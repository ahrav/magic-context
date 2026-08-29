# DRY / code-reduction audit — `packages/plugin/src/hooks/`

Read-only audit. Verified against HEAD `9c1eb4d1`. No source files modified.

Scope: `packages/plugin/src/hooks/` — 218 `.ts` files, 103,925 LOC total, of which
**111 non-test files / 48,425 LOC** are in primary scope. `*.test.ts` (107 files,
55,500 LOC) is excluded from primary scope and used only as liveness evidence.

Method: normalized-token sliding-window clone detection (windows 8/12/16/20, both
intra- and cross-file), semantic search (`colgrep`), exported-symbol reference
counting across the whole repo (`packages/ crates/ scripts/ tests/ docs/`),
pure-forwarder detection, and `git log` co-change/age signals. Every finding below
was opened and read; none is a tool artifact.

---

## Summary

| Tier | Findings | Est. net LOC delta | Notes |
|---|---|---|---|
| **T0** — mechanical, no design judgment | 16 | **−137** + 1 file deleted | 12 dead exports, 2 exact-duplicate helpers, 1 orphan shim, 1 parameterized clone |
| **T1** — same-concept consolidation, <50 LOC, ≤5 call sites | 11 | **−200** | plus ~14 symbols to de-export (0 LOC) |
| **T2** — crosses a boundary / exported API / sensitive path | 6 | **−154** | all 6 touch IPC wire framing, SQLite transactions, or backpressure math |
| **T3** — own design pass | 2 | **−180 (est.)** | recomp/partial-recomp sibling; `compactionOff` mode plumbing |
| **Do not unify yet** | 5 | 0 | volatile / already-diverged / documented-as-distinct |
| **TRACKED (open bead)** | 2 | — | referenced, not re-proposed |
| **Comment violations** | ~35 sites | −0 (edits in place) | 20 internal ticket refs, 3 review refs, 7 temporal, 5 marginal signature restatements |

**Mechanically deletable without a design pass: ≈ 491 LOC (T0+T1+T2), 1.0 % of the
in-scope 48,425 LOC.** With T3 accepted, ≈ 670 LOC.

Honest framing: **this codebase is unusually low on duplication for its size.**
The `module-wire.ts` decode layer already has proper primitives (`wireRecord`,
`wireExactKeys`, `wireString`, `wireSafeInteger`); the token-estimation family is
deliberately three distinct quantities and documented as such; `auto-update-checker/`
has effectively zero internal duplication (index↔checker similarity ratio 0.05).
Most of the recoverable LOC is **dead exports and argument-forwarding boilerplate**,
not copy-paste logic. Doc-comment quality is high — the redundant-comment category
is nearly empty, and the real comment problem is ticket/temporal references, not
signature restatement.

---

## T0 — mechanical

### D1. `runRustModeTransform` — dead export, and a pure-forwarding wrapper
`rust-mode-transform.ts:2971-2978`

```ts
export async function runRustModeTransform(transform, sessionId, messages, output, sessionMeta) {
    await transform.run(sessionId, messages, output, sessionMeta);
}
```

Zero references anywhere in the repo. Every consumer of this module imports
`RustModeModuleClient` (type) or `createRustModeTransform`/`__rustModeTransformTest`
and calls `.run()` directly (`packages/plugin/src/index.ts:44`,
`plugin/rpc-handlers.ts:49`, `e2e-tests/src/rust-scenario-support.ts:20`,
`plugin/scripts/bench-lkg-capture.ts:13`). Both a zero-ref export **and** a 5-arg
pure forwarder — the accretive-design smell and the dead-code finding coincide.
**Net −8. Lane: text.**

### D2. `formatWireSlice` — dead export
`openai-compat-adjacency.ts:128-150`

23-line debug formatter. Zero references. `openai-compat-adjacency.test.ts:3-6`
imports only `assertOpenAiCompatAdjacency` and the `OpenAiCompatWireMessage` type;
the sole production consumer `lkg-replay.ts:11` imports only
`assertOpenAiCompatAdjacency`. **Net −23. Lane: text.**

### D3. `countMessagesSinceLastUser` — dead export
`transform-message-helpers.ts:71-78`. Zero references. **Net −8. Lane: text.**

### D4. `setRecompNote` — dead export
`recomp-orchestrator.ts:166-181` (incl. 3-line doc comment). Zero references;
the sibling `setRecompStarting`/`setRecompTerminal` are both live. **Net −16.**

### D5. `extractTiersFromInner` — dead export
`compartment-parser.ts:141-159`. Zero references. Its doc comment says it is
"Exposed for the v70 heal migration" — that migration no longer calls it; the
in-file `parseCompartmentOutput` (`:186-189`) inlines the same four
`extractTier(inner, N)` calls instead. **Net −19.**

### D6. `FlushedSessions` — dead deprecated type alias + temporal comment
`hook-handlers.ts:125-131`

```ts
/**
 * @deprecated ... Kept as a type alias only for any external consumers that may
 * still import it. Will be removed in a future major.
 */
export type FlushedSessions = Set<string>;
```

Exactly **1** repo-wide reference: its own declaration. There are no external
consumers. Also a comment violation ("Will be removed in a future major").
**Net −7.**

### D7. `clearHistorianAlertState` — dead export
`compartment-runner-incremental.ts:95-97`. Zero references. **Net −3.**

### D8. `resetHighPressureNoEligibleHead` — dead export, pure forwarder
`protected-tail-boundary.ts:996-998`

```ts
export function resetHighPressureNoEligibleHead(db, sessionId) {
    resetProtectedTailNoEligibleHead(db, sessionId);
}
```
Zero references. **Net −3.**

### D9. `renderMemoryBlock` — dead export, pure forwarder
`inject-compartments.ts:251-253` → `return renderMemoryBlockV2(memories) || null;`
Zero call sites. The only repo hit for the name is a *prose comment* in
`plugin/rpc-handlers.test.ts:192`. **Net −3.**

### D10. `getLkgSlotStatsForTest` and `__resetLkgSlotStoreForTest` — dead test helpers
`lkg-slot.ts:263-266` and `lkg-slot.ts:267`. `getLkgSlotStatsForTest` has zero
references (not even in tests). `__resetLkgSlotStoreForTest` is a zero-ref alias of
the live `resetLkgSlotsForTest` (which has 8 real call sites). **Net −6.**

### D11. `readRawSessionMessageIdOrdinals` — dead export
`read-session-chunk.ts:407-415`. One reference: its own declaration. Note its
siblings `readRawSessionMessagePage` (`:242`) and `getRawSessionMessageOrdinalCount`
(`:266`) are also single-ref *but load-bearing* — they are attached as properties at
`:276-277` (`readRawSessionMessages.readPage = ...`). This one is not attached.
**Net −9. Lane: text (verify no dynamic property attach added first).**

