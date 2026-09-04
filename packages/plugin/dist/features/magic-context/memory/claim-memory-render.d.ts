import type { Database } from "../../../shared/sqlite";
import type { SnapshotVector } from "./claim-operation-contract";
import { type ProjectMemoryClaimSnapshot } from "./storage-claim-current-state";
export interface AuthorizedClaimMemorySnapshot {
    items: ProjectMemoryClaimSnapshot[];
    projectIds: number[];
    ownProjectIds: number[];
    identityByProjectId: Map<number, string>;
    snapshotVector: SnapshotVector;
}
export declare function readAuthorizedClaimMemorySnapshot(db: Database, args: {
    authorizedIdentities: readonly string[];
    ownIdentities: readonly string[];
    sharedCategories: readonly string[];
    workspaceEpoch: string;
    /**
     * Identities `workspaceEpoch` and the authorization were derived from.
     * Automatic injection is the surface with the least recourse — nothing
     * downstream re-checks it — so the provider must recompute the
     * fingerprint at publication time rather than echo the value above. A
     * workspace mutation bumps `project_memory_epoch`, not the claim
     * generation tracked in the vector, so the fingerprint is the only
     * signal that membership or sharing changed.
     */
    workspaceIdentities?: readonly string[];
    nowMs?: number;
}): AuthorizedClaimMemorySnapshot | null;
export interface ClaimMemoryRenderOptions {
    /** Workspace source attribution keyed by public claim ID. */
    sourceNameByClaimId?: ReadonlyMap<string, string>;
}
/** One compact claim fact line. Importance controls selection but stays off
 * the wire so classification-only updates do not change bytes. */
export declare function renderClaimMemoryLine(item: ProjectMemoryClaimSnapshot, sourceName?: string): string;
export declare function claimSelectionOrder(left: ProjectMemoryClaimSnapshot, right: ProjectMemoryClaimSnapshot): number;
export declare function claimRenderOrder(left: ProjectMemoryClaimSnapshot, right: ProjectMemoryClaimSnapshot): number;
export declare function renderClaimMemoryBlock(items: readonly ProjectMemoryClaimSnapshot[], wrapper?: string, renderOptions?: ClaimMemoryRenderOptions): string;
export interface TrimClaimSnapshotsResult {
    selected: ProjectMemoryClaimSnapshot[];
    renderOrder: ProjectMemoryClaimSnapshot[];
}
export declare function trimClaimSnapshotsToBudget(items: readonly ProjectMemoryClaimSnapshot[], budgetTokens: number, renderOptions?: ClaimMemoryRenderOptions): TrimClaimSnapshotsResult;
export interface ClaimWorkspaceTrimContext {
    /** Canonical member identities in workspace order. */
    identities: readonly string[];
    /** Claim project ID to canonical member identity. */
    identityByProjectId: ReadonlyMap<number, string>;
}
/**
 * Workspace-fair trim: each member identity gets an equal token floor before
 * the remainder fills greedily, so one member's pool cannot starve the rest.
 */
export declare function trimWorkspaceClaimSnapshotsToBudget(items: readonly ProjectMemoryClaimSnapshot[], budgetTokens: number, workspace: ClaimWorkspaceTrimContext, renderOptions?: ClaimMemoryRenderOptions): TrimClaimSnapshotsResult;
/** Canonical project identity per numeric project ID. */
export declare function readProjectIdentityMap(db: Database, projectIds: readonly number[]): Map<number, string>;
//# sourceMappingURL=claim-memory-render.d.ts.map