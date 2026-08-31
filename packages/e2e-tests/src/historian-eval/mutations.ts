/**
 *
 * Each mutation must fail at its expected stage.
 * The battery fails on a stage mismatch, not only on a PASS.
 * A semantic mutation rejected by validation never reaches the scorer.
 * Semantic-class fixtures must pass `validateHistorianOutput` so they exercise the scorer.
 * A validator change causes a battery error instead of silently moving a mutation to another stage.
 * migration).
 */

import { HISTORIAN_BOUNDARY_HEALING_SLACK } from "../../../plugin/src/hooks/magic-context/compartment-runner-validation";
import { V2_MEMORY_CATEGORIES } from "../../../plugin/src/features/magic-context/memory/constants";
import {
    HEX64_RE,
    predicateMatches,
    scenarioFingerprint,
    type ExpectedClaim,
    type HistorianEvalScenario,
} from "./contract";
import { buildMockHistorianOutput, type MockHistorianCompartment, type MockHistorianFact } from "../mock-historian";
import type { InjectedClaimRecord } from "./claim-read";
import type { ProbeExchange } from "./runner";
import { compareProbeAnswer, scoreRawOutput, type FailReason } from "./scorer";

export const MUTATION_EVIDENCE_SCHEMA = "historian-eval-mutation-evidence/v1";

/* */
const WRONG_PROBE_ANSWER = "historian-eval-mutation-wrong-answer";

export const MUTATION_CLASSES = [
    "speculation-promoted",
    "rejected-proposal-active",
    "wrong-category",
    "dropped-gold-fact",
    "near-miss-perturbation",
    "structural-overlap",
    "probe-wrong-answer",
] as const;
export type MutationClass = (typeof MUTATION_CLASSES)[number];

export type ExpectedMutationOutcome =
    | { stage: "scored"; failReason: FailReason | readonly FailReason[] }
    | { stage: "validation-rejected" }
    | { stage: "probe-comparison"; outcome: "fail" };

/* */
export const EXPECTED_OUTCOMES: Record<MutationClass, ExpectedMutationOutcome> = {
    "speculation-promoted": { stage: "scored", failReason: "false-authoritative" },
    "rejected-proposal-active": { stage: "scored", failReason: "false-authoritative" },
    "wrong-category": { stage: "scored", failReason: "recall" },
    "dropped-gold-fact": { stage: "scored", failReason: "recall" },
    "near-miss-perturbation": { stage: "scored", failReason: ["recall", "false-authoritative"] },
    "structural-overlap": { stage: "validation-rejected" },
    "probe-wrong-answer": { stage: "probe-comparison", outcome: "fail" },
};

export interface MutationResult {
    mutationClass: MutationClass | "baseline-fixture" | "battery-coverage";
    /** `applicable` is false when the class does not apply to the scenario; the result is recorded as skipped. */
    applicable: boolean;
    green: boolean;
    detail: string;
}

export interface ScenarioMutationEvidence {
    scenarioId: string;
    scenarioFingerprint: string;
    green: boolean;
    results: MutationResult[];
}

export interface MutationEvidenceArtifact {
    schema: typeof MUTATION_EVIDENCE_SCHEMA;
    scenarios: ScenarioMutationEvidence[];
    green: boolean;
}

/* */
function goldSatisfyingFacts(scenario: HistorianEvalScenario): MockHistorianFact[] {
    return scenario.gold.expectedClaims.map((claim) => ({
        category: claim.category,
        content: `Recorded decision: ${claim.predicate.value}.`,
    }));
}

/**
 * Baseline compartments form `gold.compartments.minCount` contiguous, non-overlapping segments over the authored transcript.
 * A single compartment triggers `compartment-count` when `gold.compartments.minCount` exceeds one.
 * A baseline failure prevents scenario promotion before mutations run.
 * The count is clamped to the message count because each segment covers at least one message.
 */
