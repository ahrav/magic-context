import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { scanForSensitiveContent } from "../../../plugin/scripts/retrieval-benchmark/privacy";
import { writeJsonAtomically } from "../../scripts/atomic-json-write";
import { pairedFactsFingerprint, type ScorecardAdapter, type ScorecardOutcome } from "../prospective-holdout/report";
import { baselineEstimates, compareWithBaseline, regretRows } from "./comparison";
import { laneEvidence, type ScorecardEvidenceBundle } from "./evidence";
import { buildScoreFamilies } from "./families";
import { evaluateGates } from "./gates";
import { SCORECARD_POLICY_OWNER, SCORE_FAMILY_IDS, ScorecardContractError, reasonCode } from "./policy";
import {
    SCORECARD_REPORT_SCHEMA,
    baselineComparable,
    deriveOutcome,
    parseScorecardReport,
    type EvidenceRow,
    type ScorecardReport,
    type ScorecardReportBody,
} from "./report-contract";

export type ScorecardExitCode = 0 | 1 | 2;

/** Every section is derived here from the bundle; nothing in the outcome is supplied by a caller. */
export function buildScorecardReport(bundle: ScorecardEvidenceBundle): ScorecardReport {
    const safetyGates = evaluateGates(bundle);
    const families = buildScoreFamilies(bundle);
    const comparison = compareWithBaseline(families.utility.familyEstimates, baselineEstimates(bundle.baseline));
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
    const comparable = baselineComparable(partial.target, bundle.baseline);
    const outcome = deriveOutcome({
        gates: safetyGates,
        lanes,
        families: SCORE_FAMILY_IDS.map((family) => families[family]),
        requiredMetricSlots: bundle.policy.requiredMetricSlots,
        adverseDeltas: comparison.adverseDeltas,
        maxToleratedRegressions: bundle.policy.maxToleratedRegressions,
        baselineComparable: comparable,
    });
    const limitations = [
        ...bundle.limitations,
        ...comparison.limitations,
        ...bundle.baseline.diagnostics,
        ...(safetyGates.some((row) => row.status === "not-observed" || row.status === "errored") ? ["hard-gates-unobserved"] : []),
        ...(outcome.mandatoryEvidenceComplete ? [] : ["mandatory-evidence-incomplete"]),
        ...(comparable ? [] : ["baseline-not-comparable"]),
    ].map(reasonCode);
    const body: ScorecardReportBody = {
        ...partial,
        limitations,
        evidence: { lanes, baseline: { status: bundle.baseline.status, reportFingerprint: bundle.baseline.reportFingerprint } },
        outcome,
    };
    return parseScorecardReport({ schema: SCORECARD_REPORT_SCHEMA, body, reportFingerprint: canonicalFingerprint(body) });
}

export function scorecardExitCode(report: ScorecardReport): ScorecardExitCode {
    if (report.body.outcome.hardGateFailures.length > 0) return 2;
    return report.body.outcome.promotionAllowed ? 0 : 1;
}

/** Refuses to write when the report fails the shared privacy scan; otherwise publishes canonical two-space JSON atomically. */
export function publishScorecardReport(report: ScorecardReport, path: string): void {
    if (scanForSensitiveContent(report).length > 0) throw new ScorecardContractError(["scorecard: privacy-rejected"]);
    writeJsonAtomically(path, report, "scorecard-report");
}

/**
 * Rejects a report whose fingerprint differs from the report recomputed from the supplied bundle, so
 * the attested outcome is always the one the bundle's own rows produce.
 */
export function createScorecardAdapter(input: { bundle: ScorecardEvidenceBundle; report: ScorecardReport }): ScorecardAdapter {
    const { bundle, report } = input;
    if (buildScorecardReport(bundle).reportFingerprint !== report.reportFingerprint) {
        throw new ScorecardContractError(["adapter: report-bundle-mismatch"]);
    }
    return {
        owner: SCORECARD_POLICY_OWNER,
        evaluate(holdout, policyFingerprint): ScorecardOutcome {
            if (policyFingerprint !== bundle.policyFingerprint) throw new ScorecardContractError(["adapter: policy-fingerprint-mismatch"]);
            const pairedDelta = laneEvidence(bundle, "paired-delta");
            const pairedFacts = pairedFactsFingerprint(holdout.pairs);
            if (pairedDelta.report === null || pairedDelta.report.body.analysis.pairedFactsFingerprint !== pairedFacts) {
                throw new ScorecardContractError(["adapter: evidence-pairs-mismatch"]);
            }
            const outcome = {
                policyFingerprint: bundle.policyFingerprint,
                freezeManifestFingerprint: bundle.freezeManifestFingerprint,
                pairedFactsFingerprint: pairedFacts,
                laneReports: bundle.lanes.map((lane) => ({ lane: lane.lane, reportFingerprint: lane.reportFingerprint })),
                baselineScorecardReportFingerprint: bundle.baseline.reportFingerprint,
                scorecardReportFingerprint: report.reportFingerprint,
                hardGateFailures: report.body.outcome.hardGateFailures,
                mandatoryEvidenceComplete: report.body.outcome.mandatoryEvidenceComplete,
                promotionAllowed: report.body.outcome.promotionAllowed,
            };
            return {
                hardGateFailures: [...outcome.hardGateFailures],
                mandatoryEvidenceComplete: outcome.mandatoryEvidenceComplete,
                promotionAllowed: outcome.promotionAllowed,
                resultFingerprint: canonicalFingerprint(outcome),
            };
        },
    };
}
