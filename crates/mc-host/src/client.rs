//! This module manages one authenticated mc-host generation.
//!
//! This module owns discovery, authentication, and mandatory negotiation.
//! This module owns correlation allocation, framing, liveness, route epochs, and bounded queues.
//! This module owns cancellation and cleanup; its public API never exposes raw frame types.

use std::{
    collections::{HashMap, HashSet},
    error::Error,
    fmt,
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc, LazyLock, Mutex, MutexGuard, Weak,
    },
    time::Duration,
};

use serde_json::Value;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    net::{tcp::OwnedWriteHalf, TcpStream},
    sync::{mpsc, oneshot},
    task::JoinHandle,
    time::{timeout_at, Instant},
};
use tokio_util::sync::{CancellationToken, DropGuard};

use crate::{
    auth::authenticate_client,
    connection_file::{read_for_client, ConnectionInfo, DAEMON_ID_LEN},
    handler::{RouteHandle, RouteIdentity, RouteTarget, TargetKind},
    transport_negotiation::{
        decode_negotiate_response, encode_negotiate_request, NegotiateRequest, NegotiateResponse,
        TransportOffer, NEGOTIATION_VERSION, TRANSPORT_TCP,
    },
    wire::{
        decode_header, encode_owned_frame, pure_header_flags, AdmissionClass, EnvelopeHeader,
        Flags, FrameId, FrameType, Priority, FROZEN_PREFIX_LEN, HEADER_LEN, MAX_BODY_LEN,
        MAX_CONTROL_BODY_LEN, PROTOCOL_VERSION,
    },
};

/// The client applies `CLIENT_HANDSHAKE_TIMEOUT` to dialing, authentication, and mandatory negotiation.
pub const CLIENT_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(2);
/// The client starts `CLIENT_FRAME_TIMEOUT` at the first header byte and leaves idle header waits unbounded.
pub const CLIENT_FRAME_TIMEOUT: Duration = Duration::from_secs(30);
/// The client applies `CLIENT_ROUTE_OPEN_TIMEOUT` to a route-open operation and its retries.
pub const CLIENT_ROUTE_OPEN_TIMEOUT: Duration = Duration::from_secs(30);
/// The client uses `CLIENT_REQUEST_TIMEOUT` as the default deadline for a request.
pub const CLIENT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// The owner must shut down within `CLIENT_SHUTDOWN_TIMEOUT`.
pub const CLIENT_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);
pub const CLIENT_MAX_PENDING_REQUESTS: usize = 1_024;
pub const CLIENT_MAX_LIVE_STREAMS: usize = 64;
/// Each stream queues at most `CLIENT_STREAM_QUEUE_ITEMS` items; saturation cancels only that stream.
pub const CLIENT_STREAM_QUEUE_ITEMS: usize = 16;
/// `CLIENT_DATA_QUEUE_FRAMES` limits ordinary writer slots; reserved controls consume none.
pub const CLIENT_DATA_QUEUE_FRAMES: usize = 256;
/// `CLIENT_CONTROL_QUEUE_FRAMES` reserves slots for pure-header Pong, Cancel, and Goodbye frames.
pub const CLIENT_CONTROL_QUEUE_FRAMES: usize = 32;
///
/// Reserved control frames use `CLIENT_CONTROL_QUEUED_BYTES` so ordinary traffic cannot starve them.
/// A failed control-byte charge retires the generation.
/// A failed data-byte charge returns a local error to that caller.
pub const CLIENT_QUEUED_BYTES: usize = MAX_BODY_LEN as usize + 1_048_576;
///
/// `CLIENT_CONTROL_QUEUED_BYTES` covers exactly `CLIENT_CONTROL_QUEUE_FRAMES` header-only control frames.
/// A control-byte charge can fail only when the control channel is full; that condition retires the generation.
pub const CLIENT_CONTROL_QUEUED_BYTES: usize = CLIENT_CONTROL_QUEUE_FRAMES * HEADER_LEN;
/// `CLIENT_INBOUND_FRAME_BYTES` reserves space for the body the reader is decoding.
///
/// An admitted connection must accept every otherwise-valid frame, so this reservation covers the framing maximum separately from `CLIENT_RETAINED_RESPONSE_BYTES`.
/// `CLIENT_INBOUND_FRAME_BYTES` is a per-connection ceiling because one reader decodes one frame at a time.
pub const CLIENT_INBOUND_FRAME_BYTES: usize = MAX_BODY_LEN as usize;
/// `CLIENT_RETAINED_RESPONSE_BYTES` caps owner-wide bytes retained in pending stream queues.
///
/// Queueing charges each item before a consumer reads it.
/// Exhausting `CLIENT_RETAINED_RESPONSE_BYTES` cancels only the saturating stream.
/// `CLIENT_RETAINED_RESPONSE_BYTES` admits one maximum-sized item plus 1_048_576 bytes.
/// One connection can retain at most `CLIENT_RETAINED_RESPONSE_BYTES + CLIENT_INBOUND_FRAME_BYTES` bytes.
pub const CLIENT_RETAINED_RESPONSE_BYTES: usize = MAX_BODY_LEN as usize + 1_048_576;

/// `CLIENT_DISCOVERY_SLOTS` caps concurrent connection-file snapshots process-wide.
///
const CLIENT_DISCOVERY_SLOTS: usize = 64;

/// The blocking closure holds each `CLIENT_DISCOVERY_SLOTS` permit.
/// A detached worker still holds its `CLIENT_DISCOVERY_SLOTS` permit.
static DISCOVERY_SLOTS: LazyLock<Arc<tokio::sync::Semaphore>> =
    LazyLock::new(|| Arc::new(tokio::sync::Semaphore::new(CLIENT_DISCOVERY_SLOTS)));

const NEGOTIATION_CORRELATION: u64 = 1;
const FIRST_APPLICATION_CORRELATION: u64 = 2;
const MAX_ERROR_CODE_BYTES: usize = 128;
const MAX_ERROR_MESSAGE_BYTES: usize = 512;
const READ_BUFFER_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendOutcome {
    /// Request bytes provably never reached the writer.
    NotSent,
    /// Some request bytes may have reached the peer without a terminal.
    OutcomeUnknown,
    /// The reader observed a matching host terminal.
    Terminal,
}

impl SendOutcome {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::NotSent => "not_sent",
            Self::OutcomeUnknown => "outcome_unknown",
            Self::Terminal => "terminal",
        }
    }
}

impl fmt::Display for SendOutcome {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// `CallError` formatting excludes raw host terminal messages.
#[derive(Clone, PartialEq, Eq)]
pub struct CallError {
    outcome: SendOutcome,
    code: String,
    message: String,
}

impl CallError {
    fn new(outcome: SendOutcome, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            outcome,
            code: bounded_code(&code.into()),
            message: bounded_text(&message.into(), MAX_ERROR_MESSAGE_BYTES),
        }
    }

    fn local(outcome: SendOutcome, code: &'static str, message: &'static str) -> Self {
        Self::new(outcome, code, message)
    }

    fn host_terminal(body: &[u8]) -> Self {
        let code = serde_json::from_slice::<Value>(body)
            .ok()
            .and_then(|value| value.get("code")?.as_str().map(str::to_owned))
            .map(|code| bounded_code(&code))
            .unwrap_or_else(|| "remote_error".to_owned());
        // Raw terminal messages may contain request, credential, or identity data.
        // `CallError` retains the bounded terminal code and discards the raw terminal message.
        Self::new(
            SendOutcome::Terminal,
            code,
            "host returned a terminal error (message redacted)",
        )
    }

    /// Send classification.
    pub const fn outcome(&self) -> SendOutcome {
        self.outcome
    }

    /// `CallError::new` bounds the error code.
    pub fn code(&self) -> &str {
        &self.code
    }

    /// The error message is bounded.
    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Debug for CallError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CallError")
            .field("outcome", &self.outcome)
            .field("code", &self.code)
            .field("message", &self.message)
            .finish()
    }
}

impl fmt::Display for CallError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {} ({})", self.outcome, self.message, self.code)
    }
}

impl Error for CallError {}

/// `ClientError` represents discovery, authentication, negotiation, or owner-lifecycle failures.
#[derive(Clone, PartialEq, Eq)]
pub struct ClientError {
    code: &'static str,
    message: &'static str,
}

impl ClientError {
    fn new(code: &'static str, message: &'static str) -> Self {
        Self { code, message }
    }

    /// The failure code is stable.
    pub const fn code(&self) -> &'static str {
        self.code
    }
}

impl fmt::Debug for ClientError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ClientError")
            .field("code", &self.code)
            .field("message", &self.message)
            .finish()
    }
}

impl fmt::Display for ClientError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} ({})", self.message, self.code)
    }
}

impl Error for ClientError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Response {
    /// Response bytes. The client does not interpret application payloads.
    pub body: Vec<u8>,
    /// The host sets `binary` when it marks the body as binary.
    pub binary: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HostStatusSnapshot {
    pub health: String,
    pub metrics: serde_json::Value,
}

/// The host emits each item in stream order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamItem {
    /// Item bytes.
    pub body: Vec<u8>,
    /// The host sets the item's binary flag.
    pub binary: bool,
}

#[derive(Debug, Clone)]
pub struct RequestOptions {
    /// Total operation budget. Queueing, publication, and terminal wait share it.
    pub timeout: Duration,
    pub cancellation: Option<CancellationToken>,
}

impl Default for RequestOptions {
    fn default() -> Self {
        Self {
            timeout: CLIENT_REQUEST_TIMEOUT,
            cancellation: None,
        }
    }
}

/// The client manages one authenticated daemon generation through this connection.
pub struct Client {
    inner: Arc<Inner>,
}

impl fmt::Debug for Client {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Client")
            .field("closed", &self.inner.closed.load(Ordering::Acquire))
            .finish_non_exhaustive()
    }
}

impl Client {
    /// The client discovers, authenticates, and negotiates one TCP generation.
    ///
    /// Discovery validates one descriptor-anchored snapshot before any dial.
    pub async fn connect(path: impl AsRef<Path>) -> Result<Self, ClientError> {
        // The handshake deadline includes discovery.
        // Starting the deadline after discovery would give filesystem stalls unbounded time.
        // The snapshot runs on a blocking pool because filesystem work is synchronous.
        // A wedged mount would otherwise occupy an async worker for the mount's duration.
        let deadline = Instant::now() + CLIENT_HANDSHAKE_TIMEOUT;
        let path = path.as_ref().to_path_buf();
        // `DISCOVERY_SLOTS` limits concurrent discovery snapshots.
        // `spawn_blocking` cannot cancel submitted work.
        // Dropping the join handle detaches the closure.
        // A filesystem syscall on a wedged mount retains its blocking worker until the call returns.
        // Each reconnect attempt can strand another blocking worker until its filesystem call returns.
        // Each timed-out attempt can strand a blocking worker until the filesystem call returns.
        // The permit limits blocking workers occupied by abandoned mounts.
        // A detached worker retains the permit, so the cap counts active workers rather than waiting callers.
        // Waiting for a permit spends the handshake deadline budget.
        // Permit exhaustion surfaces as `handshake_timeout`.
        let permit = timeout_at(deadline, Arc::clone(&DISCOVERY_SLOTS).acquire_owned())
            .await
            .map_err(|_| ClientError::new("handshake_timeout", "client handshake timed out"))?
            .expect("discovery semaphore is never closed");
        let info = timeout_at(
            deadline,
            tokio::task::spawn_blocking(move || {
                let _permit = permit;
                read_for_client(path)
            }),
        )
        .await
        .map_err(|_| ClientError::new("handshake_timeout", "client handshake timed out"))?
        .map_err(|_| ClientError::new("discovery_failed", "secure discovery failed"))?
        .map_err(|_| ClientError::new("discovery_failed", "secure discovery failed"))?;
        Self::connect_info(info, deadline).await
    }

    async fn connect_info(info: ConnectionInfo, deadline: Instant) -> Result<Self, ClientError> {
        let endpoint = info
            .endpoints
            .first()
            .ok_or_else(|| ClientError::new("discovery_failed", "secure discovery failed"))?
            .clone();
        let mut stream = timeout_at(
            deadline,
            TcpStream::connect((endpoint.host.as_str(), endpoint.port)),
        )
        .await
        .map_err(|_| ClientError::new("handshake_timeout", "client handshake timed out"))?
        .map_err(|_| ClientError::new("dial_failed", "daemon dial failed"))?;
        // `TCP_NODELAY` disables Nagle coalescing for interactive request/response traffic.
        // accept path.
        let _ = stream.set_nodelay(true);
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(ClientError::new(
                "handshake_timeout",
                "client handshake timed out",
            ));
        }
        let authenticated =
            timeout_at(deadline, authenticate_client(&mut stream, &info, remaining))
                .await
                .map_err(|_| ClientError::new("handshake_timeout", "client handshake timed out"))?
                .map_err(|_| {
                    ClientError::new("authentication_failed", "daemon authentication failed")
                })?;
        negotiate_tcp(&mut stream, deadline).await?;

