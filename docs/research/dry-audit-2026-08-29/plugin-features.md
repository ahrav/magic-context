# DRY / code-reduction audit — `packages/plugin/src/features/`

Scope: `packages/plugin/src/features/**` excluding `*.test.ts`.
333 `.ts` files, 69,326 non-test LOC. Verified against HEAD `9c1eb4d1`.
Read-only audit; no source file was modified.

Method: normalized-token windowing clone detector (windows of 8 and 15 logical
lines, diagonal merge across file pairs), `rg` for exact signatures and caller
counts, `colgrep` for same-concept probes, per-name whole-repo reference counts
across `packages/`, `crates/`, `scripts/`, `tests/`, `docs/`, and
`git log --name-only` for co-change and age signals.

---

## Summary

| Tier | Findings | Est. net LOC delta |
|---|---|---|
| T0 — banned comments, zero-ref dead code, pure-dup helpers | 21 | **−300** |
| T1 — bounded same-concept consolidation | 9 | **−215** |
| T2 — boundary/API/sensitive-path | 6 | **−480** |
| T3 — own design pass | 2 | not estimated |
| TRACKED (bead-guarded, do not remove) | 7 | +0 (≈940 LOC protected) |
| Do not unify yet | 6 | +0 |

**Est. total deletable/collapsible: ≈ 995 LOC (≈1.4 % of scope).**

