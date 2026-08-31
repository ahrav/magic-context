/// <reference types="bun-types" />

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { TestHarness } from "../src/harness";

/**
 *
 * magic-context keeps the Anthropic prompt cache alive across turns.
 * The plugin must produce a byte-identical prefix on every defer-pass transform to preserve the cache across turns.
 * Each defer-pass transform must preserve a byte-identical prefix containing the system prompt and prior messages.
 *
 * OpenCode moves cache_control to the latest message each turn.
 * comparing.
 *
 *
 *   1. The system field text stays byte-identical across turns 2..N.
 * The prefix excludes the latest user turn and must remain byte-identical across turns 2..N after stripping `cache_control`.
 *
 */

let h: TestHarness;

beforeAll(async () => {
    h = await TestHarness.create({
        magicContextConfig: {
            execute_threshold_percentage: 80,
        },
    });
});

afterAll(async () => {
    await h.dispose();
});

/** stripCacheControl removes `cache_control` because OpenCode moves it to the latest message each turn. */
function stripCacheControl(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stripCacheControl);
    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) {
            if (k === "cache_control") continue;
            out[k] = stripCacheControl(v);
        }
        return out;
    }
    return value;
}

function serialize(value: unknown): string {
    return JSON.stringify(stripCacheControl(value));
}

describe("cache stability", () => {
    it("system prompt stays stable across defer passes", async () => {
        h.mock.reset();
        h.mock.setDefault({
            text: "ok",
            usage: {
                input_tokens: 200,
                output_tokens: 10,
                cache_creation_input_tokens: 100,
                cache_read_input_tokens: 100,
            },
        });

        const sessionId = await h.createSession();

        const turnCount = 5;
        for (let i = 1; i <= turnCount; i++) {
            await h.sendPrompt(sessionId, `turn ${i}: probe message for cache stability.`);
        }

        const mainRequests = h.mock.requests().filter((r) => {
            const sys = r.body.system;
            if (sys === undefined || sys === null) return false;
            const asString = typeof sys === "string" ? sys : JSON.stringify(sys);
            return asString.includes("## Magic Context");
        });
        expect(mainRequests.length).toBeGreaterThanOrEqual(turnCount);

        // The test excludes turn 1 because it establishes the cache.
        // The comparison strips `cache_control` because OpenCode moves it to the latest message each turn.
        const systems = new Set<string>();
        for (let i = 1; i < mainRequests.length; i++) {
            systems.add(serialize(mainRequests[i]!.body.system));
        }
        if (systems.size !== 1) {
            console.log(`[TEST] ${systems.size} distinct system variants`);
        }
        expect(systems.size).toBe(1);
    }, 60_000);

    it("prefix messages stay stable across defer passes", async () => {
        h.mock.reset();
        h.mock.setDefault({
            text: "ok",
            usage: {
                input_tokens: 200,
                output_tokens: 10,
                cache_creation_input_tokens: 100,
                cache_read_input_tokens: 100,
            },
        });

        const sessionId = await h.createSession();

        const turnCount = 5;
        for (let i = 1; i <= turnCount; i++) {
            await h.sendPrompt(sessionId, `turn ${i}: probe message for cache stability.`);
        }

        const mainRequests = h.mock.requests().filter((r) => {
            const sys = r.body.system;
            if (sys === undefined || sys === null) return false;
            const asString = typeof sys === "string" ? sys : JSON.stringify(sys);
            return asString.includes("## Magic Context");
        });
        expect(mainRequests.length).toBeGreaterThanOrEqual(turnCount);

        // After stripping `cache_control`, each earlier request's messages must be a byte-identical prefix of the next request's messages.
        for (let i = 1; i < mainRequests.length - 1; i++) {
            const earlier = mainRequests[i]!.body.messages as unknown[];
            const later = mainRequests[i + 1]!.body.messages as unknown[];
            expect(earlier.length).toBeLessThanOrEqual(later.length);
            for (let j = 0; j < earlier.length; j++) {
                const earlierMsg = serialize(earlier[j]);
                const laterMsg = serialize(later[j]);
                if (earlierMsg !== laterMsg) {
                    console.log(
                        `[TEST] prefix mismatch at turn pair ${i}/${i + 1} message ${j}:`,
                    );
                    console.log(`  earlier: ${earlierMsg.slice(0, 300)}`);
                    console.log(`  later:   ${laterMsg.slice(0, 300)}`);
                }
                expect(earlierMsg).toBe(laterMsg);
            }
        }
    }, 60_000);
});
