import { describe, expect, it } from "bun:test";
import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { GATE_SOURCES, evaluateGates, hardGateFailures } from "./gates";
import { SCORECARD_GATE_IDS } from "./policy";
import { bundleFixture, metamorphicReportFixture } from "./test-fixtures";

describe("evaluateGates", () => {
    it("passes the injection gate when every pre-registered canary scenario is covered and no canary hit", () => {
        const bundle = bundleFixture();
        const rows = evaluateGates(bundle);
        expect(rows.map((row) => row.gateId)).toEqual([...SCORECARD_GATE_IDS]);
        const injection = rows.find((row) => row.gateId === "gate-injection-promoted")!;
        expect(injection).toEqual({
            gateId: "gate-injection-promoted",
            status: "passed",
            observedCount: 0,
            evidenceFingerprint: canonicalFingerprint(metamorphicReportFixture()),
            sourceLane: "metamorphic",
            diagnostic: null,
        });
        const unproduced = rows.filter((row) => row.gateId !== "gate-injection-promoted");
        expect(unproduced).toHaveLength(4);
        for (const row of unproduced) {
            expect(row).toMatchObject({ status: "not-observed", observedCount: null, evidenceFingerprint: null, sourceLane: null, diagnostic: "no-producing-lane" });
        }
        expect(hardGateFailures(rows)).toEqual(unproduced.map((row) => row.gateId).sort());
    });

    it("fails the injection gate on a canary hit with the observed count", () => {
        const metamorphic = metamorphicReportFixture({
            injectionCanaryHits: [{ scenarioId: "hse-webhook-docs-injection", role: "derivative", transformId: "reorder-independent-turns", transformVersion: 1, seed: 0 }],
        });
        const rows = evaluateGates(bundleFixture({ lanes: { metamorphic } }));
        expect(rows.find((row) => row.gateId === "gate-injection-promoted")).toMatchObject({
            status: "failed",
            observedCount: 1,
            evidenceFingerprint: canonicalFingerprint(metamorphic),
        });
        expect(hardGateFailures(rows)).toContain("gate-injection-promoted");
    });

    it("reports incomplete canary coverage and a non-present lane as not-observed", () => {
        const partial = evaluateGates(bundleFixture({ lanes: { metamorphic: metamorphicReportFixture({ coveredScenarioIds: ["hse-webhook-docs-injection"] }) } }));
        expect(partial.find((row) => row.gateId === "gate-injection-promoted")).toMatchObject({ status: "not-observed", diagnostic: "canary-coverage-incomplete", observedCount: null });
        for (const status of ["missing", "incomplete", "schema-mismatch"] as const) {
            const rows = evaluateGates(bundleFixture({ statuses: { metamorphic: status } }));
            expect(rows.find((row) => row.gateId === "gate-injection-promoted")).toMatchObject({ status: "not-observed", diagnostic: "lane-not-present" });
        }
    });

    it("maps a throwing extractor to errored without copying the message, leaving other gates untouched", () => {
        const bundle = bundleFixture();
        const poisoned = structuredClone(bundle);
        const metamorphic = poisoned.lanes.find((lane) => lane.lane === "metamorphic")!;
        Object.defineProperty(metamorphic, "report", {
            get() {
                throw new Error("secret /home/operator/path");
            },
        });
        const rows = evaluateGates(poisoned);
        const injection = rows.find((row) => row.gateId === "gate-injection-promoted")!;
        expect(injection).toEqual({ gateId: "gate-injection-promoted", status: "errored", observedCount: null, evidenceFingerprint: null, sourceLane: null, diagnostic: "extractor-threw" });
        expect(JSON.stringify(rows)).not.toContain("operator");
        expect(rows.filter((row) => row.status === "not-observed")).toHaveLength(4);
        expect(hardGateFailures(rows)).toHaveLength(5);
    });

    it("keeps exactly one producer entry per gate id", () => {
        expect(Object.keys(GATE_SOURCES).sort()).toEqual([...SCORECARD_GATE_IDS].sort());
        expect(Object.values(GATE_SOURCES).filter((source) => source !== null)).toHaveLength(1);
    });
});
