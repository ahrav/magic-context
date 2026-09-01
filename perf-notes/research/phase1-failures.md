# Research Report: A3 - Failure Modes and Transfer Limits

## Coverage

Reviewed commit-graph invalidation limits, racy worktree detection, untracked/fsmonitor caches, and
cache-policy counter-evidence.

## Findings

**A3.F1: Commit-graph use has explicit topology exclusions**

- Claim: Git does not read/write commit-graphs with replace objects or grafts, and shallow history
  can invalidate stored generations when unshallowed.
- Support: DIRECT, Git v2.51 `Documentation/technical/commit-graph.adoc`, "Design Details",
  lines 126-150.
- Decision effect: a custom traversal must preserve gix's shallow handling and fall back when graph
  applicability is uncertain.

**A3.F2: Index metadata alone cannot prove worktree freshness**

- Claim: cached stat fields can match after content changes in the filesystem timestamp window;
  Git handles this "racy Git" case by rechecking content.
- Support: DIRECT, Git v2.51 `Documentation/technical/racy-git.adoc`, lines 15-131.
- Decision effect: `(HEAD, index mtime)` is not a sufficient snapshot-reuse key.

**A3.F3: Untracked and fsmonitor caches require explicit correctness machinery**

- Claim: Git's untracked cache avoids directory reads/stat calls, while fsmonitor avoids lstat of
  every file; historical untracked-cache bugs required forced disable/flush guidance.
- Support: DIRECT, Git v2.51 `Documentation/git-update-index.adoc`, "Untracked cache" and
  "File System Monitor", lines 470-560.
- Decision effect: do not invent snapshot reuse from filesystem timestamps; use a validated monitor
  API or retain the full walk.

**A3.F4: SIEVE is not scan-resistant**

- Claim: SIEVE's authors explicitly report that it is not scan-resistant and can trail
  scan-resistant policies on block-cache traces.
- Support: DIRECT, Zhang et al., "SIEVE is Simpler than LRU", NSDI 2024, section 7.2.
- Stable source: `https://www.usenix.org/system/files/nsdi24-zhang-yazhuo.pdf`.
- Decision effect: SIEVE cannot replace the tested two-generation policy on generic popularity
  claims.

**A3.F5: S3-FIFO's gains depend on one-hit-wonder workload structure**

- Claim: S3-FIFO uses a small probationary FIFO to filter one-hit wonders and reports strong trace
  and CacheLib results, but those workload properties have not been measured here.
- Support: DIRECT, Yang et al., "FIFO Queues are All You Need for Cache Eviction", SOSP 2023,
  DOI `10.1145/3600006.3613147`, abstract and sections 1/3.
- Decision effect: policy replacement remains unverified; representation-only changes are safer.

## Lens conclusion

Fail-open performance caches must remain fail-slow for correctness. Reject timestamp-only snapshot
reuse and unmeasured policy replacement.

