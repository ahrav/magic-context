# mc-module hot-path benchmarks

`crates/mc-module/benches/hot_path.rs` measures the latency of the Rust
transform pipeline: projection, tail-hygiene measurement, m0 claim trimming,
tokenization, and the full transform pass. It anchors the optimization order
from the tail-hygiene tokenization profile (tokenizer work inside
`measure_tail_hygiene` first, m0 claim token reuse second, output identity
third).

## Claim under measurement

- **Outcome**: wall-clock service time of one synchronous, single-threaded,
  in-process call at a fixed corpus point. No arrival model (local operation
  microbenchmark); no queueing, IPC, or host response encoding.
- **Timing boundary**: the public function call (`transform`,
  `project_messages`, `mc_tokenizer::estimate_tokens`) or the
  `bench_internals` wrapper for crate-private stages
  (`measure_tail_hygiene`, `trim_claims_to_budget`, the cached transform
  seam).
- **Warm/cold**: warm process, warm tokenizer. The vendored-vocab decode
  behind the tokenizer `OnceLock` is excluded by an explicit warmup call —
  it is process-startup cost, not per-call cost. `e2e/first_hard` measures
  the materializing pass against a fresh store per iteration (store setup
  excluded via `iter_batched`); `e2e/steady*` measures the repeated stable
  pass against a committed session, which includes the per-pass
  `trace_pass_stable` SQLite write exactly as production does.
- **Estimand**: Criterion's mean per-iteration time with its 95% confidence
  interval, per cell. One estimator for every reported number — never mix
  mean, median, and slope across a table. Cells are reported individually
  and never aggregated — no "up to X% faster" summaries.

## Corpus

`benches/support/corpus.rs`. Deterministic (xorshift64*, seed
`CORPUS_SEED = 0x9E3779B97F4A7C15`), so a cell reproduces byte-for-byte.

- **Content classes**: `prose`, `code`, `json_tool`, `log`, `mixed`
  (per-message rotation). BPE cost is content-dependent; `"x".repeat(n)`
  fixtures understate tokenizer cost badly (observed: steady pass at 1,400
  messages is ~176 ms on mixed realistic content vs ~92 ms on the old
  padded fixture).
- **Session shape**: repeating user → assistant → tool_call → tool_result
  turns; every message carries a unique id and varied content so no
  accidental memoization survives.
- **Matrix**: message counts {100, 1400, 2500} × payload {256 B, 2 KiB,
  4 KiB} (tokenizer group), 2 KiB elsewhere, class variants at the
  1,400-message production-shaped point.
- **Payload labels name the requested `payload_bytes`, not the delivered
  volume.** `corpus::messages` caps the `tool_call` `command` argument at
  256 B. Three of every four messages carry the full label; the tool_call
  quarter carries 256 B, so at a 2 KiB label the session holds
  `(3*2048 + 256) / (4*2048)` ≈ 78% of `count * payload_bytes` of content.
  Cells stay comparable across arms because the corpus is seeded and
  identical on both sides, but do not read a cell label as total tokenized
  bytes.

## Groups

| Group | Measures | Path |
| --- | --- | --- |
| `tokenizer/estimate_tokens/{class}/{bytes}` | BPE token counting, bytes/s | public `mc_tokenizer` |
| `projection/full/{n}msgs` | `project_messages` | public |
| `tail_hygiene/measure/{n}msgs` | `measure_tail_hygiene` over a prebuilt projection | `bench-internals` |
| `m0/trim_claims_to_budget/{n}claims` | claim-budget fit with the real estimator | `bench-internals` |
| `e2e/first_hard/{n}msgs` | first materializing pass, fresh store per iteration | public `transform` |
| `e2e/steady/{n}msgs`, `.../{class}` | repeated stable pass, no output cache | public `transform` |
| `e2e/steady_output_cache/1400msgs` | stable pass through the cached seam (output cache warm, projection cache absent) | `bench-internals` |
| `e2e/steady_caveman/1400msgs` | stable pass with `caveman_enabled` | public `transform` |

## Running

```bash
cargo bench -p mc-module --features bench-internals            # full suite
cargo bench -p mc-module --features bench-internals -- 'tail_hygiene'
cargo bench -p mc-module --features bench-internals -- '1400msgs'
```

## Comparing a change

Criterion samples within one process are subsamples, not independent runs:
they cannot capture process-, build-, or host-level variation. For a
before/after decision:

1. `cargo bench -p mc-module --features bench-internals -- --save-baseline before`
2. Apply the change.
3. `cargo bench -p mc-module --features bench-internals -- --baseline before`
4. Repeat the pair across ≥3 fresh process invocations before believing
   effects under ~5%. An A/A run (steps 1+3 with no change) calibrates the
   harness; treat any A/A delta as the floor below which differences are
   noise for that host.

Pin expectations to a quiet host: no parallel builds, no thermal load.
`docs/perf/mc-host-baseline.md` documents host-preparation conventions for
the heavier IPC benches; the same hygiene applies here.

## Known gaps (intentional, phase 2)

- **`e2e/first_hard` clears the token cache per iteration** (bench setup calls
  `bench_internals::clear_token_cache()`), so it measures the genuine all-miss
  materializing pass. Steady-state groups intentionally run warm.
- **Steady cells replay a byte-identical request**, so from iteration 2 the
  token cache hit rate is exactly 1.0. Production steady passes append new
  turns, so each pass sees a small fraction of first-sight content. Steady
  results are therefore the hit-rate-1.0 upper bound on the production
  effect, bracketed from below by `e2e/first_hard` (all-miss).
- **Single-threaded only.** The host can run concurrent transform passes
  (one task per request); no cell measures the process-global cache lock
  under concurrency.

