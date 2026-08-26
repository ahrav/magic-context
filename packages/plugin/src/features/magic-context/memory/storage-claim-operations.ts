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

import { type Database, isInTransaction } from "../../../shared/sqlite";
import type { SourceTrustClass } from "../storage-claim-applicability-schema.ts";
import {
    APPLICABILITY_BASELINE_STREAM_KEY,
    APPLICABILITY_STREAM_KEY_PROTOCOL,
} from "../storage-claim-applicability-schema.ts";
import type {
    ClaimEffectChangeKind,
    ClaimMemoryLifecycleState,
    ClaimMemorySharing,
} from "../storage-claim-memory-schema.ts";
import {
    type CanonicalJsonValue,
    CLAIM_REQUEST_ENCODING_VERSION,
    CLAIM_RESULT_ENCODING_VERSION,
    type ClaimMutationToken,
    type ClaimOperationResult,
    type ClaimOperationResultEffect,
    canonicalJsonEncode,
    computeApplicabilityHeadsDigest,
    computeClaimOperationRequestDigest,
    computePolicyHeadsDigest,
    decodeClaimOperationResult,
    encodeClaimOperationResult,
    formatRevisionLocator,
    generatePublicClaimId,
    isValidPublicClaimId,
} from "./claim-operation-contract.ts";
import {
    automaticLadderSteps,
    classifyFineTaint,
    TAINT_CLASSIFIER_METHOD,
} from "./claim-policy.ts";
import { computeNormalizedHash } from "./normalize-hash.ts";
import {
    type ApplicabilityPathsInput,
    syncRevisionApplicabilityPathsInCurrentTransaction,
} from "./storage-claim-applicability.ts";
import {
    appendMaturityAssertionInCurrentTransaction,
    createPolicySubjectInCurrentTransaction,
    readPolicySubject,
    readPolicySupport,
    refreshEffectivePolicyInCurrentTransaction,
} from "./storage-claim-policy.ts";
import {
    addClaimConflictInCurrentTransaction,
    appendClaimRevisionInCurrentTransaction,
    ClaimGraphCorruptionError,
    createClaimInCurrentTransaction,
    createEpisode,
    createObservation,
    createSourceSpan,
    sha256Utf8Hex,
} from "./storage-claims.ts";
import type { MemoryScope } from "./types.ts";

/** Frozen semantic key vocabulary for direct project-memory claims. */
export const PROJECT_MEMORY_CLAIM_PREDICATE = "states";
export const PROJECT_MEMORY_CLAIM_SCOPE = "project-memory";

/** Actor stamped on automatic maturity ladder steps by the kernel. */
export const CLAIM_KERNEL_POLICY_ACTOR = "mc-claim-kernel-v1";

export class ClaimOperationKeyReuseError extends Error {
    constructor(producer: string, operationKey: string) {
        super(
            `claim operation key ${producer}/${operationKey} was already committed for a different request digest`,
        );
        this.name = "ClaimOperationKeyReuseError";
    }
}

/** Caller-input defects (unknown claim, duplicate collision, bad shape).
 * Thrown before any receipt exists, so the transaction rolls back whole. */
export class ClaimOperationInputError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ClaimOperationInputError";
    }
}

// ---------------------------------------------------------------------------
// Claim-local mutation token (KTD3, R5)
// ---------------------------------------------------------------------------

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
export function getProjectMemoryClaimByPublicId(
    db: Database,
    publicClaimId: string,
): ProjectMemoryClaimRef | null {
    if (!isValidPublicClaimId(publicClaimId)) {
        throw new ClaimOperationInputError(`malformed public claim ID: ${publicClaimId}`);
    }
    const row = db
        .prepare(
            `SELECT claims.id AS claimId, claims.project_id AS projectId,
                    claims.current_revision_id AS currentRevisionId
               FROM claim_public_ids
               JOIN claims ON claims.id = claim_public_ids.claim_id
              WHERE claim_public_ids.public_id = ?`,
        )
        .get(publicClaimId) as
        | { claimId: number; projectId: number; currentRevisionId: number | null }
        | undefined;
    if (!row) return null;
    if (row.currentRevisionId === null) {
        throw new ClaimGraphCorruptionError(
            `claim ${row.claimId} has a null current-revision pointer; direct-SQL corruption`,
        );
    }
    const revision = db
        .prepare(
            `SELECT revision, content, content_sha256 AS contentDigest
               FROM claim_revisions WHERE id = ? AND claim_id = ?`,
        )
        .get(row.currentRevisionId, row.claimId) as
        | { revision: number; content: string; contentDigest: string }
        | undefined;
    if (!revision) {
        throw new ClaimGraphCorruptionError(
            `claim ${row.claimId} points at missing revision ${row.currentRevisionId}`,
        );
    }
    return {
        claimId: row.claimId,
        projectId: row.projectId,
        publicClaimId,
        currentRevisionId: row.currentRevisionId,
        revision: revision.revision,
        contentDigest: revision.contentDigest,
        content: revision.content,
    };
}

function lifecycleHeadSeq(db: Database, claimId: number): number {
    const row = db
        .prepare("SELECT MAX(seq) AS seq FROM claim_memory_lifecycle_events WHERE claim_id = ?")
        .get(claimId) as { seq: number | null };
    return row.seq ?? 0;
}

function lifecycleHead(
    db: Database,
    claimId: number,
): { eventId: number; seq: number; state: ClaimMemoryLifecycleState } | null {
    const row = db
        .prepare(
            `SELECT event_id AS eventId, seq, state
               FROM claim_memory_lifecycle_heads WHERE claim_id = ?`,
        )
        .get(claimId) as
        | { eventId: number; seq: number; state: ClaimMemoryLifecycleState }
        | undefined;
    return row ?? null;
}

function applicabilityHeadsDigestForRevision(db: Database, revisionId: number): string {
    const rows = db
        .prepare(
            `SELECT stream.stream_key AS streamKey, MAX(assertion.seq) AS seq
               FROM claim_revision_applicability_streams stream
               JOIN claim_revision_applicability_assertions assertion
                 ON assertion.stream_id = stream.id
              WHERE stream.revision_id = ?
              GROUP BY stream.id`,
        )
        .all(revisionId) as Array<{ streamKey: string; seq: number }>;
    return computeApplicabilityHeadsDigest(rows);
}

function policyHeadsDigestForRevision(db: Database, revisionId: number): string {
    const counts = db
        .prepare(
            `SELECT
                COALESCE((SELECT seq FROM claim_maturity_heads WHERE revision_id = ?1), 0) AS maturitySeq,
                (SELECT COUNT(*) FROM claim_approval_actions WHERE revision_id = ?1) AS approvalCount,
                (SELECT COUNT(*) FROM claim_disposition_events WHERE revision_id = ?1) AS dispositionCount,
                (SELECT COUNT(*) FROM claim_enforcement_artifacts WHERE revision_id = ?1) AS artifactCount,
                (SELECT COUNT(*) FROM claim_enforcement_artifact_events event
                   JOIN claim_enforcement_artifacts artifact ON artifact.id = event.artifact_id
                  WHERE artifact.revision_id = ?1) AS artifactEventCount,
                (SELECT COUNT(*) FROM verification_events WHERE revision_id = ?1) AS verificationCount`,
        )
        .get(revisionId) as {
        maturitySeq: number;
        approvalCount: number;
        dispositionCount: number;
        artifactCount: number;
        artifactEventCount: number;
        verificationCount: number;
    };
    return computePolicyHeadsDigest(counts);
}

/** Mint the claim-local mutation token for the claim's current state. */
export function computeProjectMemoryMutationToken(
    db: Database,
    publicClaimId: string,
): ClaimMutationToken {
    const claim = getProjectMemoryClaimByPublicId(db, publicClaimId);
    if (!claim) {
        throw new ClaimOperationInputError(`unknown project-memory claim: ${publicClaimId}`);
    }
    return {
        tokenVersion: 1,
        publicClaimId,
        revision: claim.revision,
        contentDigest: claim.contentDigest,
        lifecycleSeq: lifecycleHeadSeq(db, claim.claimId),
        applicabilityHeadsDigest: applicabilityHeadsDigestForRevision(db, claim.currentRevisionId),
        policyHeadsDigest: policyHeadsDigestForRevision(db, claim.currentRevisionId),
    };
}

export type ClaimTokenStalePart = "revision" | "lifecycle" | "applicability" | "policy";

export type ClaimTokenValidation =
    | { ok: true; claim: ProjectMemoryClaimRef }
    | { ok: false; stalePart: ClaimTokenStalePart; reason: string };

