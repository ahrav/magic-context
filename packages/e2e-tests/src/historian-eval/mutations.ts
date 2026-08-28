/**
 * Historian structural eval lane — invalid-state mutation battery (R13/KTD5).
 *
 * Admission gate for the frozen release: for every scenario, crafted wrong
 * historian outputs must score red AT THE EXPECTED STAGE, per mutation
 * class. The battery fails on stage mismatch, not only on a PASS — a
 * semantic mutation dying in validation would silently stop exercising the
 * scorer, so semantic-class fixtures are required to be valid per
 * `validateHistorianOutput` by construction (asserted per scenario, so a
 * validator change surfaces as a battery error instead of a silent stage
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
import type { ProbeExchange } from "./runner";
import { compareProbeAnswer, scoreRawOutput, type FailReason } from "./scorer";

export const MUTATION_EVIDENCE_SCHEMA = "historian-eval-mutation-evidence/v1";

/** The deliberately wrong answer every probe mutation sends. */
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

/** Expected stage and verdict per class (plan U6 step 1). */
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
    /** Absent when the class does not apply to this scenario (recorded as skipped). */
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

/** Gold-satisfying synthetic facts: one per expected claim. */
function goldSatisfyingFacts(scenario: HistorianEvalScenario): MockHistorianFact[] {
    return scenario.gold.expectedClaims.map((claim) => ({
        category: claim.category,
        content: `Recorded decision: ${claim.predicate.value}.`,
    }));
}

/**
 * Baseline compartments: `gold.compartments.minCount` contiguous,
 * non-overlapping segments covering the authored transcript. A fixed single
 * compartment would trip the scorer's `compartment-count` structural finding
 * for every scenario declaring a minimum above one, so `assertBaselineValidates`
 * would report a baseline FAIL — and promotion would reject the scenario —
 * before any mutation ran. The count is clamped to the message count because a
 * segment must cover at least one message.
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
 * Chunk the battery scores against: the authored transcript plus trailing
 * lookahead. The scorer's default synthetic chunk ends exactly at the authored
 * end, which no real run ever does — the runner always appends post-epilogue
 * padding — and that difference is load-bearing. Production treats a last
 * compartment within `HISTORIAN_BOUNDARY_HEALING_SLACK` of the chunk end as
 * provisional: it discards that compartment AND skips fact promotion for the
 * whole pass. Scored against a chunk ending at the authored end, therefore, any
 * multi-compartment output loses every fact and reports recall 0 for a purely
 * structural reason, which is what made scenarios declaring a compartment
 * minimum above one unpromotable. The authored span stays explicit so
 * `compartment-count` still measures only compartments over authored content.
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
 * Perturb the matched span of one gold predicate: flip the first digit, or
 * split the longest word when no digit exists (a substring matcher shrugs
 * off surrounding negation, so the value itself must change). Either way
 * the predicate must stop matching — asserted by the caller, since a
 * perturbation the matcher still accepts means the matcher no longer
 * discriminates (the near-miss class exists to prove matchers stay sharp).
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
 * Score one crafted output against the class's EXPECTED stage and verdict
 * from `EXPECTED_OUTCOMES` — the single policy table the battery consults.
 * A class landing at a DIFFERENT stage is red even when that stage is a
 * rejection: stage migration silently stops exercising the scorer.
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
    // Every declared hard negative in the class, not just the first. A scenario
    // may declare several in one family, and mutating only one leaves the rest
    // unexercised: a detector that catches the first while accepting a later one
    // would still emit green admission evidence, so the release would ship a
    // false-authoritative check nothing ever demonstrated.
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
 * Aggregate one positive-claim mutation applied to EVERY expected claim.
 *
 * A scenario may declare several, and mutating only the first leaves the rest
 * unexercised: a scorer regression that stops enforcing the second or third claim
 * still trips on the first, so admission evidence stays green while the release
 * ships claims whose enforcement nothing ever demonstrated. The count is recorded
 * in the detail so a regression back to first-claim-only is visible in the
 * published artifact.
 */
function aggregatePerClaim(
    mutationClass: MutationClass,
    checks: readonly { green: boolean; detail: string }[],
): MutationResult {
    const failure = checks.findIndex((check) => !check.green);
    if (failure !== -1) {
        return {
            mutationClass,
            applicable: true,
            green: false,
            detail: `expected claim ${failure + 1} of ${checks.length}: ${checks[failure].detail}`,
        };
    }
    return {
        mutationClass,
        applicable: true,
        green: true,
        detail: `all ${checks.length} expected claim(s) caught: ${checks[0].detail}`,
    };
}

function runWrongCategory(scenario: HistorianEvalScenario): MutationResult {
    const checks = scenario.gold.expectedClaims.map((target, index) => {
        const facts = goldSatisfyingFacts(scenario);
        // Derived from the production taxonomy, never a hardcoded name:
        // `promoteSessionFactsDurable` silently DROPS facts whose category is
        // outside `V2_MEMORY_CATEGORIES`, so a drifted literal would land at the
        // same scored/recall outcome as dropped-gold-fact and this class would
        // silently stop testing miscategorization.
        const wrongCategory = V2_MEMORY_CATEGORIES.find((category) => category !== target.category);
        if (wrongCategory === undefined) {
            throw new Error("wrong-category mutation requires at least two promotable categories");
        }
        facts[index] = { ...facts[index], category: wrongCategory };
        return checkMutationOutcome("wrong-category", baselineOutput(scenario, facts), scenario);
    });
    return aggregatePerClaim("wrong-category", checks);
}

