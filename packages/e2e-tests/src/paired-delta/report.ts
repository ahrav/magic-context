import { readFileSync } from "node:fs";
import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { publishJsonAtomically } from "../incident-pool/report";
import { parsePolicyOwnerDocument } from "../prospective-holdout/contract";
import { PRIMARY_ARM_IDS, type ArmId, type ReasonCode } from "./contract";
import type { EndpointEstimate, FamilyDeltaAnalysis, FamilyNoiseFloor } from "./estimator";
import type { PairedDeltaRunResult, RolloutRecord } from "./runner";

export const PAIRED_DELTA_REPORT_SCHEMA = "paired-delta-report/v1";
export const PAIRED_DELTA_CALIBRATION_SCHEMA = "paired-delta-calibration/v1";

export interface ExclusionCount {
    armId: ArmId;
    reasonCode: ReasonCode;
    count: number;
}

type ArmMetrics = Partial<Record<ArmId, number>>;

export interface SecondaryMetrics {
    invalidSuccessRateByArm: ArmMetrics;
    tokensByArm: ArmMetrics;
    wallClockMsByArm: ArmMetrics;
    turnsByArm: ArmMetrics;
}

export interface RawRegretLadder {
    coordinateId: string;
    familyId: string;
    retrieval: number | null;
    formation: number | null;
    representation: number | null;
    label: "raw-non-inferential";
}

export interface PairedDeltaReportBody {
    poolManifestFingerprint: string;
    pinnedSnapshotId: string;
    policyFingerprint: string;
    analysis: FamilyDeltaAnalysis;
    exclusions: ExclusionCount[];
    secondaryMetrics: SecondaryMetrics;
    regret: {
        live: EndpointEstimate[];
        providerMixed: EndpointEstimate[];
        raw: RawRegretLadder[];
    };
    runSummary: {
        status: PairedDeltaRunResult["status"];
        spentUsd: number;
        observedCostRollouts: number;
        estimatedCostRollouts: number;
    };
}

export interface PairedDeltaReport {
    schema: typeof PAIRED_DELTA_REPORT_SCHEMA;
    body: PairedDeltaReportBody;
    reportFingerprint: string;
}

export interface CalibrationDecision {
    poolSize: number;
    familyCount: number;
    replicateCount: number;
    cadence: "weekly-and-release";
}

export interface CalibrationFamilyNoise {
    familyId: string;
    replicateCount: number;
    spread: number;
    variance: number;
    interval: { lower: number; upper: number };
}

export interface PairedDeltaCalibrationRecord {
    schema: typeof PAIRED_DELTA_CALIBRATION_SCHEMA;
    poolManifestFingerprint: string;
    pinnedSnapshotId: string;
    runStatus: PairedDeltaRunResult["status"];
    validForPoolSizing: boolean;
    measuredCostUsd: number;
    measuredWallClockMs: number;
    familyNoise: CalibrationFamilyNoise[];
    decisions: CalibrationDecision;
    recordFingerprint: string;
}

/** SIZING_QUANTILE_SUM_SQUARED is (z(0.975) + z(0.80))^2 for a two-sided alpha=0.05 test with 80% power. */
const SIZING_QUANTILE_SUM_SQUARED = (1.959964 + 0.841621) ** 2;

/**
 * Size the pool using the highest family variance so all families meet the target minimum detectable delta.
 *
 * Each family receives at least one pool member, even when worstVariance is zero.
 */
function derivePoolSize(
    familyNoise: readonly CalibrationFamilyNoise[],
    targetMinimumDetectableDelta: number,
    familyCount: number,
): number {
    if (
        !Number.isFinite(targetMinimumDetectableDelta) ||
        targetMinimumDetectableDelta <= 0
    ) {
        throw new Error("paired-delta-calibration: target-delta-invalid");
    }
    if (!Number.isSafeInteger(familyCount) || familyCount < 1) {
        throw new Error("paired-delta-calibration: family-count-invalid");
    }
    const worstVariance = familyNoise.reduce(
        (worst, { variance }) => Math.max(worst, variance),
        0,
    );
    const perFamily = Math.max(
        1,
        Math.ceil(
            (SIZING_QUANTILE_SUM_SQUARED * worstVariance) /
            targetMinimumDetectableDelta ** 2,
        ),
    );
    return perFamily * familyCount;
}

/**
 * A top-level run status of `completed` means the runner avoided its cost and deadline exits, while individual cells can still be excluded for provider, identity, or precondition reasons.
 * Measuring the noise floor over the population the delta estimator analyses stops a run with widespread exclusions from claiming a floor the analysis never sees.
 */
