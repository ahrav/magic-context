# Part 5a existing checks: storage fence, claim outbox, and authority

Every claim-bearing check that touches sub-part 5a, with per-check status
`unaudited`. An existing check never removes a property from the catalog
(METHOD.md); adequacy verdicts belong to `/testing:invariant-test-review` for
tests and `/low-level-systems:defensive-assertions-and-invariant-guards` for
production guards.

Provenance: `/local/home/ahrav/scratch/magic-context`, `HEAD` = `e447c927`. Every
line and file reference below was read back at `HEAD`.

**This inventory inverts the usual shape, so the structure inverts too.** In Parts
1 through 4 the first question was whether a test runs at all, and the answer was
usually no, so those inventories lead with the tests and end with the CI fact. Here
the CI fact is the strongest thing in the document and it changes what counts as a
gap, so it goes first. Then the per-file counts, then the checks themselves, then
the part that actually matters: what is **not** covered despite a suite this
strong.

## 1. CI reality

All TypeScript test invocations in the repository are in `.github/workflows/ci.yml`.
Verified against all five files in `.github/workflows/`: `ci.yml`,
`claude-code-review.yml`, `historian-eval.yml`, `retrieval-benchmark.yml`,
`shm-hardening-optin.yml`.

**The load-bearing step is `ci.yml:256-257`.**

```
.github/workflows/ci.yml:256      - name: Test
.github/workflows/ci.yml:257        run: bun run test
```

It sits in the `check-plugin` job (`ci.yml:225-227`, `runs-on: ubuntu-latest`).
Root `package.json`'s `test` script is:

```
sh scripts/test-shard.sh packages/plugin
  && bun run --cwd packages/pi-plugin test
  && bun run --cwd packages/cli test
  && bun run --cwd packages/retina-local-fs test
```

Each package's own `test` script is a bare `bun test`, which discovers every
`*.test.ts` beneath the package. `scripts/test-shard.sh` shards
`packages/plugin` across `nproc` workers, floored at 1 and capped at 8, and falls
back to one unsharded `bun test` when the installed Bun has no `--shard=`. Either
way the whole suite runs.

| Package | Test files | Runs at `ci.yml:257` |
| --- | --- | --- |
| `packages/plugin` | 371 | **Yes** |
| `packages/pi-plugin` | 74 | **Yes**, and again at `ci.yml:317` |
| `packages/cli` | 36 | **Yes** |
| `packages/retina-local-fs` | 1 | **Yes** |
| **Total** | **482** | **Yes** |

That is 100 percent of the test files in every package Part 5 scopes, and every
test named in this inventory is inside it.

Two supporting steps also cover 5a material and are named because each exists to
reach something `bun test` structurally cannot:

| Reference | Command | Bearing on 5a |
| --- | --- | --- |
| `ci.yml:217` | `bun run --cwd packages/plugin typecheck` | Type level only. Catches no fence or checkpoint behaviour |
| `ci.yml:245` | `bun run typecheck` | plugin + pi-plugin + cli + retina-local-fs, type level only |
| `ci.yml:259-262` and the step below it | `node packages/plugin/scripts/smoke-node-sqlite.ts` | The `node:sqlite` branch of `shared/sqlite.ts`. `bun test` exercises only `bun:sqlite`, and the workflow comment names the `transaction()` shim, the `readonly`-to-`readOnly` mapping, and array-bind normalisation as what would otherwise ship unverified. 5a's every durable write goes through that shim, including the checkpoint upsert |

**One count correction.** The scope map states this step covers "482 of the repo's
590 test files". At `HEAD`, under the same pruning (`node_modules/` and `dist/`
excluded, `*.test.ts`, `*.test.tsx`, `*.spec.ts` counted), the repository holds
**596**: 371 plugin, 107 e2e-tests, 74 pi-plugin, 36 cli, 6 root `scripts/`, 1
mc-shm-native, 1 retina-local-fs. The six-file difference is the root `scripts/`
suite, which the scope map inventories separately at `ci.yml:55`, `:80`, and
`:381`. The 482 numerator and the 100-percent claim are both correct.

**Rust-side CI, because half of this sub-part's records are cross-language.**
Verified by searching all five workflow files for `cargo test`, `cargo nextest`,
`mc-store`, and `mc-module`:

