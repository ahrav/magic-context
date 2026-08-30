import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { buildMockHistorianOutput } from "../mock-historian";
import { lintScenario, parseScenario, type HistorianEvalScenario } from "../historian-eval/contract";
import { scoreRawOutputWithInjectedClaims } from "../historian-eval/scorer";
import { validScenario } from "../historian-eval/test-support";
import { INJECTION_CANARY } from "./injection-canary";
import { metamorphicExitCode } from "./report";
import { buildScriptedOutput, runDeterministicMetamorphicEval } from "./runner";
import { TRANSFORMS, type Transform } from "./transforms";

const CORPUS_DIR = join(import.meta.dir, "../../historian-eval/dev");

function corpus(): HistorianEvalScenario[] {
    return readdirSync(CORPUS_DIR)
        .filter((file) => file.endsWith(".json"))
        .sort()
        .map((file) => parseScenario(JSON.parse(readFileSync(join(CORPUS_DIR, file), "utf8")), file));
}

function reorder(): Transform {
    return TRANSFORMS.find((transform) => transform.id === "reorder-independent-turns")!;
}

describe("deterministic metamorphic runner", () => {
    test("rejects an empty scenario input", () => {
        expect(() => runDeterministicMetamorphicEval([])).toThrow(
            "deterministic metamorphic eval needs at least one scenario",
        );
    });

    test("scores one real scenario through reorder end to end", () => {
        const report = runDeterministicMetamorphicEval([corpus()[0]!], { transforms: [reorder()] });

        expect(report.entries).toHaveLength(1);
        expect(report.entries[0]?.kind).toBe("scored");
        expect(report.coverage[0]?.applied).toBe(1);
        expect(metamorphicExitCode(report)).toBe(0);
    });

    test("runs the full corpus deterministically with all invariants green", () => {
        const scenarios = corpus();
        const first = runDeterministicMetamorphicEval(scenarios);
        const second = runDeterministicMetamorphicEval(scenarios);

        expect(metamorphicExitCode(first)).toBe(0);
        expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    });

    test("preserves distinct importances and rejects transcripts beyond their range", () => {
        const scenario = validScenario();
        const atLimit = {
            ...scenario,
            transcript: {
                ...scenario.transcript,
                turns: Array.from({ length: 100 }, () => ({ user: "context", assistant: "noted" })),
            },
        };
        const importances = [...buildScriptedOutput(atLimit, 0).matchAll(/ importance="(\d+)"/g)]
            .map((match) => match[1]);

        expect(importances).toHaveLength(100);
        expect(new Set(importances).size).toBe(100);

        atLimit.transcript.turns.push({ user: "context", assistant: "noted" });
        expect(() => buildScriptedOutput(atLimit, 0)).toThrow("supports at most 100 transcript turns");
    });

    test("reports a seeded accepted-claim drop as product brittleness", () => {
        const scenario = validScenario();
        const report = runDeterministicMetamorphicEval([scenario], {
            transforms: [reorder()],
            buildOutput: (candidate, seed) =>
                buildScriptedOutput(
                    candidate,
                    seed,
                    candidate.id.includes("-d-")
                        ? candidate.gold.expectedClaims.slice(1)
                        : candidate.gold.expectedClaims,
                ),
        });

        const entry = report.entries[0];
        expect(entry?.kind).toBe("scored");
        if (entry?.kind !== "scored") throw new Error("expected scored entry");
        expect(entry.invariants[0]?.holds).toBe(false);
        expect(entry.invariants[0]).toEqual(expect.objectContaining({
            changes: expect.arrayContaining([
                expect.objectContaining({ direction: "missing-from-derivative" }),
            ]),
        }));
        expect(metamorphicExitCode(report)).toBe(1);
    });

    test("reorder exposes an ordinal-sensitive producer without editing its output", () => {
        const scenario = validScenario();
        let seed = 0;
        let movedClaimId = "";
        for (; seed < 100; seed += 1) {
            const transformed = reorder().apply(scenario, seed);
            if (!transformed.applicable) continue;
            const moved = transformed.scenario.gold.expectedClaims.find((claim) => {
                const base = scenario.gold.expectedClaims.find((candidate) => candidate.id === claim.id)!;
                return claim.sourceTurnRange[0] !== base.sourceTurnRange[0];
            });
            if (moved) {
                movedClaimId = moved.id;
                break;
            }
        }
        expect(movedClaimId).not.toBe("");

        const report = runDeterministicMetamorphicEval([scenario], {
            transforms: [reorder()],
            seeds: [seed],
            buildOutput: (candidate, candidateSeed) => {
                const claims = candidate.gold.expectedClaims.filter((claim) => {
                    const base = scenario.gold.expectedClaims.find((expected) => expected.id === claim.id);
                    return base === undefined || claim.sourceTurnRange[0] === base.sourceTurnRange[0];
                });
                return buildScriptedOutput(candidate, candidateSeed, claims);
            },
        });

        const entry = report.entries[0];
        expect(entry?.kind).toBe("scored");
        if (entry?.kind !== "scored") throw new Error("expected scored entry");
        expect(entry.invariants[0]).toEqual(expect.objectContaining({ holds: false }));
        expect(metamorphicExitCode(report)).toBe(1);
    });

    test("classifies lint-red before derivative scoring", () => {
        const scenario = validScenario();
        let scoreCalls = 0;
        const broken: Transform = {
            id: "broken-remap",
            version: 1,
            alwaysApplicable: false,
            apply(base) {
                return {
                    applicable: true,
                    scenario: parseScenario({
                        ...base,
                        id: `${base.id}-d-broken-remap-v1-s0`,
                        gold: {
                            ...base.gold,
                            expectedClaims: base.gold.expectedClaims.map((claim, index) =>
                                index === 0
                                    ? { ...claim, predicate: { ...claim.predicate, value: "not authored here" } }
                                    : claim,
                            ),
                        },
                    }),
                    turnMap: base.transcript.turns.map((_, index) => index),
                };
            },
        };
        const report = runDeterministicMetamorphicEval([scenario], {
            transforms: [broken],
            seeds: [0],
            scoreOutput(rawOutput, candidate, options) {
                scoreCalls += 1;
                return scoreRawOutputWithInjectedClaims(rawOutput, candidate, options);
            },
        });

        const brokenResult = broken.apply(scenario, 0);
        if (!brokenResult.applicable) throw new Error("broken fixture must apply");
        expect(lintScenario(brokenResult.scenario)).not.toEqual([]);
        expect(report.entries[0]?.kind).toBe("lint-red");
        expect(scoreCalls).toBe(1);
        expect(metamorphicExitCode(report)).toBe(1);
    });

    test("rejects a transform that changes only derived labels", () => {
        const noOp: Transform = {
            id: "no-op-labels",
            version: 1,
            alwaysApplicable: true,
            apply(base) {
                return {
                    applicable: true,
                    scenario: parseScenario({
                        ...base,
                        id: `${base.id}-d-no-op-labels-v1-s0`,
                        title: `${base.title} (derived)`,
                    }),
                    turnMap: base.transcript.turns.map((_, index) => index),
                };
            },
        };

        const report = runDeterministicMetamorphicEval([validScenario()], {
            transforms: [noOp],
            seeds: [0],
        });

        expect(report.entries).toEqual([
            expect.objectContaining({
                kind: "lint-red",
                diagnostics: expect.arrayContaining(["derivative semantic fingerprint equals baseline"]),
            }),
        ]);
    });

    test.each([
        ["validation-rejected", () => "not historian output"],
        [
            "authored-evidence-unprocessed",
            (scenario: HistorianEvalScenario) => buildMockHistorianOutput({
                compartments: [{ start: 1, end: 2, title: "Prefix", body: "Prefix only." }],
                facts: scenario.gold.expectedClaims.map((claim) => ({
                    category: claim.category,
                    content: claim.predicate.value,
                })),
            }),
        ],
    ] as const)("classifies %s scripted output as stage-not-scored", (stage, derivativeOutput) => {
        const scenario = validScenario();
        const report = runDeterministicMetamorphicEval([scenario], {
            transforms: [reorder()],
            buildOutput: (candidate, seed) =>
                candidate.id.includes("-d-") ? derivativeOutput(candidate) : buildScriptedOutput(candidate, seed),
        });

        expect(report.entries[0]).toEqual(expect.objectContaining({
            kind: "stage-not-scored",
            role: "derivative",
            stage,
        }));
        expect(metamorphicExitCode(report)).toBe(1);
    });

    test("gives injection promotion exclusive exit code 2", () => {
        const scenario = validScenario();
        const report = runDeterministicMetamorphicEval([scenario], {
            transforms: [reorder()],
            buildOutput: (candidate, seed) => {
                if (!candidate.id.includes("-d-")) return buildScriptedOutput(candidate, seed);
                return buildMockHistorianOutput({
                    compartments: [{
                        start: 1,
                        end: candidate.transcript.turns.length * 2,
                        title: "Injection canary",
                        body: "Injection canary test.",
                    }],
                    facts: [
                        ...candidate.gold.expectedClaims.map((claim) => ({
                            category: claim.category,
                            content: claim.predicate.value,
                        })),
                        { category: "CONSTRAINTS", content: INJECTION_CANARY },
                    ],
                });
            },
        });

        expect(report.injectionCanaryHits).toEqual([
            expect.objectContaining({ role: "derivative", transformId: reorder().id }),
        ]);
        expect(metamorphicExitCode(report)).toBe(2);
    });

    test("records a baseline canary without derivative coordinates", () => {
        const scenario = validScenario();
        const report = runDeterministicMetamorphicEval([scenario], {
            transforms: [reorder()],
            buildOutput: (candidate, seed) => buildMockHistorianOutput({
                compartments: [{
                    start: 1,
                    end: candidate.transcript.turns.length * 2,
                    title: "Canary fixture",
                    body: "Canary fixture.",
                }],
                facts: [
                    ...candidate.gold.expectedClaims.map((claim) => ({
                        category: claim.category,
                        content: claim.predicate.value,
                    })),
                    ...(!candidate.id.includes("-d-")
                        ? [{ category: "CONSTRAINTS" as const, content: INJECTION_CANARY }]
                        : []),
                ],
            }),
        });

        expect(report.injectionCanaryHits).toEqual([{
            scenarioId: scenario.id,
            role: "baseline",
            transformId: null,
            transformVersion: null,
            seed: null,
        }]);
        expect(metamorphicExitCode(report)).toBe(2);
    });

    test("fails coverage when every transform is inapplicable", () => {
        const never: Transform = {
            id: "never",
            version: 1,
            alwaysApplicable: false,
            apply: () => ({ applicable: false, reason: "fixture has no target" }),
        };
        const report = runDeterministicMetamorphicEval([validScenario()], {
            transforms: [never],
            seeds: [0],
        });

        expect(report.coverage[0]).toEqual(expect.objectContaining({
            applied: 0,
            inapplicable: [expect.objectContaining({ transformId: "never" })],
            violations: ["no transforms applied"],
        }));
        expect(metamorphicExitCode(report)).toBe(1);
    });

    test("records scorer exceptions as errors, not empty reads", () => {
        const report = runDeterministicMetamorphicEval([validScenario()], {
            transforms: [reorder()],
            scoreOutput(rawOutput, scenario, options) {
                if (scenario.id.includes("-d-")) throw new Error("injected scorer failure");
                return scoreRawOutputWithInjectedClaims(rawOutput, scenario, options);
            },
        });

        expect(report.entries[0]).toEqual(expect.objectContaining({
            kind: "error",
            error: "injected scorer failure",
        }));
        expect(report.injectionCanaryHits).toEqual([]);
        expect(metamorphicExitCode(report)).toBe(1);
    });
});
