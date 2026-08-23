# Implementation Plan

This plan does not name an optimal embedding model. Public results admit candidates; only the frozen, judged Magic Context campaign below can promote one. Current repository anchors are:

- `EmbeddingPurpose` already reaches `EmbeddingProvider.embed` and `embedBatch`, but the local provider ignores it and always applies mean pooling plus normalization (`packages/plugin/src/features/magic-context/memory/embedding-provider.ts:3-4,46-71`; `embedding-local.ts:644-720`).
- Provider identity currently covers only a subset of semantic identity, while Synapse uses model plus fingerprint (`embedding-identity.ts:18-78`; `embedding-synapse.ts:57-79`).
- Primary and shadow registrations already isolate `modelId` and generation, reject stale completions, and backfill lazily (`project-embedding-registry.ts:1018-1160,2469-2573`).
- The judged harness already has immutable releases, development/holdout partitions, candidate-pool output, nDCG@10, Recall@50, raw latency samples, and three-run regression policy. It currently seeds deterministic hash vectors rather than model vectors (`retrieval-benchmark/contract.ts:27-171`; `metrics.ts:22-111`; `report.ts:35-217`; `runner.ts:578-604`; `seed.ts:50-55,429-480`).
- Synapse already has strict bundles, one process-global ORT identity, one inference permit, bounded jobs/results, semantic certification, and drain-on-shutdown ownership (`crates/mc-host/src/synapse/bundle.rs:108-183`; `inference.rs:27-34,58-109,177-265`; `mod.rs:35-112,164-203`; `docs/synapse-model-bundle.md:6-24,118-161`).

**Step 1: Freeze the campaign protocol and protect the final holdout**

**Complexity**: M

**What**: Add a reviewed `model-campaign/v1` control artifact at `packages/plugin/scripts/fixtures/retrieval-benchmark/model-campaign/v1/campaign.json`. Its strict schema lives in a proposed `packages/plugin/scripts/retrieval-benchmark/model-campaign.ts` and contains: development release fingerprint, final-holdout manifest fingerprint, exact treatment IDs, semantic-space IDs, execution-profile IDs, equal-input and model-native tracks, lexical/fused controls, metric policy, candidate-pool depth 50, three-run requirement, promotion-policy fingerprint, and a `finalHoldoutRunsAllowed` counter. Keep final-holdout corpus and judgments outside version control; use the existing `--release` plus `--release-fingerprint` trust boundary (`benchmark-retrieval.ts:60-67`). Add real failed queries and model-disagreement queries only to development drafts, promote them through the existing reviewed-release path, and freeze the final holdout before any candidate result is opened. Pool every treatment's top 50 plus lexical-only and fixed-fusion top 50; judge the union as relevant, nonrelevant, or unresolved. Do not tune recipes, dimensions, precision, shortlist, or thresholds after final-holdout access.

**Why**: EI-09, EI-29, and EI-47 show that the current 11-query holdout is a coarse rejection gate, not a close-ranking oracle, and that repeated adaptation contaminates it. The repository has 22 queries total and only 11 holdout queries, with two automatic holdout queries; repeated benchmark runs do not create new information needs. Topic-set error and reusable-holdout work support protected, paired evaluation rather than a universal minimum query count [2][3][4].

**Evidence**: NIST/SIGIR topic-set error; reusable holdout; MTEB-style pooled judged retrieval [1][2][3][4].

**Evidence quality**: Strong 4/5 evidence, High credibility, corroborated by four agents.

**Files**: `packages/plugin/scripts/benchmark-retrieval.ts`; `packages/plugin/scripts/retrieval-benchmark/{contract,index,promote,report}.ts`; `packages/plugin/scripts/fixtures/retrieval-benchmark/v1/**`; proposed `packages/plugin/scripts/retrieval-benchmark/model-campaign.ts`; proposed `packages/plugin/scripts/fixtures/retrieval-benchmark/model-campaign/v1/campaign.json`; owner-controlled final-holdout release outside the repository.

**Beads ownership**: `magic-context-3q5.27`. Reuse its judged benchmark and decision-record ownership; do not create another task or corpus system.

**Risks**: R1. Mitigate with a predeclared matrix, development-only hard-query growth, one fingerprinted final holdout, pooled top-50 judging, per-query deltas, and access counting.

**Acceptance criteria**:

- `bun packages/plugin/scripts/benchmark-retrieval.ts campaign-validate --campaign .../campaign.json` rejects unknown fields, mutable model revisions, missing treatment recipes, changed release fingerprints, and a second final-holdout run beyond policy.
- No final-holdout query text or judgment appears in Git; the committed artifact contains only its approved manifest fingerprint and policy metadata.
- A merged pool artifact accounts for every unique top-50 result from every frozen treatment and both controls; unjudged entries remain unjudged, never implicit grade 0.
- A dry run that changes one candidate dimension, transform, precision, or release fingerprint becomes campaign-incompatible before scoring.

**Step 2: Make recipe, purpose, semantic identity, and execution identity explicit**

**Complexity**: L

**What**: Extend `embedding-identity.ts`, not a new plugin system. Add:

```ts
export interface EmbeddingSpaceSpec {
    schemaVersion: "embedding-space/v2";
    model: { id: string; revision: string };
    modelArtifacts: readonly { name: string; sha256: string }[];
    tokenizerArtifacts: readonly { name: string; sha256: string }[];
    queryTransform: { id: string; template: string };
    passageTransform: { id: string; template: string };
    tokenizer: {
        paddingSide: "left" | "right";
        truncationSide: "left" | "right";
        maxInputTokens: number;
    };
    pooling: { kind: "mean" | "cls" | "last-token" | "graph"; output: string };
    dimensions: { native: number; emitted: number; reduction: "none" | "prefix" };
    precision: { weights: string; output: "f32"; calibrationSha256?: string };
    postprocess: readonly ("layer-normalize" | "prefix-truncate" | "l2-normalize")[];
}

export interface EmbeddingSpaceIdentity {
    id: `embedding-space:v2:${string}`;
    spec: EmbeddingSpaceSpec;
}

export interface EmbeddingExecutionIdentity {
    id: `embedding-execution:v1:${string}`;
    runtime: string;
    provider: string;
    target: string;
    artifacts: readonly { name: string; sha256: string }[];
}

export function createEmbeddingSpaceIdentity(spec: EmbeddingSpaceSpec): EmbeddingSpaceIdentity;
export function applyEmbeddingPurpose(
    spec: EmbeddingSpaceSpec,
    purpose: EmbeddingPurpose,
    text: string,
): string;
```

Extend `EmbeddingProvider` with `readonly space: EmbeddingSpaceIdentity`, `readonly execution: EmbeddingExecutionIdentity`, and retain `modelId` as `space.id` for existing storage call sites. Replace `LocalEmbeddingProvider`'s ignored `_purpose` with `applyEmbeddingPurpose`; make pooling/post-processing come from the closed recipe. Extend `SynapseCatalogEntry`, `SynapseLaneMetadata`, registry descriptors, and persisted rows with `space_id`, `space_spec_fingerprint`, and `execution_profile_id`. Query versus passage is host-selected; callers cannot supply arbitrary prompt text. Same model with any changed field creates another space and generation.

**Why**: EI-02, EI-03, EI-07, EI-08, EI-10, EI-44, and EI-45 agree that model name and dimensions are insufficient. E5, Nomic, BGE, and Qwen document materially different query/document and post-processing recipes [5][6][15][16][17]. Current local code ignores purpose, while current provider identity omits pooling, tokenizer artifacts, query transform, dimensions, and normalization order.

**Evidence**: E5 asymmetric instructions; Matryoshka operation order; owner model recipes; local generation guards [5][6][15][16][17].

**Evidence quality**: Strong 4/5 evidence, High credibility, corroborated across all five agents.

**Files**: `packages/plugin/src/config/schema/magic-context.ts`; `packages/plugin/src/features/magic-context/memory/embedding-{provider,identity,local,synapse}.ts`; `packages/plugin/src/features/magic-context/project-embedding-registry.ts`; related tests; storage migration files already owned by `magic-context-3q5.25`.

**Beads ownership**: `magic-context-3q5.25`; batching metadata remains `magic-context-3q5.26`.

**Risks**: R2, R6, R7. Mitigate with strict schemas, canonical hashing, purpose-spy tests, separate dimensions/precision IDs, generation guards, and no legacy fallback identity for newly admitted candidates.

**Acceptance criteria**:

- Two specs differing in any one of the 11 listed contract groups produce different `space.id` values; object key order produces the same ID.
- The exact MiniLM default retains a documented migration mapping from its legacy provider ID; every non-incumbent recipe uses `embedding-space/v2` and cannot collide with a legacy ID.
- Query and passage tests capture the literal transformed tokenizer input for every first-round treatment; symmetric MiniLM inputs remain identical.
- `project-embedding-registry` drops a completion when space ID, execution profile, or generation changes during inference, and search never scores a query vector against another space.
- Config and RPC request JSON cannot provide a free-form transform, artifact path, pooling choice, device, or execution provider.

**Step 3: Freeze the bounded candidate matrix and artifact provenance**

**Complexity**: L

**What**: Commit exactly the following first-round treatment set to `campaign.json`. Every mutable owner name is resolved to one immutable revision and every consumed file, including ONNX external data, is hashed before execution. `current-synapse-cpu` records the actual installed production manifest; it is an operational control and is deduplicated from GTE only when all semantic fields and hashes match.

| ID | Model and role | Required recipe | Dimensions/context | Precision and pooling | Provenance | First-round disposition |
|---|---|---|---|---|---|---|
| `minilm-xenova-fp32-384` | Exact TypeScript incumbent | Exact Xenova tokenizer; no purpose prefix; mean over attention mask; L2 | 384; equal-input 256 and certified deployed 256/512 boundary | fp32; mean | Deployed Xenova graph/tokenizer hashes; immutable revision | Required control; never replace with generic Sentence Transformers output. |
| `current-synapse-cpu` | Current Rust `mc-host` lane | Exact installed bundle manifest and corpus | Manifest dimensions/context | Manifest precision/pooling/output | Bundle, external-data, tokenizer, corpus, ORT hashes | Required operational control; not a model-name alias. |
| `bge-small-en-v1.5-384` | Lowest-risk challenger | Frozen query-only retrieval instruction; passage unchanged; CLS; L2 | 384/512 | owner/FastEmbed ONNX precision fixed in ID; CLS | `BAAI/bge-small-en-v1.5@5c38ec…` plus conversion hashes | Required task-floor treatment. |
| `nomic-v1.5-256` | CPU floor | `search_query:` / `search_document:`; mean; full-vector layer norm; prefix truncate; L2 | 256/8192 | fixed ONNX precision; mean | `nomic-ai/nomic-embed-text-v1.5@e9b676…` plus export hashes | Required task-floor treatment; separate from 512. |
| `nomic-v1.5-512` | CPU floor | Same ordered recipe | 512/8192 | fixed ONNX precision; mean | Same pinned source, distinct space | Required task-floor treatment. |
| `gte-modernbert-768` | Long-context CPU candidate | No prompt; owner tokenizer; CLS; L2 | 768/8192 | fp32 first; CLS | Owner-published ONNX at frozen revision | First round unless exact `current-synapse-cpu` already matches. |
| `arctic-m-v1.5-256` | CPU candidate | Query-only `Represent this sentence for searching relevant passages: `; documented pooling; prefix truncate; L2 | 256/512 | fp32 first | Owner ONNX at frozen revision | First-round sourced addition. |
| `arctic-m-v1.5-768` | CPU candidate | Same ordered recipe | 768/512 | fp32 first | Same owner revision, distinct space | First-round sourced addition. |
| `qwen3-0.6b-256` | Quality candidate | `Instruct: {frozen task}\nQuery:{query}`; documents unchanged; left padding; last-token; prefix truncate; L2 | 256/32768 | exact adapter precision in ID | Pinned Qwen revision `97b0c6…`; separately certified adapter/export or pinned TEI | Required task-floor treatment; matrix cannot close while blocked. |
| `qwen3-0.6b-512` | Quality candidate | Same recipe and frozen task text | 512/32768 | same certified path, distinct space | Same pinned source | Required task-floor treatment. |
| `bge-m3-dense-1024` | Dense experimental cell | No query instruction per card; exact dense output; L2 | 1024/8192 | owner ONNX precision fixed | Owner ONNX plus external data at frozen revision | Required task-floor dense cell; sparse/multi-vector outputs excluded. |

