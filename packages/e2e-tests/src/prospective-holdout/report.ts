import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { HoldoutContractError, array, enumeration, exact, fail, hex64, integer, record, staticId } from "./contract";
import type { PairedCaseFact } from "./comparison";

export const PROSPECTIVE_REPORT_SCHEMA = "prospective-release-report/v1";
export type Direction = "improvement" | "no-change" | "regression";
export type ReleaseDecision = "invalidated" | "hard-gate-failed" | "insufficient-evidence" | "promote" | "hold";

export interface EstimatorOutcome {
    direction: Direction;
    evidenceSufficient: boolean;
    completeFamilyCount: number;
    resultFingerprint: string;
}
export interface ScorecardOutcome {
    hardGateFailures: string[];
    mandatoryEvidenceComplete: boolean;
    promotionAllowed: boolean;
    resultFingerprint: string;
}
export interface FamilyEstimatorAdapter {
    owner: "magic-context-x4l.14";
    analyze(pairs: readonly PairedCaseFact[], policyFingerprint: string): EstimatorOutcome;
}
export interface ScorecardAdapter {
    owner: "magic-context-x4l.15";
    evaluate(input: { pairs: readonly PairedCaseFact[]; estimator: EstimatorOutcome }, policyFingerprint: string): ScorecardOutcome;
}
export interface ReportRecomputers {
    estimator: FamilyEstimatorAdapter;
    scorecard: ScorecardAdapter;
}

export interface ProspectiveReportBody {
    epochId: string;
    freezeManifestFingerprint: string;
    closeManifestFingerprint: string;
    analysisPolicyFingerprint: string;
    scorecardPolicyFingerprint: string;
    pairedFactsFingerprint: string;
    estimatorOwner: "magic-context-x4l.14";
    estimatorResultFingerprint: string;
    estimatorEvidenceSufficient: boolean;
    scorecardOwner: "magic-context-x4l.15";
    scorecardResultFingerprint: string;
    mandatoryEvidenceComplete: boolean;
    scorecardPromotionAllowed: boolean;
    invalidated: boolean;
    decision: ReleaseDecision;
    direction: Direction | null;
    completeFamilyCount: number;
    incompleteCaseIds: string[];
    familyMisses: string[];
    hardGateFailures: string[];
    prospective: { pairCount: number; completePairCount: number };
    incidentPool: { reportFingerprint: string | null };
    limitations: string[];
}
export interface ProspectiveReport {
    schema: typeof PROSPECTIVE_REPORT_SCHEMA;
    body: ProspectiveReportBody;
    reportFingerprint: string;
}

function summarizePairs(pairs: readonly PairedCaseFact[]): {
    pairedFactsFingerprint: string;
    completeFamilyCount: number;
    incompleteCaseIds: string[];
    familyMisses: string[];
    pairCount: number;
    completePairCount: number;
} {
    const sortedPairs = [...pairs].sort((left, right) => left.caseId.localeCompare(right.caseId));
    const incompleteCaseIds = sortedPairs.filter((pair) => pair.status === "incomplete").map((pair) => pair.caseId);
    const families = [...new Set(sortedPairs.map((pair) => pair.familyId))];
    return {
        pairedFactsFingerprint: canonicalFingerprint(sortedPairs),
        completeFamilyCount: families.filter((familyId) =>
            sortedPairs.filter((pair) => pair.familyId === familyId).every((pair) => pair.status === "complete")
        ).length,
        incompleteCaseIds,
        familyMisses: [...new Set(sortedPairs
            .filter((pair) => pair.releaseN.productOutcome === "fail" || pair.releaseNMinus1.productOutcome === "fail")
            .map((pair) => pair.familyId))].sort(),
        pairCount: sortedPairs.length,
        completePairCount: sortedPairs.length - incompleteCaseIds.length,
    };
}

