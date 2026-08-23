# Embedding Candidate Pilot — Result

Run date: 2026-08-23. Worktree: `exp/embedding-pilot` at `366e5f37`. Host: linux
x86_64. Runtime: bun 1.3.14, `@huggingface/transformers` 4.2.0,
`onnxruntime-node` 1.24.3, fp32, CPU.

## What was run

Six model recipes over the committed judged fixture
(`packages/plugin/scripts/fixtures/retrieval-benchmark/v1/`), dense retrieval
only, no lexical lane and no fusion, scoring through the repository's own frozen
metric module (`retrieval-benchmark/metrics.ts`) rather than a second
implementation. Documents were embedded from `semanticPayload.title` plus
`body`; queries from `queryText`. Only the 11 `development` queries were used.
The 11 `holdout` queries were not touched.

Each recipe applied its own documented contract: pooling, query and document
prefixes, optional full-vector layer normalization, prefix truncation to the
emitted dimension, then L2 normalization, in that order.

## Result

Every model scored a perfect 1.0000 on the plan's primary quality endpoint.

| Model | nDCG@10 | MRR | dMRR | dims | load ms | embed ms |
|---|---|---|---|---|---|---|
| `minilm-mean-384` (incumbent) | 1.0000 | 0.9545 | — | 384 | 255 | 178 |
| `bge-small-cls-384` | 1.0000 | 0.9545 | +0.0000 | 384 | 286 | 183 |
| `arctic-m-v1.5-cls-256` | 1.0000 | 0.9545 | +0.0000 | 256 | 802 | 445 |
| `arctic-m-v1.5-cls-768` | 1.0000 | 0.9545 | +0.0000 | 768 | 806 | 469 |
| `nomic-v1.5-mean-512` | 1.0000 | 1.0000 | +0.0455 | 512 | 924 | 611 |
| `gte-modernbert-cls-768` | 1.0000 | 1.0000 | +0.0455 | 768 | 993 | 526 |

No model was blocked. All five challengers loaded and ran on CPU from published
ONNX artifacts without conversion work.

Physical rank of the judged answer, per development query:

| Query category | MiniLM | BGE-small | Arctic-m 256 | Arctic-m 768 | Nomic 512 | GTE-ModernBERT |
|---|---|---|---|---|---|---|
| exact-symbol-path | 1 | 1 | 1 | 1 | 1 | 1 |
| error-message | 1 | 1 | 1 | 1 | 1 | 1 |
| architecture-rationale | 1 | 1 | 1 | 1 | 1 | 1 |
| **debugging-history** | **2** | **2** | **2** | **2** | **1** | **1** |
| user-directive | 1 | 1 | 1 | 1 | 1 | 1 |
| current-constraint | 1 | 1 | 1 | 1 | 1 | 1 |
| benchmark-result | 1 | 1 | 1 | 1 | 1 | 1 |
| temporal | 1 | 1 | 1 | 1 | 1 | 1 |
| contradictory-memory | 1 | 1 | 1 | 1 | 1 | 1 |
| paraphrased-decision | 1 | 1 | 1 | 1 | 1 | 1 |
| paraphrased-decision | 1 | 1 | 1 | 1 | 1 | 1 |

Ten of eleven queries are unanimous. The entire discriminating power of the
campaign's judged development set is one query.

## Why nDCG@10 returned 1.0000 for every model

This is a property of the fixture and the metric policy, not of the models.

Each query has exactly one judged relevant document: measured
`relevant docs per query: min=1 max=1` over 24 judgments (22 at grade 2, 2 at
grade 0). The metric policy condenses the judged, non-duplicate entries inside
the physical cutoff window and re-ranks them 1..m, and an unjudged document is
excluded from scoring rather than coerced to grade 0
(`metrics.ts:1-18`). With one judged relevant document, condensation always
places it at condensed rank 1.

Injecting a synthetic ranking into the same frozen scorer confirms the
consequence directly:

| Physical rank of the answer | nDCG@10 | Recall@50 | Reciprocal rank |
|---|---|---|---|
| 1 | 1 | 1 | 1.000 |
| 2 | 1 | 1 | 0.500 |
| 3 | 1 | 1 | 0.333 |
| 5 | 1 | 1 | 0.200 |
| 10 | 1 | 1 | 0.100 |
| 11 | 0 | 1 | 0.091 |
| 22 | 0 | 1 | 0.045 |

`nDCG@10` is therefore a binary "did the answer land in the top ten of
twenty-two" indicator on this fixture. It cannot distinguish rank 1 from rank
10. `Recall@50` is 1.0 by construction because the cutoff exceeds the corpus
size. Both of the plan's quality endpoints — primary and protected secondary —
have zero resolving power here. Reciprocal rank does resolve, and it is already
computed and exported by the same module.

A second structural limit: 20 of 22 queries have an identifier-twin answer
document (`q-<category>-<partition>` maps to `d-<category>-<partition>`), and
the fixture holds one document per query with no near-miss distractors. Mean
rank-1 to rank-2 cosine margin under raw MiniLM is 0.282, but two categories are
already close — `current-constraint` at 0.016 and `architecture-rationale` at
0.087 — so the corpus is not uniformly easy, it is uniformly under-populated.

## What this does and does not establish

It establishes that the committed judged release cannot rank embedding models,
and that a campaign gated on `nDCG@10` and `Recall@50` over it would return
`ABSTAIN` indefinitely or promote on a single query. It also establishes that
all five CPU challengers are runnable today from published artifacts, which
lowers the risk previously attached to artifact provenance for these five.

It does not establish that any model is better or worse for Magic Context. The
one differentiating query is a single observation and cannot support a promotion
decision. It also does not invalidate the existing benchmark for its actual
purpose: as a behavioral regression fixture it correctly detects retrieval
breaking, which is what it was built for. The error was reusing a regression
smoke fixture as a model-ranking instrument.

## Path forward

The measurement basis is now the blocking work, ahead of every model and GPU
step.

1. Make the resolving metric primary for model comparison. Reciprocal rank and
   first-relevant physical rank already exist in `metrics.ts` and need no new
   code. Graded `nDCG@10` stays as the regression endpoint it was written for.
2. Give each query more than one judged relevant document, so an ideal ordering
   exists for nDCG to compare against.
3. Add near-miss distractor documents per category. A one-document-per-query
   corpus measures topic separation, not retrieval quality.
4. Set the recall cutoff below the corpus size, or grow the corpus well past
   the cutoff. `Recall@50` over 22 documents is not a measurement.
5. Re-run this pilot against the repaired release. If the models still tie, the
   incumbent stays and the candidate and GPU programs close on measured
   grounds rather than on assumption.

Steps 2 through 6 of the implementation plan, and every GPU step behind them,
stay unstarted until step 5 above produces separation. The pilot cost one
afternoon and one throwaway script; the campaign it defers is five L-rated steps
and roughly 120 benchmark runs.