function baselineCompartments(scenario: HistorianEvalScenario): MockHistorianCompartment[] {
    const messageCount = scenario.transcript.turns.length * 2;
    const count = Math.max(1, Math.min(scenario.gold.compartments.minCount, messageCount));
    const span = Math.floor(messageCount / count);
    const remainder = messageCount % count;
    const compartments: MockHistorianCompartment[] = [];
    let start = 1;
    for (let index = 0; index < count; index += 1) {
        const end = start + span + (index < remainder ? 1 : 0) - 1;
        compartments.push({
            start,
            end,
            title: `Baseline ${index + 1} of ${count} for ${scenario.id}`,
            body: "Synthetic baseline compartment for the mutation battery.",
        });
        start = end + 1;
    }
    return compartments;
}

/**
 * The battery scores chunks against the authored transcript plus trailing lookahead.
 * The scorer's default synthetic chunk ends at the authored end.
 * The runner marks a post-epilogue compartment within `HISTORIAN_BOUNDARY_HEALING_SLACK` of the chunk end as provisional.
 * The runner discards a provisional compartment and skips fact promotion for the pass.
 * A `gold.compartments.minCount` above one is unpromotable.
 * `compartment-count` measures only compartments over authored content.
 */
function batteryScoringOptions(scenario: HistorianEvalScenario): {
    chunkStartOrdinal: number;
    chunkEndOrdinal: number;
    authoredStartOrdinal: number;
    authoredEndOrdinal: number;
} {
    const messageCount = scenario.transcript.turns.length * 2;
    return {
        chunkStartOrdinal: 1,
        chunkEndOrdinal: messageCount + HISTORIAN_BOUNDARY_HEALING_SLACK + 1,
        authoredStartOrdinal: 1,
        authoredEndOrdinal: messageCount,
    };
}

function baselineOutput(scenario: HistorianEvalScenario, facts: MockHistorianFact[]): string {
    return buildMockHistorianOutput({ compartments: baselineCompartments(scenario), facts });
}

/**
 * The mutation changes only part of the predicate because `predicateMatches` accepts substrings.
 * A matching perturbation indicates that the matcher does not distinguish near misses.
 */
export function perturbPredicateValue(value: string): string {
    const digit = /[1-9]/.exec(value);
    if (digit) {
        const flipped = String(((Number(digit[0]) + 4) % 9) + 1);
        return value.slice(0, digit.index) + flipped + value.slice(digit.index + 1);
    }
    const words = value.split(" ");
    const longestIndex = words.reduce(
        (best, word, index) => (word.length > words[best].length ? index : best),
        0,
    );
    const word = words[longestIndex];
    const middle = Math.max(1, Math.floor(word.length / 2));
    words[longestIndex] = `${word.slice(0, middle)}-alt-${word.slice(middle)}`;
    return words.join(" ");
}

/**
 * A class that reaches a different stage fails, even if that stage rejects.
 */
export function checkMutationOutcome(
    mutationClass: Exclude<MutationClass, "probe-wrong-answer">,
    output: string,
    scenario: HistorianEvalScenario,
): { green: boolean; detail: string } {
    const expected = EXPECTED_OUTCOMES[mutationClass];
    const result = scoreRawOutput(output, scenario, batteryScoringOptions(scenario));
    if (expected.stage === "validation-rejected") {
        if (result.stage !== "validation-rejected") {
            return { green: false, detail: `expected stage validation-rejected but landed at ${result.stage}` };
        }
        return { green: true, detail: "validation-rejected as expected" };
    }
    if (expected.stage !== "scored") {
        throw new Error(`checkMutationOutcome cannot score stage ${expected.stage} for ${mutationClass}`);
    }
    const allowed = Array.isArray(expected.failReason) ? expected.failReason : [expected.failReason];
    if (result.stage !== "scored") {
        return { green: false, detail: `expected stage scored but landed at ${result.stage}` };
    }
    if (result.score.verdict !== "FAIL") {
        return { green: false, detail: `expected FAIL:${allowed.join("|")} but scored ${result.score.verdict}` };
    }
    if (!result.score.failReasons.some((reason) => allowed.includes(reason))) {
        return {
            green: false,
            detail: `expected FAIL reason in [${allowed.join(", ")}] but got [${result.score.failReasons.join(", ")}]`,
        };
    }
    return { green: true, detail: `FAIL:${result.score.failReasons.join(",")} as expected` };
}

