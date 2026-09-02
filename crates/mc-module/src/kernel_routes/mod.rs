//! Daemon-side kernel access: the `kernel.*` route family and the lifecycle
//! that owns the one [`KernelStore`] they share.
//!
//! [`KernelOpenCoordinator`] holds the store slot and its phase together so a
//! route can never observe a `Ready` phase with an empty slot, and `health()`
//! can read the phase from one atomic without touching the store.

pub mod commit;
pub mod egress;
pub mod eligibility;
pub mod health;
pub mod ingest;
pub(crate) mod project;
pub mod read;
pub mod serving;
pub(crate) mod state;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use mc_host::RouteHandle;
use mc_kernel::{KernelError, KernelStore};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::dispatch::PreparedOutcome;
use crate::{jittered_store_open_delay, McHandler, StoreOpenPolicy};
pub use state::{ConflictReason, InvalidReason, KernelOutcome, UnavailableReason};

/// Directory under the managed data directory holding `core.sqlite` and
/// `artifacts/`.
pub const KERNEL_DIRECTORY: &str = "kernel";

/// Health projection of the kernel store lifecycle, stored as one atomic.
#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KernelState {
    Starting = 0,
    Ready = 1,
    Unavailable = 2,
}

impl serde::Serialize for KernelState {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl KernelState {
    fn from_u8(value: u8) -> Self {
        match value {
            1 => Self::Ready,
            2 => Self::Unavailable,
            _ => Self::Starting,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Ready => "ready",
            Self::Unavailable => "unavailable",
        }
    }
}

const UNAVAILABLE_STORE: u8 = 0;
const UNAVAILABLE_UNSUPPORTED: u8 = 1;

pub(crate) struct KernelOpenCoordinator {
    state: AtomicU8,
    /// Which [`UnavailableReason`] an `Unavailable` state carries.
    unavailable_kind: AtomicU8,
    slot: Mutex<Option<Arc<KernelStore>>>,
    health: health::KernelHealthProjection,
    /// Derived from the store in the slot, so it is emptied whenever the slot
    /// changes hands.
    eligibility_cache: Mutex<eligibility::VerdictCache>,
    /// Staged artifact uploads never outlive the store they were begun
    /// against, so they are dropped whenever the slot changes hands.
    uploads: Mutex<ingest::UploadCoordinator>,
}

impl KernelOpenCoordinator {
    pub(crate) fn new() -> Self {
        Self {
            state: AtomicU8::new(KernelState::Starting as u8),
            unavailable_kind: AtomicU8::new(UNAVAILABLE_STORE),
            slot: Mutex::new(None),
            health: health::KernelHealthProjection::new(),
            eligibility_cache: Mutex::new(eligibility::VerdictCache::default()),
            uploads: Mutex::new(ingest::UploadCoordinator::default()),
        }
    }

    pub(crate) fn uploads(&self) -> std::sync::MutexGuard<'_, ingest::UploadCoordinator> {
        self.uploads.lock().expect("upload coordinator mutex")
    }

    pub(crate) fn eligibility_cache(&self) -> std::sync::MutexGuard<'_, eligibility::VerdictCache> {
        self.eligibility_cache
            .lock()
            .expect("eligibility cache mutex")
    }

    /// The last published health block; reads one atomic pointer.
    pub(crate) fn health_block(&self) -> Arc<health::KernelHealthBlock> {
        self.health.load()
    }

    pub(crate) fn state(&self) -> KernelState {
        KernelState::from_u8(self.state.load(Ordering::Acquire))
    }

    /// The store a route may use, or the typed outcome the route must answer
    /// with instead. The guard is released before returning so no caller holds
    /// the slot across blocking kernel work.
    pub(crate) fn kernel_store(&self) -> Result<Arc<KernelStore>, KernelOutcome> {
        match self.state() {
            KernelState::Starting => {
                Err(KernelOutcome::unavailable(UnavailableReason::StoreStarting))
            }
            KernelState::Unavailable => Err(KernelOutcome::unavailable(self.unavailable_reason())),
            KernelState::Ready => self
                .slot
                .lock()
                .expect("kernel store slot mutex")
                .clone()
                .ok_or(KernelOutcome::unavailable(
                    UnavailableReason::StoreUnavailable,
                )),
        }
    }

    pub(crate) fn unavailable_reason(&self) -> UnavailableReason {
        match self.unavailable_kind.load(Ordering::Acquire) {
            UNAVAILABLE_UNSUPPORTED => UnavailableReason::StoreUnsupported,
            _ => UnavailableReason::StoreUnavailable,
        }
    }

    /// Slot first, then phase: a reader that sees `Ready` finds the store.
    fn install(&self, store: KernelStore) {
        self.eligibility_cache().clear();
        self.uploads().clear();
        *self.slot.lock().expect("kernel store slot mutex") = Some(Arc::new(store));
        self.state
            .store(KernelState::Ready as u8, Ordering::Release);
    }

    /// Phase first, then slot: a reader that still sees `Ready` may finish
    /// with the old store, and nothing observes `Unavailable` with a live slot
    /// it could use.
    pub(crate) fn mark_unavailable(&self, reason: UnavailableReason) {
        let kind = match reason {
            UnavailableReason::StoreUnsupported => UNAVAILABLE_UNSUPPORTED,
            UnavailableReason::StoreUnavailable
            | UnavailableReason::StoreStarting
            | UnavailableReason::StoreBusy
            | UnavailableReason::NoRequiredConsumer
            | UnavailableReason::SnapshotDiverged
            | UnavailableReason::QueueFull => UNAVAILABLE_STORE,
        };
        self.unavailable_kind.store(kind, Ordering::Release);
        self.state
            .store(KernelState::Unavailable as u8, Ordering::Release);
        *self.slot.lock().expect("kernel store slot mutex") = None;
        self.eligibility_cache().clear();
        self.uploads().clear();
        self.publish_phase();
    }

    /// Opens the kernel store under `root`, waiting through a held lease the
    /// same way the cache store does, and publishes the result. Terminal open
    /// failures classify through the same mapping routes use, so the health
    /// surface and a route caller name the same reason.
    pub(crate) async fn open(
        &self,
        root: PathBuf,
        policy: StoreOpenPolicy,
        cancel: CancellationToken,
    ) {
        let started = Instant::now();
        let mut backoff = policy.initial_backoff;
        let mut attempt = 0usize;
        loop {
            if cancel.is_cancelled() {
                self.mark_unavailable(UnavailableReason::StoreUnavailable);
                return;
            }
            match open_once(root.clone()).await {
                Ok(store) => {
                    if cancel.is_cancelled() {
                        self.mark_unavailable(UnavailableReason::StoreUnavailable);
                        return;
                    }
                    self.install(store);
                    return;
                }
                Err(KernelError::Held) if started.elapsed() < policy.wait_window => {
                    let delay = jittered_store_open_delay(backoff, policy.max_backoff, attempt)
                        .min(policy.wait_window.saturating_sub(started.elapsed()));
                    tokio::select! {
                        _ = cancel.cancelled() => {
                            self.mark_unavailable(UnavailableReason::StoreUnavailable);
                            return;
                        }
                        _ = tokio::time::sleep(delay) => {}
                    }
                    backoff = backoff.saturating_mul(2).min(policy.max_backoff);
                    attempt = attempt.saturating_add(1);
                }
                Err(error) => {
                    eprintln!(
                        "mc-module: kernel store open failed after {:.2}s: {error:?}",
                        started.elapsed().as_secs_f64()
                    );
                    self.mark_unavailable(open_failure_reason(error));
                    return;
                }
            }
        }
    }
}

