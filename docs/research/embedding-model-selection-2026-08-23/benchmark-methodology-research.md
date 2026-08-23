# Research: Correct Construction of a Small Domain IR Test Collection

Research date: 2026-08-23. Scope: methodology for a small, private,
mixed prose-and-code retrieval collection whose purpose is to distinguish
embedding models, not merely detect catastrophic retrieval regressions.

## Actionable summary

The present collection should remain a regression smoke test, but it should not
select an embedding model. Its 11-query development run gave every candidate
`nDCG@10 = 1`; ten queries put the sole relevant document at rank 1 for every
model, and one query supplied all observed separation. Its condensed-list
policy removed unjudged documents before scoring, while `Recall@50` used a
cutoff larger than the 22-document corpus ([1], lines 9–93).

**Recommended replacement design — an explicit project proposal, not a
literature-prescribed universal minimum:**

1. Build an initial 100-topic collection: 60 development topics and 40 sealed
   holdout topics. Stratify both by the ten existing query categories and by
   exact versus paraphrased wording. If confidence intervals remain too wide,
   add predeclared, independently sampled batches; do not declare a winner from
   the initial number alone. IR experiments vary strongly by topic, and the
   literature does not supply a universal sufficient topic count ([12], [13],
   [15], [16]).
2. Use at least 1,000 realistic in-domain documents and keep collection size
   above every reported recall cutoff. Preserve real duplicates, revisions,
   stale memories, conflicting decisions, similar errors, and same-name
   symbols. A large collection need not be exhaustively judged: TREC-style
   pooling exists precisely because exhaustive query-document assessment does
   not scale ([2], [3], [4]).
3. For every topic, pool the union of the top 20 results from the incumbent,
   every frozen challenger, lexical search, and the fixed production hybrid.
   Add same-category and deliberately authored near misses. Judge every unique
   document that appears in any candidate's top 10; keep pooling deeper until
   head-result judgment coverage is effectively complete. Diverse pooling is
   standard practice, but shallow or narrow pools can bias the qrels ([3], [4],
   [7]).
4. Write each topic as an information need, not as a document identifier:
   natural query, intent narrative, timestamp or version boundary, relevance
   criteria, and explicit disqualifiers. Domain experts should design needs
   that match expected usage ([3]).
5. Use grades `0`–`3`: `0` non-answer, `1` useful but partial support, `2`
   direct answer, `3` complete or preferred answer. Keep separate flags for
   `stale`, `contradictory`, `rejected-approach`, and `injected-instruction`;
   negative utility should not be hidden inside a relevance gain. TREC has used
   four-point judgments and explicitly distinguishes a topically related
   non-answer from a relevant answer ([5]).
6. Do not require multiple relevant documents when the need truly has one
   answer. Multiple natural positives make graded metrics more informative,
   but fabricated positives damage validity. For singleton needs, physical
   first-relevant rank and MRR are appropriate; NIST's reference implementation
   describes reciprocal rank as especially useful when one relevant document
   exists or the user wants one ([10]).
7. Make **physical-list `nDCG@10`** the graded primary metric only after all
   candidate top-10 results are judged. Report physical MRR, success/Recall@1,
   Recall@10, Recall@50, per-category results, and every per-query delta.
   Report RBP plus its residual as an incompleteness diagnostic. Keep condensed
   nDCG only as a sensitivity analysis, because condensation answers a missing-
   judgment question, not the production question of which documents occupied
   scarce result slots ([8], [9], [11], [12]).
8. Compare models with paired query-level deltas, confidence intervals, a
   predeclared paired randomization or paired-bootstrap test, win/tie/loss
   counts, and leave-one-topic-out ranking stability. Require a practical effect
   threshold and no protected-category or harmful-result regression. Topic-set
   size, effect size, metric, variance, and desired power jointly determine
   whether a comparison is conclusive ([13], [14], [15], [16]).
9. Freeze model recipes, candidate list, metrics, pool depth, and promotion rule
   before opening the final holdout. Repeated model, prompt, dimension, or
   precision choices based on holdout outcomes are adaptive reuse and weaken
   validity ([17]).
10. Let automated structure and LLMs propose labels, candidates, and
    disagreements, but require human adjudication for final holdout qrels.
    Recent evidence is explicitly contested: positive LLM-assessor results
    coexist with a 2026 critique showing circularity and metric-gaming risks
    ([18], [19], [20]).

