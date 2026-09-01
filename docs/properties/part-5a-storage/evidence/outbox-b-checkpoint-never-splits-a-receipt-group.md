# outbox-b-checkpoint-never-splits-a-receipt-group

## Discovery trigger

The advance function's doc comment states the rule in a memorable form:
"a page cannot expose half an operation (KTD13)"
(`storage-claim-operations.ts:2210-2212`). Two independent enforcement points
implement it, on opposite sides of the delivery, which raised the question of
whether they agree.

## Evidence trail

**The declared contract.**
`packages/plugin/src/features/magic-context/memory/storage-claim-operations.ts:2208-2213`:

```
2208 /**
2209  * Advance one consumer/project cursor. Regression is rejected, the cursor may
2210  * not run past the current outbox tail, and the acknowledged id must not split a
2211  * receipt group within the project: a page cannot expose half an operation
2212  * (KTD13).
2213  */
```

**Enforcement point one: the write guard.** `:2246-2259`:

```
2246     const split = db
2247         .prepare(
2248             `SELECT 1 FROM claim_operation_effects consumed
2249                JOIN claim_operation_effects pending ON pending.receipt_id = consumed.receipt_id
2250               WHERE consumed.project_id = ?1 AND consumed.id <= ?2
2251                 AND pending.project_id = ?1 AND pending.id > ?2
2252               LIMIT 1`,
2253         )
2254         .get(args.projectId, args.ackedEffectId);
2255     if (split) {
2256         throw new Error(
2257             `outbox checkpoint ${args.ackedEffectId} splits a receipt group for project ${args.projectId}`,
2258         );
2259     }
```

A self-join on `receipt_id`, project-scoped on both sides. It fires when any
effect of a receipt sits at or below the proposed id while another effect of the
same receipt sits above it.

**Enforcement point two: the read guard in the drain.**
`packages/plugin/src/hooks/magic-context/module-state-sync.ts:2298-2309`:

```
2298         for (const effect of proof.effects) {
2299             const checkpoint = readOutboxConsumerCheckpoint(
2300                 args.db,
2301                 args.consumer,
2302                 effect.projectId,
2303             );
2304             if (effect.id <= checkpoint) {
2305                 throw new Error(
2306                     `claim effect receipt ${first.receiptId} was checkpointed partially`,
2307                 );
2308             }
2309         }
```

This runs before delivery and refuses to deliver a group any part of which is
already acknowledged. So the write guard prevents creating a split, and the read
guard refuses to act on one that exists.

**A third, related check inside the mirror lane.**
`module-state-sync.ts:1847-1850` requires the receipt's effect ids to be exactly
contiguous:

```
1847     const firstEffectId = proof.effects[0]?.id ?? 0;
1848     if (proof.effects.some((effect, index) => effect.id !== firstEffectId + index)) {
1849         throw new Error(`claim mirror receipt ${args.receiptId} is reordered`);
1850     }
```

Contiguity means a single integer boundary can always be placed cleanly outside a
group, which is what makes the split guard a total rule rather than a heuristic.
The effects drain does not impose contiguity, only the count and prefix checks at
`:2292-2309`.

**The multi-project case.** The advance loop is per project inside one
transaction: `module-state-sync.ts:2330-2343` builds `maxByProject` from the
group's effects and calls the advance function once per project. So for a receipt
spanning projects A and B, the guard for A evaluates while B has not yet
advanced. That is harmless for the split rule as written, because the guard is
project-scoped: A's evaluation only inspects A's rows. The intermediate state is
never visible outside the transaction.

**Existing coverage.** Two tests, both running at `ci.yml:257`:

- `storage-claim-operations.test.ts:1018-1058`. The comment at `:1022-1023` names
  the case precisely — "The merge receipt owns the last two effect ids; acking
  between them would expose half an operation." `:1024-1034` asserts
  `maxEffectId - 1` throws `/splits a receipt group/`; `:1035-1043` then
  acknowledges `maxEffectId` successfully; `:1044-1054` asserts a regression to 1
  throws `/cannot regress/`.
