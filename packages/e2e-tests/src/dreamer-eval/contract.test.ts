import { describe, expect, test } from "bun:test";
import {
    DREAMER_EVAL_REPORT_SCHEMA,
    DREAMER_EVAL_SCENARIO_SCHEMA,
    DreamerEvalContractError,
    RUN_FATAL_FAIL_REASONS,
    dreamerEvalExitCode,
    parseRunReport,
    parseScenario,
    serializeScenario,
} from "./contract";

function claim(index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: `claim-${index}`,
        content: `Distinct memory content ${index}`,
        category: "CONSTRAINTS",
        importance: 50,
        memoryScope: "project",
        sharing: "shareable",
        hygieneVisible: true,
        fileIndependent: false,
        fixtureFiles: [{ path: `src/file-${index}.ts`, content: `export const value${index} = ${index};\n` }],
        ...overrides,
    };
}

function validScenarioRaw(): Record<string, unknown> {
    const claims = Array.from({ length: 10 }, (_, index) =>
        claim(index + 1, index === 9 ? { fileIndependent: true, fixtureFiles: [] } : {}),
    );
    return {
        schema: DREAMER_EVAL_SCENARIO_SCHEMA,
        id: "dme-core-pool",
        title: "Core dreamer maintenance pool",
        pool: { claims },
        tasks: [
            {
                task: "verify",
                preconditions: { mappings: [], verifications: [], classifiedClaimIds: [] },
                expectedInScopeClaimIds: claims.slice(0, 9).map((entry) => entry.id),
                expectedSkippedClaimIds: ["claim-10"],
                expectedResultMode: "incremental",
                gold: {
                    kind: "verify",
                    claims: claims.slice(0, 9).map((entry, index) => ({
                        claimId: entry.id,
                        verdict: "verified",
                        expectedFiles: [`src/file-${index + 1}.ts`],
                        requiredUpdateAnchors: [],
                        forbiddenUpdateAnchors: [],
                    })),
                },
            },
            {
                task: "map-memories",
                preconditions: { mappings: [], verifications: [], classifiedClaimIds: [] },
                expectedInScopeClaimIds: claims.map((entry) => entry.id),
                expectedSkippedClaimIds: [],
                expectedResultMode: null,
                gold: {
                    kind: "map",
                    claims: claims.map((entry, index) => ({
                        claimId: entry.id,
                        files: index === 9 ? [] : [`src/file-${index + 1}.ts`],
                        independent: index === 9,
                    })),
                },
            },
            {
                task: "classify-memories",
                preconditions: { mappings: [], verifications: [], classifiedClaimIds: [] },
                expectedInScopeClaimIds: claims.map((entry) => entry.id),
                expectedSkippedClaimIds: [],
                expectedResultMode: null,
                gold: {
                    kind: "classify",
                    claims: claims.map((entry) => ({
                        claimId: entry.id,
                        importance: { min: 40, max: 60 },
                        scope: "project",
                        shareable: true,
                    })),
                },
            },
        ],
    };
}

function expectDiagnostic(edit: (raw: Record<string, unknown>) => void, diagnostic: string): void {
    const raw = validScenarioRaw();
    edit(raw);
    try {
        parseScenario(raw);
        throw new Error("expected contract rejection");
    } catch (error) {
        expect(error).toBeInstanceOf(DreamerEvalContractError);
        expect((error as DreamerEvalContractError).diagnostics).toContain(diagnostic);
    }
}