| Crate | Workflow invocation | Covers 5a's Rust counterparts |
| --- | --- | --- |
| `mc-store` | **None. Zero matches in any workflow file** | **No.** `refuse_pre_cutover_store`, `sqlite_runtime`, and all three files in `crates/mc-store/tests/` (`sqlite_runtime.rs`, `claim_mirror.rs`, `claim_intent_ledger.rs`) execute in no job |
| `mc-module` | `cargo test -p mc-module --test lifecycle_cli` (`ci.yml:172`), plus `cargo build -p mc-module --bin ck-mc-host` (`:169`) | **No.** `--test lifecycle_cli` selects one integration binary and does not build the `--lib` target, so no in-crate unit test compiles. `handle_claim_effects_apply` is unreached |
| `mc-host` | `ci.yml:132-134`, `:178`, `:187`, `:190` | Not 5a scope |
| `mc-shm-native`, `mc-shm-transport` | `ci.yml:177`, `:184-185` | Not 5a scope, and Part 1 |

This is the asymmetry every drift record rests on, stated as a CI fact rather than
an inference: **the TypeScript half of each duplicated contract runs on every push
and the Rust half runs nowhere.** Green CI constrains only the TypeScript side.

## 2. Per-file test counts for the scope

Production line counts are `wc -l` at `HEAD`. A test file is attributed to a scope
file when it is that file's `*.test.ts` sibling or a suffixed variant of it. Case
counts are top-level `it(`/`test(` declarations.

| Scope file | Prod | Test files | Test lines | Cases | Runs in CI |
| --- | --- | --- | --- | --- | --- |
| `features/magic-context/storage-db.ts` | 933 | 1 (`storage-db.test.ts`) | 947 | 45 | Yes |
| `features/magic-context/migrations.ts` | 6 | **0 direct** | 0 | 0 | n/a |
| `features/magic-context/storage-meta-persisted.ts` | 2,735 | 2 | 291 | 16 | Yes |
| `features/magic-context/storage.ts` | 324 | 1 (`storage.test.ts`) | 664 | 21 | Yes |
| `features/magic-context/storage-claim-memory-schema.ts` | 464 | **0** | 0 | 0 | n/a |
| `features/magic-context/memory/storage-claim-operations.ts` | 2,341 | 2 | 2,221 | 42 | Yes |
| `features/magic-context/memory/storage-claim-policy.ts` | 776 | 1 | 666 | 14 | Yes |
| `features/magic-context/context-authority.ts` | 1,484 | 2 | 1,594 | 24 | Yes |
| `hooks/magic-context/module-state-sync.ts` | 2,635 | 1 | 1,800 | 36 | Yes |
| `features/magic-context/storage-historian-runs.ts` | 138 | 1 | 144 | 5 | Yes |
| **Totals** | **11,836** | **11** | **8,327** | **203** | **Yes** |

Two scope files have no sibling test file. `migrations.ts` is 6 lines of pure
constants and is covered indirectly and deliberately by
`schema-version-fence.test.ts` (see section 3), so its zero is not a gap.
`storage-claim-memory-schema.ts` is 464 lines defining the claim tables, their
`CHECK` constraints, and their five triggers, and its zero **is** a gap; see
section 6.

Files outside the scope set whose tests bear directly on 5a records, counted the
same way:

| File | Prod | Test file | Test lines | Cases |
| --- | --- | --- | --- | --- |
| `features/magic-context/storage-format-epoch.ts` | 955 | `storage-format-epoch.test.ts` | 853 | 35 |
| `features/magic-context/schema-fence-probe.ts` | 114 | `schema-fence-probe.test.ts` | 105 | 4 |
| `hooks/magic-context/module-wire.ts` | 1,540 | `module-wire.test.ts` | 465 | 11 |
| `features/magic-context/transform-decision-log.ts` | 489 | `transform-decision-log.test.ts` | 147 | 8 |
| `features/magic-context/storage-session-runtime-schema.ts` | 1,264 | **none found** | 0 | 0 |
| n/a | n/a | `features/magic-context/schema-version-fence.test.ts` | 54 | 5 |
| n/a | n/a | `features/magic-context/claims-direct-cutover.test.ts` | 252 | 3 |
| n/a | n/a | `config/latch-permanence-guard.test.ts` | 203 | 1 |

`storage-session-runtime-schema.ts` holds the fence stamp
(`stampDirectFormatFence`, `:129-146`) and the three `notes` authority triggers
(`:1190-1255`), and has no sibling test file at all. Both mechanisms are covered
indirectly, the stamp by `schema-version-fence.test.ts:30-37` and the triggers not
at all; see section 6.

## 3. The checks, by record area

Status is `unaudited` for every entry.

### 3.1 The fence refusal and its delivery

Records 1, 2, 5.

