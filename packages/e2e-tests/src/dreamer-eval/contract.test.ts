import { describe, expect, test } from "bun:test";
import { VERIFY_UPDATE_CONTENT_MAX_LENGTH } from "../../../plugin/src/features/magic-context/dreamer/verify";
import { sha256Utf8Hex } from "../../../plugin/src/features/magic-context/memory/storage-claims";
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
                preconditions: {
                    mappings: claims.slice(0, 9).map((entry, index) => ({
                        claimId: entry.id,
                        files: [`src/file-${index + 1}.ts`],
                    })),
                    verifications: [],
                    classifiedClaimIds: [],
                },
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
        // cannot apply.
        expectDiagnostic((raw) => {
            const tasks = raw.tasks as Array<{ gold: { claims: Array<{ expectedFiles: string[] }> } }>;
            tasks[0]!.gold.claims[0]!.expectedFiles = ["src/ghost.ts"];
        }, "scenario.tasks[0].gold.claims[0].expectedFiles[0]: path-untracked");
        expectDiagnostic((raw) => {
            const tasks = raw.tasks as Array<{ gold: { claims: Array<{ files: string[] }> } }>;
            tasks[1]!.gold.claims[0]!.files = ["src/./file-1.ts"];
        }, "scenario.tasks[1].gold.claims[0].files[0]: path-untracked");
        const moved = validScenarioRaw();
        (moved.tasks as Array<{ gold: { claims: Array<{ expectedFiles: string[] }> } }>)[0]!.gold.claims[0]!.expectedFiles =
            ["src/file-2.ts"];
        expect(() => parseScenario(moved)).not.toThrow();
    });

    test("a mapping cannot name a path its claim does not declare", () => {
        expectDiagnostic((raw) => {
            const tasks = raw.tasks as Array<{ preconditions: { mappings: Array<{ files: string[] }> } }>;
            tasks[0]!.preconditions.mappings[0]!.files = ["src/file-2.ts"];
        }, "scenario.tasks[0].preconditions.mappings[0].files[0]: path-undeclared");
        const declared = validScenarioRaw();
        (declared.tasks as Array<{ preconditions: { mappings: Array<{ files: string[] }> } }>)[0]!.preconditions.mappings[0]!.files =
            ["src/file-1.ts"];
        expect(() => parseScenario(declared)).not.toThrow();
    });

    test("a required update anchor cannot exceed the production content cap", () => {
        expectDiagnostic((raw) => {
            const tasks = raw.tasks as Array<{
                gold: { claims: Array<{ verdict: string; requiredUpdateAnchors: string[] }> };
            }>;
            tasks[0]!.gold.claims[0]!.verdict = "update";
            tasks[0]!.gold.claims[0]!.requiredUpdateAnchors = ["a".repeat(VERIFY_UPDATE_CONTENT_MAX_LENGTH + 1)];
        }, "scenario.tasks[0].gold.claims[0].requiredUpdateAnchors[0]: anchor-exceeds-content-cap");
        expectDiagnostic((raw) => {
            const tasks = raw.tasks as Array<{
                gold: { claims: Array<{ verdict: string; requiredUpdateAnchors: string[] }> };
            }>;
            tasks[0]!.gold.claims[0]!.verdict = "update";
            tasks[0]!.gold.claims[0]!.requiredUpdateAnchors = [
                "a".repeat(VERIFY_UPDATE_CONTENT_MAX_LENGTH),
                "b".repeat(VERIFY_UPDATE_CONTENT_MAX_LENGTH),
            ];
        }, "scenario.tasks[0].gold.claims[0].requiredUpdateAnchors: anchors-exceed-content-cap");
        // budget.
        const withinCap = validScenarioRaw();
        const tasks = withinCap.tasks as Array<{
            gold: { claims: Array<{ verdict: string; requiredUpdateAnchors: string[] }> };
        }>;
        tasks[0]!.gold.claims[0]!.verdict = "update";
        tasks[0]!.gold.claims[0]!.requiredUpdateAnchors = [
            "a".repeat(VERIFY_UPDATE_CONTENT_MAX_LENGTH / 2),
            "b".repeat(VERIFY_UPDATE_CONTENT_MAX_LENGTH / 2),
        ];
        expect(() => parseScenario(withinCap)).not.toThrow();
        const overlapping = validScenarioRaw();
        (overlapping.tasks as Array<{
            gold: { claims: Array<{ verdict: string; requiredUpdateAnchors: string[] }> };
        }>)[0]!.gold.claims[0]!.verdict = "update";
        (overlapping.tasks as Array<{
            gold: { claims: Array<{ verdict: string; requiredUpdateAnchors: string[] }> };
        }>)[0]!.gold.claims[0]!.requiredUpdateAnchors = [
            `${"a".repeat(VERIFY_UPDATE_CONTENT_MAX_LENGTH - 1)}b`,
            `b${"a".repeat(VERIFY_UPDATE_CONTENT_MAX_LENGTH - 1)}`,
        ];
        expect(() => parseScenario(overlapping)).not.toThrow();
    });

    test("two claims cannot normalize to one stored claim", () => {
        // cardinality check.
        expectDiagnostic((raw) => {
            const claims = (raw.pool as { claims: Array<{ content: string; category: string }> }).claims;
            claims[1]!.content = `  ${claims[0]!.content.toUpperCase()}  `;
        }, "scenario.pool.claims.content: duplicate");
        const distinctCategory = validScenarioRaw();
        const claims = (distinctCategory.pool as { claims: Array<{ content: string; category: string }> }).claims;
        claims[1]!.content = claims[0]!.content.toUpperCase();
        claims[1]!.category = "PROJECT_FACT";
        expect(() => parseScenario(distinctCategory)).not.toThrow();
    });

    test("a classify task cannot skip any claim", () => {
        // The parser requires at least ten hygiene-visible claims.
        // The production gate selects every claim in pools of at least ten hygiene-visible claims.
        expectDiagnostic((raw) => {
            const tasks = raw.tasks as Array<{
                expectedInScopeClaimIds: string[];
                expectedSkippedClaimIds: string[];
                gold: { claims: Array<{ claimId: string }> };
            }>;
            const classify = tasks[2]!;
            const dropped = classify.expectedInScopeClaimIds.pop()!;
            classify.expectedSkippedClaimIds = [dropped];
            classify.gold.claims = classify.gold.claims.filter((claim) => claim.claimId !== dropped);
        }, "scenario.tasks[2].expectedSkippedClaimIds: classify-skips-nothing");
    });

    test("the verify partition is derived from mappings and verified outcomes", () => {
        // fixtureFiles alone does not seed a mapping.
        // The gate retains normal claims only when they have mapped files.
        expectDiagnostic((raw) => {
            const tasks = raw.tasks as Array<{ preconditions: { mappings: unknown[] } }>;
            tasks[0]!.preconditions.mappings = tasks[0]!.preconditions.mappings.slice(1);
        }, "scenario.tasks[0].expectedInScopeClaimIds: verify-scope-mismatch");
        expectDiagnostic((raw) => {
            const tasks = raw.tasks as Array<{ preconditions: { mappings: Array<{ files: string[] }> } }>;
            tasks[0]!.preconditions.mappings[0]!.files = [];
        }, "scenario.tasks[0].expectedInScopeClaimIds: verify-scope-mismatch");
        // A verified outcome excludes the claim from the gate's scope.
        // Keeping a verified claim in scope causes verify-scope-mismatch.
        expectDiagnostic((raw) => {
            const tasks = raw.tasks as Array<{ preconditions: { verifications: unknown[] } }>;
            tasks[0]!.preconditions.verifications = [
                { claimId: "claim-1", outcome: "verified", verifiedAt: 1_700_000_010_000 },
            ];
        }, "scenario.tasks[0].expectedInScopeClaimIds: verify-scope-mismatch");
        // Non-verified outcomes normalize verifiedAt to 0.
        // Claims with non-verified outcomes remain in scope.
        const notVerified = validScenarioRaw();
        (notVerified.tasks as Array<{ preconditions: { verifications: unknown[] } }>)[0]!.preconditions.verifications =
            [{ claimId: "claim-1", outcome: "update", verifiedAt: 1_700_000_010_000 }];
        expect(() => parseScenario(notVerified)).not.toThrow();
    });

    test("a map task cannot skip a claim with no seeded baseline", () => {
        // selectMapMemoryInputs always selects claims without baselines.
        // Only mapping preconditions create baselines.
        expectDiagnostic((raw) => {
            const tasks = raw.tasks as Array<{
                expectedInScopeClaimIds: string[];
                expectedSkippedClaimIds: string[];
                gold: { claims: Array<{ claimId: string }> };
            }>;
            const map = tasks[1]!;
            const dropped = map.expectedInScopeClaimIds.pop()!;
            map.expectedSkippedClaimIds = [dropped];
            map.gold.claims = map.gold.claims.filter((claim) => claim.claimId !== dropped);
        }, "scenario.tasks[1].expectedSkippedClaimIds[0]: map-scope-unmapped");
    });

    test("a classify task cannot seed a disposition the hygiene surface hides", () => {
        // Stale outcomes set the stale disposition; flagged outcomes set the disputed disposition.
        // maintenance_hygiene admits claims only when stale and disputed dispositions are clear.
        for (const outcome of ["stale", "flagged"]) {
            expectDiagnostic((raw) => {
                const tasks = raw.tasks as Array<{ preconditions: { verifications: unknown[] } }>;
                tasks[2]!.preconditions.verifications = [
                    { claimId: "claim-1", outcome, verifiedAt: 1_700_000_010_000 },
                ];
            }, "scenario.tasks[2].preconditions.verifications[0].outcome: classify-hidden-disposition");
        }
        // Verify tasks may seed stale and disputed dispositions because the verification lane reads both.
        const onVerify = validScenarioRaw();
        (onVerify.tasks as Array<{ preconditions: { verifications: unknown[] } }>)[0]!.preconditions.verifications = [
            { claimId: "claim-1", outcome: "stale", verifiedAt: 1_700_000_010_000 },
        ];
        expect(() => parseScenario(onVerify)).not.toThrow();
    });

    test("a required update anchor cannot hold the root closing tag", () => {
        // Only the root tag is unsatisfiable because body extraction matches it case-insensitively.
        // Every root-tag spelling truncates the body.
        // Case-sensitive entry-construct matching lets an inert spelling carry entry constructs.
        const inert = validScenarioRaw();
        const inertTasks = inert.tasks as Array<{
            gold: { claims: Array<{ verdict: string; requiredUpdateAnchors: string[] }> };
        }>;
        inertTasks[0]!.gold.claims[0]!.verdict = "update";
        inertTasks[0]!.gold.claims[0]!.requiredUpdateAnchors = ["facts</update>more"];
        expect(() => parseScenario(inert)).not.toThrow();
        const opener = validScenarioRaw();
        const openerTasks = opener.tasks as Array<{
            gold: { claims: Array<{ verdict: string; requiredUpdateAnchors: string[] }> };
        }>;
        openerTasks[0]!.gold.claims[0]!.verdict = "update";
        openerTasks[0]!.gold.claims[0]!.requiredUpdateAnchors = ['<verified claim="ghost" files="x"/>'];
        expect(() => parseScenario(opener)).not.toThrow();
        // Root extraction runs first and matches root close tags case-insensitively.
        // Any root close-tag spelling truncates the body.
        for (const anchor of ["facts</verify>more", "facts</VERIFY>more", "facts</Verify>more"]) {
            expectDiagnostic((raw) => {
                const tasks = raw.tasks as Array<{
                    gold: { claims: Array<{ verdict: string; requiredUpdateAnchors: string[] }> };
                }>;
                tasks[0]!.gold.claims[0]!.verdict = "update";
                tasks[0]!.gold.claims[0]!.requiredUpdateAnchors = [anchor];
            }, "scenario.tasks[0].gold.claims[0].requiredUpdateAnchors[0]: anchor-holds-root-close-tag");
        }
    });

    test("a fixture path cannot carry a NUL byte", () => {
        // fixture-drift path.
        expectDiagnostic((raw) => {
            (raw.pool as { claims: Array<{ fixtureFiles: Array<{ path: string }> }> }).claims[0]!.fixtureFiles[0]!.path =
                "src/a\0.ts";
        }, "scenario.pool.claims[0].fixtureFiles[0].path: path-unrepresentable");
    });

    test("a verification timestamp must stay inside git's accepted date range", () => {
        expectDiagnostic((raw) => {
            const tasks = raw.tasks as Array<{ preconditions: { verifications: unknown[] } }>;
            tasks[0]!.preconditions.verifications = [
                { claimId: "claim-1", outcome: "verified", verifiedAt: Number.MAX_SAFE_INTEGER },
            ];
        }, "scenario.tasks[0].preconditions.verifications[0].verifiedAt: integer-invalid");
        expectDiagnostic((raw) => {
            const tasks = raw.tasks as Array<{ preconditions: { verifications: unknown[] } }>;
            tasks[0]!.preconditions.verifications = [
                { claimId: "claim-1", outcome: "update", verifiedAt: 4_102_444_802_000 },
            ];
        }, "scenario.tasks[0].preconditions.verifications[0].verifiedAt: integer-invalid");
        const atLimit = validScenarioRaw();
        (atLimit.tasks as Array<{ preconditions: { verifications: unknown[] } }>)[0]!.preconditions.verifications = [
            { claimId: "claim-1", outcome: "update", verifiedAt: 4_102_444_801_999 },
        ];
        expect(() => parseScenario(atLimit)).not.toThrow();
    });

    test("a map task cannot claim a mapped claim is in scope", () => {
        // shouldRequeueIndependentMapping requires an empty mapping sentinel.
        // Claims with mapped files never return to map scope.
        expectDiagnostic((raw) => {
            const tasks = raw.tasks as Array<{ preconditions: { mappings: unknown[] } }>;
            tasks[1]!.preconditions.mappings = [{ claimId: "claim-1", files: ["src/file-1.ts"] }];
        }, "scenario.tasks[1].expectedInScopeClaimIds[0]: map-scope-already-mapped");
        // An empty mapping remains ambiguous because requeue checks claim content and repository state; the claim may be in map scope or skipped scope.
        // Requeue checks claim content and repository state, so either partition is admissible.
        const sentinel = validScenarioRaw();
        (sentinel.tasks as Array<{ preconditions: { mappings: unknown[] } }>)[1]!.preconditions.mappings = [
            { claimId: "claim-1", files: [] },
        ];
        expect(() => parseScenario(sentinel)).not.toThrow();
    });

    test("a verify task must declare the one result mode the seeder can produce", () => {
        // The gate returns full only when Git change times are unavailable.
        // The seeder treats unavailable Git change times as fixture drift.
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
        // The seeder sets the commit time to the earliest verification time minus 2,000 ms.
        // The seeder rejects a non-positive commit time as fixture drift.
        expectDiagnostic((raw) => {
            const tasks = raw.tasks as Array<{ preconditions: { verifications: unknown[] } }>;
            tasks[0]!.preconditions.verifications = [
                { claimId: "claim-1", outcome: "verified", verifiedAt: 2_000 },
            ];
        }, "scenario.tasks[0].preconditions.verifications[0].verifiedAt: integer-invalid");
        const seedable = validScenarioRaw();
        (seedable.tasks as Array<{ preconditions: { verifications: unknown[] } }>)[0]!.preconditions.verifications = [
            { claimId: "claim-1", outcome: "update", verifiedAt: 2_001 },
        ];
        expect(() => parseScenario(seedable)).not.toThrow();
    });

    test("classify gold cannot request shareable for content production forces private", () => {
        // `applyClassifications` changes reported `shareable: true` to `false` for local-run endpoint content; otherwise the model scores PASS while the stored claim is private.
        expectDiagnostic((raw) => {
            const claims = (raw.pool as { claims: Array<{ content: string; sharing: string }> }).claims;
            claims[0]!.content = "The provider answers on 127.0.0.1:8080 during local runs.";
            claims[0]!.sharing = "private";
        }, "scenario.tasks[2].gold.claims[0].shareable: shareability-override");
        // Omitting the field preserves shareable on an already-shareable sensitive claim, so the expected gold remains achievable.
        const alreadyShareable = validScenarioRaw();
        const claims = (alreadyShareable.pool as { claims: Array<{ content: string; sharing: string }> }).claims;
        claims[0]!.content = "The provider answers on 127.0.0.1:8080 during local runs.";
        claims[0]!.sharing = "shareable";
        expect(() => parseScenario(alreadyShareable)).not.toThrow();
    });
});

