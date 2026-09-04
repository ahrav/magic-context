import type { Database } from "../../shared/sqlite";
export interface RawMessageParts {
    id: string;
    role: string;
    parts: unknown[];
    createdAt?: number | null;
    version?: string | number | null;
}
export interface RawMessage extends RawMessageParts {
    ordinal: number;
}
export interface RawMessageOrdinalAnchor {
    timeCreated: number;
    id: string;
}
export interface RawMessageOrdinalEntry extends RawMessageOrdinalAnchor {
    contributesOrdinal: boolean;
    hasValidInfo: boolean;
}
export declare function isRawCompactionSummaryInfo(info: unknown): boolean;
export declare function readRawSessionMessagesFromDb(db: Database, sessionId: string): RawMessage[];
/**
 * Read one bounded page from the canonical raw-message ordinal space. Message
 * and part JSON parsing is limited to the requested page so background FTS work
 * cannot monopolize the event loop by hydrating an entire long session.
 */
export declare function readRawSessionMessagePageFromDb(db: Database, sessionId: string, afterOrdinal: number, limit: number, finalWatermark?: number): RawMessage[];
export declare function countRawSessionMessageOrdinalsFromDb(db: Database, sessionId: string): number;
/**
 * Read the canonical raw-message ordinal space without loading or parsing part rows.
 * Keep the ordering, summary predicate, and malformed-message behavior identical to
 * `readRawSessionMessagesFromDb`; consumers compare these ordinals across passes.
 */
export declare function readRawSessionMessageIdOrdinalsFromDb(db: Database, sessionId: string): Map<string, number>;
/** Read a keyset page used to incrementally maintain shadow message ordinals. */
export declare function readRawSessionMessageOrdinalPageFromDb(db: Database, sessionId: string, after: RawMessageOrdinalAnchor | null, limit: number): RawMessageOrdinalEntry[];
/** Count stored rows without inspecting message JSON, allowing the session-id index to answer it. */
export declare function countStoredRawSessionMessagesFromDb(db: Database, sessionId: string): number;
/**
 * Read ONLY the eligible tail — messages at/after the last compartment boundary
 * — assigning them their correct ABSOLUTE ordinals (continuing from
 * `baseOrdinal`), and return the absolute session message count alongside.
 *
 * This is the O(tail) read: it never touches the ~63k pre-boundary rows that the
 * full reader scans just to recover the tail's ordinal base — a number the
 * compaction marker already stores (`end_message` ordinal + `end_message_id`
 * anchor). On a months-long session the full read is O(session) and grows
 * unbounded; this stays flat at the tail size.
 *
 * Anchor semantics: reads rows with `(time_created, id) >= anchor` (INCLUSIVE of
 * the boundary message), in the same sort order as the full reader, filters
 * compaction-summary rows identically, and numbers the kept messages
 * `baseOrdinal, baseOrdinal+1, …`. Including the anchor keeps
 * `messageIdAtOrdinal(baseOrdinal)` real (the full reader has it too) so
 * boundary-edge message ids match.
 *
 * Returns null when the anchor message id isn't found (deleted / legacy
 * compartment without `end_message_id`); the caller then falls back to the full
 * read. `absoluteMessageCount` = `baseOrdinal + (keptTail - 1)` = the exact
 * count the full reader would produce, so every absolute-ordinal consumer lines
 * up.
 */
export declare function readRawSessionTailFromDb(db: Database, sessionId: string, baseOrdinal: number, anchorMessageId: string): {
    messages: RawMessage[];
    absoluteMessageCount: number;
} | null;
/**
 * Minimal structural view of an in-memory transform message, extracted from
 * OpenCode's `MessageLike` by the caller. Kept dependency-free so this module
 * doesn't import the transform/tagging layer.
 */
export interface InMemoryMessageView {
    id: string;
    role: string;
    parts: unknown[];
    /** From the message `info` if present; used to mirror the DB summary filter. */
    summary?: boolean;
    finish?: string;
}
export interface InMemoryTailResult {
    messages: RawMessage[];
    absoluteMessageCount: number;
    /** True when the compaction anchor id was located within the array. */
    anchorFound: boolean;
}
/**
 * Extract the minimal structural view from OpenCode transform messages
 * (`args.messages`, MessageLike-shaped: `{ info, parts }`). Tolerates missing
 * fields — a message without a string id becomes an empty-id view, which
 * `buildInMemoryTailRawMessages` treats as a malformed row (ordinal slot kept,
 * no element), mirroring the DB reader.
 */
export declare function extractInMemoryMessageViews(messages: readonly {
    info?: unknown;
    parts?: unknown;
}[]): InMemoryMessageView[];
/**
 * Build an absolute-ordinal `RawMessage[]` tail from the in-memory transform
 * messages (`args.messages`), mirroring {@link readRawSessionTailFromDb} so the
 * boundary resolver produces an identical result without any opencode.db read.
 *
 * OpenCode hands the transform the post-compaction-marker tail, i.e. the eligible
 * window, already parsed. Ordinals are anchored at the last compartment boundary:
 *
 * - If `anchorMessageId` is found at index k, that message IS the boundary
 *   (ordinal `lastCompartmentEnd`); messages k, k+1, … get ordinals
 *   `lastCompartmentEnd, lastCompartmentEnd+1, …`. Messages before k (compaction
 *   marker lag — already compartmentalized) are dropped, matching the DB tail
 *   which starts AT the anchor.
 * - If the anchor isn't present (it was a summary row OpenCode already filtered,
 *   or marker is ahead), the array is assumed to start at `lastCompartmentEnd+1`
 *   and ordinals run `lastCompartmentEnd+1, …`. `anchorFound=false` flags this so
 *   callers can choose the DB fallback if they don't trust the assumption.
 * - No compartments yet (#132): pass `lastCompartmentEnd=0`,
 *   `anchorMessageId=null` → ordinals from 1 over the whole array.
 *
 * Mirrors the DB reader's contracts: compaction-summary rows
 * (`summary===true && finish==='stop'`) are filtered BEFORE ordinal assignment;
 * a malformed message (no string id) keeps its ordinal slot but yields no element;
 * `absoluteMessageCount` equals what the DB reader would report for the same tail.
 *
 * Returns null when there are no usable messages.
 */
export declare function buildInMemoryTailRawMessages(args: {
    messages: readonly InMemoryMessageView[];
    lastCompartmentEnd: number;
    anchorMessageId: string | null;
}): InMemoryTailResult | null;
export declare function readRawSessionMessagePartsByIdFromDb(db: Database, sessionId: string, messageId: string): RawMessageParts | null;
/**
 * Resolve one message ID in the canonical raw-message ordinal space. Synthetic
 * compaction summaries are excluded so this count matches every module wire
 * ordinal and does not depend on the stored compartment basis.
 */
export declare function readRawSessionMessageOrdinalByIdFromDb(db: Database, sessionId: string, messageId: string): number | null;
export declare function readRawSessionMessageByIdFromDb(db: Database, sessionId: string, messageId: string): RawMessage | null;
//# sourceMappingURL=read-session-raw.d.ts.map