Honest ranking note: of ~205 clone pairs the detector surfaced at an 8-line
window, **fewer than 25 are worth acting on**. The rest are (a) SQL text in a
canonical DDL file where byte-exactness is the point, (b) sibling row-mapper
functions whose shared shape is 4–6 lines of destructuring, or (c) per-domain
digest/normalization one-liners that must stay separate because each one is a
*persisted protocol identity*. Those are catalogued in
[Do not unify yet](#do-not-unify-yet) rather than padded into the tier counts.

Three findings carry ~70 % of the value: **CC-4** (storage barrel
double-maintenance, −215), **CC-3** (dead singleton embedding lane, −160), and
**CC-1** (dreamer child-session turn, −155).

---

## Findings by tier

### T0

#### T0-1 · CC-4a · `storage.ts` re-lists 108 of `storage-meta.ts`'s 109 exports

**Clone class.** Exact / parameterized (identifier lists).

| Member | Lines | Content |
|---|---|---|
| `magic-context/storage.ts:104-213` | 110 | explicit `export { …108 names… } from "./storage-meta"` |
| `magic-context/storage-meta.ts:1-115` | 115 | pure barrel over 3 modules, 109 names |

**Common core:** the identifier list. Verified by set-diff: `storage-meta.ts`
exports 109 names, `storage.ts` re-exports 108 of them; the only omission is
`PendingSessionCleanupRetryResult` (`storage-meta.ts:106`), which looks like an
oversight rather than a curated narrowing — nothing else in the block is
filtered.

**What differs:** nothing but that one omission.

**Call sites:** `storage.ts` is imported by 40+ modules; `storage-meta.ts` by 20.
Both cross the `features/ → hooks/`, `features/ → tools/`, and
`plugin → pi-plugin` boundaries.

**Priority signals.**
- Co-change: **30 of 63** commits touching either file touch **both** — this is
  the highest co-change ratio in the audit. Every export added to
  `storage-meta-persisted.ts` must be typed into two hand-maintained lists.
- Age: both first appear 2026-03-17; `storage.ts` last touched 2026-08-26. Old
  and still churning — the double-maintenance tax is being paid continuously.
- The codebase already uses `export *` in 16 barrels
  (`features/magic-context/index.ts:1-12`, `memory/index.ts`, `dreamer/index.ts`,
  `tools/*/index.ts`, `shared/index.ts`) and even once *inside* `storage.ts`
  itself (`storage.ts:240` `export * from "./storage-primers";`). The explicit
  enumeration is therefore incidental, not policy.

**Recommendation.** Replace `storage.ts:104-213` with
`export * from "./storage-meta";`, and `storage-meta.ts:1-115` with three
`export * from "./storage-meta-{persisted,session,shared}";` lines.

**Est. net LOC delta: −215.**
**Execution lane:** text/token (plain edit).
**Impact note (why this is only nominally T0):** ES-module `export *` silently
*drops* ambiguous names — if two starred modules export the same identifier,
neither is re-exported and there is no error. Gate the edit on a
`tsc --emitDeclarationOnly` public-surface diff before/after
(`packages/plugin/tsconfig.json` already sets `declaration: true`), and confirm
`PendingSessionCleanupRetryResult` appearing in `storage.ts` is acceptable. With
that gate this is mechanical; without it, it is a silent API break.

---

#### T0-2 · Zero-reference exports (verified whole-repo)

Each verified with `rg -n '\bNAME\b'` across `packages/ crates/ scripts/ tests/
docs/ .beads/` — the only hit is the declaration itself (or a barrel line / a
prose comment, noted per row). Barrel re-export lines were classified
programmatically and do not count as callers.

| Symbol | Location | LOC | Notes |
|---|---|---|---|
| `APPEND_ONLY_CLAIMS_TABLES` | `storage-claims-schema.ts:37-45` | 10 | also a subset-duplicate of `CLAIMS_AND_EVIDENCE_TABLES` (`:23-34`, 4 live callers) |
| `assertClaimsSchemaForeignKeys` | `storage-claims-schema.ts:347-356` | 10 | doc says "reserved for tests"; no test calls it |
| `ApprovalAction` | `storage-claim-policy-schema.ts:103` | 1 | type alias |
| `DispositionAction` | `storage-claim-policy-schema.ts:99` | 1 | type alias |
| `ClaimOperationOutcome` | `storage-claim-memory-schema.ts:71` | 1 | type alias |
| `RetrospectiveLearningRoute` | `dreamer/retrospective-learnings.ts:34` | 1 | type alias |
| `MemoryInput` | `memory/types.ts:63-77` | 15 | interface |
| `CATEGORY_DEFAULT_TTL` | `memory/constants.ts:95-98` | 4 | |
| `MURAL_FONT` | `mural/render-mural.ts:17` | 1 | |
| `MURAL_LINE_CAPACITY` | `mural/render-mural.ts:29` | 1 | |
| `muralImageTokenEstimate` | `mural/render-mural.ts:631-635` | 5 | |
| `muralOverflowMemories` | `mural/mural-selection.ts:19-30` | 12 | whole 30-line file has only this + one live export |
| `computeCueContentHash` | `mural/storage-mural-cues.ts:167-169` | 3 | |
| `consumeLastRuntimeGateRefusal` | `storage-db.ts:68-70` | 3 | |
| `schemaVersionIsSupported` | `storage-db.ts:198-203` | 6 | barrel-only (`storage.ts:75`) |
| `dreamTaskScheduled` | `dreamer/task-config.ts:85-91` | 7 | |
| `userMemoryPromotionThreshold` | `dreamer/task-config.ts:80-82` | 3 | |
| `pruneExpiredPrimerCandidates` | `storage-primers.ts:606-631` | 26 | its only callee `getAllPrimers` (`:486-493`, 8 LOC) becomes dead too → 34 |
| `recordAutonomousManifestRejection` | `memory/storage-claim-autonomous.ts:355-370` | 16 | live sibling is `recordDreamerManifestRejection`; this is the abandoned fork |
| `getPersistedToolOwnerNearestPrior` | `storage-tags.ts:2064-2071` | 8 | only mention is a *comment* in `scripts/benchmark-nearest-prior.ts:3`; that script inlines its own SQL and never imports the function |
| `replaceSessionFacts` | `compartment-storage.ts:333-336` | 4 | only mention is the comment `pi-historian-runner.ts:1194` "No replaceSessionFacts —" |
| `storedPathBelongsToWorkspace` | `workspaces.ts:238-252` | 15 | barrel-only (`storage.ts:322`) |
| `unregisterProjectEmbedding` | `project-embedding-registry.ts:2504-2514` | 11 | barrel-only (`memory/embedding.ts:41`) |
| `bumpEpochsForWorkspaceMemberSet` | `workspaces.ts:371-392` | 23 | barrel-only (`storage.ts:313`); exact clone of live `bumpEpochsForWorkspaceMembers` (`:347-369`) — see T1-6 |

Subtotal ≈ **215 LOC**, ≈ **255** counting the doc-comment blocks above each.

**Execution lane:** typed-semantic (delete export, let `tsc` confirm no
dangling import; then delete now-orphaned private callees).

**Explicitly NOT in this table** (checked and rejected as live):
`PROMOTABLE_CATEGORIES` (`memory/constants.ts:37`) has no TypeScript caller but
is **parsed out of the TS source text by a Rust parity test**,
`crates/mc-module/src/memory_render.rs:515` — deleting it breaks
`render_order_is_a_prefix_of_the_positive_vocabulary`. `mock-database.ts`,
`sql-counters.ts`, `synapse-detailed-test-support.ts`, `test-database.ts`,
`test-claim-database.ts` are all imported by `*.test.ts` files and are live.

---

#### T0-3 · Comment-policy violations

Repo policy (`AGENTS.md`) bans ticket/issue/PR IDs, reviewer references, and
temporal/roadmap phrasing in code comments. The codebase is largely compliant —
comments are mechanism-focused and genuinely load-bearing. Violations are narrow
and fully enumerable:

**Own-repo issue / PR / review references (26 occurrences).**

| File | Count | Examples |
|---|---|---|
| `memory/embedding-local.ts` | 12 | `:20` "See issue #259", `:125` "(issue #21)", `:194` "See issue #4", `:213` "issue #195", `:311` "issue #128", `:458` "See issue #259" |
| `compaction-marker.ts` | 4 | `:548` "(fork-orphan hygiene, #263)", `:571` "(#263)", `:669` "(issue #266)", `:727` "(issue #266 decision #7)" |
| `project-embedding-registry.ts` | 2 | `:590` "See issue #259", `:3055` "(PR #207 review)" |
| `memory/embedding.ts` | 1 | `:64` "See #259" |
| `memory/embedding-identity.ts` | 1 | |
| `compartment-chunk-embedding.ts` | 1 | |
| `dreamer/task-executor.ts` | 1 | |
| `dreamer/storage-dream-runs.ts` | 1 | |
| `dreamer/storage-task-schedule.ts` | 1 | |
| `sidekick/agent.ts` | 1 | |
| `smart-notes/sandbox-runner.ts` | 1 | |

Fix: inline the *mechanism* the issue documented and drop the number.
`project-embedding-registry.ts:3055` ("PR #207 review") is a reviewer reference
and the clearest violation.

*Defensible exception, called out so it is not swept up:* `embedding-local.ts:165`
"added in 3.4.x via PR #1231" refers to an **upstream** (`onnxruntime`) PR and
documents third-party behavior a reader cannot recover from local context. Keep
that class; strip the own-repo class.

**Temporal / roadmap phrasing (4 occurrences).**

- `search.ts:2030` — "Surfacing per-lane executed bounds is future work."
  → speculative future-refactor note.
- `storage-format-epoch.ts:53` — "Sidecar suffix reserved for U11's
  interruption-safe reset marker. U1 only …" → roadmap plumbing.
- `storage-format-epoch.ts:2` and `storage-current-schema.ts:2` — "U1
  direct-cutover groundwork (KTD1, …)" → plan-phase tracking in a file header.

*Not flagged:* the ~160 `KTD\d+` / `R\d+` tags across 23 files read as a
deliberate requirement-traceability vocabulary (they name invariants, not
tasks) and the many `currently` uses are present-tense state descriptions
("currently loaded config", "currently supported rung"), which policy allows.

**Comments that are actively false — higher severity than the banned ones.**

- `storage-claim-applicability-schema.ts:557-562`: "The v85 replay guard uses
  this so a database whose tables survived … is refused" and "migrations-v85.test.ts
  asserts the name list below stays in sync with the DDL."
  `missingClaimApplicabilitySchemaObjects` has **zero callers**, and **no
  `migrations*.test.ts` file exists anywhere in the repo** (`find . -name
  'migrations*.test.ts'` → empty).
- `storage-claim-applicability-schema.ts:615-618`: "callers must also drop and
  recreate `observations` (the migrations-v82.test.ts fixture path)" — same
  non-existent test file.

These two comments assert protection that does not exist. Even though the
functions themselves are bead-guarded (see TRACKED-1), **correcting the comments
is safe and should be done independently of the code**.

**Execution lane:** text/token.
**Est. net LOC delta: ≈ −10** (value here is accuracy, not bytes).

---

### T1

#### T1-1 · CC-5 · `persistShadowDescriptor` copy-pastes one 22-line UPSERT three times

**Clone class.** Exact (within one function).

| Member | Lines |
|---|---|
| `project-embedding-registry.ts:391-404` (+`.run` 405-414) | 24 |
| `project-embedding-registry.ts:412-426` (+`.run`) | 24 |
| `project-embedding-registry.ts:434-448` (+`.run`) | 24 |

Detector confirmed the 369-404 ↔ 391-426 pair at 35 logical lines — the longest
intra-file clone in the scope.

**Common core:** the whole `INSERT INTO shadow_embedding_registrations … ON
CONFLICT(project_path, scope, model_id) DO UPDATE SET …` statement plus its
9-argument bind list.
**What differs:** two values only — `scope` (`"memory"` / `"commit"` / `"chunk"`)
and the model id (`registration.modelId` twice, `registration.chunkModelId`
once).

**Call sites:** 1 (`persistShadowDescriptor` is private, called from
`registerProjectShadowEmbedding`).
**Boundary crossing:** none — single function, single file.

**Priority signals.** Age: file created 2026-05-16, last touched 2026-08-29
(today) — actively churning. Co-change is intra-file so not measurable, but the
three copies must stay byte-identical or the three scopes diverge silently.

**Recommendation.** One prepared statement plus
`for (const [scope, modelId] of [["memory", registration.modelId], ["commit",
registration.modelId], ["chunk", registration.chunkModelId]] as const)`.

**Est. net LOC delta: −44.**
**Execution lane:** structural (codemod or hand edit; mechanically safe).
**Impact note:** writes to a schema table but changes no DDL and no bind order;
verify against `project-embedding-registry.test.ts` and `shadow-backfill.test.ts`.

---

#### T1-2 · CC-9 · "unembedded session compartment" SQL predicate, 3–4 copies

**Clone class.** Parameterized (SQL text).

| Member | Lines | Shape |
|---|---|---|
| `compartment-chunk-embedding.ts:1036-1060` | 25 | candidate SELECT **with** `id NOT IN (?)` exclusion |
| `compartment-chunk-embedding.ts:1074-1096` | 23 | same SELECT, cached statement, no exclusion |
| `compartment-chunk-embedding.ts:1118-1135` | 18 | `SELECT COUNT(*)`, same predicate |
| `compartment-chunk-embedding.ts:238-250` | 13 | near-miss: same `NOT EXISTS` sub-select, different outer query |

**Common core:** the `FROM compartments c JOIN session_projects sp … WHERE
c.session_id = ? AND c.start_message IS NOT NULL AND c.end_message IS NOT NULL
AND NOT EXISTS (SELECT 1 FROM compartment_chunk_embeddings …)` body (16 lines).
**What differs:** SELECT list (columns vs `COUNT(*)`), presence of the exclusion
clause, `ORDER BY`/`LIMIT`.

**Call sites:** 3 exported functions in one file.

**Priority signals.** This is a *correctness* coupling, not just volume: the
`COUNT(*)` at `:1118` drives the `/ctx-embed-history` progress total while
`:1074` produces the actual candidate list. If the copies drift, the progress
bar and the work disagree. File created 2026-06-12, last touched 2026-08-20.

**Recommendation.** Hoist `const UNEMBEDDED_SESSION_COMPARTMENT_PREDICATE =
\`…\`` and interpolate it into the three statements (compile-time constant, no
injection surface).

**Est. net LOC delta: −35.**
**Execution lane:** text/token.

---

#### T1-3 · CC-10 · `PiFallbackFoldTagRow` SELECT projection, 3 copies

**Clone class.** Exact (SQL text).

| Member | Lines |
|---|---|
| `storage-tags.ts:1017-1027` | 11 |
| `storage-tags.ts:1043-1053` | 11 |
| `storage-tags.ts:1072-1082` | 11 |

**Common core:** the 11-column `tag_number AS tagNumber, … reasoning_token_count
AS reasoningTokenCount` alias list.
**What differs:** only the `WHERE`/`ORDER BY`/`LIMIT` tail.

**Call sites:** 3 private readers, all guarded by the same
`isPiFallbackFoldTagRow` type predicate — so all three projections must match
that predicate exactly or rows are silently filtered out.

**Recommendation.** One `const PI_FALLBACK_FOLD_TAG_PROJECTION` constant.

**Est. net LOC delta: −22.**
**Execution lane:** text/token.

---

#### T1-4 · CC-8 · `CompartmentRow` / `RecompCompartmentRow` and their type guards

**Clone class.** Parameterized (types + predicate).

| Member | Lines |
|---|---|
| `compartment-storage.ts:66-84` (`CompartmentRow`) + `:102-125` (`isCompartmentRow`) | 43 |
| `compartment-storage.ts:697-716` (`RecompCompartmentRow`) + `:718-738` (`isRecompCompartmentRow`) | 41 |

Detector confirmed both halves (67-81 ↔ 698-712 at 15 lines, 104-123 ↔ 718-735
at 18 lines).

**Common core:** 17 identical fields and 16 identical predicate clauses.
**What differs:** exactly one field each — `legacy: number | null` vs
`pass_number: number`.

**Call sites:** internal to `compartment-storage.ts`.

**Priority signals.** Age: file created 2026-03-17, last touched 2026-06-06 —
**stable for ~3 months**, so drift risk is low. Value here is volume and
readability, not defect prevention. Rank accordingly.

**Recommendation.** `interface CompartmentRowShared` + two extenders;
`isCompartmentRowShared(candidate)` + two one-line wrappers.

**Est. net LOC delta: −30.**
**Execution lane:** typed-semantic.

---

#### T1-5 · CC-7 · `runImmediate<T>` duplicated verbatim in three files

**Clone class.** Exact (one differing comment line).

| Member | Lines | Boundary |
|---|---|---|
| `git-commits/sweep-coordinator.ts:68-85` | 18 | `features/magic-context/git-commits/` |
| `storage-clone.ts:100-117` | 18 | `features/magic-context/` |
| `dreamer/lease.ts:108-125` | 18 | `features/magic-context/dreamer/` |

Same name, same generic signature `<T>(db: Database, body: () => T): T`,
byte-identical body. The only difference is the comment inside the empty
`catch` ("already rolled back / no active transaction" vs "The transaction may
already have been rolled back by SQLite").

**Call sites:** 3 private definitions, ~10 internal calls total.
**Boundary crossing:** yes — three sibling directories; the shared home would be
`shared/sqlite.ts`, which already exports `isInTransaction` and
`withPrivilegedWriter`.

**Priority signals.**
- Co-change: **0 of 17** commits touch ≥2 of the three files. The copies have
  never been edited together. Read this honestly: it means the duplication is
  **stable, not dangerous**. The argument for consolidating is code volume and
  one obvious home, not observed drift.
- Age: `dreamer/lease.ts` 2026-03-18, `sweep-coordinator.ts` 2026-06-04,
  `storage-clone.ts` 2026-07-10 — the copy propagated forward over 4 months.

**Recommendation.** Export one `runImmediate` from `shared/sqlite.ts` (next to
`isInTransaction`); keep the `dreamer/lease.ts:100-107` block comment — it
explains *why* `BEGIN IMMEDIATE` rather than `db.transaction()` and is the best
documentation of the primitive — moving it to the shared definition.

**Est. net LOC delta: −33.**
**Execution lane:** structural.
**Impact note (why not T0 despite byte-identical bodies):** this is transaction
lock-acquisition. `db.transaction()` in `shared/sqlite.ts:220-250` emits a
*deferred* `BEGIN` and takes the write lock at first write; `runImmediate` takes
it at `BEGIN`. Conflating the two would reintroduce the cross-process
double-acquire race that `dreamer/lease.ts:100-107` documents. Keep the two
primitives distinct and named differently.

---

#### T1-6 · `bumpEpochsForWorkspaceMembers` / `…MemberSet` are exact clones, one is dead

**Clone class.** Exact.

| Member | Lines |
|---|---|
| `workspaces.ts:347-369` (`bumpEpochsForWorkspaceMembers`) | 23 |
| `workspaces.ts:371-392` (`bumpEpochsForWorkspaceMemberSet`) | 22 |

**Common core:** the whole body — `const run = () => bumpEpochRows(…); if
(isInTransaction(db)) { run(); return; } db.exec("BEGIN IMMEDIATE"); try { …
COMMIT } catch { try { ROLLBACK } catch {} throw }`.
**What differs:** one expression — `workspaceMembersForIdentity(db, identity)`
vs the caller-supplied `identities`.

`…MemberSet` is **dead** (barrel-only reference, `storage.ts:313`; see T0-2).

**Recommendation.** Delete `…MemberSet` (−22, already counted in T0-2), then the
survivor's ceremony collapses into T1-5's `runImmediate` (−13 more).

**Est. net LOC delta: −13** beyond the T0-2 deletion.
**Execution lane:** typed-semantic then structural.

---

#### T1-7 · CC-13 · "does this table/column exist?" — 11 sites, 5 wrappers, 1 already exported

**Clone class.** Parameterized / near-miss.

*Table probes:*

| Member | Shape |
|---|---|
| `storage-project-identities.ts:38-45` | `export function tableExists(db, tableName)` — the canonical, parameterized, exported one |
| `storage-clone.ts:131-136` | `function tableExists(db, table)` — private, semantically identical |
| `storage-notes.ts:338-345` | `notesProjectionExists` — hardcoded `'notes_fts'` |
| `project-embedding-registry.ts:325-330` | inline, `'embedding_registrations'` |
| `project-embedding-registry.ts:361-366` | inline, `'shadow_embedding_registrations'` |
| `project-embedding-registry.ts:442-444` | inline, parameterized by table |
| `storage-embedding-measurements.ts:814-818` | inline, `'synapse_batch_ledger'` |
| `storage-db.ts:184-186` | inline, `'schema_migrations'` |
| `memory/storage-claim-policy.ts:43-51` | `hasClaimPolicySchema`, hardcoded |
| `memory/storage-claim-applicability.ts:42-49` | `hasClaimApplicabilitySchema`, hardcoded, `WeakSet` memoized |
| `memory/storage-claim-current-state.ts:527-536` | `hasClaimMemoryFragment`, hardcoded, `WeakMap` memoized |

*Column probes (`PRAGMA table_info`), 10 sites:* `workspaces.ts:30-33`
(`columnExists`, generic), `storage-notes.ts:221-228` (`noteColumnExists`,
hardcoded + `try/catch`), `storage-claim-applicability-schema.ts:124-127`
(hardcoded table+column), plus 4 "columns as a `Set<string>`" builders
(`storage-meta-shared.ts:568-573`, `storage-meta-session.ts:82-86`,
`compaction-marker.ts:124-131` ×2).

**Highest-value sub-finding, and the reason this is one finding not twelve:**
`storage-meta-shared.ts:187-193` (`ensureSessionFactsVersionColumn`)
re-implements `ensureColumn` from `storage-schema-helpers.ts:6-31` — a helper
that exists, is exported, and has exactly **one** caller (`storage-db.ts:48`).
The local copy also *omits* `ensureColumn`'s race-tolerant recheck
(`storage-schema-helpers.ts:24-30`), so replacing it is strictly a robustness
improvement, not just a dedupe.

**Recommendation, in priority order:**
1. `storage-meta-shared.ts:187` → `ensureColumn(db, "session_meta",
   "session_facts_version", "INTEGER NOT NULL DEFAULT 0")` (−6, plus the
   recheck fix). Do this one on its own merit.
2. Delete `storage-clone.ts:131-136`; import `tableExists` from
   `storage-project-identities.ts` (−6).
3. Add `tableColumnSet(db, table): Set<string>` next to `ensureColumn`; adopt at
   the 4 Set-builder sites (−13).
4. Leave the memoized probes (`hasClaimApplicabilitySchema`,
   `hasClaimMemoryFragment`) alone — their `WeakSet`/`WeakMap` caching has a
   documented negative-recheck contract (`storage-claim-applicability.ts:35-38`)
   that a generic helper must not flatten.

**Est. net LOC delta: −25.**
**Execution lane:** typed-semantic.
**Impact note:** items 1 and 3 touch schema-adjacent code. Item 1 changes an
`ALTER TABLE` path; run `storage-meta.test.ts` and `storage-db.test.ts`.

---

#### T1-8 · CC-11 · `provider.embedItems ?? embedBatch`+zip block duplicated for the fallback retry

**Clone class.** Exact.

| Member | Lines |
|---|---|
| `project-embedding-registry.ts:2664-2679` | 16 |
| `project-embedding-registry.ts:2681-2696` | 16 |

**Common core:** the whole `if (provider.embedItems) { … } else { const
positional = await provider.embedBatch(items.map(i => i.text), signal,
"passage"); vectors = new Map(items.flatMap(…)) }` block.
**What differs:** nothing — the second copy exists only because it runs again
after `activatePrimarySynapseFallback` swaps the provider.

**Call sites:** 1 function.
**Recommendation.** `const embedVia = async (p: EmbeddingProvider) => …`, call
twice.
**Est. net LOC delta: −16.**
**Execution lane:** structural.

---

#### T1-9 · Small single-file clones (grouped; each ≤ −13)

| ID | Members | Differs | Δ LOC |
|---|---|---|---|
| CC-14 | `transform-decision-log.ts:249-264` ↔ `:353-370` — "assistant message entry with a non-empty id" loop body | iteration direction/start only | −12 |
| CC-15 | `project-embedding-registry.ts:493-503` ↔ `:524-534` — registration field assignment + `db.transaction(recordActiveEmbeddingIdentity…, persistPrimaryDescriptor)` tail | `off`-identity guards in the second | −11 |
| CC-16 | `search.ts:2331-2344` (`runGitCommitLane`) ↔ `:2346-2359` (`runPrimerLane`) | search fn + result type | −12 |
| CC-17 | `compaction-marker.ts:483-499` ↔ `:511-527` — `INSERT INTO part … ON CONFLICT DO UPDATE` upsert | bind values | −13 |
| CC-18 | 8 private `createHash("sha256").update(x).digest("hex")` one-liners: `project-embedding-registry.ts:756`, `search-measurement.ts:118`, `memory/storage-claims.ts:55`, `memory/claim-operation-contract.ts:132`, `memory/embedding-synapse.ts:375`, `compartment-chunk-embedding.ts:411`, `mural/storage-mural-cues.ts:168`, `memory/verification-paths.ts:83` | encoding arg (`"utf8"`) on 2 of 8 | −12 |

CC-18 caveat: keep every domain-named wrapper. Each is a **persisted digest
protocol** (`SNAPSHOT_VECTOR_DIGEST_PROTOCOL`,
`APPLICABILITY_HEADS_DIGEST_PROTOCOL`, chunk content hash, cue content hash).
Share only the mechanical primitive so a change in one domain cannot silently
re-key another domain's stored digests. If that separation cannot be preserved
in review, drop CC-18 — 12 LOC is not worth coupling two digest protocols.

**Est. net LOC delta (group): −60.**

---

### T2

#### T2-1 · CC-1 · The dreamer child-session subagent turn — 4 nested clone families, 11 call sites

This is the largest *behavioural* duplication in the scope. Every dreamer/mural/
smart-note/sidekick task that talks to a child model repeats the same four-stage
ceremony around `shared.promptSyncWithValidatedOutputRetry`
(`shared/model-suggestion-retry.ts:464`).

**Members (11 turn sites):** `dreamer/classify.ts:476`, `dreamer/verify.ts:217`,
`dreamer/map-memories.ts:197`, `dreamer/refresh-primers.ts:238`,
`dreamer/evaluate-smart-notes.ts:446`, `dreamer/task-executor.ts:1106`,
`dreamer/task-executor.ts:1353`, `mural/compress-cues.ts:358`,
`user-memory/review-user-memories.ts:760`, `smart-notes/compiler.ts:110`,
`sidekick/agent.ts:57`.

**Sub-clone (a) — spawn child session and extract its id. 11 members, ~13 LOC each.**
Common core (9 lines, verbatim):
```
const created = shared.normalizeSDKResponse(createResponse, null as { id?: string } | null,
    { preferResponseOnMissingData: true });
agentSessionId = typeof created?.id === "string" ? created.id : null;
if (!agentSessionId) throw new Error("Could not create X session.");
```
Differs: `title`, `directory` expression, `db` expression, error message. Two
outliers: `evaluate-smart-notes.ts:460` deliberately does **not** throw
(inconclusive → abandon), and `sidekick/agent.ts:70-74` calls
`recordInvocation` before throwing. Both are expressible as options on a helper.
→ **−80**

**Sub-clone (b) — the `fetchOutput` closure. 10 members, ~8 LOC each.**
Verbatim except `client` receiver, session-id expression, `directory`, and
`limit` (20/50/100):
```
fetchOutput: async () => {
    const messagesResponse = await X.client.session.messages({
        path: { id: sessionId }, query: { directory, limit: N } });
    return shared.normalizeSDKResponse(messagesResponse, [] as unknown[],
        { preferResponseOnMissingData: true });
},
```
Sites: `compress-cues.ts:435`, `review-user-memories.ts:798`,
`compiler.ts:145`, `refresh-primers.ts:276`, `sidekick/agent.ts:101`,
`classify.ts:549`, `evaluate-smart-notes.ts:498`, `task-executor.ts:1146`,
`task-executor.ts:1435`, `map-memories.ts:255`. → **−60**

**Sub-clone (c) — the `validateOutput` preamble. 5 members, ~6 LOC each.**
`if (hasLengthCappedOutput(messages)) throw …; const text =
extractLatestAssistantText(messages); if (!text) throw …; rawManifest = text;`
at `classify.ts:559-564`, `verify.ts:293-298`, `map-memories.ts:265-270`,
`compress-cues.ts:445-449`, and (without the length-cap check)
`review-user-memories.ts:808-810`. Differs: one label string. → **−25**

**Sub-clone (d) — the provider-failure rethrow. 4 members, 8 LOC each, exact.**
`catch (error) { const providerFailure =
providerOutputFailureFromInvalidManifest(messages, text); if (providerFailure)
throw providerFailure; throw error; }` at `classify.ts:570-577`,
`verify.ts:301-308`, `map-memories.ts:276-283`, `compress-cues.ts:454-461`.
Differs: only the validator call inside the `try`. → **−24**

**Priority signals.** Co-change across the 7 primary members
(`classify`, `verify`, `map-memories`, `compress-cues`, `refresh-primers`,
`review-user-memories`, `compiler`): **23 of 105** commits touch ≥2 members.
That is the second-highest ratio in the audit and the strongest drift evidence
available — the copies *are* being edited together, and the length-cap check is
already missing from one of them (`review-user-memories.ts`), which is exactly
the divergence this class predicts. Ages 2026-06-22 → 2026-07-22 first commit,
all last touched 2026-08-11 → 2026-08-28: mature and hot.

**Recommendation.** One module (next to `createChildSessionWithFence` in
`hooks/magic-context/child-session-spawn.ts`, which all 11 already import):
- `spawnChildSessionId({client, db, parentSessionId, title, directory}):
  Promise<string | null>`
- `childSessionMessagesFetcher(client, sessionId, directory, limit): () => Promise<unknown[]>`
- `requireAssistantManifestText(messages, label, {rejectLengthCapped}): string`
- `withProviderFailureRethrow(messages, text, validate: () => void): void`

**Est. net LOC delta: −155** (−189 removed, ≈+35 for the four helpers).
**Execution lane:** structural (codemod for (b) and (d); hand-edit (a) and (c)
because of the two documented outliers).
**Impact note — why T2:** 11 files across 6 directories, and it adds exported
API to a `hooks/` module consumed by `features/`. The helpers must preserve
three non-obvious behaviours: `preferResponseOnMissingData: true` on both
`normalizeSDKResponse` calls, the per-site `limit` (20 vs 50 vs 100 — these are
tuned, not arbitrary), and `evaluate-smart-notes`' non-throwing path. Verify
against `classify.test.ts`, `verify.test.ts`, `map-memories.test.ts`,
`provider-output-failure.test.ts`, and `dreamer/task-executor.test.ts`.

**Bead interaction — read before acting.** `magic-context-pml.2` ("Port dreamer
task bodies: prompt render + parse for module-routed tasks") and
`magic-context-pml.3` ("Port TS-only dreamer tasks: … refresh-primers,
evaluate-smart-notes, review-user-memories") will rewrite several of these call
sites in Rust. **Sub-clones (b) and (d) are safe now** (pure mechanism, no task
semantics). **Sub-clones (a) and (c) should wait or be scoped to the members
`pml.2`/`pml.3` do not touch** — otherwise the consolidation is churn the port
discards.

---

#### T2-2 · CC-3 · `resolveEmbeddingConfig` + `createProvider` forked, and the fork's lane is test-only

**Clone class.** Near-miss (one member is a strict superset).

| Member | Lines | Role |
|---|---|---|
| `memory/embedding.ts:52-105` (`resolveEmbeddingConfig`) + `:108-163` (`createProvider`) | 110 | module-global singleton lane |
| `project-embedding-registry.ts:575-675` + `:678-770` | 190 | project-scoped lane |

Detector confirmed `memory/embedding.ts:52-97` ↔
`project-embedding-registry.ts:575-628` at 34 logical lines and
`:109-133` ↔ `:686-710` at 17.

**Common core:** the `local` branch (including the load-bearing
"`local_dtype` is spread CONDITIONALLY to preserve the byte-identical default
identity" comment, duplicated at `memory/embedding.ts:64-66` and
`project-embedding-registry.ts:587-590`), the whole `openai-compatible` branch,
the `off` branch, and the entire `createProvider` `openai-compatible`/`local`
dispatch.

**What differs:** the registry version is a superset — full `synapse` field
normalization (`:626-670`, ~45 LOC) versus the singleton's one-liner
`return { ...config, max_input_tokens: 8192 }` (`memory/embedding.ts:98`), plus
`testProviderFactory` and `ProviderContext` support.

**Priority signals.**
- Co-change: **14 of 72** commits touch both files. The fork *is* drifting under
  co-maintenance — and it has already diverged incorrectly: the singleton's
  hardcoded `8192` bypasses `normalizeSynapseTokenBudget` and the
  `SYNAPSE_MAX_INPUT_TOKENS`/`SYNAPSE_MAX_INPUT_BYTES` validation the registry
  applies. That is a live behavioural divergence, not a cosmetic clone.
- Age: `memory/embedding.ts` 2026-03-17 (older), registry 2026-05-16. The
  registry is the successor; the singleton is residue.

**The larger finding: the singleton lane has no production caller.**
`memory/embedding.ts:44-225` is the module-global lane
(`resolveEmbeddingConfig`, `resolveProviderIdentity`, `createProvider`,
`getOrCreateProvider`, `initializeEmbedding`, `isEmbeddingEnabled`,
`_resetEmbeddingConfigForTests`, `embedText` ≈ 180 LOC). Its only consumers are
two defaulted parameters in `search.ts:2035-2036`:
```
const embedQuery = options.embedQuery ?? embedText;
const isEmbeddingRuntimeEnabled = options.isEmbeddingRuntimeEnabled ?? isEmbeddingEnabled;
```
Every production caller supplies both explicitly and routes through
`embedTextForProject`: `plugin/src/tools/ctx-search/tools.ts:210,214`,
`pi-plugin/src/tools/ctx-search.ts:238`,
`pi-plugin/src/auto-search-pi.ts:352,361`,
`plugin/src/hooks/magic-context/auto-search-runner.ts:386,395`, and
`plugin/scripts/retrieval-benchmark/runner.ts:599`. The only remaining callers
of `initializeEmbedding` / `embedText` / `_resetEmbeddingConfigForTests` are
`memory/embedding.test.ts` and `search.test.ts`. The rest of
`memory/embedding.ts` (lines 1-43) is a re-export barrel over
`project-embedding-registry` and is genuinely load-bearing.

**Recommendation.** Delete the singleton lane, make `embedQuery` and
`isEmbeddingRuntimeEnabled` **required** on `UnifiedSearchOptions`, and update
the two test files to pass explicit stubs (they already own stubs for every
other lane). This removes the fork rather than unifying it — the correct
resolution when one branch is dead.

**Est. net LOC delta: −160.**
**Execution lane:** typed-semantic (making the options required makes `tsc`
enumerate every site that relied on the default).
**Impact note — why T2:** changes an exported signature
(`UnifiedSearchOptions`) consumed across `plugin` and `pi-plugin`, and removes
exports (`initializeEmbedding`, `embedText`, `isEmbeddingEnabled`) that are part
of `memory/index.ts`'s `export *` surface. Confirm no external embedder relies
on the singleton before deleting. `magic-context-3q5.25` ("Embedding-space
contract + purpose plumbing") and `magic-context-pml.4` ("Port embedding
pipeline to Rust") both touch this area — but both point *away* from the
singleton, so removal is aligned rather than blocked.

---

#### T2-3 · CC-6 · CAS-merge-string-set-into-`session_meta` — 3 exact clones beside an existing generic helper

**Clone class.** Parameterized (column name only).

| Member | Lines |
|---|---|
| `storage-meta-persisted.ts:2186-2223` (`addMergedReasoningStrippedIds`) | 38 |
| `storage-meta-persisted.ts:2336-2368` (`addStaleReduceStrippedIds`) | 33 |
| `storage-meta-persisted.ts:2392-2424` (`addProcessedImageStrippedIds`) | 33 |

**Common core:** the entire body — `if (add.length === 0) return true;
ensureSessionMetaRow(…); for (attempt < CAS_RETRY_LIMIT) { SELECT col; keep raw;
Set-merge; if (!changed) return true; UPDATE … WHERE session_id = ? AND col IS
?; if (changes > 0) return true } sessionLog(…"CAS: … retries exhausted");
return false`.
**What differs:** the column name — appearing in the `SELECT`, the row-cast
type, the `UPDATE`, and the log string. Nothing else.

**The smoking gun:** `storage-meta-persisted.ts:1397-1443`
(`casUpdateJsonArrayColumn`) is *already* the column-parameterized version of
this loop, complete with a runtime allow-set guard against SQL injection
(`:1404-1411`) and the documented `IS ?` vs `= ?` NULL-matching rationale
(`:1422-1427`). Its `column` union is restricted to
`"note_nudge_anchors" | "auto_search_hint_decisions"`. The generalization was
reached for once, then three later functions re-copied the loop instead of
widening the union.

**Near-miss members — do NOT fold in blindly:**
`applyStrippedPlaceholderDelta` (`:2107-2139`) uses `""` rather than `"[]"`/`NULL`
as its empty representation (`:2128` `const nextBlob = current.size > 0 ?
JSON.stringify([...current]) : ""`), and supports `remove` as well as `add`.
`setTrailingBlankDecisions` (`:2281`) stores a map, not a set.

**Recommendation.** Widen `casUpdateJsonArrayColumn`'s allow-set (keeping the
runtime guard) or add a sibling `casMergeStringSetColumn(db, sessionId, column,
add)`; reduce the three functions to one-line wrappers.

**Est. net LOC delta: −45.**
**Execution lane:** typed-semantic.
**Impact note — why T2:** this is compare-and-swap concurrency across the
OpenCode + Pi processes that share the SQLite file. The `IS ?` predicate, the
raw-value preservation, and the exact empty-blob convention per column are all
load-bearing (`:1422-1427` documents why `= ?` deadlocks forever on a NULL row).
Regression tests exist and must all pass:
`merged-reasoning-stripped-ids.test.ts`, `stale-reduce-stripped-ids.test.ts`,
`stripped-placeholder-cas.test.ts`, `sticky-injection-cas-race.test.ts`.

---

#### T2-4 · Manual `BEGIN IMMEDIATE` / `finally ROLLBACK` ceremony — 4 sites in the wrapup lease

**Clone class.** Near-miss.

| Member | Lines |
|---|---|
| `storage-meta-persisted.ts:518-544` (`getWrapupInProgressState`) | 27 |
| `storage-meta-persisted.ts:565-587` (`acquireWrapupInProgress`) | 23 |
| `storage-meta-persisted.ts:600-627` (`updateWrapupInProgress`) | 28 |
| `storage-meta-persisted.ts:635-651` (`releaseWrapupInProgress`) | 17 |

**Common core:** `db.exec("BEGIN IMMEDIATE"); let finished = false; try { … ;
db.exec("COMMIT"); finished = true; } finally { if (!finished) { try {
db.exec("ROLLBACK"); } catch {} } }` — ~11 lines of pure ceremony per site.

**What differs, and why this is the *hardest* member of the `runImmediate`
family:**
- `getWrapupInProgressState:518-524` wraps `BEGIN` in its own `try/catch` and
  returns `null` when it fails, deliberately tolerating being called from inside
  a caller's transaction. `runImmediate` cannot express that.
- `updateWrapupInProgress:603-607` issues an explicit `ROLLBACK` on the
  *success-but-no-op* path and returns `null` — a non-throwing rollback that a
  `body()`-returning wrapper cannot produce without an out-of-band signal.
- `acquireWrapupInProgress:571-575` commits early inside the `try` and returns a
  different result shape.

**Recommendation.** Introduce a file-local
`withImmediate<T>(db, body: () => {commit: boolean; value: T}): T | null` that
covers `acquire`/`release`/`update`, and leave `getWrapupInProgressState` alone
with a comment explaining why. Only do this *after* T1-5 lands, so the shared
vocabulary already exists.

**Est. net LOC delta: −30** (conservative; −22 if `update` is excluded).
**Execution lane:** structural.
**Impact note — why T2:** this is the wrapup lease. Getting the commit/rollback
decision wrong here either double-acquires the lease across processes or leaves
a write transaction open. Sensitive by the rubric (permit/lease logic).
`emergency-drain-latch.test.ts` and `storage-meta.test.ts` cover it.

---

#### T2-5 · `memory/source-trust.ts` — a claims-trust policy with zero production callers

**Location:** `memory/source-trust.ts:1-17` (whole file, 17 LOC).
**Exports:** `trustClassForLegacyMemorySource` (`:5-9`),
`liveRewriteSourceType` (`:15-17`), plus a pass-through re-export of
`SOURCE_TRUST_CLASSES` from `storage-claim-applicability-schema.ts:3`.

**Evidence.** Both functions are referenced only by `source-trust.test.ts`
(lines 4, 22, 23, 31, 42, 43). No production module imports this file.
`SOURCE_TRUST_CLASSES` is imported *directly* from
`storage-claim-applicability-schema.ts` by every real consumer, so the
re-export is also redundant.

**Why this is worth a look beyond the 17 LOC.** Closed bead
`magic-context-m3t` states as settled policy: *"the live build's rule that every
rewrite is model_inference (liveRewriteSourceType returns null unconditionally,
user-driven or not)"*. That rule now has no call site. Trust class is instead
supplied directly at construction — `dreamer/anti-memory-from-corrections.ts:271`
(`? "explicit_user"`), `test-claim-database.ts:66`,
`memory/fixtures/claim-operations-crash-worker.ts:83`. Two readings:
1. The rule was correctly absorbed into the explicit `sourceTrustClass`
   arguments and `source-trust.ts` is residue of the deleted legacy memory
   storage (`storage-memory.ts`, removed in `f4ee5460`). Delete the file.
2. A rewrite path lost its call to `liveRewriteSourceType()` and can once again
   let a model rewrite inherit `explicit_user` — the exact regression `m3t`
   closed. In that case this is a bug, not dead code.

**Recommendation.** Resolve which reading holds **before** deleting. Trace the
claim-rewrite path against
`memory/storage-claim-policy.ts:517` (`AND o.source_trust_class =
'explicit_user'`) and confirm the origin-revision-only guard `m3t` describes is
still enforced. If it is, delete `source-trust.ts` and its test (−17 plus test);
if not, file a bug.

**Est. net LOC delta: −17** (contingent).
**Execution lane:** typed-semantic, gated on the trace.
**Impact note — why T2:** claims trust classification is a policy gate. Age
signal reinforces caution: the file was created **2026-08-22 and never touched
since** — young code, so the "residue" reading is not obviously right.

---

#### T2-6 · `git-anchors/` and `relocate-memory.ts` — see TRACKED-2 and TRACKED-3

Listed here only so the tier count reflects that two large test-only subsystems
(≈820 LOC) were evaluated and **excluded** from the deletable total.

---

### T3 — deserve their own design pass

#### T3-1 · `dreamer/task-executor.ts:563-860` — 9-branch dispatch repeating an 11-field arg object

`runDreamTaskBody` is a flat `if (config.task === "…")` chain over 9 tasks
(`:563, 600, 628, 656, 712, 768, 788, 812, 834`). Each branch constructs the
same base argument object — `db, client, projectIdentity, parentSessionId,
sessionDirectory, holderId, leaseKey, deadline, leaseAcquisition, model,
fallbackModels` — before adding 1-3 task-specific fields. `leaseAcquisition,`
alone appears **10 times** in the file. Hoisting `const baseTaskArgs = {…}` and
spreading it would remove ≈50 LOC.

**Not proposed as T1/T2.** The file is 1,539 LOC and is a task-dispatch state
machine with per-branch progress reporting, run recording, and module-route
handling. And it is squarely inside `magic-context-pml.1` ("Port dreamer
scheduler + task executor to Rust"). Consolidating now produces churn the port
discards. If the port slips, revisit as a standalone design pass that also
addresses the accretive `if`-chain shape, not just the argument duplication.

#### T3-2 · `storage-session-runtime-schema.ts` — 1,118-line DDL template literal

`SESSION_RUNTIME_SCHEMA_DDL` (`:146-1264`) contains real duplication: the
`compartments` (`:181-201`) and `recomp_compartments` (`:714-736`) column lists
are near-identical (differing in `legacy` vs `pass_number` — the same split as
T1-4), and the notes-authority-guard `WHEN` predicate is repeated 4× across 3
triggers (`:1190-1256`, 8 occurrences of the `project_path = NEW/OLD.project_path`
clause), ≈40 LOC of interpolatable text.

**Deliberately not proposed.** The file's own header states the intent: *"This
is the exact final shape of every non-claim harness table the plugin uses …
Schema changes bump the component manifest digest, which changes the
direct-format identity."* The literal, auditable, un-abstracted text **is** the
artifact. Any interpolation makes the schema harder to review against a live
`sqlite_master` dump for a 40-line saving. See
[Do not unify yet](#do-not-unify-yet).

---

## TRACKED findings (bead-guarded — do not remove)

| # | Code | LOC | Bead | Reason |
|---|---|---|---|---|
| TRACKED-1 | `storage-claim-applicability-schema.ts` — `seedApplicabilityBaselines` (`:505-538`, 34), `assertClaimApplicabilitySchemaForeignKeys` (`:545-554`, 10), `missingClaimApplicabilitySchemaObjects` (`:564-612`, 49), `dropClaimApplicabilityObjectsForTests` (`:614-629`, 16), `observationSourceTrustClassColumnExists` (`:124-127`, 4) | 113 | **magic-context-3q5.40** — "Applicability engine + retrieval-time read repair" | All five are zero-reference and verified so. They are the v85 applicability schema's replay-guard and seeding surface — precursors to the applicability engine. **Do not remove — precursor to magic-context-3q5.40.** Their *comments* are separately false (see T0-3) and should be corrected in place. |
| TRACKED-2 | `memory/relocate-memory.ts` (whole file) | 361 | **magic-context-3q5.8** — "U7: Direct claims cutover for memory storage" | `relocateProjectMemoryClaims` (`:132`) is referenced only by its own two wrappers (`:352`, `:360`) and `relocate-memory.test.ts`. Header says "Direct claim relocation (U7)". **Do not remove — precursor to magic-context-3q5.8.** |
| TRACKED-3 | `git-anchors/git-anchor-reader.ts` (219) + `git-anchors/storage-git-anchors.ts` (241) | 460 | **magic-context-3q5.40** | Entire subsystem is test-only: `git-anchor-reader.ts` is imported only by `storage-git-anchors.ts:18` (type-only) and its own test; `storage-git-anchors.ts` only by its test. The `git_anchors` / `git_anchor_representations` tables it writes are created by the v85 applicability component (`storage-claim-applicability-schema.ts`, indexes `idx_git_anchors_project`, `idx_git_anchor_representations_*`) and provide the anchor identity (KTD5) the applicability engine needs. Created 2026-08-22, untouched since. **Do not remove — precursor to magic-context-3q5.40.** |
| TRACKED-4 | `memory/enforcement-artifact-revalidation.ts:43-45` — `__resetArtifactRevalidationThrottleForTests` | 3 | **magic-context-62w** — "Enforcement artifacts are never revalidated against their recorded digest" | Zero-reference test seam on the throttle for the revalidation path 62w is about. The surrounding module is live (`hooks/magic-context/transform.ts:840,1599`; `pi-plugin/src/context-handler.ts:2109`). **Do not remove — precursor to magic-context-62w.** |
| TRACKED-5 | `memory/claim-policy-commands.ts:340-375` ↔ `:846-880` — two-step confirmation + `## X — Failed` error envelope + `confirmationText(…)` pending branch | ~35 | **magic-context-2my** — "Extract a shared two-step confirmation helper for claim commands and ctx-recomp" | Detector confirmed the pair at 17 logical lines. **Already tracked; not re-proposed as a new finding.** Referenced here so a future audit does not double-count it. |
| TRACKED-6 | `memory/storage-claim-autonomous.ts:228-243`, `:285-297`, `:315-327` — the `identity: { batchId, leaseGeneration: String(…), leaseKey, runId, task }` envelope rebuilt three times inside `computeClaimOperationRequestDigest` calls | ~36 | **magic-context-0fm** — "Extract shared claims-replay identity/envelope helper for ctx-memory host adapters" | Detector confirmed `:228-237` ↔ `:285-294` ↔ `:315-324` at 10 logical lines each. **Already tracked; not re-proposed.** |
| TRACKED-7 | `dreamer/task-executor.ts` base-arg duplication + branch chain | ~50 | **magic-context-pml.1 / pml.2 / pml.3** | See T3-1. **Do not refactor yet — the port supersedes it.** |

**Stale-bead observation (not a code finding).** `magic-context-8ss` ("Unify the
nine `hasMemoryClaimsCompatSchema` forks in `storage-memory.ts` behind
`withClaimsOrLegacy`") appears **already resolved by deletion**:
`packages/plugin/src/features/magic-context/memory/storage-memory.ts` no longer
exists (removed in `f4ee5460`, "remove the retired memory storage now that
claims are the supported kernel"), and `rg hasMemoryClaimsCompatSchema` matches
nothing in the repo. Per instructions I did not re-propose that family; the
schema-probe clone class I *did* report (T1-7) is a different, still-present set
of 11 sites. Worth closing 8ss.

---

## Do not unify yet

| # | Clone | Why not |
|---|---|---|
| DNU-1 | `storage-session-runtime-schema.ts` DDL — `compartments` ↔ `recomp_compartments` column lists (`:181-201` ↔ `:714-736`), notes-authority-guard `WHEN` predicate ×4 (`:1190-1256`) | **Duplication is load-bearing.** The file's contract is "the exact final shape" of every table, and it is diffed against live `sqlite_master` output during schema review. Interpolation trades auditability for ≈40 LOC. Sensitive (schema identity, manifest digest). |
| DNU-2 | Per-domain digest wrappers: `hashChunkText` (`compartment-chunk-embedding.ts:410`), `computeCueContentHash` (`mural/storage-mural-cues.ts:167`), `normalizedQueryHash` (`query-normalization.ts:13`), `sha256Utf8Hex` (`memory/storage-claims.ts:54`), `sha256HexUtf8` (`memory/claim-operation-contract.ts:131`), `contentSha256` (`project-embedding-registry.ts:755`) | Each is a **persisted protocol identity** (`SNAPSHOT_VECTOR_DIGEST_PROTOCOL`, `POLICY_HEADS_DIGEST_PROTOCOL`, `APPLICABILITY_HEADS_DIGEST_PROTOCOL`, chunk/cue content hashes). Merging the *named wrappers* couples independent digest domains: a change made for one silently re-keys another's stored rows. Share the primitive only (T1-9/CC-18) or not at all. |
| DNU-3 | `.replace(/\s+/g, " ").trim()` at 11 sites (`compartment-chunk-embedding.ts:383`, `message-index.ts:66`, `sql-counters.ts:44`, `memory/normalize-hash.ts:4`, `query-normalization.ts:9`, `memory/storage-anti-memory.ts:111`, `smart-notes/condition-compiler.ts:339`, `search.ts:326`, + 3 in `hooks/`) | Same reason as DNU-2 — `normalizeIndexText` and `normalizeMemoryContent` feed **persisted hashes**; `sql-counters.ts` normalizes SQL for test counting. Three different contracts wearing one expression. Net saving ≈8 LOC. Not worth the coupling. |
| DNU-4 | `memory/source-trust.ts` (T2-5) | **Young + sensitive.** Created 2026-08-22, never modified. Zero-ref, but a closed bead (`m3t`) asserts its rule is live policy. Resolve the ambiguity first. |
| DNU-5 | `git-anchors/*` (TRACKED-3) | Young (2026-08-22, untouched) **and** bead-guarded. Both the "young clone" and "bead precursor" tests say wait. |
| DNU-6 | `dreamer/verify.ts:434-451`, `:465-481`, `:484-495`, `:566-577`, `:584-595`, `:644-667`, `:682-705` — repeated `stageVerificationOutcome(db, category, {token, revisionLocator, outcome, verifier}, nowMs)` + `freshTarget(…)` staging blocks (7 sites, ≈11 LOC each, differing only in the `outcome` literal) | **Already-diverged siblings needing flag-plumbing to unify.** Each block threads a different `outcome` (`"verified"` / `"update"` / …) *and* a different token source (`item.binding.token` vs `freshTarget(db, …).token`) — the token freshness choice is a per-path correctness decision, not a parameter. Unifying would require a mode flag that re-encodes exactly the distinction the code makes explicit today. Also claims-policy staging (sensitive) and inside `pml.2`'s blast radius. Potential ≈−30 LOC; not recommended. |

---

## Dead code list

Consolidated, verified against HEAD. "Zero-ref" = the only `rg` hit across
`packages/ crates/ scripts/ tests/ docs/ .beads/` is the declaration itself;
barrel `export {}` lines and prose comments were classified and excluded as
callers.

**Removable now (T0-2):** 25 exports, ≈215 LOC (≈255 with doc blocks). See the
T0-2 table for the full list with locations.

**Verified NOT dead — do not delete:**

| Symbol / file | Why it is live |
|---|---|
| `PROMOTABLE_CATEGORIES` (`memory/constants.ts:37`) | Read out of the TS **source text** by `crates/mc-module/src/memory_render.rs:515`. No TS caller; deleting breaks a Rust parity test. |
| `V2_MEMORY_CATEGORIES`, `CATEGORY_PRIORITY` | Same mechanism (`memory_render.rs:505-524`). |
| `hashCheck` (`smart-notes/compiler.ts:317`) | Called at `:189`; also mirrored by `crates/mc-store/src/lib.rs:13756` and `crates/mc-module/src/lib.rs:14174`. |
| `mock-database.ts` (5), `sql-counters.ts` (103), `synapse-detailed-test-support.ts` (215), `test-database.ts` (73), `test-claim-database.ts` (88) | Imported by `*.test.ts` and by `scripts/smoke-*.ts`. Live. |
| `memory/fixtures/claim-operations-crash-worker.ts` | Spawned by `storage-claim-operations-crash.test.ts`. |

**Orphan files:** none. Every non-test `.ts` in scope has at least one importer.

**Test-only modules living in production `src/`** (not deletable; a packaging
finding): `mock-database.ts`, `sql-counters.ts`,
`synapse-detailed-test-support.ts` (323 LOC combined) are imported exclusively
by `*.test.ts`. `packages/plugin/tsconfig.json` excludes `src/**/*.test.ts` from
the declaration build but **not** these helpers, so they ship in the published
surface. Moving them under a `__testsupport__/` directory excluded from
`tsconfig.json` would shrink the built artifact without deleting anything.
(`test-database.ts` and `test-claim-database.ts` are also used by
`scripts/smoke-*.ts` and `packages/cli`, so they must stay.)

**Stale feature-flag branches:** none found. `rg` for `if (feature`, `enabled
=== false` early-returns, and disabled-mode guards turned up only live
configuration checks.

---

## Comment-policy violations

Full detail in [T0-3](#t0-3--comment-policy-violations). Summary:

| Class | Count | Severity |
|---|---|---|
| Own-repo issue / PR / review references in comments | 26 | policy violation; `project-embedding-registry.ts:3055` ("PR #207 review") is the clearest |
| Temporal / roadmap phrasing (`search.ts:2030` "future work"; `storage-format-epoch.ts:2,53` and `storage-current-schema.ts:2` "U1 groundwork", "reserved for U11") | 4 | policy violation |
| **Comments asserting protection that does not exist** (`storage-claim-applicability-schema.ts:557-562`, `:615-618` — cite a "v85 replay guard" caller and `migrations-v85.test.ts` / `migrations-v82.test.ts`; neither the caller nor the files exist) | 2 | **highest — actively misleading**, fix independently of the bead-guarded code |
| Upstream third-party issue refs (`embedding-local.ts:165` "PR #1231") | ~2 | **not** a violation — documents external behavior a reader cannot recover locally |
| `KTD\d+` / `R\d+` requirement tags | ~160 across 23 files | **not** flagged — a deliberate invariant-traceability vocabulary, not task IDs |
| `currently` / `not yet` describing present state | ~20 | **not** flagged — present-tense state descriptions, which policy allows |

Overall the comment corpus is high quality: comments explain mechanism,
invariants, and failure modes (e.g. `dreamer/lease.ts:100-107` on why
`BEGIN IMMEDIATE` rather than `db.transaction()`;
`storage-meta-persisted.ts:1422-1427` on `IS ?` vs `= ?` against NULL). The
violations are narrow and fully enumerated above.
