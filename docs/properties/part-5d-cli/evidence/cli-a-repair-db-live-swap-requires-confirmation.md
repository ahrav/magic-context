# cli-a-repair-db-live-swap-requires-confirmation

## Discovery trigger

The task asks, for each destructive command, what confirmation it requires. The
destructive command table needed a row for `doctor repair-db`, and reading the
file to fill in the confirmation column produced the finding: there is no
confirmation on the arm that replaces the live database. The one `confirm` in the
file sits on the second arm, and the help text describes only that one.

## Evidence trail

**The control flow to the swap.** `runRepairDb`
(`packages/cli/src/commands/doctor-repair-db.ts:510-752`), in order:

| Step | Lines | Prompts? |
| --- | --- | --- |
| intro, path check | `:519-526` | no |
| refuse if a reset marker is pending | `:529-536` | no |
| holder inspection | `:538-539` | no |
| family classification gate | `:541-555` | no |
| copy the backup bundle | `:557-568` | no |
| isolated row-count snapshot, report BEFORE | `:570-587` | no |
| isolated salvage snapshot | `:589-600` | no |
| `.recover` into a fresh database | `:601-610` | no |
| could-not-start and capability-missing arms | `:611-646` | no |
| validate and migrate the recovered image | `:647-652` | no |
| re-inspect holders | `:654-659` | no |
| chmod, **rename originals aside, install replacement** | `:660-672` | **no** |
| unsuccessful-salvage reporting | `:681-700` | no |
| fresh-empty reset offer | `:702-705` | **yes** |
| re-inspect holders, build and install a fresh database | `:712-742` | no |

**Enumeration of prompts.** A read of the file at `HEAD` finds exactly one
`prompts.confirm`, at `:702-705`: "Salvage failed. Move the corrupt database
aside and create a fresh empty database? This discards all unrecovered data from
the active database." with `false` as the default. Every other `PromptIO` use in
the file is `log.info`, `log.warn`, `log.error`, `log.success`, `intro`, `outro`,
or `spinner`. `RunRepairDbOptions` (`:68-73`) has no `yes` field, unlike
`RunResetDbOptions` (`doctor-reset-db.ts:60-67`).

**What the swap does.** `activateReplacement` (`:453-475`) iterates
`DATABASE_SUFFIXES = ["", "-wal", "-shm"]` (`:44`), renaming each existing
`${dbPath}${suffix}` to `${originalAsidePath}${suffix}` and recording the move,
then renames the replacement onto `dbPath` at `:467`. `:661-662` preserves the
original file mode. The originals land at
`${dbPath}.corrupt-original-<stamp>*` via `uniqueBase` (`:663`, `:157-165`), and
are reported at `:668`.

**The data loss is real, not hypothetical.** `.recover` is lossy by
construction, and the file says so at `:681-685`: "`.recover` emits a
`lost_and_found` table whenever page-to-table attribution is lost, and the
exact-inventory gate refuses any unregistered object, so the recoveries that
salvage the most rows are precisely the ones that fail classification." So a
recovery that **passes** classification is one where rows that could not be
attributed were dropped rather than parked. `readCountsFromOpenDatabase`
(`:392-405`) counts what survived across `ROW_COUNT_TABLES` (`:43`: tags,
compartments, claims, notes, dream_runs).

**Ordering of the loss report.** `reportSchemaTransition` (`:665`),
`reportCounts(prompts, "AFTER", ...)` (`:666`), and `reportSalvageRates`
(`:667`) all run **after** `activateReplacement` at `:664`.
`reportSalvageRates` (`:221-237`) is the function that prints
"`${table}: ${beforeCount} → ${afterCount} (${rate}%, lost ${lost})`". So the
operator learns the per-table loss only once the lossy database is installed.

**Contrast with the file's own documentation.** `printHelp:495-508` says at
`:500`, "If salvage is impossible, an empty reset is offered with a separate
confirmation." That is an accurate description of `:702-705` and silent about the
salvage arm. `dispatch.ts:63` describes the command as "Back up and salvage a
corrupted shared database".

**How a user gets here.** `formatDatabaseRepairGuidance`
(`packages/cli/src/lib/database-repair-guidance.ts:9-15`) is appended to three
doctor failures: a non-`ok` `integrity_check` (`doctor-opencode.ts:1272`), an
`integrity_check` that threw (`:1276`), and any failure to open the shared
database (`:1314`). So the doctor recommends this command for exactly the
conditions in which `.recover` will be lossy.

## Failure scenario

A user's `context.db` develops a corrupt page after a power loss. `doctor`
reports `SQLite integrity_check reported: ...` and appends the repair guidance.
The user runs `doctor repair-db`. Holders are clear, the family classifies as
`current`, the backup bundle copies, `.recover` runs and emits a dump that
replays cleanly into a fresh database with 8,000 of the original 12,000
compartments — the 4,000 whose pages could not be attributed are simply absent,
and because no `lost_and_found` table survived into the registered inventory the
image classifies as `current` at `:358-366`. `activateReplacement` installs it at
`:664`. Only then does `:667` print
`compartments: 12000 → 8000 (66.7%, lost 4000)`.

The bytes are not gone: `${dbPath}.corrupt-backup-<stamp>` and
`${dbPath}.corrupt-original-<stamp>` both hold the pre-repair family, and both
paths are logged (`:568`, `:668`, `:670`). But the user was never offered the
choice between "install a database missing a third of my history" and "leave it
alone and get help", and the harness they restart (`:671`) begins writing into
the reduced database, so restoring the original later means reconciling two
divergent histories.

