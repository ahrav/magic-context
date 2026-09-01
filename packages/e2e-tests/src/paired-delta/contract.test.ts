import { describe, expect, it } from "bun:test";
import {
    PairedDeltaContractError,
    PAIRED_DELTA_MANIFEST_SCHEMA,
    PAIRED_DELTA_POLICY_GATES,
    PAIRED_DELTA_POLICY_SCHEMA,
    parseArmedCellResult,
    parsePairedDeltaManifest,
    parsePairedDeltaPolicy,
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
                query: "alpha-17",
                locatorIds: ["mem-alpha"],
            },
            r2: {
                memories: [{ claim: "The ID is alpha-17.", evidence: "Remember ID alpha-17." }],
            },
            r3: { evidence: "The required ID is alpha-17." },
        },
        absencePrecondition: {
            evidenceTurnId: "turn-evidence",
            minimumBallastBytes: 1024,
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

    it("requires an absence precondition and rejects non-MC restart declarations", () => {
        expect(() =>
            parseScenarioDeclaration({ ...scenario(), absencePrecondition: undefined }),
        ).toThrow(/absencePrecondition/);
        expect(() =>
            parseScenarioDeclaration(scenario({ restartArms: ["mc-off"] })),
        ).toThrow(/restartArms: unsupported-arm/);
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
    });
});

describe("paired-delta policy contract", () => {
    const policy = () => ({
        schema: PAIRED_DELTA_POLICY_SCHEMA as typeof PAIRED_DELTA_POLICY_SCHEMA,
        endpoint: "paired-valid-success-delta",
        targetMinimumDetectableDelta: 0.15,
        minimumAnalyzableFamilyCount: 4,
        bootstrapResamples: 5000,
        poolManifestFingerprint: "a".repeat(64),
        modelMatrix: [
            {
                providerId: "anthropic",
                modelId: "claude-sonnet-4-5-20250929",
                contextLimit: 8192,
            },
        ],
        replicateCount: 3,
        costBudgetUsd: { calibration: 500, weekly: 300, release: 1000 },
        pricesPerMillionTokens: {
            input: 3,
            output: 15,
            cacheCreation: 3.75,
            cacheRead: 0.3,
        },
        gates: [...PAIRED_DELTA_POLICY_GATES],
    });

    it("parses a well-formed policy", () => {
        expect(parsePairedDeltaPolicy(policy())).toEqual(policy());
    });

    it("rejects a missing budget mode", () => {
        const raw = policy() as Record<string, unknown>;
        raw.costBudgetUsd = { calibration: 500, weekly: 300 };
        expect(() => parsePairedDeltaPolicy(raw)).toThrow(/costBudgetUsd/);
    });

    it("rejects a non-positive budget", () => {
        const raw = policy();
        raw.costBudgetUsd.weekly = 0;
        expect(() => parsePairedDeltaPolicy(raw)).toThrow(/positive-number-required/);
    });

    it("rejects a renamed field", () => {
        const { replicateCount, ...rest } = policy();
        expect(() =>
            parsePairedDeltaPolicy({ ...rest, replicates: replicateCount }),
        ).toThrow(/fields-invalid/);
    });

    it("rejects a gate set that is not the pre-registered one", () => {
        const raw = policy();
        raw.gates = raw.gates.slice(1);
        expect(() => parsePairedDeltaPolicy(raw)).toThrow(/exact-gate-set-required/);
        expect(() =>
            parsePairedDeltaPolicy({ ...policy(), gates: ["unknown-gate"] }),
        ).toThrow(/enum-invalid/);
    });

    it("rejects an empty model matrix", () => {
        expect(() =>
            parsePairedDeltaPolicy({ ...policy(), modelMatrix: [] }),
        ).toThrow(/modelMatrix: empty/);
    });
});
