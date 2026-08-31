import { describe, expect, it } from "bun:test";
import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import type { PairedCaseFact } from "../prospective-holdout/comparison";
import { buildProspectiveReport } from "../prospective-holdout/report";
import type { ProspectiveCellResult } from "../prospective-holdout/runner";
import { cellResultFixture, H1, H2, H3 } from "../prospective-holdout/test-fixtures";
import {
    PairedDeltaEstimatorError,
    createFamilyEstimatorAdapter,
    estimateFamilyDeltas,
    type FamilyDeltaAnalysis,
    type FamilyDeltaObservation,
} from "./estimator";

const observations: FamilyDeltaObservation[] = [
    { coordinateId: "var-a:0", familyId: "fam-a", endpoint: "mc-on-vs-mc-off", delta: 0.4, runHealth: "completed" },
    { coordinateId: "var-a:1", familyId: "fam-a", endpoint: "mc-on-vs-mc-off", delta: 0.6, runHealth: "completed" },
    { coordinateId: "var-b:0", familyId: "fam-b", endpoint: "mc-on-vs-mc-off", delta: 0.1, runHealth: "completed" },
    { coordinateId: "var-b:1", familyId: "fam-b", endpoint: "mc-on-vs-mc-off", delta: 0.3, runHealth: "completed" },
    { coordinateId: "var-c:0", familyId: "fam-c", endpoint: "mc-on-vs-mc-off", delta: -0.1, runHealth: "completed" },
    { coordinateId: "var-c:1", familyId: "fam-c", endpoint: "mc-on-vs-mc-off", delta: 0.1, runHealth: "completed" },
    { coordinateId: "var-d:0", familyId: "fam-d", endpoint: "mc-on-vs-mc-off", delta: 0.2, runHealth: "completed" },
    { coordinateId: "var-d:1", familyId: "fam-d", endpoint: "mc-on-vs-mc-off", delta: 0.4, runHealth: "completed" },
    { coordinateId: "var-e:0", familyId: "fam-e", endpoint: "mc-on-vs-mc-off", delta: -0.4, runHealth: "completed" },
    { coordinateId: "var-e:1", familyId: "fam-e", endpoint: "mc-on-vs-mc-off", delta: 0, runHealth: "completed" },
];

function estimate(overrides: Partial<Parameters<typeof estimateFamilyDeltas>[0]> = {}): FamilyDeltaAnalysis {
    return estimateFamilyDeltas({
        observations,
        minimumAnalyzableFamilyCount: 3,
        bootstrapSeed: 20260830,
        bootstrapResamples: 2000,
        noiseFloors: [
            { familyId: "fam-a", value: 0.2, interval: { lower: 0.1, upper: 0.3 } },
            { familyId: "fam-b", value: 0.4, interval: { lower: 0.3, upper: 0.5 } },
            { familyId: "fam-c", value: 0.15, interval: { lower: 0.1, upper: 0.2 } },
            { familyId: "fam-d", value: 0.1, interval: { lower: 0.05, upper: 0.15 } },
            { familyId: "fam-e", value: 0.3, interval: { lower: 0.2, upper: 0.4 } },
        ],
        ...overrides,
    });
}

function pair(status: "complete" | "incomplete" = "complete"): PairedCaseFact {
    const releaseN: ProspectiveCellResult = status === "complete"
        ? cellResultFixture("release-n")
        : cellResultFixture("release-n", {
            runHealth: "timeout",
            productOutcome: "not-evaluated",
            reasonCode: "deadline-exceeded",
        });
    return {
        caseId: `case-${"a".repeat(32)}`,
        familyId: "fam-a",
        implementationFingerprint: H2,
        model: "fixture/model",
        seed: 7,
        platform: "linux-x64",
        releaseN,
        releaseNMinus1: cellResultFixture("release-n-minus-1"),
        status,
    };
}

function pairedFactsFingerprint(pairs: readonly PairedCaseFact[]): string {
    return canonicalFingerprint([...pairs].sort((left, right) =>
        `${left.caseId}:${left.model}:${left.seed}:${left.platform}`.localeCompare(
            `${right.caseId}:${right.model}:${right.seed}:${right.platform}`,
        )));
}

