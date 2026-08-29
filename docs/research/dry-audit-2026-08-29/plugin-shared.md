# DRY / code-reduction audit — `packages/plugin/src/` (excluding `features/`, `hooks/`)

Verified against HEAD `9c1eb4d1` ("Merge pull request #85 from ahrav/remove-tauri-dashboard").
Read-only audit. No source files were modified.

Scope audited (non-test LOC): `shared/` 27,361 · `config/` 3,984 · `plugin/` 3,897 ·
`tui-compiled/` 4,068 · `tui/` 3,407 · `tools/` 2,906 · `agents/` 1,081 · `index.ts` ~1,000.
Total ≈ 47.7k LOC. `*.test.ts` excluded from the primary scope and cited only as liveness
evidence.

## Summary

| Tier | Findings | Est. net LOC delta |
|---|---|---|
| T0 (dead code, pure duplicates, redundant comments) | 9 | −62 |
| T1 (same-concept consolidation, barrel/flag collapse) | 7 | −155 |
| T2 (crosses package boundary / changes behavior / sensitive) | 3 | −83 |
| T3 (own design pass) | 0 | — |
| Do not unify yet | 4 | 0 |
| **Total** | **23** | **≈ −300** |

Honest headline: **this is a low-duplication codebase.** A normalized 8-line
window scan across all ~47.7k non-test LOC in scope produced only **6** cross-file
clone classes, and **three of those are deliberate, documented, drift-tested
duplications** (§ Do not unify yet). The real yield is not clone removal — it is
(a) one high-value *semantic* clone where four hand-rolled copies have silently
drifted from a hardened canonical helper, (b) a barrel re-exporting 77 symbols of
which 8 are consumed, and (c) a modest pile of genuinely-dead exports.

Of the ~300 LOC, ~62 is mechanical and risk-free (T0), ~155 is single-file
consolidation (T1), and ~83 needs a behavior decision (T2).

Two systemic observations that matter more than the LOC count:

1. **`getErrorMessage` exists and is losing.** `shared/error-message.ts:1-3`
   exports it; ~21 files import it; the inline body
   `error instanceof Error ? error.message : String(error)` is re-spelled
   **~190 times repo-wide** and **~28 times inside this scope**.
   `plugin/tool-registry.ts` both *imports* `getErrorMessage` (line 12) and
   re-spells it inline (line 99). Near-zero LOC delta, so it is ranked low here,
   but it is the single most-repeated expression in the tree.
2. **Over-export is the dominant hygiene defect, not duplication.** ~20 symbols
   in scope are `export`ed but referenced only inside their own module, and a
   further 77 are re-exported by a barrel nobody reads. Zero LOC delta for the
   visibility fixes, but they are what makes the dead-code signal noisy.

---

## T0 — dead code, pure duplicates, redundant comments

### T0-1 · `createSessionHooks` is a zero-reference near-exact clone of `createSessionHooksAsync`

**Clone class.**
- Member A: `packages/plugin/src/plugin/hooks/create-session-hooks.ts:36-72` (`createSessionHooks`, 37 LOC)
- Member B: `packages/plugin/src/plugin/hooks/create-session-hooks.ts:74-110` (`createSessionHooksAsync`, 37 LOC)

**Common core.** 35 of 37 lines are byte-identical: same args interface, same
`enabled !== true` early return, same `createTagger()` / `createScheduler({...})` /
`createCompactionHandler()` construction, same `buildMagicContextHookConfig`
call, same return shape.

**Differences.** Exactly two lines:

```
1c1
< export function createSessionHooks(args: {
---
> export async function createSessionHooksAsync(args: {
21c21
<     const hookResult = createMagicContextHook({
---
>     const hookResult = await createMagicContextHookAsync({
```

**Call sites.** `createSessionHooksAsync` → `packages/plugin/src/index.ts:51`
(sole production caller). `createSessionHooks` → **zero** references anywhere in
`packages/`, `crates/`, `scripts/`, `docs/`. The co-located test
(`create-session-hooks.test.ts:4`) imports only `buildMagicContextHookConfig`.

**Clone type.** Parameterized (sync/async twin). **Module spread.** 1 file.
**Priority signals.** Last touched `5a031ea3` ("mason: wire prompt surfaces");
the sync variant survived the async migration. Zero call sites is decisive.

**Est. net LOC delta.** −37. **Execution lane.** text (delete lines 36-72).

**Note.** Two other sync/async twins exist but are outside this scope and both
halves are live: `createMagicContextHook`/`Async`
(`hooks/magic-context/hook.ts`) and `openDatabase`/`Async`
(`features/magic-context/storage-db.ts`). Only the `plugin/` one is dead.

---

### T0-2 · `getLogFilePath` — dead pure-forwarding wrapper

`packages/plugin/src/shared/logger.ts:105-107`

```ts
export function getLogFilePath(): string {
    return getMagicContextLogPath();
}
```

Pure forward to `shared/data-path.ts:48`. Zero references repo-wide (the only
other textual hit is a prose fixture,
`packages/plugin/scripts/calibrate-tokenizer/fixture-system.txt`).

**Est. net LOC delta.** −4. **Lane.** text.

---

### T0-3 · `PROMPT_SURFACE_TOOL_IDS` — `@deprecated` alias with no consumers

`packages/plugin/src/shared/prompt-surface-runtime.ts:40-41`

```ts
/** @deprecated Use ACTIVE_TOOL_IDS. Kept as an alias for existing consumers. */
export const PROMPT_SURFACE_TOOL_IDS = ACTIVE_TOOL_IDS;
```

The comment's premise is false at HEAD. Every consumer already uses
`ACTIVE_TOOL_IDS` — `plugin/tool-registry.test.ts:19`,
`scripts/prompt-surface-measurement.ts:9`, `scripts/measure-agent-surface.ts:20`,
`scripts/prompt-surface-fixture.ts:14`, plus 3 internal uses in the defining
file. `PROMPT_SURFACE_TOOL_IDS` has zero references outside its own declaration.