/** Recompute the token under the write transaction and name the stale part. */
export function validateProjectMemoryMutationToken(
    db: Database,
    token: ClaimMutationToken,
): ClaimTokenValidation {
    const claim = getProjectMemoryClaimByPublicId(db, token.publicClaimId);
    if (!claim) {
        throw new ClaimOperationInputError(`unknown project-memory claim: ${token.publicClaimId}`);
    }
    if (token.tokenVersion !== 1) {
        throw new ClaimOperationInputError(
            `unsupported claim mutation token version: ${String(token.tokenVersion)}`,
        );
    }
    if (token.revision !== claim.revision || token.contentDigest !== claim.contentDigest) {
        return {
            ok: false,
            stalePart: "revision",
            reason: `revision head moved from r${token.revision} to r${claim.revision}`,
        };
    }
    if (token.lifecycleSeq !== lifecycleHeadSeq(db, claim.claimId)) {
        return { ok: false, stalePart: "lifecycle", reason: "lifecycle head moved" };
    }
    if (
        token.applicabilityHeadsDigest !==
        applicabilityHeadsDigestForRevision(db, claim.currentRevisionId)
    ) {
        return { ok: false, stalePart: "applicability", reason: "applicability heads moved" };
    }
    if (token.policyHeadsDigest !== policyHeadsDigestForRevision(db, claim.currentRevisionId)) {
        return { ok: false, stalePart: "policy", reason: "policy heads moved" };
    }
    return { ok: true, claim };
}

// ---------------------------------------------------------------------------
// Generic two-phase runner (KTD5)
// ---------------------------------------------------------------------------

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

export type ClaimOperationStageOutcome =
    | {
          kind: "effects";
          payload: CanonicalJsonValue | null;
          effects: readonly ClaimEffectDescriptor[];
          /** Revisions whose policy ladder/projection phase two finalizes. */
          policyRevisionIds?: readonly number[];
          /** Public claim IDs whose mutation tokens are added to the result payload. */
          mutationTokenPublicClaimIds?: readonly string[];
      }
    | {
          kind: "stale";
          reason: string;
          payload?: CanonicalJsonValue | null;
          mutationTokenPublicClaimIds?: readonly string[];
      }
    | {
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

class StaleRollback extends Error {
    constructor(public readonly reason: string) {
        super(reason);
        this.name = "StaleRollback";
    }
}

function toRowId(result: unknown): number {
    const rowid = (result as { lastInsertRowid?: number | bigint }).lastInsertRowid;
    const value = Number(rowid);
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`insert did not produce a safe row id: ${String(rowid)}`);
    }
    return value;
}

function revisionLocatorForRow(db: Database, revisionId: number | null): string | null {
    if (revisionId === null) return null;
    const row = db
        .prepare(
            `SELECT claim_public_ids.public_id AS publicClaimId,
                    claim_revisions.revision AS revision,
                    claim_revisions.content_sha256 AS contentDigest
               FROM claim_revisions
               JOIN claim_public_ids ON claim_public_ids.claim_id = claim_revisions.claim_id
              WHERE claim_revisions.id = ?`,
        )
        .get(revisionId) as
        | { publicClaimId: string; revision: number; contentDigest: string }
        | undefined;
    if (!row) return null;
    return formatRevisionLocator(row);
}

function payloadWithMutationTokens(
    db: Database,
    payload: CanonicalJsonValue | null,
    publicClaimIds: readonly string[] | undefined,
): CanonicalJsonValue | null {
    if (!publicClaimIds || publicClaimIds.length === 0) return payload;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        throw new ClaimOperationInputError("mutation-token results require an object payload");
    }
    return {
        ...payload,
        mutationTokens: [...new Set(publicClaimIds)].map((publicClaimId) =>
            tokenRequestShape(computeProjectMemoryMutationToken(db, publicClaimId)),
        ),
    };
}

/** Ladder + projection finalization for one revision under an allocated
 * generation (phase two of KTD5). */
function finalizeRevisionPolicyInCurrentTransaction(
    db: Database,
    revisionId: number,
    generation: number,
    nowMs: number,
): void {
    const subject = readPolicySubject(db, revisionId);
    if (!subject) {
        throw new ClaimGraphCorruptionError(
            `claim revision ${revisionId} reached policy finalization without a policy subject`,
        );
    }
    const support = readPolicySupport(db, revisionId);
    const steps = automaticLadderSteps(support.historicalMaturity, {
        kind: subject.claimKind,
        originTaint: subject.originTaint,
        independentGroups: support.independentGroups,
        verified: support.verified,
        explicitUserEvidence: support.explicitUserEvidence,
    });
    for (const step of steps) {
        appendMaturityAssertionInCurrentTransaction(db, {
            revisionId,
            projectId: subject.projectId,
            maturity: step,
            actor: CLAIM_KERNEL_POLICY_ACTOR,
            nowMs,
        });
    }
    refreshEffectivePolicyInCurrentTransaction(db, revisionId, {
        generation,
        nowMs,
        ...(steps.length === 0 ? { support } : {}),
    });
}

function readStoredReceipt(
    db: Database,
    envelope: ClaimOperationEnvelope,
): { requestDigest: string; resultJson: string; outcome: string } | null {
    const row = db
        .prepare(
            `SELECT request_digest AS requestDigest, result_json AS resultJson, outcome
               FROM claim_operation_receipts WHERE producer = ? AND operation_key = ?`,
        )
        .get(envelope.producer, envelope.operationKey) as
        | { requestDigest: string; resultJson: string; outcome: string }
        | undefined;
    return row ?? null;
}

