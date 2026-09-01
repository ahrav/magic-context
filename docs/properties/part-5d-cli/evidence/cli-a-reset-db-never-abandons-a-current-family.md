# cli-a-reset-db-never-abandons-a-current-family

## Discovery trigger

The task framing asks what `doctor reset-db` actually does and whether it can
destroy data the Part 5a fence was protecting. Before answering the negative
case, the positive guarantee had to be pinned down: the command's own help text
at `packages/cli/src/commands/doctor-reset-db.ts:542` claims "Reset never
migrates or salvages data and never touches a supported database." That is a
documented guarantee, so per METHOD.md rule 3 it is a claim under test.

## Evidence trail

The guarantee is enforced at three separate points, all read at `HEAD`
`e447c927`.

1. **Entry classification.** `runResetDb` calls
   `deps.inspectFamilyState(dbPath)` at `:560` and prints the state at `:561`.
   `state === "current"` takes the refusal at `:571-577`, logging "Refusing to
   reset: this database is the current supported format. Reset abandons only
   unsupported families." and returning `RESET_DB_EXIT.refused` (3).
2. **Post-holder-inspection recheck.** After `inspectHoldersSafely` reports no
   live holder (`:588-593`), `recheckUnderExclusivity` runs at `:595`. Its
   `current` arm is `:455-462`, which logs a message naming the earlier reading
   and adds "Nothing was changed and no reset marker was published." (`:459`).
   The rationale for re-reading is written out at `:433-447`: the first
   classification reads a probe copy whose main file and sidecars are copied as
   separate operations, so a checkpoint landing between those copies makes a
   supported family read as unsupported.
3. **Post-confirmation recheck.** `:623` calls `recheckUnderExclusivity` again
   with the previously confirmed state. The reason is at `:614-622`: the
   confirmation prompt is an open-ended window in which another process can
   upgrade or replace the family in place, and marker verification compares
   device and inode while ignoring size and content, so an in-place replacement
   that reuses the inode could otherwise pass.

The classifier those three points share is
`inspectDirectDatabaseFamilyState` in `packages/cli/src/lib/database-access.ts:307-362`.
It returns `state: "current"` only at `:340-342`, when
`classification.family === "current"` **and** a database incarnation id is
readable. `:288-306` documents that classification reads a private temp copy of
the whole family and never mutates the real one.

No mutating call executes before the third check. The mutating calls in the file
are `mkdirSync` (`:113`), `chmodSync` (`:122`, `:137`, `:312`, `:352`),
`deps.renameFile` (`:136`), `rmSync` (`:236`), and `writeDatabaseResetMarker`
(`:637`). Every one is reached only from `executeQuarantine` (`:285-370`),
`refuseQuarantine`'s marker rollback (`:235-243`), or the publication at `:637`,
all of which follow `:623`.

## Failure scenario

A user runs two Magic Context builds against one shared
`~/.local/share/cortexkit/magic-context/context.db`. A stale build logs a
storage refusal and recommends a reset. The user runs `doctor reset-db --yes`
while the newer build is checkpointing. The first classification at `:560` reads
a torn probe copy and reports `unsupported`. If the recheck at `:595` did not
exist, the marker would be published against a healthy family and all four
family files would be renamed into `${dbPath}.mc-quarantine-<stamp>/`. Because
`storage-db.ts:711-712` states there is no migration lane, nothing rebuilds the
database from the quarantined copy automatically; the user's compartments,
claims, notes, and memories are gone from the application's view.

## Timing windows and dependencies

- Window A, `:560` to `:595`: the entry classification is taken with holders
  possibly live. This window is why `:595` exists.
- Window B, `:603-607` to `:623`: the confirmation prompt. Unbounded, operator
  controlled. Closed by `:623`.
- Window C, `:623` to `:637`: reclassification to marker publication. Narrow but
  nonzero; the residual inode-reuse gap named at `:614-622` lives here, and
  `storage-format-epoch.ts:838-856` explains why size is not compared.

