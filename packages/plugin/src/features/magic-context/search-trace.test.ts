/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    _resetCompartmentChunkSearchCacheForTests,
    chunkCanonicalText,
    replaceCompartmentChunkEmbeddings,
} from "./compartment-chunk-embedding";
import { appendCompartments, getCompartments } from "./compartment-storage";
import { saveCommitEmbedding, upsertCommits } from "./git-commits";
import { insertMemory, resetEmbeddingCacheForTests, saveEmbedding } from "./memory";
import { ensureMessagesIndexed } from "./message-index";
import { runMigrations } from "./migrations";
import { _resetProjectEmbeddingRegistryForTests } from "./project-embedding-registry";
import { unifiedSearch } from "./search";
import { CandidateDepthError, MAX_CANDIDATE_DEPTH } from "./search-bounds";
import {
    analyzeSearchTrace,
    assertCandidateDepthSatisfied,
    CandidateDepthMismatchError,
    createSearchTraceRecorder,
    SEARCH_TRACE_SCHEMA_VERSION,
    type SearchTraceCounters,
    type SearchTraceLane,
    type SearchTraceSpan,
    type SearchTraceStage,
} from "./search-trace";
import { countingDatabase } from "./sql-counters";
import { initializeDatabase } from "./storage-db";
import { addNote } from "./storage-notes";
import { createPrimer } from "./storage-primers";

const PROJECT = "git:trace-fixture";
const SESSION = "ses-trace-fixture";
const MODEL = "mock:model";
const QUERY = "queue drain backpressure";
/** Byte length of every seeded Float32Array([1, 0]) vector. */
const VECTOR_BYTES = 8;

const rawMessagesBySession = new Map<
    string,
    Array<{ ordinal: number; id: string; role: string; parts: unknown[] }>
>();
const readMessages = (sessionId: string) => rawMessagesBySession.get(sessionId) ?? [];

function createTestDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function collectingSink() {
    const spans: SearchTraceSpan[] = [];
    return { spans, sink: { onSpan: (span: SearchTraceSpan) => spans.push(span) } };
}

function seedMixedCorpus(db: Database): { memoryId: number; compartmentWindows: number } {
    const memory = insertMemory(db, {
        projectPath: PROJECT,
        category: "ARCHITECTURE_DECISIONS",
        content: "The queue drain path applies backpressure before the retry budget resets.",
    });
    saveEmbedding(db, memory.id, new Float32Array([1, 0]), MODEL);

    createPrimer(db, {
        projectPath: PROJECT,
        question: "How does the queue drain handle backpressure?",
        questionEmbedding: new Float32Array([1, 0]),
        questionEmbeddingModelId: MODEL,
        answer: "It applies backpressure before the retry budget resets.",
        totalSupport: 3,
        lastObservedAt: Date.UTC(2026, 0, 8),
        sourceCandidateIds: [1],
    });

    rawMessagesBySession.set(SESSION, [
        {
            ordinal: 1,
            id: "tr-m1",
            role: "user",
            parts: [{ type: "text", text: "Please make the queue drain apply backpressure." }],
        },
        {
            ordinal: 2,
            id: "tr-m2",
            role: "assistant",
            parts: [{ type: "text", text: "Done: the queue drain now applies backpressure." }],
        },
    ]);
    ensureMessagesIndexed(db, SESSION, readMessages);

    const sha = "a".repeat(40);
    upsertCommits(db, PROJECT, [
        {
            sha,
            shortSha: "aaaaaaa",
            message: "fix(queue): drain applies backpressure before retry budget reset",
            author: "dev@example.com",
            committedAtMs: 1_700_000_000_000,
        },
    ]);
    saveCommitEmbedding(db, sha, new Float32Array([1, 0]), MODEL);

    appendCompartments(db, SESSION, [
        {
            sequence: 0,
            startMessage: 1,
            endMessage: 2,
            startMessageId: "tr-m1",
            endMessageId: "tr-m2",
            title: "Queue drain backpressure design",
            content: "P1 content",
            p1: "P1 content",
        },
    ]);
    const compartment = getCompartments(db, SESSION)[0];
    const windows = chunkCanonicalText(
        "[1] U: queue drain backpressure\n[2] A: bounded drains with backpressure",
        1,
        2,
        10_000,
    );
    replaceCompartmentChunkEmbeddings(
        db,
        windows.map((window) => ({
            compartmentId: compartment.id,
            sessionId: SESSION,
            projectPath: PROJECT,
            window,
            modelId: MODEL,
            vector: new Float32Array([1, 0]),
        })),
    );

    const note = addNote(db, "session", {
        sessionId: SESSION,
        content: "Queue drain backpressure needs a regression test.",
        anchorOrdinal: 2,
    });
    // Pin the wall-clock note timestamp so cross-run projections are byte-identical.
    db.prepare("UPDATE notes SET created_at = ?, updated_at = ? WHERE id = ?").run(
        Date.UTC(2026, 1, 1),
        Date.UTC(2026, 1, 1),
        note.id,
    );

    return { memoryId: memory.id, compartmentWindows: windows.length };
}

