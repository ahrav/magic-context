import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import type { Interval, NoiseComparison, PrimaryEndpoint } from "../paired-delta/estimator";
import { PRIMARY_ENDPOINTS } from "../paired-delta/estimator";
import type { RawRegretLadder } from "../paired-delta/report";
import {
    GATE_ID_RE,
    LANE_IDS,
    REASON_CODE_RE,
    SCORECARD_GATE_IDS,
    SCORE_FAMILY_IDS,
    SLOT_IDS_BY_FAMILY,
    array,
    enumeration,
    exact,
    fail,
    hex64,
    idArray,
    integer,
    parseLaneIdentity,
    record,
    staticId,
    type GateId,
    type LaneId,
    type LaneIdentity,
    type MetricSlotId,
    type ScoreFamilyId,
} from "./policy";

export const SCORECARD_REPORT_SCHEMA = "scorecard-report/v1";

export const GATE_STATUSES = ["passed", "failed", "not-observed", "errored"] as const;
export type GateStatus = (typeof GATE_STATUSES)[number];

/** Flat on the wire: every key is present on every row, with `null` where the status carries no value. */
export interface GateRow {
    gateId: GateId;
    status: GateStatus;
    observedCount: number | null;
    evidenceFingerprint: string | null;
    sourceLane: LaneId | null;
    diagnostic: string | null;
}

export const METRIC_UNITS = ["ratio", "count", "tokens", "milliseconds", "delta"] as const;
export type MetricUnit = (typeof METRIC_UNITS)[number];

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
 * `delta` is the current point estimate minus the baseline point estimate and `interval` is the
 * current paired interval shifted by the baseline point estimate; the two releases carry no joint
 * distribution, so no narrower interval is claimed.
 */
export type DeltaRow =
    | { endpoint: PrimaryEndpoint; familyId: string; status: "compared"; delta: number; interval: Interval; noiseLabel: NoiseComparison }
    | { endpoint: PrimaryEndpoint; familyId: string; status: "no-baseline"; value: number };

export const ADVERSE_KINDS = ["adverse-interval", "family-missing"] as const;
export type AdverseKind = (typeof ADVERSE_KINDS)[number];

