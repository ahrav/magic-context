import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { publishJsonAtomically } from "../atomic-publish";
import { parsePolicyOwnerDocument } from "../prospective-holdout/contract";
import { ARM_IDS, REASON_CODES, type ArmId, type ReasonCode } from "./contract";
import type { EndpointEstimate, FamilyDeltaAnalysis, RawRegretRecord } from "./estimator";

export const PAIRED_DELTA_REPORT_SCHEMA = "paired-delta-report/v1";

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

// String `<` compares UTF-16 code units, avoiding locale-dependent `localeCompare` ordering.
function compareCodeUnits(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
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

// The ladder is a pivot of the analyzed records, so published regret values cannot contradict the analysis.
function rawRegretLadder(records: readonly RawRegretRecord[]): RawRegretLadder[] {
    const rows = new Map<string, RawRegretLadder>();
    for (const record of records) {
        const key = `${record.coordinateId}:${record.familyId}`;
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
    const declared = (policyPayload as { minimumAnalyzableFamilyCount?: unknown } | null)
        ?.minimumAnalyzableFamilyCount;
    if (!Number.isSafeInteger(declared) || (declared as number) < 1) {
        throw new Error("paired-delta-report: policy-minimum-family-count-missing");
    }
    if (declared !== analysis.minimumAnalyzableFamilyCount) {
        throw new Error("paired-delta-report: policy-minimum-family-count-mismatch");
    }
}

export function buildPairedDeltaReport(input: {
    poolManifestFingerprint: string;
    pinnedSnapshotId: string;
    policyDocument: unknown;
    analysis: FamilyDeltaAnalysis;
    exclusions: readonly ExclusionCount[];
    secondaryMetrics: SecondaryMetrics;
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
