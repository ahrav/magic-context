# Synapse tail U7 evidence run

## Result

Status: **INCONCLUSIVE. No variant selected.** All 576 A/A schedule positions
and all 2,304 treatment positions were attempted sequentially with fresh
processes. The valid evidence does show both target mechanisms, but the frozen
schedule did not produce enough admissible complete cells to apply the
nine-criterion selection procedure. This is a measurement-harness result, not
an engine-bound result.

The run used commit `af8ef1264f5af48fc8e27a8115b804a2a66d50f1` and release
artifact SHA-256
`3524f6744a8ddda4afebf876be6b85cd26ed34c15bd758c7280adef82a241ba7`.
`SHA256SUMS` covers the local ignored bundle.

## Schedule and validation

| Phase | Required | Attempted | Valid | Invalid |
| --- | ---: | ---: | ---: | ---: |
| Pre-treatment calibration | 4 | 4 | 4 | 0 |
| Byte-identical A/A | 576 | 576 | 299 | 277 |
| Treatment matrix | 2,304 | 2,304 | 1,244 | 1,060 |

Every one of the 2,084 emitted summaries passed both ledgers. Raw logical and
attempt row counts matched every emitted summary, and raw service-sample counts
matched every service summary. Invalid attempts remain in place with stdout,
stderr, status, argv, timestamps, and external label; `invalid/index.json`
indexes them. Terminal rejection did not count as censoring.

Ten frozen rates cannot pass the harness's exact-nanosecond-interval parser:
zero-delay 3,000 and 6,000/s; 5 ms rates 49, 99, 148, 198, 297, and 396/s; and
25 ms rates 30 and 60/s. This accounts for 160 A/A and 640 treatment positions
without summaries. Among treatment positions with summaries, 414 had fatal
errors and six additional positions failed solely on missed scheduled slots.
No invalid position was replaced.

The calibration retained two raw blocks. Mean service demand was 5.0563266 ms
at the 5 ms injection and 25.0605536 ms at the 25 ms injection. Round-half-up
application of factors `{0.25,0.5,0.75,1,1.5,2}` produced rates
`{49,99,148,198,297,396}` and `{10,20,30,40,60,80}` per second. Zero-delay
rates used the frozen `{1000,2000,3000,4000,6000,8000}` schedule.

## A/A control

Both external labels executed `--variant hygiene-only` against the same binary
hash. There were 141 paired valid cells. Median left/right ratios were 1.0001
for logical p95, 1.0 for goodput, deadline success, and amplification. The full
range was not stable: logical-p95 ratio ranged from 0.757 to 77.815 and goodput
ratio from 0.464 to 1.468. Mechanical binary identity passed, but required
schedule validity and null stability did not. No noise floor is inferred.

## Descriptive mechanism evidence

At closed-loop concurrency 1 and 5 ms service, hygiene-only batch p95 was
51.5-52.0 ms for all three shapes. C reduced it to 13.5-14.1 ms without changing
attempt count. At 25 ms, C reduced p95 from 51.6-52.0 ms to 30.8-31.4 ms, but
added one poll per logical request. At approximately zero delay, C imposed its
roughly 2 ms fast-first delay and therefore regressed the already-ready 1x16
and 1x64 paths. Host voluntary context switches also increased: across the
three shapes and two blocks, 5 ms C recorded 802-1,235 versus 223-349 for
hygiene-only; 25 ms C recorded 431-625 versus 227-350. CPU tick resolution was
too coarse for a stronger CPU claim.

At the valid 25 ms, 40/s query point, baseline p95 was 531.6-733.0 ms with
amplification 3.10-3.15. A with K=1 reported p95 28.6-28.9 ms,
amplification 1.0, and p95 permit wait 3.5-3.9 ms. K=2 reported p95
28.7-29.1 ms and p95 permit wait 3.7-4.1 ms. All three arms had zero terminal
rejection, so the contract's strict “lower terminal blocking” K objective did
not distinguish K. K=1 remains the smallest startup-feasible positive bound,
but this run does not select it. The 5 ms 1.0x point at 198/s was not executable.

`analysis/valid-cell-summaries.csv` contains absolute p50/p90/p95/p99/max,
deadline success, goodput X, amplification, poll and permit-wait distributions,
mean S/CV, and host CPU/context-switch deltas for every valid position.
`analysis/two-block-descriptive.json` retains both block values and ranges for
574 complete valid cells.

## Gates and nine-criterion decision

1. Frozen contract: passed.
2. Wire ledgers and retained raw-row validation: passed for every emitted summary.
3. Complete admissible tiny-engine matrix: failed.
4. Finite K and measured service demand: recorded, but the frozen blocking objective could not select K.
5. Resource observations: reported for valid cells; complete no-busy-poll matrix unavailable.
6. Deterministic Rust and plugin tests: passed.
7. `USL not applicable — two repetitions without confidence intervals; gate requires at least five repetitions with CIs`.
8. Production bundle: gate-blocked by `magic-context-c50.8`, which remains in progress.
9. Evidence, rejected alternatives, residual risks, and explicit inconclusive result: retained here and in the tracked summary.

No candidate can be selected from this epoch. A, C, and A+C remain plausible;
B and hygiene-only remain references. D remains out of scope because it needs a
completion notifier and per-method handler accounting. Push remains out of
scope. Residual risks are null instability, unsupported exact rates, batch job
eviction and connection failure at high load, coarse CPU ticks, missing
per-block load samples, and absent production-bundle confirmation.

## Verification

- `cargo test -p mc-host`: passed.
- `bun test` in `packages/plugin`: passed.
- `bun run --cwd packages/plugin typecheck`: passed.
- `bun run --cwd packages/plugin lint`: passed with five warnings.
- `cargo clippy -p mc-host`: passed.
- `sha256sum -c SHA256SUMS`: passed from the evidence directory.

## Post-collection redaction

The collection host's name in `environment.txt` and the absolute paths in
`calibration.json` were replaced with `<redacted: collection host>` and `<repo>`
when this bundle moved into version control in a public repository. The
`SHA256SUMS` was refreshed for exactly the derived files changed after
collection: those two, plus this report, which this disclosure modifies. Every
other digest, including every raw sample, is original. The commit, artifact hash, kernel,
architecture, and toolchain versions needed to reproduce a cell are all retained.
`analyze.py`, `select.py`, and `run_matrix.py` are unaltered, so they remain the
scripts that produced this evidence.