function baseSearchOptions(extra: Record<string, unknown> = {}) {
    return {
        limit: 10,
        memoryEnabled: true,
        embeddingEnabled: true,
        gitCommitsEnabled: true,
        explicitSearch: true,
        countRetrievals: false,
        measurementDisabled: true,
        embedQuery: async () => new Float32Array([1, 0]),
        isEmbeddingRuntimeEnabled: () => true,
        embeddingModelIdOverride: MODEL,
        chunkModelIdOverride: MODEL,
        ...extra,
    };
}

function spanOf(spans: readonly SearchTraceSpan[], stage: string, lane: string): SearchTraceSpan {
    const found = spans.find((span) => span.stage === stage && span.lane === lane);
    if (!found) {
        throw new Error(
            `expected span ${stage}/${lane}, got: ${spans.map((span) => `${span.stage}/${span.lane}`).join(", ")}`,
        );
    }
    return found;
}

function syntheticSpan(args: {
    id: number;
    stage: SearchTraceStage;
    lane?: SearchTraceLane;
    startMs: number;
    endMs: number;
    parentId?: number | null;
    dependsOn?: number[];
    counters?: SearchTraceCounters;
    clockDomain?: string;
}): SearchTraceSpan {
    return {
        schemaVersion: SEARCH_TRACE_SCHEMA_VERSION,
        id: args.id,
        parentId: args.parentId ?? null,
        dependsOn: args.dependsOn ?? [],
        stage: args.stage,
        lane: args.lane ?? "unified",
        startMs: args.startMs,
        endMs: args.endMs,
        status: "ok",
        counters: args.counters ?? {},
        clockDomain: args.clockDomain ?? "test",
    };
}

afterEach(() => {
    rawMessagesBySession.clear();
    resetEmbeddingCacheForTests();
    _resetCompartmentChunkSearchCacheForTests();
    _resetProjectEmbeddingRegistryForTests();
});

describe("trace neutrality", () => {
    async function runOnce(traceMode: "none" | "noop" | "collect") {
        resetEmbeddingCacheForTests();
        _resetCompartmentChunkSearchCacheForTests();
        rawMessagesBySession.clear();
        const db = createTestDb();
        try {
            const seeded = seedMixedCorpus(db);
            const counter = countingDatabase(db);
            const collected = collectingSink();
            const trace =
                traceMode === "none"
                    ? undefined
                    : traceMode === "noop"
                      ? { sink: { onSpan: () => {} } }
                      : { sink: collected.sink };
            const results = await unifiedSearch(
                counter.db,
                SESSION,
                PROJECT,
                QUERY,
                baseSearchOptions({ trace, countRetrievals: true }),
            );
            const retrievalCount = (
                db
                    .prepare("SELECT retrieval_count AS count FROM memories WHERE id = ?")
                    .get(seeded.memoryId) as { count: number }
            ).count;
            return {
                results: JSON.parse(JSON.stringify(results)) as unknown,
                sql: counter.executions.map((execution) => `${execution.method}:${execution.sql}`),
                retrievalCount,
                spans: collected.spans,
            };
        } finally {
            closeQuietly(db);
        }
    }

    it("returns byte-identical projections and the same SQL and retrieval counts", async () => {
        const none = await runOnce("none");
        const noop = await runOnce("noop");
        const collect = await runOnce("collect");

        expect(JSON.stringify(noop.results)).toBe(JSON.stringify(none.results));
        expect(JSON.stringify(collect.results)).toBe(JSON.stringify(none.results));
        expect(noop.sql).toEqual(none.sql);
        expect(collect.sql).toEqual(none.sql);
        expect(noop.retrievalCount).toBe(none.retrievalCount);
        expect(collect.retrievalCount).toBe(none.retrievalCount);

        const spans = collect.spans;
        expect(spans.filter((span) => span.stage === "root")).toHaveLength(1);
        expect(spanOf(spans, "query_inference", "query").status).toBe("ok");
        expect(spanOf(spans, "reranking", "unified").status).toBe("not_applicable");
        expect(spanOf(spans, "packing", "unified").status).toBe("not_applicable");
        const analysis = analyzeSearchTrace(spans);
        expect(analysis.coveredMs + analysis.uncoveredMs).toBeCloseTo(analysis.rootDurationMs, 6);
    });
});

