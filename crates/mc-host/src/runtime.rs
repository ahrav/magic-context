//! Host runtime composition: startup order, admission, health, and shutdown.
//!
//! Signal acquisition stays outside this crate: the caller supplies a
//! `CancellationToken`; future production wiring in `magic-context-c50.4`
//! will map SIGINT/SIGTERM, while tests inject deterministic shutdown.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use tokio::net::UnixListener;
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
use crate::handler::{
    HealthReport, HealthStatus, McHostHandler, ResourceDeclaration, RouteClass, TargetKind,
};
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
    /// Last completed sanitized component health snapshot. Authenticated
    /// `host.status` reads this without invoking a lifecycle callback.
    pub health_snapshot: RwLock<HealthReport>,
    pub providers: crate::transport_provider::TransportProviders,
    pub registry: RouteRegistry,
    /// Admits inbound frame bodies. The only budget with a blocking
    /// consumer, so nothing whose lifetime outlives a request may draw on it.
    pub ingress_budget: ByteBudget,
    /// Funds request scratch and request-derived ownership, whose holders can
    /// outlive the request that created them.
    pub scratch_budget: ByteBudget,
    pub egress_budget: ByteBudget,
    /// General-class admission pools: the configured limits minus every
    /// reserved-class declaration, so reserved work can never draw here.
    pub pending_permits: Arc<Semaphore>,
    pub task_permits: Arc<Semaphore>,
    /// Reserved-class admission pools, sized by the checked declaration sums
    /// (plan KTD2). Zero-permit when no module declared a reservation, and
    /// then unreachable because every route is general-class.
    pub reserved_pending_permits: Arc<Semaphore>,
    pub reserved_task_permits: Arc<Semaphore>,
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
    /// `host.shutdown` commit latch shared by every connection (plan KTD4).
    pub shutdown_latch: Arc<crate::lifecycle::ShutdownLatch>,
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
/// then runs handler shutdown and waits for it without blocking `run`'s return.
/// The waits are deliberately unbounded: while either callback runs, a
/// successor acquiring the same data directory would initialize concurrently
/// with live predecessor code, and the lock dies with the process anyway, so
/// holding it is the truthful answer.
fn retain_lock_until_drained<H: McHostHandler>(shared: Arc<HostShared<H>>, guard: InstanceGuard) {
    if let Ok(runtime) = tokio::runtime::Handle::try_current() {
        runtime.spawn(async move {
            // The tracker is already closed by the shutdown sequence.
            shared.tracker.wait().await;
            run_handler_shutdown(&shared).await;
            if let Some(message) = shared.fatal.take() {
                eprintln!("mc-host: deferred handler shutdown failed: {message}");
            }
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
    mut guard: InstanceGuard,
    handler: Arc<H>,
    task: tokio_util::task::AbortOnDropHandle<T>,
) {
    // Teardown is underway: demote the phase so probes report `stopping`
    // (not `starting`) for however long the unbounded drain below runs
    // (protocol §12: every teardown path demotes before cleanup).
    guard.begin_stopping();
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

fn spawn_handler_shutdown<H: McHostHandler>(handler: Arc<H>) -> JoinHandle<()> {
    tokio::spawn(async move {
        let callback = crate::panic_boundary::redact_sync(|| handler.shutdown());
        crate::panic_boundary::redact(callback).await;
    })
}

/// Owns handler shutdown and the instance guard before `HostShared` exists.
/// Shutdown runs in its own task so cancelling the waiter transfers that same
/// task and the guard to a reaper instead of cancelling cleanup or invoking
/// the callback twice. Successful publication disarms the owner without
/// spawning cleanup.
struct PrePublicationCleanup<H: McHostHandler> {
    guard: Option<InstanceGuard>,
    handler: Option<Arc<H>>,
    shutdown: Option<JoinHandle<()>>,
}

impl<H: McHostHandler> PrePublicationCleanup<H> {
    fn new(guard: InstanceGuard, handler: Arc<H>) -> Self {
        Self {
            guard: Some(guard),
            handler: Some(handler),
            shutdown: None,
        }
    }

    fn guard_mut(&mut self) -> &mut InstanceGuard {
        self.guard.as_mut().expect("armed startup cleanup")
    }

    async fn finish(mut self) {
        // Every `finish` is a teardown: demote the phase before the drain so
        // probes report `stopping` rather than a stale `starting` that would
        // expire to `wedged` under a slow handler shutdown (protocol §12).
        if let Some(guard) = self.guard.as_mut() {
            guard.begin_stopping();
        }
        self.shutdown = Some(spawn_handler_shutdown(
            self.handler.take().expect("armed startup cleanup"),
        ));
        let shutdown = self.shutdown.as_mut().expect("started startup cleanup");
        let _ = shutdown.await;
        drop(self.shutdown.take());
        drop(self.guard.take());
    }

    fn disarm(mut self) -> (InstanceGuard, Arc<H>) {
        (
            self.guard.take().expect("armed startup cleanup"),
            self.handler.take().expect("armed startup cleanup"),
        )
    }
}

impl<H: McHostHandler> Drop for PrePublicationCleanup<H> {
    fn drop(&mut self) {
        let Some(mut guard) = self.guard.take() else {
            return;
        };
        // Unwind is a teardown too: same demote-before-drain rule as
        // `finish`.
        guard.begin_stopping();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            let shutdown = self.shutdown.take().unwrap_or_else(|| {
                spawn_handler_shutdown(self.handler.take().expect("armed startup cleanup"))
            });
            runtime.spawn(async move {
                let _ = shutdown.await;
                drop(guard);
            });
        }
    }
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
        // the lifecycle cleanup chain below. Idempotent and fenced. The phase
        // demotion travels with it, so an observer sees `stopping` rather than
        // the `wedged` a publication-less `running` record would report for
        // this path's whole (unbounded) drain.
        guard.begin_stopping();
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

/// Checked sums of every module's reserved admission capacity and retained
/// resident bytes, validated before initialization so the host can never
/// start with impossible accounting (plan KTD2).
struct Reservations {
    pending: usize,
    tasks: usize,
    /// Checked sum of every module's declared bound on concurrently parked
    /// general-class handler tasks. Not a carve-out — validated against the
    /// general task pool so declared parking can never consume every slot.
    general_task_holds: usize,
    retained_bytes: u64,
}

/// Validates the startup manifest set against its resource declarations and
/// derives the routable `(module, kind, class)` entries plus the checked
/// reservation sums, so the published catalog, route admission, and permit
/// accounting can never contradict each other.
fn build_target_index(
    manifests: &[crate::handler::ManifestSnapshot],
    declarations: &[ResourceDeclaration],
) -> Result<(crate::control::TargetIndex, Reservations), HostError> {
    if manifests.is_empty() || manifests.len() > 3 {
        return Err(HostError::InitFailed(
            "the static profile requires one to three module manifests".to_owned(),
        ));
    }
    if declarations.len() != manifests.len() {
        return Err(HostError::InitFailed(
            "resource declarations do not match the manifest set".to_owned(),
        ));
    }
    let mut reservations = Reservations {
        pending: 0,
        tasks: 0,
        general_task_holds: 0,
        retained_bytes: 0,
    };
    let mut target_entries: Vec<(Box<str>, Vec<TargetKind>, RouteClass)> =
        Vec::with_capacity(manifests.len());
    for (manifest, declaration) in manifests.iter().zip(declarations) {
        if let Err(err) = crate::control::validate_manifest_module_id(&manifest.module_id) {
            return Err(HostError::InitFailed(err));
        }
        if target_entries
            .iter()
            .any(|(id, _, _)| id.as_ref() == manifest.module_id)
        {
            return Err(HostError::InitFailed(
                "duplicate module ID across startup manifests".to_owned(),
            ));
        }
        // Class and reservation must agree: a general-class module holding
        // reserved permits would shrink the general pools without anything
        // ever drawing on the carve-out, and a reserved-class module with a
        // zero reservation could dispatch only through another module's
        // permits — both are impossible accounting, refused at startup.
        match declaration.route_class {
            RouteClass::General => {
                if declaration.reserved_pending_requests != 0
                    || declaration.reserved_handler_tasks != 0
                {
                    return Err(HostError::InitFailed(
                        "a general-class module declares reserved permits".to_owned(),
                    ));
                }
            }
            RouteClass::Reserved => {
                if declaration.reserved_pending_requests == 0
                    || declaration.reserved_handler_tasks == 0
                {
                    return Err(HostError::InitFailed(
                        "a reserved-class module declares no reserved permits".to_owned(),
                    ));
                }
            }
        }
        reservations.pending = reservations
            .pending
            .checked_add(declaration.reserved_pending_requests)
            .ok_or_else(|| {
                HostError::InitFailed("reserved pending-request sum overflows".to_owned())
            })?;
        reservations.tasks = reservations
            .tasks
            .checked_add(declaration.reserved_handler_tasks)
            .ok_or_else(|| {
                HostError::InitFailed("reserved handler-task sum overflows".to_owned())
            })?;
        reservations.general_task_holds = reservations
            .general_task_holds
            .checked_add(declaration.general_task_hold_bound)
            .ok_or_else(|| {
                HostError::InitFailed("general handler-task hold sum overflows".to_owned())
            })?;
        reservations.retained_bytes = reservations
            .retained_bytes
            .checked_add(declaration.retained_resident_bytes)
            .ok_or_else(|| {
                HostError::InitFailed("retained resident-byte sum overflows".to_owned())
            })?;
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
        target_entries.push((
            manifest.module_id.clone().into_boxed_str(),
            kinds,
            declaration.route_class,
        ));
    }
    if !target_entries
        .iter()
        .any(|(_, kinds, _)| kinds.contains(&TargetKind::ToolProvider))
    {
        return Err(HostError::InitFailed(
            "startup manifests do not advertise a tool_provider role".to_owned(),
        ));
    }
    Ok((
        crate::control::TargetIndex::new(target_entries),
        reservations,
    ))
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
    // The first attempt runs inline, so startup ordering and latency are
    // unchanged. Only the wait between attempts is async: parking an executor
    // thread here would stall a same-process predecessor drain whose
    // completion releases the lock being waited on. The ~75ms budget only
    // rides out a probe's momentary shared hold; a predecessor still draining
    // (bounded by the callback and shutdown deadlines) exhausts it and yields
    // `AlreadyRunning`, and the caller decides whether to retry the start.
    let guard = {
        let mut acquired = None;
        for attempt in 0..crate::instance::LOCK_RETRY_ATTEMPTS {
            match InstanceGuard::acquire(
                config.data_dir.as_deref(),
                &config.payload_manifest_digest,
            ) {
                Ok(guard) => {
                    acquired = Some(guard);
                    break;
                }
                Err(InstanceError::AlreadyRunning)
                    if attempt + 1 < crate::instance::LOCK_RETRY_ATTEMPTS =>
                {
                    tokio::time::sleep(crate::instance::LOCK_RETRY_DELAY).await;
                }
                Err(e) => return Err(HostError::Instance(e)),
            }
        }
        match acquired {
            Some(guard) => guard,
            None => return Err(HostError::Instance(InstanceError::AlreadyRunning)),
        }
    };
    guard
        .write_lifecycle_record(crate::lifecycle::LifecyclePhase::Starting)
        .map_err(HostError::Instance)?;

    let handler = Arc::new(handler);
    handler.install_connection_key(*guard.key().bytes());
    let manifests = crate::panic_boundary::redact_sync(|| handler.manifests());
    let declarations = crate::panic_boundary::redact_sync(|| handler.resource_declarations());
    let (targets, reservations) = build_target_index(&manifests, &declarations)?;
    // Reservations must leave a usable general class: after carving out
    // every reserved permit, at least one general pending slot and one
    // general task slot must remain, or unrelated Magic Context and Synapse
    // requests could never dispatch (plan KTD2, R13).
    if reservations.pending >= config.limits.max_pending_requests {
        return Err(HostError::InitFailed(
            "reserved pending requests leave no general pending slot".to_owned(),
        ));
    }
    if reservations.tasks >= config.limits.max_handler_tasks {
        return Err(HostError::InitFailed(
            "reserved handler tasks leave no general handler-task slot".to_owned(),
        ));
    }
    // Declared long-parked general tasks (for example Synapse's running
    // query plus its FIFO waiters) draw on the general pool. If they could
    // fill it, one module's waiting traffic would starve every other route,
    // so the sum must leave at least one free general task slot.
    let general_task_slots = config.limits.max_handler_tasks - reservations.tasks;
    if reservations.general_task_holds >= general_task_slots {
        return Err(HostError::InitFailed(format!(
            "declared parked handler tasks ({}) leave no free general handler-task slot \
             ({general_task_slots} available); lower max_waiting_queries or raise \
             max_handler_tasks",
            reservations.general_task_holds
        )));
    }
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
    // the byte-budget semaphores, and declared retained bytes are handler
    // state with the same whole-incarnation lifetime; the ingress budget
    // shrinks by both below so total resident bytes still honor
    // max_resident_bytes. That subtraction must leave at least one maximum
    // request body of ingress headroom — the handler-dependent resident
    // floor: one byte below it fails startup, the exact floor is accepted.
    let catalog_resident = catalog.resident_len() as u64;
    let resident_floor = crate::config::MIN_RESIDENT_BYTES
        .saturating_add(catalog_resident)
        .saturating_add(reservations.retained_bytes);
    if config.limits.max_resident_bytes < resident_floor {
        return Err(HostError::InitFailed(
            "catalog and declared retained bytes leave no resident-byte headroom".to_owned(),
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
                PrePublicationCleanup::new(guard, handler).finish().await;

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
                PrePublicationCleanup::new(guard, handler).finish().await;
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
    let mut cleanup = PrePublicationCleanup::new(guard, handler);
    let setup = async {
        // Shutdown between initialization and publication: nothing was
        // published and no route work exists, so this is the graceful
        // outcome — the initialized handler still has to be drained.
        if shutdown.is_cancelled() {
            return Ok(None);
        }
        let setup_socket = cleanup.guard_mut().dir_path().join("setup.sock");
        let listener =
            crate::setup_socket::bind_owner_only(&setup_socket).map_err(HostError::Io)?;
        cleanup
            .guard_mut()
            .register_setup_socket(setup_socket.clone());
        cleanup
            .guard_mut()
            .publish(&setup_socket, &config.daemon_ver)
            .map_err(HostError::Instance)?;
        // Best effort: transport is already published, so a failed phase
        // rewrite must not tear down a serving host — probes then observe a
        // fresh `starting` record, which ages to `wedged` honestly.
        let _ = cleanup
            .guard_mut()
            .write_lifecycle_record(crate::lifecycle::LifecyclePhase::Running);
        Ok(Some((listener, setup_socket)))
    }
    .await;
    let (listener, setup_socket) = match setup {
        Ok(Some(listener)) => listener,
        Ok(None) => {
            cleanup.finish().await;
            return Ok(());
        }
        Err(err) => {
            cleanup.finish().await;
            return Err(err);
        }
    };

    let (guard, handler) = cleanup.disarm();

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
        health_snapshot: RwLock::new(HealthReport {
            status: HealthStatus::Degraded,
            detail: None,
            metrics: Some(serde_json::json!({"components": {}})),
        }),
        providers: config.transport_providers.clone(),
        registry: RouteRegistry::new(config.limits.max_routes),
        ingress_budget: ByteBudget::new(
            config.limits.max_resident_bytes
                - crate::config::EGRESS_RESERVED_BYTES
                - crate::config::SCRATCH_RESERVED_BYTES
                - catalog_resident
                - reservations.retained_bytes,
        ),
        scratch_budget: ByteBudget::new(crate::config::SCRATCH_RESERVED_BYTES),
        egress_budget: ByteBudget::new(crate::config::EGRESS_RESERVED_BYTES),
        pending_permits: Arc::new(Semaphore::new(
            config.limits.max_pending_requests - reservations.pending,
        )),
        task_permits: Arc::new(Semaphore::new(
            config.limits.max_handler_tasks - reservations.tasks,
        )),
        reserved_pending_permits: Arc::new(Semaphore::new(reservations.pending)),
        reserved_task_permits: Arc::new(Semaphore::new(reservations.tasks)),
        handshake_permits: Arc::new(Semaphore::new(config.limits.max_handshakes)),
        connection_permits: Arc::new(Semaphore::new(config.limits.max_connections)),
        tracker: TaskTracker::new(),
        abort_handles: Mutex::new(AbortRegistry::new()),
        shutdown_callback_ran: AtomicBool::new(false),
        shutdown: shutdown.clone(),
        shutdown_latch: Arc::new(crate::lifecycle::ShutdownLatch::new()),
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
    spawn_activation_task(&shared);
    spawn_health_task(&shared);
    accept_loop(&shared, listener).await;
    let _ = std::fs::remove_file(setup_socket);
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

/// Runs the handler's post-publication activation exactly once, tracked but
/// never awaited by startup: transport is already published and the accept
/// loop starts regardless of activation progress. An `Err`, panic, or task
/// loss trips the fatal latch; shutdown abandons an unfinished activation
/// future at the inner select, and the component-owned trackers it started
/// are drained by the handler shutdown callback.
fn spawn_activation_task<H: McHostHandler>(shared: &Arc<HostShared<H>>) {
    let outer = Arc::clone(shared);
    let shared = Arc::clone(shared);
    outer.spawn_tracked(async move {
        let handler = Arc::clone(&shared.handler);
        let watchdog = Arc::clone(&shared);
        // Abort-exempt: forced-shutdown `abort_all` must not turn an
        // in-flight activation into a spurious task loss. The inner select
        // self-bounds on the shutdown token instead; there is deliberately
        // no lifecycle deadline here because model construction and
        // certification own separate post-publication budgets.
        let task = shared.spawn_lifecycle(async move {
            let callback = crate::panic_boundary::redact_sync(|| handler.activate());
            tokio::select! {
                biased;
                () = watchdog.shutdown.cancelled() => {}
                result = crate::panic_boundary::redact(callback) => {
                    if let Err(err) = result {
                        // The handler-authored message can carry component
                        // detail; fatal diagnostics get bounded structure
                        // only (protocol V24).
                        watchdog.fatal.trip(
                            &watchdog.shutdown,
                            format!(
                                "activation invariant failure ({} bytes of detail redacted)",
                                err.0.len()
                            ),
                        );
                    }
                }
            }
        });
        if task.await.is_err() {
            shared
                .fatal
                .trip(&shared.shutdown, "activation task lost".to_owned());
        }
    });
}

/// Accepts sockets until shutdown. Each accept result is synchronously
/// registered with the task tracker before the next await — the
/// accepted-socket linearization point — so shutdown always finds and closes
/// it (plan KTD10).
async fn accept_loop<H: McHostHandler>(shared: &Arc<HostShared<H>>, listener: UnixListener) {
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
    fn activation_in_progress(report: &HealthReport) -> bool {
        let components = report
            .metrics
            .as_ref()
            .and_then(|metrics| metrics.get("components"))
            .and_then(serde_json::Value::as_object);
        components.is_some_and(|components| {
            components.values().any(|component| {
                let metrics = component
                    .get("metrics")
                    .and_then(serde_json::Value::as_object);
                metrics.is_some_and(|metrics| {
                    metrics
                        .get("storage_state")
                        .and_then(serde_json::Value::as_str)
                        == Some("starting")
                        || metrics
                            .get("synapse_state")
                            .and_then(serde_json::Value::as_str)
                            == Some("starting")
                })
            })
        })
    }

    let shared = Arc::clone(shared);
    let shared_outer = Arc::clone(&shared);
    shared_outer.spawn_tracked(async move {
        loop {
            if shared.shutdown.is_cancelled() {
                return;
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
                    () = watchdog.shutdown.cancelled() => None,
                    result = timeout(deadline, crate::panic_boundary::redact(callback)) => {
                        match result {
                            Ok(report) => Some(report),
                            Err(_) => {
                                watchdog.fatal.trip(
                                    &watchdog.shutdown,
                                    "health callback deadline expired".to_owned(),
                                );
                                None
                            }
                        }
                    }
                }
            });
            // The report itself is informational; degraded storage must not
            // make transport unready (protocol §8.1, AE9).
            let activation_in_progress = match shared.lifecycle_join("health", probe).await {
                Ok(Some(report)) => {
                    let activation_in_progress = activation_in_progress(&report);
                    *shared
                        .health_snapshot
                        .write()
                        .unwrap_or_else(std::sync::PoisonError::into_inner) = report;
                    activation_in_progress
                }
                Ok(None) => return,
                Err(_) => return,
            };
            let interval = if activation_in_progress {
                Duration::from_millis(50)
            } else {
                shared.timing.health_interval
            };
            tokio::select! {
                () = shared.shutdown.cancelled() => return,
                () = tokio::time::sleep(interval) => {}
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

    // 2. Demote the phase to `stopping`, then remove the publication — both
    // fenced, both while the lock is held.
    guard.begin_stopping();

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