// Production storage identities use `mcm_` plus 32 lowercase hexadecimal characters; locators embed that ID, a positive revision, and a SHA-256 digest.
const CLAIM_ONE_ID = `mcm_${"1".repeat(32)}`;
const CLAIM_TWO_ID = `mcm_${"2".repeat(32)}`;
// The locator's third segment is the revision content hash.
function locatorFor(publicClaimId: string, content: string): string {
    return `${publicClaimId}/r1/${sha256Utf8Hex(content)}`;
}

const SNAPSHOT_CONTENT = "Distinct memory content";
const CLAIM_ONE_LOCATOR = locatorFor(CLAIM_ONE_ID, SNAPSHOT_CONTENT);
const CLAIM_TWO_LOCATOR = locatorFor(CLAIM_TWO_ID, SNAPSHOT_CONTENT);

// Completed reports include the full scenario pool of at least 10 claims.
function poolSnapshot(index: number): Record<string, unknown> {
    const publicClaimId = `mcm_${(index + 1).toString(16).padStart(2, "0").repeat(16)}`;
    const content = `Distinct memory content ${index + 1}`;
    return {
        claimId: `claim-${index + 1}`,
        publicClaimId,
        revisionLocator: locatorFor(publicClaimId, content),
        content,
        category: "CONSTRAINTS",
        importance: 50,
        memoryScope: "project",
        sharing: "private",
        lifecycleState: "active",
        files: ["src/a.ts"],
        verificationOutcome: null,
    };
}

