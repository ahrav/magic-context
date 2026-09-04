/**
 * Transaction-local legacy `memories` projection primitives for the v84
 * memory/claims kernel (KTD1). Exact SQL over the migrated v84 shape (every
 * column exists at v84), no transaction ownership, no cache invalidation, no
 * claim knowledge. The kernel imports this leaf plus the transaction-local
 * claim primitives; `storage-memory.ts` and harness adapters depend on the
 * kernel, never the reverse — so this module must not import
 * `storage-memory.ts`.
 *
 * Type-only imports keep this module loadable by the Node SQLite smoke
 * script, whose loader cannot resolve extensionless runtime imports.
 *
 * Every writer here assumes the caller already holds a write transaction with
 * the claims-write capability enabled; the v84 guards reject these statements
 * otherwise.
 */
import type { Database } from "../../../shared/sqlite";
export interface MemoryProjectionRow {
    id: number;
    project_path: string;
    category: string;
    content: string;
    normalized_hash: string;
    importance: number | null;
    scope: string;
    shareable: number;
    source_session_id: string | null;
    source_type: string;
    first_seen_at: number;
    created_at: number;
    updated_at: number;
    status: string;
    expires_at: number | null;
    verification_status: string;
    verified_at: number | null;
    superseded_by_memory_id: number | null;
    merged_from: string | null;
    metadata_json: string | null;
}
export interface MemoryProjectionInsert {
    projectPath: string;
    category: string;
    content: string;
    normalizedHash: string;
    importance?: number | null;
    sourceSessionId?: string | null;
    sourceType?: string;
    expiresAt?: number | null;
    metadataJson?: string | null;
    nowMs?: number;
}
/** Safe-number change count for Bun/Node `number | bigint` parity. */
export declare function toSafeChangeCount(result: unknown): number;
export declare function readMemoryProjectionRow(db: Database, id: number): MemoryProjectionRow | null;
/**
 * Insert one projection row with the legacy defaults. The v80
 * `memories_stats_ai` trigger creates the stats baseline and the FTS trigger
 * indexes the content, exactly as the legacy writer relied on.
 */
export declare function insertMemoryProjectionRow(db: Database, input: MemoryProjectionInsert): number;
/**
 * Semantic content rewrite plus the derived-state invalidation the legacy
 * writer performs: the classify `shareable` verdict and `classified_at`
 * marker were scored against the OLD content, the mural cue was compressed
 * from it, and the embedding vector encodes it — all reset so nothing stale
 * survives the new content. Verification state is deliberately NOT reset
 * (locked by the migrated-v82 characterization tests).
 */
export declare function updateMemoryProjectionContent(db: Database, id: number, content: string, normalizedHash: string, nowMs?: number): void;
export interface MemoryProjectionClassificationUpdate {
    importance?: number;
    scope?: string;
    shareable?: number;
}
/** Classification fields plus the classified_at run-gate stamp. */
export declare function updateMemoryProjectionClassification(db: Database, id: number, update: MemoryProjectionClassificationUpdate, nowMs?: number): void;
/** Status transition; metadataJson replaces the stored metadata when given. */
export declare function updateMemoryProjectionStatus(db: Database, id: number, status: string, metadataJson: string | null | undefined, nowMs?: number): void;
export declare function updateMemoryProjectionVerification(db: Database, id: number, verificationStatus: string, nowMs?: number): void;
export declare function setMemoryProjectionSuperseded(db: Database, id: number, supersededByMemoryId: number, nowMs?: number): void;
/**
 * Merge-canonical base update. Counters live in `memory_stats`; a base row
 * without a stats row breaks the one-row-per-memory invariant and must abort
 * the caller's transaction rather than committing a merged marker alone.
 */
export declare function updateMemoryProjectionMerge(db: Database, id: number, mergedFrom: string, status: string, seenCount: number, retrievalCount: number, nowMs?: number): {
    baseChanges: number;
    statsChanges: number;
};
/**
 * Remove the projection row and its embedding. `memory_stats` and
 * `memory_verifications` FK-cascade off the base row.
 */
export declare function deleteMemoryProjectionRow(db: Database, id: number): void;
/**
 * Replace one memory's `memory_verifications` rows. `verifiedAt = 0` records
 * a mapping (files known, not content-verified); a positive `verifiedAt`
 * records a content verification. Files must already be normalized; an empty
 * list writes the `""` no-file sentinel row.
 */
export declare function replaceMemoryProjectionVerificationFiles(db: Database, memoryId: number, files: readonly string[], verifiedAt: number, mappedAt: number): number;
//# sourceMappingURL=storage-memory-projection.d.ts.map