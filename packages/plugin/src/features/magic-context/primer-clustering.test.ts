/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cosineSimilarity } from "./memory/cosine-similarity";
import {
    buildPrimerClusters,
    clusterEligibleForPromotion,
    PRIMER_CLUSTER_HYSTERESIS,
    PRIMER_CLUSTER_THRESHOLD,
    summarizePrimerCluster,
} from "./primer-clustering";
import { type Primer, type PrimerCandidate, primerOccurrenceKey } from "./storage-primers";

function candidate(overrides: Partial<PrimerCandidate>): PrimerCandidate {
    return {
        id: overrides.id ?? 1,
        projectPath: overrides.projectPath ?? "git:abc",
        harness: overrides.harness ?? "opencode",
        sessionId: overrides.sessionId ?? "ses",
        question: overrides.question ?? "How does caching work?",
        normalizedQuestion: overrides.normalizedQuestion ?? "how does caching work",
        sourceCompartmentStart: overrides.sourceCompartmentStart ?? 1,
        sourceCompartmentEnd: overrides.sourceCompartmentEnd ?? 5,
        sourceStartMessageId: overrides.sourceStartMessageId ?? `start_${overrides.id ?? 1}`,
        sourceEndMessageId: overrides.sourceEndMessageId ?? `end_${overrides.id ?? 1}`,
        sourceMessageTime: overrides.sourceMessageTime ?? Date.UTC(2026, 0, 1),
        questionEmbedding: overrides.questionEmbedding ?? new Float32Array([1, 0]),
        questionEmbeddingModelId: overrides.questionEmbeddingModelId ?? "model-a",
        createdAt: overrides.createdAt ?? Date.UTC(2026, 0, 1),
    };
}

describe("primer clustering", () => {
    it("counts recurrence by unique UTC occurrence days, not raw candidate rows", () => {
        const clusters = buildPrimerClusters({
            activePrimers: [],
            candidates: [
                candidate({
                    id: 2,
                    sourceMessageTime: Date.UTC(2026, 0, 8),
                    sourceStartMessageId: "s2",
                    sourceEndMessageId: "e2",
                }),
                candidate({
                    id: 1,
                    sourceMessageTime: Date.UTC(2026, 0, 1),
                    sourceStartMessageId: "s1",
                    sourceEndMessageId: "e1",
                }),
                candidate({
                    id: 3,
                    sourceMessageTime: Date.UTC(2026, 0, 1, 12),
                    sourceStartMessageId: "s3",
                    sourceEndMessageId: "e3",
                }),
            ],
        });

        expect(clusters).toHaveLength(1);
        const summary = summarizePrimerCluster(clusters[0]);
        expect(summary.support).toBe(2);
        expect(summary.spanDays).toBe(7);
        expect(clusterEligibleForPromotion(summary, 2, 7)).toBe(true);
    });

    it("is deterministic regardless of input order", () => {
        const inputs = [
            candidate({ id: 1, sourceStartMessageId: "a", sourceEndMessageId: "b" }),
            candidate({ id: 2, sourceStartMessageId: "c", sourceEndMessageId: "d" }),
            candidate({
                id: 3,
                questionEmbedding: new Float32Array([0, 1]),
                normalizedQuestion: "how do leases work",
                sourceStartMessageId: "e",
                sourceEndMessageId: "f",
            }),
        ];
        const a = buildPrimerClusters({ activePrimers: [], candidates: inputs });
        const b = buildPrimerClusters({ activePrimers: [], candidates: inputs.slice().reverse() });

        expect(a.map((cluster) => cluster.candidates.map((c) => c.id))).toEqual(
            b.map((cluster) => cluster.candidates.map((c) => c.id)),
        );
    });

    it("keeps Primers cache-neutral in v1", () => {
        const inject = readFileSync(
            join(import.meta.dir, "../../hooks/magic-context/inject-compartments.ts"),
            "utf8",
        );
        expect(inject).not.toContain("primer");
        expect(inject).not.toContain("Primer");
    });
});

// ---------------------------------------------------------------------------
// U6 — incremental centroid maintenance (R39).
//
// The reference below is the recomputing implementation this unit replaced. It
// exists only here, so production keeps one centroid path while the tests still
// prove numerical, membership, and complexity parity.
// ---------------------------------------------------------------------------

function referenceAverageVectors(vectors: Float32Array[]): Float32Array | null {
    if (vectors.length === 0) return null;
    const dims = vectors[0].length;
    if (dims === 0) return null;
    const out = new Float32Array(dims);
    for (const vector of vectors) {
        if (vector.length !== dims) return null;
        for (let i = 0; i < dims; i += 1) out[i] += vector[i];
    }
    for (let i = 0; i < dims; i += 1) out[i] /= vectors.length;
    return out;
}

interface ReferenceCluster {
    primer: Primer | null;
    candidates: PrimerCandidate[];
    centroid: Float32Array | null;
    modelId: string | null;
}

