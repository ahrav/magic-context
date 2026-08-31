//!
//! `CandidateCustody` owns candidate identity, exact admission charges, and cleanup authority until release or quarantine; aggregate counters never reconstruct ownership.
//! `ProviderRecovery` dispatches at most one cleanup call at a time.
//! The controller runs cleanup on a detached OS thread, never on a Tokio request or provider preparation worker.
//! Each recovery episode uses one injected, immutable 30-second deadline.
//! A cleanup call may outlive controller shutdown without being joined and publishes a result only when its episode and provider incarnation still match.
//!
//! Readiness governs new offers only; existing candidates serve and release under their own owners regardless of state changes.
//! The module does not format or log provider descriptors, grants, tokens, object names, or addresses.

use std::collections::VecDeque;
use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use mc_shm_transport::profile::{Admission, QuarantineRecord};

/// Each recovery episode uses a fixed 30-second deadline that retries, observations, and late results cannot extend.
/// results.
pub const RECOVERY_EPISODE_DEADLINE: Duration = Duration::from_secs(30);

/// `SUSPECT_INBOX_BOUND` limits suspects queued behind a wedged cleanup call; overflow immediately isolates the incoming record instead of increasing host memory use.
const SUSPECT_INBOX_BOUND: usize = 8;

const CLEANUP_RETRY_DELAY: Duration = Duration::from_millis(50);

/// Preflight may offer a provider only when `ProviderReadiness` is `Ready`; readiness never invalidates existing candidates.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderReadiness {
    /// `Recovering` reclaims or isolates suspect candidates.
    Recovering,
    Ready,
    /// `Quarantined` blocks new offers but retains visible charges.
    Quarantined,
}

/// `RecoveryClock` lets tests control episode deadlines with a monotonic clock.
pub trait RecoveryClock: Send + Sync + 'static {
    /// `now` returns the monotonic offset from the clock's origin.
    fn now(&self) -> Duration;
    /// `wait_until` blocks until `now() >= deadline`.
    fn wait_until(&self, deadline: Duration);
}

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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CleanupOutcome {
    /// `Reclaimed` proves stale resources are gone and permits active charges to return.
    Reclaimed,
    /// `StaleRetry` retries transient stale state under the original deadline.
    StaleRetry,
    /// `Uncertain` isolates candidates whose ownership cannot be proven.
    Uncertain,
}

/// Only the recovery controller invokes these primitives.
pub trait RecoveryBackend: Send + Sync + 'static {
    /// cleanup may block while best-effort cleaning one suspect candidate.
    fn cleanup(&self, candidate_id: u64) -> CleanupOutcome;
    /// The probe must not create provider resources.
    /// The probe must not consume or release provider resources.
    fn probe(&self) -> bool;
    /// admission_fits uses frozen host limits.
    /// admission_fits uses only immutable admission facts.
    fn admission_fits(&self) -> bool;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CustodyPhase {
    Active,
    Released,
    Quarantined,
}

enum CustodyState {
    Active(Admission),
    Released,
    // A retained record keeps the candidate's charges host-accounted.
    // `None` indicates aggregate accounting failed.
    // Quarantined storage is never reused.
    Quarantined { _retained: Option<QuarantineRecord> },
}

/// Release and quarantine execute at most once.
/// A repeated release leaves aggregate counters unchanged.
pub struct CandidateCustody {
    candidate_id: u64,
    incarnation: u64,
    state: Mutex<CustodyState>,
}

impl CandidateCustody {
    pub fn candidate_id(&self) -> u64 {
        self.candidate_id
    }

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

    /// Releasing an active record returns its charges once.
    /// Repeated releases are rejected and leave aggregate counters untouched.
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

    /// quarantine retains the candidate's exact quarantine charges.
    /// Quarantine permanently prevents this record's storage from being reused.
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
        formatter
            .debug_struct("CandidateCustody")
            .field("candidate_id", &self.candidate_id)
            .field("phase", &self.phase())
            .finish_non_exhaustive()
    }
}

/// The controller discards cleanup results unless their episode remains open.
/// The controller accepts a cleanup result only when its provider incarnation matches.
/// matches (KTD5).
#[derive(Clone, Copy, PartialEq, Eq)]
struct EpisodeFence {
    episode: u64,
    incarnation: u64,
}

struct RecoveryState {
    readiness: ProviderReadiness,
    /// Each episode has a monotonic identity.
    episode: u64,
    episode_open: bool,
    /// Each episode has an immutable deadline in clock time.
    deadline: Duration,
    /// A clean reclamation mints the next monotonic provider incarnation.
    incarnation: u64,
    inbox: VecDeque<Arc<CandidateCustody>>,
    /// `cleanup_live` remains true until the dispatched cleanup call returns.
    /// A wedged cleanup call suppresses dispatch after episode resolution.
    cleanup_live: bool,
    /// `inflight` holds the record until the live call resolves or the deadline watcher isolates it.
    inflight: Option<Arc<CandidateCustody>>,
}

