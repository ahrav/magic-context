import type { ContextDatabase } from "../../features/magic-context/storage";
import { getSourceContents, saveSourceContent } from "../../features/magic-context/storage";
import {
    adoptNullOwnerToolTag,
    getCandidateToolOwners,
    getNullOwnerToolTag,
    getToolTagNumberByOwner,
    pickNearestPriorOwner,
} from "../../features/magic-context/storage-tags";
import { makeToolCompositeKey, type Tagger } from "../../features/magic-context/tagger";
import { textMentionsRecentCommit } from "../../shared/commit-detection";
import { isRecord } from "../../shared/record-type-guard";
import { isReduceToolPart } from "./drop-stale-reduce-calls";
import { estimateImageTokensFromDataUrl } from "./image-token-estimate";
import { getMessageTimesFromOpenCodeDb } from "./read-session-db";
import { estimateTokens } from "./read-session-formatting";
import { byteSize, isThinkingPart, prependTag } from "./tag-content-primitives";
import { createExistingTagResolver } from "./tag-id-fallback";
import {
    buildFileSourceContent,
    isFilePart,
    isTextPart,
    isToolPartWithOutput,
    stripTagPrefix,
} from "./tag-part-guards";
import {
    createToolDropTarget,
    extractToolCallObservation,
    partHasCompletedResult,
    type ToolCallIndex,
    type ToolDropResult,
    ToolMutationBatch,
} from "./tool-drop-target";
import { logTransformTiming } from "./transform-stage-logger";

interface ToolOwnerDerivationCache {
    candidateOwnersByCallId: Map<string, string[]>;
    messageTimesById: Map<string, number | null>;
}

type ToolOwnerFallbackLookup =
    | { kind: "candidates"; callId: string }
    | { kind: "messageTimes"; messageIds: readonly string[] };

const TOOL_OWNER_CACHE_KEY_SEP = "\x00";

function makeToolOwnerCacheKey(sessionId: string, callId: string): string {
    return `${sessionId}${TOOL_OWNER_CACHE_KEY_SEP}${callId}`;
}

function getCachedCandidateToolOwners(
    db: ContextDatabase,
    sessionId: string,
    callId: string,
    cache: ToolOwnerDerivationCache,
    onLookup?: (lookup: ToolOwnerFallbackLookup) => void,
): string[] {
    const key = makeToolOwnerCacheKey(sessionId, callId);
    const cached = cache.candidateOwnersByCallId.get(key);
    if (cached !== undefined) return cached;

    onLookup?.({ kind: "candidates", callId });
    const candidates = getCandidateToolOwners(db, sessionId, callId);
    cache.candidateOwnersByCallId.set(key, candidates);
    return candidates;
}

function getCachedMessageTimesFromOpenCodeDb(
    sessionId: string,
    messageIds: readonly string[],
    cache: ToolOwnerDerivationCache,
    onLookup?: (lookup: ToolOwnerFallbackLookup) => void,
): Map<string, number> {
    const uncached = [...new Set(messageIds)].filter((id) => !cache.messageTimesById.has(id));
    if (uncached.length > 0) {
        onLookup?.({ kind: "messageTimes", messageIds: uncached });
        const resolved = getMessageTimesFromOpenCodeDb(sessionId, uncached);
        for (const id of uncached) {
            cache.messageTimesById.set(id, resolved.get(id) ?? null);
        }
    }

    const times = new Map<string, number>();
    for (const id of messageIds) {
        const time = cache.messageTimesById.get(id);
        if (typeof time === "number") times.set(id, time);
    }
    return times;
}

function invalidateCachedCandidateToolOwnersIfNewOwner(
    cache: ToolOwnerDerivationCache,
    sessionId: string,
    callId: string,
    ownerMsgId: string,
): void {
    const key = makeToolOwnerCacheKey(sessionId, callId);
    const cached = cache.candidateOwnersByCallId.get(key);
    if (cached !== undefined && !cached.includes(ownerMsgId)) {
        cache.candidateOwnersByCallId.delete(key);
    }
}

/**
 *
 *
 */