export interface AdverseRow {
    familyId: string;
    endpoint: PrimaryEndpoint | null;
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

export interface ScorecardReportBody {
    target: {
        freezeManifestFingerprint: string;
        policyFingerprint: string;
        pairedDeltaPolicyFingerprint: string;
        baselineScorecardReportFingerprint: string | null;
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
        baseline: { status: BaselineStatus; reportFingerprint: string | null };
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

function finiteNumber(value: unknown, label: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) fail(`${label}: number-invalid`);
    return value as number;
}

function nullable<T>(value: unknown, parse: (raw: unknown) => T): T | null {
    return value === null ? null : parse(value);
}

function boolean(value: unknown, label: string): boolean {
    if (typeof value !== "boolean") fail(`${label}: boolean-invalid`);
    return value as boolean;
}

function parseInterval(raw: unknown, label: string): Interval {
    const value = record(raw, label);
    exact(value, ["lower", "upper"], label);
    const interval = { lower: finiteNumber(value.lower, `${label}.lower`), upper: finiteNumber(value.upper, `${label}.upper`) };
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
    const observed = row.status === "passed" || row.status === "failed";
    if (observed !== (row.observedCount !== null && row.evidenceFingerprint !== null && row.sourceLane !== null)) {
        fail(`${label}: evidence-shape-invalid`);
    }
    if (row.status === "passed" && row.observedCount !== 0) fail(`${label}: passed-with-observations`);
    if (row.status === "failed" && row.observedCount === 0) fail(`${label}: failed-without-observations`);
    if (!observed && row.diagnostic === null) fail(`${label}.diagnostic: required`);
    return row;
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
        return {
            id,
            status,
            value: finiteNumber(value.value, `${label}.value`),
            unit: enumeration(value.unit, METRIC_UNITS, `${label}.unit`),
            sourceLane: enumeration(value.sourceLane, LANE_IDS, `${label}.sourceLane`),
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
        familyId: staticId(value.familyId, `${label}.familyId`, ESTIMATE_FAMILY_ID_RE),
        pointEstimate: finiteNumber(value.pointEstimate, `${label}.pointEstimate`),
        interval: parseInterval(value.interval, `${label}.interval`),
        noiseLabel: enumeration(value.noiseLabel, NOISE_LABELS, `${label}.noiseLabel`),
    };
}

function parseDeltaRow(raw: unknown, label: string): DeltaRow {
    const value = record(raw, label);
    const status = enumeration(value.status, ["compared", "no-baseline"] as const, `${label}.status`);
    const endpoint = enumeration(value.endpoint, PRIMARY_ENDPOINTS, `${label}.endpoint`);
    const familyId = staticId(value.familyId, `${label}.familyId`, ESTIMATE_FAMILY_ID_RE);
    if (status === "compared") {
        exact(value, ["endpoint", "familyId", "status", "delta", "interval", "noiseLabel"], label);
        return {
            endpoint,
            familyId,
            status,
            delta: finiteNumber(value.delta, `${label}.delta`),
            interval: parseInterval(value.interval, `${label}.interval`),
            noiseLabel: enumeration(value.noiseLabel, NOISE_LABELS, `${label}.noiseLabel`),
        };
    }
    exact(value, ["endpoint", "familyId", "status", "value"], label);
    return { endpoint, familyId, status, value: finiteNumber(value.value, `${label}.value`) };
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
        familyId: staticId(value.familyId, `${label}.familyId`, ESTIMATE_FAMILY_ID_RE),
        endpoint: nullable(value.endpoint, (endpoint) => enumeration(endpoint, PRIMARY_ENDPOINTS, `${label}.endpoint`)),
        kind: enumeration(value.kind, ADVERSE_KINDS, `${label}.kind`),
        noiseLabel: nullable(value.noiseLabel, (noise) => enumeration(noise, NOISE_LABELS, `${label}.noiseLabel`)),
        delta: nullable(value.delta, (delta) => finiteNumber(delta, `${label}.delta`)),
        interval: nullable(value.interval, (interval) => parseInterval(interval, `${label}.interval`)),
        blocking: boolean(value.blocking, `${label}.blocking`),
    };
    const measured = row.kind === "adverse-interval";
    if (measured !== (row.endpoint !== null && row.noiseLabel !== null && row.delta !== null && row.interval !== null)) {
        fail(`${label}: shape-invalid`);
    }
    if (row.blocking !== (row.kind === "family-missing" || row.noiseLabel === "outside-floor")) fail(`${label}.blocking: cross-field-invalid`);
    return row;
}

function parseRegretRow(raw: unknown, index: number): RawRegretLadder {
    const label = `report.body.regret[${index}]`;
    const value = record(raw, label);
    exact(value, ["coordinateId", "familyId", "retrieval", "formation", "representation", "label"], label);
    if (value.label !== "raw-non-inferential") fail(`${label}.label: literal-invalid`);
    const rung = (field: "retrieval" | "formation" | "representation"): number | null =>
        nullable(value[field], (delta) => finiteNumber(delta, `${label}.${field}`));
    return {
        coordinateId: staticId(value.coordinateId, `${label}.coordinateId`, ESTIMATE_FAMILY_ID_RE),
        familyId: staticId(value.familyId, `${label}.familyId`, ESTIMATE_FAMILY_ID_RE),
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
    return {
        lane,
        status: enumeration(value.status, LANE_STATUSES, `${label}.status`),
        reportFingerprint: nullable(value.reportFingerprint, (fingerprint) => hex64(fingerprint, `${label}.reportFingerprint`)),
        identity: nullable(value.identity, (identity) => parseLaneIdentity(identity, lane, `${label}.identity`)),
        diagnostics: idArray(value.diagnostics, `${label}.diagnostics`, REASON_CODE_RE),
    };
}

export interface OutcomePolicyTerms {
    requiredMetricSlots: readonly MetricSlotId[];
    maxToleratedRegressions: number;
}

/** `UNBOUNDED_POLICY_TERMS` omits required slots and permits every regression, so derived flags only bound claims. */
const UNBOUNDED_POLICY_TERMS: OutcomePolicyTerms = { requiredMetricSlots: [], maxToleratedRegressions: Number.POSITIVE_INFINITY };

/** Whether every row and slot the policy requires supports promotion. Recomputed by the parser so a report cannot claim what its own rows deny. */
export function deriveOutcome(input: OutcomePolicyTerms & {
    gates: readonly GateRow[];
    lanes: readonly EvidenceRow[];
    families: readonly ScoreFamilySection[];
    adverseDeltas: readonly AdverseRow[];
}): ScorecardReportBody["outcome"] {
    const hardGateFailures = input.gates.filter((row) => row.status !== "passed").map((row) => row.gateId).sort();
    const measured = new Set(input.families.flatMap((family) => family.slots)
        .filter((slot) => slot.status === "measured").map((slot) => slot.id));
    const mandatoryEvidenceComplete = input.lanes.every((row) => row.status === "present")
        && input.requiredMetricSlots.every((slot) => measured.has(slot));
    const blockingRegressionCount = input.adverseDeltas.filter((row) => row.blocking).length;
    return {
        promotionAllowed: hardGateFailures.length === 0
            && mandatoryEvidenceComplete
            && blockingRegressionCount <= input.maxToleratedRegressions,
        mandatoryEvidenceComplete,
        hardGateFailures,
        blockingRegressionCount,
    };
}

/** With `policyTerms`, the claimed outcome must equal the derived one. Without them, the counts must match and each claimed flag may not exceed its unbounded derivation. */
function verifyOutcome(body: ScorecardReportBody, policyTerms: OutcomePolicyTerms | undefined): void {
    const derived = deriveOutcome({
        ...(policyTerms ?? UNBOUNDED_POLICY_TERMS),
        gates: body.safetyGates,
        lanes: body.evidence.lanes,
        families: familySections(body),
        adverseDeltas: body.adverseDeltas,
    });
    const claimed = body.outcome;
    if (JSON.stringify(claimed.hardGateFailures) !== JSON.stringify(derived.hardGateFailures)) fail("report.body.outcome.hardGateFailures: cross-field-invalid");
    if (claimed.blockingRegressionCount !== derived.blockingRegressionCount) fail("report.body.outcome.blockingRegressionCount: cross-field-invalid");
    const flagInvalid = (flag: boolean, bound: boolean): boolean => (policyTerms === undefined ? flag && !bound : flag !== bound);
    if (flagInvalid(claimed.mandatoryEvidenceComplete, derived.mandatoryEvidenceComplete)) fail("report.body.outcome.mandatoryEvidenceComplete: cross-field-invalid");
    if (flagInvalid(claimed.promotionAllowed, derived.promotionAllowed) || (claimed.promotionAllowed && !claimed.mandatoryEvidenceComplete)) {
        fail("report.body.outcome.promotionAllowed: cross-field-invalid");
    }
}

export function parseScorecardReport(raw: unknown, policyTerms?: OutcomePolicyTerms): ScorecardReport {
    const root = record(raw, "report");
    exact(root, ["schema", "body", "reportFingerprint"], "report");
    if (root.schema !== SCORECARD_REPORT_SCHEMA) fail("report.schema: version-invalid");
    const value = record(root.body, "report.body");
    exact(value, REPORT_BODY_KEYS, "report.body");
    if (Object.keys(value).some((key, index) => key !== REPORT_BODY_KEYS[index])) fail("report.body: section-order-invalid");
    const target = record(value.target, "report.body.target");
    exact(target, ["freezeManifestFingerprint", "policyFingerprint", "pairedDeltaPolicyFingerprint", "baselineScorecardReportFingerprint"], "report.body.target");
    const evidence = record(value.evidence, "report.body.evidence");
    exact(evidence, ["lanes", "baseline"], "report.body.evidence");
    const baseline = record(evidence.baseline, "report.body.evidence.baseline");
    exact(baseline, ["status", "reportFingerprint"], "report.body.evidence.baseline");
    const outcome = record(value.outcome, "report.body.outcome");
    exact(outcome, ["promotionAllowed", "mandatoryEvidenceComplete", "hardGateFailures", "blockingRegressionCount"], "report.body.outcome");
    const gates = array(value.safetyGates, "report.body.safetyGates");
    if (gates.length !== SCORECARD_GATE_IDS.length) fail("report.body.safetyGates: exact-gate-set-required");
    const lanes = array(evidence.lanes, "report.body.evidence.lanes");
    if (lanes.length !== LANE_IDS.length) fail("report.body.evidence.lanes: exact-lane-set-required");
    const body: ScorecardReportBody = {
        target: {
            freezeManifestFingerprint: hex64(target.freezeManifestFingerprint, "report.body.target.freezeManifestFingerprint"),
            policyFingerprint: hex64(target.policyFingerprint, "report.body.target.policyFingerprint"),
            pairedDeltaPolicyFingerprint: hex64(target.pairedDeltaPolicyFingerprint, "report.body.target.pairedDeltaPolicyFingerprint"),
            baselineScorecardReportFingerprint: nullable(target.baselineScorecardReportFingerprint, (fingerprint) =>
                hex64(fingerprint, "report.body.target.baselineScorecardReportFingerprint")),
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
    verifyOutcome(body, policyTerms);
    if ((body.evidence.baseline.status === "present") !== (body.evidence.baseline.reportFingerprint !== null)) {
        fail("report.body.evidence.baseline: shape-invalid");
    }
    return { schema: SCORECARD_REPORT_SCHEMA, body, reportFingerprint };
}

export function familySections(body: ScorecardReportBody): ScoreFamilySection[] {
    return SCORE_FAMILY_IDS.map((family) => body[family]);
}
