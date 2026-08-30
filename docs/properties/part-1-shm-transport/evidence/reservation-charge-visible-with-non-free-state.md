# reservation-charge-visible-with-non-free-state

## Discovery trigger

A comment-versus-code lens over the `unsafe` blocks. The SAFETY comment above the
`reservation_len` load in `conservation()` asserts an ordering that `try_reserve`
does not establish. The comment is the discovery: it states the property, so it
is a claim the code is supposed to satisfy.

## Evidence trail

- `crates/mc-shm-transport/src/backend/ring.rs:664-736` is `try_reserve`. The
  relevant order is: the quarantine gate at `:672`; `reclaim_completed()` at
  `:675`; the depth check at `:685-687`; the sequence derivation at `:688-690`;
  the `SLOT_FREE -> SLOT_PRODUCER_RESERVED` compare-exchange at `:693-703`; the
  arena planning at `:708-720`; and only then the `reservation_len` store at
  `:722-726`. **Correction:** the catalog says the plan "returns early at `:710`
  and `:715`", which are now `:712` and `:717`. Those lines are the rollback
  `(*slot).state.store(SLOT_FREE, Ordering::Release)` calls; the early returns
  are at `:713` (`ProducerError::Exhausted`) and `:718`
  (`ProducerError::Arena(error)`). The rollback ordering matters to the analysis,
  so the distinction is worth keeping.
- `ring.rs:934-935` is the contradiction, quoted exactly:

  ```rust
  // SAFETY: reservation length is atomic and assigned before non-free state is observed.
  let len = unsafe { (*slot).reservation_len.load(Ordering::Relaxed) };
  ```

  The first half is true: the field is `AtomicU64` (`ring.rs:112`). The second
  half is false: the CAS at `:693-703` makes the state non-free, and the store at
  `:722-726` happens afterwards.
- `ring.rs:933` loads `state` with `Ordering::Acquire` immediately before, and the
  `reservation_len` load at `:935` is `Ordering::Relaxed`. So even the intended
  ordering would not be established by these two loads on their own.
- A grep for `reservation_len` in the file returns six sites: the field
  declaration at `:112`, the store in `try_reserve` at `:724`, the load in
  `conservation` at `:935`, the zeroing in `reclaim_completed` at `:1146`, the
  zeroing in `abort_reservation` at `:1160`, and the initialization at `:1616`.
  **`:935` is the only reader.** So the field exists solely to feed the
  conservation snapshot.
- The rollback path narrows the window in one direction and not the other. On
  arena failure the state returns to `SLOT_FREE` at `:712` or `:717` before the
  early return, so an observer never sees a stranded `PRODUCER_RESERVED` slot from
  a failed plan. The window that remains is the successful path between the CAS
  at `:693-703` and the store at `:722-726`, during which the slot reads
  `PRODUCER_RESERVED` with the previous occupant's `reservation_len`, which
  `reclaim_completed` and `abort_reservation` both zero, so in practice the stale
  value read is `0`.
- `ring.rs:991-995` computes `bytes.free = self.grant.arena_bytes.checked_sub(
  charged)`, where `charged` is the running sum of the per-state buckets built at
  `:938-987`.
- `crates/mc-shm-transport/src/arena.rs:204-216` is `ArenaCounts::conserves`. It
  sums `free`, `producer_reserved`, `published`, `receiver_held`,
  `receiver_leased`, `release_pending`, `pad`, and `quarantined` and compares to
  capacity. Because `free` is defined as `arena_bytes - charged` and `charged` is
  the sum of the other nonzero buckets, the total is identically `arena_bytes`.
  The catalog's claim that `conserves` is arithmetically self-satisfying is
  confirmed by direct read: it cannot detect an under-counted bucket.
- Existing checks: `crates/mc-shm-transport/tests/ring.rs:131-135`, `:197-200`,
  and `:231-234` all call `conservation()` single-threaded between operations, so
  no reservation is ever open when they read. The catalog's ranges are accurate
  to within a line.

## Failure scenario

1. The producer calls `try_reserve(bound, header)`.
2. The compare-exchange at `ring.rs:693-703` succeeds, so slot N reads
   `SLOT_PRODUCER_RESERVED`.
3. Before `:722-726` executes, an observer in another process calls
   `conservation()`. It loads `state` at `:933` and sees
   `SLOT_PRODUCER_RESERVED`, then loads `reservation_len` at `:935` and gets the
   zeroed residual value.
4. `descriptors.producer_reserved` is incremented at `:939` while
   `bytes.producer_reserved` gains `0` at `:940-943`, and `charged` also gains
   `0`.
5. `bytes.free` at `:991-995` is therefore computed as the full arena, so the
   snapshot reports a slot reserved and zero bytes charged for it, and
   `ArenaCounts::conserves` still returns true because the two errors cancel by
   construction.

