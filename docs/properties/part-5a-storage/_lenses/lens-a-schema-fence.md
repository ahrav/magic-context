# Lens A: the storage schema fence and database ownership

One attention focus: the newer-schema fence in
`packages/plugin/src/features/magic-context/storage-db.ts`, the schema identity
it compares, and whether the refusal can be bypassed. A sibling lens owns the
claim outbox and authority; this file does not catalog them.

Provenance: `/local/home/ahrav/scratch/magic-context`, `HEAD` = `e447c927`.
Method contract in [../../METHOD.md](../../METHOD.md). Scope and region maps
from
[../../part-5-ts-surfaces/_lenses/scope-map-and-risk-ranking.md](../../part-5-ts-surfaces/_lenses/scope-map-and-risk-ranking.md),
which ranks this material first in Part 5.

Every line reference below was read back at `HEAD`. Two references the scope map
supplied are corrected in Observations, and one premise in the task framing is
corrected in Cross-language asymmetry.

Part 5's CI fact applies throughout: `ci.yml:257` runs every test file in every
package this sub-part scopes, so absent execution is not the default finding.
The findings here are fail-open arms inside a fail-closed guard, and a
cross-language split that green CI cannot see.

## Schema identity and fence map

### The two epochs the fence compares

A `context.db` records its vintage twice, in two independent places, and the
fence reads both.

**Lane 1, the migration version.** `getPersistedSchemaVersion`
(`storage-db.ts:183-196`) returns `0` when the `schema_migrations` table is
absent (`:185-189`), otherwise
`MAX(version) FROM schema_migrations WHERE version < FORK_MIGRATION_VERSION_FLOOR`
(`:192-194`). The floor is `10_000` (`migrations.ts:2`). The ceiling this build
supports is `LATEST_SUPPORTED_VERSION = DIRECT_FORMAT_FENCE_MIGRATION_VERSION`
(`storage-db.ts:98`), which is `DIRECT_FORMAT_SUPERSEDED_MIGRATION_HEAD + 1`
(`migrations.ts:6`), so `89 + 1 = 90` (`migrations.ts:4`).

A freshly bootstrapped direct-format database carries exactly one row in that
lane. `stampDirectFormatFence`
(`storage-session-runtime-schema.ts:129-146`) inserts version 90 with the
description "direct-format fence: this database uses the registered direct
format, not the legacy migration lane" (`:141-143`), and asserts at `:130-132`
that the fence version stays below the downstream floor. Its doc comment at
`:120-127` states the contract in the fence's own words: "A pre-cutover binary
reads `MAX(version) FROM schema_migrations WHERE version < 10000` and refuses to
open any database whose lane is newer than its own fence, so this single row
makes every legacy build fail closed against a direct-format database without
mutating it."

**Lane 2, the marker format epoch.** `readDirectFormatMarker`
(`storage-format-epoch.ts:186-234`) reads the single `mc_format_marker` row and
returns one of three statuses: `absent` when the table is missing (`:190`),
`malformed` for an unreadable table, a zero-row or multi-row table, an invalid
epoch, incarnation ID, manifest digest or creation time, or a digest mismatch
(`:198-232`), or `present` with the parsed marker (`:233`). This build reads
`DIRECT_FORMAT_EPOCH = 1` (`storage-format-epoch.ts:45`).

### What the fence does on each outcome

`refuseNewerSchemaFence` (`storage-db.ts:651-681`) is the whole guard. Its
structure matters more than its length:

1. `:656-661` reads the version lane, swallowing any read error and leaving
   `persistedVersion` at `0`. The comment at `:660` states the intent: "An
   unreadable version lane stays a plain format refusal."
2. `:667-668` reads the marker and collapses every non-`present` status to epoch
   `0`: `const persistedEpoch = marker.status === "present" ? marker.marker.formatEpoch : 0`.
3. `:669-671` is the accept condition, a conjunction:
   `persistedVersion <= latestSupportedVersion && persistedEpoch <= DIRECT_FORMAT_EPOCH`
   returns `false`, meaning "not refused".
4. `:672` latches `lastSchemaFenceRejection = { persistedVersion, supportedVersion }`.
   Note the latch records **only** the version pair; the epoch that may have
   caused the refusal is not latched.
5. `:673-676` picks the lane name for the message, preferring the epoch arm.
6. `:677-679` **logs**. It does not throw.
7. `:680` returns `true`.

So the answer to "what does an older binary do when it opens a newer database"
is precise and slightly different from the framing: it **logs a fatal-prefixed
line, latches a rejection record, closes the connection, and returns `null` from
`openDatabase`.** The only throw on this path is the one at
`storage-db.ts:860-862`, and it is reached only from the `catch` at `:855` for a
genuine open error, never from the fence. Callers must null-check, which the doc
comment at `:822-827` states explicitly.

The two call sites:

- `recordFormatRefusal:689` calls the fence **first**, before recording a format
  refusal, and returns early if it fires. So a database that is both
  wrong-shaped and newer is reported as a fence rejection, not a format refusal.
- `openDirectDatabase:777-780` calls it again on the **accepted** path, after
  classification has already returned `current`. The comment at `:773-776` is
  the rationale, and it is the `:774` line the task asks about.

`getSchemaFenceRejection` (`storage-db.ts:81-86`) exposes the latch. It is
consumed at `hook.ts:263-268`, `index.ts:414-421`, `pi-plugin/src/index.ts:793-794`,
and `schema-fence-probe.ts:72`.

### Migration: there is no lane

`storage-db.ts:711-713` states the policy: "There is no migration lane: old
databases are refused, never migrated." This is structural rather than a
comment. The only write to a non-current family is `bootstrapUnderWriteLock`
(`:611-641`), which rechecks the family under `BEGIN IMMEDIATE` (`:620-627`) and
returns without writing unless the family is still `pristine` (`:628`). Every
other family reaches `recordFormatRefusal` (`:769`) and then `closeQuietly`
(`:770`).

