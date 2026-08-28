import { log } from "../../shared/logger";
import type { Database, Statement as PreparedStatement } from "../../shared/sqlite";
import {
    loadCompartmentChunkEmbeddingsForSearch,
    type StoredCompartmentChunkEmbedding,
} from "./compartment-chunk-embedding";
import { sanitizeFtsQuery } from "./fts-query";
import { type GitCommitSearchHit, searchGitCommitsSync } from "./git-commits";
import { containsProbeVerbatim, extractLiteralProbes } from "./literal-probes";
import { readProjectIdentityMap } from "./memory/claim-memory-render";
import { isValidPublicClaimId, parseRevisionLocator } from "./memory/claim-operation-contract";
import { CLAIM_POLICY_VERSION } from "./memory/claim-visibility-policy";
import { ANTI_MEMORY_CATEGORY } from "./memory/constants";
import { cosineSimilarity } from "./memory/cosine-similarity";
import {
    embedBatchForProject,
    embedText,
    getProjectEmbeddingSnapshot,
    isEmbeddingEnabled,
} from "./memory/embedding";
import type { EmbeddingPurpose } from "./memory/embedding-provider";
import {
    listActiveAntiMemoryPublicIds,
    readAntiMemories,
    readAntiMemory,
} from "./memory/storage-anti-memory";
import {
    type ProjectMemoryClaimSnapshot,
    readProjectMemoryCurrentState,
    resolveProjectIdsForIdentities,
} from "./memory/storage-claim-current-state";
import { recordClaimUsage } from "./memory/storage-claim-operations";
import { getIndexedMessageCorpusSize } from "./message-index";
import {
    DEFAULT_SEARCH_RESULT_LIMIT,
    MAX_LANE_CANDIDATES,
    normalizeCandidateDepth,
    normalizeSearchResultLimit,
    prepareExplicitQuery,
    QueryBoundsError,
} from "./search-bounds";
import { recordShadowMeasurement } from "./search-measurement";
import {
    accumulateVectorLoad,
    createSearchTraceRecorder,
    type HybridLaneStageMarks,
    type SearchTraceOptions,
    type SearchTraceRecorder,
    type SearchTraceSpanHandle,
    type VectorLoadEvent,
    type VectorLoadObserver,
    vectorLoadCounters,
} from "./search-trace";
import {
    countNoteFtsMatchesBatch,
    countSearchableNotes,
    getRecentSearchableNotes,
    getSearchableNotesByIds,
    type Note,
    selectNoteCandidateIds,
} from "./storage-notes";
import { getActivePrimers, type Primer } from "./storage-primers";
import {
    computeWorkspaceEpochFingerprint,
    expandWorkspaceIdentitySetWithAliases,
    resolveWorkspaceIdentitySet,
    resolveWorkspaceShareCategories,
    sourceNameForMemory,
    type WorkspaceIdentitySet,
} from "./workspaces";

const SEMANTIC_WEIGHT = 0.7;
const FTS_WEIGHT = 0.3;
const SINGLE_SOURCE_PENALTY = 0.8;
const RESULT_PREVIEW_LIMIT = 220;
/** Source boost multipliers for unified ranking.
 *
 * Memories are curated, hand-written summaries — strongest signal.
 * Git commits are terse human-written descriptions — high signal.
 * Messages are raw history that survived compression — boosted above baseline
 * (1.15 in this release, up from 1.0) because by definition these are the
 * specific details the historian didn't preserve as memories or compartments,
 * which is exactly what ctx_search is most useful for. */
const MEMORY_SOURCE_BOOST = 1.3;
const MESSAGE_SOURCE_BOOST = 1.15;
const GIT_COMMIT_SOURCE_BOOST = 1.2;
const PRIMER_SOURCE_BOOST = 1.25;
const ANTI_MEMORY_SEMANTIC_THRESHOLD = 0.7;
/** Ceiling on candidate texts sent to the embedding provider per search.
 *  Anti-memory passage vectors are computed live (nothing persists them),
 *  and this lane runs on the per-user-prompt auto-search path, so the batch
 *  must not scale with the record population. Lexically matched candidates
 *  keep priority; the remainder of the budget goes to the newest records. */
const ANTI_MEMORY_MAX_SEMANTIC_CANDIDATES = 32;

interface MessageSearchRow {
    messageOrdinal?: number | string;
    messageId?: string;
    role?: string;
    /** Bounded FTS snippet (R34) — never the full message body. */
    fragment?: string;
    /** `verbatim0..N` full-body probe-containment flags (KTD2). */
    [verbatimFlag: string]: unknown;
}

interface BatchedMessageSearchRow extends MessageSearchRow {
    queryIndex?: number;
    ftsRank?: number;
}

interface BatchedFtsCountRow {
    queryIndex?: number;
    count?: number;
}

const messageSearchStatements = new WeakMap<Database, PreparedStatement>();
const messageSearchStatementsWithCutoff = new WeakMap<Database, PreparedStatement>();
const batchedMessageSearchStatements = new WeakMap<Database, Map<string, PreparedStatement>>();
const batchedFtsCountStatements = new WeakMap<Database, Map<string, PreparedStatement>>();

/** R34 fragment bound: at most this many FTS tokens per message hit. */
const MESSAGE_FRAGMENT_TOKENS = 32;
const MESSAGE_FRAGMENT_START_MARKER = "<<";
const MESSAGE_FRAGMENT_END_MARKER = ">>";
const MESSAGE_FRAGMENT_OMISSION = " ... ";
/** `content` is column 4 of message_history_fts (session_id, message_ordinal, message_id, role, content). */
const MESSAGE_FRAGMENT_COLUMN = 4;
/** Identical snippet parameters for the single and batched statements (KTD2). */
const MESSAGE_FRAGMENT_SQL = `snippet(message_history_fts, ${MESSAGE_FRAGMENT_COLUMN}, '${MESSAGE_FRAGMENT_START_MARKER}', '${MESSAGE_FRAGMENT_END_MARKER}', '${MESSAGE_FRAGMENT_OMISSION}', ${MESSAGE_FRAGMENT_TOKENS}) AS fragment`;

/** Per-probe full-body containment flags, so a verbatim bonus survives even when
 *  the probe falls outside the returned fragment (AE2). SQLite `lower()` folds
 *  ASCII only; probes are ASCII identifier shapes by construction
 *  (`extractLiteralProbes`), and the JS-side probe is lowercased by the caller. */
function verbatimFlagSql(probeCount: number): string {
    return Array.from(
        { length: probeCount },
        (_, index) => `, instr(lower(content), ?) > 0 AS verbatim${index}`,
    ).join("");
}

export type SearchSource = "memory" | "message" | "git_commit" | "primer" | "note";

export interface CapturedQueryEmbedding {
    vector: Float32Array;
    modelId: string;
    chunkModelId: string;
    generation: number;
}

export interface UnifiedSearchOptions {
    limit?: number;
    memoryEnabled?: boolean;
    embeddingEnabled?: boolean;
    /** Deprecated: message search no longer reads raw messages on the hot path. */
    readMessages?: (sessionId: string) => unknown[];
    embedQuery?: (
        text: string,
        signal?: AbortSignal,
        purpose?: EmbeddingPurpose,
    ) => Promise<CapturedQueryEmbedding | Float32Array | null>;
    embedPassages?: (
        texts: string[],
        signal?: AbortSignal,
        purpose?: EmbeddingPurpose,
    ) => Promise<(Float32Array | null)[]>;
    isEmbeddingRuntimeEnabled?: () => boolean;
    /** Only return message-history hits with ordinal ≤ this value (e.g. last compartment end). -1 or omit to search all. */
    maxMessageOrdinal?: number;
    /** Include indexed git commits in the result set. Default false — the
     *  feature is gated behind experimental.git_commit_indexing config. */
    gitCommitsEnabled?: boolean;
    /** Restrict results to these sources. Omit or pass undefined to search all
     *  enabled sources. Empty array is treated as "no sources enabled" → [].
     *  Facts are NOT a source — they're already always rendered in the
     *  <session-history> block injected into message[0]. */
    sources?: SearchSource[];
    /** Abort signal — if provided, cancels in-flight embedding requests
     *  (and any downstream HTTP calls) when the caller gives up. Used by
     *  transform-hot-path callers like auto-search whose own 3s timeout
     *  needs to cancel the 30s embedding fetch. */
    signal?: AbortSignal;
    /** When true (default), increment retrieval_count on memory hits. Explicit
     *  `ctx_search` tool calls from the agent SHOULD count — the agent asked
     *  for the memory, saw it, and used it. Plugin-internal automatic surfacing
     *  (e.g. auto-search hints appended to every user prompt) should NOT count
     *  because the agent may never actually consume the hint, and even if they
     *  do, automatic surfacing doesn't indicate usefulness. Mis-counting drives
     *  spurious retrieval-count-based memory promotion decisions. */
    countRetrievals?: boolean;
    /** When true, run multi-probe message search: extract literal symbol/command/
     *  path probes from the query and query each one separately (RRF-fused) so a
     *  message containing the exact literal but not the query's other tokens is
     *  still recalled. Default false — only explicit `ctx_search` tool calls opt
     *  in; the auto-search hot path stays single-probe to protect its latency
     *  budget. NL queries with no extractable probes are unaffected either way. */
    explicitSearch?: boolean;
    /** Disables production search metrics while running an offline shadow quality comparison. */
    measurementDisabled?: boolean;
    embeddingModelIdOverride?: string;
    chunkModelIdOverride?: string;
    /** When `trace` is absent, search performs no tracing. When present,
     *  tracing does not change results, SQL, side effects, ordering, or
     *  errors. */
    trace?: SearchTraceOptions;
    /** `candidateDepth` sets the per-lane candidate count; `limit` controls
     *  returned results. */
    candidateDepth?: number;
    memoryPolicySurface?: "auto_search" | "explicit_search";
}

export interface MemorySearchResult {
    source: "memory";
    content: string;
    score: number;
    /** Opaque public claim identity (`mcm_<32hex>`). */
    publicClaimId: string;
    /** Canonical current revision locator the content was read from. */
    revisionLocator: string;
    category: string;
    matchType: "exact";
    sourceName?: string;
    policyLabel?: string;
    /** Exact SHA-256 digest of the served revision's content bytes. */
    contentDigest?: string;
}

export interface AntiMemorySearchResult {
    source: "anti_memory";
    score: number;
    publicClaimId: string;
    revisionLocator: string;
    contentDigest: string;
    claimId: number;
    normalizedHash: string;
    trigger: string;
    rejectedStrategy: string;
    rejectionReason: string;
    saferAlternative: string | null;
    matchType: "exact" | "lexical" | "semantic";
    policyLabel?: string;
}

export interface MessageSearchResult {
    source: "message";
    content: string;
    score: number;
    messageOrdinal: number;
    messageId: string;
    role: string;
}

export interface CompartmentSearchResult {
    source: "compartment";
    content: string;
    score: number;
    compartmentId: number;
    sessionId: string;
    title: string;
    startOrdinal: number;
    endOrdinal: number;
    matchType: "semantic" | "hybrid";
    snippet?: string;
}

export interface GitCommitSearchResult {
    source: "git_commit";
    content: string;
    score: number;
    sha: string;
    shortSha: string;
    author: string | null;
    committedAtMs: number;
    matchType: "semantic" | "fts" | "hybrid";
}

