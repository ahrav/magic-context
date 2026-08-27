# Synapse tail U7 evidence run (definitive epoch)

## Result

Status: **PROVISIONAL SELECTION — variant `a+c` with `K=1`.** Every frozen A/A
and treatment schedule position was attempted sequentially with a fresh process
per cell. Eight of the nine acceptance criteria pass; criterion 8 (the
production-bundle confirmatory run) is gate-blocked because `magic-context-c50.8`
remains in progress, so the selection is recorded as provisional per the frozen
stop condition, with R16 named as the unmet gate.

The run used commit `881be45b552625935a6b725a7ef830165a4c2f00` and release
artifact SHA-256
`304571f903697540689d755497f098b1db25cd6f7511868c5801abb76665aa66`.
`SHA256SUMS` covers the local ignored bundle. Prior epochs `6e5ffc03` (pilot)
and `af8ef126` (inconclusive) are untouched.

## Schedule and validation

| Phase | Required | Attempted | Valid | Invalid |
| --- | ---: | ---: | ---: | ---: |
| Pre-treatment calibration | 4 | 4 | 4 | 0 |
| Byte-identical A/A | 576 | 576 | 570 | 6 |
| Treatment matrix | 2,304 | 2,304 | 2,288 | 16 |

Collection ran 2026-08-26 22:15:21Z to 23:21:42Z (66 minutes 21 seconds wall,
3,934.6 seconds summed cell time). Load average was sampled before every phase
block (`block_loadavg.ndjson`; the af8ef126 epoch flagged this as missing).

All 2,884 emitted summaries passed both ledgers, raw logical/attempt row
counts, and raw service-sample counts. Every one of the 22 invalid positions
failed solely on missed scheduled slots (1–2 slots out of 3,000–8,000 at
zero-delay high rates, plus one 5 ms 396/s cell); there were zero fatal errors,
zero connection losses, zero ledger failures, and zero missing summaries. All
invalid evidence is retained in place and indexed by `invalid/index.json`; no
position was replaced. 1,137 of 1,152 treatment cells have both blocks valid;
14 cells have one valid block; one cell (`b`, batch 4×16-paged, open 8,000/s,
zero delay) lost both blocks to single missed slots.

Every frozen rate was executable this epoch. Calibration reproduced the
af8ef126 rates exactly: mean S 5.0567 ms → rates {49,99,148,198,297,396}/s and
25.0595 ms → {10,20,30,40,60,80}/s (round half up); zero-delay used the frozen
{1000,2000,3000,4000,6000,8000}/s with a 4,000/s reference capacity.

## A/A control — STABLE

Both labels executed `--variant hygiene-only` against one binary hash. 570/576
positions valid, 284/288 pairs complete. Median left/right ratios: logical p95
1.0002, goodput 1.0, deadline success 1.0, amplification 1.0. 269/284 p95
pairs within ±10%, 283/284 within 2×. Of the 15 pairs outside ±10%, nine have
both p95 below 2 ms (timer-resolution scale) and the single extreme (4.98) is
a closed-loop 25 ms query cell whose p95 straddles the 100 ms retry step under
the one-second hold. No label-dependent offset, no accounting mismatch. The
measurement system is accepted for selection; no noise threshold is inferred.

## Mechanism evidence (candidate / hygiene-only, hygiene-only as reference)

Query staircase (open loop, 1.0× reference):

| Cell | hygiene-only | a K=1 | ratio |
| --- | --- | --- | --- |
| 5 ms S, 198/s p95 | 585.2 ms | 10.0 ms | 0.017 |
| 5 ms S, 198/s terminal blocking | 0.187 | 0 | 0 |
| 25 ms S, 40/s p95 | 541.4 ms | 28.5 ms | 0.053 |
| 25 ms S, 40/s amplification | 2.35 | 1.00 | 0.43 |

Permit-wait p95 for admitted waiters: 3.5–6.7 ms across K∈{1,2} and both
delays — far below the descriptive 100 ms budget. The previously unexecutable
5 ms 1.0× point (198/s) is now measured.

