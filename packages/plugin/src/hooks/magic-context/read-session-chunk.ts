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
 * `readSessionChunk` re-tokenizes the TC-chunked eligible tail on every
 * compartment-trigger pass (every `message.updated`). The eligible window is
 * anchored at `lastCompartmentEnd + 1` and built forward, so every block BEHIND
 * the growing tail produces a byte-identical `formatBlock` string pass after
 * pass — re-running the BPE tokenizer on them is pure waste (≈100ms on a large
 * tool-heavy session). This memo is CONTENT-ADDRESSED on the exact block text,
 * so the token count is identical to a fresh `estimateTokens` call (no
 * semantic/threshold change) — only NEW or changed blocks (the tail edge) reach
 * the tokenizer. The cached value cannot substitute the per-tag token store:
 * that store counts FULL content, this counts the TC-chunked form (tool outputs
 * collapsed to one-line summaries), a deliberately different quantity.
 *
 * Bounded LRU so it can't grow without limit across sessions; full-string keys
 * (no hashing) keep it exact with zero collision risk. A budget-capped chunk is
 * a few dozen blocks, so a few active sessions sit far under the cap.
 */
const BLOCK_TOKEN_MEMO_MAX = 2048;
const blockTokenMemo = new Map<string, number>();
function estimateBlockTokens(blockText: string): number {
    const cached = blockTokenMemo.get(blockText);
    if (cached !== undefined) {
        // Refresh recency (Map preserves insertion order → re-insert = most-recent).
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
// Parallel to activeRawMessageCache, lifecycle-bound to the same scope. Holds the
// ABSOLUTE session message count when the cached array is a TAIL-ONLY slice (so
// `.length` would undercount). Consumers that need the true total read it via
// getCachedAbsoluteMessageCount; null means "no tail slice active → use the
// array length".
let activeAbsoluteCountCache: Map<string, number> | null = null;

/**
 * Per-session source override for raw message reading.
 *
 * The default implementation of `readRawSessionMessages(sessionId)` reads
 * from OpenCode's session DB via `withReadOnlySessionDb`. Other harnesses
 * (e.g. Pi) provide their session data through a different surface
 * (`pi.sessionManager.getBranch()`), so they register a per-session
 * provider here BEFORE invoking any code path that calls the shared
 * `readRawSessionMessages` / `getRawSessionMessageCount` /
 * `getProtectedTailStartOrdinal` / `readSessionChunk` helpers.
 *
 * The registry is lookup-by-sessionId: a registered provider takes
 * precedence over the OpenCode-DB default. Sessions never registered
 * here continue to read from OpenCode's DB (existing behavior).
 *
 * Lifecycle: providers should be registered for the duration of one
 * historian/trigger evaluation and unregistered afterward to avoid
 * leaking session state across unrelated plugin instances. The
 * `withSessionMessageProvider` helper enforces this by wrapping a
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
    /** Optional fast count path; falls back to readMessages().length. */
    getMessageCount?: () => number;
    /** Stored row count including compaction summaries, used for ordinal drift detection. */
    getStoredMessageCount?: () => number;
}

const sessionProviders = new Map<string, RawMessageProvider>();

/**
 * Register a per-session source for raw message reading. Returns an
 * unregister function. Pass-through harnesses (OpenCode) never call
 * this; only Pi/future harnesses install themselves before triggering
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
 * Run `fn` with a temporary per-session provider override. Cleans up
 * on return regardless of throw — preferred over manual
 * `setRawMessageProvider` / `cleanup()` pairs.
 *
 * ASYNC-SAFE: if `fn` returns a promise, cleanup is deferred until that promise
 * settles, so the provider stays registered for the WHOLE async scope. A bare
 * synchronous `finally` would unregister at `fn`'s FIRST `await` (the function
 * returns a pending promise immediately), leaving later awaited reads —
 * e.g. Pi's post-commit `queueDropsForCompartmentalizedMessages` — with no
 * provider, so they fall through to OpenCode's session DB. For a Pi session
 * that DB is the wrong source (empty), and on a Pi-only install it does not
 * exist at all, throwing `unable to open database file`.
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

/** Strip system-reminder blocks and OMO markers from user text for chunk compaction. */
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
    /** Number of distinct commit clusters — assistant blocks with commits separated by meaningful user turns */
    commitClusterCount: number;
    /**
     * Contiguous ranges of raw message ordinals whose visible chunk content was
     * tool-only (TC: lines, no narrative text). Historian frequently skips such
     * ranges entirely — that's safe, so validation absorbs gaps that fall fully
     * within these ranges regardless of size. Gaps outside these ranges still
     * fail validation and trigger a repair retry.
     */
    toolOnlyRanges: Array<{ start: number; end: number }>;
    /** Completed call/result ranges visible in the raw snapshot, including results past this chunk. */
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
 * Prime the active raw-message cache with a TAIL-ONLY read (only messages
 * at/after the last compartment boundary), so subsequent
 * `readRawSessionMessages(sessionId)` calls in this scope reuse it instead of
 * reading the whole session.
 *
 * This is the O(tail) path: the compartment-trigger boundary resolution is
 * offset-forward only (its candidate / suffix / range / head-cap / chunk-scan
 * reads never cross below `baseOrdinal+1`), and the absolute message count it
 * needs is recovered from the tail reader (`baseOrdinal + tail`), NOT from
 * counting pre-boundary rows. On a months-long session the full read grows
 * O(session); this stays flat at the tail size.
 *
 * The cached array carries ABSOLUTE ordinals (`baseOrdinal+1 …`) so every
 * downstream absolute-ordinal computation matches the full read; the true total
 * is stashed in the parallel absolute-count cache for `.length`-style consumers.
 *
 * No-op (returns false) when a provider is registered (Pi: in-memory branch read
 * is already cheap and authoritative), no OpenCode DB exists, the cache is
 * already populated, or no usable boundary anchor exists (e.g. no compartments,
 * or the anchor message was deleted) — in which case the caller falls through to
 * the full read, which is correct (everything is eligible / nothing to skip).
 */
export function primeTailRawMessageCache(args: {
    sessionId: string;
    lastCompartmentEnd: number;
    anchorMessageId: string | null;
}): boolean {
    const { sessionId, lastCompartmentEnd, anchorMessageId } = args;
    if (!activeRawMessageCache) return false;
    if (activeRawMessageCache.has(sessionId)) return false;
    // A registered provider (Pi) is the authoritative in-memory source and is
    // already cheap; never shadow it with a DB read.
    if (sessionProviders.has(sessionId)) return false;
    if (!openCodeDbExists()) return false;
    // Need a real boundary + anchor to read the tail; otherwise fall through to
    // the full read (correct for the no-compartment / #132 case).
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
 * Absolute session message count for the active scope. Returns the tail-prime's
 * stashed absolute count when a tail slice is cached; otherwise null, signalling
 * callers to use `readRawSessionMessages(sessionId).length` (whole-session
 * array) as before.
 */
export function getCachedAbsoluteMessageCount(sessionId: string): number | null {
    return activeAbsoluteCountCache?.get(sessionId) ?? null;
}

/**
 * Prime the active raw-message cache with an IN-MEMORY tail built from the
 * transform's `args.messages` — no opencode.db read at all. This is the hot-path
 * goal: the transform already receives the post-marker tail (the eligible
 * window) as parsed objects, so the boundary resolver can consume it directly.
 *
 * The caller supplies the already-converted absolute-ordinal `RawMessage[]` (via
 * `buildInMemoryTailRawMessages`) plus its absolute count. Same scope/lifecycle
 * rules as the other prime helpers: only inside a `withRawSessionMessageCache`
 * scope, never shadows a registered provider (Pi), and is a no-op if the cache is
 * already populated for the session.
 *
 * Returns true when it primed the cache.
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
    // No provider: fall back to OpenCode's session DB — but only if it exists.
    // A Pi-only install has no opencode.db, and a Pi transform whose provider
    // was unregistered out-of-band (e.g. session cleared while an async
    // historian is mid-flight) must not crash the post-commit drop-queue with
    // `unable to open database file`. No source → no raw messages.
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
 * Set of raw-session keys observed in the visible window. Pre-v3.3.1
 * this collapsed everything (text, file, tool) into one bare-string Set.
 * That was the bug Finding D in the plan: tool tags share `messageId =
 * callId`, so a callId reused outside the compartment would match a
 * tag inside the compartment by string equality alone, queuing drops
 * for tags that should have stayed live.
 *
 * Layer C splits the shape into:
 *   - `messageFileKeys`: bare contentIds (`<msgId>:p<n>` / `<msgId>:fileN`).
 *     These are globally unique within a session, so bare-string match
 *     is correct.
 *   - `toolObservations`: per-callId set of `ownerMsgId` values derived
 *     by FIFO pairing, mirroring `tag-messages.ts`. A tool tag is "in
 *     the visible window" iff its callId AND `tool_owner_message_id`
 *     both appear here.
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
    // FIFO queue per callId of unpaired invocations — same logic as
    // tag-messages.ts so the composite keys we produce here match what
    // the tagger persisted.
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

            // FIFO pairing: invocation parts push their owner; result
            // parts pop. The owner identifies which assistant message
            // hosts the invocation, which is what `tag-messages.ts`
            // uses for `tool_owner_message_id`.
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
                    // Result-only window inside this scan: invocation
                    // wasn't observed in the visible range. Use the
                    // result's own message id as a best-effort owner.
                    // The drop queue compares against persisted
                    // `tool_owner_message_id` and falls back to bare-
                    // callId match for legacy NULL-owner rows; this
                    // best-effort ownerMsgId is mainly informational.
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
    // When a tail-only slice is primed, `messages.length` is just the slice
    // size while ordinals are ABSOLUTE — comparing an absolute `lastOrdinal`
    // against the slice length would wrongly report hasMore=true forever
    // (historian re-fires on an already-finished session). Use the absolute
    // session count whenever the prime recorded one.
    const totalMessageCount = getCachedAbsoluteMessageCount(sessionId) ?? messages.length;
    const startOrdinal = Math.max(1, offset);
    const lines: string[] = [];
    const lineMeta: SessionChunkLine[] = [];
    /**
     * Tool-only block ranges captured at flush time. After the main loop finishes
     * we merge adjacent ranges into contiguous `toolOnlyRanges` for the validator.
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

        // Count commit clusters: an A block with commits after a non-A block (or first block) is a new cluster
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

        // Record the flushed block's range if it was pure tool-only content.
        // Validator uses these ranges to absorb gaps of any size where historian
        // legitimately skipped tool-only noise.
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

        // Skip user messages that are pure system notifications (background task
        // completions, internal initiator markers, system directives). These carry
        // zero signal for compartment summaries — unless they contain tool results
        // with extractable descriptions.
        if (msg.role === "user" && !hasMeaningfulUserText(msg.parts)) {
            const tcSummaries = extractToolCallSummaries(msg.parts);
            if (tcSummaries.length === 0) {
                recordFilteredNoise(meta);
                continue;
            }
            // Tool-result-only user messages: merge TC summaries into the
            // preceding assistant block (same "A" role since tool results follow
            // assistant tool-use messages in the compacted flow).
            const tcText = tcSummaries.join(" / ");
            if (currentBlock && currentBlock.role === "A") {
                currentBlock.endOrdinal = msg.ordinal;
                currentBlock.parts.push(tcText);
                currentBlock.meta.push(...pendingNoiseMeta, meta);
                // Do NOT flip isToolOnly here — TC-only content merging into an
                // existing A block keeps that block's narrative/tool-only status.
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
                    // Pure TC-only block — no narrative from text parts.
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

        // For messages with no text content, extract tool-call descriptions as
        // lightweight summaries so historian sees what actions were taken.
        const toolSummaries = textParts.length === 0 ? extractToolCallSummaries(msg.parts) : [];
        const allParts = [...textParts, ...toolSummaries];

        const compacted = compactTextForSummary(allParts.join(" / "), msg.role);
        const text = compacted.text;

        if (!text) {
            recordFilteredNoise(meta);
            continue;
        }

        // Narrative is present iff this message contributed at least one real text part.
        // Tool summaries alone count as tool-only. User-role messages here always carry
        // meaningful text (the no-text user branch returned above).
        const msgHasNarrative = textParts.length > 0;

        if (currentBlock && currentBlock.role === role) {
            currentBlock.endOrdinal = msg.ordinal;
            currentBlock.parts.push(text);
            currentBlock.meta.push(...pendingNoiseMeta, meta);
            currentBlock.commitHashes = mergeCommitHashes(
                currentBlock.commitHashes,
                compacted.commitHashes,
            );
            // Once any message in the merged block contributes narrative, the block is
            // no longer tool-only.
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

    // Merge adjacent tool-only block ranges into contiguous ranges. Adjacent
    // means `next.start === prev.end + 1` — a pure tool chain spread across
    // multiple successive flushed blocks becomes one merged range so validation
    // can absorb the full gap in a single heal check.
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
