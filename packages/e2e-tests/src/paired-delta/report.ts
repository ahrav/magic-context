import { readFileSync } from "node:fs";
import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { publishJsonAtomically } from "../atomic-publish";
import { compareCodeUnits } from "../code-unit-order";
import { makeContractPrimitives, vocabulary } from "../contract-primitives";
import type { PairedCaseFact } from "../prospective-holdout/comparison";
import { parsePolicyOwnerDocument } from "../prospective-holdout/contract";
import { pairedFactsFingerprint } from "../prospective-holdout/report";
import {
    ARM_IDS,
    PRIMARY_ARM_IDS,
    PairedDeltaContractError,
    REASON_CODES,
    type ArmId,
    type ReasonCode,
} from "./contract";
import type {
    DeltaEndpoint,
    EndpointEstimate,
    FamilyDeltaAnalysis,
    FamilyEstimate,
    FamilyNoiseFloor,
    Interval,
    RawRegretRecord,
} from "./estimator";
import { LIVE_REGRET_ENDPOINTS, PRIMARY_ENDPOINTS, PROVIDER_MIXED_REGRET_ENDPOINTS, REGRET_ENDPOINTS } from "./estimator";
import { validSuccess } from "./scoring";
import { tupleKey } from "./tuple-key";
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
    /** Surviving attempts only: a replaced record keeps prior spend but not prior usage, duration, or turns. */
    finalAttemptTokensByArm: ArmMetrics;
    finalAttemptWallClockMsByArm: ArmMetrics;
    finalAttemptTurnsByArm: ArmMetrics;
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
    /** Caveats a reader needs to interpret the deltas, recorded because the report is read on its own. */
    limitations: string[];
    poolManifestFingerprint: string;
    pinnedSnapshotId: string;
    policyFingerprint: string;
    /** The manifest digest excludes the plugin, harness, and live runner, so a standalone artifact identifies its implementation here. */
    implementationDigest: string;
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
        /** A refused ladder leaves its cell `completed`, so it reaches no exclusion count; without this a systemic refusal reads as an unscheduled regret arm. */
        refusedRegretLadders: Record<string, number>;
        plannedCoordinates: number;
        healthyCoordinates: number;
        /** The dispatch's own verdict, recorded because the workflow archives this report even when the step fails. */
        evidenceComplete: boolean;
        /** Which calibration artifact supplied the noise floors, so a reader can tell two dispatches apart. */
        calibrationFingerprint: string | null;
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
    implementationDigest: string;
    pairs: readonly PairedCaseFact[];
    analysis: FamilyDeltaAnalysis;
    exclusions: readonly ExclusionCount[];
    secondaryMetrics: SecondaryMetrics;
    limitations: readonly string[];
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
    if (input.implementationDigest.trim().length === 0) {
        throw new Error("paired-delta-report: implementation-digest-invalid");
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
        input.runSummary.estimatedCostRollouts < 0 ||
        Object.values(input.runSummary.refusedRegretLadders).some((count) =>
            !Number.isSafeInteger(count) || count < 1) ||
        !Number.isSafeInteger(input.runSummary.plannedCoordinates) ||
        input.runSummary.plannedCoordinates < 0 ||
        !Number.isSafeInteger(input.runSummary.healthyCoordinates) ||
        input.runSummary.healthyCoordinates < 0 ||
        input.runSummary.healthyCoordinates > input.runSummary.plannedCoordinates
    ) {
        throw new Error("paired-delta-report: run-summary-invalid");
    }
    if (input.limitations.some((line) => line.trim().length === 0)) {
        throw new Error("paired-delta-report: limitation-invalid");
    }
    const body: PairedDeltaReportBody = {
        limitations: [...input.limitations].sort(compareCodeUnits),
        poolManifestFingerprint: input.poolManifestFingerprint,
        pinnedSnapshotId: input.pinnedSnapshotId,
        policyFingerprint: policy.policyFingerprint,
        implementationDigest: input.implementationDigest,
        analysis: input.analysis,
        exclusions,
        secondaryMetrics: {
            invalidSuccessRateByArm: sortedMetrics(input.secondaryMetrics.invalidSuccessRateByArm),
            finalAttemptTokensByArm:
                sortedMetrics(input.secondaryMetrics.finalAttemptTokensByArm),
            finalAttemptWallClockMsByArm:
                sortedMetrics(input.secondaryMetrics.finalAttemptWallClockMsByArm),
            finalAttemptTurnsByArm:
                sortedMetrics(input.secondaryMetrics.finalAttemptTurnsByArm),
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

const RUN_STATUSES = vocabulary<PairedDeltaRunResult["status"]>({
    completed: true,
    "cost-cap-reached": true,
    "deadline-reached": true,
    "invalid-stored-records": true,
    "harness-unreclaimed": true,
    "usage-unmeasured": true,
});

const p = makeContractPrimitives(PairedDeltaContractError);

function finiteNumber(value: unknown, label: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) p.fail(`${label}: number-invalid`);
    return value as number;
}

function nonNegativeNumber(value: unknown, label: string): number {
    const result = finiteNumber(value, label);
    if (result < 0) p.fail(`${label}: number-invalid`);
    return result;
}

function parseInterval(raw: unknown, label: string): Interval {
    const value = p.record(raw, label);
    p.exact(value, ["lower", "upper"], label);
    return { lower: finiteNumber(value.lower, `${label}.lower`), upper: finiteNumber(value.upper, `${label}.upper`) };
}

function parseNoiseFloor(raw: unknown, label: string): FamilyNoiseFloor {
    const value = p.record(raw, label);
    const hasEndpoint = Object.hasOwn(value, "endpoint");
    p.exact(value, hasEndpoint ? ["endpoint", "familyId", "value", "interval"] : ["familyId", "value", "interval"], label);
    return {
        ...(hasEndpoint ? { endpoint: p.enumeration(value.endpoint, PRIMARY_ENDPOINTS, `${label}.endpoint`) } : {}),
        familyId: p.string(value.familyId, `${label}.familyId`),
        value: finiteNumber(value.value, `${label}.value`),
        interval: parseInterval(value.interval, `${label}.interval`),
    };
}

function parseFamilyEstimate(raw: unknown, label: string): FamilyEstimate {
    const value = p.record(raw, label);
    p.exact(value, ["familyId", "pointEstimate", "interval", "resolution", "noise"], label);
    const noise = p.record(value.noise, `${label}.noise`);
    p.exact(noise, ["label", "floor"], `${label}.noise`);
    return {
        familyId: p.string(value.familyId, `${label}.familyId`),
        pointEstimate: finiteNumber(value.pointEstimate, `${label}.pointEstimate`),
        interval: parseInterval(value.interval, `${label}.interval`),
        resolution: p.enumeration(value.resolution, ["resolved", "unresolved"] as const, `${label}.resolution`),
        noise: {
            label: p.enumeration(noise.label, ["no-noise-floor", "inside-floor", "outside-floor"] as const, `${label}.noise.label`),
            floor: noise.floor === null ? null : parseNoiseFloor(noise.floor, `${label}.noise.floor`),
        },
    };
}

// `allowed` is the estimator's bucket for this array: primary, live-regret, or provider-mixed-regret endpoints only.
function parseEndpointEstimates(raw: unknown, label: string, allowed: readonly DeltaEndpoint[]): EndpointEstimate[] {
    return p.array(raw, label).map((entry, index) => {
        const itemLabel = `${label}[${index}]`;
        const value = p.record(entry, itemLabel);
        p.exact(value, ["endpoint", "pointEstimate", "interval", "familyCount", "resolution", "families"], itemLabel);
        const families = p.array(value.families, `${itemLabel}.families`)
            .map((family, familyIndex) => parseFamilyEstimate(family, `${itemLabel}.families[${familyIndex}]`));
        const familyCount = p.integer(value.familyCount, `${itemLabel}.familyCount`);
        if (familyCount !== families.length) p.fail(`${itemLabel}.familyCount: derived-mismatch`);
        return {
            endpoint: p.enumeration(value.endpoint, allowed, `${itemLabel}.endpoint`),
            pointEstimate: finiteNumber(value.pointEstimate, `${itemLabel}.pointEstimate`),
            interval: parseInterval(value.interval, `${itemLabel}.interval`),
            familyCount,
            resolution: p.enumeration(value.resolution, ["resolved", "unresolved"] as const, `${itemLabel}.resolution`),
            families,
        };
    });
}

function parseAnalysis(raw: unknown, label: string): FamilyDeltaAnalysis {
    const value = p.record(raw, label);
    p.exact(value, [
        "poolManifestFingerprint", "pinnedSnapshotId", "policyFingerprint", "pairedFactsFingerprint",
        "bootstrapSeed", "bootstrapResamples", "minimumAnalyzableFamilyCount", "analyzableFamilyCount",
        "evidenceSufficient", "endpoints", "liveRegret", "providerMixedRegret", "rawRegretRecords",
    ], label);
    const minimumAnalyzableFamilyCount = p.integer(value.minimumAnalyzableFamilyCount, `${label}.minimumAnalyzableFamilyCount`, 1);
    const analyzableFamilyCount = p.integer(value.analyzableFamilyCount, `${label}.analyzableFamilyCount`);
    const evidenceSufficient = p.boolean(value.evidenceSufficient, `${label}.evidenceSufficient`);
    if (evidenceSufficient !== analyzableFamilyCount >= minimumAnalyzableFamilyCount) p.fail(`${label}.evidenceSufficient: derived-mismatch`);
    return {
        poolManifestFingerprint: p.hex64(value.poolManifestFingerprint, `${label}.poolManifestFingerprint`),
        pinnedSnapshotId: p.string(value.pinnedSnapshotId, `${label}.pinnedSnapshotId`),
        policyFingerprint: p.hex64(value.policyFingerprint, `${label}.policyFingerprint`),
        pairedFactsFingerprint: p.hex64(value.pairedFactsFingerprint, `${label}.pairedFactsFingerprint`),
        bootstrapSeed: p.integer(value.bootstrapSeed, `${label}.bootstrapSeed`),
        bootstrapResamples: p.integer(value.bootstrapResamples, `${label}.bootstrapResamples`, 1),
        minimumAnalyzableFamilyCount,
        analyzableFamilyCount,
        evidenceSufficient,
        endpoints: parseEndpointEstimates(value.endpoints, `${label}.endpoints`, PRIMARY_ENDPOINTS),
        liveRegret: parseEndpointEstimates(value.liveRegret, `${label}.liveRegret`, LIVE_REGRET_ENDPOINTS),
        providerMixedRegret: parseEndpointEstimates(value.providerMixedRegret, `${label}.providerMixedRegret`, PROVIDER_MIXED_REGRET_ENDPOINTS),
        rawRegretRecords: p.array(value.rawRegretRecords, `${label}.rawRegretRecords`).map((entry, index) => {
            const itemLabel = `${label}.rawRegretRecords[${index}]`;
            const item = p.record(entry, itemLabel);
            p.exact(item, ["coordinateId", "familyId", "endpoint", "delta", "inferential"], itemLabel);
            if (item.inferential !== false) p.fail(`${itemLabel}.inferential: literal-invalid`);
            return {
                coordinateId: p.string(item.coordinateId, `${itemLabel}.coordinateId`),
                familyId: p.string(item.familyId, `${itemLabel}.familyId`),
                endpoint: p.enumeration(item.endpoint, REGRET_ENDPOINTS, `${itemLabel}.endpoint`),
                delta: finiteNumber(item.delta, `${itemLabel}.delta`),
                inferential: false,
            };
        }),
    };
}

function parseArmMetrics(raw: unknown, label: string, maximum = Number.POSITIVE_INFINITY): ArmMetrics {
    const value = p.record(raw, label);
    const metrics: ArmMetrics = {};
    for (const [armId, metric] of Object.entries(value)) {
        const arm = p.enumeration(armId, ARM_IDS, `${label}.${armId}`);
        const result = nonNegativeNumber(metric, `${label}.${armId}`);
        if (result > maximum) p.fail(`${label}.${armId}: number-invalid`);
        metrics[arm] = result;
    }
    return metrics;
}

function parseCountRecord(raw: unknown, label: string): Record<string, number> {
    const value = p.record(raw, label);
    return Object.fromEntries(
        Object.entries(value).map(([key, count]) => [key, p.integer(count, `${label}.${key}`, 1)]),
    );
}

/** Strict consumer parser: rejects unknown fields at every level and a `reportFingerprint` that does not match the body. */
export function parsePairedDeltaReport(raw: unknown): PairedDeltaReport {
    const root = p.record(raw, "report");
    p.exact(root, ["schema", "body", "reportFingerprint"], "report");
    if (root.schema !== PAIRED_DELTA_REPORT_SCHEMA) p.fail("report.schema: version-invalid");
    const value = p.record(root.body, "report.body");
    p.exact(value, [
        "limitations", "poolManifestFingerprint", "pinnedSnapshotId", "policyFingerprint", "implementationDigest",
        "analysis", "exclusions", "secondaryMetrics", "regret", "runSummary",
    ], "report.body");
    const secondary = p.record(value.secondaryMetrics, "report.body.secondaryMetrics");
    p.exact(secondary, ["invalidSuccessRateByArm", "finalAttemptTokensByArm", "finalAttemptWallClockMsByArm", "finalAttemptTurnsByArm"], "report.body.secondaryMetrics");
    const regret = p.record(value.regret, "report.body.regret");
    p.exact(regret, ["live", "providerMixed", "raw"], "report.body.regret");
    const summary = p.record(value.runSummary, "report.body.runSummary");
    p.exact(summary, [
        "status", "spentUsd", "observedCostRollouts", "estimatedCostRollouts", "refusedRegretLadders",
        "plannedCoordinates", "healthyCoordinates", "evidenceComplete", "calibrationFingerprint",
    ], "report.body.runSummary");
    const body: PairedDeltaReportBody = {
        limitations: p.array(value.limitations, "report.body.limitations")
            .map((line, index) => p.string(line, `report.body.limitations[${index}]`)),
        poolManifestFingerprint: p.hex64(value.poolManifestFingerprint, "report.body.poolManifestFingerprint"),
        pinnedSnapshotId: p.string(value.pinnedSnapshotId, "report.body.pinnedSnapshotId"),
        policyFingerprint: p.hex64(value.policyFingerprint, "report.body.policyFingerprint"),
        implementationDigest: p.string(value.implementationDigest, "report.body.implementationDigest"),
        analysis: parseAnalysis(value.analysis, "report.body.analysis"),
        exclusions: p.array(value.exclusions, "report.body.exclusions").map((entry, index) => {
            const label = `report.body.exclusions[${index}]`;
            const item = p.record(entry, label);
            p.exact(item, ["armId", "reasonCode", "count"], label);
            return {
                armId: p.enumeration(item.armId, ARM_IDS, `${label}.armId`),
                reasonCode: p.enumeration(item.reasonCode, REASON_CODES, `${label}.reasonCode`),
                count: p.integer(item.count, `${label}.count`, 1),
            };
        }),
        secondaryMetrics: {
            invalidSuccessRateByArm: parseArmMetrics(secondary.invalidSuccessRateByArm, "report.body.secondaryMetrics.invalidSuccessRateByArm", 1),
            finalAttemptTokensByArm: parseArmMetrics(secondary.finalAttemptTokensByArm, "report.body.secondaryMetrics.finalAttemptTokensByArm"),
            finalAttemptWallClockMsByArm: parseArmMetrics(secondary.finalAttemptWallClockMsByArm, "report.body.secondaryMetrics.finalAttemptWallClockMsByArm"),
            finalAttemptTurnsByArm: parseArmMetrics(secondary.finalAttemptTurnsByArm, "report.body.secondaryMetrics.finalAttemptTurnsByArm"),
        },
        regret: {
            live: parseEndpointEstimates(regret.live, "report.body.regret.live", LIVE_REGRET_ENDPOINTS),
            providerMixed: parseEndpointEstimates(regret.providerMixed, "report.body.regret.providerMixed", PROVIDER_MIXED_REGRET_ENDPOINTS),
            raw: p.array(regret.raw, "report.body.regret.raw").map((entry, index) => {
                const label = `report.body.regret.raw[${index}]`;
                const item = p.record(entry, label);
                p.exact(item, ["coordinateId", "familyId", "retrieval", "formation", "representation", "label"], label);
                if (item.label !== "raw-non-inferential") p.fail(`${label}.label: literal-invalid`);
                const rung = (field: "retrieval" | "formation" | "representation"): number | null =>
                    item[field] === null ? null : finiteNumber(item[field], `${label}.${field}`);
                return {
                    coordinateId: p.string(item.coordinateId, `${label}.coordinateId`),
                    familyId: p.string(item.familyId, `${label}.familyId`),
                    retrieval: rung("retrieval"),
                    formation: rung("formation"),
                    representation: rung("representation"),
                    label: "raw-non-inferential",
                };
            }),
        },
        runSummary: {
            status: p.enumeration(summary.status, RUN_STATUSES, "report.body.runSummary.status"),
            spentUsd: nonNegativeNumber(summary.spentUsd, "report.body.runSummary.spentUsd"),
            observedCostRollouts: p.integer(summary.observedCostRollouts, "report.body.runSummary.observedCostRollouts"),
            estimatedCostRollouts: p.integer(summary.estimatedCostRollouts, "report.body.runSummary.estimatedCostRollouts"),
            refusedRegretLadders: parseCountRecord(summary.refusedRegretLadders, "report.body.runSummary.refusedRegretLadders"),
            plannedCoordinates: p.integer(summary.plannedCoordinates, "report.body.runSummary.plannedCoordinates"),
            healthyCoordinates: p.integer(summary.healthyCoordinates, "report.body.runSummary.healthyCoordinates"),
            evidenceComplete: p.boolean(summary.evidenceComplete, "report.body.runSummary.evidenceComplete"),
            calibrationFingerprint: summary.calibrationFingerprint === null
                ? null
                : p.hex64(summary.calibrationFingerprint, "report.body.runSummary.calibrationFingerprint"),
        },
    };
    // The fingerprint is an unkeyed digest over the same bytes, so it detects corruption but not a rewritten body.
    if (
        body.analysis.poolManifestFingerprint !== body.poolManifestFingerprint ||
        body.analysis.pinnedSnapshotId !== body.pinnedSnapshotId ||
        body.analysis.policyFingerprint !== body.policyFingerprint
    ) {
        p.fail("report.body.analysis: lane-binding-mismatch");
    }
    p.unique(body.exclusions.map(({ armId, reasonCode }) => `${armId}:${reasonCode}`), "report.body.exclusions");
    if (body.runSummary.healthyCoordinates > body.runSummary.plannedCoordinates) {
        p.fail("report.body.runSummary.healthyCoordinates: integer-invalid");
    }
    if (canonicalFingerprint(body.regret.live) !== canonicalFingerprint(body.analysis.liveRegret)) {
        p.fail("report.body.regret.live: analysis-mismatch");
    }
    if (canonicalFingerprint(body.regret.providerMixed) !== canonicalFingerprint(body.analysis.providerMixedRegret)) {
        p.fail("report.body.regret.providerMixed: analysis-mismatch");
    }
    if (canonicalFingerprint(body.regret.raw) !== canonicalFingerprint(rawRegretLadder(body.analysis.rawRegretRecords))) {
        p.fail("report.body.regret.raw: analysis-mismatch");
    }
    const reportFingerprint = p.hex64(root.reportFingerprint, "report.reportFingerprint");
    if (canonicalFingerprint(body) !== reportFingerprint) p.fail("report.reportFingerprint: fingerprint-mismatch");
    return { schema: PAIRED_DELTA_REPORT_SCHEMA, body, reportFingerprint };
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
    /** A digest of the declared calibration scope, because the manifest digest covers the pool's own files and deliberately excludes the plugin, harness, and live runner. */
    implementationDigest: string;
    pinnedSnapshotId: string;
    runStatus: PairedDeltaRunResult["status"];
    validForPoolSizing: boolean;
    /** Whether any measured series established variance. A constant pilot cannot, and its zero variance would otherwise size the pool at its floor. */
    varianceEstablished: boolean;
    /** Recorded so a reader can recompute `decisions.poolSize` rather than trusting the number beside it. */
    targetMinimumDetectableDelta: number;
    /** Analysable coordinates per scenario. Recorded because a family aggregate cannot show that every scenario in it was executed. */
    scenarioDepth: Record<string, number>;
    measuredCostUsd: number;
    estimatedReserveUsd: number;
    /** Charges from superseded attempts of retried coordinates, which carry no cost source of their own on the surviving record. */
    retrySpendUsd: number;
    /** A retried coordinate keeps prior spend but not prior duration, so this is the surviving attempts' wall clock rather than lifetime wall clock. */
    finalAttemptWallClockMs: number;
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

function coordinateKey(record: RolloutRecord): string {
    return tupleKey(record.scenarioId, String(record.replicateIndex));
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
    implementationDigest: string;
    targetMinimumDetectableDelta: number;
    decisions: Omit<CalibrationDecision, "poolSize">;
}): PairedDeltaCalibrationRecord {
    requireHex64(input.poolManifestFingerprint, "pool-manifest-fingerprint");
    requireHex64(input.policyFingerprint, "policy-fingerprint");
    if (input.implementationDigest.trim().length === 0) {
        throw new Error("paired-delta-calibration: implementation-digest-invalid");
    }
    const analysable = completePrimaryCoordinates(input.records);
    const deltasByCoordinate = coordinateDeltas(input.records, analysable);
    const families = new Set(input.scenarioFamilies.values());
    const bySeries = new Map<string, number[]>();
    const seriesKey = (
        familyId: string,
        endpoint: CalibrationFamilyNoise["endpoint"],
    ): string => tupleKey(familyId, endpoint);
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
        implementationDigest: input.implementationDigest,
        pinnedSnapshotId: input.pinnedSnapshotId,
        runStatus: input.runStatus,
        targetMinimumDetectableDelta: input.targetMinimumDetectableDelta,
        scenarioDepth: Object.fromEntries(
            [...input.scenarioFamilies.keys()]
                .sort(compareCodeUnits)
                .map((scenarioId) => [scenarioId, depthByScenario.get(scenarioId) ?? 0]),
        ),
        /**
         * A series whose observations are identical does not establish zero population variance, it
         * establishes that the pilot was too small to see any. Sizing from that zero would claim the
         * cohort floor supports the preregistered detectable delta.
         */
        varianceEstablished: familyNoise.length > 0 &&
            familyNoise.every(({ variance, observationCount }) =>
                observationCount >= 2 && variance > 0),
        validForPoolSizing: input.runStatus === "completed" &&
            measuredFamilies.size === families.size &&
            depthComplete &&
            familyNoise.length > 0 &&
            familyNoise.every(({ variance, observationCount }) =>
                observationCount >= 2 && variance > 0),
        /** A failed rollout is priced from its worst-case reserve, so those dollars are reported apart from provider-observed spend rather than inflating a measured total that later budgets read. */
        measuredCostUsd: observed.reduce((sum, record) => sum + record.costUsd, 0),
        estimatedReserveUsd: input.records
            .filter(({ costSource }) => costSource === "estimated")
            .reduce((sum, record) => sum + record.costUsd, 0),
        retrySpendUsd: input.records.reduce(
            (sum, record) => sum + record.priorAttemptsCostUsd,
            0,
        ),
        finalAttemptWallClockMs: input.records.reduce(
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

/**
 * Whether a noise row could have come from real observations.
 *
 * A primary endpoint delta is one of `{-1, 0, 1}`, so `n` observations are a count triple over those three values, and the row's spread fixes which values occur: 0 means one value, 1 means two adjacent values, 2 means both endpoints. The sample variance of every such triple is enumerated and the row must match one. A floor alone still admits values between reachable ones — three observations spanning 2 produce only 1 or 4/3, and a claimed 1.01 would clear a floor of 1 and derive a smaller pool than the genuine 4/3 pilot. The relationship is checked rather than the discrete observations retained, since the record is a summary by design. commentlint: allow(JUDGE)
 */
function arithmeticallyReachable(noise: CalibrationFamilyNoise): boolean {
    const n = noise.observationCount;
    if (!Number.isSafeInteger(n) || n < 2) return false;
    if (!Number.isInteger(noise.spread) || noise.spread < 0 || noise.spread > MAX_ENDPOINT_SPREAD) {
        return false;
    }
    if (noise.spread === 0) return noise.variance === 0;
    return reachableVariances(n, noise.spread).some((reachable) =>
        Math.abs(noise.variance - reachable) <= reachable * VARIANCE_TOLERANCE);
}

/**
 * Every sample variance `n` observations in `{-1, 0, 1}` can have at the given spread.
 *
 * Observations are a count triple over the three values, and the sum of squared deviations from the
 * mean is determined by the counts alone, so the set is the image of the admissible triples. Spread
 * 2 needs both endpoints present. Spread 1 uses two adjacent values; `{-1, 0}` and `{0, 1}` are a
 * shift apart and share every variance, so only `{-1, 0}` is enumerated.
 */
function reachableVariances(n: number, spread: number): number[] {
    const variances = new Set<number>();
    for (let low = 1; low <= n - 1; low++) {
        for (let high = 1; low + high <= n; high++) {
            const middle = n - low - high;
            /** Spread 1: `low` at -1, `high` at 0, nothing at 1, so the two must account for every observation. Spread 2: `low` at -1, `middle` at 0, `high` at 1. */
            if (spread === 1 && middle !== 0) continue;
            const counts = spread === 1 ? [low, high, 0] : [low, middle, high];
            const values = [-1, 0, 1];
            const mean = counts.reduce((sum, count, index) => sum + count * values[index]!, 0) / n;
            const squares = counts.reduce(
                (sum, count, index) => sum + count * (values[index]! - mean) ** 2,
                0,
            );
            variances.add(squares / (n - 1));
        }
    }
    return [...variances];
}

/** `{-1, 0, 1}` deltas cannot range wider than 2. */
const MAX_ENDPOINT_SPREAD = 2;

/** Observations per series a reader will enumerate over. At `replicateCount: 3` a family of five scenarios yields 15; the weekly cost budget cannot reach a small fraction of this. */
const MAX_CALIBRATION_OBSERVATIONS = 1_024;

/** Relative slack for the writer's floating-point variance — it sums squared deviations from a rounded mean and can land one ulp off the closed form — and far below the gap between any two reachable variances, which is at least `1/(n(n-1))`. commentlint: allow(JUDGE) */
const VARIANCE_TOLERANCE = 1e-9;

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
    /**
     * The sizing decision is read by comparisons, not by arithmetic that would throw: a missing
     * `poolSize` makes `cohort < undefined` false and a missing `familyCount` makes the per-family
     * requirement `NaN`, so both cohort gates pass silently on a malformed record.
     */
    const decisions = record.decisions as CalibrationDecision | null | undefined;
    if (
        decisions === null ||
        decisions === undefined ||
        typeof decisions !== "object" ||
        !Number.isSafeInteger(decisions.poolSize) ||
        decisions.poolSize < 1 ||
        !Number.isSafeInteger(decisions.familyCount) ||
        decisions.familyCount < 1 ||
        !Number.isSafeInteger(decisions.replicateCount) ||
        decisions.replicateCount < 1 ||
        decisions.cadence !== "weekly-and-release"
    ) {
        throw new Error("paired-delta-calibration: decisions-invalid");
    }
    requireHex64(record.poolManifestFingerprint, "pool-manifest-fingerprint");
    requireHex64(record.policyFingerprint, "policy-fingerprint");
    /**
     * Recomputed rather than trusted: the flag is what the paid-run preflight gates on, and a
     * self-consistently fingerprinted artifact can assert it while carrying a non-completed status,
     * no established variance, or no measured series at all.
     */
    const measured = Array.isArray(record.familyNoise) ? record.familyNoise : [];
    /**
     * Bounded before anything enumerates over it. `reachableVariances` is quadratic in the count,
     * and the record is fingerprint-valid whatever count it claims, so a large safe integer would
     * hold the paid-run preflight in that loop before the depth checks below ever rejected it. A
     * series can hold at most one observation per scenario coordinate, and the record declares
     * those depths itself.
     */
    const declaredDepths = record.scenarioDepth as Record<string, unknown> | null | undefined;
    const maxObservations = declaredDepths !== null && declaredDepths !== undefined &&
            typeof declaredDepths === "object"
        ? Object.values(declaredDepths)
            .filter((count): count is number => Number.isSafeInteger(count) && (count as number) >= 0)
            .reduce((sum, count) => sum + count, 0)
        : 0;
    if (measured.some((noise) =>
        !Number.isSafeInteger(noise.observationCount) || noise.observationCount > maxObservations)) {
        throw new Error("paired-delta-calibration: observation-count-exceeds-depth");
    }
    /** The depth sum is the record's own claim, so it bounds nothing on its own; a fixed ceiling does. `reachableVariances` visits `n²/2` count pairs, and at the ceiling that is about half a million, well inside a preflight's budget and two orders of magnitude above any pilot this lane can afford. commentlint: allow(JUDGE) */
    if (measured.some((noise) => noise.observationCount > MAX_CALIBRATION_OBSERVATIONS)) {
        throw new Error("paired-delta-calibration: observation-count-exceeds-ceiling");
    }
    const families = new Set(measured.map(({ familyId }) => familyId));
    /**
     * Exactly one series per family and endpoint.
     *
     * A repeated row satisfies a coverage test written with `some`, and `calibrationNoiseFloors`
     * emits one floor per row, so the duplicate reaches `estimateFamilyDeltas` — which rejects a
     * repeated key. That rejection lands after the rollouts, leaving a paid run with no report.
     */
    const covered = families.size > 0 &&
        /** The declared family count, so omitting a family — the noisiest one lowers the derived requirement — cannot pass by shrinking the expected set to the rows that remain. */
        families.size === record.decisions?.familyCount &&
        [...families].every((familyId) =>
        PRIMARY_ENDPOINTS.every((endpoint) =>
            measured.filter((noise) =>
                noise.familyId === familyId && noise.endpoint === endpoint).length === 1));
    /** Recomputed from the recorded variance and target delta, so the published decision cannot disagree with the evidence beside it. */
    const derived = typeof record.targetMinimumDetectableDelta === "number" &&
            Number.isFinite(record.targetMinimumDetectableDelta) &&
            record.targetMinimumDetectableDelta > 0 &&
            Number.isSafeInteger(record.decisions?.familyCount) &&
            (record.decisions?.familyCount ?? 0) >= 1
        ? derivePoolSize(
            measured,
            record.targetMinimumDetectableDelta,
            record.decisions.familyCount,
        )
        : null;
    /** The declared depth exactly: `buildCalibrationRecord` records `replicateCount` per scenario, and the decisions check above already refused a count below 1, so a floor here would reject a record the writer built correctly at depth 1. commentlint: allow(JUDGE) */
    const depth = record.decisions.replicateCount;
    /** Per scenario, not per family: a family with two scenarios is satisfied by one of them at full depth if only the aggregate is checked. */
    const perScenario = record.scenarioDepth as Record<string, number> | null | undefined;
    /** Exactly the declared depth, not at least it: the rollout matrix holds `replicateCount` coordinates per scenario and the store keeps one record per coordinate, so a larger depth describes observations the writer cannot have made, and inflating every depth and `observationCount` together clears the family-sum cross-check while the larger `n` admits a smaller variance. commentlint: allow(JUDGE) */
    const depthPerScenario = perScenario !== null && perScenario !== undefined &&
        typeof perScenario === "object" &&
        Object.keys(perScenario).length > 0 &&
        Object.values(perScenario).every((count) =>
            Number.isSafeInteger(count) && count === depth);
    const consistent = record.runStatus === "completed" &&
        record.varianceEstablished === true &&
        depthPerScenario &&
        measured.length > 0 &&
        measured.every((noise) => noise.observationCount >= depth && noise.variance > 0) &&
        measured.every(arithmeticallyReachable) &&
        covered &&
        derived !== null &&
        record.decisions?.poolSize === derived;
    if (record.validForPoolSizing === true && !consistent) {
        throw new Error("paired-delta-calibration: validity-inconsistent");
    }
    if (
        typeof record.pinnedSnapshotId !== "string" ||
        typeof record.policyFingerprint !== "string" ||
        typeof record.implementationDigest !== "string" ||
        record.implementationDigest.trim().length === 0 ||
        typeof record.validForPoolSizing !== "boolean" ||
        typeof record.varianceEstablished !== "boolean" ||
        !Array.isArray(record.familyNoise) ||
        record.familyNoise.some((noise) =>
            typeof noise.familyId !== "string" ||
            /** An unrecognized endpoint keys a floor the estimator never looks up, and the absent-endpoint fallback does not cover it, so the floor is silently dropped. */
            (noise.endpoint !== undefined &&
                !(PRIMARY_ENDPOINTS as readonly string[]).includes(noise.endpoint)) ||
            !Number.isFinite(noise.spread) ||
            /** `familyFloorValue` divides by these, and a non-finite floor silently labels every family outside it, which disables the gate rather than failing. */
            !Number.isSafeInteger(noise.observationCount) ||
            noise.observationCount < 0 ||
            !Number.isFinite(noise.variance) ||
            noise.variance < 0 ||
            !Number.isFinite(noise.interval?.lower) ||
            !Number.isFinite(noise.interval?.upper))
    ) {
        throw new Error("paired-delta-calibration: record-invalid");
    }
    return record;
}

/**
 * The floor is the uncertainty of the family mean, not the observed range.
 *
 * A valid-success delta is one of -1, 0, or 1, so any varying series spans at least 1 while every
 * family point estimate lies within [-1, 1]. A range-based floor would therefore mark every family
 * inside its floor and no endpoint could ever resolve. The half-width of a 95% normal interval on
 * the mean scales with the evidence instead: it shrinks as replicates accumulate, which is the
 * quantity a resolution claim has to clear.
 */
function familyFloorValue(noise: CalibrationFamilyNoise): number {
    if (noise.observationCount < 2 || !(noise.variance > 0)) return 0;
    const value = 1.959964 * Math.sqrt(noise.variance / noise.observationCount);
    /** A non-finite floor would compare false against every point estimate, disabling the gate silently. */
    if (!Number.isFinite(value)) {
        throw new Error(`paired-delta-calibration: floor-invalid-${noise.familyId}`);
    }
    return value;
}

/**
 * One floor per family and endpoint, matching the series each was measured on.
 *
 * Collapsing to a single family floor let a noisy baseline withhold resolution from a stable one,
 * which discarded the endpoint separation the record deliberately keeps.
 */
export function calibrationNoiseFloors(
    record: PairedDeltaCalibrationRecord,
): FamilyNoiseFloor[] {
    return record.familyNoise
        .map(({ familyId, endpoint, ...rest }): FamilyNoiseFloor => {
            const value = familyFloorValue({ familyId, endpoint, ...rest });
            return { familyId, endpoint, value, interval: { lower: 0, upper: value } };
        })
        .sort((left, right) => compareCodeUnits(
            `${left.familyId}:${left.endpoint ?? ""}`,
            `${right.familyId}:${right.endpoint ?? ""}`,
        ));
}
