import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import type { Interval, NoiseComparison, PrimaryEndpoint } from "../paired-delta/estimator";
import { PRIMARY_ENDPOINTS } from "../paired-delta/estimator";
import type { RawRegretLadder } from "../paired-delta/report";
import { tupleKey } from "../paired-delta/tuple-key";
import {
    GATE_ID_RE,
    LANE_IDS,
    METRIC_SLOT_IDS,
    SLOT_CONTRACTS,
    REASON_CODE_RE,
    SCORECARD_GATE_IDS,
    SCORE_FAMILY_IDS,
    SLOT_IDS_BY_FAMILY,
    array,
    boolean,
    enumeration,
    exact,
    fail,
    hex64,
    idArray,
    integer,
    nullable,
    number,
    parseLaneIdentity,
    record,
    sorted,
    staticId,
    unique,
    type GateId,
    type LaneId,
    type LaneIdentity,
    type MetricSlotId,
    type MetricUnit,
    type ScoreFamilyId,
} from "./policy";

export const SCORECARD_REPORT_SCHEMA = "scorecard-report/v1";

export const GATE_STATUSES = ["passed", "failed", "not-observed", "errored"] as const;
export type GateStatus = (typeof GATE_STATUSES)[number];

/** The one lane whose report can observe each gate; `null` when no lane produces the gate's evidence, so it cannot be observed. */
export const GATE_SOURCE_LANES = {
    "gate-cross-project-leak": null,
    "gate-unrelated-scope-secret": null,
    "gate-injection-promoted": "metamorphic",
    "gate-false-enforced-policy": null,
    "gate-database-corruption": null,
} as const satisfies Readonly<Record<GateId, LaneId | null>>;

/** The gates some lane produces; the extractor table in `gates.ts` is keyed by this so it cannot name a gate this table leaves unproduced. */
export type ProducedGateId = { [G in GateId]: (typeof GATE_SOURCE_LANES)[G] extends LaneId ? G : never }[GateId];

export function isProducedGate(gateId: GateId): gateId is ProducedGateId {
    return GATE_SOURCE_LANES[gateId] !== null;
}

/** Flat on the wire: every key is present on every row, with `null` where the status carries no value. */
export interface GateRow {
    gateId: GateId;
    status: GateStatus;
    observedCount: number | null;
    evidenceFingerprint: string | null;
    sourceLane: LaneId | null;
    diagnostic: string | null;
}

export type MetricSlot =
    | { id: MetricSlotId; status: "measured"; value: number; unit: MetricUnit; sourceLane: LaneId; sourceFingerprint: string }
    | { id: MetricSlotId; status: "not-measured"; reason: string };

export interface ScoreFamilySection {
    family: ScoreFamilyId;
    slots: MetricSlot[];
}

export interface FamilyEstimateRow {
    endpoint: PrimaryEndpoint;
    familyId: string;
    pointEstimate: number;
    interval: Interval;
    noiseLabel: NoiseComparison;
}

/**
 * A release-over-release comparison of one estimate family at one endpoint.
 * `delta` is the current point estimate minus `baselinePointEstimate` and `interval` is the current
 * paired interval shifted by `baselinePointEstimate`; the two releases carry no joint distribution, so
 * no narrower interval is claimed.
 */
export type DeltaRow =
    | {
        endpoint: PrimaryEndpoint;
        familyId: string;
        status: "compared";
        baselinePointEstimate: number;
        delta: number;
        interval: Interval;
        noiseLabel: NoiseComparison;
    }
    | { endpoint: PrimaryEndpoint; familyId: string; status: "no-baseline"; value: number };

export const ADVERSE_KINDS = ["adverse-interval", "family-missing"] as const;
export type AdverseKind = (typeof ADVERSE_KINDS)[number];

