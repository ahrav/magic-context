# Warm Batch Profile

Target: `batch/warm-anchored/512` at commit `4ad08c20b`, benchmark build ID
`a49857b4bc63d67dd40b6f8d592a529726ced782`.

The benchmark-only `MC_SCOPE_PROFILE=batch-warm-512` mode fills the engine cache once, then evaluates
the same 512 candidates for ten seconds.

Evidence:

- 199 Hz: 2,006 samples, zero lost.
- SHA-256 compression: 39.96% self cycles.
- SipHash key hashing: 9.67%.
- `malloc`, `_int_malloc`, free, and consolidation: about 30% combined.
- `evaluate_batch` body excluding named callees: 9.15%.
- Branch miss rate: 0.10%.
- `perf stat`: 31.92B userspace cycles, 85.36B instructions, IPC 2.67; negligible system time.

Source attribution:

- `evaluate_batch` builds an owned `ObjectCacheKey` before every lookup.
- `object_cache_key` clones checkout identity, object ID, HEAD, and dirty fingerprint.
- `inputs_digest` streams every context/candidate field through SHA-256 and hex-formats a new
  `String` for every candidate, including cache hits.

Conclusion: the warm path is dominated by proving cache-key identity, not cloning cached verdicts.
First remove repeated batch-constant digest work and digest hex formatting. Any deeper key redesign
must preserve input/staleness discrimination and the zero-I/O-on-hit counter contract.

Raw profile: `/tmp/mc-scope-perf/batch-warm-199.data`.

## After iteration 18

At `088fc0a5f`, a fresh 199 Hz profile captured 2,001 samples with zero loss. SHA-256 no longer
appears among material symbols. `evaluate_batch` owns 18.0% self cycles; allocator internals own
about 36%; `String::clone` owns 2.4% self and 26.6% including children; cached-classification
cloning owns 11.3% including children. SipHash writes are 7.3%, and object-cache lookup is 5.6%.

The remaining warm allocations materialize the public owned result strings and opaque cache token.
An `Arc` cache value alone cannot remove those allocations without a public result-type change, so
it is not an eligible loop treatment. Continue on cold repeated work before revisiting cache-key
representation.

Raw profile: `/tmp/mc-scope-perf/batch-warm-iter18-199.data`; report:
`/tmp/mc-scope-perf/batch-warm-iter18.report`.

## Cold batch after iteration 22

An engine-only `batch-cold-512` profile at `fa97709eb` captured 2,001 samples at 199 Hz with zero
loss. SipHash writes own 20.2% self cycles, allocator internals about 24%, object-key `hash_one`
6.9%, cache-table reserve/rehash 3.3%, and cache insert 2.8%. The first attempted profile through
Criterion was rejected because Criterion's crossbeam/rayon bootstrap analysis dominated samples.

The first eligible treatment is one bounded `HashMap::reserve` before batch inserts. Key hashing
and owned public output/token strings remain the larger representation problem.

Raw profile: `/tmp/mc-scope-perf/batch-cold-kernel-iter22-199.data`; report:
`/tmp/mc-scope-perf/batch-cold-kernel-iter22.report`.

After iteration 23 removed incremental table growth, the same profile held 2,001 samples with zero
loss: allocator internals own about 26%, SipHash writes 13.8%, full object-key `hash_one` 5.7%,
object-key clone 3.0%, and cache insertion 2.3%. The next treatment prehashes the full exact key
once with the cache's `RandomState`; equality still compares every field on collisions.

Raw profile: `/tmp/mc-scope-perf/batch-cold-kernel-iter23-199.data`; report:
`/tmp/mc-scope-perf/batch-cold-kernel-iter23.report`.