| Location | What it covers | Status |
| --- | --- | --- |
| `storage-db.test.ts:423-469` | A `context.db` whose `schema_migrations` carries `LATEST_SUPPORTED_VERSION + 1` and whose marker is `formatEpoch: 2` with a valid digest. Asserts `openDatabase(dbPath)` is `null` (`:462`), the rejection latch equals the exact version pair (`:463-466`), `getFormatRefusal()` is `null` (`:467`), and the file digest is unchanged (`:468`) | `unaudited` |
| `storage-db.test.ts:471-494` | The accepted-path fence. Bootstraps with this build so classification returns `current`, closes, inserts a version `+1` row from a second connection, and asserts the reopen is `null` (`:488`) with a fence rejection and no format refusal. Its inline comment at `:473-476` restates the `:773-776` rationale | `unaudited` |
| `storage-db.test.ts:325-373` | Marker epoch newer while the fence row stays at exactly this build's supported version, so the epoch is the only signal. Asserts `null` (`:369`), a non-null fence rejection, a null format refusal, and an unchanged digest (`:372`). Its comment names the direction-typing reason | `unaudited` |
| `storage-db.test.ts:375-394` | The `unsupported` legacy-migration family. Asserts refusal with an unchanged digest (`:392`) **and** `existsSync(\`${dbPath}-wal\`) === false` (`:393`) | `unaudited` |
| `storage-db.test.ts:396-421` | An unsupported family carrying committed WAL state. Asserts refusal without checkpointing or truncating, comparing both the main and `-wal` digests (`:416-417`) | `unaudited` |
| `storage-db.test.ts:496-502` | A non-database file throws, so callers fail closed. This is the `:855`/`:860-862` path, and it is the boundary that makes record 2's null-versus-throw distinction observable | `unaudited` |
| `storage-db.test.ts:563-589` | Downstream rows sharing `context.db` open without being treated as future upstream schema. The `openDatabase`-level counterpart to the fork-floor filter | `unaudited` |
| `storage-db.test.ts:106-145` | Three cases on `getPersistedSchemaVersion` directly: zero when the table is absent, zero when empty, and counting the fence row while ignoring the reserved downstream floor and above | `unaudited` |
| `config/latch-permanence-guard.test.ts:180-202` | One case, "classifies every production one-shot verdict-shaped slot", which registers `storage-db.ts:lastSchemaFenceRejection` in a latch-permanence registry | `unaudited` |
| `plugin/rpc-handlers.test.ts:580-598` | `buildStatusDetail` reports the live `context.db` schema version and the plugin fence | `unaudited` |
| `plugin/rpc-handlers.test.ts:52-80` | `buildStatusDetail` reports the upstream lane when fork rows share `context.db` | `unaudited` |
| `plugin/rpc-handlers.test.ts:84-103` | `buildSidebarSnapshot` surfaces the persisted stale-build failure. The user-visible end of the child-spawn probe latch | `unaudited` |

### 3.2 The fence constants and the shared vocabulary

Records 3, 9, 11.

| Location | What it covers | Status |
| --- | --- | --- |
| `schema-version-fence.test.ts:18-23` | Pins `LATEST_SUPPORTED_VERSION` to the direct-format fence row | `unaudited` |
| `schema-version-fence.test.ts:25-28` | Keeps the fence below the downstream floor. The application-side counterpart to the `stampDirectFormatFence` assertion at `storage-session-runtime-schema.ts:130-132` | `unaudited` |
| `schema-version-fence.test.ts:30-37` | A fresh direct database is stamped at exactly the supported fence | `unaudited` |
| `schema-version-fence.test.ts:39-43` | The live version lane and the supported fence are logged at boot | `unaudited` |
| `schema-version-fence.test.ts:47-53` | The direct-format vocabulary stays disjoint from the retired migration lane | `unaudited` |
| `storage-format-epoch.test.ts:81-87` | The TypeScript vocabulary matches the shared fixture `fixtures/direct-format-vocabulary-v1.json` "consumed by the Rust runtimes" | `unaudited` |
| `storage-format-epoch.test.ts:103-105` | Pins "the golden schema-object inventory the Rust verifier consumes" | `unaudited` |
| `storage-format-epoch.test.ts:107-117` | Reproduces the golden marker digest | `unaudited` |
| `storage-format-epoch.test.ts:199-214` | The classifier "refuses a malformed marker before any other verdict". **Read the scope carefully:** this covers `classifyDatabaseFormatFamily`'s ordering, not the fence's epoch collapse at `storage-db.ts:668`. A malformed marker is correctly refused **as a family**, and record 3's finding is that the fence declines first and hands the case to the guidance composer | `unaudited` |
| `storage-format-epoch.test.ts:216-229` | A tampered marker row is detected through the stored digest | `unaudited` |
| `storage-format-epoch.test.ts:657-708` | Three cases on incarnation identity: random 128-bit lowercase hex, bound into the marker digest, immutable at the database boundary and stable across reopen. These are the outbound half of record 21 | `unaudited` |
| `storage-format-epoch.test.ts:844-852` | The test-database factory "builds markers only from valid incarnation identities" | `unaudited` |
| `claims-direct-cutover.test.ts:215-239` | The fresh direct schema has the exact frozen inventory and the required claim objects | `unaudited` |
| `claims-direct-cutover.test.ts:247-251` | A source scan: shipped production source contains no retired imports, SQL, wire keys, or Doctor commands | `unaudited` |
| `crates/mc-store/tests/sqlite_runtime.rs:51-103` | The Rust half of the vocabulary parity, asserting `MC_APPLICATION_ID`, `DIRECT_FORMAT_EPOCH`, `DIRECT_FORMAT_MARKER_TABLE`, the digest protocols, and both digest functions against the same checked-in TypeScript fixture. **Runs in no workflow** | `unaudited` |

