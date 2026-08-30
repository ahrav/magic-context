# cli-a-migration-sweep-acts-only-on-what-its-phase-proves

## Discovery trigger

Building the destructive command table required a row for `doctor migrate`, and
reading `migrate.ts` for its confirmation model surfaced something the table did
not expect: the sweep that runs before every migration performs the sub-part's
only **physically** irreversible deletion, and it also runs on every plain
`doctor` invocation. That makes its correctness the highest-consequence
reconciliation logic in 5d.

## Evidence trail

**The four arms.** `sweepPendingMigrations`
(`packages/cli/src/commands/migrate.ts:329-381`), documented at `:309-327`:

| Condition | Action | Lines |
| --- | --- | --- |
| final file present | delete the row (crash between rename and row deletion) | `:350-356` |
| `phase='db_committed'` and stage present | `mkdirSync`, rename stage → final, delete the row | `:358-365` |
| `phase='db_committed'` and stage absent | push to `report.lost`, **keep the row** | `:366-370` |
| `phase='staged'` | `unlinkSync(stage_path)` best-effort, delete the row | `:373-380` |

`:339` returns an empty report when the journal table is absent. `:341-347`
selects every row ordered by `created_at`. The doc block states the design
constraint at `:311`: reconciliation happens "by phase and with NO time
thresholds — a row is only ever reconciled by what its phase and files prove".

**Why `phase='staged'` proves absence.** This is the load-bearing claim. The
commit transaction in `copyMagicContextState`'s returned `commit` closure
(`:1136-1204`):

- `:1149` `BEGIN IMMEDIATE`.
- `:1158-1164` deletes any prior `compartments` and `session_facts` rows for
  `(session_id = piSessionId, harness = 'pi')`, with the replay rationale at
  `:1150-1157`.
- `:1165-1191` inserts the remapped compartments and facts.
- `:1194-1200` advances the phase to `db_committed` **inside the same
  transaction**, with the comment at `:1194-1196`: "Advance the journal phase
  INSIDE this transaction: the sweep's roll-forward arm (db_committed ⇒ shared
  state committed) is only true because the two writes commit atomically."

So `phase='staged'` can only be observed when that transaction has not
committed, which is what makes deleting the staged file safe. The sweep's
comment at `:373-375` states the same thing from the other side.

**The write sequence the sweep reconciles.** `migrate.ts:1478-1500`:

1. `commitStagedChecksum` records the SHA-256 of the bytes about to be staged,
   with the row already at `phase='staged'` from `claimJournalIdentity`.
2. `fs.writeFileAtomic(stagePath, jsonl)` — outside the sessions root, on the
   same filesystem, so the later rename is atomic (`:1417-1420`).
3. `plan.commit(migrationKey)` — the transaction above.
4. `fs.mkdirSync(dirname(finalPath))` then `fs.renameSync(stagePath, finalPath)`.
5. `stmt(... DELETE FROM migration_pending ...)`.

The comment at `:1489-1492` names the invariant: "A failure between (2) and (4)
leaves a journal row the sweep reconciles by phase... No same-run cleanup — one
reconciliation code path for crashes and for retries."

**The journal's schema-level protection.** `MigrationPendingRow`
(`:88-97`) is preceded by a comment at `:82-87`: "Column names avoid a bare
`session_id` on purpose: the structural clearSession contract wipes every table
carrying that column, and session deletion must not destroy crash-recovery
records." The columns are `source_session_id` and `pi_session_id`, honouring it.
`migration_pending` is defined in
`packages/plugin/src/features/magic-context/storage-session-runtime-schema.ts`
and appears in the direct-format vocabulary fixture, so it is part of the
registered current schema and exists in every healthy install.

**Two call sites.** `migrate.ts:1408`, before claiming the current migration's
identity, and `doctor.ts:79-97` on every plain `doctor` invocation. The latter's
comment at `:65-70` explains the once-per-invocation placement: the journal lives
in the shared database, so dispatching per adapter would reconcile the same
physical database repeatedly.

**Loss is reported, never silenced.** `doctor.ts:82-84` routes lines beginning
`LOST` to `log.error` and everything else to `log.info`, and `:86-93` catches a
reconciliation failure into a warning rather than aborting the doctor run.

## Failure scenario

The dangerous inversion is a future change that writes shared state and advances
the phase in two transactions — for example, moving the `UPDATE
migration_pending SET phase` out of the closure for clarity, or wrapping only the
inserts in a transaction. Then a crash between the state commit and the phase
advance leaves `phase='staged'` with the state present. The next sweep — which
may be a plain `doctor` run minutes later — takes the roll-back arm, unlinks the
staged JSONL at `:376`, and deletes the row. The compartments and facts are in
`context.db` under a Pi session id whose JSONL file never existed and never will;
the harness sees no session, and the rows are unreachable. Nothing reports a
problem, because from the sweep's point of view it performed a clean rollback.

A second, present-tense scenario for the blast radius. A user interrupts
`doctor migrate --to pi --session A`, leaving a `phase='staged'` row. Before
retrying they run `doctor --harness omp` to check something unrelated.
`doctor.ts:79-97` sweeps, unlinks A's staged file, and deletes A's row. The retry
then re-mints from scratch, which is correct but does more work than the resume
the journal was built to enable, and the user was never told their interrupted
migration was discarded — the sweep's roll-back is reported as
`log.info`, not as an error.

