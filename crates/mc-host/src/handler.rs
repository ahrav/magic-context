//! Host-owned handler contract.
//!
//! `magic-context-c50.4` will adapt `McHandler` onto this boundary. It is
//! deliberately independent of the private subc SDK: no `subc-*` type appears
//! here, the handler never sees socket frames, credentials, correlations, or
//! route allocation, and the host owns lifecycle transitions, terminal
//! arbitration, and wire emission (plan KTD2).

use std::future::Future;
use std::io;
use std::path::PathBuf;

use tokio_util::sync::CancellationToken;

use crate::config::HostInit;

/// Catalog-visible snapshot of the linked module's manifest.
///
/// `provides` is carried as raw JSON so `catalog.list` can return it without
/// lossy rewriting (protocol §7.3). The host reads each entry's top-level
/// `role` for admission and preserves the remaining role data unchanged.
#[derive(Debug, Clone)]
pub struct ManifestSnapshot {
    pub module_id: String,
    pub module_version: String,
    /// The manifest's complete `provides` array, including tool schemas.
    pub provides: Vec<serde_json::Value>,
    /// Implemented module control operations only; truthfulness here is what
    /// keeps wake-plane probing fail-open (protocol §7.3).
    pub control_ops: Vec<String>,
}

/// One live route: `(channel, epoch)` allocated by the host before bind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct RouteHandle {
    pub channel: u16,
    pub epoch: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TargetKind {
    ToolProvider,
    ManagementSurface,
}

