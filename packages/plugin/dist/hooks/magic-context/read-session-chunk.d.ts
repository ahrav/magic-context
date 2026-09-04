import { type SessionChunkLine } from "./read-session-formatting";
import { type RawMessage, type RawMessageOrdinalAnchor, type RawMessageOrdinalEntry, type RawMessageParts } from "./read-session-raw";
export { extractTexts, hasMeaningfulUserText } from "./read-session-formatting";
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
    readMessageOrdinalPage?: (after: RawMessageOrdinalAnchor | null, limit: number) => RawMessageOrdinalEntry[];
    /** Optional fast count path; falls back to readMessages().length. */
    getMessageCount?: () => number;
    /** Stored row count including compaction summaries, used for ordinal drift detection. */
    getStoredMessageCount?: () => number;
}
/**
 * Register a per-session source for raw message reading. Returns an
 * unregister function. Pass-through harnesses (OpenCode) never call
 * this; only Pi/future harnesses install themselves before triggering
 * historian.
 */
export declare function setRawMessageProvider(sessionId: string, provider: RawMessageProvider): () => void;
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
export declare function withRawMessageProvider<T>(sessionId: string, provider: RawMessageProvider, fn: () => T): T;
/** Strip system-reminder blocks and OMO markers from user text for chunk compaction. */
export declare function cleanUserText(text: string): string;
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
    toolOnlyRanges: Array<{
        start: number;
        end: number;
    }>;
    /** Completed call/result ranges visible in the raw snapshot, including results past this chunk. */
    completedToolArcs: Array<{
        start: number;
        end: number;
    }>;
}
export declare function withRawSessionMessageCache<T>(fn: () => T): T;
export declare function readRawSessionMessages(sessionId: string): RawMessage[];
export declare namespace readRawSessionMessages {
    var readPage: typeof readRawSessionMessagePage;
    var getCount: typeof getRawSessionMessageOrdinalCount;
}
export declare function readRawSessionMessagePage(sessionId: string, afterOrdinal: number, limit: number, finalWatermark: number): RawMessage[];
export declare function getRawSessionMessageOrdinalCount(sessionId: string): number;
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
export declare function primeTailRawMessageCache(args: {
    sessionId: string;
    lastCompartmentEnd: number;
    anchorMessageId: string | null;
}): boolean;
/**
 * Absolute session message count for the active scope. Returns the tail-prime's
 * stashed absolute count when a tail slice is cached; otherwise null, signalling
 * callers to use `readRawSessionMessages(sessionId).length` (whole-session
 * array) as before.
 */
export declare function getCachedAbsoluteMessageCount(sessionId: string): number | null;
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
export declare function primeInMemoryTailRawMessageCache(args: {
    sessionId: string;
    messages: RawMessage[];
    absoluteMessageCount: number;
}): boolean;
export declare function readRawSessionMessageOrdinalPage(sessionId: string, after: RawMessageOrdinalAnchor | null, limit: number): RawMessageOrdinalEntry[];
export declare function getRawSessionStoredMessageCount(sessionId: string): number;
export declare function readRawSessionMessageIdOrdinals(sessionId: string): Map<string, number>;
export declare function readRawSessionMessagePartsById(sessionId: string, messageId: string): RawMessageParts | null;
export declare function readRawSessionMessageOrdinalById(sessionId: string, messageId: string): number | null;
export declare function readRawSessionMessageById(sessionId: string, messageId: string): RawMessage | null;
export declare function getRawSessionMessageCount(sessionId: string): number;
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
export declare function getRawSessionTagKeysThrough(sessionId: string, upToMessageIndex: number): RawSessionTagKeys;
export declare function getLegacyProtectedTailStartOrdinal(sessionId: string): number;
export declare function getProtectedTailStartOrdinal(sessionId: string): number;
export declare function readSessionChunk(sessionId: string, tokenBudget: number, offset?: number, eligibleEndOrdinal?: number): SessionChunk;
export declare function getRawSessionMessageIdsThrough(sessionId: string, endOrdinal: number): string[];
//# sourceMappingURL=read-session-chunk.d.ts.map