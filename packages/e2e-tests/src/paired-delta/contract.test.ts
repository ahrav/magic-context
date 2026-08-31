import { describe, expect, it } from "bun:test";
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
        checks: [
            {
                id: "check-shared",
                appliesToArms: ["mc-on", "mc-off", "compaction", "r1", "r2", "r3"],
            },
        ],
        criticalCheckIds: ["check-shared"],
        turnScript: [
            { id: "turn-evidence", role: "user", content: "Remember ID alpha-17." },
            { id: "turn-probe", role: "user", content: "Write the remembered ID." },
        ],
        interventions: {
            r1: {
                insertAfterTurnId: "turn-evidence",
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
            parseScenarioDeclaration(scenario({
                checks: [
                    { id: "check-shared", appliesToArms: ["mc-on", "mc-off", "compaction", "r1", "r2", "r3"] },
                    { id: "check-shared", appliesToArms: ["mc-on"] },
                ],
            })),
        ).toThrow(/checks: duplicate/);
    });

    it("rejects unknown arms and critical checks outside the declaration", () => {
        expect(() =>
            parseScenarioDeclaration(scenario({
                checks: [{ id: "check-shared", appliesToArms: ["mc-on", "future-arm" as never] }],
            })),
        ).toThrow(/enum-invalid/);
        expect(() =>
            parseScenarioDeclaration(scenario({ criticalCheckIds: ["check-missing"] })),
        ).toThrow(/criticalCheckIds: unknown-check/);
    });

    it("requires primary and regret-ladder check intersections", () => {
        expect(() =>
            parseScenarioDeclaration(scenario({
                checks: [{ id: "check-shared", appliesToArms: ["mc-on", "r1", "r2", "r3"] }],
            })),
        ).toThrow(/checks: primary-intersection-empty/);
        expect(() =>
            parseScenarioDeclaration(scenario({
                checks: [{ id: "check-shared", appliesToArms: ["mc-on", "mc-off", "compaction"] }],
            })),
        ).toThrow(/checks: ladder-intersection-empty/);
    });

    it("rejects empty critical-check and R1 locator lists", () => {
        expect(() =>
            parseScenarioDeclaration(scenario({ criticalCheckIds: [] })),
        ).toThrow(/criticalCheckIds: empty/);
        expect(() =>
            parseScenarioDeclaration(scenario({
                interventions: {
                    ...scenario().interventions,
                    r1: { ...scenario().interventions.r1, locatorIds: [] },
                },
            })),
        ).toThrow(/r1\.locatorIds: empty/);
    });

    it("requires every critical check to cover every compared arm", () => {
        expect(() =>
            parseScenarioDeclaration(scenario({
                checks: [
                    {
                        id: "check-shared",
                        appliesToArms: ["mc-on", "mc-off", "compaction", "r1", "r2", "r3"],
                    },
                    { id: "check-mc-only", appliesToArms: ["mc-on"] },
                ],
                criticalCheckIds: ["check-mc-only"],
            })),
        ).toThrow(/criticalCheckIds: arm-coverage-incomplete/);
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
            validateCheckVector(declaration, "mc-on", [{ id: "check-other", passed: true }]),
        ).toThrow(/declaration-mismatch/);
        expect(() =>
            validateCheckVector(declaration, "mc-on", [
                { id: "check-shared", passed: true },
                { id: "check-shared", passed: true },
            ]),
        ).toThrow(/duplicate/);
    });

    it("rejects a verifier vector that is not an array of check results", () => {
        const declaration = parseScenarioDeclaration(scenario());
        for (const vector of [null, undefined, "check-shared", { id: "check-shared" }]) {
            expect(() =>
                validateCheckVector(declaration, "mc-on", vector as never),
            ).toThrow(PairedDeltaContractError);
        }
        expect(() =>
            validateCheckVector(declaration, "mc-on", [
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
