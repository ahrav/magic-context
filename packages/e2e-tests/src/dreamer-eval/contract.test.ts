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
                    // The gate keeps a normal claim only when it has mapped
                    // files, and only an explicit precondition seeds one.
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
            const tasks = raw.tasks as Array<{ preconditions: { mappings: Array<{ files: string[] }> } }>;
            // Retarget claim-1's own mapping rather than replacing the array, so
            // every in-scope claim stays mapped and the path rule is what fails.
            tasks[0]!.preconditions.mappings[0]!.files = ["src/file-2.ts"];
        }, "scenario.tasks[0].preconditions.mappings[0].files[0]: path-undeclared");
        const declared = validScenarioRaw();
        (declared.tasks as Array<{ preconditions: { mappings: Array<{ files: string[] }> } }>)[0]!.preconditions.mappings[0]!.files =
            ["src/file-1.ts"];
        expect(() => parseScenario(declared)).not.toThrow();
    });

    test("a required update anchor cannot exceed the production content cap", () => {
        // Passing content must contain the anchor as a substring, so it is at
        // least as long as the anchor, and both the scorer and production reject
        // an update body over the cap. No manifest can satisfy such gold.
        expectDiagnostic((raw) => {
            const tasks = raw.tasks as Array<{
                gold: { claims: Array<{ verdict: string; requiredUpdateAnchors: string[] }> };
            }>;
            tasks[0]!.gold.claims[0]!.verdict = "update";
            tasks[0]!.gold.claims[0]!.requiredUpdateAnchors = ["a".repeat(VERIFY_UPDATE_CONTENT_MAX_LENGTH + 1)];
        }, "scenario.tasks[0].gold.claims[0].requiredUpdateAnchors[0]: anchor-exceeds-content-cap");
        // Two anchors that cannot overlap need a body at least as long as their
        // sum, so a pair at the cap is jointly impossible even though each passes
        // on its own.
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
        // A pair whose disjoint sum fits still parses, and so does one that only
        // fits by overlapping — the bound is a proof of impossibility, not a
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
        // Claim creation dedupes on (project, category, normalized content hash),
        // so these collapse into one row and the seeder aborts on its public-id
        // cardinality check.
        expectDiagnostic((raw) => {
            const claims = (raw.pool as { claims: Array<{ content: string; category: string }> }).claims;
            claims[1]!.content = `  ${claims[0]!.content.toUpperCase()}  `;
        }, "scenario.pool.claims.content: duplicate");
        // The identity includes the category, so the same content under a
        // different category is two distinct claims.
        const distinctCategory = validScenarioRaw();
        const claims = (distinctCategory.pool as { claims: Array<{ content: string; category: string }> }).claims;
        claims[1]!.content = claims[0]!.content.toUpperCase();
        claims[1]!.category = "PROJECT_FACT";
        expect(() => parseScenario(distinctCategory)).not.toThrow();
    });

    test("a classify task cannot skip any claim", () => {
        // Classify reads the hygiene surface, which returns every active row, and
        // parsing already forces every claim hygiene-visible with a pool of at
        // least ten, so the production gate always selects the whole pool.
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
        // Declaring fixtureFiles does not seed a mapping, and the gate keeps a
        // normal claim only when it has mapped files.
        expectDiagnostic((raw) => {
            const tasks = raw.tasks as Array<{ preconditions: { mappings: unknown[] } }>;
            tasks[0]!.preconditions.mappings = tasks[0]!.preconditions.mappings.slice(1);
        }, "scenario.tasks[0].expectedInScopeClaimIds: verify-scope-mismatch");
        expectDiagnostic((raw) => {
            const tasks = raw.tasks as Array<{ preconditions: { mappings: Array<{ files: string[] }> } }>;
            tasks[0]!.preconditions.mappings[0]!.files = [];
        }, "scenario.tasks[0].expectedInScopeClaimIds: verify-scope-mismatch");
        // A verified outcome makes the gate skip that claim, so leaving it in
        // scope is the same mismatch.
        expectDiagnostic((raw) => {
            const tasks = raw.tasks as Array<{ preconditions: { verifications: unknown[] } }>;
            tasks[0]!.preconditions.verifications = [
                { claimId: "claim-1", outcome: "verified", verifiedAt: 1_700_000_010_000 },
            ];
        }, "scenario.tasks[0].expectedInScopeClaimIds: verify-scope-mismatch");
        // Any other outcome leaves `verifiedAt` at zero, so the claim stays in
        // scope and the same scenario parses.
        const notVerified = validScenarioRaw();
        (notVerified.tasks as Array<{ preconditions: { verifications: unknown[] } }>)[0]!.preconditions.verifications =
            [{ claimId: "claim-1", outcome: "update", verifiedAt: 1_700_000_010_000 }];
        expect(() => parseScenario(notVerified)).not.toThrow();
    });

    test("a map task cannot skip a claim with no seeded baseline", () => {
        // selectMapMemoryInputs always selects a claim with no baseline, and only
        // a mapping precondition creates one.
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
        // A stale or flagged outcome sets the stale or disputed disposition, and
        // maintenance_hygiene admits a claim only when both are clear.
        for (const outcome of ["stale", "flagged"]) {
            expectDiagnostic((raw) => {
                const tasks = raw.tasks as Array<{ preconditions: { verifications: unknown[] } }>;
                tasks[2]!.preconditions.verifications = [
                    { claimId: "claim-1", outcome, verifiedAt: 1_700_000_010_000 },
                ];
            }, "scenario.tasks[2].preconditions.verifications[0].outcome: classify-hidden-disposition");
        }
        // The verification lane sees both, so a verify task may seed them.
        const onVerify = validScenarioRaw();
        (onVerify.tasks as Array<{ preconditions: { verifications: unknown[] } }>)[0]!.preconditions.verifications = [
            { claimId: "claim-1", outcome: "stale", verifiedAt: 1_700_000_010_000 },
        ];
        expect(() => parseScenario(onVerify)).not.toThrow();
    });

    test("a required update anchor cannot hold the parser's closing tag", () => {
        // The parser ends the update body at the first `</update>`, so parsed
        // content can never retain such an anchor.
        expectDiagnostic((raw) => {
            const tasks = raw.tasks as Array<{
                gold: { claims: Array<{ verdict: string; requiredUpdateAnchors: string[] }> };
            }>;
            tasks[0]!.gold.claims[0]!.verdict = "update";
            tasks[0]!.gold.claims[0]!.requiredUpdateAnchors = ["facts</update>more"];
        }, "scenario.tasks[0].gold.claims[0].requiredUpdateAnchors[0]: anchor-holds-close-tag");
        // The root extraction runs first and matches case-insensitively, so any
        // spelling of the root close tag truncates the body.
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
        // `writeFileSync` rejects it with a raw TypeError that escapes the typed
        // fixture-drift path.
        expectDiagnostic((raw) => {
            (raw.pool as { claims: Array<{ fixtureFiles: Array<{ path: string }> }> }).claims[0]!.fixtureFiles[0]!.path =
                "src/a\0.ts";
        }, "scenario.pool.claims[0].fixtureFiles[0].path: path-unrepresentable");
    });

    test("a verification timestamp must stay inside git's accepted date range", () => {
        // git rejects a commit date past 2099-12-31T23:59:59Z in every input
        // form, and `toISOString` throws past the maximum Date; both land before
        // any typed seeder check.
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
        // shouldRequeueIndependentMapping needs an empty sentinel, so a claim with
        // mapped files can never be pulled back into map scope.
        expectDiagnostic((raw) => {
            const tasks = raw.tasks as Array<{ preconditions: { mappings: unknown[] } }>;
            tasks[1]!.preconditions.mappings = [{ claimId: "claim-1", files: ["src/file-1.ts"] }];
        }, "scenario.tasks[1].expectedInScopeClaimIds[0]: map-scope-already-mapped");
        // An empty mapping stays ambiguous: the requeue heuristic reads the
        // claim's content and the repository, so either partition is admissible.
        const sentinel = validScenarioRaw();
        (sentinel.tasks as Array<{ preconditions: { mappings: unknown[] } }>)[1]!.preconditions.mappings = [
            { claimId: "claim-1", files: [] },
        ];
        expect(() => parseScenario(sentinel)).not.toThrow();
    });

    test("a required update anchor cannot spell a verify entry", () => {
        // The parser collects entries from the whole body, so one inside the
        // update content becomes a sibling entry with an unknown id.
        for (const anchor of [
            '<verified claim="ghost" files="x"/>',
            '<archive claim="ghost"/>',
            '<update claim="ghost" files="x">y',
        ]) {
            expectDiagnostic((raw) => {
                const tasks = raw.tasks as Array<{
                    gold: { claims: Array<{ verdict: string; requiredUpdateAnchors: string[] }> };
                }>;
                tasks[0]!.gold.claims[0]!.verdict = "update";
                tasks[0]!.gold.claims[0]!.requiredUpdateAnchors = [anchor];
            }, "scenario.tasks[0].gold.claims[0].requiredUpdateAnchors[0]: anchor-holds-entry");
        }
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
            { claimId: "claim-1", outcome: "update", verifiedAt: 2_001 },
        ];
        expect(() => parseScenario(seedable)).not.toThrow();
    });

    test("classify gold cannot request shareable for content production forces private", () => {
        // applyClassifications rewrites a reported `true` to false for this
        // content, so the model's "true" would score PASS while the stored claim
        // came out private.
        expectDiagnostic((raw) => {
            const claims = (raw.pool as { claims: Array<{ content: string; sharing: string }> }).claims;
            claims[0]!.content = "The provider answers on 127.0.0.1:8080 during local runs.";
            claims[0]!.sharing = "private";
        }, "scenario.tasks[2].gold.claims[0].shareable: shareability-override");
        // The override only fires on an explicitly reported `true`. A sensitive
        // claim already stored shareable keeps that value when an entry omits the
        // field, so this gold is achievable and must not be refused.
        const alreadyShareable = validScenarioRaw();
        const claims = (alreadyShareable.pool as { claims: Array<{ content: string; sharing: string }> }).claims;
        claims[0]!.content = "The provider answers on 127.0.0.1:8080 during local runs.";
        claims[0]!.sharing = "shareable";
        expect(() => parseScenario(alreadyShareable)).not.toThrow();
    });
});

