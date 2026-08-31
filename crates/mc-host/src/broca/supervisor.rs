//! The supervisor bounds process-local runs.
//!
//! The shared index lock linearizes deduplication, capacity release, and deletion across session and run-ID lookups.
//! Each `Run` lock is acquired after the index lock and is never held across an await.
//!
//! `Released` drops charges and permits after releasing the index lock because dropping `ByteCharge` acquires the budget waiter lock.
//! admission.
//!
//! Run state is process-local; after restart, every prior run ID resolves to `missing`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use sha2::{Digest, Sha256};
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use super::backend::{
    BackendError, BackendEvent, BackendRequest, BackendTerminal, ErrorClass, EventSink, Harness,
    LlmExecutionBackend, SinkStatus,
};
use super::config::{BrocaLimits, TERMINAL_HEADROOM_BYTES};
use super::protocol::{self, RequestError, SendRequest};
use crate::wire::{ByteBudget, ByteCharge};

/// `SessionKey` scopes route claims and grants no authority beyond the authenticated host bearer.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct SessionKey {
    pub project_root: std::path::PathBuf,
    pub harness: Harness,
    pub session: String,
}

impl std::fmt::Debug for SessionKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionKey")
            .field("project_root_len", &self.project_root.as_os_str().len())
            .field("harness", &self.harness)
            .field("session_len", &self.session.len())
            .finish()
    }
}

impl SessionKey {
    /// `meta_bytes` charges each identity string three times because the session map, `Run`, and `BackendRequest` each retain a copy; tombstones remain overcharged to keep the budget a ceiling.
    fn meta_bytes(&self) -> usize {
        const KEY_META_OVERHEAD_BYTES: usize = 128;
        self.project_root
            .as_os_str()
            .len()
            .saturating_add(self.session.len())
            .saturating_mul(3)
            .saturating_add(KEY_META_OVERHEAD_BYTES)
    }
}

fn app(code: &'static str, message: &str) -> RequestError {
    RequestError {
        code,
        message: message.to_owned(),
    }
}

fn closed_error() -> RequestError {
    app("cancelled", "the host is shutting down")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Status {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl Status {
    fn as_str(self) -> &'static str {
        match self {
            Self::Queued => protocol::STATUS_QUEUED,
            Self::Running => protocol::STATUS_RUNNING,
            Self::Completed => protocol::STATUS_COMPLETED,
            Self::Failed => protocol::STATUS_FAILED,
            Self::Cancelled => protocol::STATUS_CANCELLED,
        }
    }
}

/// `finish` uses first-terminal-append-wins, so completion cannot overwrite cancellation.
enum TerminalOutcome {
    Backend(BackendTerminal),
    Cancelled { message: &'static str },
}

struct RunState {
    status: Status,
    /// `Arc` lets subscribers clone replay frames without copying bytes; only a terminal append closes the log.
    /// Each replay frame retains its own byte charge while subscriber clones retain the frame.
    replay: Vec<Arc<ReplayFrame>>,
    /// Only backend-event bytes count toward `replay_bytes`; `run_started` and terminal units use pre-charged terminal headroom.
    replay_bytes: usize,
    started_appended: bool,
    terminal_appended: bool,
    subscriber_count: usize,
    /// The run task has fully stopped (backend returned or never started).
    /// Cancel and delete wait for `work_done` so no backend work outlives their completion.
    /// completion (R10).
    work_done: bool,
    /// `work_unresolved` means the backend could not prove its process tree stopped; descendants may still execute a billable request.
    /// `work_done` does not prove descendants stopped; they may still execute a billable request.
    /// Cancel and delete report failure if descendants may still execute a billable request.
    work_unresolved: bool,
    /// `purged` removes the run from both indices; subscribers detach instead of replaying its log.
    /// A subscriber-held frame retains its charge until the subscriber drops it.
    purged: bool,
    completed_at: Option<Instant>,
    /// `run_permit` is held from admission through terminal commitment, enforcing the run cap.
    run_permit: Option<OwnedSemaphorePermit>,
    /// `base_charge` covers immutable request bytes, key metadata, and terminal headroom.
    /// `base_charge` shrinks to the retained remainder at terminal commitment.
    base_charge: ByteCharge,
}

/// `ReplayFrame` retains encoded bytes and their `ByteCharge`, so held frames remain accounted.
/// The `Arc` owns both the bytes and their charge, so purging releases only unheld frames.
/// Between `Subscription::next()` and the stream write, a subscriber-held frame remains charged.
/// The byte budget returns only when the last holder drops the frame.
pub struct ReplayFrame {
    bytes: Box<[u8]>,
    _charge: ByteCharge,
}

impl ReplayFrame {
    fn uncharged(bytes: Vec<u8>) -> Arc<Self> {
        Arc::new(Self {
            bytes: bytes.into(),
            _charge: ByteCharge::none(),
        })
    }
}

impl std::ops::Deref for ReplayFrame {
    type Target = [u8];

    fn deref(&self) -> &[u8] {
        &self.bytes
    }
}

impl std::fmt::Debug for ReplayFrame {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReplayFrame")
            .field("len", &self.bytes.len())
            .finish()
    }
}

struct Run {
    run_id: String,
    key: SessionKey,
    /// `fingerprint` is the SHA-256 of the exact `session.send` body bytes.
    /// byte-identical resend matches, anything else conflicts.
    fingerprint: [u8; 32],
    state: Mutex<RunState>,
    notify: Notify,
    cancel: CancellationToken,
}

/// A tombstone blocks session resurrection until retention expires and keeps its metadata charged.
struct Tombstone {
    created_at: Instant,
    _charge: ByteCharge,
}

enum SessionEntry {
    Live(Arc<Run>),
    Tombstone(Tombstone),
}

struct Index {
    sessions: HashMap<SessionKey, SessionEntry>,
    runs: HashMap<String, Arc<Run>>,
    next_seq: u64,
    closed: bool,
}

/// `Released` detaches charges, permits, replay buffers, and tombstones under the index lock.
/// `Released` releases detached resources only after dropping the index lock to avoid waiter-lock nesting.
#[derive(Default)]
struct Released {
    charges: Vec<ByteCharge>,
    permits: Vec<OwnedSemaphorePermit>,
    replays: Vec<Vec<Arc<ReplayFrame>>>,
    tombstones: Vec<Tombstone>,
}

struct Inner {
    limits: BrocaLimits,
    backend: Arc<dyn LlmExecutionBackend>,
    /// Each run ID includes a random per-incarnation fence, so a stale ID from a previous process resolves to `missing`, never a live run.
    /// (R11/KTD12).
    incarnation: String,
    index: Mutex<Index>,
    commands: Arc<Semaphore>,
    run_slots: Arc<Semaphore>,
    subscribers: Arc<Semaphore>,
    backends: Arc<Semaphore>,
    /// Broca retains a nonblocking 64 MiB reservation.
    /// Ingress bodies and parser scratch use host charges.
    retained: ByteBudget,
    tracker: TaskTracker,
    closing: CancellationToken,
}

/// Tests use this read-only capacity snapshot to prove every permit and byte charge returns exactly to baseline across all failure paths.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SupervisorMetrics {
    pub free_command_permits: usize,
    pub free_run_slots: usize,
    pub free_subscriber_permits: usize,
    pub free_backend_permits: usize,
    pub retained_bytes_available: usize,
    pub retained_bytes_capacity: usize,
    pub sessions: usize,
    pub live_runs: usize,
    pub tombstones: usize,
}