function insertReceipt(
    db: Database,
    envelope: ClaimOperationEnvelope,
    args: {
        outcome: "applied" | "stale" | "noop";
        expectedEffectCount: number;
        effectSummaryJson: string;
        generationVectorJson: string;
        resultJson: string;
        nowMs: number;
    },
): number {
    return toRowId(
        db
            .prepare(
                `INSERT INTO claim_operation_receipts
                    (producer, operation_key, request_digest, request_encoding_version,
                     result_encoding_version, outcome, expected_effect_count,
                     effect_summary_json, generation_vector_json, result_json, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                envelope.producer,
                envelope.operationKey,
                envelope.requestDigest,
                CLAIM_REQUEST_ENCODING_VERSION,
                CLAIM_RESULT_ENCODING_VERSION,
                args.outcome,
                args.expectedEffectCount,
                args.effectSummaryJson,
                args.generationVectorJson,
                args.resultJson,
                args.nowMs,
            ),
    );
}

/**
 * Transaction-local two-phase runner. The staging callback runs inside a
 * savepoint; a stale outcome rolls it back so no partial rows survive (R5).
 */
export function runClaimOperationInCurrentTransaction(
    db: Database,
    envelope: ClaimOperationEnvelope,
    stage: (db: Database) => ClaimOperationStageOutcome,
    nowMs: number = Date.now(),
): ClaimOperationRunResult {
    if (!isInTransaction(db)) {
        throw new Error("runClaimOperationInCurrentTransaction requires an active transaction");
    }
    const existing = readStoredReceipt(db, envelope);
    if (existing) {
        if (existing.requestDigest !== envelope.requestDigest) {
            throw new ClaimOperationKeyReuseError(envelope.producer, envelope.operationKey);
        }
        return {
            outcome: existing.outcome as "applied" | "stale" | "noop",
            replayed: true,
            resultJson: existing.resultJson,
            result: decodeClaimOperationResult(existing.resultJson),
        };
    }

    let staged: ClaimOperationStageOutcome | undefined;
    try {
        db.transaction(() => {
            staged = stage(db);
            if (staged.kind === "stale") throw new StaleRollback(staged.reason);
        })();
    } catch (error) {
        if (!(error instanceof StaleRollback)) throw error;
    }
    if (staged === undefined) throw new Error("claim operation staging returned no outcome");

    if (staged.kind !== "effects") {
        const result: ClaimOperationResult = {
            resultEncodingVersion: CLAIM_RESULT_ENCODING_VERSION,
            outcome: staged.kind,
            staleReason: staged.kind === "stale" ? staged.reason : null,
            payload: payloadWithMutationTokens(
                db,
                staged.payload ?? null,
                staged.mutationTokenPublicClaimIds,
            ),
            effects: [],
            generations: {},
        };
        const resultJson = encodeClaimOperationResult(result);
        insertReceipt(db, envelope, {
            outcome: staged.kind,
            expectedEffectCount: 0,
            effectSummaryJson: "[]",
            generationVectorJson: "{}",
            resultJson,
            nowMs,
        });
        return { outcome: staged.kind, replayed: false, resultJson, result };
    }

    if (staged.effects.length === 0) {
        throw new ClaimOperationInputError(
            "an effects outcome must declare at least one effect; use noop instead",
        );
    }

    // Phase two: one generation per touched project (R4).
    const generationByProject = new Map<number, { generation: number; existed: boolean }>();
    for (const effect of staged.effects) {
        if (generationByProject.has(effect.projectId)) continue;
        const row = db
            .prepare("SELECT generation FROM claim_project_generations WHERE project_id = ?")
            .get(effect.projectId) as { generation: number } | null | undefined;
        generationByProject.set(effect.projectId, {
            generation: (row?.generation ?? 0) + 1,
            existed: row != null,
        });
    }
    for (const [projectId, allocation] of generationByProject) {
        // Append-only collision guards inspect every INSERT, including ON
        // CONFLICT resolution, so allocation uses UPDATE-then-INSERT.
        if (allocation.existed) {
            db.prepare(
                "UPDATE claim_project_generations SET generation = ?, updated_at = ? WHERE project_id = ?",
            ).run(allocation.generation, nowMs, projectId);
        } else {
            db.prepare(
                "INSERT INTO claim_project_generations (project_id, generation, updated_at) VALUES (?, ?, ?)",
            ).run(projectId, allocation.generation, nowMs);
        }
    }

    for (const revisionId of staged.policyRevisionIds ?? []) {
        const projectId = (
            db
                .prepare(
                    `SELECT claims.project_id AS projectId FROM claim_revisions
                       JOIN claims ON claims.id = claim_revisions.claim_id
                      WHERE claim_revisions.id = ?`,
                )
                .get(revisionId) as { projectId: number } | undefined
        )?.projectId;
        if (projectId === undefined) {
            throw new ClaimGraphCorruptionError(
                `policy finalization revision ${revisionId} does not exist`,
            );
        }
        const generation =
            generationByProject.get(projectId)?.generation ??
            (
                db
                    .prepare(
                        "SELECT generation FROM claim_project_generations WHERE project_id = ?",
                    )
                    .get(projectId) as { generation: number } | undefined
            )?.generation ??
            0;
        finalizeRevisionPolicyInCurrentTransaction(db, revisionId, generation, nowMs);
    }

    const resultEffects: ClaimOperationResultEffect[] = staged.effects.map((effect) => ({
        effectKey: effect.effectKey,
        changeKind: effect.changeKind,
        projectId: effect.projectId,
        generation: generationByProject.get(effect.projectId)?.generation as number,
        revisionLocator: revisionLocatorForRow(db, effect.revisionId),
    }));
    const generations: Record<string, number> = {};
    for (const [projectId, allocation] of generationByProject) {
        generations[String(projectId)] = allocation.generation;
    }
    const result: ClaimOperationResult = {
        resultEncodingVersion: CLAIM_RESULT_ENCODING_VERSION,
        outcome: "applied",
        staleReason: null,
        payload: payloadWithMutationTokens(db, staged.payload, staged.mutationTokenPublicClaimIds),
        effects: resultEffects,
        generations,
    };
    const resultJson = encodeClaimOperationResult(result);
    const effectSummaryJson = canonicalJsonEncode(
        resultEffects.map((effect) => ({
            changeKind: effect.changeKind,
            effectKey: effect.effectKey,
            generation: effect.generation,
            projectId: effect.projectId,
            revisionLocator: effect.revisionLocator,
        })),
    );
    const receiptId = insertReceipt(db, envelope, {
        outcome: "applied",
        expectedEffectCount: staged.effects.length,
        effectSummaryJson,
        generationVectorJson: canonicalJsonEncode(generations),
        resultJson,
        nowMs,
    });
    const insertEffect = db.prepare(
        `INSERT INTO claim_operation_effects
            (receipt_id, effect_key, project_id, claim_id, revision_id, change_kind, generation, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const effect of staged.effects) {
        insertEffect.run(
            receiptId,
            effect.effectKey,
            effect.projectId,
            effect.claimId,
            effect.revisionId,
            effect.changeKind,
            generationByProject.get(effect.projectId)?.generation as number,
            nowMs,
        );
    }

    // Postconditions: declared effect count and the committed generation
    // vector must agree with the stored rows (KTD5 phase-two verification).
    const storedCount = (
        db
            .prepare("SELECT COUNT(*) AS count FROM claim_operation_effects WHERE receipt_id = ?")
            .get(receiptId) as { count: number }
    ).count;
    if (storedCount !== staged.effects.length) {
        throw new Error(
            `claim operation stored ${storedCount} effects but declared ${staged.effects.length}`,
        );
    }
    for (const [projectId, allocation] of generationByProject) {
        const committed = (
            db
                .prepare("SELECT generation FROM claim_project_generations WHERE project_id = ?")
                .get(projectId) as { generation: number } | undefined
        )?.generation;
        if (committed !== allocation.generation) {
            throw new Error(
                `claim operation generation vector mismatch for project ${projectId}: allocated ${allocation.generation}, committed ${String(committed)}`,
            );
        }
    }

    return { outcome: "applied", replayed: false, resultJson, result };
}

/** Standalone runner: one immediate transaction around the two phases. */
export function runClaimOperation(
    db: Database,
    envelope: ClaimOperationEnvelope,
    stage: (db: Database) => ClaimOperationStageOutcome,
    nowMs?: number,
): ClaimOperationRunResult {
    return db
        .transaction(() => runClaimOperationInCurrentTransaction(db, envelope, stage, nowMs))
        .immediate();
}

// ---------------------------------------------------------------------------
// Evidence provenance (KTD7): producers describe, the kernel writes.
// ---------------------------------------------------------------------------

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

function writeEvidenceChain(
    db: Database,
    projectId: number,
    provenance: ClaimEvidenceProvenance,
    extractedText: string,
): number {
    const episodeId = createEpisode(db, {
        projectId,
        sourceSessionId: provenance.sourceSessionId ?? null,
    });
    const spanId = createSourceSpan(db, {
        episodeId,
        sourceLocator: provenance.sourceLocator,
        content: provenance.sourceContent,
        startOffset: 0,
        endOffset: Math.max(1, provenance.sourceContent.length),
    });
    return createObservation(db, {
        sourceSpanId: spanId,
        extractedText,
        extractor: provenance.extractor,
        extractorVersion: provenance.extractorVersion,
        extractorRunId: provenance.extractorRunId,
        independenceKey: provenance.independenceKey,
        ...(provenance.sourceTrustClass === undefined
            ? {}
            : { sourceTrustClass: provenance.sourceTrustClass }),
    });
}

function provenanceRequestShape(provenance: ClaimEvidenceProvenance): CanonicalJsonValue {
    return {
        extractor: provenance.extractor,
        extractorRunId: provenance.extractorRunId,
        extractorVersion: provenance.extractorVersion,
        independenceKey: provenance.independenceKey,
        sourceContentDigest: sha256Utf8Hex(provenance.sourceContent),
        sourceLocator: provenance.sourceLocator,
        sourceSessionId: provenance.sourceSessionId ?? null,
        sourceTrustClass: provenance.sourceTrustClass ?? null,
    };
}

function tokenRequestShape(token: ClaimMutationToken): CanonicalJsonValue {
    return {
        applicabilityHeadsDigest: token.applicabilityHeadsDigest,
        contentDigest: token.contentDigest,
        lifecycleSeq: token.lifecycleSeq,
        policyHeadsDigest: token.policyHeadsDigest,
        publicClaimId: token.publicClaimId,
        revision: token.revision,
        tokenVersion: token.tokenVersion,
    };
}

// ---------------------------------------------------------------------------
// Project-memory domain rows shared by the typed operations
// ---------------------------------------------------------------------------

export interface ProjectMemoryAttributes {
    category: string;
    importance: number;
    memoryScope: MemoryScope;
    sharing: ClaimMemorySharing;
    expiresAt: number | null;
}

const DEFAULT_ATTRIBUTES: Omit<ProjectMemoryAttributes, "category"> = {
    importance: 50,
    memoryScope: "project",
    sharing: "private",
    expiresAt: null,
};

interface AttributesRow extends ProjectMemoryAttributes {
    revisionId: number;
    normalizedHash: string;
}

function readRevisionAttributes(db: Database, revisionId: number): AttributesRow | null {
    const row = db
        .prepare(
            `SELECT revision_id AS revisionId, category, normalized_hash AS normalizedHash,
                    importance, memory_scope AS memoryScope, sharing, expires_at AS expiresAt
               FROM claim_memory_revision_attributes WHERE revision_id = ?`,
        )
        .get(revisionId) as AttributesRow | undefined;
    return row ?? null;
}

function insertAttributesRow(
    db: Database,
    args: {
        revisionId: number;
        claimId: number;
        projectId: number;
        attributes: ProjectMemoryAttributes;
        normalizedHash: string;
        nowMs: number;
    },
): void {
    db.prepare(
        `INSERT INTO claim_memory_revision_attributes
            (revision_id, claim_id, project_id, category, normalized_hash, importance,
             memory_scope, sharing, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        args.revisionId,
        args.claimId,
        args.projectId,
        args.attributes.category,
        args.normalizedHash,
        args.attributes.importance,
        args.attributes.memoryScope,
        args.attributes.sharing,
        args.attributes.expiresAt,
        args.nowMs,
    );
}

function appendLifecycleEvent(
    db: Database,
    args: {
        claimId: number;
        state: ClaimMemoryLifecycleState;
        actor: string;
        reason?: string | null;
        nowMs: number;
    },
): void {
    const head = lifecycleHead(db, args.claimId);
    db.prepare(
        `INSERT INTO claim_memory_lifecycle_events
            (claim_id, seq, predecessor_id, state, actor, reason, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        args.claimId,
        (head?.seq ?? 0) + 1,
        head?.eventId ?? null,
        args.state,
        args.actor,
        args.reason ?? null,
        args.nowMs,
    );
    // claims.state stays a coarse mirror of the ledger head for v82 readers.
    db.prepare("UPDATE claims SET state = ? WHERE id = ?").run(
        args.state === "active" ? "active" : "archived",
        args.claimId,
    );
}

/**
 * `exemptClaimIds` names every claim this operation itself is about to move off
 * the (project, category, hash) coordinate, so its own participants can never
 * read as the pre-existing owner. A revise or restore exempts one claim; a
 * merge exempts the target AND its sources, because the sources are still
 * `active` at check time and only retire later in the same transaction —
 * without the exemption, merged content that keeps a source's wording (the
 * common outcome) collides with that source and rejects a legitimate merge.
 */
function assertNoLiveDuplicate(
    db: Database,
    args: {
        projectId: number;
        category: string;
        normalizedHash: string;
        exemptClaimIds: readonly number[];
    },
): void {
    const exempt = [...new Set(args.exemptClaimIds)];
    // An empty exemption list must not emit `NOT IN ()`, which SQLite rejects
    // as a syntax error rather than matching every row.
    const exemptClause =
        exempt.length === 0 ? "" : ` AND claim_id NOT IN (${exempt.map(() => "?").join(", ")})`;
    const duplicate = db
        .prepare(
            `SELECT claim_id AS claimId FROM claim_memory_current_heads
              WHERE project_id = ? AND category = ? AND normalized_hash = ?
                AND lifecycle_state = 'active'${exemptClause}`,
        )
        .get(args.projectId, args.category, args.normalizedHash, ...exempt) as
        | { claimId: number }
        | undefined;
    if (duplicate) {
        throw new ClaimOperationInputError(
            `a live project-memory claim (${duplicate.claimId}) already owns (project ${args.projectId}, ${args.category}, ${args.normalizedHash})`,
        );
    }
}

function upsertCurrentHead(
    db: Database,
    args: {
        claimId: number;
        projectId: number;
        category: string;
        normalizedHash: string;
        revisionId: number;
        lifecycleState: ClaimMemoryLifecycleState;
        nowMs: number;
    },
): void {
    db.prepare(
        `INSERT INTO claim_memory_current_heads
            (claim_id, project_id, category, normalized_hash, revision_id, lifecycle_state, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(claim_id) DO UPDATE SET
            category = excluded.category,
            normalized_hash = excluded.normalized_hash,
            revision_id = excluded.revision_id,
            lifecycle_state = excluded.lifecycle_state,
            updated_at = excluded.updated_at`,
    ).run(
        args.claimId,
        args.projectId,
        args.category,
        args.normalizedHash,
        args.revisionId,
        args.lifecycleState,
        args.nowMs,
    );
}

/** Rebuild the current-head dedup projection from authoritative rows (KTD4). */
export function rebuildClaimMemoryCurrentHeads(db: Database, nowMs: number = Date.now()): void {
    db.transaction(() => {
        db.prepare("DELETE FROM claim_memory_current_heads").run();
        db.prepare(
            `INSERT INTO claim_memory_current_heads
                (claim_id, project_id, category, normalized_hash, revision_id, lifecycle_state, updated_at)
             SELECT claims.id, claims.project_id, attrs.category, attrs.normalized_hash,
                    claims.current_revision_id, heads.state, ?
               FROM claims
               JOIN claim_public_ids ON claim_public_ids.claim_id = claims.id
               JOIN claim_memory_revision_attributes attrs
                 ON attrs.revision_id = claims.current_revision_id
               JOIN claim_memory_lifecycle_heads heads ON heads.claim_id = claims.id`,
        ).run(nowMs);
    }).immediate();
}

function claimPayloadLocator(claim: {
    publicClaimId: string;
    revision: number;
    contentDigest: string;
}): CanonicalJsonValue {
    return {
        contentDigest: claim.contentDigest,
        publicClaimId: claim.publicClaimId,
        revision: claim.revision,
        revisionLocator: formatRevisionLocator(claim),
    };
}

function attachEvidenceStage(
    db: Database,
    claim: ProjectMemoryClaimRef,
    provenance: ClaimEvidenceProvenance,
    nowMs: number,
): ClaimOperationStageOutcome {
    const observationId = writeEvidenceChain(db, claim.projectId, provenance, claim.content);
    db.prepare(
        "INSERT INTO claim_evidence (revision_id, observation_id, relation, created_at) VALUES (?, ?, 'supports', ?)",
    ).run(claim.currentRevisionId, observationId, nowMs);
    return {
        kind: "effects",
        payload: { claim: claimPayloadLocator(claim), kind: "evidence_attached" },
        effects: [
            {
                // The observation identifies the attachment. One receipt can
                // hold several attachments to the SAME claim and revision — an
                // autonomous manifest whose entries normalize onto one live
                // (project, category, hash) slot creates the claim once and
                // attaches the rest, and an unchanged revise attaches too. A
                // key of claim plus revision alone repeats across them, and
                // `claim_operation_effects` enforces UNIQUE (receipt_id,
                // effect_key) with an append-only trigger, so the second
                // attachment would abort the whole manifest — including the
                // unrelated entries in it — and every deterministic retry the
                // same way.
                effectKey: `evidence:${claim.publicClaimId}:r${claim.revision}:o${observationId}`,
                projectId: claim.projectId,
                claimId: claim.claimId,
                revisionId: claim.currentRevisionId,
                changeKind: "evidence",
            },
        ],
        policyRevisionIds: [claim.currentRevisionId],
        mutationTokenPublicClaimIds: [claim.publicClaimId],
    };
}

// ---------------------------------------------------------------------------
// Typed operations (R1, R7): create / revise
// ---------------------------------------------------------------------------

export interface CreateProjectMemoryClaimInput {
    projectId: number;
    content: string;
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
}

export interface ProducerIdentity {
    producer: string;
    operationKey: string;
}

function resolveAttributes(input: {
    category: string;
    importance?: number;
    memoryScope?: MemoryScope;
    sharing?: ClaimMemorySharing;
    expiresAt?: number | null;
}): ProjectMemoryAttributes {
    return {
        category: input.category,
        importance: input.importance ?? DEFAULT_ATTRIBUTES.importance,
        memoryScope: input.memoryScope ?? DEFAULT_ATTRIBUTES.memoryScope,
        sharing: input.sharing ?? DEFAULT_ATTRIBUTES.sharing,
        expiresAt: input.expiresAt ?? DEFAULT_ATTRIBUTES.expiresAt,
    };
}

function attributesRequestShape(attributes: ProjectMemoryAttributes): CanonicalJsonValue {
    return {
        category: attributes.category,
        expiresAt: attributes.expiresAt,
        importance: attributes.importance,
        memoryScope: attributes.memoryScope,
        sharing: attributes.sharing,
    };
}

function createPolicySubjectForRevision(
    db: Database,
    args: {
        revisionId: number;
        projectId: number;
        originObservationId: number | null;
        provenance: ClaimEvidenceProvenance | null;
        userInferred: boolean;
        nowMs: number;
    },
): void {
    const originTaint =
        args.provenance === null
            ? "ASSISTANT_INFERENCE"
            : classifyFineTaint({
                  sourceTrustClass: args.provenance.sourceTrustClass ?? "model_inference",
                  extractor: args.provenance.extractor,
                  userInferred: args.userInferred,
              });
    createPolicySubjectInCurrentTransaction(db, {
        revisionId: args.revisionId,
        projectId: args.projectId,
        claimKind: "unknown",
        originObservationId: args.originObservationId,
        originTaint,
        classificationMethod: TAINT_CLASSIFIER_METHOD,
        nowMs: args.nowMs,
    });
}

/** Transaction-local domain stage for composition inside one outer claim operation. */
export function stageCreateProjectMemoryClaimInCurrentTransaction(
    db: Database,
    input: CreateProjectMemoryClaimInput,
    nowMs: number,
): ClaimOperationStageOutcome {
    const attributes = resolveAttributes(input);
    const normalizedHash = computeNormalizedHash(input.content);
    const holder = db
        .prepare(
            `SELECT public_id AS publicClaimId FROM claim_memory_current_heads
               JOIN claim_public_ids USING (claim_id)
              WHERE project_id = ? AND category = ? AND normalized_hash = ?
                AND lifecycle_state = 'active'`,
        )
        .get(input.projectId, attributes.category, normalizedHash) as
        | { publicClaimId: string }
        | undefined;
    if (holder) {
        const claim = getProjectMemoryClaimByPublicId(db, holder.publicClaimId);
        if (!claim) {
            throw new ClaimGraphCorruptionError(
                `current-head row points at unknown claim ${holder.publicClaimId}`,
            );
        }
        return attachEvidenceStage(db, claim, input.provenance, nowMs);
    }

    const publicClaimId = generatePublicClaimId();
    const observationId = writeEvidenceChain(db, input.projectId, input.provenance, input.content);
    const created = createClaimInCurrentTransaction(db, {
        projectId: input.projectId,
        subject: publicClaimId,
        predicate: PROJECT_MEMORY_CLAIM_PREDICATE,
        scope: PROJECT_MEMORY_CLAIM_SCOPE,
        content: input.content,
        evidence: [{ observationId }],
        sourceSessionId: input.provenance.sourceSessionId ?? null,
    });
    if (created.status !== "applied") {
        throw new ClaimOperationInputError(
            `project-memory claim creation failed: ${created.status === "invalid" ? created.reason : created.status}`,
        );
    }
    db.prepare(
        "INSERT INTO claim_public_ids (claim_id, public_id, created_at) VALUES (?, ?, ?)",
    ).run(created.claimId, publicClaimId, nowMs);
    insertAttributesRow(db, {
        revisionId: created.revisionId,
        claimId: created.claimId,
        projectId: input.projectId,
        attributes,
        normalizedHash,
        nowMs,
    });
    appendLifecycleEvent(db, {
        claimId: created.claimId,
        state: "active",
        actor: input.actor,
        nowMs,
    });
    upsertCurrentHead(db, {
        claimId: created.claimId,
        projectId: input.projectId,
        category: attributes.category,
        normalizedHash,
        revisionId: created.revisionId,
        lifecycleState: "active",
        nowMs,
    });
    db.prepare("INSERT INTO claim_usage_stats (claim_id, updated_at) VALUES (?, ?)").run(
        created.claimId,
        nowMs,
    );
    createPolicySubjectForRevision(db, {
        revisionId: created.revisionId,
        projectId: input.projectId,
        originObservationId: observationId,
        provenance: input.provenance,
        userInferred: input.userInferred ?? false,
        nowMs,
    });
    const locator = {
        publicClaimId,
        revision: 1,
        contentDigest: sha256Utf8Hex(input.content),
    };
    return {
        kind: "effects",
        payload: { claim: claimPayloadLocator(locator), kind: "created" },
        effects: [
            {
                effectKey: `upsert:${publicClaimId}:r1`,
                projectId: input.projectId,
                claimId: created.claimId,
                revisionId: created.revisionId,
                changeKind: "upsert",
            },
        ],
        policyRevisionIds: [created.revisionId],
        mutationTokenPublicClaimIds: [publicClaimId],
    };
}

/**
 * Create a project-memory claim, or — when a live claim already owns the
 * (project, category, normalized hash) slot — attach the independent
 * provenance as evidence to its current revision (R7).
 */
export function createProjectMemoryClaim(
    db: Database,
    producer: ProducerIdentity,
    input: CreateProjectMemoryClaimInput,
): ClaimOperationRunResult {
    const attributes = resolveAttributes(input);
    const envelope: ClaimOperationEnvelope = {
        ...producer,
        requestDigest: computeClaimOperationRequestDigest({
            actor: input.actor,
            attributes: attributesRequestShape(attributes),
            content: input.content,
            operation: "create-project-memory-claim",
            projectId: input.projectId,
            provenance: provenanceRequestShape(input.provenance),
            requestScope: input.requestScope ?? null,
            userInferred: input.userInferred ?? false,
        }),
    };
    const nowMs = input.nowMs ?? Date.now();
    return runClaimOperation(
        db,
        envelope,
        () => stageCreateProjectMemoryClaimInCurrentTransaction(db, input, nowMs),
        nowMs,
    );
}

export interface ReviseProjectMemoryClaimInput {
    token: ClaimMutationToken;
    content?: string;
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
}

/** Transaction-local domain stage for composition inside one outer claim operation. */
export function stageReviseProjectMemoryClaimInCurrentTransaction(
    db: Database,
    input: ReviseProjectMemoryClaimInput,
    nowMs: number,
): ClaimOperationStageOutcome {
    const validation = validateProjectMemoryMutationToken(db, input.token);
    if (!validation.ok) {
        return {
            kind: "stale",
            reason: `${validation.stalePart}: ${validation.reason}`,
        };
    }
    const claim = validation.claim;
    const current = readRevisionAttributes(db, claim.currentRevisionId);
    if (!current) {
        throw new ClaimGraphCorruptionError(
            `claim revision ${claim.currentRevisionId} has no attributes row; direct-SQL corruption`,
        );
    }
    const nextContent = input.content ?? claim.content;
    const nextAttributes: ProjectMemoryAttributes = {
        category: input.category ?? current.category,
        importance: input.importance ?? current.importance,
        memoryScope: input.memoryScope ?? current.memoryScope,
        sharing: input.sharing ?? current.sharing,
        expiresAt: input.expiresAt === undefined ? current.expiresAt : input.expiresAt,
    };
    const contentUnchanged = sha256Utf8Hex(nextContent) === claim.contentDigest;
    const unchanged =
        contentUnchanged &&
        nextAttributes.category === current.category &&
        nextAttributes.importance === current.importance &&
        nextAttributes.memoryScope === current.memoryScope &&
        nextAttributes.sharing === current.sharing &&
        nextAttributes.expiresAt === current.expiresAt;
    if (unchanged) {
        return attachEvidenceStage(db, claim, input.provenance, nowMs);
    }
    const normalizedHash = computeNormalizedHash(nextContent);
    assertNoLiveDuplicate(db, {
        projectId: claim.projectId,
        category: nextAttributes.category,
        normalizedHash,
        exemptClaimIds: [claim.claimId],
    });
    const observationId = writeEvidenceChain(db, claim.projectId, input.provenance, nextContent);
    // A metadata-only revision re-states the current revision's exact bytes, so
    // every observation supporting those bytes still supports them. Dropping
    // them would rebuild this revision's trust from the reviser's provenance
    // alone — `hasExplicitUserEvidence` and `countIndependentEvidenceGroups`
    // both read `supports` rows per revision — so an importance/scope/sharing
    // change would reclassify a user-asserted memory down to the reviser's own
    // maturity and drop it out of the automatic surfaces. A content-changing
    // revision carries nothing: those observations attest to bytes this
    // revision replaced. Relations are named rather than copied wholesale so a
    // future non-supporting relation (a refutation, say) is never re-asserted
    // as support here, the same discipline the merge path applies to lineage.
    // Carrying a stamp forward cannot by itself manufacture trust:
    // `hasExplicitUserEvidence` independently requires a non-first revision to
    // still hold the claim's first-revision bytes, so model-authored content
    // never inherits explicit-user standing through this path.
    const carriedObservationIds = contentUnchanged
        ? (
              db
                  .prepare(
                      `SELECT observation_id AS observationId FROM claim_evidence
                        WHERE revision_id = ? AND relation = 'supports'
                        ORDER BY observation_id`,
                  )
                  .all(claim.currentRevisionId) as Array<{ observationId: number }>
          ).map((row) => row.observationId)
        : [];
    const appended = appendClaimRevisionInCurrentTransaction(db, {
        claimId: claim.claimId,
        expectedCurrentRevisionId: claim.currentRevisionId,
        content: nextContent,
        evidence: [...new Set([observationId, ...carriedObservationIds])].map((carried) => ({
            observationId: carried,
            relation: "supports" as const,
        })),
        sourceSessionId: input.provenance.sourceSessionId ?? null,
    });
    if (appended.status !== "applied") {
        throw new ClaimOperationInputError(
            `project-memory revision append failed: ${appended.status === "invalid" ? appended.reason : appended.status}`,
        );
    }
    insertAttributesRow(db, {
        revisionId: appended.revisionId,
        claimId: claim.claimId,
        projectId: claim.projectId,
        attributes: nextAttributes,
        normalizedHash,
        nowMs,
    });
    upsertCurrentHead(db, {
        claimId: claim.claimId,
        projectId: claim.projectId,
        category: nextAttributes.category,
        normalizedHash,
        revisionId: appended.revisionId,
        lifecycleState: lifecycleHead(db, claim.claimId)?.state ?? "active",
        nowMs,
    });
    createPolicySubjectForRevision(db, {
        revisionId: appended.revisionId,
        projectId: claim.projectId,
        originObservationId: observationId,
        provenance: input.provenance,
        userInferred: input.userInferred ?? false,
        nowMs,
    });
    const locator = {
        publicClaimId: claim.publicClaimId,
        revision: appended.revision,
        contentDigest: sha256Utf8Hex(nextContent),
    };
    return {
        kind: "effects",
        payload: { claim: claimPayloadLocator(locator), kind: "revised" },
        effects: [
            {
                effectKey: `upsert:${claim.publicClaimId}:r${appended.revision}`,
                projectId: claim.projectId,
                claimId: claim.claimId,
                revisionId: appended.revisionId,
                changeKind: "upsert",
            },
        ],
        policyRevisionIds: [appended.revisionId],
        mutationTokenPublicClaimIds: [claim.publicClaimId],
    };
}

/**
 * Append a revision carrying changed content and/or revision-bound
 * attributes. Identical content and attributes with independent provenance
 * attach evidence to the current revision instead (R7).
 */
export function reviseProjectMemoryClaim(
    db: Database,
    producer: ProducerIdentity,
    input: ReviseProjectMemoryClaimInput,
): ClaimOperationRunResult {
    const envelope: ClaimOperationEnvelope = {
        ...producer,
        requestDigest: computeClaimOperationRequestDigest({
            actor: input.actor,
            category: input.category ?? null,
            content: input.content ?? null,
            expiresAt: input.expiresAt === undefined ? "keep" : input.expiresAt,
            importance: input.importance ?? null,
            memoryScope: input.memoryScope ?? null,
            operation: "revise-project-memory-claim",
            provenance: provenanceRequestShape(input.provenance),
            requestScope: input.requestScope ?? null,
            sharing: input.sharing ?? null,
            token: tokenRequestShape(input.token),
            userInferred: input.userInferred ?? false,
        }),
    };
    const nowMs = input.nowMs ?? Date.now();
    return runClaimOperation(
        db,
        envelope,
        () => stageReviseProjectMemoryClaimInCurrentTransaction(db, input, nowMs),
        nowMs,
    );
}

// ---------------------------------------------------------------------------
// Lifecycle (KTD4) and same-project merge (R8)
// ---------------------------------------------------------------------------

export interface SetProjectMemoryLifecycleInput {
    token: ClaimMutationToken;
    state: ClaimMemoryLifecycleState;
    actor: string;
    reason?: string | null;
    requestScope?: string;
    nowMs?: number;
}

/** Transaction-local domain stage for composition inside one outer claim operation. */
export function stageSetProjectMemoryClaimLifecycleInCurrentTransaction(
    db: Database,
    input: SetProjectMemoryLifecycleInput,
    nowMs: number,
): ClaimOperationStageOutcome {
    const validation = validateProjectMemoryMutationToken(db, input.token);
    if (!validation.ok) {
        return { kind: "stale", reason: `${validation.stalePart}: ${validation.reason}` };
    }
    const claim = validation.claim;
    const head = lifecycleHead(db, claim.claimId);
    if (!head) {
        throw new ClaimGraphCorruptionError(
            `project-memory claim ${claim.publicClaimId} has no lifecycle ledger`,
        );
    }
    if (head.state === input.state) {
        return {
            kind: "noop",
            payload: {
                claim: claimPayloadLocator(claim),
                kind: "lifecycle",
                state: head.state,
            },
            mutationTokenPublicClaimIds: [claim.publicClaimId],
        };
    }
    const attributes = readRevisionAttributes(db, claim.currentRevisionId);
    if (!attributes) {
        throw new ClaimGraphCorruptionError(
            `claim revision ${claim.currentRevisionId} has no attributes row; direct-SQL corruption`,
        );
    }
    if (input.state === "active") {
        assertNoLiveDuplicate(db, {
            projectId: claim.projectId,
            category: attributes.category,
            normalizedHash: attributes.normalizedHash,
            exemptClaimIds: [claim.claimId],
        });
    }
    appendLifecycleEvent(db, {
        claimId: claim.claimId,
        state: input.state,
        actor: input.actor,
        reason: input.reason ?? null,
        nowMs,
    });
    upsertCurrentHead(db, {
        claimId: claim.claimId,
        projectId: claim.projectId,
        category: attributes.category,
        normalizedHash: attributes.normalizedHash,
        revisionId: claim.currentRevisionId,
        lifecycleState: input.state,
        nowMs,
    });
    return {
        kind: "effects",
        payload: {
            claim: claimPayloadLocator(claim),
            kind: "lifecycle",
            state: input.state,
        },
        effects: [
            {
                effectKey: `lifecycle:${claim.publicClaimId}:${input.state}`,
                projectId: claim.projectId,
                claimId: claim.claimId,
                revisionId: claim.currentRevisionId,
                changeKind: "lifecycle",
            },
        ],
        mutationTokenPublicClaimIds: [claim.publicClaimId],
    };
}

/** Append one lifecycle event; the revision identity is untouched. Setting
 * the state the head already holds stores a zero-effect no-op receipt. */
export function setProjectMemoryClaimLifecycle(
    db: Database,
    producer: ProducerIdentity,
    input: SetProjectMemoryLifecycleInput,
): ClaimOperationRunResult {
    const envelope: ClaimOperationEnvelope = {
        ...producer,
        requestDigest: computeClaimOperationRequestDigest({
            actor: input.actor,
            operation: "set-project-memory-lifecycle",
            reason: input.reason ?? null,
            requestScope: input.requestScope ?? null,
            state: input.state,
            token: tokenRequestShape(input.token),
        }),
    };
    const nowMs = input.nowMs ?? Date.now();
    return runClaimOperation(
        db,
        envelope,
        () => stageSetProjectMemoryClaimLifecycleInCurrentTransaction(db, input, nowMs),
        nowMs,
    );
}

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
export function stageMergeProjectMemoryClaimsInCurrentTransaction(
    db: Database,
    input: MergeProjectMemoryClaimsInput,
    nowMs: number,
): ClaimOperationStageOutcome {
    // Every claim-local token validates before the first effect.
    const targetValidation = validateProjectMemoryMutationToken(db, input.targetToken);
    if (!targetValidation.ok) {
        return {
            kind: "stale",
            reason: `target ${targetValidation.stalePart}: ${targetValidation.reason}`,
        };
    }
    const target = targetValidation.claim;
    const sources: ProjectMemoryClaimRef[] = [];
    for (const token of input.sourceTokens) {
        const validation = validateProjectMemoryMutationToken(db, token);
        if (!validation.ok) {
            return {
                kind: "stale",
                reason: `source ${token.publicClaimId} ${validation.stalePart}: ${validation.reason}`,
            };
        }
        if (validation.claim.claimId === target.claimId) {
            throw new ClaimOperationInputError("merge target cannot be its own source");
        }
        if (validation.claim.projectId !== target.projectId) {
            throw new ClaimOperationInputError(
                "cross-project merge is refused; use derivation copy/move instead",
            );
        }
        sources.push(validation.claim);
    }

    const mergedContent = input.mergedContent ?? target.content;
    const targetAttributes = readRevisionAttributes(db, target.currentRevisionId);
    if (!targetAttributes) {
        throw new ClaimGraphCorruptionError(
            `claim revision ${target.currentRevisionId} has no attributes row; direct-SQL corruption`,
        );
    }
    const normalizedHash = computeNormalizedHash(mergedContent);
    assertNoLiveDuplicate(db, {
        projectId: target.projectId,
        category: targetAttributes.category,
        normalizedHash,
        exemptClaimIds: [target.claimId, ...sources.map((source) => source.claimId)],
    });

    // Both evidence relations carry lineage, so both flow into the merged
    // revision: `supports` covers create/revise/split-produced sources, and
    // `merged_from` covers a source that is itself merge-produced and so holds
    // no `supports` row of its own. Naming the relations rather than reading
    // every row keeps a future non-lineage relation (a refutation, say) from
    // being silently re-asserted here as merge support; a source carrying only
    // such a relation instead trips the zero-evidence guard below.
    const sourceObservations = sources.flatMap((source) =>
        (
            db
                .prepare(
                    `SELECT observation_id AS observationId FROM claim_evidence
                      WHERE revision_id = ? AND relation IN ('supports', 'merged_from')
                      ORDER BY observation_id`,
                )
                .all(source.currentRevisionId) as Array<{ observationId: number }>
        ).map((row) => row.observationId),
    );
    if (sourceObservations.length === 0) {
        throw new ClaimGraphCorruptionError(
            "merge sources carry no supporting evidence; direct-SQL corruption",
        );
    }
    const appended = appendClaimRevisionInCurrentTransaction(db, {
        claimId: target.claimId,
        expectedCurrentRevisionId: target.currentRevisionId,
        content: mergedContent,
        evidence: [...new Set(sourceObservations)].map((observationId) => ({
            observationId,
            relation: "merged_from" as const,
        })),
    });
    if (appended.status !== "applied") {
        throw new ClaimOperationInputError(
            `merge target revision append failed: ${appended.status === "invalid" ? appended.reason : appended.status}`,
        );
    }
    insertAttributesRow(db, {
        revisionId: appended.revisionId,
        claimId: target.claimId,
        projectId: target.projectId,
        attributes: { ...targetAttributes, category: targetAttributes.category },
        normalizedHash,
        nowMs,
    });
    createPolicySubjectForRevision(db, {
        revisionId: appended.revisionId,
        projectId: target.projectId,
        originObservationId: null,
        provenance: null,
        userInferred: false,
        nowMs,
    });

    const effects: ClaimEffectDescriptor[] = [
        {
            effectKey: `upsert:${target.publicClaimId}:r${appended.revision}`,
            projectId: target.projectId,
            claimId: target.claimId,
            revisionId: appended.revisionId,
            changeKind: "upsert",
        },
    ];
    const policyRevisionIds = [appended.revisionId];
    for (const source of sources) {
        addClaimConflictInCurrentTransaction(db, {
            relation: "supersedes",
            leftRevisionId: appended.revisionId,
            rightRevisionId: source.currentRevisionId,
        });
        const sourceAttributes = readRevisionAttributes(db, source.currentRevisionId);
        if (!sourceAttributes) {
            throw new ClaimGraphCorruptionError(
                `claim revision ${source.currentRevisionId} has no attributes row; direct-SQL corruption`,
            );
        }
        appendLifecycleEvent(db, {
            claimId: source.claimId,
            state: "retired",
            actor: input.actor,
            reason: `merged into ${target.publicClaimId}`,
            nowMs,
        });
        upsertCurrentHead(db, {
            claimId: source.claimId,
            projectId: source.projectId,
            category: sourceAttributes.category,
            normalizedHash: sourceAttributes.normalizedHash,
            revisionId: source.currentRevisionId,
            lifecycleState: "retired",
            nowMs,
        });
        effects.push({
            effectKey: `lifecycle:${source.publicClaimId}:retired`,
            projectId: source.projectId,
            claimId: source.claimId,
            revisionId: source.currentRevisionId,
            changeKind: "lifecycle",
        });
        policyRevisionIds.push(source.currentRevisionId);
    }
    // The target head lands only after every source head is `retired`. The
    // dedup index over (project, category, normalized_hash) is partial on
    // `lifecycle_state = 'active'`, so merged content that keeps a source's
    // wording still collides with that source's live head until it vacates the
    // coordinate. Retiring first makes the ordering carry the same guarantee
    // the exemption in `assertNoLiveDuplicate` states.
    upsertCurrentHead(db, {
        claimId: target.claimId,
        projectId: target.projectId,
        category: targetAttributes.category,
        normalizedHash,
        revisionId: appended.revisionId,
        lifecycleState: lifecycleHead(db, target.claimId)?.state ?? "active",
        nowMs,
    });
    const locator = {
        publicClaimId: target.publicClaimId,
        revision: appended.revision,
        contentDigest: sha256Utf8Hex(mergedContent),
    };
    return {
        kind: "effects",
        payload: {
            claim: claimPayloadLocator(locator),
            kind: "merged",
            retiredSources: sources.map((source) => source.publicClaimId),
        },
        effects,
        policyRevisionIds,
        mutationTokenPublicClaimIds: [
            target.publicClaimId,
            ...sources.map((source) => source.publicClaimId),
        ],
    };
}

/**
 * Same-project merge (R8): appends one target revision whose evidence links
 * every observation the sources carry as `merged_from` — including the ones a
 * merge-produced source itself carries as `merged_from`, so lineage survives
 * repeated merges — records supersedes conflicts, and retires the sources.
 * Trust and approval never transfer — the new target revision opens its own
 * conservative policy subject.
 */
export function mergeProjectMemoryClaims(
    db: Database,
    producer: ProducerIdentity,
    input: MergeProjectMemoryClaimsInput,
): ClaimOperationRunResult {
    if (input.sourceTokens.length === 0) {
        throw new ClaimOperationInputError("merge requires at least one source claim");
    }
    const envelope: ClaimOperationEnvelope = {
        ...producer,
        requestDigest: computeClaimOperationRequestDigest({
            actor: input.actor,
            mergedContent: input.mergedContent ?? null,
            operation: "merge-project-memory-claims",
            requestScope: input.requestScope ?? null,
            sourceTokens: input.sourceTokens.map(tokenRequestShape),
            targetToken: tokenRequestShape(input.targetToken),
        }),
    };
    const nowMs = input.nowMs ?? Date.now();
    return runClaimOperation(
        db,
        envelope,
        () => stageMergeProjectMemoryClaimsInCurrentTransaction(db, input, nowMs),
        nowMs,
    );
}

// ---------------------------------------------------------------------------
// Applicability mapping and verification (KTD7 step 6, U9 consumers)
// ---------------------------------------------------------------------------

export interface ApplyProjectMemoryMappingInput {
    token: ClaimMutationToken;
    /** Exact revision the mapping was computed against. */
    revisionLocator: string;
    paths: ApplicabilityPathsInput;
    knownFrom?: number;
    nowMs?: number;
}

/** Transaction-local domain stage for composition inside one outer claim operation. */
export function stageApplyProjectMemoryMappingInCurrentTransaction(
    db: Database,
    input: ApplyProjectMemoryMappingInput,
    nowMs: number,
): ClaimOperationStageOutcome {
    const validation = validateProjectMemoryMutationToken(db, input.token);
    if (!validation.ok) {
        return { kind: "stale", reason: `${validation.stalePart}: ${validation.reason}` };
    }
    const claim = validation.claim;
    const expectedLocator = formatRevisionLocator(claim);
    if (input.revisionLocator !== expectedLocator) {
        return {
            kind: "stale",
            reason: `revision: mapping targets ${input.revisionLocator} but current is ${expectedLocator}`,
        };
    }
    const sync = syncRevisionApplicabilityPathsInCurrentTransaction(db, {
        revisionId: claim.currentRevisionId,
        projectId: claim.projectId,
        streamKey: APPLICABILITY_BASELINE_STREAM_KEY,
        keyProtocol: APPLICABILITY_STREAM_KEY_PROTOCOL,
        sourceDigest: claim.contentDigest,
        paths: input.paths,
        knownFrom: input.knownFrom ?? nowMs,
    });
    if (!sync.appended) {
        return {
            kind: "noop",
            payload: { claim: claimPayloadLocator(claim), kind: "mapping" },
        };
    }
    return {
        kind: "effects",
        payload: { claim: claimPayloadLocator(claim), kind: "mapping" },
        effects: [
            {
                effectKey: `applicability:${claim.publicClaimId}:r${claim.revision}`,
                projectId: claim.projectId,
                claimId: claim.claimId,
                revisionId: claim.currentRevisionId,
                changeKind: "applicability",
            },
        ],
    };
}

/** Append path knowledge onto the exact current revision's baseline
 * applicability stream. A mapping equal to the stream head is a no-op. */
export function applyProjectMemoryMapping(
    db: Database,
    producer: ProducerIdentity,
    input: ApplyProjectMemoryMappingInput,
): ClaimOperationRunResult {
    const envelope: ClaimOperationEnvelope = {
        ...producer,
        requestDigest: computeClaimOperationRequestDigest({
            operation: "apply-project-memory-mapping",
            paths:
                input.paths.state === "known"
                    ? {
                          exact: [...(input.paths.exact ?? [])].sort(),
                          glob: [...(input.paths.glob ?? [])].sort(),
                          state: "known",
                      }
                    : { state: "unknown" },
            revisionLocator: input.revisionLocator,
            token: tokenRequestShape(input.token),
        }),
    };
    const nowMs = input.nowMs ?? Date.now();
    return runClaimOperation(
        db,
        envelope,
        () => stageApplyProjectMemoryMappingInCurrentTransaction(db, input, nowMs),
        nowMs,
    );
}

export interface RecordProjectMemoryVerificationInput {
    token: ClaimMutationToken;
    revisionLocator: string;
    outcome: "verified" | "update" | "archive" | "stale" | "flagged";
    verifier: string;
    nowMs?: number;
}

/** Transaction-local domain stage for composition inside one outer claim operation. */
export function stageRecordProjectMemoryVerificationInCurrentTransaction(
    db: Database,
    input: RecordProjectMemoryVerificationInput,
    nowMs: number,
): ClaimOperationStageOutcome {
    const validation = validateProjectMemoryMutationToken(db, input.token);
    if (!validation.ok) {
        return { kind: "stale", reason: `${validation.stalePart}: ${validation.reason}` };
    }
    const claim = validation.claim;
    const expectedLocator = formatRevisionLocator(claim);
    if (input.revisionLocator !== expectedLocator) {
        return {
            kind: "stale",
            reason: `revision: verification targets ${input.revisionLocator} but current is ${expectedLocator}`,
        };
    }
    db.prepare(
        `INSERT INTO verification_events (revision_id, observation_id, outcome, verifier, created_at)
         VALUES (?, NULL, ?, ?, ?)`,
    ).run(claim.currentRevisionId, input.outcome, input.verifier, nowMs);
    return {
        kind: "effects",
        payload: {
            claim: claimPayloadLocator(claim),
            kind: "verification",
            outcome: input.outcome,
        },
        effects: [
            {
                effectKey: `verification:${claim.publicClaimId}:r${claim.revision}:${input.outcome}`,
                projectId: claim.projectId,
                claimId: claim.claimId,
                revisionId: claim.currentRevisionId,
                changeKind: "verification",
            },
        ],
        policyRevisionIds: [claim.currentRevisionId],
    };
}

/** Append one verification event against the exact current revision and
 * finalize its policy under the same operation (KTD7 step 6). */
export function recordProjectMemoryVerification(
    db: Database,
    producer: ProducerIdentity,
    input: RecordProjectMemoryVerificationInput,
): ClaimOperationRunResult {
    const envelope: ClaimOperationEnvelope = {
        ...producer,
        requestDigest: computeClaimOperationRequestDigest({
            operation: "record-project-memory-verification",
            outcome: input.outcome,
            revisionLocator: input.revisionLocator,
            token: tokenRequestShape(input.token),
            verifier: input.verifier,
        }),
    };
    const nowMs = input.nowMs ?? Date.now();
    return runClaimOperation(
        db,
        envelope,
        () => stageRecordProjectMemoryVerificationInCurrentTransaction(db, input, nowMs),
        nowMs,
    );
}

// ---------------------------------------------------------------------------
// Nonsemantic telemetry (R3): mutable counters, no receipts.
// ---------------------------------------------------------------------------

export function recordClaimUsage(
    db: Database,
    args: {
        publicClaimIds: readonly string[];
        kind: "seen" | "retrieved";
        nowMs?: number;
    },
): void {
    const nowMs = args.nowMs ?? Date.now();
    const column = args.kind === "seen" ? "seen_count" : "retrieval_count";
    const stamp = args.kind === "seen" ? "last_seen_at" : "last_retrieved_at";
    // Column names come from the fixed ternaries above, never caller input.
    // pi-lens-ignore: sql-injection
    const update = db.prepare(
        `UPDATE claim_usage_stats
            SET ${column} = ${column} + 1, ${stamp} = ?, updated_at = ?
          WHERE claim_id = (SELECT claim_id FROM claim_public_ids WHERE public_id = ?)`,
    );
    db.transaction(() => {
        for (const publicClaimId of args.publicClaimIds) {
            update.run(nowMs, nowMs, publicClaimId);
        }
    }).immediate();
}

// ---------------------------------------------------------------------------
// Consumer checkpoints and outbox pruning (KTD13, R20)
// ---------------------------------------------------------------------------

export function readOutboxConsumerCheckpoint(
    db: Database,
    consumer: string,
    projectId: number,
): number {
    const row = db
        .prepare(
            `SELECT acked_effect_id AS acked FROM claim_outbox_consumer_checkpoints
              WHERE consumer = ? AND project_id = ?`,
        )
        .get(consumer, projectId) as { acked: number } | undefined;
    return row?.acked ?? 0;
}

/**
 * Advance one consumer/project cursor. Regression is rejected, the cursor may
 * not run past the current outbox tail, and the acknowledged id must not split a
 * receipt group within the project: a page cannot expose half an operation
 * (KTD13).
 */
export function advanceOutboxConsumerCheckpointInCurrentTransaction(
    db: Database,
    args: { consumer: string; projectId: number; ackedEffectId: number; nowMs?: number },
): void {
    if (!Number.isSafeInteger(args.ackedEffectId) || args.ackedEffectId < 0) {
        throw new Error(`invalid outbox checkpoint: ${String(args.ackedEffectId)}`);
    }
    const existing = readOutboxConsumerCheckpoint(db, args.consumer, args.projectId);
    if (args.ackedEffectId < existing) {
        throw new Error(
            `outbox checkpoint for ${args.consumer}/${args.projectId} cannot regress (${existing} -> ${args.ackedEffectId})`,
        );
    }
    // A cursor past the tail claims to have observed effects that do not exist.
    // Nothing else catches it: the receipt-split query below finds no `pending`
    // row beyond such an id, so it passes. Left unchecked, once every required
    // consumer holds a future cursor the prune boundary becomes that future id,
    // and effects allocated below it afterwards are deleted having never been
    // published to anyone.
    //
    // The tail falls back to the existing cursor rather than zero so a
    // re-acknowledgement stays idempotent after pruning empties the table — the
    // acknowledged effects are gone precisely because they were consumed.
    const tailRow = db.prepare("SELECT MAX(id) AS tail FROM claim_operation_effects").get() as {
        tail: number | null;
    };
    const tail = tailRow.tail ?? existing;
    if (args.ackedEffectId > tail) {
        throw new Error(
            `outbox checkpoint ${args.ackedEffectId} for ${args.consumer}/${args.projectId} is beyond the outbox tail (${tail})`,
        );
    }
    const split = db
        .prepare(
            `SELECT 1 FROM claim_operation_effects consumed
               JOIN claim_operation_effects pending ON pending.receipt_id = consumed.receipt_id
              WHERE consumed.project_id = ?1 AND consumed.id <= ?2
                AND pending.project_id = ?1 AND pending.id > ?2
              LIMIT 1`,
        )
        .get(args.projectId, args.ackedEffectId);
    if (split) {
        throw new Error(
            `outbox checkpoint ${args.ackedEffectId} splits a receipt group for project ${args.projectId}`,
        );
    }
    db.prepare(
        `INSERT INTO claim_outbox_consumer_checkpoints (consumer, project_id, acked_effect_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(consumer, project_id) DO UPDATE SET
            acked_effect_id = excluded.acked_effect_id,
            updated_at = excluded.updated_at`,
    ).run(args.consumer, args.projectId, args.ackedEffectId, args.nowMs ?? Date.now());
}

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
export function pruneClaimOperationEffectsInCurrentTransaction(
    db: Database,
    requiredConsumers: readonly string[],
): ClaimOutboxPruneResult {
    if (!isInTransaction(db)) {
        throw new Error(
            "pruneClaimOperationEffectsInCurrentTransaction requires the caller's open write transaction",
        );
    }
    if (requiredConsumers.length === 0) {
        throw new Error("outbox pruning requires at least one required consumer");
    }
    let boundary = Number.MAX_SAFE_INTEGER;
    for (const consumer of requiredConsumers) {
        const row = db
            .prepare(
                `SELECT MIN(COALESCE(checkpoint.acked_effect_id, 0)) AS acked
                   FROM (SELECT DISTINCT project_id FROM claim_operation_effects) project
                   LEFT JOIN claim_outbox_consumer_checkpoints checkpoint
                     ON checkpoint.consumer = ?
                    AND checkpoint.project_id = project.project_id`,
            )
            .get(consumer) as { acked: number | null };
        boundary = Math.min(boundary, row.acked ?? 0);
    }
    if (boundary <= 0) return { boundary: 0, prunedEffectRows: 0 };
    db.prepare(
        `INSERT INTO claim_outbox_prune_state (id, enabled, consumed_watermark)
         VALUES (1, 1, ?)
         ON CONFLICT(id) DO UPDATE SET
            enabled = 1,
            consumed_watermark = MAX(consumed_watermark, excluded.consumed_watermark)`,
    ).run(boundary);
    try {
        const prunable = `
            SELECT id FROM claim_operation_effects
             WHERE id <= ?1
               AND NOT EXISTS (
                   SELECT 1 FROM claim_operation_effects pending
                    WHERE pending.receipt_id = claim_operation_effects.receipt_id
                      AND pending.id > ?1
               )`;
        const prunedEffectRows = (
            db.prepare(`SELECT COUNT(*) AS count FROM (${prunable})`).get(boundary) as {
                count: number;
            }
        ).count;
        db.prepare(`DELETE FROM claim_operation_effects WHERE id IN (${prunable})`).run(boundary);
        return { boundary, prunedEffectRows };
    } finally {
        db.prepare("UPDATE claim_outbox_prune_state SET enabled = 0 WHERE id = 1").run();
    }
}