Poll quantization (batch, closed-loop concurrency 1): C cuts p95 from
51.5–51.6 ms to 13.5–13.7 ms at 5 ms S with identical attempt counts, and to
30.7–30.8 ms at 25 ms S with one added poll. At approximately zero delay C
imposes its ~2 ms fast-first delay (p95 0.18→2.29 ms for 1×16, 0.35→2.44 ms
for 1×64) — recorded as a trade-off. `a+c` reproduces both effects in one arm.

Overload stays explicit and bounded: at 2.0× query load, `a+c` K=1 rejects
29–30 of 80 offered as terminal `queue_full` with amplification 3.2 and p95
327–329 ms, versus baseline's zero rejection, amplification 7.35, and p95
1.44–1.65 s. Maximum amplification anywhere in the `a+c` arm is 17.8 (batch
4×16-paged, 25 ms S, 2.0×), bounded by the 4-attempt budget and the
deadline-clamped escalating poll schedule (poll max 27).

Resource shifts: C roughly doubles voluntary context switches at 25 ms S
(433–444 vs 220–230 per hold) and ~3.7× at 5 ms S; host CPU ticks stay at
zero-to-single-digit in these cells. The 10 ms escalation floor is enforced;
the once-per-job fast-first delay is exempt per R10. No busy-polling.

`analysis/valid-cell-summaries.csv` holds absolute p50/p90/p95/p99/max,
deadline success, goodput X, amplification, poll and permit-wait
distributions, mean S/CV, and host CPU/context-switch deltas for all 2,288
valid positions. `analysis/two-block-descriptive.json` retains both block
values and ranges for 1,137 complete cells. `analysis/contrasts.csv` holds all
1,007 candidate-versus-hygiene-only paired ratios.

## Queue objective and K

At the 1.0× derivation points, hygiene-only terminal blocking was 0.187 (5 ms)
and 0.163 (25 ms); A with K=1 and K=2 measured zero terminal blocking, and
model-guided M/M/1/K blocking at ρ=1 (K=1 → 1/3, K=2 → 1/4) improves on the
measured baseline attempt-level rejection while model-guided wait (≤ K × mean
S) stays below 100 ms. Pre-change baseline shows zero *terminal* blocking at
1.0× only because it retries without an attempt budget (amplification
3.11–4.21, p95 0.58–1.07 s); the strict lower-terminal-blocking reading
therefore ties at zero, and the K choice rests on the frozen model-guided rule.
**K=1 is the smallest feasible positive bound** (startup scratch validation
accepts {1,2}, rejects 3); K=2 was exercised as the adjacent level and is
indistinguishable at 1.0×.

## Gates and nine-criterion decision

1. Frozen contract: **pass** (no decision-rule change; no annotation needed —
   every frozen rate executed and calibration reproduced the frozen rates).
2. Wire-side accounting sole attribution source; count form holds for every
   retained repetition: **pass**.
3. Matrices retained raw samples and show both modes with absolute quantiles
   and two-block uncertainty; no invented threshold: **pass**.
4. Bounds derived from measured service demand and the frozen objective via
   M/M/1/K guidance; behavior at full remains explicit `queue_full`: **pass**.
5. No candidate busy-polls; CPU-seconds and wakeup/poll rates reported beside
   latency; resource shifts recorded; evidence only, no repository verdict:
   **pass**.
6. Deterministic tests: `cargo test -p mc-host` 584 passed; plugin `bun test`
   5,481 passed; typecheck clean; lint 5 warnings; clippy clean: **pass**.
7. `USL not applicable — two repetitions without confidence intervals; gate
   requires at least five repetitions with CIs`: **pass** (correctly marked).
8. Production-bundle confirmatory run: **gate-blocked** — `magic-context-c50.8`
   IN_PROGRESS. Selection recorded as provisional; R16 named as the unmet gate.
9. Evidence, rejected alternatives, residual risks, and the decision retained
   under `docs/perf/`: **pass**.