## Timing windows and dependencies

No interleaving is needed; the absence of a prompt is unconditional control flow.
Three dependencies frame it:

- `:654-659` re-inspects holders immediately before the swap and bails to
  `reportSafetyRefusal` if a harness appeared, so the swap is protected against
  concurrency. The gap is consent, not concurrency.
- The two capability arms at `:611-626` and `:627-646` are careful in exactly the
  way the salvage arm is not: both refuse to draw a verdict about the data from a
  tool limitation, leave the database untouched, and explicitly do **not** offer
  the destructive reset (`:620`, `:640`). The comment at `:628-631` states that
  posture. So the file's authors reasoned hard about when not to act, and the
  salvage swap is the case that escaped it.
- `prepareFreshDatabase` (`:407-447`) is the second arm's builder, and it is the
  one that is confirmed. Both arms end in the same `activateReplacement`, so the
  mechanism is shared and only the consent differs.

## What a test must construct

1. Build a `context.db` that classifies as `current` and whose `.recover` output
   replays into a `current` image with strictly fewer rows in at least one of
   `ROW_COUNT_TABLES`. The simplest construction is to bootstrap a normal
   database, populate `compartments`, then corrupt a page in the middle of that
   table with a raw write so `.recover` skips it.
2. Stub `deps.inspectHolders` to return `{safe: true, blockers: []}` and
   `deps.sqliteExecutable` to a shell with `SQLITE_ENABLE_DBPAGE_VTAB`
   (`defaultSqliteExecutable` honours `MAGIC_CONTEXT_SQLITE3`, `:113-115`).
3. Pass a `prompts` stub that records every method call and throws if `confirm`
   is invoked with an unexpected message.
4. Assert `REPAIR_DB_EXIT.salvaged` and that the stub recorded **no** `confirm`
   call. At `HEAD` that assertion passes, which is the defect: the desired
   assertion is the opposite, that a `confirm` preceded the swap.
5. Assert the ordering defect independently: the recorded call sequence contains
   `log.success("Salvaged database installed: ...")` (`:669`) and the
   `reportSalvageRates` lines, and check whether any rate line precedes the
   install. At `HEAD` it does not.
6. Assert both preservation paths exist so the "logical, not physical" claim in
   the destructive command table is checked:
   `${dbPath}.corrupt-backup-<stamp>` and `${dbPath}.corrupt-original-<stamp>`.

Steps 1 and 2 are the expensive part and `doctor-repair-db.test.ts` (556 lines)
already builds that scaffolding; steps 3 through 5 are assertions on top of it.

## Investigation log

### Q: Is the missing prompt deliberate, on the theory that a corrupt database has no value to preserve?

- Sources examined: `doctor-repair-db.ts:495-508` (`printHelp`), `:500`,
  `:611-626` and `:627-646` (the two capability arms and their explicit refusal
  to offer reset), `:628-631` (the comment stating that posture), `:681-685` (the
  comment on `.recover` losing rows), `:702-705` (the one prompt),
  `dispatch.ts:63`.
- Findings: the theory does not hold up against the file's own reasoning. The
  capability arms refuse to conclude anything about the data from a tool
  limitation, and `:681-685` shows the authors knew salvage drops rows. If a
  corrupt database had no value, `.recover` would not be attempted at all and the
  backup bundle at `:557-568` would be pointless. The more likely reading is that
  the salvage arm was modelled as a repair (non-destructive by intent) and the
  fresh-empty arm as a reset (destructive), so consent was attached to the label
  rather than to the effect. `printHelp:500`'s wording — describing the second
  confirmation as "separate", implying a first — reads as though a first
  confirmation was assumed to exist.
- Missing evidence: no comment or commit message in the file explains the
  asymmetry, and the sibling `doctor reset-db` confirms even when it is only
  renaming files it never deletes, which makes the asymmetry harder to justify.
- Conclusion: needs human input. If the answer is "the swap should be confirmed",
  the fix is small and should reuse `reportSalvageRates` before the prompt so the
  numbers inform the decision.

### Q: Should `reportSalvageRates` move before `activateReplacement`?

- Sources examined: `:654-679` (the install block), `:665-667` (the three report
  calls), `:221-237` (`reportSalvageRates`), `:392-405`
  (`readCountsFromOpenDatabase`, which produced `afterCounts` inside
  `migrateAndCheckRecoveredDatabase` at `:378`), `:337-390`.
- Findings: mechanically trivial. `salvageResult.afterCounts` is populated at
  `:378`, inside `migrateAndCheckRecoveredDatabase`, which completes at `:649` —
  well before `:664`. So all three report calls could run before the swap with no
  restructuring. The only argument for the present order is that the reports read
  as a completion summary rather than as a decision input.
- Missing evidence: none.
- Conclusion: resolved with answer — yes, it can move, and it must if a
  confirmation is added, because a prompt asking the operator to accept a lossy
  swap without showing the loss would be worse than the current silence.

### Q: Does the swap have a partial-completion hazard as well as a consent hazard?

- Sources examined: `:453-475` in full, `:44`, `:469-474`.
- Findings: yes, and it is a separate property. `activateReplacement` moves the
  main file first and reverses its moves only on an in-process throw, guarding
  each reversal with `existsSync(moved.to) && !existsSync(moved.from)`. A process
  death mid-loop leaves a split family with no on-disk record.
- Missing evidence: none.
- Conclusion: resolved with answer — separate concern, carried by
  `cli-a-repair-db-activation-is-self-describing`. Kept out of this record so the
  `Check` stays a single condition.
