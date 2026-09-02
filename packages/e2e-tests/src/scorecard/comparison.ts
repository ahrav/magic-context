import { compareCodeUnits } from "../code-unit-order";
import type { RawRegretLadder } from "../paired-delta/report";
import { laneEvidence, type BaselineEvidence, type ScorecardEvidenceBundle } from "./evidence";
import type { AdverseRow, BaselineStatus, DeltaRow, FamilyEstimateRow } from "./report-contract";

export interface BaselineEstimates {
    status: BaselineStatus;
    familyEstimates: readonly FamilyEstimateRow[];
}

export function baselineEstimates(baseline: BaselineEvidence): BaselineEstimates {
    return { status: baseline.status, familyEstimates: baseline.report?.body.utility.familyEstimates ?? [] };
}

export interface Comparison {
    deltas: DeltaRow[];
    adverseDeltas: AdverseRow[];
    limitations: string[];
}

function estimateKey(row: Pick<FamilyEstimateRow, "endpoint" | "familyId">): string {
    return JSON.stringify([row.endpoint, row.familyId]);
}

function compareRow(current: FamilyEstimateRow, baseline: FamilyEstimateRow): DeltaRow {
    return {
        endpoint: current.endpoint,
        familyId: current.familyId,
        status: "compared",
        delta: current.pointEstimate - baseline.pointEstimate,
        interval: {
            lower: current.interval.lower - baseline.pointEstimate,
            upper: current.interval.upper - baseline.pointEstimate,
        },
        noiseLabel: current.noiseLabel,
    };
}

function adverseRow(row: Extract<DeltaRow, { status: "compared" }>): AdverseRow {
    return {
        familyId: row.familyId,
        endpoint: row.endpoint,
        kind: "adverse-interval",
        noiseLabel: row.noiseLabel,
        delta: row.delta,
        interval: row.interval,
        blocking: row.noiseLabel === "outside-floor",
    };
}

function familyMissingRow(familyId: string): AdverseRow {
    return { familyId, endpoint: null, kind: "family-missing", noiseLabel: null, delta: null, interval: null, blocking: true };
}

function compareAdverseRows(left: AdverseRow, right: AdverseRow): number {
    return compareCodeUnits(left.familyId, right.familyId) || compareCodeUnits(left.endpoint ?? "", right.endpoint ?? "");
}

/**
 * Pairs every current `(endpoint, estimate family)` estimate with the baseline scorecard's row for
 * the same key. A pair whose shifted interval lies wholly below zero is adverse; an estimate family
 * the baseline carried but the current release does not is a blocking `family-missing` row.
 */
export function compareWithBaseline(current: readonly FamilyEstimateRow[], baseline: BaselineEstimates): Comparison {
    if (baseline.status !== "present") {
        return {
            deltas: current.map((row) => ({ endpoint: row.endpoint, familyId: row.familyId, status: "no-baseline", value: row.pointEstimate })),
            adverseDeltas: [],
            limitations: [baseline.status === "absent" ? "no-baseline" : "baseline-not-comparable"],
        };
    }
    const baselineRows = new Map(baseline.familyEstimates.map((row) => [estimateKey(row), row]));
    const deltas = current.map((row): DeltaRow => {
        const matched = baselineRows.get(estimateKey(row));
        return matched === undefined
            ? { endpoint: row.endpoint, familyId: row.familyId, status: "no-baseline", value: row.pointEstimate }
            : compareRow(row, matched);
    });
    const currentFamilies = new Set(current.map((row) => row.familyId));
    const missingFamilies = [...new Set(baseline.familyEstimates.map((row) => row.familyId))]
        .filter((familyId) => !currentFamilies.has(familyId));
    const adverseDeltas = [
        ...deltas.filter((row): row is Extract<DeltaRow, { status: "compared" }> => row.status === "compared" && row.interval.upper < 0).map(adverseRow),
        ...missingFamilies.map(familyMissingRow),
    ].sort(compareAdverseRows);
    return {
        deltas,
        adverseDeltas,
        limitations: deltas.some((row) => row.status === "no-baseline") ? ["no-baseline-families"] : [],
    };
}

/** The paired-delta ladder runs only for coordinates the treatment arm failed, so its raw rows are already the failures-only decomposition. */
export function regretRows(bundle: ScorecardEvidenceBundle): RawRegretLadder[] {
    const pairedDelta = laneEvidence(bundle, "paired-delta");
    return pairedDelta.status === "present" && pairedDelta.report !== null ? pairedDelta.report.body.regret.raw : [];
}
