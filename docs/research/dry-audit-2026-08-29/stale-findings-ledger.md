# Stale-findings ledger — DRY audit remediation (2026-08-29)

Execution branch: `chore/dry-audit-exec-2026-08-29`. Every audit finding was
re-verified against worktree HEAD immediately before application. Findings that
no longer matched were skipped without substitution and recorded here.

## Pre-existing gate failures (baseline, before any change)

Recorded on the untouched worktree at `171ffd3e^` (code identical to
`9c1eb4d1`). Typecheck and both lints are green. The failing suites below are
environment-dependent (mc-host native lifecycle) and fail on the untouched
tree; later gate runs are interpreted modulo this exact set.

- TS (`sh scripts/test-shard.sh packages/plugin`): 31 failures confined to
  `src/shared/mc-host-lifecycle/policy.test.ts` (28),
  `src/hooks/magic-context/module-transport.test.ts` (2),
  `src/features/magic-context/memory/storage-claim-operations-crash.test.ts` (1).
  `pi-plugin`, `cli`, `retina-local-fs` suites: green.
- Rust (`cargo nextest run --workspace --no-fail-fast`): 7 failures —
  `mc-module::lifecycle_cli` (6 tests) and
  `mc-host::shm_transport preflight_matrix_keeps_static_and_dynamic_states_distinct_and_side_effect_free`.

## Held items (bead-check verdicts)

- `seed_workspace_member` (mc-store/src/lib.rs): HOLD — beads 6bd and a7v are
  open and both plan mc-store workspace-member prune/write changes; the seam
  stays.
- `hardware_matches` (mc-shm-transport/src/descriptor.rs): HOLD — ymc.12 is
  in-progress (P1) on the shm transport backend qualification; the descriptor
  predicate stays.

## Stale findings (dropped)

| Finding | Reason |
|---|---|
| features T0-1/CC-4 (storage-meta.ts half) | Gate-narrowed: replacing `storage-meta.ts` with three `export *` lines widens its surface by 45 unintended names (declaration-surface diff). Applied the `storage.ts` half only (+1 blessed name, `PendingSessionCleanupRetryResult`). |
| mc-module T0-2 (test-only `stats` fields) | Stale: four test readers exist at HEAD, not two; `lib.rs` tests also assert `delta_fallback_reason` from the stored stats, and the apply-once path exposes no `cache_stats` alternative. Fields kept. |
| mc-host F3a / F3b / F3d | Premise fails: `harness_closure.rs` is compiled standalone by `tests/harness_closure.rs` via `#[path]`, so it cannot import `crate::instance`. Only F3c (generation.rs `owner_uid` fold) applied. Constraint recorded on bead `magic-context-lmy`. |
| hooks O1 (3 of 21 symbols) | Drifted: `hasLoggedCtxReducePermissionDeny`, `markCtxReducePermissionDenyLogged` (consumed by `transform-postprocess-phase.ts`) and `resetNoteNudgeCooldownOnly` (consumed by `hook-handlers.ts`) now have external consumers; kept exported. |
| docs D2 (`autoresearch-results.tsv`) | Already absent at HEAD; nothing to remove. |
| mc-module T3-3 (full `pub` demotion) | Partially applied: 9 modules demoted warning-free; the remaining modules carry test-only-used items and pml-guarded parity surfaces (the whole `codec/pi` module) whose demotion raises 91 dead-code warnings that cannot be resolved inside a dedup PR without violating guards. Compiler oracle enabled where clean. |
| mc-module T0-3 (historian test prologue) | Partially applied: 4 of the 5 cited prologues were byte-identical and folded into `seed_awaiting_historian`; the fifth had drifted. |
| mc-host F8d (trigger DDL from one list) | Gate-failed: byte-identical DDL cannot be produced from a generated list without hardcoding the existing irregular hand-wrapping, which removes the consolidation value; changing bytes is a migration-lane surface. Skipped. |
| mc-host F12 (`seed_workspace_member`) | Held per U1 verdict (beads 6bd/a7v open). Trio (`load_compartments_after`, `route_index`, `into_charge`) deleted. |
| pi F-1/M1 ("3 constants") | Narrowed: only `AUTO_SEARCH_TIMEOUT_MS` exists on both sides; `DEFAULT_SCORE_THRESHOLD`/`DEFAULT_MIN_PROMPT_CHARS` are Pi-only and stayed local. Shared: `unifiedSearchWithTimeout`, `hasStackedAugmentation`, the timeout constant. |
| tests CC-4a gate (2c XDG semantics) | Deliberate adoption: the canonical `getMagicContextStorageDir` treats an empty `XDG_DATA_HOME` differently (`??` vs `||`) from the deleted copies; adopted the canonical semantics (isolation layers included) per X9's intent. |

