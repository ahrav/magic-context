# Test-Suite DRY / Redundancy Audit — 2026-08-29

**Scope**: all TypeScript test code — `packages/e2e-tests/`, `packages/plugin`, `packages/pi-plugin`, `packages/cli`, `packages/retina-local-fs`, `scripts/`, `tests/`.
**Verified against**: `9c1eb4d1` (HEAD, `Merge pull request #85 from ahrav/remove-tauri-dashboard`).
**Method**: 597 test files / **7,088 extracted test bodies** parsed with a brace-matching extractor; normalized-body SHA-1 exact-dup classes; 4-gram Jaccard near-dup clustering (within-file and cross-file); helper/hook block extraction (2,029 blocks) with exact + near-dup classing; `rg` reference counting for dead helpers; `git log` per-file churn.
**No files modified. No `git stash` used.**

---

## Summary

### Headline: this suite is unusually non-duplicative at the *test* level

Of **7,088 test bodies**, exact-normalized-body duplication found **2 clone classes (8 LOC total)**. Near-duplicate clustering at Jaccard ≥ 0.55 found only **15 within-file clusters** with ≥ 5 members. For a ~214k-LOC test corpus that is a very low rate. **There is no large pool of deletable tests here.**

The real duplication is in **fixtures and setup**, and it is not merely LOC — three clone classes have **already drifted into semantically different oracles**, which is a correctness hazard, not a tidiness one:

| Clone class | Copies | Drift observed |
|---|---|---|
| `isHistorianRequest` (e2e) | **13** | 6 copies detect via `<new_messages>`, **7 do not** |
| hand-rolled `CREATE TABLE session_meta` DDL | **15** | column counts range **8 → 42** |
| `sendErrorBody` (wire framing) | 2 | one side gained an `extra` param, other did not |

### Counts and estimated removable LOC

| Tier | Items | Est. LOC removable |
|---|---|---|
| **T0** — dead helpers, tautological tests with zero oracle value | 6 findings (4 tests + 2 dead helpers) + 1 rename + 8 over-exports | **~82** |
| **T1** — parameterization collapses within one file | 12 clusters | **~450–480** |
| **T2** — cross-package fixture consolidation, sensitive-subsystem touches | 8 clone classes + 1 test-file deletion | **~1,250–1,350** |
| **do not delete yet** | 4 findings | 0 (2 are *coverage gaps*, not slack) |
| **Total** | | **~1,800–1,900 LOC (~0.9% of test corpus)** |

Exact-duplicate *tests*: **2 classes, 8 LOC** (T0). Everything else above is fixture/setup consolidation or table-driven collapse.

---

## 1. Tautological tests

Only four genuine zero-oracle tests exist in 7,088. All are "the import already proved this" shapes.

### T0-1 — `session-cleanup-wiring.test.ts`: three existence asserts subsumed by their own siblings
**File**: `packages/pi-plugin/src/session-cleanup-wiring.test.ts:35-38`, `:64-67`, `:90-93` (3 tests, **12 LOC**)

```ts
// :32-38
const fn = HANDLER_SRC.match(/export function clearContextHandlerSession\([^{]*\{([\s\S]*?)\n\}/);
test("function exists and is exported", () => { expect(fn).not.toBeNull(); });
const body = fn?.[1] ?? "";
```

**Why tautological**: `body` is derived from `fn` via `fn?.[1] ?? ""`. If `fn` were `null`, `body` becomes `""` and every sibling `expect(body).toContain(...)` at `:43`, `:51`, `:56` fails. The existence test cannot fail without its siblings also failing — it adds zero failure-detection power.
**Surviving coverage**: `:42-44`, `:46-52`, `:54-57` (same file). Same argument for `:64-67` (siblings at `:71-75`, `:77-79`, `:81-83`) and `:90-93` (sibling at `:97-103`).
**Churn**: 3 commits. **Tier**: T0 (the only loss is a nicer error message on a null match; the siblings still fail loudly).

### T0-2 — `compaction-accessor-guard.test.ts`: `typeof === "function"` subsumed by the call site
**File**: `packages/plugin/src/config/compaction-accessor-guard.test.ts:73-77` (1 test, **5 LOC**)

```ts
it("isCompactionEnabled is exported from the accessor module", async () => {
    const mod = await import("../config/agent-disable");
    expect(typeof mod.isCompactionEnabled).toBe("function");
});
```

**Why tautological**: the next test (`:79-86`) does `const { isCompactionEnabled } = await import("../config/agent-disable")` then **calls it five times**. A non-function throws there.
**Surviving coverage**: `packages/plugin/src/config/compaction-accessor-guard.test.ts:79-86` — strictly stronger (proves it exists *and* that all five default/explicit branches resolve correctly).
**Churn**: 2 commits. **Tier**: T0. *Note*: the file's primary guard (`:59-72`, the no-direct-reader scan) is untouched by this and must stay.

### T0-3 — `ctx-reduce/constants.test.ts`: "should be non-empty" subsumed by the substring test
**File**: `packages/plugin/src/tools/ctx-reduce/constants.test.ts:8-10` (**3 LOC**)

```ts
it("should be non-empty", () => { expect(CTX_REDUCE_DESCRIPTION.length).toBeGreaterThan(0); });
```

**Why tautological**: `CTX_REDUCE_DESCRIPTION` is a string literal constant; a literal is trivially non-empty.
**Surviving coverage**: `packages/plugin/src/tools/ctx-reduce/constants.test.ts:12-24` asserts `toContain("discardable")`, `toContain("NOT an immediate delete")`, `toContain("DONE with")` — each strictly implies non-empty, and pins the actual prompt-surface contract.
**Churn**: 2 commits. **Tier**: T0.

### T0-4 — `auto-update-checker/constants.test.ts`: constant asserted equal to a copy of itself
**File**: `packages/plugin/src/hooks/auto-update-checker/constants.test.ts:6-11` (**6 LOC**)