- `module-state-sync.test.ts:1424-1441`. Seeds a grouped fixture and asserts the
  first effect of a two-effect target group throws `"splits a receipt group"`.

Both fixtures use a single project.

## Failure scenario

Suppose the write guard were absent or bypassed (see
`outbox-b-checkpoint-monotonicity-is-application-enforced-only` for how). The
checkpoint lands mid-group. Then:

- The drain's selection query at `:2256-2266` picks the first unacknowledged
  effect, which belongs to the already-partly-acknowledged receipt.
- `proveClaimOperationDurable` loads the whole group and passes, because the
  group is intact on disk.
- The prefix check at `:2298-2309` fires and throws
  `was checkpointed partially`.

So the read guard converts a split into a hard stop rather than a silent partial
apply. The lane wedges and every subsequent settle throws. That is the correct
failure direction, and it is worth recording as the observed behaviour rather
than assuming a partial apply.

## Timing windows and dependencies

- No interleaving required for the single-project case; both guards read and
  decide inside a write transaction.
- The multi-project case has an intra-transaction ordering described above. It is
  read from the code and not constructed, which is why this record's confidence
  is medium.
- Depends on `outbox-b-checkpoint-monotonicity-is-application-enforced-only` for
  the only route to an actual split.

## What a test must construct

1. A receipt whose effects span two projects, if such an operation is
   constructible. Then assert the advance succeeds for both projects and that no
   intermediate state is observable from a second connection during the
   transaction.
2. Force a split out of band: a direct `UPDATE` setting `acked_effect_id` to a
   mid-group id on a second connection. Then run `drainClaimEffectPrefix` and
   assert it throws `was checkpointed partially`, proving the read guard is the
   backstop.
3. Contiguity: assert that a receipt's effect ids are consecutive for a real
   operation, which is what `module-state-sync.ts:1848` assumes. If a real
   operation can produce non-consecutive ids within one receipt, the mirror lane
   rejects it and the effects lane does not, and that divergence is itself a
   finding.
4. Coverage-check form: `RECEIPT_GROUP_SPANS_CHECKPOINT_CANDIDATE` fires when the
   advance function's split query returns a row. It fires on the guard's success
   path, so it never requires observing a defect.

## Investigation log

### Q: Can a shipped claim operation produce effects in more than one project?

- Sources examined: `module-state-sync.ts:2330-2343`, which builds a
  `Map<number, number>` keyed by project and loops, so it is written for the
  multi-project case; `:1851-1858`, where `touchedProjects` is a `Set` built from
  the group's effects and `vectorsAdvanceOneReceipt` (`:1786-1809`) increments
  each touched project's generation by exactly one; the prune aggregate at
  `storage-claim-operations.ts:2302-2313`, which iterates
  `SELECT DISTINCT project_id FROM claim_operation_effects` per consumer; the
  cross-project derivation trigger at
  `storage-claim-memory-schema.ts:406-410`, which requires a derivation's two
  endpoints to be in *different* projects, and the effects table's own
  `claim_id`/`project_id` binding guard at `:449-456`.
- Findings: the derivation trigger is the strongest hint that a real operation
  can touch two projects — a derivation is cross-project by construction, and an
  operation that records one plausibly emits effects on both endpoints. Three
  separate code paths are written for the multi-project case. But every test in
  `storage-claim-operations.test.ts` and `module-state-sync.test.ts` that I read
  uses one project, and I did not trace the derivation writer to confirm it emits
  two effects.
- Missing evidence: a read of the claim operation writers in
  `storage-claim-operations.ts:1-2100`. That is in this sub-part's file set but
  outside this lens's focus, so I am not doing it here rather than doing it badly.
- Conclusion: unresolved, needs a pass over the claim operation writers.
