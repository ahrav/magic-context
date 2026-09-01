/// <reference types="bun-types" />

/**
 * resolver permanently.
 *
 *
 *
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { RustTestHarness } from "../src/rust-harness";
import { driveToSteadyState, rustPrereqs } from "../src/rust-scenario-support";

describe.skipIf(!rustPrereqs.ok)("rust incident regression: removal self-heal", () => {
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

    it(
        "keeps transforming after a mid-session message is removed (no permanent park)",
        async () => {
            const sessionId = await h.createSession();
            await driveToSteadyState(h, sessionId, 4);

            const passesBefore = h.readRustPasses();
            expect(passesBefore.some((p) => p.servedFrom === "transform")).toBe(true);
            expect(passesBefore.every((p) => p.decision !== "error")).toBe(true);

            // Choose a nonterminal user message so `session.revert` deletes later messages.
            // session.revert removes the selected message and every later message.
            const messages = await h.listMessages(sessionId);
            const userIds = messages
                .map((m) => m.info)
                .filter((info): info is { id: string; role: string } =>
                    Boolean(info?.id) && info?.role === "user",
                )
                .map((info) => info.id);
            expect(userIds.length).toBeGreaterThanOrEqual(3);
            const midUserId = userIds[Math.floor(userIds.length / 2)]!;

            await h.revertMessage(sessionId, midUserId);
            await Bun.sleep(2_000);

            const passCountBeforeNext = h.readRustPasses().length;

            for (let i = 6; i <= 10; i += 1) {
                h.mock.setDefault({
                    text: `post-removal assistant ${i}`,
                    usage: {
                        input_tokens: 2_000 * i,
                        output_tokens: 20,
                        cache_creation_input_tokens: 1_000,
                    },
                });
                await h.sendPrompt(sessionId, `post-removal turn ${i}: ${h.ballast(400)}`);
                await Bun.sleep(400);
            }

            const allAfter = await h.waitForRustPasses(passCountBeforeNext + 3);
            const passesAfter = allAfter.slice(passCountBeforeNext);

            const lastPass = passesAfter.at(-1)!;
            expect(lastPass.decision).not.toBe("parked");
            expect(passesAfter.some((p) => p.servedFrom === "transform")).toBe(true);
        },
        300_000,
    );
});
