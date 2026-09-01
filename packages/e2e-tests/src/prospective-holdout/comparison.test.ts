import { describe, expect, it } from "bun:test";
import { buildPairedFacts, assertAaSymmetry, type AaPair } from "./comparison";
import type { ProspectiveCellResult } from "./runner";
import { cellResultFixture, closeManifest, freezeManifest } from "./test-fixtures";

function cell(role: "release-n" | "release-n-minus-1", overrides: Partial<ProspectiveCellResult> = {}): ProspectiveCellResult {
    return cellResultFixture(role, overrides);
}

function aa(overrides: Partial<ProspectiveCellResult> = {}): AaPair[] {
    const control = cell("release-n-minus-1", overrides);
    return [{ left: control, right: structuredClone(control) }];
}

describe("paired prospective comparison", () => {
    it("requires symmetric A/A evidence before accepting N/N-1", () => {
        const attempts = [
            { attempt: 0, cell: cell("release-n") },
            { attempt: 0, cell: cell("release-n-minus-1") },
        ];
        expect(() => buildPairedFacts(closeManifest(), attempts, [], 0, freezeManifest())).toThrow(
            /aa-evidence-incomplete/,
        );
        expect(() => buildPairedFacts(
            closeManifest(),
            attempts,
            aa({ productOutcome: "fail", failedChecks: ["check-current"] }).map((pair) => ({
                ...pair,
                right: cell("release-n-minus-1"),
            })),
            0,
            freezeManifest(),
        )).toThrow(/aa-asymmetry/);
    });

    it("accepts A/A rows that list one failure set in a different order", () => {
        const failedChecks = ["check-alpha", "check-beta"];
        const failing = (order: readonly string[]): ProspectiveCellResult =>
            cell("release-n-minus-1", { productOutcome: "fail", failedChecks: [...order] });
        const left = failing(failedChecks);
        const right = failing([...failedChecks].reverse());
        expect(() => assertAaSymmetry(left, right)).not.toThrow();
        // The projection reports the set, so a row naming a different set stays asymmetric.
        expect(() => assertAaSymmetry(left, failing(["check-alpha", "check-gamma"]))).toThrow(
            /aa-asymmetry/,
        );
        expect(left.failedChecks).toEqual(failedChecks);
        expect(() => buildPairedFacts(closeManifest(), [
            { attempt: 0, cell: cell("release-n") },
            { attempt: 0, cell: cell("release-n-minus-1") },
        ], [{ left, right }], 0, freezeManifest())).not.toThrow();
    });

    it("preserves product failures and infrastructure failures as incomplete pairs", () => {
        const product = buildPairedFacts(closeManifest(), [
            { attempt: 0, cell: cell("release-n", { productOutcome: "fail", reasonCode: "product-crash" }) },
            { attempt: 0, cell: cell("release-n-minus-1") },
        ], aa(), 0, freezeManifest());
        expect(product[0]!.status).toBe("complete");
        expect(product[0]!.releaseN.productOutcome).toBe("fail");

        const incomplete = buildPairedFacts(closeManifest(), [
            { attempt: 0, cell: cell("release-n", { runHealth: "timeout", productOutcome: "not-evaluated", reasonCode: "deadline-exceeded" }) },
            { attempt: 0, cell: cell("release-n-minus-1") },
        ], aa(), 0, freezeManifest());
        expect(incomplete[0]!.status).toBe("incomplete");
    });

    it("requires retries to rerun both arms and both arms to use one harness", () => {
        expect(() => buildPairedFacts(closeManifest(), [
            { attempt: 0, cell: cell("release-n") },
            { attempt: 0, cell: cell("release-n-minus-1") },
            { attempt: 1, cell: cell("release-n") },
        ], aa(), 1, freezeManifest())).toThrow(/unpaired-retry/);
        expect(() => buildPairedFacts(closeManifest(), [
            { attempt: 0, cell: cell("release-n") },
            { attempt: 0, cell: cell("release-n-minus-1", { harness: "pi" }) },
        ], aa(), 0, freezeManifest())).toThrow(/pair-binding-mismatch/);
        const control = cell("release-n-minus-1");
        expect(() => assertAaSymmetry(control, structuredClone(control))).not.toThrow();
    });

    it("rejects a retry committed after both arms of the previous attempt completed", () => {
        expect(() => buildPairedFacts(closeManifest(), [
            { attempt: 0, cell: cell("release-n") },
            { attempt: 0, cell: cell("release-n-minus-1") },
            { attempt: 1, cell: cell("release-n", { productOutcome: "fail", failedChecks: ["check-current"] }) },
            { attempt: 1, cell: cell("release-n-minus-1") },
        ], aa(), 1, freezeManifest())).toThrow(/retry-after-completion/);
    });

    it("selects the retry when it reruns an attempt that did not complete", () => {
        const facts = buildPairedFacts(closeManifest(), [
            {
                attempt: 0,
                cell: cell("release-n", {
                    runHealth: "timeout",
                    productOutcome: "not-evaluated",
                    reasonCode: "deadline-exceeded",
                }),
            },
            { attempt: 0, cell: cell("release-n-minus-1") },
            { attempt: 1, cell: cell("release-n", { productOutcome: "fail", failedChecks: ["check-current"] }) },
            { attempt: 1, cell: cell("release-n-minus-1") },
        ], aa(), 1, freezeManifest());
        expect(facts).toHaveLength(1);
        expect(facts[0]!.status).toBe("complete");
        expect(facts[0]!.releaseN.runHealth).toBe("completed");
        expect(facts[0]!.releaseN.productOutcome).toBe("fail");
    });

    it("rejects an attempt sequence with a hole and a coordinate with no committed pair", () => {
        expect(() => buildPairedFacts(closeManifest(), [
            {
                attempt: 0,
                cell: cell("release-n", {
                    runHealth: "timeout",
                    productOutcome: "not-evaluated",
                    reasonCode: "deadline-exceeded",
                }),
            },
            { attempt: 0, cell: cell("release-n-minus-1") },
            { attempt: 2, cell: cell("release-n") },
            { attempt: 2, cell: cell("release-n-minus-1") },
        ], aa(), 2, freezeManifest())).toThrow(/attempt-invalid/);
        expect(() => buildPairedFacts(closeManifest(), [], aa(), 1, freezeManifest())).toThrow(/missing-pair/);
    });
});
