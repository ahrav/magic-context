# Part 5a fault-to-property map

For each of the 23 records, what must actually occur for a test to be non-vacuous,
and whether the harness can produce it today.

Same rules as Parts 1 through 4: safety checks must hold *while* their faults are
active; liveness checks need a bounded fault-free window; crash recovery needs a
real termination; rare branches need deterministic injection to be reachable at
all; and coverage checks assert independent preconditions, never the violation.

Provenance: `/local/home/ahrav/scratch/magic-context`, `HEAD` = `e447c927`. Fault
classes, availability, and every reference verified at `HEAD`.

Three framing points specific to this sub-part.

**First, and unlike every earlier part, the cheapest item on the leverage ranking
is not running the tests, because they already run.** `ci.yml:256-257` executes
482 test files, 100 percent of the test files in every package Part 5 scopes, and
every check in `existing-checks.md` is inside it. The `H0`-shaped row that opened
Parts 3 and 4a and dominated both has no analogue here. What replaces it at the top
of the ranking is **building the one differential harness that exercises the real
cross-language pairing**, because the thing that is missing is not execution but a
consumer, and every fake consumer in the tree is more honest than the shipped one.

**Second, the dominant obstacle is a missing counterparty, not a missing fault.**
Fifteen of the 23 records need no injected fault at all. They need a database file
constructed offline in a state a newer binary would produce, or a delivery closure
that lies, or a static reading of the call graph. The availability column is
correspondingly generous, and that is the honest reading: this material is cheap to
test and largely untested at the seams that matter.

**Third, one availability claim cuts across everything and must not be
double-counted.** `packages/e2e-tests` (107 test files, 34,907 production lines) is
excluded from Part 5 as harness, and it is the only place in the repository that
drives two runtimes at once. Three records depend on a cross-runtime capability.
Whether that capability is built inside `e2e-tests` or as a new fixture is a
harness-ownership decision, not a fault-injection problem, and it is recorded as
such in the leverage ranking rather than counted as a fault class per record.

## Fault classes required

`S1` is listed first because it is the cheapest capability here and, like `H0` in
Part 4a, it is not a fault at all.

