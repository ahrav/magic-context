import type { Database } from "../../../shared/sqlite";
export declare const MEMORY_VERIFICATION_SENTINEL = "";
export interface MemoryVerificationState {
    /** Real repo-root-relative backing files. Excludes the no-file sentinel. */
    files: string[];
    /** True when a `""` no-file sentinel row exists for this memory. */
    hasSentinel: boolean;
    /** Max verified_at across all rows. 0 = mapped (files known) but NOT yet
     *  content-verified (the map-memories backfill records files without checking). */
    verifiedAt: number;
    /** Max mapped_at across all rows — when the file mapping was established. */
    mappedAt: number;
}
/**
 * MAP (map-memories backfill): record WHICH files back a memory (or the no-file
 * sentinel) WITHOUT content-verifying it — `verified_at=0`, `mapped_at=now`. The
 * first verify still sees it as unverified (verified_at=0) and checks the claim.
 */
export declare function recordMemoryMapping(db: Database, memoryId: number, normalizedFiles: readonly string[], now: number): number;
/**
 * VERIFY: replace one memory's side-table rows, marking them content-verified
 * (`verified_at=now`, `mapped_at=now`). Callers updating multiple memories should
 * wrap their batch in one transaction.
 */
export declare function recordMemoryVerifications(db: Database, memoryId: number, normalizedFiles: readonly string[], now: number): number;
/** Memory ids (from the given set) that have NO mapping rows yet — the
 *  map-memories backfill scope. */
export declare function getUnmappedMemoryIds(db: Database, memoryIds: readonly number[]): number[];
export declare function clearMemoryVerifications(db: Database, memoryId: number): void;
export declare function getMemoryVerifications(db: Database, memoryIds: readonly number[]): Map<number, MemoryVerificationState>;
//# sourceMappingURL=storage-memory-verifications.d.ts.map