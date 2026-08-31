import { OMO_INTERNAL_INITIATOR_MARKER } from "../../shared/internal-initiator-marker";
import { removeSystemReminders } from "../../shared/system-directive";
import {
    getRawSessionMessageCountFromDb,
    openCodeDbExists,
    withReadOnlySessionDb,
} from "./read-session-db";
import {
    type ChunkBlock,
    compactRole,
    compactTextForSummary,
    estimateTokens,
    extractTexts,
    extractToolCallSummaries,
    formatBlock,
    hasMeaningfulUserText,
    mergeCommitHashes,
    normalizeText,
    type SessionChunkLine,
} from "./read-session-formatting";
import {
    countRawSessionMessageOrdinalsFromDb,
    countStoredRawSessionMessagesFromDb,
    type RawMessage,
    type RawMessageOrdinalAnchor,
    type RawMessageOrdinalEntry,
    type RawMessageParts,
    readRawSessionMessageByIdFromDb,
    readRawSessionMessageOrdinalByIdFromDb,
    readRawSessionMessageOrdinalPageFromDb,
    readRawSessionMessagePageFromDb,
    readRawSessionMessagePartsByIdFromDb,
    readRawSessionMessagesFromDb,
    readRawSessionTailFromDb,
} from "./read-session-raw";
import { buildToolArcs } from "./read-session-true-raw-tokens";
import { isFilePart, isTextPart } from "./tag-part-guards";
import { extractToolCallObservation } from "./tool-drop-target";

export { extractTexts, hasMeaningfulUserText } from "./read-session-formatting";

/**
 * Block-tokenization memo.
 *
 * `readSessionChunk` re-tokenizes the TC-chunked eligible tail on every `message.updated` event.
 * `lastCompartmentEnd + 1` anchors the eligible window, which is built forward.
 * Blocks before the growing tail produce byte-identical `formatBlock` text.
 * Exact-text keys preserve the result of `estimateTokens`.
 * `blockTokenMemo` cannot replace the per-tag token store because the two stores count different content.
 * The per-tag token store counts full content, whereas `blockTokenMemo` counts TC-chunked content.
 * Tool outputs contribute one-line summaries to the TC-chunked token count.
 *
 * `blockTokenMemo` evicts the least-recently-used entry at 2,048 entries; exact string keys avoid hash collisions.
 */
const BLOCK_TOKEN_MEMO_MAX = 2048;
const blockTokenMemo = new Map<string, number>();
function estimateBlockTokens(blockText: string): number {
    const cached = blockTokenMemo.get(blockText);
    if (cached !== undefined) {
        // `delete` and `set` refresh recency because `Map` preserves insertion order.
        blockTokenMemo.delete(blockText);
        blockTokenMemo.set(blockText, cached);
        return cached;
    }
    const count = estimateTokens(blockText);
    if (blockTokenMemo.size >= BLOCK_TOKEN_MEMO_MAX) {
        const oldest = blockTokenMemo.keys().next().value;
        if (oldest !== undefined) blockTokenMemo.delete(oldest);
    }
    blockTokenMemo.set(blockText, count);
    return count;
}

let activeRawMessageCache: Map<string, RawMessage[]> | null = null;
// `activeAbsoluteCountCache` shares `activeRawMessageCache`'s lifecycle.
// `activeAbsoluteCountCache` stores the absolute message count when `activeRawMessageCache` contains only a tail slice.
// Consumers requiring the absolute count call `getCachedAbsoluteMessageCount`.
// A null `activeAbsoluteCountCache` means no tail slice is active, so consumers use the cached array length.
// array length".
let activeAbsoluteCountCache: Map<string, number> | null = null;

/**
 * `RawMessageProvider` overrides raw-message reads for one session.
 *
 * `readRawSessionMessages` reads OpenCode's session DB when no provider is registered.
 * `Pi` reads session data through `pi.sessionManager.getBranch()`.
 * `Pi` registers a `RawMessageProvider` for each session.
 * `RawMessageProvider` registration must precede calls to shared raw-message helpers.
 *
 * A registered provider takes precedence over the OpenCode-DB default for its `sessionId`.
 * Sessions without a registered provider use the OpenCode-DB default.
 *
 * Provider registrations must last one historian or trigger evaluation.
 * Providers must be unregistered after the evaluation to prevent session state from leaking across plugin instances.
 * `withRawMessageProvider` enforces this scoped lifetime.
 * scope.
 */
