/// <reference types="bun-types" />

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { TestHarness } from "../src/harness";
import { buildMockHistorianPayload } from "../src/mock-historian";

/**
 * Historian persists pending marker state during publication and defers marker advancement to materialization.
 * defer-pass stability.
 *
 * Deferring marker advancement lets one cache-bust cycle rebuild `<session-history>` and advance the marker boundary.
 *
 *      historian publication.
 *
 *
 * The test omits drain assertions because drain requires a materialization pass that consumes history.
 *
 */

const HISTORIAN_SYSTEM_MARKER =
    "the hippocampus of a long-running coding agent";
const RUST_MODE = process.env.MC_E2E_MODE === "rust";

function isHistorianRequest(body: Record<string, unknown>): boolean {
    const system = body.system;
    if (typeof system === "string")
        return system.includes(HISTORIAN_SYSTEM_MARKER);
    if (Array.isArray(system)) {
        for (const block of system) {
            if (block && typeof block === "object") {
                const text = (block as { text?: unknown }).text;
                if (
                    typeof text === "string" &&
                    text.includes(HISTORIAN_SYSTEM_MARKER)
                ) {
                    return true;
                }
            }
        }
    }
    return false;
}

function findOrdinalRange(
    body: Record<string, unknown>,
): { start: number; end: number } | null {
    const messages = body.messages as
        | Array<{ role: string; content: unknown }>
        | undefined;
    if (!messages) return null;
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

interface PendingRow {
    pending_compaction_marker_state: string | null;
    compaction_marker_state: string | null;
}

function readMarkerState(h: TestHarness, sessionId: string): PendingRow | null {
    const row = h
        .contextDb()
        .prepare(
            "SELECT pending_compaction_marker_state, compaction_marker_state FROM session_meta WHERE session_id = ?",
        )
        .get(sessionId) as PendingRow | null;
    return row;
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

describe("deferred compaction marker (plan v6)", () => {
    it("writes pending blob in-tx on publish and holds it across defer passes", async () => {
            h.mock.reset();

            h.mock.addMatcher((body) => {
                if (!isHistorianRequest(body)) return null;
                const range = findOrdinalRange(body);
                if (!range) {
                    return {
                        text: "<output><compartments></compartments><facts></facts><unprocessed_from>1</unprocessed_from></output>",
                        usage: {
                            input_tokens: 100,
                            output_tokens: 50,
                            cache_creation_input_tokens: 0,
                            cache_read_input_tokens: 0,
                        },
                    };
                }
                const payload = buildMockHistorianPayload({
                    start: range.start,
                    end: range.end,
                    title: "e2e marker drain chunk",
                    body: "Initial turns driven by the e2e harness — exercises the deferred-marker drain path.",
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

            // The default response remains below the 40% threshold.
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

            // Ten small turns build an eligible tail.
            for (let i = 1; i <= 10; i++) {
                await h.sendPrompt(
                    sessionId,
                    `turn ${i}: meaningful prompt carrying durable signal for chunk ${i}. ${h.ballast(3_000)}`,
                );
            }

            // Turn 11: 90K tokens crosses 40% threshold AND makes tail eligible.
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

            // Small responses prevent follow-up turns from re-triggering publication.
            h.mock.setDefault({
                text: "after-trigger",
                usage: {
                    input_tokens: 500,
                    output_tokens: 10,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 500,
                },
            });

            // Turn 12 gives the historian transform a fresh pass.
            await h.sendPrompt(sessionId, "turn 12: post-trigger follow-up.");

        if (RUST_MODE) {
            const stack = h.mcHostStack;
            if (!stack)
                throw new Error("Rust marker check requires the hermetic module stack");
            const deadline = Date.now() + 60_000;
            let afterPublish: Record<string, unknown> = {};
            while (Date.now() < deadline) {
                afterPublish = await stack.primaryStatus(
                    sessionId,
                    h.opencode.env.workdir,
                    "session.status",
                );
                if (
                    Number(afterPublish.compartment_count ?? 0) > 0 &&
                    afterPublish.pending_m1_delta === true
                ) {
                    break;
                }
                await Bun.sleep(100);
            }
            expect(Number(afterPublish.compartment_count ?? 0)).toBeGreaterThan(0);
            expect(afterPublish.pending_m1_delta).toBe(true);

            await h.sendPrompt(sessionId, "small defer turn — no mutation expected");
            const pendingAfter = await stack.primaryStatus(
                sessionId,
                h.opencode.env.workdir,
                "session.status",
            );
            const unchanged = pendingAfter.pending_m1_delta === true;
            const drained =
                pendingAfter.pending_m1_delta === false &&
                JSON.stringify(h.mock.lastRequest()?.body ?? {}).includes(
                    "<session-history>",
                );
            expect(unchanged || drained).toBe(true);
        } else {
            await h.waitFor(
                () => {
                    const row = readMarkerState(h, sessionId);
                    return (
                        row?.pending_compaction_marker_state != null &&
                        row.pending_compaction_marker_state.length > 0
                    );
                },
                {
                    timeoutMs: 30_000,
                    label: "pending_compaction_marker_state set after publish",
                },
            );

            const afterPublish = readMarkerState(h, sessionId);
            expect(afterPublish).not.toBeNull();
            expect(afterPublish?.pending_compaction_marker_state).toBeTruthy();

            const pendingBlob = JSON.parse(
                afterPublish?.pending_compaction_marker_state ?? "{}",
            );
            expect(typeof pendingBlob.ordinal).toBe("number");
            expect(pendingBlob.ordinal).toBeGreaterThan(0);
            expect(typeof pendingBlob.endMessageId).toBe("string");
            expect(pendingBlob.endMessageId.length).toBeGreaterThan(0);
            expect(typeof pendingBlob.publishedAt).toBe("number");

            const pendingBefore = afterPublish?.pending_compaction_marker_state;
            await h.sendPrompt(sessionId, "small defer turn — no mutation expected");
            const pendingAfter = readMarkerState(h, sessionId);
            const drained =
                pendingAfter?.pending_compaction_marker_state == null &&
                pendingAfter?.compaction_marker_state != null &&
                pendingAfter.compaction_marker_state.length > 0;
            const unchanged =
                pendingAfter?.pending_compaction_marker_state === pendingBefore;
            expect(drained || unchanged).toBe(true);
        }
    }, 90_000);
});