impl TargetKind {
    pub fn parse(kind: &str) -> Option<Self> {
        match kind {
            "tool_provider" => Some(Self::ToolProvider),
            "management_surface" => Some(Self::ManagementSurface),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteTarget {
    pub module_id: String,
    pub kind: TargetKind,
}

/// Caller-supplied route scope. Every field is an unverified claim: it scopes
/// handler state and never grants authority (protocol §2, §7.1).
#[derive(Clone, PartialEq, Eq)]
pub struct RouteIdentity {
    pub project_root: PathBuf,
    pub harness: String,
    pub session: String,
    pub consumer_module_id: Option<String>,
    pub consumer_launch_nonce: Option<String>,
    pub consumer_capabilities: Vec<String>,
    pub admission_facts: Option<serde_json::Value>,
}

impl std::fmt::Debug for RouteIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Identity claims are sensitive diagnostics (protocol V24): report
        // bounded structural metadata only, never the values.
        f.debug_struct("RouteIdentity")
            .field("project_root_len", &self.project_root.as_os_str().len())
            .field("harness_len", &self.harness.len())
            .field("session_len", &self.session.len())
            .field("consumer_module_id", &self.consumer_module_id.is_some())
            .field(
                "consumer_launch_nonce",
                &self.consumer_launch_nonce.is_some(),
            )
            .field("consumer_capabilities", &self.consumer_capabilities.len())
            .field("admission_facts", &self.admission_facts.is_some())
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub enum BindOutcome {
    Accept,
    /// The route is never published; the client receives this as the terminal
    /// error for its `route.open` correlation.
    Reject {
        code: String,
        message: String,
    },
}

impl std::fmt::Debug for BindOutcome {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Rejection code and message are handler-controlled and can carry
        // identity data; diagnostics get lengths only (protocol V24).
        match self {
            Self::Accept => f.write_str("Accept"),
            Self::Reject { code, message } => f
                .debug_struct("Reject")
                .field("code_len", &code.len())
                .field("message_len", &message.len())
                .finish(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HealthStatus {
    Ok,
    Degraded,
    Failing,
}

/// Internal health snapshot. Never exposed as a client JSON operation
/// (protocol §9.3).
#[derive(Debug, Clone)]
pub struct HealthReport {
    pub status: HealthStatus,
    pub detail: Option<String>,
    pub metrics: Option<serde_json::Value>,
}

impl HealthReport {
    pub fn ok() -> Self {
        Self {
            status: HealthStatus::Ok,
            detail: None,
            metrics: None,
        }
    }
}

/// How one routed request settles from the handler's side.
///
/// Output storage must be reserved through [`RequestCtx::reserve_output`]
/// before allocation; an already allocated `Vec` cannot bypass the host's
/// resident-byte budget:
///
/// ```compile_fail
/// # use mc_host::RequestOutcome;
/// let _ = RequestOutcome::Response {
///     body: Vec::<u8>::new(),
///     binary: false,
/// };
/// ```
pub enum RequestOutcome {
    /// Unary success; the host emits one `Response` terminal whose wire
    /// `binary` flag mirrors `binary`, exactly like [`RequestCtx::stream`]
    /// items.
    Response { body: OutputBuffer, binary: bool },
    /// Application failure; the host emits one canonical `Error` terminal.
    Error { code: String, message: String },
    /// Stream items were emitted through [`RequestCtx::stream`]; the host
    /// emits the `StreamEnd` terminal.
    Streamed,
}

impl std::fmt::Debug for RequestOutcome {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Error code and message are handler-controlled and can carry
        // request or identity data; diagnostics get lengths only (protocol
        // V24), matching OutputBuffer and RequestCtx.
        match self {
            Self::Response { body, binary } => f
                .debug_struct("Response")
                .field("body", body)
                .field("binary", binary)
                .finish(),
            Self::Error { code, message } => f
                .debug_struct("Error")
                .field("code_len", &code.len())
                .field("message_len", &message.len())
                .finish(),
            Self::Streamed => f.write_str("Streamed"),
        }
    }
}

/// Request body with its resident-byte charge attached: moving the bytes
/// anywhere moves the charge with them, so handler code that retains the
/// body past the callback cannot separate it from its ingress accounting.
pub struct InputBuffer {
    pub(crate) body: Vec<u8>,
    pub(crate) _charge: crate::wire::ByteCharge,
}

impl InputBuffer {
    pub fn len(&self) -> usize {
        self.body.len()
    }

    pub fn is_empty(&self) -> bool {
        self.body.is_empty()
    }

    pub fn as_slice(&self) -> &[u8] {
        &self.body
    }
}

impl std::ops::Deref for InputBuffer {
    type Target = [u8];

    fn deref(&self) -> &[u8] {
        &self.body
    }
}

impl std::fmt::Debug for InputBuffer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Application data stays out of diagnostics (protocol V24).
        f.debug_struct("InputBuffer")
            .field("len", &self.body.len())
            .finish()
    }
}

/// Host-reserved output storage.
///
/// The host acquires the resident-byte charge before allocating this buffer.
/// Its fixed maximum keeps later writes from growing beyond that reservation;
/// the charge moves with the body into the connection writer.
pub struct OutputBuffer {
    pub(crate) body: Vec<u8>,
    pub(crate) charge: crate::wire::ByteCharge,
    pub(crate) max_len: usize,
}

impl std::fmt::Debug for OutputBuffer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Reserved output holds application data, which stays out of
        // diagnostics (protocol V24) — mirror RequestCtx's body_len-only
        // policy.
        f.debug_struct("OutputBuffer")
            .field("len", &self.body.len())
            .field("max_len", &self.max_len)
            .finish()
    }
}

impl OutputBuffer {
    pub fn len(&self) -> usize {
        self.body.len()
    }

    pub fn is_empty(&self) -> bool {
        self.body.is_empty()
    }

    pub fn capacity(&self) -> usize {
        self.max_len
    }

    pub fn as_slice(&self) -> &[u8] {
        &self.body
    }

    /// Appends bytes without permitting allocation beyond the host reservation.
    pub fn extend_from_slice(&mut self, bytes: &[u8]) -> Result<(), StreamClosed> {
        if bytes.len() > self.max_len.saturating_sub(self.body.len()) {
            return Err(StreamClosed);
        }
        self.body.extend_from_slice(bytes);
        Ok(())
    }

    /// Resizes within the fixed reservation without permitting further growth.
    pub fn resize(&mut self, new_len: usize, value: u8) -> Result<(), StreamClosed> {
        if new_len > self.max_len {
            return Err(StreamClosed);
        }
        self.body.resize(new_len, value);
        Ok(())
    }

