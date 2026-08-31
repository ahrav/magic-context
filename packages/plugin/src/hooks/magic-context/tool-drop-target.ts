import { isRecord } from "../../shared/record-type-guard";
import { applyEditMarkerToInput } from "./edit-marker";
import { stripTagPrefix } from "./tag-content-primitives";
import type { MessageLike, ThinkingLikePart } from "./tag-messages";

export type ToolDropResult = "removed" | "truncated" | "absent" | "incomplete";

interface ToolCallObservation {
    callId: string;
    kind: "invocation" | "result";
}

export interface IndexedOccurrence {
    message: MessageLike;
    part: unknown;
    kind: "invocation" | "result";
}

export interface ToolCallIndexEntry {
    occurrences: IndexedOccurrence[];
    hasResult: boolean;
}

export type ToolCallIndex = Map<string, ToolCallIndexEntry>;

const DROP_PREFIX = "[dropped";
const IGNORE_PART_TYPES = new Set([
    "thinking",
    "reasoning",
    "redacted_thinking",
    "meta",
    "step-start",
    "step-finish",
]);

function isToolCallId(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

function getToolContent(part: unknown): string | undefined {
    if (!isRecord(part)) return undefined;
    if (part.type === "tool" && isRecord(part.state)) {
        return typeof part.state.output === "string" ? part.state.output : undefined;
    }
    if (part.type === "tool_result") {
        return typeof part.content === "string" ? part.content : undefined;
    }
    return undefined;
}

function setToolContent(part: unknown, content: string): void {
    if (!isRecord(part)) return;
    if (part.type === "tool" && isRecord(part.state)) {
        part.state.output = content;
        return;
    }
    if (part.type === "tool_result") {
        part.content = content;
    }
}

/**
 * When cloning succeeds, replacing the array entry isolates clamp mutations from the original part.
 */
function clonePart(part: unknown): unknown {
    if (part === null || typeof part !== "object") return part;
    try {
        return structuredClone(part);
    } catch {
        try {
            return JSON.parse(JSON.stringify(part));
        } catch {
            // If both cloning strategies fail, the subsequent clamp mutates the original part.
            return part;
        }
    }
}

/**
 */
function clampCloneInPlace(occurrence: IndexedOccurrence, clamp: (part: unknown) => void): void {
    const clone = clonePart(occurrence.part);
    clamp(clone);
    const parts = occurrence.message.parts;
    const index = parts.indexOf(occurrence.part);
    if (index >= 0) parts[index] = clone;
}

function truncateToolPart(part: unknown, tagId: number): void {
    if (!isRecord(part)) return;

    const sentinel = `[dropped \u00a7${tagId}\u00a7]`;

    if (part.type === "tool" && isRecord(part.state)) {
        const state = part.state;
        state.output = sentinel;

        if (isRecord(state.input)) {
            const inputSize = estimateInputSize(state.input);
            if (inputSize > 500) {
                truncateInputValues(state.input);
            }
        }

        return;
    }

    if (part.type === "tool_result") {
        part.content = sentinel;
        return;
    }

    if (part.type === "tool-invocation" && isRecord(part.args)) {
        const inputSize = estimateInputSize(part.args as Record<string, unknown>);
        if (inputSize > 500) {
            truncateInputValues(part.args as Record<string, unknown>);
        }
        return;
    }

    if (part.type === "tool_use" && isRecord(part.input)) {
        const inputSize = estimateInputSize(part.input as Record<string, unknown>);
        if (inputSize > 500) {
            truncateInputValues(part.input as Record<string, unknown>);
        }
    }
}

function estimateInputSize(input: Record<string, unknown>): number {
    try {
        return JSON.stringify(input).length;
    } catch {
        return 0;
    }
}

/**
 * Repeated calls with the same `tagId` leave the same marker.
 */
function editMarkerToolPart(part: unknown, tagId: number): void {
    if (!isRecord(part)) return;
    const sentinel = `[dropped \u00a7${tagId}\u00a7]`;

    if (part.type === "tool" && isRecord(part.state)) {
        part.state.output = sentinel;
        if (isRecord(part.state.input)) applyEditMarkerToInput(part.state.input);
        return;
    }
    if (part.type === "tool_result") {
        part.content = sentinel;
        return;
    }
    if (part.type === "tool-invocation" && isRecord(part.args)) {
        applyEditMarkerToInput(part.args as Record<string, unknown>);
        return;
    }
    if (part.type === "tool_use" && isRecord(part.input)) {
        applyEditMarkerToInput(part.input as Record<string, unknown>);
    }
}

/**
 */
function readToolPartInput(part: unknown): Record<string, unknown> | null {
    if (!isRecord(part)) return null;
    if (part.type === "tool" && isRecord(part.state) && isRecord(part.state.input)) {
        return part.state.input;
    }
    if (part.type === "tool-invocation" && isRecord(part.args)) return part.args;
    if (part.type === "tool_use" && isRecord(part.input)) return part.input;
    return null;
}

const TRUNCATION_SENTINEL = "...[truncated]";

/**
 */
function safeSlice(str: string, maxLen: number): string {
    if (str.length <= maxLen) return str;
    const lastCharCode = str.charCodeAt(maxLen - 1);
    if (lastCharCode >= 0xd800 && lastCharCode <= 0xdbff) {
        return str.slice(0, maxLen - 1);
    }
    return str.slice(0, maxLen);
}

function truncateInputValues(input: Record<string, unknown>): void {
    for (const key of Object.keys(input)) {
        const value = input[key];
        if (typeof value === "string") {
            if (
                value.endsWith(TRUNCATION_SENTINEL) ||
                value === "[object]" ||
                /^\[\d+ items\]$/.test(value)
            )
                continue;
            input[key] = value.length > 5 ? `${safeSlice(value, 5)}${TRUNCATION_SENTINEL}` : value;
        } else if (Array.isArray(value)) {
            input[key] = `[${value.length} items]`;
        } else if (value !== null && typeof value === "object") {
            input[key] = "[object]";
        }
    }
}

export function hasMeaningfulPart(part: unknown): boolean {
    if (!isRecord(part)) return false;
    const type = part.type;
    if (type === "text") {
        if (typeof part.text !== "string") return false;
        return stripTagPrefix(part.text).trim().length > 0;
    }
    if (typeof type !== "string") return false;
    if (IGNORE_PART_TYPES.has(type)) return false;
    return true;
}

function clearThinkingParts(thinkingParts: ThinkingLikePart[]): void {
    for (const part of thinkingParts) {
        if (part.thinking !== undefined) part.thinking = "[cleared]";
        if (part.text !== undefined) part.text = "[cleared]";
    }
}

/**
 *
 */
export function partHasCompletedResult(part: unknown): boolean {
    if (!isRecord(part)) return false;
    if (part.type === "tool") {
        if (!isRecord(part.state)) return false;
        return typeof part.state.output === "string" || part.state.status === "error";
    }
    return part.type === "tool_result";
}

export function extractToolCallObservation(part: unknown): ToolCallObservation | null {
    if (!isRecord(part)) return null;
    if (part.type === "tool" && isToolCallId(part.callID)) {
        return { callId: part.callID, kind: "result" };
    }
    if (part.type === "tool-invocation" && isToolCallId(part.callID)) {
        return { callId: part.callID, kind: "invocation" };
    }
    if (part.type === "tool_use" && isToolCallId(part.id)) {
        return { callId: part.id, kind: "invocation" };
    }
    if (part.type === "tool_result" && isToolCallId(part.tool_use_id)) {
        return { callId: part.tool_use_id, kind: "result" };
    }
    return null;
}

function isDropContent(content: string): boolean {
    return content.startsWith(DROP_PREFIX);
}

export class ToolMutationBatch {
    private partsToRemove = new Set<unknown>();
    private affectedMessages = new Set<MessageLike>();
    private messages: MessageLike[];

    constructor(messages: MessageLike[]) {
        this.messages = messages;
    }

    markForRemoval(occurrence: IndexedOccurrence): void {
        this.partsToRemove.add(occurrence.part);
        this.affectedMessages.add(occurrence.message);
    }

    finalize(): void {
        if (this.partsToRemove.size === 0) return;

        for (const message of this.affectedMessages) {
            message.parts = message.parts.filter((p) => !this.partsToRemove.has(p));
        }

        for (let i = this.messages.length - 1; i >= 0; i -= 1) {
            if (!this.messages[i].parts.some(hasMeaningfulPart)) {
                this.messages.splice(i, 1);
            }
        }

        this.partsToRemove.clear();
        this.affectedMessages.clear();
    }
}

/**
 * (`<ownerMsgId>\x00<callId>`).
 *
 *
 */
export function createToolDropTarget(
    compositeKey: string,
    thinkingParts: ThinkingLikePart[],
    index: ToolCallIndex,
    batch: ToolMutationBatch,
    tagId: number,
): {
    setContent: (content: string) => boolean;
    drop: () => ToolDropResult;
    truncate: () => ToolDropResult;
    editMarker: () => ToolDropResult;
    /**
     */
    canDrop: () => boolean;
    readInput: () => Record<string, unknown> | null;
} {
    const drop = (): ToolDropResult => {
        const entry = index.get(compositeKey);
        if (!entry || entry.occurrences.length === 0) return "absent";
        if (!entry.hasResult) return "incomplete";

        for (const occurrence of entry.occurrences) {
            batch.markForRemoval(occurrence);
        }
        clearThinkingParts(thinkingParts);
        index.delete(compositeKey);
        return "removed";
    };

    const truncate = (): ToolDropResult => {
        const entry = index.get(compositeKey);
        if (!entry || entry.occurrences.length === 0) return "absent";
        if (!entry.hasResult) return "incomplete";

        for (const occurrence of entry.occurrences) {
            clampCloneInPlace(occurrence, (part) => truncateToolPart(part, tagId));
        }
        clearThinkingParts(thinkingParts);
        return "truncated";
    };

    const editMarker = (): ToolDropResult => {
        const entry = index.get(compositeKey);
        if (!entry || entry.occurrences.length === 0) return "absent";
        if (!entry.hasResult) return "incomplete";

        for (const occurrence of entry.occurrences) {
            clampCloneInPlace(occurrence, (part) => editMarkerToolPart(part, tagId));
        }
        clearThinkingParts(thinkingParts);
        return "truncated";
    };

    return {
        setContent: (content: string): boolean => {
            if (isDropContent(content)) {
                drop();
                return true;
            }

            const entry = index.get(compositeKey);
            if (!entry) return false;

            let changed = false;
            for (const occurrence of entry.occurrences) {
                if (occurrence.kind !== "result") continue;
                const prevContent = getToolContent(occurrence.part);
                if (prevContent !== content) {
                    setToolContent(occurrence.part, content);
                    changed = true;
                }
            }
            return changed;
        },
        drop,
        truncate,
        editMarker,
        canDrop: (): boolean => {
            const entry = index.get(compositeKey);
            return !!entry && entry.occurrences.length > 0 && entry.hasResult;
        },
        readInput: (): Record<string, unknown> | null => {
            const entry = index.get(compositeKey);
            if (!entry) return null;
            for (const occurrence of entry.occurrences) {
                if (occurrence.kind !== "invocation") continue;
                const input = readToolPartInput(occurrence.part);
                if (input) return input;
            }
            for (const occurrence of entry.occurrences) {
                const input = readToolPartInput(occurrence.part);
                if (input) return input;
            }
            return null;
        },
    };
}
