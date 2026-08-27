import type { Database } from "../../../shared/sqlite";
import type { ClaimMutationToken } from "./claim-operation-contract";
import {
    computeClaimOperationRequestDigest,
    formatRevisionLocator,
} from "./claim-operation-contract";
import { ANTI_MEMORY_CATEGORY } from "./constants";
import {
    type ClaimEvidenceProvenance,
    ClaimOperationInputError,
    type ClaimOperationRunResult,
    type ProducerIdentity,
    runClaimOperation,
    stageCreateProjectMemoryClaimInCurrentTransaction,
    stageReviseProjectMemoryClaimInCurrentTransaction,
} from "./storage-claim-operations";
import { ClaimGraphCorruptionError, sha256Utf8Hex } from "./storage-claims";

export const ANTI_MEMORY_DEFAULT_TTL_MS = 90 * 24 * 60 * 60 * 1_000;

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

function requiredText(value: unknown, field: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new ClaimOperationInputError(`anti-memory ${field} must be non-empty`);
    }
    return value.trim();
}

function optionalText(value: unknown, field: string): string | null {
    if (value === undefined || value === null) return null;
    return requiredText(value, field);
}

function normalizePayload(payload: AntiMemoryPayload): StoredAntiMemoryPayload {
    return {
        trigger: requiredText(payload.trigger, "trigger"),
        rejectedStrategy: requiredText(payload.rejectedStrategy, "rejectedStrategy"),
        rejectionReason: requiredText(payload.rejectionReason, "rejectionReason"),
        saferAlternative: optionalText(payload.saferAlternative, "saferAlternative"),
        preconditions: optionalText(payload.preconditions, "preconditions"),
        attemptedApproach: optionalText(payload.attemptedApproach, "attemptedApproach"),
        observedFailure: optionalText(payload.observedFailure, "observedFailure"),
        rootCause: optionalText(payload.rootCause, "rootCause"),
        recovery: optionalText(payload.recovery, "recovery"),
        nonApplicableWhen: optionalText(payload.nonApplicableWhen, "nonApplicableWhen"),
    };
}

export function renderAntiMemoryContent(payload: AntiMemoryPayload): string {
    const stored = normalizePayload(payload);
    const lines = [
        `Trigger: ${stored.trigger}`,
        `Rejected strategy: ${stored.rejectedStrategy}`,
        `Rejection reason: ${stored.rejectionReason}`,
    ];
    const optional: Array<[string, string | null]> = [
        ["Safer alternative", stored.saferAlternative],
        ["Preconditions", stored.preconditions],
        ["Attempted approach", stored.attemptedApproach],
        ["Observed failure", stored.observedFailure],
        ["Root cause", stored.rootCause],
        ["Recovery", stored.recovery],
        ["Non-applicable when", stored.nonApplicableWhen],
    ];
    for (const [label, value] of optional) {
        if (value !== null) lines.push(`${label}: ${value}`);
    }
    return lines.join("\n");
}

function antiMemoryDedupText(payload: StoredAntiMemoryPayload): string {
    return JSON.stringify([payload.trigger, payload.rejectedStrategy]);
}

