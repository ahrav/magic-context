import type { Database } from "../../../shared/sqlite";
import type { VerifyPromptMemory } from "./verify-prompt";
export interface VerifyGateResult {
    runStartedAt: number;
    mode: "non-git" | "full" | "broad" | "incremental";
    inScope: VerifyPromptMemory[];
    inScopeIds: string[];
    skippedIds: string[];
    reason: string;
    broadCycleStartAt?: number;
}
export declare function partitionVerifyScope(args: {
    db: Database;
    projectIdentity: string;
    projectDirectory: string;
    forceBroad?: boolean;
    now?: number;
    holderId?: string;
    leaseKey?: string;
}): Promise<VerifyGateResult>;
//# sourceMappingURL=verify-gate.d.ts.map