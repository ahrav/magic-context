# Synapse query and polling tail contract

Status: contract frozen before treatment collection. Pilot-derived fields are
named below and must be filled before treatment collection starts.

This contract governs the tiny-engine selection run and the production-bundle
confirmation for Synapse query admission, retries, and batch polling. It follows
the run-record format in [mc-host-baseline.md](./mc-host-baseline.md), but its
measurements are not comparable with that document's historical results.

No repository performance policy exists. This contract defines evidence and a
selection procedure, not a pass/fail threshold.

## Claim and scope

The experiment tests whether variants A, B, C, or A+C remove the 100 ms query
retry staircase and the 50 ms pending-poll quantization without weakening finite
bounds, deadlines, cancellation, overload rejection, or idempotency behavior.
The target population is caller-level `embed.query` and `embed.batch` operations
handled by one `mc-host` Synapse instance with its single CPU permit, first with
the deterministic tiny engine and then, if its gate is available, with the real
certified bundle and ORT.

The tiny-engine run is the primary mechanism and selection evidence. The real
bundle is confirmatory. A result may be inconclusive or engine-bound. It does
not become an improvement claim merely because a point estimate moves in the
expected direction.

## Frozen vocabulary and measurement boundaries

These terms are mandatory in manifests, raw records, summaries, and plots.

- **logical request**: one caller-level operation — one `embedQuery`, or one
  page's `embed.batch` plus its `embed.result` sequence to completion. The
  harness opens the logical-request record at the scheduled start for open-loop
  work or immediately before the first wire send for closed-loop work. It closes
  the record on vectors, terminal rejection, or timeout.
- **attempt**: one wire call (`embed.query`, `embed.batch`, `embed.result`),
  including retries and polls. The harness opens an attempt immediately before
  writing that call and closes it when the matching wire reply or attempt
  timeout is observed.
- **offered rate** **λ_off**: logical requests started per second by the
  generator. Open-loop λ_off uses intended scheduled starts, including starts
  delayed in the generator; it is not the achieved send rate. Closed-loop
  λ_off is reported only as observed starts divided by the measured window.
- **admitted rate** **λ_adm**: attempts that acquire an admission permit or job
  slot. The harness derives this from method-specific wire outcomes: an attempt
  is admitted when it proceeds instead of receiving admission rejection. It
  does not use a host counter.
- **completed rate** **X**: logical requests returning vectors divided by the
  measured window. Batch completion requires all vectors for that logical
  request.
- **rejected rate**: attempts answered `queue_full`, split by wire method and
  error code. Reports also identify logical requests that end in terminal
  rejection separately from retryable rejected attempts.
- **timed-out rate**: logical requests ending `timeout`, whether the client
  deadline or host `QueryFault::Timeout` supplies the terminal outcome. Attempt
  timeouts remain separate attempt-ledger entries.
- **service time** **S**: host busy time holding the `cpu` permit for one engine
  `embed` call. Tiny-engine S comes from the test double around the injected
  delay. Real-bundle S comes from the harness's engine-call boundary. Each run
  retains raw S samples and reports mean S and its coefficient of variation.
  For 5 ms and 25 ms injected delays, estimated capacity is 1/mean S. The
  approximately-zero-delay arm is transport- and generator-bound: its measured
  engine S implies an unrealizable in-process arrival rate, so its frozen
  reference capacity is 4,000 logical requests per second. Pilot calibration
  completed 5,000 and 8,000 scheduled requests per second, while 10,000 missed
  scheduled slots. The lower reference keeps the required 2x arm inside the
  observed generator envelope. This substitution is explicit evidence about
  the host path, not an engine-capacity estimate.
- **retry amplification** **A** = attempts / logical requests, reported overall
  and by method. The report also gives the poll-count distribution per job.

Wire replies and harness timestamps are the sole attribution source for logical
request and attempt outcomes. Production metrics and in-host counters are not
outcome evidence. Process-level `utime`, `stime`, and voluntary and nonvoluntary
context-switch series read by the harness from `/proc` are separate no-busy-poll
evidence.

### Timing boundaries

- Open-loop generation uses scheduled-send timing. Logical-request latency is
  terminal receipt minus intended scheduled start, so generator or SUT delay is
  visible and coordinated omission is not hidden. The generator never waits
  for a prior result before scheduling the next start.
- Closed-loop generation uses the declared concurrency level. Each worker sends
  its next logical request only after its previous request reaches a terminal
  outcome. Closed-loop latency is terminal receipt minus the actual first wire
  send, not the scheduled timestamp used by the historical baseline.
- Attempt latency is matching wire reply or timeout minus actual wire send.
- Permit wait time is derived as attempt latency minus injected service time
  and the transport floor measured by the matching near-zero-delay control.
  Negative residuals caused by timer resolution are retained and reported, not
  clamped. The host exposes no permit-wait counter.

