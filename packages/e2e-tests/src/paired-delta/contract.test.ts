import { describe, expect, it } from "bun:test";
import { ID_SHAPED_QUERY_MAX_TOKENS } from "../../../plugin/src/features/magic-context/search";
import {
    PairedDeltaContractError,
    PAIRED_DELTA_MANIFEST_SCHEMA,
    parseArmedCellResult,
    parsePairedDeltaManifest,
    parseScenarioDeclaration,
    validateCheckVector,
    type PairedDeltaManifest,
    type ScenarioDeclaration,
} from "./contract";

function scenario(overrides: Partial<ScenarioDeclaration> = {}): ScenarioDeclaration {
    return {
        scenarioId: "var-demo-one",
        familyId: "fam-demo",
        title: "Recall the buried identifier",
        expectedAnswer: "alpha-17",
        checks: ["check-shared"],
        criticalCheckIds: ["check-shared"],
        turnScript: [
            { id: "turn-evidence", role: "user", content: "Remember ID alpha-17." },
            { id: "turn-burial", role: "user", content: "Continue after the ballast." },
            { id: "turn-probe", role: "user", content: "Write the remembered ID." },
        ],
        interventions: {
            r1: {
                insertAfterTurnId: "turn-burial",
                query: "mem-alpha",
                locatorIds: ["mem-alpha"],
            },
            r2: {
                memories: [{ claim: "The ID is alpha-17.", evidence: "Remember ID alpha-17." }],
            },
            r3: { evidence: "The required ID is alpha-17." },
        },
        absencePrecondition: {
            evidenceTurnId: "turn-evidence",
            minimumBallastBytes: 32_768,
        },
        modelContextLimit: 4096,
        restartArms: [],
        verifier: () => [{ id: "check-shared", passed: true }],
        ...overrides,
    };
}

