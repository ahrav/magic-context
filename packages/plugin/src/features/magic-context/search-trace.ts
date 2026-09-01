/**
 *
 * Tracing is optional per call.
 * `UnifiedSearchOptions.trace` accepts a `SearchTraceOptions` sink for stage-level evidence.
 * There is no global observer, so concurrent queries cannot cross-contaminate traces.
 * Each recorder uses one monotonic clock domain.
 * spans from different workers/processes must never be merged into one graph.
 *
 * Inclusive spans may overlap, so summed inclusive durations do not equal elapsed time.
 * The union of observed in-root intervals plus uncovered root time equals root wall time.
 * Exclusive time equals a span's duration minus the union of its contained children.
 * `analyzeSearchTrace` computes exclusive time and dependency critical path as separate diagnostics.
 * Exclusive time and dependency critical path need not partition wall time.
 *
 * `decodedBytes` and `cachedBytes` count payload or vector-buffer bytes touched by the query.
 * `decodedBytes` and `cachedBytes` never estimate object size.
 * On a cache miss, `decodedBytes` records bytes decoded fresh from storage.
 * On a cache hit, `cachedBytes` records warm vector-buffer bytes touched by the scan.
 */

export const SEARCH_TRACE_SCHEMA_VERSION = 1;

/** `SearchTraceStage` defines the versioned stage vocabulary; `root` spans the end-to-end search.
 * `lexical_scan` covers FTS and keyword lanes alongside dense `vector_scan` spans.
 * `reranking` and `packing` use zero-length `not_applicable` markers when their semantic passes cannot run.
 * */
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

/**
 * Exactly one of `decodedBytes` and `cachedBytes` is nonzero for each load.
 * A decoder that scans independently cached units emits one event per unit.
 *  Observers fold multiple events with `accumulateVectorLoad`. */
export interface VectorLoadEvent {
    /** `decodedBytes` records BLOB payload bytes decoded fresh from storage. */
    decodedBytes: number;
    /** `cachedBytes` records warm vector-buffer bytes served from a process cache on a cache hit.
     * */
    cachedBytes: number;
    vectorCount: number;
    cacheHit: boolean;
}

export type VectorLoadObserver = (event: VectorLoadEvent) => void;

/** `HybridLaneStageMarks` splits hybrid-lane traces into `lexical_scan`, `vector_scan`, and `fusion` spans.
 * `HybridLaneStageMarks` callbacks run synchronously on one thread.
 * Non-tracing callers emit no marks. */
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
    /** `decodedVectorBytes` counts exact decoded BLOB/vector-buffer bytes returned by this stage. */
    decodedVectorBytes?: number;
    /** `cachedVectorBytes` counts warm cache vector-buffer bytes touched by this stage. */
    cachedVectorBytes?: number;
    vectorCount?: number;
    cacheHit?: boolean;
    /** `rows` counts rows returned by metadata or lexical statements. */
    rows?: number;
    candidatesIn?: number;
    candidatesOut?: number;
    /** `requestedK` records the per-lane K requested by the caller. */
    requestedK?: number;
    /** `effectiveK` records the per-lane K executed by the lane. */
    effectiveK?: number;
}

export interface SearchTraceSpan {
    schemaVersion: typeof SEARCH_TRACE_SCHEMA_VERSION;
    id: number;
    parentId: number | null;
    /** `dependsOn` lists spans that this span causally waited on. */
    dependsOn: readonly number[];
    stage: SearchTraceStage;
    lane: SearchTraceLane;
    startMs: number;
    endMs: number;
    status: SearchTraceStatus;
    counters: SearchTraceCounters;
    /** `clockDomain` identifies the recorder's monotonic clock domain. */
    clockDomain: string;
}

export interface SearchTraceSink {
    onSpan(span: SearchTraceSpan): void;
}

export interface SearchTraceOptions {
    sink: SearchTraceSink;
    /** `now` injects a monotonic clock and defaults to `performance.now()`. */
    now?: () => number;
    /**
     * A runner merging traces from several workers must keep each clock domain's graph separate. */
    clockDomain?: string;
}

export interface SearchTraceSpanHandle {
    readonly id: number;
    /**
     * A second end call is ignored so error paths can end defensively. */
    end(status?: SearchTraceStatus, counters?: SearchTraceCounters): void;
}

export interface SearchTraceRecorder {
    readonly clockDomain: string;
    begin(
        stage: SearchTraceStage,
        lane: SearchTraceLane,
        options?: { parent?: number | null; dependsOn?: readonly number[] },
    ): SearchTraceSpanHandle;
    /** notApplicable emits a zero-length marker when the current pipeline does not execute a stage.
     * The marker makes absent stages explicit rather than missing. */
    notApplicable(stage: SearchTraceStage, lane: SearchTraceLane, parent?: number | null): void;
    /* */
    hasOpenSpans(): boolean;
}

export function createSearchTraceRecorder(options: SearchTraceOptions): SearchTraceRecorder {
    const now = options.now ?? (() => performance.now());
    const clockDomain = options.clockDomain ?? `pid:${process.pid}`;
    let nextId = 1;
    let openSpans = 0;

    // emit swallows sink failures so tracing cannot affect search behavior or errors.
    const emit = (span: SearchTraceSpan): void => {
        try {
            options.sink.onSpan(span);
        } catch {
            // An observer failure drops the span without affecting the search.
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
            // `notApplicable` uses one timestamp for `startMs` and `endMs` because separate readings would record elapsed time for an unexecuted stage.
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
// KTD8 accounting supports temporal-conservation, exclusive-time, and critical-path calculations.
// ---------------------------------------------------------------------------

export interface SearchTraceAnalysis {
    rootId: number;
    rootDurationMs: number;
    /** `coveredMs` is the temporal union of observed in-root intervals, clipped to the root. */
    coveredMs: number;
    /** `uncoveredMs` is root wall time not covered by any child span.
     * Invariant: coveredMs + uncoveredMs === rootDurationMs. */
    uncoveredMs: number;
    /** `inclusiveSumMs` sums clipped inclusive child durations and can exceed `rootDurationMs`. */
    inclusiveSumMs: number;
    /** `overlapMs` equals `inclusiveSumMs - coveredMs` and measures overlapping child time. */
    overlapMs: number;
    /** `exclusiveMs` equals each span's duration minus the temporal union of its direct children. */
    exclusiveMsBySpan: Map<number, number>;
    /** `criticalPathMs` is the longest dependency-chain duration and is not wall time. */
    criticalPathMs: number;
    /** `criticalPathIds` lists span ids on the critical dependency path in execution order. */
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

/** The function returns the longest dependency chain over `dependsOn` edges and throws on cycles or unknown span ids.
 * */
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
 * The function computes KTD8 accounting for one completed trace graph and rejects mixed clock domains, traces without exactly one root, and negative-duration spans.
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
// ---------------------------------------------------------------------------

export class CandidateDepthMismatchError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "CandidateDepthMismatchError";
    }
}

/**
 * The validator rejects benchmark cases whose lanes did not execute the requested internal candidate depth.
 * When supplied, `requestedK` must equal `effectiveK` and the caller's requested value exactly.
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

/* */
export function vectorLoadCounters(event: VectorLoadEvent | null): SearchTraceCounters {
    if (!event) return {};
    return {
        decodedVectorBytes: event.decodedBytes,
        cachedVectorBytes: event.cachedBytes,
        vectorCount: event.vectorCount,
        cacheHit: event.cacheHit,
    };
}

/**
 * The aggregate sums `decodedBytes` and `cachedBytes` independently.
 * `cacheHit` is true only when every accumulated event has `cacheHit === true`. */
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