export function buildProspectiveReport(input: {
    epochId: string;
    freezeManifestFingerprint: string;
    closeManifestFingerprint: string;
    analysisPolicyFingerprint: string;
    scorecardPolicyFingerprint: string;
    pairs: readonly PairedCaseFact[];
    estimator: FamilyEstimatorAdapter;
    scorecard: ScorecardAdapter;
    invalidated: boolean;
    incidentPoolReportFingerprint?: string;
}): ProspectiveReport {
    if (input.estimator.owner !== "magic-context-x4l.14") fail("report.estimator: wrong-owner");
    if (input.scorecard.owner !== "magic-context-x4l.15") fail("report.scorecard: wrong-owner");
    const estimator = input.estimator.analyze(input.pairs, input.analysisPolicyFingerprint);
    const scorecard = input.scorecard.evaluate({ pairs: input.pairs, estimator }, input.scorecardPolicyFingerprint);
    const summary = summarizePairs(input.pairs);
    if (estimator.completeFamilyCount !== summary.completeFamilyCount) fail("report.estimator: complete-family-count-mismatch");
    if (scorecard.promotionAllowed && (!scorecard.mandatoryEvidenceComplete || scorecard.hardGateFailures.length > 0)) {
        fail("report.scorecard: promotion-invariants-invalid");
    }
    const { incompleteCaseIds, familyMisses } = summary;
    const hardGateFailures = [...scorecard.hardGateFailures].sort();
    let decision: ReleaseDecision;
    let direction: Direction | null = null;
    if (input.invalidated) decision = "invalidated";
    else if (hardGateFailures.length > 0) decision = "hard-gate-failed";
    else if (!scorecard.mandatoryEvidenceComplete || !estimator.evidenceSufficient) decision = "insufficient-evidence";
    else {
        direction = estimator.direction;
        decision = scorecard.promotionAllowed ? "promote" : "hold";
    }
    const limitations = [
        ...(incompleteCaseIds.length > 0 ? ["incomplete-pairs"] : []),
        ...(estimator.evidenceSufficient ? [] : ["minimum-evidence-not-met"]),
        ...(scorecard.mandatoryEvidenceComplete ? [] : ["mandatory-gate-evidence-missing"]),
    ];
    const body: ProspectiveReportBody = {
        epochId: input.epochId,
        freezeManifestFingerprint: input.freezeManifestFingerprint,
        closeManifestFingerprint: input.closeManifestFingerprint,
        analysisPolicyFingerprint: input.analysisPolicyFingerprint,
        scorecardPolicyFingerprint: input.scorecardPolicyFingerprint,
        pairedFactsFingerprint: summary.pairedFactsFingerprint,
        estimatorOwner: input.estimator.owner,
        estimatorResultFingerprint: estimator.resultFingerprint,
        estimatorEvidenceSufficient: estimator.evidenceSufficient,
        scorecardOwner: input.scorecard.owner,
        scorecardResultFingerprint: scorecard.resultFingerprint,
        mandatoryEvidenceComplete: scorecard.mandatoryEvidenceComplete,
        scorecardPromotionAllowed: scorecard.promotionAllowed,
        invalidated: input.invalidated,
        decision,
        direction,
        completeFamilyCount: summary.completeFamilyCount,
        incompleteCaseIds,
        familyMisses,
        hardGateFailures,
        prospective: {
            pairCount: summary.pairCount,
            completePairCount: summary.completePairCount,
        },
        incidentPool: { reportFingerprint: input.incidentPoolReportFingerprint ?? null },
        limitations,
    };
    return parseProspectiveReport({
        schema: PROSPECTIVE_REPORT_SCHEMA,
        body,
        reportFingerprint: canonicalFingerprint(body),
    });
}

function idArray(raw: unknown, label: string, pattern: RegExp): string[] {
    const values = array(raw, label).map((entry, index) => staticId(entry, `${label}[${index}]`, pattern));
    if (new Set(values).size !== values.length) fail(`${label}: duplicate`);
    return values;
}