/** Both kinds name an `(endpoint, familyId)` estimate key; only `adverse-interval` carries a measured comparison. */
export interface AdverseRow {
    familyId: string;
    endpoint: PrimaryEndpoint;
    kind: AdverseKind;
    noiseLabel: NoiseComparison | null;
    delta: number | null;
    interval: Interval | null;
    blocking: boolean;
}

export interface UtilitySection extends ScoreFamilySection {
    family: "utility";
    familyEstimates: FamilyEstimateRow[];
    deltas: DeltaRow[];
}

export const LANE_STATUSES = ["present", "missing", "incomplete", "schema-mismatch"] as const;
export type LaneStatus = (typeof LANE_STATUSES)[number];
export const BASELINE_STATUSES = ["present", "absent", "schema-mismatch"] as const;
export type BaselineStatus = (typeof BASELINE_STATUSES)[number];

export interface EvidenceRow {
    lane: LaneId;
    status: LaneStatus;
    reportFingerprint: string | null;
    identity: LaneIdentity | null;
    diagnostics: string[];
}

export const RUN_INCOMPLETE = "run-incomplete";

/**
 * A retained incomplete report is evidence for this scorecard only when it stopped early on this target.
 * A build-identity or conformance diagnostic means it may describe another target, so it is excluded.
 */
export function interruptedOnThisTarget(lane: Pick<EvidenceRow, "status" | "diagnostics">): boolean {
    return lane.status === "incomplete" && lane.diagnostics.every((code) => code === RUN_INCOMPLETE);
}

export interface ScorecardReportBody {
    /** The policy terms the outcome depends on are restated here so a reader can recompute it from the report alone. */
    target: {
        freezeManifestFingerprint: string;
        policyFingerprint: string;
        pairedDeltaPolicyFingerprint: string;
        baselineScorecardReportFingerprint: string | null;
        requiredMetricSlots: MetricSlotId[];
        maxToleratedRegressions: number;
    };
    utility: UtilitySection;
    formation: ScoreFamilySection;
    retrieval: ScoreFamilySection;
    context: ScoreFamilySection;
    reliability: ScoreFamilySection;
    safetyGates: GateRow[];
    regret: RawRegretLadder[];
    adverseDeltas: AdverseRow[];
    limitations: string[];
    evidence: {
        lanes: EvidenceRow[];
        /** `estimatesStatus` is the loaded baseline's own paired-delta lane status: a baseline that estimated nothing cannot be compared against. */
        baseline: { status: BaselineStatus; reportFingerprint: string | null; estimatesStatus: LaneStatus | null };
    };
    outcome: {
        promotionAllowed: boolean;
        mandatoryEvidenceComplete: boolean;
        hardGateFailures: GateId[];
        blockingRegressionCount: number;
    };
}

export interface ScorecardReport {
    schema: typeof SCORECARD_REPORT_SCHEMA;
    body: ScorecardReportBody;
    reportFingerprint: string;
}

export const REPORT_BODY_KEYS = [
    "target", "utility", "formation", "retrieval", "context", "reliability",
    "safetyGates", "regret", "adverseDeltas", "limitations", "evidence", "outcome",
] as const satisfies readonly (keyof ScorecardReportBody)[];

const NOISE_LABELS = ["no-noise-floor", "inside-floor", "outside-floor"] as const satisfies readonly NoiseComparison[];
const ESTIMATE_FAMILY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export function estimateId(value: unknown, label: string): string {
    return staticId(value, label, ESTIMATE_FAMILY_ID_RE);
}

/** Every paired-delta estimate is a difference of two binary outcomes or two fractions, so it lies in [-1, 1]. */
const deltaNumber = (value: unknown, label: string): number => number(value, label, { minimum: -1, maximum: 1 });

function parseInterval(raw: unknown, label: string, bound: (value: unknown, label: string) => number = number): Interval {
    const value = record(raw, label);
    exact(value, ["lower", "upper"], label);
    const interval = { lower: bound(value.lower, `${label}.lower`), upper: bound(value.upper, `${label}.upper`) };
    if (interval.lower > interval.upper) fail(`${label}: bounds-inverted`);
    return interval;
}

