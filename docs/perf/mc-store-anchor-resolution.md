# mc-store anchor-resolution benchmarks

`crates/mc-store/benches/anchor_resolution.rs` measures the applicability
kernel's two public entry points against gix-built fixture repositories:
`snapshot_checkout` (checkout snapshot + dirty scan) and the
`ResolutionLadder` (`new` + `evaluate`) over one `GitCondition`. This doc is
intentionally local: `docs/perf/` is gitignored, and the numbers below are
host- and build-specific.

## Claim under measurement

- **Outcome**: wall-clock service time of one synchronous, single-threaded,
  in-process call at a fixed fixture point. No arrival model (local operation
  microbenchmark); no queueing, IPC, or host encoding.
- **Timing boundary**:
  - `snapshot` group: `snapshot_checkout(path, &budget)` entry → return. The
    returned `CheckoutSnapshot` is dropped outside the timed section
    (`iter_batched` batch output), so repository-handle teardown is excluded.
  - `evaluate` group: `ResolutionLadder::new(&snapshot, &budget)` +
    `evaluate(&condition)` per iteration — a cold ladder per call, matching
    the once-per-request construction in the kernel. Ladder drop (its
    ancestry cache and candidate window) happens inside the timed loop; it is
    part of the per-request cost. The snapshot is built once outside.
    `warm_exact_reachable` is the one exception: the ladder is constructed
    once outside the loop, so the cell times a cache-hit evaluation only.
- **Warm/cold**: warm process, tmpfs corpus (fixtures under `/tmp` via
  `tempfile`), page cache unmissable. Object store is loose objects only —
  no packfile, no commit-graph (the fixture kit writes individual objects).
  `EvalBudget::unbounded()` throughout: no deadline, no interrupt, so budget
  polling is a relaxed atomic load per step.
- **Estimand**: Criterion's mean per-iteration time with its 95% confidence
  interval, per cell. One estimator for every reported number. Cells are
  reported individually and never aggregated.
- **Population**: per-call, explicitly NOT per-request. No production caller
  exists yet, so the number of `evaluate` calls per request (anchors per
  session, conditions per anchor) is unknown. Do not multiply these numbers
  into a request budget without that multiplicity.

## Corpus

All fixtures are deterministic: the kit commits carry a fixed signature and
caller-supplied timestamps, so OIDs are stable across runs. All measured
operations are read-only against the repository; fixtures are built once per
cell, outside timing.

- **snapshot group**: 100 tracked files (~230 B each, under `src/`),
  committed once and materialized. `materialize` rebuilds the index from the
  tree with default stat data, so every snapshot content-compares all 100
  tracked files even when clean — the worst-case stat-invalidated scan. That
  floor is shared by all four cells; the dirty axis varies on top of it.
  Cell deltas against `dirty_000` isolate the dirty-entry cost.
- **evaluate group**: linear first-parent histories built from a root commit
  plus filler commits that each change exactly one file (`filler.txt`), so
  every commit has a unique tree. Rebase shapes keep the anchored commit
  reachable only from a `topic` ref (present in the odb, unreachable from
  HEAD) — the state a reflog leaves after a real rebase — and re-parent the
  same diff onto an advanced `main`.

## Groups

| Cell | Shape | Asserted outcome / rung |
| --- | --- | --- |
| `snapshot/dirty_000` | clean checkout, 100 tracked files | snapshot ok, 0 dirty entries |
| `snapshot/dirty_010` | 10 modified tracked files (~230 B) | snapshot ok, 10 dirty entries |
| `snapshot/dirty_100` | 100 modified tracked files (~230 B) | snapshot ok, 100 dirty entries |
| `snapshot/dirty_large_4mib` | 1 untracked 4 MiB file | snapshot ok, 1 untracked entry |
| `evaluate/exact_reachable` | 64-commit linear history, anchor = root, no captures | `Holds` via ancestry (window rungs cannot fire) |
| `evaluate/ancestry_negative` | anchor on unmerged side branch, no captures | `DoesNotHold { historical: false }` — pure negative ancestry walk |
| `evaluate/patch_id_rung_064` | rebase shape, match at window index 32, depth 65 | `Holds` via patch-ID; empty-captures run proves ancestry answers DoesNotHold; capture tree ≠ any window tree |
| `evaluate/patch_id_rung_512` | rebase shape, match at window index 504, depth 510 (`CANDIDATE_WINDOW` = 512) | same proofs as `_064` |
| `evaluate/tree_hash_rung` | anchor OID absent from odb, capture has `tree_oid`, `patch_id: None`, match 32 deep in 64 window | `Holds` via tree-hash; empty-captures run proves `Uncertain` |
| `evaluate/warm_exact_reachable` | same fixture as `exact_reachable`, ladder built once outside the loop | `Holds`; times the warm ancestry cache |