| Class | Description | Available today |
| --- | --- | --- |
| **S1** an older binary opening a newer database | A `context.db` constructed offline whose `schema_migrations` max below `FORK_MIGRATION_VERSION_FLOOR` exceeds 90, or whose `mc_format_marker.format_epoch` exceeds 1 with a valid digest, then opened by this build | **Yes, and it is the cheapest capability in the sub-part.** No injection needed; the state is pure file construction. `storage-db.test.ts` already builds both shapes: the version-lane form at `:423-469` (a second `Database`, a hand-written `mc_format_marker` and `schema_migrations`, then `LATEST_SUPPORTED_VERSION + 1`) and the accepted-path form at `:471-494` (bootstrap with this build, close, insert a `+1` row from a second connection). `buildDirectFormatMarker` and `computeMarkerDigest` are exported and already used for the marker half. The capability is present and well exercised |
| **S2** a malformed or unparseable marker | A `mc_format_marker` row that fails any validator in `storage-format-epoch.ts:194-232` — digest mismatch, out-of-range epoch, zero or multiple rows, unreadable table — **while carrying a newer vintage**, with the version lane at or below 90 so the version arm does not catch it | **Yes, and no test constructs it.** The two halves each exist separately and have never been combined. The malformed half is built at `storage-format-epoch.test.ts:199-214` ("refuses a malformed marker before any other verdict") and `:216-229` (a tampered row detected through the stored digest). The newer half is built at `storage-db.test.ts:423-469` with a **valid** digest. Combining them is writing one row with a deliberately wrong `marker_digest` and `format_epoch: 2`, which is a two-line change to an existing fixture. The production analogue is a newer binary bumping `FORMAT_MARKER_DIGEST_PROTOCOL` without bumping the migration lane |
| **S3** a fork-lane vintage | A `context.db` carrying a `schema_migrations` row at 10,000 or above, so `getPersistedSchemaVersion`'s `WHERE version < ?` bound (`storage-db.ts:192-194`) cannot see it | **Yes, and the state is intended to exist rather than hypothetical.** `migrations.ts:1` reserves the space "for downstream migrations", and two existing tests already build it: `storage-db.test.ts:128-145` ("counts the direct-format fence row but ignores the reserved downstream floor and above") and `:563-589` ("downstream rows share context.db"), plus `schema-fence-probe.test.ts:85-93` at the probe. What none asserts is the fence **verdict** for such a database |
| **S4** an acknowledgement that is truthful about nothing | A `deliver` closure that returns `{ ackedEffectId: receipt.effects.at(-1).id }` and retains nothing, so it satisfies both equality checks while applying no effect | **Yes, and this is the single highest-leverage missing vector.** No new seam: `deliver` is already a parameter of `drainClaimEffectPrefix` (`module-state-sync.ts:2215`, typed `(receipt: ClaimEffectDeliveryReceipt) => Promise<{ ackedEffectId: number }>`) and every existing test supplies one. Two shapes exist and neither is this: the pure echo at `module-state-sync.test.ts:1409-1415`, which records deliveries for an ordering assertion and is therefore not silent, and the modelled honest consumer at `context-authority-crash.test.ts:214-231`, which stores every receipt group, refuses a receipt that changed on replay, and refuses an effect crossing groups. **The shipped consumer is less honest than both**, per Part 4d: `handle_claim_effects_apply` (`mc-module/src/lib.rs:10184-10255`) returns `previous` and never calls `self.store()`. The vector is a closure that returns the right number and writes nowhere, plus an oracle that then asks what the producer knows |
| **S5** a consumer with no open store | A delivery accepted while the module's store phase is `STORE_OPENING`, so the consumer provably had no store to write to | **No, for the real pairing.** Part 4d records the asymmetry that makes the window real: during `STORE_OPENING` (`lib.rs:12007-12011`) `claim.intent.stage` returns `store_unavailable_error` (`:10097-10099`) while `claim.effects.apply` returns a successful ack, because it never calls `self.store()`. Observing it needs a live module reporting its phase, and the producer's access to that phase is itself unresolved: `hook.ts:924` reads `authorityStatus`, not health, and 5c scopes the transport's health surface. A fake consumer that *reports* `STORE_OPENING` is not the property, because the property is that the producer cannot distinguish the case. Depends on **S7** |
| **S6** concurrent producers, or any second writer of the file | A second connection writing `claim_outbox_consumer_checkpoints` directly, bypassing `advanceOutboxConsumerCheckpointInCurrentTransaction`; or two processes of different vintage opening one `context.db` with a stamp landing between the fence read at `storage-db.ts:777` and the first application query | **Split. The out-of-band-writer half is Yes; the interleaving half is Partial.** *Out-of-band writer: yes, trivially.* The table has **zero** triggers, verified against the full trigger inventory of `storage-claim-memory-schema.ts`, and its `CHECK` constraints cover type and non-negativity only, so a raw `UPDATE ... SET acked_effect_id = 0` from a second `Database` on the same path is one statement. The second-connection technique is already used throughout `storage-db.test.ts` (`:471-494`, `:423-469`) and the CLI genuinely opens the same file for mutation (`doctor-authority.ts:174`, plus the 5d-scoped `doctor-repair-db.ts` and `migrate.ts`). *Interleaving: partial.* Real multi-process convergence is already constructed twice, at `storage-db.test.ts:196-231` ("two processes bootstrap one pristine family") and `storage-claim-operations-crash.test.ts:442-453` ("concurrent identical Bun/Node operations converge"), so the capability exists. What is missing is a named interleaving point inside the fence's unfenced read window, and `bootstrapUnderWriteLock` takes `BEGIN IMMEDIATE` (`storage-db.ts:620-627`, `:639`) while the fence itself does not |
| **S7** a cross-language differential using the real pairing | One campaign driving both the TypeScript fence on `context.db` and the Rust store on `store.db`, at two binary generations, and separately driving the real `claim.effects.apply` handler as the `deliver` target instead of a closure | **No. Nothing in the repository does this, and the gap is ownership rather than infrastructure.** The pieces exist and are not joined. The shared fixture `fixtures/direct-format-vocabulary-v1.json` is checked in and asserted from both sides: TypeScript at `storage-format-epoch.test.ts:81-87`, `:103-105`, `:107-117`, running on every push; Rust at `crates/mc-store/tests/sqlite_runtime.rs:51-103`, running in **no** workflow (`mc-store` has zero matches across all five workflow files). Both prove agreement on constants; neither proves enforcement. For the outbox half, `mc-module`'s in-crate tests do not compile in CI at all, because `ci.yml:172` selects `--test lifecycle_cli` and does not build `--lib`. `packages/e2e-tests` is the only two-runtime driver in the tree and is excluded from Part 5 as harness. Two decisions precede any work: who owns the harness, and whether an enforcement divergence becomes a failure or a documented exception |
| **S8** a secondary connection surviving a refusal | A cached `transform-decision-log.ts` telemetry handle alive across a `closeDatabase()` and a subsequent fence-refused reopen | **Yes.** No injection: the ordering is open, write one decision row so `telemetryDbByPath` (`transform-decision-log.ts:390`) is populated, `closeDatabase()`, then a reopen the fence refuses. `closeDatabase` (`storage-db.ts:920-931`) clears only `pendingAsyncOpens` and `databases`, and the only `telemetryDbByPath` clear is `reset()` (`transform-decision-log.ts:469-478`), a test seam beside `setWriterForTests` and `setRetentionForTests` with no production caller. The observable is that a write still lands, which needs no access to the private map. `transform-decision-log.test.ts` exists with 8 cases and does none of this |
| **S9** an authority marker installed during a claim write | A row in `authority_managed` for the project, then an unprivileged write to `claims`, `claim_revisions`, `claim_operation_receipts`, or `claim_operation_effects`; and separately a drain beginning after `hook.ts:924` returns | **Yes for the trigger gap, Partial for the timing window.** *Trigger gap: yes.* Verified at `HEAD`: `authority_managed` has **zero** references in `storage-claim-memory-schema.ts`, and all ten references in `storage-session-runtime-schema.ts` are the table definition at `:870` plus the three `notes` guard triggers at `:1190-1255`. Installing a marker and attempting a claim write is two statements. *Timing window: partial.* The memories gate is a single module-reported read at `hook.ts:924-937` performed once before staging, and the commit, drain, delivery, and advance all follow without re-reading it, so the window is real; constructing it needs a drain driven concurrently with a mutation, which `context-authority-crash.test.ts`'s cut machinery could host but does not |
| **S10** a malformed inbound claim binding | A claim-intent binding whose `databaseIncarnationId` is not 32 lowercase hex, arriving on the decode path | **Yes, and there is nothing to exercise on the outbound side by design.** The decoder at `module-wire.ts:550-558` uses a bare `wireString` with no format check, while the mirror snapshot vector's decoder at `:284-286` enforces `/^[0-9a-f]{32}$/`. Feeding a dashed UUID to the first is a direct function call. The outbound path cannot produce one, because `readDirectFormatMarker` rejects an invalid incarnation (`storage-format-epoch.ts:222-224`) before `hook.ts:958` reads it |

