//! Host runtime composition: startup order, admission, health, and shutdown.
//!
//! Signal acquisition stays outside this crate: the caller supplies a
//! `CancellationToken`; future production wiring in `magic-context-c50.4`
//! will map SIGINT/SIGTERM, while tests inject deterministic shutdown.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex};

use tokio::net::TcpListener;
use tokio::sync::Semaphore;
use tokio::task::{AbortHandle, JoinHandle};
use tokio::time::{timeout, timeout_at, Instant};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::config::{HostConfig, HostLimits, HostTiming, LivenessPolicy};
use crate::connection::{run_connection, GenerationCore};
use crate::dispatch::{close_route, force_close_all_routes, send_connection_goodbye};
use crate::handler::{ManifestSnapshot, McHostHandler};
use crate::instance::{ConnectionKey, InstanceError, InstanceGuard};
use crate::routing::RouteRegistry;
use crate::wire::ByteBudget;

/// Why the host did not complete a graceful run.
#[derive(Debug)]
pub enum HostError {
    Config(crate::config::ConfigError),
    Instance(InstanceError),
    /// Startup validation or handler initialization failed; nothing was
    /// published.
    InitFailed(String),
    /// A lifecycle callback (bind, route-gone, health) panicked or overran its
    /// deadline. The process must terminate; shutdown was not graceful.
    LifecycleFatal(String),
    /// Host tasks could not be reaped within the shutdown deadline even after
    /// aborts. Not a graceful shutdown.
    ShutdownDeadlineExpired,
    Io(std::io::Error),
}

impl std::fmt::Display for HostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Config(err) => write!(f, "invalid host configuration: {err}"),
            Self::Instance(err) => write!(f, "instance startup failed: {err}"),
            Self::InitFailed(msg) => write!(f, "handler initialization failed: {msg}"),
            Self::LifecycleFatal(msg) => write!(f, "fatal lifecycle callback failure: {msg}"),
            Self::ShutdownDeadlineExpired => {
                write!(f, "shutdown deadline expired before host tasks were reaped")
            }
            Self::Io(err) => write!(f, "host I/O failure: {err}"),
        }
    }
}

impl std::error::Error for HostError {}

/// First-failure latch for host-fatal lifecycle errors. Tripping it cancels
/// the shutdown token so the whole host unwinds (plan KTD9).
pub struct FatalCell {
    message: Mutex<Option<String>>,
}

impl FatalCell {
    fn new() -> Self {
        Self {
            message: Mutex::new(None),
        }
    }

    pub fn trip(&self, shutdown: &CancellationToken, message: String) {
        let mut slot = self.message.lock().expect("fatal lock");
        if slot.is_none() {
            *slot = Some(message);
        }
        drop(slot);
        shutdown.cancel();
    }

    fn take(&self) -> Option<String> {
        self.message.lock().expect("fatal lock").take()
    }
}

/// Everything host tasks share. Generic over the linked handler so callback
/// futures stay statically dispatched.
pub struct HostShared<H> {
    pub handler: Arc<H>,
    pub limits: HostLimits,
    pub timing: HostTiming,
    pub liveness: Option<LivenessPolicy>,
    pub manifest: ManifestSnapshot,
    pub catalog: crate::control::CatalogCache,
    pub registry: RouteRegistry,
    pub ingress_budget: ByteBudget,
    pub egress_budget: ByteBudget,
    pub pending_permits: Arc<Semaphore>,
    pub task_permits: Arc<Semaphore>,
    pub handshake_permits: Arc<Semaphore>,
    pub connection_permits: Arc<Semaphore>,
    pub tracker: TaskTracker,
    abort_handles: Mutex<Vec<AbortHandle>>,
    pub shutdown: CancellationToken,
    pub draining: AtomicBool,
    pub fatal: FatalCell,
    pub gen_counter: AtomicU64,
    pub connections: Mutex<HashMap<u64, Arc<GenerationCore>>>,
    pub auth_key: ConnectionKey,
    pub daemon_id: [u8; 16],
    pub daemon_ver: String,
}

