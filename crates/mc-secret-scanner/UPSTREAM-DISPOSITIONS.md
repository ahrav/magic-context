# Upstream dispositions

This ledger records review decisions for changes after pinned Gossip-rs commit
`3d2869011138cd7812a12f893dc93635a961b0d7`. It never authorizes automatic
source updates.

| Review ID | Upstream range | Disposition | Local action | Evidence |
| --- | --- | --- | --- | --- |
| Baseline | Repository start through `3d2869011138cd7812a12f893dc93635a961b0d7` | Accepted as lift baseline | Copied corpus and adapted direct-text semantics listed in `SOURCE-INVENTORY.md` | Local contract, canary, direct-rule regression, digest, and provenance tests; pinned evaluator parity remains unmet |
| Baseline-defect-1 | `bittrex-access-key` and `bittrex-secret-key` at `3d2869011138cd7812a12f893dc93635a961b0d7` | Accepted with known defect | Corpus stays byte-identical; the two rules share one regex and body, so a Bittrex match emits two findings that consumers dedupe by value span | Rule bodies at `default_rules.yaml` lines 716-751 are identical apart from `name` |
| Baseline-defect-2 | `nytimes-access-token` at `3d2869011138cd7812a12f893dc93635a961b0d7` | Accepted with known defect | Corpus stays byte-identical; the `new-york-times,` alternation branch requires a literal comma, so that spelling is unreachable and only `nytimes` and `newyorktimes` detect | `default_rules.yaml` line 3317 spells the branch `new-york-times,` while the `anchors` and `keywords_any` entries at lines 3321 and 3330 spell it without the comma |
| Baseline-defect-3 | `sentry-org-token` at `3d2869011138cd7812a12f893dc93635a961b0d7` | Accepted with known defect | Corpus stays byte-identical; the pattern consumes one trailing byte without capturing it and declares no `secret_group`, so `value_span` covers the credential plus that byte and a caller redacting it removes one byte of adjacent text. `full_span` already covered the same byte, so no credential byte is left unredacted. It is the only corpus rule with no capture group and a consumed trailing delimiter | `default_rules.yaml` line 3803 ends the pattern with `(?:[^a-zA-Z0-9+/]\|\z)` outside any group, and line 3818 sets `secret_group: null` |
| Baseline-defect-4 | `kubernetes-secret-yaml` at `3d2869011138cd7812a12f893dc93635a961b0d7` | Accepted with known defect | Corpus stays byte-identical; both alternation branches capture the whole `<field>: <value>` line rather than the value, so `value_span` covers the YAML field name and separator and a caller redacting it removes the field name too. The evaluator narrows the span to the captured field rather than the whole `kind: Secret` through `data:` match, and `generic-api-key` reports the same credential with a value-only span | `default_rules.yaml` line 2705 captures `([\w.-]+:...)` in each alternation branch, and line 2717 sets `secret_group: null` |
| Overlay-divergence-1 | `magic-anthropic-api-key` in `conservative_overlay.yaml` | Accepted as deliberate divergence | Overlay shape stays broader than the corpus `anthropic-api-key` and `anthropic-admin-api-key` rules so the migration does not narrow coverage the previous redaction engine had; the overlay can report a `sk-ant-` candidate the corpus rejects | `default_rules.yaml` line 411 requires a 93-character body and an `AA` suffix, while `conservative_overlay.yaml` line 3 accepts an optional label and a 32-character-or-longer body |

Recording a disposition for post-baseline drift requires naming both the watched
source path and the digest the drift check observed, because
`scripts/check-secret-scanner-upstream-drift.sh` clears a drifted source only
when one row carries both. Record `absent` as the digest for a source that
upstream deleted.

No post-baseline drift has been reviewed in this branch.
`scripts/check-secret-scanner-upstream-drift.sh` reports `fetch-unavailable`,
`missing-ref`, `source-inventory-mismatch`, or `source-drift`, and each of those
outcomes must block release until a row records an accepted, rejected, or
superseded disposition.