### 3.3 The child-spawn probe

Record 7.

| Location | What it covers | Status |
| --- | --- | --- |
| `schema-fence-probe.test.ts:32-66` | Skips stale child spawns and latches after two consecutive probes | `unaudited` |
| `schema-fence-probe.test.ts:68-83` | Refuses a child spawn when the live schema probe cannot be read | `unaudited` |
| `schema-fence-probe.test.ts:85-93` | "Ignores downstream rows when probing the current direct-format fence". The fork-floor filter, covered here and not at `openDatabase` | `unaudited` |
| `schema-fence-probe.test.ts:95-104` | Surfaces a latched stale-build failure only once | `unaudited` |

All four exercise the version lane only. **Caller inventory, run for this
inventory because record 7's open question asks for it:** `probeChildSpawnFence`
has exactly two production callers, `hooks/magic-context/child-session-spawn.ts:88`
and `packages/pi-plugin/src/subagent-runner.ts:851`. That resolves the caller half
of the record's open question and leaves the blast-radius half open, since neither
call site was traced to a `context.db` writer in this pass.

### 3.4 The outbox guards and the drain

Records 13 through 18, 22.

| Location | What it covers | Status |
| --- | --- | --- |
| `storage-claim-operations.test.ts:954-1016` | "A checkpoint beyond the outbox tail is refused". Asserts `maxEffectId + 1` throws, then that the tail itself is accepted, then that re-acknowledging it after a full prune stays idempotent. The strongest single check in the sub-part | `unaudited` |
| `storage-claim-operations.test.ts:1018-1058` | "A checkpoint cannot split a receipt group and cannot regress". Both guards in one case | `unaudited` |
| `storage-claim-operations.test.ts:842-900` | Consumers advance independently and pruning stops at the minimum complete receipt boundary | `unaudited` |
| `storage-claim-operations.test.ts:902-952` | A project the consumer never checkpointed pins the boundary at zero. The `COALESCE(..., 0)` semantics of an absent row | `unaudited` |
| `storage-claim-operations.test.ts:1060-1108` | Pruning and restart leave the lifetime receipt and late replay intact | `unaudited` |
| `storage-claim-operations.test.ts:1110-1123` | Effect deletes require the prune capability and receipts never delete. The trigger-level append-only contract | `unaudited` |
| `storage-claim-operations.test.ts:763-818` | Policy projection, outbox rows, effect summary, generation vector, and declared count all agree | `unaudited` |
| `module-state-sync.test.ts:1400-1422` | "Delivers earlier effects first and checkpoints each receipt group atomically", with two groups. Reaches the backlog situation of record 22, with an echoing `deliver` closure | `unaudited` |
| `module-state-sync.test.ts:1424-1441` | Rejects a checkpoint that would split a receipt group, from the drain side | `unaudited` |
| `module-state-sync.test.ts:1648-1668` | Scenario 2 applies complete receipt groups in source outbox order | `unaudited` |
| `module-state-sync.test.ts:1670-1699` | Scenario 3 suppresses the claim lane and keeps the checkpoint on invalid wire input. The one check that asserts a checkpoint does **not** move | `unaudited` |
| `module-state-sync.test.ts:1734-1753` | Scenarios 7 and 8 fully reseed after drained module-store loss. The mirror lane's reseed, which record 19 contrasts with the effects lane's absence of one | `unaudited` |
| `storage-claim-operations-crash.test.ts:405-441` | Claim-operation pre-commit cuts restore old complete state; post-commit and pre-ack replays run once | `unaudited` |
| `storage-claim-operations-crash.test.ts:442-453` | Concurrent identical Bun and Node operations converge on one stored result and one effect | `unaudited` |
| `context-authority-crash.test.ts:403-459` | "Every durable cut restarts to one canonical result without duplicate effects", driven through injected crash cuts. The `settleContext` driver is at `:350-362` and calls the real `drainClaimEffectPrefix` at `:357` | `unaudited` |
| `context-authority-crash.test.ts:461-506` | Context failure stays staged and invisible, rejects a changed digest, then resumes | `unaudited` |
| `context-authority-crash.test.ts:508-543` | An incarnation mismatch terminally quarantines a pending intent without context effects | `unaudited` |
| `context-authority-crash.test.ts:214-231` | Not a test but the **modelled consumer** every crash case runs against. Its `applyReceipt` stores each receipt group, refuses a receipt that changed on replay, refuses an effect crossing groups, and returns `receipt.effects.at(-1)?.id ?? 0`. It is materially more honest than the shipped consumer, which is the finding in section 5 | `unaudited` |

