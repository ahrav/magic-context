# write-predicates-are-re-evaluated-inside-the-write-transaction

## Discovery trigger

Task 2 asked specifically for read-modify-write sequences that are not inside one
transaction, and task 5 asked whether any invariant spanning two statements is
atomic. Auditing all 113 connection acquisitions in production `lib.rs` produced a
mostly-positive answer, which is worth recording as an invariant so a future
regression is caught rather than discovered.

## Evidence trail

The audit method: scan every production `fn` in
`crates/mc-store/src/lib.rs` (lines 1-13930) whose body contains two or more
`with_conn(`, `with_conn_fenced(`, or `with_note_conn_fenced(` calls. Production
totals are 73 `with_conn` and 40 fenced. Exactly three functions have two or more:

1. `lib.rs:4816-4906` `McStore::open` — two `with_conn`. Neither is a durable
   write: `:4825-4872` registers four scalar UDFs, `:4878-4881` sizes the
   prepared-statement cache. Not a read-modify-write.
2. `lib.rs:5069-5117` `repair_note_artifacts_v51` — three `with_conn` plus a
   fenced loop. A genuine split read-modify-write, analysed separately in
   [post-migration-open-repair-is-resumable-and-effect-idempotent](post-migration-open-repair-is-resumable-and-effect-idempotent.md).
3. `lib.rs:9662-9719` `deliver_historian_side_channel` — three
   `with_conn_fenced`. **Mutually exclusive match arms**, one per side-channel
   kind: `:9684` for `"event"`, `:9697` for `"primer"`, `:9706` for
   `"user_observation"`. Exactly one executes per call, and each does its domain
   insert and `mark_historian_side_channel_delivered_tx` in the *same*
   transaction (`:9685-9690`, `:9698-9699`, `:9707-9708`). This is a correct
   transactional-outbox commit, not a split.

The exemplary cases, where a predicate could have been read outside and was not:

- `lib.rs:7145-7205` `commit_state_import`. Its fenced transaction opens at
  `:7152`. Inside it: the completed-import lookup at `:7153-7159`, the duplicate
  and not-empty decisions at `:7160-7165`, `session_has_durable_state(tx,
  session_id)` at `:7170`, `validate_state_import_compartments` at `:7173`, the
  N compartment inserts at `:7177-7179`, and the `mc_state_imports` insert at
  `:7180-7190`. The comment at `:7167-7169` states the reasoning: "This is the
  fresh-row form of the cache-state CAS. The predicate and all compartment writes
  share one fenced transaction, so a racing bootstrap cannot slip state between
  the emptiness check and the imported rows."
- `lib.rs:7114-7139` `preflight_state_import` reads the *same two* predicates in
  its own read transaction (`:7119-7128`) and returns an advisory verdict
  (`:7130-7138`). Because `commit_state_import` re-evaluates both, the preflight
  is a fast path, not a decision point. This is the pattern done right: an
  outside read that is explicitly not load-bearing.
- `lib.rs:7260-7609` `commit_transform`. Fenced transaction at `:7352`,
  `row_version` read inside it at `:7354-7357` with the comment "Read the current
  row_version inside the fenced txn", conflict decisions at `:7358-7382`, upsert
  at `:7390-7397`, and every overlay write through `:7586` in the same
  transaction.
- `lib.rs:5432-5475` `delete_session`. Table discovery from `sqlite_master`
  (`:5439-5446`) and `PRAGMA table_info` per table (`:5453`) both happen inside
  the single `with_note_conn_fenced` opened at `:5437`, so even the *schema*
  predicate that drives the loop is transaction-scoped.

The deliberate exceptions, both compensated:

- `lib.rs:6727-6757` `set_todo_state` and `:6760-6778` `arm_soft_refresh` split
  `load` from `commit` and rely on the `row_version` CAS. Covered in
  [bounded-cas-retry-never-duplicates-an-effect](bounded-cas-retry-never-duplicates-an-effect.md).
  The comment at `:6725-6726` states the compensation.

The one genuinely uncompensated split, on the open path:

- `lib.rs:4873` `refuse_pre_cutover_store(&inner)?` reads the recorded version in
  its own transaction via `recorded_mc_cache_version` (`:1346-1366`, using
  `inner.with_conn` at `:1347`).
- `lib.rs:4874` `inner.migrate(NS, MIGRATIONS)?` then re-reads the same value in
  the runner, also outside any transaction
  (`cortexkit-store/src/lib.rs:351-357`).
- So the family classification and the migration decision are two separate reads
  of the same fact, with a write between them possible in principle.

## Failure scenario

For the compensated and in-transaction cases there is no failure; the record
exists so a regression is detectable.

For the open-path split at `lib.rs:4873-4874`: a writer that changes the recorded
version between the refusal check and the runner's read would cause the store to
be migrated after passing a check that no longer describes it. Concretely, if the
refusal check reads `None` (fresh) and a competing writer then inserts
`("mc_cache", 56)`, the runner reads `current = 56`, sees `57 > 56`, and applies
the consolidated bootstrap over whatever schema version 56 left. The bootstrap's
first statement, `CREATE TABLE mc_cache_state` (`lib.rs:435`), then fails with the
raw DDL-collision error that `lib.rs:1371-1372` says the refusal exists to avoid.