Jina code, Arctic l, Qwen3 4B, CodeRankEmbed, and EmbeddingGemma do not enter this first round. Jina v2 base code enters one second-round specialist cell only if the pooled exact-symbol/path and code-query slices remain a measured weakness. Arctic l enters GPU qualification as the owner-ONNX validity graph in Step 7. Qwen3 4B enters only if 0.6B wins quality and the certified VRAM tier can host the ceiling experiment. CodeRankEmbed waits for owner-controlled export plus componentwise parity. EmbeddingGemma waits for legal and redistribution approval. BGE-M3 hybrid remains a separate architecture experiment. No additional model enters without amending the frozen campaign before results are viewed.

Core entry/exit rules are fixed before results: BGE-small enters as the lowest-risk floor and leaves future rounds only if another eligible treatment weakly dominates it on both quality metrics and improves either p95 or footprint; Nomic 256 and 512, Arctic m 256 and 768, and Qwen3 256 and 512 are evaluated as separate spaces and each leaves only on the same dominance rule or failed parity; GTE enters as the current/long-context control and leaves only when its exact current Synapse role is represented by a byte-identical control or it is dominated; dense BGE-M3 leaves the dense matrix if it does not clear the promotion gate, while its hybrid mode never enters this matrix; Jina code enters only under the specialist trigger above and leaves if it fails to improve the code/symbol/path slice without violating global gates; Arctic l enters only GPU validity/qualification and leaves production consideration unless it independently clears Step 6. MiniLM and the current Synapse lane never leave the campaign because they are controls.

**Why**: EI-13, EI-14, EI-15, EI-18, EI-19, EI-22, EI-33, EI-36, EI-44, and EI-50 support this risk-ordered matrix. Public benchmark scores nominate but cannot promote candidates (EI-05) [1][14]-[23].

**Evidence**: Owner model cards and artifacts; FastEmbed implementation contracts; ONNX external-data format [14]-[23].

**Evidence quality**: Moderate-to-Strong 3-4/5 evidence, High credibility for artifact contracts, no in-domain quality claim.

**Files**: proposed `packages/plugin/scripts/fixtures/retrieval-benchmark/model-campaign/v1/campaign.json`; proposed `packages/plugin/scripts/retrieval-benchmark/embedding-candidates.ts`; candidate bundle directories supplied outside Git; `docs/synapse-model-bundle.md` for bundle rules.

**Beads ownership**: `magic-context-3q5.27` for matrix and decisions; `magic-context-bx3.2` for certified Synapse bundle/runtime fields; `magic-context-c50.6` remains the CPU baseline owner.

**Risks**: R2, R7, R8, R9. Mitigate with immutable revisions, complete hashes, license notices, exact recipes, separate dimensions/precisions, and a dense-only BGE-M3 label.

**Acceptance criteria**:

- Campaign validation reports exactly 11 treatment IDs, or 10 only when `current-synapse-cpu` and GTE are byte- and recipe-identical with an explicit dedup proof.
- Every treatment has non-placeholder revision, artifact hashes, tokenizer hashes, dimensions, context, precision, pooling/output, transform IDs, and license metadata.
- Qwen treatments remain `blocked`, not silently omitted or substituted, until componentwise parity and adapter certification pass.
- A changed external initializer, prompt byte, dimension, precision, pooling mode, or post-processing order changes the treatment and space IDs.

**Step 4: Extend the existing harness for real model treatments and two context tracks**

**Complexity**: L

**What**: Keep the existing runner and add one injected treatment seam, not another harness. Add:

```ts
export interface PreparedEmbeddingTreatment {
    treatmentId: string;
    space: EmbeddingSpaceIdentity;
    execution: EmbeddingExecutionIdentity;
    dimensions: number;
    documentVectors: ReadonlyMap<string, Float32Array>;
    embedQuery(text: string, signal: AbortSignal | undefined): Promise<Float32Array>;
    startupEvidence: {
        coldStartMs: readonly number[];
        baselineRssBytes: number;
        peakRssBytes: number;
        modelBytes: number;
    };
}
```

Add optional `treatment` to `RunBenchmarkOptions`. Default remains the deterministic CI treatment. `seedFixture` accepts frozen document vectors and `space.id`; `buildSearchOptions` uses the treatment's live query embedder and exact model IDs instead of `BENCHMARK_EMBEDDING_MODEL_ID`. Bump the strict report schema and record treatment/space/execution IDs, context track, raw query-embedding latency, startup samples, RSS/model bytes, and stage metrics. Equal-input uses identical current 256-token document windows and candidate depth for every model. Model-native uses each recipe's context and `compartment-chunk-embedding.ts` windowing, producing a distinct fixture/index identity. Add a second injected seam, `PreparedRetrievalArm`, carrying the lexical representation, the fusion rule, the fusion parameters, and the per-lane candidate depth, so the lexical lane and the current fixed fusion are arms rather than fixed controls; the incumbent full pipeline becomes the baseline arm A0 of the Comparison Benchmark Specification below. Run lexical-only and dense-only ablations beside every treatment so a gain is never credited to the wrong factor. Record end-to-end logical-request latency as the primary latency outcome and every `search-trace.ts` span as non-additive secondary evidence, because those spans are inclusive and may overlap while the file's conservation invariant covers only root time (`search-trace.ts:241-246`). Where reranking exists, preserve first-stage Recall@50 and final nDCG@10 plus end-to-end latency separately [24][25][40].

**Why**: EI-04, EI-38, EI-39, and EI-48 require lexical controls, equal-input/native-context separation, and stage-specific reporting. Existing deterministic vectors cannot rank models, and current `runner.ts:591-603` deliberately makes purpose quality-neutral. Chunking and model context interact [25]. The Comparison Benchmark Specification below promotes the lexical representation, the fusion rule, the fusion parameters, and the candidate depth from controls to treatments, so the harness must inject them rather than hold them fixed: the FTS5 `porter unicode61` plus `bm25()` choice and the fixed linear fusion are themselves untested design decisions [46][48].

**Evidence**: BEIR and GitHub code-search hybrid practice; Azure chunking guidance; retrieve-rerank evaluation; SQLite FTS5 tokenizer and `bm25()` contracts; rank-fusion alternatives [8][9][24][25][46][48].

**Evidence quality**: Moderate 3-4/5 evidence, High/Moderate credibility; implementation is a direct extension of executable repository contracts.

**Files**: `packages/plugin/scripts/retrieval-benchmark/{runner,seed,report,profiles,timing,metrics}.ts`; `packages/plugin/scripts/benchmark-retrieval.ts`; `packages/plugin/src/features/magic-context/compartment-chunk-embedding.ts`; `packages/plugin/src/features/magic-context/{search,search-trace}.ts`; proposed `packages/plugin/scripts/retrieval-benchmark/embedding-treatment.ts`; proposed `packages/plugin/scripts/retrieval-benchmark/retrieval-arm.ts`; tests and `fixtures/retrieval-benchmark/profiles/v1/**`.

**Beads ownership**: `magic-context-3q5.27`; provider/token-aware batch preparation uses `magic-context-3q5.26`.

**Risks**: R1, R2, R9. Mitigate with a deterministic default treatment for existing CI, strict treatment fingerprints, identical equal-input fixtures, separate native-context fixtures, and explicit lexical/dense/fused/stage labels. R9 now runs in both directions: an architecture gain must not be credited to the encoder and an encoder gain must not be credited to the architecture, which the mandatory lexical-only and dense-only ablations plus one-factor-per-arm composition enforce.

**Acceptance criteria**:

- Existing `check` output is byte-stable under the deterministic treatment except for the intentional report schema bump.
- A fixture seeded with treatment A refuses query vectors from treatment B before cosine scoring.
- Equal-input reports prove byte-identical document text and boundaries across treatments; model-native reports carry distinct fixture fingerprints.
- Each run emits per-query and per-category paired nDCG@10 and Recall@50, first-stage/final metrics when applicable, raw latency samples, p50/p95, cold-start samples, RSS delta, and model bytes.
- Lexical-only, dense-only where available, and current fused controls appear as separate result rows; BGE-M3 hybrid cannot appear under a dense treatment ID.
- Every architecture arm A0 through A21 of the Comparison Benchmark Specification is realizable through `PreparedRetrievalArm` without editing production defaults, and each result row carries its own arm fingerprint. An arm differing from A0 in more than one factor is rejected unless it is declared as an interaction arm with both single-factor arms present.
- Each run emits the full latency outcome set: end-to-end logical-request latency samples, p50/p95/p99, the eCDF and CCDF inputs, `deadline_success_fraction` against each declared deadline, terminal-outcome rates, and cold-start samples decomposed by component. Stage spans are emitted but the report refuses any field that sums or maxes stage percentiles into an end-to-end percentile.

**Step 5: Run development pooling, then one protected final evaluation**

**Complexity**: L

**What**: Execute all complete treatments on the development release in both tracks. Merge top-50 outputs from every declared first-round arm, which means the baseline arm A0, the encoder arms, the lexical-representation arms, the learned-sparse arm, the fusion arms, the candidate-depth arm, and the lexical-only and dense-only ablations; judge the union; add real failure/disagreement queries to a new development release; rerun until two consecutive pooled rounds leave arm ordering unchanged under bootstrap and leave-one-query-out diagnostics. This is a stability rule, not a universal query-count claim. Fusion-weight, penalty, boost, and candidate-depth sweeps run only on the development release, because sweeping against holdout outcomes would turn the holdout into training data. Then seal recipes, artifacts, arm compositions, re-derived gate thresholds, code build, and release fingerprints and run the final holdout once on the designated reference CPU host and, for GPU candidates, the certified GPU host. Retain both latency artifacts for every run: the per-run raw request samples that feed the existing policy gate, and the merged distribution that feeds eCDF and CCDF reporting. Emit immutable per-treatment reports plus one proposed `model-comparison/v1` report covering every arm.

**Why**: EI-05, EI-09, EI-29, EI-37, and EI-47 favor offline paired replay, pooled judgments, and protected holdout use. Supplementary searches found no independent Magic Context results and no universal minimum query count [1][2][3][4]. Because the architecture is open, the pool must cover architecture arms and not only encoder treatments, or a lexical or fusion winner's true top 50 would never be judged. Parameter sweeps are adaptive analysis and must stay off the holdout [4].

**Evidence**: MTEB/IR judged evaluation; topic-set error; reusable holdout; offline replay [1]-[4].

**Evidence quality**: Strong 4/5 evidence, High credibility; no candidate-quality conclusion before execution.

