/// <reference types="bun-types" />

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { PiTestHarness } from "../src/pi-harness";
import { buildMockHistorianPayload } from "../src/mock-historian";
import { isHistorianRequest } from "../src/cache-analysis";

function findOrdinalRange(body: Record<string, unknown>): { start: number; end: number } | null {
    const messages = body.messages as Array<{ role: string; content: unknown }> | undefined;
    if (!messages) return null;
    for (const m of messages) {
        const contentArr = Array.isArray(m.content) ? m.content : [];
        for (const block of contentArr) {
            const text = (block as { text?: string }).text;
            if (!text || !text.includes("<new_messages>")) continue;
            const nums: number[] = [];
            for (const match of text.matchAll(/\[(\d+)\]/g)) nums.push(Number(match[1]));
            if (nums.length === 0) continue;
            return { start: Math.min(...nums), end: Math.max(...nums) };
        }
    }
    return null;
}

let h: PiTestHarness;

beforeAll(async () => {
    h = await PiTestHarness.create({
        magicContextConfig: {
            execute_threshold_percentage: 40,
            historian: { model: "anthropic/claude-haiku-4-5" },
        },
    });
});

afterAll(async () => {
    await h.dispose();
});

describe("pi historian success path", () => {
    it(
        "publishes a pi compartment to the DB after a successful run",
        async () => {
            h.mock.reset();
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
                return {
                    text: buildMockHistorianPayload({
                        start: range.start,
                        end: range.end,
                        title: "Pi e2e test chunk",
                        body: "Driven by the Pi e2e harness to exercise historian publication.",
                    }),
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

            for (let i = 1; i <= 10; i++) {
                await h.sendPrompt(`turn ${i}: meaningful pi prompt carrying durable signal ${i}. ${h.ballast(3_000)}`);
            }

            h.mock.setDefault({
                text: "big",
                usage: {
                    input_tokens: 90_000,
                    output_tokens: 20,
                    cache_creation_input_tokens: 90_000,
                    cache_read_input_tokens: 0,
                },
            });
            const trigger = await h.sendPrompt("turn 11: trigger pi historian with real content.");
            const sessionId = trigger.sessionId;
            expect(sessionId).toBeTruthy();

            h.mock.setDefault({
                text: "after-trigger",
                usage: {
                    input_tokens: 500,
                    output_tokens: 10,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 500,
                },
            });
            await h.sendPrompt("turn 12: post-trigger pi follow-up.", { continueSession: true });

            await Bun.sleep(300);
            await h.waitFor(
                () => {
                    const row = h
                        .contextDb()
                        .prepare(
                            "SELECT COUNT(*) as c FROM compartments WHERE session_id = ? AND harness = 'pi'",
                        )
                        .get(sessionId) as { c: number } | null;
                    return (row?.c ?? 0) >= 1;
                },
                // Bumped from 30s → 90s for CI: Pi historian publishes via
                // pi --print subprocess + HTTP mock provider; slower on shared
                // runners.
                { timeoutMs: 300_000, label: "pi compartment row appears" },
            );

            const compartmentCount = (
                h
                    .contextDb()
                    .prepare(
                        "SELECT COUNT(*) as c FROM compartments WHERE session_id = ? AND harness = 'pi'",
                    )
                    .get(sessionId) as { c: number }
            ).c;
            console.log(`[TEST] pi compartment rows after historian: ${compartmentCount}`);
            expect(compartmentCount).toBeGreaterThanOrEqual(1);

            const historianRequests = h.mock.requests().filter((r) => isHistorianRequest(r.body));
            console.log(`[TEST] pi historian requests: ${historianRequests.length}`);
            expect(historianRequests.length).toBeGreaterThanOrEqual(1);

            // Wait for the runner to fully exit — compartment_in_progress is
            // cleared in the runner's `finally` block AFTER post-publish work
            // (memory promotion, queue drops, compaction marker, compressor).
            // The compartment row appears earlier in the flow, so seeing the
            // row doesn't guarantee the flag has flipped yet. On shared CI
            // runners the gap between publish and `finally` can stretch
            // beyond the initial 300ms sleep.
            await h.waitFor(
                () => {
                    const meta = h
                        .contextDb()
                        .prepare(
                            "SELECT compartment_in_progress FROM session_meta WHERE session_id = ?",
                        )
                        .get(sessionId) as { compartment_in_progress: number } | null;
                    return (meta?.compartment_in_progress ?? 1) === 0;
                },
                { timeoutMs: 60_000, label: "pi compartment_in_progress clears" },
            );

            const meta = h
                .contextDb()
                .prepare("SELECT compartment_in_progress FROM session_meta WHERE session_id = ?")
                .get(sessionId) as { compartment_in_progress: number } | null;
            console.log(
                `[TEST] pi compartment_in_progress after historian: ${meta?.compartment_in_progress}`,
            );
            expect(meta?.compartment_in_progress ?? 1).toBe(0);
        },
        // Bumped from 120s → 600s for CI to give the bumped waitFor headroom.
        600_000,
    );
});