**Est. net LOC delta.** −2. **Lane.** text.

---

### T0-4 · `getResolvedSynapseProviderIdentity` — dead export

`packages/plugin/src/plugin/embedding-routing.ts:150-155` (6 LOC). Zero
references repo-wide, including tests. Throws on a missing
`synapse_fingerprint`, so no dynamic/string dispatch is plausible.

**Est. net LOC delta.** −6. **Lane.** text.
**Guard check.** Adjacent to Synapse embedding work in `magic-context-3q5.*`
(U8/U9 claims-native retrieval, U25 embedding-space contract). It is a
*read-side identity accessor* for an already-resolved config, not a precursor:
`getSynapseLaneIdentity` (the thing it forwards to) is live and directly callable.
Treated as removable, but see T2-3's impact note about `plugin/` being a
cross-package surface.

---

### T0-5 · `_resetEmbeddingConfigFailureLogsForTests` — dead test seam

`packages/plugin/src/plugin/embedding-bootstrap-helpers.ts:214-216` (3 LOC).
Zero references — no test calls it. The `loggedFailureSignatures` map it clears
is module-global, so a future test would want it; but nothing wants it today.

**Est. net LOC delta.** −3. **Lane.** text.

---

### T0-6 · `clearWindowOverlayCacheForTest` — dead test seam

`packages/plugin/src/shared/window-geometry.ts:334-338` (5 LOC). Zero
references, including `window-geometry.test.ts` (which does import
`setWindowOverlayPath` from the same module, so the test file was checked and
does not use this one).

**Est. net LOC delta.** −5. **Lane.** text.

---

### T0-7 · `STRUCTURAL_SENTINEL_KIND` — dead export

`packages/plugin/src/shared/transcript.ts:261`. One reference: its own
declaration. Docstring says it exists so tests can build synthetic transcripts;
no test uses it.

**Est. net LOC delta.** −1 (plus its 3-line docstring, 259-260). **Lane.** text.

---

### T0-8 · Comment violation — history narration in `shared/commit-detection.ts`

`packages/plugin/src/shared/commit-detection.ts:7-9`

```
// These three previously each carried their own hash/verb regexes that had
// drifted (hash length 6 vs 7; verb sets {hash, sha} vs {merge, rebas}). Keeping
// them here stops that drift: change the patterns once and every site follows.
```

Also line 29-30: `"the bare nouns "hash"/"sha" that the historian's old hint
regex ..."`.

The *rule* ("single source of truth; change once and every site follows") is
present-tense and load-bearing — keep it. The narration of what the three sites
"previously" carried, and the specific pre-consolidation drift values, is
timeline tracking recoverable only from git history. Per the repo's own comment
policy (`AGENTS.md` → Code Comments: never "previously", never history
narration), lines 7-8 and the "old hint regex" clause should go; the
mechanism sentence stays.

**Est. net LOC delta.** −3. **Lane.** text.

---

### T0-9 · Over-exported internals (visibility only, 0 LOC)

~20 symbols in scope are `export`ed but referenced only inside their defining
module (verified: reference count across `packages/`+`crates/`+`scripts/`+`docs/`
excluding the defining file = 0; self-reference count ≥ 2). Dropping `export`
narrows the surface and makes future dead-code scans honest. Zero LOC delta.

| File | Symbols |
|---|---|
| `shared/sqlite.ts` | `readSqliteEngineIdentity` (399), `probeSqliteEngineIdentityOffPath` (411), `isVersionAtLeast` (427), `MIN_SUPPORTED_NODE_VERSION` (385), `MIN_SUPPORTED_BUN_VERSION` (388), `detectSqliteRuntime` (55) |
| `shared/window-geometry.ts` | `WINDOW_OVERLAY_SCHEMA` (8), `PROMPT_WALL_MARGIN` (9), `PI_OUTPUT_FLOOR` (10), `OPENCODE_OUTPUT_CAP` (11), `defaultWindowOverlayPath` (293), `formatCompactTokens` (618) |
| `shared/rpc-utils.ts` | `projectHash` (33) |
| `shared/data-path.ts` | `getMagicContextTempDir` (35) |
| `shared/conflict-detector.ts` | `OMO_PACKAGE_NAMES` |
| `shared/prompt-surface.ts` | `resolveModelConfigValue` |
| `shared/model-suggestion-retry.ts` | `parseModelSuggestion` |
| `plugin/embedding-bootstrap-helpers.ts` | `EMBEDDING_AFFECTING_KEYS` (30), `EMBEDDING_AFFECTING_TOP_LEVEL_KEYS` (69), `describeFailure` (135), `logConfigFailureOnce` (157) |

**Sensitive subset — T2 minimum, do not batch with the rest:** the `sqlite.ts`
entries. `MIN_SUPPORTED_*` and `isVersionAtLeast` feed
`evaluateSqliteRuntimeGate`, and `withPrivilegedWriter` in the same file is the
subject of open bead **magic-context-80a**. Leave `sqlite.ts` visibility alone
until 80a lands — it will re-shape this file's exports anyway.

---

## T1 — same-concept consolidation

### T1-1 · `mc-host-lifecycle/index.ts` re-exports 85 symbols; 8 are consumed

`packages/plugin/src/shared/mc-host-lifecycle/index.ts` (94 LOC, 77 of them
single-symbol re-export lines).

**Consumed set — the complete union across all production importers:**

| Importer | Symbols taken from the barrel |
|---|---|
| `hooks/magic-context/module-transport.ts:30-35` | `ConnectionOrigin`, `createManagedLifecyclePolicy`, `NativeStartupEnvelope`, `resolveConnectionOrigin`, `StorageReadiness` |
| `features/magic-context/memory/embedding-synapse.ts:6-13` | `ConnectionOrigin`, `defaultConnectionFilePath`, `OUTER_AGGREGATE_MS`, `resolveConnectionOrigin`, `STORAGE_HARD_BUDGET_MS`, `StorageReadiness` |
| `plugin/embedding-routing.ts:13` | `ConnectionOrigin` |

