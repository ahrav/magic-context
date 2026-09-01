# post-migration-open-repair-is-resumable-and-effect-idempotent

## Discovery trigger

Scanning every production function for bodies that acquire the connection more
than once returned three hits. Two were benign. The third,
`repair_note_artifacts_v51`, is a genuine read-modify-write spread across four
transactions on the open path, and it runs after the migration that is supposed
to have completed the schema change it repairs.

## Evidence trail

Where it runs:

- `crates/mc-store/src/lib.rs:4902` `store.repair_note_artifacts_v51()?`, the
  sixth of seven steps in `McStore::open` (`:4816-4905`), after
  `inner.migrate(NS, MIGRATIONS)` at `:4874`.

Why it exists, from its own doc comment at `lib.rs:5063-5068`:

  "Complete route normalization after schema upgrades using the same
  caller-identity check as runtime note writes. Because the SQL migration cannot
  safely rekey several note owners under one caller identity, replay this
  idempotent repair on every store open, including stores that already recorded
  the upgraded schema version. Verify pre-v51 compiled artifacts once, then
  record completion in mc_cache_state. This repair does not advance any note
  revision."

That comment states three claims worth testing: idempotent, replayed on every
open, and does not advance a note revision.

The four transactions, `lib.rs:5069-5114`:

1. `:5071-5077` reads the completion flag:
   `SELECT EXISTS(SELECT 1 FROM mc_cache_state WHERE session_id = ?1)` with
   `FLAG_KEY = "note_artifact_repair_v51_done"` (`:5070`). Early return at
   `:5078-5080` when set.
2. `:5081-5091` reads the work list:
   `SELECT DISTINCT project_path FROM mc_notes WHERE compiled_check IS NOT NULL
   AND compiled_source_revision IS NULL ORDER BY project_path`.
3. `:5092-5104` per project, a loop of fenced batches:
   `self.with_note_conn_fenced(&project, |tx| repair_note_artifacts_tx(tx, &project))`
   at `:5099`, breaking when the returned count is below
   `NOTE_ARTIFACT_REPAIR_BATCH` (`:5100-5102`), which is `500` at `lib.rs:2948`.
4. `:5105-5112` writes the flag:
   `INSERT OR IGNORE INTO mc_cache_state (session_id, row_version, core_state,
   meta) VALUES (?1, 0, '', '')`.

The batching rationale is stated at `:5093-5096`: "Commit in bounded batches so a
kill mid-repair keeps the work already done instead of rolling back a whole
project and redoing it on every subsequent boot. The query re-selects unrepaired
rows each pass, so this is naturally resumable."

The repair body is `repair_note_artifacts_tx` at `lib.rs:13782`.

The completion flag's storage is notable: it is a sentinel row in
`mc_cache_state`, the same table that holds real per-session cache state
(`lib.rs:435-441` declares it with `session_id TEXT PRIMARY KEY, row_version,
core_state, meta, last_activity_at`). The sentinel uses `row_version = 0` and
empty strings for `core_state` and `meta`.

## Failure scenario

The design is resumable by re-selection rather than by transaction, so the
failure modes are about the re-selection predicate, not about atomicity.

**If the predicate is not narrowing.** The driving query at `lib.rs:5084` selects
projects where `compiled_check IS NOT NULL AND compiled_source_revision IS NULL`.
The inner loop at `:5097-5103` repeats until a batch returns fewer than 500 rows.
If `repair_note_artifacts_tx` can leave a row still matching that predicate — for
example a row it decides to skip rather than repair — the inner loop never
converges and `McStore::open` hangs, on every open, forever. `lib.rs:18905`
`v51_repair_keeps_a_legacy_artifact_that_has_no_recorded_digest` shows there *is*
a keep-rather-than-repair branch, which makes this the load-bearing question. It
is the open question below.

**If the flag is lost.** The flag lives in `mc_cache_state` keyed by
`session_id`. `delete_session` (`lib.rs:5432-5475`) discovers every table with a
`session_id` column from `sqlite_master` (`:5439-5446`) and deletes rows matching
the supplied `session_id` (`:5464-5470`). If any caller can reach
`delete_session` with `"note_artifact_repair_v51_done"`, the flag is cleared and
the repair replays. Replay is claimed to be harmless, so the consequence is cost
rather than corruption — unless the predicate problem above also holds.