## Research question 1: What must the collection represent?

**Facts.** A classical IR test collection contains documents, information
needs, and relevance judgments. Cranfield used 1,398 abstracts, 225 queries,
and exhaustive query-document judgments; TREC moved to much larger corpora and
pooled judgments because exhaustive assessment was infeasible ([2]). Standard
guidance says information needs should be germane to the corpus, reflect
predicted use, and preferably be designed by domain experts rather than made
from random term combinations ([3]). MTEB found no single embedding method
dominated its eight-task benchmark, and BEIR found material differences across
domains and retrieval architectures ([21], [22]).

**Inference for Magic Context.** Unit of representation should be a real
retrieval episode: user need, repository/project state, and candidate document
set. Category labels alone are not enough. The collection should preserve the
production mix of short and long text, code, paths, symbols, logs, decisions,
directives, chronology, contradictions, and duplicate revisions. Public
leaderboards can nominate candidates but cannot substitute for this private
distribution ([21], [22], [23]).

Keep two artifacts:

- **Smoke fixture:** present 22-document collection, expected to remain easy and
  deterministic.
- **Selection collection:** substantially larger, pooled, graded, versioned,
  and designed to expose plausible confusions.

This separation avoids forcing one cheap regression fixture to serve a
statistical model-selection purpose it was not built to serve.

## Research question 2: How should queries and topics be constructed?

**Facts.** Retrieval behavior varies greatly by topic, so a representative and
diverse topic sample matters more than repeated paraphrases of the same need
([12], [13]). CodeSearchNet used 99 natural-language queries and about 4,000
expert assessments over likely results rather than treating millions of
mechanically extracted function/documentation pairs as sufficient evaluation
labels ([24]).

**Proposed protocol (inference):**

- Sample actual anonymized production queries where permitted. Supplement only
  missing strata with authored queries.
- Preserve the current ten categories, but cross them with difficulty axes:
  exact/paraphrased, short/long query, explicit/implicit time, unique/ambiguous
  answer, lexical-overlap high/low, and one/multiple relevant documents.
- Remove query and document IDs whose shared naming reveals the answer. Group
  paraphrases of one information need as one topic family and put the whole
  family in one split.
- Store a topic narrative with user goal, project snapshot, expected answer
  type, inclusion rules, disqualifiers, and examples used only for assessor
  training.
- Include answerable topics and a separately scored abstention set. A topic with
  no relevant document should not silently enter an average whose metric assumes
  at least one relevant document.
- Use one primary query wording per topic for model selection. Paraphrases form
  a robustness slice; they are not independent extra observations.

The 100-topic starting point above is a budget proposal. **UNVERIFIED:** no
retrieved source establishes 100 as sufficient for this workload or any fixed
minimum for distinguishing these candidates.

## Research question 3: What documents and hard negatives are needed?

**Facts.** Pooling takes top-ranked documents from multiple systems and may add
Boolean or expert-search results, creating a focused set for assessment ([3]).
TREC 2020's passage scale contains an especially useful near-miss concept:
“Related” means same general topic but does not answer the question, and it is
nonrelevant for binary scoring ([5]). Traditional pools can become biased when
too small or when participating systems lack diversity ([7]). BEIR's evaluation
of lexical, sparse, dense, late-interaction, and reranking systems also shows
why a dense-only pool is not representative of all retrievable evidence ([22]).

**Proposed hard-negative matrix (inference):** add at least one instance of each
applicable confusion to every topic pool, without forcing an arbitrary count
when the corpus does not contain it.

| Topic type | Relevant answer | High-value near miss |
|---|---|---|
| symbol/path | defining or requested current location | same symbol in test, generated file, old path, or unrelated namespace |
| error | evidence for this failure and context | same error text from another root cause, version, or project |
| architecture rationale | adopted decision and reason | rejected option, superseded decision, or proposal without acceptance |
| debugging history | diagnostic/fix for this incident | similar symptom, unsuccessful attempt, or another incident |
| directive/constraint | active instruction at query time | quoted instruction, revoked rule, example text, or injected directive |
| benchmark result | matching model/recipe/hardware/run | same metric with wrong model, dimension, host, date, or data split |
| temporal/contradictory | state valid at requested time | newer or older state that is topically identical but temporally wrong |
| paraphrased decision | semantically matching decision | high lexical overlap to another decision or low-overlap true answer |