        let (read, write) = stream.into_split();
        let (data_tx, data_rx) = mpsc::channel(CLIENT_DATA_QUEUE_FRAMES);
        let (control_tx, control_rx) = mpsc::channel(CLIENT_CONTROL_QUEUE_FRAMES);
        let inner = Arc::new(Inner {
            daemon_id: info.daemon_id,
            daemon_ver: authenticated.daemon_ver,
            closed: AtomicBool::new(false),
            retired: AtomicBool::new(false),
            cancel: CancellationToken::new(),
            correlations: Mutex::new(Correlations::new(FIRST_APPLICATION_CORRELATION)),
            admission: Mutex::new(()),
            pending: Mutex::new(HashMap::new()),
            streams: Mutex::new(0),
            routes: Mutex::new(HashSet::new()),
            queue_budget: Arc::new(ByteCounter::new(CLIENT_QUEUED_BYTES)),
            control_budget: Arc::new(ByteCounter::new(CLIENT_CONTROL_QUEUED_BYTES)),
            read_budget: Arc::new(ByteCounter::new(CLIENT_INBOUND_FRAME_BYTES)),
            retained_budget: Arc::new(ByteCounter::new(CLIENT_RETAINED_RESPONSE_BYTES)),
            data_tx,
            control_tx,
            close_lock: tokio::sync::Mutex::new(()),
            reader: tokio::sync::Mutex::new(None),
            writer: tokio::sync::Mutex::new(None),
        });
        let writer_inner = Arc::clone(&inner);
        let writer = tokio::spawn(async move {
            writer_loop(writer_inner, write, data_rx, control_rx).await;
        });
        let reader_inner = Arc::clone(&inner);
        let reader = tokio::spawn(async move {
            reader_loop(
                reader_inner,
                tokio::io::BufReader::with_capacity(READ_BUFFER_BYTES, read),
            )
            .await;
        });
        *inner.writer.lock().await = Some(writer);
        *inner.reader.lock().await = Some(reader);
        // `reader_loop` can retire the connection generation concurrently.
        // `reader_loop` can retire this generation before the constructor returns when the peer closes or sends connection `Goodbye` after negotiation.
        // Returning before that retirement would defer the connection failure until the first operation.
        // The first operation reports `connection_retired` with `SendOutcome::NotSent`.
        if inner.retired.load(Ordering::Acquire) {
            return Err(ClientError::new(
                "connection_retired",
                "connection retired during setup",
            ));
        }
        Ok(Self { inner })
    }

    /// Authentication verifies the daemon ID against secure discovery and the proof transcript.
    pub fn daemon_id(&self) -> [u8; DAEMON_ID_LEN] {
        self.inner.daemon_id
    }

    /// Returns the daemon version obtained during authentication.
    pub fn daemon_ver(&self) -> &str {
        &self.inner.daemon_ver
    }

    /// Opens a full `(channel, epoch)` route under one absolute 30-second deadline.
    pub async fn open_route(
        &self,
        target: RouteTarget,
        identity: RouteIdentity,
    ) -> Result<RouteHandle, CallError> {
        if self.inner.closed.load(Ordering::Acquire) {
            return Err(CallError::local(
                SendOutcome::NotSent,
                "client_closed",
                "client is closed",
            ));
        }
        let body = route_open_body(&target, &identity)?;
        let deadline = Instant::now() + CLIENT_ROUTE_OPEN_TIMEOUT;
        let mut backoff = Duration::from_millis(25);
        loop {
            let response = self
                .inner
                .unary(
                    RouteHandle {
                        channel: 0,
                        epoch: 0,
                    },
                    body.clone(),
                    deadline,
                    None,
                )
                .await;
            match response {
                Ok(response) => {
                    // `parse_route_open` must return a usable tag, channel, and epoch.
                    // Without a usable tag, channel, and epoch, the client cannot name the host-bound route.
                    // The client cannot send route `Goodbye` for a route it cannot name.
                    // Leaving the connection live after an unnameable route lets repeated opens strand host-side routes and channel permits.
                    // Retiring the connection obliges the host to settle every route on the generation.
                    // The host must settle the route for which `parse_route_open` produced no handle.
                    let handle = match parse_route_open(&response.body) {
                        Ok(handle) => handle,
                        Err(error) => {
                            self.inner.retire("invalid_route_response");
                            return Err(error);
                        }
                    };
                    // Holding `routes` while inserting and checking `closed` prevents `close` from missing a newly opened handle.
                    // A close between response receipt and handle insertion can leave the handle outside the drained set.
                    // Returning that handle would produce `Ok` even though its first use fails with `client_closed`.
                    // `close` takes precedence over a concurrent successful route open.
                    // `close` sends connection `Goodbye`, so this race needs no route `Goodbye`.
                    {
                        let mut routes = lock_unpoisoned(&self.inner.routes);
                        if self.inner.closed.load(Ordering::Acquire) {
                            return Err(CallError::local(
                                SendOutcome::NotSent,
                                "client_closed",
                                "client is closed",
                            ));
                        }
                        routes.insert(handle);
                    }
                    return Ok(handle);
                }
                Err(error)
                    if error.outcome == SendOutcome::Terminal
                        && matches!(
                            error.code.as_str(),
                            "unknown_module"
                                | "module_reloading"
                                | "target_unavailable"
                                | "module_timeout"
                        )
                        && Instant::now() < deadline =>
                {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    tokio::time::sleep(backoff.min(remaining)).await;
                    backoff = (backoff * 2).min(Duration::from_millis(500));
                }
                Err(error) => return Err(error),
            }
        }
    }

    /// The request body is never replayed.
    pub async fn request(
        &self,
        route: RouteHandle,
        body: Vec<u8>,
        options: RequestOptions,
    ) -> Result<Response, CallError> {
        self.require_route(route)?;
        let deadline = request_deadline(options.timeout)?;
        self.inner
            .unary(route, body, deadline, options.cancellation)
            .await
    }

    pub async fn request_stream(
        &self,
        route: RouteHandle,
        body: Vec<u8>,
        options: RequestOptions,
    ) -> Result<ResponseStream, CallError> {
        self.require_route(route)?;
        self.inner.start_stream(route, body, options)
    }

    /// Cancels one correlation on exactly the supplied route epoch.
    pub fn cancel(&self, route: RouteHandle, correlation: u64) -> Result<(), CallError> {
        self.require_route(route)?;
        self.inner
            .cancel_key(PendingKey::new(route, correlation), "cancelled")?;
        Ok(())
    }

    /// Idempotently closes one exact route generation.
    pub async fn close_route(&self, route: RouteHandle) -> Result<(), ClientError> {
        if !self.inner.settle_route(route) {
            return Ok(());
        }
        let deadline = Instant::now() + CLIENT_SHUTDOWN_TIMEOUT;
        self.inner
            .send_control_wait(FrameType::Goodbye, FrameId::routed(route, 0), deadline)
            .await
    }

    /// `Ok` means the complete `host.shutdown` response frame reached the socket; the connection remains open.
    pub async fn host_shutdown(&self) -> Result<(), CallError> {
        if self.inner.closed.load(Ordering::Acquire) {
            return Err(CallError::local(
                SendOutcome::NotSent,
                "client_closed",
                "client is closed",
            ));
        }
        let body = br#"{"op":"host.shutdown"}"#.to_vec();
        let deadline = Instant::now() + CLIENT_SHUTDOWN_TIMEOUT;
        let response = self
            .inner
            .unary(
                RouteHandle {
                    channel: 0,
                    epoch: 0,
                },
                body,
                deadline,
                None,
            )
            .await?;
        let acknowledged = serde_json::from_slice::<serde_json::Value>(&response.body)
            .ok()
            .and_then(|value| {
                value
                    .get("op")
                    .and_then(serde_json::Value::as_str)
                    .map(|op| op == "host.shutdown")
            })
            .unwrap_or(false);
        if !acknowledged {
            return Err(CallError::local(
                SendOutcome::Terminal,
                "invalid_shutdown_response",
                "host.shutdown response did not echo the operation",
            ));
        }
        Ok(())
    }

    /// Reads the host-owned readiness snapshot without opening a route or sending an application body.
    pub async fn host_status(&self) -> Result<HostStatusSnapshot, CallError> {
        #[derive(serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        struct WireStatus {
            op: String,
            health: String,
            metrics: serde_json::Value,
        }

        if self.inner.closed.load(Ordering::Acquire) {
            return Err(CallError::local(
                SendOutcome::NotSent,
                "client_closed",
                "client is closed",
            ));
        }
        let deadline = Instant::now() + CLIENT_REQUEST_TIMEOUT;
        let response = self
            .inner
            .unary(
                RouteHandle {
                    channel: 0,
                    epoch: 0,
                },
                br#"{"op":"host.status"}"#.to_vec(),
                deadline,
                None,
            )
            .await?;
        let decoded = serde_json::from_slice::<WireStatus>(&response.body).map_err(|_| {
            CallError::local(
                SendOutcome::Terminal,
                "invalid_host_status_response",
                "host.status response is malformed",
            )
        })?;
        if decoded.op != "host.status"
            || !matches!(decoded.health.as_str(), "ok" | "degraded" | "failing")
        {
            return Err(CallError::local(
                SendOutcome::Terminal,
                "invalid_host_status_response",
                "host.status response has an invalid identity",
            ));
        }
        Ok(HostStatusSnapshot {
            health: decoded.health,
            metrics: decoded.metrics,
        })
    }

    pub async fn close(&self) -> Result<(), ClientError> {
        let deadline = Instant::now() + CLIENT_SHUTDOWN_TIMEOUT;
        let _close = timeout_at(deadline, self.inner.close_lock.lock())
            .await
            .map_err(|_| {
                self.inner.retire("shutdown_timeout");
                ClientError::new("shutdown_timeout", "client shutdown timed out")
            })?;
        let mut guard = CloseGuard::new(&self.inner);
        let already_closed = self.inner.closed.swap(true, Ordering::AcqRel);
        let mut result = Ok(());
        if !already_closed {
            self.inner.settle_all("owner_close");
            let routes: Vec<_> = lock_unpoisoned(&self.inner.routes).drain().collect();
            for route in routes {
                if self
                    .inner
                    .send_control_wait(FrameType::Goodbye, FrameId::routed(route, 0), deadline)
                    .await
                    .is_err()
                {
                    result = Err(ClientError::new(
                        "shutdown_timeout",
                        "client shutdown timed out",
                    ));
                    break;
                }
            }
            if result.is_ok()
                && self
                    .inner
                    .send_control_wait(FrameType::Goodbye, FrameId::control(0), deadline)
                    .await
                    .is_err()
            {
                result = Err(ClientError::new(
                    "shutdown_timeout",
                    "client shutdown timed out",
                ));
            }
            self.inner.cancel.cancel();
        }
        if !self.inner.join_tasks_until(deadline).await {
            result = Err(ClientError::new(
                "shutdown_timeout",
                "client shutdown timed out",
            ));
        }
        guard.disarm();
        result
    }

    fn require_route(&self, route: RouteHandle) -> Result<(), CallError> {
        if self.inner.closed.load(Ordering::Acquire) {
            return Err(CallError::local(
                SendOutcome::NotSent,
                "client_closed",
                "client is closed",
            ));
        }
        if !lock_unpoisoned(&self.inner.routes).contains(&route) {
            return Err(CallError::local(
                SendOutcome::NotSent,
                "route_not_live",
                "route is not live on this generation",
            ));
        }
        Ok(())
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        self.inner.retire("owner_drop");
    }
}

struct CloseGuard<'a> {
    inner: &'a Inner,
    armed: bool,
}

impl<'a> CloseGuard<'a> {
    const fn new(inner: &'a Inner) -> Self {
        Self { inner, armed: true }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for CloseGuard<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.inner.retire("owner_close_dropped");
        }
    }
}

/// `ResponseStream` consumes one bounded stream. Dropping `ResponseStream` emits a best-effort Cancel.
pub struct ResponseStream {
    inner: Weak<Inner>,
    key: PendingKey,
    correlation: u64,
    items: mpsc::Receiver<ChargedItem>,
    terminal: Option<oneshot::Receiver<Result<(), CallError>>>,
    finished: bool,
}

impl fmt::Debug for ResponseStream {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ResponseStream")
            .field("correlation", &self.correlation)
            .field("finished", &self.finished)
            .finish_non_exhaustive()
    }
}

impl ResponseStream {
    pub const fn correlation(&self) -> u64 {
        self.correlation
    }

    /// Returns next ordered item, `None` after StreamEnd, or terminal error.
    pub async fn next(&mut self) -> Result<Option<StreamItem>, CallError> {
        if self.finished {
            return Ok(None);
        }
        if let Ok(item) = self.items.try_recv() {
            return Ok(Some(item.into_public()));
        }
        let Some(terminal) = self.terminal.as_mut() else {
            self.finished = true;
            return Ok(None);
        };
        enum Next {
            Item(ChargedItem),
            ItemsClosed,
            Terminal(Result<Result<(), CallError>, oneshot::error::RecvError>),
        }
        let next = tokio::select! {
            biased;
            item = self.items.recv() => match item {
                Some(item) => Next::Item(item),
                None => Next::ItemsClosed,
            },
            result = terminal => Next::Terminal(result),
        };
        match next {
            Next::Item(item) => Ok(Some(item.into_public())),
            Next::ItemsClosed => {
                let Some(terminal) = self.terminal.take() else {
                    self.finished = true;
                    return Err(retired_error(SendOutcome::OutcomeUnknown));
                };
                let result = terminal
                    .await
                    .unwrap_or_else(|_| Err(retired_error(SendOutcome::OutcomeUnknown)));
                self.finished = true;
                result.map(|()| None)
            }
            Next::Terminal(result) => {
                self.finished = true;
                self.terminal = None;
                result
                    .unwrap_or_else(|_| Err(retired_error(SendOutcome::OutcomeUnknown)))
                    .map(|()| None)
            }
        }
    }

    /// Cancels the stream once. Cleanup remains epoch- and correlation-scoped.
    pub fn cancel(&mut self) -> Result<(), CallError> {
        if self.finished {
            return Ok(());
        }
        self.finished = true;
        // Buffered items retain `ByteCharge`s against the owner-wide retained-response budget.
        // When `finished` is true, `next` cannot drain buffered items.
        // Buffered items remain charged while the caller retains `ResponseStream`.
        // Exhausting the retained-response budget retires the generation.
        // Close the response channel before draining it so the reader task cannot refill it.
        self.items.close();
        while self.items.try_recv().is_ok() {}
        if let Some(inner) = self.inner.upgrade() {
            inner.cancel_key(self.key, "cancelled")?;
        }
        Ok(())
    }
}

impl Drop for ResponseStream {
    fn drop(&mut self) {
        let _ = self.cancel();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct PendingKey {
    channel: u16,
    epoch: u32,
    corr: u64,
}

impl PendingKey {
    fn new(route: RouteHandle, corr: u64) -> Self {
        Self {
            channel: route.channel,
            epoch: route.epoch,
            corr,
        }
    }

    fn route(self) -> RouteHandle {
        RouteHandle {
            channel: self.channel,
            epoch: self.epoch,
        }
    }
}

const QUEUED: u8 = 0;
const WRITING: u8 = 1;
const WRITTEN: u8 = 2;
const CANCELLED: u8 = 3;

/// Indicates whether `stop` removed the pending entry.
///
/// `Cancelled` means this stop settled the caller; `AlreadyTaken` means another owner may still send a terminal result.
/// flight.
#[derive(Debug)]
enum PendingRemoval {
    /// This stop removed the entry and settled the caller.
    Cancelled,
    /// The entry was gone, so another owner may still send a terminal result.
    AlreadyTaken,
}

struct PendingState {
    publish: Arc<AtomicU8>,
    kind: PendingKind,
}

enum PendingKind {
    Unary(oneshot::Sender<Result<Response, CallError>>),
    Stream {
        items: mpsc::Sender<ChargedItem>,
        terminal: oneshot::Sender<Result<(), CallError>>,
        /// Dropping the pending entry cancels its deadline watcher.
        /// The guard covers every settlement path because each path drops the pending entry.
        _settled: DropGuard,
    },
}

struct Inner {
    daemon_id: [u8; DAEMON_ID_LEN],
    daemon_ver: String,
    closed: AtomicBool,
    retired: AtomicBool,
    cancel: CancellationToken,
    correlations: Mutex<Correlations>,
    admission: Mutex<()>,
    pending: Mutex<HashMap<PendingKey, PendingState>>,
    streams: Mutex<usize>,
    routes: Mutex<HashSet<RouteHandle>>,
    queue_budget: Arc<ByteCounter>,
    /// The client reserves queue capacity for header-only control frames so data traffic cannot starve Pong, Cancel, or Goodbye.
    control_budget: Arc<ByteCounter>,
    /// The client reserves `read_budget` separately from `retained_budget` so retained responses cannot reject a valid inbound frame.
    read_budget: Arc<ByteCounter>,
    retained_budget: Arc<ByteCounter>,
    data_tx: mpsc::Sender<QueuedFrame>,
    control_tx: mpsc::Sender<QueuedFrame>,
    close_lock: tokio::sync::Mutex<()>,
    reader: tokio::sync::Mutex<Option<JoinHandle<()>>>,
    writer: tokio::sync::Mutex<Option<JoinHandle<()>>>,
}

impl Inner {
    async fn unary(
        self: &Arc<Self>,
        route: RouteHandle,
        body: Vec<u8>,
        deadline: Instant,
        cancellation: Option<CancellationToken>,
    ) -> Result<Response, CallError> {
        // A token cancelled before the call must not enqueue anything.
        // Admission must reject pre-cancelled tokens because `select!` runs only after admission.
        // Once writer admission succeeds, the writer may claim the frame despite the biased cancellation `select!`.
        if cancellation
            .as_ref()
            .is_some_and(CancellationToken::is_cancelled)
        {
            return Err(CallError::local(
                SendOutcome::NotSent,
                "cancelled",
                "request was cancelled",
            ));
        }
        let (tx, rx) = oneshot::channel();
        let mut rx = rx;
        let (key, publish) = self.admit(route, body, PendingKind::Unary(tx), deadline)?;
        let mut guard = UnaryAdmissionGuard::new(Arc::clone(self), key);
        let cancelled = cancellation.unwrap_or_default();
        // The stop branches borrow `rx` after `select!` because `dispatch` removes the pending entry before sending a terminal; a stop in that window must await the authoritative result.
        enum Stopped {
            Terminal(Result<Response, CallError>),
            Cancelled,
            DeadlineExpired,
        }
        let stopped = tokio::select! {
            biased;
            result = &mut rx => Stopped::Terminal(
                result.unwrap_or_else(|_| Err(retired_error(classify(&publish)))),
            ),
            () = cancelled.cancelled() => Stopped::Cancelled,
            () = tokio::time::sleep_until(deadline) => Stopped::DeadlineExpired,
        };
        let result = match stopped {
            Stopped::Terminal(result) => result,
            Stopped::Cancelled => {
                self.stop_or_take_terminal(
                    key,
                    &mut rx,
                    &publish,
                    "cancelled",
                    "request was cancelled",
                )
                .await
            }
            Stopped::DeadlineExpired => {
                self.stop_or_take_terminal(
                    key,
                    &mut rx,
                    &publish,
                    "deadline_expired",
                    "request deadline expired",
                )
                .await
            }
        };
        guard.disarm();
        result
    }

    fn start_stream(
        self: &Arc<Self>,
        route: RouteHandle,
        body: Vec<u8>,
        options: RequestOptions,
    ) -> Result<ResponseStream, CallError> {
        let deadline = request_deadline(options.timeout)?;
        // The client rejects pre-cancelled tokens before admission because the writer can transmit a request before its cancellation watcher starts.
        if options
            .cancellation
            .as_ref()
            .is_some_and(CancellationToken::is_cancelled)
        {
            return Err(CallError::local(
                SendOutcome::NotSent,
                "cancelled",
                "request was cancelled",
            ));
        }
        {
            let mut streams = lock_unpoisoned(&self.streams);
            if *streams >= CLIENT_MAX_LIVE_STREAMS {
                return Err(CallError::local(
                    SendOutcome::NotSent,
                    "stream_capacity",
                    "live stream capacity exhausted",
                ));
            }
            *streams += 1;
        }
        let (item_tx, item_rx) = mpsc::channel(CLIENT_STREAM_QUEUE_ITEMS);
        let (terminal_tx, terminal_rx) = oneshot::channel();
        let settled = CancellationToken::new();
        let admitted = self.admit(
            route,
            body,
            PendingKind::Stream {
                items: item_tx,
                terminal: terminal_tx,
                _settled: settled.clone().drop_guard(),
            },
            deadline,
        );
        let (key, _publish) = match admitted {
            Ok(value) => value,
            Err(error) => {
                *lock_unpoisoned(&self.streams) -= 1;
                return Err(error);
            }
        };
        // A default token keeps the cancellation branch available when no cancellation token is supplied.
        let cancel = options.cancellation.unwrap_or_default();
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            tokio::select! {
                biased;
                // The client must not cancel a correlation the host may have reused.
                () = settled.cancelled() => {}
                () = cancel.cancelled() => {
                    if let Some(inner) = weak.upgrade() {
                        let _ = inner.cancel_key(key, "cancelled");
                    }
                }
                () = tokio::time::sleep_until(deadline) => {
                    if let Some(inner) = weak.upgrade() {
                        let _ = inner.cancel_key(key, "deadline_expired");
                    }
                }
            }
        });
        Ok(ResponseStream {
            inner: Arc::downgrade(self),
            key,
            correlation: key.corr,
            items: item_rx,
            terminal: Some(terminal_rx),
            finished: false,
        })
    }

