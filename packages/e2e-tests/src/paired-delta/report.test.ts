import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import type { PairedCaseFact } from "../prospective-holdout/comparison";
import { POLICY_OWNER_SCHEMA } from "../prospective-holdout/contract";
import { pairedFactsFingerprint } from "../prospective-holdout/report";
import { cellResultFixture } from "../prospective-holdout/test-fixtures";
import { estimateFamilyDeltas } from "./estimator";
import {
    PAIRED_DELTA_REPORT_SCHEMA,
    buildCalibrationRecord,
    calibrationNoiseFloors,
    readCalibrationRecord,
    buildPairedDeltaReport,
    parsePairedDeltaReport,
    publishPairedDeltaReport,
} from "./report";
import { PRIMARY_ARM_IDS } from "./contract";

type PrimaryArm = (typeof PRIMARY_ARM_IDS)[number];
import type { RolloutRecord } from "./runner";

const H1 = "1".repeat(64);
const H2 = "2".repeat(64);

function pair(seed: number): PairedCaseFact {
    return {
        caseId: `case-${"a".repeat(32)}`,
        familyId: "fam-a",
        implementationFingerprint: H2,
        model: "fixture/model",
        seed,
        platform: "linux-x64",
        releaseN: cellResultFixture("release-n"),
        releaseNMinus1: cellResultFixture("release-n-minus-1"),
        status: "complete",
    };
}

const pairs = [pair(9), pair(7)];
const PAIRED_FACTS = pairedFactsFingerprint(pairs);

function policyDocument(minimumAnalyzableFamilyCount = 2) {
    const payload = { minimumAnalyzableFamilyCount, targetMinimumDetectableDelta: 0.1 };
    return {
        schema: POLICY_OWNER_SCHEMA,
        owner: "magic-context-x4l.14",
        status: "ready",
        policy: payload,
        policyFingerprint: canonicalFingerprint(payload),
    };
}

function analysisFixture(policyFingerprint: string) {
    return estimateFamilyDeltas({
        observations: [
            { coordinateId: "var-a:0", familyId: "fam-a", endpoint: "mc-on-vs-mc-off", delta: 0.3, runHealth: "completed" },
            { coordinateId: "var-b:0", familyId: "fam-b", endpoint: "mc-on-vs-mc-off", delta: 0.1, runHealth: "completed" },
            { coordinateId: "var-a:0", familyId: "fam-a", endpoint: "mc-on-vs-compaction", delta: 0.3, runHealth: "completed" },
            { coordinateId: "var-b:0", familyId: "fam-b", endpoint: "mc-on-vs-compaction", delta: 0.1, runHealth: "completed" },
            { coordinateId: "var-a:0", familyId: "fam-a", endpoint: "retrieval", delta: 0.1, runHealth: "completed" },
            { coordinateId: "var-a:0", familyId: "fam-a", endpoint: "formation", delta: 0.2, runHealth: "completed" },
        ],
        minimumAnalyzableFamilyCount: 2,
        bootstrapSeed: 17,
        bootstrapResamples: 2000,
        lane: {
            poolManifestFingerprint: H1,
            pinnedSnapshotId: "anthropic-model-20260830",
            policyFingerprint,
            pairedFactsFingerprint: PAIRED_FACTS,
        },
    });
}

function report(overrides: Partial<Parameters<typeof buildPairedDeltaReport>[0]> = {}) {
    const policy = policyDocument();
    return buildPairedDeltaReport({
        poolManifestFingerprint: H1,
        pinnedSnapshotId: "anthropic-model-20260830",
        policyDocument: policy,
        implementationDigest: "abc123",
        limitations: ["absence-precondition-basis=configured-context-limit: fixture caveat"],
        pairs,
        analysis: analysisFixture(policy.policyFingerprint),
        runSummary: {
            status: "completed" as const,
            spentUsd: 12.5,
            // A completed run stored every primary arm for all twelve coordinates. Each unhealthy coordinate has
            // one failed arm priced as an estimate, which is one of the exclusions below, and two observed arms.
            observedCostRollouts: 33,
            estimatedCostRollouts: 3,
            refusedRegretLadders: { "intervention-mismatch": 2 },
            plannedCoordinates: 12,
            healthyCoordinates: 9,
            // A calibration run with a partial matrix cannot be valid for pool sizing.
            evidenceComplete: false,
            calibrationFingerprint: null,
        },
        exclusions: [
            { armId: "mc-off", reasonCode: "provider-unavailable", count: 2 },
            { armId: "compaction", reasonCode: "deadline-exceeded", count: 1 },
        ],
        // A healthy coordinate completed every primary arm, so each map carries all three.
        secondaryMetrics: {
            invalidSuccessRateByArm: { "mc-on": 0.1, "mc-off": 0, compaction: 0 },
            finalAttemptTokensByArm: { "mc-on": 1000, "mc-off": 800, compaction: 900 },
            finalAttemptWallClockMsByArm: { "mc-on": 4000, "mc-off": 3000, compaction: 3500 },
            finalAttemptTurnsByArm: { "mc-on": 8, "mc-off": 7, compaction: 7 },
        },
        ...overrides,
    });
}

