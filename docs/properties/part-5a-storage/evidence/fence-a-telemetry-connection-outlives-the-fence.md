# fence-a-telemetry-connection-outlives-the-fence

## Discovery trigger

Task 3 asks whether the fence can be bypassed by any other open path in this
package. Enumerating every `new Database(` in `packages/plugin/src` found five
production sites besides the fenced one, and one of them opens the same
`context.db` read-write and caches the handle outside the fence's bookkeeping.

## Evidence trail

The full inventory of production `new Database(` calls in the three in-scope
TypeScript packages:

| Site | Path opened | Mode | Fenced? |
| --- | --- | --- | --- |
| `storage-db.ts:753` | resolved `context.db` | read-write | yes, this is the fence |
| `transform-decision-log.ts:395` | `getDatabasePath(args.db)`, i.e. the same `context.db` | read-write | **no** |
| `compaction-marker.ts:183` | OpenCode's `opencode.db` | read-write | not applicable, different database |
| `read-session-db.ts:63` | session database | readonly | not applicable |
| `dreamer/open-opencode-db.ts:20` | OpenCode's database | readonly | not applicable |
| `storage-current-schema.ts:303` | `:memory:` scratch | read-write | not applicable |
| `shared/sqlite.ts:412` | `:memory:` probe | read-write | not applicable |

`compaction-marker.ts:183` looked like a candidate until `:172-180` showed it
opens OpenCode's own database and refuses to create it: "NEVER create the file
... a stray `~/.local/share/opencode/` directory would get a junk empty
opencode.db here". Different file, out of scope.

That leaves `transform-decision-log.ts`. The path comes from
`getDatabasePath(args.db)` at `:220` and `:278`, and `getDatabasePath`
(`storage-db.ts:179-181`) reads `pathByDatabase`, populated only in
`finishDatabaseOpen:565`. So the telemetry path is by construction the same
`context.db` the fence just admitted.

`telemetryDatabase` (`transform-decision-log.ts:392-405`):

```
const telemetryDbByPath = new Map<string, Database>();

function telemetryDatabase(dbPath: string): Database {
    let db = telemetryDbByPath.get(dbPath);
    if (!db) {
        db = new Database(dbPath);
        try {
            db.exec("PRAGMA busy_timeout=0");
        ...
        telemetryDbByPath.set(dbPath, db);
    }
    return db;
}
```

The comment at `:383-389` explains the design and names a related staleness
already: "One long-lived non-blocking telemetry handle per database path ... If
the DB file is ever replaced on disk, writes land on the old inode until restart
— acceptable for drop-on-contention telemetry."

The lifetime gap is in `closeDatabase` (`storage-db.ts:920-931`). It clears
`pendingAsyncOpens` (`:921`) and iterates `databases` (`:922-930`), and it does
not touch `telemetryDbByPath`, which lives in a different module and is not
exported.

The only clear is `reset()` at `transform-decision-log.ts:469-478`, ending:

```
        for (const db of telemetryDbByPath.values()) closeQuietly(db);
        telemetryDbByPath.clear();
```

Its sibling methods on the same object are `setWriterForTests` (`:479-481`) and
`setRetentionForTests` (`:482`), and a search for a production caller of the
reset seam found none.

## Failure scenario

1. A process opens `context.db` successfully. The fence passes.
2. A transform pass writes a decision row, creating the cached telemetry handle
   at `:395`.
3. A newer sibling install advances the database's vintage.
4. The process calls `closeDatabase()`. `databases` is emptied; the telemetry
   handle stays open.
5. The process calls `openDatabase()` again. The cache lookup at `:840` misses,
   `openDirectDatabase` runs, and the fence refuses at `:777-780`. The process
   reports storage unavailable.
6. A later transform pass calls `writeTransformDecisionBestEffort`, which reaches
   `telemetryDatabase(dbPath)` and finds the still-open handle, and writes a row
   into a database the fence has just refused.

The write is bounded. It is a row in `transform_decisions`, wrapped in the
best-effort try at `:374-380` which swallows every error, and the handle has
`busy_timeout=0` so it drops on contention rather than waiting. But it is a write
by an older binary into a family a newer binary owns, which is the class of event
the fence exists to prevent.

