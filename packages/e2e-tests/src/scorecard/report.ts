import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { scanForSensitiveContent } from "../../../plugin/scripts/retrieval-benchmark/privacy";
import { writeJsonAtomically } from "../../scripts/atomic-json-write";
import { createFamilyEstimatorAdapter } from "../paired-delta/estimator";
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
    // The contract rejects duplicate reason codes, and the comparison and the baseline diagnostics can name the same one.
    const limitations = [...new Set([
        ...bundle.limitations,
        ...comparison.limitations,
        ...bundle.baseline.diagnostics,
        ...(safetyGates.some((row) => row.status === "not-observed" || row.status === "errored") ? ["hard-gates-unobserved"] : []),
        ...(outcome.mandatoryEvidenceComplete ? [] : ["mandatory-evidence-incomplete"]),
        ...(comparable ? [] : ["baseline-not-comparable"]),
    ].map(reasonCode))];
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

export function publishScorecardReport(report: ScorecardReport, path: string): void {
    if (scanForSensitiveContent(report).length > 0) throw new ScorecardContractError(["scorecard: privacy-rejected"]);
    parseScorecardReport(report);
    writeJsonAtomically(path, report, "scorecard-report");
}

/** Attests values recomputed from the bundle at construction, not the caller's report, which is admitted by fingerprint only. commentlint: allow(JUDGE) */
export function createScorecardAdapter(input: { bundle: ScorecardEvidenceBundle; report: ScorecardReport }): ScorecardAdapter {
    const derived = buildScorecardReport(input.bundle);
    if (derived.reportFingerprint !== input.report.reportFingerprint) {
        throw new ScorecardContractError(["adapter: report-bundle-mismatch"]);
    }
    const pairedDelta = laneEvidence(input.bundle, "paired-delta").report;
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
                const expected = archivedEstimator.adapter.analyze(holdout.pairs, archivedEstimator.policyFingerprint);
                if (expected.resultFingerprint !== holdout.estimator.resultFingerprint) {
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
