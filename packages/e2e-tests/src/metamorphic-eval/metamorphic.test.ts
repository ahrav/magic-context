import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildMockHistorianOutput } from "../mock-historian";
import { lintScenario, parseScenario, type HistorianEvalScenario } from "../historian-eval/contract";
import type { SystemVersionTuple } from "../historian-eval/runner";
import { scoreRawOutputWithInjectedClaims } from "../historian-eval/scorer";
import { validScenario } from "../historian-eval/test-support";
import { INJECTION_CANARY } from "./injection-canary";
import {
    compareLivePair,
    runLiveMetamorphicEval,
    type LiveMetamorphicOptions,
    type LiveObservation,
    type LiveRole,
} from "./live";
import { buildMetamorphicReport, metamorphicExitCode, type MetamorphicReport } from "./report";
import { buildScriptedOutput, runDeterministicMetamorphicEval } from "./runner";
import { TRANSFORMS, type Transform } from "./transforms";
import {
    partialReportPath,
    prepareDeterministicOutputPaths,
    prepareLiveOutputPaths,
    runLiveAndWriteReport,
    stagingReportPath,
} from "../../scripts/run-metamorphic-eval";

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

function liveObservation(claims: LiveObservation["injectedClaims"]): LiveObservation {
    return {
        expectationMatches: {},
        injectedClaims: claims,
        score: {
            scenarioId: "scenario",
            verdict: "PASS",
            failReasons: [],
            errorReason: null,
            errorDetail: null,
            precision: 1,
            recall: 1,
            expectedClaimsMatched: 0,
            expectedClaimsTotal: 0,
            visibleClaimsMatched: 0,
            visibleClaimsTotal: claims.length,
            falseAuthoritativeMatches: [],
            structuralFindings: [],
            probeVerdicts: [],
            system: null,
            source: "raw-output",
        },
    };
}

function injectedClaim(content: string) {
    return {
        publicClaimId: "clm_01h00000000000000000000000",
        revisionLocator: `clm_01h00000000000000000000000@1:${"a".repeat(64)}`,
        content,
        category: "ARCHITECTURE",
        revision: 1,
    } as const;
}

function systemTuple(): SystemVersionTuple {
    return {
        repoCommitSha: "a".repeat(40),
        bunVersion: "1.4.0",
        opencodeVersion: "test",
        historianModelId: "test/historian",
        probeModelId: "test/probe",
        parserImpl: "ts",
        chunkTokenBudget: null,
    };
}

function liveMode(): LiveMetamorphicOptions["mode"] {
    return {
        kind: "live",
        apiKey: "test",
        historianModel: "test/historian",
        probeModel: { providerID: "test", modelID: "probe" },
    };
}

