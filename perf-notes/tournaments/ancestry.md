# Proposed Tournament Decision: Ancestry Engine

- Owner: AhravDutta
- Evidence mode: evidence-backed
- Hard gates: exact `Option<bool>`, current budget denial order/cap, no hidden repo I/O on cache hits,
  safe Rust, bounded request memory, absent/stale/corrupt graph falls back to current semantics.
- Weights: correctness 35%, measured scenario 30%, complexity 20%, reversibility 15%.

## Candidates

| ID | Mechanism | Gate | Primary trade-off |
|---|---|---|---|
| A | Current per-pair `rev_walk` and pair memo | Pass | Simple, but repeats traversal |
| B | Independent generation-cutoff walk per pair | Pass provisionally | Prunes negatives, no batch sharing |
| C | Request-local reusable gix graph with optional generation cutoff | Pass provisionally | More code, shares decode/frontier data |
| D | Persistent reachability labels | Pass provisionally | Highest maintenance/corruption surface |

## Scenario Comparison

| Scenario | A | B | C | D |
|---|---|---|---|---|
| 10k far true query | Full walk | Full path remains | Full path once, reusable nodes | Fast after index build |
| 10k unrelated/distinct batch | Full walk per pair | Generation-pruned per pair | Generation-pruned shared graph | Fast lookup |
| No/corrupt commit-graph | Existing ODB walk | Existing ODB fallback | Existing ODB fallback | Must rebuild/fallback |
| Budget/cancellation | Existing behavior | Per-pop checks required | Per-pop checks required | Index work complicates charge |
| Rollback | Immediate | Immediate | Immediate | Persistent cleanup needed |

## Verification Ledger

| Claim | Result | Evidence | Impact |
|---|---|---|---|
| Generation cutoff is sound | Confirmed | C1 | B/C eligible |
| gix exposes reusable lazy graph | Confirmed | C3 | C implementable |
| Batch painting beats request-local reuse here | Unverified | C2 is mechanism evidence, not benchmark | C starts simpler than full paint-down |
| Persistent labels pay back | Unverified | C9 | D not selected |

## Decision

Select C incrementally: first reuse a request-local gix graph and optional commit-graph generations;
only add multi-source painting if distinct-query benchmarks still traverse repeated frontiers.
Fallback remains the current `rev_walk`. Evidence status is Mixed until shallow/replacement behavior,
budget parity, and commit-graph-present benchmarks pass.

Kill condition: any differential mismatch, hidden graph I/O on object-cache hits, unbounded retained
nodes beyond the request, or no gain on distinct-anchor batches.

