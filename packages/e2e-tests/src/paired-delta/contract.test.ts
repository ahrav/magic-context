import { describe, expect, it } from "bun:test";
import { ID_SHAPED_QUERY_MAX_TOKENS } from "../../../plugin/src/features/magic-context/search";
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
        expectedAnswer: "alpha-17",
        answerMatch: "exact",
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
                locatorIds: ["mem-alpha"],
            },
            r2: {
                memories: [{ claim: "The ID is alpha-17.", evidence: "Remember ID alpha-17." }],
            },
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

    it("applies the declared casing policy when checking supplied gold", () => {
        const base = scenario();
        const miscased = (): Partial<ScenarioDeclaration> => ({
            turnScript: [
                { id: "turn-evidence", role: "user", content: "Remember ID ALPHA-17." },
                ...base.turnScript.slice(1),
            ],
        });
        /** Under `exact` the verifier rejects a differently-cased answer, so miscased evidence is not gold. */
        expect(() =>
            parseScenarioDeclaration(scenario({ answerMatch: "exact", ...miscased() })),
        ).toThrow(/evidenceTurnId: answer-absent/);
        expect(() =>
            parseScenarioDeclaration(scenario({ answerMatch: "case-insensitive", ...miscased() })),
        ).not.toThrow();
    });

    it("rejects an answer revealed only by the composed search prompt", () => {
        /** Present in neither the fixed prefix nor a claim id alone, but in their join. */
        expect(() =>
            parseScenarioDeclaration(scenario({ expectedAnswer: "evidence: mcm" })),
        ).toThrow(/expectedAnswer: revealed-by-search-prompt/);
    });

    it("rejects an aggregate claim payload past the render bound", () => {
        const base = scenario();
        const chunk = (n: number): string => `alpha-17 part ${n} ${"x".repeat(400)}`;
        expect(() =>
            parseScenarioDeclaration(scenario({
                interventions: {
                    ...base.interventions,
                    r1: { ...base.interventions.r1, locatorIds: ["mem-a", "mem-b", "mem-c"] },
                    r2: {
                        memories: [0, 1, 2].map((n) => ({
                            claim: chunk(n),
                            evidence: "Remember ID alpha-17.",
                        })),
                    },
                },
            })),
        ).toThrow(/r2\.memories: payload-exceeds-render-bound/);
    });

    it("rejects an answer that collides with the claim-id prefix", () => {
        for (const expectedAnswer of ["mcm", "mcm_", "cm"]) {
            expect(() =>
                parseScenarioDeclaration(scenario({ expectedAnswer })),
            ).toThrow(/expectedAnswer: collides-with-claim-id-prefix/);
        }
    });

    it("treats an internal decimal point as part of a numeric value", () => {
        const base = scenario();
        const withEvidence = (content: string): Partial<ScenarioDeclaration> => ({
            expectedAnswer: "47",
            answerMatch: "case-insensitive",
            turnScript: [
                { id: "turn-evidence", role: "user", content },
                ...base.turnScript.slice(1),
            ],
            interventions: {
                ...base.interventions,
                r2: { memories: [{ claim: content, evidence: content }] },
            },
        });
        expect(() =>
            parseScenarioDeclaration(scenario(withEvidence("The ratio is 47.5 exactly."))),
        ).toThrow(/answer-absent/);
        expect(() =>
            parseScenarioDeclaration(scenario(withEvidence("The target is 47."))),
        ).not.toThrow();
    });

    it("rejects a claim that cannot render intact or is ill-formed", () => {
        const base = scenario();
        const withClaim = (claim: string): Partial<ScenarioDeclaration> => ({
            interventions: {
                ...base.interventions,
                r2: { memories: [{ claim, evidence: "Remember ID alpha-17." }] },
            },
        });
        /** Past MAX_RENDER_FIELD_BYTES: R1 would receive a truncated claim while R3 gets it whole. */
        expect(() =>
            parseScenarioDeclaration(scenario(withClaim(`alpha-17 ${"filler ".repeat(200)}`))),
        ).toThrow(/claim: exceeds-render-bound/);
        /** A lone surrogate freezes but can never be seeded. */
        expect(() =>
            parseScenarioDeclaration(scenario(withClaim("alpha-17 \ud800"))),
        ).toThrow(/claim: unicode-ill-formed/);
    });

    it("detects an answer leak across canonically equivalent spellings", () => {
        const base = scenario();
        /** Composed gold, decomposed in a post-insertion turn: identical to a reader. */
        expect(() =>
            parseScenarioDeclaration(scenario({
                expectedAnswer: "caf\u00e9",
                answerMatch: "case-insensitive",
                turnScript: [
                    { id: "turn-evidence", role: "user", content: "The venue is caf\u00e9." },
                    base.turnScript[1]!,
                    { id: "turn-probe", role: "user", content: "Write cafe\u0301 to the file." },
                ],
                interventions: {
                    ...base.interventions,
                    r2: { memories: [{ claim: "The venue is caf\u00e9.", evidence: "e" }] },
                },
            })),
        ).toThrow(/turnScript: post-insertion-answer-leak/);
    });

    it("rejects a path answer satisfied only by a longer path", () => {
        const base = scenario();
        const withPath = (content: string): Partial<ScenarioDeclaration> => ({
            expectedAnswer: "db/migrations/x.sql",
            turnScript: [
                { id: "turn-evidence", role: "user", content },
                ...base.turnScript.slice(1),
            ],
            interventions: {
                ...base.interventions,
                r2: { memories: [{ claim: content, evidence: content }] },
            },
        });
        for (const longer of [
            "at /srv/db/migrations/x.sql now",
            "at old/db/migrations/x.sql/backup",
            "at C:\\srv\\db/migrations/x.sql now",
        ]) {
            expect(() => parseScenarioDeclaration(scenario(withPath(longer))))
                .toThrow(/answer-absent/);
        }
        expect(() => parseScenarioDeclaration(scenario(withPath("write db/migrations/x.sql."))))
            .not.toThrow();
    });

    it("requires the gold answer as a complete value, not a substring", () => {
        const base = scenario();
        /** `alpha-17` inside `alpha-170` must not count as gold. */
        expect(() =>
            parseScenarioDeclaration(scenario({
                turnScript: [
                    { id: "turn-evidence", role: "user", content: "Remember ID alpha-170." },
                    ...base.turnScript.slice(1),
                ],
            })),
        ).toThrow(/evidenceTurnId: answer-absent/);
        /** A trailing sentence period is not a value character, so it still matches. */
        expect(() =>
            parseScenarioDeclaration(scenario({
                turnScript: [
                    { id: "turn-evidence", role: "user", content: "The ID is alpha-17." },
                    ...base.turnScript.slice(1),
                ],
            })),
        ).not.toThrow();
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
                turnScript: [
                    { id: "turn-evidence", role: "user", content: "Consult the memo." },
                    ...base.turnScript.slice(1),
                ],
            })),
        ).toThrow(/evidenceTurnId: answer-absent/);
    });

    it("requires the evidence turn to precede the R1 insertion point", () => {
        const base = scenario();
        /** Answer-free turns so the ordering rule is what fires, not the post-insertion leak scan. */
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

    it("rejects an R1 locator handle that leaks the expected answer", () => {
        expect(() =>
            parseScenarioDeclaration(scenario({
                interventions: {
                    ...scenario().interventions,
                    r1: { ...scenario().interventions.r1, locatorIds: ["mem-alpha-17"] },
                },
            })),
        ).toThrow(/r1\.locatorIds: contains-answer/);
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
        expect(() =>
            parsePairedDeltaManifest({ schema: PAIRED_DELTA_MANIFEST_SCHEMA, scenarios: [] }),
        ).toThrow(/manifest\.scenarios: empty/);
        /** Release-only entries leave calibration and weekly with no measurements. */
        expect(() =>
            parsePairedDeltaManifest({
                schema: PAIRED_DELTA_MANIFEST_SCHEMA,
                scenarios: [{ ...entry, runModes: ["release"] }],
            }),
        ).toThrow(/manifest\.scenarios: run-mode-uncovered/);
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
