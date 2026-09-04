import { aggregateReportQuality, type BenchmarkReport } from "../../../plugin/scripts/retrieval-benchmark/report";
import { gateAggregates, type MacroAggregate } from "../../../plugin/scripts/retrieval-benchmark/metrics";
import { compareCodeUnits } from "../code-unit-order";
import type { DreamerEvalRunReport } from "../dreamer-eval/contract";
import type { LaneReport as HistorianReport } from "../historian-eval/scorer";
import type { IncidentPoolReport } from "../incident-pool/report";
import type { PairedDeltaReport } from "../paired-delta/report";
import { laneEvidence, type LaneReports, type ScorecardEvidenceBundle } from "./evidence";
import {
    PRIMARY_ENDPOINT_SLOTS,
    SECONDARY_SLOT_SOURCES,
    SLOT_IDS_BY_FAMILY,
    reasonCode,
    type LaneId,
    type MetricSlotId,
    type ScoreFamilyId,
    type SecondaryMetricKey,
} from "./policy";
import { estimateId, type FamilyEstimateRow, type MetricSlot, type MetricUnit, type ScoreFamilySection, type UtilitySection } from "./report-contract";

/** The incident-pool family whose cases compare the same scenario across harnesses. */
export const PARITY_FAMILY_ID = "fam-parity-harness-gaps";

const SECONDARY_UNITS: Readonly<Record<SecondaryMetricKey, MetricUnit>> = {
    invalidSuccessRateByArm: "ratio",
    finalAttemptTokensByArm: "tokens",
    finalAttemptWallClockMsByArm: "milliseconds",
    finalAttemptTurnsByArm: "count",
};

type Reading = { value: number; unit: MetricUnit } | { reason: string };

const PENDING: Reading = { reason: "producer-pending" };

function ratio(value: number | null, absent: string): Reading {
    return value === null ? { reason: absent } : { value, unit: "ratio" };
}

function count(value: number): Reading {
    return { value, unit: "count" };
}

