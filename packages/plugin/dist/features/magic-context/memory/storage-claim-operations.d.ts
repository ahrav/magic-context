/**
 * Direct claim-memory operation kernel (direct-claims-cutover plan: U2;
 * KTD3-KTD5, KTD7, KTD13; R1-R8, R19-R20).
 *
 * One two-phase protocol owns every project-memory mutation:
 *   - phase one validates the claim-local mutation token and stages the
 *     domain rows inside a savepoint, returning touched projects and effect
 *     descriptors; a stale token rolls the savepoint back so zero partial
 *     rows survive.
 *   - phase two allocates one generation per touched project, finalizes the
 *     policy ladder and projection under those generations, writes the
 *     receipt-grouped outbox effects, verifies effect counts and the
 *     generation vector, and stores the durable receipt (effect summary plus
 *     canonical result bytes) before commit.
 *
 * Replaying the same producer/key/digest returns the stored result bytes
 * verbatim with zero new effects; the same key with a different digest fails
 * before the staging callback runs. Stale and no-op outcomes persist as
 * zero-effect receipts; every receipt lives until whole-incarnation reset.
 *
 * Producer adapters supply evidence provenance, claim-local tokens, and
 * stable operation keys; the kernel owns all SQL and effect ordering (KTD7).
 */
import { type Database } from "../../../shared/sqlite.ts";
import type { SourceTrustClass } from "../storage-claim-applicability-schema.ts";
import type { ClaimEffectChangeKind, ClaimMemoryLifecycleState, ClaimMemorySharing } from "../storage-claim-memory-schema.ts";
import { type CanonicalJsonValue, type ClaimMutationToken, type ClaimOperationResult } from "./claim-operation-contract.ts";
import { type ApplicabilityPathsInput } from "./storage-claim-applicability.ts";
import type { MemoryScope } from "./types.ts";
/** Frozen semantic key vocabulary for direct project-memory claims. */
export declare const PROJECT_MEMORY_CLAIM_PREDICATE = "states";
export declare const PROJECT_MEMORY_CLAIM_SCOPE = "project-memory";
/** Actor stamped on automatic maturity ladder steps by the kernel. */
export declare const CLAIM_KERNEL_POLICY_ACTOR = "mc-claim-kernel-v1";
export declare class ClaimOperationKeyReuseError extends Error {
    constructor(producer: string, operationKey: string);
}
/** Caller-input defects (unknown claim, duplicate collision, bad shape).
 * Thrown before any receipt exists, so the transaction rolls back whole. */
export declare class ClaimOperationInputError extends Error {
    constructor(message: string);
}
export interface ProjectMemoryClaimRef {
    claimId: number;
    projectId: number;
    publicClaimId: string;
    currentRevisionId: number;
    revision: number;
    contentDigest: string;
    content: string;
}
/** Resolve a project-memory claim by public ID, fail-closed on corruption. */
export declare function getProjectMemoryClaimByPublicId(db: Database, publicClaimId: string): ProjectMemoryClaimRef | null;
/** Mint the claim-local mutation token for the claim's current state. */
export declare function computeProjectMemoryMutationToken(db: Database, publicClaimId: string): ClaimMutationToken;
export type ClaimTokenStalePart = "revision" | "lifecycle" | "applicability" | "policy";
export type ClaimTokenValidation = {
    ok: true;
    claim: ProjectMemoryClaimRef;
} | {
    ok: false;
    stalePart: ClaimTokenStalePart;
    reason: string;
};
/** Recompute the token under the write transaction and name the stale part. */
export declare function validateProjectMemoryMutationToken(db: Database, token: ClaimMutationToken): ClaimTokenValidation;
export interface ClaimOperationEnvelope {
    producer: string;
    operationKey: string;
    requestDigest: string;
}
export interface ClaimEffectDescriptor {
    effectKey: string;
    projectId: number;
    claimId: number;
    revisionId: number | null;
    changeKind: ClaimEffectChangeKind;
}
export type ClaimOperationStageOutcome = {
    kind: "effects";
    payload: CanonicalJsonValue | null;
    effects: readonly ClaimEffectDescriptor[];
    /** Revisions whose policy ladder/projection phase two finalizes. */
    policyRevisionIds?: readonly number[];
    /** Public claim IDs whose mutation tokens are added to the result payload. */
    mutationTokenPublicClaimIds?: readonly string[];
} | {
    kind: "stale";
    reason: string;
    payload?: CanonicalJsonValue | null;
    mutationTokenPublicClaimIds?: readonly string[];
} | {
    kind: "noop";
    payload?: CanonicalJsonValue | null;
    mutationTokenPublicClaimIds?: readonly string[];
};
export interface ClaimOperationRunResult {
    outcome: "applied" | "stale" | "noop";
    replayed: boolean;
    /** Exact stored result bytes; byte-identical across replays (R6). */
    resultJson: string;
    result: ClaimOperationResult;
}
/**
 * Transaction-local two-phase runner. The staging callback runs inside a
 * savepoint; a stale outcome rolls it back so no partial rows survive (R5).
 */
