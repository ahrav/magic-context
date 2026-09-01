# cli-a-repair-db-activation-is-self-describing

## Discovery trigger

METHOD.md requires effect accounting where an operation can partly complete. The
sub-part has two commands that move a database family: `doctor reset-db`, which
publishes a marker before its first move, and `doctor repair-db`, which does not.
Comparing them made the gap visible: reset's authors wrote down exactly why the
marker has to come first (`doctor-reset-db.ts:5-12`), and repair's activation has
no equivalent.

## Evidence trail

**The move loop.** `activateReplacement`
(`packages/cli/src/commands/doctor-repair-db.ts:453-475`):

```
DATABASE_SUFFIXES = ["", "-wal", "-shm"]            :44
for (const suffix of DATABASE_SUFFIXES) {           :460
    const from = `${dbPath}${suffix}`;              :461
    if (!existsSync(from)) continue;                :462
    const to = `${originalAsidePath}${suffix}`;     :463
    renameSync(from, to);                           :464
    movedOriginals.push({ from, to });              :465
}
renameSync(replacementPath, dbPath);                :467
return movedOriginals.map(({ to }) => to);          :468
```

The empty string is first in `DATABASE_SUFFIXES`, so the **main database file
moves first**. Nothing is written to disk to record that the loop started, and
`movedOriginals` is in-process state only.

**The in-process rollback and its limits.** `:469-474`:

```
} catch (error) {
    for (const moved of movedOriginals.reverse()) {
        if (existsSync(moved.to) && !existsSync(moved.from)) renameSync(moved.to, moved.from);
    }
    throw error;
}
```

This covers a throw, not a death. The guard is correct — it will not clobber a
`from` that reappeared — but a `renameSync` that throws inside the reversal
propagates out of the `catch` and abandons the remaining reversals. The caller at
`:673-678` turns the throw into `salvageResult = {ok: false, detail: "could not
install recovered database: ..."}` and falls through to the unsuccessful-salvage
reporting, which prints "Database remains unchanged: ${dbPath}" at `:694` — a
statement that is false if the reversal partly failed.

**Two callers, same exposure.** `:664` for the salvage arm and `:732` for the
fresh-empty arm. Both are preceded by a `statSync(dbPath)` mode read (`:661`,
`:729`), so both require `dbPath` to exist at entry.

**What the interrupted shape classifies as.** After the first iteration,
`context.db` is absent and `context.db-wal` may exist.
`inspectDirectDatabaseFamilyState`
(`packages/cli/src/lib/database-access.ts:307-362`) takes the
`!existsSync(dbPath)` branch at `:310`, calls
`listDatabaseFamilyArtifacts` (`:311`), and because the list is non-empty returns
`{state: "unsupported", family: "orphan-artifacts", reasons: ["orphan wal
artifact without a current main database"], databaseIncarnationId: null}`
(`:313-320`). `classifyPreOpenFamily`
(`storage-format-epoch.ts:392-431`) refuses the same shape at its final arm
(`:423-429`), and `openExistingContextDatabase` turns that into a throw at
`database-access.ts:133-137`.

**So the next command's behaviour is:** `doctor` fails to open the shared
database and appends the repair guidance again (`doctor-opencode.ts:1312-1315`);
`doctor repair-db` exits at `:521-526` because `existsSync(dbPath)` is false;
`doctor reset-db` classifies `unsupported (orphan-artifacts)`, reports the plan,
and offers to quarantine the orphan sidecar (`:601-607`). None of those outputs
mentions `${dbPath}.corrupt-original-<stamp>` or
`${dbPath}.corrupt-backup-<stamp>`, because none of them knows those paths exist.
The stamp is `timestamp(deps.now())` (`:517`, `:153-155`), so the directory
listing does contain the evidence, unlabelled.

**Contrast with the two mechanisms that do this correctly.**
`doctor-reset-db.ts:629-645` publishes a marker naming the destination and every
file identity before its first move, and `:5-12` states the resulting invariant.
`migrate.ts:1477-1500` stages, journals a checksum, commits state and phase in
one transaction, and renames last, with the sweep at `:329-381` reconciling by
phase. Both are in-scope files in the same sub-part, so the pattern is available
and locally idiomatic.

**Testability gap.** `ResetDbDeps` (`doctor-reset-db.ts:53-58`) exposes
`renameFile`, which is how `doctor-reset-db.test.ts:290-322` and `:323-369`
inject rename failures. `RepairDbDeps` (`doctor-repair-db.ts:62-66`) exposes
`now`, `sqliteExecutable`, and `inspectHolders` only; `activateReplacement` calls
the module-level `renameSync` imported at `:10`. So this window cannot be reached
from a test without mocking `node:fs`.

## Failure scenario

A user runs `doctor repair-db` on a corrupt `context.db`. `.recover` succeeds and
the recovered image validates. `activateReplacement` renames `context.db` to
`context.db.corrupt-original-20260830T…`, and the machine loses power before the
`-wal` rename.

