/// <reference types="bun-types" />

/**
 *
 *
 *
 *
 *
 *
 *   - Peak request stays under 100% of context
 * Session survives at least 20 back-to-back turns with a 3 s historian delay.
 *
 *
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { TestHarness } from "../src/harness";
import { buildMockHistorianPayload } from "../src/mock-historian";

const HISTORIAN_MARKER = "the hippocampus of a long-running coding agent";

function isHistorian(body: Record<string, unknown>): boolean {
    const sys = body.system;
    if (sys === undefined || sys === null) return false;
    const asString = typeof sys === "string" ? sys : JSON.stringify(sys);
    return asString.includes(HISTORIAN_MARKER);
}

function bigReplyText(turn: number, targetBytes: number): string {
    const header = `turn-${turn}-reply: `;
    const filler = "abcdefghij0123456789".repeat(200);
    const reps = Math.max(1, Math.floor(targetBytes / filler.length));
    return header + filler.repeat(reps);
}

let h: TestHarness;

beforeAll(async () => {
    h = await TestHarness.create({
        modelContextLimit: 128_000,
        magicContextConfig: {
            execute_threshold_percentage: 40,
        },
    });
});

afterAll(async () => {
    await h.dispose();
});

describe("short context accumulating overflow", () => {
    it(
        "emergency bypass keeps 128K session under 100% with slow historian",
        async () => {
            h.mock.reset();

            h.mock.addMatcher((body) => {
                if (!isHistorian(body)) return null;
                const msgs = body.messages as Array<{ content?: unknown }> | undefined;
                const flat = JSON.stringify(msgs ?? []);
                const rangeHdr = flat.match(/Messages (\d+)-(\d+):/);
                const start = rangeHdr ? Number(rangeHdr[1]) : 0;
                const end = rangeHdr ? Number(rangeHdr[2]) : 0;
                return {
                    text: buildMockHistorianPayload({
                        start,
                        end,
                        title: "Build-up",
                        body: "Summary.",
                    }),
                    usage: {
                        input_tokens: 500,
                        output_tokens: 50,
                        cache_creation_input_tokens: 500,
                        cache_read_input_tokens: 0,
                    },
                    delayMs: 3_000,
                };
            });

            let mainCalls = 0;
            h.mock.addMatcher((body) => {
                if (isHistorian(body)) return null;
                mainCalls++;
                const approxInputTokens = Math.floor(JSON.stringify(body).length / 4);
                const reply = bigReplyText(mainCalls, 20_000);
                return {
                    text: reply,
                    usage: {
                        input_tokens: approxInputTokens,
                        output_tokens: Math.floor(reply.length / 4),
                        cache_creation_input_tokens: 0,
                        cache_read_input_tokens: 0,
                    },
                };
            });

            const sessionId = await h.createSession();
            const turnUsage: number[] = [];
            const turnErrors: Array<{ turn: number; error: string }> = [];
            const TURNS = 30;
            for (let i = 1; i <= TURNS; i++) {
                const reqBefore = h.mock.requests().length;
                try {
                    await h.sendPrompt(sessionId, `user turn ${i}: continue.`, {
                        timeoutMs: 60_000,
                    });
                } catch (err) {
                    turnErrors.push({
                        turn: i,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
                const reqs = h.mock.requests().slice(reqBefore);
                const mainReq = reqs.find((r) => !isHistorian(r.body));
                const observed = mainReq ? Math.floor(JSON.stringify(mainReq.body).length / 4) : 0;
                turnUsage.push(Math.round((observed / 128_000) * 1000) / 10);
            }

            const peakObservedPct = turnUsage.reduce((m, p) => Math.max(m, p), 0);
            const finalPct = turnUsage[turnUsage.length - 1] ?? 0;
            console.log(`[OVERFLOW-GUARD] peak: ${peakObservedPct}% final: ${finalPct}% of 128K`);
            console.log(`[OVERFLOW-GUARD] per-turn %: ${turnUsage.join(", ")}`);
            if (turnErrors.length > 0) {
                console.log(
                    `[OVERFLOW-GUARD] prompt failures (${turnErrors.length}):`,
                    turnErrors
                        .map((e) => `turn ${e.turn}: ${e.error.slice(0, 100)}`)
                        .join(" | "),
                );
            }

            // The test must reject failed prompts; otherwise it cannot verify that the overflow guard prevents failures.
            expect(turnErrors).toEqual([]);

            const ctx = h.contextDb();
            const row = ctx
                .prepare("SELECT COUNT(*) AS c FROM tags WHERE status='dropped'")
                .get() as { c: number } | undefined;
            const droppedCount = row?.c ?? 0;
            console.log(`[OVERFLOW-GUARD] dropped tags: ${droppedCount}`);
            expect(droppedCount).toBeGreaterThan(0);

            expect(peakObservedPct).toBeLessThan(100);
        },
        600_000,
    );
});
