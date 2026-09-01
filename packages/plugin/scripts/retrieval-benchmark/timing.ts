/**
 * Timing contract.
 *
 *
 * `LatencySummary` retains raw samples so callers can recompute percentiles.
 *
 * `coveredMs + uncoveredMs` equals `rootDurationMs`.
 * Trace validation enforces `coveredMs + uncoveredMs = rootDurationMs`.
 * Trace validation checks containment exclusives and the dependency critical path independently of temporal conservation.
 *
 * `decodedVectorBytes` sums exact decoded BLOB and vector-buffer bytes across spans.
 * `indexBuildMs` records fixture index-build time separately from query latency.
 * Query latency excludes fixture index-build time.
 */

import {
    analyzeSearchTrace,
    type SearchTraceLane,
    type SearchTraceSpan,
    type SearchTraceStage,
} from "../../src/features/magic-context/search-trace";

export const TIMING_POLICY_VERSION = "retrieval-timing-policy/v1";

export class TimingError extends Error {}

/**
 */
export function nearestRankPercentile(samples: readonly number[], percentile: number): number {
    if (samples.length === 0) {
        throw new TimingError("cannot compute a percentile of zero samples");
    }
    if (!(percentile > 0 && percentile <= 100)) {
        throw new TimingError(`percentile must be in (0, 100], got ${percentile}`);
    }
    for (const sample of samples) {
        if (!Number.isFinite(sample) || sample < 0) {
            throw new TimingError("latency samples must be nonnegative finite numbers");
        }
    }
    const sorted = [...samples].sort((a, b) => a - b);
    return sorted[Math.ceil((percentile / 100) * sorted.length) - 1];
}

export interface LatencySummary {
    timingPolicyVersion: typeof TIMING_POLICY_VERSION;
    sampleCount: number;
    p50Ms: number;
    p95Ms: number;
    /* */
    samplesMs: readonly number[];
}