export function parseProspectiveReport(raw: unknown): ProspectiveReport {
    const root = record(raw, "report");
    exact(root, ["schema", "body", "reportFingerprint"], "report");
    if (root.schema !== PROSPECTIVE_REPORT_SCHEMA) fail("report.schema: version-invalid");
    const value = record(root.body, "report.body");
    exact(value, [
        "epochId", "freezeManifestFingerprint", "closeManifestFingerprint",
        "analysisPolicyFingerprint", "scorecardPolicyFingerprint", "pairedFactsFingerprint",
        "estimatorOwner", "estimatorResultFingerprint", "estimatorEvidenceSufficient",
        "scorecardOwner", "scorecardResultFingerprint", "mandatoryEvidenceComplete", "scorecardPromotionAllowed",
        "invalidated", "decision", "direction", "completeFamilyCount", "incompleteCaseIds", "familyMisses",
        "hardGateFailures", "prospective", "incidentPool", "limitations",
    ], "report.body");
    if (value.estimatorOwner !== "magic-context-x4l.14" || value.scorecardOwner !== "magic-context-x4l.15") {
        fail("report.body: sibling-owner-invalid");
    }
    const prospective = record(value.prospective, "report.body.prospective");
    exact(prospective, ["pairCount", "completePairCount"], "report.body.prospective");
    const pairCount = integer(prospective.pairCount, "report.body.prospective.pairCount");
    const completePairCount = integer(prospective.completePairCount, "report.body.prospective.completePairCount");
    if (completePairCount > pairCount) fail("report.body.prospective: count-invalid");
    const incidentPool = record(value.incidentPool, "report.body.incidentPool");
    exact(incidentPool, ["reportFingerprint"], "report.body.incidentPool");
    if (
        typeof value.estimatorEvidenceSufficient !== "boolean" ||
        typeof value.mandatoryEvidenceComplete !== "boolean" ||
        typeof value.scorecardPromotionAllowed !== "boolean" ||
        typeof value.invalidated !== "boolean"
    ) {
        fail("report.body: boolean-invalid");
    }
    const body: ProspectiveReportBody = {
        epochId: staticId(value.epochId, "report.body.epochId", /^epoch-[a-z0-9]+(?:-[a-z0-9]+)*$/),
        freezeManifestFingerprint: hex64(value.freezeManifestFingerprint, "report.body.freezeManifestFingerprint"),
        closeManifestFingerprint: hex64(value.closeManifestFingerprint, "report.body.closeManifestFingerprint"),
        analysisPolicyFingerprint: hex64(value.analysisPolicyFingerprint, "report.body.analysisPolicyFingerprint"),
        scorecardPolicyFingerprint: hex64(value.scorecardPolicyFingerprint, "report.body.scorecardPolicyFingerprint"),
        pairedFactsFingerprint: hex64(value.pairedFactsFingerprint, "report.body.pairedFactsFingerprint"),
        estimatorOwner: "magic-context-x4l.14",
        estimatorResultFingerprint: hex64(value.estimatorResultFingerprint, "report.body.estimatorResultFingerprint"),
        estimatorEvidenceSufficient: value.estimatorEvidenceSufficient,
        scorecardOwner: "magic-context-x4l.15",
        scorecardResultFingerprint: hex64(value.scorecardResultFingerprint, "report.body.scorecardResultFingerprint"),
        mandatoryEvidenceComplete: value.mandatoryEvidenceComplete,
        scorecardPromotionAllowed: value.scorecardPromotionAllowed,
        invalidated: value.invalidated,
        decision: enumeration(value.decision, ["invalidated", "hard-gate-failed", "insufficient-evidence", "promote", "hold"] as const, "report.body.decision"),
        direction: value.direction === null ? null : enumeration(value.direction, ["improvement", "no-change", "regression"] as const, "report.body.direction"),
        completeFamilyCount: integer(value.completeFamilyCount, "report.body.completeFamilyCount"),
        incompleteCaseIds: idArray(value.incompleteCaseIds, "report.body.incompleteCaseIds", /^case-[0-9a-f]{32}$/),
        familyMisses: idArray(value.familyMisses, "report.body.familyMisses", /^fam-[a-z0-9]+(?:-[a-z0-9]+)*$/),
        hardGateFailures: idArray(value.hardGateFailures, "report.body.hardGateFailures", /^gate-[a-z0-9]+(?:-[a-z0-9]+)*$/),
        prospective: { pairCount, completePairCount },
        incidentPool: {
            reportFingerprint: incidentPool.reportFingerprint === null
                ? null
                : hex64(incidentPool.reportFingerprint, "report.body.incidentPool.reportFingerprint"),
        },
        limitations: idArray(value.limitations, "report.body.limitations", /^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    };
    const reportFingerprint = hex64(root.reportFingerprint, "report.reportFingerprint");
    if (canonicalFingerprint(body) !== reportFingerprint) fail("report.reportFingerprint: mismatch");
    const expectedDecision: ReleaseDecision = body.invalidated
        ? "invalidated"
        : body.hardGateFailures.length > 0
            ? "hard-gate-failed"
            : !body.mandatoryEvidenceComplete || !body.estimatorEvidenceSufficient
                ? "insufficient-evidence"
                : body.scorecardPromotionAllowed ? "promote" : "hold";
    if (body.decision !== expectedDecision) fail("report.body.decision: cross-field-invalid");
    const directional = body.decision === "promote" || body.decision === "hold";
    if (directional === (body.direction === null)) fail("report.body.direction: decision-mismatch");
    if (body.scorecardPromotionAllowed && (!body.mandatoryEvidenceComplete || body.hardGateFailures.length > 0)) {
        fail("report.body.scorecardPromotionAllowed: cross-field-invalid");
    }
    if (body.prospective.completePairCount !== body.prospective.pairCount - body.incompleteCaseIds.length) {
        fail("report.body.prospective: incomplete-count-mismatch");
    }
    const expectedLimitations = [
        ...(body.incompleteCaseIds.length > 0 ? ["incomplete-pairs"] : []),
        ...(body.estimatorEvidenceSufficient ? [] : ["minimum-evidence-not-met"]),
        ...(body.mandatoryEvidenceComplete ? [] : ["mandatory-gate-evidence-missing"]),
    ];
    if (JSON.stringify(body.limitations) !== JSON.stringify(expectedLimitations)) {
        fail("report.body.limitations: evidence-mismatch");
    }
    return { schema: PROSPECTIVE_REPORT_SCHEMA, body, reportFingerprint };
}

export function validateProspectiveReportEvidence(
    report: ProspectiveReport,
    pairs: readonly PairedCaseFact[],
    recomputers?: ReportRecomputers,
): void {
    const summary = summarizePairs(pairs);
    if (
        report.body.pairedFactsFingerprint !== summary.pairedFactsFingerprint ||
        report.body.completeFamilyCount !== summary.completeFamilyCount ||
        JSON.stringify(report.body.incompleteCaseIds) !== JSON.stringify(summary.incompleteCaseIds) ||
        JSON.stringify(report.body.familyMisses) !== JSON.stringify(summary.familyMisses) ||
        report.body.prospective.pairCount !== summary.pairCount ||
        report.body.prospective.completePairCount !== summary.completePairCount
    ) {
        throw new HoldoutContractError(["report: deterministic-recomputation-mismatch"]);
    }
    if (!recomputers) return;
    const recomputed = buildProspectiveReport({
        epochId: report.body.epochId,
        freezeManifestFingerprint: report.body.freezeManifestFingerprint,
        closeManifestFingerprint: report.body.closeManifestFingerprint,
        analysisPolicyFingerprint: report.body.analysisPolicyFingerprint,
        scorecardPolicyFingerprint: report.body.scorecardPolicyFingerprint,
        pairs,
        estimator: recomputers.estimator,
        scorecard: recomputers.scorecard,
        invalidated: report.body.invalidated,
        ...(report.body.incidentPool.reportFingerprint === null
            ? {}
            : { incidentPoolReportFingerprint: report.body.incidentPool.reportFingerprint }),
    });
    if (canonicalFingerprint(report.body) !== canonicalFingerprint(recomputed.body)) {
        throw new HoldoutContractError(["report: sibling-recomputation-mismatch"]);
    }
}

export function releasePromotionAllowed(report: ProspectiveReport, trustVerified: boolean): boolean {
    return trustVerified && report.body.decision === "promote";
}