pub struct Supervisor {
    inner: Arc<Inner>,
}

/// Every index operation recovers the index lock from poisoning.
/// as `synapse::jobs::JobTable::lock_jobs`.
fn lock_index(inner: &Inner) -> MutexGuard<'_, Index> {
    inner
        .index
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn lock_run(run: &Run) -> MutexGuard<'_, RunState> {
    run.state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl Supervisor {
    pub fn new(backend: Arc<dyn LlmExecutionBackend>) -> Self {
        Self::with_limits(backend, BrocaLimits::default())
    }

    /// Tests use shrunken caps to reach eviction, overflow, and saturation without materializing production-sized state.
    pub fn with_limits(backend: Arc<dyn LlmExecutionBackend>, limits: BrocaLimits) -> Self {
        let mut nonce = [0u8; 8];
        // `incarnation` prevents deterministic run-ID collisions when sequence numbers restart.
        getrandom::getrandom(&mut nonce).expect("OS entropy for the run incarnation");
        Self {
            inner: Arc::new(Inner {
                backend,
                incarnation: nonce.iter().map(|b| format!("{b:02x}")).collect(),
                index: Mutex::new(Index {
                    sessions: HashMap::new(),
                    runs: HashMap::new(),
                    next_seq: 1,
                    closed: false,
                }),
                commands: Arc::new(Semaphore::new(limits.max_command_callbacks)),
                run_slots: Arc::new(Semaphore::new(limits.max_active_runs)),
                subscribers: Arc::new(Semaphore::new(limits.max_total_subscribers)),
                backends: Arc::new(Semaphore::new(limits.max_backend_processes)),
                retained: ByteBudget::new(limits.max_retained_bytes),
                tracker: TaskTracker::new(),
                closing: CancellationToken::new(),
                limits,
            }),
        }
    }

    ///
    pub fn harness_unavailable_reason(&self, harness: Harness) -> Option<&'static str> {
        self.inner.backend.unavailable_reason(harness)
    }

    pub fn metrics(&self) -> SupervisorMetrics {
        let inner = &self.inner;
        let index = lock_index(inner);
        let tombstones = index
            .sessions
            .values()
            .filter(|entry| matches!(entry, SessionEntry::Tombstone(_)))
            .count();
        SupervisorMetrics {
            free_command_permits: inner.commands.available_permits(),
            free_run_slots: inner.run_slots.available_permits(),
            free_subscriber_permits: inner.subscribers.available_permits(),
            free_backend_permits: inner.backends.available_permits(),
            retained_bytes_available: inner.retained.available(),
            retained_bytes_capacity: inner.retained.capacity(),
            sessions: index.sessions.len(),
            live_runs: index.runs.len(),
            tombstones,
        }
    }

    /// One non-subscription command slot is held by RAII for the callback.
    /// `try_acquire` rejects immediately instead of waiting behind blocked settlement.
    fn command_permit(&self) -> Result<OwnedSemaphorePermit, RequestError> {
        Arc::clone(&self.inner.commands)
            .try_acquire_owned()
            .map_err(|_| app("queue_full", "command callback capacity is exhausted"))
    }

    ///
    /// Admission acquires the command permit, candidate active-run reservation, and retained-byte reservation before publishing both indices under the lock.
    /// `session.send` publishes neither index unless both reservations succeed.
    /// The spawned run task, not admission, waits for a backend permit.
    /// The stored fingerprint uses the exact request bytes in `body`.
    /// The stored fingerprint makes byte-identical retries idempotent.
    pub fn send(
        &self,
        key: &SessionKey,
        request: SendRequest,
        body: &[u8],
    ) -> Result<String, RequestError> {
        let inner = &self.inner;
        let _command = self.command_permit()?;
        let fingerprint: [u8; 32] = Sha256::digest(body).into();
        let base_bytes = request
            .retained_bytes()
            .saturating_add(key.meta_bytes())
            .saturating_add(TERMINAL_HEADROOM_BYTES);

        // Admission sweeps expired entries outside the lock and retries once under retained-byte pressure.
        let run_permit = Arc::clone(&inner.run_slots).try_acquire_owned().ok();
        let charge = match inner.retained.try_charge(base_bytes) {
            Some(charge) => Some(charge),
            None => {
                self.pressure_sweep();
                inner.retained.try_charge(base_bytes)
            }
        };

        // Rust drops the guard before the candidate reservation because the candidate reservation is declared first.
        let mut released = Released::default();
        let mut index = lock_index(inner);
        if index.closed {
            return Err(closed_error());
        }
        self.sweep_expired(&mut index, &mut released);
        // Admission checks byte-identical requests for deduplication before checking capacity.
        // A resend of an existing run returns its ID even when every candidate reservation fails.
        match index.sessions.get(key) {
            Some(SessionEntry::Live(run)) => {
                return if run.fingerprint == fingerprint {
                    Ok(run.run_id.clone())
                } else {
                    Err(app(
                        "idempotency_conflict",
                        "the session already holds a different immutable run",
                    ))
                };
            }
            Some(SessionEntry::Tombstone(_)) => {
                // A late send cannot resurrect a deleted session while its tombstone is retained.
                return Err(app(
                    "session_deleted",
                    "the session was deleted and cannot be reused yet",
                ));
            }
            None => {}
        }
        let Some(run_permit) = run_permit else {
            return Err(app("queue_full", "active-run capacity is exhausted"));
        };
        let Some(mut charge) = charge else {
            return Err(app("queue_full", "retained-byte capacity is exhausted"));
        };

        let seq = index.next_seq;
        index.next_seq += 1;
        let run_id = format!("broca-{}-{seq}", inner.incarnation);
        let run = Arc::new(Run {
            run_id: run_id.clone(),
            key: key.clone(),
            fingerprint,
            state: Mutex::new(RunState {
                status: Status::Queued,
                replay: Vec::new(),
                replay_bytes: 0,
                started_appended: false,
                terminal_appended: false,
                subscriber_count: 0,
                work_done: false,
                work_unresolved: false,
                purged: false,
                completed_at: None,
                run_permit: Some(run_permit),
                base_charge: charge.split_or_take(base_bytes),
            }),
            notify: Notify::new(),
            cancel: CancellationToken::new(),
        });
        index
            .sessions
            .insert(key.clone(), SessionEntry::Live(Arc::clone(&run)));
        index.runs.insert(run_id.clone(), Arc::clone(&run));
        // Holding the index lock while spawning prevents shutdown from closing the tracker before every visible run task registers.
        // Shutdown sets `closed` under the index lock before closing the tracker.
        // The tracker drain waits for every run task registered while the index lock is held.
        self.spawn_run(run, request);
        Ok(run_id)
    }

    /// A known run reports its state verbatim; all other run IDs report `missing`.
    /// Foreign-incarnation, expired, evicted, deleted, and unknown run IDs report `missing`.
    pub fn status(&self, key: &SessionKey, run_id: &str) -> Result<&'static str, RequestError> {
        let _command = self.command_permit()?;
        let mut released = Released::default();
        let mut index = lock_index(&self.inner);
        if index.closed {
            return Err(closed_error());
        }
        self.sweep_expired(&mut index, &mut released);
        match index.runs.get(run_id) {
            // Run IDs are sequential within an incarnation; callers must not distinguish runs outside their bound session from unknown runs.
            // A leaked run ID makes adjacent IDs guessable, so runs outside the caller's bound session report `missing`.
            Some(run) if run.key == *key => Ok(lock_run(run).status.as_str()),
            _ => Ok(protocol::STATUS_MISSING),
        }
    }

    /// A successful cancel resolves only after the run's task has fully stopped, so no backend work outlives it.
    /// An unknown, expired, or already-terminal run succeeds without effect.
    /// overwritten.
    pub async fn cancel(&self, key: &SessionKey, run_id: &str) -> Result<(), RequestError> {
        let _command = self.command_permit()?;
        let run = {
            let mut released = Released::default();
            let mut index = lock_index(&self.inner);
            if index.closed {
                return Err(closed_error());
            }
            self.sweep_expired(&mut index, &mut released);
            // A run outside the bound session cancels nothing and returns the unknown-run no-op.
            index
                .runs
                .get(run_id)
                .filter(|run| run.key == *key)
                .cloned()
        };
        let Some(run) = run else { return Ok(()) };
        run.cancel.cancel();
        finish(
            &self.inner,
            &run,
            TerminalOutcome::Cancelled {
                message: "run cancelled",
            },
        );
        wait_work_done(&run).await;
        Self::unresolved_teardown_error(&run)
    }

    /// Cancels a live run, waits for its task, purges replay and charges, and installs a bounded tombstone.
    /// Delete installs a bounded tombstone; a second delete has no effect.
    /// side-effect free.
    pub async fn delete(&self, key: &SessionKey) -> Result<(), RequestError> {
        let _command = self.command_permit()?;
        let run = {
            let mut released = Released::default();
            let mut index = lock_index(&self.inner);
            if index.closed {
                return Err(closed_error());
            }
            self.sweep_expired(&mut index, &mut released);
            match index.sessions.get(key) {
                Some(SessionEntry::Live(run)) => Arc::clone(run),
                // Deleting a tombstoned or nonexistent session succeeds without purging state.
                Some(SessionEntry::Tombstone(_)) | None => return Ok(()),
            }
        };
        run.cancel.cancel();
        finish(
            &self.inner,
            &run,
            TerminalOutcome::Cancelled {
                message: "session deleted",
            },
        );
        // Reserve tombstone capacity before waiting so eviction cannot consume the deletion guard's budget.
        let reserved_tombstone = self.inner.retained.try_charge(key.meta_bytes());
        wait_work_done(&run).await;

        let mut released = Released::default();
        let mut index = lock_index(&self.inner);
        // Only the delete that still owns `run` purges it, preventing double release.
        let same_run = matches!(
            index.sessions.get(key),
            Some(SessionEntry::Live(current)) if Arc::ptr_eq(current, &run)
        );
        if same_run {
            if let Some(charge) = reserved_tombstone {
                released.charges.push(charge);
            }
            index.sessions.remove(key);
            index.runs.remove(&run.run_id);
            let mut state = lock_run(&run);
            state.purged = true;
            // Splitting `state.base_charge` under the index lock prevents a budget gap while replacing the run with a tombstone.
            let tombstone_charge = state.base_charge.split_or_take(key.meta_bytes());
            released.charges.push(std::mem::replace(
                &mut state.base_charge,
                ByteCharge::none(),
            ));
            released.replays.push(std::mem::take(&mut state.replay));
            drop(state);
            index.sessions.insert(
                key.clone(),
                SessionEntry::Tombstone(Tombstone {
                    created_at: Instant::now(),
                    _charge: tombstone_charge,
                }),
            );
            run.notify.notify_waiters();
        } else if !index.sessions.contains_key(key) {
            // Install a tombstone if `run` was removed during `wait_work_done` so the deletion guard remains present.
            // Use the reservation taken before the wait because the removed run's charges have already been released.
            // Install an uncharged tombstone if both charge attempts fail rather than omit the deletion guard.
            // Do not replace a different live run; it was installed after this run was removed.
            // tombstone.
            let charge = reserved_tombstone
                .or_else(|| self.inner.retained.try_charge(key.meta_bytes()))
                .unwrap_or_else(ByteCharge::none);
            index.sessions.insert(
                key.clone(),
                SessionEntry::Tombstone(Tombstone {
                    created_at: Instant::now(),
                    _charge: charge,
                }),
            );
            // Run the terminal-session cap with the new tombstone protected so the cap cannot evict it.
            enforce_terminal_cap(&self.inner, &mut index, "", Some(key), &mut released);
        } else if let Some(charge) = reserved_tombstone {
            released.charges.push(charge);
        }
        drop(index);
        // Retained bytes remain bounded whether tombstone charging succeeds or fails.
        Self::unresolved_teardown_error(&run)
    }

    /// Return a teardown error when the backend cannot prove that its process tree stopped.
    /// `work_done` proves only that the run task returned, not that the backend process tree stopped.
    fn unresolved_teardown_error(run: &Arc<Run>) -> Result<(), RequestError> {
        if lock_run(run).work_unresolved {
            return Err(app(
                "teardown_unconfirmed",
                "the harness process group could not be confirmed stopped; \
                 work may still be running",
            ));
        }
        Ok(())
    }

    /// Dropping `Subscription` does not cancel the run.
    pub fn subscribe(&self, key: &SessionKey) -> Result<Subscription, RequestError> {
        let total = Arc::clone(&self.inner.subscribers)
            .try_acquire_owned()
            .map_err(|_| app("queue_full", "total subscriber capacity is exhausted"))?;
        let mut released = Released::default();
        let mut index = lock_index(&self.inner);
        if index.closed {
            return Err(closed_error());
        }
        self.sweep_expired(&mut index, &mut released);
        let run = match index.sessions.get(key) {
            Some(SessionEntry::Live(run)) => Arc::clone(run),
            Some(SessionEntry::Tombstone(_)) => {
                return Err(app("session_deleted", "the session was deleted"))
            }
            None => return Err(app("run_missing", "the session has no run to subscribe to")),
        };
        let mut state = lock_run(&run);
        if state.subscriber_count >= self.inner.limits.max_subscribers_per_run {
            // The total permit drops after the guards, so rejecting a run cannot leak a total slot.
            // The total permit drops after the guards, so rejecting a run cannot leak a total slot.
            return Err(app(
                "queue_full",
                "per-run subscriber capacity is exhausted",
            ));
        }
        state.subscriber_count += 1;
        drop(state);
        drop(index);
        Ok(Subscription {
            run,
            cursor: 0,
            closing: self.inner.closing.clone(),
            _total: total,
        })
    }

    /// Drains everything:
    /// Shutdown cancels queued and running backend work, waits for all run tasks, wakes every subscriber, and releases retained state.
    /// After shutdown, the metrics snapshot equals the construction baseline.
    /// After shutdown, the metrics snapshot equals the construction baseline.
    ///
    /// Returns the number of runs with unproven process-group teardown in `work_unresolved`.
    /// Local state is released even when process-group teardown is unproven.
    /// A drained supervisor does not prove that harness process trees stopped.
    /// The component must not report a clean shutdown while provider work may still be running.
    /// The component must not report a clean shutdown while provider work may still be running.
    pub async fn shutdown(&self) -> usize {
        let inner = &self.inner;
        inner.closing.cancel();
        let runs: Vec<Arc<Run>> = {
            let mut index = lock_index(inner);
            index.closed = true;
            index.runs.values().cloned().collect()
        };
        for run in &runs {
            run.cancel.cancel();
        }
        inner.tracker.close();
        inner.tracker.wait().await;
        // Read after the tracker drain because every backend task has returned and each run's teardown verdict is final.
        // Every backend task has returned, so each run's teardown verdict is final.
        let unresolved = runs
            .iter()
            .filter(|run| lock_run(run).work_unresolved)
            .count();
        let mut released = Released::default();
        let mut index = lock_index(inner);
        let sessions: Vec<SessionKey> = index.sessions.keys().cloned().collect();
        for key in sessions {
            remove_session(&mut index, &key, &mut released);
        }
        debug_assert!(index.runs.is_empty(), "every run is session-owned");
        index.runs.clear();
        unresolved
    }

    /// The sweep releases expired retained entries so their charges cannot wedge the budget.
    /// Release detached charges before retrying so their budget is available.
    fn pressure_sweep(&self) {
        let mut released = Released::default();
        let mut index = lock_index(&self.inner);
        self.sweep_expired(&mut index, &mut released);
    }

    fn sweep_expired(&self, index: &mut Index, released: &mut Released) {
        sweep_for(&self.inner, index, released);
        // Subscribers can pin every eviction, leaving retained state.
        // The sweep may evict every terminal entry.
        // An empty id matches no entry.
        enforce_terminal_cap(&self.inner, index, "", None, released);
    }

    fn spawn_run(&self, run: Arc<Run>, request: SendRequest) {
        let inner = Arc::clone(&self.inner);
        let backend_request = BackendRequest {
            prompt: request.prompt,
            system: request.system,
            provider: request.provider,
            model: request.model,
            max_output_tokens: request.max_output_tokens,
            temperature: request.temperature,
            harness: run.key.harness,
            session: run.key.session.clone(),
            run_id: run.run_id.clone(),
        };
        self.inner.tracker.spawn(async move {
            // `DoneGuard` marks `work_done` even if the task panics or is aborted.
            // cancel and delete waiters can never hang on a lost task.
            let _done = DoneGuard {
                run: Arc::clone(&run),
            };
            let permit = tokio::select! {
                biased;
                () = inner.closing.cancelled() => {
                    finish(&inner, &run, TerminalOutcome::Cancelled { message: "host shutdown" });
                    return;
                }
                () = run.cancel.cancelled() => {
                    finish(&inner, &run, TerminalOutcome::Cancelled { message: "run cancelled" });
                    return;
                }
                permit = Arc::clone(&inner.backends).acquire_owned() => permit,
            };
            let Ok(_backend_permit) = permit else {
                finish(
                    &inner,
                    &run,
                    TerminalOutcome::Cancelled {
                        message: "host shutdown",
                    },
                );
                return;
            };
            // The task rechecks `closing` and run cancellation after acquiring a permit because either can fire while the permit branch wins.
            // The task rechecks cancellation after acquiring a permit to prevent a cancelled run from starting the backend.
            if inner.closing.is_cancelled() {
                finish(
                    &inner,
                    &run,
                    TerminalOutcome::Cancelled {
                        message: "host shutdown",
                    },
                );
                return;
            }
            if run.cancel.is_cancelled() {
                finish(
                    &inner,
                    &run,
                    TerminalOutcome::Cancelled {
                        message: "run cancelled",
                    },
                );
                return;
            }
            if !begin_running(&run) {
                // A queued cancelled or deleted run already has a committed terminal.
                // The committed terminal prevents the backend from starting.
                return;
            }
            // The task releases the request-byte charge when the backend task ends, not when a terminal commits.
            // A cancelled run can commit its terminal before backend teardown.
            // Releasing the charge early would admit replacements while the old prompt still occupies capacity.
            let _request_charge = {
                let mut state = lock_run(&run);
                state
                    .base_charge
                    .split_excess(run.key.meta_bytes().saturating_add(TERMINAL_HEADROOM_BYTES))
            };
            let sink_inner = Arc::clone(&inner);
            let sink_run = Arc::clone(&run);
            let sink = EventSink::new(Arc::new(move |event| {
                append_event(&sink_inner, &sink_run, event)
            }));
            // The host runs the backend in a tracked task so panics become join errors.
            // Without join-error handling, a backend panic could leave the run `running` and retain its active-run slot.
            let backend = Arc::clone(&inner.backend);
            let backend_cancel = run.cancel.clone();
            let backend_task = inner
                .tracker
                .spawn(async move { backend.execute(backend_request, sink, backend_cancel).await });
            let terminal = match backend_task.await {
                Ok(terminal) => terminal,
                Err(join_error) => {
                    let message = if join_error.is_panic() {
                        "backend execution panicked"
                    } else {
                        "backend task was aborted"
                    };
                    BackendTerminal::Failed(BackendError {
                        class: ErrorClass::Permanent,
                        message: message.to_owned(),
                        retry_after_secs: None,
                        provider_code: None,
                    })
                }
            };
            // A prior cancel or delete can commit a terminal before the backend exits.
            // After another terminal commits, `finish` cannot record `FailedUnresolved`.
            // `wait_work_done` must observe `work_unresolved` after backend exit.
            if matches!(terminal, BackendTerminal::FailedUnresolved(_)) {
                lock_run(&run).work_unresolved = true;
            }
            // Cancellation must produce a `Cancelled` terminal even if the backend returns another terminal.
            let outcome = if run.cancel.is_cancelled() {
                TerminalOutcome::Cancelled {
                    message: "run cancelled",
                }
            } else {
                TerminalOutcome::Backend(terminal)
            };
            finish(&inner, &run, outcome);
            // `_backend_permit` drops here: the permit is held through reap.
        });
    }
}

