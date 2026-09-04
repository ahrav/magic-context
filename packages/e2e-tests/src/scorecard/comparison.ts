import { compareCodeUnits } from "../code-unit-order";
import type { RawRegretLadder } from "../paired-delta/report";
import { laneEvidence, type BaselineEvidence, type ScorecardEvidenceBundle } from "./evidence";
import { estimateId, estimateKey, type AdverseRow, type BaselineStatus, type DeltaRow, type FamilyEstimateRow, type LaneStatus } from "./report-contract";

export interface BaselineEstimates {
    status: BaselineStatus;
    /**
     * The baseline scorecard's own paired-delta lane status, `null` when no baseline loaded. A loaded
     * baseline whose lane did not finish holds an empty `familyEstimates` that is absence of evidence,
     * not a release that estimated nothing.
     */
    estimatesStatus: LaneStatus | null;
    familyEstimates: readonly FamilyEstimateRow[];
}

export function baselineEstimates(baseline: BaselineEvidence): BaselineEstimates {
    const body = baseline.report?.body;
    return {
        status: baseline.status,
        estimatesStatus: body?.evidence.lanes.find((row) => row.lane === "paired-delta")?.status ?? null,
        familyEstimates: body?.utility.familyEstimates ?? [],
    };
}

/**
 * An empty `familyEstimates` under a paired-delta lane that is not `present` is absence of evidence,
 * not a release that estimated nothing, so the comparison must not read it as every family vanishing.
 */
export interface CurrentEstimates {
    status: LaneStatus;
    familyEstimates: readonly FamilyEstimateRow[];
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
 * Pairs current and baseline estimates by `(endpoint, familyId)`. Only a `present` current lane can
 * drop a key the baseline estimated; a lane that did not finish yields a limitation instead of
 * `family-missing` rows, because those rows would count an evidence gap as regressions.
 */
export function compareWithBaseline(current: CurrentEstimates, baseline: BaselineEstimates): Comparison {
    const limitations: string[] = [];
    if (current.status !== "present") limitations.push("current-estimates-unavailable");
    if (baseline.status !== "present") {
        limitations.push(baseline.status === "absent" ? "no-baseline" : "baseline-not-comparable");
        return {
            deltas: current.familyEstimates.map((row) => ({ endpoint: row.endpoint, familyId: row.familyId, status: "no-baseline", value: row.pointEstimate })),
            adverseDeltas: [],
            limitations,
        };
    }
    if (baseline.estimatesStatus !== "present") limitations.push("baseline-estimates-unavailable");
    const baselineRows = new Map(baseline.familyEstimates.map((row) => [estimateKey(row), row]));
    const deltas = current.familyEstimates.map((row): DeltaRow => {
        const matched = baselineRows.get(estimateKey(row));
        return matched === undefined
            ? { endpoint: row.endpoint, familyId: row.familyId, status: "no-baseline", value: row.pointEstimate }
            : compareRow(row, matched);
    });
    const currentKeys = new Set(current.familyEstimates.map(estimateKey));
    const missing = current.status === "present"
        ? baseline.familyEstimates.filter((row) => !currentKeys.has(estimateKey(row)))
        : [];
    const adverseDeltas = [
        ...deltas.filter((row): row is Extract<DeltaRow, { status: "compared" }> => row.status === "compared" && row.interval.upper < 0).map(adverseRow),
        ...missing.map(familyMissingRow),
    ].sort(compareAdverseRows);
    if (baseline.estimatesStatus === "present" && deltas.some((row) => row.status === "no-baseline")) limitations.push("no-baseline-families");
    return { deltas, adverseDeltas, limitations };
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
