/**
 * Transaction-local claim policy write kernel and fact readers
 * (claim-trust-policy plan: U2; KTD1-KTD4, KTD7, KTD9).
 *
 * Every writer here assumes the caller already holds the outer write
 * transaction (`runInMemoryClaimsWriteTransaction` / the operation envelope),
 * matching the claim-operation kernel pattern. Policy decisions,
 * projection rows, outbox effects, and generations therefore commit together
 * (R27); the append-only v86 triggers enforce the ledger invariants at the
 * database boundary.
 */
import type { Database } from "../../../shared/sqlite.ts";
import { type ClaimKind, type DispositionKind, type EnforcementArtifactKind, type EnforcementArtifactResult, type FineTaint, type MaturityLevel } from "../storage-claim-policy-schema.ts";
import { type ActiveDispositions, type PolicyDecision, type PolicySupport } from "./claim-visibility-policy.ts";
export interface PolicySubjectRow {
    revisionId: number;
    projectId: number;
    claimKind: ClaimKind;
    originObservationId: number | null;
    originTaint: FineTaint;
    classificationMethod: string;
    sourceDigest: string;
    policyVersion: number;
}
/** Whether this database migrated to v86. */
export declare function hasClaimPolicySchema(db: Database): boolean;
export declare function readPolicySubject(db: Database, revisionId: number): PolicySubjectRow | null;
export interface CreatePolicySubjectInput {
    revisionId: number;
    projectId: number;
    claimKind: ClaimKind;
    originObservationId: number | null;
    originTaint: FineTaint;
    classificationMethod: string;
    nowMs?: number;
}
/**
 * Freeze one immutable policy subject for a revision (R1, KTD2). The bound
 * digest is read from the revision row itself so callers cannot bind foreign
 * content; the database guards re-prove project, digest, and origin evidence.
 * Idempotent: an existing subject row is returned untouched (a held-open
 * writer omission stays readable as conservative unknown until then, R26).
 */
export declare function createPolicySubjectInCurrentTransaction(db: Database, input: CreatePolicySubjectInput): PolicySubjectRow;
export interface MaturityHeadRow {
    assertionId: number;
    streamId: number;
    seq: number;
    maturity: MaturityLevel;
}
export declare function readMaturityHead(db: Database, revisionId: number): MaturityHeadRow | null;
export interface AppendMaturityAssertionInput {
    revisionId: number;
    projectId: number;
    maturity: MaturityLevel;
    actor: string;
    evidenceJson?: string | null;
    approvalActionId?: number | null;
    artifactId?: number | null;
    nowMs?: number;
}
/**
 * Append one maturity decision (KTD1). Reads the stream head inside the
 * caller's immediate transaction, consumes exactly the current predecessor,
 * and lets the chain/ladder/collision triggers reject a racing writer's
 * duplicate successor. Returns null when the head already sits at or above
 * the requested rung (idempotent no-op).
 */
export declare function appendMaturityAssertionInCurrentTransaction(db: Database, input: AppendMaturityAssertionInput): number | null;
export interface RecordDispositionEventInput {
    revisionId: number;
    projectId: number;
    disposition: DispositionKind;
    action: "assert" | "clear";
    actor: string;
    reason?: string | null;
    nowMs?: number;
}
/** Append one explicit disposition assert/clear (R14). Idempotent per state:
 * asserting an already-active disposition (or clearing an inactive one)
 * returns null instead of appending noise. */
export declare function recordDispositionEventInCurrentTransaction(db: Database, input: RecordDispositionEventInput): number | null;
export interface RecordApprovalActionInput {
    revisionId: number;
    projectId: number;
    action: "approve" | "revoke";
    host: string;
    sessionId: string;
    userCommandEvent: string;
    commandIdentity: string;
    confirmationNonce: string;
    nowMs?: number;
}
/**
 * Append one host-confirmed approval action (R10, KTD5). The revision digest
 * is bound from the current revision row inside the same transaction; the
 * database guards re-prove the binding. Replaying a completed command
 * identity returns the stored row id; reusing it for a different revision or
 * action fails.
 */
