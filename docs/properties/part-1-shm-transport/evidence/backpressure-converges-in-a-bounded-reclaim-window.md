# backpressure-converges-in-a-bounded-reclaim-window

## Citation refresh, 2026-08-31 (eventfd rewrite)

PR #131 (merge `5d638e3e8`) replaced the polling wake mechanism with sparse
eventfd doorbells. `reserve_until` no longer spins or sleeps on a poll quantum;
it parks on the `capacity_ready` doorbell. The `HotPinnedPoll`/`ColdParkWake`
modes are gone, `POLL_INTERVAL` survives only in
`crates/mc-host/tests/support/process_resources.rs:75`, and every line below was
re-verified against HEAD.

## Discovery trigger

Every existing liveness record in this part concerns a fault: a crashed producer, a
stale cursor, a discarded release. None states that the transport makes progress when
nothing is wrong. `reserve_until` is the only place in the transport that converts
"no capacity right now" into "wait and try again", and it retries exactly one error
variant. That makes it the one function whose correctness is the difference between a
transport that applies backpressure and a transport that stalls, and nothing states
what it must achieve.

## Evidence trail

- `crates/mc-shm-transport/src/backend/ring.rs:980-1048` `reserve_until`. The loop
  retries only `Err(ProducerError::Exhausted)` and only while
  `Instant::now() < deadline` (`:988`); a sustained `Exhausted` becomes
  `ProducerError::Deadline` (`:989`, `:1003-1005`, `:1022-1024`, `:1043-1044`);
  every other outcome, success or error, returns immediately. Between attempts
  there is no spin and no sleep: the producer stores a generation-bound park epoch
  on the capacity wake page (`:994-1000`), re-runs `try_reserve` after parking
  (`:1001`), rechecks the generation (`:1012`), drains the doorbell and re-runs
  `try_reserve` again (`:1016`, `:1020`), rechecks the generation again (`:1031`),
  and only then blocks in `capacity_ready.wait_until(deadline)` (`:1035`), a
  deadline-bounded `poll(2)` on the eventfd (`Doorbell::wait_until`, `:450`).
- The wake edge: `release` signals `capacity_ready` (`:1236-1241`) through
  `signal_wake` (`:1418-1432`), which increments the wake generation and writes
  the eventfd only when a waiter's park flag was set (`:1427`). Delivery is
  sparse by design: an unparked producer gets no write, and the arm/recheck
  protocol above is what closes the race where the release lands between the
  producer's check and its park.
- Three distinct conditions all surface as `Exhausted`, so all three are retried:
  descriptor depth full, `outstanding >= descriptor_depth` (`:926-928`); a lost
  `SLOT_FREE → SLOT_PRODUCER_RESERVED` compare-exchange (`:938-943`); and arena
  exhaustion from `SpanPlan::reserve`, which rolls the slot back to `SLOT_FREE`
  before returning (`:949-955`). `ArenaError::Exhausted` is produced when
  `len > capacity - used` with `used = write - reclaimed`
  (`crates/mc-shm-transport/src/arena.rs:103-110`).
- `ring.rs:916` — the mechanism that makes retrying useful:
  `try_reserve` calls `self.reclaim_completed()` before reading any cursor. This is
  the **only** call site of `reclaim_completed` in the repository, confirmed by search.
  Reclamation is therefore producer-driven and lazy: a retry is not a passive wait, it
  is the act that recovers capacity.
- `ring.rs:1470-1565` `reclaim_completed` drains the whole contiguous completed prefix
  in one call. The loop advances while `completion_sequence == next`
  (`:1478-1484`) and breaks at the first gap (`:1483-1484`), advancing
  `arena_reclaimed` (`:1558-1561`) and `completed` (`:1562`) after validating the
  run. One call is enough; a second adds nothing unless a new completion landed.
- `ring.rs:1229-1234` — the receiver end of the edge. `release` stores
  `completion_sequence` with `Release` and decrements `active_leases`. The producer's
  matching `Acquire` load is `ring.rs:1482`.
