# facade-a-claim-effects-apply-acks-a-durable-checkpoint-with-no-module-effect

## Discovery trigger

The second of Part 4c's "success without writing" handlers, found by walking
every arm of `handle_facade_value` looking for a handler that never calls
`self.store()`. `claim.effects.apply` is the only one. Following the ack value
across the wire showed it is not a courtesy acknowledgement: the producer
advances a durable outbox cursor on it.

## Evidence trail

Module side, `crates/mc-module/src/lib.rs:10184-10255`.

- `:10185-10187` — `claim_route_root(channel, "claim.effects.apply")` is called
  and its `Ok` value discarded; only the error is propagated. So the route acts
  as a presence check.
- `:10188-10190` — `arguments` must be an object.
- `:10191-10197` — `protocolVersion` must equal
  `mc_core::claim_operation::CLAIM_INTENT_PROTOCOL_VERSION`.
- `:10198-10204` — `consumer` must be a non-empty string. Its VALUE is never
  compared against anything.
- `:10205-10210` — `receipt` must be an object with a `resultJson` string.
- `:10211-10218` — `decode_claim_operation_result(result_json)`.
- `:10219-10224` — `effects` must be a non-empty array whose length equals
  `result.effects.len()`.
- `:10225-10250` — per-effect loop: ids strictly increasing, and each wire effect
  must match the decoded result's effect on `effectKey`, `projectId`,
  `generation`, and `changeKind`.
- `:10251-10254` — the answer:

      respond(json!({
          "protocolVersion": mc_core::claim_operation::CLAIM_INTENT_PROTOCOL_VERSION,
          "ackedEffectId": previous,
      }))

  where `previous` is the last effect id from the loop (`:10249`).

Grepping the whole `:10184-10255` range finds no `self.store()`, no `McStore`
method call, and no interior mutability write. The handler is a validator.

Producer side, `packages/plugin/src/hooks/magic-context/`.

- `module-wire.ts:623` — `buildClaimEffectDeliveryWireBody` returns
  `{ name: "claim.effects.apply", arguments: request }`, so this is the MCP facade
  shape, not a flat method body. That is what makes it default-production
  reachable on the surface this lens owns.
- `module-transport.ts:1068-1087` — `claimEffectsApply`. The comment at
  `:1069-1071` says "The last effect is the delivery checkpoint (same contract as
  the outbox drain and the mirror receipt decoder)."
- `module-wire.ts:717-735` — `decodeClaimEffectDeliveryResponse` throws if
  `ackedEffectId !== expectedEffectId` (`:729-733`).
- `module-state-sync.ts:2212-2218` — `drainClaimEffectPrefix`, whose `deliver`
  callback is typed `Promise<{ ackedEffectId: number }>`.
- `module-state-sync.ts:2322-2327` — `const acknowledged = await args.deliver(delivery);`
  then a second equality check on `ackedEffectId`.
- `module-state-sync.ts:2328-2346` — immediately after, inside a
  `db.transaction(...).immediate()`, it calls
  `advanceOutboxConsumerCheckpointInCurrentTransaction` for every project the
  receipt touched. This is a durable write in the producer's database keyed by
  `(consumer, project_id)`.
- `module-state-sync.ts:2256-2266` — the drain's selection predicate is
  `effects.id > COALESCE(checkpoint.acked_effect_id, 0)`, so once the checkpoint
  advances the effects are never selected again for that consumer.
- `module-state-sync.ts:1617` and `:1621` — two distinct consumers:
  `MODULE_CLAIM_MIRROR_CONSUMER = "rust-module-claim-mirror-v1"` and
  `MODULE_CLAIM_EFFECTS_CONSUMER = "rust-module-claims-v1"`.
- `hook.ts:975-988` — the settle path passes
  `consumer: MODULE_CLAIM_EFFECTS_CONSUMER` and
  `deliver: (receipt) => claimEffectsApply({...})`.

So the shipped arrangement is: consumer `rust-module-claim-mirror-v1` drives
`claim.mirror.apply`, which DOES write
(`lib.rs:10326` calls `store.apply_claim_mirror_receipt`); consumer
`rust-module-claims-v1` drives `claim.effects.apply`, which writes nothing, and
its checkpoint advances anyway.

## Failure scenario

Two readings, and the evidence does not choose between them.

Reading A, the handler is meant to apply. Then for every acked prefix the module
retains nothing while the producer permanently records the prefix as delivered to
`rust-module-claims-v1`. Recovery requires resetting that consumer's checkpoints,
which no code in either tree does. The loss is silent on both sides: the module
returns a well-formed ack, the producer's equality check passes, and the drain
reports `deliveredReceipts` and `deliveredEffects` as though work happened
(`module-state-sync.ts:2348-2350`).

Reading B, the handler is a protocol-conformance ack and the mirror consumer is
the only module-side writer. Then the behaviour is correct and the finding is
that nothing says so: not the handler name, not the `ackedEffectId` field name,
not a doc comment on `:10184`, and not the response shape. A future maintainer
reading `handle_claim_effects_apply` has no way to distinguish a deliberate
no-op from a missing implementation.