The warm state begins after successful authentication, route setup, engine
initialization, fixture loading, and one untimed request of every method used by
the cell. Each independent block then discards the first 10% of its scheduled
hold window as warmup, matching the convention in
[mc-host-baseline.md](./mc-host-baseline.md). Warmup observations remain in raw
evidence with `warmup=true` and do not enter estimates.

## Outcomes and ratio orientation

The primary outcome family is:

1. logical-request p95 latency;
2. completed rate X;
3. terminal rejected rate and timed-out rate;
4. retry amplification A.

Every candidate contrast is candidate / hygiene-only for latency, rejection,
timeout, and A, where less than 1 favors the candidate. Throughput uses
hygiene-only / candidate, so less than 1 also favors the candidate. Reports
must also show absolute values; ratios never replace them.

Required descriptive outcomes are attempt and logical-request p50, p90, p95,
p99, and max latency; eCDFs; λ_off; λ_adm; X; rejected and timed-out rates;
deadline success; A; poll-count distribution; permit-wait distribution; S and
its coefficient of variation; host `utime` and `stime`; and voluntary and
nonvoluntary context-switch counts. Raw samples are retained. p50, p90, p99,
max, CPU, context switches, and poll-count tails are exploratory unless needed
to reject a candidate for a preserved correctness or finite-resource
requirement.

## Factors and levels

The tiny-engine matrix contains every cross-product below unless a run is
stopped by a declared gate.

| Factor | Frozen levels |
| --- | --- |
| Loop discipline | closed loop; scheduled-send open loop |
| Closed-loop concurrency | 1, 2, 3, 4, 8, 16 |
| Open-loop offered λ_off | 0.25, 0.5, 0.75, 1.0, 1.5, 2.0 × the per-delay reference capacity defined above |
| Variant | baseline, hygiene-only, A, B, C, A+C |
| Injected service time | approximately 0 ms, 5 ms, 25 ms |
| Batch shape | 1×16, 4×16 paged, 1×64 |

`baseline` is pre-change code. `hygiene-only` is baseline plus the KTD4 hygiene
bundle and is the reference arm for every candidate delta. The harness is
`crates/mc-host/examples/synapse_perf.rs` with
`crates/mc-host/tests/support/perf_measurement.rs` and `raw_client.rs`. Its
client-faithful retry and poll loops mirror plugin semantics and use the same
constant set; the shipped plugin does not drive cells.

The pilot froze these fields before treatment collection:

- `INDEPENDENT_BLOCK_COUNT = 2`
- `BLOCK_HOLD_DURATION = 1 second`
- `CANDIDATE_A_K_LEVELS = {1, 2}`

These values were frozen from the U7 pilot on 2026-08-26. Two blocks are fixed
descriptive replication, not a powered design. No owner policy, minimum
detectable effect, or treatment-effect threshold exists. The one-second hold
keeps the complete matrix bounded while preserving raw request observations.
Candidate A uses every feasible positive K: startup scratch validation accepts
K=1 and K=2 and rejects K=3. K=0 remains the baseline admission behavior.

Collected-evidence annotation, 2026-08-26: this does not amend the frozen
contract or any decision rule. Pre-treatment calibration at commit `af8ef126`
measured mean S of 5.0563266 ms and 25.0605536 ms. Round-half-up application of
the frozen factors produced 5 ms rates `{49,99,148,198,297,396}` and 25 ms
rates `{10,20,30,40,60,80}` per second. During collection, the harness rejected
rates that do not divide one billion nanoseconds exactly. This affected ten
frozen rates, including zero-delay 3,000 and 6,000/s. Those positions remain
retained as invalid evidence in `docs/perf/runs/synapse-tail-af8ef126/`; no rate
was substituted and no invalid position was replaced.

Cell order is randomized as complete blocks. One independent block contains
one repetition of each scheduled cell under one environment and artifact.
Process restart boundaries and the randomization seed are recorded.

## Delay and blocking objective

At each injected-delay level and batch shape, measure baseline blocking and
waiting at the 1.0x reference capacity. Candidate A targets a lower terminal
blocking probability than baseline at the same measured load while keeping
logical-request p95 permit wait below 100 ms, the existing query retry quantum
this work is intended to remove. The same objective is reported at every other
offered load; the 1.0x point is the K derivation point. For 5 ms and 25 ms this
point remains 1/mean S. The approximately-zero-delay arm uses the explicit
transport reference above and is not used to infer engine capacity.

For each service-time level, derive candidate A's `max_waiting_queries` K with
M/M/1/K as bound-shaped guidance, not as a fitted truth:

