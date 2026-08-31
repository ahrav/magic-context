# mirror-receipt-conflict-rejects-divergent-replay

## Discovery trigger

`ClaimMirrorError::ReceiptConflict { receipt_id }` renders as "claim mirror
receipt {receipt_id} was replayed with different bytes"
(`crates/mc-store/src/claim_mirror.rs:210-212`). An error variant that names
"different bytes" implies a byte-level comparison exists and that the author
considered a source reusing a receipt ID. No test constructs that case.

## Evidence trail

The comparison sits in the same `if let Some(stored_digest)` block as the benign
replay:

```
921  let replay: Option<String> = tx
922      .query_row(
923          "SELECT group_digest FROM mc_claim_mirror_receipts
924            WHERE database_incarnation_id = ?1 AND receipt_id = ?2",
...
929  if let Some(stored_digest) = replay {
930      return if stored_digest == group_digest {
931          Ok(Ok(ClaimMirrorApplyResult { replayed: true, applied_effect_count: 0 }))
935      } else {
936          Ok(Err(ClaimMirrorError::ReceiptConflict { receipt_id: group.receipt_id }))
939      };
940  }
```

(`claim_mirror.rs:921-940`.) Both arms `return`, so no mutation statement is
reachable from either. The refusal is therefore a pure read.

The digest covers everything. `validate_group` builds it from the serialized
whole group:

```
501  let value = serde_json::to_value(group)
503  let canonical = canonical_json_encode(&value)
505  Ok(sha256_hex_utf8(&canonical))
```

(`claim_mirror.rs:501-505`.) `ClaimMirrorReceiptGroup` is
`#[serde(rename_all = "camelCase", deny_unknown_fields)]` with fields
`mirror_version`, `receipt_id`, `expected_effect_count`, `vector`, `effects`
(`claim_mirror.rs:120-128`), and `ClaimMirrorEffect` carries the full hydrated
claim (`:103-117`). So no field of the receipt is outside the comparison, and a
single altered byte in any effect's content changes the digest.

The digest is computed before the transaction opens (`claim_mirror.rs:868`, the
transaction at `:885`), so a conflicting receipt is rejected without holding the
write lock any longer than the lookup needs.

The stored digest column is constrained to 64 characters
(`crates/mc-store/src/lib.rs:1305`), matching `sha256_hex_utf8`'s output width, so
a truncated or absent digest cannot be written and then compare equal by
accident.

Ordering note: the conflict check runs *after* the incarnation check
(`claim_mirror.rs:897-902`), the workspace-epoch check (`:903-907`), and the
control-row check (`:908-919`), but *before* the project-set, generation, and
checkpoint checks (`:942-1006`). So a replayed receipt that would also have failed
a generation check reports `ReceiptConflict`, which is the more specific
diagnosis.

Production reachability is `claim.mirror.apply` at
`crates/mc-module/src/lib.rs:10053` calling
`store.apply_claim_mirror_receipt` at `:10326`, outside any test module.

## Failure scenario

The authority restarts its receipt numbering — after its own rebuild, after a
failover to a replica with a lagging sequence, or because receipt IDs are
per-source rather than global. It emits a *new* receipt 7 carrying different
effects than the old receipt 7 the mirror already absorbed.

With the digest comparison, the mirror refuses with `ReceiptConflict` and the
divergence is visible at the moment it would have occurred.

Without it — if the lookup were treated as a plain existence test — the new
receipt 7's effects would be silently discarded and the call would report success
with `replayed: true`. The mirror would then be missing every claim in that
receipt while its `acked_effect_id` stayed behind, so the *next* receipt would
fail the checkpoint chain at `claim_mirror.rs:998-1004` and the lane would wedge.
The operator would see a `CheckpointMismatch` on receipt 8 and no evidence at all
that receipt 7 was the real problem.

## Timing windows and dependencies

- No window. This is an admission-time structural check with no interleaving
  requirement.
- Dependency: `canonical_json_encode` must be deterministic for a given value, or
  a faithful retry would hash differently and be misreported as a conflict. The
  same function is used on both the store side and, per
  `mc-core/src/claim_operation.rs:339-341`, for the canonical vector, so
  determinism is load-bearing well beyond this record.
- Dependency: the digest column's 64-char CHECK (`lib.rs:1305`) keeps a malformed
  stored digest from existing.

## What a test must construct

1. Seed a mirror, then apply receipt R and assert success.
2. Build R' with `receipt_id == R.receipt_id` and one altered field. Cover each of
   these separately, because each exercises a different part of the serialized
   input:
   - a different `content` in an effect's hydrated claim (with the digest and
     locator adjusted so `validate_group` still passes),
   - a different `expected_effect_count` together with a matching effect count,
   - a different `vector.workspace_epoch`,
   - a different set of effects with the same count.
3. Assert each returns `ClaimMirrorError::ReceiptConflict { receipt_id }` with the
   right ID.
4. Assert the mirror is unchanged: `list_claim_mirror` and `claim_mirror_state`
   byte-identical before and after each refused call, including `acked_effect_id`
   and generation stamps.
5. Assert the ordering claim: build R' that would *also* fail the generation check
   and confirm the error is `ReceiptConflict`, not `GenerationMismatch`. This pins
   the precedence at `claim_mirror.rs:929` ahead of `:963`.
6. Negative control: a genuinely byte-identical replay must still return
   `replayed: true`, so the test proves the comparison discriminates rather than
   always refusing.

## Investigation log

### Q: Is any field of the receipt outside the digest?

- Sources examined: `claim_mirror.rs:501-505` (digest input),
  `:120-128` (`ClaimMirrorReceiptGroup`), `:103-117` (`ClaimMirrorEffect`),
  `:72-87` (`CommittedClaimMirrorRow`).
- Findings: the digest is taken over `serde_json::to_value(group)`, which
  serializes every field of the group and, transitively, every field of every
  effect and every hydrated claim. All three types use `deny_unknown_fields`, so
  there is no captured-but-unserialized extra data.
- Missing evidence: none.
- Conclusion: resolved with answer — no field is outside the digest.

### Q: Can a conflicting receipt mutate anything before being refused?

- Sources examined: `claim_mirror.rs:868` (validate, pre-transaction), `:885-940`
  (transaction open through the conflict return).
- Findings: between the transaction opening at `:885` and the return at `:936`,
  every statement is a `SELECT` — the state read at `:886-893`, the control read
  at `:908` (via `claim_intent_control`, `:683-691`), and the digest lookup at
  `:921-928`. `with_conn_fenced` commits the transaction, but it commits nothing.
- Missing evidence: none.
- Conclusion: resolved with answer — no, the refusal path is read-only.