On reboot the storage directory holds `context.db-wal`,
`context.db.corrupt-original-…`, `context.db.corrupt-backup-…`,
`context.db.corrupt-backup-…-wal`, and `context.db.recovering-…-<pid>.db`. The
plugin refuses to open the family. `doctor` says it could not open the shared
database and recommends `repair-db`. `repair-db` says "Database not found".
`reset-db` says the family is `unsupported (orphan-artifacts)` and offers to
abandon it — which, if confirmed, moves the orphan `-wal` into a quarantine
directory and lets the next open bootstrap a fresh empty database. The user now
has a working install, an empty history, and four unexplained files whose names
contain the word "corrupt".

Every byte survives. Nothing on the machine says so, and the one command that
offers a way forward offers the one that discards the recovery.

## Timing windows and dependencies

- The window is `:460` through `:467`: at most four `renameSync` calls (main,
  `-wal`, `-shm`, then the replacement). It is short, but a power loss is not
  rate-limited by window width, and the file already treats power loss as in
  scope by copying a backup bundle first.
- The exposure is asymmetric across the loop. A death after the **replacement**
  rename at `:467` is benign: the new database is in place and the originals are
  aside, which is the intended end state minus the log lines. A death **inside**
  the loop is the damaging case, and the main file is the first thing moved.
- Dependency: the harm depends on `orphan-artifacts` being refused rather than
  bootstrapped. That refusal is correct and is what keeps a fresh database from
  being created over a half-moved family — so the guard that prevents silent data
  loss is also what produces the dead end.
- Dependency: `uniqueBase` (`:157-165`) makes the aside path collision-free, so a
  second interrupted attempt does not overwrite the first attempt's originals.
  That is load-bearing for recoverability and worth asserting.

## What a test must construct

1. Reach the salvage-success path as in
   `cli-a-repair-db-live-swap-requires-confirmation` steps 1 and 2.
2. Inject a `renameSync` that succeeds `k` times then throws, for `k` in 0..3.
   This needs either a new `renameFile` member on `RepairDbDeps`, mirroring
   `ResetDbDeps:53-58`, or a `node:fs` module mock. The former is the better
   change and is itself a finding.
3. For each `k`, assert the desired guarantee: some artifact at or beside the
   `context.db` path names `${dbPath}.corrupt-original-<stamp>`. At `HEAD` this
   fails for `k` in 1..3.
4. Assert the weaker property that does hold today, so a regression is caught
   either way: for each `k`, the union of files present under
   `${dbPath}.corrupt-original-*`, `${dbPath}.corrupt-backup-*`, and `${dbPath}*`
   contains a readable database whose row counts equal the pre-run counts.
5. Assert the in-process rollback works for a plain throw: with a `renameSync`
   that throws on the replacement rename at `:467`, assert the family is back at
   its original paths and `REPAIR_DB_EXIT` is not `salvaged`.
6. Assert `uniqueBase` collision-freedom: run step 5 twice in the same second and
   assert two distinct aside bases.

## Investigation log

### Q: Should `activateReplacement` reuse the reset marker mechanism, or write a simpler breadcrumb?

- Sources examined: `storage-format-epoch.ts:560-583`
  (`buildDatabaseResetMarker`), `:664-668` (`writeDatabaseResetMarker` and its
  injectable publication filesystem, documented at `:648-662`), `:857-930`
  (`verifyResetMarkerFamily`), `doctor-reset-db.ts:5-12`, `:629-645`;
  `storage-format-epoch.ts:340-342` and `:396-404` (a marker's presence refuses
  the family).
- Findings: reusing the reset marker verbatim would be wrong, because a marker's
  presence makes the family `reset-pending` (`database-access.ts:308-309`) and
  routes the next invocation into `recoverPendingReset`, whose recovery action is
  to **complete a quarantine** — the opposite of what an interrupted repair wants.
  A repair breadcrumb needs its own artifact kind and its own recovery arm:
  roughly "the main file is at X, the replacement is at Y, finish or revert". The
  primitives are reusable — the digest-bound, fsync'd, mode-restricted publication
  helper and the dev/inode identity capture — but the artifact and the state must
  be distinct from the reset marker's.
- Missing evidence: whether the pre-open gate should refuse a
  repair-in-progress family the way it refuses `reset-pending`. It probably
  should, for the same reason, which means a third `PreOpenFamilyVerdict.family`
  value and a matching arm in `classifyPreOpenFamily`.
- Conclusion: needs human input. The design is a new artifact kind plus a
  recovery arm, not a reuse; that is a larger change than it first appears and
  should be sized before it is scheduled.

### Q: Should `RepairDbDeps` expose `renameFile` so this window becomes testable?

- Sources examined: `doctor-repair-db.ts:62-66`, `:147-151` (`DEFAULT_DEPS`),
  `:10` (the `renameSync` import), `:453-475`;
  `doctor-reset-db.ts:53-58`, `:69-74`, and the injection sites at
  `doctor-reset-db.test.ts:290-322` and `:323-369`.
- Findings: the change is mechanical. `RepairDbDeps` already exists with a
  `DEFAULT_DEPS` object, `activateReplacement` is a module-level function that
  would take the injected function as a parameter exactly as
  `moveIntoQuarantine` does (`doctor-reset-db.ts:125-139`), and there are two
  call sites (`:664`, `:732`). Without it, the only interruption tests possible
  are whole-process ones, which the suite does not do for this command.
- Missing evidence: none.
- Conclusion: unresolved, needs a design decision, but the precedent is in the
  sibling file and the cost is a parameter.
