/// <reference types="bun-types" />

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { TestHarness } from "../src/harness";

/**
 */

let h: TestHarness;

beforeAll(async () => {
    h = await TestHarness.create();
});

afterAll(async () => {
    await h.dispose();
});

describe("e2e smoke", () => {
    it("mock server and opencode serve are reachable", () => {
        expect(h.opencode.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    });

    it("sends a prompt, mock captures it, plugin initializes its DB", async () => {
        h.mock.reset();
        h.mock.setDefault({
            text: "response from mock",
            usage: {
                input_tokens: 100,
                output_tokens: 20,
                cache_creation_input_tokens: 100,
                cache_read_input_tokens: 0,
            },
        });

        const sessionId = await h.createSession();
        await h.sendPrompt(sessionId, "hi there");

        //
        // distinguish.
        await h.waitFor(
            () => {
                const hits = h.mock.requests().filter((r) => {
                    const body = JSON.stringify(r.body);
                    if (!body.includes("hi there")) return false;
                    if (body.includes("You are a title generator")) return false;
                    if (body.includes("Generate a title for this conversation:")) return false;
                    if (body.includes("Generate a summary of the conversation")) return false;
                    if (body.includes("Compress the conversation history")) return false;
                    return true;
                });
                return hits.length > 0;
            },
            { timeoutMs: 10_000, label: "main-agent request captured" },
        );

        const requests = h.mock.requests();
        expect(requests.length).toBeGreaterThanOrEqual(1);

        // The Magic Context assertion distinguishes plugin injection from request transport.
        const mainAgentBody = requests
            .map((r) => JSON.stringify(r.body))
            .find(
                (b) =>
                    b.includes("hi there") &&
                    !b.includes("You are a title generator") &&
                    !b.includes("Generate a title for this conversation:") &&
                    !b.includes("Generate a summary of the conversation") &&
                    !b.includes("Compress the conversation history"),
            );
        expect(mainAgentBody, "main-agent request not captured").toBeDefined();
        expect(mainAgentBody).toContain("Magic Context");

        // Plugin created its DB and ran the transform (at least one tag persisted).
        await h.waitFor(() => h.hasContextDb(), { timeoutMs: 5000, label: "context.db created" });
        await h.waitFor(() => h.countTags(sessionId) > 0, {
            timeoutMs: 5000,
            label: "tags persisted",
        });
        expect(h.countTags(sessionId)).toBeGreaterThan(0);
    }, 60_000);
});
