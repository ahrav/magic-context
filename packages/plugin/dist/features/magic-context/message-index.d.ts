import type { RawMessage } from "../../hooks/magic-context/read-session-raw";
import type { Database } from "../../shared/sqlite";
export interface MessageHistoryOrphanSweepResult {
    status: "swept" | "cooldown" | "source_unavailable";
    scanned: number;
    deleted: number;
    cursor: string;
}
export interface MessageHistoryOrphanSweepOptions {
    batchSize?: number;
    now?: number;
    safetyAgeMs?: number;
    cooldownMs?: number;
    unavailableReprobeMs?: number;
}
export declare const MESSAGE_HISTORY_ORPHAN_SWEEP_BATCH_SIZE = 200;
export declare const MESSAGE_HISTORY_ORPHAN_SAFETY_AGE_MS: number;
export declare const MESSAGE_HISTORY_ORPHAN_SWEEP_COOLDOWN_MS: number;
export declare const MESSAGE_HISTORY_ORPHAN_UNAVAILABLE_REPROBE_MS: number;
export declare function getMessageIndexSourceIdentity(message: RawMessage): string;
export declare function isMessageIndexSourceCurrent(db: Database, sessionId: string, message: RawMessage): boolean;
export declare function getLastIndexedOrdinal(db: Database, sessionId: string): number;
/**
 * Cheap IDF-lite denominator derived from the session's primary-keyed index
 * tracker. Message ordinals are contiguous through the watermark, so the small
 * approximation error from non-indexable rows is preferable to scanning the
 * global FTS row store for an exact count.
 */
export declare function getIndexedMessageCorpusSize(db: Database, sessionId: string, maxOrdinal: number | null): number;
export declare function getDirtyIndexFloor(db: Database, sessionId: string): number | null;
/**
 * Persist the earliest ordinal that an incremental write could leave missing.
 * Callers set this before the FTS transaction so a crash or write failure leaves
 * a durable reconciliation floor instead of an uncovered watermark.
 */
export declare function markMessageIndexDirty(db: Database, sessionId: string, floorOrdinal: number): void;
export declare function getMessageIndexReconciliationStartOrdinal(db: Database, sessionId: string): number;
export declare function isMessageIndexReconciledThrough(db: Database, sessionId: string, finalWatermark: number): boolean;
export declare function deleteIndexedMessage(db: Database, sessionId: string, messageId: string): number;
export declare function clearIndexedMessages(db: Database, sessionId: string): void;
export declare function getIndexableContent(role: string, parts: unknown[]): string;
export declare function indexSingleMessage(db: Database, sessionId: string, message: RawMessage): boolean;
export declare function indexMessagesAfterOrdinal(db: Database, sessionId: string, messages: RawMessage[], _lastIndexedOrdinal: number, finalWatermark?: number): number;
export declare function ensureMessagesIndexed(db: Database, sessionId: string, readMessages: (sessionId: string) => RawMessage[]): void;
/**
 * Delete old OpenCode FTS sessions that no longer exist in OpenCode's
 * authoritative session table. One bounded keyset page is processed per call;
 * the cursor survives restarts and only resets after a complete pass.
 */
export declare function sweepOrphanedOpenCodeMessageIndexes(db: Database, openReadableOpenCodeDb: () => Database | null, options?: MessageHistoryOrphanSweepOptions): MessageHistoryOrphanSweepResult;
//# sourceMappingURL=message-index.d.ts.map