Union = **8 symbols**. Every co-located test imports from the *leaf* module
directly (`./compatibility`, `./paths`, `./bootstrap`, `./contract`), never the
barrel. No cross-package consumer exists: `packages/cli` and
`packages/pi-plugin` deep-import `@magic-context/core/shared/{sqlite,data-path,
conflict-detector,jsonc-parser,redaction,harness,...}` but never
`shared/mc-host-lifecycle`.

**Evidence the barrel is not a maintained contract:** `module-transport.ts`
imports `defaultConnectionFilePath` from the leaf
(`../../shared/mc-host-lifecycle/paths:37`) while `embedding-synapse.ts:8`
imports the *same symbol* from the barrel. Two importers, two paths, one symbol.

**Never-consumed anywhere (not even leaf-imported by a test), i.e. dead through
the barrel AND over-exported at the leaf:** `availableBytesFor`
(`bootstrap.ts`), `isDaemonReason` (`contract.ts`).

**Clone type.** Structural (re-export surface vs actual demand).
**Priority signals.** Young file — created `fe4be9af` (U3 lifecycle policy),
touched by `b2b493ce` (U4), `be359a75` (review findings). It grew by accretion:
each new leaf module appended its whole export list. Actively churning, so the
gap widens every commit.

**Est. net LOC delta.** −70 (keep 8 symbols + braces).
**Lane.** typed-semantic (let `tsc --noEmit` + the existing suites prove nothing
was reachable only via the barrel).
**Impact note.** Technically changes an exported surface, but `package.json`
`exports` (lines 88-97) declares only `"."` and `"./tui"` — no `./shared/*`
subpath — so Node's exports map already blocks external deep imports. This is an
internal-only API. Ranked T1 on that basis.

---

### T1-2 · Four hand-rolled copies of the session-prompt sender in one file

**Clone class.** All four in `packages/plugin/src/plugin/conflict-warning-hook.ts`:

| Member | Lines | LOC | Enclosing function |
|---|---|---|---|
| A | 220-252 | 33 | `sendConflictWarning` (197) |
| B | 326-349 | 24 | `cleanupConflictWarnings` (260) |
| C | 455-473 | 19 | `sendSchemaFenceWarning` (427) |
| D | 539-568 | 30 | `sendStartupAnnouncement` (485) |

**Common core (~20 lines, present in all four).** Cast `client` to the
duck-typed shape `{ session?: { prompt?, promptAsync? } }`; build
`{ path: { id: sessionId }, body: { noReply: true, parts: [{ type: "text",
text, ignored: true }] } }`; call `session.prompt` if callable, else
`session.promptAsync`, else give up; wrap in `try/catch`.

**Differences.** Only the failure tail and text-literal formatting:
A logs `"conflict-warning: session prompt API unavailable"` + logs the catch;
B is silent (`catch { /* Best-effort */ }`); C `return`s from the catch;
D logs `"announcement: ..."` + `return`s. A spells the text part across 6 lines,
B/C/D inline it on one.

**Call sites / module spread.** 4 sites, 1 file, 4 different exported functions.

**Clone type.** Near-miss (identical core, divergent error tails).

**Est. net LOC delta.** −60 (one ~22-LOC `postIgnoredSessionText(client,
sessionId, text): Promise<"sent" | "unavailable" | "failed">` helper + four
2-3 line call sites). **Lane.** structural.

**This is also T2-3's evidence.** A canonical hardened implementation of exactly
this concept already exists — see **T2-3**. The T1 framing above is the
conservative option (pure local refactor, no behavior change); T2-3 is the
correct-but-behavior-changing option. Pick one; do not do both.

---

### T1-3 · `LoadOutcome` declared twice — drift hazard on the untrusted-config gate

**Clone class (exact, 7 lines each).**
- `packages/plugin/src/config/index.ts:76-83`
- `packages/plugin/src/plugin/embedding-bootstrap-helpers.ts:12-18`

```ts
export type LoadOutcome =
    | "ok"
    | "project-file-parse-error"
    | "project-file-io-error"
    | "legacy-config-unmigrated"
    | "schema-recovery"
    | "substitution-failure";
```

The two enclosing interfaces (`LoadResultDetailed` at `config/index.ts:85-100`,
`EmbeddingLoadResultDetailed<T>` at `embedding-bootstrap-helpers.ts:20-28`) then
share six identical fields (`loadOutcome`, `sources.userConfig`,
`sources.projectConfig`, `substitutionFailures`, `recoveredTopLevelKeys`, plus
`config`). The generic wrapper is *justified* — `pi-plugin`'s
`loadPiConfigDetailed` result must satisfy the same shape — but the union itself
being written twice is not.

**Why this is more than cosmetic.** `isConfigLoadUntrusted`
(`embedding-bootstrap-helpers.ts:98`) switches on three specific
`LoadOutcome` members. Add a seventh outcome in `config/index.ts` without
mirroring it here and the gate silently classifies it as trusted — which the
file's own comments (lines 52-57, 126-129) say lets a bogus provider identity
register and "let GC reap the real model's vectors."

**Call sites.** `config/index.ts` internal + `LoadResultDetailed` consumers;
`embedding-bootstrap-helpers.ts` internal +
`plugin/embedding-bootstrap.ts:10` + `pi-plugin/src/embedding-bootstrap.ts:14-16`.

**Clone type.** Exact. **Module spread.** 2 dirs, 1 package (but the type
crosses into `pi-plugin` via the generic).

**Est. net LOC delta.** −8. **Lane.** typed-semantic.
**Shape note.** Do *not* have `embedding-bootstrap-helpers.ts` import from
`../config` (the 641-LOC loader index) — that drags the whole config loader into
`pi-plugin`'s import graph. Move `LoadOutcome` to a leaf
(`config/load-outcome.ts` or `config/schema/magic-context.ts`, which
`embedding-bootstrap-helpers.ts:3` already imports) and have both sides read it
from there.

---

### T1-4 · Legacy-config path table spelled three times in one file

