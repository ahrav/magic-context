/// <reference types="bun-types" />

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { TestHarness } from "../src/harness";
import { buildMockHistorianPayload } from "../src/mock-historian";
import { FOLD_SKIP_REASON } from "../src/rust-scenario-support";

/**
 *
 * Turn 11 contains 90K tokens to exceed the 40% execution threshold.
 * The 90K-token turn makes the tail eligible at 12 messages.
 *
 * Assertions:
 *
 */

const HISTORIAN_SYSTEM_MARKER = "the hippocampus of a long-running coding agent";

function isHistorianRequest(body: Record<string, unknown>): boolean {
    if (JSON.stringify(body.messages ?? "").includes("<new_messages>")) return true;
    const system = body.system;
    if (typeof system === "string") return system.includes(HISTORIAN_SYSTEM_MARKER);
    if (Array.isArray(system)) {
        for (const block of system) {
            if (block && typeof block === "object") {
                const text = (block as { text?: unknown }).text;
                if (typeof text === "string" && text.includes(HISTORIAN_SYSTEM_MARKER)) {
                    return true;
                }
            }
        }
    }
    return false;
}

/* */
function findOrdinalRange(body: Record<string, unknown>): { start: number; end: number } | null {
    const messages = body.messages as Array<{ role: string; content: unknown }> | undefined;
    if (!messages) return null;
    // Historian sends one user message containing `[n]` lines in `<new_messages>`.
    for (const m of messages) {
        const contentArr = Array.isArray(m.content) ? m.content : [];
        for (const block of contentArr) {
            const text = (block as { text?: string }).text;
            if (!text || !text.includes("<new_messages>")) continue;
            const matches = text.matchAll(/\[(\d+)\]/g);
            const nums: number[] = [];
            for (const mm of matches) nums.push(Number(mm[1]));
            if (nums.length === 0) continue;
            return { start: Math.min(...nums), end: Math.max(...nums) };
        }
    }
    return null;
}

let h: TestHarness;

beforeAll(async () => {
    h = await TestHarness.create({
        magicContextConfig: {
            execute_threshold_percentage: 40,
        },
    });
});

afterAll(async () => {
    await h.dispose();
});

describe("historian success path", () => {
    it(
        "publishes a compartment to the DB after a successful run",
        async () => {
            h.mock.reset();

            // The mock derives compartment bounds from the historian request because the ordinal range varies.
            h.mock.addMatcher((body) => {
                if (!isHistorianRequest(body)) return null;
                const range = findOrdinalRange(body);
                if (!range) {
                    return {
                        text: "<output><compartments></compartments><facts></facts><unprocessed_from>1</unprocessed_from></output>",
                        usage: {
                            input_tokens: 500,
                            output_tokens: 50,
                            cache_creation_input_tokens: 500,
                            cache_read_input_tokens: 0,
                        },
                    };
                }
                const payload = buildMockHistorianPayload({
                    start: range.start,
                    end: range.end,
                    title: "E2E test chunk",
                    body: "Driven by the e2e harness: initial turns carry placeholder content used only to exercise historian.",
                });
                return {
                    text: payload,
                    usage: {
                        input_tokens: 500,
                        output_tokens: 200,
                        cache_creation_input_tokens: 500,
                        cache_read_input_tokens: 0,
                    },
                };
            });

            h.mock.setDefault({
                text: "fill",
                usage: {
                    input_tokens: 1_000,
                    output_tokens: 20,
                    cache_creation_input_tokens: 1_000,
                    cache_read_input_tokens: 0,
                },
            });

            const sessionId = await h.createSession();

            // The protected-tail boundary uses raw content rather than mock usage, so each turn includes about 3K tokens of ballast.
            // The protected-tail boundary uses raw content rather than mock usage.
            // never starts.
            for (let i = 1; i <= 10; i++) {
                await h.sendPrompt(
                    sessionId,
                    `turn ${i}: meaningful prompt carrying durable signal for chunk ${i}. ${h.ballast(3_000)}`,
                );
            }

            // Turn 11: 45% usage, triggers historian with eligible tail.
            h.mock.setDefault({
                text: "big",
                usage: {
                    input_tokens: 90_000,
                    output_tokens: 20,
                    cache_creation_input_tokens: 90_000,
                    cache_read_input_tokens: 0,
                },
            });
            await h.sendPrompt(sessionId, "turn 11: trigger turn with real content.");

            // Small responses keep later turns below the execution threshold.
            // Historian starts on the next transform pass after turn 11 sets compartment_in_progress.
            // provide below.
            h.mock.setDefault({
                text: "after-trigger",
                usage: {
                    input_tokens: 500,
                    output_tokens: 10,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 500,
                },
            });
            // Send turn 12 because the historian starts on the pass after `compartment_in_progress` is set.
            await h.sendPrompt(sessionId, "turn 12: post-trigger follow-up.");

            // In Rust mode, `rust-historian-producer.test.ts` covers producer completion because the producer runs outside this mock.
            const mainRequests = h.mock.requests().filter((request) => !isHistorianRequest(request.body));
            expect(mainRequests.length).toBeGreaterThanOrEqual(12);
            if (process.env.MC_E2E_MODE === "rust") {
                // The hermetic producer bypasses this OpenCode model mock in Rust mode.
                console.log(`[rust-e2e] historian publication assertions SKIPPED: ${FOLD_SKIP_REASON}`);
                return;
            }

            // The compartment row commits before `compartment_in_progress` clears.
            // `ensureProjectRegistered`, embedding, signaling, and marker work run before the flag clears.
            // Waiting only for the compartment count can observe a committed row while `compartment_in_progress` is 1.
            // A finished historian run leaves `compartment_in_progress` at 0.
            await h.waitFor(
                () => {
                    const row = h
                        .contextDb()
                        .prepare(
                            "SELECT COUNT(*) as c FROM compartments WHERE session_id = ?",
                        )
                        .get(sessionId) as { c: number } | null;
                    if ((row?.c ?? 0) < 1) return false;
                    const meta = h
                        .contextDb()
                        .prepare(
                            "SELECT compartment_in_progress FROM session_meta WHERE session_id = ?",
                        )
                        .get(sessionId) as { compartment_in_progress: number } | null;
                    return (meta?.compartment_in_progress ?? 1) === 0;
                },
                { timeoutMs: 30_000, label: "compartment published and in-progress flag cleared" },
            );

            // Assertions.
            const compartmentCount = (
                h
                    .contextDb()
                    .prepare("SELECT COUNT(*) as c FROM compartments WHERE session_id = ?")
                    .get(sessionId) as { c: number }
            ).c;
            console.log(`[TEST] compartment rows after historian: ${compartmentCount}`);
            expect(compartmentCount).toBeGreaterThanOrEqual(1);


            const meta = h
                .contextDb()
                .prepare(
                    "SELECT compartment_in_progress FROM session_meta WHERE session_id = ?",
                )
                .get(sessionId) as { compartment_in_progress: number } | null;
            console.log(
                `[TEST] compartment_in_progress after historian: ${meta?.compartment_in_progress}`,
            );
            expect(meta?.compartment_in_progress ?? 1).toBe(0);
        },
        120_000,
    );
});
