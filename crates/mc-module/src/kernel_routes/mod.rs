//! Daemon-side kernel access: the `kernel.*` route family and the lifecycle
//! that owns the one [`KernelStore`] they share.
//!
//! [`KernelOpenCoordinator`] holds the store slot and its phase together so a
//! route can never observe a `Ready` phase with an empty slot, and `health()`
//! can read the phase from one atomic without touching the store.

pub mod health;
pub mod serving;
pub(crate) mod state;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use mc_kernel::{KernelError, KernelStore};
use tokio_util::sync::CancellationToken;

use crate::{jittered_store_open_delay, StoreOpenPolicy};
pub use state::{ConflictReason, InvalidReason, KernelOutcome, UnavailableReason};

/// Directory under the managed data directory holding `core.sqlite` and
/// `artifacts/`.
pub const KERNEL_DIRECTORY: &str = "kernel";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KernelState {
    Starting,
    Ready,
    Unavailable,
}

impl serde::Serialize for KernelState {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl KernelState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Ready => "ready",
            Self::Unavailable => "unavailable",
        }
    }
}

/// Identifies why the coordinator entered the `Unavailable` phase.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UnavailableKind {
    /// The store failed to open, lost its lease, or is shut down.
    Store,
    /// This build cannot use the store or the configured backend.
    Unsupported,
}

impl From<UnavailableKind> for UnavailableReason {
    fn from(kind: UnavailableKind) -> Self {
        match kind {
            UnavailableKind::Store => Self::StoreUnavailable,
            UnavailableKind::Unsupported => Self::StoreUnsupported,
        }
    }
}

/// Encodes the lifecycle phase and unavailable reason together so readers
/// cannot observe values from different transitions.
#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Starting = 0,
    Ready = 1,
    UnavailableStore = 2,
    UnavailableUnsupported = 3,
}

impl Phase {
    fn from_u8(value: u8) -> Self {
        match value {
            1 => Self::Ready,
            2 => Self::UnavailableStore,
            3 => Self::UnavailableUnsupported,
            _ => Self::Starting,
        }
    }

    fn unavailable(kind: UnavailableKind) -> Self {
        match kind {
            UnavailableKind::Store => Self::UnavailableStore,
            UnavailableKind::Unsupported => Self::UnavailableUnsupported,
        }
    }

    fn state(self) -> KernelState {
        match self {
            Self::Starting => KernelState::Starting,
            Self::Ready => KernelState::Ready,
            Self::UnavailableStore | Self::UnavailableUnsupported => KernelState::Unavailable,
        }
    }

    fn unavailable_kind(self) -> Option<UnavailableKind> {
        match self {
            Self::Starting | Self::Ready => None,
            Self::UnavailableStore => Some(UnavailableKind::Store),
            Self::UnavailableUnsupported => Some(UnavailableKind::Unsupported),
        }
    }
}

pub(crate) struct KernelOpenCoordinator {
    phase: AtomicU8,
    /// Also serializes phase transitions against health publication, so a
    /// sample cannot overwrite the block a concurrent transition published.
    slot: Mutex<Option<Arc<KernelStore>>>,
    health: health::KernelHealthProjection,
    background_sampler: AtomicBool,
}

impl KernelOpenCoordinator {
    pub(crate) fn new() -> Self {
        Self {
            phase: AtomicU8::new(Phase::Starting as u8),
            slot: Mutex::new(None),
            health: health::KernelHealthProjection::new(),
            background_sampler: AtomicBool::new(true),
        }
    }

    /// The last published health block; reads one atomic pointer.
    pub(crate) fn health_block(&self) -> Arc<health::KernelHealthBlock> {
        self.health.load()
    }

    /// Publishes `block` only while the phase is still `Ready`, under the same
    /// lock `mark_unavailable` holds, so the two can never interleave; a phase
    /// change wins and is republished instead.
    pub(crate) fn publish_if_ready(&self, block: health::KernelHealthBlock) -> bool {
        let _slot = self.slot.lock().expect("kernel store slot mutex");
        if self.phase() != Phase::Ready {
            self.publish_phase();
            return false;
        }
        self.health.publish(block);
        true
    }

