# tshist-a-frozen-corpus-fingerprint-does-not-bind-validator-behaviour

## Discovery trigger

Task 4 asks whether the corpus freeze lint can detect a semantic change that
preserves the frozen bytes. The lint runs per pull request, so if it could, it
would be the agreement mechanism record 9 says is missing. Reading what the
fingerprint covers settled it.

## Evidence trail

All references at `HEAD` = `e447c927`.

**The lint runs.** `.github/workflows/ci.yml:436-437`:

```
      - name: Freeze lint over the dev corpus
        run: bun packages/e2e-tests/scripts/run-historian-eval.ts --lint
```

It is in the `historian-eval-contracts` job, which declares no `needs`. The
comment at `ci.yml:400-414` explains that placement: a gate downstream of
`check-plugin` would be skipped whenever `check-plugin` fails, "which reproduces
the silent non-enforcement one job away". So the lane is deliberately structured
to always run, and it does.

**What the lint checks.**
`packages/e2e-tests/scripts/run-historian-eval.ts:169` runs
`scenarios.flatMap((scenario) => lintScenario(scenario))` and `:186` reports
"lint clean: N scenario(s), all M families covered". The corpus-level identity
comes from `contract.ts:1560`, which maps every scenario through
`scenarioFingerprint` and folds the sorted result into `corpusFingerprint`.

**What the fingerprint covers.**
`packages/e2e-tests/src/historian-eval/contract.ts:769-780`:

```
export function scenarioFingerprint(scenario: HistorianEvalScenario): string {
    return canonicalFingerprint({
        schema: scenario.schema,
        id: scenario.id,
        title: scenario.title,
        families: scenario.families,
        transcript: scenario.transcript,
        expectedHistorianRuns: scenario.trigger.expectedHistorianRuns,
        gold: scenario.gold,
        probes: scenario.probes,
    });
}
```

Eight fields, all scenario-authored. No validator artifact, no version of
`compartment-runner-validation.ts`, no hash of the code the scenarios are run
against. The doc comment at `:762-768` describes it as "canonical fingerprint
over everything authored", which is accurate and is exactly the limitation: the
validator is not authored in the corpus.

The lane is careful about a related trap and the care is worth citing, because it
shows the fingerprint's scope was reasoned about. `contract.ts:1546-1552` explains
that `scenarioFingerprint` covering id and title means a copied scenario has a new
identity by construction, so a second name-independent check
(`scenarioSemanticFingerprint`, used at `:1557`) exists to catch duplicates. That
is thorough about corpus authoring and silent about the code under test.

**The one mechanism that does react to a validator change, and its direction.**
`packages/e2e-tests/src/historian-eval/mutations.ts:431-449`:

```
/** Construction invariant: semantic-class fixtures must be validator-clean. */
function assertBaselineValidates(scenario: HistorianEvalScenario): MutationResult | null {
    const result = scoreRawOutput(...);
    if (result.stage !== "scored") {
        return { ... green: false, detail: `baseline fixture failed validation (${result.stage}); semantic classes cannot be exercised` };
    }
```

The module docstring at `:8-11` states the intent: semantic-class fixtures "are
required to be valid per `validateHistorianOutput` by construction (asserted per
scenario, so a validator change surfaces as a battery error instead of a silent
stage migration)". That is real, and it is one-directional. It fires when a
validator change makes a previously valid baseline invalid. It cannot fire when a
change makes the validator more permissive, because a baseline that still scores
is still green.

## Failure scenario

A change that widens the accepted-output set: relaxing the `p1` non-blank check,
or removing the terminal-arc reject, or the `unprocessed_from` ordering in record
5 left as it is while Rust is changed to match TypeScript.

`scenarioFingerprint` is unchanged, because no scenario field moved.
`corpusFingerprint` is unchanged. The lint reports clean. Every baseline still
scores, so `assertBaselineValidates` stays green. The structural-overlap mutation
still rejects, because that check is untouched. The release freezes with a
different validator behind an identical corpus identity, and an approval signed
against `releaseApprovalFingerprint` (`contract.ts:1575`) transfers across
the change.

## Timing windows and dependencies

No timing window.

The dependency is what a freeze is supposed to mean. `contract.ts:1570-1573`
describes the approval fingerprint as covering "everything a release states about
the corpus and its errata [...] so approvals cannot transfer across releases that
differ in any of it". The scope is stated honestly as the corpus. The gap is
between that scope and the natural reading of a frozen eval as pinning behaviour.

## What a test must construct

A contract test on the fingerprint's own inputs, not on a scenario. Assert that
`scenarioFingerprint` and `corpusFingerprint` are byte-identical across two
computations that differ only in the validator module's contents. That is
awkward to write in-process and is really an argument for adding a validator
identity to the tuple rather than a test to add.

The implementable version: extend the release tuple with a hash of the validator
and parser sources, then assert the corpus fingerprint changes when either
changes. That is a change to the lane, not a test, and belongs in the fault map
rather than the catalog.

## Investigation log

### Q: None.

- Sources examined: `ci.yml:400-414`, `:436-437`;
  `run-historian-eval.ts:101`, `:169`, `:186`, `:786`;
  `contract.ts:762-780`, `:1540-1567`, `:1570-1575`;
  `mutations.ts:8-11`, `:431-449`.
- Findings: fully established. The fingerprint's input set is eight scenario
  fields; the lint's per-scenario rules are corpus authoring rules; the only
  validator-sensitive assertion is the baseline check, and it is one-directional.
- Missing evidence: none needed for the property as stated.
- Conclusion: resolved. The freeze lint binds the corpus and not the code, and the
  mutation battery's baseline assertion covers only the stricter direction. A
  permissive change is invisible to both.
