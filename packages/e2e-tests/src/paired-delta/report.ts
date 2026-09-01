import { readFileSync } from "node:fs";
import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { publishJsonAtomically } from "../atomic-publish";
import { compareCodeUnits } from "../code-unit-order";
import type { PairedCaseFact } from "../prospective-holdout/comparison";
import { parsePolicyOwnerDocument } from "../prospective-holdout/contract";
import { pairedFactsFingerprint } from "../prospective-holdout/report";
import { ARM_IDS, PRIMARY_ARM_IDS, REASON_CODES, type ArmId, type ReasonCode } from "./contract";
import type {
    EndpointEstimate,
    FamilyDeltaAnalysis,
    FamilyNoiseFloor,
    RawRegretRecord,
} from "./estimator";
import type { PairedDeltaRunResult, RolloutRecord } from "./runner";

export const PAIRED_DELTA_REPORT_SCHEMA = "paired-delta-report/v1";
export const PAIRED_DELTA_CALIBRATION_SCHEMA = "paired-delta-calibration/v1";

const ARM_ID_SET: ReadonlySet<string> = new Set(ARM_IDS);
const REASON_CODE_SET: ReadonlySet<string> = new Set(REASON_CODES);

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

function requireHex64(value: string, label: string): void {
    if (!/^[0-9a-f]{64}$/.test(value)) {
        throw new Error(`paired-delta-report: ${label}-invalid`);
    }
}

function sortedMetrics(metrics: ArmMetrics): ArmMetrics {
    for (const [armId, value] of Object.entries(metrics)) {
        if (!ARM_ID_SET.has(armId)) {
            throw new Error(`paired-delta-report: metric-arm-invalid-${armId}`);
        }
        if (value === undefined || !Number.isFinite(value) || value < 0) {
            throw new Error("paired-delta-report: metric-invalid");
        }
    }
    return Object.fromEntries(
        Object.entries(metrics).sort(([left], [right]) => compareCodeUnits(left, right)),
    );
}

// A `:`-joined key is ambiguous because both identifiers are free-form and may contain `:`; JSON array encoding keeps distinct pairs distinct.
function ladderRowKey(coordinateId: string, familyId: string): string {
    return JSON.stringify([coordinateId, familyId]);
}

// The ladder is a pivot of the analyzed records, so published regret values cannot contradict the analysis.
function rawRegretLadder(records: readonly RawRegretRecord[]): RawRegretLadder[] {
    const rows = new Map<string, RawRegretLadder>();
    for (const record of records) {
        const key = ladderRowKey(record.coordinateId, record.familyId);
        const row = rows.get(key) ?? {
            coordinateId: record.coordinateId,
            familyId: record.familyId,
            retrieval: null,
            formation: null,
            representation: null,
            label: "raw-non-inferential" as const,
        };
        row[record.endpoint] = record.delta;
        rows.set(key, row);
    }
    // `coordinateId` alone repeats across families, so the sort key carries both identifiers.
    return [...rows]
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([, row]) => row);
}

// A report is policy-bound only when its family minimum equals the minimum the ready policy declares.
function requirePolicyBoundEstimatorSettings(
    policyPayload: unknown,
    analysis: FamilyDeltaAnalysis,
): void {
    const payload = policyPayload as {
        minimumAnalyzableFamilyCount?: unknown;
        targetMinimumDetectableDelta?: unknown;
    } | null;
    const declared = payload?.minimumAnalyzableFamilyCount;
    if (!Number.isSafeInteger(declared) || (declared as number) < 1) {
        throw new Error("paired-delta-report: policy-minimum-family-count-missing");
    }
    if (declared !== analysis.minimumAnalyzableFamilyCount) {
        throw new Error("paired-delta-report: policy-minimum-family-count-mismatch");
    }
    // The declared delta sizes the cohort during calibration rather than filtering an observed estimate, so this checks its shape and leaves resolution to the interval rule.
    const detectableDelta = payload?.targetMinimumDetectableDelta;
    if (typeof detectableDelta !== "number" || !Number.isFinite(detectableDelta) ||
        detectableDelta <= 0) {
        throw new Error("paired-delta-report: policy-detectable-delta-invalid");
    }
}

