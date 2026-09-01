# cli-a-reset-db-dry-run-changes-nothing

## Discovery trigger

The task asks for a destructive-safety property stating that a dry run has no
effect. `doctor reset-db` is the only destructive command in sub-part 5d that
implements one, `dispatch.ts:64` advertises it in the usage text as
`(--dry-run/--yes)`, and `packages/cli/src/lib/database-repair-guidance.ts:6`
tells operators to "preview with --dry-run". A preview that writes would be worse
than no preview, because the operator chose it in order not to act.

## Evidence trail

**Two dry-run arms, both early returns.**

- Fresh arm: `doctor-reset-db.ts:579-586`. After the `reset-pending`,
  `pristine`, and `current` dispositions (`:563-577`), `if (options.dryRun)`
  captures a plan, reports it, logs "Dry run: no file was changed and no reset
  marker was published." (`:583`), and returns `RESET_DB_EXIT.ok`.
- Recovery arm: `:520-524`, inside `recoverPendingReset`. After reporting the
  pending marker's identities, destination, and per-role recovery status
  (`:508-519`), it logs "Dry run: no file was changed." and returns `ok`.

**Every mutating call is downstream of both returns.** The complete set of
mutating calls in the file, from its imports at `:19`:

| Call | Line | Reached from |
| --- | --- | --- |
| `mkdirSync` | `:113` | `ensureQuarantineDir` ← `moveIntoQuarantine` (`:131`) and the resume branch (`:311`) |
| `chmodSync` | `:122` | `ensureQuarantineDir`, same callers |
| `chmodSync` | `:137` | `moveIntoQuarantine` |
| `renameFile` | `:136` | `moveIntoQuarantine` |
| `chmodSync` | `:312` | `executeQuarantine` resume branch |
| `chmodSync` | `:352` | `executeQuarantine` marker finalisation |
| `rmSync` | `:236` | `refuseQuarantine` marker rollback |
| `writeDatabaseResetMarker` | `:637` | `runResetDb`, after the confirmation |

`moveIntoQuarantine` is called only at `:320` and `:353`; `ensureQuarantineDir`
only at `:131` and `:311`; `executeQuarantine` only at `:535` and `:646`;
`refuseQuarantine` only from inside `executeQuarantine` (`:296`, `:299`, `:334`,
`:337`). Every one of those sites is after a dry-run return. In the recovery arm
the check at `:520` precedes the confirmation at `:525-529` which precedes
`executeQuarantine` at `:535`.

**The plan capture is read-only.** `captureResetPlan` (`:397-410`) calls
`captureDatabaseFamilyIdentities`, which only lstats
(`storage-format-epoch.ts:505-521`), and `allocateQuarantineDirPath` (`:100-108`),
which probes candidate paths with `pathEntryExists` — an `lstatSync` wrapper
(`:83-98`) — and returns a string. It creates nothing;
`ensureQuarantineDir` is a separate function with separate callers.

**Classification is read-only by construction.**
`inspectDirectDatabaseFamilyState`
(`packages/cli/src/lib/database-access.ts:307-362`) copies the family into a
`mkdtempSync` probe directory (`:322-330`), opens the copy read-write so SQLite
can roll back a hot journal (`:274-286`, rationale `:296-305`), and removes the
directory in `finally` (`:358-361`). The real path is passed to
`inspectDatabaseForClassification` only for existence and artifact checks, which
`storage-format-epoch.ts:926-928` documents as read-only.

**Flag parsing.** `runResetDbCli:673-674` sets both `dryRun` and `yes` from the
argument array independently, and `:662-670` rejects any other flag. Because
`options.dryRun` is checked at `:579` before `confirmReset` is ever called,
`--dry-run --yes` together is a dry run; `--yes` cannot promote it.

## Failure scenario

Two ways this could break, both plausible in a future change.

1. Someone moves `ensureQuarantineDir` into `captureResetPlan` so the
   destination is validated during planning. A `--dry-run` would then create an
   empty `0700` directory beside `context.db`. That directory is not an artifact
   `listDatabaseFamilyArtifacts` recognises (`storage-format-epoch.ts:353-356`
   checks `-wal`, `-shm`, `-journal`, and the reset-marker suffix), so nothing
   would refuse the family, but `allocateQuarantineDirPath` would then skip that
   stamp on a later real run (`:102-106`) and the storage directory would
   accumulate empty directories per preview.
2. Someone moves the `--dry-run` check below the marker publication in order to
   preview the marker's contents. Then a preview would publish a marker, and
   `doctor.ts:46-51` would refuse to run any doctor until the operator ran the
   destructive command they were trying to avoid.

