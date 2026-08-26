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

/// Which pending-request and handler-task permit class a module's routes
/// draw on (plan KTD2).
///
/// The class is fixed per module by its [`ResourceDeclaration`], stored on
/// each installed route at bind time, and read back by dispatch — the host
/// never parses application bodies to pick a class, so long-settling
/// reserved work (Broca subscriptions) and general Magic Context/Synapse
/// traffic cannot consume each other's admission capacity (protocol §8.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RouteClass {
    /// Draws on the shared pools left after every reservation. The default,
    /// and the only class a zero-reservation handler ever uses.
    #[default]
    General,
    /// Draws only on permits the module reserved at startup.
    Reserved,
}

/// One immutable, host-neutral, pre-initialization declaration of the
/// runtime resources a module reserves (plan KTD2).
///
/// The runtime checked-sums declarations across all modules before handler
/// initialization: reserved pending/task slots are carved out of the
/// configured limits into a separate permit class, and retained resident
/// bytes are subtracted from the frame-admission (ingress) pool alongside
/// the resident catalog. Startup refuses any configuration that leaves
/// fewer than one general pending slot, one general task slot, or one
/// maximum-size ingress body. The all-zero default preserves the original
/// single-pool behavior exactly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ResourceDeclaration {
    /// Handler-task permits carved out of `max_handler_tasks` for this
    /// module's reserved class.
    pub reserved_handler_tasks: usize,
    /// Pending-request permits carved out of `max_pending_requests` for
    /// this module's reserved class.
    pub reserved_pending_requests: usize,
    /// Resident bytes this module retains for its own bounded state (for
    /// example Broca's 64 MiB replay budget). An accounting reservation
    /// subtracted from ingress; the module enforces its own internal budget.
    pub retained_resident_bytes: u64,
    /// The permit class every route bound to this module dispatches under.
    pub route_class: RouteClass,
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

/// Owned semantic request body with its resident-byte charge attached.
/// Transport bytes are decoded or copied synchronously before construction,
/// so asynchronous handler work never retains a receive lease.
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
    pub(crate) direct: Option<DirectOutput>,
    pub(crate) charge: crate::wire::ByteCharge,
    pub(crate) max_len: usize,
}

pub(crate) struct DirectOutput {
    pub(crate) len: usize,
    pub(crate) serializer: crate::frame_channel::DirectSerializer,
}

pub(crate) enum OutputParts {
    Owned(Vec<u8>, crate::wire::ByteCharge),
    Direct(DirectOutput, crate::wire::ByteCharge),
}

impl std::fmt::Debug for OutputBuffer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Reserved output holds application data, which stays out of
        // diagnostics (protocol V24) — mirror RequestCtx's body_len-only
        // policy.
        f.debug_struct("OutputBuffer")
            .field("len", &self.len())
            .field("max_len", &self.max_len)
            .field("direct", &self.direct.is_some())
            .finish()
    }
}