Selected: **`a+c` with K=1**, provisional on criterion 8. A alone leaves the
50 ms poll quantization; C alone leaves the query staircase; B keeps loss
semantics (terminal blocking 0.15–0.25 at 1.0×); K=2 adds nothing at 1.0×.
Rejected alternatives unchanged: D needs a completion notifier and per-method
handler accounting; push (E) is a separate protocol change; unbounded queues,
waiters, or deadline extension remain prohibited.

Residual risks: the ~2 ms fast-first regression on already-ready batch paths;
increased voluntary context switches and polls under C; single-missed-slot
invalidity at extreme zero-delay rates (5 of 6 zero-valid or single-block cells
sit at 8,000/s); coarse CPU tick resolution; heavy-tailed A/A dispersion in
sub-2 ms and staircase-bimodal cells; and no production-bundle confirmation
until c50.8 lands. No production bundle was built or run (U8 gated).

## Verification

- `cargo test -p mc-host`: 584 passed, 0 failed.
- `bun test` in `packages/plugin`: 5,481 passed, 0 failed.
- `bun run --cwd packages/plugin typecheck`: passed.
- `bun run --cwd packages/plugin lint`: passed with five warnings.
- `cargo clippy -p mc-host`: passed.
- `SHA256SUMS`: written over every file in this bundle.

## Beads states at collection

`magic-context-18r` OPEN, `magic-context-chj` OPEN, `magic-context-ioi` OPEN,
`magic-context-c50.8` IN_PROGRESS (blocks U8).


## Warmup re-analysis

The original epoch analysis did not apply the frozen warm-state exclusion: each
independent block must discard the first 10% of its one-second scheduled hold.
This is a reporting deviation, not a collection change. The rule was frozen
before treatment collection. `analysis/warmup_reanalysis.py` applies it
post-hoc from retained raw timestamps without recollecting or changing any
raw row. For every already-valid A/A (570) and treatment (2,288) position, it
sets the hold start to the first `scheduled_start_ns` for open loop or first
`actual_first_send_ns` for closed loop, excludes starts before 100 ms, retains
linked attempts only, and recomputes logical p50/p90/p95/p99/max,
amplification, terminal rejection and timeout, deadline success, goodput,
poll distribution, and permit wait. Every post-warmup logical and attempt
ledger reconciles. Raw warmup rows remain in their original NDJSON files.

### Boundary reconstruction is approximate

The reconstruction above is not an exact application of the frozen rule, and the
retained rows cannot make it one. The `881be45b` harness took the closed-loop
hold origin as `Instant::now()` before spawning its workers
(`let end = Instant::now() + Duration::from_secs(seconds)`) and never emitted it,
so no `hold_window_start_ns` exists in this bundle. The script therefore
substitutes the earliest observed start — `min(actual_first_send_ns)` for closed
loop — which cannot precede the true origin: workers still have to be spawned and
reach the socket first.

The error has a known sign. Both the 10% cutoff and the effective hold end land
later than the frozen boundaries by that startup delay, so some startup interval
is classified as measured rather than warmup, and an equal tail of post-boundary
sends is admitted. Open-loop cells are unaffected in the same way, since
`scheduled_start_ns` is an intended schedule rather than an observation.

Read this section as an approximate correction that leaves the headline
directions, A/A medians, and K=1 feasibility intact, not as evidence that the
frozen exclusion was applied exactly. Applying it exactly requires recollection
with the boundaries emitted, which later harness versions do
(`hold_window_start_ns`, `warmup_end_ns`, `hold_window_end_ns`, and a per-row
`window` class).

### Post-collection redaction and retained-tooling limits

Two kinds of alteration and non-alteration are recorded here so a reader knows
exactly what in this bundle is original.

Redacted after collection, when the bundle moved from local-only into version
control in a public repository: the collection host's name in `environment.txt`
and the absolute working-directory and executable paths in `calibration.json`,
replaced by `<redacted: collection host>` and `<repo>`. Neither is needed to
reproduce a cell — the commit, artifact hash, kernel, architecture, and toolchain
versions that identify the environment are all retained. The `SHA256SUMS` entries
for those two files were recomputed so the manifest stays self-consistent; every
other entry, including every raw sample file, is the original digest and still
verifies against an unmodified local bundle.

