/// <reference types="bun-types" />

/**
 *
 */

import { describe, expect, it } from "bun:test";
import {
    extractM0,
    extractM1,
    findBusts,
    formatBustReport,
    mainAgentRequests,
} from "../src/cache-analysis";
import type { CapturedRequest, MockUsage } from "../src/mock-provider/server";
import { PiTestHarness } from "../src/pi-harness";

const HISTORIAN_SYSTEM_MARKER = "the hippocampus of a long-running coding agent";
const MODEL_LIMIT = 100_000;

const LOW_USAGE: MockUsage = {
    input_tokens: 2_000,
    output_tokens: 20,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 2_000,
};

// Above execute_threshold (20% of 100k = 20k) → the next pass executes.
const HIGH_USAGE: MockUsage = {
    input_tokens: 30_000,
    output_tokens: 20,
    cache_creation_input_tokens: 30_000,
    cache_read_input_tokens: 0,
};

// 90,000 input tokens trigger the historian while remaining below the 100,000-token model limit.
const HISTORIAN_TRIGGER_USAGE: MockUsage = {
    input_tokens: 90_000,
    output_tokens: 20,
    cache_creation_input_tokens: 90_000,
    cache_read_input_tokens: 0,
};

function isHistorianRequest(body: Record<string, unknown>): boolean {
    const system = body.system;
    if (typeof system === "string") return system.includes(HISTORIAN_SYSTEM_MARKER);
    if (Array.isArray(system)) {
        return system.some(
            (b) =>
                b &&
                typeof b === "object" &&
                typeof (b as { text?: unknown }).text === "string" &&
                ((b as { text: string }).text).includes(HISTORIAN_SYSTEM_MARKER),
        );
    }
    return false;
}

/* */
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

