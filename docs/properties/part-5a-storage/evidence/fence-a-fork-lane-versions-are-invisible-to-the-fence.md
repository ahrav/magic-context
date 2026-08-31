# fence-a-fork-lane-versions-are-invisible-to-the-fence

## Discovery trigger

`storage-db.ts:648-650` claims "Every family reaches this check, accepted or
not". Reading what the check actually reads showed the version lane it consults
is bounded, and the bound excludes a range the codebase deliberately reserves for
downstream forks.

## Evidence trail

`packages/plugin/src/features/magic-context/storage-db.ts:183-196`:

```
export function getPersistedSchemaVersion(db: Database): number {
    const hasMigrationsTable = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
        .get();
    if (!hasMigrationsTable) {
        return 0;
    }
    const row = db
        .prepare(
            "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations WHERE version < ?",
        )
        .get(FORK_MIGRATION_VERSION_FLOOR) as { version: number } | undefined;
    return row?.version ?? 0;
}
```

The bound is `FORK_MIGRATION_VERSION_FLOOR`, imported at `:34` from
`migrations.ts`, where it is:

```
/** First version reserved for downstream migrations; upstream versions stay below it. */
export const FORK_MIGRATION_VERSION_FLOOR = 10_000;
```

So the filter is deliberate and documented, and its purpose is to keep a fork's
own migration history from being read as upstream vintage. That is a sensible
goal: without it, a fork recording version 10_001 would make every upstream
binary refuse the database.

The consequence is that the fence has no reading of fork vintage at all. A
database at upstream 90 with fork rows at 10_001 through 10_050 presents
`persistedVersion = 90` to `refuseNewerSchemaFence:658`, identical to a
freshly bootstrapped database.

The reservation is enforced in the other direction too.
`storage-session-runtime-schema.ts:130-132`:

```
    if (DIRECT_FORMAT_FENCE_MIGRATION_VERSION >= FORK_MIGRATION_VERSION_FLOOR) {
        throw new Error("direct-format fence version must stay below the downstream floor");
    }
```

So the upstream fence row can never drift into fork space. The two halves are
consistent: upstream owns below 10_000, forks own above, and the fence reads only
upstream.

`schema-fence-probe.test.ts:85` is titled "ignores downstream rows when probing
the current direct-format fence", which confirms the filter is intended
behaviour and is covered at the child-spawn probe. I found no equivalent test at
`openDatabase`.

The `schema_migrations` table itself is created at
`storage-session-runtime-schema.ts:757-761` and listed among the registered
objects at `:100`, so it is part of the exact object inventory that
classification compares. Its *contents* above the floor are not.

The remaining defences against a newer fork database are therefore:

- The marker `formatEpoch`, compared at `storage-db.ts:669` and again during
  classification at `storage-format-epoch.ts:212-217`.
- The `componentManifestDigest`, compared at
  `storage-format-epoch.ts:218-222`.
- The exact object-name inventory at `storage-format-epoch.ts:236-241`, which
  would catch a fork that added or removed a table.

A fork that adds a table trips the inventory and gets an `unsupported` family. A
fork that only adds rows, alters data, or changes column semantics inside the
existing object set trips nothing, unless it also bumps the epoch or the digest.

## Failure scenario

A downstream fork of Magic Context records its own migrations from 10_000 up, as
`migrations.ts:1` invites. One of those migrations changes the meaning of a column
in an existing table without adding or removing any object, and does not bump the
marker epoch, because the epoch is described at `storage-db.ts:664-665` as moving
only "on a breaking format change" and the fork does not consider its change
breaking for its own purposes.

An upstream binary then opens that database. Classification returns `current`:
same objects, same `application_id`, same `user_version`, same epoch, and the
manifest digest matches because the digest is computed from the registered
component manifest (`storage-current-schema.ts` via `computeExpectedDirectFormat`
at `storage-db.ts:600-603`), which the fork did not change. The fence reads
version 90 and epoch 1 and admits. The upstream binary then queries the column
with upstream semantics.

## Timing windows and dependencies

No timing window.

Dependencies: the fork's own discipline. This property's guarantee is conditional
in a way most are not: it holds if forks bump the epoch or the digest when they
change semantics, and fails if they do not. Nothing in this repository can
enforce a fork's behaviour, so the honest form of the property is the disjunction
recorded in the `Check` line: either the fence's lane is the only lane, or a
second lane exists and is compared separately.

## What a test must construct

1. Bootstrap a `context.db` with this build.
2. Insert `schema_migrations` rows at `FORK_MIGRATION_VERSION_FLOOR` and above.
3. Assert `getPersistedSchemaVersion(db)` still returns
   `LATEST_SUPPORTED_VERSION`. This documents the filter at the fence, mirroring
   `schema-fence-probe.test.ts:85` at the open path.
