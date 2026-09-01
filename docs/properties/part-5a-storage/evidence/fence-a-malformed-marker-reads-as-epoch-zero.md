# fence-a-malformed-marker-reads-as-epoch-zero

## Discovery trigger

`storage-db.ts:663-666` says the marker's format epoch, not the migration
version, is "the signal that actually distinguishes a database this build is too
old to read from one it must refuse". That makes the epoch arm the load-bearing
half of the fence. Reading how `persistedEpoch` is computed showed it collapses
every non-`present` marker status to `0`, which is the smallest possible value
and therefore always passes.

## Evidence trail

`packages/plugin/src/features/magic-context/storage-db.ts:667-671`:

```
    const marker = readDirectFormatMarker(db);
    const persistedEpoch = marker.status === "present" ? marker.marker.formatEpoch : 0;
    if (persistedVersion <= latestSupportedVersion && persistedEpoch <= DIRECT_FORMAT_EPOCH) {
        return false;
    }
```

The same collapse is repeated at `:690-691` inside `recordFormatRefusal`.

`DIRECT_FORMAT_EPOCH` is `1` (`storage-format-epoch.ts:45`), so `0 <= 1` holds
and the epoch conjunct is vacuously true whenever the marker is not `present`.

`readDirectFormatMarker` (`storage-format-epoch.ts:186-234`) returns three
statuses. The `malformed` cases are:

- `:199-203` the marker table exists but is unreadable, reason "marker table is
  unreadable: <error>" at `:201`.
- `:204` zero rows, "marker table has no row".
- `:205-207` more than one row.
- `:217-220` `!Number.isSafeInteger(formatEpoch) || formatEpoch < 1`, "marker
  format epoch is invalid" at `:219`.
- `:222-224` invalid incarnation ID.
- `:225-227` manifest digest not matching `SHA256_HEX_PATTERN`.
- `:228-230` `createdAtMs` not a safe integer.
- `:231-232` `computeMarkerDigest(withoutDigest) !== storedDigest`, "marker
  digest mismatch".

`present` is returned at `:234`.

`absent` (`:190`) is the legacy case and must read as `0`: a pre-marker database
has no epoch, and treating that as newer would refuse every legacy family
through the fence arm rather than the format arm, which would change the guidance
the user gets. So the collapse is correct for `absent`.

`malformed` is different. The digest is computed over
`FORMAT_MARKER_DIGEST_PROTOCOL` plus `application_id`, `format_epoch`,
`database_incarnation_id`, `component_manifest_digest` and `created_at_ms`; the
Rust mirror at `crates/mc-store/src/sqlite_runtime.rs:170-184` shows the same
line encoding. A newer binary that adds a digested field, changes the protocol
string, or widens the epoch encoding produces a row this build reads as
`malformed` at `storage-format-epoch.ts:231`. At that moment the database is
strictly newer and the epoch arm reads it as `0`.

The only remaining catch is the version arm. Whether it fires depends on whether
the newer binary also advanced `schema_migrations`. `storage-db.ts:664-665`
describes the fence row as "a constant pinned to the retired migration lane, so
it only moves on a breaking format change", which is exactly the case where the
marker encoding would also change; but a marker-only change is precisely what an
epoch bump is for, and `DIRECT_FORMAT_FENCE_MIGRATION_VERSION` is derived from a
retired head (`migrations.ts:4-6`), so it is not expected to move per release.

## Failure scenario

A newer generation ships marker protocol v2. Its databases carry
`format_epoch = 2` and a v2 digest, with `schema_migrations` still at 90 because
the retired lane did not move. An older binary opens the file:

1. `readDirectFormatMarker` computes a v1 digest over the v1 field set, compares
   against the stored v2 digest, and returns `malformed` at
   `storage-format-epoch.ts:231`.
2. `classifyDatabaseFormatFamily` returns family `malformed-marker` at
   `storage-format-epoch.ts:190-192`, its first branch.
3. `openDirectDatabase:765-767` sees a non-`current` family and calls
   `bootstrapUnderWriteLock`, which rechecks and returns without writing because
   the family is not `pristine` (`:628`).
4. `:769` calls `recordFormatRefusal`, which calls the fence at `:689`. The
   fence sees version 90 <= 90 and epoch 0 <= 1, returns `false`.
