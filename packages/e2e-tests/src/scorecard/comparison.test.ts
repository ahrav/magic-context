import { describe, expect, it } from "bun:test";
import { compareWithBaseline, regretRows, type CurrentEstimates } from "./comparison";
import type { FamilyEstimateRow } from "./report-contract";
import { bundleFixture, pairedDeltaReportFixture } from "./test-fixtures";

function estimate(familyId: string, pointEstimate: number, overrides: Partial<FamilyEstimateRow> = {}): FamilyEstimateRow {
    return {
        endpoint: "mc-on-vs-mc-off",
        familyId,
        pointEstimate,
        interval: { lower: pointEstimate - 0.1, upper: pointEstimate + 0.1 },
        noiseLabel: "no-noise-floor",
        ...overrides,
    };
}

function present(familyEstimates: readonly FamilyEstimateRow[]): CurrentEstimates {
    return { status: "present", familyEstimates };
}

describe("compareWithBaseline", () => {
    it("reports every current estimate as no-baseline with its absolute value when no baseline is bound", () => {
        const current = present([estimate("fam-a", 0.3), estimate("fam-b", -0.2)]);
        const absent = compareWithBaseline(current, { status: "absent", familyEstimates: [] });
        expect(absent.deltas).toEqual([
            { endpoint: "mc-on-vs-mc-off", familyId: "fam-a", status: "no-baseline", value: 0.3 },
            { endpoint: "mc-on-vs-mc-off", familyId: "fam-b", status: "no-baseline", value: -0.2 },
        ]);
        expect(absent.adverseDeltas).toEqual([]);
        expect(absent.limitations).toEqual(["no-baseline"]);
        expect(compareWithBaseline(current, { status: "schema-mismatch", familyEstimates: [] }).limitations).toEqual(["baseline-not-comparable"]);
    });

    it("compares only families the baseline carries and lists the rest as no-baseline", () => {
        const current = present([estimate("fam-a", 0.3), estimate("fam-f7", 0.5)]);
        const result = compareWithBaseline(current, { status: "present", familyEstimates: [estimate("fam-a", 0.2)] });
        expect(result.deltas).toEqual([
            {
                endpoint: "mc-on-vs-mc-off",
                familyId: "fam-a",
                status: "compared",
                baselinePointEstimate: 0.2,
                delta: expect.closeTo(0.1),
                interval: { lower: expect.closeTo(0), upper: expect.closeTo(0.2) },
                noiseLabel: "no-noise-floor",
            },
            { endpoint: "mc-on-vs-mc-off", familyId: "fam-f7", status: "no-baseline", value: 0.5 },
        ]);
        expect(result.adverseDeltas).toEqual([]);
        expect(result.limitations).toEqual(["no-baseline-families"]);
    });

    it("lists every wholly adverse pair and blocks only outside-floor rows", () => {
        const current = present([
            estimate("fam-a", -0.5, { noiseLabel: "outside-floor" }),
            estimate("fam-b", -0.5, { noiseLabel: "outside-floor", endpoint: "mc-on-vs-compaction" }),
            estimate("fam-c", -0.5, { noiseLabel: "inside-floor" }),
            estimate("fam-d", 0.05),
        ]);
        const baseline = [estimate("fam-a", 0), estimate("fam-b", 0, { endpoint: "mc-on-vs-compaction" }), estimate("fam-c", 0), estimate("fam-d", 0)];
        const result = compareWithBaseline(current, { status: "present", familyEstimates: baseline });
        expect(result.adverseDeltas.map((row) => [row.familyId, row.kind, row.blocking])).toEqual([
            ["fam-a", "adverse-interval", true],
            ["fam-b", "adverse-interval", true],
            ["fam-c", "adverse-interval", false],
        ]);
        expect(result.adverseDeltas.filter((row) => row.blocking)).toHaveLength(2);
        expect(result.adverseDeltas[0]).toMatchObject({ endpoint: "mc-on-vs-mc-off", delta: -0.5, interval: { lower: -0.6, upper: -0.4 }, noiseLabel: "outside-floor" });
        expect(result.limitations).toEqual([]);
    });

    it("emits one blocking family-missing row per (endpoint, family) key the current release dropped", () => {
        const result = compareWithBaseline(present([estimate("fam-a", 0.1), estimate("fam-gone", 0.4)]), {
            status: "present",
            familyEstimates: [
                estimate("fam-a", 0.1),
                estimate("fam-a", 0.1, { endpoint: "mc-on-vs-compaction" }),
                estimate("fam-gone", 0.4),
                estimate("fam-gone", 0.4, { endpoint: "mc-on-vs-compaction" }),
            ],
        });
        expect(result.adverseDeltas).toEqual([
            { familyId: "fam-a", endpoint: "mc-on-vs-compaction", kind: "family-missing", noiseLabel: null, delta: null, interval: null, blocking: true },
            { familyId: "fam-gone", endpoint: "mc-on-vs-compaction", kind: "family-missing", noiseLabel: null, delta: null, interval: null, blocking: true },
        ]);
        expect(result.limitations).toEqual([]);
    });

    it("reports an unfinished current lane as a limitation instead of family-missing regressions", () => {
        const baseline = { status: "present" as const, familyEstimates: [estimate("fam-a", 0.1), estimate("fam-b", 0.2)] };
        for (const status of ["missing", "incomplete", "schema-mismatch"] as const) {
            const result = compareWithBaseline({ status, familyEstimates: [] }, baseline);
            expect(result.deltas).toEqual([]);
            expect(result.adverseDeltas).toEqual([]);
            expect(result.limitations).toEqual(["current-estimates-unavailable"]);
        }
        expect(compareWithBaseline({ status: "missing", familyEstimates: [] }, { status: "absent", familyEstimates: [] }).limitations)
            .toEqual(["current-estimates-unavailable", "no-baseline"]);
    });

    it("copies the paired-delta raw regret ladder only when the lane is present", () => {
        const report = pairedDeltaReportFixture();
        expect(regretRows(bundleFixture({ lanes: { "paired-delta": report } }))).toEqual(report.body.regret.raw);
        expect(report.body.regret.raw.length).toBeGreaterThan(0);
        expect(regretRows(bundleFixture({ statuses: { "paired-delta": "incomplete" } }))).toEqual([]);
    });

    it("rejects regret ladder ids outside the report contract's id shape", () => {
        const report = structuredClone(pairedDeltaReportFixture());
        report.body.regret.raw[0]!.coordinateId = "var-a:0 ";
        expect(() => regretRows(bundleFixture({ lanes: { "paired-delta": report } }))).toThrow(/coordinateId/);
    });
});
