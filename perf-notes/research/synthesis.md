# Verified Research Synthesis

## Claim ledger

| ID | Claim | Verification | Confidence | Sources |
|---|---|---|---|---|
| C1 | Generation numbers support sound ancestry cutoffs. | VERIFIED | HIGH | Git 2.51 commit-graph spec |
| C2 | Git batches reachability by shared generation-ordered painting. | VERIFIED | HIGH | Git 2.51 `commit-reach.c` |
| C3 | gix 0.87.1 already auto-loads commit-graphs and exposes reusable graph primitives. | VERIFIED | HIGH | locked gix/gix-revwalk source |
| C4 | Existing fixture benchmarks measure commit-graph absence; production may differ. | VERIFIED | HIGH | fixture code; repository object info |
| C5 | Index/HEAD timestamps alone cannot safely reuse a full worktree snapshot. | VERIFIED | HIGH | racy-git and fsmonitor docs |
| C6 | Warm hits are dominated by digest/key construction. | VERIFIED | HIGH | local perf profiles and source |
| C7 | Fixed SHA bytes and prefix cloning preserve digest semantics. | VERIFIED | HIGH | current sha2 API and encoding |
| C8 | SIEVE is not scan-resistant; S3-FIFO needs an unmeasured one-hit workload. | VERIFIED/PARTIAL | HIGH/MEDIUM | NSDI'24; SOSP'23 |
| C9 | Persistent reachability labels outperform request-local graphs here. | UNVERIFIED | INSUFFICIENT | no project-shaped evidence |

## Recommendation

1. Keep the current cache policy and snapshot walk.
2. First optimize batch key construction with fixed digest bytes and per-batch digest prefixes.
3. Prototype a request-local reusable gix graph with generation cutoff and exact fallback/budget
   semantics; add commit-graph-present evidence before keeping it.
4. Defer persistent labels, snapshot reuse, path tries, and interval representation changes.

## Risks

- gix graph handling for shallow/replaced histories must not be weaker than current `rev_walk`.
- A prefix split must remain byte-identical to the current digest encoding.
- Existing benchmark ancestry cells understate commit-graph-equipped production behavior.
- Cache policy claims cannot be transferred without engine traces.

