//!

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

/// HostError reports failures that prevent graceful completion.
#[derive(Debug)]
pub enum HostError {
    Config(crate::config::ConfigError),
    Instance(InstanceError),
    /// The host publishes no state when startup validation or handler initialization fails.
    /// published.
    InitFailed(String),
    /// A bind, route-gone, or health callback that panics or misses its deadline causes `HostError::LifecycleFatal`; shutdown is not graceful.
    LifecycleFatal(String),
    /// If host tasks remain unreaped after aborts at the shutdown deadline, shutdown is not graceful.
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

/// FatalCell retains only the first host-fatal lifecycle error.
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

/// HostShared is generic over H so callback futures are statically dispatched.
pub struct HostShared<H> {
    pub handler: Arc<H>,
    pub limits: HostLimits,
    pub timing: HostTiming,
    pub liveness: Option<LivenessPolicy>,
    pub targets: crate::control::TargetIndex,
    pub catalog: crate::control::CatalogCache,
    /// health_snapshot stores the last completed sanitized component-health report.
    /// `host.status` reads health_snapshot without invoking a lifecycle callback.
    pub health_snapshot: RwLock<HealthReport>,
    pub ring: Arc<crate::ring_transport::RingTransport>,
    pub registry: RouteRegistry,
    /// Only inbound frame bodies may use this blocking budget because their lifetimes do not outlive the request.
    pub ingress_budget: ByteBudget,
    /// This budget funds request scratch and request-derived ownership that can outlive the creating request.
    pub scratch_budget: ByteBudget,
    pub egress_budget: ByteBudget,
    /// General-class admission pools equal the configured limits minus all reserved-class declarations.
    /// Reserved work cannot draw from the general-class pools.
    pub pending_permits: Arc<Semaphore>,
    pub task_permits: Arc<Semaphore>,
    /// Checked declaration sums size reserved-class admission pools.
    /// Reserved pools have zero permits when no module declares a reservation.
    pub reserved_pending_permits: Arc<Semaphore>,
    pub reserved_task_permits: Arc<Semaphore>,
    pub handshake_permits: Arc<Semaphore>,
    pub connection_permits: Arc<Semaphore>,
    pub tracker: TaskTracker,
    abort_handles: Mutex<AbortRegistry>,
    /// The shutdown-callback latch prevents abandon cleanup from spawning a second callback while the graceful callback still runs.
    shutdown_callback_ran: AtomicBool,
    pub shutdown: CancellationToken,
    /// `host.shutdown` uses a commit latch shared by every connection.
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
    /// The host task tracker retains abort handles so forced shutdown can reap tasks missed by graceful draining.
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

    /// The forced shutdown path's `abort_all` must not cancel an in-progress lifecycle callback; route-gone runs exactly once and completes before handler drop.
    /// with `lifecycle_callback_deadline`.
    pub fn spawn_lifecycle<F>(&self, future: F) -> JoinHandle<F::Output>
    where
        F: std::future::Future + Send + 'static,
        F::Output: Send + 'static,
    {
        self.tracker.spawn(future)
    }

