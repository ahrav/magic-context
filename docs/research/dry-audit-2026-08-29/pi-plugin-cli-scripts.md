# DRY / code-reduction audit — pi-plugin, cli, scripts, retina-local-fs, mc-shm-native, docs

Verified against `HEAD = 9c1eb4d1301c455903c367fbd33a5920430cfbdb`. Read-only audit; no
source files were modified.

Scope LOC (non-test TypeScript unless noted): `packages/pi-plugin` 30.6k (58.4k with
tests), `packages/cli` 15.1k (23.8k with tests), `scripts/` 13.6k (incl. 4.6k of tests),
`packages/retina-local-fs` 0.9k, `packages/mc-shm-native` 1.1k TS + Rust,
`packages/docs` prose.

## Summary

| Tier | Findings | Est. net LOC delta |
|---|---|---|
| T0 — comments, dead code, verbatim-inlinable | 9 | −85 |
| T1 — same-concept, single package, small | 6 | −215 |
| T2 — crosses package boundary / exported API / sensitive path | 11 | −355 |
| T3 — needs its own design pass | 1 | −45 |
| **Total** | **27** | **≈ −700** |

Of that, **≈ −420 LOC is backed by clones verified byte-identical modulo whitespace, or
identical modulo a single type-alias name**. The remainder is structural/near-miss and
carries estimation error. Two findings are **TRACKED** (do not remove) and four bodies of
code are classified **do not unify yet**.

Method: no `jscpd` in the toolchain, so clone classes were established by (a) a
cross-package same-name function index (476 pi-plugin functions × 3598 plugin functions →
52 colliding names), (b) whitespace-normalized function-body extraction and
`difflib` similarity per candidate pair, (c) sliding 8–10-line normalized-window duplicate
detection inside the large files, and (d) `git log --name-only` co-change over the last
1500 commits. Every `IDENTICAL=True` claim below was re-run against HEAD at the end of
the audit.

## Headline: the plugin ↔ pi-plugin shared surface

**The good news first.** `packages/pi-plugin` is not a fork. It already consumes
`packages/plugin` as a library through the `@magic-context/core/*` tsconfig path
(`packages/pi-plugin/tsconfig.json:24-26` → `../plugin/src/*`) and imports **155 distinct
core module paths** across 30 non-test files (`context-handler.ts` alone imports 39).
Storage, claims, search, config schema, memory render, dreamer task config, mural, and
redaction are all shared, not copied. The `*-pi.ts` files are host-shape adapters over
shared cores — e.g. `inject-compartments-pi.ts:1-26` documents that it projects Pi
messages into a MessageLike view *so the shared `prepareCompartmentInjection` can run*.

**The problem is the seam.** Along that seam, small helpers get re-typed instead of
imported, and the copies have already drifted. 52 function names are defined on both
sides; 8 of those pairs are byte-identical and 5 more are identical except for a
type-alias name or a comment.

### Lockstep-maintenance signal (co-change)

78 of the last 500 commits touching either package touch **both** (15%). Per file pair:

| plugin file | pi-plugin file | commits A | commits B | **both** | lockstep rate on B |
|---|---|---|---|---|---|
| `hooks/magic-context/auto-search-runner.ts` | `auto-search-pi.ts` | 20 | 12 | **11** | **92%** |
| `hooks/magic-context/inject-compartments.ts` | `inject-compartments-pi.ts` | 28 | 11 | **7** | 64% |
| `hooks/magic-context/transform.ts` | `context-handler.ts` | 14 | 17 | **6** | 35% |
| `hooks/magic-context/ctx-reduce-nudge.ts` | `ctx-reduce-nudge-pi.ts` | 5 | 4 | 2 | 50% |
| `hooks/magic-context/tail-hygiene-walk.ts` | `tail-hygiene-walk-pi.ts` | 3 | 1 | 0 | 0% |
| `shared/subagent-runner.ts` | `subagent-runner.ts` | 0 | 1 | 0 | 0% |
| `hooks/magic-context/compartment-runner-historian.ts` | `pi-historian-runner.ts` | 3 | 5 | 0 | 0% |
| `hooks/magic-context/todo-view.ts` | `tools/todo-view-pi.ts` | 0 | 0 | 0 | — |

**The auto-search pair is the one to fix.** 11 of 12 commits that touched
`auto-search-pi.ts` also touched `auto-search-runner.ts` in the same commit — the memory /
anti-memory / claims work of the last two weeks (`d765b44c`, `e1c756fb`, `88826e12`,
`c21d2975`, `c02a8e40`, `53da7806`, `2154ef3a`, `24193207`, `6bbeac15`, `f2ddcce6`,
`210b91a1`) landed on both files every single time. That is not divergent per-host code;
that is one feature maintained twice by hand.

`tail-hygiene-walk-pi.ts` shows the opposite pattern (0 co-change) — and it is where the
copies have **already silently diverged** (see F-3, F-4).

### Function-level map of the seam

Verified pairs. `IDENT` = byte-identical after whitespace normalization.

| Helper | plugin | pi-plugin | Verdict |
|---|---|---|---|
| `isTransientHistorianPromptError` | `compartment-runner-historian.ts:661` | `pi-historian-runner.ts:143` | **IDENT, 27L** |
| `getHistorianRetryBackoffMs` | `compartment-runner-historian.ts:653` | `pi-historian-runner.ts:135` | **IDENT, 7L** |
| `paginateNewestFirst` | `tools/ctx-note/tools.ts:87` | `tools/ctx-note.ts:172` | **IDENT, 15L** |
| `collectEmptyStringPaths` | `config/index.ts:441` | `config/index.ts:441` | **IDENT, 15L** (same line number) |
| `isPlainObject` | `config/prune-config-leaf.ts:18` | `config/index.ts:175` | **IDENT, 3L** (+3rd copy `config/project-security.ts:63`) |
| `formatTokens` | `hooks/magic-context/event-handler.ts:125` | `index.ts:477` | **IDENT, 3L** |
| `anchorSuffix` | `tools/ctx-note/tools.ts:60` | `tools/ctx-note.ts:143` | **IDENT, 3L** |
| `formatIds` | `tools/ctx-reduce/tools.ts:215` | `tools/ctx-reduce.ts:56` | **IDENT, 3L** |
| `unifiedSearchWithTimeout` | `auto-search-runner.ts:59` | `auto-search-pi.ts:106` | 0.909 — only a comment differs, 33L |
| `hasStackedAugmentation` | `auto-search-runner.ts:244` **(exported)** | `auto-search-pi.ts:153` (private) | 0.857 — only the `export` keyword differs, 7L |
| `sameMeasuredPrefix` | `tail-hygiene-walk.ts:626` | `tail-hygiene-walk-pi.ts:627` | 0.852 — only Biome line-wrapping differs, 29L |
| `memoizedContent` | `tail-hygiene-walk.ts:95` | `tail-hygiene-walk-pi.ts:86` | 0.898 — only the return-type annotation differs, 23L |
| `fnv1a32` | `tail-hygiene-walk.ts:86` | `tail-hygiene-walk-pi.ts:57` | semantically identical (proof below) |
| `bufferEqualsNullable` | `inject-compartments.ts:2339` | `inject-compartments-pi.ts:1768` | 0.857, 7L |
| `collectUserPromptParts` | `auto-search-runner.ts:222` | `auto-search-pi.ts:140` | **genuinely host-shaped — do not unify** |
| `findLatestMeaningfulUserMessage` | `auto-search-runner.ts:268` | `auto-search-pi.ts:165` | **diverged, weaker on Pi — see F-5** |
| `safeStableStringify` | `tail-hygiene-walk.ts:119` | `tail-hygiene-walk-pi.ts:66` | **diverged, locale-sensitive on Pi — see F-3** |

Also 3× duplicated across the two packages plus `scripts/`: `escapeRegex`
(`plugin/src/shared/redaction.ts:3`, `cli/src/lib/diagnostics-pi.ts:158`,
`plugin/scripts/retrieval-benchmark/privacy.ts:237`, and a 4th near-miss at
`scripts/qualify-mc-host-production-inputs.ts:2996` that adds `-` to the character class).
The shared one exists but **is not exported**, which is why it keeps getting retyped.

