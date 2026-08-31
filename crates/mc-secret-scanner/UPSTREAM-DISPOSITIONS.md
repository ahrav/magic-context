# Upstream dispositions

This ledger records review decisions for changes after pinned Gossip-rs commit
`3d2869011138cd7812a12f893dc93635a961b0d7`. It never authorizes automatic
source updates.

| Review ID | Upstream range | Disposition | Local action | Evidence |
| --- | --- | --- | --- | --- |
| Baseline | Repository start through `3d2869011138cd7812a12f893dc93635a961b0d7` | Accepted as lift baseline | Copied corpus and adapted direct-text semantics listed in `SOURCE-INVENTORY.md` | Local contract, canary, direct-rule regression, digest, and provenance tests; pinned evaluator parity remains unmet |
| Baseline-defect-1 | `bittrex-access-key` and `bittrex-secret-key` at `3d2869011138cd7812a12f893dc93635a961b0d7` | Accepted with known defect | Corpus stays byte-identical; the two rules share one regex and body, so a Bittrex match emits two findings that consumers dedupe by value span | Rule bodies at `default_rules.yaml` lines 716-751 are identical apart from `name` |

No post-baseline drift has been reviewed in this branch.
`scripts/check-secret-scanner-upstream-drift.sh` reports `fetch-unavailable`,
`missing-ref`, `source-inventory-mismatch`, or `source-drift`, and each of those
outcomes must block release until a row records an accepted, rejected, or
superseded disposition.