```ts
test("uses Magic Context package identity and npm defaults", () => {
    expect(PACKAGE_NAME).toBe("@cortexkit/opencode-magic-context");
    expect(NPM_REGISTRY_URL).toBe("https://registry.npmjs.org");
    expect(NPM_FETCH_TIMEOUT).toBe(10_000);
});
```

**Why tautological**: each assertion restates the literal in `constants.ts`. It can only fail when someone edits the constant, at which point they edit the test in the same keystroke. There is no independent oracle.
**Churn**: 1 commit. **Tier**: T0 **as written** — but see the stronger alternative below, which is the better move than plain deletion:

> `packages/plugin/src/hooks/auto-update-checker/index.test.ts:7` independently declares `const PACKAGE_NAME = "@cortexkit/opencode-magic-context";` — a *second* hand-copy of the same literal. A real parity assertion (`PACKAGE_NAME === <root package.json>.name`) would have genuine oracle value and would also catch the `index.test.ts` copy drifting. Recommend **replace, not delete**.
> The sibling test at `:13-16` (`CACHE_DIR` `toContain("opencode")` / `toEndWith("packages")`) asserts a *computed* path and is **not** tautological — keep.

### Explicitly NOT tautological (checked and cleared)
- `packages/plugin/src/features/magic-context/memory/constants.test.ts:11-19` — cross-representation parity between the TS `MEMORY_CATEGORY_ORDER_PRIORITY` map and the `MEMORY_CATEGORY_ORDER_SQL` `CASE` string. Real drift oracle. **Keep.**
- `packages/plugin/scripts/build-schema.test.ts:55-63` (`auto_update is present in the schema`) — issue #109 regression guard against generator drift. **Keep**, and see TRACKED `1cy`.
- `packages/plugin/src/features/magic-context/query-normalization.test.ts:41-44` (`re-exports the identical functions`) — asserts **referential identity** (`expect(reexportedNormalize).toBe(normalizeQueryText)`), which catches a duplicated re-implementation behind the re-export. Real oracle. **Keep.**

---

## 2. Subsumed tests

### T2-1 — `pi-plugin/src/config/project-security.test.ts` is fully subsumed on every axis
**File**: `packages/pi-plugin/src/config/project-security.test.ts:1-57` (**4 tests, 57 LOC — whole file**)

The file imports **the identical function under test** from core:
```ts
// :3
import { stripUnsafeProjectConfigFields } from "@magic-context/core/config/project-security";
```
It exercises **no pi-plugin code whatsoever**. Line-level comparison:

| pi assertion | pi loc | survivor | survivor loc | strength |
|---|---|---|---|---|
| `expect(raw.language).toBeUndefined()` | `:13` | `expect("language" in raw).toBe(false)` | `plugin/src/config/project-security.test.ts:74` | **survivor stronger** — `in` distinguishes an absent key from a present-but-`undefined` key; `toBeUndefined()` passes in both |
| `expect(raw.dreamer).toEqual({model:"x"})` | `:14` | identical | `…:75` | equal |
| `warnings…toContain("Ignoring language from project config")` | `:15-17` | `warnings.join("\n")).toContain("Ignoring language from project config")` | **`pi-plugin/src/config/index.test.ts:401-403`** | **survivor stronger** — same exact string, but reached through the real `loadPiConfig({cwd})` loader, and additionally asserts `result.config.language === "pt"` (user tier wins) |
| `fail_closed_blocking` absent + warning | `:20-30` | `expect("fail_closed_blocking" in raw).toBe(false)` + warning | `plugin/…project-security.test.ts:18-27` | survivor stronger (`in`) |
| `compaction.enabled` only-key case | `:32-44` | identical body + `// Block not deleted wholesale` note | `plugin/…project-security.test.ts:246-258` | equal, plus `warnings.some(...)` |
| `compaction.enabled` sibling-key case | `:46-56` | identical body | `plugin/…project-security.test.ts:260-270` | equal |

**Pi wiring is separately covered and stronger**: `packages/pi-plugin/src/config/index.ts:403` and `:575` call `stripUnsafeProjectConfigFields`, and that wiring is proven end-to-end through `loadPiConfig` by `packages/pi-plugin/src/config/index.test.ts:391-404` plus its siblings (`strips hidden-agent prompt/permission from PROJECT config`, `strips allow_home_project from PROJECT config`, `strips prompt-surface text from PROJECT config`, `rejects prototype-pollution keys before project security filtering`).

**Tier: T2** (not T1). *Impact note*: this is the **project-config privilege-escalation boundary**. Even though subsumption is complete and cited, deleting a security-boundary test file warrants a human reviewer signing off that `pi-plugin/src/config/index.test.ts` is accepted as the pi-side survivor. Est. **57 LOC**.
Churn: `plugin` side 18 commits (hot, well-maintained); pi side low.

### Cleared (checked, NOT subsumed)
- `packages/pi-plugin/src/embedding-bootstrap.test.ts` vs `packages/plugin/src/plugin/embedding-bootstrap.test.ts` — same filename, **disjoint** single tests (`registers Synapse as deferred intent without persisting a pending lane` vs `reads the legacy config and registers the real identity … when only legacy config exists`). **Both keep.**
- All 22 `*-pi.test.ts` ↔ `*.test.ts` twins were checked by title and import surface. They exercise the **pi transcript/session shape** against core logic, not the same inputs. No subsumption found.

---

## 3. Pure-duplicate tests

Only **2 classes** in 7,088 tests (exact normalized body match).

| # | Test name | Copies | LOC each | Tier |
|---|---|---|---|---|
| D1 | `stages the marker (deferred) instead of applying it eagerly` | `packages/pi-plugin/src/commands/ctx-recomp-signals.test.ts:56`<br>`packages/pi-plugin/src/commands/ctx-session-upgrade-signals.test.ts:39` | 5 | T0 |
| D2 | `runs detached via spawnPiRecompRun (non-blocking REPL)` | `packages/pi-plugin/src/commands/ctx-recomp-signals.test.ts:31`<br>`packages/pi-plugin/src/commands/ctx-session-upgrade-signals.test.ts:29` | 3 | T0 |

