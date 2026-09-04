import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalFingerprint, readCanonicalJsonFile } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { scanForSensitiveContent } from "../../../plugin/scripts/retrieval-benchmark/privacy";
import { createFamilyEstimatorAdapter } from "../paired-delta/estimator";
import { buildProspectiveReport, validateProspectiveReportEvidence } from "../prospective-holdout/report";
import { H3 } from "../prospective-holdout/test-fixtures";
import type { ScorecardEvidenceBundle } from "./evidence";
import { SCORECARD_GATE_IDS, ScorecardContractError, LANE_IDS } from "./policy";
import { REPORT_BODY_KEYS, baselineComparable, parseScorecardReport, type ScorecardReport } from "./report-contract";
import { buildScorecardReport, createScorecardAdapter, publishScorecardReport, scorecardExitCode } from "./report";
import {
    H1,
    PAIRED_FACTS,
    bundleFixture,
    metamorphicReportFixture,
    pairedDeltaReportFixture,
    policyFixture,
    type BundleFixtureOptions,
} from "./test-fixtures";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Rewriting non-passing gates makes the exit-0 and exit-1 test paths reachable. */
function allGatesPassed(bundle: ScorecardEvidenceBundle): ScorecardReport {
    const report = buildScorecardReport(bundle);
    const body = structuredClone(report.body);
    body.safetyGates = body.safetyGates.map((row) => row.status === "passed"
        ? row
        : { ...row, status: "passed", observedCount: 0, evidenceFingerprint: H1, sourceLane: "incident", diagnostic: null });
    body.outcome.hardGateFailures = [];
    body.limitations = body.limitations.filter((code) => code !== "hard-gates-unobserved");
    body.outcome.promotionAllowed = body.outcome.mandatoryEvidenceComplete
        && baselineComparable(body.target, body.evidence.baseline)
        && body.outcome.blockingRegressionCount <= bundle.policy.maxToleratedRegressions;
    return parseScorecardReport({ schema: report.schema, body, reportFingerprint: canonicalFingerprint(body) });
}

function baselineReport(options: BundleFixtureOptions = {}): ScorecardReport {
    return buildScorecardReport(bundleFixture(options));
}