### D12. `resetDegradedReanchorState` / `clearDegradedRebuild` — exact duplicate pair
`inject-compartments.ts:167-170` and `inject-compartments.ts:178-181`

**Clone class.** Members: `inject-compartments.ts:167-170`, `:178-181`.
Common core — byte-identical two-statement body:
```ts
degradedRebuildCountBySession.delete(sessionId);
reAnchorLoggedBySession.delete(sessionId);
```
Differs: only the name and the `export` keyword. Call sites: 1 each
(`:129` and `:604`). Module spread: same file. Clone type: **exact**.
`resetDegradedReanchorState` has zero external references, so both call sites can
target one internal function. **Net −4 plus one export removed. Lane: text.**

### D13. Dead re-export shim
`compartment-runner-incremental.ts:7-17`

```ts
// Re-export the historian-state-file helpers so existing callers
// (compartment-runner-recomp.ts, compartment-runner.ts, tests) keep working
// unchanged. ...
export { cleanupHistorianStateFile, HISTORIAN_STATE_INLINE_THRESHOLD,
         maybeWriteHistorianStateFile } from "./historian-state-file";
```

Only **one** of the three re-exports is consumed through the shim
(`compartment-runner-recomp.ts:33` imports `cleanupHistorianStateFile`), and the
comment's claim about `compartment-runner.ts` and tests is false —
`historian-state-file.test.ts:9` imports from `./historian-state-file` directly.
Repoint `compartment-runner-recomp.ts:33` at `./historian-state-file` and the whole
block (comment + import + export) goes. **Net −8. Lane: text.**

### D14. `format-bytes.ts` — unnecessary 1-line re-export shim
`packages/plugin/src/hooks/magic-context/format-bytes.ts` (entire file):
```ts
export { formatBytes } from "../../shared/format-bytes";
```
Two consumers: `execute-status.ts:31` (could import `../../shared/format-bytes`) and
`packages/pi-plugin/src/dialogs/status-dialog.ts:27` via
`@magic-context/core/hooks/magic-context/format-bytes`. The cross-package alias is
*not* load-bearing — pi-plugin already imports `@magic-context/core/shared/...`
directly in 9+ places (`pi-plugin/src/index.ts`, `subagent-entry.ts`,
`heuristic-cleanup-pi.ts`, …). **Net: −1 file, 2 import rewrites. Lane: structural codemod.**

### C1. `strip-content.ts` — `text` vs `reasoning` parameterized clone
`strip-content.ts:196-213` and `strip-content.ts:214-233`

**Clone class.** Members: `strip-content.ts:197-212`, `:215-232`.
Common core (16 lines, identical):
```ts
hasContentPart = true;
const trimmed = part.text.trim();
if (trimmed.length === 0) continue;
if (!trimmed.includes("[dropped §")) { hasNonDroppedContent = true; break; }
const allSegmentsDropped = trimmed.split(/(?=\[dropped §)/)
    .filter((s) => s.trim().length > 0)
    .every((segment) => DROPPED_PLACEHOLDER_PATTERN.test(segment.trim()));
if (!allSegmentsDropped) { hasNonDroppedContent = true; break; }
continue;
```
Differs: the guard only — `partType === "text"` vs `partType === "reasoning"`.
The second block's comment is literally `// Reasoning parts: check similarly`.
Call sites: 2 (inline branches in one loop). Module spread: 1 file.
Clone type: **parameterized (exact modulo one string literal)**.
Priority signals: file age 2026-03-17 (oldest cohort, stable); 894 LOC file; 1274-line
test file pins behavior.
Fix: `if (partType === "text" || partType === "reasoning")`.
**Net −17. Lane: structural codemod.**

---

## T1 — same-concept consolidation

### C2. `event-handler.ts` — 4× "record the detected limit but do not arm recovery"
`event-handler.ts:326-341`, `:352-365`, `:459-471`, `:478-491`

**Clone class.** 4 members, all in one file.
Common core (12 lines):
```ts
if (typeof detection.reportedLimit === "number" && detection.reportedLimit > 0) {
    recordDetectedContextLimit(deps.db, <sid>, detection.reportedLimit,
                              <modelKey>, detection.reportedLimitProvenance);
}
sessionLog(<sid>, `overflow detected <where>: reportedLimit=${...} provenance=${...} pattern=${...} — recorded limit only<suffix>`);
```
Differs: `<modelKey>` is `undefined` in the `session.error` arm (`:330`, `:356`) and
`overflowModelKey` in the `message.updated` arm (`:464`, `:483`); the log suffix text.
The comments admit the copy: `:452-454` "see session.error path above", `:475-476`
"mirrors the session.error path above".
Call sites: 4. Module spread: 1 file, 2 event arms.
Clone type: **parameterized**.
Priority signals: `event-handler.ts` first commit 2026-03-17; 1285-line test file;
event-handler + event-resolvers co-change in 63 of the last 300 commits.
Fix: `recordLimitWithoutArming(deps, sessionId, detection, modelKey, whereLabel)`.
**Net −40. Lane: typed-semantic** (needs the `deps`/`errInfo` vs `info` shape unified).

### C3. `transform-compartment-phase.ts` — 2× byte-identical 19-arg forwarding block
`transform-compartment-phase.ts:319-338` and `:363-382`

**Clone class.** 2 members, byte-identical `startCompartmentAgent({...})` calls where
**every single field is `args.<same-name>`** — 19 pure forwards plus one literal
(`preserveInjectionCacheUntilConsumed: true`).
Call sites: 2. Module spread: 1 file. Clone type: **exact**.
This is textbook accretive design: the call site's parameter list *is* the enclosing
`args` object. A third variant exists at `transform.ts:1476-1500` sourcing from `deps`
(different shape, 2 extra fields — do not fold that one in).
Fix: one local `const startAgent = () => startCompartmentAgent({ ...forward(args), preserveInjectionCacheUntilConsumed: true })`,
or make `CompartmentRunnerDeps` structurally satisfiable from `args` so the whole
literal collapses to a spread.
**Net −20 (−36 if the spread route works). Lane: structural codemod.**

### C4. `event-resolvers.ts` — detected-overflow-limit prologue ×2
`event-resolvers.ts:62-80` (in `resolveContextLimit`) and `:113-132`
(in `resolveTrustedContextLimit`)

