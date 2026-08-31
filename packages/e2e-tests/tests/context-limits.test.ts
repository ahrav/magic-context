/// <reference types="bun-types" />

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { TestHarness } from "../src/harness";

/**
 *
 *
 */

let h: TestHarness;

beforeAll(async () => {
    h = await TestHarness.create({
        magicContextConfig: {
            execute_threshold_percentage: 80,
        },
        modelContextLimit: 50_000,
    });
});

afterAll(async () => {
    await h.dispose();
});

describe("context-limit resolution", () => {
    it("uses custom provider limit.context when computing percentage", async () => {
        h.mock.reset();
        h.mock.setDefault({
            text: "ok",
            usage: {
                input_tokens: 20_000,
                output_tokens: 50,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
            },
        });

        const sessionId = await h.createSession();
        await h.sendPrompt(sessionId, "probe turn for context-limit resolution.");

        await Bun.sleep(300);

        const row = h
            .contextDb()
            .prepare("SELECT last_context_percentage FROM session_meta WHERE session_id = ?")
            .get(sessionId) as { last_context_percentage: number } | null;

        const pct = row?.last_context_percentage ?? 0;
        console.log(
            `[TEST] last_context_percentage = ${pct} (expected 47.83773440489858 for 20K/41,808)`,
        );

        expect(pct).toBe(47.83773440489858);
    }, 60_000);
});