export interface PrimerSearchResult {
    source: "primer";
    content: string;
    score: number;
    primerId: number;
    question: string;
    support: number;
    lastObservedAt: number | null;
    matchType: "semantic" | "fts" | "hybrid";
}

export interface NoteSearchResult {
    source: "note";
    content: string;
    score: number;
    noteId: number;
    status: Note["status"];
    createdAt: number;
    anchorOrdinal: number | null;
    sourceSessionId: string | null;
}

export type UnifiedSearchResult =
    | MemorySearchResult
    | AntiMemorySearchResult
    | MessageSearchResult
    | CompartmentSearchResult
    | GitCommitSearchResult
    | PrimerSearchResult
    | NoteSearchResult;

export { ID_SHAPED_QUERY_MAX_TOKENS, parseIdShapedQuery } from "./search-bounds";

function normalizeCosineScore(score: number): number {
    if (!Number.isFinite(score)) {
        return 0;
    }

    return Math.min(1, Math.max(0, score));
}

function previewText(text: string): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.length <= RESULT_PREVIEW_LIMIT) {
        return normalized;
    }
    return `${normalized.slice(0, RESULT_PREVIEW_LIMIT - 1).trimEnd()}…`;
}

interface SearchWorkspaceContext {
    identities: string[];
    expandedIdentities: string[];
    ownIdentities: string[];
    shareCategories: string[] | null;
    namesByIdentity: Map<string, string>;
    canonicalIdentityByStoredPath: Map<string, string>;
    isWorkspaced: boolean;
}

function resolveSearchWorkspaceContext(
    db: Database,
    projectPath: string,
    identitySet?: WorkspaceIdentitySet,
): SearchWorkspaceContext {
    const resolved = identitySet ?? resolveWorkspaceIdentitySet(db, projectPath);
    const isWorkspaced = resolved.identities.length > 1;
    const expanded = expandWorkspaceIdentitySetWithAliases(db, resolved.identities);
    const expandedIdentities = isWorkspaced ? expanded.expandedIdentities : resolved.identities;
    const canonicalIdentityByStoredPath = isWorkspaced
        ? expanded.canonicalIdentityByStoredPath
        : new Map(resolved.identities.map((identity) => [identity, identity]));
    const ownIdentities = expandedIdentities.filter(
        (identity) => canonicalIdentityByStoredPath.get(identity) === projectPath,
    );
    return {
        identities: resolved.identities,
        expandedIdentities,
        ownIdentities,
        shareCategories: isWorkspaced ? resolveWorkspaceShareCategories(db, projectPath) : null,
        namesByIdentity: resolved.namesByIdentity,
        canonicalIdentityByStoredPath,
        isWorkspaced,
    };
}

function getMessageSearchStatement(db: Database): PreparedStatement {
    let stmt = messageSearchStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT message_ordinal AS messageOrdinal, message_id AS messageId, role, ${MESSAGE_FRAGMENT_SQL} FROM message_history_fts WHERE session_id = ? AND message_history_fts MATCH ? ORDER BY bm25(message_history_fts), CAST(message_ordinal AS INTEGER) ASC LIMIT ?`,
        );
        messageSearchStatements.set(db, stmt);
    }
    return stmt;
}

/**
 * Cutoff-aware variant: filters `message_ordinal <= cutoff` IN SQL, BEFORE the
 * LIMIT. The JS-side post-filter in runMessageFtsQuery applies the cutoff AFTER
 * fetching `LIMIT` rows, so when the top-ranked rows are all live-tail (above the
 * cutoff) they're fetched-then-discarded and older eligible hits below the limit
 * are never seen — explicit ctx_search could then return nothing. Pushing the
 * predicate into SQL makes LIMIT count only already-eligible rows.
 */
function getMessageSearchStatementWithCutoff(db: Database): PreparedStatement {
    let stmt = messageSearchStatementsWithCutoff.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT message_ordinal AS messageOrdinal, message_id AS messageId, role, ${MESSAGE_FRAGMENT_SQL} FROM message_history_fts WHERE session_id = ? AND message_history_fts MATCH ? AND CAST(message_ordinal AS INTEGER) <= ? ORDER BY bm25(message_history_fts), CAST(message_ordinal AS INTEGER) ASC LIMIT ?`,
        );
        messageSearchStatementsWithCutoff.set(db, stmt);
    }
    return stmt;
}

function getBatchedFtsCountStatement(
    db: Database,
    queryCount: number,
    cutoff: number | null,
): PreparedStatement {
    let statements = batchedFtsCountStatements.get(db);
    if (!statements) {
        statements = new Map();
        batchedFtsCountStatements.set(db, statements);
    }
    const key = `${queryCount}:${cutoff === null ? "all" : "cutoff"}`;
    let statement = statements.get(key);
    if (!statement) {
        const cutoffSql = cutoff === null ? "" : " AND CAST(message_ordinal AS INTEGER) <= ?";
        statement = db.prepare(
            Array.from(
                { length: queryCount },
                (_, index) =>
                    `SELECT ${index} AS queryIndex, COUNT(*) AS count
                       FROM message_history_fts
                      WHERE session_id = ? AND message_history_fts MATCH ?${cutoffSql}`,
            ).join("\nUNION ALL\n"),
        );
        statements.set(key, statement);
    }
    return statement;
}

/** Read all per-probe document frequencies in one SQLite statement. */
function countSessionFtsMatchesBatch(
    db: Database,
    sessionId: string,
    ftsQueries: readonly string[],
    cutoff: number | null,
): number[] {
    if (ftsQueries.length === 0) return [];
    const bindings: unknown[] = [];
    for (const query of ftsQueries) {
        bindings.push(sessionId, query);
        if (cutoff !== null) bindings.push(cutoff);
    }
    try {
        const rows = getBatchedFtsCountStatement(db, ftsQueries.length, cutoff).all(
            ...bindings,
        ) as BatchedFtsCountRow[];
        const counts = Array.from({ length: ftsQueries.length }, () => 0);
        for (const row of rows) {
            if (
                typeof row.queryIndex === "number" &&
                row.queryIndex >= 0 &&
                row.queryIndex < counts.length &&
                typeof row.count === "number"
            ) {
                counts[row.queryIndex] = row.count;
            }
        }
        return counts;
    } catch {
        // Malformed FTS syntax that survived sanitization is non-discriminative.
        return Array.from({ length: ftsQueries.length }, () => 0);
    }
}

function getMessageOrdinal(value: number | string | undefined): number | null {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    if (typeof value === "string" && value.trim().length > 0) {
        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) ? parsed : null;
    }

    return null;
}

/** Linear decay message scoring.
 *
 * The old formula (1 / (rank+1)) collapsed quickly: rank-0 = 1.0, rank-1 = 0.5,
 * rank-2 = 0.33, rank-5 = 0.17. In practice only the #1 message hit could
 * compete with boosted memories, so all secondary message matches got buried.
 *
 * Linear decay (1 - rank/limit) keeps signal across the returned window:
 * rank-0 = 1.0, rank-1 = 0.9, rank-2 = 0.8, rank-9 = 0.1. Combined with the
 * bumped MESSAGE_SOURCE_BOOST this lets raw-history hits actually compete. */
function linearDecayScore(rank: number, total: number): number {
    if (total <= 0) return 0;
    return Math.max(0, 1 - rank / total);
}

interface NormalizedMessageRow {
    messageOrdinal: number;
    messageId: string;
    role: string;
    /** Bounded FTS fragment (R34), not the full body. */
    fragment: string;
    /** Full-body verbatim containment per sanitized probe, parallel to the
     *  probe list passed to the query (empty on the single-query path). */
    verbatim: boolean[];
}

/** Convert one FTS row into the validated shape consumed by message ranking. */
function normalizeMessageSearchRow(
    row: MessageSearchRow,
    cutoff: number | null,
    probeCount: number,
): NormalizedMessageRow | null {
    const messageOrdinal = getMessageOrdinal(row.messageOrdinal);
    if (
        messageOrdinal === null ||
        typeof row.messageId !== "string" ||
        typeof row.role !== "string" ||
        typeof row.fragment !== "string"
    ) {
        return null;
    }
    // Defense-in-depth: every SQL path applies the cutoff before LIMIT.
    if (cutoff !== null && messageOrdinal > cutoff) return null;
    return {
        messageOrdinal,
        messageId: row.messageId,
        role: row.role,
        fragment: row.fragment,
        verbatim: Array.from({ length: probeCount }, (_, index) =>
            Boolean(Number(row[`verbatim${index}`] ?? 0)),
        ),
    };
}

/** Run one FTS query and return ordinal-cutoff-filtered, validated rows in
 * bm25 rank order. `ftsQuery` must already be sanitized. */
function runMessageFtsQuery(
    db: Database,
    sessionId: string,
    ftsQuery: string,
    fetchLimit: number,
    cutoff: number | null,
): NormalizedMessageRow[] {
    if (ftsQuery.length === 0) return [];
    // Apply the ordinal cutoff IN SQL (before LIMIT) so live-tail matches can't
    // crowd out older eligible hits; null cutoff keeps the original statement.
    const rows = (
        cutoff !== null
            ? getMessageSearchStatementWithCutoff(db).all(sessionId, ftsQuery, cutoff, fetchLimit)
            : getMessageSearchStatement(db).all(sessionId, ftsQuery, fetchLimit)
    ).map((row) => row as MessageSearchRow);

    const result: NormalizedMessageRow[] = [];
    for (const row of rows) {
        const normalized = normalizeMessageSearchRow(row, cutoff, 0);
        if (normalized) result.push(normalized);
    }
    return result;
}

function getBatchedMessageSearchStatement(
    db: Database,
    queryCount: number,
    cutoff: number | null,
    probeCount: number,
): PreparedStatement {
    let statements = batchedMessageSearchStatements.get(db);
    if (!statements) {
        statements = new Map();
        batchedMessageSearchStatements.set(db, statements);
    }
    const key = `${queryCount}:${cutoff === null ? "all" : "cutoff"}:${probeCount}`;
    let statement = statements.get(key);
    if (!statement) {
        const cutoffSql = cutoff === null ? "" : " AND CAST(message_ordinal AS INTEGER) <= ?";
        const branches = Array.from(
            { length: queryCount },
            (_, index) => `SELECT * FROM (
                SELECT ${index} AS queryIndex,
                       message_ordinal AS messageOrdinal,
                       message_id AS messageId,
                       role,
                       ${MESSAGE_FRAGMENT_SQL}${verbatimFlagSql(probeCount)},
                       bm25(message_history_fts) AS ftsRank
                  FROM message_history_fts
                 WHERE session_id = ? AND message_history_fts MATCH ?${cutoffSql}
                 ORDER BY ftsRank
                 LIMIT ?
            )`,
        );
        statement = db.prepare(
            `${branches.join("\nUNION ALL\n")}\nORDER BY queryIndex ASC, ftsRank ASC`,
        );
        statements.set(key, statement);
    }
    return statement;
}

/** Run all base/probe result queries as one compound SQLite statement.
 *  `lowercasedProbes` drive the KTD2 full-body verbatim flags. */