Step 6 requires the decision-log path to still run after storage was declared
unavailable. `writeTransformDecisionRow` needs a `dbPath`, and `:220-221` and
`:278-279` both return early when `getDatabasePath(args.db)` is `null`. So the
caller must still be holding a `Database` object from before. Whether any shipped
caller does is the unresolved half.

## Timing windows and dependencies

The window opens when the first decision row is written and closes at process
exit. It is not a race; it is a lifetime mismatch between two modules' caches.

A second, narrower window is the cached-handle path in `storage-db.ts` itself.
`openDatabase:840-851` returns a cached handle without re-running the fence, and
`:838-839` clears both latches before the lookup, so a cache hit also erases a
prior rejection. Because `latestSupportedVersion` is resolved per call at `:837`,
a second call with a lower ceiling gets a handle admitted under the higher one.
`openDatabaseAsync:879-886` is the same shape.

## What a test must construct

1. Open a healthy `context.db`. Write one transform decision row so the telemetry
   handle exists. `transform-decision-log.ts:485-487` exposes `writeRow` on the
   test-seam object, which is the cheapest way in.
2. `closeDatabase()`.
3. Advance the database's vintage on a third connection.
4. `openDatabase(dbPath)` and assert it returns `null` with a fence rejection.
5. Assert that no handle in `telemetryDbByPath` is open for that path. There is
   no exported accessor, so the observable proxy is: attempt another `writeRow`
   for the same path and assert the row count in `transform_decisions` did not
   increase.

For the cached-ceiling half: open with `{ dbPath, latestSupportedVersion: 200 }`
against a version-150 database, assert success, then call
`openDatabase({ dbPath, latestSupportedVersion: 90 })` and assert the verdict.
Under the current code it returns the cached handle.

## Investigation log

### Q: Should `closeDatabase` invalidate every secondary handle?

- Sources examined: `storage-db.ts:920-931`, `:59-63` (the four module-level
  maps), `transform-decision-log.ts:383-405`, `:469-478`.
- Findings: `storage-db.ts` owns four maps and closes what it owns. The telemetry
  cache is a fifth, in another module, keyed by the same path, with no
  registration mechanism. There is no import from `storage-db.ts` to
  `transform-decision-log.ts`, only the reverse (`transform-decision-log.ts:3`
  imports `getDatabasePath`), so a call from `closeDatabase` would create a
  cycle. That is likely why it does not exist; `storage-db.ts:54-57` records that
  the migrations constants were moved to a leaf module specifically "to break the
  storage-db <-> migrations import cycle", so the codebase is cycle-averse.
- Missing evidence: whether a registration or disposer-list pattern exists
  elsewhere in the package for this purpose.
- Conclusion: needs human input. The cheapest fix may be the other direction:
  resolve the path from the live handle on each write instead of caching a
  connection, accepting the per-write open cost the comment at `:384-386`
  explicitly rejected.

### Q: Can the decision-log path run after storage is declared unavailable?

- Sources examined: `transform-decision-log.ts:218-232`, `:276-290`, `:373-381`,
  `hook.ts:255-284`.
- Findings: both entry points require `args.db` and return `false` when
  `getDatabasePath` yields `null`. `hook.ts:263-283` returns `null` from the hook
  init on a refused open, so the hook itself holds no handle. The scenario needs
  a caller that captured a `Database` before the close and still uses it, which
  is plausible for a long-lived transform pass but not demonstrated.
- Missing evidence: the transform call graph, which is 5c scope.
- Conclusion: unresolved, needs a 5c-side check of whether a transform pass can
  outlive a `closeDatabase()`. Without it the bypass is structurally present but
  its trigger is unproven.

### Q: Is a per-call ceiling meaningful against a process-cached handle?

- Sources examined: `storage-db.ts:837`, `:840-851`, `:878`, `:881-886`,
  `:160-163`.
- Findings: no. The cache is keyed by path only. The first successful open fixes
  the admitted vintage for the process lifetime, and every later call's ceiling is
  ignored on a hit. The option is documented nowhere except the interface at
  `:160-163`.
- Missing evidence: whether any production caller varies the ceiling between
  calls for one path.
- Conclusion: needs human input on whether the option should be rejected on a
  cache hit that was admitted under a different ceiling, or whether the option
  should be test-only.
