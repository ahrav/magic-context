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
    buildPairedDeltaReport,
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
        implementationCommit: "abc123",
        pairs,
        analysis: analysisFixture(policy.policyFingerprint),
        runSummary: {
            status: "completed" as const,
            spentUsd: 12.5,
            observedCostRollouts: 6,
            estimatedCostRollouts: 1,
            refusedRegretLadders: { "intervention-mismatch": 2 },
        },
        exclusions: [
            { armId: "mc-off", reasonCode: "provider-unavailable", count: 2 },
            { armId: "compaction", reasonCode: "deadline-exceeded", count: 1 },
        ],
        secondaryMetrics: {
            invalidSuccessRateByArm: { "mc-on": 0.1, "mc-off": 0 },
            tokensByArm: { "mc-on": 1000, "mc-off": 800 },
            wallClockMsByArm: { "mc-on": 4000, "mc-off": 3000 },
            turnsByArm: { "mc-on": 8, "mc-off": 7 },
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
        changed.body.secondaryMetrics.tokensByArm["mc-on"] = 1001;
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
            implementationCommit: "abc123",
            pairs,
            analysis: built.body.analysis,
            exclusions: [],
            secondaryMetrics: {
                invalidSuccessRateByArm: {},
                tokensByArm: {},
                wallClockMsByArm: {},
                turnsByArm: {},
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
            implementationCommit: "abc123",
            pairs,
            analysis: built.body.analysis,
            exclusions: [],
            secondaryMetrics: {
                invalidSuccessRateByArm: {},
                tokensByArm: {},
                wallClockMsByArm: {},
                turnsByArm: {},
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
                tokensByArm: { "mc-onn": 1 } as never,
                wallClockMsByArm: {},
                turnsByArm: {},
            },
        })).toThrow(/metric-arm-invalid-mc-onn/);
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
        implementationCommit: "abc123",
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
        expect(built.validForPoolSizing).toBe(true);
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

    it("collapses the endpoint series to one resolvable floor per family", () => {
        // `estimateFamilyDeltas` keys one floor per family and rejects a repeated id.
        const floors = calibrationNoiseFloors(build(split));
        const one = floors.find(({ familyId }) => familyId === "fam-one")!;
        const noise = build(split).familyNoise
            .find((row) => row.familyId === "fam-one" && row.endpoint === "mc-on-vs-mc-off")!;

        expect(floors.map(({ familyId }) => familyId)).toEqual(["fam-one", "fam-two"]);
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
            implementationCommit: "abc123",
            targetMinimumDetectableDelta: 0.15,
            decisions,
        })).toThrow(/policy-fingerprint-invalid/);
    });
});
