import { isRecord } from "../../shared/record-type-guard";
import { isSentinel, makeSentinel, makeWholeMessageSentinel } from "./sentinel";
import type { MessageLike, ThinkingLikePart } from "./tag-messages";

const DROPPED_PLACEHOLDER_PATTERN = /^\[dropped §\d+§\]$/;
const TAG_PREFIX_PATTERN = /^§\d+§\s*/;

// System-injected messages must not reach the LLM.
const SYSTEM_INJECTION_PATTERNS = [
    /^<!-- OMO_INTERNAL_INITIATOR -->$/,
    /^<system-reminder>[\s\S]*<\/system-reminder>$/,
    /^\[SYSTEM DIRECTIVE:/,
    /^\[Category\+Skill Reminder\]/,
    /^\[EDIT ERROR - IMMEDIATE ACTION REQUIRED\]/,
    /^\[task CALL FAILED/,
    /^\[EMERGENCY CONTEXT WINDOW WARNING\]/,
];

function isSystemInjectedText(text: string): boolean {
    const stripped = text.trim().replace(TAG_PREFIX_PATTERN, "").trim();
    if (stripped.length === 0) return false;
    return SYSTEM_INJECTION_PATTERNS.some((pattern) => pattern.test(stripped));
}

/**
 * System-injected messages must not reach the LLM.
 *
 *
 */
export function stripSystemInjectedMessages(
    messages: MessageLike[],
    protectedTailStart: number,
    providerID?: string,
): { stripped: number; sentineledIds: string[] } {
    let stripped = 0;
    const sentineledIds: string[] = [];
    for (let i = 0; i < messages.length; i++) {
        if (i >= protectedTailStart) continue;

        const msg = messages[i];
        if (msg.parts.length === 0) continue;

        if (msg.info.role === "user") continue;

        // A lone sentinel makes replay idempotent.
        if (msg.parts.length === 1 && isSentinel(msg.parts[0])) continue;

        let hasContentPart = false;
        let allContentIsSystemInjection = true;

        for (const part of msg.parts) {
            if (!isRecord(part)) continue;
            const partType = part.type as string;

            if (METADATA_PART_TYPES.has(partType)) continue;

            if (part.ignored === true) continue;

            // Tool parts are real content
            if (partType === "tool") {
                allContentIsSystemInjection = false;
                break;
            }

            if (partType === "text" && typeof part.text === "string") {
                hasContentPart = true;
                if (!isSystemInjectedText(part.text)) {
                    allContentIsSystemInjection = false;
                    break;
                }
                continue;
            }

            allContentIsSystemInjection = false;
            break;
        }

        if (hasContentPart && allContentIsSystemInjection) {
            msg.parts.length = 0;
            msg.parts.push(makeWholeMessageSentinel(providerID));
            stripped++;
            if (typeof msg.info.id === "string") sentineledIds.push(msg.info.id);
        }
    }
    return { stripped, sentineledIds };
}

//
const METADATA_PART_TYPES = new Set([
    "step-start",
    "step-finish",
    "snapshot",
    "patch",
    "agent",
    "retry",
    "subtask",
    "compaction",
]);

/**
 *
 *
 *
 * array mutation.
 *
 */
export function stripDroppedPlaceholderMessages(
    messages: MessageLike[],
    providerID?: string,
): {
    stripped: number;
    sentineledIds: string[];
} {
    let stripped = 0;
    const sentineledIds: string[] = [];
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.parts.length === 0) continue;

        if (msg.info.role === "user") continue;

        // A lone sentinel makes replay idempotent.
        if (msg.parts.length === 1 && isSentinel(msg.parts[0])) continue;

        let hasContentPart = false;
        let hasNonDroppedContent = false;

        for (const part of msg.parts) {
            if (!isRecord(part)) continue;
            const partType = part.type as string;

            if (METADATA_PART_TYPES.has(partType)) continue;

            // Tool parts carry content — don't strip messages with tool calls/results
            if (partType === "tool") {
                hasNonDroppedContent = true;
                break;
            }

            if (partType === "text" && typeof part.text === "string") {
                hasContentPart = true;
                const trimmed = part.text.trim();
                if (trimmed.length === 0) continue;
                if (!trimmed.includes("[dropped §")) {
                    hasNonDroppedContent = true;
                    break;
                }
                const allSegmentsDropped = trimmed
                    .split(/(?=\[dropped §)/)
                    .filter((s) => s.trim().length > 0)
                    .every((segment) => DROPPED_PLACEHOLDER_PATTERN.test(segment.trim()));
                if (!allSegmentsDropped) {
                    hasNonDroppedContent = true;
                    break;
                }
                continue;
            }

            if (partType === "reasoning" && typeof part.text === "string") {
                hasContentPart = true;
                const trimmed = part.text.trim();
                if (trimmed.length === 0) continue;
                if (!trimmed.includes("[dropped §")) {
                    hasNonDroppedContent = true;
                    break;
                }
                const allSegmentsDropped = trimmed
                    .split(/(?=\[dropped §)/)
                    .filter((s) => s.trim().length > 0)
                    .every((segment) => DROPPED_PLACEHOLDER_PATTERN.test(segment.trim()));
                if (!allSegmentsDropped) {
                    hasNonDroppedContent = true;
                    break;
                }
                continue;
            }

            // Unknown content-carrying part types prevent stripping.
            hasNonDroppedContent = true;
            break;
        }

        if (hasContentPart && !hasNonDroppedContent) {
            msg.parts.length = 0;
            msg.parts.push(makeWholeMessageSentinel(providerID));
            stripped++;
            if (typeof msg.info.id === "string") sentineledIds.push(msg.info.id);
        }
    }
    return { stripped, sentineledIds };
}

/**
 */
export function replayClearedReasoning(
    messages: MessageLike[],
    reasoningByMessage: Map<MessageLike, ThinkingLikePart[]>,
    messageTagNumbers: Map<MessageLike, number>,
    persistedWatermark: number,
): number {
    if (persistedWatermark <= 0) return 0;

    let cleared = 0;
    for (const message of messages) {
        const msgTag = messageTagNumbers.get(message) ?? 0;
        if (msgTag === 0 || msgTag > persistedWatermark) continue;

        const parts = reasoningByMessage.get(message);
        if (!parts) continue;

        for (const tp of parts) {
            if (tp.thinking !== undefined && tp.thinking !== "[cleared]") {
                tp.thinking = "[cleared]";
                cleared++;
            }
            if (tp.text !== undefined && tp.text !== "[cleared]") {
                tp.text = "[cleared]";
                cleared++;
            }
        }
    }
    return cleared;
}

/**
 */
export function replayStrippedInlineThinking(
    messages: MessageLike[],
    messageTagNumbers: Map<MessageLike, number>,
    persistedWatermark: number,
): number {
    if (persistedWatermark <= 0) return 0;

    let stripped = 0;
    for (const message of messages) {
        if (message.info.role !== "assistant") continue;
        const msgTag = messageTagNumbers.get(message) ?? 0;
        if (msgTag === 0 || msgTag > persistedWatermark) continue;

        for (const part of message.parts) {
            if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") continue;
            // The `<think` scan avoids regex replacement for text without `<think`.
            if (!part.text.includes("<think")) continue;
            const cleaned = (part.text as string).replace(INLINE_THINKING_PATTERN, "");
            if (cleaned !== part.text) {
                part.text = cleaned;
                stripped++;
            }
        }
    }
    return stripped;
}

export function clearOldReasoning(
    messages: MessageLike[],
    reasoningByMessage: Map<MessageLike, ThinkingLikePart[]>,
    messageTagNumbers: Map<MessageLike, number>,
    clearReasoningAge: number,
): number {
    const maxTag = findMaxTag(messageTagNumbers);
    if (maxTag === 0) return 0;

    const ageCutoff = maxTag - clearReasoningAge;
    let cleared = 0;

    for (const message of messages) {
        const msgTag = messageTagNumbers.get(message) ?? 0;
        if (msgTag === 0 || msgTag > ageCutoff) continue;

        const parts = reasoningByMessage.get(message);
        if (!parts) continue;

        for (const tp of parts) {
            if (tp.thinking !== undefined && tp.thinking !== "[cleared]") {
                tp.thinking = "[cleared]";
                cleared++;
            }
            if (tp.text !== undefined && tp.text !== "[cleared]") {
                tp.text = "[cleared]";
                cleared++;
            }
        }
    }

    return cleared;
}

function findMaxTag(messageTagNumbers: Map<MessageLike, number>): number {
    let max = 0;
    for (const tag of messageTagNumbers.values()) {
        if (tag > max) max = tag;
    }
    return max;
}

const CLEARED_REASONING_TYPES = new Set(["thinking", "reasoning"]);

/**
 *
 */
export function stripClearedReasoning(messages: MessageLike[]): number {
    let stripped = 0;
    for (const message of messages) {
        if (message.info.role !== "assistant") continue;
        for (let i = 0; i < message.parts.length; i++) {
            const part = message.parts[i];
            if (!isRecord(part)) continue;
            const partType = part.type as string;
            if (!CLEARED_REASONING_TYPES.has(partType)) continue;
            // Parts without `thinking` or `text` remain unchanged because they cannot be identified as cleared shells.
            // Parts without `thinking` or `text` remain unchanged because they cannot be identified as cleared shells.
            // Parts without `thinking` or `text` remain unchanged because they cannot be identified as cleared shells.
            if (!("thinking" in part) && !("text" in part)) continue;
            const thinking = "thinking" in part ? (part.thinking as string | undefined) : undefined;
            const text = "text" in part ? (part.text as string | undefined) : undefined;
            const isCleared =
                (thinking === undefined || thinking === "[cleared]") &&
                (text === undefined || text === "[cleared]");
            if (!isCleared) continue;
            message.parts[i] = makeSentinel(part);
            stripped++;
        }
    }
    return stripped;
}

const INLINE_THINKING_PATTERN = /<(?:thinking|think)>[\s\S]*?<\/(?:thinking|think)>\s*/g;

export function stripInlineThinking(
    messages: MessageLike[],
    messageTagNumbers: Map<MessageLike, number>,
    clearReasoningAge: number,
): number {
    const maxTag = findMaxTag(messageTagNumbers);
    if (maxTag === 0) return 0;

    const ageCutoff = maxTag - clearReasoningAge;
    let stripped = 0;

    for (const message of messages) {
        if (message.info.role !== "assistant") continue;
        const msgTag = messageTagNumbers.get(message) ?? 0;
        if (msgTag === 0 || msgTag > ageCutoff) continue;

        for (const part of message.parts) {
            if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") continue;
            const cleaned = (part.text as string).replace(INLINE_THINKING_PATTERN, "");
            if (cleaned !== part.text) {
                part.text = cleaned;
                stripped++;
            }
        }
    }
    return stripped;
}

const REASONING_IGNORED_PART_TYPES = new Set([
    "step-start",
    "step-finish",
    "snapshot",
    "patch",
    "agent",
    "retry",
    "subtask",
    "compaction",
]);

const REASONING_PART_TYPES = new Set(["reasoning", "thinking", "redacted_thinking"]);

interface MergedReasoningStripPlan {
    message: MessageLike;
    stripIndices: number[];
}

function planMergedAssistantReasoningStrip(
    messages: MessageLike[],
    mutationExemptMessage?: MessageLike,
): MergedReasoningStripPlan[] {
    const plan: MergedReasoningStripPlan[] = [];
    let prevRole: string | undefined;
    let keptReasoningInRun = false;

    for (const message of messages) {
        const role = message.info.role;

        if (role !== "assistant") {
            prevRole = role;
            keptReasoningInRun = false;
            continue;
        }

        const firstInRun = prevRole !== "assistant";
        if (firstInRun) keptReasoningInRun = false;

        if (message === mutationExemptMessage) {
            prevRole = role;
            continue;
        }

        // Keep a reasoning part only when the first non-metadata content part of the first assistant message in a run is a reasoning type.
        // Keep a reasoning part only when the first non-metadata content part of the first assistant message in a run is a reasoning type.
        // Keep a reasoning part only when the first non-metadata content part of the first assistant message in a run is a reasoning type.
        // reasoning/thinking/redacted_thinking part.
        //
        // Sentinels represent structural-noise parts removed in place.
        // The first-non-metadata rule must treat sentinels as the structural parts they replaced.
        // The first-non-metadata rule must treat sentinels as the structural parts they replaced.
        // Otherwise, an eligible first reasoning part is treated as non-first and neutralized.
        // Neutralizing that part can strip the last eligible thinking block from the run.
        let keepIndex = -1;
        if (firstInRun && !keptReasoningInRun) {
            for (let i = 0; i < message.parts.length; i++) {
                const part = message.parts[i];
                if (!isRecord(part)) continue;
                const partType = part.type as string;
                if (REASONING_IGNORED_PART_TYPES.has(partType)) continue;
                if (part.ignored === true) continue;
                if (isSentinel(part)) continue;
                // Leading whitespace-only text before reasoning is wire-invisible.
                // Treating whitespace-only text as invisible preserves the first-content rule after an assistant loses newest status.
                if (
                    partType === "text" &&
                    typeof part.text === "string" &&
                    part.text.trim() === ""
                ) {
                    continue;
                }
                if (REASONING_PART_TYPES.has(partType)) {
                    keepIndex = i;
                }
                break;
            }
        }

        const stripIndices: number[] = [];
        for (let i = 0; i < message.parts.length; i++) {
            const part = message.parts[i];
            if (!isRecord(part)) continue;
            if (!REASONING_PART_TYPES.has(part.type as string)) continue;
            if (part.cache_control !== undefined) continue;
            if (i === keepIndex) {
                keptReasoningInRun = true;
                continue;
            }
            stripIndices.push(i);
        }
        if (stripIndices.length > 0) plan.push({ message, stripIndices });

        prevRole = role;
    }

    return plan;
}

export type TrailingBlankDecision = "keep" | `keep:${number}` | "strip";

const MAX_FROZEN_TRAILING_BLANKS = 10_000;
const CANONICAL_BLANK_PART = { type: "text", text: "" } as const;

function isSentinelInvisibleTextPart(part: unknown): boolean {
    return (
        isRecord(part) &&
        part.type === "text" &&
        typeof part.text === "string" &&
        part.text.trim() === ""
    );
}

function isCanonicalBlankPart(part: unknown): boolean {
    return (
        isRecord(part) && Object.keys(part).length === 2 && part.type === "text" && part.text === ""
    );
}

function trailingBlankKeepCount(decision: TrailingBlankDecision): number | undefined {
    if (decision === "keep") return 1;
    if (!decision.startsWith("keep:")) return undefined;
    const countText = decision.slice("keep:".length);
    if (!/^[1-9]\d*$/.test(countText)) return undefined;
    const count = Number(countText);
    return Number.isSafeInteger(count) && count > 0 && count <= MAX_FROZEN_TRAILING_BLANKS
        ? count
        : undefined;
}

/**
 * The transform captures each assistant's served representation before the provider can append a blank suffix.
 * The transform refreshes the newest assistant's served representation while it remains live.
 * The transform freezes an assistant's last served representation for replay after a later assistant appears.
 */
export function findTrailingBlankDecisionCandidates(
    messages: MessageLike[],
    frozenDecisions: ReadonlyMap<string, TrailingBlankDecision>,
    options?: { refreshMessageId?: string },
): Array<readonly [string, TrailingBlankDecision]> {
    const decisions: Array<readonly [string, TrailingBlankDecision]> = [];
    for (const message of messages) {
        const id = message.info.id;
        if (message.info.role !== "assistant" || typeof id !== "string" || id.length === 0) {
            continue;
        }
        let trailingCount = 0;
        while (
            trailingCount < message.parts.length &&
            isSentinelInvisibleTextPart(message.parts[message.parts.length - trailingCount - 1])
        ) {
            trailingCount += 1;
        }
        if (trailingCount > MAX_FROZEN_TRAILING_BLANKS && trailingCount < message.parts.length) {
            continue;
        }
        const decision: TrailingBlankDecision =
            message.parts.length === 0 || trailingCount === message.parts.length
                ? "keep"
                : trailingCount === 0
                  ? "strip"
                  : trailingCount === 1
                    ? "keep"
                    : `keep:${trailingCount}`;
        const frozen = frozenDecisions.get(id);
        if (frozen !== undefined && (id !== options?.refreshMessageId || frozen === decision)) {
            continue;
        }
        decisions.push([id, decision]);
    }
    return decisions;
}

/**
 * Replay runs after mutations so it captures their final state.
 * The code never deletes the newest assistant's suffix in either message representation.
 */
export function applyFrozenTrailingBlankDecisions(
    messages: MessageLike[],
    newestAssistantId: string | undefined,
    frozenDecisions: ReadonlyMap<string, TrailingBlankDecision>,
): number {
    let mutations = 0;
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
        let message = messages[messageIndex];
        const id = message.info.id;
        if (message.info.role !== "assistant" || typeof id !== "string") continue;
        const decision = frozenDecisions.get(id);
        if (!decision) continue;

        let lastMeaningfulIndex = message.parts.length - 1;
        while (
            lastMeaningfulIndex >= 0 &&
            isSentinelInvisibleTextPart(message.parts[lastMeaningfulIndex])
        ) {
            lastMeaningfulIndex -= 1;
        }

        const replaceParts = (start: number, deleteCount: number, insertBlankCount: number) => {
            // The transform does not mutate caller-owned messages.
            message = { ...message, parts: [...message.parts] };
            messages[messageIndex] = message;
            message.parts.splice(
                start,
                deleteCount,
                ...Array.from({ length: insertBlankCount }, () => ({ ...CANONICAL_BLANK_PART })),
            );
        };

        if (lastMeaningfulIndex < 0) {
            if (message.parts.length !== 1 || !isCanonicalBlankPart(message.parts[0])) {
                mutations += Math.max(1, message.parts.length);
                replaceParts(0, message.parts.length, 1);
            }
            continue;
        }

        const trailingCount = message.parts.length - lastMeaningfulIndex - 1;
        const keepCount = trailingBlankKeepCount(decision);
        if (keepCount !== undefined) {
            const blankIndex = lastMeaningfulIndex + 1;
            const suffixIsCanonical =
                trailingCount === keepCount &&
                message.parts.slice(blankIndex).every(isCanonicalBlankPart);
            if (!suffixIsCanonical) {
                mutations += Math.max(1, trailingCount, keepCount);
                replaceParts(blankIndex, trailingCount, keepCount);
            }
            continue;
        }

        if (id === newestAssistantId || trailingCount === 0) continue;
        const lastMeaningfulPart = message.parts[lastMeaningfulIndex];
        if (
            isRecord(lastMeaningfulPart) &&
            REASONING_PART_TYPES.has(lastMeaningfulPart.type as string)
        ) {
            const blankIndex = lastMeaningfulIndex + 1;
            if (trailingCount !== 1 || !isCanonicalBlankPart(message.parts[blankIndex])) {
                mutations += Math.max(1, trailingCount);
                replaceParts(blankIndex, trailingCount, 1);
            }
            continue;
        }
        mutations += trailingCount;
        replaceParts(lastMeaningfulIndex + 1, trailingCount, 0);
    }
    return mutations;
}

/**
 * The frozen set contains stable IDs of assistants whose reasoning the merge rule would neutralize.
 */
export function findMergedReasoningStripCandidateIds(
    messages: MessageLike[],
    providerID?: string,
    options?: { mutationExemptMessage?: MessageLike },
): string[] {
    if (providerID !== "anthropic") return [];

    const ids = new Set<string>();
    for (const entry of planMergedAssistantReasoningStrip(
        messages,
        options?.mutationExemptMessage,
    )) {
        const id = entry.message.info.id;
        if (typeof id === "string" && id.length > 0) ids.add(id);
    }
    return [...ids];
}

/**
 *
 *    original response."
 *
 *
 *
 *
 *     the run.
 * The transform leaves mutationExemptMessage byte-identical.
 * When frozenMessageIds is present, the transform mutates only messages whose IDs are in frozenMessageIds.
 *
 *
 */
export function stripReasoningFromMergedAssistants(
    messages: MessageLike[],
    providerID?: string,
    options?: {
        mutationExemptMessage?: MessageLike;
        frozenMessageIds?: ReadonlySet<string>;
    },
): number {
    if (providerID !== "anthropic") return 0;

    let stripped = 0;
    for (const entry of planMergedAssistantReasoningStrip(
        messages,
        options?.mutationExemptMessage,
    )) {
        if (options?.frozenMessageIds) {
            const id = entry.message.info.id;
            if (typeof id !== "string" || !options.frozenMessageIds.has(id)) continue;
        }
        // Preserving part indexes keeps previously computed strip indices valid.
        for (const index of entry.stripIndices) {
            entry.message.parts[index] = makeSentinel(entry.message.parts[index]);
            stripped++;
        }
    }

    return stripped;
}

export interface StripProcessedImagesResult {
    stripped: number;
    newlyStrippedIds: string[];
}

/**
 *
 * Detection returns newly stripped IDs; replay strips only IDs in `frozenIds`.
 *
 * Callers invoke this function only when `modelAcceptsEmptyContent(providerID)` is true.
 */
export function stripProcessedImages(
    messages: MessageLike[],
    frozenIds: Set<string>,
    options: {
        detect: boolean;
        watermark: number;
        messageTagNumbers: Map<MessageLike, number>;
    },
): StripProcessedImagesResult {
    const { detect, watermark, messageTagNumbers } = options;
    let stripped = 0;
    const newlyStrippedIds: string[] = [];
    let hasAssistantResponse = false;

    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.info.role === "assistant") {
            hasAssistantResponse = true;
            continue;
        }
        if (msg.info.role !== "user") {
            continue;
        }

        const id = typeof msg.info.id === "string" ? msg.info.id : undefined;
        const inFrozen = id !== undefined && frozenIds.has(id);
        const maxTag = messageTagNumbers.get(msg) ?? 0;
        const isNewDetection =
            !inFrozen && detect && hasAssistantResponse && id !== undefined && maxTag <= watermark;

        if (!inFrozen && !isNewDetection) {
            continue;
        }

        let touchedThisMsg = false;
        for (let j = 0; j < msg.parts.length; j++) {
            const part = msg.parts[j];
            if (!isRecord(part) || part.type !== "file") {
                continue;
            }
            if (typeof part.mime !== "string" || !part.mime.startsWith("image/")) {
                continue;
            }
            if (
                typeof part.url === "string" &&
                part.url.startsWith("data:") &&
                part.url.length > 200
            ) {
                msg.parts[j] = makeSentinel(part);
                stripped++;
                touchedThisMsg = true;
            }
        }
        if (touchedThisMsg && isNewDetection && id !== undefined) {
            newlyStrippedIds.push(id);
        }
    }

    return { stripped, newlyStrippedIds };
}