function runMessageFtsQueriesBatch(
    db: Database,
    sessionId: string,
    ftsQueries: readonly string[],
    fetchLimit: number,
    cutoff: number | null,
    lowercasedProbes: readonly string[],
): NormalizedMessageRow[][] {
    if (ftsQueries.length === 0) return [];
    const bindings: unknown[] = [];
    for (const query of ftsQueries) {
        // Parameter order follows appearance in the SQL text: the select-list
        // verbatim flags bind before the WHERE clause and LIMIT.
        bindings.push(...lowercasedProbes);
        bindings.push(sessionId, query);
        if (cutoff !== null) bindings.push(cutoff);
        bindings.push(fetchLimit);
    }
    const rows = getBatchedMessageSearchStatement(
        db,
        ftsQueries.length,
        cutoff,
        lowercasedProbes.length,
    ).all(...bindings) as BatchedMessageSearchRow[];
    const result = Array.from({ length: ftsQueries.length }, () => [] as NormalizedMessageRow[]);
    for (const row of rows) {
        if (
            typeof row.queryIndex !== "number" ||
            row.queryIndex < 0 ||
            row.queryIndex >= result.length
        ) {
            continue;
        }
        const normalized = normalizeMessageSearchRow(row, cutoff, lowercasedProbes.length);
        if (normalized) result[row.queryIndex].push(normalized);
    }
    return result;
}

// Reciprocal-rank-fusion constant. 60 is the canonical RRF k; it dampens the
// reward gap between rank-0 and rank-1 so a candidate that appears in several
// probe lists outranks one that tops a single list.
const RRF_K = 60;
// Verbatim containment is worth one extra rank-0 list appearance — the same
// 1/RRF_K currency as the fused lists. The previous flat +0.5 bonus lived 30×
// above the RRF scale (max list contribution is 1/60 ≈ 0.017), so every
// verbatim hit saturated; after divide-by-max normalization all scores
// flattened into a ~0.95–1.0 band, and at the unified layer those ~1.0 scores
// × MESSAGE_SOURCE_BOOST crowded every memory hit out of the result set.
const VERBATIM_RANK_BONUS = 1 / RRF_K;
// Probe discrimination weighting: a probe matching a large share of the
// session's corpus (common acronyms, generic identifiers) carries near-zero
// signal — bm25 over a single common term is nearly flat, so its ranked list
// is noise. Weight each probe list (and its verbatim bonus) by a smooth
// document-frequency falloff: w = 1 / (1 + IDF_FALLOFF · df/N).
// df/N = 0.1% → 0.91, 1% → 0.50, 2% → 0.33, 10% → 0.09.
const IDF_FALLOFF = 100;

/** Smooth document-frequency weight for one probe within a session corpus. */
function probeDiscriminationWeight(df: number, corpusSize: number): number {
    if (corpusSize <= 0 || df <= 0) return 1;
    return 1 / (1 + (IDF_FALLOFF * df) / corpusSize);
}

function searchMessages(args: {
    db: Database;
    sessionId: string;
    query: string;
    limit: number;
    /** Only return messages with ordinal ≤ this value. Omit or -1 to search all indexed messages. */
    maxOrdinal?: number;
    /** Literal probes to additionally query (multi-probe recall). Empty = the
     * original single-query behavior (unchanged for NL queries / hot path). */
    probes?: string[];
}): MessageSearchResult[] {
    const cutoff = args.maxOrdinal != null && args.maxOrdinal >= 0 ? args.maxOrdinal : null;
    // Overfetch covers post-cutoff attrition, but each FTS branch's LIMIT
    // binding stays within the shared lane ceiling regardless of the caller's
    // (already tier-multiplied) limit.
    const fetchLimit =
        args.maxOrdinal != null && args.maxOrdinal >= 0
            ? Math.min(args.limit * 3, MAX_LANE_CANDIDATES)
            : Math.min(args.limit, MAX_LANE_CANDIDATES);

    const baseQuery = sanitizeFtsQuery(args.query.trim());
    const probes = args.probes ?? [];

    // No probes → original single-query path, byte-identical scoring. This is
    // the hot path (auto-search) and every plain natural-language query.
    if (probes.length === 0) {
        const filtered = runMessageFtsQuery(
            args.db,
            args.sessionId,
            baseQuery,
            fetchLimit,
            cutoff,
        ).slice(0, args.limit);
        return filtered.map((row, rank) => ({
            source: "message" as const,
            content: previewText(row.fragment),
            score: linearDecayScore(rank, filtered.length),
            messageOrdinal: row.messageOrdinal,
            messageId: row.messageId,
            role: row.role,
        }));
    }

    // Multi-probe: run the full query plus every literal probe as separate FTS
    // rankings, but batch each phase into one compound SQLite statement. This
    // preserves independent bm25 ranks while avoiding statement amplification.
    const sanitizedProbes = probes
        .map((probe) => ({ probe, query: sanitizeFtsQuery(probe) }))
        .filter((entry) => entry.query.length > 0);
    const corpusSize = getIndexedMessageCorpusSize(args.db, args.sessionId, cutoff);
    const probeCounts = countSessionFtsMatchesBatch(
        args.db,
        args.sessionId,
        sanitizedProbes.map((entry) => entry.query),
        cutoff,
    );
    const searchQueries = [
        ...(baseQuery.length > 0 ? [baseQuery] : []),
        ...sanitizedProbes.map((entry) => entry.query),
    ];
    const rowsByQuery = runMessageFtsQueriesBatch(
        args.db,
        args.sessionId,
        searchQueries,
        fetchLimit,
        cutoff,
        sanitizedProbes.map((entry) => entry.probe.toLowerCase()),
    );

    const queryLists: Array<{ rows: NormalizedMessageRow[]; weight: number }> = [];
    let queryIndex = 0;
    if (baseQuery.length > 0) {
        queryLists.push({
            rows: rowsByQuery[queryIndex] ?? [],
            // The full query is AND-joined and inherently discriminative.
            weight: 1,
        });
        queryIndex += 1;
    }
    const probeWeightByIndex: number[] = [];
    sanitizedProbes.forEach((_entry, probeIndex) => {
        const weight = probeDiscriminationWeight(probeCounts[probeIndex] ?? 0, corpusSize);
        probeWeightByIndex.push(weight);
        queryLists.push({ rows: rowsByQuery[queryIndex] ?? [], weight });
        queryIndex += 1;
    });

    const fused = new Map<string, { row: NormalizedMessageRow; score: number }>();
    for (const list of queryLists) {
        list.rows.forEach((row, rank) => {
            const rrf = list.weight / (RRF_K + rank);
            const existing = fused.get(row.messageId);
            if (existing) {
                existing.score += rrf;
            } else {
                fused.set(row.messageId, { row, score: rrf });
            }
        });
    }

    // Verbatim boost: a message that literally contains a probe is exactly what
    // a symbol/command lookup wants surfaced first. Worth one rank-0 appearance
    // of the BEST (most discriminative) matching probe — rank-domain currency,
    // so it reorders within the band instead of saturating the scale.
    // Flags cover sanitized probes only: an unsanitized probe carries weight 0
    // and can never win.
    for (const entry of fused.values()) {
        let best = 0;
        entry.row.verbatim.forEach((matched, probeIndex) => {
            const weight = probeWeightByIndex[probeIndex] ?? 0;
            if (matched && weight > best) {
                best = weight;
            }
        });
        if (best > 0) {
            entry.score += best * VERBATIM_RANK_BONUS;
        }
    }

    const ranked = [...fused.values()]
        .sort((a, b) =>
            b.score !== a.score ? b.score - a.score : a.row.messageOrdinal - b.row.messageOrdinal,
        )
        .slice(0, args.limit);

    // Map fused RRF scores into the same linear 0..1 band the single-query path
    // emits (linearDecayScore), so the unified ranker sees comparable scales
    // from both message paths and source boosts behave consistently. Rank is
    // what RRF actually determines; the band keeps cross-source comparability.
    return ranked.map((entry, rank) => ({
        source: "message" as const,
        content: previewText(entry.row.fragment),
        score: linearDecayScore(rank, ranked.length),
        messageOrdinal: entry.row.messageOrdinal,
        messageId: entry.row.messageId,
        role: entry.row.role,
    }));
}

function noteSearchText(note: Note): string {
    const reason = note.readyReason?.trim();
    return reason
        ? `${note.content}
Reason: ${reason}`
        : note.content;
}

function tokenizeKeywordNeedle(text: string): string[] {
    const matches = text.toLowerCase().match(/[a-z0-9/._:-]+/g) ?? [];
    const seen = new Set<string>();
    const tokens: string[] = [];
    for (const match of matches) {
        if (match.length <= 1 || !/[a-z0-9]/.test(match) || seen.has(match)) {
            continue;
        }
        seen.add(match);
        tokens.push(match);
    }
    return tokens;
}