function mean(values: readonly number[]): number | null {
    return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

type Reader<L extends LaneId> = (report: LaneReports[L], id: MetricSlotId) => Reading;

/** A lane that did not finish contributes only to reliability, so `allowIncomplete` is set by that family alone. */
function laneSlot<L extends LaneId>(bundle: ScorecardEvidenceBundle, lane: L, allowIncomplete: boolean, read: Reader<L>, id: MetricSlotId): MetricSlot {
    const evidence = laneEvidence(bundle, lane);
    const usable = evidence.status === "present" || (allowIncomplete && evidence.status === "incomplete");
    if (!usable || evidence.report === null || evidence.reportFingerprint === null) {
        return { id, status: "not-measured", reason: evidence.status === "incomplete" ? "lane-incomplete" : "lane-missing" };
    }
    const reading = read(evidence.report as LaneReports[L], id);
    if ("reason" in reading) return { id, status: "not-measured", reason: reasonCode(reading.reason) };
    return { id, status: "measured", value: reading.value, unit: reading.unit, sourceLane: lane, sourceFingerprint: evidence.reportFingerprint };
}

function section(family: ScoreFamilyId, resolve: (id: MetricSlotId) => MetricSlot): ScoreFamilySection {
    return { family, slots: SLOT_IDS_BY_FAMILY[family].map((id) => resolve(id)) };
}

function utilityReading(report: PairedDeltaReport, id: MetricSlotId): Reading {
    const endpoint = Object.entries(PRIMARY_ENDPOINT_SLOTS).find(([, slot]) => slot === id)?.[0];
    if (endpoint !== undefined) {
        const estimate = report.body.analysis.endpoints.find((entry) => entry.endpoint === endpoint);
        return estimate === undefined ? { reason: "endpoint-not-estimated" } : { value: estimate.pointEstimate, unit: "delta" };
    }
    const source = SECONDARY_SLOT_SOURCES[id as keyof typeof SECONDARY_SLOT_SOURCES];
    if (source === undefined) return PENDING;
    const value = report.body.secondaryMetrics[source.metric][source.arm];
    return value === undefined ? { reason: "arm-not-measured" } : { value, unit: SECONDARY_UNITS[source.metric] };
}

export function familyEstimateRows(report: PairedDeltaReport): FamilyEstimateRow[] {
    return report.body.analysis.endpoints
        .flatMap((estimate) => estimate.families.map((family): FamilyEstimateRow => ({
            endpoint: estimate.endpoint as FamilyEstimateRow["endpoint"],
            familyId: estimateId(family.familyId, "paired-delta.familyId"),
            pointEstimate: family.pointEstimate,
            interval: family.interval,
            noiseLabel: family.noise.label,
        })))
        .sort((left, right) => compareCodeUnits(left.endpoint, right.endpoint) || compareCodeUnits(left.familyId, right.familyId));
}

function formationReading(report: HistorianReport, id: MetricSlotId): Reading {
    switch (id) {
        case "active-claim-precision":
            return ratio(report.aggregate.precision, "no-visible-claims");
        case "active-claim-recall":
            return ratio(report.aggregate.recall, "no-expected-claims");
        case "false-authoritative-scenario-rate":
            return ratio(report.aggregate.falseAuthoritativeRate, "no-scored-scenarios");
        case "false-authoritative-memory-rate": {
            const scored = report.scenarios.filter((scenario) => scenario.verdict !== "ERROR");
            const visible = scored.reduce((sum, scenario) => sum + scenario.visibleClaimsTotal, 0);
            const matches = scored.reduce((sum, scenario) => sum + scenario.falseAuthoritativeMatches.length, 0);
            return visible === 0 ? { reason: "no-visible-claims" } : { value: matches / visible, unit: "ratio" };
        }
        default:
            return PENDING;
    }
}

const RETRIEVAL_SLOT_RE = /^(recall-at-10|recall-at-50|reciprocal-rank|ndcg-at-10|duplicate-rate-at-50)-(explicit|automatic)$/;

const RETRIEVAL_AGGREGATE_FIELDS: Readonly<Record<string, keyof Pick<MacroAggregate, "recallAt10" | "recallAt50" | "mrr" | "ndcgAt10" | "duplicateRateAt50">>> = {
    "recall-at-10": "recallAt10",
    "recall-at-50": "recallAt50",
    "reciprocal-rank": "mrr",
    "ndcg-at-10": "ndcgAt10",
    "duplicate-rate-at-50": "duplicateRateAt50",
};

/** Every retrieval slot reads the lane's gate aggregate, so lane-restricted diagnostic cases and paraphrase weighting apply uniformly. */
function retrievalReading(report: BenchmarkReport, id: MetricSlotId): Reading {
    const match = RETRIEVAL_SLOT_RE.exec(id);
    if (match === null) return PENDING;
    const field = RETRIEVAL_AGGREGATE_FIELDS[match[1]!]!;
    const mode = match[2]! as "explicit" | "automatic";
    const aggregate = gateAggregates(aggregateReportQuality(report)).find((entry) => entry.mode === mode);
    if (aggregate === undefined) return { reason: "no-holdout-queries" };
    return ratio(aggregate[field], "no-holdout-queries");
}

function pairedDeltaReliability(report: PairedDeltaReport, id: MetricSlotId): Reading {
    switch (id) {
        case "paired-delta-planned-coordinates":
            return count(report.body.runSummary.plannedCoordinates);
        case "paired-delta-healthy-coordinates":
            return count(report.body.runSummary.healthyCoordinates);
        default:
            return count(report.body.exclusions.reduce((sum, exclusion) => sum + exclusion.count, 0));
    }
}

function incidentReliability(report: IncidentPoolReport, id: MetricSlotId): Reading {
    switch (id) {
        case "incident-results-total":
            return count(report.results.length);
        case "incident-results-unhealthy":
            return count(report.results.filter((result) => result.run_health !== "completed").length);
        case "incident-baseline-mismatches":
            return count(report.results.filter((result) =>
                result.baseline_comparison === "regression" || result.baseline_comparison === "unexpected_failure").length);
        default: {
            const parity = report.results.filter((result) => result.family_id === PARITY_FAMILY_ID);
            return ratio(mean(parity.map((result) => (result.behavioral_verdict === "pass" ? 1 : 0))), "no-parity-cases");
        }
    }
}

function dreamerReliability(runs: DreamerEvalRunReport[], id: MetricSlotId): Reading {
    return id === "dreamer-runs-total"
        ? count(runs.length)
        : count(runs.filter((run) => run.status !== "PASS").length);
}

function reliabilitySlot(bundle: ScorecardEvidenceBundle, id: MetricSlotId): MetricSlot {
    switch (id) {
        case "paired-delta-planned-coordinates":
        case "paired-delta-healthy-coordinates":
        case "paired-delta-excluded-cells":
            return laneSlot(bundle, "paired-delta", true, pairedDeltaReliability, id);
        case "incident-results-total":
        case "incident-results-unhealthy":
        case "incident-baseline-mismatches":
        case "cross-harness-parity-pass-rate":
            return laneSlot(bundle, "incident", true, incidentReliability, id);
        case "dreamer-runs-total":
        case "dreamer-runs-not-passed":
            return laneSlot(bundle, "dreamer", true, dreamerReliability, id);
        default:
            return { id, status: "not-measured", reason: "producer-pending" };
    }
}

export interface ScoreFamilies {
    utility: Omit<UtilitySection, "deltas">;
    formation: ScoreFamilySection;
    retrieval: ScoreFamilySection;
    context: ScoreFamilySection;
    reliability: ScoreFamilySection;
}

export function buildScoreFamilies(bundle: ScorecardEvidenceBundle): ScoreFamilies {
    const pairedDelta = laneEvidence(bundle, "paired-delta");
    return {
        utility: {
            ...section("utility", (id) => laneSlot(bundle, "paired-delta", false, utilityReading, id)),
            family: "utility",
            familyEstimates: pairedDelta.status === "present" && pairedDelta.report !== null ? familyEstimateRows(pairedDelta.report) : [],
        },
        formation: section("formation", (id) => laneSlot(bundle, "historian", false, formationReading, id)),
        retrieval: section("retrieval", (id) => laneSlot(bundle, "retrieval", false, retrievalReading, id)),
        context: section("context", (id) => ({ id, status: "not-measured", reason: "producer-pending" })),
        reliability: section("reliability", (id) => reliabilitySlot(bundle, id)),
    };
}
