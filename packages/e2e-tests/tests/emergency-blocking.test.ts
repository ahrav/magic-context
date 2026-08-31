/// <reference types="bun-types" />

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { TestHarness } from "../src/harness";
import { buildMockHistorianPayload } from "../src/mock-historian";
import { FOLD_SKIP_REASON } from "../src/rust-scenario-support";
import { isHistorianRequest } from "../src/cache-analysis";

/**
 *
 *
 * When usage crosses 95%, MAGIC-CONTEXT invokes historian to compact durable history before the next model call.
 * Compaction preserves context capacity for the next model call.
 * limit.
 *
 * The test drives usage to approximately 97% of the mock's 200K limit and requires a historian request on the next turn.
 *
 */

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

describe("emergency >=95%", () => {
    it(
        "historian is invoked when usage crosses 95%",
        async () => {
            h.mock.reset();

            // Use a fast valid historian payload because the test requires invocation, not completion.
            // Strict tier validation rejects empty or flat v2 compartment payloads, retries them, and never publishes them; an invalid mock would hang the compartment wait.
            h.mock.addMatcher((body) => {
                if (!isHistorianRequest(body)) return null;
                const flat = JSON.stringify(body.messages ?? []);
                const rangeHdr = flat.match(/Messages (\d+)-(\d+):/);
                const start = rangeHdr ? Number(rangeHdr[1]) : 1;
                const end = rangeHdr ? Number(rangeHdr[2]) : 1;
                return {
                    text: buildMockHistorianPayload({
                        start,
                        end,
                        title: "Emergency build-up",
                        body: "Summary of the fill turns.",
                    }),
                    usage: {
                        input_tokens: 500,
                        output_tokens: 50,
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

            for (let i = 1; i <= 10; i++) {
                await h.sendPrompt(
                    sessionId,
                    `turn ${i}: meaningful content populating raw history. ${h.ballast(3_000)}`,
                );
            }

            h.mock.setDefault({
                text: "big",
                usage: {
                    input_tokens: 194_000,
                    output_tokens: 20,
                    cache_creation_input_tokens: 194_000,
                    cache_read_input_tokens: 0,
                },
            });
            await h.sendPrompt(
                sessionId,
                "turn 11: meaningful spike turn that pushes usage past 95%.",
            );

            // The test waits for the event handler to persist the 95%+ state.
            await Bun.sleep(300);

            // Turn 12: transform sees 97%. Historian must be invoked.
            h.mock.setDefault({
                text: "after",
                usage: {
                    input_tokens: 500,
                    output_tokens: 10,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 500,
                },
            });
            await h.sendPrompt(
                sessionId,
                "turn 12: post-emergency follow-up.",
            ).catch(() => {
                // The emergency abort can reject the in-flight request.
                // The aborted request may reject without failing this test.
            });

             // The Rust producer bypasses this mock.
            const meta = h
                .contextDb()
                .prepare(
                    "SELECT last_input_tokens FROM session_meta WHERE session_id = ?",
                )
                .get(sessionId) as { last_input_tokens: number } | null;
            expect(meta?.last_input_tokens ?? 0).toBeGreaterThan(0);
            if (process.env.MC_E2E_MODE === "rust") {
                console.log(`[rust-e2e] emergency historian assertions SKIPPED: ${FOLD_SKIP_REASON}`);
                return;
            }

            // The historian pass can run a subprocess, so this test uses a 90-second timeout.
            // real bound.
            try {
                await h.waitFor(() => h.countCompartments(sessionId) >= 1, {
                    timeoutMs: 90_000,
                    label: "emergency historian compartment",
                });
            } catch (error) {
                // Before rethrowing, diagnostics identify whether scheduling, the historian request, or compartment publication stalled.
                const historianRequests = h.mock
                    .requests()
                    .filter((r) => isHistorianRequest(r.body)).length;
                console.log(
                    `[TEST] emergency timeout: historianRequests=${historianRequests} totalRequests=${h.mock.requests().length} compartments=${h.countCompartments(sessionId)}`,
                );
                try {
                    const state = h
                        .contextDb()
                        .prepare(
                            "SELECT compartment_in_progress, last_context_percentage FROM session_meta WHERE session_id = ?",
                        )
                        .get(sessionId) as {
                        compartment_in_progress: number;
                        last_context_percentage: number;
                    } | null;
                    console.log(
                        `[TEST] session_meta: inProgress=${state?.compartment_in_progress} lastPct=${state?.last_context_percentage}`,
                    );
                } catch (dbError) {
                    console.log(`[TEST] session_meta probe failed: ${dbError}`);
                }
                console.log(`[TEST] opencode stderr tail:\n${h.opencode.stderr().slice(-3000)}`);
                throw error;
            }
            expect(h.countCompartments(sessionId)).toBeGreaterThanOrEqual(1);

        },
        120_000,
    );
});
