//!
//! The supervisor owns admission, identity, status, replay, and lifecycle.
//! Subprocess adapters and the deterministic test backend implement the same trait, so supervisor behavior never depends on which one runs.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use tokio_util::sync::CancellationToken;

/// A closed enum rejects unsupported harnesses at bind instead of carrying them into a run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Harness {
    OpenCode,
    Pi,
}

impl Harness {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "opencode" => Some(Self::OpenCode),
            "pi" => Some(Self::Pi),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::OpenCode => "opencode",
            Self::Pi => "pi",
        }
    }
}

/// The supervisor validates `session.send` and route identity before creating a `BackendRequest`.
#[derive(Clone)]
pub struct BackendRequest {
    pub prompt: String,
    pub system: Option<String>,
    pub provider: String,
    pub model: String,
    pub max_output_tokens: u64,
    pub temperature: f64,
    pub harness: Harness,
    pub session: String,
    pub run_id: String,
}

impl std::fmt::Debug for BackendRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BackendRequest")
            .field("prompt_len", &self.prompt.len())
            .field("system_len", &self.system.as_ref().map(String::len))
            .field("provider_len", &self.provider.len())
            .field("model_len", &self.model.len())
            .field("max_output_tokens", &self.max_output_tokens)
            .field("temperature", &self.temperature)
            .field("harness", &self.harness)
            .field("run_id", &self.run_id)
            .finish()
    }
}

/// Provider spelling is preserved because `HistorianProducer` matches the wire string rather than a normalized finish-reason class.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FinishReason {
    Completed,
    Length,
    MaxOutputTokens,
}

impl FinishReason {
    pub fn as_wire_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Length => "length",
            Self::MaxOutputTokens => "max_output_tokens",
        }
    }
}

/// The producer/consumer error-class contract mirrors `ERROR_CLASS_WIRE_SET` in `mc-module`'s historian producer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorClass {
    Transient,
    Permanent,
    AuthRequired,
    ContextOverflow,
}

impl ErrorClass {
    pub fn as_wire_str(self) -> &'static str {
        match self {
            Self::Transient => "transient",
            Self::Permanent => "permanent",
            Self::AuthRequired => "auth_required",
            Self::ContextOverflow => "context_overflow",
        }
    }
}

/// Producer policy consumes `BackendError`'s error class, retry metadata, and bounded provider diagnostics.
#[derive(Clone, PartialEq, Eq)]
pub struct BackendError {
    pub class: ErrorClass,
    /// Always host-authored:
    /// `BackendError::message` rides the wire into module state and caller logs, where provider output can echo prompt, memory-pool, or credential content.
    pub message: String,
    pub retry_after_secs: Option<u64>,
    /// (see `sanitized_provider_code`).
    pub provider_code: Option<String>,
}

impl std::fmt::Debug for BackendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Provider output may echo prompt content, so diagnostics record only its length.
        f.debug_struct("BackendError")
            .field("class", &self.class)
            .field("message_len", &self.message.len())
            .field("retry_after_secs", &self.retry_after_secs)
            .field("provider_code", &self.provider_code)
            .finish()
    }
}

/// Every backend run resolves to exactly one terminal classification.
#[derive(Debug, Clone, PartialEq)]
pub enum BackendTerminal {
    Completed {
        finish_reason: FinishReason,
    },
    Failed(BackendError),
    /// Cancellation may leave descendants executing a billable request.
    /// Cancel and delete commit `BackendTerminal::Failed` when descendants may still be executing a billable request.
    /// `delete` must report failure rather than claim that the backend stopped.
    FailedUnresolved(BackendError),
}

/// Assistant text is the only payload producers consume.
/// `finish_reason` carries a step-level length cap without becoming the run terminal.
#[derive(Debug, Clone, PartialEq)]
pub enum BackendEvent {
    HarnessDispatch {
        harness: Harness,
    },
    AssistantText {
        text: String,
        finish_reason: Option<FinishReason>,
    },
}

/// `Closed` rejects further events after a terminal commits, replay overflows, or cancellation.
/// Cancellation tells the backend to stop producing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SinkStatus {
    Accepted,
    Closed,
}

#[derive(Clone)]
pub struct EventSink {
    deliver: Arc<dyn Fn(BackendEvent) -> SinkStatus + Send + Sync>,
}

impl EventSink {
    pub fn new(deliver: Arc<dyn Fn(BackendEvent) -> SinkStatus + Send + Sync>) -> Self {
        Self { deliver }
    }

    pub fn emit(&self, event: BackendEvent) -> SinkStatus {
        (self.deliver)(event)
    }
}

impl std::fmt::Debug for EventSink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("EventSink")
    }
}

pub type BackendFuture = Pin<Box<dyn Future<Output = BackendTerminal> + Send + 'static>>;

///
/// Backends emit zero or more events through `events` and observe `cancel`.
/// After cancellation, control operations wait for this future to resolve.
/// The supervisor discards terminals returned after cancellation.
/// first-terminal-wins arbitration.
pub trait LlmExecutionBackend: Send + Sync + 'static {
    fn execute(
        &self,
        request: BackendRequest,
        events: EventSink,
        cancel: CancellationToken,
    ) -> BackendFuture;

    /// `unavailable_reason` returns the `harness_unavailable` subreason that every run on `harness` would fail with without executing anything.
    ///
    /// Hosts must report descriptor and closure reasons before credential reasons.
    /// When the descriptor is unavailable, report its reason before credential reasons so users receive `restart_with_supported_harness`.
    fn unavailable_reason(&self, _harness: Harness) -> Option<&'static str> {
        None
    }
}

///
pub struct HarnessDispatchBackend {
    opencode: Arc<dyn LlmExecutionBackend>,
    pi: Arc<dyn LlmExecutionBackend>,
}

impl HarnessDispatchBackend {
    pub fn new(opencode: Arc<dyn LlmExecutionBackend>, pi: Arc<dyn LlmExecutionBackend>) -> Self {
        Self { opencode, pi }
    }
}

impl LlmExecutionBackend for HarnessDispatchBackend {
    fn execute(
        &self,
        request: BackendRequest,
        events: EventSink,
        cancel: CancellationToken,
    ) -> BackendFuture {
        let backend = match request.harness {
            Harness::OpenCode => Arc::clone(&self.opencode),
            Harness::Pi => Arc::clone(&self.pi),
        };
        backend.execute(request, events, cancel)
    }

    fn unavailable_reason(&self, harness: Harness) -> Option<&'static str> {
        match harness {
            Harness::OpenCode => self.opencode.unavailable_reason(harness),
            Harness::Pi => self.pi.unavailable_reason(harness),
        }
    }
}

pub(crate) fn harness_mismatch(expected: Harness, requested: Harness) -> BackendTerminal {
    BackendTerminal::Failed(BackendError {
        class: ErrorClass::Permanent,
        message: format!(
            "backend for {} received a run bound to {}",
            expected.as_str(),
            requested.as_str()
        ),
        retry_after_secs: None,
        provider_code: None,
    })
}

pub(crate) fn dispatch_closed(harness: Harness) -> BackendTerminal {
    BackendTerminal::Failed(BackendError {
        class: ErrorClass::Permanent,
        message: format!("{} run closed before subprocess dispatch", harness.as_str()),
        retry_after_secs: None,
        provider_code: None,
    })
}