function completePrimaryCoordinates(
    records: readonly RolloutRecord[],
): Set<string> {
    const healthy = new Map<string, Set<ArmId>>();
    for (const record of records) {
        if (!(PRIMARY_ARM_IDS as readonly ArmId[]).includes(record.armId)) continue;
        if (record.cell.runHealth !== "completed") continue;
        const key = `${record.scenarioId}:${record.replicateIndex}`;
        const arms = healthy.get(key) ?? new Set<ArmId>();
        arms.add(record.armId);
        healthy.set(key, arms);
    }
    return new Set(
        [...healthy]
            .filter(([, arms]) => PRIMARY_ARM_IDS.every((armId) => arms.has(armId)))
            .map(([key]) => key),
    );
}

function requireHex64(value: string, label: string): void {
    if (!/^[0-9a-f]{64}$/.test(value)) {
        throw new Error(`paired-delta-report: ${label}-invalid`);
    }
}

function sortedMetrics(metrics: ArmMetrics): ArmMetrics {
    if (Object.values(metrics).some((value) =>
        value === undefined || !Number.isFinite(value) || value < 0)) {
        throw new Error("paired-delta-report: metric-invalid");
    }
    return Object.fromEntries(
        Object.entries(metrics).sort(([left], [right]) => left.localeCompare(right)),
    );
}

export function buildPairedDeltaReport(input: {
    poolManifestFingerprint: string;
    pinnedSnapshotId: string;
    policyDocument: unknown;
    analysis: FamilyDeltaAnalysis;
    exclusions: readonly ExclusionCount[];
    secondaryMetrics: SecondaryMetrics;
    rawRegretRecords: readonly RawRegretLadder[];
    runSummary: PairedDeltaReportBody["runSummary"];
}): PairedDeltaReport {
    const policy = parsePolicyOwnerDocument(
        input.policyDocument,
        "magic-context-x4l.14",
    );
    if (policy.status !== "ready" || policy.policyFingerprint === null) {
        throw new Error("paired-delta-report: policy-not-ready");
    }
    requireHex64(input.poolManifestFingerprint, "pool-manifest-fingerprint");
    if (input.pinnedSnapshotId.trim().length === 0) {
        throw new Error("paired-delta-report: pinned-snapshot-id-invalid");
    }
    const exclusions = [...input.exclusions].sort((left, right) =>
        `${left.armId}:${left.reasonCode}`.localeCompare(`${right.armId}:${right.reasonCode}`));
    if (exclusions.some(({ count }) => !Number.isSafeInteger(count) || count < 1)) {
        throw new Error("paired-delta-report: exclusion-count-invalid");
    }
    if (new Set(exclusions.map(({ armId, reasonCode }) => `${armId}:${reasonCode}`)).size !==
        exclusions.length) {
        throw new Error("paired-delta-report: duplicate-exclusion");
    }
    if (Object.values(input.secondaryMetrics.invalidSuccessRateByArm)
        .some((rate) => rate !== undefined && rate > 1)) {
        throw new Error("paired-delta-report: invalid-success-rate-invalid");
    }
    if (
        !Number.isFinite(input.runSummary.spentUsd) ||
        input.runSummary.spentUsd < 0 ||
        !Number.isSafeInteger(input.runSummary.observedCostRollouts) ||
        input.runSummary.observedCostRollouts < 0 ||
        !Number.isSafeInteger(input.runSummary.estimatedCostRollouts) ||
        input.runSummary.estimatedCostRollouts < 0
    ) {
        throw new Error("paired-delta-report: run-summary-invalid");
    }
    const body: PairedDeltaReportBody = {
        poolManifestFingerprint: input.poolManifestFingerprint,
        pinnedSnapshotId: input.pinnedSnapshotId,
        policyFingerprint: policy.policyFingerprint,
        analysis: input.analysis,
        exclusions,
        secondaryMetrics: {
            invalidSuccessRateByArm: sortedMetrics(input.secondaryMetrics.invalidSuccessRateByArm),
            tokensByArm: sortedMetrics(input.secondaryMetrics.tokensByArm),
            wallClockMsByArm: sortedMetrics(input.secondaryMetrics.wallClockMsByArm),
            turnsByArm: sortedMetrics(input.secondaryMetrics.turnsByArm),
        },
        regret: {
            live: input.analysis.liveRegret,
            providerMixed: input.analysis.providerMixedRegret,
            raw: [...input.rawRegretRecords].sort((left, right) =>
                left.coordinateId.localeCompare(right.coordinateId)),
        },
        runSummary: input.runSummary,
    };
    return {
        schema: PAIRED_DELTA_REPORT_SCHEMA,
        body,
        reportFingerprint: canonicalFingerprint(body),
    };
}

export function publishPairedDeltaReport(report: PairedDeltaReport, path: string): void {
    if (
        report.schema !== PAIRED_DELTA_REPORT_SCHEMA ||
        canonicalFingerprint(report.body) !== report.reportFingerprint
    ) {
        throw new Error("paired-delta-report: fingerprint-mismatch");
    }
    publishJsonAtomically(report, path);
}

