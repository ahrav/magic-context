# outbox-b-checkpoint-never-passes-the-outbox-tail

## Discovery trigger

The guard at `storage-claim-operations.ts:2241-2245` carries a nine-line comment
explaining why it exists, which is unusual enough to read closely. The comment
argues in global terms about the prune boundary; the write it protects is per
project. That mismatch is the substance of this record.

## Evidence trail

**The guard and its stated rationale.**
`packages/plugin/src/features/magic-context/memory/storage-claim-operations.ts:2227-2245`:

```
2227     // A cursor past the tail claims to have observed effects that do not exist.
2228     // Nothing else catches it: the receipt-split query below finds no `pending`
2229     // row beyond such an id, so it passes. Left unchecked, once every required
2230     // consumer holds a future cursor the prune boundary becomes that future id,
2231     // and effects allocated below it afterwards are deleted having never been
2232     // published to anyone.
2233     //
2234     // The tail falls back to the existing cursor rather than zero so a
2235     // re-acknowledgement stays idempotent after pruning empties the table — the
2236     // acknowledged effects are gone precisely because they were consumed.
2237     const tailRow = db.prepare("SELECT MAX(id) AS tail FROM claim_operation_effects").get() as {
2238         tail: number | null;
2239     };
2240     const tail = tailRow.tail ?? existing;
2241     if (args.ackedEffectId > tail) {
2242         throw new Error(
2243             `outbox checkpoint ${args.ackedEffectId} for ${args.consumer}/${args.projectId} is beyond the outbox tail (${tail})`,
2244         );
2245     }
```

**The scope mismatch.** The tail query has no `WHERE project_id = ?`. The
receipt-split guard immediately below it does, binding `?1` to `project_id` on
both sides of the join
(`:2246-2254`):

```
2250               WHERE consumed.project_id = ?1 AND consumed.id <= ?2
2251                 AND pending.project_id = ?1 AND pending.id > ?2
```

And the row being written is keyed `(consumer, project_id)` (`:2260-2266`,
`ON CONFLICT(consumer, project_id)`). So within one function, one guard is global
and the next is project-scoped, and the write is project-scoped.

The consequence is that a high effect id allocated in project B raises the
permitted ceiling for project A. Because `claim_operation_effects.id` is a single
`AUTOINCREMENT` sequence shared across projects
(`storage-claim-memory-schema.ts:271`), any activity in any project raises the
global tail.

**Why the ceiling still binds.** Effect ids are allocated monotonically from one
sequence, so the global tail is an upper bound on every project's ids. The guard
therefore never rejects a legitimate advance; it only fails to reject some
illegitimate ones. That is why it reads as a deliberate simplification rather
than a bug, and why this record is a safety property with an open question rather
than a defect claim.

**The fallback branch.** `tail = tailRow.tail ?? existing` (`:2240`). `MAX(id)`
over an empty table returns SQL `NULL`, which the cast surfaces as
`tail: null`, so an emptied table yields `tail = existing` and a
re-acknowledgement of the existing value passes both the regression check
(`:2222`, equal is allowed) and the tail check (`:2241`, equal is allowed).

**Existing coverage.**
`packages/plugin/src/features/magic-context/memory/storage-claim-operations.test.ts:954-1016`
covers all three behaviours in one test:

- `:962-972` — `maxEffectId + 1` throws `"beyond the outbox tail"`.
- `:977-991` — the tail itself is accepted for three consumers.
- `:992-1001` — a prune then empties the table
  (`expect(rowCount(ctx.db, "claim_operation_effects")).toBe(0)`).
- `:1002-1012` — re-acknowledging `maxEffectId` against the empty table
  `.not.toThrow()`, exercising the `?? existing` fallback.

The test's own comment at `:955-958` restates the production comment's reasoning,
so the test was written from it.

## Failure scenario

Two projects, A and B. A's last effect is id 10; B's is id 500. A consumer
acknowledges id 400 for project A. The regression check passes (400 > previous),
the tail check passes (400 <= 500), and the receipt-split check passes because no
`claim_operation_effects` row in project A sits at or below 400 with a sibling
above it — indeed project A has no row above 10 at all.

Project A's checkpoint now sits at 400. Effects 11 through 400 do not exist yet,
so nothing is lost immediately. When project A next allocates effects, they take
ids above 500, so they are still above the checkpoint and still delivered. The
guard's stated disaster — effects deleted having never been published — therefore
needs the prune path, which no shipped code calls
(`outbox-b-effects-are-never-pruned-in-a-shipped-install`).

So the practical consequence today is narrower than the comment implies: a
project's checkpoint can hold a value with no meaning, and
`readOutboxConsumerCheckpoint` will report it. `drainClaimEffectPrefix`'s partial
check at `:2298-2309` would then throw
`was checkpointed partially` for any receipt whose effects straddle 400, wedging
the lane.

## Timing windows and dependencies

- No interleaving. All three guards read and decide inside the caller's write
  transaction; `pruneClaimOperationEffectsInCurrentTransaction` asserts the same
  requirement explicitly at `:2293-2297`.
- Depends on `outbox-b-checkpoint-monotonicity-is-application-enforced-only`: the
  guard is bypassable from outside.
- Interacts with `outbox-b-effects-are-never-pruned-in-a-shipped-install`, which
  is what currently prevents the comment's disaster from being reachable.

## What a test must construct

1. Two projects with effects, the second holding much higher ids. The existing
   fixture already builds a second project at
   `storage-claim-operations.test.ts:908-909`, so the shape exists.
2. Advance project A's checkpoint to a value above A's own maximum effect id and
   below the global maximum. Assert it succeeds. That single assertion documents
   the scope mismatch.
3. Then allocate a new effect in project A and drive
   `drainClaimEffectPrefix`. Assert the outcome — whether the new effect is
   delivered, or whether the partial check at `:2298-2309` throws.
4. Positive control: the same advance one above the *global* maximum, asserting
   `"beyond the outbox tail"`, which the existing test already covers at
   `:962-972`.
5. Coverage-check form: `CHECKPOINT_ABOVE_OWN_PROJECT_MAX` fires when an accepted
   `ackedEffectId` exceeds `MAX(id)` for its own `project_id`. That is a
   precondition, not a violation, and it fires on the current tree.

## Investigation log

### Q: Is the global `MAX(id)` deliberate, given the guard beside it is project-scoped?

- Sources examined: the comment at `:2227-2236`, which reasons entirely about
  "the prune boundary" and "every required consumer" without mentioning
  projects; the prune function's own doc comment at `:2274-2288`, which is
  emphatically about projects — "The pairing is what makes the boundary sound.
  Checkpoints are keyed (consumer, project_id) while the delete below is global
  over effect ids, so a consumer-only aggregate reports a boundary derived from
  the projects it HAS acknowledged and silently ignores the ones it never
  checkpointed"; the test at `:902-952`, written specifically for that pairing.
- Findings: the author demonstrably understood the per-project subtlety, wrote a
  paragraph about it, and wrote a test for it — for the prune boundary. The tail
  check sits twenty lines earlier and does not carry the same care. Since a
  per-project tail would be strictly tighter and never reject a legitimate
  advance (ids come from one monotonic sequence), there is no cost argument for
  the global form that I can see. But nothing in the code says it was
  considered and rejected either.
- Missing evidence: a rationale. The `docs/` sweep found no outbox specification.
- Conclusion: needs human input.