One availability caveat that cuts across **S1**, **S2**, and **S3**. The fence
reads the version lane and the marker outside any transaction, on a connection
where `PRAGMA journal_mode=WAL` has not yet run (`storage-db.ts:782`). That is what
makes the no-byte-changed claim cheap to assert, and it also means a test asserting
"no artifact created" must scope the claim correctly:
`bootstrapUnderWriteLock` (`:766`) can run **before** the accepted-path fence and
takes `BEGIN IMMEDIATE`, which creates a `-journal` file on that connection, and
`:622-626` deliberately excludes it from the artifact inventory. Assert digests on
`context.db`, `-wal`, and `-shm`; do not assert the absence of a `-journal`.

## Map

All 23 records, in `catalog.md` order. "Non-vacuous today" means a developer can
construct the required state with the current harness. Unlike Parts 3 and 4a it
**also** means the check would run on every push once written, because
`ci.yml:257` executes the whole suite; that is the one place this column is
stronger here than in any earlier part.

Every record is `default-production` except
`fence-a-env-override-relaxes-only-the-version-arm`, which is
`explicit-config-only` and whose enabling state therefore includes setting
`MAGIC_CONTEXT_LATEST_SUPPORTED_VERSION`. In this part `default-production` means
reachable in a shipped plugin install; that precondition is not repeated per row.

### Group A: the fence and its delivery

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| fence-a-older-binary-never-writes-a-newer-database | A `context.db` newer by version lane or by marker epoch, then one `openDatabase` (S1). No injection. To close the record's own open question, add digest **and** existence assertions on `context.db`, `-wal`, and `-shm`, which `:423-469` does for the main file only and `:375-394` does for `-wal` on a different family | **Yes** |
| fence-a-refusal-is-a-null-return-not-a-throw | A fence-refused open (S1), asserting `null` and no throw. Already asserted at `:369`, `:462`, `:488`. The uncovered half is the caller side: a static sweep proving no `openDatabase` caller relies on a `catch` without a null check. **No fault required** for that half | **Yes** |
| fence-a-accepted-path-proves-vintage | A `current`-family database carrying a newer fence row (S1). Covered exactly at `:471-494`. The interesting residue is the unfenced read window between `storage-db.ts:777` and the first application query, which needs S6's interleaving half | **Yes** for the record as stated; **Partial** for the split-read window |

### Group B: fail-open arms

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| fence-a-malformed-marker-reads-as-epoch-zero | A marker row that fails a validator while carrying a newer vintage, version lane at or below 90 (S2). Both halves already exist in separate fixtures; the combination does not. Assert the open refuses **and** that the refusal is not attributed to a stale epoch of `0` | **Yes** — the highest value-per-line item in the sub-part |
| fence-a-unclassifiable-family-must-not-get-reset-guidance | The same input as above, plus a log capture (S2). `manifestOnly` at `storage-db.ts:695-698` requires `marker.status === "present"`, so a malformed marker takes `:701`. The oracle is the guidance string, and no test in the tree asserts any of the three strings | **Yes** |
| fence-a-fork-lane-versions-are-invisible-to-the-fence | A row at 10,000 or above (S3). Three tests already build the state; none asserts the fence verdict at `openDatabase`. **No fault required** | **Yes** |
| fence-a-env-override-relaxes-only-the-version-arm | `MAGIC_CONTEXT_LATEST_SUPPORTED_VERSION` set above 90, plus a database with `format_epoch >= 2` (S1). `explicit-config-only`, so the check is `always-or-unreached`. The variable has one reference in the tree and no test sets it. Note the residual parse risk the record names: `parseInt` with `Number.isFinite` accepts `"999x"` as 999 | **Yes** |

### Group C: a second guard and a second connection

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| fence-a-child-spawn-probe-omits-the-epoch-arm | A database newer only by marker epoch, version lane at or below the ceiling (S1), driven through both `probeChildSpawnFence` and `refuseNewerSchemaFence` at the same ceiling and compared. Both are exported and directly callable, so this is two calls and an equality. The record's blast-radius question is separate: the caller sweep is done (`child-session-spawn.ts:88`, `pi-plugin/src/subagent-runner.ts:851`) and whether a spawned child writes `context.db` is not | **Yes** for the disagreement; the impact half stays unresolved |
| fence-a-telemetry-connection-outlives-the-fence | Open, write one decision row, `closeDatabase()`, then a refused reopen with the telemetry handle live (S8, plus S1 for the refusal). The observable is a landed write, so the private map need not be inspected. Note the handle is configured `busy_timeout=0` (`transform-decision-log.ts:398`), so its writes drop on contention rather than blocking, which bounds the blast radius and also makes a naive assertion flaky | **Yes** |

