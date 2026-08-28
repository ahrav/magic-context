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
import { buildHistorianPayload } from "./payload";
import { goldFacts, goldenRawOutput, validScenario } from "./test-support";

function overlappingPayload(): string {
    const scenario = validScenario();
    const messageCount = scenario.transcript.turns.length * 2;
    return buildHistorianPayload({
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
        // The reference scenario declares proposed-but-rejected, so the
        // rejected-proposal class must actually apply (not be skipped).
        expect(byClass.get("rejected-proposal-active")!.applicable).toBe(true);
        expect(byClass.get("speculation-promoted")!.applicable).toBe(false);
    });

    test("a class landing at a DIFFERENT stage is red, in both directions", () => {
        const scenario = validScenario();
        // A semantic class (expected stage: scored) whose crafted output
        // dies in validation instead — the silent stage migration the
        // battery exists to catch.
        const semanticAtValidation = checkMutationOutcome("dropped-gold-fact", overlappingPayload(), scenario);
        expect(semanticAtValidation.green).toBe(false);
        expect(semanticAtValidation.detail).toContain("landed at validation-rejected");

        // A structural class (expected stage: validation-rejected) whose
        // output validates and scores instead.
        const structuralAtScored = checkMutationOutcome("structural-overlap", goldenRawOutput(), scenario);
        expect(structuralAtScored.green).toBe(false);
        expect(structuralAtScored.detail).toContain("expected stage validation-rejected");

        // A scored class whose output PASSES (mutation not detected at all).
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
        // Nearness anchor: the perturbation edits inside the value rather
        // than replacing it; everything but the inserted marker survives.
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
        // Internally consistent but truncated: one skipped-class row is the
        // cheapest shape a forger could hand-write.
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
        // Full class coverage AND an applied false-authoritative class, but
        // one always-applied class flipped to skipped: the shape that claims
        // green while demonstrating only part of the battery.
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

    test("probe mutation exercises every probe, including the claim-id comparison path", () => {
        const scenario = validScenario();
        expect(scenario.probes.map((probe) => probe.answerType)).toEqual(["exact", "multiple-choice", "claim-id"]);
        const evidence = runScenarioMutationBattery(scenario);
        const probe = evidence.results.find((result) => result.mutationClass === "probe-wrong-answer");
        expect(probe?.green).toBe(true);
        expect(probe?.detail).toContain(`all ${scenario.probes.length} probe(s)`);
        // claim-id only ever appears after another probe in the corpus, so a
        // probes[0]-only battery would never reach this comparison branch.
        expect(probe?.detail).toContain("claim-id");
    });

    test("a LATER probe that accepts the wrong answer turns the probe class red", () => {
        const scenario = validScenario();
        // Gold answer equal to the battery's wrong answer: the comparison
        // PASSES, so the mutation is not detected. Placed last, this is
        // invisible to a battery that only mutates probes[0].
        const colliding = {
            id: "probe-collides",
            question: "Which marker does the battery send?",
            answerType: "exact" as const,
            goldAnswer: "historian-eval-mutation-wrong-answer",
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
        // A fixed single-compartment baseline would trip the scorer's
        // compartment-count structural finding, so every mutation would be
        // red for the wrong reason and promotion would reject the scenario.
        expect(evidence.results.some((result) => result.mutationClass === "baseline-fixture")).toBe(false);
        expect(evidence.green).toBe(true);
    });
});
