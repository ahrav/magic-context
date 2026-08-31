# failed-fenced-transaction-leaves-no-partial-state

## Discovery trigger

Task 2 asked what happens to a partially applied change on error. Tracing the
error path through `with_conn_fenced` showed the mechanism is sound, and then
showed that no test in `mc-store` injects a failure *between* statements of a
multi-statement writer, which is the only place the property has content.

## Evidence trail

The mechanism, in the dependency:

- `cortexkit-store/src/lib.rs:185-233` `with_conn_fenced`.
- `:189` takes the store mutex.
- `:190-192` `guard.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)`.
  `IMMEDIATE`, so the write lock is held from `BEGIN`.
- `:194-199` lazily creates `cortexkit_fence`.
- `:203-209` reads the stored fence epoch.
- `:211-218` returns `Err(StoreError::Fenced { .. })` when a newer writer owns
  the database. The comment at `:212-213` says "The transaction rolls back on
  drop."
- `:229` `let out = f(&tx).map_err(|e| StoreError::Backend(e.to_string()))?;`
  The `?` returns before `commit`.
- `:230-231` `tx.commit()`.

So there are exactly two early-return paths, both before `commit`, and rusqlite's
`Transaction` defaults to `DropBehavior::Rollback`. The mechanism is correct by
construction.

The closures where the property has content, that is where more than one
statement is written inside one transaction:

- `crates/mc-store/src/lib.rs:7352-7599` `commit_transform`. Inside one
  transaction: the `row_version` read (`:7354-7357`), the `mc_cache_state`
  upsert (`:7390-7397`), a `mc_pass_trace` insert (`:7402`), a
  `mc_transform_session_roots` insert (`:7473`), a `mc_tags` insert (`:7501`),
  `mc_temporal_marks` (`:7528`), `mc_user_hints` (`:7546`),
  `mc_channel1_appends` (`:7560`), and `mc_overlay_frontiers` (`:7573`). Nine
  write shapes, one transaction.
- `lib.rs:5432-5475` `delete_session`. Discovers every table from
  `sqlite_master` (`:5439-5446`), then loops issuing one `DELETE` per table that
  has a `session_id` column (`:5448-5472`), all inside the single
  `with_note_conn_fenced` at `:5437`.
- `lib.rs:7152-7191` `commit_state_import`. N `insert_compartment_tx` calls
  (`:7177-7179`) then the `mc_state_imports` insert (`:7180-7190`).
- `lib.rs:12609` `append_compartments_tx` and `lib.rs:12671`
  `insert_chunk_transcripts_tx`, both loop-per-row helpers called from within a
  caller's transaction.

The existing coverage:

- `cortexkit-store:691-712` `fenced_write_rolls_back_on_error`. The comment at
  `:697` says "Force the closure to fail AFTER a write: the transaction must
  roll back." This is the right test, but it is the dependency's own test on a
  two-statement toy closure.
- In `mc-store` the only failure-injection hook of this shape is
  `historian_side_channel_fail_once` (`lib.rs:9667-9678`, set via
  `fail_next_historian_side_channel_for_test` at `:5249`). It returns `Err`
  at the top of `deliver_historian_side_channel`, before `with_conn_fenced` is
  even entered (`:9684` is the first transaction). So it tests the retry and
  backoff bookkeeping at `:9720-9760`, not mid-transaction rollback.

## Failure scenario

Take `commit_transform`. Suppose an overlay insert at `lib.rs:7546`
(`mc_user_hints`) fails on a constraint while the `mc_cache_state` upsert at
`:7390` has already run. Without rollback, the durable state would be: cache row
at `row_version = n+1`, overlay tables reflecting a *partial* subset of the
overlays that `n+1` is supposed to include.

That is worse than losing the whole commit, because the CAS is now satisfied.
The next caller loads `row_version = n+1` (`lib.rs:5481` `load`), sees a state it
believes is complete, and commits `n+2` on top. The missing overlays are never
reconstructed, because nothing re-derives them from the cache row; the crate doc
comment at `lib.rs:6-12` says the write is "conditional: a pass writes ONLY when
durable state actually changed", so a subsequent pass that computes no change
writes nothing and never repairs the gap.

