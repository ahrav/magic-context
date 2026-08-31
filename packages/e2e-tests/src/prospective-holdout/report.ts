import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { HoldoutContractError, array, enumeration, exact, fail, hex64, integer, record, staticId } from "./contract";
import type { PairedCaseFact } from "./comparison";
import type { LifecycleState } from "./lifecycle";

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

export function completeFamilyCount(pairs: readonly PairedCaseFact[]): number {
    const families = [...new Set(pairs.map((pair) => pair.familyId))];
    return families.filter((familyId) =>
        pairs.filter((pair) => pair.familyId === familyId)
            .every((pair) => pair.status === "complete")
    ).length;
}

/**
 * Canonical ordering for paired-case facts: caseId, model, seed, platform.
 * All fingerprints over a pair set hash this one ordering, so the estimator
 * adapter's expected fingerprint and the report body bind to the same bytes.
 */
export function sortPairedFacts(pairs: readonly PairedCaseFact[]): PairedCaseFact[] {
    return [...pairs].sort((left, right) =>
        `${left.caseId}:${left.model}:${left.seed}:${left.platform}`.localeCompare(
            `${right.caseId}:${right.model}:${right.seed}:${right.platform}`,
        )
    );
}

export function pairedFactsFingerprint(pairs: readonly PairedCaseFact[]): string {
    return canonicalFingerprint(sortPairedFacts(pairs));
}

function summarizePairs(pairs: readonly PairedCaseFact[]): {
    pairedFactsFingerprint: string;
    completeFamilyCount: number;
    incompleteCaseIds: string[];
    familyMisses: string[];
    pairCount: number;
    completePairCount: number;
} {
    const sortedPairs = sortPairedFacts(pairs);
    // A pair is per execution coordinate, so one case contributes several. Case ids are
    // deduplicated because the report parser rejects a repeated id, while the pair counts
    // stay per coordinate.
    const incompletePairs = sortedPairs.filter((pair) => pair.status === "incomplete");
    const incompleteCaseIds = [...new Set(incompletePairs.map((pair) => pair.caseId))];
    return {
        pairedFactsFingerprint: canonicalFingerprint(sortedPairs),
        completeFamilyCount: completeFamilyCount(sortedPairs),
        incompleteCaseIds,
        familyMisses: [...new Set(sortedPairs
            .filter((pair) => pair.releaseN.productOutcome === "fail" || pair.releaseNMinus1.productOutcome === "fail")
            .map((pair) => pair.familyId))].sort(),
        pairCount: sortedPairs.length,
        completePairCount: sortedPairs.length - incompletePairs.length,
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
    // Case ids are deduplicated while the counts are per coordinate, so the two cannot be
    // related by subtraction. What must hold is that some case is named incomplete exactly
    // when some coordinate is incomplete.
    if ((body.incompleteCaseIds.length > 0) !== (body.prospective.completePairCount < body.prospective.pairCount)) {
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

// A report is a snapshot of the analysis at the instant it was written, and the lifecycle
// permits `reported -> invalidated` after that instant. An epoch invalidated later keeps the
// promoting report artifact verbatim and repository validation still reports it, so
// `decision` alone cannot witness that nothing has superseded it. Only these terminal states
// carry a promoting report: `reported` is the state the report itself records, and
// `graduated` is the one transition that follows it along the promoting path.
// `insufficient-evidence` names a report whose decision cannot be `promote`, and every other
// state either precedes the report or, like `invalidated`, supersedes it.
const PROMOTABLE_LIFECYCLE_STATES: ReadonlySet<string> = new Set<LifecycleState>([
    "reported",
    "graduated",
]);

export function releasePromotionAllowed(
    report: ProspectiveReport,
    trustVerified: boolean,
    terminalLifecycleState: string,
): boolean {
    // The state arrives as a plain string because repository validation surfaces it as
    // `Record<string, string>`. Membership is checked against a closed allowlist so an
    // unrecognized value - including a lifecycle state added later - refuses promotion
    // instead of widening the gate.
    return trustVerified
        && report.body.decision === "promote"
        && PROMOTABLE_LIFECYCLE_STATES.has(terminalLifecycleState);
}