**Files**: reviewed release artifacts under `packages/plugin/scripts/fixtures/retrieval-benchmark/`; owner-only final release; generated reports under a proposed `docs/evidence/retrieval-benchmark/model-campaign/<campaign-id>/` after privacy review.

**Beads ownership**: `magic-context-3q5.27`.

**Risks**: R1, R9. Mitigate with development-only iteration, pooled judging, paired analysis, fixed fusion, final-holdout access control, and immutable evidence digests. With fusion no longer fixed, the same access control now also covers every fusion, tokenizer, and depth sweep, and the holdout access counter increments for architecture arms exactly as it does for encoder treatments.

**Acceptance criteria**:

- Every frozen treatment has three complete runs per required host/track, or a stable explicit `blocked` reason; no missing treatment is treated as a loss.
- Two successive development judgment rounds preserve top-two order under both paired bootstrap and leave-one-query-out; otherwise the campaign records `unstable` and does not open final holdout.
- Final reports match the sealed campaign, build, release, recipe, and execution fingerprints exactly.
- Privacy scan passes before any report is committed; raw private query text remains only in reviewed corpus artifacts approved for that location.
- The merged judgment pool accounts for every unique top-50 result from every declared first-round arm, including the lexical-only and dense-only ablations; an arm whose results were not pooled cannot be scored.
- No fusion-weight, single-source-penalty, source-boost, tokenizer, or candidate-depth sweep touches the final holdout, and campaign validation fails if a sealed arm composition or re-derived threshold differs from the one used in the last development round.
- Each run retains both latency artifacts with distinct digests: the per-run raw request samples used as the policy input, and the merged distribution used for reporting. Feeding a merged distribution to the policy gate, or a per-run p95 to an eCDF, is rejected.

**Step 6: Apply a promotion gate that can abstain**

**Complexity**: M

**What**: Implement comparison inside proposed `model-campaign.ts`, consuming existing validated reports. Predeclare the incumbent full pipeline, baseline arm A0, as comparator and nDCG@10 as primary quality endpoint, Recall@50 as protected secondary, stratified by mode and reported by category. The comparator is the whole pipeline including its lexical representation, fusion rule, fusion parameters, and candidate depth, not the encoder alone. An arm is promotion-eligible only when: (1) all three final runs are compatible; (2) paired query delta in nDCG@10 is positive in both modes; (3) the stratified paired-bootstrap 95% lower bound for overall nDCG@10 is above zero; (4) Recall@50 is not more than the re-derived allowance below the baseline arm in either mode; (5) dropping any one query does not reverse the overall winner; (6) median-of-three p95 is within the re-derived relative ceiling of the baseline arm and satisfies the campaign's non-null absolute p95 ceiling, `deadline_success_fraction` is not below the baseline arm at any declared deadline, and cold start is within its declared ceiling; (7) peak RSS/model bytes fit non-null campaign ceilings; and (8) index bytes, write amplification, and full-backfill wall clock fit non-null campaign ceilings. Quality, latency, footprint, and index cost are four separate gates required jointly; a large margin on one never waives another, so a quality win purchased with an unacceptable latency, footprint, or index-cost regression is not a win. If top arms overlap, leave-one-out reverses order, a category materially regresses, arm completeness differs, or a required threshold re-derivation is missing, verdict is `ABSTAIN`, not a tie-break by public score, and the incumbent pipeline stays exactly as it ships. A GPU treatment can promote only on this quality gate or on a separately predeclared operational tier: quality noninferior under the same bounds, median p95 at most 70% of the best eligible CPU lane, and RSS/model/peak-VRAM/cold-start ceilings all met. The 70% tier is project policy paying for GPU complexity, not a literature constant; changing it requires a new campaign fingerprint before results.

The inherited constants `maxAverageLossPoints = 2`, `maxSingleRunLossPoints = 5`, `maxMedianP95Percent = 110` (`fixtures/retrieval-benchmark/baselines/v1/policy.json`), and `TS_AUDIT_LATENCY_THRESHOLD_MS = 25` (`regression.ts:58`) were written against the current architecture. For any arm that changes the architecture rather than only the encoder, each must be re-derived and recorded with its derivation in the campaign artifact before results are opened; reusing them unexamined is a campaign-validation failure. They remain repository policy thresholds and are never reinterpreted as statistical confidence.

**Why**: EI-05, EI-09, EI-19, EI-29, EI-36, EI-39, and EI-47 require in-domain promotion, sensitivity reporting, and complete resource evidence. Existing regression policy already requires three runs, per-mode nDCG@10/Recall@50, and p95 at most 110% (`policy.json:1-21`); this step adds positive-win and abstention rules without reinterpreting policy thresholds as confidence. Because the architecture is open, the comparator is the full baseline arm and latency is a first-class gate rather than a secondary check; a rerank, learned-sparse, or multi-vector arm changes the stage set that the inherited ceilings were written against, so those ceilings are re-derived rather than inherited [41][43].

**Evidence**: MTEB and topic-set error; existing repository regression policy; stage-specific IR evaluation; benchmark-summary and tail-latency discipline [1]-[3][24][41][43].

**Evidence quality**: Strong for in-domain/paired abstention; Medium for project-specific resource thresholds, which are explicit policy rather than empirical claims.

**Files**: proposed `packages/plugin/scripts/retrieval-benchmark/model-campaign.ts`; `packages/plugin/scripts/retrieval-benchmark/regression.ts`; proposed `packages/plugin/scripts/fixtures/retrieval-benchmark/model-campaign/v1/policy.json`; comparison tests.

**Beads ownership**: `magic-context-3q5.27`; GPU activation consumes the verdict in `magic-context-bx3.4`.

**Risks**: R1, R5, R9. Mitigate with paired intervals, leave-one-out, explicit abstention, absolute and relative latency/footprint ceilings, and no public-score tie-break. With the architecture open, R9 additionally requires that every promotion record name the single factor the win is attributed to and cite the lexical-only and dense-only ablation rows that support that attribution.

**Acceptance criteria**:

- Synthetic comparator tests cover clear win, clear loss, overlapping interval, mode reversal, category regression, leave-one-out reversal, missing treatment, p95 failure, footprint failure, and GPU operational-tier pass/fail.
- The exact incumbent compared is `minilm-xenova-fp32-384`, not another MiniLM export.
- No default-config file changes when verdict is `ABSTAIN`, `INCOMPLETE`, or `UNSTABLE`.
- Any winning decision record cites campaign/report evidence digests and contains no leaderboard score as a gate input.
- Comparator tests additionally cover a quality win with a latency failure, a quality win with an index-cost failure, and a latency win with a quality failure; each yields no promotion. The four gates are evaluated and reported independently, and a verdict that clears fewer than four never promotes.
- An architecture arm submitted without a recorded re-derivation for each of `maxAverageLossPoints`, `maxSingleRunLossPoints`, `maxMedianP95Percent`, and `TS_AUDIT_LATENCY_THRESHOLD_MS` is rejected as campaign-incompatible before scoring.
- Every promotion record names the one factor the win is attributed to and cites the ablation rows supporting that attribution; a record attributing a win to the encoder without a dense-only row, or to the architecture without a lexical-only row, is rejected.
- An `ABSTAIN` verdict leaves the full incumbent pipeline unchanged, including its tokenizer, fusion rule, fusion constants, source boosts, and candidate depth.

**Step 7: Add one startup-selected Linux x86_64 NVIDIA CUDA ORT profile**

**Complexity**: L

**What**: Only after Step 6 justifies a GPU lane, add Cargo feature `synapse-cuda = ["ort/cuda"]` in `crates/mc-host/Cargo.toml`; do not enable FastEmbed's unrelated Candle `cuda` feature. Extend trusted startup configuration:

```rust
pub enum SynapseStartupPolicy { Cpu, Auto, CudaRequired }

pub struct SynapseLaneConfig {
    pub bundle_dir: PathBuf,
    pub runtime: RuntimeIdentity,
}

pub struct SynapseConfig {
    pub policy: SynapseStartupPolicy,
    pub cpu: SynapseLaneConfig,
    pub cuda: Option<SynapseLaneConfig>,
    pub limits: SynapseLimits,
}
```

`Auto` tries the approved CUDA lane before readiness and selects the separately identified CPU lane if eligibility/certification fails. `CudaRequired` disables Synapse on failure. There is one ORT session, one semaphore permit, one GPU device, and no request-time model/provider choice. Qualification registers one `CUDAExecutionProvider` with CPU fallback disabled and inspects ORT profiling/node assignment; every semantic graph node must be assigned to the approved provider set. Arctic l v2.0 owner ONNX is the first CUDA validity graph. Qwen3 uses GPU only after its separate adapter path and Step 6 evidence. Certification input must name exact GPU model/compute capability/VRAM, Linux/x86_64 target, driver, CUDA, cuDNN, ORT build/API, `ort`/FastEmbed versions, provider options, and hashes of every native library. Wildcards fail qualification.

**Why**: EI-11, EI-20, EI-21, EI-24, EI-25, EI-32, and EI-49 converge on the smallest lane. ORT documents explicit EP registration, compatibility requirements, and fallback/partition behavior [10][11][12][27][28].

**Evidence**: ORT execution-provider and CUDA requirements; Rust `ort` feature/API evidence; existing single-lane Synapse ownership [10]-[12][27][28].

**Evidence quality**: Moderate 3/5 evidence, High credibility, corroborated across all five agents.

**Files**: `crates/mc-host/Cargo.toml`; `crates/mc-host/src/synapse/{mod,inference}.rs`; `crates/mc-host/examples/synapse_host.rs`; Synapse tests; no new daemon or provider registry.

**Beads ownership**: contract in `magic-context-bx3.1`; certification in `magic-context-bx3.2`; bounded execution in `magic-context-bx3.3`.

**Risks**: R3, R4, R5. Mitigate with one certified tuple, fail-closed registration, node-assignment proof, one session/permit, and startup-only CPU selection.

**Acceptance criteria**:

- `cargo tree -p mc-host -e features` shows `ort/cuda` only in the GPU build and no TensorRT, ROCm/MIGraphX, DirectML, CoreML, Candle CUDA, download, or remote-model feature.
- With CPU fallback disabled, qualification fails if any semantic node lacks approved CUDA assignment or any provider/native library fails to load.
- Forced CPU, auto-with-GPU, auto-without-GPU, missing driver, wrong CUDA/cuDNN, insufficient VRAM, invalid GPU bundle, and forced-GPU failure all produce deterministic startup results.
- The active catalog exposes one lane only; no request field can select device, provider, runtime, or bundle.

**Step 8: Extend bundle, runtime, execution identity, and semantic certification for GPU**

**Complexity**: L

**What**: Bump the strict Synapse manifest and fingerprint format. Add closed recipe fields matching Step 2: literal query/passage transforms, tokenizer padding/truncation side, output, pooling (`mean|cls|last_token|graph`), emitted dimensions, dimension-reduction order, precision/calibration digest, normalization steps, all model/tokenizer/external-data hashes, and reference corpus hash. Replace `OrtIdentity` with:

```rust
pub struct NativeArtifactIdentity { pub name: String, pub path: PathBuf, pub sha256: String }
pub enum ExecutionProviderIdentity { Cpu, Cuda(CudaExecutionIdentity) }
pub struct CudaExecutionIdentity {
    pub target_gpu: String,
    pub compute_capability: String,
    pub min_driver: String,
    pub cuda: String,
    pub cudnn: String,
    pub options_fingerprint: String,
    pub native_dependencies: Vec<NativeArtifactIdentity>,
}
pub struct RuntimeIdentity {
    pub ort: NativeArtifactIdentity,
    pub provider: ExecutionProviderIdentity,
    pub execution_profile_id: String,
}
```