1. use measured λ_adm, mean S, and service-time coefficient of variation;
2. enumerate finite K values allowed by the resident-byte bound
   `K × max_text_bytes` and the request deadline;
3. choose the smallest K whose model-guided blocking estimate improves on the
   measured baseline and whose model-guided p95 waiting delay is below 100 ms;
4. exercise the chosen value plus its adjacent feasible values as
   `CANDIDATE_A_K_LEVELS`;
5. prefer measured curves over the model when service-time variance or observed
   distributions contradict M/M/1/K assumptions.

The 100 ms delay budget is descriptive. The host does not enforce it. The
request deadline remains the only wait ceiling, and behavior beyond finite K
remains explicit `queue_full`. U7 reports the full observed waiting-delay
distribution against the budget and makes no enforcement claim.

## Hypotheses

- A lowers terminal rejection and A near the 1.0x reference load by replacing common-path client
  retries with finite server waiting. It may raise admitted-request waiting and
  resident bytes.
- B lowers synchronized retry tails and retry clustering but need not lower
  rejection or mean A because it preserves loss semantics.
- C lowers the 50 ms quantized tail for jobs that lose the first-poll race. It
  may increase polls and context switches, but must preserve the busy-poll
  floor and bounded poll count.
- A+C combines A's query effect and C's polling effect. Interaction is measured,
  not assumed additive.
- Baseline and hygiene-only reveal the hygiene bundle's independent effect.
  Candidate selection uses hygiene-only as its reference.

Expected directions do not decide selection. Absolute outcomes, uncertainty,
resource shifts, correctness gates, and all nine acceptance criteria do.

## Analysis units, A/A control, multiplicity, and stopping

An independently restarted, randomized complete block is the analysis unit.
Requests and attempts within a block are observations, not independent
replicates. Per-cell estimates first reduce each block to its declared summary.
With two fixed descriptive blocks, reports show both block values, their range,
and paired point contrasts. They do not report confidence intervals, p-values,
power, or a treatment verdict. A future inferential run requires an owner-set
effect boundary and a separately frozen design.

Before treatment collection, run two byte-identical hygiene-only labels through
the complete pilot schedule as the A/A control. Report their absolute values and
paired ratios for every primary outcome. Any accounting mismatch,
label-dependent code path, or material offset that remains after rerun and
instrumentation review invalidates the harness. A/A is a measurement-system
check, not evidence for a treatment.

No inferential multiplicity procedure is applied to this fixed descriptive run.
Every loop-discipline × injected-delay × batch-shape slice reports all candidate-
versus-hygiene-only contrasts and all four primary outcomes without selecting on
the largest movement. Required descriptive outcomes are labeled exploratory.
No observed range creates a repository performance policy.

Pilot collection stops only after it can freeze independent block count, hold
duration, and K levels. Treatment collection then uses that fixed schedule with
no precision-based early stopping and no replacement of invalid repetitions.
Stop the experiment and report when any of these conditions holds:

- a selected variant meets the task acceptance criteria on the tiny engine and
  is confirmed on the real bundle;
- queueing is not material for the target population, making the remaining
  cost engine-bound;
- a variant requires an unbounded queue, unbounded waiters, or a deadline
  extension;
- an accounting invariant cannot be satisfied; fix instrumentation before a
  new, versioned collection;
- the target requires a push/notification protocol change; or
- the real-bundle gate `magic-context-c50.8` is unlanded, in which case record
  the confirmatory run as gate-blocked rather than claiming confirmation.

## Accounting and attempt ledgers

Every logical request and attempt has a stable harness ID. Every wire event
records block, cell, variant, loop discipline, scheduled start, actual send,
reply or timeout time, method, code, retry/poll classification, parent logical
request, and terminal disposition.

For each retained repetition, count form must reconcile before rates are
computed:

```text
logical requests offered
  = completed with vectors
  + terminal rejections
  + timed out
  + in flight at window end
```

The rate report therefore satisfies:

```text
λ_off = X + terminal rejections + timeouts ± in-flight
```

The sign on in-flight records whether the report uses starts or settled work;
the manifest states the convention. The raw count equality is authoritative.

For every logical request, the mutually exclusive attempt ledger satisfies:

```text
attempts = successes + retryable rejections + timeouts + polls
```

Here `successes` means successful non-poll wire calls; every `embed.result`
attempt is classified as a poll, including a poll that returns vectors. The
same gate validates X and A. Method subtotals must sum to the all-method ledger.

A repetition that violates either equality is an instrumentation bug. Exclude
it from every estimate, keep its raw data under the run's `invalid/` area, and
record the failed equality and discrepancy in the manifest. Never silently
replace it. Stop treatment collection, repair instrumentation, and start a new
versioned collection if the fixed block schedule can no longer be completed.

## USL applicability gate

