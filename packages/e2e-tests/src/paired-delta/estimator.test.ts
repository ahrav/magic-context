import { describe, expect, it } from "bun:test";
import type { PairedCaseFact } from "../prospective-holdout/comparison";
import { buildProspectiveReport, pairedFactsFingerprint } from "../prospective-holdout/report";
import type { ProspectiveCellResult } from "../prospective-holdout/runner";
import { cellResultFixture, H1, H2, H3 } from "../prospective-holdout/test-fixtures";
import {
    PairedDeltaEstimatorError,
    REGRET_ENDPOINTS,
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
    { coordinateId: "var-a:0", familyId: "fam-a", endpoint: "mc-on-vs-compaction", delta: 0.4, runHealth: "completed" },
    { coordinateId: "var-a:1", familyId: "fam-a", endpoint: "mc-on-vs-compaction", delta: 0.6, runHealth: "completed" },
    { coordinateId: "var-b:0", familyId: "fam-b", endpoint: "mc-on-vs-compaction", delta: 0.1, runHealth: "completed" },
    { coordinateId: "var-b:1", familyId: "fam-b", endpoint: "mc-on-vs-compaction", delta: 0.3, runHealth: "completed" },
    { coordinateId: "var-c:0", familyId: "fam-c", endpoint: "mc-on-vs-compaction", delta: -0.1, runHealth: "completed" },
    { coordinateId: "var-c:1", familyId: "fam-c", endpoint: "mc-on-vs-compaction", delta: 0.1, runHealth: "completed" },
    { coordinateId: "var-d:0", familyId: "fam-d", endpoint: "mc-on-vs-compaction", delta: 0.2, runHealth: "completed" },
    { coordinateId: "var-d:1", familyId: "fam-d", endpoint: "mc-on-vs-compaction", delta: 0.4, runHealth: "completed" },
    { coordinateId: "var-e:0", familyId: "fam-e", endpoint: "mc-on-vs-compaction", delta: -0.4, runHealth: "completed" },
    { coordinateId: "var-e:1", familyId: "fam-e", endpoint: "mc-on-vs-compaction", delta: 0, runHealth: "completed" },
];

// Unsorted input order exercises the shared paired-facts sort before fingerprinting.
const pairs = [pair("complete", 9), pair("complete", 7)];

const lane = {
    poolManifestFingerprint: H1,
    pinnedSnapshotId: "fixture-model-20260830",
    policyFingerprint: H3,
    pairedFactsFingerprint: pairedFactsFingerprint(pairs),
};

