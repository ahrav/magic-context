import type { Database, Statement as PreparedStatement } from "../../../shared/sqlite";
import {
    buildWorkspaceMemorySqlFilter,
    getMemorySelectColumns,
    getStatsDependentStatement,
    memoryRowsFromQuery,
    registerStatsDependentStatementCache,
} from "./storage-memory";
import type { Memory } from "./types";

const DEFAULT_SEARCH_LIMIT = 10;
// getMemorySelectColumns embeds the memory_stats projection, so these caches
// register for invalidation when the stats-table probe first turns positive.
const searchStatements = registerStatsDependentStatementCache(
    new WeakMap<Database, PreparedStatement>(),
);
const unionSearchStatements = new Map<number, WeakMap<Database, PreparedStatement>>();

function getSearchStatement(db: Database): PreparedStatement {
    return getStatsDependentStatement(db, searchStatements, () =>
        db.prepare(
            `SELECT ${getMemorySelectColumns(db)} FROM memories_fts INNER JOIN memories ON memories.id = memories_fts.rowid WHERE memories.project_path = ? AND memories.status IN ('active', 'permanent') AND (memories.expires_at IS NULL OR memories.expires_at > ?) AND memories_fts MATCH ? ORDER BY bm25(memories_fts), updatedAt DESC, memories.id ASC LIMIT ?`,
        ),
    );
}

/**
 * Sanitize a user query for FTS5 MATCH syntax.
 *
 * FTS5 interprets characters like `-`, `:`, `*`, `(`, `)` as operators.
 * This wraps each whitespace-delimited token in double quotes so special
 * characters are treated as literal content rather than query syntax.
 */

function getUnionSearchStatement(db: Database, arity: number): PreparedStatement {
    let statements = unionSearchStatements.get(arity);
    if (!statements) {
        statements = registerStatsDependentStatementCache(
            new WeakMap<Database, PreparedStatement>(),
        );
        unionSearchStatements.set(arity, statements);
    }
    return getStatsDependentStatement(db, statements, () => {
        const placeholders = Array.from({ length: arity }, () => "?").join(", ");
        return db.prepare(
            `SELECT ${getMemorySelectColumns(db)} FROM memories_fts INNER JOIN memories ON memories.id = memories_fts.rowid WHERE memories.project_path IN (${placeholders}) AND memories.status IN ('active', 'permanent') AND (memories.expires_at IS NULL OR memories.expires_at > ?) AND memories_fts MATCH ? ORDER BY bm25(memories_fts), updatedAt DESC, memories.id ASC LIMIT ?`,
        );
    });
}

function uniqueProjectPaths(projectPaths: readonly string[]): string[] {
    return [...new Set(projectPaths.filter((path) => path.length > 0))];
}

export function sanitizeFtsQuery(query: string): string {
    const tokens = query.split(/\s+/).filter((token) => token.length > 0);
    if (tokens.length === 0) return "";

    return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(" ");
}

export function searchMemoriesFTS(
    db: Database,
    projectPath: string,
    query: string,
    limit = DEFAULT_SEARCH_LIMIT,
): Memory[] {
    const trimmedQuery = query.trim();
    if (trimmedQuery.length === 0 || limit <= 0) {
        return [];
    }

    const sanitized = sanitizeFtsQuery(trimmedQuery);
    if (sanitized.length === 0) {
        return [];
    }

    return memoryRowsFromQuery(
        db,
        getSearchStatement(db).all(projectPath, Date.now(), sanitized, limit),
    );
}

export function searchMemoriesFTSUnion(
    db: Database,
    projectPaths: readonly string[],
    query: string,
    limit = DEFAULT_SEARCH_LIMIT,
    ownIdentities?: readonly string[],
    shareCategories?: readonly string[] | null,
): Memory[] {
    const identities = uniqueProjectPaths(projectPaths);
    if (identities.length === 0) return [];
    const sharingFilter = buildWorkspaceMemorySqlFilter({
        identities,
        ownIdentities,
        shareCategories,
        tableName: "memories",
        includeClassificationFields: (() => {
            const columns = db.prepare("PRAGMA table_info(memories)").all() as Array<{
                name?: string;
            }>;
            return (
                columns.some((row) => row.name === "shareable") &&
                columns.some((row) => row.name === "scope")
            );
        })(),
    });
    if (identities.length === 1 && !sharingFilter.active) {
        return searchMemoriesFTS(db, identities[0], query, limit);
    }

    const trimmedQuery = query.trim();
    if (trimmedQuery.length === 0 || limit <= 0) return [];
    const sanitized = sanitizeFtsQuery(trimmedQuery);
    if (sanitized.length === 0) return [];

    const rows = sharingFilter.active
        ? db
              .prepare(
                  `SELECT ${getMemorySelectColumns(db)} FROM memories_fts INNER JOIN memories ON memories.id = memories_fts.rowid WHERE memories.project_path IN (${identities.map(() => "?").join(", ")}) AND memories.status IN ('active', 'permanent') AND (memories.expires_at IS NULL OR memories.expires_at > ?) AND memories_fts MATCH ?${sharingFilter.clause} ORDER BY bm25(memories_fts), updatedAt DESC, memories.id ASC LIMIT ?`,
              )
              .all(...identities, Date.now(), sanitized, ...sharingFilter.params, limit)
        : getUnionSearchStatement(db, identities.length).all(
              ...identities,
              Date.now(),
              sanitized,
              limit,
          );

    return memoryRowsFromQuery(db, rows);
}
