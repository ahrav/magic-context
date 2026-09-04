import type { Database } from "../../../shared/sqlite";
export interface StoredMemoryEmbedding {
    embedding: Float32Array;
    modelId: string | null;
}
export declare function saveEmbedding(db: Database, memoryId: number, embedding: Float32Array, modelId: string): void;
/** Save an embedding only if the memory row still has the same normalized hash
 *  we embedded. If the content changed while the provider call was in flight,
 *  the stale vector is discarded instead of resurrecting an out-of-date row. */
export declare function saveEmbeddingIfHashMatches(db: Database, memoryId: number, embedding: Float32Array, modelId: string, normalizedHash: string): boolean;
export declare function loadAllEmbeddings(db: Database, projectPath: string, modelId: string): Map<number, StoredMemoryEmbedding>;
export declare function deleteEmbedding(db: Database, memoryId: number): void;
export declare function hasMemoryEmbedding(db: Database, memoryId: number, modelId: string): boolean;
export declare function getStoredModelId(db: Database, projectPath: string): string | null;
export declare function clearEmbeddingsForProject(db: Database, projectPath: string, modelId?: string): number;
/** Active memories for a project, and how many are embedded under `modelId`.
 *  Drives the `/ctx-embed` status `embedded / total` memory line. */
export declare function getMemoryEmbedCoverage(db: Database, projectPath: string, modelId: string): {
    embedded: number;
    total: number;
};
//# sourceMappingURL=storage-memory-embeddings.d.ts.map