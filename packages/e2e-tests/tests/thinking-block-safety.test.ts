/// <reference types="bun-types" />

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { TestHarness } from "../src/harness";
import {
    driveThinkingDroppedShell,
    driveThinkingImageSurvival,
    driveThinkingNudgeAnchor,
    failedCheckIds,
    THINKING_BLOCK_HARNESS_OPTIONS,
    verifyThinkingDroppedShell,
    verifyThinkingImageSurvival,
    verifyThinkingNudgeAnchor,
} from "../src/incident-pool/scenarios/source-linked-regressions";

/**
 *
 *   "messages.N.content.M: thinking or redacted_thinking blocks in the
 *    latest assistant message cannot be modified. These blocks must remain
 *    as they were in the original response."
 *
 * suite.
 */

const RUST_MODE = process.env.MC_E2E_MODE === "rust";

let h: TestHarness;

beforeAll(async () => {
    h = await TestHarness.create(THINKING_BLOCK_HARNESS_OPTIONS);
});

afterAll(async () => {
    await h.dispose();
});

describe("thinking-block safety (Anthropic 400 regression)", () => {
    describe("Bug A: nudge anchor on a thinking-bearing assistant", () => {
        it("does not inject nudge <instruction> text into an assistant that has a thinking block", async () => {
            const observation = await driveThinkingNudgeAnchor(h, {
                rustMode: RUST_MODE,
            });
            const result = verifyThinkingNudgeAnchor(observation);
            expect(failedCheckIds(result)).toEqual([]);
            expect(result.verdict).toBe("pass");
        }, 90_000);
    });

    describe("Bug B: user-message turn boundary preserved when text tag is dropped", () => {
        it(RUST_MODE
            ? "keeps provider roles safe when whole-arc history supersedes the dropped shell"
            : "keeps the user shell as [dropped §N§] so adjacent assistants are not merged", async () => {
            const observation = await driveThinkingDroppedShell(h, {
                rustMode: RUST_MODE,
            });
            expect(observation.dropEmitted).toBe(true);
            const result = verifyThinkingDroppedShell(observation);
            expect(failedCheckIds(result)).toEqual([]);
            expect(result.verdict).toBe("pass");
        }, 120_000);
    });

    describe("Bug C: file/image part survives when companion text is dropped", () => {
        it(RUST_MODE
            ? "allows whole-arc history to supersede the image without partial stripping"
            : "keeps a user message with an image part even after its text tag is dropped", async () => {
            const observation = await driveThinkingImageSurvival(h, {
                rustMode: RUST_MODE,
            });
            expect(observation.dropEmitted).toBe(true);
            const result = verifyThinkingImageSurvival(observation);
            expect(failedCheckIds(result)).toEqual([]);
            expect(result.verdict).toBe("pass");
        }, 90_000);
    });
});