Independent of which reading holds, one defect is unambiguous: `:10198-10204`
validates that `consumer` is a non-empty string and never compares it to
`"rust-module-claims-v1"` or any other expected value. A receipt delivered under
any consumer label is acked identically. If reading B is right, the handler's
only real job is to say "yes, this consumer's protocol is satisfied", and it does
not check which consumer is asking.

## Timing windows and dependencies

No interleaving window. The checkpoint advance is unconditional on the ack and
happens in the same synchronous sequence (`module-state-sync.ts:2322` then
`:2328`), inside an immediate transaction.

Dependencies:

- Reachable in a default build with no feature flags. The facade route must be
  bound (`:10185`) and the plugin's rust-mode claim-intent path must be active,
  which `hook.ts:938-949` gates on all four claim methods being present on the
  transport.
- The store need not even be open: the handler never calls `self.store()`, so a
  `claim.effects.apply` acks successfully while `store_unavailable_error` would
  be returned by every neighbouring claim handler.

That last point is worth stating plainly. During store-open
(`STORE_OPENING`, `lib.rs:12007-12011`) `claim.intent.stage` returns
`store_unavailable_error` (`:10097-10099`) and `claim.effects.apply` returns a
successful ack. The producer will advance its checkpoint against a module that
has no open store.

## What a test must construct

1. A bound facade route with NO store installed. Call `claim.effects.apply` with
   a well-formed receipt and assert the outcome. If it acks, the store-open
   window above is proven with no fault injection at all.
2. With a store installed, capture every table's row count before and after a
   successful `claim.effects.apply` and assert at least one changed, or, if
   reading B is the intended contract, assert none changed AND assert the module
   documents that.
3. Coverage-check form, per METHOD.md: do not assert the loss. Assert the two
   independent preconditions that create the window:
   `ACK_ISSUED_WITH_LAST_EFFECT_ID` fires when the handler returns
   `ackedEffectId == previous`, and `NO_STORE_WRITE_DURING_EFFECTS_APPLY` fires
   when the handler completes with the store's write counter unchanged. Both
   firing in the same request is the window. Neither marker requires observing a
   defect, so both fire on a correct implementation too, which is what the rule
   demands.
4. Consumer identity: call with `consumer: "not-a-real-consumer"` and assert the
   handler rejects it. Today it acks.
5. Cross-tree, if the harness can reach the producer database: assert that after
   a delivery the `claim_outbox_consumer_checkpoints` row for
   `rust-module-claims-v1` advanced, which pins the durability of the ack's
   consequence.

## Investigation log

### Q: Is `claim.effects.apply` intentionally a protocol-conformance ack, with the claim mirror as the only module-side writer?

- Sources examined: `lib.rs:10184-10255` for any comment or store access;
  `lib.rs:10299-10337`, `handle_claim_mirror_apply`, which does write through
  `store.apply_claim_mirror_receipt` (`:10326`) and returns `replayed` and
  `appliedEffectCount` (`:10331-10332`), a materially richer response;
  `module-state-sync.ts:1617,1621` for the two consumer constants;
  `module-state-sync.ts:1960-2050` for the mirror drain, which calls
  `client.claimMirrorApply` at `:2032`; `hook.ts:930-990` for the settle path;
  `module-transport.ts:1068-1087` and `module-wire.ts:717-735` for the ack
  contract; a search of `crates/` for `claim_effects` in test code, which found
  nothing in `mc-module`.
- Findings: the two-consumer arrangement is real and deliberate, and the mirror
  consumer's handler is visibly the writing one. That is the strongest evidence
  for reading B. Against it: the handler is named `apply`, the field is
  `ackedEffectId`, the producer's own comment calls the last effect "the delivery
  checkpoint" (`module-transport.ts:1069-1071`), and the drain's error text on
  mismatch is "claim effect delivery skipped checkpoint"
  (`module-state-sync.ts:2324-2326`). Every name on the path asserts delivery.
  Also against it: if the module needs nothing from these effects, it is unclear
  why the producer runs a second drain to it at all, rather than simply not
  registering `rust-module-claims-v1` as a consumer.
- Missing evidence: any design note explaining why two consumers exist and what
  each is for. I found none in `docs/`, and the scope map established that the
  claim subsystem has no specification outside the source
  (`part-4-module/_lenses/scope-map-and-risk-ranking.md:685-700`). Part 3's
  lens B covered the store side of the intent ledger and the mirror
  (`part-3-store-core/_lenses/lens-b-claim-mirror-ledger.md`) and does not
  discuss a second effects consumer, which is consistent with the module side
  having no store surface for it.
- Conclusion: needs human input. The question is which of two designs is
  intended, and both are defensible from the code. What can be recorded without
  a ruling is the unambiguous part: the ack drives a durable checkpoint advance,
  the handler performs no module-side effect, the handler does not verify the
  consumer identity, and it acks even with no open store.