## Timing windows and dependencies

No timing angle for the guarantee itself: both arms are straight-line early
returns.

One ordering fact does matter and is the record's open question. The fresh arm
returns at `:579-586`, **before** `inspectHoldersSafely` at `:588` and before
`recheckUnderExclusivity` at `:595`. The file header at `:14-17` states that the
classification the command acts on and reports for confirmation is the one taken
after the holder inspection. The dry run therefore previews the classification
from `:560`, which `:433-447` describes as inherently racy: it reads a probe copy
whose main file and sidecars are copied as separate operations, so a checkpoint
landing between those copies makes a supported family read as unsupported. A
preview can consequently say `unsupported (corrupt direct format)` for a family
a real run refuses as `current`.

Dependency: the guarantee also depends on `describeFamilyState` (`:141-154`)
being total over the state union, since the dry-run arm calls it via
`reportResetPlan` (`:412-427`). It is a switch with no default, so adding a
state to `DirectDatabaseFamilyState` breaks the build rather than silently
mislabelling a preview.

## What a test must construct

1. Bootstrap an `unsupported` family: a `context.db` with a valid marker whose
   `component_manifest_digest` does not match this build, or an extra schema
   object. Snapshot the directory listing and the SHA-256 of every entry.
2. `await runResetDb({dbPath, dryRun: true, prompts: <recording stub>})`.
3. Assert `RESET_DB_EXIT.ok`, the directory listing is unchanged (this catches
   an accidental quarantine directory, which a per-file digest check would miss),
   every digest is unchanged, and `readDatabaseResetMarker(dbPath).status` is
   `absent`.
4. Assert the recording stub saw no `confirm` call, since the dry run must not
   prompt.
5. Repeat for the recovery arm: publish a marker with `writeDatabaseResetMarker`,
   move one family file into the quarantine directory by hand, then dry-run and
   assert the per-role statuses were reported (`:516-518`) and nothing moved.
6. `--dry-run --yes` together: assert the outcome equals the `--dry-run`-only
   outcome.

`doctor-reset-db.test.ts:238-269` covers step 2 and part of step 3 for the fresh
arm; steps 3's listing assertion, 4, 5, and 6 are new.

## Investigation log

### Q: Should the dry run also run the holder inspection and the recheck?

- Sources examined: `doctor-reset-db.ts:579-586`, `:588-593`, `:595-597`,
  `:14-17`, `:433-447`, `:544` (help text), `database-repair-guidance.ts:6`,
  `doctor-reset-db.test.ts:238-269`, `:604-674` (the scenario that exists
  precisely because the first reading is racy).
- Findings: the trade-off is symmetric and neither side is obviously right.
  Running the inspection would make the preview faithful, at the cost of a
  preview that refuses whenever OpenCode, Pi, or OMP is running — which is the
  normal state of a machine whose owner is investigating a problem, and the
  refusal message at `:205` would tell them to close every harness just to look.
  Not running it keeps the preview always available but lets it misreport, and
  scenario 10 (`:604-674`) proves the misreport is a real state, not a
  hypothetical: it is the same tear that scenario exists to guard the acting path
  against.
- Missing evidence: no comment in the file addresses the dry-run arm's
  divergence. `:14-17` describes the acting path only, and `:544`'s help text
  ("Preview the family, file identities, and destination only") is silent about
  which reading.
- Conclusion: needs human input. A third option exists and may be the cheapest:
  keep the current behaviour, and have the dry-run output say which reading it
  used and that a real run reclassifies under exclusivity.

### Q: Can a dry run create an entry in the storage directory by any path?

- Sources examined: the mutating-call table above; `:100-108`
  (`allocateQuarantineDirPath`), `:83-98` (`pathEntryExists`), `:110-123`
  (`ensureQuarantineDir`) and its two call sites; `:397-410`
  (`captureResetPlan`); `database-access.ts:322-330` and `:358-361` (the probe
  directory's creation and removal).
- Findings: no. The only directory created during a dry run is the probe
  directory under `os.tmpdir()`, and it is removed in a `finally`. If the removal
  fails the leak is in the temp directory, not beside `context.db`.
  `allocateQuarantineDirPath` returns a path without creating it, and the two
  `ensureQuarantineDir` call sites are both past the dry-run returns.
- Missing evidence: none.
- Conclusion: resolved with answer — no. The directory-listing assertion in step
  3 is therefore a regression guard against future change rather than a check of
  present behaviour.