`LaneInfo` and `models.list` publish `semantic_space_id`, `semantic_recipe_fingerprint`, and `execution_profile_id`. The first GPU release always derives effective space identity from both semantic and execution IDs, so CPU/GPU spaces remain separate. Do not implement aliasing in the first release. Certification adds purpose-sensitive query/passage pairs, componentwise expected vectors, Unicode/code/error/truncation cases, finite/norm checks, cosine/rank checks, full provider-assignment evidence, and judged nDCG@10/Recall@50 on the exact tuple. Host-side versus graph-contained post-processing is allowed only as a manifest-fixed choice with componentwise parity.

**Why**: EI-02, EI-07, EI-08, EI-10, EI-22, EI-23, EI-30, EI-44, EI-46, and EI-50 require complete semantic/runtime identity and real-hardware certification. ONNX external-data files are part of the model [14]; ORT provider and precision can alter results [11][13].

**Evidence**: ONNX external-data specification; ORT CUDA and quantization; owner recipe contracts; immutable revision guidance [11][13][14][26].

**Evidence quality**: Moderate-to-Strong 3-4/5 evidence, High credibility.

**Files**: `crates/mc-host/src/synapse/{bundle,inference,mod,protocol}.rs`; `crates/mc-host/tests/synapse_{bundle,protocol,roundtrip}.rs`; `docs/{synapse-model-bundle,mc-host-wire-protocol}.md`; TypeScript `embedding-synapse.ts` and identity tests.

**Beads ownership**: `magic-context-bx3.2`; cross-language space contract in `magic-context-3q5.25`.

**Risks**: R2, R3, R4, R6, R7, R8. Mitigate with deny-unknown strict schemas, complete hashes, purpose-sensitive corpus, exact dependency closure, separate CPU/GPU spaces, and no alias path.

**Acceptance criteria**:

- Manifest tests reject one-byte changes to every recipe/artifact/runtime field, unlisted provider libraries, placeholder hashes, mutable revisions, and unsupported pooling/post-processing sequences.
- CPU-only bundles remain valid without fake GPU fields and retain CPU execution identity.
- Real-hardware certification detects wrong purpose transform, left/right padding, output, pooling, truncation, precision, dimensions, non-finite values, norm drift, rank drift, and unexpected CPU node assignment.
- CPU and GPU executions have different effective space IDs even when model bytes match; no alias certificate is accepted in the first release.

**Step 9: Bound admission, native-call ownership, OOM, cold start, and shutdown**

**Complexity**: L

**What**: Extend `SynapseLimits` with `max_batch_tokens`, `max_host_staging_bytes`, `max_peak_vram_bytes`, `max_cold_start_ms`, and `max_shutdown_drain_ms`; preserve existing row, request-byte, job, result, page, and retention caps (`mod.rs:40-81`). Tokenize and account before native admission. Keep one session and one permit. Add `InferenceError::ResourceExhausted { resource, reason }`. Inputs over a declared cap fail before native execution. OOM/device loss for an admitted within-cap request marks the lane failing, publishes no vector, and never reruns on CPU. Route cancellation cancels only queued wrappers or response waiting; a started native call stays tracked until completion. Do not claim ORT run cancellation preempts a GPU kernel [29]. Shutdown closes admission, cancels queued work, waits for tracker and device/session synchronization, records drain duration, then releases handler/instance ownership.

**Why**: EI-27, EI-28, EI-32, EI-41, and EI-49 show that provider-arena limits are not total VRAM, cancellation is not preemption, and bounded ownership must cover rows/tokens/bytes/jobs/results/calls. Current code already tracks started native calls and drains them (`mod.rs:169-178`).

**Evidence**: ORT CUDA memory semantics; ORT run-termination implementation; TEI's explicit batching/token limits [11][29][30].

**Evidence quality**: Moderate 2-3/5 evidence, High credibility for cancellation semantics and runtime bounds.

**Files**: `crates/mc-host/src/synapse/{mod,jobs,inference,protocol}.rs`; Synapse job/protocol/lifecycle tests; GPU measurement harness under existing smoke script.

**Beads ownership**: `magic-context-bx3.3`; shared capability descriptors in `magic-context-3q5.26`.

**Risks**: R5. Mitigate with exact caps, complete-process RSS/VRAM observation, limit-plus-one tests, one native call, no early ownership release, and fail-closed OOM handling.

**Acceptance criteria**:

- Exact-limit and limit-plus-one tests cover rows, per-input tokens/bytes, aggregate tokens/bytes, queued jobs/bytes, retained jobs/results, encoded page bytes, and active calls.
- Target-host evidence records p50/p95, throughput, baseline/peak RSS, model bytes, host staging bytes, complete peak VRAM, cold-start distribution, and shutdown drain at every admitted envelope corner.
- Injected OOM, provider reset, device loss, malformed output, native panic, route loss, and shutdown deadline overrun produce stable bounded outcomes and no suspect vector.
- A started native call remains owned after caller timeout/cancel and is joined before shutdown completes.

**Step 10: Implement startup selection, packaging, doctor, and real-host smoke**

**Complexity**: L

**What**: Extend existing daemon/doctor/package ownership only. Package one exact CPU runtime/bundle and, where approved, one exact CUDA runtime/bundle plus hashed native closure. Extend `packages/cli/src/lib/embedding-runtime.ts` subprocess probing to return redacted reasons for no GPU, unsupported GPU, driver/library mismatch, provider-load failure, insufficient VRAM, invalid bundle, semantic-certification failure, unexpected provider assignment, and healthy lane. Extend `packages/plugin/scripts/smoke-mc-host-synapse.ts` production mode to assert execution profile, node assignment, full operations, ambiguous replay, restart resubmission, atomic destination application, OOM recovery behavior, and shutdown cleanup. Network stays disabled; production smoke refuses toy bundles and unapproved campaign verdicts. Keep TensorRT, ROCm/MIGraphX, DirectML, CoreML, multi-GPU, external serving, hot reload, and runtime download out.

**Why**: EI-11, EI-21, EI-22, EI-25, EI-30, and EI-49 support one reproducible profile and no runtime download. Exact native closure is a startup compatibility unit [11][12][26][27].

**Evidence**: ORT CUDA compatibility; immutable Hugging Face revisions; conversion/remote-code supply-chain guidance [11][12][26][31].

**Evidence quality**: Moderate 3/5 evidence, High credibility.

**Files**: `packages/cli/src/lib/embedding-runtime.ts`; `packages/plugin/scripts/smoke-mc-host-synapse.ts`; `crates/mc-host/examples/synapse_host.rs`; package manifests; `docs/synapse-model-bundle.md`; install/runbook docs owned by daemon lifecycle.

**Beads ownership**: `magic-context-c50.8` and `magic-context-bx3.5`; startup model choice in `magic-context-bx3.4`.

**Risks**: R3, R4, R5, R8. Mitigate with child-process probing, exact package hashes, offline smoke, provider assignment checks, and deterministic CPU fallback.

**Acceptance criteria**:

- Doctor distinguishes every listed state without loading an unsafe native library in the CLI process.
- Real-GPU smoke passes on the exact certified tuple and fails on one deliberately missing provider dependency and one unexpected CPU-assigned node.
- CPU-only smoke proves `Auto` startup fallback and `CudaRequired` fail-closed behavior; runtime GPU failure never causes same-request CPU substitution.
- Release evidence contains feature graph, loaded-library hashes, node assignment, latency/throughput, RSS/VRAM, cold start, and shutdown drain.

**Step 11: Activate only an approved space through existing shadow, backfill, cutover, and rollback lanes**

**Complexity**: M

**What**: `magic-context-bx3.4` reads a committed Step 6 decision record at trusted startup. If absent, invalid, or non-winning, CPU remains active. Register the approved GPU or new CPU candidate through existing `registerProjectShadowEmbedding`; use its model/space ID, generation, bounded queue, persisted descriptors, and lazy historical backfill. Cut over only after required coverage and report fingerprints match. During partial backfill, semantic scoring uses only current-space vectors; uncovered documents remain eligible through lexical lanes. Rollback reselects the prior complete space on restart and never relabels vectors. Operational drift opens another campaign; it does not auto-promote a public model.

**Why**: EI-10, EI-23, EI-36, EI-43, and EI-49 require explicit activation and no cross-space fallback. The repository already has the needed generation checks and shadow backfill (`project-embedding-registry.ts:170-203,1074-1160,2469-2573`), so a new registry or recovery scheduler would duplicate owners.

**Evidence**: Existing repository generation/backfill mechanism; MLOps drift principle is advisory, while activation safety is enforced by local code [32].

**Evidence quality**: Strong local executable evidence; Medium external support. The under-supported EI-42 protocol is not used as evidence.

**Files**: `packages/plugin/src/features/magic-context/project-embedding-registry.ts`; storage embedding descriptors/migrations; `embedding-routing.ts`; config defaults only in a separate reviewed winning PR; rollout documentation.

**Beads ownership**: `magic-context-bx3.4`, `magic-context-3q5.25`, and `magic-context-3q5.27`. Packaging remains `magic-context-c50.8`/`magic-context-bx3.5`.

**Risks**: R6. Mitigate with distinct IDs/generations, coverage gates, lexical-only gaps, restart-tested rollback, and no same-request provider substitution.

**Acceptance criteria**:

- With no valid winning decision record, startup exposes the approved CPU lane and makes no default-model change.
- A partial backfill test returns lexical results for uncovered documents and performs zero cross-space cosine comparisons.
- CPU→GPU, GPU→CPU, candidate rollback, GPU disappearance, and interrupted backfill restart tests preserve old vectors under old IDs and resume/retire through existing bounded work.
- Default configuration changes only in a separate reviewed PR citing the committed campaign verdict and evidence digests.

## Comparison Benchmark Specification (architecture-open)

This specification fixes the CLAIM: what is observed, how each observation is defined, which arms are compared, and which outcomes decide. It does not fix the inference design. Treatment assignment, randomization and analysis units, nested replication, counterbalancing and order effects, A/A controls, power, minimum detectable effect, stopping rules, and multiplicity or alpha allocation are routed in subsection I. Nothing below asserts that the incumbent pipeline is adequate or that any candidate is better. Both are unknown until the campaign runs.

### A. Scope and non-negotiables

No shipping component is privileged because it ships. The whole retrieval architecture is open. Each of the following is a treatment under test, not a fixed control:

- **Lexical representation.** Memories, message history, and primers are SQLite FTS5 indexes declared `tokenize='porter unicode61'` and ranked by `bm25()` (`packages/plugin/src/features/magic-context/storage-db.ts:1282-1288` memories_fts, `1290-1297` message_history_fts, `970-976` primers_fts; `packages/plugin/src/features/magic-context/memory/storage-memory-fts.ts:23,47,122`). The FTS5 `trigram` tokenizer appears only in the notes lane (`migrations.ts:365-371`; `search.ts:1299-1325`, `NOTE_FTS_MIN_ATOM_LENGTH = 3` at `search.ts:1300`) [46][47].
- **Fusion rule and its constants.** `SEMANTIC_WEIGHT = 0.7`, `FTS_WEIGHT = 0.3`, `SINGLE_SOURCE_PENALTY = 0.8` (`search.ts:65-67`), applied at `search.ts:725-731`, `1576`, and `1884` [48].
- **Source boosts.** `MEMORY_SOURCE_BOOST = 1.3`, `MESSAGE_SOURCE_BOOST = 1.15`, `GIT_COMMIT_SOURCE_BOOST = 1.2`, `PRIMER_SOURCE_BOOST = 1.25` (`search.ts:77-80`), applied at `search.ts:1728-1731`.
- **Chunking policy** and the 256-token equal-input document window used by the equal-input track in Step 4.
- **Per-lane candidate depth.**
- **The absence of a reranking stage.**
- **The encoder**, including dimension and precision variants as separate semantic spaces.

