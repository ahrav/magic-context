import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalFingerprint, canonicalJson } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { scanForSensitiveContent } from "../../../plugin/scripts/retrieval-benchmark/privacy";
import { parsePairedDeltaPolicy } from "../paired-delta/contract";
import { parsePolicyOwnerDocument } from "../prospective-holdout/contract";
import { validateFreezePolicies } from "../prospective-holdout/freeze";
import { freezeManifest, readyPolicies } from "../prospective-holdout/test-fixtures";
import {
    METRIC_SLOT_IDS,
    PRIMARY_ENDPOINT_SLOTS,
    SCORECARD_GATE_IDS,
    SCORECARD_POLICY_OWNER,
    SCORECARD_POLICY_SCHEMA,
    ScorecardContractError,
    parseScorecardPolicy,
    scorecardPolicyFingerprint,
    type MetricSlotId,
    type ScorecardPolicy,
} from "./policy";
import { PAIRED_DELTA_POLICY_FP, policyDocumentFixture, policyFixture, requiredLanesWith } from "./test-fixtures";

const COMMITTED_POLICY_PATH = join(import.meta.dir, "..", "..", "prospective-holdout", "policies", "scorecard-policy.json");
const PAIRED_DELTA_POLICY_PATH = join(import.meta.dir, "..", "..", "pools", "paired-delta-policy.json");
const PAIRED_DELTA_POLICY_OWNER = "magic-context-x4l.14";