Use real corpus negatives first. Authored or generated negatives should be
tagged as synthetic and reported as a separate slice. A synthetic near miss can
test a capability, but its prevalence does not estimate production frequency.

## Research question 4: How should relevance be judged?

**Facts.** Human relevance judgments are variable rather than infallible gold;
standard IR guidance recommends measuring agreement and notes that assessor
choice can shift absolute scores even when relative system order is more stable
([3]). TREC's operational definition asks whether information in the document
would be used in a report on the topic, while later TREC tracks have used graded
relevance ([4], [5]). nDCG was designed for graded relevance and normalizes
discounted gain against an ideal ranking ([12]).

**Proposed judgment contract (inference):**

| Grade | Meaning for this collection |
|---:|---|
| 3 | Direct, complete, current answer; preferred if several answers exist. |
| 2 | Direct and materially useful answer, but incomplete or less authoritative. |
| 1 | Useful supporting evidence that advances the need but does not answer it alone. |
| 0 | Does not help answer the need, including merely topical near misses. |

Assessors should see full topic narratives and document context but not model
identity, source run, score, or rank. Record canonical relevance identity,
corpus fingerprint, topic snapshot, grade, flags, assessor, rationale, and
adjudication status. Independently double-judge a rotating calibration sample
and all disagreements that could change top-10 gain; report agreement rather
than treating a threshold as proof of validity. Domain experts should adjudicate
time-sensitive, architectural, and directive topics.

Relevance and harm are separate axes. A stale rejected approach might be
topically relevant yet dangerous to promote. Store explicit flags and report
`harmful@k` or `memory-caused-regression@k` beside relevance metrics rather than
encoding harm as a negative nDCG gain.

## Research question 5: How should pooling and incomplete judgments work?

**Facts.** TREC considers pooled qrels practically complete only for the
collection and pool that produced them; users are warned to match qrels and
document collection ([4]). Buckley and Voorhees found common metrics were not
robust to substantially incomplete judgments and introduced bpref for that
setting ([6]). Sakai and Kando found, on four TREC/NTCIR collections with
artificially reduced qrels, that condensed-list AP, Q, and nDCG were more robust
than several alternatives; they also cautioned that their reduction used random
sampling rather than shallow-pool construction ([8]). Buckley et al. found that
undersized pools on large collections can bias judged relevance toward
documents containing topic-title words ([7]).

**Proposed protocol (inference):**

1. Freeze all candidate recipes before creating final pools.
2. Pool top 20 from each dense candidate, BM25/lexical, and fixed hybrid; add
   category-stratified and expert-found candidates.
3. Deduplicate by canonical content identity while retaining revision identity
   where temporal distinctions matter.
4. Blind and randomize assessment order.
5. Judge the union of every candidate's top 10 completely. Report top-10 and
   top-20 judgment coverage for every run.
6. Run leave-one-system-out pool analysis: remove each candidate's unique
   contributions and recompute ordering. Large changes mean the pool is not
   reusable enough.
7. For a later model not represented in the pool, expand and version qrels
   before comparing it. Do not silently score novel unjudged results as known
   negatives.

Condensed scoring is a legitimate robustness technique for incomplete qrels
([8]). It is nevertheless the wrong primary answer here: if an unjudged result
occupies physical rank 1 and a relevant result is at physical rank 10, the user
still paid nine result slots. Primary model-selection metrics should therefore
use physical ranks after head results are judged; condensed scores remain a
sensitivity analysis.

## Research question 6: Which metrics can discriminate models?

**Facts.** Reciprocal rank is the inverse physical rank of the first relevant
result and is intended for tasks where one relevant answer suffices ([10]).
nDCG discounts graded gain by rank and normalizes by the ideal ordering ([12]).
RBP uses a persistence parameter to model rank-depth utility, and its residual
can bound the maximum upward score change if unjudged documents had maximum
gain ([9], [11]). bpref was designed to be more robust than common measures
under incomplete qrels ([6]).

**Metric plan (inference):**

- **Primary:** macro-average physical `nDCG@10`, with equal topic weight and a
  separately reported macro-average across categories. Use only after pooled
  head results are judged.
- **Required secondary:** physical MRR, Success/Recall@1, Recall@10,
  Recall@50, and median first-relevant rank. Recall@50 is meaningful only when
  the corpus exceeds 50 documents and known relevant documents can actually
  fall outside the cutoff.
