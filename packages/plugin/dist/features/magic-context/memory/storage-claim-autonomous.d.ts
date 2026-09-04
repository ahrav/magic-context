/**
 * Atomic autonomous-producer manifests (direct-claims U9; KTD3-KTD7).
 *
 * Model output never carries database authority by itself. The host binds each
 * parsed item to the exact prompt-time public locator, content digest, and
 * claim-local token, validates the complete batch before the first domain
 * write, then stages every item under one outer operation receipt.
 */
import { type Database } from "../../../shared/sqlite";
import type { ClaimMutationToken } from "./claim-operation-contract";
import { type CanonicalJsonValue } from "./claim-operation-contract";
import { type ClaimOperationRunResult, type ClaimOperationStageOutcome } from "./storage-claim-operations";
export interface AutonomousManifestIdentity {
    producer: string;
    task: string;
    runId: string;
    leaseKey: string;
    leaseGeneration: string | number;
    batchId: string;
}
export interface AutonomousManifestBinding {
    publicClaimId: string;
    revisionLocator: string;
    contentDigest: string;
    token: ClaimMutationToken;
}
export interface AutonomousManifestItem<T> {
    binding: AutonomousManifestBinding;
    /** Other claims consumed by this item, such as merge sources. */
    additionalBindings?: readonly AutonomousManifestBinding[];
    value: T;
}
export interface AutonomousCreationManifestItem<T> {
    /** Stable, canonical item identity included in the operation request digest. */
    key: CanonicalJsonValue;
    value: T;
}
export interface AutonomousManifestApplyResult {
    operation: ClaimOperationRunResult;
    appliedItems: number;
    summary: CanonicalJsonValue;
}
export declare function combineClaimOperationStageOutcomes(outcomes: readonly ClaimOperationStageOutcome[], summary: CanonicalJsonValue): ClaimOperationStageOutcome;
/** Apply one fully parsed and host-bound manifest inside its lease transaction. */
export declare function runAutonomousManifestInCurrentTransaction<T>(args: {
    db: Database;
    identity: AutonomousManifestIdentity;
    items: readonly AutonomousManifestItem<T>[];
    manifest: CanonicalJsonValue;
    resultSummary?: CanonicalJsonValue;
    stageItem: (db: Database, item: AutonomousManifestItem<T>, nowMs: number) => ClaimOperationStageOutcome;
    nowMs?: number;
}): AutonomousManifestApplyResult;
/** Applies a creation manifest under one outer claim operation. */
export declare function runAutonomousCreationManifestInCurrentTransaction<T>(args: {
    db: Database;
    identity: AutonomousManifestIdentity;
    items: readonly AutonomousCreationManifestItem<T>[];
    manifest: CanonicalJsonValue;
    resultSummary?: CanonicalJsonValue;
    stageItem: (db: Database, item: AutonomousCreationManifestItem<T>, nowMs: number) => ClaimOperationStageOutcome;
    nowMs?: number;
}): AutonomousManifestApplyResult;
/** Records a rejection result only within an active transaction. */
export declare function recordAutonomousManifestRejectionInCurrentTransaction(args: {
    db: Database;
    identity: AutonomousManifestIdentity;
    rawManifest: string;
    reason: string;
    nowMs?: number;
}): ClaimOperationRunResult;
/** Persist a malformed/incomplete provider manifest as one replayable zero-effect result. */
export declare function recordAutonomousManifestRejection(args: {
    db: Database;
    identity: AutonomousManifestIdentity;
    rawManifest: string;
    reason: string;
    nowMs?: number;
}): ClaimOperationRunResult;
//# sourceMappingURL=storage-claim-autonomous.d.ts.map