**Est. removable: 8 LOC.** Both pairs assert the same deferred-marker/detached-spawn contract for two different commands (`ctx-recomp` and `ctx-session-upgrade`). Because the *subject command differs* even though the body is byte-identical after normalization, the honest fix is **not deletion** but a shared parameterized helper invoked once per command — otherwise you silently drop coverage of one command. Treat as T0 *consolidation*, not T0 *deletion*.

---

## 4. Fixture clone classes

Ranked by (drift risk × copies). `useTempDataHome`/`afterEach`/`session_meta` numbers come from the exact + near-dup helper classer over 2,029 extracted blocks.

### CC-1 — `isHistorianRequest` · 13 copies · **DRIFTED ORACLE** · T2
**Members** (all `packages/e2e-tests/tests/`):
`cache-invariants.test.ts:55` · `deferred-compaction-marker.test.ts:44` · `emergency-blocking.test.ts:31` · `historian-success.test.ts:29` · `long-running-session.test.ts:106` · `pi-cache-invariants.test.ts:51` · `pi-deferred-compaction-marker.test.ts:55` · `pi-emergency-blocking.test.ts:10` · `pi-historian-success.test.ts:9` · `pi-long-running-session.test.ts:79` · `pi-slow-historian.test.ts:9` · `slow-historian.test.ts:46` · `subagent-behavior.test.ts:45`

**Common core**: classify a provider request as historian-originated by scanning `body.system` (string or block array) for `HISTORIAN_SYSTEM_MARKER`.
**Differences — this is the finding**: **6 of 13** copies additionally short-circuit on `JSON.stringify(body.messages ?? "").includes("<new_messages>")`; **7 do not**. Compare `historian-success.test.ts:30` (has it) against `pi-historian-success.test.ts:9-23` and `deferred-compaction-marker.test.ts:44-62` (identical otherwise, missing it). A test holding a weaker copy will classify a historian request that carries the marker only in `messages` as a **main-agent** request, silently changing what its cache/pass assertions mean.
**Proposed helper**: `packages/e2e-tests/src/cache-analysis.ts` — already the owner of exactly this concern; it exports `isInternalAgentRequest` at `:84` and `mainAgentRequests` at `:277`. Add `isHistorianRequest(body)` there with the union (`<new_messages>` ∨ system-marker) semantics and re-point all 13.
**Est.**: 13 × ~16 LOC = ~208 → one ~18 LOC helper ⇒ **~190 LOC**. **Tier T2** — changing the predicate to the union will make some currently-passing weaker-copy tests newly classify requests as historian; land behind a review that inspects each site's assertions.

### CC-2 — hand-rolled `CREATE TABLE session_meta` DDL · 15 copies · **DRIFTED SCHEMA** · T2
**Members** (approx. column count per copy, measured):
| cols | file |
|---|---|
| 8 | `packages/cli/src/commands/migrate-session.test.ts` |
| 13 | `packages/plugin/src/features/magic-context/dreamer/retrospective-raw-provider.test.ts` |
| 18 | `packages/plugin/scripts/clone-session.test.ts` |
| 19 | `packages/plugin/scripts/recover-benchmark-candidates.test.ts` |
| 22 | `packages/pi-plugin/src/boundary-execution-pi.test.ts:15` |
| 22 | `packages/plugin/src/features/magic-context/boundary-execution-cas-race.test.ts` |
| 22 | `packages/plugin/src/features/magic-context/storage-meta-persisted.test.ts:12` |
| 22 | `packages/plugin/src/hooks/magic-context/boundary-execution-integration.test.ts:19` |
| 23 | `packages/plugin/src/features/magic-context/storage-tags.test.ts` |
| 24 | `packages/plugin/src/hooks/magic-context/heuristic-cleanup.test.ts` |
| 24 | `packages/plugin/src/tools/ctx-reduce/non-blocking-dispatch.test.ts` |
| 24 | `packages/plugin/src/tools/ctx-reduce/tools.test.ts` |
| 25 | `packages/plugin/src/features/magic-context/storage-meta-persisted-overflow.test.ts:17` |
| 32 | `packages/plugin/src/hooks/magic-context/command-handler.test.ts` |
| 42 | `packages/plugin/src/hooks/magic-context/note-nudger.test.ts` |

**Common core**: a `Database(":memory:")` plus a hand-typed `session_meta` DDL.
**Differences**: the column set. `boundary-execution-integration.test.ts:19-49` and `boundary-execution-pi.test.ts:15-44` are **byte-identical 31-LOC copies** of the same 22-column DDL (the only diff is import paths: relative vs `@magic-context/core/...`). The 8-column and 42-column copies are the drift extremes.
**Why it matters beyond LOC**: each copy is an independent, silently-stale mirror of production migrations. A test can pass against its own private 2024-era schema while the real schema has moved.
**Proposed helper — already exists and is already adopted by 117 files**: `packages/plugin/src/features/magic-context/test-database.ts:43` `createDirectTestDatabase()`, which composes the schema from `CURRENT_SCHEMA_COMPONENTS` (single source of truth) and stamps the direct-format marker. For pi-plugin the wrapper is even closer to hand: `packages/pi-plugin/src/test-utils.test.ts:8` `createTestDb()` already delegates to it and is imported by **31** sibling pi tests — `boundary-execution-pi.test.ts` simply did not use it.
**Est.**: ~360 LOC of DDL → **~330 LOC**. **Tier T2**: several members are claims/boundary-execution tests, and adopting the real schema will surface currently-hidden mismatches (that is the point, but it is not a silent refactor).

### CC-3 — `useTempDataHome` / `makeTempDir` / `tempDir` + paired `afterEach` teardown · 31 + 17 copies · T2
**Scale**: 176 test files call `mkdtempSync` (**564 call sites**); **75** declare a `tempDirs: string[]` ledger; **76** mutate `XDG_DATA_HOME`.