export declare function recordApprovalActionInCurrentTransaction(db: Database, input: RecordApprovalActionInput): {
    actionId: number;
    replayed: boolean;
};
export interface RecordEnforcementArtifactInput {
    revisionId: number;
    projectId: number;
    artifactKind: EnforcementArtifactKind;
    canonicalPath: string;
    bytesDigest: string;
    gitAnchorId?: number | null;
    evaluator: string;
    evaluatorVersion: string;
    evaluatorResult: EnforcementArtifactResult;
    /** Filesystem root the evaluation ran in; revalidation only rehashes
     *  from this checkout (clones/worktrees share the project identity). */
    enforcedFromRoot?: string | null;
    nowMs?: number;
}
/** Append one content-addressed enforcement artifact record (R11, KTD6). */
export declare function recordEnforcementArtifactInCurrentTransaction(db: Database, input: RecordEnforcementArtifactInput): number;
/** Append one artifact revocation event (KTD6): removes ENFORCED support. */
export declare function revokeEnforcementArtifactInCurrentTransaction(db: Database, artifactId: number, reason: string | null, nowMs?: number): number;
/**
 * Every passing, unrevoked enforcement artifact for the revision. Revocation
 * must cover the full set: revoking only the latest would let a re-approval
 * restore ENFORCED through an older still-valid artifact.
 */
export declare function currentValidArtifactIds(db: Database, revisionId: number): number[];
/** Latest effective approval action for the revision, or null. */
export declare function currentApprovalActionId(db: Database, revisionId: number): number | null;
/** Latest passing, unrevoked enforcement artifact for the revision, or null. */
export declare function currentValidArtifactId(db: Database, revisionId: number): number | null;
/** Independently rooted evidence group count over supports evidence (R6,
 * KTD4). `independence_key` is one input, capped by distinct extractor runs
 * (repeated tool calls / one extractor run count once) and distinct observed
 * content (mirrors and copies of one source count once).
 * ponytail: derivation lineage of model summaries is not detectable for
 * legacy rows; U2 writers keep summaries on the source's independence_key. */
export declare function countIndependentEvidenceGroups(db: Database, revisionId: number): number;
/**
 * The only producer whose explicit-user observation may grant explicit-user
 * credit to a revision that changes content. The retired Tauri dashboard
 * recorded the new content as the observation's own `extracted_text`, and
 * existing databases still hold revisions it authored, so this producer tag
 * and its qualification rule are load-bearing for their trust classification
 * even though no current surface writes new observations under it.
 */
export declare const EXPLICIT_USER_REVISION_PRODUCER = "dashboard:tauri";
/** Exact explicit-user evidence for this revision. First revisions retain
 * their stated provenance. Later revisions qualify only when their bytes still
 * equal the first revision or when an observation from the
 * `EXPLICIT_USER_REVISION_PRODUCER` channel recorded the revision's exact
 * bytes. */
export declare function hasExplicitUserEvidence(db: Database, revisionId: number): boolean;
export declare function readActiveDispositions(db: Database, revisionId: number): ActiveDispositions;
export declare function readPolicySupport(db: Database, revisionId: number): PolicySupport;
/** Evaluate the pure policy decision from authoritative rows (KTD7). Callers
 * on the per-write hot path pass their already-gathered `support` so the
 * multi-query fact read runs once per revision write, not twice. */
export declare function computePolicyDecisionForRevision(db: Database, revisionId: number, precomputed?: {
    support?: PolicySupport;
    subject?: PolicySubjectRow | null;
}): PolicyDecision;
export interface RevisionIdentity {
    revisionId: number;
    claimId: number;
    projectId: number;
}
export declare function readRevisionIdentity(db: Database, revisionId: number): RevisionIdentity | null;
/**
 * Materialize one revision's effective decision into the rebuildable
 * projection (KTD7). `generation` is the project claim generation the
 * decision was computed under; readers verify it before publishing content.
 */
export declare function updateEffectivePolicyProjectionInCurrentTransaction(db: Database, identity: RevisionIdentity, decision: PolicyDecision, generation: number, nowMs?: number): void;
export declare function currentProjectPolicyGeneration(db: Database, projectId: number): number;
/**
 * Recompute and materialize one revision's effective policy from
 * authoritative rows. Returns the decision so callers can attach it to an
 * outbox effect in the same envelope (R27).
 */
export declare function refreshEffectivePolicyInCurrentTransaction(db: Database, revisionId: number, options?: {
    generation?: number;
    nowMs?: number;
    support?: PolicySupport;
}): PolicyDecision;
export declare function readProjectorWatermark(db: Database, consumer: string, projectId: number): {
    watermark: number;
    generation: number;
} | null;
/** Advance one projector watermark; regression is rejected (at-most-once
 * generation acknowledgement, KTD9). */
export declare function advanceProjectorWatermarkInCurrentTransaction(db: Database, consumer: string, projectId: number, watermark: number, generation: number, nowMs?: number): void;
//# sourceMappingURL=storage-claim-policy.d.ts.map