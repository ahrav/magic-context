import type { Database } from "../../shared/sqlite";
export type MemoryMutationType = "archive" | "delete" | "update" | "superseded";
export interface MemoryMutationLogRow {
    id: number;
    projectPath: string;
    mutationType: MemoryMutationType;
    targetMemoryId: number;
    supersededById: number | null;
    category: string | null;
    newContent: string | null;
    visibilityChanged: boolean;
    queuedAt: number;
}
export declare function queueMemoryMutation(db: Database, input: {
    projectPath: string;
    mutationType: MemoryMutationType;
    targetMemoryId: number;
    supersededById?: number | null;
    category?: string | null;
    newContent?: string | null;
    queuedAt?: number;
}): MemoryMutationLogRow;
export declare function getMemoryMutation(db: Database, id: number): MemoryMutationLogRow | null;
export declare function getMemoryMutationsForRender(db: Database, projectPath: string, afterId: number | null | undefined, renderedMemoryIds: readonly number[]): MemoryMutationLogRow[];
export declare function getMemoryMutationsForRenderByProjects(db: Database, projectPaths: readonly string[], afterId: number | null | undefined, renderedMemoryIds: readonly number[]): MemoryMutationLogRow[];
export declare function getMaxMemoryMutationId(db: Database, projectPath: string): number | null;
export declare function getMaxMemoryMutationIdForProjects(db: Database, projectPaths: readonly string[]): number | null;
//# sourceMappingURL=storage-memory-mutation-log.d.ts.map