/// `DoneGuard::drop` makes completion observable after a run-task panic or abort.
struct DoneGuard {
    run: Arc<Run>,
}

impl Drop for DoneGuard {
    fn drop(&mut self) {
        // The task releases the excess charge after terminal commitment when it exits.
        let excess = {
            let mut state = lock_run(&self.run);
            state.work_done = true;
            if state.terminal_appended {
                let retained = self
                    .run
                    .key
                    .meta_bytes()
                    .saturating_add(TERMINAL_HEADROOM_BYTES);
                Some(state.base_charge.split_excess(retained))
            } else {
                None
            }
        };
        drop(excess);
        self.run.notify.notify_waiters();
    }
}

async fn wait_work_done(run: &Run) {
    loop {
        let notified = run.notify.notified();
        tokio::pin!(notified);
        // The caller registers the waiter before rechecking so a wake between the recheck and `await` cannot be lost.
        notified.as_mut().enable();
        if lock_run(run).work_done {
            return;
        }
        notified.await;
    }
}

/// `begin_running` returns `false` when a terminal already won; the backend must not start.
fn begin_running(run: &Run) -> bool {
    // `run_started` uses terminal headroom already reserved by `base_charge`; do not add a per-unit charge.
    let unit = ReplayFrame::uncharged(protocol::run_started_unit(&run.run_id));
    {
        let mut state = lock_run(run);
        if state.terminal_appended || state.purged {
            return false;
        }
        state.status = Status::Running;
        state.started_appended = true;
        state.replay.push(unit);
    }
    run.notify.notify_waiters();
    true
}