function parseGateRow(raw: unknown, index: number): GateRow {
    const label = `report.body.safetyGates[${index}]`;
    const value = record(raw, label);
    exact(value, ["gateId", "status", "observedCount", "evidenceFingerprint", "sourceLane", "diagnostic"], label);
    const row: GateRow = {
        gateId: staticId(value.gateId, `${label}.gateId`, GATE_ID_RE) as GateId,
        status: enumeration(value.status, GATE_STATUSES, `${label}.status`),
        observedCount: nullable(value.observedCount, (count) => integer(count, `${label}.observedCount`)),
        evidenceFingerprint: nullable(value.evidenceFingerprint, (fingerprint) => hex64(fingerprint, `${label}.evidenceFingerprint`)),
        sourceLane: nullable(value.sourceLane, (lane) => enumeration(lane, LANE_IDS, `${label}.sourceLane`)),
        diagnostic: nullable(value.diagnostic, (code) => staticId(code, `${label}.diagnostic`, REASON_CODE_RE)),
    };
    if (row.gateId !== SCORECARD_GATE_IDS[index]) fail(`${label}.gateId: order-invalid`);
    // An observed gate carries all three evidence fields and no diagnostic; an unobserved one carries none and a diagnostic.
    const observed = row.status === "passed" || row.status === "failed";
    const evidence = [row.observedCount, row.evidenceFingerprint, row.sourceLane];
    if (evidence.some((field) => (field !== null) !== observed) || (row.diagnostic !== null) === observed) {
        fail(`${label}: evidence-shape-invalid`);
    }
    if (observed && row.sourceLane !== GATE_SOURCE_LANES[row.gateId]) fail(`${label}.sourceLane: gate-producer-invalid`);
    if (row.status === "passed" && row.observedCount !== 0) fail(`${label}: passed-with-observations`);
    if (row.status === "failed" && row.observedCount === 0) fail(`${label}: failed-without-observations`);
    return row;
}

function measuredValue(raw: unknown, unit: MetricUnit, label: string): number {
    switch (unit) {
        case "ratio":
            return number(raw, label, { minimum: 0, maximum: 1 });
        case "delta":
            return number(raw, label, { minimum: -1, maximum: 1 });
        case "milliseconds":
            return number(raw, label, { minimum: 0 });
        case "count":
        case "tokens":
            return integer(raw, label, 0);
    }
}

function parseSlot(raw: unknown, family: ScoreFamilyId, index: number): MetricSlot {
    const label = `report.body.${family}.slots[${index}]`;
    const value = record(raw, label);
    const status = enumeration(value.status, ["measured", "not-measured"] as const, `${label}.status`);
    const expectedId = SLOT_IDS_BY_FAMILY[family][index];
    if (value.id !== expectedId) fail(`${label}.id: order-invalid`);
    const id = expectedId as MetricSlotId;
    if (status === "measured") {
        exact(value, ["id", "status", "value", "unit", "sourceLane", "sourceFingerprint"], label);
        const contract = SLOT_CONTRACTS[id];
        if (value.unit !== contract.unit) fail(`${label}.unit: slot-unit-invalid`);
        const sourceLane = enumeration(value.sourceLane, LANE_IDS, `${label}.sourceLane`);
        if (sourceLane !== contract.lane) fail(`${label}.sourceLane: slot-producer-invalid`);
        return {
            id,
            status,
            value: measuredValue(value.value, contract.unit, `${label}.value`),
            unit: contract.unit,
            sourceLane,
            sourceFingerprint: hex64(value.sourceFingerprint, `${label}.sourceFingerprint`),
        };
    }
    exact(value, ["id", "status", "reason"], label);
    return { id, status, reason: staticId(value.reason, `${label}.reason`, REASON_CODE_RE) };
}

