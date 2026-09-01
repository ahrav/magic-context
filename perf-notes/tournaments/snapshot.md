# Proposed Tournament Decision: Snapshot Pipeline

- Owner: AhravDutta
- Hard gates: never fingerprint a partial walk; any worktree/index/untracked change invalidates the
  cache key; concurrent mutation is no less safe than today.
- Weights: correctness 45%, measured scenario 25%, complexity 20%, reversibility 10%.

## Candidates

| ID | Mechanism | Gate | Finding |
|---|---|---|---|
| A | Full status walk and sorted SHA fingerprint | Pass | Current correctness floor |
| B | Reuse by checkout identity, HEAD, and index stat signature | Fail | Misses worktree-only/racy changes |
| C | Full walk with order-independent digest and no sort | Pass provisionally | Does not remove measured status cost |

## Verification Ledger

| Claim | Result | Evidence | Impact |
|---|---|---|---|
| Index stat signature proves worktree freshness | Refuted | C5 | B ineligible |
| Monitor/untracked caches can avoid full scans | Partial | Git fsmonitor/untracked docs | Requires a real monitor API and recovery model |
| Fingerprint hashing dominates snapshot time | Unverified and unsupported | baseline only; no profile | C has no measured case |

## Decision

Keep A. A monitor-backed candidate may re-enter when gix exposes a validated change token or the
project owns a watcher with overflow/restart semantics. C may be tested only after profiling shows
sort/hash cost material.

Evidence status is Strong for rejecting B and Mixed for the long-term winner because no monitor
prototype was evaluated.