- **Incomplete-qrels diagnostics:** RBP at a predeclared persistence matching
  expected inspection depth, RBP residual, bpref, judgment coverage, and
  condensed nDCG sensitivity.
- **Safety:** stale/contradictory/rejected/injected-result rate at 1, 5, and 10.
- **Resolution:** per-topic score and rank, per-category mean, win/tie/loss
  against the incumbent, and rank-1-to-rank-2 cosine margin. Aggregate scores
  without these distributions can hide one-topic dominance.
- **Attribution:** report dense-only model comparison separately from lexical
  and production-hybrid results. BEIR found BM25 robust and architectures
  behaved differently, so a hybrid gain cannot automatically be credited to
  the embedding model ([22]).

No single metric proves general superiority. Metric choice must match whether
the user needs one answer, several supporting documents, graded ordering, or
deep recall.

## Research question 7: How many topics and what statistical test are enough?

**Facts.** Voorhees and Buckley found retrieval conclusions can change with the
topic sample and warned especially against conclusions from few topics ([13]).
Webber, Moffat, and Zobel studied statistical power in retrieval experiments,
while Sakai treated topic-set size as a design problem rather than a universal
constant ([15], [16]). Smucker, Allan, and Carterette compared significance
tests for paired IR evaluation ([14]). These sources do not establish one
minimum that transfers to this collection.

**Proposed decision analysis (inference):**

- Treat topics, not documents or paraphrases, as independent paired units.
- On development data, estimate paired effect distribution and choose a
  smallest practically important difference before opening holdout.
- On holdout, report paired mean and median deltas, 95% confidence interval,
  paired randomization or paired-bootstrap result, and leave-one-topic-out top-
  model stability.
- Compare each challenger with the incumbent under predeclared tests; avoid an
  exploratory all-pairs tournament.
- Stratify reporting by category, but do not claim category-level significance
  from tiny cells.
- Promote only when the practical threshold is met, interval excludes no
  improvement under the frozen rule, and protected slices do not regress.
- If inconclusive, keep the incumbent and add a predeclared independent topic
  batch. A tie is an evidence result, not permission to tune on holdout.

**UNVERIFIED:** 40 holdout topics will detect the expected model differences.
Only observed paired variance and target effect can answer that. The initial
100-topic proposal is a feasible starting design, not a power guarantee.

## Research question 8: How should holdout leakage and contamination be controlled?

**Facts.** Adaptive reuse of holdout data can invalidate ordinary statistical
guarantees; the reusable-holdout work addresses precisely this adaptive-data-
analysis problem ([17]). MTEB reports no universal embedding winner, and CoIR
states that models can overfit existing leaderboards, supporting private
in-domain confirmation rather than public-score promotion ([21], [23]).

**Proposed controls (inference):**

- Development topics may guide prompt, pooling, preprocessing, and metric
  debugging. Holdout topics may not.
- Freeze candidate artifact hashes, query/document instructions, pooling,
  truncation, dimensions, precision, normalization, and promotion rule before
  final holdout embeddings are run.
- Split by topic family, source incident, repository object, and document
  revision lineage. Near duplicates, paraphrases, and before/after versions of
  one decision belong in one split.
- Use a time boundary where possible and retain collection fingerprints.
- Log every holdout access. One final comparison campaign creates a release;
  later candidates require a new independently judged holdout release.
- Keep public benchmark results for candidate admission only. Do not merge
  public benchmark questions into private holdout claims.

**UNVERIFIED:** whether any candidate was pretrained on public Magic Context
repository content or semantically equivalent text. Model cards and retrieved
benchmark papers do not resolve candidate-level training contamination. A
post-training temporal slice and renamed structural variants can be reported as
sensitivity checks, but neither proves absence of contamination.

## Research question 9: What roles should automatic labels, LLM judges, and code benchmarks play?

**Facts.** Thomas et al. reported LLM labels comparable to human labellers in
their Bing/TREC experiments, with prompt paraphrases affecting accuracy ([18]).
UMBRELA reproduced high correlation with rankings of effective systems across
TREC Deep Learning tracks using GPT-4o ([19]). Clarke and Dietz's version
revised in January 2026 disputes replacement of human assessment, demonstrating
metric exploitation and warning about circularity when systems and judge share
LLM behavior ([20]). This is a live contradiction, not settled consensus.

