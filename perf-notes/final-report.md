# Scope Algebra Performance Campaign: Final Report

## Outcome

- Worktree: `/local/home/ahrav/scratch/magic-context-scope-perf-autoresearch`
- Branch: `perf/scope-algebra-autoresearch`
- Baseline metric: `1.000000`
- Confirmed best metric: `1.791313` across 76 cells, a 79.1% geometric-mean speedup.
- Expanded-composition calibration: `1.716120`; the final best is 4.4% above that calibration.
- The earlier 52-cell peak (`2.278665`) is not comparable to the 76-cell composition.
- No code changed after the confirmed-best run; iterations 54-59 are log-only discard commits.
- Nothing was pushed and no PR was opened.

The historical log calls the expanded suite "75-cell". The completion audit counted 76 Criterion
cells. `perf-notes/measurement-contract.md` now records the authoritative composition.

## Stakeholder Numbers

These are Criterion central estimates from the committed baseline and the restored-best
confirmation. They are operation-time estimates, not service latency percentiles.

| Benchmark | Baseline | Best | Speedup |
|---|---:|---:|---:|
| `ancestry/linear-10k/near` | 165.128 us | 132.170 us | 1.25x |
| `ancestry/linear-10k/far` | 134.659 ms | 150.630 ms | 0.89x |
| `ancestry/linear-10k/unrelated` | 136.250 ms | 144.390 ms | 0.94x |
| `ancestry/linear-10k/distinct-4` | 342.779 ms | 147.980 ms | 2.32x |
| `ancestry/merge-5k/unrelated` | 69.090 ms | 86.134 ms | 0.80x |
| `snapshot/clean` | 760.832 us | 801.350 us | 0.95x |
| `snapshot/untracked-1000` | 7.452 ms | 7.815 ms | 0.95x |
| `batch/cold-plain/1` | 1.011 us | 863.370 ns | 1.17x |
| `batch/cold-plain/512` | 696.363 us | 110.380 us | 6.31x |
| `batch/warm-plain/512` | 333.328 us | 99.097 us | 3.36x |
| `batch/cold-anchored/512` | 1.568 ms | 158.760 us | 9.88x |
| `batch/warm-anchored/512` | 481.563 us | 107.770 us | 4.47x |
| `adversarial/distinct-anchors` | 8.558 ms | 8.128 ms | 1.05x |

The unpinned final ancestry run crossed different host scheduling conditions. A pinned CPU-190
audit compared the restored graph directly with rev-walk: graph far/unrelated results were flat
except one 3-4% linear-unrelated tradeoff, while near and `distinct-4` were materially faster.
Six selector/continuation variants failed controlled aggregate or near-query gates and were
discarded. The table retains the campaign's committed baseline comparison; the pinned audit owns
the final policy decision.

Snapshots remain I/O-bound full status walks. Batch benchmarks use the deterministic two-commit
applicability fixture; history-shape scaling is isolated in the ancestry group rather than claimed
as a batch latency dimension.

## Complexity Changes

- Batch digest work moved from per-candidate recomputation to fixed bytes, shared prefixes, and
  adjacent/general memos.
- Ancestry moved from independent rev-walks to a request-local reusable gix graph with generation
  cutoff when a commit graph exists; shallow repositories retain rev-walk.
- Scope dimensions and match contexts use fixed arrays and occupancy masks; semver requirements
  and normalized intervals are parsed once.
- Dirty-path overlap moved from rebuilt sets and scans to sorted binary/prefix lookup.
- Cache keys use randomized full-key prehashes, identity table hashing, shared keys/tokens, and
  compact current entries.
- Repeated payload, scope, anchor, and dirty-overlap work is memoized within the batch without
  changing observable stats charges.

## Kept Optimization Commits

- `163cc6dc9` - fixed digest bytes and per-kind batch prefixes.
- `3bc4061a5` - deduplicated repeated candidate-input digests.
- `3724247e1` - added adjacent-input locality before the general memo.
- `d7cc470c1` - reused one request-local ancestry graph with generation cutoff.
- `40603d760` - shared snapshot cache keys across multi-candidate batches.
- `ee0f4eaa9` - randomized snapshot-key prehashing.
- `1c6371764` - short-circuited definitive scope mismatches.
- `d33d8959e` - cached parsed version requirements.
- `a46704a00` - cached normalized version intervals.
- `2278a4bc6` - reused intervals for version subsumption.
- `d69fca235` - reused parsed requirements for exact/set algebra.
- `b77a42757` - parsed each canonical version requirement once.
- `06db002f7` - replaced dimension maps with fixed arrays and an occupancy mask.
- `bcc73fae8` - replaced match-context maps with fixed arrays.
- `f3dbabf69` - scanned already-sorted dirty entries without rebuilding sets.
- `6df783b33` - added sorted dirty-path binary/prefix lookup.
- `088fc0a5f` - reused adjacent decoded payloads.
- `0faf2af04` - reused adjacent canonical scopes.
- `3eed888b7` - reused adjacent scope verdicts.
- `53844ef7` - reused adjacent anchor verdicts.
- `96848e709` - reused adjacent dirty-overlap results.
- `a23422238` - reserved bounded batch-cache capacity before inserts.
- `7859d2df2` - prehashed exact object cache keys with randomized state.
- `46a43cf26` - shared object keys between cache entries and tokens.
- `403416be0` - opened generic config files once.
- `7df727897` - removed duplicate file sizing before config reads.
- `11b7a24af` - preallocated confined worktree paths.
- `ff563e077` - deferred resolved scope-context construction until a miss.
- `baa77f9d6` - canonicalized shared snapshot keys after first equality.
- `9d70a4b8c` - consumed randomized prehashes with identity table hashing.
- `705c92372` - boxed cached evidence strings.
- `a45bd12ef` - boxed optional failed checks.
- `1f3ca493b` - lazily promoted the general input-digest map.
- `ec4470a11` - boxed opaque object identifiers.
- `546b559a5` - split compact current cache entries from non-current details.

