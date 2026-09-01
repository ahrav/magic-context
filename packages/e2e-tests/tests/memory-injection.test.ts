/// <reference types="bun-types" />

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { TestHarness } from "../src/harness";
import { promoteMemoryToVerified } from "../src/test-db";

/**
 *
 *
 */

let h: TestHarness;

beforeAll(async () => {
    h = await TestHarness.create();
});

afterAll(async () => {
    await h.dispose();
});

function emitMemoryWriteOnce(content: string): void {
    let emitted = false;
    h.mock.addMatcher((body) => {
        if (emitted || !JSON.stringify(body.system ?? "").includes("## Magic Context")) return null;
        const tools = body.tools;
        if (!Array.isArray(tools)) return null;
        const memoryTool = tools.find(
            (tool) =>
                tool !== null &&
                typeof tool === "object" &&
                (tool as { name?: unknown }).name === "ctx_memory",
        ) as { name: string } | undefined;
        if (!memoryTool) return null;
        emitted = true;
        return {
            content: [
                {
                    type: "tool_use",
                    id: `toolu_memory_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
                    name: memoryTool.name,
                    input: { action: "create", category: "PROJECT_RULES", content },
                },
            ],
            stop_reason: "tool_use",
            usage: {
                input_tokens: 100,
                output_tokens: 10,
                cache_creation_input_tokens: 100,
                cache_read_input_tokens: 0,
            },
        };
    });
}

describe("memory injection", () => {
    it("injects <project-memory> on first turn even with no compartments", async () => {
        h.mock.reset();
        h.mock.setDefault({
            text: "ack",
            usage: {
                input_tokens: 100,
                output_tokens: 10,
                cache_creation_input_tokens: 100,
                cache_read_input_tokens: 0,
            },
        });

        const directive = "test seeded directive: always prefer bun over npm for running scripts";
        const writerSessionId = await h.createSession();
        emitMemoryWriteOnce(directive);
        await h.sendPrompt(writerSessionId, "remember the project package-manager rule");
        promoteMemoryToVerified(h.contextDbPath(), directive);

        const memorySessionId = await h.createSession();

        // Resetting the mock excludes requests from the writer session.
        h.mock.reset();
        h.mock.setDefault({
            text: "ack 2",
            usage: {
                input_tokens: 150,
                output_tokens: 10,
                cache_creation_input_tokens: 150,
                cache_read_input_tokens: 0,
            },
        });

        await h.sendPrompt(memorySessionId, "first turn after seeded memory");

        const req = h.mock.lastRequest();
        expect(req).not.toBeNull();

        // fullBody lets the assertions search every request-body field.
        const fullBody = JSON.stringify(req!.body);
        expect(fullBody).toContain("<session-history>");
        expect(fullBody).toContain("<project-memory>");
        expect(fullBody).toContain(directive);
        expect(fullBody).not.toContain("<summary");
    }, 60_000);
});
