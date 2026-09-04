/**
 * Per-call retrieval trace contract (U1: R54-R57, KTD2/KTD7/KTD8/KTD13).
 *
 * Tracing is optional, per call, and production-owned. A caller that wants
 * stage-level evidence passes a `SearchTraceOptions` sink through
 * `UnifiedSearchOptions.trace`; every other caller pays nothing. There is no
 * global observer, so concurrent queries can never cross-contaminate traces
 * (KTD2), and each recorder is pinned to one monotonic clock domain (KTD8) —
 * spans from different workers/processes must never be merged into one graph.
 *
 * Timing semantics (R55-R56, KTD8):
 * - Inclusive spans may overlap; summed inclusive durations are NOT elapsed
 *   time. The conservation invariant is temporal: the union of in-root
 *   observed intervals plus uncovered root time equals root wall time.
 * - Exclusive time (span duration minus the union of its contained children)
 *   and the dependency critical path are separate diagnostics computed by
 *   `analyzeSearchTrace`; neither is forced to partition wall time.
 *
 * Work semantics (R57): vector byte counters measure the BLOB payload /
 * vector-buffer bytes actually returned to and touched by the query — never
 * an estimated object size. On a cache miss `decodedBytes` carries the bytes
 * decoded fresh from storage; on a cache hit `cachedBytes` carries the warm
 * vector-buffer bytes the scan touched (the declared cache-hit semantics).
 */
export declare const SEARCH_TRACE_SCHEMA_VERSION = 1;
/** Versioned stage vocabulary (R27). `root` is the end-to-end span; `lexical_scan`
 *  covers FTS/keyword lanes that AE5 requires alongside dense `vector_scan` spans.
 *  Stages absent from the current pipeline (reranking, packing) are emitted as
 *  zero-length `not_applicable` markers rather than invented precision. */
export type SearchTraceStage = "root" | "query_inference" | "generation_lookup" | "filter_construction" | "lexical_scan" | "vector_scan" | "top_k" | "metadata_hydration" | "fusion" | "reranking" | "packing";
export type SearchTraceLane = "unified" | "query" | "memory" | "message" | "compartment" | "git_commit" | "primer" | "note";
export type SearchTraceStatus = "ok" | "failed" | "cancelled" | "not_applicable";
/** One vector load reported by a decoder (R57). Byte fields are exact buffer
 *  byte lengths, never estimates. Exactly one of decodedBytes/cachedBytes is
 *  nonzero for a given load: attribution is all-or-nothing per load, so a
 *  decoder scanning several independently cached units (e.g. workspace
 *  identities) emits one event per unit rather than one mixed event.
 *  Observers fold multiple events with `accumulateVectorLoad`. */
export interface VectorLoadEvent {
    /** BLOB payload bytes decoded fresh from storage by this load. */
    decodedBytes: number;
    /** Warm vector-buffer bytes served from a process cache (touched-byte
     *  semantics on cache hit). */
    cachedBytes: number;
    vectorCount: number;
    cacheHit: boolean;
}
export type VectorLoadObserver = (event: VectorLoadEvent) => void;
/** Phase boundaries a hybrid (lexical + vector) lane reports so its trace
 *  decomposes into lexical_scan, vector_scan, and fusion spans instead of one
 *  undifferentiated span. Marks fire synchronously on one thread; phase order
 *  may vary by lane, and a lane whose semantic pass cannot run calls
 *  vectorSkipped instead of the vector pair. Callers that do not trace pass
 *  no marks and pay nothing. */
