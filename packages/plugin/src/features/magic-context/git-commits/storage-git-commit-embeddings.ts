/**
 * Embedding storage for git commits.
 *
 * Mirrors the memory-embedding storage layout but keyed by commit SHA rather
 * than memory id. Embeddings are byte-equivalent to memory embeddings (Float32
 * serialized via Float32Array.buffer), so the same cosine-similarity helpers
 * apply without conversion.
 */

import type { Database, Statement as PreparedStatement } from "../../../shared/sqlite";
import type { VectorLoadObserver } from "../search-trace";

interface CommitEmbeddingRow {
    sha: string;
    embedding: Uint8Array;
    model_id: string;
    committed_at: number;
}

/** `CommitEmbeddingCandidate` carries `committedAtMs` so ranking can complete
 *  before metadata hydration. */
export interface CommitEmbeddingCandidate {
    vector: Float32Array;
    committedAtMs: number;
}

interface UnembeddedRow {
    sha: string;
    message: string;
}

const saveStatements = new WeakMap<Database, PreparedStatement>();
const loadProjectStatements = new WeakMap<Database, PreparedStatement>();
const loadUnembeddedStatements = new WeakMap<Database, PreparedStatement>();
const countEmbeddedStatements = new WeakMap<Database, PreparedStatement>();

function getSaveStatement(db: Database): PreparedStatement {
    let stmt = saveStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `INSERT INTO git_commit_embeddings (sha, embedding, model_id, created_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(sha, model_id) DO UPDATE SET
                  embedding = excluded.embedding,
                  created_at = excluded.created_at`,
        );
        saveStatements.set(db, stmt);
    }
    return stmt;
}

function getLoadProjectStatement(db: Database): PreparedStatement {
    let stmt = loadProjectStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT e.sha AS sha, e.embedding AS embedding, e.model_id AS model_id,
                    c.committed_at AS committed_at
             FROM git_commit_embeddings e
             JOIN git_commits c ON c.sha = e.sha
             WHERE c.project_path = ? AND e.model_id = ?`,
        );
        loadProjectStatements.set(db, stmt);
    }
    return stmt;
}

function getLoadUnembeddedStatement(db: Database): PreparedStatement {
    let stmt = loadUnembeddedStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT c.sha AS sha, c.message AS message
             FROM git_commits c
             LEFT JOIN git_commit_embeddings e ON c.sha = e.sha AND e.model_id = ?
             WHERE c.project_path = ? AND e.sha IS NULL AND c.message != ''
               AND length(CAST(c.message AS BLOB)) <= ?
             ORDER BY c.committed_at DESC
             LIMIT ?`,
        );
        loadUnembeddedStatements.set(db, stmt);
    }
    return stmt;
}

function getCountEmbeddedStatement(db: Database): PreparedStatement {
    let stmt = countEmbeddedStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT COUNT(*) AS count FROM git_commit_embeddings e
             JOIN git_commits c ON c.sha = e.sha WHERE c.project_path = ? AND e.model_id = ?`,
        );
        countEmbeddedStatements.set(db, stmt);
    }
    return stmt;
}

export function saveCommitEmbedding(
    db: Database,
    sha: string,
    embedding: Float32Array,
    modelId: string,
): void {
    const bytes = new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    getSaveStatement(db).run(sha, bytes, modelId, Date.now());
}

export function hasCommitEmbedding(db: Database, sha: string, modelId: string): boolean {
    return Boolean(
        db
            .prepare("SELECT 1 FROM git_commit_embeddings WHERE sha = ? AND model_id = ? LIMIT 1")
            .get(sha, modelId),
    );
}

/** The join to `git_commits` drops embeddings whose commit row is gone, so an
 *  orphan vector can never reach ranking. */
export function loadProjectCommitEmbeddings(
    db: Database,
    projectPath: string,
    modelId: string,
    onVectorLoad?: VectorLoadObserver,
): Map<string, CommitEmbeddingCandidate> {
    const rows = getLoadProjectStatement(db).all(projectPath, modelId) as CommitEmbeddingRow[];
    const map = new Map<string, CommitEmbeddingCandidate>();
    let decodedBytes = 0;
    for (const row of rows) {
        const buffer = row.embedding.buffer.slice(
            row.embedding.byteOffset,
            row.embedding.byteOffset + row.embedding.byteLength,
        );
        decodedBytes += row.embedding.byteLength;
        map.set(row.sha, {
            vector: new Float32Array(buffer),
            committedAtMs: row.committed_at,
        });
    }
    onVectorLoad?.({ decodedBytes, cachedBytes: 0, vectorCount: map.size, cacheHit: false });
    return map;
}

/**
 * Commits with no embedding row for `modelId`, newest first.
 *
 * A commit created with an empty message carries no embeddable text: the host
 * rejects an empty item, and one rejected item fails every page of the batch's
 * application group. Because such a row is never embeddable, selecting it makes
 * the newest batch fail forever and the drain — which stops as soon as a batch
 * embeds nothing — never reaches the commits behind it. Excluding it in the
 * selection is what retires it: it is permanently not work, so it never enters
 * a batch and never blocks one. The same applies to text above a provider's
 * per-item byte cap.
 */
export function loadUnembeddedCommits(
    db: Database,
    projectPath: string,
    modelId: string,
    limit: number,
    maxInputBytes = Number.MAX_SAFE_INTEGER,
): Array<{ sha: string; message: string }> {
    return getLoadUnembeddedStatement(db).all(
        modelId,
        projectPath,
        maxInputBytes,
        limit,
    ) as UnembeddedRow[];
}

export function countEmbeddedCommits(db: Database, projectPath: string, modelId: string): number {
    const row = getCountEmbeddedStatement(db).get(projectPath, modelId) as
        | { count: number }
        | undefined;
    return row?.count ?? 0;
}
