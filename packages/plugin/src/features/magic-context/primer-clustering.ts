import { cosineSimilarity } from "./memory/cosine-similarity";
import type { Primer, PrimerCandidate } from "./storage-primers";
import { primerOccurrenceKey, primerOccurrenceUtcDay } from "./storage-primers";

export const PRIMER_CLUSTER_THRESHOLD = 0.85;
export const PRIMER_CLUSTER_HYSTERESIS = 0.02;
export const PRIMER_PROMOTION_THRESHOLD = 2;
export const PRIMER_MIN_SPAN_DAYS = 7;

export interface PrimerCluster {
    primer: Primer | null;
    candidates: PrimerCandidate[];
    centroid: Float32Array | null;
    modelId: string | null;
}

export interface PrimerClusterSummary {
    candidates: PrimerCandidate[];
    support: number;
    spanDays: number;
    lastObservedAt: number;
    sourceCandidateIds: number[];
    centroid: Float32Array | null;
    modelId: string | null;
}

function cloneVector(vector: Float32Array | null): Float32Array | null {
    return vector ? new Float32Array(vector) : null;
}

function candidateSortKey(candidate: PrimerCandidate): string {
    return `${primerOccurrenceKey(candidate)}\u001f${candidate.id}`;
}

/** `invalid` latches the zero-dimension and dimension-mismatch cases, which
 *  yield no centroid however many vectors follow. */
interface CentroidAccumulator {
    sum: Float32Array | null;
    count: number;
    dims: number;
    invalid: boolean;
}

function createAccumulator(): CentroidAccumulator {
    return { sum: null, count: 0, dims: 0, invalid: false };
}

/** `accumulateVector` preserves caller order so Float32 rounding matches a
 *  left-to-right sum over the candidate sequence. */
function accumulateVector(state: CentroidAccumulator, vector: Float32Array): void {
    state.count += 1;
    if (state.sum === null) {
        state.dims = vector.length;
        if (vector.length === 0) {
            state.invalid = true;
            return;
        }
        state.sum = new Float32Array(vector.length);
    }
    if (state.invalid) return;
    if (vector.length !== state.dims) {
        state.invalid = true;
        return;
    }
    const sum = state.sum;
    for (let i = 0; i < state.dims; i += 1) sum[i] += vector[i];
}

function accumulatorCentroid(state: CentroidAccumulator): Float32Array | null {
    if (state.invalid || state.sum === null || state.count === 0) return null;
    const out = new Float32Array(state.dims);
    for (let i = 0; i < state.dims; i += 1) out[i] = state.sum[i] / state.count;
    return out;
}

function sameEmbeddingSpace(candidate: PrimerCandidate, modelId: string | null): boolean {
    return Boolean(
        candidate.questionEmbedding &&
            candidate.questionEmbeddingModelId &&
            modelId &&
            candidate.questionEmbeddingModelId === modelId,
    );
}

function candidateAlreadyInPrimer(candidate: PrimerCandidate, primer: Primer): boolean {
    return primer.sourceCandidateIds.includes(candidate.id);
}

function applyClusterCentroid(cluster: PrimerCluster, state: CentroidAccumulator): void {
    if (state.count > 0) {
        cluster.centroid = accumulatorCentroid(state);
        return;
    }
    if (cluster.primer?.questionEmbedding) {
        cluster.centroid = cloneVector(cluster.primer.questionEmbedding);
    }
}

function normalizedTextMatches(candidate: PrimerCandidate, cluster: PrimerCluster): boolean {
    const first = cluster.candidates[0];
    if (first) return first.normalizedQuestion === candidate.normalizedQuestion;
    return cluster.primer?.question.toLowerCase().trim() === candidate.normalizedQuestion;
}

