import type { Database } from "../../../shared/sqlite";
import type { ClaimMutationToken } from "./claim-operation-contract";
import { ANTI_MEMORY_CATEGORY } from "./constants";
import { type ClaimEvidenceProvenance, type ClaimOperationRunResult, type ClaimOperationStageOutcome, type ProducerIdentity } from "./storage-claim-operations";
export declare const ANTI_MEMORY_DEFAULT_TTL_MS: number;
export interface AntiMemoryPayload {
    trigger: string;
    rejectedStrategy: string;
    rejectionReason: string;
    saferAlternative?: string | null;
    preconditions?: string | null;
    attemptedApproach?: string | null;
    observedFailure?: string | null;
    rootCause?: string | null;
    recovery?: string | null;
    nonApplicableWhen?: string | null;
}
interface StoredAntiMemoryPayload {
    trigger: string;
    rejectedStrategy: string;
    rejectionReason: string;
    saferAlternative: string | null;
    preconditions: string | null;
    attemptedApproach: string | null;
    observedFailure: string | null;
    rootCause: string | null;
    recovery: string | null;
    nonApplicableWhen: string | null;
}
export interface CreateAntiMemoryInput {
    projectId: number;
    payload: AntiMemoryPayload;
    provenance: ClaimEvidenceProvenance;
    actor: string;
    importance?: number;
    requestScope?: string;
    /**
     * Expiry anchor override. Backfill consumers anchor to the source event's
     * age so harvesting old history does not re-animate stale warnings; when
     * absent, expiry starts at the write clock.
     */
    expiresAt?: number;
    nowMs?: number;
}
export interface ReviseAntiMemoryInput {
    token: ClaimMutationToken;
    payload: AntiMemoryPayload;
    provenance: ClaimEvidenceProvenance;
    actor: string;
    requestScope?: string;
    nowMs?: number;
}
export interface ExtendAntiMemoryTtlInput {
    token: ClaimMutationToken;
    expiresAt: number;
    provenance: ClaimEvidenceProvenance;
    actor: string;
    requestScope?: string;
    nowMs?: number;
}
export interface AntiMemoryRecord {
    claimId: number;
    publicClaimId: string;
    revisionLocator: string;
    revision: number;
    content: string;
    contentDigest: string;
    category: typeof ANTI_MEMORY_CATEGORY;
    normalizedHash: string;
    importance: number;
    memoryScope: "project";
    sharing: "private";
    expiresAt: number | null;
    payload: StoredAntiMemoryPayload;
}
/**
 * Trim and null-normalize a payload, rejecting empty required fields. Exported
 * so consumers that validate or fingerprint payload text can derive the field
 * set from the payload itself instead of hand-enumerating it (a hand-kept list
 * fails open when a field is added).
 */
export declare function normalizeAntiMemoryPayload(payload: AntiMemoryPayload): StoredAntiMemoryPayload;
export declare function renderAntiMemoryContent(payload: AntiMemoryPayload): string;
export declare function parseAntiMemoryContent(content: string): AntiMemoryPayload;
export declare function stageCreateAntiMemoryInCurrentTransaction(db: Database, input: CreateAntiMemoryInput, nowMs: number): ClaimOperationStageOutcome;
export declare function createAntiMemory(db: Database, producer: ProducerIdentity, input: CreateAntiMemoryInput): ClaimOperationRunResult;
export declare function createAgentAntiMemory(db: Database, producer: ProducerIdentity, input: Omit<CreateAntiMemoryInput, "provenance"> & {
    provenance: Omit<ClaimEvidenceProvenance, "sourceTrustClass">;
}): ClaimOperationRunResult;
/**
 * Record a verification outcome against an anti-memory claim. Re-exported from
 * the generic operations module so every typed anti-memory write is reachable
 * from one place: the refusal in the generic recorder tells callers to use "the
 * typed anti-memory API", and this is it.
 */
export { stageAntiMemoryVerificationInCurrentTransaction } from "./storage-claim-operations";
export declare function stageReviseAntiMemoryInCurrentTransaction(db: Database, input: ReviseAntiMemoryInput, nowMs: number): ClaimOperationStageOutcome;
export declare function stageExtendAntiMemoryTtlInCurrentTransaction(db: Database, input: ExtendAntiMemoryTtlInput, nowMs: number): ClaimOperationStageOutcome;
export declare function reviseAntiMemory(db: Database, producer: ProducerIdentity, input: ReviseAntiMemoryInput): ClaimOperationRunResult;
export declare function extendAntiMemoryTtl(db: Database, producer: ProducerIdentity, input: ExtendAntiMemoryTtlInput): ClaimOperationRunResult;
export declare function readAntiMemory(db: Database, publicClaimId: string): AntiMemoryRecord | null;
/** Batched current-revision payload read for the search lane: one query for the
 *  whole candidate set instead of one `readAntiMemory` per record. */
export declare function readAntiMemories(db: Database, publicClaimIds: readonly string[]): Map<string, AntiMemoryRecord>;
/** Bounded candidate listing for the search lane: active, unexpired anti-memory
 *  public ids only, newest claims first. Keeps the current-state hydration that
 *  follows scoped to at most `limit` anti-memory claims instead of the whole
 *  project claim set. */
export declare function listActiveAntiMemoryPublicIds(db: Database, projectIds: readonly number[], limit: number, nowMs: number): string[];
//# sourceMappingURL=storage-anti-memory.d.ts.map