async function searchAntiMemories(args: {
    db: Database;
    projectPath: string;
    query: string;
    limit: number;
    surface: "auto_search" | "explicit_search";
    queryEmbedding: Float32Array | null;
    embedPassages: (
        texts: string[],
        signal?: AbortSignal,
        purpose?: EmbeddingPurpose,
    ) => Promise<(Float32Array | null)[]>;
    signal?: AbortSignal;
}): Promise<AntiMemorySearchResult[]> {
    const workspace = resolveSearchWorkspaceContext(args.db, args.projectPath);
    const projectIds = resolveProjectIdsForIdentities(
        args.db,
        workspace.isWorkspaced ? workspace.expandedIdentities : [args.projectPath],
    );
    if (projectIds.length === 0) return [];
    const ownProjectIds = resolveProjectIdsForIdentities(
        args.db,
        workspace.isWorkspaced ? workspace.ownIdentities : [args.projectPath],
    );
    // Bounded candidate listing first: hydrating current state for the whole
    // project claim set just to keep the anti-memory category would make this
    // per-prompt lane O(all active claims). The id list is capped like every
    // sibling lane and scopes the provider read below to anti-memory claims.
    //
    // Listed from the caller's own projects, not the expanded workspace set.
    // Anti-memory records are written `sharing: "private"`, so a co-member's
    // warning can never clear the authorization step below — including it here
    // would let newer foreign rows consume the ceiling and then be dropped,
    // hiding the caller's own warnings behind claims they can never see.
    const candidateIds = listActiveAntiMemoryPublicIds(
        args.db,
        ownProjectIds,
        MAX_LANE_CANDIDATES,
        Date.now(),
    );
    if (candidateIds.length === 0) return [];
    // One closure = one authorization/surface/lifecycle setting, shared by the
    // hydration read and the post-embedding recheck below, so the two reads
    // cannot drift: the provider stays the single authority on visibility.
    const readAntiMemoryState = (publicClaimIds: readonly string[]) => {
        const result = readProjectMemoryCurrentState(args.db, {
            publicClaimIds: [...publicClaimIds],
            projectIds,
            workspaceAuthorization: {
                ownProjectIds,
                sharedCategories: workspace.shareCategories ?? [],
            },
            workspaceEpoch: computeWorkspaceEpochFingerprint(args.db, workspace.identities),
            workspaceIdentities: workspace.identities,
            surface: "explicit_search",
            lifecycleStates: ["active"],
        });
        return result.status === "ok"
            ? result.items.filter((item) => item.category === ANTI_MEMORY_CATEGORY)
            : null;
    };
    // The state read uses the explicit-search surface (the only surface whose
    // candidate query includes anti-memory), so the automatic-surface policy
    // gates are applied here. A projection written under a newer policy version
    // fails closed — its stored bits are not trustworthy — and anything below
    // the automatic eligibility bar (effective VERIFIED+ with a present,
    // supported policy subject) must not be auto-injected into user prompts.
    // Dispositions are re-checked from the authoritative facts because the
    // projection can lag a policy-unaware writer.
    const eligibleForSurface = (item: ProjectMemoryClaimSnapshot): boolean => {
        if (args.surface !== "auto_search") return true;
        if (item.policy.policyVersion > CLAIM_POLICY_VERSION) return false;
        if (!item.policy.autoEligible) return false;
        return !(
            item.dispositions.stale ||
            item.dispositions.disputed ||
            item.dispositions.superseded
        );
    };
    const antiMemoryItems = readAntiMemoryState(candidateIds);
    if (antiMemoryItems === null) return [];
    const records = readAntiMemories(
        args.db,
        antiMemoryItems.map((item) => item.publicClaimId),
    );
    const normalizedQuery = args.query.trim().toLowerCase();
    const queryTokens = tokenizeKeywordNeedle(normalizedQuery);
    const candidates: Array<{
        result: Omit<AntiMemorySearchResult, "score" | "matchType">;
        text: string;
        lexicalScore: number | null;
    }> = [];
    for (const item of antiMemoryItems) {
        if (!eligibleForSurface(item)) continue;
        const record = records.get(item.publicClaimId);
        if (record === undefined) continue;
        // Match against payload values only. The rendered `record.content`
        // carries constant field labels ("Rejected strategy", "Root cause",
        // …) whose tokens would let unrelated prompts match every record.
        const text = [
            record.payload.trigger,
            record.payload.rejectedStrategy,
            record.payload.rejectionReason,
            record.payload.saferAlternative,
            record.payload.preconditions,
            record.payload.attemptedApproach,
            record.payload.observedFailure,
            record.payload.rootCause,
            record.payload.recovery,
            record.payload.nonApplicableWhen,
        ]
            .filter((value): value is string => value !== null)
            .join("\n")
            .toLowerCase();
        const exact = text.includes(normalizedQuery);
        const textTokens = new Set(tokenizeKeywordNeedle(text));
        const matched = queryTokens.filter((token) => textTokens.has(token)).length;
        const coverage = queryTokens.length === 0 ? 0 : matched / queryTokens.length;
        const lexicalScore =
            exact || (matched > 0 && (queryTokens.length <= 1 || matched >= 2))
                ? exact
                    ? 1
                    : 0.5 + coverage / 2
                : null;
        const result: Omit<AntiMemorySearchResult, "score" | "matchType"> = {
            source: "anti_memory",
            publicClaimId: record.publicClaimId,
            revisionLocator: record.revisionLocator,
            contentDigest: record.contentDigest,
            claimId: record.claimId,
            normalizedHash: record.normalizedHash,
            trigger: record.payload.trigger,
            rejectedStrategy: record.payload.rejectedStrategy,
            rejectionReason: record.payload.rejectionReason,
            saferAlternative: record.payload.saferAlternative,
            ...(item.explicitLabel === null ? {} : { policyLabel: item.explicitLabel }),
        };
        candidates.push({ result, text, lexicalScore });
    }

    // The embedding batch is a live provider call on the per-prompt path, so
    // it is capped independently of the candidate ceiling: lexically matched
    // candidates first (strongest score first), then the newest remaining
    // records. State items arrive ordered by ascending claim id, so a higher
    // candidate index means a newer record.
    const semanticQueryEmbedding = args.surface === "auto_search" ? args.queryEmbedding : null;
    const embedIndices =
        semanticQueryEmbedding && candidates.length > 0
            ? candidates
                  .map((_, index) => index)
                  .sort((left, right) => {
                      const leftScore = candidates[left].lexicalScore;
                      const rightScore = candidates[right].lexicalScore;
                      if ((leftScore !== null) !== (rightScore !== null)) {
                          return leftScore !== null ? -1 : 1;
                      }
                      if (leftScore !== null && rightScore !== null && leftScore !== rightScore) {
                          return rightScore - leftScore;
                      }
                      return right - left;
                  })
                  .slice(0, ANTI_MEMORY_MAX_SEMANTIC_CANDIDATES)
            : [];
    const vectorByCandidate = new Map<number, Float32Array | null>();
    const awaitedEmbedding = Boolean(semanticQueryEmbedding) && embedIndices.length > 0;
    if (semanticQueryEmbedding && embedIndices.length > 0) {
        const vectors = await args
            .embedPassages(
                embedIndices.map((index) => candidates[index].text),
                args.signal,
                "passage",
            )
            .catch((error) => {
                log(
                    `[search] anti-memory embedding failed: ${error instanceof Error ? error.message : String(error)}`,
                );
                return [];
            });
        embedIndices.forEach((candidateIndex, vectorIndex) => {
            vectorByCandidate.set(candidateIndex, vectors[vectorIndex] ?? null);
        });
    }
    const ranked: AntiMemorySearchResult[] = [];
    for (const [index, candidate] of candidates.entries()) {
        const vector = vectorByCandidate.get(index) ?? null;
        const semanticScore =
            semanticQueryEmbedding && vector
                ? normalizeCosineScore(cosineSimilarity(semanticQueryEmbedding, vector))
                : 0;
        const semanticMatch = semanticScore >= ANTI_MEMORY_SEMANTIC_THRESHOLD;
        if (candidate.lexicalScore === null && !semanticMatch) continue;
        const semanticWins = semanticMatch && semanticScore > (candidate.lexicalScore ?? 0);
        ranked.push({
            ...candidate.result,
            // A cosine score below the threshold is noise, not evidence. Folding
            // it into the score through `Math.max` would let an unrelated
            // passage outrank a genuine lexical hit while still reporting
            // `matchType: "lexical"`, so only a threshold-clearing score ranks.
            score: semanticMatch
                ? Math.max(candidate.lexicalScore ?? 0, semanticScore)
                : (candidate.lexicalScore ?? 0),
            matchType: semanticWins ? "semantic" : "lexical",
        });
    }
    const published = ranked
        .sort(
            (left, right) =>
                right.score - left.score || left.publicClaimId.localeCompare(right.publicClaimId),
        )
        .slice(0, args.limit);
    // Revalidate before publishing, but only when the passage embedding above
    // actually awaited: candidates were hydrated before a live provider call
    // that can take seconds, and under WAL another process can retire, revise,
    // expire, or quarantine a warning inside that window. The lexical-only path
    // never yields, so its snapshot is still the one it read.
    if (published.length === 0 || !awaitedEmbedding) return published;
    const current = readAntiMemoryState(published.map((result) => result.publicClaimId));
    if (current === null) return [];
    const currentById = new Map(current.map((item) => [item.publicClaimId, item]));
    return published.filter((result) => {
        const item = currentById.get(result.publicClaimId);
        // Absent means archived, expired, or no longer visible; a moved locator
        // or digest means the payload copied above is pre-transition content.
        if (item === undefined) return false;
        if (item.revisionLocator !== result.revisionLocator) return false;
        if (item.contentDigest !== result.contentDigest) return false;
        return eligibleForSurface(item);
    });
}

interface RankedNoteMatch {
    note: Note;
    score: number;
    text: string;
}

function rankNotesForNeedle(notes: readonly Note[], needle: string): RankedNoteMatch[] {
    const normalizedNeedle = needle.trim().toLowerCase();
    if (normalizedNeedle.length === 0) {
        return [];
    }
    const needleTokens = tokenizeKeywordNeedle(normalizedNeedle);
    const ranked: RankedNoteMatch[] = [];
    for (const note of notes) {
        const text = noteSearchText(note);
        const normalizedText = text.toLowerCase();
        const noteTokens = new Set(tokenizeKeywordNeedle(normalizedText));
        const exact = normalizedText.includes(normalizedNeedle);
        const matchedTokens = needleTokens.filter((token) => noteTokens.has(token)).length;
        if (!exact && matchedTokens === 0) {
            continue;
        }
        const coverage = needleTokens.length > 0 ? matchedTokens / needleTokens.length : 0;
        const score =
            (exact ? 2 : 0) +
            coverage +
            (needleTokens.length > 1 && matchedTokens === needleTokens.length ? 0.5 : 0);
        ranked.push({ note, score, text });
    }
    return ranked.sort((left, right) => {
        if (right.score !== left.score) {
            return right.score - left.score;
        }
        if (right.note.createdAt !== left.note.createdAt) {
            return right.note.createdAt - left.note.createdAt;
        }
        return left.note.id - right.note.id;
    });
}

/** FTS5's trigram tokenizer cannot represent an atom shorter than this. */
const NOTE_FTS_MIN_ATOM_LENGTH = 3;

/**
 * The OR-joined trigram query covering the atoms `rankNotesForNeedle` scores:
 * the whole needle (its exact-substring test) and each keyword token (its
 * coverage test). Substring matching makes the result a superset of the
 * scored matches for every representable atom, so pruning cannot drop a note
 * the scorer would keep through those atoms.
 *
 * Atoms below the trigram minimum are dropped from the query rather than
 * disabling it: "how to deploy sentinel" must still select older notes
 * containing "deploy sentinel" even though "to" cannot be represented. The
 * only recall cost is a note matching NOTHING but unrepresentable short
 * tokens — the weakest possible hit — which is reachable only through the
 * recency window. Returns null when no atom is representable (the caller
 * falls back to that window), and "" for an empty needle, which the scorer
 * never matches.
 */
function noteFtsQueryForNeedle(needle: string): string | null {
    const normalized = needle.trim().toLowerCase();
    if (normalized.length === 0) return "";
    const atoms = [normalized, ...tokenizeKeywordNeedle(normalized)].filter(
        (atom) => atom.length >= NOTE_FTS_MIN_ATOM_LENGTH,
    );
    if (atoms.length === 0) return null;
    return atoms.map((atom) => `"${atom.replace(/"/g, '""')}"`).join(" OR ");
}

/** The fused pool caps at MAX_LANE_CANDIDATES so scoring work stays bounded
 *  even when many needles each fill their branch. */
function loadNoteSearchCorpus(args: {
    db: Database;
    sessionId: string;
    projectPath: string;
    needles: readonly string[];
}): Note[] {
    const scope = {
        sessionId: args.sessionId,
        projectPath: args.projectPath,
        limit: MAX_LANE_CANDIDATES,
    };
    const queries = args.needles.map(noteFtsQueryForNeedle);
    if (queries.some((query) => query === null)) {
        return getRecentSearchableNotes(args.db, scope);
    }
    const bestRankById = new Map<number, number>();
    for (const query of queries) {
        if (!query) continue;
        const ids = selectNoteCandidateIds(args.db, query, scope);
        if (ids === null) {
            return getRecentSearchableNotes(args.db, scope);
        }
        ids.forEach((id, rank) => {
            const existing = bestRankById.get(id);
            if (existing === undefined || rank < existing) bestRankById.set(id, rank);
        });
    }
    if (bestRankById.size === 0) return [];
    const pooled = [...bestRankById.entries()]
        .sort((left, right) => left[1] - right[1] || left[0] - right[0])
        .slice(0, MAX_LANE_CANDIDATES)
        .map(([id]) => id);
    return getSearchableNotesByIds(args.db, {
        ids: pooled,
        sessionId: args.sessionId,
        projectPath: args.projectPath,
    });
}

