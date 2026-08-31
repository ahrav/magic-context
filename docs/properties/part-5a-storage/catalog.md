# Part 5a property catalog: storage fence, claim outbox, and authority

Scope: sub-part 5a of Part 5, ranked the highest-risk material in the part. Ten
units in `packages/plugin`. `features/magic-context/storage-db.ts` (933 lines)
holds the newer-schema fence and the only `context.db` open path.
`features/magic-context/migrations.ts` (6) is the constant file the fence reads
its ceiling from. `features/magic-context/storage-meta-persisted.ts` (2,735),
`features/magic-context/storage.ts` (324), and
`features/magic-context/storage-claim-memory-schema.ts` (464) are the schema and
persisted-meta surface. `features/magic-context/memory/storage-claim-operations.ts`
(2,341) holds the checkpoint advance,
`features/magic-context/memory/storage-claim-policy.ts` (776) the policy
projection, `features/magic-context/context-authority.ts` (1,484) the authority
lifecycle, and `hooks/magic-context/module-state-sync.ts` (2,635) the outbox
producer and its drain. `features/magic-context/storage-historian-runs.ts` (138)
is read as a boundary only; 5c owns its writers.

Out-of-scope files cited throughout because a load-bearing mechanism sits inside
them: `features/magic-context/storage-format-epoch.ts` (the marker reader and the
family classifier the fence consumes), `features/magic-context/schema-fence-probe.ts`
(the child-spawn probe, a second guard claiming the same property),
`features/magic-context/storage-session-runtime-schema.ts` (the fence stamp and
the three notes authority triggers), `hooks/magic-context/module-wire.ts` and
`hooks/magic-context/module-transport.ts` (the delivery encode and decode),
`hooks/magic-context/hook.ts` (the drain's only production caller),
`features/magic-context/transform-decision-log.ts` (a second read-write
connection to the fenced path), `crates/mc-store/src/lib.rs` and
`crates/mc-store/src/sqlite_runtime.rs` (the Rust half of the fence asymmetry),
and `crates/mc-module/src/lib.rs:10184-10255` (the consumer, cataloged by Part
4d).

Provenance: `/local/home/ahrav/scratch/magic-context`, `HEAD` = `e447c927`
("refactor(shm): trim final review leftovers"). Method contract in
[../METHOD.md](../METHOD.md). Scope, region maps, and CI facts from
[../part-5-ts-surfaces/_lenses/scope-map-and-risk-ranking.md](../part-5-ts-surfaces/_lenses/scope-map-and-risk-ranking.md).
Two lens passes produced the records:
[_lenses/lens-a-schema-fence.md](_lenses/lens-a-schema-fence.md) (12 records,
`fence-a-` prefix) and
[_lenses/lens-b-outbox-authority.md](_lenses/lens-b-outbox-authority.md) (11
records, `outbox-b-` prefix). Records below are the lens text unchanged; only the
evidence link paths were rewritten for this directory. The group names and their
ordering are this synthesis pass's own and carry no lens authority.

**Stability caveat, from the scope map.** `packages/plugin` is **mixed**, not
stable. Two directories inside it were excluded from all of Part 5 as actively
moving: `src/shared/mc-host-client/` (5,944 production lines, still being edited
at `HEAD~1..HEAD`) and `src/shared/mc-host-lifecycle/` (4,769 lines). Together
that is 10,713 lines, 5.9 percent of the package. Everything 5a scopes sits
outside both, and the ten files above are in the stable remainder. The
`module-transport.ts` boundary file cited above changed 19 lines at
`HEAD~6..HEAD` and is read, not cataloged.

**One arithmetic correction to the scope map, carried here so later parts inherit
the right number.** The scope map lists 5a as "10 units, 11,698 lines". The ten
files sum to 11,836 at `HEAD`; 11,698 is the sum of the first nine, excluding the
boundary-only `storage-historian-runs.ts` (138). Both figures are defensible
descriptions of the set and neither changes a record. Line counts above are
`wc -l` at `HEAD`.

## What this part is about

Every earlier part's dominant finding was **absent coverage**. Part 4 recorded
that 926 of `mc-module`'s 938 tests never run and that six of seven integration
binaries are never invoked. That is not the situation here, and the difference has
to lead, because it changes what a hazard even looks like.

**The coverage is real.** `.github/workflows/ci.yml:256-257` is a single step,
`bun run test`, in the `check-plugin` job (`ci.yml:225-227`). Root
`package.json`'s `test` script is
`sh scripts/test-shard.sh packages/plugin && bun run --cwd packages/pi-plugin test
&& bun run --cwd packages/cli test && bun run --cwd packages/retina-local-fs test`,
each package script a bare `bun test` that discovers every `*.test.ts` beneath it.
That one step executes **482 test files**: 371 in `packages/plugin`, 74 in
`pi-plugin`, 36 in `cli`, 1 in `retina-local-fs`. That is 100 percent of the test
files in every package Part 5 scopes, and every test naming a 5a file is inside
it. Counted at `HEAD` the repository holds 596 test files under the same pruning,
not the 590 the scope map states; the six-file difference is the root
`scripts/` suite, which the scope map inventories separately at `ci.yml:55`,
`:80`, and `:381`. The 482 figure and the 100-percent claim both hold.

So the hazards here are different in kind. They are **drift between this
TypeScript implementation and the Rust one**, and **guards that exist on one side
only**. Seven facts frame every record below.

**1. The newer-schema fence is the only guard stopping an older binary from
writing a database a newer one owns, and it logs and returns null rather than
throwing.** `refuseNewerSchemaFence` (`storage-db.ts:651-681`) reads the version
lane, collapses the marker status to an epoch, and accepts only when
`persistedVersion <= latestSupportedVersion && persistedEpoch <= DIRECT_FORMAT_EPOCH`
(`:669`). On refusal it latches a rejection record (`:672`), composes a lane name
(`:673-676`), calls `log(...)` (`:677-679`), and returns `true` (`:680`). There is
no `throw` in it. Both call sites then do the same two things:
`recordFormatRefusal` runs the fence first and returns early (`:689`), and the
accepted-path call at `:777` is followed by `closeQuietly(db); return null;`
(`:778-779`), matching the refusal path at `:770-771`. **This corrects the scope
map**, which records the fence as "enforced at `:678`, which throws"
([scope map:143-147](../part-5-ts-surfaces/_lenses/scope-map-and-risk-ranking.md)).
The message text at `:678` is quoted correctly there; "throws" is not. The only
`throw` in `openDatabase` is `:860-862`, from the `catch` at `:855`, for a genuine
open error. A refusal reaches a caller as `null`, and no byte of the family
changes: `PRAGMA journal_mode=WAL` is deliberately deferred to `:782`, after the
verdict. This matters beyond pedantry, because it decides what a test asserts and
because a caller that guards only with `try/catch` treats a refusal as a
successful open of nothing. Records 1, 2, and 5.

**2. The guards point in opposite directions across the language boundary, so one
skew yields two verdicts.** This TypeScript fence refuses a **newer** database.
Part 3 established that the Rust store's fence guards only **below** its cutover:
`refuse_pre_cutover_store` (`crates/mc-store/src/lib.rs:1375-1385`) matches
`Some(recorded) if recorded < OLDEST_ADOPTABLE_MIGRATION_VERSION` and every other
case, including a recorded version above the ceiling, falls through to the
permissive `_ => Ok(())` arm at `:1383`. Verified at `HEAD` and cited from Part 3
rather than re-derived. The two runtimes own different files, which is itself a
correction to the task's framing: Rust's fenced store is `store.db` and
TypeScript's is `context.db`, and `mc-module` says twice that it never opens
`context.db` (`crates/mc-module/src/lib.rs:15451`, `:26264`). So the fence is not
being flanked on its own file. What exists instead is worse than a missing guard:
at one version skew, one install **fails closed** on `context.db` and **fails
open** on `store.db`, and the two hold halves of one claim protocol
(`mc-store/src/lib.rs:11018` stages "one claim command before the host mutates
`context.db`"). The user-visible symptom is Magic Context announcing itself
disabled while the module keeps writing. Records 10 and 12.

**Sharper still, Rust defines the fence vocabulary and never calls it.**
`crates/mc-store/src/sqlite_runtime.rs` declares itself as sharing "one
vocabulary (application ID, format epoch, marker and manifest digests) with the
TypeScript host" and names
`packages/plugin/src/features/magic-context/fixtures/direct-format-vocabulary-v1.json`
as "the cross-runtime source of truth" (`:3-6`). It defines `MC_APPLICATION_ID`,
`DIRECT_FORMAT_EPOCH`, `DIRECT_FORMAT_MARKER_TABLE`,
`FORMAT_MARKER_DIGEST_PROTOCOL`, `SCHEMA_MANIFEST_PROTOCOL`,
`compute_schema_manifest_digest`, and `compute_marker_digest`. Verified at
`HEAD`: a search for `sqlite_runtime` across `crates/` excluding
`crates/mc-store/tests/` returns exactly three hits, and the only one that is a
use rather than the file's own text is `pub mod sqlite_runtime;` at
`mc-store/src/lib.rs:17`; the single `sqlite_runtime::` reference in the tree is
inside `crates/mc-store/tests/sqlite_runtime.rs`. Both runtimes' `DIRECT_FORMAT_EPOCH`
is `1`, they agree by fixture, and only one of them gates an open. A shared
checked-in fixture plus a passing integration test creates a reasonable and false
impression that both runtimes enforce one format identity. Record 11.

**3. The real blind spots are not where the scope map said.** The scope map flags
`storage-db.ts:774` as "a stated blind spot". Read in place, `:773-776` is a
**rationale for a second fence call that closes a hole**, not an admission of one:
"The fence is checked on the accepted path too, not only on refusal. Object-name
identity cannot see a fence a newer binary moved without renaming anything, so
skipping this here would leave the one family that reaches real queries as the
only one never proving its vintage." The undetectable thing is a vintage change
that renames no schema object, and the `:777-780` call is what catches it. There
is a dedicated test. Record 5 carries the fix; the genuine gaps are two others.

The first is that **a malformed marker collapses to epoch zero, so an unparseable
newer marker passes the decisive arm.** `storage-db.ts:668` is
`marker.status === "present" ? marker.marker.formatEpoch : 0`, repeated at
`:691`. `readDirectFormatMarker` returns `malformed` for a digest mismatch, an
out-of-range epoch, or an unreadable marker table
(`storage-format-epoch.ts:194-232`), and `0 <= DIRECT_FORMAT_EPOCH` is true, so
the epoch arm of `:669` passes unconditionally for it. `absent` collapsing to zero
is correct, because a legacy database has no marker. `malformed` is not, and the
code itself calls the epoch the deciding signal: `:663-666` says "The marker's
format epoch is the signal that actually distinguishes a database this build is
too old to read from one it must refuse". A newer binary that bumps
`FORMAT_MARKER_DIGEST_PROTOCOL` without bumping the migration lane produces
exactly this input, and then the version arm is the only remaining catch. Worse,
the same input reaches `recordFormatRefusal`'s guidance composition, where
`manifestOnly` requires `marker.status === "present"` (`:695-698`) and therefore
fails, so `:701` recommends `doctor reset-db` — the one action the fence's own
message at `:678` forbids, for the reason stated at `:663-666`. Records 3 and 4.

The second is that **a lane bound makes fork vintage unreadable.**
`getPersistedSchemaVersion` (`storage-db.ts:183-196`) reads
`MAX(version) FROM schema_migrations WHERE version < ?` bound to
`FORK_MIGRATION_VERSION_FLOOR`, which is `10_000` (`migrations.ts:2`, whose own
comment at `:1` reserves that space "for downstream migrations"). So no row at or
above the floor can raise `persistedVersion`, and a downstream fork's newer
database presents as version 90 to an upstream binary. The filter is deliberate
and tested at the child-spawn probe, not at `openDatabase`. Record 9.

**4. The outbox checkpoint advance is the point of no return.** It is the commit
of the `INSERT ... ON CONFLICT(consumer, project_id) DO UPDATE SET
acked_effect_id = excluded.acked_effect_id` at
`memory/storage-claim-operations.ts:2261-2266`, reached through the
`db.transaction(...).immediate()` at `module-state-sync.ts:2328-2345`, which is
the statement immediately after the acknowledgement equality check at
`:2323-2327`. Both readers select strictly above the checkpoint with the same
predicate, `effects.id > COALESCE(checkpoint.acked_effect_id, 0)`
(`module-state-sync.ts:1779` and `:2263`), so an absent row reads as zero and the
committed value means exactly: no effect at or below this id will ever be selected
for this consumer again. The prefix becomes permanently unselectable. Verified at
`HEAD` by searching for the table name across the tree: one `SELECT`, one upsert,
one prune aggregate, and the two drain joins. **No `DELETE`, no downward `UPDATE`,
no reset, and zero references anywhere under `crates/`.** The same function that
performs the advance is the function that forbids undoing it, rejecting regression
at `:2222-2226`. A crash in the single `await` before the commit is the safe
direction: the checkpoint has not moved and the next drain re-delivers. The unsafe
direction is not a crash. Records 13 and 19.

**5. The producer cannot verify the thing that matters.** It runs a genuinely
careful guard chain, and every link in it is a check on itself or on a value it
supplied. It can verify local durability (`proveClaimOperationDurable`,
`module-state-sync.ts:2143-2203`), the declared effect count (`:2156-2158`,
re-checked at `:2292-2297`), effect-key uniqueness (`:2160-2162`), the
strictly-above prefix (`:2298-2309`), regression (`storage-claim-operations.ts:2222-2226`),
the beyond-tail bound (`:2237-2245`), the receipt-split bound (`:2246-2259`), and
the protocol version (`module-wire.ts:620-624`). It **cannot** verify that the
consumer wrote anything, that its store was open, or that it is the named
consumer, because the expected effect id is read back out of the request itself:
`module-state-sync.ts:2318` takes `proof.effects.at(-1)?.id` from the outgoing
delivery and `:2323` compares the ack to it, and the transport derives its own
`expectedEffectId` the same way (`module-transport.ts:1076-1081`) for the
independent check in the decoder (`module-wire.ts:717-735`). Two independent
checks of the same tautology. Part 4d established the module side:
`handle_claim_effects_apply` (`crates/mc-module/src/lib.rs:10184-10255`) returns
`"ackedEffectId": previous`, the last delivered id, and never calls
`self.store()`. Verified at `HEAD`. So the acknowledgement can be **truthful
about nothing**, and the checkpoint's meaning is unenforceable. Records 14, 23,
and 20.

**6. No reconciliation exists for the claim lane.** Three lanes, three different
answers. Notes get a real reset-and-repull: `reconcileAuthorityProject`
(`context-authority.ts:610-659`) deletes `mirror_identity` and
`mirror_note_revisions`, zeroes `mirror_cursors`, and pulls pages until
exhausted. The claim mirror reseeds per process (`module-state-sync.ts:1986-1994`).
The claim **effects** lane has a durable cursor that survives restarts, no seeding
protocol, and no detector. Verified at `HEAD`: `reconcileAuthorityProject` takes a
`projectPath` and no domain, and its loop is
`for (const domain of ["notes"] as const)` at `:617`, a one-element loop that
excludes `memories`. Part 3 established that the claim mirror's divergence is
prevented at admission and never detected afterwards; this is the producer-side
confirmation that the other end has no detector either. Divergence is permanent
and silent on both sides. Records 19 and 20.

**7. The identity-format defect Part 3 found is not reachable from this
producer.** Say this explicitly, because it means the naive Rust-side fix would be
fatal. Part 3's `intent-control-transition-write-is-silently-dropped` records that
Rust's `set_claim_intent_transition_tx` returns `Ok(())` without writing when its
`database_incarnation_id` argument is not 32 lowercase hex, and that all four call
sites pass `context_store_uuid`, which production mints as a dashed UUID. This
producer is not one of those callers. It supplies a validated 32-hex incarnation:
`hook.ts:958` reads it from `readDirectFormatMarker(db)`, which rejects a marker
whose incarnation fails `isValidDatabaseIncarnationId`
(`storage-format-epoch.ts:222-224`), and that predicate is `/^[0-9a-f]{32}$/`
over a value minted as `randomBytes(16).toString("hex")`. The dashed
`randomUUID()` from `ensureContextStoreUuid` (`context-authority.ts:445-457`) is
a **different** identity travelling the same wire as `context_store_uuid`. So
repairing Rust's guard without changing its argument would put a
`context_store_uuid` in the column and make every comparison against this
producer's correct value fail `IncarnationMismatch`. Record 21.

### How the records are ordered

The framing decides the order. Groups A through C establish what the TypeScript
fence is, then where it fails open, before Group D states the cross-language split
those groups build toward. Groups E through G do the same for the outbox: the
point of no return and the empty acknowledgement first, then the guards that do
work and where they stop, then the three absences. Groups D and E are the two the
framing points at; the rest are the reading order needed to make them land.

## Index

Twenty-three records, in group order. Semantics distribution is 19 `always`,
3 `sometimes`, 1 `always-or-unreached`, and no `reachable` or `unreachable`.
Reachability is 22 `default-production` and 1 `explicit-config-only`, with no
`test-only` record. In this part `default-production` means reachable in a shipped
plugin install.

| Slug | Type | Confidence |
| --- | --- | --- |
| [fence-a-older-binary-never-writes-a-newer-database](#fence-a-older-binary-never-writes-a-newer-database) | safety | high |
| [fence-a-refusal-is-a-null-return-not-a-throw](#fence-a-refusal-is-a-null-return-not-a-throw) | safety | high |
| [fence-a-accepted-path-proves-vintage](#fence-a-accepted-path-proves-vintage) | safety | high |
| [fence-a-malformed-marker-reads-as-epoch-zero](#fence-a-malformed-marker-reads-as-epoch-zero) | safety | high |
| [fence-a-unclassifiable-family-must-not-get-reset-guidance](#fence-a-unclassifiable-family-must-not-get-reset-guidance) | safety | high |
| [fence-a-fork-lane-versions-are-invisible-to-the-fence](#fence-a-fork-lane-versions-are-invisible-to-the-fence) | safety | high |
| [fence-a-env-override-relaxes-only-the-version-arm](#fence-a-env-override-relaxes-only-the-version-arm) | safety | high |
| [fence-a-child-spawn-probe-omits-the-epoch-arm](#fence-a-child-spawn-probe-omits-the-epoch-arm) | safety | medium |
| [fence-a-telemetry-connection-outlives-the-fence](#fence-a-telemetry-connection-outlives-the-fence) | safety | high |
| [fence-a-rust-store-has-no-newer-schema-fence](#fence-a-rust-store-has-no-newer-schema-fence) | safety | high |
| [fence-a-rust-ships-the-fence-vocabulary-uncalled](#fence-a-rust-ships-the-fence-vocabulary-uncalled) | safety | high |
| [fence-a-mixed-skew-install-is-reached](#fence-a-mixed-skew-install-is-reached) | reachability | high |
| [outbox-b-checkpoint-advance-is-the-point-of-no-return](#outbox-b-checkpoint-advance-is-the-point-of-no-return) | safety | high |
| [outbox-b-acknowledgement-is-an-echo-of-the-delivered-prefix](#outbox-b-acknowledgement-is-an-echo-of-the-delivered-prefix) | safety | high |
| [outbox-b-checkpoint-advances-against-a-module-with-no-open-store](#outbox-b-checkpoint-advances-against-a-module-with-no-open-store) | reachability | medium |
| [outbox-b-multi-receipt-backlog-drain-occurs-in-a-campaign](#outbox-b-multi-receipt-backlog-drain-occurs-in-a-campaign) | reachability | high |
| [outbox-b-checkpoint-monotonicity-is-application-enforced-only](#outbox-b-checkpoint-monotonicity-is-application-enforced-only) | safety | high |
| [outbox-b-checkpoint-never-passes-the-outbox-tail](#outbox-b-checkpoint-never-passes-the-outbox-tail) | safety | high |
| [outbox-b-checkpoint-never-splits-a-receipt-group](#outbox-b-checkpoint-never-splits-a-receipt-group) | safety | medium |
| [outbox-b-no-repair-path-lowers-or-rebuilds-a-claim-consumer-checkpoint](#outbox-b-no-repair-path-lowers-or-rebuilds-a-claim-consumer-checkpoint) | safety | high |
| [outbox-b-effects-are-never-pruned-in-a-shipped-install](#outbox-b-effects-are-never-pruned-in-a-shipped-install) | safety | high |
| [outbox-b-authority-write-fence-covers-notes-but-not-claim-tables](#outbox-b-authority-write-fence-covers-notes-but-not-claim-tables) | safety | high |
| [outbox-b-intent-binding-incarnation-is-hex-validated-outbound-only](#outbox-b-intent-binding-incarnation-is-hex-validated-outbound-only) | safety | high |

---

## Group A: what the fence is, and how a refusal is delivered

Three records on the guard itself. The first is the no-byte-changed claim on
refusal, the second is the delivery mechanism a caller has to get right, and the
third is the second call site that covers the one family reaching real queries.
They share a cause worth naming up front: the fence runs on a connection that has
already set `busy_timeout` and `foreign_keys` (`storage-db.ts:758-759`) but has
**not** yet enabled WAL, which is deferred to `:782` precisely so a refusal cannot
create a `-wal` file. That deferral is what makes the no-byte-changed claim
structural rather than incidental, and it is why the third record's unfenced read
window between `:777` and the first application query is worth a question.

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
Confidence: high — [evidence](evidence/fence-a-older-binary-never-writes-a-newer-database.md).
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
Confidence: high — [evidence](evidence/fence-a-refusal-is-a-null-return-not-a-throw.md).
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
Confidence: high — [evidence](evidence/fence-a-accepted-path-proves-vintage.md).
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

## Group B: fail-open arms inside the fail-closed fence

Four records on inputs that pass a guard built to stop them. The accept condition
at `storage-db.ts:669` is a two-arm conjunction and each record attacks a
different way an arm goes quiet: the epoch arm reads an unparseable marker as the
oldest possible value, the guidance composed for that same input recommends the
destruction the fence's own message forbids, the version arm cannot see a lane
above `FORK_MIGRATION_VERSION_FLOOR`, and the version ceiling is overridable by
environment variable while the epoch is not. The first three are
`default-production`; the fourth is the part's only `explicit-config-only` record
and is here because it is the one arm-relaxation that turns out to be **safe** by
design, which is worth recording next to three that are not.

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
Confidence: high — [evidence](evidence/fence-a-malformed-marker-reads-as-epoch-zero.md).
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
Confidence: high — [evidence](evidence/fence-a-unclassifiable-family-must-not-get-reset-guidance.md).
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
Confidence: high — [evidence](evidence/fence-a-fork-lane-versions-are-invisible-to-the-fence.md).
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
Confidence: high — [evidence](evidence/fence-a-env-override-relaxes-only-the-version-arm.md).
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

## Group C: a second guard and a second connection

Two records on things that claim or hold what the fence decided, and disagree with
it. `probeChildSpawnFence` (`schema-fence-probe.ts:70-101`) is described as the
schema fence and compares the version lane only, against the non-overridable
constant, so an epoch-only skew passes a gate that every historian, recomp,
dreamer, and sidekick child must clear. The transform decision log caches a
separate read-write `Database` per path (`transform-decision-log.ts:390-405`) that
`closeDatabase` (`storage-db.ts:920-931`) never clears, so it stays writable
across a subsequent refusal. Grouped because both are the same shape: the fence's
verdict is not the only verdict in the process, and neither of these two consults
it.

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
Confidence: medium — [evidence](evidence/fence-a-child-spawn-probe-omits-the-epoch-arm.md).
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
Confidence: high — [evidence](evidence/fence-a-telemetry-connection-outlives-the-fence.md).
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

## Group D: the cross-language split, and the state that exhibits it

Three records, and this is the group the framing points at. The first two are the
matched pair of asymmetries: Rust's store fences the older direction only and
falls through on newer, and Rust separately ships the whole shared fence
vocabulary and calls none of it. The third is the operational state in which those
two readings become an observed behaviour rather than a reading of two files, and
it is one of the part's three `sometimes` records because executing both code
paths proves nothing; what must occur is the two verdicts co-occurring on one
install. Note the reachability labels carefully: all three are
`default-production` because the shipped default on each side is what produces
the split. Record 11's `default-production` is the unusual one, and it is correct
for the stated reason: the finding **is** that no production path calls the
module, so the uncalled state is the default state.

### fence-a-rust-store-has-no-newer-schema-fence


Type: safety
Reachability: default-production — `refuse_pre_cutover_store` is called at
`mc-store/src/lib.rs:4873` inside `McStore::open`, per
[part-3 lens-a:89](../part-3-store-core/_lenses/lens-a-sqlite-durability.md).
Status: active
Exercised: not yet on the newer direction — Part 3 records
`fresh_and_current_module_stores_open_without_a_pre_cutover_refusal`
(`lib.rs:16140`) and
`pre_cutover_module_store_is_refused_by_family_not_by_ddl_collision`
(`lib.rs:16089`) as the existing checks, both about the older direction or the
happy path
([part-3 lens-a:413](../part-3-store-core/_lenses/lens-a-sqlite-durability.md),
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
([part-3 lens-a:490](../part-3-store-core/_lenses/lens-a-sqlite-durability.md)).
Required faults and enabling state: a `store.db` whose
`cortexkit_schema_version` `MAX(version)` for namespace `mc_cache` exceeds the
binary's ceiling. Produced by running a newer binary then an older one on the
same install.
Confidence: high — [evidence](evidence/fence-a-rust-store-has-no-newer-schema-fence.md).
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
Confidence: high — [evidence](evidence/fence-a-rust-ships-the-fence-vocabulary-uncalled.md).
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
([part-3 lens-a:529-539](../part-3-store-core/_lenses/lens-a-sqlite-durability.md)).
This record names the mechanism by which the impression arises.
Open questions:
- Is `sqlite_runtime` staged for a later wiring into `McStore::open`? Part 3
  asked the adjacent question about `compute_schema_manifest_digest`
  ([part-3 lens-a:432](../part-3-store-core/_lenses/lens-a-sqlite-durability.md))
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
Confidence: high — [evidence](evidence/fence-a-mixed-skew-install-is-reached.md).
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

## Group E: the point of no return and the acknowledgement that justifies it

Four records, and with Group D this is where the part's weight sits. The first
names the irreversible commit and the absence of any path that undoes it. The
second is the reason that matters: the ack is an echo of a value the producer
supplied, checked twice, so the advance is justified by nothing the consumer did.
The third and fourth are the two `sometimes` records that turn the argument into
an observation, one by reaching a delivery accepted while the consumer provably
had no store to write to, the other by reaching a backlog so that the ordering
guarantees the drain invests in are exercised outside the degenerate one-group
case. Read them together: records 13 and 14 state a deficiency in the information
content of a response, and records 23 and 22 are the campaign situations under
which a harness sees it.

### outbox-b-checkpoint-advance-is-the-point-of-no-return


Type: safety
Reachability: default-production
Status: active
Exercised: partial — `context-authority-crash.test.ts:330-370` drives the advance
under injected crashes, but against a consumer fake that applies
(`:214-231`), so it proves the crash ordering and not the irreversibility.
Guarantee: Once a consumer checkpoint commits at effect id N, no code path in
either tree can cause effects at or below N to be selected for that consumer
again, so the advance must never commit for a prefix whose delivery obligation
is unfulfilled.
Check: `always` — at every commit of the upsert at
`storage-claim-operations.ts:2260-2266`, assert the committed `acked_effect_id`
is greater than or equal to the prior value and that the delivering call
returned without error. `always` rather than `always-or-unreached` because the
advance is on the mandatory settle path of every module-mode memory mutation
(`hook.ts:974-988`), so it is evaluated on every such operation.
Fault/timing angle: The single `await` between `deliver` returning at
`module-state-sync.ts:2322` and the transaction committing at `:2345`. A crash
inside it is the safe direction; the checkpoint stays put and the next drain
re-delivers.
Required faults and enabling state: None to reach the advance. To make the
advance harmful, a consumer that returns the expected id without retaining the
prefix, which is the shipped consumer per Part 4d.
Confidence: high — [evidence](evidence/outbox-b-checkpoint-advance-is-the-point-of-no-return.md).
Verified the advance site, the two read predicates, the absence of any lowering
path via a repository-wide search for the table name, and that the table has no
`crates/` reference.
Existing check: `storage-claim-operations.test.ts:1018-1058` asserts regression
throws (status: unaudited). No check asserts that no repair path exists.
Impact: A silently unfulfilled delivery obligation with no missing row to
notice it by. The claim mirror the module serves diverges from the producer's
claim store for the life of the database.
Open questions:
- Should a checkpoint reset exist at all, or is the design intent that a
  divergent consumer is repaired only by whole-database reset? (needs human
  input)

### outbox-b-acknowledgement-is-an-echo-of-the-delivered-prefix


Type: safety
Reachability: default-production
Status: active
Exercised: not yet — every existing test supplies a `deliver` closure that
either applies the receipt (`context-authority-crash.test.ts:214-231`) or is a
pure echo (`module-state-sync.test.ts:1409-1415`); neither distinguishes the
two, which is precisely the property.
Guarantee: The producer's checkpoint advance is justified by evidence the
consumer durably applied the delivered prefix, not merely by the consumer
returning a value the producer already knew.
Check: `always` — at every advance, assert the producer holds at least one fact
about the consumer's state that was not derivable from the request it just
sent. Today the assertion fails by construction, so the implementable form is
the coverage-check pair in the evidence file: assert the independent
preconditions (an ack was accepted, and the accepted value equals
`request.receipt.effects.at(-1).id`) rather than the violation.
Fault/timing angle: None. No interleaving is required; the deficiency is in the
information content of the response, not its timing.
Required faults and enabling state: None. Default module-mode operation.
Confidence: high — [evidence](evidence/outbox-b-acknowledgement-is-an-echo-of-the-delivered-prefix.md).
Verified both equality checks, the transport's derivation of `expectedEffectId`
from the outgoing request, and Part 4d's module-side reading at `HEAD`.
Existing check: `module-wire.ts:729-733` and `module-state-sync.ts:2323-2327`
both enforce the echo (status: unaudited). Part 4d records that
`decodeClaimEffectDeliveryResponse` has zero test references.
Impact: The checkpoint's meaning is unenforceable. Everything downstream of it
in this lens rests on an ack that carries no information.
Open questions:
- Is `claim.effects.apply` intended to apply, or is it a protocol-conformance
  ack with the mirror lane as the only writer? Part 4d left this open and it is
  the same question. (needs human input)

### outbox-b-checkpoint-advances-against-a-module-with-no-open-store


Type: reachability
Reachability: default-production
Status: active
Exercised: not yet — no test on either side drives a delivery while the module's
store is opening.
Guarantee: A campaign reaches at least one delivery accepted while the consumer
cannot possibly have applied it, so the producer's inability to distinguish that
case is observed rather than argued.
Check: `sometimes` — mark `EFFECTS_ACK_ACCEPTED_DURING_STORE_OPENING` when a
delivery is accepted and the module's store phase is `STORE_OPENING`. Assert the
two independent preconditions separately, per METHOD.md's coverage-check rule:
the ack was accepted, and the module reported a non-ready store phase in the
same window. Neither marker observes a defect, so both fire on a correct
implementation too.
Fault/timing angle: The store-open window itself. Part 4d records that during
`STORE_OPENING` (`lib.rs:12007-12011`) `claim.intent.stage` returns
`store_unavailable_error` (`:10097-10099`) while `claim.effects.apply` returns a
successful ack (`:10251-10254`), because the latter never calls `self.store()`.
Required faults and enabling state: A delivery timed into the module's store-open
window. Reaching it from the producer requires the intent to have staged before
the store closed and reopened, or a restart between staging and settling.
Confidence: medium — [evidence](evidence/outbox-b-checkpoint-advances-against-a-module-with-no-open-store.md).
Verified Part 4d's four module-side references at `HEAD`. The producer-side
sequencing that reaches the window is reasoned from `hook.ts:917-990` and not
constructed.
Existing check: none.
Impact: This is the cleanest possible demonstration that the ack carries no
information, and it needs no fault injection beyond timing: the producer commits
an irreversible checkpoint against a consumer that provably had no store to
write to.
Open questions:
- Can the producer observe the module's store phase at all from the claim path?
  `hook.ts:924` reads `authorityStatus`, not health. Unresolved, needs a pass
  over the transport's health surface, which 5c scopes.

### outbox-b-multi-receipt-backlog-drain-occurs-in-a-campaign


Type: reachability
Reachability: default-production
Status: active
Exercised: partial — `module-state-sync.test.ts:1400-1422` constructs exactly
this situation with two groups and asserts the delivery order, but with a
`deliver` closure that echoes. The situation is reached; the operational state
that makes it interesting is not.
Guarantee: A campaign produces at least one drain in which the unacknowledged
prefix contains a receipt group other than the one the current mutation just
committed, so ordering and partial-progress behaviour are observed rather than
assumed.
Check: `sometimes` — mark `EFFECTS_DRAIN_DELIVERED_BACKLOG_GROUP` when
`drainClaimEffectPrefix` delivers a group whose `receiptId` differs from
`throughReceiptId`. `sometimes` and not `reachable`: the loop at
`module-state-sync.ts:2256` executes its lines on every single mutation, so line
coverage says nothing; what must occur at least once is the *state* of a
non-empty prior backlog.
Fault/timing angle: The backlog only exists if a previous drain did not
complete. Reaching it needs an earlier delivery that failed after the receipt
committed and before the checkpoint advanced, or a mutation in a project whose
effects an earlier scoped drain excluded (observation 5).
Required faults and enabling state: One prior failed delivery, or two mutations
in projects that do not share a receipt. Both are producible with the existing
in-test consumer.
Confidence: high — [evidence](evidence/outbox-b-multi-receipt-backlog-drain-occurs-in-a-campaign.md).
Verified the scoping logic, the break at `:2351`, and the existing two-group
test.
Existing check: `module-state-sync.test.ts:1400-1422` (status: unaudited).
Impact: Without this situation, every observation of the drain is of the
degenerate one-group case, and the ordering guarantees the code invests in are
untested where they matter.
Open questions: None.

## Group F: the guards the producer does run, and where they stop

Three records on `advanceOutboxConsumerCheckpointInCurrentTransaction`'s own
rejections. Two of them are the part's strongest existing coverage: the
beyond-tail bound and the receipt-split bound each have a dedicated passing test.
The third is the structural gap underneath both, that the checkpoint table carries
zero triggers while every table the same schema fragment calls append-only carries
three to six, so all four guards live in one function and any other writer of the
file bypasses them. Grouped because the contrast is the point: this is careful,
well-tested, application-level enforcement of an invariant the database itself
does not hold, on the one mutable table whose corruption is unrecoverable.

### outbox-b-checkpoint-monotonicity-is-application-enforced-only


Type: safety
Reachability: default-production
Status: active
Exercised: partial — the TypeScript guards are covered
(`storage-claim-operations.test.ts:954-1058`), but no test writes the table
through any path other than the guarded function.
Guarantee: A checkpoint row's `acked_effect_id` never decreases and never
exceeds the outbox tail, for every writer of the database file, not only for
callers of `advanceOutboxConsumerCheckpointInCurrentTransaction`.
Check: `always` — after any transaction that modifies
`claim_outbox_consumer_checkpoints`, assert the new `acked_effect_id` is at
least the old one and at most `MAX(id)` of `claim_operation_effects`. `always`
because the invariant is claimed unconditionally by
`storage-claim-memory-schema.ts:286-288`.
Fault/timing angle: None required. The gap is structural: the table has no
triggers, so a direct `UPDATE` from any other connection bypasses all four
guards.
Required faults and enabling state: A writer other than the guarded function.
The CLI already opens the same file for mutation
(`doctor-authority.ts:174`, and the 5d-scoped `doctor-repair-db.ts` and
`migrate.ts`), and `storage-db.ts` exists precisely because other-version
binaries can reach the file.
Confidence: high — [evidence](evidence/outbox-b-checkpoint-monotonicity-is-application-enforced-only.md).
Verified the full trigger inventory of the claim-memory schema and confirmed
zero triggers name the checkpoint table.
Existing check: `storage-claim-operations.test.ts:1018-1058` covers the
in-process guards (status: unaudited). No check covers an out-of-band writer.
Impact: The one mutable table in an otherwise trigger-fenced schema is the one
whose corruption is silent and irreversible.
Open questions:
- Why does `claim_operation_effects` get a capability-gated delete trigger while
  its cursor table gets none? A deliberate trade or an oversight is not
  determinable from the code. (needs human input)

### outbox-b-checkpoint-never-passes-the-outbox-tail


Type: safety
Reachability: default-production
Status: active
Exercised: yes — `storage-claim-operations.test.ts:954-1016` asserts
`maxEffectId + 1` throws "beyond the outbox tail", then asserts the tail itself
is accepted and that re-acknowledging it after a full prune stays idempotent.
Guarantee: A checkpoint never claims to have observed an effect id that has not
been allocated, and the tail bound remains sound after pruning empties the
table.
Check: `always` — at each advance, assert `ackedEffectId <= COALESCE(MAX(id) of
claim_operation_effects, existing)`. `always` because the guard at
`storage-claim-operations.ts:2241-2245` is unconditional.
Fault/timing angle: The interaction with pruning. The tail falls back to the
existing cursor rather than zero (`:2240`), so an empty table does not force a
regression error on re-acknowledgement. The comment at `:2234-2236` states this
intent.
Required faults and enabling state: To exercise the fallback branch, a pruned
outbox, which in a shipped install never occurs (see
`outbox-b-effects-are-never-pruned-in-a-shipped-install`).
Confidence: high — [evidence](evidence/outbox-b-checkpoint-never-passes-the-outbox-tail.md).
Verified the guard, the fallback, and that the tail query carries no project
predicate while the write it authorizes is per project.
Existing check: `storage-claim-operations.test.ts:954-1016` (status: unaudited).
It does not cover the cross-project weakness in observation 2.
Impact: Stated in the code's own comment at `:2227-2232`: once every required
consumer holds a future cursor, the prune boundary becomes that future id and
effects allocated below it afterwards are deleted having never been published.
Open questions:
- Is the global `MAX(id)` deliberate, given the receipt-split guard beside it is
  project-scoped? A per-project tail would be strictly tighter. (needs human
  input)

### outbox-b-checkpoint-never-splits-a-receipt-group


Type: safety
Reachability: default-production
Status: active
Exercised: yes — `storage-claim-operations.test.ts:1018-1058` and
`module-state-sync.test.ts:1424-1441` both assert a mid-group id throws
"splits a receipt group".
Guarantee: A consumer's visible prefix never contains part of one claim
operation, so a page can never expose half an operation.
Check: `always` — at each advance, assert no `claim_operation_effects` row in
the project sits at or below `ackedEffectId` whose `receipt_id` also has a row
above it. `always` because the guard at `storage-claim-operations.ts:2246-2259`
is unconditional and the drain enforces the same thing from the other side at
`:2298-2309`.
Fault/timing angle: A receipt whose effects span more than one project. Then the
per-project advances at `module-state-sync.ts:2337-2343` happen inside one
transaction, so the intermediate state where one project has advanced and
another has not is never visible to a reader; but the split guard evaluates
against that intermediate state within the transaction.
Required faults and enabling state: A multi-project receipt to reach the
interesting case. Whether the claim operations that ship can produce one is
unresolved.
Confidence: medium — [evidence](evidence/outbox-b-checkpoint-never-splits-a-receipt-group.md).
Verified both guards and both tests. The multi-project ordering above is read
from the code and not constructed.
Existing check: the two tests above (status: unaudited). Both use
single-project receipts.
Impact: A consumer applies a fragment of an operation and treats it as
complete, which for a mirror means a claim at a revision its own operation never
finished producing.
Open questions:
- Can a shipped claim operation produce effects in more than one project? The
  advance loop and `vectorsAdvanceOneReceipt` (`module-state-sync.ts:1786-1809`)
  are both written as though it can. Unresolved, needs a pass over the claim
  operation writers in `storage-claim-operations.ts:1-2100`.

## Group G: no repair, no retention, no fence on the claim lane

Four records on things that are absent rather than wrong. No path lowers or
rebuilds a claim consumer checkpoint. Nothing in a shipped install ever calls the
prune the schema's retention contract describes. The authority write fence exists
at the database boundary for `notes` and for no claim table. And the incarnation
format check exists on encode and not on decode. The first three interact in a way
worth stating: because nothing prunes, no effect row is ever deleted, so a
checkpoint reset *would* recover a diverged consumer — the point of no return is
softened by an unwired retention path, and hardened again by the absence of the
reset. The fourth is in this group because it is the one record whose impact is
bounded today and whose value is as a warning about a fix elsewhere.

### outbox-b-no-repair-path-lowers-or-rebuilds-a-claim-consumer-checkpoint


Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test constructs a diverged consumer, because no test
uses a consumer that acks without applying.
Guarantee: For every consumer whose checkpoint has advanced, divergence between
the acknowledged prefix and the consumer's actual state is either detectable or
repairable.
Check: `always` — assert that for each `(consumer, project_id)` row, some
executable code path can either compare the acked prefix against the consumer's
state or reset the row. `always` and not `unreachable`: this is a forbidden
*state* (an undetectable, unrepairable divergence) with no dedicated detection
point, which METHOD.md's rule maps to `always(!X)` rather than `unreachable`.
Fault/timing angle: The clearest concrete window is an authority round trip. A
CLI `doctor drain-authority` run (`doctor-authority.ts:173-227`) returns
memories to TypeScript ownership and removes the marker
(`context-authority.ts:1128-1130`) without resetting either claim consumer's
checkpoint; a later `prepareAuthority` hands ownership back to a module whose
claim state was never seeded with the already-acked prefix.
Required faults and enabling state: No injected fault. An authority drain and a
re-prepare, both shipped operations, are sufficient to produce a module that has
never seen effects the producer records as delivered.
Confidence: high — [evidence](evidence/outbox-b-no-repair-path-lowers-or-rebuilds-a-claim-consumer-checkpoint.md).
Verified the absence of any checkpoint write other than the forward upsert, and
verified that `reconcileAuthorityProject` reconciles the notes mirror by reset
and re-pull while its domain loop excludes `memories`. The evidence file narrows
the gap: the notes-only loop is explained by its note-specific body, and the
claim *mirror* does reseed per process (`module-state-sync.ts:1986-1994`). The
lane with no reconciliation, no seeding, and a durable cursor is the claim
*effects* lane specifically.
Existing check: none for the claim effects lane. The notes lane has
`context-authority.ts:633-657` (status: unaudited), which is the shape the claim
effects lane lacks.
Impact: Part 3 established that the claim mirror's divergence is prevented at
admission and never detected afterwards. This is the producer-side confirmation:
the other end has no detector either. Divergence is a permanent, silent state on
both sides.
Open questions:
- Why does the claim effects lane combine a durable cursor with no seeding
  protocol and no reconciliation, when both sibling lanes have one or the other?
  (needs human input)

### outbox-b-effects-are-never-pruned-in-a-shipped-install


Type: safety
Reachability: default-production
Status: active
Exercised: not yet — the prune function is covered by seven test call sites, and
zero production call sites exist, so the tests establish behaviour that never
runs in a shipped install.
Guarantee: `claim_operation_effects` either stays bounded or its growth is
accounted for, and the retention contract the schema describes is the one the
product executes.
Check: `always` — over a session's lifetime, assert that either the
`claim_operation_effects` row count is bounded by some stated function of live
claims, or that the prune path executed at least once. `always` because the
schema states a retention contract unconditionally
(`storage-claim-memory-schema.ts:25-27`, `:430-432`).
Fault/timing angle: None. This is a static wiring fact, not a race.
Required faults and enabling state: None. A default install, any number of
memory mutations.
Confidence: high — [evidence](evidence/outbox-b-effects-are-never-pruned-in-a-shipped-install.md).
Verified by `rg` across the repository excluding `node_modules`, `dist`, and
`*.test.ts`: the only matches for `pruneClaimOperationEffects` are its own
definition and its own error string.
Existing check: `storage-claim-operations.test.ts:842-900`, `:902-952`,
`:1060-1087` cover the prune semantics thoroughly (status: unaudited). None
covers whether anything calls it.
Impact: Two consequences with opposite signs. Unbounded growth of an
append-only table for the life of the database, which is a slow durable-size
problem. And, in the other direction, the point of no return is *softened*: no
effect row is ever deleted, so a checkpoint reset would in fact be able to
recover a diverged consumer if such a reset existed. It does not.
Open questions:
- Is the prune path unwired deliberately, pending a decision about required
  consumers, or is this a missing call? The function's own signature demands a
  non-empty required-consumer list (`:2298-2300`), and no code anywhere defines
  that list. (needs human input)

### outbox-b-authority-write-fence-covers-notes-but-not-claim-tables


Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test attempts a claim write while the authority marker
is installed and asserts the outcome.
Guarantee: While a project's authority is module-owned, the local database
refuses local writes to the state the module owns, for claims as it does for
notes.
Check: `always` — with `authority_managed` holding a row for the project,
assert an unprivileged write to `claims`, `claim_revisions`,
`claim_operation_receipts`, or `claim_operation_effects` is refused, exactly as
`notes_authority_guard_insert` refuses a note write. `always` because the fence
is claimed for the project, not for a subset of tables.
Fault/timing angle: The gate that does exist for claims is a single
module-reported read at `hook.ts:924-937`, performed once before staging. The
commit, the drain, the delivery, and the checkpoint advance all follow without
re-reading it, so an authority drain concurrent with a memory mutation lands the
mutation and its checkpoint advance under an authority that has already gone.
Required faults and enabling state: For the trigger gap, only an installed
marker. For the timing window, a drain that begins after `hook.ts:924` returns.
Confidence: high — [evidence](evidence/outbox-b-authority-write-fence-covers-notes-but-not-claim-tables.md).
Verified that all ten `authority_managed` references in the schema file are the
table definition plus the three notes triggers, and that the claim-memory schema
names it nowhere.
Existing check: `storage-session-runtime-schema.ts:1190-1255` fences `notes`
(status: unaudited). Nothing fences a claim table.
Impact: The authority contract is enforced at the database boundary for the
smaller of the two domains and only in application code for the larger one, so
a code path that forgets the `hook.ts` check writes claim state the module
believes it owns.
Open questions:
- Is the claim lane deliberately outside the trigger fence because the claim
  tables have their own append-only guards, or is the memories domain simply
  unfenced? (needs human input)

### outbox-b-intent-binding-incarnation-is-hex-validated-outbound-only


Type: safety
Reachability: default-production
Status: active
Exercised: partial — `module-wire.ts:284-286` is exercised through the mirror
snapshot tests; the binding decoder at `:550-558` has no format assertion to
exercise.
Guarantee: Every `databaseIncarnationId` crossing the claim wire is 32
lowercase hex characters, in both directions and on both the mirror and the
intent lanes.
Check: `always` — on every encode and decode of a claim binding or mirror
vector, assert the incarnation matches `/^[0-9a-f]{32}$/`. `always` because the
value's only consumers compare it for equality against a 32-hex column.
Fault/timing angle: None. A format question, not a race.
Required faults and enabling state: A malformed or substituted binding on the
inbound path. The outbound path cannot produce one, because
`readDirectFormatMarker` rejects an invalid marker
(`storage-format-epoch.ts:222-224`) before `hook.ts:958` reads it.
Confidence: high — [evidence](evidence/outbox-b-intent-binding-incarnation-is-hex-validated-outbound-only.md).
Verified the mint, the validator, the marker read, the producer's use, and the
two different decoder standards. Also verified that this producer is **not** one
of the four dashed-UUID callers Part 3 found: those are all inside
`crates/mc-store/src/lib.rs` and all pass `context_store_uuid`.
Existing check: `module-wire.ts:284-286` for the mirror vector only (status:
unaudited).
Impact: Bounded on the outbound path. The value that matters is the one Part 3's
trap turns on: if Rust's guard were repaired without changing its argument, the
column would hold a `context_store_uuid` and every comparison against this
producer's correct 32-hex value would fail `IncarnationMismatch`.
Open questions: None.

## Relationship map

Grouped by shared mechanism rather than by the section headings above, because the
sharpest relationships cross groups and two of them cross parts. Every dominance
statement is a **hypothesis** about which oracle subsumes which, offered to guide
ordering. Unlike Part 4a, these hypotheses are testable today: the checks that
exist here run on every push, so a dominance claim can be settled rather than
argued.

- **The two-arm conjunction, and the three ways an arm goes quiet.**
  [fence-a-malformed-marker-reads-as-epoch-zero](#fence-a-malformed-marker-reads-as-epoch-zero),
  [fence-a-fork-lane-versions-are-invisible-to-the-fence](#fence-a-fork-lane-versions-are-invisible-to-the-fence),
  [fence-a-env-override-relaxes-only-the-version-arm](#fence-a-env-override-relaxes-only-the-version-arm),
  [fence-a-child-spawn-probe-omits-the-epoch-arm](#fence-a-child-spawn-probe-omits-the-epoch-arm).
  All four are statements about `storage-db.ts:669`'s conjunction, or about a
  second guard that reproduces one arm of it. Read as a set they show the two arms
  are each other's only backstop and neither is total: the epoch arm is vacuous for
  a malformed marker, the version arm is blind above 10,000 and overridable by
  environment variable, and the child-spawn probe drops the epoch arm entirely
  while also ignoring the override. No record dominates another, because each
  disables a different arm in a different place. Hypothesis: a single test helper
  that builds a `context.db` from a `(versionLane, markerStatus, markerEpoch,
  manifestDigest)` tuple makes all four constructible at once, which is why the
  fault map ranks that fixture builder third.
- **A guard whose verdict is not the process's only verdict.**
  [fence-a-refusal-is-a-null-return-not-a-throw](#fence-a-refusal-is-a-null-return-not-a-throw),
  [fence-a-telemetry-connection-outlives-the-fence](#fence-a-telemetry-connection-outlives-the-fence),
  [fence-a-child-spawn-probe-omits-the-epoch-arm](#fence-a-child-spawn-probe-omits-the-epoch-arm).
  Three consequences of the fence being advisory in its delivery. It returns a
  value a caller may mishandle, it does not revoke handles other modules already
  hold, and a sibling guard claiming the same property enforces less. The
  null-return record *hypothetically dominates* nothing but is a precondition of
  reading the other two correctly: because refusal is a return rather than an
  exception, nothing unwinds, nothing is torn down, and a cached telemetry writer
  is simply never told. The latch-clearing behaviour at `storage-db.ts:838-839`
  and `:879-880` belongs to this cluster too and is carried inside the
  null-return and telemetry records rather than as a record of its own.
- **Cross-part edge to Part 3: the fence asymmetry.**
  [fence-a-rust-store-has-no-newer-schema-fence](#fence-a-rust-store-has-no-newer-schema-fence),
  [fence-a-rust-ships-the-fence-vocabulary-uncalled](#fence-a-rust-ships-the-fence-vocabulary-uncalled),
  [fence-a-mixed-skew-install-is-reached](#fence-a-mixed-skew-install-is-reached).
  These three depend on Part 3 and must not re-derive it. Part 3's
  `lens-a-sqlite-durability` established the permissive `_ => Ok(())` arm at
  `mc-store/src/lib.rs:1383` and its consequence, "an older binary opens a newer
  database silently and queries it with the older binary's expectations", and
  separately established `recorded-schema-version-cannot-disagree-with-the-actual-schema`,
  that for `store.db` none of `application_id`, `user_version`, marker row,
  incarnation ID, manifest digest, or object inventory "are set or checked". Record
  10 cites the first; record 11 names the mechanism by which the shared fixture
  makes the second surprising. Record 12 is the reachability record over both, and
  it is the only record in the part that no in-repository harness can construct
  today. Hypothesis: record 12 *dominates* both others as an oracle, because a
  campaign that observes the two verdicts co-occurring proves the asymmetry
  directly and makes 10 and 11 redundant as evidence, while 10 and 11 individually
  prove only that a reading of the source is correct. That is exactly why the
  leverage ranking puts the differential harness first.
- **Cross-part edge to Part 4d: the empty acknowledgement.**
  [outbox-b-acknowledgement-is-an-echo-of-the-delivered-prefix](#outbox-b-acknowledgement-is-an-echo-of-the-delivered-prefix),
  [outbox-b-checkpoint-advance-is-the-point-of-no-return](#outbox-b-checkpoint-advance-is-the-point-of-no-return),
  [outbox-b-checkpoint-advances-against-a-module-with-no-open-store](#outbox-b-checkpoint-advances-against-a-module-with-no-open-store),
  [outbox-b-no-repair-path-lowers-or-rebuilds-a-claim-consumer-checkpoint](#outbox-b-no-repair-path-lowers-or-rebuilds-a-claim-consumer-checkpoint).
  The load-bearing cross-part dependency in this sub-part. Part 4d's
  `facade-a-claim-effects-apply-acks-a-durable-checkpoint-with-no-module-effect`
  owns the consumer: `handle_claim_effects_apply` never calls `self.store()`,
  returns the last delivered effect id, never compares the `consumer` value, and
  acks while the store is still opening, when every neighbouring claim handler
  returns `store_unavailable_error`. Part 4d also fixes the coverage reality that
  makes this a drift finding rather than a bug report: **the Rust half has no
  test, the TypeScript producer is tested against a fake delivery closure, and
  `decodeClaimEffectDeliveryResponse` has zero test references anywhere in the
  tree.** So the one contract with two ends has a CI-verified producer, an
  untested consumer, and a wire decoder nobody tests, and the tested half's tests
  all supply a consumer more honest than the shipped one. The echo record
  *hypothetically dominates* the point-of-no-return record's harmfulness half:
  if the ack carried one fact the producer did not already know, the irreversible
  advance would be justified and the missing repair path would be a resilience
  gap rather than a correctness one. It dominates neither the irreversibility
  claim itself, which is a static property of the call graph, nor the
  store-opening record, which is a timing situation.
- **Two independent checks of one tautology.**
  [outbox-b-acknowledgement-is-an-echo-of-the-delivered-prefix](#outbox-b-acknowledgement-is-an-echo-of-the-delivered-prefix),
  [outbox-b-multi-receipt-backlog-drain-occurs-in-a-campaign](#outbox-b-multi-receipt-backlog-drain-occurs-in-a-campaign).
  The producer checks the ack at `module-state-sync.ts:2323-2327` and the decoder
  checks it again at `module-wire.ts:729-733` against an `expectedEffectId` the
  transport derives from the same outgoing request. Two independent
  implementations of the same comparison, which reads as defence in depth and is
  not, because both derive their expectation from the request. The backlog record
  is here because the drain's ordering investment is what those checks protect,
  and today every observation of it is of the one-group case. Hypothesis: no
  dominance. A backlog observation strengthens the ordering claim without saying
  anything about the ack's information content.
- **An invariant the database does not hold.**
  [outbox-b-checkpoint-monotonicity-is-application-enforced-only](#outbox-b-checkpoint-monotonicity-is-application-enforced-only),
  [outbox-b-checkpoint-never-passes-the-outbox-tail](#outbox-b-checkpoint-never-passes-the-outbox-tail),
  [outbox-b-checkpoint-never-splits-a-receipt-group](#outbox-b-checkpoint-never-splits-a-receipt-group),
  [outbox-b-authority-write-fence-covers-notes-but-not-claim-tables](#outbox-b-authority-write-fence-covers-notes-but-not-claim-tables).
  Four records on where enforcement lives. The tail and split guards work and are
  tested; the monotonicity record says all of them are bypassable by any writer
  that does not call the one function; the authority record is the same shape one
  layer out, where `notes` gets three triggers and no claim table gets any. The
  monotonicity record *hypothetically dominates* the tail and split records as a
  **scope** claim and not as a correctness claim: proving an out-of-band writer can
  set any value makes the in-process guards' completeness moot, while saying
  nothing about whether they are individually correct. Note the cross-project
  weakness that sits inside the tail record and is not a record of its own: the
  tail query at `storage-claim-operations.ts:2237-2239` selects
  `MAX(id) FROM claim_operation_effects` with **no project predicate** while the
  receipt-split guard two statements later is project-scoped, so a high effect id
  in project B licenses a checkpoint in project A.
- **Absences that partly cancel.**
  [outbox-b-effects-are-never-pruned-in-a-shipped-install](#outbox-b-effects-are-never-pruned-in-a-shipped-install),
  [outbox-b-no-repair-path-lowers-or-rebuilds-a-claim-consumer-checkpoint](#outbox-b-no-repair-path-lowers-or-rebuilds-a-claim-consumer-checkpoint),
  [outbox-b-checkpoint-never-passes-the-outbox-tail](#outbox-b-checkpoint-never-passes-the-outbox-tail).
  Three records that only make sense read together, and the only place in this part
  where two findings have opposite signs. Because
  `pruneClaimOperationEffectsInCurrentTransaction` has no production caller —
  verified at `HEAD`, the only two matches in the tree outside `*.test.ts` are its
  own definition at `storage-claim-operations.ts:2289` and its own error string at
  `:2295` — an append-only table grows for the life of the database, which is a
  durable-size problem, **and** every effect row needed to redo a lost delivery
  survives, which means the irreversible checkpoint is only irreversible for want
  of a reset that nobody wrote. The tail record is in this cluster because its
  fallback branch, the tail defaulting to the existing cursor rather than zero at
  `:2240`, exists for the pruned case that a shipped install never reaches. So one
  tested guard's interesting arm is dead code in production.
- **The identity that is correct here and wrong next door.**
  [outbox-b-intent-binding-incarnation-is-hex-validated-outbound-only](#outbox-b-intent-binding-incarnation-is-hex-validated-outbound-only).
  Deliberately outside every cluster. Its outbound path cannot produce a bad value,
  its inbound decoder has no format check, and its real content is a warning about
  a repair in another part: Part 3's
  `intent-control-transition-write-is-silently-dropped` describes a Rust guard that
  silently drops a write when its argument is not 32-hex, and the four callers pass
  a dashed `context_store_uuid`. Fixing that guard without changing its argument
  would make every comparison against this producer's correct 32-hex value fail.
  The record is in the catalog so that the interaction is written down before
  someone repairs one side.