Sample size 20 and ~5 s measurement time per cell keep the full suite at a
few minutes of wall time.

## Running

```bash
cargo test -p mc-store                                    # wiring stays green
cargo bench -p mc-store --bench anchor_resolution         # full suite
cargo bench -p mc-store --bench anchor_resolution -- 'evaluate'
cargo bench -p mc-store --bench anchor_resolution -- 'patch_id'
```

## Comparing a change

Criterion samples within one process are subsamples, not independent runs:
they cannot capture process-, build-, or host-level variation. For a
before/after decision:

1. `cargo bench -p mc-store --bench anchor_resolution -- --save-baseline before`
2. Apply the change.
3. `cargo bench -p mc-store --bench anchor_resolution -- --baseline before`
4. Repeat the pair across ≥3 fresh process invocations before believing
   effects under ~5%. Run an A/A first (steps 1+3 with no change): treat any
   A/A delta as the floor below which differences are noise for that host.

## Known gaps

- **Per-request multiplicity unknown.** No production caller exists; a
  request may evaluate many conditions against one snapshot, and only
  `warm_exact_reachable` measures the intra-ladder cache effect that
  multiplicity would exercise.
- **Packed/commit-graph object stores uncovered.** Fixtures hold loose
  objects only. Real checkouts usually have packfiles and often a
  commit-graph, which change both ancestry-walk and object-access cost.
- **Dirty-byte distribution unknown.** The modified-file cells use ~230 B
  files and the untracked cell one 4 MiB blob; real dirty sets mix sizes and
  statuses. The fixture index also carries default stat data (see Corpus), so
  the clean-scan floor is the stat-invalidated worst case, not the
  stat-clean fast path.
- **Allocation axis not instrumented.** Cells time wall clock only; no
  per-cell allocation counts.
- **Shared 192-vCPU host, no isolation.** No core pinning, no frequency
  pinning, other tenants present. Sub-5% deltas need the replication
  protocol above.

## Recorded baseline: phase0 (2026-08-31)

Single host (shared 192-vCPU, no isolation), single process per run, scratch
checkout of commit `f986676` plus this harness (three files: bench, Cargo.toml
wiring, this doc). Criterion baseline name: `phase0`. All numbers are
Criterion means with 95% CIs from stdout. Bench wall time: 146 s for the
save-baseline run (includes the release build), 99 s for the A/A run.

| Cell | phase0 mean [95% CI] |
| --- | --- |
| `snapshot/dirty_000` | 4.3452 ms [4.2882, 4.4039] |
| `snapshot/dirty_010` | 4.4420 ms [4.3581, 4.5474] |
| `snapshot/dirty_100` | 4.2319 ms [4.1645, 4.3148] |
| `snapshot/dirty_large_4mib` | 4.0420 ms [4.0229, 4.0691] |
| `evaluate/exact_reachable` | 821.81 µs [820.82, 823.38] |
| `evaluate/ancestry_negative` | 827.45 µs [825.85, 829.07] |
| `evaluate/patch_id_rung_064` | 4.7404 ms [4.7288, 4.7561] |
| `evaluate/patch_id_rung_512` | 38.276 ms [38.204, 38.368] |
| `evaluate/tree_hash_rung` | 1.5652 ms [1.5612, 1.5701] |
| `evaluate/warm_exact_reachable` | 11.467 µs [11.438, 11.503] |

