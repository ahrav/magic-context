/**
 *
 * ----------------
 *
 * ----------------
 *
 * Implementation
 * --------------
 *
 */

import { isRecord } from "../../shared/record-type-guard";
import { isSentinel } from "./sentinel";
import type { MessageLike } from "./tag-messages";

const NOTE_TOOL_NAMES = new Set(["ctx_note"]);
const READ_ACTION = "read";

/**
 */
export function hasVisibleNoteReadCall(messages: MessageLike[]): boolean {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const parts = messages[i]?.parts;
        if (!Array.isArray(parts)) continue;
        for (const part of parts) {
            if (isSentinel(part)) continue;
            if (isVisibleNoteReadPart(part)) return true;
        }
    }
    return false;
}

/**
 *
 *
 * `isVisibleNoteReadPart` returns true only when a recognized `ctx_note` part has `action === "read"`.
 */
function isVisibleNoteReadPart(part: unknown): boolean {
    if (!isRecord(part)) return false;

    // `tool` parts read `action` from `state.input`.
    if (part.type === "tool" && typeof part.tool === "string" && NOTE_TOOL_NAMES.has(part.tool)) {
        const state = part.state;
        if (isRecord(state) && isRecord(state.input)) {
            return state.input.action === READ_ACTION;
        }
        return false;
    }

    // `tool_use` parts identify the tool with `name` and read the action from `input.action`.
    if (
        part.type === "tool_use" &&
        typeof part.name === "string" &&
        NOTE_TOOL_NAMES.has(part.name)
    ) {
        if (isRecord(part.input)) {
            return part.input.action === READ_ACTION;
        }
        return false;
    }

    // `argsCandidate` uses non-nullish `args`; otherwise it uses `input`.
    if (
        part.type === "tool-invocation" &&
        typeof part.toolName === "string" &&
        NOTE_TOOL_NAMES.has(part.toolName)
    ) {
        const argsCandidate = part.args ?? part.input;
        if (isRecord(argsCandidate)) {
            return argsCandidate.action === READ_ACTION;
        }
        return false;
    }

    return false;
}