### 3.5 Production guards that carry a claim

Not tests, but claim-bearing checks in shipped code, so they belong in the
inventory.

| Location | The claim it enforces | Status |
| --- | --- | --- |
| `storage-db.ts:669` | The fence's two-arm accept condition | `unaudited` |
| `storage-db.ts:784-787` | `assertSqliteConnectionContract` with `expectWal` and `minBusyTimeoutMs: 5000`, on every accepted open | `unaudited` |
| `storage-session-runtime-schema.ts:130-132` | `stampDirectFormatFence` throws if the fence version ever reaches the downstream floor | `unaudited` |
| `storage-claim-operations.ts:2218-2220` | Checkpoint input validation: safe integer, non-negative | `unaudited` |
| `storage-claim-operations.ts:2222-2226` | Checkpoint regression rejected | `unaudited` |
| `storage-claim-operations.ts:2237-2245` | Checkpoint not beyond the outbox tail. Note the tail query carries **no project predicate** while the write it authorises is per project | `unaudited` |
| `storage-claim-operations.ts:2246-2259` | Checkpoint does not split a receipt group. Project-scoped, unlike the guard above it | `unaudited` |
| `module-state-sync.ts:2156-2172`, `:2182-2195` | `proveClaimOperationDurable`: count mismatch, repeated effect key, row-versus-result disagreement, generation not durably reached | `unaudited` |
| `module-state-sync.ts:2292-2297` | The drain re-checks the receipt id and the expected effect count | `unaudited` |
| `module-state-sync.ts:2298-2309` | Every effect in the group sits strictly above the current checkpoint, or the receipt is "checkpointed partially" | `unaudited` |
| `module-state-sync.ts:2323-2327` | The ack equals the last delivered effect id | `unaudited` |
| `module-wire.ts:729-733` | The decoder's independent check of the same equality | `unaudited` |
| `module-wire.ts:284-286` | The mirror snapshot vector's `databaseIncarnationId` matches `/^[0-9a-f]{32}$/` | `unaudited` |
| `module-state-sync.ts:2059` | `throw new Error("claim mirror outbox drain exceeded 1000 receipt groups")` | `unaudited` |
| `module-state-sync.ts:2354-2358` | The effects drain's equivalent bound | `unaudited` |
| `storage-claim-memory-schema.ts:416-418`, `:427-429`, `:433-438`, `:439-445`, `:449-456` | Five triggers on the claim tables: receipts never delete, effect updates raise, effect deletes require the prune capability and a watermark-bounded id, key-colliding inserts raise, and every effect must bind a claim of the stated project | `unaudited` |
| `storage-session-runtime-schema.ts:1190-1255` | The three `notes` authority guard triggers, each standing down when `context_privilege_state.enabled = 1` | `unaudited` |

## 4. Explicit "none found"

Categories with no check at all, stated explicitly per METHOD.md.

