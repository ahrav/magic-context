import type { Database } from "../../../shared/sqlite";
/**
 * Default candidate decay TTL (30 days). review-user-memories runs daily with a
 * default promotion_threshold of 3, and genuine user traits recur over days-to-
 * weeks, so 30d leaves ample room for a real pattern to accumulate its variants
 * while pruning one-off noise that never recurs. Tune if promotion starves.
 */
export declare const USER_MEMORY_CANDIDATE_TTL_MS: number;
export interface UserMemoryCandidate {
    id: number;
    content: string;
    sessionId: string;
    sourceCompartmentStart: number | null;
    sourceCompartmentEnd: number | null;
    createdAt: number;
}
export interface UserMemorySourceProvenance {
    candidateId: number;
    sessionId: string;
    sourceCompartmentStart: number | null;
    sourceCompartmentEnd: number | null;
}
export interface UserMemory {
    id: number;
    content: string;
    status: "active" | "dismissed";
    promotedAt: number;
    sourceCandidateIds: number[];
    sourceProvenance: UserMemorySourceProvenance[] | null;
    createdAt: number;
    updatedAt: number;
}
export declare function insertUserMemoryCandidates(db: Database, candidates: Array<{
    content: string;
    sessionId: string;
    sourceCompartmentStart?: number;
    sourceCompartmentEnd?: number;
}>): void;
export declare function getUserMemoryCandidates(db: Database): UserMemoryCandidate[];
export declare function deleteUserMemoryCandidates(db: Database, ids: number[]): void;
/** Candidate IDs without a session-project mapping return an empty array. */
export declare function getUserMemoryCandidateProjectIdentities(db: Database, ids: readonly number[]): Map<number, string[]>;
/**
 * Time-based decay: drop candidate observations older than the TTL that never
 * accumulated enough corroborating variants to be promoted. Without this, a
 * one-off observation that never recurs sits in the pool forever (review only
 * consumes candidates when the pool reaches the promotion threshold, so an
 * under-threshold trickle of noise accrues indefinitely). The TTL must comfortably
 * exceed promotion_threshold × the typical recurrence interval of a real trait so
 * decay prunes only noise, never a slow-but-genuine pattern mid-accumulation.
 * Returns rows pruned.
 */
export declare function pruneExpiredUserMemoryCandidates(db: Database, ttlMs: number, now?: number): number;
export declare function insertUserMemory(db: Database, content: string, sourceCandidateIds: number[]): number;
export declare function getActiveUserMemories(db: Database): UserMemory[];
export declare function updateUserMemoryContent(db: Database, id: number, content: string, sourceCandidateIds?: number[]): void;
export declare function dismissUserMemory(db: Database, id: number): void;
//# sourceMappingURL=storage-user-memory.d.ts.map