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
import { SCORECARD_GATE_IDS, SCORE_FAMILY_IDS, ScorecardContractError, LANE_IDS } from "./policy";
import { REPORT_BODY_KEYS, deriveOutcome, parseScorecardReport, type ScorecardReport } from "./report-contract";
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

/**
 * Rewrites every gate as passed so the exit-0 and exit-1 paths are reachable. The parser refuses an
 * observed row for a gate no lane produces, so the result is not re-parsed; it exercises
 * `deriveOutcome` and `scorecardExitCode` over rows the builder derived.
 */
function allGatesPassed(bundle: ScorecardEvidenceBundle): ScorecardReport {
    const report = buildScorecardReport(bundle);
    const body = structuredClone(report.body);
    const metamorphic = body.evidence.lanes.find((row) => row.lane === "metamorphic")!.reportFingerprint ?? H1;
    body.safetyGates = body.safetyGates.map((row) => row.status === "passed"
        ? row
        : { ...row, status: "passed", observedCount: 0, evidenceFingerprint: metamorphic, sourceLane: "metamorphic", diagnostic: null });
    body.limitations = body.limitations.filter((code) => code !== "hard-gates-unobserved");
    body.outcome = deriveOutcome({
        gates: body.safetyGates,
        lanes: body.evidence.lanes,
        baseline: body.evidence.baseline,
        families: SCORE_FAMILY_IDS.map((family) => body[family]),
        requiredMetricSlots: bundle.policy.requiredMetricSlots,
        adverseDeltas: body.adverseDeltas,
        maxToleratedRegressions: bundle.policy.maxToleratedRegressions,
    });
    return { schema: report.schema, body, reportFingerprint: canonicalFingerprint(body) };
}

function baselineReport(options: BundleFixtureOptions = {}): ScorecardReport {
    return buildScorecardReport(bundleFixture(options));
}

