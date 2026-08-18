//! Host-owned handler contract.
//!
//! This boundary is what `magic-context-c50.4` adapts `McHandler` onto. It is
//! deliberately independent of the private subc SDK: no `subc-*` type appears
//! here, the handler never sees socket frames, credentials, correlations, or
//! route allocation, and the host owns every terminal and lifecycle decision
//! (plan KTD2).

use std::future::Future;
use std::path::PathBuf;

use tokio_util::sync::CancellationToken;

use crate::config::HostInit;

/// Catalog-visible snapshot of the linked module's manifest.
///
/// `provides` is carried as raw JSON so `catalog.list` can return it without
/// lossy rewriting (protocol §7.3); the host never interprets role internals.
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

/// Caller-supplied route scope. Every field is an unverified claim: it scopes
/// handler state and never grants authority (protocol §2, §7.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteIdentity {
    pub project_root: PathBuf,
    pub harness: String,
    pub session: String,
    pub consumer_module_id: Option<String>,
    pub consumer_launch_nonce: Option<String>,
    pub consumer_capabilities: Vec<String>,
    pub admission_facts: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BindOutcome {
    Accept,
    /// The route is never published; the client receives this as the terminal
    /// error for its `route.open` correlation.
    Reject {
        code: String,
        message: String,
    },
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
#[derive(Debug)]
pub enum RequestOutcome {
    /// Unary success; the host emits one `Response` terminal.
    Response(Vec<u8>),
    /// Application failure; the host emits one canonical `Error` terminal.
    Error { code: String, message: String },
    /// Stream items were emitted through [`RequestCtx::stream`]; the host
    /// emits the `StreamEnd` terminal.
    Streamed,
}

/// Context for one dispatched request. Dropping it without returning an
/// outcome leaves settlement to the host (cancellation or teardown).
///
/// `RequestCtx` does not expose transport identities or capabilities:
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
    /// Opaque request body. Binary or JSON per `binary`.
    pub body: Vec<u8>,
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

    /// Queues one nonterminal `StreamData` item, in order. Returns `Err` once
    /// a terminal has been selected for this request or the connection is
    /// gone; the handler should stop streaming then.
    pub async fn stream(&self, item: Vec<u8>, binary: bool) -> Result<(), StreamClosed> {
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

/// The stream or connection can no longer accept items.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StreamClosed;

impl std::fmt::Display for StreamClosed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "stream closed: terminal already selected or connection gone"
        )
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
/// Concurrency: `handle` runs on independent tasks and may overlap itself and
/// every other callback. `initialize` is called exactly once before the
/// listener binds. `bind` precedes any request for its route; `route_gone`
/// follows the settlement of all of the route's requests and runs exactly once
/// per handle the handler observed — including rejected binds. `health` runs
/// on a dedicated host task.
///
/// Failure policy (plan KTD9): a panic or deadline overrun in `initialize`,
/// `bind`, `route_gone`, or `health` is host-fatal. A panic in `handle` maps
/// to one `internal_error` terminal for that correlation only (when the
/// runtime unwinds; under `panic=abort` any panic kills the process).
pub trait McHostHandler: Send + Sync + 'static {
    fn manifest(&self) -> ManifestSnapshot;

    fn initialize(&self, init: HostInit) -> impl Future<Output = Result<(), InitError>> + Send;

    fn bind(
        &self,
        route: RouteHandle,
        identity: RouteIdentity,
    ) -> impl Future<Output = BindOutcome> + Send;

    fn handle(&self, ctx: RequestCtx) -> impl Future<Output = RequestOutcome> + Send;

    fn route_gone(&self, route: RouteHandle) -> impl Future<Output = ()> + Send;

    fn health(&self) -> impl Future<Output = HealthReport> + Send;
}
