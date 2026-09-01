# note-b-pending-candidate-set-is-unbounded-and-fully-materialized-per-poll

## Discovery trigger

My brief named unbounded caller-driven growth and missing reapers as recurring
findings and asked me to check both explicitly for notes. The check has two
halves: is the note *count* bounded, and is anything evicting notes. Both answers
are no, and the per-poll cost is linear in the unbounded quantity.

## Evidence trail

1. No count cap on either writer. `insert_note`
   (`crates/mc-store/src/lib.rs:10130-10164`) validates project vocabulary
   (`:10131-10137`) and non-empty content (`:10139-10143`), then inserts.
   `insert_project_note` (`:10166-10200`) does the same and picks the status
   (`:10183-10189`). Neither runs a `COUNT(*)`, and neither consults a limit
   constant. The only `COUNT(*)` over `mc_notes` in the file is the read path's
   pagination total (`:10349`).

2. No reaper. A search for a note deletion found exactly two: the
   `DELETE FROM mc_notes WHERE context_store_uuid = ?1 AND project_path = ?2` at
   `:11393`, which is a store-scoped teardown owned by Parts 3 and 4c, and the
   `deleted.saturating_add(if table == "mc_notes" ...)` accounting at `:5460`.
   Neither is age- or volume-driven. Compare the note-evaluation *ledgers*, which
   do have a reaper: `collect_note_eval_ledgers_tx` (`:13119-13157`) deletes
   acquisition rows past `NOTE_EVAL_NO_WORK_RETENTION_MS` (`:13146-13150`) and
   terminal claim rows past `NOTE_EVAL_TERMINAL_RETENTION_MS`
   (`:13151-13156`), with an explicit comment on why blanking columns is not
   enough (`:13143-13147`). So the codebase has the reaper pattern and applied it
   to the ledgers and not to the notes.

3. The candidate query has no `LIMIT`:

   ```
   SELECT {NOTE_EVAL_CANDIDATE_COLUMNS} FROM mc_notes
     WHERE project_path = ?1 AND type = 'smart' AND status = 'pending'
       AND id NOT IN (SELECT note_id FROM mc_note_eval_claims
                       WHERE project = ?1 AND terminal_kind IS NULL)
     ORDER BY id
   ```
   (`:13292-13297`), collected into a `Vec` at `:13298-13301`.

4. Every candidate is converted per poll. `lib.rs:11203-11207`:

   ```
   let snapshots: Vec<SmartNoteSelectionSnapshot> = candidates
       .iter()
       .map(smart_note_selection_snapshot)
       .collect();
   ```

   and `smart_note_selection_snapshot` (`lib.rs:13963-13985`) clones three
   `String`s per note: `status` (`:13966`), `compile_status` (`:13967`), and
   `check_status` (`:13970-13976`).

5. Selection then walks the whole vector up to four times, once per phase, because
   each phase filters and sorts the full slice
   (`crates/mc-module/src/smart_note_evaluation.rs:717-727`, `:741-751`,
   `:767-779`, `:793-796`) and `select_smart_note_evaluation_cycle` calls them in
   a loop (`:916-937`). The fallback branch passes `notes.len()` as the limit
   (`:933`), so it sorts and collects the entire fallback subset rather than
   taking one.

6. The per-poll cost was considered and partially optimized, which sharpens rather
   than softens the finding. `SmartNoteSelectionSnapshot::has_compiled_check`
   carries this doc comment: "Only artifact PRESENCE affects selection, so the
   snapshot avoids copying the artifact body for every pending note on every
   acquisition poll" (`:690-692`). That sentence states the loop it is optimizing:
   every pending note, every poll.

7. Growth is caller-driven and reachable from the model-facing facade. A
   `ctx_note` write with a non-empty `surface_condition` lands as
   `type = 'smart', status = 'pending'` (`mc-store:10183-10189`), and content is
   capped per note at `MAX_NOTE_CONTENT_BYTES`, 64 KiB (`lib.rs:14395`, enforced
   at `:11556`). So each note is bounded and the count is not.

8. The one gate on conditioned writes is a liveness gate, not a volume gate:
   `if condition.is_some() && !self.has_live_note_evaluator(project, now)`
   (`lib.rs:11618`). Once an evaluator is live, which is the normal state, that
   gate admits every write.

9. Nothing drains `pending` except evaluation reaching a `met` outcome, which
   sets `status = "ready"` (`smart_note_evaluation.rs:421`), or a user dismissal.
   A note whose condition never fires stays `pending` forever and stays in the
   candidate set forever. `check_status = "fallback"` notes in particular never
   leave `pending` on a `False` outcome (`:647-656`).

## Failure scenario

An agent working through a long task parks follow-ups as conditioned notes. This
is the documented intended use: `docs/AUDIT-KNOWN-ISSUES.md:903-916` (A54)
describes exactly this pattern, "did we park a follow-up about X?", and accepts
by design that pending smart notes are searchable, so parking many of them is
expected behaviour rather than abuse.

