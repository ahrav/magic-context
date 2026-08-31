import { describe, expect, it } from "bun:test";

import {
    SEARCH_TRACE_SCHEMA_VERSION,
    type SearchTraceSpan,
} from "../../src/features/magic-context/search-trace";
import {
    nearestRankPercentile,
    summarizeLatency,
    TIMING_POLICY_VERSION,
    TimingError,
    traceTimingEvidence,
} from "./timing";

function span(overrides: Partial<SearchTraceSpan> & Pick<SearchTraceSpan, "id">): SearchTraceSpan {
    return {
        schemaVersion: SEARCH_TRACE_SCHEMA_VERSION,
        parentId: null,
        dependsOn: [],
        stage: "vector_scan",
        lane: "memory",
        startMs: 0,
        endMs: 0,
        status: "ok",
        counters: {},
        clockDomain: "test",
        ...overrides,
    };
}

describe("nearestRankPercentile", () => {
    it("matches the versioned nearest-rank golden examples", () => {
        // n=4: p50 rank = ceil(0.5*4) = 2 -> second smallest; p95 rank = 4.
        expect(nearestRankPercentile([40, 10, 30, 20], 50)).toBe(20);
        expect(nearestRankPercentile([40, 10, 30, 20], 95)).toBe(40);
        const hundred = Array.from({ length: 100 }, (_, i) => 100 - i);
        expect(nearestRankPercentile(hundred, 50)).toBe(50);
        expect(nearestRankPercentile(hundred, 95)).toBe(95);
        expect(nearestRankPercentile(hundred, 100)).toBe(100);
        // For n=3, p50 has rank ceil(1.5) = 2 and is never an interpolated midpoint.
        expect(nearestRankPercentile([1, 2, 10], 50)).toBe(2);
        expect(nearestRankPercentile([7], 95)).toBe(7);
    });

    it("rejects empty samples, out-of-range percentiles, and invalid values", () => {
        expect(() => nearestRankPercentile([], 50)).toThrow(TimingError);
        expect(() => nearestRankPercentile([1], 0)).toThrow(TimingError);
        expect(() => nearestRankPercentile([1], 101)).toThrow(TimingError);
        expect(() => nearestRankPercentile([Number.NaN], 50)).toThrow(TimingError);
        expect(() => nearestRankPercentile([-1], 50)).toThrow(TimingError);
    });

    it("summarizeLatency retains raw samples in observation order", () => {
        const summary = summarizeLatency([5, 3, 9, 1]);
        expect(summary).toEqual({
            timingPolicyVersion: TIMING_POLICY_VERSION,
            sampleCount: 4,
            p50Ms: 3,
            p95Ms: 9,
            samplesMs: [5, 3, 9, 1],
        });
        // Summaries are recomputable from the retained samples.
        expect(nearestRankPercentile(summary.samplesMs, 50)).toBe(summary.p50Ms);
        expect(nearestRankPercentile(summary.samplesMs, 95)).toBe(summary.p95Ms);
    });
});