describe("buildScorecardReport", () => {
    it("is byte-identical for identical inputs and keeps the fixed section order", () => {
        const first = buildScorecardReport(bundleFixture());
        const second = buildScorecardReport(bundleFixture());
        expect(JSON.stringify(first)).toBe(JSON.stringify(second));
        expect(first.reportFingerprint).toBe(second.reportFingerprint);
        expect(Object.keys(first.body)).toEqual([...REPORT_BODY_KEYS]);
        expect(first.body.safetyGates.map((row) => row.gateId)).toEqual([...SCORECARD_GATE_IDS]);
        expect(first.body.evidence.lanes.map((row) => row.lane)).toEqual([...LANE_IDS]);
        expect(parseScorecardReport(JSON.parse(JSON.stringify(first)))).toEqual(first);
    });

    it("passes the shared privacy scan and admits only reason codes as limitations", () => {
        const report = buildScorecardReport(bundleFixture());
        expect(scanForSensitiveContent(report)).toEqual([]);
        expect(report.body.limitations).toEqual([
            ...LANE_IDS.map((lane) => `identity-unverified-${lane}`),
            "no-baseline",
            "hard-gates-unobserved",
        ]);
        const tampered = structuredClone(report);
        tampered.body.limitations.push("Operator note: see /home/me");
        tampered.reportFingerprint = canonicalFingerprint(tampered.body);
        expect(() => parseScorecardReport(tampered)).toThrow(/limitations\[8\]: id-invalid/);
    });

    it("blocks promotion and exits 2 when any gate is not-observed even with every delta positive", () => {
        const report = buildScorecardReport(bundleFixture());
        expect(report.body.outcome.mandatoryEvidenceComplete).toBe(true);
        expect(report.body.outcome.hardGateFailures).toEqual(SCORECARD_GATE_IDS.filter((gate) => gate !== "gate-injection-promoted").sort());
        expect(report.body.outcome.promotionAllowed).toBe(false);
        expect(scorecardExitCode(report)).toBe(2);
    });

    it("allows promotion and exits 0 only when gates pass, lanes are present, required slots are measured, and blocking rows fit", () => {
        const report = allGatesPassed(bundleFixture());
        expect(report.body.outcome).toEqual({ promotionAllowed: true, mandatoryEvidenceComplete: true, hardGateFailures: [], blockingRegressionCount: 0 });
        expect(scorecardExitCode(report)).toBe(0);
    });

    it("exits 1 when a required slot is not measured or a lane is not present", () => {
        const missingLane = allGatesPassed(bundleFixture({ statuses: { historian: "missing" } }));
        expect(missingLane.body.outcome).toMatchObject({ promotionAllowed: false, mandatoryEvidenceComplete: false });
        expect(missingLane.body.limitations).toContain("mandatory-evidence-incomplete");
        expect(scorecardExitCode(missingLane)).toBe(1);
        const unmeasured = allGatesPassed(bundleFixture({ policy: policyFixture({ requiredMetricSlots: ["ctx-expand-recovery"] }) }));
        expect(unmeasured.body.outcome.mandatoryEvidenceComplete).toBe(false);
        expect(scorecardExitCode(unmeasured)).toBe(1);
    });

    it("exits 1 when blocking regressions exceed the tolerance and 0 when the tolerance absorbs them", () => {
        const baseline = baselineReport({ lanes: { "paired-delta": pairedDeltaReportFixture({ familyDeltas: { "fam-a": 0.9, "fam-b": 0.9 } }) } });
        const regressed = pairedDeltaReportFixture({
            familyDeltas: { "fam-a": 0.1, "fam-b": 0.1 },
            noiseFloors: [
                { familyId: "fam-a", value: 0.01, interval: { lower: 0, upper: 0.01 } },
                { familyId: "fam-b", value: 0.01, interval: { lower: 0, upper: 0.01 } },
            ],
        });
        const policy = policyFixture({ baselineScorecardReportFingerprint: baseline.reportFingerprint });
        const blocked = allGatesPassed(bundleFixture({ policy, baseline, lanes: { "paired-delta": regressed } }));
        expect(blocked.body.adverseDeltas.length).toBeGreaterThan(0);
        expect(blocked.body.adverseDeltas.every((row) => row.blocking)).toBe(true);
        expect(blocked.body.outcome.blockingRegressionCount).toBe(blocked.body.adverseDeltas.length);
        expect(blocked.body.outcome.promotionAllowed).toBe(false);
        expect(scorecardExitCode(blocked)).toBe(1);
        const tolerant = allGatesPassed(bundleFixture({
            policy: policyFixture({ baselineScorecardReportFingerprint: baseline.reportFingerprint, maxToleratedRegressions: 4 }),
            baseline,
            lanes: { "paired-delta": regressed },
        }));
        expect(scorecardExitCode(tolerant)).toBe(0);
        expect(tolerant.body.utility.deltas.every((row) => row.status === "compared")).toBe(true);
    });

    it("denies promotion and exits 1 when the policy pins a baseline the bundle cannot compare against", () => {
        const policy = policyFixture({ baselineScorecardReportFingerprint: H3 });
        const report = allGatesPassed(bundleFixture({ policy, baseline: null }));
        expect(report.body.adverseDeltas).toEqual([]);
        expect(report.body.outcome).toMatchObject({ promotionAllowed: false, mandatoryEvidenceComplete: true, blockingRegressionCount: 0 });
        expect(report.body.limitations).toContain("baseline-not-comparable");
        expect(scorecardExitCode(report)).toBe(1);
        const forged = structuredClone(report.body);
        forged.outcome.promotionAllowed = true;
        expect(() => parseScorecardReport({ schema: report.schema, body: forged, reportFingerprint: canonicalFingerprint(forged) }))
            .toThrow(/outcome\.promotionAllowed: cross-field-invalid/);
    });

    it("reports four not-observed gates and one passed injection gate from lane-built fixtures", () => {
        const report = buildScorecardReport(bundleFixture({ lanes: { metamorphic: metamorphicReportFixture() } }));
        expect(report.body.safetyGates.filter((row) => row.status === "not-observed")).toHaveLength(4);
        expect(report.body.safetyGates.find((row) => row.gateId === "gate-injection-promoted")?.status).toBe("passed");
        expect(report.body.regret.length).toBeGreaterThan(0);
    });
});

describe("publishScorecardReport", () => {
    it("writes canonical bytes a canonical reader accepts and refuses a report that fails the privacy scan", () => {
        const root = mkdtempSync(join(tmpdir(), "scorecard-report-"));
        roots.push(root);
        const report = buildScorecardReport(bundleFixture());
        const path = join(root, "scorecard-report.json");
        publishScorecardReport(report, path);
        expect(readFileSync(path, "utf8")).toBe(`${JSON.stringify(report, null, 2)}\n`);
        expect(readCanonicalJsonFile(path, (code) => new Error(code))).toEqual(JSON.parse(JSON.stringify(report)));
        const leaking = structuredClone(report) as unknown as { body: { target: Record<string, unknown> } };
        leaking.body.target.freezeManifestFingerprint = "/home/operator/freeze";
        const refused = join(root, "refused.json");
        expect(() => publishScorecardReport(leaking as unknown as ScorecardReport, refused)).toThrow(/scorecard: privacy-rejected/);
        expect(existsSync(refused)).toBe(false);
    });
});