export function buildPairedDeltaReport(input: {
    poolManifestFingerprint: string;
    pinnedSnapshotId: string;
    policyDocument: unknown;
    pairs: readonly PairedCaseFact[];
    analysis: FamilyDeltaAnalysis;
    exclusions: readonly ExclusionCount[];
    secondaryMetrics: SecondaryMetrics;
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
    if (
        input.analysis.poolManifestFingerprint !== input.poolManifestFingerprint ||
        input.analysis.pinnedSnapshotId !== input.pinnedSnapshotId ||
        input.analysis.policyFingerprint !== policy.policyFingerprint
    ) {
        throw new Error("paired-delta-report: analysis-lane-binding-mismatch");
    }
    // The estimator adapter proves this against the pairs it analyzes; the report path proves it too rather than trusting the stamped value.
    if (pairedFactsFingerprint(input.pairs) !== input.analysis.pairedFactsFingerprint) {
        throw new Error("paired-delta-report: analysis-paired-facts-mismatch");
    }
    requirePolicyBoundEstimatorSettings(policy.policy, input.analysis);
    const exclusions = [...input.exclusions].sort((left, right) => compareCodeUnits(
        `${left.armId}:${left.reasonCode}`,
        `${right.armId}:${right.reasonCode}`,
    ));
    for (const { armId, reasonCode } of exclusions) {
        if (!ARM_ID_SET.has(armId)) {
            throw new Error(`paired-delta-report: exclusion-arm-invalid-${armId}`);
        }
        if (!REASON_CODE_SET.has(reasonCode)) {
            throw new Error(`paired-delta-report: exclusion-reason-code-invalid-${reasonCode}`);
        }
    }
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
            raw: rawRegretLadder(input.analysis.rawRegretRecords),
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
    if (report.schema !== PAIRED_DELTA_REPORT_SCHEMA) {
        throw new Error("paired-delta-report: schema-invalid");
    }
    if (canonicalFingerprint(report.body) !== report.reportFingerprint) {
        throw new Error("paired-delta-report: fingerprint-mismatch");
    }
    publishJsonAtomically(report, path);
}

export interface CalibrationDecision {
    poolSize: number;
    familyCount: number;
    replicateCount: number;
    cadence: "weekly-and-release";
}

export interface CalibrationFamilyNoise {
    familyId: string;
    /** One entry per primary endpoint, because pooling both dilutes a noisy baseline with a constant one. */
    endpoint: "mc-on-vs-mc-off" | "mc-on-vs-compaction";
    observationCount: number;
    spread: number;
    variance: number;
    interval: { lower: number; upper: number };
}

export interface PairedDeltaCalibrationRecord {
    schema: typeof PAIRED_DELTA_CALIBRATION_SCHEMA;
    poolManifestFingerprint: string;
    /** Noise measured under one policy does not transfer to another: replicate depth and the family minimum both change what the floor means. */
    policyFingerprint: string;
    /** The manifest digest covers the pool's own files and deliberately excludes the plugin and live runner, so the evaluated implementation is bound here instead. */
    implementationCommit: string;
    pinnedSnapshotId: string;
    runStatus: PairedDeltaRunResult["status"];
    validForPoolSizing: boolean;
    measuredCostUsd: number;
    estimatedReserveUsd: number;
    /** Charges from superseded attempts of retried coordinates, which carry no cost source of their own on the surviving record. */
    retrySpendUsd: number;
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
        const key = coordinateKey(record);
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

/** Both identifiers are free-form, so the key is JSON-encoded rather than `:`-joined. */
function coordinateKey(record: RolloutRecord): string {
    return JSON.stringify([record.scenarioId, record.replicateIndex]);
}

/**
 * The preregistered endpoint is a valid-success delta, so a cell scores 1 only when every applicable critical check passed.
 * Averaging the whole check vector let an arm that wrote the file with the wrong answer score 0.5 despite zero valid successes.
 */
function validSuccess(record: RolloutRecord): number {
    if (record.cell.criticalTotal === 0) {
        throw new Error(`paired-delta-calibration: empty-critical-vector-${record.scenarioId}`);
    }
    return record.cell.criticalPassed === record.cell.criticalTotal ? 1 : 0;
}

const CALIBRATION_ENDPOINTS = [
    ["mc-off", "mc-on-vs-mc-off"],
    ["compaction", "mc-on-vs-compaction"],
] as const;

/**
 * The paired endpoint is `mc-on` minus a baseline, so the noise floor is measured on those deltas rather than on `mc-on` outcomes alone.
 * Endpoint identity is retained, because pooling a noisy baseline with a constant one dilutes the variance the noisy endpoint has to be sized for.
 */
function coordinateDeltas(
    records: readonly RolloutRecord[],
    analysable: ReadonlySet<string>,
): Map<string, Map<CalibrationFamilyNoise["endpoint"], number>> {
    const cells = new Map<string, Map<ArmId, number>>();
    for (const record of records) {
        if (record.cell.runHealth !== "completed") continue;
        const key = coordinateKey(record);
        if (!analysable.has(key)) continue;
        const scores = cells.get(key) ?? new Map<ArmId, number>();
        scores.set(record.armId, validSuccess(record));
        cells.set(key, scores);
    }
    const deltas = new Map<string, Map<CalibrationFamilyNoise["endpoint"], number>>();
    for (const [key, scores] of cells) {
        const treatment = scores.get("mc-on");
        if (treatment === undefined) continue;
        const observed = new Map<CalibrationFamilyNoise["endpoint"], number>();
        for (const [baseline, endpoint] of CALIBRATION_ENDPOINTS) {
            const value = scores.get(baseline);
            if (value !== undefined) observed.set(endpoint, treatment - value);
        }
        if (observed.size > 0) deltas.set(key, observed);
    }
    return deltas;
}

export function buildCalibrationRecord(input: {
    records: readonly RolloutRecord[];
    scenarioFamilies: ReadonlyMap<string, string>;
    runStatus: PairedDeltaRunResult["status"];
    poolManifestFingerprint: string;
    pinnedSnapshotId: string;
    policyFingerprint: string;
    implementationCommit: string;
    targetMinimumDetectableDelta: number;
    decisions: Omit<CalibrationDecision, "poolSize">;
}): PairedDeltaCalibrationRecord {
    requireHex64(input.poolManifestFingerprint, "pool-manifest-fingerprint");
    requireHex64(input.policyFingerprint, "policy-fingerprint");
    if (input.implementationCommit.trim().length === 0) {
        throw new Error("paired-delta-calibration: implementation-commit-invalid");
    }
    const analysable = completePrimaryCoordinates(input.records);
    const deltasByCoordinate = coordinateDeltas(input.records, analysable);
    const families = new Set(input.scenarioFamilies.values());
    const bySeries = new Map<string, number[]>();
    const seriesKey = (
        familyId: string,
        endpoint: CalibrationFamilyNoise["endpoint"],
    ): string => JSON.stringify([familyId, endpoint]);
    for (const familyId of families) {
        for (const [, endpoint] of CALIBRATION_ENDPOINTS) {
            bySeries.set(seriesKey(familyId, endpoint), []);
        }
    }
    /** Replicate depth is counted per scenario, so one scenario's complete replicates cannot stand in for another scenario that failed outright in the same family. */
    const depthByScenario = new Map<string, number>();
    for (const record of input.records) {
        if (record.armId !== "mc-on") continue;
        const familyId = input.scenarioFamilies.get(record.scenarioId);
        if (!familyId) {
            throw new Error(`paired-delta-calibration: unknown-scenario-${record.scenarioId}`);
        }
        const observed = deltasByCoordinate.get(coordinateKey(record));
        if (observed === undefined) continue;
        for (const [endpoint, delta] of observed) {
            bySeries.get(seriesKey(familyId, endpoint))!.push(delta);
        }
        depthByScenario.set(
            record.scenarioId,
            (depthByScenario.get(record.scenarioId) ?? 0) + 1,
        );
    }
    const familyNoise = [...bySeries]
        .filter(([, values]) => values.length > 0)
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([key, values]): CalibrationFamilyNoise => {
            const [familyId, endpoint] = JSON.parse(key) as [
                string,
                CalibrationFamilyNoise["endpoint"],
            ];
            const average = values.reduce((sum, value) => sum + value, 0) / values.length;
            const variance = values.length === 1
                ? 0
                : values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
                    (values.length - 1);
            const spread = Math.max(...values) - Math.min(...values);
            return {
                familyId,
                endpoint,
                observationCount: values.length,
                spread,
                variance,
                interval: { lower: 0, upper: spread },
            };
        });
    const measuredFamilies = new Set(familyNoise.map(({ familyId }) => familyId));
    /** Every selected scenario reaches the configured replicate depth, and one measurement per family reports zero variance, so pool sizing requires the depth the run was configured for. */
    const depthComplete = [...input.scenarioFamilies.keys()].every((scenarioId) =>
        (depthByScenario.get(scenarioId) ?? 0) >= input.decisions.replicateCount);
    const observed = input.records.filter(({ costSource }) => costSource === "observed");
    return ((body: Omit<PairedDeltaCalibrationRecord, "recordFingerprint">) =>
        ({ ...body, recordFingerprint: canonicalFingerprint(body) }))({
        schema: PAIRED_DELTA_CALIBRATION_SCHEMA,
        poolManifestFingerprint: input.poolManifestFingerprint,
        policyFingerprint: input.policyFingerprint,
        implementationCommit: input.implementationCommit,
        pinnedSnapshotId: input.pinnedSnapshotId,
        runStatus: input.runStatus,
        validForPoolSizing: input.runStatus === "completed" &&
            measuredFamilies.size === families.size &&
            depthComplete,
        /** A failed rollout is priced from its worst-case reserve, so those dollars are reported apart from provider-observed spend rather than inflating a measured total that later budgets read. */
        measuredCostUsd: observed.reduce((sum, record) => sum + record.costUsd, 0),
        estimatedReserveUsd: input.records
            .filter(({ costSource }) => costSource === "estimated")
            .reduce((sum, record) => sum + record.costUsd, 0),
        retrySpendUsd: input.records.reduce(
            (sum, record) => sum + record.priorAttemptsCostUsd,
            0,
        ),
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
    });
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
    requireHex64(record.policyFingerprint, "policy-fingerprint");
    if (
        typeof record.pinnedSnapshotId !== "string" ||
        typeof record.policyFingerprint !== "string" ||
        typeof record.implementationCommit !== "string" ||
        record.implementationCommit.trim().length === 0 ||
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

/**
 * The estimator keys one floor per family and rejects a repeated `familyId`, while the record keeps a series per endpoint, so each family collapses to its widest observed floor.
 * Widest rather than mean, because a floor decides whether an interval is inside measured noise: the narrower endpoint would call a delta resolved that the noisier one cannot separate.
 */
export function calibrationNoiseFloors(
    record: PairedDeltaCalibrationRecord,
): FamilyNoiseFloor[] {
    const widest = new Map<string, FamilyNoiseFloor>();
    for (const { familyId, spread, interval } of record.familyNoise) {
        const existing = widest.get(familyId);
        if (existing === undefined || spread > existing.value) {
            widest.set(familyId, { familyId, value: spread, interval });
        }
    }
    return [...widest.values()].sort((left, right) =>
        compareCodeUnits(left.familyId, right.familyId));
}
