import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { REPORT_SCHEMA_VERSION as RETRIEVAL_REPORT_SCHEMA, type BenchmarkReport } from "../../../plugin/scripts/retrieval-benchmark/report";
import { GATE_ID_RE, REASON_CODE_RE, makeContractPrimitives, vocabulary } from "../contract-primitives";
import { DREAMER_EVAL_REPORT_SCHEMA } from "../dreamer-eval/contract";
import { SCENARIO_ID_RE } from "../historian-eval/contract";
import type { SystemVersionTuple } from "../historian-eval/runner";
import { LANE_REPORT_SCHEMA as HISTORIAN_REPORT_SCHEMA } from "../historian-eval/scorer";
import { parseSystemVersionTuple } from "../historian-eval/system-tuple";
import { INCIDENT_REPORT_SCHEMA } from "../incident-pool/report";
import { METAMORPHIC_REPORT_SCHEMA } from "../metamorphic-eval/report";
import { PRIMARY_ARM_IDS, type PairedDeltaPolicyModel } from "../paired-delta/contract";
import { PRIMARY_ENDPOINTS, type PrimaryEndpoint } from "../paired-delta/estimator";
import { PAIRED_DELTA_REPORT_SCHEMA, type SecondaryMetrics } from "../paired-delta/report";

export const SCORECARD_POLICY_SCHEMA = "scorecard-policy/v1";
export const SCORECARD_POLICY_OWNER = "magic-context-x4l.15";

export class ScorecardContractError extends Error {
    readonly diagnostics: readonly string[];

    constructor(diagnostics: readonly string[]) {
        super([...diagnostics].sort().join("; "));
        this.name = "ScorecardContractError";
        this.diagnostics = [...diagnostics].sort();
    }
}

const p = makeContractPrimitives(ScorecardContractError);
export const {
    fail,
    record,
    exact,
    string,
    staticId,
    hex64,
    enumeration,
    array,
    number,
    integer,
    unique,
    sorted,
    idArray,
} = p;

export function reasonCode(value: string): string {
    return staticId(value, "reason", REASON_CODE_RE);
}

export const SCORECARD_GATE_IDS = [
    "gate-cross-project-leak",
    "gate-unrelated-scope-secret",
    "gate-injection-promoted",
    "gate-false-enforced-policy",
    "gate-database-corruption",
] as const;
export type GateId = (typeof SCORECARD_GATE_IDS)[number];

export const LANE_IDS = ["paired-delta", "historian", "metamorphic", "dreamer", "incident", "retrieval"] as const;
export type LaneId = (typeof LANE_IDS)[number];

/** The one report schema each lane's strict parser accepts; a policy row naming another literal cannot be dispatched. */
export const LANE_REPORT_SCHEMAS: Readonly<Record<LaneId, string>> = {
    "paired-delta": PAIRED_DELTA_REPORT_SCHEMA,
    historian: HISTORIAN_REPORT_SCHEMA,
    metamorphic: METAMORPHIC_REPORT_SCHEMA,
    dreamer: DREAMER_EVAL_REPORT_SCHEMA,
    incident: INCIDENT_REPORT_SCHEMA,
    retrieval: RETRIEVAL_REPORT_SCHEMA,
};

export const SCORE_FAMILY_IDS = ["utility", "formation", "retrieval", "context", "reliability"] as const;
export type ScoreFamilyId = (typeof SCORE_FAMILY_IDS)[number];

export const UTILITY_SLOT_IDS = [
    "valid-success-delta-mc-on-vs-mc-off",
    "valid-success-delta-mc-on-vs-compaction",
    "valid-failure-rate",
    "invalid-failure-rate",
    "invalid-success-rate-mc-on",
    "invalid-success-rate-mc-off",
    "invalid-success-rate-compaction",
    "final-attempt-tokens-mc-on",
    "final-attempt-tokens-mc-off",
    "final-attempt-tokens-compaction",
    "final-attempt-wall-clock-ms-mc-on",
    "final-attempt-wall-clock-ms-mc-off",
    "final-attempt-wall-clock-ms-compaction",
    "final-attempt-turns-mc-on",
    "final-attempt-turns-mc-off",
    "final-attempt-turns-compaction",
] as const;
export const FORMATION_SLOT_IDS = [
    "active-claim-precision",
    "active-claim-recall",
    "false-authoritative-scenario-rate",
    "false-authoritative-memory-rate",
    "supersession-latency",
    "pollution-duplication",
] as const;
export const RETRIEVAL_SLOT_IDS = [
    "recall-at-10-explicit",
    "recall-at-50-explicit",
    "reciprocal-rank-explicit",
    "ndcg-at-10-explicit",
    "duplicate-rate-at-50-explicit",
    "recall-at-10-automatic",
    "recall-at-50-automatic",
    "reciprocal-rank-automatic",
    "ndcg-at-10-automatic",
    "duplicate-rate-at-50-automatic",
    "currentness",
    "rejection-recall",
    "literal-recall",
    "abstention-accuracy",
] as const;
export const CONTEXT_SLOT_IDS = [
    "post-compaction-probe-accuracy",
    "ctx-expand-recovery",
    "input-token-reduction",
    "cache-write-preservation",
] as const;
export const RELIABILITY_SLOT_IDS = [
    "paired-delta-planned-coordinates",
    "paired-delta-healthy-coordinates",
    "paired-delta-excluded-cells",
    "incident-results-total",
    "incident-results-unhealthy",
    "incident-baseline-mismatches",
    "cross-harness-parity-pass-rate",
    "dreamer-runs-total",
    "dreamer-runs-not-passed",
    "restart-scenarios",
    "contention-failures",
] as const;