The incumbent is represented by exactly one BASELINE ARM: the full production pipeline as configured today, carrying its own arm identity and fingerprint. It is the comparator. It is not an untouchable control and it can lose.

Latency is a first-class outcome with its own gate. It is not a footnote on a quality table.

Retrieval fans out across six lanes: memories, message history, compartment chunks, git commits, primers, and notes. For independent identical branches the probability that at least one branch misses is `P(any miss) = 1 - (1-p)^N`; for non-identical branches `1 - prod_i (1 - p_i)`. Both product forms assume branch independence. The six lanes share one SQLite file, one page cache, one query string, and one host, so they are correlated, and marginal per-lane percentiles are therefore not sufficient to reconstruct the user-visible tail. Every latency claim is measured end to end at the caller and is never assembled from per-lane statistics [43].

One hypothesis is recorded here as a hypothesis and nothing more. `porter unicode61` applies Porter stemming and Unicode-category token splitting, which is a plausible mismatch for identifiers, paths, error strings, and directives, where the exact surface form carries the signal. This weakness is NOT established in the research corpus for this repository. It becomes evidence only after the lexical ablation arms A3 through A6 are measured on the judged corpus. Until then it justifies running the arms and nothing else.

### B. Claim register

One register, presented as two panels keyed by the same scenario IDs because a single 13-column table is unreadable. Every field is fixed before any run. `LR` abbreviates logical request.

**Panel 1: observation contract.**

| ID | Scenario | System boundary | Timing start | Timing end | LR definition | Attempt definition | Terminal outcome set | Arrival model | Warm or cold |
|---|---|---|---|---|---|---|---|---|---|
| S1 | Interactive `ctx_search` retrieval | Public `ctx_search` entry to returned result page | Entry to the `root` span (`search-trace.ts:33`) | `root` span end, after the result page is materialized | One `ctx_search` call for one judged query under one arm and one context track | Identical to the LR; the harness performs no client retry, and this must be asserted, not assumed | success, error, deadline-exceeded, cancelled (AbortSignal), rejected (arm or space incompatibility refusal) | Not applicable: one outstanding LR, no generator, trace replay of a frozen query list | Steady state after a declared warmup regime; cold start is S9 |
| S2 | Query embedding | `embedQuery` call on the prepared arm | Call entry | Returned `Float32Array` | One query embedding for one LR | Identical to the LR | success, error, cancelled | Not applicable, serial inside S1 | Steady state; first call is S9 |
| S3 | Per-lane scan | One lane's `lexical_scan` or `vector_scan` span | Span begin | Span end | One lane scan inside one LR | Identical | ok, failed, cancelled, not_applicable (zero-length marker, `search-trace.ts:209-225`) | Not applicable, fan-out inside S1 | Steady state |
| S4 | Fusion | `fusion` span, `fusionStart` to `fusionEnd` | Span begin | Span end | One fusion pass inside one LR | Identical | ok, failed | Not applicable | Steady state |
| S5 | Hydration | Result-row materialization after fusion | First hydration read | Last hydration read | One hydration pass inside one LR | Identical | success, partial (documents uncovered by the current space), error | Not applicable | Steady state |
| S6 | Optional rerank | Rerank stage entry to reordered list | Stage entry | Stage exit | One rerank pass over the first-stage list inside one LR | Identical | success, error, deadline-exceeded, skipped (no rerank arm) | Not applicable | Steady state; model load is S9 |
| S7 | Document indexing and embedding throughput | Indexing job admission to durable row plus vector | Admission | Durable commit | One document indexing unit | Attempts exceed LRs when a completion is dropped on a generation change (`project-embedding-registry.ts:1018-1160`) | success, error, rejected (`ResourceExhausted`), dropped (stale generation) | Partly open with a bounded queue | Steady state after ramp-up |
| S8 | Full backfill or re-embedding | Backfill start to declared coverage | Backfill start | Coverage target reached | One backfill campaign over one corpus at one arm | Attempts include restart-resumed units | success, error, rejected, dropped, interrupted-and-resumed | Partly open with a bounded queue | Cold at start, steady state after ramp-up; both reported |
| S9 | Cold start | Process start to first successful embedding | Process start | First successful `embedQuery` return | One process cold start | Identical | ready, failed | Not applicable, one-shot per process | Cold only, by construction |

**Panel 2: estimand and outcome contract.** Ratio orientation is candidate over baseline arm throughout, so a latency ratio above 1.00 is slower and a quality ratio above 1.00 is better. Deltas are reported in metric points, not percentages.

| ID | Estimand and scale | Target population | Primary outcomes | Exploratory outcomes |
|---|---|---|---|---|
| S1 | Distribution of end-to-end LR latency in milliseconds, and paired per-query quality in metric points | Judged queries in the frozen release, at one arm, one track, one host fingerprint | Paired nDCG@10; Recall@50; eCDF and p50/p95/p99 of LR latency; `deadline_success_fraction` | CCDF of LR latency on log Y; per-category deltas; judged coverage; outcome rates |
| S2 | Distribution of query-embedding latency in milliseconds | Same judged query set | p50/p95/p99; eCDF | Token count per query; batch-of-one overhead |
| S3 | Distribution of per-lane scan latency in milliseconds, per lane | Same judged query set, stratified by lane | p50/p95 per lane; `not_applicable` counts | Decoded BLOB bytes; candidate depth executed against requested |
| S4 | Distribution of fusion latency in milliseconds | Same judged query set | p50/p95 | `candidatesIn` and `candidatesOut` |
| S5 | Distribution of hydration latency in milliseconds | Same judged query set | p50/p95; partial-hydration rate | Bytes hydrated |
| S6 | Distribution of rerank latency in milliseconds, plus first-stage against final quality | Same judged query set, rerank arms only | First-stage Recall@50; final nDCG@10; rerank p50/p95; added end-to-end latency | Rerank input width sensitivity |
| S7 | Mean indexing throughput in documents per second and in tokens per second, plus per-document latency distribution | Documents in the frozen corpus at one arm | Mean throughput; goodput; p50/p95 per-document latency; outcome rates | Queue depth; scheduler lag; capacity curve |
| S8 | Total wall clock in seconds to declared coverage, plus mean throughput | One corpus, one arm | Wall clock; mean throughput; goodput; outcome rates | Capacity curve; ramp-down recovery and hysteresis |
| S9 | Distribution of cold-start latency in milliseconds, decomposed by component | Repeated process cold starts at one arm | p50/p95 total cold start | Per-component split: model artifact load, ONNX Runtime session creation, tokenizer load, SQLite page cache warm, vector BLOB decode, and for GPU arms provider initialization and engine or kernel warmup |

Two rate outcomes accompany every latency outcome and are never omitted:

- `deadline_success_fraction = (successful valid requests completing within the declared deadline) / (valid requests)`.
- `goodput = (successful valid requests completing within the declared deadline) / (elapsed time)`.

The declared deadline must be non-null in the campaign artifact before any run. Round 1 declares two: the inherited `TS_AUDIT_LATENCY_THRESHOLD_MS = 25` for the 100K/384 audit cell (`regression.ts:58`), restated as a claim parameter rather than inherited truth, and a separate user-perception deadline for S1 that the campaign must set explicitly. A deadline-exceeded LR right-censors completion time: it is known only to exceed the deadline, so it is counted in the outcome rates and excluded from any completed-latency quantile, and the exclusion is disclosed. Reporting "latency" after silently dropping errors and timeouts yields latency conditional on success and is prohibited.

Statistic-to-question matching is fixed here so it is not renegotiated at reporting time. Mean for capacity, throughput, totals, and aggregate cost. Threshold proportion for a deadline objective [44]. eCDF to compare arms and read quantiles. CCDF with log Y for the extreme tail. Histogram or density to expose modes. Latency over time or a heatmap for warmup and drift. Load-response curve for offered load. `1/mean` is a throughput statement only for a single continuously busy serial worker at service time, and Little's Law relates means only [42]. No trimmed or winsorized mean is permitted for any user-facing or deadline claim; trimming appears only as a clearly labeled diagnostic [41].

### C. Factor and arm matrix

Nine factors with named levels. Every arm is a fully specified end-to-end pipeline with its own identity and fingerprint, so a win is attributable to one factor rather than to an unrecorded co-change.

| Factor | Levels | Round |
|---|---|---|
| F1 Encoder and semantic space | The 11 frozen Step 3 treatments, each dimension and precision variant a separate space | 1 (Qwen3 arms declared and `blocked`) |
| F2 Lexical representation | `porter unicode61` incumbent; unstemmed symbol-preserving `unicode61` with declared `tokenchars`; `trigram` on all lexical lanes; code-identifier-aware analyzer splitting camelCase, snake_case, and path separators while retaining the unsplit surface form | 1 |
| F3 Learned sparse lane | none (incumbent); BGE-M3 sparse replacing the FTS5 lexical lane | 1 for BGE-M3 sparse [49][51] |
| F4 Late interaction | none; BGE-M3 ColBERT multi-vector as a scoring lane [49][50] | Deferred to round 2 |
| F5 Fusion rule | fixed linear weights (incumbent); swept linear weights; Reciprocal Rank Fusion; score-normalization variant before linear combination | 1 |
| F6 Fusion parameters | `SINGLE_SOURCE_PENALTY` and the four source boosts at incumbent values, swept, and at the neutral 1.0 ablation | 1 |
| F7 Per-lane candidate depth | incumbent depth; swept depth grid | 1 |
| F8 Chunking and context track | equal-input 256-token window; model-native window per recipe | 1, both tracks, as already required by Step 4 |
| F9 Reranking stage | absent (incumbent); cross-encoder rerank over the first-stage list | Deferred to round 2 |

**First-round arms: 22.** Each runs in both F8 tracks where the arm's context permits.

