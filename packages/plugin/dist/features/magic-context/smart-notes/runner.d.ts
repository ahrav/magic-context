import type { Database } from "../../../shared/sqlite";
export interface RunDueCompiledSmartNoteChecksArgs {
    db: Database;
    projectIdentity: string;
    projectRoot: string;
    now?: number;
    maxChecks?: number;
    sweepBudgetMs?: number;
    leaseHeld?: () => boolean;
    signal?: AbortSignal;
    retinaHandoff?: boolean;
}
export interface RunDueCompiledSmartNoteChecksResult {
    ran: number;
    surfaced: number;
    failed: number;
    networkFailed: number;
}
export declare function runDueCompiledSmartNoteChecks(args: RunDueCompiledSmartNoteChecksArgs): Promise<RunDueCompiledSmartNoteChecksResult>;
//# sourceMappingURL=runner.d.ts.map