export const SLOT_IDS_BY_FAMILY = {
    utility: UTILITY_SLOT_IDS,
    formation: FORMATION_SLOT_IDS,
    retrieval: RETRIEVAL_SLOT_IDS,
    context: CONTEXT_SLOT_IDS,
    reliability: RELIABILITY_SLOT_IDS,
} as const satisfies Record<ScoreFamilyId, readonly string[]>;

export type UtilitySlotId = (typeof UTILITY_SLOT_IDS)[number];
export type MetricSlotId = (typeof SLOT_IDS_BY_FAMILY)[ScoreFamilyId][number];
export const METRIC_SLOT_IDS: readonly MetricSlotId[] = SCORE_FAMILY_IDS.flatMap((family) => SLOT_IDS_BY_FAMILY[family]);

export const PRIMARY_ENDPOINT_SLOTS: Readonly<Record<PrimaryEndpoint, UtilitySlotId>> = {
    "mc-on-vs-mc-off": "valid-success-delta-mc-on-vs-mc-off",
    "mc-on-vs-compaction": "valid-success-delta-mc-on-vs-compaction",
};

export type PrimaryArmId = (typeof PRIMARY_ARM_IDS)[number];
export type SecondaryMetricKey = keyof SecondaryMetrics;

/** Which paired-delta arm metric each per-arm utility slot reads. */
export const SECONDARY_SLOT_SOURCES: Readonly<Partial<Record<UtilitySlotId, { metric: SecondaryMetricKey; arm: PrimaryArmId }>>> = {
    "invalid-success-rate-mc-on": { metric: "invalidSuccessRateByArm", arm: "mc-on" },
    "invalid-success-rate-mc-off": { metric: "invalidSuccessRateByArm", arm: "mc-off" },
    "invalid-success-rate-compaction": { metric: "invalidSuccessRateByArm", arm: "compaction" },
    "final-attempt-tokens-mc-on": { metric: "finalAttemptTokensByArm", arm: "mc-on" },
    "final-attempt-tokens-mc-off": { metric: "finalAttemptTokensByArm", arm: "mc-off" },
    "final-attempt-tokens-compaction": { metric: "finalAttemptTokensByArm", arm: "compaction" },
    "final-attempt-wall-clock-ms-mc-on": { metric: "finalAttemptWallClockMsByArm", arm: "mc-on" },
    "final-attempt-wall-clock-ms-mc-off": { metric: "finalAttemptWallClockMsByArm", arm: "mc-off" },
    "final-attempt-wall-clock-ms-compaction": { metric: "finalAttemptWallClockMsByArm", arm: "compaction" },
    "final-attempt-turns-mc-on": { metric: "finalAttemptTurnsByArm", arm: "mc-on" },
    "final-attempt-turns-mc-off": { metric: "finalAttemptTurnsByArm", arm: "mc-off" },
    "final-attempt-turns-compaction": { metric: "finalAttemptTurnsByArm", arm: "compaction" },
};

export const NOISE_FLOOR_SOURCES = ["calibration", "none"] as const;
export type NoiseFloorSource = (typeof NOISE_FLOOR_SOURCES)[number];

export type PolicyModel = PairedDeltaPolicyModel;

export type SystemProjection = SystemVersionTuple;

export type ReleaseFingerprintsProjection = BenchmarkReport["semantic"]["releaseFingerprints"];

const RELEASE_FINGERPRINTS_KEYS = vocabulary<keyof ReleaseFingerprintsProjection>({
    corpus: true,
    judgments: true,
    syntheticProfiles: true,
    manifest: true,
});

export type LaneIdentity =
    | { kind: "identityless" }
    | { kind: "projection"; implementationDigest: string; pinnedSnapshotId: string }
    | { kind: "projection"; system: SystemProjection }
    | { kind: "projection"; releaseFingerprints: ReleaseFingerprintsProjection };