const REGRESSED = pairedDeltaReportFixture({
    familyDeltas: { "fam-a": 0.1, "fam-b": 0.1 },
    noiseFloors: (["mc-on-vs-mc-off", "mc-on-vs-compaction"] as const).flatMap((endpoint) => [
        { endpoint, familyId: "fam-a", value: 0.01, interval: { lower: 0, upper: 0.01 } },
        { endpoint, familyId: "fam-b", value: 0.01, interval: { lower: 0, upper: 0.01 } },
    ]),
});

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

    it("records the policy terms the outcome depends on so the parser can recompute it", () => {
        const policy = policyFixture({ maxToleratedRegressions: 3, requiredMetricSlots: ["ctx-expand-recovery"] });
        const bundle = bundleFixture({ policy });
        const report = buildScorecardReport(bundle);
        expect(report.body.target).toMatchObject({ maxToleratedRegressions: 3, requiredMetricSlots: ["ctx-expand-recovery"] });
        const forged = structuredClone(report.body);
        forged.outcome.promotionAllowed = true;
        expect(() => parseScorecardReport({ schema: report.schema, body: forged, reportFingerprint: canonicalFingerprint(forged) }))
            .toThrow(/outcome: cross-field-invalid/);
        expect(() => publishScorecardReport({ bundle, report: { schema: report.schema, body: forged, reportFingerprint: canonicalFingerprint(forged) } }, "/dev/null"))
            .toThrow(/scorecard: report-bundle-mismatch/);
    });

    it("refuses a bundle whose parsed lane or baseline report no longer matches its recorded fingerprint", () => {
        const edited = bundleFixture();
        const lane = edited.lanes.find((row) => row.lane === "paired-delta")!;
        if (lane.lane !== "paired-delta" || lane.report === null) throw new Error("fixture lane absent");
        lane.report.body.analysis.endpoints[0]!.families[0]!.pointEstimate += 1;
        expect(() => buildScorecardReport(edited)).toThrow(/scorecard: lane-fingerprint-mismatch-paired-delta/);
        const baseline = baselineReport();
        const withBaseline = bundleFixture({ policy: policyFixture({ baselineScorecardReportFingerprint: baseline.reportFingerprint }), baseline });
        withBaseline.baseline.report!.body.utility.familyEstimates[0]!.pointEstimate += 1;
        expect(() => buildScorecardReport(withBaseline)).toThrow(/scorecard: baseline-fingerprint-mismatch/);
    });

    it("passes the shared privacy scan and admits only reason codes as limitations", () => {
        const report = buildScorecardReport(bundleFixture());
        expect(scanForSensitiveContent(report)).toEqual([]);
        expect(report.body.limitations.every((code) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(code))).toBe(true);
        expect(report.body.limitations).toContain("no-baseline");
        expect(report.body.limitations).toContain("hard-gates-unobserved");
        expect(new Set(report.body.limitations).size).toBe(report.body.limitations.length);
        const tampered = structuredClone(report);
        tampered.body.limitations.push("Operator note: see /home/me");
        tampered.reportFingerprint = canonicalFingerprint(tampered.body);
        expect(() => parseScorecardReport(tampered)).toThrow(/limitations\[\d+\]: id-invalid/);
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
        const policy = policyFixture({ baselineScorecardReportFingerprint: baseline.reportFingerprint });
        const blocked = allGatesPassed(bundleFixture({ policy, baseline, lanes: { "paired-delta": REGRESSED } }));
        expect(blocked.body.adverseDeltas.length).toBeGreaterThan(0);
        expect(blocked.body.adverseDeltas.every((row) => row.blocking)).toBe(true);
        expect(blocked.body.outcome.blockingRegressionCount).toBe(blocked.body.adverseDeltas.length);
        expect(blocked.body.outcome.promotionAllowed).toBe(false);
        expect(scorecardExitCode(blocked)).toBe(1);
        const tolerant = allGatesPassed(bundleFixture({
            policy: policyFixture({ baselineScorecardReportFingerprint: baseline.reportFingerprint, maxToleratedRegressions: 4 }),
            baseline,
            lanes: { "paired-delta": REGRESSED },
        }));
        expect(scorecardExitCode(tolerant)).toBe(0);
        expect(tolerant.body.utility.deltas.every((row) => row.status === "compared")).toBe(true);
    });

    it("denies promotion and exits 1 when the policy pins a baseline the bundle cannot compare against", () => {
        const policy = policyFixture({ baselineScorecardReportFingerprint: H3 });
        const bundle = bundleFixture({ policy, baseline: null });
        expect(bundle.baseline.status).toBe("schema-mismatch");
        const report = allGatesPassed(bundle);
        expect(report.body.adverseDeltas).toEqual([]);
        expect(report.body.outcome).toMatchObject({ promotionAllowed: false, mandatoryEvidenceComplete: false, blockingRegressionCount: 0 });
        expect(report.body.limitations.filter((code) => code === "baseline-not-comparable")).toHaveLength(1);
        expect(report.body.limitations).toContain("baseline-path-missing");
        expect(scorecardExitCode(report)).toBe(1);
        const built = buildScorecardReport(bundle);
        const forged = structuredClone(built.body);
        forged.outcome.mandatoryEvidenceComplete = true;
        expect(() => parseScorecardReport({ schema: built.schema, body: forged, reportFingerprint: canonicalFingerprint(forged) }))
            .toThrow(/outcome: cross-field-invalid/);
    });

    it("denies promotion when the pinned baseline loaded but its own paired-delta lane did not finish", () => {
        const hollow = baselineReport({ statuses: { "paired-delta": "missing" } });
        expect(hollow.body.utility.familyEstimates).toEqual([]);
        const policy = policyFixture({ baselineScorecardReportFingerprint: hollow.reportFingerprint });
        const report = allGatesPassed(bundleFixture({ policy, baseline: hollow }));
        expect(report.body.evidence.baseline).toMatchObject({ status: "present", estimatesStatus: "missing" });
        expect(report.body.adverseDeltas).toEqual([]);
        expect(report.body.outcome).toMatchObject({ promotionAllowed: false, mandatoryEvidenceComplete: false, blockingRegressionCount: 0 });
        expect(report.body.limitations).toContain("baseline-estimates-unavailable");
        expect(scorecardExitCode(report)).toBe(1);
        const bundle = bundleFixture({ policy, baseline: hollow });
        const built = buildScorecardReport(bundle);
        const forgedOutcome = structuredClone(built.body);
        forgedOutcome.outcome.mandatoryEvidenceComplete = true;
        expect(() => parseScorecardReport({ schema: built.schema, body: forgedOutcome, reportFingerprint: canonicalFingerprint(forgedOutcome) }))
            .toThrow(/outcome: cross-field-invalid/);
        // The recorded estimate status is a loader fact the report cannot recompute; the bundle-side admission catches it.
        const forgedRow = structuredClone(built.body);
        forgedRow.evidence.baseline.estimatesStatus = "present";
        forgedRow.outcome.mandatoryEvidenceComplete = true;
        expect(() => publishScorecardReport({ bundle, report: { schema: built.schema, body: forgedRow, reportFingerprint: canonicalFingerprint(forgedRow) } }, "/dev/null"))
            .toThrow(/scorecard: report-bundle-mismatch/);
    });

    it("refuses a bundle whose policy terms do not match the fingerprint it names", () => {
        const bundle = bundleFixture();
        bundle.policy = { ...bundle.policy, maxToleratedRegressions: 99 };
        expect(() => buildScorecardReport(bundle)).toThrow(/scorecard: policy-fingerprint-mismatch/);
    });

    it("reports four not-observed gates and one passed injection gate from lane-built fixtures", () => {
        const report = buildScorecardReport(bundleFixture({ lanes: { metamorphic: metamorphicReportFixture() } }));
        expect(report.body.safetyGates.filter((row) => row.status === "not-observed")).toHaveLength(4);
        expect(report.body.safetyGates.find((row) => row.gateId === "gate-injection-promoted")?.status).toBe("passed");
        expect(report.body.regret.length).toBeGreaterThan(0);
    });
});

