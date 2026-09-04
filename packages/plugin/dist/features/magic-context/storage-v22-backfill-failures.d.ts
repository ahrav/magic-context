import type { Database } from "../../shared/sqlite";
export type V22BackfillErrorClass = "not_git_repo" | "git_missing" | "git_timeout" | "permission_denied" | "unknown";
type RecordableV22BackfillErrorClass = V22BackfillErrorClass | "dubious_ownership";
export interface V22BackfillFailureRow {
    id: number;
    tableName: string;
    rowId: number;
    rawProjectPath: string;
    errorClass: V22BackfillErrorClass;
    errorMessage: string | null;
    failedAt: number;
}
export declare function recordV22BackfillFailure(db: Database, input: {
    tableName: string;
    rowId: number;
    rawProjectPath: string;
    errorClass: RecordableV22BackfillErrorClass;
    errorMessage?: string | null;
    failedAt?: number;
}): V22BackfillFailureRow;
export declare function getV22BackfillFailure(db: Database, tableName: string, rowId: number): V22BackfillFailureRow | null;
export declare function listV22BackfillFailures(db: Database): V22BackfillFailureRow[];
export declare function deleteV22BackfillFailure(db: Database, tableName: string, rowId: number): boolean;
export declare function clearV22BackfillFailures(db: Database): number;
export {};
//# sourceMappingURL=storage-v22-backfill-failures.d.ts.map