Representative members of the 31-copy factory class:
`packages/plugin/src/features/magic-context/compartment-storage-v6.test.ts:9` · `…/compression-depth-storage.test.ts:18` · `…/storage.test.ts:66` · `…/project-identity.test.ts:36` · `…/project-docs-hash.test.ts:16` · `packages/plugin/src/hooks/magic-context/apply-operations.tool-drop.test.ts:40` · `…/compaction-off-transition.test.ts:70` · `…/compartment-runner-drop-queue.test.ts:48` · `…/read-session-db.test.ts:363` · `…/tag-messages-collision.test.ts:44` · `…/tool-input-preservation.test.ts:26` · `…/transform-context-state.test.ts:32` · `…/transform-operations.test.ts:44` · `…/compartment-runner-timeout.test.ts:133` · `…/compartment-runner.test.ts:1008` · `…/compartment-trigger.test.ts:35` · `…/transform-heuristic-cleanup-persistence.test.ts:28` · `…/transform-todo-state.test.ts:39` · `…/system-prompt-hash.test.ts:60` · `…/transform-index-staleness.test.ts:49` · `…/module-state-sync.test.ts:80` · `…/read-session-chunk.test.ts:32` · `…/transform-cache-busting-signals.test.ts:70` · `…/transform-compaction-off.test.ts:105` · `packages/plugin/scripts/recover-benchmark-candidates.test.ts:35` · `packages/plugin/scripts/retrieval-benchmark/runner.test.ts:32` · `packages/plugin/src/plugin/embedding-bootstrap.test.ts:17` · `packages/cli/src/commands/migrate.test.ts:30` · `packages/plugin/src/shared/rpc-client.test.ts:37` · `packages/plugin/src/features/magic-context/git-anchors/git-anchor-reader.test.ts:9` · `packages/plugin/src/hooks/auto-update-checker/index.test.ts:62`

**Common core** (18 copies byte-identical):
```ts
function useTempDataHome(prefix: string) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir); process.env.XDG_DATA_HOME = dir;
}
```
**Differences**: (a) `void` vs `string` return; (b) whether `XDG_DATA_HOME` is set at all (the `makeTempDir` variants do not); (c) `packages/plugin/src/hooks/magic-context/compaction-marker-consistency.test.ts:15` and `…/compaction-marker-manager.test.ts:50` additionally `mkdirSync` the `opencode/` and `cortexkit/magic-context/` subtrees.

Paired teardown class — **17 copies**, 15 byte-identical at 14 LOC (`closeDatabase()` → restore `XDG_DATA_HOME` → `rmSync` each temp dir with `maxRetries: 10, retryDelay: 100` → `tempDirs.length = 0`), the largest at `packages/plugin/src/hooks/magic-context/compartment-runner.test.ts:68` (22 LOC, also sweeps `tmpdir()/magic-context-historian`).

**Proposed helper**: new `packages/plugin/src/shared/test-support/temp-data-home.ts` exporting one `useTempDataHome({ prefix, layout?: "plain" | "opencode-db" })` that owns the ledger and registers its own `afterEach`. Re-export for pi-plugin through `@magic-context/core`.
**Est.**: (31 × ~7) + (17 × ~14) ≈ 455 LOC → **~410 LOC**. **Tier T2** (spans `plugin/src`, `plugin/scripts`, `cli`, `pi-plugin`).

### CC-4 — wire-framing peer helpers · 2 copies · **DRIFTED** · T2 (sensitive: wire framing / shm transport)
**Members**:
| helper | `packages/plugin/src/hooks/magic-context/module-transport.test.ts` | `packages/plugin/src/shared/mc-host-client/client.test.ts` |
|---|---|---|
| `frameCursor` | `:134` (20 L) | `:153` (20 L) |
| `jsonBody` | `:155` (3 L) | `:174` (3 L) |
| `sendResponse` | `:158` (10 L) | `:177` (10 L) |
| `sendErrorBody` | `:169` (13 L) | `:188` (**14 L**) |
| `sendRouteOpenOk` | `:184` (13 L) | `:204` (13 L) |

**Common core**: cursor-based frame scanning over `FakePeerConnection.frames` plus JSON-body response/error/route-open senders.
**Difference — already drifted**: `client.test.ts:188` `sendErrorBody` gained an `extra: Record<string, unknown> = {}` parameter spread into the error body; `module-transport.test.ts:169` did not. The two files now build *different* error frames from the same-named helper.
**Proposed helper**: `packages/plugin/src/shared/mc-host-client/test-support/fake-peer.ts` — the existing home of `FakePeerConnection`, `PEER_HEADER_LEN` (`:17`) and `encodePeerAuthMessage` (`:76`). It currently exports **no** frame helpers (verified), so this is a clean addition.
**Est.**: 2 × ~59 LOC ⇒ **~59 LOC**. **Tier T2 minimum** — wire framing + shm transport; also interacts with TRACKED `magic-context-kp5` (outgoing-frame byte accounting owner in `wire.rs`) and `magic-context-ymc`.

### CC-5 — e2e mock-provider body/session helpers · ~15 copies · T2
| helper | members |
|---|---|
| `stripCacheControl` | `cache-stability.test.ts:45` (12 L) · `long-running-session.test.ts:85` (13 L) · `pi-cache-stability.test.ts:79` (13 L) · `pi-long-running-session.test.ts:58` (13 L) |
| `latestSessionFile` | `pi-compaction-off.test.ts:22` (17 L) · `pi-deferred-compaction-marker.test.ts:98` (16 L) · `pi-long-running-session.test.ts:207` (16 L) |
| `emitMemoryWriteOnce` | `memory-injection.test.ts:30` (34 L) · `pi-memory-injection.test.ts:29` (29 L) · `pi-cross-harness.test.ts:18` (29 L, takes `mock` as a param) |
| `textFromContent` | `long-running-session.test.ts:129` · `pi-long-running-session.test.ts:87` (12 L) |
| `findToolName` | `long-running-session.test.ts:149` · `pi-long-running-session.test.ts:120` (11 L) |
| `readCompactionEntries` | `pi-deferred-compaction-marker.test.ts:114` · `pi-long-running-session.test.ts:223` (10 L) |

