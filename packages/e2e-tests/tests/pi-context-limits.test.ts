/// <reference types="bun-types" />

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { PiTestHarness } from "../src/pi-harness";

/**
 *
 *
 */

let h: PiTestHarness;

beforeAll(async () => {
    h = await PiTestHarness.create({
        modelContextLimit: 50_000,
        magicContextConfig: {
            execute_threshold_percentage: 80,
        },
    });
});

afterAll(async () => {
    await h.dispose();
});

describe("pi context-limit resolution", () => {
    it("uses Pi model override contextWindow when computing percentage", async () => {
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

        const turn = await h.sendPrompt("probe turn for pi context-limit resolution.", {
            timeoutMs: 60_000,
        });
        expect(turn.sessionId).toBeTruthy();

        const pct = await h.waitFor(
            () => {
                const row = h
                    .contextDb()
                    .prepare("SELECT last_context_percentage FROM session_meta WHERE session_id = ?")
                    .get(turn.sessionId!) as { last_context_percentage: number } | null;
                return row?.last_context_percentage === undefined ? false : row.last_context_percentage;
            },
            { timeoutMs: 5_000, label: "pi last_context_percentage persisted" },
        );

        // The exact pressure is 20,000 / 41,808 × 100 = 47.83773440489858%.
        expect(pct).toBe(47.83773440489858);
    }, 60_000);
});
