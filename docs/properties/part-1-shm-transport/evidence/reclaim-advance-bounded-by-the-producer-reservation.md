# reclaim-advance-bounded-by-the-producer-reservation

## Discovery trigger

`reclaim_completed` is producer-side code that advances the producer's own arena
cursor. Reading it showed that the distance it advances comes from a field it
re-reads out of shared memory at reclaim time, not from anything the producer
retained. `DescriptorSlot` carries an atomic `reservation_len` that looks like it
was meant to be that retained record, and `reclaim_completed` does not read it.

## Evidence trail

All references are to `crates/mc-shm-transport/src/backend/ring.rs`.

- `:1106-1152` — `reclaim_completed`, the whole loop. It runs on the producer and
  walks completions in strict publication order.
- `:1116-1119` — the loop advances only while `completion_sequence == next`, so
  reclamation head-of-line blocks behind the lowest unreleased sequence.
- `:1121-1123` — the slot must be `SLOT_RELEASE_PENDING`, else
  `InvalidSharedState`.
- `:1125` — `let descriptor = unsafe { std::ptr::read_volatile((*slot).descriptor.get()) };`
  This is a *second* read of the same descriptor. The first was at `:802` during
  `try_receive`, in the other process.
- `:1127-1130` — the re-read descriptor is re-validated with
  `validate(expected, self.arena_bytes())`. This re-runs the full identity and
  span ladder, so a rewritten descriptor must still be internally consistent.
- `:1132-1135` — the only ordering guard: `validated.allocation_start() !=
  reclaimed` rejects as `InvalidSharedState`. This pins where the advance starts.
- `:1136-1138` — `let new_reclaimed = reclaimed.checked_add(validated.allocation_len())`.
  This is the distance, taken from the re-read record. Nothing compares it to what
  the producer reserved.
- `:113` — `reservation_len: AtomicU64` in `DescriptorSlot`.
- `:720-724` — the producer writes it: `(*slot).reservation_len.store(plan.allocation_len(), Ordering::Relaxed)`
  at reservation time, so the value is the producer's own reservation length.
- `:933` — the only read of `reservation_len` anywhere: inside `conservation()`,
  for the per-state byte tally. `reclaim_completed` never reads it.
- `:1144` and `:1158` — the only other writes, both stores of `0` during reclaim
  and abort.
- `:229` and `:258` — `Mapping::create` and `Mapping::attach` both map the whole
  object `PROT_READ | PROT_WRITE`.
- `:1709` — required seals are `F_SEAL_GROW | F_SEAL_SHRINK | F_SEAL_SEAL`. No
  `F_SEAL_WRITE`, so both the `descriptor` cell and the `reservation_len` atomic
  are peer-writable at any time.
- `crates/mc-shm-transport/src/arena.rs:103-108` — the downstream catch.
  `SpanPlan::reserve` computes `used = write.checked_sub(reclaimed)` and returns
  `ArenaError::InvalidCursor` on underflow, and again if `used > capacity`. An
  over-advanced `arena_reclaimed` therefore surfaces later as a cursor error, not
  as an out-of-bounds access.

## Failure scenario

The receiver releases sequence `n`, which stores `completion_sequence = n` and
leaves the slot `SLOT_RELEASE_PENDING`. Before the producer's next
`reclaim_completed`, the peer rewrites that slot's descriptor with a larger
`allocation_len`, keeping `allocation_start` equal to the current `arena_reclaimed`
and keeping the record internally consistent so `:1127-1130` still accepts it.
The producer then advances `arena_reclaimed` by the peer's chosen distance.

Because `arena_reclaimed` is the free-space floor, the producer now believes bytes
that older still-leased frames occupy are free, and a later reservation can be
planned over them. The failure appears as either corrupted payloads for a
concurrently held lease, or as `ArenaError::InvalidCursor` from
`arena.rs:103-108` once `write` and `reclaimed` cross. Both are denial of service
plus corruption rather than memory unsafety, because every span is re-bounds-checked
against the arena in `lease_span` (`:1088-1104`).

