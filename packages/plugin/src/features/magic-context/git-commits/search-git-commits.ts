/**
 *
 * unifiedSearch applies source boosts when it merges these raw scored matches.
 *
 * The lanes retain only SHA, lane scores, committed_at, and discovery ordinal until top-K hydration, avoiding metadata loads for unreturned candidates.
 */

import { log } from "../../../shared/logger";
import type { Database, Statement as PreparedStatement } from "../../../shared/sqlite";
import { sanitizeFtsQuery } from "../fts-query";
import { cosineSimilarity } from "../memory/cosine-similarity";
import { MAX_LANE_CANDIDATES } from "../search-bounds";
import type { HybridLaneStageMarks, VectorLoadObserver } from "../search-trace";
import { loadProjectCommitEmbeddings } from "./storage-git-commit-embeddings";
import type { StoredGitCommit } from "./storage-git-commits";

const ftsStatements = new WeakMap<Database, PreparedStatement>();
const ftsPlainStatements = new WeakMap<Database, PreparedStatement>();
const getBySHAsStatements = new WeakMap<Database, PreparedStatement>();

interface CommitRow {
    sha: string;
    project_path: string;
    short_sha: string;
    message: string;
    author: string | null;
    committed_at: number;
    indexed_at: number;
}

interface CandidateRow {
    sha: string;
    committed_at: number;
}

interface CommitCandidate {
    sha: string;
    committedAtMs: number;
    /** ordinal records discovery position: FTS candidates first, then semantic-only candidates. */
    ordinal: number;
    ftsScore?: number;
    semanticScore?: number;
}

function rowToCommit(row: CommitRow): StoredGitCommit {
    return {
        sha: row.sha,
        shortSha: row.short_sha,
        projectPath: row.project_path,
        message: row.message,
        author: row.author,
        committedAtMs: row.committed_at,
        indexedAtMs: row.indexed_at,
    };
}

function getFtsStatement(db: Database): PreparedStatement {
    let stmt = ftsStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT c.sha AS sha, c.committed_at AS committed_at
             FROM git_commits_fts
             INNER JOIN git_commits c ON c.sha = git_commits_fts.sha
             WHERE c.project_path = ? AND git_commits_fts MATCH ?
             ORDER BY bm25(git_commits_fts) LIMIT ?`,
        );
        ftsStatements.set(db, stmt);
    }
    return stmt;
}

function getLikeFallbackStatement(db: Database): PreparedStatement {
    let stmt = ftsPlainStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT sha, committed_at
             FROM git_commits
             WHERE project_path = ? AND lower(message) LIKE '%' || lower(?) || '%'
             ORDER BY committed_at DESC LIMIT ?`,
        );
        ftsPlainStatements.set(db, stmt);
    }
    return stmt;
}

