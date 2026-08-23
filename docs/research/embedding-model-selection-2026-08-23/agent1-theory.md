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
