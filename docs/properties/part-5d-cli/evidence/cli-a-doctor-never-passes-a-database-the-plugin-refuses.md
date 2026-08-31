# cli-a-doctor-never-passes-a-database-the-plugin-refuses

## Discovery trigger

The task asks whether the doctor's verdict can be wrong in the dangerous
direction — reporting healthy when it is not. Part 5a established that the plugin
fence has two arms, a version lane and a marker format epoch, and that
`storage-db.ts:663-666` calls the epoch the deciding signal. Checking which of the
two arms the doctor probes answered the question: only the version lane, and the
read-only open the doctor uses skips family classification entirely.

## Evidence trail

**The doctor's database check.**
`packages/cli/src/commands/doctor-opencode.ts:1242-1317`:

- `:1252` `const db = openExistingContextDatabase(dbPath, { readonly: true });`
- `:1257` `pass("Opened the shared DB with a supported schema");`
- `:1259-1263` reads `readStorageVersions(db)`, logs
  `formatStorageVersions(...)`, and runs `checkStorageVersionFence(...)`, failing
  on `alarm` and logging otherwise.
- `:1264-1278` runs `PRAGMA integrity_check`.
- `:1305-1311` catches `UnsupportedSchemaVersionError` and fails with the fence
  message.

The comment at `:1250-1251` states the intent: "The schema compatibility check
runs before integrity checks so a newer schema can never be reported healthy by
an older CLI." That is a documented guarantee and therefore a claim under test.

**What the read-only open actually checks.**
`packages/cli/src/lib/database-access.ts:117-180`:

- `:121` returns `null` when the file is absent.
- `:122-138` is the pre-open artifact gate — `classifyPreOpenFamily`, which
  refuses a pending reset marker, a hot rollback journal beside a nonempty main
  file, and orphan artifacts. It is inside `if (!options.readonly)`.
- `:139-140` opens the connection.
- `:143-153` is the family classification —
  `classifyDatabaseFormatFamily(inspectDatabaseForClassification(db, path),
  getExpectedDirectFormat())`, throwing unless the family is `current`. Also
  inside `if (!options.readonly)`.
- `:154-161` reads `getPersistedSchemaVersion(db)` and throws
  `UnsupportedSchemaVersionError` when it exceeds `LATEST_SUPPORTED_VERSION`.
  **Not** gated on `readonly`.

So a read-only open verifies the version lane and nothing else about format
identity.

**What the version probe compares.**
`packages/cli/src/lib/storage-versions.ts:33-58`. `StorageVersions` is two
numbers, `context_db_schema_version` and `plugin_supported_version` (`:18-23`),
populated by `readStorageVersions` (`:60-66`) from `getPersistedSchemaVersion` and
`LATEST_SUPPORTED_VERSION`. The three arms are: database greater than supported
(`:38-45`), database less than supported (`:46-53`), equal (`:54-57`, returning
`alarm: false` and "Format fence: context.db and this build are both v90"). No
marker, no epoch, no `application_id`, no `user_version`.

**What the plugin fence compares.** `refuseNewerSchemaFence`
(`packages/plugin/src/features/magic-context/storage-db.ts:651-681`) reads the
version lane and the marker, sets `persistedEpoch` from a `present` marker or `0`
otherwise (`:668`), and accepts only when
`persistedVersion <= latestSupportedVersion && persistedEpoch <=
DIRECT_FORMAT_EPOCH` (`:669`). The comment at `:663-666` says the epoch "is the
signal that actually distinguishes a database this build is too old to read from
one it must refuse". Separately, `openDatabase`'s accepted path calls the fence
again, and Part 5a's `fence-a-accepted-path-proves-vintage` records why: object-name
identity proves shape, never vintage.

**Negative confirmation.** A search across `packages/cli/src` at `HEAD` for
`formatEpoch`, `DIRECT_FORMAT_EPOCH`, and `readDirectFormatMarker` finds them only
in `doctor-repair-db.ts` (`:26-34` imports, `:343-357` restoring
`application_id` and `user_version` on a recovered image) and
`database-access.ts` (`:307-362`, inside the CLI-only family-state inspector used
by `doctor reset-db`). No doctor health check reads a format epoch.