function provenanceDigestShape(provenance: ClaimEvidenceProvenance) {
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

function payloadDigestShape(payload: StoredAntiMemoryPayload) {
    return { ...payload };
}

function insertPayload(
    db: Database,
    revisionId: number,
    claimId: number,
    payload: StoredAntiMemoryPayload,
    nowMs: number,
): void {
    db.prepare(
        `INSERT INTO claim_anti_memory_revision_payloads
            (revision_id, claim_id, trigger, rejected_strategy, rejection_reason,
             safer_alternative, preconditions, attempted_approach, observed_failure,
             root_cause, recovery, non_applicable_when, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        revisionId,
        claimId,
        payload.trigger,
        payload.rejectedStrategy,
        payload.rejectionReason,
        payload.saferAlternative,
        payload.preconditions,
        payload.attemptedApproach,
        payload.observedFailure,
        payload.rootCause,
        payload.recovery,
        payload.nonApplicableWhen,
        nowMs,
    );
}

export function createAntiMemory(
    db: Database,
    producer: ProducerIdentity,
    input: CreateAntiMemoryInput,
): ClaimOperationRunResult {
    const payload = normalizePayload(input.payload);
    const content = renderAntiMemoryContent(payload);
    const dedupText = antiMemoryDedupText(payload);
    const nowMs = input.nowMs ?? Date.now();
    return runClaimOperation(
        db,
        {
            ...producer,
            requestDigest: computeClaimOperationRequestDigest({
                actor: input.actor,
                operation: "create-anti-memory",
                payload: payloadDigestShape(payload),
                projectId: input.projectId,
                provenance: provenanceDigestShape(input.provenance),
                requestScope: input.requestScope ?? null,
            }),
        },
        () => {
            const staged = stageCreateProjectMemoryClaimInCurrentTransaction(
                db,
                {
                    projectId: input.projectId,
                    content,
                    dedupText,
                    category: ANTI_MEMORY_CATEGORY,
                    importance: input.importance,
                    memoryScope: "project",
                    sharing: "private",
                    expiresAt: nowMs + ANTI_MEMORY_DEFAULT_TTL_MS,
                    provenance: input.provenance,
                    actor: input.actor,
                    requestScope: input.requestScope,
                    nowMs,
                },
                nowMs,
            );
            if (staged.kind === "effects") {
                const created = staged.effects.find((effect) => effect.changeKind === "upsert");
                if (created?.revisionId != null) {
                    insertPayload(db, created.revisionId, created.claimId, payload, nowMs);
                }
            }
            return staged;
        },
        nowMs,
    );
}

export function createAgentAntiMemory(
    db: Database,
    producer: ProducerIdentity,
    input: Omit<CreateAntiMemoryInput, "provenance"> & {
        provenance: Omit<ClaimEvidenceProvenance, "sourceTrustClass">;
    },
): ClaimOperationRunResult {
    return createAntiMemory(db, producer, {
        ...input,
        provenance: { ...input.provenance, sourceTrustClass: "model_inference" },
    });
}

function reviseWithPayload(
    db: Database,
    producer: ProducerIdentity,
    args: {
        input: Omit<ReviseAntiMemoryInput, "payload">;
        payload: StoredAntiMemoryPayload;
        expiresAt?: number;
        operation: "revise-anti-memory" | "extend-anti-memory-ttl";
    },
): ClaimOperationRunResult {
    const content = renderAntiMemoryContent(args.payload);
    const dedupText = antiMemoryDedupText(args.payload);
    const nowMs = args.input.nowMs ?? Date.now();
    return runClaimOperation(
        db,
        {
            ...producer,
            requestDigest: computeClaimOperationRequestDigest({
                actor: args.input.actor,
                expiresAt: args.expiresAt ?? null,
                operation: args.operation,
                payload: payloadDigestShape(args.payload),
                provenance: provenanceDigestShape(args.input.provenance),
                requestScope: args.input.requestScope ?? null,
                token: args.input.token,
            }),
        },
        () => {
            const staged = stageReviseProjectMemoryClaimInCurrentTransaction(
                db,
                {
                    token: args.input.token,
                    content,
                    dedupText,
                    ...(args.expiresAt === undefined ? {} : { expiresAt: args.expiresAt }),
                    provenance: args.input.provenance,
                    actor: args.input.actor,
                    requestScope: args.input.requestScope,
                    nowMs,
                },
                nowMs,
            );
            if (staged.kind === "effects") {
                const revised = staged.effects.find((effect) => effect.changeKind === "upsert");
                if (revised?.revisionId != null) {
                    insertPayload(db, revised.revisionId, revised.claimId, args.payload, nowMs);
                }
            }
            return staged;
        },
        nowMs,
    );
}

export function reviseAntiMemory(
    db: Database,
    producer: ProducerIdentity,
    input: ReviseAntiMemoryInput,
): ClaimOperationRunResult {
    const current = readAntiMemory(db, input.token.publicClaimId);
    if (current === null) throw new ClaimOperationInputError("unknown anti-memory claim");
    return reviseWithPayload(db, producer, {
        input,
        payload: normalizePayload(input.payload),
        operation: "revise-anti-memory",
    });
}

export function extendAntiMemoryTtl(
    db: Database,
    producer: ProducerIdentity,
    input: ExtendAntiMemoryTtlInput,
): ClaimOperationRunResult {
    if (!Number.isSafeInteger(input.expiresAt)) {
        throw new ClaimOperationInputError("anti-memory expiry must be a safe integer");
    }
    const current = readAntiMemory(db, input.token.publicClaimId);
    if (current === null) throw new ClaimOperationInputError("unknown anti-memory claim");
    if (current.expiresAt === null || input.expiresAt <= current.expiresAt) {
        throw new ClaimOperationInputError("anti-memory TTL extension must move expiry forward");
    }
    return reviseWithPayload(db, producer, {
        input,
        payload: current.payload,
        expiresAt: input.expiresAt,
        operation: "extend-anti-memory-ttl",
    });
}

export function readAntiMemory(db: Database, publicClaimId: string): AntiMemoryRecord | null {
    const row = db
        .prepare(
            `SELECT revisions.revision, revisions.content, revisions.content_sha256 AS contentDigest,
                    attrs.category, attrs.normalized_hash AS normalizedHash,
                    attrs.importance, attrs.memory_scope AS memoryScope, attrs.sharing,
                    attrs.expires_at AS expiresAt,
                    payload.trigger, payload.rejected_strategy AS rejectedStrategy,
                    payload.rejection_reason AS rejectionReason,
                    payload.safer_alternative AS saferAlternative,
                    payload.preconditions, payload.attempted_approach AS attemptedApproach,
                    payload.observed_failure AS observedFailure,
                    payload.root_cause AS rootCause, payload.recovery,
                    payload.non_applicable_when AS nonApplicableWhen
               FROM claim_public_ids public
               JOIN claims ON claims.id = public.claim_id
               JOIN claim_revisions revisions ON revisions.id = claims.current_revision_id
               JOIN claim_memory_revision_attributes attrs ON attrs.revision_id = revisions.id
               LEFT JOIN claim_anti_memory_revision_payloads payload ON payload.revision_id = revisions.id
              WHERE public.public_id = ?`,
        )
        .get(publicClaimId) as
        | (Omit<AntiMemoryRecord, "publicClaimId" | "revisionLocator" | "payload"> &
              StoredAntiMemoryPayload & { trigger: string | null })
        | undefined;
    if (!row || row.category !== ANTI_MEMORY_CATEGORY) return null;
    if (row.trigger === null) {
        throw new ClaimGraphCorruptionError(
            `anti-memory ${publicClaimId} current revision has no payload row`,
        );
    }
    const payload: StoredAntiMemoryPayload = {
        trigger: row.trigger,
        rejectedStrategy: row.rejectedStrategy,
        rejectionReason: row.rejectionReason,
        saferAlternative: row.saferAlternative,
        preconditions: row.preconditions,
        attemptedApproach: row.attemptedApproach,
        observedFailure: row.observedFailure,
        rootCause: row.rootCause,
        recovery: row.recovery,
        nonApplicableWhen: row.nonApplicableWhen,
    };
    return {
        publicClaimId,
        revisionLocator: formatRevisionLocator({
            publicClaimId,
            revision: row.revision,
            contentDigest: row.contentDigest,
        }),
        revision: row.revision,
        content: row.content,
        contentDigest: row.contentDigest,
        category: ANTI_MEMORY_CATEGORY,
        normalizedHash: row.normalizedHash,
        importance: row.importance,
        memoryScope: "project",
        sharing: "private",
        expiresAt: row.expiresAt,
        payload,
    };
}
