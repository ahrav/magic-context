import { describe, expect, it } from "bun:test";
import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { PRIMARY_ENDPOINT_SLOTS } from "./policy";
import { parseScorecardReport, type ScorecardReport, type ScorecardReportBody } from "./report-contract";
import { policyFixture, scorecardReportFixture } from "./test-fixtures";

function withOutcome(report: ScorecardReport, outcome: Partial<ScorecardReportBody["outcome"]>): ScorecardReport {
    const body = { ...report.body, outcome: { ...report.body.outcome, ...outcome } };
    return { ...report, body, reportFingerprint: canonicalFingerprint(body) };
}

describe("parseScorecardReport", () => {
    const policy = policyFixture();
    const terms = { requiredMetricSlots: policy.requiredMetricSlots, maxToleratedRegressions: policy.maxToleratedRegressions };
    const missingLanes = scorecardReportFixture(policy);
    const presentLanes = scorecardReportFixture(policy, {
        evidence: {
            lanes: missingLanes.body.evidence.lanes.map((row) => ({ ...row, status: "present", reportFingerprint: "b".repeat(64), diagnostics: [] })),
            baseline: { status: "absent", reportFingerprint: null },
        },
        safetyGates: missingLanes.body.safetyGates.map((row) => ({ ...row, status: "passed", observedCount: 0, evidenceFingerprint: "c".repeat(64), sourceLane: "historian", diagnostic: null })),
    });

    it("round-trips a report whose outcome is derived from its rows", () => {
        expect(parseScorecardReport(missingLanes)).toEqual(missingLanes);
        expect(parseScorecardReport(missingLanes, terms)).toEqual(missingLanes);
        expect(missingLanes.body.outcome).toMatchObject({ promotionAllowed: false, mandatoryEvidenceComplete: false });
    });

    it("rejects claims the rows deny regardless of policy terms", () => {
        expect(() => parseScorecardReport(withOutcome(missingLanes, { hardGateFailures: [] }))).toThrow(/hardGateFailures: cross-field-invalid/);
        expect(() => parseScorecardReport(withOutcome(missingLanes, { blockingRegressionCount: 1 }))).toThrow(/blockingRegressionCount: cross-field-invalid/);
        expect(() => parseScorecardReport(withOutcome(missingLanes, { mandatoryEvidenceComplete: true }))).toThrow(/mandatoryEvidenceComplete: cross-field-invalid/);
        expect(() => parseScorecardReport(withOutcome(presentLanes, { promotionAllowed: true, mandatoryEvidenceComplete: false }))).toThrow(/promotionAllowed: cross-field-invalid/);
    });

    it("bounds policy-dependent flags without terms and pins them with terms", () => {
        // Every required slot is unmeasured, so with terms the derived outcome denies both flags.
        expect(presentLanes.body.outcome).toMatchObject({ promotionAllowed: false, mandatoryEvidenceComplete: false });
        const claimed = withOutcome(presentLanes, { promotionAllowed: true, mandatoryEvidenceComplete: true });
        expect(parseScorecardReport(claimed).body.outcome.promotionAllowed).toBe(true);
        expect(() => parseScorecardReport(claimed, terms)).toThrow(/mandatoryEvidenceComplete: cross-field-invalid/);
        const primarySlot = PRIMARY_ENDPOINT_SLOTS[policy.primaryEndpoint];
        expect(() => parseScorecardReport(claimed, { requiredMetricSlots: [primarySlot], maxToleratedRegressions: 0 })).toThrow(/cross-field-invalid/);
        expect(parseScorecardReport(claimed, { requiredMetricSlots: [], maxToleratedRegressions: 0 })).toEqual(claimed);
    });
});