The consequence for the migration questions in the task is that they mostly
dissolve on this side. There are no incremental migrations to be transactional
about; the bootstrap is one `db.transaction(...).immediate()` (`:616-639`)
covering `composeRegisteredSchema`, `createDirectFormatMarkerSchema` and
`stampDirectFormatMarker`, so a crash mid-bootstrap rolls back to a pristine
file and the next open re-bootstraps. That is a materially stronger position
than Part 3 records for the Rust side, where the version-table creation and the
current-version read sit outside any transaction and the per-migration `BEGIN`
is DEFERRED
([part-3 lens-a:408-414](../../part-3-store-core/_lenses/lens-a-sqlite-durability.md),
`cortexkit-store:341-383`).

Recorded-version-versus-actual-schema disagreement is also narrower here than in
Rust. TypeScript checks an exact object-name inventory during classification
(`storage-format-epoch.ts:242-247` for missing and unregistered objects), plus
`application_id` and `user_version`, plus the manifest digest. Part 3's
`recorded-schema-version-cannot-disagree-with-the-actual-schema` record notes
that for `store.db` "none of these are set or checked"
([part-3 lens-a:529-539](../../part-3-store-core/_lenses/lens-a-sqlite-durability.md)).
The residual TypeScript exposure is the version row itself, covered by record 9
below plus observation O9.

## Cross-language asymmetry

The task asks whether a Rust binary can write a database this TypeScript layer
would refuse. The answer needs a correction to the premise first, and then it
splits into two genuine asymmetries that are sharper than the original framing.

**Correction: the two runtimes own different files.** Rust's fenced store is
`store.db` (`mc-store/src/lib.rs:1344`, `:1368`, `:3456-3457`, and the path
construction at `:13943`). TypeScript's is `context.db`
(`storage-db.ts:176`). `mc-module` says so twice, unprompted:
"The module never opens or attaches the host's context.db — the TypeScript
plugin ..." (`mc-module/src/lib.rs:15451`) and "The module does not read the
host's context.db; the TS surface owns it." (`:26264`). A content search for
`context.db` across `crates/` returns five hits, all comments or message text,
none an open. So a Rust binary **cannot** write the specific file this fence
protects, and the fence is not being flanked on its own file.

That makes the real asymmetry a matched pair of guards pointing in **opposite
directions**, which is worse than a missing guard because each side's guard
implies a safety story the other does not honour.

**Asymmetry 1: opposite fence directions, so one skew produces two verdicts.**
TypeScript fences the *newer* direction and refuses (`storage-db.ts:669`). Rust
fences the *older* direction only: `refuse_pre_cutover_store`
(`mc-store/src/lib.rs:1375-1385`) matches
`Some(recorded) if recorded < OLDEST_ADOPTABLE_MIGRATION_VERSION` (`:1377-1382`)
and every other case, including a recorded version *above* the ceiling, falls
through to `Ok(())` (`:1383`). Part 3 established this and states the
consequence: "an older binary opens a newer database silently and queries it
with the older binary's expectations"
([part-3 lens-a:555-563](../../part-3-store-core/_lenses/lens-a-sqlite-durability.md)).
Cited, not re-derived.

So on one machine, at one version skew, an older install fails closed on
`context.db` and fails **open** on `store.db`. Both databases hold halves of one
claim protocol; `mc-store/src/lib.rs:11018` describes staging "one claim command
before the host mutates `context.db`". Record 10 and record 12 carry this.

**Asymmetry 2: Rust ships the fence vocabulary and never calls it.** This is the
finding I did not expect. `crates/mc-store/src/sqlite_runtime.rs:1-6` declares
itself as sharing "one vocabulary (application ID, format epoch, marker and
manifest digests) with the TypeScript host", names
`packages/plugin/src/features/magic-context/fixtures/direct-format-vocabulary-v1.json`
as "the cross-runtime source of truth", and says an integration test proves the
module against it. It defines `MC_APPLICATION_ID` (`:12`), `DIRECT_FORMAT_EPOCH`
(`:14-15`), `DIRECT_FORMAT_MARKER_TABLE = "mc_format_marker"` (`:17`),
`FORMAT_MARKER_DIGEST_PROTOCOL` (`:20`), `SCHEMA_MANIFEST_PROTOCOL` (`:22`),
`compute_schema_manifest_digest` (`:156-168`) and `compute_marker_digest`
(`:170-184`).

It is declared `pub mod sqlite_runtime;` at `mc-store/src/lib.rs:17` and that is
the module's only reference from production Rust. A search for `sqlite_runtime::`
across `crates/` excluding `crates/mc-store/tests/` returns **zero** hits; the
only consumer is `crates/mc-store/tests/sqlite_runtime.rs` (`:8-9`, `:51-103`).
`DIRECT_FORMAT_EPOCH` in Rust and `DIRECT_FORMAT_EPOCH` in TypeScript are both
`1`, agree by fixture, and only one of them gates an open.

The `format_epoch` occurrences inside `mc-store/src/lib.rs` (`:1219`, `:3784`,
`:3825`, `:3863-3864`, `:11089-11097`) are a different thing: a column on the
claim-intent binding, checked with `binding.format_epoch < 1` (`:3825`). That is
per-claim binding validation, not a database-open fence.

## Observations

Line-anchored, verified at `HEAD`.

**O1. The fence logs and returns; it does not throw.**
`storage-db.ts:677-680` is `log(...)` then `return true`. The scope map records
the fence as "enforced at `:678`, which throws a message ending 'Do not reset
this database: a newer binary owns it.'"
([scope map:143-147](../../part-5-ts-surfaces/_lenses/scope-map-and-risk-ranking.md)).
The message text at `:678` is correct; "throws" is not. The refusal reaches a
caller as `null` from `openDatabase` (`:779`, `:771`), never as an exception.
The only throw in `openDatabase` is `:860-862`, from the `catch` at `:855`.
Correction recorded, and it changes what a test must assert. Record 2.

**O2. The `:774` blind spot is narrower than "detection is blind", and the
comment is a rationale, not an admission of a hole.** `:773-776` reads: "The
fence is checked on the accepted path too, not only on refusal. Object-name
identity cannot see a fence a newer binary moved without renaming anything, so
skipping this here would leave the one family that reaches real queries as the
only one never proving its vintage." The undetectable thing is a **vintage
change that renames no schema object**. Classification
(`storage-format-epoch.ts:206-247`) compares object names, `application_id`,
`user_version` and the manifest digest, and returns `current` when all match, so
a newer binary that changes only semantics inside an identical object set is
invisible to it. The `:777-780` call closes exactly that gap by reading the
version lane and the epoch. `storage-db.test.ts:478-497` is the dedicated test,
and its inline comment at `:481-484` names the same reasoning. So `:774` is a
gap the code **fixes**. Records 5, 3 and 9 carry what the fix does not reach.