| Arm | Composition | Purpose |
|---|---|---|
| A0 `arm-baseline-production` | Full incumbent pipeline: MiniLM `minilm-xenova-fp32-384`, `porter unicode61` plus `bm25()`, fixed linear fusion 0.7/0.3, penalty 0.8, boosts 1.3/1.15/1.2/1.25, incumbent depth, no rerank | Baseline arm and comparator |
| A1 `arm-lexical-only` | A0 with the dense lane disabled | Ablation: what the lexical lane alone achieves |
| A2 `arm-dense-only` | A0 with the lexical lane disabled | Ablation: what the encoder alone achieves |
| A3 `arm-lex-unstemmed` | A0 with unstemmed symbol-preserving `unicode61` | Isolates stemming and token splitting |
| A4 `arm-lex-trigram-all` | A0 with `trigram` on all lexical lanes | Isolates substring matching |
| A5 `arm-lex-code-identifier` | A0 with the code-identifier-aware analyzer | Isolates identifier and path handling |
| A6 `arm-sparse-bgem3` | A0 with BGE-M3 sparse replacing the FTS5 lexical lane | Learned sparse as a lexical alternative |
| A7 `arm-fusion-rrf` | A0 with Reciprocal Rank Fusion | Isolates the fusion rule, removing score-scale coupling |
| A8 `arm-fusion-swept-linear` | A0 with the linear weight swept on a declared grid under `w_semantic + w_lexical = 1` | Sensitivity curve for the inherited 0.7/0.3 |
| A9 `arm-fusion-normalized-linear` | A0 with a declared score normalization applied before linear combination | Isolates raw-score scale mismatch between cosine and `bm25()` |
| A10 `arm-fusion-neutral-priors` | A0 with `SINGLE_SOURCE_PENALTY = 1.0` and all four source boosts at 1.0 | Ablation of the inherited priors |
| A11 `arm-depth-swept` | A0 with per-lane candidate depth swept on a declared grid | Recall against latency trade curve |
| A12 `arm-enc-current-synapse-cpu` | A0 with the installed Rust `mc-host` bundle as the encoder | Operational control from Step 3 |
| A13 `arm-enc-bge-small-384` | A0 with `bge-small-en-v1.5-384` | Encoder swap only |
| A14 `arm-enc-nomic-256` | A0 with `nomic-v1.5-256` | Encoder swap only |
| A15 `arm-enc-nomic-512` | A0 with `nomic-v1.5-512` | Encoder swap only |
| A16 `arm-enc-gte-modernbert-768` | A0 with `gte-modernbert-768` | Encoder swap only |
| A17 `arm-enc-arctic-m-256` | A0 with `arctic-m-v1.5-256` | Encoder swap only |
| A18 `arm-enc-arctic-m-768` | A0 with `arctic-m-v1.5-768` | Encoder swap only |
| A19 `arm-enc-bge-m3-dense-1024` | A0 with `bge-m3-dense-1024` | Encoder swap only, dense output only |
| A20 `arm-enc-qwen3-256` | A0 with `qwen3-0.6b-256` | Declared, `blocked` until parity and adapter certification pass |
| A21 `arm-enc-qwen3-512` | A0 with `qwen3-0.6b-512` | Declared, `blocked` until parity and adapter certification pass |

Ablation requirement: A1 and A2 must run in every round. Without them a lexical or fusion gain can be credited to the encoder and an encoder gain can be credited to the architecture. Any arm changing more than one factor relative to A0 is rejected by campaign validation unless it is explicitly declared as an interaction arm with both single-factor arms also present.

Deferred combinations and their entry triggers: F4 late interaction enters round 2 only if A6 shows a measured exact-token gain that dense plus lexical cannot reach; F9 reranking enters round 2 only if first-stage Recall@50 at some arm materially exceeds that arm's nDCG@10 headroom, which is the only condition under which a reordering stage can pay for its added latency; full F2 by F5 crossings enter round 2 only if both single-factor families show non-overlapping effects.

**Constants under test.** Each inherited constant is re-derived or swept. None is inherited by assumption.

| Constant | Location | Equation or objective it encodes | Round-1 treatment |
|---|---|---|---|
| `SEMANTIC_WEIGHT = 0.7` | `search.ts:65` | `score = w_s * s + w_f * f` with `w_s + w_f = 1`, one free parameter | Swept in A8; A7 and A9 remove the assumption that raw cosine and `bm25()` are on a combinable scale |
| `FTS_WEIGHT = 0.3` | `search.ts:66` | Complement of `SEMANTIC_WEIGHT` under the sum constraint | Swept jointly in A8 |
| `SINGLE_SOURCE_PENALTY = 0.8` | `search.ts:67`, applied `728`, `731`, `1576` | Multiplicative prior that a one-lane hit is weaker evidence than a two-lane hit | Swept, with 1.0 ablation in A10 |
| `MEMORY_SOURCE_BOOST = 1.3` | `search.ts:77`, applied `1728` | Per-source prior multiplier on fused score | Swept, with 1.0 ablation in A10 |
| `MESSAGE_SOURCE_BOOST = 1.15` | `search.ts:78`, applied `1731` | Same | Swept, with 1.0 ablation in A10 |
| `GIT_COMMIT_SOURCE_BOOST = 1.2` | `search.ts:79` | Same | Swept, with 1.0 ablation in A10 |
| `PRIMER_SOURCE_BOOST = 1.25` | `search.ts:80` | Same | Swept, with 1.0 ablation in A10 |
| `NOTE_FTS_MIN_ATOM_LENGTH = 3` | `search.ts:1300`, filter at `1322` | Hard property of the FTS5 `trigram` tokenizer, which cannot represent an atom shorter than three characters [46] | Fixed while `trigram` is in use; any replacement tokenizer must state its own minimum, and A3 through A6 must each declare theirs |
| `METRIC_CUTOFFS = [10, 50]` | `metrics.ts:24` | 10 models what the user reads; 50 models first-stage sufficiency for a later reordering stage | 10 held; 50 re-derived against the actual rerank input width if F9 enters |
| `TS_AUDIT_LATENCY_THRESHOLD_MS = 25` | `regression.ts:58` | Absolute run-level p95 ceiling for the 100K/384 audit cell | Re-derived per arm, because a rerank, sparse, or multi-vector arm changes the stage set the ceiling was written against |
| `maxAverageLossPoints = 2` | `fixtures/retrieval-benchmark/baselines/v1/policy.json` | Tolerated average quality loss in metric points against the baseline | Re-derived for an architecture change; not reused unexamined |
| `maxSingleRunLossPoints = 5` | Same artifact | Per-run quality floor in metric points | Re-derived |
| `maxMedianP95Percent = 110` | Same artifact | Relative latency ceiling on median-of-run p95 | Re-derived |
| Per-lane candidate depth | `search.ts` lane limits | Recall against scan cost | Swept in A11 |
| 256-token equal-input window | Step 4 equal-input track | Holds document input byte-identical to isolate the encoder | Held for the equal-input track; replaced by model-native windows in the native track |

### D. Outcome definitions

**Quality.** Per-query and per-category paired nDCG@10 and Recall@50 under the existing `retrieval-metric-policy/v1` (`metrics.ts:22-26`), with relevance defined as judged grade at or above 1 (`metrics.ts:30-32`), unjudged pairs excluded from condensed scoring and reported through coverage counts rather than coerced to grade 0 (`metrics.ts:139,187-198`), and both the physical and condensed rank views retained. Judged coverage is reported for every arm and every category. Where a rerank arm is present, first-stage recall is reported separately from final ranking quality. Per-category exact-token slices are mandatory: paths and symbols, error strings, and directives. These are the slices where the F2 and F3 arms are expected to separate if they separate at all.

**Latency.** The primary latency outcome is end-to-end user-visible LR latency at the S1 boundary. Per-stage decomposition from `search-trace.ts` is secondary and explicitly NON-ADDITIVE: stage spans are inclusive and may overlap, the file's own conservation invariant is `coveredMs + uncoveredMs === rootDurationMs` while the sum of clipped child durations may exceed `rootDurationMs` (`search-trace.ts:241-246`). Therefore stage percentiles are never summed into an end-to-end percentile and max-of-stage-p99 is never reported as end-to-end p99. Reported per arm: p50, p95, p99, the eCDF, and the CCDF on log Y for the tail; `deadline_success_fraction` against each declared deadline; outcome rates. Cold start is reported separately from steady state, decomposed into the S9 components. `%util` is not reported for any parallel resource; queue depth and per-operation latency replace it, and throughput is measured at fixed latency rather than latency at fixed throughput.

**Cost and footprint.** Index bytes per arm, split by lane and by dense against lexical against sparse; write amplification per indexed document; embedding throughput; indexing wall clock; baseline and peak RSS; model bytes; peak VRAM for GPU arms.

**Correctness and safety.** Outcome rates for every scenario, judged coverage, and every refusal or fallback event, including space-mismatch refusals and lexical-only fallbacks for documents uncovered by the current space.

### E. Instrumentation and storage plan

Per query, per arm, per track, per run: query ID, category, arm ID and fingerprint, track, lane set, terminal outcome, LR latency, every `search-trace.ts` span with stage, lane, status, and inclusive bounds, candidate depth requested against executed (`search-trace.ts:419-429`), decoded BLOB and warm-cache vector bytes, ranked locators, and judged coverage counts.

Per run: host fingerprint, build fingerprint, release fingerprint, campaign fingerprint, observation count, run index, and the counters that prove harness validity.

**Latency distribution representation.** One mergeable representation is declared per campaign, with its error contract and configuration recorded in the report:

| Representation | Error contract | Required configuration disclosure |
|---|---|---|
| HdrHistogram | Fixed relative value error inside a configured dynamic range | `lowestDiscernibleValue`, `highestTrackableValue`, `numberOfSignificantValueDigits`, out-of-range count [36] |
| DDSketch | Approximately constant relative value error | Relative accuracy, bin limit, collapse count [37] |
| Native or OpenTelemetry exponential histogram | Value-space error; quantiles are computed at query time | Scale, max bucket count, zero-count and overflow counts [39] |
| KLL | Bounded rank error | `k`, retained item count [38] |

A percentile is a query result, not an aggregatable structure. Percentiles are never averaged across hosts, runs, or windows, never added across stages, and never combined as a max. Distributions are merged first and quantiles are read from the merge [40].

**Two artifacts, never interchanged.** The existing regression gate consumes one run-level p95 per matrix cell computed from raw request samples only, then aggregates with `median-of-run-p95`; pooled cross-run samples and averaged worker or query percentiles are rejected as policy inputs (`regression.ts:96,298-314`; `policy.json` `runLevelP95Input: "raw-request-samples"`, `runAggregation: "median-of-run-p95"`). That rejection is deliberate and is preserved unchanged. The new requirement is additive: per-run raw samples and the merged distribution are additionally retained as the REPORTING substrate for eCDF and CCDF. The policy input remains the per-run p95 under the versioned nearest-rank rule `retrieval-timing-policy/v1`; the reporting substrate is a separate artifact and is never fed to the gate.

**Tail resolution is finite and disclosed.** `nominal_tail_obs(q) = n * (1 - q)` is reported next to every quantile. More samples do not create independence when requests are correlated, so the independent-run count is reported alongside the observation count and no quantile is claimed beyond its nominal tail support.

**Generator and harness validity counters** are required for every scenario with concurrency, meaning S7 and S8: intended, scheduled, sent, admitted, completed, rejected, dropped, timed-out, delayed starts, scheduler lag, and generator headroom. A completion-coupled generator self-throttles against an exogenous target, and omitting scheduled or queueing delay from the timing boundary produces coordinated omission [33][34]. For S1 through S6 and S9 the arrival model is declared not applicable with one outstanding LR, and the campaign must assert that no generator exists rather than leaving it implied [35].

### F. Reporting contract

Required tables, one row per arm per track per category cell:

1. Quality: n judged, judged coverage, nDCG@10, Recall@50, paired delta against A0 in metric points, and for rerank arms first-stage recall beside final quality.
2. Latency: observation count, independent-run count, p50, p95, p99, `nominal_tail_obs` at each reported quantile, `deadline_success_fraction` per declared deadline, and outcome rates.
3. Footprint and index cost: index bytes by lane class, write amplification, embedding throughput, indexing wall clock, baseline and peak RSS, model bytes, peak VRAM.
4. Cold start: p50 and p95 total plus the S9 component split.

Required charts, selected by the rule in subsection B:

1. eCDF of LR latency, one curve per arm, for comparing arms and reading quantiles.
2. CCDF on log Y, one curve per arm, for the extreme tail.
3. Latency over time per run, for warmup and drift.
4. Load-response curve for S7 and S8 only: offered, admitted, completed, goodput, error and timeout and rejection rates, p50, p99, p99.9, queue depth, and scheduler lag against offered load, with ramp-up separated from measurement and a ramp-down segment to check recovery and hysteresis. Capacity is reported as the highest sustained offered load meeting the declared latency and error objective with stable backlog, and never as a single number without its curve.
5. Per-category quality delta against A0, one panel per arm.

