# outbox-b-effects-are-never-pruned-in-a-shipped-install

## Discovery trigger

The advance function's tail comment warns that "once every required consumer holds
a future cursor the prune boundary becomes that future id, and effects allocated
below it afterwards are deleted having never been published to anyone"
(`storage-claim-operations.ts:2229-2232`). Assessing how bad that is requires
knowing who computes the prune boundary in production. Nobody does.

## Evidence trail

**The prune function exists and is careful.**
`packages/plugin/src/features/magic-context/memory/storage-claim-operations.ts:2289-2341`.
It refuses to run outside the caller's write transaction (`:2293-2297`), refuses
an empty required-consumer list (`:2298-2300`), computes the boundary as the
minimum acknowledged id across every required consumer paired with every project
the outbox still holds effects for (`:2301-2313`), returns early when the
boundary is zero (`:2314`), enables the capability row and records the watermark
(`:2315-2321`), deletes only complete receipt groups at or below the boundary
(`:2323-2336`), and clears the capability in a `finally` (`:2338-2340`).

Its doc comment at `:2274-2288` explains why the consumer/project pairing is
load-bearing, in a paragraph that reads like it was written after finding the bug
it prevents.

**Nothing calls it.** `rg -n "pruneClaimOperationEffects"` across the repository
with `--glob '!node_modules' --glob '!dist' --glob '!*.test.ts'` returns exactly
two lines, both inside the function itself:

```
./packages/plugin/src/features/magic-context/memory/storage-claim-operations.ts:2289:export function pruneClaimOperationEffectsInCurrentTransaction(
./packages/plugin/src/features/magic-context/memory/storage-claim-operations.ts:2295:            "pruneClaimOperationEffectsInCurrentTransaction requires the caller's open write transaction",
```

The second is the function's own error string. With tests included, the callers
are seven sites in `storage-claim-operations.test.ts`: `:873`, `:889`, `:925`,
`:944`, `:994`, `:1079`, plus the import at `:42`.

**No required-consumer list exists anywhere.** The function's contract demands
one (`:2291`, `:2298-2300`), and the two consumer identities that would populate
it are defined in a different package directory
(`hooks/magic-context/module-state-sync.ts:1617`, `:1621`). Nothing joins them.
The tests invent names — `"module-mirror"`, `"policy-projector"`,
`"retrieval-projector"`, `"u5-module"` — that appear nowhere in production code.

**The delete trigger therefore never fires either.**
`storage-claim-memory-schema.ts:433-438` refuses any delete unless
`claim_outbox_prune_state.enabled = 1`, and the only writer of that flag is the
prune function (`:2315-2321` to set, `:2339` to clear). So
`claim_operation_effects` is, in a shipped install, strictly append-only with no
exit at all.

**Receipts were already append-only forever.**
`storage-claim-memory-schema.ts:416-418`:
"claim_operation_receipts live until whole-database reset". So both halves of the
receipt-plus-effects ledger grow monotonically for the life of the database
incarnation.

## Failure scenario

Two consequences, pointing in opposite directions.

**Growth.** Every claim operation appends one receipt row and one or more effect
rows, and neither ever leaves. `claim_operation_receipts` carries
`result_json TEXT NOT NULL` and two JSON blobs
(`effect_summary_json`, `generation_vector_json`, `:260-262`), so the per-operation
cost is not small. Over a long-lived project database the effects table also
carries two indexes (`:282-284`) that grow with it. Nothing bounds this, and
nothing reports it.

**Recoverability, in the good direction.** Because no effect row is ever deleted,
the information needed to redo a mis-acknowledged delivery survives indefinitely.
If a checkpoint reset existed, a diverged consumer would be fully recoverable: set
the row back and re-drain. So the unwired prune path is currently the only thing
making the point of no return theoretically reversible, and the absence of a reset
entry point is what keeps it irreversible in practice. See
`outbox-b-no-repair-path-lowers-or-rebuilds-a-claim-consumer-checkpoint`.

**The warning at `:2229-2232` is not currently reachable.** Its disaster needs the
prune path. That does not make the tail guard useless — it makes it a guard
against a future wiring — but it does mean the comment describes a hazard the
shipped product does not have.

## Timing windows and dependencies

- No timing. A static wiring fact.
- Inverts the severity of `outbox-b-checkpoint-never-passes-the-outbox-tail`:
  that guard's stated consequence is gated on this path being wired.
- Softens `outbox-b-checkpoint-advance-is-the-point-of-no-return` in principle
  and not in practice.

## What a test must construct

1. The wiring assertion. Statically, assert that some production module imports
   `pruneClaimOperationEffectsInCurrentTransaction`. On the current tree that
   fails, and the failure is the finding. This is the cheapest possible oracle
   and needs no database.
2. The growth assertion. Drive N memory mutations through the module-mode path
   and assert `rowCount(db, "claim_operation_effects")` is monotone
   non-decreasing and equals the total effect count. Then assert it stays that
   way after a session ends and the database is reopened.
3. Do not add a prune call to make a test pass. This is a discovery catalog, and
   the wiring decision belongs to a human.
4. Coverage-check form: `OUTBOX_EFFECT_APPENDED` fires on each effect insert and
   `OUTBOX_PRUNE_INVOKED` fires when the prune function is entered. Assert the
   first fires and record whether the second ever does. Both are preconditions;
   neither observes a defect.

## Investigation log

### Q: Is the prune path unwired deliberately, pending a required-consumer decision, or is this a lost call site?

- Sources examined: the `rg` result above; the seven test call sites, which
  collectively cover the boundary minimum, the per-project pairing, the
  capability gating, the receipt-survival rule, and prune-then-reopen
  (`storage-claim-operations.test.ts:842-900`, `:902-952`, `:954-1016`,
  `:1060-1087`); the two production consumer constants at
  `module-state-sync.ts:1617` and `:1621`; a `docs/` sweep for `KTD13`,
  `claim_outbox`, and `direct-claims-cutover`, which found no specification and
  no plan document.
- Findings: the depth of the test coverage argues the function was written to be
  used — six tests is a lot of investment in dead code, and one of them
  (`:902-952`) exists specifically to prevent a subtle boundary bug. Against a
  lost call site: the required-consumer list has no home anywhere. Wiring it
  needs a decision about whether `rust-module-claims-v1` counts as required,
  which is exactly the question Part 4d could not resolve about whether that
  consumer applies anything. So the most likely reading is that the prune path is
  blocked on the same unresolved design question, and the author left it complete
  but unwired rather than wire it wrongly. That is a reading, not a finding.
- Missing evidence: a design note or a tracking item. Not retrievable in scope,
  and per the repository's comment discipline a tracking reference would not be
  in the source anyway.
- Conclusion: needs human input.