export interface RawMessageProvider {
    readMessages(): RawMessage[];
    readMessagePage?: (afterOrdinal: number, limit: number, finalWatermark: number) => RawMessage[];
    readMessageById?: (messageId: string) => RawMessage | null;
    readMessagePartsById?: (messageId: string) => RawMessageParts | null;
    readMessageOrdinalById?: (messageId: string) => number | null;
    readMessageIdOrdinals?: () => Map<string, number>;
    readMessageOrdinalPage?: (
        after: RawMessageOrdinalAnchor | null,
        limit: number,
    ) => RawMessageOrdinalEntry[];
    /** `getMessageCount` falls back to `readMessages().length` when no fast count is available. */
    getMessageCount?: () => number;
    /** The stored row count includes compaction summaries for ordinal drift detection. */
    getStoredMessageCount?: () => number;
}

const sessionProviders = new Map<string, RawMessageProvider>();

/**
 * historian.
 */
export function setRawMessageProvider(sessionId: string, provider: RawMessageProvider): () => void {
    sessionProviders.set(sessionId, provider);
    return () => {
        const current = sessionProviders.get(sessionId);
        if (current === provider) sessionProviders.delete(sessionId);
    };
}

/**
 * `withRawMessageProvider` unregisters the provider after `fn` throws or returns, except after a returned promise settles.
 *
 * A synchronous `finally` unregisters the provider when `fn` returns a pending promise, before later awaited reads.
 * A synchronous `finally` would route later awaited reads to OpenCode's session DB.
 * OpenCode's session DB is empty for Pi sessions and may be absent on Pi-only installs.
 * On Pi-only installs, reading OpenCode's absent session DB throws `unable to open database file`.
 */
export function withRawMessageProvider<T>(
    sessionId: string,
    provider: RawMessageProvider,
    fn: () => T,
): T {
    const cleanup = setRawMessageProvider(sessionId, provider);
    let result: T;
    try {
        result = fn();
    } catch (error) {
        cleanup();
        throw error;
    }
    if (
        result !== null &&
        typeof result === "object" &&
        typeof (result as { then?: unknown }).then === "function"
    ) {
        return (result as unknown as Promise<unknown>).finally(cleanup) as unknown as T;
    }
    cleanup();
    return result;
}

/** Chunk compaction strips system-reminder blocks and OMO markers from user text. */
export function cleanUserText(text: string): string {
    return removeSystemReminders(text).replace(OMO_INTERNAL_INITIATOR_MARKER, "").trim();
}

export interface SessionChunk {
    startIndex: number;
    endIndex: number;
    startMessageId: string;
    endMessageId: string;
    messageCount: number;
    tokenEstimate: number;
    hasMore: boolean;
    text: string;
    lines: SessionChunkLine[];
    /** The commit-cluster count includes assistant blocks with commits separated by meaningful user turns. */
    commitClusterCount: number;
    /**
     * Tool-only ranges contain TC lines and no narrative text.
     * Validation absorbs gaps that fall fully within these ranges regardless of size.
     * Gaps outside tool-only ranges fail validation and trigger a repair retry.
     */
    toolOnlyRanges: Array<{ start: number; end: number }>;
    /** The raw snapshot includes completed call/result ranges, including results past this chunk. */
    completedToolArcs: Array<{ start: number; end: number }>;
}

export function withRawSessionMessageCache<T>(fn: () => T): T {
    const outerCache = activeRawMessageCache;
    if (!outerCache) {
        activeRawMessageCache = new Map();
        activeAbsoluteCountCache = new Map();
    }

    try {
        return fn();
    } finally {
        if (!outerCache) {
            activeRawMessageCache = null;
            activeAbsoluteCountCache = null;
        }
    }
}

