# Cross-Subsystem Duplication Audit

**Scope:** duplication that crosses subsystem boundaries — TypeScript package ↔ TypeScript
package, TypeScript ↔ Rust, and Rust crate ↔ Rust crate. Within-module duplication is covered
by the sibling audits (`packages/plugin/src/features`, `hooks`, `shared`, `pi-plugin/cli`,
`crates/mc-module`, `mc-host`/`store`/`shm`).

**Verified against:** HEAD `9c1eb4d1` ("Merge pull request #85 from ahrav/remove-tauri-dashboard").
Read-only audit; no files were modified.

**Co-change method:** `git log --no-merges --format=%H --name-only -n 1500` (reaches back to
`76d2c1eb`), filtered to each clone class's members. A "lockstep commit" is one commit touching
two or more members of the same class. Lockstep *rate* (lockstep ÷ that file's own commit count)
is the strongest ranking signal in this report, because it measures how often a human had to
remember the second copy.

---

## Summary

The repository already owns three good anchoring mechanisms for unavoidable twins, and uses all
three well in places:

1. **Generated single-source contract** — `release/mc-host-release.json` is generated into both
   `packages/plugin/src/shared/mc-host-lifecycle/generated-contract.ts:14` and
   `mc_module::release_contract::RELEASE_CONTRACT_JSON`, with a `--check` drift gate
   (`generated-contract.ts:4`) and a Rust conformance test asserting hardcoded Rust constants
   equal the contract (`crates/mc-module/tests/release_contract_conformance.rs:17`,
   `crates/mc-module/src/lib.rs:30389`).
2. **Shared frozen golden replayed by both languages** — `smart-note-evaluation-golden.json` is
   replayed by `crates/mc-module/src/smart_note_evaluation.rs:1102` and
   `packages/plugin/src/features/magic-context/smart-notes/evaluation-state.test.ts:54`, with the
   contract written down in `packages/plugin/src/features/magic-context/smart-notes/PARITY.md`.
3. **Shared fixture replayed by both packages** — `packages/pi-plugin/src/tail-hygiene-parity.test.ts`
   drives `measureTailHygiene` (plugin) and `measurePiTailHygiene` (pi) over one fixture.

Almost every finding below is a place where a twin exists **without** one of those three anchors,
even though the mechanism was already available. That is the through-line: the problem is not that
the repo lacks a pattern, it is that the pattern is applied unevenly.

Highest-signal findings, in order:

| # | Clone class | Lockstep | Why it ranks here |
|---|---|---|---|
| X1 | Two config loaders (plugin ↔ pi-plugin) | 4 / 7 and 4 / 5 | One lockstep commit was a **security fix** applied twice by hand; the two loaders use **different JSONC parsers** for the same file |
| X2 | Four authorities for the managed data root | 2 cross-file (incl. 1 cross-language) | 38 non-test sites hardcode `"cortexkit"`; the four resolvers disagree on whether a relative `XDG_DATA_HOME` is legal |
| X3 | `migrate-dreamer-v2` copied into the CLI | **0** | Zero co-change is worse than lockstep: the next dreamer task added will silently be written as disabled by the doctor's on-disk migration |
| X4 | `retina-local-fs` path fence re-derives the fenced layout | 0 | A **security fence** built on the permissive data-root rule, not the daemon's |
| X5 | `auto-search-pi` ↔ `auto-search-runner` | **11 / 12 (92%)** | Highest lockstep rate in the repo; the helpers pi copied are already `export`ed by the plugin |
| X7 | `ctx_memory` / `ctx_note` tool schemas | **24** | Highest absolute lockstep count; blocked by two incompatible tool-schema DSLs |

---

## Findings by tier

### T2 — cross-boundary consolidation (per-finding approval)

---

#### X1 — Two hand-maintained config loaders for one config file, with divergent JSONC parsers

**Clone type:** structural / near-miss (shared type vocabulary, duplicated orchestration).

**Members**

- `packages/plugin/src/config/index.ts:1-641` — `LoadOutcome` at `:77`, `LoadResultDetailed` at
  `:85`, `loadConfigFileDetailed` at `:103`
- `packages/pi-plugin/src/config/index.ts:1-637` — `LoadOutcome` at `:45`,
  `LoadPiConfigResultDetailed` at `:53`, `loadConfigFile` at `:105`

**Common core.** Both files implement the same eight-stage pipeline over the same two files
(`<base>.jsonc` then `<base>.json`, user tier then project tier): read → `substituteConfigVariables`
→ JSONC parse → prototype-pollution sanitize → `migrateLegacyAgentEnabledInMemory` →
`migrateDreamerV2` → `migrateLegacyExperimental` → `stripUnsafeProjectConfigFields` /
`constrainProjectThresholdOverrides` / `dropInheritedEmbeddingKeyOnRedirect` →
`MagicContextConfigSchema` parse → `pruneNestedConfigLeaf`. Every leaf helper is already shared via
`@magic-context/core/config/*`. The duplicated part is the orchestration plus the result vocabulary:
the six-member `LoadOutcome` union is character-identical in both files, as are the
`sources: { userConfig, projectConfig }` shape, the `substitutionFailures: Array<{ keyPath, source,
message }>` shape, and `recoveredTopLevelKeys`.

**Differences.** Three, one of which is load-bearing:

1. **Different JSONC parsers for the same file.** Plugin uses `parseJsonc`
   (`packages/plugin/src/config/index.ts:132`), which is `stripTrailingCommas(stripJsonComments(text))`
   then `JSON.parse` (`packages/plugin/src/shared/jsonc-parser.ts:158-164`). Pi uses
   `parseCommentJson` from the `comment-json` npm package
   (`packages/pi-plugin/src/config/index.ts:31,120`). These are different grammars: a comment or
   trailing comma the regex normalizer mishandles, or a construct `comment-json` accepts that the
   normalizer does not, makes the same `magic-context.jsonc` load differently under OpenCode and
   under Pi. This is not a deliberate split — `comment-json@^5.0.0` is a dependency of
   `packages/plugin/package.json:66` too, so either package can use either parser.
2. Plugin's result type is `MagicContextPluginConfig` (adds `disabled_hooks`, `command`); pi's is
   plain `MagicContextConfig`.
3. Plugin additionally imports `resolveTransformMode` and `isCompactionEnabled`; pi does not.

**Call sites.** `packages/plugin/src/index.ts` (boot) and `packages/pi-plugin/src/index.ts:446-465`
(boot). Both are the single config entry point for their harness.

**Owning modules.** `packages/plugin/src/config`, `packages/pi-plugin/src/config`.

**Priority signals.**

- **Lockstep: 4 of 7 plugin commits, 4 of 5 pi commits.** `9f4d90ae`, `c5145a9c`, `5a031ea3`,
  `e37f3a62`.
- `c5145a9c` is **"fix(config): block prototype pollution deep-merge security-strip bypass"** —
  +50 lines to the plugin loader and +55 to the pi loader, plus both test files. A security fix
  was written twice. That is the exact failure mode this class predicts.
- The parity guard that used to cover this pair **was deleted**; bead `magic-context-1cy`
  ("Replace deleted config-parity guard with experimental-absence schema test") tracks replacing it
  with something narrower. The twin is currently unguarded.

**Est. net LOC delta.** Roughly −350 to −450 if the orchestration moves into
`@magic-context/core/config` as a `loadMagicContextConfig({ scope, parse, extend })` with the two
harness-specific pieces injected. The parser divergence must be resolved as part of it (pick one;
`comment-json` is the stricter and already-vendored option).

**Execution lane.** T2, sensitive (config is a security boundary — project-tier stripping runs here).
Land behind a restored parity test first, coordinated with `magic-context-1cy` so the two efforts do
not collide.

---

#### X2 — Four independent authorities for the managed data root, and 38 hardcoded copies of its layout

**Clone type:** semantic / parameterized. Same concept ("where does CortexKit keep its state"),
four implementations with materially different acceptance rules, plus wide literal duplication of the
path segments.

**Members — the four resolvers**

| Authority | Relative `XDG_DATA_HOME` | Home source | Test isolation |
|---|---|---|---|
| `crates/mc-host/src/instance.rs:147` `data_dir_path` | **rejected** (`path.is_absolute().then_some`) | `env HOME`, must be absolute | n/a |
| `packages/plugin/src/shared/mc-host-lifecycle/paths.ts:51` `resolveLifecycleDataRoot` | **rejected** (`absoluteOrNull`) | `env.HOME`, must be absolute | `MAGIC_CONTEXT_TEST_DATA_DIR`, `NODE_ENV=test` backstop |
| `packages/plugin/src/shared/data-path.ts:6` `getDataDir` | **accepted** | `os.homedir()` | via `getMagicContextStorageDir` (`:198`) only |
| `packages/retina-local-fs/src/path-fence.ts:60-62`, `:111` | **accepted** (`resolve()`d against cwd) | `process.env.HOME ?? homedir()` | none |

**Members — the layout literals.** The segments `cortexkit`, `run`, `magic-context`, and
`subc-connection.json` are hand-written rather than derived:

- `crates/mc-host/src/instance.rs:22` `CONNECTION_FILE_NAME = "subc-connection.json"`, `:167`
  `MANAGED_DIR_NAME = "cortexkit"`, `:178` `runtime_dir_path` joins `"run"`
- `packages/plugin/src/shared/mc-host-lifecycle/paths.ts:27` `CONNECTION_FILE_NAME` (duplicate of the
  Rust constant), `:69` `managedSubtreePath` hardcodes `"cortexkit"`, `:73` `runtimeDirPath`
  hardcodes `"run"`
- `packages/retina-local-fs/src/path-fence.ts:113` `"cortexkit"`, `:138`
  `["plexus","claustrum","staging","run","magic-context"]`
- 38 further non-test TypeScript sites across six packages and `scripts/` hardcode `"cortexkit"`,
  including `packages/cli/src/lib/diagnostics-opencode.ts:256`,
  `packages/plugin/src/tui/data/context-db.ts:21`,
  `packages/plugin/src/shared/mc-host-lifecycle/owner.ts:210`,
  `packages/e2e-tests/src/pi-harness.ts:52,199`,
  `packages/e2e-tests/src/initialize-context-db.ts:9`,
  `packages/e2e-tests/src/rust-harness.ts:183,626,649`,
  `packages/e2e-tests/src/rust-runner/hermetic-mc-host.ts:177,731,737,738,936,938,1144`,
  `packages/e2e-tests/src/opencode-runner/spawn.ts:61`,
  `packages/plugin/scripts/probe-mc-host-transport.ts:372`,
  `packages/plugin/scripts/bench-synapse-vs-local.ts:39`,
  `packages/plugin/scripts/drive-preseed.ts:27`.

**The asymmetry that makes this cheap to fix.** `paths.ts:65` already reads
`releaseContract.coordination.directory` from the generated contract instead of hardcoding
`.mc-host-coordination`, and `crates/mc-host/src/lifecycle.rs:40` hardcodes
`COORDINATION_DIR_NAME` but is machine-checked against the contract at
`crates/mc-module/src/lib.rs:30389-30401`. The mechanism is built, wired, and drift-gated. It simply
does not cover `cortexkit`, `run`, `magic-context`, or `subc-connection.json` — there is no
conformance assertion for `MANAGED_DIR_NAME` or `CONNECTION_FILE_NAME` in
`crates/mc-module/tests/release_contract_conformance.rs`.

**Differences that are already documented as deliberate.** `paths.ts:10-17` states plainly that it
must not reuse `data-path.ts`'s `getDataDir()` because lifecycle paths have to agree byte-for-byte
with the Rust daemon while storage paths keep their `os.homedir()` fallback. That reasoning is sound
and this finding does not propose merging those two. The finding is that the *segment names* and
the *relative-`XDG_DATA_HOME` rule* should be single-sourced even though the resolvers stay separate.

**Priority signals.**

- Lockstep: `b6931fc6` (`data-path.ts` + `paths.ts`), `fe4be9af` (`paths.ts` + `instance.rs` —
  cross-language). `paths.ts` 10 commits, `instance.rs` 22.
- Blast radius: every one of the 38 literal sites is a place where a layout change (adding a level,
  renaming `magic-context`) leaves a stale path that resolves to a directory that does not exist, or
  worse, to a *different* live directory.

**Est. net LOC delta.** Small (roughly −60), but that is not the point — the value is removing 38
independent chances to name the wrong path.

**Execution lane.** T2 minimum, sensitive (lifecycle publication, release pipeline, security fence).
Recommended sequence: (a) add `managed_subtree`, `runtime_directory`, `connection_file`, and
`storage_subdirectory` to `release/mc-host-release.json`; (b) extend
`release_contract_conformance.rs` to assert `mc_host::MANAGED_DIR_NAME` and
`mc_host::CONNECTION_FILE_NAME` against it, matching the existing `COORDINATION_DIRECTORY` pattern;
(c) delete the TypeScript literals in favour of `releaseContract.*`. Steps (a)–(c) are one T2 change;
sweeping the 38 script/e2e sites is a follow-on T1.

---

#### X3 — `migrate-dreamer-v2` re-implemented inside the CLI, with the spec comments stripped

**Clone type:** near-miss (same algorithm and constants, different mutation style, comments removed).

**Members**

- `packages/plugin/src/config/migrate-dreamer-v2.ts:1-336` — the in-memory migration run on every
  config load
- `packages/cli/src/lib/migrate-dreamer-v2-doctor.ts:1-279` — the on-disk equivalent run by
  `doctor`

**Common core.** 119 shared 6-line shingles, the largest cross-package clone measured. Identical
constants: `OLD_VERIFY_TASK`, `OLD_CURATE_TASKS`, `RETIRED_OBJECT_MEMORY_TASKS`, the eleven-entry
`CANONICAL` task list, `DEFAULT_BASE_CRON`, `DEFAULT_CLASSIFY_CRON`,
`DEFAULT_RETROSPECTIVE_CRON`, `DEFAULT_VERIFY_BROAD_CRON`, and the `windowToCron`
`/^(\d{1,2}):(\d{2})\s*-/` regex with the same fail-open fallback. A diff of the two `CANONICAL`
blocks is empty apart from a stripped trailing comment.

**Differences.** The CLI copy mutates in place and returns `boolean`; the plugin copy returns a new
object. The CLI copy deletes the explanatory header
(`packages/plugin/src/config/migrate-dreamer-v2.ts:1-37`) that encodes the migration *rules* —
"legacy `tasks` array present → it is the user's deliberate selection: each listed task gets the base
cron, each omitted canonical task gets `""` (disabled)". The rules survive only in the plugin copy.

**Call sites.** `packages/cli/src/commands/doctor*.ts` for the on-disk copy;
`packages/plugin/src/config/index.ts` and `packages/pi-plugin/src/config/index.ts` (both import
`@magic-context/core/config/migrate-dreamer-v2`) for the in-memory copy.

**Priority signals.**

- **Lockstep: 0.** Both files were last touched on 2026-06-23 (`7334224b` and `d6ddac3c`) and neither
  appears in the last 1500 commits since. They have not drifted yet.
- Zero co-change is the *worse* signal here, not the better one. The next dreamer task added to
  `CANONICAL` in the plugin will be absent from the CLI's list, and by the documented rule the
  doctor's on-disk migration will write `""` for it — silently disabling a task the user never
  disabled, in a file the doctor rewrites on disk.
- The CLI already imports plugin code (`packages/cli/src/commands/migrate.ts:4` imports
  `@magic-context/core/shared/data-path`), so the shared-import path exists and is in use.

**Est. net LOC delta.** −180 to −230 if the doctor's on-disk writer wraps the shared in-memory
migration (parse → `migrateDreamerV2` → serialize) instead of reimplementing it.

**Execution lane.** T2 (behavioral: the doctor writes the user's real config file). Needs a test
asserting both paths produce the same `tasks` record for a fixed set of legacy shapes, plus one
asserting a task added to `CANONICAL` shows up in the doctor's output.

---

#### X4 — `retina-local-fs` builds a security fence on the permissive data-root rule

**Clone type:** semantic. Same concept as X2 but called out separately because the divergence has a
security consequence rather than a correctness one.

**Members**

- `packages/retina-local-fs/src/path-fence.ts:47-65` `resolveFenceRoots` →
  `resolve(options.dataDirectory ?? process.env.XDG_DATA_HOME ?? join(home, ".local", "share"))`
- `packages/retina-local-fs/src/path-fence.ts:108-142` `isFencedPath`, whose default
  `dataDirectory` parameter is `process.env.XDG_DATA_HOME ?? join(resolve(homeDirectory), ".local", "share")`
- versus `crates/mc-host/src/instance.rs:147` and
  `packages/plugin/src/shared/mc-host-lifecycle/paths.ts:51`, which both reject a relative value

**The divergence.** `path-fence.ts` passes `XDG_DATA_HOME` through `resolve()`, which resolves a
relative value against `process.cwd()`. The daemon and the lifecycle resolver both *ignore* a
relative value and fall back to `$HOME/.local/share`; `instance.rs:139-141` says so explicitly ("a
poisoned `XDG_DATA_HOME=./x` cannot select a cwd-dependent lifecycle root"). So under
`XDG_DATA_HOME=./x` the daemon's real state lives at `~/.local/share/cortexkit/...` while the fence
computes its root at `$cwd/x/cortexkit`. The paths the fence exists to refuse —
`plexus/store.db*`, `run/`, `*binding-key*`, `*.handle` (`path-fence.ts:138-141`) — would then not
match, and a retina provider read of the real files would not be fenced.

**Confidence.** Code-reading only. I did not execute this and did not attempt an exploit. The
inference is: the fence root is derived from a value the fence resolves permissively, and the files
it protects are placed by a component that resolves the same value strictly. Both routes into
`isFencedPath` (the production `resolveAndFenceProviderPath` path and the exported
`isFencedPath` re-exported at `packages/retina-local-fs/src/provider.ts:10`) share the weakness.

**Secondary divergence.** Three different home authorities across the four resolvers:
`env.HOME` only (Rust, lifecycle), `os.homedir()` only (`data-path.ts:7`), and
`process.env.HOME ?? homedir()` (`path-fence.ts:50`).

**Call sites.** `packages/retina-local-fs/src/provider.ts:95,104`; consumed by both
`packages/plugin` and `packages/pi-plugin` via their `tsconfig` project references.

**Priority signals.** Lockstep 0; `path-fence.ts` has 2 commits in the window. Low churn, which is
why the divergence has gone unnoticed. Ranked high on impact, not on churn.

**Est. drift risk.** High. Fixing it is small: reject a relative `XDG_DATA_HOME` in
`resolveFenceRoots` the way the other two resolvers do, and derive the fenced-root list from the
same contract X2 proposes.

**Execution lane.** T2, sensitive (security fence). Should be paired with X2 so the fence's layout
list and the daemon's layout come from one source.

---

#### X5 — `auto-search-pi` mirrors `auto-search-runner`, copying helpers the plugin already exports

**Clone type:** near-miss structural clone with a duplicated private helper set.

**Members**

- `packages/pi-plugin/src/auto-search-pi.ts` — `AUTO_SEARCH_TIMEOUT_MS = 3_000` at `:102`,
  `unifiedSearchWithTimeout` at `:106`, `collectUserPromptParts` at `:140`,
  `hasStackedAugmentation` at `:153`, `extractUserPromptText` at `:161`,
  `findLatestMeaningfulUserMessage` at `:165`, `runAutoSearchHintForPi` at `:235`,
  `clearAutoSearchForPiSession` at `:451`
- `packages/plugin/src/hooks/magic-context/auto-search-runner.ts` — `AUTO_SEARCH_TIMEOUT_MS = 3_000`
  at `:54`, `unifiedSearchWithTimeout` at `:59`, `collectUserPromptParts` at `:222` (**exported**),
  `hasStackedAugmentation` at `:244` (**exported**), `extractUserPromptText` at `:252`,
  `findLatestMeaningfulUserMessage` at `:268`, `runAutoSearchHint` at `:293`,
  `clearAutoSearchForSession` at `:489`

**Common core.** An eight-function mirror with matching names and a matching timeout constant.
`collectUserPromptParts` and `hasStackedAugmentation` are already `export`ed from the plugin side —
pi holds private copies of two functions it could import today. `auto-search-pi.test.ts` already
imports six symbols from `@magic-context/core/...`, so the import edge exists.

**Differences.** Pi's version carries `DEFAULT_SCORE_THRESHOLD = 0.55` and
`DEFAULT_MIN_PROMPT_CHARS = 20` locally, and adds `appendHintToUserMessage` (`:201`) for Pi's
message shape. The plugin side has `emptyDelivery` / `executeAutoSearchDelivery` (its channel
delivery path) which pi lacks. The message types differ (`UserMessage` vs `MessageLike`).

**Priority signals.**

- **Lockstep: 11 of 12 pi commits (92%) and 11 of 20 plugin commits.** `d765b44c`, `e1c756fb`,
  `88826e12`, `c21d2975`, `c02a8e40`, `53da7806`, `2154ef3a`, `24193207`, `f2ddcce6`, `210b91a1`,
  `b78a643f`. This is the highest lockstep rate measured anywhere in this audit: essentially every
  change to Pi's auto-search required the same change to the plugin's.
- No parity test. `auto-search-pi.test.ts` exercises the Pi side only; it does not drive the
  plugin's `runAutoSearchHint` over a shared fixture the way `tail-hygiene-parity.test.ts` does.

**Est. net LOC delta.** −40 to −60 for the immediate step (import the two already-exported helpers,
share `extractUserPromptText` / `findLatestMeaningfulUserMessage` behind a message-shape adapter,
share the three constants). Larger if the search-and-decide core is extracted, but that requires
reconciling the two message types.

**Execution lane.** Split. **T1:** delete pi's private `collectUserPromptParts` and
`hasStackedAugmentation` and import the exported plugin versions; move
`AUTO_SEARCH_TIMEOUT_MS`, `DEFAULT_SCORE_THRESHOLD`, `DEFAULT_MIN_PROMPT_CHARS` to one module
(under 50 LOC, same language, no behavior change). **T2:** extract the decide-and-hint core behind a
message adapter, gated on a parity test built on the `tail-hygiene-parity.test.ts` pattern.

---

#### X6 — `heuristic-cleanup` and `inject-compartments` twins with no parity anchor

**Clone type:** structural clone with harness-specific extensions.

**Members**

- `packages/pi-plugin/src/heuristic-cleanup-pi.ts:290` `applyPiHeuristicCleanup` (600 LOC) ↔
  `packages/plugin/src/hooks/magic-context/heuristic-cleanup.ts:37` `applyHeuristicCleanup`
  (370 LOC) — 78 shared shingles, first overlap at `heuristic-cleanup-pi.ts:71` ↔
  `heuristic-cleanup.ts:25`
- `packages/pi-plugin/src/inject-compartments-pi.ts` (2448 LOC) ↔
  `packages/plugin/src/hooks/magic-context/inject-compartments.ts` (2958 LOC) — 40 shared shingles,
  first overlap at `inject-compartments-pi.ts:1742` ↔ `inject-compartments.ts:2314`

**Common core.** Both pairs already share their leaf helpers through
`@magic-context/core/hooks/magic-context/*` (`heuristic-cleanup-pi.ts:43-60` imports nine of them).
What remains duplicated is the decision structure: the ordering of cleanup passes, the eligibility
predicates, and the reclaim bookkeeping.

**Differences.** Pi's cleanup is materially larger and adds Pi-only block handling; Pi's injection
diverges on message assembly because the two harnesses' transcript shapes differ. These are
genuine differences, not accidents.

**Priority signals.**

- `inject-compartments`: **11 lockstep commits** (`079f86e2`, `c21d2975`, `80a4623d`, `5f7d6ab3`,
  `210b91a1`, `81c4fb4c`, `62bdb449`, `f5ebc060`, `0415ee89`, `dd52281c`, `bbd330ac`) out of 38
  plugin / 19 pi commits.
- `heuristic-cleanup`: 2 lockstep (`e37f3a62`, `dd52281c`) out of 2 / 3.
- Neither has a parity test. Their `*-pi.test.ts` files import core *helpers and fixtures* but never
  invoke the plugin counterpart, so nothing machine-checks that the two decision structures agree
  where they are supposed to.

**Recommendation.** **Do not unify these.** The size and the real harness differences make a merge
expensive and risky, and the two files are actively changing. Add the missing anchor instead: a
`heuristic-cleanup-parity.test.ts` and an `inject-compartments-parity.test.ts` built on the shape of
`packages/pi-plugin/src/tail-hygiene-parity.test.ts` — one shared fixture, both implementations, the
agreed-upon invariants asserted equal and the harness-specific deltas asserted explicitly. That
converts an 11-commit hand-remembered obligation into a failing test.

**Execution lane.** T2 (test-only change, but it establishes a contract that will constrain future
work in both packages).

---

#### X7 — `ctx_memory` / `ctx_note` tool schemas duplicated across two schema DSLs

**Clone type:** parameterized clone across incompatible DSLs. **Not a consolidation candidate.**

**Members**

- `packages/plugin/src/tools/ctx-memory/tools.ts` — `mutationTokenShape` and `antiMemoryShape`
  built from `tool.schema.*` (`@opencode-ai/plugin`)
- `packages/pi-plugin/src/tools/ctx-memory.ts:35-62` — `MutationTokenSchema` and `AntiMemorySchema`
  built from `Type.*` (TypeBox, via `@earendil-works/pi-coding-agent`)
- `packages/plugin/src/tools/ctx-note/tools.ts:53` ↔ `packages/pi-plugin/src/tools/ctx-note.ts:136`
  — same pattern, 14 shared shingles

**Common core.** The seven mutation-token fields (`tokenVersion`, `publicClaimId`, `revision`,
`contentDigest`, `lifecycleSeq`, `applicabilityHeadsDigest`, `policyHeadsDigest`) and the ten
anti-memory fields (`trigger`, `rejectedStrategy`, `rejectionReason`, plus seven nullable-optional
fields) appear in both, in the same order, with the same optionality. The action lists and the
dreamer-only action set are duplicated too.

**Differences.** The behavioral logic is *already* shared — pi imports
`assertCtxMemoryWriteShape` and `executeCtxMemoryClaimAction` from
`@magic-context/core/tools/ctx-memory/claim-actions` and the descriptions from
`.../ctx-memory/constants`. Only the schema declaration is duplicated, because the two host SDKs
demand different schema builders.

**Priority signals.**

- **Lockstep: 24 commits** — the highest absolute count in this audit — out of 30 pi / 34 plugin
  commits. `269225ee`, `d5910335`, `b5d16905`, `e780870b`, `25f615b0`, `021e884f`, `a33a0f30`,
  `69f10ad7`, `fd978588`, `904b1cc0`, `80a4623d`, `030ad70f`, and twelve more.
- The failure mode is a tool contract skew: a field added to one schema and not the other means the
  model can pass it on one harness and gets a validation error on the other, for the same tool name.

**Recommendation.** Do not try to unify the schemas — two DSLs, two host SDKs. Instead publish one
field/action **spec** in core (a plain `as const` record of field name → kind → optionality, plus
the action lists), build both schemas from it, and add a test asserting each host's compiled schema
exposes exactly the spec's key set with the spec's optionality. That collapses the 24-commit lockstep
into a one-file edit.

**Execution lane.** T2 (touches the model-facing tool contract on both harnesses).

---

### T1 — same-language cross-package helper extraction (under 50 LOC)

---

#### X8 — Historian retry classifier duplicated byte-for-byte across harnesses

**Clone type:** exact (modulo tabs vs spaces).

**Members**

- `packages/plugin/src/hooks/magic-context/compartment-runner-historian.ts:49`
  `MAX_HISTORIAN_RETRIES = 2`, `:653-659` `getHistorianRetryBackoffMs`, `:661-687`
  `isTransientHistorianPromptError`
- `packages/pi-plugin/src/pi-historian-runner.ts:129` `MAX_HISTORIAN_RETRIES = 2`, `:135-141`
  `getHistorianRetryBackoffMs`, `:143-168` `isTransientHistorianPromptError`

**Common core.** ~35 LOC identical: the two-tier backoff
(`retryIndex === 0 ? 2_000 + rand(1_001) : 6_000 + rand(2_001)`), the eight-token non-retryable
deny list (`invalid request`, `bad request`, `unauthorized`, `forbidden`, `authentication`, `auth`,
`" 400"`, `startsWith("400")`) and the nine-token retryable allow list (`429`, `rate limit`,
`timeout`, `econnreset`, `etimedout`, `503`, `502`, `500`, `overloaded`), in the same order with the
same precedence.

**Differences.** None in these three declarations. Pi wraps the backoff with an injectable
`args.retryBackoffMs?.(retryIndex)` override (`pi-historian-runner.ts:258-260`) and its own
`sleepWithAbort` (`:188`); the plugin uses a local `sleep` (`:689`).

**Call sites.** One per harness: the historian retry loop
(`compartment-runner-historian.ts:394-448`, `pi-historian-runner.ts:223-266`).

**Priority signals.** 1 lockstep commit (`e7c8ae7b`, "mason: keep historian tool arcs whole") out of
6 plugin / 7 pi commits. The classifier is a policy table: adding a retryable provider error to one
harness and not the other means one harness retries a transient failure and the other gives up.

**Est. net LOC delta.** −35, plus one shared test for the token tables.

**Execution lane.** T1. Move the three declarations to `@magic-context/core/hooks/magic-context/`
(e.g. `historian-retry-policy.ts`) and import from both. Keep pi's injectable override at the call
site.

---

#### X9 — `getStorageDir()` reimplemented instead of importing the canonical resolver

**Clone type:** exact (two hand-written copies plus one generated mirror).

**Members**

- `packages/cli/src/lib/diagnostics-opencode.ts:249-258` `getStorageDir` — hand-written
- `packages/plugin/src/tui/data/context-db.ts:15-22` `getStorageDir` — hand-written
- `packages/plugin/src/tui-compiled/data/context-db.ts:15-22` — byte-identical generated mirror of
  the above (`packages/plugin/scripts/build-tui.ts:9` writes it; drift-gated by
  `packages/plugin/package.json:40` `check:tui-compiled`). **Not a separate finding** — it is build
  output.
- Canonical: `packages/plugin/src/shared/data-path.ts:198-209` `getMagicContextStorageDir`

**Common core.** `process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")` then
`join(..., "cortexkit", "magic-context")`.

**Differences — and the reason this matters.** The canonical resolver carries two test-isolation
layers the copies lack: `MAGIC_CONTEXT_TEST_DATA_DIR` (`data-path.ts:200-203`) and the
`NODE_ENV=test` backstop (`:204-206`). `data-path.ts:184-193` documents why the backstop exists —
without it, a `bun test` run from a directory lacking the bunfig preload resolves to the real shared
path, "which is how the live DB reached v41". Both copies are exactly that hole: a test that reaches
`diagnostics-opencode.ts`'s doctor path or the TUI's RPC discovery gets the user's live
`~/.local/share/cortexkit/magic-context`.

Both copies also carry a comment pointing at the canonical resolver
(`diagnostics-opencode.ts:252-256`: "See packages/plugin/src/shared/data-path.ts for the canonical
resolver") and then reimplement it anyway.

**Call sites.** `diagnostics-opencode.ts:735`; `context-db.ts:26` (`initRpcClient`). Meanwhile
`getMagicContextStorageDir` is imported correctly by `packages/plugin/src/index.ts:61`,
`packages/pi-plugin/src/index.ts:92`, `packages/cli/src/lib/diagnostics-pi.ts:10`,
`packages/cli/src/commands/migrate.ts:4`, `packages/cli/src/commands/doctor.ts:15`,
`packages/cli/src/commands/doctor-pi.ts:22`, `packages/cli/src/commands/migrate-session.ts:30` — so
the CLI already depends on it and the copy in `diagnostics-opencode.ts` is gratuitous.

**Priority signals.** Lockstep 0; `context-db.ts` 7 commits, `data-path.ts` 2,
`diagnostics-opencode.ts` 1. Ranked on the isolation hole, not churn.

**Est. net LOC delta.** −16, and it closes a test-isolation gap.

**Execution lane.** T1. Import `getMagicContextStorageDir` in both, then regenerate
`tui-compiled` via `bun run build:tui`.

---

#### X10 — e2e harness fixtures duplicated three ways

**Clone type:** exact literal + near-miss interface.

**Members**

- `DEFAULT_MOCK_RESPONSE` — `packages/e2e-tests/src/harness.ts:71`,
  `packages/e2e-tests/src/rust-harness.ts:79`, `packages/e2e-tests/src/pi-harness.ts:34`. All three
  are the identical literal (`text: "ok"`, `input_tokens: 100`, `output_tokens: 20`,
  `cache_creation_input_tokens: 100`, `cache_read_input_tokens: 0`).
- `SdkClient` — `packages/e2e-tests/src/harness.ts:52`, `packages/e2e-tests/src/rust-harness.ts:55`.
  Identical `session.create` / `session.prompt` / `session.messages` signatures; `harness.ts` adds
  `children`, `rust-harness.ts` adds `revert`.
- Overlapping harness options: `TestHarnessOptions` (`harness.ts:29`) /
  `RustTestHarnessOptions` (`rust-harness.ts:34`) share `magicContextConfig`,
  `openCodeConfigExtra`, `modelContextLimit`, `mockDefault` with identical doc comments.
- Also the DB-path joins listed under X2: `pi-harness.ts:52,199`,
  `initialize-context-db.ts:9`, `rust-harness.ts:649`, `harness.ts:313`,
  `opencode-runner/spawn.ts:61`.

**Priority signals.** 4 lockstep commits, one of which (`25945724`) touched all three harnesses.
`rust-harness.ts` 9 commits, `harness.ts` 6, `pi-harness.ts` 4.

**Est. net LOC delta.** −45.

**Execution lane.** T1. Move `DEFAULT_MOCK_RESPONSE`, the shared `SdkClient` core (with per-harness
extensions declared as intersections), and the four shared option fields into
`packages/e2e-tests/src/contract-primitives.ts` (which already exists for this purpose).

---

#### X11 — `PI_CTX_REDUCE_KEEP` duplicates `CTX_REDUCE_KEEP`

**Clone type:** exact constant, already guarded.

**Members**

- `packages/plugin/src/features/magic-context/reclaim-protection.ts:2` `CTX_REDUCE_KEEP = 3`
- `packages/pi-plugin/src/heuristic-cleanup-pi.ts:69` `PI_CTX_REDUCE_KEEP = 3`

**Call sites.** Plugin: `reclaim-protection.ts:17`, `supersession-reclaim.ts:60`. Pi:
`heuristic-cleanup-pi.ts:262`, `tail-hygiene-walk-pi.ts:11,432`.

**Anchor already present.** `packages/pi-plugin/src/heuristic-cleanup-pi.test.ts:259-260` asserts
`CTX_REDUCE_KEEP === 3` and `PI_CTX_REDUCE_KEEP === CTX_REDUCE_KEEP`. So drift is caught. Ranked low
for that reason.

**Est. net LOC delta.** −2 constant, −2 assertions. `heuristic-cleanup-pi.ts` already imports nine
symbols from `@magic-context/core/...`, so replacing the constant with a re-export is trivial.

**Execution lane.** T1, opportunistic — fold into X6 or X8 rather than as a standalone change.

---

#### X12 — Test `StorageDescriptor` fixture duplicated nine times across two crates

**Clone type:** exact, test-only, cross-crate.

**Members** (all construct `StorageDescriptor { module_id: "magic-context-test",
storage_namespace: "mc_cache", isolation: Isolation::Module, backend: Sqlite { path:
dir.join("store.db") } }`)

- `crates/mc-module/src/test_support.rs:13-22` `descriptor` — the canonical one
- `crates/mc-store/src/lib.rs:13937` `descriptor`, `:19426` `store`, `:19986` `store`
- `crates/mc-module/src/transform.rs:13036` `store`
- `crates/mc-module/src/historian.rs:1831` `store`
- `crates/mc-module/src/historian_chunk.rs:1543`, `:1599`
- `crates/mc-module/src/smart_note_evaluation.rs:1230` `open_store`
- `crates/mc-store/tests/claim_intent_ledger.rs:18` `descriptor`

**Priority signals.** This is the 272-shingle cross-crate hit from the Rust clone scan
(`transform.rs:13036` ↔ `mc-store/src/lib.rs:19426`) — inflated because the identical helper appears
inside many `#[cfg(test)]` modules. Lockstep 0. Test-only, low drift consequence (a mismatched
descriptor changes only the test DB path or namespace).

**Blocker.** `mc-module` depends on `mc-store`, not the reverse, so
`mc-module::test_support::descriptor` cannot serve `mc-store`'s own tests. The helper has to move
*down* to `mc-store` behind a `test-support` feature, with `mc-module` re-exporting.

**Est. net LOC delta.** −70 to −90.

**Execution lane.** T1 within `mc-store`; T2 if the dependency-direction change (adding a
`test-support` feature to `mc-store` that `mc-module` enables as a dev-dependency) is in scope.
Coordinate with bead `magic-context-8vi` (mc-core `cache-core` feature decision), which is deciding
adjacent feature-flag policy.

---

#### X13 — `error instanceof Error ? error.message : String(error)` inlined ~180 times

**Clone type:** semantic duplicate of a one-line helper.

**Members.** `packages/plugin/src/shared/error-message.ts:1-3` `getErrorMessage` is the canonical
helper. The literal expression appears inline at roughly 180 non-test sites, concentrated in
`packages/pi-plugin/src/context-handler.ts` (37), `packages/cli/src/commands/doctor-opencode.ts` (10),
`packages/cli/src/commands/doctor-repair-db.ts` (8), `packages/pi-plugin/src/subagent-runner.ts` (7),
`packages/cli/src/commands/doctor-pi.ts` (7), `packages/retina-local-fs/src/path-fence.ts:145`.

**Honest ranking: do not sweep this.** The expression is character-identical everywhere, so there is
no drift risk — the thing a DRY audit exists to prevent is absent. A 180-site mechanical replacement
produces a large, review-hostile diff for zero behavioral benefit and would collide with almost every
in-flight branch. Reported for completeness.

**Recommendation.** Enforce it forward with a lint rule (a Biome/ESLint `no-restricted-syntax`
pattern pointing at `getErrorMessage`) rather than a retroactive sweep, and let the sites convert as
files are touched for other reasons.

**Execution lane.** T1, lint-only. No code sweep.

---

## Cross-language drift-risk table

Cross-language twins are never consolidation findings. Each row names the twin, its members, whether
an anchor exists today, and the recommended anchor.

| Twin | Members | Anchor today | Recommended anchor | Drift risk if unanchored |
|---|---|---|---|---|
| **v2 envelope codec** | `packages/plugin/src/shared/mc-host-client/protocol.ts:13-20` (`PROTOCOL_VERSION`, `HEADER_LEN=21`, `FROZEN_PREFIX_LEN=5`, `MAX_FRAME_BODY_LEN=67_108_864`, 12 frame types, flag bit layout) ↔ `crates/mc-host/src/wire.rs:25,28,32,35` | **Prose spec** `docs/mc-host-wire-protocol.md` §6, with independent literal vectors on each side (`protocol.test.ts:34-35` hex headers; `crates/mc-host/tests/protocol_vectors.rs`). §14.1 (`docs/mc-host-wire-protocol.md:991`) *mandates* the independence. | Keep the independent codecs. Move the literal header/flag vectors into one machine-readable fixture both suites load (the `smart-note-evaluation-golden.json` pattern) so a doc edit cannot leave one side behind. A shared JSON fixture does not violate §14.1 — it imports no production helper. | A header-layout change lands in the doc and one implementation; the other decodes a frame that is no longer the frame on the wire. 5 lockstep commits between `wire.rs` and the doc; `protocol.ts` only 1 — the TS side lags. |
| **Frame body cap, third definition** | `protocol.ts:18` `67_108_864` ↔ `crates/mc-host/src/wire.rs:35` `64*1024*1024` ↔ `crates/mc-shm-transport/src/arena.rs:4` `MAX_FRAME_BYTES = 64*1024*1024` (with `MIN_ARENA_BYTES = MAX_FRAME_BYTES` at `:6`) | None across the three. `packages/mc-shm-native/tests/mechanism.ts:82` restates the equality in a comment. | Add `max_frame_body_len` to `release/mc-host-release.json`; assert `wire::MAX_FRAME_BODY_LEN`, `mc_shm_transport::MAX_FRAME_BYTES`, and the TS constant against it. | The shm arena is sized to hold exactly one maximum frame. Raising the wire cap without raising `MAX_FRAME_BYTES` makes the largest legal frame unreservable. Lockstep 0 — the three have never moved together. |
| **Auth handshake + proof vectors** | `packages/plugin/src/shared/mc-host-client/auth.ts:23-31` (`NONCE_LEN`, `PROOF_LEN`, `MAX_AUTH_MESSAGE_LEN=4_096`, `SERVER_PROOF_DOMAIN="subc-server-v1"`, `CLIENT_AUTH_DOMAIN="subc-client-v1"`) ↔ `crates/mc-host/src/auth.rs:16-20`; `compute_proof` (`auth.rs:141`) ↔ `computeProof` | Doc `:198,205` carries the literal 32-byte proofs; both suites transcribe them independently (`auth.test.ts:21-28`, `protocol_vectors.rs:37-40`) | One shared vectors fixture, as above. | 1 lockstep commit (`fe4be9af`) out of 5 TS / 7 Rust. A domain-string or field-order change on one side fails every handshake; the vectors are the only thing that would catch it, and they are hand-copied. |
| **Handshake deadline semantics** | `packages/plugin/src/shared/mc-host-client/deadline.ts:17-59` (`Deadline`, `remainingMs()` clamps to 0, `stageBudgetMs = min(cap, remaining)`) ↔ `crates/mc-host/src/auth.rs:161-177` (private `Deadline`, `remaining()` **errors** on expiry, `remaining_or_zero()` clamps) | None | Pin the total handshake budget in the release contract and add a test on each side asserting the stage sequence cannot exceed it. | Both sides bound "the whole handshake" but with opposite expiry behavior. If the two totals diverge, one side tears down mid-handshake and the other reports a different failure class. |
| **`CLAIM_MIRROR_VERSION`** | `packages/plugin/src/hooks/magic-context/module-wire.ts:30` `= 1` (rejected at `:396`, `:430`, `:741`) ↔ `crates/mc-store/src/claim_mirror.rs:21` `= 1` (rejected at `:364`, `:414`) | None | Add `epochs.claim_mirror` to the release contract next to the existing `epochs.state_sync` / `epochs.tagger` entries, and assert the Rust constant against it as `COORDINATION_DIRECTORY` already is. | Both sides reject on mismatch, so a one-sided bump is a hard fail-closed outage of claim-mirror sync rather than corruption. 2 lockstep commits (`8ef978a6`, `6925fb1c`). |
| **Claim wire payload types** | `module-wire.ts:36-208` (`ClaimIntentBinding`, `ClaimIntentState`, `ClaimIntentWireRecord`, `ClaimIntentStage/Inspect/Ack Request+Response`, `ClaimEffectDelivery*`, `CommittedClaimMirrorRow`, `ClaimMirrorSnapshot`, `ClaimMirrorReceiptGroup`, `ClaimMirrorLifecycle`) ↔ `crates/mc-store/src/claim_mirror.rs:93` + `crates/mc-module/src/memory_tool.rs:22,112-129` | Names match across languages (good); no field-level contract test found | One round-trip fixture per message: TS encodes → Rust decodes → Rust re-encodes → TS decodes, asserting equality. | Silent field skew on a persisted-and-mirrored payload. Bead `magic-context-0fm` already tracks extracting the shared claims-replay identity/envelope helper — coordinate. |
| **Managed path segments** | `crates/mc-host/src/instance.rs:22,167,178` ↔ `packages/plugin/src/shared/mc-host-lifecycle/paths.ts:27,69,73` ↔ 38 further TS literals | `coordination.directory` **is** contract-sourced (`paths.ts:65`) and Rust-asserted (`crates/mc-module/src/lib.rs:30389`); `cortexkit` / `run` / `magic-context` / `subc-connection.json` are **not** | Extend the existing contract + conformance-test pattern to cover them. See X2. | Two processes coordinate on different roots or look for the connection file in the wrong place. `fe4be9af` already shows `paths.ts` and `instance.rs` moving together by hand. |
| **Smart-note evaluation reducer** | `packages/plugin/src/features/magic-context/smart-notes/evaluation-state.ts:83-86` `evaluationBackoffMs` ↔ `crates/mc-module/src/smart_note_evaluation.rs:355-360` `evaluation_backoff_ms`; plus `dueReadyReason` ↔ `due_ready_reason` with matching UTF-16 truncation | **Anchored.** Shared frozen golden replayed by both (`smart_note_evaluation.rs:1102`, `evaluation-state.test.ts:54`), generator + regeneration-is-a-semantic-change rule in `smart-notes/PARITY.md:16`, generator pins frozen legacy writers so neither reducer is its own oracle | None needed — **this is the exemplar** every other row should copy | Already covered. 2 lockstep commits, one of which (`68063ef3`) correctly touched the golden too. |
| **Release contract** | `release/mc-host-release.json` → `generated-contract.ts:14` + `mc_module::release_contract::RELEASE_CONTRACT_JSON` | **Anchored.** Generator with `--check` drift gate (`generated-contract.ts:2-4`), SHA-256 pin (`:17`), Rust conformance test (`crates/mc-module/tests/release_contract_conformance.rs:17-25`) | None needed — **second exemplar** | Already covered. |
| **`ctx_memory` tool schema** | Two schema DSLs; see X7 | None | Shared field/action spec in core + key-set parity test | 24 lockstep commits. |

---

## TRACKED — do not re-propose

These twins exist because work is in flight. Reference the bead instead of proposing consolidation.

| Twin observed | Bead | Note |
|---|---|---|
| TS ↔ Rust tagger, git-commits ingestion, message index, dreamer scheduler / task bodies / TS-only tasks, embedding pipeline | epic `magic-context-pml` (`.1`–`.7`) | The TS side dies when each port lands. Do not propose unifying. |
| `notes_fts` / trigram / vector retrieval code | epic `magic-context-3q5` (esp. `.31` bigram replacement, `.11`–`.13` mc-vector, `.17`–`.19` lexical/RRF) | Being replaced wholesale. Do not consolidate soon-dead code. |
| `packages/plugin/src/shared/mc-host-client/tcp-frame-channel.ts` ↔ `crates/mc-host/src/tcp_frame_channel.rs` (4 lockstep: `df745a3b`, `26235a6c`, `58f5a431`, `464f3f59`); `transport-negotiation.ts` ↔ `transport_negotiation.rs` (4 lockstep: `35af65f6`, `df745a3b`, `74b1f386`, `464f3f59`); `shm-frame-channel.ts` ↔ shm provider | epics `magic-context-c50`, `magic-context-ymc` | The loopback TCP client path is being replaced by the shm fast path. Twins here are expected. |
| Claims-replay identity / envelope helper across ctx-memory host adapters | `magic-context-0fm` | Already tracked; X-table row above defers to it. |
| Two-step confirmation helper (claim commands, ctx-recomp) | `magic-context-2my` | Already tracked. |
| PID start-time probes (TS e2e reaper ↔ Rust) — observed at `packages/e2e-tests/src/rust-runner/hermetic-mc-host.ts:177,738` | `magic-context-dmv` | Already tracked. |
| Duplicate Synapse hashing / scalar depth scan; duplicate Synapse tokenization | `magic-context-18r`, `magic-context-chj` | Already tracked. |
| Deleted config-parity guard between the two config loaders | `magic-context-1cy` | Directly constrains X1 — sequence the two together. |
| Outgoing-frame byte accounting in `wire.rs` | `magic-context-kp5` | Within `mc-host`; sibling audit's scope. |
| `secure_runtime_dir` / `open_validated_dir` `O_NOFOLLOW` walk | `magic-context-nll` | Within `mc-host`; sibling audit's scope. |
| Nine `hasMemoryClaimsCompatSchema` forks in `storage-memory.ts` | `magic-context-8ss` | Within `plugin/features`; sibling audit's scope. |
| `withPrivilegedWriter` claims capability toggling in `shared/sqlite.ts` | `magic-context-80a` | Within `plugin/shared`; sibling audit's scope. |

---

## Do not unify yet

| Twin | Why to wait | What to do instead |
|---|---|---|
| `inject-compartments-pi.ts` ↔ `inject-compartments.ts` (X6) | 2448 + 2958 LOC, 38 / 19 commits in the window, genuinely different transcript shapes per harness. A merge now would be a large risky change against two actively moving files. | Add `inject-compartments-parity.test.ts` on the `tail-hygiene-parity.test.ts` pattern. |
| `heuristic-cleanup-pi.ts` ↔ `heuristic-cleanup.ts` (X6) | Pi's version is 60% larger with Pi-only block handling; the shared surface is the pass ordering, not the passes. | Add `heuristic-cleanup-parity.test.ts`. |
| `ctx_memory` / `ctx_note` schemas (X7) | Two incompatible host schema DSLs (`tool.schema.*` vs TypeBox `Type.*`). Consolidation is not available. | Shared field/action spec + key-set parity test. |
| Wire codec and auth handshake (drift table) | `docs/mc-host-wire-protocol.md:991` **mandates** independent implementations and independent oracles. Unifying would violate the normative requirement. | Share only the *vectors*, never the code. |
| TCP frame channel and transport negotiation twins | Being replaced under `magic-context-c50` / `magic-context-ymc`. | Nothing. Revisit after the shm cutover. |
| `tui-compiled/` mirror of `tui/` | Build output, not a hand-maintained copy. `packages/plugin/scripts/build-tui.ts:9` writes it and `packages/plugin/package.json:40` `check:tui-compiled` gates drift. | Nothing. Fix the source (`tui/`) and regenerate; see X9. |

---

## Method notes and limits

- **Clone detection** used a 6-line normalized-shingle index (comments, blank lines, and lines under
  12 characters dropped; whitespace collapsed) across `packages/*/src` for TypeScript, and a 7-line
  index across `crates/*/src` for Rust. Shingle counts in this report are shared-shingle counts, not
  LOC. They rank candidates; every reported clone was then read and diffed by hand.
- **Co-change** is measured over the most recent 1500 non-merge commits. The repository squash-merges,
  so a 400-commit window (the originally suggested depth) yielded almost no signal — many entries were
  merge commits with no file list. All lockstep counts here use the 1500-commit window and are
  reproducible with the commit SHAs cited.
- **Not covered.** I found no cross-boundary duplication in log or metric emission: logging is
  genuinely centralized in `packages/plugin/src/shared/logger.ts:61,82` (`log`, `sessionLog`) and
  pi imports it; no metric-emitter helpers were found duplicated across crates.
- **X4 is a code-reading inference**, not a demonstrated exploit. I did not run the scenario.
- Timeout and deadline helpers other than the two `Deadline` types were not found duplicated across
  boundaries; the retry/backoff instances outside X8 (`module-transport.ts:461,1348-1378`,
  `client.ts:292-295,1293-1296,1794-1797`, `notification-socket.ts:128`,
  `project-embedding-registry.ts:3096`, `embedding-synapse.ts:366-367,1800`) are all within
  `packages/plugin` and belong to the sibling audits.