export function buildPrimerClusters(args: {
    candidates: PrimerCandidate[];
    activePrimers: Primer[];
    threshold?: number;
    hysteresis?: number;
}): PrimerCluster[] {
    const threshold = args.threshold ?? PRIMER_CLUSTER_THRESHOLD;
    const hysteresis = args.hysteresis ?? PRIMER_CLUSTER_HYSTERESIS;
    const clusters: PrimerCluster[] = args.activePrimers
        .slice()
        .sort((a, b) => a.id - b.id)
        .map((primer) => ({
            primer,
            candidates: [],
            centroid: cloneVector(primer.questionEmbedding),
            modelId: primer.questionEmbeddingModelId,
        }));
    // `CentroidAccumulator` never re-accumulates a divided centroid.
    const accumulators = new Map<PrimerCluster, CentroidAccumulator>();
    for (const cluster of clusters) accumulators.set(cluster, createAccumulator());

    const sorted = args.candidates
        .slice()
        .sort((a, b) => candidateSortKey(a).localeCompare(candidateSortKey(b)));

    const accumulateCandidate = (
        cluster: PrimerCluster,
        state: CentroidAccumulator,
        candidate: PrimerCandidate,
    ): void => {
        const vector = candidate.questionEmbedding;
        if (vector && sameEmbeddingSpace(candidate, cluster.modelId)) {
            accumulateVector(state, vector);
        }
    };

    for (const candidate of sorted) {
        let best: { cluster: PrimerCluster; score: number } | null = null;
        for (const cluster of clusters) {
            let score = Number.NEGATIVE_INFINITY;
            if (
                candidate.questionEmbedding &&
                cluster.centroid &&
                sameEmbeddingSpace(candidate, cluster.modelId)
            ) {
                score = cosineSimilarity(candidate.questionEmbedding, cluster.centroid);
            } else if (normalizedTextMatches(candidate, cluster)) {
                score = 1;
            }
            const stickierThreshold =
                cluster.primer && candidateAlreadyInPrimer(candidate, cluster.primer)
                    ? threshold - hysteresis
                    : threshold;
            if (score >= stickierThreshold && (!best || score > best.score)) {
                best = { cluster, score };
            }
        }

        if (best) {
            best.cluster.candidates.push(candidate);
            const state = accumulators.get(best.cluster) ?? createAccumulator();
            accumulators.set(best.cluster, state);
            accumulateCandidate(best.cluster, state, candidate);
            applyClusterCentroid(best.cluster, state);
            continue;
        }

        const created: PrimerCluster = {
            primer: null,
            candidates: [candidate],
            centroid: cloneVector(candidate.questionEmbedding),
            modelId: candidate.questionEmbeddingModelId,
        };
        const createdState = createAccumulator();
        accumulateCandidate(created, createdState, candidate);
        accumulators.set(created, createdState);
        clusters.push(created);
    }

    return clusters;
}

export function summarizePrimerCluster(cluster: PrimerCluster): PrimerClusterSummary {
    const occurrenceByDay = new Map<string, PrimerCandidate>();
    const byKey = new Map<string, PrimerCandidate>();
    for (const candidate of cluster.candidates) {
        const key = primerOccurrenceKey(candidate);
        if (!byKey.has(key)) byKey.set(key, candidate);
    }
    for (const candidate of byKey.values()) {
        const day = primerOccurrenceUtcDay(candidate.sourceMessageTime);
        const existing = occurrenceByDay.get(day);
        if (!existing || candidate.sourceMessageTime < existing.sourceMessageTime) {
            occurrenceByDay.set(day, candidate);
        }
    }
    const distinct = [...occurrenceByDay.values()].sort(
        (a, b) => a.sourceMessageTime - b.sourceMessageTime || a.id - b.id,
    );
    const first = distinct[0]?.sourceMessageTime ?? 0;
    const last = distinct[distinct.length - 1]?.sourceMessageTime ?? first;
    const supportIds = new Set<number>(cluster.primer?.sourceCandidateIds ?? []);
    for (const candidate of cluster.candidates) supportIds.add(candidate.id);
    return {
        candidates: cluster.candidates,
        support: distinct.length,
        spanDays: distinct.length <= 1 ? 0 : Math.floor((last - first) / (24 * 60 * 60 * 1000)),
        lastObservedAt: last || Date.now(),
        sourceCandidateIds: [...supportIds].sort((a, b) => a - b),
        centroid: cluster.centroid,
        modelId: cluster.modelId,
    };
}

export function clusterEligibleForPromotion(
    summary: PrimerClusterSummary,
    threshold = PRIMER_PROMOTION_THRESHOLD,
    minSpanDays = PRIMER_MIN_SPAN_DAYS,
): boolean {
    return summary.support >= threshold && summary.spanDays >= minSpanDays;
}