function absentTargets(scenario: HistorianEvalScenario, families: readonly string[]): MockHistorianFact[] {
    return scenario.gold.expectedAbsent
        .filter((absent) => families.includes(absent.family))
        .map((absent) => ({
            category: scenario.gold.expectedClaims[0]?.category ?? V2_MEMORY_CATEGORIES[0],
            content: `Decision: ${absent.predicate.value}.`,
        }));
}

function runFalseAuthoritativeClass(
    scenario: HistorianEvalScenario,
    mutationClass: MutationClass,
    families: readonly string[],
): MutationResult {
    const forbidden = absentTargets(scenario, families);
    if (forbidden.length === 0) {
        return { mutationClass, applicable: false, green: true, detail: "no expected-absent predicate in class families" };
    }
    // Mutating only the first hard negative could leave later negatives untested.
    // A scenario may declare several hard negatives in one family, so the battery mutates each one.
    // Mutating only one hard negative could miss a detector that accepts later negatives.
    const gold = goldSatisfyingFacts(scenario);
    const checks = forbidden.map((fact, index) => ({
        index,
        ...checkMutationOutcome(
            mutationClass as Exclude<MutationClass, "probe-wrong-answer">,
            baselineOutput(scenario, [...gold, fact]),
            scenario,
        ),
    }));
    const failure = checks.find((check) => !check.green);
    if (failure !== undefined) {
        return {
            mutationClass,
            applicable: true,
            green: false,
            detail: `expected-absent target ${failure.index + 1} of ${checks.length}: ${failure.detail}`,
        };
    }
    return {
        mutationClass,
        applicable: true,
        green: true,
        detail: `all ${checks.length} expected-absent target(s) caught: ${checks[0].detail}`,
    };
}

/**
 *
 * Mutating every variant catches variant-specific regressions.
 * published artifact.
 */
function aggregateChecks(
    mutationClass: MutationClass,
    unit: string,
    checks: readonly { green: boolean; detail: string }[],
): MutationResult {
    if (checks.length === 0) {
        return { mutationClass, applicable: true, green: false, detail: `no ${unit} to mutate` };
    }
    const failure = checks.findIndex((check) => !check.green);
    if (failure !== -1) {
        return {
            mutationClass,
            applicable: true,
            green: false,
            detail: `${unit} ${failure + 1} of ${checks.length}: ${checks[failure].detail}`,
        };
    }
    return {
        mutationClass,
        applicable: true,
        green: true,
        detail: `all ${checks.length} ${unit}(s) caught: ${checks[0].detail}`,
    };
}

function runWrongCategory(scenario: HistorianEvalScenario): MutationResult {
    // Testing every non-matching category catches pair-specific validation gaps.
    //
    // `promoteSessionFactsDurable` drops categories outside `V2_MEMORY_CATEGORIES`; use that taxonomy to test miscategorization rather than dropped facts.
    const checks = scenario.gold.expectedClaims.flatMap((target, index) =>
        V2_MEMORY_CATEGORIES.filter((category) => category !== target.category).map((wrongCategory) => {
            const facts = goldSatisfyingFacts(scenario);
            facts[index] = { ...facts[index], category: wrongCategory };
            const check = checkMutationOutcome("wrong-category", baselineOutput(scenario, facts), scenario);
            return { ...check, detail: `${target.id} as ${wrongCategory}: ${check.detail}` };
        }),
    );
    return aggregateChecks("wrong-category", "category pairing", checks);
}

function runDroppedGoldFact(scenario: HistorianEvalScenario): MutationResult {
    const checks = scenario.gold.expectedClaims.map((_target, index) => {
        const facts = goldSatisfyingFacts(scenario).filter((_fact, factIndex) => factIndex !== index);
        return checkMutationOutcome("dropped-gold-fact", baselineOutput(scenario, facts), scenario);
    });
    return aggregateChecks("dropped-gold-fact", "expected claim", checks);
}

