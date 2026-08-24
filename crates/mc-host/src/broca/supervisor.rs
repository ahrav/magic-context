//! Bounded process-local run supervision (KTD3, KTD4, KTD12; R5, R7-R13).
//!
//! One mutex-protected index carries both run identities — sessions keyed by
//! `(project_root, harness, session)` and runs keyed by `run_id` — so send
//! deduplication, capacity release, and deletion linearize across both maps
//! (KTD3). Everything per-run (status, replay, subscriber count, charges,
//! notification) lives on a stable `Run` object behind its own lock, taken
//! only *after* the index lock and never held across an await.
//!
//! Charges and permits release strictly outside the index lock through the
//! `Released` collector, mirroring `crate::synapse::jobs`: dropping a
//! `ByteCharge` takes the budget's waiter lock, and nesting that inside the
//! index lock would put a host-wide lock under the one serializing every
//! admission.
//!
//! Nothing here is durable (KTD12/R11): a restart maps every old run ID to
//! `missing`, and the historian or classify ledger decides whether to refire.

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

/// The immutable-run identity scope (R5). Route claims only — the key scopes
/// runs and grants nothing beyond the authenticated host bearer (R4).
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct SessionKey {
    pub project_root: std::path::PathBuf,
    pub harness: Harness,
    pub session: String,
}

impl std::fmt::Debug for SessionKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Identity claims are sensitive diagnostics (R19): lengths only.
        f.debug_struct("SessionKey")
            .field("project_root_len", &self.project_root.as_os_str().len())
            .field("harness", &self.harness)
            .field("session_len", &self.session.len())
            .finish()
    }
}