describe("traceTimingEvidence", () => {
    const validSpans: SearchTraceSpan[] = [
        span({ id: 1, stage: "root", lane: "unified", startMs: 0, endMs: 95 }),
        span({
            id: 2,
            stage: "lexical_scan",
            lane: "message",
            parentId: 1,
            startMs: 10,
            endMs: 50,
        }),
        span({
            id: 3,
            stage: "vector_scan",
            lane: "memory",
            parentId: 1,
            startMs: 30,
            endMs: 80,
            counters: { decodedVectorBytes: 1000, vectorCount: 4 },
        }),
        span({
            id: 4,
            stage: "fusion",
            lane: "unified",
            parentId: 1,
            dependsOn: [2, 3],
            startMs: 80,
            endMs: 90,
            counters: { cachedVectorBytes: 200 },
        }),
    ];

    it("conserves temporal coverage while the inclusive sum exceeds root time (AE5)", () => {
        const evidence = traceTimingEvidence(validSpans);
        // Inclusive sum 40+50+10 = 100 > 95 root ms: never elapsed time.
        expect(evidence.inclusiveSumMs).toBe(100);
        expect(evidence.rootDurationMs).toBe(95);
        // Temporal union [10,90] = 80; overlap of the two scans = 20.
        expect(evidence.coveredMs).toBe(80);
        expect(evidence.overlapMs).toBe(20);
        // Conservation: covered + uncovered accounts for root wall time.
        expect(evidence.uncoveredMs).toBe(15);
        expect(evidence.coveredMs + evidence.uncoveredMs).toBe(evidence.rootDurationMs);
    });

    it("reports the dependency critical path as an independent diagnostic", () => {
        const evidence = traceTimingEvidence(validSpans);
        // The critical path is vector_scan (50 ms) plus fusion (10 ms), not the 80 ms temporal union.
        expect(evidence.criticalPathMs).toBe(60);
        expect(evidence.criticalPath).toEqual([3, 4]);
        expect(evidence.criticalPathMs).not.toBe(evidence.coveredMs);
    });

    it("reports containment exclusives per span", () => {
        const evidence = traceTimingEvidence(validSpans);
        const root = evidence.exclusive.find((entry) => entry.spanId === 1);
        // Root exclusive: 95 - union([10,90]) = 15 (its uncovered time).
        expect(root?.exclusiveMs).toBe(15);
        // Leaf spans have no children: exclusive = inclusive.
        expect(evidence.exclusive.find((entry) => entry.spanId === 2)?.exclusiveMs).toBe(40);
        expect(evidence.exclusive.map((entry) => entry.spanId)).toEqual([1, 2, 3, 4]);
    });

    it("sums exact vector byte counters and carries index-build time separately", () => {
        const evidence = traceTimingEvidence(validSpans, { indexBuildMs: 1234 });
        expect(evidence.work).toEqual({
            decodedVectorBytes: 1000,
            cachedVectorBytes: 200,
            vectorCount: 4,
            indexBuildMs: 1234,
        });
        // Index-build time never folds into query latency.
        expect(evidence.rootDurationMs).toBe(95);
        expect(traceTimingEvidence(validSpans).work.indexBuildMs).toBeNull();
        expect(() => traceTimingEvidence(validSpans, { indexBuildMs: -1 })).toThrow(TimingError);
    });

    // Each row feeds one malformed span graph to `traceTimingEvidence` and
    // asserts the named structural rejection.
    it.each([
        [
            "rejects negative durations",
            [
                span({ id: 1, stage: "root", lane: "unified", startMs: 0, endMs: 100 }),
                span({ id: 2, parentId: 1, startMs: 50, endMs: 40 }),
            ],
            /negative duration/,
        ],
        [
            "rejects a graph with no root",
            [span({ id: 2, startMs: 0, endMs: 10 })],
            /exactly one root/,
        ],
        [
            "rejects a graph with two roots",
            [
                span({ id: 1, stage: "root", lane: "unified", startMs: 0, endMs: 10 }),
                span({ id: 2, stage: "root", lane: "unified", startMs: 0, endMs: 10 }),
            ],
            /exactly one root/,
        ],
        [
            "rejects a child extending outside its parent",
            [
                span({ id: 1, stage: "root", lane: "unified", startMs: 0, endMs: 100 }),
                span({ id: 2, parentId: 1, startMs: 10, endMs: 40 }),
                span({ id: 3, parentId: 2, startMs: 30, endMs: 60 }),
            ],
            /outside its parent/,
        ],
        [
            "rejects a span outside the root window",
            [
                span({ id: 1, stage: "root", lane: "unified", startMs: 10, endMs: 100 }),
                span({ id: 2, startMs: 0, endMs: 5 }),
            ],
            /outside the root window/,
        ],
        [
            "rejects an unknown parent id",
            [
                span({ id: 1, stage: "root", lane: "unified", startMs: 0, endMs: 100 }),
                span({ id: 2, parentId: 99, startMs: 0, endMs: 10 }),
            ],
            /unknown parent/,
        ],
        [
            "rejects duplicate span ids",
            [
                span({ id: 1, stage: "root", lane: "unified", startMs: 0, endMs: 100 }),
                span({ id: 2, parentId: 1, startMs: 0, endMs: 10 }),
                span({ id: 2, parentId: 1, startMs: 0, endMs: 10 }),
            ],
            /duplicate span id/,
        ],
        [
            "rejects parent cycles",
            [
                span({ id: 1, stage: "root", lane: "unified", startMs: 0, endMs: 100 }),
                span({ id: 2, parentId: 3, startMs: 0, endMs: 10 }),
                span({ id: 3, parentId: 2, startMs: 0, endMs: 10 }),
            ],
            /parent cycle/,
        ],
        [
            "rejects dependency cycles",
            [
                span({ id: 1, stage: "root", lane: "unified", startMs: 0, endMs: 100 }),
                span({ id: 2, parentId: 1, dependsOn: [3], startMs: 0, endMs: 10 }),
                span({ id: 3, parentId: 1, dependsOn: [2], startMs: 0, endMs: 10 }),
            ],
            /cycle/,
        ],
        [
            "rejects mixed clock domains",
            [
                span({ id: 1, stage: "root", lane: "unified", startMs: 0, endMs: 100 }),
                span({ id: 2, parentId: 1, startMs: 0, endMs: 10, clockDomain: "other" }),
            ],
            /clock domains/,
        ],
        [
            "rejects a root span that itself has a parent",
            [
                span({ id: 1, stage: "root", lane: "unified", parentId: 2, startMs: 0, endMs: 9 }),
                span({ id: 2, startMs: 0, endMs: 9 }),
            ],
            /must not have a parent/,
        ],
    ] as Array<[string, Parameters<typeof traceTimingEvidence>[0], RegExp]>)(
        "%s",
        (_title, spans, message) => {
            expect(() => traceTimingEvidence(spans)).toThrow(message);
        },
    );

    it("carries the versioned timing policy identifier", () => {
        expect(TIMING_POLICY_VERSION).toBe("retrieval-timing-policy/v1");
        expect(traceTimingEvidence(validSpans).timingPolicyVersion).toBe(TIMING_POLICY_VERSION);
    });
});