export function readRawSessionMessages(sessionId: string): RawMessage[] {
    if (activeRawMessageCache) {
        const cached = activeRawMessageCache.get(sessionId);
        if (cached) {
            return cached;
        }

        const messages = readRawSessionMessagesFromSource(sessionId);
        activeRawMessageCache.set(sessionId, messages);
        return messages;
    }

    return readRawSessionMessagesFromSource(sessionId);
}

export function readRawSessionMessagePage(
    sessionId: string,
    afterOrdinal: number,
    limit: number,
    finalWatermark: number,
): RawMessage[] {
    const provider = sessionProviders.get(sessionId);
    if (provider?.readMessagePage) {
        return provider.readMessagePage(afterOrdinal, limit, finalWatermark);
    }
    if (provider) {
        return provider
            .readMessages()
            .filter(
                (message) => message.ordinal > afterOrdinal && message.ordinal <= finalWatermark,
            )
            .slice(0, limit);
    }
    if (!openCodeDbExists()) return [];
    return withReadOnlySessionDb((db) =>
        readRawSessionMessagePageFromDb(db, sessionId, afterOrdinal, limit, finalWatermark),
    );
}

export function getRawSessionMessageOrdinalCount(sessionId: string): number {
    const provider = sessionProviders.get(sessionId);
    if (provider) {
        if (provider.getMessageCount) return provider.getMessageCount();
        return provider.readMessages().length;
    }
    if (!openCodeDbExists()) return 0;
    return withReadOnlySessionDb((db) => countRawSessionMessageOrdinalsFromDb(db, sessionId));
}

readRawSessionMessages.readPage = readRawSessionMessagePage;
readRawSessionMessages.getCount = getRawSessionMessageOrdinalCount;

/**
 * The boundary-resolution path primes the active raw-message cache with messages at or after the last compartment boundary; subsequent `readRawSessionMessages(sessionId)` calls reuse the cache.
 *
 * Compartment-trigger boundary resolution is O(tail).
 * Boundary resolution never reads below `baseOrdinal + 1`.
 * Tail-cache reads scale with tail length rather than session length.
 *
 * The cached array uses absolute ordinals starting at `baseOrdinal + 1`.
 * The parallel absolute-count cache stores the true total for `.length`-style consumers.
 *
 * The function returns `false` when a provider is registered, no OpenCode DB exists, the cache is populated, or no usable boundary anchor exists; the caller then performs a full read.
 */
export function primeTailRawMessageCache(args: {
    sessionId: string;
    lastCompartmentEnd: number;
    anchorMessageId: string | null;
}): boolean {
    const { sessionId, lastCompartmentEnd, anchorMessageId } = args;
    if (!activeRawMessageCache) return false;
    if (activeRawMessageCache.has(sessionId)) return false;
    if (sessionProviders.has(sessionId)) return false;
    if (!openCodeDbExists()) return false;
    if (lastCompartmentEnd < 1 || !anchorMessageId) return false;

    const result = withReadOnlySessionDb((db) =>
        readRawSessionTailFromDb(db, sessionId, lastCompartmentEnd, anchorMessageId),
    );
    if (!result) return false; // anchor not found → caller uses full read
    activeRawMessageCache.set(sessionId, result.messages);
    activeAbsoluteCountCache?.set(sessionId, result.absoluteMessageCount);
    return true;
}

/**
 */
export function getCachedAbsoluteMessageCount(sessionId: string): number | null {
    return activeAbsoluteCountCache?.get(sessionId) ?? null;
}

/**
 *
 * The function requires a `withRawSessionMessageCache` scope, does not shadow a registered provider, and leaves an existing session cache unchanged.
 *
 */
export function primeInMemoryTailRawMessageCache(args: {
    sessionId: string;
    messages: RawMessage[];
    absoluteMessageCount: number;
}): boolean {
    const { sessionId, messages, absoluteMessageCount } = args;
    if (!activeRawMessageCache) return false;
    if (activeRawMessageCache.has(sessionId)) return false;
    if (sessionProviders.has(sessionId)) return false;
    activeRawMessageCache.set(sessionId, messages);
    activeAbsoluteCountCache?.set(sessionId, absoluteMessageCount);
    return true;
}

