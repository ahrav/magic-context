# outbox-b-multi-receipt-backlog-drain-occurs-in-a-campaign

## Discovery trigger

`drainClaimEffectPrefix` is a loop with a `maxReceipts` bound of up to 1000
(`module-state-sync.ts:2219`), a scoping optimisation with a nine-line comment
(`:2224-2228`), and a `break` on reaching the target (`:2351`). All of that
machinery is for the multi-group case. On the shipped path the target receipt was
just committed, so the common case is one group. Whether the interesting case ever
occurs in a campaign is a situation-coverage question, not a line-coverage one.

## Evidence trail

**The loop and its bound.**
`packages/plugin/src/hooks/magic-context/module-state-sync.ts:2219`:

```
2219     const maxReceipts = Math.max(1, Math.min(args.maxReceipts ?? 1_000, 1_000));
```

`hook.ts:974-988` passes no `maxReceipts`, so production runs with 1000.

**The scoping, and why it narrows what is ever drained.** `:2224-2228`:

```
2224     // Projects the target mutation touches. Delivery order is per project, so a
2225     // target only needs its own projects' unacknowledged prefix. Draining every
2226     // project would make one mutation wait on unrelated history and, past
2227     // `maxReceipts`, fail after the write already committed.
2228     let scopedProjectIds: number[] | null = null;
```

Set at `:2246-2247` from the target receipt's own effects. Because `hook.ts:977`
always supplies `throughReceiptId`, and a receipt always has at least one effect
(`:2318-2321` throws otherwise), `scopedProjectIds` is always non-null in
production. The selection query then carries
` AND effects.project_id IN (...)` (`:2250-2254`).

**The early exit.** `:2238-2245`:

```
2238         reachedReceipt = targetEffects.every(
2239             (effect) =>
2240                 effect.id <= readOutboxConsumerCheckpoint(args.db, args.consumer, effect.projectId),
2241         );
2242         if (reachedReceipt) {
2243             lastEffectId = targetEffects.at(-1)?.id ?? 0;
2244             return { deliveredReceipts, deliveredEffects, lastEffectId, reachedReceipt };
2245         }
```

So an already-acknowledged target short-circuits with zero deliveries. And
`:2350-2351` breaks the loop the moment the target group is delivered, so the
drain never runs past the target.

**Selection order.** `:2256-2266` selects `ORDER BY effects.id LIMIT 1` over the
unacknowledged, in-scope effects. So the loop walks receipt groups in effect-id
order and reaches the target last, by construction, because the target was
allocated most recently.

**The existing test reaches the situation and not the state.**
`packages/plugin/src/hooks/magic-context/module-state-sync.test.ts:1399-1422`,
"delivers earlier effects first and checkpoints each receipt group atomically":

```
1418         expect(deliveries.map((delivery) => delivery.effectIds.length)).toEqual([1, 2]);
1419         expect(deliveries[1]?.effectIds).toEqual(target.effects.map((effect) => effect.id));
1420         expect(result.reachedReceipt).toBe(true);
1421         expect(result.deliveredReceipts).toBe(2);
```

Two groups, the earlier one delivered first. The `deliver` closure at `:1409-1415`
records and echoes. So the two-group shape is constructed by a test that runs at
`ci.yml:257`. What the test does not do is arrive at that shape the way production
would — by a previous delivery having failed — and it does not attempt more than
two groups.

**How a backlog arises in production.** Two routes, both without injected faults
in the module:

- A prior `settleContext` threw after the receipt committed and before the
  checkpoint advanced. Any error from `deliver`, or the mismatch throw at
  `:2323-2327`, or the transaction at `:2328-2345` failing, leaves the group
  unacknowledged. `commitModuleClaimIntent` propagates it (`:264` has no catch),
  so the caller sees an error and the effects stay pending.
- A mutation in a project whose effects an earlier scoped drain excluded. Because
  scoping is per target receipt, effects in project B are never drained by a
  mutation targeting project A. The next mutation in project B then finds B's
  backlog.

## Failure scenario

Not a failure — an unobserved state. Every property this lens records about
ordering, partial progress, and the `maxReceipts` bound is exercised only in the
degenerate one-group case if this situation never occurs. Specifically unobserved
without it:

- Whether the per-group checkpoint advance at `:2328-2345` is genuinely atomic
  per group, or whether a mid-backlog failure leaves a partially advanced state.
- Whether the prefix check at `:2298-2309` fires spuriously when the backlog
  contains a group the mirror consumer already handled — the two consumers share
  the table and have independent rows, so it should not, and that should be
  observed rather than assumed.
- What `:2354-2358` does when the backlog exceeds `maxReceipts`: it throws
  `claim effect prefix did not reach receipt N within M groups`, from inside
  `settleContext`, after the context write has already committed. The comment at
  `:2226-2227` names this exact hazard as the reason for scoping.

## Timing windows and dependencies

- The situation requires a prior incomplete drain, so it is history-dependent
  rather than timing-dependent.
- Depends on nothing else in this lens; it is the enabling state for observing
  several of them.
- Cheapest to construct by route two — two projects, two mutations — which needs
  no failure at all.

## What a test must construct

1. Route two, the cheap one. Create effects in projects A and B. Drive a mutation
   targeting A only; assert B's checkpoint row is absent afterwards. Then drive a
   mutation targeting B and assert the drain delivers B's earlier groups before
   the target. Mark `EFFECTS_DRAIN_DELIVERED_BACKLOG_GROUP` when a delivered
   `receiptId` differs from `throughReceiptId`.
2. Route one. Use a `deliver` closure that throws on its first call, then
   succeeds. Assert the checkpoint did not move on the failure, then that the
   retry delivers both groups in id order.
3. The bound. Seed more than `maxReceipts` groups in the target's project with
   `maxReceipts` set low, and assert the throw text at `:2354-2358` and that the
   context receipt is nonetheless durable. That is the scoping comment's stated
   hazard, observed.
4. `sometimes` and not `reachable`: the loop body at `:2256-2352` executes on
   every mutation, so a line-coverage marker would fire always and prove nothing.
   The marker must be conditioned on `receiptId !== throughReceiptId`, which is
   the operational state.
5. Marker names are constant and unique per METHOD.md: use
   `EFFECTS_DRAIN_DELIVERED_BACKLOG_GROUP` and
   `EFFECTS_DRAIN_EXCEEDED_MAX_RECEIPTS`, never constructed from a receipt id.

## Investigation log

### Q: Can the effects consumer accumulate a backlog it never drains?

- Sources examined: `:2230-2248` for the scoping, `:2250-2254` for the scope
  clause, `hook.ts:974-988` for the only production caller and its always-set
  `throughReceiptId`, `:2350-2351` for the break, and the prune aggregate at
  `storage-claim-operations.ts:2302-2313`, which pairs each required consumer with
  every project the outbox holds effects for.
- Findings: yes. Because the production drain is always scoped to the target
  receipt's projects and always breaks at the target, a project that never hosts a
  mutation never gets a checkpoint row for `rust-module-claims-v1`. Its effects
  remain selectable forever. That is harmless for delivery — they will be
  delivered when that project next mutates — but it means the prune boundary for
  that consumer is pinned at zero by the pairing rule, which the test at
  `storage-claim-operations.test.ts:902-952` documents deliberately. Since the
  prune path is unwired
  (`outbox-b-effects-are-never-pruned-in-a-shipped-install`), the pinned boundary
  has no consequence today.
- Missing evidence: none for this question.
- Conclusion: resolved with answer — yes, and the accumulation is benign for
  delivery while being exactly what makes the backlog situation reachable.