CodeSearchNet separates mechanically extracted documentation/function pairs
from its smaller expert-judged challenge set ([24]). CoIR spans ten code datasets,
eight retrieval tasks, and seven domains and reports that state-of-the-art
systems still find code retrieval difficult ([23]). These benchmarks establish
that code retrieval is heterogeneous; they do not establish quality for mixed
project memory.

**Proposed use (inference):**

- Derive high-confidence candidate positives from exact paths, definitions,
  references, commit links, timestamps, and fixture ownership. Treat these as
  structural controls, not automatic proof of semantic relevance.
- Use static analysis and lexical search to discover hard negatives and missed
  pool documents.
- Let an LLM draft grades, rationales, and disagreement flags on development
  data. Version model, prompt, temperature, and raw output; calibrate against
  human judgments.
- Require human adjudication for all final holdout head results and every label
  that could change candidate order. Never use the evaluated embedding model or
  a close generator family as the sole judge.
- Report prose, code, exact-token, and mixed-document slices separately. Keep a
  lexical baseline and evaluate dense-only and hybrid pipelines independently.

## Direct answers to our failure

1. **Why was condensed `nDCG@10` always 1?** Each development topic had one
   judged relevant document, and unjudged documents were removed before gain
   was scored. The relevant document therefore became condensed rank 1 whenever
   it appeared inside physical top 10 ([1], lines 56–86). Condensed metrics can
   be robust to incomplete judgments in other settings ([8]); here, one positive
   plus almost no judged negatives removed all within-cutoff rank resolution.
2. **Must every query have several relevant documents?** No. Natural multiple
   positives support graded ordering, but singleton needs are valid and MRR is
   designed for them ([10]). The repair is complete head judging, physical-rank
   scoring, and realistic near misses—not fabricated positives.
3. **What should replace identifier twins?** Real information needs with
   independent IDs, natural wording, intent narratives, and several plausible
   same-topic documents. Shared query/document naming should never reveal the
   target.
4. **How many distractors?** No universal number is supported. Proposed minimum:
   pool all candidate/lexical/hybrid top 20, ensure every top-10 item is judged,
   and include each applicable near-miss type. Coverage and leave-one-system-out
   stability determine whether more judging is needed ([3], [7]).
5. **What becomes primary?** Physical `nDCG@10` for graded topics after complete
   head judging; physical MRR for first-answer sensitivity. Keep both and report
   per-query deltas. Never let condensation silently redefine physical rank.
6. **What happens to `Recall@50`?** Retain it only on a corpus well above 50
   documents, with enough known positives that relevant documents can be missed.
   Add Recall@10 and Success@1. On 22 documents, Recall@50 was tautological ([1],
   lines 71–85).
7. **Can the existing 22-query release select a winner?** No. It remains useful
   as a deterministic regression fixture, but one development query supplied
   all observed model separation ([1], lines 37–54, 95–108).
8. **Can an LLM cheaply finish the qrels?** It can propose and triage them, but
   sole-LLM final qrels are not supported. Positive 2023–2024 findings and the
   2026 critique conflict ([18], [19], [20]).
9. **When may a model be promoted?** Only after a frozen candidate beats the
   incumbent by a predeclared practical threshold on paired sealed-holdout
   topics, with uncertainty reported and no protected-slice regression. If the
   result remains query-sensitive or inconclusive, retain the incumbent and
   expand the topic set.

## Open questions and unsupported areas

- **Required sample size:** UNVERIFIED until development-run paired variance and
  target effect are measured. No universal query count was found.
- **Production query distribution:** UNVERIFIED until anonymized real-query
  sampling is audited; authored category balance may not match use frequency.
- **Relevance prevalence:** UNVERIFIED. Do not force several positives per topic
  before measuring how often production needs naturally have them.
- **Assessor reliability and cost:** UNVERIFIED for project experts. Run a timed
  pilot with overlap and adjudication before fixing pool depth.
- **Pool completeness for future models:** inherently unsupported by a frozen
  pool. New model families require pool expansion and a new release ([4], [7]).
- **LLM judge transfer:** UNVERIFIED for private code, chronology, directives,
  and contradiction labels; published results are contested and use other
  collections ([18], [19], [20]).
- **Candidate training contamination:** UNVERIFIED for repository content.
- **Synthetic-negative realism:** UNVERIFIED. Report synthetic and natural
  slices separately.
- **Metric persistence/cutoffs:** the correct RBP persistence and operational
  cutoffs require observed user inspection depth; literature supplies metric
  mechanisms, not this product's behavior ([9], [11]).