export function readRawSessionMessageOrdinalPage(
    sessionId: string,
    after: RawMessageOrdinalAnchor | null,
    limit: number,
): RawMessageOrdinalEntry[] {
    const provider = sessionProviders.get(sessionId);
    if (provider?.readMessageOrdinalPage) return provider.readMessageOrdinalPage(after, limit);
    if (provider) {
        const rows = provider
            .readMessages()
            .map((message) => ({
                id: message.id,
                timeCreated: message.createdAt ?? message.ordinal,
                contributesOrdinal: true,
                hasValidInfo: true,
            }))
            .filter(
                (row) =>
                    !after ||
                    row.timeCreated > after.timeCreated ||
                    (row.timeCreated === after.timeCreated && row.id > after.id),
            )
            .sort(
                (left, right) =>
                    left.timeCreated - right.timeCreated || left.id.localeCompare(right.id),
            );
        return rows.slice(0, Math.max(1, Math.floor(limit)));
    }
    if (!openCodeDbExists()) return [];
    return withReadOnlySessionDb((db) =>
        readRawSessionMessageOrdinalPageFromDb(db, sessionId, after, limit),
    );
}

export function getRawSessionStoredMessageCount(sessionId: string): number {
    const provider = sessionProviders.get(sessionId);
    if (provider?.getStoredMessageCount) return provider.getStoredMessageCount();
    if (provider) return provider.readMessages().length;
    if (!openCodeDbExists()) return 0;
    return withReadOnlySessionDb((db) => countStoredRawSessionMessagesFromDb(db, sessionId));
}

export function readRawSessionMessagePartsById(
    sessionId: string,
    messageId: string,
): RawMessageParts | null {
    const provider = sessionProviders.get(sessionId);
    if (provider?.readMessagePartsById) return provider.readMessagePartsById(messageId);
    if (provider?.readMessageById) return provider.readMessageById(messageId);
    if (provider) {
        return provider.readMessages().find((message) => message.id === messageId) ?? null;
    }
    if (!openCodeDbExists()) return null;
    return withReadOnlySessionDb((db) =>
        readRawSessionMessagePartsByIdFromDb(db, sessionId, messageId),
    );
}

export function readRawSessionMessageOrdinalById(
    sessionId: string,
    messageId: string,
): number | null {
    const provider = sessionProviders.get(sessionId);
    if (provider?.readMessageOrdinalById) {
        return provider.readMessageOrdinalById(messageId);
    }
    if (provider?.readMessageIdOrdinals) {
        return provider.readMessageIdOrdinals().get(messageId) ?? null;
    }
    if (provider?.readMessageOrdinalPage) {
        let after: RawMessageOrdinalAnchor | null = null;
        let ordinal = 0;
        while (true) {
            const page = provider.readMessageOrdinalPage(after, 500);
            if (page.length === 0) return null;
            for (const entry of page) {
                if (entry.contributesOrdinal) ordinal += 1;
                if (entry.id === messageId) return entry.contributesOrdinal ? ordinal : null;
            }
            const last = page.at(-1);
            if (!last || page.length < 500) return null;
            after = { timeCreated: last.timeCreated, id: last.id };
        }
    }
    if (provider?.readMessageById) {
        return provider.readMessageById(messageId)?.ordinal ?? null;
    }
    if (provider) {
        return provider.readMessages().find((message) => message.id === messageId)?.ordinal ?? null;
    }
    if (!openCodeDbExists()) return null;
    return withReadOnlySessionDb((db) =>
        readRawSessionMessageOrdinalByIdFromDb(db, sessionId, messageId),
    );
}

export function readRawSessionMessageById(sessionId: string, messageId: string): RawMessage | null {
    const provider = sessionProviders.get(sessionId);
    if (provider?.readMessageById) {
        return provider.readMessageById(messageId);
    }
    if (provider) {
        return provider.readMessages().find((message) => message.id === messageId) ?? null;
    }
    if (!openCodeDbExists()) return null;
    return withReadOnlySessionDb((db) => readRawSessionMessageByIdFromDb(db, sessionId, messageId));
}

