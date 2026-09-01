/// <reference types="bun-types" />

/**
 *
 * A stale `ctx_reduce` strip requires growth, an EXECUTE pass that freezes drop state, and a subsequent DEFER pass.
 *
 * DEFER passes must not change the cached prefix.
 * `findBusts` uses the production diagnostic's bust definition.
 * A bust is a change between consecutive requests to a wire segment before the final `cache_control` breakpoint.
 *
 *   A1  low-pressure pure-defer growth stays byte-stable
 *   A2  defer passes AFTER an execute pass + growth stay byte-stable
 *   A3  an aged ctx_reduce call never vanishes mid-prefix on a defer pass
 *
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { extractM0, extractM1, findBusts, formatBustReport, isHistorianRequest, mainAgentRequests } from "../src/cache-analysis";
import { TestHarness } from "../src/harness";
import {
    driveAgedCtxReduceSurvival,
    driveFirstRenderPureDeferStability,
    failedCheckIds,
    verifyAgedCtxReduceSurvival,
    verifyFirstRenderPureDeferStability,
} from "../src/incident-pool/scenarios/source-linked-regressions";
import type { MockUsage } from "../src/mock-provider/server";

const RUST_MODE = process.env.MC_E2E_MODE === "rust";

function wireValueText(value: unknown): string {
    return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 *
 * The historian accepts ordinals only as line-anchored `[N] U:` or `[N] A:` entries.
 * Unanchored bracketed digits can match prose instead of session entries.
 * Prose can contain stray bracketed digits such as `m[0]`.
 * A stray `[0]` produces a 0-N compartment range.
 * A 0-N compartment range fails the historian's raw-session-range validation.
 */
function findOrdinalRange(body: Record<string, unknown>): { start: number; end: number } | null {
    const messages = (body.messages as Array<{ content: unknown }> | undefined) ?? [];
    for (const m of messages) {
        const blocks = Array.isArray(m.content) ? m.content : [];
        for (const block of blocks) {
            const text = (block as { text?: string }).text;
            if (!text || !text.includes("<new_messages>")) continue;
            const start = text.indexOf("<new_messages>");
            const end = text.indexOf("</new_messages>");
            const scope = end > start ? text.slice(start, end) : text.slice(start);
            const nums = [...scope.matchAll(/^\[(\d+)\] [UA]:/gm)].map((mm) => Number(mm[1]));
            if (nums.length > 0) return { start: Math.min(...nums), end: Math.max(...nums) };
        }
    }
    return null;
}

/* */
function installHistorianMatcher(h: TestHarness): void {
    h.mock.addMatcher((body) => {
        if (!isHistorianRequest(body)) return null;
        const range = findOrdinalRange(body);
        const usage = {
            input_tokens: 500,
            output_tokens: 200,
            cache_creation_input_tokens: 500,
            cache_read_input_tokens: 0,
        };
        if (!range) {
            return {
                text: "<output><compartments></compartments><facts></facts><unprocessed_from>1</unprocessed_from></output>",
                usage,
            };
        }
        const payload = [
            "<output>",
            "<compartments>",
            `<compartment start="${range.start}" end="${range.end}" title="cache-invariant chunk" importance="50" episode_type="feature">`,
            "<p1>Driven by the cache-invariant harness: durable signal exercising historian publish and the m[0]/m[1] SOFT-delta taxonomy.</p1>",
            "<p2>Cache-invariant harness chunk exercising historian publish.</p2>",
            "<p3>cache-invariant harness chunk</p3>",
            "<p4/>",
            "</compartment>",
            "</compartments>",
            "<facts></facts>",
            "<events></events>",
            `<unprocessed_from>${range.end + 1}</unprocessed_from>`,
            "</output>",
        ].join("\n");
        return { text: payload, usage };
    });
}

const MODEL_LIMIT = 100_000;

// Usage below `execute_threshold` (20,000 tokens) causes a DEFER pass.
const DEFER_USAGE: MockUsage = {
    input_tokens: 2_000,
    output_tokens: 20,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 2_000,
};

// Usage above `execute_threshold` causes the next pass to execute.
const EXECUTE_USAGE: MockUsage = {
    input_tokens: 30_000,
    output_tokens: 20,
    cache_creation_input_tokens: 30_000,
    cache_read_input_tokens: 0,
};

const HISTORIAN_TRIGGER_USAGE: MockUsage = {
    input_tokens: 90_000,
    output_tokens: 20,
    cache_creation_input_tokens: 90_000,
    cache_read_input_tokens: 0,
};

let h: TestHarness;

beforeEach(async () => {
    h = await TestHarness.create({
        modelContextLimit: MODEL_LIMIT,
        magicContextConfig: {
            execute_threshold_percentage: 20,
            protected_tags: 1,
            dreamer: { disable: true },
            sidekick: { disable: true },
            compressor: { enabled: false },
            memory: {
                enabled: true,
                auto_promote: false,
                auto_search: { enabled: false },
                git_commit_indexing: { enabled: false },
            },
        },
    });
});

