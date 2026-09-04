import { compareCodeUnits } from "../code-unit-order";
import type { RawRegretLadder } from "../paired-delta/report";
import { laneEvidence, type BaselineEvidence, type ScorecardEvidenceBundle } from "./evidence";
import { estimateId, estimateKey, type AdverseRow, type BaselineStatus, type DeltaRow, type FamilyEstimateRow } from "./report-contract";

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

function compareRow(current: FamilyEstimateRow, baseline: FamilyEstimateRow): DeltaRow {
    return {
        endpoint: current.endpoint,
        familyId: current.familyId,
        status: "compared",
        baselinePointEstimate: baseline.pointEstimate,
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

function familyMissingRow(baseline: FamilyEstimateRow): AdverseRow {
    return { familyId: baseline.familyId, endpoint: baseline.endpoint, kind: "family-missing", noiseLabel: null, delta: null, interval: null, blocking: true };
}

/** The report contract requires adverse rows ordered by `(familyId, endpoint, kind)`. */
function compareAdverseRows(left: AdverseRow, right: AdverseRow): number {
    return compareCodeUnits(left.familyId, right.familyId)
        || compareCodeUnits(left.endpoint, right.endpoint)
        || compareCodeUnits(left.kind, right.kind);
}

/**
 * Pairs every current `(endpoint, estimate family)` estimate with the baseline scorecard's row for
 * the same key. A pair whose shifted interval lies wholly below zero is adverse; a key the baseline
 * carried but the current release does not is a blocking `family-missing` row.
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
    const currentKeys = new Set(current.map(estimateKey));
    const missing = baseline.familyEstimates.filter((row) => !currentKeys.has(estimateKey(row)));
    const adverseDeltas = [
        ...deltas.filter((row): row is Extract<DeltaRow, { status: "compared" }> => row.status === "compared" && row.interval.upper < 0).map(adverseRow),
        ...missing.map(familyMissingRow),
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
    if (pairedDelta.status !== "present" || pairedDelta.report === null) return [];
    return pairedDelta.report.body.regret.raw.map((row) => ({
        ...row,
        coordinateId: estimateId(row.coordinateId, "paired-delta.regret.coordinateId"),
        familyId: estimateId(row.familyId, "paired-delta.regret.familyId"),
    }));
}