function getBySHAsStatement(db: Database): PreparedStatement {
    let stmt = getBySHAsStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT sha, project_path, short_sha, message, author, committed_at, indexed_at
               FROM git_commits
              WHERE project_path = ?
                AND sha IN (SELECT value FROM json_each(?))`,
        );
        getBySHAsStatements.set(db, stmt);
    }
    return stmt;
}

export interface GitCommitSearchHit {
    commit: StoredGitCommit;
    /** score stores the combined score in [0, 1]. */
    score: number;
    matchType: "semantic" | "fts" | "hybrid";
}

export interface SearchGitCommitsOptions {
    limit: number;
    /** semanticWeight weights raw semantic scores; defaults to 0.7. */
    semanticWeight?: number;
    /** ftsWeight weights raw FTS scores; defaults to 0.3. */
    ftsWeight?: number;
    /** The singleSourcePenalty scales scores with only one lane signal to favor hybrid matches; default 0.8.
     * */
    singleSourcePenalty?: number;
    /** Pre-computed query embedding. When omitted, we skip the semantic pass. */
    queryEmbedding?: Float32Array | null;
    /** queryModelId identifies the model that generated queryEmbedding; commit vectors are read only from the same model space. */
    queryModelId?: string | null;
    /** vectorLoadObserver receives decoded commit-vector byte counts when the semantic pass loads embeddings. */
    onVectorLoad?: VectorLoadObserver;
    /** stageMarks records phase boundaries for the lexical, semantic, and fusion passes. */
    stages?: HybridLaneStageMarks;
}

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.min(1, Math.max(0, value));
}

interface ScoredCandidate {
    candidate: CommitCandidate;
    score: number;
    matchType: GitCommitSearchHit["matchType"];
}

function scoreCandidate(
    candidate: CommitCandidate,
    weights: { semanticWeight: number; ftsWeight: number; singleSourcePenalty: number },
): ScoredCandidate | null {
    const sem = candidate.semanticScore;
    const fts = candidate.ftsScore;
    let score = 0;
    let matchType: GitCommitSearchHit["matchType"] = "fts";

    if (sem !== undefined && fts !== undefined) {
        score = weights.semanticWeight * sem + weights.ftsWeight * fts;
        matchType = "hybrid";
    } else if (sem !== undefined) {
        score = sem * weights.singleSourcePenalty;
        matchType = "semantic";
    } else if (fts !== undefined) {
        score = fts * weights.singleSourcePenalty;
        matchType = "fts";
    }

    if (score <= 0) return null;
    return { candidate, score, matchType };
}

/**
 */
export function searchGitCommitsSync(
    db: Database,
    projectPath: string,
    query: string,
    options: SearchGitCommitsOptions,
): GitCommitSearchHit[] {
    const trimmed = query.trim();
    if (trimmed.length === 0 || options.limit <= 0) return [];

    const weights = {
        semanticWeight: options.semanticWeight ?? 0.7,
        ftsWeight: options.ftsWeight ?? 0.3,
        singleSourcePenalty: options.singleSourcePenalty ?? 0.8,
    };
    // `limit` is clamped to `MAX_LANE_CANDIDATES` so no caller can exceed the shared candidate bound.
    const limit = Math.min(options.limit, MAX_LANE_CANDIDATES);
    const fetchLimit = Math.min(Math.max(limit * 3, 30), MAX_LANE_CANDIDATES);

    // Selection and hydration share one snapshot, preventing a concurrent indexer from changing hydrated rows after ranking.
    return db.transaction((): GitCommitSearchHit[] => {
        const candidates = new Map<string, CommitCandidate>();
        const addCandidate = (sha: string, committedAtMs: number): CommitCandidate => {
            const existing = candidates.get(sha);
            if (existing) return existing;
            const candidate: CommitCandidate = {
                sha,
                committedAtMs,
                ordinal: candidates.size,
            };
            candidates.set(sha, candidate);
            return candidate;
        };

        options.stages?.lexicalStart();
        const lexicalRows: CandidateRow[] = [];
        const sanitized = sanitizeFtsQuery(trimmed);
        if (sanitized.length > 0) {
            try {
                lexicalRows.push(
                    ...(getFtsStatement(db).all(
                        projectPath,
                        sanitized,
                        fetchLimit,
                    ) as CandidateRow[]),
                );
            } catch (error) {
                log(
                    `[git-commits] FTS query failed for "${trimmed}": ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }

        if (lexicalRows.length === 0) {
            lexicalRows.push(
                ...(getLikeFallbackStatement(db).all(
                    projectPath,
                    trimmed,
                    fetchLimit,
                ) as CandidateRow[]),
            );
        }

        lexicalRows.forEach((row, rank) => {
            const candidate = addCandidate(row.sha, row.committed_at);
            if (candidate.ftsScore === undefined) candidate.ftsScore = 1 / (rank + 1);
        });
        options.stages?.lexicalEnd(lexicalRows.length);

        if (options.queryEmbedding && options.queryModelId && options.queryModelId !== "off") {
            options.stages?.vectorStart();
            const embeddings = loadProjectCommitEmbeddings(
                db,
                projectPath,
                options.queryModelId,
                options.onVectorLoad,
            );
            // Semantic scoring visits every cached vector but admits only the top fetchLimit candidates, bounding fusion and final sorting to MAX_LANE_CANDIDATES; newer commits break similarity ties.
            const semanticHits: Array<{ sha: string; committedAtMs: number; similarity: number }> =
                [];
            for (const [sha, entry] of embeddings.entries()) {
                const similarity = clamp01(cosineSimilarity(options.queryEmbedding, entry.vector));
                if (similarity <= 0) continue;
                semanticHits.push({ sha, committedAtMs: entry.committedAtMs, similarity });
            }
            semanticHits.sort(
                (left, right) =>
                    right.similarity - left.similarity || right.committedAtMs - left.committedAtMs,
            );
            for (const hit of semanticHits.slice(0, fetchLimit)) {
                const candidate = addCandidate(hit.sha, hit.committedAtMs);
                candidate.semanticScore = hit.similarity;
            }
            options.stages?.vectorEnd(Math.min(semanticHits.length, fetchLimit));
        } else {
            options.stages?.vectorSkipped();
        }

        options.stages?.fusionStart();
        const scored: ScoredCandidate[] = [];
        for (const candidate of candidates.values()) {
            const entry = scoreCandidate(candidate, weights);
            if (entry) scored.push(entry);
        }
        scored.sort((left, right) => {
            if (right.score !== left.score) return right.score - left.score;
            if (right.candidate.committedAtMs !== left.candidate.committedAtMs) {
                return right.candidate.committedAtMs - left.candidate.committedAtMs;
            }
            return left.candidate.ordinal - right.candidate.ordinal;
        });
        const selected = scored.slice(0, limit);
        if (selected.length === 0) {
            options.stages?.fusionEnd(candidates.size, 0);
            return [];
        }

        const rows = getBySHAsStatement(db).all(
            projectPath,
            JSON.stringify(selected.map((entry) => entry.candidate.sha)),
        ) as CommitRow[];
        const commitBySha = new Map(rows.map((row) => [row.sha, rowToCommit(row)]));

        // `IN` result order is not authoritative, so restore the selected order.
        const hits: GitCommitSearchHit[] = [];
        for (const entry of selected) {
            const commit = commitBySha.get(entry.candidate.sha);
            if (!commit) continue;
            hits.push({ commit, score: entry.score, matchType: entry.matchType });
        }
        options.stages?.fusionEnd(candidates.size, hits.length);
        return hits;
    })();
}