describe("dreamer eval scenario contract", () => {
    test("full valid scenario round-trips unchanged", () => {
        const raw = validScenarioRaw();
        const parsed = parseScenario(raw);
        expect(JSON.parse(serializeScenario(parsed))).toEqual(raw);
        expect(parseScenario(JSON.parse(serializeScenario(parsed)))).toEqual(parsed);
    });

    test("gold cannot name a claim absent from the pool", () => {
        expectDiagnostic((raw) => {
            const tasks = raw.tasks as Array<{ gold: { claims: Array<{ claimId: string }> } }>;
            tasks[0]!.gold.claims[0]!.claimId = "claim-missing";
        }, "scenario.tasks[0].gold.claims[0].claimId: unknown-claim");
    });

    test("importance bands stay ordered and within 1-100", () => {
        expectDiagnostic((raw) => {
            const tasks = raw.tasks as Array<{ gold: { claims: Array<{ importance?: { min: number; max: number } }> } }>;
            tasks[2]!.gold.claims[0]!.importance = { min: 0, max: 60 };
        }, "scenario.tasks[2].gold.claims[0].importance.min: integer-invalid");
        expectDiagnostic((raw) => {
            const tasks = raw.tasks as Array<{ gold: { claims: Array<{ importance?: { min: number; max: number } }> } }>;
            tasks[2]!.gold.claims[0]!.importance = { min: 80, max: 70 };
        }, "scenario.tasks[2].gold.claims[0].importance: range-invalid");
    });

    test("verify gold excludes file-independent claims", () => {
        expectDiagnostic((raw) => {
            const tasks = raw.tasks as Array<{ gold: { claims: unknown[] } }>;
            tasks[0]!.gold.claims.push({
                claimId: "claim-10",
                verdict: "verified",
                expectedFiles: [],
                requiredUpdateAnchors: [],
                forbiddenUpdateAnchors: [],
            });
        }, "scenario.tasks[0].gold.claims[9].claimId: file-independent-verify");
    });

    test("pool requires 10-50 hygiene-visible claims", () => {
        expectDiagnostic((raw) => {
            (raw.pool as { claims: unknown[] }).claims.pop();
        }, "scenario.pool.claims: hygiene-visible-count-invalid");
        expectDiagnostic((raw) => {
            const claims = (raw.pool as { claims: unknown[] }).claims;
            for (let index = 11; index <= 51; index += 1) claims.push(claim(index));
        }, "scenario.pool.claims: count-invalid");
    });

    test("verify gold ties the reported backing set to the verdict", () => {
        expectDiagnostic((raw) => {
            const tasks = raw.tasks as Array<{ gold: { claims: Array<{ expectedFiles: string[] }> } }>;
            tasks[0]!.gold.claims[0]!.expectedFiles = [];
        }, "scenario.tasks[0].gold.claims[0].expectedFiles: retained-claim-has-no-file");
        expectDiagnostic((raw) => {
            const tasks = raw.tasks as Array<{
                gold: { claims: Array<{ verdict: string; expectedFiles: string[] }> };
            }>;
            tasks[0]!.gold.claims[0]!.verdict = "archive";
        }, "scenario.tasks[0].gold.claims[0].expectedFiles: archive-has-files");
    });

    test("map gold cannot pair independence with a file set", () => {
        expectDiagnostic((raw) => {
            const tasks = raw.tasks as Array<{ gold: { claims: Array<{ files: string[] }> } }>;
            tasks[1]!.gold.claims[9]!.files = ["src/ghost.ts"];
        }, "scenario.tasks[1].gold.claims[9].files: independent-has-files");
        expectDiagnostic((raw) => {
            const tasks = raw.tasks as Array<{ gold: { claims: Array<{ files: string[] }> } }>;
            tasks[1]!.gold.claims[0]!.files = [];
        }, "scenario.tasks[1].gold.claims[0].files: mapped-claim-has-no-file");
    });

    test("a precondition with no seeding implementation is rejected", () => {
        expectDiagnostic((raw) => {
            const tasks = raw.tasks as Array<{ preconditions: { classifiedClaimIds: string[] } }>;
            tasks[0]!.preconditions.classifiedClaimIds = ["claim-1"];
        }, "scenario.tasks[0].preconditions.classifiedClaimIds: unsupported");
    });
});