// Storage identities the production predicates accept: `mcm_` plus 32 lowercase
// hexadecimal characters, and a locator embedding that same id, a positive
// revision, and a SHA-256 digest.
const CLAIM_ONE_ID = `mcm_${"1".repeat(32)}`;
const CLAIM_TWO_ID = `mcm_${"2".repeat(32)}`;
// The locator's third segment is the revision's content hash, so it is derived
// rather than filled in.
function locatorFor(publicClaimId: string, content: string): string {
    return `${publicClaimId}/r1/${sha256Utf8Hex(content)}`;
}

const SNAPSHOT_CONTENT = "Distinct memory content";
const CLAIM_ONE_LOCATOR = locatorFor(CLAIM_ONE_ID, SNAPSHOT_CONTENT);
const CLAIM_TWO_LOCATOR = locatorFor(CLAIM_TWO_ID, SNAPSHOT_CONTENT);

// A completed report has to carry the whole scenario pool, and the contract's
// floor is ten claims.
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

/** Bytes the production parsers read back as the evidence beside them. */
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

/** The same capture with `overrides` folded into its first claim. */
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
        // Verify parses to one record of verdict lists; map and classify parse
        // to one entry per claim, so a report that only accepted a record could
        // not carry the evidence two of the three scorers produce.
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
        // Absent evidence belongs to a run that failed before scoring, so the
        // null case rides on an ERROR report; a PASS must carry both fields.
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
        // A shape no scorer emits, and evidence naming a claim the run never
        // observed, are both refused.
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
        // A single-claim capture is only legal for a run that failed before
        // observing the pool, since a completed one must carry all ten.
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
        // No task creates, deletes, or rekeys a claim, so an omitted or rebound
        // identity is a corrupt before/after comparison rather than a real
        // observation.
        // An omitted claim.
        expect(() => parseRunReport({ ...baseReport, poolAfter: POOL_CAPTURE.slice(1) })).toThrow(
            /poolAfter: identity-drift/,
        );
        // A rebound public id on an otherwise identical claim.
        expect(() =>
            parseRunReport({
                ...baseReport,
                poolAfter: captureWithFirst({
                    publicClaimId: CLAIM_TWO_ID,
                    revisionLocator: locatorFor(CLAIM_TWO_ID, POOL_CAPTURE[0]!.content as string),
                }),
            }),
        ).toThrow(/poolAfter: identity-drift/);
        // A result attributed to another claim entirely.
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
        // Archival is a lifecycleState change on the same identity, so it is not
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
        // The locator embeds the claim's own id, so one naming another claim is a
        // mismatched pairing even though both halves are well formed.
        expect(() => parse({ revisionLocator: CLAIM_TWO_LOCATOR })).toThrow(
            /revisionLocator: locator-claim-mismatch/,
        );
        // The digest is the revision's content hash, so one over other bytes
        // describes a revision whose content is not the one recorded.
        expect(() => parse({ revisionLocator: `${OBSERVED_ID}/r1/${"c".repeat(64)}` })).toThrow(
            /revisionLocator: locator-digest-mismatch/,
        );
        expect(parse({}).poolBefore).toHaveLength(POOL_CAPTURE.length);
    });

    test("a passing report must carry the evidence it was scored from", () => {
        // A scorer reaches PASS only after a nonblank manifest validates and
        // yields parsed evidence.
        expect(() => parseRunReport({ ...baseReport, rawManifest: null })).toThrow(
            /parsedManifest: pass-requires-evidence/,
        );
        expect(() => parseRunReport({ ...baseReport, parsedManifest: null })).toThrow(
            /parsedManifest: pass-requires-evidence/,
        );
        // Blank bytes are non-null but are exactly what every scorer rejects as
        // ERROR:provider-failure, so they cannot back a PASS either.
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
        // An ERROR run may hold neither.
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
        // The map scorer emits only wrong-independence, wrong-mapping, and
        // invalid-output, so a map report claiming wrong-archival would carry
        // run-fatal exit 2 for an outcome it could never reach.
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
        // precheck admits only a nonblank manifest, so every scorer failure has
        // raw bytes; every reason but invalid-output also carries parsed evidence.
        const failing = { ...baseReport, status: "FAIL", reason: "wrong-verdict" };
        expect(() => parseRunReport({ ...failing, rawManifest: null })).toThrow(
            /rawManifest: fail-requires-evidence/,
        );
        expect(() => parseRunReport({ ...failing, rawManifest: "  " })).toThrow(
            /rawManifest: fail-requires-evidence/,
        );
        // A post-parse ERROR has no such rule, so the binding rule is what refuses
        // evidence with no bytes behind it.
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
        // invalid-output is raised when validation threw, so it has no parsed
        // evidence to carry.
        const rejected = { ...baseReport, status: "FAIL", reason: "invalid-output", rawManifest: "<verify>" };
        expect(parseRunReport({ ...rejected, parsedManifest: null }).parsedManifest).toBeNull();
        // And it cannot carry evidence: the reason is raised before any parse
        // result exists.
        expect(() => parseRunReport(rejected)).toThrow(/parsedManifest: invalid-output-has-evidence/);
        // Structurally parseable bytes beside invalid-output are legitimate: the
        // reason also covers a manifest the validator rejected for not covering
        // the expected ids, and reproducing that needs a set the report lacks.
        expect(
            parseRunReport({ ...baseReport, status: "FAIL", reason: "invalid-output", parsedManifest: null }).reason,
        ).toBe("invalid-output");
    });

    test("evidence entries must carry the fields their scorer emits", () => {
        // A map entry always has files and independence; verify's three lists each
        // have their own field set; a classify entry needs at least one
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
        // A partial classification is exactly what the parser produces.
        expect(
            parseRunReport({
                ...baseReport,
                task: "classify-memories",
                rawManifest: rawClassify(CLASSIFY_EVIDENCE),
                parsedManifest: CLASSIFY_EVIDENCE,
            }).parsedManifest,
        ).toEqual(CLASSIFY_EVIDENCE);
        // Classify validation demands exact id coverage, so evidence for a subset
        // of the observed pool is an artifact no scorer produces.
        expect(() =>
            parseRunReport({
                ...baseReport,
                task: "classify-memories",
                parsedManifest: CLASSIFY_EVIDENCE.slice(0, 1),
            }),
        ).toThrow(/parsedManifest: coverage-incomplete/);
    });

    test("an anchor's own edge whitespace costs a character on each side", () => {
        // The parser trims the body, so whitespace at an anchor's edge survives
        // only with a non-whitespace character outside it.
        expectDiagnostic((raw) => {
            const tasks = raw.tasks as Array<{
                gold: { claims: Array<{ verdict: string; requiredUpdateAnchors: string[] }> };
            }>;
            tasks[0]!.gold.claims[0]!.verdict = "update";
            tasks[0]!.gold.claims[0]!.requiredUpdateAnchors = [
                ` ${"a".repeat(VERIFY_UPDATE_CONTENT_MAX_LENGTH - 2)} `,
            ];
        }, "scenario.tasks[0].gold.claims[0].requiredUpdateAnchors[0]: anchor-exceeds-content-cap");
        // Two characters shorter leaves room for the padding on both sides.
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
        // `"İ".toLowerCase()` is two code units, so folding first would double the
        // measured cost and refuse a body that actually fits.
        const expanding = validScenarioRaw();
        const tasks = expanding.tasks as Array<{
            gold: { claims: Array<{ verdict: string; requiredUpdateAnchors: string[] }> };
        }>;
        tasks[0]!.gold.claims[0]!.verdict = "update";
        tasks[0]!.gold.claims[0]!.requiredUpdateAnchors = ["\u0130".repeat(11_000)];
        expect(() => parseScenario(expanding)).not.toThrow();
    });

    test("parsed evidence must reproduce from the captured bytes", () => {
        // The exploit this closes: bytes that carry no entries paired with a
        // fabricated evidence array.
        expect(() =>
            parseRunReport({ ...baseReport, rawManifest: "<verify></verify>" }),
        ).toThrow(/parsedManifest: evidence-mismatch/);
        // Evidence that differs in a field, not just in coverage.
        expect(() =>
            parseRunReport({
                ...baseReport,
                parsedManifest: {
                    ...VERIFY_EVIDENCE,
                    verified: [{ publicClaimId: OBSERVED_ID, files: ["src/other.ts"] }],
                },
            }),
        ).toThrow(/parsedManifest: evidence-mismatch/);
        // Bytes the parser refuses cannot back evidence either.
        expect(() => parseRunReport({ ...baseReport, rawManifest: "<verify>" })).toThrow(
            /rawManifest: evidence-unparseable/,
        );
        // Key order is not part of the comparison.
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
        // An ERROR run may hold a partial capture, so it keeps the exemption.
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

    test("a completed report must capture the scenario pool", () => {
        // Binding equality is vacuous for two empty captures, and every scenario
        // declares at least ten claims.
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
        // An ERROR run may have died before observing anything.
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
        // Every valid scenario carries at least one task, so nothing to
        // aggregate means no evaluation ran.
        expect(dreamerEvalExitCode([])).toBe(1);
        expect(dreamerEvalExitCode([parseRunReport(baseReport)])).toBe(0);
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