export function summarizeLatency(samplesMs: readonly number[]): LatencySummary {
    return {
        timingPolicyVersion: TIMING_POLICY_VERSION,
        sampleCount: samplesMs.length,
        p50Ms: nearestRankPercentile(samplesMs, 50),
        p95Ms: nearestRankPercentile(samplesMs, 95),
        samplesMs: [...samplesMs],
    };
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

export interface WorkEvidence {
    /** `decodedVectorBytes` sums exact decoded BLOB and vector-buffer bytes across spans. */
    decodedVectorBytes: number;
    /** `cachedVectorBytes` counts warm-cache vector-buffer bytes touched across spans. */
    cachedVectorBytes: number;
    vectorCount: number;
    /** `indexBuildMs` records fixture index-build time separately from query latency. */
    indexBuildMs: number | null;
}

export interface TraceTimingEvidence {
    timingPolicyVersion: typeof TIMING_POLICY_VERSION;
    /** `rootDurationMs` measures elapsed time for the root trace. */
    rootDurationMs: number;
    /** `coveredMs` measures the temporal union of observed intervals within the root. */
    coveredMs: number;
    /** `uncoveredMs` measures uninstrumented root time, and `coveredMs + uncoveredMs` equals `rootDurationMs`. */
    uncoveredMs: number;
    /** The clipped inclusive-child-duration sum may exceed `rootDurationMs` and is diagnostic only.
     * */
    inclusiveSumMs: number;
    overlapMs: number;
    /** A containment exclusive equals a span's duration minus the temporal union of its direct children.
     * Containment exclusives diagnose a property separate from temporal conservation. */
    exclusive: readonly {
        spanId: number;
        stage: SearchTraceStage;
        lane: SearchTraceLane;
        exclusiveMs: number;
    }[];
    /** The dependency critical path is diagnostic; it need not partition wall time.
     * */
    criticalPathMs: number;
    criticalPath: readonly number[];
    work: WorkEvidence;
}

/**
 * */
function validateIntervalGraph(spans: readonly SearchTraceSpan[]): void {
    const byId = new Map<number, SearchTraceSpan>();
    for (const span of spans) {
        if (byId.has(span.id)) throw new TimingError(`duplicate span id ${span.id}`);
        byId.set(span.id, span);
    }
    const root = spans.find((span) => span.stage === "root");
    if (root && root.parentId !== null) {
        throw new TimingError(`root span ${root.id} must not have a parent`);
    }
    for (const span of spans) {
        if (span.parentId === null) continue;
        const parent = byId.get(span.parentId);
        if (!parent) {
            throw new TimingError(`span ${span.id} references unknown parent ${span.parentId}`);
        }
        if (span.startMs < parent.startMs || span.endMs > parent.endMs) {
            throw new TimingError(
                `span ${span.id} extends outside its parent ${parent.id} interval`,
            );
        }
    }
    // Parent chains must terminate (no cycles).
    for (const span of spans) {
        const seen = new Set<number>();
        let current: SearchTraceSpan | undefined = span;
        while (current && current.parentId !== null) {
            if (seen.has(current.id)) {
                throw new TimingError(`parent cycle through span ${current.id}`);
            }
            seen.add(current.id);
            current = byId.get(current.parentId);
        }
    }
    // A span outside the root rejects, whether parented or not.
    if (root) {
        for (const span of spans) {
            if (span.id === root.id) continue;
            if (span.startMs < root.startMs || span.endMs > root.endMs) {
                throw new TimingError(`span ${span.id} lies outside the root window`);
            }
        }
    }
}

/**
 * `toleranceMs` bounds the allowed temporal-conservation gap.
 */
export function traceTimingEvidence(
    spans: readonly SearchTraceSpan[],
    options: { indexBuildMs?: number | null; toleranceMs?: number } = {},
): TraceTimingEvidence {
    const analysis = analyzeSearchTrace(spans);
    validateIntervalGraph(spans);

    const toleranceMs = options.toleranceMs ?? 0;
    const conservationGap = Math.abs(
        analysis.coveredMs + analysis.uncoveredMs - analysis.rootDurationMs,
    );
    if (conservationGap > toleranceMs) {
        throw new TimingError(
            `temporal conservation violated: covered ${analysis.coveredMs} + uncovered ${analysis.uncoveredMs} != root ${analysis.rootDurationMs}`,
        );
    }

    const indexBuildMs = options.indexBuildMs ?? null;
    if (indexBuildMs !== null && (!Number.isFinite(indexBuildMs) || indexBuildMs < 0)) {
        throw new TimingError("index build time must be a nonnegative finite number");
    }
    const work: WorkEvidence = {
        decodedVectorBytes: 0,
        cachedVectorBytes: 0,
        vectorCount: 0,
        indexBuildMs,
    };
    for (const span of spans) {
        work.decodedVectorBytes += span.counters.decodedVectorBytes ?? 0;
        work.cachedVectorBytes += span.counters.cachedVectorBytes ?? 0;
        work.vectorCount += span.counters.vectorCount ?? 0;
    }

    const byId = new Map(spans.map((span) => [span.id, span]));
    const exclusive = [...analysis.exclusiveMsBySpan.entries()]
        .sort(([a], [b]) => a - b)
        .map(([spanId, exclusiveMs]) => {
            const span = byId.get(spanId);
            if (!span) throw new TimingError(`exclusive time for unknown span ${spanId}`);
            return { spanId, stage: span.stage, lane: span.lane, exclusiveMs };
        });

    return {
        timingPolicyVersion: TIMING_POLICY_VERSION,
        rootDurationMs: analysis.rootDurationMs,
        coveredMs: analysis.coveredMs,
        uncoveredMs: analysis.uncoveredMs,
        inclusiveSumMs: analysis.inclusiveSumMs,
        overlapMs: analysis.overlapMs,
        exclusive,
        criticalPathMs: analysis.criticalPathMs,
        criticalPath: analysis.criticalPath,
        work,
    };
}
