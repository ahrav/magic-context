//! Provider readiness, candidate custody, and bounded recovery (plan U2).
//!
//! One provider-private [`CandidateCustody`] record owns candidate identity,
//! exact admission charges, and cleanup authority from admission through
//! release or quarantine (KTD4). Aggregate counters observe the record's
//! charges but never reconstruct ownership. One bounded, deduplicated
//! [`ProviderRecovery`] controller per provider dispatches at most one
//! cleanup call at a time, on its own detached OS thread — never a Tokio
//! request worker and never the provider preparation worker (R7) — under one
//! injected, immutable 30-second episode deadline (KTD5). A non-returning
//! cleanup suppresses further dispatch while live, may outlive controller
//! shutdown without being joined, and cannot publish a late result unless
//! both its episode and provider incarnation still match.
//!
//! Readiness governs NEW offers only (R6): existing candidates continue to
//! serve and release under their own owners regardless of state changes.
//! Nothing here formats or logs provider descriptors, grants, tokens, object
//! names, or addresses (R17).

use std::collections::VecDeque;
use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use mc_shm_transport::profile::{Admission, QuarantineRecord};

/// Immutable per-episode recovery deadline (R7): fixed when an episode
/// starts and never extended by retry delay, repeated observations, or late
/// results.
pub const RECOVERY_EPISODE_DEADLINE: Duration = Duration::from_secs(30);

/// Bounds suspects queued behind a wedged cleanup call: overflow isolates
/// the incoming record immediately instead of growing host memory.
const SUSPECT_INBOX_BOUND: usize = 8;

/// Delay between retries of one transiently failing cleanup call.
const CLEANUP_RETRY_DELAY: Duration = Duration::from_millis(50);

/// Observable provider offer state (R6). Preflight may offer the provider
/// only in `Ready`; the state never invalidates existing candidates.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderReadiness {
    /// Suspect candidates are being reclaimed or isolated.
    Recovering,
    /// Preflight may create a new offer.
    Ready,
    /// Terminal for new offers; retained charges stay visible.
    Quarantined,
}

/// Injected monotonic clock so episode deadlines are test-controllable.
pub trait RecoveryClock: Send + Sync + 'static {
    /// Monotonic offset from the clock's origin.
    fn now(&self) -> Duration;
    /// Blocks until `now() >= deadline`.
    fn wait_until(&self, deadline: Duration);
}

/// Production clock over [`std::time::Instant`].
pub struct SystemClock {
    origin: std::time::Instant,
}

impl SystemClock {
    pub fn new() -> Self {
        Self {
            origin: std::time::Instant::now(),
        }
    }
}

impl Default for SystemClock {
    fn default() -> Self {
        Self::new()
    }
}

impl RecoveryClock for SystemClock {
    fn now(&self) -> Duration {
        self.origin.elapsed()
    }

    fn wait_until(&self, deadline: Duration) {
        loop {
            let now = self.now();
            if now >= deadline {
                return;
            }
            std::thread::sleep(deadline - now);
        }
    }
}

/// Outcome of one cleanup call over one suspect candidate.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CleanupOutcome {
    /// Stale resources are provably gone; active charges may return.
    Reclaimed,
    /// Transient stale state observed; retry under the original deadline.
    StaleRetry,
    /// Ownership cannot be proven; isolate the candidate.
    Uncertain,
}

/// Provider cleanup and readiness primitives, driven only by the recovery
/// controller — never by preflight or request workers (R6-R7).
pub trait RecoveryBackend: Send + Sync + 'static {
    /// Blocking best-effort cleanup for one suspect candidate. May stall
    /// forever; the controller fences its late result and never joins it.
    fn cleanup(&self, candidate_id: u64) -> CleanupOutcome;
    /// Non-destructive readiness probe after cleanup: must not create,
    /// consume, or release provider resources.
    fn probe(&self) -> bool;
    /// Whether another candidate's admission still fits the frozen host
    /// limits, from immutable admission facts only.
    fn admission_fits(&self) -> bool;
}

/// Custody phase of one candidate lifecycle record.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CustodyPhase {
    Active,
    Released,
    Quarantined,
}

enum CustodyState {
    Active(Admission),
    Released,
    // The retained record proves the charges stay host-accounted. `None`
    // only when aggregate accounting itself failed; the phase is still
    // terminal and storage is never reused.
    Quarantined { _retained: Option<QuarantineRecord> },
}

/// Provider-private candidate lifecycle record (KTD4): owns candidate
/// identity, the exact admission charges, and cleanup authority from
/// admission through release or quarantine. Both terminal transitions are
/// exactly-once; a stale release after the controller reclaimed or isolated
/// the record is rejected without touching aggregate counters.
pub struct CandidateCustody {
    candidate_id: u64,
    incarnation: u64,
    state: Mutex<CustodyState>,
}

impl CandidateCustody {
    pub fn candidate_id(&self) -> u64 {
        self.candidate_id
    }

    /// Provider incarnation the candidate was admitted under.
    pub fn admitted_incarnation(&self) -> u64 {
        self.incarnation
    }

    pub fn phase(&self) -> CustodyPhase {
        match *self.state.lock().expect("custody lock") {
            CustodyState::Active(_) => CustodyPhase::Active,
            CustodyState::Released => CustodyPhase::Released,
            CustodyState::Quarantined { .. } => CustodyPhase::Quarantined,
        }
    }

