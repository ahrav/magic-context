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
