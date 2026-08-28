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
    type ClaimOperationStageOutcome,
    DEFAULT_MEMORY_IMPORTANCE,
    type ProducerIdentity,
    provenanceRequestShape,
    runClaimOperation,
    stageCreateProjectMemoryClaimInCurrentTransaction,
    stageReviseProjectMemoryClaimInCurrentTransaction,
    tokenRequestShape,
    validateProjectMemoryMutationToken,
} from "./storage-claim-operations";
import { ClaimGraphCorruptionError } from "./storage-claims";

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
    // The payload columns are `CHECK (col IS NULL OR length(trim(col)) > 0)`, so
    // an absent optional field has exactly one legal stored form: NULL. A
    // blank string is the same absence spelled differently — model-generated
    // payloads routinely emit `""` for a field they have nothing to say about —
    // and rejecting it would fail the whole write over a value the schema and
    // the renderer both treat as "not present".
    if (typeof value === "string" && value.trim().length === 0) return null;
    return requiredText(value, field);
}

/**
 * Trim and null-normalize a payload, rejecting empty required fields. Exported
 * so consumers that validate or fingerprint payload text can derive the field
 * set from the payload itself instead of hand-enumerating it (a hand-kept list
 * fails open when a field is added).
 */
export function normalizeAntiMemoryPayload(payload: AntiMemoryPayload): StoredAntiMemoryPayload {
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
    const stored = normalizeAntiMemoryPayload(payload);
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

export function stageCreateAntiMemoryInCurrentTransaction(
    db: Database,
    input: CreateAntiMemoryInput,
    nowMs: number,
): ClaimOperationStageOutcome {
    const payload = normalizeAntiMemoryPayload(input.payload);
    const staged = stageCreateProjectMemoryClaimInCurrentTransaction(
        db,
        {
            projectId: input.projectId,
            content: renderAntiMemoryContent(payload),
            dedupText: antiMemoryDedupText(payload),
            category: ANTI_MEMORY_CATEGORY,
            importance: input.importance,
            memoryScope: "project",
            sharing: "private",
            expiresAt: input.expiresAt ?? nowMs + ANTI_MEMORY_DEFAULT_TTL_MS,
            provenance: input.provenance,
            actor: input.actor,
            requestScope: input.requestScope,
            nowMs,
            // The staging boundary refuses anti-memory category writes that do
            // not come through this typed path, so every caller reaching the
            // generic stage from here must carry the writer assertion.
            antiMemoryWriter: true,
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
}

export function createAntiMemory(
    db: Database,
    producer: ProducerIdentity,
    input: CreateAntiMemoryInput,
): ClaimOperationRunResult {
    const payload = normalizeAntiMemoryPayload(input.payload);
    const nowMs = input.nowMs ?? Date.now();
    return runClaimOperation(
        db,
        {
            ...producer,
            requestDigest: computeClaimOperationRequestDigest({
                actor: input.actor,
                // Importance lands in the persisted revision attributes, so it
                // is part of the request: leaving it out lets a second call
                // that reuses the operation key with a different importance
                // replay the first receipt and silently drop the new value
                // instead of raising ClaimOperationKeyReuseError. Digest the
                // resolved value so an omitted importance and an explicit
                // default stay one request.
                importance: input.importance ?? DEFAULT_MEMORY_IMPORTANCE,
                operation: "create-anti-memory",
                payload: payloadDigestShape(payload),
                projectId: input.projectId,
                provenance: provenanceRequestShape(input.provenance),
                requestScope: input.requestScope ?? null,
            }),
        },
        () => stageCreateAntiMemoryInCurrentTransaction(db, { ...input, payload }, nowMs),
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
        /**
         * Produces the payload for the new revision. Runs inside the staged
         * callback, so only after the operation-key receipt lookup misses.
         * Every read of current state and every check against it belongs here:
         * a pre-transaction read or comparison would reject an honest replay
         * whose receipt should short-circuit instead — for a TTL extension the
         * stored expiry already equals the request's, and the claim may have
         * moved on or gone away entirely since the first attempt.
         */
        resolvePayload: () => StoredAntiMemoryPayload;
        /**
         * The payload as the caller *requested* it, or null for an operation
         * that supplies none. What gets stored can be state read back from the
         * current revision; folding that into the request digest would make an
         * idempotent retry diverge as soon as an unrelated revision changed
         * the payload in between, raising `ClaimOperationKeyReuseError`
         * instead of replaying the receipt. The digest describes the request,
         * never the row.
         */
        digestPayload: StoredAntiMemoryPayload | null;
        expiresAt?: number;
        operation: "revise-anti-memory" | "extend-anti-memory-ttl";
    },
): ClaimOperationRunResult {
    const nowMs = args.input.nowMs ?? Date.now();
    return runClaimOperation(
        db,
        {
            ...producer,
            requestDigest: computeClaimOperationRequestDigest({
                actor: args.input.actor,
                expiresAt: args.expiresAt ?? null,
                operation: args.operation,
                payload:
                    args.digestPayload === null ? null : payloadDigestShape(args.digestPayload),
                provenance: provenanceRequestShape(args.input.provenance),
                requestScope: args.input.requestScope ?? null,
                token: tokenRequestShape(args.input.token),
            }),
        },
        () => {
            const payload = args.resolvePayload();
            const staged = stageReviseProjectMemoryClaimInCurrentTransaction(
                db,
                {
                    token: args.input.token,
                    content: renderAntiMemoryContent(payload),
                    dedupText: antiMemoryDedupText(payload),
                    ...(args.expiresAt === undefined ? {} : { expiresAt: args.expiresAt }),
                    provenance: args.input.provenance,
                    actor: args.input.actor,
                    requestScope: args.input.requestScope,
                    nowMs,
                    antiMemoryWriter: true,
                },
                nowMs,
            );
            if (staged.kind === "effects") {
                const revised = staged.effects.find((effect) => effect.changeKind === "upsert");
                if (revised?.revisionId != null) {
                    insertPayload(db, revised.revisionId, revised.claimId, payload, nowMs);
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
    const payload = normalizeAntiMemoryPayload(input.payload);
    return reviseWithPayload(db, producer, {
        input,
        resolvePayload: () => {
            if (readAntiMemory(db, input.token.publicClaimId) === null) {
                throw new ClaimOperationInputError("unknown anti-memory claim");
            }
            return payload;
        },
        digestPayload: payload,
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
    return reviseWithPayload(db, producer, {
        input,
        // An extension carries no payload of its own: it re-states the current
        // one. Reading it here, inside the stage, keeps both the read and the
        // forward-progress check off the replay path.
        resolvePayload: () => {
            const current = readAntiMemory(db, input.token.publicClaimId);
            if (current === null) throw new ClaimOperationInputError("unknown anti-memory claim");
            // Judge forward progress only for a caller whose token is still
            // current. A superseded token means a concurrent extension already
            // won, and its expiry can legitimately sit beyond this request's —
            // forward progress from the caller's own snapshot. That race is the
            // contract's zero-effect `stale` outcome, which the stage below
            // produces; throwing here would relabel it a caller defect and
            // record no receipt at all.
            if (validateProjectMemoryMutationToken(db, input.token).ok) {
                if (current.expiresAt === null || input.expiresAt <= current.expiresAt) {
                    throw new ClaimOperationInputError(
                        "anti-memory TTL extension must move expiry forward",
                    );
                }
            }
            return current.payload;
        },
        digestPayload: null,
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
        | (Omit<
              AntiMemoryRecord,
              "publicClaimId" | "revisionLocator" | "payload" | "memoryScope" | "sharing"
          > &
              StoredAntiMemoryPayload & {
                  trigger: string | null;
                  memoryScope: string;
                  sharing: string;
              })
        | undefined;
    if (!row || row.category !== ANTI_MEMORY_CATEGORY) return null;
    if (row.trigger === null) {
        throw new ClaimGraphCorruptionError(
            `anti-memory ${publicClaimId} current revision has no payload row`,
        );
    }
    // Anti-memory is project-private by construction; a stored row that says
    // otherwise means some path mutated scope or sharing around the typed
    // writer. Fail closed instead of masking the violated invariant with
    // hardcoded values.
    if (row.memoryScope !== "project" || row.sharing !== "private") {
        throw new ClaimGraphCorruptionError(
            `anti-memory ${publicClaimId} must be project-private but stores ` +
                `scope=${row.memoryScope} sharing=${row.sharing}`,
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
        memoryScope: row.memoryScope,
        sharing: row.sharing,
        expiresAt: row.expiresAt,
        payload,
    };
}
