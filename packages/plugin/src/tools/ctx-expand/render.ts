/**
 * `renderVerboseRange` and `renderMessageById` provide ctx_expand's verbose and by-id views.
 *
 * `ctx_expand`'s default range view merges turns and renders tool calls as `TC: name(arg)`.
 * modes:
 *
 * `renderVerboseRange` renders each message separately with its id and a per-part preview.
 * `renderMessageById` uses a message or tool-call id to recover the matching message in full.
 * `renderMessageById` returns every text part and complete tool input and output for one message.
 * `renderMessageById` reads the message from stored OpenCode or Pi history.
 * `renderMessageById` recovers output dropped by `ctx_reduce` from stored history.
 * `ctx_reduce` represents dropped output as `[dropped §N§]`.
 * `renderMessageById` cannot recover content after session prune or revert deletes its stored row.
 * `renderMessageById` does not rerun missing tool calls because rerunning can change their output.
 *     answer).
 *
 * Pi supplies raw messages through `RawMessageProvider`.
 */

import { readRawSessionMessages } from "../../hooks/magic-context/read-session-chunk";
import { estimateTokens } from "../../hooks/magic-context/read-session-formatting";
import type { RawMessage } from "../../hooks/magic-context/read-session-raw";

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function roleLabel(role: string): string {
    if (role === "assistant") return "A (assistant)";
    if (role === "user") return "U (user)";
    return role;
}

function truncate(value: string, max: number): string {
    const t = value.trim();
    return t.length <= max ? t : `${t.slice(0, max)}…`;
}

/* */
function keyArg(input: Record<string, unknown> | null | undefined): string {
    if (!input) return "";
    for (const k of ["filePath", "path", "pattern", "query", "symbol", "module", "action"]) {
        const v = input[k];
        if (typeof v === "string" && v.length > 0) return truncate(v, 60);
    }
    if (typeof input.description === "string") return truncate(input.description, 60);
    return "";
}

/**
 * `asToolPart` handles OpenCode's merged `tool` parts.
 * `asToolPart` handles Anthropic `tool_use` and `tool_result` parts and Pi tool parts.
 */
function asToolPart(part: Record<string, unknown>): {
    name: string;
    callId: string;
    title: string | null;
    input: Record<string, unknown> | null;
    output: string | null;
} | null {
    const type = typeof part.type === "string" ? part.type : "";

    if (type === "tool") {
        const state = isRecord(part.state) ? part.state : null;
        const output =
            state && typeof state.output === "string"
                ? state.output
                : state && state.output != null
                  ? JSON.stringify(state.output)
                  : null;
        const metadata = state && isRecord(state.metadata) ? state.metadata : null;
        const title =
            (state && typeof state.title === "string" && state.title) ||
            (metadata && typeof metadata.title === "string" && metadata.title) ||
            null;
        return {
            name: typeof part.tool === "string" ? part.tool : "tool",
            callId: typeof part.callID === "string" ? part.callID : "",
            title,
            input: state && isRecord(state.input) ? state.input : null,
            output,
        };
    }

    if (type === "tool_use") {
        return {
            name: typeof part.name === "string" ? part.name : "tool",
            callId: typeof part.id === "string" ? part.id : "",
            title: null,
            input: isRecord(part.input) ? part.input : null,
            output: null,
        };
    }

    if (type === "tool_result") {
        const content = part.content;
        const output =
            typeof content === "string"
                ? content
                : content != null
                  ? JSON.stringify(content)
                  : null;
        return {
            name: "tool_result",
            callId: typeof part.tool_use_id === "string" ? part.tool_use_id : "",
            title: null,
            input: null,
            output,
        };
    }

    return null;
}

function textOf(part: Record<string, unknown>): string | null {
    if (part.type === "text" && typeof part.text === "string") return part.text;
    return null;
}

function reasoningOf(part: Record<string, unknown>): string | null {
    if ((part.type === "reasoning" || part.type === "thinking") && typeof part.text === "string") {
        return part.text;
    }
    return null;
}

