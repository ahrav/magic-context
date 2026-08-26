import type { TestHarness } from "./harness";
import type { MockUsage } from "./mock-provider/server";

/** Must stay below the lowest consumer execute threshold so scripted calls do not trigger compaction. */
export const DEFAULT_SCRIPTED_TOOL_USAGE: MockUsage = {
    input_tokens: 2_000,
    output_tokens: 20,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 2_000,
};

export interface ScriptedToolCallOptions {
    /** Exact published tool name, e.g. "ctx_memory". */
    tool: string;
    input: Record<string, unknown>;
    prompt: string;
    /** Usage for the tool_use response and the follow-up default. */
    usage?: MockUsage;
    followUpText?: string;
}

export interface ScriptedToolCall {
    /** Tool name as published on the provider wire. */
    publishedToolName: string;
    /** Provider-visible tool result (the wire tool_result text). */
    resultText: string;
}

interface WireContentBlock {
    type?: string;
    text?: string;
    tool_use_id?: string;
    content?: unknown;
}

export function publishedToolName(body: Record<string, unknown>, tool: string): string | null {
    const tools = body.tools;
    if (!Array.isArray(tools)) return null;
    for (const entry of tools) {
        if (!entry || typeof entry !== "object") continue;
        const name = (entry as { name?: unknown }).name;
        if (name === tool) return name;
    }
    return null;
}

function toolResultTextOf(block: WireContentBlock): string {
    const content = block.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .map((inner) =>
                inner && typeof inner === "object" ? ((inner as WireContentBlock).text ?? "") : "",
            )
            .join("\n");
    }
    return "";
}

/** Find the provider-visible tool_result for one scripted call id. */
export function findToolResultText(harness: TestHarness, callId: string): string | null {
    for (const request of harness.mock.requests()) {
        const messages = request.body.messages;
        if (!Array.isArray(messages)) continue;
        for (const message of messages) {
            const content = (message as { content?: unknown }).content;
            if (!Array.isArray(content)) continue;
            for (const block of content as WireContentBlock[]) {
                if (block?.type === "tool_result" && block.tool_use_id === callId) {
                    return toolResultTextOf(block);
                }
            }
        }
    }
    return null;
}

let scriptedCallCounter = 0;

/**
 * Drive one real tool loop and capture its provider-visible tool result.
 * Missing publication or result is an infrastructure failure, not a behavioral
 * verdict.
 *
 * Starts from `mock.reset()`, which clears the captured request history as well
 * as the queue, default response, and matchers. A turn driven before this call
 * is therefore not observable after it: the caller keeps no wire baseline
 * across the boundary, and must reinstall its own matchers and default for the
 * next step. Chained calls see only the most recent turn's requests, which is
 * what makes `findToolResultText` a bounded scan and the `published === null`
 * diagnostic name only this turn's published tools. Observe a turn before
 * scripting the next one, or capture the observation first.
 */
export async function runScriptedToolCall(
    harness: TestHarness,
    sessionId: string,
    options: ScriptedToolCallOptions,
): Promise<ScriptedToolCall> {
    const usage = options.usage ?? DEFAULT_SCRIPTED_TOOL_USAGE;
    const callId = `toolu_scripted_${++scriptedCallCounter}`;
    let published: string | null = null;
    harness.mock.reset();
    harness.mock.addMatcher((body) => {
        if (published !== null) return null;
        const name = publishedToolName(body, options.tool);
        if (!name) return null;
        published = name;
        return {
            content: [{ type: "tool_use", id: callId, name, input: options.input }],
            stop_reason: "tool_use" as const,
            usage,
        };
    });
    harness.mock.setDefault({
        text: options.followUpText ?? "scripted tool follow-up",
        usage,
    });
    await harness.sendPrompt(sessionId, options.prompt);
    if (published === null) {
        const visible = [
            ...new Set(
                harness.mock
                    .requests()
                    .flatMap((request) => request.body.tools ?? [])
                    .map((tool) =>
                        tool &&
                        typeof tool === "object" &&
                        typeof (tool as { name?: unknown }).name === "string"
                            ? (tool as { name: string }).name
                            : null,
                    )
                    .filter((name): name is string => name !== null),
            ),
        ];
        throw new Error(
            `scripted tool infrastructure error: tool ${options.tool} was never published on the provider wire (visible: ${visible.join(", ") || "none"})`,
        );
    }
    const resultText = findToolResultText(harness, callId);
    if (resultText === null) {
        throw new Error(
            `scripted tool infrastructure error: no provider-visible tool_result for scripted ${options.tool} call`,
        );
    }
    return {
        publishedToolName: published,
        resultText,
    };
}
