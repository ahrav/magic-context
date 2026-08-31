/// <reference types="bun-types" />

/**
 * today's incident.
 *
 * Sessions past the execute threshold must materialize a fold.
 * The served wire shrinks, and a materialized m0 is present.
 *
 *
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { RustTestHarness } from "../src/rust-harness";
import { rustPrereqs } from "../src/rust-scenario-support";

describe.skipIf(!rustPrereqs.ok)("rust invariant: fold under pressure", () => {

    let h: RustTestHarness;

    beforeEach(async () => {
        // A 30,000-token context limit and 25% execute threshold force the test session past the execute threshold.
        h = await RustTestHarness.create({
            modelContextLimit: 30_000,
            magicContextConfig: {
                execute_threshold_percentage: 25,
                protected_tags: 1,
                compressor: { enabled: false },
            },
        });
    });

    afterEach(async () => {
        await h?.dispose();
    });

    it(
        "lands a fold when the session grows past the execute threshold (wire shrinks, m0 present)",
        async () => {
            const sessionId = await h.createSession();


            let peakWireBytes = 0;
            for (let i = 1; i <= 10; i += 1) {
                h.mock.setDefault({
                    text: `assistant ${i}`,
                    usage: {
                        input_tokens: 3_000 * i,
                        output_tokens: 20,
                        cache_creation_input_tokens: 2_000,
                    },
                });
                await h.sendPrompt(sessionId, `fold-under-pressure turn ${i}: ${h.ballast(2_500)}`);
                peakWireBytes = Math.max(peakWireBytes, h.lastMainWireBytes());
                await Bun.sleep(200);
            }

            const passes = await h.waitForRustPasses(5);
            const foldPass = passes.find((p) =>
                ["HARD", "EXECUTE", "MIGRATE_HARD"].includes(p.decision.toUpperCase()),
            );
            expect(foldPass).toBeDefined();

            for (let i = 11; i <= 13; i += 1) {
                h.mock.setDefault({
                    text: `post-fold ${i}`,
                    usage: {
                        input_tokens: 8_000,
                        output_tokens: 20,
                        cache_creation_input_tokens: 2_000,
                    },
                });
                await h.sendPrompt(sessionId, `fold-under-pressure turn ${i}: ${h.ballast(300)}`);
                await Bun.sleep(200);
            }
            await Bun.sleep(500);

            const foldedWire = h.lastMainWireSerialized();
            const foldedWireBytes = h.lastMainWireBytes();

            expect(foldedWireBytes).toBeLessThan(peakWireBytes);

            expect(foldedWire).toContain("Rust fold e2e chunk");
            const firstMessage = h.lastMainMessages()[0];
            expect(JSON.stringify(firstMessage)).toContain("<session-history>");
        },
        300_000,
    );
});
