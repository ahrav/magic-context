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
import {
    CLAIM_POLICY_VERSION,
    type ClaimKind,
    type DispositionKind,
    type EnforcementArtifactKind,
    type EnforcementArtifactResult,
    type FineTaint,
    MATURITY_RANK,
    type MaturityLevel,
} from "../storage-claim-policy-schema.ts";
import {
    type ActiveDispositions,
    evaluateClaimPolicy,
    type PolicyDecision,
    type PolicySupport,
} from "./claim-visibility-policy.ts";

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
export function hasClaimPolicySchema(db: Database): boolean {
    return (
        db
            .prepare(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'claim_revision_policy_subjects'",
            )
            .get() != null
    );
}

export function readPolicySubject(db: Database, revisionId: number): PolicySubjectRow | null {
    const row = db
        .prepare(
            `SELECT revision_id AS revisionId, project_id AS projectId, claim_kind AS claimKind,
                    origin_observation_id AS originObservationId, origin_taint AS originTaint,
                    classification_method AS classificationMethod, source_digest AS sourceDigest,
                    policy_version AS policyVersion
             FROM claim_revision_policy_subjects WHERE revision_id = ?`,
        )
        .get(revisionId) as PolicySubjectRow | null | undefined;
    return row ?? null;
}

export interface CreatePolicySubjectInput {
    revisionId: number;
    projectId: number;
    claimKind: ClaimKind;
    originObservationId: number | null;
    originTaint: FineTaint;
    classificationMethod: string;
    nowMs?: number;
}

/** Load the revision's exact content digest or refuse the write: every
 *  authority row (policy subject, approval, enforcement artifact) binds to
 *  the revision's exact bytes, and a missing revision must fail the write
 *  rather than bind against unchecked data. Shared so a future change to
 *  this binding (extra validation, column change) lands once. */
function loadRevisionDigestOrThrow(db: Database, revisionId: number): string {
    const revision = db
        .prepare("SELECT content_sha256 AS digest FROM claim_revisions WHERE id = ?")
        .get(revisionId) as { digest: string } | null | undefined;
    if (!revision) throw new Error(`claim revision ${revisionId} does not exist`);
    return revision.digest;
}

/**
 * Freeze one immutable policy subject for a revision (R1, KTD2). The bound
 * digest is read from the revision row itself so callers cannot bind foreign
 * content; the database guards re-prove project, digest, and origin evidence.
 * Idempotent: an existing subject row is returned untouched (a held-open
 * writer omission stays readable as conservative unknown until then, R26).
 */