function runNearMiss(scenario: HistorianEvalScenario): MutationResult {
    const checks = scenario.gold.expectedClaims.map((target: ExpectedClaim, index) => {
        const facts = goldSatisfyingFacts(scenario);
        const perturbed = perturbPredicateValue(target.predicate.value);
        if (predicateMatches(target.predicate, `Recorded decision: ${perturbed}.`)) {
            return {
                green: false,
                detail: `perturbation "${perturbed}" still matches predicate "${target.predicate.value}" — matcher does not discriminate`,
            };
        }
        facts[index] = { ...facts[index], content: `Recorded decision: ${perturbed}.` };
        return checkMutationOutcome("near-miss-perturbation", baselineOutput(scenario, facts), scenario);
    });
    return aggregateChecks("near-miss-perturbation", "expected claim", checks);
}

function runStructuralOverlap(scenario: HistorianEvalScenario): MutationResult {
    const messageCount = scenario.transcript.turns.length * 2;
    const overlapping = buildMockHistorianOutput({
        compartments: [
            { start: 1, end: Math.max(2, messageCount - 2), title: "A", body: "a" },
            { start: Math.max(1, messageCount - 3), end: messageCount, title: "B", body: "b" },
        ],
        facts: goldSatisfyingFacts(scenario),
    });
    const check = checkMutationOutcome("structural-overlap", overlapping, scenario);
    return { mutationClass: "structural-overlap", applicable: true, ...check };
}

function runProbeWrongAnswer(scenario: HistorianEvalScenario): MutationResult {
    if (scenario.probes.length === 0) {
        // A scenario without probes leaves `probe-wrong-answer` unexercised.
        return { mutationClass: "probe-wrong-answer", applicable: false, green: false, detail: "scenario has no probes; probe class cannot be exercised" };
    }
    const expected = EXPECTED_OUTCOMES["probe-wrong-answer"];
    if (expected.stage !== "probe-comparison") {
        throw new Error(`probe-wrong-answer policy entry must stay at probe-comparison, got ${expected.stage}`);
    }
    // The mutation loop processes every probe so `claim-id` comparisons are exercised.
    const failures = scenario.probes.flatMap((probe) => {
        // The injected backing claim and its recorded locator satisfy probe availability checks.
        const backingId = probe.answerType === "claim-id" ? probe.expectedClaimRef : probe.sourceClaimRef;
        const backing = scenario.gold.expectedClaims.find((claim) => claim.id === backingId);
        const injectedClaims: InjectedClaimRecord[] =
            backing === undefined
                ? []
                : [
                      {
                          publicClaimId: `mem-${probe.id}`,
                          revisionLocator: `loc-${probe.id}`,
                          content: `Recorded decision: ${backing.predicate.value}.`,
                          category: backing.category,
                          revision: 1,
                      },
                  ];
        const exchange: ProbeExchange = {
            probeId: probe.id,
            answerRaw: WRONG_PROBE_ANSWER,
            reAsked: false,
            injectedRevisionLocators: injectedClaims.map((item) => item.revisionLocator),
            payloadText: null,
            finalRequestPayloadText: null,
            responseText: `<answer>${WRONG_PROBE_ANSWER}</answer>`,
            discardedResponseTexts: [],
        };
        const verdict = compareProbeAnswer({ probe, exchange, scenario, injectedClaims });
        return verdict.outcome === expected.outcome
            ? []
            : [`${probe.id} (${probe.answerType}): expected probe ${expected.outcome} but got ${verdict.outcome}`];
    });
    if (failures.length > 0) {
        return { mutationClass: "probe-wrong-answer", applicable: true, green: false, detail: failures.join("; ") };
    }
    const answerTypes = [...new Set(scenario.probes.map((probe) => probe.answerType))].sort();
    return {
        mutationClass: "probe-wrong-answer",
        applicable: true,
        green: true,
        detail: `probe fail as expected for all ${scenario.probes.length} probe(s), covering answer types ${answerTypes.join(", ")}`,
    };
}

