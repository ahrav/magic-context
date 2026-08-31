# fence-a-accepted-path-proves-vintage

## Discovery trigger

The task names `storage-db.ts:774` as a stated detection blind spot. Reading it
in context showed the opposite: `:773-776` is the rationale for a second fence
call that **closes** the blind spot, and the blind spot itself belongs to
object-name classification, not to the fence.

## Evidence trail

`packages/plugin/src/features/magic-context/storage-db.ts:772-780`:

```
        }
        // The fence is checked on the accepted path too, not only on refusal.
        // Object-name identity cannot see a fence a newer binary moved without
        // renaming anything, so skipping this here would leave the one family
        // that reaches real queries as the only one never proving its vintage.
        if (refuseNewerSchemaFence(db, dbPath, latestSupportedVersion)) {
            closeQuietly(db);
            return null;
        }
```

`:774` is the second line of a four-line comment. The comment spans `:773-776`
and the code it justifies is `:777-780`.

The blind spot it names is real and belongs to
`classifyDatabaseFormatFamily` (`storage-format-epoch.ts:188-247`). That function
compares:

- the marker status and, when present, `formatEpoch` against
  `expected.formatEpoch` (`:212-217`) and `componentManifestDigest` against the
  build's manifest (`:218-222`);
- `application_id` (`:224-228`) and `user_version` (`:229-233`);
- an exact two-way object-name set difference, missing objects at `:236-238` and
  unregistered objects at `:239-241`;
- a pending reset marker artifact (`:242-244`).

`:246` returns `family: "current"` when there are no reasons. So a newer binary
that changes semantics inside an identical object set, with the same
`application_id`, the same `user_version`, the same manifest digest and the same
marker epoch, classifies as `current`. Nothing in that list is a vintage counter
except the epoch and the digest.

That is why `:777` exists. It re-reads the version lane
(`getPersistedSchemaVersion`, `:183-196`) and the marker epoch (`:667-668`) after
classification has already said `current`.

The doc comment on the fence itself makes the same point at `:648-650`: "Every
family reaches this check, accepted or not: the exact object inventory proves
shape, never vintage, so a database whose objects match this build can still
carry a fence only a newer binary understands."

The dedicated test is `storage-db.test.ts:478-497`, titled "#when an
exactly-current family carries a newer fence #then still reports a fence
rejection". Its inline comment at `:481-484` restates the reasoning: "The fence
row is then the only evidence that a newer binary owns the family, which is
exactly what an object-name inventory cannot see." The test bootstraps with this
build (`:485`), closes (`:486`), inserts version `LATEST_SUPPORTED_VERSION + 1`
(`:488-492`), reopens and asserts `null` plus the exact latch pair (`:494-496`).

## Failure scenario

Delete the `:777-780` block. A newer binary's database whose object set is
unchanged, which is the common case for a release that changes only column
semantics or a value encoding, would then classify as `current` at `:765`, skip
the format refusal at `:768`, enable WAL at `:782`, pass the connection contract
at `:784`, and reach `ensureContextStoreUuid` at `:788` and
`finishDatabaseOpen` at `:789`. `finishDatabaseOpen` writes:
`healWedgedChannel2Claims` (`:553`, an `UPDATE` on `session_meta`),
`setToolDefinitionDatabase` and `loadToolDefinitionMeasurements` (`:559-560`),
and `restrictDatabaseFilePermissions` (`:563`). So the older binary would begin
mutating a family a newer binary owns, starting with a Channel-2 lease heal.

## Timing windows and dependencies

The fence at `:777` reads outside any transaction. `bootstrapUnderWriteLock`
(`:611-641`) is the only part of the open that takes `BEGIN IMMEDIATE`, and it
runs earlier at `:766`. So between the fence's read at `:777` and the first
application query after `finishDatabaseOpen`, a concurrent newer binary could
complete its own vintage bump. The window includes `PRAGMA journal_mode=WAL`
(`:782`), `applySqliteTuningPragmas` (`:783`),
`assertSqliteConnectionContract` (`:784-787`) and `ensureContextStoreUuid`
(`:788`), the last of which writes.

`busy_timeout=5000` (`:758`) is the only contention control. The comment at
`:756-757` explains it must precede any file-level statement so a cold-open loser
waits for the winner's bootstrap commit rather than throwing `SQLITE_BUSY`.