`packages/plugin/src/config/migrate-config-location.ts`. The same five
legacy config bases are enumerated in three places:

| Base | `userScopeConfigPaths()` | `resolveLegacyConfigSources()` | `resolveLegacyConfigSourcesForHarness()` |
|---|---|---|---|
| `<configHome>/opencode/magic-context` | 125-126 | 154 | 203 |
| `~/.pi/agent/magic-context` | 127-128 | 158 | 192 |
| `<dir>/magic-context` | — | 163 | 207 |
| `<dir>/.opencode/magic-context` | — | 165 | 209 |
| `<dir>/.pi/magic-context` | — | 168 | 196 |

Spellings 2 and 3 go through the `legacySourcesForBase(base, label)` helper
(106-112) and duplicate the label strings too (`"OpenCode user"`, `"Pi user"`,
`"project root"`, `"OpenCode project"`, `"Pi project"` each appear twice).
Spelling 1 bypasses the helper and re-derives `.jsonc`/`.json` by hand.

**Why this is more than cosmetic.** The docstring at 172-186 explains that
`userScopeConfigPaths()` is the guard that stops a project-scope migration from
eating the user's own config ("the config-eats-itself bug"). It is a *filter*
built from a hand-maintained second copy of the user-scope half of the table.
Add a user-scope legacy base to `resolveLegacyConfigSources` and forget
`userScopeConfigPaths`, and the guard silently stops covering it.

**Fix shape.** One `LEGACY_BASES: ReadonlyArray<{ scope: "user"|"project";
harness: ConhoseHarness|"any"; base(dir): string; label: string }>` table;
derive all three consumers from it (`userScopeConfigPaths` becomes a
`filter(scope==="user").flatMap(bothExtensions)`).

**Clone type.** Structural. **Module spread.** 1 file, 3 functions.
**Priority signals.** Covered by `config/migrate-config-location.test.ts`.

**Est. net LOC delta.** −15. **Lane.** structural.
**Impact note.** This code moves and renames user config files. Any change must
keep `migrate-config-location.test.ts` green *and* preserve the exact
`userScopeConfigPaths` membership set — a regression here silently relocates a
user's config and drops them to schema defaults.

---

### T1-5 · `getErrorMessage` is re-spelled inline ~28 times in scope

`shared/error-message.ts:1-3` exports `getErrorMessage`. The inline body is
re-spelled at (non-test, in-scope):

`shared/rpc-utils.ts:450` · `shared/logger.ts:25` · `shared/sqlite.ts:97`
(`?? ""` variant) · `shared/prompt-surface-runtime.ts:154` ·
`shared/models-dev-cache.ts:474` · `shared/tui-config.ts:135` ·
`shared/token-estimator.ts:145` · `shared/mc-host-client/client.ts:343` ·
`config/index.ts:118,156` · `config/variable.ts:177` ·
`config/migrate-config-location.ts:477,587,630` ·
`plugin/messages-transform.ts:180,235` ·
`plugin/dream-timer.ts:696,764,777` ·
`plugin/conflict-warning-hook.ts:97,143,186,251,565` ·
`plugin/tool-registry.ts:99` · `tools/ctx-note/tools.ts:317,374` ·
`tui/index.tsx:648` · `tui/data/context-db.ts:282`.

**Sharpest evidence:** `plugin/tool-registry.ts` imports `getErrorMessage` at
line 12, uses it at line 112, and re-spells it inline at line 99 — same
function, 13 lines apart.

**Clone type.** Exact (single expression). **Module spread.** 5 dirs.
**Est. net LOC delta.** ~0 (one-for-one line swap; ~28 import-line additions
partly offset by shorter expressions).

**Ranked low deliberately.** This is a readability/DRY win with no code-size
payoff, and it is a 28-file diff. Worth doing as a lint rule
(`no-restricted-syntax` on the ternary shape) rather than a one-off sweep.
**Excluded sites:** `tui/entry.mjs:8` is plain JS outside the TS graph, and
`tui-compiled/**` is generated (see § Do not unify yet).

---

### T1-6 · `resolveEmbeddingRouting` is `async` but never awaits

`packages/plugin/src/plugin/embedding-routing.ts:108` is declared
`export async function` and its body contains **zero** `await` expressions
(verified: `rg -n 'await' embedding-routing.ts` → no matches).

The needless `Promise` propagates: `plugin/embedding-bootstrap.ts:28` must
`await` it, which forces `ensureProjectRegisteredFromOpenCodeDirectory`
(`:13`) to be `async`, which forces every one of its 8 call sites to handle a
promise. `hooks/magic-context/hook.ts:682-687` documents the resulting hazard in
prose:

```
// ensureProjectRegisteredFromOpenCodeDirectory is `async` but does
// its config load + stale-embedding wipe SYNCHRONOUSLY (no internal
// await), so awaiting it as the first statement would run that work
// on the transform's return path. A macrotask yield lets the
// transform return first, keeping the hot path clean.
```

That comment is a workaround for an `async` keyword that buys nothing.

**Category.** Over-abstraction / accretive design (async plumbing).
**Call sites.** 2 direct (`plugin/embedding-bootstrap.ts:28`,
`pi-plugin/src/embedding-bootstrap.ts:86`), 8 transitive.
**Est. net LOC delta.** ~−5, but the value is removing the `setTimeout(0)`
workaround, not the lines.
**Lane.** typed-semantic.
**Impact note — T2 in practice.** `pi-plugin` imports it across the package
boundary, and it is genuinely *possible* a future Synapse lane needs to probe
the daemon here (the docstring at 100-106 says lanes are "deferred (no daemon
probe here)" — i.e. the async signature may be reserved on purpose). Confirm
that intent before de-async-ing. If the reservation is real, delete the
`hook.ts` workaround comment's premise instead and leave the signature alone.

---

### T1-7 · Duplicated `LoadOutcome`-adjacent block also duplicated at `config/index.ts:89-96` ↔ `embedding-bootstrap-helpers.ts:22-29`