/**
 * Corpus-wide document frequency per probe for discrimination weighting. The
 * candidate pool is capped at MAX_LANE_CANDIDATES, so counting a probe's
 * matches inside the pool would clamp df at the cap while the weight's
 * denominator stays corpus-wide — inflating a non-discriminative probe's
 * weight by up to corpus/cap. Probes without an indexed count (unrepresentable
 * atom, absent projection, malformed query) are omitted; the caller falls
 * back to its pool-derived count for those.
 */
function noteProbeDocumentFrequencies(args: {
    db: Database;
    sessionId: string;
    projectPath: string;
    probes: readonly string[];
}): Map<string, number> {
    const frequencies = new Map<string, number>();
    const queryByProbe = new Map<string, string>();
    for (const probe of args.probes) {
        if (queryByProbe.has(probe)) continue;
        const query = noteFtsQueryForNeedle(probe);
        if (query !== null && query.length > 0) queryByProbe.set(probe, query);
    }
    if (queryByProbe.size === 0) return frequencies;
    const countable = [...queryByProbe.entries()];
    const counts = countNoteFtsMatchesBatch(
        args.db,
        countable.map(([, query]) => query),
        { sessionId: args.sessionId, projectPath: args.projectPath },
    );
    if (counts === null) return frequencies;
    countable.forEach(([probe], index) => {
        frequencies.set(probe, counts[index] ?? 0);
    });
    return frequencies;
}

function searchNotes(args: {
    db: Database;
    sessionId: string;
    projectPath: string;
    query: string;
    limit: number;
    probes?: string[];
}): NoteSearchResult[] {
    if (args.limit <= 0) {
        return [];
    }

    const probes = args.probes ?? [];
    // Probe discrimination weighs a probe against the whole scoped corpus, so the
    // denominator comes from an indexed count rather than the hydrated rows.
    const corpusSize = countSearchableNotes(args.db, {
        sessionId: args.sessionId,
        projectPath: args.projectPath,
    });
    if (corpusSize === 0) {
        return [];
    }
    const notes = loadNoteSearchCorpus({
        db: args.db,
        sessionId: args.sessionId,
        projectPath: args.projectPath,
        needles: [args.query, ...probes],
    });
    if (notes.length === 0) {
        return [];
    }

    const baseList = rankNotesForNeedle(notes, args.query);

    if (probes.length === 0) {
        const ranked = baseList.slice(0, args.limit);
        return ranked.map((entry, rank) => ({
            source: "note" as const,
            content: previewText(entry.text),
            score: linearDecayScore(rank, ranked.length),
            noteId: entry.note.id,
            status: entry.note.status,
            createdAt: entry.note.createdAt,
            anchorOrdinal: entry.note.anchorOrdinal,
            sourceSessionId: entry.note.sessionId,
        }));
    }

    const queryLists: Array<{ rows: RankedNoteMatch[]; weight: number }> = [];
    if (baseList.length > 0) {
        queryLists.push({ rows: baseList, weight: 1 });
    }
    const probeFrequencies = noteProbeDocumentFrequencies({
        db: args.db,
        sessionId: args.sessionId,
        projectPath: args.projectPath,
        probes,
    });
    const probeWeights = new Map<string, number>();
    for (const probe of probes) {
        const rows = rankNotesForNeedle(notes, probe);
        if (rows.length === 0) {
            continue;
        }
        const weight = probeDiscriminationWeight(
            probeFrequencies.get(probe) ?? rows.length,
            corpusSize,
        );
        probeWeights.set(probe, weight);
        queryLists.push({ rows, weight });
    }

    const fused = new Map<number, { entry: RankedNoteMatch; score: number }>();
    for (const list of queryLists) {
        list.rows.forEach((row, rank) => {
            const rrf = list.weight / (RRF_K + rank);
            const existing = fused.get(row.note.id);
            if (existing) {
                existing.score += rrf;
            } else {
                fused.set(row.note.id, { entry: row, score: rrf });
            }
        });
    }

    for (const match of fused.values()) {
        let best = 0;
        for (const probe of probes) {
            const weight = probeWeights.get(probe) ?? 0;
            if (weight > best && containsProbeVerbatim(match.entry.text, [probe])) {
                best = weight;
            }
        }
        if (best > 0) {
            match.score += best * VERBATIM_RANK_BONUS;
        }
    }

    const ranked = [...fused.values()]
        .sort((left, right) => {
            if (right.score !== left.score) {
                return right.score - left.score;
            }
            if (right.entry.note.createdAt !== left.entry.note.createdAt) {
                return right.entry.note.createdAt - left.entry.note.createdAt;
            }
            return left.entry.note.id - right.entry.note.id;
        })
        .slice(0, args.limit);

    return ranked.map((entry, rank) => ({
        source: "note" as const,
        content: previewText(entry.entry.text),
        score: linearDecayScore(rank, ranked.length),
        noteId: entry.entry.note.id,
        status: entry.entry.note.status,
        createdAt: entry.entry.note.createdAt,
        anchorOrdinal: entry.entry.note.anchorOrdinal,
        sourceSessionId: entry.entry.note.sessionId,
    }));
}

function searchCompartmentChunks(args: {
    db: Database;
    sessionId: string;
    projectPath: string;
    queryEmbedding: Float32Array | null;
    limit: number;
    maxOrdinal?: number;
    modelId?: string | null;
    onVectorLoad?: VectorLoadObserver;
}): CompartmentSearchResult[] {
    if (!args.queryEmbedding || args.limit <= 0 || !args.modelId || args.modelId === "off")
        return [];
    const cutoff = args.maxOrdinal != null && args.maxOrdinal >= 0 ? args.maxOrdinal : null;
    const rows = loadCompartmentChunkEmbeddingsForSearch(
        args.db,
        args.sessionId,
        args.projectPath,
        args.modelId,
        args.onVectorLoad,
        cutoff,
    );
    if (rows.length === 0) return [];

    const byCompartment = new Map<
        number,
        { row: StoredCompartmentChunkEmbedding; score: number }
    >();
    for (const row of rows) {
        if (cutoff !== null && row.endOrdinal > cutoff) {
            continue;
        }
        const score = normalizeCosineScore(cosineSimilarity(args.queryEmbedding, row.vector));
        if (score <= 0) continue;
        const existing = byCompartment.get(row.compartmentId);
        if (!existing || score > existing.score) {
            byCompartment.set(row.compartmentId, { row, score });
        }
    }

    return [...byCompartment.values()]
        .sort((left, right) =>
            right.score !== left.score
                ? right.score - left.score
                : left.row.startOrdinal - right.row.startOrdinal,
        )
        .slice(0, args.limit)
        .map(({ row, score }) => ({
            source: "compartment" as const,
            content: previewText(row.title),
            score: score * SINGLE_SOURCE_PENALTY,
            compartmentId: row.compartmentId,
            sessionId: row.sessionId,
            title: row.title,
            startOrdinal: row.startOrdinal,
            endOrdinal: row.endOrdinal,
            matchType: "semantic" as const,
        }));
}

/** Assign each message ordinal to its containing compartment with one ordered
 *  interval sweep instead of scanning every compartment range per message.
 *
 *  Assignment order and fusion order are deliberately separate (KTD5): the sweep
 *  walks ordinal-sorted copies, while overlap ties are still resolved by the
 *  compartment's original semantic rank, so a boundary message lands in the
 *  earliest-ranked containing compartment exactly as a rank-ordered scan did.
 *  Returned map keys are the caller's message array indexes. */
export function assignMessagesToCompartments(
    messages: readonly MessageSearchResult[],
    compartments: readonly CompartmentSearchResult[],
): Map<number, CompartmentSearchResult> {
    const assignment = new Map<number, CompartmentSearchResult>();
    if (messages.length === 0 || compartments.length === 0) return assignment;

    const ranges = compartments
        .map((compartment, rank) => ({ compartment, rank }))
        .sort(
            (left, right) =>
                left.compartment.startOrdinal - right.compartment.startOrdinal ||
                left.compartment.endOrdinal - right.compartment.endOrdinal ||
                left.rank - right.rank,
        );
    const ordered = messages
        .map((message, index) => ({ message, index }))
        .sort(
            (left, right) =>
                left.message.messageOrdinal - right.message.messageOrdinal ||
                left.index - right.index,
        );

    // Ranges whose start is already reached and whose end has not been passed.
    // Messages advance monotonically, so a range dropped here can never contain
    // a later ordinal.
    let active: Array<{ compartment: CompartmentSearchResult; rank: number }> = [];
    let cursor = 0;
    for (const { message, index } of ordered) {
        const ordinal = message.messageOrdinal;
        while (cursor < ranges.length && ranges[cursor].compartment.startOrdinal <= ordinal) {
            active.push(ranges[cursor]);
            cursor += 1;
        }
        if (active.length > 0) {
            active = active.filter((entry) => entry.compartment.endOrdinal >= ordinal);
        }
        let best: { compartment: CompartmentSearchResult; rank: number } | null = null;
        for (const entry of active) {
            if (!best || entry.rank < best.rank) best = entry;
        }
        if (best) assignment.set(index, best.compartment);
    }
    return assignment;
}

/** Exported for the KTD1 characterization tests, which differential-check the
 *  interval sweep against a local reference of the former per-message scan. */
export function mergeMessageAndCompartmentResults(args: {
    messages: MessageSearchResult[];
    compartments: CompartmentSearchResult[];
    limit: number;
}): Array<MessageSearchResult | CompartmentSearchResult> {
    if (args.compartments.length === 0) return args.messages;
    if (args.messages.length === 0) return args.compartments;

    const fused = new Map<
        string,
        {
            result: MessageSearchResult | CompartmentSearchResult;
            score: number;
            tieOrdinal: number;
            snippetScore: number;
        }
    >();

    const add = (
        key: string,
        result: MessageSearchResult | CompartmentSearchResult,
        score: number,
        tieOrdinal: number,
    ) => {
        const existing = fused.get(key);
        if (existing) {
            existing.score += score;
            return existing;
        }
        const entry = { result, score, tieOrdinal, snippetScore: -1 };
        fused.set(key, entry);
        return entry;
    };

    args.compartments.forEach((compartment, rank) => {
        add(
            `compartment:${compartment.compartmentId}`,
            compartment,
            1 / (RRF_K + rank),
            compartment.startOrdinal,
        );
    });

    const containingByMessageIndex = assignMessagesToCompartments(args.messages, args.compartments);

    for (const [rank, message] of args.messages.entries()) {
        const containing = containingByMessageIndex.get(rank);
        const contribution = 1 / (RRF_K + rank);
        if (!containing) {
            add(`message:${message.messageId}`, message, contribution, message.messageOrdinal);
            continue;
        }

        const entry = add(
            `compartment:${containing.compartmentId}`,
            containing,
            contribution,
            containing.startOrdinal,
        );
        if (message.score > entry.snippetScore && entry.result.source === "compartment") {
            entry.snippetScore = message.score;
            entry.result = {
                ...entry.result,
                matchType: "hybrid",
                snippet: message.content,
            };
        }
    }

    const ranked = [...fused.values()]
        .sort((left, right) =>
            right.score !== left.score
                ? right.score - left.score
                : left.tieOrdinal - right.tieOrdinal,
        )
        .slice(0, args.limit);

    return ranked.map((entry, rank) => ({
        ...entry.result,
        score: linearDecayScore(rank, ranked.length),
    }));
}