describe("dreamer eval report contract", () => {
    const baseReport = {
        schema: DREAMER_EVAL_REPORT_SCHEMA,
        scenarioId: "dme-core-pool",
        task: "verify",
        runId: "run-1",
        nowMs: 1,
        status: "PASS",
        reason: null,
        runFatal: false,
        system: {
            repoCommitSha: "a".repeat(40),
            bunVersion: "1.3.11",
            opencodeVersion: "1.0.0",
            modelId: "model",
            parserImpl: "ts",
        },
        poolBefore: [],
        poolAfter: [],
        rawManifest: "<verify></verify>",
        parsedManifest: {},
        receiptOutcomes: [],
    };

    test("unknown ERROR or FAIL reason is rejected", () => {
        expect(() => parseRunReport({ ...baseReport, status: "ERROR", reason: "unknown" })).toThrow(
            /reason: enum-invalid/,
        );
        expect(() => parseRunReport({ ...baseReport, status: "FAIL", reason: "unknown" })).toThrow(
            /reason: enum-invalid/,
        );
    });

    test("exit mapping is 0 for PASS, 1 for ordinary red, and 2 for wrong archival", () => {
        expect(dreamerEvalExitCode(parseRunReport(baseReport))).toBe(0);
        expect(dreamerEvalExitCode(parseRunReport({ ...baseReport, status: "FAIL", reason: "wrong-verdict" }))).toBe(1);
        expect(
            dreamerEvalExitCode(
                parseRunReport({ ...baseReport, status: "FAIL", reason: "wrong-archival", runFatal: true }),
            ),
        ).toBe(2);
    });

    test("runFatal must agree with the declared run-fatal reason set", () => {
        for (const reason of RUN_FATAL_FAIL_REASONS) {
            expect(() => parseRunReport({ ...baseReport, status: "FAIL", reason, runFatal: false })).toThrow(
                /runFatal: mapping-invalid/,
            );
        }
        expect(() =>
            parseRunReport({ ...baseReport, status: "FAIL", reason: "wrong-verdict", runFatal: true }),
        ).toThrow(/runFatal: mapping-invalid/);
        expect(() =>
            parseRunReport({ ...baseReport, status: "ERROR", reason: "harness-failure", runFatal: true }),
        ).toThrow(/runFatal: mapping-invalid/);
    });

    test("parsed manifest evidence round-trips every scorer's shape", () => {
        // Verify parses to one record of verdict lists; map and classify parse
        // to one entry per claim, so a report that only accepted a record could
        // not carry the evidence two of the three scorers produce.
        const mapShape = [{ publicClaimId: "mcm_one", files: ["src/a.ts"], independent: false }];
        expect(parseRunReport({ ...baseReport, task: "map-memories", parsedManifest: mapShape }).parsedManifest).toEqual(
            mapShape,
        );
        const verifyShape = { verified: [{ publicClaimId: "mcm_one", files: ["src/a.ts"] }], updated: [], archived: [] };
        expect(parseRunReport({ ...baseReport, parsedManifest: verifyShape }).parsedManifest).toEqual(verifyShape);
        expect(parseRunReport({ ...baseReport, parsedManifest: null }).parsedManifest).toBeNull();
        expect(() => parseRunReport({ ...baseReport, parsedManifest: ["not-a-record"] })).toThrow(
            /parsedManifest\[0\]: object-required/,
        );
        expect(() => parseRunReport({ ...baseReport, parsedManifest: "not-a-manifest" })).toThrow(
            /parsedManifest: object-required/,
        );
    });

    test("a report snapshot array cannot repeat a claim", () => {
        const snapshot = {
            claimId: "claim-1",
            publicClaimId: "mcm_one",
            revisionLocator: "mcm_one@1",
            content: "Distinct memory content",
            category: "CONSTRAINTS",
            importance: 50,
            memoryScope: "project",
            sharing: "private",
            lifecycleState: "active",
            files: ["src/a.ts"],
            verificationOutcome: null,
        };
        for (const field of ["poolBefore", "poolAfter"] as const) {
            expect(() => parseRunReport({ ...baseReport, [field]: [snapshot, { ...snapshot }] })).toThrow(
                new RegExp(`${field}: duplicate`),
            );
            expect(() =>
                parseRunReport({
                    ...baseReport,
                    [field]: [snapshot, { ...snapshot, claimId: "claim-2" }],
                }),
            ).toThrow(new RegExp(`${field}.publicClaimId: duplicate`));
        }
        expect(parseRunReport({ ...baseReport, poolBefore: [snapshot] }).poolBefore).toHaveLength(1);
    });
});