function deriveToolOwnerMessageId(
    sessionId: string,
    db: ContextDatabase,
    message: MessageLike,
    obs: { callId: string; kind: "invocation" | "result" },
    unpaired: Map<string, string[]>,
    cache: ToolOwnerDerivationCache,
    onFallbackLookup?: (lookup: ToolOwnerFallbackLookup) => void,
): string {
    const messageId = typeof message.info.id === "string" ? message.info.id : "";

    if (obs.kind === "invocation") {
        if (messageId) {
            const queue = unpaired.get(obs.callId) ?? [];
            queue.push(messageId);
            unpaired.set(obs.callId, queue);
            return messageId;
        }
        return obs.callId;
    }

    const queue = unpaired.get(obs.callId);
    if (queue && queue.length > 0) {
        const popped = queue.shift();
        if (queue.length === 0) unpaired.delete(obs.callId);
        if (popped !== undefined) return popped;
    }

    //
    //
    if (messageId) {
        const candidates = getCachedCandidateToolOwners(
            db,
            sessionId,
            obs.callId,
            cache,
            onFallbackLookup,
        );
        if (candidates.length > 0) {
            const ids = [...candidates, messageId];
            const times = getCachedMessageTimesFromOpenCodeDb(
                sessionId,
                ids,
                cache,
                onFallbackLookup,
            );
            const persisted = pickNearestPriorOwner(candidates, messageId, times);
            if (persisted !== null) return persisted;
        }
        return messageId;
    }
    return obs.callId;
}

export type MessageInfo = {
    id?: string;
    role?: string;
    sessionID?: string;
    summary?: boolean;
    /** syntheticHead marks one of the two m[0]/m[1] messages prepended by compartment injection. */
    syntheticHead?: boolean;
    finish?: string;
    error?: unknown;
};

export interface ThinkingLikePart {
    type: string;
    thinking?: string;
    text?: string;
}

export type MessageLike = { info: MessageInfo; parts: unknown[] };

export interface TagNormalizationTarget {
    tagNumber: number;
    message: MessageLike;
    part: unknown;
    field: "text" | "tool_state_output" | "tool_result_content";
}

export type TagTarget = {
    setContent: (content: string) => boolean;
    getContent?: () => string | null;
    drop?: () => ToolDropResult;
    truncate?: () => ToolDropResult;
    /** `editMarker` retains a superseded edit/write call, its `filePath`, and a diff-region hint while replacing its output with `[dropped §N§]`.
     * */
    editMarker?: () => ToolDropResult;
    /** `canDrop` reports whether `drop()` or `truncate()` would reclaim bytes without mutating content.
     * `canDrop` is absent on message and file targets. */
    canDrop?: () => boolean;
    /** `readInput` returns the tool invocation input object without mutating it.
     * `readInput` returns `null` when no invocation part exists. */
    readInput?: () => Record<string, unknown> | null;
    message?: MessageLike;
};

export interface TagMessagesResult {
    targets: Map<number, TagTarget>;
    reasoningByMessage: Map<MessageLike, ThinkingLikePart[]>;
    messageTagNumbers: Map<MessageLike, number>;
    toolCallIndex: ToolCallIndex;
    batch: ToolMutationBatch;
    hasRecentReduceCall: boolean;
    /* */
    hasRecentCommit: boolean;
    /** The field stores exact part references tagged by tagMessages. */
    normalizationTargets: TagNormalizationTarget[];
}

function collectRelevantSourceTagIds(
    messages: MessageLike[],
    assignments: ReadonlyMap<string, number>,
): number[] {
    const currentMessageIds = new Set(
        messages.flatMap((message) =>
            typeof message.info.id === "string" ? [message.info.id] : [],
        ),
    );

    const relevantTagIds = new Set<number>();
    for (const [contentId, tagId] of assignments) {
        const match = /^(.*):(p|file)\d+$/.exec(contentId);
        if (!match) continue;
        if (!currentMessageIds.has(match[1])) continue;
        relevantTagIds.add(tagId);
    }

    return Array.from(relevantTagIds);
}

function getReasoningByteSize(parts: ThinkingLikePart[]): number {
    let reasoningBytes = 0;

    for (const part of parts) {
        const content = part.thinking ?? part.text ?? "";
        if (content && content !== "[cleared]") {
            reasoningBytes += byteSize(content);
        }
    }

    return reasoningBytes;
}

/**
 */
function getReasoningTokenCount(parts: ThinkingLikePart[]): number {
    let tokens = 0;
    for (const part of parts) {
        const content = part.thinking ?? part.text ?? "";
        if (content && content !== "[cleared]") {
            tokens += estimateTokens(content);
        }
    }
    return tokens;
}

