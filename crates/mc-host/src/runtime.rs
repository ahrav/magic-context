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
use crate::dispatch::{
    finish_route_close, force_close_all_routes, send_connection_goodbye, settle_route,
};
use crate::handler::{McHostHandler, TargetKind};
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
    pub targets: crate::control::TargetIndex,
    pub catalog: crate::control::CatalogCache,
    pub registry: RouteRegistry,
    pub ingress_budget: ByteBudget,
    pub egress_budget: ByteBudget,
    pub pending_permits: Arc<Semaphore>,
    pub task_permits: Arc<Semaphore>,
    pub handshake_permits: Arc<Semaphore>,
    pub connection_permits: Arc<Semaphore>,
    pub tracker: TaskTracker,
    abort_handles: Mutex<AbortRegistry>,
    /// One-shot latch for the handler shutdown callback: the abandon-path
    /// cleanup can run after a `run` future was dropped with the graceful
    /// path's callback task already spawned and still executing, and a second
    /// spawn would overlap the handler's shutdown with itself.
    shutdown_callback_ran: AtomicBool,
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
        let mut registry = self.abort_handles.lock().expect("abort lock");
        registry.prune_and_push(handle.abort_handle());
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
    ///
    /// The error distinguishes a callback that STOPPED (panicked or aborted,
    /// so its handle is dead) from one that did not (deadline expired while a
    /// non-yielding poll continues). Cleanup that would let another party
    /// touch the same route — route-gone, finalize, channel reuse — may only
    /// proceed in the former case.
    pub async fn lifecycle_join<T>(
        &self,
        what: &'static str,
        mut task: JoinHandle<T>,
    ) -> Result<T, LifecycleFailure> {
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
                Err(LifecycleFailure { stopped: true })
            }
            Err(_) => {
                // Abort is only observed when the callback's current poll
                // returns, so joining here could block forever on a
                // non-yielding future — the very case the deadline exists to
                // escape. Request the abort, trip the latch, and return; the
                // detached task is reaped by the tracker wait, which is
                // itself bounded.
                task.abort();
                self.fatal
                    .trip(&self.shutdown, format!("{what} callback deadline expired"));
                Err(LifecycleFailure { stopped: false })
            }
        }
    }

    fn abort_all(&self) {
        for handle in self
            .abort_handles
            .lock()
            .expect("abort lock")
            .handles
            .iter()
        {
            handle.abort();
        }
    }
}

/// Pruning at doubling thresholds amortizes cleanup; finished handles remain
/// until a registration reaches `prune_at`.
struct AbortRegistry {
    handles: Vec<AbortHandle>,
    prune_at: usize,
}

const ABORT_PRUNE_FLOOR: usize = 64;

impl AbortRegistry {
    fn new() -> Self {
        Self {
            handles: Vec::new(),
            prune_at: ABORT_PRUNE_FLOOR,
        }
    }

    fn prune_and_push(&mut self, handle: AbortHandle) {
        if self.handles.len() >= self.prune_at {
            self.handles.retain(|h| !h.is_finished());
            self.prune_at = (self.handles.len() * 2).max(ABORT_PRUNE_FLOOR);
        }
        self.handles.push(handle);
    }
}

/// Keeps the instance lock held until every tracked task — including
/// abort-exempt lifecycle callbacks that still own the handler — has finished,
/// without blocking `run`'s return. The wait is deliberately unbounded: while
/// such a callback runs, a successor acquiring the same data directory would
/// initialize concurrently with live predecessor code, and the lock dies with
/// the process anyway, so holding it is the truthful answer.
fn retain_lock_until_drained<H: McHostHandler>(shared: Arc<HostShared<H>>, guard: InstanceGuard) {
    if let Ok(runtime) = tokio::runtime::Handle::try_current() {
        runtime.spawn(async move {
            // The tracker is already closed by the shutdown sequence.
            shared.tracker.wait().await;
            drop(shared);
            drop(guard);
        });
    }
}