---

## T2 findings — cross-package / exported API / sensitive paths

### F-1 — auto-search hint runner: one feature, two hand-maintained copies

**Clone class.** Members:
- `packages/plugin/src/hooks/magic-context/auto-search-runner.ts:54,59,244,252,268,293,484,489`
- `packages/pi-plugin/src/auto-search-pi.ts:102-104,106,153,161,165,235,451`

Function-for-function parallel structure: `AUTO_SEARCH_TIMEOUT_MS` (:54 / :102),
`unifiedSearchWithTimeout` (:59 / :106), `collectUserPromptParts` (:222 / :140),
`hasStackedAugmentation` (:244 / :153), `extractUserPromptText` (:252 / :161),
`findLatestMeaningfulUserMessage` (:268 / :165), `runAutoSearchHint` /
`runAutoSearchHintForPi` (:293 / :235), `clearAutoSearchForSession` /
`clearAutoSearchForPiSession` (:489 / :451).

**Common core.** `unifiedSearchWithTimeout` is the substantial one: 33 lines,
`AbortController` + `Promise.race` + `clearTimeout` in `finally`, both calling the *same*
`unifiedSearch` from `@magic-context/core/features/magic-context/search` with the same
`countRetrievals: false, memoryPolicySurface: "auto_search"`. The only normalized-diff
delta is the wording of one comment. `hasStackedAugmentation` is 7 lines checking the same
three literal tags; the only delta is that plugin's is `export`ed and pi's is not — pi
could import it today and does not. `extractUserPromptText` is a one-line composition over
the already-shared `extractBoundedAutoSearchQuery`.

**Differences (legitimate).** `collectUserPromptParts` walks `message.parts` with an
`ignored === true` filter on OpenCode vs `content: string | Part[]` on Pi — real host
shape, keep separate. `findLatestMeaningfulUserMessage` diverges further (see F-5).

**Call sites / spread.** pi: 1 caller (`context-handler.ts:179,6115`). plugin: 1 caller
(`hook-handlers.ts:25,392`). Two modules, two packages.

**Clone type.** Parameterized (near-miss on the shared subset; structural on the whole).

**Priority signals.** Co-change **11/12 = 92%**, the highest in the repo. Both files
carry active P1/P2 memory + claims work. Boundary-crossing. Highest priority in this
report.

**Est. net LOC delta.** −40 (extract `unifiedSearchWithTimeout` + `hasStackedAugmentation`
+ `extractUserPromptText` + the 3 constants into a shared module; pi keeps an import).

**Execution lane.** Typed-semantic. Do **not** make pi import
`auto-search-runner.ts` wholesale — it pulls `hasMeaningfulUserText`, `MessageLike`, the
`AutoSearchDelivery` union and `executeAutoSearchDelivery` into the Pi bundle. Extract the
host-agnostic helpers into a new `plugin/src/hooks/magic-context/auto-search-shared.ts`
(module has no top-level side effects — only `const` at `:54` and `:98` — so the move is
safe), then import from both. Tests exist on both sides
(`auto-search-runner.test.ts`, `auto-search-pi.test.ts`) as liveness evidence.

### F-2 — historian transient-error classifier duplicated verbatim (27 lines)

**Members.** `packages/plugin/src/hooks/magic-context/compartment-runner-historian.ts:653,661`
and `packages/pi-plugin/src/pi-historian-runner.ts:135,143`.

**Common core.** Both `getHistorianRetryBackoffMs` (7L) and
`isTransientHistorianPromptError` (27L) are **byte-identical after whitespace
normalization** (re-verified at HEAD). The classifier encodes a retry policy: a
non-retryable deny-list (`invalid request`, `bad request`, `unauthorized`, `forbidden`,
`authentication`, `auth`, `" 400"`, `startsWith("400")`) followed by a retryable
allow-list (`429`, `rate limit`, `timeout`, `econnreset`, `etimedout`, `503`, `502`,
`500`, `overloaded`). The backoff is `2000 + rand(1001)` on the first retry, `6000 +
rand(2001)` after.

**Differences.** None.

**Call sites.** Private to each file, one runner each.

**Clone type.** Exact.

**Priority signals.** 0 co-change — which is the *risk*, not a reassurance: a retry
policy that must agree across harnesses has no mechanism keeping it in agreement. Adding
one provider error string to one side silently changes retry behavior on only one host.
34 duplicated lines is the largest exact cross-package clone found.

**Est. net LOC delta.** −32.

**Execution lane.** Structural codemod. Move both to a shared
`hooks/magic-context/historian-retry-policy.ts`; the classifier is a pure
`string → boolean` with no host types, so the move is mechanical.

### F-3 — tail-hygiene hash/memo core duplicated, and the copy is locale-sensitive

**Members.** `packages/plugin/src/hooks/magic-context/tail-hygiene-walk.ts:76-84,86,95,119,626`
and `packages/pi-plugin/src/tail-hygiene-walk-pi.ts:16-22,53,57,66,86,627`.

**Common core.** `fnv1a32`, `memoizedContent` (with its
`MAX_CONTENT_MEMO_ENTRIES` / `MAX_CONTENT_MEMO_BYTES` eviction loop), `sameMeasuredPrefix`,
and the `FNV1A_32_OFFSET` / `FNV1A_32_PRIME` / `TAG_PREFIX` / memo-bound constants.

`fnv1a32` differs only in where the `>>> 0` sits (`tail-hygiene-walk.ts:88` folds it into
the loop; `tail-hygiene-walk-pi.ts:60-62` defers it to the return). I verified these are
**equivalent for all inputs** — `Math.imul` returns int32 and `^` operates on int32, so
the deferred coercion produces identical output; tested over 20 006 inputs including empty
string, NUL-separated keys, 500-char payloads, `§NNN§` tag prefixes, and non-BMP
codepoints: 0 mismatches. So this is a semantic clone, not a behavior difference.

`memoizedContent` (23L) differs only in the return-type annotation
(`ContentMemoEntry` vs an inline `{ hash; tokens }`). `sameMeasuredPrefix` (29L) differs
only in Biome line-wrapping of three early-return statements.

**Difference that matters — this is a latent bug, not just duplication.**
`safeStableStringify` was *not* copied; it was reimplemented.
`tail-hygiene-walk.ts:119` delegates to the shared
`@magic-context/core/shared/stable-json` `stableStringify`, whose docstring
(`packages/plugin/src/shared/stable-json.ts:1-19,30`) states in terms: *"Keys are sorted
by code-point order (**NOT** locale-sensitive)"* and *"Code-point sort (NOT
localeCompare). Stable across runtimes/locales."*
`packages/pi-plugin/src/tail-hygiene-walk-pi.ts:66-83` hand-rolls it with
**`left.localeCompare(right)`** — precisely what the shared module warns against. Since
this feeds `fnv1a32` → the tail-hygiene `contentSignature`, a Pi user under a locale whose
collation disagrees with code-point order can produce a different signature for identical
content, which is the value that gates whether a defer pass is allowed to reuse the
measured prefix.

**Second, smaller divergence.** `tail-hygiene-walk-pi.ts:53` defines a local `isRecord`
that **accepts arrays** (`value !== null && typeof value === "object"`), whereas the shared
`packages/plugin/src/shared/record-type-guard.ts:1-3` excludes them
(`!Array.isArray(value)`). `safeStableStringify` compensates at `:71`, but the same guard
is reused unguarded at `:149, :248, :253, :264, :297, :485, :526, :734`. Note
`transcript-pi.ts` already imports the shared guard — so pi-plugin uses both semantics
under one name.

**Call sites.** All private to their file.

**Clone type.** Near-miss (formatting-only) on 4 helpers; semantic-candidate on
`safeStableStringify`; near-miss-with-behavior-delta on `isRecord`.

**Priority signals.** 0 co-change over the whole history — the two files have never been
fixed together, and they have already drifted twice. Boundary-crossing.