## Not executed in this run (no code touched; still open audit work)

- U6 remainder: cross X10 (e2e harness fixtures → `contract-primitives.ts`),
  tests P1–P12 (`test.each` parameterization, 67 tests), tests CC-6/CC-7
  identical members.
- U7 (Wave 3 correctness items 1–10), U8 (remaining ungated T2s), and U10
  (Wave 5 drift anchors) were not attempted; no partial edits exist for them.
  The KTD10/KTD7/KTD11 exclusions below are unaffected.

## Wave review dispositions

- Wave 1: independent fresh-context review (claude CLI, print mode) over
  `b4f75a88..2114cd06`; 20 findings. Fixed in `995e732c`: unused imports,
  dangling doc comments, three comment rewrites that inverted or weakened
  meaning, stale mirror references, benchmark header, docs index link, RSS
  guidance reconciliation, `S_ISVTX` visibility revert, additional stale
  dashboard-consumer comments. Declined: `export *` barrel revert (covered by
  the declaration-surface gate), `issue-135-wire-fixtures.ts` rename (not
  scheduled in Wave 1), `paths.ts` alias collapse (Wave 2c / F-8),
  `mural-selection.ts` file move (beyond minimal edit), auto-search no-op
  deletion (F-22 T2 slice, deferred), `MAX_EMERGENCY_REQUEST_BUDGET` doc
  wording (minor, pre-existing).

## Guarded skips (report scheduled work the guard forbids)

| Finding | Guard |
|---|---|

## Exclusions carried by plan decisions

- KTD10 bead-gated T2 items: C14 (0fm), C15/M9-hooks (80a), F6 mc-host (kp5),
  mc-module T2-3 (q4i), F13a (ymc), F-11/F-12 (c50).
- KTD7: mc-host F9 filed as a bead, not implemented.
- KTD11: tests T2-1 (`project-security.test.ts` deletion) prepared but held for
  human sign-off; file kept.
- KTD8: claim-payload round-trip fixture filed as a bead (0fm-gated).

- Wave 2a (plugin TS T1): independent review over `a993a8ef..24b5f6d2^`;
  8 findings. Fixed in `24b5f6d2`: log-tail drift restored per site, two
  displaced JSDoc blocks, `LEGACY_BASES` harness typing, predicate-const
  rename + bind-order note, helper rename, exhaustiveness-comment reword.
  Declined: `adoptPrimaryIdentity` parameter split (both call sites written
  together), keeping the `_unindexed` forwarder (audit chose the explicit-arg
  fix).
