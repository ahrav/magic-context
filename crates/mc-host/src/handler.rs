//!
//! The boundary excludes private `subc-*` SDK types.
//! Handlers do not receive socket frames, credentials, correlations, or route allocation.
//! The host owns lifecycle transitions, terminal arbitration, and wire emission.

use std::collections::BTreeMap;
use std::future::Future;
use std::io;
use std::path::PathBuf;

use tokio_util::sync::CancellationToken;

use crate::config::HostInit;

///
/// The host retains `provides` as raw JSON so `catalog.list` returns it without lossy rewriting.
/// The host reads each entry's top-level `role` for admission.
#[derive(Debug, Clone)]
pub struct ManifestSnapshot {
    pub module_id: String,
    pub module_version: String,
    /// `provides` retains the complete manifest array, including tool schemas.
    pub provides: Vec<serde_json::Value>,
    /// `control_ops` lists only implemented module control operations.
    pub control_ops: Vec<String>,
}

/// The host allocates each `(channel, epoch)` route before binding.
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

/// Each route uses its module's pending-request and handler-task permit class.
///
/// `ResourceDeclaration` fixes the route class for every module.
/// The host stores the class on each route at bind time and dispatch reads that stored value.
/// The host never parses application bodies to select a permit class.
/// Reserved work and general traffic use separate admission capacity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RouteClass {
    /// `General` draws on capacity remaining after every reservation.
    /// A zero-reservation handler uses only `General`.
    #[default]
    General,
    /// `Reserved` draws only on permits reserved for its module at startup.
    Reserved,
}

/// Modules declare reserved runtime resources before initialization.
///
/// Before handler initialization, the runtime sums declarations across all modules.
/// The runtime removes reserved pending and task slots from the configured general limits.
/// The runtime assigns reserved pending and task slots to a separate permit class.
/// The runtime subtracts retained resident bytes from the ingress pool alongside the resident catalog.
/// Startup rejects configurations that leave fewer than one general pending slot, one general task slot, or one maximum-size ingress body.
/// The all-zero declaration preserves single-pool behavior.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ResourceDeclaration {
    /// `reserved_handler_tasks` is deducted from `max_handler_tasks` for the module's reserved permit class.
    pub reserved_handler_tasks: usize,
    /// `reserved_pending_requests` is deducted from `max_pending_requests` for the module's reserved permit class.
    pub reserved_pending_requests: usize,
    /// `retained_resident_bytes` is deducted from ingress capacity; the module enforces its internal memory budget.
    pub retained_resident_bytes: u64,
    /// `general_task_hold_bound` limits general-pool handler tasks parked on internal admission.
    /// Parked tasks use the general pool.
    /// Startup sums `general_task_hold_bound` across modules.
    /// Startup rejects configurations whose parked tasks could consume every general slot.
    /// Consuming every general slot would let one module's waiting traffic starve other routes of dispatch capacity.
    /// `general_task_hold_bound = 0` declares no long-parked general tasks.
    pub general_task_hold_bound: usize,
    /// The permit class every route bound to this module dispatches under.
    pub route_class: RouteClass,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteTarget {
    pub module_id: String,
    pub kind: TargetKind,
}

/// `RouteIdentity` fields are unverified claims that scope handler state but never grant authority.
#[derive(Clone, PartialEq, Eq)]
pub struct RouteIdentity {
    pub project_root: PathBuf,
    pub harness: String,
    pub session: String,
    pub consumer_module_id: Option<String>,
    pub consumer_launch_nonce: Option<String>,
    pub consumer_capabilities: Vec<String>,
    pub admission_facts: Option<serde_json::Value>,
    pub credential_fingerprints: BTreeMap<String, String>,
}

impl std::fmt::Debug for RouteIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // `Debug` exposes only structural metadata because identity claims may contain sensitive data.
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
            .field(
                "credential_fingerprints",
                &self.credential_fingerprints.len(),
            )
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub enum BindOutcome {
    Accept,
    /// `Reject` prevents route publication and terminates the `route.open` correlation with an error.
    Reject {
        code: String,
        message: String,
    },
}