describe("candidate-depth seam", () => {
    function seedMessageCorpus(db: Database, count: number) {
        rawMessagesBySession.set(
            SESSION,
            Array.from({ length: count }, (_, index) => ({
                ordinal: index + 1,
                id: `depth-m${index + 1}`,
                role: index % 2 === 0 ? "user" : "assistant",
                parts: [{ type: "text", text: `queue drain item ${index + 1} with extra words` }],
            })),
        );
        ensureMessagesIndexed(db, SESSION, readMessages);
    }

    async function runWithDepth(db: Database, candidateDepth: number) {
        const counter = countingDatabase(db);
        const collected = collectingSink();
        const results = await unifiedSearch(counter.db, SESSION, PROJECT, "queue drain", {
            limit: 5,
            sources: ["message"],
            embeddingEnabled: false,
            countRetrievals: false,
            measurementDisabled: true,
            candidateDepth,
            trace: { sink: collected.sink },
        });
        const ftsBindings = counter
            .matching("message_history_fts MATCH")
            .flatMap((execution) => execution.bindings);
        return { results, spans: collected.spans, ftsBindings };
    }

    it("executes different candidate/top-K work at K=50 vs K=100 with unchanged delivery", async () => {
        const db = createTestDb();
        try {
            seedMessageCorpus(db, 60);
            const k50 = await runWithDepth(db, 50);
            const k100 = await runWithDepth(db, 100);

            const lane50 = spanOf(k50.spans, "lexical_scan", "message");
            const lane100 = spanOf(k100.spans, "lexical_scan", "message");
            expect(lane50.counters.requestedK).toBe(50);
            expect(lane50.counters.effectiveK).toBe(50);
            expect(lane50.counters.candidatesOut).toBe(50);
            expect(lane100.counters.requestedK).toBe(100);
            expect(lane100.counters.effectiveK).toBe(100);
            expect(lane100.counters.candidatesOut).toBe(60);
            expect(k50.ftsBindings).toContain(50);
            expect(k100.ftsBindings).toContain(100);

            expect(k50.results).toHaveLength(5);
            expect(k100.results).toHaveLength(5);

            assertCandidateDepthSatisfied(k50.spans, 50);
            assertCandidateDepthSatisfied(k100.spans, 100);
        } finally {
            closeQuietly(db);
        }
    });

    it("rejects out-of-range candidate depths before any database work", async () => {
        const db = createTestDb();
        try {
            seedMessageCorpus(db, 3);
            for (const depth of [MAX_CANDIDATE_DEPTH + 1, 0, 2.5, Number.NaN]) {
                const counter = countingDatabase(db);
                let error: unknown = null;
                try {
                    await unifiedSearch(counter.db, SESSION, PROJECT, "queue drain", {
                        sources: ["message"],
                        embeddingEnabled: false,
                        measurementDisabled: true,
                        countRetrievals: false,
                        candidateDepth: depth,
                    });
                } catch (caught) {
                    error = caught;
                }
                expect(error).toBeInstanceOf(CandidateDepthError);
                expect(counter.executions).toHaveLength(0);
            }
        } finally {
            closeQuietly(db);
        }
    });

    it("rejects requested/effective candidate-K mismatch evidence", () => {
        const matching = [
            syntheticSpan({ id: 1, stage: "root", startMs: 0, endMs: 10 }),
            syntheticSpan({
                id: 2,
                stage: "top_k",
                lane: "memory",
                startMs: 0,
                endMs: 5,
                parentId: 1,
                counters: { requestedK: 100, effectiveK: 100 },
            }),
        ];
        expect(() => assertCandidateDepthSatisfied(matching, 100)).not.toThrow();

        const mismatched = [
            matching[0],
            syntheticSpan({
                id: 2,
                stage: "top_k",
                lane: "memory",
                startMs: 0,
                endMs: 5,
                parentId: 1,
                counters: { requestedK: 100, effectiveK: 50 },
            }),
        ];
        expect(() => assertCandidateDepthSatisfied(mismatched)).toThrow(
            CandidateDepthMismatchError,
        );
        expect(() => assertCandidateDepthSatisfied(matching, 50)).toThrow(
            CandidateDepthMismatchError,
        );
    });
});