**Between the last batch and the flag.** A kill in the window
`:5104` to `:5112` loses only the flag. On restart the selection at `:5083-5085`
finds nothing, the loops do not execute, and the flag is written. This window is
benign, and it is the reason the record's check semantics can be
`always-or-unreached` rather than requiring a transaction.

## Timing windows and dependencies

- Window A: between any batch commit at `:5099` and the next iteration.
  Protection is the re-selecting predicate, not a transaction.
- Window B: between the last batch and the flag insert at `:5105-5112`.
  Protection is that the flag is not required for correctness, only for skipping
  future work.
- Window C: between the migration commit (`cortexkit-store:381`) and the repair
  starting (`lib.rs:4902`). A kill here leaves the schema at version 57 with the
  data repair incomplete, and nothing records that. The version row cannot
  express it, which is why the separate flag exists.
- Depends on `repair_note_artifacts_tx` being idempotent and revision-preserving.
  The doc comment asserts both.

## What a test must construct

The resumability test:

1. Seed more than 500 rows matching `compiled_check IS NOT NULL AND
   compiled_source_revision IS NULL`, across at least two distinct
   `project_path` values so the outer loop iterates too.
2. Open the store in a child process, `SIGKILL` after the first batch commits at
   `:5099` but before the flag insert.
3. Reopen and assert two things: the rows repaired in the first batch are
   unchanged (not re-repaired), and every remaining row is repaired.
4. Assert no note revision advanced, per the comment at `lib.rs:5068`.

Step 3's first half is the real oracle and must be per-row: capture the repaired
rows' full contents after the kill and compare them after the reopen. A count is
not enough, because a re-repair that is a no-op and a re-repair that rewrites the
same values are indistinguishable by count but distinguishable by an `updated_at`
or revision column.

The convergence test, which is cheaper and higher value:

1. Seed a row that `repair_note_artifacts_tx` takes the keep-rather-than-repair
   branch on, per `lib.rs:18905`.
2. `McStore::open` with a bounded timeout.
3. Assert it returns.

If the keep branch leaves the predicate satisfied, this hangs, and it hangs on
every open, which is the worst available outcome for a store that cannot be
opened to be fixed.

## Investigation log

### Q: Can `repair_note_artifacts_tx` leave a row still matching the driving predicate, making the inner loop non-convergent?

- Sources examined: the loop at `lib.rs:5097-5103`, the batch constant at
  `:2948`, the function signature at `:13782`, and the test names
  `lib.rs:18124` `note_artifact_repair_verifies_digest_or_clears_compiled_state`
  and `lib.rs:18905`
  `v51_repair_keeps_a_legacy_artifact_that_has_no_recorded_digest`.
- Findings: the first test name says the outcomes are "verifies digest" or
  "clears compiled state". Clearing `compiled_check` would falsify
  `compiled_check IS NOT NULL` and remove the row from the predicate; setting
  `compiled_source_revision` would falsify the second conjunct. Either exit
  narrows. The second test name says a legacy artifact with no recorded digest is
  *kept*, which is the case that might not narrow.
- Missing evidence: I did not read `repair_note_artifacts_tx`'s body
  (`lib.rs:13782` onward). The loop's `break` condition is
  `processed < NOTE_ARTIFACT_REPAIR_BATCH`, where `processed` is the function's
  return value, so convergence depends on whether "kept" rows are counted in
  `processed` and whether they still match the selection.
- Conclusion: unresolved, needs a read of `repair_note_artifacts_tx`. This is the
  single highest-value follow-up from this record, because the failure mode is an
  unopenable store rather than a data defect.

### Q: Can any caller pass the sentinel key to `delete_session` and clear the flag?

- Sources examined: `lib.rs:5432-5475` `delete_session`, which takes
  `session_id: &str` and `project_path: &str`; `lib.rs:5070` for the sentinel
  value.
- Findings: `delete_session`'s `session_id` is caller-supplied with no format
  validation in the function. The sentinel is a plain string with no prefix or
  character class that a real session id could not have.
- Missing evidence: the callers of `delete_session` are outside `mc-store` and
  outside this lens's scope, so I cannot say whether a session id is ever
  attacker- or client-controlled at that boundary.
- Conclusion: unresolved, needs a caller audit. Recorded as an open question on
  the catalog record rather than assumed safe.