impl std::fmt::Debug for BindOutcome {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Handler-controlled rejection codes and messages may contain identity data, so diagnostics expose only lengths.
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

/// Client JSON operations do not expose the health snapshot.
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

///
/// `RequestCtx::reserve_output` must reserve output storage before allocation; preallocated `Vec`s cannot bypass host limits.
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
    /// The `binary` flag has the same semantics as `RequestCtx::stream`.
    /// items.
    Response { body: OutputBuffer, binary: bool },
    /// An application failure causes the host to emit one canonical `Error` terminal.
    Error {
        code: String,
        message: String,
        /// The delay is advisory; callers may retry sooner.
        retry_after_ms: Option<u64>,
    },
    /// The host emits `StreamEnd` after items emitted through `RequestCtx::stream`.
    /// The host emits the `StreamEnd` terminal.
    Streamed,
}

impl RequestOutcome {
    pub fn error(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Error {
            code: code.into(),
            message: message.into(),
            retry_after_ms: None,
        }
    }

    pub fn error_retry_after(
        code: impl Into<String>,
        message: impl Into<String>,
        retry_after_ms: u64,
    ) -> Self {
        Self::Error {
            code: code.into(),
            message: message.into(),
            retry_after_ms: Some(retry_after_ms),
        }
    }
}

impl std::fmt::Debug for RequestOutcome {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Handler-controlled error codes and messages can contain request or identity data; diagnostics expose only their lengths.
        // Handler-controlled error codes and messages can contain request or identity data; diagnostics expose only their lengths.
        // Protocol V24 diagnostics expose only error-code and message lengths, matching `OutputBuffer` and `RequestCtx`.
        match self {
            Self::Response { body, binary } => f
                .debug_struct("Response")
                .field("body", body)
                .field("binary", binary)
                .finish(),
            Self::Error {
                code,
                message,
                retry_after_ms,
            } => f
                .debug_struct("Error")
                .field("code_len", &code.len())
                .field("message_len", &message.len())
                .field("retry_after_ms", retry_after_ms)
                .finish(),
            Self::Streamed => f.write_str("Streamed"),
        }
    }
}

/// The semantic request body owns its resident-byte charge.
/// The host decodes or copies transport bytes before construction, so asynchronous handler work never retains a receive lease.
/// Asynchronous handler work never retains a receive lease.
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

///
/// The host acquires the resident-byte charge before allocating this buffer.
/// The buffer's fixed maximum prevents writes from exceeding its reservation.
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
        // Diagnostics expose only the reserved output length, not application data.
        // Diagnostics mirror `RequestCtx` by exposing only the body length.
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

    /// `OutputBuffer::append` appends bytes without allocating beyond the host reservation.
    pub fn extend_from_slice(&mut self, bytes: &[u8]) -> Result<(), StreamClosed> {
        if self.direct.is_some() || bytes.len() > self.max_len.saturating_sub(self.body.len()) {
            return Err(StreamClosed);
        }
        self.body.extend_from_slice(bytes);
        Ok(())
    }

    /// `OutputBuffer::resize` resizes within the fixed reservation without permitting further growth.
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

/// Dropping `RequestCtx` without returning an outcome leaves settlement to the host through cancellation or teardown.
/// Dropping `RequestCtx` without returning an outcome leaves settlement to the host through cancellation or teardown.
///
/// `RequestCtx` hides transport correlations and sockets.
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
    /// `RequestBody` owns an opaque semantic body; `binary` selects binary or JSON encoding.
    /// Retaining the body retains its ingress byte charge.
    pub body: InputBuffer,
    pub binary: bool,
    pub(crate) cancel: CancellationToken,
    pub(crate) stream: crate::dispatch::StreamSink,
    /// `scratch` funds request scratch and request-derived ownership.
    /// `scratch` is separate from the pool that charged `body`.
    /// `scratch` charges cannot stall another connection's frame admission.
    pub(crate) scratch: crate::wire::ByteBudget,
}

