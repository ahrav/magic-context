# Upstream dispositions

This ledger records review decisions for changes after pinned Gossip-rs commit
`3d2869011138cd7812a12f893dc93635a961b0d7`. It never authorizes automatic
source updates.

| Review ID | Upstream range | Disposition | Local action | Evidence |
| --- | --- | --- | --- | --- |
| Baseline | Repository start through `3d2869011138cd7812a12f893dc93635a961b0d7` | Accepted as lift baseline | Copied corpus and adapted direct-text semantics listed in `SOURCE-INVENTORY.md` | Local contract, canary, direct-rule regression, digest, and provenance tests; pinned evaluator parity remains unmet |

No post-baseline drift has been reviewed in this branch. A future drift check
that cannot fetch the upstream ref, cannot find the ref, or observes changed
source must block release until a row records an accepted, rejected, or
superseded disposition.