## Discarded Approaches

- Snapshot shortcuts: collect-sort, manual hash hex, streaming content hashing, and cross-request
  reuse either regressed small sets or could not prove staleness.
- Cache representations: borrowed/Cow/Arc evidence, boxed snapshots, always-shared snapshot values,
  and borrowed hit callbacks regressed warm paths.
- Lazy reserve/ladder variants traded small warm movement for cold regressions or stayed in noise.
- Digest-prefix narrowing and generation-map reuse failed full-suite confirmation.
- Ancestry first-query rev-walk, thresholded fallback, frontier continuation, and timestamp selectors
  traded deep unrelated gains for 3-59% regressions in near, shared-query, or cold-anchor cells.
- Custom payload decoding was rejected after profiling: serde was not the dominant retained cost,
  and replacing it duplicated correctness-sensitive schema handling.

The full iteration-by-iteration record and evidence pointers are in `perf-notes/results.tsv`.

## Research And Tournament Decisions

- DAG research verified Git generation cutoffs and gix's reusable graph API; persistent labels lack
  project-shaped payoff/corruption evidence.
- Batch research selected fixed digest prefixes first; grouped phases and filesystem memos remain
  gated on an exact stats charge model.
- Snapshot research rejected index/HEAD timestamp reuse because it misses worktree-only and racy
  changes; a monitor-backed token is required.
- Cache research retained the bounded two-generation policy. SIEVE is not scan-resistant, and
  S3-FIFO has no engine trace proving its workload assumptions.

Decision records: `perf-notes/tournaments/ancestry.md`, `batch.md`, `snapshot.md`, and `cache.md`.
Claim evidence is in `perf-notes/research/evidence-ledger.jsonl` and `synthesis.md`.

## Allocation Evidence

Final DHAT counts for 512 candidates:

| State | Allocations/candidate | Requested bytes/candidate |
|---|---:|---:|
| Cold plain | 4.018 | 422.207 |
| Cold anchored | 4.121 | 712.625 |
| Warm plain | 3.014 | 312.078 |
| Warm anchored | 3.014 | 312.078 |

The remaining warm allocation floor is owned output/token materialization. Details and attribution
are in `perf-notes/profiles/allocations.md`.

## Correctness Coverage

- Added algebra-law properties: reflexivity, transitivity, equivalence, soundness, overlap symmetry,
  satisfiable subsumption, absent dimensions, and redacted uncertainty.
- Added generated-DAG ancestry differential tests, unknown-OID and exhausted-budget cases.
- Added semver matching/interval differentials.
- Added whole-engine generated reference-model comparison, warm-cache zero-I/O checks, cross-snapshot
  staleness, exact ordering/evidence/stats assertions, and budget exhaustion coverage.
- Added snapshot fingerprint permutation/content/path invariants.
- Final exact guard: 387 mc-store tests passed, one skipped; doctests passed; clippy passed with
  `-D warnings`.
- Iteration checkpoints ran full workspace tests (2,062-2,063 passed per checkpoint) and drift
  replications.

## Remaining Opportunities

1. Persistent commit graph or reachability index. Ceiling: remove the roughly 129 ms deep-history
   loose-object walk. Requires absence/staleness/corruption recovery and bounded update cost.
2. Monitor-backed snapshot reuse. Ceiling: avoid the measured 0.7-7.8 ms full status walk. Requires
   overflow, restart, untracked-file, and concurrent-mutation proofs.
3. Borrowed/shared public batch results. Ceiling: about 3.014 warm allocations and 312 requested
   bytes per candidate. Requires a public API/lifetime change.
4. Payload/stat memos across non-adjacent candidates. Requires an explicit stats and budget charge
   model before implementation.
5. Cache-policy replacement. Requires retained hit-rate, reuse-distance, scan, and one-hit-wonder
   traces before S3-FIFO or another policy is decision-grade.
6. Custom serde replacement. Reconsider only if payload decode becomes dominant after a wire-format
   or workload change.
