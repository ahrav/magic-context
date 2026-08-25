//! Managed Rust consumer for one authenticated mc-host generation.
//!
//! This module owns discovery, authentication, mandatory negotiation,
//! correlation allocation, framing, liveness, route epochs, bounded queues,
//! cancellation, and cleanup. Raw frame types never cross the public API.

use std::{
    collections::{HashMap, HashSet},
    error::Error,
    fmt,
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc, Mutex, MutexGuard, Weak,
    },
    time::Duration,
};

use serde_json::Value;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    net::{tcp::OwnedReadHalf, tcp::OwnedWriteHalf, TcpStream},
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
        decode_negotiate_response, NegotiateResponse, TransportOffer, NEGOTIATION_VERSION,
        TRANSPORT_TCP,
    },
    wire::{
        decode_header, encode_owned_frame, pure_header_flags, AdmissionClass, EnvelopeHeader,
        Flags, FrameId, FrameType, Priority, HEADER_LEN, MAX_BODY_LEN, MAX_CONTROL_BODY_LEN,
        PROTOCOL_VERSION,
    },
};

/// Total deadline for dial, authentication, and mandatory negotiation.
pub const CLIENT_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(2);
/// Deadline for a frame after its first header byte. Idle header waits are unbounded.
pub const CLIENT_FRAME_TIMEOUT: Duration = Duration::from_secs(30);
/// Absolute deadline for one route-open operation, including retries.
pub const CLIENT_ROUTE_OPEN_TIMEOUT: Duration = Duration::from_secs(30);
/// Default absolute deadline for one request.
pub const CLIENT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Absolute deadline for owner shutdown.
pub const CLIENT_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);
/// Owner-wide pending request cap.
pub const CLIENT_MAX_PENDING_REQUESTS: usize = 1_024;
/// Owner-wide live stream cap.
pub const CLIENT_MAX_LIVE_STREAMS: usize = 64;
/// Per-stream item queue. Saturation cancels only that stream.
pub const CLIENT_STREAM_QUEUE_ITEMS: usize = 16;
/// Ordinary writer slots. Reserved controls do not consume these slots.
pub const CLIENT_DATA_QUEUE_FRAMES: usize = 256;
/// Reserved pure-header Pong, Cancel, and Goodbye slots.
pub const CLIENT_CONTROL_QUEUE_FRAMES: usize = 32;
/// Shared queued-byte cap charged by both ordinary and reserved control frames.
pub const CLIENT_QUEUED_BYTES: usize = MAX_BODY_LEN as usize + 1_048_576;
/// Owner-wide bytes retained in pending stream queues.
pub const CLIENT_RETAINED_RESPONSE_BYTES: usize = MAX_BODY_LEN as usize + 1_048_576;

const NEGOTIATION_CORRELATION: u64 = 1;
const FIRST_APPLICATION_CORRELATION: u64 = 2;
const MAX_ERROR_CODE_BYTES: usize = 128;
const MAX_ERROR_MESSAGE_BYTES: usize = 512;

/// Exact send-outcome classifications used by recovery policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendOutcome {
    /// Request bytes provably never reached the writer.
    NotSent,
    /// Some request bytes may have reached the peer without a terminal.
    OutcomeUnknown,
    /// Matching host terminal was observed.
    Terminal,
}

impl SendOutcome {
    /// Stable spelling used by cross-language recovery policy.
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

/// Managed call failure. Formatting never includes payload or identity data.
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
        // Peer text may echo a request, credential, or identity. Preserve the
        // stable code but never retain the raw terminal message.
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

    /// Stable bounded error code.
    pub fn code(&self) -> &str {
        &self.code
    }

    /// Bounded redacted message.
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

/// Discovery, authentication, negotiation, or owner-lifecycle failure.
#[derive(Clone, PartialEq, Eq)]
pub struct ClientError {
    code: &'static str,
    message: &'static str,
}

impl ClientError {
    fn new(code: &'static str, message: &'static str) -> Self {
        Self { code, message }
    }