/* */
function assertBaselineValidates(scenario: HistorianEvalScenario): MutationResult | null {
    const result = scoreRawOutput(
        baselineOutput(scenario, goldSatisfyingFacts(scenario)),
        scenario,
        batteryScoringOptions(scenario),
    );
    if (result.stage !== "scored") {
        return {
            mutationClass: "baseline-fixture",
            applicable: true,
            green: false,
            detail: `baseline fixture failed validation (${result.stage}); semantic classes cannot be exercised`,
        };
    }
    if (result.score.verdict !== "PASS") {
        return {
            mutationClass: "baseline-fixture",
            applicable: true,
            green: false,
            detail: `baseline fixture scored ${result.score.verdict} [${result.score.failReasons.join(",")}]; mutations would be red for the wrong reason`,
        };
    }
    return null;
}

export function runScenarioMutationBattery(scenario: HistorianEvalScenario): ScenarioMutationEvidence {
    const baselineFailure = assertBaselineValidates(scenario);
    const results: MutationResult[] =
        baselineFailure !== null
            ? [baselineFailure]
            : [
                  runFalseAuthoritativeClass(scenario, "speculation-promoted", [
                      "assistant-speculation",
                      "prompt-injection",
                      "conflicting-evidence",
                      "user-correction",
                      "current-vs-historical",
                  ]),
                  runFalseAuthoritativeClass(scenario, "rejected-proposal-active", [
                      "proposed-but-rejected",
                      "explored-never-accepted",
                  ]),
                  runWrongCategory(scenario),
                  runDroppedGoldFact(scenario),
                  runNearMiss(scenario),
                  runStructuralOverlap(scenario),
                  runProbeWrongAnswer(scenario),
              ];
    // Each scenario must exercise at least one false-authoritative class.
    const falseAuthoritative = results.filter(
        (result) =>
            result.mutationClass === "speculation-promoted" || result.mutationClass === "rejected-proposal-active",
    );
    if (falseAuthoritative.length > 0 && falseAuthoritative.every((result) => !result.applicable)) {
        results.push({
            mutationClass: "battery-coverage",
            applicable: true,
            green: false,
            detail: "no false-authoritative mutation applied: expected-absent families match no battery class",
        });
    }
    return {
        scenarioId: scenario.id,
        scenarioFingerprint: scenarioFingerprint(scenario),
        green: results.every((result) => result.green),
        results,
    };
}

export function runMutationBattery(scenarios: readonly HistorianEvalScenario[]): MutationEvidenceArtifact {
    const evidence = scenarios.map((scenario) => runScenarioMutationBattery(scenario));
    return {
        schema: MUTATION_EVIDENCE_SCHEMA,
        scenarios: evidence,
        green: evidence.every((entry) => entry.green),
    };
}

const RESULT_LABELS: readonly string[] = [...MUTATION_CLASSES, "baseline-fixture", "battery-coverage"];

/**
 * Only false-authoritative classes may be inapplicable in a green run.
 */
const ALWAYS_APPLICABLE_CLASSES: readonly MutationClass[] = MUTATION_CLASSES.filter(
    (mutationClass) =>
        mutationClass !== "speculation-promoted" && mutationClass !== "rejected-proposal-active",
);

function evidenceFail(code: string): never {
    throw new Error(`mutation evidence: ${code}`);
}

/**
 * A green artifact contains one result per mutation class and at least one applicable false-authoritative result.
 * Full result coverage rejects `{green: true}` shells and single-result stubs.
 */