impl<H: McHostHandler> HostShared<H> {
    /// Spawns onto the host task tracker, retaining an abort handle so the
    /// forced shutdown path can reap tasks the graceful drain missed.
    pub fn spawn_tracked<F>(&self, future: F) -> JoinHandle<F::Output>
    where
        F: std::future::Future + Send + 'static,
        F::Output: Send + 'static,
    {
        let handle = self.tracker.spawn(future);
        let mut aborts = self.abort_handles.lock().expect("abort lock");
        aborts.retain(|h| !h.is_finished());
        aborts.push(handle.abort_handle());
        handle
    }

    /// Spawns a lifecycle-callback task onto the tracker WITHOUT retaining an
    /// abort handle: the forced shutdown path's `abort_all` must never cancel
    /// an in-progress lifecycle callback (route-gone runs exactly once and
    /// completes before handler drop). The spawned future must bound itself
    /// with `lifecycle_callback_deadline`.
    pub fn spawn_lifecycle<F>(&self, future: F) -> JoinHandle<F::Output>
    where
        F: std::future::Future + Send + 'static,
        F::Output: Send + 'static,
    {
        self.tracker.spawn(future)
    }

    /// Joins a lifecycle callback task under the lifecycle deadline. Panic or
    /// overrun trips the fatal latch; the host must terminate rather than
    /// report graceful completion (plan KTD9).
    pub async fn lifecycle_join<T>(
        &self,
        what: &'static str,
        mut task: JoinHandle<T>,
    ) -> Result<T, ()> {
        match timeout(self.timing.lifecycle_callback_deadline, &mut task).await {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(join_err)) => {
                let kind = if join_err.is_panic() {
                    "panicked"
                } else {
                    "was aborted"
                };
                self.fatal
                    .trip(&self.shutdown, format!("{what} callback {kind}"));
                Err(())
            }
            Err(_) => {
                task.abort();
                let _ = task.await;
                self.fatal
                    .trip(&self.shutdown, format!("{what} callback deadline expired"));
                Err(())
            }
        }
    }

    fn abort_all(&self) {
        for handle in self.abort_handles.lock().expect("abort lock").iter() {
            handle.abort();
        }
    }
}

/// Cancels host work if the `run` future is dropped instead of completing:
/// `TaskTracker` does not abort tracked tasks on drop, so a supervisor that
/// aborts `run` would otherwise leave the health loop and authenticated
/// connections serving indefinitely while the instance lock frees for a
/// successor. The guard owns the `InstanceGuard`, and forced cleanup —
/// exactly-once route-gone before handler drop, publication removal and lock
/// release last — runs on a spawned task the abandoned future no longer has
/// to poll. Normal completion disarms it.
struct AbandonGuard<H: McHostHandler> {
    inner: Option<(Arc<HostShared<H>>, InstanceGuard)>,
}

impl<H: McHostHandler> AbandonGuard<H> {
    fn guard_mut(&mut self) -> &mut InstanceGuard {
        &mut self.inner.as_mut().expect("armed abandon guard").1
    }

    /// Normal completion: hand the instance guard back for the ordered
    /// handler-then-lock drop.
    fn disarm(mut self) -> InstanceGuard {
        self.inner.take().expect("armed abandon guard").1
    }
}

impl<H: McHostHandler> Drop for AbandonGuard<H> {
    fn drop(&mut self) {
        let Some((shared, guard)) = self.inner.take() else {
            return;
        };
        shared.shutdown.cancel();
        for gen in shared
            .connections
            .lock()
            .expect("connections lock")
            .values()
        {
            gen.read_cancel.cancel();
            gen.shutdown_complete.cancel();
            gen.token.cancel();
        }
        shared.abort_all();
        // Route cleanup is async (route-gone callbacks must run before the
        // handler drops), so the guard moves into the cleanup task and drops
        // last — the lock and publication release only after handler-visible
        // routes got their exactly-once route-gone. Without a runtime the
        // process is tearing down and the lock dies with it; the guard's own
        // Drop still removes the publication.
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                force_close_all_routes(&shared).await;
                shared.tracker.close();
                let lifecycle_chain = shared.timing.lifecycle_callback_deadline.saturating_mul(2);
                let _ = timeout(lifecycle_chain, shared.tracker.wait()).await;
                drop(shared);
                drop(guard);
            });
        }
    }
}

