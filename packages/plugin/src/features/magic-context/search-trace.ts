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

export const SEARCH_TRACE_SCHEMA_VERSION = 1;

/** Versioned stage vocabulary (R27). `root` is the end-to-end span; `lexical_scan`
 *  covers FTS/keyword lanes that AE5 requires alongside dense `vector_scan` spans.
 *  Stages absent from the current pipeline (reranking, packing) are emitted as
 *  zero-length `not_applicable` markers rather than invented precision. */
export type SearchTraceStage =
    | "root"
    | "query_inference"
    | "generation_lookup"
    | "filter_construction"
    | "lexical_scan"
    | "vector_scan"
    | "top_k"
    | "metadata_hydration"
    | "fusion"
    | "reranking"
    | "packing";

export type SearchTraceLane =
    | "unified"
    | "query"
    | "memory"
    | "message"
    | "compartment"
    | "git_commit"
    | "primer"
    | "note";

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
    begin(
        stage: SearchTraceStage,
        lane: SearchTraceLane,
        options?: { parent?: number | null; dependsOn?: readonly number[] },
    ): SearchTraceSpanHandle;
    /** Emits a zero-length marker for a stage the current pipeline does not
     *  execute, so absent stages are explicit rather than missing. */
    notApplicable(stage: SearchTraceStage, lane: SearchTraceLane, parent?: number | null): void;
    /** True while any began span has not been ended (test/diagnostic seam). */
    hasOpenSpans(): boolean;
}

export function createSearchTraceRecorder(options: SearchTraceOptions): SearchTraceRecorder {
    const now = options.now ?? (() => performance.now());
    const clockDomain = options.clockDomain ?? `pid:${process.pid}`;
    let nextId = 1;
    let openSpans = 0;

    // Tracing is behavior- and error-neutral for the traced search: a
    // throwing sink must not abort an otherwise successful search or mask
    // an in-flight error, so observer failures are swallowed here.
    const emit = (span: SearchTraceSpan): void => {
        try {
            options.sink.onSpan(span);
        } catch {
            // Dropped span: the observer failed, the search did not.
        }
    };

    const begin: SearchTraceRecorder["begin"] = (stage, lane, beginOptions) => {
        const id = nextId;
        nextId += 1;
        const parentId = beginOptions?.parent ?? null;
        const dependsOn = beginOptions?.dependsOn ? [...beginOptions.dependsOn] : [];
        const startMs = now();
        openSpans += 1;
        let ended = false;
        return {
            id,
            end(status: SearchTraceStatus = "ok", counters: SearchTraceCounters = {}) {
                if (ended) return;
                ended = true;
                openSpans -= 1;
                emit({
                    schemaVersion: SEARCH_TRACE_SCHEMA_VERSION,
                    id,
                    parentId,
                    dependsOn,
                    stage,
                    lane,
                    startMs,
                    endMs: now(),
                    status,
                    counters,
                    clockDomain,
                });
            },
        };
    };

    return {
        clockDomain,
        begin,
        notApplicable(stage, lane, parent) {
            // One timestamp for both edges: begin(...).end(...) would take
            // two clock readings and record spurious elapsed time for a
            // stage that never executed.
            const id = nextId;
            nextId += 1;
            const at = now();
            emit({
                schemaVersion: SEARCH_TRACE_SCHEMA_VERSION,
                id,
                parentId: parent ?? null,
                dependsOn: [],
                stage,
                lane,
                startMs: at,
                endMs: at,
                status: "not_applicable",
                counters: {},
                clockDomain,
            });
        },
        hasOpenSpans: () => openSpans > 0,
    };
}

// ---------------------------------------------------------------------------
// KTD8 accounting: temporal conservation, exclusive time, critical path.
// ---------------------------------------------------------------------------

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

type Interval = readonly [number, number];

function unionLength(intervals: Interval[]): number {
    if (intervals.length === 0) return 0;
    const sorted = [...intervals].sort((left, right) => left[0] - right[0]);
    let total = 0;
    let [currentStart, currentEnd] = sorted[0];
    for (const [start, end] of sorted.slice(1)) {
        if (start > currentEnd) {
            total += currentEnd - currentStart;
            currentStart = start;
            currentEnd = end;
        } else if (end > currentEnd) {
            currentEnd = end;
        }
    }
    return total + (currentEnd - currentStart);
}

function clip(span: SearchTraceSpan, windowStart: number, windowEnd: number): Interval | null {
    const start = Math.max(span.startMs, windowStart);
    const end = Math.min(span.endMs, windowEnd);
    return end > start ? [start, end] : null;
}

/** Longest dependency chain over `dependsOn` edges. Throws on cycles and on
 *  references to unknown span ids. */
function computeCriticalPath(spans: readonly SearchTraceSpan[]): {
    totalMs: number;
    path: number[];
} {
    const byId = new Map(spans.map((span) => [span.id, span]));
    const memo = new Map<number, { totalMs: number; path: number[] }>();
    const visiting = new Set<number>();

    const visit = (id: number): { totalMs: number; path: number[] } => {
        const cached = memo.get(id);
        if (cached) return cached;
        if (visiting.has(id)) {
            throw new Error(`search trace dependency cycle through span ${id}`);
        }
        const span = byId.get(id);
        if (!span) {
            throw new Error(`search trace references unknown span ${id}`);
        }
        visiting.add(id);
        let best = { totalMs: 0, path: [] as number[] };
        for (const dependency of span.dependsOn) {
            const result = visit(dependency);
            if (result.totalMs > best.totalMs) best = result;
        }
        const result = {
            totalMs: best.totalMs + (span.endMs - span.startMs),
            path: [...best.path, id],
        };
        visiting.delete(id);
        memo.set(id, result);
        return result;
    };

    let best = { totalMs: 0, path: [] as number[] };
    for (const span of spans) {
        if (span.stage === "root") continue;
        const result = visit(span.id);
        if (result.totalMs > best.totalMs) best = result;
    }
    return best;
}