`delete_session` has the mirror problem: a partial delete leaves a session's rows
in some tables and not others, and the deletion is driven by dynamic table
discovery, so there is no static list a repair could replay against.

## Timing windows and dependencies

- The window is between the first and the last write statement inside one
  closure. For `commit_transform` that spans `lib.rs:7390` to `:7586`; for
  `delete_session` it spans the loop body at `:5448-5472`, whose length is the
  number of discovered tables.
- No concurrency is required. A constraint violation, a serialization error from
  `serde_json`, or an injected fault is enough. This is the cheap kind of
  property: it needs a fault, not an interleaving.
- Depends on rusqlite's `Transaction` drop behaviour remaining `Rollback`. That
  is the library default and is not overridden anywhere; a content search for
  `set_drop_behavior` and `DropBehavior` across `crates/` and
  `cortexkit-store/src/lib.rs` finds no occurrences.

## What a test must construct

The shape is: inject a failure at statement k of an n-statement closure, for
`1 < k < n`, then assert every touched table is unchanged.

Concretely for `commit_transform`, the cheapest injection point is a value that
passes the caller's validation but violates a table constraint late in the
sequence. The migration SQL is dense with `CHECK` constraints, for example
`lib.rs:1301-1304` on `mc_claim_mirror_receipts`
(`expected_effect_count > 0`, `first_effect_id > 0`, `length(group_digest) = 64`),
so a crafted overlay value is a plausible lever without adding a test hook.

For `delete_session` the lever is different: the loop discovers tables from
`sqlite_master`, so a table added by an out-of-band writer with a `session_id`
column and a constraint that blocks deletion would fail mid-loop. That is a
realistic construction because `delete_session` deliberately does not use a
static table list.

The oracle must be per-table and per-identity, not a row count: snapshot every
touched table's contents for the target `session_id` before the call, and compare
after. An aggregate count can be satisfied by a rollback that also rolled back an
unrelated concurrent effect.

## Investigation log

### Q: Are there any nested transactions or savepoints that could complicate rollback?

- Sources examined: content search for `savepoint`, `SAVEPOINT`,
  `unchecked_transaction`, and `TransactionBehavior` across
  `crates/mc-store/src/lib.rs` and `cortexkit-store/src/lib.rs`.
- Findings: no savepoints anywhere. `TransactionBehavior` appears once, at
  `cortexkit-store:191`. `unchecked_transaction` appears three times
  (`lib.rs:5532`, `:5664`, `:8862`), all inside `with_conn` on read paths, none
  nested inside a fenced write.
- Missing evidence: none.
- Conclusion: resolved with answer — rollback is a single flat level, so there is
  no partial-rollback semantics to reason about.

### Q: Can a closure return `Ok` while having failed a statement, bypassing rollback?

- Sources examined: the internal outcome enums at `lib.rs:3654-3768`
  (`CommitOutcome`, `PublishTxnOutcome`, `StateImportTxnOutcome`,
  `TruncateTxnOutcome`, `LineageDescentTxnOutcome`,
  `ModuleStateSyncTxnOutcome`), and their use, for example
  `commit_state_import` returning `Ok(StateImportTxnOutcome::SessionNotEmpty)`
  at `lib.rs:7164` and `:7171`.
- Findings: yes, and deliberately. The codebase distinguishes "this transaction
  should commit but the domain outcome is a rejection" from "this transaction
  must roll back", by returning `Ok(SomeRejection)` for the former. In every case
  I read, the rejecting return happens *before* any write in that closure:
  `:7164` and `:7171` precede the compartment inserts at `:7177`.
- Missing evidence: I did not audit all 40 fenced call sites for a rejection
  return that occurs after a write.
- Conclusion: unresolved, needs an audit of the remaining fenced closures. This
  is the one way the property could be violated without a fault, so it is worth
  a dedicated pass.