export interface RequiredLane {
    lane: LaneId;
    schema: string;
    identity: LaneIdentity;
}

export interface ScorecardPolicy {
    schema: typeof SCORECARD_POLICY_SCHEMA;
    primaryEndpoint: PrimaryEndpoint;
    secondaryMetricSlots: UtilitySlotId[];
    gates: GateId[];
    injectionCanaryScenarioIds: string[];
    maxToleratedRegressions: number;
    statisticalComparison: { bootstrapResamples: number; noiseFloorSource: NoiseFloorSource };
    modelMatrix: PolicyModel[];
    replicateCount: number;
    releaseCostBudgetUsd: number;
    requiredLanes: RequiredLane[];
    requiredMetricSlots: MetricSlotId[];
    pairedDeltaPolicyFingerprint: string;
    baselineScorecardReportFingerprint: string | null;
}

export const SCORECARD_POLICY_KEYS = [
    "schema",
    "primaryEndpoint",
    "secondaryMetricSlots",
    "gates",
    "injectionCanaryScenarioIds",
    "maxToleratedRegressions",
    "statisticalComparison",
    "modelMatrix",
    "replicateCount",
    "releaseCostBudgetUsd",
    "requiredLanes",
    "requiredMetricSlots",
    "pairedDeltaPolicyFingerprint",
    "baselineScorecardReportFingerprint",
] as const;

function positiveNumber(value: unknown, label: string): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) fail(`${label}: positive-number-required`);
    return value as number;
}

function nullableHex64(value: unknown, label: string): string | null {
    return value === null ? null : hex64(value, label);
}

function exactIdSequence<T extends string>(raw: unknown, expected: readonly T[], label: string, code: string): T[] {
    const values = array(raw, label).map((entry, index) => string(entry, `${label}[${index}]`));
    if (values.length !== expected.length || values.some((value, index) => value !== expected[index])) fail(`${label}: ${code}`);
    return [...expected];
}

function parseSystemProjection(raw: unknown, label: string): SystemProjection {
    return parseSystemVersionTuple(p, raw, label) ?? fail(`${label}: object-required`);
}

export function parseLaneIdentity(raw: unknown, lane: LaneId, label: string): LaneIdentity {
    const value = record(raw, label);
    const kind = enumeration(value.kind, ["identityless", "projection"] as const, `${label}.kind`);
    if (kind === "identityless") {
        exact(value, ["kind"], label);
        return { kind };
    }
    switch (lane) {
        case "paired-delta":
            exact(value, ["kind", "implementationDigest", "pinnedSnapshotId"], label);
            return {
                kind,
                implementationDigest: string(value.implementationDigest, `${label}.implementationDigest`),
                pinnedSnapshotId: string(value.pinnedSnapshotId, `${label}.pinnedSnapshotId`),
            };
        case "historian":
        case "metamorphic":
            exact(value, ["kind", "system"], label);
            return { kind, system: parseSystemProjection(value.system, `${label}.system`) };
        case "retrieval": {
            exact(value, ["kind", "releaseFingerprints"], label);
            const fingerprints = record(value.releaseFingerprints, `${label}.releaseFingerprints`);
            exact(fingerprints, RELEASE_FINGERPRINTS_KEYS, `${label}.releaseFingerprints`);
            return {
                kind,
                releaseFingerprints: {
                    corpus: hex64(fingerprints.corpus, `${label}.releaseFingerprints.corpus`),
                    judgments: hex64(fingerprints.judgments, `${label}.releaseFingerprints.judgments`),
                    syntheticProfiles: hex64(fingerprints.syntheticProfiles, `${label}.releaseFingerprints.syntheticProfiles`),
                    manifest: hex64(fingerprints.manifest, `${label}.releaseFingerprints.manifest`),
                },
            };
        }
        case "dreamer":
        case "incident":
            return fail(`${label}: identity-unsupported`);
    }
}

function parseRequiredLanes(raw: unknown, label: string): RequiredLane[] {
    const rows = array(raw, label).map((entry, index) => {
        const rowLabel = `${label}[${index}]`;
        const value = record(entry, rowLabel);
        exact(value, ["lane", "schema", "identity"], rowLabel);
        const lane = enumeration(value.lane, LANE_IDS, `${rowLabel}.lane`);
        if (value.schema !== LANE_REPORT_SCHEMAS[lane]) fail(`${rowLabel}.schema: version-invalid`);
        return { lane, schema: LANE_REPORT_SCHEMAS[lane], identity: parseLaneIdentity(value.identity, lane, `${rowLabel}.identity`) };
    });
    if (rows.length !== LANE_IDS.length || rows.some((row, index) => row.lane !== LANE_IDS[index])) fail(`${label}: exact-lane-set-required`);
    return rows;
}