- Existing check, partial: `two_process_zero_copy_exchange_uses_authenticated_grant`
  (`crates/mc-shm-transport/tests/ring.rs:551-592`). The parent fills the arena with
  one `MAX_FRAME_BYTES` frame, then calls `reserve_until(1, .., now + 5s)` while the
  child holds the lease and sleeps 50 ms (`:575-582`, child at `:623`). The
  `.unwrap()` at `:581` is a genuine convergence assertion, and
  `assert!(waiting_since.elapsed() >= Duration::from_millis(25))` at `:583` keeps it
  from passing vacuously. What it does not do: exercise descriptor-depth exhaustion,
  bound convergence any tighter than five seconds, or assert that capacity returned in
  full.
- Existing check, negative direction:
  `retained_oldest_lease_enforces_fifo_reclamation_and_release_validation`
  (`tests/ring.rs:181-185`) asserts `reserve_until(.., Instant::now())` returns
  `Deadline`. That pins the give-up path, not the converge path.

## Failure scenario

1. A producer offers a frame while the arena is full or the descriptor ring is at
   depth. `try_reserve` returns `Exhausted` and `reserve_until` parks a wake epoch
   and, after its rechecks, blocks on the `capacity_ready` doorbell.
2. The receiver drains normally: it acquires the oldest frame, copies it, and
   releases the lease, storing `completion_sequence` (`:1231-1233`) and signalling
   `capacity_ready` (`:1236-1237`).
3. A defect anywhere in the recovery chain — `reclaim_completed` not called from
   the retry path, the loop advancing at most one sequence per call, the `Acquire`
   load at `:1482` weakened, `reserve_until` misclassifying the retryable variant,
   or a wake defect: `release` skipping the doorbell write while the producer's
   park flag is set, or the producer parking without re-running `try_reserve`
   first — leaves the producer asleep or `completed`/`arena_reclaimed` behind
   their true values. The wake-defect family is new with the eventfd mechanism;
   the polling design re-evaluated every 50 microseconds regardless.
4. `reserve_until` keeps returning to the doorbell until the deadline and reports
   `ProducerError::Deadline`. In the host that is an outbound publish failure:
   `publish_one` returns `Err`, the endpoint cancels and returns
   (`crates/mc-host/src/ring_transport.rs:479-483`), the endpoint thread joins,
   and `admission.release()` runs unconditionally (`:276`) — the pre-refactor
   suspect branch is gone.
5. The operator-visible symptom is a retired generation attributed to a transport
   fault, on a channel where the peer was draining correctly the entire time.

## Timing windows and dependencies

The window opens at the first `Exhausted` and closes at the deadline. Three
quantities bound it and all three must be stated for a test to be refutable.
First, visibility: the producer cannot observe a release until the `Release` store
at `:1231-1233` is visible to the `Acquire` load at `:1482`, which is immediate
in-process and bounded by store propagation across processes. Second, the reclaim
pass: one `try_reserve` recovers the entire contiguous completed prefix, so the
bound after visibility is **one further attempt**, not a number proportional to
the backlog. Third, the wake: a parked producer performs that attempt only after
the `capacity_ready` doorbell fires or its `wait_until` deadline lapses, so
doorbell wake latency replaces the old 50-microsecond poll quantum as the floor on
any asserted bound — and unlike the quantum it is not a code constant, so a test
must choose and record its own inner bound. Dependency on the fault-free window is
strict: the property is stated for a receiver that keeps releasing. Under a
retained lease, non-convergence is the documented FIFO behaviour, which is why
`reclamation-keeps-pace-with-completion` carries the head-of-line case separately.

## What a test must construct

Offered load that actually exhausts capacity, then removal of the pressure, then a
bounded poll. Two arms, because the two exhaustion causes are independent and only
one is covered today. Arm A, arena exhaustion: fill the arena with one maximum
frame, hold its lease, assert `try_reserve` returns `Exhausted`, release, then
assert the **next single** `try_reserve` succeeds — not `reserve_until` with a
generous deadline, because that cannot distinguish one reclaim pass from a
thousand. Arm B, descriptor exhaustion: publish `descriptor_depth` small frames
without receiving, assert `Exhausted`, then receive and release all of them and
assert one `try_reserve` succeeds. Both arms must also assert the negative: with a
deadline set beyond the release, `reserve_until` returns `Ok`, and the elapsed
time is strictly below the deadline, so a `Deadline` return is a failure rather
than a slow pass — under the eventfd mechanism this arm is also the lost-wake
detector, because a parked producer whose `capacity_ready` signal was skipped
converges only at its deadline. Cross-process form: keep the 5-second deadline of
the existing test as an outer safety bound, but assert convergence within an
explicit inner wall-clock bound after the release is observed, chosen and recorded
by the test, and fail if it is exceeded; N poll rounds is no longer a meaningful
unit because the producer does not poll. Enabling situation is already declared in
`fault-map.md` as `shm_arena_wrap_with_live_lease`; arm B needs no new marker
because descriptor saturation without receipt is trivially reachable.