## Timing windows and dependencies

The window opens when the receiver's `release` stores `completion_sequence`
(`:901-907`) and closes when the producer's `reclaim_completed` reads the slot
(`:1125`). Nothing bounds it: reclamation runs only when the producer next
reserves or explicitly reclaims, so a producer idle for minutes leaves the window
open for minutes. Both candidate sources of truth are in the same writable
mapping, so this cannot be fixed by preferring `reservation_len` over the
descriptor without also changing where that record lives. Shares its root with
`quarantine-authority-survives-peer-writes` and
`no-rust-reference-over-peer-writable-payload`. Depends on
`validated-spans-are-disjoint-and-inside-the-arena` for the re-validation at
`:1127-1130` being as strong as claimed.

## What a test must construct

A `RELEASE_PENDING` slot whose descriptor is rewritten between release and
reclaim — fault class F2, which no harness provides. The rewrite must be
consistent: `allocation_start` unchanged, `allocation_len` increased,
`span_count`, span offsets, span lengths, `body_len`, and the wire header all
adjusted so `validate` still accepts. The oracle is that `arena_reclaimed`
advances by the length the producer stored at `:722`, or that reclaim rejects. A
weaker but immediately available check: assert in `reclaim_completed` that
`validated.allocation_len() == (*slot).reservation_len.load(...)`, which turns
the property into a production guard and would fail on any peer rewrite of either
field. Because the confirming evidence is a byte-level identity, the test also
needs `shm_arena_wrap_with_live_lease` as a coverage check so the head-of-line
case is actually reached.

## Investigation log

### Q: Was the atomic `reservation_len` (`ring.rs:113`) intended to be the producer's trusted record? It is written but never read by `reclaim_completed`. A producer-local table would be trustworthy; is that feasible given `Ring` is thread-confined?

- Sources examined: `git log -S "reservation_len" -- crates/mc-shm-transport/src/backend/ring.rs`,
  which returns exactly one commit, `6f504bf2` "feat(mc-shm-transport): U9/U4
  bounded shared-memory transport core" — the field's introducing commit, with no
  later change; `ring.rs:912-996` for `conservation()`, its only reader; the
  SAFETY comment at `:932`, "reservation length is atomic and assigned before
  non-free state is observed", which describes an observation contract for a
  *reader of the snapshot*, not a trust contract; `ring.rs:525-532` for `Ring`'s
  `PhantomData<Rc<()>>` marker.
- Findings: the field's single documented purpose is the conservation snapshot.
  Nothing in the introducing commit, the field's comments, or
  `docs/mc-host-shm-transport.md` describes it as an authoritative record for
  reclamation. On feasibility: `Ring` carries `_not_send_or_sync:
  PhantomData<Rc<()>>` (`:531`) and takes `&self` on every operation, so it is
  thread-confined by construction. A `RefCell<[u64; depth]>` or equivalent held in
  the `Ring` value would be private, process-local, and unreachable by the peer,
  so a producer-local table is structurally possible. Whether the producer and the
  reclaiming code are always the same `Ring` value in every deployment was not
  established: `reclaim_completed` is called from the producer path, but I did not
  trace every caller.
- Missing evidence: any statement of design intent for `reservation_len`. Also
  unestablished: whether a peer rewrite can actually get past `:1127-1130` and
  `:1133` together while remaining internally consistent. I constructed the
  requirements above by reading the guards but did not build a concrete accepted
  tuple, which is why the catalog confidence is medium rather than high.
- Conclusion: unresolved, needs an exploitability construction. Specifically:
  one concrete field tuple that `validate` accepts, that satisfies
  `allocation_start == arena_reclaimed`, and whose `allocation_len` exceeds the
  producer's stored `reservation_len`. Until that exists the record is a lead
  about a missing cross-check rather than a demonstrated defect. The
  design-intent half needs human input.