describe("paired-delta report", () => {
    it("binds identity, exclusions, secondary metrics, and regret discipline", () => {
        const built = report();
        expect(built.schema).toBe(PAIRED_DELTA_REPORT_SCHEMA);
        expect(built.body.poolManifestFingerprint).toBe(H1);
        expect(built.body.policyFingerprint).toHaveLength(64);
        expect(built.body.exclusions).toEqual([
            { armId: "compaction", reasonCode: "deadline-exceeded", count: 1 },
            { armId: "mc-off", reasonCode: "provider-unavailable", count: 2 },
        ]);
        // `formation` is R2 - R1 and R1's search turn is mock-served, so both R1-dependent rungs are provider-mixed.
        expect(built.body.regret.providerMixed.map(({ endpoint }) => endpoint))
            .toEqual(["formation", "retrieval"]);
        expect(built.body.regret.live.map(({ endpoint }) => endpoint)).toEqual([]);
        expect(built.body.regret.raw).toEqual([{
            coordinateId: "var-a:0",
            familyId: "fam-a",
            retrieval: 0.1,
            formation: 0.2,
            representation: null,
            label: "raw-non-inferential",
        }]);
        expect(built.reportFingerprint).toBe(canonicalFingerprint(built.body));
    });

    it("derives the raw regret ladder from the analyzed records in a total order", () => {
        const policy = policyDocument(1);
        const analysis = estimateFamilyDeltas({
            observations: [
                { coordinateId: "var-a:0", familyId: "fam-b", endpoint: "mc-on-vs-mc-off", delta: 0.3, runHealth: "completed" },
                { coordinateId: "var-a:0", familyId: "fam-b", endpoint: "mc-on-vs-compaction", delta: 0.3, runHealth: "completed" },
                { coordinateId: "var-a:0", familyId: "fam-b", endpoint: "retrieval", delta: 0.5, runHealth: "completed" },
                { coordinateId: "var-a:1", familyId: "fam-a", endpoint: "retrieval", delta: 0.4, runHealth: "completed" },
            ],
            minimumAnalyzableFamilyCount: 1,
            bootstrapSeed: 17,
            bootstrapResamples: 2000,
            lane: {
                poolManifestFingerprint: H1,
                pinnedSnapshotId: "anthropic-model-20260830",
                policyFingerprint: policy.policyFingerprint,
                pairedFactsFingerprint: PAIRED_FACTS,
            },
        });
        const built = report({ policyDocument: policy, analysis });
        // Ordering is keyed on both identifiers, so `var-a:0` under `fam-b` cannot precede `var-a:1` by caller order alone.
        expect(built.body.regret.raw.map(({ coordinateId, familyId, retrieval }) =>
            [coordinateId, familyId, retrieval])).toEqual([
            ["var-a:0", "fam-b", 0.5],
            ["var-a:1", "fam-a", 0.4],
        ]);
    });

    it("changes fingerprint when a lane fact changes and publishes atomically", () => {
        const built = report();
        const changed = report();
        changed.body.secondaryMetrics.finalAttemptTokensByArm["mc-on"] = 1001;
        expect(canonicalFingerprint(changed.body)).not.toBe(built.reportFingerprint);
        expect(() => publishPairedDeltaReport(changed, "/unused")).toThrow(
            /fingerprint-mismatch/,
        );

        const root = mkdtempSync(join(tmpdir(), "paired-delta-report-"));
        try {
            const path = join(root, "nested", "report.json");
            publishPairedDeltaReport(built, path);
            expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(built);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("rejects an analysis estimated for a different lane", () => {
        const built = report();
        expect(() => buildPairedDeltaReport({
            poolManifestFingerprint: H1,
            pinnedSnapshotId: "different-model-20260831",
            policyDocument: {
                schema: POLICY_OWNER_SCHEMA,
                owner: "magic-context-x4l.14",
                status: "ready",
                policy: { minimumAnalyzableFamilyCount: 2, targetMinimumDetectableDelta: 0.1 },
                policyFingerprint: built.body.policyFingerprint,
            },
            implementationDigest: "abc123",
            limitations: [],
            pairs,
            analysis: built.body.analysis,
            exclusions: [],
            secondaryMetrics: {
                invalidSuccessRateByArm: {},
                finalAttemptTokensByArm: {},
                finalAttemptWallClockMsByArm: {},
                finalAttemptTurnsByArm: {},
            },
            runSummary: built.body.runSummary,
        })).toThrow(/analysis-lane-binding-mismatch/);
    });

    it("rejects a non-ready or wrongly owned pre-registration document", () => {
        const built = report();
        expect(() => buildPairedDeltaReport({
            poolManifestFingerprint: H1,
            pinnedSnapshotId: "anthropic-model-20260830",
            policyDocument: {
                schema: POLICY_OWNER_SCHEMA,
                owner: "magic-context-x4l.15",
                status: "ready",
                policy: {},
                policyFingerprint: H2,
            },
            implementationDigest: "abc123",
            limitations: [],
            pairs,
            analysis: built.body.analysis,
            exclusions: [],
            secondaryMetrics: {
                invalidSuccessRateByArm: {},
                finalAttemptTokensByArm: {},
                finalAttemptWallClockMsByArm: {},
                finalAttemptTurnsByArm: {},
            },
            runSummary: built.body.runSummary,
        })).toThrow(/policy: identity-invalid/);
    });

    it("keeps ladder rows distinct when an identifier contains the key separator", () => {
        const policy = policyDocument(1);
        // `a:b` + `c` and `a` + `b:c` share one `:`-joined key.
        const analysis = estimateFamilyDeltas({
            observations: [
                { coordinateId: "a:b", familyId: "c", endpoint: "mc-on-vs-mc-off", delta: 0.3, runHealth: "completed" },
                { coordinateId: "a:b", familyId: "c", endpoint: "mc-on-vs-compaction", delta: 0.3, runHealth: "completed" },
                { coordinateId: "a:b", familyId: "c", endpoint: "retrieval", delta: 0.5, runHealth: "completed" },
                { coordinateId: "a", familyId: "b:c", endpoint: "formation", delta: 0.7, runHealth: "completed" },
            ],
            minimumAnalyzableFamilyCount: 1,
            bootstrapSeed: 17,
            bootstrapResamples: 2000,
            lane: {
                poolManifestFingerprint: H1,
                pinnedSnapshotId: "anthropic-model-20260830",
                policyFingerprint: policy.policyFingerprint,
                pairedFactsFingerprint: PAIRED_FACTS,
            },
        });
        const built = report({ policyDocument: policy, analysis });
        expect(built.body.regret.raw.map(({ coordinateId, familyId, retrieval, formation }) =>
            [coordinateId, familyId, retrieval, formation])).toEqual([
            ["a", "b:c", null, 0.7],
            ["a:b", "c", 0.5, null],
        ]);
    });

    it("rejects a ready policy whose estimator settings the analysis does not honor", () => {
        const policy = policyDocument(2);
        expect(() => report({
            policyDocument: policyDocument(5),
            analysis: analysisFixture(canonicalFingerprint({
                minimumAnalyzableFamilyCount: 5,
                targetMinimumDetectableDelta: 0.1,
            })),
        })).toThrow(/policy-minimum-family-count-mismatch/);
        expect(() => report({
            policyDocument: {
                schema: POLICY_OWNER_SCHEMA,
                owner: "magic-context-x4l.14",
                status: "ready",
                policy: { targetMinimumDetectableDelta: 0.1 },
                policyFingerprint: canonicalFingerprint({ targetMinimumDetectableDelta: 0.1 }),
            },
            analysis: analysisFixture(canonicalFingerprint({ targetMinimumDetectableDelta: 0.1 })),
        })).toThrow(/policy-minimum-family-count-missing/);
        expect(report({ policyDocument: policy, analysis: analysisFixture(policy.policyFingerprint) })
            .body.analysis.minimumAnalyzableFamilyCount).toBe(2);
    });

    it("rejects an analysis stamped for a different cohort than the supplied pairs", () => {
        expect(() => report({ pairs: [pair(9)] }))
            .toThrow(/analysis-paired-facts-mismatch/);
    });

    it("rejects a ready policy whose detectable delta is unusable", () => {
        const payload = { minimumAnalyzableFamilyCount: 2, targetMinimumDetectableDelta: 0 };
        expect(() => report({
            policyDocument: {
                schema: POLICY_OWNER_SCHEMA,
                owner: "magic-context-x4l.14",
                status: "ready",
                policy: payload,
                policyFingerprint: canonicalFingerprint(payload),
            },
            analysis: analysisFixture(canonicalFingerprint(payload)),
        })).toThrow(/policy-detectable-delta-invalid/);
    });

    it("rejects arm and reason identifiers outside the declared contract", () => {
        expect(() => report({
            exclusions: [{ armId: "mc-onn" as never, reasonCode: "provider-unavailable", count: 1 }],
        })).toThrow(/exclusion-arm-invalid-mc-onn/);
        expect(() => report({
            exclusions: [{ armId: "mc-off", reasonCode: "provider-gone" as never, count: 1 }],
        })).toThrow(/exclusion-reason-code-invalid-provider-gone/);
        expect(() => report({
            secondaryMetrics: {
                invalidSuccessRateByArm: {},
                finalAttemptTokensByArm: { "mc-onn": 1 } as never,
                finalAttemptWallClockMsByArm: {},
                finalAttemptTurnsByArm: {},
            },
        })).toThrow(/metric-arm-invalid-mc-onn/);
        // Healthy evidence means every primary arm ran, so the builder refuses a map missing one, as the parser does.
        expect(() => report({
            secondaryMetrics: {
                invalidSuccessRateByArm: { "mc-on": 0.1, "mc-off": 0 },
                finalAttemptTokensByArm: { "mc-on": 1000, "mc-off": 800, compaction: 900 },
                finalAttemptWallClockMsByArm: { "mc-on": 4000, "mc-off": 3000, compaction: 3500 },
                finalAttemptTurnsByArm: { "mc-on": 4, "mc-off": 3, compaction: 3 },
            },
        })).toThrow(/metric-arm-missing-invalidSuccessRateByArm-compaction/);
        // The parser requires a positive plan, so the builder refuses an empty one too.
        expect(() => report({
            runSummary: { ...report().body.runSummary, plannedCoordinates: 0, healthyCoordinates: 0 },
        })).toThrow(/run-summary-invalid/);
    });

    it("separates a schema mismatch from a fingerprint mismatch when publishing", () => {
        const built = report();
        expect(() => publishPairedDeltaReport(
            { ...built, schema: "paired-delta-report/v2" as never },
            "/unused",
        )).toThrow(/schema-invalid/);
    });
});

function rolloutRecord(
    scenarioId: string,
    replicateIndex: number,
    armId: PrimaryArm,
    validSuccess: boolean,
    options: {
        runHealth?: RolloutRecord["cell"]["runHealth"];
        costSource?: RolloutRecord["costSource"];
        priorAttemptsCostUsd?: number;
    } = {},
): RolloutRecord {
    const runHealth = options.runHealth ?? "completed";
    return {
        schema: "paired-delta-rollout/v1",
        poolManifestFingerprint: H1,
        scenarioId,
        armId,
        replicateIndex,
        repoCommit: "abc123",
        openCodeVersion: "1.18.25",
        pinnedProviderId: "anthropic",
        pinnedSnapshotId: "claude-sonnet-4-5-20250929",
        echoedProviderId: "anthropic",
        echoedModelId: "claude-sonnet-4-5-20250929",
        baseScriptFingerprint: H2,
        intervention: { kind: "none", value: null },
        cell: {
            armId,
            /** `check-file` passes either way, so a wrong answer is a passing check with no valid success. */
            checksPassed: validSuccess ? 2 : 1,
            checksTotal: 2,
            criticalPassed: validSuccess ? 1 : 0,
            criticalTotal: 1,
            invalidSuccess: false,
            runHealth,
            reasonCode: runHealth === "completed" ? null : "provider-unavailable",
        },
        checks: [
            { id: "check-file", passed: true },
            { id: "check-answer", passed: validSuccess },
        ],
        usage: { input: 10, output: 5, cacheCreation: 0, cacheRead: 0 },
        costUsd: 1.25,
        priorAttemptsCostUsd: options.priorAttemptsCostUsd ?? 0,
        maxAttemptCostUsd: 1.25,
        costSource: options.costSource ?? "observed",
        wallClockMs: 1000,
        turns: 3,
        harnessDisposed: true,
    };
}

/** A coordinate contributes paired deltas only when every primary arm completed. */
function coordinate(
    scenarioId: string,
    replicateIndex: number,
    outcomes: Record<PrimaryArm, boolean>,
): RolloutRecord[] {
    return PRIMARY_ARM_IDS.map((armId) =>
        rolloutRecord(scenarioId, replicateIndex, armId, outcomes[armId]));
}

describe("paired-delta calibration record", () => {
    const families = new Map([
        ["var-a", "fam-one"],
        ["var-b", "fam-two"],
    ]);
    const decisions = {
        familyCount: 8,
        replicateCount: 3,
        cadence: "weekly-and-release",
    } as const;
    const build = (
        records: readonly RolloutRecord[],
        overrides: {
            runStatus?: Parameters<typeof buildCalibrationRecord>[0]["runStatus"];
            targetMinimumDetectableDelta?: number;
            scenarioFamilies?: ReadonlyMap<string, string>;
        } = {},
    ) => buildCalibrationRecord({
        records,
        scenarioFamilies: overrides.scenarioFamilies ?? families,
        runStatus: overrides.runStatus ?? "completed",
        poolManifestFingerprint: H1,
        pinnedSnapshotId: "claude-sonnet-4-5-20250929",
        policyFingerprint: H2,
        implementationDigest: "abc123",
        targetMinimumDetectableDelta: overrides.targetMinimumDetectableDelta ?? 0.15,
        decisions,
    });

    /**
     * `fam-one` alternates `mc-off` while `compaction` tracks `mc-on`, so the
     * mc-off endpoint is noisy and the compaction endpoint is constant.
     * `fam-two` is quiet on both.
     */
    const split = [
        ...coordinate("var-a", 0, { "mc-on": true, "mc-off": false, compaction: true }),
        ...coordinate("var-a", 1, { "mc-on": true, "mc-off": true, compaction: true }),
        ...coordinate("var-a", 2, { "mc-on": true, "mc-off": false, compaction: true }),
        ...coordinate("var-b", 0, { "mc-on": true, "mc-off": true, compaction: true }),
        ...coordinate("var-b", 1, { "mc-on": true, "mc-off": true, compaction: true }),
        ...coordinate("var-b", 2, { "mc-on": true, "mc-off": true, compaction: true }),
    ];

    /** Every series varies, so the pilot establishes variance for each one. */
    const varyingEverywhere = [
        ...coordinate("var-a", 0, { "mc-on": true, "mc-off": false, compaction: true }),
        ...coordinate("var-a", 1, { "mc-on": true, "mc-off": true, compaction: false }),
        ...coordinate("var-a", 2, { "mc-on": true, "mc-off": false, compaction: true }),
        ...coordinate("var-b", 0, { "mc-on": true, "mc-off": true, compaction: false }),
        ...coordinate("var-b", 1, { "mc-on": true, "mc-off": false, compaction: true }),
        ...coordinate("var-b", 2, { "mc-on": true, "mc-off": true, compaction: false }),
    ];

    it("refuses to size from a pilot that established no variance", () => {
        const established = build(varyingEverywhere);

        expect(established.varianceEstablished).toBe(true);
        expect(established.validForPoolSizing).toBe(true);
        // A constant series does not establish zero population variance, only too small a pilot.
        expect(build(split).varianceEstablished).toBe(false);
        expect(build(split).validForPoolSizing).toBe(false);
    });

    it("scores the preregistered valid-success endpoint as binary", () => {
        // Every arm passes `check-file`, so a check average would report 0.5 rather than 0.
        const built = build(split);
        const mcOff = built.familyNoise
            .find((noise) => noise.familyId === "fam-one" && noise.endpoint === "mc-on-vs-mc-off");

        expect(mcOff?.spread).toBe(1);
        expect(mcOff?.observationCount).toBe(3);
    });

    it("keeps endpoint identity so a constant baseline cannot dilute a noisy one", () => {
        const built = build(split);

        expect(built.familyNoise.map(({ familyId, endpoint }) => `${familyId}:${endpoint}`))
            .toEqual([
                "fam-one:mc-on-vs-compaction",
                "fam-one:mc-on-vs-mc-off",
                "fam-two:mc-on-vs-compaction",
                "fam-two:mc-on-vs-mc-off",
            ]);
        const worst = Math.max(...built.familyNoise.map(({ variance }) => variance));
        const pooled = [1, 0, 1, 0, 0, 0];
        const pooledMean = pooled.reduce((sum, value) => sum + value, 0) / pooled.length;
        const pooledVariance = pooled
            .reduce((sum, value) => sum + (value - pooledMean) ** 2, 0) / (pooled.length - 1);

        expect(worst).toBeGreaterThan(pooledVariance);
        /** `fam-two` is constant on both endpoints, so this pilot establishes no variance for it. */
        expect(built.varianceEstablished).toBe(false);
        expect(built.validForPoolSizing).toBe(false);
        const { recordFingerprint, ...body } = built;
        expect(recordFingerprint).toBe(canonicalFingerprint(body));
    });

    it("sizes the pool from the worst endpoint variance and the target delta", () => {
        const quiet = build([
            ...coordinate("var-a", 0, { "mc-on": true, "mc-off": true, compaction: true }),
            ...coordinate("var-a", 1, { "mc-on": true, "mc-off": true, compaction: true }),
            ...coordinate("var-a", 2, { "mc-on": true, "mc-off": true, compaction: true }),
            ...coordinate("var-b", 0, { "mc-on": true, "mc-off": true, compaction: true }),
            ...coordinate("var-b", 1, { "mc-on": true, "mc-off": true, compaction: true }),
            ...coordinate("var-b", 2, { "mc-on": true, "mc-off": true, compaction: true }),
        ]);
        const built = build(split);
        const worst = Math.max(...built.familyNoise.map(({ variance }) => variance));

        expect(quiet.decisions.poolSize).toBe(decisions.familyCount);
        expect(built.decisions.poolSize).toBe(
            Math.ceil(((1.959964 + 0.841621) ** 2 * worst) / 0.15 ** 2) * decisions.familyCount,
        );
    });

    it("widens the pool as the target delta shrinks", () => {
        expect(build(split, { targetMinimumDetectableDelta: 0.05 }).decisions.poolSize)
            .toBeGreaterThan(build(split).decisions.poolSize);
    });

    it("rejects a non-positive target delta", () => {
        expect(() => build(split, { targetMinimumDetectableDelta: 0 }))
            .toThrow(/target-delta-invalid/);
    });

    it("marks cap-terminated calibration invalid for sizing", () => {
        expect(build(split, { runStatus: "cost-cap-reached" }).validForPoolSizing).toBe(false);
    });

    it("separates observed spend, estimated reserves, and retry spend", () => {
        const built = build([
            ...split,
            rolloutRecord("var-a", 0, "mc-off", false, {
                runHealth: "crash",
                costSource: "estimated",
                priorAttemptsCostUsd: 0.75,
            }),
        ]);

        expect(built.measuredCostUsd).toBe(18 * 1.25);
        expect(built.estimatedReserveUsd).toBe(1.25);
        expect(built.retrySpendUsd).toBe(0.75);
        // Duration is the surviving attempts only: the record keeps prior spend, not prior wall clock.
        expect(built.finalAttemptWallClockMs).toBe(19 * 1000);
    });

    it("ignores coordinates whose paired baseline arms did not complete", () => {
        const built = build([
            ...coordinate("var-a", 0, { "mc-on": true, "mc-off": false, compaction: true }),
            ...coordinate("var-a", 1, { "mc-on": true, "mc-off": true, compaction: true }),
            ...coordinate("var-a", 2, { "mc-on": true, "mc-off": false, compaction: true }),
            rolloutRecord("var-b", 0, "mc-on", true),
            rolloutRecord("var-b", 0, "mc-off", false, { runHealth: "unavailable" }),
            rolloutRecord("var-b", 0, "compaction", true),
        ]);

        expect(new Set(built.familyNoise.map(({ familyId }) => familyId)))
            .toEqual(new Set(["fam-one"]));
        expect(built.validForPoolSizing).toBe(false);
    });

    it("requires every selected scenario to reach the configured replicate depth", () => {
        const built = build(split, {
            scenarioFamilies: new Map([
                ["var-a", "fam-one"],
                ["var-b", "fam-two"],
                ["var-c", "fam-two"],
            ]),
        });

        expect(built.validForPoolSizing).toBe(false);
    });

    it("derives one resolvable floor per family and endpoint", () => {
        const floors = calibrationNoiseFloors(build(split));
        const one = floors.find(({ familyId, endpoint }) =>
            familyId === "fam-one" && endpoint === "mc-on-vs-mc-off")!;
        const noise = build(split).familyNoise
            .find((row) => row.familyId === "fam-one" && row.endpoint === "mc-on-vs-mc-off")!;

        /** Endpoint identity is kept, so a noisy baseline cannot withhold resolution from a stable one. */
        expect(floors.map(({ familyId, endpoint }) => `${familyId}:${endpoint}`)).toEqual([
            "fam-one:mc-on-vs-compaction",
            "fam-one:mc-on-vs-mc-off",
            "fam-two:mc-on-vs-compaction",
            "fam-two:mc-on-vs-mc-off",
        ]);
        /**
         * A valid-success delta is one of -1, 0, 1, so a range-based floor would be at least 1 and
         * mark every family inside it, leaving no endpoint able to resolve.
         */
        expect(noise.spread).toBe(1);
        expect(one.value).toBeLessThan(1);
        expect(one.value).toBeCloseTo(
            1.959964 * Math.sqrt(noise.variance / noise.observationCount),
            12,
        );
        expect(one.interval).toEqual({ lower: 0, upper: one.value });
        expect(() => estimateFamilyDeltas({
            observations: [
                {
                    coordinateId: "var-a:0",
                    familyId: "fam-one",
                    endpoint: "mc-on-vs-mc-off",
                    delta: 0.3,
                    runHealth: "completed",
                },
                {
                    coordinateId: "var-b:0",
                    familyId: "fam-two",
                    endpoint: "mc-on-vs-mc-off",
                    delta: 0.1,
                    runHealth: "completed",
                },
            ],
            minimumAnalyzableFamilyCount: 2,
            bootstrapSeed: 17,
            bootstrapResamples: 2000,
            lane: {
                poolManifestFingerprint: H1,
                pinnedSnapshotId: "anthropic-model-20260830",
                policyFingerprint: H2,
                pairedFactsFingerprint: PAIRED_FACTS,
            },
            noiseFloors: floors,
        })).not.toThrow();
    });

    it("rejects a record whose policy fingerprint is not a digest", () => {
        expect(() => buildCalibrationRecord({
            records: split,
            scenarioFamilies: families,
            runStatus: "completed",
            poolManifestFingerprint: H1,
            pinnedSnapshotId: "claude-sonnet-4-5-20250929",
            policyFingerprint: "not-a-digest",
            implementationDigest: "abc123",
            targetMinimumDetectableDelta: 0.15,
            decisions,
        })).toThrow(/policy-fingerprint-invalid/);
    });
});

describe("paired-delta calibration record reader", () => {
    const written = (overrides: Record<string, unknown>) => {
        const built = buildCalibrationRecord({
            records: [
                ...coordinate("var-a", 0, { "mc-on": true, "mc-off": false, compaction: true }),
                ...coordinate("var-a", 1, { "mc-on": true, "mc-off": true, compaction: false }),
                ...coordinate("var-a", 2, { "mc-on": true, "mc-off": false, compaction: true }),
            ],
            scenarioFamilies: new Map([["var-a", "fam-one"]]),
            runStatus: "completed",
            poolManifestFingerprint: H1,
            pinnedSnapshotId: "claude-sonnet-4-5-20250929",
            policyFingerprint: H2,
            implementationDigest: "abc123",
            targetMinimumDetectableDelta: 0.15,
            decisions: {
                familyCount: 1,
                replicateCount: 3,
                cadence: "weekly-and-release",
            },
        });
        const { recordFingerprint, ...body } = { ...built, ...overrides };
        // Re-fingerprinted, so the reader cannot reject these on consistency alone.
        return { ...body, recordFingerprint: canonicalFingerprint(body) };
    };
    const root = mkdtempSync(join(tmpdir(), "paired-delta-read-"));
    const write = (record: unknown): string => {
        const path = join(root, `record-${Math.random().toString(16).slice(2)}.json`);
        require("node:fs").writeFileSync(path, JSON.stringify(record));
        return path;
    };

    it("accepts a record it wrote itself", () => {
        expect(readCalibrationRecord(write(written({}))).validForPoolSizing).toBe(true);
    });

    it("rejects a validity claim the recorded evidence does not support", () => {
        const record = written({});
        // One series instead of both endpoints for the family.
        expect(() => readCalibrationRecord(write(written({
            familyNoise: (record.familyNoise as unknown[]).slice(0, 1),
        })))).toThrow(/validity-inconsistent/);
        // A pool size that is not what the recorded variance and target delta imply.
        expect(() => readCalibrationRecord(write(written({
            decisions: { ...(record.decisions as object), poolSize: 1 },
        })))).toThrow(/validity-inconsistent/);
    });

    it("rejects sizing decisions the cohort gates would silently pass", () => {
        // `cohort < undefined` is false, so an absent poolSize disables the gate rather than failing.
        // `undefined` is not representable in JSON, so an absent object arrives as a fingerprint mismatch.
        for (const decisions of [
            null,
            { familyCount: 1, replicateCount: 3, cadence: "weekly-and-release" },
            { poolSize: 4, replicateCount: 3, cadence: "weekly-and-release" },
            { poolSize: 0, familyCount: 1, replicateCount: 3, cadence: "weekly-and-release" },
            { poolSize: 4, familyCount: 1, replicateCount: 0, cadence: "weekly-and-release" },
        ]) {
            expect(() => readCalibrationRecord(write(written({ decisions }))))
                .toThrow(/decisions-invalid/);
        }
    });

    it("rejects a floor keyed by an endpoint the estimator never looks up", () => {
        const record = written({});
        const familyNoise = (record.familyNoise as unknown[])
            .map((noise, index) => (index === 0
                ? { ...(noise as object), endpoint: "latency" }
                : noise));

        /** `validForPoolSizing: false` so the endpoint check is what rejects, not the validity recompute. */
        expect(() => readCalibrationRecord(write(written({
            familyNoise,
            validForPoolSizing: false,
        })))).toThrow(/record-invalid/);
    });
});

describe("paired-delta calibration reader: series integrity", () => {
    const build3 = () => buildCalibrationRecord({
        records: [
            ...coordinate("var-a", 0, { "mc-on": true, "mc-off": false, compaction: true }),
            ...coordinate("var-a", 1, { "mc-on": true, "mc-off": true, compaction: false }),
            ...coordinate("var-a", 2, { "mc-on": true, "mc-off": false, compaction: true }),
        ],
        scenarioFamilies: new Map([["var-a", "fam-one"]]),
        runStatus: "completed",
        poolManifestFingerprint: H1,
        pinnedSnapshotId: "claude-sonnet-4-5-20250929",
        policyFingerprint: H2,
        implementationDigest: "abc123",
        targetMinimumDetectableDelta: 0.15,
        decisions: { familyCount: 1, replicateCount: 3, cadence: "weekly-and-release" },
    });
    const root = mkdtempSync(join(tmpdir(), "paired-delta-series-"));
    const rewrite = (overrides: Record<string, unknown>): string => {
        const { recordFingerprint, ...body } = { ...build3(), ...overrides };
        const path = join(root, `record-${Math.random().toString(16).slice(2)}.json`);
        require("node:fs").writeFileSync(
            path,
            JSON.stringify({ ...body, recordFingerprint: canonicalFingerprint(body) }),
        );
        return path;
    };

    it("rejects a duplicated family and endpoint series before any spend", () => {
        const rows = build3().familyNoise;

        // A repeat satisfies a `some`-based coverage test, then the estimator rejects it after the run.
        expect(() => readCalibrationRecord(rewrite({ familyNoise: [...rows, rows[0]] })))
            .toThrow(/validity-inconsistent/);
    });

    it("requires the observed depth to reach the declared replicate count", () => {
        const shallow = build3().familyNoise.map((noise) => ({ ...noise, observationCount: 2 }));

        expect(() => readCalibrationRecord(rewrite({ familyNoise: shallow })))
            .toThrow(/validity-inconsistent/);
    });

    it("rejects a noise summary no observations could have produced", () => {
        // A token variance clears `variance > 0` and shrinks the derived pool to whatever the cohort clears.
        const impossible = build3().familyNoise.map((noise) => ({
            ...noise,
            spread: 0,
            variance: 1e-12,
        }));

        expect(() => readCalibrationRecord(rewrite({ familyNoise: impossible })))
            .toThrow(/validity-inconsistent/);
    });

    it("rejects a variance below the discrete minimum for its observation count", () => {
        // Deltas are `{-1, 0, 1}`, so three nonconstant observations cannot vary by less than 1/3.
        const belowFloor = build3().familyNoise.map((noise) => ({
            ...noise,
            spread: 1,
            variance: 0.1,
        }));

        expect(() => readCalibrationRecord(rewrite({ familyNoise: belowFloor })))
            .toThrow(/validity-inconsistent/);
    });

    it("rejects a two-point spread whose variance only a one-point spread can reach", () => {
        // Spread 2 requires both -1 and 1, making 1 the minimum variance for three observations.
        const forged = build3().familyNoise.map((noise) => ({
            ...noise,
            spread: 2,
            variance: 1 / 3,
        }));

        expect(() => readCalibrationRecord(rewrite({ familyNoise: forged })))
            .toThrow(/validity-inconsistent/);
    });

    it("rejects a variance between two reachable discrete values", () => {
        // Three observations spanning 2 produce only 1 or 4/3; 1.01 clears a floor of 1 and nothing else.
        const between = build3().familyNoise.map((noise) => ({
            ...noise,
            spread: 2,
            variance: 1.01,
        }));

        expect(() => readCalibrationRecord(rewrite({ familyNoise: between })))
            .toThrow(/validity-inconsistent/);
    });

    it("accepts a two-point spread at its own floor", () => {
        // Deltas of +1, -1, and 0 span 2 with variance exactly 1.
        const spread2 = buildCalibrationRecord({
            records: [
                ...coordinate("var-a", 0, { "mc-on": true, "mc-off": false, compaction: false }),
                ...coordinate("var-a", 1, { "mc-on": false, "mc-off": true, compaction: true }),
                ...coordinate("var-a", 2, { "mc-on": true, "mc-off": true, compaction: true }),
            ],
            scenarioFamilies: new Map([["var-a", "fam-one"]]),
            runStatus: "completed",
            poolManifestFingerprint: H1,
            pinnedSnapshotId: "claude-sonnet-4-5-20250929",
            policyFingerprint: H2,
            implementationDigest: "abc123",
            targetMinimumDetectableDelta: 0.15,
            decisions: { familyCount: 1, replicateCount: 3, cadence: "weekly-and-release" },
        });
        expect(spread2.familyNoise.map(({ spread, variance }) => [spread, variance]))
            .toEqual([[2, 1], [2, 1]]);

        const path = join(root, `record-${Math.random().toString(16).slice(2)}.json`);
        require("node:fs").writeFileSync(path, JSON.stringify(spread2));
        expect(readCalibrationRecord(path).validForPoolSizing).toBe(true);
    });

    it("accepts the writer's rounded variance at the spread-1 floor", () => {
        // Eleven observations with one differing land one ulp below 1/11 after rounding the mean.
        const eleven = buildCalibrationRecord({
            records: Array.from({ length: 11 }, (_, index) =>
                coordinate("var-a", index, {
                    "mc-on": true,
                    "mc-off": index === 0,
                    compaction: index === 0,
                })).flat(),
            scenarioFamilies: new Map([["var-a", "fam-one"]]),
            runStatus: "completed",
            poolManifestFingerprint: H1,
            pinnedSnapshotId: "claude-sonnet-4-5-20250929",
            policyFingerprint: H2,
            implementationDigest: "abc123",
            targetMinimumDetectableDelta: 0.15,
            decisions: { familyCount: 1, replicateCount: 11, cadence: "weekly-and-release" },
        });
        expect(eleven.validForPoolSizing).toBe(true);
        expect(eleven.familyNoise[0]?.variance).toBeLessThan(1 / 11);

        const path = join(root, `record-${Math.random().toString(16).slice(2)}.json`);
        require("node:fs").writeFileSync(path, JSON.stringify(eleven));
        expect(readCalibrationRecord(path).validForPoolSizing).toBe(true);
    });

    it("reads a record built at a replicate depth of one", () => {
        // Two scenarios in one family reach two observations per series at depth 1.
        const shallow = buildCalibrationRecord({
            records: [
                ...coordinate("var-a", 0, { "mc-on": true, "mc-off": false, compaction: true }),
                ...coordinate("var-b", 0, { "mc-on": true, "mc-off": true, compaction: false }),
            ],
            scenarioFamilies: new Map([["var-a", "fam-one"], ["var-b", "fam-one"]]),
            runStatus: "completed",
            poolManifestFingerprint: H1,
            pinnedSnapshotId: "claude-sonnet-4-5-20250929",
            policyFingerprint: H2,
            implementationDigest: "abc123",
            targetMinimumDetectableDelta: 0.15,
            decisions: { familyCount: 1, replicateCount: 1, cadence: "weekly-and-release" },
        });
        expect(shallow.validForPoolSizing).toBe(true);

        const path = join(root, `record-${Math.random().toString(16).slice(2)}.json`);
        require("node:fs").writeFileSync(path, JSON.stringify(shallow));
        expect(readCalibrationRecord(path).validForPoolSizing).toBe(true);
    });

    it("rejects an observation count no declared depth could supply before enumerating", () => {
        // A fingerprint-valid record can claim any count; the reader must refuse it in constant time.
        const oversized = build3().familyNoise.map((noise) => ({
            ...noise,
            observationCount: 50_000_000,
        }));
        const started = performance.now();

        expect(() => readCalibrationRecord(rewrite({ familyNoise: oversized })))
            .toThrow(/observation-count-exceeds-depth/);
        expect(performance.now() - started).toBeLessThan(1_000);
    });

    it("rejects an observation count above the fixed ceiling whatever the record declares", () => {
        // Depth and counts agree with each other, so only a ceiling the record cannot move stops the enumeration.
        const n = 1_000_000;
        const inflated = build3();
        const started = performance.now();

        expect(() => readCalibrationRecord(rewrite({
            decisions: { ...inflated.decisions, replicateCount: n },
            scenarioDepth: { "var-a": n },
            familyNoise: inflated.familyNoise.map((noise) => ({ ...noise, observationCount: n })),
        }))).toThrow(/observation-count-exceeds-ceiling/);
        expect(performance.now() - started).toBeLessThan(1_000);
    });

    it("rejects a scenario depth above the declared replicate count", () => {
        // Inflating depth and series counts together clears the family-sum cross-check.
        const inflated = build3();

        expect(() => readCalibrationRecord(rewrite({
            scenarioDepth: { "var-a": 4 },
            familyNoise: inflated.familyNoise.map((noise) => ({ ...noise, observationCount: 4 })),
        }))).toThrow(/validity-inconsistent/);
    });
});

describe("parsePairedDeltaReport", () => {
    it("round-trips builder output and rejects the wrong schema literal", () => {
        const built = report();
        expect(parsePairedDeltaReport(JSON.parse(JSON.stringify(built)))).toEqual(built);
        expect(() => parsePairedDeltaReport({ ...built, schema: "paired-delta-report/v0" })).toThrow(/report\.schema: version-invalid/);
    });

    it("rejects an extra field at any nesting level naming the path", () => {
        const built = report();
        expect(() => parsePairedDeltaReport({ ...built, extra: 1 })).toThrow(/^report: fields-invalid/);
        const nested = structuredClone(built) as unknown as { body: Record<string, unknown> };
        (nested.body.runSummary as Record<string, unknown>).operator = "x";
        expect(() => parsePairedDeltaReport(nested)).toThrow(/report\.body\.runSummary: fields-invalid/);
        const deep = structuredClone(built) as unknown as { body: { analysis: { endpoints: Record<string, unknown>[] } } };
        deep.body.analysis.endpoints[0]!.weight = 2;
        expect(() => parsePairedDeltaReport(deep)).toThrow(/report\.body\.analysis\.endpoints\[0\]: fields-invalid/);
    });

    it("rejects a tampered report fingerprint and unknown enum values", () => {
        const built = report();
        const tampered = structuredClone(built);
        tampered.body.runSummary.spentUsd = 0;
        expect(() => parsePairedDeltaReport(tampered)).toThrow(/report\.reportFingerprint: fingerprint-mismatch/);
        const badArm = structuredClone(built) as unknown as { body: { exclusions: Record<string, unknown>[] } };
        badArm.body.exclusions[0]!.armId = "r9";
        expect(() => parsePairedDeltaReport(badArm)).toThrow(/report\.body\.exclusions\[0\]\.armId: enum-invalid/);
        const badStatus = structuredClone(built) as unknown as { body: { runSummary: Record<string, unknown> } };
        badStatus.body.runSummary.status = "done";
        expect(() => parsePairedDeltaReport(badStatus)).toThrow(/report\.body\.runSummary\.status: enum-invalid/);
    });

    it("rejects a fingerprint-consistent body that violates the builder's cross-field invariants", () => {
        const built = report();
        // The fingerprint is an unkeyed digest, so a writer can recompute it over a rewritten body.
        const forge = (mutate: (body: typeof built.body) => void): unknown => {
            const body = structuredClone(built.body);
            mutate(body);
            return { schema: built.schema, body, reportFingerprint: canonicalFingerprint(body) };
        };
        expect(() => parsePairedDeltaReport(forge((body) => { body.analysis.evidenceSufficient = false; })))
            .toThrow(/report\.body\.analysis\.evidenceSufficient: derived-mismatch/);
        expect(() => parsePairedDeltaReport(forge((body) => { body.analysis.endpoints[0]!.familyCount = 99; })))
            .toThrow(/report\.body\.analysis\.endpoints\[0\]\.familyCount: derived-mismatch/);
        expect(() => parsePairedDeltaReport(forge((body) => {
            body.analysis.endpoints.push({ ...body.analysis.endpoints[0]!, endpoint: "representation" });
        }))).toThrow(/report\.body\.analysis\.endpoints\[2\]\.endpoint: enum-invalid/);
        expect(() => parsePairedDeltaReport(forge((body) => { body.analysis.policyFingerprint = H1; })))
            .toThrow(/report\.body\.analysis: lane-binding-mismatch/);
        expect(() => parsePairedDeltaReport(forge((body) => { body.regret.providerMixed = []; })))
            .toThrow(/report\.body\.regret\.providerMixed: analysis-mismatch/);
        expect(() => parsePairedDeltaReport(forge((body) => { body.regret.raw[0]!.retrieval = 0.9; })))
            .toThrow(/report\.body\.regret\.raw: analysis-mismatch/);
        expect(() => parsePairedDeltaReport(forge((body) => { body.secondaryMetrics.invalidSuccessRateByArm["mc-on"] = 1.5; })))
            .toThrow(/invalidSuccessRateByArm\.mc-on: number-invalid/);
        expect(() => parsePairedDeltaReport(forge((body) => { body.secondaryMetrics.finalAttemptTokensByArm["mc-on"] = -1; })))
            .toThrow(/finalAttemptTokensByArm\.mc-on: integer-invalid/);
        expect(() => parsePairedDeltaReport(forge((body) => { body.runSummary.spentUsd = -1; })))
            .toThrow(/report\.body\.runSummary\.spentUsd: number-invalid/);
        expect(() => parsePairedDeltaReport(forge((body) => { body.runSummary.healthyCoordinates = 13; })))
            .toThrow(/report\.body\.runSummary\.healthyCoordinates: integer-invalid/);
        expect(() => parsePairedDeltaReport(forge((body) => { body.exclusions.push({ ...body.exclusions[0]! }); })))
            .toThrow(/report\.body\.exclusions: duplicate/);
        expect(() => parsePairedDeltaReport(forge((body) => { body.analysis.bootstrapResamples = 1; })))
            .toThrow(/report\.body\.analysis\.bootstrapResamples: integer-invalid/);
        expect(() => parsePairedDeltaReport(forge((body) => { body.analysis.bootstrapSeed = 0x1_0000_0000; })))
            .toThrow(/report\.body\.analysis\.bootstrapSeed: integer-invalid/);
        expect(() => parsePairedDeltaReport(forge((body) => {
            body.analysis.endpoints[0]!.pointEstimate += 0.5;
        }))).toThrow(/report\.body\.analysis\.endpoints\[0\]\.pointEstimate: derived-mismatch/);
        expect(() => parsePairedDeltaReport(forge((body) => {
            const endpoint = body.analysis.endpoints[0]!;
            endpoint.resolution = endpoint.resolution === "resolved" ? "unresolved" : "resolved";
        }))).toThrow(/report\.body\.analysis\.endpoints\[0\]\.resolution: derived-mismatch/);
        expect(() => parsePairedDeltaReport(forge((body) => {
            body.analysis.analyzableFamilyCount += 1;
            body.analysis.evidenceSufficient = body.analysis.analyzableFamilyCount >= body.analysis.minimumAnalyzableFamilyCount;
        }))).toThrow(/report\.body\.analysis\.analyzableFamilyCount: derived-mismatch/);
        // An inverted interval reads as excluding zero, which would let the resolution check pass.
        expect(() => parsePairedDeltaReport(forge((body) => {
            body.analysis.endpoints[0]!.interval = { lower: 1, upper: -1 };
        }))).toThrow(/report\.body\.analysis\.endpoints\[0\]\.interval: interval-invalid/);
        expect(() => parsePairedDeltaReport(forge((body) => {
            const family = body.analysis.endpoints[0]!.families[0]!;
            expect(family.noise).toEqual({ label: "no-noise-floor", floor: null });
            family.noise.label = "outside-floor";
        }))).toThrow(/report\.body\.analysis\.endpoints\[0\]\.families\[0\]\.noise\.label: derived-mismatch/);
        // A primary estimate needs coordinates present at both endpoints, so one endpoint alone or two
        // endpoints over different family sets is a topology the estimator cannot produce.
        expect(() => parsePairedDeltaReport(forge((body) => {
            body.analysis.endpoints = [body.analysis.endpoints[0]!];
        }))).toThrow(/report\.body\.analysis\.endpoints: paired-endpoints-required/);
        expect(() => parsePairedDeltaReport(forge((body) => {
            body.analysis.endpoints[1]!.families[0]!.familyId = "fam-elsewhere";
        }))).toThrow(/report\.body\.analysis\.endpoints: family-set-mismatch/);
        expect(() => parsePairedDeltaReport(forge((body) => {
            body.runSummary.status = "cost-cap-reached";
            body.runSummary.observedCostRollouts = 0;
        }))).toThrow(/report\.body\.runSummary\.observedCostRollouts: healthy-coordinate-shortfall/);
        expect(() => parsePairedDeltaReport(forge((body) => { body.exclusions[0]!.count = 99; })))
            .toThrow(/report\.body\.exclusions: [a-z-]+-exceeds-plan/);
        // The builder sorts exclusions and limitations, so a reordered archive is not a shape it can emit.
        expect(() => parsePairedDeltaReport(forge((body) => { body.exclusions.reverse(); })))
            .toThrow(/report\.body\.exclusions: order-invalid/);
        expect(() => parsePairedDeltaReport(forge((body) => { body.limitations = ["b caveat", "a caveat"]; })))
            .toThrow(/report\.body\.limitations: order-invalid/);
        expect(() => parsePairedDeltaReport(forge((body) => { body.runSummary.refusedRegretLadders = { vibes: 1 }; })))
            .toThrow(/report\.body\.runSummary\.refusedRegretLadders\.vibes: enum-invalid/);
        expect(() => parsePairedDeltaReport(forge((body) => { body.runSummary.refusedRegretLadders = { "intervention-mismatch": 99 }; })))
            .toThrow(/report\.body\.runSummary\.refusedRegretLadders: exceeds-plan/);
        // Outside calibration, completeness follows from sufficiency and a fully healthy matrix.
        expect(() => parsePairedDeltaReport(forge((body) => {
            body.runSummary.calibrationFingerprint = H1;
            body.runSummary.evidenceComplete = !body.runSummary.evidenceComplete;
        }))).toThrow(/report\.body\.runSummary\.evidenceComplete: derived-mismatch/);
        // A calibration report derives completeness from calibration validity, which the body does not carry,
        // but validity needs a completed run over a full matrix, so a partial matrix cannot be complete.
        expect(() => parsePairedDeltaReport(forge((body) => {
            expect(body.runSummary.calibrationFingerprint).toBeNull();
            expect(body.runSummary.healthyCoordinates).toBeLessThan(body.runSummary.plannedCoordinates);
            body.runSummary.evidenceComplete = true;
        }))).toThrow(/report\.body\.runSummary\.evidenceComplete: derived-mismatch/);
        expect(() => parsePairedDeltaReport(forge((body) => {
            body.runSummary.healthyCoordinates = body.runSummary.plannedCoordinates;
            body.runSummary.observedCostRollouts = 36;
            body.runSummary.estimatedCostRollouts = 0;
            body.exclusions = [];
            body.runSummary.evidenceComplete = true;
        }))).not.toThrow();
        // Healthy evidence implies every primary arm appears in each secondary-metric map.
        expect(() => parsePairedDeltaReport(forge((body) => { delete body.secondaryMetrics.invalidSuccessRateByArm["mc-on"]; })))
            .toThrow(/report\.body\.secondaryMetrics\.invalidSuccessRateByArm\.mc-on: arm-required/);
        // Refusals and raw ladders partition the planned coordinates.
        expect(() => parsePairedDeltaReport(forge((body) => {
            body.runSummary.refusedRegretLadders = { "intervention-mismatch": 12 };
        }))).toThrow(/report\.body\.analysis\.rawRegretRecords: exceeds-plan/);
        // A floor is 1.96 * sqrt(variance / n) over deltas in {-1, 0, 1}, so it stays under 2.
        expect(() => parsePairedDeltaReport(forge((body) => {
            const family = body.analysis.endpoints[0]!.families[0]!;
            family.noise.floor = { endpoint: "mc-on-vs-compaction", familyId: family.familyId, value: 3, interval: { lower: 0, upper: 3 } };
            family.noise.label = "inside-floor";
            family.resolution = "unresolved";
            body.analysis.endpoints[0]!.resolution = "unresolved";
        }))).toThrow(/noise\.floor\.value: number-invalid/);
        // Rungs run in order and stop at the first failure.
        expect(() => parsePairedDeltaReport(forge((body) => {
            body.analysis.rawRegretRecords = body.analysis.rawRegretRecords.filter(({ endpoint }) => endpoint !== "retrieval");
        }))).toThrow(/report\.body\.analysis\.rawRegretRecords: ladder-prefix-missing-/);
        // A regret family's point estimate is the mean of its raw deltas.
        expect(() => parsePairedDeltaReport(forge((body) => {
            const estimate = body.analysis.providerMixedRegret[0]!;
            const family = estimate.families[0]!;
            family.pointEstimate += 0.05;
            estimate.pointEstimate = estimate.families.reduce((sum, { pointEstimate }) => sum + pointEstimate, 0) / estimate.families.length;
            body.regret.providerMixed = body.analysis.providerMixedRegret;
        }))).toThrow(/report\.body\.analysis\.providerMixedRegret\[0\]\.families\[0\]\.pointEstimate: derived-mismatch/);
        expect(() => parsePairedDeltaReport(forge((body) => {
            body.runSummary.status = "usage-unmeasured";
            body.runSummary.estimatedCostRollouts = 0;
            body.runSummary.observedCostRollouts = 36;
        }))).toThrow(/report\.body\.runSummary\.estimatedCostRollouts: status-evidence-required/);
        // An aggregate regret endpoint has raw observations behind it.
        expect(() => parsePairedDeltaReport(forge((body) => {
            body.analysis.rawRegretRecords = body.analysis.rawRegretRecords.filter(({ endpoint }) => endpoint !== "formation");
            body.regret.raw = body.regret.raw.map((row) => ({ ...row, formation: null }));
        }))).toThrow(/report\.body\.analysis: aggregate-without-raw-formation/);
        // A raw regret endpoint has its aggregate estimate.
        expect(() => parsePairedDeltaReport(forge((body) => {
            body.analysis.providerMixedRegret = body.analysis.providerMixedRegret.filter(({ endpoint }) => endpoint !== "formation");
            body.regret.providerMixed = body.analysis.providerMixedRegret;
        }))).toThrow(/report\.body\.analysis\.rawRegretRecords\[\d+\]\.endpoint: aggregate-required/);
        expect(() => parsePairedDeltaReport(forge((body) => {
            body.runSummary.plannedCoordinates = 0;
            body.runSummary.healthyCoordinates = 0;
        }))).toThrow(/report\.body\.runSummary\.plannedCoordinates: integer-invalid/);
        // A calibrated floor's interval is exactly [0, value].
        expect(() => parsePairedDeltaReport(forge((body) => {
            const family = body.analysis.endpoints[0]!.families[0]!;
            family.noise.floor = { endpoint: "mc-on-vs-compaction", familyId: family.familyId, value: 0.5, interval: { lower: 0.1, upper: 0.5 } };
        }))).toThrow(/noise\.floor\.interval: derived-mismatch/);
        // Deltas are differences of values in [0, 1].
        expect(() => parsePairedDeltaReport(forge((body) => { body.analysis.endpoints[0]!.families[0]!.pointEstimate = 2; })))
            .toThrow(/report\.body\.analysis\.endpoints\[0\]\.families\[0\]\.pointEstimate: number-invalid/);
        // Every exclusion is a final record the two cost counters also count.
        expect(() => parsePairedDeltaReport(forge((body) => {
            body.runSummary.status = "cost-cap-reached";
            body.runSummary.observedCostRollouts = 27;
            body.runSummary.estimatedCostRollouts = 0;
        }))).toThrow(/report\.body\.runSummary\.observedCostRollouts: exclusion-shortfall/);
        // A completed run stored every primary arm for every planned coordinate.
        expect(() => parsePairedDeltaReport(forge((body) => { body.runSummary.estimatedCostRollouts = 0; })))
            .toThrow(/report\.body\.runSummary\.observedCostRollouts: completed-run-shortfall/);
        // An estimated cost marks a failed cell, and every failed cell is an exclusion.
        expect(() => parsePairedDeltaReport(forge((body) => {
            body.runSummary.status = "cost-cap-reached";
            body.exclusions = [];
        }))).toThrow(/report\.body\.runSummary\.estimatedCostRollouts: exclusion-shortfall/);
        // A completed run recorded every unhealthy coordinate's failed primary cell, so each one is an exclusion.
        expect(() => parsePairedDeltaReport(forge((body) => {
            body.runSummary.estimatedCostRollouts = 1;
            body.runSummary.observedCostRollouts = 35;
            body.exclusions = [{ armId: "mc-off", reasonCode: "provider-unavailable", count: 1 }];
        }))).toThrow(/report\.body\.exclusions: unhealthy-coordinate-shortfall/);
        expect(() => parsePairedDeltaReport(forge((body) => { body.secondaryMetrics.finalAttemptTokensByArm["mc-on"] = 0.5; })))
            .toThrow(/finalAttemptTokensByArm\.mc-on: integer-invalid/);
        // A primary arm's exclusions fit within the unhealthy coordinates.
        expect(() => parsePairedDeltaReport(forge((body) => {
            body.exclusions.find(({ armId }) => armId === "compaction")!.count = 4;
        }))).toThrow(/report\.body\.exclusions: compaction-exceeds-plan/);
        expect(() => parsePairedDeltaReport(forge((body) => { body.runSummary.estimatedCostRollouts = 999; })))
            .toThrow(/report\.body\.runSummary\.observedCostRollouts: exceeds-plan/);
        // Every analyzable family needs a coordinate whose primary arms all completed.
        expect(() => parsePairedDeltaReport(forge((body) => {
            body.runSummary.healthyCoordinates = 0;
            body.runSummary.evidenceComplete = false;
        }))).toThrow(/report\.body\.analysis\.analyzableFamilyCount: healthy-coordinate-shortfall/);
        // Joining ids with a separator would let an embedded separator forge a matching family set.
        expect(() => parsePairedDeltaReport(forge((body) => {
            const [first, second] = body.analysis.endpoints;
            first!.families[0]!.familyId = "a";
            first!.families[1]!.familyId = "b\u0000c";
            second!.families[0]!.familyId = "a\u0000b";
            second!.families[1]!.familyId = "c";
        }))).toThrow(/report\.body\.analysis\.endpoints: family-set-mismatch/);
        // A family cannot be `resolved` over an interval that includes zero.
        expect(() => parsePairedDeltaReport(forge((body) => {
            const family = body.analysis.endpoints[0]!.families[0]!;
            family.interval = { lower: -1, upper: 1 };
            family.resolution = "resolved";
        }))).toThrow(/report\.body\.analysis\.endpoints\[0\]\.families\[0\]\.resolution: derived-mismatch/);
        expect(() => parsePairedDeltaReport(forge((body) => {
            body.analysis.endpoints[0]!.families[0]!.noise.floor = {
                endpoint: "mc-on-vs-mc-off",
                familyId: "fam-somebody-else",
                value: 0.5,
                interval: { lower: 0, upper: 0.5 },
            };
        }))).toThrow(/report\.body\.analysis\.endpoints\[0\]\.families\[0\]\.noise\.floor\.familyId: floor-owner-mismatch/);
        // `calibrationNoiseFloors` is the only floor producer and always names the endpoint it measured.
        expect(() => parsePairedDeltaReport(forge((body) => {
            const family = body.analysis.endpoints[0]!.families[0]!;
            family.noise.floor = { familyId: family.familyId, value: 1.5, interval: { lower: 0, upper: 1.5 } };
            family.noise.label = "inside-floor";
            family.resolution = "unresolved";
            body.analysis.endpoints[0]!.resolution = "unresolved";
        }))).toThrow(/report\.body\.analysis\.endpoints\[0\]\.families\[0\]\.noise\.floor: fields-invalid/);
        expect(() => parsePairedDeltaReport(forge((body) => {
            const endpoint = body.analysis.endpoints[0]!;
            endpoint.families = [];
            endpoint.familyCount = 0;
            endpoint.resolution = "unresolved";
        }))).toThrow(/report\.body\.analysis\.endpoints\[0\]\.families: families-required/);
        expect(() => parsePairedDeltaReport(forge((body) => {
            const family = body.analysis.endpoints[0]!.families[0]!;
            expect(body.analysis.endpoints[0]!.endpoint).toBe("mc-on-vs-compaction");
            family.noise.floor = {
                endpoint: "mc-on-vs-mc-off",
                familyId: family.familyId,
                value: 0.5,
                interval: { lower: 0, upper: 0.5 },
            };
        }))).toThrow(/report\.body\.analysis\.endpoints\[0\]\.families\[0\]\.noise\.floor\.endpoint: floor-owner-mismatch/);
    });

    it("preserves an endpoint-scoped noise floor through the round trip", () => {
        const policy = policyDocument();
        const analysis = estimateFamilyDeltas({
            observations: [
                { coordinateId: "var-a:0", familyId: "fam-a", endpoint: "mc-on-vs-mc-off", delta: 0.3, runHealth: "completed" },
                { coordinateId: "var-a:0", familyId: "fam-a", endpoint: "mc-on-vs-compaction", delta: 0.3, runHealth: "completed" },
                { coordinateId: "var-b:0", familyId: "fam-b", endpoint: "mc-on-vs-mc-off", delta: 0.1, runHealth: "completed" },
                { coordinateId: "var-b:0", familyId: "fam-b", endpoint: "mc-on-vs-compaction", delta: 0.1, runHealth: "completed" },
            ],
            minimumAnalyzableFamilyCount: 2,
            bootstrapSeed: 17,
            bootstrapResamples: 2000,
            lane: {
                poolManifestFingerprint: H1,
                pinnedSnapshotId: "anthropic-model-20260830",
                policyFingerprint: policy.policyFingerprint,
                pairedFactsFingerprint: PAIRED_FACTS,
            },
            noiseFloors: [{ familyId: "fam-a", endpoint: "mc-on-vs-mc-off", value: 0.1, interval: { lower: 0, upper: 0.1 } }],
        });
        const built = report({ policyDocument: policy, analysis });
        const endpoint = built.body.analysis.endpoints.find((entry) => entry.endpoint === "mc-on-vs-mc-off")!;
        expect(endpoint.families.find((family) => family.familyId === "fam-a")!.noise.floor?.endpoint).toBe("mc-on-vs-mc-off");
        expect(parsePairedDeltaReport(JSON.parse(JSON.stringify(built)))).toEqual(built);
    });
});
