import { describe, expect, it } from "bun:test";
import { buildPairedFacts, assertAaSymmetry } from "./comparison";
import type { ProspectiveCellResult } from "./runner";
import { cellResultFixture, closeManifest, freezeManifest } from "./test-fixtures";

function cell(role: "release-n" | "release-n-minus-1", overrides: Partial<ProspectiveCellResult> = {}): ProspectiveCellResult {
    return cellResultFixture(role, overrides);
}

describe("paired prospective comparison", () => {
    it("preserves product failures and infrastructure failures as incomplete pairs", () => {
        const product = buildPairedFacts(closeManifest(), [
            { attempt: 0, cell: cell("release-n", { productOutcome: "fail", reasonCode: "product-crash" }) },
            { attempt: 0, cell: cell("release-n-minus-1") },
        ], 0, freezeManifest());
        expect(product[0]!.status).toBe("complete");
        expect(product[0]!.releaseN.productOutcome).toBe("fail");

        const incomplete = buildPairedFacts(closeManifest(), [
            { attempt: 0, cell: cell("release-n", { runHealth: "timeout", productOutcome: "not-evaluated", reasonCode: "deadline-exceeded" }) },
            { attempt: 0, cell: cell("release-n-minus-1") },
        ], 0, freezeManifest());
        expect(incomplete[0]!.status).toBe("incomplete");
    });

    it("requires retries to rerun both arms and validates A/A symmetry", () => {
        expect(() => buildPairedFacts(closeManifest(), [
            { attempt: 0, cell: cell("release-n") },
            { attempt: 0, cell: cell("release-n-minus-1") },
            { attempt: 1, cell: cell("release-n") },
        ], 1, freezeManifest())).toThrow(/unpaired-retry/);
        expect(() => assertAaSymmetry(cell("release-n"), cell("release-n-minus-1"))).not.toThrow();
        expect(() => assertAaSymmetry(
            cell("release-n"),
            cell("release-n-minus-1", { productOutcome: "fail", failedChecks: ["check-current"] }),
        )).toThrow(/aa-asymmetry/);
    });
});