| Category | Finding |
| --- | --- |
| A malformed **and** newer marker at the fence | **None found.** `storage-db.test.ts:423-469` builds `formatEpoch: 2` with a **valid** digest via `buildDirectFormatMarker` and `computeMarkerDigest`, so it exercises the `present` branch. No test constructs the input where `readDirectFormatMarker` returns `malformed` while the vintage is newer, which is the case the epoch arm passes |
| Guidance-string selection for a `malformed-marker` family | **None found.** No test asserts which of the two strings at `storage-db.ts:700-701` a refused family receives |
| The `MAGIC_CONTEXT_LATEST_SUPPORTED_VERSION` environment path | **None found.** The variable has exactly one reference in the repository, its read at `storage-db.ts:217`. No test sets it, and none asserts that raising the ceiling leaves the epoch arm enforcing |
| An epoch-only skew at the child-spawn probe | **None found.** All four `schema-fence-probe.test.ts` cases drive the version lane |
| A live secondary connection across a fence refusal | **None found.** No test opens, writes a decision-log row, calls `closeDatabase`, then reopens under a refusal while the cached `telemetryDbByPath` handle is live |
| A fork-lane row at `openDatabase` | **Partial, not none.** `storage-db.test.ts:563-589` and `:128-145` cover the filter's behaviour; no test asserts what fence **verdict** a fork-lane database receives |
| An out-of-band writer to `claim_outbox_consumer_checkpoints` | **None found.** Every test writes it through `advanceOutboxConsumerCheckpointInCurrentTransaction` |
| A consumer that acks without applying | **None found**, and this is the shipped consumer. Section 5 |
| A delivery accepted while the consumer's store is opening | **None found** on either side of the wire |
| A claim write attempted while `authority_managed` holds a row | **None found.** No test attempts it and asserts the outcome |
| A malformed inbound claim-intent binding incarnation | **None found.** The decoder at `module-wire.ts:550-558` has no format assertion, so there is nothing to exercise |
| `decodeClaimEffectDeliveryResponse` | **None found anywhere in the tree.** Verified at `HEAD`: the only references are its definition (`module-wire.ts:717`), its single caller (`module-transport.ts:59`, `:1088`), and two build artifacts under `packages/plugin/dist/`. This confirms Part 4d's finding at this commit |
| A production caller of `pruneClaimOperationEffectsInCurrentTransaction` | **None found.** Verified at `HEAD`: outside `*.test.ts` the only two matches in the tree are its own definition (`storage-claim-operations.ts:2289`) and its own error string (`:2295`) |
| A cross-runtime campaign driving both fences | **None found.** Section 5 |
| Sibling test file for `storage-claim-memory-schema.ts` | **None found.** 464 lines, five triggers, no direct test file |
| Sibling test file for `storage-session-runtime-schema.ts` | **None found.** 1,264 lines including the fence stamp and the three notes authority triggers |
| Property-based or fuzz tooling over the fence or the checkpoint | **None found.** No `fast-check`, no generator-driven case in any file named in this inventory |

## 5. What is not covered, despite the suite

This is the section the inversion exists for. A 482-file suite running on every
push does not cover the following, and in each case the reason is structural rather
than an oversight.

### 5.1 The cross-language pairing is covered on one side and nowhere as a pair

The claim-effect delivery contract has two ends. Their coverage is asymmetric in
three separate ways at once, and Part 4d established all three from the module
side. Re-verified here at `HEAD`:

1. **The Rust half has no test.** `handle_claim_effects_apply`
   (`crates/mc-module/src/lib.rs:10184-10255`) has no test naming it, and no
   `mc-module` in-crate test compiles in CI anyway, because `ci.yml:172` selects
   `--test lifecycle_cli` and does not build `--lib`.
2. **The TypeScript producer is tested against a fake delivery closure.** Every
   check in section 3.4 supplies its own `deliver`. Two shapes exist:
   `module-state-sync.test.ts:1409-1415`, a pure echo, and
   `context-authority-crash.test.ts:214-231`, a modelled consumer that stores each
   receipt group, refuses a receipt that changed on replay, and refuses an effect
   crossing groups. **Neither is the shipped consumer**, and the second is
   strictly more honest than it. So the strongest crash-recovery evidence in this
   sub-part is evidence about a consumer that does not ship.
3. **The response decoder has zero test references anywhere.** Section 4.

The consequence for reading every `Exercised:` line in this catalog: a passing
TypeScript check is genuine evidence for the TypeScript path and **no** evidence
for its Rust counterpart, even where both consume the same frozen fixture. A
shared fixture proves agreement at the fixture's inputs and nothing beyond them.
The scope map raised this as an open question about how `Exercised` should be
labelled for cross-language pairs
([scope map:736-744](../part-5-ts-surfaces/_lenses/scope-map-and-risk-ranking.md));
it is still open, and this sub-part's records were written under the reading the
scope map proposed.

The vocabulary fixture is the sharpest instance. `storage-format-epoch.test.ts:81-87`,
`:103-105`, and `:107-117` assert TypeScript agreement with
`fixtures/direct-format-vocabulary-v1.json` and run on every push.
`crates/mc-store/tests/sqlite_runtime.rs:51-103` asserts Rust agreement with the
same file and runs nowhere. Both prove **agreement on the constants**. Neither
proves **enforcement**, and record 11 is the finding that only one side enforces
at all.

### 5.2 Guards with no counterpart on the Rust side

Each row is a TypeScript mechanism whose Rust equivalent does not exist, is not
called, or points the other way. Every one of these is verified in the catalog's
framing section and cited here as an inventory fact.

