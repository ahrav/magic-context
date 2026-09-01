# fence-a-older-binary-never-writes-a-newer-database

## Discovery trigger

The Part 5 scope map ranks `storage-db.ts`'s newer-schema fence the single
highest-risk item in Part 5 because it is "the only thing stopping an older
binary writing a newer database", and `storage-db.ts:711-713` has already
foreclosed repair by refusing to migrate. The first question is therefore the
plainest one: when the fence fires, is the database genuinely untouched?

## Evidence trail

The fence is `refuseNewerSchemaFence` at
`packages/plugin/src/features/magic-context/storage-db.ts:651-681`.

The accept condition is one conjunction at `:669`:

```
if (persistedVersion <= latestSupportedVersion && persistedEpoch <= DIRECT_FORMAT_EPOCH) {
    return false;
}
```

`persistedVersion` comes from `getPersistedSchemaVersion` (`:183-196`), which
returns `0` when `schema_migrations` is absent (`:185-189`) and otherwise
`MAX(version) ... WHERE version < FORK_MIGRATION_VERSION_FLOOR` (`:192-194`).
`persistedEpoch` comes from the marker at `:667-668`.

`latestSupportedVersion` resolves through `getRuntimeLatestSupportedVersion`
(`:213-225`) to `LATEST_SUPPORTED_VERSION` (`:98`), which is
`DIRECT_FORMAT_FENCE_MIGRATION_VERSION` = `89 + 1` = 90 (`migrations.ts:4`,
`:6`). `DIRECT_FORMAT_EPOCH` is `1` (`storage-format-epoch.ts:45`).

The ordering inside the open is what makes the no-write claim credible.
`openDirectDatabase` (`:729-794`):

1. `:737-741` runs the SQLite runtime gate before any connection exists.
2. `:743-750` runs `refusePreOpenFamily`, which inspects on-disk artifacts
   before SQLite can recover an orphan WAL. The comment at `:715-718` states
   that reason.
3. `:753` constructs the connection.
4. `:758-759` sets `busy_timeout` and `foreign_keys` only.
5. `:761-767` classifies, and bootstraps only if the family is not `current`.
6. `:768-772` refuses a non-`current` family and closes.
7. `:777-780` runs the fence on the accepted path and closes on refusal.
8. `:782` is the first `PRAGMA journal_mode=WAL`, deliberately after the verdict.

So on the fence path the only statements executed against the file are two
PRAGMAs, the classification reads, and possibly `bootstrapUnderWriteLock`. That
last one is the only writer, and `:628` returns without writing unless the
family is still `pristine` after the recheck under `BEGIN IMMEDIATE` (`:639`). A
database carrying a newer fence is not pristine, so it is not written.

`storage-db.test.ts:421-476` and `:478-497` both assert
`expect(fileDigest(dbPath)).toBe(before)` after the refused open, which is the
existing evidence for the no-write half.

## Failure scenario

An install runs a newer plugin generation, which stamps `schema_migrations`
version 91 or a marker with `format_epoch` 2. A pinned or stale older install
then opens the same `context.db`. If the fence's conjunction at `:669` were
inverted, or if WAL were enabled before the verdict, the older binary would
either write application rows against a schema it misreads, or truncate and
rewrite the WAL of a family it does not own. Because `:711-713` states there is
no migration lane, nothing walks the damage forward; the recovery is
`doctor reset-db`, which discards the newer binary's data.

## Timing windows and dependencies

The window is `:753-780`. Two sub-windows matter.

First, `bootstrapUnderWriteLock` at `:766` takes `BEGIN IMMEDIATE` and creates a
`-journal` file on this very connection. `:622-626` filters `journal` out of the
artifact inventory precisely so the lock holder does not misread its own journal
as an orphan artifact. A digest assertion on `context.db-journal` would
therefore be wrong; the assertion must cover the main file plus `-wal` and
`-shm`.

Second, the fence reads the version lane and the marker outside any transaction,
on a connection with `busy_timeout=5000` (`:758`). A concurrent newer binary
completing its own bootstrap between `:761` and `:777` is possible; the fence's
placement after classification means it reads the post-bootstrap state.

Dependencies: `storage-format-epoch.ts` for the marker and classification,
`migrations.ts` for both constants, `storage-current-schema.ts` for the expected
object inventory via `computeExpectedDirectFormat` (`:598-603`).

## What a test must construct

1. A `context.db` bootstrapped by this build, so classification returns
   `current`. `openDatabase(dbPath)` then `closeDatabase()` does it.
2. Digest the main file, `-wal` and `-shm`, and record which exist.
3. Advance the vintage by exactly one axis, in two separate cases: insert a
   `schema_migrations` row at `LATEST_SUPPORTED_VERSION + 1`; or rewrite
   `mc_format_marker` with `formatEpoch: 2` and a matching digest from
   `buildDirectFormatMarker` plus `computeMarkerDigest`.
4. Reopen. Assert `null`, assert `getSchemaFenceRejection()` non-null, assert
   `getFormatRefusal()` null, and assert all three digests unchanged plus no
   newly created `-wal` or `-shm`.

The epoch-only case is the one the existing tests do not isolate:
`storage-db.test.ts:432-459` bumps the epoch **and** leaves the version row at
the supported value, which is close, but `:352-372` is the case that pairs a
newer epoch with an equal version and it asserts only the latch, not the digest
of the sidecars.

## Investigation log

### Q: Does any refusal path leave a `-wal` file that did not previously exist?

- Sources examined: `storage-db.ts:743-750` (`refusePreOpenFamily`), `:753-782`
  (connection construction through the first WAL pragma),
  `storage-db.test.ts:373-396` and `:398-420` (the two unsupported-family
  tests), `:421-476` and `:478-497` (the two fence tests).
- Findings: the unsupported-family test asserts
  `expect(existsSync(\`${dbPath}-wal\`)).toBe(false)` at `:394`, and the
  WAL-state test asserts both main and WAL digests unchanged at `:414-415`.
  Neither fence test makes an existence or sidecar-digest assertion. Reading the
  code, `PRAGMA journal_mode=WAL` at `:782` is unreachable on the fence path
  because `:779` returns first, so no `-wal` should be created. But
  `bootstrapUnderWriteLock` at `:766` runs before the fence and does take a write
  lock, creating `-journal`.
- Missing evidence: an executed assertion. I did not run the suite.
- Conclusion: unresolved, needs a digest-and-existence assertion over
  `context.db`, `-wal` and `-shm` on both fence cases. The code reading says no
  `-wal` is created; that is inference, not observation.

### Q: Can `bootstrapUnderWriteLock` write to a newer database?

- Sources examined: `storage-db.ts:611-641`, `storage-format-epoch.ts:186-247`.
- Findings: `:765` calls it only when the family is not `current`, and `:628`
  returns early unless the recheck yields `pristine`. A database carrying a
  newer fence row and a valid marker classifies as `current` (so bootstrap is
  skipped) or as `unsupported`/`malformed-marker` (so `:628` returns). A
  pristine file has no fence row to be newer.
- Missing evidence: none for this question.
- Conclusion: resolved with answer. `bootstrapUnderWriteLock` cannot write a
  newer database, because every path to a write requires the post-lock
  classification to be `pristine`.
