import type { Database } from "../../shared/sqlite";
import type { EmbeddingPurpose } from "./memory/embedding-provider";
import { type SearchTraceOptions } from "./search-trace";
import { type Note } from "./storage-notes";
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
    embedQuery?: (text: string, signal?: AbortSignal, purpose?: EmbeddingPurpose) => Promise<CapturedQueryEmbedding | Float32Array | null>;
    embedPassages?: (texts: string[], signal?: AbortSignal, purpose?: EmbeddingPurpose) => Promise<(Float32Array | null)[]>;
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
export type UnifiedSearchResult = MemorySearchResult | AntiMemorySearchResult | MessageSearchResult | CompartmentSearchResult | GitCommitSearchResult | PrimerSearchResult | NoteSearchResult;
export { ID_SHAPED_QUERY_MAX_TOKENS, parseIdShapedQuery } from "./search-bounds";
/** Assign each message ordinal to its containing compartment with one ordered
 *  interval sweep instead of scanning every compartment range per message.
 *
 *  Assignment order and fusion order are deliberately separate (KTD5): the sweep
 *  walks ordinal-sorted copies, while overlap ties are still resolved by the
 *  compartment's original semantic rank, so a boundary message lands in the
 *  earliest-ranked containing compartment exactly as a rank-ordered scan did.
 *  Returned map keys are the caller's message array indexes. */
export declare function assignMessagesToCompartments(messages: readonly MessageSearchResult[], compartments: readonly CompartmentSearchResult[]): Map<number, CompartmentSearchResult>;
/** Exported for the KTD1 characterization tests, which differential-check the
 *  interval sweep against a local reference of the former per-message scan. */
export declare function mergeMessageAndCompartmentResults(args: {
    messages: MessageSearchResult[];
    compartments: CompartmentSearchResult[];
    limit: number;
}): Array<MessageSearchResult | CompartmentSearchResult>;
/**
 * Parse a whole-query exact-locator list: every whitespace-separated token
 * must be a public claim ID (`mcm_<32hex>`) or a full revision locator
 * (`mcm_<32hex>/r<n>/<sha256>`). Returns null for anything else so ordinary
 * text queries fall through to the normal lanes.
 */
export declare function parseLocatorShapedQuery(query: string): string[] | null;
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
export declare function resolveClaimsByLocatorsForSearch(args: {
    db: Database;
    projectPath: string;
    locators: readonly string[];
    limit: number;
    /** Revision locators already rendered in the injected baseline. */
    visibleRevisionLocators?: ReadonlySet<string> | null;
    /** Bump claim retrieval telemetry (explicit agent lookups). */
    countRetrievals?: boolean;
}): Array<MemorySearchResult | AntiMemorySearchResult> | null;
export declare function unifiedSearch(db: Database, sessionId: string, projectPath: string, query: string, options?: UnifiedSearchOptions): Promise<UnifiedSearchResult[]>;
//# sourceMappingURL=search.d.ts.map