function getSourceBoost(result: UnifiedSearchResult): number {
    switch (result.source) {
        case "memory":
        case "anti_memory":
            return MEMORY_SOURCE_BOOST;
        case "message":
        case "compartment":
            return MESSAGE_SOURCE_BOOST;
        case "git_commit":
            return GIT_COMMIT_SOURCE_BOOST;
        case "primer":
            return PRIMER_SOURCE_BOOST;
        case "note":
            return 1;
    }
}

function compareUnifiedResults(left: UnifiedSearchResult, right: UnifiedSearchResult): number {
    const leftEffective = left.score * getSourceBoost(left);
    const rightEffective = right.score * getSourceBoost(right);

    if (rightEffective !== leftEffective) {
        return rightEffective - leftEffective;
    }

    if (
        (left.source === "memory" || left.source === "anti_memory") &&
        (right.source === "memory" || right.source === "anti_memory")
    ) {
        return left.publicClaimId.localeCompare(right.publicClaimId);
    }

    if (left.source === "message" && right.source === "message") {
        return left.messageOrdinal - right.messageOrdinal;
    }

    if (left.source === "compartment" && right.source === "compartment") {
        return left.startOrdinal - right.startOrdinal;
    }

    if (left.source === "git_commit" && right.source === "git_commit") {
        // Newer commits win ties.
        return right.committedAtMs - left.committedAtMs;
    }

    if (left.source === "primer" && right.source === "primer") {
        return right.support - left.support || left.primerId - right.primerId;
    }

    if (left.source === "note" && right.source === "note") {
        return right.createdAt - left.createdAt || left.noteId - right.noteId;
    }

    return 0;
}

function toGitCommitResult(hit: GitCommitSearchHit): GitCommitSearchResult {
    return {
        source: "git_commit",
        content: previewText(hit.commit.message),
        score: hit.score,
        sha: hit.commit.sha,
        shortSha: hit.commit.shortSha,
        author: hit.commit.author,
        committedAtMs: hit.commit.committedAtMs,
        matchType: hit.matchType,
    };
}

function searchGitCommits(args: {
    db: Database;
    projectPath: string;
    query: string;
    limit: number;
    /** Pre-computed query embedding (or null if embedding is disabled / failed).
     *  unifiedSearch embeds once and passes the same vector here and to
     *  searchMemories — never embed twice for one query. */
    queryEmbedding: Float32Array | null;
    queryModelId?: string | null;
    onVectorLoad?: VectorLoadObserver;
    stages?: HybridLaneStageMarks;
}): GitCommitSearchResult[] {
    if (args.limit <= 0) return [];

    const hits = searchGitCommitsSync(args.db, args.projectPath, args.query, {
        limit: args.limit,
        queryEmbedding: args.queryEmbedding,
        queryModelId: args.queryModelId,
        onVectorLoad: args.onVectorLoad,
        stages: args.stages,
    });
    return hits.map(toGitCommitResult);
}

function primerText(primer: Primer): string {
    const answer = primer.answer.trim();
    return answer ? `Q: ${primer.question}\nA: ${answer}` : `Q: ${primer.question}`;
}

function searchPrimers(args: {
    db: Database;
    projectPath: string;
    query: string;
    limit: number;
    queryEmbedding: Float32Array | null;
    queryModelId: string | null;
    onVectorLoad?: VectorLoadObserver;
    stages?: HybridLaneStageMarks;
}): PrimerSearchResult[] {
    if (args.limit <= 0) return [];
    // Vector phase covers the primer decode plus cosine scoring: the decoded
    // bytes reported through onVectorLoad are exactly this phase's work.
    args.stages?.vectorStart();
    const primers = getActivePrimers(args.db, args.projectPath, args.onVectorLoad);
    const semanticScores = new Map<number, number>();
    for (const primer of primers) {
        if (
            !args.queryEmbedding ||
            !primer.questionEmbedding ||
            primer.questionEmbeddingModelId !== args.queryModelId
        ) {
            continue;
        }
        const score = normalizeCosineScore(
            cosineSimilarity(args.queryEmbedding, primer.questionEmbedding),
        );
        if (score > 0) semanticScores.set(primer.id, score);
    }
    args.stages?.vectorEnd(semanticScores.size);
    if (primers.length === 0) return [];

    args.stages?.lexicalStart();
    const ftsQuery = sanitizeFtsQuery(args.query);
    const ftsRanks = new Map<number, number>();
    if (ftsQuery) {
        const rows = args.db
            .prepare(
                `SELECT p.id AS id, bm25(primers_fts) AS rank
                 FROM primers_fts
                 JOIN primers p ON p.id = primers_fts.rowid
                 WHERE primers_fts MATCH ? AND p.project_path = ? AND p.status = 'active'
                 ORDER BY rank ASC
                 LIMIT ?`,
            )
            .all(
                ftsQuery,
                args.projectPath,
                Math.min(args.limit * 3, MAX_LANE_CANDIDATES),
            ) as Array<{ id: number; rank: number }>;
        rows.forEach((row, index) => {
            ftsRanks.set(row.id, linearDecayScore(index, rows.length));
        });
    }
    args.stages?.lexicalEnd(ftsRanks.size);

    args.stages?.fusionStart();
    const scored = primers
        .map((primer) => {
            const semantic = semanticScores.get(primer.id) ?? 0;
            const fts = ftsRanks.get(primer.id) ?? 0;
            if (semantic <= 0 && fts <= 0) return null;
            const score =
                semantic > 0 && fts > 0
                    ? semantic * SEMANTIC_WEIGHT + fts * FTS_WEIGHT
                    : Math.max(semantic, fts);
            return {
                source: "primer" as const,
                content: previewText(primerText(primer)),
                score,
                primerId: primer.id,
                question: primer.question,
                support: primer.totalSupport,
                lastObservedAt: primer.lastObservedAt,
                matchType: semantic > 0 && fts > 0 ? "hybrid" : semantic > 0 ? "semantic" : "fts",
            } satisfies PrimerSearchResult;
        })
        .filter((result): result is PrimerSearchResult => result !== null)
        .sort((a, b) => b.score - a.score || b.support - a.support || a.primerId - b.primerId)
        .slice(0, args.limit);
    args.stages?.fusionEnd(primers.length, scored.length);
    return scored;
}

function resolveSources(sources: SearchSource[] | undefined): Set<SearchSource> {
    if (sources === undefined) {
        // Default: search all recall sources. Facts are deliberately NOT a
        // source — they're always rendered in <session-history> so searching
        // them returns content the agent already sees.
        return new Set<SearchSource>(["memory", "message", "git_commit", "primer", "note"]);
    }
    const set = new Set<SearchSource>();
    for (const source of sources) {
        if (
            source === "memory" ||
            source === "message" ||
            source === "git_commit" ||
            source === "primer" ||
            source === "note"
        ) {
            set.add(source);
        }
    }
    return set;
}

/**
 * Parse a whole-query exact-locator list: every whitespace-separated token
 * must be a public claim ID (`mcm_<32hex>`) or a full revision locator
 * (`mcm_<32hex>/r<n>/<sha256>`). Returns null for anything else so ordinary
 * text queries fall through to the normal lanes.
 */
export function parseLocatorShapedQuery(query: string): string[] | null {
    const tokens = query
        .trim()
        .split(/[\s,]+/)
        .filter(Boolean);
    if (tokens.length === 0) return null;
    const publicClaimIds: string[] = [];
    for (const token of tokens) {
        if (isValidPublicClaimId(token)) {
            publicClaimIds.push(token);
            continue;
        }
        const locator = parseRevisionLocator(token);
        if (locator === null) return null;
        publicClaimIds.push(locator.publicClaimId);
    }
    return publicClaimIds;
}

/**
 * Exact claim/revision-locator lookup through the current-state provider —
 * the only search path that serves project-memory claims while the retrieval
 * projection is inactive. A revision locator resolves to the claim's CURRENT
 * visible revision. Workspace authorization applies before the limit: a
 * foreign member's claim is visible only when shareable in a shared
 * category, and a nonmember cannot distinguish hidden from missing. Results
 * are revalidated through the same provider after telemetry and immediately
 * before publication, so a claim hidden or revised once the provider's
 * snapshot closed is dropped rather than served. Returns null when nothing
 * resolved so callers fall through to the normal lanes.
 */