export declare function runClaimOperationInCurrentTransaction(db: Database, envelope: ClaimOperationEnvelope, stage: (db: Database) => ClaimOperationStageOutcome, nowMs?: number): ClaimOperationRunResult;
/** Standalone runner: one immediate transaction around the two phases. */
export declare function runClaimOperation(db: Database, envelope: ClaimOperationEnvelope, stage: (db: Database) => ClaimOperationStageOutcome, nowMs?: number): ClaimOperationRunResult;
export interface ClaimEvidenceProvenance {
    sourceLocator: string;
    /** Raw span text; only its SHA-256 is stored. */
    sourceContent: string;
    sourceSessionId?: string | null;
    extractor: string;
    extractorVersion: string;
    extractorRunId: string;
    independenceKey: string;
    /** Omitted means the schema's conservative `model_inference` default. */
    sourceTrustClass?: SourceTrustClass;
}
/**
 * Canonical provenance shape for claim-operation request digests. Shared with
 * the typed anti-memory writer so both digest the same field set; a field
 * added to `ClaimEvidenceProvenance` must land here exactly once.
 */
export declare function provenanceRequestShape(provenance: ClaimEvidenceProvenance): CanonicalJsonValue;
/**
 * Project a mutation token onto the exact fields that identify the request.
 * Digesting a caller's token object directly would fold in any extra property
 * it happens to carry, so two spellings of the same token — one built here,
 * one round-tripped through JSON by a retrying caller — would digest
 * differently and turn an honest replay into `ClaimOperationKeyReuseError`.
 */
export declare function tokenRequestShape(token: ClaimMutationToken): CanonicalJsonValue;
export interface ProjectMemoryAttributes {
    category: string;
    importance: number;
    memoryScope: MemoryScope;
    sharing: ClaimMemorySharing;
    expiresAt: number | null;
}
/**
 * Importance applied when a create request omits it. Exported so typed writers
 * that build their own request digests can digest the same resolved value this
 * module persists, keeping an omitted importance and an explicit `50` one
 * request rather than two.
 */
export declare const DEFAULT_MEMORY_IMPORTANCE = 50;
/** Rebuild the current-head dedup projection from authoritative rows (KTD4). */
export declare function rebuildClaimMemoryCurrentHeads(db: Database, nowMs?: number): void;
export interface CreateProjectMemoryClaimInput {
    projectId: number;
    content: string;
    /** Optional normalized-hash preimage when display content is not dedup identity. */
    dedupText?: string;
    category: string;
    importance?: number;
    memoryScope?: MemoryScope;
    sharing?: ClaimMemorySharing;
    expiresAt?: number | null;
    provenance: ClaimEvidenceProvenance;
    actor: string;
    userInferred?: boolean;
    requestScope?: string;
    nowMs?: number;
    /**
     * Set only by the typed anti-memory writer (`storage-anti-memory.ts`).
     * The stage refuses `REJECTED_APPROACH` rows without it so no generic
     * caller can mint an anti-memory revision that lacks its payload row.
     */
    antiMemoryWriter?: boolean;
}
export interface ProducerIdentity {
    producer: string;
    operationKey: string;
}
/** Transaction-local domain stage for composition inside one outer claim operation. */
export declare function stageCreateProjectMemoryClaimInCurrentTransaction(db: Database, input: CreateProjectMemoryClaimInput, nowMs: number): ClaimOperationStageOutcome;
/**
 * Create a project-memory claim, or — when a live claim already owns the
 * (project, category, normalized hash) slot — attach the independent
 * provenance as evidence to its current revision (R7).
 */
