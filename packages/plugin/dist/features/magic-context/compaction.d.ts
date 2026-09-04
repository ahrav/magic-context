import type { Database } from "../../shared/sqlite";
interface CompactionHandler {
    onCompacted(sessionId: string, db: Database): void;
}
export declare function createCompactionHandler(): CompactionHandler;
export {};
//# sourceMappingURL=compaction.d.ts.map