    fn admit(
        &self,
        route: RouteHandle,
        body: Vec<u8>,
        kind: PendingKind,
        deadline: Instant,
    ) -> Result<(PendingKey, Arc<AtomicU8>), CallError> {
        if self.closed.load(Ordering::Acquire) || self.retired.load(Ordering::Acquire) {
            return Err(CallError::local(
                SendOutcome::NotSent,
                "connection_retired",
                "connection generation is retired",
            ));
        }
        if Instant::now() >= deadline {
            return Err(CallError::local(
                SendOutcome::NotSent,
                "deadline_expired",
                "request deadline expired before admission",
            ));
        }
        let _admission = lock_unpoisoned(&self.admission);
        let mut pending = lock_unpoisoned(&self.pending);
        if self.closed.load(Ordering::Acquire) || self.retired.load(Ordering::Acquire) {
            return Err(CallError::local(
                SendOutcome::NotSent,
                "connection_retired",
                "connection generation is retired",
            ));
        }
        if route
            != (RouteHandle {
                channel: 0,
                epoch: 0,
            })
            && !lock_unpoisoned(&self.routes).contains(&route)
        {
            return Err(CallError::local(
                SendOutcome::NotSent,
                "route_not_live",
                "route is not live on this generation",
            ));
        }
        if Instant::now() >= deadline {
            return Err(CallError::local(
                SendOutcome::NotSent,
                "deadline_expired",
                "request deadline expired before admission",
            ));
        }
        if pending.len() >= CLIENT_MAX_PENDING_REQUESTS {
            return Err(CallError::local(
                SendOutcome::NotSent,
                "pending_capacity",
                "pending request capacity exhausted",
            ));
        }
        let mut correlations = lock_unpoisoned(&self.correlations);
        let corr = correlations.allocate().ok_or_else(|| {
            CallError::local(
                SendOutcome::NotSent,
                "correlations_exhausted",
                "correlation space exhausted after u64::MAX",
            )
        })?;
        let key = PendingKey::new(route, corr);
        let publish = Arc::new(AtomicU8::new(QUEUED));
        let frame = match encode_data_frame(
            route,
            corr,
            body,
            Arc::clone(&publish),
            &self.queue_budget,
            deadline,
        ) {
            Ok(frame) => frame,
            Err(error) => {
                correlations.restore(corr);
                return Err(error);
            }
        };
        pending.insert(
            key,
            PendingState {
                publish: Arc::clone(&publish),
                kind,
            },
        );
        if self.data_tx.try_send(frame).is_err() {
            pending.remove(&key);
            correlations.restore(corr);
            return Err(CallError::local(
                SendOutcome::NotSent,
                "writer_queue_full",
                "writer data queue is full",
            ));
        }
        Ok((key, publish))
    }

    /// `stop_or_take_terminal` stops a pending unary request and prefers a terminal that beat the stop.
    ///
    /// `dispatch` removes the pending entry before publishing the terminal, so cancellation or deadline in that window finds nothing to cancel.
    /// When `remove` finds no entry, the caller awaits the terminal instead of returning a local error.
    async fn stop_or_take_terminal(
        &self,
        key: PendingKey,
        rx: &mut oneshot::Receiver<Result<Response, CallError>>,
        publish: &AtomicU8,
        code: &'static str,
        message: &'static str,
    ) -> Result<Response, CallError> {
        let stopped = match self.cancel_key(key, code) {
            Ok(PendingRemoval::AlreadyTaken) => {
                return rx
                    .await
                    .unwrap_or_else(|_| Err(retired_error(classify(publish))));
            }
            // `cancel_key` has already settled the channel, so `try_recv` observes its own result.
            Ok(PendingRemoval::Cancelled) => {
                if let Ok(result) = rx.try_recv() {
                    return result;
                }
                None
            }
            Err(error) => Some(error.outcome),
        };
        let outcome = stopped.unwrap_or_else(|| classify(publish));
        Err(CallError::local(outcome, code, message))
    }

    fn cancel_key(&self, key: PendingKey, code: &'static str) -> Result<PendingRemoval, CallError> {
        let state = lock_unpoisoned(&self.pending).remove(&key);
        let Some(state) = state else {
            return Ok(PendingRemoval::AlreadyTaken);
        };
        let outcome = if state
            .publish
            .compare_exchange(QUEUED, CANCELLED, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            SendOutcome::NotSent
        } else {
            SendOutcome::OutcomeUnknown
        };
        self.finish_pending(
            state,
            Err(CallError::local(outcome, code, "request stopped")),
        );
        if outcome == SendOutcome::OutcomeUnknown {
            // Control requests use identity 0/0, but §6.2 permits `Cancel` only for a pending nonzero correlation on a current nonzero route.
            // `cancel_key` preserves `OutcomeUnknown` because the request may already have reached the host.
            // OutcomeUnknown prevents the caller from treating the request as replay-safe.
            if key.channel == 0 {
                return Ok(PendingRemoval::Cancelled);
            }
            // `Cancel` is best-effort cleanup.
            // A failed Cancel enqueue returns an error without changing the request's OutcomeUnknown.
            // A concurrently retired generation can make the Cancel outcome NotSent.
            // Replacing OutcomeUnknown with the Cancel's NotSent outcome would incorrectly mark a possibly delivered request as replay-safe.
            // is replay-safe.
            if let Err(error) = self.send_control(
                FrameType::Cancel,
                pure_header_flags(),
                FrameId {
                    channel: key.channel,
                    epoch: key.epoch,
                    corr: key.corr,
                },
                None,
            ) {
                return Err(CallError::new(outcome, error.code, error.message));
            }
        }
        Ok(PendingRemoval::Cancelled)
    }

    ///
    /// `flags` is explicit because `Pong` must echo `Ping` flags exactly, while §6.1 permits any valid priority.
    /// `Pong` must echo `Ping` flags exactly (V35), while §6.1 permits any valid priority.
    /// `Pong` must echo `Ping` flags exactly.
    fn send_control(
        &self,
        ty: FrameType,
        flags: Flags,
        id: FrameId,
        ack: Option<oneshot::Sender<()>>,
    ) -> Result<(), CallError> {
        if self.retired.load(Ordering::Acquire) {
            return Err(retired_error(SendOutcome::NotSent));
        }
        let bytes = encode_owned_frame(ty, flags, id, Vec::new()).map_err(|_| {
            CallError::local(
                SendOutcome::NotSent,
                "encode_failed",
                "control encode failed",
            )
        })?;
        // `send_control` uses the reserved pool so ordinary requests cannot prevent control-frame admission.
        // self-inflicted teardown.
        let charge = self.control_budget.charge(bytes.len()).ok_or_else(|| {
            self.retire("control_capacity_exhausted");
            CallError::local(
                SendOutcome::Terminal,
                "control_capacity_exhausted",
                "reserved control admission exhausted",
            )
        })?;
        let frame = QueuedFrame {
            bytes,
            charge,
            publish: None,
            ack,
            deadline: Instant::now() + CLIENT_FRAME_TIMEOUT,
        };
        if self.control_tx.try_send(frame).is_err() {
            self.retire("control_capacity_exhausted");
            return Err(CallError::local(
                SendOutcome::Terminal,
                "control_capacity_exhausted",
                "reserved control admission exhausted",
            ));
        }
        Ok(())
    }

    async fn send_control_wait(
        &self,
        ty: FrameType,
        id: FrameId,
        deadline: Instant,
    ) -> Result<(), ClientError> {
        let (tx, rx) = oneshot::channel();
        self.send_control(ty, pure_header_flags(), id, Some(tx))
            .map_err(|_| {
                ClientError::new(
                    "control_capacity_exhausted",
                    "client control admission failed",
                )
            })?;
        timeout_at(deadline, rx)
            .await
            .map_err(|_| ClientError::new("shutdown_timeout", "client shutdown timed out"))?
            .map_err(|_| ClientError::new("connection_retired", "connection retired"))
    }

    fn dispatch(self: &Arc<Self>, header: EnvelopeHeader, body: Vec<u8>, charge: ByteCharge) {
        match header.ty {
            FrameType::Ping => {
                // `Pong` echoes `Ping` flags exactly.
                let _ = self.send_control(
                    FrameType::Pong,
                    header.flags,
                    FrameId::control(header.corr),
                    None,
                );
            }
            FrameType::Goodbye if header.channel == 0 => self.retire("connection_goodbye"),
            FrameType::Goodbye => {
                let route = RouteHandle {
                    channel: header.channel,
                    epoch: header.epoch,
                };
                self.settle_route(route);
            }
            FrameType::Push => {}
            FrameType::Response | FrameType::Error | FrameType::StreamEnd => {
                let key = PendingKey {
                    channel: header.channel,
                    epoch: header.epoch,
                    corr: header.corr,
                };
                let state = lock_unpoisoned(&self.pending).remove(&key);
                let Some(state) = state else {
                    // A `Response` on identity 0/0 can carry a route bound for an `open_route` caller that dropped or timed out.
                    // A `Response` on identity 0/0 can carry a route bound for an `open_route` caller that dropped or timed out.
                    // A `Response` on identity 0/0 can carry a route bound for an `open_route` caller that dropped or timed out.
                    // An abandoned `open_route` on identity 0/0 cannot withdraw its bind because §6.2 permits no `Cancel`.
                    if header.ty == FrameType::Response && header.channel == 0 {
                        self.release_stranded_route(&body);
                    }
                    return;
                };
                drop(charge);
                match state.kind {
                    PendingKind::Unary(tx) => {
                        let result = match header.ty {
                            FrameType::Response => Ok(Response {
                                body,
                                binary: header.flags.is_binary(),
                            }),
                            FrameType::Error => Err(CallError::host_terminal(&body)),
                            FrameType::StreamEnd => Err(CallError::local(
                                SendOutcome::Terminal,
                                "unexpected_stream",
                                "unary request received stream terminal",
                            )),
                            _ => unreachable!(),
                        };
                        let _ = tx.send(result);
                    }
                    PendingKind::Stream { terminal, .. } => {
                        // Direct settlement retires the deadline watcher without calling `finish_pending`.
                        // `PendingKind::Stream::_settled`.
                        let terminal_result = match header.ty {
                            FrameType::StreamEnd => Ok(()),
                            FrameType::Error => Err(CallError::host_terminal(&body)),
                            FrameType::Response => Err(CallError::local(
                                SendOutcome::Terminal,
                                "unexpected_response",
                                "stream received unary response terminal",
                            )),
                            _ => unreachable!(),
                        };
                        let _ = terminal.send(terminal_result);
                        self.release_stream();
                    }
                }
            }
            FrameType::StreamData => {
                let key = PendingKey {
                    channel: header.channel,
                    epoch: header.epoch,
                    corr: header.corr,
                };
                let mut pending = lock_unpoisoned(&self.pending);
                let Some(state) = pending.get_mut(&key) else {
                    return;
                };
                match &mut state.kind {
                    PendingKind::Unary(_) => {
                        let state = pending.remove(&key).expect("entry exists");
                        drop(pending);
                        self.finish_pending(
                            state,
                            Err(CallError::local(
                                // The best-effort `Cancel` may leave the run executing or committing.
                                // `Terminal` would suppress OutcomeUnknown recovery.
                                // The frame handler does not drain stream frames for a unary correlation.
                                // A unary correlation has no legal stream frames.
                                // Stream frames are invalid for unary correlations.
                                SendOutcome::OutcomeUnknown,
                                "unexpected_stream",
                                "unary request received stream data",
                            )),
                        );
                        let _ = self.send_control(
                            FrameType::Cancel,
                            pure_header_flags(),
                            FrameId {
                                channel: key.channel,
                                epoch: key.epoch,
                                corr: key.corr,
                            },
                            None,
                        );
                    }
                    PendingKind::Stream { items, .. } => {
                        // The stream queue charges retained bytes against the queue budget so held items cannot exhaust the reader's frame reservation.
                        // The stream handler treats retention-budget exhaustion as stream saturation.
                        // The stream handler cancels the saturated stream without advancing its generation.
                        // the generation.
                        let retained = self.retained_budget.charge(body.len());
                        let item = retained.map(|retained| ChargedItem {
                            body,
                            binary: header.flags.is_binary(),
                            _charge: retained,
                        });
                        // The reader releases the read reservation when bytes are retained or discarded.
                        drop(charge);
                        if item.is_none_or(|item| items.try_send(item).is_err()) {
                            let state = pending.remove(&key).expect("entry exists");
                            drop(pending);
                            self.finish_pending(
                                state,
                                Err(CallError::local(
                                    // The handler uses `OutcomeUnknown` because local overflow occurs after sending the request.
                                    // The handler observed no terminal frame.
                                    // The best-effort `Cancel` may not reach the host.
                                    // The run may still be committing.
                                    // `Terminal` would falsely claim authoritative settlement.
                                    SendOutcome::OutcomeUnknown,
                                    "stream_saturated",
                                    "stream consumer queue saturated",
                                )),
                            );
                            let _ = self.send_control(
                                FrameType::Cancel,
                                pure_header_flags(),
                                FrameId {
                                    channel: key.channel,
                                    epoch: key.epoch,
                                    corr: key.corr,
                                },
                                None,
                            );
                        }
                    }
                }
            }
            _ => self.retire("protocol_violation"),
        }
    }

    /// `release_stranded_route` releases a late route bind that no caller can own.
    ///
    /// The handler sends a best-effort route `Goodbye` for a successful bind that no caller can cache.
    /// The handler closes the connection only when it cannot queue the route `Goodbye`.
    /// The handler does not send `Goodbye` when the body names no route.
    ///
    /// A cached bind belongs to the caller that received it.
    /// The handler does not treat a duplicate terminal for a cached bind as stranded.
    /// Sending `Goodbye` would close a route still in use.
    fn release_stranded_route(&self, body: &[u8]) {
        let Ok(route) = parse_route_open(body) else {
            return;
        };
        if lock_unpoisoned(&self.routes).contains(&route) {
            return;
        }
        if self
            .send_control(
                FrameType::Goodbye,
                pure_header_flags(),
                FrameId::routed(route, 0),
                None,
            )
            .is_err()
        {
            self.retire("stranded_route_cleanup_failed");
        }
    }

    fn finish_pending(&self, state: PendingState, result: Result<Response, CallError>) {
        match state.kind {
            PendingKind::Unary(tx) => {
                let _ = tx.send(result);
            }
            PendingKind::Stream { terminal, .. } => {
                let terminal_result = result.map(|_| ());
                let _ = terminal.send(terminal_result);
                // Dropping `state` retires the deadline watcher.
                // see `PendingKind::Stream::_settled`.
                self.release_stream();
            }
        }
    }

    fn release_stream(&self) {
        let mut streams = lock_unpoisoned(&self.streams);
        *streams = streams.saturating_sub(1);
    }

    ///
    /// The route settlement sends no per-correlation `Cancel`.
    /// `settle_all` also sends no `Cancel` frames.
    /// reason.
    fn settle_route(&self, route: RouteHandle) -> bool {
        let pending = {
            let _admission = lock_unpoisoned(&self.admission);
            let mut pending = lock_unpoisoned(&self.pending);
            if !lock_unpoisoned(&self.routes).remove(&route) {
                return false;
            }
            let keys: Vec<_> = pending
                .keys()
                .copied()
                .filter(|key| key.route() == route)
                .collect();
            keys.into_iter()
                .filter_map(|key| pending.remove(&key).map(|state| (key, state)))
                .collect::<Vec<_>>()
        };
        for (_key, state) in pending {
            let outcome = cancel_classification(&state.publish);
            self.finish_pending(
                state,
                Err(CallError::local(outcome, "route_gone", "request stopped")),
            );
        }
        true
    }