- Wave 2b (crates T1): independent review over the crates diff; 8 findings +
  2 unverified-without-build (both closed by `cargo check --workspace
  --all-targets` green). Fixed in `84f127ef`: const-doc untangling,
  `FirstDivergence`/`PromptSurfacePreset` re-exports for nameability, restored
  mechanism comments (client.rs fatal-stop, build-output explicit args),
  fixture import source + doc reword, `CompactedText` derives + helper
  privatization. Declined: reverting the explicit `use_frozen_unit_index`
  argument (audit's chosen minimal fix).
- Wave 2c (pi/cli T1): independent review over `84f127ef..cccb0b92^`;
  12 findings. Fixed in `cccb0b92`: unused imports (auto-search, tui),
  duplicate redaction import merge, escapeRegex via the CLI barrel, alias-shim
  comment reword, DEDUP_SAFE_TOOLS rationale restored, `formatIds` import
  direction left pointing at the plugin tool module (reviewed as acceptable:
  module is side-effect-free), `hasStackedAugmentation` shim dropped and the
  script importer repointed. Declined/accepted-as-is: XDG empty-string
  semantics (deliberate, ledgered above), NODE_ENV=test mkdtemp backstop (the
  isolation fix X9 exists to adopt), doctor-pi TOCTOU edge (pre-existing
  class), `typeof` dep types, structural inspection type in db-maintenance.

## Bead count reconciliation

Wave 4 filed 15 beads (10 T3-class + 5 stale-docs): `vo1` (McHandler split),
`j23` (apply_once decompose), `p5m` (runHistorianRebuildLoop), `j4z`
(compactionOff pipelines), `d5l` (mc-store modules), `lmy` (leaf fs layer),
`456` (redaction contract), `awe` (claim round-trip fixture, 0fm-gated),
`q84` (F9 error-type consolidation), `9a4` (pi F-5 ignored-filter bug);
`1t0` (STRUCTURE.md), `trm` (ARCHITECTURE.md), `lpn` (fixture pins), `aaq`
(decisions README), `lmv` (context-window-geometry). Hygiene: closed `8ss`
(zero `hasMemoryClaimsCompatSchema` hits re-verified); append-only comments
on `nll` (6 walk members + predicate duplicate + the `#[path]` constraint)
and `rnq` (piolium not digest-pinned; land with incident-pool tests). The two
conditional beads (shared model-pinning, source-trust lost-call) were not
filed: their triggering units (U7 step 9 fallback, U8 T2-5 resolution) did
not run.

## Second execution run (resume)

Resumed at `2c9e8db9`; this section records the U6-remainder and U7 work.

### Completed

- U6 remainder (commit `bc1570bc` + review fixes): X10 harness fixtures,
  tests P1–P12 `test.each` parameterization (row-per-test, counts preserved),
  CC-6 identical members, CC-7 identical members (`createCountingPi`,
  `assistantMessages`, `makeSeededGitCommit`).
- U7 item 1 — F1 facade CAS divergence (`9ea829d0`): shared `*_tx` functions,
  McStore mutation-neutral semantics canonical (archaeology: facade copied
  2026-07-23 in `22d45928`; the McStore fix landed 2026-08-19 in `336aa9b3`
  and never reached the facade — drift, not intent). Facade-path regression
  test observed red (ready reset to pending) before the fix. Outcome recorded
  on bead 3q5.8.
- U7 item 2 — pi F-3 (`a1ba3f0f` step 1, `8a151f6c` step 2): shared
  code-point stringify + shared isRecord + cross-leg hash parity test
  (observed red); then structural extraction of the hash/memo/prefix core
  into `tail-hygiene-memo.ts`. New bug bead filed from review: dreamer
  `claim-manifest.ts` batchId still sorts with `localeCompare`.
- U7 item 3 — M3/X1 (`dda646cd`): six-fixture cross-loader parity test
  (green before unification, per the plan's gate), one shared
  `parseConfigJsonc` (comment-json) behind both loaders and the CLI config
  readers, sanitizer tightened to flag any non-plain prototype,
  experimental-absence schema assertion added; bead 1cy commented and closed.
- U7 item 4 — tests CC-1 (`49645553`): 18 historian classifiers (the 13
  audited `isHistorianRequest` + 3 `isHistorian` + `tool-loop.ts` +
  `compaction-off.test.ts`) unified on union semantics in
  `cache-analysis.ts`, marker wired into the production-signature drift pin,
  unit tests per input shape. Coordination note appended to bead 4t7.
- U7 item 5 — mc-module T2-1 (`73338bdb`, `0551c5d6`): see stale note below;
  retention invariants pinned by tests on the boundary-token and
  tag-baseline members.

### Stale findings (dropped) — this run

| Finding | Reason |
|---|---|
| mc-module T2-1 self-eviction bug (5 unguarded caches) | Premise fails at the audit's own HEAD `9c1eb4d1`: all six members carry a pre-insert budget guard (`retained_bytes > max → refuse`), and with `remove()`+`push_back` ordering the newcomer alone always fits, so the eviction loop can never pop the just-inserted session. No fix needed; invariant pinned by new tests instead. |
| X10 destination (`contract-primitives.ts`) | That module is the fail-closed artifact-validator home, not a fixture home; consolidated into a new `harness-primitives.ts` leaf instead. |
| CC-6 "(sessionId) variants" fold | The two `(sessionId)` variants have drifted schemas (NOT NULL columns, AUTOINCREMENT part, `createDirectTestDatabase` delegation) and are not identical members; only the 4 byte-identical `(dataHome)` copies were folded. |

### Narrowings and residuals (open audit work, exact resume point)

- U7 remaining, in plan order: item 6 features T2-2 (embedding singleton
  lane), item 7 X4+X2 (fence + contract extension), item 8 X3 (doctor
  migration), item 9 shared T2-3 (conflict-warning senders), item 10 tests
  CC-2 (16 `session_meta` DDL sites — re-verified heterogeneous: most sites
  create several sibling tables beside `session_meta`, so each needs per-site
  judgment before `createDirectTestDatabase` adoption).
- X1 orchestration unification (one `loadMagicContextConfig` with harness
  injection, est. −350..450 LOC) remains open BEHIND the now-landed parity
  gate; the load-bearing parser divergence is fixed.
- T2-1 `SessionLruCache<E>` consolidation remains open; review found a
  seventh family member (`TransformSnapshotCache`, lib.rs ready-LRU) the
  audit table missed.
- U8 (ungated non-correctness T2s), U10 (Wave 5 drift anchors), and the U11
  final-review/PR tail were not attempted this run.
- Grammar note (X1): comment-json rejects raw U+2028/U+2029 inside string
  values that JSON.parse accepted, and accepts BOM/NBSP whitespace it
  rejected; judged small and net-favorable in review. A primitive-valued
  `__proto__` key is silently dropped by comment-json construction (no
  warning), unlike the old own-key path; prototype safety is unaffected.

### Pre-existing failures observed this run (verified failing at base, not caused by this branch)

- `packages/e2e-tests` incident-unit: `src/incident-pool/evidence.test.ts`
  (18) — `verifierFromCommand` cannot resolve `cargo test -p
  mc-shm-transport` mutation commands introduced by `35555157`.
- `packages/e2e-tests/src/historian-eval/promote.test.ts` (1) —
  whole-tree byte-identity case, environment-dependent.
- `packages/plugin` `bun test src/shared/` directory-run interference (28,
  incl. `data-path.test.ts` members green in isolation); the pinned shard
  gate shows only the recorded 31-failure baseline.
- Rust full gate this run: 1 failure (`lifecycle_cli
  full_dev_mode_lifecycle_roundtrip`), a strict subset of the recorded
  7-failure baseline.

### Review dispositions — this run

- U6 remainder: two fresh-context CLI reviews; fixed unused import, cron
  Sunday-intent comment, OMO release note, `makeSeededGitCommit` rename;
  declined import-line style nit. `undefined/` stray artifact noted
  (pre-existing, untracked, untouched).
- F1: fixed ctx_note caller trimmed-compare divergence, dead conjunct,
  facade changed-condition test tail. All three review findings applied.
- F-3: fixed empty-arguments toolInput parity, dead ternary, comment
  overstatement; extracted `contentSignature`/`safeStableStringify` per
  review; declined type-ownership move and `memoizedContent` API narrowing
  (behavior-neutral follow-ups); TAG_PREFIX copies outside the walks left
  (out of finding scope). Aliased-array `[Circular]` note recorded
  (pre-existing shared-helper behavior, parity holds).
- X1: fixed vacuous pollution assertions (per-source outcome + warning
  needles), inert grammar fixture, unswitched CLI readers, comment nits;
  strengthened test caught and documented the combined-vs-per-source
  outcome contract.
- CC-1: fixed marker drift-pin wiring, JSON.stringify system-shape
  narrowing, two residual copies, stale comment; declined
  system-marker-first hardening (recorded as unit-test comment instead).
- T2-1: fixed charge derivation, duplicate eviction pin, import placement,
  Arc qualification; seventh-member note carried to the residual above.

## Third execution run (resume #2)

Resumed at `0dce37bf`; this section records the U7 items 6–10 work.
U7 (Wave 3 correctness items) is now complete.

### Completed

- U7 item 6 — features T2-2/CC-3 (`e59eb07f`): deleted the dead
  module-global embedding lane (memory/embedding.ts singleton, incl. the
  hardcoded synapse 8192 that bypassed `normalizeSynapseTokenBudget`);
  `embedQuery`/`isEmbeddingRuntimeEnabled` are now required on
  `UnifiedSearchOptions`. Red evidence: tsc enumerated every defaulting
  site (a test-including tsc probe verified the error set returned to
  baseline modulo line shifts). Unique provider-identity tests moved to
  embedding-openai.test.ts; cosine tests to cosine-similarity.test.ts.
- U7 item 7 — X4 + X2 (`9b2031fe`): path-fence honors XDG_DATA_HOME and
  HOME only when absolute AND still fences the cwd-relative tree the
  permissive storage resolver would write to (union of candidate roots;
  three fence tests observed red first). Release contract gained a fixed
  `layout` section (managed_subtree/runtime_directory/connection_file/
  storage_subdirectory) with generator validation (mutation tests
  observed red first), Rust consts, a generated retina-local-fs module,
  and an mc-module conformance test binding contract values to
  mc_host::MANAGED_DIR_NAME / RUNTIME_DIR_NAME (new) /
  CONNECTION_FILE_NAME and DEFAULT_MODULE_ID. TS resolvers, e2e
  harnesses, and plugin scripts now compose managed paths through
  contract-derived helpers (`storageSubtreePath` added to data-path.ts).
- U7 item 8 — X3 (`2b28e149`): CLI doctor wraps the shared
  `migrateDreamerV2` with a recursive comment-preserving graft.
  16-fixture cross-copy parity test observed green before the swap
  (characterization gate); canonical-coverage test pins every
  `CANONICAL_DREAMER_TASKS` member in doctor output; comment-preservation
  test pins JSONC comments at three depths.
- U7 item 9 — shared T2-3 (`e078bbce`): the four hand-rolled
  conflict-warning senders route through `sendIgnoredMessage`. Blocker
  check passed: `isMidTurn` fails open to not-mid-turn on an unreadable
  DB, so the primary path was taken — the T1-2 fallback and its
  conditional model-pinning bug bead were not needed. Three tests
  observed red first (mid-turn deferral, prompt-context pinning,
  markSeen deferral); toast-direction mapping and positive markSeen also
  pinned.
- U7 item 10 — tests CC-2 (`b4a0be33`): 13 fixtures adopted
  `createDirectTestDatabase` (incl. the pi-plugin site and the cas-race
  first-composes/second-plain two-handle pattern); command-handler's
  dead IF-NOT-EXISTS blocks deleted. Deferred as deliberate fixtures:
  cli migrate-session (legacy-schema migration source), clone-session
  (OpenCode session-DB half + narrow context columns are the point of
  its assertions), recover-benchmark-candidates (pre-existing-failing
  ledgered file; its context half is adoptable once that baseline is
  fixed).

### Pre-existing failures newly verified at baseline (not caused by this branch)

- `bun run test:release` / `release:qualify:check` / `release:payload:check`
  fail identically at the pre-change baseline: `Cannot find package
  'typescript'` from `scripts/qualify-mc-host-production-inputs.ts`
  (environment; the generate-manifest suite and
  `release:contract:check` are green).
- `bun test src/shared/` directory-run interference: 28 failures at both
  baseline and post-change HEAD (already ledgered); the touched lifecycle
  files pass in isolation.

### Narrowings and residuals (this run)

- X2 residual literals (deliberate, outside the data-layout contract):
  config-home `cortexkit` segments (migrate-config-location.ts, hermetic
  fixtureConfigRoot), drive-preseed's rig-specific `ckdev-rig/runtime`
  segments (its managed prefix + connection filename now derive from the
  contract), and the fence-local `plexus`/`claustrum`/`staging` segments.
- CC-2 sibling drift outside the finding's member list (same defect
  class, keyed on other tables): `tools/ctx-note/tools.test.ts` `notes`
  copy, `storage-source.test.ts` `source_contents` NOT NULL drift,
  `storage-ops.test.ts` exact `pending_ops` duplicate.
- features T2-2 review observations recorded, not applied (would change
  the audit-approved contract): a registry-backed `embedQuery` default
  and folding `isEmbeddingRuntimeEnabled` into `embeddingEnabled`;
  memory/embedding.ts barrel remains as the audit's scope fence (two
  import paths to the registry surface).