**Clone class.** Common core (16 lines):
```ts
const modelKey = resolveModelKey(providerID, modelID);
let detected: number | undefined;
let detectedLimitProvenance: "prompt_only" | "combined" | "unknown" = "unknown";
if (ctx?.db && ctx.sessionID) {
    try {
        const overflow = getOverflowState(ctx.db, ctx.sessionID, modelKey);
        if (overflow.detectedContextLimit > 0) {
            detected = overflow.detectedContextLimit;
            detectedLimitProvenance = overflow.detectedContextLimitProvenance;
        }
    } catch { /* best-effort */ }
}
```
Differs: only the swallow-comment wording ("Reading session meta is best-effort — fall
through to the catalog." vs "best-effort; ignore").
Call sites: 2 in one file. Clone type: **near-miss (identical code, different comment)**.
Fix: `readDetectedLimit(ctx, modelKey): { detected?, provenance }`.
**Net −16. Lane: structural codemod.**

### C5. Session-directory resolution — 3× identical, including the comment
`compartment-runner-incremental.ts:424-433`, `compartment-runner-recomp.ts:183-192`,
`compartment-runner-partial-recomp.ts:201-210`

**Clone class.** 3 members across 3 files in the same directory.
Common core (10 lines, byte-identical including the leading comment):
```ts
// Intentional: session.get failure is non-fatal — we fall back to deps.directory
const parentSessionResponse = await client.session.get({ path: { id: sessionId } }).catch(() => null);
const parentSession = normalizeSDKResponse(parentSessionResponse,
    null as { directory?: string } | null, { preferResponseOnMissingData: true });
const sessionDirectory = parentSession?.directory ?? directory;
```
Differs: nothing.
Call sites: 3. Module spread: 3 files, 1 directory.
Clone type: **exact**.
Priority signals: recomp↔partial-recomp co-change 17/20 commits (85 %);
`transform.ts:913-919` solves the same problem differently (cached-first,
`sessionDirectoryBySession`) — do **not** fold that fourth site in, it is a
deliberately different policy.
Fix: `resolveSessionDirectory(client, sessionId, fallback): Promise<string>` in the
runner-shared module. **Net −20. Lane: structural codemod.**

### C6. `inject-compartments.ts` — `if (claimLaneStable) injectionCache.set(populated)` ×3
`inject-compartments.ts:511-519`, `:584-592`, `:679-687`

**Clone class.** 3 members (a 4th at `:448-456` is the `kind: "empty"` variant — leave it).
Common core (9 lines, identical):
```ts
if (claimLaneStable) {
    injectionCache.set(sessionId, { db, kind: "populated", injection: result,
                                    claimSnapshotVector, renderedRevisionLocators });
}
```
Differs: nothing; the surrounding `result` literal differs.
Call sites: 3. Module spread: 1 file. Clone type: **exact**.
Fix: local `cachePopulated(result: PreparedCompartmentInjection)`.
**Net −14. Lane: structural codemod.**

### C7. `applyMarkersToState` vs inline marker assignment in `applyCachedRowToState`
`inject-compartments.ts:1915-1951` and `:2429-2460`

**Clone class.** 2 members. Measured overlap: **22 consecutive identical normalized
lines**, similarity ratio 0.727 over the two bodies.
Common core: the whole `markers → state.cachedM0*` assignment block
(`cachedM0ClaimFormatEpoch`, `cachedM0ClaimSnapshotVector` (with `canonicalSnapshotVector`),
`cachedM0RenderedRevisionLocators` (with sort+stringify), `…ProjectUserProfileVersion`,
`…MaxCompartmentSeq`, `…MaxMutationId`, `…ProjectDocsHash`, `…MaterializedAt`,
`…SessionFactsVersion`, `…UpgradeState` (via `encodeCachedM0UpgradeIdentity` with 4
args), `…SystemHash`, `…ModelKey`, `…ProjectIdentity`, `snapshotMarkers`).
**What differs — and this is load-bearing:** `applyMarkersToState:1948` sets
`state.cachedM0MuralHash = markers.muralHash ?? null`, whereas
`applyCachedRowToState:2436` sets it from `row.cached_m0_mural_hash ?? null`, and also
sets `cachedM0MuralDataUrl` from the row. Any unification must keep the row as the
mural source on the cached-row path.
Call sites: `applyMarkersToState` has 2 (`:2737`, `:2869`); the inline block has 1.
Module spread: 1 file. Clone type: **near-miss**.
Priority signals: `inject-compartments.ts` touched in 87 of the last 300 commits — the
highest-churn file in scope, which raises the drift cost of leaving this split.
Impact note: this block feeds `cachedRowMatchesState` (`:2410-2427`) CAS decisions
for the m[0]/m[1] injection cache. A wrong unification produces silent
double-materialization or a missed HARD cache bust — the exact class of bug the
comment at `:1941-1946` documents.
Fix: `applyCachedRowToState` calls
`applyMarkersToState(state, toBuffer(row.cached_m0_bytes), markers, toBuffer(row.cached_m1_bytes))`
then overrides the two mural fields from the row.
**Net −20. Lane: typed-semantic.**

### C8. Compaction-marker advance + stale-pending CAS clear ×3
`compartment-runner-recomp.ts:314-333`, `compartment-runner-recomp.ts:616-632`,
`compartment-runner-partial-recomp.ts:369-385`

**Clone class.** 3 members across 2 files.
Common core (14 lines):
```ts
if (<lastEnd> > 0) {
    const markerUpdated = updateCompactionMarkerAfterPublication(db, sessionId, <lastEnd>, deps.directory);
    // Only clear the stale pending blob when the boundary actually advanced —
    // preserve it for the deferred-drain retry on failure.
    if (markerUpdated) {
        const stalePending = getPendingCompactionMarkerState(db, sessionId);
        if (stalePending) clearPendingCompactionMarkerStateIf(db, sessionId, stalePending);
    }
}
```
Differs: the ordinal variable name (`lastCompartmentEnd` vs `lastEnd`) and the
surrounding rationale comment. The three rationale comments say the same thing three
ways ("recomp now owns the boundary" / "advance … on the full-completion path too" /
"partial recomp now owns the boundary up to lastEnd").
Call sites: 3. Module spread: 2 files. Clone type: **parameterized**.
Note the 4th `updateCompactionMarkerAfterPublication` call
(`compartment-runner-incremental.ts:747`) deliberately does **not** do the CAS clear —
that is the deferred-marker path. Do not fold it in.
Fix: `advanceCompactionMarkerAndClearStalePending(db, sessionId, ordinal, directory): boolean`
in `compaction-marker-manager.ts`.
**Net −24. Lane: structural codemod.** *(T1 by size; if the reviewer treats the
compaction marker as boundary/backpressure state, promote to T2.)*

### C9. `protected-tail-boundary.ts` — 9-field ctx passthrough ×3
`protected-tail-boundary.ts:423-431`, `:621-629`, `:842-850`

**Clone class.** 3 members. Common core — 9 consecutive `X: ctx.X` lines:
`usageSource, contextLimit, executeThresholdPercentage, triggerBudget,
priorBoundaryOrdinal, migrationFloorActive, emergencyTailScale,
providerShapeVersion, cacheNamespace`.
Differs: nothing in the shared span; the surrounding snapshot fields differ
(empty-session literal vs computed vs emergency-scaled).
Call sites: 3. Module spread: 1 file. Clone type: **exact**.
Priority signals: file is young (first commit 2026-06-08) and central to boundary
math — 844-line test file pins it.
Impact note: `ProtectedTailBoundarySnapshot` is the boundary contract consumed by
every runner; a spread helper must not silently widen or drop a field, so add an
exhaustiveness type test.
Fix: `boundaryCtxFields(ctx)` returning the 9-field slice, spread at all 3 sites.
**Net −13. Lane: typed-semantic.**

### C10. `readCurrentM0SnapshotMarkers` — 14-field argument forwarding ×2
`inject-compartments.ts:2008-2022` and `:2601-2615`

**Clone class.** 2 members, 14 lines each, all fields forwarded from `options`/local
`projectPath`/`projectDirectory`/`workspace`. Differs: the first passes
`nowMs: foldMaterializedAt`, the second omits `nowMs`.
Call sites: 2 (production). Clone type: **near-miss**.
Fix: `m0MarkerReadArgs(options, workspace, projectPath, projectDirectory, nowMs?)`.
**Net −12. Lane: structural codemod.**

### C11. `transform-message-helpers.ts` — "latest" vs "by-id" variant pairs
`transform-message-helpers.ts:36-51` / `:53-67` and `:87-107` / `:115-129`

**Clone class.** Two pairs, 4 members, one file.
Pair A: `appendReminderToLatestUserMessage` vs `appendReminderToUserMessageById` —
same reverse/forward scan + `isMeaningfulUserMessage` guard + `appendReminderToUserMessage`.
Pair B: `injectToolPartIntoLatestAssistant` vs `injectToolPartIntoAssistantById` —
same `isReplayableAssistantAnchor` + `hasToolPartWithCallId` idempotency + push.
Differs: iteration direction, the id predicate, and the return type
(`string | null` vs `boolean`).
Call sites: 4 total (`auto-search-runner.ts:48`, `transform-postprocess-phase.ts:117`,
`transform.ts:121`). Clone type: **structural**.
Honest assessment: the return-type divergence and the "by-id returns `false` when the
anchor left the window" semantics are real. A shared `findAnchor(messages, mode)` +
two thin wrappers is worth ~12 LOC; a full merge behind a mode flag would be
flag-plumbing and is not recommended.
**Net −12. Lane: typed-semantic.**

### O1. Over-exported internal-only symbols (de-export only, 0 LOC)
Exported but with **zero references outside the defining file** — narrowing these
removes them from the crate's public surface and lets the compiler/linter see them
as dead if they later lose their last caller. Verified individually:

| Symbol | Location | internal call sites |
|---|---|---|
| `resolveToolAvailability` | `ctx-reduce-availability.ts:167` | 2 |
| `clearToolAvailability` | `ctx-reduce-availability.ts:206` | 2 |
| `resolveToolAvailabilityFromMessages` | `ctx-reduce-availability.ts:130` | 2 |
| `hasLoggedCtxReducePermissionDeny` | `ctx-reduce-availability.ts:395` | 2 |
| `markCtxReducePermissionDenyLogged` | `ctx-reduce-availability.ts:399` | 2 |
| `isDroppedToolOutput` | `ctx-reduce-nudge.ts:47` | 1 |
| `findLkgAnchor` | `lkg-replay.ts:196` | 1 |
| `validateLkgSeamBoundary` | `lkg-replay.ts:435` | 2 |
| `canonicalOrdinalForMessageId` | `module-state-sync.ts:681` | 2 (+ test barrel) |
| `moduleWatermarksEqual` | `module-state-sync.ts:650` | 1 (+ test barrel) |
| `toFlatModuleWireBody` | `module-wire.ts:1066` | 1 (+ test barrel) |
| `clearAllNoteNudgeState` | `note-nudger.ts:272` | 1 |
| `recordNoteNudgeDeliveryTime` | `note-nudger.ts:44` | 1 |
| `resetNoteNudgeCooldownOnly` | `note-nudger.ts:294` | 1 |
| `extractCommitHashes` | `read-session-formatting.ts:134` | 1 |
| `clearSystemPromptHashSession` | `system-prompt-hash.ts:37` | 1 |
| `stripCompleteTagPairsGlobally` | `tag-content-primitives.ts:66` | 1 |
| `stripMalformedTagNotationGlobally` | `tag-content-primitives.ts:70` | 1 |
| `nonEmergencyPerRunCap` / `force80PerRunCap` / `force95PerRunCap` | `protected-tail-boundary.ts:206/213/217` | 1 each |

Several of these (`module-state-sync`, `module-wire`) are re-exported through a
`__…ForTest` barrel — check the barrel before narrowing. **Lane: text.**

---

## T2 — crosses a boundary / sensitive path

### C13. The module `method` string-literal union is declared 3 times
`module-state-sync.ts:2385-2402` (18 lines, 15 methods),
`module-transport.ts:683-727` (45 lines, 42 methods),
`module-transport.ts:892-903` (12 lines, 13 authority methods)

**Clone class.** 3 members across 2 files.
Common core: the wire method names. `ModuleStateSyncClient.call` declares a 15-method
subset; `ModuleTransport.call` declares the full 42-method superset; `authorityRequest`
re-declares the 13 `authority.*` + `mirror.pull` names a second time inside the same
file, and every one of those 13 already appears in the `call` union 200 lines above.
Differs: which subset. Clone type: **structural (subset relation, no shared type)**.
Call sites: 3 declarations. Module spread: 2 files.
**Sensitive: IPC/wire framing → T2 minimum.**
Impact note: today, adding a module method requires editing 1-3 unions with no
compiler link between them; a method present in `authorityRequest` but absent from
`call` (or vice versa) is silently unrepresentable rather than a type error. Extract
`type ModuleAuthorityMethod = …` and `type ModuleMethod = ModuleAuthorityMethod | …`,
then `ModuleStateSyncClient` takes `Extract<ModuleMethod, "state_sync" | …>` or a
named `ModuleStateSyncMethod` subset. No runtime change; the risk is purely that a
sloppy extraction *widens* a client's accepted method set. Add a type-level test
asserting the state-sync subset does not admit `authority.*`.
**Net −45. Lane: typed-semantic.**

### C14. Claim-mirror / claim-intent optional method declarations across 3 client interfaces
`module-state-sync.ts:2372-2381` (`ModuleStateSyncClient`),
`rust-mode-transform.ts:~211-241` (`RustModeModuleClient`), plus `ModuleTransport`

**Clone class.** The 5-line
`claimX?(args: { sessionId: string; projectRoot: string; request: XRequest }): Promise<XResponse>`
shape is repeated for `claimIntentStage`, `claimIntentInspect`, `claimIntentAck`,
`claimEffectsApply`, `claimMirrorReplace`, `claimMirrorApply` — and
`claimMirrorReplace`/`claimMirrorApply` are declared **byte-identically** in both
`ModuleStateSyncClient:2372-2381` and `RustModeModuleClient`.
The same 20-line `import type { Claim…Request/Response }` list is also duplicated
between `module-transport.ts:46-66` and `rust-mode-transform.ts:88-102`.
Clone type: **exact (interface members) + exact (import list)**.
**Sensitive: claims policy + IPC wire → T2 minimum.**
Impact note: adjacent to open bead **magic-context-0fm** (shared claims-replay
identity/envelope helper for ctx-memory host adapters) — this is the *client
interface* side, not the adapter side, so it is a distinct finding, but sequence it
after 0fm lands so the two extractions do not conflict.
Fix: `type ClaimRpc<Req, Res> = (args: { sessionId: string; projectRoot: string; request: Req }) => Promise<Res>;`
plus a single `ClaimCapableModuleClient` interface both clients extend.
**Net −30. Lane: typed-semantic.**

### C15. `BEGIN IMMEDIATE` / finally-ROLLBACK skeleton ×4
`compartment-runner-recomp.ts:94-139`, `compartment-runner-incremental.ts:637-724`,
`inject-compartments.ts:2101-2200`, `inject-compartments.ts:2471-2530`

**Clone class.** 4 members across 3 files.
Common core (9 lines):
```ts
db.exec("BEGIN IMMEDIATE");
let <done> = false;
try {
    … ; db.exec("COMMIT"); <done> = true;
} finally {
    if (!<done>) {
        try { db.exec("ROLLBACK"); }
        catch { /* Transaction may already be closed … */ }
    }
}
```
Differs: the sentinel name (`finished` / `published`), the early-return-with-explicit-
ROLLBACK arms inside the body (recomp has 2, incremental has 1, inject has 1), and
whether extra cleanup runs alongside the rollback (`rollbackDrainReservation()` in
incremental). Two identical swallow-comments ("Transaction may already be closed by
SQLite after an error.") plus two paraphrases exist; two more copies live outside
scope at `features/magic-context/compartment-storage.ts:414,626`.
Call sites: 4 in scope, 6 repo-wide. Clone type: **structural**.
**No existing helper** — `rg 'withTransaction|runInTransaction|immediateTransaction'`
returns nothing, and the 10 `db.transaction(() => …)` sites use bun:sqlite's own
wrapper (which is `BEGIN`, not `BEGIN IMMEDIATE`). So this is a real gap, not a
duplicate of something already present.
**Sensitive: SQLite transaction semantics → T2 minimum.**
Impact note: the early-return arms make a naive `withImmediateTransaction(db, fn)`
lossy — those arms must become a typed "abort" result, not a bare `return`. Getting
this wrong leaves a transaction open under a lease-loss path. Recommend a
`Result`-shaped callback (`{ commit: T } | { abort: R }`) rather than exceptions.
Also interacts with open bead **magic-context-80a** (`withPrivilegedWriter` capability
toggling in `shared/sqlite.ts`) — the two wrappers should be designed together, so
sequence after 80a.
**Net −24. Lane: typed-semantic.**

### C16. Per-run cap trio — parameterized clone in backpressure math
`protected-tail-boundary.ts:206-219`

**Clone class.** 3 members: `nonEmergencyPerRunCap:206-211`,
`force80PerRunCap:213-215`, `force95PerRunCap:217-219`.
Common core: `Math.min(MAX, Math.max(k * N, Math.min(Math.round(f * usable), abs)))`.
Differs: the 4-tuple only — `(NON_EMERGENCY_MAX_CAP, 2, 0.25, 100_000)`,
`(FORCE80_MAX_CAP, 3, 0.35, 150_000)`, `(FORCE95_MAX_CAP, 4, 0.5, 250_000)`.
Call sites: 1 each, all inside `selectPerRunCap:231-236`. Module spread: 1 file.
Clone type: **parameterized**.
**Sensitive: this is the per-run drain budget — backpressure logic → T2 minimum.**
Impact note: collapsing to a table (`{ threshold, max, mult, frac, abs }[]`) also
collapses `selectPerRunCap`'s threshold ladder, which is where a wrong ordering
silently shrinks the drain cap under emergency pressure. Only do this with the
`protected-tail-boundary.test.ts` (844 lines) cap cases extended to assert all three
tiers at their boundaries first. The de-export half (O1) is safe on its own.
**Net −10. Lane: typed-semantic. Prerequisite: boundary cap test coverage.**

### C17. `rust-mode-transform.ts` — 4× 9-field `state` forwarding to `resolveOrdinalsForModule`
`rust-mode-transform.ts:2131-2140`, `:2149-2160`, `:2488-2498`, `:2508-2518`

**Clone class.** 4 members, one file.
Common core (9 lines) — every field is a rename of a `state` property:
```ts
generation: state.moduleGeneration,
memoGeneration: state.idOrdinalMemoGeneration,
memo: state.idOrdinalMemo,
memoAnchor: state.ordinalMemoAnchor,
memoStoredCount: state.ordinalMemoStoredCount,
memoCanonicalCount: state.ordinalMemoCanonicalCount,
provisionalBase: state.ordinalContinuationBase ?? undefined,
```
Differs: only the first call (`:2131`) passes a caller-computed `provisionalBase`
instead of the state field.
Call sites: 4 production (+ 7 in tests). Clone type: **parameterized**.
**Accretive-design smell, not just duplication:** `resolveOrdinalsForModule`
(`module-wire.ts:870`) takes 9 loose parameters that are 8 renames of one object. Its
real dependency set today is "the session's ordinal memo state" — one argument.
**Sensitive: IPC wire framing (ordinal resolution feeds the transform wire) → T2.**
Impact note: changing the public signature of `resolveOrdinalsForModule` breaks 7 test
call sites and `module-state-sync.test.ts`; the rename map must be preserved exactly or
ordinals silently shift. Do the object-argument change and the call-site collapse in
one commit with the existing `module-wire.test.ts` ordinal reconciliation cases green.
Fix: `resolveOrdinalsForModule({ sessionId, messages, memo: ordinalMemoOf(state), provisionalBase? })`.
**Net −27. Lane: typed-semantic.**

### C18. `rust-mode-transform.ts` — 2× ~20-field `buildTransformBody` forwarding
`rust-mode-transform.ts:2332-2360` and `:2553-2578`

**Clone class.** 2 members, one file, ~20 forwarded fields each including a nested
4-line `usage: { ...passUsage(usage, contextLimit), final_wire_input_tokens, final_wire_trusted }`
and a 3-line `prevResponseCompletedAtMs` ternary, all identical.
Differs: `input`/`fullArrayFingerprint` (retry uses `retryEncodedInput` and
`pendingWireCache.fingerprint`) and the delta block (present only on the first).
Call sites: 2 production (+ 6 in tests). Clone type: **near-miss**.
**Sensitive: IPC wire body → T2.**
Fix: hoist the invariant 18 fields into a `const bodyBase = { … }` computed once, then
`buildTransformBody({ ...bodyBase, input, fullArrayFingerprint, delta })`.
**Net −18. Lane: structural codemod.**

---

## T3 — deserve their own design pass

### A1. `compartment-runner-recomp.ts` ⟷ `compartment-runner-partial-recomp.ts`
651 + 542 = 1,193 LOC. Measured similarity: **111 shared normalized lines**,
`difflib` ratio **0.417**. Largest contiguous shared runs: 17, 12, 10, 9, 9, 9, 7, 7, 6, 6.

Shared core (the historian-pass loop):
`readSessionChunk` → `validateChunkCoverage` → `buildReferenceBlocks` →
`buildCompartmentAgentPrompt({ memoryEnabled: false, extractionFree: true })` →
`sendIgnoredMessage("## Magic Recomp …")` → `runValidatedHistorianPass({…})` →
progress emit → staging append → the C8 marker block.

What differs: partial-recomp snaps the range to compartment boundaries
(`snapRangeToCompartments`), carries `priorCompartments`/`tailCompartments` through
staging unchanged, and merges instead of `DELETE FROM compartments`; full recomp
truncates and rebuilds from ordinal 1. The prompt/notification strings differ only in
`"## Magic Recomp"` vs `"## Magic Recomp — Partial"` and the tense of two comments
(`:376-380` vs `:406-410`).

**Priority signals — strongest in this audit:** the two files co-change in **17 of the
20** commits that touch `partial-recomp` (85 %). `partial-recomp` was created
2026-04-20, one month after `recomp` (2026-03-17), i.e. it started as a copy and has
been co-maintained by hand ever since. Every one of C5, C8, and the `deps`-destructure
clone lives in this pair.

Why T3, not T1: 58 % of the code genuinely differs, and the difference is a *range
model* (whole-session truncate-and-rebuild vs bounded splice-and-merge), not a flag.
A parameterized merge behind `range?: PartialRecompRange` would be exactly the
flag-plumbing this audit is meant to flag. The right shape is a shared
`runHistorianRebuildLoop(deps, plan)` where `plan` supplies chunk source, staging
strategy, and label — two implementations of one loop, not one function with a mode
bit. **Est. −120 LOC. Requires: a design pass, then the C5/C8 extractions land inside it.**

### A2. `compactionOff` — one binary mode encoded as 137 scattered guards
**137 non-test references repo-wide**; in scope: `transform-postprocess-phase.ts` 33,
`transform.ts` 28, `hook.ts` 5, `inject-compartments.ts` 4, `event-handler.ts` 4,
`transform-compartment-phase.ts` 3, `command-handler.ts` 3,
`rust-mode-transform.ts` 2, `channel2-cycle.ts` 2, `compaction-off-transition.ts` 2.

In `transform-postprocess-phase.ts` alone: `!compactionOff &&` appears at `:855`,
`:865`, `:981`, `:993`, `:1024`, `:1344`, `:1466`, `:1494`, `:1604`, `:1644`, `:1720`,
`:1811`, `:1870`, `:2052`, `:2091`, `:2121`, `:2199`; plus `(args.fullFeatureMode || compactionOff)`
at `:889` and `skipMergedReasoningStrip: compactionOff` / `skipTrailingWhitespaceStrip: compactionOff`
at `:2116-2117`.

This is the exact accretive-design pattern the repo's own AGENTS.md names: *"a growing
list of `if feature_disabled { return; }` guards encoding one binary mode with no
type-level distinction."* The flag is resolved **once** at boot
(`hook.ts:446: const compactionOff = !isCompactionEnabled(deps.config)`) and is
process-stable — `transform.ts:578` and `transform-postprocess-phase.ts:580` both
document it as "boot-resolved". A process-stable binary mode with ~20 negated guards
in one function is a candidate for two composed pipelines (or two strategy objects)
selected once at construction, not a boolean threaded through 10 files.

Why T3 and not actionable today: every guard sits on a mutating gate (materialization,
sentinel emptying, reasoning strip, tool reclaim, channel-2 nudge). Splitting the
pipeline is a real state-machine restructure across `transform.ts` +
`transform-postprocess-phase.ts` (4,944 LOC combined) with 3,670 + 3,263 lines of test.
The guards are also *individually* correct and documented (`:581-585` explains the
`||` vs `&&` asymmetry). **Est. −60 LOC and a large clarity gain, but the LOC is not
the point — do this for correctness legibility or not at all.** Interacts with the
public `issue #266` slice work; confirm with the owner before starting.

---

## TRACKED — do not remove, precursor to an open bead

### TR1. Two-step recomp confirmation state machine → **TRACKED(magic-context-2my)**
`command-handler.ts:40-50` (`RecompConfirmation`, `recompConfirmationBySession`) and
`:956-1041` (window check, argsKey compare, set/delete, two dialog bodies at
`:1009-1023` and `:1029-1041`).
The two dialog-render blocks are near-identical (differ only in the range suffix and
the confirm-command string), and the same window/argsKey/delete dance exists for claim
commands. **Do not remove or consolidate — this is exactly the code bead
magic-context-2my ("Extract a shared two-step confirmation helper for claim commands
and ctx-recomp") covers.** Reference the bead.

### TR2. Claim client-interface / envelope duplication → adjacent to **TRACKED(magic-context-0fm)**
See **C14**. The *adapter* side is bead magic-context-0fm ("Extract shared
claims-replay identity/envelope helper for ctx-memory host adapters"). C14 is the
*client interface declaration* side and is a genuinely separate surface, but must be
sequenced after 0fm. **Do not land C14 before 0fm.**

Also noted and **not** re-proposed, per the guard:
`magic-context-8ss` (`hasMemoryClaimsCompatSchema` forks — lives in
`features/magic-context/storage-memory.ts`, out of scope),
`magic-context-80a` (`withPrivilegedWriter` — prerequisite for C15),
`magic-context-8b6` (`wakePlaneStatus` cache window — only one hooks reference,
`hook.ts:1180`; the cache is in `features/`).

Additional bead-adjacency flags on findings above:
- **C13/C14/C17/C18** touch the module wire, which the `magic-context-pml` epic
  (Rust feature parity: ports of dreamer, embedding, tagger, message index) will
  extend. Do not freeze the method union while `pml.1`–`pml.7` are adding methods —
  extract the *type*, which makes those additions cheaper, but expect churn.
- **A1** (recomp/partial-recomp) overlaps `magic-context-pml.1`/`pml.2` (port dreamer
  scheduler + task bodies to Rust) only tangentially; the historian runners are not in
  the port list, so A1 is safe to design independently.
- **C16** (per-run cap) sits on protected-tail drain budget; no open bead found.

---

## Do not unify yet

1. **Three per-part token estimators.**
   `final-wire-token-estimate.ts:53-115` (`estimateMessageTokens`, switch over
   `text/reasoning/thinking/redacted_thinking/file/tool/tool-invocation/tool_use/tool_result`),
   `read-session-true-raw-tokens.ts:363-415` (`estimateNonToolPart`, same part kinds
   with a `TrueRawTokenBreakdown` accumulator), and
   `tag-messages.ts:290-330` (`getReasoningTokenCount`, `estimateInputTokenCount`,
   `estimateTextTagTokenCount`).
   Semantically similar, **deliberately different quantities** — `read-session-chunk.ts:54-56`
   states it outright: *"that store counts FULL content, this counts the TC-chunked
   form (tool outputs collapsed to one-line summaries), a deliberately different
   quantity."* One counts the final wire, one counts true-raw with a provenance
   breakdown and an LRU cache, one counts per-tag stored costs. Unifying would couple
   three independent budget models. **Semantic-candidate only. Leave split.**

2. **`buildClaim*WireBody` family** — `module-wire.ts:602-624`. Four 4-line functions
   identical modulo the method-name literal and generic parameter
   (`claim.intent.stage` / `.inspect` / `.ack` / `claim.effects.apply`). Collapsing to
   a generic factory saves ~12 LOC and *loses* four named, individually-typed entry
   points on a wire boundary. Low value, non-trivial risk. **Not worth it.**

3. **`ReferenceCompartment` vs `CandidateCompartment`** —
   `reference-retrieval.ts:32-42` vs `compartment-runner-types.ts:147-167`.
   Structurally overlapping, but `reference-retrieval.ts:25-30` documents exactly why:
   *"Both `Compartment` (stored rows) and `CandidateCompartment` (in-flight staging)
   are assignable — they differ only in null/undefined widening."* The narrow shape is
   an intentional structural-minimum contract. **Correct as-is.**

4. **`module-transport.ts` / `module-state-sync.ts` / `rust-mode-transform.ts` import
   lists** (20 duplicated `import type { Claim… }` lines). Volatile — all three files
   are the youngest in scope (2026-07-17 / 2026-07-22) and the `pml` epic is actively
   adding wire types. Barrel-ing them now guarantees churn. Revisit after `pml` lands.

5. **`transform.ts:913-919` session-directory resolution** — do **not** fold into C5.
   It is a cache-first policy (`sessionDirectoryBySession`, `sessionDirectoryResolvedFromHost`)
   with a different failure contract than the runners' plain fallback. Weakly coupled +
   on the transform hot path.

---

## Dead code list

Verified zero references across `packages/ crates/ scripts/ tests/ docs/` (excluding
`node_modules/`, `target/`, lockfiles). Each was also opened to confirm it is not
attached as a property, re-exported through a barrel, or referenced dynamically.

| Symbol | Location | LOC | Evidence |
|---|---|---|---|
| `runRustModeTransform` | `rust-mode-transform.ts:2971-2978` | 8 | consumers use `createRustModeTransform` / `.run()` directly |
| `formatWireSlice` | `openai-compat-adjacency.ts:128-150` | 23 | test imports only `assertOpenAiCompatAdjacency` |
| `extractTiersFromInner` | `compartment-parser.ts:141-159` | 19 | `parseCompartmentOutput:186-189` inlines the same 4 calls |
| `setRecompNote` | `recomp-orchestrator.ts:166-181` | 16 | siblings `setRecompStarting`/`setRecompTerminal` are live |
| `readRawSessionMessageIdOrdinals` | `read-session-chunk.ts:407-415` | 9 | siblings attached at `:276-277`; this one is not |
| `countMessagesSinceLastUser` | `transform-message-helpers.ts:71-78` | 8 | — |
| Historian-state-file re-export shim | `compartment-runner-incremental.ts:7-17` | 8 | only `cleanupHistorianStateFile` flows through; comment's claims are stale |
| `FlushedSessions` | `hook-handlers.ts:125-131` | 7 | 1 repo hit = its own declaration |
| `getLkgSlotStatsForTest` | `lkg-slot.ts:263-266` | 4 | zero refs even in tests |
| `resetDegradedReanchorState` (merge into `clearDegradedRebuild`) | `inject-compartments.ts:167-170` | 4 | byte-identical duplicate; 0 external refs |
| `clearHistorianAlertState` | `compartment-runner-incremental.ts:95-97` | 3 | — |
| `resetHighPressureNoEligibleHead` | `protected-tail-boundary.ts:996-998` | 3 | pure forwarder, 0 refs |
| `renderMemoryBlock` | `inject-compartments.ts:251-253` | 3 | only hit is prose in `rpc-handlers.test.ts:192` |
| `__resetLkgSlotStoreForTest` | `lkg-slot.ts:267` | 2 | zero-ref alias of the live `resetLkgSlotsForTest` |
| `format-bytes.ts` (whole file) | `hooks/magic-context/format-bytes.ts` | 1 + file | pi-plugin already imports `@magic-context/core/shared/*` directly (9+ sites) |

**Total: 118 LOC + 1 file.** No orphan files found — every non-test module in
`hooks/` is imported somewhere, including the small cross-harness seams
(`fold-execution-gate.ts`, `channel2-cycle.ts`, `execute-flush.ts`,
`raw-fallback-context-limit.ts`), which are load-bearing for `packages/pi-plugin`.

Stale feature-flag branches: none found. `compactionOff` (A2) is a *live* mode, not a
stale flag. No dead `cfg`-equivalent branches.

---

## Comment violations

Per the repo's own rule (AGENTS.md, "Code Comments"): comments must not carry ticket
IDs, PR numbers, review references, or temporal/roadmap phrasing.

### Ticket references (20 sites)
Internal issue numbers embedded in comments — these belong in the tracker or the PR
description, not the source:

| Ticket | Count | Sites |
|---|---|---|
| `issue #266` (compaction-off) | 11 | `event-handler.ts:84`, `hook.ts:197`, `hook.ts:443`, `transform-compartment-phase.ts:32`, `transform-compartment-phase.ts:178`, `transform-postprocess-phase.ts:580`, `transform-postprocess-phase.ts:881`, `transform.ts:578`, `transform.ts:863`, `compaction-off-transition.ts:2`, `inject-compartments.ts:880` |
| `issue #129` (auto-title gate) | 4 | `channel2-delivery.ts:213`, `send-session-notification.ts:162`, `inject-compartments.ts:733`, `inject-compartments.ts:2552` |
| `issue #135` (orphan tool wire) | 2 | `openai-compat-adjacency.ts:9`, `issue-135-wire-fixtures.ts:2` |
| `issue #50` | 1 | `compartment-runner-historian.ts:411` |
| `issue #241` | 1 | `execute-status.ts:36` |
| `issue #62` | 1 | `send-session-notification.ts:194` |
| `Issue #44` | 2 | `compartment-runner-types.ts:97`, `:104` (+ `transform.ts:1493`) |

Fix pattern: replace `// Compaction-off mode (issue #266), boot-resolved.` with the
mechanism — `// Boot-resolved and process-stable: native compaction owns the window,
so every MC mutating gate is disarmed.` The *why* survives; the tracker reference goes.

**Legitimate and should stay:** `strip-content.ts:766` (`vercel/ai#13583/#13972`) and
`channel2-delivery.ts:34` (`anomalyco/opencode#28202`) — upstream third-party bug
references are mechanism documentation, not project tracking.

`issue-135-wire-fixtures.ts` is a borderline case: the *filename* encodes a ticket.
The file is a real regression fixture with one live consumer
(`openai-compat-adjacency.test.ts:2`). Recommend renaming to
`orphan-tool-wire-fixtures.ts` and rewording the header to describe the shape
(`[dropped] assistant between tool_calls and tool result`) rather than the ticket.

### Review / conversation references (4 sites)
- `system-prompt-hash.ts:518` — `// See Oracle review 2026-04-26 Finding A1 for the bug this fixes.`
- `transform-postprocess-phase.ts:604` — `reason for the three-set split (see Oracle review 2026-04-26).`
- `transform.ts:534` — `See Oracle review 2026-04-26 for the three-set split rationale.`
- `hook-handlers.ts:64` — `re-firing the same flush signal across multiple turns (Oracle review, 2026-04-26).`

All four are unreachable to a reader without the review artifact. The three-set-split
rationale is *already written out* at `hook-handlers.ts:59-70`; the cross-references
should point there, and `system-prompt-hash.ts:518` should state the bug.

### Temporal / roadmap phrasing (7 sites)
- `hook-handlers.ts:129` — `Will be removed in a future major.` (on dead `FlushedSessions` — D6 deletes it)
- `command-handler.ts:947` — `Partial-range args fall through to the full-recomp dialog for now — TUI …`
- `compartment-runner-historian.ts:44` — `The user has explicitly requested keeping these dumps for now (see audit …)`
- `tokenizer-calibration.ts:43` — `new tokenizer not yet in ai-tokenizer's claude encoding` *(borderline — states a real external dependency state; acceptable if reworded to name the version)*
- `compartment-runner-incremental.ts:8-10` — `so existing callers … keep working unchanged. The implementation moved to …` (history narration; D13 deletes it)
- `hook.ts:1510` — `Dogfood 2026-05-30: previously the command path …`
- `compartment-runner-partial-recomp.ts:300` — `The + 1 off-by-one here previously created a gap …`

The last two narrate history. Rewrite in the present tense: state the invariant the
`+ 1` maintains, not the bug it used to have.

### Signature-restating comments (5 marginal sites)
The codebase is genuinely clean here — a scan of all 111 non-test files for doc
comments whose words are a subset of the function name produced only 21 candidates,
and 16 of those add real information (fallback behavior, case-sensitivity, threading
constraints). The five that add nothing recoverable-from-the-signature:

- `compaction-marker-manager.ts:480` — `/** Remove the compaction marker for a session (e.g. on session.deleted). */`
- `compaction-marker-manager.ts:642` — `/** Close the writable OpenCode DB connection used for marker injection. */`
- `emergency-drop.ts:46` — `/** Normalize a stored tool name for tier matching. */`
- `reference-retrieval.ts:74` — `/** Group seeds by importance band, preserving corpus order within each band. */`
- `reference-retrieval.ts:152` — `/** Render the cross-project calibration block. Empty string if no seeds. */`

Low priority; each is one line and two of them do carry a small non-obvious fact
("writable", "preserving corpus order"). **Recommend leaving these unless the file is
already being edited.**

---

## Execution ordering

1. **T0 dead code (D1–D14) + C1.** Independent, `rg`-verified, no design judgment.
   ≈ −137 LOC, 1 file. Lane: text (D14 is a 2-line codemod).
2. **T1 mechanical clones (C2–C6, C10).** Single-file or single-directory, all with
   existing test coverage. ≈ −122 LOC.
3. **T1 with type work (C7, C9, C11).** ≈ −45 LOC. C7 must preserve the mural-source
   divergence; C9 needs an exhaustiveness type test.
4. **O1 de-export sweep.** Zero LOC, shrinks the module surface, makes future dead
   code visible. Check the `__…ForTest` barrels first.
5. **C8** — pairs naturally with A1; land it standalone only if A1 is deferred.
6. **T2, gated on beads.** C15 after `magic-context-80a`. C14 after `magic-context-0fm`.
   C13/C17/C18 are safe now but will see churn while `magic-context-pml` adds wire
   methods — extract the types (which reduces `pml`'s cost) rather than freezing them.
   C16 needs boundary cap tests first.
7. **A1 design pass.** Highest-value single item in the audit (85 % co-change,
   ≈ −120 LOC, and it absorbs C5/C8). Own task.
8. **A2** — raise with the `issue #266` owner. Do it for legibility, not LOC.
