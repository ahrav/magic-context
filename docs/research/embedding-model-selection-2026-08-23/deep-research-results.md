## Deep Research Results

### Problem

Find optimal embedding models for magic-context's mixed project-memory, source-code, symbol/path, error, temporal, and architecture-context retrieval workload. Compare the current CPU-local ONNX lane and Rust mc-host Synapse lane. Add an optional GPU path only if it improves measured quality or satisfies a justified latency/footprint tier. Model promotion must remain in-domain benchmark-gated; embedding spaces and execution profiles must never mix silently.

### Current Date

2026-08-23

### Executive Summary

- Do not name an optimal winner. Keep exact Xenova MiniLM as control, preserve the existing BGE-small/Nomic floor, and add only bounded, recipe-correct treatments to the judged benchmark.
- Make query/document transforms and all post-processing part of semantic identity. New dimensions, precision, artifacts, or transforms create a new space and require separate indexing.
- Lean toward one Linux NVIDIA CUDA ORT profile inside Synapse. Fail closed on provider registration or partitioning and use a separately identified startup CPU fallback.
- Treat Arctic l as the lowest-risk CUDA ORT validity treatment and Qwen3 0.6B as a quality-only alternate through a certified adapter. Neither is a winner without in-domain results.
- Expand and protect the judged corpus, retain lexical controls, and measure paired query/category deltas before any model promotion.

### Evidence Highlights

| Rank | Technique or constraint | Evidence IDs | Score | Interpretation |
|---:|---|---|---:|---|
| 1 | Bind exact preprocessing and post-processing to semantic-space identity. | EI-02 | 20.00 | Highest-consensus correctness constraint. |
| 2 | Use public benchmarks only for nomination; use judged in-domain results for promotion. | EI-05 | 20.00 | No model winner follows from model cards or leaderboards. |
| 3 | Treat every Matryoshka dimension and operation order as a distinct candidate. | EI-07 | 16.00 | Prevents unsupported truncation shortcuts. |
| 4 | Treat the small holdout as a coarse gate, not a close-ranking oracle. | EI-09 | 16.00 | Requires broader independent judgments before winner claims. |
| 5 | Never compare or mix vectors across unproven semantic spaces. | EI-10 | 16.00 | Applies to CPU/GPU fallback and reindexing. |
| 6 | Protect the holdout from iterative shortlist, prompt, and precision adaptation. | EI-29 | 16.00 | Small-corpus overfit is an active selection risk. |
| 7 | Pool challenger outputs and report query/category sensitivity before resolving close candidates. | EI-47 | 16.00 | Strongest supported benchmark-hardening technique. |
| 8 | Start GPU support with one pinned, fail-closed CUDA ORT lane. | EI-11 | 15.00 | Strong architecture direction, pending a target hardware tuple. |
| 9 | Keep CPU/GPU execution identities distinct and require real-hardware certification for aliasing. | EI-23 | 15.00 | Numeric equivalence is earned, not assumed. |
| 10 | Apply literal model-specific query/document transforms in benchmark adapters. | EI-44 | 15.00 | A model-ID-only comparison is invalid. |

### Hallucination Flags

| Flag | Classification | Claim or citation | Result and ranking action |
|---|---|---|---|
| H-01 | HALLUCINATION RISK | `github.com/cortexkit/magic-context/.../synapse-model-bundle.md` | HTTP 404. Only this citation instance is strength 0. EI-12 and EI-49 survive on local code evidence and independent sources. |
| H-02 | HALLUCINATION RISK | Pinned `github.com/ahrav/magic-context/blob/21bd.../synapse-model-bundle.md` | HTTP 404. Only this citation instance is strength 0. The merged Synapse findings survive on local code evidence and independent sources. |
| H-06 | HALLUCINATION RISK | A1-F10 cites MRL for the broad rule that independently learned spaces are incomparable. | MRL supports dimensional nesting, not the complete broad claim. Only the citation instance is strength 0; EI-10 survives on independent identity and migration evidence. |
| H-07 | HALLUCINATION RISK | A2-F3's structured URL names GTE while the claim also names Arctic m. | The structured citation instance is strength 0 for the Arctic half. Agent 2's narrative supplies the Arctic owner card and metadata, so EI-14 survives. |
| H-08 | HALLUCINATION RISK | A2-F4's structured URL names Jina while the claim also covers CodeRankEmbed. | The structured citation instance is strength 0 for the CodeRank half. Narrative owner metadata and CoRNStack preserve EI-15's conditional experimental status. |
| H-09 | HALLUCINATION RISK | A2-F5's structured URL names Qwen3 0.6B while the claim orders Arctic l and Qwen3 4B too. | The structured citation instance is strength 0 as written. Narrative owner sources preserve artifact facts, while EI-16 remains a contested proposal. |
| H-10 | HALLUCINATION RISK | A2-F12 uses the TensorRT page for a broad rejection of eight providers and servers. | The structured citation instance is strength 0 as written. Provider-specific narrative sources support the narrower first-release deferral in EI-21. |
| H-11 | HALLUCINATION RISK | A3-F05 uses TensorRT reproducibility documentation to generalize across CPU, CUDA, and TensorRT. | The A3 citation instance is strength 0. EI-23 survives at lower confidence through independent runtime-identity and certification evidence. |
| H-12 | HALLUCINATION RISK | A5-F12 cites Qdrant named vectors for explicit activation, lazy re-embedding, and reversible rollback. | The source does not establish the complete protocol. The merged finding EI-42 is strength 0 UNVERIFIED and excluded from ranking. |

### Implementation Plan

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

### Consensus & Contested Decisions

| Decision | Option A | Option B | Evidence For A | Evidence For B | Verdict |
|---|---|---|---|---|---|
| Candidate shortlist and model-winner policy | Name a winner from public rankings or model cards. | Use public evidence only to bound the shortlist; select and promote only through the repository's predeclared judged campaign. | Model cards and public suites establish artifact contracts and self-reported or out-of-domain scores, but no Magic Context result. | EI-05, EI-09, EI-29, EI-36, and EI-47 show broad agreement on in-domain selection and insufficient evidence for a current winner. | INSUFFICIENT EVIDENCE |
| Query/document preprocessing and semantic identity | Identify a space mainly by model name and output dimensions. | Bind literal query/document templates, tokenizer behavior, pooling, truncation, dimensions, precision, normalization, and artifact hashes into identity. | No report supports model-name-only identity; several failure reports show it can preserve shape while changing rankings. | EI-02, EI-03, EI-07, EI-08, EI-22, EI-44, and EI-45 are corroborated across all five agents. | STRONG CONSENSUS |
| Initial GPU provider/platform | Add one startup-selected Linux NVIDIA CUDA ORT profile inside Synapse. | Start with TEI, TensorRT, another provider, or automatic multi-platform selection. | EI-11, EI-20, EI-24, EI-25, and EI-49 preserve the existing bundle and one-lane contract with the smallest runtime extension. | EI-21 and EI-35 support later alternatives only when a measured winner or performance need justifies their extra boundary. | LEAN (Option A) |
| CPU/GPU equivalence and fallback | Alias CPU and GPU outputs by model name/shape and permit ORT's implicit CPU fallback. | Keep identities separate by default; certify exact hardware/runtime before aliasing and use startup-only fallback to a separately identified CPU lane. | No report supports implicit equivalence; EI-24 documents silent partition risk. | EI-10, EI-11, EI-23, EI-24, EI-46, and EI-49 converge on explicit certification and fail-closed fallback. | STRONG CONSENSUS |
| Lexical/hybrid control | Replace or judge retrieval with dense vectors alone. | Keep lexical retrieval beside dense retrieval and evaluate any BGE-M3 hybrid path as a separate architecture. | Dense bi-encoders are simpler, and reports do not prove a new hybrid stack beats the existing fused path. | EI-04 and EI-18 provide direct exact-token and hybrid-separation evidence. | LEAN (Option B) |

#### Contested decisions

| Question | Strongest evidence for one side | Strongest evidence for the other side | Synthesis |
|---|---|---|---|
| First GPU model/runtime | Agent 2 favors owner-ONNX Arctic l v2.0 first because it fits CUDA ORT with lower implementation risk. | Agent 1 names Qwen3 0.6B as the main GPU candidate; Agent 4 says pinned TEI is the strongest exact Qwen3 treatment. | Platform leans CUDA ORT, but model order is contested. Arctic is the validity-first ORT treatment; Qwen is a quality-only alternate until judged results exist. |
| Dense-only versus hybrid | BEIR and GitHub code-search evidence support lexical/sparse or late-interaction controls. | Existing dense plus lexical retrieval may already cover exact identifiers; BGE-M3 adds index and scoring machinery. | Retain lexical beside dense and measure the gap. Do not infer a BGE-M3 architecture decision from model-card scores. |
| CPU/GPU semantic aliasing | Separate spaces are safest because provider and precision can alter vectors. | Reports allow future aliasing after exact hardware/runtime certification. | Separate by default. Certification may permit semantic aliasing only under a versioned tolerance, while diagnostics retain execution identity. |
| Post-processing location | Host operations are inspectable and purpose-aware. | Exporting post-processing into ONNX keeps the host smaller and binds semantics into graph bytes. | No forced consensus. Whichever path is selected must be exact, fingerprinted, and parity-tested. |
| MiniLM context | Upstream Sentence Transformers documents 256 word pieces. | The deployed Xenova tokenizer and application ceiling are 512. | The incumbent is the Xenova treatment; certify actual behavior and run equal-input analysis before crediting extra context. |

### Risk Register