Covered by T1-3 (same clone class, detected independently by the block scanner).
Listed here only so the scanner output maps 1:1 to a finding.

---

## T2 — crosses a boundary, changes behavior, or touches a sensitive path

### T2-1 · `ensureProjectRegisteredFromOpenCodeDirectory` ↔ `ensureProjectRegisteredFromPiDirectory`

**Clone class.**
- Member A: `packages/plugin/src/plugin/embedding-bootstrap.ts:13-40` (28 LOC) — *in scope*
- Member B: `packages/pi-plugin/src/embedding-bootstrap.ts:58-110` (53 LOC) — out of scope, cited as the other clone member

**Common core (identical control flow, both members).**
`load*ConfigDetailed(directory)` → `resolveProjectIdentityForSession(directory,
config.allow_home_project)` → bail if no identity → `if
(isConfigLoadUntrusted(detailed)) { handleUntrustedLoad(db, identity,
directory, detailed); return; }` → `await resolveEmbeddingRouting({config})` →
`for (const warning of routing.warnings) log(...)` → build
`EmbeddingFeatures { memoryEnabled, gitCommitEnabled }` →
`registerProjectEmbedding(db, identity, routing.primary, features, directory)`
→ `if (routing.shadow) registerProjectShadowEmbedding(...)`.

**Differences.**
1. Config loader: `loadPluginConfigDetailed` vs `loadPiConfigDetailed`.
2. Log prefix: `[magic-context]` vs `[magic-context][pi]`.
3. **Member B adds a stat-based memoization layer that Member A lacks**
   (`registrationFingerprintsByDatabase` WeakMap, `configCandidatePaths`,
   `configFingerprint`; pi lines 21-56 + 65-73 + 100-109).
4. Member B orders `features` before `routing`; A orders `routing` before
   `features`. No behavioral effect.

**This is the finding, not the LOC.** Both members solve the same
"this runs on a hot path and does synchronous config+DB work" problem, and they
solve it *differently*: Pi memoizes on config-file `stat`; OpenCode instead
relies on a caller-side `await new Promise(r => setTimeout(r, 0))` macrotask
yield (`hooks/magic-context/hook.ts:687`). Two divergent fixes for one problem
is exactly the drift DRY exists to prevent — and the OpenCode side re-does the
full config load on every trigger.

**Call sites.** A: `index.ts:336`, `hooks/magic-context/hook.ts:492,548,689,
1273,1312`, `plugin/tool-registry.ts:111,151,157`. B: pi-plugin internal.

**Clone type.** Near-miss / semantic-candidate.
**Module spread.** 2 packages (`plugin`, `pi-plugin`).

**Priority signals — strong.** The two files share **5 commits**:
`71caf023`, `4cc072f2`, `ad1e540a`, `7b96265c`, `bc58cd52`. Textbook
change-coupling / shotgun surgery: five separate times, both copies had to be
edited together.

