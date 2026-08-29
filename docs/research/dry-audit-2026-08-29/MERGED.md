# DRY + code-reduction audit — MERGED synthesis (2026-08-29)

Merged from 9 reports in `docs/research/dry-audit-2026-08-29/` against HEAD `9c1eb4d1`.
Bead guard: `.beads-guard.txt` (107 open issues). Read-only; only this file was written.

---

## 1. Headline numbers

### As reported, per tier (before dedup)

| Tier | Findings | Est. net LOC | Sources (findings / LOC) |
|---|---:|---:|---|
| **T0** | 74 | **−1,105** | features 21/−300 · hooks 16/−137 · shared 9/−62 · mc-module 4/−219 · mc-host 9/−220 · pi/cli 9/−85 · tests 6/−82 |
| **T1** | 68 | **−2,189** | features 9/−215 · hooks 11/−200 · shared 7/−155 · mc-module 7/−339 · mc-host 10/−420 · pi/cli 6/−215 · tests 12/−465 · cross X8–X13 6/−180 |
| **T2** | 52 | **−4,292** | features 6/−480 · hooks 6/−154 · shared 3/−83 · mc-module 4/−435 · mc-host 6/−760 · pi/cli 11/−355 · tests 9/−1,300 · cross X1–X7 7/−725 |
| **T3** | 11 | **−285 quantified** + large structural | features 2 · hooks 2/−180 · mc-module 3 · mc-host 3/−60 · pi/cli 1/−45 |

### After cross-report dedup (§2)

- 10 canonical merges; **−141 LOC of double-counting removed** (M1 −40, M2 −32, M3 −24, M8 −45); mc-host **F4 (−150) reclassified TRACKED** (bead `nll` owns it).
- **Deduped actionable totals: T0 −1,105 · T1 ≈ −2,135 · T2 ≈ −4,055 · T3 ≈ −285+structural.**
- **Deletable now (T0+T1): ≈ −3,240 LOC** across ~140 findings, all compiler/test-verifiable, no design pass.
- T0–T2 grand total ≈ **−7,300 LOC** (≈1.2 % of the ~600k-LOC audited surface; every report independently notes this is a low-duplication codebase — the value is concentrated in ~15 high findings, several of which are correctness fixes).

### Docs-KB (from docs-md.md — separate axis, not LOC)

111 tracked `*.md`, 1,335 KB. **DELETE** 6 tracked files (1.9 KB) + 1 untracked stray (0.8 KB) · **CONSOLIDATE** 4 files (19.1 KB) · **MOVE** 1 (10.2 KB) · **STALE-CONTENT** 7 files (166 KB, keep+fix) · KEEP 100. Recoverable ≈ 41.7 KB (3.1 %); the real docs debt is the 166 KB of load-bearing-but-wrong content in `STRUCTURE.md`/`ARCHITECTURE.md`.

### Guard buckets

- **TRACKED (bead-guarded)**: 44 consolidated rows (§5) across ~38 distinct beads; ≈2,600 LOC of code protected from deletion.
- **Do-not-unify-yet**: **41** findings (features 6, hooks 5, shared 4, mc-module 3, mc-host 7, pi/cli 6, tests 4, cross 6) — §4.4.

---

## 2. Cross-report dedup — canonical merged findings