/// Keeps the instance lock held until an aborted initialization task actually
/// stops, then runs the handler shutdown callback, without blocking `run`'s
/// return. The lock is the single-instance fence: releasing it while the old
/// callback still owns the handler and its storage descriptor would let a
/// successor initialize the same data directory concurrently. A successor
/// meanwhile observes `AlreadyRunning`, which is the truthful answer while
/// that callback runs.
///
/// The shutdown callback runs even though initialization never completed: an
/// interrupted initialize can already have handed work to component-owned
/// trackers (blocking bundle loads, native inference), and only `shutdown`
/// stops and drains those, so skipping it would release the fence beside
/// live component work. Handler shutdown callbacks are therefore drain-shaped
/// and state-independent — they must tolerate running against a handler whose
/// initialize was interrupted. Both awaits are deliberately unbounded, for
/// the same reason `retain_lock_until_drained`'s wait is: a bound that drops
/// the guard anyway would release the fence while handler code still runs,
/// and the lock dies with the process regardless.
fn retain_lock_until_stopped<H: McHostHandler, T: Send + 'static>(
    guard: InstanceGuard,
    handler: Arc<H>,
    task: tokio_util::task::AbortOnDropHandle<T>,
) {
    if let Ok(runtime) = tokio::runtime::Handle::try_current() {
        runtime.spawn(async move {
            let _ = task.await;
            let callback = crate::panic_boundary::redact_sync(|| handler.shutdown());
            crate::panic_boundary::redact(callback).await;
            drop(handler);
            drop(guard);
        });
    }
}

/// Why a lifecycle callback did not produce a value, and whether it has
/// actually stopped running.
pub struct LifecycleFailure {
    /// `false` means the callback is still executing (its deadline expired
    /// inside a non-yielding poll, which `abort` cannot interrupt), so no
    /// caller may advance cleanup for the same object.
    pub stopped: bool,
}

/// Runs the handler shutdown callback so handler-owned work stops before the
/// caller drops the instance guard. Startup failure paths use this directly:
/// they run after `initialize` but before `HostShared` and `AbandonGuard`
/// exist, so no other owner can drain the handler for them. The await is
/// unbounded for the same reason the lock-retention waits are — returning
/// early would release the fence while handler code still runs.
async fn drain_handler<H: McHostHandler>(handler: &Arc<H>) {
    let callback = crate::panic_boundary::redact_sync(|| handler.shutdown());
    crate::panic_boundary::redact(callback).await;
}

/// Cancels host work if the `run` future is dropped instead of completing:
/// `TaskTracker` does not abort tracked tasks on drop, so a supervisor that
/// aborts `run` would otherwise leave the health loop and authenticated
/// connections serving indefinitely while the instance lock frees for a
/// successor. The guard owns the `InstanceGuard`, and forced cleanup —
/// exactly-once route-gone, then the handler shutdown callback, publication
/// removal and lock release last — runs on a spawned task the abandoned
/// future no longer has to poll. Normal completion disarms it.
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
        let Some((shared, mut guard)) = self.inner.take() else {
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
        // The listener died with the dropped future: unpublish immediately so
        // discovery stops advertising a dead endpoint, instead of waiting out
        // the lifecycle cleanup chain below. Idempotent and fenced.
        guard.remove_publication();
        // Route cleanup is async (route-gone callbacks must run before the
        // handler drops), so the guard moves into the cleanup task and drops
        // last — the lock releases only after handler-visible routes got
        // their exactly-once route-gone. Without a runtime the process is
        // tearing down and the lock dies with it.
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                force_close_all_routes(&shared).await;
                shared.tracker.close();
                // Unbounded, for the same reason the shutdown path is: an
                // abort-exempt callback still executing owns the handler, and
                // releasing the lock beside it would let a successor
                // initialize this data directory concurrently. The lock lives
                // on a descriptor that dies with the process.
                shared.tracker.wait().await;
                // The handler shutdown callback still runs on this abandoned
                // path: component-owned work (queued batch workers, tracked
                // native inference) is only stopped and drained by
                // `shutdown`, so releasing the lock without it would free the
                // fence while such work can still start. Running it after the
                // tracker drained above means it can never overlap a
                // lifecycle callback that still owns the handler; the
                // once-latch inside lets a callback already spawned by the
                // graceful path win instead.
                run_handler_shutdown(&shared).await;
                // The callback task is itself tracked and never aborted; a
                // deadline overrun leaves it running (fatal-latched), and the
                // lock must outlive it.
                shared.tracker.wait().await;
                drop(shared);
                drop(guard);
            });
        }
    }
}