**Est. net LOC delta.** −25 (extract
`registerProjectEmbeddingFromDetailed(db, directory, detailed, logPrefix)` into
`plugin/embedding-bootstrap.ts`; both wrappers keep only their loader + prefix +
Pi's memoization).
**Lane.** structural.
**Impact note.** `plugin/embedding-bootstrap-helpers` and
`plugin/embedding-routing` are already `pi-plugin` import targets
(`pi-plugin/src/embedding-bootstrap.ts:14-17`), so the shared-helper direction
is established and no new coupling is created. But this touches embedding
*identity registration* — a wrong `EmbeddingFeatures` or `routing.primary`
lets stale-identity GC delete real vectors (see the `handleUntrustedLoad`
docstring). Land it with the pi-plugin embedding tests, and decide explicitly
whether OpenCode adopts Pi's memoization (recommended) or Pi drops it.

---

### T2-2 · `stripJsoncForParse` re-implements `shared/jsonc-parser.ts`

**Clone class.**
- Member A: `packages/plugin/src/shared/jsonc-parser.ts:3-63` `stripJsonComments`
  (61 LOC) + `:65-~130` `stripTrailingCommas` (private)
- Member B: `packages/plugin/src/config/migrate-config-location.ts:222-279`
  `stripJsoncForParse` (58 LOC) — comment-strip pass *and* trailing-comma pass
  in one function

**Common core.** Both are character-scanning state machines with the same four
states (in-string / escaped / line-comment / block-comment), both then run a
second string-aware pass that drops a `,` whose next non-whitespace char is
`}` or `]`.

**Differences (immaterial at the sole call site).** Member B emits `"\n"` for a
line comment and `" "` for a block comment; Member A preserves the newline and
drops block comments entirely. Member B's only consumer is
`normalizedJsoncSemantics` (`:291-293`), which does
`JSON.stringify(sortJson(JSON.parse(strip(content))))` — whitespace-insensitive
by construction. Member A's public `stripJsonComments` is therefore a drop-in.

**Call sites.** A: `config/variable.ts` (via `stripJsonComments`),
`shared/conflict-detector.ts` + 10 others (via `readJsoncFile`), and
`packages/cli/src/lib/jsonc-config.ts`, `packages/cli/src/commands/doctor-pi.ts`
across the package boundary. B: `migrate-config-location.ts:292` only.

**Clone type.** Semantic-candidate (independent re-implementations; the header
comment at 214-219 says "ported from AFT", confirming B was written from the
same source rather than derived from A).
**Module spread.** 2 dirs.

**Est. net LOC delta.** −58.
**Lane.** typed-semantic (behavior must be pinned by test before the swap).
**Impact note — sensitive.** `normalizedJsoncSemantics` is the comparator behind
the migration's *refuse-and-warn* gate (214-219: "A legacy source that
semantically MATCHES an existing target is moved aside (target wins); one that
DIFFERS triggers refuse-and-warn (never auto-clobber)"). A normalizer that
becomes *more* permissive turns a real conflict into a silent
move-aside → the user loses config. Land only with a differential test that
runs both implementations over the `migrate-config-location.test.ts` corpus and
asserts identical `normalizedJsoncSemantics` output before deleting Member B.

---

### T2-3 · Four hand-rolled senders bypass the hardened `sendIgnoredMessage`, and have drifted from it

This is the **highest-value finding in the audit** and the correct resolution of
T1-2.

**Canonical implementation.**
`packages/plugin/src/hooks/magic-context/send-session-notification.ts:245-274`
`sendIgnoredMessage(client, sessionId, text, params, forcePersist)` — 365-LOC
module, the project's single answer to "post an ignored status line into a
session."

**Its consumers (7 production sites):**
`hooks/magic-context/hook.ts:134`, `event-handler.ts:61`,
`child-session-spawn.ts:10`, `compartment-runner-recomp.ts:47`,
`compartment-runner-partial-recomp.ts:38`,
`transform-compartment-phase.ts:26`, plus dynamic imports from
`plugin/rpc-handlers.ts:1019,1049` and `index.ts:147`.

**Its non-consumers:** the four blocks in
`plugin/conflict-warning-hook.ts` (220-252, 326-349, 455-473, 539-568).

**The four copies are missing three behaviors the canonical helper provides:**

1. **TUI toast path.** `sendIgnoredMessage:246` tries
   `trySendTuiToast` first (`:47-80`) and only persists a user row on
   failure. All four copies unconditionally persist.
2. **Mid-turn gate + bounded queue.** The canonical path checks
   `midTurnDetector(sessionId)` at four separate yield windows
   (`:251, :151, :169, :217`) and queues instead of appending, because
   (`:250-252`) "OpenCode's `MessageV2.latest` is role-based and treats an
   ignored-only user row as the latest user turn." None of the four copies check
   mid-turn at all.
3. **Prompt-context pinning.** `sendIgnoredMessageNow:180-211` resolves and
   pins `agent` / `model` / `variant`, with this rationale (`:180-190`):
   "even though this is `noReply: true` … OpenCode's createUserMessage RECORDS
   prompt context on the appended user message, and THAT becomes the session's
   active model/agent for the NEXT real turn. Passing nothing makes OpenCode
   record the DEFAULT agent/model — which then switches the model on the user's
   next turn and busts the provider prefix cache the prior turn warmed."
   **All four copies pass no `agent`/`model`/`variant`.**

   Per that comment, each of the four hand-rolled posts can silently switch the
   user's model and bust prefix caching on their next turn. That is a latent
   behavior bug in each copy, not merely duplication.

The one guard the copies *do* have is the title-safety check — all four call
`waitForSafeNotificationTarget` (lines 212, 324, 437, 520), matching
`sendIgnoredMessageNow:163`.

**Direct corroboration that this is one concept with two implementations:**
schema-fence warning delivery exists twice —
`plugin/conflict-warning-hook.ts:427 sendSchemaFenceWarning` (hand-rolled) and
`hooks/magic-context/child-session-spawn.ts:68` (canonical
`sendIgnoredMessage(..., forcePersist=true)` after two `pushNotification`
calls). Same notice class, two delivery paths.

**Clone type.** Semantic (divergent-behavior clone).
**Module spread.** 2 dirs, `plugin/` ↔ `hooks/`.
**Priority signals.** `plugin/ → hooks/magic-context/send-session-notification`
is an *already-accepted* dependency direction — `plugin/rpc-handlers.ts:1019,
1049` dynamically imports that exact module. So no new architectural coupling.

**Est. net LOC delta.** −80 in `conflict-warning-hook.ts` (four blocks → four
`await sendIgnoredMessage(client, sessionId, text, {})` calls; the local
`waitForSafeNotificationTarget` guards become redundant too, since the canonical
path performs it).
**Lane.** structural + typed-semantic.

**Impact note — must be answered before landing.**
`sendIgnoredMessage` pulls in `isMidTurn` from `hooks/magic-context/read-session-db`,
which reads OpenCode's session DB. `sendConflictWarning` /
`sendStartupAnnouncement` run at plugin boot / session start
(`index.ts:46,416,476`), potentially before that DB is readable. Verify
`isMidTurn`'s behavior on an unreadable DB (fail-open to "not mid-turn"?) before
routing boot-time warnings through it. If it cannot fail open safely, fall back
to **T1-2** (extract a local helper, no behavior change) and file the
model-pinning divergence as a separate bug.

---

## TRACKED — do not remove, precursor to an open bead

Nothing in this scope was found to be *blocked* by an open bead, but the
following are adjacent enough that removal should defer:

| Item | Location | Bead | Reason |
|---|---|---|---|
| `sqlite.ts` export visibility (`MIN_SUPPORTED_*`, `isVersionAtLeast`, `readSqliteEngineIdentity`, `probeSqliteEngineIdentityOffPath`, `detectSqliteRuntime`) | `shared/sqlite.ts:55,385,388,399,411,427` | **magic-context-80a** | 80a inverts claims-capability toggling out of `withPrivilegedWriter` in this same file and will re-shape its export set. Do not touch visibility here first. |
| `shared/tui-preferences.ts`, `tui/data/notification-socket.ts`, `plugin/sidebar-snapshot-cache.ts`, `shared/window-geometry.ts` overlay reader | various | **magic-context-mpy**, **magic-context-rnq** | Dashboard-removal follow-ups are still open. These are TUI/sidebar surfaces, not dashboard-only, and all have live consumers (verified below) — but they sit in the blast radius of the mpy/rnq cleanup. Let those land first. |
| `shared/rpc-notifications.ts` / `rpc-server.ts` / `rpc-client.ts` / `rpc-types.ts` | `shared/rpc-*.ts` | **magic-context-ymc** | ymc replaces the loopback-TCP hot path with shared-memory IPC. Any consolidation of the RPC family will be rewritten by it. |
| `mc-host-client/transport-provider.ts` send-outcome blocks | `551-580`, `707-757` | **magic-context-kp5** | kp5 ("give outgoing-frame byte accounting one owner in wire.rs") is the Rust-side counterpart; the TS `not_sent` / `outcome_unknown` split should move with it. |
| `shared/mc-host-lifecycle/compatibility.ts` (`evaluate*Compatibility`, `parseSemverTriple`) | `compatibility.ts` | **magic-context-c50**, **magic-context-q4i** | c50 replaces the private subc daemon with the hand-rolled Rust module host; q4i concerns mid-session compatibility events from held-open v85 writers. The compatibility evaluators are barrel-dead (T1-1) but leaf-live via tests — shrink the *barrel*, keep the leaf. |

**Already-tracked consolidations — referenced, not re-proposed:**
`magic-context-8ss` (nine `hasMemoryClaimsCompatSchema` forks in
`storage-memory.ts` — `features/`, out of scope),
`magic-context-80a`, `magic-context-2my`, `magic-context-0fm`,
`magic-context-tzu`, `magic-context-mpy`, `magic-context-rnq`.

---

## Do not unify yet

### DNU-1 · `tui-compiled/` is generated output with a CI drift gate — correct as-is

4,068 LOC of checked-in generated code. Not a finding to fix; documenting the
evidence so no later pass mistakes it for duplication.

- **Generator:** `packages/plugin/scripts/build-tui.ts:9`
  (`const outputRoot = join(pluginRoot, "src/tui-compiled")`), source
  `src/tui`.
- **Drift gate:** `packages/plugin/package.json:40`
  `"check:tui-compiled"` re-runs the build into a temp dir and `diff -ru`s it
  against the checked-in tree, exiting non-zero on any difference.
- **Why checked in:** `package.json:28` ships `src/tui-compiled` in `files`,
  and `exports["./tui"]` (93-96) points at `src/tui/entry.mjs`, which
  `import`s `../tui-compiled/index.tsx` (`tui/entry.mjs:29`). The OpenTUI host
  cannot run the Solid transform, so the transform must happen at publish time.
- **Byte-identical file pairs (5 of 7):** `data/notification-socket.ts`,
  `data/context-db.ts`, `types/opencode-plugin-tui.d.ts`, `badge-contrast.ts`,
  `compaction-off.ts` — `diff -q` reports no difference. The build copies
  non-JSX files verbatim by design.
- **Transformed pairs (2 of 7):** `index.tsx` (1,151 → 1,614 LOC, 2,694 diff
  lines) and `slots/sidebar-content.tsx` (1,070 → 1,268 LOC, 2,298 diff lines)
  — Solid JSX compiled with runtime-specifier rewriting.
- **The one place the split is deliberately avoided:**
  `shared/tui-runtime-specifiers.ts:12-15` explains that the specifier list
  lives in `shared/` rather than `tui/` precisely *because* `build-tui.ts`
  copies everything under `src/tui/`, and this list is build tooling the runtime
  bundle must not carry. Single source of truth already established.

**Verdict.** Keep. Anything mechanically derived from `src/tui` is out of DRY
scope by construction, and the gate makes drift a build failure.

### DNU-2 · `PeerFrameType` in `test-support/fake-peer.ts` — intentional independent oracle

`shared/mc-host-client/test-support/fake-peer.ts:20-33` duplicates the 12
`FrameType` byte values from `shared/mc-host-client/protocol.ts:26-40`. The
comment at `fake-peer.ts:20` states the intent:

```ts
/** Frame type bytes duplicated from the wire doc, not from protocol.ts. */
```

A test double that imported the constants from the code under test could not
detect a wrong constant. This is a deliberate second oracle. `PEER_HEADER_LEN`
(`:17`) and `PEER_PROTOCOL_VERSION` (`:18`) serve the same role.

**Verdict.** Do not unify — ever. Sensitive (wire framing).

### DNU-3 · Inline agent allow-lists in `agents/hidden-agent-registrations.ts`

`agents/hidden-agent-registrations.ts:141-151` inlines the 9-element tool array
that `agents/dreamer.ts:45-56` exports as `DREAMER_DOCS_ALLOWED_TOOLS`; same
pattern for `DREAMER_CURATE_ALLOWED_TOOLS` (`:116`) and
`DREAMER_MEMORY_MAPPER_ALLOWED_TOOLS`. Byte identity is enforced by
`src/agent-registration-drift.test.ts:212,222,239`.

The stated reason (`hidden-agent-registrations.ts:40-56`) is honest about being
insurance: *"Belt-and-suspenders, not the load-bearing fix… Inlining the small
id/tool/step values additionally removes any dependency on cross-module
top-level `const` init timing."*

**Assessment.** The stated rationale is weak — `dist/index.js` is a single
`bun build --splitting` bundle, so `agents/dreamer.ts` and
`agents/hidden-agent-registrations.ts` end up in one module graph with
bundler-hoisted initialization; a top-level `const` array of string literals in
a sibling module has no plausible ordering hazard. Replacing each inline literal
with `[...DREAMER_*_ALLOWED_TOOLS]` would remove ~30 LOC and one test block.

**Verdict.** Do not unify yet. This is the plugin's boot path, and the module
header (5-23) documents that a prior mistake in this exact file *"fails the
WHOLE plugin load."* The payoff (~30 LOC) does not justify re-coupling a boot
path against an author who explicitly chose the redundancy. Revisit only with a
bundle-output inspection proving the hoisting claim.

### DNU-4 · `transport-provider.ts` send-outcome classification trio

`shared/mc-host-client/transport-provider.ts:551-560 / 561-570 / 571-580`
(the `send` path) and `707-718 / 719-731 / 735-757` (the `reserve` path) repeat
the same block: catch from `channel.produce`, narrow to
`BOUNDED_CHANNEL_CODES`, then `throw new McHostCallError("not_sent", …)` if
`!published` else `closeUpstream(...)` + `throw new
McHostCallError("outcome_unknown", …)`.

**Verdict.** Do not unify yet. Sensitive (IPC framing + replay safety). The
`not_sent` vs `outcome_unknown` distinction is documented in
`mc-host-client/errors.ts:29-38` as the load-bearing rule for whether a retry is
legal; each copy is deliberately explicit about its own `published` closure
state. ~30 LOC is not worth blurring that. Also tracked: **magic-context-kp5**.

---

## Dead code (consolidated)

Every entry verified with `rg -w <name>` across `packages/`, `crates/`,
`scripts/`, `docs/` (test files included in the search, i.e. tests do not
rescue any of these).

| Symbol | Location | LOC | Tier |
|---|---|---|---|
| `createSessionHooks` | `plugin/hooks/create-session-hooks.ts:36-72` | 37 | T0-1 |
| `getResolvedSynapseProviderIdentity` | `plugin/embedding-routing.ts:150-155` | 6 | T0-4 |
| `clearWindowOverlayCacheForTest` | `shared/window-geometry.ts:334-338` | 5 | T0-6 |
| `getLogFilePath` | `shared/logger.ts:105-107` | 4 | T0-2 |
| `_resetEmbeddingConfigFailureLogsForTests` | `plugin/embedding-bootstrap-helpers.ts:214-216` | 3 | T0-5 |
| `PROMPT_SURFACE_TOOL_IDS` | `shared/prompt-surface-runtime.ts:40-41` | 2 | T0-3 |
| `STRUCTURAL_SENTINEL_KIND` (+ docstring) | `shared/transcript.ts:259-261` | 3 | T0-7 |
| `availableBytesFor` (barrel + leaf, no test) | `mc-host-lifecycle/bootstrap.ts`, `index.ts:37` | — | T1-1 |
| `isDaemonReason` (barrel + leaf, no test) | `mc-host-lifecycle/contract.ts`, `index.ts:49` | — | T1-1 |
| 77 unconsumed barrel re-export lines | `mc-host-lifecycle/index.ts` | 70 | T1-1 |

**Dashboard-removal leftovers — searched, none found.** After
`a37f2187..2bae8911` (dashboard removal) and HEAD `9c1eb4d1` (merge of
`remove-tauri-dashboard`), a case-insensitive `tauri|dashboard` sweep across the
whole scope returns only prose: three prompt/description strings
(`agents/magic-context-prompt.ts:65,89,111`,
`tools/ctx-note/constants.ts:3`) using "dashboard" as example *content*, and
four explanatory comments (`tools/ctx-search/tools.ts:174`,
`plugin/messages-transform.ts:67`, `shared/keep-subagents.ts:9`,
`shared/harness.ts:9`). No dashboard-only code paths, exports, or helpers
remain in this scope. `plugin/conflict-warning-hook.ts` is *Desktop* (Electron)
mode, not the removed Tauri dashboard — see its header at lines 2-7 — and is
live from `index.ts:46,416,476`.

**Exported types with zero importers — deliberately NOT reported as dead.** ~60
exported `interface`/`type` declarations (e.g. `FixConflictsOptions`,
`ErrorDescription`, `ConnectionStats`, `PromptRetryOptions`) have no external
reference because callers pass object literals and read inferred return types.
That is normal TypeScript API design, not dead code. Reporting them would be
noise.

---

## Comment violations

| Location | Issue |
|---|---|
| `shared/commit-detection.ts:7-8` | History narration: *"These three **previously** each carried their own hash/verb regexes that had drifted (hash length 6 vs 7; verb sets {hash, sha} vs {merge, rebas})."* Keep the present-tense mechanism sentence at line 9; delete the narration. |
| `shared/commit-detection.ts:29-30` | *"…the bare nouns "hash"/"sha" that the historian's **old** hint regex…"* — references a removed implementation. |
| `shared/prompt-surface-runtime.ts:40` | *"Kept as an alias for existing consumers."* The premise is false at HEAD — there are none. Comment and symbol both go (T0-3). |
| `tui/index.tsx:834` | *"works without depending on the (now-deprecated) `api.command`"* — "now-" is temporal framing about an upstream API. Low priority; borderline, since it explains a live compatibility choice. |
| `tui/index.tsx:1043` | *"a deprecated shim that translates to `api.keymap.registerLayer`"* — same borderline class; describes present upstream state, acceptable. |

Overall comment hygiene in this scope is **good**. A targeted sweep for
`for now` / `currently` / `not yet` / `TODO` / `FIXME` / `per review` /
`this CR` / task IDs found **zero** tracking-ID or roadmap comments in any
non-test file. The `not yet` / `previously` hits that do exist are almost all
legitimate present-tense state descriptions (`"RPC server is not yet up"`,
`"Live ReceiveLeases … not yet released"`), not timeline tracking.

---

## Method notes / limits

- Dead-export detection: per-symbol `rg -w` across `packages/ crates/ scripts/
  docs/` excluding the defining file, then a self-reference count to separate
  *dead everywhere* from *over-exported* (used internally only). Both classes
  reported separately.
- Clone detection: normalized (whitespace-collapsed, comment-stripped) 8-line
  sliding-window hashing for cross-file classes, 10-line for intra-file, over
  all non-test `.ts`/`.tsx` in scope. `jscpd` is not installed in this
  workspace.
- Cross-package liveness confirmed for `shared/`: `packages/cli` and
  `packages/pi-plugin` deep-import `shared/{sqlite,data-path,conflict-detector,
  conflict-fixer,jsonc-parser,jsonc-edit,harness,harness-provider-map,redaction,
  rpc-utils,tui-config,window-geometry,opencode-config-dir,models-dev-cache}`.
  `shared/mc-host-lifecycle` has no cross-package consumer.
- **Known blind spots.** Dynamic `import()` with a computed specifier, and
  symbols reached only through a string key, would evade the `rg`-based sweep.
  Spot-checked the dynamic-import sites in `index.ts:147` and
  `plugin/rpc-handlers.ts:1019,1049` — all use literal specifiers. Symbols
  reachable from `crates/` via a wire/route name were not modeled; none of the
  reported dead symbols look route-shaped.
- Not audited (owned by other agents): `features/`, `hooks/`, `*.test.ts`.
  `pi-plugin` files are cited only as the second member of a clone class whose
  first member is in scope.
