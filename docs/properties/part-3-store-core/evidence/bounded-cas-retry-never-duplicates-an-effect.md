# bounded-cas-retry-never-duplicates-an-effect

## Discovery trigger

Task 2 asked for read-modify-write sequences that are not inside one
transaction. Two exist by design, and both compensate with a `row_version` CAS
plus a bounded retry loop. The loops are correct; the way they report exhaustion
is not.

## Evidence trail

The two loops:

- `crates/mc-store/src/lib.rs:6727-6757` `set_todo_state`.
  - `:6735` `for _ in 0..8 {`
  - `:6736` `let loaded = self.load(session_id)?;` — its own read transaction
    (`load` at `:5481` uses `self.inner.with_conn`).
  - `:6737-6741` short-circuits to `TodoStateSetOutcome::Noop` when
    `last_todo_state_owner_message_id` and `last_todo_state_hash` already match
    the requested values.
  - `:6742-6745` mutates `meta` in memory.
  - `:6746` `self.commit(session_id, loaded.row_version, &loaded.core, &meta)` —
    a separate fenced transaction.
  - `:6750` `Err(error @ McStoreError::CasConflict { .. }) => last_conflict = Some(error)`
    continues the loop.
  - `:6751` `Err(error) => return Err(error)` exits on anything else.
  - `:6754-6756` on exhaustion returns `last_conflict` or
    `McStoreError::Serde("todo state update exceeded CAS retry limit")`.
- `lib.rs:6760-6778` `arm_soft_refresh`. Identical shape: `for _ in 0..8` at
  `:6762`, `load` at `:6763`, short-circuit at `:6764-6766` when
  `soft_refresh_pending` is already true, `commit` at `:6769`, the same two match
  arms at `:6771-6772`, and the same exhaustion form at `:6775-6777` with
  `"soft refresh arm exceeded CAS retry limit"`.

Why the split is intentional, from `lib.rs:6725-6726`:

  "Set the normalized todo snapshot with replay-safe owner/hash semantics. A
  cache row CAS makes a retry harmless even when a transform commits between the
  read and update."

What the CAS is, on the write side:

- `commit` (`lib.rs:7215-7223`) → `commit_with_consumed_drops` (`:7226-7257`) →
  `commit_transform` (`:7260-7609`).
- `lib.rs:7352` opens the fenced transaction.
- `:7353-7357` reads the current `row_version` *inside* it, with the comment
  "Read the current row_version inside the fenced txn; NO_ROW when absent" and
  `NO_ROW = -1` (`:404`).
- `:7358-7382` returns `CommitOutcome::CasConflict(current)` on mismatch, at three
  distinct decision points (`:7361`, `:7370`, `:7380`).
- `:7390-7397` performs the upsert only past those checks.
- `:7600-7608` maps `CommitOutcome::CasConflict(found)` to
  `Err(McStoreError::CasConflict { expected, found })`.

So the predicate is evaluated inside the write transaction and the loop outside
it. That is the correct division: the loop provides progress, the CAS provides
safety.

The crate-level statement of the same contract, `lib.rs:6-12`:

  "writes go through `cortexkit-store`'s epoch-fenced transaction (rejects a
  superseded lease handover) AND an app-level `row_version` CAS inside that same
  transaction. The epoch fence only rejects a STRICTLY-NEWER writer (lease
  handover) — an equal-epoch writer is NOT fenced — so the row_version CAS is
  what catches a same-epoch second writer."

Existing coverage:

- `lib.rs:14153`
  `boundary_divergence_counter_cas_loser_does_not_double_increment_and_survives_reopen`
  covers a losing CAS at a different site and asserts no double increment. That
  is the right oracle shape, applied elsewhere.
- No test drives `set_todo_state` or `arm_soft_refresh` through a losing attempt.
  Searching the three test modules (`lib.rs:13932-19420`, `:19422-19980`,
  `:19982-20650`) for those function names finds only success-path uses.

## Failure scenario

**Duplicate effect, which the short-circuits prevent.** Suppose
`set_todo_state` loses the CAS on attempt 1 after its `commit` has already
applied. That cannot happen: the CAS decision and the write are in one
transaction (`lib.rs:7358-7397`), so a conflict means nothing was written.
Suppose instead the caller retries the whole `set_todo_state` call after a
partial failure. Attempt 2's `load` observes the owner and hash already set and
returns `Noop` at `:6740`, so the effect is applied once. `arm_soft_refresh` is
idempotent for the same reason: setting an already-set boolean returns `true`
without writing (`:6765`).

So the property's "at most once" half is structurally sound. The interesting
failure is the other half.

**Starvation, which nothing prevents.** There is no backoff between attempts. The
loop is `load`, `commit`, repeat, as fast as the connection allows. A steady
competing writer that commits between each `load` and `commit` causes eight
consecutive `CasConflict`s deterministically. `set_todo_state` then returns
`last_conflict`, which is `McStoreError::CasConflict { .. }` — a classifiable
error, so a caller can retry. That path is acceptable.

