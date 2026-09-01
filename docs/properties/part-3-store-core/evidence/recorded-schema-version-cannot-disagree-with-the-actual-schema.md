# recorded-schema-version-cannot-disagree-with-the-actual-schema

## Discovery trigger

`docs/migration-version-lanes.md:9-20` defines format identity as six things
including "an exact `main.sqlite_schema` inventory", and says "a manifest
mismatch fail[s] closed". For `store.db` the identity is one integer in an
ordinary table, and nothing compares it to the schema it claims to describe.

## Evidence trail

Where the version lives:

- `cortexkit-store/src/lib.rs:341-349` creates
  `cortexkit_schema_version(namespace, version, applied_at_unix,
  PRIMARY KEY (namespace, version))`.
- `:375-380` inserts one row per applied migration.
- `crates/mc-store/src/lib.rs:401` `const NS: &str = "mc_cache"` is this
  crate's namespace.
- `lib.rs:5348-5358` `module_store_schema_version` reads
  `SELECT COALESCE(MAX(version), 0) FROM cortexkit_schema_version WHERE
  namespace = ?1`. Its doc comment at `:5345-5347` says "Read-only probe for
  status surfaces; it never writes."

Where the version is *not* stored:

- `PRAGMA user_version` is never set. `docs/migration-version-lanes.md:13` lists
  `PRAGMA user_version = 1` as part of format identity. A content search for
  `user_version` across `crates/` finds only `sqlite_runtime.rs:14-15`, the
  `DIRECT_FORMAT_EPOCH` constant and its doc comment.
- `PRAGMA application_id` is never set on `store.db`. `sqlite_runtime.rs:11-12`
  defines `MC_APPLICATION_ID = 0x4D43_5458`; the only code that *applies* it is
  TypeScript, at `packages/cli/src/commands/doctor-repair-db.ts:355`.
- `mc_format_marker` (`sqlite_runtime.rs:17`) is never created by Rust. The only
  references outside the constant and its test are TypeScript:
  `packages/cli/src/commands/doctor-repair-db.test.ts:321` and
  `packages/plugin/src/features/magic-context/memory/fixtures/claim-operations-crash-worker.ts:49`.

The declared-object side that exists but is unused:

- `sqlite_runtime.rs:153-167` `compute_schema_manifest_digest` computes a
  canonical SHA-256 over `component name=<n> dependsOn=<a,b> provides=<x,y>`
  lines. This is the mechanism the document's "manifest mismatch" language
  refers to.
- `sqlite_runtime.rs:169-185` `compute_marker_digest` binds the epoch,
  incarnation id, manifest digest, and creation time.
- Neither has a production caller. A content search returns definitions plus
  `crates/mc-store/tests/sqlite_runtime.rs:87` and `:94, :102`.

The version-reading guard:

- `lib.rs:1346-1366` `recorded_mc_cache_version`. `:1348-1355` checks whether
  `cortexkit_schema_version` exists in `main.sqlite_schema` and returns `None`
  when absent (`:1356-1358`). `:1359-1363` reads `MAX(version)`. `:1364` is
  `Ok(u32::try_from(recorded).ok().filter(|version| *version > 0))`, so a
  recorded literal `0` becomes `None`.
- `lib.rs:1375-1385` `refuse_pre_cutover_store` refuses only when
  `recorded < OLDEST_ADOPTABLE_MIGRATION_VERSION`, which `:1342` defines equal
  to `LATEST_MIGRATION_VERSION`, computed as `57` from the array (`:1321-1331`,
  `:433`).

## Failure scenario

Three ways the version and the schema can disagree.

**1. Out-of-band schema change.** The version is an ordinary table row, not a
header field, so any writer that can open the file can drop a table without
touching it. `lib.rs:16697-16713` demonstrates that a raw
`rusqlite::Connection::open` on the same path is expressible in this codebase.
After such a change `module_store_schema_version` still returns 57 while the
schema is something else. The next query fails with a missing-table error at
first use rather than a diagnosable refusal at open.

**2. Recorded zero read as pristine.** A store whose `cortexkit_schema_version`
contains `("mc_cache", 0)` is mapped to `None` by `lib.rs:1364`.
`refuse_pre_cutover_store` then falls through to `Ok(())` (`:1383`) and
`run_migrations` computes `current = 0` (`cortexkit-store:351-357`) and applies
the bootstrap. If any bootstrap object already exists, the first
`CREATE TABLE mc_cache_state` (`lib.rs:435`) fails with the raw DDL-collision
error that `lib.rs:1371-1372` explicitly says the refusal exists to avoid.

