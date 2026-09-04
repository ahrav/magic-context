import { describe, expect, it } from "bun:test";
import { canonicalJson } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { buildScoreFamilies, familyEstimateRows } from "./families";
import { SCORE_FAMILY_IDS, SLOT_CONTRACTS, SLOT_IDS_BY_FAMILY, type MetricSlotId } from "./policy";
import type { MetricSlot } from "./report-contract";
import {
    bundleFixture,
    historianReportFixture,
    incidentReportFixture,
    incidentResultFixture,
    pairedDeltaReportFixture,
    retrievalReportFixture,
    retrievalScenarioFixture,
    scenarioScoreFixture,
} from "./test-fixtures";

function slot(slots: readonly MetricSlot[], id: MetricSlotId): MetricSlot {
    const found = slots.find((entry) => entry.id === id);
    if (found === undefined) throw new Error(`slot ${id} absent`);
    return found;
}

function value(slots: readonly MetricSlot[], id: MetricSlotId): number {
    const found = slot(slots, id);
    if (found.status !== "measured") throw new Error(`slot ${id} is ${found.reason}`);
    return found.value;
}

describe("buildScoreFamilies", () => {
    it("emits every slot of every family in fixed order whatever the lane statuses", () => {
        for (const statuses of [{}, { "paired-delta": "missing" as const }, { historian: "schema-mismatch" as const, retrieval: "incomplete" as const }]) {
            const families = buildScoreFamilies(bundleFixture({ statuses }));
            for (const family of SCORE_FAMILY_IDS) {
                expect(families[family].family).toBe(family);
                expect(families[family].slots.map((entry) => entry.id)).toEqual([...SLOT_IDS_BY_FAMILY[family]]);
            }
        }
    });

    it("marks a missing lane's slots lane-missing and never carries a value key on a not-measured slot", () => {
        const families = buildScoreFamilies(bundleFixture({ statuses: { historian: "missing", retrieval: "schema-mismatch" } }));
        expect(families.formation.slots.every((entry) => entry.status === "not-measured" && entry.reason === "lane-missing")).toBe(true);
        expect(families.retrieval.slots.every((entry) => entry.status === "not-measured" && entry.reason === "lane-missing")).toBe(true);
        for (const entry of families.formation.slots) expect(Object.keys(entry).sort()).toEqual(["id", "reason", "status"]);
    });

    it("lets an incomplete paired-delta lane populate only reliability counts", () => {
        const families = buildScoreFamilies(bundleFixture({ statuses: { "paired-delta": "incomplete" } }));
        expect(families.utility.slots.every((entry) => entry.status === "not-measured" && entry.reason === "lane-incomplete")).toBe(true);
        expect(families.utility.familyEstimates).toEqual([]);
        expect(value(families.reliability.slots, "paired-delta-excluded-cells")).toBe(2);
        expect(value(families.reliability.slots, "paired-delta-planned-coordinates")).toBe(4);
    });

    it("keeps reliability counts unmeasured when an incomplete lane's report may describe another target", () => {
        for (const diagnostics of [["pre-registration-mismatch"], ["run-incomplete", "build-identity-mismatch"]]) {
            const families = buildScoreFamilies(bundleFixture({ statuses: { "paired-delta": "incomplete" }, diagnostics: { "paired-delta": diagnostics } }));
            for (const id of ["paired-delta-excluded-cells", "paired-delta-planned-coordinates", "paired-delta-healthy-coordinates"] as const) {
                expect(slot(families.reliability.slots, id)).toEqual({ id, status: "not-measured", reason: "lane-incomplete" });
            }
        }
    });

    it("marks a slot produced exactly when a present lane set measures it", () => {
        // `produced` must match whether a reader populates the slot; otherwise a policy can require unavailable evidence.
        const families = buildScoreFamilies(bundleFixture());
        for (const family of SCORE_FAMILY_IDS) {
            for (const entry of families[family].slots) {
                const pending = entry.status === "not-measured" && entry.reason === "producer-pending";
                expect([entry.id, SLOT_CONTRACTS[entry.id].produced]).toEqual([entry.id, !pending]);
            }
        }
    });

    it("reads utility deltas, secondary arm metrics, and pending producers from a present paired-delta lane", () => {
        const report = pairedDeltaReportFixture();
        const families = buildScoreFamilies(bundleFixture({ lanes: { "paired-delta": report } }));
        const expected = report.body.analysis.endpoints.find((entry) => entry.endpoint === "mc-on-vs-mc-off")!.pointEstimate;
        expect(slot(families.utility.slots, "valid-success-delta-mc-on-vs-mc-off")).toMatchObject({ status: "measured", value: expected, unit: "delta", sourceLane: "paired-delta" });
        expect(slot(families.utility.slots, "final-attempt-tokens-compaction")).toMatchObject({ status: "measured", value: 900, unit: "tokens" });
        expect(slot(families.utility.slots, "invalid-success-rate-mc-on")).toMatchObject({ value: 0.1, unit: "ratio" });
        expect(slot(families.utility.slots, "valid-failure-rate")).toEqual({ id: "valid-failure-rate", status: "not-measured", reason: "producer-pending" });
        expect(families.utility.familyEstimates).toEqual(familyEstimateRows(report));
        expect(families.utility.familyEstimates.map((row) => `${row.endpoint}/${row.familyId}`)).toEqual([
            "mc-on-vs-compaction/fam-a", "mc-on-vs-compaction/fam-b", "mc-on-vs-mc-off/fam-a", "mc-on-vs-mc-off/fam-b",
        ]);
    });

    it("reads the historian aggregate rates and leaves the per-memory false-authoritative rate to its producer", () => {
        const historian = historianReportFixture([
            scenarioScoreFixture("hse-a", { visibleClaimsTotal: 4 }),
            // One visible claim can match several absent predicates, so summing match ids would overstate this scenario.
            scenarioScoreFixture("hse-b", { verdict: "FAIL", failReasons: ["false-authoritative"], falseAuthoritativeMatches: ["abs-x", "abs-y"], visibleClaimsTotal: 1 }),
            scenarioScoreFixture("hse-c", { verdict: "ERROR", errorReason: "run-never-fired", precision: null, recall: null, visibleClaimsTotal: 100 }),
        ]);
        const families = buildScoreFamilies(bundleFixture({ lanes: { historian } }));
        expect(value(families.formation.slots, "false-authoritative-scenario-rate")).toBeCloseTo(1 / 2);
        expect(value(families.formation.slots, "active-claim-precision")).toBe(historian.aggregate.precision!);
        expect(slot(families.formation.slots, "false-authoritative-memory-rate")).toEqual({ id: "false-authoritative-memory-rate", status: "not-measured", reason: "producer-pending" });
        expect(slot(families.formation.slots, "supersession-latency")).toMatchObject({ status: "not-measured", reason: "producer-pending" });
    });

    it("reads retrieval metrics per query mode over the holdout partition only", () => {
        const retrieval = retrievalReportFixture({
            scenarios: [
                retrievalScenarioFixture("case-1:q-1", { mode: "explicit", metricValue: 1, duplicateRateAt50: 0.5 }),
                retrievalScenarioFixture("case-1:q-2", { mode: "explicit", metricValue: 0.5, duplicateRateAt50: 0.1 }),
                retrievalScenarioFixture("case-1:q-3", { mode: "explicit", partition: "development", metricValue: 0, duplicateRateAt50: 1 }),
                retrievalScenarioFixture("case-1:q-4", { mode: "automatic", metricValue: 0.25, duplicateRateAt50: null }),
            ],
        });
        const families = buildScoreFamilies(bundleFixture({ lanes: { retrieval } }));
        expect(value(families.retrieval.slots, "recall-at-10-explicit")).toBeCloseTo(0.75);
        expect(value(families.retrieval.slots, "duplicate-rate-at-50-explicit")).toBeCloseTo(0.3);
        expect(value(families.retrieval.slots, "ndcg-at-10-automatic")).toBeCloseTo(0.25);
        expect(slot(families.retrieval.slots, "duplicate-rate-at-50-automatic")).toMatchObject({ status: "not-measured", reason: "metric-undefined" });
        expect(slot(families.retrieval.slots, "currentness")).toMatchObject({ reason: "producer-pending" });
        const explicitOnly = retrievalReportFixture({ scenarios: [retrievalScenarioFixture("case-1:q-1", { mode: "explicit" })] });
        const automaticSlots = buildScoreFamilies(bundleFixture({ lanes: { retrieval: explicitOnly } })).retrieval.slots;
        expect(slot(automaticSlots, "recall-at-10-automatic")).toMatchObject({ status: "not-measured", reason: "no-holdout-queries" });
        expect(slot(automaticSlots, "duplicate-rate-at-50-automatic")).toMatchObject({ status: "not-measured", reason: "no-holdout-queries" });
    });

    it("weights the duplicate rate by paraphrase group and drops lane-restricted cases like its sibling slots", () => {
        const retrieval = retrievalReportFixture({
            scenarios: [
                retrievalScenarioFixture("case-1:q-1", { paraphraseGroup: "pg-a", metricValue: 1, duplicateRateAt50: 1 }),
                retrievalScenarioFixture("case-1:q-2", { paraphraseGroup: "pg-a", metricValue: 1, duplicateRateAt50: 1 }),
                retrievalScenarioFixture("case-1:q-3", { paraphraseGroup: "pg-a", metricValue: 1, duplicateRateAt50: 1 }),
                retrievalScenarioFixture("case-1:q-4", { paraphraseGroup: "pg-b", metricValue: 0, duplicateRateAt50: 0 }),
                retrievalScenarioFixture("case-2:q-5", { paraphraseGroup: "pg-c", metricValue: 0, duplicateRateAt50: 0 }),
            ],
            laneRestrictedCaseIds: ["case-2"],
        });
        const families = buildScoreFamilies(bundleFixture({ lanes: { retrieval } }));
        // Micro-averaging over the five queries would give 0.6; the lane's gate policy gives each intent equal weight and excludes case-2.
        expect(value(families.retrieval.slots, "duplicate-rate-at-50-explicit")).toBeCloseTo(0.5);
        expect(value(families.retrieval.slots, "recall-at-10-explicit")).toBeCloseTo(0.5);
    });

    it("rejects a paired-delta estimate family id outside the report contract's id shape", () => {
        const report = structuredClone(pairedDeltaReportFixture());
        report.body.analysis.endpoints[0]!.families[0]!.familyId = "fam a";
        expect(() => buildScoreFamilies(bundleFixture({ lanes: { "paired-delta": report } }))).toThrow(/familyId/);
    });

    it("counts incident-pool results and leaves cross-harness parity to its producer", () => {
        const incident = incidentReportFixture([
            incidentResultFixture(),
            incidentResultFixture({ variant_id: "var-two" }),
            incidentResultFixture({
                variant_id: "var-three",
                behavioral_verdict: "assertion_fail", baseline_comparison: "regression", failed_checks: ["check-a"], observation_signature: "e".repeat(64),
            }),
        ]);
        const families = buildScoreFamilies(bundleFixture({ lanes: { incident } }));
        expect(value(families.reliability.slots, "incident-baseline-mismatches")).toBe(1);
        expect(value(families.reliability.slots, "incident-results-total")).toBe(3);
        expect(slot(families.reliability.slots, "cross-harness-parity-pass-rate")).toEqual({ id: "cross-harness-parity-pass-rate", status: "not-measured", reason: "producer-pending" });
        const defaults = buildScoreFamilies(bundleFixture());
        expect(value(defaults.reliability.slots, "dreamer-runs-total")).toBe(1);
        expect(slot(defaults.context.slots, "ctx-expand-recovery")).toMatchObject({ reason: "producer-pending" });
    });

    it("is byte-stable under permuted input arrays", () => {
        const report = pairedDeltaReportFixture();
        const permuted = structuredClone(report);
        permuted.body.analysis.endpoints.reverse();
        for (const endpoint of permuted.body.analysis.endpoints) endpoint.families.reverse();
        const first = buildScoreFamilies(bundleFixture({ lanes: { "paired-delta": report } }));
        const second = buildScoreFamilies(bundleFixture({ lanes: { "paired-delta": permuted } }));
        // Array order is part of the lane fingerprint, so only the source fingerprint may differ between the two builds.
        const withoutSource = (text: string): string => text.replace(/"sourceFingerprint":"[0-9a-f]{64}"/g, "");
        expect(withoutSource(canonicalJson(second))).toBe(withoutSource(canonicalJson(first)));
        expect(JSON.stringify(second.utility.familyEstimates)).toBe(JSON.stringify(first.utility.familyEstimates));
    });
});