    /// Returns every active charge exactly once. Repeated or stale releases
    /// are rejected and leave aggregate counters untouched.
    pub fn release(&self) -> bool {
        let mut state = self.state.lock().expect("custody lock");
        match std::mem::replace(&mut *state, CustodyState::Released) {
            CustodyState::Active(admission) => {
                admission.release();
                true
            }
            previous => {
                *state = previous;
                false
            }
        }
    }

    /// Isolates the candidate with its exact quarantine charges (R8) and
    /// permanently prevents this record's storage from being reused.
    fn quarantine(&self) -> bool {
        let mut state = self.state.lock().expect("custody lock");
        match std::mem::replace(&mut *state, CustodyState::Quarantined { _retained: None }) {
            CustodyState::Active(admission) => {
                *state = CustodyState::Quarantined {
                    _retained: admission.quarantine().ok(),
                };
                true
            }
            previous => {
                *state = previous;
                false
            }
        }
    }
}

impl fmt::Debug for CandidateCustody {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Host-generated identity only; no provider data exists here (R17).
        formatter
            .debug_struct("CandidateCustody")
            .field("candidate_id", &self.candidate_id)
            .field("phase", &self.phase())
            .finish_non_exhaustive()
    }
}

/// Publication fence: a cleanup result is discarded unless both the episode
/// it was dispatched under is still open and the provider incarnation still
/// matches (KTD5).
#[derive(Clone, Copy, PartialEq, Eq)]
struct EpisodeFence {
    episode: u64,
    incarnation: u64,
}

struct RecoveryState {
    readiness: ProviderReadiness,
    /// Monotonic episode identity; `episode_open` distinguishes a live
    /// episode from one already resolved at its deadline or completion.
    episode: u64,
    episode_open: bool,
    /// Immutable per-episode deadline in clock time.
    deadline: Duration,
    /// Monotonic provider incarnation; a clean reclamation mints the next.
    incarnation: u64,
    inbox: VecDeque<Arc<CandidateCustody>>,
    /// True while one dispatched cleanup call has not returned. Survives
    /// episode resolution so a wedged call keeps suppressing dispatch.
    cleanup_live: bool,
    /// The record the live call owns, until it resolves or the deadline
    /// watcher isolates it.
    inflight: Option<Arc<CandidateCustody>>,
}

struct RecoveryShared {
    backend: Arc<dyn RecoveryBackend>,
    clock: Arc<dyn RecoveryClock>,
    retry_delay: Duration,
    state: Mutex<RecoveryState>,
}

/// One bounded, deduplicated recovery controller per provider (KTD4-KTD5).
/// Cheap to clone; dropping every clone is bounded shutdown and never joins
/// a live cleanup call.
#[derive(Clone)]
pub struct ProviderRecovery {
    shared: Arc<RecoveryShared>,
}

impl ProviderRecovery {
    /// A provider with no suspects starts trivially `Ready`.
    pub fn new(backend: Arc<dyn RecoveryBackend>, clock: Arc<dyn RecoveryClock>) -> Self {
        Self::with_retry_delay(backend, clock, CLEANUP_RETRY_DELAY)
    }

    /// Test seam: controls the real-time delay between cleanup retries. The
    /// episode deadline itself always comes from the injected clock.
    pub fn with_retry_delay(
        backend: Arc<dyn RecoveryBackend>,
        clock: Arc<dyn RecoveryClock>,
        retry_delay: Duration,
    ) -> Self {
        Self {
            shared: Arc::new(RecoveryShared {
                backend,
                clock,
                retry_delay,
                state: Mutex::new(RecoveryState {
                    readiness: ProviderReadiness::Ready,
                    episode: 0,
                    episode_open: false,
                    deadline: Duration::ZERO,
                    incarnation: 1,
                    inbox: VecDeque::new(),
                    cleanup_live: false,
                    inflight: None,
                }),
            }),
        }
    }

    /// Pure state read for preflight: no backend call, no counter change,
    /// no resource effect (R6).
    pub fn readiness(&self) -> ProviderReadiness {
        self.shared.state.lock().expect("recovery lock").readiness
    }

    /// Current monotonic provider incarnation.
    pub fn incarnation(&self) -> u64 {
        self.shared.state.lock().expect("recovery lock").incarnation
    }

    /// Monotonic count of started recovery episodes.
    pub fn episode(&self) -> u64 {
        self.shared.state.lock().expect("recovery lock").episode
    }

    /// Transfers the admission charges into a lifecycle record bound to the
    /// current provider incarnation, before the candidate is exposed.
    pub fn admit_candidate(
        &self,
        candidate_id: u64,
        admission: Admission,
    ) -> Arc<CandidateCustody> {
        let incarnation = self.shared.state.lock().expect("recovery lock").incarnation;
        Arc::new(CandidateCustody {
            candidate_id,
            incarnation,
            state: Mutex::new(CustodyState::Active(admission)),
        })
    }