struct RecoveryShared {
    backend: Arc<dyn RecoveryBackend>,
    clock: Arc<dyn RecoveryClock>,
    retry_delay: Duration,
    state: Mutex<RecoveryState>,
}

/// Cloning shares the controller; dropping all clones never joins a live cleanup call.
#[derive(Clone)]
pub struct ProviderRecovery {
    shared: Arc<RecoveryShared>,
}

impl ProviderRecovery {
    /// A provider with no suspects starts `Ready`.
    pub fn new(backend: Arc<dyn RecoveryBackend>, clock: Arc<dyn RecoveryClock>) -> Self {
        Self::with_retry_delay(backend, clock, CLEANUP_RETRY_DELAY)
    }

    /// `retry_delay` sets the real-time delay between cleanup retries.
    /// The episode deadline comes from the injected clock.
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

    pub fn readiness(&self) -> ProviderReadiness {
        self.shared.state.lock().expect("recovery lock").readiness
    }

    /// `incarnation` returns the current monotonic provider incarnation.
    pub fn incarnation(&self) -> u64 {
        self.shared.state.lock().expect("recovery lock").incarnation
    }

    /// `episode` returns the monotonic count of started recovery episodes.
    pub fn episode(&self) -> u64 {
        self.shared.state.lock().expect("recovery lock").episode
    }

    /// `admit_candidate` transfers admission charges into a lifecycle record bound to the current provider incarnation before exposing the candidate.
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