**Misclassified exhaustion.** The `unwrap_or_else` at `:6754-6756` and
`:6775-6777` produces `McStoreError::Serde` with a prose message. `Serde` is the
serialization error variant. Reaching it requires the loop to run eight times
with `last_conflict` still `None`, which means every iteration took a path that
neither returned nor recorded a conflict. Reading the arms, the only ways out of
an iteration are: `return Ok(Noop)` (`:6740`), `return Ok(Updated)` (`:6748`),
`last_conflict = Some(..)` (`:6750`), and `return Err(..)` (`:6751`). Every
iteration therefore either returns or sets `last_conflict`, so the `Serde` branch
looks unreachable. That makes it a latent trap rather than a live defect: it is a
misclassification waiting for a future fifth arm that continues the loop without
recording a conflict.

## Timing windows and dependencies

- The window is between `load` at `lib.rs:6736` and `commit` at `:6746`. Its
  duration is one JSON deserialization of `CoreState` and `ModuleMeta` plus one
  fenced transaction acquisition, so it is short but non-zero.
- Within one process the window is not actually contended: `with_conn` and
  `with_conn_fenced` both take the same `Mutex<Connection>`
  (`cortexkit-store:159`, `:189`), so no other thread of this process can commit
  between them. Across processes the exclusive file lease
  (`cortexkit-store:279-282`) prevents a second live writer.
- So a losing CAS requires either an equal-epoch writer during a lease handover —
  the case the crate doc at `lib.rs:8-11` says the CAS exists for — or a writer
  that bypasses the lease entirely, as `lib.rs:16702` demonstrates is
  expressible.
- Depends on `row_version` being monotonic. `commit_transform` computes the next
  value and writes it in the same transaction as the CAS check, so monotonicity
  is transaction-protected.

## What a test must construct

The losing-attempt test needs a hook in the load-to-commit window:

1. Open a store, seed a session with cache state.
2. Install a hook that fires after `load` returns and before `commit` runs, and
   from that hook perform a competing commit that bumps `row_version`.
3. Call `set_todo_state` and assert the outcome is `Updated` with a `row_version`
   reflecting exactly one application of the todo state, not two.
4. Repeat with the hook firing on all eight attempts and assert the error is
   `McStoreError::CasConflict`, not `McStoreError::Serde`.

The hook does not exist. The two existing hooks of this shape are
`set_before_max_compartment_end_read_hook` (`lib.rs:5283`) and
`set_abandon_historian_hook` (`:5294`), both `#[cfg(any(test,
feature = "test-support"))]`, and neither fires in the `set_todo_state` path.
Adding one is a source change, which this lens does not make.

A cheaper test that needs no hook, covering the idempotence half only:

1. Call `set_todo_state` with the same `owner_message_id` and `state_hash` twice.
2. Assert the second returns `TodoStateSetOutcome::Noop` and that `row_version`
   did not change.

The oracle must be per-identity: assert the specific session's `row_version` and
`last_todo_state_hash`, since an aggregate write count could be satisfied by an
unrelated commit.

## Investigation log

### Q: Why is the retry bound 8, and why is there no backoff?

- Sources examined: `lib.rs:6735`, `:6762`; the doc comments at `:6725-6726` and
  `:6759`; the contrasting backoff logic that does exist for the historian side
  channel at `:9726-9730`, which computes
  `1_000 * (1 << attempt_count.min(6))` capped at
  `HISTORIAN_SIDE_CHANNEL_MAX_BACKOFF_MS = 60_000` (`:3714`).
- Findings: the codebase clearly knows how to write bounded exponential backoff
  and chose not to here. No comment explains 8. Given the mutex and lease
  analysis above, contention on this path should be near-zero in a
  single-writer deployment, which is a plausible unstated rationale.
- Missing evidence: no design note.
- Conclusion: needs human input. Recorded on the catalog record as an open
  question rather than inferred.

### Q: Is the `McStoreError::Serde` exhaustion branch actually reachable?

- Sources examined: every exit from the loop body at `lib.rs:6736-6752` and
  `:6763-6773`.
- Findings: each iteration either returns or assigns `last_conflict`, so after
  any completed iteration `last_conflict` is `Some`. The `unwrap_or_else` at
  `:6754` and `:6775` therefore appears dead. The only way to reach it is a zero
  -iteration loop, which `0..8` cannot produce.
- Missing evidence: none; the control flow is fully local.
- Conclusion: resolved with answer — currently unreachable, so it is a latent
  misclassification rather than an active defect. Worth flagging because the
  variant choice (`Serde` for a contention outcome) would be wrong the moment a
  new continue-arm is added.