export function buildCalibrationRecord(input: {
    records: readonly RolloutRecord[];
    scenarioFamilies: ReadonlyMap<string, string>;
    runStatus: PairedDeltaRunResult["status"];
    poolManifestFingerprint: string;
    pinnedSnapshotId: string;
    targetMinimumDetectableDelta: number;
    decisions: Omit<CalibrationDecision, "poolSize">;
}): PairedDeltaCalibrationRecord {
    requireHex64(input.poolManifestFingerprint, "pool-manifest-fingerprint");
    const analysable = completePrimaryCoordinates(input.records);
    const byFamily = new Map<string, number[]>();
    for (const familyId of new Set(input.scenarioFamilies.values())) {
        byFamily.set(familyId, []);
    }
    for (const record of input.records) {
        if (record.armId !== "mc-on" || record.cell.runHealth !== "completed") continue;
        const familyId = input.scenarioFamilies.get(record.scenarioId);
        if (!familyId) {
            throw new Error(`paired-delta-calibration: unknown-scenario-${record.scenarioId}`);
        }
        if (record.cell.checksTotal === 0) {
            throw new Error(`paired-delta-calibration: empty-check-vector-${record.scenarioId}`);
        }
        if (!analysable.has(`${record.scenarioId}:${record.replicateIndex}`)) continue;
        byFamily.get(familyId)!.push(
            record.cell.checksPassed / record.cell.checksTotal,
        );
    }
    const familyNoise = [...byFamily]
        .filter(([, values]) => values.length > 0)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([familyId, values]): CalibrationFamilyNoise => {
            const average = values.reduce((sum, value) => sum + value, 0) / values.length;
            const variance = values.length === 1
                ? 0
                : values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
                    (values.length - 1);
            const spread = Math.max(...values) - Math.min(...values);
            return {
                familyId,
                replicateCount: values.length,
                spread,
                variance,
                interval: { lower: 0, upper: spread },
            };
        });
    const body: Omit<PairedDeltaCalibrationRecord, "recordFingerprint"> = {
        schema: PAIRED_DELTA_CALIBRATION_SCHEMA,
        poolManifestFingerprint: input.poolManifestFingerprint,
        pinnedSnapshotId: input.pinnedSnapshotId,
        runStatus: input.runStatus,
        // A single completed coordinate per family reports zero variance, so
        // sizing also requires the replicate depth the run was configured for.
        validForPoolSizing: input.runStatus === "completed" &&
            familyNoise.length === byFamily.size &&
            familyNoise.every(({ replicateCount }) =>
                replicateCount >= input.decisions.replicateCount),
        measuredCostUsd: input.records.reduce((sum, record) => sum + record.costUsd, 0),
        measuredWallClockMs: input.records.reduce(
            (sum, record) => sum + record.wallClockMs,
            0,
        ),
        familyNoise,
        decisions: {
            ...input.decisions,
            poolSize: derivePoolSize(
                familyNoise,
                input.targetMinimumDetectableDelta,
                input.decisions.familyCount,
            ),
        },
    };
    return { ...body, recordFingerprint: canonicalFingerprint(body) };
}

export function publishCalibrationRecord(
    record: PairedDeltaCalibrationRecord,
    path: string,
): void {
    const { recordFingerprint, ...body } = record;
    if (
        record.schema !== PAIRED_DELTA_CALIBRATION_SCHEMA ||
        canonicalFingerprint(body) !== recordFingerprint
    ) {
        throw new Error("paired-delta-calibration: fingerprint-mismatch");
    }
    publishJsonAtomically(record, path);
}

export function readCalibrationRecord(path: string): PairedDeltaCalibrationRecord {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("paired-delta-calibration: record-invalid");
    }
    const { recordFingerprint, ...body } = raw;
    if (
        raw.schema !== PAIRED_DELTA_CALIBRATION_SCHEMA ||
        typeof recordFingerprint !== "string" ||
        canonicalFingerprint(body) !== recordFingerprint
    ) {
        throw new Error("paired-delta-calibration: fingerprint-mismatch");
    }
    const record = raw as unknown as PairedDeltaCalibrationRecord;
    requireHex64(record.poolManifestFingerprint, "pool-manifest-fingerprint");
    if (
        typeof record.pinnedSnapshotId !== "string" ||
        typeof record.validForPoolSizing !== "boolean" ||
        !Array.isArray(record.familyNoise) ||
        record.familyNoise.some((noise) =>
            typeof noise.familyId !== "string" ||
            !Number.isFinite(noise.spread) ||
            !Number.isFinite(noise.interval?.lower) ||
            !Number.isFinite(noise.interval?.upper))
    ) {
        throw new Error("paired-delta-calibration: record-invalid");
    }
    return record;
}

export function calibrationNoiseFloors(
    record: PairedDeltaCalibrationRecord,
): FamilyNoiseFloor[] {
    return record.familyNoise.map(({ familyId, spread, interval }) => ({
        familyId,
        value: spread,
        interval,
    }));
}