/// Runs one host incarnation to completion.
///
/// Startup follows the protocol order (§8.1): lock and credentials, handler
/// initialization, listener bind, publication, then admission. The function
/// returns after shutdown has drained (or fatally failed); the instance lock
/// releases when the guard drops at the end — after the handler.
pub async fn run<H: McHostHandler>(
    handler: H,
    config: HostConfig,
    shutdown: CancellationToken,
) -> Result<(), HostError> {
    crate::panic_boundary::install();
    config.validate().map_err(HostError::Config)?;
    let mut guard =
        InstanceGuard::acquire(config.data_dir.as_deref()).map_err(HostError::Instance)?;

    let handler = Arc::new(handler);
    let manifest = crate::panic_boundary::redact_sync(|| handler.manifest());
    let catalog = crate::control::CatalogCache::new(&manifest);
    if catalog.max_body_len() > crate::wire::MAX_BODY_LEN as usize {
        return Err(HostError::InitFailed(
            "linked manifest exceeds the frame limit".to_owned(),
        ));
    }
    // `route.open` admits only manifest-supported roles (protocol §7.2); a
    // manifest without the tool_provider role would publish a catalog that
    // says the role is unavailable while route admission still accepted it.
    if !manifest.provides.iter().any(|entry| {
        entry.get("role").and_then(|role| role.as_str())
            == Some(crate::control::TARGET_KIND_TOOL_PROVIDER)
    }) {
        return Err(HostError::InitFailed(
            "linked manifest does not advertise a tool_provider role".to_owned(),
        ));
    }
    // The module ID must satisfy the same bounds route.open enforces on the
    // client-supplied target, or the catalog advertises a module no request
    // can name.
    if let Err(err) = crate::control::validate_manifest_module_id(&manifest.module_id) {
        return Err(HostError::InitFailed(err));
    }

    // Initialization runs exactly once, before bind; failure or deadline
    // overrun prevents publication entirely (protocol §8.1). Abort-on-drop:
    // if this `run` future is dropped mid-initialize, the callback must not
    // keep running after the instance lock frees for a successor.
    {
        let handler = Arc::clone(&handler);
        let init = config.init.clone();
        let mut init_task = tokio_util::task::AbortOnDropHandle::new(tokio::spawn(async move {
            let callback = crate::panic_boundary::redact_sync(|| handler.initialize(init));
            crate::panic_boundary::redact(callback).await
        }));
        match timeout(config.timing.lifecycle_callback_deadline, &mut init_task).await {
            Ok(Ok(Ok(()))) => {}
            Ok(Ok(Err(err))) => return Err(HostError::InitFailed(err.0)),
            Ok(Err(join_err)) => {
                let kind = if join_err.is_panic() {
                    "panic"
                } else {
                    "abort"
                };
                return Err(HostError::InitFailed(format!("initialize {kind}")));
            }
            Err(_) => {
                init_task.abort();
                let _ = (&mut init_task).await;
                return Err(HostError::InitFailed(
                    "initialize deadline expired".to_owned(),
                ));
            }
        }
    }

    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(HostError::Io)?;
    let port = listener.local_addr().map_err(HostError::Io)?.port();

    let auth_key = ConnectionKey(*guard.key().bytes());
    let daemon_id = *guard.daemon_id();
    guard
        .publish(port, &config.daemon_ver)
        .map_err(HostError::Instance)?;

    let shared = Arc::new(HostShared {
        handler,
        limits: config.limits.clone(),
        timing: config.timing.clone(),
        liveness: config.liveness.clone(),
        manifest,
        catalog,
        registry: RouteRegistry::new(config.limits.max_routes),
        ingress_budget: ByteBudget::new(
            config.limits.max_resident_bytes - crate::config::EGRESS_RESERVED_BYTES,
        ),
        egress_budget: ByteBudget::new(crate::config::EGRESS_RESERVED_BYTES),
        pending_permits: Arc::new(Semaphore::new(config.limits.max_pending_requests)),
        task_permits: Arc::new(Semaphore::new(config.limits.max_handler_tasks)),
        handshake_permits: Arc::new(Semaphore::new(config.limits.max_handshakes)),
        connection_permits: Arc::new(Semaphore::new(config.limits.max_connections)),
        tracker: TaskTracker::new(),
        abort_handles: Mutex::new(Vec::new()),
        shutdown: shutdown.clone(),
        draining: AtomicBool::new(false),
        fatal: FatalCell::new(),
        gen_counter: AtomicU64::new(1),
        connections: Mutex::new(HashMap::new()),
        auth_key,
        daemon_id,
        daemon_ver: config.daemon_ver.clone(),
    });

    let mut abandon_guard = AbandonGuard {
        inner: Some((Arc::clone(&shared), guard)),
    };
    spawn_health_task(&shared);
    accept_loop(&shared, listener).await;
    let graceful = shutdown_sequence(&shared, abandon_guard.guard_mut()).await;
    let guard = abandon_guard.disarm();

    // Handler drop precedes lock release: `shared` holds the last handler Arc
    // once the tracker has drained, and `guard` drops after it (protocol §12
    // steps 6-8).
    let fatal = shared.fatal.take();
    drop(shared);
    drop(guard);

    if let Some(message) = fatal {
        return Err(HostError::LifecycleFatal(message));
    }
    if !graceful {
        return Err(HostError::ShutdownDeadlineExpired);
    }
    Ok(())
}

