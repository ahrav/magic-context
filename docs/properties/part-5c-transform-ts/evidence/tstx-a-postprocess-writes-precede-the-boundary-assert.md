# tstx-a-postprocess-writes-precede-the-boundary-assert

## Discovery trigger

Part 4b's second framing fact is that two durable writes break the fenced-commit
contract: `descend_lineage` (`transform.rs:3312`) and
`truncate_compartments_for_revert` (`:4646`) each commit their own transaction
before the terminal CAS and neither is rolled back. Part 4b also corrects the
framing to say both are observable today because straight-line error paths sit
downstream of each inside the same pass
([part-4b catalog:263-277](../../part-4b-transform/catalog.md)).

Looking for that shape on the TypeScript side, the question inverts: there is no
fence, so nothing can be outside it. The comparable structure is a durable write
followed by a validation that can still reject the pass, and the adapter has
exactly one, twelve lines apart.

## Evidence trail

Read at `HEAD` = `e447c927`. References in
`packages/plugin/src/hooks/magic-context/rust-mode-transform.ts` unless stated.

**The ordering.** `:2639-2663`, with intervening lines elided:

```ts
appliedMessages = applyNativeMessagesVerbatim(
    { messages: [] },
    response,
    previousWireCache?.nativeOutput ? { ... } : undefined,
);
pendingWireCache.nativeOutput = appliedMessages;
runRustModePostprocess({
    db: deps.db,
    sessionId,
    messages: appliedMessages as MessageLike[],
    ...
});
const boundaryId = response.boundary_id;
if (typeof boundaryId === "string" && boundaryId.length > 0) {
    assertNativeBoundary(appliedMessages, sessionId, boundaryId);
}
```

`runRustModePostprocess` is `:2650-2659`. `assertNativeBoundary` is `:2662`. No
branch, no try, and no early return between them.

**What the postprocess commits before the assert.** From
`packages/plugin/src/hooks/magic-context/transform-postprocess-phase.ts:381-422`:

- `reconcileMarkerRepresentation` (`:381-390`), which opens a transaction at
  `:466-470` and sets stale summary tags to `dropped` via `dropMarkerSummaryTag`
  (`:425-432`, `updateTagStatus` at `:431`), and assigns a new tag through
  `options.tagger.assignTag` at `:477-491`.
- `markNoteNudgeDelivered` (`:417`) in the deferred-notes path.

Two durable effect classes, then a validation that can reject the pass.

**The rejection path leaves them.** When `assertNativeBoundary` throws at
`:652-654`, control reaches the single `catch` at `:2894`. The handler logs the
wire-invariant case (`:2896-2903`), then — absent `emergencyFailClosed` — calls
`replayLastGood` (`:2916-2921`) and `markFailure` (`:2924`). Nothing reverts a
database write, and there is no transaction open around `:2650-2662` to roll back.

**Why the note-nudge case is the one that matters.**
`transform-postprocess-phase.ts:407-421`:

```ts
if (!deferredNoteText) return;
const instruction = `\n\n<instruction name="deferred_notes">${deferredNoteText}</instruction>`;
const anchoredMessageId = findLastUserMessageId(args.messages);
const outcome = markNoteNudgeDelivered(args.db, args.sessionId, instruction, anchoredMessageId);
if (anchoredMessageId && outcome.ok) {
    appendReminderToUserMessageById(args.messages, anchoredMessageId, instruction);
}
```

`markNoteNudgeDelivered` at `:417` marks the nudge delivered. The append at `:418-419`
writes it into `args.messages`, which is `appliedMessages`. If the assert then
throws, the served array comes from `replayLastGood` (O16 step 3) or the raw
fallback (step 5), and neither contains the append — the LKG entry was snapshotted
at pass entry and the raw fallback serves the untransformed input
(`:1806`). So the nudge is marked delivered and never served.

That is not idempotent across passes in the way
`messages-transform.ts:181-183` claims for the TypeScript path: a delivered nudge
is not re-offered, so the effect is a lost nudge rather than a retried one. The
marker-tag drops are more benign — a tag re-dropped next pass is a no-op — which
is why the confidence on the effect set is medium and on the ordering high.

**Contrast with the same file's other ordering, which is careful.** `:2914-2915`
states the invariant that makes the fail-open ladder work: "Validation happens
before the caller-owned array is replaced, so the original live array is still
available for fail-open replay." That is honoured by passing a throwaway
`{ messages: [] }` at `:2640` instead of `output`. So the author reasoned
explicitly about ordering with respect to the *array* and not with respect to the
*database*.

## Failure scenario

A module returns a response with a non-empty `boundary_id` whose head fails one
of the three conjuncts at `:636` — say an assistant message where m0 belongs,
which a lineage-switch or recovery response could plausibly produce. The session
has a pending deferred note.

1. `applyNativeMessagesVerbatim` builds `appliedMessages` (`:2639`).
2. `runRustModePostprocess` marks the note delivered (`:417`) and appends it to
   `appliedMessages` (`:418-419`).
3. `assertNativeBoundary` throws (`:2662` → `:652`).
4. The catch logs (`:2896-2903`), replays LKG (`:2916`), marks a failure (`:2924`).
5. The user is served the LKG array. It has no note.
6. The nudge is durably delivered, so no later pass offers it.

The note is lost. Three consecutive such passes also park the session
(`:1474-1485`), so the loss coincides with a degraded mode where the user is least
likely to notice a missing nudge.

## Timing windows and dependencies