    fn phase(&self) -> Phase {
        Phase::from_u8(self.phase.load(Ordering::Acquire))
    }

    pub(crate) fn state(&self) -> KernelState {
        self.phase().state()
    }

    pub(crate) fn background_sampler_enabled(&self) -> bool {
        self.background_sampler.load(Ordering::Acquire)
    }

    #[cfg(feature = "test-support")]
    pub(crate) fn disable_background_sampler(&self) {
        self.background_sampler.store(false, Ordering::Release);
    }

    /// The store a route may use, or the typed outcome the route must answer
    /// with instead. The guard is released before returning so no caller holds
    /// the slot across blocking kernel work.
    pub(crate) fn kernel_store(&self) -> Result<Arc<KernelStore>, KernelOutcome> {
        match self.phase() {
            Phase::Starting => Err(KernelOutcome::unavailable(UnavailableReason::StoreStarting)),
            Phase::UnavailableStore | Phase::UnavailableUnsupported => {
                Err(KernelOutcome::unavailable(self.unavailable_reason()))
            }
            Phase::Ready => self
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
        self.phase()
            .unavailable_kind()
            .unwrap_or(UnavailableKind::Store)
            .into()
    }

    /// Slot first, then phase: a reader that sees `Ready` finds the store.
    ///
    /// Unlike `mark_unavailable`, `install` does not republish the health
    /// block: `Ready` reaches health only from a sample that carries measured
    /// facts.
    fn install(&self, store: KernelStore) {
        let mut slot = self.slot.lock().expect("kernel store slot mutex");
        *slot = Some(Arc::new(store));
        self.phase.store(Phase::Ready as u8, Ordering::Release);
    }

    /// Phase first, then slot: a reader that still sees `Ready` may finish
    /// with the old store, and nothing observes `Unavailable` with a live slot.
    /// `slot` stays locked through the publish, so a concurrent sample cannot
    /// publish `Ready` afterward.
    pub(crate) fn mark_unavailable(&self, kind: UnavailableKind) {
        let mut slot = self.slot.lock().expect("kernel store slot mutex");
        self.phase
            .store(Phase::unavailable(kind) as u8, Ordering::Release);
        *slot = None;
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
        let mut waiting = false;
        loop {
            if cancel.is_cancelled() {
                self.mark_unavailable(UnavailableKind::Store);
                return;
            }
            match open_once(root.clone()).await {
                Ok(store) => {
                    if cancel.is_cancelled() {
                        self.mark_unavailable(UnavailableKind::Store);
                        return;
                    }
                    self.install(store);
                    return;
                }
                Err(KernelError::Held) if started.elapsed() < policy.wait_window => {
                    if !waiting {
                        waiting = true;
                        eprintln!(
                            "mc-module: kernel store lease held; waiting up to {}s for predecessor exit",
                            policy.wait_window.as_secs()
                        );
                    }
                    let delay = jittered_store_open_delay(backoff, policy.max_backoff, attempt)
                        .min(policy.wait_window.saturating_sub(started.elapsed()));
                    tokio::select! {
                        _ = cancel.cancelled() => {
                            self.mark_unavailable(UnavailableKind::Store);
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
                    self.mark_unavailable(open_failure_kind(error));
                    return;
                }
            }
        }
    }
}

/// Every terminal open error is either a store this build cannot use or a
/// store that may open next time; a held lease past the wait window is the
/// latter.
fn open_failure_kind(error: KernelError) -> UnavailableKind {
    match KernelOutcome::from(error) {
        KernelOutcome::Unavailable {
            reason: UnavailableReason::StoreUnsupported,
        } => UnavailableKind::Unsupported,
        KernelOutcome::Available
        | KernelOutcome::Stale { .. }
        | KernelOutcome::Abstained { .. }
        | KernelOutcome::Unavailable { .. }
        | KernelOutcome::Conflict { .. }
        | KernelOutcome::Invalid { .. } => UnavailableKind::Store,
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
