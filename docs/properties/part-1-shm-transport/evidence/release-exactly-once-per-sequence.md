# release-exactly-once-per-sequence

## Discovery trigger

`ReleaseIdentity` is a value that several parties can hold at once — the receiver
gets one from `try_receive`, the producer gets the same one from `commit`, and the
addon copies it into its own table. Descriptor slots are reused every
`descriptor_depth` sequences. So the question is which mechanism actually arbitrates
between competing releases: the identity comparison, or something else. The
identity comparison cannot be the arbiter, because a stale identity can match a
recycled slot's descriptor bytes on a later lap.

## Evidence trail

- `crates/mc-shm-transport/src/backend/ring.rs:1072-1088` `slot_ptr` — the index is
  `(sequence - 1) % self.grant.descriptor_depth` (`:1076`). Sequences `N` and
  `N + depth` share one slot, so identity uniqueness across laps is a property of
  the descriptor contents, not of the address.
- `ring.rs:886-893` — the single mutation point:
  ```rust
  let changed = unsafe {
      (*slot).state.compare_exchange(
          SLOT_RECEIVER_LEASED,
          SLOT_RELEASE_PENDING,
          Ordering::AcqRel,
          Ordering::Acquire,
      )
  };
  ```
  Exactly one caller can observe `SLOT_RECEIVER_LEASED` and move the slot on. Every
  side effect of a successful release — the `completion_sequence` store and the
  `active_leases` decrement at `:904-908` — is downstream of it, so both inherit its
  exactly-once character.
- `ring.rs:894-902` — the error mapping: an observed `SLOT_RELEASE_PENDING` or
  `SLOT_FREE` becomes `LeaseError::DuplicateRelease`; anything else becomes
  `InvalidSequence`. This is the only place `DuplicateRelease` originates on the ring
  path.
- `ring.rs:867-884` — the checks that run *before* the CAS: a `consumed` acquire load
  (`:867`) with `sequence > consumed` rejected (`:868`), then a
  `std::ptr::read_volatile((*slot).descriptor.get())` (`:875`) and three field
  comparisons against the identity (`:876`, `:879`, `:882`). None of these is atomic
  with the CAS at `:886`, and the descriptor read is a separate access from the state
  transition.
- `crates/mc-shm-transport/src/lease.rs:198-206` `release_once` — a second,
  independent guard: `if self.released { return Err(LeaseError::DuplicateRelease); }`
  (`:199-201`). So duplicates *through one lease handle* are caught locally without
  ever reaching the ring. Corrected span: `:198-206`, not `:198-208`.
- `lease.rs:215-221` `Drop` — the third release entry point, discarding its result
  at `:218`. A duplicate arriving here is therefore invisible; see
  `release-failure-is-observable`.
- `ring.rs:1108-1154` `reclaim_completed` — after a successful release the producer
  resets `reservation_len`, `completion_sequence`, and `state` (`:1146-1148`) but
  **not** the descriptor body, so residual descriptor bytes from the previous lap
  survive in the slot until the next `commit_reservation` overwrites them at
  `:1206`.
- Existing checks, corrected: the sequential-case ladder is
  `crates/mc-shm-transport/tests/ring.rs:163-187`, not `:164-189` — `:188-191` is the
  following `Exhausted` assert. It covers wrong incarnation (`:164-170`), wrong lane
  (`:171-178`), wrong sequence (`:179-186`), and duplicate (`:187`).
  `tests/ring.rs:212` `stale_lap_release_cannot_complete_recycled_slot` is confirmed
  and is a genuine full-lap test: it wraps `depth` sequences (`:216-221`), leases a
  fresh frame (`:224`), and asserts the lap-old identity yields `InvalidSequence`
  (`:225-229`).

## Failure scenario

The sequential cases are covered. The uncovered one is the read-then-CAS window,
which needs a second party progressing between `:873` and `:884`:

1. Party A holds a stale identity for sequence `N` — for example a copy kept after
   its lease was already completed, or a lap-old identity.
2. Party A calls `release(N)`. The quarantine, incarnation, lane, and `consumed`
   checks pass. At `:873` it reads the descriptor and, because the slot still holds
   sequence `N`'s residual bytes, the three comparisons at `:874-882` pass.
