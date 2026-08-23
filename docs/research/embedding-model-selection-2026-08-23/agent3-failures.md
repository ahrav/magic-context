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