**Est. net LOC delta.** −65.

**Execution lane.** Two separate changes, in this order. (1) *Correctness, not DRY*:
replace the hand-rolled `safeStableStringify` at `tail-hygiene-walk-pi.ts:66` with the
shared `stableStringify`, and the local `isRecord` at `:53` with
`@magic-context/core/shared/record-type-guard`. Both are behavior-changing on the
locale/array edges and need a test. (2) Then extract `fnv1a32` + `memoizedContent` +
`sameMeasuredPrefix` + constants to a shared module (structural codemod, no behavior
change). Do not bundle (1) and (2) in one commit.

### F-4 — pi config loader re-types plugin config-loader helpers

**Members.** `packages/plugin/src/config/index.ts:441` ↔
`packages/pi-plugin/src/config/index.ts:441` (`collectEmptyStringPaths`, **IDENT**, 15L —
note the identical line number, evidence of a line-for-line copy at fork time);
`packages/plugin/src/config/prune-config-leaf.ts:18` ↔
`packages/pi-plugin/src/config/index.ts:175` (`isPlainObject`, **IDENT**, 3L; a third copy
sits at `packages/plugin/src/config/project-security.ts:63`).

Also same-name, now-diverged: `bindSubstitutionFailures` (`:457` ↔ `:457`, 0.550),
`defineOwnConfigValue` (`:178` ↔ `:179`, 0.700), `combinedOutcome` (`:474` ↔ `:483`,
0.552), `redactConfigValue` (`:240` ↔ `:158`, 0.800).

**Differences.** At file level the two loaders are 812 changed lines out of ~640 — they
have genuinely diverged (Pi resolves its own legacy-config read fallback, uses
`comment-json` directly, exposes `LoadPiConfig*` result types). Only the two leaf helpers
above are still identical.

**Call sites.** Both private, used within their loader.

**Clone type.** Exact (the two leaves) inside a structurally-diverged file pair.

**Priority signals.** Moderate. The identical line numbers show a copy origin; the drift
elsewhere in the file shows the copies are not being kept in sync deliberately.

**Est. net LOC delta.** −16 in scope (−19 including the third `isPlainObject`).

**Execution lane.** Text/structural. Export `collectEmptyStringPaths` from the plugin
loader (or better, move both leaves to a small `config/config-value-shape.ts`) and import.
`isPlainObject` should collapse all three copies at once — but the third is in
`packages/plugin`, so coordinate with that agent's scope.

### F-5 — `findLatestMeaningfulUserMessage` diverged; the Pi copy dropped a filter

Not a consolidation candidate — reported because it is the *consequence* of F-1's copy.

`packages/plugin/src/hooks/magic-context/auto-search-runner.ts:268-291` selects the target
user message via `hasMeaningfulUserText(msg.parts)`, and its comment (`:277-285`) records
exactly why: that helper filters `ignored: true` notifications, system reminders, and
system-directive-only stubs, because *"The previous inline check accepted any non-empty
text part, which let ignored plugin-internal messages (e.g. the v0.21.7 startup
announcement) reach the embedding endpoint as if they were real user prompts."*

`packages/pi-plugin/src/auto-search-pi.ts:165-201` uses
`collectUserPromptParts(msg).trim().length === 0` — i.e. **the inline check that comment
says was the bug**. Pi's `collectUserPromptParts` (`:140-151`) also has no `ignored`
filter. So on Pi, plugin-internal notification text can still reach the embedding
provider.

Pi's version additionally carries real host logic the plugin's does not (an
`entryIdByRef` reference-identity resolution with a deliberate no-fallback-on-miss rule,
`:174-189`), so the two functions cannot simply merge. **Priority signal:** the fix that
landed on the plugin side never crossed the seam. **Lane:** typed-semantic, correctness
change, needs its own task — not part of a DRY pass.

### F-6 — `packages/cli` diagnostics: 107 lines split only by a type-alias prefix

**Members.**
- `packages/cli/src/lib/diagnostics-opencode.ts:152,162,259,302,343,807`
- `packages/cli/src/lib/diagnostics-pi.ts:97,107,150,337,370,508`

**Common core.** Verified:
`fileSize` (`:259` ↔ `:150`) **IDENT 7L**; `formatBytes` (`:807` ↔ `:508`) **IDENT 6L**;
`parseHistorianDumpMeta` (`:302` ↔ `:337`) 32L, similarity **0.969**, whose *entire*
normalized diff is one token — `HistorianDumpMeta` vs `PiHistorianDumpMeta`;
`listDumpsInDir` (`:343` ↔ `:370`) 38L, similarity **0.919**, whose entire diff is three
occurrences of `HistorianDumpSummary` vs `PiHistorianDumpSummary`.

And the types those aliases name are **structurally identical**:
`HistorianDumpSummary` (`diagnostics-opencode.ts:152-160`) vs `PiHistorianDumpSummary`
(`diagnostics-pi.ts:97-105`) — same 5 fields, same types, same order, same optionality;
`HistorianDumpMeta` (`:162-178`) vs `PiHistorianDumpMeta` (`:107-116`) — same 8 fields
(`compartmentCount`, `minStart`, `maxEnd`, `unprocessedFrom`, `factCountByCategory`,
`userObservationCount`, `ordinalGapCount`, `ordinalOverlapCount`), same types, same order.
Only the JSDoc differs.

**Differences.** None functional. This is one implementation wearing two type names.

**Call sites.** All four functions are private to their file. Both interface pairs are
`export`ed but — verified with `rg -w` across `packages/` — **imported nowhere outside
their defining file**, so consolidating them breaks no consumer.

**Clone type.** Parameterized (single type parameter, resolvable to a plain shared type).

**Module spread.** 2 files, same directory, same package.

**Est. net LOC delta.** −95.

**Execution lane.** Typed-semantic but low risk. Create
`packages/cli/src/lib/historian-dumps.ts` holding one `HistorianDumpMeta`,
one `HistorianDumpSummary`, `parseHistorianDumpMeta`, `listDumpsInDir`, `fileSize`,
`formatBytes`. Keep `export type PiHistorianDumpMeta = HistorianDumpMeta` aliases in
`diagnostics-pi.ts` so the change is provably non-breaking (that is what keeps this out of
"exported API change"); a follow-up can retire the aliases. Liveness: `diagnostics-pi.test.ts`
and `doctor-opencode.test.ts` cover both sides.

*Tier note:* same package and same directory, so this is T1-shaped; filed under T2 only
because the touched types are `export`ed. With the alias shim, treat as T1.

### F-7 — `logs-opencode.ts` / `logs-pi.ts`: duplicated issue-bundling, asymmetric redaction

**Members.** `packages/cli/src/lib/logs-opencode.ts:21,25,38,93,108` ↔
`packages/cli/src/lib/logs-pi.ts:11,15,28,39,49`.

