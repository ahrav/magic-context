/// <reference types="bun-types" />

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { TestHarness } from "../src/harness";

/**
 *
 */

let h: TestHarness;

beforeAll(async () => {
    h = await TestHarness.create({
        openCodeConfigExtra: {
            compaction: { auto: true, prune: false },
        },
    });
});

afterAll(async () => {
    await h.dispose();
});

describe("conflict detection", () => {
    it(
        "plugin disables itself when opencode auto-compaction is active",
        async () => {
            h.mock.reset();
            h.mock.setDefault({
                text: "ok",
                usage: {
                    input_tokens: 100,
                    output_tokens: 10,
                    cache_creation_input_tokens: 50,
                    cache_read_input_tokens: 50,
                },
            });

            const sessionId = await h.createSession();
            await h.sendPrompt(sessionId, "hello — should not be tagged.");

            await Bun.sleep(500);

            expect(h.hasContextDb()).toBe(false);
        },
        60_000,
    );
});
