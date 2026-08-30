/// <reference types="bun-types" />

import { afterAll, describe, expect, it } from "bun:test";
import { realpathSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { TestHarness } from "../src/harness";
import { PiTestHarness } from "../src/pi-harness";
import { promoteMemoryToVerified } from "../src/test-db";

let oc: TestHarness | null = null;
let pi: PiTestHarness | null = null;

afterAll(async () => {
    await pi?.dispose();
    await oc?.dispose();
});

function emitMemoryWriteOnce(mock: TestHarness["mock"], content: string): void {
    let emitted = false;
    mock.addMatcher((body) => {
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
                    id: `toolu_cross_memory_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
                    name: memoryTool.name,
                    input: { action: "create", category: "PROJECT_RULES", content },
                },
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 100 },
        };
    });
}

describe("pi cross harness", () => {
    it("shares public-tool project memory writes between OpenCode and Pi both directions", async () => {
        oc = await TestHarness.create();
        const sharedWorkdir = realpathSync(pathResolve(oc.opencode.env.workdir));
        pi = await PiTestHarness.create({
            sharedDataDir: oc.opencode.env.dataDir,
            workdir: sharedWorkdir,
        });

        oc.mock.reset();
        oc.mock.setDefault({
            text: "oc bootstrap",
            usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 100 },
        });
        const ocSession = await oc.createSession();
        await oc.sendPrompt(ocSession, "bootstrap opencode shared db");

        pi.mock.reset();
        pi.mock.setDefault({
            text: "pi bootstrap",
            usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 100 },
        });
        await pi.sendPrompt("bootstrap pi shared db", { timeoutMs: 60_000 });

        const fromOpenCode = "OpenCode wrote this memory for Pi flagship search";
        emitMemoryWriteOnce(oc.mock, fromOpenCode);
        await oc.sendPrompt(ocSession, "remember this workflow rule for Pi");
        // v86 trust policy: agent writes start CANDIDATE and are hidden from
        // automatic injection; promote through the real verification API.
        promoteMemoryToVerified(pi.contextDbPath(), fromOpenCode);
        await pi.newSession();

        pi.mock.reset();
        pi.mock.setDefault({
            text: "Pi sees OpenCode memory",
            usage: { input_tokens: 140, output_tokens: 10, cache_creation_input_tokens: 140 },
        });
        await pi.sendPrompt("read flagship memory from pi", { timeoutMs: 60_000 });
        // Pi now injects shared project memories into <session-history>
        // (parity with OpenCode), so the cross-harness check is on the
        // outbound provider request body, not on `ctx_search` output —
        // visible memories are intentionally filtered from search results
        // to avoid duplicate context. Mirrors the OpenCode-side assertion
        // below.
        expect(JSON.stringify(pi.mock.lastRequest()!.body)).toContain(fromOpenCode);

        const fromPi = "Pi wrote this memory for OpenCode injection";
        emitMemoryWriteOnce(pi.mock, fromPi);
        await pi.sendPrompt("remember this workflow rule for OpenCode", { timeoutMs: 60_000 });
        promoteMemoryToVerified(pi.contextDbPath(), fromPi);

        oc.mock.reset();
        oc.mock.setDefault({
            text: "oc sees pi",
            usage: { input_tokens: 130, output_tokens: 10, cache_creation_input_tokens: 130 },
        });
        const ocReadSession = await oc.createSession();
        await oc.sendPrompt(ocReadSession, "read pi memory from opencode");
        expect(JSON.stringify(oc.mock.lastRequest()!.body)).toContain(fromPi);
    }, 300_000);
});