function readRawSessionMessagesFromSource(sessionId: string): RawMessage[] {
    const provider = sessionProviders.get(sessionId);
    if (provider) return provider.readMessages();
    if (!openCodeDbExists()) return [];
    return withReadOnlySessionDb((db) => readRawSessionMessagesFromDb(db, sessionId));
}

export function getRawSessionMessageCount(sessionId: string): number {
    const provider = sessionProviders.get(sessionId);
    if (provider) {
        if (provider.getMessageCount) return provider.getMessageCount();
        return provider.readMessages().length;
    }
    if (!openCodeDbExists()) return 0;
    return withReadOnlySessionDb((db) => getRawSessionMessageCountFromDb(db, sessionId));
}

/**
 * Tool tags use `messageId = callId`.
 * A `callId` reused outside the compartment can match a visible tool tag.
 * String-only matching can queue drops for live tags.
 *
 * `messageFileKeys` uses session-unique content IDs, while `toolObservations` uses `callId` and `tool_owner_message_id`.
 * `messageFileKeys` can match content IDs as bare strings because those IDs are unique within a session.
 *     is correct.
 * `toolObservations` maps each `callId` to owner message IDs paired in FIFO order.
 * A tool tag is visible only when `toolObservations` contains both its `callId` and `tool_owner_message_id`.
 */
export interface RawSessionTagKeys {
    messageFileKeys: Set<string>;
    toolObservations: Map<string, Set<string>>;
}

export function getRawSessionTagKeysThrough(
    sessionId: string,
    upToMessageIndex: number,
): RawSessionTagKeys {
    const messages = readRawSessionMessages(sessionId);
    const messageFileKeys = new Set<string>();
    const toolObservations = new Map<string, Set<string>>();
    // `unpairedInvocations` pairs invocation owners with results in FIFO order.
    const unpairedInvocations = new Map<string, string[]>();

    for (const message of messages) {
        if (message.ordinal > upToMessageIndex) break;

        for (const [partIndex, part] of message.parts.entries()) {
            if (isTextPart(part)) {
                messageFileKeys.add(`${message.id}:p${partIndex}`);
                continue;
            }
            if (isFilePart(part)) {
                messageFileKeys.add(`${message.id}:file${partIndex}`);
                continue;
            }

            const obs = extractToolCallObservation(part);
            if (!obs) continue;

            // The invocation owner is the assistant message that contains the invocation part.
            let ownerMsgId: string;
            if (obs.kind === "invocation") {
                ownerMsgId = message.id;
                const queue = unpairedInvocations.get(obs.callId) ?? [];
                queue.push(message.id);
                unpairedInvocations.set(obs.callId, queue);
            } else {
                const queue = unpairedInvocations.get(obs.callId);
                if (queue && queue.length > 0) {
                    const popped = queue.shift();
                    if (queue.length === 0) unpairedInvocations.delete(obs.callId);
                    ownerMsgId = popped ?? message.id;
                } else {
                    // The fallback uses the result message ID when no queued invocation is available, including when the invocation is outside the visible range.
                    ownerMsgId = message.id;
                }
            }
            const owners = toolObservations.get(obs.callId) ?? new Set();
            owners.add(ownerMsgId);
            toolObservations.set(obs.callId, owners);
        }
    }

    return { messageFileKeys, toolObservations };
}

const PROTECTED_TAIL_USER_TURNS = 5;

export function getLegacyProtectedTailStartOrdinal(sessionId: string): number {
    const messages = readRawSessionMessages(sessionId);
    const userOrdinals = messages
        .filter((m) => m.role === "user" && hasMeaningfulUserText(m.parts))
        .map((m) => m.ordinal);
    if (userOrdinals.length < PROTECTED_TAIL_USER_TURNS) {
        return 1;
    }
    return userOrdinals[userOrdinals.length - PROTECTED_TAIL_USER_TURNS];
}