function serializeToolInput(input: unknown): string | null {
    try {
        return JSON.stringify(input) ?? null;
    } catch {
        return null;
    }
}

function estimateInputByteSize(serializedInput: string | null): number {
    return serializedInput?.length ?? 0;
}

/** The field stores the real-tokenizer count for a string or JSON-serializable tool input payload. */
function estimateInputTokenCount(input: unknown, serializedInput: string | null): number {
    if (input === undefined || input === null) return 0;
    const tokenText = typeof input === "string" ? input : serializedInput;
    return tokenText ? estimateTokens(tokenText) : 0;
}

/**
 * Tag token counts use the visual-token heuristic for images and tokenize plain text directly.
 */
function estimateTextTagTokenCount(text: string): number {
    if (!text) return 0;
    if (text.startsWith("data:image/")) return estimateImageTokensFromDataUrl(text);
    return estimateTokens(text);
}

function extractToolTagMetadata(part: unknown): {
    toolName: string | null;
    inputByteSize: number;
    inputTokenCount: number;
} {
    if (!isRecord(part)) {
        return { toolName: null, inputByteSize: 0, inputTokenCount: 0 };
    }

    const toolName =
        typeof part.tool === "string"
            ? part.tool
            : typeof part.toolName === "string"
              ? part.toolName
              : typeof part.name === "string"
                ? part.name
                : null;
    const state = isRecord(part.state) ? part.state : null;
    const input = state?.input ?? part.args ?? part.input ?? {};
    const serializedInput = serializeToolInput(input);

    return {
        toolName,
        inputByteSize: estimateInputByteSize(serializedInput),
        inputTokenCount: estimateInputTokenCount(input, serializedInput),
    };
}

export interface TagMessagesOptions {
    /**
     * Denying `ctx_reduce` suppresses agent-visible tag prefixes because agents cannot act on them.
     * The session freezes the availability verdict so message shape remains stable.
     */
    skipPrefixInjection?: boolean;
    /* */
    onToolOwnerFallbackLookup?: (lookup: ToolOwnerFallbackLookup) => void;
}