    /// Stable failure code.
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

/// One successful unary response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Response {
    /// Response bytes. The client does not interpret application payloads.
    pub body: Vec<u8>,
    /// Whether the host marked the body as binary.
    pub binary: bool,
}

/// One ordered streaming response item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamItem {
    /// Item bytes.
    pub body: Vec<u8>,
    /// Whether the host marked the item as binary.
    pub binary: bool,
}

/// Per-request deadline and cancellation controls.
#[derive(Debug, Clone)]
pub struct RequestOptions {
    /// Total operation budget. Queueing, publication, and terminal wait share it.
    pub timeout: Duration,
    /// Optional caller cancellation token.
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

/// Managed connection to one authenticated daemon generation.
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
    /// Securely discovers, authenticates, and negotiates one TCP generation.
    ///
    /// Discovery validates one descriptor-anchored snapshot before any dial.
    pub async fn connect(path: impl AsRef<Path>) -> Result<Self, ClientError> {
        // The deadline starts before discovery, not after it. §11.2 spends one
        // 2-second budget on discovery, dial, authentication, and negotiation
        // together, so starting the clock after the snapshot would give a
        // stalled filesystem unbounded time and then hand the handshake a fresh
        // budget. The snapshot also runs on a blocking pool: it is synchronous
        // filesystem work, and on a wedged mount it would otherwise occupy an
        // async worker for as long as the mount takes.
        let deadline = Instant::now() + CLIENT_HANDSHAKE_TIMEOUT;
        let path = path.as_ref().to_path_buf();
        let info = timeout_at(
            deadline,
            tokio::task::spawn_blocking(move || read_for_client(path)),
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
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(ClientError::new(
                "handshake_timeout",
                "client handshake timed out",
            ));
        }
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
            closed: AtomicBool::new(false),
            retired: AtomicBool::new(false),
            cancel: CancellationToken::new(),
            correlations: Mutex::new(Correlations::new(FIRST_APPLICATION_CORRELATION)),
            admission: Mutex::new(()),
            pending: Mutex::new(HashMap::new()),
            streams: Mutex::new(0),
            routes: Mutex::new(HashSet::new()),
            queue_budget: Arc::new(ByteCounter::new(CLIENT_QUEUED_BYTES)),
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
            reader_loop(reader_inner, read).await;
        });
        *inner.writer.lock().await = Some(writer);
        *inner.reader.lock().await = Some(reader);
        // The reader runs on another worker and can retire this generation
        // before the constructor returns — a peer that closes or sends
        // connection `Goodbye` right after negotiation does exactly that.
        // Returning a "ready" client then defers the failure to the first
        // operation, which reports `connection_retired` as `NotSent`; the
        // historian does not reconnect on that path, so a daemon reload race
        // would abort the run instead of establishing a replacement.
        if inner.retired.load(Ordering::Acquire) {
            return Err(ClientError::new(
                "connection_retired",
                "connection retired during setup",
            ));
        }
        Ok(Self { inner })
    }

    /// Authenticated daemon ID from the secure discovery and proof transcript.
    pub fn daemon_id(&self) -> [u8; DAEMON_ID_LEN] {
        self.inner.daemon_id
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
                    let handle = parse_route_open(&response.body)?;
                    // Publish under the same lock `close` drains, and recheck
                    // closure while holding it. A close that lands between the
                    // response arriving and this insert would otherwise leave a
                    // handle in a drained set and hand the caller an `Ok` that
                    // fails `client_closed` on first use. Local close wins
                    // (protocol §11.1). The host side needs no route `Goodbye`
                    // here: `close` sends the connection `Goodbye`, which
                    // obliges the host to settle every route on the generation.
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

    /// Sends one unary request. The body is never replayed.
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

    /// Starts one bounded streaming request.
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

    /// Rejects new work, closes routes, settles pending calls, and joins I/O tasks.
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

/// Consumer for one bounded stream. Dropping it emits a best-effort Cancel.
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
    /// Correlation used by this stream.
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

struct PendingState {
    publish: Arc<AtomicU8>,
    kind: PendingKind,
}

enum PendingKind {
    Unary(oneshot::Sender<Result<Response, CallError>>),
    Stream {
        items: mpsc::Sender<ChargedItem>,
        terminal: oneshot::Sender<Result<(), CallError>>,
        /// Retires the detached deadline watcher when this entry is dropped, so
        /// the watcher cannot outlive the stream by up to the caller's whole
        /// timeout. A guard rather than a bare token because settlement has
        /// several sites - the terminal-frame branch in `dispatch` settles the
        /// caller directly without `finish_pending` - and dropping the entry is
        /// the one thing every path, present or future, already does.
        _settled: DropGuard,
    },
}

struct Inner {
    daemon_id: [u8; DAEMON_ID_LEN],
    closed: AtomicBool,
    retired: AtomicBool,
    cancel: CancellationToken,
    correlations: Mutex<Correlations>,
    admission: Mutex<()>,
    pending: Mutex<HashMap<PendingKey, PendingState>>,
    streams: Mutex<usize>,
    routes: Mutex<HashSet<RouteHandle>>,
    queue_budget: Arc<ByteCounter>,
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
        // A token cancelled before the call must not enqueue anything. The
        // `select!` below is biased toward cancellation, but admission has
        // already handed the frame to the writer, which can claim it on another
        // worker before this task reaches the select.
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
        let (key, publish) = self.admit(route, body, PendingKind::Unary(tx), deadline)?;
        let mut guard = UnaryAdmissionGuard::new(Arc::clone(self), key);
        let cancelled = cancellation.unwrap_or_default();
        let result = tokio::select! {
            biased;
            result = rx => result.unwrap_or_else(|_| Err(retired_error(classify(&publish)))),
            () = cancelled.cancelled() => {
                let outcome = self.cancel_key(key, "cancelled").err().map_or_else(|| classify(&publish), |error| error.outcome);
                Err(CallError::local(outcome, "cancelled", "request was cancelled"))
            }
            () = tokio::time::sleep_until(deadline) => {
                let outcome = self.cancel_key(key, "deadline_expired").err().map_or_else(|| classify(&publish), |error| error.outcome);
                Err(CallError::local(outcome, "deadline_expired", "request deadline expired"))
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
        // A token cancelled before the call must not enqueue anything: the
        // watcher is spawned after admission, so the writer could otherwise
        // claim and transmit a side-effecting request before the first cancel
        // observation. A token cancelled after this point is the watcher's job.
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
        // A default token is never cancelled, so the absent-cancellation case
        // reduces to a deadline-only watcher without a second spawn shape.
        let cancel = options.cancellation.unwrap_or_default();
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            tokio::select! {
                biased;
                // Settlement first: a stream that already terminated must not
                // issue a cancel on a correlation the host may have reused.
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

    fn cancel_key(&self, key: PendingKey, code: &'static str) -> Result<(), CallError> {
        let state = lock_unpoisoned(&self.pending).remove(&key);
        let Some(state) = state else {
            return Ok(());
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
            // A control request has identity 0/0, and §6.2 requires `Cancel` on
            // a current nonzero route with a pending nonzero correlation — so
            // cancelling one has no legal frame. Emitting 0/0 anyway made the
            // host close the generation, taking every unrelated route with it,
            // and left cleanup depending on the peer accepting a malformed
            // frame. The host settles the request on its own deadline instead;
            // the caller's OutcomeUnknown classification is already correct and
            // is what actually protects it from replaying.
            if key.channel == 0 {
                return Ok(());
            }
            // The Cancel is best-effort cleanup, and the request's bytes may
            // already be on the wire. Report the failed enqueue, but keep the
            // request's own OutcomeUnknown classification: substituting the
            // control frame's outcome (NotSent when the generation retires
            // concurrently) would tell the caller a possibly-delivered request
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
        Ok(())
    }

    /// Queues one pure-header control frame.
    ///
    /// `flags` is explicit because a `Pong` must echo the `Ping`'s flags exactly
    /// (conformance vector V35), and §6.1 lets a conforming peer pick any valid
    /// priority - so no single flag byte is correct for every control frame.
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
        let charge = self.queue_budget.charge(bytes.len()).ok_or_else(|| {
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

    fn dispatch(
        self: &Arc<Self>,
        header: EnvelopeHeader,
        body: Vec<u8>,
        charge: Option<ByteCharge>,
    ) {
        match header.ty {
            FrameType::Ping => {
                // V35: the Pong echoes the Ping's flags exactly.
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
                        // Settles the caller directly rather than through
                        // `finish_pending`, so the deadline watcher is retired
                        // by dropping the rest of the entry; see
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
                                SendOutcome::Terminal,
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
                        // An empty item is never charged, so an absent charge
                        // means exhaustion only when there were bytes to
                        // charge for. Reading it as exhaustion either way
                        // retires the generation over a legal zero-length
                        // StreamData: `validate_inbound` requires an empty body
                        // of `StreamEnd` alone.
                        let charge = match charge {
                            Some(charge) => Some(charge),
                            None if header.len == 0 => None,
                            None => {
                                drop(pending);
                                self.retire("response_memory_exhausted");
                                return;
                            }
                        };
                        let item = ChargedItem {
                            body,
                            binary: header.flags.is_binary(),
                            _charge: charge,
                        };
                        if items.try_send(item).is_err() {
                            let state = pending.remove(&key).expect("entry exists");
                            drop(pending);
                            self.finish_pending(
                                state,
                                Err(CallError::local(
                                    SendOutcome::Terminal,
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

    fn finish_pending(&self, state: PendingState, result: Result<Response, CallError>) {
        match state.kind {
            PendingKind::Unary(tx) => {
                let _ = tx.send(result);
            }
            PendingKind::Stream { terminal, .. } => {
                let terminal_result = result.map(|_| ());
                let _ = terminal.send(terminal_result);
                // Dropping the rest of the entry retires the deadline watcher;
                // see `PendingKind::Stream::_settled`.
                self.release_stream();
            }
        }
    }

    fn release_stream(&self) {
        let mut streams = lock_unpoisoned(&self.streams);
        *streams = streams.saturating_sub(1);
    }

    /// Settles every pending request on one route and drops the route.
    ///
    /// Emits no per-correlation `Cancel`. Route `Goodbye` — the frame this
    /// settlement accompanies on close, or the inbound frame that triggered it —
    /// already obliges the host to stop dispatch and settle or cancel that
    /// route's work (protocol §11.2). Sending one `Cancel` per possibly-sent
    /// request would add nothing and can exceed the 32 reserved control slots,
    /// and `send_control` retires the whole generation on overflow: a routine
    /// route teardown carrying more than 32 claimed requests would take down
    /// every unrelated route with it. `settle_all` is silent for the same
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
        // Await each task under the shared deadline rather than polling
        // `is_finished`: a `yield_now` loop re-queues itself every iteration and
        // spins the worker for the whole shutdown budget.
        for slot in [&self.writer, &self.reader] {
            let Some(mut task) = slot.lock().await.take() else {
                continue;
            };
            if tokio::time::timeout_at(deadline, &mut task).await.is_err() {
                within_deadline = false;
                // The timeout means this task never completed, so it is safe to
                // await again after the abort - a completed handle would panic.
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
    /// Absent for a zero-length item, which is never charged.
    _charge: Option<ByteCharge>,
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

async fn reader_loop(inner: Arc<Inner>, mut read: OwnedReadHalf) {
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
    charge: Option<ByteCharge>,
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
    read_exact_until(read, &mut header_bytes[1..], deadline, &inner.cancel).await?;
    let header = decode_header(&header_bytes).map_err(|_| ())?;
    validate_inbound(&header)?;
    let charge = if header.len == 0 {
        None
    } else {
        inner.retained_budget.charge(header.len as usize)
    };
    let mut body = Vec::new();
    if let Some(_charge) = charge.as_ref() {
        body.resize(header.len as usize, 0);
        read_exact_until(read, &mut body, deadline, &inner.cancel).await?;
    } else if header.len > 0 {
        drain_until(read, header.len as usize, deadline, &inner.cancel).await?;
        return Err(());
    }
    Ok(Some(InboundFrame {
        header,
        body,
        charge,
    }))
}

async fn read_exact_until<R: AsyncRead + Unpin>(
    read: &mut R,
    buf: &mut [u8],
    deadline: Instant,
    cancel: &CancellationToken,
) -> Result<(), ()> {
    let mut offset = 0;
    while offset < buf.len() {
        let count = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(()),
            result = timeout_at(deadline, read.read(&mut buf[offset..])) => result.map_err(|_| ())?.map_err(|_| ())?,
        };
        if count == 0 {
            return Err(());
        }
        offset += count;
    }
    Ok(())
}

async fn drain_until<R: AsyncRead + Unpin>(
    read: &mut R,
    mut remaining: usize,
    deadline: Instant,
    cancel: &CancellationToken,
) -> Result<(), ()> {
    let mut scratch = [0u8; 8192];
    while remaining > 0 {
        let take = remaining.min(scratch.len());
        read_exact_until(read, &mut scratch[..take], deadline, cancel).await?;
        remaining -= take;
    }
    Ok(())
}

/// Turns a caller-supplied timeout into an absolute deadline.
///
/// `Instant + Duration` panics when the sum is unrepresentable, and the timeout
/// is public configuration — `Duration::MAX` is a conventional spelling of "no
/// timeout" — so an out-of-range value must be a typed rejection rather than a
/// crash in the consumer.
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
    // §7.1 caps a channel-0 body at 65,536 bytes even though framing permits
    // more. Rejecting on the header keeps one oversize control response from
    // being allocated and retained at all — `parse_route_open` ignores unknown
    // fields, so a padded response would otherwise open a route and leave the
    // generation live while holding roughly 64 MiB.
    if header.channel == 0 && header.len > MAX_CONTROL_BODY_LEN {
        return Err(());
    }
    match header.ty {
        FrameType::Response | FrameType::Error | FrameType::StreamData | FrameType::StreamEnd => {
            // `decode_header` already rejects a mixed zero/nonzero
            // channel/epoch pair, so the identity is control (0/0) or routed
            // (nonzero/nonzero) by here; only the correlation is left.
            if header.corr == 0 {
                return Err(());
            }
            // The direct profile carries stream termination in the header. A
            // StreamEnd body is structural corruption even though the framing
            // layer does not classify StreamEnd as pure-header, so the
            // pure-header check below never sees it.
            if matches!(header.ty, FrameType::StreamEnd) && header.len != 0 {
                return Err(());
            }
        }
        FrameType::Push => {
            // Push is unsolicited, so a correlation would claim a pending
            // request the frame cannot answer.
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
    // Pure-header frames must set binary 0, last 0, and admission Normal, but
    // §6.1 permits any valid priority — matching the framing layer's own check
    // in `tcp_frame_channel`. Comparing the whole flag byte would retire the
    // generation over a conforming Ping that merely chose Interactive.
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
    let body = serde_json::to_vec(&serde_json::json!({
        "op": "transport.negotiate",
        "negotiation_version": NEGOTIATION_VERSION,
        "offers": [{"transport": TRANSPORT_TCP, "capability_version": 1}]
    }))
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
    // Channel 0 accepts UTF-8 JSON only (§7.1), so a binary setup response is a
    // nonconforming generation even when its body happens to parse.
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
    let offers = [TransportOffer {
        transport: TRANSPORT_TCP.to_owned(),
        capability_version: 1,
        parameters: None,
    }];
    let selection = decode_negotiate_response(&frame.body, &offers).map_err(|_| {
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
    timeout_at(deadline, stream.read_exact(&mut header_bytes))
        .await
        .map_err(|_| ClientError::new("handshake_timeout", "client handshake timed out"))?
        .map_err(|_| ClientError::new("negotiation_failed", "transport negotiation failed"))?;
    let header = decode_header(&header_bytes)
        .map_err(|_| ClientError::new("negotiation_failed", "transport negotiation failed"))?;
    if header.len > MAX_BODY_LEN {
        return Err(ClientError::new(
            "negotiation_failed",
            "transport negotiation failed",
        ));
    }
    let mut body = vec![0u8; header.len as usize];
    timeout_at(deadline, stream.read_exact(&mut body))
        .await
        .map_err(|_| ClientError::new("handshake_timeout", "client handshake timed out"))?
        .map_err(|_| ClientError::new("negotiation_failed", "transport negotiation failed"))?;
    Ok(InboundFrame {
        header,
        body,
        charge: None,
    })
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
    // Present-with-null is not absent: the host reads any present member as
    // `Some(..)`, so a `json!` null would make bind observe facts the caller
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
                closed: AtomicBool::new(false),
                retired: AtomicBool::new(false),
                cancel: CancellationToken::new(),
                correlations: Mutex::new(Correlations::new(FIRST_APPLICATION_CORRELATION)),
                admission: Mutex::new(()),
                pending: Mutex::new(HashMap::new()),
                streams: Mutex::new(0),
                routes: Mutex::new(HashSet::from([route(1), route(2)])),
                queue_budget: Arc::new(ByteCounter::new(queued_bytes)),
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
        // Retire without draining pending, so the best-effort Cancel enqueue
        // fails with the control path's own NotSent classification.
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
        // Both settle shapes must retire the watcher: `cancel_key` funnels
        // through `finish_pending`, while a terminal frame settles the caller
        // directly inside `dispatch`. Only dropping the entry covers both.
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
                None => inner.cancel_key(key, "cancelled").expect("stream settled"),
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
                    None,
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
        // One Cancel per claimed request overruns the 32 reserved control slots,
        // and `send_control` retires the generation on overflow - so a routine
        // route teardown would take every unrelated route with it.
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
            // Claim each request so settlement classifies it possibly-sent,
            // which is the case that used to emit a Cancel.
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

        // Legal control and routed identities stay legal.
        assert!(validate_inbound(&header(FrameType::Response, 0, 0, 7, 4)).is_ok());
        assert!(validate_inbound(&header(FrameType::Response, 3, 9, 7, 4)).is_ok());
        assert!(validate_inbound(&header(FrameType::StreamData, 3, 9, 7, 4)).is_ok());
        assert!(validate_inbound(&header(FrameType::StreamEnd, 3, 9, 7, 0)).is_ok());
        assert!(validate_inbound(&header(FrameType::Push, 3, 9, 0, 4)).is_ok());

        // A routed frame with epoch 0 never decodes, so `validate_inbound` only
        // sees coherent identities (see `wire::decode_header`).
        assert!(validate_inbound(&header(FrameType::Response, 3, 0, 7, 4)).is_ok());

        // The direct profile requires an empty StreamEnd body.
        assert!(validate_inbound(&header(FrameType::StreamEnd, 3, 9, 7, 1)).is_err());

        // Push is unsolicited, so it carries no correlation.
        assert!(validate_inbound(&header(FrameType::Push, 3, 9, 5, 4)).is_err());

        // §7.1 caps a channel-0 body at 65,536 bytes; framing alone permits far
        // more, and an accepted oversize control response would be allocated
        // and retained before anything could reject it.
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

        // Pre-existing rules keep holding.
        assert!(validate_inbound(&header(FrameType::Response, 3, 9, 0, 4)).is_err());
        assert!(validate_inbound(&header(FrameType::Ping, 0, 0, 7, 0)).is_ok());
        assert!(validate_inbound(&header(FrameType::Ping, 1, 0, 7, 0)).is_err());
        assert!(validate_inbound(&header(FrameType::Goodbye, 0, 0, 0, 0)).is_ok());
        assert!(validate_inbound(&header(FrameType::Goodbye, 3, 9, 0, 1)).is_err());
        assert!(validate_inbound(&header(FrameType::Request, 3, 9, 7, 4)).is_err());
    }

    #[tokio::test]
    async fn a_ping_at_any_valid_priority_is_answered_with_an_exact_flag_echo() {
        // §6.1 fixes binary, last, and admission on pure-header frames but lets
        // priority be any valid value, and V35 requires the Pong to echo the
        // Ping's flags exactly.
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

            inner.dispatch(ping, Vec::new(), None);

            let pong = control_rx.recv().await.expect("Pong queued");
            assert_eq!(pong.bytes[5], FrameType::Pong as u8);
            assert_eq!(
                pong.bytes[6], flags.0,
                "the Pong must echo the Ping's flag byte, not the client's default"
            );
            assert!(!inner.retired.load(Ordering::Acquire));
            drop(pong);
        }

        // The mandated bits are still fixed.
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
        // Only `StreamEnd` must be empty, so a zero-length `StreamData` is
        // legal. It carries no charge because there were no bytes to charge
        // for, which must not read as an exhausted budget.
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
            None,
        );

        assert!(
            !inner.retired.load(Ordering::Acquire),
            "an uncharged empty item is not an exhausted budget"
        );
        let item = items_rx.try_recv().expect("the empty item is delivered");
        assert!(item.body.is_empty());
        assert!(lock_unpoisoned(&inner.pending).contains_key(&key));
    }

    #[tokio::test]
    async fn an_out_of_range_timeout_is_rejected_instead_of_panicking() {
        // `Duration::MAX` is a conventional spelling of "no timeout" and is
        // public configuration, so an unrepresentable deadline must be a typed
        // rejection rather than a panic inside the consumer.
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

    #[test]
    fn absent_admission_facts_are_omitted_rather_than_sent_as_null() {
        // The host reads any present member as `Some(..)`, so a null would make
        // bind observe facts the caller never supplied.
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
    async fn data_and_control_charge_one_shared_byte_cap() {
        let (inner, data_rx, control_rx) = test_inner(HEADER_LEN * 2);
        inner
            .send_control(
                FrameType::Pong,
                pure_header_flags(),
                FrameId::control(1),
                None,
            )
            .expect("first header");
        let (kind, _rx) = unary_sender();
        inner
            .admit(
                route(1),
                Vec::new(),
                kind,
                Instant::now() + Duration::from_secs(1),
            )
            .expect("data header uses remaining shared bytes");
        assert_eq!(inner.queue_budget.used(), HEADER_LEN * 2);
        assert!(inner
            .send_control(
                FrameType::Pong,
                pure_header_flags(),
                FrameId::control(2),
                None
            )
            .is_err());
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
            None,
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
                Some(charge),
            );
        }
        let error = terminal_rx
            .await
            .expect("terminal sender")
            .expect_err("saturated stream fails");
        assert_eq!(error.code(), "stream_saturated");
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
            None,
        );
        assert!(unary_rx.try_recv().expect("unary settled").is_ok());
        assert!(lock_unpoisoned(&inner.pending).is_empty());
        inner.retire("test_done");
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