const POOL_CAPTURE = Array.from({ length: 10 }, (_, index) => poolSnapshot(index));
const OBSERVED_ID = POOL_CAPTURE[0]!.publicClaimId as string;
const CLASSIFY_EVIDENCE = POOL_CAPTURE.map((claim) => ({
    publicClaimId: claim.publicClaimId as string,
    scope: "project",
}));
const VERIFY_EVIDENCE = {
    verified: [{ publicClaimId: OBSERVED_ID, files: ["src/a.ts"] }],
    updated: [],
    archived: [],
};

/* */
function rawVerify(evidence: typeof VERIFY_EVIDENCE): string {
    const lines = evidence.verified.map(
        (entry) => `<verified claim="${entry.publicClaimId}" files="${entry.files.join(",")}"/>`,
    );
    return `<verify>\n${lines.join("\n")}\n</verify>`;
}

function rawMap(evidence: Array<{ publicClaimId: string; files: string[]; independent: boolean }>): string {
    const lines = evidence.map((entry) =>
        entry.independent
            ? `<memory claim="${entry.publicClaimId}" independent="true"/>`
            : `<memory claim="${entry.publicClaimId}" files="${entry.files.join(",")}"/>`,
    );
    return `<mappings>\n${lines.join("\n")}\n</mappings>`;
}