/// Every terminal open error is either a store this build cannot use or a
/// store that may open next time; a held lease past the wait window is the
/// latter.
fn open_failure_reason(error: KernelError) -> UnavailableReason {
    match KernelOutcome::from(error) {
        KernelOutcome::Unavailable {
            reason: UnavailableReason::StoreUnsupported,
        } => UnavailableReason::StoreUnsupported,
        KernelOutcome::Available
        | KernelOutcome::Stale { .. }
        | KernelOutcome::Abstained { .. }
        | KernelOutcome::Unavailable { .. }
        | KernelOutcome::Conflict { .. }
        | KernelOutcome::Invalid { .. } => UnavailableReason::StoreUnavailable,
    }
}

async fn open_once(root: PathBuf) -> Result<KernelStore, KernelError> {
    match tokio::task::spawn_blocking(move || KernelStore::open(&root)).await {
        Ok(result) => result,
        Err(error) => panic!("kernel store open worker failed: {error}"),
    }
}

/// The kernel root sits beside the cache store file under the managed data
/// directory.
pub(crate) fn kernel_root_for(sqlite_path: &str) -> PathBuf {
    Path::new(sqlite_path)
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default()
        .join(KERNEL_DIRECTORY)
}

/// Every `kernel.*` response is `payload` plus a `state` field, so a client
/// parses one shape whatever the outcome; a non-available state carries an
/// otherwise empty payload.
pub(crate) fn kernel_response(state: &KernelOutcome, payload: Value) -> PreparedOutcome {
    let mut body = match payload {
        Value::Object(map) => map,
        _ => serde_json::Map::new(),
    };
    body.insert(
        "state".to_string(),
        serde_json::to_value(state).expect("kernel outcome serializes"),
    );
    crate::respond(Value::Object(body))
}

pub(crate) fn state_only(state: KernelOutcome) -> PreparedOutcome {
    kernel_response(&state, json!({}))
}

/// The store and project binding a `kernel.*` route works against. Binding
/// failures answer through the shared management error codes; a project
/// mismatch or an unopened store answers with a typed kernel state.
pub(crate) struct RouteScope {
    pub(crate) store: Arc<KernelStore>,
    pub(crate) project: project::ProjectBinding,
}

impl McHandler {
    pub(crate) fn kernel_route_scope(
        &self,
        channel: RouteHandle,
        request: &Value,
        operation: &str,
    ) -> Result<RouteScope, PreparedOutcome> {
        let (_, binding) = self.management_binding(channel, request, operation)?;
        let Some(requested_root) = request.get("project_root").and_then(Value::as_str) else {
            return Err(crate::invalid_params_error(format!(
                "{operation} requires project_root"
            )));
        };
        let project = project::ProjectBinding::new(&binding.project_root);
        if !project.accepts(Path::new(requested_root)) {
            return Err(state_only(KernelOutcome::invalid(
                InvalidReason::ProjectMismatch,
            )));
        }
        let store = self.kernel.kernel_store().map_err(state_only)?;
        Ok(RouteScope { store, project })
    }
}

/// Runs kernel work off the async workers; a panic inside the store closure is
/// reported as an unavailable store rather than taking the handler down.
pub(crate) async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, KernelOutcome> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| KernelOutcome::unavailable(UnavailableReason::StoreUnavailable))
}
