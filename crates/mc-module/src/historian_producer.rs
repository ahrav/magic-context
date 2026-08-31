//! This module provides the Broca session client for the historian writer.
//!
//! `mc_host::Client` owns transport, authentication, correlation, liveness, and route epochs.
//! This module interprets only Broca request and stream payloads.

use std::{
    collections::BTreeMap,
    error::Error,
    fmt,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use async_trait::async_trait;
use mc_host::{
    CallError, Client, ClientError, RequestOptions, ResponseStream, RouteHandle, RouteIdentity,
    RouteTarget, SendOutcome, StreamItem, TargetKind, SUBC_LAUNCH_NONCE_ENV, SUBC_MODULE_ID_ENV,
};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

const DEFAULT_RUNNER_MODULE_ID: &str = "broca";
const HISTORIAN_MAX_OUTPUT_TOKENS: u32 = 32_000;
const HISTORIAN_TEMPERATURE: f64 = 0.1;
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_AWAIT_TIMEOUT: Duration = Duration::from_secs(600);
const RECOVERY_REDRAIN_TIMEOUT: Duration = Duration::from_secs(60);

pub const ERROR_CLASS_WIRE_SET: [&str; 4] = [
    "transient",
    "permanent",
    "auth_required",
    "context_overflow",
];

static DEPRECATED_HEURISTIC_USES: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorClass {
    Transient,
    Permanent,
    AuthRequired,
    ContextOverflow,
}

impl ErrorClass {
    pub const fn as_wire_str(self) -> &'static str {
        match self {
            Self::Transient => ERROR_CLASS_WIRE_SET[0],
            Self::Permanent => ERROR_CLASS_WIRE_SET[1],
            Self::AuthRequired => ERROR_CLASS_WIRE_SET[2],
            Self::ContextOverflow => ERROR_CLASS_WIRE_SET[3],
        }
    }

    pub fn from_wire(s: &str) -> Option<Self> {
        match s {
            "transient" => Some(Self::Transient),
            "permanent" => Some(Self::Permanent),
            "auth_required" | "auth" => Some(Self::AuthRequired),
            "context_overflow" => Some(Self::ContextOverflow),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ErrorClassification {
    pub class: ErrorClass,
    pub retry_after_secs: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistorianSendOutcome {
    NotSent,
    OutcomeUnknown,
    Terminal,
}

impl From<SendOutcome> for HistorianSendOutcome {
    fn from(value: SendOutcome) -> Self {
        match value {
            SendOutcome::NotSent => Self::NotSent,
            SendOutcome::OutcomeUnknown => Self::OutcomeUnknown,
            SendOutcome::Terminal => Self::Terminal,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistorianCallFailure {
    pub outcome: HistorianSendOutcome,
    pub code: String,
    pub message: String,
    classification: Option<ErrorClassification>,
    class_field_present: bool,
}

impl HistorianCallFailure {
    pub fn untagged(
        outcome: HistorianSendOutcome,
        code: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            outcome,
            code: code.into(),
            message: message.into(),
            classification: None,
            class_field_present: false,
        }
    }

    pub fn tagged(
        code: impl Into<String>,
        message: impl Into<String>,
        class: ErrorClass,
        retry_after_secs: Option<u64>,
    ) -> Self {
        Self {
            outcome: HistorianSendOutcome::Terminal,
            code: code.into(),
            message: message.into(),
            classification: Some(ErrorClassification {
                class,
                retry_after_secs,
            }),
            class_field_present: true,
        }
    }

    pub const fn classification(&self) -> Option<ErrorClassification> {
        self.classification
    }

    pub const fn has_class_field(&self) -> bool {
        self.class_field_present
    }
}

impl From<CallError> for HistorianCallFailure {
    fn from(error: CallError) -> Self {
        Self::untagged(
            error.outcome().into(),
            error.code().to_owned(),
            error.message().to_owned(),
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistorianClientFailure {
    pub code: String,
    pub message: String,
}

impl From<ClientError> for HistorianClientFailure {
    fn from(error: ClientError) -> Self {
        Self {
            code: error.code().to_owned(),
            message: error.to_string(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DeprecatedHeuristicDecision {
    pub retryable_model_failure: bool,
    pub abort_or_overflow: bool,
}

pub fn deprecated_heuristic_uses() -> u64 {
    DEPRECATED_HEURISTIC_USES.load(Ordering::Relaxed)
}

#[cfg(test)]
pub(crate) fn reset_deprecated_heuristic_uses_for_test() {
    DEPRECATED_HEURISTIC_USES.store(0, Ordering::Relaxed);
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunHandle {
    pub run_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProducerOutput {
    pub text: String,
    pub length_capped: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunState {
    Terminal,
    Active,
    Missing { detail: Option<String> },
}

#[derive(Debug, Clone)]
pub struct HistorianProducerConfig {
    pub connection_file: PathBuf,
    pub project_root: PathBuf,
    pub harness: String,
    pub module_id: String,
    pub request_timeout: Duration,
    pub await_timeout: Duration,
    pub cancellation: Option<CancellationToken>,
    pub credential_fingerprints: BTreeMap<String, String>,
}

impl HistorianProducerConfig {
    pub fn new(
        connection_file: impl Into<PathBuf>,
        project_root: impl Into<PathBuf>,
        harness: impl Into<String>,
    ) -> Self {
        Self {
            connection_file: connection_file.into(),
            project_root: project_root.into(),
            harness: harness.into(),
            module_id: DEFAULT_RUNNER_MODULE_ID.to_owned(),
            request_timeout: DEFAULT_REQUEST_TIMEOUT,
            await_timeout: DEFAULT_AWAIT_TIMEOUT,
            cancellation: None,
            credential_fingerprints: BTreeMap::new(),
        }
    }
}

#[derive(Debug)]
pub enum HistorianProducerError {
    Client(HistorianClientFailure),
    Call(HistorianCallFailure),
    Json(serde_json::Error),
    MissingRunId,
    MissingSession,
    UnexpectedStreamEnd,
    TimedOut,
    Protocol(String),
    CrossIncarnationUnknown {
        daemon_changed: bool,
        identity_changed: bool,
    },
    CleanupFailed {
        operation: &'static str,
        primary: Option<Box<HistorianProducerError>>,
        cleanup: Box<HistorianProducerError>,
    },
    RunFailed {
        run_id: String,
        detail: String,
        classification: Option<ErrorClassification>,
        class_field_present: bool,
    },
    TerminalRunMismatch {
        expected: String,
        found: Option<String>,
    },
    RunPaused {
        run_id: String,
        reason: Option<String>,
        classification: Option<ErrorClassification>,
        class_field_present: bool,
    },
}

impl HistorianProducerError {
    pub fn retryable_model_failure(message: impl Into<String>) -> Self {
        Self::Call(HistorianCallFailure::untagged(
            HistorianSendOutcome::Terminal,
            "retryable_model_failure",
            message,
        ))
    }

    pub fn context_overflow(message: impl Into<String>) -> Self {
        Self::Call(HistorianCallFailure::untagged(
            HistorianSendOutcome::Terminal,
            "context_overflow",
            message,
        ))
    }

    pub fn aborted(message: impl Into<String>) -> Self {
        Self::Call(HistorianCallFailure::untagged(
            HistorianSendOutcome::Terminal,
            "aborted",
            message,
        ))
    }

    pub fn tagged_call(
        code: impl Into<String>,
        message: impl Into<String>,
        class: ErrorClass,
        retry_after_secs: Option<u64>,
    ) -> Self {
        Self::Call(HistorianCallFailure::tagged(
            code,
            message,
            class,
            retry_after_secs,
        ))
    }

    pub fn classification(&self) -> Option<ErrorClassification> {
        match self {
            Self::Call(failure) => failure.classification(),
            Self::RunFailed { classification, .. } | Self::RunPaused { classification, .. } => {
                *classification
            }
            Self::CleanupFailed {
                primary: Some(primary),
                ..
            } => primary.classification(),
            _ => None,
        }
    }

    pub fn has_class_field(&self) -> bool {
        match self {
            Self::Call(failure) => failure.has_class_field(),
            Self::RunFailed {
                class_field_present,
                ..
            }
            | Self::RunPaused {
                class_field_present,
                ..
            } => *class_field_present,
            Self::CleanupFailed {
                primary: Some(primary),
                ..
            } => primary.has_class_field(),
            _ => false,
        }
    }

    pub fn code(&self) -> Option<&str> {
        match self {
            Self::Call(failure) => Some(&failure.code),
            Self::CleanupFailed {
                primary: Some(primary),
                ..
            } => primary.code(),
            _ => None,
        }
    }

    ///
    /// `None` denotes a transport or client error rather than a send attempt; callers must not treat it as `NotSent`.
    /// `None` denotes a transport or client error rather than a send attempt; callers must not treat it as `NotSent`.
    pub fn send_outcome(&self) -> Option<HistorianSendOutcome> {
        match self {
            Self::Call(failure) => Some(failure.outcome),
            Self::CleanupFailed {
                primary: Some(primary),
                ..
            } => primary.send_outcome(),
            _ => None,
        }
    }

    pub fn is_unknown_module(&self) -> bool {
        self.code() == Some("unknown_module")
    }

    pub fn is_cross_incarnation_unknown(&self) -> bool {
        match self {
            Self::CrossIncarnationUnknown { .. } => true,
            Self::CleanupFailed {
                primary: Some(primary),
                ..
            } => primary.is_cross_incarnation_unknown(),
            _ => false,
        }
    }

    pub(crate) fn deprecated_heuristic_decision(&self) -> DeprecatedHeuristicDecision {
        record_deprecated_heuristic_use(self.heuristic_log_code());
        self.heuristic_decision()
    }

    fn heuristic_decision(&self) -> DeprecatedHeuristicDecision {
        match self {
            Self::CleanupFailed {
                primary: Some(primary),
                ..
            } => primary.heuristic_decision(),
            Self::Call(failure) => DeprecatedHeuristicDecision {
                retryable_model_failure: retryable_code(&failure.code)
                    || retryable_code(&failure.message),
                abort_or_overflow: abort_or_overflow(&failure.code)
                    || abort_or_overflow(&failure.message),
            },
            Self::RunFailed { detail, .. } => DeprecatedHeuristicDecision {
                retryable_model_failure: retryable_code(detail),
                abort_or_overflow: abort_or_overflow(detail),
            },
            _ => DeprecatedHeuristicDecision {
                retryable_model_failure: false,
                abort_or_overflow: false,
            },
        }
    }

    fn heuristic_log_code(&self) -> &str {
        match self {
            Self::Call(failure) => &failure.code,
            Self::RunFailed { .. } => "run_failed",
            Self::RunPaused { .. } => "run_paused",
            Self::TimedOut => "timed_out",
            Self::CleanupFailed { .. } => "cleanup_failed",
            Self::CrossIncarnationUnknown { .. } => "cross_incarnation_unknown",
            _ => "producer_error",
        }
    }
}

fn record_deprecated_heuristic_use(code: &str) {
    DEPRECATED_HEURISTIC_USES.fetch_add(1, Ordering::Relaxed);
    eprintln!("[mc-module] untagged producer error (deprecated heuristic used): code={code}");
}

fn retryable_code(s: &str) -> bool {
    let s = s.to_ascii_lowercase();
    s.contains("retry")
        || s.contains("transient")
        || s.contains("rate_limit")
        || s.contains("provider_unavailable")
        || s.contains("overloaded")
}

fn abort_or_overflow(s: &str) -> bool {
    let s = s.to_ascii_lowercase();
    s.contains("abort")
        || s.contains("cancel")
        || s.contains("context_overflow")
        || s.contains("overflow")
}

impl fmt::Display for HistorianProducerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Client(error) => write!(f, "host client {}: {}", error.code, error.message),
            Self::Call(failure) => write!(
                f,
                "historian call {} ({:?}): {}",
                failure.code, failure.outcome, failure.message
            ),
            Self::Json(error) => write!(f, "json: {error}"),
            Self::MissingRunId => write!(f, "session.send did not return an active run_id"),
            Self::MissingSession => write!(f, "historian producer has no bound session"),
            Self::UnexpectedStreamEnd => {
                write!(f, "subscribe stream ended before the run terminal control unit")
            }
            Self::TimedOut => write!(f, "historian producer timed out"),
            Self::Protocol(detail) => write!(f, "runner protocol violation: {detail}"),
            Self::CrossIncarnationUnknown {
                daemon_changed,
                identity_changed,
            } => write!(
                f,
                "session.send outcome is unknown across replay fence (daemon_changed={daemon_changed}, identity_changed={identity_changed})"
            ),
            Self::CleanupFailed {
                operation,
                primary,
                cleanup,
            } => match primary {
                Some(primary) => {
                    write!(f, "{primary} ({operation} cleanup also failed: {cleanup})")
                }
                None => write!(f, "{operation} cleanup failed after success: {cleanup}"),
            },
            Self::RunFailed { run_id, detail, .. } => write!(f, "run {run_id} failed: {detail}"),
            Self::TerminalRunMismatch { expected, found } => write!(
                f,
                "run {expected} received terminal control unit after RunStarted {found:?}"
            ),
            Self::RunPaused { run_id, reason, .. } => {
                write!(f, "run {run_id} paused")?;
                if let Some(reason) = reason {
                    write!(f, ": {reason}")?;
                }
                Ok(())
            }
        }
    }
}

impl Error for HistorianProducerError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Json(error) => Some(error),
            Self::CleanupFailed { cleanup, .. } => Some(cleanup.as_ref()),
            _ => None,
        }
    }
}

impl From<serde_json::Error> for HistorianProducerError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

pub fn with_cleanup<T>(
    primary: Result<T, HistorianProducerError>,
    cleanup: Result<(), HistorianProducerError>,
    operation: &'static str,
) -> Result<T, HistorianProducerError> {
    match (primary, cleanup) {
        (Ok(value), Ok(())) => Ok(value),
        (Ok(_), Err(cleanup)) => Err(HistorianProducerError::CleanupFailed {
            operation,
            primary: None,
            cleanup: Box::new(cleanup),
        }),
        (Err(primary), cleanup) => Err(attach_cleanup(primary, cleanup, operation)),
    }
}

pub fn attach_cleanup(
    primary: HistorianProducerError,
    cleanup: Result<(), HistorianProducerError>,
    operation: &'static str,
) -> HistorianProducerError {
    match cleanup {
        Ok(()) => primary,
        Err(cleanup) => HistorianProducerError::CleanupFailed {
            operation,
            primary: Some(Box::new(primary)),
            cleanup: Box::new(cleanup),
        },
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SemanticIdentity {
    project_root: PathBuf,
    harness: String,
    session: String,
}

#[async_trait]
trait ProducerStream: Send {
    async fn next(&mut self) -> Result<Option<StreamItem>, HistorianProducerError>;
}

struct ManagedStream(ResponseStream);

#[async_trait]
impl ProducerStream for ManagedStream {
    async fn next(&mut self) -> Result<Option<StreamItem>, HistorianProducerError> {
        self.0.next().await.map_err(map_call_error)
    }
}

#[async_trait]
trait ProducerConnection: Send + Sync {
    fn daemon_id(&self) -> [u8; 16];
    async fn open_route(
        &self,
        target: RouteTarget,
        identity: RouteIdentity,
    ) -> Result<RouteHandle, HistorianProducerError>;
    async fn request(
        &self,
        route: RouteHandle,
        body: Vec<u8>,
        options: RequestOptions,
    ) -> Result<Vec<u8>, HistorianProducerError>;
    async fn request_stream(
        &self,
        route: RouteHandle,
        body: Vec<u8>,
        options: RequestOptions,
    ) -> Result<Box<dyn ProducerStream>, HistorianProducerError>;
    async fn close_route(&self, route: RouteHandle) -> Result<(), HistorianProducerError>;
    async fn close(&self) -> Result<(), HistorianProducerError>;
}

struct ManagedConnection(Client);

#[async_trait]
impl ProducerConnection for ManagedConnection {
    fn daemon_id(&self) -> [u8; 16] {
        self.0.daemon_id()
    }

    async fn open_route(
        &self,
        target: RouteTarget,
        identity: RouteIdentity,
    ) -> Result<RouteHandle, HistorianProducerError> {
        self.0
            .open_route(target, identity)
            .await
            .map_err(map_call_error)
    }

    async fn request(
        &self,
        route: RouteHandle,
        body: Vec<u8>,
        options: RequestOptions,
    ) -> Result<Vec<u8>, HistorianProducerError> {
        self.0
            .request(route, body, options)
            .await
            .map(|response| response.body)
            .map_err(map_call_error)
    }

    async fn request_stream(
        &self,
        route: RouteHandle,
        body: Vec<u8>,
        options: RequestOptions,
    ) -> Result<Box<dyn ProducerStream>, HistorianProducerError> {
        self.0
            .request_stream(route, body, options)
            .await
            .map(|stream| Box::new(ManagedStream(stream)) as Box<dyn ProducerStream>)
            .map_err(map_call_error)
    }

    async fn close_route(&self, route: RouteHandle) -> Result<(), HistorianProducerError> {
        self.0.close_route(route).await.map_err(map_client_error)
    }

    async fn close(&self) -> Result<(), HistorianProducerError> {
        self.0.close().await.map_err(map_client_error)
    }
}

struct Reconnected {
    connection: Box<dyn ProducerConnection>,
    identity: SemanticIdentity,
}

#[async_trait]
trait ProducerConnector: Send + Sync {
    async fn connect(
        &self,
        config: &HistorianProducerConfig,
    ) -> Result<Box<dyn ProducerConnection>, HistorianProducerError>;

    async fn reconnect(
        &self,
        config: &HistorianProducerConfig,
        identity: &SemanticIdentity,
    ) -> Result<Reconnected, HistorianProducerError>;
}

struct ManagedConnector;

#[async_trait]
impl ProducerConnector for ManagedConnector {
    async fn connect(
        &self,
        config: &HistorianProducerConfig,
    ) -> Result<Box<dyn ProducerConnection>, HistorianProducerError> {
        Client::connect(&config.connection_file)
            .await
            .map(|client| Box::new(ManagedConnection(client)) as Box<dyn ProducerConnection>)
            .map_err(map_client_error)
    }

    async fn reconnect(
        &self,
        config: &HistorianProducerConfig,
        identity: &SemanticIdentity,
    ) -> Result<Reconnected, HistorianProducerError> {
        Ok(Reconnected {
            connection: self.connect(config).await?,
            identity: identity.clone(),
        })
    }
}

fn map_call_error(error: CallError) -> HistorianProducerError {
    HistorianProducerError::Call(error.into())
}

fn map_client_error(error: ClientError) -> HistorianProducerError {
    HistorianProducerError::Client(error.into())
}

pub struct HistorianProducer {
    config: HistorianProducerConfig,
    connector: Arc<dyn ProducerConnector>,
    connection: Box<dyn ProducerConnection>,
    session_id: Option<String>,
    command_route: Option<RouteHandle>,
    subscribe_route: Option<RouteHandle>,
}

impl HistorianProducer {
    pub async fn connect(config: HistorianProducerConfig) -> Result<Self, HistorianProducerError> {
        Self::connect_with(config, Arc::new(ManagedConnector)).await
    }

    async fn connect_with(
        config: HistorianProducerConfig,
        connector: Arc<dyn ProducerConnector>,
    ) -> Result<Self, HistorianProducerError> {
        let connection = connector.connect(&config).await?;
        Ok(Self {
            config,
            connector,
            connection,
            session_id: None,
            command_route: None,
            subscribe_route: None,
        })
    }

    pub fn bind_session(&mut self, session_id: impl Into<String>) {
        self.session_id = Some(session_id.into());
    }

    pub async fn start(
        &mut self,
        session_id: &str,
        system: &str,
        prompt: &str,
        model: &str,
    ) -> Result<RunHandle, HistorianProducerError> {
        self.start_with_generation(
            session_id,
            system,
            prompt,
            model,
            HISTORIAN_MAX_OUTPUT_TOKENS,
            HISTORIAN_TEMPERATURE,
        )
        .await
    }

    pub async fn start_with_generation(
        &mut self,
        session_id: &str,
        system: &str,
        prompt: &str,
        model: &str,
        max_output_tokens: u32,
        temperature: f64,
    ) -> Result<RunHandle, HistorianProducerError> {
        // The handler checks the cancellation token before `ensure_command_route` because its awaits do not observe the token.
        // The handler checks the cancellation token before `ensure_command_route` because its awaits do not observe the token.
        // Without a pre-route cancellation check, a cancelled handler can wait through route admission and bind a route.
        // A handler cancelled before its request starts can otherwise bind a route after route admission completes.
        // `NotSent` means no frame has been queued on any route.
        // `NotSent` means no frame has been queued on any route.
        if self.stop_requested() {
            return Err(HistorianProducerError::Call(
                HistorianCallFailure::untagged(
                    HistorianSendOutcome::NotSent,
                    "cancelled",
                    "historian firing was cancelled before it started".to_owned(),
                ),
            ));
        }
        self.bind_session(session_id.to_owned());
        let (provider, model_name) = model.split_once('/').ok_or_else(|| {
            HistorianProducerError::Call(HistorianCallFailure::untagged(
                HistorianSendOutcome::NotSent,
                "invalid_model",
                format!("model '{model}' is not in canonical provider/model form"),
            ))
        })?;
        let mut params = serde_json::Map::new();
        params.insert("prompt".into(), json!(prompt));
        params.insert(
            "model".into(),
            json!({ "provider": provider, "model": model_name }),
        );
        params.insert("tools".into(), json!([]));
        params.insert(
            "generation".into(),
            json!({
                "max_output_tokens": max_output_tokens,
                "temperature": temperature,
            }),
        );
        if !system.is_empty() {
            params.insert("system".into(), json!(system));
        }
        let frozen = serde_json::to_vec(&json!({
            "method": "session.send",
            "params": params,
        }))?;
        let frozen_identity = self.semantic_identity()?;
        let frozen_daemon = self.connection.daemon_id();
        let response = match self.send_frozen_once(&frozen).await {
            Ok(response) => response,
            Err(error) if is_outcome_unknown(&error) && !self.stop_requested() => {
                self.replay_frozen_once(frozen_daemon, frozen_identity, &frozen, error)
                    .await?
            }
            Err(error) => return Err(error),
        };
        let run_id = response
            .get("run_id")
            .and_then(Value::as_str)
            .or_else(|| {
                response
                    .get("result")
                    .and_then(|result| result.get("run_id"))
                    .and_then(Value::as_str)
            })
            .ok_or(HistorianProducerError::MissingRunId)?;
        Ok(RunHandle {
            run_id: run_id.to_owned(),
        })
    }

    pub async fn await_output(
        &mut self,
        run_id: &str,
    ) -> Result<ProducerOutput, HistorianProducerError> {
        self.await_output_with_timeout(run_id, self.config.await_timeout)
            .await
    }

    pub async fn await_output_with_timeout(
        &mut self,
        run_id: &str,
        timeout: Duration,
    ) -> Result<ProducerOutput, HistorianProducerError> {
        self.subscribe_from_start(run_id, timeout).await
    }

    pub async fn redrain_output(
        &mut self,
        run_id: &str,
    ) -> Result<ProducerOutput, HistorianProducerError> {
        self.redrain_output_with_timeout(run_id, RECOVERY_REDRAIN_TIMEOUT)
            .await
    }

    pub async fn redrain_output_with_timeout(
        &mut self,
        run_id: &str,
        timeout: Duration,
    ) -> Result<ProducerOutput, HistorianProducerError> {
        self.subscribe_from_start(run_id, timeout).await
    }

    pub async fn status(&mut self, run_id: &str) -> Result<RunState, HistorianProducerError> {
        let route = self.ensure_command_route().await?;
        let response = self
            .unary_json(
                route,
                json!({ "method": "run.status", "params": { "run_id": run_id } }),
            )
            .await?;
        classify_run_state(run_id, &response)
    }

    pub async fn cancel(&mut self, run_id: &str) -> Result<(), HistorianProducerError> {
        let route = self.ensure_command_route().await?;
        self.unary_json(
            route,
            json!({ "method": "run.cancel", "params": { "run_id": run_id } }),
        )
        .await?;
        Ok(())
    }

    pub async fn purge_session(&mut self, session_id: &str) -> Result<(), HistorianProducerError> {
        self.bind_session(session_id.to_owned());
        let budget = self.config.request_timeout;
        let purge = async {
            let delete = async {
                let route = self.ensure_command_route().await?;
                self.unary_json(route, json!({ "method": "session.delete", "params": {} }))
                    .await
                    .map(|_| ())
            }
            .await;
            let close = self.close().await;
            with_cleanup(delete, close, "close")
        };
        match tokio::time::timeout(budget, purge).await {
            Ok(result) => result,
            Err(_) => Err(HistorianProducerError::TimedOut),
        }
    }

    pub async fn close_attempt(&mut self) -> Result<(), HistorianProducerError> {
        self.close_routes().await
    }

    pub async fn close(&mut self) -> Result<(), HistorianProducerError> {
        self.close_routes_and_connection().await
    }

    async fn send_frozen_once(&mut self, frozen: &[u8]) -> Result<Value, HistorianProducerError> {
        let route = self.ensure_command_route().await?;
        let response = self
            .connection
            .request(
                route,
                frozen.to_vec(),
                self.request_options(self.config.request_timeout),
            )
            .await?;
        Ok(serde_json::from_slice(&response)?)
    }

    ///
    /// The recovery path returns `ambiguous` unchanged on every abort because the frozen request may already have reached the host.
    /// The recovery path returns `ambiguous` unchanged on every abort because the frozen request may already have reached the host.
    /// Reporting cancellation as `NotSent` would permit retrying a request that may already have reached the host.
    /// Reporting cancellation as `NotSent` would permit retrying a request that may already have reached the host.
    /// Reporting cancellation as `NotSent` would permit retrying a request that may already have reached the host.
    async fn replay_frozen_once(
        &mut self,
        frozen_daemon: [u8; 16],
        frozen_identity: SemanticIdentity,
        frozen: &[u8],
        ambiguous: HistorianProducerError,
    ) -> Result<Value, HistorianProducerError> {
        // The recovery path releases the ambiguous generation before reconnecting because both connections consume a host permit.
        // The old and replay connections both consume a host connection permit.
        // At `max_connections == 1`, reconnecting before release causes the host to drop the new authenticated socket.
        // At `max_connections == 1`, reconnecting before release causes the host to drop the new authenticated socket.
        // The recovery path releases the old generation before reconnecting so failed reconnects cannot prevent its cleanup.
        if let Err(error) = self.close_routes_and_connection().await {
            eprintln!("mc-module: historian replay cleanup failed: {error}");
        }
        self.command_route = None;
        self.subscribe_route = None;

        // The recovery path checks cancellation before setup because cleanup, reconnect, and route opening do not observe the token.
        // The recovery path checks cancellation before setup because cleanup, reconnect, and route opening do not observe the token.
        // Cleanup, reconnect, and route opening do not observe the cancellation token.
        // Cancellation during setup is observed by the `stop_requested` checks after cleanup and reconnect.
        // The recovery path rechecks `stop_requested` after cleanup and reconnect to avoid opening a route after cancellation.
        if self.stop_requested() {
            return Err(ambiguous);
        }

        let reconnected = match self
            .connector
            .reconnect(&self.config, &frozen_identity)
            .await
        {
            Ok(reconnected) => reconnected,
            Err(error) => {
                // Reconnect failures must preserve the original send's unknown outcome.
                // Reconnect failures must not replace the original send's `OutcomeUnknown` result.
                // `Client` errors have no `send_outcome()` classification.
                // The recovery path returns `ambiguous` because the frozen request may already have committed.
                eprintln!("mc-module: historian replay reconnect failed: {error}");
                return Err(ambiguous);
            }
        };
        let daemon_changed = reconnected.connection.daemon_id() != frozen_daemon;
        let identity_changed = reconnected.identity != frozen_identity;
        self.connection = reconnected.connection;

        if daemon_changed || identity_changed {
            return Err(HistorianProducerError::CrossIncarnationUnknown {
                daemon_changed,
                identity_changed,
            });
        }
        // The `stop_requested` check after reconnect is the last check before `send_frozen_once` can open a route.
        if self.stop_requested() {
            return Err(ambiguous);
        }
        let sent = self.send_frozen_once(frozen).await;
        // If `stop_requested` follows a replay send error, return `ambiguous`: the replay error does not classify the original send.
        // A replay `cancelled` or `NotSent` error classifies only the replay.
        // Reporting a replay-local failure would mark a possibly committed request as safe to retry.
        if sent.is_err() && self.stop_requested() {
            return Err(ambiguous);
        }
        sent
    }

    async fn ensure_command_route(&mut self) -> Result<RouteHandle, HistorianProducerError> {
        if let Some(route) = self.command_route {
            return Ok(route);
        }
        let route = self.open_bound_route().await?;
        self.command_route = Some(route);
        Ok(route)
    }

    async fn ensure_subscribe_route(&mut self) -> Result<RouteHandle, HistorianProducerError> {
        if let Some(route) = self.subscribe_route {
            return Ok(route);
        }
        let route = self.open_bound_route().await?;
        self.subscribe_route = Some(route);
        Ok(route)
    }

    async fn open_bound_route(&self) -> Result<RouteHandle, HistorianProducerError> {
        let semantic = self.semantic_identity()?;
        let open = self.connection.open_route(
            RouteTarget {
                module_id: self.config.module_id.clone(),
                kind: TargetKind::ManagementSurface,
            },
            RouteIdentity {
                project_root: semantic.project_root,
                harness: semantic.harness,
                session: semantic.session,
                consumer_module_id: nonempty_env(SUBC_MODULE_ID_ENV),
                consumer_launch_nonce: nonempty_env(SUBC_LAUNCH_NONCE_ENV),
                consumer_capabilities: Vec::new(),
                admission_facts: None,
                credential_fingerprints: self.config.credential_fingerprints.clone(),
            },
        );
        let Some(cancellation) = self.config.cancellation.clone() else {
            return open.await;
        };
        tokio::select! {
            biased;
            () = cancellation.cancelled() => {
                //
                if let Err(error) = self.connection.close().await {
                    eprintln!("mc-module: historian cancelled route-open cleanup failed: {error}");
                }
                Err(HistorianProducerError::Call(HistorianCallFailure::untagged(
                    HistorianSendOutcome::NotSent,
                    "cancelled",
                    "historian route open was cancelled".to_owned(),
                )))
            }
            route = open => route,
        }
    }

    async fn unary_json(
        &self,
        route: RouteHandle,
        body: Value,
    ) -> Result<Value, HistorianProducerError> {
        let body = serde_json::to_vec(&body)?;
        let response = self
            .connection
            .request(
                route,
                body,
                self.request_options(self.config.request_timeout),
            )
            .await?;
        Ok(serde_json::from_slice(&response)?)
    }

    ///
    async fn subscribe_from_start(
        &mut self,
        run_id: &str,
        timeout: Duration,
    ) -> Result<ProducerOutput, HistorianProducerError> {
        match tokio::time::timeout(timeout, self.subscribe_and_drain(run_id, timeout)).await {
            Ok(result) => result,
            Err(_) => Err(HistorianProducerError::TimedOut),
        }
    }

    async fn subscribe_and_drain(
        &mut self,
        run_id: &str,
        timeout: Duration,
    ) -> Result<ProducerOutput, HistorianProducerError> {
        let route = self.ensure_subscribe_route().await?;
        let body = serde_json::to_vec(&json!({
            "method": "session.subscribe",
            "params": { "from": "start" },
        }))?;
        let mut stream = self
            .connection
            .request_stream(route, body, self.request_options(timeout))
            .await?;
        drain_subscribe(&mut *stream, run_id).await
    }

    async fn close_routes(&mut self) -> Result<(), HistorianProducerError> {
        let mut first_error = None;
        if let Some(route) = self.subscribe_route.take() {
            if let Err(error) = self.connection.close_route(route).await {
                first_error.get_or_insert(error);
            }
        }
        if let Some(route) = self.command_route.take() {
            if let Err(error) = self.connection.close_route(route).await {
                first_error.get_or_insert(error);
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    async fn close_routes_and_connection(&mut self) -> Result<(), HistorianProducerError> {
        let mut result = self.close_routes().await;
        if let Err(error) = self.connection.close().await {
            if result.is_ok() {
                result = Err(error);
            }
        }
        result
    }

    fn semantic_identity(&self) -> Result<SemanticIdentity, HistorianProducerError> {
        Ok(SemanticIdentity {
            project_root: self.config.project_root.clone(),
            harness: self.config.harness.clone(),
            session: self
                .session_id
                .clone()
                .ok_or(HistorianProducerError::MissingSession)?,
        })
    }

    fn request_options(&self, timeout: Duration) -> RequestOptions {
        RequestOptions {
            timeout,
            cancellation: self.config.cancellation.clone(),
        }
    }

    ///
    fn stop_requested(&self) -> bool {
        self.config
            .cancellation
            .as_ref()
            .is_some_and(CancellationToken::is_cancelled)
    }
}

async fn drain_subscribe(
    stream: &mut dyn ProducerStream,
    run_id: &str,
) -> Result<ProducerOutput, HistorianProducerError> {
    let mut text = String::new();
    let mut last_run_started: Option<String> = None;
    let mut length_capped = false;
    while let Some(item) = stream.next().await? {
        let event: Value = serde_json::from_slice(&item.body)?;
        let Some(unit) = control_unit(&event) else {
            continue;
        };
        if is_run_started_unit(unit) {
            last_run_started = unit_run_id(unit).map(ToOwned::to_owned);
        }
        let terminal = is_terminal_unit(unit);
        if !terminal && unit_run_id(unit).is_some_and(|id| id != run_id) {
            continue;
        }
        if is_paused_unit(unit) && unit_run_id(unit) == Some(run_id) {
            let info = unit_error_info(unit);
            return Err(HistorianProducerError::RunPaused {
                run_id: run_id.to_owned(),
                reason: paused_reason(unit).map(ToOwned::to_owned),
                classification: info.classification,
                class_field_present: info.class_field_present,
            });
        }
        if let Some(piece) = unit_text(unit) {
            text.push_str(&piece);
        }
        if unit_is_length_capped(unit) {
            length_capped = true;
        }
        if terminal {
            if last_run_started.as_deref() != Some(run_id) {
                return Err(HistorianProducerError::TerminalRunMismatch {
                    expected: run_id.to_owned(),
                    found: last_run_started,
                });
            }
            if is_error_unit(unit) {
                let info = unit_error_info(unit);
                return Err(HistorianProducerError::RunFailed {
                    run_id: run_id.to_owned(),
                    detail: info.detail.unwrap_or_else(|| "run failed".to_owned()),
                    classification: info.classification,
                    class_field_present: info.class_field_present,
                });
            }
            return Ok(ProducerOutput {
                text,
                length_capped,
            });
        }
    }
    Err(HistorianProducerError::UnexpectedStreamEnd)
}

fn nonempty_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

fn is_outcome_unknown(error: &HistorianProducerError) -> bool {
    matches!(
        error,
        HistorianProducerError::Call(HistorianCallFailure {
            outcome: HistorianSendOutcome::OutcomeUnknown,
            ..
        })
    )
}

fn classify_run_state(run_id: &str, value: &Value) -> Result<RunState, HistorianProducerError> {
    let value = value.get("result").unwrap_or(value);
    let response_run_id = value.get("run_id").and_then(Value::as_str);
    if response_run_id != Some(run_id) {
        return Err(HistorianProducerError::Protocol(format!(
            "run.status answered for run {response_run_id:?}, not {run_id}"
        )));
    }
    let Some(state) = value.get("state").and_then(Value::as_str) else {
        return Err(HistorianProducerError::Protocol(
            "run.status response has no state string".to_owned(),
        ));
    };
    match state {
        "queued" | "running" => Ok(RunState::Active),
        "completed" | "failed" | "cancelled" => Ok(RunState::Terminal),
        "missing" => Ok(RunState::Missing {
            detail: value
                .get("detail")
                .or_else(|| value.get("last_error"))
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
        }),
        other => Err(HistorianProducerError::Protocol(format!(
            "undocumented run state {other:?}"
        ))),
    }
}

fn control_unit(event: &Value) -> Option<&Value> {
    let kind = event.get("kind").and_then(Value::as_str);
    if kind == Some("display") {
        return None;
    }
    Some(event.get("unit").unwrap_or(event))
}

fn unit_type(unit: &Value) -> Option<&str> {
    unit.get("type")
        .or_else(|| unit.get("kind"))
        .and_then(Value::as_str)
}

fn unit_run_id(unit: &Value) -> Option<&str> {
    unit.get("run_id")
        .or_else(|| unit.get("runId"))
        .and_then(Value::as_str)
}

fn unit_text(unit: &Value) -> Option<String> {
    if !unit_type(unit).is_some_and(|kind| kind.eq_ignore_ascii_case("assistant_message")) {
        return None;
    }
    if let Some(blocks) = unit
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
    {
        let text: String = blocks
            .iter()
            .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect();
        return (!text.is_empty()).then_some(text);
    }
    unit.get("text")
        .or_else(|| unit.get("content"))
        .or_else(|| unit.get("message").and_then(|message| message.get("text")))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn is_terminal_unit(unit: &Value) -> bool {
    if is_error_unit(unit) {
        return true;
    }
    unit_type(unit)
        .map(str::to_ascii_lowercase)
        .is_some_and(|kind| {
            matches!(
                kind.as_str(),
                "run_finished" | "terminal" | "run_terminal" | "finished"
            )
        })
}

fn is_run_started_unit(unit: &Value) -> bool {
    unit_type(unit)
        .map(str::to_ascii_lowercase)
        .is_some_and(|kind| kind == "run_started" || kind == "runstarted")
}

fn unit_is_length_capped(unit: &Value) -> bool {
    unit.get("finish_reason")
        .or_else(|| unit.get("finishReason"))
        .and_then(Value::as_str)
        .is_some_and(|reason| {
            matches!(
                reason.to_ascii_lowercase().as_str(),
                "length" | "max_tokens" | "max_output_tokens"
            )
        })
}

fn is_paused_unit(unit: &Value) -> bool {
    unit_type(unit).is_some_and(|kind| kind.eq_ignore_ascii_case("paused"))
}

fn paused_reason(unit: &Value) -> Option<&str> {
    unit.get("reason")
        .or_else(|| unit.get("detail"))
        .and_then(Value::as_str)
}

fn is_error_unit(unit: &Value) -> bool {
    unit_type(unit)
        .map(str::to_ascii_lowercase)
        .is_some_and(|kind| kind == "error" || kind == "run_error")
}

#[derive(Debug, Default)]
struct UnitErrorInfo {
    detail: Option<String>,
    classification: Option<ErrorClassification>,
    class_field_present: bool,
}

fn unit_error_info(unit: &Value) -> UnitErrorInfo {
    if let Some(error) = unit.get("error") {
        let (classification, class_field_present) = classification_from_object(error);
        let detail = error
            .get("message")
            .and_then(Value::as_str)
            .or_else(|| unit.get("detail").and_then(Value::as_str))
            .or_else(|| unit.get("message").and_then(Value::as_str))
            .map(ToOwned::to_owned)
            .or_else(|| error.as_str().map(ToOwned::to_owned))
            .or_else(|| Some(error.to_string()));
        return UnitErrorInfo {
            detail,
            classification,
            class_field_present,
        };
    }

    let detail = unit
        .get("detail")
        .or_else(|| unit.get("message"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let (classification, class_field_present) = detail
        .as_deref()
        .and_then(classification_from_json_text)
        .unwrap_or((None, false));
    UnitErrorInfo {
        detail,
        classification,
        class_field_present,
    }
}

fn classification_from_json_text(s: &str) -> Option<(Option<ErrorClassification>, bool)> {
    serde_json::from_str::<Value>(s)
        .ok()
        .map(|value| classification_from_object(&value))
}

fn classification_from_object(value: &Value) -> (Option<ErrorClassification>, bool) {
    let Some(class_value) = value.get("class") else {
        return (None, false);
    };
    let Some(class) = class_value.as_str().and_then(ErrorClass::from_wire) else {
        return (None, true);
    };
    (
        Some(ErrorClassification {
            class,
            retry_after_secs: value
                .get("retry_after_secs")
                .and_then(retry_after_secs_from_value),
        }),
        true,
    )
}

fn retry_after_secs_from_value(value: &Value) -> Option<u64> {
    value.as_u64().or_else(|| {
        value
            .as_f64()
            .filter(|value| value.is_finite() && *value >= 0.0)
            .map(|value| value.ceil() as u64)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashSet, VecDeque};
    use std::sync::Mutex;

    #[derive(Clone)]
    struct FakeConnection {
        daemon_id: [u8; 16],
        state: Arc<Mutex<FakeState>>,
    }

    #[derive(Default)]
    struct FakeState {
        requests: Vec<Vec<u8>>,
        identities: Vec<RouteIdentity>,
        responses: VecDeque<Result<Vec<u8>, HistorianProducerError>>,
        opened_routes: Vec<RouteHandle>,
        closed_routes: Vec<RouteHandle>,
        close_route_errors: VecDeque<HistorianProducerError>,
        close_calls: usize,
        next_channel: u16,
        stall_stream: bool,
        cancel_on_close: Option<CancellationToken>,
        cancel_on_open_route: Option<CancellationToken>,
    }

    #[async_trait]
    impl ProducerConnection for FakeConnection {
        fn daemon_id(&self) -> [u8; 16] {
            self.daemon_id
        }

        async fn open_route(
            &self,
            _target: RouteTarget,
            identity: RouteIdentity,
        ) -> Result<RouteHandle, HistorianProducerError> {
            // observe.
            let cancel = self.state.lock().unwrap().cancel_on_open_route.take();
            if let Some(cancel) = cancel {
                cancel.cancel();
                tokio::task::yield_now().await;
            }
            let mut state = self.state.lock().unwrap();
            state.identities.push(identity);
            state.next_channel += 1;
            let route = RouteHandle {
                channel: state.next_channel,
                epoch: u32::from(state.next_channel),
            };
            state.opened_routes.push(route);
            Ok(route)
        }

        async fn request(
            &self,
            _route: RouteHandle,
            body: Vec<u8>,
            _options: RequestOptions,
        ) -> Result<Vec<u8>, HistorianProducerError> {
            let mut state = self.state.lock().unwrap();
            state.requests.push(body);
            state
                .responses
                .pop_front()
                .unwrap_or_else(|| Ok(br#"{"run_id":"run-default"}"#.to_vec()))
        }

        async fn request_stream(
            &self,
            _route: RouteHandle,
            _body: Vec<u8>,
            _options: RequestOptions,
        ) -> Result<Box<dyn ProducerStream>, HistorianProducerError> {
            if self.state.lock().unwrap().stall_stream {
                return Ok(Box::new(StallingStream));
            }
            Ok(Box::new(FakeStream(VecDeque::new())))
        }

        async fn close_route(&self, route: RouteHandle) -> Result<(), HistorianProducerError> {
            let mut state = self.state.lock().unwrap();
            state.closed_routes.push(route);
            match state.close_route_errors.pop_front() {
                Some(error) => Err(error),
                None => Ok(()),
            }
        }

        async fn close(&self) -> Result<(), HistorianProducerError> {
            let cancel = {
                let mut state = self.state.lock().unwrap();
                state.close_calls += 1;
                state.cancel_on_close.take()
            };
            if let Some(cancel) = cancel {
                cancel.cancel();
            }
            Ok(())
        }
    }

    struct FakeStream(VecDeque<Result<Option<StreamItem>, HistorianProducerError>>);

    #[async_trait]
    impl ProducerStream for FakeStream {
        async fn next(&mut self) -> Result<Option<StreamItem>, HistorianProducerError> {
            self.0.pop_front().unwrap_or(Ok(None))
        }
    }

    struct StallingStream;

    #[async_trait]
    impl ProducerStream for StallingStream {
        async fn next(&mut self) -> Result<Option<StreamItem>, HistorianProducerError> {
            std::future::pending().await
        }
    }

    struct FakeConnector {
        initial: FakeConnection,
        reconnects: Mutex<VecDeque<(FakeConnection, Option<SemanticIdentity>)>>,
        reconnect_calls: AtomicU64,
    }

    #[async_trait]
    impl ProducerConnector for FakeConnector {
        async fn connect(
            &self,
            _config: &HistorianProducerConfig,
        ) -> Result<Box<dyn ProducerConnection>, HistorianProducerError> {
            Ok(Box::new(self.initial.clone()))
        }

        async fn reconnect(
            &self,
            _config: &HistorianProducerConfig,
            identity: &SemanticIdentity,
        ) -> Result<Reconnected, HistorianProducerError> {
            self.reconnect_calls.fetch_add(1, Ordering::SeqCst);
            let Some((connection, override_identity)) = self.reconnects.lock().unwrap().pop_front()
            else {
                return Err(HistorianProducerError::Client(HistorianClientFailure {
                    code: "connect_failed".to_owned(),
                    message: "no host to dial".to_owned(),
                }));
            };
            Ok(Reconnected {
                connection: Box::new(connection),
                identity: override_identity.unwrap_or_else(|| identity.clone()),
            })
        }
    }

    fn unknown() -> HistorianProducerError {
        HistorianProducerError::Call(HistorianCallFailure::untagged(
            HistorianSendOutcome::OutcomeUnknown,
            "connection_retired",
            "outcome unknown",
        ))
    }

    fn cancelled_unknown() -> HistorianProducerError {
        HistorianProducerError::Call(HistorianCallFailure::untagged(
            HistorianSendOutcome::OutcomeUnknown,
            "cancelled",
            "request was cancelled",
        ))
    }

    fn terminal(code: &str) -> HistorianProducerError {
        HistorianProducerError::Call(HistorianCallFailure::untagged(
            HistorianSendOutcome::Terminal,
            code,
            "terminal",
        ))
    }

    fn connection(
        daemon: u8,
        responses: impl IntoIterator<Item = Result<Vec<u8>, HistorianProducerError>>,
    ) -> FakeConnection {
        FakeConnection {
            daemon_id: [daemon; 16],
            state: Arc::new(Mutex::new(FakeState {
                responses: responses.into_iter().collect(),
                ..FakeState::default()
            })),
        }
    }

    async fn producer(
        initial: FakeConnection,
        reconnect: Option<(FakeConnection, Option<SemanticIdentity>)>,
    ) -> (HistorianProducer, Arc<FakeConnector>) {
        let connector = Arc::new(FakeConnector {
            initial,
            reconnects: Mutex::new(reconnect.into_iter().collect()),
            reconnect_calls: AtomicU64::new(0),
        });
        let config = HistorianProducerConfig {
            request_timeout: Duration::from_secs(1),
            await_timeout: Duration::from_secs(1),
            ..HistorianProducerConfig::new("/unused", "/project", "opencode")
        };
        let connected = HistorianProducer::connect_with(config, connector.clone())
            .await
            .unwrap();
        (connected, connector)
    }

    #[tokio::test]
    async fn start_opens_expected_identity_and_sends_once() {
        let first = connection(1, [Ok(br#"{"run_id":"run-1"}"#.to_vec())]);
        let state = Arc::clone(&first.state);
        let (mut producer, connector) = producer(first, None).await;
        let handle = producer
            .start("session-1", "system", "prompt", "provider/model")
            .await
            .unwrap();
        assert_eq!(handle.run_id, "run-1");
        assert_eq!(connector.reconnect_calls.load(Ordering::SeqCst), 0);
        let state = state.lock().unwrap();
        assert_eq!(state.requests.len(), 1);
        assert_eq!(state.identities.len(), 1);
        assert_eq!(state.identities[0].project_root, PathBuf::from("/project"));
        assert_eq!(state.identities[0].harness, "opencode");
        assert_eq!(state.identities[0].session, "session-1");
        let body: Value = serde_json::from_slice(&state.requests[0]).unwrap();
        assert_eq!(body["method"], "session.send");
        assert_eq!(body["params"]["prompt"], "prompt");
    }

    #[tokio::test]
    async fn same_daemon_and_identity_resends_exact_bytes_once() {
        let first = connection(7, [Err(unknown())]);
        let second = connection(7, [Ok(br#"{"run_id":"run-2"}"#.to_vec())]);
        let first_state = Arc::clone(&first.state);
        let second_state = Arc::clone(&second.state);
        let (mut producer, connector) = producer(first, Some((second, None))).await;
        let handle = producer
            .start("session-2", "system", "prompt", "provider/model")
            .await
            .unwrap();
        assert_eq!(handle.run_id, "run-2");
        assert_eq!(connector.reconnect_calls.load(Ordering::SeqCst), 1);
        let first = first_state.lock().unwrap();
        let second = second_state.lock().unwrap();
        assert_eq!(first.requests.len(), 1);
        assert_eq!(second.requests.len(), 1);
        assert_eq!(first.requests[0], second.requests[0]);
    }

    #[tokio::test]
    async fn second_unknown_outcome_stops_without_third_attempt() {
        let first = connection(7, [Err(unknown())]);
        let second = connection(7, [Err(unknown())]);
        let first_state = Arc::clone(&first.state);
        let second_state = Arc::clone(&second.state);
        let (mut producer, connector) = producer(first, Some((second, None))).await;

        assert!(producer
            .start("session", "", "prompt", "provider/model")
            .await
            .is_err());

        assert_eq!(connector.reconnect_calls.load(Ordering::SeqCst), 1);
        assert_eq!(first_state.lock().unwrap().requests.len(), 1);
        assert_eq!(second_state.lock().unwrap().requests.len(), 1);
    }

    #[tokio::test]
    async fn changed_daemon_returns_typed_unknown_without_resend() {
        let first = connection(1, [Err(unknown())]);
        let second = connection(2, []);
        let second_state = Arc::clone(&second.state);
        let (mut producer, connector) = producer(first, Some((second, None))).await;
        let error = producer
            .start("session", "", "prompt", "provider/model")
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            HistorianProducerError::CrossIncarnationUnknown {
                daemon_changed: true,
                identity_changed: false
            }
        ));
        assert_eq!(connector.reconnect_calls.load(Ordering::SeqCst), 1);
        assert!(second_state.lock().unwrap().requests.is_empty());
    }

    #[tokio::test]
    async fn any_semantic_identity_change_prevents_resend() {
        for field in ["project", "harness", "session"] {
            let first = connection(3, [Err(unknown())]);
            let second = connection(3, []);
            let second_state = Arc::clone(&second.state);
            let mut changed = SemanticIdentity {
                project_root: PathBuf::from("/project"),
                harness: "opencode".to_owned(),
                session: "session".to_owned(),
            };
            match field {
                "project" => changed.project_root = PathBuf::from("/other"),
                "harness" => changed.harness = "claude-code".to_owned(),
                "session" => changed.session = "other-session".to_owned(),
                _ => unreachable!(),
            }
            let (mut producer, _) = producer(first, Some((second, Some(changed)))).await;
            let error = producer
                .start("session", "", "prompt", "provider/model")
                .await
                .unwrap_err();
            assert!(matches!(
                error,
                HistorianProducerError::CrossIncarnationUnknown {
                    daemon_changed: false,
                    identity_changed: true
                }
            ));
            assert!(second_state.lock().unwrap().requests.is_empty(), "{field}");
        }
    }

    #[tokio::test]
    async fn not_sent_and_terminal_failures_are_never_replayed() {
        for failure in [
            HistorianProducerError::Call(HistorianCallFailure::untagged(
                HistorianSendOutcome::NotSent,
                "correlation_exhausted",
                "not sent",
            )),
            terminal("idempotency_conflict"),
        ] {
            let first = connection(1, [Err(failure)]);
            let state = Arc::clone(&first.state);
            let (mut producer, connector) = producer(first, None).await;
            assert!(producer
                .start("session", "", "prompt", "provider/model")
                .await
                .is_err());
            assert_eq!(connector.reconnect_calls.load(Ordering::SeqCst), 0);
            assert_eq!(state.lock().unwrap().requests.len(), 1);
        }
    }

    #[tokio::test]
    async fn caller_cancellation_prevents_replay_but_transport_loss_still_replays() {
        async fn start_with_token(
            token: Option<CancellationToken>,
        ) -> (
            Arc<FakeConnector>,
            Arc<Mutex<FakeState>>,
            Arc<Mutex<FakeState>>,
            Result<RunHandle, HistorianProducerError>,
        ) {
            let first = connection(9, [Err(cancelled_unknown())]);
            let first_state = Arc::clone(&first.state);
            let second = connection(9, [Ok(br#"{"run_id":"replayed"}"#.to_vec())]);
            let second_state = Arc::clone(&second.state);
            let connector = Arc::new(FakeConnector {
                initial: first,
                reconnects: Mutex::new(VecDeque::from(vec![(second, None)])),
                reconnect_calls: AtomicU64::new(0),
            });
            let config = HistorianProducerConfig {
                request_timeout: Duration::from_secs(1),
                await_timeout: Duration::from_secs(1),
                cancellation: token,
                ..HistorianProducerConfig::new("/unused", "/project", "opencode")
            };
            let mut producer = HistorianProducer::connect_with(config, connector.clone())
                .await
                .unwrap();
            let result = producer
                .start("session", "", "prompt", "provider/model")
                .await;
            (connector, first_state, second_state, result)
        }

        let cancelled = CancellationToken::new();
        cancelled.cancel();
        let (connector, first_state, replay_state, result) =
            start_with_token(Some(cancelled)).await;
        let error = result.expect_err("a cancelled start does not succeed");
        assert_eq!(
            error.send_outcome(),
            Some(HistorianSendOutcome::NotSent),
            "a firing cancelled before it started queued nothing: {error:?}"
        );
        assert!(
            first_state.lock().unwrap().requests.is_empty(),
            "a pre-cancelled firing must not send session.send at all"
        );
        assert!(
            first_state.lock().unwrap().opened_routes.is_empty(),
            "a pre-cancelled firing must not bind a route"
        );
        assert_eq!(
            connector.reconnect_calls.load(Ordering::SeqCst),
            0,
            "a cancelled caller must not trigger connection setup"
        );
        assert!(
            replay_state.lock().unwrap().requests.is_empty(),
            "a cancelled caller must not have its request resent"
        );

        for token in [None, Some(CancellationToken::new())] {
            let (connector, _first_state, replay_state, result) = start_with_token(token).await;
            assert_eq!(result.expect("transport loss replays").run_id, "replayed");
            assert_eq!(connector.reconnect_calls.load(Ordering::SeqCst), 1);
            assert_eq!(replay_state.lock().unwrap().requests.len(), 1);
        }
    }

    #[tokio::test]
    async fn a_cancellation_during_replay_setup_stops_before_dialing() {
        let cancelled = CancellationToken::new();
        let first = connection(9, [Err(cancelled_unknown())]);
        first.state.lock().unwrap().cancel_on_close = Some(cancelled.clone());
        let second = connection(9, [Ok(br#"{"run_id":"replayed"}"#.to_vec())]);
        let second_state = Arc::clone(&second.state);
        let connector = Arc::new(FakeConnector {
            initial: first,
            reconnects: Mutex::new(VecDeque::from(vec![(second, None)])),
            reconnect_calls: AtomicU64::new(0),
        });
        let config = HistorianProducerConfig {
            request_timeout: Duration::from_secs(1),
            await_timeout: Duration::from_secs(1),
            cancellation: Some(cancelled),
            ..HistorianProducerConfig::new("/unused", "/project", "opencode")
        };
        let mut producer = HistorianProducer::connect_with(config, connector.clone())
            .await
            .unwrap();

        let error = producer
            .start("session", "", "prompt", "provider/model")
            .await
            .expect_err("a cancelled replay does not succeed");
        assert!(
            is_outcome_unknown(&error),
            "the frozen request may already have been delivered, so the abort must \
             stay ambiguous rather than reporting the cancellation as NotSent: {error:?}"
        );
        assert_eq!(
            connector.reconnect_calls.load(Ordering::SeqCst),
            0,
            "a token that fires during replay cleanup must prevent the dial"
        );
        assert!(
            second_state.lock().unwrap().opened_routes.is_empty(),
            "no route may be bound for a cancelled replay"
        );
    }

    #[tokio::test]
    async fn a_failed_replay_reconnect_keeps_the_send_ambiguous() {
        let first = connection(9, [Err(cancelled_unknown())]);
        let connector = Arc::new(FakeConnector {
            initial: first,
            reconnects: Mutex::new(VecDeque::new()),
            reconnect_calls: AtomicU64::new(0),
        });
        let config = HistorianProducerConfig {
            request_timeout: Duration::from_secs(1),
            await_timeout: Duration::from_secs(1),
            ..HistorianProducerConfig::new("/unused", "/project", "opencode")
        };
        let mut producer = HistorianProducer::connect_with(config, connector.clone())
            .await
            .unwrap();

        let error = producer
            .start("session", "", "prompt", "provider/model")
            .await
            .expect_err("a replay that cannot dial does not succeed");
        assert_eq!(
            connector.reconnect_calls.load(Ordering::SeqCst),
            1,
            "the replay did attempt the dial"
        );
        assert!(
            is_outcome_unknown(&error),
            "the dial failure must not replace the ambiguous send classification: {error:?}"
        );
        assert_eq!(
            error.send_outcome(),
            Some(HistorianSendOutcome::OutcomeUnknown),
            "a consumer asking whether the request was sent must still get the ambiguous answer"
        );
    }

    #[tokio::test]
    async fn a_cancellation_during_route_open_abandons_it_and_closes_the_connection() {
        let cancelled = CancellationToken::new();
        let first = connection(9, [Ok(br#"{"run_id":"unreachable"}"#.to_vec())]);
        first.state.lock().unwrap().cancel_on_open_route = Some(cancelled.clone());
        let state = Arc::clone(&first.state);
        let connector = Arc::new(FakeConnector {
            initial: first,
            reconnects: Mutex::new(VecDeque::new()),
            reconnect_calls: AtomicU64::new(0),
        });
        let config = HistorianProducerConfig {
            request_timeout: Duration::from_secs(1),
            await_timeout: Duration::from_secs(1),
            cancellation: Some(cancelled),
            ..HistorianProducerConfig::new("/unused", "/project", "opencode")
        };
        let mut producer = HistorianProducer::connect_with(config, connector.clone())
            .await
            .unwrap();

        let error = producer
            .start("session", "", "prompt", "provider/model")
            .await
            .expect_err("a cancelled route open does not start a run");
        assert_eq!(
            error.send_outcome(),
            Some(HistorianSendOutcome::NotSent),
            "nothing of the caller's request was queued: {error:?}"
        );
        let state = state.lock().unwrap();
        assert!(
            state.requests.is_empty(),
            "no session.send may follow an abandoned route open"
        );
        assert!(
            state.close_calls >= 1,
            "the abandoned open must be settled by closing the connection, since \
             the host may bind a route this client can never name"
        );
    }

    #[tokio::test]
    async fn close_releases_subscription_and_command_routes() {
        let first = connection(1, [Ok(br#"{"run_id":"run"}"#.to_vec())]);
        let state = Arc::clone(&first.state);
        let (mut producer, _) = producer(first, None).await;
        producer.bind_session("session");
        producer.ensure_command_route().await.unwrap();
        producer.ensure_subscribe_route().await.unwrap();
        producer.close().await.unwrap();
        let state = state.lock().unwrap();
        assert_eq!(
            state.opened_routes.iter().copied().collect::<HashSet<_>>(),
            state.closed_routes.iter().copied().collect::<HashSet<_>>()
        );
        assert_eq!(
            state.closed_routes,
            vec![
                RouteHandle {
                    channel: 2,
                    epoch: 2,
                },
                RouteHandle {
                    channel: 1,
                    epoch: 1,
                },
            ]
        );
        assert_eq!(state.close_calls, 1);
    }

    #[tokio::test]
    async fn attempt_cleanup_reopens_exact_routes_without_closing_connection() {
        let first = connection(
            1,
            [
                Ok(br#"{"run_id":"run-1"}"#.to_vec()),
                Ok(br#"{"run_id":"run-2"}"#.to_vec()),
            ],
        );
        let state = Arc::clone(&first.state);
        let (mut producer, _) = producer(first, None).await;
        producer
            .start("session", "", "prompt-1", "provider/model-a")
            .await
            .unwrap();
        producer.ensure_subscribe_route().await.unwrap();
        producer.close_attempt().await.unwrap();
        assert_eq!(state.lock().unwrap().close_calls, 0);

        producer
            .start("session", "", "prompt-2", "provider/model-b")
            .await
            .unwrap();
        producer.ensure_subscribe_route().await.unwrap();
        producer.close().await.unwrap();

        let state = state.lock().unwrap();
        assert_eq!(state.opened_routes.len(), 4);
        assert_eq!(
            state.opened_routes.iter().copied().collect::<HashSet<_>>(),
            state.closed_routes.iter().copied().collect::<HashSet<_>>()
        );
        assert_eq!(state.close_calls, 1);
    }

    #[tokio::test]
    async fn first_route_close_failure_does_not_skip_second_route_or_client_close() {
        let first = connection(1, []);
        first
            .state
            .lock()
            .unwrap()
            .close_route_errors
            .push_back(terminal("close_failed"));
        let state = Arc::clone(&first.state);
        let (mut producer, _) = producer(first, None).await;
        producer.bind_session("session");
        producer.ensure_command_route().await.unwrap();
        producer.ensure_subscribe_route().await.unwrap();

        assert!(producer.close().await.is_err());

        let state = state.lock().unwrap();
        assert_eq!(state.opened_routes.len(), 2);
        assert_eq!(
            state.opened_routes.iter().copied().collect::<HashSet<_>>(),
            state.closed_routes.iter().copied().collect::<HashSet<_>>()
        );
        assert_eq!(
            state.closed_routes,
            vec![
                RouteHandle {
                    channel: 2,
                    epoch: 2,
                },
                RouteHandle {
                    channel: 1,
                    epoch: 1,
                },
            ],
            "first route failure must not skip exact second route"
        );
        assert_eq!(state.close_calls, 1);
    }

    #[test]
    fn run_state_mapping_is_closed_over_known_states() {
        for state in ["queued", "running"] {
            assert_eq!(
                classify_run_state("run", &json!({"run_id":"run", "state":state})).unwrap(),
                RunState::Active
            );
        }
        for state in ["completed", "failed", "cancelled"] {
            assert_eq!(
                classify_run_state("run", &json!({"run_id":"run", "state":state})).unwrap(),
                RunState::Terminal
            );
        }
        assert!(classify_run_state("run", &json!({"run_id":"run", "state":"paused"})).is_err());
        assert!(classify_run_state("run", &json!({"run_id":"other", "state":"missing"})).is_err());
    }

    #[tokio::test]
    async fn an_attempt_that_outlives_its_budget_reports_timed_out() {
        // is deterministic.
        let connection = connection(1, [Ok(br#"{"run_id":"run"}"#.to_vec())]);
        connection.state.lock().unwrap().stall_stream = true;
        let (mut producer, _) = producer(connection, None).await;
        producer.bind_session("session");

        let error = tokio::time::timeout(
            Duration::from_secs(5),
            producer.await_output_with_timeout("run", Duration::from_millis(20)),
        )
        .await
        .expect("the attempt's own bound must end the wait")
        .expect_err("a stalled subscription cannot complete");
        assert!(
            matches!(error, HistorianProducerError::TimedOut),
            "expected TimedOut, got {error:?}"
        );
    }

    #[test]
    fn error_class_wire_strings_match_pinned_contract_set() {
        assert_eq!(ErrorClass::Transient.as_wire_str(), "transient");
        assert_eq!(ErrorClass::Permanent.as_wire_str(), "permanent");
        assert_eq!(ErrorClass::AuthRequired.as_wire_str(), "auth_required");
        assert_eq!(
            ErrorClass::ContextOverflow.as_wire_str(),
            "context_overflow"
        );
    }

    fn stream_of(events: impl IntoIterator<Item = Value>) -> FakeStream {
        FakeStream(
            events
                .into_iter()
                .map(|event| {
                    Ok(Some(StreamItem {
                        body: serde_json::to_vec(&event).expect("event serializes"),
                        binary: false,
                    }))
                })
                .collect(),
        )
    }

    #[tokio::test]
    async fn every_error_spelling_terminates_the_drain_with_its_classification() {
        for kind in ["error", "run_error"] {
            let mut stream = stream_of([
                json!({"type": "run_started", "run_id": "r1"}),
                json!({"type": "assistant_message", "run_id": "r1", "text": "partial"}),
                json!({
                    "type": kind,
                    "run_id": "r1",
                    "error": {"message": "model is busy", "class": "transient", "retry_after_secs": 4},
                }),
            ]);

            let error = drain_subscribe(&mut stream, "r1")
                .await
                .expect_err("an error unit ends the run");
            match error {
                HistorianProducerError::RunFailed {
                    run_id,
                    detail,
                    classification,
                    class_field_present,
                } => {
                    assert_eq!(run_id, "r1");
                    assert_eq!(detail, "model is busy");
                    assert!(class_field_present);
                    assert_eq!(
                        classification,
                        Some(ErrorClassification {
                            class: ErrorClass::Transient,
                            retry_after_secs: Some(4),
                        })
                    );
                }
                other => panic!("{kind} produced {other:?} instead of RunFailed"),
            }
        }
    }

    #[tokio::test]
    async fn a_successful_drain_returns_text_and_the_length_cap() {
        let mut stream = stream_of([
            json!({"type": "run_started", "run_id": "r1"}),
            json!({"type": "assistant_message", "run_id": "r1", "text": "first "}),
            json!({"type": "assistant_message", "run_id": "r1", "text": "second", "finish_reason": "max_tokens"}),
            json!({"type": "run_finished", "run_id": "r1"}),
        ]);

        let output = drain_subscribe(&mut stream, "r1")
            .await
            .expect("terminal unit completes the run");
        assert_eq!(output.text, "first second");
        assert!(
            output.length_capped,
            "the cap travels with the text it truncated"
        );
    }
}