## What a test must construct

The existing test covers the version arm. Two gaps remain.

1. **Epoch arm on a `current` family.** Bootstrap with this build, close, then
   rewrite the `mc_format_marker` row to `formatEpoch: 2` with a digest computed
   by `computeMarkerDigest` so the marker stays `present`. Note that this makes
   classification report an epoch mismatch at
   `storage-format-epoch.ts:212-217`, so the family becomes `unsupported` and the
   refusal arrives via `recordFormatRefusal:689` rather than via `:777`. That
   asymmetry is worth asserting explicitly: the epoch is visible to
   classification, the version lane is not, which is why the version lane is the
   case `:777` uniquely catches.
2. **The split-read window.** Bootstrap, then hold the open at `:777` while a
   second connection stamps a newer fence row, then let the open complete.
   Assert whether the process proceeds to write. This needs a test seam inside
   `openDirectDatabase` that does not exist.

## Investigation log

### Q: Is `:774` an admission of an undetectable case, or a rationale?

- Sources examined: `storage-db.ts:773-780`, `:648-650`,
  `storage-format-epoch.ts:188-247`, `storage-db.test.ts:478-497`.
- Findings: it is a rationale. The sentence is conditional — "**skipping this
  here would leave** the one family that reaches real queries as the only one
  never proving its vintage" — and the code immediately below performs the check
  that avoids the described outcome. The undetectable thing is a vintage change
  that renames no object, and it is undetectable **to classification**, not to
  the fence.
- Missing evidence: none. The comment, the fence doc at `:648-650`, and the
  dedicated test all agree.
- Conclusion: resolved with answer. `:774` names a limitation of object-name
  identity and the surrounding code compensates for it. The residual blind spots
  are elsewhere: the epoch collapse
  (`fence-a-malformed-marker-reads-as-epoch-zero`) and the fork-lane filter
  (`fence-a-fork-lane-versions-are-invisible-to-the-fence`).

### Q: Is the unfenced read window at `:777` worth closing?

- Sources examined: `storage-db.ts:753-789` (the whole post-connection
  sequence), `:611-641` (the only `BEGIN IMMEDIATE`), `:756-757` (the
  busy_timeout rationale), `:548-572` (`finishDatabaseOpen` and its writes).
- Findings: the fence read and the first write are separated by six statements,
  two of which (`ensureContextStoreUuid` at `:788` and
  `healWedgedChannel2Claims` at `:553`) write. A newer binary completing a
  vintage bump inside that window would be missed. Whether that is reachable
  depends on how a newer binary bumps vintage: if it does so during its own
  bootstrap under `BEGIN IMMEDIATE`, the two opens serialise on the write lock
  and the loser rechecks at `:640`. If a newer binary bumps vintage on an
  already-bootstrapped database, as a migration would, there is no lock
  serialising it against this read.
- Missing evidence: whether any shipped path bumps the fence row or marker epoch
  on an existing database. `stampDirectFormatFence` is called only from
  `createSessionRuntimeSchema` (`storage-session-runtime-schema.ts:149-152`),
  which is bootstrap. I did not find an update path.
- Conclusion: needs human input. If vintage only ever changes at bootstrap, the
  window is closed by the write lock and the concern is theoretical. If a future
  release bumps vintage in place, it is not.

### Q: Does the fence at `:777` run before any write on the accepted path?

- Sources examined: `storage-db.ts:777-789`, `:548-572`, `:495-503`,
  `:784-787`.
- Findings: yes for application writes. Between `:777` and the first write, the
  statements are `PRAGMA journal_mode=WAL` (`:782`, which writes the WAL header
  but not application data), `applySqliteTuningPragmas` (`:783`, three
  connection-scoped PRAGMAs), and `assertSqliteConnectionContract` (`:784`,
  reads). The first application write is `ensureContextStoreUuid` at `:788`.
- Missing evidence: whether `PRAGMA journal_mode=WAL` on a database that is
  already in WAL mode is a no-op at the byte level. The unsupported-family WAL
  test at `storage-db.test.ts:398-420` asserts the WAL digest unchanged, but that
  path never reaches `:782`.
- Conclusion: resolved with answer for application writes. The `journal_mode`
  pragma's byte-level effect on an already-WAL database is unresolved and only
  matters for the refusal paths, which do not reach `:782`.
