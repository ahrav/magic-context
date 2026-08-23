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
