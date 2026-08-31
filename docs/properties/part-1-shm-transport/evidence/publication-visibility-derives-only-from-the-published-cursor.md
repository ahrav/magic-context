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
  - stores: `:953` and `:958` (`try_reserve` rollback, `Release`), `:1115`
    (`try_receive` to `SLOT_RECEIVER_LEASED`, `Release`), `:1554`
    (`reclaim_completed` to `SLOT_FREE`, `Release`), `:1572`
    (`abort_reservation` to `SLOT_FREE`, `Release`), and `:1618`
    (`commit_reservation` to `SLOT_PUBLISHED`, **`Relaxed`**);
  - compare-exchanges: `:937` (`try_reserve`), `:1084` (`try_receive`), `:1213`
    (`release`), all `AcqRel` on success and `Acquire` on failure;
  - plain loads: `:1271` (`conservation`) and `:1485` (`reclaim_completed`), both
    `Acquire`.
- `ring.rs:1615-1621` is the publication sequence, in program order:
  `write_volatile` of the descriptor at `:1617`, `state.store(SLOT_PUBLISHED,
  Relaxed)` at `:1618`, `arena_write.store(..., Relaxed)` at `:1619`, and
  `published.store(sequence, Release)` at `:1620` (re-verified at post-#131
  HEAD: `:1615` is the SAFETY comment, `:1616` the `unsafe {`, and the stores
  are `:1617-1620`).
- The consequence is precise. A `Relaxed` store does not head a release sequence,
  so the `Acquire` load of `state` at `:1269` has nothing to synchronize with when
  it observes `SLOT_PUBLISHED`. The `Release` store at `:1620` is to a different
  location (`ProducerPage::published`), so acquiring `state` does not order
  against it either. An observer that reaches `SLOT_PUBLISHED` through `:1269` has
  no happens-before edge to the descriptor write at `:1617`.
- The correct pattern is present in the same file, which is what makes the
  omission look unintentional. `reclaim_completed` loads
  `completion_sequence` with `Acquire` at `:1482` and only then loads `state` at
  `:1485` and reads the descriptor at `:1489`. The comment at `:1481` states the
  pairing: "SAFETY: acquire pairs with receiver release publication." The matching
  `Release` store is at `:1229-1234` in `release`.
- The receive path is also correctly gated. `try_receive` loads `published` with
  `Acquire` at `:1072`, checks `consumed == published` at `:1073-1075`, and only then
  compare-exchanges the slot at `:1081-1091` and reads the descriptor at `:1093`. The
  comment at `:1092` states the dependency: "SAFETY: acquire publication made
  descriptor visible; one read snapshots all fields."
- The ungated load's blast radius is bounded today. `conservation()`
  (`ring.rs:1250-1333`) reads only `state` at `:1269` and `reservation_len` at `:1271`
  and never touches `(*slot).descriptor` or arena bytes. So the present
  consequence is an accounting-accuracy question, not undefined behaviour.
- `ring.rs:122` shows `reservation_len` is `AtomicU64`, so the `Relaxed` load at
  `:1271` is a well-defined atomic read of a possibly stale value rather than a
  race.
- Existing check: none. `two_process_zero_copy_exchange_uses_authenticated_grant`
  (`crates/mc-shm-transport/tests/ring.rs:551`) is the only cross-process test; it
  exchanges one frame in lockstep with a sleep, so it cannot place a reader inside
  the window.
- `docs/properties/part-1-shm-transport/existing-checks.md:181-183` records that
  no loom, shuttle, Miri, or ThreadSanitizer configuration exists anywhere in the
  repository, so no tool currently checks any ordering choice in this file.

## Failure scenario

1. The producer commits. The descriptor bytes are written at `ring.rs:1617` and
   the slot state becomes `SLOT_PUBLISHED` at `:1618` with `Relaxed` ordering.
2. On a weakly-ordered target the store at `:1618` may become visible to another
   core before the descriptor write at `:1617`, because no barrier separates them
   and the store carries no release semantics.
3. An observer in the peer process calls `conservation()`, loads `state` at
   `:1269`, and observes `SLOT_PUBLISHED`.
