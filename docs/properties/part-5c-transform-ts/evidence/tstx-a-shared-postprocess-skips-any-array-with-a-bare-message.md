# tstx-a-shared-postprocess-skips-any-array-with-a-bare-message

## Discovery trigger

Part 4b establishes that the CI suite's module transport is a hand-written stub
returning canned objects. The task asks what the adapter does with a response the
stub could never produce. Answering that required first characterising what the
stub *does* produce, and reading the stub's shapes revealed the opposite finding:
the shape the stub produces is itself special-cased in production source, and the
special case disables the whole shared postprocess phase. So the 70-test suite
does not merely fail to cover the interesting inputs; it systematically runs the
skip arm.

## Evidence trail

Read at `HEAD` = `e447c927`.

**The guard.** `packages/plugin/src/hooks/magic-context/transform-postprocess-phase.ts:367-380`:

```ts
if (!args.fullFeatureMode || args.compactionOff) return;
// Test doubles and older integrations may return the legacy bare message shape.
// The host-side sticky phase only applies to OpenCode MessageLike objects, so leave
// those responses untouched instead of treating a missing `info` object as a failure.
if (
    args.messages.some(
        (message) =>
            !message ||
            typeof message !== "object" ||
            !isRecord((message as { info?: unknown }).info),
    )
) {
    return;
}
```

Two returns. `:367` is the mode gate and is not this record. `:371-380` is the
shape gate, and the predicate is `some`, not `every`: **one** element lacking a
record `info` suppresses the phase for the whole array.

The justification at `:368-370` names test doubles first. That is the finding: a
production tolerance introduced to accommodate test fixtures, which the fixtures
then exercise instead of the body.

**What the body does, and therefore what is skipped.** `:381-422`, in order:

- `reconcileMarkerRepresentation` (`:381-390`), which drops stale summary tags in
  a transaction (`:466-470`), splices stale summaries out of the served array
  (`:474`), and re-injects the persisted marker summary with a freshly assigned
  tag (`:477-491`).
- Note-nudge anchors appended to their target user messages (`:391-393`).
- Auto-search hint decisions appended, gated on
  `autoSearchHintFragmentsStillEligible` (`:394-405`).
- The deferred-notes path (`:407-422`), which calls `markNoteNudgeDelivered`
  (`:417`) and appends only if `outcome.ok` (`:418-419`), logging when it is not
  (`:420-421`).

So the skip suppresses marker reconciliation, note nudges, auto-search hints, and
deferred-note delivery, all four, together, silently. There is no `sessionLog` on
the return path at `:379`.

**The call site.** `packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:2650-2659`
calls it with `messages: appliedMessages as MessageLike[]`, the array the module
just returned and the adapter applied verbatim.

**The stub's shape trips it.** From `rust-mode-transform.test.ts` (3,702 lines, 70
tests), the declared `native` arrays are bare at `:848`, `:954`, `:1049`,
`:1548`, `:1657`, `:1709`, `:1764`, and `:1823`. `:848` is representative:

```ts
const native = [{ role: "assistant", parts: [{ type: "text", text: "module output" }] }];
```

No `info` key, so `isRecord(message.info)` is `isRecord(undefined)` → false, so
`some` is true, so the phase returns at `:379`.

Only one array in the file carries `info` wrappers: `:973-982`, inside the test at
`:967`. `grep -c "info: { role"` over the file returns 2, both inside that array.

So of the 70 tests, at most one can reach the postprocess body through the adapter.

**Why this is not a test-only concern.** `isRecord` in
`transform-postprocess-phase.ts` is imported, not local, and the guard is
unconditional production code. Nothing distinguishes a test double from a real
module response — the predicate is purely structural. A real module that omits
`info` on one element of an otherwise-correct array gets the same treatment.