Mix handling is explicit. The query mix across categories is held constant across arms, or reweighted to a declared reference mix. For means, `mean_ref = sum_k (w_k * mean_k)`. For percentiles, the DISTRIBUTIONS are weighted, `F_ref(x) = sum_k (w_k * F_k(x))`, and the percentile is read off `F_ref`. Weighting percentiles directly is prohibited.

Every result is reported per cell. No suite-level summary of the form "up to X percent faster" or "X percent better" is permitted, in any table, chart, caption, or decision record [41]. Mandatory disclosure on every table: observation count, independent-run count, host fingerprint, distribution representation and its configuration, dropped and overflow counts, and judged coverage.

### G. Decision rule

Four gates, evaluated separately and required jointly. An arm wins only by clearing all four against A0.

1. **Quality gate.** Paired per-query nDCG@10 delta positive in both context tracks; the stratified paired-bootstrap lower bound above zero; Recall@50 within the re-derived loss allowance in both tracks; no material per-category regression; leave-one-query-out does not reverse the winner.
2. **Latency gate.** Median-of-run p95 within the re-derived relative ceiling and within the campaign's non-null absolute p95 ceiling; `deadline_success_fraction` not below A0 at every declared deadline; any eCDF crossing where an arm wins in the tail but loses in the body, or the reverse, stated explicitly rather than summarized away; cold start within its declared ceiling.
3. **Footprint gate.** Baseline and peak RSS, model bytes, and peak VRAM within non-null campaign ceilings.
4. **Index-cost gate.** Index bytes, write amplification, and full-backfill wall clock within non-null campaign ceilings.

The inherited constants `maxAverageLossPoints = 2`, `maxSingleRunLossPoints = 5`, `maxMedianP95Percent = 110`, and `TS_AUDIT_LATENCY_THRESHOLD_MS = 25` are repository policy written against the current architecture. For an arm that changes the architecture rather than only the encoder, each must be re-derived and recorded in the campaign artifact with its derivation before results are opened. Reusing them unexamined is a campaign-validation failure. They are policy thresholds, not statistical confidence statements, and this specification does not convert them into one.

A quality win purchased with an unacceptable latency, footprint, or index-cost regression is not a win. Gates do not trade against each other and no gate is waived by a large margin on another.

Ties, overlapping intervals, leave-one-out reversal, per-category regression, differing arm completeness, or a missing re-derivation all produce `ABSTAIN`. Abstention is a legitimate and expected outcome. It keeps the incumbent pipeline exactly as it ships, changes no default configuration file, and is not a tie-break opportunity for public leaderboard scores.

### H. Threats to validity

| Threat | Mechanism | Mitigation | Risk ID |
|---|---|---|---|
| Coordinated omission | A completion-coupled generator self-throttles, or scheduled and queueing delay falls outside the timing boundary, so the recorded tail is optimistic | Declare the arrival model per scenario; assert no generator for S1 through S6 and S9; record the full intended-to-completed counter chain for S7 and S8; include scheduling delay in the S7 and S8 boundary [33][34][35] | R1 |
| Holdout contamination and adaptive tuning | Sweeping F5 through F7 against holdout outcomes turns the holdout into training data | Sweeps run only on the development release; the holdout opens once, after arms, constants, and gate thresholds are sealed; the access counter from Step 1 covers architecture arms as well as encoder treatments [4] | R1 |
| Small-topic-set instability | Few judged queries let one or two queries decide an ordering, and 22 arms multiply the chance of a spurious leader | Paired per-query analysis; leave-one-query-out; the two-round stability rule from Step 5 extended to all arms; multiplicity routed to the experiment-design owner [2][3] | R1 |
| Mix shift and Simpson's paradox | An arm can win every category and lose the aggregate, or the reverse, when category weights differ across arms | Hold the mix constant or reweight to a declared reference; report every cell; weight distributions rather than percentiles for aggregate quantiles [45] | R1 |
| Lane correlation defeating independence | The six lanes share one SQLite file, one page cache, and one host, so per-lane marginals do not compose into the user-visible tail through the product forms in subsection A | Measure end to end at the caller; treat stage decomposition as non-additive diagnostic evidence only [43] | R9 |
| Host and thermal drift | A long campaign drifts, and the latency baseline binds one exact host fingerprint (`regression.ts:132,155,183,478,886`) | One reference host per lane class; host fingerprint asserted per run; latency over time charted per run; A/A mechanical check retained as integrity evidence and never read as a noise floor (`regression.ts:19,975-976`) | R1, R5 |
| Warmup misdeclaration | A declared steady state that has not been reached mixes cold and warm regimes into one distribution | Test that the declared post-warmup regime is reached rather than assuming an iteration count; report cold start and steady state separately; enumerate the S9 components | R5 |
| Attribution error between encoder and architecture | A fusion or tokenizer gain is credited to the encoder, or an encoder gain is credited to the architecture | A1 and A2 ablations mandatory in every round; one factor changed per arm; interaction arms require both single-factor arms present; arm fingerprints recorded per result row | R9 |
| Sparse and multi-vector output mislabeling | BGE-M3 sparse or ColBERT results appearing under a dense arm ID would misattribute an architecture gain to an encoder | A6 and any F4 arm carry their own arm IDs; a dense arm ID cannot emit sparse or multi-vector results, as already required by Step 3 and Step 4 | R9 |
| Rare failure modes judged by frequency | A low-probability space-mismatch or dropped-completion path can carry high impact | Rare failure modes are evaluated by expected loss, probability times impact, not frequency alone | R2, R6 |

Evidence-class separation is enforced. Judged-corpus arm comparisons are controlled interventions. Any production usage telemetry is observation and cannot substitute for an intervention. Any projection beyond the measured corpus size, query mix, or host is a model, and it must state its assumptions and pass out-of-sample validation before it enters a decision record.

### I. Out of scope here and routed elsewhere

| Question | Owner |
|---|---|
| Treatment assignment, randomization and analysis units, nested replication, counterbalancing and order effects, A/A controls, power, minimum detectable effect, stopping rules, multiplicity and alpha allocation | `/quantitative-analysis:benchmark-experiment-design` |
| Exact-artifact execution and evidence retention | `/performance:bench-compare` |
| Final repository-policy classification from valid bounds | `/performance:perf-regression` |

This specification fixes the claim. It does not fix the inference design, does not execute the campaign, and does not issue the policy verdict.

## Evidence Trail

| Plan Step | Research Finding(s) | Evidence Strength | Credibility | Confidence |
|---|---|---|---|---|
| 1 | EI-09, EI-29, EI-47 | HIGH | HIGH | HIGH |
| 2 | EI-02, EI-03, EI-07, EI-08, EI-10, EI-44, EI-45 | HIGH | HIGH | HIGH |
| 3 | EI-05, EI-13-EI-19, EI-22, EI-33, EI-36, EI-50 | MEDIUM | HIGH | MEDIUM |
| 4 | EI-04, EI-38, EI-39, EI-48 | MEDIUM | HIGH | MEDIUM |
| 5 | EI-05, EI-09, EI-29, EI-37, EI-47 | HIGH | HIGH | HIGH |
| 6 | EI-05, EI-09, EI-19, EI-29, EI-36, EI-39, EI-47 | HIGH | HIGH | HIGH |
| 7 | EI-11, EI-20, EI-21, EI-24, EI-25, EI-32, EI-49 | MEDIUM | HIGH | MEDIUM |
| 8 | EI-02, EI-07, EI-08, EI-10, EI-22, EI-23, EI-30, EI-44, EI-46, EI-50 | HIGH | HIGH | HIGH |
| 9 | EI-27, EI-28, EI-32, EI-41, EI-49 | MEDIUM | HIGH | MEDIUM |
| 10 | EI-11, EI-21, EI-22, EI-25, EI-30, EI-49 | MEDIUM | HIGH | MEDIUM |
| 11 | EI-10, EI-23, EI-36, EI-43, EI-49 | MEDIUM | HIGH | HIGH |
| CBS-A (scope and non-negotiables) | EI-04, EI-05, EI-18, EI-36 | HIGH | HIGH | HIGH |
| CBS-B (claim register) | EI-04, EI-38, EI-39, EI-48 | MEDIUM | HIGH | MEDIUM |
| CBS-C (factor and arm matrix) | EI-04, EI-05, EI-18, EI-36, EI-48 | MEDIUM | HIGH | MEDIUM |
| CBS-D (outcome definitions) | EI-04, EI-09, EI-39, EI-47 | HIGH | HIGH | HIGH |
| CBS-E (instrumentation and storage) | EI-09, EI-47 | MEDIUM | HIGH | MEDIUM |
| CBS-F (reporting contract) | EI-05, EI-09, EI-47 | HIGH | HIGH | HIGH |
| CBS-G (decision rule) | EI-05, EI-09, EI-19, EI-29, EI-36, EI-47 | HIGH | HIGH | HIGH |
| CBS-H (threats to validity) | EI-06, EI-09, EI-29, EI-47 | HIGH | HIGH | HIGH |
| CBS-I (routing and scope limits) | EI-05, EI-09 | MEDIUM | HIGH | MEDIUM |
| CBS-N1 (hypothesis: `porter unicode61` stemming and Unicode splitting degrade exact identifier, path, error-string, and directive matching in this repository) | none | NOVEL | n/a | n/a |

**CBS-N1 validation note (mandatory).** This hypothesis is not in the research corpus. No cited source measures `porter unicode61` against Magic Context identifier, path, error-string, or directive queries. It is recorded only to justify running arms A3 through A6 and it must not be cited as evidence, used to weight a prior, or referenced in a decision record. It becomes evidence, or is refuted, only after A3 through A6 report per-category exact-token slices on the judged development corpus, with A1 present so the effect is attributable to the lexical representation rather than to the encoder. If those arms show no separation on those slices, the hypothesis is recorded as refuted and the incumbent tokenizer stands.

Rows CBS-A through CBS-I inherit their findings from the same executable repository contracts and IR-evaluation sources as Steps 4 through 6. The measurement-discipline sources [33]-[45] supply method rather than in-domain claims, so they raise no confidence about which arm wins. Project-specific thresholds in Step 6 and in CBS-G are versioned repository policy, not claims of universal optimality, and CBS-G requires each to be re-derived before it applies to an architecture change. One NOVEL row appears, CBS-N1, with the mandatory validation note above. No LOW row appears.

## Alternatives