All in `packages/e2e-tests/tests/`. **Proposed helpers**: request/body shapers (`stripCacheControl`, `textFromContent`, `findToolName`) → `packages/e2e-tests/src/cache-analysis.ts` (already owns `extractMessageText:297`, `extractM0:322`, `extractM1:327`, `buildSegments:132`). Pi session-file readers (`latestSessionFile`, `readCompactionEntries`) → `packages/e2e-tests/src/pi-harness.ts` as `PiTestHarness` methods. `emitMemoryWriteOnce` → `packages/e2e-tests/src/scripted-tool-call.ts`, standardizing on the `pi-cross-harness.test.ts:18` signature that already takes the mock explicitly.
**Est.**: ~169 LOC → **~120 LOC**. **Tier T2** (cross-file e2e harness).

### CC-6 — `createOpenCodeDb` · 13 copies · T2
`packages/plugin/src/features/magic-context/compaction-marker.test.ts:27` · `…/message-index-maintenance.test.ts:17` · `packages/plugin/src/hooks/magic-context/compaction-marker-consistency.test.ts:29` · `…/compaction-marker-manager.test.ts:60` · `…/compaction-off-transition.test.ts:92` · `…/compartment-runner.test.ts:1015` · `…/compartment-runner-timeout.test.ts:140` · `…/compartment-trigger.test.ts:42` · `…/degraded-reanchor.test.ts:63` · `…/module-state-sync.test.ts:87` · `…/read-session-chunk.test.ts:39` · `…/read-session-db.test.ts:380` · `…/transform-compartment-phase.test.ts:15`

4 of these are byte-identical 13-LOC copies (`compaction-marker-consistency:29`, `compaction-marker-manager:60`, `degraded-reanchor:63`, `compaction-marker:27` at 12 L). The rest diverge in signature (`(dataHome)` vs `(sessionId)` vs `(rows: MessageRow[])` vs `(liveSessionIds: string[])`).
**Proposed helper**: `packages/plugin/src/features/magic-context/test-database.ts` — add `createOpenCodeTestDb({ dataHome, rows? })` beside `createDirectTestDatabase`. Only the 4 identical + the 2 `(sessionId)` variants should be folded in the first pass; the row-seeding variants need per-site review.
**Est.**: **~80 LOC** (conservative — identical members only).

### CC-7 — pi command mock + claim seeding · 12 copies · T1/T2
| helper | members | LOC |
|---|---|---|
| `createMockPi` | `packages/pi-plugin/src/commands/ctx-approve.test.ts:23` (18) · `…/ctx-enforce.test.ts:25` (18) · `…/ctx-commands.test.ts:55` (21) | 18–21 |
| `createCountingPi` | `packages/pi-plugin/src/index-env-guard.test.ts:28` · `…/index-in-process-latch.test.ts:35` — **byte-identical, 29 L** | 29 |
| `seedClaim` | `pi-plugin/src/commands/ctx-approve.test.ts:47` · `plugin/…/dreamer/verify.test.ts:42` · `…/dreamer/verify-gate.test.ts:46` · `…/dreamer/map-memories.test.ts:44` · `…/dreamer/classify.test.ts:34` · `…/dreamer/storage-dream-runs.test.ts:84` · `…/context-authority-crash.test.ts:235` | 23 (3 identical) |
| `assistantMessages` | `plugin/…/dreamer/task-executor.test.ts:57` · `…/mural/compress-cues.test.ts:29` · `…/user-memory/review-user-memories.test.ts:47` — **byte-identical, 9 L** | 9 |
| `makeGitCommit` | `plugin/…/project-embedding-registry.test.ts:102` · `…/shadow-backfill.test.ts:83` (identical, 11 L) · `…/git-commits/indexer.test.ts:51` (+`message?`) | 11 |

**Proposed helpers**: `createMockPi`/`createCountingPi` → extend `packages/pi-plugin/src/test-utils.test.ts` (which already exports `createFakePi`, used by `commands/ctx-aug.test.ts:3`). `seedClaim` + `assistantMessages` → new `packages/plugin/src/features/magic-context/dreamer/dreamer-test-support.ts`. `makeGitCommit` → `packages/plugin/src/features/magic-context/git-commits/` test-support module.
**Est.**: **~60 LOC**. `seedClaim` members touch **claims policy** ⇒ **T2**; `createCountingPi` and `assistantModules` are byte-identical ⇒ T1 within-package.

### CC-8 — e2e `TestHarness.create` bootstrap · 11 copies · **low value, recommend NO ACTION**
`overflow-recovery.test.ts:73` · `pi-context-limits.test.ts:20` · `pi-overflow-recovery.test.ts:31` · `short-context-overflow.test.ts:60` · `pi-short-context-overflow.test.ts:56` · `cache-stability.test.ts:31` · `historian-success.test.ts:69` · `slow-historian.test.ts:55` · `emergency-blocking.test.ts:49` · `deferred-compaction-marker.test.ts:102` · `session-isolation.test.ts:33`

Already 8 LOC and already delegating to `TestHarness.create` (`packages/e2e-tests/src/harness.ts:81`). The only variation is a meaningful per-suite `execute_threshold_percentage` (40 vs 80). **Consolidating this would hide a semantically important knob behind a helper. Leave it.** Listed for completeness so a future pass does not "fix" it.

The 11-copy `rust-*` `beforeEach`/`beforeAll` class (`rust-fm-oc-1..6`, `rust-park-self-heal:37`, `rust-removal-self-heal:26`, `rust-tail-mutation-readopt:63`, `rust-smoke:10`, `rust-steady-state-byte-identity:25`, each 7 L) is likewise already thin and already importing `rustPrereqs`/`driveToSteadyState` from `packages/e2e-tests/src/rust-scenario-support.ts`. **No action** — but see TRACKED `magic-context-dmv`, which already owns fixture consolidation in this area.

---

## 5. Parameterization table

Only **9 of 597** test files currently use `test.each`/`it.each`/`describe.each` (`condition-compiler.test.ts` ×3, `mc-host-client/connection.test.ts` ×2, `harness-provider-map`, `escalation-bands`, `fold-execution-gate`, `overflow-detection`, `mural/compress-cues`, `dreamer/cron`, `historian-eval/contract`). The clusters below are the table-shaped ones found at Jaccard ≥ 0.55 with ≥ 5 members. LOC saved ≈ `(N−1)×L − N×2` (table row overhead).