function referenceSameSpace(candidateRow: PrimerCandidate, modelId: string | null): boolean {
    return Boolean(
        candidateRow.questionEmbedding &&
            candidateRow.questionEmbeddingModelId &&
            modelId &&
            candidateRow.questionEmbeddingModelId === modelId,
    );
}

function referenceRecompute(cluster: ReferenceCluster): void {
    const vectors = cluster.candidates
        .filter((entry) => referenceSameSpace(entry, cluster.modelId))
        .map((entry) => entry.questionEmbedding)
        .filter((vector): vector is Float32Array => Boolean(vector));
    if (vectors.length > 0) {
        cluster.centroid = referenceAverageVectors(vectors);
        return;
    }
    if (cluster.primer?.questionEmbedding) {
        cluster.centroid = new Float32Array(cluster.primer.questionEmbedding);
    }
}

/** Recomputing equivalent of `buildPrimerClusters`, used for differential checks. */
function referenceBuildClusters(args: {
    candidates: PrimerCandidate[];
    activePrimers: Primer[];
    threshold?: number;
    hysteresis?: number;
}): ReferenceCluster[] {
    const threshold = args.threshold ?? PRIMER_CLUSTER_THRESHOLD;
    const hysteresis = args.hysteresis ?? PRIMER_CLUSTER_HYSTERESIS;
    const clusters: ReferenceCluster[] = args.activePrimers
        .slice()
        .sort((a, b) => a.id - b.id)
        .map((primer) => ({
            primer,
            candidates: [],
            centroid: primer.questionEmbedding ? new Float32Array(primer.questionEmbedding) : null,
            modelId: primer.questionEmbeddingModelId,
        }));
    const sortKey = (entry: PrimerCandidate) => `${primerOccurrenceKey(entry)}\u001f${entry.id}`;
    const sorted = args.candidates.slice().sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

    for (const entry of sorted) {
        let best: { cluster: ReferenceCluster; score: number } | null = null;
        for (const cluster of clusters) {
            let score = Number.NEGATIVE_INFINITY;
            if (
                entry.questionEmbedding &&
                cluster.centroid &&
                referenceSameSpace(entry, cluster.modelId)
            ) {
                score = cosineSimilarity(entry.questionEmbedding, cluster.centroid);
            } else {
                const first = cluster.candidates[0];
                const textMatch = first
                    ? first.normalizedQuestion === entry.normalizedQuestion
                    : cluster.primer?.question.toLowerCase().trim() === entry.normalizedQuestion;
                if (textMatch) score = 1;
            }
            const stickier = cluster.primer?.sourceCandidateIds.includes(entry.id)
                ? threshold - hysteresis
                : threshold;
            if (score >= stickier && (!best || score > best.score)) {
                best = { cluster, score };
            }
        }
        if (best) {
            best.cluster.candidates.push(entry);
            referenceRecompute(best.cluster);
            continue;
        }
        clusters.push({
            primer: null,
            candidates: [entry],
            centroid: entry.questionEmbedding ? new Float32Array(entry.questionEmbedding) : null,
            modelId: entry.questionEmbeddingModelId,
        });
    }
    return clusters;
}

function shape(
    clusters: ReadonlyArray<{
        candidates: PrimerCandidate[];
        centroid: Float32Array | null;
        modelId: string | null;
    }>,
) {
    return clusters.map((cluster) => ({
        ids: cluster.candidates.map((entry) => entry.id),
        modelId: cluster.modelId,
        centroid: cluster.centroid ? [...cluster.centroid] : null,
    }));
}

function makePrimer(overrides: Partial<Primer>): Primer {
    return {
        id: overrides.id ?? 1,
        projectPath: overrides.projectPath ?? "git:abc",
        question: overrides.question ?? "How does caching work?",
        questionEmbedding: overrides.questionEmbedding ?? new Float32Array([1, 0]),
        questionEmbeddingModelId: overrides.questionEmbeddingModelId ?? "model-a",
        answer: overrides.answer ?? "It caches.",
        status: overrides.status ?? "active",
        totalSupport: overrides.totalSupport ?? 2,
        lastObservedAt: overrides.lastObservedAt ?? Date.UTC(2026, 0, 1),
        answerRefreshedAt: overrides.answerRefreshedAt ?? null,
        sourceCandidateIds: overrides.sourceCandidateIds ?? [],
        sourceProvenance: overrides.sourceProvenance ?? null,
        createdAt: overrides.createdAt ?? Date.UTC(2026, 0, 1),
        updatedAt: overrides.updatedAt ?? Date.UTC(2026, 0, 1),
    };
}

