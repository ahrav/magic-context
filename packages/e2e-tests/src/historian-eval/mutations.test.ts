import { describe, expect, test } from "bun:test";
import {
    EXPECTED_OUTCOMES,
    MUTATION_CLASSES,
    MUTATION_EVIDENCE_SCHEMA,
    checkMutationOutcome,
    parseMutationEvidence,
    perturbPredicateValue,
    runMutationBattery,
    runScenarioMutationBattery,
} from "./mutations";
import { normalizeContent, predicateMatches } from "./contract";
import { buildMockHistorianOutput } from "../mock-historian";
import { goldFacts, goldenRawOutput, validScenario } from "./test-support";

function overlappingPayload(): string {
    const scenario = validScenario();
    const messageCount = scenario.transcript.turns.length * 2;
    return buildMockHistorianOutput({
        compartments: [
            { start: 1, end: messageCount - 2, title: "A", body: "a" },
            { start: messageCount - 3, end: messageCount, title: "B", body: "b" },
        ],
        facts: goldFacts(),
    });
}

describe("mutation battery (R13/KTD5)", () => {
    test("every mutation class on the reference scenario lands at its expected stage and verdict", () => {
        const evidence = runScenarioMutationBattery(validScenario());
        expect(evidence.green).toBe(true);
        const byClass = new Map(evidence.results.map((result) => [result.mutationClass, result]));
        for (const mutationClass of MUTATION_CLASSES) {
            const result = byClass.get(mutationClass);
            expect(result).toBeDefined();
            expect(result!.green).toBe(true);
        }
        // The rejected-proposal class must apply because the reference scenario declares proposed-but-rejected.
        expect(byClass.get("rejected-proposal-active")!.applicable).toBe(true);
        expect(byClass.get("speculation-promoted")!.applicable).toBe(false);
    });

    test("a class landing at a DIFFERENT stage is red, in both directions", () => {
        const scenario = validScenario();
        // A semantic mutation must reach scoring; validation rejection is a stage migration.
        // The battery rejects mutations that land at a stage other than their expected stage.
        const semanticAtValidation = checkMutationOutcome("dropped-gold-fact", overlappingPayload(), scenario);
        expect(semanticAtValidation.green).toBe(false);
        expect(semanticAtValidation.detail).toContain("landed at validation-rejected");

        // A structural mutation must be rejected during validation; scoring is a stage migration.
        const structuralAtScored = checkMutationOutcome("structural-overlap", goldenRawOutput(), scenario);
        expect(structuralAtScored.green).toBe(false);
        expect(structuralAtScored.detail).toContain("expected stage validation-rejected");

        // The battery rejects a scored class whose output passes because it did not detect the mutation.
        const passingMutation = checkMutationOutcome("dropped-gold-fact", goldenRawOutput(), scenario);
        expect(passingMutation.green).toBe(false);
        expect(passingMutation.detail).toContain("scored PASS");
    });

    test("a probe-less scenario fails the battery (probe class cannot be exercised)", () => {
        const scenario = validScenario();
        const evidence = runScenarioMutationBattery({ ...scenario, probes: [] });
        expect(evidence.green).toBe(false);
        const probeResult = evidence.results.find((result) => result.mutationClass === "probe-wrong-answer");
        expect(probeResult?.applicable).toBe(false);
        expect(probeResult?.green).toBe(false);
    });

    test("a scenario whose expected-absent families match no false-authoritative class fails the battery", () => {
        const scenario = validScenario();
        const stripped = {
            ...scenario,
            gold: { ...scenario.gold, expectedAbsent: [] },
        };
        const evidence = runScenarioMutationBattery(stripped);
        expect(evidence.green).toBe(false);
        const coverage = evidence.results.find((result) => result.mutationClass === "battery-coverage");
        expect(coverage?.detail).toContain("no false-authoritative mutation applied");
    });

    test("near-miss perturbation stops the predicate from matching while staying near the value", () => {
        const digitPerturbed = perturbPredicateValue("4096");
        expect(predicateMatches({ kind: "normalized-substring", value: "4096" }, digitPerturbed)).toBe(false);
        expect(digitPerturbed).toHaveLength(4);

        const wordPerturbed = perturbPredicateValue("in-process lru cache");
        expect(
            predicateMatches({ kind: "normalized-substring", value: "in-process lru cache" }, wordPerturbed),
        ).toBe(false);
        expect(normalizeContent(wordPerturbed).replace("-alt-", "")).toBe(normalizeContent("in-process lru cache"));

        // Single-word predicates must not survive via substring containment.
        const single = perturbPredicateValue("vitest");
        expect(predicateMatches({ kind: "normalized-substring", value: "vitest" }, single)).toBe(false);
    });

    test("expected outcomes cover every class", () => {
        for (const mutationClass of MUTATION_CLASSES) {
            expect(EXPECTED_OUTCOMES[mutationClass]).toBeDefined();
        }
    });

    test("corpus-level battery aggregates per-scenario evidence with fingerprints", () => {
        const scenario = validScenario();
        const artifact = runMutationBattery([scenario]);
        expect(artifact.green).toBe(true);
        expect(artifact.scenarios).toHaveLength(1);
        expect(artifact.scenarios[0].scenarioFingerprint).toMatch(/^[0-9a-f]{64}$/);
    });

    test("evidence parser round-trips a real battery artifact", () => {
        const artifact = runMutationBattery([validScenario()]);
        const parsed = parseMutationEvidence(JSON.parse(JSON.stringify(artifact)));
        expect(parsed.green).toBe(true);
        expect(parsed.scenarios).toHaveLength(1);
    });

    test("evidence parser rejects a green entry without full class coverage (forged shell)", () => {
        // One skipped-class row is internally consistent but omits the remaining mutation classes.
        // One skipped-class row is internally consistent but omits the remaining mutation classes.
        const forged = {
            schema: MUTATION_EVIDENCE_SCHEMA,
            green: true,
            scenarios: [
                {
                    scenarioId: "hse-forged",
                    scenarioFingerprint: "0".repeat(64),
                    green: true,
                    results: [
                        {
                            mutationClass: "speculation-promoted",
                            applicable: false,
                            green: true,
                            detail: "",
                        },
                    ],
                },
            ],
        };
        expect(() => parseMutationEvidence(forged)).toThrow(/green-without-full-class-coverage/);
    });

    test("evidence parser rejects a green entry where no false-authoritative class applied", () => {
        const results = MUTATION_CLASSES.map((mutationClass) => ({
            mutationClass,
            applicable: false,
            green: true,
            detail: "",
        }));
        const forged = {
            schema: MUTATION_EVIDENCE_SCHEMA,
            green: true,
            scenarios: [
                {
                    scenarioId: "hse-forged",
                    scenarioFingerprint: "0".repeat(64),
                    green: true,
                    results,
                },
            ],
        };
        expect(() => parseMutationEvidence(forged)).toThrow(
            /green-without-applicable-false-authoritative-class/,
        );
    });

    test("evidence parser rejects a green entry that marks an unconditionally applied class skipped", () => {
        // A report can claim green while an always-applied mutation class is skipped.
        const results = MUTATION_CLASSES.map((mutationClass) => ({
            mutationClass,
            applicable: mutationClass !== "wrong-category",
            green: true,
            detail: "",
        }));
        const forged = {
            schema: MUTATION_EVIDENCE_SCHEMA,
            green: true,
            scenarios: [
                {
                    scenarioId: "hse-forged",
                    scenarioFingerprint: "0".repeat(64),
                    green: true,
                    results,
                },
            ],
        };
        expect(() => parseMutationEvidence(forged)).toThrow(/green-with-skipped-required-class-wrong-category/);
    });

    test("evidence parser rejects duplicate scenario entries that would mask a red result", () => {
        // Duplicate entries for one scenario can mask a red result because `checkMutationEvidence` keeps the later entry by `scenarioFingerprint`.
        // Duplicate scenario fingerprints can make `checkMutationEvidence` read a scenario as green while artifact-level `green` remains false.
        // Only scenario-fingerprint uniqueness detects the duplicate's masking effect.
        const artifact = runMutationBattery([validScenario()]);
        const green = JSON.parse(JSON.stringify(artifact.scenarios[0])) as Record<string, unknown>;
        const red = JSON.parse(JSON.stringify(green)) as {
            green: boolean;
            results: Array<{ green: boolean }>;
        };
        red.green = false;
        red.results[0].green = false;
        const forged = {
            schema: MUTATION_EVIDENCE_SCHEMA,
            green: false,
            scenarios: [red, green],
        };
        expect(() => parseMutationEvidence(forged)).toThrow(/scenarioId: duplicate/);

        // A distinct entry ID does not prevent masking when duplicate entries share a `scenarioFingerprint`.
        const renamed = { ...red, scenarioId: "hse-other" };
        expect(() => parseMutationEvidence({ ...forged, scenarios: [renamed, green] })).toThrow(
            /scenarioFingerprint: duplicate/,
        );
    });

    test("probe mutation exercises every probe, including the claim-id comparison path", () => {
        const scenario = validScenario();
        expect(scenario.probes.map((probe) => probe.answerType)).toEqual(["exact", "multiple-choice", "claim-id"]);
        const evidence = runScenarioMutationBattery(scenario);
        const probe = evidence.results.find((result) => result.mutationClass === "probe-wrong-answer");
        expect(probe?.green).toBe(true);
        expect(probe?.detail).toContain(`all ${scenario.probes.length} probe(s)`);
        // A battery that mutates only `probes[0]` never compares `claim-id`.
        expect(probe?.detail).toContain("claim-id");
    });

    test("a LATER probe that accepts the wrong answer turns the probe class red", () => {
        const scenario = validScenario();
        // When the gold answer equals the battery's wrong answer, the comparison passes and does not detect the mutation.
        // Placing that probe last makes the undetected mutation invisible to a battery that mutates only `probes[0]`.
        const colliding = {
            id: "probe-collides",
            question: "Which marker does the battery send?",
            answerType: "exact" as const,
            goldAnswer: "historian-eval-mutation-wrong-answer",
            sourceClaimRef: "exp-cache-capacity",
        };
        const evidence = runScenarioMutationBattery({ ...scenario, probes: [...scenario.probes, colliding] });
        const probe = evidence.results.find((result) => result.mutationClass === "probe-wrong-answer");
        expect(probe?.green).toBe(false);
        expect(probe?.detail).toContain("probe-collides");
        expect(evidence.green).toBe(false);
    });

    test("baseline satisfies gold.compartments.minCount above one (higher minimums stay promotable)", () => {
        const scenario = validScenario();
        const raised = { ...scenario, gold: { ...scenario.gold, compartments: { minCount: 3 } } };
        const evidence = runScenarioMutationBattery(raised);
        // A fixed single-compartment baseline would trigger the scorer's compartment-count structural finding, making every mutation red for the wrong reason and causing promotion to reject the scenario.
        expect(evidence.results.some((result) => result.mutationClass === "baseline-fixture")).toBe(false);
        expect(evidence.green).toBe(true);
    });
});
