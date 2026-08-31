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
    truncateUtf8Bytes,
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
/**
 *
 * */
const MEMORY_SOURCE_BOOST = 1.3;
const MESSAGE_SOURCE_BOOST = 1.15;
const GIT_COMMIT_SOURCE_BOOST = 1.2;
const PRIMER_SOURCE_BOOST = 1.25;
const ANTI_MEMORY_SEMANTIC_THRESHOLD = 0.7;
/** Each search sends at most 32 candidate texts to the embedding provider.
 * The search computes anti-memory passage vectors live and does not persist them.
 * Anti-memory semantic search runs on each user-prompt auto-search path.
 * Candidate selection must not scale with record population.
 * Lexically matched candidates take priority; newest records fill the remaining budget. */
const ANTI_MEMORY_MAX_SEMANTIC_CANDIDATES = 32;
/** Each anti-memory passage is limited to 2048 bytes before embedding and lexical-overlap scanning.
 * The write path normalizes payload fields without limiting their length.
 * Without a passage-length cap, one oversized record could exceed the provider input budget or consume the per-prompt deadline.
 * The 32-candidate and 2048-byte ceilings bound each batch. */
const ANTI_MEMORY_MAX_PASSAGE_BYTES = 2048;

interface MessageSearchRow {
    messageOrdinal?: number | string;
    messageId?: string;
    role?: string;
    /** The FTS query returns a bounded snippet, never the full message body. */
    fragment?: string;
    /** `verbatim0..N` flags test full-body probe containment. */
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

/* */
const MESSAGE_FRAGMENT_TOKENS = 32;
const MESSAGE_FRAGMENT_START_MARKER = "<<";
const MESSAGE_FRAGMENT_END_MARKER = ">>";
const MESSAGE_FRAGMENT_OMISSION = " ... ";
/** `content` is column 4 of message_history_fts (session_id, message_ordinal, message_id, role, content). */
const MESSAGE_FRAGMENT_COLUMN = 4;
/* */
const MESSAGE_FRAGMENT_SQL = `snippet(message_history_fts, ${MESSAGE_FRAGMENT_COLUMN}, '${MESSAGE_FRAGMENT_START_MARKER}', '${MESSAGE_FRAGMENT_END_MARKER}', '${MESSAGE_FRAGMENT_OMISSION}', ${MESSAGE_FRAGMENT_TOKENS}) AS fragment`;

/** Per-probe full-body containment flags preserve the verbatim bonus when a probe falls outside the returned fragment.
 * SQLite `lower()` folds ASCII only; `extractLiteralProbes` produces ASCII identifier-shape probes, and the caller lowercases each probe.
 * */
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
    /** Message search does not read raw messages on the hot path. */
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
    /** The search returns only hits with ordinal ≤ this value; -1 or omission searches all messages. */
    maxMessageOrdinal?: number;
    /** When enabled, the search includes indexed git commits; the default is false.
     * The `experimental.git_commit_indexing` configuration gates git-commit search. */
    gitCommitsEnabled?: boolean;
    /**
     * An undefined source list searches all enabled sources; an empty list returns `[]`.
     * The system renders facts in `message[0]` inside `<session-history>` instead of returning them as search results.
     * */
    sources?: SearchSource[];
    /** Abort signal — if provided, cancels in-flight embedding requests
     * The signal also cancels downstream HTTP calls when the caller aborts.
     * `auto-search` uses a 3s timeout and must cancel the 30s embedding fetch.
     * */
    signal?: AbortSignal;
    /** Memory hits increment `retrieval_count` by default.
     * Explicit `ctx_search` calls count because the agent requested the memory.
     * Automatic surfacing must not increment retrieval_count.
     * An agent may never consume an automatically surfaced hint.
     * Automatic surfacing does not indicate usefulness.
     * Automatic surfacing must not drive retrieval-count-based memory promotion. */
    countRetrievals?: boolean;
    /** Enabled message search extracts literal symbol, command, and path probes.
     * Search RRF-fuses results from each literal symbol, command, and path probe.
     * Multi-probe search can recall a message that matches one literal but none of the query's other tokens.
     * Defaults to false; only explicit `ctx_search` calls enable multi-probe search.
     * Auto-search remains single-probe to meet its latency budget.
     * NL queries with no extractable probes are unaffected by `explicitSearch`. */
    explicitSearch?: boolean;
    /** Disables production search metrics while running an offline shadow quality comparison. */
    measurementDisabled?: boolean;
    embeddingModelIdOverride?: string;
    chunkModelIdOverride?: string;
    /** Without `trace`, search performs no tracing; tracing does not change results, SQL, side effects, ordering, or errors.
     *  errors. */
    trace?: SearchTraceOptions;
    /** `candidateDepth` sets the per-lane candidate count; `limit` sets the returned-result count.
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
 * TODO: Apply `message_ordinal <= cutoff` in SQL before `LIMIT`.
 * `runMessageFtsQuery` applies the cutoff after LIMIT, which can discard all fetched rows despite older eligible hits.
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

/* */
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
        // `runMessageFtsQuery` treats FTS query failures as non-discriminative.
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

/**
 *
 *
 * */
function linearDecayScore(rank: number, total: number): number {
    if (total <= 0) return 0;
    return Math.max(0, 1 - rank / total);
}

interface NormalizedMessageRow {
    messageOrdinal: number;
    messageId: string;
    role: string;
    /** The result contains a bounded FTS fragment, not the full body. */
    fragment: string;
    /**
     * */
    verbatim: boolean[];
}

/* */
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

/** `runMessageFtsQuery` returns ordinal-cutoff-filtered, validated rows in BM25 rank order.
 * `ftsQuery` must be sanitized before `runMessageFtsQuery` receives it. */
function runMessageFtsQuery(
    db: Database,
    sessionId: string,
    ftsQuery: string,
    fetchLimit: number,
    cutoff: number | null,
): NormalizedMessageRow[] {
    if (ftsQuery.length === 0) return [];
    // A `null` cutoff keeps the original SQL statement.
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

/**
 * */
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

// `RRF_K = 60` reduces the difference between adjacent rank contributions.
const RRF_K = 60;
// `verbatim` adds one rank-0 list contribution to the RRF score.
const VERBATIM_RANK_BONUS = 1 / RRF_K;
const IDF_FALLOFF = 100;

/* */
function probeDiscriminationWeight(df: number, corpusSize: number): number {
    if (corpusSize <= 0 || df <= 0) return 1;
    return 1 / (1 + (IDF_FALLOFF * df) / corpusSize);
}

function searchMessages(args: {
    db: Database;
    sessionId: string;
    query: string;
    limit: number;
    /** `cutoff` limits results to messages with ordinal ≤ `cutoff`; omit `cutoff` to search all indexed messages. */
    maxOrdinal?: number;
    /**
     * An empty probe list uses the single-query path. */
    probes?: string[];
}): MessageSearchResult[] {
    const cutoff = args.maxOrdinal != null && args.maxOrdinal >= 0 ? args.maxOrdinal : null;
    // Overfetch compensates for candidates removed after cutoff filtering.
    // limit.
    const fetchLimit =
        args.maxOrdinal != null && args.maxOrdinal >= 0
            ? Math.min(args.limit * 3, MAX_LANE_CANDIDATES)
            : Math.min(args.limit, MAX_LANE_CANDIDATES);

    const baseQuery = sanitizeFtsQuery(args.query.trim());
    const probes = args.probes ?? [];

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

    // Each query retains its independent bm25 rank.
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

    // A literal probe match receives one rank-0 RRF contribution.
    // A verbatim match uses the highest weight among matching probes.
    // The verbatim contribution reorders matches within the score band instead of saturating it.
    // Flags cover sanitized probes only: an unsanitized probe carries weight 0
    // An unsanitized probe has weight 0 and cannot win the verbatim-match tie-break.
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

    // Fused RRF scores use the single-query path's linear 0..1 band.
    // The mapping makes scores from both message paths comparable and keeps source boosts consistent.
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
    // The capped ID list limits the provider read to anti-memory claims.
    //
    const candidateIds = listActiveAntiMemoryPublicIds(
        args.db,
        ownProjectIds,
        MAX_LANE_CANDIDATES,
        Date.now(),
    );
    if (candidateIds.length === 0) return [];
    // The shared closure keeps both reads' authorization, surface, and lifecycle settings identical.
    //
    const readAntiMemoryState = (publicClaimIds: readonly string[]) => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
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
            if (result.status === "ok") {
                return result.items.filter((item) => item.category === ANTI_MEMORY_CATEGORY);
            }
        }
        return null;
    };
    // The reader rejects projections with `policyVersion > CLAIM_POLICY_VERSION` because their policy bits are untrusted.
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
        // Payload matching excludes constant `record.content` labels because those labels match unrelated prompts.
        //
        // Exclusion matching ignores `nonApplicableWhen` because it states when the rejection does not hold.
        // TODO: Add exclusion matching for `nonApplicableWhen`.
        //
        // The search caps assembled text because payload fields have no write-side length limit.
        // The assembly places identity fields before context fields so truncation preserves identity.
        const text = truncateUtf8Bytes(
            [
                record.payload.trigger,
                record.payload.rejectedStrategy,
                record.payload.rejectionReason,
                record.payload.saferAlternative,
                record.payload.preconditions,
                record.payload.attemptedApproach,
                record.payload.observedFailure,
                record.payload.rootCause,
                record.payload.recovery,
            ]
                .filter((value): value is string => value !== null)
                .join("\n")
                .toLowerCase(),
            ANTI_MEMORY_MAX_PASSAGE_BYTES,
        );
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

