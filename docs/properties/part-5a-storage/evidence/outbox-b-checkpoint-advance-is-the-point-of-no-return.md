# outbox-b-checkpoint-advance-is-the-point-of-no-return

## Discovery trigger

Part 4d established that the module's `claim.effects.apply` returns an
acknowledged effect id without touching its store, and noted in passing that the
producer "advances a durable outbox cursor on it". That phrasing raised the
question this record answers: how durable, and durable in what sense. The answer
turned out to be that the advance is the only irreversible step on the whole
path, and that nothing in either tree can move it back.

## Evidence trail

**The write itself.**
`packages/plugin/src/features/magic-context/memory/storage-claim-operations.ts:2260-2266`:

```
db.prepare(
    `INSERT INTO claim_outbox_consumer_checkpoints (consumer, project_id, acked_effect_id, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(consumer, project_id) DO UPDATE SET
        acked_effect_id = excluded.acked_effect_id,
        updated_at = excluded.updated_at`,
).run(args.consumer, args.projectId, args.ackedEffectId, args.nowMs ?? Date.now());
```

**How it is reached on the shipped path.**
`packages/plugin/src/hooks/magic-context/module-state-sync.ts:2328-2345` wraps the
per-project advances in `db.transaction(...).immediate()`. The statement
immediately before is the ack check at `:2323-2327`, and the statement before
that is `const acknowledged = await args.deliver(delivery);` at `:2322`. So the
sequence is: deliver, compare, commit. `hook.ts:974-988` supplies the `deliver`
closure and `throughReceiptId`, inside the `settleContext` callback that
`context-authority.ts:264` awaits.

**Why it is irreversible: the read predicates.** Both readers of the table use
`effects.id > COALESCE(checkpoint.acked_effect_id, 0)`:

- `module-state-sync.ts:1776-1779`, in `pendingClaimMirrorReceipt`.
- `module-state-sync.ts:2261-2263`, in `drainClaimEffectPrefix`.

An effect at or below the checkpoint is therefore never selected again for that
consumer. An absent row reads as zero, which is the only way to get back to
"nothing acknowledged", and no code produces an absent row after one exists.

**Why nothing can undo it.** `rg` for `claim_outbox_consumer_checkpoints` across
`packages/` and `crates/`, excluding `node_modules`, `dist`, and `*.test.ts`,
returns exactly six code sites:

| Site | Operation |
| --- | --- |
| `storage-claim-operations.ts:2201-2202` | `SELECT` |
| `storage-claim-operations.ts:2260-2266` | `INSERT ... ON CONFLICT DO UPDATE` |
| `storage-claim-operations.ts:2305-2309` | `LEFT JOIN` in the prune aggregate |
| `storage-claim-memory-schema.ts:289-297` | `CREATE TABLE` |
| `module-state-sync.ts:1776` | `LEFT JOIN` |
| `module-state-sync.ts:2261` | `LEFT JOIN` |

Plus two vocabulary-fixture mentions
(`fixtures/direct-format-vocabulary-v1.json:81`, `:309`) and two comments
(`storage-claim-memory-schema.ts:28`, `:45`). No `DELETE`, no downward `UPDATE`,
and zero references under `crates/`.

**The advance function forbids its own reversal.**
`storage-claim-operations.ts:2222-2226` throws
`outbox checkpoint for ... cannot regress`. So the single writer of the row is
also the guard that makes the write one-way.

## Failure scenario

A module-mode memory mutation commits its claim operation, receipt, and effects.
`settleContext` delivers the receipt group. The consumer returns
`{ ackedEffectId: <last effect id> }` and retains nothing (Part 4d,
`crates/mc-module/src/lib.rs:10184-10255`). The producer's equality check passes,
because the value was derivable from the request. The transaction at
`module-state-sync.ts:2328-2345` commits.

From that instant the effects exist, the receipt exists, the claim exists, and
the delivery obligation does not. There is no missing row anywhere to notice the
loss by, and the drain reports `deliveredReceipts` and `deliveredEffects` as
though work happened (`:2347-2349`). A later session's drain selects nothing,
because the predicate excludes the acked prefix, so the lane looks healthy
forever.

## Timing windows and dependencies

- One window: the `await` at `module-state-sync.ts:2322`. A crash inside it
  leaves the checkpoint unmoved, which is safe; the next drain re-delivers and
  the module's do-nothing handler is idempotent by accident.
- Depends on `outbox-b-acknowledgement-is-an-echo-of-the-delivered-prefix` for
  why the ack cannot prevent this.
- Depended on by `outbox-b-no-repair-path-lowers-or-rebuilds-a-claim-consumer-checkpoint`.
- Softened by `outbox-b-effects-are-never-pruned-in-a-shipped-install`: the rows
  survive, so a reset could in principle recover. None exists.

## What a test must construct

1. A real claim operation through `hook.ts`'s memory path, or the same shape as
   `context-authority-crash.test.ts:275-370` builds it, with a `deliver` closure
   that returns the correct id and records nothing.
2. Read `claim_outbox_consumer_checkpoints` before and after. Assert the row for
   `rust-module-claims-v1` advanced.
3. Run a second drain and assert it selects nothing. That is the irreversibility,
   observed rather than argued.
4. Attempt every plausible repair and assert each fails or does not exist:
   a lower `advanceOutboxConsumerCheckpointInCurrentTransaction` call (throws at
   `:2222-2226`), and a search for any reset entry point (none).
5. Per METHOD.md's coverage-check rule, do not assert the loss. Assert the two
   independent preconditions: `CHECKPOINT_ADVANCED_ON_ACK` fires when the
   transaction at `:2328` commits, and `CONSUMER_RETAINED_NOTHING` fires when the
   consumer's write counter is unchanged across the delivery. Both fire on a
   correct implementation; both firing together is the window.

## Investigation log

### Q: Should a checkpoint reset exist at all, or is whole-database reset the intended repair?

- Sources examined: every write site of the table (list above); the receipt
  delete trigger at `storage-claim-memory-schema.ts:416-418`, whose message is
  "claim_operation_receipts live until whole-database reset"; the notes-lane
  reconciliation at `context-authority.ts:633-657`, which does reset a cursor to
  zero and re-pull; `packages/cli/src/commands/doctor-authority.ts:173-227`,
  which is the closest thing to a repair command and touches no checkpoint.
- Findings: the codebase clearly knows the reset-and-repull pattern, uses it for
  the notes mirror, and does not use it here. The receipt trigger's message
  shows "whole-database reset" is an accepted repair concept in this schema. But
  a whole-database reset destroys the claims too, so it is not a repair for a
  diverged consumer; it is a repair for a corrupt database.
- Missing evidence: any design note. The `docs/` sweep found no claim or outbox
  specification at all, so there is nothing to consult.
- Conclusion: needs human input. The design question is upstream of this record
  and identical to Part 4d's unresolved one.
