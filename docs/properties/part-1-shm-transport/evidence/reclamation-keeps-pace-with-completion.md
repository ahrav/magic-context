# reclamation-keeps-pace-with-completion

## Discovery trigger

Arena reclamation is strict FIFO: one retained lease pins `arena_reclaimed` and blocks
byte reclamation for every sequence behind it, however many have been released. The
catalog already covers the pathological side of that design — a stale cursor, a
peer-chosen advance — but not the ordinary side. Nothing states that when no lease is
retained, reclamation actually catches up, or how far it must catch up per pass. The
existing FIFO test releases the blocking lease and then asks for a single byte, which
one reclaimed sequence out of two satisfies.

## Evidence trail

- `crates/mc-shm-transport/src/backend/ring.rs:1106-1152` `reclaim_completed`. It reads
  `completed` (`:1109`), then loops: for `next = completed + 1` it loads
  `completion_sequence` with `Acquire` (`:1116`) and **breaks at the first gap**
  (`:1117-1118`). That break is the head-of-line mechanism. When the sequence is
  contiguous it requires `SLOT_RELEASE_PENDING` (`:1121-1123`), revalidates the
  descriptor (`:1125-1130`), requires `allocation_start == arena_reclaimed`
  (`:1133-1135`), then advances `arena_reclaimed` (`:1136-1143`), clears
  `reservation_len` and `completion_sequence`, frees the slot, and stores `completed`
  (`:1144-1147`). The loop continues, so **one call drains the entire contiguous
  completed prefix**, not one sequence.
- `ring.rs:673` — the only call site of `reclaim_completed` in the repository, confirmed
  by search: the first statement of `try_reserve`. Reclamation is producer-driven and
  lazy. A receiver that releases everything while the producer never reserves again
  leaves every byte and every slot charged indefinitely, and that is by design rather
  than a defect. It fixes the shape of the bound: the window is counted in producer
  reserve attempts, not in wall-clock time.
- The two capacities reclamation feeds. Descriptors: `try_reserve` computes
  `outstanding = published - completed` and refuses at `outstanding >=
  descriptor_depth` (`:677-684`). Bytes: `SpanPlan::reserve` computes `used = write -
  reclaimed` and returns `ArenaError::Exhausted` when `len > capacity - used`
  (`crates/mc-shm-transport/src/arena.rs:103-111`). Both cursors advance only in
  `reclaim_completed`, at `:1147` and `:1140-1143`.
- `ring.rs:902-906` — the receiver's half of the edge: `completion_sequence` stored with
  `Release` after the `SLOT_RECEIVER_LEASED → SLOT_RELEASE_PENDING` compare-exchange at
  `:884-891`. `Release` at `:905` pairs with `Acquire` at `:1116`.
- The observable healthy state: `conservation()` (`:911-995`) counts `SLOT_FREE` into
  `descriptors.free` (`:935`) and derives `bytes.free = arena_bytes - charged`
  (`:989-993`). Full recovery is `descriptors.free == descriptor_depth` and
  `bytes.free == arena_bytes`. Caveat carried from
  `reservation-charge-visible-with-non-free-state`: `bytes.free` is derived, so
  `ArenaCounts::conserves` is arithmetically self-satisfying and only
  `descriptors.free` plus a successful full-size reserve are independent evidence.
- Existing check, and the exact gap:
  `retained_oldest_lease_enforces_fifo_reclamation_and_release_validation`
  (`crates/mc-shm-transport/tests/ring.rs:148-219`). It publishes 40 MiB at sequence 1
  and holds its lease (`:154-162`), publishes the remaining 24 MiB at sequence 2 and
  releases it immediately (`:164-171`), and asserts the head-of-line consequence:
  `try_reserve(1)` is `Exhausted` (`:198-201`), `bytes.free == 0` (`:210`),
  `receiver_leased == 1` and `release_pending == 1` (`:208-209`). That half is good. Then
  it releases the retained lease (`:212`) and asserts `try_reserve(1)` succeeds
  (`:213-215`). With `arena_bytes == MAX_FRAME_BYTES == 64 MiB` fully charged, a
  reclaimer that advanced only sequence 1 would leave 40 MiB free — and a one-byte
  request succeeds against 40 MiB exactly as it succeeds against 64 MiB. The test cannot
  see the difference.
- `boundary_round_trips_include_wrap_and_exact_maximum` (`tests/ring.rs:66-146`) does
  assert full recovery at `:141-145`, but only after a strictly serial
  publish-receive-release cycle where the prefix is never non-contiguous, so it never
  exercises catch-up across more than one sequence.

## Failure scenario

