/**
 * Batched project-memory current-state provider (KTD6; R9-R12).
 *
 * One provider owns all project-memory reads: claims resolve by public
 * locator or authorized project set; revision attributes, evidence
 * summaries, applicability heads, lifecycle, policy, and telemetry hydrate
 * under one snapshot; policy visibility applies before any candidate limit;
 * the hydration snapshot closes; and the SnapshotVector is revalidated from
 * a fresh snapshot before the result may be published.
 *
 * Fail-closed contract: a null current-revision pointer, missing attributes
 * row, missing evidence, stale current pointer, malformed stored public ID,
 * or broken lifecycle head throws ClaimGraphCorruptionError instead of
 * serving unauditable claims.
 */
import type { Database } from "../../../shared/sqlite";
import type { ClaimMemoryLifecycleState, ClaimMemorySharing } from "../storage-claim-memory-schema.ts";
import { type ClaimMutationToken, type SnapshotVector } from "./claim-operation-contract.ts";
import { type ActiveDispositions } from "./claim-visibility-policy.ts";
import { type ApplicabilityAssertionRecord } from "./storage-claim-applicability.ts";
import type { MemoryScope } from "./types.ts";
export type ProjectMemorySurface = "auto_inject" | "explicit_search" | "maintenance_hygiene" | "maintenance_verification";
export interface ProjectMemoryWorkspaceAuthorization {
    /** Projects owned by the active workspace member. */
    ownProjectIds: readonly number[];
    /** Foreign workspace categories explicitly shared with this member. */
    sharedCategories: readonly string[];
}
export interface ProjectMemoryCurrentStateRequest {
    /** Exact public locator lookup; combined with projectIds when both set. */
    publicClaimIds?: readonly string[];
    /** Authorized project set: only claims in these projects hydrate. */
    projectIds?: readonly number[];
    /** Optional workspace sharing filter, applied before the candidate limit. */
    workspaceAuthorization?: ProjectMemoryWorkspaceAuthorization;
    /** Policy surface applied before any candidate limit. */
    surface?: ProjectMemorySurface;
    /** Lifecycle states to include; defaults to live claims only. */
    lifecycleStates?: readonly ClaimMemoryLifecycleState[];
    /** Candidate cap applied after visibility filtering. */
    limit?: number;
    /** Opaque workspace-epoch signature bound into the SnapshotVector. */
    workspaceEpoch?: string;
    /**
     * Workspace identities the caller derived `workspaceEpoch` and
     * `workspaceAuthorization` from. Supplying them lets the provider recompute
     * the fingerprint from current state at publication time instead of echoing
     * the caller's value, which is the only way a membership or shared-category
     * revocation landing mid-read can be detected.
     */
    workspaceIdentities?: readonly string[];
    /** Expiry evaluation instant; defaults to Date.now(). */
    nowMs?: number;
}
export interface ProjectMemoryPolicyView {
    effectiveMaturity: string;
    originTaint: string;
    autoEligible: boolean;
    explicitEligible: boolean;
    hardHidden: boolean;
    policyVersion: number;
    generation: number;
}
export interface ProjectMemoryClaimSnapshot {
    publicClaimId: string;
    revisionLocator: string;
    revision: number;
    content: string;
    contentDigest: string;
    category: string;
    normalizedHash: string;
    importance: number;
    memoryScope: MemoryScope;
    sharing: ClaimMemorySharing;
    expiresAt: number | null;
    lifecycleState: ClaimMemoryLifecycleState;
    evidence: {
        observationCount: number;
        independenceKeys: string[];
    };
    applicability: ApplicabilityAssertionRecord[];
    policy: ProjectMemoryPolicyView;
    /** Authoritative disposition facts read from conflict/disposition/
     * verification rows, not the projection, so uniform absence holds even
     * when the projection lags a policy-unaware writer. */
    dispositions: ActiveDispositions;
    /** Sanitized evidence label for labeled explicit-search rendering; null
     * for clean rows. Never set on the auto_inject surface. */
    explicitLabel: string | null;
    telemetry: {
        seenCount: number;
        retrievalCount: number;
    };
    verification: {
        latestOutcome: "verified" | "update" | "archive" | "stale" | "flagged" | null;
        verifiedAt: number;
    };
    mutationToken: ClaimMutationToken;
    projectId: number;
}
export type ProjectMemoryCurrentStateResult = {
    status: "ok";
    items: ProjectMemoryClaimSnapshot[];
    snapshotVector: SnapshotVector;
} | {
    status: "stale";
    reasons: string[];
};
export declare function hasClaimMemoryFragment(db: Database): boolean;
export declare function readProjectMemorySnapshotVector(db: Database, projectIds: readonly number[], workspaceEpoch: string): SnapshotVector;
export declare function snapshotVectorChanges(before: SnapshotVector, after: SnapshotVector): string[];
/**
 * Hydrate the requested current claim set under one snapshot, close it, then
 * revalidate the SnapshotVector from a fresh snapshot. Returns `stale`
 * instead of publishing when the vector moved between the two.
 */
export declare function readProjectMemoryCurrentState(db: Database, request: ProjectMemoryCurrentStateRequest): ProjectMemoryCurrentStateResult;
/**
 * Resolve canonical project identities to numeric project IDs, skipping
 * identities with no registered project. Readers hold identity strings; the
 * provider keys on numeric project IDs.
 */
export declare function resolveProjectIdsForIdentities(db: Database, identities: readonly string[]): number[];
export interface ProjectClaimLifecycleCensus {
    total: number;
    active: number;
    archived: number;
    retired: number;
    ids: number[];
    archivedIds: number[];
    retiredIds: number[];
}
export declare function censusProjectMemoryClaims(db: Database, projectIdentity: string): ProjectClaimLifecycleCensus;
/**
 * Cheap lifecycle-state count of project-memory claims for status and gate
 * surfaces. Counts the claim set the provider would hydrate (public-ID rows
 * with a matching lifecycle head), without hydration or policy filtering —
 * counts gate scheduling and status displays, not content publication.
 */
export declare function countProjectMemoryClaims(db: Database, request: {
    projectIds: readonly number[];
    lifecycleStates?: readonly ClaimMemoryLifecycleState[];
}): number;
//# sourceMappingURL=storage-claim-current-state.d.ts.map