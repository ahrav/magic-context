/// <reference types="bun-types" />

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { PiTestHarness } from "../src/pi-harness";
import { promoteMemoryToVerified } from "../src/test-db";

let h: PiTestHarness;

beforeAll(async () => {
    h = await PiTestHarness.create();
});

afterAll(async () => {
    await h.dispose();
});

function countCompartments(sessionId: string): number {
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

function emitMemoryWriteOnce(content: string): void {
    let emitted = false;
    h.mock.addMatcher((body) => {
        if (emitted) return null;
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
                    id: `toolu_pi_memory_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
                    name: memoryTool.name,
                    input: { action: "create", category: "PROJECT_RULES", content },
                },
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 100 },
        };
    });
}

describe("pi memory injection", () => {
    it("injects <project-memory> into the Pi system prompt", async () => {
        h.mock.reset();
        h.mock.setDefault({
            text: "bootstrap",
            usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 100 },
        });
        const bootstrap = await h.sendPrompt("bootstrap pi memory db", { timeoutMs: 60_000 });
        expect(bootstrap.exitCode).toBeNull();

        const directive = "pi seeded directive: prefer stable cross-harness memory checks";
        emitMemoryWriteOnce(directive);
        await h.sendPrompt("remember the project memory directive", { timeoutMs: 60_000 });
        // v86 trust policy: an agent write starts CANDIDATE and is hidden
        // from automatic surfaces; injection needs a verified row.
        promoteMemoryToVerified(h.contextDbPath(), directive);
        await h.newSession();

        h.mock.reset();
        h.mock.setDefault({
            text: "after seed",
            usage: { input_tokens: 120, output_tokens: 10, cache_creation_input_tokens: 120 },
        });
        const assertion = await h.sendPrompt("read my project memory", { timeoutMs: 60_000 });
        expect(assertion.sessionId).toBeTruthy();

        // The assertion session has no historian output; memory injection alone
        // must build the session-history wrapper and project-memory payload.
        expect(countCompartments(assertion.sessionId!)).toBe(0);

        const body = JSON.stringify(h.mock.lastRequest()!.body);
        expect(body).toContain("<session-history>");
        expect(body).toContain("<project-memory>");
        expect(body).toContain(directive);
    }, 60_000);
});