    fn settle_all(&self, code: &'static str) {
        let pending = {
            let _admission = lock_unpoisoned(&self.admission);
            std::mem::take(&mut *lock_unpoisoned(&self.pending))
        };
        for (_, state) in pending {
            let outcome = cancel_classification(&state.publish);
            self.finish_pending(
                state,
                Err(CallError::local(
                    outcome,
                    code,
                    "connection generation closed",
                )),
            );
        }
    }

    fn retire(&self, code: &'static str) {
        if self.retired.swap(true, Ordering::AcqRel) {
            return;
        }
        self.closed.store(true, Ordering::Release);
        self.settle_all(code);
        lock_unpoisoned(&self.routes).clear();
        self.cancel.cancel();
    }

    async fn join_tasks_until(&self, deadline: Instant) -> bool {
        let mut within_deadline = true;
        // The shared deadline bounds total shutdown time across all tasks.
        // A `yield_now` loop re-queues itself every iteration.
        // A `yield_now` loop spins the worker for the whole shutdown budget.
        for slot in [&self.writer, &self.reader] {
            let Some(mut task) = slot.lock().await.take() else {
                continue;
            };
            if tokio::time::timeout_at(deadline, &mut task).await.is_err() {
                within_deadline = false;
                // `JoinHandle` must not be awaited again after it completes.
                task.abort();
                let _ = task.await;
            }
        }
        within_deadline
    }
}

struct UnaryAdmissionGuard {
    inner: Arc<Inner>,
    key: PendingKey,
    armed: bool,
}

impl UnaryAdmissionGuard {
    const fn new(inner: Arc<Inner>, key: PendingKey) -> Self {
        Self {
            inner,
            key,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for UnaryAdmissionGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = self.inner.cancel_key(self.key, "caller_dropped");
        }
    }
}

struct Correlations {
    next: Option<u64>,
}

impl Correlations {
    const fn new(first: u64) -> Self {
        Self { next: Some(first) }
    }

    fn allocate(&mut self) -> Option<u64> {
        let current = self.next?;
        self.next = current.checked_add(1);
        Some(current)
    }

    fn restore(&mut self, correlation: u64) {
        if self.next == correlation.checked_add(1)
            || (correlation == u64::MAX && self.next.is_none())
        {
            self.next = Some(correlation);
        }
    }
}

struct ByteCounter {
    cap: usize,
    used: Mutex<usize>,
}

impl ByteCounter {
    const fn new(cap: usize) -> Self {
        Self {
            cap,
            used: Mutex::new(0),
        }
    }

    fn charge(self: &Arc<Self>, bytes: usize) -> Option<ByteCharge> {
        let mut used = lock_unpoisoned(&self.used);
        let next = used.checked_add(bytes)?;
        if next > self.cap {
            return None;
        }
        *used = next;
        Some(ByteCharge {
            owner: Arc::downgrade(self),
            bytes,
        })
    }

    #[cfg(test)]
    fn used(&self) -> usize {
        *lock_unpoisoned(&self.used)
    }
}

struct ByteCharge {
    owner: Weak<ByteCounter>,
    bytes: usize,
}

impl ByteCharge {
    /// A zero-byte charge keeps inbound-frame accounting uniform.
    const fn none() -> Self {
        Self {
            owner: Weak::new(),
            bytes: 0,
        }
    }
}

impl Drop for ByteCharge {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.upgrade() {
            let mut used = lock_unpoisoned(&owner.used);
            *used = used.saturating_sub(self.bytes);
        }
    }
}

struct ChargedItem {
    body: Vec<u8>,
    binary: bool,
    /// account for.
    _charge: ByteCharge,
}

impl ChargedItem {
    fn into_public(self) -> StreamItem {
        StreamItem {
            body: self.body,
            binary: self.binary,
        }
    }
}

struct QueuedFrame {
    bytes: Vec<u8>,
    charge: ByteCharge,
    publish: Option<Arc<AtomicU8>>,
    ack: Option<oneshot::Sender<()>>,
    deadline: Instant,
}

async fn writer_loop(
    inner: Arc<Inner>,
    mut write: OwnedWriteHalf,
    mut data_rx: mpsc::Receiver<QueuedFrame>,
    mut control_rx: mpsc::Receiver<QueuedFrame>,
) {
    loop {
        let frame = if let Ok(frame) = control_rx.try_recv() {
            frame
        } else {
            tokio::select! {
                biased;
                () = inner.cancel.cancelled() => break,
                frame = control_rx.recv() => match frame {
                    Some(frame) => frame,
                    None => match data_rx.recv().await { Some(frame) => frame, None => break },
                },
                frame = data_rx.recv() => match frame {
                    Some(frame) => frame,
                    None => match control_rx.recv().await { Some(frame) => frame, None => break },
                },
            }
        };
        if frame
            .publish
            .as_ref()
            .is_some_and(|state| !claim_for_write(state))
        {
            continue;
        }
        let written = tokio::select! {
            biased;
            () = inner.cancel.cancelled() => break,
            result = timeout_at(frame.deadline, write.write_all(&frame.bytes)) => result,
        };
        if !matches!(written, Ok(Ok(()))) {
            inner.retire("write_failed");
            break;
        }
        if let Some(state) = &frame.publish {
            state.store(WRITTEN, Ordering::Release);
        }
        if let Some(ack) = frame.ack {
            let _ = ack.send(());
        }
        drop(frame.charge);
    }
    let _ = write.shutdown().await;
}

async fn reader_loop<R: AsyncRead + Unpin>(inner: Arc<Inner>, mut read: R) {
    loop {
        let frame = match read_active_frame(&mut read, &inner).await {
            Ok(Some(frame)) => frame,
            Ok(None) => {
                inner.retire("eof");
                break;
            }
            Err(()) => {
                inner.retire("protocol_violation");
                break;
            }
        };
        inner.dispatch(frame.header, frame.body, frame.charge);
        if inner.retired.load(Ordering::Acquire) {
            break;
        }
    }
}

struct InboundFrame {
    header: EnvelopeHeader,
    body: Vec<u8>,
    /// `ChargedItem` owns the charge until `into_public` consumes it.
    charge: ByteCharge,
}

async fn read_active_frame<R: AsyncRead + Unpin>(
    read: &mut R,
    inner: &Arc<Inner>,
) -> Result<Option<InboundFrame>, ()> {
    let mut header_bytes = [0u8; HEADER_LEN];
    let first = tokio::select! {
        biased;
        () = inner.cancel.cancelled() => return Err(()),
        result = read.read(&mut header_bytes[..1]) => result.map_err(|_| ())?,
    };
    if first == 0 {
        return Ok(None);
    }
    let deadline = Instant::now() + CLIENT_FRAME_TIMEOUT;
    // The parser can reject an incompatible version from `len` and `ver` in bytes 0..5.
    // Waiting for all 21 bytes lets a peer that sends only the prefix hold the connection and an active slot until the frame deadline.
    read_exact_until(
        read,
        &mut header_bytes[1..FROZEN_PREFIX_LEN],
        deadline,
        &inner.cancel,
    )
    .await?;
    if header_bytes[4] != PROTOCOL_VERSION {
        return Err(());
    }
    read_exact_until(
        read,
        &mut header_bytes[FROZEN_PREFIX_LEN..],
        deadline,
        &inner.cancel,
    )
    .await?;
    let header = decode_header(&header_bytes).map_err(|_| ())?;
    validate_inbound(&header)?;
    if header.len == 0 {
        return Ok(Some(InboundFrame {
            header,
            body: Vec::new(),
            charge: ByteCharge::none(),
        }));
    }
    // The reservation covers the framing maximum and belongs to the reader
    // A reservation failure here indicates a header above the framing maximum, which `validate_inbound` rejects.
    // The guard preserves the invariant that valid frames cannot exhaust `read_budget`.
    let Some(charge) = inner.read_budget.charge(header.len as usize) else {
        drain_until(read, header.len as usize, deadline, &inner.cancel).await?;
        return Err(());
    };
    let body = read_body_until(read, header.len as usize, deadline, &inner.cancel).await?;
    Ok(Some(InboundFrame {
        header,
        body,
        charge,
    }))
}

/// Any read failure requires reconnecting; the client does not resynchronize the stream.
/// header begins.
async fn read_exact_until<R: AsyncRead + Unpin>(
    read: &mut R,
    buf: &mut [u8],
    deadline: Instant,
    cancel: &CancellationToken,
) -> Result<(), ()> {
    crate::frame_read::read_exact(read, buf, deadline, cancel)
        .await
        .map_err(|_| ())
}

async fn read_body_until<R: AsyncRead + Unpin>(
    read: &mut R,
    len: usize,
    deadline: Instant,
    cancel: &CancellationToken,
) -> Result<Vec<u8>, ()> {
    let mut body = Vec::with_capacity(len);
    crate::frame_read::read_body(read, &mut body, len, deadline, cancel)
        .await
        .map_err(|_| ())?;
    Ok(body)
}

async fn drain_until<R: AsyncRead + Unpin>(
    read: &mut R,
    remaining: usize,
    deadline: Instant,
    cancel: &CancellationToken,
) -> Result<(), ()> {
    crate::frame_read::drain(read, remaining, deadline, cancel)
        .await
        .map_err(|_| ())
}

///
fn request_deadline(timeout: Duration) -> Result<Instant, CallError> {
    Instant::now().checked_add(timeout).ok_or_else(|| {
        CallError::local(
            SendOutcome::NotSent,
            "invalid_timeout",
            "request timeout is out of range",
        )
    })
}

fn validate_inbound(header: &EnvelopeHeader) -> Result<(), ()> {
    if header.ver != PROTOCOL_VERSION || header.len > MAX_BODY_LEN {
        return Err(());
    }
    // §7.1 caps channel-0 bodies at 65,536 bytes.
    if header.channel == 0 && header.len > MAX_CONTROL_BODY_LEN {
        return Err(());
    }
    match header.ty {
        // A terminal answers either a control request (0/0) or a routed one.
        // `decode_header` rejects mixed zero/nonzero channel/epoch pairs.
        FrameType::Response | FrameType::Error => {
            if header.corr == 0 {
                return Err(());
            }
            // §7.1 permits UTF-8 JSON only on channel 0.
            if header.channel == 0 && header.flags.is_binary() {
                return Err(());
            }
        }
        FrameType::StreamData | FrameType::StreamEnd => {
            if header.corr == 0 || header.channel == 0 || header.epoch == 0 {
                return Err(());
            }
            // The direct profile encodes stream termination in the header.
            // A `StreamEnd` body is structural corruption in the direct profile.
            // The framing layer does not classify `StreamEnd` as pure-header.
            if matches!(header.ty, FrameType::StreamEnd) && header.len != 0 {
                return Err(());
            }
        }
        FrameType::Push => {
            // `Push` frames must use correlation 0 because they are unsolicited.
            // A `Push` correlation would claim a pending request that the frame cannot answer.
            if header.channel == 0 || header.epoch == 0 || header.corr != 0 {
                return Err(());
            }
        }
        FrameType::Ping => {
            if header.channel != 0 || header.epoch != 0 || header.corr == 0 {
                return Err(());
            }
        }
        FrameType::Goodbye => {
            if header.corr != 0 || (header.channel != 0 && header.epoch == 0) {
                return Err(());
            }
        }
        _ => return Err(()),
    }
    // Section 6.1 permits any valid priority.
    // `Ping` validation compares only non-priority flags because `Interactive` priority is conforming.
    if header.ty.is_pure_header()
        && (header.len != 0
            || header.flags.is_binary()
            || header.flags.is_last()
            || header.flags.admission_class() != Some(AdmissionClass::Normal))
    {
        return Err(());
    }
    Ok(())
}

fn encode_data_frame(
    route: RouteHandle,
    corr: u64,
    body: Vec<u8>,
    publish: Arc<AtomicU8>,
    budget: &Arc<ByteCounter>,
    deadline: Instant,
) -> Result<QueuedFrame, CallError> {
    let bytes = encode_owned_frame(
        FrameType::Request,
        Flags::new(false, Priority::Interactive, false),
        FrameId::routed(route, corr),
        body,
    )
    .map_err(|_| {
        CallError::local(
            SendOutcome::NotSent,
            "body_too_large",
            "request body exceeds wire limit",
        )
    })?;
    let charge = budget.charge(bytes.len()).ok_or_else(|| {
        CallError::local(
            SendOutcome::NotSent,
            "queued_byte_capacity",
            "shared queued-byte capacity exhausted",
        )
    })?;
    Ok(QueuedFrame {
        bytes,
        charge,
        publish: Some(publish),
        ack: None,
        deadline,
    })
}

async fn negotiate_tcp(stream: &mut TcpStream, deadline: Instant) -> Result<(), ClientError> {
    // The response validator checks the offer encoded in `request`.
    let request = NegotiateRequest {
        negotiation_version: NEGOTIATION_VERSION,
        offers: vec![TransportOffer {
            transport: TRANSPORT_TCP.to_owned(),
            capability_version: 1,
            parameters: None,
        }],
    };
    let body = encode_negotiate_request(&request)
        .map_err(|_| ClientError::new("negotiation_failed", "transport negotiation failed"))?;
    let bytes = encode_owned_frame(
        FrameType::Request,
        Flags::new(false, Priority::Interactive, false),
        FrameId::control(NEGOTIATION_CORRELATION),
        body,
    )
    .map_err(|_| ClientError::new("negotiation_failed", "transport negotiation failed"))?;
    timeout_at(deadline, stream.write_all(&bytes))
        .await
        .map_err(|_| ClientError::new("handshake_timeout", "client handshake timed out"))?
        .map_err(|_| ClientError::new("negotiation_failed", "transport negotiation failed"))?;
    let frame = read_setup_frame(stream, deadline).await?;
    // Channel 0 accepts UTF-8 JSON only (§7.1), so a binary setup response is nonconforming even when its body parses.
    if frame.header.ty != FrameType::Response
        || frame.header.channel != 0
        || frame.header.epoch != 0
        || frame.header.corr != NEGOTIATION_CORRELATION
        || frame.header.flags.is_binary()
    {
        return Err(ClientError::new(
            "negotiation_failed",
            "transport negotiation failed closed",
        ));
    }
    let selection = decode_negotiate_response(&frame.body, &request.offers).map_err(|_| {
        ClientError::new("negotiation_failed", "transport negotiation failed closed")
    })?;
    if !matches!(selection, NegotiateResponse::Tcp { reason: None }) {
        return Err(ClientError::new(
            "negotiation_failed",
            "transport negotiation failed closed",
        ));
    }
    Ok(())
}

async fn read_setup_frame(
    stream: &mut TcpStream,
    deadline: Instant,
) -> Result<InboundFrame, ClientError> {
    let mut header_bytes = [0u8; HEADER_LEN];
    // The handshake reads bytes 0..5 first so it rejects incompatible versions immediately.
    read_setup_exact(stream, &mut header_bytes[..FROZEN_PREFIX_LEN], deadline).await?;
    if header_bytes[4] != PROTOCOL_VERSION {
        return Err(ClientError::new(
            "negotiation_failed",
            "transport negotiation failed",
        ));
    }
    read_setup_exact(stream, &mut header_bytes[FROZEN_PREFIX_LEN..], deadline).await?;
    let header = decode_header(&header_bytes)
        .map_err(|_| ClientError::new("negotiation_failed", "transport negotiation failed"))?;
    // Negotiation is channel-zero control traffic, so §7.1's 65,536-byte cap applies.
    // The negotiation path bypasses `validate_inbound`, so it must enforce the 65,536-byte cap itself.
    // rejected.
    if header.channel != 0 || header.len > MAX_CONTROL_BODY_LEN {
        return Err(ClientError::new(
            "negotiation_failed",
            "transport negotiation failed",
        ));
    }
    let mut body = vec![0u8; header.len as usize];
    read_setup_exact(stream, &mut body, deadline).await?;
    Ok(InboundFrame {
        header,
        body,
        charge: ByteCharge::none(),
    })
}

/// The setup reader applies the shared handshake deadline to every setup-byte read.
async fn read_setup_exact(
    stream: &mut TcpStream,
    buf: &mut [u8],
    deadline: Instant,
) -> Result<(), ClientError> {
    timeout_at(deadline, stream.read_exact(buf))
        .await
        .map_err(|_| ClientError::new("handshake_timeout", "client handshake timed out"))?
        .map_err(|_| ClientError::new("negotiation_failed", "transport negotiation failed"))?;
    Ok(())
}