- **Canonical identity across storage migration:** repository design requires
  it, but external IR sources do not validate the project's exact adapter.

## References

1. Magic Context, “Embedding Candidate Pilot — Result,” 2026. [`pilot-result-2026-08-23.md`](./pilot-result-2026-08-23.md)
2. Manning, Raghavan, and Schütze, “Standard test collections,” *Introduction to Information Retrieval*, 2008. https://nlp.stanford.edu/IR-book/html/htmledition/standard-test-collections-1.html
3. Manning, Raghavan, and Schütze, “Assessing relevance,” *Introduction to Information Retrieval*, 2008. https://nlp.stanford.edu/IR-book/html/htmledition/assessing-relevance-1.html
4. NIST, “TREC Data — English Relevance Judgements.” https://trec.nist.gov/data/reljudge_eng.html
5. NIST, “TREC 2020 Deep Learning Track.” https://trec.nist.gov/data/deep2020.html
6. Buckley and Voorhees, “Retrieval Evaluation with Incomplete Information,” SIGIR 2004. https://www.nist.gov/publications/retrieval-evaluation-incomplete-information
7. Buckley, Dimmick, Soboroff, and Voorhees, “Bias and the Limits of Pooling for Large Collections,” 2007. https://www.nist.gov/publications/bias-and-limits-pooling-large-collections
8. Sakai and Kando, “On information retrieval metrics designed for evaluation with incomplete relevance assessments,” *Information Retrieval* 11, 2008. https://doi.org/10.1007/s10791-008-9059-7
9. Moffat and Zobel, “Rank-biased precision for measurement of retrieval effectiveness,” *ACM TOIS* 27, 2008. https://doi.org/10.1145/1416950.1416952
10. NIST `trec_eval`, reciprocal-rank implementation and measure description. https://raw.githubusercontent.com/usnistgov/trec_eval/main/m_recip_rank.c
11. NIST `trec_eval`, RBP-residual implementation and measure description. https://raw.githubusercontent.com/usnistgov/trec_eval/main/m_rbp_resid.c
12. Manning, Raghavan, and Schütze, “Evaluation of ranked retrieval results,” *Introduction to Information Retrieval*, 2008. https://nlp.stanford.edu/IR-book/html/htmledition/evaluation-of-ranked-retrieval-results-1.html
13. Voorhees and Buckley, “The Effect of Topic Set Size on Retrieval Experiment Error,” SIGIR 2002. https://www.nist.gov/publications/effect-topic-set-size-retrieval-experiment-error
14. Smucker, Allan, and Carterette, “A comparison of statistical significance tests for information retrieval evaluation,” CIKM 2007. https://doi.org/10.1145/1321440.1321528
15. Webber, Moffat, and Zobel, “Statistical power in retrieval experimentation,” CIKM 2008. https://doi.org/10.1145/1458082.1458158
16. Sakai, “Topic set size design,” *Information Retrieval Journal* 19, 2015. https://doi.org/10.1007/s10791-015-9273-z
17. Dwork et al., “The reusable holdout: Preserving validity in adaptive data analysis,” *Science* 349, 2015. https://doi.org/10.1126/science.aaa9375
18. Thomas et al., “Large language models can accurately predict searcher preferences,” arXiv:2309.10621v3, 2024. https://arxiv.org/abs/2309.10621
19. Upadhyay et al., “UMBRELA: UMbrela is the (Open-Source Reproduction of the) Bing RELevance Assessor,” arXiv:2406.06519, 2024. https://arxiv.org/abs/2406.06519
20. Clarke and Dietz, “LLM-based relevance assessment still can't replace human relevance assessment,” arXiv:2412.17156v3, revised 2026. https://arxiv.org/abs/2412.17156
21. Muennighoff et al., “MTEB: Massive Text Embedding Benchmark,” EACL 2023. https://aclanthology.org/2023.eacl-main.148/
22. Thakur et al., “BEIR: A Heterogeneous Benchmark for Zero-shot Evaluation of Information Retrieval Models,” NeurIPS 2021. https://arxiv.org/abs/2104.08663
23. Li et al., “CoIR: A Comprehensive Benchmark for Code Information Retrieval Models,” ACL 2025. https://aclanthology.org/2025.acl-long.1072/
24. Husain et al., “CodeSearchNet Challenge: Evaluating the State of Semantic Code Search,” arXiv:1909.09436v3, 2020. https://arxiv.org/abs/1909.09436
