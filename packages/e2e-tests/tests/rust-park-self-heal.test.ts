/// <reference types="bun-types" />

/**
 *
 *
 *
 *
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { RustTestHarness } from "../src/rust-harness";
import { driveToSteadyState, rustPrereqs } from "../src/rust-scenario-support";

describe.skipIf(!rustPrereqs.ok)("rust incident regression: park self-heal", () => {
    let h: RustTestHarness;

    beforeEach(async () => {
        h = await RustTestHarness.create({
            modelContextLimit: 100_000,
            magicContextConfig: { execute_threshold_percentage: 40, protected_tags: 1 },
        });
    });

    afterEach(async () => {
        await h?.dispose();
    });

    it("recovers after a mid-session module restart without permanent degradation", async () => {
        const sessionId = await h.createSession();
        await driveToSteadyState(h, sessionId, 3);

        const before = h.readRustPasses();
        expect(before.some((p) => p.servedFrom === "transform")).toBe(true);
        const beforeCount = before.length;

        await h.mcHost.restartHost();
        await Bun.sleep(500);

        // At least one post-restart pass must be served from "transform".
        for (let i = 4; i <= 7; i += 1) {
            h.mock.setDefault({
                text: `post-restart assistant ${i}`,
                usage: {
                    input_tokens: 2_000 * i,
                    output_tokens: 20,
                    cache_creation_input_tokens: 1_000,
                },
            });
            await h.sendPrompt(sessionId, `post-restart turn ${i}: ${h.ballast(400)}`);
            await Bun.sleep(300);
        }

        const all = await h.waitForRustPasses(beforeCount + 4);
        const after = all.slice(beforeCount);

        expect(after.some((p) => p.servedFrom === "transform")).toBe(true);
        expect(after.at(-1)!.decision).not.toBe("parked");
    }, 300_000);

    it(
        "un-parks and resumes serving after the module recovers from a prolonged outage",
        async () => {
            const sessionId = await h.createSession();
            await driveToSteadyState(h, sessionId, 3);
            const beforeCount = h.readRustPasses().length;

            await h.mcHost.crashHost();
            for (let i = 4; i <= 8; i += 1) {
                h.mock.setDefault({
                    text: `outage assistant ${i}`,
                    usage: {
                        input_tokens: 2_000 * i,
                        output_tokens: 20,
                        cache_creation_input_tokens: 1_000,
                    },
                });
                await h.sendPrompt(sessionId, `outage turn ${i}: ${h.ballast(400)}`);
                await Bun.sleep(300);
            }

            await h.mcHost.restartHost();
            await Bun.sleep(500);
            for (let i = 9; i <= 18; i += 1) {
                h.mock.setDefault({
                    text: `recovery assistant ${i}`,
                    usage: {
                        input_tokens: 2_000 * i,
                        output_tokens: 20,
                        cache_creation_input_tokens: 1_000,
                    },
                });
                await h.sendPrompt(sessionId, `recovery turn ${i}: ${h.ballast(400)}`);
                await Bun.sleep(300);
            }

            const all = await h.waitForRustPasses(beforeCount + 15);
            const recovery = all.slice(beforeCount + 5);

            expect(recovery.some((p) => p.servedFrom === "transform")).toBe(true);
            expect(recovery.at(-1)!.decision).not.toBe("parked");
        },
        300_000,
    );
});