| # | File | Tests | First:last line | Cur. LOC | Est. saved | Churn | Tier |
|---|---|---|---|---|---|---|---|
| P1 | `packages/e2e-tests/src/historian-eval/contract.test.ts` | 9 | `:950`–`:1117` | 111 | **~66** | **36** | T1 (hot file — collapse carefully) |
| P2 | `packages/plugin/src/hooks/magic-context/read-session-db.test.ts` | 6 | `:95`–`:343` | 96 | **~56** | 9 | T1 |
| P3 | `packages/plugin/src/shared/conflict-detector.test.ts` | 5 | `:194`–`:300` | 104 | **~54** | 8 | T1 |
| P4 | `packages/e2e-tests/scripts/prospective-holdout.test.ts` | 6 | `:505`–`:878` | 94 | **~54** | 9 | T1 |
| P5 | `packages/plugin/src/hooks/magic-context/compartment-runner-partial-recomp.test.ts` | 6 | `:102`–`:178` | 79 | **~49** | 2 | T1 |
| P6 | `packages/plugin/src/hooks/magic-context/compartment-runner-validation.test.ts` | 5 | `:91`–`:172` | 66 | **~38** | 9 | T1 |
| P7 | `packages/pi-plugin/src/strip-tag-prefix.test.ts` | 5 | `:19`–`:81` | 55 | **~33** | 4 | T1 |
| P8 | `packages/plugin/scripts/retrieval-benchmark/timing.test.ts` | 5 | `:148`–`:227` | 60 | **~32** | 1 | T1 |
| P9 | `packages/plugin/src/features/magic-context/scheduler.test.ts` | 5 | `:38`–`:138` | 56 | **~30** | 3 | T1 |
| P10 | `packages/plugin/src/features/magic-context/range-parser.test.ts` | 5 | `:13`–`:106` | 45 | **~25** | 2 | T1 |
| P11 | `packages/plugin/src/config/project-security.test.ts` | 5 (of 31 strip-shaped) | `:10`–`:70` | 48 | **~24** | 18 | T1 |
| P12 | `packages/plugin/src/features/magic-context/dreamer/cron.test.ts` | 5 | `:109`–`:133` | 30 | **~12** | — | T1 (file already uses `.each`) |
| | **Total** | **67** | | **844** | **~473** | | |

**Deliberately excluded** (clustered at ≥ 0.55 but are *distinct narratives*, not table rows — collapsing them would destroy readability and per-scenario failure messages):
- `packages/plugin/src/hooks/magic-context/transform-cache-busting-signals.test.ts:113`–`:392` (5 tests / 280 LOC) — "Test 1..4" are four different publish/flush interleavings.
- `packages/plugin/src/hooks/magic-context/rust-mode-transform.test.ts:2472`–`:2793` (5 / 186 LOC) — distinct raw-fallback refusal reasons.
- `packages/plugin/src/hooks/magic-context/transform-operations.test.ts:133`–`:281` (5 / 179 LOC) — thinking-block ownership branches.

P11 is the highest-leverage of the "safe" set beyond the table: `plugin/src/config/project-security.test.ts` has **~15** further `strips <field> from project config` tests of near-identical shape (`:10`, `:17`, `:28`, `:39`, `:70`, `:246`, `:260`, and the embedding/model-stripping family). A `(field, path, expectedWarningSubstring, siblingToPreserve)` table would collapse them to ~120 LOC total. Not counted in the estimate above because it is a bigger rewrite of a security-boundary file (18 commits of churn = actively maintained). Flag for a follow-up.

---

## 6. Dead test helpers

Verified by `rg -w <symbol>` across `packages/` + `scripts/` (all TS), then re-verified repo-wide including non-TS to catch doc/markdown references.

### T0-5 — `crashingDatabase` + `CrashInjection`: superseded, zero references
**File**: `packages/plugin/src/features/magic-context/synapse-detailed-test-support.ts:159-166` (`interface CrashInjection`) and `:174-215` (`export function crashingDatabase`) — **~52 LOC**, i.e. ~24% of the 215-LOC module.

**Evidence**: the only occurrences repo-wide are the declaration itself and the generated `packages/plugin/dist/features/magic-context/synapse-detailed-test-support.d.ts:53`. The module *is* live (imported by `compartment-chunk-embedding.test.ts:32`, `project-embedding-registry.test.ts:55`, `git-commits/indexer.test.ts:20`, `compartment-embedding.test.ts:19`, `shadow-backfill.test.ts:32`) — but for its other exports, never this one.

**Why it is dead rather than unadopted**: the crash tests chose a different, better mechanism. `packages/plugin/src/features/magic-context/context-authority-crash.test.ts:54` defines a custom error class (`super(\`injected crash ${cut}\`)`) and `:132` a `crash(cut: CrashCut)` helper driving **named cut points** (`"after-rust-stage"` `:171`, `"after-intent-ack"` `:211`, `"after-mirror-group-commit"` `:229`). `crashingDatabase` injects on a **SQL regex match** — a weaker, more brittle oracle that the codebase has moved past.
**Recommendation**: delete both the interface and the function. **Tier T0.**

### Over-exported but live (module-private in practice) — hygiene only, 0 net LOC
Each of these has references *only inside its own defining module*; the `export` keyword is unnecessary surface. Verified individually.