function parseFamilySection(raw: unknown, family: ScoreFamilyId, extraKeys: readonly string[] = []): ScoreFamilySection {
    const label = `report.body.${family}`;
    const value = record(raw, label);
    exact(value, ["family", "slots", ...extraKeys], label);
    if (value.family !== family) fail(`${label}.family: identity-invalid`);
    const slots = array(value.slots, `${label}.slots`);
    if (slots.length !== SLOT_IDS_BY_FAMILY[family].length) fail(`${label}.slots: exact-slot-set-required`);
    return { family, slots: slots.map((slot, index) => parseSlot(slot, family, index)) };
}

function parseFamilyEstimateRow(raw: unknown, label: string): FamilyEstimateRow {
    const value = record(raw, label);
    exact(value, ["endpoint", "familyId", "pointEstimate", "interval", "noiseLabel"], label);
    return {
        endpoint: enumeration(value.endpoint, PRIMARY_ENDPOINTS, `${label}.endpoint`),
        familyId: estimateId(value.familyId, `${label}.familyId`),
        pointEstimate: deltaNumber(value.pointEstimate, `${label}.pointEstimate`),
        interval: parseInterval(value.interval, `${label}.interval`, deltaNumber),
        noiseLabel: enumeration(value.noiseLabel, NOISE_LABELS, `${label}.noiseLabel`),
    };
}

function parseDeltaRow(raw: unknown, label: string): DeltaRow {
    const value = record(raw, label);
    const status = enumeration(value.status, ["compared", "no-baseline"] as const, `${label}.status`);
    const endpoint = enumeration(value.endpoint, PRIMARY_ENDPOINTS, `${label}.endpoint`);
    const familyId = estimateId(value.familyId, `${label}.familyId`);
    if (status === "compared") {
        exact(value, ["endpoint", "familyId", "status", "baselinePointEstimate", "delta", "interval", "noiseLabel"], label);
        return {
            endpoint,
            familyId,
            status,
            baselinePointEstimate: deltaNumber(value.baselinePointEstimate, `${label}.baselinePointEstimate`),
            delta: number(value.delta, `${label}.delta`),
            interval: parseInterval(value.interval, `${label}.interval`),
            noiseLabel: enumeration(value.noiseLabel, NOISE_LABELS, `${label}.noiseLabel`),
        };
    }
    exact(value, ["endpoint", "familyId", "status", "value"], label);
    return { endpoint, familyId, status, value: deltaNumber(value.value, `${label}.value`) };
}

function parseUtilitySection(raw: unknown): UtilitySection {
    const section = parseFamilySection(raw, "utility", ["familyEstimates", "deltas"]);
    const value = record(raw, "report.body.utility");
    return {
        family: "utility",
        slots: section.slots,
        familyEstimates: array(value.familyEstimates, "report.body.utility.familyEstimates")
            .map((row, index) => parseFamilyEstimateRow(row, `report.body.utility.familyEstimates[${index}]`)),
        deltas: array(value.deltas, "report.body.utility.deltas")
            .map((row, index) => parseDeltaRow(row, `report.body.utility.deltas[${index}]`)),
    };
}

function parseAdverseRow(raw: unknown, index: number): AdverseRow {
    const label = `report.body.adverseDeltas[${index}]`;
    const value = record(raw, label);
    exact(value, ["familyId", "endpoint", "kind", "noiseLabel", "delta", "interval", "blocking"], label);
    const row: AdverseRow = {
        familyId: estimateId(value.familyId, `${label}.familyId`),
        endpoint: enumeration(value.endpoint, PRIMARY_ENDPOINTS, `${label}.endpoint`),
        kind: enumeration(value.kind, ADVERSE_KINDS, `${label}.kind`),
        noiseLabel: nullable(value.noiseLabel, (noise) => enumeration(noise, NOISE_LABELS, `${label}.noiseLabel`)),
        delta: nullable(value.delta, (delta) => number(delta, `${label}.delta`)),
        interval: nullable(value.interval, (interval) => parseInterval(interval, `${label}.interval`)),
        blocking: boolean(value.blocking, `${label}.blocking`),
    };
    const measured = row.kind === "adverse-interval";
    if ([row.noiseLabel, row.delta, row.interval].some((field) => (field !== null) !== measured)) fail(`${label}: shape-invalid`);
    if (row.blocking !== (row.kind === "family-missing" || row.noiseLabel === "outside-floor")) fail(`${label}.blocking: cross-field-invalid`);
    return row;
}