Reading the shapes:

- The four `snapshot` cells sit within ~10% of each other (~4.0–4.4 ms).
  The 100-file stat-invalidated rehash floor plus repository open dominates;
  neither 100 modified files nor one 4 MiB untracked hash moves the cell
  outside that band. Isolating the dirty axis needs a stat-clean index
  fixture (see Known gaps).
- `warm_exact_reachable` (11.5 µs) vs `exact_reachable` (822 µs): the
  ladder's interior ancestry cache removes ~99% of a repeated identical
  evaluation. Per-request cost is therefore dominated by the first
  evaluation per (anchor, HEAD) pair.
- `patch_id_rung_512` (38.3 ms) ≈ 8× `patch_id_rung_064` (4.74 ms), tracking
  the ~8× window depth (510 vs 65): the full-window walk plus the per-cold-
  ladder ancestry walk scales linearly at these depths.

### A/A pass (same binary, `--baseline phase0`)

| Cell | A/A mean | Mean change [95% CI] | Criterion verdict |
| --- | --- | --- | --- |
| `snapshot/dirty_000` | 4.2319 ms | −2.20% [−4.07, −0.30] | within noise threshold |
| `snapshot/dirty_010` | 4.2963 ms | −2.83% [−5.09, −0.54] | within noise threshold |
| `snapshot/dirty_100` | 4.1000 ms | −5.56% [−7.55, −3.56] | flagged: improved |
| `snapshot/dirty_large_4mib` | 4.1437 ms | +1.19% [+0.38, +2.09] | within noise threshold |
| `evaluate/exact_reachable` | 867.91 µs | +4.43% [+3.01, +6.27] | flagged: regressed |
| `evaluate/ancestry_negative` | 862.97 µs | +4.23% [+3.23, +5.32] | flagged: regressed |
| `evaluate/patch_id_rung_064` | 4.9937 ms | +5.06% [+4.15, +5.94] | flagged: regressed |
| `evaluate/patch_id_rung_512` | 40.211 ms | +4.99% [+3.93, +6.31] | flagged: regressed |
| `evaluate/tree_hash_rung` | 1.6241 ms | +7.51% [+3.66, +11.76] | flagged: regressed |
| `evaluate/warm_exact_reachable` | 12.255 µs | +6.10% [+5.07, +7.10] | flagged: regressed |

The A/A pass compares the identical binary against its own baseline, so
every flagged verdict above is a false positive and defines this host's
noise floor: **~±7% per cell, with correlated drift** (the entire `evaluate`
group moved +4–7% in the same direction within one process, so the drift is
process- or host-level, not per-cell). Criterion's within-process p-values
flagged 7 of 10 identical cells as changed. Consequences:

- Treat single-pair deltas under ~8% on this host as unresolved.
- Criterion's regressed/improved verdicts are not decision-grade here;
  compare means across ≥3 fresh process invocations per arm.


## Phase log (perf-pipeline campaign, 2026-08-31)

- phase0 = f986676 (PR 149 head). Baseline + A/A recorded above; A/A floor ~±7-8% correlated.
- phase1 = dfda2c866 (external review-findings commit). Evaluate cells improved 95-98.5%
  (patch-ID memo, merge-base ancestry, Rc window, 4 MiB object cache). Snapshot cells within noise.
- phase2 = phase1 + STATUS_SCAN_THREAD_CAP=4 (kept round). snapshot/dirty_000 -69%,
  dirty_010 -72%, dirty_100 -54%, dirty_large_4mib -10% (SHA-256 floor ~2.3 ms of that cell).
  Sweep: cap 2 = 1.54 ms, cap 4 = 1.40 ms, cap 8 = 1.49 ms on dirty_000 at 192 visible CPUs.
- Residual dirty_000 (~1.39 ms) is diffuse per-call gix machinery (alloc/copy churn, index
  decode + SHA-1 checksum, config parse, zlib); no single lever >=3% of the cell remains.
- Named criterion baselines retained: phase0, phase1, probe192/probe4/probe1/probeArena*/sweep*.
