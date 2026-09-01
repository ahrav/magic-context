# outbox-b-checkpoint-monotonicity-is-application-enforced-only

## Discovery trigger

`storage-claim-memory-schema.ts:286-288` is unusually candid:

```
286     -- Durable per-consumer/project cursors (KTD13). Mutable; monotonicity is
287     -- enforced by advanceOutboxConsumerCheckpointInCurrentTransaction (the
288     -- claim_policy_projector_watermarks pattern).
```

A comment that names the function enforcing an invariant is telling you the
database does not. In a schema fragment that spends 28 `CREATE TRIGGER`
statements enforcing append-only contracts, that is worth checking.

## Evidence trail

**The table's own constraints.**
`packages/plugin/src/features/magic-context/storage-claim-memory-schema.ts:289-297`:

```
289     CREATE TABLE claim_outbox_consumer_checkpoints (
290         consumer TEXT NOT NULL CHECK (length(consumer) > 0),
291         project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
292         acked_effect_id INTEGER NOT NULL CHECK (
293             typeof(acked_effect_id) = 'integer' AND acked_effect_id >= 0
294         ),
295         updated_at INTEGER NOT NULL,
296         PRIMARY KEY (consumer, project_id)
297     ) WITHOUT ROWID;
```

Type and non-negativity. Nothing about monotonicity, nothing about the tail,
nothing about receipt groups.

**The trigger inventory of the same fragment.** Counted from the 28
`CREATE TRIGGER` statements in the file, grouped by target table:

| Table | Triggers | First site |
| --- | --- | --- |
| `claim_project_generations` | 3 | `:93` |
| `claim_public_ids` | 3 | `:313` |
| `claim_memory_revision_attributes` | 5 | `:324` |
| `claim_memory_lifecycle_events` | 6 | `:352` |
| `claim_derivations` | 4 | `:388` |
| `claim_operation_receipts` | 3 | `:412` |
| `claim_operation_effects` | 5 | `:427` |
| **`claim_outbox_consumer_checkpoints`** | **0** | — |
| `claim_memory_current_heads` | 0 | — |
| `claim_usage_stats` | 0 | — |
| `claim_mural_cues` | 0 | — |
| `claim_outbox_prune_state` | 0 | — |

The split is clean: every table the header comment at `:22-25` calls append-only
carries three to six triggers, and every table it calls "mutable by design" at
`:27-30` carries none. So the absence is consistent with the fragment's own
classification, which makes the question not "was this forgotten" but "is the
checkpoint table correctly classified" — see the investigation log.

`claim_operation_effects` even gets a capability-gated delete guard
(`:433-438`): the delete is refused unless `claim_outbox_prune_state.enabled` is
1 *and* the row id sits at or below the recorded `consumed_watermark`. So the
schema author was willing to encode a two-part conditional retention rule in SQL
for the effects table, and encoded nothing for the cursor that authorizes that
watermark.

**Where the invariant actually lives.**
`memory/storage-claim-operations.ts:2218-2259`, four throws in TypeScript:

- `:2218-2220` — not a safe non-negative integer.
- `:2222-2226` — regression, against a value read at `:2221`.
- `:2241-2245` — beyond `MAX(id)` of `claim_operation_effects` (`:2237-2240`).
- `:2255-2259` — splits a receipt group (`:2246-2254`).

Every one is a read-then-decide in application code. All four are bypassed by any
`UPDATE claim_outbox_consumer_checkpoints SET acked_effect_id = ...` issued from
anywhere else.

**Other writers of the same database file exist.** The privileged-writer wrapper
(`packages/plugin/src/shared/sqlite.ts:329-354`) exists because triggers, not
application code, are the enforcement layer for the tables that have them; its
own doc comment at `:318-328` says the privilege "is recorded in the durable
`context_privilege_state` table ... so the guard triggers — which reference that
table, never a connection-local UDF — stand down for this connection's writes".
That design only protects tables with triggers.

Concretely, other processes open this file for mutation:
`packages/cli/src/commands/doctor-authority.ts:174` calls
`openExistingContextDatabaseForMutation(dbPath)`, and the 5d-scoped
`doctor-repair-db.ts` and `migrate.ts` are named by the scope map as destructive
or migrating CLI commands over the same database. The schema fence in
`storage-db.ts` exists precisely because binaries of other versions can reach the
file.

## Failure scenario

Any writer that is not `advanceOutboxConsumerCheckpointInCurrentTransaction`
sets `acked_effect_id` to a value of its choosing. Two directions matter:

- Forward past the tail. The producer's next `advanceOutbox...` call reads that
  value as `existing` (`:2221`) and any smaller true value regresses, so the
  legitimate advance now throws on every subsequent delivery. The drain converts
  that into a thrown settle, and the claim lane stops.
- Forward past effects never delivered. Those effects fall outside both read
  predicates permanently. Same consequence as the point-of-no-return record, but
  reached without any delivery at all.

Backwards is the benign direction: it causes redelivery, which the module's
do-nothing handler tolerates.

## Timing windows and dependencies

- No timing window. A structural absence.
- Independent of the ack semantics; this record holds even if
  `claim.effects.apply` applied perfectly.
- Interacts with `outbox-b-checkpoint-never-passes-the-outbox-tail`: that guard
  is one of the four this record shows are bypassable.

## What a test must construct

1. Open the context database on a second connection and
   `UPDATE claim_outbox_consumer_checkpoints SET acked_effect_id = <tail + 1000>`.
   Assert it succeeds. That single assertion is the finding.
2. Then call `advanceOutboxConsumerCheckpointInCurrentTransaction` with the
   correct next value and assert it throws `cannot regress`, showing the lane is
   now wedged rather than merely wrong.
3. Positive control: attempt the analogous out-of-band write against
   `claim_operation_effects` — a `DELETE` without the prune capability — and
   assert it raises
   "claim_operation_effects deletes require the prune capability and an id at or
   below the consumed watermark" (`storage-claim-memory-schema.ts:438`). That
   isolates the missing trigger as the difference rather than some ambient
   protection.
4. Do not pair `always(!X)` with a `sometimes(X)` marker. The precondition to
   assert is `CHECKPOINT_TABLE_HAS_NO_TRIGGERS`, checkable by querying
   `sqlite_master` for triggers whose `tbl_name` is the checkpoint table and
   asserting the count. That fires on the current tree without observing any
   corruption.

## Investigation log

### Q: Why does the effects table get a capability-gated delete trigger while its cursor table gets none?

- Sources examined: the full trigger inventory above; the fragment's header
  comment at `:22-31`, which classifies the checkpoint table with
  `claim_memory_current_heads` and `claim_usage_stats` as "mutable by design:
  rebuildable projection, nonsemantic telemetry, and durable consumer cursors";
  `claim_memory_current_heads`, described at `:5-6` as a "rebuildable
  current-head dedup index"; `claim_usage_stats`, described at `:2134` of
  `storage-claim-operations.ts` as "Nonsemantic telemetry (R3): mutable counters,
  no receipts".
- Findings: the grouping is the problem. The other two mutable tables genuinely
  are recoverable — one is rebuildable from the ledger, the other is telemetry
  nobody depends on. The checkpoint table is neither: it is the only mutable
  table whose corruption is unrecoverable, and it was placed in the "mutable by
  design" bucket alongside two tables where mutability is harmless. That reads
  like a classification error rather than a considered trade, but the comment is
  deliberate enough that I will not assert it.
- Missing evidence: a rationale for the grouping. The `docs/` sweep found no
  claim or outbox specification.
- Conclusion: needs human input.
