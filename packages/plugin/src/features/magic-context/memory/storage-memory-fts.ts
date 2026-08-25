import type { Database, Statement as PreparedStatement } from "../../../shared/sqlite";
import { sanitizeFtsQuery } from "../fts-query";
import {
    buildWorkspaceMemorySqlFilter,
    getMemorySelectColumns,
    getMemoryStatsJoin,
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
            `SELECT ${getMemorySelectColumns(db)} FROM memories_fts INNER JOIN memories ON memories.id = memories_fts.rowid ${getMemoryStatsJoin(db)} WHERE memories.project_path = ? AND memories.status IN ('active', 'permanent') AND (memories.expires_at IS NULL OR memories.expires_at > ?) AND memories_fts MATCH ? ORDER BY bm25(memories_fts), updatedAt DESC, memories.id ASC LIMIT ?`,
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
            `SELECT ${getMemorySelectColumns(db)} FROM memories_fts INNER JOIN memories ON memories.id = memories_fts.rowid ${getMemoryStatsJoin(db)} WHERE memories.project_path IN (${placeholders}) AND memories.status IN ('active', 'permanent') AND (memories.expires_at IS NULL OR memories.expires_at > ?) AND memories_fts MATCH ? ORDER BY bm25(memories_fts), updatedAt DESC, memories.id ASC LIMIT ?`,
        );
    });
}

function uniqueProjectPaths(projectPaths: readonly string[]): string[] {
    return [...new Set(projectPaths.filter((path) => path.length > 0))];
}

export { sanitizeFtsQuery };

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

const withinSearchStatements = registerStatsDependentStatementCache(
    new WeakMap<Database, PreparedStatement>(),
);

/**
 * Rank FTS matches WITHIN an explicit id set. The id set is authoritative —
 * callers pass ids that already passed status, expiry, workspace, and policy
 * filtering — so the query needs no other predicates and returns the
 * top-ranked members of the set in one bounded fetch. Restricting inside SQL
 * is what keeps a hidden-heavy corpus cheap: ranking globally and filtering
 * afterwards must either widen without bound or truncate eligible matches.
 */
export function searchMemoriesFTSWithinIds(
    db: Database,
    memoryIds: readonly number[],
    query: string,
    limit: number,
): Memory[] {
    if (memoryIds.length === 0 || limit <= 0) return [];
    const trimmedQuery = query.trim();
    if (trimmedQuery.length === 0) return [];
    const sanitized = sanitizeFtsQuery(trimmedQuery);
    if (sanitized.length === 0) return [];
    const statement = getStatsDependentStatement(db, withinSearchStatements, () =>
        db.prepare(
            `SELECT ${getMemorySelectColumns(db)} FROM memories_fts INNER JOIN memories ON memories.id = memories_fts.rowid ${getMemoryStatsJoin(db)} WHERE memories.id IN (SELECT value FROM json_each(?)) AND memories_fts MATCH ? ORDER BY bm25(memories_fts), updatedAt DESC, memories.id ASC LIMIT ?`,
        ),
    );
    return memoryRowsFromQuery(db, statement.all(JSON.stringify(memoryIds), sanitized, limit));
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
                  `SELECT ${getMemorySelectColumns(db)} FROM memories_fts INNER JOIN memories ON memories.id = memories_fts.rowid ${getMemoryStatsJoin(db)} WHERE memories.project_path IN (${identities.map(() => "?").join(", ")}) AND memories.status IN ('active', 'permanent') AND (memories.expires_at IS NULL OR memories.expires_at > ?) AND memories_fts MATCH ?${sharingFilter.clause} ORDER BY bm25(memories_fts), updatedAt DESC, memories.id ASC LIMIT ?`,
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
