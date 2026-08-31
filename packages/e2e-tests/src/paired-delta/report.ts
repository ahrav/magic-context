import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { publishJsonAtomically } from "../incident-pool/report";
import { parsePolicyOwnerDocument } from "../prospective-holdout/contract";
import type { ArmId, ReasonCode } from "./contract";
import type { EndpointEstimate, FamilyDeltaAnalysis } from "./estimator";

export const PAIRED_DELTA_REPORT_SCHEMA = "paired-delta-report/v1";

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
    if (Object.values(metrics).some((value) =>
        value === undefined || !Number.isFinite(value) || value < 0)) {
        throw new Error("paired-delta-report: metric-invalid");
    }
    return Object.fromEntries(
        Object.entries(metrics).sort(([left], [right]) => compareCodeUnits(left, right)),
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
    const exclusions = [...input.exclusions].sort((left, right) => compareCodeUnits(
        `${left.armId}:${left.reasonCode}`,
        `${right.armId}:${right.reasonCode}`,
    ));
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
            raw: [...input.rawRegretRecords].sort((left, right) =>
                compareCodeUnits(left.coordinateId, right.coordinateId)),
        },
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
