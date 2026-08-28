# Synapse inference concurrency contract

Status: contract version 1, frozen on 2026-08-28 before treatment collection.
The production-bundle variance pilot may fill only the fields named under
[Pre-authorized pilot fill-ins](#pre-authorized-pilot-fill-ins). Filling those
fields does not rebaseline the experiment. Any other edit after the first A/A
block starts a new contract version and a new collection epoch.

This contract governs the comparison of the shipped serialized Synapse
inference topology with benchmark-only concurrency topologies. It follows the
run-record structure in [synapse-tail-contract.md](./synapse-tail-contract.md),
but results from the two experiments are not comparable.

No owner-set treatment-effect boundary, resident-memory materiality boundary,
or shutdown-drain materiality boundary exists. This experiment therefore uses
fixed descriptive replication. It applies no power calculation, confidence
interval, p-value, Holm correction, or automated treatment verdict. The final
decision is explicitly **inconclusive — human decision required**.

## Claim and scope

The experiment asks whether Synapse should retain B0, its shipped
single-CPU-permit inference topology, or adopt one named topology from T1–T4.
It measures one `mc-host` process under pinned CPU budgets. Benchmark-only
construction gates all non-default topologies; no production concurrency
parameter or TypeScript change is part of this experiment.

The deciding evidence is the mixed batch-and-query arm on the production
bundle. Deterministic-engine and `synapse-tiny` runs establish mechanism only.
An unrestricted-host run is exploratory. A candidate may be rejected by a hard
correctness or existing finite-resource guard, but no observed performance or
resource movement selects a candidate automatically.

## Frozen vocabulary and measurement boundaries

- **logical query**: one scheduled `embed.query` operation, opened at its
  intended scheduled-send instant and closed on vectors, terminal rejection,
  timeout, or cancellation.
- **batch session**: one scheduled `embed.batch` job and every `embed.result`
  page needed to reach a terminal disposition. One absolute freshness deadline
  covers submission and polling.
- **attempt**: one wire call, including query retries and result polls.
- **deadline goodput**: batch items published by the freshness deadline divided
  by measured elapsed time. `queue_full` items do not count as goodput.
- **missed slot**: a scheduled query or batch-session start the generator did
  not dispatch at its scheduled instant. A cell with a missed slot in either
  stream is invalid.
- **cell**: one topology × CPU budget × workload level × client-policy × seed
  repetition.
- **block**: one complete restricted-randomized pass over the frozen cell set,
  with one host-process invocation per treatment.

Query latency uses scheduled send to terminal-frame receipt. Timeouts and
terminal rejections remain in the logical-request ledger and are never silently
dropped from the latency evidence. Reports show p50, p95, and p99 for each
logical-query terminal class and show censoring separately.

Each cell discards the first 10% of its fixed hold window as warmup. The harness
records intended, scheduled, sent, admitted, completed, `queue_full`, timeout,
cancelled, and in-flight counts for each method. Raw rows retain warmup and
post-window classifications.

## Candidate set and topology axis

Client policy and topology are independent axes. Every deciding topology runs
the current-plugin fidelity policy defined below.

| ID | Frozen meaning | Levels or disposition |
| --- | --- | --- |
| B0 | Merged-main topology: one CPU permit, serialized backend, bounded query waiting | Run with shipped K=1 posture; run shipped-default K=0 as sensitivity control |
| T1(n) | B0 with ORT intra-op thread count `n` | `n ∈ {2, 4, budget}`; resolve `budget` per cell and drop duplicate integer levels |
| T2 | Class-aware query/batch arbitration over one native-call server | One named candidate; contract below |
| T3 | Release and reacquire the CPU permit at full chunk re-entry boundaries | Chunk rows from bundle manifest, else 16; record source and value |
| T4(N) | Pool of independently loaded and certified model instances | `N ∈ {2, 4}`; pool size equals CPU permit count |
| T5 | More permits over one serialized backend | Apparatus test only; never a treatment candidate |

The candidate set excludes T2+T3 as a composite. A composite would confound two
mechanisms before either earns adoption. It also excludes config-only reductions
of `max_batch_items` or `max_queued_jobs`: those are capacity controls, not
inference topologies. A later contract may test either option after this
collection ends.

Frozen s64 labels B, C, and A+C are not reused.

### T2 arbiter contract

T2 is a class-aware single-server arbiter, not two permits feeding a backend
mutex. Its implementation must satisfy all five obligations:

1. It alternates classes only while both classes wait; otherwise it is
   work-conserving and serves the non-empty class.
2. It skips a dead waiter's closed receiver without advancing the alternation
   cursor.
3. Cancellation deregisters the waiter.
4. Shutdown is observed by clients as `cancelled`, never as an engine or
   invariant error.
5. The turn guard is `Send + 'static` because it crosses `spawn_blocking`, and
   dropping it passes the baton.

The baton-passing implementation has no background task. If implementation
instead introduces an arbiter task, that task must join the component tracker
and observe the ordered shutdown arm.

## Workload and stream semantics

The query arm is scheduled-send open loop. It reports no-retry and
current-plugin-retry policies separately. The batch arm is partly open: batch
sessions arrive exogenously, while chunks and result polls remain
completion-coupled within each session.

The deciding mixed arm runs two independent scheduled streams over one origin.
Randomness derives independently from `(seed, method, logical_id)`, so changing
one stream cannot consume the other stream's random sequence. Batch and query
texts come from one fixed corpus sample stratified by token-length class. Every
level uses the same sample and records its SHA-256.

The frozen batch:query submission-rate ratios are 1:1 and 4:1. Gate 1 B0
screening fixes the absolute rates that place one level at a lightly loaded
operating point and one at a contended operating point; those rates enter the
versioned run manifest before any A/A or treatment block. The ratio labels do
not claim equal service demand. Each level gets its own state decision. A
candidate ranking that flips between levels is inconclusive.

A batch session's freshness deadline equals the current-plugin page deadline.
The experiment does not shorten it. Every result page records item count and
receipt time, allowing deadline goodput to be recomputed from raw evidence.

## Current-plugin client fidelity

The Rust harness reproduces these clauses as one named policy. Source anchors
refer to the current file
`packages/plugin/src/features/magic-context/memory/embedding-synapse.ts`.

| Clause | Harness rule | Current source anchor |
| --- | --- | --- |
| Absolute deadline | One application deadline spans every retry; each attempt receives only the remaining budget, checked before dispatch | `callWithRetry`, lines 1577–1602 |
| Retry hint | Parse finite, non-negative `retry_after_ms`/`retryAfterMs`; round up to integer milliseconds | `readRetryAfter`, lines 214–220 |
| Retry sleep | Sleep uniformly in `[base, 3 × base)` and reject a retry whose sleep reaches the deadline | `callWithRetry`, lines 1631–1639 |
| Attempt caps | Permit 63 retries after the first `queue_full` attempt and 3 retries after the first other retryable attempt | constants at lines 38–45; `callWithRetry`, lines 1628–1630 |
| Missing retry hint | Use `max(1, min(2000, 100 × 2^min(attempt,4)))` milliseconds | `callWithRetry`, lines 1631–1634 |
| Fast-first polling | Issue the first result poll immediately; seed the first pending wait below the served/default cap | `newPollDelayState`, lines 1470–1479; `pollBatch`, lines 1511–1518 |
| Poll escalation | Multiply pending waits by 1.6, floor them at 10 ms, and treat served `retry_after_ms` as a ceiling rather than a target | constants at lines 33–36; `pendingPollDelay`, lines 290–308 |
| Page deadline | Share one absolute deadline across batch submission, module-restart resubmission, and polling | `embedBatch`, lines 803–825; `pollBatch`, lines 1511–1525 |

The harness does **not** model:

- the managed transport's replay token, because the Rust harness talks to its
  own origin directly and records logical identity itself; and
- the `outcome_unknown` retry gate at lines 1620–1621, because embedding calls
  pass `retryEmbeddings = true`, making that branch non-deciding for this policy.

These omissions limit client-path parity. The directional retry, deadline, and
polling rules above are the workload-fidelity contract; the harness does not
claim byte-for-byte managed-client equivalence.

## Frozen factors and operational constants

| Factor | Frozen value |
| --- | --- |
| CPU budgets | 4, 8, and 16 logical CPUs for deciding evidence; unrestricted exploratory |
| Per-cell hold | 1 second, with first 10% discarded |
| Idle recovery cadence | One idle window after every cell, equal to the cell hold duration |
| Four-CPU co-tenancy arm | One pinned synthetic worker continuously consumes one logical CPU during the measured window |
| T1 levels | `{2, 4, budget}` after duplicate removal |
| T4 levels | `{2, 4}` |
| T3 chunk rows | Bundle `recommended_batch.rows`; fallback 16 when absent, matching current plugin fallback at `embedding-synapse.ts:624` |
| Mixed rate ratios | 1:1 and 4:1 batch sessions to queries |
| Warmup | First 10% of each hold window |
| Observer overhead control | B0, deterministic engine, four-CPU budget, observer off versus on |

The observer control reports deltas for logical-query latency, batch deadline
goodput, process CPU time, VmRSS, and VmHWM. Every B0 summary carries that field;
it is descriptive and has no acceptance threshold.

Missed-slot count and rate are reported for every topology × budget. Because no
owner-set materiality boundary exists, the harness does not invent one. Any
between-topology divergence pauses progression for human classification; it
cannot be waived by deleting invalid cells.

Cpuset emulation constrains logical core count. It does not reproduce LLC share,
memory bandwidth, NUMA placement, or turbo behavior. Any adoption decision
requires confirmation on representative low-core hardware.

## Primary outcomes and analysis

The primary outcome family has exactly two members:

1. logical-query p50, p95, and p99 scheduled-send-to-terminal latency; and
2. batch deadline goodput.

All other outcomes are exploratory, including absolute and per-method ledger
counts, offered and achieved rates, retry amplification, result-poll counts,
service-demand bounds, process CPU time, VmRSS, VmHWM, queue depth, drain time,
and observer overhead.

The independently restarted randomized complete block is the analysis unit.
Requests and attempts within one block are observations, not independent
replicates. Reports show each block value, ranges, and block-paired point
contrasts. They do not report confidence intervals, p-values, power, Holm-adjusted
results, or a powered treatment verdict.

The topology verdict must have the same direction at 4, 8, and 16 logical CPUs.
Any cross-budget ranking divergence is reported as inconclusive. The
unrestricted run cannot resolve a deciding-budget divergence.

### USL applicability

USL requires a closed one-request-in-flight sweep with at least six levels,
independent repeats, randomized order, an identical text mix, and confidence
intervals for σ and κ. T1 has at most three unique levels and T4 has two. No
declared arm qualifies. Reports state `USL not applicable — insufficient closed
concurrency levels and no inferential replication`. Open query and mixed arms
use offered-load/goodput curves and service-demand bounds instead.

## KTD9 resolution and pre-authorized pilot fill-ins

KTD9 resolves to the descriptive branch. Owner-set effect and resource
boundaries are absent, so Holm is dropped and the final verdict remains
`inconclusive — human decision required` regardless of point estimates.

The production-bundle three-block variance pilot may fill only:

- `INDEPENDENT_BLOCK_COUNT`, which becomes a fixed descriptive count for the
  full collection; and
- numeric steady-state tolerances for the flat permit-wait proxy and flat RSS
  checks.

The pilot record must preserve all three pilot blocks and explain the selected
fixed count and tolerances. These fill-ins occur before treatment collection
and cannot use treatment effects. They do not authorize a powered claim. No
other factor, level, threshold, hold duration, deadline, or stop condition may
change without a new contract version and complete rebaseline.

## Failure classification and accounting

Measurement invalidity and adverse treatment outcomes are separate.

| Classification | Causes | Handling |
| --- | --- | --- |
| Invalid repetition | Logical or attempt ledger mismatch; provenance drift; any missed scheduled slot; censoring overrun; generator/SUT schedule drift; harness-teardown `cancelled` | Retain raw evidence under `invalid/`, report cause, do not replace |
| Adverse treatment outcome | OOM; lane failure; startup rejection; drain-budget miss; candidate-caused `cancelled` or `queue_full` | Retain in candidate summaries; reject only affected candidate when a hard guard fails |
| Experiment stop | Production identity cannot be pinned; open-loop schedule cannot be held; A/A path asymmetry or unstable null behavior; request mix or service demand shifts across levels; missed-slot divergence awaits owner classification | Stop new treatments and publish a stop report |

For each measured method, the logical ledger reconciles:

```text
offered = completed + terminal_rejection + timeout + cancelled + in_flight
```

The attempt ledger reconciles:

```text
attempts = successes + retryable_rejections + timeouts + polls
```

Method subtotals sum to the all-method ledger. A mismatch invalidates the whole
repetition. No invalid or adverse run is silently replaced.

## Provenance and run records

Each collection lives under `docs/perf/runs/<name>-<commit>/` and records:

- repository commit and dirty state, rustc version, kernel, host identity, CPU
  model/topology, CPU-budget mechanism, and load before and after each cell;
- process arrangement, randomization seed and realized order, block and restart
  boundaries, stream schedules, and corpus SHA-256;
- bundle directory, manifest model, bundle fingerprint, dimensions,
  `max_tokens`, pooling, quantization, recommended batch shape, and model-file
  SHA-256;
- ORT library path, version, and SHA-256;
- topology ID and resolved parameters, client-policy ID, CPU budget, co-tenancy
  state, hold/warmup windows, idle windows, and pilot-filled constants;
- raw logical-request, attempt, page-receipt, service-time, `/proc/self/status`,
  and `/proc/self/stat` samples;
- invalid and adverse runs with classifications; and
- absolute summaries, paired descriptive contrasts, USL applicability, stop
  condition if any, residual risks, and the explicit human-required decision.

Mechanism-only fixture evidence is labeled `synapse-tiny` and cannot support a
production-model claim.

## Gates and stop conditions

Before treatment collection:

1. compile and run `mc-host` in default and `bench-topology` states;
2. pass `synapse_protocol` and `synapse_jobs` in both states;
3. pin production bundle, model, ORT, commit, corpus, CPU schedule, and contract
   version;
4. run production B0/B0 A/A with identical binary, both labels, and both
   schedule slots;
5. retain the three-block production variance pilot and fill only the authorized
   fields above; and
6. verify every topology preserves the lifecycle guards below.

Every candidate preserves lane-failure checks after each permit acquisition and
before backend use; `settle_inference` marks the lane failing before sink error;
`AbandonGuard` publication semantics; ordered shutdown
`cancel → close admission → close tracker → wait`; reserved result-byte
accounting; and starvation freedom for query and batch classes.

Stop the experiment and publish retained evidence when:

- production bundle or ORT identity cannot be pinned;
- either scheduled stream misses a slot or the generator cannot hold open load;
- A/A shows path asymmetry or unstable null behavior;
- request mix or service demand shifts across concurrency levels;
- missed-slot rates diverge across topologies and no owner classification is
  available;
- a ledger or provenance invariant cannot be repaired without changing the
  frozen contract; or
- USL interpretation is attempted after its applicability check fails.

A candidate that weakens a lifecycle guard, exceeds an existing enforced
resident-memory bound, or misses an existing enforced shutdown budget is
rejected alone. Its run remains an adverse treatment outcome. In the absence of
owner-set materiality boundaries, descriptive resource movement cannot trigger
or waive adoption.

## Verification contract

| Check | Command or evidence |
| --- | --- |
| Default Rust lane | `bun run test:rust` |
| Feature tests | `cargo nextest run -p mc-host --features bench-topology` |
| Guard suites, default | `cargo nextest run -p mc-host --test synapse_protocol --test synapse_jobs` |
| Guard suites, feature | `cargo nextest run -p mc-host --features bench-topology --test synapse_protocol --test synapse_jobs` |
| Default lint | `cargo clippy --workspace --all-targets -- -D warnings` |
| Feature lint | `cargo clippy -p mc-host --all-targets --features bench-topology -- -D warnings` |
| Format | `cargo fmt --check` |
| Contract review | Every R2/R4/R5/R6 semantic appears once; all source anchors match current code; KTD9 is resolved before sizing |

No test asserts a latency or resource threshold. The report may recommend B0 or
one candidate, but adoption remains a separate human-authorized change with its
own bound contract.