4. Assert `openDatabase(dbPath)` succeeds and `getSchemaFenceRejection()` is
   `null`. This is the finding, asserted as current behaviour rather than as
   correct behaviour.

A coverage check in the sense of `METHOD.md:79-86` would assert the independent
preconditions rather than the violation: that a fork-space row exists, and that
the marker epoch equals this build's, and that the manifest digest matches. Those
three jointly create the window, and asserting them fires on a correct
implementation too.

## Investigation log

### Q: Is a fork expected to bump the epoch or the digest?

- Sources examined: `migrations.ts:1-6`, `storage-db.ts:663-666`,
  `storage-session-runtime-schema.ts:120-146`,
  `storage-format-epoch.ts:206-247`.
- Findings: nothing states an expectation. `storage-db.ts:664-665` describes the
  fence row as moving "only on a breaking format change" and the epoch as "the
  signal that actually distinguishes a database this build is too old to read
  from one it must refuse", both framed from the upstream perspective. The
  manifest digest is derived from the build's registered component manifest, so a
  fork that adds a schema component changes it automatically, which is a useful
  accidental defence. A fork that changes only data semantics does not.
- Missing evidence: any fork-facing documentation. `docs/migration-version-lanes.md`
  exists and Part 3 quotes it
  (`docs/properties/part-3-store-core/_lenses/lens-a-sqlite-durability.md:529-539`,
  `:557-563`); I did not read it in this pass and it is the most likely place for
  such an expectation.
- Conclusion: unresolved, needs a read of `docs/migration-version-lanes.md`.
  If it states the expectation, this becomes a contract-vs-code lead about
  whether the code can detect a violation of it; if it does not, it is a gap in
  the fork contract.

### Q: Is the filter's purpose defensible?

- Sources examined: `migrations.ts:1-2`, `getPersistedSchemaVersion:192-194`,
  `storage-session-runtime-schema.ts:130-132`,
  `schema-fence-probe.test.ts:85`.
- Findings: yes. Without the filter, any fork row would make every upstream
  binary refuse, which would make the two lanes mutually exclusive rather than
  layered. The floor at 10_000 leaves 9,910 versions of headroom above the
  retired head of 89, and the assertion at `:130-132` prevents upstream drift
  into fork space. The design is coherent.
- Missing evidence: none.
- Conclusion: resolved with answer. The filter is correct for its stated purpose.
  The finding is not that the filter is wrong but that the fence's completeness
  claim at `storage-db.ts:648-650` is about families reached, not lanes read, and
  a reader can easily take it for the stronger claim.

### Q: Does the child-spawn probe inherit the same blindness?

- Sources examined: `schema-fence-probe.ts:83`, `storage-db.ts:183-196`,
  `schema-fence-probe.test.ts:85`.
- Findings: yes, it calls the same `getPersistedSchemaVersion`. The test title at
  `:85` shows this is intended there as well.
- Missing evidence: none.
- Conclusion: resolved with answer. Both fences read the same bounded lane, so
  the blindness is uniform rather than a disagreement between them.

### Q: Can anything in the codebase lower the recorded fence row?

- Sources examined: every `schema_migrations` reference in `packages/plugin/src`
  and `packages/cli/src` outside `*.test.ts`. Six sites:
  `storage-db.ts:185` and `:192` (the fence's reads),
  `storage-claim-applicability-schema.ts:628`,
  `storage-session-runtime-schema.ts:100` (the registered-object list), `:122`
  (the contract comment), `:132` (the fence-row insert) and `:757` (the DDL), and
  `shared/rpc-types.ts:216` (a doc comment describing a reported field as the
  "Persisted schema version of context.db (MAX of schema_migrations)").
- Findings: exactly one site deletes.
  `storage-claim-applicability-schema.ts:628` is
  `db.prepare("DELETE FROM schema_migrations WHERE version >= 85").run()`, the
  last statement of `dropClaimApplicabilityObjectsForTests` (`:614-629`). The
  fence row is version 90, so that statement removes it and drops
  `getPersistedSchemaVersion` from 90 to whatever remains below 85, which for a
  direct-format database is 0. The function's own comment at `:615-618` explains
  it is the `migrations-v82.test.ts` fixture path. A search for callers of that
  function found none outside tests; the eleven production importers of the module
  take `APPLICABILITY_BASELINE_STREAM_KEY`, `SOURCE_TRUST_CLASSES` or the
  `SourceTrustClass` type instead.
- Missing evidence: whether tree-shaking removes it from the shipped bundle. It
  is an ordinary named export from a production module, so a bundler could keep
  it if anything reachable references it, and nothing does.
- Conclusion: resolved with answer for reachability: no production caller, so the
  recorded fence row cannot be lowered in a shipped install. The residual note is
  that a destructive statement against the fence's own input ships as an
  ordinary export from a non-test file, which is why this record's check is
  phrased about the lane's contents rather than assuming the row is immutable.