function parseModelMatrix(raw: unknown, label: string): PolicyModel[] {
    const models = array(raw, label).map((entry, index) => {
        const modelLabel = `${label}[${index}]`;
        const value = record(entry, modelLabel);
        exact(value, ["providerId", "modelId", "contextLimit"], modelLabel);
        return {
            providerId: string(value.providerId, `${modelLabel}.providerId`),
            modelId: string(value.modelId, `${modelLabel}.modelId`),
            contextLimit: integer(value.contextLimit, `${modelLabel}.contextLimit`, 1),
        };
    });
    if (models.length === 0) fail(`${label}: empty`);
    // A repeated provider/model identity runs that model more times than `replicateCount` states.
    unique(models.map((model) => `${model.providerId}\u0000${model.modelId}`), label);
    return models;
}

export function parseScorecardPolicy(raw: unknown): ScorecardPolicy {
    const root = record(raw, "policy");
    exact(root, SCORECARD_POLICY_KEYS, "policy");
    if (root.schema !== SCORECARD_POLICY_SCHEMA) fail("policy.schema: version-invalid");
    const comparison = record(root.statisticalComparison, "policy.statisticalComparison");
    exact(comparison, ["bootstrapResamples", "noiseFloorSource"], "policy.statisticalComparison");
    const canaryIds = idArray(root.injectionCanaryScenarioIds, "policy.injectionCanaryScenarioIds", SCENARIO_ID_RE);
    if (canaryIds.length === 0) fail("policy.injectionCanaryScenarioIds: empty");
    const secondaryMetricSlots = idArray(root.secondaryMetricSlots, "policy.secondaryMetricSlots", REASON_CODE_RE)
        .map((slot, index) => enumeration(slot, UTILITY_SLOT_IDS, `policy.secondaryMetricSlots[${index}]`));
    if (secondaryMetricSlots.some((slot) => SECONDARY_SLOT_SOURCES[slot] === undefined)) fail("policy.secondaryMetricSlots: not-secondary");
    const requiredMetricSlots = idArray(root.requiredMetricSlots, "policy.requiredMetricSlots", REASON_CODE_RE)
        .map((slot, index) => enumeration(slot, METRIC_SLOT_IDS, `policy.requiredMetricSlots[${index}]`));
    const primaryEndpoint = enumeration(root.primaryEndpoint, PRIMARY_ENDPOINTS, "policy.primaryEndpoint");
    // Promotion reads the primary endpoint's delta, so a policy that does not require that slot
    // pre-registers a decision on a metric the evidence is allowed to omit.
    if (!requiredMetricSlots.includes(PRIMARY_ENDPOINT_SLOTS[primaryEndpoint])) {
        fail("policy.requiredMetricSlots: primary-endpoint-slot-required");
    }
    return {
        schema: SCORECARD_POLICY_SCHEMA,
        primaryEndpoint,
        secondaryMetricSlots,
        gates: exactIdSequence(root.gates, SCORECARD_GATE_IDS, "policy.gates", "exact-gate-set-required"),
        injectionCanaryScenarioIds: canaryIds,
        maxToleratedRegressions: integer(root.maxToleratedRegressions, "policy.maxToleratedRegressions"),
        statisticalComparison: {
            bootstrapResamples: integer(comparison.bootstrapResamples, "policy.statisticalComparison.bootstrapResamples", 1),
            noiseFloorSource: enumeration(comparison.noiseFloorSource, NOISE_FLOOR_SOURCES, "policy.statisticalComparison.noiseFloorSource"),
        },
        modelMatrix: parseModelMatrix(root.modelMatrix, "policy.modelMatrix"),
        replicateCount: integer(root.replicateCount, "policy.replicateCount", 1),
        releaseCostBudgetUsd: positiveNumber(root.releaseCostBudgetUsd, "policy.releaseCostBudgetUsd"),
        requiredLanes: parseRequiredLanes(root.requiredLanes, "policy.requiredLanes"),
        requiredMetricSlots,
        pairedDeltaPolicyFingerprint: hex64(root.pairedDeltaPolicyFingerprint, "policy.pairedDeltaPolicyFingerprint"),
        baselineScorecardReportFingerprint: nullableHex64(root.baselineScorecardReportFingerprint, "policy.baselineScorecardReportFingerprint"),
    };
}

export function scorecardPolicyFingerprint(policy: ScorecardPolicy): string {
    return canonicalFingerprint(policy);
}

export { GATE_ID_RE, PRIMARY_ARM_IDS, REASON_CODE_RE };