**The Pi doctor has the same gap.** `doctor-pi.ts:597-601` performs the same
read-only open and `checkStorageVersionFence` call, and `:623-627` maps
`UnsupportedSchemaVersionError` the same way. So this is not an OpenCode-specific
defect, unlike `cli-a-opencode-doctor-exit-code-reflects-unresolved-failures`.

**What the user sees instead of a failure.** Part 5a's
`fence-a-refusal-is-a-null-return-not-a-throw` records that a fence refusal
reaches the caller as `null` plus a latched rejection record and a log line, not a
throw. So there is no crash to contradict the doctor's pass.

## Failure scenario

Two builds share one `context.db`. The newer one bumps `DIRECT_FORMAT_EPOCH` to 2
and stamps `mc_format_marker.format_epoch = 2` and `PRAGMA user_version = 2`,
without moving the migration lane — which is stable by construction, since
`LATEST_SUPPORTED_VERSION` is pinned to a retired-lane constant
(`storage-db.ts:98`, `migrations.ts:4-6`).

The older build's plugin refuses every open: `:669` fails on the epoch arm, `:678`
logs `storage fatal` and "Do not reset this database: a newer binary owns it", and
the caller receives `null`. The user notices Magic Context is not injecting
context and runs `magic-context doctor`.

Doctor output for the storage section:

```
Shared context DB exists at /home/u/.local/share/cortexkit/magic-context/context.db
✔ Opened the shared DB with a supported schema
  Storage versions: context_db_schema_version=90, plugin_supported_version=90
  Format fence: context.db and this build are both v90
✔ SQLite integrity_check: ok
  Shared DB row counts: tags=…, compartments=…, notes=…, claims=…, dream_runs=…
```

Two passes, a reassuring fence line naming the concept that is actually failing,
and correct row counts read from a database this build will never open in anger.
If nothing else fails, `:1430-1431` prints "Everything looks good! ✨" and exits 0.

The user has now been told by the diagnostic tool that storage is healthy, while
the plugin's log says `storage fatal` and names the remedy. The next thing they are
likely to try is `doctor reset-db`, which will quarantine the newer binary's
database — see `cli-a-reset-db-abandons-a-newer-format-family`. The false pass is
what routes them there.

## Timing windows and dependencies

No timing angle; the gap is static.

Dependencies worth recording:

- The read-only gating at `:122-138` and `:143-153` is deliberate and partly
  well-reasoned. The comment at `:123-127` explains the **write** path's choice to
  classify on the live connection rather than a whole-family temp copy, "which on
  a large store means reading and rewriting every byte of context.db before any
  work begins." That argument is about the pre-open artifact gate's cost model,
  not about skipping classification on reads, and the classification at `:143-153`
  runs on the already-open connection, so its cost on a read-only open would be
  pragma and schema reads only.
- `getExpectedDirectFormat` (`:241-245`) memoises `computeExpectedDirectFormat()`,
  so a doctor that classified would pay that once.
- The row counts at `:1281-1300` are read from the refused family and reported as
  informational. They are accurate about the file and misleading about the
  install, which sharpens rather than causes the problem.

## What a test must construct

1. Bootstrap a current-format `context.db` with this build.
2. Raise the marker epoch to 2 with a recomputed `marker_digest`, so the marker
   stays `present`, and set `PRAGMA user_version = 2` so the family is internally
   consistent. Leave `schema_migrations` alone, so
   `getPersistedSchemaVersion` still returns 90.
3. Assert the plugin would refuse: read the marker and confirm
   `formatEpoch > DIRECT_FORMAT_EPOCH`, and assert
   `classifyDatabaseFormatFamily` returns a family other than `current`. This
   pins the premise independently of the doctor.
4. Assert `openExistingContextDatabase(path, {readonly: true})` returns a live
   handle and does **not** throw. At `HEAD` this passes and is the mechanism.
5. Assert `checkStorageVersionFence(readStorageVersions(db))` returns
   `alarm: false`. At `HEAD` this passes and is the second half of the mechanism.