impl RequestCtx {
    /// The future resolves when the host requests cancellation.
    /// The request may still complete because the host's first-terminal-wins arbiter selects the outcome.
    pub fn cancelled(&self) -> impl Future<Output = ()> + Send + '_ {
        self.cancel.cancelled()
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel.is_cancelled()
    }

    /// Reserves capacity and its resident-byte charge before allocating output.
    ///
    /// The returned buffer holds at most `max_len` body bytes and transfers its charge into a unary response or stream item.
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

    /// The reservation covers request-derived allocations, including parse scratch and owned trees decoded from `body`.
    /// The reservation covers state whose lifetime is the request rather than the response.
    ///
    /// `None` means the pool cannot cover the request now; reserve before allocating.
    /// Reserving after allocation lets the allocation escape the resident envelope.
    /// Concurrent requests can each exceed the envelope by their full allocation.
    /// The returned charge releases on drop; retain it while the charged bytes are resident.
    /// are live.
    pub fn try_reserve_resident(&self, bytes: usize) -> Option<crate::wire::ByteCharge> {
        self.scratch.try_charge(bytes)
    }

    /// The resident ceiling bounds `try_reserve_resident`.
    /// Reservations above the resident ceiling cannot be acquired.
    /// Callers treat requests above the resident ceiling as permanent rejection, not retryable backpressure.
    pub fn resident_capacity(&self) -> usize {
        self.scratch.capacity()
    }

    /// The stream queues one nonterminal `StreamData` item in order.
    /// The method returns `Err` after cancellation, terminal selection, or connection loss.
    /// After `Err`, `stream` cannot queue another item.
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

/// Output reservation or streaming cannot proceed after admission rejection, cancellation, terminal selection, or connection loss.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StreamClosed;

impl std::fmt::Display for StreamClosed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "request output is no longer accepted")
    }
}

impl std::error::Error for StreamClosed {}

#[derive(Debug)]
pub struct InitError(pub String);

impl std::fmt::Display for InitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "handler initialization failed: {}", self.0)
    }
}

impl std::error::Error for InitError {}

///
///
pub trait McHostHandler: Send + Sync + 'static {
    fn manifests(&self) -> Vec<ManifestSnapshot>;

    /// Implementations return one immutable `ResourceDeclaration` for each `manifests` entry.
    /// The host reads declarations once before initialization, in manifest order.
    /// The default returns zero-reservation declarations for every module.
    /// Zero reservations preserve existing single-pool admission.
    fn resource_declarations(&self) -> Vec<ResourceDeclaration> {
        vec![ResourceDeclaration::default(); self.manifests().len()]
    }

    /// `install_connection_key` installs the incarnation bearer used for protocol-internal credential-row fingerprints.
    /// The host calls `install_connection_key` before component initialization or route binding.
    fn install_connection_key(&self, _key: [u8; 32]) {}

    fn initialize(&self, init: HostInit) -> impl Future<Output = Result<(), InitError>> + Send;

    /// `activate` runs after transport publication and before request acceptance without gating readiness. For expected artifact faults, `activate` degrades the affected lane and returns `Ok(())`; `Err`, panic, and task loss are host-fatal. Because `shutdown` abandons unfinished activation, long-running work must use component-owned trackers drained by `shutdown`.
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

    /// `shutdown` drains handler-owned work and releases handler-owned resources.
    /// The host awaits `shutdown` before releasing the single-instance fence.
    /// Awaiting `shutdown` prevents a successor from starting while handler-owned work remains.
    ///
    /// `shutdown` runs at most once per incarnation and may run against a partially initialized handler.
    /// `shutdown` may run after `initialize` is interrupted.
    /// An interrupted `initialize` may already have handed work to handler-owned trackers.
    /// Only `shutdown` stops work held by handler-owned trackers.
    /// Implementations must tolerate partially initialized state by cancelling, closing, and draining existing resources.
    /// Implementations must not assert that initialization finished.
    fn shutdown(&self) -> impl Future<Output = ()> + Send;
}
