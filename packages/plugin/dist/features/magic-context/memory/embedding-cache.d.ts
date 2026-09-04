import type { Database } from "../../../shared/sqlite";
import { type StoredMemoryEmbedding } from "./storage-memory-embeddings";
export declare function getProjectEmbeddings(db: Database, projectPath: string, modelId: string): Map<number, StoredMemoryEmbedding>;
export declare function peekProjectEmbeddings(projectPath: string, modelId: string): Map<number, StoredMemoryEmbedding> | null;
export declare function invalidateProject(projectPath: string): void;
export declare function invalidateMemory(projectPath: string, memoryId: number): void;
export declare function resetEmbeddingCacheForTests(): void;
export declare function setEmbeddingCacheTtlForTests(ttlMs: number): void;
//# sourceMappingURL=embedding-cache.d.ts.map