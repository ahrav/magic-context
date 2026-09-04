import { type Database } from "../../../shared/sqlite";
import type { ClaimOperationResultEffect } from "../memory/claim-operation-contract";
export interface CorrectionHarvestResult {
    consumed: number;
    skipped: number;
    effects: readonly ClaimOperationResultEffect[];
}
export declare function countPendingCorrectionEvents(db: Database, projectIdentity: string): number;
export declare function harvestAntiMemoriesFromCorrections(args: {
    db: Database;
    projectIdentity: string;
    actor?: string;
    nowMs?: number;
}): CorrectionHarvestResult;
//# sourceMappingURL=anti-memory-from-corrections.d.ts.map