4. Today it stops there and only mis-attributes bytes. The unsoundness is
   conditional on a future reader: any code that follows this path into
   `(*slot).descriptor` or the arena would read bytes it has no ordering edge to,
   which is a data race and undefined behaviour rather than a stale value, because
   `descriptor` is an `UnsafeCell<SharedDescriptor>` (`ring.rs:123`) accessed with
   `read_volatile` and not an atomic.

The reason this is cataloged as safety rather than as accounting is step 4. The
guard against it is a convention that nothing reads the descriptor from slot
state, and no comment, type, or test enforces that convention.

## Timing windows and dependencies

The window is the reorder distance between the two stores at `:1617` and `:1618`,
which is a hardware and compiler property with no upper bound in the abstract
machine. On x86-64's TSO model, store-store reordering is not permitted, so the
window is empirically unobservable there even though the Rust abstract machine
permits it; on aarch64 or Graviton it is observable. That makes platform gating
essential to any test: a passing result on x86-64 proves nothing. The property
depends on `reservation-charge-visible-with-non-free-state` for its practical
severity, because both are only observable through `conservation()`, and that
function has no production caller at this commit (`Ring::probe` at `ring.rs:1336`
is its only non-test caller, and `ShmRecoveryBackend::probe` at
the host-side readiness probe that returned a constant without touching a
`Ring`).

## What a test must construct

Either a genuine cross-process race on a weakly-ordered target, or a model
checker. The concrete shape for the hardware route is: one process committing
frames in a tight loop while a second process polls `conservation()` on the same
mapping, on aarch64, with an oracle that is not `ArenaCounts::conserves` because
that predicate is arithmetically self-satisfying (`arena.rs:204-216` against
`ring.rs:1327-1331`). The oracle must be a per-slot cross-check of `reservation_len`
and the descriptor's `allocation_len` for slots the observer finds non-free.

The model-checker route is more tractable and does not need the hardware. Extract
the slot state machine and the four cursors into a `cfg(loom)` harness with two
threads, one running the commit sequence of `:1615-1620` and one running the
observer sequence of `:1267-1271` extended to read the descriptor, and assert the
observer never sees a `SLOT_PUBLISHED` slot with an unwritten descriptor. That
extension is the point: it asserts the property the current code relies on
convention for. Neither route exists today, and adding loom is itself the missing
capability recorded as F5 in
`docs/properties/part-1-shm-transport/fault-map.md`.

## Investigation log

### Q: Is the relaxed state store intentional, given `abort_reservation` and `reclaim_completed` use `Release` for the same field?

- Sources examined: the complete `state` access grep listed above;
  `ring.rs:1615-1621` (the publication sequence and its SAFETY comment at
  `:1615`, "producer exclusively owns reserved slot and arena range");
  `:1548-1556` (`reclaim_completed`'s stores; the pre-#131 comment "producer
  alone reclaims in publication order" now reads "removal succeeded and producer
  exclusively publishes reclaimed capacity" at `:1550`); `:1567-1575`
  (`abort_reservation`, comment at `:1569`, "reservation owner calls only before
  publication"); `:946-962` (the rollback stores at `:953` and `:958`, whose
  comments at `:952` and `:957` cite producer ownership); and `:1481` and `:1092`
  for the two comments that do name acquire-release pairings.
- Findings: the file's comments are consistent about *ownership* and silent about
  *ordering* for the state field specifically. The only two comments that name a
  pairing are on the `published` and `completion_sequence` cursors, which matches
  the property's own statement that those are the two intended publication edges.
  Read that way, `Relaxed` at `:1618` is defensible: state is meant to be a slot
  ownership token, not a publication edge, and the `Release` on the other five
  stores is then incidental rather than load-bearing. Nothing states this, and
  the SAFETY comment at `:1270` in `conservation` cuts the other way by asserting
  an ordering guarantee about a sibling field.
- Missing evidence: no comment, commit message, or plan requirement addresses why
  one store of six is `Relaxed`. There is also no tool result to appeal to, since
  no concurrency checker is configured anywhere in the repository.
- Conclusion: unresolved, needs the author's reasoning recorded in the code. The
  mechanism is fully established and the reading above is a hypothesis, not a
  finding; asserting it as the intent would be fabrication. What is settled
  without an answer: the `Acquire` load at `:1269` synchronizes with nothing when it
  observes `SLOT_PUBLISHED`, and the invariant that keeps that safe is unwritten.