    /// Atomically checks `Ready` readiness, admits the profile's charges,
    /// and binds them into a custody record — all under the recovery lock,
    /// so a suspect reported by another candidate cannot flip readiness to
    /// `Recovering` between the readiness decision and the admission. A
    /// candidate admitted through this gate was provably admitted while the
    /// provider was `Ready`.
    pub fn admit_candidate_while_ready(
        &self,
        candidate_id: u64,
        admission: &Arc<mc_shm_transport::profile::AdmissionController>,
        profile: &mc_shm_transport::profile::TargetProfile,
    ) -> Option<Arc<CandidateCustody>> {
        let state = self.shared.state.lock().expect("recovery lock");
        if state.readiness != ProviderReadiness::Ready {
            return None;
        }
        // Lock order is recovery -> admission accounting, matching the
        // cleanup path (recovery -> custody -> admission); no path takes
        // the admission lock first.
        let charges = admission.admit(profile, None).ok()?;
        Some(Arc::new(CandidateCustody {
            candidate_id,
            incarnation: state.incarnation,
            state: Mutex::new(CustodyState::Active(charges)),
        }))
    }

    /// Feeds one suspect record into the bounded, deduplicated inbox and
    /// starts or continues a recovery episode.
    pub fn report_suspect(&self, record: Arc<CandidateCustody>) {
        RecoveryShared::report_suspect(&self.shared, record);
    }
}

impl fmt::Debug for ProviderRecovery {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderRecovery")
            .field("readiness", &self.readiness())
            .finish_non_exhaustive()
    }
}

impl RecoveryShared {
    fn report_suspect(shared: &Arc<Self>, record: Arc<CandidateCustody>) {
        if record.phase() != CustodyPhase::Active {
            // Already released or isolated: no charges left to recover.
            return;
        }
        let mut state = shared.state.lock().expect("recovery lock");
        let id = record.candidate_id;
        let duplicate = state
            .inflight
            .as_ref()
            .is_some_and(|held| held.candidate_id == id)
            || state.inbox.iter().any(|held| held.candidate_id == id);
        if duplicate {
            return;
        }
        match state.readiness {
            // Terminal for new offers: isolate directly, charges stay
            // visible, and no new episode or cleanup call is created.
            ProviderReadiness::Quarantined => {
                drop(state);
                let _ = record.quarantine();
            }
            ProviderReadiness::Ready => {
                state.inbox.push_back(record);
                Self::start_episode(shared, &mut state);
            }
            ProviderReadiness::Recovering => {
                if state.inbox.len() >= SUSPECT_INBOX_BOUND {
                    drop(state);
                    let _ = record.quarantine();
                    return;
                }
                state.inbox.push_back(record);
                Self::maybe_dispatch(shared, &mut state);
            }
        }
    }

    fn start_episode(shared: &Arc<Self>, state: &mut RecoveryState) {
        state.episode += 1;
        state.episode_open = true;
        // The deadline is fixed here and never touched again (KTD5).
        state.deadline = shared.clock.now().saturating_add(RECOVERY_EPISODE_DEADLINE);
        state.readiness = ProviderReadiness::Recovering;
        let watcher = Arc::clone(shared);
        let episode = state.episode;
        let deadline = state.deadline;
        // Detached and never joined: under the system clock the watcher
        // lives at most one deadline. A failed spawn leaves resolution to
        // the cleanup path; readiness simply stays `Recovering` (unoffered).
        let _ = std::thread::Builder::new()
            .name("mc-host-provider-recovery-deadline".to_owned())
            .spawn(move || Self::run_deadline(&watcher, episode, deadline));
        Self::maybe_dispatch(shared, state);
    }

    /// Dispatches at most one cleanup call. A live call — including one
    /// that never returns — suppresses every further dispatch until it
    /// returns (R7).
    fn maybe_dispatch(shared: &Arc<Self>, state: &mut RecoveryState) {
        if state.cleanup_live || !state.episode_open {
            return;
        }
        let Some(record) = state.inbox.pop_front() else {
            return;
        };
        state.cleanup_live = true;
        state.inflight = Some(Arc::clone(&record));
        let fence = EpisodeFence {
            episode: state.episode,
            incarnation: state.incarnation,
        };
        let worker = Arc::clone(shared);
        // Cleanup runs on its own detached OS thread — never a Tokio
        // request worker and never the provider preparation worker — so a
        // wedged call occupies exactly this thread and bounded shutdown
        // never waits on it. A failed spawn is indistinguishable from a
        // non-returning call: the episode deadline still resolves readiness.
        let _ = std::thread::Builder::new()
            .name("mc-host-provider-recovery".to_owned())
            .spawn(move || Self::run_cleanup(&worker, &record, fence));
    }

    fn fence_holds(state: &RecoveryState, fence: EpisodeFence) -> bool {
        state.episode_open
            && state.episode == fence.episode
            && state.incarnation == fence.incarnation
    }

