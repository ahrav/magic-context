# Applicability Allocation Profile

## Method

A temporary isolated `dhat` 0.3.3 bench installed `dhat::Alloc`, built the normal applicability
fixture outside the measurement interval, and measured one 512-candidate batch per state. The
temporary target and dependency were removed after collection; the final dependency graph is
unchanged.

Evidence:

- Counts: `/tmp/mc-scope-perf/final-dhat-allocations.log`
- Heap profile: `/tmp/mc-scope-perf/final-dhat-heap.json`
- Combined heap-mode summary: 7,253 blocks, 900,602 requested bytes, 218,070 peak live bytes.

## Counts

| Path | Blocks/batch | Bytes/batch | Blocks/candidate | Bytes/candidate |
|---|---:|---:|---:|---:|
| Cold plain, 512 | 2,057 | 216,170 | 4.018 | 422.207 |
| Cold anchored, 512 | 2,110 | 364,864 | 4.121 | 712.625 |
| Warm plain, 512 | 1,543 | 159,784 | 3.014 | 312.078 |
| Warm anchored, 512 | 1,543 | 159,784 | 3.014 | 312.078 |

## Attribution

The highest-frequency sites each allocate 512 blocks in `evaluate_batch`: owned result buffers
and `String` clones. The largest repeated sites allocate 81,920 bytes per 512 candidates. Cold-only
sites include object-cache table reserves (25,616-51,216 bytes) and zlib setup. This confirms the
earlier perf attribution: the remaining warm floor is owned public output and token
materialization, not hidden repository I/O.

Removing the roughly three warm allocations per candidate requires a borrowed/shared public result
contract. That API change was outside the loop constraints, so no allocation-count gate was added.
