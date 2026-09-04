import type { PluginContext } from "../../../plugin/types";
import type { Database } from "../../../shared/sqlite";
import { type LeaseAcquisition } from "../dreamer/lease";
import type { ClaimOperationResultEffect } from "../memory/claim-operation-contract";
import { type AutonomousManifestIdentity } from "../memory/storage-claim-autonomous";
import type { MemoryCategory } from "../memory/types";
import { type UserMemory, type UserMemoryCandidate } from "./storage-user-memory";
interface ReviewUserMemoriesArgs {
    db: Database;
    client: PluginContext["client"];
    projectIdentity: string;
    parentSessionId: string | undefined;
    sessionDirectory: string | undefined;
    holderId: string;
    /** Keyed lease this task holds (Dreamer v2: global user-memories domain).
     *  Defaults to the legacy single lease key for back-compat. */
    leaseKey?: string;
    deadline: number;
    leaseAcquisition?: LeaseAcquisition;
    promotionThreshold: number;
    /** Per-task model override (Dreamer v2). */
    model?: string;
    /** Resolved dreamer fallback chain. */
    fallbackModels?: readonly string[];
    language?: string;
}
export interface ReviewResult {
    promoted: number;
    projectPromoted: number;
    merged: number;
    dismissed: number;
    candidatesConsumed: number;
    /**
     * Effects of the claim-native project promotions. Reducing the outcome to
     * counts left the dream-run audit with no claim IDs at all while the log
     * reported `project_promoted > 0`; the curate and retrospective paths feed
     * these through `claimEffectMemoryChanges` for the same reason.
     */
    effects: readonly ClaimOperationResultEffect[];
}
interface ReviewCandidateSnapshot extends UserMemoryCandidate {
    projectIdentities: string[];
}
export interface UserMemoryReviewSnapshot {
    candidates: ReviewCandidateSnapshot[];
    stableMemories: UserMemory[];
    digest: string;
}
interface ProfilePromotion {
    content: string;
    candidateIds: number[];
}
interface ProjectPromotion extends ProfilePromotion {
    category: MemoryCategory;
}
interface ProfileUpdate {
    memoryId: number;
    content: string;
    candidateIds: number[];
}
interface ProfileDismissal {
    memoryId: number;
    reason: string | null;
}
export interface UserMemoryReviewManifest {
    promotions: ProfilePromotion[];
    projectPromotions: ProjectPromotion[];
    updates: ProfileUpdate[];
    dismissals: ProfileDismissal[];
    consumeCandidateIds: number[];
}
interface ReviewApplyResult {
    result: ReviewResult;
    replayed: boolean;
    staleReason: string | null;
}
export declare function captureUserMemoryReviewSnapshot(db: Database, projectIdentity: string, now?: number): UserMemoryReviewSnapshot;
export declare function parseUserMemoryReviewManifest(value: unknown): UserMemoryReviewManifest;
export declare function applyUserMemoryReviewManifest(args: {
    db: Database;
    projectIdentity: string;
    holderId: string;
    leaseKey: string;
    expectedLeaseGeneration?: number;
    identity: AutonomousManifestIdentity;
    snapshot: UserMemoryReviewSnapshot;
    manifest: UserMemoryReviewManifest;
    /** Minimum corroborating candidates a project promotion must carry. */
    promotionThreshold: number;
    nowMs?: number;
}): ReviewApplyResult;
export declare function reviewUserMemories(args: ReviewUserMemoriesArgs): Promise<ReviewResult>;
export {};
//# sourceMappingURL=review-user-memories.d.ts.map