fn route_open_body(target: &RouteTarget, identity: &RouteIdentity) -> Result<Vec<u8>, CallError> {
    let project_root = identity.project_root.to_str().ok_or_else(|| {
        CallError::local(
            SendOutcome::NotSent,
            "invalid_identity",
            "route identity path is not UTF-8",
        )
    })?;
    let kind = match target.kind {
        TargetKind::ToolProvider => "tool_provider",
        TargetKind::ManagementSurface => "management_surface",
    };
    let mut request = serde_json::json!({
        "op": "route.open",
        "target": {"kind": kind, "module_id": target.module_id},
        "identity": {
            "project_root": project_root,
            "harness": identity.harness,
            "session": identity.session
        },
        "consumer_capabilities": identity.consumer_capabilities
    });
    // A present JSON `null` makes `bind` observe `Some(..)`, unlike an absent member.
    // never supplied.
    if let Some(facts) = identity.admission_facts.as_ref() {
        request["admission_facts"] = facts.clone();
    }
    if let (Some(module_id), Some(launch_nonce)) = (
        identity.consumer_module_id.as_ref(),
        identity.consumer_launch_nonce.as_ref(),
    ) {
        request["consumer_identity"] = serde_json::json!({
            "module_id": module_id,
            "launch_nonce": launch_nonce
        });
    }
    serde_json::to_vec(&request).map_err(|_| {
        CallError::local(
            SendOutcome::NotSent,
            "invalid_identity",
            "route-open request could not be encoded",
        )
    })
}

fn parse_route_open(body: &[u8]) -> Result<RouteHandle, CallError> {
    let value = serde_json::from_slice::<Value>(body).map_err(|_| {
        CallError::local(
            SendOutcome::Terminal,
            "invalid_route_response",
            "host returned an invalid route-open response",
        )
    })?;
    if value.get("op").and_then(Value::as_str) != Some("route.open") {
        return Err(CallError::local(
            SendOutcome::Terminal,
            "invalid_route_response",
            "host returned an invalid route-open response",
        ));
    }
    let channel = value
        .get("route_channel")
        .and_then(Value::as_u64)
        .and_then(|value| u16::try_from(value).ok())
        .filter(|value| *value != 0)
        .ok_or_else(|| {
            CallError::local(
                SendOutcome::Terminal,
                "invalid_route_response",
                "host returned an invalid route-open response",
            )
        })?;
    let epoch = value
        .get("route_epoch")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value != 0)
        .ok_or_else(|| {
            CallError::local(
                SendOutcome::Terminal,
                "invalid_route_response",
                "host returned an invalid route-open response",
            )
        })?;
    Ok(RouteHandle { channel, epoch })
}