    // The search caps the live per-prompt embedding batch independently of the candidate ceiling.
    // The embedding batch prioritizes lexically matched candidates by descending score, then remaining candidates from newest to oldest.
    // Ascending claim-ID order makes higher candidate indexes identify newer records.
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
            // Only cosine scores at or above the threshold affect ranking.
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
    // The awaited passage-embedding call extends the revalidation window.
    // During the provider call, another process can retire, revise, expire, or quarantine a warning.
    // The state read and record read use separate autocommit statements, so lexical results can combine two snapshots.
    // The provider verifies visibility at publication time, matching the locator lane.
    if (published.length === 0) return published;
    const current = readAntiMemoryState(published.map((result) => result.publicClaimId));
    if (current === null) return [];
    const currentById = new Map(current.map((item) => [item.publicClaimId, item]));
    return published.filter((result) => {
        const item = currentById.get(result.publicClaimId);
        // An absent revalidation record means the warning is archived, expired, or no longer visible.
        // A moved locator or digest means the copied payload predates the transition.
        if (item === undefined) return false;
        if (item.revisionLocator !== result.revisionLocator) return false;
        if (item.contentDigest !== result.contentDigest) return false;
        // A disposition between the reads can change only the label; the label therefore detects stale, disputed, or superseded warnings in explicit search.
        // Publishing the pre-transition copy would omit its stale, disputed, or superseded label.
        if ((item.explicitLabel ?? undefined) !== result.policyLabel) return false;
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

/** FTS5's trigram tokenizer cannot represent atoms shorter than three characters. */
const NOTE_FTS_MIN_ATOM_LENGTH = 3;

/**
 * The OR-joined trigram query includes the whole needle for exact-substring scoring and each keyword token for coverage scoring.
 * The query includes the needle and keyword tokens so FTS pruning preserves candidates that scoring can match.
 *
 * The query retains representable atoms when shorter atoms are unrepresentable.
 * The caller falls back to the recency window when no atom is representable.
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

/** loadNoteSearchCorpus caps the fused pool at MAX_LANE_CANDIDATES to bound scoring work.
 * */
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
 * Probe discrimination uses corpus-wide document frequency.
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

/**
 *
 * */
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

/**
 * */
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
    /**
     * */
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
 */
export function resolveClaimsByLocatorsForSearch(args: {
    db: Database;
    projectPath: string;
    locators: readonly string[];
    limit: number;
    /* */
    visibleRevisionLocators?: ReadonlySet<string> | null;
    /* */
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
    // The provider closes its snapshot before revalidation.
    // The initial read may be stale at revalidation.
    // Under WAL, another process can write while this process reads old committed state.
    // Another process can commit a quarantine, rejection, or revision before this call returns.
    // Telemetry can delay revalidation by up to `busy_timeout`.
    // The telemetry write does not create the stale-read window.
    // The provider revalidates even when `countRetrievals === false`.
    const current = readVisibleClaims();
    if (current === null) return null;
    const currentByClaimId = new Map(current.map((item) => [item.publicClaimId, item]));
    // Revalidation publishes a result only when every field copied from the snapshot still matches.
    // A missing current claim is either hidden or deleted.
    // The initial copy can predate a quarantine, rejection, or revision.
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
        // An anti-memory result carries payload fields instead of `content` and `category`.
        // The preceding equality checks do not cover anti-memory payload fields.
        // Revalidation reapplies hydration's lifecycle and category gates.
        // Otherwise, revalidation can publish a warning archived after hydration.
        // still published.
        if (result.source === "anti_memory") {
            return item.category === ANTI_MEMORY_CATEGORY && item.lifecycleState === "active";
        }
        return item.content === result.content && item.category === result.category;
    });
    // `null` also represents a missing or foreign-hidden locator.
    // Callers cannot distinguish a hidden claim from a missing claim.
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
    // For calls that reach trace creation, a supplied sink receives one root span.
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
    // `requestedK` and `effectiveK` share one value, so their equality cannot detect per-lane clamping.
    // TODO: Expose per-lane executed bounds to detect internal clamping.
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
    // The filter span encloses downstream chain roots, so `criticalPathMs` includes filtering cost.
    // Workspace resolution is filter work.
    // The search starts embedding before workspace resolution because SQLite reads are synchronous.
    const filterDeps = filterSpan ? [filterSpan.id] : [];

    //
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

    await Promise.resolve();

    // Message indexing is event-driven and does not run during search.
    // Unreconciled sessions return no message hits until asynchronous first-touch reconciliation finishes.
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

    // The embedding-dependent searches share one query vector and run in parallel after embedding completes.
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
    // Generation-gated vectors keep `generation_lookup` on semantic scans' critical path.
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
    // Disabled message fusion emits `notApplicable` instead of `ok` to avoid reporting zero-cost work as executed.
    // Disabled message fusion emits `notApplicable` instead of `ok` to avoid reporting zero-cost work as executed.
    // Disabled message fusion emits `notApplicable` instead of `ok` to avoid reporting zero-cost work as executed.
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

    // The `fusion` span depends on the scan spans to preserve phase ordering.
    // A single lane span would report lexical-only execution as vector time.
    // A single lane span would report lexical-only execution as vector time and hide the hybrid pipeline structure.
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
                    // Lane implementations run lexical and vector phases sequentially, so the second phase depends on the first.
                    // Lane implementations run lexical and vector phases sequentially, so the second phase depends on the first.
                    // Lane implementations run lexical and vector phases sequentially, so the second phase depends on the first.
                    // Without the phase dependency, the critical path uses `max(lexical, vector)` rather than their sum.
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