- shared T2-3 review residual: `CONFLICT_WARNING_MARKER` duplicates the
  first line of `formatConflictShort` (pre-existing; single-sourcing it
  is a follow-up).
- X1 orchestration unification and the T2-1 `SessionLruCache<E>`
  consolidation remain open as previously ledgered.

### Review dispositions — this run

- Item 6: 8 findings; applied test rehoming (incl. unique secret-identity
  tests), stub consistency, pure-indirection removal, barrel comment
  reword; declined the two contract-shape alternatives and the barrel
  deletion (scope fence), and the shared test-stub hoist (independent
  test oracles).
- Item 7: 10 findings; applied the union-of-roots fence fix (MAJOR) with
  its new red test, HOME absolute-only, owner.ts helper reuse, retina
  biome exclusion for the generated file, STORAGE_SUBDIRECTORY ↔
  DEFAULT_MODULE_ID bind, drive-preseed partial derivation, generator
  contract passing, annotation drop; declined moving the conformance
  test file (kept beside the coordination sibling) and the
  benchmark-tag-queries HOME fallback change (behavior preservation).
- Item 8: 5 findings; applied recursive comment-preserving graft (MAJOR)
  with a JSONC comment test (MAJOR), dead-branch removal + Object.hasOwn,
  changed-flag assertion tightening, comment rewording.
