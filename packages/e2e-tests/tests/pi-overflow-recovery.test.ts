/// <reference types="bun-types" />

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { PiTestHarness } from "../src/pi-harness";

/**
 *
 *
 */

interface SessionMetaRow {
    needs_emergency_recovery: number | null;
    detected_context_limit: number | null;
    last_context_percentage: number | null;
}

let h: PiTestHarness;

beforeAll(async () => {
    h = await PiTestHarness.create({
        modelContextLimit: 128_000,
        magicContextConfig: {
            execute_threshold_percentage: 40,
        },
    });
});

afterAll(async () => {
    await h.dispose();
});

function readMeta(sessionId: string): SessionMetaRow {
    const row = h
        .contextDb()
        .prepare(
            "SELECT needs_emergency_recovery, detected_context_limit, last_context_percentage FROM session_meta WHERE session_id = ?",
        )
        .get(sessionId) as SessionMetaRow | undefined;
    return row ?? {
        needs_emergency_recovery: null,
        detected_context_limit: null,
        last_context_percentage: null,
    };
}

describe("pi context overflow detection", () => {
    it("persists provider-reported limit and uses it for next-pass pressure", async () => {
        h.mock.reset();

        let shouldOverflow = true;
        h.mock.addMatcher(() => {
            if (shouldOverflow) {
                shouldOverflow = false;
                return {
                    error: {
                        status: 400,
                        type: "invalid_request_error",
                        message:
                            "This model's maximum context length is 120000 tokens. Please reduce the length of the messages.",
                    },
                };
            }

            return {
                text: "ok after overflow",
                usage: {
                    input_tokens: 60_000,
                    output_tokens: 50,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                },
            };
        });

        let sessionId: string | null = null;
        try {
            const turn = await h.sendPrompt("turn that will overflow", { timeoutMs: 30_000 });
            sessionId = turn.sessionId;
        } catch {
            const state = await h.getState();
            sessionId = typeof state.sessionId === "string" ? state.sessionId : null;
        }
        expect(sessionId).toBeTruthy();

        const afterOverflow = await h.waitFor(
            () => {
                const state = readMeta(sessionId!);
                return state.detected_context_limit === 120_000 ? state : false;
            },
            { timeoutMs: 10_000, intervalMs: 100, label: "pi detected_context_limit persisted" },
        );
        expect(afterOverflow.detected_context_limit).toBe(120_000);

        await h.sendPrompt("next turn should use detected limit for pressure math", {
            timeoutMs: 60_000,
            continueSession: true,
        });

        const afterNext = await h.waitFor(
            () => {
                const state = readMeta(sessionId!);
                return state.last_context_percentage === null ? false : state;
            },
            { timeoutMs: 5_000, label: "pi corrected pressure persisted" },
        );

        expect(afterNext.detected_context_limit).toBe(120_000);
        expect(afterNext.last_context_percentage).toBe(53.66342301087579);
    }, 120_000);

    it("does not persist detected_context_limit for non-overflow rate-limit errors", async () => {
        await h.newSession();
        h.mock.reset();
        h.mock.addMatcher(() => ({
            error: {
                status: 429,
                type: "rate_limit_error",
                message: "Rate limit exceeded. Please try again later.",
            },
        }));

        let sessionId: string | null = null;
        try {
            const turn = await h.sendPrompt("this will rate-limit", { timeoutMs: 15_000 });
            sessionId = turn.sessionId;
        } catch {
            const state = await h.getState();
            sessionId = typeof state.sessionId === "string" ? state.sessionId : null;
        }
        expect(sessionId).toBeTruthy();

        await Bun.sleep(1_500);
        expect(readMeta(sessionId!).detected_context_limit ?? 0).toBe(0);
    }, 30_000);
});