    pub(crate) fn into_parts(self) -> (Vec<u8>, crate::wire::ByteCharge) {
        (self.body, self.charge)
    }
}

impl io::Write for OutputBuffer {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.extend_from_slice(bytes).map_err(|_| {
            io::Error::new(io::ErrorKind::WriteZero, "output reservation exhausted")
        })?;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Context for one dispatched request. Dropping it without returning an
/// outcome leaves settlement to the host (cancellation or teardown).
///
/// `RequestCtx` specifically hides transport correlations, sockets, and
/// credentials:
///
/// ```compile_fail
/// fn no_correlation(ctx: mc_host::RequestCtx) { let _ = ctx.corr; }
/// ```
///
/// ```compile_fail
/// fn no_socket(ctx: mc_host::RequestCtx) { let _ = ctx.socket; }
/// ```
///
/// ```compile_fail
/// fn no_credentials(ctx: mc_host::RequestCtx) { let _ = ctx.credentials; }
/// ```
pub struct RequestCtx {
    pub route: RouteHandle,
    /// Opaque request body. Binary or JSON per `binary`. Carries its
    /// resident-byte charge, so retaining it keeps its ingress accounting.
    pub body: InputBuffer,
    pub binary: bool,
    pub(crate) cancel: CancellationToken,
    pub(crate) stream: crate::dispatch::StreamSink,
}

impl RequestCtx {
    /// Resolves when the host has requested cancellation of this request
    /// (client `Cancel`, route close, or shutdown). Best effort: the handler
    /// may still complete, and the host's first-terminal-wins arbiter decides.
    pub fn cancelled(&self) -> impl Future<Output = ()> + Send + '_ {
        self.cancel.cancelled()
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel.is_cancelled()
    }

    /// Reserves capacity and its resident-byte charge before allocating output.
    ///
    /// The returned buffer can hold at most `max_len` body bytes. Its charge
    /// transfers into either a unary response or a stream item.
    pub async fn reserve_output(&self, max_len: usize) -> Result<OutputBuffer, StreamClosed> {
        self.stream.reserve(max_len).await
    }

    /// Queues one nonterminal `StreamData` item, in order. Returns `Err` once
    /// the request is cancelled, a terminal is selected, or the connection is
    /// gone; the handler should stop streaming then.
    pub async fn stream(&self, item: OutputBuffer, binary: bool) -> Result<(), StreamClosed> {
        self.stream.send(item, binary).await
    }
}

impl std::fmt::Debug for RequestCtx {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The body is application data and must stay out of diagnostics
        // (protocol V24).
        f.debug_struct("RequestCtx")
            .field("route", &self.route)
            .field("body_len", &self.body.len())
            .field("binary", &self.binary)
            .finish()
    }
}

/// Output reservation or streaming can no longer proceed because admission
/// was rejected, cancellation or terminal selection occurred, or the
/// connection was lost.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StreamClosed;

impl std::fmt::Display for StreamClosed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "request output is no longer accepted")
    }
}

impl std::error::Error for StreamClosed {}

/// Handler initialization failure; prevents publication and fails startup.
#[derive(Debug)]
pub struct InitError(pub String);

impl std::fmt::Display for InitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "handler initialization failed: {}", self.0)
    }
}

impl std::error::Error for InitError {}

/// The linked module's lifecycle surface, called only by the host.
///
/// Concurrency: `handle` runs on independent tasks and may overlap itself,
/// `health`, and lifecycle callbacks for other routes. `initialize` is called
/// exactly once before the listener binds. `bind` precedes any request for its
/// route. `route_gone` follows completion or forced abort of that route's
/// request tasks and runs exactly once per handle the handler observed,
/// including rejected binds. `health` runs on a dedicated host task.
///
/// Failure policy (plan KTD9): a panic or deadline overrun in `initialize`,
/// `bind`, `route_gone`, or `health` is host-fatal. A panic in `handle` maps
/// to one `internal_error` terminal for that correlation only (when the
/// runtime unwinds; under `panic=abort` any panic kills the process).
pub trait McHostHandler: Send + Sync + 'static {
    fn manifests(&self) -> Vec<ManifestSnapshot>;

    fn initialize(&self, init: HostInit) -> impl Future<Output = Result<(), InitError>> + Send;

    fn bind(
        &self,
        route: RouteHandle,
        target: RouteTarget,
        identity: RouteIdentity,
    ) -> impl Future<Output = BindOutcome> + Send;

    fn handle(&self, ctx: RequestCtx) -> impl Future<Output = RequestOutcome> + Send;

    fn route_gone(&self, route: RouteHandle) -> impl Future<Output = ()> + Send;

    fn health(&self) -> impl Future<Output = HealthReport> + Send;

    fn shutdown(&self) -> impl Future<Output = ()> + Send;
}
