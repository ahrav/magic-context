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
     * When `expiresAt` is absent, expiry starts at the write clock.
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

function requiredText(value: unknown, field: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new ClaimOperationInputError(`anti-memory ${field} must be non-empty`);
    }
    return value.replace(/\s+/g, " ").trim();
}

function optionalText(value: unknown, field: string): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value === "string" && value.trim().length === 0) return null;
    return requiredText(value, field);
}

/**
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

export function parseAntiMemoryContent(content: string): AntiMemoryPayload {
    const fields = new Map<string, string>();
    for (const line of content.split(/\r?\n/)) {
        if (line.trim().length === 0) continue;
        const separator = line.indexOf(":");
        if (separator <= 0) throw new ClaimOperationInputError("invalid anti-memory content line");
        const label = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim();
        if (fields.has(label)) throw new ClaimOperationInputError(`duplicate anti-memory ${label}`);
        fields.set(label, value);
    }
    const known = new Set([
        "Trigger",
        "Rejected strategy",
        "Rejection reason",
        "Safer alternative",
        "Preconditions",
        "Attempted approach",
        "Observed failure",
        "Root cause",
        "Recovery",
        "Non-applicable when",
    ]);
    for (const label of fields.keys()) {
        if (!known.has(label))
            throw new ClaimOperationInputError(`unknown anti-memory field ${label}`);
    }
    return normalizeAntiMemoryPayload({
        trigger: requiredText(fields.get("Trigger"), "trigger"),
        rejectedStrategy: requiredText(fields.get("Rejected strategy"), "rejectedStrategy"),
        rejectionReason: requiredText(fields.get("Rejection reason"), "rejectionReason"),
        saferAlternative: fields.get("Safer alternative"),
        preconditions: fields.get("Preconditions"),
        attemptedApproach: fields.get("Attempted approach"),
        observedFailure: fields.get("Observed failure"),
        rootCause: fields.get("Root cause"),
        recovery: fields.get("Recovery"),
        nonApplicableWhen: fields.get("Non-applicable when"),
    });
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
                //
                // The digest uses requested `expiresAt`, not the resolved expiry.
                // The digest represents omitted expiry as null because the resolved default varies with `nowMs`.
                // The digest represents omitted expiry as null because the resolved default varies with `nowMs`.
                // The digest represents omitted expiry as null because the resolved default varies with `nowMs`.
                // The digest represents omitted expiry as null because the resolved default varies with `nowMs`.
                expiresAt: input.expiresAt ?? null,
                // The digest includes resolved importance because reuse with different persisted importance must raise `ClaimOperationKeyReuseError`.
                // The digest includes resolved importance because reuse with different persisted importance must raise `ClaimOperationKeyReuseError`.
                // The digest includes resolved importance because reuse with different persisted importance must raise `ClaimOperationKeyReuseError`.
                // The digest includes resolved importance because reuse with different persisted importance must raise `ClaimOperationKeyReuseError`.
                // The digest includes resolved importance because reuse with different persisted importance must raise `ClaimOperationKeyReuseError`.
                // The digest uses resolved importance so omitted importance and an explicit default represent the same request.
                // The digest uses resolved importance so omitted importance and an explicit default represent the same request.
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
         * `resolvePayload` alone reads and compares current state so receipt lookup can short-circuit replays.
         * `resolvePayload` alone reads and compares current state so receipt lookup can short-circuit replays.
         * A replayed TTL extension may already have the requested stored expiry.
         * The claim may change or be deleted between the first attempt and a replay.
         */
        resolvePayload: () => StoredAntiMemoryPayload;
        /**
         * The digest uses the caller-requested payload rather than payload read from the current revision.
         * The digest uses the caller-requested payload rather than payload read from the current revision.
         * The digest uses the caller-requested payload rather than payload read from the current revision.
         * The digest uses the caller-requested payload rather than payload read from the current revision.
         * The digest uses the caller-requested payload rather than payload read from the current revision.
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

/**
 * The staging helper runs inside a transaction the caller already owns.
 */