1. A producer publishes several frames. The receiver acquires them and releases all but
   the oldest, so `completion_sequence` is set for the newer sequences while sequence
   `k` stays `SLOT_RECEIVER_LEASED`.
2. `reclaim_completed` breaks at `k` (`:1117-1118`). `arena_reclaimed` and `completed`
   stay pinned. `try_reserve` reports `Exhausted` from either the depth gate or the
   arena gate. This is correct, documented behaviour.
3. The receiver releases lease `k`. The prefix is now contiguous from `completed + 1`
   through the newest released sequence.
4. A defect that makes the loop advance one sequence per call — an early `break`, a
   `return Ok(())` inside the body, or the `completed` reload moved outside the loop —
   leaves the remaining sequences charged after the first reserve.
5. Consequence: capacity returns at one sequence per producer reserve attempt instead of
   all at once. Under `reserve_until` the producer still converges, because each retry
   is another pass, so the defect is invisible to any test with a loose deadline. What
   breaks is the size class: a producer asking for a large frame is refused while the
   arena is mostly reclaimable, and reports `Deadline` on a healthy channel. In the host
   that is an unclean close (`crates/mc-host/src/shm_provider.rs:538-542`). The
   accounting stays self-consistent throughout, so nothing else signals it.

## Timing windows and dependencies

No race window; both cursors are producer-owned and written only in
`reclaim_completed`. The bound has two parts. Visibility: the receiver's `Release` store
at `:905` must be visible to the `Acquire` load at `:1116`, immediate in-process and
bounded by store propagation across processes. Progress: after visibility, **one**
`try_reserve` must reclaim the entire contiguous prefix, because the loop is written to
do exactly that. So the fault-free window is one producer reserve attempt, and any need
for a second is the defect. The producer-driven dependency is strict and is the reason
the bound cannot be phrased in wall-clock terms: with no producer activity, elapsed time
buys nothing. The head-of-line precondition is the situation
`shm_arena_wrap_with_live_lease`, already declared in `fault-map.md`, and it is what
makes the non-contiguous prefix exist in the first place.

## What a test must construct

A non-contiguous completed prefix of length at least two behind a retained lease, then
release, then a single-pass full-recovery assertion. Concretely, against the contract
profile: publish and acquire sequence 1 and hold it; publish, acquire, and release
sequences 2 and 3; assert `descriptors.release_pending == 2` and
`descriptors.receiver_leased == 1` so the non-contiguous shape is witnessed rather than
assumed; release sequence 1; then perform exactly **one** `try_reserve` and assert
`descriptors.free == descriptor_depth` and `bytes.free == arena_bytes` after it. The
size of the request matters: ask for a frame that only fits if every sequence was
reclaimed, so the assertion has an independent witness beyond the derived `bytes.free`.
That single change closes the gap in the existing test, which asks for one byte. Add the
head-of-line arm as the negative control in the same test: before releasing sequence 1,
assert a full-size request is `Exhausted`, so the recovery assertion cannot pass by the
capacity having been available all along. Do not use `reserve_until` for either arm —
its retry loop performs additional reclaim passes and destroys the one-pass bound.

## Investigation log

### Q: Does one `reclaim_completed` call recover the whole contiguous prefix, and is that anywhere asserted?

- Sources examined: `ring.rs:662-734`, `:736-757`, `:846-909`, `:911-995`,
  `:1106-1152`; `arena.rs:88-128`, `:202-219`; `tests/ring.rs:66-146`, `:148-219`;
  `crates/mc-host/src/shm_provider.rs:538-542`.
- Findings: yes to the first, no to the second. The loop structure at `:1110-1150` is
  unambiguous — the only exits are the gap `break`, an error, or exhausting the prefix —
  so one call drains everything contiguous. Nothing asserts it. The FIFO test asserts
  the blocking half well and the recovery half with a one-byte request against a 64 MiB
  arena where 40 MiB would also pass. I also checked whether `reserve_until` masks the
  defect and it does: each retry is another pass, so convergence still happens and only
  the large-frame case fails. That is why the check must be a single `try_reserve` and
  must request a size that needs the full arena.
- Missing evidence: nothing for the mechanism. Untested rather than unknown is the
  cross-process visibility bound, shared with
  `backpressure-converges-in-a-bounded-reclaim-window`; the one two-process test uses a
  50 ms sleep against a 5-second deadline and measures no latency.
- Conclusion: resolved with answer — the healthy-case liveness statement is "one
  producer reserve attempt restores the entire contiguous prefix", the distinguishing
  assertion against head-of-line blocking is a full-size request rather than a one-byte
  request, and the bound must be counted in producer attempts because `try_reserve` is
  the sole driver of reclamation.