### Group D: the cross-language split

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| fence-a-rust-store-has-no-newer-schema-fence | A `store.db` whose `cortexkit_schema_version` `MAX(version)` for namespace `mc_cache` exceeds the binary's ceiling, then `McStore::open` (S1's Rust analogue). Constructible locally by seeding the version row, and the fall-through at `mc-store/src/lib.rs:1383` needs no fault. **But `mc-store` is named in zero workflow files**, so a check written here executes nowhere, which is the opposite of every TypeScript row above | **Partial** — constructible locally, unprotected by automation. Promoting it to `Yes` costs a workflow change, and that change is not in 5a's gift because `mc-store` is Part 3 scope |
| fence-a-rust-ships-the-fence-vocabulary-uncalled | **None.** A static wiring claim, provable by a call-graph assertion: no production Rust path reaches `sqlite_runtime`'s marker or manifest helpers before opening a database. Verified at `HEAD` by search, and the negative claim is what the record asserts. Implementable as a source-scan check in the shape `claims-direct-cutover.test.ts:247-251` already uses for the TypeScript side | **Yes** as a coverage check over the current call graph |
| fence-a-mixed-skew-install-is-reached | Run a newer binary generation once against a fresh install so it advances both `schema_migrations` past 90 and `cortexkit_schema_version` past the Rust ceiling, then run an older generation, and observe `getSchemaFenceRejection()` non-null for `context.db` while `McStore::open` returns `Ok` on the paired `store.db` (S7). Version skew is the whole input; no fault injection | **No** — the only record in the sub-part that no current capability can make non-vacuous. It is `sometimes`, so a partial construction that executes both code paths without co-occurring verdicts does not satisfy it |

### Group E: the point of no return and the empty acknowledgement

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| outbox-b-checkpoint-advance-is-the-point-of-no-return | **None to reach the advance**; it is on the mandatory settle path of every module-mode memory mutation (`hook.ts:974-988`). Two halves. The irreversibility half is a static claim over the call graph, verified at `HEAD` by searching the table name: one `SELECT`, one upsert, one prune aggregate, two drain joins, no `DELETE`, no downward `UPDATE`, zero `crates/` references. The harmfulness half needs S4 | **Yes** for both halves, the second once S4 exists |
| outbox-b-acknowledgement-is-an-echo-of-the-delivered-prefix | **None.** No interleaving; the deficiency is in the response's information content. The literal check ("the producer holds one fact not derivable from the request it sent") fails by construction today, so the implementable form is the coverage-check pair the record names: assert the two independent preconditions, that an ack was accepted and that the accepted value equals `request.receipt.effects.at(-1).id`. Both fire on a correct implementation | **Yes** as the coverage-check pair |
| outbox-b-checkpoint-advances-against-a-module-with-no-open-store | A delivery timed into the module's store-open window (S5, therefore S7). Two markers, asserted independently per METHOD.md: the ack was accepted, and the module reported a non-ready store phase in the same window. The second marker is the blocker, because the producer's access to the module's phase is unresolved and 5c scopes the health surface | **No** for the real pairing. A fake consumer reporting the phase would satisfy the markers while inverting the property, since the property is that the producer cannot tell |
| outbox-b-multi-receipt-backlog-drain-occurs-in-a-campaign | An unacknowledged prefix containing a receipt group other than the current mutation's. Two routes, both producible with the existing in-test consumer: one prior delivery that failed after the receipt committed and before the checkpoint advanced, or two mutations in projects that do not share a receipt. `module-state-sync.test.ts:1400-1422` already constructs the two-group shape. `sometimes`, so the marker must fire on the **state** of a non-empty prior backlog, not on the loop's lines, which execute on every mutation | **Yes** |

### Group F: the guards that run, and where they stop

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| outbox-b-checkpoint-monotonicity-is-application-enforced-only | A writer other than the guarded function (S6, out-of-band half). One raw `UPDATE` from a second connection, since the table has zero triggers. Assert the post-transaction invariant, not the function's rejection, because the record's scope is every writer of the file | **Yes** |
| outbox-b-checkpoint-never-passes-the-outbox-tail | **None.** The guard at `storage-claim-operations.ts:2241-2245` is unconditional and covered exactly at `:954-1016`, including the post-prune idempotence arm. Two residues are not covered: the cross-project weakness, where the tail query at `:2237-2239` has no project predicate while the write is per project, which needs two projects and no fault; and the fallback branch at `:2240`, which requires a pruned outbox that a shipped install never reaches | **Yes** for the record; the cross-project residue is also **Yes** and unwritten |
| outbox-b-checkpoint-never-splits-a-receipt-group | **None** for the single-project case, covered twice (`storage-claim-operations.test.ts:1018-1058`, `module-state-sync.test.ts:1424-1441`), both with single-project receipts. The interesting case is a receipt whose effects span more than one project, and whether a shipped claim operation can produce one is **unresolved**: three separate code regions are written as though it can (`module-state-sync.ts:1786-1809`, `:2330-2343`, `storage-claim-operations.ts:2302-2313`), and every test uses one project | **Partial** — the guard is proven, the multi-project case that makes the fault/timing angle real is not constructible until that question is answered |

