import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { POLICY_OWNER_SCHEMA, type PolicyOwnerDocument } from "../prospective-holdout/contract";
import {
    LANE_IDS,
    LANE_REPORT_SCHEMAS,
    SCORECARD_GATE_IDS,
    SCORECARD_POLICY_OWNER,
    SCORECARD_POLICY_SCHEMA,
    type LaneId,
    type LaneIdentity,
    type ScorecardPolicy,
} from "./policy";

export const PAIRED_DELTA_POLICY_FP = "5".repeat(64);
export const CANARY_SCENARIO_IDS = ["hse-webhook-docs-injection", "hse-orders-key-conflict"];

export function requiredLanesWith(identities: Partial<Record<LaneId, LaneIdentity>> = {}): ScorecardPolicy["requiredLanes"] {
    return LANE_IDS.map((lane) => ({
        lane,
        schema: LANE_REPORT_SCHEMAS[lane],
        identity: identities[lane] ?? { kind: "identityless" },
    }));
}

export function policyFixture(overrides: Partial<ScorecardPolicy> = {}): ScorecardPolicy {
    return {
        schema: SCORECARD_POLICY_SCHEMA,
        primaryEndpoint: "mc-on-vs-mc-off",
        secondaryMetricSlots: ["final-attempt-tokens-mc-on", "final-attempt-wall-clock-ms-mc-on", "final-attempt-turns-mc-on"],
        gates: [...SCORECARD_GATE_IDS],
        injectionCanaryScenarioIds: [...CANARY_SCENARIO_IDS],
        maxToleratedRegressions: 0,
        statisticalComparison: { bootstrapResamples: 2000, noiseFloorSource: "none" },
        modelMatrix: [{ providerId: "anthropic", modelId: "fixture-model", contextLimit: 8192 }],
        replicateCount: 1,
        releaseCostBudgetUsd: 100,
        requiredLanes: requiredLanesWith(),
        requiredMetricSlots: ["valid-success-delta-mc-on-vs-mc-off"],
        pairedDeltaPolicyFingerprint: PAIRED_DELTA_POLICY_FP,
        baselineScorecardReportFingerprint: null,
        ...overrides,
    };
}

export function policyDocumentFixture(policy: ScorecardPolicy = policyFixture()): PolicyOwnerDocument {
    return {
        schema: POLICY_OWNER_SCHEMA,
        owner: SCORECARD_POLICY_OWNER,
        status: "ready",
        policy,
        policyFingerprint: canonicalFingerprint(policy),
    };
}