function estimate(overrides: Partial<Parameters<typeof estimateFamilyDeltas>[0]> = {}): FamilyDeltaAnalysis {
    return estimateFamilyDeltas({
        observations,
        minimumAnalyzableFamilyCount: 3,
        bootstrapSeed: 20260830,
        bootstrapResamples: 2000,
        lane,
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

function primaryEndpoint(analysis: FamilyDeltaAnalysis, endpoint: string) {
    return analysis.endpoints.find((estimate) => estimate.endpoint === endpoint)!;
}

function pair(status: "complete" | "incomplete" = "complete", seed = 7): PairedCaseFact {
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
        seed,
        platform: "linux-x64",
        releaseN,
        releaseNMinus1: cellResultFixture("release-n-minus-1"),
        status,
    };
}

describe("family-clustered delta estimator", () => {
    it("computes exact family means and deterministic family-clustered intervals", () => {
        const first = estimate();
        const second = estimate();
        const changedSeed = estimate({ bootstrapSeed: 20260831 });
        const endpoint = primaryEndpoint(first, "mc-on-vs-mc-off");

        expect(first.endpoints.map(({ endpoint }) => endpoint)).toEqual([
            "mc-on-vs-compaction", "mc-on-vs-mc-off",
        ]);
        expect(endpoint.pointEstimate).toBeCloseTo(0.16, 12);
        expect(endpoint.families.map(({ familyId }) => familyId)).toEqual([
            "fam-a", "fam-b", "fam-c", "fam-d", "fam-e",
        ]);
        for (const [actual, expected] of endpoint.families.map(({ pointEstimate }) => pointEstimate)
            .map((value, index) => [value, [0.5, 0.2, 0, 0.3, -0.2][index]!] as const)) {
            expect(actual).toBeCloseTo(expected, 12);
        }
        expect(second).toEqual(first);
        expect(primaryEndpoint(changedSeed, "mc-on-vs-mc-off").interval).not.toEqual(endpoint.interval);
        expect(first.bootstrapResamples).toBe(2000);
    });

    it("keeps CI resolution and per-family noise-floor facts separate", () => {
        const endpoint = primaryEndpoint(estimate(), "mc-on-vs-mc-off");
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

    it("rejects unhealthy input instead of silently excluding it", () => {
        expect(() => estimate({
            observations: [
                ...observations,
                { ...observations[0]!, coordinateId: "var-a:bad", runHealth: "timeout" },
            ],
        })).toThrow(/observation: unanalyzable-var-a:bad/);
        expect(() => estimate({ bootstrapResamples: 1999 })).toThrow(/bootstrap-resamples-too-small/);
        expect(() => estimate({ bootstrapSeed: 2 ** 32 })).toThrow(/bootstrap-seed-invalid/);
        expect(() => estimate({ bootstrapSeed: -1 })).toThrow(/bootstrap-seed-invalid/);
        expect(() => estimate({
            lane: { ...lane, pairedFactsFingerprint: "not-a-hash" },
        })).toThrow(/lane-paired-facts-fingerprint-invalid/);
    });

    it("orders observations independently of caller order when an identifier contains a colon", () => {
        // family `a:b` + coordinate `c` and family `a` + coordinate `b:c` share one joined sort key.
        const rows: FamilyDeltaObservation[] = [
            { coordinateId: "c", familyId: "a:b", endpoint: "retrieval", delta: 0.2, runHealth: "completed" },
            { coordinateId: "b:c", familyId: "a", endpoint: "retrieval", delta: 0.4, runHealth: "completed" },
            { coordinateId: "p:0", familyId: "fam-p", endpoint: "mc-on-vs-mc-off", delta: 0.3, runHealth: "completed" },
            { coordinateId: "p:0", familyId: "fam-p", endpoint: "mc-on-vs-compaction", delta: 0.3, runHealth: "completed" },
        ];
        const forward = estimate({ minimumAnalyzableFamilyCount: 1, observations: rows, noiseFloors: undefined });
        const reversed = estimate({
            minimumAnalyzableFamilyCount: 1,
            observations: [...rows].reverse(),
            noiseFloors: undefined,
        });
        expect(reversed).toEqual(forward);
        expect(forward.rawRegretRecords.map(({ familyId, coordinateId }) => [familyId, coordinateId]))
            .toEqual([["a", "b:c"], ["a:b", "c"]]);
    });

    it("partitions every declared regret endpoint into exactly one aggregate bucket", () => {
        const result = estimate({
            observations: [
                ...observations,
                { coordinateId: "var-a:0", familyId: "fam-a", endpoint: "retrieval", delta: 0.2, runHealth: "completed" },
                { coordinateId: "var-a:0", familyId: "fam-a", endpoint: "formation", delta: 0.3, runHealth: "completed" },
                { coordinateId: "var-a:0", familyId: "fam-a", endpoint: "representation", delta: 0.4, runHealth: "completed" },
            ],
        });
        const bucketed = [
            ...result.liveRegret.map(({ endpoint }) => endpoint),
            ...result.providerMixedRegret.map(({ endpoint }) => endpoint),
        ];
        expect([...bucketed].sort()).toEqual([...REGRET_ENDPOINTS].sort());
        expect(new Set(bucketed).size).toBe(bucketed.length);
    });

    it("rejects an undeclared endpoint instead of estimating and dropping it", () => {
        expect(() => estimate({
            observations: [
                ...observations,
                { ...observations[0]!, coordinateId: "var-a:z", endpoint: "latency" as never },
            ],
        })).toThrow(/observation: endpoint-undeclared-latency/);
    });

    it("rejects one coordinate assigned to two families", () => {
        expect(() => estimate({
            observations: [
                ...observations,
                { ...observations[0]!, endpoint: "retrieval", familyId: "fam-z" },
            ],
        })).toThrow(/observation: family-conflict-var-a:0/);
    });

    it("counts only families with evidence at every primary endpoint", () => {
        // Equal-sized but disjoint family sets carry no paired evidence.
        const disjoint = estimate({
            minimumAnalyzableFamilyCount: 2,
            observations: observations.map((row) => row.endpoint === "mc-on-vs-compaction"
                ? { ...row, familyId: `${row.familyId}-alt`, coordinateId: `${row.coordinateId}-alt` }
                : row),
            noiseFloors: undefined,
        });
        expect(disjoint.endpoints).toEqual([]);
        expect(disjoint.analyzableFamilyCount).toBe(0);
        expect(disjoint.evidenceSufficient).toBe(false);

        const overlapping = estimate({ minimumAnalyzableFamilyCount: 2, noiseFloors: undefined });
        expect(overlapping.analyzableFamilyCount).toBe(5);
        expect(overlapping.evidenceSufficient).toBe(true);
    });

    it("pools each primary endpoint over the paired families alone", () => {
        // fam-shared is neutral at both endpoints; the unpaired families are strongly positive.
        const partial = estimate({
            minimumAnalyzableFamilyCount: 1,
            observations: [
                { coordinateId: "shared:0", familyId: "fam-shared", endpoint: "mc-on-vs-mc-off", delta: 0.01, runHealth: "completed" },
                { coordinateId: "shared:1", familyId: "fam-shared", endpoint: "mc-on-vs-mc-off", delta: -0.01, runHealth: "completed" },
                { coordinateId: "only-a:0", familyId: "fam-a", endpoint: "mc-on-vs-mc-off", delta: 0.9, runHealth: "completed" },
                { coordinateId: "only-a:1", familyId: "fam-b", endpoint: "mc-on-vs-mc-off", delta: 0.9, runHealth: "completed" },
                { coordinateId: "shared:2", familyId: "fam-shared", endpoint: "mc-on-vs-compaction", delta: 0.01, runHealth: "completed" },
                { coordinateId: "shared:3", familyId: "fam-shared", endpoint: "mc-on-vs-compaction", delta: -0.01, runHealth: "completed" },
                { coordinateId: "only-c:0", familyId: "fam-c", endpoint: "mc-on-vs-compaction", delta: 0.9, runHealth: "completed" },
                { coordinateId: "only-c:1", familyId: "fam-d", endpoint: "mc-on-vs-compaction", delta: 0.9, runHealth: "completed" },
            ],
            noiseFloors: undefined,
        });
        expect(partial.analyzableFamilyCount).toBe(1);
        expect(partial.evidenceSufficient).toBe(true);
        expect(partial.endpoints).toHaveLength(2);
        for (const endpoint of partial.endpoints) {
            expect(endpoint.families.map(({ familyId }) => familyId)).toEqual(["fam-shared"]);
            expect(endpoint.familyCount).toBe(1);
            expect(endpoint.pointEstimate).toBeCloseTo(0, 12);
            expect(endpoint.resolution).toBe("unresolved");
        }
    });

    it("reports a malformed noise floor as an estimator error", () => {
        expect(() => estimate({
            noiseFloors: [{ familyId: "fam-a", value: 0.2, interval: undefined as never }],
        })).toThrow(PairedDeltaEstimatorError);
    });

    it("treats a primary endpoint without observations as zero analyzable families", () => {
        const result = estimate({
            minimumAnalyzableFamilyCount: 1,
            observations: observations.filter(({ endpoint }) => endpoint === "mc-on-vs-mc-off"),
        });
        expect(result.analyzableFamilyCount).toBe(0);
        expect(result.evidenceSufficient).toBe(false);
    });

    it("never resolves a family or endpoint from a single observation", () => {
        const result = estimate({
            minimumAnalyzableFamilyCount: 1,
            observations: [
                { coordinateId: "var-a:0", familyId: "fam-a", endpoint: "mc-on-vs-mc-off", delta: 0.4, runHealth: "completed" },
                { coordinateId: "var-a:0", familyId: "fam-a", endpoint: "mc-on-vs-compaction", delta: 0.4, runHealth: "completed" },
            ],
            noiseFloors: undefined,
        });
        for (const endpoint of result.endpoints) {
            expect(endpoint.resolution).toBe("unresolved");
            expect(endpoint.families.every(({ resolution }) => resolution === "unresolved")).toBe(true);
        }
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
    const adapter = (analysis = estimate({ minimumAnalyzableFamilyCount: 1 })) =>
        createFamilyEstimatorAdapter({
            poolManifestFingerprint: H1,
            pinnedSnapshotId: "fixture-model-20260830",
            policyFingerprint: H3,
            analysis,
        });

    it("implements every projection row without leaking noise labels", () => {
        const belowFloor = adapter(estimate({ minimumAnalyzableFamilyCount: 6 })).analyze(pairs, H3);
        expect(belowFloor.evidenceSufficient).toBe(false);
        expect(belowFloor.direction).toBe("no-change");

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

        const mixed = adapter(estimate({
            minimumAnalyzableFamilyCount: 1,
            observations: observations.map((row) => ({
                ...row,
                delta: row.endpoint === "mc-on-vs-mc-off"
                    ? Math.abs(row.delta) + 0.2
                    : -Math.abs(row.delta) - 0.2,
            })),
        })).analyze(pairs, H3);
        expect(mixed.direction).toBe("no-change");
    });

    it("never projects a direction on insufficient evidence", () => {
        // Resolved positive endpoints plus a family minimum the cohort misses.
        const analysis = estimate({
            minimumAnalyzableFamilyCount: 6,
            observations: observations.map((row) => ({ ...row, delta: Math.abs(row.delta) + 0.2 })),
        });
        expect(analysis.endpoints.some(({ interval }) => interval.lower > 0)).toBe(true);
        expect(analysis.evidenceSufficient).toBe(false);
        expect(adapter(analysis).analyze(pairs, H3).direction).toBe("no-change");
    });

    it("withholds direction when no family is measured at both primary endpoints", () => {
        // Strongly positive deltas over disjoint families: no primary estimate survives, so nothing can resolve.
        const disjoint = estimate({
            minimumAnalyzableFamilyCount: 2,
            observations: observations.map((row) => {
                const positive = { ...row, delta: Math.abs(row.delta) + 0.2 };
                return positive.endpoint === "mc-on-vs-compaction"
                    ? {
                        ...positive,
                        familyId: `${positive.familyId}-alt`,
                        coordinateId: `${positive.coordinateId}-alt`,
                    }
                    : positive;
            }),
            noiseFloors: undefined,
        });
        expect(disjoint.endpoints).toEqual([]);
        expect(disjoint.analyzableFamilyCount).toBe(0);
        expect(disjoint.evidenceSufficient).toBe(false);
        expect(adapter(disjoint).analyze(pairs, H3).direction).toBe("no-change");
    });

    it("reports the analysis gate verbatim", () => {
        const analysis = estimate({ minimumAnalyzableFamilyCount: 1 });
        expect(adapter(analysis).analyze(pairs, H3).evidenceSufficient)
            .toBe(analysis.evidenceSufficient);
    });

    it("keeps direction unresolved when only one family excludes zero", () => {
        // fam-a resolves positive while the pooled endpoint intervals straddle zero.
        const outcome = adapter(estimate({ minimumAnalyzableFamilyCount: 1 })).analyze(pairs, H3);
        const analysis = estimate({ minimumAnalyzableFamilyCount: 1 });
        expect(analysis.endpoints.every(({ resolution }) => resolution === "unresolved")).toBe(true);
        expect(analysis.endpoints.some(({ families }) =>
            families.some(({ resolution }) => resolution === "resolved"))).toBe(true);
        expect(outcome.direction).toBe("no-change");
    });

    it("binds pool, policy, and prospective facts with typed failures", () => {
        expect(() => createFamilyEstimatorAdapter({
            poolManifestFingerprint: H2,
            pinnedSnapshotId: "fixture-model-20260830",
            policyFingerprint: H3,
            analysis: estimate(),
        }).analyze(pairs, H3)).toThrow(PairedDeltaEstimatorError);
        expect(() => adapter(estimate({
            lane: { ...lane, pinnedSnapshotId: "other-model-20260830" },
        })).analyze(pairs, H3)).toThrow(/lane-binding-mismatch/);
        expect(() => adapter().analyze([pair("incomplete")], H3)).toThrow(/paired-facts-fingerprint-mismatch/);
        expect(() => adapter().analyze(pairs, H2)).toThrow(/policy-fingerprint-mismatch/);
        expect(() => adapter(estimate({
            minimumAnalyzableFamilyCount: 1,
            lane: { ...lane, pairedFactsFingerprint: pairedFactsFingerprint([pair("incomplete")]) },
        })).analyze(pairs, H3)).toThrow(/paired-facts-fingerprint-mismatch/);
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

        const changed = estimate({ minimumAnalyzableFamilyCount: 1 });
        changed.endpoints[0]!.families[0]!.pointEstimate += 0.01;
        expect(adapter().analyze(pairs, H3).resultFingerprint).not.toBe(
            adapter(changed).analyze(pairs, H3).resultFingerprint,
        );
    });
});