export function getProtectedTailStartOrdinal(sessionId: string): number {
    return getLegacyProtectedTailStartOrdinal(sessionId);
}

export function readSessionChunk(
    sessionId: string,
    tokenBudget: number,
    offset: number = 1,
    eligibleEndOrdinal?: number,
): SessionChunk {
    const messages = readRawSessionMessages(sessionId);
    // `lastOrdinal` must be compared with the absolute message count; using `messages.length` would leave `hasMore` true for tail slices.
    const totalMessageCount = getCachedAbsoluteMessageCount(sessionId) ?? messages.length;
    const startOrdinal = Math.max(1, offset);
    const lines: string[] = [];
    const lineMeta: SessionChunkLine[] = [];
    /**
     * `flushedToolOnlyBlocks` records ranges that are merged into contiguous `toolOnlyRanges` after the loop.
     */
    const flushedToolOnlyBlocks: Array<{ start: number; end: number }> = [];
    let totalTokens = 0;
    let messagesProcessed = 0;
    let lastOrdinal = startOrdinal - 1;
    let highestScannedOrdinal = startOrdinal - 1;
    let lastMessageId = "";
    let firstMessageId = "";
    let currentBlock: ChunkBlock | null = null;
    let pendingNoiseMeta: SessionChunkLine[] = [];
    let commitClusters = 0;
    let lastFlushedRole = "";

    function recordFilteredNoise(meta: SessionChunkLine): void {
        pendingNoiseMeta.push(meta);
        if (!currentBlock) {
            highestScannedOrdinal = Math.max(highestScannedOrdinal, meta.ordinal);
        }
    }

    function flushCurrentBlock(): boolean {
        if (!currentBlock) return true;
        const blockText = formatBlock(currentBlock);
        const blockTokens = estimateBlockTokens(blockText);
        if (totalTokens + blockTokens > tokenBudget && totalTokens > 0) {
            return false;
        }

        if (
            currentBlock.role === "A" &&
            currentBlock.commitHashes.length > 0 &&
            lastFlushedRole !== "A"
        ) {
            commitClusters++;
        }
        lastFlushedRole = currentBlock.role;

        if (!firstMessageId) firstMessageId = currentBlock.meta[0]?.messageId ?? "";
        lastOrdinal =
            currentBlock.meta[currentBlock.meta.length - 1]?.ordinal ?? currentBlock.endOrdinal;
        highestScannedOrdinal = Math.max(highestScannedOrdinal, lastOrdinal);
        lastMessageId = currentBlock.meta[currentBlock.meta.length - 1]?.messageId ?? "";
        messagesProcessed += currentBlock.meta.length;
        lines.push(blockText);
        lineMeta.push(...currentBlock.meta);
        totalTokens += blockTokens;

        // `toolOnlyRanges` lets the validator absorb gaps of any size caused by skipped tool-only noise.
        if (currentBlock.isToolOnly) {
            flushedToolOnlyBlocks.push({
                start: currentBlock.startOrdinal,
                end: currentBlock.endOrdinal,
            });
        }

        currentBlock = null;
        return true;
    }

    for (const msg of messages) {
        if (eligibleEndOrdinal !== undefined && msg.ordinal >= eligibleEndOrdinal) break;
        if (msg.ordinal < startOrdinal) continue;

        const meta = { ordinal: msg.ordinal, messageId: msg.id };

        // `user` messages without meaningful text are skipped unless `extractToolCallSummaries` finds tool-result descriptions.
        if (msg.role === "user" && !hasMeaningfulUserText(msg.parts)) {
            const tcSummaries = extractToolCallSummaries(msg.parts);
            if (tcSummaries.length === 0) {
                recordFilteredNoise(meta);
                continue;
            }
            const tcText = tcSummaries.join(" / ");
            if (currentBlock && currentBlock.role === "A") {
                currentBlock.endOrdinal = msg.ordinal;
                currentBlock.parts.push(tcText);
                currentBlock.meta.push(...pendingNoiseMeta, meta);
                // `TC-only` content merged into an existing `"A"` block does not change that block's `isToolOnly` status.
                pendingNoiseMeta = [];
            } else {
                if (!flushCurrentBlock()) break;
                currentBlock = {
                    role: "A",
                    startOrdinal: pendingNoiseMeta[0]?.ordinal ?? msg.ordinal,
                    endOrdinal: msg.ordinal,
                    parts: [tcText],
                    meta: [...pendingNoiseMeta, meta],
                    commitHashes: [],
                    isToolOnly: true,
                };
                pendingNoiseMeta = [];
            }
            continue;
        }

        const role = compactRole(msg.role);
        const textParts = extractTexts(msg.parts)
            .map((t) => (msg.role === "user" ? cleanUserText(t) : t))
            .map(normalizeText)
            .filter((value) => value.length > 0);

        const toolSummaries = textParts.length === 0 ? extractToolCallSummaries(msg.parts) : [];
        const allParts = [...textParts, ...toolSummaries];

        const compacted = compactTextForSummary(allParts.join(" / "), msg.role);
        const text = compacted.text;

        if (!text) {
            recordFilteredNoise(meta);
            continue;
        }

        // Narrative is present iff this message contributed at least one real text part.
        const msgHasNarrative = textParts.length > 0;

        if (currentBlock && currentBlock.role === role) {
            currentBlock.endOrdinal = msg.ordinal;
            currentBlock.parts.push(text);
            currentBlock.meta.push(...pendingNoiseMeta, meta);
            currentBlock.commitHashes = mergeCommitHashes(
                currentBlock.commitHashes,
                compacted.commitHashes,
            );
            if (msgHasNarrative) currentBlock.isToolOnly = false;
            pendingNoiseMeta = [];
            continue;
        }

        if (!flushCurrentBlock()) break;

        currentBlock = {
            role,
            startOrdinal: pendingNoiseMeta[0]?.ordinal ?? msg.ordinal,
            endOrdinal: msg.ordinal,
            parts: [text],
            meta: [...pendingNoiseMeta, meta],
            commitHashes: [...compacted.commitHashes],
            isToolOnly: !msgHasNarrative,
        };
        pendingNoiseMeta = [];
    }

    if (flushCurrentBlock() && pendingNoiseMeta.length > 0) {
        highestScannedOrdinal = Math.max(
            highestScannedOrdinal,
            pendingNoiseMeta[pendingNoiseMeta.length - 1]?.ordinal ?? highestScannedOrdinal,
        );
    }

    // `toolOnlyRanges` represents maximal contiguous tool-only ordinal ranges.
    const toolOnlyRanges: Array<{ start: number; end: number }> = [];
    for (const range of flushedToolOnlyBlocks) {
        const last = toolOnlyRanges[toolOnlyRanges.length - 1];
        if (last && range.start === last.end + 1) {
            last.end = range.end;
        } else {
            toolOnlyRanges.push({ start: range.start, end: range.end });
        }
    }

    const completedToolArcs = buildToolArcs(messages).flatMap((arc) =>
        arc.resOrdinal === null ? [] : [{ start: arc.invOrdinal, end: arc.resOrdinal }],
    );

    return {
        startIndex: startOrdinal,
        endIndex: lastOrdinal,
        startMessageId: firstMessageId,
        endMessageId: lastMessageId,
        messageCount: messagesProcessed,
        tokenEstimate: totalTokens,
        hasMore:
            Math.max(lastOrdinal, highestScannedOrdinal) <
            (eligibleEndOrdinal !== undefined
                ? Math.min(eligibleEndOrdinal - 1, totalMessageCount)
                : totalMessageCount),
        text: lines.join("\n"),
        lines: lineMeta,
        commitClusterCount: commitClusters,
        toolOnlyRanges,
        completedToolArcs,
    };
}

export function getRawSessionMessageIdsThrough(sessionId: string, endOrdinal: number): string[] {
    if (endOrdinal < 1) return [];
    return readRawSessionMessages(sessionId)
        .filter((message) => message.ordinal <= endOrdinal)
        .map((message) => message.id);
}
