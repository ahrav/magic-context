import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { scanForSensitiveContent } from "../../../plugin/scripts/retrieval-benchmark/privacy";
import { writeJsonAtomically } from "../../scripts/atomic-json-write";
import { createFamilyEstimatorAdapter } from "../paired-delta/estimator";
import { pairedFactsFingerprint, type ScorecardAdapter, type ScorecardOutcome } from "../prospective-holdout/report";
import { baselineEstimates, compareWithBaseline, regretRows } from "./comparison";
import { laneEvidence, type ScorecardEvidenceBundle } from "./evidence";
import { buildScoreFamilies } from "./families";
import { evaluateGates } from "./gates";
import { SCORECARD_POLICY_OWNER, SCORE_FAMILY_IDS, ScorecardContractError, reasonCode, scorecardPolicyFingerprint } from "./policy";
import {
    SCORECARD_REPORT_SCHEMA,
    deriveOutcome,
    parseScorecardReport,
    type EvidenceRow,
    type ScorecardReport,
    type ScorecardReportBody,
} from "./report-contract";

export type ScorecardExitCode = 0 | 1 | 2;

/**
 * Every recorded fingerprint must still describe the parsed object beside it: the loader fixed both
 * at read time, and a report derived from an object edited since would attribute the edit to the archive.
 */
function verifyBundleFingerprints(bundle: ScorecardEvidenceBundle): void {
    if (scorecardPolicyFingerprint(bundle.policy) !== bundle.policyFingerprint) throw new ScorecardContractError(["scorecard: policy-fingerprint-mismatch"]);
    for (const lane of bundle.lanes) {
        if (lane.report !== null && canonicalFingerprint(lane.report) !== lane.reportFingerprint) {
            throw new ScorecardContractError([`scorecard: lane-fingerprint-mismatch-${lane.lane}`]);
        }
    }
    const baseline = bundle.baseline;
    if (baseline.report !== null && (canonicalFingerprint(baseline.report.body) !== baseline.reportFingerprint || baseline.report.reportFingerprint !== baseline.reportFingerprint)) {
        throw new ScorecardContractError(["scorecard: baseline-fingerprint-mismatch"]);
    }
}

/** Every section is derived here from the bundle; nothing in the outcome is supplied by a caller. */
export function buildScorecardReport(bundle: ScorecardEvidenceBundle): ScorecardReport {
    verifyBundleFingerprints(bundle);
    const safetyGates = evaluateGates(bundle);
    const families = buildScoreFamilies(bundle);
    const baseline = baselineEstimates(bundle.baseline);
    const comparison = compareWithBaseline(
        { status: laneEvidence(bundle, "paired-delta").status, familyEstimates: families.utility.familyEstimates },
        baseline,
    );
    const baselineRow = { status: bundle.baseline.status, reportFingerprint: bundle.baseline.reportFingerprint, estimatesStatus: baseline.estimatesStatus };
    const lanes: EvidenceRow[] = bundle.lanes.map((lane) => ({
        lane: lane.lane,
        status: lane.status,
        reportFingerprint: lane.reportFingerprint,
        identity: lane.identity,
        diagnostics: lane.diagnostics,
    }));
    const partial = {
        target: {
            freezeManifestFingerprint: bundle.freezeManifestFingerprint,
            policyFingerprint: bundle.policyFingerprint,
            pairedDeltaPolicyFingerprint: bundle.policy.pairedDeltaPolicyFingerprint,
            baselineScorecardReportFingerprint: bundle.policy.baselineScorecardReportFingerprint,
            maxToleratedRegressions: bundle.policy.maxToleratedRegressions,
            requiredMetricSlots: [...bundle.policy.requiredMetricSlots],
        },
        utility: { ...families.utility, deltas: comparison.deltas },
        formation: families.formation,
        retrieval: families.retrieval,
        context: families.context,
        reliability: families.reliability,
        safetyGates,
        regret: regretRows(bundle),
        adverseDeltas: comparison.adverseDeltas,
    };
    const outcome = deriveOutcome({
        gates: safetyGates,
        lanes,
        baseline: baselineRow,
        families: SCORE_FAMILY_IDS.map((family) => families[family]),
        requiredMetricSlots: bundle.policy.requiredMetricSlots,
        adverseDeltas: comparison.adverseDeltas,
        maxToleratedRegressions: bundle.policy.maxToleratedRegressions,
    });
    // The contract rejects duplicate reason codes, and more than one source can name the same one.
    const limitations = [...new Set([
        ...bundle.limitations,
        ...comparison.limitations,
        ...bundle.baseline.diagnostics,
        ...(safetyGates.some((row) => row.status === "not-observed" || row.status === "errored") ? ["hard-gates-unobserved"] : []),
        ...(outcome.mandatoryEvidenceComplete ? [] : ["mandatory-evidence-incomplete"]),
    ].map(reasonCode))];
    const body: ScorecardReportBody = {
        ...partial,
        limitations,
        evidence: { lanes, baseline: baselineRow },
        outcome,
    };
    return parseScorecardReport({ schema: SCORECARD_REPORT_SCHEMA, body, reportFingerprint: canonicalFingerprint(body) });
}