describe("primer centroid accumulation (R39)", () => {
    const ordinary = [
        candidate({
            id: 1,
            questionEmbedding: new Float32Array([1, 0]),
            sourceStartMessageId: "a1",
        }),
        candidate({
            id: 2,
            questionEmbedding: new Float32Array([0.99, 0.14]),
            sourceStartMessageId: "a2",
        }),
        candidate({
            id: 3,
            questionEmbedding: new Float32Array([0.98, 0.2]),
            sourceStartMessageId: "a3",
        }),
    ];

    it("matches the recomputing reference for membership, model ids, and centroid bits", () => {
        expect(shape(buildPrimerClusters({ candidates: ordinary, activePrimers: [] }))).toEqual(
            shape(referenceBuildClusters({ candidates: ordinary, activePrimers: [] })),
        );
    });

    it("makes the same assignment for threshold-adjacent adversarial vectors", () => {
        // Cosines land within a few 1e-3 of the 0.85 threshold in both directions.
        const adversarial = [
            candidate({ id: 1, questionEmbedding: new Float32Array([1, 0]) }),
            candidate({
                id: 2,
                questionEmbedding: new Float32Array([0.8503, 0.5262]),
                sourceStartMessageId: "b2",
                normalizedQuestion: "different question two",
            }),
            candidate({
                id: 3,
                questionEmbedding: new Float32Array([0.8497, 0.5272]),
                sourceStartMessageId: "b3",
                normalizedQuestion: "different question three",
            }),
            candidate({
                id: 4,
                questionEmbedding: new Float32Array([0.9999, 0.0141]),
                sourceStartMessageId: "b4",
                normalizedQuestion: "different question four",
            }),
        ];
        expect(shape(buildPrimerClusters({ candidates: adversarial, activePrimers: [] }))).toEqual(
            shape(referenceBuildClusters({ candidates: adversarial, activePrimers: [] })),
        );
    });

    it("produces the same clusters for reversed input", () => {
        const forward = buildPrimerClusters({ candidates: ordinary, activePrimers: [] });
        const reversed = buildPrimerClusters({
            candidates: [...ordinary].reverse(),
            activePrimers: [],
        });
        expect(shape(reversed)).toEqual(shape(forward));
    });

    it("keeps an active primer as the centroid until the first compatible candidate", () => {
        const primer = makePrimer({ id: 7, questionEmbedding: new Float32Array([0, 1]) });
        const incompatible = candidate({
            id: 5,
            questionEmbedding: new Float32Array([1, 0]),
            questionEmbeddingModelId: "model-z",
            normalizedQuestion: "unrelated question",
            sourceStartMessageId: "c5",
        });

        const clusters = buildPrimerClusters({
            candidates: [incompatible],
            activePrimers: [primer],
        });
        const reference = referenceBuildClusters({
            candidates: [incompatible],
            activePrimers: [primer],
        });

        expect(shape(clusters)).toEqual(shape(reference));
        expect([...(clusters[0].centroid ?? [])]).toEqual([0, 1]);
    });

    it("retains reference behavior for missing, zero-length, and mismatched vectors", () => {
        const cases: PrimerCandidate[][] = [
            [
                candidate({ id: 1, questionEmbedding: null, sourceStartMessageId: "d1" }),
                candidate({ id: 2, questionEmbedding: null, sourceStartMessageId: "d2" }),
            ],
            [
                candidate({ id: 1, questionEmbedding: new Float32Array([]) }),
                candidate({
                    id: 2,
                    questionEmbedding: new Float32Array([]),
                    sourceStartMessageId: "e2",
                }),
            ],
            [
                candidate({ id: 1, questionEmbedding: new Float32Array([1, 0]) }),
                candidate({
                    id: 2,
                    questionEmbedding: new Float32Array([1, 0, 0]),
                    sourceStartMessageId: "f2",
                }),
            ],
        ];
        for (const candidates of cases) {
            expect(shape(buildPrimerClusters({ candidates, activePrimers: [] }))).toEqual(
                shape(referenceBuildClusters({ candidates, activePrimers: [] })),
            );
        }
    });

    it("reads each accepted candidate vector once instead of rescanning the cluster", () => {
        const many = Array.from({ length: 30 }, (_, index) =>
            candidate({
                id: index + 1,
                questionEmbedding: new Float32Array([1, 0]),
                sourceStartMessageId: `g${index + 1}`,
                sourceMessageTime: Date.UTC(2026, 0, 1) + index,
            }),
        );
        const count = (
            candidates: PrimerCandidate[],
            build: (rows: PrimerCandidate[]) => unknown,
        ) => {
            let reads = 0;
            const watched = candidates.map(
                (row) =>
                    new Proxy(row, {
                        get(target, prop, receiver) {
                            if (prop === "questionEmbedding") reads += 1;
                            return Reflect.get(target, prop, receiver);
                        },
                    }) as PrimerCandidate,
            );
            build(watched);
            return reads;
        };

        const incremental = count(many, (rows) =>
            buildPrimerClusters({ candidates: rows, activePrimers: [] }),
        );
        const recomputing = count(many, (rows) =>
            referenceBuildClusters({ candidates: rows, activePrimers: [] }),
        );

        // Recomputation rescans the whole cluster on every insert (triangular);
        // accumulation touches each accepted vector a bounded number of times.
        expect(incremental).toBeLessThan(recomputing);
        expect(incremental).toBeLessThan(many.length * 5);
    });
});