describe("paired-delta scenario contract", () => {
    it("parses a valid declaration without replacing authored functions", () => {
        const raw = scenario();
        const parsed = parseScenarioDeclaration(raw);
        expect(parsed).toEqual(raw);
        expect(parsed.verifier({ armId: "mc-on", workspacePath: "/tmp/x" })).toEqual([
            { id: "check-shared", passed: true },
        ]);
    });

    it("rejects duplicate and malformed identifiers", () => {
        expect(() => parseScenarioDeclaration(scenario({ scenarioId: "Demo One" }))).toThrow(
            PairedDeltaContractError,
        );
        expect(() =>
            parseScenarioDeclaration(scenario({ checks: ["check-shared", "check-shared"] })),
        ).toThrow(/checks: duplicate/);
    });

    it("rejects malformed check ids and critical checks outside the declaration", () => {
        expect(() =>
            parseScenarioDeclaration(scenario({ checks: ["Check Shared" as never] })),
        ).toThrow(/checks\[0\]: id-invalid/);
        expect(() =>
            parseScenarioDeclaration(scenario({ criticalCheckIds: ["check-missing"] })),
        ).toThrow(/criticalCheckIds: unknown-check/);
    });

    it("requires the gold answer wherever an arm must derive it", () => {
        const base = scenario();
        expect(() =>
            parseScenarioDeclaration(scenario({
                interventions: {
                    ...base.interventions,
                    r2: { memories: [{ claim: "Unrelated note.", evidence: "Remember ID alpha-17." }] },
                },
            })),
        ).toThrow(/r2\.memories: answer-absent/);
        expect(() =>
            parseScenarioDeclaration(scenario({
                interventions: {
                    ...base.interventions,
                    r3: { evidence: "Some unrelated context." },
                },
            })),
        ).toThrow(/r3\.evidence: answer-absent/);
        expect(() =>
            parseScenarioDeclaration(scenario({
                turnScript: [
                    { id: "turn-evidence", role: "user", content: "Consult the memo." },
                    ...base.turnScript.slice(1),
                ],
            })),
        ).toThrow(/evidenceTurnId: answer-absent/);
    });

    it("requires the evidence turn to precede the R1 insertion point", () => {
        const base = scenario();
        /** Answer-free turns so the ordering rule is what fires, not the post-insertion leak scan. commentlint: allow(JUDGE) */
        const turnScript: ScenarioDeclaration["turnScript"] = [
            { id: "turn-lead", role: "user", content: "Start the task." },
            { id: "turn-evidence", role: "user", content: "Consult the memo." },
            { id: "turn-probe", role: "user", content: "Write the remembered ID." },
        ];
        for (const insertAfterTurnId of ["turn-lead", "turn-evidence"]) {
            expect(() =>
                parseScenarioDeclaration(scenario({
                    turnScript,
                    interventions: {
                        ...base.interventions,
                        r1: { ...base.interventions.r1, insertAfterTurnId },
                    },
                })),
            ).toThrow(/evidenceTurnId: not-before-r1-insertion/);
        }
    });

    it("rejects a padded expected answer the verifier could never match", () => {
        expect(() =>
            parseScenarioDeclaration(scenario({ expectedAnswer: "alpha-17 " })),
        ).toThrow(/expectedAnswer: not-trimmed/);
    });

    it("rejects an answer leak in any turn at or after the R1 insertion point", () => {
        const base = scenario();
        expect(() =>
            parseScenarioDeclaration(scenario({
                turnScript: [
                    ...base.turnScript.slice(0, 2),
                    { id: "turn-probe", role: "user", content: "Write ALPHA-17 to the file." },
                ],
            })),
        ).toThrow(/turnScript: post-insertion-answer-leak/);
    });

    it("requires a user probe turn after the R1 insertion point", () => {
        const base = scenario();
        expect(() =>
            parseScenarioDeclaration(scenario({
                interventions: {
                    ...base.interventions,
                    r1: { ...base.interventions.r1, insertAfterTurnId: "turn-probe" },
                },
            })),
        ).toThrow(/insertAfterTurnId: no-following-probe/);
        expect(() =>
            parseScenarioDeclaration(scenario({
                turnScript: [
                    ...base.turnScript.slice(0, 2),
                    { id: "turn-probe", role: "assistant", content: "Understood." },
                ],
            })),
        ).toThrow(/insertAfterTurnId: no-following-probe/);
    });

    it("rejects duplicate R2 gold claims", () => {
        const base = scenario();
        for (const second of ["The ID is alpha-17.", "the id is   ALPHA-17.  "]) {
            expect(() =>
                parseScenarioDeclaration(scenario({
                    interventions: {
                        ...base.interventions,
                        r1: { ...base.interventions.r1, locatorIds: ["mem-alpha", "mem-beta"] },
                        r2: {
                            memories: [
                                { claim: "The ID is alpha-17.", evidence: "First sighting." },
                                { claim: second, evidence: "Second sighting." },
                            ],
                        },
                    },
                })),
            ).toThrow(/r2\.memories: duplicate/);
        }
    });

    it("requires one declared gold memory per R1 locator handle", () => {
        const base = scenario();
        expect(() =>
            parseScenarioDeclaration(scenario({
                interventions: {
                    ...base.interventions,
                    r1: {
                        ...base.interventions.r1,
                        locatorIds: ["mem-alpha", "mem-beta"],
                    },
                },
            })),
        ).toThrow(/r1\.locatorIds: memory-cardinality-mismatch/);
    });

    it("bounds R1 locator sets to the scripted-search limit", () => {
        const base = scenario();
        const withLocators = (count: number): Partial<ScenarioDeclaration> => ({
            interventions: {
                ...base.interventions,
                r1: {
                    ...base.interventions.r1,
                    locatorIds: Array.from({ length: count }, (_, i) => `mem-handle${i}`),
                },
                r2: {
                    memories: Array.from({ length: count }, (_, i) => ({
                        claim: `Gold claim ${i} names alpha-17.`,
                        evidence: `Gold evidence ${i}.`,
                    })),
                },
            },
        });
        expect(() =>
            parseScenarioDeclaration(scenario(withLocators(ID_SHAPED_QUERY_MAX_TOKENS + 1))),
        ).toThrow(/r1\.locatorIds: exceeds-search-limit/);
        expect(() =>
            parseScenarioDeclaration(scenario(withLocators(ID_SHAPED_QUERY_MAX_TOKENS))),
        ).not.toThrow();
    });

    it("rejects an R2 declaration with no gold memory", () => {
        expect(() =>
            parseScenarioDeclaration(scenario({
                interventions: { ...scenario().interventions, r2: { memories: [] } },
            })),
        ).toThrow(/r2\.memories: empty/);
    });

    it("requires an absence precondition and rejects non-MC restart declarations", () => {
        expect(() =>
            parseScenarioDeclaration({ ...scenario(), absencePrecondition: undefined }),
        ).toThrow(/absencePrecondition/);
        expect(() =>
            parseScenarioDeclaration(scenario({ restartArms: ["mc-off"] })),
        ).toThrow(/restartArms: unsupported-arm/);
    });

    it("rejects an R1 query that leaks the expected answer", () => {
        expect(() =>
            parseScenarioDeclaration(scenario({
                interventions: {
                    ...scenario().interventions,
                    r1: { ...scenario().interventions.r1, query: "find alpha-17 now" },
                },
            })),
        ).toThrow(/r1\.query: contains-answer/);
    });

    it("rejects ballast below the token-denominated context window", () => {
        expect(() =>
            parseScenarioDeclaration(scenario({
                absencePrecondition: {
                    evidenceTurnId: "turn-evidence",
                    minimumBallastBytes: 1024,
                },
            })),
        ).toThrow(/absencePrecondition: ballast-below-context/);
    });

    it("requires verifier output to match the arm's declared checks", () => {
        const declaration = parseScenarioDeclaration(scenario());
        expect(() =>
            validateCheckVector(declaration, [{ id: "check-other", passed: true }]),
        ).toThrow(/declaration-mismatch/);
        expect(() =>
            validateCheckVector(declaration, [
                { id: "check-shared", passed: true },
                { id: "check-shared", passed: true },
            ]),
        ).toThrow(/duplicate/);
    });

    it("rejects a verifier vector that is not an array of check results", () => {
        const declaration = parseScenarioDeclaration(scenario());
        for (const vector of [null, undefined, "check-shared", { id: "check-shared" }]) {
            expect(() =>
                validateCheckVector(declaration, vector as never),
            ).toThrow(PairedDeltaContractError);
        }
        expect(() =>
            validateCheckVector(declaration, [
                { id: "check-shared", passed: "yes" as never },
            ]),
        ).toThrow(/checkVector\[0\]\.passed: boolean-required/);
    });
});

