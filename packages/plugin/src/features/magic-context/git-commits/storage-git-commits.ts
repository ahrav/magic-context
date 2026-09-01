/**
 *
 *   - Identity is the SHA, not a memory row id
 *
 * Eviction: when `max_commits` is exceeded for a project, we delete the oldest
 * `indexed_at` can reorder during catch-up after a long absence, so eviction orders by `committed_at`.
 */

import { log } from "../../../shared/logger";
import type { Database, Statement as PreparedStatement } from "../../../shared/sqlite";
import type { GitCommit } from "./git-log-reader";

export interface StoredGitCommit extends GitCommit {
    projectPath: string;
    indexedAtMs: number;
}

const insertStatements = new WeakMap<Database, PreparedStatement>();
const existingShasStatements = new WeakMap<Database, PreparedStatement>();
const projectCountStatements = new WeakMap<Database, PreparedStatement>();
const evictOverflowStatements = new WeakMap<Database, PreparedStatement>();
const latestCommitTimeStatements = new WeakMap<Database, PreparedStatement>();

function getInsertStatement(db: Database): PreparedStatement {
    let stmt = insertStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `INSERT INTO git_commits (sha, project_path, short_sha, message, author, committed_at, indexed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(sha) DO UPDATE SET
                 project_path = excluded.project_path,
                 short_sha = excluded.short_sha,
                 message = excluded.message,
                 author = excluded.author,
                 committed_at = excluded.committed_at,
                 indexed_at = excluded.indexed_at
             WHERE git_commits.message != excluded.message`,
        );
        insertStatements.set(db, stmt);
    }
    return stmt;
}

function getExistingShasStatement(db: Database): PreparedStatement {
    let stmt = existingShasStatements.get(db);
    if (!stmt) {
        stmt = db.prepare("SELECT sha FROM git_commits WHERE project_path = ?");
        existingShasStatements.set(db, stmt);
    }
    return stmt;
}

function getProjectCountStatement(db: Database): PreparedStatement {
    let stmt = projectCountStatements.get(db);
    if (!stmt) {
        stmt = db.prepare("SELECT COUNT(*) AS count FROM git_commits WHERE project_path = ?");
        projectCountStatements.set(db, stmt);
    }
    return stmt;
}

function getLatestCommitTimeStatement(db: Database): PreparedStatement {
    let stmt = latestCommitTimeStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "SELECT MAX(committed_at) AS latest FROM git_commits WHERE project_path = ?",
        );
        latestCommitTimeStatements.set(db, stmt);
    }
    return stmt;
}

function getEvictOverflowStatement(db: Database): PreparedStatement {
    let stmt = evictOverflowStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `DELETE FROM git_commits
             WHERE rowid IN (
                 SELECT rowid FROM git_commits
                 WHERE project_path = ?
                 ORDER BY committed_at DESC, sha DESC
                 LIMIT -1 OFFSET ?
             )`,
        );
        evictOverflowStatements.set(db, stmt);
    }
    return stmt;
}

/** Rows skipped because `message` matches do not contribute to `inserted` or `updated`.
 * */
export function upsertCommits(
    db: Database,
    projectPath: string,
    commits: GitCommit[],
): { inserted: number; updated: number } {
    if (commits.length === 0) return { inserted: 0, updated: 0 };

    const existing = new Set<string>();
    for (const row of getExistingShasStatement(db).all(projectPath) as { sha: string }[]) {
        existing.add(row.sha);
    }

    let inserted = 0;
    let updated = 0;
    const now = Date.now();
    const insertStmt = getInsertStatement(db);

    db.transaction(() => {
        for (const commit of commits) {
            const result = insertStmt.run(
                commit.sha,
                projectPath,
                commit.shortSha,
                commit.message,
                commit.author,
                commit.committedAtMs,
                now,
            );
            // changes > 0 means row was inserted or updated (not skipped by WHERE clause)
            if (result.changes > 0) {
                if (existing.has(commit.sha)) {
                    updated++;
                } else {
                    inserted++;
                    existing.add(commit.sha);
                }
            }
        }
    })();

    return { inserted, updated };
}

/* */
export function getCommitCount(db: Database, projectPath: string): number {
    const row = getProjectCountStatement(db).get(projectPath) as { count: number } | undefined;
    return row?.count ?? 0;
}

/* */
export function getLatestIndexedCommitTimeMs(db: Database, projectPath: string): number | null {
    const row = getLatestCommitTimeStatement(db).get(projectPath) as
        | { latest: number | null }
        | undefined;
    return row?.latest ?? null;
}

/**
 * */
export function enforceProjectCap(db: Database, projectPath: string, maxCommits: number): number {
    if (maxCommits <= 0) return 0;
    const count = getCommitCount(db, projectPath);
    if (count <= maxCommits) return 0;

    // The DELETE computes overflow from the current table state to avoid stale count-derived `excess` values deleting additional commits.
    getEvictOverflowStatement(db).run(projectPath, maxCommits);
    const after = getCommitCount(db, projectPath);
    const evicted = Math.max(0, count - after);
    if (evicted > 0) {
        log(
            `[git-commits] evicted ${evicted} oldest commits for project ${projectPath} (cap=${maxCommits}, was=${count})`,
        );
    }
    return evicted;
}