## Timing windows and dependencies

- The reconciliation is not itself racy: it reads and writes the journal through
  the same connection the caller opened, and `openExistingContextDatabaseForMutation`
  sets `busy_timeout=5000` and `foreign_keys=ON`
  (`database-access.ts:65-74`, `:100-110`). Two concurrent sweeps would serialise
  on the journal writes.
- The correctness dependency is atomicity of the pair (state, phase), stated at
  `:1194-1196`. Anything that breaks it converts the roll-back arm into data
  loss.
- A second dependency: the roll-forward arm assumes stage and final are on the
  same filesystem so the rename is atomic. `claimJournalIdentity` is passed a
  `stageDir` that is a sibling of the sessions root
  (`:1417-1420`), and the comment there states the requirement.
- The `lost` arm is unbounded in time. Nothing deletes a `lost` row, so a
  permanently lost migration produces a `LOST` error on every subsequent doctor
  run forever. That is deliberate ("never silently delete", `:323-325`) but has
  no exit.

## What a test must construct

`migrate.test.ts` (1,411 lines) already covers the arms. The additions this
record wants:

1. **The atomicity invariant, asserted directly.** Insert a journal row at
   `phase='staged'`, then insert `compartments` rows for the same
   `pi_session_id` out of band, then sweep. Assert the sweep still takes the
   roll-back arm — that is the correct behaviour given the phase — and assert
   separately that no production code path can produce that state, by checking
   that the only `UPDATE migration_pending SET phase = 'db_committed'` statement
   in the tree (`:1199`) is lexically inside the `BEGIN IMMEDIATE` opened at
   `:1149`. A guard test in the style of the existing accessor-exclusivity guards
   (`packages/plugin/src/config/compaction-accessor-guard.test.ts`) fits.
2. **Foreign-key blast radius.** Two rows for two different migration keys, one
   `staged` and one `db_committed` with its stage present. Sweep once. Assert the
   staged one was rolled back and the committed one rolled forward, i.e. the
   sweep does not stop at the first row and does not confine itself to a key.
   Then assert the same from the `doctor.ts` entry, which passes no key at all.
3. **`lost` retention.** A `db_committed` row with neither file. Assert the row
   survives the sweep and survives a second sweep, and that
   `formatMigrationSweepLines` produces a line starting `LOST`.
4. **Idempotency.** Sweep twice over each fixture and assert the second report is
   all-zero, matching the claim at `:327`.
5. **Missing journal table.** Call the sweep against a database without
   `migration_pending` and assert an empty report rather than a throw (`:339`).

## Investigation log

### Q: Is the whole-journal blast radius intended, or should `doctor` sweep only rows whose `target_harness` matches an adapter it is running?

- Sources examined: `migrate.ts:341-347` (the unfiltered select), `:329-381`;
  `doctor.ts:65-70` (the once-per-invocation comment), `:79-97`;
  `migrate.ts:1408` (the per-migration call), `:289-297`
  (`migrationKeyFor` and the claim helper's doc);
  `MigrationPendingRow.target_harness` (`:91`).
- Findings: the comment at `:65-70` justifies running the sweep **once** rather
  than per adapter, and its reasoning is about avoiding repeated work on one
  physical database — it does not address scope. Filtering by `target_harness`
  would be possible, since the column exists, but it would break the sweep's own
  stated design: reconciliation "by phase and with NO time thresholds", where a
  row's phase and files are the whole input. Adding a harness filter would leave
  rows unreconciled indefinitely when the user stops using a harness, which is
  arguably worse. The real gap may be reporting rather than scope: a roll-back of
  a row the current invocation did not initiate is arguably a warning, not an
  info line.
- Missing evidence: no comment states whether cross-key reconciliation from
  `doctor` was considered.
- Conclusion: needs human input. The safest change is reporting severity, not
  scope.

### Q: Does the `lost` arm need a retention policy?

- Sources examined: `migrate.ts:323-325` and `:366-370` (the arm and its
  "never silently delete" rationale), `:108-113` (`MigrationSweepReport.lost`),
  `doctor.ts:82-84` (the `LOST` error routing).
- Findings: the arm is correct — a `db_committed` row with no bytes means shared
  state exists for a session whose file is gone, and the `content_sha256`
  column names what was lost, which is exactly the information a manual recovery
  needs. But there is no acknowledgement mechanism. A user who accepts the loss
  has no command to clear the row, so every future `doctor` run reports an error
  for a resolved situation, which trains them to ignore doctor errors.
- Missing evidence: whether any command can delete a `migration_pending` row
  outside the sweep. A search of `packages/cli/src` finds
  `DELETE FROM migration_pending` only inside the sweep (`:352`, `:363`, `:381`)
  and the successful-migration path (`:1497`), so no.
- Conclusion: unresolved, needs a retention decision — most likely an
  acknowledge flag or a `doctor` subcommand that reports the checksum and clears
  the row on explicit request.