### Group G: no repair, no retention, no fence on the claim lane

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| outbox-b-no-repair-path-lowers-or-rebuilds-a-claim-consumer-checkpoint | **No injected fault.** Two halves. The static half is an absence claim over the call graph, verified at `HEAD`. The concrete window is two shipped operations in sequence: a CLI `doctor drain-authority` (`doctor-authority.ts:173-227`) returning memories to TypeScript ownership and removing the marker (`context-authority.ts:1128-1130`) without resetting either claim consumer's checkpoint, then a `prepareAuthority` handing ownership back to a module never seeded with the already-acked prefix. Note the record's own narrowing: the notes-only domain loop at `context-authority.ts:617` is explained by its note-specific body, and the claim **mirror** does reseed per process (`module-state-sync.ts:1986-1994`); the lane with a durable cursor, no seeding, and no detector is the claim **effects** lane specifically | **Yes** |
| outbox-b-effects-are-never-pruned-in-a-shipped-install | **None.** A static wiring fact plus a volume observation. Verified at `HEAD`: outside `*.test.ts` the only matches for `pruneClaimOperationEffects` are its own definition (`storage-claim-operations.ts:2289`) and its own error string (`:2295`). The `always` form the record states is a disjunction, so the cheap arm is "the prune path executed at least once", which is false today and provable by a call-graph check | **Yes** |
| outbox-b-authority-write-fence-covers-notes-but-not-claim-tables | An installed `authority_managed` row plus an unprivileged claim write (S9, trigger half). Two statements. The timing half, a drain beginning after `hook.ts:924` returns, needs S9's partial half | **Yes** for the trigger gap; **Partial** for the timing window |
| outbox-b-intent-binding-incarnation-is-hex-validated-outbound-only | A malformed or substituted binding on the inbound decode path (S10). A direct call to the decoder with a dashed UUID. The outbound path cannot produce one and needs no test. The record's value is the interaction it names with Part 3's Rust guard, which no test in this part can assert | **Yes** |

**Totals: 19 non-vacuous today, 2 partial, 2 no.**

The distribution is unlike any earlier part. Part 3's records were blocked on
missing cheap capabilities. Part 4a's were constructible and unprotected. Here they
are **both constructible and protected**, which is why 19 of 23 sit at `Yes`: once
written, each runs on every push at `ci.yml:257`.

The four exceptions are informative because they are all the same shape. The two
`No` rows, `fence-a-mixed-skew-install-is-reached` and
`outbox-b-checkpoint-advances-against-a-module-with-no-open-store`, are both
`sometimes` records that need the real cross-language pairing, and both are
blocked on **S7**. `fence-a-rust-store-has-no-newer-schema-fence` is `Partial` for
a different reason, that it is constructible but lands in a crate CI never builds.
`outbox-b-checkpoint-never-splits-a-receipt-group` is `Partial` on an unresolved
question about the domain rather than on any capability. So three of the four
exceptions are one gap, and it is the gap the leverage ranking puts first.

## Coverage checks to add

Each asserts a precondition that a **correct** implementation still satisfies, so
it fires without a defect present. Names are constants, globally unique, and never
constructed dynamically.

