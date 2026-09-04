import type { Database } from "../../../shared/sqlite";
import { type StoredMemoryEmbedding } from "./storage-memory-embeddings";
import type { Memory } from "./types";
export declare function ensureMemoryEmbeddings(args: {
    db: Database;
    projectIdentity: string;
    memories: Memory[];
    existingEmbeddings: Map<number, StoredMemoryEmbedding>;
}): Promise<Map<number, StoredMemoryEmbedding>>;
//# sourceMappingURL=embedding-backfill.d.ts.map