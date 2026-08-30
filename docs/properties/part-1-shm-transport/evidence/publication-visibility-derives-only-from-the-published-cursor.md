# publication-visibility-derives-only-from-the-published-cursor

## Discovery trigger

A memory-ordering lens over every access to `DescriptorSlot::state`: enumerate the
stores and loads, note each one's `Ordering`, and check which loads are gated by
an acquire on a publication cursor. One store is `Relaxed` where its five
siblings are `Release`, and one load has no gate.

## Evidence trail

- A grep for `.state.load`, `.state.store`, and `.state.compare_exchange` in
  `crates/mc-shm-transport/src/backend/ring.rs` gives the complete access set,
  which makes this analysis exhaustive rather than sampled:
  - stores: `:710` and `:715` (`try_reserve` rollback, `Release`), `:824`
    (`try_receive` to `SLOT_RECEIVER_LEASED`, `Release`), `:1146`
    (`reclaim_completed` to `SLOT_FREE`, `Release`), `:1159`
    (`abort_reservation` to `SLOT_FREE`, `Release`), and `:1205`
    (`commit_reservation` to `SLOT_PUBLISHED`, **`Relaxed`**);
  - compare-exchanges: `:694` (`try_reserve`), `:793` (`try_receive`), `:885`
    (`release`), all `AcqRel` on success and `Acquire` on failure;
  - plain loads: `:931` (`conservation`) and `:1121` (`reclaim_completed`), both
    `Acquire`.
- `ring.rs:1205-1210` is the publication sequence, in program order:
  `write_volatile` of the descriptor at `:1206`, `state.store(SLOT_PUBLISHED,
  Relaxed)` at `:1207`, `arena_write.store(..., Relaxed)` at `:1208`, and
  `published.store(sequence, Release)` at `:1209`. **Correction:** the catalog
  cites `:1204-1210`; `:1204` is the SAFETY comment and `:1203` the `unsafe {`.
  The stores are `:1206-1209`.
- The consequence is precise. A `Relaxed` store does not head a release sequence,
  so the `Acquire` load of `state` at `:933` has nothing to synchronize with when
  it observes `SLOT_PUBLISHED`. The `Release` store at `:1209` is to a different
  location (`ProducerPage::published`), so acquiring `state` does not order
  against it either. An observer that reaches `SLOT_PUBLISHED` through `:933` has
  no happens-before edge to the descriptor write at `:1206`.
- The correct pattern is present in the same file, which is what makes the
  omission look unintentional. `reclaim_completed` loads
  `completion_sequence` with `Acquire` at `:1118` and only then loads `state` at
  `:1123` and reads the descriptor at `:1127`. The comment at `:1117` states the
  pairing: "SAFETY: acquire pairs with receiver release publication." The matching
  `Release` store is at `:904-907` in `release`.
- The receive path is also correctly gated. `try_receive` loads `published` with
  `Acquire` at `:783`, checks `consumed == published` at `:784-786`, and only then
  compare-exchanges the slot at `:792-802` and reads the descriptor at `:804`. The
  comment at `:803` states the dependency: "SAFETY: acquire publication made
  descriptor visible; one read snapshots all fields."
- The ungated load's blast radius is bounded today. `conservation()`
  (`ring.rs:914-997`) reads only `state` at `:933` and `reservation_len` at `:935`
  and never touches `(*slot).descriptor` or arena bytes. So the present
  consequence is an accounting-accuracy question, not undefined behaviour.
- `ring.rs:112` shows `reservation_len` is `AtomicU64`, so the `Relaxed` load at
  `:935` is a well-defined atomic read of a possibly stale value rather than a
  race.
- Existing check: none. `two_process_zero_copy_exchange_uses_authenticated_grant`
  (`crates/mc-shm-transport/tests/ring.rs:581`) is the only cross-process test; it
  exchanges one frame in lockstep with a sleep, so it cannot place a reader inside
  the window.
- `docs/properties/part-1-shm-transport/existing-checks.md:181-183` records that
  no loom, shuttle, Miri, or ThreadSanitizer configuration exists anywhere in the
  repository, so no tool currently checks any ordering choice in this file.

## Failure scenario

1. The producer commits. The descriptor bytes are written at `ring.rs:1206` and
   the slot state becomes `SLOT_PUBLISHED` at `:1207` with `Relaxed` ordering.
2. On a weakly-ordered target the store at `:1207` may become visible to another
   core before the descriptor write at `:1206`, because no barrier separates them
   and the store carries no release semantics.