export function resolveClaimsByLocatorsForSearch(args: {
    db: Database;
    projectPath: string;
    locators: readonly string[];
    limit: number;
    /** Revision locators already rendered in the injected baseline. */
    visibleRevisionLocators?: ReadonlySet<string> | null;
    /** Bump claim retrieval telemetry (explicit agent lookups). */
    countRetrievals?: boolean;
}): Array<MemorySearchResult | AntiMemorySearchResult> | null {
    if (args.locators.length === 0) return null;
    const publicClaimIds: string[] = [];
    for (const raw of args.locators) {
        if (isValidPublicClaimId(raw)) {
            publicClaimIds.push(raw);
            continue;
        }
        const parsed = parseRevisionLocator(raw);
        if (parsed !== null) publicClaimIds.push(parsed.publicClaimId);
    }
    if (publicClaimIds.length === 0) return null;
    const workspace = resolveSearchWorkspaceContext(args.db, args.projectPath);
    const authorizedIdentities = workspace.isWorkspaced
        ? workspace.expandedIdentities
        : [args.projectPath];
    const authorizedProjectIds = new Set(
        resolveProjectIdsForIdentities(args.db, authorizedIdentities),
    );
    const ownProjectIds = new Set(
        resolveProjectIdsForIdentities(
            args.db,
            workspace.isWorkspaced ? workspace.ownIdentities : [args.projectPath],
        ),
    );
    // One closure = one authorization/surface/lifecycle setting, used by both
    // the hydration read and the pre-publication recheck below. The two reads
    // must not be able to drift: the provider is the single authority that
    // decides visibility, so the recheck asks it the same question rather than
    // reimplementing the policy filter.
    const readVisibleClaims = (): ProjectMemoryClaimSnapshot[] | null => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const result = readProjectMemoryCurrentState(args.db, {
                publicClaimIds: [...new Set(publicClaimIds)],
                projectIds: [...authorizedProjectIds],
                workspaceAuthorization: {
                    ownProjectIds: [...ownProjectIds],
                    sharedCategories: workspace.shareCategories ?? [],
                },
                workspaceEpoch: computeWorkspaceEpochFingerprint(args.db, workspace.identities),
                // Named so the provider recomputes the fingerprint at
                // publication time; without them it echoes the value above into
                // both snapshot vectors and a revocation in flight goes
                // undetected.
                workspaceIdentities: workspace.identities,
                surface: "explicit_search",
                lifecycleStates: ["active", "archived"],
            });
            if (result.status === "ok") return result.items;
        }
        return null;
    };
    const items = readVisibleClaims();
    if (items === null) return null;
    const visible = items;
    const identityByProjectId = readProjectIdentityMap(
        args.db,
        visible.map((item) => item.projectId),
    );
    const ordered: Array<MemorySearchResult | AntiMemorySearchResult> = [];
    for (const item of visible) {
        if (args.visibleRevisionLocators?.has(item.revisionLocator)) continue;
        const identity = identityByProjectId.get(item.projectId);
        const sourceName =
            workspace.isWorkspaced && identity
                ? (sourceNameForMemory(
                      identity,
                      args.projectPath,
                      workspace.identities,
                      workspace.namesByIdentity,
                      workspace.canonicalIdentityByStoredPath,
                  ) ?? undefined)
                : undefined;
        if (item.category === ANTI_MEMORY_CATEGORY) {
            if (item.lifecycleState !== "active") continue;
            const record = readAntiMemory(args.db, item.publicClaimId);
            if (record === null) continue;
            ordered.push({
                source: "anti_memory",
                score: 1,
                publicClaimId: record.publicClaimId,
                revisionLocator: record.revisionLocator,
                contentDigest: record.contentDigest,
                claimId: record.claimId,
                normalizedHash: record.normalizedHash,
                trigger: record.payload.trigger,
                rejectedStrategy: record.payload.rejectedStrategy,
                rejectionReason: record.payload.rejectionReason,
                saferAlternative: record.payload.saferAlternative,
                matchType: "exact",
                ...(item.explicitLabel === null ? {} : { policyLabel: item.explicitLabel }),
            });
        } else
            ordered.push({
                source: "memory",
                content: item.content,
                score: 1,
                publicClaimId: item.publicClaimId,
                revisionLocator: item.revisionLocator,
                category: item.category,
                matchType: "exact",
                ...(sourceName === undefined ? {} : { sourceName }),
                ...(item.explicitLabel === null ? {} : { policyLabel: item.explicitLabel }),
                contentDigest: item.contentDigest,
            });
        if (ordered.length >= args.limit) break;
    }
    if (ordered.length === 0) return null;
    if (args.countRetrievals !== false) {
        recordClaimUsage(args.db, {
            publicClaimIds: ordered
                .filter((result): result is MemorySearchResult => result.source === "memory")
                .map((result) => result.publicClaimId),
            kind: "retrieved",
        });
    }
    // Revalidate through the provider before publishing. The provider proves
    // visibility inside its own snapshot and then CLOSES it, so every byte
    // above was read from state that is already historical here: one
    // connection is cached per path per process, and under WAL another process
    // can take the writer lock, let this process read old committed state, and
    // commit a quarantine, rejection, or revision before this call returns.
    // The telemetry write widens that window — `BEGIN IMMEDIATE` blocks for up
    // to `busy_timeout` behind that writer — but it does not create it, so the
    // recheck runs even when `countRetrievals === false`: publication safety
    // must not depend on whether a counter is enabled.
    const current = readVisibleClaims();
    if (current === null) return null;
    const currentByClaimId = new Map(current.map((item) => [item.publicClaimId, item]));
    // Publish a result only when every field copied out of the snapshot still
    // matches. Absent means hidden or gone; a moved locator, digest, content,
    // category, or evidence label means the claim transitioned under us and
    // the copy above is pre-transition content.
    const confirmed = ordered.filter((result) => {
        const item = currentByClaimId.get(result.publicClaimId);
        if (item === undefined) return false;
        if (
            item.revisionLocator !== result.revisionLocator ||
            item.contentDigest !== result.contentDigest ||
            (item.explicitLabel ?? undefined) !== result.policyLabel
        ) {
            return false;
        }
        // An anti-memory result carries payload fields, not `content`/`category`,
        // so the equality checks above cannot cover it. The read spans
        // `["active", "archived"]` and archiving moves neither the locator nor
        // the digest, so the lifecycle and category gates hydration applied are
        // re-applied here instead; otherwise a warning archived under us is
        // still published.
        if (result.source === "anti_memory") {
            return item.category === ANTI_MEMORY_CATEGORY && item.lifecycleState === "active";
        }
        return item.content === result.content && item.category === result.category;
    });
    // Dropping is the same observable outcome as never resolving: `null` is
    // exactly what a missing or foreign-hidden locator returns, so a caller
    // cannot distinguish "this claim went hidden" from "no such claim".
    if (confirmed.length === 0) return null;
    return confirmed;
}

export async function unifiedSearch(
    db: Database,
    sessionId: string,
    projectPath: string,
    query: string,
    options: UnifiedSearchOptions = {},
): Promise<UnifiedSearchResult[]> {
    const prepared = prepareExplicitQuery(query);
    if (!prepared.ok) {
        throw new QueryBoundsError(prepared);
    }
    const trimmedQuery = prepared.query;
    const measurementStartedAt = Date.now();
    // The trace root precedes depth validation, and both precede the
    // empty-query short-circuit: an invalid candidateDepth must throw for
    // every input, and a supplied sink must see one root span per call —
    // including the call that throws.
    const trace = options.trace ? createSearchTraceRecorder(options.trace) : null;
    const rootSpan = trace?.begin("root", "unified") ?? null;
    let candidateDepth: number | null;
    try {
        candidateDepth = normalizeCandidateDepth(options.candidateDepth);
    } catch (error) {
        rootSpan?.end("failed");
        throw error;
    }
    if (trimmedQuery.length === 0) {
        rootSpan?.end("ok", { candidatesOut: 0 });
        return [];
    }

    try {
        const results = await executeUnifiedSearch({
            db,
            sessionId,
            projectPath,
            trimmedQuery,
            options,
            measurementStartedAt,
            candidateDepth,
            trace,
            rootSpan,
        });
        rootSpan?.end("ok", { candidatesOut: results.length });
        return results;
    } catch (error) {
        rootSpan?.end("failed");
        throw error;
    }
}