describe("timing accounting", () => {
    it("produces exact root, union, overlap, exclusive, critical-path, and uncovered values", () => {
        const ticks = [0, 0, 40, 60, 110, 120];
        let tick = 0;
        const collected = collectingSink();
        const recorder = createSearchTraceRecorder({
            sink: collected.sink,
            now: () => ticks[Math.min(tick++, ticks.length - 1)],
            clockDomain: "manual",
        });

        const root = recorder.begin("root", "unified");
        const lexical = recorder.begin("lexical_scan", "message", { parent: root.id });
        const dense = recorder.begin("vector_scan", "memory", {
            parent: root.id,
            dependsOn: [lexical.id],
        });
        lexical.end("ok");
        dense.end("ok");
        root.end("ok");
        expect(recorder.hasOpenSpans()).toBe(false);

        const analysis = analyzeSearchTrace(collected.spans);
        expect(analysis.rootDurationMs).toBe(120);
        expect(analysis.inclusiveSumMs).toBe(130);
        expect(analysis.coveredMs).toBe(110);
        expect(analysis.overlapMs).toBe(20);
        expect(analysis.uncoveredMs).toBe(10);
        expect(analysis.coveredMs + analysis.uncoveredMs).toBe(analysis.rootDurationMs);
        expect(analysis.exclusiveMsBySpan.get(root.id)).toBe(10);
        expect(analysis.exclusiveMsBySpan.get(lexical.id)).toBe(60);
        expect(analysis.exclusiveMsBySpan.get(dense.id)).toBe(70);
        expect(analysis.criticalPathMs).toBe(130);
        expect(analysis.criticalPath).toEqual([lexical.id, dense.id]);
    });

    it("conserves wall time for overlapping non-nested lanes whose inclusive sum exceeds root", () => {
        const spans = [
            syntheticSpan({ id: 1, stage: "root", startMs: 0, endMs: 100 }),
            syntheticSpan({
                id: 2,
                stage: "lexical_scan",
                lane: "message",
                startMs: 0,
                endMs: 70,
                parentId: 1,
            }),
            syntheticSpan({
                id: 3,
                stage: "vector_scan",
                lane: "memory",
                startMs: 30,
                endMs: 95,
                parentId: 1,
            }),
        ];
        const analysis = analyzeSearchTrace(spans);
        expect(analysis.inclusiveSumMs).toBe(135);
        expect(analysis.inclusiveSumMs).toBeGreaterThan(analysis.rootDurationMs);
        expect(analysis.overlapMs).toBe(40);
        expect(analysis.coveredMs).toBe(95);
        expect(analysis.uncoveredMs).toBe(5);
        expect(analysis.coveredMs + analysis.uncoveredMs).toBe(analysis.rootDurationMs);
    });

    it("refuses to merge spans from different clock domains into one graph", () => {
        const spans = [
            syntheticSpan({ id: 1, stage: "root", startMs: 0, endMs: 100, clockDomain: "pid:1" }),
            syntheticSpan({
                id: 2,
                stage: "vector_scan",
                lane: "memory",
                startMs: 0,
                endMs: 50,
                parentId: 1,
                clockDomain: "pid:2",
            }),
        ];
        expect(() => analyzeSearchTrace(spans)).toThrow(/clock domains/);
    });

    it("rejects negative durations, missing roots, and dependency cycles", () => {
        expect(() =>
            analyzeSearchTrace([syntheticSpan({ id: 1, stage: "root", startMs: 10, endMs: 5 })]),
        ).toThrow(/negative duration/);
        expect(() =>
            analyzeSearchTrace([
                syntheticSpan({
                    id: 1,
                    stage: "vector_scan",
                    lane: "memory",
                    startMs: 0,
                    endMs: 5,
                }),
            ]),
        ).toThrow(/exactly one root/);
        expect(() =>
            analyzeSearchTrace([
                syntheticSpan({ id: 1, stage: "root", startMs: 0, endMs: 10 }),
                syntheticSpan({
                    id: 2,
                    stage: "vector_scan",
                    lane: "memory",
                    startMs: 0,
                    endMs: 5,
                    parentId: 1,
                    dependsOn: [3],
                }),
                syntheticSpan({
                    id: 3,
                    stage: "lexical_scan",
                    lane: "message",
                    startMs: 0,
                    endMs: 5,
                    parentId: 1,
                    dependsOn: [2],
                }),
            ]),
        ).toThrow(/cycle/);
    });
});