export function parseMutationEvidence(raw: unknown): MutationEvidenceArtifact {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) evidenceFail("schema-invalid");
    const root = raw as Record<string, unknown>;
    if (root.schema !== MUTATION_EVIDENCE_SCHEMA) evidenceFail("schema-invalid");
    if (Object.keys(root).sort().join(",") !== "green,scenarios,schema") evidenceFail("fields-invalid");
    if (!Array.isArray(root.scenarios) || typeof root.green !== "boolean") evidenceFail("fields-invalid");
    // Artifact validation rejects duplicate `scenarioId` and `scenarioFingerprint` values.
    const seenIds = new Set<string>();
    const seenFingerprints = new Set<string>();
    const scenarios = root.scenarios.map((entryRaw, index) => {
        if (typeof entryRaw !== "object" || entryRaw === null) evidenceFail(`scenarios[${index}]: object-required`);
        const entry = entryRaw as Record<string, unknown>;
        if (Object.keys(entry).sort().join(",") !== "green,results,scenarioFingerprint,scenarioId") {
            evidenceFail(`scenarios[${index}]: fields-invalid`);
        }
        if (typeof entry.scenarioId !== "string" || entry.scenarioId.length === 0) {
            evidenceFail(`scenarios[${index}].scenarioId: string-invalid`);
        }
        if (typeof entry.scenarioFingerprint !== "string" || !HEX64_RE.test(entry.scenarioFingerprint)) {
            evidenceFail(`scenarios[${index}].scenarioFingerprint: fingerprint-invalid`);
        }
        if (seenIds.has(entry.scenarioId)) evidenceFail(`scenarios[${index}].scenarioId: duplicate`);
        seenIds.add(entry.scenarioId);
        if (seenFingerprints.has(entry.scenarioFingerprint)) {
            evidenceFail(`scenarios[${index}].scenarioFingerprint: duplicate`);
        }
        seenFingerprints.add(entry.scenarioFingerprint);
        if (typeof entry.green !== "boolean" || !Array.isArray(entry.results) || entry.results.length === 0) {
            evidenceFail(`scenarios[${index}]: fields-invalid`);
        }
        const results = entry.results.map((resultRaw, resultIndex) => {
            const label = `scenarios[${index}].results[${resultIndex}]`;
            if (typeof resultRaw !== "object" || resultRaw === null) evidenceFail(`${label}: object-required`);
            const result = resultRaw as Record<string, unknown>;
            if (Object.keys(result).sort().join(",") !== "applicable,detail,green,mutationClass") {
                evidenceFail(`${label}: fields-invalid`);
            }
            if (typeof result.mutationClass !== "string" || !RESULT_LABELS.includes(result.mutationClass)) {
                evidenceFail(`${label}.mutationClass: enum-invalid`);
            }
            if (typeof result.applicable !== "boolean" || typeof result.green !== "boolean") {
                evidenceFail(`${label}: fields-invalid`);
            }
            if (typeof result.detail !== "string") evidenceFail(`${label}.detail: string-invalid`);
            return result as unknown as MutationResult;
        });
        if (entry.green !== results.every((result) => result.green)) {
            evidenceFail(`scenarios[${index}].green: inconsistent-with-results`);
        }
        if (entry.green === true) {
            const labels = results.map((result) => result.mutationClass);
            const missing = MUTATION_CLASSES.filter((mutationClass) => !labels.includes(mutationClass));
            if (missing.length > 0 || labels.length !== MUTATION_CLASSES.length) {
                evidenceFail(`scenarios[${index}]: green-without-full-class-coverage`);
            }
            const falseAuthoritativeApplied = results.some(
                (result) =>
                    (result.mutationClass === "speculation-promoted" ||
                        result.mutationClass === "rejected-proposal-active") &&
                    result.applicable,
            );
            if (!falseAuthoritativeApplied) {
                evidenceFail(`scenarios[${index}]: green-without-applicable-false-authoritative-class`);
            }
            const skipped = ALWAYS_APPLICABLE_CLASSES.filter(
                (mutationClass) =>
                    !results.some((result) => result.mutationClass === mutationClass && result.applicable),
            );
            if (skipped.length > 0) {
                evidenceFail(`scenarios[${index}]: green-with-skipped-required-class-${skipped.join(",")}`);
            }
        }
        return entry as unknown as ScenarioMutationEvidence;
    });
    if (root.green !== scenarios.every((entry) => entry.green)) {
        evidenceFail("green: inconsistent-with-scenarios");
    }
    return { schema: MUTATION_EVIDENCE_SCHEMA, scenarios, green: root.green };
}