3. An observer in the peer process calls `conservation()`, loads `state` at
   `:933`, and observes `SLOT_PUBLISHED`.
4. Today it stops there and only mis-attributes bytes. The unsoundness is
   conditional on a future reader: any code that follows this path into
   `(*slot).descriptor` or the arena would read bytes it has no ordering edge to,
   which is a data race and undefined behaviour rather than a stale value, because
   `descriptor` is an `UnsafeCell<SharedDescriptor>` (`ring.rs:113`) accessed with
   `read_volatile` and not an atomic.

The reason this is cataloged as safety rather than as accounting is step 4. The
guard against it is a convention that nothing reads the descriptor from slot
state, and no comment, type, or test enforces that convention.

## Timing windows and dependencies

The window is the reorder distance between the two stores at `:1204` and `:1205`,
which is a hardware and compiler property with no upper bound in the abstract
machine. On x86-64's TSO model, store-store reordering is not permitted, so the
window is empirically unobservable there even though the Rust abstract machine
permits it; on aarch64 or Graviton it is observable. That makes platform gating
essential to any test: a passing result on x86-64 proves nothing. The property
depends on `reservation-charge-visible-with-non-free-state` for its practical
severity, because both are only observable through `conservation()`, and that
function has no production caller at this commit (`Ring::probe` at `ring.rs:1004`
is its only non-test caller, and `ShmRecoveryBackend::probe` at
the host-side readiness probe that returned a constant without touching a
`Ring`).

## What a test must construct

Either a genuine cross-process race on a weakly-ordered target, or a model
checker. The concrete shape for the hardware route is: one process committing
frames in a tight loop while a second process polls `conservation()` on the same
mapping, on aarch64, with an oracle that is not `ArenaCounts::conserves` because
that predicate is arithmetically self-satisfying (`arena.rs:204-216` against
`ring.rs:991-995`). The oracle must be a per-slot cross-check of `reservation_len`
and the descriptor's `allocation_len` for slots the observer finds non-free.

The model-checker route is more tractable and does not need the hardware. Extract
the slot state machine and the four cursors into a `cfg(loom)` harness with two
threads, one running the commit sequence of `:1204-1207` and one running the
observer sequence of `:931-933` extended to read the descriptor, and assert the
observer never sees a `SLOT_PUBLISHED` slot with an unwritten descriptor. That
extension is the point: it asserts the property the current code relies on
convention for. Neither route exists today, and adding loom is itself the missing
capability recorded as F5 in
`docs/properties/part-1-shm-transport/fault-map.md`.

## Investigation log

### Q: Is the relaxed state store intentional, given `abort_reservation` and `reclaim_completed` use `Release` for the same field?

- Sources examined: the complete `state` access grep listed above;
  `ring.rs:1205-1210` (the publication sequence and its SAFETY comment at
  `:1204`, "producer exclusively owns reserved slot and arena range");
  `:1141-1150` (`reclaim_completed`'s stores, with the comment at `:1141`,
  "producer alone reclaims in publication order"); `:1158-1162`
  (`abort_reservation`, comment at `:1158`, "reservation owner calls only before
  publication"); `:704-720` (the rollback stores at `:712` and `:717`, whose
  comments at `:711` and `:716` cite producer ownership); and `:1117` and `:803`
  for the two comments that do name acquire-release pairings.
- Findings: the file's comments are consistent about *ownership* and silent about
  *ordering* for the state field specifically. The only two comments that name a
  pairing are on the `published` and `completion_sequence` cursors, which matches
  the property's own statement that those are the two intended publication edges.
  Read that way, `Relaxed` at `:1207` is defensible: state is meant to be a slot
  ownership token, not a publication edge, and the `Release` on the other five
  stores is then incidental rather than load-bearing. Nothing states this, and
  the SAFETY comment at `:934` in `conservation` cuts the other way by asserting
  an ordering guarantee about a sibling field.
- Missing evidence: no comment, commit message, or plan requirement addresses why
  one store of six is `Relaxed`. There is also no tool result to appeal to, since
  no concurrency checker is configured anywhere in the repository.
- Conclusion: unresolved, needs the author's reasoning recorded in the code. The
  mechanism is fully established and the reading above is a hypothesis, not a
  finding; asserting it as the intent would be fabrication. What is settled
  without an answer: the `Acquire` load at `:933` synchronizes with nothing when it
  observes `SLOT_PUBLISHED`, and the invariant that keeps that safe is unwritten.
