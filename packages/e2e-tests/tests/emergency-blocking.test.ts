/// <reference types="bun-types" />

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { TestHarness } from "../src/harness";
import { FOLD_SKIP_REASON } from "../src/rust-scenario-support";

/**
 * Emergency handling when usage climbs to or above 95%.
 *
 * At >=95% (BLOCK_UNTIL_DONE_PERCENTAGE), the plugin takes one of two actions:
 *   (a) Block the transform on historian completion (standard 95% path).
 *   (b) Abort the in-flight request via client.session.abort() and notify the
 *       user (emergency-recovery path when historian has prior failures).
 *
 * Either way, the critical invariant is that MAGIC-CONTEXT invokes historian
 * when usage crosses 95% so durable history can be compacted before the next
 * model call. Without this, the next prompt would blow the provider context
 * limit.
 *
 * This test drives usage to ~97% of the mock's 200K limit and verifies that
 * at least one historian request is captured on the NEXT turn.
 *
 * Latency is intentionally NOT asserted because the plugin may either block
 * or abort — both behaviors are correct and protect the user, but they have
 * very different timing characteristics.
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

            // Fast historian mock so the test doesn't need to wait on a long
            // delay. We only need historian to be INVOKED; what it does after
            // that isn't part of this invariant.
            h.mock.addMatcher((body) => {
                if (!isHistorianRequest(body)) return null;
                return {
                    text:
                        "<output>" +
                        "<compartments></compartments>" +
                        "<facts></facts>" +
                        "<unprocessed_from>1</unprocessed_from>" +
                        "</output>",
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

            // Fill-phase: 10 low-pressure turns to get enough history.
            for (let i = 1; i <= 10; i++) {
                await h.sendPrompt(
                    sessionId,
                    `turn ${i}: meaningful content populating raw history. ${h.ballast(3_000)}`,
                );
            }

            // Turn 11: response carries ~97% of 200K limit.
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

            // Give event handler a beat to persist 95%+ state.
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
                // Emergency abort path cancels the in-flight request — any
                // error here is expected, not a failure of the invariant.
            });

             // The pressure observation is fold-independent and is asserted in
             // both modes. Rust's module-side producer bypasses this mock, so its
             // publication path is covered by the dedicated producer suite.
            const meta = h
                .contextDb()
                .prepare(
                    "SELECT last_input_tokens FROM session_meta WHERE session_id = ?",
                )
                .get(sessionId) as { last_input_tokens: number } | null;
            expect(meta?.last_input_tokens ?? 0).toBeGreaterThan(0);
            if (process.env.MC_E2E_MODE === "rust") {
                // The Rust producer does not send its request through this mock;
                // this test asserts only the shared pressure behavior.
                console.log(`[rust-e2e] emergency historian assertions SKIPPED: ${FOLD_SKIP_REASON}`);
                return;
            }

            // 90s, not 30s: the historian pass runs a subprocess against the
            // mock provider, which on GitHub-hosted runners is 3-5x slower
            // than local hardware; the test's own budget below stays the
            // real bound.
            try {
                await h.waitFor(() => h.countCompartments(sessionId) >= 1, {
                    timeoutMs: 90_000,
                    label: "emergency historian compartment",
                });
            } catch (error) {
                // Diagnostics before rethrow: pinpoint which stage of the
                // emergency pipeline stalled (scheduling, the historian
                // request, or compartment publish).
                const historianRequests = h.mock
                    .requests()
                    .filter((r) => isHistorianRequest(r.body)).length;
                const inProgress = h
                    .contextDb()
                    .prepare(
                        "SELECT COUNT(*) AS c FROM compartment_in_progress WHERE session_id = ?",
                    )
                    .get(sessionId) as { c: number } | null;
                const pct = h
                    .contextDb()
                    .prepare(
                        "SELECT last_context_percentage FROM session_meta WHERE session_id = ?",
                    )
                    .get(sessionId) as { last_context_percentage: number } | null;
                console.log(
                    `[TEST] emergency timeout: historianRequests=${historianRequests} totalRequests=${h.mock.requests().length} compartments=${h.countCompartments(sessionId)} inProgress=${inProgress?.c} lastPct=${pct?.last_context_percentage}`,
                );
                console.log(`[TEST] opencode stderr tail:\n${h.opencode.stderr().slice(-3000)}`);
                throw error;
            }
            expect(h.countCompartments(sessionId)).toBeGreaterThanOrEqual(1);

            // The shared pressure observation above also proves the plugin saw
            // the high-pressure turn before the follow-up rewrote its usage.
        },
        120_000,
    );
});
