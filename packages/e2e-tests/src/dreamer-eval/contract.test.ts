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
            // A declared fixture path, so the independence pairing is what
            // fails rather than the tracked-path check.
            tasks[1]!.gold.claims[9]!.files = ["src/file-1.ts"];
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

    test("a claim state no seeding step can reproduce is rejected", () => {
        expectDiagnostic((raw) => {
            (raw.pool as { claims: Array<{ hygieneVisible: boolean }> }).claims[0]!.hygieneVisible = false;
        }, "scenario.pool.claims[0].hygieneVisible: unsupported");
        expectDiagnostic((raw) => {
            (raw.pool as { claims: Array<{ category: string }> }).claims[0]!.category = "REJECTED_APPROACH";
        }, "scenario.pool.claims[0].category: unsupported");
    });

    test("update anchors are rejected on a verdict that never scores them", () => {
        expectDiagnostic((raw) => {
            const tasks = raw.tasks as Array<{ gold: { claims: Array<{ requiredUpdateAnchors: string[] }> } }>;
            tasks[0]!.gold.claims[0]!.requiredUpdateAnchors = ["still true"];
        }, "scenario.tasks[0].gold.claims[0]: anchors-require-update");
        expectDiagnostic((raw) => {
            const tasks = raw.tasks as Array<{ gold: { claims: Array<{ forbiddenUpdateAnchors: string[] }> } }>;
            tasks[0]!.gold.claims[0]!.forbiddenUpdateAnchors = ["stale"];
        }, "scenario.tasks[0].gold.claims[0]: anchors-require-update");
    });

    test("an update whose anchors contradict each other is rejected", () => {
        // Anchor scoring is a case-insensitive substring test, so a forbidden
        // anchor contained in a required one demands content that both holds and
        // omits the same text.
        for (const forbidden of ["bounded cache", "BOUNDED CACHE", "cache"]) {
            expectDiagnostic((raw) => {
                const tasks = raw.tasks as Array<{
                    gold: { claims: Array<{ verdict: string; requiredUpdateAnchors: string[]; forbiddenUpdateAnchors: string[] }> };
                }>;
                const claim = tasks[0]!.gold.claims[0]!;
                claim.verdict = "update";
                claim.requiredUpdateAnchors = ["bounded cache"];
                claim.forbiddenUpdateAnchors = [forbidden];
            }, "scenario.tasks[0].gold.claims[0]: anchors-overlap");
        }
    });

    test("a file path no manifest can encode is rejected", () => {
        // Production splits the `files` attribute on commas and trims each
        // entry, so these paths decode as something other than what was
        // authored and the gold set can never be reported back.
        expectDiagnostic((raw) => {
            const tasks = raw.tasks as Array<{ gold: { claims: Array<{ expectedFiles: string[] }> } }>;
            tasks[0]!.gold.claims[0]!.expectedFiles = ["src/generated,a.ts"];
        }, "scenario.tasks[0].gold.claims[0].expectedFiles[0]: path-unrepresentable");
        expectDiagnostic((raw) => {
            const tasks = raw.tasks as Array<{ gold: { claims: Array<{ files: string[] }> } }>;
            tasks[1]!.gold.claims[0]!.files = [" src/file-1.ts"];
        }, "scenario.tasks[1].gold.claims[0].files[0]: path-unrepresentable");
        expectDiagnostic((raw) => {
            (raw.pool as { claims: Array<{ fixtureFiles: Array<{ path: string }> }> }).claims[0]!.fixtureFiles[0]!.path =
                'src/quote".ts';
        }, "scenario.pool.claims[0].fixtureFiles[0].path: path-unrepresentable");
        expectDiagnostic((raw) => {
            const tasks = raw.tasks as Array<{ preconditions: { mappings: unknown[] } }>;
            tasks[0]!.preconditions.mappings = [{ claimId: "claim-1", files: ["src/a<b>.ts"] }];
        }, "scenario.tasks[0].preconditions.mappings[0].files[0]: path-unrepresentable");
    });

    test("gold file sets are restricted to declared fixture paths", () => {
        // Production drops an untracked path and rejects the manifest when none
        // survives, so gold naming one would score green for output the host
        // cannot apply.
        expectDiagnostic((raw) => {
            const tasks = raw.tasks as Array<{ gold: { claims: Array<{ expectedFiles: string[] }> } }>;
            tasks[0]!.gold.claims[0]!.expectedFiles = ["src/ghost.ts"];
        }, "scenario.tasks[0].gold.claims[0].expectedFiles[0]: path-untracked");
        expectDiagnostic((raw) => {
            const tasks = raw.tasks as Array<{ gold: { claims: Array<{ files: string[] }> } }>;
            tasks[1]!.gold.claims[0]!.files = ["src/./file-1.ts"];
        }, "scenario.tasks[1].gold.claims[0].files[0]: path-untracked");
        // A claim may name a path another claim declares: that is how a fixture
        // models a file that moved.
        const moved = validScenarioRaw();
        (moved.tasks as Array<{ gold: { claims: Array<{ expectedFiles: string[] }> } }>)[0]!.gold.claims[0]!.expectedFiles =
            ["src/file-2.ts"];
        expect(() => parseScenario(moved)).not.toThrow();
    });

    test("a mapping cannot name a path its claim does not declare", () => {
        // The seeder applies a mapping only for a path the mapped claim itself
        // declares and rejects anything else as fixture-drift. Unlike gold, this
        // is per-claim: src/file-2.ts belongs to claim-2.
        expectDiagnostic((raw) => {
            const tasks = raw.tasks as Array<{ preconditions: { mappings: unknown[] } }>;
            tasks[0]!.preconditions.mappings = [{ claimId: "claim-1", files: ["src/file-2.ts"] }];
        }, "scenario.tasks[0].preconditions.mappings[0].files[0]: path-undeclared");
        const declared = validScenarioRaw();
        (declared.tasks as Array<{ preconditions: { mappings: unknown[] } }>)[0]!.preconditions.mappings = [
            { claimId: "claim-1", files: ["src/file-1.ts"] },
        ];
        expect(() => parseScenario(declared)).not.toThrow();
    });

    test("a verify task must declare the one result mode the seeder can produce", () => {
        // The seeder always git-inits and commits, and calls the gate with
        // forceBroad false: "broad" needs forceBroad, "non-git" is never
        // returned at all, and "full" only appears when git change-times are
        // unavailable — which the seeder itself treats as fixture drift.
        for (const mode of ["full", "non-git", "broad", null]) {
            expectDiagnostic((raw) => {
                (raw.tasks as Array<Record<string, unknown>>)[0]!.expectedResultMode = mode;
            }, "scenario.tasks[0].expectedResultMode: verify-mode-unproducible");
        }
    });

    test("a broad task must carry the verification history its watermark needs", () => {
        expectDiagnostic((raw) => {
            const tasks = raw.tasks as Array<Record<string, unknown>>;
            tasks[0]!.task = "verify-broad";
            tasks[0]!.expectedResultMode = "broad";
        }, "scenario.tasks[0].preconditions.verifications: broad-requires-history");
    });

    test("a verification timestamp must leave room for the fixture commit", () => {
        // The seeder derives the commit time as the earliest verification minus
        // 2_000 ms and rejects a non-positive result as fixture-drift.
        expectDiagnostic((raw) => {
            const tasks = raw.tasks as Array<{ preconditions: { verifications: unknown[] } }>;
            tasks[0]!.preconditions.verifications = [
                { claimId: "claim-1", outcome: "verified", verifiedAt: 2_000 },
            ];
        }, "scenario.tasks[0].preconditions.verifications[0].verifiedAt: integer-invalid");
        const seedable = validScenarioRaw();
        (seedable.tasks as Array<{ preconditions: { verifications: unknown[] } }>)[0]!.preconditions.verifications = [
            { claimId: "claim-1", outcome: "verified", verifiedAt: 2_001 },
        ];
        expect(() => parseScenario(seedable)).not.toThrow();
    });

    test("classify gold cannot request shareable for content production forces private", () => {
        // applyClassifications rewrites shareable to false for this content, so
        // the model's "true" would score PASS while the stored claim came out
        // private.
        expectDiagnostic((raw) => {
            (raw.pool as { claims: Array<{ content: string }> }).claims[0]!.content =
                "The provider answers on 127.0.0.1:8080 during local runs.";
        }, "scenario.tasks[2].gold.claims[0].shareable: shareability-override");
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

    test("a commit sha must be a full object id, not an intermediate length", () => {
        // 40 hex characters under SHA-1, 64 under SHA-256, nothing between: an
        // intermediate length names a commit that cannot exist, so the recorded
        // source revision could not be checked out or verified.
        for (const sha of ["a".repeat(39), "a".repeat(41), "a".repeat(63), "a".repeat(65)]) {
            expect(() =>
                parseRunReport({ ...baseReport, system: { ...baseReport.system, repoCommitSha: sha } }),
            ).toThrow(/repoCommitSha: id-invalid/);
        }
        for (const sha of ["a".repeat(40), "a".repeat(64)]) {
            expect(
                parseRunReport({ ...baseReport, system: { ...baseReport.system, repoCommitSha: sha } }).system
                    .repoCommitSha,
            ).toBe(sha);
        }
    });

    test("blank provider output round-trips instead of collapsing into absence", () => {
        // Every scorer records a blank manifest as ERROR:provider-failure, so the
        // observed bytes have to survive the report; null stays reserved for "no
        // output was captured".
        const blank = { ...baseReport, status: "ERROR", reason: "provider-failure", rawManifest: "   " };
        expect(parseRunReport(blank).rawManifest).toBe("   ");
        expect(parseRunReport({ ...blank, rawManifest: "" }).rawManifest).toBe("");
        expect(parseRunReport({ ...blank, rawManifest: null }).rawManifest).toBeNull();
        expect(() => parseRunReport({ ...blank, rawManifest: 7 })).toThrow(/rawManifest: string-invalid/);
    });
});
