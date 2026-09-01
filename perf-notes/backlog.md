# Measured Backlog

1. Ancestry algorithm and repository index use.
   Evidence: 10k far/unrelated queries are about 135ms; stable profiles show loose-object inflate
   and traversal dominate, with 7.8s system time per ten-second kernel loop.
   Next artifact: DAG reachability research and ancestry design tournament.
2. Warm-batch cache-key construction.
   Evidence: SHA-256 40%, SipHash 10%, allocator functions about 30% on 512 warm hits.
   Next artifact: batch-shape and cache-value tournament; first candidate is batch-constant digest
   prefixing plus fixed-byte digests.
3. Snapshot status walk.
   Evidence: clean snapshot 0.76ms; 1,000 untracked files 7.45ms.
   Next artifact: status/snapshot reuse research and staleness tournament.
4. Cache value cloning.
   Evidence: lower priority than key construction in the current warm profile.
   Next artifact: revisit after key hashing moves; do not add `Arc` speculatively.
5. Scope/version parsing.
   Evidence: eight-term matching is 304ns and does not move the suite today.
   Next artifact: defer until the top three kernels move or a profile promotes it.

Allocation-count attribution remains open: DHAT/heaptrack/valgrind are unavailable on this host.
No profiling-only dependency was added because perf already identified allocator cost and key/digest
construction sites; obtain exact counts before declaring an allocation contract.