    fn run_cleanup(shared: &Arc<Self>, record: &Arc<CandidateCustody>, fence: EpisodeFence) {
        loop {
            // A panicking cleanup is uncertain ownership, not a dead
            // controller; `redact_sync` keeps provider panic payloads off
            // diagnostic surfaces (R17).
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                crate::panic_boundary::redact_sync(|| shared.backend.cleanup(record.candidate_id()))
            }))
            .unwrap_or(CleanupOutcome::Uncertain);
            let mut state = shared.state.lock().expect("recovery lock");
            if !Self::fence_holds(&state, fence) {
                // Late result after the deadline resolved the episode or a
                // newer incarnation was minted: publishing anything would
                // return or revive charges the fence owner already settled.
                Self::retire_call(shared, &mut state);
                return;
            }
            if outcome == CleanupOutcome::StaleRetry && shared.clock.now() < state.deadline {
                // Retry the same one call under the original deadline; the
                // delay never extends it.
                drop(state);
                std::thread::sleep(shared.retry_delay);
                let mut state = shared.state.lock().expect("recovery lock");
                if !Self::fence_holds(&state, fence) {
                    Self::retire_call(shared, &mut state);
                    return;
                }
                drop(state);
                continue;
            }
            state.cleanup_live = false;
            state.inflight = None;
            match outcome {
                CleanupOutcome::Reclaimed => {
                    // Return every active charge exactly once, then mint the
                    // next provider incarnation: stale releases and results
                    // carrying the old incarnation are rejected.
                    if record.release() {
                        state.incarnation += 1;
                    }
                }
                // StaleRetry at the immutable deadline and every uncertain
                // outcome isolate the candidate with exact charges (R8).
                CleanupOutcome::StaleRetry | CleanupOutcome::Uncertain => {
                    let _ = record.quarantine();
                }
            }
            Self::after_record_resolved(shared, state);
            return;
        }
    }

    fn retire_call(shared: &Arc<Self>, state: &mut RecoveryState) {
        state.cleanup_live = false;
        state.inflight = None;
        Self::maybe_dispatch(shared, state);
    }

    fn after_record_resolved(shared: &Arc<Self>, mut state: MutexGuard<'_, RecoveryState>) {
        if !state.episode_open || state.readiness != ProviderReadiness::Recovering {
            return;
        }
        if !state.inbox.is_empty() {
            Self::maybe_dispatch(shared, &mut state);
            return;
        }
        // Every suspect is reclaimed or isolated: close the episode and
        // resolve readiness off the lock (the probe is provider code).
        state.episode_open = false;
        let episode = state.episode;
        drop(state);
        Self::resolve_readiness(shared, episode);
    }

    fn resolve_readiness(shared: &Arc<Self>, episode: u64) {
        // The non-destructive probe proves isolation held; admission facts
        // prove another candidate still fits the frozen limits (R8). A
        // panicking probe is provider-wide uncertainty.
        let ready = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            crate::panic_boundary::redact_sync(|| {
                shared.backend.probe() && shared.backend.admission_fits()
            })
        }))
        .unwrap_or(false);
        let mut state = shared.state.lock().expect("recovery lock");
        if state.episode != episode || state.readiness != ProviderReadiness::Recovering {
            return;
        }
        if ready {
            state.readiness = ProviderReadiness::Ready;
            if !state.inbox.is_empty() {
                // Suspects reported during resolution get their own episode
                // with its own immutable deadline.
                Self::start_episode(shared, &mut state);
            }
        } else {
            // Provider-wide uncertainty or admission-cap exhaustion:
            // terminal for new offers; charges stay visible (R8).
            state.readiness = ProviderReadiness::Quarantined;
            let stragglers: Vec<_> = state.inbox.drain(..).collect();
            drop(state);
            for record in stragglers {
                let _ = record.quarantine();
            }
        }
    }

    fn run_deadline(shared: &Arc<Self>, episode: u64, deadline: Duration) {
        shared.clock.wait_until(deadline);
        let mut state = shared.state.lock().expect("recovery lock");
        if state.episode != episode || !state.episode_open {
            return;
        }
        // The immutable deadline passed with unresolved suspects: isolate
        // each with exact quarantine charges. A still-live cleanup call
        // keeps `cleanup_live` set — suppressing dispatch — and its late
        // result fails the fence.
        state.episode_open = false;
        let mut unresolved: Vec<_> = state.inbox.drain(..).collect();
        unresolved.extend(state.inflight.take());
        for record in &unresolved {
            let _ = record.quarantine();
        }
        drop(state);
        Self::resolve_readiness(shared, episode);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::Condvar;

    use mc_shm_transport::profile::{
        AdmissionController, HostLimits, ResourceCharges, TargetProfile,
    };

    use super::*;
    use crate::shm_provider::qualified_test_profile;

    const TICK: Duration = Duration::from_millis(2);
    const SETTLE: Duration = Duration::from_millis(60);

    struct FakeClock {
        now: Mutex<Duration>,
        advanced: Condvar,
    }

    impl FakeClock {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                now: Mutex::new(Duration::ZERO),
                advanced: Condvar::new(),
            })
        }

        fn advance(&self, by: Duration) {
            let mut now = self.now.lock().expect("clock lock");
            *now += by;
            self.advanced.notify_all();
        }
    }

    impl RecoveryClock for FakeClock {
        fn now(&self) -> Duration {
            *self.now.lock().expect("clock lock")
        }

        fn wait_until(&self, deadline: Duration) {
            let mut now = self.now.lock().expect("clock lock");
            while *now < deadline {
                now = self.advanced.wait(now).expect("clock wait");
            }
        }
    }

    enum Scripted {
        Return(CleanupOutcome),
        Block,
    }

    struct FakeBackend {
        script: Mutex<VecDeque<Scripted>>,
        default_outcome: Mutex<CleanupOutcome>,
        gate: Mutex<Option<CleanupOutcome>>,
        gate_signal: Condvar,
        cleanup_calls: AtomicU64,
        live_cleanups: AtomicU64,
        max_live_cleanups: AtomicU64,
        probe_calls: AtomicU64,
        probe_ok: AtomicBool,
        saw_tokio_worker: AtomicBool,
        saw_foreign_thread: AtomicBool,
        admission: Arc<AdmissionController>,
        profile: Arc<TargetProfile>,
    }

    impl FakeBackend {
        fn new(admission: Arc<AdmissionController>, profile: Arc<TargetProfile>) -> Arc<Self> {
            Arc::new(Self {
                script: Mutex::new(VecDeque::new()),
                default_outcome: Mutex::new(CleanupOutcome::Uncertain),
                gate: Mutex::new(None),
                gate_signal: Condvar::new(),
                cleanup_calls: AtomicU64::new(0),
                live_cleanups: AtomicU64::new(0),
                max_live_cleanups: AtomicU64::new(0),
                probe_calls: AtomicU64::new(0),
                probe_ok: AtomicBool::new(true),
                saw_tokio_worker: AtomicBool::new(false),
                saw_foreign_thread: AtomicBool::new(false),
                admission,
                profile,
            })
        }

        fn push(&self, scripted: Scripted) {
            self.script.lock().expect("script lock").push_back(scripted);
        }

        fn set_default(&self, outcome: CleanupOutcome) {
            *self.default_outcome.lock().expect("default lock") = outcome;
        }

        fn release_blocked(&self, outcome: CleanupOutcome) {
            *self.gate.lock().expect("gate lock") = Some(outcome);
            self.gate_signal.notify_all();
        }

        fn cleanup_calls(&self) -> u64 {
            self.cleanup_calls.load(Ordering::SeqCst)
        }
    }

    impl RecoveryBackend for FakeBackend {
        fn cleanup(&self, _candidate_id: u64) -> CleanupOutcome {
            self.cleanup_calls.fetch_add(1, Ordering::SeqCst);
            let live = self.live_cleanups.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_live_cleanups.fetch_max(live, Ordering::SeqCst);
            if tokio::runtime::Handle::try_current().is_ok() {
                self.saw_tokio_worker.store(true, Ordering::SeqCst);
            }
            if std::thread::current().name() != Some("mc-host-provider-recovery") {
                self.saw_foreign_thread.store(true, Ordering::SeqCst);
            }
            let action = self
                .script
                .lock()
                .expect("script lock")
                .pop_front()
                .unwrap_or(Scripted::Return(
                    *self.default_outcome.lock().expect("default lock"),
                ));
            let outcome = match action {
                Scripted::Return(outcome) => outcome,
                Scripted::Block => {
                    let mut gate = self.gate.lock().expect("gate lock");
                    loop {
                        if let Some(outcome) = gate.take() {
                            break outcome;
                        }
                        gate = self.gate_signal.wait(gate).expect("gate wait");
                    }
                }
            };
            self.live_cleanups.fetch_sub(1, Ordering::SeqCst);
            outcome
        }

        fn probe(&self) -> bool {
            self.probe_calls.fetch_add(1, Ordering::SeqCst);
            self.probe_ok.load(Ordering::SeqCst)
        }

        fn admission_fits(&self) -> bool {
            self.admission.can_admit(&self.profile, None).is_ok()
        }
    }

    struct Rig {
        backend: Arc<FakeBackend>,
        clock: Arc<FakeClock>,
        admission: Arc<AdmissionController>,
        profile: Arc<TargetProfile>,
        recovery: ProviderRecovery,
        next_candidate: AtomicU64,
    }

    impl Rig {
        fn new(candidates: u64) -> Self {
            let profile = Arc::new(qualified_test_profile());
            let charges = profile.charges();
            let admission = Arc::new(AdmissionController::new(HostLimits {
                descriptors: charges.descriptors * candidates,
                arena_bytes: charges.arena_bytes * candidates,
                leases: charges.leases * candidates,
                mappings: charges.mappings * candidates,
                pinned_workers: 0,
            }));
            let clock = FakeClock::new();
            let backend = FakeBackend::new(Arc::clone(&admission), Arc::clone(&profile));
            let recovery = ProviderRecovery::with_retry_delay(
                Arc::clone(&backend) as Arc<dyn RecoveryBackend>,
                Arc::clone(&clock) as Arc<dyn RecoveryClock>,
                Duration::from_millis(1),
            );
            Self {
                backend,
                clock,
                admission,
                profile,
                recovery,
                next_candidate: AtomicU64::new(1),
            }
        }

        fn admit(&self) -> Arc<CandidateCustody> {
            let admission = self
                .admission
                .admit(&self.profile, None)
                .expect("test admission fits");
            let id = self.next_candidate.fetch_add(1, Ordering::SeqCst);
            self.recovery.admit_candidate(id, admission)
        }

        fn charges(&self) -> ResourceCharges {
            self.profile.charges()
        }

        fn active(&self) -> ResourceCharges {
            self.admission.snapshot().expect("snapshot").active
        }

        fn quarantined(&self) -> ResourceCharges {
            self.admission.snapshot().expect("snapshot").quarantined
        }
    }

    fn wait_for(what: &str, condition: impl Fn() -> bool) {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !condition() {
            assert!(
                std::time::Instant::now() < deadline,
                "timed out waiting for {what}"
            );
            std::thread::sleep(TICK);
        }
    }

    fn charges_times(charges: ResourceCharges, factor: u64) -> ResourceCharges {
        ResourceCharges {
            descriptors: charges.descriptors * factor,
            arena_bytes: charges.arena_bytes * factor,
            leases: charges.leases * factor,
            mappings: charges.mappings * factor,
            pinned_workers: charges.pinned_workers * factor,
            spans_per_frame: charges.spans_per_frame,
        }
    }

    #[test]
    fn custody_releases_exactly_once_and_rejects_stale_releases() {
        let rig = Rig::new(2);
        let record = rig.admit();
        assert_eq!(record.phase(), CustodyPhase::Active);
        assert_eq!(rig.active(), rig.charges());
        assert!(record.release());
        assert_eq!(record.phase(), CustodyPhase::Released);
        assert_eq!(rig.active(), ResourceCharges::ZERO);
        // A repeated (stale) release is rejected and counters do not move.
        assert!(!record.release());
        assert_eq!(rig.active(), ResourceCharges::ZERO);

        let isolated = rig.admit();
        assert!(isolated.quarantine());
        assert_eq!(isolated.phase(), CustodyPhase::Quarantined);
        assert_eq!(rig.quarantined(), rig.charges());
        // Neither release nor a second quarantine can move the charges.
        assert!(!isolated.release());
        assert!(!isolated.quarantine());
        assert_eq!(rig.quarantined(), rig.charges());
        assert_eq!(rig.active(), ResourceCharges::ZERO);
    }

    #[test]
    fn readiness_reads_are_pure() {
        let rig = Rig::new(1);
        for _ in 0..16 {
            assert_eq!(rig.recovery.readiness(), ProviderReadiness::Ready);
        }
        assert_eq!(rig.backend.cleanup_calls(), 0);
        assert_eq!(rig.backend.probe_calls.load(Ordering::SeqCst), 0);
        assert_eq!(rig.active(), ResourceCharges::ZERO);
        assert_eq!(rig.quarantined(), ResourceCharges::ZERO);
    }

    /// Seeded-defect detector for the readiness/admission race: a gate that
    /// checks readiness and admits in two separate steps would admit a
    /// candidate whose preparation crosses the `Ready`-to-`Recovering`
    /// transition; the atomic gate refuses while a suspect is unresolved
    /// even though admission capacity is free.
    #[test]
    fn ready_gate_admission_is_refused_while_recovering() {
        let rig = Rig::new(2);
        let ready = rig
            .recovery
            .admit_candidate_while_ready(1, &rig.admission, &rig.profile)
            .expect("ready provider admits");
        assert_eq!(ready.admitted_incarnation(), 1);

        // A blocked cleanup keeps the episode open: readiness is
        // `Recovering` while a second candidate's charges would still fit.
        rig.backend.push(Scripted::Block);
        rig.recovery.report_suspect(Arc::clone(&ready));
        wait_for("recovering readiness", || {
            rig.recovery.readiness() == ProviderReadiness::Recovering
        });
        assert!(
            rig.recovery
                .admit_candidate_while_ready(2, &rig.admission, &rig.profile)
                .is_none(),
            "a recovering provider must not admit a new candidate"
        );

        // Clean reclamation resolves the episode; admission reopens with
        // the freshly minted incarnation bound into the custody record.
        rig.backend.release_blocked(CleanupOutcome::Reclaimed);
        wait_for("ready readiness", || {
            rig.recovery.readiness() == ProviderReadiness::Ready
        });
        let reopened = rig
            .recovery
            .admit_candidate_while_ready(3, &rig.admission, &rig.profile)
            .expect("recovered provider admits");
        assert_eq!(reopened.admitted_incarnation(), 2);
        assert!(reopened.release());
    }

    #[test]
    fn clean_reclamation_returns_charges_once_and_mints_a_new_incarnation() {
        let rig = Rig::new(1);
        let record = rig.admit();
        assert_eq!(rig.recovery.incarnation(), 1);
        rig.backend
            .push(Scripted::Return(CleanupOutcome::Reclaimed));
        rig.recovery.report_suspect(Arc::clone(&record));
        wait_for("clean reclamation", || {
            rig.recovery.readiness() == ProviderReadiness::Ready && rig.recovery.incarnation() == 2
        });
        assert_eq!(rig.active(), ResourceCharges::ZERO);
        assert_eq!(rig.quarantined(), ResourceCharges::ZERO);
        assert_eq!(rig.backend.cleanup_calls(), 1);
        assert_eq!(rig.backend.probe_calls.load(Ordering::SeqCst), 1);
        assert_eq!(rig.backend.max_live_cleanups.load(Ordering::SeqCst), 1);
        assert_eq!(rig.recovery.episode(), 1);
        // Cleanup ran on the dedicated recovery thread, not a Tokio or
        // preparation worker (R7).
        assert!(!rig.backend.saw_tokio_worker.load(Ordering::SeqCst));
        assert!(!rig.backend.saw_foreign_thread.load(Ordering::SeqCst));
        // The old incarnation's stale release is rejected exactly.
        assert!(!record.release());
        assert_eq!(record.admitted_incarnation(), 1);
        assert_eq!(rig.active(), ResourceCharges::ZERO);
        // A new candidate is permitted after clean reclamation.
        assert!(rig.admission.can_admit(&rig.profile, None).is_ok());
    }

    #[test]
    fn transient_stale_results_retry_one_call_at_a_time_under_the_original_deadline() {
        let rig = Rig::new(1);
        let record = rig.admit();
        rig.backend
            .push(Scripted::Return(CleanupOutcome::StaleRetry));
        rig.backend
            .push(Scripted::Return(CleanupOutcome::StaleRetry));
        rig.backend
            .push(Scripted::Return(CleanupOutcome::Reclaimed));
        rig.recovery.report_suspect(record);
        wait_for("retried reclamation", || {
            rig.recovery.readiness() == ProviderReadiness::Ready && rig.recovery.incarnation() == 2
        });
        assert_eq!(rig.backend.cleanup_calls(), 3);
        assert_eq!(rig.backend.max_live_cleanups.load(Ordering::SeqCst), 1);
        // Retries stayed inside the one original episode: the deadline was
        // never reset into a new episode.
        assert_eq!(rig.recovery.episode(), 1);
        assert_eq!(rig.active(), ResourceCharges::ZERO);
    }

    #[test]
    fn stale_retries_stop_at_the_immutable_deadline_and_isolate() {
        let rig = Rig::new(1);
        let record = rig.admit();
        rig.backend.set_default(CleanupOutcome::StaleRetry);
        rig.recovery.report_suspect(Arc::clone(&record));
        wait_for("retries running", || rig.backend.cleanup_calls() >= 2);
        // Partway advance (20s of the 30s deadline): retries must keep
        // running under the ORIGINAL deadline. A retry branch that reset
        // `deadline = now() + 30s` here would survive the final advance to
        // 31s below and hang the resolution wait.
        rig.clock.advance(Duration::from_secs(20));
        let calls_partway = rig.backend.cleanup_calls();
        wait_for("retries continue past the partway advance", || {
            rig.backend.cleanup_calls() > calls_partway
        });
        assert_eq!(rig.recovery.readiness(), ProviderReadiness::Recovering);
        rig.clock.advance(Duration::from_secs(11));
        wait_for("deadline resolution", || {
            rig.recovery.readiness() != ProviderReadiness::Recovering
        });
        // Uncertain ownership at the deadline isolates the exact charges;
        // with single-candidate limits nothing else fits, so the provider
        // quarantines.
        assert_eq!(rig.recovery.readiness(), ProviderReadiness::Quarantined);
        assert_eq!(record.phase(), CustodyPhase::Quarantined);
        assert_eq!(rig.quarantined(), rig.charges());
        assert_eq!(rig.active(), ResourceCharges::ZERO);
        // Retries stop after the deadline.
        wait_for("call retirement", || {
            rig.backend.live_cleanups.load(Ordering::SeqCst) == 0
        });
        let settled = rig.backend.cleanup_calls();
        std::thread::sleep(SETTLE);
        assert_eq!(rig.backend.cleanup_calls(), settled);
        assert_eq!(rig.recovery.episode(), 1, "the deadline never restarts");
    }

    #[test]
    fn never_returning_cleanup_suppresses_dispatch_and_resolves_at_the_deadline() {
        let rig = Rig::new(2);
        let first = rig.admit();
        let second = rig.admit();
        rig.backend.push(Scripted::Block);
        rig.recovery.report_suspect(Arc::clone(&first));
        wait_for("blocked call dispatched", || {
            rig.backend.cleanup_calls() == 1
        });
        rig.recovery.report_suspect(Arc::clone(&second));
        std::thread::sleep(SETTLE);
        assert_eq!(
            rig.backend.cleanup_calls(),
            1,
            "no second cleanup call may start while one is live"
        );
        // The controller stays responsive while the call is wedged.
        assert_eq!(rig.recovery.readiness(), ProviderReadiness::Recovering);
        rig.clock
            .advance(RECOVERY_EPISODE_DEADLINE + Duration::from_secs(1));
        wait_for("deadline resolution", || {
            rig.recovery.readiness() != ProviderReadiness::Recovering
        });
        // Both unresolved suspects were isolated with exact charges; the
        // quarantine consumed both slots so admission no longer fits.
        assert_eq!(rig.recovery.readiness(), ProviderReadiness::Quarantined);
        assert_eq!(first.phase(), CustodyPhase::Quarantined);
        assert_eq!(second.phase(), CustodyPhase::Quarantined);
        assert_eq!(rig.quarantined(), charges_times(rig.charges(), 2));
        assert_eq!(rig.active(), ResourceCharges::ZERO);
        // Owner shutdown is bounded: dropping the controller never joins
        // the wedged call.
        let start = std::time::Instant::now();
        drop(rig.recovery.clone());
        assert!(start.elapsed() < Duration::from_secs(1));
        // Late completion after the timeout is fenced out entirely.
        let incarnation = rig.recovery.incarnation();
        rig.backend.release_blocked(CleanupOutcome::Reclaimed);
        wait_for("late call retired", || {
            rig.backend.live_cleanups.load(Ordering::SeqCst) == 0
        });
        std::thread::sleep(SETTLE);
        assert_eq!(rig.recovery.incarnation(), incarnation);
        assert_eq!(rig.recovery.readiness(), ProviderReadiness::Quarantined);
        assert_eq!(rig.quarantined(), charges_times(rig.charges(), 2));
        assert_eq!(rig.active(), ResourceCharges::ZERO);
    }

    #[test]
    fn late_completion_after_a_newer_episode_is_fenced() {
        let rig = Rig::new(3);
        let first = rig.admit();
        rig.backend.push(Scripted::Block);
        rig.recovery.report_suspect(Arc::clone(&first));
        wait_for("blocked call dispatched", || {
            rig.backend.cleanup_calls() == 1
        });
        // Deadline isolates the wedged suspect; with room left the provider
        // returns to Ready while the old call is still live.
        rig.clock
            .advance(RECOVERY_EPISODE_DEADLINE + Duration::from_secs(1));
        wait_for("first episode resolves", || {
            rig.recovery.readiness() == ProviderReadiness::Ready
        });
        assert_eq!(first.phase(), CustodyPhase::Quarantined);
        assert_eq!(rig.recovery.episode(), 1);
        // A newer episode starts, but the live call keeps suppressing
        // dispatch.
        let second = rig.admit();
        rig.recovery.report_suspect(Arc::clone(&second));
        wait_for("second episode opens", || rig.recovery.episode() == 2);
        std::thread::sleep(SETTLE);
        assert_eq!(rig.backend.cleanup_calls(), 1);
        assert_eq!(rig.recovery.readiness(), ProviderReadiness::Recovering);
        // The stale episode-1 result is ignored: no charge return, no
        // incarnation mint. Its retirement lets episode 2 dispatch.
        rig.backend.release_blocked(CleanupOutcome::Reclaimed);
        wait_for("second episode resolves", || {
            rig.recovery.readiness() == ProviderReadiness::Ready
        });
        assert_eq!(rig.recovery.incarnation(), 1);
        assert_eq!(first.phase(), CustodyPhase::Quarantined);
        assert_eq!(second.phase(), CustodyPhase::Quarantined);
        assert_eq!(rig.backend.cleanup_calls(), 2);
        assert_eq!(rig.quarantined(), charges_times(rig.charges(), 2));
        assert_eq!(rig.active(), ResourceCharges::ZERO);
    }

    #[test]
    fn provider_wide_uncertainty_quarantines_and_isolates_new_suspects_directly() {
        let rig = Rig::new(3);
        let first = rig.admit();
        let second = rig.admit();
        rig.backend.probe_ok.store(false, Ordering::SeqCst);
        rig.recovery.report_suspect(Arc::clone(&first));
        wait_for("provider-wide uncertainty", || {
            rig.recovery.readiness() == ProviderReadiness::Quarantined
        });
        // Admission still fits, so only the failed probe explains the
        // terminal state.
        assert!(rig.admission.can_admit(&rig.profile, None).is_ok());
        assert_eq!(first.phase(), CustodyPhase::Quarantined);
        let calls = rig.backend.cleanup_calls();
        // A suspect reported after quarantine is isolated directly: no new
        // episode, no cleanup call, charges retained exactly.
        rig.recovery.report_suspect(Arc::clone(&second));
        wait_for("direct isolation", || {
            second.phase() == CustodyPhase::Quarantined
        });
        assert_eq!(rig.backend.cleanup_calls(), calls);
        assert_eq!(rig.recovery.episode(), 1);
        assert_eq!(rig.quarantined(), charges_times(rig.charges(), 2));
        assert_eq!(rig.active(), ResourceCharges::ZERO);
    }

    #[test]
    fn suspect_reports_deduplicate() {
        let rig = Rig::new(1);
        let record = rig.admit();
        rig.backend.push(Scripted::Block);
        rig.recovery.report_suspect(Arc::clone(&record));
        wait_for("blocked call dispatched", || {
            rig.backend.cleanup_calls() == 1
        });
        rig.recovery.report_suspect(Arc::clone(&record));
        rig.backend.release_blocked(CleanupOutcome::Reclaimed);
        wait_for("reclamation", || {
            rig.recovery.readiness() == ProviderReadiness::Ready
        });
        std::thread::sleep(SETTLE);
        assert_eq!(
            rig.backend.cleanup_calls(),
            1,
            "duplicate report deduplicated"
        );
        assert_eq!(rig.recovery.incarnation(), 2);
    }

    #[test]
    fn suspect_inbox_overflow_isolates_directly_without_growing_the_inbox() {
        let total = (SUSPECT_INBOX_BOUND + 2) as u64;
        let rig = Rig::new(total);
        rig.backend.push(Scripted::Block);
        let wedged = rig.admit();
        rig.recovery.report_suspect(Arc::clone(&wedged));
        wait_for("blocked call dispatched", || {
            rig.backend.cleanup_calls() == 1
        });
        let queued: Vec<_> = (0..SUSPECT_INBOX_BOUND).map(|_| rig.admit()).collect();
        for record in &queued {
            rig.recovery.report_suspect(Arc::clone(record));
        }
        // The inbox is at its bound: the next distinct suspect must be
        // isolated synchronously with its exact charges instead of growing
        // host memory — no new episode and no additional cleanup dispatch.
        let overflow = rig.admit();
        rig.recovery.report_suspect(Arc::clone(&overflow));
        assert_eq!(overflow.phase(), CustodyPhase::Quarantined);
        assert_eq!(rig.quarantined(), rig.charges());
        assert_eq!(rig.backend.cleanup_calls(), 1);
        assert_eq!(rig.recovery.episode(), 1);
        assert_eq!(rig.recovery.readiness(), ProviderReadiness::Recovering);
        for record in &queued {
            assert_eq!(record.phase(), CustodyPhase::Active);
        }
        // Deadline resolution isolates exactly the wedged call plus the
        // bounded inbox; the overflow record is never double-counted.
        rig.clock
            .advance(RECOVERY_EPISODE_DEADLINE + Duration::from_secs(1));
        wait_for("deadline resolution", || {
            rig.recovery.readiness() != ProviderReadiness::Recovering
        });
        assert_eq!(rig.quarantined(), charges_times(rig.charges(), total));
        assert_eq!(rig.active(), ResourceCharges::ZERO);
    }
}