fn claim_for_write(state: &AtomicU8) -> bool {
    state
        .compare_exchange(QUEUED, WRITING, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
}

fn classify(state: &AtomicU8) -> SendOutcome {
    match state.load(Ordering::Acquire) {
        QUEUED | CANCELLED => SendOutcome::NotSent,
        WRITING | WRITTEN => SendOutcome::OutcomeUnknown,
        _ => SendOutcome::OutcomeUnknown,
    }
}

fn cancel_classification(state: &AtomicU8) -> SendOutcome {
    if state
        .compare_exchange(QUEUED, CANCELLED, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
    {
        SendOutcome::NotSent
    } else {
        classify(state)
    }
}

fn retired_error(outcome: SendOutcome) -> CallError {
    CallError::local(
        outcome,
        "generation_retired",
        "connection generation retired",
    )
}

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn bounded_code(code: &str) -> String {
    let code = code
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.'))
        .take(MAX_ERROR_CODE_BYTES)
        .collect::<String>();
    if code.is_empty() {
        "remote_error".to_owned()
    } else {
        code
    }
}

fn bounded_text(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::response_flags;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn test_inner(
        queued_bytes: usize,
    ) -> (
        Arc<Inner>,
        mpsc::Receiver<QueuedFrame>,
        mpsc::Receiver<QueuedFrame>,
    ) {
        let (data_tx, data_rx) = mpsc::channel(CLIENT_DATA_QUEUE_FRAMES);
        let (control_tx, control_rx) = mpsc::channel(CLIENT_CONTROL_QUEUE_FRAMES);
        (
            Arc::new(Inner {
                daemon_id: [0; DAEMON_ID_LEN],
                daemon_ver: "mc-host/0.0.0-test".to_owned(),
                closed: AtomicBool::new(false),
                retired: AtomicBool::new(false),
                cancel: CancellationToken::new(),
                correlations: Mutex::new(Correlations::new(FIRST_APPLICATION_CORRELATION)),
                admission: Mutex::new(()),
                pending: Mutex::new(HashMap::new()),
                streams: Mutex::new(0),
                routes: Mutex::new(HashSet::from([route(1), route(2)])),
                queue_budget: Arc::new(ByteCounter::new(queued_bytes)),
                control_budget: Arc::new(ByteCounter::new(CLIENT_CONTROL_QUEUED_BYTES)),
                read_budget: Arc::new(ByteCounter::new(CLIENT_INBOUND_FRAME_BYTES)),
                retained_budget: Arc::new(ByteCounter::new(CLIENT_RETAINED_RESPONSE_BYTES)),
                data_tx,
                control_tx,
                close_lock: tokio::sync::Mutex::new(()),
                reader: tokio::sync::Mutex::new(None),
                writer: tokio::sync::Mutex::new(None),
            }),
            data_rx,
            control_rx,
        )
    }

    fn route(epoch: u32) -> RouteHandle {
        RouteHandle { channel: 7, epoch }
    }

    fn unary_sender() -> (PendingKind, oneshot::Receiver<Result<Response, CallError>>) {
        let (tx, rx) = oneshot::channel();
        (PendingKind::Unary(tx), rx)
    }

    async fn ack_controls(mut rx: mpsc::Receiver<QueuedFrame>, count: usize) {
        for _ in 0..count {
            let mut frame = rx.recv().await.expect("control frame");
            frame
                .ack
                .take()
                .expect("close control has ack")
                .send(())
                .ok();
        }
    }

    #[test]
    fn max_correlation_is_used_once_then_exhausted() {
        let mut correlations = Correlations::new(u64::MAX);
        assert_eq!(correlations.allocate(), Some(u64::MAX));
        assert_eq!(correlations.allocate(), None);
        correlations.restore(u64::MAX);
        assert_eq!(correlations.allocate(), Some(u64::MAX));
        assert_eq!(correlations.allocate(), None);
    }

    #[tokio::test]
    async fn real_admission_exhausts_after_max_without_second_charge_or_frame() {
        let (inner, data_rx, _control_rx) = test_inner(CLIENT_QUEUED_BYTES);
        lock_unpoisoned(&inner.correlations).next = Some(u64::MAX);
        let deadline = Instant::now() + Duration::from_secs(1);
        let (first_kind, _first_rx) = unary_sender();
        let (key, _) = inner
            .admit(route(1), Vec::new(), first_kind, deadline)
            .expect("u64::MAX is admitted once");
        assert_eq!(key.corr, u64::MAX);
        let charged = inner.queue_budget.used();
        assert_eq!(data_rx.len(), 1);

        let (second_kind, _second_rx) = unary_sender();
        let error = inner
            .admit(route(1), Vec::new(), second_kind, deadline)
            .expect_err("correlation space is exhausted");
        assert_eq!(error.outcome(), SendOutcome::NotSent);
        assert_eq!(error.code(), "correlations_exhausted");
        assert_eq!(data_rx.len(), 1);
        assert_eq!(inner.queue_budget.used(), charged);

        inner.retire("test_done");
        drop(data_rx);
        assert_eq!(inner.queue_budget.used(), 0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn close_wins_against_admission_blocked_on_pending() {
        let (inner, data_rx, control_rx) = test_inner(CLIENT_QUEUED_BYTES);
        let client = Arc::new(Client {
            inner: Arc::clone(&inner),
        });
        let pending = lock_unpoisoned(&inner.pending);
        let closer = {
            let client = Arc::clone(&client);
            tokio::spawn(async move { client.close().await })
        };
        while !inner.closed.load(Ordering::Acquire) {
            std::thread::yield_now();
        }
        loop {
            match inner.admission.try_lock() {
                Err(std::sync::TryLockError::WouldBlock) => break,
                Err(std::sync::TryLockError::Poisoned(_)) => panic!("admission lock poisoned"),
                Ok(guard) => drop(guard),
            }
            std::thread::yield_now();
        }
        let admission = {
            let inner = Arc::clone(&inner);
            tokio::task::spawn_blocking(move || {
                let (kind, _rx) = unary_sender();
                inner.admit(
                    route(1),
                    b"must-not-write".to_vec(),
                    kind,
                    Instant::now() + Duration::from_secs(1),
                )
            })
        };
        drop(pending);
        let acknowledger = tokio::spawn(ack_controls(control_rx, 3));

        closer.await.unwrap().expect("close completes");
        acknowledger.await.unwrap();
        let error = admission
            .await
            .unwrap()
            .expect_err("close wins admission ordering");
        assert_eq!(error.outcome(), SendOutcome::NotSent);
        assert_eq!(error.code(), "connection_retired");
        assert!(lock_unpoisoned(&inner.pending).is_empty());
        assert!(data_rx.is_empty(), "losing admission queues no write");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn exact_route_close_wins_against_admission_blocked_on_pending() {
        let (inner, data_rx, _control_rx) = test_inner(CLIENT_QUEUED_BYTES);
        let pending = lock_unpoisoned(&inner.pending);
        let closer = {
            let inner = Arc::clone(&inner);
            tokio::task::spawn_blocking(move || inner.settle_route(route(1)))
        };
        loop {
            match inner.admission.try_lock() {
                Err(std::sync::TryLockError::WouldBlock) => break,
                Err(std::sync::TryLockError::Poisoned(_)) => panic!("admission lock poisoned"),
                Ok(guard) => drop(guard),
            }
            std::thread::yield_now();
        }
        let admission = {
            let inner = Arc::clone(&inner);
            tokio::task::spawn_blocking(move || {
                let (kind, _rx) = unary_sender();
                inner.admit(
                    route(1),
                    b"must-not-write".to_vec(),
                    kind,
                    Instant::now() + Duration::from_secs(1),
                )
            })
        };
        drop(pending);

        assert!(closer.await.unwrap(), "exact route was live");
        let error = admission
            .await
            .unwrap()
            .expect_err("closed route rejects admission");
        assert_eq!(error.outcome(), SendOutcome::NotSent);
        assert_eq!(error.code(), "route_not_live");
        assert!(lock_unpoisoned(&inner.pending).is_empty());
        assert!(data_rx.is_empty(), "losing admission queues no write");
        assert!(lock_unpoisoned(&inner.routes).contains(&route(2)));
    }

    #[tokio::test]
    async fn admission_winning_is_settled_by_close() {
        let (inner, data_rx, control_rx) = test_inner(CLIENT_QUEUED_BYTES);
        let deadline = Instant::now() + Duration::from_secs(1);
        let (kind, rx) = unary_sender();
        let (_key, publish) = inner
            .admit(route(1), b"admitted".to_vec(), kind, deadline)
            .expect("admission wins");
        let client = Client {
            inner: Arc::clone(&inner),
        };
        let acknowledger = tokio::spawn(ack_controls(control_rx, 3));

        client.close().await.expect("close completes");
        acknowledger.await.unwrap();
        let error = rx.await.unwrap().expect_err("close settles admitted work");
        assert_eq!(error.code(), "owner_close");
        assert_eq!(classify(&publish), SendOutcome::NotSent);
        assert!(lock_unpoisoned(&inner.pending).is_empty());
        assert_eq!(data_rx.len(), 1, "admission queued exactly one frame");
    }

    #[tokio::test]
    async fn cancel_winning_queued_prevents_writer_claim_and_frame() {
        let (inner, data_rx, mut control_rx) = test_inner(CLIENT_QUEUED_BYTES);
        let deadline = Instant::now() + Duration::from_secs(1);
        let (kind, rx) = unary_sender();
        let (key, publish) = inner
            .admit(route(1), b"must-not-send".to_vec(), kind, deadline)
            .expect("admitted");
        inner.cancel_key(key, "cancelled").expect("cancel queued");
        let error = rx.await.expect("settled").expect_err("cancelled");
        assert_eq!(error.outcome(), SendOutcome::NotSent);
        assert_eq!(publish.load(Ordering::Acquire), CANCELLED);
        assert!(!claim_for_write(&publish));
        assert!(control_rx.try_recv().is_err(), "not-sent needs no Cancel");

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut peer = TcpStream::connect(listener.local_addr().unwrap())
            .await
            .unwrap();
        let (socket, _) = listener.accept().await.unwrap();
        let (_read, write) = socket.into_split();
        let writer_inner = Arc::clone(&inner);
        let writer = tokio::spawn(async move {
            writer_loop(writer_inner, write, data_rx, control_rx).await;
        });
        let mut byte = [0u8; 1];
        assert!(
            tokio::time::timeout(Duration::from_millis(50), peer.read(&mut byte))
                .await
                .is_err(),
            "cancel-winning queued request must write no frame bytes"
        );
        assert_eq!(inner.queue_budget.used(), 0);
        inner.cancel.cancel();
        writer.await.unwrap();
    }

    #[tokio::test]
    async fn writer_winning_cancel_is_outcome_unknown_and_queues_cancel() {
        let (inner, mut data_rx, mut control_rx) = test_inner(CLIENT_QUEUED_BYTES);
        let (kind, rx) = unary_sender();
        let (key, publish) = inner
            .admit(
                route(1),
                b"possibly-sent".to_vec(),
                kind,
                Instant::now() + Duration::from_secs(1),
            )
            .expect("admitted");
        assert!(claim_for_write(&publish), "writer wins QUEUED CAS");
        inner.cancel_key(key, "cancelled").expect("cancel writing");
        let error = rx.await.expect("settled").expect_err("cancelled");
        assert_eq!(error.outcome(), SendOutcome::OutcomeUnknown);
        let cancel = control_rx.recv().await.expect("Cancel queued");
        assert_eq!(cancel.bytes[5], FrameType::Cancel as u8);
        assert_eq!(publish.load(Ordering::Acquire), WRITING);
        drop(data_rx.recv().await);
        drop(cancel);
        assert_eq!(inner.queue_budget.used(), 0);
    }

    #[tokio::test]
    async fn failed_cancel_enqueue_keeps_outcome_unknown() {
        let (inner, mut data_rx, control_rx) = test_inner(CLIENT_QUEUED_BYTES);
        let (kind, rx) = unary_sender();
        let (key, publish) = inner
            .admit(
                route(1),
                b"possibly-sent".to_vec(),
                kind,
                Instant::now() + Duration::from_secs(1),
            )
            .expect("admitted");
        assert!(claim_for_write(&publish), "writer claims the request");
        // Retiring without draining pending makes the best-effort `Cancel` enqueue fail with `NotSent`.
        inner.retired.store(true, Ordering::Release);

        let error = inner
            .cancel_key(key, "cancelled")
            .expect_err("Cancel cannot be queued on a retired generation");
        assert_eq!(
            error.outcome(),
            SendOutcome::OutcomeUnknown,
            "a claimed request stays possibly-sent when its Cancel cannot be queued"
        );
        assert_eq!(error.code(), "generation_retired");
        let settled = rx.await.expect("settled").expect_err("cancelled");
        assert_eq!(settled.outcome(), SendOutcome::OutcomeUnknown);
        drop(data_rx.recv().await);
        drop(control_rx);
    }

    #[tokio::test]
    async fn settled_stream_retires_its_deadline_watcher() {
        // `cancel_key` and terminal-frame dispatch settle through different paths; removing the watcher entry is the only cleanup common to both.
        for terminal in [None, Some(FrameType::StreamEnd)] {
            let (inner, mut data_rx, _control_rx) = test_inner(CLIENT_QUEUED_BYTES);
            let (items_tx, _items_rx) = mpsc::channel(CLIENT_STREAM_QUEUE_ITEMS);
            let (terminal_tx, terminal_rx) = oneshot::channel();
            let settled = CancellationToken::new();
            let (key, _publish) = inner
                .admit(
                    route(1),
                    Vec::new(),
                    PendingKind::Stream {
                        items: items_tx,
                        terminal: terminal_tx,
                        _settled: settled.clone().drop_guard(),
                    },
                    Instant::now() + Duration::from_secs(600),
                )
                .expect("stream admitted");
            assert!(
                !settled.is_cancelled(),
                "the watcher must stay armed while the stream is live"
            );
            drop(data_rx.recv().await);

            match terminal {
                None => {
                    inner.cancel_key(key, "cancelled").expect("stream settled");
                }
                Some(ty) => inner.dispatch(
                    EnvelopeHeader {
                        len: 0,
                        ver: PROTOCOL_VERSION,
                        ty,
                        flags: response_flags(false, true),
                        channel: key.channel,
                        epoch: key.epoch,
                        corr: key.corr,
                    },
                    Vec::new(),
                    ByteCharge::none(),
                ),
            }

            assert!(
                settled.is_cancelled(),
                "settling via {terminal:?} must retire the watcher instead of \
                 leaving it asleep until the deadline"
            );
            assert!(lock_unpoisoned(&inner.pending).is_empty());
            let _ = terminal_rx.await;
        }
    }

    #[tokio::test]
    async fn route_settlement_never_floods_the_reserved_control_queue() {
        // Sending one `Cancel` per claimed request can exhaust the 32 reserved control slots; `send_control` then retires the generation and disconnects unrelated routes.
        let (inner, mut data_rx, mut control_rx) = test_inner(CLIENT_QUEUED_BYTES);
        let route = route(1);
        lock_unpoisoned(&inner.routes).insert(route);
        for _ in 0..CLIENT_CONTROL_QUEUE_FRAMES + 1 {
            let (kind, _rx) = unary_sender();
            let (_key, publish) = inner
                .admit(
                    route,
                    Vec::new(),
                    kind,
                    Instant::now() + Duration::from_secs(60),
                )
                .expect("admitted");
            // Claiming a request classifies its settlement as possibly sent, which requires a `Cancel`.
            assert!(claim_for_write(&publish));
            drop(data_rx.recv().await);
        }

        assert!(inner.settle_route(route));

        assert!(
            !inner.retired.load(Ordering::Acquire),
            "route settlement must not retire the generation"
        );
        assert!(
            control_rx.try_recv().is_err(),
            "route Goodbye already settles the host side; per-correlation Cancel adds only overflow risk"
        );
        assert!(lock_unpoisoned(&inner.pending).is_empty());
    }

    #[test]
    fn inbound_validation_enforces_the_direct_profile_table() {
        let header =
            |ty: FrameType, channel: u16, epoch: u32, corr: u64, len: u32| EnvelopeHeader {
                len,
                ver: PROTOCOL_VERSION,
                ty,
                flags: if ty.is_pure_header() {
                    pure_header_flags()
                } else {
                    Flags::new(false, Priority::Interactive, false)
                },
                channel,
                epoch,
                corr,
            };

        assert!(validate_inbound(&header(FrameType::Response, 0, 0, 7, 4)).is_ok());
        assert!(validate_inbound(&header(FrameType::Response, 3, 9, 7, 4)).is_ok());
        assert!(validate_inbound(&header(FrameType::StreamData, 3, 9, 7, 4)).is_ok());
        assert!(validate_inbound(&header(FrameType::StreamEnd, 3, 9, 7, 0)).is_ok());
        assert!(validate_inbound(&header(FrameType::Push, 3, 9, 0, 4)).is_ok());

        assert!(validate_inbound(&header(FrameType::Response, 3, 0, 7, 4)).is_ok());

        assert!(validate_inbound(&header(FrameType::StreamEnd, 3, 9, 7, 1)).is_err());

        assert!(validate_inbound(&header(FrameType::Push, 3, 9, 5, 4)).is_err());

        // §7.1 caps channel-0 bodies at 65,536 bytes.
        assert!(
            validate_inbound(&header(FrameType::Response, 0, 0, 7, MAX_CONTROL_BODY_LEN)).is_ok()
        );
        assert!(validate_inbound(&header(
            FrameType::Response,
            0,
            0,
            7,
            MAX_CONTROL_BODY_LEN + 1
        ))
        .is_err());
        // A routed body is opaque and keeps the framing cap.
        assert!(validate_inbound(&header(
            FrameType::Response,
            3,
            9,
            7,
            MAX_CONTROL_BODY_LEN + 1
        ))
        .is_ok());

        // §6.2 requires stream frames to use routed identities.
        // A control identity is structurally illegal, not merely unmatched.
        assert!(validate_inbound(&header(FrameType::StreamData, 0, 0, 7, 4)).is_err());
        assert!(validate_inbound(&header(FrameType::StreamEnd, 0, 0, 7, 0)).is_err());
        // A terminal may still answer a control request.
        assert!(validate_inbound(&header(FrameType::Response, 0, 0, 7, 4)).is_ok());
        assert!(validate_inbound(&header(FrameType::Error, 0, 0, 7, 4)).is_ok());

        // Channel-0 bodies must be UTF-8 JSON.
        // A binary terminal on channel 0 is malformed.
        let binary_control = EnvelopeHeader {
            len: 4,
            ver: PROTOCOL_VERSION,
            ty: FrameType::Response,
            flags: response_flags(true, true),
            channel: 0,
            epoch: 0,
            corr: 7,
        };
        assert!(validate_inbound(&binary_control).is_err());
        // A routed body stays opaque and may be binary.
        let binary_routed = EnvelopeHeader {
            channel: 3,
            epoch: 9,
            ..binary_control
        };
        assert!(validate_inbound(&binary_routed).is_ok());

        assert!(validate_inbound(&header(FrameType::Response, 3, 9, 0, 4)).is_err());
        assert!(validate_inbound(&header(FrameType::Ping, 0, 0, 7, 0)).is_ok());
        assert!(validate_inbound(&header(FrameType::Ping, 1, 0, 7, 0)).is_err());
        assert!(validate_inbound(&header(FrameType::Goodbye, 0, 0, 0, 0)).is_ok());
        assert!(validate_inbound(&header(FrameType::Goodbye, 3, 9, 0, 1)).is_err());
        assert!(validate_inbound(&header(FrameType::Request, 3, 9, 7, 4)).is_err());
    }

    #[tokio::test]
    async fn a_ping_at_any_valid_priority_is_answered_with_an_exact_flag_echo() {
        // `Ping` fixes binary, last, and admission flags; priority may use any valid value.
        // `Pong` must echo `Ping`'s flags exactly.
        for priority in [
            Priority::Passive,
            Priority::Interactive,
            Priority::Background,
        ] {
            let (inner, _data_rx, mut control_rx) = test_inner(CLIENT_QUEUED_BYTES);
            let flags = Flags::new(false, priority, false);
            let ping = EnvelopeHeader {
                len: 0,
                ver: PROTOCOL_VERSION,
                ty: FrameType::Ping,
                flags,
                channel: 0,
                epoch: 0,
                corr: 41,
            };
            assert!(
                validate_inbound(&ping).is_ok(),
                "{priority:?} is a valid Ping priority, not a reason to retire"
            );

            inner.dispatch(ping, Vec::new(), ByteCharge::none());

            let pong = control_rx.recv().await.expect("Pong queued");
            assert_eq!(pong.bytes[5], FrameType::Pong as u8);
            assert_eq!(
                pong.bytes[6], flags.0,
                "the Pong must echo the Ping's flag byte, not the client's default"
            );
            assert!(!inner.retired.load(Ordering::Acquire));
            drop(pong);
        }

        // `Ping` fixes binary, last, and admission flags.
        for flags in [
            Flags::new(true, Priority::Passive, false),
            Flags::new(false, Priority::Passive, true),
        ] {
            let ping = EnvelopeHeader {
                len: 0,
                ver: PROTOCOL_VERSION,
                ty: FrameType::Ping,
                flags,
                channel: 0,
                epoch: 0,
                corr: 41,
            };
            assert!(validate_inbound(&ping).is_err());
        }
    }

    #[tokio::test]
    async fn a_zero_length_stream_item_is_delivered_without_retiring() {
        // Only `StreamEnd` must be empty; zero-length `StreamData` is valid.
        // A zero-length `StreamData` incurs no charge because it carries no bytes.
        // A zero-length `StreamData` must reach the stream instead of retiring it.
        // generation.
        let (inner, mut data_rx, _control_rx) = test_inner(CLIENT_QUEUED_BYTES);
        let (items_tx, mut items_rx) = mpsc::channel(CLIENT_STREAM_QUEUE_ITEMS);
        let (terminal_tx, _terminal_rx) = oneshot::channel();
        let (key, _publish) = inner
            .admit(
                route(1),
                Vec::new(),
                PendingKind::Stream {
                    items: items_tx,
                    terminal: terminal_tx,
                    _settled: CancellationToken::new().drop_guard(),
                },
                Instant::now() + Duration::from_secs(60),
            )
            .expect("stream admitted");
        drop(data_rx.recv().await);

        inner.dispatch(
            EnvelopeHeader {
                len: 0,
                ver: PROTOCOL_VERSION,
                ty: FrameType::StreamData,
                flags: response_flags(false, false),
                channel: key.channel,
                epoch: key.epoch,
                corr: key.corr,
            },
            Vec::new(),
            ByteCharge::none(),
        );

        assert!(
            !inner.retired.load(Ordering::Acquire),
            "an empty item carries a no-op charge, not an exhausted budget"
        );
        let item = items_rx.try_recv().expect("the empty item is delivered");
        assert!(item.body.is_empty());
        assert!(lock_unpoisoned(&inner.pending).contains_key(&key));
    }

    #[tokio::test]
    async fn an_out_of_range_timeout_is_rejected_instead_of_panicking() {
        // `Duration::MAX` means no timeout; reject an unrepresentable deadline with a typed error instead of panicking.
        let error = request_deadline(Duration::MAX).expect_err("unrepresentable");
        assert_eq!(error.outcome(), SendOutcome::NotSent);
        assert_eq!(error.code(), "invalid_timeout");
        assert!(request_deadline(Duration::from_secs(30)).is_ok());
    }

    #[tokio::test]
    async fn a_pre_cancelled_stream_never_enqueues_a_frame() {
        let (inner, mut data_rx, _control_rx) = test_inner(CLIENT_QUEUED_BYTES);
        lock_unpoisoned(&inner.routes).insert(route(1));
        let cancelled = CancellationToken::new();
        cancelled.cancel();

        let error = inner
            .start_stream(
                route(1),
                b"must-not-send".to_vec(),
                RequestOptions {
                    timeout: Duration::from_secs(30),
                    cancellation: Some(cancelled),
                },
            )
            .expect_err("an already-cancelled token admits nothing");
        assert_eq!(error.outcome(), SendOutcome::NotSent);
        assert_eq!(error.code(), "cancelled");
        assert!(
            data_rx.try_recv().is_err(),
            "a cancelled stream must not reach the writer"
        );
        assert!(lock_unpoisoned(&inner.pending).is_empty());
        assert_eq!(
            *lock_unpoisoned(&inner.streams),
            0,
            "no live stream charged"
        );
    }

    #[tokio::test]
    async fn a_pre_cancelled_unary_never_enqueues_a_frame() {
        let (inner, mut data_rx, _control_rx) = test_inner(CLIENT_QUEUED_BYTES);
        let cancelled = CancellationToken::new();
        cancelled.cancel();

        let error = inner
            .unary(
                route(1),
                b"must-not-send".to_vec(),
                Instant::now() + Duration::from_secs(30),
                Some(cancelled),
            )
            .await
            .expect_err("an already-cancelled token admits nothing");
        assert_eq!(error.outcome(), SendOutcome::NotSent);
        assert_eq!(error.code(), "cancelled");
        assert!(
            data_rx.try_recv().is_err(),
            "a cancelled request must not reach the writer"
        );
        assert!(lock_unpoisoned(&inner.pending).is_empty());
    }

    #[tokio::test]
    async fn a_terminal_that_wins_the_cancellation_race_is_not_discarded() {
        // Remove the pending entry before publishing the terminal so a concurrent stop cannot cancel a completed request.
        // A stop after `dispatch` removes the pending entry finds nothing to cancel.
        // Reporting a local error after the host answers would discard that answer and force outcome-unknown recovery for a settled operation.
        let (inner, mut data_rx, _control_rx) = test_inner(CLIENT_QUEUED_BYTES);
        lock_unpoisoned(&inner.routes).insert(route(1));
        let (kind, rx) = unary_sender();
        let (key, publish) = inner
            .admit(
                route(1),
                Vec::new(),
                kind,
                Instant::now() + Duration::from_secs(60),
            )
            .expect("admitted");
        assert!(claim_for_write(&publish), "the writer claimed the request");
        drop(data_rx.recv().await);

        // A concurrent stop cannot enqueue `Cancel` after the terminal becomes observable.
        let state = lock_unpoisoned(&inner.pending)
            .remove(&key)
            .expect("entry exists");
        match state.kind {
            PendingKind::Unary(tx) => tx
                .send(Ok(Response {
                    body: b"authoritative".to_vec(),
                    binary: false,
                }))
                .expect("terminal published"),
            PendingKind::Stream { .. } => unreachable!("admitted a unary request"),
        }

        let mut rx = rx;
        let response = inner
            .stop_or_take_terminal(key, &mut rx, &publish, "cancelled", "request was cancelled")
            .await
            .expect("the observed terminal wins over the local stop");
        assert_eq!(response.body, b"authoritative");
    }

    #[tokio::test]
    async fn a_terminal_still_in_flight_wins_over_the_local_stop() {
        // Removing the pending entry before sending the terminal prevents a concurrent stop from cancelling a completed request.
        // A single `try_recv` can report `OutcomeUnknown` after the host answered if `dispatch` holds the sender before publishing the terminal.
        // stop must wait for the owner that holds the sender.
        let (inner, mut data_rx, _control_rx) = test_inner(CLIENT_QUEUED_BYTES);
        lock_unpoisoned(&inner.routes).insert(route(1));
        let (kind, rx) = unary_sender();
        let (key, publish) = inner
            .admit(
                route(1),
                Vec::new(),
                kind,
                Instant::now() + Duration::from_secs(60),
            )
            .expect("admitted");
        assert!(claim_for_write(&publish), "the writer claimed the request");
        drop(data_rx.recv().await);

        let state = lock_unpoisoned(&inner.pending)
            .remove(&key)
            .expect("entry exists");
        let PendingKind::Unary(tx) = state.kind else {
            unreachable!("admitted a unary request")
        };

        let mut rx = rx;
        let stop = async {
            inner
                .stop_or_take_terminal(key, &mut rx, &publish, "cancelled", "request was cancelled")
                .await
        };
        let publish_terminal = async {
            // `publish_terminal` waits after `stop` observes the absent entry and before the owner publishes.
            tokio::task::yield_now().await;
            tx.send(Ok(Response {
                body: b"authoritative".to_vec(),
                binary: false,
            }))
            .expect("terminal published");
        };
        let (result, ()) = tokio::join!(stop, publish_terminal);
        let response = result.expect("the in-flight terminal wins over the local stop");
        assert_eq!(response.body, b"authoritative");
    }

    #[tokio::test]
    async fn a_dropped_sender_after_an_absent_entry_reports_the_send_outcome() {
        // When generation retirement removes the pending entry, it drops the sender.
        // Generation retirement can drop the sender after taking the pending entry.
        // `stop` must classify generation-retirement removal from publish state.
        let (inner, mut data_rx, _control_rx) = test_inner(CLIENT_QUEUED_BYTES);
        lock_unpoisoned(&inner.routes).insert(route(1));
        let (kind, rx) = unary_sender();
        let (key, publish) = inner
            .admit(
                route(1),
                Vec::new(),
                kind,
                Instant::now() + Duration::from_secs(60),
            )
            .expect("admitted");
        assert!(claim_for_write(&publish), "the writer claimed the request");
        drop(data_rx.recv().await);
        drop(
            lock_unpoisoned(&inner.pending)
                .remove(&key)
                .expect("entry exists"),
        );

        let mut rx = rx;
        let error = inner
            .stop_or_take_terminal(key, &mut rx, &publish, "cancelled", "request was cancelled")
            .await
            .expect_err("a dropped sender publishes no terminal");
        assert_eq!(error.code, "generation_retired");
        assert_eq!(
            error.outcome,
            SendOutcome::OutcomeUnknown,
            "a claimed request whose sender vanished may still have been delivered"
        );
    }

    #[test]
    fn absent_admission_facts_are_omitted_rather_than_sent_as_null() {
        // The host reads every present member as `Some(..)`.
        // `bind` observes caller-omitted facts when a present member is null.
        let target = RouteTarget {
            kind: TargetKind::ToolProvider,
            module_id: "magic-context".to_owned(),
        };
        let mut identity = identity_fixture();
        let body = route_open_body(&target, &identity).expect("body encodes");
        let value: serde_json::Value = serde_json::from_slice(&body).expect("valid JSON");
        assert!(
            value.get("admission_facts").is_none(),
            "absent facts must not appear as an explicit null"
        );

        identity.admission_facts = Some(serde_json::json!({"tier": "gold"}));
        let body = route_open_body(&target, &identity).expect("body encodes");
        let value: serde_json::Value = serde_json::from_slice(&body).expect("valid JSON");
        assert_eq!(
            value["admission_facts"],
            serde_json::json!({"tier": "gold"})
        );
    }

    fn identity_fixture() -> RouteIdentity {
        RouteIdentity {
            project_root: std::path::PathBuf::from("/tmp/project"),
            harness: "opencode".to_owned(),
            session: "session".to_owned(),
            consumer_module_id: None,
            consumer_launch_nonce: None,
            consumer_capabilities: Vec::new(),
            admission_facts: None,
            credential_fingerprints: std::collections::BTreeMap::new(),
        }
    }

    #[tokio::test]
    async fn dropped_unary_future_cleans_pending_and_possibly_sent_request() {
        let (inner, mut data_rx, mut control_rx) = test_inner(CLIENT_QUEUED_BYTES);
        let task_inner = Arc::clone(&inner);
        let request = tokio::spawn(async move {
            task_inner
                .unary(
                    route(1),
                    b"stalled-peer".to_vec(),
                    Instant::now() + Duration::from_secs(60),
                    None,
                )
                .await
        });
        let frame = data_rx.recv().await.expect("request admitted");
        let publish = frame.publish.as_ref().expect("data publication state");
        assert!(
            claim_for_write(publish),
            "simulate stalled writer after claim"
        );
        request.abort();
        assert!(request.await.expect_err("request aborted").is_cancelled());

        assert!(lock_unpoisoned(&inner.pending).is_empty());
        let cancel = control_rx.recv().await.expect("possibly-sent Cancel");
        assert_eq!(cancel.bytes[5], FrameType::Cancel as u8);
        drop(frame);
        drop(cancel);
        assert_eq!(inner.queue_budget.used(), 0);
    }

    #[tokio::test]
    async fn dropped_close_retires_and_repeated_close_joins_tasks() {
        let (inner, _data_rx, _control_rx) = test_inner(CLIENT_QUEUED_BYTES);
        let writer_cancel = inner.cancel.clone();
        *inner.writer.lock().await = Some(tokio::spawn(async move {
            writer_cancel.cancelled().await;
        }));
        let reader_cancel = inner.cancel.clone();
        *inner.reader.lock().await = Some(tokio::spawn(async move {
            reader_cancel.cancelled().await;
        }));
        let client = Arc::new(Client {
            inner: Arc::clone(&inner),
        });
        let closing = {
            let client = Arc::clone(&client);
            tokio::spawn(async move { client.close().await })
        };
        while !inner.closed.load(Ordering::Acquire) {
            tokio::task::yield_now().await;
        }
        closing.abort();
        assert!(closing.await.expect_err("close aborted").is_cancelled());
        assert!(inner.retired.load(Ordering::Acquire));
        assert!(inner.cancel.is_cancelled());

        timeout_at(Instant::now() + Duration::from_secs(1), client.close())
            .await
            .expect("second close bounded")
            .expect("second close succeeds");
        assert!(inner.writer.lock().await.is_none());
        assert!(inner.reader.lock().await.is_none());
    }

    #[tokio::test]
    async fn data_capacity_spares_control_reserve_and_does_not_burn_correlation() {
        let (inner, data_rx, mut control_rx) = test_inner(CLIENT_QUEUED_BYTES);
        let deadline = Instant::now() + Duration::from_secs(1);
        let mut receivers = Vec::new();
        for _ in 0..CLIENT_DATA_QUEUE_FRAMES {
            let (kind, rx) = unary_sender();
            inner
                .admit(route(1), Vec::new(), kind, deadline)
                .expect("data slot");
            receivers.push(rx);
        }
        let next_before = lock_unpoisoned(&inner.correlations).next;
        let (kind, _rx) = unary_sender();
        let error = inner
            .admit(route(1), Vec::new(), kind, deadline)
            .expect_err("257th data frame is rejected");
        assert_eq!(error.outcome(), SendOutcome::NotSent);
        assert_eq!(error.code(), "writer_queue_full");
        assert_eq!(lock_unpoisoned(&inner.correlations).next, next_before);

        inner
            .send_control(
                FrameType::Pong,
                pure_header_flags(),
                FrameId::control(99),
                None,
            )
            .expect("reserved control remains available");
        let pong = control_rx.recv().await.expect("queued Pong");
        assert_eq!(pong.bytes[5], FrameType::Pong as u8);
        drop(pong);
        assert_eq!(data_rx.len(), CLIENT_DATA_QUEUE_FRAMES);

        inner.retire("test_done");
        drop(data_rx);
        drop(control_rx);
        drop(receivers);
        assert_eq!(inner.queue_budget.used(), 0);
    }

    #[tokio::test]
    async fn control_exhaustion_retires_and_releases_all_queued_bytes() {
        let (inner, data_rx, control_rx) = test_inner(CLIENT_QUEUED_BYTES);
        for corr in 1..=CLIENT_CONTROL_QUEUE_FRAMES as u64 {
            inner
                .send_control(
                    FrameType::Pong,
                    pure_header_flags(),
                    FrameId::control(corr),
                    None,
                )
                .expect("reserved slot");
        }
        let error = inner
            .send_control(
                FrameType::Pong,
                pure_header_flags(),
                FrameId::control(99),
                None,
            )
            .expect_err("33rd control retires generation");
        assert_eq!(error.code(), "control_capacity_exhausted");
        assert!(inner.retired.load(Ordering::Acquire));
        drop(data_rx);
        drop(control_rx);
        assert_eq!(inner.queue_budget.used(), 0);
        assert!(lock_unpoisoned(&inner.pending).is_empty());
    }

    #[tokio::test]
    async fn data_saturation_never_starves_a_control_frame() {
        // Control frames must not charge the request-body pool: failed data charges reject one caller, but failed control charges retire the generation.
        // Control frames use a separate budget because queued data can otherwise retire the generation when Pong or Cancel admission fails.
        let (inner, data_rx, mut control_rx) = test_inner(HEADER_LEN);
        let (kind, _rx) = unary_sender();
        inner
            .admit(
                route(1),
                Vec::new(),
                kind,
                Instant::now() + Duration::from_secs(1),
            )
            .expect("data header fills the whole data budget");
        assert_eq!(
            inner.queue_budget.used(),
            HEADER_LEN,
            "the data pool is now saturated"
        );

        inner
            .send_control(
                FrameType::Pong,
                pure_header_flags(),
                FrameId::control(1),
                None,
            )
            .expect("a reserved control frame does not compete with request bytes");
        assert!(
            !inner.retired.load(Ordering::Acquire),
            "ordinary traffic must never retire the generation through a starved control frame"
        );
        assert_eq!(inner.control_budget.used(), HEADER_LEN);
        let queued = control_rx.try_recv().expect("Pong queued");
        assert_eq!(queued.bytes[5], FrameType::Pong as u8);

        drop(data_rx);
        drop(control_rx);
        assert_eq!(inner.queue_budget.used(), 0);
    }

    #[tokio::test]
    async fn stale_epoch_terminal_cannot_settle_reused_channel() {
        let (inner, mut data_rx, _control_rx) = test_inner(CLIENT_QUEUED_BYTES);
        let (kind, mut rx) = unary_sender();
        let (key, _) = inner
            .admit(
                route(2),
                Vec::new(),
                kind,
                Instant::now() + Duration::from_secs(1),
            )
            .expect("admit current epoch");
        drop(data_rx.recv().await);
        inner.dispatch(
            EnvelopeHeader {
                len: 0,
                ver: PROTOCOL_VERSION,
                ty: FrameType::Response,
                flags: response_flags(false, true),
                channel: key.channel,
                epoch: 1,
                corr: key.corr,
            },
            Vec::new(),
            ByteCharge::none(),
        );
        assert!(matches!(
            rx.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        assert!(lock_unpoisoned(&inner.pending).contains_key(&key));
        inner.retire("test_done");
    }

    #[tokio::test]
    async fn saturated_stream_fails_alone_and_queues_cancel() {
        let (inner, mut data_rx, mut control_rx) = test_inner(CLIENT_QUEUED_BYTES);
        let (items_tx, _items_rx) = mpsc::channel(CLIENT_STREAM_QUEUE_ITEMS);
        let (terminal_tx, terminal_rx) = oneshot::channel();
        let (stream_key, _) = inner
            .admit(
                route(1),
                Vec::new(),
                PendingKind::Stream {
                    items: items_tx,
                    terminal: terminal_tx,
                    _settled: CancellationToken::new().drop_guard(),
                },
                Instant::now() + Duration::from_secs(1),
            )
            .expect("stream admitted");
        drop(data_rx.recv().await);
        let (unary_kind, mut unary_rx) = unary_sender();
        let (unary_key, _) = inner
            .admit(
                route(1),
                Vec::new(),
                unary_kind,
                Instant::now() + Duration::from_secs(1),
            )
            .expect("unrelated unary admitted");
        drop(data_rx.recv().await);

        for _ in 0..=CLIENT_STREAM_QUEUE_ITEMS {
            let charge = inner.retained_budget.charge(1).expect("retained byte");
            inner.dispatch(
                EnvelopeHeader {
                    len: 1,
                    ver: PROTOCOL_VERSION,
                    ty: FrameType::StreamData,
                    flags: response_flags(false, false),
                    channel: stream_key.channel,
                    epoch: stream_key.epoch,
                    corr: stream_key.corr,
                },
                vec![1],
                charge,
            );
        }
        let error = terminal_rx
            .await
            .expect("terminal sender")
            .expect_err("saturated stream fails");
        assert_eq!(error.code(), "stream_saturated");
        // Saturation occurs after publication without a terminal frame; because Cancel is best-effort, report `OutcomeUnknown` rather than `Terminal`.
        assert_eq!(error.outcome(), SendOutcome::OutcomeUnknown);
        let cancel = control_rx.recv().await.expect("stream Cancel");
        assert_eq!(cancel.bytes[5], FrameType::Cancel as u8);

        inner.dispatch(
            EnvelopeHeader {
                len: 0,
                ver: PROTOCOL_VERSION,
                ty: FrameType::Response,
                flags: response_flags(false, true),
                channel: unary_key.channel,
                epoch: unary_key.epoch,
                corr: unary_key.corr,
            },
            Vec::new(),
            ByteCharge::none(),
        );
        assert!(unary_rx.try_recv().expect("unary settled").is_ok());
        assert!(lock_unpoisoned(&inner.pending).is_empty());
        inner.retire("test_done");
    }

    #[tokio::test]
    async fn unary_stream_data_is_unknown_not_terminal() {
        // `StreamData` is nonterminal and Cancel is best-effort, so report `OutcomeUnknown` rather than `Terminal`.
        let (inner, mut data_rx, mut control_rx) = test_inner(CLIENT_QUEUED_BYTES);
        lock_unpoisoned(&inner.routes).insert(route(1));
        let (kind, mut rx) = unary_sender();
        let (key, _publish) = inner
            .admit(
                route(1),
                Vec::new(),
                kind,
                Instant::now() + Duration::from_secs(60),
            )
            .expect("admitted");
        drop(data_rx.recv().await);

        inner.dispatch(
            EnvelopeHeader {
                len: 1,
                ver: PROTOCOL_VERSION,
                ty: FrameType::StreamData,
                flags: response_flags(false, false),
                channel: key.channel,
                epoch: key.epoch,
                corr: key.corr,
            },
            vec![1],
            inner.retained_budget.charge(1).expect("retained byte"),
        );

        let error = rx
            .try_recv()
            .expect("unary settled")
            .expect_err("stream data on a unary is a violation");
        assert_eq!(error.code(), "unexpected_stream");
        assert_eq!(error.outcome(), SendOutcome::OutcomeUnknown);
        let cancel = control_rx.recv().await.expect("scoped Cancel");
        assert_eq!(cancel.bytes[5], FrameType::Cancel as u8);
        inner.retire("test_done");
    }

    #[tokio::test]
    async fn cancelling_a_stream_releases_its_queued_item_charges() {
        // Cancellation releases queued-item charges because `next` stops at `finished`; otherwise a retained stream pins the owner budget.
        // generation.
        let (inner, mut data_rx, mut control_rx) = test_inner(CLIENT_QUEUED_BYTES);
        lock_unpoisoned(&inner.routes).insert(route(1));
        let (items_tx, items_rx) = mpsc::channel(CLIENT_STREAM_QUEUE_ITEMS);
        let (terminal_tx, terminal_rx) = oneshot::channel();
        let (key, publish) = inner
            .admit(
                route(1),
                Vec::new(),
                PendingKind::Stream {
                    items: items_tx,
                    terminal: terminal_tx,
                    _settled: CancellationToken::new().drop_guard(),
                },
                Instant::now() + Duration::from_secs(60),
            )
            .expect("stream admitted");
        // The host streams items only after receiving the request.
        // The writer has claimed the request before the host streams items.
        // `OutcomeUnknown` emits the `Cancel` frame.
        assert!(claim_for_write(&publish), "the writer claimed the request");
        drop(data_rx.recv().await);

        let mut stream = ResponseStream {
            inner: Arc::downgrade(&inner),
            key,
            correlation: key.corr,
            items: items_rx,
            terminal: Some(terminal_rx),
            finished: false,
        };

        // Queued items simulate a slow consumer.
        // them.
        const ITEMS: usize = 4;
        for _ in 0..ITEMS {
            inner.dispatch(
                EnvelopeHeader {
                    len: 8,
                    ver: PROTOCOL_VERSION,
                    ty: FrameType::StreamData,
                    flags: response_flags(false, false),
                    channel: key.channel,
                    epoch: key.epoch,
                    corr: key.corr,
                },
                vec![7; 8],
                inner.retained_budget.charge(8).expect("retained bytes"),
            );
        }
        assert_eq!(inner.retained_budget.used(), ITEMS * 8);

        stream.cancel().expect("cancel succeeds");
        assert_eq!(
            inner.retained_budget.used(),
            0,
            "cancel released every queued item's charge while the stream is still alive"
        );
        // `stream` remains alive so cancellation releases queued charges before `ResponseStream::drop`.
        assert!(stream
            .next()
            .await
            .expect("cancelled stream ends")
            .is_none());
        let cancel = control_rx.recv().await.expect("scoped Cancel");
        assert_eq!(cancel.bytes[5], FrameType::Cancel as u8);
        inner.retire("test_done");
        drop(stream);
    }

    #[tokio::test(start_paused = true)]
    async fn idle_header_is_unbounded_then_partial_frame_has_one_deadline() {
        let (inner, _data_rx, _control_rx) = test_inner(CLIENT_QUEUED_BYTES);
        let (mut peer, mut reader) = tokio::io::duplex(64);
        let task_inner = Arc::clone(&inner);
        let task = tokio::spawn(async move { read_active_frame(&mut reader, &task_inner).await });

        tokio::time::advance(Duration::from_secs(3_600)).await;
        tokio::task::yield_now().await;
        assert!(
            !task.is_finished(),
            "idle first-header wait must be unbounded"
        );

        peer.write_all(&[0]).await.expect("first header byte");
        tokio::time::advance(CLIENT_FRAME_TIMEOUT - Duration::from_millis(1)).await;
        tokio::task::yield_now().await;
        assert!(!task.is_finished(), "partial frame keeps original deadline");
        tokio::time::advance(Duration::from_millis(1)).await;
        tokio::task::yield_now().await;
        assert!(task.await.expect("reader task").is_err());
    }

    #[tokio::test]
    async fn an_unsupported_version_fails_at_the_frozen_prefix() {
        // Byte 4 of the frozen prefix already proves the generation unusable.
        // A peer that sends only the five-byte frozen prefix can hold the connection until the frame deadline if the reader waits for the remaining header bytes.
        // The one-second timeout requires prefix-first rejection because it is shorter than `CLIENT_FRAME_TIMEOUT`.
        let (inner, _data_rx, _control_rx) = test_inner(CLIENT_QUEUED_BYTES);
        let (mut peer, mut reader) = tokio::io::duplex(64);
        let mut prefix = [0u8; FROZEN_PREFIX_LEN];
        prefix[4] = PROTOCOL_VERSION.wrapping_add(1);
        peer.write_all(&prefix).await.expect("frozen prefix");

        let result = tokio::time::timeout(
            Duration::from_secs(1),
            read_active_frame(&mut reader, &inner),
        )
        .await
        .expect("an unsupported version must be rejected on the prefix alone");
        assert!(
            result.is_err(),
            "an unsupported envelope version is not a readable frame"
        );
    }

    #[tokio::test]
    async fn an_oversize_negotiation_response_is_rejected_on_the_header() {
        // Negotiation payloads are channel-zero control traffic and must not exceed 65,536 bytes.
        // `read_setup_frame` must enforce the control-body cap because it bypasses `validate_inbound`.
        // The reader rejects headers over 65,536 bytes before allocating their bodies.
        // `read_setup_frame` must reject the header before reading the body.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let peer = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let header = EnvelopeHeader {
                len: MAX_CONTROL_BODY_LEN + 1,
                ver: PROTOCOL_VERSION,
                ty: FrameType::Response,
                flags: response_flags(false, true),
                channel: 0,
                epoch: 0,
                corr: NEGOTIATION_CORRELATION,
            }
            .encode();
            socket.write_all(&header).await.unwrap();
            socket
        });
        let mut stream = TcpStream::connect(addr).await.unwrap();

        let outcome = tokio::time::timeout(
            Duration::from_secs(1),
            read_setup_frame(&mut stream, Instant::now() + CLIENT_HANDSHAKE_TIMEOUT),
        )
        .await
        .expect("the header alone proves the violation; no body wait");
        let Err(error) = outcome else {
            panic!("an oversize control body is rejected");
        };
        assert_eq!(error.code(), "negotiation_failed");
        drop(peer.await);
    }

    #[tokio::test]
    async fn an_abandoned_control_open_releases_a_late_bound_route() {
        // `open_route` can write the request before its caller drops or times out.
        // `open_route` responses can arrive after the pending entry is removed.
        // A late route-bind response without a pending entry strands the binding unless the client sends `Goodbye`.
        // The client never learns the route handle, so it cannot send a route `Goodbye`.
        // Each repeated abandonment consumes a host-side route and channel permit.
        // The client must send a best-effort route `Goodbye` for late binds it cannot own.
        // The client closes the connection only when route `Goodbye` cannot be queued.
        let (inner, mut data_rx, mut control_rx) = test_inner(CLIENT_QUEUED_BYTES);
        let control = RouteHandle {
            channel: 0,
            epoch: 0,
        };
        let (tx, _rx) = oneshot::channel();
        let (key, publish) = inner
            .admit(
                control,
                Vec::new(),
                PendingKind::Unary(tx),
                Instant::now() + Duration::from_secs(60),
            )
            .expect("control request admitted");
        // The host answers only a request it received, so the writer claimed it.
        // The writer's claim makes the abandonment `OutcomeUnknown`.
        // Identity 0/0 has no legal `Cancel`.
        assert!(claim_for_write(&publish), "the writer claimed the request");
        drop(data_rx.recv().await);

        let removal = inner
            .cancel_key(key, "caller_dropped")
            .expect("abandoning a control request never fails");
        assert!(matches!(removal, PendingRemoval::Cancelled));
        assert!(
            control_rx.try_recv().is_err(),
            "identity 0/0 has no legal Cancel, so abandoning emits no control frame"
        );

        let bound = RouteHandle {
            channel: 9,
            epoch: 3,
        };
        let body = serde_json::to_vec(&serde_json::json!({
            "op": "route.open",
            "route_channel": bound.channel,
            "route_epoch": bound.epoch,
        }))
        .expect("body encodes");
        inner.dispatch(
            EnvelopeHeader {
                len: u32::try_from(body.len()).expect("fits a frame length"),
                ver: PROTOCOL_VERSION,
                ty: FrameType::Response,
                flags: response_flags(false, false),
                channel: control.channel,
                epoch: control.epoch,
                corr: key.corr,
            },
            body,
            ByteCharge::none(),
        );

        let goodbye = control_rx
            .try_recv()
            .expect("a stranded bind is released with a route Goodbye");
        assert_eq!(goodbye.bytes[5], FrameType::Goodbye as u8);
        let header = decode_header(&goodbye.bytes).expect("the Goodbye decodes");
        assert_eq!(header.channel, bound.channel, "the exact stranded channel");
        assert_eq!(header.epoch, bound.epoch, "the exact stranded epoch");
        assert_eq!(header.corr, 0, "a route Goodbye carries correlation 0");
        assert!(
            !inner.retired.load(Ordering::Acquire),
            "reclaiming one route must not take unrelated routes with it"
        );
        assert!(
            !lock_unpoisoned(&inner.routes).contains(&bound),
            "a late bind never enters the client cache"
        );
        inner.retire("test_done");
    }

    #[tokio::test]
    async fn a_duplicate_bind_terminal_never_closes_an_owned_route() {
        // An unmatched control `Response` can represent a stranded route binding.
        // Only an unmatched route-bind response can indicate a stranded binding; duplicate terminals for delivered routes must not trigger cleanup.
        // `inner.routes` distinguishes stranded binds from routes the caller owns; only stranded binds receive `Goodbye`.
        let (inner, _data_rx, mut control_rx) = test_inner(CLIENT_QUEUED_BYTES);
        let owned = route(1);
        assert!(
            lock_unpoisoned(&inner.routes).contains(&owned),
            "the fixture owns this route"
        );
        let body = serde_json::to_vec(&serde_json::json!({
            "op": "route.open",
            "route_channel": owned.channel,
            "route_epoch": owned.epoch,
        }))
        .expect("body encodes");
        inner.dispatch(
            EnvelopeHeader {
                len: u32::try_from(body.len()).expect("fits a frame length"),
                ver: PROTOCOL_VERSION,
                ty: FrameType::Response,
                flags: response_flags(false, false),
                channel: 0,
                epoch: 0,
                corr: FIRST_APPLICATION_CORRELATION,
            },
            body,
            ByteCharge::none(),
        );

        assert!(
            control_rx.try_recv().is_err(),
            "an owned route is never released by a duplicate bind terminal"
        );
        assert!(
            lock_unpoisoned(&inner.routes).contains(&owned),
            "the owned route stays live"
        );
        inner.retire("test_done");
    }

    #[tokio::test]
    async fn token_cancelling_a_stream_leaves_its_queued_items_reachable() {
        // `cancel_key` cannot reach the caller-held receiver, so queued items remain charged to the owner-wide retained budget.
        // `cancel_key` leaves `finished` false, so `next` can drain queued items.
        let (inner, mut data_rx, _control_rx) = test_inner(CLIENT_QUEUED_BYTES);
        lock_unpoisoned(&inner.routes).insert(route(1));
        let (items_tx, items_rx) = mpsc::channel(CLIENT_STREAM_QUEUE_ITEMS);
        let (terminal_tx, terminal_rx) = oneshot::channel();
        let (key, publish) = inner
            .admit(
                route(1),
                Vec::new(),
                PendingKind::Stream {
                    items: items_tx,
                    terminal: terminal_tx,
                    _settled: CancellationToken::new().drop_guard(),
                },
                Instant::now() + Duration::from_secs(60),
            )
            .expect("stream admitted");
        assert!(claim_for_write(&publish), "the writer claimed the request");
        drop(data_rx.recv().await);
        let mut stream = ResponseStream {
            inner: Arc::downgrade(&inner),
            key,
            correlation: key.corr,
            items: items_rx,
            terminal: Some(terminal_rx),
            finished: false,
        };

        const ITEMS: usize = 4;
        for _ in 0..ITEMS {
            inner.dispatch(
                EnvelopeHeader {
                    len: 8,
                    ver: PROTOCOL_VERSION,
                    ty: FrameType::StreamData,
                    flags: response_flags(false, false),
                    channel: key.channel,
                    epoch: key.epoch,
                    corr: key.corr,
                },
                vec![7; 8],
                inner.retained_budget.charge(8).expect("retained bytes"),
            );
        }
        assert_eq!(inner.retained_budget.used(), ITEMS * 8);

        let _ = inner.cancel_key(key, "cancelled");
        assert!(
            !stream.finished,
            "a watcher cancellation does not short-circuit the consumer"
        );

        // Every queued item is still delivered, in order, before the terminal.
        let mut drained = 0;
        loop {
            match stream.next().await {
                Ok(Some(item)) => {
                    assert_eq!(item.body, vec![7; 8]);
                    drained += 1;
                }
                Ok(None) => panic!("a cancelled stream reports its cancellation"),
                Err(error) => {
                    assert_eq!(error.code(), "cancelled");
                    break;
                }
            }
        }
        assert_eq!(drained, ITEMS, "the queued items survive the cancellation");
        assert_eq!(
            inner.retained_budget.used(),
            0,
            "draining the cancelled stream releases every charge"
        );
        inner.retire("test_done");
        drop(stream);
    }

    #[tokio::test]
    async fn dropping_a_token_cancelled_stream_releases_its_queued_charges() {
        // Dropping an unpolled watcher-cancelled stream releases its retained bytes.
        let (inner, mut data_rx, _control_rx) = test_inner(CLIENT_QUEUED_BYTES);
        lock_unpoisoned(&inner.routes).insert(route(1));
        let (items_tx, items_rx) = mpsc::channel(CLIENT_STREAM_QUEUE_ITEMS);
        let (terminal_tx, terminal_rx) = oneshot::channel();
        let (key, publish) = inner
            .admit(
                route(1),
                Vec::new(),
                PendingKind::Stream {
                    items: items_tx,
                    terminal: terminal_tx,
                    _settled: CancellationToken::new().drop_guard(),
                },
                Instant::now() + Duration::from_secs(60),
            )
            .expect("stream admitted");
        assert!(claim_for_write(&publish), "the writer claimed the request");
        drop(data_rx.recv().await);
        let stream = ResponseStream {
            inner: Arc::downgrade(&inner),
            key,
            correlation: key.corr,
            items: items_rx,
            terminal: Some(terminal_rx),
            finished: false,
        };

        const ITEMS: usize = 4;
        for _ in 0..ITEMS {
            inner.dispatch(
                EnvelopeHeader {
                    len: 8,
                    ver: PROTOCOL_VERSION,
                    ty: FrameType::StreamData,
                    flags: response_flags(false, false),
                    channel: key.channel,
                    epoch: key.epoch,
                    corr: key.corr,
                },
                vec![7; 8],
                inner.retained_budget.charge(8).expect("retained bytes"),
            );
        }
        let _ = inner.cancel_key(key, "cancelled");
        assert_eq!(inner.retained_budget.used(), ITEMS * 8);

        drop(stream);
        assert_eq!(
            inner.retained_budget.used(),
            0,
            "dropping the consumer releases every queued charge"
        );
        inner.retire("test_done");
    }

    #[tokio::test]
    async fn retained_stream_bytes_never_deny_a_maximum_sized_frame() {
        // Admitted connections must accept every otherwise-valid frame under the wire contract.
        // A shared pool can make an unrelated maximum-sized terminal unreadable when another consumer retains queued bytes.
        let (inner, mut data_rx, _control_rx) = test_inner(CLIENT_QUEUED_BYTES);
        let (items_tx, _items_rx) = mpsc::channel(CLIENT_STREAM_QUEUE_ITEMS);
        let (terminal_tx, _terminal_rx) = oneshot::channel();
        let (key, _publish) = inner
            .admit(
                route(1),
                Vec::new(),
                PendingKind::Stream {
                    items: items_tx,
                    terminal: terminal_tx,
                    _settled: CancellationToken::new().drop_guard(),
                },
                Instant::now() + Duration::from_secs(60),
            )
            .expect("stream admitted");
        drop(data_rx.recv().await);

        let queued = 2 * 1024 * 1024;
        let charge = inner.read_budget.charge(queued).expect("read reservation");
        inner.dispatch(
            EnvelopeHeader {
                len: u32::try_from(queued).expect("fits a frame length"),
                ver: PROTOCOL_VERSION,
                ty: FrameType::StreamData,
                flags: response_flags(true, false),
                channel: key.channel,
                epoch: key.epoch,
                corr: key.corr,
            },
            vec![0; queued],
            charge,
        );

        assert_eq!(
            inner.retained_budget.used(),
            queued,
            "a queued item is accounted against retention, not the read reservation"
        );
        assert_eq!(
            inner.read_budget.used(),
            0,
            "the read reservation is released once the bytes are retained"
        );
        assert!(
            inner.read_budget.charge(MAX_BODY_LEN as usize).is_some(),
            "queued bytes must not deny the reader a maximum-sized frame"
        );
        inner.retire("test_done");
    }

    #[tokio::test]
    async fn exhausted_retention_cancels_only_the_saturating_stream() {
        // Retention exhaustion is local to the affected stream, like item-queue overflow.
        // When retention is exhausted, `dispatch` cancels only the affected stream.
        // The stream cancellation preserves the generation and its unrelated routes.
        let (inner, mut data_rx, mut control_rx) = test_inner(CLIENT_QUEUED_BYTES);
        let (items_tx, _items_rx) = mpsc::channel(CLIENT_STREAM_QUEUE_ITEMS);
        let (terminal_tx, terminal_rx) = oneshot::channel();
        let (key, _publish) = inner
            .admit(
                route(1),
                Vec::new(),
                PendingKind::Stream {
                    items: items_tx,
                    terminal: terminal_tx,
                    _settled: CancellationToken::new().drop_guard(),
                },
                Instant::now() + Duration::from_secs(60),
            )
            .expect("stream admitted");
        drop(data_rx.recv().await);

        let hold = inner
            .retained_budget
            .charge(CLIENT_RETAINED_RESPONSE_BYTES)
            .expect("retention fully held by an existing consumer");
        let charge = inner.read_budget.charge(1).expect("read reservation");
        inner.dispatch(
            EnvelopeHeader {
                len: 1,
                ver: PROTOCOL_VERSION,
                ty: FrameType::StreamData,
                flags: response_flags(false, false),
                channel: key.channel,
                epoch: key.epoch,
                corr: key.corr,
            },
            vec![7],
            charge,
        );

        let error = terminal_rx
            .await
            .expect("terminal sender")
            .expect_err("the stream that could not retain its item fails");
        assert_eq!(error.code(), "stream_saturated");
        assert_eq!(error.outcome(), SendOutcome::OutcomeUnknown);
        let cancel = control_rx.recv().await.expect("stream Cancel");
        assert_eq!(cancel.bytes[5], FrameType::Cancel as u8);
        assert!(
            !inner.retired.load(Ordering::Acquire),
            "a saturated consumer must not retire the generation"
        );
        assert_eq!(
            inner.read_budget.used(),
            0,
            "the discarded item releases the read reservation"
        );
        drop(hold);
        inner.retire("test_done");
    }

    #[tokio::test]
    async fn a_malformed_route_open_success_retires_the_generation() {
        // The host binds routes whose success bodies omit the channel and epoch, so clients cannot send those routes `Goodbye`.
        // Keeping the connection live lets repeated opens strand host-side routes and channel permits.
        // Retiring the connection obliges the host to settle stranded routes and channel permits.
        let (inner, mut data_rx, _control_rx) = test_inner(CLIENT_QUEUED_BYTES);
        let client = Client {
            inner: Arc::clone(&inner),
        };
        let open = tokio::spawn(async move {
            client
                .open_route(
                    RouteTarget {
                        kind: TargetKind::ManagementSurface,
                        module_id: "magic-context".to_owned(),
                    },
                    identity_fixture(),
                )
                .await
        });

        let frame = data_rx.recv().await.expect("route.open request");
        let header = decode_header(&frame.bytes).expect("request header");
        inner.dispatch(
            EnvelopeHeader {
                len: 0,
                ver: PROTOCOL_VERSION,
                ty: FrameType::Response,
                flags: response_flags(false, true),
                channel: 0,
                epoch: 0,
                corr: header.corr,
            },
            br#"{"ok":true}"#.to_vec(),
            ByteCharge::none(),
        );

        let error = open
            .await
            .expect("open task")
            .expect_err("a success body without a route is not a route");
        assert_eq!(error.code(), "invalid_route_response");
        assert!(
            inner.retired.load(Ordering::Acquire),
            "an unnameable binding must not be left on a live generation"
        );
        assert!(
            lock_unpoisoned(&inner.routes).is_empty(),
            "retirement drops the generation's routes"
        );
    }

    #[test]
    fn queue_and_retained_charges_release_exactly() {
        let budget = Arc::new(ByteCounter::new(10));
        let first = budget.charge(7).expect("first charge");
        assert!(budget.charge(4).is_none());
        assert_eq!(budget.used(), 7);
        drop(first);
        assert_eq!(budget.used(), 0);
    }

    #[test]
    fn epoch_is_part_of_pending_key() {
        let old = PendingKey::new(
            RouteHandle {
                channel: 7,
                epoch: 1,
            },
            9,
        );
        let current = PendingKey::new(
            RouteHandle {
                channel: 7,
                epoch: 2,
            },
            9,
        );
        assert_ne!(old, current);
    }

    #[test]
    fn terminal_formatting_redacts_peer_message_and_body() {
        let sentinel = "CANARY-CREDENTIAL-PAYLOAD-93ff";
        let body = serde_json::to_vec(&serde_json::json!({
            "code": "stable_code",
            "message": sentinel
        }))
        .expect("serialize");
        let error = CallError::host_terminal(&body);
        let rendered = format!("{error:?} {error}");
        assert_eq!(error.outcome(), SendOutcome::Terminal);
        assert_eq!(error.code(), "stable_code");
        assert!(!rendered.contains(sentinel));
    }

    #[test]
    fn outcome_spellings_are_exact() {
        assert_eq!(SendOutcome::NotSent.as_str(), "not_sent");
        assert_eq!(SendOutcome::OutcomeUnknown.as_str(), "outcome_unknown");
        assert_eq!(SendOutcome::Terminal.as_str(), "terminal");
    }
}