export function scorecardExitCode(report: ScorecardReport): ScorecardExitCode {
    if (report.body.outcome.hardGateFailures.length > 0) return 2;
    return report.body.outcome.promotionAllowed ? 0 : 1;
}

/**
 * The report alone cannot prove a produced gate's status or a `family-missing` row, so both consumers
 * of a report recompute it from the bundle and admit the caller's copy only by matching fingerprint.
 */
function derivedFrom(input: { bundle: ScorecardEvidenceBundle; report: ScorecardReport }, code: string): ScorecardReport {
    const derived = buildScorecardReport(input.bundle);
    if (derived.reportFingerprint !== input.report.reportFingerprint) throw new ScorecardContractError([code]);
    return derived;
}

/** Writes the recomputed report, never the caller's copy. */
export function publishScorecardReport(input: { bundle: ScorecardEvidenceBundle; report: ScorecardReport }, path: string): void {
    const report = derivedFrom(input, "scorecard: report-bundle-mismatch");
    if (scanForSensitiveContent(report).length > 0) throw new ScorecardContractError(["scorecard: privacy-rejected"]);
    writeJsonAtomically(path, report, "scorecard-report");
}

export function createScorecardAdapter(input: { bundle: ScorecardEvidenceBundle; report: ScorecardReport }): ScorecardAdapter {
    const derived = derivedFrom(input, "adapter: report-bundle-mismatch");
    // Cloned so the estimator the adapter recomputes cannot follow a later edit to the bundle's analysis.
    const pairedDelta = structuredClone(laneEvidence(input.bundle, "paired-delta").report);
    // An estimator result from any other analysis of the same pairs must not pair with this promotion decision.
    const archivedEstimator = pairedDelta === null ? null : {
        pairedFactsFingerprint: pairedDelta.body.analysis.pairedFactsFingerprint,
        policyFingerprint: pairedDelta.body.policyFingerprint,
        adapter: createFamilyEstimatorAdapter({
            poolManifestFingerprint: pairedDelta.body.poolManifestFingerprint,
            pinnedSnapshotId: pairedDelta.body.pinnedSnapshotId,
            policyFingerprint: pairedDelta.body.policyFingerprint,
            analysis: pairedDelta.body.analysis,
        }),
    };
    const attested = {
        policyFingerprint: derived.body.target.policyFingerprint,
        freezeManifestFingerprint: derived.body.target.freezeManifestFingerprint,
        laneReports: derived.body.evidence.lanes.map((lane) => ({ lane: lane.lane, reportFingerprint: lane.reportFingerprint })),
        baselineScorecardReportFingerprint: derived.body.evidence.baseline.reportFingerprint,
        scorecardReportFingerprint: derived.reportFingerprint,
        hardGateFailures: [...derived.body.outcome.hardGateFailures],
        mandatoryEvidenceComplete: derived.body.outcome.mandatoryEvidenceComplete,
        promotionAllowed: derived.body.outcome.promotionAllowed,
    };
    return {
        owner: SCORECARD_POLICY_OWNER,
        evaluate(holdout, policyFingerprint): ScorecardOutcome {
            if (policyFingerprint !== attested.policyFingerprint) throw new ScorecardContractError(["adapter: policy-fingerprint-mismatch"]);
            if (holdout.freezeManifestFingerprint !== attested.freezeManifestFingerprint) {
                throw new ScorecardContractError(["adapter: freeze-fingerprint-mismatch"]);
            }
            const pairedFacts = pairedFactsFingerprint(holdout.pairs);
            // Without paired-delta evidence, no archived estimator can validate `holdout.pairs`.
            if (archivedEstimator !== null) {
                if (archivedEstimator.pairedFactsFingerprint !== pairedFacts) throw new ScorecardContractError(["adapter: evidence-pairs-mismatch"]);
                // Every projected field, not only the fingerprint: a wrapper can return the genuine fingerprint with an edited direction.
                const expected = archivedEstimator.adapter.analyze(holdout.pairs, archivedEstimator.policyFingerprint);
                if (canonicalFingerprint(expected) !== canonicalFingerprint(holdout.estimator)) {
                    throw new ScorecardContractError(["adapter: estimator-result-mismatch"]);
                }
            }
            const outcome = { ...attested, pairedFactsFingerprint: pairedFacts };
            return {
                hardGateFailures: [...outcome.hardGateFailures],
                mandatoryEvidenceComplete: outcome.mandatoryEvidenceComplete,
                promotionAllowed: outcome.promotionAllowed,
                resultFingerprint: canonicalFingerprint(outcome),
            };
        },
    };
}
