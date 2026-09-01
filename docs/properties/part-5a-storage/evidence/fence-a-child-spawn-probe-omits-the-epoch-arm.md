# fence-a-child-spawn-probe-omits-the-epoch-arm

## Discovery trigger

Searching for consumers of `getSchemaFenceRejection` turned up a module the
scope map does not name: `features/magic-context/schema-fence-probe.ts`, a second
fence that runs before a child session is created. Comparing its condition to the
open fence's showed it checks one of the two arms.

## Evidence trail

`packages/plugin/src/features/magic-context/schema-fence-probe.ts:70-101` is
`probeChildSpawnFence`. Its live-handle arm is `:82-92`:

```
    try {
        const persistedVersion = getPersistedSchemaVersion(db);
        if (persistedVersion > LATEST_SUPPORTED_VERSION) {
            return recordStaleFence(persistedVersion, LATEST_SUPPORTED_VERSION);
        }
    } catch {
        return recordStaleFence(LATEST_SUPPORTED_VERSION, LATEST_SUPPORTED_VERSION, "read_error");
    }
```

Compare the open fence at `storage-db.ts:669`, which is a conjunction over the
version lane **and** the marker epoch. The probe never calls
`readDirectFormatMarker`; its imports are `getPersistedSchemaVersion`,
`getSchemaFenceRejection` and `LATEST_SUPPORTED_VERSION` only
(`schema-fence-probe.ts:2-6`).

It also compares against the imported constant `LATEST_SUPPORTED_VERSION`
(`:5`, used at `:84-85`), not against `getRuntimeLatestSupportedVersion`. So the
env override and the per-call option documented in
`fence-a-env-override-relaxes-only-the-version-arm` are honoured at open and
ignored at spawn, in the relaxing direction: an operator who raised the ceiling
opens the database and is then refused every child spawn.

The null-handle arm at `:71-79` reads the open fence's latch instead:

```
    if (!db) {
        const knownRejection = getSchemaFenceRejection();
        if (knownRejection) {
            return recordStaleFence(knownRejection.persistedVersion, knownRejection.supportedVersion);
        }
        return { allowSpawn: true };
    }
```

The comment at `:65-68` explains: "an already fail-closed main handle has no
handle to query, so its recorded rejection is the authoritative verdict." That
arm does therefore inherit the epoch verdict indirectly, because the latch is set
by `refuseNewerSchemaFence:672` regardless of which arm fired. But note the latch
payload carries only the version pair, so an epoch refusal arrives here as
`persistedVersion === supportedVersion`, and `recordStaleFence` reports that pair
to the user.

**Two callers**, both production:

- `packages/plugin/src/hooks/magic-context/child-session-spawn.ts:88`, inside
  `createChildSessionWithFence`. Its doc comment at `:82-84` states the reach:
  "Shared OpenCode child-session choke point. Every historian/recomp, dreamer,
  and sidekick child must pass this probe before asking OpenCode to create it."
  On refusal it logs (`:91-95`), optionally surfaces (`:97-100`), and returns
  `null` at `:101`, so no session is created.
- `packages/pi-plugin/src/subagent-runner.ts:851`, as
  `probeChildSpawnFence(openDatabase())`. On refusal it calls `failBeforeSpawn`
  with the message "Magic Context: plugin build is older than its database
  (database=v..., supported_fence=v...) — restart Pi." (`:853-857`).

The Pi call site passes `openDatabase()` directly, so a fence-refused open yields
`null` and the probe takes the latch-reading arm. That is the intended
composition, but it means one skew is observed twice: once by
`refuseNewerSchemaFence` and once by `recordStaleFence`, and
`recordStaleFence:46-49` increments `consecutiveFailures` and latches at
`STALE_CHILD_SPAWN_LATCH_THRESHOLD = 2` (`:9`).

## Failure scenario

A newer generation bumps only the marker epoch, leaving `schema_migrations` at
90. On the OpenCode path:

1. `openDatabase` refuses at `storage-db.ts:777-780` and the hook disables Magic
   Context at `hook.ts:263-283`, so no child spawns anyway.