**3. Newer database opened by an older binary.** The refusal guard is
one-directional: `recorded < 57` refuses, `recorded > 57` does not. And
`run_migrations` skips every bundled version at or below `current`
(`cortexkit-store:363-365`). So a `store.db` written by a binary shipping
version 58 opens on a 57 binary with no refusal, no migration, and no warning.
The 57 binary then queries a schema it does not know, and
`module_store_schema_version` correctly reports 58 while
`LATEST_MIGRATION_VERSION` is 57 — a discrepancy that is *observable* but
nothing acts on. `lib.rs:1316-1320` says the status surface reports the value
"to answer 'which schema does this binary support'", so the skew is surfaced to
an operator rather than enforced.

**4. Post-migration repairs are not version-recorded.** `McStore::open` runs
`repair_note_artifacts_v51` (`lib.rs:4902`) and
`prune_transform_session_roots` (`:4903`) after `migrate`. Both mutate data, and
neither is recorded against a version. `repair_note_artifacts_v51` carries its
own completion flag (`lib.rs:5070`, `:5105-5112`) precisely because the version
row cannot express it. So "version 57" describes a schema, not a completed data
state, and the two are tracked by different mechanisms.

## Timing windows and dependencies

- Cases 1 and 3 need no window; they are steady states.
- Case 2 needs a store seeded with a literal `0` version row, which no code path
  in this crate produces (`cortexkit-store:378` inserts `m.version`, which is
  57). It would come from an external writer or a historical binary.
- Case 4's window is between the migration commit
  (`cortexkit-store:381`) and the repair flag commit (`lib.rs:5105-5112`).
- All of it depends on the version being a table row rather than a header field.
  A `PRAGMA user_version` value would not fix out-of-band DDL either, but
  `application_id` plus a marker row plus an inventory digest — the three things
  the document specifies — would detect it.

## What a test must construct

For case 1, the highest-value and cheapest test:

1. `McStore::open` a temp store, assert `module_store_schema_version() == 57`.
2. Drop the store, open a raw `rusqlite::Connection` on the same path, and
   `DROP TABLE mc_tags` (or any bootstrap object).
3. `McStore::open` again and assert a diagnosable refusal.

Step 3 fails today: the reopen succeeds. The oracle needs the declared object
inventory, and `compute_schema_manifest_digest` is already written for it.

For case 3:

1. Seed `cortexkit_schema_version` with `("mc_cache", 58)` on a store whose
   schema is otherwise version 57.
2. `McStore::open` and assert a refusal or an explicit forward-compatibility
   decision.

Fails today: the open succeeds silently.

For case 2, seed `("mc_cache", 0)` alongside an existing `mc_cache_state` table
and assert the error names the family rather than the DDL collision.

## Investigation log

### Q: Is there a plan to wire `compute_schema_manifest_digest` into `McStore::open`?

- Sources examined: `sqlite_runtime.rs:1-6`, which names
  `packages/plugin/src/features/magic-context/fixtures/direct-format-vocabulary-v1.json`
  as "the cross-runtime source of truth"; `docs/migration-version-lanes.md:18-20`
  on the schema composer owning component dependencies and object ownership;
  `lib.rs:4816-4905`.
- Findings: the vocabulary is deliberately shared between runtimes, and the
  digest helpers are written to that shared encoding. The composer the document
  describes ("Duplicate ownership, dependency cycles, undeclared objects, and a
  manifest mismatch fail closed") does not exist in Rust; there is no component
  registry in `crates/mc-store/src`. `MIGRATIONS` is one flat SQL string, not a
  set of registered components.
- Missing evidence: whether the composer is TypeScript-only by design, applying
  to `context.db` while `store.db` uses the migration table instead.
- Conclusion: needs human input. The document does not scope its format-identity
  section to `context.db`, but the Rust code behaves as if it were scoped that
  way. Either the doc should say so or `store.db` should adopt the identity.

### Q: Does the version row's absence versus a zero value change any behaviour?

- Sources examined: `lib.rs:1346-1366` in full, `:1375-1385`,
  `cortexkit-store:351-357`.
- Findings: no, they are deliberately collapsed. `:1356-1358` returns `None` for
  a missing table and `:1364` returns `None` for a zero value, and
  `refuse_pre_cutover_store` treats `None` identically to a current version by
  falling through at `:1383`. The doc comment at `lib.rs:1344-1345` states the
  intent: "or `None` when the namespace has no history: a fresh file, or one
  predating the version table."
- Missing evidence: none.
- Conclusion: resolved with answer — collapsed on purpose. The consequence is
  that "no history" and "history recorded as zero" both authorize a bootstrap,
  which is only safe if the schema really is empty, and nothing checks that.