function installHistorianMatcher(h: PiTestHarness): void {
    h.mock.addMatcher((body) => {
        if (!isHistorianRequest(body)) return null;
        const range = findOrdinalRange(body);
        const usage: MockUsage = {
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
            `<compartment start="${range.start}" end="${range.end}" title="pi cache-invariant chunk" importance="50" episode_type="feature">`,
            "<p1>Driven by the Pi cache-invariant harness exercising the m[0]/m[1] SOFT-delta taxonomy.</p1>",
            "<p2>Pi cache-invariant chunk exercising historian publish.</p2>",
            "<p3>pi cache-invariant chunk</p3>",
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

function mainRequests(h: PiTestHarness): CapturedRequest[] {
    return mainAgentRequests(h.mock.requests());
}

function requestText(request: CapturedRequest | undefined): string {
    return JSON.stringify(request?.body ?? {});
}

function countCompartments(h: PiTestHarness, sessionId: string): number {
    try {
        const row = h
            .contextDb()
            .prepare("SELECT COUNT(*) AS n FROM compartments WHERE session_id = ?")
            .get(sessionId) as { n: number } | null;
        return row?.n ?? 0;
    } catch {
        return 0;
    }
}

function readOldestActiveTag(h: PiTestHarness, sessionId: string): number {
    const row = h
        .contextDb()
        .prepare(
            "SELECT tag_number AS tag FROM tags WHERE session_id = ? AND harness = 'pi' AND type = 'message' AND status = 'active' ORDER BY tag_number ASC LIMIT 1",
        )
        .get(sessionId) as { tag: number } | null;
    return row?.tag ?? 0;
}

/* */
function emitCtxReduceOnce(h: PiTestHarness, drop: string): void {
    let emitted = false;
    h.mock.addMatcher((body) => {
        if (emitted) return null;
        const sys = JSON.stringify(body.system ?? "");
        if (!sys.includes("## Magic Context")) return null;
        const tools = Array.isArray(body.tools) ? body.tools : [];
        const name = tools
            .map((t) => (t && typeof t === "object" ? (t as { name?: unknown }).name : null))
            .find((n) => typeof n === "string" && /^ctx_reduce$/.test(n)) as string | undefined;
        if (!name) return null;
        emitted = true;
        return {
            content: [
                {
                    type: "tool_use",
                    id: `toolu_pi_ci_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
                    name,
                    input: { drop },
                },
            ],
            stop_reason: "tool_use" as const,
            usage: LOW_USAGE,
        };
    });
}

async function waitForLeaseFree(h: PiTestHarness, sessionId: string, label: string): Promise<void> {
    await h.waitFor(
        () => {
            try {
                const lease = h
                    .contextDb()
                    .prepare("SELECT holder_id FROM compartment_state_lease WHERE session_id = ?")
                    .get(sessionId) as { holder_id: string } | null;
                return lease === null ? true : null;
            } catch {
                return true;
            }
        },
        { timeoutMs: 60_000, label },
    );
}

function assertNoBusts(label: string, requests: CapturedRequest[]): void {
    expect(requests.length).toBeGreaterThanOrEqual(2);
    const busts = findBusts(requests);
    if (busts.length > 0) {
        console.error(`[pi-cache-invariant:${label}] ${busts.length} bust(s):\n${formatBustReport(busts)}`);
    }
    expect({ label, busts: busts.length }).toEqual({ label, busts: 0 });
}

async function createHarness(): Promise<PiTestHarness> {
    return PiTestHarness.create({
        modelContextLimit: MODEL_LIMIT,
        magicContextConfig: {
            execute_threshold_percentage: 20,
            protected_tags: 1,
            dreamer: { disable: true },
            sidekick: { disable: true },
            compressor: { enabled: false },
            historian: { model: "anthropic/claude-haiku-4-5" },
            memory: {
                enabled: true,
                auto_promote: false,
                auto_search: { enabled: false },
                git_commit_indexing: { enabled: false },
            },
        },
    });
}

async function sendTurn(
    h: PiTestHarness,
    prompt: string,
    responseText: string,
    usage: MockUsage = LOW_USAGE,
    timeoutMs = 90_000,
): Promise<void> {
    h.mock.setDefault({ text: responseText, usage });
    await h.sendPrompt(prompt, { timeoutMs, continueSession: true });
}

describe("pi cache invariants — replay class", () => {
    it("A1: low-pressure pure-defer growth never busts the cached prefix", async () => {
        const h = await createHarness();
        try {
            for (let i = 1; i <= 6; i++) {
                await sendTurn(h, `pi A1 turn ${i}: low-pressure cache-stability probe.`, `pi A1 reply ${i}`);
            }

            const requests = mainRequests(h);
            expect(requests.length).toBeGreaterThanOrEqual(6);
            assertNoBusts("A1-low-pressure-defer", requests);
        } finally {
            await h.dispose();
        }
    }, 180_000);

    it("A2: defer passes after an execute pass have zero busts", async () => {
        const h = await createHarness();
        try {
            await sendTurn(h, "pi A2 turn 1: warmup.", "pi A2 warmup 1");
            await sendTurn(h, "pi A2 turn 2: warmup.", "pi A2 warmup 2");
            await sendTurn(h, "pi A2 turn 3: high usage marks next pass execute.", "pi A2 high usage", HIGH_USAGE);

            const firstPostExecuteIndex = mainRequests(h).length;
            for (let i = 4; i <= 8; i++) {
                await sendTurn(h, `pi A2 turn ${i}: defer growth after execute.`, `pi A2 defer reply ${i}`);
            }

            const postExecuteWindow = mainRequests(h).slice(firstPostExecuteIndex);
            assertNoBusts("A2-post-execute-defer", postExecuteWindow);
        } finally {
            await h.dispose();
        }
    }, 220_000);

    it("A3: materialized ctx_reduce placeholders do not vanish during defer growth", async () => {
        const h = await createHarness();
        try {
            await sendTurn(h, "pi A3 turn 1: establish reducible baseline content.", "pi A3 reply 1");
            const sessionId = h.lastTurn?.sessionId ?? "";
            expect(sessionId).toBeTruthy();
            const reduceTarget = await h.waitFor(() => readOldestActiveTag(h, sessionId), {
                timeoutMs: 60_000,
                label: "pi A3 active tag for ctx_reduce",
            });
            expect(reduceTarget).toBeGreaterThan(0);

            emitCtxReduceOnce(h, String(reduceTarget));
            await sendTurn(h, `pi A3 turn 2: issue ctx_reduce for old tag ${reduceTarget}.`, "pi A3 after ctx_reduce");
            await sendTurn(h, "pi A3 turn 3: pressure so pending drop applies next.", "pi A3 pressure", HIGH_USAGE);
            await sendTurn(h, "pi A3 turn 4: execute pass materializes the dropped placeholder.", "pi A3 materialize");

            await h.waitFor(
                () => {
                    const row = h
                        .contextDb()
                        .prepare("SELECT status FROM tags WHERE session_id = ? AND tag_number = ? AND harness = 'pi'")
                        .get(sessionId, reduceTarget) as { status: string } | null;
                    return row?.status === "dropped" ? true : null;
                },
                { timeoutMs: 60_000, label: "pi A3 ctx_reduce target dropped" },
            );
            expect(requestText(mainRequests(h).at(-1))).toContain("[dropped");

            const postReduceStart = mainRequests(h).length - 1;
            for (let i = 5; i <= 8; i++) {
                await sendTurn(h, `pi A3 turn ${i}: low-pressure defer growth ages the placeholder.`, `pi A3 defer ${i}`);
            }

            const postReduceWindow = mainRequests(h).slice(postReduceStart);
            assertNoBusts("A3-ctx_reduce-placeholder-defer", postReduceWindow);
            expect(requestText(mainRequests(h).at(-1))).toContain("[dropped");
        } finally {
            await h.dispose();
        }
    }, 260_000);
});

describe("pi cache invariants — m[0]/m[1] taxonomy", () => {
    it("B9: published compartments ride m[1] while m[0] and m[1] replay byte-identically", async () => {
        const h = await createHarness();
        try {
            installHistorianMatcher(h);

            // The test forces an early execute so the baseline session-history block materializes empty before any compartment exists.
            await sendTurn(h, "pi B9 turn 1: warmup.", "pi B9 warm");
            const sessionId = h.lastTurn?.sessionId ?? "";
            expect(sessionId).toBeTruthy();
            await sendTurn(h, "pi B9 turn 2: high usage marks next pass execute.", "pi B9 high", HIGH_USAGE);
            await sendTurn(h, "pi B9 turn 3: execute pass materializes empty m[0].", "pi B9 materialize");

            const m0BaselineEmpty = extractM0(mainRequests(h).at(-1)!.body);
            expect(m0BaselineEmpty).toContain("<session-history></session-history>");

            for (let i = 4; i <= 11; i++) {
                await sendTurn(
                    h,
                    `pi B9 turn ${i}: durable content for compartment chunk ${i}. ${h.ballast(3_000)}`,
                    `pi B9 reply ${i}`,
                );
            }
            await sendTurn(h, "pi B9 turn 12: high-usage historian trigger.", "pi B9 trigger", HISTORIAN_TRIGGER_USAGE, 120_000);
            await sendTurn(h, "pi B9 turn 13: follow-up starts + awaits the historian publish.", "pi B9 post", LOW_USAGE, 120_000);

            await h.waitFor(() => countCompartments(h, sessionId) >= 1, {
                timeoutMs: 120_000,
                label: "pi B9 compartment publishes",
            });

            // If the historian holds the lease, Pi defers mutations, so the test continues execute-eligible turns until the lease releases.
            let surfaceReq = mainRequests(h).find((r) => extractM1(r.body)?.includes("<new-compartments>"));
            for (let attempt = 0; attempt < 4 && !surfaceReq; attempt++) {
                await waitForLeaseFree(h, sessionId, "historian lease free before B9 surface execute");
                await sendTurn(h, `pi B9 turn ${14 + attempt}: execute pass to surface.`, `pi B9 surface ${attempt}`, HIGH_USAGE);
                surfaceReq = mainRequests(h).find((r) => extractM1(r.body)?.includes("<new-compartments>"));
            }

            expect(surfaceReq).toBeDefined();
            const m1 = extractM1(surfaceReq!.body)!;
            const m0 = extractM0(surfaceReq!.body)!;
            expect(m1).toContain("<new-compartments>");
            expect(m1).toContain("pi cache-invariant chunk");
            expect(m0).not.toContain("pi cache-invariant chunk");
            expect(m0).toBe(m0BaselineEmpty!);

            const surfaceIdx = mainRequests(h).indexOf(surfaceReq!);
            await sendTurn(h, "pi B9 defer replay 1.", "pi B9 replay 1");
            await sendTurn(h, "pi B9 defer replay 2.", "pi B9 replay 2");

            const after = mainRequests(h).slice(surfaceIdx);
            expect(new Set(after.map((r) => extractM1(r.body))).size).toBe(1);
            expect(new Set(after.map((r) => extractM0(r.body))).size).toBe(1);
            assertNoBusts("B9-soft-publish-replay", mainRequests(h).slice(-2));
        } finally {
            await h.dispose();
        }
    }, 360_000);


});
