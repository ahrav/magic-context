/**
 *
 * Callers must hold the outer write transaction.
 * Policy decisions, projection rows, outbox effects, and generations commit together.
 * Database triggers enforce ledger invariants.
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

/* */
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

/**
 * Reject writes when `revisionId` has no `claim_revisions` row.
 * */
function loadRevisionDigestOrThrow(db: Database, revisionId: number): string {
    const revision = db
        .prepare("SELECT content_sha256 AS digest FROM claim_revisions WHERE id = ?")
        .get(revisionId) as { digest: string } | null | undefined;
    if (!revision) throw new Error(`claim revision ${revisionId} does not exist`);
    return revision.digest;
}

/**
 * The function reads `source_digest` from `claim_revisions` to prevent caller-supplied digest bindings.
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
 * The transition consumes only the current predecessor in the caller's transaction.
 * The function returns `null` when the head is already at or above the requested rung.
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

/**
 * The function returns `null` when asserting an active disposition or clearing an inactive disposition.
 * */
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
 * The function binds the approval digest from `claim_revisions` in the same transaction.
 * Database constraints revalidate the approval digest binding.
 * A replayed completed command identity returns its stored row ID.
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
    /**
     * */
    enforcedFromRoot?: string | null;
    nowMs?: number;
}

/* */
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

/** Revocation removes ENFORCED support. */
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
 * Revocation must cover every passing, unrevoked enforcement artifact for the revision.
 * Revocation cannot restore `ENFORCED` through an older still-valid artifact.
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
// ---------------------------------------------------------------------------

/* */
export function currentApprovalActionId(db: Database, revisionId: number): number | null {
    const row = db
        .prepare(
            `SELECT id, action FROM claim_approval_actions
             WHERE revision_id = ? ORDER BY id DESC LIMIT 1`,
        )
        .get(revisionId) as { id: number; action: string } | null | undefined;
    return row?.action === "approve" ? row.id : null;
}

/* */
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

/** Independently rooted evidence groups count supports by independence key, extractor run, and observed content.
 * Repeated tool calls from one extractor run count once.
 * Mirrors and copies of one source count once.
 * Derivation lineage of model summaries is not detectable for legacy rows.
 * For legacy rows, U2 writers keep summaries on the source's `independence_key`. */
export function countIndependentEvidenceGroups(db: Database, revisionId: number): number {
    // Count jointly distinct evidence groups; do not use the minimum of marginal key, run, and content counts.
    // The marginal minimum is 2 for `(keyA, run1, X)`, `(keyA, run2, Y)`, and `(keyB, run1, Y)`.
    // Those three rows contain no fully distinct pair because every pair shares a key, run, or content.
    // A fully distinct pair produces a count of 2.
    // The query evaluates the full support set because a fully distinct pair determines the count.
    // The query evaluates the full support set because an application-side row cap could omit the fully distinct pair that determines the count.
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
 * `dashboard:tauri` is the only producer whose explicit-user observation can grant explicit-user credit to a content-changing revision.
 */
export const EXPLICIT_USER_REVISION_PRODUCER = "dashboard:tauri";

/** Revision 1 accepts explicit-user supporting evidence without content-hash matching.
 * Later revisions require either the initial content hash or a matching `dashboard:tauri` observation.
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
    // The latest verified, stale, or flagged event is the only active verification outcome.
    // Filtering each disposition separately would keep both stale and flagged active after a stale-to-flagged transition.
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

/**
 * Callers on the per-write hot path pass their already-gathered `support`.
 * Using the supplied `support` avoids a second multi-query fact read per revision write. */
export function computePolicyDecisionForRevision(
    db: Database,
    revisionId: number,
    precomputed: { support?: PolicySupport; subject?: PolicySubjectRow | null } = {},
): PolicyDecision {
    // `undefined` means no precomputed subject; `null` means no subject and must not trigger a re-read.
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
 * The projection is rebuildable from authoritative rows.
 * `generation` is the claim generation the decision was computed under;
 * Readers verify `generation` before publishing content.
 */
export function updateEffectivePolicyProjectionInCurrentTransaction(
    db: Database,
    identity: RevisionIdentity,
    decision: PolicyDecision,
    generation: number,
    nowMs?: number,
): void {
    // Unknown taint represents a missing subject or an unsupported policy version.
    // `refreshEffectivePolicyInCurrentTransaction` cannot materialize unknown taint.
    // The CHECK constraint permits no unknown taint value.
    // Any substitute taint is directive-capable, silently upgrading unproven origin.
    // The code fails closed rather than requiring every caller to pre-check.
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
 */
export function refreshEffectivePolicyInCurrentTransaction(
    db: Database,
    revisionId: number,
    options: { generation?: number; nowMs?: number; support?: PolicySupport } = {},
): PolicyDecision {
    const identity = readRevisionIdentity(db, revisionId);
    if (!identity) throw new Error(`claim revision ${revisionId} does not exist`);
    const subject = readPolicySubject(db, revisionId);
    const decision = computePolicyDecisionForRevision(db, revisionId, {
        support: options.support,
        subject,
    });
    // A revision without a frozen subject has no projection row; absence fails closed.
    // A revision without a frozen subject has no projection row; writing one would require an unsupported taint value.
    // This evaluator cannot interpret a subject whose policy version exceeds `CLAIM_POLICY_VERSION`.
    // Overwriting a projection from a newer policy version would replace its newer `policy_version` with the current version and fabricate taint.
    // Overwriting the projection would erase the policy-version signal readers use to treat the row as unknown.
    // Readers treat rows with `policy_version > CLAIM_POLICY_VERSION` as unknown.
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

/**
 * */
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