| Risk ID | Risk | Likelihood | Impact | Mitigation | Source |
|---|---|---|---|---|---|
| R1 | Small-corpus overfit or holdout contamination can make close variants appear ordered when a few queries dominate. | High | High | Predeclare candidates and recipes; run the final holdout rarely; report paired query deltas and leave-one-out sensitivity; pool hard negatives; expand independent slices. | EI-09, EI-29, EI-47; [NIST topic-set study](https://www.nist.gov/publications/effect-topic-set-size-retrieval-experiment-error) |
| R2 | A preprocessing, pooling, or truncation mismatch can test the wrong embedding function while preserving valid-looking vectors. | High | High | Use host-owned versioned query/document templates and fingerprint tokenizer, padding, pooling, output, dimension, precision, and normalization. | EI-02, EI-03, EI-13, EI-44; [Qwen3 pinned artifacts](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/tree/97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3) |
| R3 | Silent ORT CPU fallback or provider partition can turn a claimed GPU lane into mixed CPU/GPU execution. | High | High | Disable CPU EP fallback during qualification; inspect node assignment and profiling; fail startup; use a separately identified service-level CPU fallback. | EI-11, EI-24; [ORT Execution Provider APIs](https://onnxruntime.ai/docs/execution-providers/#apis-for-execution-provider) |
| R4 | GPU dependency closure or version drift can pass Cargo build checks but fail at runtime. | Medium | High | Pin and hash ORT, CUDA, cuDNN, driver/provider closure; record target hardware; require a real-device startup smoke and readiness failure. | EI-25; [ORT CUDA requirements](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html#requirements) |
| R5 | GPU OOM, retained memory, and cold-start cliffs can appear outside the configured provider arena. | High | High | Keep one session; bound tokens, rows, bytes, jobs, results, and calls; measure complete VRAM under cold, warm, and soak workloads. | EI-26, EI-27, EI-41; [ORT `gpu_mem_limit`](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html#gpu_mem_limit) |
| R6 | Identity or reindex mistakes can mix changed artifacts, transforms, providers, or partial old/new indexes. | Medium | High | Hash all consumed files; create a new space for every semantic change; keep execution identity separate; require explicit activation and prohibit cross-space scoring. | EI-10, EI-22, EI-23, EI-42; [Qdrant named vectors](https://qdrant.tech/documentation/concepts/vectors/) |
| R7 | Quantization or Matryoshka operation-order drift can reorder near neighbors while preserving shape and norm. | Medium | High | Give each dimension, precision, calibration digest, and post-processing recipe its own identity and judged result. | EI-07, EI-08; [ORT quantization](https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html) |
| R8 | Conversion and distribution can import remote code, pickle, mutable revisions, mixed artifacts, or incompatible license terms. | Medium | High | Prefer owner artifacts; pin revisions; convert offline; retain hashes and license notices; disable runtime download; require legal review where needed. | EI-17, EI-22, EI-30; [Transformers custom models](https://huggingface.co/docs/transformers/en/models#custom-models) |
| R9 | Dense-only attribution can blame an encoder for exact-token failures or misreport BGE-M3 hybrid gains as dense-model gains. | Medium | Medium | Keep lexical control; report dense and fused paths separately; treat sparse and multi-vector indexing as a separate architecture. | EI-04, EI-18; [GitHub code search](https://github.blog/engineering/architecture-optimization/the-technology-behind-githubs-new-code-search/) |

### Delta-Query Results

One permitted delta-query round ran four parallel queries on 2026-08-23:

- `"magic-context" embedding benchmark MiniLM BGE Nomic Qwen3`
- `information retrieval small topic set paired bootstrap nDCG significance`
- `embedding model selection private domain corpus hard negatives judged evaluation`
- `MTEB custom retrieval benchmark paired significance query count`

No independent Magic Context candidate results were found. Only existing project/task material and already-cited general information-retrieval evaluation literature surfaced. A ResearchGate bootstrap lead was secondary and did not supersede the existing primary NIST/SIGIR evidence. No source supplied a universal minimum query count. The critical gap remains and can only be closed by running the repository's predeclared in-domain campaign. Search-result pages are not evidence of a model winner.

### Full Research (collapsed)

<details>
<summary>Agent 1: Foundational Theory & Algorithms</summary>

# Research Report — Agent 1: Foundational Theory & Algorithms

**Research date:** 2026-08-23  
**Scope:** Retrieval theory, benchmark validity, representation truncation and quantization, code-retrieval transfer, embedding-space invariants, and the minimum GPU execution contract.  
**Decision summary:** Keep MiniLM as the default until a candidate wins on the repository's judged holdout under the existing quality and latency policy. Treat model name, query and document transforms, tokenizer, truncation, output selection, pooling, post-processing, dimension, and quantization as one semantic contract. Test BGE-small-en-v1.5 first as the simplest CPU Synapse challenger. Test Nomic v1.5 at 256 and 512 dimensions only after its exact layer-normalize, truncate, and re-normalize recipe is supported. Test Qwen3-Embedding-0.6B at 256 and 512 dimensions as the main optional GPU candidate, with CPU as a control rather than an assumed deployment path. Keep BGE-M3 experimental because its main value is a different retrieval architecture, not merely a larger dense vector.

## 1. Codebase Context

The TypeScript local lane defaults to `Xenova/all-MiniLM-L6-v2` (`packages/plugin/src/config/schema/magic-context.ts:22`) through `@huggingface/transformers` `^4.1.0` (`packages/plugin/package.json:57-59`). The local provider defaults to fp32 and a 512-token application limit (`packages/plugin/src/features/magic-context/memory/embedding-local.ts:258-263,423-438`). Every call hard-codes mean pooling and L2 normalization (`embedding-local.ts:668-672,713-717`). This recipe agrees with the reference MiniLM pooling recipe, although the exact Xenova tokenizer artifact declares a 512-token model limit while the upstream Sentence Transformers card describes the model as a sentence and short-paragraph encoder and says its default path truncates after 256 word pieces ([Xenova tokenizer configuration](https://huggingface.co/Xenova/all-MiniLM-L6-v2/raw/main/tokenizer_config.json); [upstream MiniLM model card](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2)). The repository benchmark, rather than either metadata value, therefore has to decide whether the current 512-token application setting is useful.

Provider configuration distinguishes `local`, `openai-compatible`, `synapse`, and `off`, and requires an explicit fallback for Synapse (`magic-context.ts:298-307`). OpenAI-compatible providers can distinguish stored-document and query input types (`magic-context.ts:318-329`), but the local provider accepts a purpose parameter without using it (`embedding-local.ts:684-688`). Local dtype and remote input/truncation settings enter provider identity because they can change vectors (`packages/plugin/src/features/magic-context/memory/embedding-identity.ts:18-78`). This is already the right direction, but candidate models with literal text prefixes need those transforms included too.

The Rust Synapse lane pins `fastembed = 6.0.0` and `ort = 2.0.0-rc.13`, disables their default features, and dynamically loads ORT (`crates/mc-host/Cargo.toml:18-19`). It is intentionally CPU-only (`crates/mc-host/src/synapse/inference.rs:1-3`), uses one intra-op thread (`inference.rs:252-256`), and admits one native inference call at a time (`crates/mc-host/src/synapse/mod.rs:164-200`). Bundle artifacts and tokenizer files are SHA-256 pinned (`docs/synapse-model-bundle.md:11-24`). The fingerprint covers dimensions, mean-or-CLS pooling, quantization, output selection, maximum tokens, artifacts, table epoch, a semantic certification corpus, and fixed L2 post-processing (`docs/synapse-model-bundle.md:26-74,88-116`). Startup verifies the exact ORT bytes, runs structural checks, and certifies expected vectors before reporting ready (`docs/synapse-model-bundle.md:118-153`). One model is active and there is no registry, runtime download, or request-time model choice (`docs/synapse-model-bundle.md:180-189`).

The judged corpus contains 22 queries and 22 authored documents. It has 17 explicit and 5 automatic queries across ten categories: exact symbol/path, error message, architecture rationale, debugging history, user directive, current constraint, benchmark result, temporal fact, contradictory memory, and paraphrased decision (`packages/plugin/scripts/fixtures/retrieval-benchmark/v1/corpus.json:3-519`; documents begin at line 520). Nine categories have two queries and the paraphrase category has four. Metrics use graded relevance, nDCG@10, and Recall@50 (`packages/plugin/scripts/retrieval-benchmark/metrics.ts:24-31,219-235,318-337`). Macro aggregation first averages paraphrases within an intent and then gives intents equal weight (`metrics.ts:358-395`). The policy requires three runs, allows at most two percentage points of average holdout loss, allows no run more than five points below baseline, and requires median-of-three run-level p95 at no more than 110% of baseline (`packages/plugin/scripts/fixtures/retrieval-benchmark/baselines/v1/policy.json:1-21`). The policy explicitly says these limits are repository policy, not statistical confidence (`policy.json:4`).

The supplied candidate floor is BGE-small-en-v1.5, Nomic Embed v1.5 at 256 and 512 dimensions, Qwen3-Embedding-0.6B at 256 and 512 dimensions, and BGE-M3 as an experiment. The supplied GPU constraints are also treated as fixed: one active Synapse lane per process, no request-time model or device selection, deterministic CPU behavior when no GPU exists, no runtime downloads, and no silent CPU/GPU substitution under one identity.

## 2. Findings

**Finding 1: Dense retrieval quality is learned from a query-document relation, not from generic sentence similarity**

- **Source**: Karpukhin et al., [“Dense Passage Retrieval for Open-Domain Question Answering”](https://aclanthology.org/2020.emnlp-main.550/) (EMNLP 2020); Wang et al., [“Text Embeddings by Weakly-Supervised Contrastive Pre-training”](https://arxiv.org/abs/2212.03533); Thakur et al., [“BEIR: A Heterogeneous Benchmark for Zero-shot Evaluation of Information Retrieval Models”](https://arxiv.org/abs/2104.08663).

- **Source credibility**: High. These papers are peer-reviewed or formally evaluated across established retrieval collections.
- **Evidence strength**: 4.

- **Summary**: Dense bi-encoders learn separate query and document representations under a contrastive objective. DPR uses two encoders, dot-product scoring, positive passages, hard negatives, and in-batch negatives. The loss teaches the model which relation to preserve. It does not make the resulting vectors a universal measure of textual similarity. E5 broadens the training mixture, but still learns through paired contrastive data. BEIR shows that the training distribution and negative-mining choices materially affect zero-shot behavior.

- **Key technique/insight**: Evaluate a candidate as a complete retrieval recipe: query transform, document transform, tokenizer, truncation, encoder, pooling, normalization, and similarity. A sentence-similarity score or a public aggregate does not establish fitness for project-memory retrieval. The judged corpus should retain separate reporting for natural-language paraphrases and identifier-heavy queries because those are different learned relations.

- **Applicability to our problem**: This applies directly to memories phrased as decisions, constraints, and historical facts. It also explains why a model trained mainly on question-passage pairs can improve semantic queries while regressing exact error strings or symbols.

- **Caveats**: DPR's large gains are on open-domain QA, not source paths or project history. E5's broader training makes transfer more plausible, but does not prove transfer to this repository. These sources justify the benchmark design, not any candidate winner.

**Finding 2: Query and document instructions are part of the model, not optional prompt decoration**

- **Source**: Su et al., [“One Embedder, Any Task: Instruction-Finetuned Text Embeddings”](https://arxiv.org/abs/2212.09741) (ACL 2023); [Nomic Embed v1.5 model card](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5); [BGE-small-en-v1.5 model card](https://huggingface.co/BAAI/bge-small-en-v1.5); [Qwen3-Embedding-0.6B model card](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B).

- **Source credibility**: High for the instruction-learning result and Moderate for candidate-specific model-card recipes.
- **Evidence strength**: 4 for INSTRUCTOR and 3 for the implemented model cards. The owner-reported 1% to 5% estimate is **WEAK**, strength 2.

- **Summary**: INSTRUCTOR trains on task and domain descriptions attached to each input and uses different descriptions for query and target roles. The candidate cards make this concrete. Nomic requires `search_query: ` for queries and `search_document: ` for indexed text. BGE recommends adding its retrieval instruction to short queries but not passages. Qwen requires a one-sentence task instruction on queries and no instruction on documents. Qwen's card reports a 1% to 5% retrieval decrease without query instructions, but that number is self-reported and therefore **WEAK**, strength 2, for project decisions.

- **Key technique/insight**: Benchmark every candidate with the exact documented asymmetric recipe and make the two literal transforms fingerprinted fields. Do not compare a correctly instructed candidate against an uninstructed candidate and call the result a model comparison. The TypeScript local lane currently ignores embedding purpose, so it cannot fairly evaluate Nomic or Qwen without an explicit transform step. The OpenAI-compatible lane's separate input types are conceptually right, but string-prefix models need the literal template, including whitespace and newlines, bound into identity.

- **Applicability to our problem**: Project queries are short and often imperative, while indexed memories are declarative. That is exactly the asymmetric retrieval shape these recipes target.

- **Caveats**: An instruction consumes tokens and can hurt if it mismatches the task. The ideal project-specific wording is not established by these sources. It must be frozen before holdout evaluation, not tuned repeatedly on the 22 judged queries. Qwen's numerical improvement estimate remains **WEAK**, strength 2, until reproduced on this corpus.

**Finding 3: Pooling and post-processing make the current lanes unsuitable for blind model substitution**

- **Source**: [MiniLM model card](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2); [BGE-small-en-v1.5 model card](https://huggingface.co/BAAI/bge-small-en-v1.5); [Nomic Embed v1.5 model card](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5); [Qwen3-Embedding-0.6B model card](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B).

- **Source credibility**: Moderate to High because these are the model owners' executable reference recipes.
- **Evidence strength**: 3.

- **Summary**: MiniLM's reference recipe is attention-mask-aware mean pooling followed by L2 normalization, which matches the TypeScript lane. BGE-small-en-v1.5 uses the first token, or CLS, followed by L2 normalization and emits 384 dimensions at a 512-token model length. Nomic first mean-pools a 768-dimensional result, layer-normalizes the full vector, takes the requested Matryoshka prefix, and then L2-normalizes. Qwen3-Embedding-0.6B uses the last non-padding token and L2-normalizes; its card identifies a 1024-dimensional native output, 32K sequence length, Matryoshka support, and instruction-aware queries.

- **Key technique/insight**: The present TypeScript mean-plus-normalize path can faithfully preserve MiniLM but not BGE's CLS recipe, Nomic's layer-normalize/truncate recipe, or Qwen's last-token recipe. The current Synapse lane can express BGE's CLS recipe, but its manifest exposes only mean or CLS pooling. Nomic at 256 or 512 dimensions therefore needs either an ONNX graph whose exported output already performs the documented post-processing or a narrowly added certified post-processing mode. Qwen needs an exported post-pooled output or explicit last-token support. A model that cannot be represented exactly should be marked unsupported, not approximated with mean pooling.

- **Applicability to our problem**: This narrows the first runnable shortlist. BGE-small is the lowest-friction CPU Synapse challenger. Nomic is next after exact post-processing support. Qwen is primarily a GPU-path candidate because it also needs a different pooling path and has 0.6B parameters, although CPU should still be measured as a control.

- **Caveats**: An ONNX export can fuse post-processing into the graph, which may avoid host changes. That export is then a distinct artifact and must be certified as such. Model-card leaderboard values only apply to their stated recipe, not to a convenient approximation.

**Finding 4: Exact identifiers justify a lexical or late-interaction control, but not an immediate architecture expansion**

- **Source**: Thakur et al., [BEIR](https://arxiv.org/abs/2104.08663); Khattab and Zaharia, [“ColBERT: Efficient and Effective Passage Search via Contextualized Late Interaction over BERT”](https://arxiv.org/abs/2004.12832) (SIGIR 2020); Formal et al., [“SPLADE: Sparse Lexical and Expansion Model for First Stage Ranking”](https://arxiv.org/abs/2107.05720) (SIGIR 2021); [BGE-M3 model card](https://huggingface.co/BAAI/bge-m3) and Chen et al., [BGE-M3 technical report](https://arxiv.org/abs/2402.03216).

- **Source credibility**: High for BEIR, ColBERT, and SPLADE; Moderate for BGE-M3's self-description.
- **Evidence strength**: 4 for the general result and 3 for the implemented BGE-M3 modes. BGE-M3's owner recommendation to use hybrid retrieval is **WEAK**, strength 2, as project-design evidence.

- **Summary**: BEIR finds BM25 to be a robust zero-shot baseline and finds late-interaction and reranking methods strongest on average, but at higher compute cost. ColBERT preserves one vector per token and performs late query-document interaction instead of collapsing each side to one vector. SPLADE keeps sparse lexical coordinates while learning term expansion. BGE-M3 exposes dense, learned sparse, and ColBERT-style outputs from one model and supports inputs up to 8192 tokens. These approaches address the lexical gap without discarding exact term evidence.

- **Key technique/insight**: Add a lexical or existing hybrid control to candidate reports, especially for exact-symbol-path and error-message categories. Do not treat a dense-model win on semantic categories as permission to regress exact identifiers. Keep BGE-M3 experimental: evaluating its dense vector alone tests a model, while evaluating dense+sparse+multi-vector tests a new index and scoring architecture. Those are different experiments and need different identities, latency accounting, and rollback plans.

- **Applicability to our problem**: Two judged categories directly exercise exact strings, and code paths, stack traces, hashes, and symbols often carry relevance in tokens that a dense model can smooth away.

- **Caveats**: Learned sparse and late-interaction methods add storage, index, and query cost. The corpus may show that the existing lexical component already covers these cases, in which case adding BGE-M3 modes would be unnecessary. BGE-M3's card recommends hybrid retrieval, but that recommendation is **WEAK**, strength 2, as design evidence until the repository benchmark measures it.

**Finding 5: Public embedding leaderboards are useful filters, not selection oracles**

- **Source**: Muennighoff et al., [“MTEB: Massive Text Embedding Benchmark”](https://aclanthology.org/2023.eacl-main.148/) (EACL 2023); Thakur et al., [BEIR](https://arxiv.org/abs/2104.08663).

- **Source credibility**: High. These are peer-reviewed benchmark studies.
- **Evidence strength**: 4.

- **Summary**: MTEB was created because evaluation on one embedding task leaves transfer to other tasks unresolved. Its original benchmark covers 58 datasets across eight task families. Its correlation analysis shows that some task families correlate weakly with others. It also warns that preprocessing and evaluation-pipeline choices can move results. BEIR reaches a parallel conclusion for retrieval: systems trained and ranked in narrow settings behave inconsistently across 18 zero-shot datasets.

- **Key technique/insight**: Use MTEB, BEIR, and code-retrieval scores to form a bounded shortlist and to reject obviously weak models. Select the default only on the repository's frozen judged holdout and operational latency matrix. Report category-level results so a macro average cannot hide an exact-identifier or temporal-fact regression.

- **Applicability to our problem**: The project workload mixes semantic search, source-code terms, operational errors, chronology, and persistent instructions. No public aggregate has that mixture or the same costs of a false memory retrieval.

- **Caveats**: Public benchmarks remain valuable because they reduce the risk of overfitting all model choice to 22 local queries. A model that is poor across broad public suites deserves a higher burden of proof. The right rule is “public evidence for shortlist, in-domain evidence for adoption,” not “ignore public benchmarks.”

**Finding 6: Code-retrieval benchmarks still miss important parts of this workload, and contamination evidence is insufficient**

- **Source**: Husain et al., [“CodeSearchNet Challenge: Evaluating the State of Semantic Code Search”](https://arxiv.org/abs/1909.09436); Li et al., [“CoIR: A Comprehensive Benchmark for Code Information Retrieval Models”](https://arxiv.org/abs/2407.02883).

- **Source credibility**: Moderate. CodeSearchNet is an official released benchmark; CoIR is an implemented open benchmark and preprint.
- **Evidence strength**: 3.

- **Summary**: CodeSearchNet evaluates 99 natural-language queries against about six million functions and supplies roughly 4,000 expert judgments across Go, Java, JavaScript, PHP, Python, and Ruby. It does not include Rust or TypeScript and does not target path lookup, exact error messages, or temporal project facts. CoIR broadens evaluation to ten datasets and text-to-code, code-to-code, code-to-text, and hybrid tasks. Its own limitations section says the benchmark is English-only, mainly text-based, and does not model metadata such as software and language versions that can determine real-world relevance.

- **Key technique/insight**: CodeSearchNet or CoIR performance can support a code-aware candidate entering the shortlist, but cannot replace the local exact-symbol, error-message, temporal, contradiction, and user-directive judgments. Qwen's self-reported MTEB-Code result should be recorded as provenance, not used as an acceptance gate.

- **Applicability to our problem**: The mismatch is direct: this repository is TypeScript and Rust, and its context index stores prose memories and metadata alongside code-related text.

- **Caveats**: CoIR is substantially better than treating CodeSearchNet as all of code retrieval. It may reveal large code-semantic differences among candidates. This search found no primary source that establishes the contamination status of Qwen3-Embedding, BGE, Nomic, or MiniLM against CodeSearchNet or CoIR. Therefore contamination is **INSUFFICIENT**, not proven present or absent. Public leaderboard claims should carry this unknown rather than an accusation.

**Finding 7: Matryoshka truncation is valid only for models trained for nested prefixes**

- **Source**: Kusupati et al., [“Matryoshka Representation Learning”](https://papers.nips.cc/paper_files/paper/2022/hash/c32319f4868da7613d78af9993100e42-Abstract-Conference.html) (NeurIPS 2022); [Nomic Embed v1.5 model card](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5); [Qwen3-Embedding-0.6B model card](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B).

- **Source credibility**: High for MRL and Moderate for model-specific implementation.
- **Evidence strength**: 4 for the MRL result and 3 for the candidate implementations.

- **Summary**: MRL jointly optimizes nested prefixes so that early dimensions carry a coarse representation and later dimensions refine it. The paper compares these prefixes with independently trained lower-dimensional baselines and reports favorable accuracy-compute trade-offs. That result does not authorize truncating an arbitrary embedding. Nomic's recipe specifically layer-normalizes the full vector, slices the requested prefix, and L2-normalizes again. Qwen's card explicitly marks the model as MRL-capable.

- **Key technique/insight**: Treat Nomic-256, Nomic-512, Qwen-256, and Qwen-512 as four separate candidate identities and benchmark cells. Store the final dimension in the embedding-space fingerprint. Do not manufacture 256-dimensional BGE-small or MiniLM variants by slicing them; use their native dimensions unless a model owner documents nested training.

- **Applicability to our problem**: Lower dimensions directly reduce persistent vector bytes and similarity work. They may make a larger encoder operationally viable without forcing the index to retain its full output.

- **Caveats**: MRL demonstrates broad feasibility, not zero loss on this workload. A lower-dimensional prefix can reorder near neighbors even when its aggregate public score is close. The local holdout and category diagnostics remain the acceptance authority.

**Finding 8: Quantization is a semantic variant and must be benchmarked independently**

- **Source**: [ONNX Runtime quantization documentation](https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html); [Sentence Transformers embedding quantization documentation](https://www.sbert.net/examples/sentence_transformer/applications/embedding-quantization/README.html).

- **Source credibility**: High because these are official implementation documents.
- **Evidence strength**: 3.

- **Summary**: ONNX Runtime explicitly says model quantization is not lossless and can reduce accuracy; it provides weight and activation comparison tools because some tensors are more sensitive than others. Sentence Transformers distinguishes model quantization from post-hoc embedding quantization. Its int8 embedding path depends on calibration ranges, and its binary and int8 paths can use oversampling and float rescoring to recover retrieval quality.

- **Key technique/insight**: Benchmark every dtype or quantization mode as a distinct candidate, not as a free speed switch. Record model-graph hash, weight/activation quantization mode, calibration artifact and corpus where applicable, output precision, and any embedding-vector quantization or rescoring strategy. The existing TypeScript identity fold for non-fp32 dtype and the Synapse quantization fingerprint are correct safeguards.

- **Applicability to our problem**: Quantization may be necessary for Nomic, Qwen, or BGE-M3 to fit CPU memory or GPU VRAM and latency limits. It is also one of the easiest ways to create a silent near-neighbor regression while preserving dimensions and apparent health.

- **Caveats**: Small numerical changes do not always change ranked results. If a quantized artifact passes vector certification, judged quality, and latency, it can be preferred. TensorRT's GPU int8 path uses its own calibration and quantization logic, so a CPU-quantized ONNX result is not evidence for the TensorRT result.

**Finding 9: The 22-query corpus supports a repository gate but not a broad claim of optimality**

- **Source**: Voorhees and Buckley, [“The Effect of Topic Set Size on Retrieval Experiment Error”](https://www.nist.gov/publications/effect-topic-set-size-retrieval-experiment-error) (SIGIR 2002); Smucker, Allan, and Carterette, [“A Comparison of Statistical Significance Tests for Information Retrieval Evaluation”](https://ciir-publications.cs.umass.edu/getpdf.php?id=744) (CIKM 2007).

- **Source credibility**: High. These are peer-reviewed IR evaluation studies.
- **Evidence strength**: 4.

- **Summary**: The NIST study shows that retrieval effectiveness varies substantially by topic and that small topic sets produce larger-than-expected chances of reversing a system comparison with another same-sized topic sample. It computes empirical error rates through 25 topics. Smucker et al. compare paired IR significance tests on TREC runs and find that the paired t-test, bootstrap, and randomization test usually agree, while recommending randomization when applicable. They also state that the test statistic should match the reported statistic.

- **Key technique/insight**: Keep the current policy as an operational regression gate, exactly as its own description intends. Add paired per-query or per-intent differences, a paired randomization test for the reported macro statistic, and a bootstrap confidence interval as diagnostics. Do not let failure to reach significance override a policy regression, and do not let a policy pass become a claim that the candidate is universally optimal. Expand the frozen corpus before making a long-lived default when plausible candidates remain within the uncertainty band.

- **Applicability to our problem**: There are only two queries in most categories and only five automatic queries. One hard topic can therefore dominate a category, while three latency runs do nothing to increase quality-topic sample size. The existing paraphrase-first macro aggregation is a sound defense against counting near-duplicate wording as independent evidence.

- **Caveats**: A small, carefully targeted corpus can be more decision-relevant than a large generic one. Exact randomization over 22 paired topics is practical. The limitation is external validity and power, not that the benchmark is useless.

**Finding 10: Cross-model embedding mixing is invalid even when dimensions and normalization match**

- **Source**: The model-specific pooling and dimensionality contracts above; Kusupati et al., [MRL](https://papers.nips.cc/paper_files/paper/2022/hash/c32319f4868da7613d78af9993100e42-Abstract-Conference.html); [ONNX Runtime quantization documentation](https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html). The invariant below is a mathematical synthesis from those source facts.

- **Source credibility**: High for the derivation; the implementation consequences are project-specific synthesis.
- **Evidence strength**: 4 for the proof, grounded in strength-3 and strength-4 premises.

- **Summary**: Let one embedding function be `f` and another be `g`. Even if both emit unit vectors of dimension `d`, there is no shared coordinate basis. For any orthogonal matrix `Q`, replacing `g(x)` with `Qg(x)` preserves every within-`g` cosine similarity because `(Qg(a))·(Qg(b)) = g(a)·g(b)`. It can nevertheless change `f(q)·Qg(d)` arbitrarily. Therefore equal dimension, unit norm, and good within-model quality cannot make cross-model scores meaningful.

- **Key technique/insight**: Enforce one semantic-space identifier across every scored query and stored vector, and bind every vector-producing choice into that identifier. The required invariants are listed below.

- **Applicability to our problem**: The existing provider identity, Synapse bundle fingerprint, table epoch, and semantic certification corpus already implement much of this contract. Missing candidate-specific query/document transforms and new pooling/post-processing modes are the main theory-driven additions.

- **Caveats**: Two executions of the same mathematical model can differ by harmless floating-point rounding without becoming different semantic spaces. The repository can define an explicit tolerance and ranking-stability certificate. The supplied GPU constraint is stricter: even if certified equivalent, CPU and GPU must not substitute silently under one lane identity.

The required invariants are:

1. A query vector may score a stored vector only when both carry the same semantic-space identifier.
2. The identifier must bind exact model and external-initializer hashes; tokenizer and special-token hashes; query transform; document transform; tokenization, padding, and truncation policy; output tensor; pooling; post-processing order; final dimension; model quantization; output or index quantization; normalization; and similarity function.
3. Any changed field creates a new space and triggers coexistence plus lazy re-embedding, never in-place mixing.
4. Structural checks such as finite components, dimensions, and unit norm are necessary but not sufficient. A pinned semantic corpus with expected vectors or expected pairwise scores is also required.
5. Backend execution identity must be separate from, and include, the semantic identity. CPU/GPU equivalence may be declared only by an explicit versioned certification; it must never arise from an unavailable-device fallback.

**Finding 11: The minimum GPU experiment is one pinned CUDA lane, not a device-selecting model service**

- **Source**: [ONNX Runtime execution-provider architecture](https://onnxruntime.ai/docs/execution-providers/); [ONNX Runtime CUDA Execution Provider](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html); [ONNX Runtime TensorRT Execution Provider](https://onnxruntime.ai/docs/execution-providers/TensorRT-ExecutionProvider.html); [Qwen3-Embedding-0.6B official release, 2025-06-05](https://qwenlm.github.io/blog/qwen3-embedding/); [Qwen3 technical report](https://arxiv.org/abs/2506.05176).

- **Source credibility**: High for runtime behavior and release identity; Moderate for model-owner benchmark claims.
- **Evidence strength**: 3 for implemented runtime contracts and model artifacts. Qwen's self-reported superiority claims are **WEAK**, strength 2, and are excluded from the recommendation.

- **Summary**: ONNX Runtime requires explicit execution-provider registration. Provider order is meaningful: TensorRT documentation recommends registering CUDA after TensorRT so unsupported TensorRT nodes can execute under CUDA. CUDA and cuDNN major versions have explicit compatibility constraints. TensorRT engine and timing caches depend on GPU compute capability and are preferably scoped per GPU model. These facts make an execution provider, its options, accelerator libraries, and device class part of a reproducible execution identity. Qwen3-Embedding was released on 2025-06-05, before this report date, and its official 0.6B card specifies 28 layers, 32K sequence length, 1024 native dimensions, MRL support, and instruction awareness.

- **Key technique/insight**: Start with one NVIDIA CUDA EP platform, one owner-provisioned bundle, one fixed EP configuration, and one active Synapse lane. Fail closed when that provider or exact runtime is unavailable. Keep the existing CPU lane deterministic and separately named. Defer TensorRT, int8 calibration, multiple GPU families, and provider fallback until a CUDA result proves that GPU acceleration changes the feasible model frontier. This is a simplicity recommendation, not a claim that CUDA is always faster.

- **Applicability to our problem**: This order answers the repository decision with the fewest new mechanisms. It separates “better model” from “different retrieval architecture” and separates “GPU makes a model feasible” from “GPU implementation exists.”

- **Caveats**: A measured CPU Qwen run could pass and remove the need for GPU. A CUDA EP may partition or execute some operations differently from CPU, so exact model hashes alone are insufficient. No source proves that Qwen, Nomic, BGE-small, or BGE-M3 wins this corpus. Qwen's owner-reported superiority claims are **WEAK**, strength 2, until reproduced here. The winner remains intentionally unresolved until benchmark execution.

The benchmark shortlist should be executed in this order:

| Candidate | Exact recipe | First lane | Reason to retain | Gate or blocker |
| --- | --- | --- | --- | --- |
| MiniLM baseline | Mean pool, L2, fp32, current tokenizer and truncation | TypeScript CPU local and Synapse CPU parity check | Existing behavior and rollback anchor | No default change |
| BGE-small-en-v1.5, 384d | Query instruction, no passage instruction, CLS pool, L2 | Synapse CPU | Smallest recipe change and native 384d | Must beat judged baseline under current policy |
| Nomic Embed v1.5, 256d and 512d | `search_query`/`search_document`, mean pool, full-vector layer norm, prefix slice, L2 | Synapse CPU first | Native MRL dimensions and longer-context option | Exact post-processing must be exported or certified in host |
| Qwen3-Embedding-0.6B, 256d and 512d | Project retrieval instruction on query only, last-token pool, MRL slice, L2 | Pinned CUDA Synapse; CPU control | Larger code-capable, instruction-aware candidate that can test whether GPU expands quality frontier | New pooling/export path, exact GPU identity, latency and VRAM evidence |
| BGE-M3, native 1024d dense | Documented dense output | CPU or GPU experiment | Tests long-context multilingual dense model | Experimental; compare cost at native dimension |
| BGE-M3 hybrid | Dense plus sparse and/or multi-vector scoring | Separate architecture experiment | Tests exact-token and semantic fusion | Requires new index/scoring identity; not a drop-in embedding candidate |

## 3. Structured Evidence Summary

```json
[
  {
    "id": "F1",
    "claim": "Dense retrieval quality is learned from a query-document contrastive relation and its negative distribution.",
    "source_url": "https://aclanthology.org/2020.emnlp-main.550/",
    "source_title": "Dense Passage Retrieval for Open-Domain Question Answering",
    "evidence_strength": 4,
    "credibility_tier": "High",
    "applicability": "Evaluate complete retrieval recipes rather than bare model names."
  },
  {
    "id": "F2",
    "claim": "Candidate query and document instructions are asymmetric parts of the embedding function.",
    "source_url": "https://arxiv.org/abs/2212.09741",
    "source_title": "One Embedder, Any Task: Instruction-Finetuned Text Embeddings",
    "evidence_strength": 4,
    "credibility_tier": "High",
    "applicability": "Fingerprint and benchmark literal query and document transforms."
  },
  {
    "id": "F3",
    "claim": "MiniLM, BGE, Nomic, and Qwen require different pooling and post-processing recipes.",
    "source_url": "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5",
    "source_title": "Nomic Embed v1.5 model card",
    "evidence_strength": 3,
    "credibility_tier": "Moderate",
    "applicability": "Reject approximate pooling substitutions and add only exact modes needed by benchmark candidates."
  },
  {
    "id": "F4",
    "claim": "Lexical, sparse, and late-interaction signals provide a necessary control for exact-token retrieval.",
    "source_url": "https://arxiv.org/abs/2104.08663",
    "source_title": "BEIR: A Heterogeneous Benchmark for Zero-shot Evaluation of Information Retrieval Models",
    "evidence_strength": 4,
    "credibility_tier": "High",
    "applicability": "Report a lexical or hybrid control and keep BGE-M3 hybrid separate from dense model selection."
  },
  {
    "id": "F5",
    "claim": "Cross-task and cross-domain benchmark rankings do not reliably determine in-domain winners.",
    "source_url": "https://aclanthology.org/2023.eacl-main.148/",
    "source_title": "MTEB: Massive Text Embedding Benchmark",
    "evidence_strength": 4,
    "credibility_tier": "High",
    "applicability": "Use MTEB and BEIR for shortlist formation only."
  },
  {
    "id": "F6",
    "claim": "CodeSearchNet and CoIR do not cover the complete project-memory workload, and candidate contamination status is unknown.",
    "source_url": "https://arxiv.org/abs/2407.02883",
    "source_title": "CoIR: A Comprehensive Benchmark for Code Information Retrieval Models",
    "evidence_strength": 3,
    "credibility_tier": "Moderate",
    "applicability": "Keep local path, error, temporal, contradiction, and directive judgments authoritative."
  },
  {
    "id": "F7",
    "claim": "Dimension truncation is justified only for an MRL-trained model and exact documented post-processing order.",
    "source_url": "https://papers.nips.cc/paper_files/paper/2022/hash/c32319f4868da7613d78af9993100e42-Abstract-Conference.html",
    "source_title": "Matryoshka Representation Learning",
    "evidence_strength": 4,
    "credibility_tier": "High",
    "applicability": "Treat every model-dimension pair as a separate fingerprinted benchmark candidate."
  },
  {
    "id": "F8",
    "claim": "Model and embedding quantization can alter accuracy and depend on quantization or calibration details.",
    "source_url": "https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html",
    "source_title": "ONNX Runtime quantization documentation",
    "evidence_strength": 3,
    "credibility_tier": "High",
    "applicability": "Benchmark and fingerprint every quantized artifact independently."
  },
  {
    "id": "F9",
    "claim": "A 22-query test can enforce repository policy but has limited power and external validity.",
    "source_url": "https://www.nist.gov/publications/effect-topic-set-size-retrieval-experiment-error",
    "source_title": "The Effect of Topic Set Size on Retrieval Experiment Error",
    "evidence_strength": 4,
    "credibility_tier": "High",
    "applicability": "Add paired uncertainty diagnostics and avoid broad optimality claims."
  },
  {
    "id": "F10",
    "claim": "Equal dimensions and normalization do not make two independently learned embedding spaces comparable.",
    "source_url": "https://papers.nips.cc/paper_files/paper/2022/hash/c32319f4868da7613d78af9993100e42-Abstract-Conference.html",
    "source_title": "Matryoshka Representation Learning",
    "evidence_strength": 4,
    "credibility_tier": "High",
    "applicability": "Require exact semantic-space identity for every query-document comparison."
  },
  {
    "id": "F11",
    "claim": "A reproducible GPU lane must pin execution provider order, runtime compatibility, provider options, and device class in addition to model semantics.",
    "source_url": "https://onnxruntime.ai/docs/execution-providers/",
    "source_title": "ONNX Runtime execution-provider architecture",
    "evidence_strength": 3,
    "credibility_tier": "High",
    "applicability": "Start with one fail-closed CUDA EP Synapse lane and Qwen3-Embedding-0.6B as the main GPU candidate."
  }
]
```

## 4. Patterns & Consensus

The strongest consensus is that the unit of comparison is an embedding pipeline, not a model label. Training objective, input role, instructions, tokenizer, pooling, post-processing, dimension, and numeric format all affect the learned relation or the resulting coordinates. The current Synapse fingerprint already covers most artifact-level fields and provides a better foundation for candidate work than a permissive request-time model registry.

The second consensus is that broad benchmarks test transfer but do not remove the need for local judgments. MTEB, BEIR, CodeSearchNet, and CoIR are useful because they expose weak candidates and different retrieval capabilities. Their coverage also makes the gap visible: none reproduces this repository's combination of exact paths, error text, persistent instructions, contradictions, and chronology.

The third consensus is that efficiency choices are coupled to quality. MRL, model quantization, vector quantization, and GPU execution can make a candidate feasible, but each can reorder neighbors. Every such choice belongs in the candidate matrix and identity. No optimization should inherit another variant's quality result.

The fourth consensus is that exact lexical evidence remains valuable. Dense retrieval closes semantic gaps; sparse and late-interaction methods preserve exact terms. The safest near-term experiment is to retain a lexical control while testing dense candidates, not to replace the retrieval architecture before the model question is answered.

Finally, evidence favors a narrow GPU lane. One pinned CUDA execution provider, one model, and fail-closed startup preserve the current Synapse invariants. TensorRT, quantized GPU execution, provider fallback, and multiple device families are separate hypotheses that should be added only if the first GPU experiment proves they are needed.

## 5. Disagreements & Open Questions

**Dense-only versus hybrid.** BEIR favors late interaction and reranking on average, while dense bi-encoders remain cheaper and simpler. The local corpus must show whether current lexical retrieval already protects identifiers. If it does, BGE-M3 hybrid would add machinery without solving a measured gap.

**How much MRL truncation costs here.** The MRL paper and candidate cards support nested prefixes, but no source establishes that 256 dimensions preserve this corpus's close neighbors. Nomic-256 versus Nomic-512 and Qwen-256 versus Qwen-512 remain empirical comparisons.

**Exact candidate instructions.** Model cards give general retrieval instructions. They do not specify whether this project should say “retrieve project memories,” “retrieve source-code context,” or use one instruction across all ten categories. One project instruction is simpler and avoids per-request spaces, but its wording must be selected on development data and frozen before holdout runs.

**Post-processing location.** Nomic and Qwen can be supported by adding narrowly defined host operations or by exporting post-processing into ONNX. Exporting keeps the host smaller but moves more semantics into opaque graph bytes. Host support is more inspectable but expands the manifest schema. Both can be safe if the artifact, output selector, recipe, and certification vectors are pinned.

**CPU/GPU equivalence.** Floating-point differences may be harmless, but the supplied constraint forbids silent substitution. It remains open whether future explicit certification should permit CPU and GPU outputs to share one semantic table while retaining distinct execution identities. The first GPU version should avoid this decision and use a distinct lane and embedding identity.

**Corpus size.** The 22-query set is carefully targeted but statistically small. Open questions are how many additional independently authored intents are needed, how to prevent candidate-driven query creation, and whether automatic-search behavior needs more than five queries. Growth should be pre-registered and candidate-blind.

**Code benchmark contamination.** No primary source located in this search proves or disproves overlap between the candidate training corpora and CodeSearchNet or CoIR. This remains an evidence gap. It is a reason to discount public code scores, not to discard them or claim contamination as fact.

**GPU platform boundary.** CUDA EP on one NVIDIA platform is the simplest supported experiment. Exact GPU model, minimum compute capability, CUDA and cuDNN versions, memory floor, and whether fp16 is allowed remain deployment facts for the implementation owner to measure and pin.

## 6. Recommended Reading

1. Karpukhin et al., [Dense Passage Retrieval for Open-Domain Question Answering](https://aclanthology.org/2020.emnlp-main.550/). Best concise foundation for bi-encoder training, positives, and negatives.
2. Thakur et al., [BEIR](https://arxiv.org/abs/2104.08663). Most relevant evidence on domain transfer and lexical, dense, sparse, late-interaction, and reranking trade-offs.
3. Muennighoff et al., [MTEB](https://aclanthology.org/2023.eacl-main.148/). Explains why one public task or average cannot stand in for a target workload.
4. Su et al., [INSTRUCTOR](https://arxiv.org/abs/2212.09741). Establishes instructions as learned task and domain inputs rather than informal prompt text.
5. Kusupati et al., [Matryoshka Representation Learning](https://papers.nips.cc/paper_files/paper/2022/hash/c32319f4868da7613d78af9993100e42-Abstract-Conference.html). Primary source for nested dimensional representations and their limits.
6. Li et al., [CoIR](https://arxiv.org/abs/2407.02883). Broadest cited code-retrieval benchmark and unusually clear limitations section.
7. Voorhees and Buckley, [The Effect of Topic Set Size on Retrieval Experiment Error](https://www.nist.gov/publications/effect-topic-set-size-retrieval-experiment-error). Direct warning against overinterpreting small topic sets.
8. [ONNX Runtime execution-provider documentation](https://onnxruntime.ai/docs/execution-providers/) and [quantization documentation](https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html). Required background for the GPU and numeric identity contract.
9. Candidate executable recipes: [BGE-small-en-v1.5](https://huggingface.co/BAAI/bge-small-en-v1.5), [Nomic Embed v1.5](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5), [Qwen3-Embedding-0.6B](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B), and [BGE-M3](https://huggingface.co/BAAI/bge-m3).

</details>

<details>
<summary>Agent 2: Production Systems & Battle-Tested Implementations</summary>

# Research Report — Agent 2: Production Systems & Battle-Tested Implementations

**As of:** 2026-08-23

This report treats model cards as artifact and usage documentation, not proof that a model will improve Magic Context. No source found tests this repository's mix of project-memory prose, exact symbols, debugging history, architectural decisions, and natural-language-to-code retrieval. Model promotion therefore remains subordinate to the repository's judged benchmark.

## 1. Codebase Context

Magic Context has two materially different local execution contracts.

The TypeScript provider defaults to `Xenova/all-MiniLM-L6-v2` (`packages/plugin/src/config/schema/magic-context.ts:22`, `packages/plugin/src/config/schema/magic-context.ts:298-312`) and depends on `@huggingface/transformers` `^4.1.0` (`packages/plugin/package.json:58`). It creates a Transformers.js `feature-extraction` pipeline, defaults to fp32, and invokes it with mean pooling and L2 normalization (`packages/plugin/src/features/magic-context/memory/embedding-local.ts:235-263`, `packages/plugin/src/features/magic-context/memory/embedding-local.ts:423-438`, `packages/plugin/src/features/magic-context/memory/embedding-local.ts:559-564`, `packages/plugin/src/features/magic-context/memory/embedding-local.ts:668-675`). Its logical input ceiling defaults to 512 tokens (`packages/plugin/src/features/magic-context/memory/embedding-local.ts:423-430`). Plain Node/Bun uses the native ONNX Runtime path selected by Transformers.js, while Electron deliberately injects the WASM runtime (`packages/plugin/src/features/magic-context/memory/embedding-local.ts:467-473`, `packages/plugin/src/features/magic-context/memory/embedding-local.ts:549-563`). Model and non-default dtype participate in provider identity, so quantized and fp32 vectors are not mixed (`packages/plugin/src/features/magic-context/memory/embedding-identity.ts:36-78`).

The Rust Synapse lane pins `fastembed = 6.0.0` and `ort = 2.0.0-rc.13`, with defaults disabled and dynamic ORT loading only (`crates/mc-host/Cargo.toml:15-20`). It verifies the exact ORT shared-library bytes before process-global initialization (`crates/mc-host/src/synapse/inference.rs:27-34`, `crates/mc-host/src/synapse/inference.rs:58-108`, `crates/mc-host/src/synapse/inference.rs:118-174`). It loads one owner-provisioned ONNX bundle, supports mean or CLS pooling and fixed quantization/output choices, uses one intra-op thread, and validates dimensions, finite values, and unit norm (`crates/mc-host/src/synapse/inference.rs:177-265`, `crates/mc-host/src/synapse/inference.rs:268-289`). A one-permit semaphore serializes native inference (`crates/mc-host/src/synapse/mod.rs:164-200`). The bundle fingerprint binds artifact hashes, tokenizer files, pooling, quantization, output selection, max tokens, dimensions, table epoch, and semantic-certification corpus (`crates/mc-host/src/synapse/bundle.rs:108-126`, `crates/mc-host/src/synapse/bundle.rs:254-265`, `crates/mc-host/src/synapse/bundle.rs:529-565`; `docs/synapse-model-bundle.md:72-116`).

Provider selection is explicit. `synapse` requires a configured fallback provider; `local`, `openai-compatible`, and `off` are separate choices (`packages/plugin/src/config/schema/magic-context.ts:298-308`). Synapse identity is model plus fingerprint, while local identity is model plus any non-default dtype (`packages/plugin/src/features/magic-context/memory/embedding-identity.ts:18-30`, `packages/plugin/src/features/magic-context/memory/embedding-identity.ts:36-78`). This is already the right base for refusing silent CPU/GPU substitution.

The judged corpus contains 22 queries and 22 documents, derived by parsing `packages/plugin/scripts/fixtures/retrieval-benchmark/v1/corpus.json` (`queries` starts at line 3; `documents` starts at line 520). It has 17 explicit and 5 automatic queries across 10 categories. Repository policy requires three runs, checks holdout macro nDCG@10 and Recall@50 per mode, allows at most a two-point average loss and five-point worst-run loss, and limits candidate median-of-three run-level p95 to 110% of baseline (`packages/plugin/scripts/fixtures/retrieval-benchmark/baselines/v1/policy.json:1-21`). The policy explicitly says these thresholds are repository policy, not statistical confidence (`policy.json:4`).

## 2. Findings

**Finding 1: Synapse is the correct home for an optional GPU lane; the TypeScript provider should remain the portable control**

- **Source**: [Magic Context Synapse Model Bundle Operations](https://github.com/cortexkit/magic-context/blob/main/docs/synapse-model-bundle.md); [ONNX Runtime execution-provider architecture](https://onnxruntime.ai/docs/execution-providers/).
- **Source credibility**: High. The repository document is the normative implementation contract, and the ONNX Runtime page is vendor documentation for provider behavior.
- **Evidence strength**: 3/5, implemented and tested.
- **Summary**: The TypeScript lane permits runtime-selected native ONNX or Electron WASM and downloads or caches model artifacts through Transformers.js. Its identity covers model and non-default dtype but not the native runtime build or execution provider. Synapse rejects a different process-global ORT identity, hash-verifies the runtime and every model artifact, certifies output semantics, and serializes inference (`docs/synapse-model-bundle.md:6-24,118-150`; `crates/mc-host/src/synapse/inference.rs:27-174`; `crates/mc-host/src/synapse/mod.rs:164-200`).
- **Key technique/insight**: Reuse Synapse's immutable bundle, exact runtime identity, semantic certification corpus, and one-lane admission model instead of adding a second device-selection mechanism to the TypeScript provider.
- **Applicability to our problem**: Keep TypeScript MiniLM as the portable control. Add one startup-selected GPU execution provider to Synapse. GPU absence should disable that lane and activate the existing explicit fallback under a different provider identity.
- **Caveats**: This is an architecture fit judgment, not evidence that GPU inference improves quality or p95. ORT must never execute the same declared GPU lane silently on CPU.

**Finding 2: The current MiniLM baseline is artifact-specific and must be measured exactly as deployed**

- **Source**: [Upstream all-MiniLM-L6-v2 model card](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2); [Xenova tokenizer configuration](https://huggingface.co/Xenova/all-MiniLM-L6-v2/raw/main/tokenizer_config.json); [Xenova artifact metadata](https://huggingface.co/api/models/Xenova/all-MiniLM-L6-v2?blobs=true).
- **Source credibility**: High. These are the model owner's card and the exact deployed conversion's published configuration and artifacts.
- **Evidence strength**: 3/5, official artifacts plus an implemented repository path.
- **Summary**: The upstream card identifies Apache-2.0 licensing, 384-dimensional output, and default truncation after 256 word pieces. Its metadata reports 22,713,728 parameters. The deployed Xenova conversion declares `model_max_length: 512`; its fp32 ONNX file is 90,387,606 bytes and it also publishes fp16, integer, and 4-bit variants. Magic Context uses that Xenova artifact with fp32, mean pooling, normalization, and a 512-token application ceiling.
- **Key technique/insight**: Define the baseline by exact model and tokenizer artifacts plus preprocessing, not by the family name `all-MiniLM-L6-v2`.
- **Applicability to our problem**: Every candidate comparison must load the same Xenova baseline used in production. A standard Sentence Transformers run that truncates at 256 is not equivalent for inputs between 257 and 512 tokens.
- **Caveats**: Artifact metadata establishes what is shipped, not whether processing 512 tokens improves retrieval. The judged corpus must decide that.

**Finding 3: The strongest first-round CPU ONNX additions are GTE ModernBERT base and Snowflake Arctic Embed m v1.5**

- **Source**: [GTE ModernBERT model card](https://huggingface.co/Alibaba-NLP/gte-modernbert-base); [GTE artifact metadata](https://huggingface.co/api/models/Alibaba-NLP/gte-modernbert-base?blobs=true); [Arctic m v1.5 model card](https://huggingface.co/Snowflake/snowflake-arctic-embed-m-v1.5); [Arctic m artifact metadata](https://huggingface.co/api/models/Snowflake/snowflake-arctic-embed-m-v1.5?blobs=true); [BGE-small card](https://huggingface.co/BAAI/bge-small-en-v1.5); [Nomic v1.5 card](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5).
- **Source credibility**: High for artifact identity, dimensions, context, prompts, and license. Model-owner quality claims remain self-reported.
- **Evidence strength**: 3/5, official model cards and executable artifacts; no Magic Context transfer proof.
- **Summary**: `Alibaba-NLP/gte-modernbert-base` is Apache-2.0, 149,014,272 parameters, English, 8,192 tokens, and 768 dimensions. It publishes fp32, fp16, int8, uint8, and 4-bit ONNX variants, uses CLS pooling, and declares no prompt. `Snowflake/snowflake-arctic-embed-m-v1.5` is Apache-2.0, 108,891,648 parameters, 512 tokens, and 768 dimensions. It publishes multiple ONNX precisions, documents Matryoshka use at 256 dimensions, and requires query-only prefix `Represent this sentence for searching relevant passages: `. Existing floor candidates remain BGE-small at 33,360,512 parameters, 384 dimensions, and 512 tokens, and Nomic v1.5 at 136,731,648 parameters, 8,192 tokens, and documented 512/256 Matryoshka outputs with `search_query:` and `search_document:` prefixes.
- **Key technique/insight**: Add only candidates that test a distinct production hypothesis: long-context ModernBERT without a prompt transform, and a compact compression-aware retriever near Nomic's size.
- **Applicability to our problem**: Benchmark GTE 768 and Arctic m at 256 and 768 alongside BGE-small and Nomic 256/512. This is a bounded CPU matrix with official ONNX artifacts and supported mean or CLS pooling.
- **Caveats**: Do not add `mixedbread-ai/mxbai-embed-large-v1` or `lightonai/modernbert-embed-large` in the first round. Their [mxbai metadata](https://huggingface.co/api/models/mixedbread-ai/mxbai-embed-large-v1?blobs=true) and [ModernBERT Embed metadata](https://huggingface.co/api/models/lightonai/modernbert-embed-large?blobs=true) show materially larger models without filling a new first-round gap. This is shortlist control, not a claim that they are lower quality.

**Finding 4: Jina v2 base code is the deployable code-specialist; CodeRankEmbed is an export-parity experiment**

- **Source**: [Jina v2 base code model card](https://huggingface.co/jinaai/jina-embeddings-v2-base-code); [Jina artifact metadata](https://huggingface.co/api/models/jinaai/jina-embeddings-v2-base-code?blobs=true); [CodeRankEmbed model card](https://huggingface.co/nomic-ai/CodeRankEmbed); [CodeRankEmbed artifact metadata](https://huggingface.co/api/models/nomic-ai/CodeRankEmbed?blobs=true); [CoRNStack paper](https://arxiv.org/abs/2412.01007).
- **Source credibility**: High for model metadata and artifacts; Moderate for transfer from the authors' code-retrieval evaluation to mixed project memory.
- **Evidence strength**: 3/5, official artifacts plus an implemented research report.
- **Summary**: `jinaai/jina-embeddings-v2-base-code` is Apache-2.0, 160,869,120 parameters, 768 dimensions, and 8,192 tokens. Its card states support for English and 30 programming languages, and its repository publishes fp32, fp16, and quantized ONNX files. `nomic-ai/CodeRankEmbed` is MIT, 136,731,648 parameters, 768 dimensions, 8,192 tokens, and requires `Represent this query for searching relevant code: `. Its `main` branch has no ONNX artifact and uses custom code. CoRNStack reports code-retrieval and GitHub-issue function-localization gains but does not evaluate project-memory prose.
- **Key technique/insight**: Separate a directly deployable code encoder from a research candidate that first needs a reproducible export and componentwise reference parity.
- **Applicability to our problem**: Put Jina v2 code in the judged matrix as the single production-ready code specialist. Keep CodeRankEmbed experimental until an owner-controlled ONNX export passes Synapse certification.
- **Caveats**: Reject `jinaai/jina-code-embeddings-0.5b` from the production shortlist because its [official card](https://huggingface.co/jinaai/jina-code-embeddings-0.5b) uses CC-BY-NC-4.0 and its repository has no ONNX artifact. Neither Jina v2 nor CodeRank proves performance on mixed memories, exact paths, temporal facts, or instructions.

**Finding 5: The useful GPU quality ladder is Snowflake l v2.0, Qwen3 0.6B, then Qwen3 4B as a ceiling**

- **Source**: [Arctic l v2.0 model card](https://huggingface.co/Snowflake/snowflake-arctic-embed-l-v2.0); [Arctic l artifact metadata](https://huggingface.co/api/models/Snowflake/snowflake-arctic-embed-l-v2.0?blobs=true); [Qwen3 0.6B card](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B); [Qwen3 0.6B metadata](https://huggingface.co/api/models/Qwen/Qwen3-Embedding-0.6B?blobs=true); [Qwen3 4B card](https://huggingface.co/Qwen/Qwen3-Embedding-4B); [Qwen3 Embedding paper](https://arxiv.org/abs/2506.05176).
- **Source credibility**: High for artifact, license, context, dimension, and prompt facts; Moderate for model-owner quality claims.
- **Evidence strength**: 3/5, official artifacts/cards and implemented serving support.
- **Summary**: Arctic l v2.0 is Apache-2.0, 567,754,752 parameters, 1,024 dimensions, and 8,192 tokens. It publishes official ONNX plus external data, uses CLS pooling and `query: `, and documents a 256-dimensional Matryoshka output. Qwen3 0.6B is Apache-2.0, 595,776,512 parameters, 32K context, native 1,024 dimensions, and user-selected dimensions from 32 through 1,024. Qwen3 4B has 4,021,774,336 parameters, 32K context, native 2,560 dimensions, and Matryoshka support. Qwen queries use `Instruct: {task_description}\nQuery:{query}`; documents have no instruction. The official Qwen repositories, created 2025-06-03, do not publish ONNX artifacts.
- **Key technique/insight**: Order GPU experiments by implementation risk: owner-published ONNX first, then a larger model needing a separate Candle/TEI or certified export path, then a costly ceiling model.
- **Applicability to our problem**: Test Arctic l v2.0 at 256 and 1,024 first. Retain Qwen3 0.6B at 256/512 as the main larger-model candidate. Test Qwen3 4B at 512/1,024 only if target VRAM and the quality campaign justify it.
- **Caveats**: Do not add Qwen3 8B before 4B wins in-domain. No source proves that any rung wins Magic Context's corpus, and Qwen's missing owner ONNX artifact is a real implementation blocker for the current lane.

**Finding 6: EmbeddingGemma is technically credible but licensing-conditional**

- **Source**: [Google EmbeddingGemma model card](https://ai.google.dev/gemma/docs/embeddinggemma/model_card); [Hugging Face EmbeddingGemma technical article](https://huggingface.co/blog/embeddinggemma); [community ONNX artifact metadata](https://huggingface.co/api/models/onnx-community/embeddinggemma-300m-ONNX?blobs=true); [FastEmbed 6 model source](https://docs.rs/fastembed/6.0.0/src/fastembed/models/text_embedding.rs.html).
- **Source credibility**: High for the owner model contract and maintained artifact registry. The ONNX export is community-maintained rather than owner-published.
- **Evidence strength**: 3/5, official 2025 model documentation plus an implemented community export.
- **Summary**: EmbeddingGemma has 308M parameters, a 2K input limit, native 768-dimensional output, and documented 512/256/128 Matryoshka truncation. Retrieval prompts are `task: search result | query: ` and `title: none | text: `. The original model is gated under the Gemma license. `onnx-community/embeddinggemma-300m-ONNX` publishes fp32, fp16, int8, and 4-bit variants, and FastEmbed 6 lists its `sentence_embedding` output.
- **Key technique/insight**: Treat legal permission and export provenance as first-class admission gates, separate from technical compatibility.
- **Applicability to our problem**: Include 256/512 only as a conditional judged experiment after legal and redistribution review, then certify the community export against the owner implementation.
- **Caveats**: A maintained community export is not equivalent to an owner artifact. EmbeddingGemma must not delay permissively licensed candidates or become a redistributable default without explicit approval.

**Finding 7: BGE-M3 stays experimental because Magic Context presently discards two of its three retrieval modes**

- **Source**: [BGE-M3 model card](https://huggingface.co/BAAI/bge-m3); [BGE-M3 artifact metadata](https://huggingface.co/api/models/BAAI/bge-m3?blobs=true); [FastEmbed 6 documentation](https://docs.rs/fastembed/6.0.0/fastembed/).
- **Source credibility**: High for model capabilities, artifacts, and runtime support. Public hybrid-quality claims are model-owner evidence.
- **Evidence strength**: 3/5, official model documentation and an implemented runtime path.
- **Summary**: BGE-M3 is MIT, 1,024-dimensional, accepts 8,192 tokens, and emits dense, learned sparse, and ColBERT-style multi-vector representations. Its repository publishes ONNX plus external data. FastEmbed 6 offers both a dense `TextEmbedding` entry and a dedicated `Bgem3Embedding` path for all three outputs. The official card does not state a parameter count, so this report does not infer one.
- **Key technique/insight**: Distinguish a dense-model comparison from a retrieval-architecture comparison. BGE-M3's main differentiator is hybrid and late-interaction output, not only a larger dense vector.
- **Applicability to our problem**: Keep native 1,024-dimensional dense BGE-M3 in an experimental cell. Evaluate dense+sparse or multi-vector retrieval only as a separate index, scoring, identity, latency, and rollback project.
- **Caveats**: Current storage consumes one dense vector and Synapse selects one output (`crates/mc-host/src/synapse/bundle.rs:108-155`). Dense-only evaluation leaves two advertised modes unused, so public hybrid scores do not transfer.

**Finding 8: Weight memory separates realistic CPU candidates from GPU-only experiments**

- **Source**: [BGE-small metadata](https://huggingface.co/api/models/BAAI/bge-small-en-v1.5?blobs=true); [Arctic m metadata](https://huggingface.co/api/models/Snowflake/snowflake-arctic-embed-m-v1.5?blobs=true); [Nomic metadata](https://huggingface.co/api/models/nomic-ai/nomic-embed-text-v1.5?blobs=true); [GTE metadata](https://huggingface.co/api/models/Alibaba-NLP/gte-modernbert-base?blobs=true); [Jina code metadata](https://huggingface.co/api/models/jinaai/jina-embeddings-v2-base-code?blobs=true); [Arctic l metadata](https://huggingface.co/api/models/Snowflake/snowflake-arctic-embed-l-v2.0?blobs=true); [Qwen3 0.6B metadata](https://huggingface.co/api/models/Qwen/Qwen3-Embedding-0.6B?blobs=true); [Qwen3 4B metadata](https://huggingface.co/api/models/Qwen/Qwen3-Embedding-4B?blobs=true).
- **Source credibility**: High. Parameter counts come from the official repositories' `safetensors.total` metadata; memory values are direct arithmetic.
- **Evidence strength**: 3/5, official artifact metadata plus reproducible calculation.
- **Summary**: Weight-only fp32/fp16/int8 lower bounds are about 127/64/32 MiB for BGE-small; 415/208/104 MiB for Arctic m; 522/261/130 MiB for Nomic; 568/284/142 MiB for GTE; 614/307/153 MiB for Jina v2 code; 2.12/1.06/0.53 GiB for Arctic l; 2.22/1.11/0.55 GiB for Qwen3 0.6B; and 14.98/7.49/3.75 GiB for Qwen3 4B.
- **Key technique/insight**: Use parameter-byte arithmetic only as an early feasibility floor. Measure complete process RSS or VRAM under exact batch and token workloads before promotion.
- **Applicability to our problem**: The figures keep Qwen3 4B out of the CPU lane and require target-GPU VRAM evidence. They also show that GTE, Nomic, Arctic m, and Jina remain plausible CPU candidates with quantized artifacts.
- **Caveats**: These are not deployment memory numbers. Activations, attention workspace, ORT arenas, CUDA kernels, TensorRT engines, batch, and token length add memory. Output-dimension truncation reduces stored vector and scan cost, not encoder weight or compute cost.

**Finding 9: Prompting, padding, pooling, and output truncation must become explicit embedding identity**

- **Source**: [BGE-small model card](https://huggingface.co/BAAI/bge-small-en-v1.5); [Nomic v1.5 model card](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5); [Arctic m model card](https://huggingface.co/Snowflake/snowflake-arctic-embed-m-v1.5); [Arctic l model card](https://huggingface.co/Snowflake/snowflake-arctic-embed-l-v2.0); [Qwen3 model card](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B); [FastEmbed 6 Qwen3 source](https://docs.rs/fastembed/6.0.0/src/fastembed/models/qwen3.rs.html).
- **Source credibility**: High for executable model-owner recipes and exact runtime source.
- **Evidence strength**: 3/5, documented and implemented contracts.
- **Summary**: BGE and Arctic m use a query-only `Represent this sentence...` prefix; Nomic uses `search_query:` and `search_document:`; Arctic l uses `query: `; CodeRankEmbed requires a code-search query instruction; EmbeddingGemma prefixes both query and document; BGE-M3 says it no longer requires query instructions; and Qwen3 uses an instruction-bearing query, no document instruction, left padding, and last-token pooling. The local provider accepts but ignores `EmbeddingPurpose` (`embedding-local.ts:644-648,684-688`). Synapse embeds supplied text unchanged, supports only mean or CLS pooling, and does not fingerprint query/document templates or last-token pooling (`inference.rs:208-225`; `bundle.rs:529-565`).
- **Key technique/insight**: Make preprocessing a versioned host-owned contract. Fingerprint exact query template, document template, pooling, padding side, truncation side, output dimension, quantization, normalization, and artifact identity.
- **Applicability to our problem**: A benchmark that swaps only model IDs is invalid. Candidate adapters must apply exact asymmetric recipes. Prefer host-side templates selected by `embed.query` versus passage batch so callers cannot drift.
- **Caveats**: Qwen3 cannot use the current user-defined Synapse path unless the graph emits the final sentence embedding or the host adds left-padding and last-token support. Every preprocessing or output change creates a new fingerprint and requires lazy re-embedding.

**Finding 10: FastEmbed 6 supports execution-provider injection, but its `cuda` feature is not the ONNX CUDA switch**

- **Source**: [FastEmbed user-defined init source](https://docs.rs/fastembed/6.0.0/src/fastembed/text_embedding/init.rs.html); [FastEmbed user-defined constructor](https://docs.rs/fastembed/6.0.0/src/fastembed/text_embedding/impl.rs.html); [FastEmbed 6 features](https://docs.rs/crate/fastembed/6.0.0/features); [FastEmbed crate source](https://docs.rs/fastembed/6.0.0/src/fastembed/lib.rs.html).
- **Source credibility**: High. These sources are generated from the exact pinned crate release.
- **Evidence strength**: 3/5, exact implementation source.
- **Summary**: `InitOptionsUserDefined` contains `execution_providers`, and the constructor passes them into the ORT `SessionBuilder`. Current Synapse leaves that vector empty and sets only max length and one intra-op thread (`crates/mc-host/src/synapse/inference.rs:236-256`). FastEmbed's Cargo `cuda` feature enables Candle implementations for Qwen3 and Nomic v2 MoE; it does not enable ONNX Runtime CUDA. Its `qwen3` feature also enables Hugging Face access, while this repository intentionally forbids runtime downloads.
- **Key technique/insight**: Treat ONNX CUDA and Candle CUDA as separate backends with separate artifacts, loaders, pooling, dependencies, and identities.
- **Applicability to our problem**: Existing ONNX candidates need `ort/cuda`, a GPU-capable exact ORT build, and an explicit `CUDAExecutionProvider` dispatch. Qwen3 through FastEmbed 6 would require a separately designed offline safetensors/Candle bundle.
- **Caveats**: Supporting both paths in the first release would violate the minimal-provider constraint. FastEmbed API availability alone does not prove that the runtime library contains or can initialize the requested EP.

**Finding 11: Linux NVIDIA CUDA is the only justified first GPU platform, and provider failure must be fatal to that lane**

- **Source**: [ONNX Runtime CUDA EP requirements](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html#requirements); [ONNX Runtime EP architecture](https://onnxruntime.ai/docs/execution-providers/); [ort 2.0.0-rc.13 EP source](https://docs.rs/ort/2.0.0-rc.13/src/ort/ep/mod.rs.html); [ort session-builder source](https://docs.rs/ort/2.0.0-rc.13/src/ort/session/builder/impl_options.rs.html).
- **Source credibility**: High. ONNX Runtime vendor docs and exact pinned Rust binding source define the behavior directly.
- **Evidence strength**: 3/5, implemented runtime contracts.
- **Summary**: ORT CUDA requires a build matched to CUDA and cuDNN major versions; cuDNN 8 and 9 builds are not interchangeable, and vendor libraries must be discoverable. EP order controls graph partitioning, so unsupported nodes may remain on CPU. In `ort` rc.13, `ExecutionProviderDispatch` silently logs registration failure and falls back by default; `.error_on_failure()` makes registration failure fatal.
- **Key technique/insight**: Define one startup-selected Linux NVIDIA profile and fail closed. Pin runtime build provenance, main ORT library, provider DSOs, ordered EP list, provider options, CUDA/cuDNN majors, device policy, and semantic-certification output.
- **Applicability to our problem**: Configure CUDA with `.error_on_failure()`, create the session, run structural and semantic certification, and publish the lane only after all checks pass. On failure, disable Synapse and use the separately identified TypeScript fallback.
- **Caveats**: Some unsupported operations may legitimately run on CPU within a CUDA session. If allowed, identity must say `CUDA+CPU partition`, not “CUDA only.” System driver libraries may be impractical to content-pin; record resolved versions and enforce a tested compatibility range.

**Finding 12: TensorRT, AMD, DirectML, CoreML, and external servers are valid later options, not first-release scope**

- **Source**: [ONNX Runtime TensorRT EP](https://onnxruntime.ai/docs/execution-providers/TensorRT-ExecutionProvider.html); [ROCm EP removal notice](https://onnxruntime.ai/docs/execution-providers/ROCm-ExecutionProvider.html); [MIGraphX EP](https://onnxruntime.ai/docs/execution-providers/MIGraphX-ExecutionProvider.html); [DirectML EP](https://onnxruntime.ai/docs/execution-providers/DirectML-ExecutionProvider.html); [CoreML EP](https://onnxruntime.ai/docs/execution-providers/CoreML-ExecutionProvider.html); [TEI README](https://github.com/huggingface/text-embeddings-inference/blob/main/README.md); [Infinity README](https://github.com/michaelfeil/infinity/blob/main/README.md); [vLLM pooling documentation](https://docs.vllm.ai/en/stable/models/pooling_models/).
- **Source credibility**: High for official runtime constraints; Moderate for project-maintainer production claims. Public integration lists without deployment measurements are **WEAK (strength 2)** evidence of production scale.
- **Evidence strength**: 3/5 overall for implemented runtimes; external adoption evidence is **WEAK (strength 2)**.
- **Summary**: ORT recommends TensorRT before CUDA, and TensorRT engine caches depend on model, precision, profiles, settings, and GPU; dynamic shapes can rebuild engines. Legacy ROCm EP was removed starting with ORT 1.23 in favor of MIGraphX. DirectML is Windows DirectX 12, in sustained engineering, and requires sequential execution with memory-pattern optimization disabled. CoreML is Apple-only, while current secure Synapse staging rejects non-Linux. TEI supports relevant model families, token-based dynamic batching, safetensors and ONNX, CUDA images, metrics, tracing, revision, dtype, prompt, and truncation controls. Infinity supports several engines and accelerators but is multi-model by design. vLLM explicitly says pooling support is for convenience and is not guaranteed to improve performance.
- **Key technique/insight**: Defer runtime breadth until one pinned CUDA ORT lane establishes a measured need. Use TensorRT only for a CUDA-qualified winner that misses performance. Use TEI only if an ONNX-incompatible model, especially Qwen3, wins by enough to justify a service boundary.
- **Applicability to our problem**: CUDA ORT preserves the current Synapse bundle, certification, and one-lane process model with the fewest moving parts. The other providers either conflict with Linux-only staging, add platform matrices, introduce model-service behavior, or lack a proven performance advantage.
- **Caveats**: TEI's published A10 benchmark uses BGE-base, 512-token inputs, and batch sizes 1 and 32, but numeric results are images and do not establish Magic Context p95. No public runtime report supplies workload, revision, batch distribution, and tail-latency evidence transferable to this repository.

## 3. Structured Evidence Summary

```json
[
  {
    "id": "F1",
    "claim": "Synapse's immutable bundle, exact runtime identity, semantic certification, and one-lane admission contract make it the correct home for an optional GPU path.",
    "source_url": "https://github.com/cortexkit/magic-context/blob/main/docs/synapse-model-bundle.md",
    "source_title": "Magic Context Synapse Model Bundle Operations",
    "evidence_strength": 3,
    "credibility_tier": "High",
    "applicability": "Keep TypeScript MiniLM as the portable control and add only one startup-selected, separately identified GPU Synapse lane."
  },
  {
    "id": "F2",
    "claim": "The deployed MiniLM baseline is the exact Xenova ONNX and tokenizer recipe, not a generic upstream MiniLM run.",
    "source_url": "https://huggingface.co/api/models/Xenova/all-MiniLM-L6-v2?blobs=true",
    "source_title": "Xenova all-MiniLM-L6-v2 artifact metadata",
    "evidence_strength": 3,
    "credibility_tier": "High",
    "applicability": "Benchmark the exact fp32 Xenova artifact, 512-token configuration, mean pooling, normalization, and repository chunking as the control."
  },
  {
    "id": "F3",
    "claim": "GTE ModernBERT base and Snowflake Arctic Embed m v1.5 are the strongest additional first-round CPU ONNX candidates.",
    "source_url": "https://huggingface.co/Alibaba-NLP/gte-modernbert-base",
    "source_title": "GTE ModernBERT base model card",
    "evidence_strength": 3,
    "credibility_tier": "High",
    "applicability": "Add GTE 768 and Arctic m 256/768 to the existing BGE-small and Nomic judged matrix."
  },
  {
    "id": "F4",
    "claim": "Jina v2 base code is directly ONNX-deployable, while CodeRankEmbed first requires an owner-controlled export and parity proof.",
    "source_url": "https://huggingface.co/jinaai/jina-embeddings-v2-base-code",
    "source_title": "Jina Embeddings v2 base code model card",
    "evidence_strength": 3,
    "credibility_tier": "Moderate",
    "applicability": "Use Jina v2 as the one production-ready code specialist and keep CodeRankEmbed experimental."
  },
  {
    "id": "F5",
    "claim": "The bounded GPU model ladder is Arctic l v2.0 first, Qwen3 0.6B second, and Qwen3 4B only as a ceiling experiment.",
    "source_url": "https://huggingface.co/Qwen/Qwen3-Embedding-0.6B",
    "source_title": "Qwen3-Embedding-0.6B model card",
    "evidence_strength": 3,
    "credibility_tier": "Moderate",
    "applicability": "Test owner-published ONNX first, then Qwen only through a separately specified runtime or certified export."
  },
  {
    "id": "F6",
    "claim": "EmbeddingGemma is technically viable at reduced dimensions but remains gated by Gemma licensing and community-export provenance.",
    "source_url": "https://ai.google.dev/gemma/docs/embeddinggemma/model_card",
    "source_title": "Google EmbeddingGemma model card",
    "evidence_strength": 3,
    "credibility_tier": "High",
    "applicability": "Run 256/512 only after legal review and componentwise parity certification; do not make it a default yet."
  },
  {
    "id": "F7",
    "claim": "BGE-M3's production value is its dense, sparse, and multi-vector architecture, while the current system consumes only one dense output.",
    "source_url": "https://huggingface.co/BAAI/bge-m3",
    "source_title": "BGE-M3 model card",
    "evidence_strength": 3,
    "credibility_tier": "High",
    "applicability": "Keep dense BGE-M3 experimental and treat hybrid BGE-M3 as a separate retrieval-architecture project."
  },
  {
    "id": "F8",
    "claim": "Weight-only memory floors keep compact encoders CPU-plausible and place Qwen3 4B firmly in GPU-only experimentation.",
    "source_url": "https://huggingface.co/api/models/Qwen/Qwen3-Embedding-4B?blobs=true",
    "source_title": "Qwen3-Embedding-4B artifact metadata",
    "evidence_strength": 3,
    "credibility_tier": "High",
    "applicability": "Use parameter arithmetic for early rejection, then measure complete RSS or VRAM under exact batches and token lengths."
  },
  {
    "id": "F9",
    "claim": "Query and document prompts, padding, pooling, truncation, output dimension, quantization, and normalization are embedding-space identity fields.",
    "source_url": "https://docs.rs/fastembed/6.0.0/src/fastembed/models/qwen3.rs.html",
    "source_title": "FastEmbed 6 Qwen3 implementation",
    "evidence_strength": 3,
    "credibility_tier": "High",
    "applicability": "Add a versioned host-owned preprocessing contract before benchmarking or deploying asymmetric candidates."
  },
  {
    "id": "F10",
    "claim": "FastEmbed execution-provider injection can drive ONNX GPU sessions, but FastEmbed's cuda feature selects Candle code rather than ORT CUDA.",
    "source_url": "https://docs.rs/crate/fastembed/6.0.0/features",
    "source_title": "FastEmbed 6 feature list",
    "evidence_strength": 3,
    "credibility_tier": "High",
    "applicability": "Use ort/cuda for existing ONNX bundles and treat Candle Qwen3 as a separate backend contract."
  },
  {
    "id": "F11",
    "claim": "One Linux NVIDIA CUDA profile with fatal EP-registration failure is the minimum reproducible GPU runtime contract.",
    "source_url": "https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html#requirements",
    "source_title": "ONNX Runtime CUDA Execution Provider requirements",
    "evidence_strength": 3,
    "credibility_tier": "High",
    "applicability": "Pin runtime and provider identity, certify at startup, and use an explicitly separate fallback when CUDA is unavailable."
  },
  {
    "id": "F12",
    "claim": "TensorRT, MIGraphX, DirectML, CoreML, TEI, Infinity, and vLLM add platform or service complexity that is not justified for the first GPU release.",
    "source_url": "https://onnxruntime.ai/docs/execution-providers/TensorRT-ExecutionProvider.html",
    "source_title": "ONNX Runtime TensorRT Execution Provider",
    "evidence_strength": 3,
    "credibility_tier": "High",
    "applicability": "Defer runtime breadth until CUDA ORT evidence identifies a specific unmet need; treat public adoption evidence as WEAK strength 2."
  }
]
```

## 4. Patterns & Consensus

Production implementations converge on artifact pinning, explicit preprocessing, fixed model revisions, dynamic batching, and startup-time device configuration. TEI, FastEmbed, Sentence Transformers configurations, and ONNX Runtime all expose these as separate controls because a model name does not fully determine served vectors.

The compact models with the cleanest ONNX path remain encoder models between roughly 33M and 160M parameters. They are credible CPU candidates and should be exhausted before paying for a GPU service. Larger decoder-derived Qwen3 embeddings provide a plausible quality ceiling, including code retrieval evidence in the authors' evaluation, but require a different pooling/runtime path and much more memory.

Matryoshka dimensions reduce vector-table size and cosine-scan bandwidth, but do not make the encoder itself smaller. Every dimension is a distinct benchmark candidate and embedding identity. Quantized model weights likewise need their own certification because lower precision can alter nearest-neighbor order even when public aggregate scores move little.

GPU acceleration is workload-sensitive. Dynamic batching helps throughput under concurrent load, but Magic Context's one serialized lane and interactive queries may run at batch one. No public benchmark establishes that a GPU path will satisfy this repository's p95 gate after process startup, tokenization, IPC, and low batch occupancy. The local three-run gate is the only decision-grade evidence.

## 5. Disagreements & Open Questions

1. **Corpus resolution.** Twenty-two judged queries are appropriate as a regression gate but weak as a broad model-selection population, especially with only five automatic queries. A candidate can pass policy while overfitting a few intents. Add judged cases only through the existing review process, and report per-category deltas beside aggregate pass/fail.

2. **Target GPU is unspecified.** CUDA version, cuDNN major, compute capability, VRAM, driver, and target architecture materially change packaging and performance. No GPU runtime can be certified until one minimum platform is named.

3. **Qwen3 execution path is unresolved.** Official repositories have no ONNX export, current Synapse cannot express last-token pooling, and FastEmbed's Qwen3 path is Candle with Hugging Face loading. Choose between an owner-controlled offline safetensors Candle bundle, TEI sidecar, or a certified ONNX export only after Qwen3 wins a quality-only benchmark.

4. **Prompt ownership is unresolved.** The candidate floor requires correct query/document instructions, but local and Synapse backends currently do not apply purpose-specific text transforms. Benchmark adapters can prove model quality, but production needs one host-owned preprocessing contract before promotion.

5. **GPU/CPU numerical equivalence is not guaranteed.** Even the same ONNX graph can change low-order values across providers and precision. Decide whether componentwise certification establishes one compatible space or whether every provider gets a distinct fingerprint. The safer default is distinct identity unless a strict equivalence test proves otherwise.

6. **EmbeddingGemma redistribution needs review.** Technical feasibility is established; permission to redistribute a gated Gemma-derived bundle is not.

7. **No evidence level 5 was found.** Maintained runtimes are real implementations, but no public deployment report states scale, workload, model revision, batch distribution, and tail latency closely enough to transfer to Magic Context. Vendor/model-card results remain evidence level 2-3.

## 6. Recommended Reading

1. [Synapse Model Bundle Operations](../../../docs/synapse-model-bundle.md) — current normative artifact, fingerprint, and failure contract.
2. [ONNX Runtime execution-provider architecture](https://onnxruntime.ai/docs/execution-providers/) and [CUDA EP requirements](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html) — provider partitioning and package compatibility.
3. [ONNX Runtime TensorRT EP](https://onnxruntime.ai/docs/execution-providers/TensorRT-ExecutionProvider.html) — provider order, engine caches, and portability limits.
4. [FastEmbed 6.0.0 documentation](https://docs.rs/fastembed/6.0.0/fastembed/) and [feature list](https://docs.rs/crate/fastembed/6.0.0/features) — exact pinned runtime's ONNX/Candle split.
5. [Qwen3-Embedding-0.6B model card](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B) and [paper](https://arxiv.org/abs/2506.05176) — prompts, pooling, dimensions, and authors' code-retrieval evidence.
6. [GTE ModernBERT base model card](https://huggingface.co/Alibaba-NLP/gte-modernbert-base) and [Snowflake Arctic Embed l v2.0 card](https://huggingface.co/Snowflake/snowflake-arctic-embed-l-v2.0) — strongest additional ONNX candidates at CPU and GPU scales.
7. [CoRNStack / CodeRankEmbed paper](https://arxiv.org/abs/2412.01007) — code-specialized retrieval evidence and its transfer limits.
8. [Hugging Face TEI README](https://github.com/huggingface/text-embeddings-inference/blob/main/README.md) — best-maintained alternate GPU serving path if an ONNX-incompatible model wins.

</details>

<details>
<summary>Agent 3: Failure Modes, Post-Mortems & Anti-Patterns</summary>

# Research Report — Agent 3: Failure Modes, Post-Mortems & Anti-Patterns

**Research date:** 2026-08-23  
**Scope:** Failure evidence that should constrain model screening, GPU execution, and embedding-space identity for magic-context. Public leaderboard scores are treated as discovery evidence, not as a selection gate.  
**Evidence scale:** 5 = proven at scale; 4 = peer-reviewed; 3 = implemented, tested, or reproducible issue; 2 = credible documented practice; 1 = anecdotal. `WEAK` marks strength 2 or lower, or Low-credibility evidence.

## 1. Codebase Context

The local lane is narrower than its configurable model name suggests. It defaults to `Xenova/all-MiniLM-L6-v2` (`packages/plugin/src/config/schema/magic-context.ts:22`), exposes multiple Transformers.js dtypes, and preserves fp32 as the default (`packages/plugin/src/features/magic-context/memory/embedding-local.ts:12-29,258-263`). Its actual vector recipe is fixed: both single and batch calls ignore `EmbeddingPurpose`, use mean pooling, and request L2 normalization (`embedding-local.ts:644-672,684-718`). The constructor advertises 512 input tokens and builds identity from model name plus non-default dtype (`embedding-local.ts:423-438`; `embedding-identity.ts:37-78`). Pooling, prompt/instruction policy, artifact revision, tokenizer bytes, effective truncation, output dimension, and runtime build do not participate in that local identity.

The local lane already contains one relevant native-runtime post-mortem. Concurrent model loads on older `onnxruntime-node` builds could double-free native state and kill the process, so a cross-process lock now serializes `InferenceSession::LoadModel` (`embedding-local.ts:31-38,105-116,524-563`). This is direct repository evidence that “model load is read-only” is not a safe concurrency assumption for native runtimes.

Synapse has a materially stronger contract. It is CPU-only, loads one FastEmbed model, serializes native inference, and uses one intra-op thread (`crates/mc-host/src/synapse/inference.rs:1-3,177-188,252-265`). One semaphore permit admits at most one native call, and a tracker owns every started call through shutdown (`crates/mc-host/src/synapse/mod.rs:169-178,492-535,638-675,916-925`). Startup performs structural checks and componentwise semantic certification; vectors must have the expected count, dimension, finite values, and norm, and the pinned certification corpus is chosen to expose pooling, output-selection, and truncation mistakes (`inference.rs:268-345`).

The bundle documentation makes the intended invariant explicit. Model, external data, all tokenizer files, and the certification corpus are byte-hashed (`docs/synapse-model-bundle.md:8-24`). The fingerprint covers dimensions, pooling, quantization, output selection, truncation, and fixed L2 post-processing (`docs/synapse-model-bundle.md:53-77`). The ORT shared library is separately hash-pinned, the dependency graph disables download and accelerator features, bundles are immutable, and no request may select a model (`docs/synapse-model-bundle.md:118-142,180-189`). A GPU lane should extend this contract, not weaken it.

The judged benchmark is much better than the older snapshot tool. The old tool explicitly says it has no gold labels and cannot measure precision or recall (`packages/plugin/scripts/embedding-baseline.ts:13-21`). In contrast, `buildCorpusArtifacts()` deterministically yields 22 queries, 22 documents, 24 human judgments, and ten categories. The split is 11 development and 11 holdout queries; by mode it is 17 explicit and five automatic overall, but only nine explicit and **two automatic** queries in holdout. These counts derive from the authored scenarios (`packages/plugin/scripts/build-benchmark-corpus.ts:63-337,421-488`) and the ten-category contract (`packages/plugin/scripts/retrieval-benchmark/contract.ts:51-62`). Tests require every query to have a positive human grade (`build-benchmark-corpus.test.ts:64-76`). The regression gate evaluates holdout nDCG@10 and Recall@50 separately by mode (`retrieval-benchmark/regression.ts:82-90`) and requires three runs with latency bounds (`scripts/fixtures/retrieval-benchmark/baselines/v1/policy.json:4-20`). The two-query automatic holdout is therefore the effective sample for one half of the quality gate.

### Candidate artifact snapshot

The table records model-hub metadata observed on 2026-08-23. Hashes are full Hugging Face repository revisions, not sufficient by themselves for a production bundle; every consumed file still needs its own digest. License values are model-card metadata, not legal advice.

| Candidate | Revision observed | License metadata | Required vector semantics | Failure-sensitive fit |
|---|---|---|---|---|
| Current `Xenova/all-MiniLM-L6-v2` | `751bff37182d3f1213fa05d7196b954e230abad9` | Apache-2.0 | mean pool, normalize; converted tokenizer says 512 | Fits local recipe, but provenance and 256-vs-512 source contract are unresolved. |
| `BAAI/bge-small-en-v1.5` | `5c38ec7c405ec4b44b94cc5a9bb96e735b38267a` | MIT | CLS pool; 512 tokens; optional query instruction | Fits Synapse `cls` only after query policy is explicit. It is wrong under the current local mean-pooling recipe. |
| `nomic-ai/nomic-embed-text-v1.5` | `e9b6763023c676ca8431644204f50c2b100d9aab` | Apache-2.0 | mean pool; task prefixes; for 256/512: layer-normalize, prefix-truncate, then L2-normalize | Not a drop-in 256/512 candidate for either current lane. Its config also carries remote `auto_map` entries. |
| `Qwen/Qwen3-Embedding-0.6B` | `97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3` | Apache-2.0 | last-token pool; left-padding-aware; query instruction; document has no instruction; 32–1024 output dimensions | GPU-path candidate. Current local and Synapse pooling contracts cannot express it. The observed repository had no ONNX artifact, so conversion is part of the trusted build. |
| `BAAI/bge-m3` | `5617a9f61b028005a4858fdac845db406aefb181` | MIT | CLS dense vector, with separate sparse and multi-vector modes; up to 8192 tokens | Keep experimental. Output mode and fp16 choice are semantic identity, not mere acceleration settings. |

Primary artifact references: [Xenova MiniLM model API](https://huggingface.co/api/models/Xenova/all-MiniLM-L6-v2), [BGE-small pooling config](https://huggingface.co/BAAI/bge-small-en-v1.5/blob/5c38ec7c405ec4b44b94cc5a9bb96e735b38267a/1_Pooling/config.json), [Nomic model card](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/blob/e9b6763023c676ca8431644204f50c2b100d9aab/README.md), [Qwen pooling and prompt configs](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/tree/97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3), and [BGE-M3 model card](https://huggingface.co/BAAI/bge-m3/blob/5617a9f61b028005a4858fdac845db406aefb181/README.md).

## 2. Findings

**Finding 1: A model ID is not an embedding-space contract**

- **Source**: [BGE-small pooling config at revision `5c38ec7…`](https://huggingface.co/BAAI/bge-small-en-v1.5/blob/5c38ec7c405ec4b44b94cc5a9bb96e735b38267a/1_Pooling/config.json); [Nomic v1.5 model card at revision `e9b6763…`](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/blob/e9b6763023c676ca8431644204f50c2b100d9aab/README.md); [Qwen3 pooling and prompt configs at revision `97b0c61…`](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/tree/97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3); [BGE-M3 pooling config at revision `5617a9f…`](https://huggingface.co/BAAI/bge-m3/blob/5617a9f61b028005a4858fdac845db406aefb181/1_Pooling/config.json).
- **Source credibility**: High. These are publisher-owned, revision-pinned model artifacts. Local applicability is verified against `embedding-local.ts:644-672,684-718` and Synapse's mean/CLS-only mapping in `inference.rs:208-225`.
- **Evidence strength**: 3/5. Implemented artifact contracts make the pooling and prompt differences directly reproducible.
- **Summary**: Source fact: BGE-small and BGE-M3 declare CLS pooling; Nomic declares mean pooling plus task prefixes; Qwen declares last-token pooling, a query instruction, and no document instruction. Inference for magic-context: the generic local recipe can return finite, correctly shaped, normalized vectors while silently implementing the wrong model. Equal dimensions do not protect against mixed spaces.
- **Key technique/insight**: Certify the complete function `(text, purpose) -> vector`, including output selector, pooling, mask handling, padding side, normalization, query/document templates, and purpose mapping. Reject a model if the lane cannot represent its recipe.
- **Applicability to our problem**: The current local mean-pooling lane is not valid for BGE-small, Qwen3, or BGE-M3. Synapse can represent BGE CLS but not Qwen last-token pooling or role templates. Nomic 256/512 also needs post-processing beyond the current lanes.
- **Caveats**: BGE v1.5 documents only slight retrieval degradation without its query instruction, so no-instruction BGE remains a legitimate separately declared candidate. Model-card guidance is not repository performance evidence; every recipe still needs the judged gate.

**Finding 2: The current local identity can survive an upstream artifact change**

- **Source**: Hugging Face, [Download files from the Hub — From specific version](https://huggingface.co/docs/huggingface_hub/en/guides/download#from-specific-version); [Xenova/all-MiniLM-L6-v2 model API](https://huggingface.co/api/models/Xenova/all-MiniLM-L6-v2).
- **Source credibility**: High. Official Hub documentation defines revision behavior, and the model API is the publisher platform's live metadata endpoint.
- **Evidence strength**: 3/5. The mutable-resolution mechanism and local identity inputs are directly inspectable.
- **Summary**: Source fact: an unqualified Hub download resolves the latest `main`; immutable resolution requires a full commit hash. Magic-context asks Transformers.js for a model name and hashes model name plus optional non-default dtype, not repository revision or file digests (`embedding-local.ts:559-563`; `embedding-identity.ts:70-78`). The Xenova repository resolved to `751bff37182d3f1213fa05d7196b954e230abad9` when checked. Inference: two hosts with the same local identity can load different bytes after a cache miss or upstream update.
- **Key technique/insight**: Fold the resolved revision and SHA-256 of model, external data, tokenizer, and post-processing artifacts into immutable bundle identity; refuse mismatches before session construction.
- **Applicability to our problem**: Synapse already enforces this invariant. Any GPU path should reuse its strict bundle design. The CPU-local lane remains weaker until it records artifact cohorts rather than only names.
- **Caveats**: This finding proves exposure, not that the observed Xenova revision changed vector semantics. A mutable `main` can change documentation or non-runtime files only. Digesting consumed files avoids overreacting to irrelevant repository changes.

**Finding 3: MiniLM's 256/512 token metadata conflict can produce a false long-input claim**

- **Source**: [Upstream MiniLM model card](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/blob/1110a243fdf4706b3f48f1d95db1a4f5529b4d41/README.md); [upstream 256-token sentence-transformer config](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/blob/1110a243fdf4706b3f48f1d95db1a4f5529b4d41/sentence_bert_config.json); [Xenova 512-token tokenizer config](https://huggingface.co/Xenova/all-MiniLM-L6-v2/blob/751bff37182d3f1213fa05d7196b954e230abad9/tokenizer_config.json).
- **Source credibility**: High. All three are revision-pinned publisher artifacts; their disagreement is directly visible.
- **Evidence strength**: 3/5. The metadata conflict is reproducible, but the exact Transformers.js runtime behavior still needs a probe.
- **Summary**: Source fact: upstream Sentence Transformers says inputs beyond 256 word pieces are truncated and sets `max_seq_length` to 256; Xenova omits that file and sets tokenizer maximum to 512; magic-context advertises 512 (`embedding-local.ts:423-430`). Inference: public MiniLM results do not certify whether this lane clips at 256, uses 512, or embeds positions 257–512 under a recipe different from the source sentence model.
- **Key technique/insight**: Run a tail-sensitivity test against the exact artifact: compare inputs identical through token 256 but different afterward, repeat near token 512, and record tokenization and vector deltas.
- **Applicability to our problem**: The default lane's effective truncation must be resolved before it is the baseline for long-input candidates. Apply the same boundary test to Nomic 8192, Qwen 32K, and BGE-M3 8192.
- **Caveats**: The base BERT graph supports 512 positions, so this is not proof of a shape error or silent clipping. It is an unresolved preprocessing contract. The report deliberately does not claim which branch Transformers.js takes.

**Finding 4: Matryoshka truncation and quantization are semantic changes, not storage knobs**

- **Source**: [Nomic v1.5 model card](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/blob/e9b6763023c676ca8431644204f50c2b100d9aab/README.md); ONNX Runtime, [Quantization debugging](https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html#quantization-debugging); Sentence Transformers, [Embedding Quantization](https://www.sbert.net/examples/sentence_transformer/applications/embedding-quantization/README.html); [BGE-M3 model card](https://huggingface.co/BAAI/bge-m3/blob/5617a9f61b028005a4858fdac845db406aefb181/README.md).
- **Source credibility**: High. Official model cards and runtime/library documentation describe the exact recipes and known accuracy tradeoffs.
- **Evidence strength**: 3/5. Recipes and loss mechanisms are implemented and testable; candidate-specific retrieval loss remains benchmark-dependent.
- **Summary**: Source fact: Nomic reduced dimensions require mean pool, full-vector layer normalization, leading-dimension truncation, then L2 normalization. ORT says quantization is not lossless; Sentence Transformers says int8 calibration data strongly influences retrieval; BGE-M3 warns fp16 causes slight degradation. Inference: changing operation order, output dimension, weight precision, embedding precision, or calibration can preserve shape and norm while reordering near-tied documents.
- **Key technique/insight**: Treat `(artifact, model precision, output dimension, reduction recipe, embedding precision, calibration digest)` as one indivisible candidate identity and benchmark the exact persisted representation.
- **Applicability to our problem**: Nomic 256 and 512 are separate candidates, as are Qwen 256 and 512. Dtype variants cannot borrow fp32 evidence. Float32 MiniLM remains the control.
- **Caveats**: Weight quantization and stored-embedding quantization are different mechanisms. Publisher guidance establishes risk, not the magnitude on magic-context's corpus; rescoring may recover quality but changes latency and architecture.

**Finding 5: CPU and GPU execution of the same weights need not be bit-identical**

- **Source**: PyTorch 2.9, [Reproducibility](https://docs.pytorch.org/docs/2.9/notes/randomness.html); ONNX Runtime, [`use_tf32`](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html#use_tf32); NVIDIA TensorRT, [Algorithm Selection and Reproducible Builds](https://docs.nvidia.com/deeplearning/tensorrt/latest/inference-library/precision-control.html#algorithm-selection-and-reproducible-builds).
- **Source credibility**: High. Official framework and accelerator-runtime documentation states the numerical behavior.
- **Evidence strength**: 3/5. The mechanisms are implemented and documented; retrieval impact is workload-specific.
- **Summary**: Source fact: PyTorch does not guarantee CPU/GPU reproducibility; ORT enables reduced-mantissa TF32 by default on supported GPUs; TensorRT builder noise can select different tactics and accumulation orders, so rebuilt engines are typically not bit-identical. Inference: same ONNX weights, dimensions, and norms do not establish retrieval-equivalent CPU and GPU lanes.
- **Key technique/insight**: Default CPU, CUDA, and TensorRT to distinct identities. Alias only after repeated cold/warm certification across supported GPU architectures using componentwise bounds, cosine drift, top-k overlap, and judged retrieval metrics.
- **Applicability to our problem**: GPU execution/model identity must include precision, TF32, provider, hardware, and tactic/cache state. Rebuild TensorRT engines repeatedly or pin and audit an editable timing cache.
- **Caveats**: Exact equality is too strict and structural checks are too weak. No source supplies a universal safe tolerance; magic-context must calibrate it from reference vectors and ranking stability.

**Finding 6: Provider fallback can make a GPU lane a silent hybrid**

- **Source**: ONNX Runtime, [Execution Provider APIs](https://onnxruntime.ai/docs/execution-providers/#apis-for-execution-provider); ONNX Runtime, [TensorRT usage](https://onnxruntime.ai/docs/execution-providers/TensorRT-ExecutionProvider.html#python); pinned ORT [`session.disable_cpu_ep_fallback` source](https://github.com/microsoft/onnxruntime/blob/4d308dacbbb385fcba9911cd9c07f5603d65cbd6/include/onnxruntime/core/session/onnxruntime_session_options_config_keys.h).
- **Source credibility**: High. Official docs and source define provider priority and the default fallback switch.
- **Evidence strength**: 3/5. Provider partitioning is directly reproducible with unsupported operators.
- **Summary**: Source fact: ORT assigns a node to the first capable provider and otherwise falls through; TensorRT guidance recommends CUDA behind TensorRT; CPU fallback is enabled by default. Inference: a session can initialize and appear to be a GPU lane while CPU islands and device transfers erase latency gains or alter numerics. `get_providers()` proves registration, not full graph assignment.
- **Key technique/insight**: Qualify with CPU fallback disabled, inspect verbose provider assignment/profiling, and fail readiness if any semantic operator leaves the intended provider set. If TensorRT plus CUDA is allowed, that ordered pair is part of identity.
- **Applicability to our problem**: Service-level deterministic CPU fallback should happen before GPU lane activation under a distinct identity. Never switch providers after partial request execution.
- **Caveats**: Some shape/copy nodes may be intentionally assigned outside the accelerator depending on ORT behavior. The certification policy must define acceptable assignments instead of assuming every graph node is compute-semantic.

**Finding 7: CUDA, cuDNN, ORT, TensorRT, and driver versions form one deployable unit**

- **Source**: ONNX Runtime, [CUDA Execution Provider requirements](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html#requirements); ORT issues [#19616](https://github.com/microsoft/onnxruntime/issues/19616) and [#19602](https://github.com/microsoft/onnxruntime/issues/19602).
- **Source credibility**: High for the official compatibility matrix; Moderate for issue examples, which are user reports without maintainer-confirmed post-mortems.
- **Evidence strength**: 3/5. Shared-library load failures and version constraints are reproducible.
- **Summary**: Source fact: cuDNN 8 and 9 builds are incompatible, CUDA compatibility is constrained by major version, and missing cuDNN/cuBLAS libraries prevent CUDA provider creation. Inference: “CUDA 12 installed” is not a sufficient deployment contract, and a registered CPU provider can mask accelerator setup failure unless readiness rejects it.
- **Key technique/insight**: Pin ORT build hash, CUDA/cuDNN/TensorRT/driver versions, target architecture, and compute capability; preload or package the declared native set; require provider creation and semantic probe before publishing readiness.
- **Applicability to our problem**: This extends Synapse's exact-hash ORT identity. GPU incompatibility should select the CPU lane once at startup with a distinct identity and one bounded degraded reason.
- **Caveats**: The issue reports illustrate failure signatures but do not independently prove every root cause. Official version tables govern. Compatibility ranges change across ORT releases and must be captured at bundle build time.

**Finding 8: TensorRT cold start and dynamic-shape profiles can dominate embedding latency**

- **Source**: ONNX Runtime, [TensorRT EP caches](https://onnxruntime.ai/docs/execution-providers/TensorRT-ExecutionProvider.html#tensorrt-ep-caches) and [explicit dynamic-shape ranges](https://onnxruntime.ai/docs/execution-providers/TensorRT-ExecutionProvider.html#explicit-shape-range-for-dynamic-shape-input); NVIDIA, [TensorRT engine portability](https://docs.nvidia.com/deeplearning/tensorrt/latest/getting-started/support-matrix.html#engine-portability).
- **Source credibility**: Moderate. Sources are official, but ORT's published cold-start timings are for SD-UNet rather than an embedding encoder.
- **Evidence strength**: 3/5. Engine building, profile derivation, cache invalidation, and portability constraints are implemented mechanisms.
- **Summary**: Source fact: ORT reports 384 seconds without cache, 42 with timing cache, nine with engine cache, and 1.9 with an embedded engine for one SD-UNet case; dynamic inputs need min/opt/max profiles, and profile mismatch rebuilds the engine. Inference: text encoders' dynamic batch and sequence shapes can create first-request compiles, bad profiles, or request-path rebuilds if shape bounds are implicit.
- **Key technique/insight**: Predeclare bounded batch/token profiles, build and warm before readiness, refuse request-time rebuilds, and key caches by every model/runtime/provider/profile/hardware input.
- **Applicability to our problem**: Measure cold startup separately from steady-state throughput and test each shape boundary. TensorRT is optional only after plain CUDA evidence shows a need.
- **Caveats**: The published timing values must not be projected onto Qwen or BGE-M3. Hardware-compatibility mode changes performance and portability tradeoffs and also belongs in execution identity.

**Finding 9: ORT's GPU memory limit is not a process VRAM limit**

- **Source**: ONNX Runtime, [`gpu_mem_limit`](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html#gpu_mem_limit) and [`arena_extend_strategy`](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html#arena_extend_strategy); open issue [microsoft/onnxruntime#29351](https://github.com/microsoft/onnxruntime/issues/29351).
- **Source credibility**: Moderate. Arena semantics are official; the 2026 multi-session OOM report is reproducible reporter evidence without maintainer confirmation.
- **Evidence strength**: 3/5. Official limits are implemented, and the issue includes a measured reproducer and mitigations.
- **Summary**: Source fact: `gpu_mem_limit` bounds only the EP arena, total VRAM can be higher, and the default is effectively unlimited. Issue #29351 reports alternating embedding/reranker sessions growing about 2 GiB per iteration until OOM, with a per-session cap stopping growth in that environment. Inference: model weights, TensorRT workspace, libraries, streams, transfers, and external allocations require a host-level budget; one-shape warmup cannot prove bounded residency.
- **Key technique/insight**: Preserve one active session, admit against a total VRAM envelope, soak varied rows/tokens, record NVML and ORT telemetry, force OOM below production limits, and verify shutdown releases memory.
- **Applicability to our problem**: This supports the existing one-active-lane constraint and argues against request-time swapping. Bound workspace, arena, batch, token budget, queue depth, and concurrent calls together.
- **Caveats**: The issue's two-session trigger is less applicable to a one-lane design and does not prove a universal ORT leak. Arena high-water retention can be intentional reuse rather than leaked live memory.

**Finding 10: Cancellation is not a proven GPU preemption mechanism**

- **Source**: magic-context [Synapse lifecycle source](https://github.com/cortexkit/magic-context/blob/main/crates/mc-host/src/synapse/mod.rs); pinned ORT [`RunOptionsSetTerminate` implementation](https://github.com/microsoft/onnxruntime/blob/4d308dacbbb385fcba9911cd9c07f5603d65cbd6/onnxruntime/core/framework/run_options.cc).
- **Source credibility**: High. Both are implementation sources, but neither supplies a CUDA/TensorRT completion bound.
- **Evidence strength**: 2/5 — **WEAK**. No GPU-specific kernel-preemption test or post-mortem was found.
- **Summary**: Source fact: current Synapse cancels queued work and response waiters but drains every started native call before releasing state (`mod.rs:10-13,492-535,638-675,916-925`). ORT's implementation sets a terminate flag. Inference: a returned cancellation error does not prove that launched GPU work has physically quiesced or that buffers and sessions are safe to destroy.
- **Key technique/insight**: Keep ownership until joined: cancellation stops admission/waiting, while started work retains buffers, permits, and session ownership. Escalate only through documented isolated-worker termination after a bounded drain attempt.
- **Applicability to our problem**: Fault-test shutdown and cancellation during the largest accepted batch and TensorRT engine build. Do not count request cancellation as GPU memory reclamation.
- **Caveats**: This is explicitly WEAK because evidence is an absence of GPU-specific guarantees plus conservative local design, not proof that ORT cannot interrupt any GPU workload. A pinned runtime may support tighter measured behavior later.

**Finding 11: Public embedding leaderboards do not transfer reliably to project-memory and code retrieval**

- **Source**: Muennighoff et al., [MTEB, EACL 2023](https://aclanthology.org/2023.eacl-main.148/); Thakur et al., [BEIR v4](https://arxiv.org/abs/2104.08663v4); Li et al., [CoIR, ACL 2025](https://aclanthology.org/2025.acl-long.1072/); Su et al., [BRIGHT v4](https://arxiv.org/abs/2407.12883v4).
- **Source credibility**: High. MTEB and CoIR are peer-reviewed; BEIR is a major benchmark study; BRIGHT is retained as a reproducible preprint example rather than the basis for the tier.
- **Evidence strength**: 4/5. Peer-reviewed cross-task and code-retrieval evidence establishes transfer risk.
- **Summary**: Source fact: MTEB found no model dominated all tasks; BEIR found out-of-distribution weakness; CoIR found state-of-the-art systems struggled across ten code datasets and eight tasks; BRIGHT reported a leading MTEB model dropping from 59.0 to 18.3 nDCG@10 on reasoning-intensive retrieval. Inference: aggregate leaderboard rank is a poor proxy for magic-context's symbols, errors, temporal constraints, contradictions, and mixed code/prose.
- **Key technique/insight**: Use public benchmarks only to create a diverse shortlist. Select on the exact production query/document transforms and judged repository categories, with lexical-plus-vector retrieval in the loop.
- **Applicability to our problem**: MiniLM remains default unless a candidate wins the in-domain gate. Model-card MTEB numbers cannot promote BGE, Nomic, Qwen, or BGE-M3.
- **Caveats**: BRIGHT is not treated as peer-reviewed support here, and no external benchmark exactly matches project memory. The repository corpus is authoritative but has sample-size limits described in Finding 12.

**Finding 12: The current holdout is too small to support fine-grained model ranking by itself**

- **Source**: Voorhees and Buckley, [The effect of topic set size on retrieval experiment error](https://doi.org/10.1145/564376.564432), SIGIR 2002; magic-context [benchmark corpus builder](https://github.com/cortexkit/magic-context/blob/main/packages/plugin/scripts/build-benchmark-corpus.ts) and [regression policy](https://github.com/cortexkit/magic-context/blob/main/packages/plugin/scripts/retrieval-benchmark/regression.ts).
- **Source credibility**: High. The IR result is peer-reviewed, and local counts come from executable repository artifacts.
- **Evidence strength**: 4/5. The paper directly analyzed topic-set error up to 25 topics; the local 11-query holdout is inside that range.
- **Summary**: Source fact: retrieval behavior varies strongly by topic, and few-topic superiority error rates were larger than expected. Magic-context has 11 holdout queries, split into nine explicit and two automatic queries, while policy aggregates each mode separately. Inference: one automatic query can move half that mode's macro score, and three repeated runs do not add independent information needs.
- **Key technique/insight**: Report paired query deltas, leave-one-query-out sensitivity, and query-level bootstrap intervals; require minimum per-mode/category counts and expand the blind holdout before resolving close candidates.
- **Applicability to our problem**: The current corpus is useful for catching semantic mistakes and rejecting large regressions, not for declaring a sub-point “optimal model” win among many dimensions, precisions, and providers.
- **Caveats**: The paper does not prescribe a universal minimum for this workload. Expansion targets must follow desired detectable effect and query variance; bootstrap intervals do not manufacture missing coverage.

**Finding 13: Repeated candidate tuning contaminates even a private judged holdout**

- **Source**: Dwork et al., [The reusable holdout: Preserving validity in adaptive data analysis](https://doi.org/10.1126/science.aaa9375), *Science* 2015; MTEB issue [#1636 — autodetect dataset contamination](https://github.com/embeddings-benchmark/mteb/issues/1636).
- **Source credibility**: High for the peer-reviewed adaptivity result; Moderate for the official MTEB issue, which documents an unresolved ecosystem problem rather than proving candidate contamination.
- **Evidence strength**: 4/5. Adaptive holdout overfitting is peer-reviewed; embedding-specific automatic detection remains unresolved.
- **Summary**: Source fact: conventional validity assumes analysis choices are fixed before viewing holdout results; adaptively choosing from prior holdout outcomes creates spurious discoveries. MTEB's open issue tracks difficulty detecting embedding benchmark contamination when training data are undisclosed. Inference: repeatedly adjusting prompts, dimensions, quantization, profiles, or shortlist after magic-context holdout results turns that holdout into development data.
- **Key technique/insight**: Freeze recipes before holdout execution, tune only on development queries, preserve every attempt, and require fresh adjudicated queries after material adaptive changes. Predeclare multiple-comparison or sequential rules if reuse is unavoidable.
- **Applicability to our problem**: A private corpus prevents public pretraining leakage but not local benchmark overfitting. Public MTEB scores cannot restore independence.
- **Caveats**: No evidence proves that any shortlisted model trained on magic-context's private corpus, and MTEB issue #1636 does not prove any specific public score is contaminated. Keep contamination as an uncertainty, not an accusation.

**Finding 14: Model conversion is a supply-chain and licensing boundary**

- **Source**: Hugging Face, [Custom models](https://huggingface.co/docs/transformers/en/models#custom-models), [Pickle Scanning](https://huggingface.co/docs/hub/en/security-pickle), and [revision-pinned downloads](https://huggingface.co/docs/huggingface_hub/en/guides/download#from-specific-version); pinned candidate trees for [Nomic](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/tree/e9b6763023c676ca8431644204f50c2b100d9aab) and [BGE-M3](https://huggingface.co/BAAI/bge-m3/tree/5617a9f61b028005a4858fdac845db406aefb181).
- **Source credibility**: High. Official security guidance and revision-pinned artifact inventories establish the trust boundary.
- **Evidence strength**: 3/5. Remote-code and pickle execution risks are implemented behaviors; the candidate artifact facts are directly inspectable.
- **Summary**: Source fact: `trust_remote_code=True` executes repository code; Hugging Face recommends commit pinning and says pickle loading can execute arbitrary code while scanning is not foolproof. Nomic's pinned config carried remote `auto_map` entries; BGE-M3 exposed ONNX and `pytorch_model.bin` but no safetensors at the observed revision. License metadata was Apache-2.0 or MIT. Inference: an offline ONNX runtime can inherit unsafe or irreproducible provenance from a conversion job that ran mutable remote code, loaded pickle, or mixed revisions.
- **Key technique/insight**: Convert in an isolated environment without production credentials; pin every model and transitive code revision; prefer publisher ONNX or safetensors; record converter/toolchain hashes, file digests, and license snapshot; verify publisher-reference vectors.
- **Applicability to our problem**: Production should receive only the strict ONNX/tokenizer/certification bundle and never download or enable remote code. Prefer publisher ONNX for BGE-M3 unless exact-pickle conversion is separately approved.
- **Caveats**: Model-card license fields are metadata, not a legal opinion. A pickle file is not proof of malicious content, and `auto_map` may be bypassed by a sufficiently new native Transformers implementation; the conversion process must record what it actually executed.

## 3. Structured Evidence Summary

```json
[
  {
    "id": "F-01",
    "claim": "Embedding-space identity must include pooling, purpose-specific prompts, padding, masking, output selection, and normalization rather than only model ID.",
    "source_url": "https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/tree/97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3",
    "source_title": "Qwen3-Embedding-0.6B pinned pooling and prompt artifacts",
    "evidence_strength": 3,
    "credibility_tier": "High",
    "applicability": "All candidates; blocks generic mean pooling for BGE-small, Qwen3, and BGE-M3."
  },
  {
    "id": "F-02",
    "claim": "A model-name identity can remain unchanged while an unpinned upstream main revision changes consumed artifacts.",
    "source_url": "https://huggingface.co/docs/huggingface_hub/en/guides/download#from-specific-version",
    "source_title": "Hugging Face Hub: Download files from a specific version",
    "evidence_strength": 3,
    "credibility_tier": "High",
    "applicability": "CPU-local identity and GPU bundle provenance."
  },
  {
    "id": "F-03",
    "claim": "MiniLM's upstream 256-token sentence recipe conflicts with the Xenova conversion's 512-token tokenizer contract and requires runtime certification.",
    "source_url": "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/blob/1110a243fdf4706b3f48f1d95db1a4f5529b4d41/sentence_bert_config.json",
    "source_title": "all-MiniLM-L6-v2 pinned sentence-transformer configuration",
    "evidence_strength": 3,
    "credibility_tier": "High",
    "applicability": "Current default and every long-context comparison."
  },
  {
    "id": "F-04",
    "claim": "Matryoshka dimension, operation order, precision, and quantization calibration define distinct vector spaces and candidates.",
    "source_url": "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/blob/e9b6763023c676ca8431644204f50c2b100d9aab/README.md",
    "source_title": "nomic-embed-text-v1.5 pinned model card",
    "evidence_strength": 3,
    "credibility_tier": "High",
    "applicability": "Nomic 256/512, Qwen 256/512, and every quantized variant."
  },
  {
    "id": "F-05",
    "claim": "CPU, CUDA, and independently built TensorRT engines may produce numerically different vectors from the same weights.",
    "source_url": "https://docs.nvidia.com/deeplearning/tensorrt/latest/inference-library/precision-control.html#algorithm-selection-and-reproducible-builds",
    "source_title": "NVIDIA TensorRT: Algorithm Selection and Reproducible Builds",
    "evidence_strength": 3,
    "credibility_tier": "High",
    "applicability": "GPU semantic aliasing and certification."
  },
  {
    "id": "F-06",
    "claim": "Default execution-provider fallback can silently turn a claimed GPU lane into mixed TensorRT, CUDA, and CPU execution.",
    "source_url": "https://onnxruntime.ai/docs/execution-providers/#apis-for-execution-provider",
    "source_title": "ONNX Runtime Execution Provider APIs",
    "evidence_strength": 3,
    "credibility_tier": "High",
    "applicability": "Every CUDA or TensorRT session."
  },
  {
    "id": "F-07",
    "claim": "ORT, CUDA, cuDNN, TensorRT, driver, architecture, and provider libraries form one compatibility and startup unit.",
    "source_url": "https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html#requirements",
    "source_title": "ONNX Runtime CUDA Execution Provider requirements",
    "evidence_strength": 3,
    "credibility_tier": "High",
    "applicability": "GPU packaging, startup readiness, and deterministic CPU fallback."
  },
  {
    "id": "F-08",
    "claim": "TensorRT engine building, cache identity, and dynamic-shape profiles can create cold-start and request-path latency cliffs.",
    "source_url": "https://onnxruntime.ai/docs/execution-providers/TensorRT-ExecutionProvider.html#tensorrt-ep-caches",
    "source_title": "ONNX Runtime TensorRT Execution Provider caches",
    "evidence_strength": 3,
    "credibility_tier": "Moderate",
    "applicability": "Optional TensorRT path; published timings are not embedding-specific."
  },
  {
    "id": "F-09",
    "claim": "ORT gpu_mem_limit bounds only the provider arena, not total process VRAM, and multi-session arena behavior can reach OOM.",
    "source_url": "https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html#gpu_mem_limit",
    "source_title": "ONNX Runtime CUDA Execution Provider gpu_mem_limit",
    "evidence_strength": 3,
    "credibility_tier": "Moderate",
    "applicability": "GPU VRAM admission, soak testing, and one-active-lane policy."
  },
  {
    "id": "F-10",
    "claim": "Run cancellation is not proven to provide bounded CUDA or TensorRT kernel preemption and must not release native ownership early.",
    "source_url": "https://github.com/microsoft/onnxruntime/blob/4d308dacbbb385fcba9911cd9c07f5603d65cbd6/onnxruntime/core/framework/run_options.cc",
    "source_title": "ONNX Runtime RunOptionsSetTerminate implementation",
    "evidence_strength": 2,
    "credibility_tier": "High — WEAK evidence for GPU-specific behavior",
    "applicability": "Timeout, cancellation, shutdown, and buffer/session lifetime."
  },
  {
    "id": "F-11",
    "claim": "Public aggregate embedding leaderboards do not reliably predict project-memory and code-retrieval quality.",
    "source_url": "https://aclanthology.org/2025.acl-long.1072/",
    "source_title": "CoIR: A Comprehensive Benchmark for Code Information Retrieval Models",
    "evidence_strength": 4,
    "credibility_tier": "High",
    "applicability": "Candidate discovery only; repository judged corpus remains selection authority."
  },
  {
    "id": "F-12",
    "claim": "The 11-query holdout, especially its two automatic queries, cannot reliably rank close model variants by itself.",
    "source_url": "https://doi.org/10.1145/564376.564432",
    "source_title": "The effect of topic set size on retrieval experiment error",
    "evidence_strength": 4,
    "credibility_tier": "High",
    "applicability": "Quality-gate interpretation and holdout expansion."
  },
  {
    "id": "F-13",
    "claim": "Repeatedly adapting prompts, dimensions, precision, or shortlist to holdout outcomes contaminates the private holdout.",
    "source_url": "https://doi.org/10.1126/science.aaa9375",
    "source_title": "The reusable holdout: Preserving validity in adaptive data analysis",
    "evidence_strength": 4,
    "credibility_tier": "High",
    "applicability": "Benchmark workflow, predeclaration, and fresh challenge-set collection."
  },
  {
    "id": "F-14",
    "claim": "Model conversion is a supply-chain and licensing boundary because remote code, pickle, mutable revisions, and mixed tokenizer/model inputs can enter an offline ONNX bundle.",
    "source_url": "https://huggingface.co/docs/transformers/en/models#custom-models",
    "source_title": "Hugging Face Transformers: Custom models",
    "evidence_strength": 3,
    "credibility_tier": "High",
    "applicability": "Candidate conversion, bundle provenance, and production no-download policy."
  }
]
```

## Patterns & Consensus

### Model selection

Evidence converges on one rule: select a **vector recipe**, not a model name. Recipe identity includes model and tokenizer bytes, role-specific input transform, pooling, masking and padding behavior, output selection, dimension reduction and order, normalization, quantization/calibration, and truncation. That rule immediately narrows the shortlist:

1. **Keep MiniLM as the control and default.** Before using it as the long-input baseline, resolve and certify the 256/512 discrepancy.
2. **Prioritize BGE-small-en-v1.5 as the lowest-risk new CPU/Synapse candidate.** Its CLS recipe fits Synapse's existing pooling enum. It is not valid under the current local mean-pooling adapter. Benchmark both the publisher query instruction and the documented no-instruction v1.5 mode as predeclared, separate recipes.
3. **Keep Nomic 256 and 512 only if the lane implements the exact Matryoshka order and task prefixes.** Otherwise test full 768 or remove it from that lane. Each dimension is a separate identity.
4. **Treat Qwen3-Embedding-0.6B 256/512 as a GPU implementation candidate, not a config-only model swap.** It needs last-token pooling, left-padding correctness, role instructions, conversion evidence, and larger memory/startup tests.
5. **Keep BGE-M3 experimental.** Dense-only output must be selected explicitly; sparse and multi-vector capabilities do not fit the current single-vector database contract. Its long context and fp16 tradeoff need workload evidence.

### GPU execution and identity contract

GPU admission should require one immutable descriptor with these fields:

- model repository revision, license metadata snapshot, model/external-data/tokenizer/config hashes, converter version and options;
- query and document templates, purpose mapping, pooling, attention-mask rule, padding side, truncation side and maximum, output selector, dimension-reduction recipe, normalization, model precision, embedding precision, and calibration digest;
- ORT library hash and version, EP list in order, `session.disable_cpu_ep_fallback`, provider options including TF32/fp16/int8, CUDA/cuDNN/TensorRT/driver versions, GPU architecture, dynamic-shape profiles, workspace and arena bounds, and engine/timing-cache digest;
- certification corpus digest, numeric tolerance, repeated-build results, judged retrieval result, and supported batch/token envelope.

Store CPU and GPU lanes under distinct identities by default. Semantic aliasing is earned only when structural probes, componentwise/vector-level checks, provider-assignment checks, repeated cold builds, and the repository retrieval gate all pass. Even then, retain execution identity separately in diagnostics so a driver, EP, or engine-cache change cannot hide behind a shared semantic label.

The existing operational constraints are supported by the failure evidence: one active lane, no request-time model switch, no runtime download, bounded rows/tokens/VRAM, startup-only deterministic CPU fallback, and shutdown that drains started native work.

### Benchmark discipline

The judged corpus is the right authority, but its present role should be **semantic rejection and coarse regression detection**, not precise ranking among many close candidates. Public leaderboards should seed the shortlist. Development queries should tune recipes. Final holdout execution should be predeclared and rare. The automatic holdout needs substantial expansion before its two-query macro score can support an “optimal model” claim. New queries should emphasize exact code symbols, error strings, mixed code/prose chunks, stale versus current facts, long-tail tokens, and near-duplicate memories because those are where generic semantic benchmarks transfer poorly.

## Disagreements & Open Questions

1. **MiniLM's effective token boundary is unresolved.** Upstream Sentence Transformers says 256; Xenova's conversion tokenizer says 512; magic-context advertises 512. A pinned runtime probe must settle whether tokens 257–512 affect vectors and whether doing so helps target retrieval.
2. **No universal numeric equivalence tolerance is sourced.** Componentwise tolerance, cosine drift, and rank stability need to be calibrated on this repository. Exact vector equality is too strict; norm and dimension checks alone are too weak.
3. **ORT termination semantics on CUDA/TensorRT remain insufficient.** The API has a terminate flag, but no reviewed source gave a kernel-level completion bound. Keep drain-to-quiescence until fault tests prove otherwise.
4. **TensorRT may not beat plain CUDA at magic-context batch sizes.** Its documented cold-start cost is real, but the benefit for small text-embedding batches is unproven. Benchmark CUDA EP first; add TensorRT only after measured need.
5. **Candidate contamination is unknown, not proven.** MTEB's own project still tracks how to detect it. Do not accuse a model without training-overlap evidence; simply refuse to use public scores as the final gate.
6. **Qwen ONNX conversion is part of the candidate.** No ONNX file appeared in the observed official repository revision. Export graph, opset, precision, pooling/post-processing placement, and reference parity must be reviewed together.
7. **BGE-M3's extra retrieval modes may tempt scope expansion.** Sparse and multi-vector outputs require new storage and scoring contracts. They should not be smuggled into a dense-vector model comparison.
8. **The minimum useful holdout size is workload- and effect-dependent.** The IR literature proves few-topic instability, not a magic threshold for this corpus. Use query-level uncertainty and prospective power/design work to set expansion targets.

## Recommended Reading

1. ONNX Runtime, [CUDA Execution Provider](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html) — compatibility matrix, arena settings, TF32, and provider options.
2. ONNX Runtime, [TensorRT Execution Provider](https://onnxruntime.ai/docs/execution-providers/TensorRT-ExecutionProvider.html) — provider order, caches, dynamic profiles, and invalidation rules.
3. NVIDIA TensorRT, [Algorithm Selection and Reproducible Builds](https://docs.nvidia.com/deeplearning/tensorrt/latest/inference-library/precision-control.html#algorithm-selection-and-reproducible-builds).
4. PyTorch 2.9, [Reproducibility](https://docs.pytorch.org/docs/2.9/notes/randomness.html).
5. Hugging Face, [Custom models](https://huggingface.co/docs/transformers/en/models#custom-models), [Pickle Scanning](https://huggingface.co/docs/hub/en/security-pickle), and [revision-pinned downloads](https://huggingface.co/docs/huggingface_hub/en/guides/download#from-specific-version).
6. Muennighoff et al., [MTEB: Massive Text Embedding Benchmark](https://aclanthology.org/2023.eacl-main.148/), EACL 2023.
7. Li et al., [CoIR: A Comprehensive Benchmark for Code Information Retrieval Models](https://aclanthology.org/2025.acl-long.1072/), ACL 2025.
8. Su et al., [BRIGHT: A Realistic and Challenging Benchmark for Reasoning-Intensive Retrieval](https://arxiv.org/abs/2407.12883v4), v4 updated 2025-03-26.
9. Voorhees and Buckley, [The effect of topic set size on retrieval experiment error](https://doi.org/10.1145/564376.564432), SIGIR 2002.
10. Dwork et al., [The reusable holdout: Preserving validity in adaptive data analysis](https://doi.org/10.1126/science.aaa9375), *Science* 2015.
11. Candidate pinned artifacts: [BGE-small](https://huggingface.co/BAAI/bge-small-en-v1.5/tree/5c38ec7c405ec4b44b94cc5a9bb96e735b38267a), [Nomic v1.5](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/tree/e9b6763023c676ca8431644204f50c2b100d9aab), [Qwen3 0.6B](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/tree/97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3), and [BGE-M3](https://huggingface.co/BAAI/bge-m3/tree/5617a9f61b028005a4858fdac845db406aefb181).

</details>

<details>
<summary>Agent 4: Rust Ecosystem & Implementation Patterns</summary>

# Research Report — Agent 4: Rust Ecosystem & Implementation Patterns

**Research date:** 2026-08-23  
**Scope:** Rust-native and Rust-hosted embedding inference for magic-context, with emphasis on `fastembed` 6.0.0, `ort` 2.0.0-rc.13, and an optional GPU lane.  
**Evidence scale:** 5 = proven production; 4 = peer-reviewed; 3 = maintained implementation or test evidence; 2 = official documented practice without independent validation; 1 = anecdotal or insufficient. Source quality is separate from evidence strength: “High” means a primary project source, not that a performance or production claim has been independently reproduced.

## 1. Codebase Context

The TypeScript local lane defaults to `Xenova/all-MiniLM-L6-v2` (`packages/plugin/src/config/schema/magic-context.ts:22`). It creates a Transformers.js `feature-extraction` pipeline with `fp32` as the compatibility-preserving default dtype (`packages/plugin/src/features/magic-context/memory/embedding-local.ts:252-263, 541-563`) and requests mean pooling plus L2 normalization (`embedding-local.ts:644-675`). The provider accepts a `purpose` parameter but deliberately ignores it (`embedding-local.ts:644-648`). This matters because Nomic v1.5 and Qwen3 are asymmetric retrieval models whose official usage distinguishes query text from passage text.

The Rust lane is narrower and more controlled. `mc-host` pins `fastembed = 6.0.0` with only `ort-load-dynamic` and pins `ort = 2.0.0-rc.13` with `load-dynamic`, `ndarray`, and `std` (`crates/mc-host/Cargo.toml:18-19`). The crate forbids application unsafe code (`crates/mc-host/src/lib.rs:3`). The resolved feature graph also enables `ort/api-24` through FastEmbed, but enables no GPU execution-provider feature. The bundle hashes the ONNX graph, external initializers, four tokenizer files, and the semantic corpus; it binds dimensions, pooling, quantization declaration, output selection, and truncation into the canonical fingerprint (`docs/synapse-model-bundle.md:9-24, 72-114`). The host securely commits one dynamic ORT identity and then cannot switch it in-process (`docs/synapse-model-bundle.md:117-142`; `crates/mc-host/src/synapse/inference.rs:59-104`).

The current backend constructs a FastEmbed user-defined model from verified bytes, attaches external initializers, selects pooling and output, and uses one intra-op thread (`crates/mc-host/src/synapse/inference.rs:228-264`). It does not pass an explicit execution provider, so ORT uses its CPU default. A mutex serializes the FastEmbed session (`inference.rs:268-298`), while the component has one native-inference semaphore permit (`crates/mc-host/src/synapse/mod.rs:164-174, 199-200`). Startup validates shape, finite values, unit norm, and a pinned semantic corpus (`inference.rs:263-264, 333-356`).

The repository already has the right decision gate. Its judged retrieval benchmark defines nDCG@10 and recall@50 (`packages/plugin/scripts/retrieval-benchmark/metrics.ts:22-26, 85-110, 170-220`), uses holdout policy inputs, and separates semantic-quality identity from host-specific latency identity (`packages/plugin/scripts/retrieval-benchmark/regression.ts:2-24, 81-117`). No ecosystem benchmark or model-card score should replace that corpus.

One integration gap changes the feasible shortlist. `EmbeddingPurpose` is `"query" | "passage"` (`packages/plugin/src/features/magic-context/memory/embedding-provider.ts:3`). The OpenAI-compatible provider converts that purpose only into a provider-specific `input_type` field (`embedding-openai.ts:211-230, 284-300`). Synapse sends only text and content hash (`embedding-synapse.ts:1309-1320`), and its Rust protocol has no purpose field. Therefore neither current local nor Synapse execution can apply different Qwen/Nomic query and passage prompts without a new, fingerprinted preprocessing contract.

## 2. Findings

**Finding 1: FastEmbed 6.0.0 fits the strict ONNX bundle, but its user-defined surface is intentionally small**

- **Source**: https://docs.rs/fastembed/6.0.0/src/fastembed/text_embedding/init.rs.html; https://docs.rs/fastembed/6.0.0/src/fastembed/text_embedding/impl.rs.html; https://docs.rs/fastembed/6.0.0/src/fastembed/common.rs.html; https://docs.rs/fastembed/6.0.0/src/fastembed/text_embedding/output.rs.html
- **Source credibility**: High. Immutable primary source for the exact FastEmbed 6.0.0 release.
- **Evidence strength**: 3/5. Maintained implementation evidence.
- **Summary**: FastEmbed’s `UserDefinedEmbeddingModel` accepts ONNX bytes, external initializer name/byte pairs, the tokenizer file set, pooling, a quantization-mode declaration, and an output key. `InitOptionsUserDefined` exposes execution-provider dispatches, maximum token length, and intra-op thread count. Inference exposes a per-call batch size. Those are exactly the controls the current CPU lane uses, and the external-initializer path retains the buffers for session lifetime.
- **Key technique/insight**: The same source defines the boundary: FastEmbed does not expose the constructed `ort::Session`, inter-op threads, generic session config entries, CPU-fallback disabling, ORT profiling, I/O binding, device allocators, `RunOptions`, or run termination. Its output key is applied after `Session::run` has produced and collected all outputs, so it does not suppress unneeded graph outputs before execution. Its quantization enum changes batching rules; actual quantized operators and weights must already be present in the ONNX artifact.
- **Applicability to our problem**: The existing strict model bundle can continue through FastEmbed for CPU and a basic GPU pilot. External initializers, tokenizer identity, pooling, output selection, and one intra-op thread already map cleanly onto Synapse.
- **Caveats**: Passing a CUDA dispatch is possible, but a fully controlled GPU session is not possible through FastEmbed alone. Requirements for cancellation, I/O binding, pre-run output suppression, profiling, or CPU-fallback disabling would require a direct `ort` adapter or process boundary.

**Finding 2: FastEmbed can receive ORT GPU providers, but its own `cuda` feature is Candle CUDA**

- **Source**: https://docs.rs/crate/fastembed/6.0.0/features; https://docs.rs/crate/ort/2.0.0-rc.13/features
- **Source credibility**: High. Primary feature manifests for the exact crate releases.
- **Evidence strength**: 3/5. Maintained implementation and package-manifest evidence.
- **Summary**: FastEmbed 6.0.0’s `cuda` and `cudnn` features enable Candle for its Qwen3 and Nomic-v2 implementations. Its only named ORT execution-provider feature is `directml`; `ort-load-dynamic` only enables ORT dynamic loading.
- **Key technique/insight**: The generic `Vec<ExecutionProviderDispatch>` on `InitOptionsUserDefined` still permits CUDA, TensorRT, DirectML, CoreML, MIGraphX, or another ORT provider when the shared `ort` dependency has the corresponding feature enabled. Cargo feature unification lets `mc-host` add `cuda` to its direct `ort` dependency without changing FastEmbed’s API.
- **Applicability to our problem**: An in-process ONNX CUDA pilot should enable `ort/cuda`, retain `fastembed/ort-load-dynamic`, and pass an explicit CUDA dispatch to FastEmbed’s user-defined options.
- **Caveats**: Enabling `fastembed/cuda` would introduce Candle and Hugging Face Hub support, not make the existing ONNX session use `CUDAExecutionProvider`. Enabling `ort/cuda` only compiles the registration wrapper; it does not prove that the dynamically loaded ORT binary contains CUDA support or that its dependent libraries are present.

**Finding 3: `ort` rc.13 exposes the requested EP feature set, but compile-time and runtime availability are separate contracts**

- **Source**: https://docs.rs/crate/ort/2.0.0-rc.13/features; https://docs.rs/ort/2.0.0-rc.13/ort/ep/index.html; https://onnxruntime.ai/docs/execution-providers/ROCm-ExecutionProvider.html; https://onnxruntime.ai/docs/execution-providers/TensorRT-ExecutionProvider.html
- **Source credibility**: High. Exact crate source plus upstream ONNX Runtime provider documentation.
- **Evidence strength**: 3/5. Maintained implementation evidence, with official operational documentation.
- **Summary**: The exact rc.13 crate has features named `cuda`, `tensorrt`, `rocm`, `directml`, and `coreml`, plus `migraphx`; provider modules are compile-gated by those features. The current magic-context graph resolves API 24 plus dynamic loading. `load-dynamic` disables link-time ORT linkage and loads one process-global library, using `ORT_DYLIB_PATH` only if the application has not already called `ort::init_from`. It rejects a runtime older than its selected API minor and warns for a newer minor.
- **Key technique/insight**: The `rocm` feature demonstrates why feature names are not deployment proof. Upstream removed the ROCm EP in ORT 1.23 and directs current applications to MIGraphX. TensorRT adds engine building, cache lifecycle, precision profiles, and GPU-specific non-portable artifacts.
- **Applicability to our problem**: CUDA is the lowest-complexity first Linux/NVIDIA GPU provider. TensorRT belongs in a later benchmark treatment. Current AMD work should target MIGraphX rather than the removed ROCm EP.
- **Caveats**: A current API-24 bundle cannot obtain ROCm support merely because rc.13 still exposes `ort/rocm`. DirectML is Windows-only and in sustained engineering; CoreML is Apple-only. These are platform lanes, not one portable GPU artifact.

**Finding 4: CUDA initialization requires no unsafe application code, but strict failure and artifact closure must be added**

- **Source**: https://docs.rs/ort/2.0.0-rc.13/ort/ep/index.html; https://docs.rs/ort/2.0.0-rc.13/src/ort/ep/cuda.rs.html; https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html; https://onnxruntime.ai/docs/build/eps.html
- **Source credibility**: High. Exact Rust wrapper source and official ONNX Runtime deployment documentation.
- **Evidence strength**: 3/5 for API capability. Operational-setting guidance is 2/5 and **WEAK** because it is official practice without repository-specific validation.
- **Summary**: The rc.13 safe wrapper exposes `ep::CUDA` options for device ID, arena memory limit, arena extension strategy, convolution search, TF32, CUDA graphs, and other provider options. It exposes provider availability checks and `ExecutionProviderDispatch::error_on_failure`; the latter prevents registration errors from degrading into silent CPU fallback. Calling these safe APIs is compatible with `#![forbid(unsafe_code)]`. The custom compute-stream method is unsafe and unnecessary here.
- **Key technique/insight**: The existing ORT-core hash is not a sufficient GPU identity. ONNX Runtime’s shared-provider build produces `onnxruntime_providers_shared` and provider-specific libraries. CUDA then loads CUDA runtime, cuBLAS, cuDNN, and related libraries. Compatible CUDA and cuDNN major versions are required; cuDNN 8 and 9 are not interchangeable. Rust preload helpers keep libraries loaded but do not hash them.
- **Applicability to our problem**: A strict GPU bundle should hash and allowlist the ORT core, `providers_shared`, the CUDA or TensorRT provider library, and every owner-provisioned CUDA/cuDNN/TensorRT user-space dependency. It should record NVIDIA driver and physical-device identity and fail closed on registration, device-envelope, or loaded-object-closure mismatch.
- **Caveats**: The NVIDIA driver normally cannot be bundled with the application. Exact dependency staging and loaded-object verification are repository-specific obligations supplied by neither crate. `gpu_mem_limit` covers only the EP arena, not total device memory.

**Finding 5: Existing serialization is the right GPU default; I/O binding and extra sessions are not justified yet**

- **Source**: https://docs.rs/ort/2.0.0-rc.13/src/ort/session/mod.rs.html; https://docs.rs/ort/2.0.0-rc.13/src/ort/session/io_binding.rs.html; https://docs.rs/ort/2.0.0-rc.13/src/ort/session/run_options.rs.html; https://onnxruntime.ai/docs/performance/tune-performance/iobinding.html
- **Source credibility**: High. Exact wrapper implementation plus official ORT performance guidance.
- **Evidence strength**: 3/5. Maintained implementation evidence.
- **Summary**: rc.13 `Session::run` takes `&mut self` because maintainers observed crashes and memory corruption when earlier versions allowed concurrent inference; the source recommends one session per thread or batching. Magic-context already serializes one session with a mutex and one permit, so the safest GPU pilot retains one session and one in-flight native run while sweeping token-based batch size.
- **Key technique/insight**: ORT I/O binding is intended to keep data on-device or reuse unchanged device inputs. rc.13 says it provides no meaningful benefit for CPU → GPU → CPU pipelines or changing inputs. Embedding IDs and masks are built on CPU, and vectors return to CPU for SQLite/search. `RunOptions::terminate` can request cancellation, and sessions/bindings release through `Drop`.
- **Applicability to our problem**: Preserve the current ownership topology. Treat pinned memory, I/O binding, or multiple sessions as measured optimizations only after profiling shows transfer or serialization dominates model compute or queueing.
- **Caveats**: FastEmbed exposes neither I/O binding nor `RunOptions`, so a started FastEmbed GPU call remains non-cancellable. Hard cancellation requires direct ORT or process isolation. ORT’s environment is process-global and first-wins, so model/provider changes should use lane-process restart rather than hot replacement.

**Finding 6: BGE-small-en-v1.5 is the cleanest first challenger because its semantics fit FastEmbed**

- **Source**: https://docs.rs/fastembed/6.0.0/src/fastembed/common.rs.html; https://raw.githubusercontent.com/Anush008/fastembed-rs/v6.0.0/README.md; https://huggingface.co/BAAI/bge-small-en-v1.5/blob/5c38ec7c405ec4b44b94cc5a9bb96e735b38267a/README.md; https://huggingface.co/BAAI/bge-m3/blob/5617a9f61b028005a4858fdac845db406aefb181/README.md
- **Source credibility**: High. Immutable crate source and revision-pinned official model cards.
- **Evidence strength**: 3/5 for maintained implementation fit. Model-card behavior is 2/5 and **WEAK** because it lacks independent validation on this repository.
- **Summary**: The official BGE material specifies CLS pooling followed by L2 normalization, 384 output dimensions, and a 512-token limit for BGE-small-en-v1.5. FastEmbed 6.0.0 has a maintained built-in model entry and maps BGE-small to CLS pooling. Retrieval instructions are optional for the general similarity case and recommended only for some short-query-to-passage tasks.
- **Key technique/insight**: BGE-small separates model-quality evaluation from GPU-plumbing evaluation because its semantic operations already match the current user-defined FastEmbed path.
- **Applicability to our problem**: Run BGE-small through the CPU bundle first, then through the same ONNX artifact on CUDA. Use those runs to establish semantic equivalence and latency methodology before larger models.
- **Caveats**: A GPU port cannot rescue a model that fails the judged corpus. Model-card results do not establish magic-context quality, and any optional query instruction must be fingerprinted if enabled.

**Finding 7: Nomic v1.5 and Qwen3 need explicit preprocessing and postprocessing that the current Synapse wire cannot express**

- **Source**: https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/blob/e9b6763023c676ca8431644204f50c2b100d9aab/README.md; https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/blob/97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3/README.md
- **Source credibility**: High. Revision-pinned official model cards.
- **Evidence strength**: 2/5 — **WEAK**. Official documented behavior without independent validation on the judged corpus.
- **Summary**: Nomic v1.5 requires `search_document:` and `search_query:` prefixes. Its Matryoshka procedure mean-pools, layer-normalizes the 768-vector, slices to 512 or 256 dimensions, and L2-normalizes again. FastEmbed’s generic mean-pool-plus-L2 path lacks that layer-normalize-and-slice sequence. Qwen3-Embedding-0.6B requires left-padding-aware last-token pooling, final L2 normalization, and a query instruction; its official contract declares 32K context and dimensions from 32 through 1024.
- **Key technique/insight**: Nomic 256/512 needs a graph-side layer-normalize-and-slice output, a direct postprocessor, or a dimension-aware server. Qwen ONNX needs graph-side last-token pooling and the 256/512 Matryoshka slice, or it must bypass FastEmbed’s mean/CLS-only pooling. Selecting `last_hidden_state` with mean or CLS pooling is wrong.
- **Applicability to our problem**: These remain valuable benchmark candidates only if query/passsage preprocessing, dimensional reduction, and normalization are explicit and fingerprinted. Benchmarks may prefix texts explicitly while the production contract is repaired.
- **Caveats**: Synapse does not transmit query/passsage purpose. The OpenAI-compatible provider maps purpose to `input_type`, which TEI’s OpenAI request ignores. Production cannot claim the benchmarked embedding identity until purpose-aware preprocessing is deterministic and shared by indexing and querying.

**Finding 8: FastEmbed’s Candle Qwen3 implementation proves Rust feasibility but is not a drop-in strict bundle path**

- **Source**: https://docs.rs/crate/fastembed/6.0.0/features; https://docs.rs/crate/fastembed/6.0.0/source/src/models/qwen3.rs; https://docs.rs/crate/fastembed/6.0.0/source/tests/qwen3.rs; https://huggingface.github.io/candle/guide/installation.html
- **Source credibility**: High. Exact release source/tests and official Candle build documentation.
- **Evidence strength**: 3/5. Maintained implementation and test evidence.
- **Summary**: FastEmbed 6.0.0 includes a Candle implementation for `Qwen/Qwen3-Embedding-0.6B`, with tests against official reference similarities. It uses left padding, last-token pooling, and L2 normalization, demonstrating feasible Rust-native Qwen3 inference.
- **Key technique/insight**: The implementation is a useful semantic oracle for validating an ONNX export or sidecar. It is not the same runtime as FastEmbed’s user-defined ORT lane.
- **Applicability to our problem**: Keep Candle Qwen3 as a reference implementation or benchmark spike. It can verify prompt formatting, last-token pooling, normalization, and CPU/GPU semantic tolerances.
- **Caveats**: FastEmbed’s `qwen3` feature automatically enables `hf-hub`; its high-level loader resolves Hub files and memory-maps safetensors. A strict local bundle would require lower-level Candle loading and tokenizer setup, adding a second bundle/runtime implementation and CUDA toolkit/build integration.

**Finding 9: A pinned TEI sidecar is the most mature optional Qwen3 GPU path, but it adds a service boundary**

- **Source**: https://huggingface.co/docs/text-embeddings-inference/index; https://huggingface.co/docs/text-embeddings-inference/supported_models; https://github.com/huggingface/text-embeddings-inference/blob/0d124dc9773be6ac5a9a57d8439aba9bbbf33273/README.md; https://github.com/huggingface/text-embeddings-inference/blob/0d124dc9773be6ac5a9a57d8439aba9bbbf33273/router/src/http/types.rs; https://github.com/huggingface/text-embeddings-inference/blob/0d124dc9773be6ac5a9a57d8439aba9bbbf33273/router/src/http/server.rs
- **Source credibility**: High. Official documentation and commit-pinned maintained Rust server source.
- **Evidence strength**: 3/5. Maintained implementation evidence.
- **Summary**: TEI directly lists Qwen3-Embedding-0.6B and Nomic models, uses token-based dynamic batching, loads safetensors, and has maintained Rust server code. Its router accepts an exact local model directory for air-gapped deployment, a Hub revision when allowed, dtype, pooling, maximum concurrent requests, and maximum batch tokens. `/embed` supports prompt names, normalization, and dimensions; `/v1/embeddings` supports dimensions but not prompt names.
- **Key technique/insight**: TEI already implements Qwen3’s model family, last-token pooling, Matryoshka dimensions, batching, overload admission, metrics, and CUDA kernels. A production contract should pin the OCI digest, mount a read-only local model directory, hash all model/tokenizer files, disable network access, set every semantic and admission flag, and expose a served-model name equal to the semantic fingerprint.
- **Applicability to our problem**: TEI is the preferred Qwen3-0.6B 256/512 GPU spike and the fastest way to produce a semantically valid larger-model treatment for the repository benchmark.
- **Caveats**: TEI adds supervision, local HTTP, readiness, queueing, shutdown, and another artifact lifecycle. Its OpenAI endpoint ignores magic-context `input_type`; use a `/embed` adapter with `prompt_name` or prepend canonical query/passsage text. Advance only if judged quality or throughput pays for the boundary.

**Finding 10: Other sampled Rust runtimes do not yet beat ORT or TEI for this candidate set**

- **Source**: https://github.com/tracel-ai/burn; https://github.com/LaurentMazare/tch-rs; https://docs.mistralrs.dev/reference/supported-models/; https://github.com/ggml-org/llama.cpp/blob/master/examples/embedding/README.md
- **Source credibility**: Moderate. Primary project documentation, but exact candidate support was not established for every runtime.
- **Evidence strength**: 1/5 — **WEAK**. Negative evidence from an incomplete support search, not proof of absence.
- **Summary**: Candle has the best exact-model evidence because FastEmbed implements and tests Qwen3 on it. Burn documents broad CUDA/ROCm/Metal/WGPU backends and ONNX import, but no maintained exact implementation was found for this candidate set. `tch` requires a matching LibTorch C++ distribution and CUDA closure. mistral.rs advertises embeddings and OpenAI-compatible serving, but inspected primary docs lacked exact shortlist evidence comparable to TEI. llama.cpp has an embedding example, but no load-bearing source here established exact Qwen3-Embedding, Nomic-v1.5, or BGE-M3 semantics.
- **Key technique/insight**: Generic GPU or embedding capability is not enough; exact tokenizer, prompt, pooling, dimensional reduction, normalization, packaging, and tests determine suitability.
- **Applicability to our problem**: Reconsider Candle for a future in-process safetensors lane, or mistral.rs/llama.cpp if a verified GGUF/UQFF candidate reproduces official preprocessing and beats TEI. Burn and LibTorch add no demonstrated capability needed by the current shortlist.
- **Caveats**: This finding is explicitly weak. Project capabilities can change, and the absence of exact evidence in this search is not proof that support cannot exist.

**Finding 11: Semantic model identity and execution identity must be separate and joined by real-hardware certification**

- **Source**: https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html; https://onnxruntime.ai/docs/execution-providers/TensorRT-ExecutionProvider.html; https://onnxruntime.ai/docs/build/eps.html; https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/blob/97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3/README.md; https://onnx.ai/onnx/repo-docs/ExternalData.html
- **Source credibility**: High. Official runtime, format, and revision-pinned model documentation.
- **Evidence strength**: 2/5 — **WEAK**. The contract is a synthesis of official sources, not an externally validated magic-context deployment.
- **Summary**: Semantic identity should include immutable source revision; hashes of weights, graph/external data or safetensors; tokenizer and SentenceTransformers files; query/passsage prompts; special-token and padding behavior; truncation; pooling; layer normalization; Matryoshka dimension; final normalization; output; dtype/quantization; and export tool/opset/flags. ONNX external data is part of the model and must remain with the graph.
- **Key technique/insight**: Execution identity separately records the producer. For ORT: FastEmbed/ORT versions, API minor, `ort::info()`, native closure hashes, EP order, fallback policy, CUDA/cuDNN/TensorRT versions, provider options, device/driver, TF32, arena, batch budget, and concurrency. For TEI: OCI digest, TEI build, backend, CUDA image/runtime, device, dtype, pooling, dimensions, and admission/batching flags. TensorRT caches are disposable execution artifacts, not semantic identity.
- **Applicability to our problem**: Reuse a CPU semantic fingerprint on GPU only after the exact runtime/hardware passes structural checks, componentwise corpus checks, purpose-sensitive cases, dimensions, Unicode/code/truncation cases, CPU/GPU cosine and rank checks, and judged holdout nDCG@10/recall@50. Benchmark cold start, warm batches, memory, overload, cancellation, and restart on a host-fingerprinted GPU.
- **Caveats**: If equivalence is not demonstrated, issue a distinct lane fingerprint and never mix stored passage vectors from one lane with query vectors from another. Acceptance tolerances remain an open repository decision.

**Finding 12: Order the candidate shortlist by semantic risk, not advertised model rank**

- **Source**: https://raw.githubusercontent.com/Anush008/fastembed-rs/v6.0.0/README.md; https://huggingface.co/BAAI/bge-small-en-v1.5/blob/5c38ec7c405ec4b44b94cc5a9bb96e735b38267a/README.md; https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/blob/e9b6763023c676ca8431644204f50c2b100d9aab/README.md; https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/blob/97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3/README.md; https://huggingface.co/BAAI/bge-m3/blob/5617a9f61b028005a4858fdac845db406aefb181/README.md
- **Source credibility**: High. Exact crate release and revision-pinned official model cards.
- **Evidence strength**: 2/5 — **WEAK**. Official capability evidence supports the matrix, but no source establishes the repository winner.
- **Summary**: Retain MiniLM fp32 as baseline. Test BGE-small-en-v1.5 first on CPU and CUDA. Test Nomic-v1.5 at 256/512 only with prefixes and layer-normalize/slice/normalize. Test Qwen3-Embedding-0.6B at 256/512 as the primary GPU challenger, first through pinned TEI and second through a certified pooled ONNX export. Keep BGE-M3 experimental because its 1024-dimensional, 8192-token, multi-representation model exceeds the current dense-only need; FastEmbed warns its default quantized BGE-M3 artifact is CPU-optimized and fails with a GPU provider.
- **Key technique/insight**: Use the same judged corpus and host-bound latency policy for every treatment. This isolates semantic quality, runtime cost, and GPU benefit rather than importing public leaderboard conclusions.
- **Applicability to our problem**: Promotion requires holdout quality, latency, memory, startup, and immutable runtime-contract gates. Start with CUDA, one model, and one in-flight session/process. Defer TensorRT, I/O binding, multiple sessions, and wider provider portability until measurement earns them.
- **Caveats**: No model should replace MiniLM solely because of MTEB or model-card claims. Final choice remains benchmark-dependent, and Nomic/Qwen production use remains blocked on purpose-aware preprocessing identity.

## 3. Structured Evidence Summary

```json
[
  {"id":"F1","claim":"FastEmbed user-defined ONNX models expose bundle-critical inputs but not low-level ORT run/session controls.","source_url":["https://docs.rs/fastembed/6.0.0/src/fastembed/text_embedding/init.rs.html","https://docs.rs/fastembed/6.0.0/src/fastembed/text_embedding/impl.rs.html","https://docs.rs/fastembed/6.0.0/src/fastembed/common.rs.html","https://docs.rs/fastembed/6.0.0/src/fastembed/text_embedding/output.rs.html"],"source_title":["FastEmbed 6.0.0 user-defined model source","FastEmbed 6.0.0 text embedding implementation","FastEmbed 6.0.0 session builder","FastEmbed 6.0.0 output handling"],"evidence_strength":"3/5","credibility_tier":"High","applicability":"Directly defines which existing Synapse bundle controls can remain in FastEmbed and which GPU controls require another boundary."},
  {"id":"F2","claim":"FastEmbed's cuda feature is Candle CUDA; ORT CUDA must be enabled on the shared ort dependency.","source_url":["https://docs.rs/crate/fastembed/6.0.0/features","https://docs.rs/crate/ort/2.0.0-rc.13/features"],"source_title":["FastEmbed 6.0.0 features","ort 2.0.0-rc.13 features"],"evidence_strength":"3/5","credibility_tier":"High","applicability":"Prevents enabling the wrong feature and defines the minimal in-process ONNX CUDA feature change."},
  {"id":"F3","claim":"ort rc.13 exposes CUDA, TensorRT, ROCm, DirectML, CoreML, and MIGraphX wrappers, but runtime support depends on the loaded ORT build.","source_url":["https://docs.rs/crate/ort/2.0.0-rc.13/features","https://docs.rs/ort/2.0.0-rc.13/ort/ep/index.html","https://onnxruntime.ai/docs/execution-providers/ROCm-ExecutionProvider.html","https://onnxruntime.ai/docs/execution-providers/TensorRT-ExecutionProvider.html"],"source_title":["ort rc.13 feature list","ort rc.13 execution providers","ONNX Runtime ROCm EP","ONNX Runtime TensorRT EP"],"evidence_strength":"3/5","credibility_tier":"High","applicability":"Supports CUDA-first selection, MIGraphX for current AMD work, and deferral of TensorRT."},
  {"id":"F4","claim":"Safe CUDA registration is compatible with forbid(unsafe_code), but strict registration and native dependency closure are application obligations.","source_url":["https://docs.rs/ort/2.0.0-rc.13/ort/ep/index.html","https://docs.rs/ort/2.0.0-rc.13/src/ort/ep/cuda.rs.html","https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html","https://onnxruntime.ai/docs/build/eps.html"],"source_title":["ort rc.13 EP API","ort rc.13 CUDA source","ONNX Runtime CUDA EP","ONNX Runtime EP shared libraries"],"evidence_strength":"3/5 API; 2/5 WEAK operational guidance","credibility_tier":"High","applicability":"Defines fail-closed initialization and the GPU artifact manifest beyond the currently hashed ORT core."},
  {"id":"F5","claim":"One serialized session matches rc.13 guidance; I/O binding and cancellation are unavailable through FastEmbed and are not yet justified.","source_url":["https://docs.rs/ort/2.0.0-rc.13/src/ort/session/mod.rs.html","https://docs.rs/ort/2.0.0-rc.13/src/ort/session/io_binding.rs.html","https://docs.rs/ort/2.0.0-rc.13/src/ort/session/run_options.rs.html","https://onnxruntime.ai/docs/performance/tune-performance/iobinding.html"],"source_title":["ort rc.13 Session source","ort rc.13 I/O binding source","ort rc.13 RunOptions source","ONNX Runtime I/O Binding"],"evidence_strength":"3/5","credibility_tier":"High","applicability":"Supports retaining the existing one-permit topology and measuring batching before adding sessions or device buffers."},
  {"id":"F6","claim":"BGE-small's CLS-plus-normalize contract fits the existing FastEmbed lane directly.","source_url":["https://docs.rs/fastembed/6.0.0/src/fastembed/common.rs.html","https://raw.githubusercontent.com/Anush008/fastembed-rs/v6.0.0/README.md","https://huggingface.co/BAAI/bge-small-en-v1.5/blob/5c38ec7c405ec4b44b94cc5a9bb96e735b38267a/README.md","https://huggingface.co/BAAI/bge-m3/blob/5617a9f61b028005a4858fdac845db406aefb181/README.md"],"source_title":["FastEmbed session builder","FastEmbed supported models","BGE-small-en-v1.5 model card","BGE family model table"],"evidence_strength":"3/5 implementation; 2/5 WEAK model-card behavior","credibility_tier":"High","applicability":"Provides the lowest-semantic-risk challenger and CPU/GPU equivalence control."},
  {"id":"F7","claim":"Nomic 256/512 and Qwen3 256/512 require prompts and postprocessing absent from the current Synapse contract.","source_url":["https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/blob/e9b6763023c676ca8431644204f50c2b100d9aab/README.md","https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/blob/97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3/README.md"],"source_title":["Nomic Embed Text v1.5 model card","Qwen3-Embedding-0.6B model card"],"evidence_strength":"2/5 WEAK","credibility_tier":"High","applicability":"Makes purpose propagation and exact pooling/dimensional reduction prerequisites for valid candidate tests and production use."},
  {"id":"F8","claim":"FastEmbed's Candle Qwen3 implementation proves Rust feasibility but does not provide a drop-in strict local bundle loader.","source_url":["https://docs.rs/crate/fastembed/6.0.0/features","https://docs.rs/crate/fastembed/6.0.0/source/src/models/qwen3.rs","https://docs.rs/crate/fastembed/6.0.0/source/tests/qwen3.rs","https://huggingface.github.io/candle/guide/installation.html"],"source_title":["FastEmbed Qwen3 feature","FastEmbed Qwen3 implementation","FastEmbed Qwen3 tests","Candle CUDA installation"],"evidence_strength":"3/5","credibility_tier":"High","applicability":"Supplies a Rust semantic oracle for Qwen3 exports and sidecars without becoming the first production lane."},
  {"id":"F9","claim":"Pinned, air-gapped TEI is the strongest optional GPU sidecar for Qwen3 and dynamic batching.","source_url":["https://huggingface.co/docs/text-embeddings-inference/index","https://huggingface.co/docs/text-embeddings-inference/supported_models","https://github.com/huggingface/text-embeddings-inference/blob/0d124dc9773be6ac5a9a57d8439aba9bbbf33273/README.md","https://github.com/huggingface/text-embeddings-inference/blob/0d124dc9773be6ac5a9a57d8439aba9bbbf33273/router/src/http/types.rs","https://github.com/huggingface/text-embeddings-inference/blob/0d124dc9773be6ac5a9a57d8439aba9bbbf33273/router/src/http/server.rs"],"source_title":["TEI documentation","TEI supported models","TEI commit-pinned README","TEI HTTP types","TEI HTTP server"],"evidence_strength":"3/5","credibility_tier":"High","applicability":"Provides the lowest-risk Qwen3 GPU benchmark treatment with explicit operational identity requirements."},
  {"id":"F10","claim":"Other sampled Rust runtimes lack stronger exact-candidate evidence than ORT or TEI for this repository.","source_url":["https://github.com/tracel-ai/burn","https://github.com/LaurentMazare/tch-rs","https://docs.mistralrs.dev/reference/supported-models/","https://github.com/ggml-org/llama.cpp/blob/master/examples/embedding/README.md"],"source_title":["Burn repository","tch-rs repository","mistral.rs supported models","llama.cpp embedding example"],"evidence_strength":"1/5 WEAK","credibility_tier":"Moderate","applicability":"Avoids adding a runtime without exact candidate and packaging evidence while preserving explicit switch conditions."},
  {"id":"F11","claim":"Semantic model identity must be distinct from hardware/runtime execution identity and joined by real-hardware certification.","source_url":["https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html","https://onnxruntime.ai/docs/execution-providers/TensorRT-ExecutionProvider.html","https://onnxruntime.ai/docs/build/eps.html","https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/blob/97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3/README.md","https://onnx.ai/onnx/repo-docs/ExternalData.html"],"source_title":["ONNX Runtime CUDA EP","ONNX Runtime TensorRT EP","ONNX Runtime EP packaging","Qwen3 model card","ONNX external data"],"evidence_strength":"2/5 WEAK","credibility_tier":"High","applicability":"Defines the concrete semantic fingerprint, execution fingerprint, and CPU/GPU certification gate."},
  {"id":"F12","claim":"MiniLM, BGE-small, Nomic 256/512, Qwen3 256/512, and experimental BGE-M3 form the benchmark matrix; no source establishes a winner.","source_url":["https://raw.githubusercontent.com/Anush008/fastembed-rs/v6.0.0/README.md","https://huggingface.co/BAAI/bge-small-en-v1.5/blob/5c38ec7c405ec4b44b94cc5a9bb96e735b38267a/README.md","https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/blob/e9b6763023c676ca8431644204f50c2b100d9aab/README.md","https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/blob/97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3/README.md","https://huggingface.co/BAAI/bge-m3/blob/5617a9f61b028005a4858fdac845db406aefb181/README.md"],"source_title":["FastEmbed supported models","BGE-small model card","Nomic v1.5 model card","Qwen3-Embedding model card","BGE-M3 model card"],"evidence_strength":"2/5 WEAK","credibility_tier":"High","applicability":"Supplies a risk-ordered candidate matrix whose winner is determined only by the repository's judged quality and host-bound cost gates."}
]
```

## 4. Patterns & Consensus

Primary sources agree that preprocessing and postprocessing are part of the model. Pooling, query instructions, padding side, dimensional truncation, and normalization can change retrieval more than the choice of Rust wrapper. The current strict bundle is therefore an asset: extend its semantic fingerprint rather than treating a model repository name as identity.

The ecosystem also converges on one practical deployment split. Small BERT-family ONNX models fit FastEmbed/ORT well. Larger decoder-style embedding models benefit from a runtime that knows their architecture, prompts, pooling, and batching; TEI currently has stronger exact Qwen3 evidence than a generic ONNX export. This does not imply TEI wins latency or quality on magic-context. It means TEI is the lower-risk way to produce a valid Qwen3 treatment for the repository benchmark.

GPU feature flags are never enough. Every provider has native dependency, device, memory, and fallback behavior outside Cargo’s view. Strict registration, native-object closure, hardware identity, and a real-device smoke are required. CUDA is the best first provider because it has the strongest source and packaging path here. TensorRT is a second optimization layer, while current ROCm work should use MIGraphX rather than the removed ROCm EP.

Finally, batching is the main GPU opportunity. Magic-context already has one inference owner and bounded pages. Preserve that ownership, sweep batch rows and total tokens, and add sessions or I/O binding only after evidence shows host-device copies or serialization—not model compute or queueing—limits the chosen candidate.

## 5. Disagreements & Open Questions

1. FastEmbed’s Qwen3 source comment calls the wrapper “mean-pooling,” while the implementation and tests use last-token pooling. The implementation matches the Qwen model card; the comment is stale. Certification must follow behavior, not that comment.
2. The rc.13 crate still exposes an `ort/rocm` feature although upstream removed ROCm EP in ORT 1.23. Treat the feature as source compatibility for older/custom runtimes, not current support.
3. No exact GPU ORT artifact has been selected. CUDA/cuDNN major versions, ORT build flags, provider shared libraries, and minimum driver remain open until an owner-provisioned build is named and hashed.
4. It is unproven that Optimum can export the exact Qwen3 and BGE-M3 postprocessing graph needed here. A successful `feature-extraction` export is not enough; outputs must reproduce official prompts, pooling, dimensional slicing, and normalization. Test exported graphs against the source framework before adding them to the benchmark.
5. The current Synapse wire loses `EmbeddingPurpose`. The current OpenAI-compatible integration sends `input_type`, while TEI needs `prompt_name` or already-prefixed text. Decide one canonical purpose-to-text transformation and include it in lane identity before promoting Nomic or Qwen.
6. CPU/GPU equivalence tolerance is not yet specified. Componentwise tolerance, cosine deviation, top-k stability, and judged-metric loss need explicit acceptance bounds. TF32 and FP16 should be separate treatments until those bounds pass.
7. `gpu_mem_limit` bounds only the CUDA EP arena, not total device use. The acceptable process high-water mark and behavior when the device is shared remain open.
8. I/O binding and pinned memory have no workload-specific evidence. Measure transfer share at production batch shapes before bypassing FastEmbed for them.
9. TEI’s process boundary adds restart and HTTP queueing semantics. A spike must measure cancellation, shutdown drain, overload status, and stale-sidecar identity handling rather than assuming HTTP cancellation stops GPU work.
10. BGE-M3’s sparse and ColBERT outputs are not used by the current dense retrieval contract. Its additional cost is unjustified unless the judged corpus shows a dense-quality win or a separate hybrid-retrieval design is approved.

## 6. Recommended Reading

- **S1:** FastEmbed 6.0.0 user-defined model source: https://docs.rs/fastembed/6.0.0/src/fastembed/text_embedding/init.rs.html
- **S2:** FastEmbed 6.0.0 session construction and external initializers: https://docs.rs/fastembed/6.0.0/src/fastembed/text_embedding/impl.rs.html
- **S3:** FastEmbed 6.0.0 common session builder: https://docs.rs/fastembed/6.0.0/src/fastembed/common.rs.html
- **S4:** FastEmbed 6.0.0 output selection and normalization: https://docs.rs/fastembed/6.0.0/src/fastembed/text_embedding/output.rs.html
- **S5:** FastEmbed 6.0.0 feature list: https://docs.rs/crate/fastembed/6.0.0/features
- **S6:** `ort` 2.0.0-rc.13 feature list: https://docs.rs/crate/ort/2.0.0-rc.13/features
- **S7:** `ort` 2.0.0-rc.13 execution-provider source: https://docs.rs/ort/2.0.0-rc.13/ort/ep/index.html
- **S8:** `ort` 2.0.0-rc.13 CUDA source and preload closure: https://docs.rs/ort/2.0.0-rc.13/src/ort/ep/cuda.rs.html
- **S9:** `ort` 2.0.0-rc.13 session, I/O binding, and run options: https://docs.rs/ort/2.0.0-rc.13/src/ort/session/mod.rs.html and https://docs.rs/ort/2.0.0-rc.13/src/ort/session/io_binding.rs.html and https://docs.rs/ort/2.0.0-rc.13/src/ort/session/run_options.rs.html
- **S10:** ONNX Runtime CUDA EP requirements and options: https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html
- **S11:** ONNX Runtime TensorRT EP and engine-cache constraints: https://onnxruntime.ai/docs/execution-providers/TensorRT-ExecutionProvider.html
- **S12:** ONNX Runtime ROCm removal notice: https://onnxruntime.ai/docs/execution-providers/ROCm-ExecutionProvider.html
- **S13:** ONNX Runtime execution-provider shared-library packaging: https://onnxruntime.ai/docs/build/eps.html
- **S14:** ONNX Runtime I/O binding guidance: https://onnxruntime.ai/docs/performance/tune-performance/iobinding.html
- **S15:** FastEmbed 6.0.0 Qwen3 implementation: https://docs.rs/crate/fastembed/6.0.0/source/src/models/qwen3.rs
- **S16:** FastEmbed 6.0.0 supported models and BGE-M3 GPU warning: https://raw.githubusercontent.com/Anush008/fastembed-rs/v6.0.0/README.md
- **S17:** FastEmbed 6.0.0 Qwen3 tests: https://docs.rs/crate/fastembed/6.0.0/source/tests/qwen3.rs
- **S18:** BGE-small-en-v1.5 model card at revision `5c38ec7c405ec4b44b94cc5a9bb96e735b38267a`: https://huggingface.co/BAAI/bge-small-en-v1.5/blob/5c38ec7c405ec4b44b94cc5a9bb96e735b38267a/README.md
- **S19:** Nomic Embed Text v1.5 model card at revision `e9b6763023c676ca8431644204f50c2b100d9aab`: https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/blob/e9b6763023c676ca8431644204f50c2b100d9aab/README.md
- **S20:** Qwen3-Embedding-0.6B model card at revision `97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3`: https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/blob/97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3/README.md
- **S21:** BGE-M3 model card at revision `5617a9f61b028005a4858fdac845db406aefb181`: https://huggingface.co/BAAI/bge-m3/blob/5617a9f61b028005a4858fdac845db406aefb181/README.md
- **S22:** TEI current documentation: https://huggingface.co/docs/text-embeddings-inference/index and https://huggingface.co/docs/text-embeddings-inference/supported_models
- **S23:** TEI README at inspected commit `0d124dc9773be6ac5a9a57d8439aba9bbbf33273`: https://github.com/huggingface/text-embeddings-inference/blob/0d124dc9773be6ac5a9a57d8439aba9bbbf33273/README.md
- **S24:** TEI HTTP request types, including dimensions and prompt names: https://github.com/huggingface/text-embeddings-inference/blob/0d124dc9773be6ac5a9a57d8439aba9bbbf33273/router/src/http/types.rs
- **S25:** TEI `/embed` and `/v1/embeddings` implementation: https://github.com/huggingface/text-embeddings-inference/blob/0d124dc9773be6ac5a9a57d8439aba9bbbf33273/router/src/http/server.rs
- **S26:** ONNX external-data format: https://onnx.ai/onnx/repo-docs/ExternalData.html
- **S27:** Candle CUDA installation: https://huggingface.github.io/candle/guide/installation.html
- **S28:** Burn backend matrix and ONNX overview: https://github.com/tracel-ai/burn
- **S29:** `tch-rs` LibTorch requirements: https://github.com/LaurentMazare/tch-rs
- **S30:** mistral.rs supported-model documentation: https://docs.mistralrs.dev/reference/supported-models/
- **S31:** llama.cpp embedding example: https://github.com/ggml-org/llama.cpp/blob/master/examples/embedding/README.md
- **S32:** Optimum ONNX export guide, whose export success still requires model-specific semantic validation: https://huggingface.co/docs/optimum-onnx/onnx/usage_guides/export_a_model

</details>

<details>
<summary>Agent 5: Industry Practice & System Architecture</summary>

# Research Report — Agent 5: Industry Practice & System Architecture

**Research date:** 2026-08-23  
**Scope:** Industry practice for selecting, evaluating, deploying, and migrating embedding models for mixed project-memory and code-context retrieval. Public benchmark scores are treated as shortlist evidence only. Vendor documentation establishes supported mechanisms, not model or server superiority.

## 1. Codebase Context

Magic Context has two materially different local inference lanes. The default lane resolves to `Xenova/all-MiniLM-L6-v2` and uses the local provider unless configuration selects another provider ([schema lines 19–22](https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/packages/plugin/src/config/schema/magic-context.ts#L19-L22); [provider selection lines 46–70](https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/packages/plugin/src/features/magic-context/memory/embedding.ts#L46-L70)). `LocalEmbeddingProvider` defaults to a 512-token application limit and fp32 inference ([lines 423–437](https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/packages/plugin/src/features/magic-context/memory/embedding-local.ts#L423-L437), [lines 258–263](https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/packages/plugin/src/features/magic-context/memory/embedding-local.ts#L258-L263)), then applies mean pooling and L2 normalization for single and batch requests ([lines 668–675](https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/packages/plugin/src/features/magic-context/memory/embedding-local.ts#L668-L675), [lines 713–720](https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/packages/plugin/src/features/magic-context/memory/embedding-local.ts#L713-L720)). One issue must be resolved before comparing chunk-length treatments: the upstream MiniLM model card says inputs longer than 256 wordpieces are truncated by default. The repository's 512-token provider limit does not prove that tokens 257–512 influence the converted Xenova artifact.

The provider layer supports local, OpenAI-compatible, off, and Synapse configurations ([embedding.ts lines 54–164](https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/packages/plugin/src/features/magic-context/memory/embedding.ts#L54-L164)). Provider identity includes model-affecting settings. Synapse identity derives from model plus certified fingerprint, while non-default local dtype and OpenAI-compatible input/truncation settings alter identity ([embedding-identity.ts lines 18–68](https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/packages/plugin/src/features/magic-context/memory/embedding-identity.ts#L18-L68)). This is the correct base for preventing cross-space cosine comparisons. The current local batch method still accepts `_purpose` without applying it ([embedding-local.ts lines 684–688](https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/packages/plugin/src/features/magic-context/memory/embedding-local.ts#L684-L688)), so instruction-aware candidates cannot be compared fairly until query/document purpose plumbing is active.

Synapse is intentionally narrower and more strongly controlled. Its default advertised model is `gte-modernbert-base-f16`, with an 8,192-token and 1 MiB per-item ceiling ([embedding-synapse.ts lines 28–32](https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/packages/plugin/src/features/magic-context/memory/embedding-synapse.ts#L28-L32)). A bundle is immutable, owner-provisioned, size-bounded, and SHA-256 verified before FastEmbed receives it ([bundle guide lines 6–24](https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/docs/synapse-model-bundle.md#L6-L24)). Its fingerprint covers artifacts, dimensions, pooling, quantization, output selection, truncation, and L2 post-processing ([lines 72–77](https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/docs/synapse-model-bundle.md#L72-L77)). The host pins FastEmbed 6.0.0 and dynamically loaded ORT 2.0.0-rc.13 ([Cargo.toml lines 18–19](https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/crates/mc-host/Cargo.toml#L18-L19)), uses one ORT intra-op thread, and runs structural plus semantic certification before readiness ([inference.rs lines 177–188 and 252–265](https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/crates/mc-host/src/synapse/inference.rs#L177-L265)). One semaphore permit serializes native inference, while query admission and batch jobs are bounded separately ([mod.rs lines 164–203](https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/crates/mc-host/src/synapse/mod.rs#L164-L203)). Bundles are never watched or hot-reloaded, and each lane serves exactly one model ([bundle guide lines 180–189](https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/docs/synapse-model-bundle.md#L180-L189)).

The judged retrieval corpus contains 22 queries and 22 documents, split evenly between development and holdout. It covers exact symbol/path, errors, architecture rationale, debugging history, directives, current constraints, benchmark results, temporal memory, contradictory memory, and paraphrased decisions ([corpus artifact](https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/packages/plugin/scripts/fixtures/retrieval-benchmark/v1/corpus.json)). Quality policy uses graded relevance, nDCG@10, and Recall@50 ([metrics.ts lines 22–32](https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/packages/plugin/scripts/retrieval-benchmark/metrics.ts#L22-L32)). The repository requires three runs; latency is the median of three run-level p95 values from raw request samples, with host identity and environment controls ([regression.ts lines 1–20](https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/packages/plugin/scripts/retrieval-benchmark/regression.ts#L1-L20); [policy.json lines 1–20](https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/packages/plugin/scripts/fixtures/retrieval-benchmark/baselines/v1/policy.json#L1-L20)). These runs control execution variability. They do not increase the number of independent relevance judgments.

Task `magic-context-3q5.27` sets the correct decision rule: MiniLM remains default until an in-domain win, and the minimum campaign includes BGE-small-en-v1.5, Nomic v1.5 at 256/512 dimensions, Qwen3-Embedding-0.6B at 256/512 dimensions, and BGE-M3 as experimental, with correct query/document instructions. Task `magic-context-bx3` also sets the right GPU boundaries: one startup-selected lane, exact execution identity, deterministic CPU fallback, bounded work, no request-time switching, no mutable registry or runtime downloads, and no multi-GPU scheduler. Industry evidence below supports those constraints rather than replacing them.

## 2. Findings

**Finding 1: The repository's judged corpus should decide; public leaderboards should only nominate candidates**

- **Source**: MTEB paper, <https://arxiv.org/html/2210.07316>; BEIR paper, <https://arxiv.org/html/2104.08663>; CodeSearchNet paper, <https://arxiv.org/html/1909.09436>; CoIR paper, <https://arxiv.org/html/2407.02883>; Sentence Transformers evaluation documentation, <https://sbert.net/docs/package_reference/sentence_transformer/evaluation.html>; Sentence Transformers hard-negative utilities, <https://sbert.net/docs/package_reference/util.html>.
- **Source credibility**: High. MTEB, BEIR, CodeSearchNet, and CoIR are research benchmarks with disclosed tasks and methods. Sentence Transformers documentation is first-party implementation evidence for evaluator mechanics, not independent proof of model quality.
- **Evidence strength**: 4/5 — peer-reviewed or research-grade benchmark evidence, supported by implemented evaluation tooling.
- **Summary**: MTEB evaluated more than 30 models across thousands of experiments and found that performance varied strongly by task, with no model best on every task. BEIR exists because retrieval behavior changes across domains and task types. CodeSearchNet used 99 natural-language queries with roughly 4,000 expert relevance annotations over a six-language corpus, while CoIR separates text-to-code, code-to-code, code QA, and mixed text/code retrieval rather than treating code search as one task. None of these sources establishes the best model for project memory.
- **Key technique/insight**: Use a frozen, graded, domain-specific judgment set and pool top results from the incumbent, every challenger, the lexical lane, and fixed hybrid configurations. Judge high-scoring wrong results as hard negatives. Report per-query and per-category deltas alongside macro nDCG@10 and Recall@50.
- **Applicability to our problem**: The current 22-query corpus is a useful regression seed because its categories match Magic Context's real semantics. Public scores should reduce the candidate set, while this corpus and additional locally judged cases should select the default. New cases should come from real retrieval failures and candidate disagreements.
- **Caveats**: The 11-query holdout is too narrow for a broad superiority claim because most categories contribute only one holdout example. No source supplies a universal minimum sample count. The set should grow until each important slice has multiple independent examples and further judgment rounds stop changing candidate ordering materially. Three latency runs do not increase judgment diversity.

**Finding 2: Use offline replay and shadow spaces before any user-facing comparison**

- **Source**: Chapelle, Joachims, Radlinski, and Yue, “Large Scale Validation and Analysis of Interleaved Search Evaluation,” <https://www.microsoft.com/en-us/research/publication/large-scale-validation-and-analysis-of-interleaved-search-evaluation/>.
- **Source credibility**: High. This ACM TOIS work evaluates interleaving with data from two commercial search engines and a scientific-literature retrieval system.
- **Evidence strength**: 5/5 — validated at production search scale.
- **Summary**: Interleaving can compare rankers efficiently when a service has repeated traffic and reliable implicit feedback. The study compares interleaving with manual judgments and observational feedback and evaluates sensitivity. That validates the technique under large search workloads, not under sparse local use.
- **Key technique/insight**: Replay the same query against separate immutable candidate spaces, retain paired ranked outputs, and compare them offline before exposing any change. Online interleaving is a later option only when feedback semantics and sample volume are adequate.
- **Applicability to our problem**: For Magic Context, a shadow lane should mean local replay against separately identified spaces. It should not mean request-time random assignment, two user-visible answers, or uploading private memory. Start with the frozen corpus, then add opt-in local replay of real queries.
- **Caveats**: Transfer to a single-user local tool is limited. Magic Context has sparse searches, no stable click signal, and a privacy-first default. Online A/B or interleaving would require a defined success event, telemetry consent, sufficient interactions, and a power analysis. Existing shadow-space and lazy-reembedding machinery is more applicable than commercial experimentation infrastructure.

**Finding 3: Mixed code and project memory favors hybrid lexical+dense retrieval, not dense-only replacement**

- **Source**: GitHub code-search architecture, <https://github.blog/engineering/architecture-optimization/the-technology-behind-githubs-new-code-search/>; Anthropic Contextual Retrieval report, <https://www.anthropic.com/news/contextual-retrieval>; Vespa hybrid-search tutorial, <https://docs.vespa.ai/en/learn/tutorials/hybrid-search.html>.
- **Source credibility**: High for GitHub's production exact-search mechanism; Moderate for Anthropic's vendor-reported experiments and Vespa's first-party tutorial.
- **Evidence strength**: 5/5 for exact code-search practice; 3/5 for the portability of reported hybrid gains.
- **Summary**: GitHub's production code-search architecture uses a trigram index because code users need exact substring and regular-expression retrieval. Dense retrieval addresses complementary semantic cases such as paraphrased decisions and related debugging history. Anthropic reports that combining contextual embeddings with contextual BM25 reduced top-20 retrieval failure from 5.7% to 2.9% on its tested domains, with reranking reducing it to 1.9%. Vespa provides an implemented BM25-plus-nearest-neighbor evaluation pattern under nDCG@10.
- **Key technique/insight**: Keep lexical and dense candidate generators independent, fuse their outputs under a fixed rule, and preserve lane-level diagnostics. Evaluate lexical-only, dense-only, and fused retrieval for every candidate.
- **Applicability to our problem**: Exact symbols, paths, error strings, task IDs, and negated directives need lexical coverage. Paraphrased rationale and debugging history need semantic coverage. A default candidate should qualify on the fused user-visible path while dense-only results reveal whether the model or the fusion rule caused a change.
- **Caveats**: Anthropic's percentages are vendor-reported and cannot be projected onto Magic Context. GitHub's trigram architecture proves the value of exact code retrieval, not the ideal fusion formula. BGE-M3's sparse and multi-vector outputs require a separate architecture experiment; dense-only use does not test its full advertised system.

**Finding 4: Query/document instructions are part of the embedding-space contract**

- **Source**: BGE-small-en-v1.5 model card, <https://huggingface.co/BAAI/bge-small-en-v1.5/raw/main/README.md>; Nomic Embed v1.5 model card, <https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/raw/main/README.md>; Qwen3-Embedding-0.6B model card, <https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/raw/main/README.md>; local purpose handling, <https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/packages/plugin/src/features/magic-context/memory/embedding-local.ts#L684-L688>.
- **Source credibility**: High for first-party model input contracts and repository code; Moderate for producer-reported quality deltas.
- **Evidence strength**: 3/5 — implemented producer contracts that are directly testable.
- **Summary**: Instruction behavior differs across shortlisted models. Nomic requires prefixes such as `search_query:` and `search_document:` and documents layer normalization before Matryoshka truncation and final L2 normalization. Qwen3 uses task instructions on queries and no corresponding document instruction. BGE v1.5 documents query-side retrieval instructions. These transformations affect the resulting vector space.
- **Key technique/insight**: Version and fingerprint exact query templates, document templates, task descriptions, pooling, normalization order, truncation, and dimensional projection. Add fixtures that assert the exact bytes entering each encoder for query and document purposes.
- **Applicability to our problem**: Every candidate in `magic-context-3q5.27` must be tested with its declared asymmetric behavior. Changing a Nomic prefix, Qwen instruction, or normalization order must create a new space even when model weights are unchanged.
- **Caveats**: Qwen's reported 1–5% benefit from instructions is vendor evidence and may not transfer. More importantly, the current local batch path ignores `_purpose`; instruction-aware local benchmark results are invalid for a default swap until that path is fixed and verified.

**Finding 5: Chunking and truncation must be benchmark factors, not model metadata footnotes**

- **Source**: Azure AI Search chunking guidance, <https://learn.microsoft.com/en-us/azure/search/vector-search-how-to-chunk-documents>; CoIR paper, <https://arxiv.org/html/2407.02883>; MiniLM model card, <https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/raw/main/README.md>; BGE-small model card, <https://huggingface.co/BAAI/bge-small-en-v1.5/raw/main/README.md>; Nomic model card, <https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/raw/main/README.md>; Qwen3 model card, <https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/raw/main/README.md>; BGE-M3 model card, <https://huggingface.co/BAAI/bge-m3/raw/main/README.md>; GTE-ModernBERT model card, <https://huggingface.co/Alibaba-NLP/gte-modernbert-base/raw/main/README.md>.
- **Source credibility**: High for model-declared limits and CoIR's research workload description; Moderate for Azure's general starting guidance.
- **Evidence strength**: 4/5 — research evidence for context diversity plus directly testable model contracts. Azure's specific starting values are 2/5 credible practice and are not treated as universal.
- **Summary**: Azure treats 512 tokens with 25% overlap as a starting point and explicitly says the optimum varies by content. CoIR includes multi-turn code retrieval where context can exceed 4,000 tokens while many retrievers accept only 512. Candidate limits vary from upstream MiniLM's default 256 wordpieces through BGE-small's 512, Nomic and BGE-M3's 8,192, GTE-ModernBERT's 8,192, and Qwen3's 32K. A longer limit is a capability, not proof that one long vector retrieves better.
- **Key technique/insight**: Run a compatibility track with today's chunking held constant to isolate encoder quality, then a small predeclared model-native matrix that varies coherent chunk boundaries, overlap, and maximum tokens. Record truncation rate, chunks per project, index bytes, re-embedding time, latency, and quality.
- **Applicability to our problem**: First probe the exact installed Xenova tokenizer and ONNX artifact to learn whether tokens 257–512 affect MiniLM output. Then compare candidates under both equal-input and model-native treatments so extra source text is not misreported as encoder quality.
- **Caveats**: Azure's overlap recommendation is not a product-specific optimum. Longer contexts may dilute a vector that represents several topics and may increase latency or memory. Comparing a 256-token treatment with an 8K treatment without labeling the input difference confounds the result.

**Finding 6: Measure candidate recall before reranking and user-visible ranking after reranking**

- **Source**: Sentence Transformers retrieval evaluator, <https://sbert.net/docs/package_reference/sentence_transformer/evaluation.html>; Sentence Transformers Retrieve & Re-Rank guide, <https://www.sbert.net/examples/sentence_transformer/applications/retrieve_rerank/README.html>; CrossEncoder evaluation documentation, <https://www.sbert.net/docs/package_reference/cross_encoder/evaluation.html>; Anthropic Contextual Retrieval report, <https://www.anthropic.com/news/contextual-retrieval>.
- **Source credibility**: High for first-party evaluator behavior; Moderate for Anthropic's scoped vendor experiment.
- **Evidence strength**: 3/5 — implemented evaluator and pipeline contracts with tested examples.
- **Summary**: Retrieve-and-rerank systems use a cheaper lexical or bi-encoder stage to collect a wider candidate set, then a cross-encoder to rescore it. Sentence Transformers exposes first-stage Recall, MRR, MAP, and nDCG plus reranking metrics over supplied candidates. A reranker cannot recover a relevant document omitted from its input candidates.
- **Key technique/insight**: Report pre-rerank Recall@50, post-rerank nDCG@10, and end-to-end p95 separately. Hold reranker, candidate depth, fusion, and templates constant while comparing encoders.
- **Applicability to our problem**: Magic Context's existing Recall@50 and nDCG@10 pairing already maps well to candidate coverage and final ordering. If reranking is introduced, the same harness can distinguish retrieval failure from ordering failure.
- **Caveats**: External evidence does not show that this corpus needs a reranker. A stronger reranker can hide a weaker encoder, while a larger encoder can appear better if it receives a different downstream path. Reranker selection should be a separate factorial campaign after encoder selection or when top-50 recall is healthy but top-10 order remains poor.

**Finding 7: The existing shortlist is well tiered; no source supports naming a winner before the repository campaign**

- **Source**: MiniLM model card/API, <https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/raw/main/README.md>, <https://huggingface.co/api/models/sentence-transformers/all-MiniLM-L6-v2>; BGE-small model card/API, <https://huggingface.co/BAAI/bge-small-en-v1.5/raw/main/README.md>, <https://huggingface.co/api/models/BAAI/bge-small-en-v1.5>; Nomic model card/API, <https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/raw/main/README.md>, <https://huggingface.co/api/models/nomic-ai/nomic-embed-text-v1.5>; Qwen3 model card/API, <https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/raw/main/README.md>, <https://huggingface.co/api/models/Qwen/Qwen3-Embedding-0.6B>; BGE-M3 model card/API, <https://huggingface.co/BAAI/bge-m3/raw/main/README.md>, <https://huggingface.co/api/models/BAAI/bge-m3>; GTE-ModernBERT model card/API, <https://huggingface.co/Alibaba-NLP/gte-modernbert-base/raw/main/README.md>, <https://huggingface.co/api/models/Alibaba-NLP/gte-modernbert-base>.
- **Source credibility**: High for producer-declared architecture, dimensions, context, and license metadata. Public model-card benchmark scores remain vendor evidence.
- **Evidence strength**: 3/5 — maintained model artifacts and directly testable metadata.
- **Summary**: The shortlist spans useful operating points. MiniLM is a 384-dimensional, roughly 22.7M-parameter baseline with upstream default truncation at 256 wordpieces. BGE-small is 384-dimensional, 512-token, and roughly 33.4M parameters. Nomic is 768-dimensional natively, supports 256/512 Matryoshka treatments, up to 8,192 tokens, and roughly 136.7M parameters. GTE-ModernBERT is 768-dimensional, 8,192-token, and roughly 149M parameters. Qwen3-0.6B is 1,024-dimensional natively with Matryoshka support, 32K context, and roughly 595.8M parameters. BGE-M3 is 1,024-dimensional with 8,192-token dense, sparse, and multi-vector modes. Hub metadata declares Apache-2.0 for MiniLM, Nomic, Qwen3, and GTE, and MIT for BGE-small and BGE-M3.
- **Key technique/insight**: Run candidates in increasing operational cost: MiniLM control, BGE-small, Nomic 256/512, GTE-ModernBERT execution control, Qwen3 256/512 on CPU and GPU, then BGE-M3's richer modes only if justified.
- **Applicability to our problem**: This ordering can disprove the need for a heavier deployment early. GTE isolates Synapse execution from model changes. A bounded CPU run of Qwen provides an execution control before attributing a result to GPU hardware.
- **Caveats**: Parameter totals are Hub safetensors metadata, not measured resident memory. Memory depends on precision, graph, sequence length, batch, and allocator. Model cards do not determine in-domain quality. BGE-M3 dense-only testing is incomplete, while full sparse or multi-vector use requires additional indexing and fusion work.

**Finding 8: Keep the simple CPU-local lane as the supported baseline; use Synapse for certified and heavier models**

- **Source**: Local provider implementation, <https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/packages/plugin/src/features/magic-context/memory/embedding-local.ts#L245-L263>; provider lifecycle, <https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/packages/plugin/src/features/magic-context/memory/embedding.ts#L167-L173>; Synapse bundle contract, <https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/docs/synapse-model-bundle.md#L6-L24>; Synapse certification and failure behavior, <https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/docs/synapse-model-bundle.md#L144-L161>.
- **Source credibility**: High. These are exact repository implementation and normative design sources at commit `21bd53d00033c96bf322accc2be100beb39006dc`.
- **Evidence strength**: 3/5 — implemented and tested local architecture.
- **Summary**: The local lane has the smallest operational surface: one in-process Transformers.js feature-extraction pipeline, fp32 by default, mean pooling, normalization, and lazy provider creation. Synapse adds exact hashes, complete space fingerprinting, one model, semantic certification, bounded jobs, and fail-closed lane health. It also serializes inference and uses one ORT intra-op thread. These are distinct operating points, not interchangeable wrappers.
- **Key technique/insight**: Separate baseline availability from advanced execution. Keep the smallest proven CPU path available while using the certified lane for models and runtimes whose artifact, memory, or execution risks require stronger controls.
- **Applicability to our problem**: Preserve MiniLM local as bootstrap/default until another treatment passes quality, latency, and footprint gates. Use Synapse for GTE, Qwen, BGE-M3, and GPU experiments. Reuse its certification, identity, lifecycle, and backfill instead of constructing a second GPU registry or protocol.
- **Caveats**: This is constraint-driven synthesis from repository behavior, not an external production comparison. A quality winner may remain opt-in if cold start, footprint, or p95 violates policy. A faster GPU does not justify a model swap if MiniLM remains better on judged retrieval.

**Finding 9: Serving-system features transfer selectively; an external model server is not automatically appropriate**

- **Source**: Hugging Face TEI README, <https://raw.githubusercontent.com/huggingface/text-embeddings-inference/main/README.md>; TEI CLI arguments, <https://huggingface.co/docs/text-embeddings-inference/en/cli_arguments>; vLLM stable pooling documentation, <https://docs.vllm.ai/en/stable/models/pooling_models/>; Infinity README, <https://raw.githubusercontent.com/michaelfeil/infinity/main/README.md>; NVIDIA NIM overview, <https://docs.nvidia.com/nim/nemo-retriever/text-embedding/latest/overview.html>; NIM support matrix, <https://docs.nvidia.com/nim/nemo-retriever/text-embedding/latest/support-matrix.html>.
- **Source credibility**: Moderate. These are maintained first-party runtime and vendor documents that establish features, not independent comparative performance.
- **Evidence strength**: 3/5 — implemented serving systems and documented runtime behavior.
- **Summary**: TEI serves one model ID or local directory per process, supports revision pinning, token-based dynamic batching, explicit concurrency and batch-token limits, CPU and accelerator images, and air-gapped deployment. vLLM supports embeddings and pooling but explicitly says pooling support is primarily for convenience and is not guaranteed to outperform Transformers. Infinity offers several backends, dynamic batching, and multi-model orchestration. NIM offers an OpenAI-compatible GPU service with hardware-specific profiles.
- **Key technique/insight**: Transfer only immutable startup configuration, one loaded model, token-aware batches, explicit backpressure, observability, and deterministic failure behavior. Adopt a server boundary only when process isolation, multiple clients, container operations, or measured batching benefits require it.
- **Applicability to our problem**: In-process ORT/FastEmbed is the smallest first GPU implementation because it reuses the certified bundle and host lifecycle. TEI is useful as a benchmark adapter or later isolation option. vLLM is relevant if a chosen decoder-based model performs materially better there. Infinity's multi-model feature conflicts with the deliberate one-lane scope. NIM is relevant only under an explicit NVIDIA enterprise deployment requirement.
- **Caveats**: No cited source compares these systems on Magic Context's single-user workload. Cloud and multi-tenant batching benefits may disappear at low concurrency. NIM's scale and security claims are vendor claims. Runtime choice remains benchmark-gated.

**Finding 10: The smallest coherent GPU architecture is one Linux/NVIDIA ORT CUDA profile selected at startup**

- **Source**: ONNX Runtime execution-provider documentation, <https://onnxruntime.ai/docs/execution-providers/>; CUDA Execution Provider documentation, <https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html>; ONNX Runtime I/O Binding documentation, <https://onnxruntime.ai/docs/performance/tune-performance/iobinding.html>; current Synapse native-runtime contract, <https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/docs/synapse-model-bundle.md#L118-L150>.
- **Source credibility**: High for ONNX Runtime mechanisms and exact repository constraints.
- **Evidence strength**: 3/5 — maintained runtime implementation documentation and an implemented host boundary.
- **Summary**: ONNX Runtime accepts an ordered execution-provider list and assigns graph work according to priority. Its CUDA provider has explicit CUDA and cuDNN compatibility requirements. ORT also warns that host/device copies can dominate apparent inference time and offers I/O Binding to control transfers. These sources establish mechanisms, not a latency win for small single-query embeddings.
- **Key technique/insight**: Select one execution profile at startup, certify the complete graph and output semantics, and publish execution identity. If unsupported operators deliberately run on CPU, identify and certify that fixed profile as `cuda+cpu` rather than calling it pure CUDA.
- **Applicability to our problem**: First support the existing Linux host boundary plus one NVIDIA CUDA EP profile. Identity should include model fingerprint, ORT build/hash, CUDA/cuDNN tuple, EP options, precision, provider partition policy, dimensions, pooling, and truncation. On GPU startup or certification failure, destroy the candidate and start a separately identified CPU lane. Keep one permit initially.
- **Caveats**: Linux x86-64/NVIDIA is a smallest-scope proposal, not proof of market-optimal coverage. The actual target GPU, driver, VRAM, and CUDA stack remain unspecified. I/O Binding, pinned memory, overlapping copies, and additional streams should be added only after stage-level measurements show transfer or launch overhead is material.

**Finding 11: GPU capacity should be token-bounded, admission-bounded, and measured from cold start through steady state**

- **Source**: TEI CLI arguments, <https://huggingface.co/docs/text-embeddings-inference/en/cli_arguments>; NVIDIA NIM support matrix, <https://docs.nvidia.com/nim/nemo-retriever/text-embedding/latest/support-matrix.html>; Synapse admission implementation, <https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/crates/mc-host/src/synapse/mod.rs#L164-L203>.
- **Source credibility**: Moderate for transferable server and vendor capacity practice; High for the local implementation boundary.
- **Evidence strength**: 3/5 — implemented admission and documented hardware-profile controls.
- **Summary**: TEI treats maximum batch tokens as a critical hardware control and caps concurrent requests to provide backpressure instead of unbounded waiting. NIM's matrix shows that precision, memory, disk, and maximum tokens vary by model, hardware, and optimized versus fallback profile. Current Synapse already has one native permit, one waiting interactive query, bounded background jobs, cancellation ownership, and no request-time model load.
- **Key technique/insight**: Define capacity in tokens, rows, UTF-8 bytes, queued jobs, retained result bytes, and in-flight calls. Give interactive queries priority over background re-embedding and cap batch assembly delay. Measure time-to-ready, first-query latency, warm p50/p95, throughput, peak device memory, tokenization cost, and shutdown behavior.
- **Applicability to our problem**: Extend existing Synapse limits instead of copying a cloud scheduler. Run a small batch-size and token-budget sweep on the exact model and target GPU. Reject or defer overload at the existing admission boundary.
- **Caveats**: Vendor defaults are not portable. A single-user workload may never create enough concurrent work for dynamic batching to help. Worst-case sequence and batch shapes, not average requests, must fit the declared memory envelope.

**Finding 12: Model migration should use parallel immutable spaces, explicit activation, and reversible lazy re-embedding**

- **Source**: Qdrant named-vector documentation, <https://qdrant.tech/documentation/concepts/vectors/>; Elasticsearch alias documentation, <https://www.elastic.co/docs/manage-data/data-store/aliases>; Elasticsearch reindex examples, <https://www.elastic.co/docs/reference/elasticsearch/rest-apis/reindex-indices>; Magic Context embedding identity, <https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/packages/plugin/src/features/magic-context/memory/embedding-identity.ts#L18-L68>.
- **Source credibility**: High for implemented storage mechanisms and local identity code.
- **Evidence strength**: 3/5 — implemented parallel-space and logical-target patterns.
- **Summary**: Qdrant allows separate named vector spaces with different dimensions, distances, and generating models to coexist and be managed independently. Elasticsearch aliases separate a logical read target from physical indices during reindexing. The transferable invariant is that stored vectors are never reinterpreted under a new model and activation changes explicitly.
- **Key technique/insight**: Certify a candidate, create a distinct shadow identity, embed the judged corpus and a bounded real-project sample, run gates, then activate that identity for new writes. Backfill old content lazily, retain the previous identity for rollback, and expose per-identity migration state.
- **Applicability to our problem**: Existing model IDs, generation checks, shadow lanes, lazy backfill, and lexical gap coverage already implement the stronger local form. GPU work should reuse them. Rollback should change active identity, not rewrite vectors.
- **Caveats**: Qdrant and Elasticsearch are larger systems and do not prescribe Magic Context's exact cutover policy. The project must define retention grace, activation authority, and completion observability. Cosine scores from different spaces must never be fused directly.

**Finding 13: Drift monitoring should trigger new judgments, not silently retrain or swap models**

- **Source**: Google Cloud, “MLOps: Continuous delivery and automation pipelines in machine learning,” <https://cloud.google.com/architecture/mlops-continuous-delivery-and-automation-pipelines-in-machine-learning>.
- **Source credibility**: Moderate for general MLOps practice; **WEAK** for retrieval-specific or local single-user policy because the source is broad cloud guidance.
- **Evidence strength**: 2/5 — credible practice; **WEAK** as direct evidence for embedding retrieval.
- **Summary**: The guidance distinguishes scheduled retraining, retraining on new labels, performance degradation, and feature-distribution change. For retrieval without continuous labels, embedding or query-distribution drift is only a warning. It does not prove quality improved or degraded.
- **Key technique/insight**: Separate continuous operational monitoring from periodic judged quality evaluation. Operational anomalies trigger a benchmark and judgment cycle; they do not authorize automatic model replacement.
- **Applicability to our problem**: Monitor model and execution identity, certification, stage latency, truncation, admission rejection, GPU memory high-water mark, fallback reason, re-embedding coverage, and active/shadow result overlap. Quality comes from rerunning the frozen corpus and adding reviewed failures or disagreement cases. Any change to weights, tokenizer, templates, pooling, dimension, quantization, execution profile, chunking, fusion, or reranker must trigger the gate.
- **Caveats**: No cited source defines retrieval-specific drift thresholds for this workload. Query logging should remain local, bounded, redacted where possible, and opt-in. Vector-distribution change alone must not become a default-swap signal.

**Finding 14: Offline delivery needs revision pinning, artifact review, and license retention**

- **Source**: Hugging Face Hub revision-pinning documentation, <https://huggingface.co/docs/huggingface_hub/en/guides/download>; Hugging Face pickle-security documentation, <https://huggingface.co/docs/hub/en/security-pickle>; TEI air-gapped/local-model documentation, <https://raw.githubusercontent.com/huggingface/text-embeddings-inference/main/README.md>; candidate model cards and APIs, <https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/raw/main/README.md>, <https://huggingface.co/BAAI/bge-small-en-v1.5/raw/main/README.md>, <https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/raw/main/README.md>, <https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/raw/main/README.md>, <https://huggingface.co/BAAI/bge-m3/raw/main/README.md>, <https://huggingface.co/Alibaba-NLP/gte-modernbert-base/raw/main/README.md>; Synapse bundle contract, <https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/docs/synapse-model-bundle.md#L118-L174>.
- **Source credibility**: High for first-party distribution mechanics, security warnings, producer metadata, and local bundle behavior.
- **Evidence strength**: 3/5 — implemented delivery mechanisms and directly inspectable artifact metadata.
- **Summary**: Hugging Face supports full commit-hash pinning rather than mutable branch retrieval. Its security documentation warns that pickle can execute arbitrary code and that repository scanning is not foolproof. TEI accepts local directories and supports air-gapped deployment. Current model metadata declares Apache-2.0 for MiniLM, Nomic, Qwen3, and GTE, and MIT for BGE-small and BGE-M3.
- **Key technique/insight**: Fetch reviewed artifacts from a pinned revision, hash every byte, retain licenses and notices, avoid remote-code execution, and certify offline artifacts before use. Prefer ONNX or safetensors inputs over executable serialization formats.
- **Applicability to our problem**: Existing immutable Synapse bundles and network-disabled release smoke implement most of this pattern. Candidate bundles should record source URL, full revision, hashes, model contract, license files, and native runtime identity. Remote OpenAI-compatible providers should remain explicit opt-in because project memory and code may be private.
- **Caveats**: A model-card license field is not a complete redistribution audit of weights, tokenizer assets, bundled code, or training-data restrictions. This report is not legal approval. Every release still needs artifact-level license review and retained notices.

## 3. Structured Evidence Summary

```json
[
  {
    "id": "F1",
    "claim": "Use public benchmarks to shortlist models and the repository's judged corpus to select them.",
    "source_url": "https://arxiv.org/html/2210.07316",
    "source_title": "MTEB: Massive Text Embedding Benchmark",
    "evidence_strength": 4,
    "credibility_tier": "High",
    "applicability": "Directly supports in-domain model gating; the current 11-query holdout still needs broader independent judgments and pooled hard negatives."
  },
  {
    "id": "F2",
    "claim": "Prefer offline replay into shadow spaces; online interleaving requires sufficient traffic and a meaningful feedback signal.",
    "source_url": "https://www.microsoft.com/en-us/research/publication/large-scale-validation-and-analysis-of-interleaved-search-evaluation/",
    "source_title": "Large Scale Validation and Analysis of Interleaved Search Evaluation",
    "evidence_strength": 5,
    "credibility_tier": "High",
    "applicability": "Strong method evidence but limited transfer to a sparse, private, single-user local workload."
  },
  {
    "id": "F3",
    "claim": "Keep lexical retrieval beside dense retrieval for exact code and memory terms, and evaluate the fused path.",
    "source_url": "https://github.blog/engineering/architecture-optimization/the-technology-behind-githubs-new-code-search/",
    "source_title": "The technology behind GitHub's new code search",
    "evidence_strength": 5,
    "credibility_tier": "High",
    "applicability": "Exact symbols, paths, errors, and directives need lexical coverage while paraphrased memory benefits from dense retrieval."
  },
  {
    "id": "F4",
    "claim": "Query and document instructions, pooling, normalization, truncation, and dimensional projection belong to embedding-space identity.",
    "source_url": "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/raw/main/README.md",
    "source_title": "nomic-embed-text-v1.5 model card",
    "evidence_strength": 3,
    "credibility_tier": "High",
    "applicability": "Directly requires purpose-aware templates and identity changes for every model-affecting transformation."
  },
  {
    "id": "F5",
    "claim": "Benchmark chunking jointly with model limits and verify the effective MiniLM truncation boundary.",
    "source_url": "https://learn.microsoft.com/en-us/azure/search/vector-search-how-to-chunk-documents",
    "source_title": "Chunk documents for RAG and vector search in Azure AI Search",
    "evidence_strength": 4,
    "credibility_tier": "Moderate",
    "applicability": "Requires both equal-input and model-native tracks; Azure's concrete starting values are not treated as universal."
  },
  {
    "id": "F6",
    "claim": "Measure first-stage Recall@50 separately from final nDCG@10 and end-to-end latency when reranking is present.",
    "source_url": "https://www.sbert.net/examples/sentence_transformer/applications/retrieve_rerank/README.html",
    "source_title": "Sentence Transformers Retrieve and Re-Rank",
    "evidence_strength": 3,
    "credibility_tier": "High",
    "applicability": "Maps directly onto the repository's existing Recall@50 and nDCG@10 metrics while preventing rerankers from hiding recall loss."
  },
  {
    "id": "F7",
    "claim": "Retain MiniLM, BGE-small, Nomic 256/512, GTE-ModernBERT, Qwen3 256/512, and experimental BGE-M3 as tiered candidates without preselecting a winner.",
    "source_url": "https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/raw/main/README.md",
    "source_title": "Qwen3-Embedding-0.6B model card",
    "evidence_strength": 3,
    "credibility_tier": "High",
    "applicability": "Supports a cost-ordered campaign; in-domain quality and local resource use remain unproven until measured."
  },
  {
    "id": "F8",
    "claim": "Keep the simple CPU-local lane as baseline and use Synapse for certified or heavier models.",
    "source_url": "https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/docs/synapse-model-bundle.md",
    "source_title": "Synapse Model Bundle Operations",
    "evidence_strength": 3,
    "credibility_tier": "High",
    "applicability": "Constraint-driven division of roles that reuses existing implementation and avoids a second model registry or lifecycle."
  },
  {
    "id": "F9",
    "claim": "External embedding servers transfer useful controls but add unjustified operations unless isolation, shared clients, or batching is measured to help.",
    "source_url": "https://raw.githubusercontent.com/huggingface/text-embeddings-inference/main/README.md",
    "source_title": "Hugging Face Text Embeddings Inference README",
    "evidence_strength": 3,
    "credibility_tier": "Moderate",
    "applicability": "Use server systems as benchmark adapters or later isolation options, not as the default local architecture without measured benefit."
  },
  {
    "id": "F10",
    "claim": "Start GPU support with one startup-selected Linux NVIDIA CUDA ORT profile and a separately identified CPU fallback.",
    "source_url": "https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html",
    "source_title": "ONNX Runtime CUDA Execution Provider",
    "evidence_strength": 3,
    "credibility_tier": "High",
    "applicability": "Smallest coherent extension of the certified Synapse lane; actual target hardware and compatibility tuple remain to be selected."
  },
  {
    "id": "F11",
    "claim": "Bound GPU admission by tokens, rows, bytes, jobs, retained results, and in-flight calls; benchmark cold start and steady state.",
    "source_url": "https://huggingface.co/docs/text-embeddings-inference/en/cli_arguments",
    "source_title": "Text Embeddings Inference CLI arguments",
    "evidence_strength": 3,
    "credibility_tier": "Moderate",
    "applicability": "Transfers token-aware batching and backpressure while retaining the repository's one-permit and bounded-job design."
  },
  {
    "id": "F12",
    "claim": "Migrate through parallel immutable spaces, explicit activation, lazy re-embedding, and reversible rollback without cross-space scoring.",
    "source_url": "https://qdrant.tech/documentation/concepts/vectors/",
    "source_title": "Qdrant Vectors and Named Vectors",
    "evidence_strength": 3,
    "credibility_tier": "High",
    "applicability": "Matches existing model IDs, generations, shadow lanes, and lexical gap coverage."
  },
  {
    "id": "F13",
    "claim": "Use operational drift as a trigger for new evaluation, not automatic model replacement.",
    "source_url": "https://cloud.google.com/architecture/mlops-continuous-delivery-and-automation-pipelines-in-machine-learning",
    "source_title": "MLOps: Continuous delivery and automation pipelines in machine learning",
    "evidence_strength": 2,
    "credibility_tier": "Moderate; WEAK for retrieval-specific policy",
    "applicability": "Useful as a monitoring frame only; Magic Context needs judged retrieval evidence before any model swap."
  },
  {
    "id": "F14",
    "claim": "Deliver local models from pinned revisions as reviewed, hashed offline bundles with retained license notices and no remote-code execution.",
    "source_url": "https://huggingface.co/docs/huggingface_hub/en/guides/download",
    "source_title": "Hugging Face Hub download files and revision pinning",
    "evidence_strength": 3,
    "credibility_tier": "High",
    "applicability": "Directly extends the immutable Synapse bundle and network-disabled release smoke; legal review remains required."
  }
]
```

## 4. Patterns & Consensus

Across peer-reviewed benchmarks, production code search, model cards, and serving systems, five patterns recur.

First, retrieval quality is distribution-specific. MTEB, BEIR, CodeSearchNet, and CoIR broaden evaluation precisely because one task or domain does not predict another. Magic Context's benchmark-gated default aligns with this consensus. Public leaderboards can remove implausible candidates, but they should not select the default.

Second, the encoder is only one component of a retrieval system. Exact lexical retrieval, chunking, query/document transformations, candidate depth, fusion, and reranking all affect outcomes. Campaigns should freeze those components when asking a model question, then vary them deliberately in later experiments. “Best embedding model” without a fixed retrieval pipeline is not a well-formed decision.

Third, vector space is a full execution contract. Producer instructions, output selection, pooling, normalization, dimensions, quantization, truncation, model bytes, and runtime profile can change vectors. The repository's fingerprint and generation model is stricter than many serving APIs and should remain authoritative.

Fourth, maintained serving systems bound work by tokens and admission, pin one model or revision per serving instance, and separate cold-start loading from request handling. Their multi-tenant scaling features do not automatically transfer to a local tool. The transferable subset is immutable startup configuration, one loaded model, token-aware batches, explicit backpressure, observability, and deterministic failure behavior.

Fifth, migrations preserve old and new representations in parallel until activation and rollback are safe. Magic Context's distinct identities, shadow spaces, lazy backfill, lexical gap coverage, and grace-period cleanup already match this pattern. GPU support should extend that machinery, not introduce hardware tiers that obscure model or execution identity.

## 5. Disagreements & Open Questions

1. **Effective MiniLM context limit.** Repository code allows 512 tokens, while the upstream model card says 256 wordpieces by default. The Xenova conversion may carry different tokenizer configuration. A direct sensitivity probe on exact installed artifacts is required.

2. **Judgment-set breadth.** The holdout has 11 queries. No source provides a universal minimum. The decision question is whether candidate ordering remains stable after adding independent cases and pooled hard negatives. Three execution runs do not answer sampling uncertainty.

3. **CPU feasibility of Qwen3-0.6B.** It is much larger than current local candidates, but public parameter count does not establish local latency. A bounded CPU run remains useful as an execution control before attributing a GPU result to hardware.

4. **BGE-M3 treatment.** Its distinguishing architecture includes dense, sparse, and multi-vector output. Dense-only evaluation is easy but incomplete. A full treatment needs additional index and fusion work and should remain experimental unless evidence justifies it.

5. **Reranker scope.** External evidence supports retrieve-and-rerank pipelines, but no evidence shows that this 22-document corpus or a typical project needs one. Measure the encoder gap first. Add a reranker only when candidate recall is healthy and top-order quality remains the limiting error.

6. **GPU equivalence policy.** CPU and CUDA kernels can differ numerically. The project must decide whether two certified executions count as one space under a measured tolerance or always use distinct identities. **WEAK:** no source establishes a safe universal tolerance; use corpus certification plus worst-case similarity and ranking-stability tests.

7. **Exact first GPU hardware floor.** ORT documents CUDA compatibility, and NIM publishes model-specific profiles, but the repository has not named a target GPU. Forge the bundle and capacity contract against an actual card, driver, CUDA/cuDNN tuple, and VRAM budget.

8. **Online feedback.** Interleaving is supported at commercial search scale, but Magic Context lacks a dense, unambiguous click signal. **WEAK applicability:** local judged replay is preferable unless product behavior changes.

9. **License completeness.** Declared Apache-2.0 and MIT metadata is encouraging, but redistribution still needs artifact-level review and retained notices. This report does not provide legal approval.

## 6. Recommended Reading

Start with the MTEB and BEIR papers for why model choice must remain task-specific: <https://arxiv.org/html/2210.07316> and <https://arxiv.org/html/2104.08663>. Add CodeSearchNet and CoIR for code-retrieval judgment design and task diversity: <https://arxiv.org/html/1909.09436> and <https://arxiv.org/html/2407.02883>.

For retrieval architecture, read GitHub's exact code-search design, Anthropic's scoped hybrid experiment, Vespa's reproducible hybrid tutorial, and Sentence Transformers' retrieve-and-rerank guide: <https://github.blog/engineering/architecture-optimization/the-technology-behind-githubs-new-code-search/>, <https://www.anthropic.com/news/contextual-retrieval>, <https://docs.vespa.ai/en/learn/tutorials/hybrid-search.html>, and <https://www.sbert.net/examples/sentence_transformer/applications/retrieve_rerank/README.html>.

For candidate execution contracts, read each producer model card rather than relying on leaderboard summaries: <https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/raw/main/README.md>, <https://huggingface.co/BAAI/bge-small-en-v1.5/raw/main/README.md>, <https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/raw/main/README.md>, <https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/raw/main/README.md>, <https://huggingface.co/BAAI/bge-m3/raw/main/README.md>, and <https://huggingface.co/Alibaba-NLP/gte-modernbert-base/raw/main/README.md>.

For serving and GPU mechanics, prioritize TEI's admission controls and ONNX Runtime's provider and I/O documentation: <https://huggingface.co/docs/text-embeddings-inference/en/cli_arguments>, <https://onnxruntime.ai/docs/execution-providers/>, <https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html>, and <https://onnxruntime.ai/docs/performance/tune-performance/iobinding.html>. Read vLLM, Infinity, and NIM as alternative runtime references, not superiority evidence: <https://docs.vllm.ai/en/stable/models/pooling_models/>, <https://raw.githubusercontent.com/michaelfeil/infinity/main/README.md>, and <https://docs.nvidia.com/nim/nemo-retriever/text-embedding/latest/support-matrix.html>.

For rollout and offline delivery, use Qdrant named vectors, Elasticsearch aliases, Hugging Face revision pinning, and the pickle-security warning: <https://qdrant.tech/documentation/concepts/vectors/>, <https://www.elastic.co/docs/manage-data/data-store/aliases>, <https://huggingface.co/docs/huggingface_hub/en/guides/download>, and <https://huggingface.co/docs/hub/en/security-pickle>.

</details>

<details>
<summary>Phase 2: Full Synthesis</summary>

# Research Synthesis

This synthesis cross-references the five reports dated 2026-08-23. It does not select an optimal model. Public benchmarks and model cards support candidate admission and artifact contracts; only Magic Context's judged retrieval benchmark can support promotion.

## Evidence Inventory

### Scoring method

Evidence strength uses the reports' 0-5 scale. Fractional labels such as `3/5` are normalized to their leading number. Credibility multipliers are High = 1.0, Moderate = 0.8, Low = 0.5, and Suspect = 0.1. Applicability is classified here as High = 1.0, Medium = 0.7, and Low = 0.4. Corroboration is the number of independent agents supporting the merged claim, including narrative support. Technique score is:

`best evidence strength × best credibility multiplier × applicability multiplier × agent corroboration count`

Strength-0 claims remain in the inventory but are excluded from ranking. A high score ranks support for a technique or constraint, not a model's quality on Magic Context.

| ID | Merged claim | Source URLs | Agents (count) | Best strength | Best credibility | Applicability | Score |
|---|---|---|---:|---:|---|---|---:|
| EI-01 | Dense retrieval quality depends on the learned query-document relation and negative distribution, so the retrieval recipe matters beyond the model name. | [DPR](https://aclanthology.org/2020.emnlp-main.550/) | A1 (1), single-agent | 4 | High | Medium | 2.80 |
| EI-02 | Query/document instructions, pooling, padding, masking, truncation, output selection, dimension reduction, quantization, and normalization are part of semantic-space identity. | [E5](https://arxiv.org/abs/2212.09741); [FastEmbed Qwen3](https://docs.rs/fastembed/6.0.0/src/fastembed/models/qwen3.rs.html); [Qwen3 pinned tree](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/tree/97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3); [Nomic card](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/raw/main/README.md); [ORT CUDA](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html); [ORT TensorRT](https://onnxruntime.ai/docs/execution-providers/TensorRT-ExecutionProvider.html); [ORT build](https://onnxruntime.ai/docs/build/eps.html); [Qwen3 pinned card](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/blob/97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3/README.md); [ONNX external data](https://onnx.ai/onnx/repo-docs/ExternalData.html) | A1,A2,A3,A4,A5 (5) | 4 | High | High | 20.00 |
| EI-03 | MiniLM, BGE, Nomic, and Qwen need different exact pooling and post-processing recipes; generic mean pooling is invalid for several candidates. | [Nomic](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5); [Nomic pinned](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/blob/e9b6763023c676ca8431644204f50c2b100d9aab/README.md); [Qwen3 pinned](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/blob/97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3/README.md) | A1,A3,A4 (3) | 3 | High | High | 9.00 |
| EI-04 | Exact symbols, paths, errors, and directives require a lexical or sparse control beside dense retrieval; hybrid evaluation must remain separate from dense-model selection. | [BEIR: A Heterogeneous Benchmark for Zero-shot Evaluation of Information Retrieval Models](https://arxiv.org/abs/2104.08663); [The technology behind GitHub's new code search](https://github.blog/engineering/architecture-optimization/the-technology-behind-githubs-new-code-search/) | A1,A5 (2) | 5 | High | High | 10.00 |
| EI-05 | Cross-task leaderboards nominate candidates but do not establish the Magic Context winner. | [MTEB: Massive Text Embedding Benchmark](https://aclanthology.org/2023.eacl-main.148/); [CoIR: A Comprehensive Benchmark for Code Information Retrieval Models](https://aclanthology.org/2025.acl-long.1072/); [MTEB: Massive Text Embedding Benchmark](https://arxiv.org/html/2210.07316) | A1,A2,A3,A4,A5 (5) | 4 | High | High | 20.00 |
| EI-06 | CodeSearchNet and CoIR do not cover the full project-memory workload, and candidate contamination status is unknown. | [CoIR](https://arxiv.org/abs/2407.02883) | A1 (1), single-agent | 3 | Moderate | Medium | 1.68 |
| EI-07 | Dimension truncation is valid only for a documented Matryoshka-trained model with the exact operation order; every model-dimension pair is a separate candidate. | [MRL](https://papers.nips.cc/paper_files/paper/2022/hash/c32319f4868da7613d78af9993100e42-Abstract-Conference.html); [Nomic pinned](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/blob/e9b6763023c676ca8431644204f50c2b100d9aab/README.md); [Qwen3 pinned](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/blob/97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3/README.md) | A1,A2,A3,A4 (4) | 4 | High | High | 16.00 |
| EI-08 | Model, output, and index quantization can change rankings; precision and calibration digest define a separate candidate. | [ORT quantization](https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html); [Nomic pinned](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/blob/e9b6763023c676ca8431644204f50c2b100d9aab/README.md) | A1,A3 (2) | 3 | High | High | 6.00 |
| EI-09 | The small judged holdout is useful for rejection and coarse regression detection, but it cannot reliably rank close variants or support broad optimality claims. | [NIST topic-set summary](https://www.nist.gov/publications/effect-topic-set-size-retrieval-experiment-error); [SIGIR topic-set study](https://doi.org/10.1145/564376.564432) | A1,A2,A3,A5 (4) | 4 | High | High | 16.00 |
| EI-10 | Equal dimensions and normalization do not make independently learned spaces comparable; cross-space scoring must never occur silently. | [MRL](https://papers.nips.cc/paper_files/paper/2022/hash/c32319f4868da7613d78af9993100e42-Abstract-Conference.html); [Qdrant vectors](https://qdrant.tech/documentation/concepts/vectors/) | A1,A3,A4,A5 (4) | 4 | High | High | 16.00 |
| EI-11 | The smallest supported GPU direction is one startup-selected Linux NVIDIA CUDA ORT lane with pinned provider/runtime identity and fail-closed registration. | [ORT execution providers](https://onnxruntime.ai/docs/execution-providers/); [ORT CUDA requirements](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html#requirements); [ORT CUDA](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html) | A1,A2,A3,A4,A5 (5) | 3 | High | High | 15.00 |
| EI-12 | Synapse's immutable bundle, certification, exact runtime identity, and one-permit admission make it the existing home for a certified GPU lane; the TypeScript MiniLM lane remains the portable control. | [reported Synapse link, broken](https://github.com/cortexkit/magic-context/blob/main/docs/synapse-model-bundle.md); [reported pinned Synapse link, broken](https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/docs/synapse-model-bundle.md) | A2,A3,A4,A5 (4) | 3 | High | High | 12.00 |
| EI-13 | The incumbent is the exact Xenova fp32 ONNX/tokenizer recipe with mean pooling, normalization, and a 512-token application ceiling, not a generic upstream MiniLM run; upstream documents 256 word pieces. | [Xenova metadata](https://huggingface.co/api/models/Xenova/all-MiniLM-L6-v2?blobs=true); [MiniLM pinned config](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/blob/1110a243fdf4706b3f48f1d95db1a4f5529b4d41/sentence_bert_config.json) | A2,A3,A5 (3) | 3 | High | High | 9.00 |
| EI-14 | GTE ModernBERT 768 and Arctic Embed m v1.5 at 256/768 are well-supported extra CPU ONNX treatments, but neither is an in-domain winner. | [GTE card](https://huggingface.co/Alibaba-NLP/gte-modernbert-base) | A2,A5 (2) | 3 | High | High | 6.00 |
| EI-15 | Jina v2 base code is directly ONNX-deployable; CodeRankEmbed remains an export-and-parity experiment. | [Jina v2 code](https://huggingface.co/jinaai/jina-embeddings-v2-base-code) | A2 (1), single-agent | 3 | Moderate | Medium | 1.68 |
| EI-16 | One report orders the larger-model ladder as Arctic l v2.0, Qwen3 0.6B, then Qwen3 4B; other reports favor Qwen3 as the main quality candidate, so this ordering is not consensus. | [Qwen3 0.6B](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B) | A2 (1), single-agent | 3 | High | Medium | 2.10 |
| EI-17 | EmbeddingGemma is technically viable at truncated dimensions but is blocked by Gemma licensing review and community-only ONNX provenance. | [EmbeddingGemma card](https://ai.google.dev/gemma/docs/embeddinggemma/model_card) | A2 (1), single-agent | 3 | High | Low | 1.20 |
| EI-18 | BGE-M3's differentiator is dense, sparse, and multi-vector retrieval; dense-only use is experimental and the hybrid form is a separate architecture project. | [BGE-M3](https://huggingface.co/BAAI/bge-m3) | A1,A2,A4,A5 (4) | 3 | High | High | 12.00 |
| EI-19 | Weight-only arithmetic is an early feasibility floor, not deployment RSS or VRAM; it keeps Qwen3 4B out of the CPU lane. | [Qwen3 4B metadata](https://huggingface.co/api/models/Qwen/Qwen3-Embedding-4B?blobs=true) | A2 (1), single-agent | 3 | High | High | 3.00 |
| EI-20 | FastEmbed's `cuda` feature selects Candle implementations; ONNX CUDA requires the shared `ort/cuda` feature and explicit execution-provider injection. | [FastEmbed features](https://docs.rs/crate/fastembed/6.0.0/features); [ort features](https://docs.rs/crate/ort/2.0.0-rc.13/features) | A2,A4 (2) | 3 | High | High | 6.00 |
| EI-21 | ORT exposes several provider wrappers, but first-release breadth across TensorRT, MIGraphX, DirectML, CoreML, TEI, Infinity, and vLLM is not justified without measured need. | [ORT TensorRT](https://onnxruntime.ai/docs/execution-providers/TensorRT-ExecutionProvider.html); [ort EP module](https://docs.rs/ort/2.0.0-rc.13/ort/ep/index.html); [ORT ROCm](https://onnxruntime.ai/docs/execution-providers/ROCm-ExecutionProvider.html); [Burn](https://github.com/tracel-ai/burn); [tch-rs](https://github.com/LaurentMazare/tch-rs); [mistral.rs](https://docs.mistralrs.dev/reference/supported-models/); [llama.cpp embedding](https://github.com/ggml-org/llama.cpp/blob/master/examples/embedding/README.md) | A2,A4,A5 (3) | 3 | High | Medium | 6.30 |
| EI-22 | Mutable model names can resolve to changed artifacts; release bundles must pin revisions, hash all consumed files, retain license notices, and avoid runtime download or remote-code execution. | [HF revision pinning](https://huggingface.co/docs/huggingface_hub/en/guides/download#from-specific-version); [HF download guide](https://huggingface.co/docs/huggingface_hub/en/guides/download) | A3,A5 (2) | 3 | High | High | 6.00 |
| EI-23 | CPU, CUDA, and TensorRT may produce numerically different vectors; semantic aliasing requires explicit real-hardware certification while execution identities remain distinct. | [TensorRT precision](https://docs.nvidia.com/deeplearning/tensorrt/latest/inference-library/precision-control.html#algorithm-selection-and-reproducible-builds); [ORT CUDA](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html); [ORT TensorRT](https://onnxruntime.ai/docs/execution-providers/TensorRT-ExecutionProvider.html); [ORT build](https://onnxruntime.ai/docs/build/eps.html); [Qwen3 pinned](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/blob/97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3/README.md); [ONNX external data](https://onnx.ai/onnx/repo-docs/ExternalData.html) | A1,A2,A3,A4,A5 (5) | 3 | High | High | 15.00 |
| EI-24 | Default ORT provider partitioning can silently place unsupported GPU operators on CPU; provider registration alone does not prove full GPU execution. | [ORT provider API](https://onnxruntime.ai/docs/execution-providers/#apis-for-execution-provider) | A2,A3,A4,A5 (4) | 3 | High | High | 12.00 |
| EI-25 | ORT, CUDA, cuDNN, driver, architecture, and provider libraries form one startup compatibility unit; strict registration and native closure are application obligations. | [ORT CUDA requirements](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html#requirements); [ort EP API](https://docs.rs/ort/2.0.0-rc.13/ort/ep/index.html); [ort CUDA source](https://docs.rs/ort/2.0.0-rc.13/src/ort/ep/cuda.rs.html); [ORT build](https://onnxruntime.ai/docs/build/eps.html) | A2,A3,A4 (3) | 3 | High | High | 9.00 |
| EI-26 | TensorRT engine builds, caches, and dynamic-shape profiles can cause cold-start and request-path latency cliffs. | [ORT TensorRT caches](https://onnxruntime.ai/docs/execution-providers/TensorRT-ExecutionProvider.html#tensorrt-ep-caches) | A2,A3,A4,A5 (4) | 3 | Moderate | Medium | 6.72 |
| EI-27 | `gpu_mem_limit` bounds only an ORT provider arena, not total VRAM; admission and soak tests must cover complete process memory and multi-session behavior. | [ORT CUDA gpu_mem_limit](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html#gpu_mem_limit); [TEI CLI](https://huggingface.co/docs/text-embeddings-inference/en/cli_arguments) | A3,A4,A5 (3) | 3 | Moderate | High | 7.20 |
| EI-28 | Run cancellation is not proof of bounded GPU kernel preemption and must not release session or buffer ownership early. | [ORT RunOptions source](https://github.com/microsoft/onnxruntime/blob/4d308dacbbb385fcba9911cd9c07f5603d65cbd6/onnxruntime/core/framework/run_options.cc) | A3,A4 (2) | 2 | High | High | 4.00 |
| EI-29 | Repeated prompt, dimension, precision, or shortlist adaptation to holdout outcomes contaminates the private holdout. | [Adaptive data analysis](https://doi.org/10.1126/science.aaa9375) | A1,A2,A3,A5 (4) | 4 | High | High | 16.00 |
| EI-30 | Model conversion is a supply-chain and licensing boundary because remote code, pickle, mutable revisions, and mixed tokenizer/model inputs can enter a nominally offline bundle. | [Transformers custom models](https://huggingface.co/docs/transformers/en/models#custom-models); [HF download guide](https://huggingface.co/docs/huggingface_hub/en/guides/download) | A2,A3,A4,A5 (4) | 3 | High | High | 12.00 |
| EI-31 | FastEmbed user-defined ONNX models expose bundle inputs and provider injection, but not the lower-level session/run controls needed for every GPU policy. | [FastEmbed init](https://docs.rs/fastembed/6.0.0/src/fastembed/text_embedding/init.rs.html); [FastEmbed implementation](https://docs.rs/fastembed/6.0.0/src/fastembed/text_embedding/impl.rs.html); [FastEmbed common](https://docs.rs/fastembed/6.0.0/src/fastembed/common.rs.html); [FastEmbed output](https://docs.rs/fastembed/6.0.0/src/fastembed/text_embedding/output.rs.html) | A2,A4 (2) | 3 | High | High | 6.00 |
| EI-32 | One serialized ORT session matches current guidance; I/O binding, cancellation plumbing, and multiple sessions are not yet justified. | [ort session](https://docs.rs/ort/2.0.0-rc.13/src/ort/session/mod.rs.html); [ort I/O binding](https://docs.rs/ort/2.0.0-rc.13/src/ort/session/io_binding.rs.html); [ort run options](https://docs.rs/ort/2.0.0-rc.13/src/ort/session/run_options.rs.html); [ORT I/O binding](https://onnxruntime.ai/docs/performance/tune-performance/iobinding.html) | A4 (1), single-agent | 3 | High | High | 3.00 |
| EI-33 | BGE-small's CLS-plus-normalize contract is the lowest-semantic-risk challenger for the existing FastEmbed/Synapse lane. | [FastEmbed common](https://docs.rs/fastembed/6.0.0/src/fastembed/common.rs.html); [FastEmbed README](https://raw.githubusercontent.com/Anush008/fastembed-rs/v6.0.0/README.md); [BGE-small pinned](https://huggingface.co/BAAI/bge-small-en-v1.5/blob/5c38ec7c405ec4b44b94cc5a9bb96e735b38267a/README.md); [BGE-M3 pinned](https://huggingface.co/BAAI/bge-m3/blob/5617a9f61b028005a4858fdac845db406aefb181/README.md) | A2,A4,A5 (3) | 3 | High | High | 9.00 |
| EI-34 | FastEmbed's Candle Qwen3 implementation proves Rust feasibility but is not a drop-in strict local bundle loader. | [FastEmbed features](https://docs.rs/crate/fastembed/6.0.0/features); [FastEmbed Qwen3 source](https://docs.rs/crate/fastembed/6.0.0/source/src/models/qwen3.rs); [FastEmbed Qwen3 test](https://docs.rs/crate/fastembed/6.0.0/source/tests/qwen3.rs); [Candle installation](https://huggingface.github.io/candle/guide/installation.html) | A2,A4 (2) | 3 | High | Medium | 4.20 |
| EI-35 | A pinned air-gapped TEI sidecar is the best-supported alternate Qwen3 benchmark/runtime treatment, but it is not justified as the first local production GPU lane. | [TEI docs](https://huggingface.co/docs/text-embeddings-inference/index); [TEI supported models](https://huggingface.co/docs/text-embeddings-inference/supported_models); [TEI pinned README](https://github.com/huggingface/text-embeddings-inference/blob/0d124dc9773be6ac5a9a57d8439aba9bbbf33273/README.md); [TEI HTTP types](https://github.com/huggingface/text-embeddings-inference/blob/0d124dc9773be6ac5a9a57d8439aba9bbbf33273/router/src/http/types.rs); [TEI server](https://github.com/huggingface/text-embeddings-inference/blob/0d124dc9773be6ac5a9a57d8439aba9bbbf33273/router/src/http/server.rs) | A2,A4,A5 (3) | 3 | High | Medium | 6.30 |
| EI-36 | The risk-ordered benchmark matrix must retain MiniLM and existing floor candidates and may add well-supported treatments; no report establishes a winner. | [FastEmbed README](https://raw.githubusercontent.com/Anush008/fastembed-rs/v6.0.0/README.md); [BGE-small pinned](https://huggingface.co/BAAI/bge-small-en-v1.5/blob/5c38ec7c405ec4b44b94cc5a9bb96e735b38267a/README.md); [Nomic pinned](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/blob/e9b6763023c676ca8431644204f50c2b100d9aab/README.md); [Qwen3 pinned](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/blob/97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3/README.md); [BGE-M3 pinned](https://huggingface.co/BAAI/bge-m3/blob/5617a9f61b028005a4858fdac845db406aefb181/README.md); [Qwen3 current card](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/raw/main/README.md) | A1,A2,A4,A5 (4) | 3 | High | High | 12.00 |
| EI-37 | Offline paired replay into immutable shadow spaces is more applicable than online interleaving for a sparse, private, single-user workload. | [Microsoft interleaving study](https://www.microsoft.com/en-us/research/publication/large-scale-validation-and-analysis-of-interleaved-search-evaluation/) | A5 (1), single-agent | 5 | High | Medium | 3.50 |
| EI-38 | Chunking must be benchmarked jointly with model limits, using equal-input and model-native tracks, and the effective MiniLM truncation boundary must be certified. | [Azure chunking guidance](https://learn.microsoft.com/en-us/azure/search/vector-search-how-to-chunk-documents) | A1,A2,A5 (3) | 4 | Moderate | High | 9.60 |
| EI-39 | When reranking is present, report first-stage Recall@50 separately from final nDCG@10 and end-to-end latency. | [Sentence Transformers retrieve-rerank](https://www.sbert.net/examples/sentence_transformer/applications/retrieve_rerank/README.html) | A5 (1), single-agent | 3 | High | High | 3.00 |
| EI-40 | External embedding servers can transfer useful controls but add unjustified operations unless batching, isolation, or shared-client evidence pays for the boundary. | [TEI README](https://raw.githubusercontent.com/huggingface/text-embeddings-inference/main/README.md) | A2,A4,A5 (3) | 3 | Moderate | Low | 2.88 |
| EI-41 | GPU admission must be bounded by rows, tokens, bytes, jobs, retained results, and in-flight calls, with cold-start and steady-state measurements. | [TEI CLI](https://huggingface.co/docs/text-embeddings-inference/en/cli_arguments) | A2,A3,A4,A5 (4) | 3 | High | High | 12.00 |
| EI-42 | Parallel immutable spaces, explicit activation, lazy re-embedding, and reversible rollback are the proposed migration pattern, but the cited Qdrant page does not establish that complete protocol. | [Qdrant vectors](https://qdrant.tech/documentation/concepts/vectors/) | A5 (1), single-agent, under-supported | 0 | Suspect | High | 0.00 |
| EI-43 | Operational drift should trigger a new judged evaluation rather than automatic model replacement. | [Google MLOps](https://cloud.google.com/architecture/mlops-continuous-delivery-and-automation-pipelines-in-machine-learning) | A5 (1) | 2 | Moderate | Low | 0.64 |
| EI-44 | Candidate adapters must apply the literal model-specific query and document transforms before any quality comparison; swapping only model IDs is invalid. | [BGE-small](https://huggingface.co/BAAI/bge-small-en-v1.5); [Nomic](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5); [Arctic m](https://huggingface.co/Snowflake/snowflake-arctic-embed-m-v1.5); [Arctic l](https://huggingface.co/Snowflake/snowflake-arctic-embed-l-v2.0); [Qwen3](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B) | A1,A2,A3,A4,A5 (5) | 3 | High | High | 15.00 |
| EI-45 | Preprocessing should be a versioned host-owned contract selected by query versus document purpose, rather than caller-supplied free-form text. | [FastEmbed Qwen3](https://docs.rs/fastembed/6.0.0/src/fastembed/models/qwen3.rs.html); [Nomic](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5) | A1,A2,A4,A5 (4) | 3 | High | High | 12.00 |
| EI-46 | CPU/GPU alias certification needs structural, componentwise, Unicode/code/truncation, cosine/rank, provider-assignment, and judged-retrieval checks on the exact hardware/runtime tuple. | [ORT CUDA](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html); [ORT execution providers](https://onnxruntime.ai/docs/execution-providers/) | A1,A3,A4 (3) | 3 | High | High | 9.00 |
| EI-47 | Candidate judgments should pool top results from incumbent, challengers, lexical, and fixed hybrid runs, report per-query/category deltas, and expand independent holdout coverage before resolving close candidates. | [MTEB](https://arxiv.org/html/2210.07316); [SIGIR topic-set study](https://doi.org/10.1145/564376.564432) | A1,A2,A3,A5 (4) | 4 | High | High | 16.00 |
| EI-48 | Equal-input and model-native-context tracks are both needed to separate encoder quality from extra-context and chunking effects. | [Azure chunking guidance](https://learn.microsoft.com/en-us/azure/search/vector-search-how-to-chunk-documents) | A2,A5 (2) | 3 | Moderate | Medium | 3.36 |
| EI-49 | GPU operation should keep one active lane, no request-time model switching or download, bounded admission, startup-only explicit fallback, and separate diagnostics identity. | [Synapse report link, broken](https://github.com/cortexkit/magic-context/blob/main/docs/synapse-model-bundle.md); [ORT CUDA](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html) | A2,A3,A4,A5 (4) | 3 | High | High | 12.00 |
| EI-50 | ONNX external data files are part of the model artifact and semantic fingerprint, not optional deployment extras. | [ONNX external data](https://onnx.ai/onnx/repo-docs/ExternalData.html) | A3,A4 (2) | 3 | High | High | 6.00 |

Inventory count: **50 unique merged claims**. All 63 structured claim records map into these rows; EI-44 through EI-50 preserve material narrative-only claims.

## Hallucination Check

The check compared report dates with 2026-08-23, scanned all structured citations, and probed 79 unique structured source URLs. Seventy-four returned a success or redirect. Two returned 404 and three returned 403 to the automated verifier. A 403 is a verification trigger, not evidence that a citation is fabricated or wrong. Only suspicious or unsupported citation/finding instances appear in the exclusion table and receive strength 0.

### Actual exclusions

| Flag | Classification | Claim or citation | Result and ranking action |
|---|---|---|---|
| H-01 | HALLUCINATION RISK | `github.com/cortexkit/magic-context/.../synapse-model-bundle.md` | HTTP 404. Only this citation instance is strength 0. EI-12 and EI-49 survive on local code evidence and independent sources. |
| H-02 | HALLUCINATION RISK | Pinned `github.com/ahrav/magic-context/blob/21bd.../synapse-model-bundle.md` | HTTP 404. Only this citation instance is strength 0. The merged Synapse findings survive on local code evidence and independent sources. |
| H-06 | HALLUCINATION RISK | A1-F10 cites MRL for the broad rule that independently learned spaces are incomparable. | MRL supports dimensional nesting, not the complete broad claim. Only the citation instance is strength 0; EI-10 survives on independent identity and migration evidence. |
| H-07 | HALLUCINATION RISK | A2-F3's structured URL names GTE while the claim also names Arctic m. | The structured citation instance is strength 0 for the Arctic half. Agent 2's narrative supplies the Arctic owner card and metadata, so EI-14 survives. |
| H-08 | HALLUCINATION RISK | A2-F4's structured URL names Jina while the claim also covers CodeRankEmbed. | The structured citation instance is strength 0 for the CodeRank half. Narrative owner metadata and CoRNStack preserve EI-15's conditional experimental status. |
| H-09 | HALLUCINATION RISK | A2-F5's structured URL names Qwen3 0.6B while the claim orders Arctic l and Qwen3 4B too. | The structured citation instance is strength 0 as written. Narrative owner sources preserve artifact facts, while EI-16 remains a contested proposal. |
| H-10 | HALLUCINATION RISK | A2-F12 uses the TensorRT page for a broad rejection of eight providers and servers. | The structured citation instance is strength 0 as written. Provider-specific narrative sources support the narrower first-release deferral in EI-21. |
| H-11 | HALLUCINATION RISK | A3-F05 uses TensorRT reproducibility documentation to generalize across CPU, CUDA, and TensorRT. | The A3 citation instance is strength 0. EI-23 survives at lower confidence through independent runtime-identity and certification evidence. |
| H-12 | HALLUCINATION RISK | A5-F12 cites Qdrant named vectors for explicit activation, lazy re-embedding, and reversible rollback. | The source does not establish the complete protocol. The merged finding EI-42 is strength 0 UNVERIFIED and excluded from ranking. |

### Resolved citation-verification triggers

| Trigger | Citation | Resolution |
|---|---|---|
| VT-01 | `doi.org/10.1126/science.aaa9375` returned HTTP 403 to the automated verifier. | Access failure did not establish a citation defect. Report metadata identifies the reusable-holdout primary paper, and independent report evidence supports the narrower holdout-contamination finding. No exclusion. |
| VT-02 | `doi.org/10.1145/564376.564432` returned HTTP 403 to the automated verifier. | The NIST publication page independently identifies and supports the same topic-set study. No exclusion. |
| VT-03 | Microsoft interleaving study URL returned HTTP 403 to the automated verifier. | The report provides exact title and primary-project URL. EI-37 remains Medium-applicability, single-agent evidence rather than a hallucination finding. No exclusion. |

### Verified single-agent review triggers

| Trigger | Finding | Verification result |
|---|---|---|
| VSA-01 | EI-01, contrastive relation and negatives | Primary ACL source resolved and supports the research claim. Survives, explicitly single-agent. |
| VSA-02 | EI-06, benchmark coverage and unknown contamination | CoIR source resolved for coverage; contamination remains an unknown rather than an asserted fact. Survives, explicitly single-agent. |
| VSA-03 | EI-15, Jina deployability and CodeRank export status | Owner pages resolved; narrative supplies separate sources. Survives, explicitly single-agent. |
| VSA-04 | EI-16, Arctic/Qwen GPU ladder | Artifact facts resolve, but ordering is judgment rather than source fact. Survives only as a contested proposal. |
| VSA-05 | EI-17, EmbeddingGemma feasibility and gates | Owner card resolved. Community-export and legal gates remain explicit. Survives, explicitly single-agent. |
| VSA-06 | EI-19, weight lower bounds | Qwen metadata resolved and arithmetic is reproducible. Survives, explicitly single-agent. |
| VSA-07 | EI-32, serialized session and deferred controls | Exact `ort` source and official I/O-binding docs resolved. Survives, explicitly single-agent. |
| VSA-08 | EI-37, offline replay versus online interleaving | Exact primary citation metadata is recorded; limited transfer is explicit. Survives, explicitly single-agent. |
| VSA-09 | EI-39, separate first-stage and reranked metrics | Sentence Transformers source resolved. Survives, explicitly single-agent. |

No source publication date is later than 2026-08-23. No clear anachronism was found. Model-card dates from 2025 are plausible relative to the current date. Model cards remain evidence for artifact contracts and self-reported evaluations only, never for Magic Context quality.

Actual hallucination-risk count: **9**.

## Consensus Matrix

| Decision | Option A | Option B | Evidence For A | Evidence For B | Verdict |
|---|---|---|---|---|---|
| Candidate shortlist and model-winner policy | Name a winner from public rankings or model cards. | Use public evidence only to bound the shortlist; select and promote only through the repository's predeclared judged campaign. | Model cards and public suites establish artifact contracts and self-reported or out-of-domain scores, but no Magic Context result. | EI-05, EI-09, EI-29, EI-36, and EI-47 show broad agreement on in-domain selection and insufficient evidence for a current winner. | INSUFFICIENT EVIDENCE |
| Query/document preprocessing and semantic identity | Identify a space mainly by model name and output dimensions. | Bind literal query/document templates, tokenizer behavior, pooling, truncation, dimensions, precision, normalization, and artifact hashes into identity. | No report supports model-name-only identity; several failure reports show it can preserve shape while changing rankings. | EI-02, EI-03, EI-07, EI-08, EI-22, EI-44, and EI-45 are corroborated across all five agents. | STRONG CONSENSUS |
| Initial GPU provider/platform | Add one startup-selected Linux NVIDIA CUDA ORT profile inside Synapse. | Start with TEI, TensorRT, another provider, or automatic multi-platform selection. | EI-11, EI-20, EI-24, EI-25, and EI-49 preserve the existing bundle and one-lane contract with the smallest runtime extension. | EI-21 and EI-35 support later alternatives only when a measured winner or performance need justifies their extra boundary. | LEAN (Option A) |
| CPU/GPU equivalence and fallback | Alias CPU and GPU outputs by model name/shape and permit ORT's implicit CPU fallback. | Keep identities separate by default; certify exact hardware/runtime before aliasing and use startup-only fallback to a separately identified CPU lane. | No report supports implicit equivalence; EI-24 documents silent partition risk. | EI-10, EI-11, EI-23, EI-24, EI-46, and EI-49 converge on explicit certification and fail-closed fallback. | STRONG CONSENSUS |
| Lexical/hybrid control | Replace or judge retrieval with dense vectors alone. | Keep lexical retrieval beside dense retrieval and evaluate any BGE-M3 hybrid path as a separate architecture. | Dense bi-encoders are simpler, and reports do not prove a new hybrid stack beats the existing fused path. | EI-04 and EI-18 provide direct exact-token and hybrid-separation evidence. | LEAN (Option B) |

Consensus-row count: **5**.

## Evidence-Ranked Techniques

Corroboration below is raw independent-agent count. Ties are not broken by model popularity. Strength-0 EI-42 is excluded.

| Rank | Technique or constraint | Evidence IDs | Score | Interpretation |
|---:|---|---|---:|---|
| 1 | Bind exact preprocessing and post-processing to semantic-space identity. | EI-02 | 20.00 | Highest-consensus correctness constraint. |
| 2 | Use public benchmarks only for nomination; use judged in-domain results for promotion. | EI-05 | 20.00 | No model winner follows from model cards or leaderboards. |
| 3 | Treat every Matryoshka dimension and operation order as a distinct candidate. | EI-07 | 16.00 | Prevents unsupported truncation shortcuts. |
| 4 | Treat the small holdout as a coarse gate, not a close-ranking oracle. | EI-09 | 16.00 | Requires broader independent judgments before winner claims. |
| 5 | Never compare or mix vectors across unproven semantic spaces. | EI-10 | 16.00 | Applies to CPU/GPU fallback and reindexing. |
| 6 | Protect the holdout from iterative shortlist, prompt, and precision adaptation. | EI-29 | 16.00 | Small-corpus overfit is an active selection risk. |
| 7 | Pool challenger outputs and report query/category sensitivity before resolving close candidates. | EI-47 | 16.00 | Strongest supported benchmark-hardening technique. |
| 8 | Start GPU support with one pinned, fail-closed CUDA ORT lane. | EI-11 | 15.00 | Strong architecture direction, pending a target hardware tuple. |
| 9 | Keep CPU/GPU execution identities distinct and require real-hardware certification for aliasing. | EI-23 | 15.00 | Numeric equivalence is earned, not assumed. |
| 10 | Apply literal model-specific query/document transforms in benchmark adapters. | EI-44 | 15.00 | A model-ID-only comparison is invalid. |
| 11 | Keep immutable offline bundles and avoid mutable or remote-code model loading. | EI-30 | 12.00 | Supply-chain and semantic integrity align. |
| 12 | Fail qualification on silent ORT CPU partitioning. | EI-24 | 12.00 | Provider registration alone is insufficient evidence of GPU execution. |
| 13 | Keep BGE-M3 hybrid evaluation separate from dense model selection. | EI-18 | 12.00 | Avoids attributing architecture gains to a dense encoder. |
| 14 | Retain a bounded, no-winner candidate matrix. | EI-36 | 12.00 | Supports a cost-ordered campaign, not a promotion result. |
| 15 | Bound GPU work across tokens, rows, bytes, jobs, results, and in-flight calls. | EI-41 | 12.00 | Required before latency or OOM claims are meaningful. |
| 16 | Preserve one active lane, startup-only fallback, and no request-time switching. | EI-49 | 12.00 | Reuses existing operational invariants. |
| 17 | Keep lexical retrieval beside dense retrieval. | EI-04 | 10.00 | Exact-token control remains necessary for mixed code and memory. |
| 18 | Benchmark chunking and effective context jointly with model choice. | EI-38 | 9.60 | Separates context benefit from encoder benefit. |
| 19 | Use BGE-small as the lowest-semantic-risk challenger. | EI-33 | 9.00 | Candidate admission only; quality remains unproven. |
| 20 | Certify full native GPU dependency closure at startup. | EI-25 | 9.00 | Cargo features alone do not prove runtime readiness. |

## Candidate Matrix

Weight lower bounds are arithmetic floors for weights only. They exclude activations, attention workspace, runtime arenas, output buffers, external-data overhead, and process/runtime memory. “Official ONNX” means an owner repository publishes the ONNX artifact; a maintained conversion or runtime path is described separately.

| Model | Role (CPU/GPU/experimental) | Exact required transforms | Native/truncated dimensions | Context | License | Official ONNX status | Expected weight lower bound | Evidence status | Recommended first-round decision |
|---|---|---|---|---:|---|---|---|---|---|
| `Xenova/all-MiniLM-L6-v2` exact incumbent | CPU baseline | Exact Xenova tokenizer and fp32 graph; mean pool over attention mask; L2 normalize; certify effective 256-vs-512 behavior | 384 native | Upstream recipe 256; Xenova tokenizer/application ceiling 512 | Apache-2.0 | Xenova-published ONNX conversion; not an owner Sentence Transformers ONNX claim | ≥86.6 MiB fp32 by 22.7M parameters; shipped graph 90,387,606 bytes | Implemented control; artifact identity weaker than Synapse; quality known only as incumbent | **Required control.** Do not substitute a generic Sentence Transformers run. |
| `BAAI/bge-small-en-v1.5` | CPU floor | Optional query-only retrieval instruction must be frozen; CLS pooling; L2 normalize; 512 truncation | 384 native | 512 | MIT | Owner ONNX status not established by reports; maintained FastEmbed ONNX path exists | ≥127 MiB fp32 | 3/5 contract evidence; lowest semantic implementation risk; in-domain quality unproven | **Run in first round** as lowest-risk challenger and CPU/GPU equivalence control. |
| `nomic-ai/nomic-embed-text-v1.5` | CPU floor | `search_query:` / `search_document:`; mean pool; full-vector layer normalization; prefix truncate; L2 normalize | 768 native; 512 and 256 documented | 8,192 | Apache-2.0 | Exact owner ONNX status not established in reports; FastEmbed/runtime support exists | ≥522 MiB fp32 | 2-3/5 recipe evidence; current host lacks required purpose/post-processing contract | **Run 256 and 512 only after exact adapter exists.** Treat each dimension as separate. |
| `Alibaba-NLP/gte-modernbert-base` | CPU | No prompt declared; CLS pool; L2 normalize; exact owner tokenizer/truncation | 768 native | 8,192 | Apache-2.0 | Yes; owner publishes fp32, fp16, int8, uint8, and 4-bit ONNX variants | ≥568 MiB fp32 | 3/5 artifact evidence; no Magic Context transfer proof | **Add first-round 768 treatment** to test long context without prompt asymmetry. |
| `Snowflake/snowflake-arctic-embed-m-v1.5` | CPU | Query-only `Represent this sentence for searching relevant passages: `; documented pooling; Matryoshka truncation; L2 normalize | 768 native; 256 documented | 512 | Apache-2.0 | Yes; owner publishes multiple ONNX precisions | ≥415 MiB fp32 | 3/5 artifact evidence; no in-domain proof | **Add first-round 256 and 768 treatments.** |
| `jinaai/jina-embeddings-v2-base-code` | CPU experimental specialist | Owner tokenizer and pooling recipe; exact ONNX output; normalize; no report-supported project-specific prompt | 768 native | 8,192 | Apache-2.0 | Yes; owner repository publishes fp32, fp16, and quantized ONNX | ≥614 MiB fp32 | Single-agent 3/5 artifact evidence; code-only transfer to mixed memory unproven | **One first-round specialist cell** if matrix budget permits; never replace general candidates from code-only evidence. |
| `Snowflake/snowflake-arctic-embed-l-v2.0` | GPU | Query-only `query: `; CLS pool; documented Matryoshka truncation; L2 normalize; include external data | 1,024 native; 256 documented | 8,192 | Apache-2.0 | Yes; owner ONNX plus external data | ≥2.12 GiB fp32; ≥1.06 GiB fp16 | 3/5 artifact evidence; one report ranks it first because it fits ORT cleanly | **Preferred first CUDA ORT validity treatment**, not a quality winner. |
| `Qwen/Qwen3-Embedding-0.6B` | GPU experimental | Query `Instruct: {task_description}\nQuery:{query}`; documents unprefixed; left padding; last-token pooling; truncate only as documented; L2 normalize | 1,024 native; selectable 32-1,024; evaluate 256/512 | 32K | Apache-2.0 | No owner ONNX artifact | ≥2.22 GiB fp32; ≥1.11 GiB fp16 | Strong artifact contract and model-owner scores; current Synapse cannot express recipe; no in-domain result | **Quality-only benchmark through a certified adapter or pinned TEI.** Do not make first ORT production lane. |
| `Qwen/Qwen3-Embedding-4B` | GPU experimental ceiling | Same Qwen query/document, left-padding, last-token, and normalization contract | 2,560 native; evaluate 512/1,024 only if justified | 32K | Apache-2.0 | No owner ONNX artifact | ≥14.98 GiB fp32; ≥7.49 GiB fp16 | Artifact facts supported; no reason to pay cost before 0.6B result | **Defer.** Admit only if 0.6B wins quality and target VRAM supports a ceiling experiment. |
| `BAAI/bge-m3` | Experimental architecture | No query instruction per card; exact dense output and normalization for dense cell; sparse/multi-vector outputs require separate scoring and identity | 1,024 native | 8,192 | MIT | Yes; owner ONNX plus external data | Unknown; official card does not state parameter count in reports | 3/5 artifact evidence; public hybrid results do not transfer to dense-only use | **Dense experimental cell only.** Treat hybrid or ColBERT modes as a separate project, not this model contest. |
| `nomic-ai/CodeRankEmbed` | Experimental code specialist | `Represent this query for searching relevant code: `; owner tokenizer/custom-code semantics; parity to reference required | 768 native | 8,192 | MIT | No owner ONNX artifact | ≥522 MiB fp32 | Single-agent 3/5 artifact/paper evidence; project-memory prose not evaluated | **Defer until owner-controlled export and componentwise parity exist.** |
| EmbeddingGemma 300M | Experimental gated | Query `task: search result | query: `; document `title: none | text: `; documented pooling and Matryoshka order; certify community export | 768 native; 512/256/128 documented | 2K | Gemma license, gated | Community ONNX only; no owner ONNX established | ≥1.15 GiB fp32 by 308M parameters | Single-agent 3/5 technical evidence; legal and provenance gates open | **Defer pending legal/redistribution review and export parity.** |

No row is an optimal winner. First-round decisions only control experiment order and implementation risk.

## GPU Architecture Synthesis

### Smallest supportable profile

1. **Boundary:** reuse the Synapse process and immutable bundle contract. Keep the TypeScript MiniLM provider as the portable control and explicit fallback.
2. **Platform:** one Linux NVIDIA target profile. Pin GPU architecture, driver, CUDA, cuDNN, ORT API/build, `ort`/FastEmbed versions, provider options, and hashes of the entire native dependency closure.
3. **Provider:** enable `ort/cuda`, inject one `CUDAExecutionProvider`, and treat registration failure as fatal for the GPU lane. During qualification, disable CPU EP fallback and inspect provider assignment/profiling so every semantic node runs on the intended provider set.
4. **Session:** one serialized session and one active lane. Keep existing permit and job bounds. Add explicit bounds for rows, tokens, bytes, retained results, in-flight calls, and measured VRAM envelope.
5. **Identity:** separate semantic identity from execution identity. Semantic identity binds all model/tokenizer/external-data hashes and transformations. Execution identity binds runtime/provider/hardware. CPU and GPU remain separate by default.
6. **Certification:** run structural, finite/norm, componentwise, Unicode/code/truncation, purpose-sensitive, cosine/rank, provider-assignment, repeated-cold-start, and judged nDCG@10/Recall@50 checks on the exact hardware/runtime tuple.
7. **Fallback:** choose GPU or CPU at startup. If CUDA is unavailable or certification fails, activate a separately identified CPU lane before serving. Never let ORT silently partition a declared GPU lane onto CPU.

### Proven by the reports

- FastEmbed user-defined ONNX construction accepts execution providers, and `ort` exposes a safe CUDA provider wrapper.
- FastEmbed's Cargo `cuda` feature is Candle CUDA, not ONNX Runtime CUDA.
- ORT provider priority and CPU fallback can create mixed execution unless qualification disables and inspects fallback.
- Synapse already supplies immutable artifacts, exact runtime identity, certification, one-lane admission, and no request-time switching.
- Arctic l v2.0 offers an owner-published ONNX artifact that fits this path. Qwen3 does not.

### Unresolved

- Actual GPU model, VRAM, compute capability, driver, CUDA/cuDNN versions, and exact GPU-capable ORT distribution.
- Exact native dependency manifest and whether repository packaging can reproduce it.
- Full-graph CUDA coverage for the selected ONNX graph.
- Numeric and rank tolerance for CPU/GPU alias certification.
- Batch-size and token-distribution crossover where GPU beats CPU, plus cold-start and OOM recovery behavior.
- Whether Qwen3's judged quality warrants a TEI/Candle/export boundary.

### Rejected for the first release

- **TensorRT:** second optimization layer only after a CUDA-qualified winner misses a measured performance target. Engine caches, profiles, and rebuilds add identity and cold-start risk.
- **MIGraphX/AMD, DirectML/Windows, CoreML/Apple:** each creates another platform matrix before one target profile is proven.
- **TEI, Infinity, or vLLM as the default local service:** additional process, API, batching, readiness, and packaging surfaces without measured need. Pinned TEI remains an acceptable Qwen3 benchmark adapter.
- **FastEmbed Candle Qwen3 as a drop-in:** it does not satisfy the current strict offline bundle contract without a separate loader and identity design.
- **Automatic provider/device selection or request-time switching:** conflicts with one-lane admission and makes identity, fallback, and failure attribution ambiguous.

## Risk Register

| Risk ID | Risk | Likelihood | Impact | Mitigation | Source |
|---|---|---|---|---|---|
| R1 | Small-corpus overfit or holdout contamination can make close variants appear ordered when a few queries dominate. | High | High | Predeclare candidates and recipes; run the final holdout rarely; report paired query deltas and leave-one-out sensitivity; pool hard negatives; expand independent slices. | EI-09, EI-29, EI-47; [NIST topic-set study](https://www.nist.gov/publications/effect-topic-set-size-retrieval-experiment-error) |
| R2 | A preprocessing, pooling, or truncation mismatch can test the wrong embedding function while preserving valid-looking vectors. | High | High | Use host-owned versioned query/document templates and fingerprint tokenizer, padding, pooling, output, dimension, precision, and normalization. | EI-02, EI-03, EI-13, EI-44; [Qwen3 pinned artifacts](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/tree/97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3) |
| R3 | Silent ORT CPU fallback or provider partition can turn a claimed GPU lane into mixed CPU/GPU execution. | High | High | Disable CPU EP fallback during qualification; inspect node assignment and profiling; fail startup; use a separately identified service-level CPU fallback. | EI-11, EI-24; [ORT Execution Provider APIs](https://onnxruntime.ai/docs/execution-providers/#apis-for-execution-provider) |
| R4 | GPU dependency closure or version drift can pass Cargo build checks but fail at runtime. | Medium | High | Pin and hash ORT, CUDA, cuDNN, driver/provider closure; record target hardware; require a real-device startup smoke and readiness failure. | EI-25; [ORT CUDA requirements](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html#requirements) |
| R5 | GPU OOM, retained memory, and cold-start cliffs can appear outside the configured provider arena. | High | High | Keep one session; bound tokens, rows, bytes, jobs, results, and calls; measure complete VRAM under cold, warm, and soak workloads. | EI-26, EI-27, EI-41; [ORT `gpu_mem_limit`](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html#gpu_mem_limit) |
| R6 | Identity or reindex mistakes can mix changed artifacts, transforms, providers, or partial old/new indexes. | Medium | High | Hash all consumed files; create a new space for every semantic change; keep execution identity separate; require explicit activation and prohibit cross-space scoring. | EI-10, EI-22, EI-23, EI-42; [Qdrant named vectors](https://qdrant.tech/documentation/concepts/vectors/) |
| R7 | Quantization or Matryoshka operation-order drift can reorder near neighbors while preserving shape and norm. | Medium | High | Give each dimension, precision, calibration digest, and post-processing recipe its own identity and judged result. | EI-07, EI-08; [ORT quantization](https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html) |
| R8 | Conversion and distribution can import remote code, pickle, mutable revisions, mixed artifacts, or incompatible license terms. | Medium | High | Prefer owner artifacts; pin revisions; convert offline; retain hashes and license notices; disable runtime download; require legal review where needed. | EI-17, EI-22, EI-30; [Transformers custom models](https://huggingface.co/docs/transformers/en/models#custom-models) |
| R9 | Dense-only attribution can blame an encoder for exact-token failures or misreport BGE-M3 hybrid gains as dense-model gains. | Medium | Medium | Keep lexical control; report dense and fused paths separately; treat sparse and multi-vector indexing as a separate architecture. | EI-04, EI-18; [GitHub code search](https://github.blog/engineering/architecture-optimization/the-technology-behind-githubs-new-code-search/) |

Risk count: **9**.

## Contradictions & Gaps

### Contradictions

| Question | Strongest evidence for one side | Strongest evidence for the other side | Synthesis |
|---|---|---|---|
| First GPU model/runtime | Agent 2 favors owner-ONNX Arctic l v2.0 first because it fits CUDA ORT with lower implementation risk. | Agent 1 names Qwen3 0.6B as the main GPU candidate; Agent 4 says pinned TEI is the strongest exact Qwen3 treatment. | Platform leans CUDA ORT, but model order is contested. Arctic is the validity-first ORT treatment; Qwen is a quality-only alternate until judged results exist. |
| Dense-only versus hybrid | BEIR and GitHub code-search evidence support lexical/sparse or late-interaction controls. | Existing dense plus lexical retrieval may already cover exact identifiers; BGE-M3 adds index and scoring machinery. | Retain lexical beside dense and measure the gap. Do not infer a BGE-M3 architecture decision from model-card scores. |
| CPU/GPU semantic aliasing | Separate spaces are safest because provider and precision can alter vectors. | Reports allow future aliasing after exact hardware/runtime certification. | Separate by default. Certification may permit semantic aliasing only under a versioned tolerance, while diagnostics retain execution identity. |
| Post-processing location | Host operations are inspectable and purpose-aware. | Exporting post-processing into ONNX keeps the host smaller and binds semantics into graph bytes. | No forced consensus. Whichever path is selected must be exact, fingerprinted, and parity-tested. |
| MiniLM context | Upstream Sentence Transformers documents 256 word pieces. | The deployed Xenova tokenizer and application ceiling are 512. | The incumbent is the Xenova treatment; certify actual behavior and run equal-input analysis before crediting extra context. |

### Gaps

| Gap | Severity | Impact | Narrow delta-queries |
|---|---|---|---|
| **Independent in-domain candidate results and a stable judged population** | **CRITICAL** | This is the fundamental candidate-winner decision, which is INSUFFICIENT EVIDENCE. Results could change every model ordering and determine whether any GPU path is justified. | 1. On a predeclared frozen matrix, what are paired per-query nDCG@10 and Recall@50 deltas versus exact Xenova MiniLM? 2. Does leave-one-query-out or query bootstrap change the top-two ordering? 3. After pooled judging from dense, lexical, and fixed hybrid runs, does another judgment round still change ordering materially? |
| Exact host-owned query/document transforms | High | Wrong prompts or pooling can reverse model ordering and create incompatible spaces. | 1. What literal query/document template does each admitted candidate require? 2. Do one shared project-memory instruction and category-specific instructions differ on development-only queries? 3. Does host-side post-processing match the owner reference componentwise? |
| Target GPU compatibility tuple | High | Without hardware, driver, CUDA, cuDNN, VRAM, and ORT build, the CUDA lean is not a reproducible platform decision. | 1. What exact deployed GPU architecture, VRAM, driver, CUDA, and cuDNN tuple must be supported? 2. Which pinned ORT build loads every required provider library on that target? 3. Does the selected graph achieve full CUDA node assignment with CPU fallback disabled? |
| CPU/GPU alias tolerance | High | An overly loose rule can mix spaces; an overly strict rule forces unnecessary reindexing. | 1. What componentwise, cosine, and rank thresholds are stable across repeated cold starts? 2. Do judged nDCG@10 and Recall@50 remain identical within the proposed tolerance? 3. Which runtime/provider changes invalidate certification? |
| GPU workload envelope | Medium | GPU may lose on single-row requests, OOM on long inputs, or fail p95 because of cold start. | 1. Where is the CPU/GPU crossover over observed rows and token lengths? 2. What is complete peak VRAM, not provider-arena usage, under the largest admitted batch? 3. What cold-start and recovery latency occurs after process restart? |
| Safe activation/reindex protocol | Medium | New spaces can coexist incorrectly or rollback can select incomplete data. | 1. Which existing generation fields prove a space is complete before activation? 2. What read path prevents cross-space scoring during lazy re-embedding? 3. What state makes rollback reversible after partial reindex? |
| Qwen3 production boundary | Medium | Qwen3 cannot enter current Synapse correctly without last-token pooling, left padding, prompts, and an offline runtime/artifact contract. | 1. Does Qwen3 0.6B win enough judged queries to justify a new boundary? 2. Can a pinned TEI local directory reproduce the owner vectors under the required prompts? 3. Can an owner-controlled ONNX export pass componentwise parity and full CUDA assignment? |

`CRITICAL_GAP: yes` — **Independent in-domain candidate results and a stable judged population**.

## Key Insights

1. **An embedding model is a complete function, not a repository name.** Query/document templates, tokenization, pooling, truncation, dimensions, precision, and normalization all define the space ([E5](https://arxiv.org/abs/2212.09741), [Qwen3 pinned artifacts](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/tree/97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3)).
2. **No report establishes an optimal Magic Context model.** MTEB and public code benchmarks can nominate treatments, but domain rankings are not reliable winner evidence ([MTEB](https://arxiv.org/html/2210.07316), [MTEB: Massive Text Embedding Benchmark](https://aclanthology.org/2023.eacl-main.148/)).
3. **The current judged corpus is a useful guardrail, not a precision instrument.** Small topic sets can misorder close systems, and repeated holdout adaptation contaminates the result ([NIST topic-set summary](https://www.nist.gov/publications/effect-topic-set-size-retrieval-experiment-error), [adaptive data analysis](https://doi.org/10.1126/science.aaa9375)).
4. **Lexical retrieval remains a first-class control for code-shaped memory.** Exact symbols, paths, and errors are not safely delegated to dense similarity alone ([The technology behind GitHub's new code search](https://github.blog/engineering/architecture-optimization/the-technology-behind-githubs-new-code-search/), [BEIR](https://arxiv.org/abs/2104.08663)).
5. **Synapse already contains the right safety boundary for optional GPU inference.** The useful new mechanism is one certified provider profile, not a second model registry or request-time device selector ([ORT execution providers](https://onnxruntime.ai/docs/execution-providers/), [ORT CUDA](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html)).
6. **A registered CUDA provider is not proof of a GPU lane.** ORT can partition unsupported nodes to CPU unless qualification disables fallback and checks assignment ([ORT provider API](https://onnxruntime.ai/docs/execution-providers/#apis-for-execution-provider)).
7. **Owner-published ONNX changes experiment order, not quality conclusions.** Arctic l can validate the CUDA ORT path with less export risk; Qwen3 remains a separate quality candidate because its owner does not publish ONNX ([Arctic l](https://huggingface.co/Snowflake/snowflake-arctic-embed-l-v2.0), [Qwen3](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B)).
8. **CPU/GPU equivalence is a certification result.** Provider, precision, runtime, and hardware identity remain diagnostic facts even if vectors later earn semantic aliasing ([TensorRT precision](https://docs.nvidia.com/deeplearning/tensorrt/latest/inference-library/precision-control.html#algorithm-selection-and-reproducible-builds), [ORT CUDA](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html)).
9. **Weight size is only a floor.** Complete RSS or VRAM depends on activations, arenas, token length, batches, and engines, so Qwen3 4B is a ceiling experiment rather than a default candidate ([Qwen3 4B metadata](https://huggingface.co/api/models/Qwen/Qwen3-Embedding-4B?blobs=true), [ORT CUDA memory limit](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html#gpu_mem_limit)).

## Executive Summary

- Do not name an optimal winner. Keep exact Xenova MiniLM as control, preserve the existing BGE-small/Nomic floor, and add only bounded, recipe-correct treatments to the judged benchmark.
- Make query/document transforms and all post-processing part of semantic identity. New dimensions, precision, artifacts, or transforms create a new space and require separate indexing.
- Lean toward one Linux NVIDIA CUDA ORT profile inside Synapse. Fail closed on provider registration or partitioning and use a separately identified startup CPU fallback.
- Treat Arctic l as the lowest-risk CUDA ORT validity treatment and Qwen3 0.6B as a quality-only alternate through a certified adapter. Neither is a winner without in-domain results.
- Expand and protect the judged corpus, retain lexical controls, and measure paired query/category deltas before any model promotion.

## Supplementary Evidence

One permitted delta-query round ran four parallel queries on 2026-08-23:

- `"magic-context" embedding benchmark MiniLM BGE Nomic Qwen3`
- `information retrieval small topic set paired bootstrap nDCG significance`
- `embedding model selection private domain corpus hard negatives judged evaluation`
- `MTEB custom retrieval benchmark paired significance query count`

No independent Magic Context candidate results were found. Only existing project/task material and already-cited general information-retrieval evaluation literature surfaced. A ResearchGate bootstrap lead was secondary and did not supersede the existing primary NIST/SIGIR evidence. No source supplied a universal minimum query count. The critical gap remains and can only be closed by running the repository's predeclared in-domain campaign. Search-result pages are not evidence of a model winner.

## Source URL Ledger

- <https://aclanthology.org/2020.emnlp-main.550/>
- <https://aclanthology.org/2023.eacl-main.148/>
- <https://aclanthology.org/2025.acl-long.1072/>
- <https://ai.google.dev/gemma/docs/embeddinggemma/model_card>
- <https://arxiv.org/abs/1909.09436>
- <https://arxiv.org/abs/2004.12832>
- <https://arxiv.org/abs/2104.08663>
- <https://arxiv.org/abs/2104.08663v4>
- <https://arxiv.org/abs/2107.05720>
- <https://arxiv.org/abs/2212.03533>
- <https://arxiv.org/abs/2212.09741>
- <https://arxiv.org/abs/2402.03216>
- <https://arxiv.org/abs/2407.02883>
- <https://arxiv.org/abs/2407.12883v4>
- <https://arxiv.org/abs/2412.01007>
- <https://arxiv.org/abs/2506.05176>
- <https://arxiv.org/html/1909.09436>
- <https://arxiv.org/html/2104.08663>
- <https://arxiv.org/html/2210.07316>
- <https://arxiv.org/html/2407.02883>
- <https://ciir-publications.cs.umass.edu/getpdf.php?id=744>
- <https://cloud.google.com/architecture/mlops-continuous-delivery-and-automation-pipelines-in-machine-learning>
- <https://docs.mistralrs.dev/reference/supported-models/>
- <https://docs.nvidia.com/deeplearning/tensorrt/latest/getting-started/support-matrix.html#engine-portability>
- <https://docs.nvidia.com/deeplearning/tensorrt/latest/inference-library/precision-control.html#algorithm-selection-and-reproducible-builds>
- <https://docs.nvidia.com/nim/nemo-retriever/text-embedding/latest/overview.html>
- <https://docs.nvidia.com/nim/nemo-retriever/text-embedding/latest/support-matrix.html>
- <https://docs.pytorch.org/docs/2.9/notes/randomness.html>
- <https://docs.rs/crate/fastembed/6.0.0/features>
- <https://docs.rs/crate/fastembed/6.0.0/source/src/models/qwen3.rs>
- <https://docs.rs/crate/fastembed/6.0.0/source/tests/qwen3.rs>
- <https://docs.rs/crate/ort/2.0.0-rc.13/features>
- <https://docs.rs/fastembed/6.0.0/fastembed/>
- <https://docs.rs/fastembed/6.0.0/src/fastembed/common.rs.html>
- <https://docs.rs/fastembed/6.0.0/src/fastembed/lib.rs.html>
- <https://docs.rs/fastembed/6.0.0/src/fastembed/models/qwen3.rs.html>
- <https://docs.rs/fastembed/6.0.0/src/fastembed/models/text_embedding.rs.html>
- <https://docs.rs/fastembed/6.0.0/src/fastembed/text_embedding/impl.rs.html>
- <https://docs.rs/fastembed/6.0.0/src/fastembed/text_embedding/init.rs.html>
- <https://docs.rs/fastembed/6.0.0/src/fastembed/text_embedding/output.rs.html>
- <https://docs.rs/ort/2.0.0-rc.13/ort/ep/index.html>
- <https://docs.rs/ort/2.0.0-rc.13/src/ort/ep/cuda.rs.html>
- <https://docs.rs/ort/2.0.0-rc.13/src/ort/ep/mod.rs.html>
- <https://docs.rs/ort/2.0.0-rc.13/src/ort/session/builder/impl_options.rs.html>
- <https://docs.rs/ort/2.0.0-rc.13/src/ort/session/io_binding.rs.html>
- <https://docs.rs/ort/2.0.0-rc.13/src/ort/session/mod.rs.html>
- <https://docs.rs/ort/2.0.0-rc.13/src/ort/session/run_options.rs.html>
- <https://docs.vespa.ai/en/learn/tutorials/hybrid-search.html>
- <https://docs.vllm.ai/en/stable/models/pooling_models/>
- <https://doi.org/10.1126/science.aaa9375>
- <https://doi.org/10.1145/564376.564432>
- <https://github.blog/engineering/architecture-optimization/the-technology-behind-githubs-new-code-search/>
- <https://github.com/LaurentMazare/tch-rs>
- <https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/crates/mc-host/Cargo.toml#L18-L19>
- <https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/crates/mc-host/src/synapse/inference.rs#L177-L265>
- <https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/crates/mc-host/src/synapse/mod.rs#L164-L203>
- <https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/docs/synapse-model-bundle.md>
- <https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/docs/synapse-model-bundle.md#L118-L150>
- <https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/docs/synapse-model-bundle.md#L118-L174>
- <https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/docs/synapse-model-bundle.md#L144-L161>
- <https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/docs/synapse-model-bundle.md#L180-L189>
- <https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/docs/synapse-model-bundle.md#L6-L24>
- <https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/docs/synapse-model-bundle.md#L72-L77>
- <https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/packages/plugin/scripts/fixtures/retrieval-benchmark/baselines/v1/policy.json#L1-L20>
- <https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/packages/plugin/scripts/fixtures/retrieval-benchmark/v1/corpus.json>
- <https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/packages/plugin/scripts/retrieval-benchmark/metrics.ts#L22-L32>
- <https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/packages/plugin/scripts/retrieval-benchmark/regression.ts#L1-L20>
- <https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/packages/plugin/src/config/schema/magic-context.ts#L19-L22>
- <https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/packages/plugin/src/features/magic-context/memory/embedding-identity.ts#L18-L68>
- <https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/packages/plugin/src/features/magic-context/memory/embedding-local.ts#L245-L263>
- <https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/packages/plugin/src/features/magic-context/memory/embedding-local.ts#L258-L263>
- <https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/packages/plugin/src/features/magic-context/memory/embedding-local.ts#L423-L437>
- <https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/packages/plugin/src/features/magic-context/memory/embedding-local.ts#L668-L675>
- <https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/packages/plugin/src/features/magic-context/memory/embedding-local.ts#L684-L688>
- <https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/packages/plugin/src/features/magic-context/memory/embedding-local.ts#L713-L720>
- <https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/packages/plugin/src/features/magic-context/memory/embedding-synapse.ts#L28-L32>
- <https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/packages/plugin/src/features/magic-context/memory/embedding.ts#L167-L173>
- <https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/packages/plugin/src/features/magic-context/memory/embedding.ts#L46-L70>
- <https://github.com/ahrav/magic-context/blob/21bd53d00033c96bf322accc2be100beb39006dc/packages/plugin/src/features/magic-context/memory/embedding.ts#L54-L164>
- <https://github.com/cortexkit/magic-context/blob/main/crates/mc-host/src/synapse/mod.rs>
- <https://github.com/cortexkit/magic-context/blob/main/docs/synapse-model-bundle.md>
- <https://github.com/cortexkit/magic-context/blob/main/packages/plugin/scripts/build-benchmark-corpus.ts>
- <https://github.com/cortexkit/magic-context/blob/main/packages/plugin/scripts/retrieval-benchmark/regression.ts>
- <https://github.com/embeddings-benchmark/mteb/issues/1636>
- <https://github.com/ggml-org/llama.cpp/blob/master/examples/embedding/README.md>
- <https://github.com/huggingface/text-embeddings-inference/blob/0d124dc9773be6ac5a9a57d8439aba9bbbf33273/README.md>
- <https://github.com/huggingface/text-embeddings-inference/blob/0d124dc9773be6ac5a9a57d8439aba9bbbf33273/router/src/http/server.rs>
- <https://github.com/huggingface/text-embeddings-inference/blob/0d124dc9773be6ac5a9a57d8439aba9bbbf33273/router/src/http/types.rs>
- <https://github.com/huggingface/text-embeddings-inference/blob/main/README.md>
- <https://github.com/michaelfeil/infinity/blob/main/README.md>
- <https://github.com/microsoft/onnxruntime/blob/4d308dacbbb385fcba9911cd9c07f5603d65cbd6/include/onnxruntime/core/session/onnxruntime_session_options_config_keys.h>
- <https://github.com/microsoft/onnxruntime/blob/4d308dacbbb385fcba9911cd9c07f5603d65cbd6/onnxruntime/core/framework/run_options.cc>
- <https://github.com/microsoft/onnxruntime/issues/19602>
- <https://github.com/microsoft/onnxruntime/issues/19616>
- <https://github.com/microsoft/onnxruntime/issues/29351>
- <https://github.com/tracel-ai/burn>
- <https://huggingface.co/Alibaba-NLP/gte-modernbert-base>
- <https://huggingface.co/Alibaba-NLP/gte-modernbert-base/raw/main/README.md>
- <https://huggingface.co/BAAI/bge-m3>
- <https://huggingface.co/BAAI/bge-m3/blob/5617a9f61b028005a4858fdac845db406aefb181/1_Pooling/config.json>
- <https://huggingface.co/BAAI/bge-m3/blob/5617a9f61b028005a4858fdac845db406aefb181/README.md>
- <https://huggingface.co/BAAI/bge-m3/raw/main/README.md>
- <https://huggingface.co/BAAI/bge-m3/tree/5617a9f61b028005a4858fdac845db406aefb181>
- <https://huggingface.co/BAAI/bge-small-en-v1.5>
- <https://huggingface.co/BAAI/bge-small-en-v1.5/blob/5c38ec7c405ec4b44b94cc5a9bb96e735b38267a/1_Pooling/config.json>
- <https://huggingface.co/BAAI/bge-small-en-v1.5/blob/5c38ec7c405ec4b44b94cc5a9bb96e735b38267a/README.md>
- <https://huggingface.co/BAAI/bge-small-en-v1.5/raw/main/README.md>
- <https://huggingface.co/BAAI/bge-small-en-v1.5/tree/5c38ec7c405ec4b44b94cc5a9bb96e735b38267a>
- <https://huggingface.co/Qwen/Qwen3-Embedding-0.6B>
- <https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/blob/97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3/README.md>
- <https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/raw/main/README.md>
- <https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/tree/97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3>
- <https://huggingface.co/Qwen/Qwen3-Embedding-4B>
- <https://huggingface.co/Snowflake/snowflake-arctic-embed-l-v2.0>
- <https://huggingface.co/Snowflake/snowflake-arctic-embed-m-v1.5>
- <https://huggingface.co/Xenova/all-MiniLM-L6-v2/blob/751bff37182d3f1213fa05d7196b954e230abad9/tokenizer_config.json>
- <https://huggingface.co/Xenova/all-MiniLM-L6-v2/raw/main/tokenizer_config.json>
- <https://huggingface.co/api/models/Alibaba-NLP/gte-modernbert-base>
- <https://huggingface.co/api/models/Alibaba-NLP/gte-modernbert-base?blobs=true>
- <https://huggingface.co/api/models/BAAI/bge-m3>
- <https://huggingface.co/api/models/BAAI/bge-m3?blobs=true>
- <https://huggingface.co/api/models/BAAI/bge-small-en-v1.5>
- <https://huggingface.co/api/models/BAAI/bge-small-en-v1.5?blobs=true>
- <https://huggingface.co/api/models/Qwen/Qwen3-Embedding-0.6B>
- <https://huggingface.co/api/models/Qwen/Qwen3-Embedding-0.6B?blobs=true>
- <https://huggingface.co/api/models/Qwen/Qwen3-Embedding-4B?blobs=true>
- <https://huggingface.co/api/models/Snowflake/snowflake-arctic-embed-l-v2.0?blobs=true>
- <https://huggingface.co/api/models/Snowflake/snowflake-arctic-embed-m-v1.5?blobs=true>
- <https://huggingface.co/api/models/Xenova/all-MiniLM-L6-v2>
- <https://huggingface.co/api/models/Xenova/all-MiniLM-L6-v2?blobs=true>
- <https://huggingface.co/api/models/jinaai/jina-embeddings-v2-base-code?blobs=true>
- <https://huggingface.co/api/models/lightonai/modernbert-embed-large?blobs=true>
- <https://huggingface.co/api/models/mixedbread-ai/mxbai-embed-large-v1?blobs=true>
- <https://huggingface.co/api/models/nomic-ai/CodeRankEmbed?blobs=true>
- <https://huggingface.co/api/models/nomic-ai/nomic-embed-text-v1.5>
- <https://huggingface.co/api/models/nomic-ai/nomic-embed-text-v1.5?blobs=true>
- <https://huggingface.co/api/models/onnx-community/embeddinggemma-300m-ONNX?blobs=true>
- <https://huggingface.co/api/models/sentence-transformers/all-MiniLM-L6-v2>
- <https://huggingface.co/blog/embeddinggemma>
- <https://huggingface.co/docs/hub/en/security-pickle>
- <https://huggingface.co/docs/huggingface_hub/en/guides/download>
- <https://huggingface.co/docs/huggingface_hub/en/guides/download#from-specific-version>
- <https://huggingface.co/docs/optimum-onnx/onnx/usage_guides/export_a_model>
- <https://huggingface.co/docs/text-embeddings-inference/en/cli_arguments>
- <https://huggingface.co/docs/text-embeddings-inference/index>
- <https://huggingface.co/docs/text-embeddings-inference/supported_models>
- <https://huggingface.co/docs/transformers/en/models#custom-models>
- <https://huggingface.co/jinaai/jina-code-embeddings-0.5b>
- <https://huggingface.co/jinaai/jina-embeddings-v2-base-code>
- <https://huggingface.co/nomic-ai/CodeRankEmbed>
- <https://huggingface.co/nomic-ai/nomic-embed-text-v1.5>
- <https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/blob/e9b6763023c676ca8431644204f50c2b100d9aab/README.md>
- <https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/raw/main/README.md>
- <https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/tree/e9b6763023c676ca8431644204f50c2b100d9aab>
- <https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2>
- <https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/blob/1110a243fdf4706b3f48f1d95db1a4f5529b4d41/README.md>
- <https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/blob/1110a243fdf4706b3f48f1d95db1a4f5529b4d41/sentence_bert_config.json>
- <https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/raw/main/README.md>
- <https://huggingface.github.io/candle/guide/installation.html>
- <https://learn.microsoft.com/en-us/azure/search/vector-search-how-to-chunk-documents>
- <https://onnx.ai/onnx/repo-docs/ExternalData.html>
- <https://onnxruntime.ai/docs/build/eps.html>
- <https://onnxruntime.ai/docs/execution-providers/>
- <https://onnxruntime.ai/docs/execution-providers/#apis-for-execution-provider>
- <https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html>
- <https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html#arena_extend_strategy>
- <https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html#gpu_mem_limit>
- <https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html#requirements>
- <https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html#use_tf32>
- <https://onnxruntime.ai/docs/execution-providers/CoreML-ExecutionProvider.html>
- <https://onnxruntime.ai/docs/execution-providers/DirectML-ExecutionProvider.html>
- <https://onnxruntime.ai/docs/execution-providers/MIGraphX-ExecutionProvider.html>
- <https://onnxruntime.ai/docs/execution-providers/ROCm-ExecutionProvider.html>
- <https://onnxruntime.ai/docs/execution-providers/TensorRT-ExecutionProvider.html>
- <https://onnxruntime.ai/docs/execution-providers/TensorRT-ExecutionProvider.html#explicit-shape-range-for-dynamic-shape-input>
- <https://onnxruntime.ai/docs/execution-providers/TensorRT-ExecutionProvider.html#python>
- <https://onnxruntime.ai/docs/execution-providers/TensorRT-ExecutionProvider.html#tensorrt-ep-caches>
- <https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html>
- <https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html#quantization-debugging>
- <https://onnxruntime.ai/docs/performance/tune-performance/iobinding.html>
- <https://papers.nips.cc/paper_files/paper/2022/hash/c32319f4868da7613d78af9993100e42-Abstract-Conference.html>
- <https://qdrant.tech/documentation/concepts/vectors/>
- <https://qwenlm.github.io/blog/qwen3-embedding/>
- <https://raw.githubusercontent.com/Anush008/fastembed-rs/v6.0.0/README.md>
- <https://raw.githubusercontent.com/huggingface/text-embeddings-inference/main/README.md>
- <https://raw.githubusercontent.com/michaelfeil/infinity/main/README.md>
- <https://sbert.net/docs/package_reference/sentence_transformer/evaluation.html>
- <https://sbert.net/docs/package_reference/util.html>
- <https://www.anthropic.com/news/contextual-retrieval>
- <https://www.elastic.co/docs/manage-data/data-store/aliases>
- <https://www.elastic.co/docs/reference/elasticsearch/rest-apis/reindex-indices>
- <https://www.microsoft.com/en-us/research/publication/large-scale-validation-and-analysis-of-interleaved-search-evaluation/>
- <https://www.nist.gov/publications/effect-topic-set-size-retrieval-experiment-error>
- <https://www.sbert.net/docs/package_reference/cross_encoder/evaluation.html>
- <https://www.sbert.net/examples/sentence_transformer/applications/embedding-quantization/README.html>
- <https://www.sbert.net/examples/sentence_transformer/applications/retrieve_rerank/README.html>

</details>

### References

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
