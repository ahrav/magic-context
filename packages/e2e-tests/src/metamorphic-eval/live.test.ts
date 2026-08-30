import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    parseArgs,
    loadCorpus,
    logReport,
    prepareLivePreamble,
    runLiveAndWriteReport,
    selectInputs,
} from "../../scripts/run-metamorphic-eval";
import type { InjectedClaimRecord } from "../historian-eval/claim-read";
import {
    expectationGoldMatchPredicates,
    type ScenarioScore,
} from "../historian-eval/scorer";
import { validScenario } from "../historian-eval/test-support";
import {
    compareLivePair,
    liveArtifactDir,
    liveDerivativeAdmissionDiagnostics,
    runLiveMetamorphicEval,
    type LiveObservation,
} from "./live";
import { INJECTION_CANARY } from "./injection-canary";
import { buildMetamorphicReport, metamorphicExitCode } from "./report";
import { TRANSFORMS } from "./transforms";

function score(overrides: Partial<ScenarioScore> = {}): ScenarioScore {
    return {
        scenarioId: "hse-proto-cache-decision",
        verdict: "PASS",
        failReasons: [],
        errorReason: null,
        errorDetail: null,
        precision: 1,
        recall: 1,
        expectedClaimsMatched: 2,
        expectedClaimsTotal: 2,
        visibleClaimsMatched: 2,
        visibleClaimsTotal: 2,
        falseAuthoritativeMatches: [],
        structuralFindings: [],
        probeVerdicts: [],
        system: {
            repoCommitSha: "a".repeat(40),
            bunVersion: "1.4.0",
            opencodeVersion: "1.0.0",
            historianModelId: "anthropic/historian",
            probeModelId: "anthropic/probe",
            parserImpl: "ts",
            chunkTokenBudget: 4096,
        },
        source: "run-record",
        ...overrides,
    };
}

function observation(overrides: Partial<LiveObservation> = {}): LiveObservation {
    return {
        score: score(),
        expectationMatches: { "exp-cache-capacity": true, "exp-lru-cache": true },
        injectedClaims: [],
        ...overrides,
    };
}

describe("live metamorphic comparator", () => {
    test("computes independent edge-local predicates for every expectation", () => {
        const scenario = validScenario();
        const claims = scenario.gold.expectedClaims.map((expected, index): InjectedClaimRecord => ({
            publicClaimId: `clm_01h0000000000000000000000${index}`,
            revisionLocator: `clm_01h0000000000000000000000${index}@1`,
            content: expected.predicate.value,
            category: expected.category,
            revision: 1,
        }));

        expect(expectationGoldMatchPredicates(scenario, claims)).toEqual({
            "exp-cache-capacity": true,
            "exp-lru-cache": true,
        });
        expect(expectationGoldMatchPredicates(scenario, [claims[0]!])).toEqual({
            "exp-cache-capacity": false,
            "exp-lru-cache": true,
        });
    });

    test("lets one visible claim satisfy two expectation predicates independently", () => {
        const scenario = validScenario();
        scenario.gold.expectedClaims = [
            { ...scenario.gold.expectedClaims[0]!, id: "exp-cache-a" },
            { ...scenario.gold.expectedClaims[0]!, id: "exp-cache-b" },
        ];

        expect(expectationGoldMatchPredicates(scenario, [{
            category: "ARCHITECTURE",
            content: "Use the in-process LRU cache.",
        }])).toEqual({
            "exp-cache-a": true,
            "exp-cache-b": true,
        });
    });

    test("holds for identical predicate maps and unrelated extra claims", () => {
        const unrelated: InjectedClaimRecord = {
            publicClaimId: "clm_01h00000000000000000000009",
            revisionLocator: "clm_01h00000000000000000000009@1",
            content: "unrelated formed claim",
            category: "ARCHITECTURE",
            revision: 1,
        };
        const verdicts = compareLivePair(
            observation({ score: score({ recall: 0.5 }) }),
            observation({ score: score({ recall: 1, visibleClaimsTotal: 3 }), injectedClaims: [unrelated] }),
        );

        expect(verdicts.every((verdict) => verdict.holds)).toBe(true);
    });

    test("names an expectation lost only by the derivative", () => {
        const verdicts = compareLivePair(
            observation(),
            observation({ expectationMatches: { "exp-cache-capacity": false, "exp-lru-cache": true } }),
        );

        expect(verdicts[0]).toEqual({
            invariant: "expectation-predicate-equality",
            holds: false,
            changedExpectationIds: ["exp-cache-capacity"],
        });
    });

    test("names a false-authoritative match added only by the derivative", () => {
        expect(compareLivePair(
            observation(),
            observation({ score: score({ falseAuthoritativeMatches: ["abs-redis-active"] }) }),
        )[1]).toEqual({
            invariant: "false-authoritative-set-equality",
            holds: false,
            baselineMatches: [],
            derivativeMatches: ["abs-redis-active"],
        });
    });

    test("rejects a PASS to FAIL verdict change", () => {
        expect(compareLivePair(
            observation(),
            observation({ score: score({ verdict: "FAIL" }) }),
        )[2]).toEqual({
            invariant: "scenario-verdict-equality",
            holds: false,
            baselineVerdict: "PASS",
            derivativeVerdict: "FAIL",
        });
    });
});

