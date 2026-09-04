import type { Database } from "../../../shared/sqlite";
import { type ClaimMutationToken } from "./claim-operation-contract";
import { type ClaimOperationRunResult, type ProducerIdentity } from "./storage-claim-operations";
export type ClaimRelocationMode = "copy" | "move";
export interface RelocateProjectMemoryClaimsInput {
    sourceTokens: readonly ClaimMutationToken[];
    targetProjectIdentity: string;
    mode: ClaimRelocationMode;
    actor?: string;
    nowMs?: number;
}
/**
 * Copy or move project-memory claims across numeric projects as one U2
 * operation. Every source token is validated before target work begins. A
 * stale token therefore stores one zero-effect receipt for the whole batch.
 * Targets receive fresh conservative evidence and explicit derivation
 * lineage; source evidence, approvals, and maturity are never inherited.
 */
export declare function relocateProjectMemoryClaims(db: Database, producer: ProducerIdentity, input: RelocateProjectMemoryClaimsInput): ClaimOperationRunResult;
export declare function copyProjectMemoryClaims(db: Database, producer: ProducerIdentity, input: Omit<RelocateProjectMemoryClaimsInput, "mode">): ClaimOperationRunResult;
export declare function moveProjectMemoryClaims(db: Database, producer: ProducerIdentity, input: Omit<RelocateProjectMemoryClaimsInput, "mode">): ClaimOperationRunResult;
//# sourceMappingURL=relocate-memory.d.ts.map