6. Assert the desired outcome: a doctor run against this database produces
   `failCount > 0` and no `pass("Opened the shared DB with a supported schema")`.
   At `HEAD` this fails. Same seam problem as
   `cli-a-opencode-doctor-exit-code-reflects-unresolved-failures`: the OpenCode
   doctor has no `deps` object, so this needs either a seam or module mocks. The
   Pi doctor does have one (`doctor-pi.ts:107-131`), so step 6 is cheapest to
   write there first, and the gap is present in both.
7. Route-A variant: corrupt only `marker_digest` so the marker reads `malformed`.
   Assert the same expectations. This case is worth having separately because
   `refuseNewerSchemaFence` collapses a non-`present` marker to epoch `0` at
   `:668` and therefore does **not** fire — Part 5a's
   `fence-a-malformed-marker-reads-as-epoch-zero` — so the refusal comes from the
   family classifier instead, and the doctor misses both.

## Investigation log

### Q: Should the read-only open run the family classification?

- Sources examined: `database-access.ts:113-116` (the function's doc comment),
  `:117-180`, `:122-138` and its rationale comment at `:123-127`, `:143-153`,
  `:154-161`, `:241-245` (`getExpectedDirectFormat` memoisation);
  `storage-format-epoch.ts:926-928` (`inspectDatabaseForClassification` declared
  read-only: "pragma reads and schema reads only, so refusal paths never mutate
  the family"); `doctor-opencode.ts:1250-1251` (the doctor's stated intent).
- Findings: the classification is documented as read-only and operates on an
  already-open connection, so running it on a read-only open costs a handful of
  pragma and schema reads plus one memoised manifest computation. The cost
  argument in `:123-127` applies to the pre-open artifact gate's whole-family temp
  copy, not to this. The reason for the `!options.readonly` gate on `:143-153` is
  more likely that a read-only open is used by diagnostics that want to inspect a
  database *whatever* its family — `doctor-repair-db.ts:127-145` and
  `database-access.ts:307-362` both deliberately classify without refusing, and a
  doctor that threw on an unsupported family would lose the ability to report row
  counts and integrity for it. If so, the right fix is not to make the read-only
  open refuse but to have the doctor classify explicitly and `fail()` on a
  non-`current` verdict while still reporting what it can.
- Missing evidence: no comment explains the `readonly` gate on `:143-153`
  specifically. The doc at `:113-116` says "Applies the shared schema fence
  immediately after opening context.db. No query or migration write may run until
  this check accepts the persisted version" — which describes the version check
  and is silent about the family classification, so the doc is arguably already
  describing only what the read path does.
- Conclusion: needs human input. Two shapes: refuse on read-only opens (simple,
  but breaks diagnostics that need to inspect a refused family), or add an
  explicit classification check to each doctor's storage section (more code, keeps
  diagnostics working, and is what the doctors' own purpose calls for).

### Q: Should `StorageVersions` grow a `context_db_format_epoch` field?

- Sources examined: `storage-versions.ts:1-11` (the module doc), `:18-23`,
  `:33-58`, `:60-66`, `:68-74` (`formatStorageVersions`);
  `doctor-opencode.ts:1259-1263`, `doctor-pi.ts:597-601`.
- Findings: the module doc at `:8-11` says the field names are snake_case "to
  mirror the `storage_versions` block of the mc-module status envelope, so fleet
  probes parse one shape across both surfaces." So the shape is a cross-surface
  contract, and adding a field means changing that envelope too, not just this
  file. That is a real constraint and the reason this is a schema decision rather
  than a local edit. It is also the strongest argument **for** doing it: if fleet
  probes read `storage_versions` to decide whether an install is fenced, they are
  currently reading a shape that cannot express the deciding signal.
- Missing evidence: the mc-module status envelope's definition was not read; it
  is outside 5d's footprint and outside the TypeScript packages.
- Conclusion: unresolved, needs a schema decision on the status envelope, taken
  jointly with the Rust side. Flagged for the synthesis pass because it touches
  Part 3's territory.
