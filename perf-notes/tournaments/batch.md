# Proposed Tournament Decision: Batch Evaluation Shape

- Owner: AhravDutta
- Hard gates: ordered byte-exact results/evidence, identical stats and budget outcomes, unchanged
  staleness dimensions, bounded memory.
- Weights: correctness 35%, measured warm/cold gain 35%, complexity 20%, reversibility 10%.

## Candidates

| ID | Mechanism | Gate | Primary trade-off |
|---|---|---|---|
| A | Current loop plus fixed-byte SHA digests and precomputed batch digest prefixes | Pass | Smallest measured lever |
| B | Group by scope/anchor, then classify in phases with interned batch context | Pass provisionally | Larger ordering/stats proof |
| C | B plus decoded-payload and filesystem memos | Pass provisionally | Budget charge semantics become complex |

## Verification Ledger

| Claim | Result | Evidence | Impact |
|---|---|---|---|
| Digest/key work dominates warm hits | Confirmed | C6 | A directly targeted |
| Fixed bytes/prefix preserve digest identity | Confirmed, test still required | C7 | A eligible |
| Grouping gives additional material gain | Unverified | no prototype | B deferred |
| Stat/decode memo preserves exact charges | Unverified | no charge model | C deferred |

## Decision

Select A for the first optimization round. Re-profile afterward. B enters only if repeated
per-candidate context work remains material; C requires a written charge model before code.

Evidence status is Strong for the first round, not for the eventual final architecture.
Kill condition: digest differential changes, any cache-hit/staleness test fails, or full-suite gain
is within A/A drift while touched warm cells do not improve.