async function executeUnifiedSearch(args: {
    db: Database;
    sessionId: string;
    projectPath: string;
    trimmedQuery: string;
    options: UnifiedSearchOptions;
    measurementStartedAt: number;
    candidateDepth: number | null;
    trace: SearchTraceRecorder | null;
    rootSpan: SearchTraceSpanHandle | null;
}): Promise<UnifiedSearchResult[]> {
    const { db, sessionId, projectPath, trimmedQuery, options, trace } = args;
    const rootId = args.rootSpan?.id ?? null;

    const limit = normalizeSearchResultLimit(options.limit);
    const tierLimit =
        args.candidateDepth ??
        Math.min(Math.max(limit * 3, DEFAULT_SEARCH_RESULT_LIMIT), MAX_LANE_CANDIDATES);
    // requestedK and effectiveK are emitted from this one variable, so the
    // candidate-depth assertion over these counters checks plumbing
    // identity only; it cannot see a lane that internally clamped its
    // executed bound. Surfacing per-lane executed bounds is future work.
    const laneDepth = { requestedK: tierLimit, effectiveK: tierLimit };

    const filterSpan = trace?.begin("filter_construction", "unified", { parent: rootId }) ?? null;
    const embeddingEnabled = options.embeddingEnabled ?? true;
    const embedQuery = options.embedQuery ?? embedText;
    const isEmbeddingRuntimeEnabled = options.isEmbeddingRuntimeEnabled ?? isEmbeddingEnabled;
    const gitCommitsEnabled = options.gitCommitsEnabled ?? false;
    const activeSources = resolveSources(options.sources);

    const memoryFeatureEnabled = options.memoryEnabled ?? true;
    const runMessages = activeSources.has("message");
    const runGitCommits = activeSources.has("git_commit") && gitCommitsEnabled;
    const runPrimers = activeSources.has("primer") && memoryFeatureEnabled;
    const runNotes = activeSources.has("note");
    const runAntiMemories = activeSources.has("memory") && memoryFeatureEnabled;
    const runCompartmentChunks = runMessages && memoryFeatureEnabled && embeddingEnabled;
    filterSpan?.end("ok");
    // Downstream chain roots depend on the filter span so criticalPathMs
    // includes filtering cost. Workspace resolution is also filter work,
    // but its synchronous SQLite reads must not run before the embed fetch
    // is dispatched; it gets its own span after the dispatch below.
    const filterDeps = filterSpan ? [filterSpan.id] : [];

    // Embed the query ONCE at the top — both memory and git-commit searches
    // need the same vector. Previously each search called `embedQuery`
    // independently, producing two parallel HTTP requests for the same
    // input text (visible in LMStudio logs as duplicate `/v1/embeddings`
    // entries) which serialized at the model and doubled latency on
    // single-GPU embedding endpoints.
    //
    // We start the embed BEFORE running the synchronous `searchMessages`
    // path. JavaScript evaluates `Promise.all` arguments left-to-right, so
    // any synchronous call inside an arg expression blocks the event loop
    // and prevents in-flight `fetch()` work from being processed by the
    // runtime — even though the request was technically dispatched. On
    // long sessions `searchMessages` can do seconds of indexing work
    // (`ensureMessagesIndexed` walks raw OpenCode session history); doing
    // that BEFORE the embed call meant the embed fetch couldn't start
    // until indexing finished.
    const antiMemorySemanticEnabled =
        runAntiMemories && (options.memoryPolicySurface ?? "explicit_search") === "auto_search";
    const needsEmbedding =
        (runGitCommits || runCompartmentChunks || runPrimers || antiMemorySemanticEnabled) &&
        embeddingEnabled &&
        isEmbeddingRuntimeEnabled();

    const embedSpan =
        trace && needsEmbedding
            ? trace.begin("query_inference", "query", { parent: rootId, dependsOn: filterDeps })
            : null;
    if (trace && !needsEmbedding) {
        trace.notApplicable("query_inference", "query", rootId);
    }
    const queryEmbeddingPromise: Promise<CapturedQueryEmbedding | Float32Array | null> =
        needsEmbedding
            ? embedQuery(trimmedQuery, options.signal, "query").then(
                  (captured) => {
                      embedSpan?.end("ok");
                      return captured;
                  },
                  (error) => {
                      embedSpan?.end(options.signal?.aborted ? "cancelled" : "failed");
                      log(
                          `[search] query embedding failed: ${error instanceof Error ? error.message : String(error)}`,
                      );
                      return null;
                  },
              )
            : Promise.resolve(null);

    // Yield to the event loop so the embed fetch's request gets a chance
    // to be dispatched at the runtime level before we run any synchronous
    // work. This is the crucial line that unblocks the auto-search 3-second
    // delay observed in production: without it, `searchMessages` runs
    // before the embed fetch is processed, and the embedding HTTP request
    // doesn't actually leave the process until we await later.
    await Promise.resolve();

    // Run the synchronous message-FTS SELECT now that the embed fetch is
    // in flight. Message indexing is event-driven and never runs here;
    // unreconciled sessions simply return no message hits until the async
    // first-touch reconciliation finishes.
    // Multi-probe recall is opt-in for explicit searches only. NL queries
    // yield no probes, so this is a no-op for them regardless of the flag.
    const messageProbes = options.explicitSearch ? extractLiteralProbes(trimmedQuery) : [];
    const messageSpan =
        trace && runMessages
            ? trace.begin("lexical_scan", "message", { parent: rootId, dependsOn: filterDeps })
            : null;
    const messageResults: MessageSearchResult[] = runMessages
        ? searchMessages({
              db,
              sessionId,
              query: trimmedQuery,
              limit: tierLimit,
              maxOrdinal: options.maxMessageOrdinal,
              probes: messageProbes,
          })
        : [];
    messageSpan?.end("ok", { candidatesOut: messageResults.length, ...laneDepth });

    // Wait for the single embed call (if any) and then run the two
    // embedding-dependent searches in parallel using the same vector.
    const capturedQuery = await queryEmbeddingPromise;
    const generationSpan =
        trace?.begin("generation_lookup", "query", {
            parent: rootId,
            dependsOn: embedSpan ? [embedSpan.id] : [],
        }) ?? null;
    const embeddingSnapshot = getProjectEmbeddingSnapshot(projectPath);
    const queryContract =
        capturedQuery instanceof Float32Array || capturedQuery === null ? null : capturedQuery;
    const embedPassages =
        options.embedPassages ??
        (async (texts, signal, purpose) => {
            const batch = await embedBatchForProject(projectPath, texts, signal, purpose);
            const expectedGeneration = queryContract?.generation ?? embeddingSnapshot?.generation;
            const expectedModelId = queryContract?.modelId ?? embeddingSnapshot?.modelId;
            return batch &&
                batch.generation === expectedGeneration &&
                batch.modelId === expectedModelId
                ? batch.vectors
                : texts.map(() => null);
        });
    const generationIsCurrent =
        queryContract === null ||
        (embeddingSnapshot !== null && embeddingSnapshot.generation === queryContract.generation);
    const queryEmbedding = generationIsCurrent
        ? (queryContract?.vector ?? (capturedQuery instanceof Float32Array ? capturedQuery : null))
        : null;
    generationSpan?.end("ok");
    // Every semantic lane consumes the generation-gated vector, so a vector
    // scan's causal edge runs through generation_lookup rather than jumping
    // straight to query inference; otherwise the critical path drops the
    // generation check from the semantic pipeline.
    const semanticDeps = generationSpan ? [generationSpan.id] : embedSpan ? [embedSpan.id] : [];
    const embeddingModelId =
        queryContract?.modelId ?? options.embeddingModelIdOverride ?? embeddingSnapshot?.modelId;
    const chunkModelId =
        queryContract?.chunkModelId ??
        options.chunkModelIdOverride ??
        embeddingSnapshot?.chunkModelId;
    const laneSpanIds: number[] = [];
    const antiMemorySpan =
        trace && runAntiMemories
            ? trace.begin("fusion", "memory", {
                  parent: rootId,
                  dependsOn: [...filterDeps, ...semanticDeps],
              })
            : null;
    if (trace && !runAntiMemories) trace.notApplicable("fusion", "memory", rootId);
    const antiMemoryPromise: Promise<AntiMemorySearchResult[]> = runAntiMemories
        ? searchAntiMemories({
              db,
              projectPath,
              query: trimmedQuery,
              limit: tierLimit,
              surface: options.memoryPolicySurface ?? "explicit_search",
              queryEmbedding,
              embedPassages,
              signal: options.signal,
          }).then(
              (results) => {
                  if (antiMemorySpan) {
                      laneSpanIds.push(antiMemorySpan.id);
                      antiMemorySpan.end("ok", {
                          candidatesOut: results.length,
                          ...laneDepth,
                      });
                  }
                  return results;
              },
              (error) => {
                  antiMemorySpan?.end(options.signal?.aborted ? "cancelled" : "failed");
                  throw error;
              },
          )
        : Promise.resolve([]);
    let compartmentLoad: VectorLoadEvent | null = null;
    const compartmentSpan =
        trace && runCompartmentChunks
            ? trace.begin("vector_scan", "compartment", {
                  parent: rootId,
                  dependsOn: semanticDeps,
              })
            : null;
    const compartmentResults = runCompartmentChunks
        ? searchCompartmentChunks({
              db,
              sessionId,
              projectPath,
              queryEmbedding,
              limit: tierLimit,
              maxOrdinal: options.maxMessageOrdinal,
              modelId: chunkModelId && chunkModelId !== "off" ? chunkModelId : null,
              onVectorLoad: compartmentSpan
                  ? (event) => {
                        compartmentLoad = accumulateVectorLoad(compartmentLoad, event);
                    }
                  : undefined,
          })
        : [];
    compartmentSpan?.end("ok", {
        ...vectorLoadCounters(compartmentLoad),
        candidatesOut: compartmentResults.length,
        ...laneDepth,
    });
    // The message fusion stage only runs when a feeding lane ran; a span
    // with status "ok" for a disabled stage would misreport zero-cost work
    // as executed, so absent stages emit the explicit marker instead.
    const messageFusionRan = runMessages || runCompartmentChunks;
    const messageFusionSpan =
        trace && messageFusionRan
            ? trace.begin("fusion", "message", {
                  parent: rootId,
                  dependsOn: [
                      ...(messageSpan ? [messageSpan.id] : []),
                      ...(compartmentSpan ? [compartmentSpan.id] : []),
                  ],
              })
            : null;
    if (trace && !messageFusionRan) trace.notApplicable("fusion", "message", rootId);
    const messageLikeResults = mergeMessageAndCompartmentResults({
        messages: messageResults,
        compartments: compartmentResults,
        limit: tierLimit,
    });
    messageFusionSpan?.end("ok", {
        candidatesIn: messageResults.length + compartmentResults.length,
        candidatesOut: messageLikeResults.length,
    });

    if (messageFusionSpan) laneSpanIds.push(messageFusionSpan.id);

    // Hybrid lanes (git-commit, primer) decompose into lexical_scan,
    // vector_scan, and fusion spans through stage marks the lane functions
    // fire at their phase boundaries, joined by an explicit fusion
    // dependency — one undifferentiated lane span would report lexical-only
    // execution as vector time and hide the hybrid pipeline's structure.
    const runVectorLane = <T>(
        lane: "git_commit" | "primer",
        run: (
            onVectorLoad: VectorLoadObserver | undefined,
            stages: HybridLaneStageMarks | undefined,
        ) => T[],
    ): T[] => {
        if (!trace) return run(undefined, undefined);
        const recorder = trace;
        let load: VectorLoadEvent | null = null;
        const spans: {
            lexical: SearchTraceSpanHandle | null;
            vector: SearchTraceSpanHandle | null;
            fusion: SearchTraceSpanHandle | null;
        } = { lexical: null, vector: null, fusion: null };
        const stages: HybridLaneStageMarks = {
            lexicalStart: () => {
                spans.lexical = recorder.begin("lexical_scan", lane, {
                    parent: rootId,
                    // Sequential phase chaining: the lane implementations
                    // run their phases one after another on one thread, so
                    // whichever phase starts second causally waited on the
                    // first — without the edge the critical path takes
                    // max(lexical, vector) instead of their sum.
                    dependsOn: [...filterDeps, ...(spans.vector ? [spans.vector.id] : [])],
                });
            },
            lexicalEnd: (candidatesOut) => spans.lexical?.end("ok", { candidatesOut }),
            vectorStart: () => {
                spans.vector = recorder.begin("vector_scan", lane, {
                    parent: rootId,
                    dependsOn: [...semanticDeps, ...(spans.lexical ? [spans.lexical.id] : [])],
                });
            },
            vectorEnd: (candidatesOut) =>
                spans.vector?.end("ok", {
                    ...vectorLoadCounters(load),
                    candidatesOut,
                    ...laneDepth,
                }),
            vectorSkipped: () => recorder.notApplicable("vector_scan", lane, rootId),
            fusionStart: () => {
                spans.fusion = recorder.begin("fusion", lane, {
                    parent: rootId,
                    dependsOn: [
                        ...(spans.lexical ? [spans.lexical.id] : []),
                        ...(spans.vector ? [spans.vector.id] : []),
                    ],
                });
            },
            fusionEnd: (candidatesIn, candidatesOut) =>
                spans.fusion?.end("ok", { candidatesIn, candidatesOut }),
        };
        const results = run((event) => {
            load = accumulateVectorLoad(load, event);
        }, stages);
        const tail = spans.fusion ?? spans.vector ?? spans.lexical;
        if (tail) laneSpanIds.push(tail.id);
        return results;
    };

    const runGitCommitLane = (): GitCommitSearchResult[] =>
        runVectorLane("git_commit", (onVectorLoad, stages) =>
            searchGitCommits({
                db,
                projectPath,
                query: trimmedQuery,
                limit: tierLimit,
                queryEmbedding,
                queryModelId:
                    embeddingModelId && embeddingModelId !== "off" ? embeddingModelId : null,
                onVectorLoad,
                stages,
            }),
        );

    const runPrimerLane = (): PrimerSearchResult[] =>
        runVectorLane("primer", (onVectorLoad, stages) =>
            searchPrimers({
                db,
                projectPath,
                query: trimmedQuery,
                limit: tierLimit,
                queryEmbedding,
                queryModelId:
                    embeddingModelId && embeddingModelId !== "off" ? embeddingModelId : null,
                onVectorLoad,
                stages,
            }),
        );

    const runNoteLane = (): NoteSearchResult[] => {
        const span = trace
            ? trace.begin("lexical_scan", "note", { parent: rootId, dependsOn: filterDeps })
            : null;
        const lane = searchNotes({
            db,
            sessionId,
            projectPath,
            query: trimmedQuery,
            limit: tierLimit,
            probes: messageProbes,
        });
        if (span) {
            laneSpanIds.push(span.id);
            span.end("ok", { candidatesOut: lane.length, ...laneDepth });
        }
        return lane;
    };

    const [antiMemoryResults, gitCommitResults, primerResults, noteResults] = await Promise.all([
        antiMemoryPromise,
        runGitCommits
            ? Promise.resolve(runGitCommitLane())
            : Promise.resolve([] as GitCommitSearchResult[]),
        runPrimers ? Promise.resolve(runPrimerLane()) : Promise.resolve([] as PrimerSearchResult[]),
        runNotes ? Promise.resolve(runNoteLane()) : Promise.resolve([] as NoteSearchResult[]),
    ]);

    const fusionSpan =
        trace?.begin("fusion", "unified", { parent: rootId, dependsOn: laneSpanIds }) ?? null;
    const fused = [
        ...antiMemoryResults,
        ...primerResults,
        ...messageLikeResults,
        ...gitCommitResults,
        ...noteResults,
    ].sort(compareUnifiedResults);
    fusionSpan?.end("ok", {
        candidatesIn:
            primerResults.length +
            antiMemoryResults.length +
            messageLikeResults.length +
            gitCommitResults.length +
            noteResults.length,
        candidatesOut: fused.length,
    });
    const topKSpan =
        trace?.begin("top_k", "unified", {
            parent: rootId,
            dependsOn: fusionSpan ? [fusionSpan.id] : [],
        }) ?? null;
    const reservedAntiMemory =
        (options.memoryPolicySurface ?? "explicit_search") === "auto_search"
            ? antiMemoryResults[0]
            : undefined;
    const results = reservedAntiMemory
        ? [
              ...fused.filter((result) => result !== reservedAntiMemory).slice(0, limit - 1),
              reservedAntiMemory,
          ].sort(compareUnifiedResults)
        : fused.slice(0, limit);
    topKSpan?.end("ok", { candidatesIn: fused.length, candidatesOut: results.length });
    if (trace) {
        trace.notApplicable("reranking", "unified", rootId);
        trace.notApplicable("packing", "unified", rootId);
    }

    if (!options.measurementDisabled) {
        void recordShadowMeasurement({
            db,
            sessionId,
            projectPath,
            query: trimmedQuery,
            options: options.trace ? { ...options, trace: undefined } : options,
            primaryResults: results,
            primaryQuery: queryContract,
            primaryLatencyMs: Date.now() - args.measurementStartedAt,
            search: unifiedSearch,
        });
    }

    return results;
}