function parseRegretRow(raw: unknown, index: number): RawRegretLadder {
    const label = `report.body.regret[${index}]`;
    const value = record(raw, label);
    exact(value, ["coordinateId", "familyId", "retrieval", "formation", "representation", "label"], label);
    if (value.label !== "raw-non-inferential") fail(`${label}.label: literal-invalid`);
    const rung = (field: "retrieval" | "formation" | "representation"): number | null =>
        nullable(value[field], (delta) => deltaNumber(delta, `${label}.${field}`));
    return {
        coordinateId: estimateId(value.coordinateId, `${label}.coordinateId`),
        familyId: estimateId(value.familyId, `${label}.familyId`),
        retrieval: rung("retrieval"),
        formation: rung("formation"),
        representation: rung("representation"),
        label: "raw-non-inferential",
    };
}

function parseEvidenceRow(raw: unknown, index: number): EvidenceRow {
    const label = `report.body.evidence.lanes[${index}]`;
    const value = record(raw, label);
    exact(value, ["lane", "status", "reportFingerprint", "identity", "diagnostics"], label);
    const lane = enumeration(value.lane, LANE_IDS, `${label}.lane`);
    if (lane !== LANE_IDS[index]) fail(`${label}.lane: order-invalid`);
    const row: EvidenceRow = {
        lane,
        status: enumeration(value.status, LANE_STATUSES, `${label}.status`),
        reportFingerprint: nullable(value.reportFingerprint, (fingerprint) => hex64(fingerprint, `${label}.reportFingerprint`)),
        identity: nullable(value.identity, (identity) => parseLaneIdentity(identity, lane, `${label}.identity`)),
        diagnostics: idArray(value.diagnostics, `${label}.diagnostics`, REASON_CODE_RE),
    };
    if ((row.status === "present") !== (row.diagnostics.length === 0)) fail(`${label}.diagnostics: cross-field-invalid`);
    if ((row.status === "present" || row.status === "incomplete") && row.reportFingerprint === null) fail(`${label}.reportFingerprint: required`);
    if (row.status === "missing" && (row.reportFingerprint !== null || row.identity !== null)) fail(`${label}: shape-invalid`);
    return row;
}

export function estimateKey(row: { endpoint: PrimaryEndpoint; familyId: string }): string {
    return tupleKey(row.endpoint, row.familyId);
}

/** Every gate that is not `passed` blocks promotion: `not-observed` and `errored` count as failures, not as unknowns. */
export function hardGateFailures(rows: readonly GateRow[]): GateId[] {
    return rows.filter((row) => row.status !== "passed").map((row) => row.gateId).sort();
}