This requires a writer outside the exclusive lease, since `open_sqlite` acquires
it at `cortexkit-store:279-282` before either read. So the window is real but the
enabling state is a lease violation.

The more general risk the record guards against: any future function that reads a
gating predicate in one `with_conn` and writes in a later `with_conn_fenced`
inherits the same unsoundness, and the codebase currently has almost none of
those, so the pattern is easy to keep clean and easy to break silently.

## Timing windows and dependencies

- The `commit_state_import` / `preflight_state_import` window is between the two
  calls and is explicitly harmless.
- The `set_todo_state` / `arm_soft_refresh` window is between `load` and
  `commit`, guarded by the CAS.
- The `lib.rs:4873-4874` window is between two version reads on the open path.
- All three are closed within one process by the shared `Mutex<Connection>`
  (`cortexkit-store:159`, `:189`), and across processes by the exclusive file
  lease (`:279-282`). The lease is therefore load-bearing for a property that
  should not depend on it: an in-transaction predicate would hold regardless.

## What a test must construct

The property is best checked as a structural invariant plus one behavioural test.

Structural, and cheap enough to run in CI: for each production function that
acquires the connection more than once, assert it is on an allowlist of three,
with a stated reason for each. That turns a silent regression into a build
failure. This is a lint rather than a test, and it needs the three current
entries documented, which this evidence file provides.

Behavioural, for the open-path split:

1. Create a store, then close it.
2. Open a raw `rusqlite::Connection` outside the lease — the pattern at
   `lib.rs:16702` — and seed `cortexkit_schema_version` with `("mc_cache", 56)`.
3. `McStore::open` and assert the error is
   `McStoreError::PreCutoverModuleStore { recorded_version: 56, bootstrap_version:
   57 }`, not a raw DDL collision.

That test passes today for the steady state, because both reads see 56. To
exercise the window itself the seed must land *between* the two reads, which
needs a hook that does not exist between `lib.rs:4873` and `:4874`.

For `commit_state_import`, the racing-bootstrap test the comment at `:7167-7169`
describes:

1. Begin a `commit_state_import` for a fresh session.
2. From an out-of-lease connection, insert cache state for the same session
   between the preflight and the commit.
3. Assert `commit_state_import` returns `StateImportError::SessionNotEmpty` rather
   than importing on top.

Step 3 should pass, because `:7170` re-checks. That is the test that proves the
compensation rather than assuming it.

## Investigation log

### Q: Do any of the 40 fenced closures return `Ok(rejection)` *after* performing a write, which would commit a partial decision?

- Sources examined: the internal outcome enums at `lib.rs:3654-3768`; the
  rejection returns in `commit_state_import` at `:7161-7165` and `:7170-7172`,
  both before the inserts at `:7177`; the conflict returns in `commit_transform`
  at `:7361`, `:7370`, `:7380`, all before the upsert at `:7390`;
  `AbandonHistorianTxnOutcome` (`:3741`), `TruncateTxnOutcome` (`:3747`),
  `LineageDescentTxnOutcome` (`:3754`), `ModuleStateSyncTxnOutcome` (`:4328`).
- Findings: in every case I read, the rejecting return precedes all writes in that
  closure, which is the correct ordering. The pattern is consistent enough to
  look intentional.
- Missing evidence: I did not read all 40 closures. The larger ones —
  `apply_state_sync` (`:7617-7934`), `descend_lineage` (`:8177-8854`),
  `publish_historian_chunk` (`:9351-9550`) — each contain multiple outcome
  variants and were not audited statement by statement.
- Conclusion: unresolved, needs a targeted audit of those three. This is the same
  open question recorded on
  [failed-fenced-transaction-leaves-no-partial-state](failed-fenced-transaction-leaves-no-partial-state.md),
  and it is the cheapest remaining high-value follow-up in this lens.

### Q: Are the three `unchecked_transaction` read snapshots consistent, or can they observe a torn state?

- Sources examined: `lib.rs:5526-5657` `load_transform_snapshot_with_hook`
  (transaction at `:5532`), `:5658-5786` `load_session_status_snapshot`
  (transaction at `:5664`), `:8855-8886` `load_m1_revision_snapshot`
  (transaction at `:8862`). Each issues several `query_row` calls against the
  same handle, for example `:8863-8872` reading `MAX(sequence)` from
  `mc_compartments` and then `MAX(status_version)` from `mc_notes`.
- Findings: consistent. `unchecked_transaction` is DEFERRED, so in WAL mode the
  read snapshot is pinned from the first read and every subsequent read in that
  handle sees the same snapshot. None of the three commits, so each drops to
  rollback, which is correct for a read.
- Missing evidence: none for consistency. The cost — a pinned WAL for the
  snapshot's duration, unbounded for
  `load_transform_snapshot_with_hook` because its `after_state_read` callback
  (`:5529`) runs while the snapshot is open — is noted in the lens's durability
  contract section rather than here.
- Conclusion: resolved with answer — multi-statement reads are snapshot-consistent
  by construction, so the two-statement atomicity question is satisfied on the
  read side as well as the write side.