function stageAntiMemoryRevisionInCurrentTransaction(
    db: Database,
    input: Omit<ReviseAntiMemoryInput, "payload">,
    payload: StoredAntiMemoryPayload,
    expiresAt: number | undefined,
    nowMs: number,
): ClaimOperationStageOutcome {
    const staged = stageReviseProjectMemoryClaimInCurrentTransaction(
        db,
        {
            token: input.token,
            content: renderAntiMemoryContent(payload),
            dedupText: antiMemoryDedupText(payload),
            ...(expiresAt === undefined ? {} : { expiresAt }),
            provenance: input.provenance,
            actor: input.actor,
            requestScope: input.requestScope,
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
}

/**
 */
export { stageAntiMemoryVerificationInCurrentTransaction } from "./storage-claim-operations";

export function stageReviseAntiMemoryInCurrentTransaction(
    db: Database,
    input: ReviseAntiMemoryInput,
    nowMs: number,
): ClaimOperationStageOutcome {
    if (readAntiMemory(db, input.token.publicClaimId) === null) {
        throw new ClaimOperationInputError("unknown anti-memory claim");
    }
    return stageAntiMemoryRevisionInCurrentTransaction(
        db,
        input,
        normalizeAntiMemoryPayload(input.payload),
        undefined,
        nowMs,
    );
}

export function stageExtendAntiMemoryTtlInCurrentTransaction(
    db: Database,
    input: ExtendAntiMemoryTtlInput,
    nowMs: number,
): ClaimOperationStageOutcome {
    if (!Number.isSafeInteger(input.expiresAt)) {
        throw new ClaimOperationInputError("anti-memory expiry must be a safe integer");
    }
    const current = readAntiMemory(db, input.token.publicClaimId);
    if (current === null) throw new ClaimOperationInputError("unknown anti-memory claim");
    if (current.expiresAt === null || input.expiresAt <= current.expiresAt) {
        throw new ClaimOperationInputError("anti-memory TTL extension must move expiry forward");
    }
    return stageAntiMemoryRevisionInCurrentTransaction(
        db,
        input,
        current.payload,
        input.expiresAt,
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
        // Staging prevents replay from re-reading the payload or rechecking expiry progress.
        resolvePayload: () => {
            const current = readAntiMemory(db, input.token.publicClaimId);
            if (current === null) throw new ClaimOperationInputError("unknown anti-memory claim");
            // A concurrent extension can set an expiry later than this request's snapshot.
            // The stage returns a zero-effect `stale` outcome when a concurrent extension sets a later expiry.
            // Throwing before staging would classify a concurrent later-expiry extension as invalid input and omit its receipt.
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

const ANTI_MEMORY_ROW_COLUMNS = `claims.id AS claimId, public.public_id AS publicClaimId,
                    revisions.revision, revisions.content, revisions.content_sha256 AS contentDigest,
                    attrs.category, attrs.normalized_hash AS normalizedHash,
                    attrs.importance, attrs.memory_scope AS memoryScope, attrs.sharing,
                    attrs.expires_at AS expiresAt,
                    payload.trigger, payload.rejected_strategy AS rejectedStrategy,
                    payload.rejection_reason AS rejectionReason,
                    payload.safer_alternative AS saferAlternative,
                    payload.preconditions, payload.attempted_approach AS attemptedApproach,
                    payload.observed_failure AS observedFailure,
                    payload.root_cause AS rootCause, payload.recovery,
                    payload.non_applicable_when AS nonApplicableWhen`;

const ANTI_MEMORY_ROW_JOINS = `FROM claim_public_ids public
               JOIN claims ON claims.id = public.claim_id
               JOIN claim_revisions revisions ON revisions.id = claims.current_revision_id
               JOIN claim_memory_revision_attributes attrs ON attrs.revision_id = revisions.id
               LEFT JOIN claim_anti_memory_revision_payloads payload ON payload.revision_id = revisions.id`;

type AntiMemoryRow = Omit<
    AntiMemoryRecord,
    "publicClaimId" | "revisionLocator" | "payload" | "memoryScope" | "sharing"
> &
    StoredAntiMemoryPayload & {
        publicClaimId: string;
        trigger: string | null;
        memoryScope: string;
        sharing: string;
    };

/** Payload fields are returned exactly as stored; normalize only on writes.
 * Do not normalize reads: returned payload fields must match stored values.
 *  normalization scheme. */
function antiMemoryRecordFromRow(row: AntiMemoryRow): AntiMemoryRecord {
    if (row.trigger === null) {
        throw new ClaimGraphCorruptionError(
            `anti-memory ${row.publicClaimId} current revision has no payload row`,
        );
    }
    // Reject rows whose scope or sharing violates the project-private invariant.
    // hardcoded values.
    if (row.memoryScope !== "project" || row.sharing !== "private") {
        throw new ClaimGraphCorruptionError(
            `anti-memory ${row.publicClaimId} must be project-private but stores ` +
                `scope=${row.memoryScope} sharing=${row.sharing}`,
        );
    }
    return {
        claimId: row.claimId,
        publicClaimId: row.publicClaimId,
        revisionLocator: formatRevisionLocator({
            publicClaimId: row.publicClaimId,
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
        payload: {
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
        },
    };
}

export function readAntiMemory(db: Database, publicClaimId: string): AntiMemoryRecord | null {
    const row = db
        .prepare(
            // The interpolation uses fixed column and join fragments, not caller input.
            // pi-lens-ignore: sql-injection
            `SELECT ${ANTI_MEMORY_ROW_COLUMNS}
               ${ANTI_MEMORY_ROW_JOINS}
              WHERE public.public_id = ?`,
        )
        .get(publicClaimId) as AntiMemoryRow | undefined;
    if (!row || row.category !== ANTI_MEMORY_CATEGORY) return null;
    return antiMemoryRecordFromRow(row);
}

/**
 * The search lane reads all candidate payloads in one query instead of calling `readAntiMemory` for each record. */
export function readAntiMemories(
    db: Database,
    publicClaimIds: readonly string[],
): Map<string, AntiMemoryRecord> {
    const records = new Map<string, AntiMemoryRecord>();
    if (publicClaimIds.length === 0) return records;
    const rows = db
        .prepare(
            // Interpolation generates only `?` placeholders; values are bound through `.all(...publicClaimIds)`.
            // pi-lens-ignore: sql-injection
            `SELECT ${ANTI_MEMORY_ROW_COLUMNS}
               ${ANTI_MEMORY_ROW_JOINS}
              WHERE public.public_id IN (${publicClaimIds.map(() => "?").join(", ")})`,
        )
        .all(...publicClaimIds) as AntiMemoryRow[];
    for (const row of rows) {
        if (row.category !== ANTI_MEMORY_CATEGORY) continue;
        records.set(row.publicClaimId, antiMemoryRecordFromRow(row));
    }
    return records;
}

/**
 * */
export function listActiveAntiMemoryPublicIds(
    db: Database,
    projectIds: readonly number[],
    limit: number,
    nowMs: number,
): string[] {
    if (projectIds.length === 0 || limit <= 0) return [];
    const rows = db
        .prepare(
            // Interpolation generates only `?` placeholders; values are bound through `.all(...projectIds)`.
            // pi-lens-ignore: sql-injection
            `SELECT public.public_id AS publicId
               FROM claim_memory_current_heads heads
               JOIN claim_public_ids public ON public.claim_id = heads.claim_id
               JOIN claim_memory_revision_attributes attrs ON attrs.revision_id = heads.revision_id
              WHERE heads.project_id IN (${projectIds.map(() => "?").join(", ")})
                AND heads.category = ?
                AND heads.lifecycle_state = 'active'
                AND (attrs.expires_at IS NULL OR attrs.expires_at > ?)
              ORDER BY heads.claim_id DESC
              LIMIT ?`,
        )
        .all(...projectIds, ANTI_MEMORY_CATEGORY, nowMs, limit) as Array<{ publicId: string }>;
    return rows.map((row) => row.publicId);
}