/// Validates the startup manifest set and derives the routable
/// `(module, kind)` pairs, so the published catalog and route admission can
/// never contradict each other.
fn build_target_index(
    manifests: &[crate::handler::ManifestSnapshot],
) -> Result<crate::control::TargetIndex, HostError> {
    if manifests.is_empty() || manifests.len() > 2 {
        return Err(HostError::InitFailed(
            "the static profile requires one or two module manifests".to_owned(),
        ));
    }
    let mut target_entries: Vec<(Box<str>, Vec<TargetKind>)> = Vec::with_capacity(manifests.len());
    for manifest in manifests {
        if let Err(err) = crate::control::validate_manifest_module_id(&manifest.module_id) {
            return Err(HostError::InitFailed(err));
        }
        if target_entries
            .iter()
            .any(|(id, _)| id.as_ref() == manifest.module_id)
        {
            return Err(HostError::InitFailed(
                "duplicate module ID across startup manifests".to_owned(),
            ));
        }
        let mut kinds = Vec::new();
        for entry in &manifest.provides {
            // A published catalog entry whose role can never route would
            // contradict route admission, so startup refuses it.
            let Some(kind) = entry
                .get("role")
                .and_then(|role| role.as_str())
                .and_then(TargetKind::parse)
            else {
                return Err(HostError::InitFailed(
                    "manifest advertises an unsupported role".to_owned(),
                ));
            };
            if kinds.contains(&kind) {
                return Err(HostError::InitFailed(
                    "manifest advertises a duplicate target pair".to_owned(),
                ));
            }
            kinds.push(kind);
        }
        if kinds.is_empty() {
            return Err(HostError::InitFailed(
                "manifest advertises no routable role".to_owned(),
            ));
        }
        target_entries.push((manifest.module_id.clone().into_boxed_str(), kinds));
    }
    Ok(crate::control::TargetIndex::new(target_entries))
}