function expectRejects(raw: unknown, code: string): void {
    expect(() => parseScorecardPolicy(raw)).toThrow(new RegExp(code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    expect(() => parseScorecardPolicy(raw)).toThrow(ScorecardContractError);
}

describe("parseScorecardPolicy", () => {
    it("round-trips a valid policy through canonical JSON with a stable fingerprint", () => {
        const policy = policyFixture();
        const parsed = parseScorecardPolicy(JSON.parse(canonicalJson(policy)));
        expect(parsed).toEqual(policy);
        expect(scorecardPolicyFingerprint(parsed)).toBe(canonicalFingerprint(policy));
        expect(scorecardPolicyFingerprint(parseScorecardPolicy(structuredClone(policy)))).toBe(scorecardPolicyFingerprint(parsed));
    });

    it("rejects a missing or extra top-level key and an undefined field", () => {
        const { replicateCount: _dropped, ...missing } = policyFixture();
        expectRejects(missing, "policy: fields-invalid");
        expectRejects({ ...policyFixture(), weighting: 1 }, "policy: fields-invalid");
        expectRejects({ ...policyFixture(), replicateCount: undefined }, "policy.replicateCount: integer-invalid");
    });

    it("requires the exact five gate ids in order", () => {
        const [first, ...rest] = SCORECARD_GATE_IDS;
        expectRejects(policyFixture({ gates: [...rest, first] as never }), "policy.gates: exact-gate-set-required");
        expectRejects(policyFixture({ gates: [...rest] as never }), "policy.gates: exact-gate-set-required");
        expectRejects(policyFixture({ gates: [...rest, "gate-unknown"] as never }), "policy.gates: exact-gate-set-required");
    });

    it("validates lane identities per lane kind", () => {
        expectRejects(
            policyFixture({ requiredLanes: requiredLanesWith({ historian: { kind: "signature" } as never }) }),
            "policy.requiredLanes[1].identity.kind: enum-invalid",
        );
        expectRejects(
            policyFixture({
                requiredLanes: requiredLanesWith({
                    "paired-delta": { kind: "projection", implementationDigest: "abc" } as never,
                }),
            }),
            "policy.requiredLanes[0].identity: fields-invalid",
        );
        expectRejects(
            policyFixture({ requiredLanes: requiredLanesWith({ incident: { kind: "projection" } as never }) }),
            "policy.requiredLanes[4].identity: identity-unsupported",
        );
        const projected = policyFixture({
            requiredLanes: requiredLanesWith({
                "paired-delta": { kind: "projection", implementationDigest: "abc", pinnedSnapshotId: "snap" },
            }),
        });
        expect(parseScorecardPolicy(JSON.parse(canonicalJson(projected)))).toEqual(projected);
    });

    it("requires the full lane set in fixed order with the lane's report schema", () => {
        const lanes = requiredLanesWith();
        expectRejects(policyFixture({ requiredLanes: lanes.slice(1) }), "policy.requiredLanes: exact-lane-set-required");
        expectRejects(policyFixture({ requiredLanes: [...lanes.slice(1), lanes[0]!] }), "policy.requiredLanes: exact-lane-set-required");
        expectRejects(
            policyFixture({ requiredLanes: [{ ...lanes[0]!, schema: "paired-delta-report/v0" }, ...lanes.slice(1)] }),
            "policy.requiredLanes[0].schema: version-invalid",
        );
    });

    it("rejects unknown metric slot ids and non-utility secondary slots", () => {
        expectRejects(policyFixture({ requiredMetricSlots: ["headline-score" as never] }), "policy.requiredMetricSlots[0]: enum-invalid");
        expectRejects(policyFixture({ secondaryMetricSlots: ["recall-at-10-explicit" as never] }), "policy.secondaryMetricSlots[0]: enum-invalid");
        expect(new Set(METRIC_SLOT_IDS).size).toBe(METRIC_SLOT_IDS.length);
    });

    it("requires the primary endpoint's own delta slot", () => {
        const pairs = Object.entries(PRIMARY_ENDPOINT_SLOTS) as [ScorecardPolicy["primaryEndpoint"], MetricSlotId][];
        for (const [primaryEndpoint, slot] of pairs) {
            const other = METRIC_SLOT_IDS.find((id) => id !== slot)!;
            expectRejects(
                policyFixture({ primaryEndpoint, requiredMetricSlots: [other] }),
                "policy.requiredMetricSlots: primary-endpoint-slot-required",
            );
            expect(parseScorecardPolicy(policyFixture({ primaryEndpoint, requiredMetricSlots: [slot] })).primaryEndpoint)
                .toBe(primaryEndpoint);
        }
    });

    it("requires a hex64 paired-delta binding and allows a null baseline", () => {
        expectRejects(policyFixture({ pairedDeltaPolicyFingerprint: "abc" }), "policy.pairedDeltaPolicyFingerprint: fingerprint-invalid");
        expect(parseScorecardPolicy(policyFixture({ baselineScorecardReportFingerprint: null })).baselineScorecardReportFingerprint).toBeNull();
        expect(parseScorecardPolicy(policyFixture({ baselineScorecardReportFingerprint: PAIRED_DELTA_POLICY_FP })).baselineScorecardReportFingerprint)
            .toBe(PAIRED_DELTA_POLICY_FP);
    });

    it("requires at least one unique canary scenario id from the historian scenario grammar", () => {
        expectRejects(policyFixture({ injectionCanaryScenarioIds: [] }), "policy.injectionCanaryScenarioIds: empty");
        expectRejects(policyFixture({ injectionCanaryScenarioIds: ["hse-a-b", "hse-a-b"] }), "policy.injectionCanaryScenarioIds: duplicate");
        expectRejects(policyFixture({ injectionCanaryScenarioIds: ["hse_webhook_docs_injection"] }), "policy.injectionCanaryScenarioIds[0]: id-invalid");
        expectRejects(policyFixture({ injectionCanaryScenarioIds: ["webhook-docs-injection"] }), "policy.injectionCanaryScenarioIds[0]: id-invalid");
    });
});

describe("committed scorecard policy document", () => {
    const raw = JSON.parse(readFileSync(COMMITTED_POLICY_PATH, "utf8")) as unknown;

    it("is a ready policy-owner document that parses and passes the privacy scan", () => {
        expect(scanForSensitiveContent(raw)).toEqual([]);
        const document = parsePolicyOwnerDocument(raw, SCORECARD_POLICY_OWNER);
        expect(document.status).toBe("ready");
        const policy = parseScorecardPolicy(document.policy);
        expect(policy.schema).toBe(SCORECARD_POLICY_SCHEMA);
        expect(document.policyFingerprint).toBe(scorecardPolicyFingerprint(policy));
        expect(policy.baselineScorecardReportFingerprint).toBeNull();
    });

    it("binds the committed paired-delta policy and restates its matrix, replicate count, and release budget", () => {
        const pairedDeltaRaw = JSON.parse(readFileSync(PAIRED_DELTA_POLICY_PATH, "utf8")) as unknown;
        const pairedDeltaDocument = parsePolicyOwnerDocument(pairedDeltaRaw, PAIRED_DELTA_POLICY_OWNER);
        expect(pairedDeltaDocument.status).toBe("ready");
        const pairedDelta = parsePairedDeltaPolicy(pairedDeltaDocument.policy);
        const policy = parseScorecardPolicy(parsePolicyOwnerDocument(raw, SCORECARD_POLICY_OWNER).policy);
        expect(pairedDeltaDocument.policyFingerprint).not.toBeNull();
        expect(policy.pairedDeltaPolicyFingerprint).toBe(pairedDeltaDocument.policyFingerprint!);
        expect(policy.modelMatrix).toEqual(pairedDelta.modelMatrix);
        expect(policy.replicateCount).toBe(pairedDelta.replicateCount);
        expect(policy.releaseCostBudgetUsd).toBe(pairedDelta.costBudgetUsd.release);
    });

    it("is written as canonical two-space JSON", () => {
        expect(readFileSync(COMMITTED_POLICY_PATH, "utf8")).toBe(`${JSON.stringify(raw, null, 2)}\n`);
    });

    it("is accepted by freeze validation beside a ready analysis policy", () => {
        const scorecard = parsePolicyOwnerDocument(raw, SCORECARD_POLICY_OWNER);
        const freeze = freezeManifest();
        freeze.body.policies.scorecard = {
            owner: SCORECARD_POLICY_OWNER,
            schemaVersion: SCORECARD_POLICY_SCHEMA,
            policyFingerprint: scorecard.policyFingerprint!,
        };
        expect(() => validateFreezePolicies(freeze, { analysis: readyPolicies().analysis, scorecard })).not.toThrow();
        const fixtureDocument = policyDocumentFixture();
        expect(() => validateFreezePolicies(freeze, { analysis: readyPolicies().analysis, scorecard: fixtureDocument }))
            .toThrow(/fingerprint-mismatch/);
    });
});
