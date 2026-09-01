/// <reference types="bun-types" />

/**
 *
 * Across consecutive defer passes, retained provider-request messages must be byte-identical.
 *
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { RustTestHarness, stableSerialize } from "../src/rust-harness";
import { driveToSteadyState, rustPrereqs } from "../src/rust-scenario-support";

describe.skipIf(!rustPrereqs.ok)("rust invariant: steady-state byte identity", () => {
    let h: RustTestHarness;

    beforeAll(async () => {
        h = await RustTestHarness.create({
            modelContextLimit: 100_000,
            magicContextConfig: { execute_threshold_percentage: 40, protected_tags: 1 },
        });
    });

    afterAll(async () => {
        await h?.dispose();
    });

    it("serves byte-identical wire bodies across defer passes with no new content", async () => {
        const sessionId = await h.createSession();
        await driveToSteadyState(h, sessionId, 3);

        // Per-message serialization permits element-wise retained-prefix comparisons.
        // Whole-array serialization changes when a later pass appends a message.
        const perPassMessages: string[][] = [];
        for (let i = 1; i <= 4; i += 1) {
            h.mock.setDefault({
                text: "identical steady reply",
                usage: {
                    input_tokens: 9_000,
                    output_tokens: 20,
                    cache_creation_input_tokens: 1_000,
                },
            });
            await h.sendPrompt(sessionId, `defer probe ${i}: ${h.ballast(150)}`);
            const messages = h.lastMainMessages();
            perPassMessages.push(messages.map((m) => stableSerialize(m)));
        }

        const passes = await h.waitForRustPasses(1);
        expect(passes.every((p) => p.decision !== "error" && p.decision !== "parked")).toBe(true);

        const m0s = perPassMessages.map((msgs) => msgs[0]!);
        for (let i = 1; i < m0s.length; i += 1) {
            expect(m0s[i]).toBe(m0s[0]);
        }

        for (let pass = 1; pass < perPassMessages.length; pass += 1) {
            const earlier = perPassMessages[pass - 1]!;
            const later = perPassMessages[pass]!;
            // The earlier pass's newest message is its live user message, not retained.
            const retained = earlier.length - 1;
            expect(retained).toBeGreaterThan(0);
            for (let index = 0; index < retained; index += 1) {
                expect(later[index]).toBe(earlier[index]);
            }
        }
    }, 300_000);
});