| TypeScript guard | Rust counterpart | Record |
| --- | --- | --- |
| `refuseNewerSchemaFence` (`storage-db.ts:651-681`), refusing a newer database | `refuse_pre_cutover_store` (`mc-store/src/lib.rs:1375-1385`) refuses only **below** the cutover; a recorded version above the ceiling falls through to `_ => Ok(())` at `:1383` | 10 |
| The marker epoch, the marker digest, `application_id`, `user_version`, and the exact object inventory as family identity | `crates/mc-store/src/sqlite_runtime.rs` defines the whole vocabulary and no production path calls it. Only `pub mod sqlite_runtime;` at `mc-store/src/lib.rs:17` references the module, and the single `sqlite_runtime::` use in the tree is in its own integration test | 11 |
| `claim_outbox_consumer_checkpoints`, the durable consumer cursor | **No such table under `crates/`.** Verified at `HEAD`: zero matches for the table name in the whole Rust tree | 13, 19 |
| Consumer identity as a contract, two distinct constants at `module-state-sync.ts:1617` and `:1621` | The module requires `consumer` to be a non-empty string and never compares its value (Part 4d, `lib.rs:10198-10204`) | 14 |
| `proveClaimOperationDurable`'s local durability proof | Not applicable, and there is no consumer-side counterpart that proves application | 14 |
| `advanceOutboxConsumerCheckpointInCurrentTransaction`'s four guards | No counterpart; the cursor exists only in TypeScript | 15 |
| The three `notes` authority triggers (`storage-session-runtime-schema.ts:1190-1255`) | No equivalent for any claim table on either side; `authority_managed` has **zero** references in `storage-claim-memory-schema.ts` | 20 |
| `isValidDatabaseIncarnationId`, `/^[0-9a-f]{32}$/`, enforced on the marker read | Rust's `set_claim_intent_transition_tx` silently returns `Ok(())` on a non-32-hex argument, and its four callers pass a dashed `context_store_uuid` (Part 3) | 21 |

The direction matters and is one-way. Because only the TypeScript half is
CI-verified, a **TypeScript-only** guard is an unverified Rust obligation, and a
**Rust-only** guard would be a live TypeScript defect. Every row above is the
first kind. This sub-part found no guard present on the Rust side and missing on
the TypeScript side.

### 5.3 What the strong suite covers well, so it is not mistaken for a gap

Recorded because two records' `Exercised:` lines read `yes` and that is unusual in
this catalog. The beyond-tail bound, the receipt-split bound, and the accepted-path
fence each have a dedicated case that constructs the state and asserts the exact
error or the exact latch. The crash-cut coverage in
`storage-claim-operations-crash.test.ts` and `context-authority-crash.test.ts` is
real process-level SIGKILL and durable-cut work, not simulated, and it drives the
real `drainClaimEffectPrefix`. The claim-schema trigger contract is exercised at
`storage-claim-operations.test.ts:1110-1123`. None of this is weak coverage. The
findings in this sub-part sit beside it, not instead of it.

## 6. A reference correction, recorded rather than applied

Per METHOD.md rule 1, every line reference in this document was read back at
`HEAD`. Doing that surfaced a systematic forward drift in one lens file's
citations of one test file. The records themselves are reproduced verbatim in
`catalog.md` per the synthesis instruction, so the correction is recorded here
instead of edited into them, and it is flagged for the portfolio evaluation.

`_lenses/lens-a-schema-fence.md` cites `storage-db.test.ts` with a consistent
offset of roughly two to seven lines. Verified boundaries at `HEAD`, computed by
matching each `it(` to its closing brace at the same indent:

| Lens A citation | Verified at `HEAD` | What it names |
| --- | --- | --- |
| `:421-476` | `:423-469` | Newer version lane refused, digest unchanged |
| `:478-497` | `:471-494` | Accepted-path fence, `current` family with a newer fence row |
| `:481-484` | `:473-476` | That test's inline comment |
| `:432-459` | `:427-431` for the marker build; digest asserted at `:468` | The `formatEpoch: 2` valid-digest marker |
| `:352-372` | inside `:325-373` | The epoch-only case |
| `:368`, `:459`, `:494` | `:369`, `:462`, `:488` | The three `toBeNull()` assertions |
| `:373-396` | `:375-394` | The `unsupported` legacy family |
| `:398-420` | `:396-421` | Unsupported family with committed WAL state |
| `:394` | `:393` | `existsSync(\`${dbPath}-wal\`) === false` |

**No substantive claim changes.** Every test the lens says exists does exist, every
assertion it attributes is present, and the inline comment it quotes is there.
Only the numbers drift. The lens's other citations were spot-checked and hold:
`schema-fence-probe.test.ts:32`, `:68`, `:85`, `:95` are exact, and
`storage-db.ts`'s production references at `:651-681`, `:668`, `:669`, `:672`,
`:678`, `:689`, `:777` are exact.