**Common core.** `formatTimestamp` (`:25` ↔ `:15`) **IDENT 12L**; `BundledIssueReport`
interface (`:38` ↔ `:28`) identical 4L; `filterLogLinesBySession` (`:93` ↔ `:39`)
similarity 0.783 — identical `\bses_[A-Za-z0-9]{8,32}\b` regex and identical
`matches.every(...)` rule, with the plugin copy's explanatory comments stripped in the Pi
copy (which then *cites the other file* — `logs-pi.ts:35` "See logs-opencode.ts for the
rationale"); and `bundleIssueReport` (`:108` ↔ `:49`), whose 400-line tail, 4000-line
error-scan window, `extractRecentErrors(..., 20)`, `capBodyToGithubLimit` cap, and
markdown section skeleton are the same in both.

**Differences.** The Pi copy omits the historian-failure extraction
(`HISTORIAN_LOG_PATTERNS`, `isHistorianLogLine`, `extractHistorianFailureLines`,
`logs-opencode.ts:54-81`) and the `## Configuration` block; it takes an options object
rather than a positional `sessionFilter`; and the output filename differs
(`magic-context-pi-issue-*` vs `magic-context-issue-*`).

**Divergence worth flagging on its own.** Both define `sanitizeLogContent`, and both are
single-expression forwarders to *different* sanitizers:
`logs-opencode.ts:21-23` → `sanitizeDiagnosticText` (paths + secrets, from
`@magic-context/core/shared/redaction`); `logs-pi.ts:11-13` → `sanitizeString` from
`diagnostics-pi.ts:187` (secrets + paths + a username→SHA-256 hash rewrite). These bodies
write files users are directed to paste into public GitHub issues. Two different redaction
strengths under one function name in one directory is a hazard regardless of the DRY
verdict. See F-15.

**Call sites.** One each: `doctor-opencode.ts:38,336` and `doctor-pi.ts:43,980`.

**Module spread.** 2 files, same directory.

**Priority signals.** `logs-opencode.ts` has 522 lines of tests
(`logs-opencode.test.ts`); **`logs-pi.ts` has no test file at all** — so the copy that
does the redacting is the untested one.

**Est. net LOC delta.** −40.

**Execution lane.** Structural codemod for `formatTimestamp` /
`filterLogLinesBySession` / `BundledIssueReport` (mechanical, −27). The
`bundleIssueReport` bodies should stay two functions over one shared section-builder —
merging them behind a `harness` flag would be exactly the flag-plumbing this audit
otherwise flags. **Sensitive path** (public issue bodies): land the redaction decision
(F-15) before or with this, and give `logs-pi.ts` a test first.

### F-8 — `paths.ts`: seven pure-forwarding exports, two of them the same function twice

**Members.** `packages/cli/src/lib/paths.ts:126,131,136,141,149,220,266,271,280,285`.

Verified single-expression forwarders with no added semantics:

| Wrapper | Body | Refs |
|---|---|---|
| `getPiAgentConfigDir` `:126` | `return getPiAgentDir();` | 22 |
| `getPiUserConfigPath` `:141` | `return resolveCortexKitUserConfigPath();` | 22 |
| `getOmpUserConfigPath` `:271` | `return resolveCortexKitUserConfigPath();` | 10 |
| `getMagicContextLogPath` `:280` | `return getMagicContextLogPathCore(harness);` | 31 |
| `getMagicContextHistorianDir` `:285` | `return getMagicContextHistorianDirCore(harness);` | 7 |

`getPiAgentConfigDir` is a zero-argument alias of `getPiAgentDir` **carrying the same
JSDoc line verbatim** (`:118` and `:125`: *"Pi's per-user agent dir; overridable via
PI_CODING_AGENT_DIR."*) — so the codebase has two names, one behavior, and two copies of
the sentence explaining it.

`getPiUserConfigPath` and `getOmpUserConfigPath` are **the same function body under two
harness-flavored names**, and the code already admits it:
`packages/cli/src/commands/setup-omp.ts:30` reads
`getPiUserConfigPath: getOmpUserConfigPath` — an alias mapped onto an alias to satisfy a
dependency shape. That is the "growing flag/name plumbing over a single implementation"
smell in its purest form.

Two more of the same shape elsewhere: `database-access.ts:38`
`getPersistedSchemaVersion → getCorePersistedSchemaVersion(db)` (36 refs) and
`database-access.ts:187`
`openExistingContextDatabaseForMutation → openExistingContextDatabase(path, {readonly:false})`
(14 refs). The latter at least binds an argument, so it earns its keep; the former does
not.

**Clone type.** Structural (over-abstraction, not textual duplication).

**Est. net LOC delta.** −28.

**Execution lane.** Structural codemod (rename-and-inline). **T2 because all are
exported** and `setup-pi.ts:43,89` injects `getPiUserConfigPath` as a typed dependency
(`typeof getPiUserConfigPath`), so the collapse touches that seam too. Suggested order:
(1) delete `getPiAgentConfigDir`, point its 22 refs at `getPiAgentDir`; (2) collapse
`getPiUserConfigPath`/`getOmpUserConfigPath` into one `getSharedUserConfigPath` and drop
the `setup-omp.ts:30` alias; (3) inline the two `*Core` forwarders. Keep
`getPiSessionsRoot`/`getPiCacheRoot`/`getPiUserExtensionsPath`/`getOmpConfigPath`/`getOmpPluginsLockPath`
— they compose a `join`, which is real work.

### F-9 — `ctx-note` / `ctx-reduce` tool helpers duplicated verbatim, including a UX string

**Members.** `packages/plugin/src/tools/ctx-note/tools.ts:60,87` ↔
`packages/pi-plugin/src/tools/ctx-note.ts:143,172`;
`packages/plugin/src/tools/ctx-reduce/tools.ts:215` ↔
`packages/pi-plugin/src/tools/ctx-reduce.ts:56`.

**Common core.** `paginateNewestFirst` **IDENT 15L** — including the user-visible footer
template `` `Showing ${page.length} of ${total} (newest first) — ${remaining} older: ctx_note(action="read", offset=${offset + page.length})` ``. `anchorSuffix` **IDENT 3L**.
`formatIds` **IDENT 3L**. `DEFAULT_READ_LIMIT = 25` duplicated on both sides.

**Differences.** None in the cloned helpers.

**Priority signals.** A duplicated user-facing string means the two harnesses can print
different pagination hints after a one-sided edit. 0 co-change on this pair.

**Est. net LOC delta.** −16.

**Execution lane.** Structural codemod. `paginateNewestFirst` is a pure function over
`Note[]`; export it from the plugin tool module (or a shared `tools/pagination.ts`) and
import.

### F-10 — `escapeRegex`: 3 identical copies because the shared one is not exported

**Members.** `packages/plugin/src/shared/redaction.ts:3` (identical, **not exported**),
`packages/cli/src/lib/diagnostics-pi.ts:158` (identical),
`packages/plugin/scripts/retrieval-benchmark/privacy.ts:237` (identical), and
`scripts/qualify-mc-host-production-inputs.ts:2996` (near-miss: adds `-` to the class,
`[.*+?^${}()|[\]\\-]`, which is correct-and-stricter for its use).

**Est. net LOC delta.** −6 in scope.

**Execution lane.** Text. Export from `shared/redaction.ts` (or a `shared/regex.ts`) and
import at the two in-scope sites. Leave the `qualify` variant alone or import it
explicitly as a distinct `escapeRegexForCharClass` — silently swapping in the 3-char-class
version there would change TOML matching in a release-gate path.

### F-11 — `scripts/qualify-mc-host-production-inputs.ts`: TOML quote-scanner core ×3

**TRACKED-adjacent: `magic-context-c50`. Sensitive path (release qualification).**

**Members.** `scripts/qualify-mc-host-production-inputs.ts:2932` (`assignmentKeyText`),
`:2963` (`normalizeTableHeader`), `:3108` (`splitDottedKey`) — three `let quote: string |
null = null; let escaped = false;` scanners (the only three in the file, `:2933`, `:2965`,
`:3111`).

**Common core.** The identical 8-line quote/escape state machine, detected as a 3×
duplicate normalized window at `:2938/:2970/:3116`:
```
if (quote === '"') {
    if (escaped) escaped = false;
    else if (char === "\\") escaped = true;
    else if (char === '"') quote = null;
} else if (char === "'") { quote = null; }
```

**Differences.** Each wraps the core with a different accumulator: return-slice-at-`=`,
`out +=` with whitespace collapsing, `current +=` with dot splitting.

**Clone type.** Near-miss around a shared state machine.

**Priority signals.** These three functions each carry a docstring explaining a specific
TOML mis-parse they exist to prevent (quoted `=` in
`target.'cfg(target_os = "linux")'.dependencies`, whitespace around dots, dots inside
`replace."ort:2.0.0-rc.13"`). A fix to one scanner's escape handling that misses the other
two reintroduces the class of bug the docstrings describe. High correctness leverage for a
small change.

**Est. net LOC delta.** −18.

**Execution lane.** Structural codemod: extract
`scanTomlOutsideStrings(text, onChar)` or a small generator, and rebuild all three on it.
**Impact note:** this file is the `release:qualify` / `release:qualify:require` gate
(`package.json`). It has a 3042-line test (`qualify-mc-host-production-inputs.test.ts`,
run by `test:release`), and `check:all` runs `release:qualify:check` — so the refactor has
a strong existing gate. Do not touch the `escapeRegex` at `:2996` in the same change
(F-10).

### F-12 — `scripts/generate-mc-host-release-manifest.ts`: platform capability table ×3

**TRACKED-adjacent: `magic-context-c50`. Sensitive path (release contract).**

**Members.** `scripts/generate-mc-host-release-manifest.ts:157-164`, `:174-181`,
`:191-198`.

**Common core.** The same 6-element `filesystem` capability array
(`atomic_same_filesystem_replacement`, `cross_process_locks`,
`file_and_directory_fsync`, `local_filesystem`, `no_follow_link_semantics`,
`retained_object_execution`) written out three times, once per supported target.
Additionally the `darwin-arm64` (`:150-166`) and `darwin-x64` (`:167-183`) entries are
identical **except for the `target` string** — 14 duplicated lines.

**Differences.** `linux-x64-gnu` (`:184-200`) legitimately differs:
`kernel_min`/`glibc_min` instead of `os_min`, `synapse: "certified_cpu"`, and
`procfs_self_fd_exec` instead of `dev_fd_exec`.

**Clone type.** Exact (declarative data).

**Est. net LOC delta.** −14.

**Execution lane.** Text. `const BASE_FILESYSTEM_CAPABILITIES = [...] as const` plus a
small `darwinTarget(target)` builder. **Impact note:** this data is emitted into
`release/generated/mc-host-release-contract.rs`, so the extraction must be
byte-output-identical — and `bun run release:contract:check` (`package.json`) verifies
exactly that. Run it as the acceptance gate. Also covered by
`generate-mc-host-release-manifest.test.ts` (771L) via `test:release`.

---

## T1 findings — same-concept, single package

### F-13 — `packages/pi-plugin/src/index.ts`: historian deps literal built 6 times

**Members.** `packages/pi-plugin/src/index.ts:1289-1320` (`registerCtxRecompCommand`),
`:1323-1372` (`registerCtxWrapupCommand`), `:1374-1400` (`registerCtxSessionUpgradeCommand`).
The `historianChunkTokens: deriveHistorianChunkTokens(...)` marker appears at
`:1293, :1309, :1328, :1350, :1377, :1397` — six occurrences.

**Common core.** Each of the three registrations builds the same 8-field block twice —
once from `bootProjectDeps` and again inside its `resolveRuntimeDeps: (ctx) => {...}`
closure from `resolveCurrentProjectDeps(ctx)`:
```
db, runner, historianModel, historianChunkTokens: deriveHistorianChunkTokens(
  resolveHistorianContextLimit(<deps>.historianConfig?.model)),
historianFallbacks, historianTimeoutMs, historianThinkingLevel,
language, memoryEnabled, autoPromote, compactionOff
```
Detected as duplicate 10-line normalized windows at `:1292/:1327` and `:1308/:1349`.

**Differences.** Wrapup adds `userMemoriesEnabled` / `executeThreshold*`; the runner
instance differs per command (`recompRunner` / `wrapupRunner`).

**Call sites.** 6, all in this one file.

**Clone type.** Structural / same-concept.

**Priority signals.** The `deriveHistorianChunkTokens(resolveHistorianContextLimit(...))`
composition repeated six times is the specific hazard — a change to how the chunk budget
is derived has six edit points in one function, and the boot-vs-runtime pairs must stay
consistent or `/ctx-recomp` silently uses a stale budget after a project switch.

**Est. net LOC delta.** −60.

**Execution lane.** Structural codemod: one
`historianCommandDeps(deps: ProjectDeps, runner: PiSubagentRunner)` helper returning the
shared 8 fields, spread at all six sites with the per-command extras added. Same file,
same package, no exported surface.

### F-14 — `readJsonc` duplicated inside `packages/cli`

**Members.** `packages/cli/src/commands/doctor-pi.ts:221` ↔
`packages/cli/src/lib/diagnostics-pi.ts:224`. Similarity 0.839, 15L.

**Common core.** Identical `{ value, error }`-shaped JSONC read with try/catch.

**Differences.** Two only: the error field is named `error` in one and `parseError` in
the other, and `diagnostics-pi.ts` adds an `existsSync` guard returning `{ value: {} }`.

**Related.** A third same-name-different-shape variant lives at
`packages/cli/src/commands/doctor-omp.ts:133` / `diagnostics-opencode.ts:279` (`readConfig`,
similarity 0.381) — genuinely different, leave it.

**Est. net LOC delta.** −13.

**Execution lane.** Text/structural. `packages/cli/src/lib/jsonc-config.ts` already
exists and is the natural home. Adopt the `existsSync`-guarded, `parseError`-named
variant (the superset) and update the one `doctor-pi.ts` caller.

### F-15 — `doctor-omp` / `doctor-pi` duplicated version + report scaffolding

**Members.** `packages/cli/src/commands/doctor-omp.ts:93,108,112,120` ↔
`packages/cli/src/commands/doctor-pi.ts:183,201,205,158`.

`parseSemver` (0.200 — diverged enough to leave), `add` (0.667, 3L), `printResult`
(0.714, 7L), `selfVersion` (0.667, 12L). Whole-file similarity is only 0.193, so these two
doctors have genuinely diverged; only the reporting scaffold is worth touching.

Also `getSelfVersion` exists 3× (`doctor-opencode.ts:197`,
`diagnostics-opencode.ts:213`, `diagnostics-pi.ts:135`; the latter pair at 0.733).

**Est. net LOC delta.** −22.

**Execution lane.** Structural. Extract `add`/`printResult` into a shared
`lib/health-report.ts`. Leave `parseSemver` alone — the two implementations differ and
merging them is a behavior change on version comparison.

### F-16 — DB-maintenance command scaffolding duplicated

**Members.** `packages/cli/src/commands/doctor-repair-db.ts:153,477,495` ↔
`packages/cli/src/commands/doctor-reset-db.ts:79,195,538`.

`timestamp` (`:153` ↔ `:79`) **IDENT 3L**; `reportSafetyRefusal` (0.690, ~14L);
`printHelp` (0.250 — leave, the help text is legitimately different).
A third `timestamp` at `doctor-omp.ts:376` is a different implementation (0.444).

**Est. net LOC delta.** −20.

**Execution lane.** Text for `timestamp`; structural for `reportSafetyRefusal` (the
refusal-message shape is shared, the reasons are not — pass reasons in, don't flag).

### F-17 — `ensureDir` ×4 and `defaultOpenCodeDbPath` ×2

**Members.** `ensureDir`: `packages/cli/src/adapters/opencode.ts:317` ↔
`packages/cli/src/adapters/pi.ts:188` (**IDENT 7L**), plus
`packages/cli/src/commands/setup-opencode.ts:61` and
`packages/cli/src/commands/setup-pi.ts:141` (these two diverge, 0.250).
`defaultOpenCodeDbPath`: `packages/cli/src/commands/migrate-session.ts:412` ↔
`packages/cli/src/commands/migrate.ts:241` — **IDENT 3L**, and both are pure forwarders to
`getOpenCodeDatabasePath()`. Same pattern for `defaultContextDbPath` (`migrate-session.ts:415`)
/ `defaultCortexkitDbPath` (`migrate.ts:245`) — same body, two names.
`getProjectConfigPath` (`diagnostics-pi.ts:241`) and `projectConfigPath`
(`doctor-pi.ts:270`) are likewise two names for `resolveCortexKitProjectConfigPath(cwd)`.

**Est. net LOC delta.** −20.

**Execution lane.** Text. One `ensureDir` in `lib/`; delete the pure-forwarding
`default*Path` / `*projectConfigPath` wrappers and call the underlying functions directly.

### F-18 — `sha256` helpers re-typed per module

**In scope.** `packages/retina-local-fs/src/provider.ts:614`
(`createHash("sha256").update(value).digest("hex")`) and
`scripts/generate-mc-host-release-manifest.ts:475` (`sha256Hex`).

**Context.** 15 such helpers exist repo-wide under 6 different names — including
`sha256Utf8Hex` (`plugin/src/features/magic-context/memory/storage-claims.ts:54`) and
`sha256HexUtf8` (`.../claim-operation-contract.ts:131`), near-anagrams of each other. Most
copies are in `packages/plugin` (other agent's scope).

**Est. net LOC delta.** −6 in scope; the repo-wide consolidation is worth ~−45 but needs
cross-scope agreement, and content-hash helpers feed persisted digests, so it is not a
free rename.

**Execution lane.** Defer. Raise as a repo-wide item; do not unify piecemeal.

---

## T3 — needs its own design pass

### F-19 — `diagnostics-pi.ts` carries a parallel redaction stack

**Members.** `packages/cli/src/lib/diagnostics-pi.ts:158` (`escapeRegex`), `:162`
(`currentUserHash`), `:167` (`redactSecretString`), `:187` (`sanitizeString`), `:204`
(`shouldRedactKey`), `:208` (`sanitizeValue`) — roughly 60 lines reimplementing
path/username/secret redaction and key-based config redaction.

**Against.** The shared implementation already exists and is already re-exported into
this very package: `packages/cli/src/lib/redaction.ts:1-17` re-exports
`sanitizeDiagnosticText`, `sanitizeConfigValue`, `isSecretKey`, `redactSecretText`,
`sanitizePathString`, `hasShareabilitySensitiveText` from
`@magic-context/core/shared/redaction`. `diagnostics-opencode.ts:269,273` uses them.
`diagnostics-pi.ts` does not.

**Evidence this has already cost a bug.** The comment at `diagnostics-pi.ts:167-173`
records it: *"Apply the shared comprehensive redactor (OpenCode parity: adds
`github_pat_`/`ghp_`/`hf_`/`AKIA`/Slack/Google/JWT and generic key=value forms that **the
bespoke version leaked**)"*. The bespoke version leaked secrets; the fix was to layer the
shared redactor *underneath* the bespoke one rather than replace it.

**Asymmetry, and it points the wrong way.** Under the *same function name*:
`diagnostics-opencode.ts:269` `sanitizeString` = `sanitizePathString` (paths only, **no
secret redaction**); `diagnostics-pi.ts:187` `sanitizeString` = secret redaction + path
rewrite + username→SHA-256 hash. Same for `sanitizeValue`
(`sanitizeConfigValue` vs a hand-rolled `shouldRedactKey` recursion whose key regex
`/api[_-]?key|token|secret|password|authorization|cookie/i` differs from the shared
`isSecretKey`). Both feed `bundleIssueReport`, which writes files users paste into public
GitHub issues (F-7).

**Why T3.** This is not a mechanical extraction. Deciding it requires answering: is the
OpenCode diagnostics path under-redacting, or is the Pi path over-redacting? What is the
intended redaction contract for a shareable issue body? Is the username→hash rewrite
wanted on both harnesses? The DRY consolidation falls out of that answer, not the reverse.
`packages/cli/src/lib/redaction.test.ts` (196L) covers the shared layer;
`diagnostics-pi.test.ts` covers the bespoke one; `logs-pi.ts` has no test.

**Est. net LOC delta.** −45, contingent on the contract decision.

**Execution lane.** Design pass, then typed-semantic. Route to a security review, not to
a codemod. Also note `packages/cli/src/lib/redaction.ts` is otherwise a pure re-export
barrel with one real function (`sanitizeDiagnosticEndpoint`, `:19`) — once the contract is
settled, the barrel may be unnecessary indirection.

---

## T0 findings

### F-20 — Ten stale cross-file line-number citations in comments

Every one of these was checked against HEAD and **every one is stale**. Line-number
citations across files cannot survive edits; they are guaranteed rot.

| Comment | Claims | Actually at HEAD |
|---|---|---|
| `pi-plugin/src/auto-search-pi.ts:14` | per-session cache at `auto-search-runner.ts` lines 33-38, 182-187, 271-272 | 33-38 = imports; 182-187 = threshold check; 271-272 = a role/id guard |
| `auto-search-pi.ts:25` | 3000 ms cap at lines 40-47, 222-229, 239-246 | 40-47 = imports; 222-229 = `collectUserPromptParts`; 239-246 = `hasStackedAugmentation` doc. The constant is at `:54` |
| `auto-search-pi.ts:47` | stacked-augmentation guard at lines 106-115, 189-198 | 106-115 = a type docstring; 189-198 = the packer call. Guard is at `:244` |
| `auto-search-pi.ts:49` | prompt extraction at lines 118-143 | a type union |
| `auto-search-pi.ts:129` | "OpenCode lines 69-73 and search.ts lines 77-84" | unverifiable-by-construction |
| `auto-search-pi.ts:321` | "same at lines 189-198" | self-referential drift |
| `auto-search-pi.ts:416` | "OpenCode lines 268-270" | `:268` is `findLatestMeaningfulUserMessage`'s signature |
| `pi-plugin/src/context-handler.ts:1003` | `plugin/src/config/schema/magic-context.ts:303` = `clear_reasoning_age` | `:303` is `expandConfigPath`; the field is at `:505` and `:783` |
| `context-handler.ts:5705` | `transform-postprocess-phase.ts` "around lines 611-650" | an interface field list |
| `cli/src/commands/setup-opencode.ts:489` | the `if (hadExistingSetup) detectConflicts/fixConflicts` block "above (lines 231-257)" | `:231-232` ends another function, `:233` starts `writeMagicContextConfig`; the real block is at `:412-414` |

**Est. net LOC delta.** −6. **Lane:** text. Replace each with a symbol reference
(`` `auto-search-runner.ts`'s `hasStackedAugmentation` ``) — names survive edits, line
numbers do not.

### F-21 — `auto-search-pi.ts` docstring describes a per-turn cache that does not exist

`packages/pi-plugin/src/auto-search-pi.ts:11-21` documents a `sessionId -> { messageId,
hint }` process-local cache, cache-hit replay semantics, and invalidation via
`clearAutoSearchForPiSession()`. There is **no such cache in the file** — the only `let`
and `Map`-shaped state in the whole module is `let collected = ""` (`:144`) and a loop
index (`:170`). The state moved to `session_meta` (see F-22). The docstring is describing a
removed design.

**Est. net LOC delta.** −12. **Lane:** text.

### F-22 — Three no-op functions retained as ceremony, with contradicting docstrings

- `packages/plugin/src/hooks/magic-context/auto-search-runner.ts:483-486`
  `_resetAutoSearchCache()` — empty body; comment: *"Decisions are persisted in SQLite;
  retained as a no-op compatibility hook for tests."* Called only by
  `auto-search-runner.test.ts:52,56`.
- `packages/plugin/src/hooks/magic-context/auto-search-runner.ts:488-491`
  `clearAutoSearchForSession(_sessionId)` — empty body. Imported and called from live code
  (`hook-handlers.ts:25,392`) where it does nothing.
- `packages/pi-plugin/src/auto-search-pi.ts:447-453`
  `clearAutoSearchForPiSession(_sessionId)` — empty body, but its docstring says
  *"release the per-turn cache entry for that session"*, which is false.

**Est. net LOC delta.** −25 including the imports, live call sites, and the 3 test calls
(`auto-search-pi.test.ts:50,51`, `context-handler.test.ts:1074,1075`).

**Lane:** text. **Tier note:** the `_resetAutoSearchCache` removal is T0. The two
`clear*ForSession` removals touch exported symbols and live call sites across two
packages, so treat those as T2. If they are being kept as deliberate lifecycle
placeholders, say so in the comment instead of describing behavior that does not happen.

### F-23 — Six stale `dashboard` references after the Tauri dashboard was removed

The Tauri desktop dashboard was removed at HEAD (`9c1eb4d1`, "refactor: remove the Tauri
desktop dashboard"; no dashboard package remains under `packages/`). These comments still
describe it as a live consumer:

- `packages/pi-plugin/src/tokenize-pi-messages.ts:14` — "so `/ctx-status` and the
  dashboard can render an accurate breakdown"
- `packages/pi-plugin/src/system-prompt.ts:201` — "Persist hash + token estimate so
  dashboard / status surfaces are…"
- `packages/pi-plugin/src/context-handler.ts:5622` — "the dashboard. Walks the
  post-everything message array…"
- `packages/pi-plugin/src/auto-search-pi.ts:362` — "explicit ctx_search/dashboard only"
- `packages/pi-plugin/src/pi-historian-runner.ts:1316` — "recall-only side-table writes
  (dashboard + ctx_search)"
- `packages/cli/src/lib/dreamer-setup.ts:7` — "stay an advanced config/dashboard option"

**Est. net LOC delta.** −3 (edits, not deletions). **Lane:** text.
**Cross-reference:** dashboard-removal cleanup is actively tracked
(`magic-context-mpy`, `magic-context-tzu`, `magic-context-rnq`) — these comment edits are
in the same sweep but are not themselves blocked by those beads.

### F-24 — Four timeline / review-artifact comments

Per `AGENTS.md`, comments state what the code *is*, not the project timeline, and must not
cite review rounds.

- `packages/pi-plugin/src/dreamer/index.ts:30-35` and `:38-42` — both open with "Council
  finding #7:" and then narrate a past state ("Hardcoded `{provider:"off"}` previously
  meant dreamer skipped both paths", "Hardcoded `false` previously made dreamer's memory
  tasks a no-op"). Rewrite as the present-tense requirement: *why* dreamer needs the real
  embedding config and memory gate.
- `packages/pi-plugin/src/index.ts:1462-1464` — "Council finding #7: … Previously
  hardcoded to off/false, making most dreamer tasks useless on Pi."
- `packages/pi-plugin/src/index.ts:1516-1519` — "We previously wrapped URLs in OSC 8
  hyperlink escapes, but not all terminals support them…". The *reason* (not all terminals
  support OSC 8; `ctx.ui.notify` re-renders through pi-tui and strips raw escapes) is
  worth keeping; the "we previously" framing is not.
- `packages/pi-plugin/src/context-handler.ts:1004` — "Pi previously hardcoded `30`, which
  cleared reasoning more aggressively than the user configured."

Note: most other `previously` hits in scope are legitimate ("previously-stripped
placeholders", "previously-delivered nudge") — those describe *data state*, not project
history. Leave them.

**Est. net LOC delta.** −8. **Lane:** text.

### F-25 — Duplicated JSDoc on an alias pair

`packages/cli/src/lib/paths.ts:118` and `:125` carry the identical sentence *"Pi's
per-user agent dir; overridable via PI_CODING_AGENT_DIR."* on `getPiAgentDir` and its
zero-argument alias `getPiAgentConfigDir`. Resolved by F-8.
**Est. net LOC delta.** −2.

### F-26 — Two pure-forwarding wrappers, verbatim-inlinable

`packages/cli/src/lib/diagnostics-opencode.ts:269-271`
(`sanitizeString → sanitizePathString`) and `:273-275`
(`sanitizeValue → sanitizeConfigValue`). No added semantics, no bound arguments, and the
names collide with substantially different functions of the same name in
`diagnostics-pi.ts` (F-19). 15 call sites in one file, so inlining is a single
find-and-replace.

**Est. net LOC delta.** −8. **Lane:** text. Sequence after F-19 — if the redaction
contract changes, the right target changes with it.

### F-27 — Eight over-exported symbols in `packages/pi-plugin`

Verified with `rg -w` across `packages/`, `scripts/`, `crates/`, `tests/`: referenced
**only inside their defining file**, with no test importing them. Removing `export`
narrows the surface at zero behavioral cost.

| Symbol | Location | Internal uses |
|---|---|---|
| `TODOS_COMMAND_NAME` | `src/tools/todo-view-pi.ts:19` | `:346` |
| `clearTodowriteToolCallTodos` | `src/tools/todo-view-pi.ts:111` | `:178,582,590,611,617` |
| `parseTodoStateJson` | `src/tools/todo-view-pi.ts:135` | `:157` |
| `seedTodoSnapshotFromStateJson` | `src/tools/todo-view-pi.ts:153` | `:571,607` |
| `clearTodoSnapshot` | `src/tools/todo-view-pi.ts:172` | `:585,593,613,619` |
| `renderCtxStatusEntry` | `src/commands/pi-command-utils.ts:71` | `:105` |
| `defaultLoaders` | `src/dreamer/pi-session-api.ts:29` | `:60` |
| `resolvePiCodingAgentModule` | `src/dreamer/pi-session-api.ts:53` | `:92` |

Also `HistorianDumpMeta` / `HistorianDumpSummary` / `PiHistorianDumpMeta` /
`PiHistorianDumpSummary` in `packages/cli/src/lib/` are exported and imported nowhere
outside their files (see F-6).

**Est. net LOC delta.** ≈0 (surface reduction, not deletion). **Lane:** text.

---

## TRACKED — do not remove

| Item | Bead | Note |
|---|---|---|
| `scripts/qualify-mc-host-production-inputs.ts` (4595L) + `.test.ts` (3042L) | `magic-context-c50` | Active precursor to the hand-rolled Rust module host. Zero external refs beyond `package.json` `release:qualify*` is expected. **Do not remove — precursor to magic-context-c50.** Duplication inside it is reported as F-11 (refactor, not deletion). |
| `scripts/generate-mc-host-release-manifest.ts` (1727L) + `.test.ts` | `magic-context-c50` | Emits `release/generated/mc-host-release-contract.rs`. **Do not remove — precursor to magic-context-c50.** F-12 applies. |
| `scripts/build-mc-host-payload.ts` (1255L) + `.test.ts` | `magic-context-c50` | `release:payload*`. **Do not remove — precursor to magic-context-c50.** No internal duplication found (0 duplicate 8-line windows). |
| `scripts/run-mc-host-closure-qualification.ts` (65L) | `magic-context-c50` | **Zero references anywhere in the repo** — not in `package.json`, not in `.github/workflows/`, not in docs. Would otherwise be flagged dead. It drives the `mc-host` `harness_closure` ignored test with roots read from `release/mc-host-production-input-sources.json`. **Do not remove — precursor to magic-context-c50.** Consider adding a `package.json` script entry so its liveness is legible. |
| `scripts/drive-rig/` (6 files, ~410L sh + Dockerfile) | `magic-context-c50` (adjacent) | Referenced only from `piolium/attack-surface/lite-recon.md` and a Mermaid node in `docs/mc-host-wire-protocol.md:42`. The connection-file path it uses is still live (`plugin/src/hooks/magic-context/module-transport.ts:38`), so it is not stale on that axis, but `run.sh:7` pins `mc-drive:1.18.3` while `release/mc-host-harness-closures/` carries `opencode-linux-x64-1.18.22`. **Not proposing removal**; flag the image pin for refresh alongside c50. |
| `packages/pi-plugin/src/index.ts` dreamer config threading | `magic-context-pml.1`–`pml.3`, `magic-context-c7t` | F-13's consolidation touches the dreamer/command deps surface that the Rust dreamer port and the `c7t` bash-capable-dreamer bug both operate on. Sequence F-13 with those, or keep it purely mechanical. |
| stale `dashboard` comments (F-23) | `magic-context-mpy`, `magic-context-tzu`, `magic-context-rnq` | Cleanup is tracked; the comment edits are safe now but belong in that sweep. |
| `packages/cli/src/lib/paths.ts` PID/process helpers | `magic-context-dmv` | `dmv` wants shared PID start-time probes for the Rust e2e reaper. No PID-probe duplication found in `packages/cli` at HEAD, so no conflict — noted so F-8's `paths.ts` edits stay clear of any incoming probe module. |

## Do not unify yet

- **`inject-compartments-pi.ts` (2448L) ↔ `inject-compartments.ts` (2958L).** Highest
  absolute LOC pair, and it is already doing the right thing: the header
  (`inject-compartments-pi.ts:1-26`) documents that it projects Pi's
  `content: string | Part[]` into a MessageLike view precisely so the shared
  `prepareCompartmentInjection` runs unchanged, and it imports 15 core modules. The
  remaining same-name functions are host-shaped (`renderUserProfileBlock` 0.200,
  `prependM0M1Messages` 0.364, `getSessionFactsVersion` 0.444). Co-change is 64%, so
  watch it — but the divergence is real message-shape work, not copy rot. Only
  `bufferEqualsNullable` (`:2339` ↔ `:1768`, 0.857, 7L) is worth lifting, and it is not
  worth a boundary change on its own.
- **`context-handler.ts` (6151L) ↔ `transform.ts` / `hook.ts`.** Similarity to `hook.ts`
  is effectively nil (0 co-change); to `transform.ts` it is 35% co-change but the file has
  **zero internal duplicate 10-line windows** — it is a large, non-repetitive host
  adapter. Intentionally per-host.
- **`collectUserPromptParts`** (F-1) and **`findLatestMeaningfulUserMessage`** (F-5).
  Different message shapes and, in the latter case, different resolution strategies
  (`entryIdByRef` reference identity vs positional). F-5 needs a correctness fix, not
  unification.
- **`packages/cli` `doctor-*` command bodies.** `doctor-opencode.ts` ↔ `doctor-pi.ts`
  similarity is **0.067** (80 shared normalized lines out of 1347/1024);
  `doctor-opencode.ts` ↔ `doctor-omp.ts` is 0.029. `setup-opencode.ts` ↔ `setup-pi.ts` is
  0.121. These three-harness command families have genuinely diverged and should stay
  separate — only their leaf helpers (F-15, F-16, F-17) are worth sharing. Resist the
  temptation to build a `runDoctor(harness)` with a flag matrix.
- **`packages/cli/src/adapters/{opencode,pi,omp}.ts`** (301/179/180L, pairwise 0.346 /
  0.184 / 0.125). Already a proper adapter set behind `adapters/types.ts` (100L). Only
  `ensureDir` is duplicated (F-17).
- **`packages/plugin` `sha256` family** (F-18). Cross-scope and touches persisted digests.

## Dead code

Everything below was checked with `rg` across the whole repo (including `.github/workflows/`
and every `package.json` script block) before being listed.

**Confirmed dead (safe to remove):**
- `_resetAutoSearchCache` (`plugin/src/hooks/magic-context/auto-search-runner.ts:483`) —
  empty body, referenced only by its own test. −8 LOC with the test calls. (F-22)

**Empty-bodied but wired into live paths — remove or document, do not leave as-is:**
- `clearAutoSearchForSession` (`auto-search-runner.ts:488`), called from
  `hook-handlers.ts:392`.
- `clearAutoSearchForPiSession` (`pi-plugin/src/auto-search-pi.ts:451`), called from
  `context-handler.ts:6115`.
  Both T2 (exported, cross-file live callers). ≈−17 LOC. (F-22)

**Over-exported, not dead:** the 8 symbols in F-27 plus the 4 `cli` diagnostics types in
F-6. Narrow visibility; do not delete.

**Unreferenced but deliberately manual — NOT proposing deletion:**
- `scripts/ci-watch.sh` (134L). Zero references anywhere. But it is a self-documenting
  developer tool with a full usage/env/exit-code header (`:1-25`) explaining why it exists
  (`gh run watch` swallows the exit code through a pipe). Keep.
- `scripts/context-dump.ts` (68L). Referenced only in `STRUCTURE.md:100` prose and a
  tokenizer fixture. Thin CLI over
  `packages/plugin/scripts/context-dump/run-context-dump`. Manual debug tool. Keep.
- `scripts/perf-mc-host.sh` (420L). No CI reference, but invoked as an operator command
  in `docs/perf/mc-host-ipc-budget.md:147-151` and
  `docs/perf/mc-shm-hardware-envelope.md:27,110`. Documented manual tool. Keep.
- `packages/pi-plugin/scripts/experiments/perf/` (1414L across 7 files). Zero executable
  references — not in `packages/pi-plugin/package.json`, not in any workflow. But it has a
  38-line README with concrete invocations, and recent commit activity
  (`8b31fb9a`, `38dc9f19`, `0fa0583e`, `fa72ddc5`). Operator-invoked benchmark harness,
  same category as `perf-mc-host.sh`. Keep. Worth a `package.json` script entry to make
  liveness legible.
- `scripts/install.sh`, `scripts/install.ps1`. No CI reference, but both are `curl`/`irm`
  targets in `README.md:57,63` — **user-facing, highest-consequence files in `scripts/`.**
  Keep.

**Untracked local cruft (not a repo finding):** `scripts/sqlite-bench/` (`run_ab.py`,
`ts_bench.ts` 190L, and a committed-looking `__pycache__/run_ab.cpython-39.pyc`) is
**not in `git ls-files`** — it is untracked local work, out of scope for a repo audit.
Flagging only so it is not mistaken for tracked dead code.

**No dead code found** in `packages/retina-local-fs` (0 duplicate windows across
`provider.ts` 616L and `path-fence.ts` 157L) or `packages/mc-shm-native` (0 duplicate
windows in `index.ts` 519L; the rest is Rust). `packages/docs` is prose — the
docs-URL follow-up is `magic-context-mpy`.

## Comment violations

Summarized; details in F-20 through F-25.

| Class | Count | Locations | Delta |
|---|---|---|---|
| Stale cross-file line-number citations | 10 | `auto-search-pi.ts:14,25,47,49,129,321,416`; `context-handler.ts:1003,5705`; `setup-opencode.ts:489` | −6 |
| Docstring describing removed design | 1 block | `auto-search-pi.ts:11-21` (per-turn cache that does not exist) | −12 |
| Docstrings contradicting empty bodies | 3 | `auto-search-runner.ts:483,488`; `auto-search-pi.ts:447` | (in F-22) |
| Stale `dashboard` references post-removal | 6 | `tokenize-pi-messages.ts:14`; `system-prompt.ts:201`; `context-handler.ts:5622`; `auto-search-pi.ts:362`; `pi-historian-runner.ts:1316`; `dreamer-setup.ts:7` | −3 |
| Timeline / review-artifact narration | 4 | `dreamer/index.ts:30,38`; `index.ts:1462,1516`; `context-handler.ts:1004` ("Council finding #7", "previously hardcoded") | −8 |
| Duplicated JSDoc on an alias pair | 1 | `paths.ts:118` / `:125` | −2 |
| **Total** | **25** | | **−31** |

The line-number-citation class is the one worth a rule, not just a fix: 10 of 10 are
stale, and the pattern will regenerate. Every one should become a symbol reference.

## Suggested order

1. **F-20, F-21, F-23, F-24, F-25** — comments only, zero risk, and F-20/F-21 stop the
   `auto-search-pi.ts` docstring from misleading whoever executes F-1.
2. **F-3 step (1)** — the `localeCompare` and `isRecord` fixes in
   `tail-hygiene-walk-pi.ts`. Correctness, not DRY. Needs a test.
3. **F-2, F-9, F-10, F-17, F-14, F-16** — mechanical exact-clone collapses, each small
   and independently verifiable (≈−100 LOC).
4. **F-6** — the 107-line `cli` diagnostics consolidation with alias shims. Biggest
   single win, provably non-breaking.
5. **F-1** — the auto-search shared module. Highest priority by co-change; do it via a
   new small shared file, not a wholesale import.
6. **F-13, F-3 step (2), F-7, F-8, F-15, F-22, F-26, F-27** — the rest.
7. **F-11, F-12** — release-path refactors, each behind its own existing
   `release:*:check` gate. Sequence after `magic-context-c50` lands or coordinate with it.
8. **F-19** — design pass. Route to security review.
9. **F-5** — file as a correctness bug against `auto-search-pi.ts`, not a DRY item.
10. **F-18** — repo-wide, cross-scope. Defer.