describe("paired-delta armed cell contract", () => {
    const completed = {
        armId: "mc-on",
        checksPassed: 2,
        checksTotal: 3,
        criticalPassed: 1,
        criticalTotal: 1,
        invalidSuccess: false,
        runHealth: "completed",
        reasonCode: null,
    } as const;

    it("accepts a completed result and optional regret keys remain optional", () => {
        expect(parseArmedCellResult(completed)).toEqual(completed);
    });

    it("rejects negative and inverted counts", () => {
        expect(() => parseArmedCellResult({ ...completed, checksPassed: -1 })).toThrow(
            /checksPassed: integer-invalid/,
        );
        expect(() => parseArmedCellResult({ ...completed, checksPassed: 4 })).toThrow(
            /checks: passed-exceeds-total/,
        );
        expect(() => parseArmedCellResult({ ...completed, criticalPassed: 2 })).toThrow(
            /critical: passed-exceeds-total/,
        );
    });

    it("rejects critical counts that exceed the overall counts they subset", () => {
        expect(() =>
            parseArmedCellResult({ ...completed, criticalTotal: 4, criticalPassed: 1 }),
        ).toThrow(/critical: total-exceeds-checks/);
        expect(() =>
            parseArmedCellResult({
                ...completed,
                checksPassed: 0,
                criticalPassed: 1,
                criticalTotal: 1,
            }),
        ).toThrow(/critical: passed-exceeds-checks/);
    });

    it("rejects reason codes incompatible with the reported health", () => {
        expect(() =>
            parseArmedCellResult({
                ...completed,
                runHealth: "timeout",
                reasonCode: "runner-crash",
            }),
        ).toThrow(/reasonCode: health-incompatible/);
        expect(() =>
            parseArmedCellResult({
                ...completed,
                runHealth: "crash",
                reasonCode: "deadline-exceeded",
            }),
        ).toThrow(/reasonCode: health-incompatible/);
        for (const health of ["timeout", "crash", "malformed", "unavailable"] as const) {
            expect(() =>
                parseArmedCellResult({
                    ...completed,
                    runHealth: health,
                    reasonCode: "harness-failure",
                }),
            ).not.toThrow();
        }
    });

    it("rejects a completed cell with an empty score denominator", () => {
        expect(() =>
            parseArmedCellResult({
                ...completed,
                checksPassed: 0,
                checksTotal: 0,
                criticalPassed: 0,
                criticalTotal: 0,
            }),
        ).toThrow(/checks: completed-requires-checks/);
        expect(() =>
            parseArmedCellResult({
                ...completed,
                checksPassed: 0,
                checksTotal: 0,
                criticalPassed: 0,
                criticalTotal: 0,
                runHealth: "timeout",
                reasonCode: "deadline-exceeded",
            }),
        ).not.toThrow();
    });
});

describe("paired-delta manifest contract", () => {
    it("round-trips frozen entries for multiple families and run modes", () => {
        const raw: PairedDeltaManifest = {
            schema: PAIRED_DELTA_MANIFEST_SCHEMA,
            scenarios: [
                {
                    scenarioId: "var-demo-one",
                    semanticFingerprint: "a".repeat(64),
                    verifierBundleDigest: "b".repeat(64),
                    runModes: ["calibration", "weekly", "release"],
                },
                {
                    scenarioId: "var-demo-two",
                    semanticFingerprint: "c".repeat(64),
                    verifierBundleDigest: "d".repeat(64),
                    runModes: ["release"],
                },
            ],
        };
        expect(parsePairedDeltaManifest(raw)).toEqual(raw);
    });

    it("rejects duplicate scenario ids and unknown run modes", () => {
        const entry = {
            scenarioId: "var-demo-one",
            semanticFingerprint: "a".repeat(64),
            verifierBundleDigest: "b".repeat(64),
            runModes: ["release"],
        };
        expect(() =>
            parsePairedDeltaManifest({
                schema: PAIRED_DELTA_MANIFEST_SCHEMA,
                scenarios: [entry, entry],
            }),
        ).toThrow(/duplicate/);
        expect(() =>
            parsePairedDeltaManifest({
                schema: PAIRED_DELTA_MANIFEST_SCHEMA,
                scenarios: [{ ...entry, runModes: ["nightly"] }],
            }),
        ).toThrow(/enum-invalid/);
        expect(() =>
            parsePairedDeltaManifest({
                schema: PAIRED_DELTA_MANIFEST_SCHEMA,
                scenarios: [{ ...entry, runModes: [] }],
            }),
        ).toThrow(/runModes: empty/);
    });
});