- Item 9: 9 findings; applied disposition-gated auto-remove, TUI-gate
  comment reword, duplicate-bound correction, two toast-direction tests,
  positive markSeen test, afterEach cleanup, fence pre-send log;
  declined the marker single-sourcing (pre-existing, ledgered above)
  and the flush-path guard cap (pre-existing helper behavior).
- Item 10: 8 findings; applied docblock fix, retrospective context-half
  adoption, cas-race busy_timeout + mechanism comment, local-variable
  cleanup, and ledger-reason corrections for the deferred sites;
  recorded the sibling-drift residual above.

### Exact resume point

- U8 (plan): remaining ungated non-correctness T2s in `MERGED.md` §6
  item 11 dependency order (features CC-1(b/d) → features T2-3 → tests
  CC-3/CC-4/CC-5 → pi F-7/F-8 → M10 → shared T2-2 → hooks C13 → C16 →
  C17/C18 → mc-module T2-2/T2-4; T2-5 fork resolution; KTD10/KTD7/KTD11
  exclusions unchanged), then U10 (Wave 5 anchors, awe-bead fixture
  excluded), then U11 (ledger finalization, full final-HEAD gate,
  comment-policy sweep over the branch diff).

## Fourth execution run (resume #3, interrupted) + final run (resume #4)

