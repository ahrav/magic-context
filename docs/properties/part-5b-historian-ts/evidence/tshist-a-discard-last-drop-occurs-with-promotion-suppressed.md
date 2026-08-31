# tshist-a-discard-last-drop-occurs-with-promotion-suppressed

## Discovery trigger

The `sometimes` record for this lens. Discard-last has direct unit coverage, so
its lines execute on every push. What the unit tests cannot produce is the
operational state: a real publication in which the drop fires and, because it
fired, three separate side-channel writes are all withheld. That distinction is
exactly the one `METHOD.md:72-74` draws between `reachable` and `sometimes`.

## Evidence trail

All references at `HEAD` = `e447c927`.

**The decision.**
`packages/plugin/src/hooks/magic-context/compartment-runner-validation.ts:104-117`:

```
export function shouldDiscardLastHistorianCompartment(
    compartments: ReadonlyArray<{ endMessage: number }>,
    chunk: Pick<HistorianValidationChunk, "endIndex" | "completedToolArcs">,
): boolean {
    if (compartments.length < 2) return false;

    const last = compartments[compartments.length - 1];
    const previous = compartments[compartments.length - 2];
    const lookaheadMargin = chunk.endIndex - last.endMessage;
    return (
        lookaheadMargin <= HISTORIAN_BOUNDARY_HEALING_SLACK &&
        !boundarySplitsCompletedToolArc(previous.endMessage + 1, chunk.completedToolArcs)
    );
}
```

`HISTORIAN_BOUNDARY_HEALING_SLACK` is 2 (`:11`).

**Where it is applied.** `compartment-runner-incremental.ts:515-530`:

```
const inEmergency = getOverflowState(db, sessionId).needsEmergencyRecovery;
let persistedCompartments = emittedCompartments;
if (
    !inEmergency &&
    !forceKeepLastCompartmentForChunk &&
    shouldDiscardLastHistorianCompartment(emittedCompartments, chunk)
) {
    ...
    persistedCompartments = emittedCompartments.slice(0, -1);
    telemetry.discardedLast = true;
```

The rationale at `:500-514` explains why the last compartment is structurally
unreliable: it was decided without lookahead, so it is re-derived next run when
following context exists.

**The suppression it implies.** `:591-593`:

```
const discardedLast = persistedCompartments.length < emittedCompartments.length;
const weakLookaheadFinalCompartment = forceKeepLastCompartmentForChunk;
const skipUnanchoredPromotion = discardedLast || weakLookaheadFinalCompartment;
```

Three consumers, all gated on it:

- Durable fact promotion, `:663`: `if (promotionActive && !skipUnanchoredPromotion)`.
- User-memory candidates, `:820-825`: `!skipUnanchoredPromotion` in the condition.
- Primer candidates, `:849-854`: same.

The reason is stated at `:579-586`: facts are unanchored, so "persisted-range
facts cannot be separated from discarded-tail facts; a reworded re-emission next
run would double up."

Events are handled separately and not by this flag: `:616-623` filters any event
whose `atCompartment` exceeds `persistedCompartments.length`, because the index is
1-based into the *emitted* list.

**Forward progress is checked after the drop.** `:534-553` reads
`newCompartments[newCompartments.length - 1]?.endMessage ?? 0`, where
`newCompartments` is `persistedCompartments` (`:532`). So a drop that would leave
no progress fails the run rather than publishing nothing.

**Existing coverage, and its limit.**
`compartment-runner-validation.test.ts:296-313` covers the decision directly in
three cases: `k = 1` returns false, an ordinary `k = 2` returns true, and an
arc-splitting retained boundary returns false. Those execute at `ci.yml:257`.
`historian-eval/scorer.ts:347-351` reports the healing decision in the eval lane
when `run.lookaheadMargin <= HISTORIAN_BOUNDARY_HEALING_SLACK`, and `:757` calls
`shouldDiscardLastHistorianCompartment` on validated compartments. So the lines
run and the decision is observed.

What no check does is drive a full publish in which the drop fires and then assert
that all three side channels were withheld. `:663`, `:820-825`, and `:849-854` are
three independent conditions reading one flag, and nothing ties them together.

## Failure scenario

A regression that computes `skipUnanchoredPromotion` correctly for facts and
loses it for primers, say by reordering the primer condition at `:849-854`.

Run N discards its last compartment and promotes a primer sourced from the
dropped tail. Run N+1 re-derives that compartment, now non-last, and promotes the
same primer again. `insertPrimerCandidates` (`:881`) is described at `:858-860` as
keyed on a stable occurrence excluding question text, so a *reworded*
re-emission is a second occurrence. The comment at `:579-586` names this exact
double-up as what the gate prevents.

Nothing executing today would catch it, because the only assertions on the drop
are on the boolean decision, not on its consequences.

## Timing windows and dependencies

The decision reads durable overflow state at `:515`, so it is
pressure-dependent: at 95 percent recovery the drop is skipped entirely to
maximize relief, per the comment at `:511-512`. That is why this is a `sometimes`
record rather than an `always` one. A campaign that never reaches the
non-emergency, near-full-chunk shape never produces the state, and the
suppression logic is then unexercised in composition even though its lines ran.

The other enabling condition is the model's behaviour: it must consume nearly the
whole chunk, leaving a lookahead margin of 0, 1, or 2, while emitting at least two
compartments.

## What a test must construct

1. A session under moderate pressure, so `needsEmergencyRecovery` is false.
2. `forceKeepLastCompartment` unset and `chunk.hasMore` such that
   `forceKeepLastCompartmentForChunk` is false (`:354-355`).
3. A model output with at least two compartments whose last `endMessage` is within
   2 of `chunk.endIndex`, and whose retained boundary does not split an arc.
4. Facts, user observations, and primer candidates all present in the output.
5. The coverage marker fires on the preconditions only: one fewer compartment
   than emitted, plus non-empty `facts`, `userObservations`, and
   `primerCandidates` on the validated pass. It must not assert the suppression,
   because a marker that can only fire by observing the double-promotion defect
   is useless on a correct implementation (`METHOD.md:79-83`).
6. A separate ordinary test, not the marker, asserts the consequence: zero rows
   written by `promoteSessionFactsDurable`, `insertUserMemoryCandidates`, and
   `insertPrimerCandidates` for that run.
7. Assert events anchored at index `emittedCompartments.length` were filtered
   (`:618`) while earlier ones survived.

Step 6 is the composition assertion that does not exist. Step 7 is a separate
mechanism worth asserting in the same run because both derive from the same drop.

## Investigation log

### Q: None.

- Sources examined: `compartment-runner-validation.ts:11`, `:104-117`;
  `compartment-runner-incremental.ts:354-355`, `:500-530`, `:534-553`, `:579-593`,
  `:616-623`, `:663`, `:820-825`, `:849-901`;
  `compartment-runner-validation.test.ts:296-313`;
  `historian-eval/scorer.ts:347-351`, `:757`.
- Findings: the flag's derivation and all three consumers are established, the
  event path is separate, and forward progress is evaluated after the drop. The
  existing coverage is on the decision only.
- Missing evidence: none needed for the property as stated.
- Conclusion: resolved. The situation is reachable in a shipped install, the
  suppression is real, and no check observes the situation and its consequences
  together.