That is the safe composition. The unsafe composition needs a live handle whose
database becomes newer after the open succeeded:

1. The process opens successfully at epoch 1.
2. A newer sibling upgrades the marker to epoch 2 in place.
3. `createChildSessionWithFence` is called with the still-live `args.db`.
4. The probe reads the version lane, still 90, and returns `allowSpawn: true`
   (`:97-100`).
5. A historian, recomp, dreamer or sidekick child is created and runs against a
   database a newer binary owns.

Whether step 2 exists depends on whether any shipped path bumps vintage in place,
which is unresolved in `fence-a-accepted-path-proves-vintage`.

## Timing windows and dependencies

The probe is a per-spawn read on the process's existing handle, so its window is
exactly the interval between the successful open and each spawn. The comment at
`:66-67` states the design: "The hot path uses the process's existing SQLite
handle."

The latch is process-local module state (`:29-35`), acknowledged at `:107`:
"Test seam: child-spawn fence state is process-local by design." A successful
read re-arms it at `:97-99`, with the comment at `:94-96` calling that path
"normally unreachable for a monotonic schema version".

Dependencies: `getPersistedSchemaVersion` and therefore the fork-floor filter, so
this probe inherits `fence-a-fork-lane-versions-are-invisible-to-the-fence` as
well. `schema-fence-probe.test.ts:85` is titled "ignores downstream rows when
probing the current direct-format fence", so that inheritance is deliberate here.

## What a test must construct

1. A `context.db` bootstrapped by this build, opened successfully.
2. On a second connection, rewrite `mc_format_marker` to `formatEpoch: 2` with a
   valid digest from `computeMarkerDigest`, leaving `schema_migrations` at 90.
3. Call `probeChildSpawnFence` with the still-live handle. Under the current code
   it returns `{ allowSpawn: true }`. That is the discriminating assertion.
4. Assert that the same database, reopened, is refused by `openDatabase`. The
   pair of assertions is the disagreement.

A second test should cover the double-count question: with a fence-refused open,
call `probeChildSpawnFence(openDatabase())` once and assert
`consecutiveFailures`. If the open's own refusal plus the probe's latch-read
count as one failure, the value is 1; if the composition double-counts, the
latching at threshold 2 arrives on the first spawn attempt rather than the
second.

## Investigation log

### Q: Who calls `probeChildSpawnFence`, and is a spawned child a writer?

- Sources examined: a repository-wide search for `probeChildSpawnFence`,
  `getChildSpawnFenceFailure`, `schema-fence-probe` and
  `STALE_CHILD_SPAWN_FAILURE` across `packages/`, excluding `node_modules` and
  `dist`. Then `child-session-spawn.ts:80-110` and
  `subagent-runner.ts:845-860`.
- Findings: two production callers, named above. `child-session-spawn.ts:82-84`
  states that every historian, recomp, dreamer and sidekick child passes through
  it. Those children are the writers described in the Part 5 scope map's 5b and
  5c sets; the probe itself does not write.
- Missing evidence: whether a child process opens `context.db` independently or
  inherits a handle. `subagent-runner.ts` spawns a Pi process, so it must reopen,
  and its own open would hit the full fence.
- Conclusion: resolved with answer. Two callers, both gating child creation. The
  OpenCode caller gates in-process work; the Pi caller gates a separate process
  that would independently face the full fence on its own open, which narrows
  that half of the exposure.

### Q: Is using the constant rather than the runtime ceiling deliberate?

- Sources examined: `schema-fence-probe.ts:2-6` (imports), `:84-85`,
  `storage-db.ts:213-225`.
- Findings: `getRuntimeLatestSupportedVersion` is not exported from
  `storage-db.ts`, so the probe could not call it without a change. That is
  suggestive of the constant being the only available choice rather than a
  decision. The effect is one-directional and safe: an operator override relaxes
  the open and not the spawn, so the probe is the stricter of the two.
- Missing evidence: any comment addressing it.
- Conclusion: needs human input. The effect is safe; the inconsistency means the
  two guards do not answer the same question, which matters for the `always`
  check in the record.
