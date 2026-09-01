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