## Investigation log

### Q: Is `reserve_until` convergence guaranteed by construction, or is there a state where retrying cannot help?

- Sources examined: `ring.rs:664-759`, `:1072-1086`, `:1108-1154`; `arena.rs:88-128`;
  `crates/mc-host/src/ring_transport.rs:33`, `:44`, `:447-451`, `:580-606`;
  `tests/ring.rs:138-209`, `:581-647`.
- Findings: the retry set is exactly right for the fault-free case. All three
  exhaustion causes map to the one retried variant, and the slot rollback at `:710`
  and `:715` means a failed arena plan does not leak the descriptor slot it had already
  claimed. The compare-exchange loss at `:700` deserved a check of its own, since a
  losing CAS is normally permanent: `slot_ptr` maps sequence to index `(sequence - 1) %
  descriptor_depth` (`:1074`), so the slot for `published + 1` was last used by
  sequence `published + 1 - depth`, and the depth gate at `:683` already guarantees
  that sequence is at or below `completed`, hence reclaimed to `SLOT_FREE` at `:1146`.
  In the fault-free case the CAS therefore cannot lose, and the `Exhausted` at `:700`
  is a defensive path. It is the same path a killed producer wedges permanently, which
  is `crashed-producer-does-not-wedge-the-sequence` and is out of scope here.
- Missing evidence: nothing for the mechanism. Untested rather than unknown is the
  cross-process visibility bound; the existing two-process test uses a 5-second
  deadline and a 50 ms sleep, which is three orders of magnitude of slack and so
  measures nothing about latency.
- Conclusion: resolved with answer — convergence holds by construction in the
  fault-free case, and the tight bound is one `try_reserve` after the release becomes
  visible, because `reclaim_completed` drains the entire contiguous prefix per call.
  The property is worth cataloging because that bound is nowhere asserted, and the one
  test that touches convergence uses a deadline loose enough to hide a reclaimer that
  advanced one sequence at a time.

### 2026-08-31: re-derivation against the eventfd doorbell mechanism

- Sources examined: `crates/mc-shm-transport/src/backend/ring.rs:384-467`,
  `:905-978`, `:980-1048`, `:1229-1241`, `:1418-1432`, `:1470-1565`;
  `crates/mc-shm-transport/src/arena.rs:89-112`;
  `crates/mc-host/src/ring_transport.rs:276`, `:479-483`, `:560-630`;
  `crates/mc-shm-transport/tests/ring.rs:128-209`, `:551-625`.
- Findings: the retry set, the single `reclaim_completed` call site, and the
  one-pass prefix drain all survive PR #131; the pre-refactor citation targets
  moved but the logic is line-for-line recognisable. What changed is the wait
  between retries: `reserve_until` went from a 50-microsecond sleep loop
  (`ColdParkWake`) to a park/recheck/park protocol against the `capacity_ready`
  doorbell, with `release` signalling only a parked waiter. The convergence
  argument therefore gains a step: the release must not only publish
  `completion_sequence`, it must wake the producer, and the arm/recheck ordering
  (`try_reserve` re-run after every park and after every drain) is what makes a
  release that lands mid-arm safe. The old "one poll quantum is the floor" clause
  is void; nothing in the code constant-bounds wake latency.
- Missing evidence: unchanged — the cross-process visibility bound is untested,
  and there is now additionally no measured figure for doorbell wake latency to
  inform the inner bound a test should assert.
- Conclusion: resolved with answer — the guarantee and the one-attempt reclaim
  bound survive; the poll-quantum floor is replaced by doorbell wake latency, the
  `reserve_until` arm doubles as the lost-wake detector, and the inner
  cross-process bound must be a recorded wall-clock choice rather than a count of
  poll rounds.