/// Delay before retrying a failed `accept()`, preventing a tight error loop
/// when the listener stays ready under persistent resource exhaustion.
const ACCEPT_ERROR_BACKOFF: std::time::Duration = std::time::Duration::from_millis(100);

/// Accepts sockets until shutdown. Each accept result is synchronously
/// registered with the task tracker before the next await — the
/// accepted-socket linearization point — so shutdown always finds and closes
/// it (plan KTD10).
async fn accept_loop<H: McHostHandler>(shared: &Arc<HostShared<H>>, listener: TcpListener) {
    loop {
        let accepted = tokio::select! {
            biased;
            () = shared.shutdown.cancelled() => return,
            accepted = listener.accept() => accepted,
        };
        let Ok((stream, _addr)) = accepted else {
            // Resource errors (EMFILE/ENFILE) leave the listener permanently
            // ready; retrying without delay would spin a core. Backoff keeps
            // the loop bounded while remaining responsive to shutdown.
            tokio::select! {
                biased;
                () = shared.shutdown.cancelled() => return,
                () = tokio::time::sleep(ACCEPT_ERROR_BACKOFF) => {}
            }
            continue;
        };
        // Bounded unauthenticated work: no permit means close without reading
        // a single client byte (protocol §5.1, V11).
        let Ok(permit) = shared.handshake_permits.clone().try_acquire_owned() else {
            drop(stream);
            continue;
        };
        let shared_conn = Arc::clone(shared);
        shared.spawn_tracked(async move {
            run_connection(shared_conn, stream, permit).await;
        });
    }
}