The fourth run landed five U8 commits, then was cancelled mid-C13. The final
run recovered C13 and closed out the branch.

### Completed — U8 (both runs)

- features CC-1(b/d) (`c63bc0c7`): shared child-session fetch
  (`child-session-spawn.ts`) and provider-failure rethrow
  (`provider-output-failure.ts`) helpers across 11 dreamer/mural/sidekick/
  smart-notes/user-memory callers.
- features T2-3 (`9c21acdf`): frozen-set CAS writers merged through a widened
  `casUpdateJsonArrayColumn` (`IS ?` retained).
- pi F-8 (`6fbb64c0`): CLI pure-forwarding path aliases collapsed onto their
  implementations.
- M10 (`b10513a0`): project embedding registration control flow
  single-sourced; pi-plugin bootstrap delegates to the plugin implementation.
- shared T2-2 (`47865008`): migration comparator backed by the shared JSONC
  strip pipeline, with a 120-line differential test before the swap.
- hooks C13 (`c7b10e99`, recovery): the module wire `method` union declared
  once (`ModuleAuthorityMethod` / `ModuleMethod` / `ModuleStateSyncMethod` in
  `module-wire.ts`); transport `call`, `authorityRequest`, and the state-sync
  client interface all point at it. Recovery review caught two defects in the
  interrupted edit: (1) `"authority.drain_flip"` had been dropped from the
  union (live method — Rust dispatcher `mc-module/src/lib.rs:12276`); restored
  as a direct `ModuleMethod` member since the authority helper never carried
  it. (2) The type-level subset test lived in a `*.test.ts` file that tsc
  excludes and `bun test` type-strips (inert); the compile-time guards moved
  into `module-wire.ts` source where `tsc --noEmit` checks them.
