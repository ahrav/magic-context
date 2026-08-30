# backpressure-converges-in-a-bounded-reclaim-window

## Discovery trigger

Every existing liveness record in this part concerns a fault: a crashed producer, a
stale cursor, a discarded release. None states that the transport makes progress when
nothing is wrong. `reserve_until` is the only place in the transport that converts
"no capacity right now" into "wait and try again", and it retries exactly one error
variant. That makes it the one function whose correctness is the difference between a
transport that applies backpressure and a transport that stalls, and nothing states
what it must achieve.

## Evidence trail

- `crates/mc-shm-transport/src/backend/ring.rs:743-756` `reserve_until`. The loop
  retries only `Err(ProducerError::Exhausted)` and only while `Instant::now() <
  deadline` (`:745`); a sustained `Exhausted` becomes `ProducerError::Deadline`
  (`:753`); every other outcome, success or error, returns immediately (`:754`).
  Retry spacing is `std::hint::spin_loop()` under `HotPinnedPoll` and
  `std::thread::sleep(Duration::from_micros(50))` under `ColdParkWake`
  (`:747-750`). The shipped host profile selects `ColdParkWake`
  (`crates/mc-host/src/shm_provider.rs:81`), so the polling quantum is 50 microseconds.
- Three distinct conditions all surface as `Exhausted`, so all three are retried:
  descriptor depth full, `outstanding >= descriptor_depth` (`:683-684`); a lost
  `SLOT_FREE → SLOT_PRODUCER_RESERVED` compare-exchange (`:700`); and arena
  exhaustion from `SpanPlan::reserve`, which rolls the slot back to `SLOT_FREE`
  before returning (`:708-712`). `ArenaError::Exhausted` is produced when `len >
  capacity - used` with `used = write - reclaimed`
  (`crates/mc-shm-transport/src/arena.rs:103-111`).
- `ring.rs:673` — the mechanism that makes retrying useful:
  `try_reserve` calls `self.reclaim_completed()` before reading any cursor. This is
  the **only** call site of `reclaim_completed` in the repository, confirmed by search.
  Reclamation is therefore producer-driven and lazy: a retry is not a passive wait, it
  is the act that recovers capacity.
- `ring.rs:1106-1152` `reclaim_completed` drains the whole contiguous completed prefix
  in one call. The loop advances while `completion_sequence == completed + 1`
  (`:1111-1117`) and breaks at the first gap (`:1117-1118`), advancing
  `arena_reclaimed` (`:1140-1143`) and `completed` (`:1147`) once per reclaimed
  sequence. One call is enough; a second adds nothing unless a new completion landed.
- `ring.rs:902-906` — the receiver end of the edge. `release` stores
  `completion_sequence` with `Release` and decrements `active_leases`. The producer's
  matching `Acquire` load is `ring.rs:1116`.
- Existing check, partial: `two_process_zero_copy_exchange_uses_authenticated_grant`
  (`crates/mc-shm-transport/tests/ring.rs:565-602`). The parent fills the arena with
  one `MAX_FRAME_BYTES` frame, then calls `reserve_until(1, .., now + 5s)` while the
  child holds the lease and sleeps 50 ms (`:584-591`, child at `:625-627`). The
  `.unwrap()` at `:591` is a genuine convergence assertion, and
  `assert!(waiting_since.elapsed() >= Duration::from_millis(25))` at `:592` keeps it
  from passing vacuously. What it does not do: exercise descriptor-depth exhaustion,
  bound convergence any tighter than five seconds, or assert that capacity returned in
  full.
- Existing check, negative direction:
  `retained_oldest_lease_enforces_fifo_reclamation_and_release_validation`
  (`tests/ring.rs:202-206`) asserts `reserve_until(.., Instant::now())` returns
  `Deadline`. That pins the give-up path, not the converge path.

## Failure scenario

1. A producer offers a frame while the arena is full or the descriptor ring is at
   depth. `try_reserve` returns `Exhausted` and `reserve_until` begins retrying.
2. The receiver drains normally: it acquires the oldest frame, copies it, and releases
   the lease, storing `completion_sequence` (`:905`).
3. A defect anywhere in the recovery chain — `reclaim_completed` not called from the
   retry path, the loop advancing at most one sequence per call, the `Acquire` load at
   `:1116` weakened, or `reserve_until` misclassifying the retryable variant — leaves
   `completed` and `arena_reclaimed` behind their true values.
4. `reserve_until` keeps returning `Exhausted` until the deadline and reports
   `ProducerError::Deadline`. In the host that is an outbound publish failure:
   `publish_one` returns `Err`, the endpoint cancels the generation and returns
   `false`, and the close is unclean, so the candidate's charges are reported as a
   suspect (`crates/mc-host/src/shm_provider.rs:538-542`, `:364-371`).
5. The operator-visible symptom is a retired generation attributed to a transport
   fault, on a channel where the peer was draining correctly the entire time.

## Timing windows and dependencies

The window opens at the first `Exhausted` and closes at the deadline. Three quantities
bound it and all three must be stated for a test to be refutable. First, visibility:
the producer cannot observe a release until the `Release` store at `:905` is visible
to the `Acquire` load at `:1116`, which is immediate in-process and bounded by store
propagation across processes. Second, the reclaim pass: one `try_reserve` recovers the
entire contiguous completed prefix, so the bound after visibility is **one further
attempt**, not a number proportional to the backlog. Third, the polling quantum: under
`ColdParkWake` retries are 50 microseconds apart (`:749`), so no bound below one
quantum is measurable, and a test asserting a tighter one fails for a measurement
reason rather than a defect. `HotPinnedPoll` has no such floor but burns the calling
thread. Dependency on the fault-free window is strict: the property is stated for a
receiver that keeps releasing. Under a retained lease, non-convergence is the
documented FIFO behaviour, which is why `reclamation-keeps-pace-with-completion`
carries the head-of-line case separately.

## What a test must construct

Offered load that actually exhausts capacity, then removal of the pressure, then a
bounded poll. Two arms, because the two exhaustion causes are independent and only one
is covered today. Arm A, arena exhaustion: fill the arena with one maximum frame, hold
its lease, assert `try_reserve` returns `Exhausted`, release, then assert the **next
single** `try_reserve` succeeds — not `reserve_until` with a generous deadline, because
that cannot distinguish one reclaim pass from a thousand. Arm B, descriptor
exhaustion: publish `descriptor_depth` small frames without receiving, assert
`Exhausted`, then receive and release all of them and assert one `try_reserve`
succeeds. Both arms must also assert the negative: with a deadline set beyond the
release, `reserve_until` returns `Ok`, and the elapsed time is strictly below the
deadline, so a `Deadline` return is a failure rather than a slow pass. Cross-process
form: keep the 5-second deadline of the existing test as an outer safety bound, but
assert convergence within an explicit inner bound of N poll rounds after the release
is observed, and fail if N is exceeded. Enabling situation is already declared in
`fault-map.md` as `shm_arena_wrap_with_live_lease`; arm B needs no new marker because
descriptor saturation without receipt is trivially reachable.

## Investigation log

### Q: Is `reserve_until` convergence guaranteed by construction, or is there a state where retrying cannot help?

- Sources examined: `ring.rs:662-757`, `:1070-1084`, `:1106-1152`; `arena.rs:88-128`;
  `crates/mc-host/src/shm_provider.rs:55`, `:81`, `:538-542`, `:665-691`;
  `tests/ring.rs:148-219`, `:565-631`.
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