export function tagMessages(
    sessionId: string,
    messages: MessageLike[],
    tagger: Tagger,
    db: ContextDatabase,
    options: TagMessagesOptions = {},
): TagMessagesResult {
    const skipPrefixInjection = options.skipPrefixInjection === true;
    const onToolOwnerFallbackLookup = options.onToolOwnerFallbackLookup;
    const targets = new Map<number, TagTarget>();
    const normalizationTargets: TagNormalizationTarget[] = [];
    const reasoningByMessage = new Map<MessageLike, ThinkingLikePart[]>();
    const messageTagNumbers = new Map<MessageLike, number>();
    // Keys are composite `<ownerMsgId>\x00<callId>`, not bare `callId`.
    // Two assistant turns that reuse a callId produce distinct keys when their ownerMsgId values differ.
    const toolTagByCallId = new Map<string, number>();
    const toolThinkingByCallId = new Map<string, ThinkingLikePart[]>();
    const toolCallIndex: ToolCallIndex = new Map();
    const unpairedInvocations = new Map<string, string[]>();
    const ownerDerivationCache: ToolOwnerDerivationCache = {
        candidateOwnersByCallId: new Map(),
        messageTimesById: new Map(),
    };
    // The isToolPartWithOutput block reads the cache so it does not run FIFO pairing again.
    const ownerByPartKey = new Map<unknown, { ownerMsgId: string; callId: string }>();
    const batch = new ToolMutationBatch(messages);
    const assignments = tagger.getAssignments(sessionId);
    const resolver = createExistingTagResolver(sessionId, tagger, db);
    const tGetSourceContents = performance.now();
    const sourceContents = getSourceContents(
        db,
        sessionId,
        collectRelevantSourceTagIds(messages, assignments),
    );
    logTransformTiming(sessionId, "tag.getSourceContents", tGetSourceContents);
    let precedingThinkingParts: ThinkingLikePart[] = [];
    let lastReduceMessageIndex = -1;
    const RECENT_REDUCE_LOOKBACK = 10;
    const COMMIT_LOOKBACK = 5;
    let commitDetected = false;

    // The tagging pass must not run inside db.transaction(...).
    // tagger.assignTag() uses a SAVEPOINT to atomically insert the tag and update its counter.
    // An outer transaction would roll back earlier writes when a later UNIQUE collision occurs.
    // A late UNIQUE collision would roll back all tag inserts and saveSourceContent calls in the pass.
    // A rollback would leave in-memory message mutations and §N§ prefixes applied.
    //
    // Each tagger.assignTag() SAVEPOINT isolates that call's database operations.
    // Each tag insert and counter upsert succeeds or fails independently.
    // A failed tag operation does not roll back other operations in the pass.
    let accDerive = 0;
    let accGetToolTag = 0;
    let accAssignTag = 0;
    let accAssignToolTag = 0;
    let accSaveSource = 0;
    const tLoop = performance.now();
    for (let msgIndex = 0; msgIndex < messages.length; msgIndex++) {
        const message = messages[msgIndex];
        const messageId = typeof message.info.id === "string" ? message.info.id : null;

        if (message.info.role === "user") {
            precedingThinkingParts = [];
        }

        const messageThinkingParts = message.parts.filter(isThinkingPart);
        if (messageThinkingParts.length > 0) {
            reasoningByMessage.set(message, messageThinkingParts);
        }
        const messageHasTextPart = message.parts.some(isTextPart);
        let textOrdinal = 0;
        let fileOrdinal = 0;

        for (let partIndex = 0; partIndex < message.parts.length; partIndex += 1) {
            const part = message.parts[partIndex];

            if (isReduceToolPart(part)) {
                lastReduceMessageIndex = msgIndex;
            }

            const toolObservation = extractToolCallObservation(part);
            if (toolObservation) {
                // Invocation parts use their hosting message ID when it is nonempty; otherwise they use callId.
                // Result parts pop the FIFO queue for callId when that queue is nonempty.
                // When the FIFO queue is empty and the result has a message ID, result parts use the nearest prior persisted owner.
                // When no persisted owner exists and the result has a message ID, result parts use that message ID.
                const _tDerive = performance.now();
                const ownerMsgId = deriveToolOwnerMessageId(
                    sessionId,
                    db,
                    message,
                    toolObservation,
                    unpairedInvocations,
                    ownerDerivationCache,
                    onToolOwnerFallbackLookup,
                );
                accDerive += performance.now() - _tDerive;
                const compositeKey = makeToolCompositeKey(ownerMsgId, toolObservation.callId);
                const entry = toolCallIndex.get(compositeKey) ?? {
                    occurrences: [],
                    hasResult: false,
                };
                entry.occurrences.push({ message, part, kind: toolObservation.kind });
                // OpenCode `{ type: "tool" }` parts have type `"tool"` even while their calls are pending or running.
                // Pending and running OpenCode tool parts are not completed results.
                // hasResult requires state.output to be present.
                // Reclaim selectors exclude open arcs so live task inputs cannot become reclaim targets.
                // task part's input must never become a reclaim target.
                if (toolObservation.kind === "result" && partHasCompletedResult(part))
                    entry.hasResult = true;
                toolCallIndex.set(compositeKey, entry);

                const _tGetTool = performance.now();
                let existingTagId = tagger.getToolTag(
                    sessionId,
                    toolObservation.callId,
                    ownerMsgId,
                );
                accGetToolTag += performance.now() - _tGetTool;

                // The invocation-only path adopts legacy NULL owners.
                // prematurely.
                if (existingTagId === undefined) {
                    const orphan = getNullOwnerToolTag(db, sessionId, toolObservation.callId);
                    if (orphan !== null) {
                        const claimed = adoptNullOwnerToolTag(db, orphan.id, ownerMsgId);
                        if (claimed) {
                            invalidateCachedCandidateToolOwnersIfNewOwner(
                                ownerDerivationCache,
                                sessionId,
                                toolObservation.callId,
                                ownerMsgId,
                            );
                            tagger.bindToolTag(
                                sessionId,
                                toolObservation.callId,
                                ownerMsgId,
                                orphan.tagNumber,
                            );
                            existingTagId = orphan.tagNumber;
                        } else {
                            existingTagId = tagger.getToolTag(
                                sessionId,
                                toolObservation.callId,
                                ownerMsgId,
                            );
                        }
                    }
                }

                if (existingTagId === undefined) {
                    const persisted = getToolTagNumberByOwner(
                        db,
                        sessionId,
                        toolObservation.callId,
                        ownerMsgId,
                    );
                    if (persisted !== null) {
                        tagger.bindToolTag(
                            sessionId,
                            toolObservation.callId,
                            ownerMsgId,
                            persisted,
                        );
                        existingTagId = persisted;
                    }
                }

                if (existingTagId !== undefined) {
                    toolTagByCallId.set(compositeKey, existingTagId);
                    messageTagNumbers.set(
                        message,
                        Math.max(messageTagNumbers.get(message) ?? 0, existingTagId),
                    );
                    if (
                        message.info.role === "tool" &&
                        precedingThinkingParts.length > 0 &&
                        !toolThinkingByCallId.has(compositeKey)
                    ) {
                        toolThinkingByCallId.set(compositeKey, precedingThinkingParts);
                    }
                }
                ownerByPartKey.set(part, { ownerMsgId, callId: toolObservation.callId });
            }

            if (messageId && isTextPart(part)) {
                const textPart = part;
                const thinkingParts = messageThinkingParts;
                const contentId = `${messageId}:p${partIndex}`;
                resolver.resolve(messageId, "message", contentId, textOrdinal);
                const reasoningBytes = textOrdinal === 0 ? getReasoningByteSize(thinkingParts) : 0;
                const reasoningTokens =
                    textOrdinal === 0 ? getReasoningTokenCount(thinkingParts) : 0;
                const _tAssignText = performance.now();
                const tagId = tagger.assignTag(
                    sessionId,
                    contentId,
                    "message",
                    byteSize(textPart.text),
                    db,
                    reasoningBytes,
                    null,
                    0,
                    null,
                    () => ({
                        tokenCount: estimateTextTagTokenCount(stripTagPrefix(textPart.text)),
                        inputTokenCount: null,
                        reasoningTokenCount: reasoningTokens,
                    }),
                );
                accAssignTag += performance.now() - _tAssignText;
                const persistedSource = sourceContents.get(tagId);
                if (persistedSource !== undefined) {
                    textPart.text = persistedSource;
                } else {
                    const sourceContent = stripTagPrefix(textPart.text);
                    if (sourceContent.trim().length > 0) {
                        const _tSaveText = performance.now();
                        saveSourceContent(db, sessionId, tagId, sourceContent);
                        accSaveSource += performance.now() - _tSaveText;
                    }
                }
                messageTagNumbers.set(
                    message,
                    Math.max(messageTagNumbers.get(message) ?? 0, tagId),
                );
                if (!skipPrefixInjection) {
                    textPart.text = prependTag(tagId, textPart.text);
                    normalizationTargets.push({
                        tagNumber: tagId,
                        message,
                        part: textPart,
                        field: "text",
                    });
                }
                targets.set(tagId, {
                    message,
                    setContent: (content) => {
                        if (textPart.text === content) return false;
                        textPart.text = content;
                        for (const tp of thinkingParts) {
                            if (tp.thinking !== undefined) tp.thinking = "[cleared]";
                            if (tp.text !== undefined) tp.text = "[cleared]";
                        }
                        return true;
                    },
                    getContent: () => textPart.text,
                });
                textOrdinal += 1;
                continue;
            }

            if (isToolPartWithOutput(part)) {
                const toolPart = part;
                const thinkingParts = precedingThinkingParts;
                const reasoningBytes = getReasoningByteSize(thinkingParts);
                const reasoningTokens = getReasoningTokenCount(thinkingParts);
                const { toolName, inputByteSize, inputTokenCount } =
                    extractToolTagMetadata(toolPart);

                // The memoized owner prevents a second dequeue for the same part.
                // extractToolCallObservation already assigned an owner for this part.
                // Reusing the memoized owner prevents a second dequeue and preserves later result pairing for the same callId.
                const memo = ownerByPartKey.get(part);
                const ownerMsgId = memo?.ownerMsgId ?? messageId ?? toolPart.callID;
                const compositeKey = makeToolCompositeKey(ownerMsgId, toolPart.callID);

                const _tAssignTool = performance.now();
                const tagId = tagger.assignToolTag(
                    sessionId,
                    toolPart.callID,
                    ownerMsgId,
                    byteSize(toolPart.state.output),
                    db,
                    reasoningBytes,
                    toolName,
                    inputByteSize,
                    () => ({
                        tokenCount: estimateTextTagTokenCount(
                            stripTagPrefix(toolPart.state.output),
                        ),
                        inputTokenCount,
                        reasoningTokenCount: reasoningTokens,
                    }),
                );
                invalidateCachedCandidateToolOwnersIfNewOwner(
                    ownerDerivationCache,
                    sessionId,
                    toolPart.callID,
                    ownerMsgId,
                );
                accAssignToolTag += performance.now() - _tAssignTool;
                messageTagNumbers.set(
                    message,
                    Math.max(messageTagNumbers.get(message) ?? 0, tagId),
                );
                if (!skipPrefixInjection) {
                    toolPart.state.output = prependTag(tagId, toolPart.state.output);
                    normalizationTargets.push({
                        tagNumber: tagId,
                        message,
                        part: toolPart,
                        field: "tool_state_output",
                    });
                }
                toolTagByCallId.set(compositeKey, tagId);
                if (thinkingParts.length > 0 && !toolThinkingByCallId.has(compositeKey)) {
                    toolThinkingByCallId.set(compositeKey, thinkingParts);
                }
            }

            if (messageId && isFilePart(part)) {
                const filePart = part;
                const messageParts = message.parts;
                const contentId = `${messageId}:file${partIndex}`;
                const existingTagId = resolver.resolve(messageId, "file", contentId, fileOrdinal);
                const _tAssignFile = performance.now();
                const tagId = tagger.assignTag(
                    sessionId,
                    contentId,
                    "file",
                    byteSize(filePart.url),
                    db,
                    0,
                    null,
                    0,
                    null,
                    () => ({
                        tokenCount: estimateTextTagTokenCount(filePart.url),
                        inputTokenCount: null,
                        reasoningTokenCount: null,
                    }),
                );
                accAssignTag += performance.now() - _tAssignFile;
                if (existingTagId === undefined) {
                    const sourceContent = buildFileSourceContent(message.parts);
                    if (sourceContent) {
                        const _tSaveFile = performance.now();
                        saveSourceContent(db, sessionId, tagId, sourceContent);
                        accSaveSource += performance.now() - _tSaveFile;
                    }
                }
                messageTagNumbers.set(
                    message,
                    Math.max(messageTagNumbers.get(message) ?? 0, tagId),
                );
                targets.set(tagId, {
                    message,
                    setContent: (content) => {
                        const prev = messageParts[partIndex];
                        const prevText =
                            typeof prev === "object" && prev !== null && "text" in prev
                                ? (prev as { text: string }).text
                                : "";
                        if (prevText === content) return false;
                        messageParts[partIndex] = {
                            type: "text",
                            text: content,
                        } as MessageLike["parts"][number];
                        return true;
                    },
                });
                fileOrdinal += 1;
            }
        }

        if (message.info.role === "assistant" && !messageHasTextPart) {
            precedingThinkingParts = messageThinkingParts;
        }

        if (
            !commitDetected &&
            message.info.role === "assistant" &&
            messages.length - msgIndex <= COMMIT_LOOKBACK
        ) {
            for (const part of message.parts) {
                if (isTextPart(part)) {
                    const text = (part as { text: string }).text;
                    if (textMentionsRecentCommit(text)) {
                        commitDetected = true;
                        break;
                    }
                }
            }
        }
    }

    logTransformTiming(sessionId, "tag.loop", tLoop);
    logTransformTiming(sessionId, "tag.deriveOwner", performance.now() - accDerive);
    logTransformTiming(sessionId, "tag.getToolTag", performance.now() - accGetToolTag);
    logTransformTiming(sessionId, "tag.assignTag", performance.now() - accAssignTag);
    logTransformTiming(sessionId, "tag.assignToolTag", performance.now() - accAssignToolTag);
    logTransformTiming(sessionId, "tag.saveSource", performance.now() - accSaveSource);

    for (const [compositeKey, tagId] of toolTagByCallId) {
        const thinkingParts = toolThinkingByCallId.get(compositeKey) ?? [];
        targets.set(
            tagId,
            createToolDropTarget(compositeKey, thinkingParts, toolCallIndex, batch, tagId),
        );
    }

    const hasRecentReduceCall =
        lastReduceMessageIndex >= 0 &&
        messages.length - lastReduceMessageIndex <= RECENT_REDUCE_LOOKBACK;

    return {
        targets,
        reasoningByMessage,
        messageTagNumbers,
        toolCallIndex,
        batch,
        hasRecentReduceCall,
        hasRecentCommit: commitDetected,
        normalizationTargets,
    };
}
