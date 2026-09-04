/**
 * Commit indexer — bridges `git log` output into the plugin's storage.
 *
 * Public entry points:
 *   - indexCommitsForProject() — sweep HEAD, upsert, evict to cap, embed backlog
 *   - embedUnembeddedCommits() — drain embedding backlog only (called from dream timer)
 *
 * Concurrency: both functions are guarded by a singleton in-progress flag
 * scoped to (projectPath, operation) so the dream timer can't spawn parallel
 * sweeps of the same project.
 */
import type { Database } from "../../../shared/sqlite";
export interface IndexCommitsOptions {
    sinceDays: number;
    maxCommits: number;
    /** If true, skip the embed step after indexing. Useful when the caller
     *  plans to embed in a separate scheduled pass. Default false. */
    skipEmbed?: boolean;
}
export interface IndexCommitsResult {
    scanned: number;
    inserted: number;
    updated: number;
    evicted: number;
    embedded: number;
    /**
     * Set when `git log` failed structurally (directory is not a repo, or the
     * repo has no commits yet). The sweep uses this to park the project on a
     * long re-probe cooldown instead of retrying every tick.
     */
    nonIndexable: boolean;
}
/**
 * Sweep commits from `directory` (must be a git repo), upsert them for
 * `projectPath`, enforce max-commits cap, and optionally embed the backlog.
 *
 * Safe to call repeatedly — existing commits whose message hasn't changed
 * are skipped cheaply (SQLite WHERE clause in the UPSERT).
 */
export declare function indexCommitsForProject(db: Database, projectPath: string, directory: string, options: IndexCommitsOptions): Promise<IndexCommitsResult>;
/**
 * Embed unembedded commits for a project, draining until exhausted or hitting
 * the wall-clock / per-sweep limits. Mirrors the memory embedding sweep
 * behavior so provider switches refresh the commit index as quickly as memories.
 */
export declare function embedUnembeddedCommits(db: Database, projectPath: string): Promise<number>;
/** Test-only: reset in-progress guards. */
export declare function _resetIndexerGuards(): void;
//# sourceMappingURL=indexer.d.ts.map