/** Pairs only score when both roles report one system tuple, so a shared tuple is what lets these fixtures reach the invariant comparison. commentlint: allow(JUDGE) */
function pairedObservation(
    claims: LiveObservation["injectedClaims"] = [],
    overrides: Partial<LiveObservation["score"]> = {},
): LiveObservation {
    const base = liveObservation(claims);
    return { ...base, score: { ...base.score, system: systemTuple(), ...overrides } };
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

describe("live metamorphic runner", () => {
    test("fails injection equality when an unscored claim changes", () => {
        const verdict = compareLivePair(
            liveObservation([injectedClaim("keep the cache local")]),
            liveObservation([injectedClaim("keep the cache local"), injectedClaim("use redis")]),
        )[0];

        expect(verdict).toEqual(expect.objectContaining({
            invariant: "injection-set-equality",
            holds: false,
            changes: [expect.objectContaining({ direction: "added-in-derivative" })],
        }));
    });

    test("marks every progress report incomplete", async () => {
        const progress: ReturnType<typeof runDeterministicMetamorphicEval>[] = [];
        const observation = liveObservation([]);
        const report = await runLiveMetamorphicEval([validScenario()], {
            mode: {
                kind: "live",
                apiKey: "test",
                historianModel: "test/historian",
                probeModel: { providerID: "test", modelID: "probe" },
            },
            artifactRoot: "/tmp/metamorphic-live-test",
            opencodeVersion: "test",
            transforms: [reorder()],
            seeds: [0],
            admit: () => [],
            execute: async () => observation,
            onProgress: (partial) => progress.push(partial),
        });

        expect(progress.length).toBeGreaterThan(0);
        expect(progress[0]?.tierInvalidReason?.kind).toBe("incomplete");
        expect(progress.every((partial) => metamorphicExitCode(partial) === 1)).toBe(true);
        expect(metamorphicExitCode(report)).toBe(1);
    });

    test("rejects live outputs that overlap the scenario corpus", () => {
        const root = mkdtempSync(join(tmpdir(), "metamorphic-paths-"));
        try {
            const corpus = join(root, "corpus");
            mkdirSync(corpus);
            expect(() => prepareLiveOutputPaths(join(corpus, "report.json"), corpus)).toThrow(
                "must not overlap the scenario corpus",
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("clears stale regular reports before live admission", () => {
        const root = mkdtempSync(join(tmpdir(), "metamorphic-stale-"));
        try {
            const corpus = join(root, "corpus");
            const report = join(root, "output", "report.json");
            mkdirSync(corpus);
            mkdirSync(join(root, "output"));
            writeFileSync(report, "stale");
            writeFileSync(partialReportPath(report), "stale partial");

            prepareLiveOutputPaths(report, corpus);

            expect(existsSync(report)).toBe(false);
            expect(existsSync(partialReportPath(report))).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("does not remove an unowned partial directory", async () => {
        const root = mkdtempSync(join(tmpdir(), "metamorphic-partial-"));
        try {
            const reportPath = join(root, "report.json");
            const partialPath = partialReportPath(reportPath);
            mkdirSync(partialPath);
            const never: Transform = {
                id: "never",
                version: 1,
                alwaysApplicable: false,
                apply: () => ({ applicable: false, reason: "fixture" }),
            };

            await runLiveAndWriteReport(reportPath, [validScenario()], {
                mode: {
                    kind: "live",
                    apiKey: "test",
                    historianModel: "test/historian",
                    probeModel: { providerID: "test", modelID: "probe" },
                },
                artifactRoot: join(root, "artifacts"),
                opencodeVersion: "test",
                transforms: [never],
                seeds: [0],
            });

            expect(existsSync(partialPath)).toBe(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("rejects a corpus reached through a symlinked output path", () => {
        const root = mkdtempSync(join(tmpdir(), "metamorphic-symlink-"));
        try {
            const corpusDirectory = join(root, "corpus");
            mkdirSync(corpusDirectory);
            const alias = join(root, "corpus-alias");
            symlinkSync(corpusDirectory, alias);

            expect(() => prepareLiveOutputPaths(join(alias, "scenario.json"), corpusDirectory)).toThrow(
                "must not overlap the scenario corpus",
            );
            expect(() => prepareLiveOutputPaths(join(corpusDirectory, "scenario.json"), alias)).toThrow(
                "must not overlap the scenario corpus",
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("rejects report, staging, and partial paths that are not regular files", () => {
        const root = mkdtempSync(join(tmpdir(), "metamorphic-shape-"));
        try {
            const corpusDirectory = join(root, "corpus");
            mkdirSync(corpusDirectory);
            const occupied = join(root, "as-directory", "report.json");
            mkdirSync(occupied, { recursive: true });
            expect(() => prepareLiveOutputPaths(occupied, corpusDirectory)).toThrow(
                "is not a regular file",
            );

            const staged = join(root, "as-staging", "report.json");
            mkdirSync(join(root, "as-staging"));
            mkdirSync(stagingReportPath(staged));
            expect(() => prepareLiveOutputPaths(staged, corpusDirectory)).toThrow("is not a regular file");

            const linked = join(root, "as-symlink", "report.json");
            mkdirSync(join(root, "as-symlink"));
            symlinkSync(join(root, "elsewhere.json"), stagingReportPath(linked));
            expect(() => prepareLiveOutputPaths(linked, corpusDirectory)).toThrow("is a symlink");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("rejects a report destination inside the artifact namespace", () => {
        const root = mkdtempSync(join(tmpdir(), "metamorphic-namespace-"));
        try {
            const corpusDirectory = join(root, "corpus");
            mkdirSync(corpusDirectory);
            expect(() =>
                prepareLiveOutputPaths(join(root, "metamorphic-eval-artifacts"), corpusDirectory),
            ).toThrow("must stay outside the artifact namespace");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("validates deterministic report destinations against the corpus", () => {
        const root = mkdtempSync(join(tmpdir(), "metamorphic-deterministic-paths-"));
        try {
            const corpusDirectory = join(root, "corpus");
            mkdirSync(corpusDirectory);
            expect(() =>
                prepareDeterministicOutputPaths(join(corpusDirectory, "report.json"), corpusDirectory),
            ).toThrow("must not overlap the scenario corpus");

            const report = join(root, "output", "report.json");
            mkdirSync(join(root, "output"));
            writeFileSync(report, "stale");
            prepareDeterministicOutputPaths(report, corpusDirectory);
            expect(existsSync(report)).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("never writes a report through a symlinked staging path", async () => {
        const root = mkdtempSync(join(tmpdir(), "metamorphic-staging-"));
        try {
            const reportPath = join(root, "report.json");
            const victim = join(root, "victim.json");
            writeFileSync(victim, "protected");
            symlinkSync(victim, stagingReportPath(reportPath));
            const never: Transform = {
                id: "never",
                version: 1,
                alwaysApplicable: false,
                apply: () => ({ applicable: false, reason: "fixture" }),
            };

            await runLiveAndWriteReport(reportPath, [validScenario()], {
                mode: liveMode(),
                artifactRoot: join(root, "artifacts"),
                opencodeVersion: "test",
                transforms: [never],
                seeds: [0],
            });

            expect(readFileSync(victim, "utf8")).toBe("protected");
            expect(lstatSync(reportPath).isFile()).toBe(true);
            expect(JSON.parse(readFileSync(reportPath, "utf8")).schema).toBe("metamorphic-eval-report/v2");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe("live metamorphic control tier", () => {
    async function runWithExecutor(
        execute: (role: LiveRole) => LiveObservation,
        overrides: Partial<LiveMetamorphicOptions> = {},
    ): Promise<{ report: MetamorphicReport; roles: LiveRole[] }> {
        const roles: LiveRole[] = [];
        const report = await runLiveMetamorphicEval([validScenario()], {
            mode: liveMode(),
            artifactRoot: "/tmp/metamorphic-control-tier",
            opencodeVersion: "test",
            transforms: [reorder()],
            seeds: [0],
            admit: () => [],
            execute: async (_scenario, role) => {
                roles.push(role);
                return execute(role);
            },
            ...overrides,
        });
        return { report, roles };
    }

    test("treats two ERROR controls as tier-invalid instead of agreement", async () => {
        const { report, roles } = await runWithExecutor(() =>
            pairedObservation([], {
                verdict: "ERROR",
                errorReason: "historian-transport",
                errorDetail: "provider unreachable",
                precision: null,
                recall: null,
            }),
        );

        expect(report.tierInvalidReason?.kind).toBe("control-error");
        expect(roles).toEqual(["control-a", "control-b"]);
        expect(metamorphicExitCode(report)).toBe(1);
    });

    test("publishes a control-a canary hit through the progress callback", async () => {
        const progress: MetamorphicReport[] = [];
        const { report } = await runWithExecutor(
            () => pairedObservation([injectedClaim(INJECTION_CANARY)]),
            { onProgress: (partial) => progress.push(partial) },
        );

        expect(report.injectionCanaryHits).toHaveLength(1);
        expect(progress.at(-1)?.injectionCanaryHits).toEqual(report.injectionCanaryHits);
        expect(metamorphicExitCode(report)).toBe(2);
    });

    test("leaves transform coordinates off a baseline canary hit", async () => {
        const { report } = await runWithExecutor((role) =>
            role === "baseline"
                ? pairedObservation([injectedClaim(INJECTION_CANARY)])
                : pairedObservation(),
        );

        expect(report.injectionCanaryHits).toEqual([
            {
                scenarioId: validScenario().id,
                role: "baseline",
                transformId: null,
                transformVersion: null,
                seed: null,
            },
        ]);
    });

    test("runs one baseline per scenario across transforms", async () => {
        const roles: LiveRole[] = [];
        const report = await runLiveMetamorphicEval([validScenario()], {
            mode: liveMode(),
            artifactRoot: "/tmp/metamorphic-baseline-reuse",
            opencodeVersion: "test",
            transforms: [...TRANSFORMS],
            seeds: [0],
            admit: () => [],
            execute: async (_scenario, role) => {
                roles.push(role);
                return pairedObservation();
            },
        });

        const derivatives = roles.filter((role) => role === "derivative").length;
        expect(derivatives).toBeGreaterThan(1);
        expect(roles.filter((role) => role === "baseline")).toHaveLength(1);
        expect(report.entries.filter((entry) => entry.kind === "scored")).toHaveLength(derivatives + 1);
    });

    test("carries the precomputed system tuple into partial reports", async () => {
        const progress: MetamorphicReport[] = [];
        const system = systemTuple();
        const { report } = await runWithExecutor(() => pairedObservation(), {
            system,
            onProgress: (partial) => progress.push(partial),
        });

        expect(progress.length).toBeGreaterThan(0);
        expect(progress[0]?.system).toEqual(system);
        expect(report.system).toEqual(system);
    });

    test("publishes the deadline outcome and next role through the progress callback", async () => {
        const progress: MetamorphicReport[] = [];
        let clock = 0;
        const { report } = await runWithExecutor(() => pairedObservation(), {
            deadlineAtMs: 10,
            nowMs: () => (clock += 6),
            onProgress: (partial) => progress.push(partial),
        });

        expect(report.tierInvalidReason).toEqual({ kind: "deadline-exhausted", nextRole: "control-b" });
        expect(progress.at(-1)?.tierInvalidReason).toEqual(report.tierInvalidReason);
        expect(metamorphicExitCode(report)).toBe(1);
    });

    test("rejects report destinations that reserve another run's auxiliary names", () => {
        const root = mkdtempSync(join(tmpdir(), "metamorphic-reserved-"));
        try {
            const corpusDirectory = join(root, "corpus");
            mkdirSync(corpusDirectory);
            // `foo.json` derives and unlinks both of these, so accepting either as a
            // canonical destination lets one invocation delete another's report.
            for (const reserved of ["foo.partial.json", "foo.json.tmp"]) {
                expect(() => prepareLiveOutputPaths(join(root, reserved), corpusDirectory)).toThrow(
                    "a name this runner derives and deletes",
                );
                expect(() => prepareDeterministicOutputPaths(join(root, reserved), corpusDirectory)).toThrow(
                    "a name this runner derives and deletes",
                );
            }
            expect(() => prepareLiveOutputPaths(join(root, "foo.json"), corpusDirectory)).not.toThrow();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("rejects outputs that resolve onto a symlinked corpus scenario", () => {
        const root = mkdtempSync(join(tmpdir(), "metamorphic-corpus-link-"));
        try {
            const corpusDirectory = join(root, "corpus");
            mkdirSync(corpusDirectory);
            const outsideTarget = join(root, "shared", "scenario.json");
            mkdirSync(join(root, "shared"));
            writeFileSync(outsideTarget, "{}");
            symlinkSync(outsideTarget, join(corpusDirectory, "linked.json"));

            expect(() => prepareLiveOutputPaths(outsideTarget, corpusDirectory)).toThrow(
                "must not resolve onto a scenario file",
            );
            expect(() => prepareDeterministicOutputPaths(outsideTarget, corpusDirectory)).toThrow(
                "must not resolve onto a scenario file",
            );
            expect(readFileSync(outsideTarget, "utf8")).toBe("{}");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("accepts a live rerun once the artifact namespace exists", () => {
        const root = mkdtempSync(join(tmpdir(), "metamorphic-rerun-"));
        try {
            const corpusDirectory = join(root, "corpus");
            mkdirSync(corpusDirectory);
            const report = join(root, "out", "report.json");
            mkdirSync(join(root, "out"));

            const first = prepareLiveOutputPaths(report, corpusDirectory);
            /** A control run creates `first.artifactNamespace`; later runs must tolerate it. commentlint: allow(JUDGE) */
            mkdirSync(first.artifactNamespace);
            expect(() => prepareLiveOutputPaths(report, corpusDirectory)).not.toThrow();
            expect(() => prepareLiveOutputPaths(join(root, "out", "sibling.json"), corpusDirectory)).not.toThrow();

            mkdirSync(join(root, "out2"));
            writeFileSync(join(root, "out2", "metamorphic-eval-artifacts"), "not a directory");
            expect(() => prepareLiveOutputPaths(join(root, "out2", "report.json"), corpusDirectory)).toThrow(
                "artifact namespace exists and is not a directory",
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("derives distinct partials for extensionless and JSON reports", () => {
        expect(partialReportPath("/x/foo")).not.toBe(partialReportPath("/x/foo.json"));
        expect(partialReportPath("/x/foo.json")).toBe("/x/foo.json.partial.json");
        expect(stagingReportPath("/x/foo")).not.toBe(stagingReportPath("/x/foo.json"));
    });

    test("counts only admitted derivatives as applied coverage", async () => {
        /** An identity derivative lints red on its fingerprint, which is the `rejected` branch that must not count as applied. commentlint: allow(JUDGE) */
        const identity: Transform = {
            id: "identity-fixture",
            version: 1,
            alwaysApplicable: true,
            apply: (scenario) => ({
                applicable: true,
                scenario,
                turnMap: scenario.transcript.turns.map((_, index) => index),
            }),
        };
        const report = await runLiveMetamorphicEval([validScenario()], {
            mode: liveMode(),
            artifactRoot: "/tmp/metamorphic-applied-coverage",
            opencodeVersion: "test",
            transforms: [identity],
            seeds: [0],
            execute: async () => pairedObservation(),
        });

        expect(report.entries).toHaveLength(1);
        expect(report.entries[0]?.kind).toBe("lint-red");
        expect(report.coverage[0]?.applied).toBe(0);
        expect(report.coverage[0]?.violations).toContain("no transforms applied");
    });

    test("reports a thrown control failure as a control error, not an incomplete run", async () => {
        for (const failing of ["control-a", "control-b"] as const) {
            const { report } = await runWithExecutor((role) => {
                if (role === failing) throw new Error(`${failing} artifact setup failed`);
                return pairedObservation();
            });

            expect(report.tierInvalidReason).toEqual({
                kind: "control-error",
                controlAErrorReason: failing === "control-a" ? "control-a artifact setup failed" : null,
                controlBErrorReason: failing === "control-b" ? "control-b artifact setup failed" : null,
            });
        }
    });
});