function rawClassify(evidence: Array<{ publicClaimId: string; scope: string }>): string {
    const lines = evidence.map((entry) => `<memory claim="${entry.publicClaimId}" scope="${entry.scope}"/>`);
    return `<classify>\n${lines.join("\n")}\n</classify>`;
}

/* */
function captureWithFirst(overrides: Record<string, unknown>): Array<Record<string, unknown>> {
    return POOL_CAPTURE.map((claim, index) => (index === 0 ? { ...claim, ...overrides } : claim));
}

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
        poolBefore: POOL_CAPTURE,
        poolAfter: POOL_CAPTURE,
        rawManifest: rawVerify(VERIFY_EVIDENCE),
        parsedManifest: VERIFY_EVIDENCE,
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
        // Verify emits one verdict-list record; map and classify emit one entry per claim, so a record-only report cannot contain evidence from two scorers.
        const mapShape = [{ publicClaimId: OBSERVED_ID, files: ["src/a.ts"], independent: false }];
        expect(
            parseRunReport({
                ...baseReport,
                task: "map-memories",
                rawManifest: rawMap(mapShape),
                parsedManifest: mapShape,
            }).parsedManifest,
        ).toEqual(mapShape);
        const verifyShape = VERIFY_EVIDENCE;
        expect(parseRunReport({ ...baseReport, parsedManifest: verifyShape }).parsedManifest).toEqual(verifyShape);
        // A run without evidence failed before scoring, so null `rawManifest` and `parsedManifest` require an ERROR report; PASS requires both.
        expect(
            parseRunReport({ ...baseReport, status: "ERROR", reason: "harness-failure", parsedManifest: null })
                .parsedManifest,
        ).toBeNull();
        expect(() =>
            parseRunReport({ ...baseReport, task: "map-memories", parsedManifest: ["not-a-record"] }),
        ).toThrow(/parsedManifest\[0\]: object-required/);
        expect(() => parseRunReport({ ...baseReport, parsedManifest: "not-a-manifest" })).toThrow(
            /parsedManifest: object-required/,
        );
        expect(() => parseRunReport({ ...baseReport, parsedManifest: {} })).toThrow(
            /parsedManifest: fields-invalid/,
        );
        expect(() =>
            parseRunReport({ ...baseReport, parsedManifest: { verified: [], updated: [], archived: [] } }),
        ).toThrow(/parsedManifest: evidence-empty/);
        expect(() => parseRunReport({ ...baseReport, task: "map-memories", parsedManifest: [] })).toThrow(
            /parsedManifest: evidence-empty/,
        );
        expect(() =>
            parseRunReport({
                ...baseReport,
                parsedManifest: {
                    verified: [{ publicClaimId: CLAIM_TWO_ID, files: ["src/a.ts"] }],
                    updated: [],
                    archived: [],
                },
            }),
        ).toThrow(/verified\[0\].publicClaimId: unobserved-claim/);
    });

    test("a report snapshot array cannot repeat a claim", () => {
        const snapshot = {
            claimId: "claim-1",
            publicClaimId: CLAIM_ONE_ID,
            revisionLocator: CLAIM_ONE_LOCATOR,
            content: SNAPSHOT_CONTENT,
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
        // A one-claim capture is valid only for a run that failed before observing the full 10-claim pool.
        expect(
            parseRunReport({
                ...baseReport,
                status: "ERROR",
                reason: "harness-failure",
                poolBefore: [snapshot],
                poolAfter: [snapshot],
            }).poolBefore,
        ).toHaveLength(1);
    });

    test("a completed report cannot change which claims it observed", () => {
        const snapshot = {
            claimId: "claim-1",
            publicClaimId: CLAIM_ONE_ID,
            revisionLocator: CLAIM_ONE_LOCATOR,
            content: SNAPSHOT_CONTENT,
            category: "CONSTRAINTS",
            importance: 50,
            memoryScope: "project",
            sharing: "private",
            lifecycleState: "active",
            files: ["src/a.ts"],
            verificationOutcome: null,
        };
        // Tasks never create, delete, or rekey claims; omitted or rebound identities corrupt before/after comparisons.
        // observation.
        expect(() => parseRunReport({ ...baseReport, poolAfter: POOL_CAPTURE.slice(1) })).toThrow(
            /poolAfter: identity-drift/,
        );
        expect(() =>
            parseRunReport({
                ...baseReport,
                poolAfter: captureWithFirst({
                    publicClaimId: CLAIM_TWO_ID,
                    revisionLocator: locatorFor(CLAIM_TWO_ID, POOL_CAPTURE[0]!.content as string),
                }),
            }),
        ).toThrow(/poolAfter: identity-drift/);
        expect(() =>
            parseRunReport({
                ...baseReport,
                status: "FAIL",
                reason: "wrong-verdict",
                poolAfter: captureWithFirst({
                    claimId: "claim-99",
                    publicClaimId: CLAIM_TWO_ID,
                    revisionLocator: locatorFor(CLAIM_TWO_ID, POOL_CAPTURE[0]!.content as string),
                }),
            }),
        ).toThrow(/poolAfter: identity-drift/);
        // Archival changes `lifecycleState` without changing claim identity.
        // drift.
        expect(
            parseRunReport({ ...baseReport, poolAfter: captureWithFirst({ lifecycleState: "archived" }) })
                .poolAfter[0]?.lifecycleState,
        ).toBe("archived");
        // An ERROR run may have failed before capturing the pool.
        expect(
            parseRunReport({
                ...baseReport,
                status: "ERROR",
                reason: "harness-failure",
                poolBefore: [snapshot],
                poolAfter: [],
            }).poolAfter,
        ).toHaveLength(0);
    });

    test("a snapshot must carry storage identities production can produce", () => {
        const snapshot = {
            claimId: "claim-1",
            publicClaimId: CLAIM_ONE_ID,
            revisionLocator: CLAIM_ONE_LOCATOR,
            content: SNAPSHOT_CONTENT,
            category: "CONSTRAINTS",
            importance: 50,
            memoryScope: "project",
            sharing: "private",
            lifecycleState: "active",
            files: ["src/a.ts"],
            verificationOutcome: null,
        };
        const parse = (overrides: Record<string, unknown>) =>
            parseRunReport({
                ...baseReport,
                poolBefore: captureWithFirst(overrides),
                poolAfter: captureWithFirst(overrides),
            });
        expect(() => parse({ publicClaimId: "mcm_one" })).toThrow(/publicClaimId: id-invalid/);
        expect(() => parse({ publicClaimId: `mcm_${"A".repeat(32)}` })).toThrow(/publicClaimId: id-invalid/);
        expect(() => parse({ revisionLocator: `${CLAIM_ONE_ID}@1` })).toThrow(/revisionLocator: locator-invalid/);
        expect(() => parse({ revisionLocator: `${CLAIM_ONE_ID}/r0/${"a".repeat(64)}` })).toThrow(
            /revisionLocator: locator-invalid/,
        );
        // A locator must embed its own claim ID; a locator naming another claim is invalid.
        // A revisionLocator whose claim ID differs from publicClaimId is rejected even when both IDs are valid.
        expect(() => parse({ revisionLocator: CLAIM_TWO_LOCATOR })).toThrow(
            /revisionLocator: locator-claim-mismatch/,
        );
        // A revisionLocator digest must match the revision content hash.
        expect(() => parse({ revisionLocator: `${OBSERVED_ID}/r1/${"c".repeat(64)}` })).toThrow(
            /revisionLocator: locator-digest-mismatch/,
        );
        expect(parse({}).poolBefore).toHaveLength(POOL_CAPTURE.length);
    });

    test("a passing report must carry the evidence it was scored from", () => {
        // A PASS report requires a nonblank rawManifest and parsedManifest.
        expect(() => parseRunReport({ ...baseReport, rawManifest: null })).toThrow(
            /parsedManifest: pass-requires-evidence/,
        );
        expect(() => parseRunReport({ ...baseReport, parsedManifest: null })).toThrow(
            /parsedManifest: pass-requires-evidence/,
        );
        // Blank rawManifest values cannot support PASS because scorers classify them as ERROR:provider-failure.
        expect(() => parseRunReport({ ...baseReport, rawManifest: "   " })).toThrow(
            /parsedManifest: pass-requires-evidence/,
        );
        expect(
            parseRunReport({
                ...baseReport,
                status: "ERROR",
                reason: "provider-failure",
                rawManifest: "   ",
                parsedManifest: null,
            }).rawManifest,
        ).toBe("   ");
        // An ERROR run may omit both `rawManifest` and `parsedManifest`.
        expect(
            parseRunReport({
                ...baseReport,
                status: "ERROR",
                reason: "provider-failure",
                rawManifest: null,
                parsedManifest: null,
            }).rawManifest,
        ).toBeNull();
    });

    test("a failure reason must be one its task's scorer can produce", () => {
        // The map scorer permits only wrong-independence, wrong-mapping, and invalid-output.
        expect(() =>
            parseRunReport({
                ...baseReport,
                task: "map-memories",
                status: "FAIL",
                reason: "wrong-archival",
                runFatal: true,
            }),
        ).toThrow(/reason: task-reason-mismatch/);
        expect(() =>
            parseRunReport({
                ...baseReport,
                task: "classify-memories",
                status: "FAIL",
                reason: "wrong-verdict",
            }),
        ).toThrow(/reason: task-reason-mismatch/);
        expect(
            parseRunReport({
                ...baseReport,
                task: "map-memories",
                status: "FAIL",
                reason: "wrong-independence",
                rawManifest: rawMap([{ publicClaimId: OBSERVED_ID, files: ["src/a.ts"], independent: false }]),
                parsedManifest: [{ publicClaimId: OBSERVED_ID, files: ["src/a.ts"], independent: false }],
            }).reason,
        ).toBe("wrong-independence");
    });

    test("a failing report must carry the evidence it was scored from", () => {
        // All scorer failures require a nonblank rawManifest; only invalid-output may omit parsedManifest.
        const failing = { ...baseReport, status: "FAIL", reason: "wrong-verdict" };
        expect(() => parseRunReport({ ...failing, rawManifest: null })).toThrow(
            /rawManifest: fail-requires-evidence/,
        );
        expect(() => parseRunReport({ ...failing, rawManifest: "  " })).toThrow(
            /rawManifest: fail-requires-evidence/,
        );
        // Reports cannot include parsedManifest without rawManifest.
        expect(() =>
            parseRunReport({
                ...baseReport,
                status: "ERROR",
                reason: "apply-not-applied",
                rawManifest: null,
            }),
        ).toThrow(/rawManifest: evidence-without-bytes/);
        expect(() => parseRunReport({ ...failing, parsedManifest: null })).toThrow(
            /parsedManifest: fail-requires-evidence/,
        );
        // An invalid-output report omits parsedManifest because validation failed before parsing.
        const rejected = { ...baseReport, status: "FAIL", reason: "invalid-output", rawManifest: "<verify>" };
        expect(parseRunReport({ ...rejected, parsedManifest: null }).parsedManifest).toBeNull();
        // result exists.
        expect(() => parseRunReport(rejected)).toThrow(/parsedManifest: invalid-output-has-evidence/);
        // An invalid-output report may retain structurally parseable rawManifest when validation rejects its expected-ID coverage.
        expect(
            parseRunReport({ ...baseReport, status: "FAIL", reason: "invalid-output", parsedManifest: null }).reason,
        ).toBe("invalid-output");
    });

    test("evidence entries must carry the fields their scorer emits", () => {
        // classification field.
        expect(() =>
            parseRunReport({ ...baseReport, task: "map-memories", parsedManifest: [{ publicClaimId: OBSERVED_ID }] }),
        ).toThrow(/parsedManifest\[0\]: fields-invalid/);
        expect(() =>
            parseRunReport({
                ...baseReport,
                parsedManifest: { verified: [{ publicClaimId: OBSERVED_ID }], updated: [], archived: [] },
            }),
        ).toThrow(/parsedManifest.verified\[0\]: fields-invalid/);
        expect(() =>
            parseRunReport({
                ...baseReport,
                parsedManifest: {
                    verified: [],
                    updated: [{ publicClaimId: OBSERVED_ID, files: ["src/a.ts"] }],
                    archived: [],
                },
            }),
        ).toThrow(/parsedManifest.updated\[0\]: fields-invalid/);
        expect(() =>
            parseRunReport({
                ...baseReport,
                task: "classify-memories",
                parsedManifest: CLASSIFY_EVIDENCE.map((entry, index) =>
                    index === 0 ? { publicClaimId: entry.publicClaimId } : entry,
                ),
            }),
        ).toThrow(/parsedManifest\[0\]: classification-empty/);
        expect(
            parseRunReport({
                ...baseReport,
                task: "classify-memories",
                rawManifest: rawClassify(CLASSIFY_EVIDENCE),
                parsedManifest: CLASSIFY_EVIDENCE,
            }).parsedManifest,
        ).toEqual(CLASSIFY_EVIDENCE);
        // Classify validation requires evidence for every observed ID.
        expect(() =>
            parseRunReport({
                ...baseReport,
                task: "classify-memories",
                parsedManifest: CLASSIFY_EVIDENCE.slice(0, 1),
            }),
        ).toThrow(/parsedManifest: coverage-incomplete/);
    });

    test("an anchor's own edge whitespace costs a character on each side", () => {
        // The parser preserves anchor-edge whitespace only when a non-whitespace character remains outside the anchor.
        expectDiagnostic((raw) => {
            const tasks = raw.tasks as Array<{
                gold: { claims: Array<{ verdict: string; requiredUpdateAnchors: string[] }> };
            }>;
            tasks[0]!.gold.claims[0]!.verdict = "update";
            tasks[0]!.gold.claims[0]!.requiredUpdateAnchors = [
                ` ${"a".repeat(VERIFY_UPDATE_CONTENT_MAX_LENGTH - 2)} `,
            ];
        }, "scenario.tasks[0].gold.claims[0].requiredUpdateAnchors[0]: anchor-exceeds-content-cap");
        const fits = validScenarioRaw();
        const tasks = fits.tasks as Array<{
            gold: { claims: Array<{ verdict: string; requiredUpdateAnchors: string[] }> };
        }>;
        tasks[0]!.gold.claims[0]!.verdict = "update";
        tasks[0]!.gold.claims[0]!.requiredUpdateAnchors = [
            ` ${"a".repeat(VERIFY_UPDATE_CONTENT_MAX_LENGTH - 4)} `,
        ];
        expect(() => parseScenario(fits)).not.toThrow();
    });

    test("a required anchor's capacity is measured before case folding", () => {
        // The parser measures the body before lowercasing: `"İ".toLowerCase()` has two code units, so lowercasing first rejects a body that fits.
        const expanding = validScenarioRaw();
        const tasks = expanding.tasks as Array<{
            gold: { claims: Array<{ verdict: string; requiredUpdateAnchors: string[] }> };
        }>;
        tasks[0]!.gold.claims[0]!.verdict = "update";
        tasks[0]!.gold.claims[0]!.requiredUpdateAnchors = ["\u0130".repeat(11_000)];
        expect(() => parseScenario(expanding)).not.toThrow();
    });

    test("parsed evidence must reproduce from the captured bytes", () => {
        // `parsedManifest` must match the evidence parsed from `rawManifest`.
        expect(() =>
            parseRunReport({ ...baseReport, rawManifest: "<verify></verify>" }),
        ).toThrow(/parsedManifest: evidence-mismatch/);
        expect(() =>
            parseRunReport({
                ...baseReport,
                parsedManifest: {
                    ...VERIFY_EVIDENCE,
                    verified: [{ publicClaimId: OBSERVED_ID, files: ["src/other.ts"] }],
                },
            }),
        ).toThrow(/parsedManifest: evidence-mismatch/);
        // `parsedManifest` cannot supply evidence unless the parser accepts `rawManifest`.
        expect(() => parseRunReport({ ...baseReport, rawManifest: "<verify>" })).toThrow(
            /rawManifest: evidence-unparseable/,
        );
        // The `parsedManifest` comparison ignores object key order.
        expect(
            parseRunReport({
                ...baseReport,
                parsedManifest: {
                    archived: [],
                    updated: [],
                    verified: [{ files: ["src/a.ts"], publicClaimId: OBSERVED_ID }],
                },
            }).status,
        ).toBe("PASS");
    });

    test("a receipt cannot name a claim the run never observed", () => {
        const receipt = { claimId: "claim-1", operation: "verify", outcome: "applied" };
        expect(parseRunReport({ ...baseReport, receiptOutcomes: [receipt] }).receiptOutcomes).toHaveLength(1);
        expect(() =>
            parseRunReport({ ...baseReport, receiptOutcomes: [{ ...receipt, claimId: "claim-999" }] }),
        ).toThrow(/receiptOutcomes\[0\].claimId: unobserved-claim/);
        // ERROR reports may use a partial capture.
        expect(
            parseRunReport({
                ...baseReport,
                status: "ERROR",
                reason: "gate-mismatch",
                poolBefore: [],
                poolAfter: [],
                rawManifest: null,
                parsedManifest: null,
                receiptOutcomes: [{ ...receipt, claimId: "claim-999" }],
            }).receiptOutcomes,
        ).toHaveLength(1);
    });

    test("a passing report's archive must show in the after capture", () => {
        // A PASS applied its manifest, so an archived claim cannot still be active.
        const archiving = {
            verified: [],
            updated: [],
            archived: [{ publicClaimId: OBSERVED_ID, reason: "queue removed" }],
        };
        const raw = `<verify>\n<archive claim="${OBSERVED_ID}" reason="queue removed"/>\n</verify>`;
        expect(() =>
            parseRunReport({ ...baseReport, rawManifest: raw, parsedManifest: archiving }),
        ).toThrow(/poolAfter: archive-not-applied\[0\]/);
        expect(
            parseRunReport({
                ...baseReport,
                rawManifest: raw,
                parsedManifest: archiving,
                poolAfter: captureWithFirst({ lifecycleState: "archived" }),
            }).status,
        ).toBe("PASS");
    });

    test("a capture cannot hold two active claims with one identity", () => {
        // The modified first claim collides with the second claim's normalized content, so duplicate detection must reject it.
        const collidingFirst = () => {
            const content = `  ${POOL_CAPTURE[1]!.content as string}  `;
            return { content, revisionLocator: locatorFor(OBSERVED_ID, content) };
        };
        // `assertNoLiveDuplicate` rejects duplicate active identities; otherwise, a ledger would retain only one owner.
        expect(() =>
            parseRunReport({
                ...baseReport,
                poolBefore: captureWithFirst(collidingFirst()),
                poolAfter: captureWithFirst(collidingFirst()),
            }),
        ).toThrow(/poolBefore.content: duplicate/);
        // Archived claims may share identities because `assertNoLiveDuplicate` checks only active rows.
        expect(
            parseRunReport({
                ...baseReport,
                poolBefore: captureWithFirst({ ...collidingFirst(), lifecycleState: "archived" }),
                poolAfter: captureWithFirst({ ...collidingFirst(), lifecycleState: "archived" }),
            }).poolBefore,
        ).toHaveLength(POOL_CAPTURE.length);
    });

    test("a wrong-result-mode error belongs only to a verify task", () => {
        // Only `verify` can produce `wrong-result-mode`.
        for (const task of ["map-memories", "classify-memories"]) {
            expect(() =>
                parseRunReport({
                    ...baseReport,
                    task,
                    status: "ERROR",
                    reason: "wrong-result-mode",
                    rawManifest: null,
                    parsedManifest: null,
                }),
            ).toThrow(/reason: task-reason-mismatch/);
        }
        expect(
            parseRunReport({
                ...baseReport,
                status: "ERROR",
                reason: "wrong-result-mode",
                rawManifest: null,
                parsedManifest: null,
            }).reason,
        ).toBe("wrong-result-mode");
    });

    test("a task that selects nothing cannot produce an artifact", () => {
        // When a gate selects no inputs, production returns immediately and scores no manifest.
        expectDiagnostic((raw) => {
            const tasks = raw.tasks as Array<{
                preconditions: { mappings: unknown[] };
                expectedInScopeClaimIds: string[];
                expectedSkippedClaimIds: string[];
                gold: { claims: unknown[] };
            }>;
            const verify = tasks[0]!;
            verify.preconditions.mappings = [];
            verify.expectedSkippedClaimIds = [...verify.expectedInScopeClaimIds, ...verify.expectedSkippedClaimIds];
            verify.expectedInScopeClaimIds = [];
            verify.gold.claims = [];
        }, "scenario.tasks[0].expectedInScopeClaimIds: scope-empty");
    });

    test("a completed report must capture the scenario pool", () => {
        // Empty captures satisfy binding equality.
        expect(() => parseRunReport({ ...baseReport, poolBefore: [], poolAfter: [] })).toThrow(
            /poolBefore: pool-capture-incomplete/,
        );
        expect(() =>
            parseRunReport({
                ...baseReport,
                poolBefore: POOL_CAPTURE.slice(0, 9),
                poolAfter: POOL_CAPTURE.slice(0, 9),
            }),
        ).toThrow(/poolBefore: pool-capture-incomplete/);
        // ERROR runs may omit pool captures.
        expect(
            parseRunReport({
                ...baseReport,
                status: "ERROR",
                reason: "gate-mismatch",
                poolBefore: [],
                poolAfter: [],
            }).poolBefore,
        ).toHaveLength(0);
    });

    test("an empty aggregation is not a pass", () => {
        expect(dreamerEvalExitCode([])).toBe(1);
        expect(dreamerEvalExitCode([parseRunReport(baseReport)])).toBe(0);
    });

    test("a commit sha must be a full object id, not an intermediate length", () => {
        // A source revision must contain either 40 hexadecimal characters for SHA-1 or 64 for SHA-256.
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
        // A blank `rawManifest` remains distinct from `null`.
        const blank = {
            ...baseReport,
            status: "ERROR",
            reason: "provider-failure",
            rawManifest: "   ",
            parsedManifest: null,
        };
        expect(parseRunReport(blank).rawManifest).toBe("   ");
        expect(parseRunReport({ ...blank, rawManifest: "" }).rawManifest).toBe("");
        expect(parseRunReport({ ...blank, rawManifest: null }).rawManifest).toBeNull();
        expect(() => parseRunReport({ ...blank, rawManifest: 7 })).toThrow(/rawManifest: string-invalid/);
    });
});
