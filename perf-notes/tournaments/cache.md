# Proposed Tournament Decision: Cache Policy and Values

- Owner: AhravDutta
- Hard gates: 16,384 entries per generation, two-generation total bound, scan resistance no weaker
  on adversarial candidate storms, same staleness key and append-confirmation behavior.
- Weights: correctness 35%, measured gain 25%, adversarial behavior 20%, complexity 15%,
  reversibility 5%.

## Candidates

| ID | Mechanism | Gate | Primary trade-off |
|---|---|---|---|
| A | Existing two-generation policy and cloned values | Pass | Known tests, clone cost |
| B | Existing policy with shared immutable classification values | Pass provisionally | Refcount cost, lower deep clone cost |
| C | SIEVE or S3-FIFO family with shared values | Unproven | Different admission/scan behavior |

## Verification Ledger

| Claim | Result | Evidence | Impact |
|---|---|---|---|
| Value clone dominates warm hits | Refuted as current priority | C6 profile | B deferred |
| SIEVE is scan-resistant | Refuted | C8 / NSDI section 7.2 | SIEVE branch rejected |
| S3-FIFO matches engine one-hit distribution | Unverified | no engine trace | S3-FIFO branch deferred |
| Existing policy's bounded behavior is tested | Confirmed | `cache.rs` tests | A remains floor |

## Decision

Keep A's policy and value representation for now. Re-profile after key construction improves; B
may then be tested as one representation lever. Do not change eviction policy until a retained
engine trace measures hit ratio, reuse distance, scans, and one-hit-wonder share.

Evidence status is Strong for no policy change and Mixed for cloned versus shared values.
