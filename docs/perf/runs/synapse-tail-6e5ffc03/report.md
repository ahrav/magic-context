# Synapse tail U7 partial run

## Result

Status: **INCOMPLETE. No variant selected.** Pilot evidence is valid for its
recorded cells, but the release harness cannot produce the full frozen R3
matrix without changing measurement instrumentation. No production bundle was
run.

The run used commit `6e5ffc03ab166b7e91f4fc5f7062cbf17bdbf2a5` and release
artifact `target/release/examples/synapse_perf`. `environment.txt` records the
machine and toolchain. `SHA256SUMS` covers the retained bundle.

## Pre-treatment gates

- KTD9: accepted by the current user request. Generator and SUT ran in one
  process. Resource rows label generator and host-runtime threads separately.
- Constants parity: passed by source inspection. Plugin and harness both use
  four total attempts, retry jitter `[base, 3*base)`, fast-first poll jitter
  `[1, 2)` ms, poll multiplier 1.6, 10 ms floor, and 50 ms default cap.
- A/A: mechanical byte-identical hygiene-only pilot paths completed twice, but
  the full randomized A/A schedule was not run because pilot blockers fired
  before treatment collection.
- Beads state: `18r`, `chj`, and `ioi` are open; `c50.8` is in progress.

## Pilot evidence

The 56 invocations produced 40 summaries. Thirty-six repetitions passed the
harness admissibility gate. Every emitted summary passed both logical and
attempt ledgers, and every summary's raw logical and attempt row counts matched
its ledger. Twenty invalid attempts remain under `invalid/`: four finite-budget
hygiene-only overload repetitions and sixteen startup rejections for K above
the resident scratch limit.

Service-time p50 and CV ranges across the two descriptive blocks were:

| Injected delay | Service-time p50 | Service CV |
| --- | ---: | ---: |
| approximately 0 ms | 0.242-4.378 microseconds | 0.222-0.358 |
| 5 ms | 5.056-5.068 ms | 0.00036-0.00098 |
| 25 ms | 25.059-25.072 ms | 0.00011-0.00045 |

At approximate 1/S query load, the pilot showed queue buildup and both target
quantization modes:

| Delay/rate | Variant | Completed | Terminal rejection | A | logical p95 | permit-wait p95 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 5 ms / 200 s^-1 | baseline | 200/200 | 0% | 3.265-3.275 | 612-712 ms | 0.18 ms |
| 5 ms / 200 s^-1 | hygiene-only | 163-171/200 | 14.5-18.5% | 2.275-2.355 | 536-570 ms | 0.18-0.19 ms |
| 5 ms / 200 s^-1 | A, K=1 | 200/200 | 0% | 1.040-1.045 | 10.11-10.15 ms | 4.98 ms |
| 5 ms / 200 s^-1 | A, K=2 | 200/200 | 0% | 1.020 | 15.00-15.04 ms | 9.90-9.91 ms |
| 25 ms / 40 s^-1 | baseline | 40/40 | 0% | 3.025-3.100 | 632-633 ms | 0.24-0.25 ms |
| 25 ms / 40 s^-1 | hygiene-only | 33-36/40 | 10.0-17.5% | 2.325-2.475 | 517-598 ms | 0.22-0.25 ms |
| 25 ms / 40 s^-1 | A, K=1 | 40/40 | 0% | 1.000 | 28.66-28.85 ms | 3.62-3.81 ms |
| 25 ms / 40 s^-1 | A, K=2 | 40/40 | 0% | 1.000 | 28.37-28.93 ms | 3.35-3.89 ms |

These are pilot observations, not treatment contrasts. They cannot select A.
They do show material queueing and a roughly 100 ms retry staircase. Batch
pilot rows also show the 50 ms pending-poll step: with 5 or 25 ms service,
1x16 and 1x64 shapes had approximately 51-52 ms logical p95 and three attempts;
the four-page shape had approximately 52 ms p95 and six attempts.

Host CPU tick deltas were mostly zero at the kernel tick resolution. Host
voluntary context switches at 5 ms/rate 200 were 1172-1196 for A, 1428-1429
for hygiene-only, and 1905-1913 for baseline. At 25 ms/rate 40 they were
231-237 for A, 288-305 for hygiene-only, and 365-369 for baseline. These pilot
resource rows show no CPU-spin signal, but they are not the required complete
matrix no-busy-poll proof.

## Frozen pilot fields

- independent blocks: 2, fixed descriptive replication;
- hold duration: 1 second;
- candidate A K levels: 1 and 2;
- no policy, MDE, power target, confidence threshold, or pass threshold.

K=3 and larger fail startup. K=3 requires 176,206,848 scratch bytes while only
174,129,408 are reservable. K=1 is the smallest feasible positive level and
K=2 is its only feasible positive neighbor.

## Exact blocker

Treatment collection did not start for three coupled reasons:

1. The harness retains only service-time quantiles and CV, not raw service-time
   samples or mean S. The required open-loop 1/S levels therefore cannot be
   derived from retained evidence.
2. Near-zero engine service is 0.242-4.378 microseconds while observed closed-
   loop logical throughput is only 147-14,900 per second. Literal 0.25x-2x 1/S
   requires hundreds of thousands to millions of in-process task starts and
   NDJSON rows per second. That exceeds the observed generator/transport
   envelope and would produce missed-slot-invalid repetitions rather than the
   declared workload.
3. The executable treats more than 1% non-completion as invalid. Required 1.5x
   and 2x overload cells intentionally produce terminal rejection above that
   level. Pilot hygiene-only rows were invalid at 10.0-18.5% rejection despite
   both ledgers holding.

Changing rates to transport capacity or accepting rejected overload rows would
change the frozen contract after pilot results. U7 scope does not authorize the
needed harness edits. Full collection is therefore blocked, not silently
rescaled.

## Gates and decision

`USL not applicable — fewer than five repetitions with CIs; the six-level
closed-loop treatment matrix was not collected.`

No nine-criterion selection is possible because criteria 3, 5, 7, and 9 need
the complete treatment matrix and criterion 4 needs retained mean S. Result is
inconclusive due to measurement-harness limits, not engine-bound. U8 remains
unchecked and `magic-context-c50.8` remains in progress.

## Verification

- `cargo test -p mc-host`: passed all executed unit, integration, and doc tests.
- `bun test` in `packages/plugin`: 5,481 passed, 0 failed.
- `bun run --cwd packages/plugin typecheck`: passed.
- `bun run --cwd packages/plugin lint`: exited successfully with five existing
  warnings and two configuration notices outside this evidence unit.
- `cargo clippy -p mc-host`: passed.
- `sha256sum -c SHA256SUMS`: passed after final report generation.

## Post-collection redaction

The collection host's name in `environment.txt` was replaced with `<redacted: collection host>`
when this bundle moved into version control in a public repository. The
`SHA256SUMS` was refreshed for exactly the derived files changed after
collection: that file, plus this report, which this disclosure modifies. Every
other digest, including every raw sample, is original. The commit, artifact hash, kernel,
architecture, and toolchain versions needed to reproduce a cell are all retained.
`analyze.py`, `select.py`, and `run_matrix.py` are unaltered, so they remain the
scripts that produced this evidence.
