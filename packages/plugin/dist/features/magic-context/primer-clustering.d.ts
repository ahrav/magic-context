import type { Primer, PrimerCandidate } from "./storage-primers";
export declare const PRIMER_CLUSTER_THRESHOLD = 0.85;
export declare const PRIMER_CLUSTER_HYSTERESIS = 0.02;
export declare const PRIMER_PROMOTION_THRESHOLD = 2;
export declare const PRIMER_MIN_SPAN_DAYS = 7;
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
export declare function buildPrimerClusters(args: {
    candidates: PrimerCandidate[];
    activePrimers: Primer[];
    threshold?: number;
    hysteresis?: number;
}): PrimerCluster[];
export declare function summarizePrimerCluster(cluster: PrimerCluster): PrimerClusterSummary;
export declare function clusterEligibleForPromotion(summary: PrimerClusterSummary, threshold?: number, minSpanDays?: number): boolean;
//# sourceMappingURL=primer-clustering.d.ts.map