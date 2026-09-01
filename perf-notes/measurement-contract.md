# Scope Algebra Measurement Contract

- Outcome: Criterion mean operation time for each named benchmark cell.
- Metric: unweighted geometric mean of `baseline_time / candidate_time` across all 76 cells.
- Population: this checkout, rustc 1.98.0, Linux x86-64, Intel Xeon Platinum 8488C host.
- Timing boundary: benchmark operation only; deterministic repository construction is outside it.
- Warm state: Criterion warmup plus one explicit prewarm for snapshot fixtures. "Cold batch" means
  a fresh applicability engine/cache, not cold filesystem pages.
- Units: one full benchmark process is an analysis unit; Criterion samples and iterations are
  subsamples. Shared page cache, CPU frequency, and host load are interference sources.
- Assignment: fixed baseline followed by candidate. Suspicious results require fresh-process
  ABBA confirmation; no decision uses an incomplete block.
- Stopping: fixed Criterion run. No optional stopping. A structural scaling win may be kept when
  relevant cells improve beyond A/A drift and no adversarial cell regresses beyond it.
- Reporting: retain the geometric mean and touched per-cell means/confidence intervals. The
  aggregate never replaces per-cell results.

Iteration 0 ran at host load averages 15.56/12.18/12.11 on a 192-logical-CPU, two-NUMA-node host.
The governor was unavailable through the cpufreq sysfs path. The identical-artifact A/A run
reported a 0.992000 geometric mean; individual unchanged cells moved in both directions by roughly
5%, with one noisy warm-batch cell reaching about 7%.

The suite grew from 37 to 52 and finally 76 cells. Historical entries call the final composition
"75-cell"; a completion audit counted 76 `main/estimates.json` files and 76 benchmark results:
17 algebra, 13 ancestry, 3 snapshot, 4 tracked snapshot-matrix, 4 payload-decode, 3 cheap-check,
19 batch, 6 anchor-density, 3 payload-check, 1 staleness, and 3 adversarial cells.

The final ancestry audit pins both artifacts to CPU 190. Unpinned historical ancestry comparisons
remain useful as campaign evidence, but do not override the pinned direct comparisons when host
load or CPU migration changes between artifacts.