| Contested decision | Chosen first path | Switch condition | How speculation is avoided |
|---|---|---|---|
| Qwen through pinned TEI vs owner-controlled ONNX/direct ORT | Use pinned, air-gapped TEI only as the first exact benchmark adapter if no parity-certified owner-controlled ONNX export exists. Production stays inside Synapse. | Switch to direct ORT only when a pinned export passes componentwise owner-reference parity, full CUDA node assignment, dependency closure, and the same judged campaign. Switch production to TEI only if Qwen wins and measured batching/isolation benefit pays for another process/API. | No generic serving interface, sidecar lifecycle, or Qwen production path is built before a measured win. |
| Host-side vs graph-contained post-processing | Prefer host-side transforms/post-processing where FastEmbed/Synapse can express the exact owner recipe and test each step. | Use graph-contained processing when owner graph includes it or host code cannot reproduce it without a new kernel; require graph hash, declared output, and componentwise parity. | Manifest records one closed choice; no runtime strategy abstraction. |
| CUDA ORT vs later providers | One Linux x86_64 NVIDIA CUDA ORT EP. | TensorRT only after a CUDA-qualified winner misses a predeclared latency/VRAM target and engine-cache/profile costs are measured. ROCm/MIGraphX, DirectML, or CoreML require a supported deployment target and their own task/certification matrix. | Cargo and startup enums contain only CPU/CUDA; no provider registry or automatic provider search. |
| CPU/GPU identity aliasing | Separate effective spaces in the first release. | Consider a one-pair alias only after exact real-hardware corpus tests pass structural, componentwise, Unicode/code/truncation, cosine/rank, and judged nDCG@10/Recall@50 tolerances across repeated cold starts. Execution IDs remain distinct. | No general alias registry is added. Default separation needs no certificate machinery. |
| Dense candidate vs BGE-M3 hybrid | Run BGE-M3 dense 1024 only in the model campaign; retain lexical/current fusion as controls. | Start a separate architecture experiment only if dense+existing fusion leaves measured exact-token/category failures and BGE-M3 sparse/multi-vector benefits justify new index, scorer, latency, identity, and rollback contracts. | Hybrid outputs cannot share a dense treatment ID or report row. |

## Validation Strategy

1. **Quality and integrity**: Strict campaign/release/report schemas; immutable fingerprints; complete candidate matrix; pooled top-50 judgments; no implicit grade 0; three runs; paired per-query/category nDCG@10 and Recall@50; bootstrap and leave-one-query-out; lexical/dense/fused and first-stage/final separation; final holdout access gate.
2. **Artifact parity**: For every candidate, compare tokenizer inputs and componentwise vectors against the pinned owner reference over ASCII, Unicode, code, symbols, paths, errors, empty/short text, exact truncation boundary, over-boundary text, query/passage, and every emitted dimension. Hash model, tokenizer, external data, corpus, runtime, and calibration bytes.
3. **Unit/property tests**: Canonical identity is key-order invariant and one-field sensitive; transform selection is purpose-sensitive; dimensions/precision never alias; generation changes discard stale completions; parser bounds hold at limit and limit-plus-one. Property-test canonical ID serialization and bounded arithmetic. Use Kani only for checked reservation/size arithmetic if ordinary property tests cannot cover overflow state space. Use Miri only for any new unsafe native-wrapper code; neither proves GPU numerical correctness.
4. **Real GPU smoke**: Exact target tuple, provider registration, full node assignment with CPU fallback disabled, structural/semantic corpus, all four Synapse operations, restart replay, provider failure, OOM, and shutdown. Native GPU correctness requires reference parity plus real-device execution, not Miri or Kani.
5. **Dependency closure**: `cargo tree -e features`, loaded-library inventory, hashes, offline startup, no runtime download, no unapproved EP, license notices, and subprocess doctor probe.
6. **Resource/failure tests**: Rows, tokens, bytes, jobs, results, host staging, RSS, VRAM, cold/warm startup, sustained soak, OOM/device loss, native panic, caller timeout, route loss, and bounded shutdown. Soak until RSS/VRAM and retained-job counts return to a stable envelope after repeated batches and restarts.
7. **Rollback/restart**: CPU↔GPU startup matrix, invalid decision record, interrupted lazy backfill, partial coverage, GPU disappearance, candidate rollback, and old-space retention/GC. Assert zero cross-space cosine calls and lexical coverage for gaps.
8. **Release gate**: No production default or GPU package claim until campaign verdict, exact-hardware smoke, package/doctor evidence, and rollback test all pass. Any failed or unstable gate records `ABSTAIN` and leaves MiniLM/current CPU behavior unchanged.

## References

1. Muennighoff et al., “MTEB: Massive Text Embedding Benchmark,” EACL 2023. <https://aclanthology.org/2023.eacl-main.148/>
2. Voorhees and Buckley, “The Effect of Topic Set Size on Retrieval Experiment Error,” NIST summary. <https://www.nist.gov/publications/effect-topic-set-size-retrieval-experiment-error>
3. Voorhees and Buckley, “The Effect of Topic Set Size on Retrieval Experiment Error,” SIGIR 2002. <https://doi.org/10.1145/564376.564432>
4. Dwork et al., “The Reusable Holdout: Preserving Validity in Adaptive Data Analysis,” Science 2015. <https://doi.org/10.1126/science.aaa9375>
5. Wang et al., “Text Embeddings by Weakly-Supervised Contrastive Pre-training” (E5). <https://arxiv.org/abs/2212.09741>
6. Kusupati et al., “Matryoshka Representation Learning.” <https://papers.nips.cc/paper_files/paper/2022/hash/c32319f4868da7613d78af9993100e42-Abstract-Conference.html>
7. Karpukhin et al., “Dense Passage Retrieval for Open-Domain Question Answering.” <https://aclanthology.org/2020.emnlp-main.550/>
8. Thakur et al., “BEIR: A Heterogeneous Benchmark for Zero-shot Evaluation of Information Retrieval Models.” <https://arxiv.org/abs/2104.08663>
9. GitHub Engineering, “The technology behind GitHub’s new code search.” <https://github.blog/engineering/architecture-optimization/the-technology-behind-githubs-new-code-search/>
10. ONNX Runtime, “Execution Providers.” <https://onnxruntime.ai/docs/execution-providers/>
11. ONNX Runtime, “CUDA Execution Provider.” <https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html>
12. ONNX Runtime, “CUDA Execution Provider requirements.” <https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html#requirements>
13. ONNX Runtime, “Quantize ONNX models.” <https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html>
14. ONNX, “External Data.” <https://onnx.ai/onnx/repo-docs/ExternalData.html>
15. BAAI, `bge-small-en-v1.5` pinned model card. <https://huggingface.co/BAAI/bge-small-en-v1.5/blob/5c38ec7c405ec4b44b94cc5a9bb96e735b38267a/README.md>
16. Nomic AI, `nomic-embed-text-v1.5` pinned model card. <https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/blob/e9b6763023c676ca8431644204f50c2b100d9aab/README.md>
17. Qwen, `Qwen3-Embedding-0.6B` pinned model card. <https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/blob/97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3/README.md>
18. Alibaba NLP, `gte-modernbert-base` model card. <https://huggingface.co/Alibaba-NLP/gte-modernbert-base>
19. Snowflake, `snowflake-arctic-embed-m-v1.5` model card. <https://huggingface.co/Snowflake/snowflake-arctic-embed-m-v1.5>
20. Snowflake, `snowflake-arctic-embed-l-v2.0` model card. <https://huggingface.co/Snowflake/snowflake-arctic-embed-l-v2.0>
21. BAAI, `bge-m3` model card. <https://huggingface.co/BAAI/bge-m3>
22. Jina AI, `jina-embeddings-v2-base-code` model card. <https://huggingface.co/jinaai/jina-embeddings-v2-base-code>
23. FastEmbed 6.0.0 documentation. <https://docs.rs/fastembed/6.0.0/fastembed/>
24. Sentence Transformers, “Retrieve & Re-Rank.” <https://www.sbert.net/examples/sentence_transformer/applications/retrieve_rerank/README.html>
25. Microsoft Azure AI Search, “Chunk Documents in Vector Search.” <https://learn.microsoft.com/en-us/azure/search/vector-search-how-to-chunk-documents>
26. Hugging Face Hub, “Download files from a specific version.” <https://huggingface.co/docs/huggingface_hub/en/guides/download#from-specific-version>
27. `ort` 2.0.0-rc.13 feature list. <https://docs.rs/crate/ort/2.0.0-rc.13/features>
28. `ort` 2.0.0-rc.13 CUDA execution-provider wrapper. <https://docs.rs/ort/2.0.0-rc.13/src/ort/ep/cuda.rs.html>
29. ONNX Runtime `RunOptions` termination implementation. <https://github.com/microsoft/onnxruntime/blob/4d308dacbbb385fcba9911cd9c07f5603d65cbd6/onnxruntime/core/framework/run_options.cc>
30. Hugging Face, Text Embeddings Inference CLI arguments. <https://huggingface.co/docs/text-embeddings-inference/en/cli_arguments>
31. Hugging Face Transformers, custom model and remote-code guidance. <https://huggingface.co/docs/transformers/en/models#custom-models>
32. Google Cloud Architecture Center, “MLOps: Continuous delivery and automation pipelines in machine learning.” <https://cloud.google.com/architecture/mlops-continuous-delivery-and-automation-pipelines-in-machine-learning>
33. Tene, “How NOT to Measure Latency,” InfoQ presentation (coordinated omission). <https://www.infoq.com/presentations/latency-response-time/>
34. `wrk2` constant-throughput HTTP load generator with coordinated-omission correction. <https://github.com/giltene/wrk2>
35. Schroeder, Wierman, and Harchol-Balter, “Open Versus Closed: A Cautionary Tale,” NSDI 2006. <https://www.usenix.org/legacy/event/nsdi06/tech/schroeder.html>
36. HdrHistogram: A High Dynamic Range Histogram. <https://github.com/HdrHistogram/HdrHistogram>
37. Masson, Rim, and Lee, “DDSketch: A Fast and Fully-Mergeable Quantile Sketch with Relative-Error Guarantees,” VLDB 2019. <https://arxiv.org/abs/1908.10693>
38. Karnin, Lang, and Liberty, “Optimal Quantile Approximation in Streams” (KLL), FOCS 2016. <https://arxiv.org/abs/1603.05346>
39. OpenTelemetry, “Metrics Data Model: ExponentialHistogram.” <https://opentelemetry.io/docs/specs/otel/metrics/data-model/#exponentialhistogram>
40. Prometheus, “Histograms and summaries.” <https://prometheus.io/docs/practices/histograms/>
41. Fleming and Wallace, “How not to lie with statistics: the correct way to summarize benchmark results,” CACM 1986. <https://doi.org/10.1145/5666.5673>
42. Little, “A Proof for the Queuing Formula: L = λW,” Operations Research 1961. <https://doi.org/10.1287/opre.9.3.383>
43. Dean and Barroso, “The Tail at Scale,” CACM 2013. <https://doi.org/10.1145/2408776.2408794>
44. Google SRE Book, “Service Level Objectives.” <https://sre.google/sre-book/service-level-objectives/>
45. Stanford Encyclopedia of Philosophy, “Simpson’s Paradox.” <https://plato.stanford.edu/entries/paradox-simpson/>
46. SQLite, “FTS5 Extension” (`unicode61`, `porter`, and `trigram` tokenizers; `bm25()`). <https://www.sqlite.org/fts5.html>
47. Robertson and Zaragoza, “The Probabilistic Relevance Framework: BM25 and Beyond,” Foundations and Trends in Information Retrieval 2009. <https://doi.org/10.1561/1500000019>
48. Cormack, Clarke, and Buettcher, “Reciprocal Rank Fusion Outperforms Condorcet and Individual Rank Learning Methods,” SIGIR 2009. <https://doi.org/10.1145/1571941.1572114>
49. Chen et al., “M3-Embedding: Multi-Linguality, Multi-Functionality, Multi-Granularity Text Embeddings Through Self-Knowledge Distillation” (BGE-M3 dense, sparse, and multi-vector). <https://arxiv.org/abs/2402.03216>
50. Khattab and Zaharia, “ColBERT: Efficient and Effective Passage Search via Contextualized Late Interaction over BERT,” SIGIR 2020. <https://arxiv.org/abs/2004.12832>
51. Formal, Piwowarski, and Clinchant, “SPLADE: Sparse Lexical and Expansion Model for First Stage Ranking,” SIGIR 2021. <https://arxiv.org/abs/2107.05720>
