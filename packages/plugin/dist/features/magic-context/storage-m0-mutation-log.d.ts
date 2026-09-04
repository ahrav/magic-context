import type { Database } from "../../shared/sqlite";
export type M0MutationType = "compartment_delete" | "compartment_merge" | "recomp_boundary_change" | "compartment_upgrade";
export interface M0MutationLogRow {
    id: number;
    sessionId: string;
    mutationType: M0MutationType;
    targetId: number | null;
    queuedAt: number;
}
export declare function queueM0Mutation(db: Database, input: {
    sessionId: string;
    mutationType: M0MutationType;
    targetId?: number | null;
    queuedAt?: number;
}): M0MutationLogRow;
export declare function getM0Mutation(db: Database, id: number): M0MutationLogRow | null;
export declare function getM0MutationsBySession(db: Database, sessionId: string): M0MutationLogRow[];
export declare function getM0MutationsAfterId(db: Database, sessionId: string, afterId: number): M0MutationLogRow[];
export declare function getMaxM0MutationId(db: Database, sessionId: string): number | null;
export declare function deleteM0Mutation(db: Database, id: number): boolean;
export declare function clearM0MutationsForSession(db: Database, sessionId: string): number;
//# sourceMappingURL=storage-m0-mutation-log.d.ts.map