/**
 * Compute the KTD8 accounting for one completed trace graph. Rejects graphs
 * that mix clock domains (cross-worker clocks are never comparable), lack
 * exactly one root, or contain a negative-duration span.
 */
export function analyzeSearchTrace(spans: readonly SearchTraceSpan[]): SearchTraceAnalysis {
    if (spans.length === 0) {
        throw new Error("cannot analyze an empty search trace");
    }
    const domains = new Set(spans.map((span) => span.clockDomain));
    if (domains.size > 1) {
        throw new Error(
            `search trace mixes clock domains (${[...domains].join(", ")}); cross-worker clocks are never merged into one graph`,
        );
    }
    for (const span of spans) {
        if (!Number.isFinite(span.startMs) || !Number.isFinite(span.endMs)) {
            throw new Error(`span ${span.id} has a non-finite timestamp`);
        }
        if (span.endMs < span.startMs) {
            throw new Error(`span ${span.id} has negative duration`);
        }
    }
    const roots = spans.filter((span) => span.stage === "root");
    if (roots.length !== 1) {
        throw new Error(`search trace must have exactly one root span, found ${roots.length}`);
    }
    const root = roots[0];
    const rootDurationMs = root.endMs - root.startMs;

    const inRoot: Interval[] = [];
    let inclusiveSumMs = 0;
    for (const span of spans) {
        if (span.id === root.id) continue;
        const clipped = clip(span, root.startMs, root.endMs);
        if (!clipped) continue;
        inRoot.push(clipped);
        inclusiveSumMs += clipped[1] - clipped[0];
    }
    const coveredMs = unionLength(inRoot);

    const exclusiveMsBySpan = new Map<number, number>();
    for (const span of spans) {
        const children: Interval[] = [];
        for (const candidate of spans) {
            if (candidate.parentId !== span.id) continue;
            const clipped = clip(candidate, span.startMs, span.endMs);
            if (clipped) children.push(clipped);
        }
        exclusiveMsBySpan.set(span.id, span.endMs - span.startMs - unionLength(children));
    }

    const critical = computeCriticalPath(spans);
    return {
        rootId: root.id,
        rootDurationMs,
        coveredMs,
        uncoveredMs: rootDurationMs - coveredMs,
        inclusiveSumMs,
        overlapMs: inclusiveSumMs - coveredMs,
        exclusiveMsBySpan,
        criticalPathMs: critical.totalMs,
        criticalPath: critical.path,
    };
}

// ---------------------------------------------------------------------------
// KTD7 candidate-depth evidence validation.
// ---------------------------------------------------------------------------

export class CandidateDepthMismatchError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "CandidateDepthMismatchError";
    }
}

/**
 * Reject a benchmark case whose lanes did not execute the requested internal
 * candidate depth (KTD7). Every span carrying candidate-depth evidence must
 * report `effectiveK === requestedK`, and when `requestedK` is supplied it
 * must match the caller's request exactly.
 */
export function assertCandidateDepthSatisfied(
    spans: readonly SearchTraceSpan[],
    requestedK?: number,
): void {
    for (const span of spans) {
        const { requestedK: spanRequested, effectiveK } = span.counters;
        if (spanRequested === undefined && effectiveK === undefined) continue;
        if (spanRequested === undefined || effectiveK === undefined) {
            throw new CandidateDepthMismatchError(
                `span ${span.id} (${span.stage}/${span.lane}) records incomplete candidate-depth evidence`,
            );
        }
        if (spanRequested !== effectiveK) {
            throw new CandidateDepthMismatchError(
                `span ${span.id} (${span.stage}/${span.lane}) requested K=${spanRequested} but executed K=${effectiveK}`,
            );
        }
        if (requestedK !== undefined && spanRequested !== requestedK) {
            throw new CandidateDepthMismatchError(
                `span ${span.id} (${span.stage}/${span.lane}) recorded K=${spanRequested}, caller requested K=${requestedK}`,
            );
        }
    }
}

/** Fold one decoder `VectorLoadEvent` into span counters. */
export function vectorLoadCounters(event: VectorLoadEvent | null): SearchTraceCounters {
    if (!event) return {};
    return {
        decodedVectorBytes: event.decodedBytes,
        cachedVectorBytes: event.cachedBytes,
        vectorCount: event.vectorCount,
        cacheHit: event.cacheHit,
    };
}

/** Fold per-load events into one stage-level summary. Each event stays
 *  all-or-nothing, so a stage mixing cold and warm loads carries both byte
 *  fields nonzero here; cacheHit reports whether every load hit the cache. */
export function accumulateVectorLoad(
    prev: VectorLoadEvent | null,
    event: VectorLoadEvent,
): VectorLoadEvent {
    if (!prev) return event;
    return {
        decodedBytes: prev.decodedBytes + event.decodedBytes,
        cachedBytes: prev.cachedBytes + event.cachedBytes,
        vectorCount: prev.vectorCount + event.vectorCount,
        cacheHit: prev.cacheHit && event.cacheHit,
    };
}