    /// `admit_candidate_while_ready` holds the recovery lock while checking `Ready`, admitting charges, and binding custody, preventing another suspect from changing readiness before admission.
    /// A candidate admitted through this gate was admitted while the provider was `Ready`.
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
        // Lock acquisition order is recovery, then custody, then admission accounting; no path acquires the admission lock first.
        let charges = admission.admit(profile, None).ok()?;
        Some(Arc::new(CandidateCustody {
            candidate_id,
            incarnation: state.incarnation,
            state: Mutex::new(CustodyState::Active(charges)),
        }))
    }

    /// `report_suspect` adds one suspect record to the bounded, deduplicated inbox and starts or continues recovery.
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
            // Released or isolated records have no charges left to recover.
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
            // A terminal record is isolated directly; its charges remain visible, and no recovery episode or cleanup call is created.
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
        state.deadline = shared.clock.now().saturating_add(RECOVERY_EPISODE_DEADLINE);
        state.readiness = ProviderReadiness::Recovering;
        let watcher = Arc::clone(shared);
        let episode = state.episode;
        let deadline = state.deadline;
        // The watcher is detached and never joined; under the system clock, it lives at most one deadline.
        let _ = std::thread::Builder::new()
            .name("mc-host-provider-recovery-deadline".to_owned())
            .spawn(move || Self::run_deadline(&watcher, episode, deadline));
        Self::maybe_dispatch(shared, state);
    }

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
        // Cleanup runs on a detached OS thread, not a Tokio request worker or provider preparation worker.
        // A wedged call occupies only its detached OS thread.
        // The caller never waits for the cleanup thread; a failed spawn is indistinguishable from a non-returning call because the episode deadline resolves readiness.
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
            // A cleanup panic leaves candidate ownership uncertain.
            // diagnostic surfaces.
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                crate::panic_boundary::redact_sync(|| shared.backend.cleanup(record.candidate_id()))
            }))
            .unwrap_or(CleanupOutcome::Uncertain);
            let mut state = shared.state.lock().expect("recovery lock");
            if !Self::fence_holds(&state, fence) {
                // A result arriving after the episode deadline resolves or after a new incarnation is minted cannot be published.
                // Publishing a result from a prior incarnation could revive charges already released or quarantined.
                // Publishing a late result could revive charges already released or quarantined.
                Self::retire_call(shared, &mut state);
                return;
            }
            if outcome == CleanupOutcome::StaleRetry && shared.clock.now() < state.deadline {
                // Retries retain the original deadline; sleeping never extends it.
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
                    // `incarnation` advances only after `record.release()` succeeds.
                    // Incrementing `incarnation` rejects stale releases and results carrying the prior incarnation.
                    if record.release() {
                        state.incarnation += 1;
                    }
                }
                // `StaleRetry` at the immutable deadline and every `Uncertain` outcome isolate the candidate with its existing charges.
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
        // The resolver closes the episode and resolves readiness after releasing the lock because the probe calls provider code.
        state.episode_open = false;
        let episode = state.episode;
        drop(state);
        Self::resolve_readiness(shared, episode);
    }

    fn resolve_readiness(shared: &Arc<Self>, episode: u64) {
        // The non-destructive probe proves that isolation held.
        // A panicking probe creates provider-wide uncertainty.
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
                // Suspects reported during resolution start a separate episode with a separate immutable deadline.
                Self::start_episode(shared, &mut state);
            }
        } else {
            // Provider-wide uncertainty and admission-cap exhaustion are terminal for new offers; charges remain visible.
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
        // When the immutable deadline expires with unresolved suspects, the resolver isolates them.
        // The resolver must not dispatch another record while the original cleanup can still return.
        // The late cleanup result fails the episode fence.
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

    /// The atomic gate rejects admission while a suspect remains unresolved, even when capacity is free.
    #[test]
    fn ready_gate_admission_is_refused_while_recovering() {
        let rig = Rig::new(2);
        let ready = rig
            .recovery
            .admit_candidate_while_ready(1, &rig.admission, &rig.profile)
            .expect("ready provider admits");
        assert_eq!(ready.admitted_incarnation(), 1);

        // A blocked cleanup keeps the episode open, so readiness remains `Recovering` although a second candidate's charges fit.
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

        // With an empty inbox, reclamation closes the episode before probing readiness.
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
        assert!(!rig.backend.saw_tokio_worker.load(Ordering::SeqCst));
        assert!(!rig.backend.saw_foreign_thread.load(Ordering::SeqCst));
        assert!(!record.release());
        assert_eq!(record.admitted_incarnation(), 1);
        assert_eq!(rig.active(), ResourceCharges::ZERO);
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
        // Retries remain in the original episode and retain its original deadline.
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
        // Retries retain the original 30 s deadline.
        // Retries do not reset the deadline to `now() + 30s`.
        // A reset deadline would delay resolution past the original 30 s deadline.
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
        // At the deadline, uncertain ownership quarantines the exact charges, preventing admission under single-candidate limits.
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
        // The deadline resolves the episode without waiting for cleanup.
        assert_eq!(rig.recovery.readiness(), ProviderReadiness::Recovering);
        rig.clock
            .advance(RECOVERY_EPISODE_DEADLINE + Duration::from_secs(1));
        wait_for("deadline resolution", || {
            rig.recovery.readiness() != ProviderReadiness::Recovering
        });
        // Both unresolved suspects were isolated with their exact charges, consuming both slots and preventing admission.
        assert_eq!(rig.recovery.readiness(), ProviderReadiness::Quarantined);
        assert_eq!(first.phase(), CustodyPhase::Quarantined);
        assert_eq!(second.phase(), CustodyPhase::Quarantined);
        assert_eq!(rig.quarantined(), charges_times(rig.charges(), 2));
        assert_eq!(rig.active(), ResourceCharges::ZERO);
        // Dropping the controller never joins a wedged cleanup.
        let start = std::time::Instant::now();
        drop(rig.recovery.clone());
        assert!(start.elapsed() < Duration::from_secs(1));
        // The stale completion returns no charges and does not increment incarnation.
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
        // The deadline isolates the wedged suspect; because capacity remains, the provider returns to `Ready` while the old cleanup call remains live.
        rig.clock
            .advance(RECOVERY_EPISODE_DEADLINE + Duration::from_secs(1));
        wait_for("first episode resolves", || {
            rig.recovery.readiness() == ProviderReadiness::Ready
        });
        assert_eq!(first.phase(), CustodyPhase::Quarantined);
        assert_eq!(rig.recovery.episode(), 1);
        // The live episode-1 cleanup call suppresses episode-2 cleanup dispatch.
        // dispatch.
        let second = rig.admit();
        rig.recovery.report_suspect(Arc::clone(&second));
        wait_for("second episode opens", || rig.recovery.episode() == 2);
        std::thread::sleep(SETTLE);
        assert_eq!(rig.backend.cleanup_calls(), 1);
        assert_eq!(rig.recovery.readiness(), ProviderReadiness::Recovering);
        // The stale episode-1 result returns no charges and does not increment incarnation.
        // Retiring the stale episode-1 cleanup call lets episode 2 dispatch.
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
        // A failed probe transitions the provider to `Quarantined` even when admission fits.
        // terminal state.
        assert!(rig.admission.can_admit(&rig.profile, None).is_ok());
        assert_eq!(first.phase(), CustodyPhase::Quarantined);
        let calls = rig.backend.cleanup_calls();
        // A suspect reported after quarantine is isolated directly without starting a new episode.
        // Direct isolation starts no episode or cleanup call and retains the suspect's charges.
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
        // When the inbox reaches its bound, the next distinct suspect is isolated synchronously.
        // The overflow suspect is isolated synchronously without growing the inbox.
        // The overflow suspect starts no episode and dispatches no additional cleanup.
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
        // Deadline resolution isolates the blocked suspect and every record in the bounded inbox.
        // Deadline resolution does not double-count the overflow record.
        rig.clock
            .advance(RECOVERY_EPISODE_DEADLINE + Duration::from_secs(1));
        wait_for("deadline resolution", || {
            rig.recovery.readiness() != ProviderReadiness::Recovering
        });
        assert_eq!(rig.quarantined(), charges_times(rig.charges(), total));
        assert_eq!(rig.active(), ResourceCharges::ZERO);
    }
}