/** Whether every row and slot the policy requires supports promotion. Recomputed by the parser so a report cannot claim what its own rows deny. */
export function deriveOutcome(input: {
    gates: readonly GateRow[];
    lanes: readonly EvidenceRow[];
    baseline: Pick<ScorecardReportBody["evidence"]["baseline"], "status" | "estimatesStatus">;
    families: readonly ScoreFamilySection[];
    requiredMetricSlots: readonly MetricSlotId[];
    adverseDeltas: readonly AdverseRow[];
    maxToleratedRegressions: number;
}): ScorecardReportBody["outcome"] {
    const failures = hardGateFailures(input.gates);
    const measured = new Set(input.families.flatMap((family) => family.slots)
        .filter((slot) => slot.status === "measured").map((slot) => slot.id));
    // A pinned baseline that did not load, or loaded without its own estimates, leaves the release-over-release comparison unmade.
    const baselineComparable = input.baseline.status === "absent"
        || (input.baseline.status === "present" && input.baseline.estimatesStatus === "present");
    const mandatoryEvidenceComplete = input.lanes.every((row) => row.status === "present")
        && baselineComparable
        && input.requiredMetricSlots.every((slot) => measured.has(slot));
    const blockingRegressionCount = input.adverseDeltas.filter((row) => row.blocking).length;
    return {
        promotionAllowed: failures.length === 0
            && mandatoryEvidenceComplete
            && blockingRegressionCount <= input.maxToleratedRegressions,
        mandatoryEvidenceComplete,
        hardGateFailures: failures,
        blockingRegressionCount,
    };
}

/** Every gate observation and measurement must name a lane row that carries the same fingerprint. */
function verifyEvidenceBindings(body: ScorecardReportBody): void {
    const lanes = new Map(body.evidence.lanes.map((row) => [row.lane, row]));
    for (const [index, gate] of body.safetyGates.entries()) {
        if (gate.sourceLane === null) continue;
        const lane = lanes.get(gate.sourceLane);
        // A pass needs the whole run; a failure is evidence even when the run stopped at the observation,
        // which is how the live metamorphic runner reports a canary hit.
        const bound = lane !== undefined && (lane.status === "present" || (gate.status === "failed" && interruptedOnThisTarget(lane)));
        if (!bound || lane.reportFingerprint !== gate.evidenceFingerprint) {
            fail(`report.body.safetyGates[${index}]: evidence-binding-invalid`);
        }
    }
    for (const family of familySections(body)) {
        for (const [index, slot] of family.slots.entries()) {
            if (slot.status !== "measured") continue;
            // Reliability slots read run-health counts from a lane that did not finish, so an interrupted lane also sources a measurement.
            const lane = lanes.get(slot.sourceLane);
            const parsed = lane !== undefined && (lane.status === "present" || interruptedOnThisTarget(lane));
            if (!parsed || lane.reportFingerprint !== slot.sourceFingerprint) {
                fail(`report.body.${family.family}.slots[${index}]: evidence-binding-invalid`);
            }
        }
    }
}

/** Recomputes the adverse rows from the deltas; a `family-missing` row cannot name a key the current release estimated. */
function verifyComparison(body: ScorecardReportBody): void {
    const { familyEstimates, deltas } = body.utility;
    const baselinePresent = body.evidence.baseline.status === "present";
    unique(familyEstimates.map(estimateKey), "report.body.utility.familyEstimates");
    if (deltas.length !== familyEstimates.length) fail("report.body.utility.deltas: estimate-mirror-invalid");
    for (const [index, delta] of deltas.entries()) {
        const estimate = familyEstimates[index]!;
        const label = `report.body.utility.deltas[${index}]`;
        if (estimateKey(delta) !== estimateKey(estimate)) fail(`${label}: estimate-mirror-invalid`);
        if (delta.status === "no-baseline") {
            if (delta.value !== estimate.pointEstimate) fail(`${label}.value: cross-field-invalid`);
        } else {
            if (!baselinePresent) fail(`${label}.status: baseline-required`);
            if (delta.noiseLabel !== estimate.noiseLabel) fail(`${label}.noiseLabel: cross-field-invalid`);
            const shifted = delta.baselinePointEstimate;
            if (delta.delta !== estimate.pointEstimate - shifted
                || delta.interval.lower !== estimate.interval.lower - shifted
                || delta.interval.upper !== estimate.interval.upper - shifted) {
                fail(`${label}: cross-field-invalid`);
            }
        }
    }
    const adverse = body.adverseDeltas;
    unique(adverse.map((row) => `${row.kind}:${estimateKey(row)}`), "report.body.adverseDeltas");
    sorted(adverse, (row) => [row.familyId, row.endpoint, row.kind], "report.body.adverseDeltas");
    if (adverse.length > 0 && !baselinePresent) fail("report.body.adverseDeltas: baseline-required");
    const expected = deltas.filter((row): row is Extract<DeltaRow, { status: "compared" }> => row.status === "compared" && row.interval.upper < 0);
    const claimedByKey = new Map(adverse.filter((row) => row.kind === "adverse-interval").map((row) => [estimateKey(row), row]));
    if (claimedByKey.size !== expected.length) fail("report.body.adverseDeltas: derived-mismatch");
    for (const row of expected) {
        const claimed = claimedByKey.get(estimateKey(row));
        if (claimed === undefined
            || claimed.delta !== row.delta
            || claimed.noiseLabel !== row.noiseLabel
            || claimed.interval!.lower !== row.interval.lower
            || claimed.interval!.upper !== row.interval.upper) {
            fail("report.body.adverseDeltas: derived-mismatch");
        }
    }
    const currentKeys = new Set(familyEstimates.map(estimateKey));
    for (const [index, row] of adverse.entries()) {
        if (row.kind === "family-missing" && currentKeys.has(estimateKey(row))) fail(`report.body.adverseDeltas[${index}]: family-present`);
    }
}