describe("family-clustered delta estimator", () => {
    it("computes exact family means and deterministic family-clustered intervals", () => {
        const first = estimate();
        const second = estimate();
        const changedSeed = estimate({ bootstrapSeed: 20260831 });
        const endpoint = first.endpoints[0]!;

        expect(endpoint.pointEstimate).toBeCloseTo(0.16, 12);
        expect(endpoint.families.map(({ familyId }) => familyId)).toEqual([
            "fam-a", "fam-b", "fam-c", "fam-d", "fam-e",
        ]);
        for (const [actual, expected] of endpoint.families.map(({ pointEstimate }) => pointEstimate)
            .map((value, index) => [value, [0.5, 0.2, 0, 0.3, -0.2][index]!] as const)) {
            expect(actual).toBeCloseTo(expected, 12);
        }
        expect(second).toEqual(first);
        expect(changedSeed.endpoints[0]!.interval).not.toEqual(endpoint.interval);
        expect(first.bootstrapResamples).toBe(2000);
    });

    it("keeps CI resolution and per-family noise-floor facts separate", () => {
        const endpoint = estimate().endpoints[0]!;
        const family = endpoint.families.find(({ familyId }) => familyId === "fam-b")!;
        expect(endpoint.resolution).toBe("unresolved");
        expect(family.noise).toEqual({
            label: "inside-floor",
            floor: {
                familyId: "fam-b",
                value: 0.4,
                interval: { lower: 0.3, upper: 0.5 },
            },
        });
        expect(family.interval.lower).toBeLessThanOrEqual(family.pointEstimate);
        expect(family.interval.upper).toBeGreaterThanOrEqual(family.pointEstimate);
    });

    it("marks every delta unresolved below the family floor", () => {
        const result = estimate({ minimumAnalyzableFamilyCount: 6 });
        expect(result.evidenceSufficient).toBe(false);
        expect(result.endpoints.every(({ resolution }) => resolution === "unresolved")).toBe(true);
        expect(result.endpoints.every(({ families }) =>
            families.every(({ resolution }) => resolution === "unresolved"))).toBe(true);
    });

    it("labels estimates when no calibration noise floor exists", () => {
        const result = estimate({ noiseFloors: undefined });
        expect(result.endpoints[0]!.families.every(({ noise }) =>
            noise.label === "no-noise-floor" && noise.floor === null)).toBe(true);
    });

    it("keeps single-observation families unresolved", () => {
        const result = estimate({
            minimumAnalyzableFamilyCount: 2,
            observations: [
                { coordinateId: "var-a:0", familyId: "fam-a", endpoint: "mc-on-vs-mc-off", delta: 0.5, runHealth: "completed" },
                { coordinateId: "var-b:0", familyId: "fam-b", endpoint: "mc-on-vs-mc-off", delta: 0.4, runHealth: "completed" },
            ],
            noiseFloors: undefined,
        });
        const families = result.endpoints[0]!.families;
        expect(families.every(({ resolution }) => resolution === "unresolved")).toBe(true);
        expect(families.every(({ interval }) => interval.lower === interval.upper)).toBe(true);
    });

    it("rejects unhealthy input instead of silently excluding it", () => {
        expect(() => estimate({
            observations: [
                ...observations,
                { ...observations[0]!, coordinateId: "var-a:bad", runHealth: "timeout" },
            ],
        })).toThrow(/observation: unanalyzable-var-a:bad/);
        expect(() => estimate({ bootstrapResamples: 1999 })).toThrow(/bootstrap-resamples-too-small/);
    });

    it("keeps retrieval provider-mixed and live regret inferentially separate", () => {
        const result = estimate({
            observations: [
                ...observations,
                { coordinateId: "var-a:0", familyId: "fam-a", endpoint: "retrieval", delta: 0.2, runHealth: "completed" },
                { coordinateId: "var-a:0", familyId: "fam-a", endpoint: "formation", delta: 0.3, runHealth: "completed" },
                { coordinateId: "var-a:0", familyId: "fam-a", endpoint: "representation", delta: 0.4, runHealth: "completed" },
            ],
        });
        expect(result.providerMixedRegret.map(({ endpoint }) => endpoint)).toEqual(["retrieval"]);
        expect(result.liveRegret.map(({ endpoint }) => endpoint)).toEqual(["formation", "representation"]);
        expect(result.rawRegretRecords.every(({ inferential }) => inferential === false)).toBe(true);
    });
});