export function createPolicySubjectInCurrentTransaction(
    db: Database,
    input: CreatePolicySubjectInput,
): PolicySubjectRow {
    const existing = readPolicySubject(db, input.revisionId);
    if (existing) return existing;
    const revision = { digest: loadRevisionDigestOrThrow(db, input.revisionId) };
    db.prepare(
        `INSERT INTO claim_revision_policy_subjects
            (revision_id, project_id, claim_kind, origin_observation_id, origin_taint,
             classification_method, source_digest, policy_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        input.revisionId,
        input.projectId,
        input.claimKind,
        input.originObservationId,
        input.originTaint,
        input.classificationMethod,
        revision.digest,
        CLAIM_POLICY_VERSION,
        input.nowMs ?? Date.now(),
    );
    const created = readPolicySubject(db, input.revisionId);
    if (!created) throw new Error(`policy subject for revision ${input.revisionId} not created`);
    return created;
}

export interface MaturityHeadRow {
    assertionId: number;
    streamId: number;
    seq: number;
    maturity: MaturityLevel;
}

export function readMaturityHead(db: Database, revisionId: number): MaturityHeadRow | null {
    const row = db
        .prepare(
            `SELECT assertion_id AS assertionId, stream_id AS streamId, seq, maturity
             FROM claim_maturity_heads WHERE revision_id = ?`,
        )
        .get(revisionId) as MaturityHeadRow | null | undefined;
    return row ?? null;
}

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
export function appendMaturityAssertionInCurrentTransaction(
    db: Database,
    input: AppendMaturityAssertionInput,
): number | null {
    let stream = db
        .prepare("SELECT id FROM claim_maturity_streams WHERE revision_id = ?")
        .get(input.revisionId) as { id: number } | null | undefined;
    const now = input.nowMs ?? Date.now();
    if (!stream) {
        db.prepare(
            "INSERT INTO claim_maturity_streams (revision_id, project_id, created_at) VALUES (?, ?, ?)",
        ).run(input.revisionId, input.projectId, now);
        stream = db
            .prepare("SELECT id FROM claim_maturity_streams WHERE revision_id = ?")
            .get(input.revisionId) as { id: number };
    }
    const head = readMaturityHead(db, input.revisionId);
    if (head && MATURITY_RANK[head.maturity] >= MATURITY_RANK[input.maturity]) return null;
    const result = db
        .prepare(
            `INSERT INTO claim_maturity_assertions
                (stream_id, seq, predecessor_id, maturity, actor, evidence_json,
                 approval_action_id, artifact_id, policy_version, recorded_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
            stream.id,
            (head?.seq ?? 0) + 1,
            head?.assertionId ?? null,
            input.maturity,
            input.actor,
            input.evidenceJson ?? null,
            input.approvalActionId ?? null,
            input.artifactId ?? null,
            CLAIM_POLICY_VERSION,
            now,
        );
    return Number(result.lastInsertRowid);
}

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
export function recordDispositionEventInCurrentTransaction(
    db: Database,
    input: RecordDispositionEventInput,
): number | null {
    const current = db
        .prepare(
            `SELECT action FROM claim_disposition_events
             WHERE revision_id = ? AND disposition = ? ORDER BY id DESC LIMIT 1`,
        )
        .get(input.revisionId, input.disposition) as { action: string } | null | undefined;
    const active = current?.action === "assert";
    if ((input.action === "assert") === active) return null;
    const result = db
        .prepare(
            `INSERT INTO claim_disposition_events
                (revision_id, project_id, disposition, action, reason, actor, policy_version, recorded_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
            input.revisionId,
            input.projectId,
            input.disposition,
            input.action,
            input.reason ?? null,
            input.actor,
            CLAIM_POLICY_VERSION,
            input.nowMs ?? Date.now(),
        );
    return Number(result.lastInsertRowid);
}

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
export function recordApprovalActionInCurrentTransaction(
    db: Database,
    input: RecordApprovalActionInput,
): { actionId: number; replayed: boolean } {
    const existing = db
        .prepare(
            `SELECT id, revision_id AS revisionId, action FROM claim_approval_actions
             WHERE command_identity = ?`,
        )
        .get(input.commandIdentity) as
        | { id: number; revisionId: number; action: string }
        | null
        | undefined;
    if (existing) {
        if (existing.revisionId !== input.revisionId || existing.action !== input.action) {
            throw new Error(
                `approval command identity ${input.commandIdentity} was already committed for a different target`,
            );
        }
        return { actionId: existing.id, replayed: true };
    }
    const revision = { digest: loadRevisionDigestOrThrow(db, input.revisionId) };
    const result = db
        .prepare(
            `INSERT INTO claim_approval_actions
                (revision_id, project_id, action, host, source_session_id, user_command_event,
                 command_identity, confirmation_nonce, revision_digest, policy_version, recorded_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
            input.revisionId,
            input.projectId,
            input.action,
            input.host,
            input.sessionId,
            input.userCommandEvent,
            input.commandIdentity,
            input.confirmationNonce,
            revision.digest,
            CLAIM_POLICY_VERSION,
            input.nowMs ?? Date.now(),
        );
    return { actionId: Number(result.lastInsertRowid), replayed: false };
}

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
export function recordEnforcementArtifactInCurrentTransaction(
    db: Database,
    input: RecordEnforcementArtifactInput,
): number {
    const revision = { digest: loadRevisionDigestOrThrow(db, input.revisionId) };
    const result = db
        .prepare(
            `INSERT INTO claim_enforcement_artifacts
                (revision_id, project_id, artifact_kind, canonical_path, bytes_digest,
                 git_anchor_id, evaluator, evaluator_version, evaluator_result,
                 revision_digest, policy_version, recorded_at, enforced_from_root)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
            input.revisionId,
            input.projectId,
            input.artifactKind,
            input.canonicalPath,
            input.bytesDigest,
            input.gitAnchorId ?? null,
            input.evaluator,
            input.evaluatorVersion,
            input.evaluatorResult,
            revision.digest,
            CLAIM_POLICY_VERSION,
            input.nowMs ?? Date.now(),
            input.enforcedFromRoot ?? null,
        );
    return Number(result.lastInsertRowid);
}

/** Append one artifact revocation event (KTD6): removes ENFORCED support. */
export function revokeEnforcementArtifactInCurrentTransaction(
    db: Database,
    artifactId: number,
    reason: string | null,
    nowMs?: number,
): number {
    const result = db
        .prepare(
            `INSERT INTO claim_enforcement_artifact_events (artifact_id, action, reason, recorded_at)
             VALUES (?, 'revoked', ?, ?)`,
        )
        .run(artifactId, reason, nowMs ?? Date.now());
    return Number(result.lastInsertRowid);
}

/**
 * Every passing, unrevoked enforcement artifact for the revision. Revocation
 * must cover the full set: revoking only the latest would let a re-approval
 * restore ENFORCED through an older still-valid artifact.
 */
export function currentValidArtifactIds(db: Database, revisionId: number): number[] {
    const rows = db
        .prepare(
            `SELECT artifact.id AS id FROM claim_enforcement_artifacts artifact
             WHERE artifact.revision_id = ? AND artifact.evaluator_result = 'pass'
               AND NOT EXISTS (
                   SELECT 1 FROM claim_enforcement_artifact_events event
                   WHERE event.artifact_id = artifact.id AND event.action = 'revoked'
               )
             ORDER BY artifact.id ASC`,
        )
        .all(revisionId) as Array<{ id: number }>;
    return rows.map((row) => row.id);
}

// ---------------------------------------------------------------------------
// Current-support fact readers (R15): append-only history in, booleans out.
// ---------------------------------------------------------------------------

/** Latest effective approval action for the revision, or null. */
export function currentApprovalActionId(db: Database, revisionId: number): number | null {
    const row = db
        .prepare(
            `SELECT id, action FROM claim_approval_actions
             WHERE revision_id = ? ORDER BY id DESC LIMIT 1`,
        )
        .get(revisionId) as { id: number; action: string } | null | undefined;
    return row?.action === "approve" ? row.id : null;
}

/** Latest passing, unrevoked enforcement artifact for the revision, or null. */
export function currentValidArtifactId(db: Database, revisionId: number): number | null {
    const row = db
        .prepare(
            `SELECT artifact.id AS id FROM claim_enforcement_artifacts artifact
             WHERE artifact.revision_id = ? AND artifact.evaluator_result = 'pass'
               AND NOT EXISTS (
                   SELECT 1 FROM claim_enforcement_artifact_events event
                   WHERE event.artifact_id = artifact.id AND event.action = 'revoked'
               )
             ORDER BY artifact.id DESC LIMIT 1`,
        )
        .get(revisionId) as { id: number } | null | undefined;
    return row?.id ?? null;
}

function latestVerificationOutcome(
    db: Database,
    revisionId: number,
    outcomes: readonly string[],
): string | null {
    const placeholders = outcomes.map(() => "?").join(", ");
    const row = db
        .prepare(
            // Interpolation is a compile-time placeholder list, not caller input.
            // pi-lens-ignore: sql-injection
            `SELECT outcome FROM verification_events
             WHERE revision_id = ? AND outcome IN (${placeholders})
             ORDER BY id DESC LIMIT 1`,
        )
        .get(revisionId, ...outcomes) as { outcome: string } | null | undefined;
    return row?.outcome ?? null;
}

function explicitDispositionActive(
    db: Database,
    revisionId: number,
    disposition: DispositionKind,
): boolean {
    const row = db
        .prepare(
            `SELECT action FROM claim_disposition_events
             WHERE revision_id = ? AND disposition = ? ORDER BY id DESC LIMIT 1`,
        )
        .get(revisionId, disposition) as { action: string } | null | undefined;
    return row?.action === "assert";
}

/** Independently rooted evidence group count over supports evidence (R6,
 * KTD4). `independence_key` is one input, capped by distinct extractor runs
 * (repeated tool calls / one extractor run count once) and distinct observed
 * content (mirrors and copies of one source count once).
 * ponytail: derivation lineage of model summaries is not detectable for
 * legacy rows; U2 writers keep summaries on the source's independence_key. */
export function countIndependentEvidenceGroups(db: Database, revisionId: number): number {
    // JOINT independence, not marginal cardinalities: the minimum of three
    // distinct counts reads 2 for (keyA,run1,X), (keyA,run2,Y), (keyB,run1,Y)
    // even though every pair shares a key, a run, or content — promoting a
    // revision to CORROBORATED on evidence that is not independently rooted.
    // The only consumer threshold is >= 2, so an existence check for one
    // fully-distinct pair decides the count. It runs in SQL over the FULL
    // support set: any application-side row cap could truncate away the one
    // row that completes a qualifying pair.
    const row = db
        .prepare(
            `SELECT
                EXISTS (
                    SELECT 1 FROM claim_evidence e
                    JOIN observations o ON o.id = e.observation_id
                    WHERE e.revision_id = ?1 AND e.relation = 'supports'
                ) AS hasAny,
                EXISTS (
                    SELECT 1
                    FROM claim_evidence e1
                    JOIN observations o1 ON o1.id = e1.observation_id
                    JOIN claim_evidence e2 ON e2.revision_id = ?1 AND e2.relation = 'supports'
                    JOIN observations o2 ON o2.id = e2.observation_id
                    WHERE e1.revision_id = ?1 AND e1.relation = 'supports'
                      AND o1.independence_key <> o2.independence_key
                      AND o1.extractor_run_id <> o2.extractor_run_id
                      AND o1.content_sha256 <> o2.content_sha256
                ) AS hasPair`,
        )
        .get(revisionId) as { hasAny: number; hasPair: number };
    if (row.hasPair) return 2;
    return row.hasAny ? 1 : 0;
}

/**
 * The only producer whose explicit-user observation may grant explicit-user
 * credit to a revision that changes content. The retired Tauri dashboard
 * recorded the new content as the observation's own `extracted_text`, and
 * existing databases still hold revisions it authored, so this producer tag
 * and its qualification rule are load-bearing for their trust classification
 * even though no current surface writes new observations under it.
 */
export const EXPLICIT_USER_REVISION_PRODUCER = "dashboard:tauri";

/** Exact explicit-user evidence for this revision. First revisions retain
 * their stated provenance. Later revisions qualify only when their bytes still
 * equal the first revision or when an observation from the
 * `EXPLICIT_USER_REVISION_PRODUCER` channel recorded the revision's exact
 * bytes. */
export function hasExplicitUserEvidence(db: Database, revisionId: number): boolean {
    return (
        db
            .prepare(
                `SELECT 1 FROM claim_evidence e
             JOIN observations o ON o.id = e.observation_id
             JOIN claim_revisions cr ON cr.id = e.revision_id
             WHERE e.revision_id = ? AND e.relation = 'supports'
               AND o.source_trust_class = 'explicit_user'
               AND (
                   cr.revision = 1
                   OR cr.content_sha256 = (
                       SELECT first.content_sha256 FROM claim_revisions first
                       WHERE first.claim_id = cr.claim_id AND first.revision = 1
                   )
                   OR (
                       o.extractor = ?
                       AND o.content_sha256 = cr.content_sha256
                   )
               )
             LIMIT 1`,
            )
            .get(revisionId, EXPLICIT_USER_REVISION_PRODUCER) != null
    );
}

export function readActiveDispositions(db: Database, revisionId: number): ActiveDispositions {
    // Verification status is ONE current outcome: the latest event across
    // verified/stale/flagged supersedes every earlier one. Filtering per
    // disposition would let a stale->flagged transition keep both active.
    const verificationOutcome = latestVerificationOutcome(db, revisionId, [
        "verified",
        "stale",
        "flagged",
    ]);
    const contradicted =
        db
            .prepare(
                `SELECT 1 FROM claim_conflicts
                 WHERE relation = 'contradicts' AND (left_revision_id = ? OR right_revision_id = ?)
                 LIMIT 1`,
            )
            .get(revisionId, revisionId) != null;
    const superseded =
        db
            .prepare(
                `SELECT 1 FROM claim_conflicts
                 WHERE relation = 'supersedes' AND right_revision_id = ? LIMIT 1`,
            )
            .get(revisionId) != null;
    return {
        stale:
            verificationOutcome === "stale" || explicitDispositionActive(db, revisionId, "stale"),
        disputed:
            verificationOutcome === "flagged" ||
            explicitDispositionActive(db, revisionId, "disputed"),
        superseded,
        rejected: explicitDispositionActive(db, revisionId, "rejected"),
        contradicted,
        quarantined: explicitDispositionActive(db, revisionId, "quarantined"),
    };
}

export function readPolicySupport(db: Database, revisionId: number): PolicySupport {
    const head = readMaturityHead(db, revisionId);
    const approvalId = currentApprovalActionId(db, revisionId);
    return {
        historicalMaturity: head?.maturity ?? null,
        approved: approvalId != null,
        enforcedArtifact: currentValidArtifactId(db, revisionId) != null,
        verified:
            latestVerificationOutcome(db, revisionId, ["verified", "stale", "flagged"]) ===
            "verified",
        explicitUserEvidence: hasExplicitUserEvidence(db, revisionId),
        independentGroups: countIndependentEvidenceGroups(db, revisionId),
    };
}

/** Evaluate the pure policy decision from authoritative rows (KTD7). Callers
 * on the per-write hot path pass their already-gathered `support` so the
 * multi-query fact read runs once per revision write, not twice. */
export function computePolicyDecisionForRevision(
    db: Database,
    revisionId: number,
    precomputed: { support?: PolicySupport; subject?: PolicySubjectRow | null } = {},
): PolicyDecision {
    // `undefined` means "not precomputed"; an explicit null is the known
    // absence of a subject and must not trigger a re-read.
    const subject =
        precomputed.subject === undefined ? readPolicySubject(db, revisionId) : precomputed.subject;
    return evaluateClaimPolicy({
        subject: {
            present: subject != null,
            originTaint: subject?.originTaint ?? null,
            policyVersion: subject?.policyVersion ?? null,
        },
        support: precomputed.support ?? readPolicySupport(db, revisionId),
        dispositions: readActiveDispositions(db, revisionId),
    });
}

export interface RevisionIdentity {
    revisionId: number;
    claimId: number;
    projectId: number;
}

export function readRevisionIdentity(db: Database, revisionId: number): RevisionIdentity | null {
    const row = db
        .prepare(
            `SELECT claim_revisions.id AS revisionId, claims.id AS claimId,
                    claims.project_id AS projectId
             FROM claim_revisions JOIN claims ON claims.id = claim_revisions.claim_id
             WHERE claim_revisions.id = ?`,
        )
        .get(revisionId) as RevisionIdentity | null | undefined;
    return row ?? null;
}

/**
 * Materialize one revision's effective decision into the rebuildable
 * projection (KTD7). `generation` is the project claim generation the
 * decision was computed under; readers verify it before publishing content.
 */
export function updateEffectivePolicyProjectionInCurrentTransaction(
    db: Database,
    identity: RevisionIdentity,
    decision: PolicyDecision,
    generation: number,
    nowMs?: number,
): void {
    // An "unknown" taint only arises for a missing subject or an unsupported
    // policy version, and `refreshEffectivePolicyInCurrentTransaction` skips
    // the write for both. Persisting it would require inventing a concrete
    // taint (the CHECK constraint has no "unknown" word), and any substitute
    // is directive-capable — a silent trust upgrade for a claim of unproven
    // origin. Fail closed instead of relying on every caller to pre-check.
    if (decision.originTaint === "unknown") {
        throw new Error(
            `refusing to project an unknown origin taint for revision ${identity.revisionId}`,
        );
    }
    db.prepare(
        `INSERT INTO claim_effective_policy
            (revision_id, claim_id, project_id, effective_maturity, origin_taint,
             auto_eligible, explicit_eligible, hard_hidden, reason_codes_json,
             dispositions_json, policy_version, generation, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(revision_id) DO UPDATE SET
            effective_maturity = excluded.effective_maturity,
            origin_taint = excluded.origin_taint,
            auto_eligible = excluded.auto_eligible,
            explicit_eligible = excluded.explicit_eligible,
            hard_hidden = excluded.hard_hidden,
            reason_codes_json = excluded.reason_codes_json,
            dispositions_json = excluded.dispositions_json,
            policy_version = excluded.policy_version,
            generation = excluded.generation,
            updated_at = excluded.updated_at`,
    ).run(
        identity.revisionId,
        identity.claimId,
        identity.projectId,
        decision.effectiveMaturity,
        decision.originTaint,
        decision.surfaces.auto_inject.eligible ? 1 : 0,
        decision.surfaces.explicit_search.eligible ? 1 : 0,
        decision.hardHidden ? 1 : 0,
        JSON.stringify(decision.reasonCodes),
        JSON.stringify(decision.activeDispositions),
        decision.policyVersion,
        generation,
        nowMs ?? Date.now(),
    );
}

export function currentProjectPolicyGeneration(db: Database, projectId: number): number {
    const row = db
        .prepare("SELECT generation FROM claim_project_generations WHERE project_id = ?")
        .get(projectId) as { generation: number } | null | undefined;
    return row?.generation ?? 0;
}

/**
 * Recompute and materialize one revision's effective policy from
 * authoritative rows. Returns the decision so callers can attach it to an
 * outbox effect in the same envelope (R27).
 */
export function refreshEffectivePolicyInCurrentTransaction(
    db: Database,
    revisionId: number,
    options: { generation?: number; nowMs?: number; support?: PolicySupport } = {},
): PolicyDecision {
    const identity = readRevisionIdentity(db, revisionId);
    if (!identity) throw new Error(`claim revision ${revisionId} does not exist`);
    // Read the subject once and share it with the decision computation and
    // the projection guard below; this runs on the per-write hot path and
    // every corpus-wide backfill pass.
    const subject = readPolicySubject(db, revisionId);
    const decision = computePolicyDecisionForRevision(db, revisionId, {
        support: options.support,
        subject,
    });
    // A revision without a frozen subject stays absent from the projection:
    // absence is the fail-closed contract, and writing a row would need a
    // fabricated taint value the CHECK constraint has no word for. A subject
    // written by a NEWER policy version is likewise not interpretable here:
    // overwriting its projection would stamp the current policy_version and a
    // fabricated taint over the row, erasing the very signal
    // (`policy_version > CLAIM_POLICY_VERSION`) readers use to treat it as
    // unknown. Keep the newer build's row untouched.
    if (subject == null || decision.reasonCodes.includes("policy_version_unsupported")) {
        return decision;
    }
    updateEffectivePolicyProjectionInCurrentTransaction(
        db,
        identity,
        decision,
        options.generation ?? currentProjectPolicyGeneration(db, identity.projectId),
        options.nowMs,
    );
    return decision;
}

// ---------------------------------------------------------------------------
// Projector watermarks (KTD9)
// ---------------------------------------------------------------------------

export function readProjectorWatermark(
    db: Database,
    consumer: string,
    projectId: number,
): { watermark: number; generation: number } | null {
    const row = db
        .prepare(
            `SELECT watermark, generation FROM claim_policy_projector_watermarks
             WHERE consumer = ? AND project_id = ?`,
        )
        .get(consumer, projectId) as { watermark: number; generation: number } | null | undefined;
    return row ?? null;
}

/** Advance one projector watermark; regression is rejected (at-most-once
 * generation acknowledgement, KTD9). */
export function advanceProjectorWatermarkInCurrentTransaction(
    db: Database,
    consumer: string,
    projectId: number,
    watermark: number,
    generation: number,
    nowMs?: number,
): void {
    const existing = readProjectorWatermark(db, consumer, projectId);
    if (existing && (watermark < existing.watermark || generation < existing.generation)) {
        throw new Error(
            `projector watermark for ${consumer}/${projectId} cannot regress (${existing.watermark}/${existing.generation} -> ${watermark}/${generation})`,
        );
    }
    db.prepare(
        `INSERT INTO claim_policy_projector_watermarks
            (consumer, project_id, watermark, generation, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(consumer, project_id) DO UPDATE SET
            watermark = excluded.watermark,
            generation = excluded.generation,
            updated_at = excluded.updated_at`,
    ).run(consumer, projectId, watermark, generation, nowMs ?? Date.now());
}