Not altered: `analyze.py`, `select.py`, and `run_matrix.py` are the scripts that
produced this evidence, so they are retained exactly as run even where review
found defects in them. Three are known and material to how far this run's numbers
can be pushed:

- `analyze.py` derives phase completeness from the number of status files without
  binding each status record one-to-one to a planned schedule entry, so a
  duplicated status record together with a missing planned position would not be
  caught by the completeness check.
- `select.py` averages candidate and hygiene-only rows independently rather than
  joining them by `block`, so a contrast in `analysis/contrasts.csv` can be an
  unpaired aggregate. This run has treatment cells with a single valid block,
  where that is the case.
- `analysis/valid-cell-summaries.csv` — the input `select.py` consumes — is written
  from the unfiltered raw summaries, so the selection inputs, the contrast table,
  and the queue objective were all computed *before* the warm-state exclusion.
  Combined with the approximate boundary reconstruction above, this means the
  warmup re-analysis confirms the direction and practical separation of the
  selection rather than recomputing the selection under the frozen rule.

`run_matrix.py` also writes into `raw` and phase directories it never creates, so
re-running it from a clean checkout needs those directories made first.

Together these are why the `a+c` K=1 selection is recorded as provisional. Putting
it on exact post-exclusion, block-paired selection inputs requires a new epoch
with the boundaries emitted, not a re-analysis of this one.

### Comparison

`analysis/warmup_reanalysis.json` contains the original and corrected result
for every valid position. Its
`max_relative_shift_per_outcome_per_arm.all_valid_cells` table gives the
maximum relative shift for each reported outcome and quantile, separately for
query and batch. The largest individual query shift is permit-wait p50:
0.328 ms to 25.188 ms (+7,573%) in an `a` K=1, closed-concurrency-8, 25 ms-S
cell. The largest individual batch shift is logical p99: 1.183 ms to 51.235
ms (+4,232%) in an `a` K=1, 1x64, open-4,000/s, zero-delay cell. These
single-cell rank changes are retained as descriptive evidence; neither is a
selection input.

The selection inputs retain their directions and practical separation:

| Input | Original analysis | Warmup re-analysis |
| --- | --- | --- |
| Query, 5 ms S, 1.0x: hygiene-only → A K=1 p95 | 585.20 → 10.00 ms | 588.14 → 10.03 ms |
| Query, 25 ms S, 1.0x: hygiene-only → A K=1 p95 | 541.37 → 28.54 ms | 608.38 → 28.63 ms |
| Same query cells: hygiene-only → A K=1 amplification | 2.467 → 1.008; 2.350 → 1.000 | 2.522 → 1.008; 2.457 → 1.000 |
| Same query cells: hygiene-only → A K=1 terminal rejection probability | 0.187 → 0; 0.163 → 0 | 0.197 → 0; 0.186 → 0 |
| Batch closed-1, 5 ms S, 1x16: hygiene-only → C p95 | 51.56 → 13.60 ms | 51.55 → 13.58 ms |
| Batch closed-1, 5 ms S, all shapes: hygiene-only → C p95 range | 51.56–52.00 → 13.60–13.94 ms | 51.55–52.01 → 13.58–13.92 ms |
| A/A left/right p95 median | 1.000216 | 1.000307 |

A/A goodput, deadline-success, and amplification medians remain 1.0. Its p95
range widens from 0.547–4.984 to 0.528–18.341 after excluding the first tenth,
but no label-dependent median offset appears. The query candidate terminal
blocking zeros remain zeros. A K=1 remains the smallest feasible positive K;
the post-warmup candidate p95 permit waits remain 4.96 ms (5 ms S) and 3.60 ms
(25 ms S), far below the descriptive 100 ms budget.

### Verdict

**Selection unchanged.** No selection input reverses direction or changes the
A/A stability, candidate-zero-blocking, or K-feasibility conclusion. The
frozen contract has no numerical materiality threshold, so this assessment
uses a change to those documented selection inputs rather than a new cutoff.
The provisional selection remains `a+c` with K=1; the production-bundle gate
remains unchanged.