describe("publishScorecardReport", () => {
    it("writes the report recomputed from the bundle as canonical bytes and refuses a copy the bundle does not produce", () => {
        const root = mkdtempSync(join(tmpdir(), "scorecard-report-"));
        roots.push(root);
        const bundle = bundleFixture();
        const report = buildScorecardReport(bundle);
        const path = join(root, "scorecard-report.json");
        publishScorecardReport({ bundle, report }, path);
        expect(readFileSync(path, "utf8")).toBe(`${JSON.stringify(report, null, 2)}\n`);
        expect(readCanonicalJsonFile(path, (code) => new Error(code))).toEqual(JSON.parse(JSON.stringify(report)));
        const drifted = structuredClone(report);
        drifted.body.outcome.blockingRegressionCount = 7;
        drifted.reportFingerprint = canonicalFingerprint(drifted.body);
        const mismatched = join(root, "mismatched.json");
        expect(() => publishScorecardReport({ bundle, report: drifted }, mismatched)).toThrow(/scorecard: report-bundle-mismatch/);
        expect(existsSync(mismatched)).toBe(false);
        const foreign = buildScorecardReport(bundleFixture({ freezeManifestFingerprint: H3 }));
        expect(() => publishScorecardReport({ bundle, report: foreign }, mismatched)).toThrow(/scorecard: report-bundle-mismatch/);
        expect(existsSync(mismatched)).toBe(false);
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

    function analysisPolicy(bundle: ScorecardEvidenceBundle): string {
        const pairedDelta = bundle.lanes.find((lane) => lane.lane === "paired-delta")!;
        if (pairedDelta.lane !== "paired-delta" || pairedDelta.report === null) throw new Error("fixture lane absent");
        return pairedDelta.report.body.policyFingerprint;
    }

    /** A bundle whose paired-delta lane analyzed `PAIRED_FACTS`, as a prospective comparison does. */
    function boundBundle(options: BundleFixtureOptions = {}, pairedDelta: Parameters<typeof pairedDeltaReportFixture>[0] = {}): ScorecardEvidenceBundle {
        return bundleFixture({ ...options, lanes: { ...options.lanes, "paired-delta": pairedDeltaReportFixture({ pairs: PAIRED_FACTS, ...pairedDelta }) } });
    }

    function holdout(bundle: ScorecardEvidenceBundle, pairs = PAIRED_FACTS) {
        return {
            pairs,
            estimator: estimator(bundle).analyze(PAIRED_FACTS, analysisPolicy(bundle)),
            freezeManifestFingerprint: bundle.freezeManifestFingerprint,
        };
    }

    it("rejects a report that was not derived from the supplied bundle", () => {
        const bundle = boundBundle();
        const foreign = buildScorecardReport(boundBundle({ freezeManifestFingerprint: H3 }));
        expect(() => createScorecardAdapter({ bundle, report: foreign })).toThrow(/adapter: report-bundle-mismatch/);
        expect(() => createScorecardAdapter({ bundle, report: allGatesPassed(bundle) })).toThrow(/adapter: report-bundle-mismatch/);
        expect(() => createScorecardAdapter({ bundle, report: buildScorecardReport(bundle) })).not.toThrow();
    });

    it("attests the recomputed outcome, not a forged body or an input mutated after construction", () => {
        const bundle = boundBundle();
        const genuine = buildScorecardReport(bundle);
        const forged = structuredClone(genuine);
        forged.body.outcome = { promotionAllowed: true, mandatoryEvidenceComplete: true, hardGateFailures: [], blockingRegressionCount: 0 };
        const fromForged = createScorecardAdapter({ bundle, report: forged });
        expect(fromForged.evaluate(holdout(bundle), bundle.policyFingerprint)).toMatchObject({
            promotionAllowed: false,
            hardGateFailures: genuine.body.outcome.hardGateFailures,
        });
        const mutableBundle = boundBundle();
        const adapter = createScorecardAdapter({ bundle: mutableBundle, report: genuine });
        const before = adapter.evaluate(holdout(mutableBundle), mutableBundle.policyFingerprint);
        genuine.body.outcome.promotionAllowed = true;
        mutableBundle.policyFingerprint = H3;
        mutableBundle.lanes[0]!.reportFingerprint = H3;
        expect(adapter.evaluate(holdout(bundle), bundle.policyFingerprint)).toEqual(before);
        expect(before.promotionAllowed).toBe(false);
    });

    it("rejects a foreign policy or freeze fingerprint, foreign paired facts, and an estimator result from another analysis", () => {
        const bundle = boundBundle();
        const adapter = createScorecardAdapter({ bundle, report: buildScorecardReport(bundle) });
        expect(() => adapter.evaluate(holdout(bundle), H3)).toThrow(/adapter: policy-fingerprint-mismatch/);
        expect(() => adapter.evaluate({ ...holdout(bundle), freezeManifestFingerprint: H3 }, bundle.policyFingerprint))
            .toThrow(/adapter: freeze-fingerprint-mismatch/);
        expect(() => adapter.evaluate(holdout(bundle, PAIRED_FACTS.slice(1)), bundle.policyFingerprint)).toThrow(/adapter: evidence-pairs-mismatch/);
        const otherAnalysis = boundBundle({}, { familyDeltas: { "fam-a": 0.9, "fam-b": 0.9 } });
        expect(() => adapter.evaluate({ ...holdout(bundle), estimator: holdout(otherAnalysis).estimator }, bundle.policyFingerprint))
            .toThrow(/adapter: estimator-result-mismatch/);
        const genuine = holdout(bundle);
        const wrapped = { ...genuine, estimator: { ...genuine.estimator, evidenceSufficient: !genuine.estimator.evidenceSufficient } };
        expect(() => adapter.evaluate(wrapped, bundle.policyFingerprint)).toThrow(/adapter: estimator-result-mismatch/);
        expect(() => adapter.evaluate(holdout(bundle), H3)).toThrow(ScorecardContractError);
        const mutable = boundBundle();
        const mutableAdapter = createScorecardAdapter({ bundle: mutable, report: buildScorecardReport(mutable) });
        const lane = mutable.lanes.find((row) => row.lane === "paired-delta")!;
        if (lane.lane !== "paired-delta" || lane.report === null) throw new Error("fixture lane absent");
        lane.report.body.analysis.endpoints[0]!.families[0]!.pointEstimate += 1;
        expect(() => mutableAdapter.evaluate(holdout(mutable), mutable.policyFingerprint)).toThrow(/adapter: estimator-result-mismatch/);
        expect(() => mutableAdapter.evaluate(holdout(bundle), bundle.policyFingerprint)).not.toThrow();
    });

    it("attests the report's own denial when the paired-delta lane is absent instead of throwing", () => {
        const bundle = boundBundle({ statuses: { "paired-delta": "missing" } });
        const report = buildScorecardReport(bundle);
        const adapter = createScorecardAdapter({ bundle, report });
        const outcome = adapter.evaluate(
            { pairs: PAIRED_FACTS, estimator: holdout(boundBundle()).estimator, freezeManifestFingerprint: bundle.freezeManifestFingerprint },
            bundle.policyFingerprint,
        );
        expect(outcome).toMatchObject({ promotionAllowed: false, mandatoryEvidenceComplete: false });
        expect(report.body.outcome.mandatoryEvidenceComplete).toBe(false);
    });

    it("drives the prospective report to hard-gate-failed and recomputes to the same result fingerprint", () => {
        const bundle = boundBundle();
        const report = buildScorecardReport(bundle);
        const scorecard = createScorecardAdapter({ bundle, report });
        const prospective = buildProspectiveReport({
            epochId: "epoch-test-release",
            freezeManifestFingerprint: bundle.freezeManifestFingerprint,
            closeManifestFingerprint: H3,
            analysisPolicyFingerprint: analysisPolicy(bundle),
            scorecardPolicyFingerprint: bundle.policyFingerprint,
            pairs: PAIRED_FACTS,
            estimator: estimator(bundle),
            scorecard,
            invalidated: false,
        });
        expect(prospective.body.decision).toBe("hard-gate-failed");
        expect(prospective.body.hardGateFailures).toEqual(report.body.outcome.hardGateFailures);
        expect(() => validateProspectiveReportEvidence(prospective, PAIRED_FACTS, { estimator: estimator(bundle), scorecard })).not.toThrow();

        const swappedLane = boundBundle({ lanes: { metamorphic: metamorphicReportFixture({ coveredScenarioIds: ["hse-webhook-docs-injection"] }) } });
        const swapped = createScorecardAdapter({ bundle: swappedLane, report: buildScorecardReport(swappedLane) });
        expect(() => validateProspectiveReportEvidence(prospective, PAIRED_FACTS, { estimator: estimator(bundle), scorecard: swapped })).toThrow(/sibling-recomputation-mismatch/);
        expect(() => validateProspectiveReportEvidence(prospective, PAIRED_FACTS.slice(1), { estimator: estimator(bundle), scorecard })).toThrow(/deterministic-recomputation-mismatch/);
        const otherFreeze = boundBundle({ freezeManifestFingerprint: H3 });
        const otherFreezeAdapter = createScorecardAdapter({ bundle: otherFreeze, report: buildScorecardReport(otherFreeze) });
        expect(() => validateProspectiveReportEvidence(prospective, PAIRED_FACTS, { estimator: estimator(bundle), scorecard: otherFreezeAdapter }))
            .toThrow(/adapter: freeze-fingerprint-mismatch/);
    });
});