5. The refusal is recorded as a **format** refusal, not a fence rejection, and
   the guidance recommends `doctor reset-db`.

The database is not written, so the immediate safety property holds. The harm is
misclassification: the user is told the family is not the supported format and is
pointed at the destructive command, when the true cause is that a newer binary
owns it. That second half is recorded separately as
`fence-a-unclassifiable-family-must-not-get-reset-guidance`.

## Timing windows and dependencies

No timing window; this is a pure classification defect evaluated on every open.

Dependencies: `readDirectFormatMarker`'s status enum, `DIRECT_FORMAT_EPOCH`, and
the digest protocol shared with `crates/mc-store/src/sqlite_runtime.rs:20`. The
cross-runtime fixture
`packages/plugin/src/features/magic-context/fixtures/direct-format-vocabulary-v1.json`
pins the v1 encoding on both sides, so a protocol bump is a coordinated change
whose transition period is exactly this scenario.

## What a test must construct

A marker that is newer **and** unparseable, with the version lane left at the
supported value so it cannot rescue the fence:

1. Create `context.db` with the `mc_format_marker` DDL as
   `storage-db.test.ts:338-347` does.
2. Insert a row with `format_epoch = 2` and a **deliberately wrong**
   `marker_digest`, for example `"0".repeat(64)`. Do not use
   `computeMarkerDigest`; the existing tests at `:350-358` and `:449-457` use it
   and therefore produce a `present` marker.
3. Insert `schema_migrations` version `LATEST_SUPPORTED_VERSION` exactly.
4. Assert the open returns `null` and the file digest is unchanged, which should
   pass.
5. Assert `getSchemaFenceRejection()` is non-null. Under the current code it
   will be `null` and `getFormatRefusal()?.family` will be
   `"malformed-marker"`. That is the discriminating assertion.

A second case should cover `formatEpoch: 0` in the row, which
`storage-format-epoch.ts:216-221` rejects as invalid, to confirm an out-of-range
epoch also collapses to `0` rather than being read literally.

## Investigation log

### Q: Is `absent` versus `malformed` a deliberate merge?

- Sources examined: `storage-db.ts:662-668` (the comment block explaining why
  the marker epoch is the decisive signal), `:667-668` (the collapse),
  `storage-format-epoch.ts:186-234` (all three statuses),
  `:190-192` (the `malformed-marker` family branch).
- Findings: the comment at `:662-666` explains why the epoch matters and why
  reset guidance for a too-old database would be wrong. It does not mention the
  `malformed` case at all. The ternary at `:668` is written as a single
  `status === "present"` test, which reads as "default to the oldest value when
  we have no marker" rather than as a considered decision about unparseable
  markers. `classifyDatabaseFormatFamily` treats `malformed` as its own family,
  distinct from `absent`, which shows the codebase does distinguish them
  elsewhere.
- Missing evidence: any comment, test, or doc addressing an unparseable marker.
  A search of `storage-db.test.ts` for a wrong-digest fixture found none; all
  marker fixtures use `computeMarkerDigest`.
- Conclusion: needs human input. The distinction exists in the classifier and
  not in the fence, which is consistent with an oversight, but the safe
  behaviour for `malformed` is a design question: refusing as newer would also
  misclassify a genuinely corrupt marker as a newer database.

### Q: Would the version arm catch a marker-protocol bump in practice?

- Sources examined: `migrations.ts:1-6`, `storage-db.ts:664-665`,
  `storage-session-runtime-schema.ts:120-146`.
- Findings: `DIRECT_FORMAT_FENCE_MIGRATION_VERSION` is
  `DIRECT_FORMAT_SUPERSEDED_MIGRATION_HEAD + 1` where the head is the retired
  legacy lane's last version, 89. `storage-db.ts:664-665` calls it "a constant
  pinned to the retired migration lane, so it only moves on a breaking format
  change". `stampDirectFormatFence` inserts exactly that one row
  (`storage-session-runtime-schema.ts:137-145`). So the version arm moves only
  when the team chooses to move it, and the epoch arm exists specifically so it
  does not have to.
- Missing evidence: the release policy for bumping the epoch versus the fence
  version. Not in the files read.
- Conclusion: unresolved, needs the release policy. The code's own comments
  imply the epoch is the arm expected to move, which is the arm this record
  shows can be defeated.
