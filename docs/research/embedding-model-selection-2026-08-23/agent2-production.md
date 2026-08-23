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