describe("live metamorphic orchestration", () => {
    test("admits a lint-clean derivative through the mutation battery", () => {
        const transformed = TRANSFORMS[0]!.apply(validScenario(), 0);
        if (!transformed.applicable) throw new Error("fixture transform must apply");

        expect(liveDerivativeAdmissionDiagnostics([transformed.scenario])).toEqual([]);
    });

    test("runs each role once in its own artifact directory", async () => {
        const calls: Array<{ role: string; artifactDir: string }> = [];
        const root = "/tmp/metamorphic-live-test";
        const scenario = validScenario();
        const transformed = TRANSFORMS[0]!.apply(scenario, 0);
        if (!transformed.applicable) throw new Error("fixture transform must apply");
        const report = await runLiveMetamorphicEval([validScenario()], {
            mode: { kind: "live", apiKey: "test", historianModel: "anthropic/historian", probeModel: { providerID: "anthropic", modelID: "probe" } },
            artifactRoot: root,
            opencodeVersion: "1.0.0",
            transforms: [TRANSFORMS[0]!],
            seeds: [0],
            admit: () => [],
            execute: async (_scenario, role, artifactDir) => {
                calls.push({ role, artifactDir });
                return observation();
            },
        });

        expect(calls).toEqual([
            { role: "control-a", artifactDir: join(root, scenario.id, "control-a") },
            { role: "control-b", artifactDir: join(root, scenario.id, "control-b") },
            { role: "baseline", artifactDir: join(root, transformed.scenario.id, "baseline") },
            { role: "derivative", artifactDir: join(root, transformed.scenario.id, "derivative") },
        ]);
        expect(new Set(calls.map((call) => call.artifactDir)).size).toBe(4);
        expect(report.entries).toHaveLength(2);
        expect(metamorphicExitCode(report)).toBe(0);
    });

    test("control disagreement invalidates the tier before product pairs", async () => {
        const calls: string[] = [];
        const report = await runLiveMetamorphicEval([validScenario()], {
            mode: { kind: "live", apiKey: "test", historianModel: "anthropic/historian", probeModel: { providerID: "anthropic", modelID: "probe" } },
            artifactRoot: "/tmp/metamorphic-live-test",
            opencodeVersion: "1.0.0",
            transforms: [TRANSFORMS[0]!],
            seeds: [0],
            admit: () => [],
            execute: async (_scenario, role) => {
                calls.push(role);
                return role === "control-b"
                    ? observation({ expectationMatches: { "exp-cache-capacity": false, "exp-lru-cache": true } })
                    : observation();
            },
        });

        expect(calls).toEqual(["control-a", "control-b"]);
        expect(report.entries).toHaveLength(1);
        expect(report.entries[0]).toEqual(expect.objectContaining({ kind: "error", transformId: "baseline-control" }));
        expect(report.tierInvalidReason).toEqual({
            kind: "control-disagreement",
            systemMismatch: false,
            failedInvariants: ["expectation-predicate-equality"],
        });
        expect(metamorphicExitCode(report)).toBe(1);
    });

    test("compares control system tuples independent of object key order", async () => {
        const system = score().system!;
        const reorderedSystem = Object.fromEntries(Object.entries(system).reverse()) as typeof system;
        const report = await runLiveMetamorphicEval([validScenario()], {
            mode: { kind: "live", apiKey: "test", historianModel: "anthropic/historian", probeModel: { providerID: "anthropic", modelID: "probe" } },
            artifactRoot: "/tmp/metamorphic-live-test",
            opencodeVersion: "1.0.0",
            transforms: [TRANSFORMS[0]!],
            seeds: [0],
            admit: () => [],
            execute: async (_scenario, role) =>
                role === "control-b" ? observation({ score: score({ system: reorderedSystem }) }) : observation(),
        });

        expect(report.tierInvalidReason).toBeNull();
        expect(metamorphicExitCode(report)).toBe(0);
    });

    test("rejects a product pair whose system tuples differ", async () => {
        const report = await runLiveMetamorphicEval([validScenario()], {
            mode: { kind: "live", apiKey: "test", historianModel: "anthropic/historian", probeModel: { providerID: "anthropic", modelID: "probe" } },
            artifactRoot: "/tmp/metamorphic-live-test",
            opencodeVersion: "1.0.0",
            transforms: [TRANSFORMS[0]!],
            seeds: [0],
            admit: () => [],
            execute: async (_scenario, role) => role === "derivative"
                ? observation({ score: score({ system: { ...score().system!, historianModelId: "anthropic/other" } }) })
                : observation(),
        });

        expect(report.entries).toContainEqual(expect.objectContaining({
            kind: "error",
            error: "pair system tuple mismatch",
        }));
        expect(metamorphicExitCode(report)).toBe(1);
    });

    test("treats two null control system tuples as a tier-invalid system mismatch", async () => {
        const report = await runLiveMetamorphicEval([validScenario()], {
            mode: { kind: "live", apiKey: "test", historianModel: "anthropic/historian", probeModel: { providerID: "anthropic", modelID: "probe" } },
            artifactRoot: "/tmp/metamorphic-live-test",
            opencodeVersion: "1.0.0",
            transforms: [TRANSFORMS[0]!],
            seeds: [0],
            admit: () => [],
            execute: async () => observation({ score: score({ system: null }) }),
        });

        expect(report.tierInvalidReason).toEqual({
            kind: "control-disagreement",
            systemMismatch: true,
            failedInvariants: [],
        });
        expect(metamorphicExitCode(report)).toBe(1);
    });

    test("refuses admission before any model call", async () => {
        let calls = 0;
        const report = await runLiveMetamorphicEval([validScenario()], {
            mode: { kind: "live", apiKey: "test", historianModel: "anthropic/historian", probeModel: { providerID: "anthropic", modelID: "probe" } },
            artifactRoot: "/tmp/metamorphic-live-test",
            opencodeVersion: "1.0.0",
            transforms: [TRANSFORMS[0]!],
            seeds: [0],
            admit: () => ["lint-red derivative"],
            execute: async () => {
                calls += 1;
                return observation();
            },
        });

        expect(calls).toBe(0);
        expect(report.entries[0]).toEqual(expect.objectContaining({ kind: "error", error: expect.stringContaining("lint-red") }));
    });

    test("preserves all rejected pairs instead of reporting an empty selection", async () => {
        let calls = 0;
        const report = await runLiveMetamorphicEval([validScenario()], {
            mode: { kind: "live", apiKey: "test", historianModel: "anthropic/historian", probeModel: { providerID: "anthropic", modelID: "probe" } },
            artifactRoot: "/tmp/metamorphic-live-test",
            opencodeVersion: "1.0.0",
            transforms: [
                {
                    id: "no-op",
                    version: 1,
                    alwaysApplicable: true,
                    apply: (base) => ({
                        applicable: true,
                        scenario: { ...base, id: `${base.id}-d-no-op-v1-s0` },
                        turnMap: base.transcript.turns.map((_, index) => index),
                    }),
                },
                {
                    id: "throws",
                    version: 1,
                    alwaysApplicable: true,
                    apply: () => {
                        throw new Error("fixture transform failure");
                    },
                },
            ],
            seeds: [0],
            execute: async () => {
                calls += 1;
                return observation();
            },
        });

        expect(calls).toBe(0);
        expect(report.entries).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: "lint-red" }),
            expect.objectContaining({ kind: "error", error: "fixture transform failure" }),
        ]));
        expect(report.tierInvalidReason).toBeNull();
        expect(metamorphicExitCode(report)).toBe(1);
    });

    test("flags an always-applicable transform that reports inapplicable", async () => {
        const report = await runLiveMetamorphicEval([validScenario()], {
            mode: { kind: "live", apiKey: "test", historianModel: "anthropic/historian", probeModel: { providerID: "anthropic", modelID: "probe" } },
            artifactRoot: "/tmp/metamorphic-live-test",
            opencodeVersion: "1.0.0",
            transforms: [{
                id: "broken-always",
                version: 1,
                alwaysApplicable: true,
                apply: () => ({ applicable: false, reason: "fixture refusal" }),
            }],
            seeds: [0],
            admit: () => [],
            execute: async () => observation(),
        });

        expect(report.coverage[0]).toEqual(expect.objectContaining({
            applied: 0,
            violations: [
                "broken-always declared always applicable but did not apply",
                "no transforms applied",
            ],
        }));
        expect(metamorphicExitCode(report)).toBe(1);
    });

    test.each(["control-a", "control-b", "baseline", "derivative"] as const)(
        "preserves hard canary coordinates and exit 2 for %s",
        async (canaryRole) => {
        const calls: string[] = [];
        const canary: InjectedClaimRecord = {
            publicClaimId: "clm_01h00000000000000000000008",
            revisionLocator: "clm_01h00000000000000000000008@1",
            content: INJECTION_CANARY,
            category: "CONSTRAINTS",
            revision: 1,
        };
        const report = await runLiveMetamorphicEval([validScenario()], {
            mode: { kind: "live", apiKey: "test", historianModel: "anthropic/historian", probeModel: { providerID: "anthropic", modelID: "probe" } },
            artifactRoot: "/tmp/metamorphic-live-test",
            opencodeVersion: "1.0.0",
            transforms: [TRANSFORMS[0]!],
            seeds: [0],
            admit: () => [],
            execute: async (_scenario, role) => {
                calls.push(role);
                return role === canaryRole ? observation({ injectedClaims: [canary] }) : observation();
            },
        });

        expect(report.injectionCanaryHits).toEqual([{
            scenarioId: validScenario().id,
            role: canaryRole,
            transformId: canaryRole === "baseline" || canaryRole === "derivative" ? TRANSFORMS[0]!.id : null,
            transformVersion: canaryRole === "baseline" || canaryRole === "derivative" ? TRANSFORMS[0]!.version : null,
            seed: canaryRole === "baseline" || canaryRole === "derivative" ? 0 : null,
        }]);
        const roles = ["control-a", "control-b", "baseline", "derivative"];
        expect(calls).toEqual(roles.slice(0, roles.indexOf(canaryRole) + 1));
        expect(metamorphicExitCode(report)).toBe(2);
    });

    test("marks an all-inapplicable live selection as selection-empty, not product brittleness", async () => {
        const report = await runLiveMetamorphicEval([validScenario()], {
            mode: { kind: "live", apiKey: "test", historianModel: "anthropic/historian", probeModel: { providerID: "anthropic", modelID: "probe" } },
            artifactRoot: "/tmp/metamorphic-live-test",
            opencodeVersion: "1.0.0",
            transforms: [{
                id: "never",
                version: 1,
                alwaysApplicable: false,
                apply: () => ({ applicable: false, reason: "fixture has no target" }),
            }],
            seeds: [0],
            admit: () => [],
            execute: async () => observation(),
        });

        expect(report.entries).toEqual([]);
        expect(report.tierInvalidReason).toEqual({
            kind: "selection-empty",
            reason: "no applicable product pairs selected; choose a scenario and transform that apply",
        });
        expect(JSON.stringify(report)).not.toContain("brittleness");
        expect(metamorphicExitCode(report)).toBe(1);
    });

    test("checks the deadline only between calls and publishes progress after controls and pairs", async () => {
        let now = 0;
        const calls: string[] = [];
        const progress: number[] = [];
        const report = await runLiveMetamorphicEval([validScenario()], {
            mode: { kind: "live", apiKey: "test", historianModel: "anthropic/historian", probeModel: { providerID: "anthropic", modelID: "probe" } },
            artifactRoot: "/tmp/metamorphic-live-test",
            opencodeVersion: "1.0.0",
            transforms: [TRANSFORMS[0]!],
            seeds: [0, 1],
            admit: () => [],
            deadlineAtMs: 10,
            nowMs: () => now,
            onProgress: (partial) => progress.push(partial.entries.length),
            execute: async (_scenario, role) => {
                calls.push(role);
                if (role === "baseline") now = 20;
                return observation();
            },
        });

        expect(calls).toEqual(["control-a", "control-b", "baseline"]);
        expect(progress).toEqual([0, 1]);
        expect(report.tierInvalidReason).toEqual(expect.objectContaining({ kind: "deadline-exhausted" }));
        expect(metamorphicExitCode(report)).toBe(1);
    });

    test("publishes progress after control completion and every completed product pair", async () => {
        const progress: number[] = [];
        await runLiveMetamorphicEval([validScenario()], {
            mode: { kind: "live", apiKey: "test", historianModel: "anthropic/historian", probeModel: { providerID: "anthropic", modelID: "probe" } },
            artifactRoot: "/tmp/metamorphic-live-test",
            opencodeVersion: "1.0.0",
            transforms: [TRANSFORMS[0]!],
            seeds: [0, 1],
            admit: () => [],
            onProgress: (partial) => progress.push(partial.entries.length),
            execute: async () => observation(),
        });

        expect(progress).toEqual([0, 1, 2, 3]);
    });

    test("isolates every role artifact directory", () => {
        const root = "/tmp/metamorphic-live";
        const scenarioId = "hse-example-d-transform-v1-s0";
        const paths = (["baseline", "derivative", "control-a", "control-b"] as const)
            .map((role) => liveArtifactDir(root, scenarioId, role));

        expect(new Set(paths).size).toBe(4);
        expect(paths[0]).toBe(join(root, scenarioId, "baseline"));
    });
});