    /// `lifecycle_callback_deadline` expiry trips the fatal latch; the host must terminate rather than continue.
    ///
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
                // `timeout` cannot expire while a future fails to yield.
                // `shared.tracker.wait()` reaps the detached task.
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

/// Pruning at doubling thresholds amortizes cleanup.
/// Finished handles remain until a registration reaches `prune_at`.
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

/// The instance lock remains held until every tracked task finishes.
/// Abort-exempt lifecycle callbacks can retain the handler.
/// The cleanup task runs handler shutdown and waits without blocking `run`'s return.
/// The host waits for tracked callbacks and handler shutdown without deadlines to preserve the single-instance fence.
/// Otherwise, a successor acquiring the same data directory could initialize concurrently.
/// Process exit releases the instance lock.
fn retain_lock_until_drained<H: McHostHandler>(shared: Arc<HostShared<H>>, guard: InstanceGuard) {
    if let Ok(runtime) = tokio::runtime::Handle::try_current() {
        runtime.spawn(async move {
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

/// The cleanup task keeps the instance lock held until the aborted initialization task stops.
/// The cleanup task runs the handler shutdown callback after the aborted initialization task stops without blocking `run`'s return.
/// Releasing `guard` before the callback stops permits concurrent initialization.
/// A successor observes `AlreadyRunning` while the callback runs.
///
/// `shutdown` must tolerate interrupted initialization.
/// `retain_lock_until_stopped` must not time-limit either await: releasing `guard` before handler code stops permits concurrent initialization.
/// Dropping `guard` while handler code runs releases the single-instance fence.
fn retain_lock_until_stopped<H: McHostHandler, T: Send + 'static>(
    mut guard: InstanceGuard,
    handler: Arc<H>,
    task: tokio_util::task::AbortOnDropHandle<T>,
) {
    // `retain_lock_until_stopped` demotes the phase before draining so probes report `stopping` instead of `starting`.
    // `guard.begin_stopping()` keeps probes in `stopping` throughout the unbounded drain.
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

/// `stopped` reports whether the callback has stopped running.
pub struct LifecycleFailure {
    /// `false` means the callback still executes because its deadline expired inside a non-yielding poll that `abort` cannot interrupt.
    /// Callers must not advance cleanup until `stopped` is `true`.
    pub stopped: bool,
}

fn spawn_handler_shutdown<H: McHostHandler>(handler: Arc<H>) -> JoinHandle<()> {
    tokio::spawn(async move {
        let callback = crate::panic_boundary::redact_sync(|| handler.shutdown());
        crate::panic_boundary::redact(callback).await;
    })
}

/// `PrePublicationCleanup` owns the `InstanceGuard` and handler shutdown before `HostShared` exists.
/// Running shutdown in its own task lets a cancelled waiter transfer cleanup and the guard to a reaper without invoking `shutdown` twice.
/// Successful publication disarms the owner without spawning cleanup.
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
        // Unwinding demotes the phase before draining shutdown.
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

/// Cancelling `run` aborts host work because `TaskTracker` does not abort tracked tasks on drop.
/// When `run` is dropped, `AbandonGuard` moves cleanup to a spawned task; `disarm` suppresses cleanup after normal completion.
struct AbandonGuard<H: McHostHandler> {
    inner: Option<(Arc<HostShared<H>>, InstanceGuard)>,
}

impl<H: McHostHandler> AbandonGuard<H> {
    fn guard_mut(&mut self) -> &mut InstanceGuard {
        &mut self.inner.as_mut().expect("armed abandon guard").1
    }

    /// `disarm` returns `InstanceGuard` so normal completion drops the handler before releasing the lock.
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
        // `begin_stopping` changes the published phase to `stopping`.
        guard.begin_stopping();
        // `force_close_all_routes` completes route-gone callbacks before the handler drops.
        // `AbandonGuard` moves `InstanceGuard` into the cleanup task so the lock releases after route-gone callbacks.
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                force_close_all_routes(&shared).await;
                shared.tracker.close();
                // `tracker.wait()` has no deadline because releasing the lock while an abort-exempt callback owns the handler permits concurrent initialization.
                shared.tracker.wait().await;
                // `run_handler_shutdown` runs after `tracker.wait()` because only `shutdown` stops and drains component-owned work.
                run_handler_shutdown(&shared).await;
                // The tracked callback task is never aborted; `InstanceGuard` must outlive a callback that exceeds its deadline.
                shared.tracker.wait().await;
                drop(shared);
                drop(guard);
            });
        }
    }
}

/// `Reservations` stores checked sums of module reservations and retained bytes.
struct Reservations {
    pending: usize,
    tasks: usize,
    /// `general_task_holds` is the checked sum of declared bounds on concurrently parked general-class handler tasks.
    general_task_holds: usize,
    retained_bytes: u64,
}

/// `build_target_index` validates manifests and declarations so catalog, admission, and permit accounting agree.
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
        // General-class modules must reserve no permits, and reserved-class modules must reserve nonzero permits, to prevent unclaimable or cross-module permits.
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
            // Startup rejects catalog entries whose roles cannot route because they contradict route admission.
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

///
/// After publication, `run` returns only after shutdown drains or a fatal failure.
/// After publication, `guard` drops only after `shared.tracker` drains.
pub async fn run<H: McHostHandler>(
    handler: H,
    config: HostConfig,
    shutdown: CancellationToken,
) -> Result<(), HostError> {
    run_with_publish_hook(handler, config, shutdown, None).await
}

/// Runs a host with a frame-publication observer used by transport contract
/// tests to hold a write before its completion hook fires.
#[doc(hidden)]
pub async fn run_with_publish_hook<H: McHostHandler>(
    handler: H,
    mut config: HostConfig,
    shutdown: CancellationToken,
    publish_hook: Option<crate::ring_transport::PublishHook>,
) -> Result<(), HostError> {
    crate::panic_boundary::install();
    config.validate().map_err(HostError::Config)?;
    // Async waiting prevents an executor thread from blocking a predecessor drain that releases the lock.
    // Each retry waits `LOCK_RETRY_DELAY`; exhausting `LOCK_RETRY_ATTEMPTS` returns `AlreadyRunning`.
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
    // Reserved permits must leave one general task slot so unrelated routes can dispatch.
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
    // Declared general task holds must leave one free general task slot to prevent one route from starving other routes.
    let general_task_slots = config.limits.max_handler_tasks - reservations.tasks;
    if reservations.general_task_holds >= general_task_slots {
        return Err(HostError::InitFailed(format!(
            "declared parked handler tasks ({}) leave no free general handler-task slot \
             ({general_task_slots} available); lower max_waiting_queries or raise \
             max_handler_tasks",
            reservations.general_task_holds
        )));
    }
    // Reject over-limit manifests during serialization before materializing a full catalog copy.
    let Ok(catalog) =
        crate::control::CatalogCache::new_bounded(&manifests, crate::wire::MAX_BODY_LEN as usize)
    else {
        return Err(HostError::InitFailed(
            "linked manifest catalog exceeds the frame limit".to_owned(),
        ));
    };
    // Startup requires `max_resident_bytes` to cover `catalog_resident`, `reservations.retained_bytes`, and `MIN_RESIDENT_BYTES` of ingress headroom.
    // `max_resident_bytes == resident_floor` succeeds; one byte less fails startup.
    let catalog_resident = catalog.resident_len() as u64;
    let resident_floor = crate::config::MIN_RESIDENT_BYTES
        .saturating_add(catalog_resident)
        .saturating_add(reservations.retained_bytes);
    if config.limits.max_resident_bytes < resident_floor {
        return Err(HostError::InitFailed(
            "catalog and declared retained bytes leave no resident-byte headroom".to_owned(),
        ));
    }

    // Initialization failure or deadline expiration prevents publication.
    // `init_task` is abort-on-drop so dropping `run` cancels initialization before a successor acquires the instance lock.
    {
        let init_handler = Arc::clone(&handler);
        // Move `config.init` rather than cloning it so no second descriptor copy remains outside the byte budgets.
        let init = std::mem::take(&mut config.init);
        let mut init_task = tokio_util::task::AbortOnDropHandle::new(tokio::spawn(async move {
            let callback = crate::panic_boundary::redact_sync(|| init_handler.initialize(init));
            crate::panic_boundary::redact(callback).await
        }));
        let joined = tokio::select! {
            biased;
            // A shutdown request aborts `init_task`; the reaper retains `guard` until cleanup stops the handler.
            () = shutdown.cancelled() => None,
            joined = timeout(config.timing.lifecycle_callback_deadline, &mut init_task) => {
                Some(joined)
            }
        };
        let Some(joined) = joined else {
            // A detached reaper retains the guard until initialization ends, then shuts down the handler before dropping the guard to prevent concurrent initialization against the same data directory.
            init_task.abort();
            retain_lock_until_stopped(guard, Arc::clone(&handler), init_task);
            return Err(HostError::InitFailed(
                "shutdown requested during initialization".to_owned(),
            ));
        };
        match joined {
            Ok(Ok(Ok(()))) => {}
            Ok(Ok(Err(err))) => {
                // `PrePublicationCleanup::finish` keeps `guard` held until shutdown stops work that failed initialization may have started.
                PrePublicationCleanup::new(guard, handler).finish().await;

                // Initialization errors report only the handler message length because the message may contain storage credentials or endpoints.
                return Err(HostError::InitFailed(format!(
                    "handler initialization failed ({} bytes of detail redacted)",
                    err.0.len()
                )));
            }
            Ok(Err(join_err)) => {
                // A panic after initialization starts handler-owned work requires the same shutdown cleanup as an initialization error.
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

    // After initialization runs, `PrePublicationCleanup` keeps `guard` until shutdown drains handler-owned work on every early return.
    let mut cleanup = PrePublicationCleanup::new(guard, handler);
    let setup = async {
        // If shutdown occurs before publication, cleanup drains the initialized handler and the host exits successfully.
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
        // A failed lifecycle-phase rewrite does not tear down an already published transport.
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

    let ring_limits = crate::ring_transport::process_limits(config.limits.max_connections)
        .ok_or_else(|| {
            HostError::InitFailed("shared-memory resource limits overflow".to_owned())
        })?;
    let ring = Arc::new(crate::ring_transport::RingTransport::for_ring_profile(
        ring_limits,
    ));
    if let Some(hook) = publish_hook {
        ring.set_publish_hook(hook);
    }
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
        ring,
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

    // `shared` retains the final handler `Arc` until the tracker drains, so the handler drops before `guard` releases the lock.
    // steps 6-8).
    let fatal = shared.fatal.take();
    if graceful {
        drop(shared);
        drop(guard);
    } else {
        // If the tracker does not drain, a reaper retains the handler and lock because lifecycle callbacks may still own the handler.
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

/// The accept loop delays retries after failed `accept()` calls to avoid a tight loop while persistent resource exhaustion keeps the listener ready.
const ACCEPT_ERROR_BACKOFF: std::time::Duration = std::time::Duration::from_millis(100);

/// Startup tracks the handler's post-publication activation without awaiting it because transport is already published.
/// The accept loop starts regardless of activation progress; an activation `Err`, panic, or task loss trips the fatal latch.
/// Shutdown abandons unfinished activation.
/// Shutdown abandons an unfinished activation future at the inner select.
fn spawn_activation_task<H: McHostHandler>(shared: &Arc<HostShared<H>>) {
    let outer = Arc::clone(shared);
    let shared = Arc::clone(shared);
    outer.spawn_tracked(async move {
        let handler = Arc::clone(&shared.handler);
        let watchdog = Arc::clone(&shared);
        // Forced-shutdown `abort_all` does not report an in-flight activation as task loss.
        let task = shared.spawn_lifecycle(async move {
            let callback = crate::panic_boundary::redact_sync(|| handler.activate());
            tokio::select! {
                biased;
                () = watchdog.shutdown.cancelled() => {}
                result = crate::panic_boundary::redact(callback) => {
                    if let Err(err) = result {
                        // Handler-authored messages carry component detail; fatal diagnostics use bounded structure.
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
            // EMFILE and ENFILE leave the listener ready; retrying without delay would spin a core, so back off while remaining responsive to shutdown.
            tokio::select! {
                biased;
                () = shared.shutdown.cancelled() => return,
                () = tokio::time::sleep(ACCEPT_ERROR_BACKOFF) => {}
            }
            continue;
        };
        // The host closes unauthenticated connections without reading when no permit is available.
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

/// Internal health probes are neither routed requests nor client JSON operations (§9.3); callback failure is host-fatal.
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
            // The probe is abort-exempt and self-bounded.
            // `abort_all` must not convert a healthy in-flight probe into `LifecycleFatal`; the internal deadline bounds the probe if the joining loop aborts.
            let probe = shared.spawn_lifecycle(async move {
                let callback = crate::panic_boundary::redact_sync(|| handler.health());
                tokio::select! {
                    biased;
                    // Shutdown cancels the informational probe.
                    // A probe that ignores shutdown keeps its tracker until the joining loop exits.
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
            // Degraded health-report storage does not make transport unready.
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

/// `shutdown_sequence` returns whether every host task was reaped before the shutdown deadline.
async fn shutdown_sequence<H: McHostHandler>(
    shared: &Arc<HostShared<H>>,
    guard: &mut InstanceGuard,
) -> bool {
    let deadline = Instant::now() + shared.timing.shutdown_deadline;

    // `accept_loop` has returned before shutdown freezes admission.
    // route opens and new routed dispatch observe `draining`.
    shared
        .draining
        .store(true, std::sync::atomic::Ordering::SeqCst);
    shared.registry.freeze_admission();

    // `begin_stopping` demotes the phase to `stopping` before removing the publication.
    // `begin_stopping` fences the phase demotion and publication removal while holding the instance lock.
    guard.begin_stopping();

    // `shutdown` settles each route's admitted work, emitting its terminals, before running each route's `route-gone` callback.
    // `shutdown` runs each route's `route-gone` before it fences read loops so `route-gone` can reject work admitted before admission froze.
    // `shutdown` fences and joins read-side producers only after every route drain reaches a terminal state.
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

        send_connection_goodbyes(&generations, deadline).await;
        for gen in &generations {
            gen.token.cancel();
        }
        for gen in &generations {
            gen.shutdown_complete.cancel();
        }
    };
    let drained_in_time = timeout_at(deadline, drain).await.is_ok();

    if !drained_in_time {
        // Forced shutdown aborts tasks while preserving exactly-once `route-gone` and handler-drop ordering.
        shared.abort_all();
        force_close_all_routes(shared).await;
    }

    // `shutdown` closes `tracker` only after accepts, read loops, and dispatch loops stop so exiting connection tasks cannot race a late `Sockets` close.
    shared.shutdown.cancel();
    shared.tracker.close();
    if timeout_at(deadline, shared.tracker.wait()).await.is_err() {
        shared.abort_all();
        force_close_all_routes(shared).await;
        // `shutdown` waits up to `2 * lifecycle_callback_deadline` for the bind and `route-gone` callbacks before returning.
        // `shutdown` does not return while a callback owns the handler, because returning releases the instance lock.
        let lifecycle_chain = shared.timing.lifecycle_callback_deadline.saturating_mul(2);
        if timeout(lifecycle_chain, shared.tracker.wait())
            .await
            .is_err()
        {
            // `shutdown` trips the fatal latch if lifecycle callbacks exceed `2 * lifecycle_callback_deadline` rather than run shutdown concurrently.
            // Non-graceful shutdown retains the instance fence until `tracker` drains.
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

async fn send_connection_goodbyes(generations: &[Arc<GenerationCore>], deadline: Instant) {
    let mut sends = tokio::task::JoinSet::new();
    for gen in generations {
        let gen = Arc::clone(gen);
        sends.spawn(async move { send_connection_goodbye(gen, deadline).await });
    }
    while sends.join_next().await.is_some() {}
}

/// Runs the handler shutdown callback exactly once, after route cleanup.
/// The callback is never aborted: a deadline overrun trips the fatal latch
/// and returns non-graceful while the still-tracked task keeps running, so
/// the handler stays owned until it actually stops.
async fn run_handler_shutdown<H: McHostHandler>(shared: &Arc<HostShared<H>>) -> bool {
    // `run_handler_shutdown` uses first-caller-wins because abandon cleanup can run after a dropped `run` future while the original shutdown callback still runs.
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame_channel::{frame_sender, SenderQueue};
    use std::collections::HashMap;

    fn stalled_generation(id: u64) -> (Arc<GenerationCore>, SenderQueue) {
        let token = CancellationToken::new();
        let (writer, queue) = frame_sender(1, token.clone(), Duration::from_secs(1));
        (
            Arc::new(GenerationCore {
                id,
                token: token.clone(),
                read_cancel: token.child_token(),
                read_tasks: TaskTracker::new(),
                shutdown_complete: CancellationToken::new(),
                writer,
                membership: std::sync::Mutex::new(HashMap::new()),
                pending: std::sync::Mutex::new(HashMap::new()),
                pings: std::sync::Mutex::new(HashMap::new()),
                busy_rejects: Arc::new(tokio::sync::Semaphore::new(1)),
                next_ping_corr: std::sync::atomic::AtomicU64::new(1),
            }),
            queue,
        )
    }

    #[tokio::test(start_paused = true)]
    async fn stalled_generations_share_one_shutdown_goodbye_deadline() {
        let (first, mut first_queue) = stalled_generation(1);
        let (second, mut second_queue) = stalled_generation(2);
        let started = Instant::now();
        let deadline = started + Duration::from_millis(250);

        send_connection_goodbyes(&[first, second], deadline).await;

        assert_eq!(
            Instant::now().duration_since(started),
            Duration::from_millis(250)
        );
        for queue in [&mut first_queue, &mut second_queue] {
            let frame = queue.try_recv().expect("Goodbye was queued concurrently");
            assert_eq!(frame.frame.bytes[5], crate::wire::FrameType::Goodbye as u8);
        }
    }
}