export interface HybridLaneStageMarks {
    lexicalStart(): void;
    lexicalEnd(candidatesOut: number): void;
    vectorStart(): void;
    vectorEnd(candidatesOut: number): void;
    vectorSkipped(): void;
    fusionStart(): void;
    fusionEnd(candidatesIn: number, candidatesOut: number): void;
}
export interface SearchTraceCounters {
    /** Exact decoded BLOB/vector-buffer bytes returned by this stage (R57). */
    decodedVectorBytes?: number;
    /** Warm cache vector-buffer bytes touched by this stage. */
    cachedVectorBytes?: number;
    vectorCount?: number;
    cacheHit?: boolean;
    /** Rows returned by metadata/lexical statements. */
    rows?: number;
    candidatesIn?: number;
    candidatesOut?: number;
    /** KTD7 candidate-depth evidence: the per-lane K the caller requested. */
    requestedK?: number;
    /** KTD7 candidate-depth evidence: the per-lane K the lane executed. */
    effectiveK?: number;
}
export interface SearchTraceSpan {
    schemaVersion: typeof SEARCH_TRACE_SCHEMA_VERSION;
    id: number;
    parentId: number | null;
    /** Ids of spans this span causally waited on (dependency edges, KTD8). */
    dependsOn: readonly number[];
    stage: SearchTraceStage;
    lane: SearchTraceLane;
    startMs: number;
    endMs: number;
    status: SearchTraceStatus;
    counters: SearchTraceCounters;
    /** Monotonic clock domain; one per query, never merged across workers. */
    clockDomain: string;
}
export interface SearchTraceSink {
    onSpan(span: SearchTraceSpan): void;
}
export interface SearchTraceOptions {
    sink: SearchTraceSink;
    /** Injected monotonic clock (KTD13). Defaults to `performance.now()`. */
    now?: () => number;
    /** Clock-domain label. Defaults to this process; a runner merging traces
     *  from several workers must keep each domain's graph separate. */
    clockDomain?: string;
}
export interface SearchTraceSpanHandle {
    readonly id: number;
    /** Completes the span and emits it to the sink. Idempotent: a second call
     *  is ignored so error paths can end defensively. */
    end(status?: SearchTraceStatus, counters?: SearchTraceCounters): void;
}
export interface SearchTraceRecorder {
    readonly clockDomain: string;
    begin(stage: SearchTraceStage, lane: SearchTraceLane, options?: {
        parent?: number | null;
        dependsOn?: readonly number[];
    }): SearchTraceSpanHandle;
    /** Emits a zero-length marker for a stage the current pipeline does not
     *  execute, so absent stages are explicit rather than missing. */
    notApplicable(stage: SearchTraceStage, lane: SearchTraceLane, parent?: number | null): void;
    /** True while any began span has not been ended (test/diagnostic seam). */
    hasOpenSpans(): boolean;
}
export declare function createSearchTraceRecorder(options: SearchTraceOptions): SearchTraceRecorder;
export interface SearchTraceAnalysis {
    rootId: number;
    rootDurationMs: number;
    /** Temporal union of all in-root observed intervals, clipped to the root. */
    coveredMs: number;
    /** Root wall time not covered by any child span (uninstrumented overhead).
     *  Invariant (R56): coveredMs + uncoveredMs === rootDurationMs. */
    uncoveredMs: number;
    /** Sum of clipped inclusive child durations. May exceed rootDurationMs. */
    inclusiveSumMs: number;
    /** inclusiveSumMs - coveredMs: how much child time overlapped. */
    overlapMs: number;
    /** Per-span duration minus the temporal union of its direct children. */
    exclusiveMsBySpan: Map<number, number>;
    /** Longest dependency-chain duration (separate diagnostic, never wall time). */
    criticalPathMs: number;
    /** Span ids along the critical dependency path, in execution order. */
    criticalPath: readonly number[];
}
/**
 * Compute the KTD8 accounting for one completed trace graph. Rejects graphs
 * that mix clock domains (cross-worker clocks are never comparable), lack
 * exactly one root, or contain a negative-duration span.
 */
export declare function analyzeSearchTrace(spans: readonly SearchTraceSpan[]): SearchTraceAnalysis;
export declare class CandidateDepthMismatchError extends Error {
    constructor(message: string);
}
/**
 * Reject a benchmark case whose lanes did not execute the requested internal
 * candidate depth (KTD7). Every span carrying candidate-depth evidence must
 * report `effectiveK === requestedK`, and when `requestedK` is supplied it
 * must match the caller's request exactly.
 */
export declare function assertCandidateDepthSatisfied(spans: readonly SearchTraceSpan[], requestedK?: number): void;
/** Fold one decoder `VectorLoadEvent` into span counters. */
export declare function vectorLoadCounters(event: VectorLoadEvent | null): SearchTraceCounters;
/** Fold per-load events into one stage-level summary. Each event stays
 *  all-or-nothing, so a stage mixing cold and warm loads carries both byte
 *  fields nonzero here; cacheHit reports whether every load hit the cache. */
export declare function accumulateVectorLoad(prev: VectorLoadEvent | null, event: VectorLoadEvent): VectorLoadEvent;
//# sourceMappingURL=search-trace.d.ts.map