`_lenses/lens-b-outbox-authority.md`'s citations were checked the same way and are
accurate. `storage-claim-operations.test.ts:954-1016`, `:1018-1058`, `:842-900`,
and `:902-952` are exact to the line; `module-state-sync.test.ts:1400-1422` and
`:1424-1441` are exact; `context-authority-crash.test.ts:214-231` and `:330-370`
correctly name helper regions rather than tests. One range is short:
`:1060-1087` for "pruning and restart leave the lifetime receipt and late replay
intact" is `:1060-1108` at `HEAD`, and the cited span is inside it.

## 7. Suspiciously quiet areas

Where the ratio of durable consequence to check density is worst.

- **`storage-claim-memory-schema.ts`, 464 lines, five triggers, no test file.**
  Its triggers are the append-only contract every outbox record depends on, and
  they are exercised only indirectly through
  `storage-claim-operations.test.ts:1110-1123`. Nothing tests the schema fragment
  as a unit, and nothing tests the one table it calls "mutable by design"
  (`:22-31`) for the property its own comment says lives in application code
  (`:286-288`).
- **`storage-session-runtime-schema.ts`, 1,264 lines, no test file.** It holds
  `stampDirectFormatFence`, the fence row's `throw` at `:130-132`, and the three
  `notes` authority triggers at `:1190-1255`. The stamp is covered indirectly by
  `schema-version-fence.test.ts:30-37`. The triggers are covered by nothing found
  in this pass, and they are the exact mechanism record 20 says the claim tables
  lack.
- **`storage-meta-persisted.ts`, 2,735 lines against 291 test lines and 16
  cases.** The worst ratio in the scope set by an order of magnitude: 9.4
  production lines per test line, against `storage-claim-operations.ts`'s 1.05
  and `module-state-sync.ts`'s 1.46. It is the second-largest file in the sub-part
  and no record in this catalog is anchored in it, which is a scoping observation
  rather than a claim that it is safe. Whether the two lens focuses simply did not
  reach it is an open question for the portfolio evaluation.
- **`storage-claim-policy.ts`, 776 lines, 14 cases.** The policy projection that
  `storage-claim-operations.test.ts:763-818` asserts agreement with. Also carries
  no record.
- **The guidance strings and the log text.** `storage-db.ts:678`, `:700`, and
  `:701` are the only channel through which a refused user learns what to do, one
  of them tells the user not to reset and another tells them to, and no test
  asserts any of the three strings. `plugin/rpc-handlers.test.ts:84-103` covers
  the sidebar surface but not the text.
- **The latch as process-global mutable state.** `lastSchemaFenceRejection`
  (`storage-db.ts:72`) is cleared at `:838-839` and `:879-880` on every open
  attempt, so a second open erases a prior rejection before a reader sees it.
  `config/latch-permanence-guard.test.ts:180-202` registers the slot in a
  permanence registry; nothing tests the clear-on-reopen behaviour or the
  cached-handle path at `:840-851` that returns a handle admitted under a possibly
  different ceiling.

## 8. Sampling limits on this inventory

- Test-file attribution is by filename sibling and suffix. A check living in an
  unrelated file that happens to exercise a 5a mechanism is found only if it
  imports a named 5a symbol; that search was run for the fence and outbox APIs and
  surfaced `schema-version-fence.test.ts`, `claims-direct-cutover.test.ts`, and
  `plugin/rpc-handlers.test.ts`, none of which is a filename sibling. Other such
  files may exist for mechanisms I did not search by name.
- Case counts are top-level `it(`/`test(` declarations and do not count
  `it.each`, table-driven expansion, or assertions per case. A 45-case file is not
  necessarily 45 independent claims.
- `packages/e2e-tests` (107 test files) is excluded from Part 5 as harness and was
  not searched for 5a coverage. If a cross-runtime fence or outbox scenario exists
  anywhere, that is where it would be, and record 12's open question says so.
- CI behaviour is read from the workflow files and `package.json` scripts. I cannot
  observe a CI run from here, so "runs at `ci.yml:257`" is a reading of the
  configuration, not an observation of a green job. The scope map records one
  unresolved workflow defect on this basis at `ci.yml:214`
  (`test:mc-shm:node`, a script `packages/plugin/package.json` does not define);
  it is outside 5a scope and remains open.
- Production-guard coverage in section 3.5 is the guards the two lens passes
  reached. `storage-meta-persisted.ts` and `storage-claim-policy.ts` were not
  swept for assertions, consistent with their appearance in section 7.