/// Runs one host incarnation to completion.
///
/// Startup follows the protocol order (§8.1): lock and credentials, handler
/// initialization, listener bind, publication, then admission. The function
/// returns after shutdown has drained (or fatally failed); the instance lock
/// releases when the guard drops at the end — after the handler.
pub async fn run<H: McHostHandler>(
    handler: H,
    mut config: HostConfig,
    shutdown: CancellationToken,
) -> Result<(), HostError> {
    crate::panic_boundary::install();
    config.validate().map_err(HostError::Config)?;
    let mut guard =
        InstanceGuard::acquire(config.data_dir.as_deref()).map_err(HostError::Instance)?;

    let handler = Arc::new(handler);
    let manifests = crate::panic_boundary::redact_sync(|| handler.manifests());
    let targets = build_target_index(&manifests)?;
    // Bounded during serialization, not after: an over-limit manifest must be
    // refused without ever materializing a full copy of its catalog.
    let Ok(catalog) =
        crate::control::CatalogCache::new_bounded(&manifests, crate::wire::MAX_BODY_LEN as usize)
    else {
        return Err(HostError::InitFailed(
            "linked manifest catalog exceeds the frame limit".to_owned(),
        ));
    };
    // The cached catalog stays resident for the whole incarnation outside
    // the byte-budget semaphores; the ingress budget shrinks by it below so
    // total resident bytes still honor max_resident_bytes. That subtraction
    // must leave at least one maximum request body of ingress headroom.
    let catalog_resident = catalog.resident_len() as u64;
    if config.limits.max_resident_bytes
        < crate::config::MIN_RESIDENT_BYTES.saturating_add(catalog_resident)
    {
        return Err(HostError::InitFailed(
            "linked manifest catalog leaves no resident-byte headroom".to_owned(),
        ));
    }

    // Initialization runs exactly once, before bind; failure or deadline
    // overrun prevents publication entirely (protocol §8.1). Abort-on-drop:
    // if this `run` future is dropped mid-initialize, the callback must not
    // keep running after the instance lock frees for a successor.
    {
        let init_handler = Arc::clone(&handler);
        // Taken, not cloned: the storage descriptor can be arbitrarily large
        // and must not stay owned by `config` for the incarnation, outside
        // every byte budget — the handler consumes the only copy.
        let init = std::mem::take(&mut config.init);
        let mut init_task = tokio_util::task::AbortOnDropHandle::new(tokio::spawn(async move {
            let callback = crate::panic_boundary::redact_sync(|| init_handler.initialize(init));
            crate::panic_boundary::redact(callback).await
        }));
        let joined = tokio::select! {
            biased;
            // A shutdown request during initialization must not hold the
            // instance lock for the whole lifecycle deadline.
            () = shutdown.cancelled() => None,
            joined = timeout(config.timing.lifecycle_callback_deadline, &mut init_task) => {
                Some(joined)
            }
        };
        let Some(joined) = joined else {
            // Not joined here: a non-yielding initialize would block this
            // await forever. The lock must still outlive the callback — it
            // owns the handler and the initialization payload, and a
            // successor starting against the same data directory would run a
            // second initialization concurrently — so the guard moves into a
            // detached reaper that waits for the task, runs the handler
            // shutdown callback (draining any component-owned work the
            // interrupted initialize already started), and drops it last.
            init_task.abort();
            retain_lock_until_stopped(guard, Arc::clone(&handler), init_task);
            return Err(HostError::InitFailed(
                "shutdown requested during initialization".to_owned(),
            ));
        };
        match joined {
            Ok(Ok(Ok(()))) => {}
            Ok(Ok(Err(err))) => {
                // A failed initialization can still have left handler-owned
                // work running: a composite's primary may have initialized
                // successfully before its secondary failed, and only the
                // shutdown callback stops it. Awaiting it here keeps the
                // single-instance fence — `guard` drops when this returns —
                // held until the handler is actually idle.
                drain_handler(&handler).await;

                // The handler-authored message can carry data derived from
                // the opaque storage descriptor (credentials, endpoints);
                // startup diagnostics get bounded structure only (V24).
                return Err(HostError::InitFailed(format!(
                    "handler initialization failed ({} bytes of detail redacted)",
                    err.0.len()
                )));
            }
            Ok(Err(join_err)) => {
                // A panic can happen after initialization starts handler-owned
                // work, so it has the same cleanup obligation as a returned
                // initialization error.
                drain_handler(&handler).await;
                let kind = if join_err.is_panic() {
                    "panic"
                } else {
                    "abort"
                };
                return Err(HostError::InitFailed(format!("initialize {kind}")));
            }
            Err(_) => {
                init_task.abort();
                retain_lock_until_stopped(guard, Arc::clone(&handler), init_task);
                return Err(HostError::InitFailed(
                    "initialize deadline expired".to_owned(),
                ));
            }
        }
    }

    // Initialization has run, so every early return from here must drain the
    // handler before `guard` drops: a completed initialize can have opened
    // stores or started handler-owned work, and only the shutdown callback
    // stops it. `AbandonGuard` takes that duty over once it exists, which is
    // why these steps are grouped instead of each returning through `?`.
    let setup = async {
        // Shutdown between initialization and publication: nothing was
        // published and no route work exists, so this is the graceful
        // outcome — the initialized handler still has to be drained.
        if shutdown.is_cancelled() {
            return Ok(None);
        }
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(HostError::Io)?;
        let port = listener.local_addr().map_err(HostError::Io)?.port();
        guard
            .publish(port, &config.daemon_ver)
            .map_err(HostError::Instance)?;
        Ok(Some(listener))
    }
    .await;
    let listener = match setup {
        Ok(Some(listener)) => listener,
        Ok(None) => {
            drain_handler(&handler).await;
            return Ok(());
        }
        Err(err) => {
            drain_handler(&handler).await;
            return Err(err);
        }
    };

    let auth_key = ConnectionKey(*guard.key().bytes());
    let daemon_id = *guard.daemon_id();

    drop(manifests);

    let shared = Arc::new(HostShared {
        handler,
        limits: config.limits.clone(),
        timing: config.timing.clone(),
        liveness: config.liveness.clone(),
        targets,
        catalog,
        registry: RouteRegistry::new(config.limits.max_routes),
        ingress_budget: ByteBudget::new(
            config.limits.max_resident_bytes
                - crate::config::EGRESS_RESERVED_BYTES
                - catalog_resident,
        ),
        egress_budget: ByteBudget::new(crate::config::EGRESS_RESERVED_BYTES),
        pending_permits: Arc::new(Semaphore::new(config.limits.max_pending_requests)),
        task_permits: Arc::new(Semaphore::new(config.limits.max_handler_tasks)),
        handshake_permits: Arc::new(Semaphore::new(config.limits.max_handshakes)),
        connection_permits: Arc::new(Semaphore::new(config.limits.max_connections)),
        tracker: TaskTracker::new(),
        abort_handles: Mutex::new(AbortRegistry::new()),
        shutdown_callback_ran: AtomicBool::new(false),
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
    if graceful {
        drop(shared);
        drop(guard);
    } else {
        // The tracker did not drain, so abort-exempt lifecycle callbacks may
        // still be running and still own the handler. Releasing the lock here
        // would let a successor initialize the same data directory beside
        // them; hand both to a reaper instead and return immediately.
        retain_lock_until_drained(shared, guard);
    }

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
                tokio::select! {
                    biased;
                    // The probe is informational (protocol §9.3): shutdown
                    // cancels it without ceremony, and that cancellation is
                    // not a lifecycle failure — an abort-exempt probe that
                    // ignored shutdown would hold the tracker past the whole
                    // shutdown budget.
                    () = watchdog.shutdown.cancelled() => {}
                    result = timeout(deadline, crate::panic_boundary::redact(callback)) => {
                        if result.is_err() {
                            watchdog.fatal.trip(
                                &watchdog.shutdown,
                                "health callback deadline expired".to_owned(),
                            );
                        }
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

    // 3-5. Settle each route's admitted work (emitting its terminals) and run
    // its route-gone while read loops are still available to refuse work
    // arriving in the frozen-admission window — step 1's `server_busy` duty
    // lasts as long as the host keeps reading, and fencing reads before
    // cleanup would leave nothing to observe it. Only then fence and join
    // read-side producers, so connection Goodbyes are queued after every
    // drain terminal and after neither producer class can enqueue again
    // (step 4's normative requirement).
    let drain = async {
        for handle in shared.registry.all_routes() {
            if settle_route(shared, handle).await {
                finish_route_close(shared, handle).await;
            }
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
        if timeout(lifecycle_chain, shared.tracker.wait())
            .await
            .is_err()
        {
            // A callback outlived the whole chain budget and still owns the
            // handler; running the shutdown callback beside it would overlap
            // two handler callbacks, and the doctrine prefers the fatal latch
            // over overlap (see the forced route close in dispatch). The
            // caller's non-graceful branch keeps the instance fence held
            // until the tracker actually drains.
            shared.fatal.trip(
                &shared.shutdown,
                "lifecycle callback did not stop before handler shutdown".to_owned(),
            );
            return false;
        }
        run_handler_shutdown(shared).await;
        return false;
    }
    run_handler_shutdown(shared).await && drained_in_time
}

/// Runs the handler shutdown callback exactly once, after route cleanup.
/// The callback is never aborted: a deadline overrun trips the fatal latch
/// and returns non-graceful while the still-tracked task keeps running, so
/// the handler stays owned until it actually stops.
async fn run_handler_shutdown<H: McHostHandler>(shared: &Arc<HostShared<H>>) -> bool {
    // First caller wins: the abandon-path cleanup can fire after a `run`
    // future was dropped mid-shutdown-sequence, when this callback's task was
    // already spawned and keeps running detached from the dropped join. A
    // second spawn would break the exactly-once contract; the loser reports
    // non-graceful and the tracker still reaps the winner's task.
    if shared
        .shutdown_callback_ran
        .swap(true, std::sync::atomic::Ordering::SeqCst)
    {
        return false;
    }
    let handler = Arc::clone(&shared.handler);
    let mut task = shared.spawn_lifecycle(async move {
        let callback = crate::panic_boundary::redact_sync(|| handler.shutdown());
        crate::panic_boundary::redact(callback).await;
    });
    match timeout(shared.timing.lifecycle_callback_deadline, &mut task).await {
        Ok(Ok(())) => true,
        Ok(Err(join_err)) => {
            let kind = if join_err.is_panic() {
                "panicked"
            } else {
                "was aborted"
            };
            shared
                .fatal
                .trip(&shared.shutdown, format!("shutdown callback {kind}"));
            false
        }
        Err(_) => {
            shared.fatal.trip(
                &shared.shutdown,
                "shutdown callback deadline expired".to_owned(),
            );
            false
        }
    }
}