**O3. Every non-`present` marker status collapses to epoch `0`.**
`storage-db.ts:668` and again at `:691`. `0 <= DIRECT_FORMAT_EPOCH` is true, so
the epoch arm of `:669` passes unconditionally for an `absent` or `malformed`
marker. `absent` is correct and intended, because a legacy database has no
marker. `malformed` is the problem: `readDirectFormatMarker` returns `malformed`
for a digest mismatch (`storage-format-epoch.ts:231`), an out-of-range epoch
(`:216-221`), and an unreadable marker table (`:194-199`). A newer binary that
changes the marker encoding, adds a digested field, or bumps
`FORMAT_MARKER_DIGEST_PROTOCOL` produces a marker this build parses as
`malformed`, and the epoch arm then reads it as the oldest possible value. The
version arm is the only remaining catch. Record 3.

**O4. A malformed marker gets hard `reset-db` guidance, which is the one action
the fence message forbids.** `classifyDatabaseFormatFamily` returns family
`malformed-marker` as its first branch (`storage-format-epoch.ts:190-192`), so
the open path reaches `recordFormatRefusal` (`storage-db.ts:769`). Inside it,
the fence runs first (`:689`) and declines by O3. Then `manifestOnly` (`:695-698`)
requires `marker.status === "present"`, which a malformed marker fails, so
`guidance` takes the `:701` branch: "To abandon this database family and start
fresh, run 'npx @cortexkit/magic-context@latest doctor reset-db'." The fence's
own message at `:678` ends "Do not reset this database: a newer binary owns it",
and the comment at `:663-666` states the reason: "reset guidance for the former
would destroy a family a newer binary legitimately owns." The code contains the
warning and the contradicting path. Record 4.

**O5. The fence ceiling is overridable by environment variable; the epoch is
not.** `getRuntimeLatestSupportedVersion` (`storage-db.ts:213-225`) prefers
`options.latestSupportedVersion` (`:214-216`), then
`process.env.MAGIC_CONTEXT_LATEST_SUPPORTED_VERSION` parsed with `parseInt`
(`:217-223`), then the constant. `Number.isFinite(parsed)` accepts any finite
integer including a huge one, and accepts a trailing-garbage string such as
`"999x"`. The epoch comparison at `:669` uses the hard-coded
`DIRECT_FORMAT_EPOCH`, so the override relaxes one arm of a two-arm conjunction.
The env var has exactly one reference in the repo, this one. Record 6.

**O6. The child-spawn fence is strictly weaker than the open fence.**
`probeChildSpawnFence` (`schema-fence-probe.ts:70-101`) checks
`persistedVersion > LATEST_SUPPORTED_VERSION` (`:84`) and nothing else. It does
not read the marker, so the epoch arm is absent. It also uses the constant
`LATEST_SUPPORTED_VERSION` directly (`:5`, `:84-85`) rather than
`getRuntimeLatestSupportedVersion`, so it ignores both the env override and the
per-call option. A database newer only by epoch passes this probe while failing
the open fence. Its own comment at `:94-96` calls the re-arm path "normally
unreachable for a monotonic schema version". Two callers:
`hooks/magic-context/child-session-spawn.ts:88`, described at `:82-84` as the
"Shared OpenCode child-session choke point" that every historian, recomp,
dreamer and sidekick child must pass, and `pi-plugin/src/subagent-runner.ts:851`.
Record 7.

**O7. A second read-write connection to the same file outlives the fence.**
`transform-decision-log.ts:392-405` caches one `new Database(dbPath)` per path
in `telemetryDbByPath` (`:390`), where `dbPath` comes from
`getDatabasePath(args.db)` (`:220`, `:278`), which is the same `context.db` the
fence guards. The handle is created only after a successful open, so it does not
defeat the first fence pass. But `closeDatabase` (`storage-db.ts:920-931`)
clears `pendingAsyncOpens` and `databases` only; it never touches
`telemetryDbByPath`. The only clearing is `reset()` at
`transform-decision-log.ts:469-478`, whose sibling methods are
`setWriterForTests` (`:479`) and `setRetentionForTests` (`:482`), and which has
no production caller. So after `closeDatabase()` the telemetry connection stays
open and writable while a subsequent `openDatabase()` is being refused by the
fence. The comment at `:388-389` acknowledges a related staleness: "If the DB
file is ever replaced on disk, writes land on the old inode until restart".
Record 8.

**O8. Fork-lane versions are invisible to the fence by construction.**
`getPersistedSchemaVersion:192-194` filters `version < FORK_MIGRATION_VERSION_FLOOR`,
so any row at or above `10_000` cannot raise `persistedVersion`.
`migrations.ts:1` describes the floor as "First version reserved for downstream
migrations; upstream versions stay below it", and
`storage-session-runtime-schema.ts:130-132` throws if the fence version ever
reaches the floor. So a downstream fork that records its own migrations above
the floor advances a lane the fence structurally cannot read, and its databases
present as version 90 to an upstream binary. Record 9.

**O9. The only code that can lower the recorded fence row is test-only, but it
ships in a production module.** `dropClaimApplicabilityObjectsForTests`
(`storage-claim-applicability-schema.ts:614-629`) ends with
`db.prepare("DELETE FROM schema_migrations WHERE version >= 85").run()` (`:628`).
The fence row is version 90, so that statement deletes it, dropping
`getPersistedSchemaVersion` from 90 to 0. The name marks it test-only and no
production caller imports it, but it is an ordinary export from a non-test file.
Carried as an observation only, with no record of its own: with no production
caller it has no default-production reachability, and inventing a `test-only`
record for it would spend a record slot on a hazard that cannot fire in a
shipped install. It is the sharpest available reason to believe record 9's
concern about the version row's trustworthiness is worth checking, so it belongs
with that record's evidence rather than on its own.

