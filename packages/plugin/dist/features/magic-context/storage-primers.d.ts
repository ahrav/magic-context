import type { Database } from "../../shared/sqlite";
import type { VectorLoadObserver } from "./search-trace";
export declare const PRIMER_CANDIDATE_TTL_MS: number;
export declare const PRIMER_CANDIDATE_MAX_AGE_MS: number;
export interface PrimerCandidateInput {
    projectPath: string;
    harness: string;
    sessionId: string;
    question: string;
    normalizedQuestion?: string;
    sourceCompartmentStart?: number | null;
    sourceCompartmentEnd?: number | null;
    sourceStartMessageId: string;
    sourceEndMessageId: string;
    sourceMessageTime: number;
    questionEmbedding?: Float32Array | null;
    questionEmbeddingModelId?: string | null;
    createdAt?: number;
}
export interface PrimerCandidate {
    id: number;
    projectPath: string;
    harness: string;
    sessionId: string;
    question: string;
    normalizedQuestion: string;
    sourceCompartmentStart: number | null;
    sourceCompartmentEnd: number | null;
    sourceStartMessageId: string;
    sourceEndMessageId: string;
    sourceMessageTime: number;
    questionEmbedding: Float32Array | null;
    questionEmbeddingModelId: string | null;
    createdAt: number;
}
export interface PrimerSourceProvenance {
    candidateId: number;
    projectPath: string;
    harness: string;
    sessionId: string;
    sourceCompartmentStart: number | null;
    sourceCompartmentEnd: number | null;
    sourceStartMessageId: string;
    sourceEndMessageId: string;
}
export interface Primer {
    id: number;
    projectPath: string;
    question: string;
    questionEmbedding: Float32Array | null;
    questionEmbeddingModelId: string | null;
    answer: string;
    status: "active" | "archived";
    totalSupport: number;
    lastObservedAt: number | null;
    answerRefreshedAt: number | null;
    sourceCandidateIds: number[];
    sourceProvenance: PrimerSourceProvenance[] | null;
    createdAt: number;
    updatedAt: number;
}
export declare function normalizePrimerQuestion(question: string): string;
export declare function primerOccurrenceKey(candidate: Pick<PrimerCandidate, "projectPath" | "harness" | "sessionId" | "sourceStartMessageId" | "sourceEndMessageId">): string;
export declare function primerOccurrenceUtcDay(sourceMessageTime: number): string;
export declare function vectorBlob(vector: Float32Array | null | undefined): Uint8Array | null;
export declare function blobToFloat32Array(value: Uint8Array | ArrayBuffer | null | undefined): Float32Array | null;
export declare function insertPrimerCandidates(db: Database, candidates: PrimerCandidateInput[]): number[];
export declare function updatePrimerCandidateEmbedding(db: Database, candidateId: number, vector: Float32Array, modelId: string): void;
/** Replaces an active primer's question vector, for provider-identity changes:
 *  search skips any primer whose embedding model id differs from the query's,
 *  so a primer embedded under a retired identity is semantically invisible
 *  until rewritten here. */
export declare function updatePrimerQuestionEmbedding(db: Database, primerId: number, vector: Float32Array, modelId: string, now?: number): void;
/** Whether any active primer or promotion candidate carries a vector produced
 *  under an identity other than `currentModelId`. Pure EXISTS checks so gate
 *  evaluation never loads or decodes embedding BLOBs; rows with NO embedding
 *  are deliberately excluded — those belong to the promotion threshold's
 *  ordinary scheduling, not the stale-identity repair path. */
export declare function hasPrimerRowsWithStaleEmbeddings(db: Database, projectPath: string, currentModelId: string): boolean;
export declare function getPrimerCandidatesByIds(db: Database, ids: number[]): PrimerCandidate[];
export declare function getPrimerCandidatesForProject(db: Database, projectPath: string): PrimerCandidate[];
export declare function getPrimerCandidatesForPromotion(db: Database, projectPath: string, now?: number, ttlMs?: number): PrimerCandidate[];
export declare function countPrimerCandidatesForProject(db: Database, projectPath: string): number;
export declare function getActivePrimers(db: Database, projectPath: string, onVectorLoad?: VectorLoadObserver): Primer[];
export declare function getAllPrimers(db: Database, projectPath?: string): Primer[];
export declare function createPrimer(db: Database, input: {
    projectPath: string;
    question: string;
    questionEmbedding?: Float32Array | null;
    questionEmbeddingModelId?: string | null;
    answer?: string;
    totalSupport: number;
    lastObservedAt: number;
    sourceCandidateIds: number[];
    now?: number;
}): number;
export declare function updatePrimerSupport(db: Database, input: {
    primerId: number;
    questionEmbedding?: Float32Array | null;
    questionEmbeddingModelId?: string | null;
    totalSupport: number;
    lastObservedAt: number;
    sourceCandidateIds: number[];
    now?: number;
}): void;
export declare function updatePrimerAnswer(db: Database, primerId: number, answer: string, refreshedAt?: number): void;
export declare function pruneExpiredPrimerCandidates(db: Database, now?: number, ttlMs?: number, maxAgeMs?: number): number;
//# sourceMappingURL=storage-primers.d.ts.map