describe("createScorecardAdapter", () => {
    function estimator(bundle: ScorecardEvidenceBundle) {
        const pairedDelta = bundle.lanes.find((lane) => lane.lane === "paired-delta")!;
        if (pairedDelta.lane !== "paired-delta" || pairedDelta.report === null) throw new Error("fixture lane absent");
        return createFamilyEstimatorAdapter({
            poolManifestFingerprint: pairedDelta.report.body.poolManifestFingerprint,
            pinnedSnapshotId: pairedDelta.report.body.pinnedSnapshotId,
            policyFingerprint: pairedDelta.report.body.policyFingerprint,
            analysis: pairedDelta.report.body.analysis,
        });
    }

    it("rejects a report that was not derived from the supplied bundle", () => {
        const bundle = bundleFixture();
        const foreign = buildScorecardReport(bundleFixture({ freezeManifestFingerprint: H3 }));
        expect(() => createScorecardAdapter({ bundle, report: foreign })).toThrow(/adapter: report-bundle-mismatch/);
        expect(() => createScorecardAdapter({ bundle, report: allGatesPassed(bundle) })).toThrow(/adapter: report-bundle-mismatch/);
        expect(() => createScorecardAdapter({ bundle, report: buildScorecardReport(bundle) })).not.toThrow();
    });

    it("rejects a foreign policy fingerprint and paired facts the paired-delta report did not analyze", () => {
        const bundle = bundleFixture();
        const adapter = createScorecardAdapter({ bundle, report: buildScorecardReport(bundle) });
        const outcome = { direction: "no-change" as const, evidenceSufficient: true, completeFamilyCount: 1, resultFingerprint: H1 };
        expect(() => adapter.evaluate({ pairs: PAIRED_FACTS, estimator: outcome }, H3)).toThrow(/adapter: policy-fingerprint-mismatch/);
        expect(() => adapter.evaluate({ pairs: PAIRED_FACTS.slice(1), estimator: outcome }, bundle.policyFingerprint)).toThrow(/adapter: evidence-pairs-mismatch/);
        expect(() => adapter.evaluate({ pairs: PAIRED_FACTS, estimator: outcome }, H3)).toThrow(ScorecardContractError);
    });

    it("drives the prospective report to hard-gate-failed and recomputes to the same result fingerprint", () => {
        const bundle = bundleFixture();
        const report = buildScorecardReport(bundle);
        const scorecard = createScorecardAdapter({ bundle, report });
        const pairedDelta = bundle.lanes.find((lane) => lane.lane === "paired-delta")!;
        const prospective = buildProspectiveReport({
            epochId: "epoch-test-release",
            freezeManifestFingerprint: bundle.freezeManifestFingerprint,
            closeManifestFingerprint: H3,
            analysisPolicyFingerprint: pairedDelta.report!.body.policyFingerprint,
            scorecardPolicyFingerprint: bundle.policyFingerprint,
            pairs: PAIRED_FACTS,
            estimator: estimator(bundle),
            scorecard,
            invalidated: false,
        });
        expect(prospective.body.decision).toBe("hard-gate-failed");
        expect(prospective.body.hardGateFailures).toEqual(report.body.outcome.hardGateFailures);
        expect(() => validateProspectiveReportEvidence(prospective, PAIRED_FACTS, { estimator: estimator(bundle), scorecard })).not.toThrow();

        const swappedLane = bundleFixture({ lanes: { metamorphic: metamorphicReportFixture({ coveredScenarioIds: ["hse-webhook-docs-injection"] }) } });
        const swapped = createScorecardAdapter({ bundle: swappedLane, report: buildScorecardReport(swappedLane) });
        expect(() => validateProspectiveReportEvidence(prospective, PAIRED_FACTS, { estimator: estimator(bundle), scorecard: swapped })).toThrow(/sibling-recomputation-mismatch/);
        expect(() => validateProspectiveReportEvidence(prospective, PAIRED_FACTS.slice(1), { estimator: estimator(bundle), scorecard })).toThrow(/deterministic-recomputation-mismatch/);
    });
});
