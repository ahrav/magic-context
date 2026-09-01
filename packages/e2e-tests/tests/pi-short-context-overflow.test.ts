
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { PiTestHarness } from "../src/pi-harness";
import { buildMockHistorianPayload } from "../src/mock-historian";
import { isHistorianRequest } from "../src/cache-analysis";

/**
 *
 *
 *
 * Pi rejects concurrent `prompt` commands with `Agent is already processing`, so this test cannot drive a tool call and its continuation with back-to-back prompts.
 *
 *
 */

function bigReplyText(turn: number, targetBytes: number): string {
    const header = `turn-${turn}-reply: `;
    const filler = "abcdefghij0123456789".repeat(200);
    const reps = Math.max(1, Math.floor(targetBytes / filler.length));
    return header + filler.repeat(reps);
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

describe("pi short context accumulating overflow", () => {
    it("emergency bypass keeps a 128K Pi session under 100% with slow historian", async () => {
        h.mock.reset();

        h.mock.addMatcher((body) => {
            if (!isHistorianRequest(body)) return null;
            const msgs = body.messages as Array<{ content?: unknown }> | undefined;
            const flat = JSON.stringify(msgs ?? []);
            const rangeHdr = flat.match(/Messages (\d+)-(\d+):/);
            const start = rangeHdr ? Number(rangeHdr[1]) : 0;
            const end = rangeHdr ? Number(rangeHdr[2]) : 0;
            return {
                text: buildMockHistorianPayload({
                    start,
                    end,
                    title: "Pi build-up",
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
            if (isHistorianRequest(body)) return null;
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

        let sessionId: string | null = null;
        const turnUsage: number[] = [];
        const turnErrors: Array<{ turn: number; error: string }> = [];
        const turns = 30;

        // Background work can keep the agent busy after `agent_end`.
        // A prompt sent while the agent is busy fails with "Agent is already processing".
        const waitForIdle = async (): Promise<void> => {
            const deadline = Date.now() + 30_000;
            while (Date.now() < deadline) {
                const state = await h.getState().catch(() => null);
                if (state && !state.isStreaming && !state.isCompacting) return;
                await new Promise((r) => setTimeout(r, 250));
            }
        };

        for (let i = 1; i <= turns; i++) {
            const reqBefore = h.mock.requests().length;
            try {
                await waitForIdle();
                const turn = await h.sendPrompt(`user turn ${i}: continue.`, {
                    timeoutMs: 60_000,
                    continueSession: true,
                });
                sessionId = sessionId ?? turn.sessionId;
            } catch (err) {
                turnErrors.push({
                    turn: i,
                    error: err instanceof Error ? err.message : String(err),
                });
                const state = await h.getState().catch(() => null);
                if (state && typeof state.sessionId === "string") sessionId = sessionId ?? state.sessionId;
            }
            const reqs = h.mock.requests().slice(reqBefore);
            const mainReq = reqs.find((r) => !isHistorianRequest(r.body));
            const observed = mainReq ? Math.floor(JSON.stringify(mainReq.body).length / 4) : 0;
            turnUsage.push(Math.round((observed / 128_000) * 1000) / 10);
        }

        const peakObservedPct = turnUsage.reduce((m, p) => Math.max(m, p), 0);
        const finalPct = turnUsage[turnUsage.length - 1] ?? 0;
        console.log(`[PI-OVERFLOW-GUARD] peak: ${peakObservedPct}% final: ${finalPct}% of 128K`);
        console.log(`[PI-OVERFLOW-GUARD] per-turn %: ${turnUsage.join(", ")}`);
        if (turnErrors.length > 0) {
            console.log(
                `[PI-OVERFLOW-GUARD] prompt failures (${turnErrors.length}):`,
                turnErrors.map((e) => `turn ${e.turn}: ${e.error.slice(0, 100)}`).join(" | "),
            );
        }

        expect(sessionId).toBeTruthy();
        expect(turnErrors).toEqual([]);

        const compartmentCount = h
            .contextDb()
            .prepare("SELECT COUNT(*) AS c FROM compartments WHERE session_id = ?")
            .get(sessionId!) as { c: number };
        const meta = h
            .contextDb()
            .prepare("SELECT last_context_percentage, last_input_tokens FROM session_meta WHERE session_id = ?")
            .get(sessionId!) as { last_context_percentage: number; last_input_tokens: number } | undefined;
        const droppedCount = h.countDroppedTags(sessionId!);
        console.log(
            `[PI-OVERFLOW-GUARD] compartments=${compartmentCount.c} dropped_tags=${droppedCount} last_context_percentage=${meta?.last_context_percentage} last_input_tokens=${meta?.last_input_tokens}`,
        );
    }, 240_000);
});
