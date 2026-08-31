import type { TestHarness } from "./harness";
import type { MockUsage } from "./mock-provider/server";

/* */
export const DEFAULT_SCRIPTED_TOOL_USAGE: MockUsage = {
    input_tokens: 2_000,
    output_tokens: 20,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 2_000,
};

export interface ScriptedToolCallOptions {
    /** `tool` must exactly match the published tool name, such as "ctx_memory". */
    tool: string;
    input: Record<string, unknown>;
    prompt: string;
    /** `usage` applies to the `tool_use` response and the follow-up default response. */
    usage?: MockUsage;
    followUpText?: string;
}

export interface ScriptedToolCall {
    /** `publishedToolName` is the tool name published on the provider wire. */
    publishedToolName: string;
    /** `resultText` contains the provider-visible `tool_result` text. */
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

/* */
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
 * `runScriptedToolCall` drives one real tool loop and captures its provider-visible tool result.
 * Missing publication or result is an infrastructure failure, not a behavioral verdict.
 * verdict.
 *
 * `mock.reset()` clears captured request history.
 * `mock.reset()` also clears the queue, default response, and matchers.
 * A turn driven before `mock.reset()` is no longer observable.
 * Callers must reinstall matchers and the default response after `mock.reset()`.
 * The `published === null` diagnostic names only tools published in the current turn.
 * Callers must observe each turn before scripting the next turn.
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