| ID | Merges | Canonical statement |
|---|---|---|
| **M1 AUTO-SEARCH** | pi F-1 **≡** cross X5 (+ pi F-5, F-20/21/22 satellites) | `auto-search-runner.ts` ↔ `auto-search-pi.ts`: 8-function mirror, **92 % lockstep (11/12 commits)** — highest in repo. Two plugin helpers pi copies are already exported. Split: T1 (import exported helpers + share 3 constants, −40) then T2 (decide-and-hint core behind message adapter, gated on a parity test). Satellite **correctness bug** F-5: Pi dropped the `ignored`-filter the plugin comment documents as a fixed bug — file as bug, not DRY. Est. −50 net. |
| **M2 HIST-RETRY** | pi F-2 **≡** cross X8 | `isTransientHistorianPromptError` + `getHistorianRetryBackoffMs` + `MAX_HISTORIAN_RETRIES` byte-identical in `compartment-runner-historian.ts:653-687` ↔ `pi-historian-runner.ts:135-168`. 0 co-change = no mechanism keeps the retry policy in agreement. T1, exact clone, structural codemod, **−35**. |
| **M3 CONFIG-LOADER** | cross X1 **⊇** plugin-shared T1-3/T1-7 (LoadOutcome ×2) **⊇** pi F-4 (`collectEmptyStringPaths` IDENT at same line number, `isPlainObject` ×3) | Two hand-maintained loaders for one config file, **different JSONC parsers** (regex-strip vs `comment-json`), 4/7 + 4/5 lockstep, one lockstep commit was a **security fix written twice** (`c5145a9c` prototype-pollution). Parity guard was deleted; bead **1cy** tracks its replacement. T2 correctness/security. Est. **−400** (incl. the T1-3/F-4 leaf slices). Sequence with 1cy. |
| **M4 NOFOLLOW** | mc-host F4 **≡** bead **nll**, extended | The `O_NOFOLLOW` component-walk exists **6×**, not the 2 the bead names. TRACKED — extend `nll` with: `instance.rs:414`, `connection_file.rs:252`, `harness_closure.rs:1034`, the `generation.rs:363/:387` relative walks, and the predicate duplicate `harness_closure.rs:1085 verify_safe_ancestor` ≡ `instance.rs:774 is_safe_ancestor` (that predicate collapse is the separable T0 slice, in mc-host F3). Do not file new work. |
| **M5 DASH** | pi F-23 + docs-md S7 + tests TRACKED(tzu) + plugin-shared clean-sweep | Dashboard-removal leftovers (beads **mpy/rnq/tzu**): 6 stale comments in pi/cli (F-23, −3), AUDITOR.md + AUDIT-KNOWN-ISSUES entries citing deleted code (S7, rnq — retire in place), `dream-task-token-telemetry.test.ts` fate (tzu). plugin-shared verified its scope clean. One sweep, comment edits safe now; rnq edits must land with incident-pool tests (see §5 hygiene: piolium is NOT digest-pinned). |
| **M6 ERRMSG** | plugin-shared T1-5 **≡** cross X13 | `getErrorMessage` re-spelled ~190× repo-wide (~28 in shared scope; `tool-registry.ts` imports it and re-spells it 13 lines apart). Expression is character-identical everywhere → zero drift risk. **Lint rule only** (`no-restricted-syntax`), no retroactive sweep. ~0 LOC. |
| **M7 SHA256** | features CC-18/DNU-2 **≡** pi F-18 | 15 `createHash("sha256")` wrappers under 6 names repo-wide. Domain-named wrappers are **persisted digest protocols** — share only the mechanical primitive or nothing. Defer as one repo-wide item (−12 in features scope; ~−45 repo-wide, not free). |
| **M8 STORE-FIXTURE** | mc-host F10/T-1 **⊂** cross X12 | `StorageDescriptor` test fixture ×9 across mc-store + mc-module. Canonical: X12 — move helper *down* into mc-store behind the existing `test-support` feature; mc-module re-exports. T1 in mc-store, T2 if the dev-dep feature wiring counts. **−80** total (F10's −45 is the mc-store slice). Coordinate with bead 8vi (adjacent feature-flag policy). |
| **M9 TXN-IMMEDIATE** | features T1-5 (`runImmediate` ×3) + T1-6 tail + T2-4 (wrapup lease) + hooks C15 (×4, + 2 more in `compartment-storage.ts`) | One family: hand-rolled `BEGIN IMMEDIATE`/finally-ROLLBACK ceremony, ~9 sites across features/ and hooks/. No existing helper (`db.transaction()` is deferred-BEGIN — must stay distinct). Shared home `shared/sqlite.ts`. Hooks slice and any `withPrivilegedWriter` interaction **sequenced after bead 80a**. Features T1-5 slice is safe now (−33); wrapup lease (T2-4, −30) and hooks C15 (−24) need the typed-abort result shape. |
| **M10 EMBED-BOOTSTRAP** | plugin-shared T2-1; **checked against cross-subsystem: no overlap found** (X1 is the config *loader*; this is embedding *registration*) | `ensureProjectRegisteredFromOpenCodeDirectory` ↔ `…FromPiDirectory`: identical control flow, 5 shared lockstep commits, and two *different* hot-path fixes (Pi stat-memoizes; OpenCode uses a `setTimeout(0)` yield). T2, near-miss, structural, **−25** + a memoization decision. Related: plugin-shared T1-6 (`resolveEmbeddingRouting` async-with-no-await drives the workaround). |

No other same-root-cause overlaps found beyond these (hunted: format-bytes shims, storage-dir resolvers (X9 stands alone), escapeRegex (pi F-10 owns all copies incl. the plugin-shared one), tail-hygiene (pi F-3 only)).

---

## 3. Verification corrections (spot-checked at HEAD by this synthesis)

| # | Claim | Check | Result |
|---|---|---|---|
| V1 | plugin-features CC-4: `storage.ts:104-213` re-lists storage-meta's exports (−215) | Read `storage.ts:100-219` | **PASS** — explicit `export { …108 names… } from "./storage-meta"` block occupies exactly :104-213 (110 lines); `export *` idiom already used elsewhere in the same file (`:240`). |
| V2 | mc-host F9: 84 hand-written Display+Error+From blocks, no thiserror (−570) | `rg thiserror` all Cargo.toml → 0; counted impls in the 5 scope crates | **PASS** — 38 `impl Display` + 36 `impl Error` + 10 `impl From<…>` = **exactly 84** blocks; no `thiserror` anywhere in the workspace. |
| V3 | mc-module T1-1: boundary.rs ↔ historian_chunk.rs 13 byte-identical helpers (−157) | Diffed `compact_text_for_summary` at `boundary.rs:1883-1910` ↔ `historian_chunk.rs:1074-1101` | **PASS** — byte-identical (28 lines); `merge_commit_hashes` follows at the cited next lines in both files, consistent with the drift claim. |
| V4 | tests CC-2: 15 hand-rolled `CREATE TABLE session_meta` DDL copies | `rg 'CREATE TABLE (IF NOT EXISTS )?session_meta' -g '*.test.ts'` | **PASS with annotation** — 15 files match, but **16 sites**: `recover-benchmark-candidates.test.ts` has two DDLs (`:65`, `:739`). The report *undercounted* by one site; estimate unchanged or slightly larger. |

Nothing dropped. V4 annotated in the finding below.

---

## 4. Priority bands

Legend: **corr** = correctness fix disguised as dedup (do first). Lane: text / structural / typed-semantic (t-sem) / design.

### 4.1 HIGH

| ID | What | Tier | Clone | Lane | LOC | Source |
|---|---|---|---|---|---:|---|
| **F1** ⚠corr | mc-store `FacadeMutationTxn` ↔ `McStore` note write path **already semantically diverged**: facade's `update_note_cas` fires artifact-invalidation + claim-fencing on unchanged conditions the McStore comment explicitly forbids. Decide intent, then extract `*_tx` functions; add the missing both-paths test. Fold into 3q5.8. | T2 | near-miss+semantic | t-sem | −170 | mc-host F1 |
| **M3** ⚠corr | Config loaders plugin↔pi: divergent JSONC parsers + security fix applied twice by hand. Restore parity test (bead 1cy) first. | T2 | structural | t-sem | −400 | cross X1, shared T1-3, pi F-4 |
| **M1** ⚠corr | Auto-search plugin↔pi, 92 % lockstep; + F-5 Pi-side ignored-filter regression (file as bug). | T1+T2 | near-miss | t-sem | −50 | pi F-1, cross X5 |
| **CC-1(tests)** ⚠corr | `isHistorianRequest` ×13 in e2e, **drifted oracle** (6 have the `<new_messages>` short-circuit, 7 don't) — weaker copies misclassify historian requests. Unify in `cache-analysis.ts` with union semantics; coordinate with bead 4t7. | T2 | near-miss | t-sem | −190 | tests CC-1 |
| **T2-1(mc-module)** ⚠corr | Six session-keyed byte-budget LRU caches; **5 of 6 lack the self-eviction guard** `ProjectionCache` has — an oversized insert can evict itself. Fix asymmetry as a correctness question, then consolidate to one `SessionLruCache<E>`. | T2 | structural | t-sem | −120 | mc-module T2-1 |
| **T2-2(features)** ⚠corr | CC-3: singleton embedding lane (`memory/embedding.ts:44-225`) is a dead fork that **already diverged** (hardcoded 8192 bypasses `normalizeSynapseTokenBudget`). Delete the fork; make `embedQuery`/`isEmbeddingRuntimeEnabled` required options. Aligned with 3q5.25/pml.4, not blocked. | T2 | near-miss | t-sem | −160 | features T2-2 |
| **F-3(pi)** ⚠corr | Pi `safeStableStringify` hand-rolled with **`localeCompare`** — shared `stableStringify` docstring forbids exactly this; feeds the tail-hygiene content signature. Also array-accepting `isRecord`. Step 1 = correctness swap + test; step 2 = extract fnv1a32/memo helpers. | T2 | semantic | t-sem | −65 | pi F-3 |
| **X4** ⚠corr | `retina-local-fs` path fence resolves relative `XDG_DATA_HOME` permissively while the daemon rejects it → fence root can diverge from the protected files. Reject relative, derive layout from X2's contract. Code-reading inference, not a demonstrated exploit. | T2 | semantic | t-sem | ~−10 | cross X4 |
| **X3** ⚠corr | `migrate-dreamer-v2` re-implemented in the CLI doctor (on-disk writer), spec comments stripped, **0 co-change** — next CANONICAL task added will be silently written as disabled in the user's real config file. Wrap the shared in-memory migration. | T2 | near-miss | t-sem | −205 | cross X3 |
| **T2-3(shared)** ⚠corr | 4 hand-rolled session-prompt senders in `conflict-warning-hook.ts` bypass hardened `sendIgnoredMessage`: no mid-turn gate, no model pinning → each post can silently switch the user's model and bust prefix cache. Verify `isMidTurn` fail-open at boot first; else fall back to local T1-2 extraction (−60) + file the pinning bug. | T2 | semantic | struct+t-sem | −80 | shared T2-3 (T1-2 alt) |
| **CC-2(tests)** | 15 files / **16 sites** (V4) of hand-rolled `session_meta` DDL, column counts 8→42 — silently-stale schema mirrors. Adopt `createDirectTestDatabase()` (117 files already do). | T2 | parameterized | t-sem | −330 | tests CC-2 |
| **A1(hooks)** | recomp ↔ partial-recomp runners: **85 % co-change (17/20)**, born as a copy. Design pass: shared `runHistorianRebuildLoop(deps, plan)`; absorbs C5 + C8. | T3 | structural | design | −120 | hooks A1 |
| **CC-4(features)/T0-1** | storage barrel double-maintenance (V1): highest co-change ratio in features audit (30/63). `export *` swap gated on a `tsc` declaration-surface diff. | T0* | exact | text+gate | −215 | features CC-4 |
| **X7** | `ctx_memory`/`ctx_note` schemas across two DSLs, **24 lockstep commits** (highest absolute). Not unifiable — publish one field/action spec in core + key-set parity test per host. New code, not deletion. | T2 | parameterized | t-sem | ~0 | cross X7 |
| **X6** | inject-compartments + heuristic-cleanup twins (11 lockstep): **do not unify** — add parity tests on the `tail-hygiene-parity.test.ts` pattern. New code. | T2 | structural | test-only | ~0 | cross X6 |

### 4.2 MEDIUM

| ID | What | Tier | Clone | Lane | LOC | Source |
|---|---|---|---|---|---:|---|
| F9 | thiserror adoption, 84 blocks (V2). Dependency decision first; crate-by-crate, mc-store first, snapshot `to_string()` before/after. | T2 | structural | t-sem | −570 | mc-host F9 |
| T1-1(mc-module) | `chunk_text.rs` extraction, 13 exact + 3 drifted helpers (V3); module-private, rustc-verified. | T1 | exact | text | −157 | mc-module T1-1 |
| T2-3(mc-module) | Chunked-staging state machine ×3 coordinators + inline 4th (484-LOC handler). Extract only the inline copy first, byte-for-byte checks/codes; **after bead q4i**. | T2 | structural | t-sem | −250 | mc-module T2-3 |
| CC-1(features) | Dreamer child-session turn, 4 nested clone families, 11 sites, 23/105 co-change; length-cap check already missing in one member. Sub-clones (b)+(d) safe now; (a)+(c) scoped around pml.2/.3. | T2 | param | struct | −155 | features CC-1 |
| T2-3(features) | CAS-merge-string-set ×3 beside the existing generic `casUpdateJsonArrayColumn` — widen the allow-set. Cross-process CAS; keep `IS ?` semantics. | T2 | param | t-sem | −45 | features T2-3 |
| F2a+F2b | mc-store lineage-descent commit tail ×3 (41 lines byte-identical ×2 + 3-line variant). | T1 | exact/near | struct | −70 | mc-host F2 |
| F8a–F8d | mc-store SQL consolidation (17-column SELECT ×5 — positional row mapper; NOTE column lists; trigger `json_object` ×2). F8d needs migration-lane byte-identical DDL gate. | T1 | exact | text/struct | −58 | mc-host F8 |
| F11/T-2 | `TransformCommit` 20-field literal ×10 in tests → `base_commit()`. | T1 | param | struct | −105 | mc-host F11, tests |
| M8 | StorageDescriptor fixture ×9 → mc-store `test-support`. | T1/T2 | exact | struct | −80 | mc-host F10, cross X12 |
| CC-3(tests) | `useTempDataHome`+teardown, 31+17 copies (18 byte-identical) → one shared test-support helper. | T2 | exact | struct | −410 | tests CC-3 |
| CC-4(tests) | Wire-framing peer helpers ×2, `sendErrorBody` already drifted → `fake-peer.ts`. Sensitive (wire); after/with kp5 awareness. | T2 | near-miss | struct | −59 | tests CC-4 |
| CC-5/6/7(tests) | e2e mock-provider helpers (~15), `createOpenCodeDb` ×13 (fold identical 6), pi mock + `seedClaim` family. | T1/T2 | exact/near | struct | −260 | tests CC-5–7 |
| P1–P12(tests) | 12 table-shaped clusters → `test.each` (67 tests, excluding narrative suites). | T1 | param | struct | −473 | tests §5 |
| T1-1(shared) | `mc-host-lifecycle/index.ts` barrel: 85 re-exports, 8 consumed. Internal-only surface (exports map blocks deep imports). | T1 | structural | t-sem | −70 | shared T1-1 |
| T2-2(shared) | `stripJsoncForParse` re-implements `jsonc-parser.ts`; behind the migration refuse-and-warn gate — differential test before swap. | T2 | semantic | t-sem | −58 | shared T2-2 |
| X2 | Managed-data-root: 4 resolvers disagree on relative `XDG_DATA_HOME`; 38 hardcoded `"cortexkit"` sites. Extend release contract + conformance test (pattern exists), then sweep. Pairs with X4. | T2 | semantic | t-sem | −60 | cross X2 |
| X9 | `getStorageDir` copies lack the test-isolation backstop that once let a test hit the live DB. Import canonical resolver; regen tui-compiled. | T1 | exact | text | −16 | cross X9 |
| X10 | e2e harness fixtures ×3 (`DEFAULT_MOCK_RESPONSE`, `SdkClient`, options) → `contract-primitives.ts`. | T1 | exact | struct | −45 | cross X10 |
| C13/C14 | Module method union ×3 declarations; claim-RPC interface members duplicated. Extract types (helps pml); **C14 after 0fm**. | T2 | structural | t-sem | −75 | hooks C13/C14 |
| C17/C18 | rust-mode-transform state forwarding ×4 and body-build ×2 (wire-sensitive; object-argument refactor). | T2 | param | t-sem | −45 | hooks C17/C18 |
| F-6(cli) | Diagnostics historian-dump types+fns: one implementation wearing two type names (107 lines, single-token diffs). Alias shim keeps it non-breaking → treat as T1. | T1 | param | t-sem | −95 | pi F-6 |
| F-13(pi) | Historian deps literal ×6 in pi index — boot/runtime pairs must stay consistent or `/ctx-recomp` uses a stale budget. Keep purely mechanical (pml/c7t adjacency). | T1 | structural | struct | −60 | pi F-13 |
| F-7/F-15/F-16/F-17/F-14(cli) | logs/doctor/db-maintenance leaf helpers; F-7 is redaction-adjacent — land after/with F-19 decision, give `logs-pi.ts` a test first. | T1/T2 | mixed | struct | −115 | pi F-7,14–17 |
| F-8(cli) | `paths.ts` 7 pure-forwarding exports (two names, one body, twice). Exported ⇒ T2. | T2 | structural | struct | −28 | pi F-8 |
| F-11/F-12 | Release-gate TOML scanner ×3 + platform capability table ×3; both behind existing `release:*:check` gates; coordinate with c50. | T2 | near/exact | struct/text | −32 | pi F-11/12 |
| T2-2/T2-4(mc-module) | Publication fences (predicate+string param) and producer-failure tails (must preserve `cancellation_confirmed_stopped` asymmetry). | T2 | param/near | t-sem | −65 | mc-module T2-2/4 |
| F6(mc-host) | Wire envelope header prologue ×3 — **after/with kp5** only. | T2 | near-miss | struct | −25 | mc-host F6 |
| F13a | mc-shm `Debug`-via-`Display` + redaction shims ×18 → two macros; redaction tests as gate; after ymc quiesces. | T2 | exact | struct | −55 | mc-host F13a |
| T2-1(tests) | Delete `pi-plugin/config/project-security.test.ts` (fully subsumed, cited line-by-line) — security boundary ⇒ human sign-off. | T2 | subsumed | t-sem | −57 | tests T2-1 |
| M9 | BEGIN-IMMEDIATE family (see §2). Features slice now; hooks slice after 80a. | T1/T2 | exact/struct | struct | −87 | features T1-5/T2-4, hooks C15 |
| M10 | Embedding-bootstrap plugin↔pi twin + memoization decision. | T2 | near-miss | struct | −25 | shared T2-1 |

### 4.3 LOW

| ID | What | Tier | Lane | LOC | Source |
|---|---|---|---|---:|---|
| Wave-1 T0 bulk | All dead exports / pure forwarders / dup helpers / comment fixes across all reports (features T0-2/3, hooks D1–D14+C1+O1, shared T0-1..9, mc-module T0-1/2/4, mc-host F3/F12/C1–C5, pi F-20..27, tests T0-1..6) | T0 | text/t-sem | −1,105 | all |
| features T1-2/3/4/7/8/9 | SQL predicate/projection hoists, row-type shares, small clones | T1 | text/t-sem | −165 | features |
| hooks C2–C11 | event-handler/record-limit, forwarding blocks, session-dir resolution (×3, exact), marker-advance, ctx passthroughs | T1 | struct/t-sem | −191 | hooks |
| shared T1-2/4/6 | conflict-warning local helper (if T2-3 blocked), legacy-path table, de-async decision | T1 | struct | −80 | shared |
| mc-module T1-2..T1-6, T0-3 | TransformResponse base(), forwarder collapse, codec json.rs, caveman predicate, entry-point visibility, historian test fixture | T0/T1 | struct/text | −330 | mc-module |
| mc-host F5/F7 | generation walk pair (keep `NONBLOCK`), client-side frame_read wrappers only | T1 | struct/text | −40 | mc-host |
| F-9/F-10(pi) | ctx-note/ctx-reduce helpers incl. user-facing pagination string; escapeRegex export | T1/T0 | struct/text | −22 | pi |
| X11 | `PI_CTX_REDUCE_KEEP` — already drift-guarded by a test; fold into M1/M2 change | T1 | text | −4 | cross |
| M6, M7 | getErrorMessage lint rule; sha256 primitive share (defer) | T1 | lint/defer | ~0 | shared/cross/pi |
| D2(mc-host) | generation/harness_closure **leaf** filesystem helpers only (ENOSPC classification folds in); not the stores | T3 | struct | −60 | mc-host D2 |
| F-19(cli) | diagnostics-pi parallel redaction stack — **design pass, route to security review** (which side's contract is right?) | T3 | design | −45 | pi F-19 |
| A2(hooks) | `compactionOff` 137 scattered guards → two composed pipelines; do for legibility or not at all; confirm with issue-#266 owner | T3 | design | −60 | hooks A2 |

### 4.4 Do-not-unify-yet (41 findings — kept split, with reasons)

| Bucket | Items | Reason class |
|---|---|---|
| **Load-bearing duplication** | features DNU-1 (schema DDL literal is the audit artifact), DNU-2/3 (persisted digest/normalization protocols), shared DNU-2 (`fake-peer` independent oracle), mc-host raw_client oracle (§14.1 mandates independence), mc-host conserves/SpanPlan twins, mc-core string-enum codecs, cross wire-codec/auth (doc **mandates** independent impls — share vectors only) | Independence or byte-exactness is the point |
| **Deliberately different quantities/policies** | hooks token estimators ×3, hooks transform.ts session-dir cache policy, hooks ReferenceCompartment contract, pi collectUserPromptParts / findLatestMeaningfulUserMessage (host-shaped), cli doctor-* bodies (similarity 0.03–0.19), cli adapters | Distinct contracts wearing similar shapes |
| **Active epic / volatile** | shared DNU-4 + kp5 send-outcome trio, hooks import lists (pml), mc-shm backend pair (ymc — design trait once), TCP/negotiation twins (c50/ymc), mc-module DNU-3 traits (c50.11 adds 2nd impl), tui-compiled (generated, drift-gated) | Being rewritten; consolidation = churn |
| **Young + ambiguous** | features DNU-4 `source-trust.ts` (zero-ref but closed bead m3t may make it live policy — trace before delete), DNU-5 git-anchors (bead 3q5.40), DNU-6 verify.ts staging blocks (flag-plumbing to unify) | Resolve intent first |
| **Payoff too small / readability cost** | mc-module DNU-1 (309 `.lock().expect` — real issue is lock order, T3-1), DNU-2 ParsedCompartment (serde wire risk for −16), hooks buildClaim*WireBody, features whitespace normalizers ×11, tests CC-8 harness bootstrap + rust beforeEach (knobs are semantic), tests DND-2 skip ledger, DND-3 source-text tests (churn below threshold), DND-4 dup pairs (consolidate, don't delete), inject-compartments/heuristic-cleanup merges (X6 → parity tests instead) | Cost > benefit |

---

## 5. TRACKED consolidated table

One row per bead (code items merged). **Do not remove any of this code; reference the bead.**

| Bead | What code | Report(s) |
|---|---|---|
| 3q5.40 | `storage-claim-applicability-schema.ts` replay-guard/seed surface (113 LOC, zero-ref); `git-anchors/*` (460 LOC, test-only) | features TRACKED-1/-3 |
| 3q5.8/.9/.10 | `memory/relocate-memory.ts` (361 LOC); mc-store note-write surface (F1 lands inside this cutover) | features TRACKED-2, mc-host F1 |
| 3q5 (U7–U10) + cjs | `mc-core/claim_operation.rs` digest-contract surface (looks dead; pinned against the shared TS golden fixture) | mc-host |
| cjs | `recordDispositionEventInCurrentTransaction` (TS, storage-claim-policy.ts:212) — no Rust analogue; guard satisfied | mc-host |
| 62w | `__resetArtifactRevalidationThrottleForTests` seam | features TRACKED-4 |
| 2my | Two-step confirmation blocks (claim commands + ctx-recomp dialog state machine) | features TRACKED-5, hooks TR1 |
| 0fm | Claims-replay identity envelope ×3 (`storage-claim-autonomous.ts`); hooks C14 client-interface side **sequenced after** 0fm; cross claim-wire payload row defers to it | features TRACKED-6, hooks TR2, cross |
| pml.1–.7 | `dreamer/task-executor.ts` base-args + dispatch; module wire method unions will churn; TS tagger/dreamer/embedding/message-index twins die when ports land; `handle_dreamer_run_task` + `tag_*` family | features TRACKED-7/T3-1, hooks, mc-module TRACKED-4, cross |
| 80a | `shared/sqlite.ts` export visibility + `withPrivilegedWriter`; prerequisite for hooks C15 / M9 hooks slice | shared, hooks |
| kp5 | `wire.rs:384-507` ByteBudget/ByteCharge; F6 sequenced after; TS transport-provider send-outcome trio moves with it; tests CC-4 tagged | mc-host, shared, tests |
| nll | O_NOFOLLOW walk family — **extend bead to 6 members + predicate dup** (M4) | mc-host F4, cross |
| 89q | `LifecycleTransactionLock` + `NamespaceAnchor` | mc-host |
| 8vi | mc-core `cache-core` feature (on-by-default, gates 6 re-exports, untested off) — decision is the bead's; X12/M8 coordinates | mc-host, cross |
| q4i + a7v + 6bd | `acked_watermarks` wire field; `ModuleWorkspace*Wire`; T2-3 staging extraction after q4i; `seed_workspace_member` (mc-store, dead **unless** 6bd/a7v write members from Rust — check first) | mc-module TRACKED-1, mc-host |
| x84 + 658 | `memory_render.rs` `MirroredClaimMemory(Error)` typed variants = future decision channel | mc-module TRACKED-2 |
| c50 (+.1/.9/.11/.12) | `ck-mc-host` bin error-block ×9 + cmd prologues; qualify/manifest/payload/closure-qualification scripts + drive-rig; subc evidence docs + spike plan (MOVE, not delete); `runtime.rs`/`handler.rs`/`config.rs` comments carry bead IDs (fix text, keep code) | mc-module TRACKED-3, pi, docs-md, mc-host C1–C4 |
| 1l7 | Resident-byte ceiling default (same lifecycle path as c50) | mc-module |
| ymc (+.12) | mc-shm backend pair (no trait yet — design once); `hardware_matches` (dead-looking, **verify vs ymc.12 before delete**); rpc-* family; `docs/mc-host-shm-transport.md` | mc-host D3/F13b, shared, docs-md |
| mpy / rnq / tzu | Dashboard follow-ups = **M5**: AUDITOR.md + AUDIT-KNOWN-ISSUES retire-in-place; pi/cli stale comments; `dream-task-token-telemetry.test.ts` fate | docs-md S7, pi F-23, tests, shared |
| c7t | `piolium/**` (M1 finding is the open P1's source; citation still resolves); F-13 dreamer-config threading adjacency | docs-md, pi |
| dmv | PID start-time probes; `paths.ts` edits stay clear; rust-* e2e fixture consolidation deferred to it | pi, tests, cross |
| 1cy | Config-parity guard replacement — **directly constrains M3/X1**; sequence together | cross, tests |
| shb | Historian-producer decode coverage must be restored, never reduced — CC-4 removes no assertions; trimming those suites is forbidden | tests |
| fds/lmp/wxf/4t7/dha/5ts | Flaky/failing tests are tracked bugs; nothing deleted for flakiness; CC-1 lands only in coordination with 4t7 | tests |
| mwx | Rust workspace test coverage in CI; F1's missing both-paths test cross-references it | mc-host, tests |
| 18r / chj | Duplicate Synapse hashing/tokenization — elsewhere; no finding raised | mc-module, cross |
| 1or | `frames_until_corr` — not in mc-module; no finding | mc-module |
| 8ss | *(stale — see hygiene below)* | features, hooks, shared, cross |
| 3q5 epic (docs) | `docs/specs/prompt-surface/**` (ratified, sha256-pinned); perf docs (ll1/bux/qm0/a9p/u51/nlw/z00/ds8); PARITY.md ledgers (pml) | docs-md |
| m3t (closed) | `memory/source-trust.ts` — zero-ref, but the closed bead asserts its rule is live policy; trace the rewrite path before deleting (features T2-5) | features |

### Bead hygiene: updates the tracker needs

1. **Close `8ss` as stale.** `storage-memory.ts` was deleted in `f4ee5460`; `rg hasMemoryClaimsCompatSchema` → zero hits repo-wide. Three reports independently confirmed. (features, hooks, shared)
2. **Extend `nll`** from 2 walk members to **6** + the `verify_safe_ancestor` ≡ `is_safe_ancestor` predicate duplicate (M4). The bead as written misses the *creating* walk in `harness_closure.rs`.
3. **Correct `rnq`'s premise**: piolium is **not** digest-pinned, and `source-inventory.json` stores no digest literals for AUDITOR.md / AUDIT-KNOWN-ISSUES — `evidence.ts:430,438` hashes live bytes. Edits need no digest-regen step but change every derived claim digest; land with the incident-pool tests in one change. (docs-md)
4. **File the two actively-false comments** at `storage-claim-applicability-schema.ts:557-562` and `:615-618`: they cite a caller and `migrations-v85/-v82.test.ts` files that **do not exist**. The code is TRACKED (3q5.40) but the comments should be corrected now, independently. (features T0-3)
5. **Record the PROMOTABLE_CATEGORIES cross-language trap**: `memory/constants.ts:37` (also `V2_MEMORY_CATEGORIES`, `CATEGORY_PRIORITY`) has zero TS callers but is **parsed out of TS source text** by `crates/mc-module/src/memory_render.rs:515` — deleting it breaks a Rust parity test. Any dead-code tooling must allowlist these. (features)
6. **Resolve `source-trust.ts` vs closed `m3t`** before any deletion: either the rule was absorbed into explicit `sourceTrustClass` args (delete file+test) or a rewrite path lost its `liveRewriteSourceType()` call (file a bug). (features T2-5)
7. Smaller: `seed_workspace_member` — check 6bd/a7v before delete; `hardware_matches` — check ymc.12; drive-rig `run.sh` pins `mc-drive:1.18.3` vs closures at 1.18.22 — flag for refresh with c50; `foldInfraEnabled` is a dead gate with a misleading skip message and `parity-findings-s2.md:15` is false at HEAD — coverage decision for the e2e owner (adjacent 4t7); consider `package.json` entries for `run-mc-host-closure-qualification.ts` and the pi perf experiments so liveness is legible.

---

## 6. Suggested execution order

### Wave 1 — high-priority T0 (auto-executable, ≈ −1,105 LOC)

All T0 items, independently landable per report scope: dead exports + orphaned callees (features T0-2, hooks D1–D14, shared T0-1..7, mc-module T0-1/2, mc-host F3a–d + F12 confirmed-dead trio, pi F-22 `_resetAutoSearchCache`, tests T0-1..5); comment fixes (features T0-3 incl. hygiene item 4, hooks tickets/temporal, shared T0-8, mc-module T0-4, mc-host C1–C5, pi F-20/21/24/25, M5 comment slice); mechanical renames (tests T0-6 `test-utils.test.ts` → `test-utils.ts`); de-export sweeps (hooks O1, shared T0-9 minus sqlite.ts, pi F-27, tests over-exports). **Gate:** CC-4 barrel swap needs its `tsc` declaration diff; hold the 2 bead-check dead items (`seed_workspace_member`, `hardware_matches`).

### Wave D — docs/md (small, parallel to Wave 1)

- **DELETE:** `packages/e2e-tests/mutations/fm-oc-{1..6}.md` (loader is `.json`-only; not digest-pinned; zero inbound). `rm` untracked `autoresearch-results.tsv` (all 7 rows merged).
- **MOVE:** `2026-08-17-0505-subc-api-surface-spike-plan.md` → **`docs/plans-archive/`** (tracked; `docs/plans/` is gitignored and would silently untrack it) + update the one citation in `docs/subc-api-surface-inventory-2026-08-17.md:5` in the same commit. TRACKED(c50.1).
- **CONSOLIDATE:** synapse-tail landing docs into per-epoch `report.md` + `docs/perf/runs/README.md` index (carry the warmup re-analysis); r4 perf trio → round-4 canonical (fixes the stale 64→256 MiB constant, S3); add `docs/README.md` index (C3).
- **STALE-CONTENT → beads (proposed):** "STRUCTURE.md: fix 6 verified-wrong claims (main.rs, cache-policy/, backfill-embeddings, migrations exemplar, workspace layout, subc)"; "ARCHITECTURE.md: resolve subc self-contradiction + add mc-shm-transport"; "prompt-surface fixture docs: add source-revision pins (S4)"; "specs/prompt-surface decisions README: reflect ratified status (S5)"; "context-window-geometry: reword subc milestone (S6)". S7 belongs to rnq (M5).

### Wave 2 — T1 in 3 sub-waves by file ownership (no shared files across sub-waves)

- **2a — plugin TS (`features/` + `hooks/` + `shared/`+`config/`+`plugin/`):** features T1-1..T1-9 (incl. M9 features slice); hooks C2–C11; shared T1-1 (barrel), T1-3 slice via M3-prep (move `LoadOutcome` to a leaf now), T1-4, T1-2-or-T2-3 decision. ≈ −650.
- **2b — crates:** mc-module **T3-3 visibility tightening first** (turns dead-code detection into a compiler gate), then T1-1 chunk_text (V3), T1-2..T1-6, T0-3 fixture; mc-host F2, F5, F7 (client side), F8a–d (F8d behind the DDL byte-identity gate), M8/F10, F11. ≈ −900.
- **2c — pi-plugin/cli/scripts/e2e + cross-package T1:** M2 historian-retry; M1 T1-slice; pi F-9/F-10/F-13/F-14/F-16/F-17, F-6 (alias shim); X9, X10, X11; tests P1–P12 + CC-6/CC-7 identical members. ≈ −900.

### Wave 3 — T2 per finding, correctness-labeled first

1. **F1** (mc-store CAS divergence — decision, then `*_tx` extraction, then both-paths test; fold into 3q5.8)
2. **pi F-3 step 1** (localeCompare/isRecord swap + test) and **file pi F-5 as a bug**
3. **M3/X1** (config loader — with 1cy parity test first)
4. **tests CC-1** (isHistorianRequest union — with 4t7)
5. **mc-module T2-1** (self-eviction fix as its own commit, then `SessionLruCache`)
6. **features T2-2** (delete singleton embedding lane)
7. **X4** (fence relative-XDG rejection) paired with **X2** (contract extension)
8. **X3** (doctor wraps shared migration + both-paths test)
9. **shared T2-3** (isMidTurn boot verification, then reroute; else T1-2 fallback + pinning bug)
10. **tests CC-2** (session_meta → createDirectTestDatabase, 16 sites)
11. Then non-correctness T2s in dependency order: features CC-1(b/d) → features T2-3 → tests CC-3/CC-4/CC-5 + T2-1 deletion (human sign-off) → F-6/F-7 (+logs-pi test first)/F-8 → M10 → shared T2-2 (differential test) → hooks C13 → C16 (cap tests first) → C17/C18 → mc-module T2-2/T2-4 → **gated:** C14 (after 0fm), C15/M9-hooks (after 80a), F6 (after/with kp5), mc-module T2-3 (after q4i), F13a (after ymc quiesces), F-11/F-12 (with c50), F9 (dependency decision, then mc-store first).

### Wave 4 — T3 filed as beads (proposed titles)

1. "mc-module: split `impl McHandler` (8,520 LOC) into `handlers/<family>.rs` — pure moves" (T3-1)
2. "mc-module: decompose `transform.rs` `apply_once` (2,476 LOC) by pass stage" (T3-2; sequence vs pml)
3. "hooks: design `runHistorianRebuildLoop` shared by recomp/partial-recomp (85 % co-change)" (A1 — **high priority**)
4. "hooks: `compactionOff` — two composed pipelines instead of 137 scattered guards" (A2; confirm with issue-#266 owner)
5. "mc-store: extract `notes` + `schema` modules from lib.rs (20,650 LOC); record remaining 8 seams on 3q5.28" (D1)
6. "mc-host: shared leaf filesystem layer for generation/harness_closure (incl. ENOSPC classification parity)" (D2)
7. "cli: redaction contract for shareable issue bundles — security review of the diagnostics-pi parallel stack" (F-19)
8. "repo: drift anchors from cross-subsystem table (§7) — wire/auth vectors fixture, frame-cap contract entry, claim-mirror epoch entry, claim-payload round-trip fixture, X7 tool-schema spec, X6 parity tests" (new-code proposals)
9. Stale-docs beads from Wave D.

**Backlog (no wave):** all LOW items not swept in Waves 1–2, M6 lint rule, M7 sha256, and the entire do-not-unify list (§4.4).

---

## 7. Cross-language drift-risk table (from cross-subsystem.md)

**New-code proposals — contract tests and spec anchors, not deletions.** The repo already has three working anchor patterns (generated contract + `--check`; shared frozen golden; shared fixture replayed by both) — these rows apply them where missing.

| Twin | Members | Anchor today | Recommended anchor |
|---|---|---|---|
| v2 envelope codec | `mc-host-client/protocol.ts:13-20` ↔ `mc-host/src/wire.rs:25-35` | Prose spec + hand-copied vectors (§14.1 mandates independent impls) | One machine-readable vectors fixture both suites load; never share code |
| Frame body cap ×3 | `protocol.ts:18` ↔ `wire.rs:35` ↔ `mc-shm-transport/arena.rs:4` | None (comment restates equality) | `max_frame_body_len` in release contract, asserted on all three |
| Auth handshake + proofs | `auth.ts:23-31` ↔ `auth.rs:16-20`; `computeProof` twins | Doc literals hand-transcribed into both suites | Shared vectors fixture |
| Handshake deadline | `deadline.ts:17-59` ↔ `auth.rs:161-177` (opposite expiry behavior) | None | Pin total handshake budget in contract + per-side stage-sum test |
| `CLAIM_MIRROR_VERSION` | `module-wire.ts:30` ↔ `claim_mirror.rs:21` | None (both fail closed) | `epochs.claim_mirror` contract entry + Rust conformance assert |
| Claim wire payload types | `module-wire.ts:36-208` ↔ `claim_mirror.rs` + `memory_tool.rs` | Name parity only | Round-trip fixture (TS encode → Rust decode → re-encode → TS decode); coordinate 0fm |
| Managed path segments | `instance.rs` ↔ `paths.ts` ↔ 38 TS literals | `coordination.directory` is contract-anchored; `cortexkit`/`run`/`magic-context`/`subc-connection.json` are not | Extend the existing contract + conformance pattern (X2) |
| Smart-note reducer | `evaluation-state.ts` ↔ `smart_note_evaluation.rs` | **Anchored** (frozen golden + PARITY.md) — the exemplar | None needed |
| Release contract | `release/mc-host-release.json` → both languages | **Anchored** (generator + `--check` + SHA pin + conformance test) | None needed |
| `ctx_memory` tool schema | Two schema DSLs (X7) | None | Shared field/action spec in core + key-set parity test per host |

---

## 8. Decision menu

Five approvals unlock everything above:

1. **Approve Wave 1 + Wave D deletes/moves?** (T0 ≈ −1,105 LOC + 7 doc files + 1 move; auto-executable, per-report verification already done; two dead items held for bead checks.)
2. **Approve Wave 2 sub-waves 2a/2b/2c?** (T1 ≈ −2,100 LOC; disjoint file ownership; 2b starts with the mc-module visibility tightening; three named gates: CC-4 tsc diff, F8d DDL byte-identity, F-6 alias shim.)
3. **Approve the correctness-first T2 list (Wave 3 items 1–10)?** These are bugs wearing dedup clothing: F1 facade CAS, pi localeCompare hashing, config-loader parser split, drifted historian-request oracle, LRU self-eviction, dead-but-diverged embedding lane, fence root, doctor migration fork, un-pinned session posts, drifted schema mirrors. Each needs a per-finding reviewer.
4. **File the Wave-4 T3 beads + stale-docs beads?** (9 T3 titles + 5 docs titles as listed; plus the 7 bead-hygiene updates in §5 — closing 8ss, extending nll, correcting rnq's premise.)
5. **Adopt the drift anchors (§7)?** New code, not deletion: 2 vector fixtures, 3 contract entries + conformance asserts, 1 round-trip fixture, X7 schema spec, X6 parity tests. This converts the repo's worst hand-remembered obligations (92 % and 24-commit lockstep classes) into failing tests.
