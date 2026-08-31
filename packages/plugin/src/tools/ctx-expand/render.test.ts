import { describe, expect, test } from "bun:test";

import { setRawMessageProvider } from "../../hooks/magic-context/read-session-chunk";
import type { RawMessage } from "../../hooks/magic-context/read-session-raw";
import { renderMessageByOrdinal, renderVerboseRange } from "./render";

const SESSION = "ses-render-test";

function provide(messages: RawMessage[]): () => void {
    return setRawMessageProvider(SESSION, {
        readMessages: () => messages,
        readMessageById: (id) => messages.find((m) => m.id === id) ?? null,
    });
}

function ocTool(tool: string, callID: string, input: unknown, output: unknown): unknown {
    return { type: "tool", tool, callID, state: { input, output } };
}

describe("renderVerboseRange", () => {
    test("lists each message separately with id + per-part preview", () => {
        const cleanup = provide([
            {
                ordinal: 10,
                id: "msg_a",
                role: "user",
                parts: [{ type: "text", text: "please read the config" }],
            },
            {
                ordinal: 11,
                id: "msg_b",
                role: "assistant",
                parts: [
                    { type: "text", text: "Reading it now." },
                    ocTool("read", "read:1", { filePath: "config.ts" }, "line1\nline2\nline3"),
                ],
            },
        ]);
        try {
            const out = renderVerboseRange(SESSION, 10, 11, 15_000);
            expect(out.text).toContain("[10] U (user)");
            expect(out.text).toContain("[11] A (assistant)");
            expect(out.text).toContain("tool read(config.ts)");
            expect(out.text).toMatch(/→ output ~\d+ tok/);
            expect(out.text).not.toContain("line2");
            expect(out.lastOrdinal).toBe(11);
            expect(out.truncated).toBe(false);
        } finally {
            cleanup();
        }
    });

    test("only includes messages within [start,end]", () => {
        const cleanup = provide([
            { ordinal: 5, id: "msg_before", role: "user", parts: [{ type: "text", text: "x" }] },
            { ordinal: 10, id: "msg_in", role: "user", parts: [{ type: "text", text: "y" }] },
            { ordinal: 99, id: "msg_after", role: "user", parts: [{ type: "text", text: "z" }] },
        ]);
        try {
            const out = renderVerboseRange(SESSION, 10, 20, 15_000);
            expect(out.text).toContain("[10] U (user)");
            expect(out.text).not.toContain("[5] U (user)");
            expect(out.text).not.toContain("[99] U (user)");
        } finally {
            cleanup();
        }
    });

    test("token budget truncates across many messages and reports continuation", () => {
        // With a 30-token budget, the first block fits and the second does not.
        const text = "word ".repeat(40);
        const cleanup = provide([
            { ordinal: 1, id: "m1", role: "user", parts: [{ type: "text", text }] },
            { ordinal: 2, id: "m2", role: "user", parts: [{ type: "text", text }] },
            { ordinal: 3, id: "m3", role: "user", parts: [{ type: "text", text }] },
        ]);
        try {
            const out = renderVerboseRange(SESSION, 1, 3, 30);
            expect(out.text).toContain("[1] U (user)");
            expect(out.truncated).toBe(true);
            expect(out.lastOrdinal).toBe(1);
        } finally {
            cleanup();
        }
    });
});

describe("renderMessageByOrdinal", () => {
    test("recovers the FULL untruncated tool output (the ctx_reduce way-back)", () => {
        const fullOutput = "ERROR at line 42\n".repeat(50);
        const cleanup = provide([
            {
                ordinal: 7,
                id: "msg_tool",
                role: "assistant",
                parts: [ocTool("bash", "bash:9", { description: "run tests" }, fullOutput)],
            },
        ]);
        try {
            const out = renderMessageByOrdinal(SESSION, 7);
            expect(out).toContain("[7] A (assistant)");
            expect(out).toContain("[tool: bash #bash:9]");
            expect(out).toContain(fullOutput.trim().slice(0, 30));
            expect(out).toContain("input:");
        } finally {
            cleanup();
        }
    });

    test("strips step-start/step-finish/reasoning noise — only tool input+output remain", () => {
        const cleanup = provide([
            {
                ordinal: 9,
                id: "msg_noisy",
                role: "assistant",
                parts: [
                    { type: "step-start" },
                    { type: "reasoning", text: "thinking about which file to read" },
                    {
                        type: "tool",
                        tool: "read",
                        callID: "read:3",
                        state: {
                            status: "completed",
                            input: { filePath: "a.ts" },
                            output: "the recovered output",
                            title: "Read a.ts",
                        },
                    },
                    {
                        type: "step-finish",
                        reason: "tool-calls",
                        tokens: { total: 1234, cache: { read: 999 } },
                    },
                ],
            },
        ]);
        try {
            const out = renderMessageByOrdinal(SESSION, 9);
            expect(out).toContain("[tool: read #read:3]");
            expect(out).toContain("description: Read a.ts");
            expect(out).toContain("the recovered output");
            // Noise stripped.
            expect(out).not.toContain("step-start");
            expect(out).not.toContain("step-finish");
            expect(out).not.toContain("reasoning");
            expect(out).not.toContain("thinking about which file");
            expect(out).not.toContain("1234");
        } finally {
            cleanup();
        }
    });

    test("recovers a non-tool user message in full (any role)", () => {
        const paste = "a very long pasted log\n".repeat(20);
        const cleanup = provide([
            { ordinal: 3, id: "msg_paste", role: "user", parts: [{ type: "text", text: paste }] },
        ]);
        try {
            const out = renderMessageByOrdinal(SESSION, 3);
            expect(out).toContain("[3] U (user)");
            expect(out).toContain("[text]");
            expect(out).toContain(paste.trim().slice(0, 30));
        } finally {
            cleanup();
        }
    });

    test("missing ordinal reports deleted, does not throw", () => {
        const cleanup = provide([
            { ordinal: 1, id: "exists", role: "user", parts: [{ type: "text", text: "hi" }] },
        ]);
        try {
            const out = renderMessageByOrdinal(SESSION, 999);
            expect(out).toContain("No message at ordinal 999");
            expect(out).toContain("deleted");
        } finally {
            cleanup();
        }
    });
});