export function parseScorecardReport(raw: unknown): ScorecardReport {
    const root = record(raw, "report");
    exact(root, ["schema", "body", "reportFingerprint"], "report");
    if (root.schema !== SCORECARD_REPORT_SCHEMA) fail("report.schema: version-invalid");
    const value = record(root.body, "report.body");
    exact(value, REPORT_BODY_KEYS, "report.body");
    if (Object.keys(value).some((key, index) => key !== REPORT_BODY_KEYS[index])) fail("report.body: section-order-invalid");
    const target = record(value.target, "report.body.target");
    exact(target, [
        "freezeManifestFingerprint", "policyFingerprint", "pairedDeltaPolicyFingerprint", "baselineScorecardReportFingerprint",
        "requiredMetricSlots", "maxToleratedRegressions",
    ], "report.body.target");
    const evidence = record(value.evidence, "report.body.evidence");
    exact(evidence, ["lanes", "baseline"], "report.body.evidence");
    const baseline = record(evidence.baseline, "report.body.evidence.baseline");
    exact(baseline, ["status", "reportFingerprint", "estimatesStatus"], "report.body.evidence.baseline");
    const outcome = record(value.outcome, "report.body.outcome");
    exact(outcome, ["promotionAllowed", "mandatoryEvidenceComplete", "hardGateFailures", "blockingRegressionCount"], "report.body.outcome");
    const gates = array(value.safetyGates, "report.body.safetyGates");
    if (gates.length !== SCORECARD_GATE_IDS.length) fail("report.body.safetyGates: exact-gate-set-required");
    const lanes = array(evidence.lanes, "report.body.evidence.lanes");
    if (lanes.length !== LANE_IDS.length) fail("report.body.evidence.lanes: exact-lane-set-required");
    const requiredMetricSlots = idArray(target.requiredMetricSlots, "report.body.target.requiredMetricSlots", REASON_CODE_RE)
        .map((slot, index) => enumeration(slot, METRIC_SLOT_IDS, `report.body.target.requiredMetricSlots[${index}]`));
    unique(requiredMetricSlots, "report.body.target.requiredMetricSlots");
    const body: ScorecardReportBody = {
        target: {
            freezeManifestFingerprint: hex64(target.freezeManifestFingerprint, "report.body.target.freezeManifestFingerprint"),
            policyFingerprint: hex64(target.policyFingerprint, "report.body.target.policyFingerprint"),
            pairedDeltaPolicyFingerprint: hex64(target.pairedDeltaPolicyFingerprint, "report.body.target.pairedDeltaPolicyFingerprint"),
            baselineScorecardReportFingerprint: nullable(target.baselineScorecardReportFingerprint, (fingerprint) =>
                hex64(fingerprint, "report.body.target.baselineScorecardReportFingerprint")),
            requiredMetricSlots,
            maxToleratedRegressions: integer(target.maxToleratedRegressions, "report.body.target.maxToleratedRegressions", 0),
        },
        utility: parseUtilitySection(value.utility),
        formation: parseFamilySection(value.formation, "formation"),
        retrieval: parseFamilySection(value.retrieval, "retrieval"),
        context: parseFamilySection(value.context, "context"),
        reliability: parseFamilySection(value.reliability, "reliability"),
        safetyGates: gates.map(parseGateRow),
        regret: array(value.regret, "report.body.regret").map(parseRegretRow),
        adverseDeltas: array(value.adverseDeltas, "report.body.adverseDeltas").map(parseAdverseRow),
        limitations: idArray(value.limitations, "report.body.limitations", REASON_CODE_RE),
        evidence: {
            lanes: lanes.map(parseEvidenceRow),
            baseline: {
                status: enumeration(baseline.status, BASELINE_STATUSES, "report.body.evidence.baseline.status"),
                reportFingerprint: nullable(baseline.reportFingerprint, (fingerprint) =>
                    hex64(fingerprint, "report.body.evidence.baseline.reportFingerprint")),
                estimatesStatus: nullable(baseline.estimatesStatus, (status) =>
                    enumeration(status, LANE_STATUSES, "report.body.evidence.baseline.estimatesStatus")),
            },
        },
        outcome: {
            promotionAllowed: boolean(outcome.promotionAllowed, "report.body.outcome.promotionAllowed"),
            mandatoryEvidenceComplete: boolean(outcome.mandatoryEvidenceComplete, "report.body.outcome.mandatoryEvidenceComplete"),
            hardGateFailures: idArray(outcome.hardGateFailures, "report.body.outcome.hardGateFailures", GATE_ID_RE) as GateId[],
            blockingRegressionCount: integer(outcome.blockingRegressionCount, "report.body.outcome.blockingRegressionCount"),
        },
    };
    const reportFingerprint = hex64(root.reportFingerprint, "report.reportFingerprint");
    if (canonicalFingerprint(body) !== reportFingerprint) fail("report.reportFingerprint: mismatch");
    const pinned = body.target.baselineScorecardReportFingerprint;
    const loaded = body.evidence.baseline;
    if ((loaded.status === "absent") !== (pinned === null)) fail("report.body.evidence.baseline.status: cross-field-invalid");
    if ((loaded.status === "present") !== (loaded.reportFingerprint !== null && loaded.estimatesStatus !== null)) fail("report.body.evidence.baseline: shape-invalid");
    if (loaded.status === "present" && loaded.reportFingerprint !== pinned) fail("report.body.evidence.baseline.reportFingerprint: cross-field-invalid");
    verifyEvidenceBindings(body);
    verifyComparison(body);
    const derived = deriveOutcome({
        gates: body.safetyGates,
        lanes: body.evidence.lanes,
        baseline: loaded,
        families: familySections(body),
        requiredMetricSlots: body.target.requiredMetricSlots,
        adverseDeltas: body.adverseDeltas,
        maxToleratedRegressions: body.target.maxToleratedRegressions,
    });
    if (canonicalFingerprint(body.outcome) !== canonicalFingerprint(derived)) fail("report.body.outcome: cross-field-invalid");
    return { schema: SCORECARD_REPORT_SCHEMA, body, reportFingerprint };
}

export function familySections(body: ScorecardReportBody): ScoreFamilySection[] {
    return SCORE_FAMILY_IDS.map((family) => body[family]);
}