| Coverage check | Situation it witnesses | Why it is safe |
| --- | --- | --- |
| `storage_fence_read_a_marker_status_other_than_present` | The fence's marker read returned `absent` or `malformed`, so `storage-db.ts:668` collapsed the epoch to `0` | Legal and ordinary: a legacy database has no marker, and `absent` collapsing to zero is the intended behaviour. Records the precondition of the malformed case without asserting the outcome |
| `storage_fence_version_lane_read_threw_and_defaulted_to_zero` | The `catch` at `storage-db.ts:657-661` swallowed a read error, leaving `persistedVersion` at `0` | The comment at `:660` states this is intended ("An unreadable version lane stays a plain format refusal"), so observing it is a fact about the code |
| `storage_fence_refused_on_the_epoch_arm_not_the_version_arm` | A refusal where `persistedEpoch > DIRECT_FORMAT_EPOCH` selected the lane name at `:673-676` | Legal: the two-arm conjunction has two refusal reasons and the code composes a distinct message for each. This is the independent precondition of the record that the latch carries only the version pair |
| `storage_fence_ran_on_the_accepted_path` | `refuseNewerSchemaFence` was reached at `:777` after classification returned `current` | Legal by construction; the call exists for exactly this family and declines on every healthy open |
| `storage_fence_declined_before_a_format_refusal_was_recorded` | `recordFormatRefusal` reached `:689`, the fence declined, and the format refusal was then composed | The ordinary shape of every non-`current` family that is not also newer. It is the precondition of the guidance-string record |
| `storage_migrations_table_held_a_row_at_or_above_the_fork_floor` | A `context.db` carried a `schema_migrations` row at 10,000 or above | Legal and reserved: `migrations.ts:1` reserves the space for downstream forks. Records the precondition of the fork-lane blindness, not the blindness |
| `storage_open_returned_a_cached_handle_without_rerunning_the_fence` | `openDatabase` took the cached-handle path at `:840-851` | Legal and the common case; a process opens the same path many times |
| `storage_decision_log_created_a_second_connection_for_a_fenced_path` | `telemetryDbByPath` was populated for the same path `openDatabase` guards | Legal: the decision log's write path creates it on the first decision row of every session |
| `child_spawn_fence_probe_allowed_a_spawn` | `probeChildSpawnFence` returned `allowSpawn: true` | The overwhelmingly common outcome; the probe exists to allow spawns and occasionally refuse one |
| `rust_store_open_admitted_a_recorded_version_through_the_fallthrough_arm` | `refuse_pre_cutover_store` reached `_ => Ok(())` at `mc-store/src/lib.rs:1383` | Legal and true on **every** healthy open, since the fallthrough is the success path. That is exactly why it is a safe marker and a bad assertion target: pairing it with a `sometimes` on the above-ceiling case would be the forbidden shape |
| `claim_effects_delivery_ack_equalled_the_last_delivered_effect_id` | The equality at `module-state-sync.ts:2323-2327` held | Ordinary and expected on every successful delivery. One half of the echo record's coverage pair |
| `claim_effects_delivery_ack_was_accepted` | A delivery returned and the producer proceeded to the advance | The other half of the pair, asserted **independently** so that neither marker observes the defect |
| `claim_outbox_checkpoint_advanced_for_a_project` | The upsert at `storage-claim-operations.ts:2261-2266` committed | The mandatory settle path of every module-mode memory mutation |
| `claim_outbox_tail_query_returned_an_id_from_another_project` | `SELECT MAX(id) FROM claim_operation_effects` returned a row whose `project_id` differs from the checkpoint being written | Legal and a plain consequence of a global query on a multi-project table. The precondition of the cross-project weakness, not the weakness |
| `claim_outbox_tail_fell_back_to_the_existing_cursor` | `tailRow.tail` was null so `:2240` used `existing` | The documented intent at `:2234-2236`. Legal, and today it never fires in production, which is itself the observation |
| `claim_effects_drain_delivered_a_backlog_group` | `drainClaimEffectPrefix` delivered a group whose `receiptId` differs from `throughReceiptId` | Legal: a backlog is the normal consequence of any earlier incomplete drain. This is the record's own `sometimes` marker |
| `claim_effects_drain_scoped_itself_to_the_target_receipts_projects` | `throughReceiptId` was supplied so `scopedProjectIds` was set and the drain broke at `:2351` | The production shape; `hook.ts:977` always supplies it |
| `claim_receipt_group_spanned_more_than_one_project` | One receipt's effects carried more than one distinct `project_id` | Legal if it can happen at all, and observing it **resolves the record's open question** either way. If it never fires across a campaign, that is evidence the multi-project code is defensive |
| `authority_marker_was_installed_while_a_claim_write_was_staged` | `authority_managed` held a row for the project at the moment a claim write was attempted | Legal and the point of the authority handover. The precondition of the unfenced-claim-table record |
| `claim_binding_decoder_received_an_incarnation_that_is_not_32_hex` | The decoder at `module-wire.ts:550-558` was handed a value failing `/^[0-9a-f]{32}$/` | A legal input shape from the perspective of a decoder with no format check. Asserting it arrived says nothing about what the decoder does with it |
| `cross_runtime_vocabulary_fixture_was_asserted_from_both_runtimes_in_one_campaign` | The same `direct-format-vocabulary-v1.json` was checked by TypeScript and by Rust in one run | Legal by construction, and the precondition of any differential claim about the two fences |

**Anti-patterns to avoid in this sub-part specifically.** Four pairings are
forbidden by METHOD.md's rule, and each is tempting because the defect is easier to
name than its precondition.

- Do not pair `always(!consumer_acked_without_applying)` with
  `sometimes(consumer_acked_without_applying)`. That marker can only fire by
  observing the defect, and worse, it is unobservable from the producer, which is
  the whole finding. Assert
  `claim_effects_delivery_ack_was_accepted` and
  `claim_effects_delivery_ack_equalled_the_last_delivered_effect_id`
  **independently** instead: two legal preconditions, both present on a correct
  implementation, whose conjunction is the vulnerable window.
- Do not pair `always(checkpoint_never_regresses)` with
  `sometimes(checkpoint_regressed)`. The `always` is already total over every
  writer, so a companion `sometimes` on the failure adds nothing and can only fire
  on corruption. Assert `claim_outbox_checkpoint_advanced_for_a_project` plus the
  independent existence of a second writer of the file.
- Do not pair `always(fence_refuses_a_newer_database)` with
  `sometimes(older_binary_wrote_a_newer_database)`. Assert
  `storage_fence_read_a_marker_status_other_than_present` and
  `storage_migrations_table_held_a_row_at_or_above_the_fork_floor` instead, which
  are the two independent ways the conjunction goes quiet.
- Do not pair `always(both_runtimes_enforce_one_format_identity)` with
  `sometimes(one_runtime_admitted_a_newer_database)`. Assert
  `rust_store_open_admitted_a_recorded_version_through_the_fallthrough_arm` and
  `cross_runtime_vocabulary_fixture_was_asserted_from_both_runtimes_in_one_campaign`
  instead. The first is true on every healthy Rust open, which is precisely what
  makes it a safe precondition and a useless assertion.

One further constraint on every marker here. The fence latches its rejection at
`storage-db.ts:672` and both open entry points clear the latch at `:838-839` and
`:879-880` **before** the cache lookup, so a marker placed after a second open has
already lost the record. Place latch-reading markers at the point where the
precondition becomes true, not after the next open attempt.