USL (σ, κ) is fitted only after the applicability gate passes: **≥6 closed-loop
levels, zero in-window rejections and timeouts, stationary service time, ≥5 reps
with CIs**. Otherwise the run record must state:

```text
USL not applicable — <failed condition>
```

USL is diagnostic only and never primary acceptance evidence. Open-loop query
and mixed-load arms use load-response and queueing analysis instead.

## Run records and admissibility

Each collection uses `docs/perf/runs/<name>-<commit>/` and contains at least:

- `environment.txt` with host, kernel, CPU topology, load before each block,
  rustc, Bun, commit, artifact hashes, process arrangement, and pinned config;
- a manifest with factors, levels, pilot-frozen fields, randomization seed and
  order, block/restart boundaries, timing conventions, warmup, constants-parity
  result, KTD9 acceptance, and all evidence-gate results;
- raw logical-request, attempt, service-time, and `/proc` samples;
- invalid repetitions retained with reasons;
- absolute summaries, ratios, uncertainty, multiplicity results, and the USL
  gate result; and
- candidate and rejected alternatives, residual risks, and the decision or an
  explicit inconclusive or engine-bound result.

A hypothetical repetition is admissible only if it uses a pinned artifact and
environment, one frozen matrix cell, the declared loop timing, the warm-state
rule, the fixed block schedule, matching client/host constants, and passing
logical-request and attempt ledgers. Missing raw samples, silent replacement,
an unfrozen placeholder, or a failed evidence gate makes it inadmissible.

## KTD9 owner acceptance

Owner acceptance recorded 2026-08-26: the user's explicit request to implement
this accepted plan constitutes acceptance of KTD9's in-process generator/SUT
arrangement for U7. The harness may run generator and host in one process. It
must preserve scheduled-send open-loop timing, record the arrangement in every
manifest, and exclude generator threads from R15 host-thread attribution. A
process-separation arm is not required before treatment collection.

## Selection basis: `magic-context-s64` acceptance criteria

The following nine criteria are transcribed verbatim from
`bd show magic-context-s64` and are the basis U7 must cite:

1. The claim and reporting contract are frozen before treatment collection: logical-request and
   attempt boundaries, workload/arrival semantics, warm state, target population, outcome family,
   ratio orientation, and exploratory metrics are explicit.
2. Wire-side accounting is the sole attribution source (no host metrics dependency); every retained
   run satisfies `offered = completed + terminal rejection + timeout ± in-flight`.
3. Tiny-engine burst and open-loop matrices retain raw samples and show whether the 100 ms retry mode
   and 50 ms pending-poll mode remain. Report absolute p50/p90/p95/p99/max, attempt amplification,
   poll distribution, deadline success, and goodput with uncertainty. Do not invent a pass threshold.
4. Candidate queue bounds and retry/poll budgets are derived from measured service demand and the
   stated delay/blocking objective through queueing theory, then implemented under `bounded-design`
   and `retry-backoff-jitter`; behavior at full remains explicit `queue_full`.
5. No candidate busy-polls: minimum delay is enforced, CPU-seconds and wakeup/poll rates are reported,
   and resource shifts are included beside latency. A repository verdict requires a separate,
   owner-authored performance policy; absent one, report evidence only.
6. Deterministic tests pass for deadline expiry while waiting (zero engine calls), shutdown while
   waiting (`cancelled`), route loss while queued (zero engine work), bound+1 rejection, jitter bounds,
   poll escalation, and unchanged `idempotency_conflict` / `module_restarted` behavior.
7. USL is either run only after its applicability gate passes or marked not applicable with the exact
   failed condition. Open query and mixed-load arms use load-response and queueing analysis instead.
8. A production-bundle confirmatory run uses one pinned commit/artifact/host schedule and reports
   whether the tiny-engine mechanism survives realistic service demand; all failed attempts retained.
9. `docs/perf/` retains the frozen contract, run manifest, raw evidence references, candidate and
   rejected alternatives, residual risks, and the decision or explicit inconclusive result.

## Verification contract

U1 is a documentation artifact and adds no executable test. U7 and U8 enforce
it through these checks:

| Check | Command or evidence |
| --- | --- |
| Host deterministic tests | `cargo test -p mc-host` |
| Plugin tests | `bun test` in `packages/plugin` |
| Plugin types | `bun run --cwd packages/plugin typecheck` |
| Lint | `bun run --cwd packages/plugin lint`; `cargo clippy -p mc-host` |
| Harness cells | `cargo run --release -p mc-host --example synapse_perf -- <cell args>` |
| Evidence gates | accounting and attempt-ledger invariants per retained repetition; censoring bound; USL gate; pre-treatment constants parity; KTD9 acceptance |

No test asserts a latency threshold. Every new deterministic test uses virtual
time rather than wall-clock sleeps.
