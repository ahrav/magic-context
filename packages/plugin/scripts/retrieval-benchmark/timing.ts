/**
 * Versioned timing contract (U4: R55-R57, KTD8/KTD10).
 *
 * Two independent concerns, deliberately separated:
 *
 * 1. Percentiles. ONE versioned nearest-rank rule computes p50/p95 from
 *    retained raw samples; summaries always carry their samples so any
 *    aggregate can be recomputed from raw evidence (R60, KTD10).
 *
 * 2. Trace accounting. Report-facing validation over U1's
 *    `analyzeSearchTrace`: the temporal-conservation invariant (union of
 *    in-root intervals + uncovered root time = root wall time) is validated
 *    separately from containment exclusives and the dependency critical
 *    path, and summed inclusive stage durations are NEVER treated as
 *    elapsed time (R56). Invalid interval graphs — parent cycles, unknown
 *    parents, duplicate span ids, children outside their parent, spans
 *    outside the root, negative durations, missing/duplicate roots — reject
 *    deterministically before any number is reported.
 *
 * Work evidence (R57): decoded vector bytes are summed from exact per-span
 * BLOB/buffer byte counters; fixture index-build time is carried as a
 * separate field and never folded into query latency.
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
 * The one versioned percentile rule: nearest-rank over a sorted ascending
 * copy, rank = ceil(p/100 * n), one-based. No interpolation, so a reported
 * percentile is always an actually observed sample.
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
    /** Raw samples retained in observation order (KTD10, R60). */
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
// Report-facing trace accounting.
// ---------------------------------------------------------------------------

export interface WorkEvidence {
    /** Exact decoded BLOB/vector-buffer bytes summed across spans (R57). */
    decodedVectorBytes: number;
    /** Warm cache vector-buffer bytes touched across spans. */
    cachedVectorBytes: number;
    vectorCount: number;
    /** Fixture index-build time; separate evidence, never query latency. */
    indexBuildMs: number | null;
}

export interface TraceTimingEvidence {
    timingPolicyVersion: typeof TIMING_POLICY_VERSION;
    /** Root wall time — the ONLY elapsed-time figure (R56). */
    rootDurationMs: number;
    /** Temporal union of in-root observed intervals. */
    coveredMs: number;
    /** Uninstrumented root time. Conservation: covered + uncovered = root. */
    uncoveredMs: number;
    /** Sum of clipped inclusive child durations. May exceed rootDurationMs;
     *  a diagnostic only, never elapsed time. */
    inclusiveSumMs: number;
    overlapMs: number;
    /** Containment exclusives: per-span duration minus its direct children's
     *  temporal union. Separate diagnostic from conservation. */
    exclusive: readonly {
        spanId: number;
        stage: SearchTraceStage;
        lane: SearchTraceLane;
        exclusiveMs: number;
    }[];
    /** Dependency critical path: separate diagnostic, never forced to
     *  partition wall time (KTD8). */
    criticalPathMs: number;
    criticalPath: readonly number[];
    work: WorkEvidence;
}

/** Structural interval-graph validation beyond `analyzeSearchTrace`:
 *  duplicate ids, unknown parents, parent cycles, child-outside-parent, and
 *  non-root spans outside the root window all reject deterministically. */
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
    // Root coverage: every non-root span must lie within the root window,
    // parented or not — a span outside the root breaks conservation.
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
 * Validate one completed trace graph and produce report-facing timing and
 * work evidence. Delegates clock-domain, duration, single-root, and
 * dependency-cycle rejection to U1's `analyzeSearchTrace`, then enforces
 * the containment structure a report may rely on, and finally checks the
 * temporal-conservation invariant within `toleranceMs` (clock resolution).
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