### Compliance check on the `sometimes` records

METHOD.md distinguishes `reachable` (location coverage) from `sometimes` (situation
coverage) and requires the coverage-check rules above for either. The synthesis
brief anticipated **one `sometimes` record per lens**. Verified against the
extracted records at `HEAD`: there are **three**, not two. Lens A produced one and
lens B produced two.

| Record | Lens | Situation, not location |
| --- | --- | --- |
| `fence-a-mixed-skew-install-is-reached` | A | Two verdicts co-occurring on one install. The record's own `Check:` line states why `reachable` is wrong: "executing both code paths proves nothing" |
| `outbox-b-multi-receipt-backlog-drain-occurs-in-a-campaign` | B | A non-empty prior backlog. Its `Check:` line notes the loop at `module-state-sync.ts:2256` executes its lines on every mutation, so line coverage says nothing |
| `outbox-b-checkpoint-advances-against-a-module-with-no-open-store` | B | An ack accepted while the module's store phase is `STORE_OPENING` |

All three are correctly `sometimes` under METHOD.md's rule, all three name a
constant marker, and none pairs an `always(!X)` with a `sometimes(X)`. The third
explicitly instructs asserting its two preconditions separately. **No duplication
across the three:** they witness three different situations, and no two are
satisfiable by one observation. The two blocked on **S7** are blocked for
different reasons, one needing two binary generations and one needing a live
module's store phase, so building the differential harness does not automatically
satisfy both.

The three `reachability`-typed records are the same three, which is consistent:
every `sometimes` check in this sub-part belongs to a reachability record and every
reachability record uses `sometimes`. No record in this sub-part uses `reachable`
or `unreachable`, and per METHOD.md that is correct, because none of the findings
is about a code location that must or must not execute.

## Leverage ranking, by cheapest valid oracle

Ranked by the cost of the cheapest oracle that yields a valid result, not by
records unblocked per capability.

**State the difference from every earlier part plainly: the cheapest item here is
not running the tests, because they already run.** `ci.yml:256-257` executes 482
test files on every push, 100 percent of the test files in every package Part 5
scopes. There is no `H0` row to put first. What sits at the top instead is the one
capability whose absence explains three of the four non-`Yes` rows and quietly
weakens the `Yes` rows too, because the suite that runs is a suite testing one half
of a two-halved contract against a counterparty more honest than the shipped one.

1. **S7, one differential harness exercising the real cross-language pairing.**
   The highest-leverage item and the only one that is genuinely new
   infrastructure. Two legs, and they are independent enough to build separately.
   *Fence leg:* drive the TypeScript fence on `context.db` and `McStore::open` on
   the paired `store.db` at two binary generations, and observe the two verdicts on
   one install. This unblocks `fence-a-mixed-skew-install-is-reached`, the only
   `No` that no other item touches, and promotes
   `fence-a-rust-store-has-no-newer-schema-fence` out of `Partial` by giving its
   check somewhere to run. *Outbox leg:* make the real `claim.effects.apply`
   handler the `deliver` target instead of a closure. That unblocks
   `outbox-b-checkpoint-advances-against-a-module-with-no-open-store` and converts
   `outbox-b-acknowledgement-is-an-echo-of-the-delivered-prefix` and
   `outbox-b-checkpoint-advance-is-the-point-of-no-return` from arguments into
   observations. The pieces exist and are not joined: the shared vocabulary
   fixture is checked in and asserted from both sides, and
   `packages/e2e-tests` is the only two-runtime driver in the tree. **Two decisions
   precede the work**, and neither is engineering: who owns the harness, given
   `e2e-tests` is excluded from Part 5 as harness; and whether an enforcement
   divergence becomes a failure or a documented exception, since the two runtimes
   are *designed* to fence different files and only the direction is in question.
   It is first despite being the most expensive because everything below it is
   cheap and none of it reaches the drift.
2. **S4, one dishonest delivery closure.** Nearly free and it is the sharpest
   single item. No new seam, no new dependency, no process: `deliver` is already a
   parameter and every existing test supplies one. Write a closure that returns
   `receipt.effects.at(-1).id` and retains nothing, then ask what the producer
   knows afterwards. It makes four Group E and G records observable rather than
   argued, and it does something the ranking's first item does not: it lets the
   **existing** crash-cut suite be re-run against a consumer as weak as the shipped
   one, which is the fastest way to learn whether
   `context-authority-crash.test.ts`'s five cases still pass. They may. That is the
   point. It sits second only because it cannot reach the two `No` rows.
3. **S1, S2, and S3 together, one offline database fixture builder.** A helper
   that builds a `context.db` from a `(versionLane, markerStatus, markerEpoch,
   manifestDigest)` tuple. No faults, no processes, no injection: pure file
   construction, and roughly half of it already exists inline in
   `storage-db.test.ts:423-469` and `storage-format-epoch.test.ts:199-229`. It makes
   all four Group B records constructible at once, plus
   `fence-a-child-spawn-probe-omits-the-epoch-arm`, plus the missing digest and
   existence assertions on `fence-a-older-binary-never-writes-a-newer-database`.
   The malformed-and-newer cell is the specific gap worth naming: **the malformed
   half and the newer half each exist in the suite today and have never been
   combined**, and the combination is the one input that defeats the arm the code
   itself calls decisive.