Dependency: the guarantee rests entirely on `classifyDatabaseFormatFamily`
(`storage-format-epoch.ts:288-345`) returning `current` for a healthy family. It
requires an exact object inventory (`:332-339`), a matching `application_id`
(`:322-326`), a `user_version` equal to the format epoch (`:327-331`), and a
present marker whose epoch and manifest digest match (`:309-321`). Any drift in
the registered schema makes a healthy database read as `unsupported`, which turns
this guarantee's protection off. That is the coupling worth watching.

## What a test must construct

1. Bootstrap a current-format `context.db` with this build.
2. Call `runResetDb({dbPath, deps: {inspectFamilyState: () => ({state:
   "unsupported", family: "malformed-marker", reasons: ["injected"],
   databaseIncarnationId: null})}, yes: true})` for the first-pass case, and
   with a stub that returns `unsupported` once then `current` for the
   recheck case. `ResetDbDeps` (`:53-58`) exposes `inspectFamilyState`, so both
   are injectable without touching the filesystem.
3. Assert `RESET_DB_EXIT.refused` and that the SHA-256 of `context.db`,
   `context.db-wal`, `context.db-shm`, `context.db-journal`, and
   `context.db.mc-reset` (present or absent) is unchanged.
4. Assert no directory matching `${dbPath}.mc-quarantine-*` exists.
5. Repeat with the recheck stub returning `current` only on the third call, to
   cover the post-confirmation arm at `:623`.

Step 3 is the part existing tests omit: `doctor-reset-db.test.ts:495-537` and
`:604-674` assert the exit code and the family's continued classification, not a
digest of all five paths.

## Investigation log

### Q: The `--dry-run` arm returns before either recheck, so a preview can report `unsupported` for a family a real run would refuse as `current`. Is the preview meant to be a faithful rehearsal?

- Sources examined: `doctor-reset-db.ts:579-586` (dry-run return),
  `:588` (holder inspection, after it), `:595` (first recheck),
  `:14-17` (header claim about which classification the command acts on),
  `:433-447` (recheck rationale), `:544` (help text for `--dry-run`),
  `packages/cli/src/lib/database-repair-guidance.ts:6` (guidance recommending
  `--dry-run`), `doctor-reset-db.test.ts:238-269` (the dry-run test).
- Findings: the header at `:14-17` says the classification the command "acts on
  — and reports to the operator for confirmation — is the one taken after the
  first holder inspection finds no live holder." The dry run reports the one
  taken at `:560`, before that inspection. The test at `:238-269` asserts the
  preview's content against a family that is stably unsupported, so it cannot
  distinguish the two readings. Making the dry run run the holder inspection
  would be a behaviour change: a preview would then refuse when OpenCode is
  running, which is arguably the common case for someone investigating.
- Missing evidence: no comment states whether the dry run's divergence is
  deliberate. The header's wording covers the acting path only.
- Conclusion: needs human input. Two defensible designs: a preview that always
  works but may misreport, or a preview that mirrors the real run and refuses
  when a holder is live.

### Q: Does any refusal path leave a `-journal` file that did not previously exist?

- Sources examined: `doctor-reset-db.ts:560`, `database-access.ts:307-362`,
  `:322-331` (probe directory and per-suffix copy), `:358-361` (finally block).
- Findings: classification copies the family into `mkdtempSync(join(tmpdir(),
  "mc-family-probe-"))` and opens the copy read-write so SQLite can roll back a
  hot journal (`:270-286`, `:296-305`). The `finally` at `:358-361` closes the
  connection and removes the probe directory recursively. Nothing opens the real
  path: `openProbeCopyForRecovery` receives `probePath`, and
  `inspectDatabaseForClassification(db, dbPath)` uses `dbPath` only for
  existence and artifact checks (`storage-format-epoch.ts:926-928`). So no SQLite connection is made to the real family on a refusal
  path.
- Missing evidence: none for the refusal path.
- Conclusion: resolved with answer — no. The real family is never opened by
  SQLite during classification, so no journal, WAL, or SHM file can be created
  by a refusal. This is a stronger position than the plugin's own fence, which
  runs on a live connection (Part 5a records the deferral of
  `PRAGMA journal_mode=WAL` to `storage-db.ts:782` for that reason).