afterEach(async () => {
    await h.dispose();
});

function setDefer(text: string): void {
    h.mock.setDefault({ text, usage: DEFER_USAGE });
}

/** The mock emits one `ctx_reduce` tool call on the first main-agent request that exposes `ctx_reduce`. */
function emitCtxReduceOnce(drop: string): void {
    let emitted = false;
    h.mock.addMatcher((body) => {
        if (emitted) return null;
        const sys = JSON.stringify(body.system ?? "");
        if (!sys.includes("## Magic Context")) return null;
        const tools = Array.isArray(body.tools) ? body.tools : [];
        const name = tools
            .map((t) => (t && typeof t === "object" ? (t as { name?: unknown }).name : null))
            .find((n) => typeof n === "string" && /ctx_reduce/.test(n)) as string | undefined;
        if (!name) return null;
        emitted = true;
        return {
            content: [
                {
                    type: "tool_use",
                    id: `toolu_ci_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
                    name,
                    input: { drop },
                },
            ],
            stop_reason: "tool_use" as const,
            usage: DEFER_USAGE,
        };
    });
}

async function waitForRustCompartment(sessionId: string): Promise<void> {
    const stack = h.mcHostStack;
    if (!stack) throw new Error("Rust compartment wait requires the hermetic module stack");
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
        const status = await stack.primaryStatus(sessionId, h.opencode.env.workdir, "session.status");
        if (Number(status.compartment_count ?? 0) > 0) return;
        await Bun.sleep(100);
    }
    throw new Error("waitForRustCompartment timed out after 60000ms");
}

describe("cache invariants — replay class", () => {
    describe("#given a low-pressure conversation (A1)", () => {
        describe("#when several pure-defer turns grow the tail", () => {
            it("#then the cached prefix never busts across defer passes", async () => {
                const observation = await driveFirstRenderPureDeferStability(h);

                if (observation.bustReport) {
                    console.error(
                        `[cache-invariant:A1-low-pressure-defer] ${observation.bustCount} bust(s):\n${observation.bustReport}`,
                    );
                }
                expect(observation.mainRequestCount).toBeGreaterThanOrEqual(6);
                const result = verifyFirstRenderPureDeferStability(observation);
                expect(failedCheckIds(result)).toEqual([]);
                expect(result.verdict).toBe("pass");
            }, 120_000);
        });
    });

    describe("#given a conversation that crossed an execute pass (A2)", () => {
        describe("#when defer passes follow the execute pass with continued growth", () => {
            it("#then defer passes after the execute settle to a stable prefix", async () => {
                // A high-usage turn after warm-up makes the next transform execute.
                const sessionId = await h.createSession();
                setDefer("A2 warmup 1");
                await h.sendPrompt(sessionId, "A2 turn 1: warmup.");
                setDefer("A2 warmup 2");
                await h.sendPrompt(sessionId, "A2 turn 2: warmup.");

                h.mock.setDefault({ text: "A2 high usage", usage: EXECUTE_USAGE });
                await h.sendPrompt(sessionId, "A2 turn 3: high usage triggers an execute pass.");

                // The execute pass busts once when drops and markers materialize.
                // DEFER passes following the execute pass are byte-stable.
                const firstDeferIndex = h.mock.requests().length;
                for (let i = 4; i <= 8; i++) {
                    setDefer(`A2 defer reply ${i}`);
                    await h.sendPrompt(sessionId, `A2 turn ${i}: defer growth after execute.`);
                }

                // `findBusts` evaluates only the post-execute DEFER window.
                const deferRequests = mainAgentRequests(h.mock.requests().slice(firstDeferIndex));
                expect(deferRequests.length).toBeGreaterThanOrEqual(4);
                const busts = findBusts(deferRequests);
                if (busts.length > 0) {
                    console.error(
                        `[cache-invariant:A2-post-execute-defer] ${busts.length} bust(s):\n${formatBustReport(busts)}`,
                    );
                }
                expect(busts.length).toBe(0);
            }, 150_000);
        });
    });

    describe("#given an aged ctx_reduce call in the conversation (A3 — the regression)", () => {
        describe("#when pure-defer turns grow the tail past the protected window", () => {
            it("#then the ctx_reduce message never vanishes mid-prefix and the prefix never busts", async () => {
                const observation = await driveAgedCtxReduceSurvival(h);

                if (observation.bustReport) {
                    console.error(
                        `[cache-invariant:A3-ctx_reduce-defer-growth] ${observation.bustCount} bust(s):\n${observation.bustReport}`,
                    );
                }
                expect(observation.sawReduceOnWire).toBe(true);
                expect(observation.finalWireHasCtxReduce).toBe(true);
                const result = verifyAgedCtxReduceSurvival(observation);
                expect(failedCheckIds(result)).toEqual([]);
                expect(result.verdict).toBe("pass");
            }, 150_000);
        });
    });
});

describe("cache invariants — m[0]/m[1] taxonomy (B class)", () => {
    describe("#given a compartment published after m[0] materialized empty (B9 — the seq-refold regression)", () => {
        describe("#when publication surfaces and defer passes follow", () => {
            it(
                RUST_MODE
                    ? "#then the one-time renderer transition folds into m[0], then defer replay freezes"
                    : "#then m[0] stays empty/frozen (SOFT) — the compartment rides m[1], never folds into m[0]",
                async () => {
                    // TypeScript materializes an empty m[0] before the compartment exists.
                    // Rust consumes a renderer transition when the first compartment appears.
                    installHistorianMatcher(h);
                    const sessionId = await h.createSession();

                    // An early execute pass materializes EMPTY m[0] before any compartments exist.
                    // The pass after the execute pass materializes empty m[0].
                    setDefer("B9 warm 1");
                    await h.sendPrompt(sessionId, "B9 turn 1: warmup.");
                    h.mock.setDefault({
                        text: "B9 high",
                        usage: RUST_MODE
                            ? { input_tokens: 19_000, output_tokens: 20, cache_creation_input_tokens: 19_000, cache_read_input_tokens: 0 }
                            : EXECUTE_USAGE,
                    });
                    await h.sendPrompt(sessionId, "B9 turn 2: high usage marks the next pass execute.");
                    setDefer("B9 materialize-empty");
                    await h.sendPrompt(sessionId, "B9 turn 3: execute pass materializes empty m[0].");

                    const m0BaselineEmpty = wireValueText(
                        extractM0(mainAgentRequests(h.mock.requests()).at(-1)!.body),
                    );
                    expect(m0BaselineEmpty).toContain("<session-history></session-history>");

                    for (let i = 4; i <= 11; i++) {
                        setDefer(`B9 reply ${i}`);
                        await h.sendPrompt(sessionId, `B9 turn ${i}: durable content for compartment chunk ${i}. ${h.ballast(3_000)}`);
                    }
                    h.mock.setDefault({ text: "B9 trigger", usage: HISTORIAN_TRIGGER_USAGE });
                    await h.sendPrompt(sessionId, "B9 turn 12: high-usage historian trigger.");
                    setDefer("B9 post-trigger");
                    await h.sendPrompt(sessionId, "B9 turn 13: follow-up starts + awaits the historian publish.");

                    if (RUST_MODE) {
                        await waitForRustCompartment(sessionId);
                        setDefer("B9 surface published Rust compartment");
                        await h.sendPrompt(sessionId, "B9 turn 14: surface the published compartment.");
                    } else {
                        await h.waitFor(() => h.countCompartments(sessionId) >= 1, {
                            timeoutMs: 60_000,
                            label: "B9 compartment publishes to DB",
                        });
                    }

                    // TypeScript keeps the additive publication in m[1].
                    // Rust consumes the pending hard transition for the newly detected renderer shape before replaying it.
                    const requests = mainAgentRequests(h.mock.requests());
                    const surfaceReq = RUST_MODE
                        ? requests.at(-1)
                        : requests.find((r) => wireValueText(extractM1(r.body)).includes("<new-compartments>"));
                    expect(surfaceReq).toBeDefined();
                    const m1 = wireValueText(extractM1(surfaceReq!.body));
                    const m0 = wireValueText(extractM0(surfaceReq!.body));
                    if (RUST_MODE) {
                        expect(m0).toContain("Hermetic Broca chunk");
                        expect(m0).not.toBe(m0BaselineEmpty!);
                        expect(m1).not.toContain("<new-compartments>");
                    } else {
                        expect(m1).toContain("<new-compartments>");
                        expect(m1).toContain("</new-compartments>");
                        expect(m0).toBe(m0BaselineEmpty!);
                    }

                    const surfaceIdx = requests.indexOf(surfaceReq!);
                    setDefer("B9 replay 1");
                    await h.sendPrompt(
                        sessionId,
                        RUST_MODE
                            ? "B9 turn 15: defer replay of the surfaced compartment."
                            : "B9 turn 14: defer replay of the surfaced compartment.",
                    );
                    setDefer("B9 replay 2");
                    await h.sendPrompt(
                        sessionId,
                        RUST_MODE ? "B9 turn 16: defer replay again." : "B9 turn 15: defer replay again.",
                    );

                    // Both message lanes remain byte-identical from the surface request through every subsequent defer-only replay.
                    const after = mainAgentRequests(h.mock.requests()).slice(surfaceIdx);
                    const m1s = new Set(after.map((r) => wireValueText(extractM1(r.body))));
                    const m0s = new Set(after.map((r) => wireValueText(extractM0(r.body))));
                    expect(m1s.size).toBe(1);
                    expect(m0s.size).toBe(1);

                    const replayPair = mainAgentRequests(h.mock.requests()).slice(-2);
                    const busts = findBusts(replayPair);
                    if (busts.length > 0) {
                        console.error(
                            `[cache-invariant:B9-soft-publish] ${busts.length} bust(s):\n${formatBustReport(busts)}`,
                        );
                    }
                    expect(busts.length).toBe(0);
                },
                220_000,
            );
        });
    });

});
