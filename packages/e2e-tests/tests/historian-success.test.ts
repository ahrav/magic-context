/// <reference types="bun-types" />

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { TestHarness } from "../src/harness";
import { buildMockHistorianPayload } from "../src/mock-historian";
import { FOLD_SKIP_REASON } from "../src/rust-scenario-support";

/**
 * Historian publishes a compartment end-to-end.
 *
 * This test drives:
 *   - 11 user turns, each with meaningful text
 *   - Turn 11 carries 90K tokens to cross the 40% execute threshold AND
 *     make the tail eligible (>=12 messages)
 *   - Mock historian returns a VALID response matching the chunk
 *
 * Assertions:
 *   - At least one historian request was issued
 *   - The compartments table has a row after historian finishes
 *   - session_meta.compartment_in_progress is cleared
 *
 * This verifies the full write path: event-handler trigger → transform starts
 * historian → historian runs → response is validated → compartment is
 * persisted → in-progress flag is cleared.
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

/** Extract the message ordinals historian was asked to process from the body. */
function findOrdinalRange(body: Record<string, unknown>): { start: number; end: number } | null {
    const messages = body.messages as Array<{ role: string; content: unknown }> | undefined;
    if (!messages) return null;
    // Historian prompt is sent as a single user message whose content holds
    // the <new_messages> block with lines like "[3] U: ...". Extract all
    // bracketed ordinals and return min/max.
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

            // Dynamic historian response: parse the request to find the
            // actual ordinal range and return a compartment covering it.
            h.mock.addMatcher((body) => {
                if (!isHistorianRequest(body)) return null;
                const range = findOrdinalRange(body);
                if (!range) {
                    // Shouldn't happen in practice, but fall back to a safe
                    // zero-compartment empty response.
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

            // Each build turn carries ~3K tokens of REAL text ballast: the v3
            // protected-tail boundary measures true-raw content, not the
            // mock's fabricated usage numbers — without content mass the
            // boundary finds no eligible head and the historian (correctly)
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

            // Reset to small responses so subsequent turns don't keep piling
            // on pressure. The 90K spike on turn 11 set compartment_in_progress;
            // historian actually STARTS on the next transform pass, which we
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
            // Turn 12: gives the transform a fresh pass to actually start
            // historian after the event handler flipped compartment_in_progress.
            // Historian was previously kicked off implicitly by the 80%
            // emergency nudge's promptAsync call; since that path was removed
            // in v0.14.1, tests need to provide the follow-up turn explicitly.
            await h.sendPrompt(sessionId, "turn 12: post-trigger follow-up.");

            // The main-agent requests and trigger setup are fold-independent. In
            // Rust mode the producer runs outside this mock, so completion belongs
            // to rust-historian-producer.test.ts rather than this mock-capture test.
            const mainRequests = h.mock.requests().filter((request) => !isHistorianRequest(request.body));
            expect(mainRequests.length).toBeGreaterThanOrEqual(12);
            if (process.env.MC_E2E_MODE === "rust") {
                // The hermetic producer bypasses this OpenCode model mock; report
                // that this mock-capture assertion is intentionally not applicable.
                console.log(`[rust-e2e] historian publication assertions SKIPPED: ${FOLD_SKIP_REASON}`);
                return;
            }

            // Wait for the historian run to REACH ITS TERMINAL STATE: at least
            // one compartment published AND compartment_in_progress cleared.
            // These are NOT simultaneous — the compartment row is COMMITted
            // (compartment-runner-incremental.ts BEGIN IMMEDIATE..COMMIT) well
            // before the flag clears at the end of the same async run, with an
            // `await ensureProjectRegistered` + embedding/signal/marker work in
            // between. Waiting only on the compartment count (the old check)
            // raced that window: on a slower runner the row exists while the
            // flag is still 1. The flag always ends at 0 on a finished run
            // (success path clears it; any throw clears it via the runner's
            // catch), so the terminal invariant is "compartment present AND flag
            // cleared". Wait for both.
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


            // compartment_in_progress should be cleared after successful publication.
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