- Lint restoration (`0f03c42d`): the five interrupted-run commits had landed
  with format/import-order lint failures in 17 files; mechanical fix, no
  behavior change.
- features T2-5 (`1d4bd4cb`): fork resolved empirically to the
  absorbed-into-args reading — `hasExplicitUserEvidence` enforces the
  origin-revision-only rule from closed bead `m3t` (regression test at
  `storage-claim-policy.test.ts:592-612` observed), every production mint
  passes `sourceTrustClass` explicitly or defaults `model_inference`, and no
  rewrite path retains a row's `source_type`. `source-trust.ts` + test
  deleted; the conditional lost-call bug bead was not needed.
- hooks C16 (`768e98f5`): per-run drain-cap trio folded into
  `PER_RUN_CAP_TIERS`; five boundary tests (tier edges at 80/95, per-term
  regimes, monotone no-shrink property, out-of-domain fallback) written and
  observed green against the old implementation first.
- hooks C17+C18 (`e5333a59`): `resolveOrdinalsForModule` takes a
  `ModuleOrdinalMemo` bundle projected once by `ordinalMemoOf(state)` (call
  sites collapse 4×9 fields); the two `buildTransformBody` calls share a
  hoisted `transformBodyBase` with `fullArrayFingerprint` deliberately
  per-site (the retry rebuilds `pendingWireCache` first). Reviewer verified no
  hoisted source mutates between the two builds.
- tests CC-4 (`de7c731d`): the five drifted fake-peer frame helpers (incl.
  `bodyJson`, added on review) consolidated into
  `test-support/fake-peer.ts`; `sendErrorBody` standardized on the
  extra-field superset (default `{}` keeps the transport suite's error frames
  byte-identical). No assertion removed (TRACKED shb honored).

### Wire-sensitivity evidence

`bun run test:rust-e2e` on this host fails a fixed 15-test environment set
(mc-host native lifecycle / historian / failure-drill classes; recorded in
run logs). Three full runs — after C13, after C17/C18, after CC-4 — produced
byte-identical failure sets (diff-verified), and the C13 diff is type-only
(erased at runtime), so no wire regression is attributable to this branch.

### Final-HEAD full gate (U11)

- `bun run typecheck`: green. `bun run lint`: green. `bun run lint:rust`:
  green.
- `scripts/test-rust.sh`: 1391/1393 pass; 2 failures
  (`mc-host::lifecycle delayed_lifecycle_callback_runs_shutdown_once_…`,
  `mc-host::shm_transport unavailable_outranks_capability_mismatch_…`) are
  load-dependent timeout flakes in the recorded mc-host environment class —
  both pass in isolation (verified this run); no Rust code changed on this
  branch since the recorded baseline.