impl SessionKey {
    /// Logical bytes the index retains for this key: both map keys plus the
    /// run ID, fingerprint, and entry skeleton, folded into one conservative
    /// constant. String contents dominate; struct overhead stays outside the
    /// accounting claim, matching `synapse::jobs::job_input_bytes`.
    fn meta_bytes(&self) -> usize {
        const KEY_META_OVERHEAD_BYTES: usize = 128;
        self.project_root
            .as_os_str()
            .len()
            .saturating_add(self.session.len())
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

/// How a run's single terminal is classified before encoding (R10): every
/// terminal path funnels through [`finish`], whose first-append-wins check
/// is what makes "completion cannot overwrite cancellation" hold.
enum TerminalOutcome {
    Backend(BackendTerminal),
    Cancelled { message: &'static str },
}

struct RunState {
    status: Status,
    /// Encoded, sequence-addressed replay units (KTD4). `Arc` so subscribers
    /// copy references, never bytes; the terminal append is the only
    /// transition that closes this log.
    replay: Vec<Arc<[u8]>>,
    /// Charged backend-event bytes only; the `run_started` and terminal
    /// units live inside the pre-charged terminal headroom.
    replay_bytes: usize,
    started_appended: bool,
    terminal_appended: bool,
    subscriber_count: usize,
    /// The run task has fully stopped (backend returned or never started).
    /// Cancel and delete wait on this so no backend work outlives their
    /// completion (R10).
    work_done: bool,
    /// Removed from both indices; replay and charges are gone. Subscribers
    /// observing this detach instead of replaying a purged log.
    purged: bool,
    completed_at: Option<Instant>,
    /// Held from admission through terminal commitment (R13's 32-run cap).
    run_permit: Option<OwnedSemaphorePermit>,
    /// Immutable request bytes, key metadata, and terminal headroom (R12);
    /// shrunk to the retained remainder at terminal commitment.
    base_charge: ByteCharge,
    /// One charge per retained backend-event unit.
    unit_charges: Vec<ByteCharge>,
}

struct Run {
    run_id: String,
    key: SessionKey,
    /// SHA-256 over the exact `session.send` body bytes (R5/KTD11): a
    /// byte-identical resend matches, anything else conflicts.
    fingerprint: [u8; 32],
    state: Mutex<RunState>,
    notify: Notify,
    cancel: CancellationToken,
}

/// A deleted session's bounded residue (R10/R12): blocks resurrection until
/// retention expires and keeps its metadata charged until then.
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

/// Charges, permits, replay buffers, and tombstones detached under the index
/// lock but released only after it drops — the same discipline as
/// `synapse::jobs::Released`, and for the same waiter-lock nesting reason.
#[derive(Default)]
struct Released {
    charges: Vec<ByteCharge>,
    permits: Vec<OwnedSemaphorePermit>,
    replays: Vec<Vec<Arc<[u8]>>>,
    tombstones: Vec<Tombstone>,
}

struct Inner {
    limits: BrocaLimits,
    backend: Arc<dyn LlmExecutionBackend>,
    /// Random per-incarnation fence inside every run ID: a stale ID from a
    /// previous process must resolve to `missing`, never to a live run
    /// (R11/KTD12).
    incarnation: String,
    index: Mutex<Index>,
    commands: Arc<Semaphore>,
    run_slots: Arc<Semaphore>,
    subscribers: Arc<Semaphore>,
    backends: Arc<Semaphore>,
    /// Broca's own nonblocking budget for the 64 MiB retained reservation
    /// (KTD2): ingress bodies and parser scratch stay on host charges.
    retained: ByteBudget,
    tracker: TaskTracker,
    closing: CancellationToken,
}

/// Read-only capacity snapshot, used by tests to prove every permit and byte
/// charge returns exactly to baseline across all failure paths.
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

/// Acquires the index lock, recovering from poisoning: every operation on
/// `Index` is defensive against partially applied state, and the expiry
/// sweep bounds how long an inconsistent entry survives — the same rationale
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

    /// Test seam: shrunken caps make eviction, overflow, and saturation
    /// reachable without materializing production-sized state. The
    /// component always uses [`Supervisor::new`].
    pub fn with_limits(backend: Arc<dyn LlmExecutionBackend>, limits: BrocaLimits) -> Self {
        let mut nonce = [0u8; 8];
        // Unpredictable across restarts so a stale run ID cannot collide
        // with a live one by counting sequence numbers.
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

    /// One non-subscription command slot (R13), held by RAII for the
    /// caller's whole callback. `try_acquire` so command 33 fails fast
    /// instead of queueing behind blocked settlement.
    fn command_permit(&self) -> Result<OwnedSemaphorePermit, RequestError> {
        Arc::clone(&self.inner.commands)
            .try_acquire_owned()
            .map_err(|_| app("queue_full", "command callback capacity is exhausted"))
    }

    /// Admits or deduplicates one `session.send` (F1, R5-R6).
    ///
    /// Admission order (KTD3): the command permit, then candidate active-run
    /// and retained-byte reservations, then the recheck-and-publish of both
    /// indices under the lock. The spawned run task — not this call — queues
    /// for a backend permit, so admission never blocks behind execution.
    /// `body` must be the exact request bytes: the stored fingerprint is
    /// what makes the producer's frozen-bytes retry idempotent (KTD11).
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

        // Candidate reservations precede the index recheck (KTD3). On
        // retained pressure, sweep expired entries (released outside the
        // lock) and retry exactly once.
        let run_permit = Arc::clone(&inner.run_slots).try_acquire_owned().ok();
        let charge = match inner.retained.try_charge(base_bytes) {
            Some(charge) => Some(charge),
            None => {
                self.pressure_sweep();
                inner.retained.try_charge(base_bytes)
            }
        };

        // Declared before the guard so failed candidates release after it.
        let mut released = Released::default();
        let mut index = lock_index(inner);
        if index.closed {
            return Err(closed_error());
        }
        self.sweep_expired(&mut index, &mut released);
        // Deduplication answers before capacity does: a byte-identical
        // resend of an existing run must return its ID even when every
        // candidate reservation failed (AE2), because it creates nothing.
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
                // AE7: a late send cannot resurrect a deleted session while
                // its tombstone is retained.
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
                purged: false,
                completed_at: None,
                run_permit: Some(run_permit),
                base_charge: charge.split_or_take(base_bytes),
                unit_charges: Vec::new(),
            }),
            notify: Notify::new(),
            cancel: CancellationToken::new(),
        });
        index
            .sessions
            .insert(key.clone(), SessionEntry::Live(Arc::clone(&run)));
        index.runs.insert(run_id.clone(), Arc::clone(&run));
        // Spawned under the index lock: shutdown sets `closed` under this
        // same lock before closing the tracker, so a run it can see is
        // always a task the tracker drain will wait for.
        self.spawn_run(run, request);
        Ok(run_id)
    }

    /// Exact status vocabulary only (R7): a known run reports its state
    /// verbatim; anything else — foreign incarnation, expired, evicted,
    /// deleted, never existed — is `missing`.
    pub fn status(&self, run_id: &str) -> Result<&'static str, RequestError> {
        let _command = self.command_permit()?;
        let mut released = Released::default();
        let mut index = lock_index(&self.inner);
        if index.closed {
            return Err(closed_error());
        }
        self.sweep_expired(&mut index, &mut released);
        match index.runs.get(run_id) {
            Some(run) => Ok(lock_run(run).status.as_str()),
            None => Ok(protocol::STATUS_MISSING),
        }
    }

    /// Cancels one run (F3, R10). Resolves only after the run's task has
    /// fully stopped, so no backend work outlives a successful cancel.
    /// Idempotent: an unknown, expired, or already-terminal run is a
    /// success with no effect, and a committed completion is never
    /// overwritten.
    pub async fn cancel(&self, run_id: &str) -> Result<(), RequestError> {
        let _command = self.command_permit()?;
        let run = {
            let mut released = Released::default();
            let mut index = lock_index(&self.inner);
            if index.closed {
                return Err(closed_error());
            }
            self.sweep_expired(&mut index, &mut released);
            index.runs.get(run_id).cloned()
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
        Ok(())
    }

    /// Deletes the route's session (F3, R10): cancels any live run, waits
    /// for its backend to stop, purges replay and charges, and installs a
    /// bounded tombstone. A second delete finds the tombstone and is
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
                // Idempotent repeats and never-existing sessions purge
                // nothing and succeed.
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
        wait_work_done(&run).await;

        let mut released = Released::default();
        let mut index = lock_index(&self.inner);
        // Re-looked-up under the lock: a concurrent delete may already have
        // installed the tombstone, and only the delete that still finds its
        // own run performs the purge (single-releaser rule, R10).
        let same_run = matches!(
            index.sessions.get(key),
            Some(SessionEntry::Live(current)) if Arc::ptr_eq(current, &run)
        );
        if same_run {
            index.sessions.remove(key);
            index.runs.remove(&run.run_id);
            let mut state = lock_run(&run);
            state.purged = true;
            // The tombstone's charge is carved out of the run's own base
            // charge, so the swap from run to tombstone is atomic under the
            // index lock with no budget round trip that could lose a race
            // against a resurrecting send.
            let tombstone_charge = state.base_charge.split_or_take(key.meta_bytes());
            released.charges.push(std::mem::replace(
                &mut state.base_charge,
                ByteCharge::none(),
            ));
            released.charges.append(&mut state.unit_charges);
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
            // A terminal-cap eviction can remove the session between the
            // terminal commit above and this re-lock; without a tombstone
            // the completed delete would silently lose its resurrection
            // guard (AE7). The evicted run's charges are already released,
            // so the tombstone is charged fresh against the retained budget
            // — and skipped silently when the budget refuses, because
            // delete must never block (the worst case is only the original
            // no-tombstone race). A key holding a different live run means
            // a post-eviction send already won; that session is not ours to
            // tombstone.
            if let Some(charge) = self.inner.retained.try_charge(key.meta_bytes()) {
                index.sessions.insert(
                    key.clone(),
                    SessionEntry::Tombstone(Tombstone {
                        created_at: Instant::now(),
                        _charge: charge,
                    }),
                );
                // The fresh tombstone grew the retained-session count by
                // one, so the cap is re-enforced here instead of waiting
                // for the next terminal commit.
                enforce_terminal_cap(&self.inner, &mut index, &run.run_id, &mut released);
            }
        }
        Ok(())
    }

    /// Attaches one replay cursor from `start` (F2, R8). Admission order:
    /// total subscriber permit, then the index lookup, then the per-run cap
    /// under the run's own lock. Detach is dropping the returned
    /// [`Subscription`] — it never affects the run (R9).
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
            // The total permit is RAII and drops after the guards, so a
            // per-run rejection can never leak a total slot.
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

    /// Drains everything (F3, R10, R13): refuses new work, cancels every
    /// queued and running backend, waits for all run tasks, wakes every
    /// subscriber, and releases all retained state. The metrics snapshot
    /// afterwards is exactly the construction baseline.
    pub async fn shutdown(&self) {
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
        let mut released = Released::default();
        let mut index = lock_index(inner);
        let sessions: Vec<SessionKey> = index.sessions.keys().cloned().collect();
        for key in sessions {
            remove_session(&mut index, &key, &mut released);
        }
        debug_assert!(index.runs.is_empty(), "every run is session-owned");
        index.runs.clear();
    }

    /// Releases expired retained entries so their charges cannot wedge the
    /// budget (R12): detach under the lock, release outside it, and the
    /// caller retries its reservation once.
    fn pressure_sweep(&self) {
        let mut released = Released::default();
        let mut index = lock_index(&self.inner);
        self.sweep_expired(&mut index, &mut released);
    }

    fn sweep_expired(&self, index: &mut Index, released: &mut Released) {
        sweep_for(&self.inner, index, released);
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
            project_root: run.key.project_root.clone(),
            harness: run.key.harness,
            session: run.key.session.clone(),
            run_id: run.run_id.clone(),
        };
        self.inner.tracker.spawn(async move {
            // Marks `work_done` even if this task panics or is aborted, so
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
            // The select above can resolve its permit branch while `closing`
            // or the run's own cancel fires concurrently; recheck both so a
            // stopped run never spawns a fresh harness subprocess whose
            // termination grace would only delay the settled outcome.
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
                // Cancelled or deleted while queued: the terminal is already
                // committed and the backend must never start.
                return;
            }
            // The immutable request bytes stay charged for exactly as long
            // as the backend can observe them: this charge rides the backend
            // task's scope and drops when the task ends, not at terminal
            // commitment — a cancelled run's terminal can precede backend
            // teardown, and releasing early would let replacement sends
            // consume capacity the old prompt still occupies.
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
            // The backend runs in its own tracked task so a panic surfaces
            // as a join error instead of unwinding past `finish`: an
            // unfinished run would stay `running` forever, hold its
            // active-run slot, and strand its subscribers (R10).
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
            // A fired cancel token wins over whatever the backend returned:
            // the control operation already promised a cancellation
            // terminal, and `finish` is first-append-wins anyway.
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

/// Sets `work_done` on drop, so completion is observable even across panic
/// or abort of the run task.
struct DoneGuard {
    run: Arc<Run>,
}

impl Drop for DoneGuard {
    fn drop(&mut self) {
        // The second half of the request-byte release rule in `finish`: if
        // the terminal is already committed, the task exiting is what stops
        // the request bytes from being owned, so the excess releases here.
        // For a started run the excess already rode the backend task and
        // this split is empty. The charge drops outside the run lock.
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
        // Registered before the recheck so a wake between check and await
        // cannot be lost.
        notified.as_mut().enable();
        if lock_run(run).work_done {
            return;
        }
        notified.await;
    }
}

/// Queued -> running plus the `run_started` unit (R8). Returns false when a
/// terminal already won, in which case the backend must not start.
fn begin_running(run: &Run) -> bool {
    let unit: Arc<[u8]> = protocol::run_started_unit(&run.run_id).into();
    {
        let mut state = lock_run(run);
        if state.terminal_appended || state.purged {
            return false;
        }
        state.status = Status::Running;
        state.started_appended = true;
        // No per-unit charge: run_started lives inside the terminal
        // headroom reserved with the run's base charge.
        state.replay.push(unit);
    }
    run.notify.notify_waiters();
    true
}

/// Retains one backend event (KTD4, R12). Nonblocking by contract: charge
/// first, then a short run-lock append. `Closed` tells the backend the run
/// accepts nothing further.
fn append_event(inner: &Arc<Inner>, run: &Arc<Run>, event: BackendEvent) -> SinkStatus {
    let BackendEvent::AssistantText {
        text,
        finish_reason,
    } = event;
    let unit: Arc<[u8]> =
        protocol::assistant_message_unit(&run.run_id, &text, finish_reason).into();
    let len = unit.len();
    let charge = match inner.retained.try_charge(len) {
        Some(charge) => Some(charge),
        None => {
            // Pressure path: detach expired entries under the lock, release
            // outside it, retry once (KTD3).
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
            // The unused charge (if any) drops after the guard.
            return SinkStatus::Closed;
        }
        if state
            .replay_bytes
            .saturating_add(len)
            .saturating_add(TERMINAL_HEADROOM_BYTES)
            > inner.limits.max_run_replay_bytes
        {
            // Deterministic re-failure on the same output: permanent.
            overflow = Some((
                "replay exceeded the per-run retained cap",
                ErrorClass::Permanent,
            ));
        } else if let Some(charge) = charge {
            state.replay.push(unit);
            state.replay_bytes += len;
            state.unit_charges.push(charge);
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
    // One failed terminal and a stopped backend (AE10): later events find
    // `terminal_appended` and can no longer grow retained data.
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

/// Commits a run's single terminal (R10): first append wins, the active-run
/// permit releases, dead request bytes shrink away, and the terminal-session
/// cap is enforced — all under the index-then-run lock order, with every
/// release deferred past both guards.
fn finish(inner: &Arc<Inner>, run: &Arc<Run>, outcome: TerminalOutcome) {
    let mut released = Released::default();
    let mut index = lock_index(inner);
    {
        let mut state = lock_run(run);
        if state.terminal_appended || state.purged {
            return;
        }
        // A run cancelled while still queued never appended run_started;
        // replay stays well-formed (R8) by prepending it from the headroom.
        if !state.started_appended {
            state
                .replay
                .push(protocol::run_started_unit(&run.run_id).into());
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
        state.replay.push(unit.into());
        state.terminal_appended = true;
        state.status = status;
        state.completed_at = Some(Instant::now());
        if let Some(permit) = state.run_permit.take() {
            released.permits.push(permit);
        }
        // A started run's immutable request bytes ride the backend task and
        // drop with it. For a run whose backend never started they release
        // only once BOTH the terminal is committed and the run task has
        // stopped (`work_done`): a run cancelled while queued commits its
        // terminal while the parked task still owns `backend_request`, and
        // releasing then would admit replacement sends beside the old
        // prompt. Whichever of terminal commit and task exit happens second
        // performs the split — see `DoneGuard`. Either way only key
        // metadata and the (now spent) terminal headroom stay charged.
        let retained = run.key.meta_bytes().saturating_add(TERMINAL_HEADROOM_BYTES);
        if state.work_done {
            released
                .charges
                .push(state.base_charge.split_excess(retained));
        }
    }
    enforce_terminal_cap(inner, &mut index, &run.run_id, &mut released);
    drop(index);
    run.notify.notify_waiters();
}

/// Evicts oldest eligible terminal or tombstone sessions until the 256-cap
/// holds (R12). The just-committed run is protected so a fresh terminal is
/// never displaced by its own commit.
fn enforce_terminal_cap(
    inner: &Arc<Inner>,
    index: &mut Index,
    keep_run_id: &str,
    released: &mut Released,
) {
    // ponytail: O(sessions) scans per eviction; the cap bounds sessions at
    // 257, so an ordered structure buys nothing yet.
    loop {
        let mut retained = 0usize;
        let mut oldest: Option<(SessionKey, Instant)> = None;
        for (key, entry) in &index.sessions {
            let (at, evictable) = match entry {
                SessionEntry::Tombstone(tombstone) => (Some(tombstone.created_at), true),
                SessionEntry::Live(run) => {
                    let state = lock_run(run);
                    if !state.terminal_appended {
                        continue;
                    }
                    (
                        state.completed_at,
                        state.subscriber_count == 0 && run.run_id != keep_run_id,
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
            // Every over-cap entry is pinned by a subscriber or is the
            // protected fresh terminal; those pins drain quickly and the
            // next commit or sweep re-enforces the cap.
            return;
        };
        remove_session(index, &key, released);
    }
}

/// Detaches one session entry and everything it owns into `released`. A
/// removed live run is marked purged so late subscribers detach instead of
/// replaying a log whose charges are gone.
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
            released.charges.append(&mut state.unit_charges);
            released.replays.push(std::mem::take(&mut state.replay));
            if let Some(permit) = state.run_permit.take() {
                released.permits.push(permit);
            }
            drop(state);
            run.notify.notify_waiters();
        }
    }
}

/// Moves retention-expired entries that are not replay-pinned into
/// `released`. A subscriber mid-replay pins its run because releasing the
/// Arc'd replay units early would divorce the accounting from bytes still
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
                state.subscriber_count == 0
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

/// One replay cursor over a run (KTD4). Holds its total-subscriber permit
/// and per-run slot until dropped; dropping it — request cancellation, route
/// closure, TCP loss, or normal completion — detaches only this waiter and
/// never affects the run (R9).
pub struct Subscription {
    run: Arc<Run>,
    cursor: usize,
    closing: CancellationToken,
    _total: OwnedSemaphorePermit,
}

impl Subscription {
    /// The next retained unit in order, or `None` once the in-band terminal
    /// has been delivered (R8), the run was purged, or the host is shutting
    /// down. Waits without polling while the run is still producing.
    pub async fn next(&mut self) -> Option<Arc<[u8]>> {
        loop {
            let notified = self.run.notify.notified();
            tokio::pin!(notified);
            // Registered before the state check so an append between the
            // check and the await still wakes this cursor.
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
