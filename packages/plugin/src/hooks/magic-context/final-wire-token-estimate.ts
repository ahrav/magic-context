import { getMeasuredToolDefinitionTokens } from "../../features/magic-context/tool-definition-tokens";
import { estimateImageTokensFromDataUrl } from "./image-token-estimate";
import { estimateTokens } from "./read-session-formatting";
import type { MessageLike } from "./tag-messages";
import { resolveModelCalibration } from "./tokenizer-calibration";

export interface MessageTokenEstimate {
    conversation: number;
    toolCall: number;
}

function compactWireLabel(value: unknown, fallback: string): string {
    if (typeof value !== "string" || value.length === 0) return fallback;
    return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 32) || fallback;
}

function wirePartKind(part: unknown, role: string): string {
    const rawType =
        part !== null &&
        typeof part === "object" &&
        typeof (part as { type?: unknown }).type === "string"
            ? (part as { type: string }).type
            : "unknown";
    if (rawType === "tool_result" || rawType === "tool-result") return "toolresult";
    if (rawType === "tool_use" || rawType === "tool-use" || rawType === "tool-invocation") {
        return "tool";
    }
    // OpenCode's native `tool` part carries the result on user-role messages
    // OpenCode's native `tool` part carries the call on assistant-role messages.
    if (role === "user" && rawType === "tool") return "toolresult";
    return compactWireLabel(rawType, "unknown");
}

/* */
export function describeFinalWireTail(messages: readonly MessageLike[]): string {
    return `[${messages
        .slice(-3)
        .map((message) => {
            const role = compactWireLabel(message.info.role, "unknown");
            const kinds = message.parts.map((part) => wirePartKind(part, role)).join("+") || "none";
            return `${role}:${kinds}`;
        })
        .join(", ")}]`;
}

function serializedTokens(value: unknown): number {
    if (value === undefined) return 0;
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    return serialized ? estimateTokens(serialized) : 0;
}

/* */
export function estimateMessageTokens(message: MessageLike): MessageTokenEstimate {
    let conversation = 0;
    let toolCall = 0;
    for (const part of message.parts) {
        if (!part || typeof part !== "object") continue;
        const p = part as {
            type?: string;
            text?: string;
            thinking?: string;
            signature?: string;
            data?: string;
            ignored?: boolean;
            state?: { input?: unknown; output?: unknown };
            args?: unknown;
            input?: unknown;
            content?: unknown;
            mime?: string;
            url?: unknown;
            metadata?: { anthropic?: { signature?: string } };
        };
        if (p.ignored) continue;
        switch (p.type) {
            case "text":
                if (typeof p.text === "string") conversation += estimateTokens(p.text);
                break;
            case "reasoning": {
                if (typeof p.text === "string") conversation += estimateTokens(p.text);
                const signature = p.metadata?.anthropic?.signature;
                if (typeof signature === "string") conversation += estimateTokens(signature);
                break;
            }
            case "thinking":
                if (typeof p.thinking === "string") conversation += estimateTokens(p.thinking);
                if (typeof p.signature === "string") conversation += estimateTokens(p.signature);
                break;
            case "redacted_thinking":
                if (typeof p.data === "string") conversation += estimateTokens(p.data);
                break;
            case "file":
                if (typeof p.mime === "string" && p.mime.startsWith("image/")) {
                    conversation +=
                        typeof p.url === "string" && p.url.startsWith("data:")
                            ? estimateImageTokensFromDataUrl(p.url)
                            : 1200;
                }
                break;
            case "tool":
                toolCall += serializedTokens(p.state?.input);
                toolCall += serializedTokens(p.state?.output);
                break;
            case "tool-invocation":
                toolCall += serializedTokens(p.args);
                break;
            case "tool_use":
                toolCall += serializedTokens(p.input);
                break;
            case "tool_result":
                toolCall += serializedTokens(p.content);
                break;
        }
    }
    return { conversation, toolCall };
}

export interface FinalWireTokenEstimateInput {
    messages: readonly MessageLike[];
    systemPromptTokens: number;
    providerID: string | undefined;
    modelID: string | undefined;
    agentName: string | undefined;
}

export interface FinalWireTokenEstimate {
    tokens: number;
    trusted: boolean;
    messageTokens: MessageTokenEstimate;
    systemTokens: number;
    toolDefinitionTokens: number | undefined;
}

/**
 */
export function estimateFinalWireInputTokens(
    input: FinalWireTokenEstimateInput,
): FinalWireTokenEstimate {
    const messageTokens = input.messages.reduce<MessageTokenEstimate>(
        (total, message) => {
            const next = estimateMessageTokens(message);
            total.conversation += next.conversation;
            total.toolCall += next.toolCall;
            return total;
        },
        { conversation: 0, toolCall: 0 },
    );
    const measuredToolDefinitions =
        input.providerID && input.modelID
            ? getMeasuredToolDefinitionTokens(input.providerID, input.modelID, input.agentName)
            : undefined;
    const calibration = resolveModelCalibration(input.providerID, input.modelID);
    const systemTokens = Math.round(
        Math.max(0, input.systemPromptTokens) * calibration.systemRatio,
    );
    const toolDefinitionTokens =
        measuredToolDefinitions === undefined
            ? undefined
            : Math.round(measuredToolDefinitions * calibration.toolsRatio);
    return {
        tokens:
            systemTokens +
            (toolDefinitionTokens ?? 0) +
            messageTokens.conversation +
            messageTokens.toolCall,
        trusted: systemTokens > 0 && toolDefinitionTokens !== undefined,
        messageTokens,
        systemTokens,
        toolDefinitionTokens,
    };
}