The consequence is byte-accounting inaccuracy in a cross-process snapshot, not
memory unsafety. No pointer, length, or span is derived from `reservation_len`;
`reclaim_completed` derives its advance from the descriptor's `allocation_len`
instead (`ring.rs:1138-1140`), which is the subject of a separate record.

## Timing windows and dependencies

The window is the instruction interval between the CAS at `:691-701` and the
store at `:720-724`, containing only two atomic loads at `:703` and `:705` and
the `SpanPlan::reserve` call at `:706`. It is short but not bounded by anything,
and on a failed plan the state is rolled back before the observer could
misattribute it, so the only observable case is the success path. There is a
second, wider dependency that changes this property's priority sharply: at this
commit `conservation()` has no production caller. Its only non-test caller is
`Ring::probe()` at `ring.rs:1004`, and the only production `probe` implementation,
`ShmRecoveryBackend::probe` (`crates/mc-host/src/shm_provider.rs:143-147` at
`9c1eb4d1`), returned `true` unconditionally with the comment "No shared state
outlives the endpoint thread, so isolation alone proves the provider side is
clean" and never touched a `Ring`. `ed487e11` deleted that implementation with
`shm_provider.rs` and `provider_recovery.rs`, and nothing in the tree replaces it,
so the observer this property protects still does not exist.

## What a test must construct

Two producer and observer roles that are genuinely concurrent, which the current
harness cannot do: the only cross-process test,
`two_process_zero_copy_exchange_uses_authenticated_grant`
(`crates/mc-shm-transport/tests/ring.rs:581`), is lockstep with a sleep. The
concrete construction is a deterministic pause between `ring.rs:701` and `:720`,
reached by a failpoint rather than by timing, with a second process calling
`conservation()` while the pause is held. The oracle must not be
`ArenaCounts::conserves`, which passes by construction. It must be the per-slot
cross-check the catalog names: for every slot whose state is not `SLOT_FREE`,
assert `reservation_len` equals the `allocation_len` of the reservation that owns
it, read from the descriptor for published and leased slots and from the
producer's own plan for reserved ones.

## Investigation log

### Q: Which is wrong, the comment or the order?

- Sources examined: `ring.rs:664-736` in full, `:934-935` for the comment text,
  `:112` for the field type, and the complete `reservation_len` grep.
- Findings: the code order is unambiguous, and the comment describes the opposite
  order. Storing `reservation_len` before the CAS would be a different hazard,
  because the slot is not yet owned by this producer at that point, so the two
  candidate fixes are not symmetric. Nothing in the file explains the choice.
- Missing evidence: no commit message, comment, or plan requirement establishes
  which of the two the author intended.
- Conclusion: unresolved, needs the author. What is settled is that the comment is
  false as written, and a future reader relying on it would be misled. That alone
  is the reportable finding, and it needs no answer to this question.

### Q: Are `conservation()` and `probe()` test-only? If any cross-process production path calls them, this moves from latent to live.

- Sources examined: a grep for `.conservation()` across `crates/` and
  `packages/`, returning `ring.rs:1004` plus nine call sites in
  `crates/mc-shm-transport/tests/ring.rs`; a grep for `probe` across `crates/`;
  `ring.rs:1000-1005` (`Ring::probe`); and at `9c1eb4d1`
  `crates/mc-host/src/shm_provider.rs:143-147` (`ShmRecoveryBackend::probe`),
  `crates/mc-host/src/provider_recovery.rs:113` (the `probe` trait method) and
  `:530` (its only production call site, inside `resolve_readiness`), all three
  deleted by `ed487e11`.
- Findings: `Ring::conservation()` is called from exactly one non-test place,
  `Ring::probe()`. `Ring::probe()` has no non-test caller. The recovery
  controller's `probe()` at `provider_recovery.rs:530` dispatched to
  `ShmRecoveryBackend::probe`, which returned a constant `true` and never
  constructed or consulted a `Ring`; `ed487e11` deleted both, removing the caller
  rather than the gap. The test at
  `crates/mc-shm-transport/tests/ring.rs:265`
  (`probe_reads_shared_state_without_consuming_a_frame`) is the only exercise of
  `Ring::probe`.
- Missing evidence: whether a future provider is intended to call
  `Ring::probe()` as its readiness probe. The comment at `shm_provider.rs:144-146`,
  deleted by `ed487e11`, argued it was unnecessary for the provider side, which
  was an argument about the single-thread ownership model rather than a permanent
  decision.
- Conclusion: resolved at this commit. Both are effectively test-only, so the
  property stays latent and its priority is lower than the raw contradiction
  suggests. It becomes live if any cross-process readiness or observability path
  starts calling `conservation()`.
