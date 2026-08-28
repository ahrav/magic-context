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

import {
    HEX64_RE,
    predicateMatches,
    scenarioFingerprint,
    type ExpectedClaim,
    type HistorianEvalScenario,
} from "./contract";
import { buildHistorianPayload, type PayloadFact } from "./payload";
import type { ProbeExchange } from "./runner";
import { compareProbeAnswer, scoreRawOutput, type FailReason } from "./scorer";

export const MUTATION_EVIDENCE_SCHEMA = "historian-eval-mutation-evidence/v1";

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
function goldSatisfyingFacts(scenario: HistorianEvalScenario): PayloadFact[] {
    return scenario.gold.expectedClaims.map((claim) => ({
        category: claim.category,
        content: `Recorded decision: ${claim.predicate.value}.`,
    }));
}

function baselineOutput(scenario: HistorianEvalScenario, facts: PayloadFact[]): string {
    const messageCount = scenario.transcript.turns.length * 2;
    return buildHistorianPayload({
        compartments: [
            {
                start: 1,
                end: messageCount,
                title: `Baseline for ${scenario.id}`,
                body: "Synthetic baseline compartment for the mutation battery.",
            },
        ],
        facts,
    });
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
    const result = scoreRawOutput(output, scenario);
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

function absentTargets(scenario: HistorianEvalScenario, families: readonly string[]): PayloadFact[] {
    return scenario.gold.expectedAbsent
        .filter((absent) => families.includes(absent.family))
        .map((absent) => ({
            category: scenario.gold.expectedClaims[0]?.category ?? "ARCHITECTURE",
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
    const output = baselineOutput(scenario, [...goldSatisfyingFacts(scenario), forbidden[0]]);
    const check = checkMutationOutcome(mutationClass as Exclude<MutationClass, "probe-wrong-answer">, output, scenario);
    return { mutationClass, applicable: true, ...check };
}

function runWrongCategory(scenario: HistorianEvalScenario): MutationResult {
    const facts = goldSatisfyingFacts(scenario);
    const target = scenario.gold.expectedClaims[0];
    const wrongCategory = ["NAMING", "PROJECT_RULES", "ARCHITECTURE"].find(
        (category) => category !== target.category,
    ) as string;
    facts[0] = { ...facts[0], category: wrongCategory };
    const check = checkMutationOutcome("wrong-category", baselineOutput(scenario, facts), scenario);
    return { mutationClass: "wrong-category", applicable: true, ...check };
}

function runDroppedGoldFact(scenario: HistorianEvalScenario): MutationResult {
    const facts = goldSatisfyingFacts(scenario).slice(1);
    const check = checkMutationOutcome("dropped-gold-fact", baselineOutput(scenario, facts), scenario);
    return { mutationClass: "dropped-gold-fact", applicable: true, ...check };
}

function runNearMiss(scenario: HistorianEvalScenario): MutationResult {
    const facts = goldSatisfyingFacts(scenario);
    const target: ExpectedClaim = scenario.gold.expectedClaims[0];
    const perturbed = perturbPredicateValue(target.predicate.value);
    if (predicateMatches(target.predicate, `Recorded decision: ${perturbed}.`)) {
        return {
            mutationClass: "near-miss-perturbation",
            applicable: true,
            green: false,
            detail: `perturbation "${perturbed}" still matches predicate "${target.predicate.value}" — matcher does not discriminate`,
        };
    }
    facts[0] = { ...facts[0], content: `Recorded decision: ${perturbed}.` };
    const check = checkMutationOutcome("near-miss-perturbation", baselineOutput(scenario, facts), scenario);
    return { mutationClass: "near-miss-perturbation", applicable: true, ...check };
}

function runStructuralOverlap(scenario: HistorianEvalScenario): MutationResult {
    const messageCount = scenario.transcript.turns.length * 2;
    const overlapping = buildHistorianPayload({
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
    const probe = scenario.probes[0];
    if (!probe) {
        // A probe-less scenario would freeze with this class never
        // exercised; the freeze lint forbids it and the battery fails red
        // as defense in depth.
        return { mutationClass: "probe-wrong-answer", applicable: false, green: false, detail: "scenario has no probes; probe class cannot be exercised" };
    }
    const exchange: ProbeExchange = {
        probeId: probe.id,
        answerRaw: "historian-eval-mutation-wrong-answer",
        reAsked: false,
        injectedRevisionLocators: [],
        payloadText: null,
    };
    // No injected claims: the gold claim was never promoted, so a miss is a
    // probe FAIL, not a trimmed ERROR (KTD6).
    const verdict = compareProbeAnswer({ probe, exchange, scenario, injectedClaims: [] });
    const expected = EXPECTED_OUTCOMES["probe-wrong-answer"];
    if (expected.stage !== "probe-comparison") {
        throw new Error(`probe-wrong-answer policy declares stage ${expected.stage}; only probe-comparison is scoreable here`);
    }
    if (verdict.outcome !== expected.outcome) {
        return {
            mutationClass: "probe-wrong-answer",
            applicable: true,
            green: false,
            detail: `expected probe ${expected.outcome} but got ${verdict.outcome}`,
        };
    }
    return { mutationClass: "probe-wrong-answer", applicable: true, green: true, detail: `probe ${expected.outcome} as expected` };
}

/** Construction invariant: semantic-class fixtures must be validator-clean. */
function assertBaselineValidates(scenario: HistorianEvalScenario): MutationResult | null {
    const result = scoreRawOutput(baselineOutput(scenario, goldSatisfyingFacts(scenario)), scenario);
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

function evidenceFail(code: string): never {
    throw new Error(`mutation evidence: ${code}`);
}

/**
 * A scenario entry claiming green must carry exactly one result per mutation
 * class. `runScenarioMutationBattery` only emits a short result list when it
 * fails closed early — `baseline-fixture` on a validator-dirty baseline, or an
 * extra `battery-coverage` red — so a green entry has no legitimate way to be
 * missing a class. Without this check, a hand-edited artifact whose results
 * are a single green `battery-coverage` entry is internally consistent and
 * `loadRelease` accepts evidence that never exercised the required classes.
 */
function checkRequiredClassCoverage(entry: ScenarioMutationEvidence, label: string): void {
    if (!entry.green) return;
    const seen = new Map<string, number>();
    for (const result of entry.results) {
        seen.set(result.mutationClass, (seen.get(result.mutationClass) ?? 0) + 1);
    }
    for (const mutationClass of MUTATION_CLASSES) {
        const count = seen.get(mutationClass) ?? 0;
        if (count === 0) evidenceFail(`${label}.results: missing-class-${mutationClass}`);
        if (count > 1) evidenceFail(`${label}.results: duplicate-class-${mutationClass}`);
    }
    for (const mutationClass of seen.keys()) {
        if (!(MUTATION_CLASSES as readonly string[]).includes(mutationClass)) {
            evidenceFail(`${label}.results: unexpected-class-${mutationClass}-in-green-entry`);
        }
    }
    // These five classes are unconditional in `runScenarioMutationBattery`, so
    // a green entry that marks any of them inapplicable never exercised it.
    // Without this, a forged entry can carry all seven labels, flip these to
    // `applicable: false`, leave one false-authoritative class applicable, and
    // still satisfy the label-and-count check.
    const alwaysApplicable = [
        "wrong-category",
        "dropped-gold-fact",
        "near-miss-perturbation",
        "structural-overlap",
        "probe-wrong-answer",
    ] as const;
    for (const mutationClass of alwaysApplicable) {
        const result = entry.results.find((candidate) => candidate.mutationClass === mutationClass);
        if (result !== undefined && !result.applicable) {
            evidenceFail(`${label}.results: inapplicable-class-${mutationClass}`);
        }
    }
    // The same invariant the battery asserts when it emits `battery-coverage`:
    // every scenario declares a hard-negative family, so a green entry in
    // which neither false-authoritative class was applicable means the
    // family-to-class mapping drifted and nothing actually ran.
    const falseAuthoritative = entry.results.filter(
        (result) =>
            result.mutationClass === "speculation-promoted" || result.mutationClass === "rejected-proposal-active",
    );
    if (falseAuthoritative.every((result) => !result.applicable)) {
        evidenceFail(`${label}.results: no-applicable-false-authoritative-class`);
    }
}

/**
 * Strict, fail-closed evidence parser: an artifact claiming green must be
 * internally consistent (aggregate flags derived from per-result flags,
 * every result labeled with a known class), so a hand-written
 * `{green: true}` shell cannot slip a scenario past the admission gate.
 */
export function parseMutationEvidence(raw: unknown): MutationEvidenceArtifact {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) evidenceFail("schema-invalid");
    const root = raw as Record<string, unknown>;
    if (root.schema !== MUTATION_EVIDENCE_SCHEMA) evidenceFail("schema-invalid");
    if (Object.keys(root).sort().join(",") !== "green,scenarios,schema") evidenceFail("fields-invalid");
    if (!Array.isArray(root.scenarios) || typeof root.green !== "boolean") evidenceFail("fields-invalid");
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
        const parsed = entry as unknown as ScenarioMutationEvidence;
        checkRequiredClassCoverage(parsed, `scenarios[${index}]`);
        return parsed;
    });
    if (root.green !== scenarios.every((entry) => entry.green)) {
        evidenceFail("green: inconsistent-with-scenarios");
    }
    return { schema: MUTATION_EVIDENCE_SCHEMA, scenarios, green: root.green };
}
