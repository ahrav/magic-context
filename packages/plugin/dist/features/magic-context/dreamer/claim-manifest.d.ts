import type { Database } from "../../../shared/sqlite";
import type { AutonomousManifestBinding, AutonomousManifestIdentity } from "../memory/storage-claim-autonomous";
import { type ProjectMemoryClaimSnapshot } from "../memory/storage-claim-current-state";
import type { ClaimEvidenceProvenance } from "../memory/storage-claim-operations";
export type DreamerMaintenanceLane = "hygiene" | "verification";
/**
 * Read a project's live claims for one maintenance lane.
 *
 * Two attempts, matching every other production reader of this state: a
 * concurrent write during the read window moves the claim/policy generations
 * and reports `stale`, which is routine rather than exceptional. A single
 * attempt would return `[]` on that outcome, and because the dreamer tasks
 * treat an empty pool as "this project has no claims", the whole pass would
 * no-op with no error. Exhausting both attempts still yields `[]` — the pass
 * is skipped, not failed — but says so, so a project whose generations keep
 * moving is visible instead of looking idle.
 */
export declare function readDreamerProjectClaims(db: Database, projectIdentity: string, lane: DreamerMaintenanceLane): ProjectMemoryClaimSnapshot[];
export declare function claimManifestBinding(claim: ProjectMemoryClaimSnapshot): AutonomousManifestBinding;
export declare function sameClaimManifestBinding(left: AutonomousManifestBinding, right: AutonomousManifestBinding): boolean;
export declare function refreshDreamerClaimBatch(args: {
    db: Database;
    projectIdentity: string;
    lane: DreamerMaintenanceLane;
    claims: readonly ProjectMemoryClaimSnapshot[];
}): ProjectMemoryClaimSnapshot[];
export declare function dreamerManifestIdentity(args: {
    db: Database;
    holderId: string;
    leaseKey: string;
    parentSessionId?: string;
    task: string;
    publicClaimIds: readonly string[];
}): AutonomousManifestIdentity;
export declare function recordDreamerManifestRejection(args: {
    db: Database;
    holderId: string;
    leaseKey: string;
    identity: AutonomousManifestIdentity;
    rawManifest: string;
    reason: string;
}): void;
export declare function dreamerInferenceProvenance(args: {
    identity: AutonomousManifestIdentity;
    binding: AutonomousManifestBinding;
    sourceContent: string;
}): ClaimEvidenceProvenance;
//# sourceMappingURL=claim-manifest.d.ts.map