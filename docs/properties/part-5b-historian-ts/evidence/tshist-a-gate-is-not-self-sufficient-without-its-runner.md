# tshist-a-gate-is-not-self-sufficient-without-its-runner

## Discovery trigger

The 5.3x size asymmetry the scope map flags (352 TypeScript lines against 1,869
Rust) invites the conclusion that the TypeScript validator is four fifths
weaker. Enumerating the 22 checks showed something more specific: four of them
exist on this side but not inside the function named "validate", and the function
accepts the argument they would need while ignoring it.

## Evidence trail

All references at `HEAD` = `e447c927`.

**The signature advertises state it does not read.**
`packages/plugin/src/hooks/magic-context/compartment-runner-validation.ts:119-125`:

```
export function validateHistorianOutput(
    text: string,
    _sessionId: string,
    chunk: HistorianValidationChunk,
    _priorCompartments: StoredCompartmentRange[],
    sequenceOffset: number,
): ValidatedHistorianPassResult {
```

`_sessionId` (`:121`) and `_priorCompartments` (`:123`) are underscore-prefixed
and appear nowhere in the body, which runs `:126-182`. Reading it end to end: the
parse (`:126`), the empty check (`:127-132`), both heals (`:136-142`), mapping
(`:144`), `validateParsedCompartments` (`:152`), the terminal-arc check
(`:166-171`), and the success shape (`:173-182`). No use of either parameter.

**The four relocated checks and every site that runs them.**

| Rust check | TS helper | Sites |
| --- | --- | --- |
| 4, stored ranges valid | `validateStoredCompartments` (`:250-272`) | `compartment-runner-incremental.ts:198`; `pi-historian-runner.ts:489`; `compartment-runner-recomp.ts:249`, `:551`; `compartment-runner-partial-recomp.ts:311` |
| 3, chunk coverage valid | `validateChunkCoverage` (`:325-347`) | `compartment-runner-incremental.ts:384`; `pi-historian-runner.ts:652`; `compartment-runner-recomp.ts:360`; `compartment-runner-partial-recomp.ts:400` |
| 5 and 6, chunk start | derived, not checked | `compartment-runner-incremental.ts:214-217` computes `offset` from the last stored `endMessage`; `:353` builds the chunk from it |
| 22, forward progress | inline | `compartment-runner-incremental.ts:534-553` |

Both helpers are exported from the validator module and imported by the runners
(`compartment-runner-incremental.ts:58-64`,
`pi-historian-runner.ts:88-93`), never called by the gate.

**A third caller already exists and supplies none of them.**
`packages/e2e-tests/src/historian-eval/scorer.ts:715`:

```
const validated = validateHistorianOutput(rawOutput, RAW_OUTPUT_SESSION_ID, chunk, [], 1);
```

The prior array is `[]`, so `validateStoredCompartments` has nothing to reject
even if it were called; the chunk is synthesized at `:594-599` with contiguous
ordinals and empty range arrays; and no forward-progress check follows. That
caller is the executing per-PR mutation battery
(`.github/workflows/ci.yml:439-440`), so the seam is not hypothetical.

**Check 22's placement differs from Rust's, not just its location.** On this side
forward progress is evaluated *after* discard-last has dropped a compartment
(`compartment-runner-incremental.ts:515-530` then `:534-553`), so the check sees
`persistedCompartments`, not what the model emitted. Rust's check 22 is inside the
gate at `:565-570` and therefore sees the emitted set.

## Failure scenario

Two shapes.

First, a new caller. Somebody adds a path that calls `validateHistorianOutput`
and then `appendCompartments`, reasoning from the name and from the
`priorCompartments` parameter that prior state has been validated. That path
inherits none of checks 3, 4, 5, 6, or 22. Part 4a records checks 11 through 15
as the ordinal-sanity family that stops a model claiming coverage of a range it
did not summarize; checks 5, 6, and 22 are the family that stops it claiming
coverage that does not *advance*.

Second, the existing third caller. The mutation battery drives the gate with no
prior state, which is correct for its purpose but means a green battery is
evidence about the gate in isolation and not about the composition the product
ships.

## Timing windows and dependencies

No timing window. This is a composition obligation, and its enforcement is
convention: the two shipped runners happen to call all four helpers.

The dependency is the module boundary itself. Because the helpers are exported
alongside the gate, a reader who imports the gate has the helpers in scope and no
signal that they are mandatory.

## What a test must construct

An enumeration rather than an execution. For every call site of
`validateHistorianOutput` whose result can reach `appendCompartments`, assert on
the same path a call to `validateStoredCompartments`, a call to
`validateChunkCoverage`, a chunk start derived from stored state, and a
forward-progress check.

That is a lint, not a unit test, and it is the honest oracle: the property is
about composition across files, and no single test can observe it. A weaker but
executable proxy is a test that calls the gate with an inverted
`priorCompartments` array and asserts the gate accepts, documenting that the
parameter is inert.

## Investigation log

### Q: None.

- Sources examined: `compartment-runner-validation.ts:119-183`, `:250-272`,
  `:325-347`; `compartment-runner-incremental.ts:58-64`, `:198`, `:214-217`,
  `:353`, `:384`, `:515-553`; `pi-historian-runner.ts:88-93`, `:489`, `:652`;
  `compartment-runner-recomp.ts:249`, `:360`, `:551`;
  `compartment-runner-partial-recomp.ts:311`, `:400`;
  `historian-eval/scorer.ts:594-599`, `:715`; `ci.yml:439-440`.
- Findings: the mechanical facts are fully established. Both parameters are
  unread, all four checks are present at caller level, both shipped runners run
  all four, and the one caller that does not is the eval scorer.
- Missing evidence: none needed for the property as stated.
- Conclusion: resolved. The gate is correct in composition and misleading in
  isolation, and there is already one caller relying on the isolated form.