- `sh scripts/test-shard.sh packages/plugin`: 31 failures = the recorded
  31-failure baseline (isolation re-check: `policy.test.ts` 28,
  `module-transport.test.ts` 2, `storage-claim-operations-crash.test.ts` 1;
  the shard run redistributes 9 policy-class environment failures into
  `paths.test.ts` via the known directory-run interference — `paths.test.ts`
  is fully green in isolation).
- pi-plugin (793), cli (387), retina-local-fs (26): all green.
- Comment-policy sweep over `git diff main...HEAD` code paths: no tracking,
  temporal, or review-narration comments added by this branch.

### Dropped-stale — these runs

None. (The two C13 recovery defects were errors in the in-flight edit, not
stale audit findings.)

### Residuals — cut under the final-resume budget rule (complete list)

U8 items not executed, still open audit work:

- tests CC-3: `useTempDataHome`/teardown factory consolidation (31 + 17
  copies, est. −410 LOC) into `shared/test-support/temp-data-home.ts`.
- tests CC-5: e2e mock-provider body/session helpers (~15 copies, est. −120
  LOC) into `cache-analysis.ts` / `pi-harness.ts` / `scripted-tool-call.ts`.
- pi F-7: `logs-opencode.ts`/`logs-pi.ts` issue-bundling consolidation with
  the asymmetric-redaction decision; logs-pi test first per plan.
- mc-module T2-2: the two publication fences (predicate + string delta).
- mc-module T2-4: historian producer-failure handling in the drive loop
  (preserve the `cancellation_confirmed_stopped` asymmetry).

U10 (Wave 5 drift anchors) skipped entirely per the final-resume provision:
all §7 anchors remain open (v2 envelope vectors fixture, `max_frame_body_len`
contract entry ×3, auth handshake/`computeProof` vectors, handshake deadline
budget pin, `epochs.claim_mirror` entry + Rust assert, X7 `ctx_memory`
schema spec, X6 parity tests; claim-payload round-trip fixture stays
bead-gated per KTD8). New sibling from C13 review: nothing pins the TS
`ModuleMethod` union against the mc-module Rust dispatch arms — the
`drain_flip` drop would have been caught by exactly such an anchor; fold into
the U10 work when it runs.

Carried residuals from earlier runs (unchanged): X1 orchestration
unification (parity gate landed); T2-1 `SessionLruCache<E>` consolidation
(7 members incl. `TransformSnapshotCache`); CC-2 sibling drift
(`notes`/`source_contents`/`pending_ops` copies); shared T2-3
`CONFLICT_WARNING_MARKER` single-sourcing; X2 residual literals; features
T2-2 review observations. KTD10/KTD7/KTD11/KTD8 exclusions unchanged; tests
T2-1 deletion still awaits human sign-off.

Workspace notes: the two stale top-level strays named in the resume brief
(`docs/research/.beads-guard.txt`, `docs/research/MERGED.md`) were deleted;
the other untracked top-level `docs/research/*.md` duplicates and the
`undefined/` test-artifact directory predate this run and were left
untouched (not offered for cleanup).

### Review dispositions — final run

- C13 recovery: 2 HIGH (drain_flip drop; inert type test), 1 MEDIUM
  (comment citing a nonexistent test), 2 LOW (import order; dead constraint
  prose) — all applied.
- T2-5: verification-detail review, no findings; deletion confirmed safe on
  all three trace questions.
- C16: 1 LOW (fallback tests) + 2 nits (comment wording, catch-all
  duplication) — tests and wording applied; the `?? last-tier` fallback kept
  alongside `minUsagePercentage: 0` because `find` still types as
  `T | undefined` and NaN fails every `>=`.
- C17/C18: 1 LOW applied (ModuleOrdinalMemo aliasing sentence: the resolver
  mutates `entries` in place — pass the live Map, never a copy).
- CC-4: 1 MEDIUM applied (`bodyJson` moved too), 1 LOW applied
  (`routeChannel`/`routeEpoch` rename + header-vs-body doc).