describe("embedding terminal statuses", () => {
    it("records a failed embedding span, leaves no open trace, and matches untraced results", async () => {
        const db = createTestDb();
        try {
            seedMixedCorpus(db);
            const failingEmbed = async () => {
                throw new Error("provider exploded");
            };
            const untraced = await unifiedSearch(
                db,
                SESSION,
                PROJECT,
                QUERY,
                baseSearchOptions({ embedQuery: failingEmbed }),
            );
            const collected = collectingSink();
            const traced = await unifiedSearch(
                db,
                SESSION,
                PROJECT,
                QUERY,
                baseSearchOptions({ embedQuery: failingEmbed, trace: { sink: collected.sink } }),
            );

            expect(JSON.stringify(traced)).toBe(JSON.stringify(untraced));
            expect(spanOf(collected.spans, "query_inference", "query").status).toBe("failed");
            expect(spanOf(collected.spans, "root", "unified").status).toBe("ok");
            expect(() => analyzeSearchTrace(collected.spans)).not.toThrow();
        } finally {
            closeQuietly(db);
        }
    });

    it("records a cancelled embedding span when the caller's signal aborted", async () => {
        const db = createTestDb();
        try {
            seedMixedCorpus(db);
            const controller = new AbortController();
            const abortingEmbed = async () => {
                controller.abort();
                const error = new Error("aborted");
                error.name = "AbortError";
                throw error;
            };
            const collected = collectingSink();
            await unifiedSearch(
                db,
                SESSION,
                PROJECT,
                QUERY,
                baseSearchOptions({
                    embedQuery: abortingEmbed,
                    signal: controller.signal,
                    trace: { sink: collected.sink },
                }),
            );
            expect(spanOf(collected.spans, "query_inference", "query").status).toBe("cancelled");
            expect(() => analyzeSearchTrace(collected.spans)).not.toThrow();
        } finally {
            closeQuietly(db);
        }
    });
});

describe("vector byte counters", () => {
    it("records exact decoded bytes on cache miss and touched bytes on cache hit", async () => {
        const db = createTestDb();
        try {
            const seeded = seedMixedCorpus(db);
            const compartmentBytes = seeded.compartmentWindows * VECTOR_BYTES;

            const cold = collectingSink();
            await unifiedSearch(
                db,
                SESSION,
                PROJECT,
                QUERY,
                baseSearchOptions({ trace: { sink: cold.sink } }),
            );

            const compartmentCold = spanOf(cold.spans, "vector_scan", "compartment");
            expect(compartmentCold.counters.cacheHit).toBe(false);
            expect(compartmentCold.counters.decodedVectorBytes).toBe(compartmentBytes);
            expect(compartmentCold.counters.vectorCount).toBe(seeded.compartmentWindows);

            const commitCold = spanOf(cold.spans, "vector_scan", "git_commit");
            expect(commitCold.counters.cacheHit).toBe(false);
            expect(commitCold.counters.decodedVectorBytes).toBe(VECTOR_BYTES);
            expect(commitCold.counters.vectorCount).toBe(1);

            const primerCold = spanOf(cold.spans, "vector_scan", "primer");
            expect(primerCold.counters.cacheHit).toBe(false);
            expect(primerCold.counters.decodedVectorBytes).toBe(VECTOR_BYTES);
            expect(primerCold.counters.vectorCount).toBe(1);

            const warm = collectingSink();
            await unifiedSearch(
                db,
                SESSION,
                PROJECT,
                QUERY,
                baseSearchOptions({ trace: { sink: warm.sink } }),
            );

            const compartmentWarm = spanOf(warm.spans, "vector_scan", "compartment");
            expect(compartmentWarm.counters.cacheHit).toBe(true);
            expect(compartmentWarm.counters.decodedVectorBytes).toBe(0);
            expect(compartmentWarm.counters.cachedVectorBytes).toBe(compartmentBytes);

            expect(spanOf(warm.spans, "vector_scan", "git_commit").counters.cacheHit).toBe(false);
            expect(spanOf(warm.spans, "vector_scan", "primer").counters.cacheHit).toBe(false);
        } finally {
            closeQuietly(db);
        }
    });
});
