/// <reference types="bun-types" />

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { RustTestHarness } from "../src/rust-harness";

const prereqs = RustTestHarness.detectPrereqs();

describe.skipIf(!prereqs.ok)("rust-mode lane smoke", () => {
    let h: RustTestHarness;

    beforeAll(async () => {
        h = await RustTestHarness.create({
            modelContextLimit: 100_000,
            magicContextConfig: { execute_threshold_percentage: 40 },
        });
    });

    afterAll(async () => {
        await h?.dispose();
    });

    it("boots Rust mode and transforms a real session through McHostModuleTransport", async () => {
        const sessionId = await h.createSession();

        for (let i = 1; i <= 3; i += 1) {
            h.mock.setDefault({
                text: `assistant ${i}`,
                usage: { input_tokens: 1_000 * i, output_tokens: 20, cache_creation_input_tokens: 500 },
            });
            await h.sendPrompt(sessionId, `turn ${i}: ${h.ballast(400)}`);
        }

        expect(h.mainRequests().length).toBeGreaterThanOrEqual(3);

        const passes = await h.waitFor(
            () => {
                const p = h.readRustPasses();
                return p.length > 0 ? p : null;
            },
            { timeoutMs: 30_000, label: "rust transform pass observed" },
        );
        expect(passes.length).toBeGreaterThan(0);

        const served = h.readRustPasses().filter((p) => p.servedFrom === "transform");
        expect(served.length).toBeGreaterThan(0);

        // healthy module.
        expect(h.readRustPasses().every((p) => p.decision !== "parked")).toBe(true);
    }, 300_000);
});

describe.skipIf(prereqs.ok)("rust-mode lane skip visibility", () => {
    it("prints a skip reason when prerequisites are unmet", () => {        console.log(`[rust-e2e] SKIPPED: ${prereqs.skipReason ?? "unknown reason"}`);
        expect(prereqs.skipReason && prereqs.skipReason.length > 0).toBe(true);
    });
});
