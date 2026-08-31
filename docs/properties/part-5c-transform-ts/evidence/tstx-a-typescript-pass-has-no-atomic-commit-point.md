# tstx-a-typescript-pass-has-no-atomic-commit-point

## Discovery trigger

Part 4b's framing paragraph states the Rust contract precisely: "The commit point
is a single fenced transaction, but a pass is up to three transactions"
([part-4b catalog:79-95](../../part-4b-transform/catalog.md)). The terminal
`store.commit_transform` at `transform.rs:5565` is one fenced SQLite transaction
in which ten named write groups land or none do, and the engine states the
obligation itself at `transform.rs:3505-3507`.

The task asks what the TypeScript side does with each named Rust behaviour. The
answer for this one is not "it has a weaker fence" but "it has no fence and rests
on a different correctness argument", which is a more interesting finding than a
missing feature, because it means a differential cannot assume either side's
argument holds.

## Evidence trail

Read at `HEAD` = `e447c927`.

**No pass-level transaction exists.** Searching the TypeScript renderer's three
largest units for transaction vocabulary:

- `transform.ts` (2,624 lines): zero matches for `transaction`, `BEGIN`, or
  `IMMEDIATE`. One `.prepare(` in the whole file, at `:417`, and it is
  `SELECT * FROM notes WHERE project_path = ? ORDER BY id ASC`.
- `transform-postprocess-phase.ts` (2,320 lines): one `db.transaction(` at
  `:466`. It wraps a single loop:

```ts
if (staleSummaryIds.size > 0) {
    options.db.transaction(() => {
        for (const messageId of staleSummaryIds) {
            dropMarkerSummaryTag(options.db, options.sessionId, messageId);
        }
    })();
}
```

  That is `:466-470`. It brackets tag-status updates for stale summary ids and
  nothing else.
- `transform-compartment-phase.ts` (447 lines): zero matches.

**No pass-level compare-and-swap exists.** Searching for the Rust mechanism's
vocabulary (`row_version`, `rowVersion`, `expected`, `CasConflict`) across
`transform.ts` and `transform-postprocess-phase.ts` returns only: two calls to
`casChannel2NudgeState` (`transform.ts:2548`, `:2550`), which is a **per-field**
compare-and-swap on one nudge-state column; three `cas-lost-*` outcome strings in
`transform-postprocess-phase.ts:137-138`, `:545`, `:552`, likewise per-field; and
prose uses of the word "case". There is no pass-level expected version and no
reload-and-retry wrapper.

**The pass makes 22 independent durable writes.** Enumerated from `transform.ts`
by matching top-level writer-helper calls, then read individually to confirm each
commits on its own:

| Line | Call |
| --- | --- |
| `:701` | `clearOpenCodePendingTransformDecision` |
| `:806` | `commitCompactionModeRecord` |
| `:1014` | `dropSlot` |
| `:1019` | `updateSessionMeta` |
| `:1026` | `clearHistorianFailureState` |
| `:1027` | `clearPersistedReasoningWatermark` |
| `:1035` | `clearEmergencyDropSample` |
| `:1036` | `clearDetectedContextLimit` |
| `:1037` | `clearEmergencyRecovery` |
| `:1073` | `updateSessionMeta` |
| `:1166` | `dropSlot` |
| `:1167` | `recordOverflowDetected` |
| `:1366` | `setDeferredExecutePendingIfAbsent` |
| `:1475` | `updateSessionMeta` |
| `:1538` | `recordHighPressureNoEligibleHead` |
| `:1655` | `recordSessionProjectIdentity` |
| `:1732` | `updateSessionMeta` |
| `:2331` | `clearEmergencyRecovery` |
| `:2377` | `clearEmergencyDropSample` |
| `:2411` | `dropSlot` |
| `:2421` | `recordPendingTransformDecision` |
| `:2520` | `updateSessionMeta` |

The list is the top-level set in `transform.ts` only; the postprocess phase adds
more. It is a floor, not a ceiling, and the record's claim does not depend on the
exact count — it depends on the count being greater than one, which the first two
rows already establish.

Note `:2520` has an explicit failure log at `:2526`
("conversation_tokens UPDATE failed:"), so at least one of the 22 is known to be
independently failable.

**The stated substitute is idempotence.** `packages/plugin/src/plugin/messages-transform.ts:181-183`:

> Correctness is preserved because all persistent state mutations inside
> the inner transform are idempotent across passes.

That sentence closes the doc comment on `createMessagesTransformHandler`, whose
`catch` at `:170` converts every non-intentional error into a return with the
messages unmodified.

**The gap is conceded in the audit file.** `docs/AUDIT-KNOWN-ISSUES.md:407-426`
is entry A24. `:419-424`:

> The genuinely risky sub-case — a throw *between*
> `prepareCompartmentInjection`'s tail-trim and `injectM0M1`'s prepend, which would
> drop history for that one pass — is bounded (the next pass replays correctly) and
> the content strips are idempotent. A future hardening would stage trim+inject
> atomically so a throw leaves the array fully transformed or fully untouched; that
> is a core-path refactor, not a quick fix, and is deferred.

So the project already knows atomicity is absent, names the one sub-case it
considers risky, and argues from idempotence plus replay. That argument is the
property under test.

## Failure scenario

A pass throws at write site *k*. Sites 1 through *k*−1 are committed; *k* through
22 are not. The outer wrapper returns the messages unmodified
(`messages-transform.ts:170-200`), so the user sees one untransformed turn. The
next pass runs on the mixed state.

