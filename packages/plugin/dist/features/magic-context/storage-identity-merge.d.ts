import type { Database } from "../../shared/sqlite";
export interface IdentityMergeTableReport {
    tableName: string;
    identityColumn: string;
    derived: boolean;
    sourceRows: number;
    changedRows: number;
}
export interface IdentityMergeReport {
    fromIdentity: string;
    toIdentity: string;
    auditedTables: IdentityMergeTableReport[];
    changedRows: number;
    dryRun: boolean;
}
export declare function auditIdentityMerge(db: Database, fromIdentity: string, toIdentity: string): IdentityMergeReport;
export declare function mergeProjectIdentities(db: Database, fromIdentity: string, toIdentity: string, options?: {
    dryRun?: boolean;
    now?: number;
}): IdentityMergeReport;
//# sourceMappingURL=storage-identity-merge.d.ts.map