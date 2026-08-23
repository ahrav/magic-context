# Rebuilt Benchmark — Result

Run date: 2026-08-23. Release built from commit `8f02017c`. Host: linux x86_64,
bun 1.3.14, `@huggingface/transformers` 4.2.0, `onnxruntime-node` 1.24.3, fp32,
CPU.

## Why the benchmark was rebuilt

The committed `fixtures/retrieval-benchmark/v1` release returned a perfect,
identical `nDCG@10` of 1.0000 for six different embedding models, so it could not
rank them. Measured causes, recorded in `pilot-result-2026-08-23.md`: 22
documents, exactly one judged relevant document per query, no near-miss
distractors, `Recall@50` tautological over a 22-document corpus, and a condensed
judged view that scores 1.0 whether the answer sits at physical rank 1 or rank
10.

Methodology for the rebuild came from `benchmark-methodology-research.md` (24
sources). The load-bearing conclusion was to score PHYSICAL rank rather than the
condensed judged view, since condensation is exactly what destroyed rank
resolution.

## What the new release is

Built by `packages/plugin/scripts/embedding-eval/build-release.ts` from a pinned
commit of this repository, so the corpus is real in-domain content rather than a
fixture.

| Property | v1 release | This release |
|---|---|---|
| Documents | 22 | 2,400 (1,730 TS symbols, 422 Rust items, 248 doc sections) |
| Topics | 22 | 80, split 40 development / 40 holdout |
| Judgments | 24 | 442 |
| Judged documents per topic | exactly 1 | min 3, max 26, mean 5.5 |
| Near-miss distractors | none | mined from real reference and name relationships |
| Identifier twins | 20 of 22 | none, asserted at build time |
| `Recall@50` meaningful | no, cutoff exceeds corpus | yes, corpus is 48× the cutoff |
| Rank resolution | none within the top 10 | strictly monotone in physical rank |

Labels are structurally verifiable rather than hand-judged. Grade 2 is the single
document that defines the queried symbol. Grade 1 is a document that references
that symbol or shares a name-containment relationship with it. Every other
document is grade 0. Because the rule assigns a definite grade to every document,
the pool is complete by construction and no incomplete-judgment correction such
as bpref or infAP is needed.

The harness asserts the property v1 lost before any model loads. Moving one
topic's gold document down the ranking produces strictly decreasing scores —
1.0000 for the ideal ordering, then 0.5615, 0.3543, 0.2808, 0.1623 at physical
ranks 1, 2, 3, and 10. Under the v1 metric all four of those were 1.0.

## Results

40 development topics, 2,400 documents. The 40 holdout topics were not read.
Intervals are a paired bootstrap over topics, 10,000 resamples.

| Arm | nDCG@10 | Δ vs MiniLM | 95% CI | MRR | S@1 | R@10 | R@50 | sec |
|---|---|---|---|---|---|---|---|---|
| `gte-modernbert-cls-768` | 0.7268 | +0.1680 | [0.0870, 0.2541] | 0.9181 | 0.600 | 0.683 | 0.872 | 230.3 |
| `arctic-m-cls-768` | 0.7076 | +0.1488 | [0.0631, 0.2403] | 0.8917 | 0.575 | 0.667 | 0.825 | 68.0 |
| `nomic-mean-512` | 0.6946 | +0.1358 | [0.0527, 0.2185] | 0.8890 | 0.575 | 0.642 | 0.792 | 199.8 |
| `bge-small-cls-384` | 0.6883 | +0.1295 | [0.0529, 0.2097] | 0.8811 | 0.600 | 0.634 | 0.804 | 50.9 |
| `arctic-m-cls-256` | 0.6705 | +0.1117 | [0.0233, 0.2056] | 0.8790 | 0.525 | 0.617 | 0.810 | 67.6 |
| `bm25-lexical` (control) | 0.6053 | +0.0465 | [−0.0407, 0.1352] | 0.6848 | 0.150 | **0.749** | 0.823 | 0.1 |
| `minilm-mean-384` (incumbent) | **0.5588** | — | — | 0.7538 | 0.250 | 0.594 | 0.791 | 42.2 |

`sec` is wall clock to embed 2,400 documents plus 40 queries on CPU. It is a cost
signal for this corpus, not a request-latency measurement.

## Findings

The incumbent is last. All five dense challengers beat `minilm-mean-384` on
physical `nDCG@10`, and every one of those five intervals excludes zero, so the
gaps are separable from zero at 40 topics. MiniLM also has the second-worst
Success@1 at 0.250, meaning it puts the defining document first in one query out
of four.

Plain BM25 outperforms the incumbent encoder on `nDCG@10` (0.6053 against
0.5588), though its interval overlaps zero so that particular gap is not
separable here. Its profile is sharply different from every dense arm: the best
`Recall@10` in the table at 0.749, and by far the worst Success@1 at 0.150. Term
matching finds the right neighbourhood and then orders it badly. That is direct
evidence for keeping a lexical lane beside a dense lane rather than replacing
one with the other, and it means a dense-only comparison would have
misattributed recall the FTS lane already provides.

Cost separates the leaders. `gte-modernbert-cls-768` leads on quality but took
230 seconds against 51 seconds for `bge-small-cls-384`, a 4.5× cost for
0.0385 additional nDCG. Their intervals overlap heavily, so this release cannot
declare one better than the other. `arctic-m-cls-768` sits between them at 68
seconds and 0.7076.

Dimension truncation costs measurable quality. `arctic-m` at 768 dimensions
scores 0.7076 against 0.6705 at 256, from the same model and the same forward
pass.

## What this does not establish

Topics are identifier lookups phrased one way, `where is <symbol> defined`. This
release measures symbol and identifier retrieval, which is one of the ten
categories the v1 corpus enumerated. It says nothing about architecture
rationale, debugging history, user directives, temporal facts, or contradictory
memories, and those categories need human relevance judgments that structural
rules cannot supply.

Documents are source and documentation text drawn from the repository, not actual
stored memory records, and query phrasing is templated rather than natural. Forty
topics is a small set: the intervals are wide, roughly ±0.08, and they are why no
single winner is named.

The holdout partition is still sealed. Nothing here is a promotion decision.

## Path forward

1. Do not promote a default yet. Five candidates beat the incumbent on one
   category with overlapping intervals, which identifies a shortlist, not a
   winner.
2. Narrow the shortlist on cost. `bge-small-cls-384` delivers +0.1295 at
   near-incumbent cost and is the natural first candidate; `gte-modernbert-cls-768`
   and `arctic-m-cls-768` are the quality-first alternatives.
3. Add human-judged topics for the prose categories before any default swap. A
   model that wins identifier lookup and loses decision recall is not an upgrade.
4. Keep the lexical arm in every future comparison. It beat the incumbent encoder
   here and leads `Recall@10`.
5. Open the holdout exactly once, against a frozen shortlist, after step 3.
6. The GPU work stays deferred. Every arm above ran on CPU, and the two cheapest
   challengers already clear the incumbent.

## Reproducing

```sh
bun run packages/plugin/scripts/embedding-eval/build-release.ts
bun run packages/plugin/scripts/embedding-eval/eval-models.ts
```

The release is a function of the checkout, so arms are only comparable when built
from the same commit. `release.json` is generated and not committed; the builder
records the source commit inside it. Model artifacts download to
`.cache/embedding-eval-models`.
