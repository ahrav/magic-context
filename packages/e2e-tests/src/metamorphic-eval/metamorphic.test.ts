import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { buildMockHistorianOutput } from "../mock-historian";
import { lintScenario, parseScenario, type HistorianEvalScenario } from "../historian-eval/contract";
import { scoreRawOutputWithInjectedClaims } from "../historian-eval/scorer";
import { validScenario } from "../historian-eval/test-support";
import { INJECTION_CANARY } from "./injection-canary";
import { buildMetamorphicReport, metamorphicExitCode } from "./report";
import { buildScriptedOutput, runDeterministicMetamorphicEval, DETERMINISTIC_SEEDS } from "./runner";
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

function importancesOf(output: string): number[] {
    return [...output.matchAll(/ importance="(\d+)"/g)].map((match) => Number(match[1]));
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

    test("assigns distinct importances up to the value range, then repeats them", () => {
        const scenario = validScenario();
        const atRange = {
            ...scenario,
            transcript: {
                ...scenario.transcript,
                turns: Array.from({ length: 100 }, () => ({ user: "context", assistant: "noted" })),
            },
        };
        const atRangeImportances = importancesOf(buildScriptedOutput(atRange, 0));

        expect(atRangeImportances).toHaveLength(100);
        expect(new Set(atRangeImportances).size).toBe(100);

        const beyondRange = {
            ...atRange,
            gold: { ...atRange.gold, compartments: { minCount: 150 } },
        };
        const beyondRangeImportances = importancesOf(buildScriptedOutput(beyondRange, 0));

        expect(beyondRangeImportances).toHaveLength(150);
        expect(new Set(beyondRangeImportances).size).toBe(100);
        expect(Math.min(...beyondRangeImportances)).toBeGreaterThanOrEqual(1);
        expect(Math.max(...beyondRangeImportances)).toBeLessThanOrEqual(100);
    });

    test("scores a scenario whose lint-legal compartment count exceeds the importance range", () => {
        const scenario = validScenario();
        const wide = {
            ...scenario,
            transcript: {
                ...scenario.transcript,
                turns: Array.from({ length: 60 }, () => ({ user: "context", assistant: "noted" })),
            },
            gold: { ...scenario.gold, compartments: { minCount: 110 } },
        };

        expect(lintScenario(wide).filter((d) => d.includes("compartments.minCount"))).toEqual([]);
        expect(importancesOf(buildScriptedOutput(wide, 0))).toHaveLength(110);
    });

    test("builds at least the declared compartment minimum", () => {
        const scenario = validScenario();
        scenario.gold.compartments.minCount = 6;

        const output = buildScriptedOutput(scenario, 0);

        expect([...output.matchAll(/<compartment\b/g)]).toHaveLength(6);
    });

    test("normalizes predicate text before building scripted facts", () => {
        const scenario = validScenario();
        scenario.gold.expectedClaims[0]!.predicate.value = "  use the in-process\nLRU cache  ";

        expect(buildScriptedOutput(scenario, 0)).toContain("use the in-process lru cache");
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
            preservesTurnText: true,
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
        expect(report.coverage[0]).toEqual(expect.objectContaining({
            applied: 0,
            violations: ["no transforms applied"],
        }));
        expect(metamorphicExitCode(report)).toBe(1);
    });

    test("rejects a derivative whose declared turn map disagrees with its gold", () => {
        const transform: Transform = {
            ...reorder(),
            id: "wrong-map",
            apply(base, seed) {
                const result = reorder().apply(base, seed);
                if (!result.applicable) return result;
                return { ...result, turnMap: base.transcript.turns.map((_, index) => index) };
            },
        };

        const report = runDeterministicMetamorphicEval([validScenario()], {
            transforms: [transform],
            seeds: [0],
        });

        expect(report.entries[0]).toEqual(expect.objectContaining({
            kind: "lint-red",
            diagnostics: expect.arrayContaining(["derivative gold does not match its declared turn map"]),
        }));
    });

    test("matches each derivative with the baseline built from the same seed", () => {
        const scenario = validScenario();
        const report = runDeterministicMetamorphicEval([scenario], {
            transforms: [reorder()],
            seeds: [0, 1],
            buildOutput(candidate, seed) {
                return buildScriptedOutput(
                    candidate,
                    seed,
                    seed === 0 ? candidate.gold.expectedClaims : candidate.gold.expectedClaims.slice(1),
                );
            },
        });

        expect(report.entries).toHaveLength(2);
        expect(report.entries.every((entry) =>
            entry.kind === "scored" && entry.invariants[0]?.holds === true
        )).toBe(true);
    });

    test("emits score-level invariants for scored pairs", () => {
        const report = runDeterministicMetamorphicEval([validScenario()], {
            transforms: [reorder()],
            seeds: [0],
        });
        const entry = report.entries[0];
        if (entry?.kind !== "scored") throw new Error("expected scored entry");

        expect(entry.invariants.map((invariant) => invariant.invariant)).toEqual([
            "injection-set-equality",
            "expected-absent-empty",
            "expectation-predicate-equality",
            "false-authoritative-set-equality",
            "scenario-verdict-equality",
        ]);
    });

    test("fails an empty report instead of passing vacuously", () => {
        expect(metamorphicExitCode(buildMetamorphicReport({
            entries: [],
            coverage: [],
            injectionCanaryHits: [],
        }))).toBe(1);
    });

    test("preserves canary claims from authored-evidence-unprocessed output", () => {
        const scenario = validScenario();
        const output = buildMockHistorianOutput({
            compartments: [{ start: 1, end: 2, title: "Prefix", body: "Prefix only." }],
            facts: [{ category: "CONSTRAINTS", content: INJECTION_CANARY }],
        });
        const report = runDeterministicMetamorphicEval([scenario], {
            transforms: [reorder()],
            buildOutput: (candidate, seed) =>
                candidate.id.includes("-d-") ? output : buildScriptedOutput(candidate, seed),
        });

        expect(report.entries[0]).toEqual(expect.objectContaining({
            kind: "stage-not-scored",
            role: "derivative",
            stage: "authored-evidence-unprocessed",
        }));
        expect(report.injectionCanaryHits).toEqual([
            expect.objectContaining({ role: "derivative" }),
        ]);
        expect(metamorphicExitCode(report)).toBe(2);
    });

    test("rejects a transform that changes only derived labels", () => {
        const noOp: Transform = {
            id: "no-op-labels",
            version: 1,
            alwaysApplicable: true,
            preservesTurnText: true,
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
            seed: DETERMINISTIC_SEEDS[0],
        }]);
        expect(metamorphicExitCode(report)).toBe(2);
    });

    test("names the offending seed when one seeded baseline promotes the canary", () => {
        const scenario = validScenario();
        const seeds = [11, 22, 33] as const;
        const offending = 22;
        const report = runDeterministicMetamorphicEval([scenario], {
            transforms: [reorder()],
            seeds,
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
                    ...(!candidate.id.includes("-d-") && seed === offending
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
            seed: offending,
        }]);
        expect(metamorphicExitCode(report)).toBe(2);
    });

    test("rejects a text-preserving transform whose turn map misstates provenance", () => {
        const scenario = validScenario();
        const liar: Transform = {
            id: "liar-map",
            version: 1,
            alwaysApplicable: true,
            preservesTurnText: true,
            apply(base) {
                const turns = [...base.transcript.turns];
                const order = turns.map((_, index) => index);
                [order[0], order[1]] = [order[1]!, order[0]!];
                return {
                    applicable: true,
                    scenario: parseScenario({
                        ...base,
                        id: `${base.id}-d-liar-map-v1-s0`,
                        transcript: {
                            ...base.transcript,
                            turns: order.map((index) => ({ ...turns[index]! })),
                        },
                    }),
                    turnMap: turns.map((_, index) => index),
                };
            },
        };
        const report = runDeterministicMetamorphicEval([scenario], {
            transforms: [liar],
            seeds: [0],
        });

        expect(report.entries).toEqual([
            expect.objectContaining({
                kind: "lint-red",
                diagnostics: expect.arrayContaining([
                    expect.stringContaining("turn map does not match the transcript"),
                ]),
            }),
        ]);
    });

    test("rejects a transform that mutates authored fields outside the transcript", () => {
        const scenario = validScenario();
        const probeDrift: Transform = {
            id: "probe-drift",
            version: 1,
            alwaysApplicable: true,
            preservesTurnText: true,
            apply(base) {
                return {
                    applicable: true,
                    scenario: parseScenario({
                        ...base,
                        id: `${base.id}-d-probe-drift-v1-s0`,
                        probes: base.probes.map((probe, index) =>
                            index === 0 ? { ...probe, question: `${probe.question} (drifted)` } : probe,
                        ),
                    }),
                    turnMap: base.transcript.turns.map((_, index) => index),
                };
            },
        };
        const report = runDeterministicMetamorphicEval([scenario], {
            transforms: [probeDrift],
            seeds: [0],
        });

        expect(report.entries).toEqual([
            expect.objectContaining({
                kind: "lint-red",
                diagnostics: expect.arrayContaining([
                    expect.stringContaining("authored fields outside the transcript"),
                ]),
            }),
        ]);
    });

    test("fails coverage when every transform is inapplicable", () => {
        const never: Transform = {
            id: "never",
            version: 1,
            alwaysApplicable: false,
            preservesTurnText: true,
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
