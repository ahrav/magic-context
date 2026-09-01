# tshist-a-mutation-battery-drives-one-rejecting-check

## Discovery trigger

Task 4 asks whether the mutation battery's seven classes cover the three
omissions Part 4a names. The battery is the strongest-looking executing evidence
in the part, so establishing what it actually drives was necessary before any
record could cite it as coverage.

## Evidence trail

All references at `HEAD` = `e447c927`.

**It runs, per pull request, with no credentials.**
`.github/workflows/ci.yml:439-440`:

```
      - name: Run the invalid-state mutation battery
        run: bun packages/e2e-tests/scripts/run-historian-eval.ts --mutations
```

`ci.yml:411-414` states the design intent: "Contract lint, scorer tests, the
freeze lint, and the mutation battery all run per-PR with no live model calls and
no credentials (R14); live scenario runs are scheduled or dispatched through
historian-eval.yml only."

**The seven classes and their expected stages.**
`packages/e2e-tests/src/historian-eval/mutations.ts:33-41`:

```
export const MUTATION_CLASSES = [
    "speculation-promoted",
    "rejected-proposal-active",
    "wrong-category",
    "dropped-gold-fact",
    "near-miss-perturbation",
    "structural-overlap",
    "probe-wrong-answer",
] as const;
```

`:50-58`:

```
export const EXPECTED_OUTCOMES: Record<MutationClass, ExpectedMutationOutcome> = {
    "speculation-promoted": { stage: "scored", failReason: "false-authoritative" },
    "rejected-proposal-active": { stage: "scored", failReason: "false-authoritative" },
    "wrong-category": { stage: "scored", failReason: "recall" },
    "dropped-gold-fact": { stage: "scored", failReason: "recall" },
    "near-miss-perturbation": { stage: "scored", failReason: ["recall", "false-authoritative"] },
    "structural-overlap": { stage: "validation-rejected" },
    "probe-wrong-answer": { stage: "probe-comparison", outcome: "fail" },
};
```

One entry expects `validation-rejected`. Five expect `scored`, which means they
pass the validator and are judged by the scorer. One expects a probe comparison.

**The stage assertion is strict, in both directions.** `:187-192`:

```
const result = scoreRawOutput(output, scenario, batteryScoringOptions(scenario));
if (expected.stage === "validation-rejected") {
    if (result.stage !== "validation-rejected") {
        return { green: false, detail: `expected stage validation-rejected but landed at ${result.stage}` };
    }
```

So a semantic mutation that starts dying in validation is a battery error, not a
silent pass. The module docstring at `:4-11` names that as the reason.

**What `structural-overlap` builds.** `:344-355`:

```
const overlapping = buildMockHistorianOutput({
    compartments: [
        { start: 1, end: Math.max(2, messageCount - 2), title: "A", body: "a" },
        { start: Math.max(1, messageCount - 3), end: messageCount, title: "B", body: "b" },
    ],
    ...
```

The second compartment starts before the first ends. That is
`compartment-runner-validation.ts:295-297`, the overlap arm, which Part 4a
numbers as Rust check 16. One check of 22.

**The chunk the battery drives has no completed tool arcs.**
`packages/e2e-tests/src/historian-eval/scorer.ts:594-599`:

```
lines: Array.from({ length: endIndex - startIndex + 1 }, (_, index) => ({
    ordinal: startIndex + index,
    messageId: `msg-${startIndex + index}`,
})),
toolOnlyRanges: [],
completedToolArcs: [],
```

Empty arrays for both. `compartment-runner-validation.ts:63-68` returns `false`
for an empty arc list, so the terminal-arc reject at `:166-171` can never fire in
the lane, and `:53-55` can never heal. Contiguous synthesized ordinals also mean
the gap and coverage arithmetic never sees a hole.

**The gate is driven with no prior state.** `scorer.ts:715`:

```
const validated = validateHistorianOutput(rawOutput, RAW_OUTPUT_SESSION_ID, chunk, [], 1);
```

`[]` for prior compartments. `validateStoredCompartments` is called separately at
`:280` over the scorer's own row list, and `validateChunkCoverage` is not called
at all in the scorer. So the four relocated checks from record 7 are absent or
differently composed here.

**Against Part 4a's three omissions.** No class targets chunk-identity binding,
because no class perturbs the relationship between output text and chunk. No class
targets minimum summary size: the fixtures carry real bodies, and
`buildMockHistorianOutput` is a fixture builder, not a degenerate-body generator.
No class targets gate-ran enforcement, because every class goes through
`scoreRawOutput`, which calls the gate.

## Failure scenario

Not a defect scenario but a misreading scenario, and it is the one this record
exists to prevent. A reader sees a green seven-class mutation battery running on
every pull request against a frozen corpus and concludes the validator is
covered. It is covered for one rejecting check out of 22, with arcs disabled, with
contiguous ordinals, and with no prior state. The other 21 checks are exercised
only by the unit suite at `ci.yml:257`, and three of them not at all on either
side.

## Timing windows and dependencies

No timing window.

The dependency worth naming: the battery's value is real and lies elsewhere. It is
strong evidence about the *scorer*, five classes' worth, and about the
construction invariant at `:431-449` that keeps semantic fixtures validator-clean.
Neither is validator coverage.

## What a test must construct

To make this record's claim checkable rather than merely stated, the lane would
need a per-check coverage assertion: for each of the 22 rejecting checks, either a
class that reaches it or an explicit recorded exemption. The battery already has
the shape for this, since `MutationResult` carries an `applicable` flag (`:63`)
for classes that do not apply to a scenario, and a `battery-coverage` pseudo-class
already exists in the `mutationClass` union (`:61`).

Adding classes for the three omissions is cheap in the same frame: a degenerate
one-character `p1` covering a wide span, and an output whose compartments cover
the right ordinals with text from a different conversation.

## Investigation log

### Q: Would adding a class for each of the three omissions be cheap, given the battery already builds crafted outputs and asserts a stage?

- Sources examined: `mutations.ts:4-11`, `:33-41`, `:50-58`, `:61-67`, `:187-192`,
  `:320-355`, `:431-449`; `scorer.ts:280`, `:347-351`, `:594-599`, `:715`, `:757`;
  `ci.yml:411-414`, `:439-440`.
- Findings: mechanically cheap. The battery already constructs arbitrary outputs
  through `buildMockHistorianOutput` and asserts a stage per class, and a
  `battery-coverage` class name already exists in the union. The obstacle is not
  the harness.
- Missing evidence: what the expected stage would be for a minimum-size class,
  since neither implementation rejects a degenerate body today. The honest
  expectation is `scored`, which makes it a scorer test rather than a validator
  test, and that is a design question.
- Conclusion: unresolved, needs a design pass. It is a coverage-gap proposal
  rather than a property, and it belongs in the fault map.
