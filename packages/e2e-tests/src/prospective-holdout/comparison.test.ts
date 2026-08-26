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
});