impl OutputBuffer {
    pub fn len(&self) -> usize {
        self.direct
            .as_ref()
            .map_or(self.body.len(), |body| body.len)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn capacity(&self) -> usize {
        self.max_len
    }

    pub fn as_slice(&self) -> &[u8] {
        &self.body
    }

    /// Appends bytes without permitting allocation beyond the host reservation.
    pub fn extend_from_slice(&mut self, bytes: &[u8]) -> Result<(), StreamClosed> {
        if self.direct.is_some() || bytes.len() > self.max_len.saturating_sub(self.body.len()) {
            return Err(StreamClosed);
        }
        self.body.extend_from_slice(bytes);
        Ok(())
    }

    /// Resizes within the fixed reservation without permitting further growth.
    pub fn resize(&mut self, new_len: usize, value: u8) -> Result<(), StreamClosed> {
        if self.direct.is_some() || new_len > self.max_len {
            return Err(StreamClosed);
        }
        self.body.resize(new_len, value);
        Ok(())
    }

    pub(crate) fn into_parts(self) -> OutputParts {
        match self.direct {
            Some(direct) => OutputParts::Direct(direct, self.charge),
            None => OutputParts::Owned(self.body, self.charge),
        }
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
    /// Opaque owned semantic body. Binary or JSON per `binary`.
    /// Retaining the body retains its ingress byte charge.
    pub body: InputBuffer,
    pub binary: bool,
    pub(crate) cancel: CancellationToken,
    pub(crate) stream: crate::dispatch::StreamSink,
    /// Pool funding request scratch and request-derived ownership. Separate
    /// from the pool that charged `body`, so holding these bytes can never
    /// stall another connection's frame admission.
    pub(crate) scratch: crate::wire::ByteBudget,
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

    /// `output_from_writer` reserves `exact_len` bytes and defers serialization.
    pub async fn output_from_writer(
        &self,
        exact_len: usize,
        serializer: impl FnOnce(&mut dyn io::Write) -> io::Result<()> + Send + 'static,
    ) -> Result<OutputBuffer, StreamClosed> {
        self.stream.reserve_direct(exact_len, serializer).await
    }

    /// Reserves resident bytes for request-derived state the handler is about to
    /// allocate — parse scratch, an owned tree decoded from `body`, anything whose
    /// lifetime is the request rather than the response.
    ///
    /// `None` means the pool cannot cover it right now. Charge BEFORE allocating:
    /// a reservation taken afterwards has already let the allocation escape the
    /// envelope, and concurrent requests each escape by their own full amount.
    /// The returned charge releases on drop, so hold it for as long as the bytes
    /// are live.
    pub fn try_reserve_resident(&self, bytes: usize) -> Option<crate::wire::ByteCharge> {
        self.scratch.try_charge(bytes)
    }

    /// The resident ceiling `try_reserve_resident` is measured against. A
    /// reservation above this can never be acquired, so callers report it
    /// as a permanent rejection instead of retryable backpressure.
    pub fn resident_capacity(&self) -> usize {
        self.scratch.capacity()
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

    /// One immutable resource declaration per [`McHostHandler::manifests`]
    /// entry, in the same order, read exactly once before initialization
    /// (plan KTD2). The default declares zero reservations for every
    /// module, which preserves single-pool admission unchanged.
    fn resource_declarations(&self) -> Vec<ResourceDeclaration> {
        vec![ResourceDeclaration::default(); self.manifests().len()]
    }

    fn initialize(&self, init: HostInit) -> impl Future<Output = Result<(), InitError>> + Send;

    /// Runs once after transport publication, before the accept loop, and is never awaited for readiness: storage opening and model construction belong here rather than in `initialize`, so transport never waits behind them. An expected artifact fault resolves to `Ok(())` with that lane internally degraded; `Err`, panic, and task loss are invariant failures that reach the host-fatal channel. Shutdown abandons an unfinished activation future, so long-running work must live in component-owned trackers that `shutdown` drains. commentlint: allow(JUDGE)
    fn activate(&self) -> impl Future<Output = Result<(), InitError>> + Send {
        async { Ok(()) }
    }

    fn bind(
        &self,
        route: RouteHandle,
        target: RouteTarget,
        identity: RouteIdentity,
    ) -> impl Future<Output = BindOutcome> + Send;

    fn handle(&self, ctx: RequestCtx) -> impl Future<Output = RequestOutcome> + Send;

    fn route_gone(&self, route: RouteHandle) -> impl Future<Output = ()> + Send;

    fn health(&self) -> impl Future<Output = HealthReport> + Send;

    /// Drains handler-owned work and releases handler-owned resources. The
    /// host awaits this before it releases the single-instance fence, so a
    /// successor cannot start against work this call has not stopped.
    ///
    /// Runs at most once per incarnation, and it can run against a handler
    /// whose `initialize` was interrupted rather than completed: an aborted
    /// initialization can already have handed work to handler-owned trackers,
    /// and only this call stops it. Implementations must therefore tolerate
    /// partially initialized state — cancel, close, and drain whatever exists
    /// instead of asserting that setup finished.
    fn shutdown(&self) -> impl Future<Output = ()> + Send;
}