- **Projection cache path**: the incremental projection reuse lives in
  handler state (`McHandler`); the cached seam here runs with projection
  cache absent. Cached projection was already measured at ~11 ms vs
  ~1,750 ms full in the debug-profile large fixture and is not the current
  bottleneck.
- **Frozen-unit-heavy sessions** (10k–50k units), **native attachment**,
  and **host response encoding** need seeded store state or the host
  boundary and are out of scope for this in-process suite.
- **Stage counters**: `TransformTimings` isolates `tail_hygiene` and reports
  `tokenize_calls`, `tokenize_cache_hits`, `tokenize_cache_misses`,
  `tokenize_cache_bypassed` (contents under the 64-byte cache threshold),
  and `tokenize_bytes` per pass. These are deltas of thread-local counters,
  and a pass holds one thread from its start snapshot to its end snapshot
  (`apply_once_with_estimator_and_projection` is synchronous and spawns
  nothing), so a delta counts that pass alone even when concurrent handler
  tasks tokenize at the same time. `calls` therefore equals
  `hits + misses + bypassed` exactly. Consumers must classify all five as
  counters, not millisecond stage samples.

## Recorded comparison: token-count cache (2026-08-30)

Single host, single process pair, fixed corpus seed. One replication —
direction and magnitude are decisive, but sub-10% deltas here are below the
design's resolution.

Local raw bundle: `docs/perf/runs/mc-module-token-cache-2026-08-30/criterion/`
(gitignored, 48 files). Integrity manifest:
`docs/perf/runs/mc-module-token-cache-2026-08-30/SHA256SUMS` (tracked).

Per the ignore policy in `.gitignore`, Criterion sample bundles are
host- and build-specific and stay local; a clean checkout holds the report,
manifest, environment, and hashes but not the samples. So
`sha256sum -c SHA256SUMS` reports all 48 entries missing in a fresh clone —
that is the expected state, not lost evidence. The hashes exist to let
whoever holds the bundle prove it is the one behind the table below:

```sh
cd docs/perf/runs/mc-module-token-cache-2026-08-30 && sha256sum -c SHA256SUMS
```

Regenerate the bundle with the benchmark command in `manifest.json`; a
regenerated run will not match these hashes, since the samples are
host-specific.

Baseline-arm provenance: the bench harness, `bench-internals` feature, and
criterion dev-dependency ship with the cache change itself and do not exist
at the parent commit, so the `precache` arm was collected from a hybrid
tree — this harness applied onto the pre-cache implementation. The hybrid
tree is not a commit; rebuilding it requires reverting the token-cache
routing while keeping the bench files. Three cells (`tail_hygiene/1400`,
`tail_hygiene/2500`, `e2e/steady/1400`) also crossed a Criterion sampling-
mode boundary between arms (flat baseline vs linear candidate), so the mean
is the only estimator available in both arms; immaterial at −98%/−77%
scale, disqualifying for sub-10% cells.

All numbers are Criterion means with 95% CIs, from the retained
`estimates.json` of both arms.

| Cell | Before (mean [95% CI]) | After (mean [95% CI]) | Mean change |
| --- | --- | --- | --- |
| `tail_hygiene/measure/100msgs` | 10.72 ms [10.66, 10.80] | 161.5 µs [161.5, 161.5] | −98.5% |
| `tail_hygiene/measure/1400msgs` | 155.0 ms [154.6, 155.6] | 2.445 ms [2.442, 2.450] | −98.4% |
| `tail_hygiene/measure/2500msgs` | 281.1 ms [280.4, 281.9] | 4.555 ms [4.551, 4.562] | −98.4% |
| `e2e/steady/1400msgs_2KiB_mixed` | 195.8 ms [194.9, 196.4] | 45.06 ms [44.92, 45.20] | −77.0% |
| `e2e/first_hard/1400msgs_2KiB_mixed` | 210.5 ms [208.6, 213.3] | 203.8 ms [203.0, 204.7] | −3.2% |
| `m0/trim_claims_to_budget/8claims` | 2.546 µs [2.542, 2.550] | 2.649 µs [2.643, 2.655] | +4.0% |
| `m0/trim_claims_to_budget/64claims` | 2.693 µs [2.680, 2.705] | 2.788 µs [2.783, 2.793] | +3.5% |
| `m0/trim_claims_to_budget/256claims` | 3.315 µs [3.309, 3.322] | 3.306 µs [3.300, 3.312] | −0.3% |

Reading the marginal cells against the design's own limits:

- `e2e/first_hard` −3.2% (cold cache per iteration): below the ~5%
  single-replication resolution; unresolved until replicated across ≥3
  fresh process invocations with an A/A floor. The load-bearing result of
  this cell is directional: the all-miss pass did **not** regress.
- `m0/trim_claims` +3.5–4.0% on the 8/64 cells: also below resolution, and
  these cells underflow the budget and tokenize only sub-64-byte wrapper
  strings, which bypass the cache entirely — they exercise the counter
  overhead, not the cache. The 64claims slope estimator reads +5.6%, above
  the ~5% threshold, so this group is flagged for replication rather than
  dismissed. The 256claims cell — the only one that actually trims — is
  flat (−0.3%).

The tail_hygiene and steady headline cells are hit-rate-1.0 upper bounds
(see Known gaps). Their mechanism coherence check: the steady-pass delta
(195.8 − 45.06 ≈ 150.7 ms) matches the tail_hygiene stage delta
(155.0 − 2.445 ≈ 152.6 ms) within 2 ms at the same corpus point, so the
e2e improvement is attributable to the tail-hygiene stage rather than
assumed.
