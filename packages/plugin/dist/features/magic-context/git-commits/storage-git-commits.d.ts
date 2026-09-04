/**
 * SQLite storage layer for indexed git commits.
 *
 * Separate from the memory embedding table because:
 *   - Identity is the SHA, not a memory row id
 *   - Lifecycle is managed by git, not by Dreamer review flow
 *   - FTS is also separate so commit queries never pollute memory BM25 ranks
 *
 * Eviction: when `max_commits` is exceeded for a project, we delete the oldest
 * commits by `committed_at ASC` (not by indexed_at — indexed_at can reorder
 * when we catch up after a long absence). ON DELETE CASCADE removes matching
 * embedding rows and FTS triggers remove matching FTS rows, so a single DELETE
 * cleans all three tables.
 */
import type { Database } from "../../../shared/sqlite";
import type { GitCommit } from "./git-log-reader";
export interface StoredGitCommit extends GitCommit {
    projectPath: string;
    indexedAtMs: number;
}
/** Batch upsert in a single transaction. Returns the count actually inserted
 *  or updated (skipped unchanged rows don't count). */
export declare function upsertCommits(db: Database, projectPath: string, commits: GitCommit[]): {
    inserted: number;
    updated: number;
};
/** Return the total count of indexed commits for a project. */
export declare function getCommitCount(db: Database, projectPath: string): number;
/** Return the most recent committed_at (ms) for this project, or null. */
export declare function getLatestIndexedCommitTimeMs(db: Database, projectPath: string): number | null;
/** Keep at most `maxCommits` rows for this project, evicting oldest overflow.
 *  Returns number of rows evicted. */
export declare function enforceProjectCap(db: Database, projectPath: string, maxCommits: number): number;
//# sourceMappingURL=storage-git-commits.d.ts.map