Whether a real module ever does is a `mc-module` question this record does not
answer. What it establishes is that the adapter's contract with the module does
not require `info` anywhere: `applyNativeMessagesVerbatim` (`:1245-1289`) does not
check it, and `:1264-1265` explicitly forbids inspecting the array ("Do not clone,
normalize, or otherwise inspect the returned native message array"). So the
absence is permitted by the wire contract and punished by the postprocess.

## Failure scenario

A module response contains 40 well-formed messages and one whose `info` was
dropped — a serialization edge, a synthetic message assembled on a different code
path, a partial write in the encode-back. The adapter applies all 41 verbatim.
`runRustModePostprocess` returns at `:379`.

Consequences for that pass:

- A pending note nudge is not appended. `markNoteNudgeDelivered` (`:417`) is
  never reached, so the nudge is not marked delivered and **defers** rather than
  being lost. That is the good case, and it is good by accident: the durable write
  happens after the appends, so the early return cannot half-deliver.
- A persisted compaction marker is not reconciled. The served array keeps whatever
  summary messages the module returned, including stale ones that
  `reconcileMarkerRepresentation` exists to remove (`:439-441` describes rebuilding
  from persisted state to remove "stale loser-process arrays and duplicate
  summaries deterministically"). So the model sees duplicate or stale summaries.
- An auto-search hint is not appended, and since the eligibility check at `:397`
  is also skipped, nothing records that it was skipped.

If the malformed element recurs every pass — a stable module bug rather than a
transient one — the deferral is unbounded, and the four features are off for the
session with no diagnostic. That is the shape worth alarming on.

## Timing windows and dependencies

No race. The window is the length of the condition: one pass.

The interaction that matters is with the other two module-triggered gates. On the
stub's shape, all three are off simultaneously:

| Gate | Site | Off because |
| --- | --- | --- |
| Boundary assert | `rust-mode-transform.ts:2660-2663` | no `boundary_id` |
| Rendered-claim check | `rust-mode-transform.ts:720-722` | no locators, no vector |
| Shared postprocess | `transform-postprocess-phase.ts:371-380` | no `info` |

So the CI suite's canned shape disables every structural check the adapter has.
That is why this record and `tstx-a-boundary-assert-is-module-triggered` should be
read together: individually each is a gate, together they are the reason 68 of 70
tests constrain almost nothing about response handling.

Dependency: `fullFeatureMode` at `:367` is `!sessionMeta.isSubagent` (passed from
`rust-mode-transform.ts:2654`), and `compactionOff` comes from deps. A subagent
session or compaction-off mode returns at `:367` for unrelated and legitimate
reasons, so a test must set neither.

## What a test must construct

1. **The skip, asserted as a skip.** A rust-mode pass with durable state the body
   would act on — the cheapest is a note-nudge anchor, since
   `getNoteNudgeAnchors` (`:391`) is a plain read and the append is observable in
   the served array. Return a module array of two messages where the first carries
   `info` and the second does not. Assert the served array contains **no** appended
   reminder, and assert the nudge is still pending afterwards. The second assertion
   is what distinguishes a skip from a silent loss.
2. **The same fixture with `info` on both.** Assert the reminder **is** appended.
   Together with case 1 this pins the predicate's `some` semantics: one bad element
   is enough.
3. **The four-feature sweep.** For each of marker reconciliation, note nudges,
   auto-search hints, and deferred notes, one pair of the above. The value is not
   redundancy; it is that the guard suppresses four independent features and a
   single-feature test would leave three uncovered if the guard were later narrowed.
4. **A coverage check, not an assertion of the defect.** Per METHOD.md's
   coverage-check rules, assert the independent preconditions that create the
   window: a rust-mode non-subagent pass with compaction on, at least one durable
   postprocess obligation pending, and at least one applied message lacking `info`.
   Those three co-occurring is the vulnerable state, and the marker fires on a
   correct implementation.

Note what a test must *not* do: assert that no production module ever omits
`info`. That is unfalsifiable from the TypeScript side and it is the wrong oracle;
the property is about what the guard does, not about what the module sends.

## Investigation log

### Q: Should the tolerance be narrowed to the shapes tests actually produce, or should the guard log? It currently cannot be distinguished from a pass with nothing to do.

- Sources examined: `transform-postprocess-phase.ts:367-380`; the four bodies at
  `:381-422`; the call site at `rust-mode-transform.ts:2650-2659`; the eight bare
  `native` declarations and the one `info`-bearing array in
  `rust-mode-transform.test.ts`.
- Findings: three options, and they are not equivalent. (a) Log on the `:379`
  return. Cheapest, makes the skip observable, changes no behaviour. (b) Filter
  rather than skip — run the body over the elements that do have `info`. That
  changes behaviour and could half-apply a marker reconciliation whose correctness
  depends on seeing the whole array, since `reconcileMarkerRepresentation` splices
  the array at `:474`. (c) Narrow the guard to the head element only, which is
  where the legacy bare shape actually appears in the fixtures. I could not
  establish that the bare shape only ever appears at the head, so (c) is not
  obviously safe.
- Missing evidence: whether "older integrations" in the comment at `:368` refers to
  a still-supported module version or to a historical one. If no supported module
  emits the bare shape, the tolerance exists solely for test doubles and the honest
  fix is to fix the doubles.
- Conclusion: needs human input, and the question to put to a human is narrower
  than the original: does any supported `mc-module` version return messages without
  an `info` wrapper? If no, the tolerance is test-only and should move into the
  tests. If yes, option (a) is the safe increment. I recommend (a) regardless,
  because it costs one line and converts a silent skip into an observable one,
  which is a precondition for alarming on the recurring case.

### Q: Does the early return risk a half-delivered note nudge?

- Sources examined: `:407-422`, the deferred-notes block; `markNoteNudgeDelivered`
  at `:417`; the `outcome.ok` branch at `:418-421`.
- Findings: no. The durable write (`:417`) is strictly after every append and
  strictly after the guard, so the guard cannot interleave with it. The block is
  ordered write-then-append with an outcome check, so the genuinely risky ordering
  — marked delivered, not appended — is representable when `outcome.ok` is true but
  `anchoredMessageId` is null (`:418`), and *that* is independent of this guard.
- Missing evidence: none for this question.
- Conclusion: resolved. The guard's failure mode is deferral, not loss. Noted in
  the failure scenario as good by accident, because the ordering that makes it safe
  is not commented as deliberate. The `anchoredMessageId`-null case is a separate
  observation and belongs to whoever catalogs the note-nudge protocol; it is outside
  this record's claim.