export declare function createProjectMemoryClaim(db: Database, producer: ProducerIdentity, input: CreateProjectMemoryClaimInput): ClaimOperationRunResult;
export interface ReviseProjectMemoryClaimInput {
    token: ClaimMutationToken;
    content?: string;
    /** Optional normalized-hash preimage when display content is not dedup identity. */
    dedupText?: string;
    category?: string;
    importance?: number;
    memoryScope?: MemoryScope;
    sharing?: ClaimMemorySharing;
    /** Undefined keeps the current expiry; null clears it. */
    expiresAt?: number | null;
    provenance: ClaimEvidenceProvenance;
    actor: string;
    userInferred?: boolean;
    requestScope?: string;
    nowMs?: number;
    /**
     * Set only by the typed anti-memory writer (`storage-anti-memory.ts`).
     * The stage refuses `REJECTED_APPROACH` revisions without it: a generic
     * revise would advance the current revision with no
     * `claim_anti_memory_revision_payloads` row, permanently breaking the
     * typed reader for that claim (the payload table is append-only).
     */
    antiMemoryWriter?: boolean;
}
/** Transaction-local domain stage for composition inside one outer claim operation. */
export declare function stageReviseProjectMemoryClaimInCurrentTransaction(db: Database, input: ReviseProjectMemoryClaimInput, nowMs: number): ClaimOperationStageOutcome;
/**
 * Append a revision carrying changed content and/or revision-bound
 * attributes. Identical content and attributes with independent provenance
 * attach evidence to the current revision instead (R7).
 */
export declare function reviseProjectMemoryClaim(db: Database, producer: ProducerIdentity, input: ReviseProjectMemoryClaimInput): ClaimOperationRunResult;
export interface SetProjectMemoryLifecycleInput {
    token: ClaimMutationToken;
    state: ClaimMemoryLifecycleState;
    actor: string;
    reason?: string | null;
    requestScope?: string;
    nowMs?: number;
}
/** Transaction-local domain stage for composition inside one outer claim operation. */
export declare function stageSetProjectMemoryClaimLifecycleInCurrentTransaction(db: Database, input: SetProjectMemoryLifecycleInput, nowMs: number): ClaimOperationStageOutcome;
/** Append one lifecycle event; the revision identity is untouched. Setting
 * the state the head already holds stores a zero-effect no-op receipt. */
export declare function setProjectMemoryClaimLifecycle(db: Database, producer: ProducerIdentity, input: SetProjectMemoryLifecycleInput): ClaimOperationRunResult;
export interface MergeProjectMemoryClaimsInput {
    targetToken: ClaimMutationToken;
    sourceTokens: readonly ClaimMutationToken[];
    /** Undefined keeps the target's current content. */
    mergedContent?: string;
    actor: string;
    requestScope?: string;
    nowMs?: number;
}
/** Transaction-local domain stage for composition inside one outer claim operation. */
export declare function stageMergeProjectMemoryClaimsInCurrentTransaction(db: Database, input: MergeProjectMemoryClaimsInput, nowMs: number): ClaimOperationStageOutcome;
/**
 * Same-project merge (R8): appends one target revision whose evidence links
 * every observation the sources carry as `merged_from` — including the ones a
 * merge-produced source itself carries as `merged_from`, so lineage survives
 * repeated merges — records supersedes conflicts, and retires the sources.
 * Trust and approval never transfer — the new target revision opens its own
 * conservative policy subject.
 */
export declare function mergeProjectMemoryClaims(db: Database, producer: ProducerIdentity, input: MergeProjectMemoryClaimsInput): ClaimOperationRunResult;
export interface ApplyProjectMemoryMappingInput {
    token: ClaimMutationToken;
    /** Exact revision the mapping was computed against. */
    revisionLocator: string;
    paths: ApplicabilityPathsInput;
    knownFrom?: number;
    nowMs?: number;
}
/** Transaction-local domain stage for composition inside one outer claim operation. */
export declare function stageApplyProjectMemoryMappingInCurrentTransaction(db: Database, input: ApplyProjectMemoryMappingInput, nowMs: number): ClaimOperationStageOutcome;
/** Append path knowledge onto the exact current revision's baseline
 * applicability stream. A mapping equal to the stream head is a no-op. */