/// `append_reserved` appends an uncharged control unit from terminal headroom reserved by the run's base charge.
fn append_reserved(run: &Arc<Run>, unit: Vec<u8>) -> SinkStatus {
    let unit = ReplayFrame::uncharged(unit);
    {
        let mut state = lock_run(run);
        if state.terminal_appended || state.purged {
            return SinkStatus::Closed;
        }
        state.replay.push(unit);
    }
    run.notify.notify_waiters();
    SinkStatus::Accepted
}

/// `Closed` tells the backend not to send further events for the run.
fn append_event(inner: &Arc<Inner>, run: &Arc<Run>, event: BackendEvent) -> SinkStatus {
    let (text, finish_reason) = match event {
        BackendEvent::HarnessDispatch { harness } => {
            return append_reserved(run, protocol::harness_dispatch_unit(&run.run_id, harness));
        }
        BackendEvent::AssistantText {
            text,
            finish_reason,
        } => (text, finish_reason),
    };
    let bytes: Box<[u8]> =
        protocol::assistant_message_unit(&run.run_id, &text, finish_reason).into();
    let len = bytes.len();
    let charge = match inner.retained.try_charge(len) {
        Some(charge) => Some(charge),
        None => {
            // On charge failure, `append_event` detaches expired entries under the index lock, releases them after unlocking, and retries once.
            let mut released = Released::default();
            {
                let mut index = lock_index(inner);
                sweep_for(inner, &mut index, &mut released);
            }
            drop(released);
            inner.retained.try_charge(len)
        }
    };
    let overflow: Option<(&'static str, ErrorClass)>;
    {
        let mut state = lock_run(run);
        if state.terminal_appended || state.purged {
            return SinkStatus::Closed;
        }
        if state
            .replay_bytes
            .saturating_add(len)
            .saturating_add(TERMINAL_HEADROOM_BYTES)
            > inner.limits.max_run_replay_bytes
        {
            // A deterministic re-failure on the same output is permanent.
            overflow = Some((
                "replay exceeded the per-run retained cap",
                ErrorClass::Permanent,
            ));
        } else if let Some(charge) = charge {
            state.replay.push(Arc::new(ReplayFrame {
                bytes,
                _charge: charge,
            }));
            state.replay_bytes += len;
            drop(state);
            run.notify.notify_waiters();
            return SinkStatus::Accepted;
        } else {
            // Aggregate pressure can clear as retention expires: transient.
            overflow = Some((
                "aggregate retained budget is exhausted",
                ErrorClass::Transient,
            ));
        }
    }
    let (message, class) = overflow.expect("both non-return branches set the overflow reason");
    // After one terminal failure stops the backend, later events find `terminal_appended` and cannot grow retained data.
    run.cancel.cancel();
    finish(
        inner,
        run,
        TerminalOutcome::Backend(BackendTerminal::Failed(BackendError {
            class,
            message: message.to_owned(),
            retry_after_secs: None,
            provider_code: None,
        })),
    );
    SinkStatus::Closed
}

/// `finish` commits only the first terminal, releases `run_permit` when present, releases request-byte excess only after `work_done`, and enforces the terminal-session cap.
/// The index-before-run order is the required lock hierarchy.
/// Resource destruction runs after both locks are released.
fn finish(inner: &Arc<Inner>, run: &Arc<Run>, outcome: TerminalOutcome) {
    let mut released = Released::default();
    let mut index = lock_index(inner);
    {
        let mut state = lock_run(run);
        if state.terminal_appended || state.purged {
            return;
        }
        // Cancellation while queued prevents `run_started` from being appended.
        // Replay stays well-formed by prepending `run_started` from reserved headroom.
        if !state.started_appended {
            state
                .replay
                .push(ReplayFrame::uncharged(protocol::run_started_unit(
                    &run.run_id,
                )));
            state.started_appended = true;
        }
        let (unit, status): (Vec<u8>, Status) = match &outcome {
            TerminalOutcome::Backend(BackendTerminal::Completed { finish_reason }) => (
                protocol::run_finished_unit(&run.run_id, *finish_reason),
                Status::Completed,
            ),
            TerminalOutcome::Backend(BackendTerminal::Failed(error)) => {
                (protocol::error_unit(&run.run_id, error), Status::Failed)
            }
            // `work_unresolved` prevents cancel and delete from reporting success while backend work may still run.
            TerminalOutcome::Backend(BackendTerminal::FailedUnresolved(error)) => {
                state.work_unresolved = true;
                (protocol::error_unit(&run.run_id, error), Status::Failed)
            }
            TerminalOutcome::Cancelled { message } => (
                protocol::error_unit(
                    &run.run_id,
                    &BackendError {
                        class: ErrorClass::Permanent,
                        message: (*message).to_owned(),
                        retry_after_secs: None,
                        provider_code: None,
                    },
                ),
                Status::Cancelled,
            ),
        };
        state.replay.push(ReplayFrame::uncharged(unit));
        state.terminal_appended = true;
        state.status = status;
        state.completed_at = Some(Instant::now());
        if let Some(permit) = state.run_permit.take() {
            released.permits.push(permit);
        }
        // The cleanup path releases queued-run request bytes only after terminal commit and `work_done`.
        // Releasing the charge before `work_done` could admit a replacement send while the parked task still owns `backend_request`.
        let retained = run.key.meta_bytes().saturating_add(TERMINAL_HEADROOM_BYTES);
        if state.work_done {
            released
                .charges
                .push(state.base_charge.split_excess(retained));
        }
    }
    enforce_terminal_cap(inner, &mut index, &run.run_id, None, &mut released);
    drop(index);
    run.notify.notify_waiters();
}

/// Evicts the oldest eligible terminal or tombstone sessions until the 256-session cap holds.
/// The just-committed run is protected from eviction during its own commit.
fn enforce_terminal_cap(
    inner: &Arc<Inner>,
    index: &mut Index,
    keep_run_id: &str,
    keep_key: Option<&SessionKey>,
    released: &mut Released,
) {
    // The 257-session bound makes O(sessions) scans per eviction sufficient.
    // The 257-session bound does not justify an ordered structure.
    loop {
        let mut retained = 0usize;
        let mut oldest: Option<(SessionKey, Instant)> = None;
        for (key, entry) in &index.sessions {
            let (at, evictable) = match entry {
                SessionEntry::Tombstone(tombstone) => {
                    // `keep_key` prevents eviction of the delete operation's resurrection guard.
                    // Evicting the resurrection guard would undo the guard installed by the delete operation.
                    // installed.
                    (Some(tombstone.created_at), keep_key != Some(key))
                }
                SessionEntry::Live(run) => {
                    let state = lock_run(run);
                    if !state.terminal_appended {
                        continue;
                    }
                    // A terminal run with unresolved backend work is not evictable.
                    // Eviction would make later cancel and delete take the unknown-run success path without observing `work_unresolved`.
                    // Eviction would also release charges for state still held by the backend task.
                    // Backend permits bound the number of transiently unevictable runs.
                    (
                        state.completed_at,
                        state.work_done && state.subscriber_count == 0 && run.run_id != keep_run_id,
                    )
                }
            };
            retained += 1;
            if evictable {
                if let Some(at) = at {
                    if oldest.as_ref().is_none_or(|(_, best)| at < *best) {
                        oldest = Some((key.clone(), at));
                    }
                }
            }
        }
        if retained <= inner.limits.max_terminal_sessions {
            return;
        }
        let Some((key, _)) = oldest else {
            return;
        };
        remove_session(index, &key, released);
    }
}

/// A removed live run is marked `purged` so late subscribers detach instead of replaying a log whose charges were released.
fn remove_session(index: &mut Index, key: &SessionKey, released: &mut Released) {
    let Some(entry) = index.sessions.remove(key) else {
        return;
    };
    match entry {
        SessionEntry::Tombstone(tombstone) => released.tombstones.push(tombstone),
        SessionEntry::Live(run) => {
            index.runs.remove(&run.run_id);
            let mut state = lock_run(&run);
            state.purged = true;
            released.charges.push(std::mem::replace(
                &mut state.base_charge,
                ByteCharge::none(),
            ));
            released.replays.push(std::mem::take(&mut state.replay));
            if let Some(permit) = state.run_permit.take() {
                released.permits.push(permit);
            }
            drop(state);
            run.notify.notify_waiters();
        }
    }
}

/// A subscriber mid-replay pins its run because releasing its `Arc` replay units early would detach accounting from resident bytes.
/// resident.
fn sweep_for(inner: &Arc<Inner>, index: &mut Index, released: &mut Released) {
    let now = Instant::now();
    let retention = inner.limits.terminal_retention;
    let expired: Vec<SessionKey> = index
        .sessions
        .iter()
        .filter(|(_, entry)| match entry {
            SessionEntry::Tombstone(tombstone) => {
                now.saturating_duration_since(tombstone.created_at) >= retention
            }
            SessionEntry::Live(run) => {
                let state = lock_run(run);
                // teardown verdict.
                state.work_done
                    && state.subscriber_count == 0
                    && state
                        .completed_at
                        .is_some_and(|at| now.saturating_duration_since(at) >= retention)
            }
        })
        .map(|(key, _)| key.clone())
        .collect();
    for key in expired {
        remove_session(index, &key, released);
    }
}

/// Dropping a `Subscription` detaches only that waiter and never affects the run.
pub struct Subscription {
    run: Arc<Run>,
    cursor: usize,
    closing: CancellationToken,
    _total: OwnedSemaphorePermit,
}

impl Subscription {
    /// `Subscription::next` returns `None` after delivering the in-band terminal, after purge, or during shutdown.
    /// `Subscription::next` waits without polling while the run is still producing.
    /// A returned frame retains its byte charge, so its bytes remain accounted across concurrent purge.
    pub async fn next(&mut self) -> Option<Arc<ReplayFrame>> {
        loop {
            let notified = self.run.notify.notified();
            tokio::pin!(notified);
            // `Subscription::next` registers its notification before checking run state so an append between the check and await wakes the Subscription.
            notified.as_mut().enable();
            {
                let state = lock_run(&self.run);
                if state.purged {
                    return None;
                }
                if self.cursor < state.replay.len() {
                    let unit = Arc::clone(&state.replay[self.cursor]);
                    self.cursor += 1;
                    return Some(unit);
                }
                if state.terminal_appended {
                    return None;
                }
            }
            tokio::select! {
                () = &mut notified => {}
                () = self.closing.cancelled() => return None,
            }
        }
    }
}

impl std::fmt::Debug for Subscription {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Subscription")
            .field("run_id", &self.run.run_id)
            .field("cursor", &self.cursor)
            .finish()
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        let mut state = lock_run(&self.run);
        state.subscriber_count = state.subscriber_count.saturating_sub(1);
    }
}
