/// <reference types="bun-types" />

/**
 * Incident regression #1: mid-session message removal wedged the ordinal
 * resolver permanently.
 *
 * The bug: when a message is removed mid-session (session.revert, which opencode
 * emits as `message.removed`), the Rust adapter's ordinal resolver saw the raw
 * array shrink under its stored anchor and entered a permanent mismatch loop —
 * every later pass failed to resolve ordinals and the transform stopped serving
 * (parking the session). The fix is a self-heal re-prime that rebuilds the
 * ordinal map from the durable rows after a removal.
 *
 * The assertion targets the outcome: after a real removal the transform keeps
 * serving and the session never permanently parks.
 *
 * Drives the FULL production path: opencode → plugin → direct mc-host → McHandler.
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

            // Pick a MID-session user message to remove (not newest, not first).
            // Reverting to it drops it and everything after — the exact shape
            // session.revert produces and opencode persists as message.removed.
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
            // Let the async clear-and-reindex settle (the re-prime source).
            await Bun.sleep(2_000);

            const passCountBeforeNext = h.readRustPasses().length;

            // The passes after the removal MUST recover — this is the exact point
            // the old resolver wedged. Drive fresh turns with realistic spacing.
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

            // Outcome invariants (no permanent wedge):
            //  - the session is not permanently parked (the last pass serves), and
            //  - the module resumed real transforms after the removal, proving the
            //    ordinal resolver re-primed rather than looping forever.
            const lastPass = passesAfter.at(-1)!;
            expect(lastPass.decision).not.toBe("parked");
            expect(passesAfter.some((p) => p.servedFrom === "transform")).toBe(true);
        },
        300_000,
    );
});