**O10. Cached-handle reuse skips the fence, including when the ceiling changes.**
`openDatabase:840-851` returns a cached handle for a path already in `databases`
without re-running the fence, and `openDatabaseAsync:881-886` does the same. The
latches are cleared to `null` at `:838-839` and `:879-880` before the cache
lookup, so a cache hit also erases any prior rejection record. Because
`latestSupportedVersion` is a per-call input (`:837`, `:878`), a second call with
a **lower** ceiling returns the handle admitted under the higher one. Record 8
carries this with O7.

**O11. Refusal is surfaced to a user on three paths, and the epoch is dropped
from all three.** `hook.ts:263-283` records a `schema_fence` init failure
carrying `persistedVersion` and `supportedVersion`; `index.ts:414-421` sends a
Desktop warning via `sendSchemaFenceWarning`, with the comment at `:408-412`
explaining that Desktop has no dialog surface; `pi-plugin/src/index.ts:793-794`
reads both latches. All three consume `getSchemaFenceRejection`, whose payload
is the version pair only (`storage-db.ts:81-86`, latched at `:672`). When the
epoch arm caused the refusal, `persistedVersion` equals `supportedVersion` and
the surfaced message reports a version pair that is not the reason. Record 1 and
record 2.

## Candidate properties

### fence-a-older-binary-never-writes-a-newer-database

Type: safety
Reachability: default-production — the fence is on the only `context.db` open
path in `packages/plugin` (`storage-db.ts:753` is the sole `new Database(dbPath)`
for the resolved context path), reached by every plugin start through
`openDatabase`/`openDatabaseAsync`. No flag gates it.
Status: active
Exercised: partial — `storage-db.test.ts:421-476` proves a newer version lane is
refused with the file digest unchanged, and `:478-497` proves the same for a
`current` family carrying a newer fence row. Neither asserts that no `-wal` or
`-shm` byte changed on the fence path specifically, and none covers the
epoch-only case with an unchanged version row beyond `:352-372`.
Guarantee: When the persisted version lane exceeds this build's ceiling or the
marker epoch exceeds `DIRECT_FORMAT_EPOCH`, no byte of the database family is
modified and no handle is returned.
Check: `always` — after an `openDatabase` that the fence refuses, the digest of
`context.db`, `context.db-wal` and `context.db-shm` equals the pre-call digest,
and the return value is `null`. `always` because the guarantee must hold on
every refusal, not merely be reachable once.
Fault/timing angle: the window is `storage-db.ts:753-780`. A connection is
constructed and `PRAGMA busy_timeout` and `foreign_keys` are set (`:758-759`)
before the verdict; `PRAGMA journal_mode=WAL` is deliberately deferred to `:782`,
after the fence. `bootstrapUnderWriteLock` (`:766`) can run first and takes
`BEGIN IMMEDIATE`, creating a `-journal` file on this connection, which `:622-626`
excludes from the artifact inventory.
Required faults and enabling state: a `context.db` whose `schema_migrations` max
below 10_000 exceeds 90, or whose `mc_format_marker.format_epoch` exceeds 1 with
a valid digest. No fault injection needed; the state is constructible offline.
Confidence: high — [evidence](../evidence/fence-a-older-binary-never-writes-a-newer-database.md).
Read the full open path and both fence call sites, and confirmed WAL is enabled
only after the verdict.
Existing check: `storage-db.test.ts:421-476` and `:478-497`, both run at
`ci.yml:257`. Status `unaudited`.
Impact: an older binary writing a newer database corrupts a family that
`storage-db.ts:711-713` has already foreclosed repair for, because there is no
migration lane to walk it forward.
Open questions:
- Does any refusal path leave a `-wal` file that did not previously exist? The
  legacy-family test asserts `existsSync(\`${dbPath}-wal\`) === false` at
  `storage-db.test.ts:394`, but the fence tests do not. Unresolved, needs a
  digest-and-existence assertion on all three files.

### fence-a-refusal-is-a-null-return-not-a-throw

Type: safety
Reachability: default-production — the callers that must null-check are the
shipped plugin entry points: `hook.ts:263`, `index.ts:414`,
`pi-plugin/src/index.ts:793`.
Status: active
Exercised: partial — every fence test asserts `openDatabase(dbPath)` is
`toBeNull()` (`storage-db.test.ts:368`, `:459`, `:494`), so the null contract is
covered. No test asserts that a caller that only wraps `openDatabase` in
`try/catch`, without a null check, is absent from the codebase.
Guarantee: A fence refusal is delivered as a `null` return plus a latched
rejection record, never as a thrown error, and every caller therefore both
null-checks and catches.
Check: `always` — on a fence refusal, `openDatabase` returns `null` and does not
throw, and `getSchemaFenceRejection()` is non-null. `always` because the
delivery mechanism must be uniform; a caller that guesses wrong disables nothing
and proceeds without storage.
Fault/timing angle: none for the return itself. The latch is process-global
mutable state (`storage-db.ts:72`) cleared at `:838-839` and `:879-880` on every
open attempt, so a second open between the refusal and the read of the latch
erases the record.
Required faults and enabling state: a newer-fence database plus a caller that
reads the latch after an intervening successful open on a different path.
Confidence: high — [evidence](../evidence/fence-a-refusal-is-a-null-return-not-a-throw.md).
Verified `:677-680` is `log` then `return true`, and that the only throw is
`:860-862` from the `catch` at `:855`. This corrects the scope map.
Existing check: `storage-db.test.ts` fence cases, plus
`config/latch-permanence-guard.test.ts:133`, which registers
`storage-db.ts:lastSchemaFenceRejection` in a latch-permanence registry. Both at
`ci.yml:257`. Status `unaudited`.
Impact: the doc comment at `storage-db.ts:822-827` requires callers to handle
both outcomes. A caller handling only the throw treats a fence refusal as a
successful open of `null`, and `storage-db.ts:800-809` explains why silently
losing storage lets raw history reach the model.
Open questions:
- The scope map states the fence throws at `:678`. Should the scope map be
  corrected, or was an earlier revision throwing? (needs human input)

### fence-a-malformed-marker-reads-as-epoch-zero

