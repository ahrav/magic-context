//! The `LlmExecutionBackend` seam (KTD5, R14, R18).
//!
//! The supervisor owns admission, identity, status, replay, and lifecycle;
//! a backend receives one validated immutable request and returns canonical
//! events plus exactly one terminal classification. Subprocess adapters
//! (plan U3) and the deterministic test backend implement the same trait so
//! supervisor behavior never depends on which one runs.

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use tokio_util::sync::CancellationToken;

/// The two supported subprocess harnesses (R4). A closed enum rather than a
/// string so an unsupported harness can only be rejected at bind, never
/// carried into a run.
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

/// One validated, immutable run request. Built only from a strictly decoded
/// `session.send` plus the bind-validated route identity, so a backend never
/// sees unvalidated bytes.
#[derive(Clone)]
pub struct BackendRequest {
    pub prompt: String,
    pub system: Option<String>,
    pub provider: String,
    pub model: String,
    pub max_output_tokens: u64,
    pub temperature: f64,
    pub project_root: PathBuf,
    pub harness: Harness,
    pub session: String,
    pub run_id: String,
}

impl std::fmt::Debug for BackendRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Prompt, system text, and identity claims are sensitive (R19):
        // diagnostics report bounded structural metadata only.
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

/// Exact length-class finish reasons plus ordinary completion (R18). The
/// provider spelling is preserved because `HistorianProducer` matches the
/// wire string, not a normalized class.
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

/// The producer/consumer error-class contract, mirroring
/// `ERROR_CLASS_WIRE_SET` in `mc-module`'s historian producer.
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

/// One classified run failure (R18): error class, retry metadata, and the
/// bounded provider diagnostics current producer policy consumes.
#[derive(Clone, PartialEq, Eq)]
pub struct BackendError {
    pub class: ErrorClass,
    /// Always host-authored (R19): provider failure text steers
    /// classification inside the parsers but is never stored here, because
    /// this message rides the wire into module state and caller logs and
    /// provider output can echo prompt, memory-pool, or credential content.
    pub message: String,
    pub retry_after_secs: Option<u64>,
    /// Provider-supplied code, admitted only in short identifier shape
    /// (see `sanitized_provider_code`).
    pub provider_code: Option<String>,
}

impl std::fmt::Debug for BackendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The message can quote provider output, which may echo prompt
        // content (R19); diagnostics get its length only.
        f.debug_struct("BackendError")
            .field("class", &self.class)
            .field("message_len", &self.message.len())
            .field("retry_after_secs", &self.retry_after_secs)
            .field("provider_code", &self.provider_code)
            .finish()
    }
}

/// The single terminal classification every backend run resolves to (R18).
/// Malformed output, overflow, timeout, and unclassifiable provider failures
/// must all map to one `Failed`; there is deliberately no "unknown" arm.
#[derive(Debug, Clone, PartialEq)]
pub enum BackendTerminal {
    Completed {
        finish_reason: FinishReason,
    },
    Failed(BackendError),
    /// Failed, AND the harness process tree could not be proven stopped, so
    /// descendants may still be executing a billable request. Commits the
    /// same failure terminal as [`BackendTerminal::Failed`], but cancel and
    /// delete must report failure instead of claiming the work stopped.
    FailedUnresolved(BackendError),
}

/// One canonical nonterminal event. Assistant text is the only unit current
/// producers consume; the optional finish reason carries a step-level length
/// cap (R18) without promoting it to the run terminal.
#[derive(Debug, Clone, PartialEq)]
pub enum BackendEvent {
    AssistantText {
        text: String,
        finish_reason: Option<FinishReason>,
    },
}

/// Whether an emitted event was retained. `Closed` means the run can accept
/// nothing further — terminal already committed, replay overflowed, or the
/// run was cancelled — and the backend should stop producing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SinkStatus {
    Accepted,
    Closed,
}

/// Ordered event delivery back into the supervisor's replay log. Emission is
/// synchronous and nonblocking so a backend can never be wedged by a slow
/// subscriber; replay fan-out happens on the supervisor side (KTD4).
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

/// Boxed so the supervisor can hold either harness adapter behind one
/// `Arc<dyn LlmExecutionBackend>` chosen from the route-bound harness.
pub type BackendFuture = Pin<Box<dyn Future<Output = BackendTerminal> + Send + 'static>>;

/// Execution seam between supervision and the harness (KTD5).
///
/// Contract: emit zero or more events through `events`, observe `cancel`
/// promptly — a cancelled run's control operations wait for this future to
/// resolve before they complete (R10) — and resolve to exactly one terminal.
/// A terminal returned after cancellation is discarded by the supervisor's
/// first-terminal-wins arbitration.
pub trait LlmExecutionBackend: Send + Sync + 'static {
    fn execute(
        &self,
        request: BackendRequest,
        events: EventSink,
        cancel: CancellationToken,
    ) -> BackendFuture;
}

/// Routes each run to the adapter for its ROUTE-BOUND harness.
///
/// `BackendRequest::harness` comes from the session key, so a host wired
/// with a single adapter would run every route through that one CLI —
/// executing a Pi-bound run under `opencode` (different provider aliases,
/// different credentials, different transcript vocabulary) rather than
/// failing. The supervisor holds one backend by design, so the dispatch
/// belongs in a backend that owns both.
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
}

/// The terminal for a run whose route-bound harness is not the one this
/// adapter implements. Wiring that mismatch is a host construction error,
/// but it must surface as one bounded failed run rather than as a run
/// executed under the wrong CLI with the wrong credentials (R18/R19).
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