3. Before A reaches `:884`, the legitimate holder of `N` releases, the producer
   runs `reclaim_completed` and frees the slot (`:1146`), then reserves, commits
   sequence `N + depth` into the same slot (`:1204-1207`), and the receiver leases
   it (`:824`).
4. A's CAS at `:884-891` now observes `SLOT_RECEIVER_LEASED` — belonging to
   `N + depth`, not `N` — and succeeds.
5. `completion_sequence` is stored as `N`, not `N + depth` (`:902-905`). The next
   `reclaim_completed` compares `completion != next` at `:1117` and breaks, so
   reclamation stalls; meanwhile `active_leases` has been decremented for a lease
   that is still live (`:906`).
6. Consequence: two releases counted for one sequence, one live lease with its
   accounting already returned, and a reclamation cursor that no longer advances.
   The legitimate holder's later `Drop` gets `DuplicateRelease`, discarded at
   `lease.rs:218`.

## Timing windows and dependencies

The window is the instruction span between the descriptor `read_volatile` at
`ring.rs:875` and the compare-exchange at `:886` — a handful of loads and branches,
so it is narrow but real, and it is entered on every release call. Constructing the
interleaving requires a *full lap* of `descriptor_depth` sequences to complete
inside it, which is why physical concurrency alone is an implausible constructor and
a deterministic scheduling point is the practical route. No configuration
dependency; no platform gating, though the `Acquire` failure ordering at `:891` and
the `Relaxed` `active_leases` operations at `:828` and `:908` mean a weakly-ordered
target is the honest place to run it. Relationship: this record dominates
`release-authority-bound-to-lease-ownership` only for *duplicate* releases; a first
release by the wrong party passes this property's check and is that record's
concern. `receive-failure-leaves-no-wedged-slot` shares the same CAS as its arbiter,
approached from the receive side.

## What a test must construct

At least two release attempts for one sequence, and for the uncovered case they must
interleave. Concretely: a deterministic scheduling point immediately after the
descriptor read at `ring.rs:875` (fault class F3, absent today), holding party A
there while a second party performs a legitimate release, a `reclaim_completed`, a
reserve, a commit that reuses the slot, and a fresh `try_receive`; then release A and
assert its CAS fails. The oracle is per-identity, not aggregate: for the multiset of
release calls carrying one identity, exactly one returns `Ok`, and `active_leases`
is decremented exactly once. Assert `active_leases` directly rather than inferring
it from `conservation()`, and assert that `completion_sequence` never holds a value
for a sequence whose lease is still live. Coverage checks to emit:
`shm_full_lap_slot_recycled` and `shm_release_raced_with_reclaim`.

## Investigation log

### Q: Is the descriptor re-read at `:873` atomic with the arbitrating CAS at `:884`, and does that gap admit a second successful release for one sequence?

The catalog records no open question here; the record's own Impact names this gap as
the thing to make explicit, so it is the question investigated.

- Sources examined: `ring.rs:849-911` (`release` in full), `:1072-1088`
  (`slot_ptr` indexing), `:1108-1154` (`reclaim_completed`, including which slot
  fields are reset at `:1146-1148`), `:1198-1210` (`commit_reservation`'s descriptor
  write), `crates/mc-shm-transport/src/lease.rs:198-221`,
  `crates/mc-shm-transport/tests/ring.rs:138-243` (both existing release tests).
- Findings: the two accesses are separate and nothing serializes them. The
  exactly-once guarantee for *state* is nonetheless sound, because the CAS is the
  sole mutation point and only one caller can win it. What the gap admits is a
  *misattributed* win: a caller whose pre-checks validated sequence `N` completing
  whichever lease occupies the slot at CAS time. Reaching it requires a full lap
  inside the window, which is why the existing full-lap test at `tests/ring.rs:212`
  does not catch it — that test is single-threaded, so the recycle completes long
  before the stale release is attempted and the pre-check at `:880` correctly
  rejects it.
- Missing evidence: none about the code. What is missing is a way to run it — there
  is no failpoint after `:873`, and the repository has no loom, Shuttle, Miri, or
  ThreadSanitizer configuration, so the interleaving cannot be constructed today
  (fault classes F3 and F4).
- Conclusion: resolved with answer — the accesses are not atomic, the exactly-once
  property on state still holds, and the residual hazard is misattribution rather
  than a double success. It remains unexercised, needs F3, and is the reason this
  record stays open despite good sequential coverage.