4. **S6's out-of-band-writer half, one raw `UPDATE` from a second connection.**
   One statement, because `claim_outbox_consumer_checkpoints` has zero triggers. It
   makes `outbox-b-checkpoint-monotonicity-is-application-enforced-only`
   non-vacuous and reframes the two well-tested guards beside it: proving any other
   writer can set any value makes their completeness moot without touching their
   correctness. Cheap enough to sit here despite unblocking one record, and it has
   a real production analogue, since the CLI opens the same file for mutation.
5. **S9's trigger half plus S10, two direct calls.** Install an `authority_managed`
   row and attempt a claim write; hand a dashed UUID to the binding decoder. Two
   short tests, two records
   (`outbox-b-authority-write-fence-covers-notes-but-not-claim-tables`,
   `outbox-b-intent-binding-incarnation-is-hex-validated-outbound-only`), no
   faults. The second is worth writing even though its impact is bounded today,
   because its value is as a tripwire on the Part 3 repair it warns about.
6. **Static call-graph checks, in the shape the repository already uses.**
   `claims-direct-cutover.test.ts:247-251` is a shipped source-scan test asserting
   production source contains no retired imports, SQL, wire keys, or Doctor
   commands. Three records are exactly this shape and need nothing else:
   `fence-a-rust-ships-the-fence-vocabulary-uncalled` (no production Rust path
   reaches the vocabulary), `outbox-b-effects-are-never-pruned-in-a-shipped-install`
   (no production caller of the prune), and the static half of
   `outbox-b-no-repair-path-lowers-or-rebuilds-a-claim-consumer-checkpoint` (no
   lowering write). All three are absence claims that a scan can hold stable
   against future edits, which is more valuable than the one-time verification this
   pass already did.
7. **S8, the surviving telemetry connection.** One record, one ordering, no
   injection, but it needs care: the cached handle is configured `busy_timeout=0`,
   so its writes drop on contention and a naive assertion is flaky. It sits low for
   that reason and because the blast radius is bounded to `transform_decisions`
   rows rather than arbitrary state.
8. **S6's interleaving half, a stamp landing inside the fence's unfenced read
   window.** The capability partly exists, since two tests already run real
   multi-process convergence. What is missing is a named interleaving point between
   `storage-db.ts:777` and the first application query, and the record it serves
   (`fence-a-accepted-path-proves-vintage`) is already `Yes` without it. Lowest
   value per unit of work in the list.
9. **S5 alone, without S7.** Listed to be explicit that it is **not** a separate
   item. Simulating a consumer that reports `STORE_OPENING` satisfies the markers
   while inverting the property, because the property is that the producer cannot
   distinguish the case. Do not build it as a shortcut around item 1.

**Records that need a product decision rather than a harness.** No amount of test
infrastructure resolves these, and each is a live open question from at least one
lens.

- **Is `claim.effects.apply` meant to apply?** Part 4d could not resolve it and
  neither could lens B. Every name on the producer side asserts delivery and the
  handler writes nothing. The producer's behaviour is unsafe under one reading and
  correct under the other, and the two differ only in what the module is supposed to
  do. Nothing else in Group E can be prioritised until this is answered, because the
  answer decides whether those records describe a defect or a naming problem.
- **Should a checkpoint reset exist at all?** Decided entirely by the previous
  question. If the handler is meant to apply, the absence of a reset makes every
  divergence permanent; if it is a conformance ack, the checkpoint is bookkeeping and
  a reset is pointless.
- **Should `malformed` collapse to epoch `0` alongside `absent`?** `absent` must
  read as zero for legacy databases. `malformed` arguably must not, and the code's
  own comment at `storage-db.ts:663-666` calls the epoch the deciding signal.
- **Should a `malformed-marker` family get a third guidance string**, distinct from
  both the manifest-only and the abandon-family cases, given that `:678` forbids the
  reset `:701` recommends?
- **Should `refuse_pre_cutover_store` gain an above-ceiling arm, or should
  `store.db` adopt the marker vocabulary `sqlite_runtime` already defines?** Both
  are one-line-ish changes with very different blast radii, and Part 3 asked the
  adjacent question about `compute_schema_manifest_digest` and left it open.
- **Is the global `MAX(id)` tail deliberate**, given the receipt-split guard beside
  it is project-scoped? A per-project tail would be strictly tighter and no weaker,
  which is a suspicious asymmetry to leave unexplained.
- **Can one claim operation produce effects in more than one project?** Three code
  regions are written as though it can and every test uses one project. This one is
  answerable from the code with a pass over the claim-operation writers, which sit in
  this sub-part's file set but outside both lens focuses, so it is queued rather than
  escalated.
- **Is the prune path unwired deliberately?** Its signature demands a non-empty
  required-consumer list and no code anywhere defines that list.
- **Should the environment override reject a non-numeric suffix** rather than
  accepting `parseInt`'s prefix, so a typo does not silently set a very high ceiling?
- **How should `Exercised:` be labelled for a cross-language fixture pair?** The
  scope map raised it and left it open. Every drift record in Part 5 depends on the
  ruling, and this sub-part's records were written under the scope map's proposed
  reading: green CI is evidence for the TypeScript path only, and a shared fixture
  proves agreement at the fixture's inputs and nothing beyond them.