| Symbol | File:line | Internal uses |
|---|---|---|
| `makeQuery` | `packages/plugin/scripts/retrieval-benchmark/test-support.ts:58` | `:92` |
| `makeValidCorpus` | `…/test-support.ts:83` | `:184` |
| `makeValidJudgments` | `…/test-support.ts:107` | `:185` |
| `SYNAPSE_TEST_MODEL` | `packages/plugin/src/features/magic-context/synapse-detailed-test-support.ts:15` | `:21,:50,:72,:138` |
| `SYNAPSE_TEST_FINGERPRINT` | `…:16` | `:22,:51,:73,:139,:153` |
| `SYNAPSE_TEST_EPOCH` | `…:17` | `:52,:74,:140,:154` |
| `SYNAPSE_TEST_DIMS` | `…:18` | `:53,:75,:141,:155` |
| `FakeCandidateHost` | `packages/plugin/src/shared/mc-host-client/test-support/test-util.ts:167` | `:169,:259,:427,:434,:472` |
| `PEER_HEADER_LEN` | `…/test-support/fake-peer.ts:17` | `:63,:71,:214,:225,:234` |
| `encodePeerAuthMessage` | `…/test-support/fake-peer.ts:76` | `:328,:344` |

**Tier T0** (drop `export`). Note the four `SYNAPSE_TEST_*` constants are re-exported in a block at `…test-support.ts:21-22` — check that block before touching them.

### T0-6 — misnamed helper module loaded as a test file
**File**: `packages/pi-plugin/src/test-utils.test.ts` — **157 LOC, ZERO `test(`/`it(`/`describe(` calls** (verified). It is a pure helper module (`createTestDb:8`, `userMessage:13`, `assistantMessage:26`, `assistantToolCall:49`, `fakeContext`, `createFakePi`, `textOf`) that is imported by **31 sibling test files** via `from "./test-utils.test"` (e.g. `context-handler.test.ts:87`, `inject-compartments-pi.test.ts:39`, `tools/index.test.ts:13`, `dialogs/status-dialog.test.ts:13`).

**Impact**: `bun test` matches and loads it as a test file that contributes no tests; every consumer carries a `"./test-utils.test"` import specifier that reads like a mistake.
**Recommendation**: rename to `packages/pi-plugin/src/test-utils.ts` and update the 31 import specifiers. Mechanical, 0 net LOC. **Tier T0.**

Also: `packages/mc-shm-native/tests/suite.test.ts` (3 LOC) is a pure aggregator (`import "./capability.ts"; import "./mechanism.ts"; import "./runtime.ts";`). Intentional; **no action**.

---

## 7. TRACKED

Findings that intersect open beads. **None of these are proposed for deletion by this audit.**

| Bead | Interaction | Audit position |
|---|---|---|
| **TRACKED(magic-context-tzu)** | `packages/plugin/src/features/magic-context/dreamer/dream-task-token-telemetry.test.ts` (44 LOC, 5 commits) is a pure source-text-assertion suite (`expect(src.includes("recordChildInvocation")).toBe(true)` at `:24-26`, `:31-33`, `:39`). It would otherwise be my top over-specification candidate. | **Already a tracked decision.** `tzu` records the exact options (delete, or replace with a behavioral `getSubagentTotalsBySubagent` assertion). **Deferring entirely — no duplicate recommendation.** |
| **TRACKED(magic-context-shb)** | Wire-level historian-producer decode coverage must be **restored**, not reduced. | This audit proposes **no** reduction in historian-producer or decode-path coverage. CC-4 (wire helpers) *consolidates duplicated fixtures* in `module-transport.test.ts` / `client.test.ts` and **removes no assertions**. Any future pass that trims `packages/e2e-tests/tests/rust-historian-producer.test.ts`, `crates/mc-module/tests/broca_roundtrip.rs`, or `packages/e2e-tests/scripts/run-rust-historian-producer-mutation.ts` is **forbidden**. |
| **TRACKED(magic-context-1cy)** | Config-parity guard replacement pending; `1cy` names `packages/plugin/scripts/build-schema.test.ts:56` as the intended home for the `schema.properties.experimental === undefined` assertion. | `build-schema.test.ts:55-63` (`auto_update is present in the schema`) is explicitly **KEEP** in §1. My T0-2 finding is in a *different* file (`config/compaction-accessor-guard.test.ts`) and removes only the `typeof === "function"` line, leaving the accessor-exclusivity scan at `:59-72` intact. No overlap. |
| **TRACKED(magic-context-dmv)** | Shared PID start-time probe consolidation is tracked, covering `packages/e2e-tests/src/rust-runner/hermetic-mc-host.ts` ↔ `packages/plugin/src/shared/rpc-utils.ts`. | CC-8's `rust-*` `beforeEach` class sits in this neighborhood. **Marked NO ACTION** in CC-8 and deferred to `dmv`. |
| **TRACKED(magic-context-fds / lmp / wxf / 4t7 / dha / 5ts)** | Flaky/failing tests are tracked bugs. | **No test is proposed for deletion on grounds of flakiness anywhere in this report.** Specifically preserved: `packages/e2e-tests/tests/historian-success.test.ts`, `slow-historian.test.ts`, `emergency-blocking.test.ts` and their pi twins — these appear in CC-1 and CC-5 as *fixture* consolidation targets only. `4t7` (historian subprocess bypasses the mock provider on hosts with real credentials) is directly relevant to CC-1: the `isHistorianRequest` drift is plausibly *why* some copies need the `<new_messages>` fallback. **Land CC-1 only in coordination with `4t7`.** |
| **TRACKED(magic-context-mwx)** | Workspace Rust test coverage to CI is pending. | Rust in-crate `#[cfg(test)]` was **out of scope** and is **not** counted as deletable slack anywhere in this report. |
| **TRACKED(magic-context-kp5 / ymc)** | Outgoing-frame byte accounting owner in `wire.rs`; shared-memory IPC fast path. | CC-4 touches wire-framing test fixtures ⇒ tagged **T2 minimum** with an impact note. |

---

## 8. Do not delete yet

### DND-1 — `foldInfraEnabled` is a dead gate with a live, *misleading* skip message (COVERAGE GAP, not slack)
**File**: `packages/e2e-tests/src/rust-scenario-support.ts:32-34`

```ts
export function foldInfraEnabled(): boolean { return process.env.MC_RUST_E2E_FOLD === "1"; }
export const FOLD_SKIP_REASON =
    "requires broad Rust fold qualification beyond the focused direct " +
    "backend fixture; set MC_RUST_E2E_FOLD=1 to run it";   // :36-38
```

