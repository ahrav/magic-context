import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { POLICY_OWNER_SCHEMA } from "../prospective-holdout/contract";
import { estimateFamilyDeltas } from "./estimator";
import {
    PAIRED_DELTA_REPORT_SCHEMA,
    buildPairedDeltaReport,
    publishPairedDeltaReport,
} from "./report";

const H1 = "1".repeat(64);
const H2 = "2".repeat(64);

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
            pairedFactsFingerprint: H2,
        },
    });
}

function report(overrides: Partial<Parameters<typeof buildPairedDeltaReport>[0]> = {}) {
    const policy = policyDocument();
    return buildPairedDeltaReport({
        poolManifestFingerprint: H1,
        pinnedSnapshotId: "anthropic-model-20260830",
        policyDocument: policy,
        analysis: analysisFixture(policy.policyFingerprint),
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
        expect(built.body.regret.providerMixed.map(({ endpoint }) => endpoint)).toEqual(["retrieval"]);
        expect(built.body.regret.live.map(({ endpoint }) => endpoint)).toEqual(["formation"]);
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
                pairedFactsFingerprint: H2,
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
            analysis: built.body.analysis,
            exclusions: [],
            secondaryMetrics: {
                invalidSuccessRateByArm: {},
                tokensByArm: {},
                wallClockMsByArm: {},
                turnsByArm: {},
            },
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
            analysis: built.body.analysis,
            exclusions: [],
            secondaryMetrics: {
                invalidSuccessRateByArm: {},
                tokensByArm: {},
                wallClockMsByArm: {},
                turnsByArm: {},
            },
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
                pairedFactsFingerprint: H2,
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