Over months, a project accumulates several thousand pending smart notes whose
conditions have not fired. Nothing removes them: no age reaper, no volume cap,
and no eviction. The evaluator polls `note.evaluation.next` on its drain
schedule.

Each poll:

1. Reads every pending row's candidate projection from SQLite.
2. Allocates one `SmartNoteSelectionSnapshot` per row, with three `String`
   allocations each.
3. Filters and sorts the full slice up to four times.
4. Returns one note id, or none.

The poll's cost is linear in the accumulated set with no ceiling, and the
accumulated set only grows. The transaction is held for the whole thing, inside
`with_note_conn_fenced` (`mc-store:13209`), so it also holds the note
connection's write lock for a duration that grows with history.

There is no fault and no interleaving; this is the steady state of correct use.

## Timing windows and dependencies

No window. The dependency is elapsed use: writes accumulate monotonically and
polls recur on the drain schedule. The two independent growth axes are the note
count (unbounded) and the poll rate (client-controlled, see
`note-b-fallback-phase-writes-no-durable-backoff`), and the cost is their
product.

## What a test must construct

1. Open a store, register an evaluator, and insert N pending smart notes with
   conditions, for N in something like `{10, 100, 1000}`.
2. Call `note.evaluation.next` once per N.
3. Assert the number of rows the candidate query returned is bounded by a declared
   constant. The observable is the candidate slice length inside the selection
   closure, which the test can capture because the closure is supplied by the
   caller (`lib.rs:11201-11231`), so a test-only closure can record
   `candidates.len()` without touching production code.

That is the structural oracle and it fires immediately: there is no constant to
compare against.

The cost oracle is weaker and worth stating so nobody writes it by mistake: timing
the poll across N and asserting sublinearity would be a performance test on a
shared runner, which the repository's own benchmarking discipline would reject.
The structural assertion is the right one, because the property is "bounded by a
declared constant", not "fast".

A useful companion assertion for the eviction half: insert N notes, advance the
clock by an arbitrarily long interval, run whatever maintenance the store exposes,
and assert the pending count is unchanged. That documents the absence of a reaper
as a deliberate observation rather than an oversight in the test.

## Investigation log

### Q: Is there a cap or reaper elsewhere, outside these two crates?

- Sources examined: every `insert` into `mc_notes` in `mc-store/src/lib.rs`
  (`:10130-10164`, `:10166-10200`, and the transaction-scoped variants at
  `:4393-4459`), every `DELETE FROM mc_notes` (`:8675`, `:11393`), the
  `mc_notes` triggers (`:774`, `:857`, `:1041`, `:1142`), a grep for
  `MAX_NOTE`/`max_notes`/`notes_max` across `mc-store` and `mc-module` returning
  only `MAX_NOTE_CONTENT_BYTES`, and the ledger reaper for contrast
  (`:13119-13157`).
- Findings: no cap and no reaper in either crate. The triggers are ownership,
  authority, writer-fence, and feed maintenance, not volume control. The
  `DELETE` at `:8675` is inside a different subsystem's cleanup and is keyed on
  something other than note age or count.
- Missing evidence: the plugin's dreamer maintenance tasks. The task registry
  (`packages/plugin/src/features/magic-context/dreamer/task-registry.ts:22`) lists
  `evaluate-smart-notes`, and there is a
  `retrospective-orphan-sweep.ts` that also references it (`:35`). An orphan sweep
  is the shape that would reap notes, and I did not read it. If it reaps only
  orphans (notes whose anchor block is gone) rather than aged notes, it would not
  bound this.
- Conclusion: unresolved, needs a sweep of the plugin's dreamer maintenance tasks,
  starting with `retrospective-orphan-sweep.ts`. Note that a plugin-side reaper
  would bound the durable set but would not bound the Rust module's per-poll
  materialization, which is the half this record asserts; a `LIMIT` on the
  candidate query is a separate question from whether notes are reaped.

### Q: Would a `LIMIT` on the candidate query even be correct?

- Sources examined: the four selectors' order keys
  (`smart_note_evaluation.rs:728`, `:752`, `:780`, `:797-803`) and the candidate
  query's `ORDER BY id` (`mc-store:13296`).
- Findings: not naively. The query orders by `id` and each phase orders by a
  different column, so `LIMIT 200 ORDER BY id` would silently exclude the note
  with the earliest `check_next_due_at` if its id happened to be high. A correct
  bound needs either per-phase SQL with the phase's own `ORDER BY` and `LIMIT`,
  which moves the predicates out of the pure selectors and into SQL and so
  breaks the cross-language fixture's coverage, or a volume cap at write time,
  which is a policy decision.
- Missing evidence: none needed for this observation.
- Conclusion: resolved with answer. The naive fix is wrong, which is useful
  context for whoever dispositions this: the finding is real and the remedy is a
  design choice, not a one-line `LIMIT`.