**Evidence**:
- `foldInfraEnabled` has **0 references** repo-wide outside its own declaration (verified against every multi-line import block from `rust-scenario-support`).
- `MC_RUST_E2E_FOLD` is read **only** inside that unused function (`:33`) and named in the skip string (`:38`). Nothing else in the repo reads it.
- `FOLD_SKIP_REASON` **is** live (9 refs) — but its two consumers gate on something else entirely: `packages/e2e-tests/tests/overflow-recovery.test.ts:235` and `packages/e2e-tests/tests/emergency-blocking.test.ts:162` both branch on `if (process.env.MC_E2E_MODE === "rust")` and then `return`, printing `FOLD_SKIP_REASON` on the way out.

**Consequence**: in rust mode those assertions are **unconditionally skipped**, and the message promises an opt-in (`set MC_RUST_E2E_FOLD=1 to run it`) that **cannot work** — the flag is never consulted. Additionally `packages/e2e-tests/parity-findings-s2.md:15` asserts "The Rust test now explicitly asserts `foldInfraEnabled() === false`", which is **false at HEAD**.

**Why not a T0 dead-helper delete**: deleting the function alone would leave the misleading opt-in text and the permanently-dark coverage in place. The decision is either (a) wire `foldInfraEnabled()` into the two gate sites so the documented opt-in actually runs the fold assertions, or (b) delete the function *and* the `set MC_RUST_E2E_FOLD=1 to run it` clause, and correct `parity-findings-s2.md:15`. **This is a coverage finding for the e2e owner, adjacent to TRACKED(magic-context-4t7).** Not counted in the deletable-LOC totals.

*(By contrast the sibling gate is correctly wired and must be left alone: `duplicateIdInfraEnabled` `:41` is consumed at `packages/e2e-tests/tests/rust-duplicate-tool-use-id.test.ts:53` and `:58`, with `DUPLICATE_ID_SKIP_REASON` at `:57` — that is what the fold pair should look like.)*

### DND-2 — the 10 empty `it.skip` bodies in `pi-cache-stability.test.ts`
**File**: `packages/e2e-tests/tests/pi-cache-stability.test.ts:853`, `:858`, `:862`, `:867`, `:872`, `:876`, `:880`, `:884`, `:888`, `:892` — all `it.skip("…", () => {})`.

These are **10 of the repo's 12 total** skip/todo markers, each preceded by a specific `FIXME(pi-cache-stability)` naming the exact harness limitation (pi `--print` exits before async historian drain; no hook to force pi native compact; no print-mode subagent command harness). They cost ~0 runtime and function as a documented coverage-gap ledger for the Pi harness.
**Position**: **keep**. Per the flaky/failing guard, an unmet-coverage marker is not deletable slack. If they should become beads instead of comments, that is an owner decision, not an audit deletion.

### DND-3 — the static source-text assertion family (14 files) — over-specified, but churn does not yet justify action
Test files that `readFileSync` production source and assert on its text:
`packages/plugin/src/index-refresh.test.ts` · `packages/plugin/src/plugin/dream-timer.test.ts` · `packages/plugin/src/tools/ctx-memory/tools.test.ts` · `packages/plugin/scripts/retrieval-benchmark/physical-locator.test.ts` · `packages/plugin/src/hooks/magic-context/recomp-orchestrator.test.ts` · `packages/pi-plugin/src/session-cleanup-wiring.test.ts` · `…/startup-rehydration-signals.test.ts` · `…/ctx-reduce-nudge-pi.test.ts` · `…/context-handler.test.ts` · `…/agent-end-handler.test.ts` · `…/historian-publish-signals.test.ts` · `…/tools/ctx-memory.test.ts` · `…/commands/ctx-flush-signals.test.ts` · `packages/cli/src/lib/logs-opencode.test.ts`

The rubric requires demonstrable churn before flagging over-specification. Measured churn: `dream-timer.test.ts` **13** commits (highest), `session-cleanup-wiring.test.ts` **3**, `compaction-accessor-guard.test.ts` **2**. That is **not** evidence of repeated fix-up churn.

`dream-timer.test.ts` is the weakest of the family — e.g. `:58-67` asserts a `try {` appears within 200 chars before `await startDreamScheduleTimer(` and a `catch` within 300 chars after; `:23-30` counts `if (!db) return;` occurrences against `openTimerDatabaseOrNull("` call sites. Both break on innocuous formatting. But the same file also contains three genuinely strong behavioral tests (`:159-213` proving startup passes serialize with `maxConcurrent === 1`, `:225-300` proving a queued-then-unregistered project is skipped, `:310-388` proving an interval tick yields to a draining wave). **Position: leave the family alone this pass; revisit if churn crosses ~20 commits.** Recorded here so the next audit has the baseline.

### DND-4 — the two "pure duplicate" pairs are consolidation, not deletion
`packages/pi-plugin/src/commands/ctx-recomp-signals.test.ts:31`/`:56` vs `…/ctx-session-upgrade-signals.test.ts:29`/`:39` (§3, D1/D2). Bodies are byte-identical after normalization, **but the command under test differs** (`ctx-recomp` vs `ctx-session-upgrade`). Deleting either copy drops real coverage of one command. Fold into a shared parameterized helper invoked once per command; do **not** delete a member.

---

## Appendix — reproduction

```bash
# corpus + exact-duplicate test bodies (7,088 tests, 597 files)
python3 /tmp/opencode/audit/dup.py

# within-file near-dup clusters (parameterization candidates)
python3 /tmp/opencode/audit/near2.py 0.55 5 within

# helper/hook clone classes (exact, then near-dup)
python3 /tmp/opencode/audit/helpers.py
python3 /tmp/opencode/audit/helpers3.py 0.62 3 6

# drift checks
rg -l 'CREATE TABLE (IF NOT EXISTS )?session_meta' packages -g '*.test.ts'
rg -l 'function isHistorianRequest' packages/e2e-tests/tests
rg -w foldInfraEnabled packages --type ts       # -> 0 refs outside declaration
rg -c '^\s*(?:it|test|describe)\(' packages/pi-plugin/src/test-utils.test.ts  # -> 0
```