Type: safety
Reachability: default-production — `storage-db.ts:668` is on the unconditional
fence path; no flag or option changes the collapse.
Status: active
Exercised: not yet — `storage-db.test.ts` covers a marker with `formatEpoch: 2`
and a **valid** digest (`:432-459`, built by `buildDirectFormatMarker` with
`computeMarkerDigest`). No test constructs a marker that is newer *and*
malformed, which is the case where the epoch arm silently passes.
Guarantee: A marker this build cannot parse is never treated as evidence that
the database is old enough to open.
Check: `always` — whenever `readDirectFormatMarker` returns `malformed`, the
open path refuses, and the refusal is not attributed to a stale epoch of `0`.
`always` because the collapse is evaluated on every open.
Fault/timing angle: none; this is a pure classification defect, not a race. The
window is the single expression at `storage-db.ts:668`, repeated at `:691`.
Required faults and enabling state: a `context.db` whose `mc_format_marker` row
fails any validator in `storage-format-epoch.ts:206-232` while carrying a newer
vintage, and whose `schema_migrations` lane is at or below 90 so the version arm
does not catch it. A newer binary that bumps `FORMAT_MARKER_DIGEST_PROTOCOL`
without bumping the migration lane produces exactly this.
Confidence: high — [evidence](../evidence/fence-a-malformed-marker-reads-as-epoch-zero.md).
Traced all three marker statuses through `:668` and confirmed
`0 <= DIRECT_FORMAT_EPOCH` makes the epoch arm of `:669` vacuous for two of
them.
Existing check: none for the malformed-and-newer combination. Status
`unaudited`.
Impact: the epoch is the arm the code itself calls decisive
(`storage-db.ts:663-666`: "The marker's format epoch is the signal that actually
distinguishes a database this build is too old to read from one it must
refuse"). Collapsing an unparseable marker to `0` removes that signal in the one
case where the marker format itself changed.
Open questions:
- Is `absent` versus `malformed` a deliberate merge, given that `absent` must
  read as `0` for legacy databases but `malformed` arguably must not?
  (needs human input)

### fence-a-unclassifiable-family-must-not-get-reset-guidance

Type: safety
Reachability: default-production — `recordFormatRefusal` is called at
`storage-db.ts:769` on every non-`current` family, and `malformed-marker` is
`classifyDatabaseFormatFamily`'s first branch
(`storage-format-epoch.ts:190-192`).
Status: active
Exercised: not yet — `storage-db.test.ts:373-396` covers the `unsupported`
legacy family and `:398-420` an unsupported family with WAL state. No test
asserts which guidance string a `malformed-marker` family receives.
Guarantee: A database this binary cannot classify is refused without being
handed advice that destroys it, because an unclassifiable family may be one a
newer binary owns.
Check: `always` — when the refused family is `malformed-marker`, or when the
marker status is not `present`, the logged guidance does not recommend
`doctor reset-db` as the primary action. `always` because the message is
composed on every refusal.
Fault/timing angle: none. The composition is straight-line at
`storage-db.ts:690-704`.
Required faults and enabling state: any `context.db` whose marker row fails a
validator. A truncated write, a partially applied newer-binary marker update, or
a protocol bump all produce it.
Confidence: high — [evidence](../evidence/fence-a-unclassifiable-family-must-not-get-reset-guidance.md).
Verified `manifestOnly` at `:695-698` requires `marker.status === "present"`, so
the softened guidance at `:700` is unreachable for a malformed marker and `:701`
is taken.
Existing check: none. Status `unaudited`.
Impact: `storage-db.ts:663-666` states the exact harm: "reset guidance for the
former would destroy a family a newer binary legitimately owns." The
destructive command is real and shipped
(`packages/cli/src/commands/doctor-reset-db.ts`, 677 lines per the scope map),
and `storage-db.ts:818` routes users to it.
Open questions:
- Should `malformed-marker` receive a third guidance string, distinct from both
  the manifest-only and the abandon-family cases? (needs human input)

### fence-a-accepted-path-proves-vintage

Type: safety
Reachability: default-production — `storage-db.ts:777` is unconditional on the
accepted path, after `classification.family === "current"`.
Status: active
Exercised: yes — `storage-db.test.ts:478-497` bootstraps a database with this
build, closes it, inserts a version-91 row, and asserts the reopen is refused
with a fence rejection and no format refusal. That is precisely the accepted-path
fence.
Guarantee: A family whose object inventory, `application_id`, `user_version` and
manifest digest all match this build is still refused if its version lane or
marker epoch is newer.
Check: `always` — for every open that reaches `storage-db.ts:781`, the persisted
version is at or below the runtime ceiling and the marker epoch is at or below
`DIRECT_FORMAT_EPOCH`. `always` because it is a precondition of every query the
process will later run.
Fault/timing angle: the fence reads the version lane and the marker outside any
transaction, on a connection that has not yet enabled WAL (`:782`). A concurrent
newer binary could stamp a newer fence row between this read and the first
application query. `bootstrapUnderWriteLock` uses `BEGIN IMMEDIATE` (`:639`) but
the fence itself does not.
Required faults and enabling state: for the split-read window, two processes of
different versions opening the same path concurrently, with the newer one
completing its stamp between `:777` and the first query.
Confidence: high — [evidence](../evidence/fence-a-accepted-path-proves-vintage.md).
Read `:765-780` and confirmed the fence runs after classification returns
`current`, and that the dedicated test exists.
Existing check: `storage-db.test.ts:478-497`, at `ci.yml:257`. Status
`unaudited`.
Impact: without this call, the one family that reaches real queries would be the
only one never proving its vintage, which is what the comment at `:773-776`
says.
Open questions:
- Is the unfenced read window at `:777` worth closing with `BEGIN IMMEDIATE`,
  given that a newer binary stamping a fence row mid-open is the scenario the
  fence exists for? (needs human input)

### fence-a-env-override-relaxes-only-the-version-arm

Type: safety
Reachability: explicit-config-only — reached only by setting
`MAGIC_CONTEXT_LATEST_SUPPORTED_VERSION` (`storage-db.ts:217`, the sole
reference in the repo) or by passing `options.latestSupportedVersion` (`:214`).
Neither has a default.
Status: active
Exercised: partial — the option form is used throughout `storage-db.test.ts`
indirectly via `LATEST_SUPPORTED_VERSION + 1` fixtures, but no test sets the
environment variable, and none asserts that raising the ceiling still leaves the
epoch arm enforcing.
Guarantee: Raising the supported-version ceiling never admits a database whose
marker epoch exceeds `DIRECT_FORMAT_EPOCH`.
Check: `always-or-unreached` — if the override is set, an open still refuses any
database whose marker epoch is newer. `always-or-unreached` because a
default-production install never sets it, but the guard must hold when it is
set.
Fault/timing angle: none.
Required faults and enabling state: the env var set to a value above 90, plus a
database with `format_epoch >= 2`.
Confidence: high — [evidence](../evidence/fence-a-env-override-relaxes-only-the-version-arm.md).
Verified `:669` compares the epoch against the module constant, not against any
overridable value, and that `parseInt` with `Number.isFinite` accepts
trailing-garbage strings.
Existing check: none for the env path. Status `unaudited`.
Impact: an operator raising the ceiling to unblock a version-lane mismatch does
not thereby disable the epoch fence, which is the safe design. The residual risk
is the parse: `"999x"` parses to `999`, so a typo silently sets a very high
ceiling rather than being rejected.
Open questions:
- Should the override reject a non-numeric suffix rather than accepting
  `parseInt`'s prefix? Unresolved, needs a decision on operator ergonomics
  versus strictness.

### fence-a-child-spawn-probe-omits-the-epoch-arm

Type: safety
Reachability: default-production — `probeChildSpawnFence` is the pre-spawn gate
in `schema-fence-probe.ts:70-101`, and the module is production, not a test
fixture.
Status: active
Exercised: partial — `schema-fence-probe.test.ts` has four cases (`:32`, `:68`,
`:85`, `:95`) covering the two-probe latch, the read-error arm, the fork-floor
filter, and the surface-once behaviour. All exercise the version lane only. No
case constructs a database newer by marker epoch alone, which is the gap.
Guarantee: A child is not spawned by a process whose view of the shared schema
is stale, by either the version lane or the marker epoch.
Check: `always` — whenever `probeChildSpawnFence` returns `allowSpawn: true`,
the same database would also pass `refuseNewerSchemaFence` at the same ceiling.
`always` because the two guards claim the same thing and must not disagree.
Fault/timing angle: the probe reads the live handle (`schema-fence-probe.ts:83`)
while the open fence read a possibly different snapshot at open time. A newer
binary stamping a fence row between the two is the intended detection, per the
comment at `:66-68`.
Required faults and enabling state: a database newer only by marker epoch, with
the version lane at or below the ceiling. The probe reads only the version
(`:84`), so it allows the spawn.
Confidence: medium — [evidence](../evidence/fence-a-child-spawn-probe-omits-the-epoch-arm.md).
Verified the probe body reads only `getPersistedSchemaVersion` and compares
against the imported constant. Did not enumerate callers, so the blast radius of
an allowed spawn is not established.
Existing check: unresolved, needs a caller and test sweep. Status `unaudited`.
Impact: the probe's stated purpose is to "refuse the child rather than allowing
one stale spawn across a migration fence" (`:88-90`). An epoch-only skew defeats
that purpose while the open fence would have caught it.
Open questions:
- Who calls `probeChildSpawnFence`, and is a spawned child a writer to
  `context.db`? Unresolved, needs a caller sweep this pass did not run.
- The probe uses `LATEST_SUPPORTED_VERSION` directly rather than
  `getRuntimeLatestSupportedVersion`, so an operator override is honoured at
  open and ignored at spawn. Deliberate or drift? (needs human input)

### fence-a-telemetry-connection-outlives-the-fence

Type: safety
Reachability: default-production — the telemetry handle is created by the normal
transform decision-log write path (`transform-decision-log.ts:220`, `:278`,
`:409`), and `closeDatabase` is the shipped teardown.
Status: active
Exercised: not yet — no test opens, closes, then reopens under a fence refusal
while a telemetry handle is live.
Guarantee: After a fence refusal for a path, no connection in this process
retains write access to that path.
Check: `always` — when `getSchemaFenceRejection()` is non-null for a path,
`telemetryDbByPath` holds no open handle for that path. `always` because a
retained writer defeats the refusal for as long as the process lives.
Fault/timing angle: the ordering is open, write a decision row (creating the
cached handle), `closeDatabase()`, then a reopen the fence refuses. Between the
refusal and process exit, the telemetry handle is the only writer and it is
configured `busy_timeout=0` (`transform-decision-log.ts:398`) so its writes drop
on contention rather than blocking.
Required faults and enabling state: a version skew arriving mid-process, for
example a newer sibling stamping a newer fence row while this process is live,
plus at least one prior decision-log write to have created the handle.
Confidence: high — [evidence](../evidence/fence-a-telemetry-connection-outlives-the-fence.md).
Verified `closeDatabase` (`storage-db.ts:920-931`) touches only
`pendingAsyncOpens` and `databases`, and that the only `telemetryDbByPath` clear
is inside a test-seam object with no production caller.
Existing check: none. Status `unaudited`.
Impact: this is the one path in the package where an older binary can still
write bytes to a database the fence has refused. The writes are best-effort
telemetry rows (`:373-381`), so the damage is bounded to the
`transform_decisions` table rather than arbitrary, but it is a write to a family
a newer binary owns.
Open questions:
- Should `closeDatabase` invalidate every secondary handle for the path, or
  should the decision log resolve its path through the live handle on each write
  instead of caching? (needs human input)
- The cached-handle path at `storage-db.ts:840-851` returns a handle admitted
  under a possibly higher ceiling when called again with a lower
  `latestSupportedVersion`. Is a per-call ceiling on a process-cached handle
  meaningful at all? (needs human input)

### fence-a-fork-lane-versions-are-invisible-to-the-fence

Type: safety
Reachability: default-production — the filter is in the fence's own version
read, `storage-db.ts:192-194`.
Status: active
Exercised: partial — `schema-fence-probe.test.ts:85` is titled "ignores
downstream rows when probing the current direct-format fence", so the filter is
deliberate and covered at the child-spawn probe. No test covers it at
`openDatabase`, and none asserts what a fork-lane database's fence verdict is.
Guarantee: The version lane the fence reads is the only lane in which a vintage
change can be recorded, or else a second lane exists and the fence is blind to
it.
Check: `always` — the maximum `schema_migrations.version` in a database equals
`getPersistedSchemaVersion`'s result, or a documented second lane exists and is
compared separately. `always` because the fence's completeness claim depends on
it at every open.
Fault/timing angle: none.
Required faults and enabling state: a `context.db` carrying a row at 10_000 or
above. `migrations.ts:1` reserves that space for downstream forks, so the state
is intended to exist, not hypothetical.
Confidence: high — [evidence](../evidence/fence-a-fork-lane-versions-are-invisible-to-the-fence.md).
Verified the `WHERE version < ?` bound at `:192-194` with
`FORK_MIGRATION_VERSION_FLOOR` at `:194`, the reservation comment at
`migrations.ts:1-2`, and the deliberate-filter test title at
`schema-fence-probe.test.ts:85`.
Existing check: `schema-fence-probe.test.ts:85` covers the filter at the
child-spawn probe, not at `openDatabase`. Status `unaudited`.
Impact: a downstream fork's newer database presents as version 90 to an upstream
binary. The marker epoch and the manifest digest are the remaining defences, and
the digest is a classification input, whose refusal path carries the
`reset-db` guidance covered by record 4.
Open questions:
- Is a fork expected to bump the marker epoch or the manifest digest when it
  advances its own lane? If not, the fence has no signal at all for fork
  vintage. (needs human input)

### fence-a-rust-store-has-no-newer-schema-fence

Type: safety
Reachability: default-production — `refuse_pre_cutover_store` is called at
`mc-store/src/lib.rs:4873` inside `McStore::open`, per
[part-3 lens-a:89](../../part-3-store-core/_lenses/lens-a-sqlite-durability.md).
Status: active
Exercised: not yet on the newer direction — Part 3 records
`fresh_and_current_module_stores_open_without_a_pre_cutover_refusal`
(`lib.rs:16140`) and
`pre_cutover_module_store_is_refused_by_family_not_by_ddl_collision`
(`lib.rs:16089`) as the existing checks, both about the older direction or the
happy path
([part-3 lens-a:413](../../part-3-store-core/_lenses/lens-a-sqlite-durability.md),
`:429`). Part 4's finding that `mc-module` tests do not run in CI applies to the
Rust half regardless.
Guarantee: Each runtime refuses to write a database whose recorded vintage
exceeds what that runtime understands.
Check: `always` — for every successful `McStore::open`, the recorded `mc_cache`
version is at or below `OLDEST_ADOPTABLE_MIGRATION_VERSION`. `always` because it
must hold on every open, mirroring the TypeScript fence's obligation.
Fault/timing angle: Part 3 records that `refuse_pre_cutover_store` reads the
recorded version in its own transaction and `inner.migrate` re-reads it outside
any transaction, so the predicate is split
([part-3 lens-a:490](../../part-3-store-core/_lenses/lens-a-sqlite-durability.md)).
Required faults and enabling state: a `store.db` whose
`cortexkit_schema_version` `MAX(version)` for namespace `mc_cache` exceeds the
binary's ceiling. Produced by running a newer binary then an older one on the
same install.
Confidence: high — [evidence](../evidence/fence-a-rust-store-has-no-newer-schema-fence.md).
Read `recorded_mc_cache_version` (`mc-store/src/lib.rs:1346-1367`) and
`refuse_pre_cutover_store` (`:1375-1385`) and confirmed the `_ => Ok(())` arm at
`:1383` swallows the above-ceiling case. Cited Part 3 for the conclusion rather
than re-deriving it. Also verified the file-scope correction: Rust never opens
`context.db` (`mc-module/src/lib.rs:15451`, `:26264`).
Existing check: `mc-store/src/lib.rs:16089` and `:16140` per Part 3, neither
covering the newer direction. Status `unaudited`.
Impact: at one version skew an install fails closed on `context.db` and fails
open on `store.db`, and the two hold halves of one claim protocol
(`mc-store/src/lib.rs:11018`). The user-visible symptom is that Magic Context
announces itself disabled while the module continues writing.
Open questions:
- Should `refuse_pre_cutover_store` gain an above-ceiling arm, or should
  `store.db` adopt the marker vocabulary its own `sqlite_runtime` module already
  defines? See the next record. (needs human input)

### fence-a-rust-ships-the-fence-vocabulary-uncalled

Type: safety
Reachability: default-production — `pub mod sqlite_runtime;`
(`mc-store/src/lib.rs:17`) ships in the crate. The finding is that no production
path calls it, which is itself the default-production state.
Status: active
Exercised: partial — `crates/mc-store/tests/sqlite_runtime.rs:8-9`, `:51-103`
proves the constants and digest functions against the shared fixture
`packages/plugin/src/features/magic-context/fixtures/direct-format-vocabulary-v1.json`,
which `sqlite_runtime.rs:3-6` names as the cross-runtime source of truth. Per
Part 4, `mc-store` tests do not run in CI, so this is partial evidence for
agreement and none for enforcement.
Guarantee: A fence vocabulary shared between two runtimes is enforced by both,
or the asymmetry is recorded and intended.
Check: `always` — if `sqlite_runtime`'s marker and manifest helpers define the
format identity, some production Rust path reads them before writing a database.
`always` because the vocabulary's purpose is to gate writes, and an uncalled
gate holds vacuously.
Fault/timing angle: none. This is a static wiring gap.
Required faults and enabling state: none. The state is unconditional at `HEAD`.
Confidence: high — [evidence](../evidence/fence-a-rust-ships-the-fence-vocabulary-uncalled.md).
A search for `sqlite_runtime::` across `crates/` excluding
`crates/mc-store/tests/` returns zero hits; the module declaration at
`mc-store/src/lib.rs:17` is the only production reference. Confirmed the
`format_epoch` hits inside `lib.rs` (`:1219`, `:3825`, `:11089`) are the
claim-intent binding column, not a database-open fence.
Existing check: `crates/mc-store/tests/sqlite_runtime.rs`, which proves the
vocabulary matches the fixture and nothing about enforcement. Status
`unaudited`.
Impact: the shared fixture creates a reasonable but false impression that both
runtimes enforce one format identity. Part 3 independently concluded that "the
two runtimes identify their databases by different mechanisms"
([part-3 lens-a:529-539](../../part-3-store-core/_lenses/lens-a-sqlite-durability.md)).
This record names the mechanism by which the impression arises.
Open questions:
- Is `sqlite_runtime` staged for a later wiring into `McStore::open`? Part 3
  asked the adjacent question about `compute_schema_manifest_digest`
  ([part-3 lens-a:432](../../part-3-store-core/_lenses/lens-a-sqlite-durability.md))
  and left it open. (needs human input)

### fence-a-mixed-skew-install-is-reached

Type: reachability
Reachability: default-production — both halves are shipped defaults: the
TypeScript fence on `context.db` and the unfenced newer direction on `store.db`.
Status: active
Exercised: not yet — no cross-runtime campaign constructs the state. Part 5's
`ci.yml:257` covers the TypeScript half in isolation; nothing exercises the pair.
Guarantee: A campaign reaches the operational state in which one install, at one
version skew, has `context.db` refused by the fence while `store.db` is opened
and written by the same older binary generation.
Check: `sometimes` — at least once per campaign, observe a run in which
`getSchemaFenceRejection()` is non-null for `context.db` and a Rust
`McStore::open` on the paired `store.db` returns `Ok` with a recorded version
above the binary's ceiling. `sometimes` rather than `reachable` because
executing both code paths proves nothing; the situation is the two verdicts
co-occurring on one install, which is situation coverage.
Fault/timing angle: the enabling window is a partial upgrade. The scope map
records the fence message naming this cause: "A pinned or stale plugin is likely
sharing this database with a newer instance" (`storage-db.ts:678`).
Required faults and enabling state: run a newer binary generation once against a
fresh install so it advances both `schema_migrations` past 90 and
`cortexkit_schema_version` past the Rust ceiling, then run an older generation.
No fault injection; version skew is the whole input.
Confidence: high — [evidence](../evidence/fence-a-mixed-skew-install-is-reached.md).
Both halves verified independently at `HEAD`: the TypeScript refusal at
`storage-db.ts:669-680` and the Rust fall-through at
`mc-store/src/lib.rs:1383`, the latter cited from Part 3.
Existing check: none spanning both runtimes. Status `unaudited`.
Impact: this is the state in which the product's two durable stores disagree
about whether they may be written, and it is the state every other record in
this lens is ultimately about. Without reaching it, the asymmetry stays a
reading of two files rather than an observed behaviour.
Open questions:
- Which harness can drive both runtimes at two versions? `packages/e2e-tests` is
  excluded from Part 5 as harness but may be the only place this fits.
  Unresolved, needs a harness-fit decision from the fault-map pass.

## Contract-vs-code leads

**L1. The scope map says the fence throws; it logs.**
Scope map
[:143-147](../../part-5-ts-surfaces/_lenses/scope-map-and-risk-ranking.md)
versus `storage-db.ts:677-680`. Both sides cited in O1 and record 2. Not
resolved in favour of the doc.

**L2. The fence message forbids reset; a sibling path recommends it.**
`storage-db.ts:678` ends "Do not reset this database: a newer binary owns it."
`storage-db.ts:701` recommends `doctor reset-db` for any family whose marker is
not `present`, including `malformed-marker`. The comment at `:663-666` states
the harm this creates. Record 4.

**L3. The fence's completeness claim versus the fork-lane filter.**
`storage-db.ts:648-650` says "Every family reaches this check, accepted or not",
and `storage-session-runtime-schema.ts:120-127` says the single fence row makes
"every legacy build fail closed". Both are about the *families* reached, and
neither is false, but `:192-194` bounds the lane read at 10_000, so the check
every family reaches cannot see a fork lane. Record 9.

**L4. Two fences claiming one property with different arms.**
`storage-db.ts:669` compares version and epoch; `schema-fence-probe.ts:84`
compares version only, against a non-overridable constant. Both are described as
the schema fence. Record 7.

**L5. A shared cross-runtime fixture that only one runtime enforces.**
`crates/mc-store/src/sqlite_runtime.rs:3-6` names the TypeScript fixture as "the
cross-runtime source of truth" and says an integration test proves the module
against it. It does not claim enforcement, and there is none. Record 11.

**L6. Part 3's `store.db` format-identity finding versus
`docs/migration-version-lanes.md`.** Part 3 records that the doc defines family
identity by `application_id`, `user_version`, a marker row, an incarnation ID, a
manifest digest and an exact schema inventory, and that "For `store.db` none of
these are set or checked"
([part-3 lens-a:529-539](../../part-3-store-core/_lenses/lens-a-sqlite-durability.md)).
Carried forward as context for records 10 and 11, not re-derived. I did not read
`docs/migration-version-lanes.md` in this pass.

## Open questions

Grouped by what would resolve them.

**Resolvable by a sweep this pass did not run.**

- Is there a specification for the fence outside `storage-db.ts`'s own doc
  comments? The scope map raised the same question for the outbox
  ([scope map:756-761](../../part-5-ts-surfaces/_lenses/scope-map-and-risk-ranking.md)).
  I found the fence contract restated at
  `storage-session-runtime-schema.ts:120-127` and referenced in
  `shared/rpc-types.ts:216`, both code. `docs/migration-version-lanes.md` exists
  and Part 3 quotes it; I did not read it. Unresolved.
- Does `doctor-repair-db.ts` or `doctor-reset-db.ts` respect the fence before
  destroying? `packages/cli/src/lib/database-access.ts:100-108` and `:279-285`
  open `context.db` read-write without going through `openDatabase`. That is 5d
  scope, but it is the other half of record 4's impact. Unresolved.

**Design decisions.**

- Should `malformed` collapse to epoch `0` alongside `absent`? Record 3.
- Should a `malformed-marker` family get its own guidance string? Record 4.
- Should `refuse_pre_cutover_store` gain an above-ceiling arm, or should
  `store.db` adopt the marker vocabulary `sqlite_runtime` already defines?
  Records 10 and 11.
- Should the env override reject trailing garbage rather than accepting
  `parseInt`'s prefix? Record 6.
- Is a per-call `latestSupportedVersion` meaningful against a process-cached
  handle? Record 8.

**Needs a harness decision.**

- Which harness can drive two runtimes at two versions for record 12?
