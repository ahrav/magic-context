import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { POLICY_OWNER_SCHEMA } from "../prospective-holdout/contract";
import { estimateFamilyDeltas } from "./estimator";
import {
    buildCalibrationRecord,
    PAIRED_DELTA_REPORT_SCHEMA,
    buildPairedDeltaReport,
    publishPairedDeltaReport,
} from "./report";
import type { RolloutRecord } from "./runner";

const H1 = "1".repeat(64);
const H2 = "2".repeat(64);

function report() {
    const policy = {
        schema: POLICY_OWNER_SCHEMA,
        owner: "magic-context-x4l.14",
        status: "ready",
        policy: { minimumAnalyzableFamilyCount: 2, targetMinimumDetectableDelta: 0.1 },
        policyFingerprint: canonicalFingerprint({
            minimumAnalyzableFamilyCount: 2,
            targetMinimumDetectableDelta: 0.1,
        }),
    };
    const analysis = estimateFamilyDeltas({
        observations: [
            { coordinateId: "var-a:0", familyId: "fam-a", endpoint: "mc-on-vs-mc-off", delta: 0.3, runHealth: "completed" },
            { coordinateId: "var-b:0", familyId: "fam-b", endpoint: "mc-on-vs-mc-off", delta: 0.1, runHealth: "completed" },
            { coordinateId: "var-a:0", familyId: "fam-a", endpoint: "retrieval", delta: 0.1, runHealth: "completed" },
            { coordinateId: "var-a:0", familyId: "fam-a", endpoint: "formation", delta: 0.2, runHealth: "completed" },
        ],
        minimumAnalyzableFamilyCount: 2,
        bootstrapSeed: 17,
        bootstrapResamples: 2000,
    });
    return buildPairedDeltaReport({
        poolManifestFingerprint: H1,
        pinnedSnapshotId: "anthropic-model-20260830",
        policyDocument: policy,
        analysis,
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
        rawRegretRecords: [
            {
                coordinateId: "var-a:0",
                familyId: "fam-a",
                retrieval: 0.1,
                formation: 0.2,
                representation: null,
                label: "raw-non-inferential",
            },
        ],
        runSummary: {
            status: "completed",
            spentUsd: 12.5,
            observedCostRollouts: 9,
            estimatedCostRollouts: 1,
        },
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
        expect(built.body.regret.providerMixed.map(({ endpoint }) => endpoint)).toEqual(["retrieval"]);
        expect(built.body.regret.live.map(({ endpoint }) => endpoint)).toEqual(["formation"]);
        expect(built.body.regret.raw[0]!.label).toBe("raw-non-inferential");
        expect(built.body.runSummary).toEqual({
            status: "completed",
            spentUsd: 12.5,
            observedCostRollouts: 9,
            estimatedCostRollouts: 1,
        });
        expect(built.reportFingerprint).toBe(canonicalFingerprint(built.body));
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
            analysis: built.body.analysis,
            exclusions: [],
            secondaryMetrics: {
                invalidSuccessRateByArm: {},
                tokensByArm: {},
                wallClockMsByArm: {},
                turnsByArm: {},
            },
            rawRegretRecords: [],
            runSummary: {
                status: "cost-cap-reached",
                spentUsd: 1,
                observedCostRollouts: 0,
                estimatedCostRollouts: 1,
            },
        })).toThrow(/policy: identity-invalid/);
    });
});

function calibrationRecord(
    scenarioId: string,
    replicateIndex: number,
    checksPassed: number,
): RolloutRecord {
    return {
        schema: "paired-delta-rollout/v1",
        poolManifestFingerprint: H1,
        scenarioId,
        armId: "mc-on",
        replicateIndex,
        repoCommit: "abc123",
        pinnedProviderId: "anthropic",
        pinnedSnapshotId: "claude-sonnet-4-5-20250929",
        echoedProviderId: "anthropic",
        echoedModelId: "claude-sonnet-4-5-20250929",
        baseScriptFingerprint: H2,
        intervention: { kind: "none", value: null },
        cell: {
            armId: "mc-on",
            checksPassed,
            checksTotal: 2,
            criticalPassed: checksPassed > 0 ? 1 : 0,
            criticalTotal: 1,
            invalidSuccess: false,
            runHealth: "completed",
            reasonCode: null,
        },
        checks: [
            { id: "check-file", passed: checksPassed > 0 },
            { id: "check-answer", passed: checksPassed > 1 },
        ],
        usage: { input: 10, output: 5, cacheCreation: 0, cacheRead: 0 },
        costUsd: 1.25,
        costSource: "observed",
        wallClockMs: 1000,
        turns: 3,
        harnessDisposed: true,
    };
}

describe("paired-delta calibration record", () => {
    const families = new Map([
        ["var-a", "fam-one"],
        ["var-b", "fam-two"],
    ]);
    const records = [
        calibrationRecord("var-a", 0, 0),
        calibrationRecord("var-a", 1, 1),
        calibrationRecord("var-a", 2, 2),
        calibrationRecord("var-b", 0, 2),
        calibrationRecord("var-b", 1, 2),
        calibrationRecord("var-b", 2, 2),
    ];

    it("derives measured family spread, variance, cost, and wall clock", () => {
        const built = buildCalibrationRecord({
            records,
            scenarioFamilies: families,
            runStatus: "completed",
            poolManifestFingerprint: H1,
            pinnedSnapshotId: "claude-sonnet-4-5-20250929",
            decisions: {
                poolSize: 20,
                familyCount: 8,
                replicateCount: 3,
                cadence: "weekly-and-release",
            },
        });

        expect(built.validForPoolSizing).toBe(true);
        expect(built.measuredCostUsd).toBe(7.5);
        expect(built.measuredWallClockMs).toBe(6000);
        expect(built.familyNoise).toEqual([
            {
                familyId: "fam-one",
                replicateCount: 3,
                spread: 1,
                variance: 0.25,
                interval: { lower: 0, upper: 1 },
            },
            {
                familyId: "fam-two",
                replicateCount: 3,
                spread: 0,
                variance: 0,
                interval: { lower: 0, upper: 0 },
            },
        ]);
        const { recordFingerprint, ...body } = built;
        expect(recordFingerprint).toBe(canonicalFingerprint(body));
    });

    it("marks cap-terminated calibration invalid for sizing", () => {
        expect(buildCalibrationRecord({
            records,
            scenarioFamilies: families,
            runStatus: "cost-cap-reached",
            poolManifestFingerprint: H1,
            pinnedSnapshotId: "claude-sonnet-4-5-20250929",
            decisions: {
                poolSize: 20,
                familyCount: 8,
                replicateCount: 3,
                cadence: "weekly-and-release",
            },
        }).validForPoolSizing).toBe(false);
    });
});