describe("metamorphic CLI selection", () => {
    test("resolves live mode before corpus admission", () => {
        const calls: string[] = [];
        expect(() => prepareLivePreamble([validScenario()], {
            liveModeFromEnv() {
                calls.push("mode");
                throw new Error("missing route");
            },
            liveAdmissionGate() {
                calls.push("admission");
                return 0;
            },
        })).toThrow("missing route");
        expect(calls).toEqual(["mode"]);
    });

    test.each(["admission", "build", "opencode"] as const)(
        "fails the %s preamble stage before later work",
        (stage) => {
        const calls: string[] = [];
        const prepared = prepareLivePreamble([validScenario()], {
            liveModeFromEnv: () => ({ kind: "live", apiKey: "test", historianModel: "anthropic/historian", probeModel: { providerID: "anthropic", modelID: "probe" } }),
            liveAdmissionGate: () => {
                calls.push("admission");
                return stage === "admission" ? 1 : 0;
            },
            buildPluginBundle: () => {
                calls.push("build");
                return stage === "build" ? 1 : 0;
            },
            opencodeVersion: () => {
                calls.push("opencode");
                return stage === "opencode" ? null : "1.0.0";
            },
            runSystemTuple: () => {
                calls.push("system");
                return score().system!;
            },
        });

        expect(prepared).toBeNull();
        expect(calls).toEqual(
            stage === "admission"
                ? ["admission"]
                : stage === "build"
                  ? ["admission", "build"]
                  : ["admission", "build", "opencode"],
        );
    });

    test("refuses an unknown checkout identity before live execution", () => {
        const calls: string[] = [];
        const prepared = prepareLivePreamble([validScenario()], {
            liveModeFromEnv: () => ({ kind: "live", apiKey: "test", historianModel: "anthropic/historian", probeModel: { providerID: "anthropic", modelID: "probe" } }),
            liveAdmissionGate: () => 0,
            buildPluginBundle: () => 0,
            opencodeVersion: () => "1.0.0",
            runSystemTuple: () => {
                calls.push("system");
                return { ...score().system!, repoCommitSha: "unknown" };
            },
        });

        expect(prepared).toBeNull();
        expect(calls).toEqual(["system"]);
    });

    test("parses live filters and rejects unknown selections", () => {
        const scenario = validScenario();
        const args = parseArgs([
            "--live",
            "--scenario",
            scenario.id,
            "--transform",
            TRANSFORMS[0]!.id,
            "--report",
            "/tmp/report.json",
        ]);

        expect(args.live).toBe(true);
        expect(args.deadlineMinutes).toBeNull();
        expect(selectInputs([scenario], args)).toEqual({
            scenarios: [scenario],
            transforms: [TRANSFORMS[0]!],
        });
        expect(() => selectInputs([scenario], { scenarioIds: ["missing"], transformIds: [] }))
            .toThrow(/unknown scenario/);
    });

    test("rejects multiple live scenarios before preparing the model route", () => {
        const first = validScenario();
        const second = { ...validScenario(), id: "hse-second" };
        expect(() => selectInputs([first, second], {
            live: true,
            scenarioIds: [],
            transformIds: [TRANSFORMS[0]!.id],
        })).toThrow(/exactly one scenario/);
    });

    test("loads --scenarios from a directory and rejects missing or non-directory paths", () => {
        const root = mkdtempSync(join(tmpdir(), "metamorphic-corpus-"));
        try {
            writeFileSync(join(root, "scenario.json"), JSON.stringify(validScenario()));
            expect(parseArgs(["--scenarios", root]).corpusDirectory).toBe(root);
            expect(loadCorpus(root).map((scenario) => scenario.id)).toEqual([validScenario().id]);
            expect(() => loadCorpus(join(root, "missing"))).toThrow(/scenario directory does not exist/);
            expect(() => loadCorpus(join(root, "scenario.json"))).toThrow(/not a directory/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("keeps workflow transform choices and defaults bound to implementation", () => {
        const workflow = Bun.YAML.parse(readFileSync(
            join(import.meta.dir, "../../../../.github/workflows/historian-eval.yml"),
            "utf8",
        )) as {
            on: { workflow_dispatch: { inputs: Record<string, { options?: string[]; default: string }> } };
        };
        const inputs = workflow.on.workflow_dispatch.inputs;
        expect([...(inputs.metamorphic_transform.options ?? [])].sort()).toEqual(
            TRANSFORMS.map((transform) => transform.id).sort(),
        );
        expect(inputs.metamorphic_scenario.default).toBe("hse-webhook-docs-injection");

        const selected = selectInputs(loadCorpus(join(import.meta.dir, "../../historian-eval/dev")), {
            live: true,
            scenarioIds: [inputs.metamorphic_scenario.default],
            transformIds: [inputs.metamorphic_transform.default],
        });
        const transformed = selected.transforms[0]!.apply(selected.scenarios[0]!, 20_260_830);
        expect(transformed.applicable).toBe(true);
        if (!transformed.applicable) throw new Error("workflow default transform must apply");
        expect(JSON.stringify(transformed.scenario)).toContain(INJECTION_CANARY);
    });

    test("parses a positive deadline and rejects invalid values", () => {
        expect(parseArgs(["--deadline-minutes", "290"]).deadlineMinutes).toBe(290);
        expect(() => parseArgs(["--deadline-minutes", "0"])).toThrow(/positive integer/);
    });

    test("writes incremental partial evidence and removes it only after final write", async () => {
        const root = mkdtempSync(join(tmpdir(), "metamorphic-partial-"));
        try {
            const destination = join(root, "report.json");
            const report = await runLiveAndWriteReport(destination, [validScenario()], {
                mode: { kind: "live", apiKey: "test", historianModel: "anthropic/historian", probeModel: { providerID: "anthropic", modelID: "probe" } },
                artifactRoot: join(root, "runs"),
                opencodeVersion: "1.0.0",
                transforms: [TRANSFORMS[0]!],
                seeds: [0],
                admit: () => [],
                execute: async () => observation(),
            });

            expect(report.entries).toHaveLength(2);
            expect(existsSync(join(root, "report.partial.json"))).toBe(false);
            expect(JSON.parse(readFileSync(destination, "utf8"))).toEqual(report);

            const badDestination = join(root, "final-is-directory");
            const partialPath = `${badDestination}.partial.json`;
            mkdirSync(badDestination);
            await expect(runLiveAndWriteReport(badDestination, [validScenario()], {
                mode: { kind: "live", apiKey: "test", historianModel: "anthropic/historian", probeModel: { providerID: "anthropic", modelID: "probe" } },
                artifactRoot: join(root, "runs-fail"),
                opencodeVersion: "1.0.0",
                transforms: [TRANSFORMS[0]!],
                seeds: [0],
                admit: () => [],
                execute: async () => observation(),
            })).rejects.toThrow();
            expect(existsSync(partialPath)).toBe(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("refuses model spend when the initial partial is not writable", async () => {
        const root = mkdtempSync(join(tmpdir(), "metamorphic-initial-partial-"));
        let calls = 0;
        try {
            const destination = join(root, "report.json");
            mkdirSync(join(root, "report.partial.json"));
            await expect(runLiveAndWriteReport(destination, [validScenario()], {
                mode: { kind: "live", apiKey: "test", historianModel: "anthropic/historian", probeModel: { providerID: "anthropic", modelID: "probe" } },
                artifactRoot: join(root, "runs"),
                opencodeVersion: "1.0.0",
                transforms: [TRANSFORMS[0]!],
                seeds: [0],
                admit: () => [],
                execute: async () => {
                    calls += 1;
                    return observation();
                },
            })).rejects.toThrow();
            expect(calls).toBe(0);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("ignores later progress write failures and still publishes the final report", async () => {
        const root = mkdtempSync(join(tmpdir(), "metamorphic-progress-fail-"));
        try {
            const destination = join(root, "report.json");
            const partial = join(root, "report.partial.json");
            let progressCalls = 0;
            const report = await runLiveAndWriteReport(destination, [validScenario()], {
                mode: { kind: "live", apiKey: "test", historianModel: "anthropic/historian", probeModel: { providerID: "anthropic", modelID: "probe" } },
                artifactRoot: join(root, "runs"),
                opencodeVersion: "1.0.0",
                transforms: [TRANSFORMS[0]!],
                seeds: [0],
                admit: () => [],
                execute: async () => observation(),
                onProgress: () => {
                    progressCalls += 1;
                    if (progressCalls === 1) {
                        rmSync(partial, { force: true });
                        mkdirSync(partial);
                    } else {
                        throw new Error("progress observer failed");
                    }
                },
            });

            expect(report.entries).toHaveLength(2);
            expect(JSON.parse(readFileSync(destination, "utf8"))).toEqual(report);
            expect(existsSync(partial)).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("deadline logging points to the surviving final report", async () => {
        const root = mkdtempSync(join(tmpdir(), "metamorphic-deadline-"));
        const error = spyOn(console, "error").mockImplementation(() => {});
        try {
            const destination = join(root, "report.json");
            await runLiveAndWriteReport(destination, [validScenario()], {
                mode: { kind: "live", apiKey: "test", historianModel: "anthropic/historian", probeModel: { providerID: "anthropic", modelID: "probe" } },
                artifactRoot: join(root, "runs"),
                opencodeVersion: "1.0.0",
                transforms: [TRANSFORMS[0]!],
                seeds: [0],
                admit: () => [],
                deadlineAtMs: 0,
                nowMs: () => 0,
                execute: async () => observation(),
            });

            expect(error.mock.calls.flat().join(" ")).toContain(`inspect final report ${destination}`);
            expect(error.mock.calls.flat().join(" ")).not.toContain("incremental partial report");
        } finally {
            error.mockRestore();
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("red logging prints actionable canary, coverage, entry, verdict, and invariant detail", () => {
        const errors = spyOn(console, "error").mockImplementation(() => {});
        const output = spyOn(console, "log").mockImplementation(() => {});
        try {
            const key = {
                scenarioId: validScenario().id,
                transformId: TRANSFORMS[0]!.id,
                transformVersion: TRANSFORMS[0]!.version,
                seed: 0,
            };
            const report = buildMetamorphicReport({
                entries: [
                    { ...key, kind: "error", error: "fixture error" },
                    {
                        ...key,
                        seed: 1,
                        kind: "scored",
                        baselineScore: score({ verdict: "FAIL", failReasons: ["recall"] }),
                        derivativeScore: score(),
                        invariants: [{
                            invariant: "scenario-verdict-equality",
                            holds: false,
                            baselineVerdict: "FAIL",
                            derivativeVerdict: "PASS",
                        }],
                    },
                ],
                coverage: [{
                    scenarioId: key.scenarioId,
                    applied: 2,
                    inapplicable: [],
                    violations: ["fixture coverage"],
                }],
                injectionCanaryHits: [{
                    ...key,
                    role: "derivative",
                }],
            });

            expect(logReport("/tmp/report.json", report)).toBe(2);
            const logged = errors.mock.calls.flat().join("\n");
            expect(logged).toContain('"role":"derivative"');
            expect(logged).toContain("coverage violation:");
            expect(logged).toContain("non-scored pair:");
            expect(logged).toContain("non-PASS pair:");
            expect(logged).toContain("baseline=FAIL(recall)");
            expect(logged).toContain("failed invariant:");
            expect(logged).toContain('"baselineVerdict":"FAIL"');
        } finally {
            errors.mockRestore();
            output.mockRestore();
        }
    });
});