export declare function applyProjectMemoryMapping(db: Database, producer: ProducerIdentity, input: ApplyProjectMemoryMappingInput): ClaimOperationRunResult;
export interface RecordProjectMemoryVerificationInput {
    token: ClaimMutationToken;
    revisionLocator: string;
    outcome: "verified" | "update" | "archive" | "stale" | "flagged";
    verifier: string;
    nowMs?: number;
}
export declare function stageRecordProjectMemoryVerificationInCurrentTransaction(db: Database, input: RecordProjectMemoryVerificationInput, nowMs: number): ClaimOperationStageOutcome;
/**
 * Record a verification outcome against an anti-memory claim.
 *
 * The generic recorder refuses this category because a generic revision path
 * drops the TTL, outcome, and scope invariants the typed writer maintains. A
 * verification event carries none of that state — it appends an outcome against
 * the current revision and touches neither content nor category — so the
 * verification lane needs an entry point that is allowed to record one. This is
 * the API that refusal message names; re-exported from `storage-anti-memory.ts`
 * so the typed surface is where a caller looks for it.
 */
export declare function stageAntiMemoryVerificationInCurrentTransaction(db: Database, input: RecordProjectMemoryVerificationInput, nowMs: number): ClaimOperationStageOutcome;
/** Append one verification event against the exact current revision and
 * finalize its policy under the same operation (KTD7 step 6). */
export declare function recordProjectMemoryVerification(db: Database, producer: ProducerIdentity, input: RecordProjectMemoryVerificationInput): ClaimOperationRunResult;
export declare function recordClaimUsage(db: Database, args: {
    publicClaimIds: readonly string[];
    kind: "seen" | "retrieved";
    nowMs?: number;
}): void;
/**
 * Count each DELIVERED anti-memory warning exactly once as `retrieved`.
 *
 * The shared search resolver deliberately counts only `memory`-source usage,
 * so warning retrieval telemetry is a delivery-surface obligation. Every
 * surface that renders packed results (explicit tools, auto-search runners)
 * must call this one entry point instead of restating the filter, or a new
 * consumer silently loses warning counters.
 */
export declare function recordDeliveredAntiMemoryUsage(db: Database, delivered: readonly {
    source: string;
    publicClaimId?: string;
}[], nowMs?: number): void;
export declare function readOutboxConsumerCheckpoint(db: Database, consumer: string, projectId: number): number;
/**
 * Advance one consumer/project cursor. Regression is rejected, the cursor may
 * not run past the current outbox tail, and the acknowledged id must not split a
 * receipt group within the project: a page cannot expose half an operation
 * (KTD13).
 */
export declare function advanceOutboxConsumerCheckpointInCurrentTransaction(db: Database, args: {
    consumer: string;
    projectId: number;
    ackedEffectId: number;
    nowMs?: number;
}): void;
export interface ClaimOutboxPruneResult {
    boundary: number;
    prunedEffectRows: number;
}
/**
 * Consumption-driven outbox retention (KTD13): the prune boundary is the
 * minimum acknowledged effect id across every REQUIRED consumer paired with
 * every project the outbox still holds effects for (an absent checkpoint pins
 * the boundary at zero), and only complete receipt groups at or below the
 * boundary leave. Receipts themselves never leave (R20). Runs inside the
 * caller's write transaction so the enabled=1 capability row can never commit.
 *
 * The pairing is what makes the boundary sound. Checkpoints are keyed
 * (consumer, project_id) while the delete below is global over effect ids, so a
 * consumer-only aggregate reports a boundary derived from the projects it HAS
 * acknowledged and silently ignores the ones it never checkpointed. A consumer
 * caught up on one project past another project's effect ids would then prune
 * effects it never processed.
 */
export declare function pruneClaimOperationEffectsInCurrentTransaction(db: Database, requiredConsumers: readonly string[]): ClaimOutboxPruneResult;
//# sourceMappingURL=storage-claim-operations.d.ts.map