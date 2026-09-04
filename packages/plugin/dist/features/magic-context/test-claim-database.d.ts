import type { Database } from "../../shared/sqlite";
import type { ClaimMutationToken } from "./memory/claim-operation-contract";
import { type ClaimEvidenceProvenance } from "./memory/storage-claim-operations";
import type { MemoryScope } from "./memory/types";
import type { ClaimMemorySharing } from "./storage-claim-memory-schema";
export declare function createClaimReaderTestDatabase(): Database;
export interface SeedProjectMemoryClaimArgs {
    projectIdentity: string;
    content: string;
    category?: string;
    importance?: number;
    memoryScope?: MemoryScope;
    sharing?: ClaimMemorySharing;
    expiresAt?: number | null;
    operationKey?: string;
    actor?: string;
    provenance?: Partial<ClaimEvidenceProvenance>;
}
export interface SeededProjectMemoryClaim {
    projectId: number;
    publicClaimId: string;
    revisionLocator: string;
    revision: number;
    contentDigest: string;
    token: ClaimMutationToken;
}
export declare function seedProjectMemoryClaim(db: Database, args: SeedProjectMemoryClaimArgs): SeededProjectMemoryClaim;
//# sourceMappingURL=test-claim-database.d.ts.map