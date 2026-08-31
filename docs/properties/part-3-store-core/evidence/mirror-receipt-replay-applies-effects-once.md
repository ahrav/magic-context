# mirror-receipt-replay-applies-effects-once

## Discovery trigger

`ClaimMirrorApplyResult` carries a `replayed: bool` alongside
`applied_effect_count` (`crates/mc-store/src/claim_mirror.rs:148-153`). A result
type that distinguishes "applied" from "replayed" is an admission that the same
receipt is expected to arrive more than once, so the question is what makes the
second arrival free of effect.

## Evidence trail

The dedup lookup runs before any mutation, keyed by incarnation and receipt ID:

- `claim_mirror.rs:921-928` selects `group_digest` from
  `mc_claim_mirror_receipts` for `(database_incarnation_id, receipt_id)`.
- `claim_mirror.rs:929-934` returns
  `ClaimMirrorApplyResult { replayed: true, applied_effect_count: 0 }` when the
  stored digest equals the recomputed one. No statement between the lookup and
  this return mutates anything.
- `claim_mirror.rs:935-939` returns `ReceiptConflict` on a digest difference.
  That arm is a separate record.

The digest is not a header hash. `validate_group` serializes the entire
`ClaimMirrorReceiptGroup` and hashes its canonical encoding
(`claim_mirror.rs:501-505`), so the mirror version, receipt ID, expected count,
vector, and every effect participate. `validate_group` is called first thing in
`apply_claim_mirror_receipt` (`claim_mirror.rs:868`), before any connection is
taken.

Atomicity comes from the transaction boundary. The whole body runs inside
`self.inner.with_conn_fenced(...)` (`claim_mirror.rs:885`), and
`with_conn_fenced` opens one `TransactionBehavior::Immediate` transaction
(`../commons/crates/cortexkit-store/src/lib.rs:185-192`) with an epoch fence
check. Inside that single transaction:

- effects are written per effect at `claim_mirror.rs:1051-1061` (upsert at
  `:1052`, revocation delete at `:1054-1060`),
- touched projects are restamped and their `acked_effect_id` advanced at
  `:1064-1096`,
- the dedup row is inserted at `:1097-1113`,
- the mirror's `updated_at_ms` is bumped at `:1114-1117`.

So there is no interleaving in which effects are durable but the dedup row is
not. A crash before commit rolls all of it back, and the retry is a fresh first
apply rather than a replay.

The seeding precondition is enforced: an apply against an unseeded mirror returns
`NotSeeded` (`claim_mirror.rs:886-896`), so the dedup table cannot be populated
without a mirror state row to anchor it.

Production reachability is the facade handler `claim.mirror.apply`, dispatched at
`crates/mc-module/src/lib.rs:10053` and calling
`store.apply_claim_mirror_receipt` at `:10326`. Neither line is inside a
`#[cfg(test)]` module; the `#[cfg(test)]` attributes above that point
(`mc-module/src/lib.rs:132`, `:598`, `:610`) each apply to a single item.

## Failure scenario

The host applies receipt 7 and the response is lost. The host retries with the
same bytes. If the dedup lookup were keyed only on receipt ID without a digest,
or if the dedup insert were in a different transaction from the effects, the
retry would re-run `claim_mirror.rs:1008-1096`. The per-effect guards would not
stop it: the upsert at `:1052` is an `ON CONFLICT ... DO UPDATE`
(`claim_mirror.rs:592-604`) and would happily rewrite the identical row. What
would break is the checkpoint arithmetic. The second pass would find
`acked_effect_id` already advanced to effect 7's ID, so `:998` would compare
`previous_project_effect_id` against the new value and refuse — meaning the
observable symptom of a broken dedup is not a doubled claim but a
`CheckpointMismatch` on the *next* genuine receipt, which then wedges that
project's lane permanently, because `mirror-reset-cycle-requires-a-rebuild-grant`
shows production cannot reseed.

## Timing windows and dependencies

- Window: caller issues apply, response is lost, caller retries. Unbounded in
  duration; the dedup row is durable and never pruned, so the retry is safe
  arbitrarily later.
- Dependency: the single-transaction property at `claim_mirror.rs:885`. If any
  future change moved the dedup insert outside that transaction, this record
  fails.
- Dependency: byte-stability of the caller's re-serialization. The dedup is
  digest-exact, so a retry that re-mints the payload with a reordered map or a
  changed count becomes `ReceiptConflict` rather than a benign replay. This is
  Q1 in the lens.

## What a test must construct

1. Seed a mirror with `replace_claim_mirror_snapshot`.
2. Apply receipt R; assert `replayed == false` and
   `applied_effect_count == R.effects.len()`.
3. Apply R again with identical bytes; assert `replayed == true` and
   `applied_effect_count == 0`.
4. Snapshot the full mirror via `list_claim_mirror` and `claim_mirror_state`
   before and after step 3 and assert byte equality, including each project's
   `acked_effect_id` and each row's generation stamps.
5. The variant no existing test covers: apply R, apply R+1, then replay R. Assert
   the replay is still a no-op and that R+1's effects survive untouched. This is
   the case where a naive "compare against the latest receipt" dedup would fail.
6. The restart variant: apply R, drop and reopen the store, replay R.
7. Effect accounting: count apply calls that returned `replayed == false`
   (acknowledged) and total apply calls (attempted). Assert observed effect
   applications per public claim ID are at least the acknowledged count and at
   most the attempted count, then use per-identity row equality as the primary
   oracle, since aggregate counts cancel across claims.

## Investigation log

### Q: Does the facade retry `claim.mirror.apply` with byte-identical bytes?

- Sources examined: `crates/mc-module/src/lib.rs:10299-10336` (the handler and
  its argument decode), `claim_mirror.rs:921-940` (the dedup contract),
  `claim_mirror.rs:501-505` (the digest input).
- Findings: the handler decodes a caller-supplied payload and forwards it; it
  does not re-mint the receipt, so byte stability is the sender's responsibility.
  The store's contract is digest-exact, which means a semantically identical
  retry that serializes differently is reported as `ReceiptConflict`, not as a
  replay.
- Missing evidence: the host-side claim-outbox sender and its retry policy, which
  are outside this part's scope.
- Conclusion: unresolved, needs the host claim-outbox sender.

### Q: Can a crash leave effects applied without the dedup row?

- Sources examined: `claim_mirror.rs:885` (transaction open), `:1097-1113` (dedup
  insert), `../commons/crates/cortexkit-store/src/lib.rs:185-192`
  (`with_conn_fenced` opens one IMMEDIATE transaction).
- Findings: effects, project-state updates, and the dedup insert are all
  statements in one transaction. There is no intermediate commit.
- Missing evidence: none for this question at this layer. Whether SQLite's own
  durability holds under the configured journal mode is a different part's
  subject.
- Conclusion: resolved with answer — no, not at this layer; the dedup row and the
  effects share one transaction.