The failure is not the mixed state itself — that is the design. The failure is a
write whose replay is not idempotent. Two shapes visible in the write list:

- **A cleared-then-recomputed pair.** `:1035-1037` clear three emergency-recovery
  fields together. A throw between `:1036` and `:1037` leaves
  `detectedContextLimit` cleared and `emergencyRecovery` armed. Whether the next
  pass reconstructs both depends on whether the arming decision reads the limit it
  just lost.
- **A watermark advance.** `:2520` writes `conversationTokens` and
  `toolCallTokens`. If any earlier site consumed a watermark that `:2520`'s values
  are supposed to match, the pair is split.

Neither is asserted here as a defect. They are the two candidate shapes that make
the per-helper audit in the open question worth doing.

## Timing windows and dependencies

The window is the whole pass body, `transform.ts:701` to `:2520`, with 22 commit
points inside it and no bracket around any group of them. Rust's equivalent window
is zero-width by construction: `transform.rs:5565` is one call.

There is a second, wider window. The 22 writes are not the only durable effects: an
out-of-band notice is *sent to the user* at `transform.ts:796-804` before
`commitCompactionModeRecord` at `:806`, and the code comments the ordering
deliberately at `:747-752` ("A notice transition first stages a durable pending
record, then commits its settled value only after delivery; a failure therefore
retries the same logical transition across process restarts"). So one of the 22 is
already a two-phase protocol with an external effect in the middle, and it accepts
a duplicate notice after a crash by design (`:793-796`).

Dependency: the property's truth is a property of the 22 helpers, each of which
lives outside this part's file set. The record can establish the absence of a
fence from inside the set; it cannot establish idempotence from inside the set.
That asymmetry is why the open question is queued rather than answered.

## What a test must construct

A fault seam that chooses *where* to throw. The outer wrapper already converts a
throw into a no-op return, so half the harness exists.

1. Wrap `deps.db` in a proxy that counts write statements and throws on the *n*th.
   `transform.ts` reaches its writes through imported helpers that all take `db`,
   so one proxy covers all 22 without touching source.
2. For each *n* from 1 to 22: run one fixture, capture the full durable state,
   then replay the same fixture to completion with the proxy disarmed. Assert the
   final state equals the state a single uninterrupted run reaches. That is the
   idempotence claim at O7, expressed as an oracle.
3. Assert additionally that the served array after the throw equals the input
   array, which is what the outer wrapper promises and what `AUDIT-KNOWN-ISSUES.md:419-421`
   identifies as the risky sub-case.

Step 2's oracle is the right one because it tests the actual claim rather than a
proxy for it: it does not require knowing which writes are paired, only that
replay converges.

For the comparison against Rust, note what this record makes impossible: a
differential cannot use "state after an interrupted pass" as a comparable
observation, because Rust's is defined (unchanged) and TypeScript's is a function
of where the interruption landed. Only completed passes are comparable.

## Investigation log

### Q: Idempotence is claimed for "all persistent state mutations" (O7). Enumerating 22 helpers against that claim is a per-helper audit larger than this lens.

- Sources examined: the 22 call sites listed above; the one transaction at
  `transform-postprocess-phase.ts:466-470`; `AUDIT-KNOWN-ISSUES.md:407-426`;
  the notice-delivery ordering at `transform.ts:790-813`.
- Findings: three of the 22 are visibly *not* single-shot idempotent in the naive
  sense and are handled explicitly rather than by accident. `commitCompactionModeRecord`
  (`:806`) is gated on `noticeDelivered` and the comment at `:793-796` states the
  design accepts "a duplicate after a crash rather than permanently losing the
  notice", so its idempotence is at the level of the logical transition, not the
  row. `setDeferredExecutePendingIfAbsent` (`:1366`) has if-absent semantics in its
  name. `recordPendingTransformDecision` (`:2421`) deletes rather than writes when
  `bustedThisPass` is false (`transform-decision-log.ts:190-192`). The remaining 19
  I did not read to the same depth.
- Missing evidence: 19 helpers, each in a different module outside this file set,
  several of which (`updateSessionMeta`, called three times with different field
  sets) are generic writers whose idempotence depends on the caller's field
  selection rather than on the helper.
- Conclusion: unresolved, needs a dedicated pass over the write set. The three I
  did read all turn out to be deliberately reasoned about, which raises my prior
  that the claim is largely true and lowers the urgency; but "largely true" is not
  what `messages-transform.ts:181-183` says, and the claim is load-bearing for a
  subsystem with no fence. Recommend the pass be scoped to the 19, with
  `updateSessionMeta`'s three call sites treated as three separate questions.

### Q: Does the single transaction at `transform-postprocess-phase.ts:466-470` cover anything the record should credit?

- Sources examined: `:443-471`, plus `dropMarkerSummaryTag` at `:425-432`.
- Findings: it wraps a loop of `dropMarkerSummaryTag` calls, each of which resolves
  a tag number by message id and sets its status to `dropped` (`:430-431`). The
  transaction makes the *set* of drops atomic with respect to each other. It does
  not bracket the `messages.splice` at `:474` that removes the same summaries from
  the served array, so the durable drop and the array edit are not atomic with each
  other.
- Missing evidence: none for this question.
- Conclusion: resolved. The transaction is real but narrow, and it does not
  contradict the record: it makes a sub-group atomic, not the pass. Worth noting
  that it demonstrates the codebase has the tool and uses it where it judged the
  grouping mattered, which makes the absence elsewhere a choice rather than an
  oversight.