The window is `:2650` to `:2662`, straight-line. It is not a race: a single-threaded
pass either reaches the assert or does not. That makes the property cheap to test —
no interleaving, no injected fault beyond a crafted response.

Dependencies that gate reachability:

- The assert only runs when `boundary_id` is present
  (`tstx-a-boundary-assert-is-module-triggered`). So this record's window is open
  only on responses that opt into validation.
- The postprocess only runs when every applied message carries `info`
  (`tstx-a-shared-postprocess-skips-any-array-with-a-bare-message`). So the window
  needs a **well-shaped array with a badly-shaped head** — well-shaped enough for
  the postprocess to act, malformed enough for the assert to reject.

That conjunction is why the existing test does not cover it: `rust-mode-transform.test.ts:1011`
supplies a head with `info` and a non-synthetic part, so the postprocess arguably
does run, but the test asserts only array restoration (`:1038-1039`) and
`failureCount` (`:1040`), never a durable effect. The session in that test has no
pending nudge, so there is nothing to lose.

## What a test must construct

1. **The lost nudge.** Seed a session with a deferred note so
   `peekNoteNudgeText` (`transform-postprocess-phase.ts:407-413`) returns text.
   Stub a module response with `boundary_id: "m1#0"` and a `native_messages` array
   whose every element carries `info` but whose head is an assistant message.
   Assert: the pass fails (`failureCount === 1`), the served array is the LKG or
   input array and contains no `deferred_notes` instruction, **and** the nudge is
   now marked delivered. The third assertion is the property; the first two set up
   the observation.
2. **The control.** Same fixture, well-formed head. Assert the nudge is delivered
   *and* appears in the served array. The pair is what makes case 1 a finding rather
   than an artefact of the seeding.
3. **The marker-tag variant.** Seed a persisted compaction marker plus a stale
   summary so `reconcileMarkerRepresentation` has tags to drop, then reject. Assert
   the tags are `dropped` while the served array still contains the stale summaries,
   because it came from LKG. This one is the benign case and is worth writing to
   document that it is benign rather than leaving a reader to assume it.
4. **A hoist regression test.** If the ordering is later changed so the assert
   runs first, case 1 flips: the nudge should stay pending. Writing case 1 now means
   the hoist is provable rather than hopeful.

## Investigation log

### Q: Is the ordering deliberate? Moving `assertNativeBoundary` above `runRustModePostprocess` looks free from the source, since the assert reads only the array.

- Sources examined: `rust-mode-transform.ts:2635-2663`, including the comment at
  `:2636-2638` ("Validate and postprocess the module result before touching the
  caller-owned array. This keeps failure recovery O(1) on the steady path: no defensive
  full-array clone is needed just in case boundary validation rejects it"); the
  comment at `:2914-2915`; `assertNativeBoundary`'s signature and body at
  `:630-654`; `runRustModePostprocess`'s signature at
  `transform-postprocess-phase.ts:357-366`.
- Findings: `assertNativeBoundary` takes `(output, sessionId, boundaryId)` and
  reads only the array — no `db`, no state mutation, and it either returns or
  throws. So hoisting it above `:2650` is a pure reordering with no data dependency
  in the way. The comment at `:2636-2638` shows the author was thinking about
  rejection cost at exactly this point, and its wording is itself evidence: it says
  "Validate and postprocess", in that order, while the code postprocesses at `:2650`
  and validates at `:2662`, and chose a throwaway target to avoid a
  clone. That is evidence the ordering was considered with respect to the array and
  no evidence it was considered with respect to the database.
- Missing evidence: any comment, commit message, or test naming the postprocess-then-assert
  order as intentional. I did not search the git history for the commit that
  introduced `:2650`, which would settle it.
- Conclusion: needs human input, but the question is narrow and the answer is
  probably "no reason". Recommend framing it as: is there a case where the
  postprocess must run on an array the boundary check would reject? If not, hoist
  the assert and this record becomes an `always-or-unreached` about a window that
  no longer exists — the cheapest possible resolution.

### Q: Which of the postprocess's durable effects are not idempotent across a rejected pass?

- Sources examined: `transform-postprocess-phase.ts:381-422`; `dropMarkerSummaryTag`
  at `:425-432`; `markNoteNudgeDelivered` at `:417` and its outcome use at
  `:418-421`; `getNoteNudgeAnchors` at `:391` and `getAutoSearchHintDecisions` at
  `:394`, both reads.
- Findings: the anchor and hint loops (`:391-405`) are read-then-append with no
  write, so a rejected pass leaves them fully repeatable. `dropMarkerSummaryTag`
  sets a status to `dropped`, which is idempotent by construction. The tag assigned
  at `:477-491` allocates a number, so repeating it may or may not allocate a second
  — that depends on `assignTag`, which is outside this file set. `markNoteNudgeDelivered`
  is the clear non-idempotent one: its name and its `outcome.ok` gate both imply a
  once-only transition.
- Missing evidence: `assignTag`'s behaviour on a repeated
  `(sessionId, "<summaryMessageId>:p0")` key. If it mints a fresh number each call,
  a rejected pass burns tag numbers, which is minor but worth knowing.
- Conclusion: unresolved for `assignTag`, resolved for the rest. The record's
  guarantee does not depend on `assignTag` — one non-idempotent effect is enough to
  make the ordering matter, and `markNoteNudgeDelivered` supplies it. Confidence on
  the effect set is recorded as medium for exactly this reason.