/* */
function renderPartPreview(part: unknown): string | null {
    if (!isRecord(part)) return null;
    const text = textOf(part);
    if (text !== null) {
        const t = truncate(text, 200);
        return t.length > 0 ? `    • ${t}` : null;
    }
    const tool = asToolPart(part);
    if (tool) {
        const arg = keyArg(tool.input);
        const head = arg ? `${tool.name}(${arg})` : tool.name;
        return tool.output !== null
            ? `    • tool ${head} → output ~${estimateTokens(tool.output)} tok`
            : `    • tool ${head}`;
    }
    const reasoning = reasoningOf(part);
    if (reasoning !== null) return `    • [reasoning] ${truncate(reasoning, 120)}`;
    const type = typeof part.type === "string" ? part.type : "part";
    if (type === "file") return "    • [file]";
    if (type === "step-start" || type === "step-finish") return null;
    return `    • [${type}]`;
}

/**
 * `renderPartFull` includes tool input, tool output, optional descriptions, and non-tool text.
 */
function renderPartFull(part: unknown): string | null {
    if (!isRecord(part)) return null;

    const text = textOf(part);
    if (text !== null) {
        return text.trim().length > 0 ? `  [text]\n${text}` : null;
    }

    const tool = asToolPart(part);
    if (tool) {
        const lines: string[] = [];
        const idSuffix = tool.callId ? ` #${tool.callId}` : "";
        lines.push(`  [tool: ${tool.name}${idSuffix}]`);
        if (tool.title && tool.title.trim().length > 0) {
            lines.push(`  description: ${tool.title.trim()}`);
        }
        if (tool.input) lines.push(`  input: ${JSON.stringify(tool.input)}`);
        if (tool.output !== null) lines.push(`  output:\n${tool.output}`);
        return lines.join("\n");
    }

    const type = typeof part.type === "string" ? part.type : "part";
    if (type === "file") {
        const name =
            (typeof part.filename === "string" && part.filename) ||
            (typeof part.url === "string" && part.url) ||
            "";
        return `  [file]${name ? ` ${name}` : ""}`;
    }

    // `renderPartFull` skips `step-start`, `step-finish`, and reasoning parts; it returns `null` for other unsupported part types.
    return null;
}

/**
 * `renderMessageById` returns the untruncated message selected by its `[N]` ordinal.
 */
export function renderMessageByOrdinal(sessionId: string, ordinal: number): string {
    const msg = readRawSessionMessages(sessionId).find((m: RawMessage) => m.ordinal === ordinal);
    if (!msg) {
        return (
            `No message at ordinal ${ordinal} in this session's stored history — it was deleted ` +
            `(session prune/revert) or the ordinal is wrong, so it can't be recovered. ` +
            `Re-run the tool if you still need the data.`
        );
    }
    const rendered = msg.parts.map(renderPartFull).filter((l): l is string => l !== null);

    const lines: string[] = [`[${msg.ordinal}] ${roleLabel(msg.role)} — full recovery:`, ""];
    if (rendered.length === 0) {
        lines.push("  (no recoverable content — message had only structural/reasoning parts)");
    } else {
        lines.push(...rendered);
    }
    return lines.join("\n");
}

export interface VerboseRangeResult {
    text: string;
    /* */
    lastOrdinal: number;
    /* */
    truncated: boolean;
}

/**
 */
export function renderVerboseRange(
    sessionId: string,
    start: number,
    end: number,
    tokenBudget: number,
): VerboseRangeResult {
    const messages = readRawSessionMessages(sessionId).filter(
        (m: RawMessage) => m.ordinal >= start && m.ordinal <= end,
    );

    const out: string[] = [];
    let usedTokens = 0;
    let lastOrdinal = start - 1;
    let truncated = false;

    for (const msg of messages) {
        const header = `[${msg.ordinal}] ${roleLabel(msg.role)}`;
        const partLines = msg.parts.map(renderPartPreview).filter((l): l is string => l !== null);
        const block = partLines.length > 0 ? `${header}\n${partLines.join("\n")}` : header;

        const blockTokens = estimateTokens(block);
        if (usedTokens + blockTokens > tokenBudget && out.length > 0) {
            truncated = true;
            break;
        }
        out.push(block);
        usedTokens += blockTokens;
        lastOrdinal = msg.ordinal;
    }

    return { text: out.join("\n\n"), lastOrdinal, truncated };
}