function runDroppedGoldFact(scenario: HistorianEvalScenario): MutationResult {
    const checks = scenario.gold.expectedClaims.map((_target, index) => {
        const facts = goldSatisfyingFacts(scenario).filter((_fact, factIndex) => factIndex !== index);
        return checkMutationOutcome("dropped-gold-fact", baselineOutput(scenario, facts), scenario);
    });
    return aggregatePerClaim("dropped-gold-fact", checks);
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
    return aggregatePerClaim("near-miss-perturbation", checks);
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
        // A probe-less scenario would freeze with this class never
        // exercised; the freeze lint forbids it and the battery fails red
        // as defense in depth.
        return { mutationClass: "probe-wrong-answer", applicable: false, green: false, detail: "scenario has no probes; probe class cannot be exercised" };
    }
    // No injected claims: the gold claim was never promoted, so a miss is a
    // probe FAIL, not a trimmed ERROR (KTD6). The expected outcome comes
    // from the policy table so this class stays table-driven like the rest
    // of the battery.
    const expected = EXPECTED_OUTCOMES["probe-wrong-answer"];
    if (expected.stage !== "probe-comparison") {
        throw new Error(`probe-wrong-answer policy entry must stay at probe-comparison, got ${expected.stage}`);
    }
    // EVERY probe, not just the first: `compareProbeAnswer` branches on
    // `answerType`, and the corpus places `claim-id` probes after an `exact`
    // or `multiple-choice` one. Mutating only `probes[0]` would leave the
    // claim-id comparison path unexercised, so a regression accepting a wrong
    // claim identifier would still pass the admission gate.
    const failures = scenario.probes.flatMap((probe) => {
        const exchange: ProbeExchange = {
            probeId: probe.id,
            answerRaw: WRONG_PROBE_ANSWER,
            reAsked: false,
            injectedRevisionLocators: [],
            payloadText: null,
            // Synthetic exchange: there is no captured request, the answer came
            // straight from the marker reply, and nothing was re-asked.
            finalRequestPayloadText: null,
            responseText: `<answer>${WRONG_PROBE_ANSWER}</answer>`,
            discardedResponseTexts: [],
        };
        const verdict = compareProbeAnswer({ probe, exchange, scenario, injectedClaims: [] });
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

/** Construction invariant: semantic-class fixtures must be validator-clean. */
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
    // A scenario must trip at least one false-authoritative class: every
    // scenario declares at least one hard-negative family, so both classes
    // being inapplicable means the family/absent mapping drifted.
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
 * The two false-authoritative classes are the only ones a green run may skip
 * (a scenario need not declare an expected-absent predicate in both class
 * family sets). Every other class is unconditionally applied, so a green
 * artifact marking one `applicable: false` was not produced by the battery.
 */
const ALWAYS_APPLICABLE_CLASSES: readonly MutationClass[] = MUTATION_CLASSES.filter(
    (mutationClass) =>
        mutationClass !== "speculation-promoted" && mutationClass !== "rejected-proposal-active",
);

function evidenceFail(code: string): never {
    throw new Error(`mutation evidence: ${code}`);
}

/**
 * Strict, fail-closed evidence parser: an artifact claiming green must be
 * internally consistent (aggregate flags derived from per-result flags,
 * every result labeled with a known class) AND carry the exact result set
 * a green battery run emits — one result per mutation class with at least
 * one applicable false-authoritative class — so a hand-written
 * `{green: true}` shell (or a single-result stub) cannot slip a scenario
 * past the admission gate.
 */
export function parseMutationEvidence(raw: unknown): MutationEvidenceArtifact {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) evidenceFail("schema-invalid");
    const root = raw as Record<string, unknown>;
    if (root.schema !== MUTATION_EVIDENCE_SCHEMA) evidenceFail("schema-invalid");
    if (Object.keys(root).sort().join(",") !== "green,scenarios,schema") evidenceFail("fields-invalid");
    if (!Array.isArray(root.scenarios) || typeof root.green !== "boolean") evidenceFail("fields-invalid");
    // One entry per scenario, keyed BOTH ways. `checkMutationEvidence` indexes
    // entries by `scenarioFingerprint` into a Map, where a later duplicate wins,
    // so a red entry followed by a green one for the same scenario reports green
    // to the admission gate. The aggregate flags stay self-consistent under that
    // forgery — they are derived from every entry, including the masked red one —
    // so uniqueness is the only place it can be caught.
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
        // Green class coverage: a green battery run always emits exactly one
        // result per mutation class (the baseline-fixture and
        // battery-coverage rows only appear on red runs), and at least one
        // false-authoritative class applied. Anything else claiming green is
        // a forged or truncated artifact.
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
            // Coverage alone still admits an artifact that lists every class
            // but marks the unconditional ones skipped, which would claim
            // green while demonstrating only the false-authoritative pair.
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