describe("bound prospective estimator adapter", () => {
    const pairs = [pair()];
    const expectedPairedFactsFingerprint = pairedFactsFingerprint(pairs);
    const adapter = (analysis = estimate({ minimumAnalyzableFamilyCount: 1 })) =>
        createFamilyEstimatorAdapter({
            poolManifestFingerprint: H1,
            pinnedSnapshotId: "fixture-model-20260830",
            policyFingerprint: H3,
            expectedPairedFactsFingerprint,
            analysis: {
                ...analysis,
                poolManifestFingerprint: H1,
                pinnedSnapshotId: "fixture-model-20260830",
                policyFingerprint: H3,
            },
        });

    it("implements every projection row without leaking noise labels", () => {
        const belowFloor = adapter(estimate({ minimumAnalyzableFamilyCount: 6 })).analyze(pairs, H3);
        expect(belowFloor.evidenceSufficient).toBe(false);

        const noChange = adapter(estimate({
            minimumAnalyzableFamilyCount: 1,
            observations: observations.map((row, index) => ({
                ...row,
                delta: index % 2 === 0 ? -0.1 : 0.1,
            })),
        })).analyze(pairs, H3);
        expect(noChange.direction).toBe("no-change");
        expect(noChange).not.toHaveProperty("noise");

        const positive = adapter(estimate({
            minimumAnalyzableFamilyCount: 1,
            observations: observations.map((row) => ({ ...row, delta: Math.abs(row.delta) + 0.2 })),
        })).analyze(pairs, H3);
        expect(positive.direction).toBe("improvement");

        const negative = adapter(estimate({
            minimumAnalyzableFamilyCount: 1,
            observations: observations.map((row) => ({ ...row, delta: -Math.abs(row.delta) - 0.2 })),
        })).analyze(pairs, H3);
        expect(negative.direction).toBe("regression");

        const disagreeing = adapter(estimate({
            minimumAnalyzableFamilyCount: 1,
            observations: [
                ...observations.map((row) => ({ ...row, delta: Math.abs(row.delta) + 0.2 })),
                ...observations.map((row) => ({
                    ...row,
                    endpoint: "mc-on-vs-compaction" as const,
                    delta: -Math.abs(row.delta) - 0.2,
                })),
            ],
        })).analyze(pairs, H3);
        expect(disagreeing.direction).toBe("no-change");
    });

    it("binds pool, policy, and prospective facts with typed failures", () => {
        expect(() => createFamilyEstimatorAdapter({
            poolManifestFingerprint: H2,
            pinnedSnapshotId: "fixture-model-20260830",
            policyFingerprint: H3,
            expectedPairedFactsFingerprint,
            analysis: {
                ...estimate(),
                poolManifestFingerprint: H1,
                pinnedSnapshotId: "fixture-model-20260830",
                policyFingerprint: H3,
            },
        }).analyze(pairs, H3)).toThrow(PairedDeltaEstimatorError);
        expect(() => adapter().analyze([pair("incomplete")], H3)).toThrow(/paired-facts-fingerprint-mismatch/);
        expect(() => adapter().analyze(pairs, H2)).toThrow(/policy-fingerprint-mismatch/);
    });

    it("runs through buildProspectiveReport and fingerprints every lane record", () => {
        const scorecard = {
            owner: "magic-context-x4l.15" as const,
            evaluate: () => ({
                hardGateFailures: [],
                mandatoryEvidenceComplete: true,
                promotionAllowed: false,
                resultFingerprint: H2,
            }),
        };
        const report = buildProspectiveReport({
            epochId: "epoch-paired-delta",
            freezeManifestFingerprint: H1,
            closeManifestFingerprint: H2,
            analysisPolicyFingerprint: H3,
            scorecardPolicyFingerprint: H3,
            pairs,
            estimator: adapter(),
            scorecard,
            invalidated: false,
        });
        expect(report.body.completeFamilyCount).toBe(1);

        const changed = estimate();
        changed.endpoints[0]!.families[0]!.pointEstimate += 0.01;
        expect(adapter().analyze(pairs, H3).resultFingerprint).not.toBe(
            adapter(changed).analyze(pairs, H3).resultFingerprint,
        );
    });
});