/// Dedicated internal health probe: never a routed request, never a client
/// JSON operation (protocol §9.3). Callback failure is host-fatal.
fn spawn_health_task<H: McHostHandler>(shared: &Arc<HostShared<H>>) {
    let shared = Arc::clone(shared);
    let shared_outer = Arc::clone(&shared);
    shared_outer.spawn_tracked(async move {
        loop {
            tokio::select! {
                () = shared.shutdown.cancelled() => return,
                () = tokio::time::sleep(shared.timing.health_interval) => {}
            }
            let handler = Arc::clone(&shared.handler);
            let deadline = shared.timing.lifecycle_callback_deadline;
            let watchdog = Arc::clone(&shared);
            // Abort-exempt and self-bounded like the other lifecycle
            // callbacks: `abort_all` on the forced path must not turn an
            // in-flight healthy probe into a spurious LifecycleFatal, and
            // the internal deadline keeps the probe bounded even if this
            // joining loop is aborted.
            let probe = shared.spawn_lifecycle(async move {
                let callback = crate::panic_boundary::redact_sync(|| handler.health());
                match timeout(deadline, crate::panic_boundary::redact(callback)).await {
                    Ok(report) => Some(report),
                    Err(_) => {
                        watchdog.fatal.trip(
                            &watchdog.shutdown,
                            "health callback deadline expired".to_owned(),
                        );
                        None
                    }
                }
            });
            // The report itself is informational; degraded storage must not
            // make transport unready (protocol §8.1, AE9).
            if shared.lifecycle_join("health", probe).await.is_err() {
                return;
            }
        }
    });
}

/// Graceful shutdown in protocol order (§12). Returns whether every host task
/// was reaped in time.
async fn shutdown_sequence<H: McHostHandler>(
    shared: &Arc<HostShared<H>>,
    guard: &mut InstanceGuard,
) -> bool {
    let deadline = Instant::now() + shared.timing.shutdown_deadline;

    // 1. Freeze admission: accepts already stopped (accept_loop returned);
    // route opens and new routed dispatch observe `draining`.
    shared
        .draining
        .store(true, std::sync::atomic::Ordering::SeqCst);
    shared.registry.freeze_admission();

    // 2. Fenced publication removal while the lock is held.
    guard.remove_publication();

    // 3-5. Drain every route while read loops remain available to reject work
    // arriving during the frozen-admission window. Once route cleanup is
    // complete, fence and join read-side producers; connection Goodbyes are
    // queued only after neither producer class can enqueue another frame.
    let drain = async {
        for handle in shared.registry.all_routes() {
            close_route(shared, handle).await;
        }

        let generations: Vec<Arc<GenerationCore>> = shared
            .connections
            .lock()
            .expect("connections lock")
            .values()
            .cloned()
            .collect();

        for gen in &generations {
            gen.read_cancel.cancel();
            gen.read_tasks.close();
        }
        for gen in &generations {
            gen.read_tasks.wait().await;
        }

        for gen in &generations {
            send_connection_goodbye(gen).await;
        }
        for gen in &generations {
            gen.token.cancel();
        }
        for gen in &generations {
            gen.shutdown_complete.cancel();
        }
    };
    let drained_in_time = timeout_at(deadline, drain).await.is_ok();

    if !drained_in_time {
        // Forced path: abort tasks but preserve exactly-once route-gone and
        // handler-drop ordering (protocol §12 forced shutdown).
        shared.abort_all();
        force_close_all_routes(shared).await;
    }

    // 6-7. Task-producer closure: accepts, read loops, and dispatch loops are
    // all stopped or cancelled, so closing the tracker cannot race a late
    // producer (plan KTD10). Sockets close as connection tasks exit.
    shared.shutdown.cancel();
    shared.tracker.close();
    if timeout_at(deadline, shared.tracker.wait()).await.is_err() {
        shared.abort_all();
        force_close_all_routes(shared).await;
        // Abort-exempt lifecycle work self-bounds: a bind wrapper chains two
        // callbacks (bind, then route-gone), each capped at
        // lifecycle_callback_deadline. Wait out that chain before returning:
        // `run` releases the instance lock when it returns, and releasing it
        // while a callback still owns the handler would let a successor start
        // against the predecessor's in-flight cleanup.
        let lifecycle_chain = shared.timing.lifecycle_callback_deadline.saturating_mul(2);
        let _ = timeout(lifecycle_chain, shared.tracker.wait()).await;
        return false;
    }
    drained_in_time
}
