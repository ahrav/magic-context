/**
 * Transaction-local memory/claims kernel (KTD1, KTD3, KTD6-KTD8): every v84
 * semantic or lifecycle memory operation commits claim changes, the legacy
 * `memories` compatibility projection, operation envelope, claim-change
 * outbox rows, and one generation bump per touched project in the CALLER's
 * immediate transaction (R12-R13). Callers own transaction start/commit
 * through the adapters below; the kernel never issues BEGIN/COMMIT.
 *
 * Type-only, `node:`, and explicit-`.ts` sibling imports keep this module
 * loadable by the Node SQLite smoke script, whose loader cannot resolve
 * extensionless runtime imports.
 *
 * A row whose project identity cannot resolve to the numeric registry (a raw
 * pre-v22 path), whose content is empty, or whose schema-legal metadata is
 * claim-invalid (bad scope, importance, shareable, ...) cannot form a claim.
 * Those writes apply the projection under the capability and record a
 * blocking `claim_backfill_failures` row instead of silently inventing claim
 * state; the v22 takeover (U4) and doctor retry (U5) own the repair.
 */

import { type Database, hasClaimCompatibilityWriteState } from "../../../shared/sqlite.ts";
import { CLAIMS_BACKFILL_META_KEYS } from "../storage-memory-claims-schema.ts";
import {
    addClaimConflictInCurrentTransaction,
    addVerificationEvent,
    appendClaimRevisionInCurrentTransaction,
    ClaimGraphCorruptionError,
    type ClaimState,
    createClaimInCurrentTransaction,
    createEpisode,
    createObservation,
    createSourceSpan,
    ensureProjectInCurrentTransaction,
    resolveProjectId,
    sha256Utf8Hex,
    type VerificationOutcome,
} from "./storage-claims.ts";
import {
    deleteMemoryProjectionRow,
    insertMemoryProjectionRow,
    type MemoryProjectionInsert,
    type MemoryProjectionRow,
    readMemoryProjectionRow,
    replaceMemoryProjectionVerificationFiles,
    setMemoryProjectionSuperseded,
    updateMemoryProjectionClassification,
    updateMemoryProjectionContent,
    updateMemoryProjectionMerge,
    updateMemoryProjectionStatus,
    updateMemoryProjectionVerification,
} from "./storage-memory-projection.ts";
import type { MemoryStatus } from "./types.ts";

// ---------------------------------------------------------------------------
// Failpoint seams (Process-Crash Test Contract). No-op by default; U6
// activates them through this registry.
// ---------------------------------------------------------------------------

export const MEMORY_CLAIM_FAILPOINT_IDS = [
    "memory-claim.010.claim.after",
    "memory-claim.020.projection.after",
    "memory-claim.030.outbox.after",
    "memory-claim.040.generation.after",
    "memory-claim.050.commit.before",
    "memory-claim.060.commit.after",
    "memory-claim.070.ack.after",
] as const;

export type MemoryClaimFailpointId = (typeof MEMORY_CLAIM_FAILPOINT_IDS)[number];

const activeFailpoints = new Map<MemoryClaimFailpointId, () => void>();

export function setMemoryClaimFailpoint(
    id: MemoryClaimFailpointId,
    hook: (() => void) | null,
): void {
    if (hook) activeFailpoints.set(id, hook);
    else activeFailpoints.delete(id);
}

export function clearMemoryClaimFailpoints(): void {
    activeFailpoints.clear();
}

function hitMemoryClaimFailpoint(id: MemoryClaimFailpointId): void {
    activeFailpoints.get(id)?.();
}

export function acknowledgeMemoryClaimResult(): void {
    hitMemoryClaimFailpoint("memory-claim.070.ack.after");
}

// ---------------------------------------------------------------------------
// Schema probe, capability, and transaction adapters
// ---------------------------------------------------------------------------

/**
 * Whether this database migrated to v84. Delegates to the shared probe so
 * this module and the privileged-writer path in shared/sqlite.ts share one
 * positive-only cache: a negative probe is never cached, because a sibling
 * process can migrate the shared file after this handle opened.
 */
export function hasMemoryClaimsCompatSchema(db: Database): boolean {
    return hasClaimCompatibilityWriteState(db);
}

const capabilityDepth = new WeakMap<Database, number>();

interface MemoryClaimGenerationContext {
    generations: Map<number, { generation: number; existed: boolean }>;
}

const generationContexts = new WeakMap<Database, MemoryClaimGenerationContext>();

/**
 * Outer transaction shares one generation allocation per touched project.
 * Nested scopes restore allocation snapshots after errors so rolled-back
 * savepoints do not retain allocations.
 */
export function withMemoryClaimGenerationContextInCurrentTransaction<T>(
    db: Database,
    fn: () => T,
): T {
    const existing = generationContexts.get(db);
    if (existing) {
        const snapshot = new Map(existing.generations);
        try {
            return fn();
        } catch (error) {
            existing.generations = snapshot;
            throw error;
        }
    }

    const context: MemoryClaimGenerationContext = { generations: new Map() };
    generationContexts.set(db, context);
    try {
        return fn();
    } finally {
        generationContexts.delete(db);
    }
}

/**
 * Enable the claims-write capability for `fn` inside the CALLER's write
 * transaction. Only the outermost scope clears the flag, and it clears
 * BEFORE the caller commits, so no second connection can observe enabled=1
 * (Schema Contract: the capability is transaction-scoped).
 */
export function withClaimsWriteCapabilityInCurrentTransaction<T>(db: Database, fn: () => T): T {
    const depth = capabilityDepth.get(db) ?? 0;
    capabilityDepth.set(db, depth + 1);
    try {
        db.prepare(
            "INSERT INTO claim_compatibility_write_state (id, enabled) VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET enabled = 1",
        ).run();
        const result = fn();
        if (depth === 0) {
            db.prepare("UPDATE claim_compatibility_write_state SET enabled = 0 WHERE id = 1").run();
        }
        return result;
    } catch (error) {
        // The enclosing transaction normally reverts the flag on rollback,
        // but a caller that swallows this error and keeps its transaction
        // open must not retain the capability.
        if (depth === 0) {
            try {
                db.prepare(
                    "UPDATE claim_compatibility_write_state SET enabled = 0 WHERE id = 1",
                ).run();
            } catch {
                // The clear is best-effort: the original error wins.
            }
        }
        throw error;
    } finally {
        if (depth === 0) capabilityDepth.delete(db);
        else capabilityDepth.set(db, depth);
    }
}

/**
 * Caller adapter: one immediate transaction (a stacked savepoint when the
 * caller already holds one) with the claims-write capability enabled for its
 * duration and cleared before commit.
 */
export function runInMemoryClaimsWriteTransaction<T>(db: Database, fn: () => T): T {
    const outermost = (capabilityDepth.get(db) ?? 0) === 0;
    const result = db
        .transaction(() => {
            const value = withClaimsWriteCapabilityInCurrentTransaction(db, () =>
                withMemoryClaimGenerationContextInCurrentTransaction(db, fn),
            );
            if (outermost) hitMemoryClaimFailpoint("memory-claim.050.commit.before");
            return value;
        })
        .immediate();
    if (outermost) hitMemoryClaimFailpoint("memory-claim.060.commit.after");
    return result;
}

// ---------------------------------------------------------------------------
// Operation envelope, outbox, and generations (KTD7, R13)
// ---------------------------------------------------------------------------

export interface MemoryClaimOperationEnvelope {
    /** Producer namespace, e.g. "storage-memory" or "module-mirror". */
    producer: string;
    /** Durable key, unique within the producer namespace. */
    operationKey: string;
    /** Canonical request digest (SHA-256 hex over the canonical request). */
    requestDigest: string;
    /** Marks a random-key envelope no caller can ever present again. A
     *  zero-effect run of an ephemeral envelope persists nothing: its replay
     *  record would be unreachable, so storing it only grows
     *  claim_operations. */
    ephemeral?: true;
}

export type MemoryClaimEffectType = "upsert" | "lifecycle" | "evidence";

export interface MemoryClaimEffect {
    effectKey: string;
    projectId: number;
    claimId: number;
    effectType: MemoryClaimEffectType;
}

export interface MemoryClaimOperationOutcome<T> {
    result: T;
    /** True when the stored committed result was returned with zero new effects. */
    replayed: boolean;
}

export class ClaimOperationKeyReuseError extends Error {
    constructor(producer: string, operationKey: string) {
        super(
            `claim operation key ${producer}/${operationKey} was already committed for a different request digest`,
        );
        this.name = "ClaimOperationKeyReuseError";
    }
}

/** Canonical request digest helper for callers without a natural digest. */
export function computeClaimRequestDigest(request: unknown): string {
    return sha256Utf8Hex(JSON.stringify(request));
}

export function readMemoryClaimOperationResult<T>(
    db: Database,
    envelope: MemoryClaimOperationEnvelope,
): MemoryClaimOperationOutcome<T> | null {
    const existing = db
        .prepare(
            "SELECT request_digest AS requestDigest, result_json AS resultJson FROM claim_operations WHERE producer = ? AND operation_key = ?",
        )
        .get(envelope.producer, envelope.operationKey) as
        | { requestDigest: string; resultJson: string }
        | undefined;
    if (!existing) return null;
    if (existing.requestDigest !== envelope.requestDigest) {
        throw new ClaimOperationKeyReuseError(envelope.producer, envelope.operationKey);
    }
    try {
        return { result: JSON.parse(existing.resultJson) as T, replayed: true };
    } catch (error) {
        throw new ClaimGraphCorruptionError(
            `claim operation ${envelope.producer}/${envelope.operationKey} stored an unparseable result: ${error instanceof Error ? error.message : String(error)}`,
        );
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

/**
 * Envelope runner: replay of the same producer/key with the same digest
 * returns the stored committed result and performs zero new effects; the
 * same key with a different digest fails before any work runs. A first run
 * persists the envelope, stamps deduplicated outbox rows, and bumps one
 * generation per touched project.
 */
export function runMemoryClaimOperationInCurrentTransaction<T>(
    db: Database,
    envelope: MemoryClaimOperationEnvelope,
    work: () => { result: T; effects: readonly MemoryClaimEffect[] },
): MemoryClaimOperationOutcome<T> {
    const replay = readMemoryClaimOperationResult<T>(db, envelope);
    if (replay) return replay;

    const { result, effects } = work();
    // An ephemeral envelope's random key can never be presented again, so a
    // zero-effect run has no replay value: skip the claim_operations insert,
    // outbox stamps, and generation allocation entirely.
    if (envelope.ephemeral && effects.length === 0) return { result, replayed: false };
    const now = Date.now();
    const operationId = toRowId(
        db
            .prepare(
                `INSERT INTO claim_operations
                    (producer, operation_key, request_digest, expected_effect_count, result_json, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(
                envelope.producer,
                envelope.operationKey,
                envelope.requestDigest,
                effects.length,
                JSON.stringify(result ?? null),
                now,
            ),
    );

    const context = generationContexts.get(db);
    const generationByProject = context?.generations ?? new Map();
    const newlyAllocatedProjects = new Set<number>();
    for (const effect of effects) {
        if (generationByProject.has(effect.projectId)) continue;
        const row = db
            .prepare("SELECT generation FROM claim_project_generations WHERE project_id = ?")
            .get(effect.projectId) as { generation: number } | null | undefined;
        generationByProject.set(effect.projectId, {
            generation: (row?.generation ?? 0) + 1,
            existed: row != null,
        });
        newlyAllocatedProjects.add(effect.projectId);
    }
    const insertOutbox = db.prepare(
        `INSERT INTO claim_change_outbox
            (operation_id, effect_key, project_id, claim_id, effect_type, generation, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const effect of effects) {
        insertOutbox.run(
            operationId,
            effect.effectKey,
            effect.projectId,
            effect.claimId,
            effect.effectType,
            generationByProject.get(effect.projectId)?.generation as number,
            now,
        );
    }
    hitMemoryClaimFailpoint("memory-claim.030.outbox.after");

    for (const projectId of newlyAllocatedProjects) {
        const allocation = generationByProject.get(projectId);
        if (!allocation) continue;
        // Append-only collision guards inspect every INSERT, including ON
        // CONFLICT resolution, so allocation uses UPDATE-then-INSERT.
        if (allocation.existed) {
            db.prepare(
                "UPDATE claim_project_generations SET generation = ?, updated_at = ? WHERE project_id = ?",
            ).run(allocation.generation, now, projectId);
        } else {
            db.prepare(
                "INSERT INTO claim_project_generations (project_id, generation, updated_at) VALUES (?, ?, ?)",
            ).run(projectId, allocation.generation, now);
        }
    }
    hitMemoryClaimFailpoint("memory-claim.040.generation.after");

    return { result, replayed: false };
}

// ---------------------------------------------------------------------------
// Provenance, adoption, and revision metadata (KTD2, KTD3, KTD5, R4, R10)
// ---------------------------------------------------------------------------

/** The frozen claim semantic key for a canonical legacy memory id (KTD3). */
export function legacyMemoryClaimSubject(canonicalMemoryId: number): string {
    return `legacy-memory:${canonicalMemoryId}`;
}

export const LEGACY_MEMORY_CLAIM_PREDICATE = "states";
export const LEGACY_MEMORY_CLAIM_SCOPE = "project-memory";

export type MemoryClaimProvenance =
    | {
          kind: "live";
          producer: string;
          operationKey: string;
          sourceSessionId?: string | null;
      }
    | { kind: "migration" };

export interface MemoryClaimLink {
    memoryId: number;
    canonicalMemoryId: number;
    claimId: number;
    projectId: number;
    rootObservationId: number;
}

export type MemoryClaimLinkFailureReason =
    | "unresolved-project-identity"
    | "empty-content"
    | "empty-category"
    | "empty-normalized-hash"
    | "invalid-importance"
    | "invalid-scope"
    | "invalid-shareable"
    | "empty-source-session-id"
    | "empty-source-type"
    | "shared-claim-content-edit";

export class MemoryClaimsStatsIntegrityError extends Error {
    readonly memoryId: number;

    constructor(memoryId: number) {
        super(`memory_stats row missing for memory ${memoryId} during a claims merge write`);
        this.name = "MemoryClaimsStatsIntegrityError";
        this.memoryId = memoryId;
    }
}

/**
 * Prefixes that mark a `memories.project_path` as a canonical claims project
 * identity. Canonicality requires a nonempty suffix after the prefix: a bare
 * `git:`/`dir:` carries no identity payload. Single source of truth for
 * `resolveMemoryClaimProjectInCurrentTransaction` and the SQL twin
 * `canonicalMemoryProjectPathSql`, so the TS resolver and SQL gates cannot
 * drift.
 */
export const CANONICAL_MEMORY_PROJECT_PATH_PREFIXES = ["git:", "dir:"] as const;

/**
 * SQL predicate over a `project_path` column expression: true exactly when
 * the resolver's canonical-shape check accepts the path (known prefix plus a
 * nonempty suffix). Derived from `CANONICAL_MEMORY_PROJECT_PATH_PREFIXES` —
 * the same list the TS resolver consumes.
 */
export function canonicalMemoryProjectPathSql(column: string): string {
    // substr equality is a BINARY compare, matching the TS resolver's
    // case-sensitive startsWith; LIKE is ASCII-case-insensitive and would
    // accept 'GIT:'/'DIR:' rows the resolver rejects.
    const branches = CANONICAL_MEMORY_PROJECT_PATH_PREFIXES.map(
        (prefix) =>
            `(substr(${column}, 1, ${prefix.length}) = '${prefix}' AND length(${column}) > ${prefix.length})`,
    );
    return `(${branches.join(" OR ")})`;
}

/**
 * Resolve a legacy `project_path` to the numeric claims project. A canonical
 * identity registers on demand; a raw path that never rekeyed stays
 * unresolved (null) and belongs to the v22 repair lane. The canonical-shape
 * check derives from `CANONICAL_MEMORY_PROJECT_PATH_PREFIXES`; SQL callers
 * use `canonicalMemoryProjectPathSql` over the same list.
 */
export function resolveMemoryClaimProjectInCurrentTransaction(
    db: Database,
    projectPath: string,
): number | null {
    const existing = resolveProjectId(db, projectPath);
    if (existing !== null) return existing;
    if (
        CANONICAL_MEMORY_PROJECT_PATH_PREFIXES.some(
            (prefix) => projectPath.startsWith(prefix) && projectPath.length > prefix.length,
        )
    ) {
        return ensureProjectInCurrentTransaction(db, projectPath);
    }
    return null;
}

export function memoryClaimMetadataFailureReason(
    row: MemoryProjectionRow,
): MemoryClaimLinkFailureReason | null {
    if (typeof row.category !== "string" || row.category.length === 0) return "empty-category";
    if (typeof row.normalized_hash !== "string" || row.normalized_hash.length === 0) {
        return "empty-normalized-hash";
    }
    const importance = row.importance;
    if (
        importance !== null &&
        (!Number.isInteger(importance) || importance < 1 || importance > 100)
    ) {
        return "invalid-importance";
    }
    if (row.scope !== "project" && row.scope !== "ecosystem" && row.scope !== "universe") {
        return "invalid-scope";
    }
    if (row.shareable !== 0 && row.shareable !== 1) return "invalid-shareable";
    if (row.source_session_id === "") return "empty-source-session-id";
    if (typeof row.source_type !== "string" || row.source_type.length === 0) {
        return "empty-source-type";
    }
    return null;
}

export function memoryClaimAdoptionFailureReason(
    row: MemoryProjectionRow,
    projectId: number | null,
): MemoryClaimLinkFailureReason | null {
    if (projectId === null) return "unresolved-project-identity";
    if (typeof row.content !== "string" || row.content.length === 0) return "empty-content";
    return memoryClaimMetadataFailureReason(row);
}

export function recordMemoryClaimLinkFailure(
    db: Database,
    memoryId: number,
    projectPath: string,
    reason: MemoryClaimLinkFailureReason,
): void {
    const now = Date.now();
    db.prepare(
        `INSERT INTO claim_backfill_failures
            (phase, item_kind, item_key, reason_code, detail, disposition, created_at, updated_at)
         VALUES ('rows', 'memory', ?, ?, ?, 'blocking', ?, ?)
         ON CONFLICT(phase, item_kind, item_key)
         DO UPDATE SET reason_code = excluded.reason_code, detail = excluded.detail,
                       disposition = 'blocking', updated_at = excluded.updated_at`,
    ).run(String(memoryId), reason, projectPath.slice(0, 512), now, now);
}

/**
 * Flip a memory's rows-phase blocking/retry failure to resolved once its
 * crosswalk link exists — the live-writer twin of the backfill sweep
 * (`sweepResolvedRowFailures`). Warnings stay visible on the repair surface.
 */
export function resolveMemoryClaimLinkFailure(db: Database, memoryId: number): void {
    db.prepare(
        `UPDATE claim_backfill_failures SET disposition = 'resolved', updated_at = ?
          WHERE phase = 'rows' AND item_kind = 'memory' AND item_key = ?
            AND disposition IN ('blocking', 'retry')`,
    ).run(Date.now(), String(memoryId));
}

function createMemoryObservation(
    db: Database,
    args: {
        projectId: number;
        memoryId: number;
        content: string;
        provenance: MemoryClaimProvenance;
    },
): number {
    const live = args.provenance.kind === "live" ? args.provenance : null;
    const episodeId = createEpisode(db, {
        projectId: args.projectId,
        sourceSessionId: live?.sourceSessionId ?? null,
    });
    const sourceLocator = live
        ? `operation://${live.producer}/${live.operationKey}`
        : `legacy-memory://${args.memoryId}`;
    const spanId = createSourceSpan(db, {
        episodeId,
        sourceLocator,
        content: args.content,
        startOffset: 0,
        endOffset: args.content.length,
    });
    return createObservation(db, {
        sourceSpanId: spanId,
        extractedText: args.content,
        extractor: live ? live.producer : "legacy-memory-adoption",
        extractorVersion: "1",
        extractorRunId: live ? live.operationKey : `legacy-memory:${args.memoryId}`,
        independenceKey: `legacy-memory:${args.memoryId}`,
    });
}

interface RevisionMemoryMetadataInput {
    category: string;
    normalizedHash: string;
    importance: number;
    memoryScope: string;
    shareable: number;
    sourceType: string;
    expiresAt: number | null;
    metadataJson: string | null;
}

function clampImportance(value: number | null | undefined): number {
    const numeric = Number(value ?? 50);
    if (!Number.isFinite(numeric)) return 50;
    return Math.max(1, Math.min(100, Math.round(numeric)));
}

function metadataFromProjectionRow(
    row: MemoryProjectionRow,
    overrides: Partial<RevisionMemoryMetadataInput> = {},
): RevisionMemoryMetadataInput {
    return {
        category: row.category,
        normalizedHash: row.normalized_hash,
        importance: clampImportance(row.importance),
        memoryScope: row.scope,
        shareable: row.shareable,
        sourceType: row.source_type,
        expiresAt: row.expires_at,
        metadataJson: row.metadata_json,
        ...overrides,
    };
}

function insertRevisionMemoryMetadata(
    db: Database,
    revisionId: number,
    metadata: RevisionMemoryMetadataInput,
): void {
    db.prepare(
        `INSERT INTO claim_revision_memory_metadata
            (revision_id, category, normalized_hash, importance, memory_scope, shareable,
             source_type, expires_at, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        revisionId,
        metadata.category,
        metadata.normalizedHash,
        metadata.importance,
        metadata.memoryScope,
        metadata.shareable,
        metadata.sourceType,
        metadata.expiresAt,
        metadata.metadataJson,
        Date.now(),
    );
}

/**
 * Unknown or NULL projection status maps to archived, not active: every
 * legacy reader omits rows outside the three known statuses, so the claim
 * mirror must never publish such a row as live.
 */
export function claimStateFromMemoryStatus(status: string | null): ClaimState {
    if (status === "permanent" || status === "archived") return status;
    if (status === "active") return "active";
    return "archived";
}

export function readMemoryClaimLink(db: Database, memoryId: number): MemoryClaimLink | null {
    return (db
        .prepare(
            `SELECT memory_id AS memoryId, canonical_memory_id AS canonicalMemoryId,
                    claim_id AS claimId, project_id AS projectId,
                    root_observation_id AS rootObservationId
               FROM legacy_memory_claims WHERE memory_id = ?`,
        )
        .get(memoryId) ?? null) as MemoryClaimLink | null;
}

/**
 * True when another crosswalk row on the claim still references a live
 * (active or permanent) memories row. A canonical claim shared by several
 * projections (the dedup branch of `ensureMemoryClaimLinkInCurrentTransaction`)
 * retires only with its last live link; retiring it earlier would flip the
 * surviving projections' claim reads to archived.
 */
function claimHasOtherLiveMemoryLink(db: Database, claimId: number, memoryId: number): boolean {
    const sibling = db
        .prepare(
            `SELECT 1 FROM legacy_memory_claims lmc
               JOIN memories m ON m.id = lmc.memory_id
              WHERE lmc.claim_id = ? AND lmc.memory_id <> ?
                AND m.status IN ('active', 'permanent')
              LIMIT 1`,
        )
        .get(claimId, memoryId);
    return sibling !== null && sibling !== undefined;
}

const CLAIM_STATE_RANK: Record<ClaimState, number> = { archived: 0, active: 1, permanent: 2 };

/**
 * The lifecycle state a canonical claim should hold given one linked
 * projection's imminent status: the max-rank state (archived < active <
 * permanent) across every surviving linked projection, with THIS row's next
 * status substituted for its stored one (the projection write lands after
 * the claim write). A claim whose links all point at archived or deleted
 * rows resolves to archived. Generalizes the sibling-liveness retire gate:
 * one projection's transition can neither downgrade a permanent sibling nor
 * strand a stale permanent state once the last permanent link archives.
 */
export function sharedClaimStateFromLiveLinks(
    db: Database,
    claimId: number,
    memoryId: number,
    nextStatus: string,
): ClaimState {
    let state = claimStateFromMemoryStatus(nextStatus);
    const siblings = db
        .prepare(
            `SELECT m.status AS status FROM legacy_memory_claims lmc
               JOIN memories m ON m.id = lmc.memory_id
              WHERE lmc.claim_id = ? AND lmc.memory_id <> ?`,
        )
        .all(claimId, memoryId) as Array<{ status: string | null }>;
    for (const sibling of siblings) {
        const siblingState = claimStateFromMemoryStatus(sibling.status);
        if (CLAIM_STATE_RANK[siblingState] > CLAIM_STATE_RANK[state]) state = siblingState;
    }
    return state;
}

interface CanonicalHashMatch extends MemoryClaimLink {
    currentRevisionId: number;
    currentContent: string;
}

function findCanonicalLinkByHash(
    db: Database,
    projectId: number,
    category: string,
    normalizedHash: string,
): CanonicalHashMatch | null {
    return (db
        .prepare(
            `SELECT lmc.memory_id AS memoryId, lmc.canonical_memory_id AS canonicalMemoryId,
                    lmc.claim_id AS claimId, lmc.project_id AS projectId,
                    lmc.root_observation_id AS rootObservationId,
                    claims.current_revision_id AS currentRevisionId,
                    rev.content AS currentContent
               FROM legacy_memory_claims lmc
               JOIN claims ON claims.id = lmc.claim_id
               JOIN claim_revisions rev ON rev.id = claims.current_revision_id
               JOIN claim_revision_memory_metadata meta ON meta.revision_id = claims.current_revision_id
              WHERE lmc.project_id = ? AND lmc.memory_id = lmc.canonical_memory_id
                AND meta.category = ? AND meta.normalized_hash = ?
              ORDER BY lmc.memory_id LIMIT 1`,
        )
        .get(projectId, category, normalizedHash) ?? null) as CanonicalHashMatch | null;
}

function readClaimCurrentRevisionId(db: Database, claimId: number): number {
    const row = db
        .prepare("SELECT current_revision_id AS pointer FROM claims WHERE id = ?")
        .get(claimId) as { pointer: number | null } | undefined;
    if (!row || row.pointer === null) {
        throw new ClaimGraphCorruptionError(
            `claim ${claimId} is missing or has a null current-revision pointer`,
        );
    }
    return row.pointer;
}

function appendMemoryClaimRevision(
    db: Database,
    args: {
        claimId: number;
        content: string;
        observationId: number;
        metadata: RevisionMemoryMetadataInput;
        sourceSessionId?: string | null;
    },
): number {
    const expected = readClaimCurrentRevisionId(db, args.claimId);
    const outcome = appendClaimRevisionInCurrentTransaction(db, {
        claimId: args.claimId,
        expectedCurrentRevisionId: expected,
        content: args.content,
        evidence: [{ observationId: args.observationId }],
        sourceSessionId: args.sourceSessionId ?? null,
    });
    if (outcome.status !== "applied") {
        throw new Error(
            `memory claim revision append failed with status ${outcome.status} for claim ${args.claimId}`,
        );
    }
    insertRevisionMemoryMetadata(db, outcome.revisionId, args.metadata);
    return outcome.revisionId;
}

export interface EnsureMemoryClaimLinkOptions {
    /**
     * When false, a hash-equal preimage whose content or revision metadata
     * differs from the canonical claim links WITHOUT appending a revision
     * (the source bytes stay retained on the root observation). Merge-delete
     * relocations use this so the canonical claim keeps reflecting the
     * surviving projection row (R6).
     */
    adoptDivergentContent?: boolean;
}

/**
 * Ensure the memory row has its durable claim link, adopting the preimage as
 * revision 1 when unlinked (R10). Exact-hash dedup selects the existing
 * canonical claim for the (project, category, normalized hash) tuple before
 * allocating a new one (KTD3, R6); a hash-equal preimage whose content or
 * revision metadata differs from the canonical claim's current semantic
 * state appends a revision so the claim reflects it.
 */
export function ensureMemoryClaimLinkInCurrentTransaction(
    db: Database,
    row: MemoryProjectionRow,
    projectId: number,
    provenance: MemoryClaimProvenance,
    options: EnsureMemoryClaimLinkOptions = {},
): MemoryClaimLink {
    const existing = readMemoryClaimLink(db, row.id);
    if (existing) return existing;

    const failure = memoryClaimAdoptionFailureReason(row, projectId);
    if (failure) throw new Error(`memory ${row.id} cannot be adopted into claims: ${failure}`);

    const now = Date.now();
    const canonical = findCanonicalLinkByHash(db, projectId, row.category, row.normalized_hash);
    if (canonical && canonical.canonicalMemoryId !== row.id) {
        const observationId = createMemoryObservation(db, {
            projectId,
            memoryId: row.id,
            content: row.content,
            provenance,
        });
        if (options.adoptDivergentContent ?? true) {
            // Compare the full semantic state, not content alone: a re-added
            // memory can carry the same bytes with divergent importance /
            // scope / metadata, and reusing the canonical claim as-is would
            // reactivate it with stale revision metadata.
            const current = readCurrentClaimSemanticState(db, canonical.claimId);
            const desiredMeta = metadataFromProjectionRow(row);
            if (
                claimSemanticStateDiffers(current, row.content, desiredMeta, row.source_session_id)
            ) {
                appendMemoryClaimRevision(db, {
                    claimId: canonical.claimId,
                    content: row.content,
                    observationId,
                    metadata: desiredMeta,
                    sourceSessionId: row.source_session_id,
                });
            }
        }
        db.prepare(
            `INSERT INTO legacy_memory_claims
                (memory_id, canonical_memory_id, claim_id, project_id, root_observation_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
            row.id,
            canonical.canonicalMemoryId,
            canonical.claimId,
            projectId,
            observationId,
            now,
        );
        resolveMemoryClaimLinkFailure(db, row.id);
        return {
            memoryId: row.id,
            canonicalMemoryId: canonical.canonicalMemoryId,
            claimId: canonical.claimId,
            projectId,
            rootObservationId: observationId,
        };
    }

    const observationId = createMemoryObservation(db, {
        projectId,
        memoryId: row.id,
        content: row.content,
        provenance,
    });
    const created = createClaimInCurrentTransaction(db, {
        projectId,
        subject: legacyMemoryClaimSubject(row.id),
        predicate: LEGACY_MEMORY_CLAIM_PREDICATE,
        scope: LEGACY_MEMORY_CLAIM_SCOPE,
        state: claimStateFromMemoryStatus(row.status),
        content: row.content,
        evidence: [{ observationId }],
        sourceSessionId: row.source_session_id,
    });
    if (created.status !== "applied") {
        throw new ClaimGraphCorruptionError(
            `memory ${row.id} claim adoption failed: ${created.status === "invalid" ? created.reason : created.status}`,
        );
    }
    insertRevisionMemoryMetadata(db, created.revisionId, metadataFromProjectionRow(row));
    db.prepare(
        `INSERT INTO legacy_memory_claims
            (memory_id, canonical_memory_id, claim_id, project_id, root_observation_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(row.id, row.id, created.claimId, projectId, observationId, now);
    resolveMemoryClaimLinkFailure(db, row.id);
    return {
        memoryId: row.id,
        canonicalMemoryId: row.id,
        claimId: created.claimId,
        projectId,
        rootObservationId: observationId,
    };
}

/** Why a supersession recording did — or deliberately did not — write an edge. */
export type MemoryClaimSupersessionOutcome =
    | "recorded"
    | "exists"
    | "same-claim"
    | "sibling-suppressed";

/**
 * Record one supersession edge between two linked memories' current
 * revisions: same-project pairs use `claim_conflicts` (supersedes), distinct
 * projects use the audit-only `claim_merge_lineage` relation (KTD8). A
 * source claim with another live crosswalk link records nothing
 * ("sibling-suppressed"): the sibling projection still asserts the claim, so
 * an edge would mark the survivor's claim superseded. Both paths are
 * idempotent ("exists"), so page replay or a doctor retry cannot duplicate
 * lineage. The discriminated outcome lets callers separate a new edge from
 * the reasons no edge exists — the disposition oracle must not demand an
 * edge the sibling-liveness rule forbids.
 */
export function recordMemoryClaimSupersessionOutcomeInCurrentTransaction(
    db: Database,
    source: MemoryClaimLink,
    target: MemoryClaimLink,
): MemoryClaimSupersessionOutcome {
    // A duplicate link shares its canonical claim; a claim cannot supersede
    // itself.
    if (source.claimId === target.claimId) return "same-claim";
    if (claimHasOtherLiveMemoryLink(db, source.claimId, source.memoryId)) {
        return "sibling-suppressed";
    }
    const sourceRevisionId = readClaimCurrentRevisionId(db, source.claimId);
    const targetRevisionId = readClaimCurrentRevisionId(db, target.claimId);
    if (source.projectId === target.projectId) {
        const existing = db
            .prepare(
                "SELECT 1 FROM claim_conflicts WHERE relation = 'supersedes' AND left_revision_id = ? AND right_revision_id = ?",
            )
            .get(targetRevisionId, sourceRevisionId);
        if (existing) return "exists";
        addClaimConflictInCurrentTransaction(db, {
            relation: "supersedes",
            leftRevisionId: targetRevisionId,
            rightRevisionId: sourceRevisionId,
        });
        return "recorded";
    }
    const existing = db
        .prepare(
            "SELECT 1 FROM claim_merge_lineage WHERE source_revision_id = ? AND target_revision_id = ?",
        )
        .get(sourceRevisionId, targetRevisionId);
    if (existing) return "exists";
    db.prepare(
        `INSERT INTO claim_merge_lineage
            (source_revision_id, source_project_id, target_revision_id, target_project_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
    ).run(sourceRevisionId, source.projectId, targetRevisionId, target.projectId, Date.now());
    return "recorded";
}

/** Boolean view of the outcome recorder: true only when a new edge was recorded. */
export function recordMemoryClaimSupersessionInCurrentTransaction(
    db: Database,
    source: MemoryClaimLink,
    target: MemoryClaimLink,
): boolean {
    return (
        recordMemoryClaimSupersessionOutcomeInCurrentTransaction(db, source, target) === "recorded"
    );
}

export interface MemoryClaimLineageToken {
    ordinal: number;
    raw: string;
    kind: "id" | "marker" | "malformed";
    id?: number;
}

export interface MemoryRelationshipSourceRow {
    sourceId: number;
    memoryId: number;
    sourceDigest: string;
    mergedFrom: string | null;
    supersededByMemoryId: number | null;
}

export function parseMemoryClaimMergedFrom(raw: string | null): MemoryClaimLineageToken[] {
    if (raw === null) return [];
    const trimmed = raw.trim();
    if (trimmed.length === 0) return [];
    if (trimmed.startsWith("[")) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(trimmed);
        } catch {
            return [{ ordinal: 0, raw: trimmed, kind: "malformed" }];
        }
        if (!Array.isArray(parsed)) return [{ ordinal: 0, raw: trimmed, kind: "malformed" }];
        return parsed.map((value, ordinal) => {
            const numeric =
                typeof value === "number"
                    ? value
                    : typeof value === "string" && /^\d+$/.test(value.trim())
                      ? Number.parseInt(value.trim(), 10)
                      : null;
            return numeric !== null && Number.isSafeInteger(numeric) && numeric >= 1
                ? { ordinal, raw: String(value), kind: "id" as const, id: numeric }
                : {
                      ordinal,
                      raw: JSON.stringify(value) ?? String(value),
                      kind: "malformed" as const,
                  };
        });
    }
    return trimmed.split(",").map((part, ordinal) => {
        const token = part.trim();
        if (token === "identity-merge") return { ordinal, raw: token, kind: "marker" as const };
        if (/^\d+$/.test(token)) {
            return { ordinal, raw: token, kind: "id" as const, id: Number.parseInt(token, 10) };
        }
        return { ordinal, raw: token, kind: "malformed" as const };
    });
}

function memoryRelationshipSourceDigest(row: {
    merged_from: string | null;
    superseded_by_memory_id: number | null;
}): string {
    return sha256Utf8Hex(JSON.stringify([row.merged_from, row.superseded_by_memory_id]));
}

function memoryRelationshipTokenDetail(token: MemoryClaimLineageToken): string {
    return JSON.stringify({
        ordinal: token.ordinal,
        raw: token.raw.slice(0, 160),
        digest: sha256Utf8Hex(token.raw),
    });
}

function upsertMemoryRelationshipDisposition(
    db: Database,
    itemKind: "lineage" | "supersession",
    itemKey: string,
    reasonCode: string,
    detail: string,
    resolved: boolean,
): void {
    const now = Date.now();
    db.prepare(
        `INSERT INTO claim_backfill_failures
            (phase, item_kind, item_key, reason_code, detail, disposition, created_at, updated_at)
         VALUES ('relationships', ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(phase, item_kind, item_key) DO UPDATE SET
            reason_code = excluded.reason_code,
            detail = excluded.detail,
            disposition = CASE
                WHEN claim_backfill_failures.disposition = 'warning' THEN 'warning'
                ELSE excluded.disposition
            END,
            rationale = CASE
                WHEN claim_backfill_failures.disposition = 'warning'
                THEN claim_backfill_failures.rationale ELSE NULL
            END,
            updated_at = excluded.updated_at`,
    ).run(
        itemKind,
        itemKey,
        reasonCode,
        detail.slice(0, 2000),
        resolved ? "resolved" : "blocking",
        now,
        now,
    );
}

export function memoryClaimSupersessionExists(
    db: Database,
    source: MemoryClaimLink,
    target: MemoryClaimLink,
): boolean {
    if (source.claimId === target.claimId) return true;
    if (source.projectId === target.projectId) {
        return Boolean(
            db
                .prepare(
                    `SELECT 1 FROM claim_conflicts cc
                       JOIN claim_revisions left_rev ON left_rev.id = cc.left_revision_id
                       JOIN claim_revisions right_rev ON right_rev.id = cc.right_revision_id
                      WHERE cc.relation = 'supersedes'
                        AND left_rev.claim_id = ? AND right_rev.claim_id = ? LIMIT 1`,
                )
                .get(target.claimId, source.claimId),
        );
    }
    return Boolean(
        db
            .prepare(
                `SELECT 1 FROM claim_merge_lineage cml
                   JOIN claim_revisions source_rev ON source_rev.id = cml.source_revision_id
                   JOIN claim_revisions target_rev ON target_rev.id = cml.target_revision_id
                  WHERE source_rev.claim_id = ? AND target_rev.claim_id = ? LIMIT 1`,
            )
            .get(source.claimId, target.claimId),
    );
}

export function listMemoryRelationshipSources(
    db: Database,
    boundaryMemoryId: number,
): MemoryRelationshipSourceRow[] {
    return db
        .prepare(
            `SELECT id AS sourceId, memory_id AS memoryId, source_digest AS sourceDigest,
                    merged_from AS mergedFrom,
                    superseded_by_memory_id AS supersededByMemoryId
               FROM claim_memory_relationship_sources
              WHERE memory_id <= ? ORDER BY memory_id, id`,
        )
        .all(boundaryMemoryId) as MemoryRelationshipSourceRow[];
}

export function translateMemoryClaimRelationshipsInCurrentTransaction(
    db: Database,
    row: Pick<MemoryProjectionRow, "id" | "merged_from" | "superseded_by_memory_id">,
): MemoryClaimEffect[] {
    const link = readMemoryClaimLink(db, row.id);
    if (!link) return [];

    const sourceDigest = memoryRelationshipSourceDigest(row);
    if (
        !db
            .prepare(
                "SELECT 1 FROM claim_memory_relationship_sources WHERE memory_id = ? AND source_digest = ?",
            )
            .get(row.id, sourceDigest)
    ) {
        db.prepare(
            `INSERT INTO claim_memory_relationship_sources
                (memory_id, source_digest, merged_from, superseded_by_memory_id, created_at)
             VALUES (?, ?, ?, ?, ?)`,
        ).run(row.id, sourceDigest, row.merged_from, row.superseded_by_memory_id, Date.now());
    }

    const prefix = `memory:${row.id}:relations:${sourceDigest}`;
    db.prepare(
        `UPDATE claim_backfill_failures
            SET disposition = 'resolved', reason_code = 'relationship-source-replaced',
                rationale = NULL, updated_at = ?
          WHERE phase = 'relationships'
            AND item_key LIKE ?
            AND item_key NOT LIKE ?
            AND disposition IN ('blocking', 'retry')`,
    ).run(Date.now(), `memory:${row.id}:relations:%`, `${prefix}:%`);

    const effects: MemoryClaimEffect[] = [];
    if (row.superseded_by_memory_id !== null) {
        const itemKey = `${prefix}:superseded-by`;
        const target = readMemoryClaimLink(db, row.superseded_by_memory_id);
        if (target) {
            const outcome: MemoryClaimSupersessionOutcome = memoryClaimSupersessionExists(
                db,
                link,
                target,
            )
                ? "exists"
                : recordMemoryClaimSupersessionOutcomeInCurrentTransaction(db, link, target);
            upsertMemoryRelationshipDisposition(
                db,
                "supersession",
                itemKey,
                // A sibling-suppressed edge is deliberately absent from the
                // graph: the source claim keeps a live sibling link. Its own
                // reason code keeps the reconciliation oracle from demanding
                // the edge the sibling-liveness rule forbids.
                outcome === "sibling-suppressed"
                    ? "sibling-suppressed-supersession"
                    : "translated-supersession",
                memoryRelationshipTokenDetail({
                    ordinal: 0,
                    raw: String(row.superseded_by_memory_id),
                    kind: "id",
                }),
                true,
            );
            if (outcome === "recorded") {
                effects.push({
                    effectKey: `${prefix}:supersession`,
                    projectId: target.projectId,
                    claimId: target.claimId,
                    effectType: "evidence",
                });
            }
        } else {
            upsertMemoryRelationshipDisposition(
                db,
                "supersession",
                itemKey,
                "dangling-supersession",
                memoryRelationshipTokenDetail({
                    ordinal: 0,
                    raw: String(row.superseded_by_memory_id),
                    kind: "id",
                }),
                false,
            );
        }
    }

    for (const token of parseMemoryClaimMergedFrom(row.merged_from)) {
        const itemKey = `${prefix}:merged-from:${token.ordinal}`;
        if (token.kind === "marker") {
            upsertMemoryRelationshipDisposition(
                db,
                "lineage",
                itemKey,
                "identity-merge-marker",
                memoryRelationshipTokenDetail(token),
                true,
            );
            continue;
        }
        if (token.kind === "id") {
            const source = readMemoryClaimLink(db, token.id as number);
            if (source) {
                const outcome: MemoryClaimSupersessionOutcome = memoryClaimSupersessionExists(
                    db,
                    source,
                    link,
                )
                    ? "exists"
                    : recordMemoryClaimSupersessionOutcomeInCurrentTransaction(db, source, link);
                upsertMemoryRelationshipDisposition(
                    db,
                    "lineage",
                    itemKey,
                    // Same sibling-liveness suppression as the superseded-by
                    // branch: the merged-from source claim stays asserted by
                    // a live sibling, so no lineage edge may exist.
                    outcome === "sibling-suppressed"
                        ? "sibling-suppressed-supersession"
                        : "translated-lineage",
                    memoryRelationshipTokenDetail(token),
                    true,
                );
                if (outcome === "recorded") {
                    effects.push({
                        effectKey: `${prefix}:lineage:${token.ordinal}`,
                        projectId: link.projectId,
                        claimId: link.claimId,
                        effectType: "evidence",
                    });
                }
                continue;
            }
            upsertMemoryRelationshipDisposition(
                db,
                "lineage",
                itemKey,
                "dangling-lineage",
                memoryRelationshipTokenDetail(token),
                false,
            );
            continue;
        }
        upsertMemoryRelationshipDisposition(
            db,
            "lineage",
            itemKey,
            "malformed-lineage",
            memoryRelationshipTokenDetail(token),
            false,
        );
    }
    return effects;
}

/** Claim lifecycle state change (active | permanent | archived). */
export function setClaimLifecycleStateInCurrentTransaction(
    db: Database,
    claimId: number,
    state: ClaimState,
): void {
    db.prepare("UPDATE claims SET state = ? WHERE id = ?").run(state, claimId);
    // Read-back instead of a change count: bun:sqlite can report a
    // transaction-wide total-changes delta rather than the UPDATE's own row
    // count, so the count is not a reliable single-row oracle.
    const row = db.prepare("SELECT state FROM claims WHERE id = ?").get(claimId) as
        | { state: string }
        | undefined;
    if (row?.state !== state) {
        throw new Error(`claim ${claimId} lifecycle update did not persist state ${state}`);
    }
}

export function retireMemoryClaimInCurrentTransaction(
    db: Database,
    claimId: number,
    verifier: string,
): void {
    setClaimLifecycleStateInCurrentTransaction(db, claimId, "archived");
    addVerificationEvent(db, {
        revisionId: readClaimCurrentRevisionId(db, claimId),
        outcome: "archive",
        verifier,
    });
}

// ---------------------------------------------------------------------------
// Kernel operations (Mutation Transition Matrix)
// ---------------------------------------------------------------------------

export interface MemoryClaimWriteResult {
    memoryId: number;
    /** Null when the row could not link (unresolved identity / empty content). */
    claimId: number | null;
    revisionId: number | null;
    /** False when the target memory row does not exist (legacy no-op). */
    found: boolean;
}

function unlinkableResult(memoryId: number, found = true): MemoryClaimWriteResult {
    return { memoryId, claimId: null, revisionId: null, found };
}

/**
 * Pre-adoption gate shared by the direct write paths: computes the FULL
 * adoption failure reason — unresolved identity, empty content, and the
 * schema-legal metadata shapes `memories` cannot reject (bad scope,
 * importance, shareable, ...) — and records the blocking failure row. A
 * non-null return means the caller applies its projection mutation and
 * returns an unlinkable result instead of reaching the invariant throw
 * inside `ensureMemoryClaimLinkInCurrentTransaction`; the v22 takeover (U4)
 * and doctor retry (U5) own the repair. Callers keep a redundant
 * `projectId === null` term in their branch condition purely to narrow the
 * type — the returned reason already covers it.
 */
function recordMemoryClaimAdoptionFailure(
    db: Database,
    row: MemoryProjectionRow,
    projectId: number | null,
): MemoryClaimLinkFailureReason | null {
    const failure = memoryClaimAdoptionFailureReason(row, projectId);
    if (failure !== null) {
        recordMemoryClaimLinkFailure(db, row.id, row.project_path, failure);
    }
    return failure;
}

function liveProvenance(
    envelope: MemoryClaimOperationEnvelope,
    sourceSessionId?: string | null,
): MemoryClaimProvenance {
    return {
        kind: "live",
        producer: envelope.producer,
        operationKey: envelope.operationKey,
        sourceSessionId: sourceSessionId ?? null,
    };
}

/**
 * New memory: projection insert (allocating the canonical memory id while
 * the transaction is uncommitted, KTD3), claim revision 1 with live
 * provenance and revision metadata, crosswalk, one upsert effect, one
 * generation bump. Stats and FTS state come from the existing triggers.
 */
export function createMemoryWithClaimsInCurrentTransaction(
    db: Database,
    envelope: MemoryClaimOperationEnvelope,
    input: MemoryProjectionInsert,
): MemoryClaimOperationOutcome<MemoryClaimWriteResult> {
    return runMemoryClaimOperationInCurrentTransaction(db, envelope, () => {
        const memoryId = insertMemoryProjectionRow(db, input);
        const projectId = resolveMemoryClaimProjectInCurrentTransaction(db, input.projectPath);
        const row = readMemoryProjectionRow(db, memoryId) as MemoryProjectionRow;
        const failure = recordMemoryClaimAdoptionFailure(db, row, projectId);
        if (failure !== null || projectId === null) {
            hitMemoryClaimFailpoint("memory-claim.010.claim.after");
            hitMemoryClaimFailpoint("memory-claim.020.projection.after");
            return { result: unlinkableResult(memoryId), effects: [] };
        }
        const link = ensureMemoryClaimLinkInCurrentTransaction(
            db,
            row,
            projectId,
            liveProvenance(envelope, input.sourceSessionId),
        );
        // Re-adding content whose canonical claim was archived by a delete
        // reactivates the claim alongside the fresh projection row. The
        // max-rank shared state (not a hardcoded 'active') keeps a permanent
        // sibling's claim permanent; the sync emits the lifecycle effect for
        // an actual state change.
        const lifecycleEffects = syncClaimLifecycleAfterAdoption(
            db,
            row,
            link,
            projectId,
            envelope.producer,
        );
        const revisionId = readClaimCurrentRevisionId(db, link.claimId);
        hitMemoryClaimFailpoint("memory-claim.010.claim.after");
        hitMemoryClaimFailpoint("memory-claim.020.projection.after");
        return {
            result: { memoryId, claimId: link.claimId, revisionId, found: true },
            effects: [
                {
                    effectKey: `memory:${memoryId}:upsert`,
                    projectId,
                    claimId: link.claimId,
                    effectType: "upsert" as const,
                },
                ...lifecycleEffects,
            ],
        };
    });
}

export interface UpdateMemoryContentClaimInput {
    memoryId: number;
    content: string;
    normalizedHash: string;
    sourceSessionId?: string | null;
    /**
     * The caller's verdict invalidated the previous verification: the kernel
     * deletes the `memory_verifications` rows inside this transaction and
     * suppresses the verified-event carry, so the new revision never claims
     * verified for content the verdict rejected.
     */
    clearsVerification?: boolean;
    nowMs?: number;
}

/**
 * Same positivity rule as claims-backfill's
 * `recordAdoptedMemoryVerifiedEventInCurrentTransaction`: a row counts as
 * verified when the projection columns say so or the `memory_verifications`
 * side table carries a positive `verified_at` (the only place pre-v84
 * TypeScript verification writes). Duplicated locally because importing
 * claims-backfill here would form a runtime import cycle and break this
 * module's explicit-`.ts` import contract for the Node SQLite smoke script.
 */
function memoryRowHasPositiveVerification(
    db: Database,
    row: Pick<MemoryProjectionRow, "id" | "verification_status" | "verified_at">,
): boolean {
    if (row.verification_status === "verified" && row.verified_at !== null && row.verified_at > 0) {
        return true;
    }
    const side = db
        .prepare(
            "SELECT MAX(verified_at) AS verifiedAt FROM memory_verifications WHERE memory_id = ?",
        )
        .get(row.id) as { verifiedAt: number | null } | undefined;
    return (side?.verifiedAt ?? 0) > 0;
}

/**
 * Lifecycle half of an adoption: `ensureMemoryClaimLinkInCurrentTransaction`
 * reuses whatever canonical claim already owns the (project, category, hash)
 * tuple — including one archived by a prior delete of an equivalent row — so
 * the claim state is re-derived from the adopting projection row under the
 * shared-claim max-rank rule and an active row never points at an archived
 * claim. An archive transition retires (archive event); any other change
 * sets the state directly. Returns the lifecycle effect only when the state
 * actually changed. Local twin of relocate-memory's
 * `syncAdoptedClaimLifecycleState`: importing it here would form an import
 * cycle (relocate-memory imports this module).
 */
export function syncClaimLifecycleAfterAdoption(
    db: Database,
    row: MemoryProjectionRow,
    link: MemoryClaimLink,
    projectId: number,
    producer: string,
): MemoryClaimEffect[] {
    const desiredState = sharedClaimStateFromLiveLinks(db, link.claimId, row.id, row.status);
    if (readCurrentClaimSemanticState(db, link.claimId).state === desiredState) return [];
    if (desiredState === "archived") {
        retireMemoryClaimInCurrentTransaction(db, link.claimId, producer);
    } else {
        setClaimLifecycleStateInCurrentTransaction(db, link.claimId, desiredState);
    }
    return [
        {
            effectKey: `memory:${row.id}:lifecycle`,
            projectId,
            claimId: link.claimId,
            effectType: "lifecycle" as const,
        },
    ];
}

/**
 * Content rewrite: adopt an unlinked preimage as revision 1, then append the
 * requested content as the next revision in the same transaction (R10),
 * update the projection semantic fields, and invalidate derived rows.
 */
export function updateMemoryContentWithClaimsInCurrentTransaction(
    db: Database,
    envelope: MemoryClaimOperationEnvelope,
    input: UpdateMemoryContentClaimInput,
): MemoryClaimOperationOutcome<MemoryClaimWriteResult> {
    return runMemoryClaimOperationInCurrentTransaction(db, envelope, () => {
        const row = readMemoryProjectionRow(db, input.memoryId);
        if (!row) return { result: unlinkableResult(input.memoryId, false), effects: [] };
        // The verdict-driven clear owns the side-table delete inside this
        // transaction; the carry gates below are suppressed with it because
        // the projection's verified columns describe the rejected content.
        if (input.clearsVerification) {
            db.prepare("DELETE FROM memory_verifications WHERE memory_id = ?").run(row.id);
        }
        const projectId = resolveMemoryClaimProjectInCurrentTransaction(db, row.project_path);
        const failure = recordMemoryClaimAdoptionFailure(db, row, projectId);
        if (failure !== null || projectId === null || input.content.length === 0) {
            // An empty replacement content cannot form a revision even when
            // the preimage row itself is adoptable.
            if (failure === null) {
                recordMemoryClaimLinkFailure(db, row.id, row.project_path, "empty-content");
            }
            hitMemoryClaimFailpoint("memory-claim.010.claim.after");
            updateMemoryProjectionContent(
                db,
                row.id,
                input.content,
                input.normalizedHash,
                input.nowMs,
            );
            hitMemoryClaimFailpoint("memory-claim.020.projection.after");
            // The rewrite can repair the very reason the preimage was
            // unadoptable (an empty-content row given real content), so the
            // repaired postimage adopts inside the same operation; committing
            // the projection alone would strand a now-adoptable row unlinked.
            const post = readMemoryProjectionRow(db, row.id);
            if (
                post &&
                projectId !== null &&
                memoryClaimAdoptionFailureReason(post, projectId) === null
            ) {
                const link = ensureMemoryClaimLinkInCurrentTransaction(
                    db,
                    post,
                    projectId,
                    liveProvenance(envelope, input.sourceSessionId ?? post.source_session_id),
                );
                const effects: MemoryClaimEffect[] = [
                    {
                        effectKey: `memory:${row.id}:upsert`,
                        projectId,
                        claimId: link.claimId,
                        effectType: "upsert" as const,
                    },
                    ...syncClaimLifecycleAfterAdoption(
                        db,
                        post,
                        link,
                        projectId,
                        envelope.producer,
                    ),
                ];
                // The projection keeps its verified columns across a content
                // rewrite, so the adopted claim's current revision needs its
                // own verified event.
                if (!input.clearsVerification && memoryRowHasPositiveVerification(db, post)) {
                    addVerificationEvent(db, {
                        revisionId: readClaimCurrentRevisionId(db, link.claimId),
                        outcome: "verified",
                        verifier: envelope.producer,
                    });
                    effects.push({
                        effectKey: `memory:${row.id}:evidence`,
                        projectId,
                        claimId: link.claimId,
                        effectType: "evidence" as const,
                    });
                }
                return {
                    result: {
                        memoryId: row.id,
                        claimId: link.claimId,
                        revisionId: readClaimCurrentRevisionId(db, link.claimId),
                        found: true,
                    },
                    effects,
                };
            }
            return { result: unlinkableResult(row.id), effects: [] };
        }
        const link = ensureMemoryClaimLinkInCurrentTransaction(db, row, projectId, {
            kind: "migration",
        });
        // The projection write leaves source_session_id untouched, so the
        // revision defaults to the row's session (like every other revision
        // path); an explicit input session still wins.
        const sessionId = input.sourceSessionId ?? row.source_session_id;
        const observationId = createMemoryObservation(db, {
            projectId,
            memoryId: row.id,
            content: input.content,
            provenance: liveProvenance(envelope, sessionId),
        });
        if (
            input.normalizedHash !== row.normalized_hash &&
            claimHasOtherLiveMemoryLink(db, link.claimId, row.id)
        ) {
            // Another live projection shares this canonical claim, so the
            // hash-changing append below makes the claim's current revision
            // diverge from that sibling's projection (and strands its hash
            // dedup lookup). The append still proceeds — no oracle-level
            // split or unlink exists — so the divergence is recorded as a
            // fail-visible diagnostic on the edited row.
            recordMemoryClaimLinkFailure(db, row.id, row.project_path, "shared-claim-content-edit");
        }
        // The content update resets shareable in the projection; the revision
        // metadata mirrors that post-state.
        const revisionId = appendMemoryClaimRevision(db, {
            claimId: link.claimId,
            content: input.content,
            observationId,
            metadata: metadataFromProjectionRow(row, {
                normalizedHash: input.normalizedHash,
                shareable: 0,
            }),
            sourceSessionId: sessionId,
        });
        const effects: MemoryClaimEffect[] = [
            {
                effectKey: `memory:${row.id}:upsert`,
                projectId,
                claimId: link.claimId,
                effectType: "upsert" as const,
            },
            // The link above can dedup-adopt an archived canonical claim, so
            // the lifecycle re-derivation runs after the revision append and
            // any archive event lands on the new current revision.
            ...syncClaimLifecycleAfterAdoption(db, row, link, projectId, envelope.producer),
        ];
        // The projection deliberately keeps its verified columns across a
        // content rewrite, so the appended revision needs its own verified
        // event — without one the claim's current revision reads unverified
        // while the projection stays verified.
        if (!input.clearsVerification && memoryRowHasPositiveVerification(db, row)) {
            addVerificationEvent(db, {
                revisionId,
                outcome: "verified",
                verifier: envelope.producer,
            });
            effects.push({
                effectKey: `memory:${row.id}:evidence`,
                projectId,
                claimId: link.claimId,
                effectType: "evidence" as const,
            });
        }
        hitMemoryClaimFailpoint("memory-claim.010.claim.after");
        updateMemoryProjectionContent(db, row.id, input.content, input.normalizedHash, input.nowMs);
        hitMemoryClaimFailpoint("memory-claim.020.projection.after");
        return {
            result: { memoryId: row.id, claimId: link.claimId, revisionId, found: true },
            effects,
        };
    });
}

export interface UpdateMemoryClassificationClaimInput {
    memoryId: number;
    importance?: number;
    scope?: string;
    shareable?: number;
    nowMs?: number;
}

/**
 * Classification-only semantic change: appends a same-content revision whose
 * metadata carries the new importance/scope/shareability, then updates the
 * projection fields plus the classified_at run-gate stamp.
 */
export function updateMemoryClassificationWithClaimsInCurrentTransaction(
    db: Database,
    envelope: MemoryClaimOperationEnvelope,
    input: UpdateMemoryClassificationClaimInput,
): MemoryClaimOperationOutcome<MemoryClaimWriteResult> {
    return runMemoryClaimOperationInCurrentTransaction(db, envelope, () => {
        const row = readMemoryProjectionRow(db, input.memoryId);
        if (!row) return { result: unlinkableResult(input.memoryId, false), effects: [] };
        const projectId = resolveMemoryClaimProjectInCurrentTransaction(db, row.project_path);
        const projectionUpdate = {
            importance: input.importance,
            scope: input.scope,
            shareable: input.shareable,
        };
        const failure = recordMemoryClaimAdoptionFailure(db, row, projectId);
        if (failure !== null || projectId === null) {
            hitMemoryClaimFailpoint("memory-claim.010.claim.after");
            updateMemoryProjectionClassification(db, row.id, projectionUpdate, input.nowMs);
            hitMemoryClaimFailpoint("memory-claim.020.projection.after");
            // The classification write can repair the very reason the
            // preimage was unadoptable (an invalid importance / scope /
            // shareable given a valid replacement), so the repaired postimage
            // adopts inside the same operation; committing the projection
            // alone would strand a now-adoptable row unlinked.
            const post = readMemoryProjectionRow(db, row.id);
            if (
                post &&
                projectId !== null &&
                memoryClaimAdoptionFailureReason(post, projectId) === null
            ) {
                const link = ensureMemoryClaimLinkInCurrentTransaction(
                    db,
                    post,
                    projectId,
                    liveProvenance(envelope, post.source_session_id),
                );
                const effects: MemoryClaimEffect[] = [
                    {
                        effectKey: `memory:${row.id}:upsert`,
                        projectId,
                        claimId: link.claimId,
                        effectType: "upsert" as const,
                    },
                    ...syncClaimLifecycleAfterAdoption(
                        db,
                        post,
                        link,
                        projectId,
                        envelope.producer,
                    ),
                ];
                // Adoption reads the projection's verified columns and side
                // table, so the adopted claim's current revision needs its
                // own verified event when the row is positively verified.
                if (memoryRowHasPositiveVerification(db, post)) {
                    addVerificationEvent(db, {
                        revisionId: readClaimCurrentRevisionId(db, link.claimId),
                        outcome: "verified",
                        verifier: envelope.producer,
                    });
                    effects.push({
                        effectKey: `memory:${row.id}:evidence`,
                        projectId,
                        claimId: link.claimId,
                        effectType: "evidence" as const,
                    });
                }
                return {
                    result: {
                        memoryId: row.id,
                        claimId: link.claimId,
                        revisionId: readClaimCurrentRevisionId(db, link.claimId),
                        found: true,
                    },
                    effects,
                };
            }
            return { result: unlinkableResult(row.id), effects: [] };
        }
        const link = ensureMemoryClaimLinkInCurrentTransaction(db, row, projectId, {
            kind: "migration",
        });
        const observationId = createMemoryObservation(db, {
            projectId,
            memoryId: row.id,
            content: row.content,
            provenance: liveProvenance(envelope),
        });
        const revisionId = appendMemoryClaimRevision(db, {
            claimId: link.claimId,
            content: row.content,
            observationId,
            metadata: metadataFromProjectionRow(row, {
                importance:
                    input.importance !== undefined
                        ? clampImportance(input.importance)
                        : clampImportance(row.importance),
                memoryScope: input.scope ?? (row.scope || "project"),
                shareable: input.shareable ?? (row.shareable ? 1 : 0),
            }),
            sourceSessionId: row.source_session_id,
        });
        const effects: MemoryClaimEffect[] = [
            {
                effectKey: `memory:${row.id}:upsert`,
                projectId,
                claimId: link.claimId,
                effectType: "upsert" as const,
            },
            // The link above can dedup-adopt an archived canonical claim, so
            // the lifecycle re-derivation runs after the revision append and
            // any archive event lands on the new current revision.
            ...syncClaimLifecycleAfterAdoption(db, row, link, projectId, envelope.producer),
        ];
        // The projection keeps its verified columns across a classification
        // change, so the appended revision needs its own verified event —
        // without one the claim's current revision reads unverified while
        // the projection stays verified.
        if (memoryRowHasPositiveVerification(db, row)) {
            addVerificationEvent(db, {
                revisionId,
                outcome: "verified",
                verifier: envelope.producer,
            });
            effects.push({
                effectKey: `memory:${row.id}:evidence`,
                projectId,
                claimId: link.claimId,
                effectType: "evidence" as const,
            });
        }
        hitMemoryClaimFailpoint("memory-claim.010.claim.after");
        updateMemoryProjectionClassification(db, row.id, projectionUpdate, input.nowMs);
        hitMemoryClaimFailpoint("memory-claim.020.projection.after");
        return {
            result: { memoryId: row.id, claimId: link.claimId, revisionId, found: true },
            effects,
        };
    });
}

export interface SetMemoryStatusClaimInput {
    memoryId: number;
    status: MemoryStatus;
    /** Replacement metadata JSON (already merged by the caller), if any. */
    metadataJson?: string | null;
    nowMs?: number;
}

/**
 * Lifecycle transition (archive, restore, permanent): claim state change
 * plus an archive verification event when archiving, and the projection
 * status/metadata update. A pure status change appends no revision — prior
 * revisions stay untouched (R3) — but a metadata_json replacement (e.g. an
 * archive reason) appends a same-content revision so the claim history keeps
 * matching the projection metadata.
 */
export function setMemoryStatusWithClaimsInCurrentTransaction(
    db: Database,
    envelope: MemoryClaimOperationEnvelope,
    input: SetMemoryStatusClaimInput,
): MemoryClaimOperationOutcome<MemoryClaimWriteResult> {
    return runMemoryClaimOperationInCurrentTransaction(db, envelope, () => {
        const row = readMemoryProjectionRow(db, input.memoryId);
        if (!row) return { result: unlinkableResult(input.memoryId, false), effects: [] };
        const projectId = resolveMemoryClaimProjectInCurrentTransaction(db, row.project_path);
        const failure = recordMemoryClaimAdoptionFailure(db, row, projectId);
        if (failure !== null || projectId === null) {
            hitMemoryClaimFailpoint("memory-claim.010.claim.after");
            updateMemoryProjectionStatus(db, row.id, input.status, input.metadataJson, input.nowMs);
            hitMemoryClaimFailpoint("memory-claim.020.projection.after");
            return { result: unlinkableResult(row.id), effects: [] };
        }
        // The ensure below can create the claim and crosswalk rows inside
        // this operation, and a first adoption owes the outbox its upsert
        // effect: a no-op transition (unchanged status, no metadata
        // replacement) otherwise commits the fresh crosswalk with zero
        // outbox rows and the reconciliation oracle flags it forever.
        const wasLinked = readMemoryClaimLink(db, row.id) !== null;
        const link = ensureMemoryClaimLinkInCurrentTransaction(db, row, projectId, {
            kind: "migration",
        });
        const relationshipEffects = translateMemoryClaimRelationshipsInCurrentTransaction(db, row);
        const effects: MemoryClaimEffect[] = [];
        let revisionId: number | null = null;
        if (input.metadataJson !== undefined && input.metadataJson !== row.metadata_json) {
            const observationId = createMemoryObservation(db, {
                projectId,
                memoryId: row.id,
                content: row.content,
                provenance: liveProvenance(envelope),
            });
            revisionId = appendMemoryClaimRevision(db, {
                claimId: link.claimId,
                content: row.content,
                observationId,
                metadata: metadataFromProjectionRow(row, { metadataJson: input.metadataJson }),
                sourceSessionId: row.source_session_id,
            });
            effects.push({
                effectKey: `memory:${row.id}:upsert`,
                projectId,
                claimId: link.claimId,
                effectType: "upsert" as const,
            });
        }
        if (!wasLinked) {
            // The metadata branch above already emits the upsert when it
            // appends a revision; a first adoption without one still owes it.
            if (revisionId === null) {
                effects.push({
                    effectKey: `memory:${row.id}:upsert`,
                    projectId,
                    claimId: link.claimId,
                    effectType: "upsert" as const,
                });
            }
            // A verified preimage carries its verified status onto the
            // adopted claim as evidence — the fresh (or dedup-reused) claim
            // has no verified event for this row yet.
            if (memoryRowHasPositiveVerification(db, row)) {
                addVerificationEvent(db, {
                    revisionId: readClaimCurrentRevisionId(db, link.claimId),
                    outcome: "verified",
                    verifier: envelope.producer,
                });
                effects.push({
                    effectKey: `memory:${row.id}:evidence`,
                    projectId,
                    claimId: link.claimId,
                    effectType: "evidence" as const,
                });
            }
        }
        // A shared canonical claim (several crosswalk rows, one claim, via
        // the dedup branch) holds the max-rank state across its surviving
        // linked projections, so one projection's transition can neither
        // downgrade a permanent sibling nor strand a stale permanent state.
        // An unchanged state writes nothing and emits no lifecycle effect.
        // Adoption reuses this comparison as its lifecycle sync: dedup onto
        // a canonical claim archived by a prior delete re-derives the state
        // from the live row instead of leaving it archived.
        const nextState = sharedClaimStateFromLiveLinks(db, link.claimId, row.id, input.status);
        if (readCurrentClaimSemanticState(db, link.claimId).state !== nextState) {
            setClaimLifecycleStateInCurrentTransaction(db, link.claimId, nextState);
            if (nextState === "archived") {
                addVerificationEvent(db, {
                    revisionId: readClaimCurrentRevisionId(db, link.claimId),
                    outcome: "archive",
                    verifier: envelope.producer,
                });
            }
            effects.push({
                effectKey: `memory:${row.id}:lifecycle`,
                projectId,
                claimId: link.claimId,
                effectType: "lifecycle" as const,
            });
        }
        hitMemoryClaimFailpoint("memory-claim.010.claim.after");
        updateMemoryProjectionStatus(db, row.id, input.status, input.metadataJson, input.nowMs);
        hitMemoryClaimFailpoint("memory-claim.020.projection.after");
        return {
            result: {
                memoryId: row.id,
                claimId: link.claimId,
                revisionId,
                found: true,
            },
            effects: [...effects, ...relationshipEffects],
        };
    });
}

/**
 * Ordinary delete: claim retirement (archived + archive event) with the
 * crosswalk retained, then projection removal. Claim history is retained —
 * this is retention, not privacy erasure.
 */
export function deleteMemoryWithClaimsInCurrentTransaction(
    db: Database,
    envelope: MemoryClaimOperationEnvelope,
    input: { memoryId: number },
): MemoryClaimOperationOutcome<MemoryClaimWriteResult> {
    return runMemoryClaimOperationInCurrentTransaction(db, envelope, () => {
        const row = readMemoryProjectionRow(db, input.memoryId);
        if (!row) return { result: unlinkableResult(input.memoryId, false), effects: [] };
        const projectId = resolveMemoryClaimProjectInCurrentTransaction(db, row.project_path);
        const failure = recordMemoryClaimAdoptionFailure(db, row, projectId);
        if (failure !== null || projectId === null) {
            hitMemoryClaimFailpoint("memory-claim.010.claim.after");
            // The boundary guard still rejects this delete for an unlinked
            // boundary row: an unlinkable boundary member must stay until the
            // v22/doctor lane repairs its identity.
            deleteMemoryProjectionRow(db, row.id);
            hitMemoryClaimFailpoint("memory-claim.020.projection.after");
            return { result: unlinkableResult(row.id), effects: [] };
        }
        // The ensure below can create the claim and crosswalk rows inside
        // this operation, and a first adoption owes the outbox its upsert
        // effect: with a live sibling holding the claim, the retirement
        // branch below emits nothing, and the projection row is gone after
        // this delete — so no later write can ever announce the crosswalk.
        const wasLinked = readMemoryClaimLink(db, row.id) !== null;
        const link = ensureMemoryClaimLinkInCurrentTransaction(db, row, projectId, {
            kind: "migration",
        });
        const relationshipEffects = translateMemoryClaimRelationshipsInCurrentTransaction(db, row);
        const effects: MemoryClaimEffect[] = [];
        if (!wasLinked) {
            // Upsert only — no verified carry: the row leaves the corpus and
            // the claim retires (or stays with its live sibling), matching
            // the supersede kernel's source side and the module tombstone.
            effects.push({
                effectKey: `memory:${row.id}:upsert`,
                projectId,
                claimId: link.claimId,
                effectType: "upsert" as const,
            });
        }
        // A shared canonical claim retires only with its last live link;
        // deleting one projection while a sibling stays live leaves the
        // claim and its lifecycle stream untouched.
        if (!claimHasOtherLiveMemoryLink(db, link.claimId, row.id)) {
            setClaimLifecycleStateInCurrentTransaction(db, link.claimId, "archived");
            addVerificationEvent(db, {
                revisionId: readClaimCurrentRevisionId(db, link.claimId),
                outcome: "archive",
                verifier: envelope.producer,
            });
            effects.push({
                effectKey: `memory:${row.id}:lifecycle`,
                projectId,
                claimId: link.claimId,
                effectType: "lifecycle" as const,
            });
        }
        hitMemoryClaimFailpoint("memory-claim.010.claim.after");
        deleteMemoryProjectionRow(db, row.id);
        hitMemoryClaimFailpoint("memory-claim.020.projection.after");
        return {
            result: { memoryId: row.id, claimId: link.claimId, revisionId: null, found: true },
            effects: [...effects, ...relationshipEffects],
        };
    });
}

export interface SupersedeMemoryClaimResult extends MemoryClaimWriteResult {
    supersededByClaimId: number | null;
}

/**
 * Supersession: the superseding claim's current revision supersedes the
 * source's (same-project `claim_conflicts`) or, across projects, an
 * audit-only `claim_merge_lineage` row (KTD8). The source claim retires and
 * the projection records the pointer.
 */
export function supersedeMemoryWithClaimsInCurrentTransaction(
    db: Database,
    envelope: MemoryClaimOperationEnvelope,
    input: { memoryId: number; supersededByMemoryId: number; nowMs?: number },
): MemoryClaimOperationOutcome<SupersedeMemoryClaimResult> {
    return runMemoryClaimOperationInCurrentTransaction<SupersedeMemoryClaimResult>(
        db,
        envelope,
        () => {
            const row = readMemoryProjectionRow(db, input.memoryId);
            if (!row) {
                return {
                    result: {
                        ...unlinkableResult(input.memoryId, false),
                        supersededByClaimId: null,
                    },
                    effects: [],
                };
            }
            const projectId = resolveMemoryClaimProjectInCurrentTransaction(db, row.project_path);
            const failure = recordMemoryClaimAdoptionFailure(db, row, projectId);
            if (failure !== null || projectId === null) {
                hitMemoryClaimFailpoint("memory-claim.010.claim.after");
                setMemoryProjectionSuperseded(db, row.id, input.supersededByMemoryId, input.nowMs);
                hitMemoryClaimFailpoint("memory-claim.020.projection.after");
                return {
                    result: { ...unlinkableResult(row.id), supersededByClaimId: null },
                    effects: [],
                };
            }
            // The ensure calls below can create the claim and crosswalk rows
            // inside this operation, and a first adoption owes the outbox its
            // upsert effect — committing a crosswalk without one would strand
            // it unreconciled (the both-endpoints-unlinked exact-hash shape
            // otherwise commits with zero effects: the target dedup-adopts
            // onto the source's new claim, the recorder suppresses the
            // same-claim edge, and the live sibling keeps the claim active).
            const sourceWasLinked = readMemoryClaimLink(db, row.id) !== null;
            const link = ensureMemoryClaimLinkInCurrentTransaction(db, row, projectId, {
                kind: "migration",
            });
            const relationshipEffects = translateMemoryClaimRelationshipsInCurrentTransaction(
                db,
                row,
            );

            const effects: MemoryClaimEffect[] = [...relationshipEffects];
            if (!sourceWasLinked) {
                effects.push({
                    effectKey: `memory:${row.id}:upsert`,
                    projectId,
                    claimId: link.claimId,
                    effectType: "upsert" as const,
                });
            }
            let supersededByClaimId: number | null = null;
            const target = readMemoryProjectionRow(db, input.supersededByMemoryId);
            const targetProjectId = target
                ? resolveMemoryClaimProjectInCurrentTransaction(db, target.project_path)
                : null;
            if (
                target &&
                targetProjectId !== null &&
                memoryClaimAdoptionFailureReason(target, targetProjectId) === null
            ) {
                const targetWasLinked = readMemoryClaimLink(db, target.id) !== null;
                const targetLink = ensureMemoryClaimLinkInCurrentTransaction(
                    db,
                    target,
                    targetProjectId,
                    { kind: "migration" },
                );
                supersededByClaimId = targetLink.claimId;
                if (!targetWasLinked) {
                    effects.push({
                        effectKey: `memory:${target.id}:upsert`,
                        projectId: targetProjectId,
                        claimId: targetLink.claimId,
                        effectType: "upsert" as const,
                    });
                }
                // The link above can dedup-adopt a canonical claim archived
                // by a prior delete, so the target claim's state re-derives
                // from its live links; the helper no-ops when the state
                // already matches.
                effects.push(
                    ...syncClaimLifecycleAfterAdoption(
                        db,
                        target,
                        targetLink,
                        targetProjectId,
                        envelope.producer,
                    ),
                );
                if (recordMemoryClaimSupersessionInCurrentTransaction(db, link, targetLink)) {
                    effects.push({
                        effectKey: `memory:${target.id}:evidence`,
                        projectId: targetProjectId,
                        claimId: targetLink.claimId,
                        effectType: "evidence" as const,
                    });
                }
                if (!targetWasLinked && memoryRowHasPositiveVerification(db, target)) {
                    // Side-table-only verification never sets the projection
                    // columns, so the target's first adoption owes one
                    // verified event for its pre-existing verified state —
                    // the ordinary-kernel twin of the module delta's target
                    // carry. The evidence effect dedups against the
                    // supersession record above: outbox effect keys are
                    // unique per operation.
                    addVerificationEvent(db, {
                        revisionId: readClaimCurrentRevisionId(db, targetLink.claimId),
                        outcome: "verified",
                        verifier: envelope.producer,
                    });
                    const evidenceKey = `memory:${target.id}:evidence`;
                    if (!effects.some((effect) => effect.effectKey === evidenceKey)) {
                        effects.push({
                            effectKey: evidenceKey,
                            projectId: targetProjectId,
                            claimId: targetLink.claimId,
                            effectType: "evidence" as const,
                        });
                    }
                }
            }
            // A shared canonical claim retires only with its last live link;
            // the superseded projection flips to archived below, so only
            // sibling crosswalk rows count. The check runs after the target
            // adoption: an unlinked hash-equal target dedup-adopts onto this
            // same claim, and that live sibling must keep the claim active
            // (the recorder above already returns "same-claim" for the pair,
            // so no self-supersession edge exists either).
            if (!claimHasOtherLiveMemoryLink(db, link.claimId, row.id)) {
                effects.push({
                    effectKey: `memory:${row.id}:lifecycle`,
                    projectId,
                    claimId: link.claimId,
                    effectType: "lifecycle" as const,
                });
                setClaimLifecycleStateInCurrentTransaction(db, link.claimId, "archived");
            }
            hitMemoryClaimFailpoint("memory-claim.010.claim.after");
            setMemoryProjectionSuperseded(db, row.id, input.supersededByMemoryId, input.nowMs);
            const post = readMemoryProjectionRow(db, row.id);
            // Post-state snapshot only: the supersession edge is already
            // recorded above, so this translation returns no new effects — it
            // exists to satisfy the projection's lineage-write guard.
            if (post) translateMemoryClaimRelationshipsInCurrentTransaction(db, post);
            hitMemoryClaimFailpoint("memory-claim.020.projection.after");
            return {
                result: {
                    memoryId: row.id,
                    claimId: link.claimId,
                    revisionId: null,
                    found: true,
                    supersededByClaimId,
                },
                effects,
            };
        },
    );
}

export interface MergeMemoryStatsClaimInput {
    memoryId: number;
    seenCount: number;
    retrievalCount: number;
    mergedFrom: string;
    status: string;
    nowMs?: number;
}

/**
 * Merge-canonical stats/state assignment: claim lifecycle follows the new
 * status; counters stay telemetry (memory_stats). A base row without a stats
 * row aborts the transaction (the v80 one-row-per-memory invariant).
 */
export function mergeMemoryStatsWithClaimsInCurrentTransaction(
    db: Database,
    envelope: MemoryClaimOperationEnvelope,
    input: MergeMemoryStatsClaimInput,
): MemoryClaimOperationOutcome<MemoryClaimWriteResult> {
    return runMemoryClaimOperationInCurrentTransaction(db, envelope, () => {
        const row = readMemoryProjectionRow(db, input.memoryId);
        if (!row) return { result: unlinkableResult(input.memoryId, false), effects: [] };
        const applyProjection = (): void => {
            const { baseChanges, statsChanges } = updateMemoryProjectionMerge(
                db,
                row.id,
                input.mergedFrom,
                input.status,
                input.seenCount,
                input.retrievalCount,
                input.nowMs,
            );
            if (baseChanges > 0 && statsChanges === 0) {
                throw new MemoryClaimsStatsIntegrityError(row.id);
            }
        };
        const projectId = resolveMemoryClaimProjectInCurrentTransaction(db, row.project_path);
        const failure = recordMemoryClaimAdoptionFailure(db, row, projectId);
        if (failure !== null || projectId === null) {
            hitMemoryClaimFailpoint("memory-claim.010.claim.after");
            applyProjection();
            hitMemoryClaimFailpoint("memory-claim.020.projection.after");
            return { result: unlinkableResult(row.id), effects: [] };
        }
        // The ensure below can create the claim and crosswalk rows inside
        // this operation, and a first adoption owes the outbox its upsert
        // effect — an unchanged state below otherwise commits the fresh
        // crosswalk with zero effects and the reconciliation oracle flags
        // it forever.
        const wasLinked = readMemoryClaimLink(db, row.id) !== null;
        const link = ensureMemoryClaimLinkInCurrentTransaction(db, row, projectId, {
            kind: "migration",
        });
        const relationshipEffects = translateMemoryClaimRelationshipsInCurrentTransaction(db, row);
        const effects: MemoryClaimEffect[] = [];
        if (!wasLinked) {
            effects.push({
                effectKey: `memory:${row.id}:upsert`,
                projectId,
                claimId: link.claimId,
                effectType: "upsert" as const,
            });
        }
        // Shared-claim rule: the claim holds the max-rank state across its
        // surviving linked projections; an unchanged state writes nothing.
        const nextState = sharedClaimStateFromLiveLinks(db, link.claimId, row.id, input.status);
        if (readCurrentClaimSemanticState(db, link.claimId).state !== nextState) {
            setClaimLifecycleStateInCurrentTransaction(db, link.claimId, nextState);
            effects.push({
                effectKey: `memory:${row.id}:lifecycle`,
                projectId,
                claimId: link.claimId,
                effectType: "lifecycle" as const,
            });
        }
        if (!wasLinked && memoryRowHasPositiveVerification(db, row)) {
            // Side-table-only verification never sets the projection columns,
            // so the row's first adoption owes one verified event for its
            // pre-existing verified state — the merge-kernel twin of the
            // status kernel's first-adoption carry.
            addVerificationEvent(db, {
                revisionId: readClaimCurrentRevisionId(db, link.claimId),
                outcome: "verified",
                verifier: envelope.producer,
            });
            effects.push({
                effectKey: `memory:${row.id}:evidence`,
                projectId,
                claimId: link.claimId,
                effectType: "evidence" as const,
            });
        }
        hitMemoryClaimFailpoint("memory-claim.010.claim.after");
        applyProjection();
        const post = readMemoryProjectionRow(db, row.id);
        if (post) {
            relationshipEffects.push(
                ...translateMemoryClaimRelationshipsInCurrentTransaction(db, post),
            );
        }
        hitMemoryClaimFailpoint("memory-claim.020.projection.after");
        return {
            result: { memoryId: row.id, claimId: link.claimId, revisionId: null, found: true },
            effects: [...effects, ...relationshipEffects],
        };
    });
}

export interface UpdateMemoryVerificationClaimInput {
    memoryId: number;
    verificationStatus: string;
    nowMs?: number;
}

const VERIFICATION_EVENT_OUTCOMES: Record<string, VerificationOutcome> = {
    verified: "verified",
    stale: "stale",
    flagged: "flagged",
};

/**
 * Verification status change: one verification event for verified/stale/
 * flagged outcomes plus the projection verification columns. A fresh
 * `unverified` write stays the absence of events (KTD5), but an `unverified`
 * that withdraws a positive verification records 'stale'; a write that
 * transitions nothing emits no event and no evidence effect. A first
 * adoption still emits its upsert (and any lifecycle re-derivation)
 * independent of the event gate.
 */
export function updateMemoryVerificationWithClaimsInCurrentTransaction(
    db: Database,
    envelope: MemoryClaimOperationEnvelope,
    input: UpdateMemoryVerificationClaimInput,
): MemoryClaimOperationOutcome<MemoryClaimWriteResult> {
    return runMemoryClaimOperationInCurrentTransaction(db, envelope, () => {
        const row = readMemoryProjectionRow(db, input.memoryId);
        if (!row) return { result: unlinkableResult(input.memoryId, false), effects: [] };
        const projectId = resolveMemoryClaimProjectInCurrentTransaction(db, row.project_path);
        const failure = recordMemoryClaimAdoptionFailure(db, row, projectId);
        if (failure !== null || projectId === null) {
            hitMemoryClaimFailpoint("memory-claim.010.claim.after");
            updateMemoryProjectionVerification(db, row.id, input.verificationStatus, input.nowMs);
            hitMemoryClaimFailpoint("memory-claim.020.projection.after");
            return { result: unlinkableResult(row.id), effects: [] };
        }
        // A first adoption owes the outbox its upsert even when the write
        // below transitions nothing — committing a new crosswalk with zero
        // effects would strand it unreconciled.
        const wasLinked = readMemoryClaimLink(db, row.id) !== null;
        const link = ensureMemoryClaimLinkInCurrentTransaction(db, row, projectId, {
            kind: "migration",
        });
        const effects: MemoryClaimEffect[] = [];
        if (!wasLinked) {
            effects.push({
                effectKey: `memory:${row.id}:upsert`,
                projectId,
                claimId: link.claimId,
                effectType: "upsert" as const,
            });
        }
        // The link above can dedup-adopt an archived canonical claim, so the
        // claim's state re-derives from its live links; the helper no-ops
        // when the state already matches.
        effects.push(
            ...syncClaimLifecycleAfterAdoption(db, row, link, projectId, envelope.producer),
        );
        const nowMs = input.nowMs ?? Date.now();
        const outcome = VERIFICATION_EVENT_OUTCOMES[input.verificationStatus];
        // Mirror of the module path's transition guard: an event (and its
        // evidence effect) lands only for an actual transition — a status
        // flip or a re-verify that advances verified_at — so a no-op write
        // (unverified → unverified) emits nothing.
        const statusChanged = input.verificationStatus !== row.verification_status;
        const positiveAdvanced = outcome === "verified" && nowMs > (row.verified_at ?? 0);
        let eventRecorded = false;
        if (outcome && (statusChanged || positiveAdvanced)) {
            addVerificationEvent(db, {
                revisionId: readClaimCurrentRevisionId(db, link.claimId),
                outcome,
                verifier: envelope.producer,
            });
            eventRecorded = true;
        } else if (
            input.verificationStatus === "unverified" &&
            memoryRowHasPositiveVerification(db, row)
        ) {
            // 'unverified' has no event outcome of its own, but clearing a
            // positive verification withdraws evidence: the claim's current
            // revision records 'stale' instead of silently losing its
            // verified standing.
            addVerificationEvent(db, {
                revisionId: readClaimCurrentRevisionId(db, link.claimId),
                outcome: "stale",
                verifier: envelope.producer,
            });
            eventRecorded = true;
        }
        if (eventRecorded) {
            effects.push({
                effectKey: `memory:${row.id}:evidence`,
                projectId,
                claimId: link.claimId,
                effectType: "evidence" as const,
            });
        }
        hitMemoryClaimFailpoint("memory-claim.010.claim.after");
        updateMemoryProjectionVerification(db, row.id, input.verificationStatus, nowMs);
        hitMemoryClaimFailpoint("memory-claim.020.projection.after");
        return {
            result: { memoryId: row.id, claimId: link.claimId, revisionId: null, found: true },
            effects,
        };
    });
}

export interface ReplaceMemoryVerificationFilesClaimInput {
    memoryId: number;
    /** Normalized repo-relative files; empty writes the no-file sentinel. */
    files: readonly string[];
    now: number;
    /** True = content verification (event); false = mapping only (no event, KTD5). */
    verified: boolean;
}

export interface ReplaceMemoryVerificationFilesResult {
    memoryId: number;
    claimId: number | null;
    rowsWritten: number;
}

/**
 * File mapping / positive verification snapshot: replaces the
 * `memory_verifications` rows; a positive verification also appends one
 * current-snapshot verification event. A mapped-only snapshot appends no
 * event and no outbox effect (no claim-domain state change).
 */
export function replaceMemoryVerificationFilesWithClaimsInCurrentTransaction(
    db: Database,
    envelope: MemoryClaimOperationEnvelope,
    input: ReplaceMemoryVerificationFilesClaimInput,
): MemoryClaimOperationOutcome<ReplaceMemoryVerificationFilesResult> {
    return runMemoryClaimOperationInCurrentTransaction<ReplaceMemoryVerificationFilesResult>(
        db,
        envelope,
        () => {
            const row = readMemoryProjectionRow(db, input.memoryId);
            const verifiedAt = input.verified ? input.now : 0;
            if (!row) {
                const rowsWritten = replaceMemoryProjectionVerificationFiles(
                    db,
                    input.memoryId,
                    input.files,
                    verifiedAt,
                    input.now,
                );
                return {
                    result: { memoryId: input.memoryId, claimId: null, rowsWritten },
                    effects: [],
                };
            }
            const projectId = resolveMemoryClaimProjectInCurrentTransaction(db, row.project_path);
            // A mapped-only snapshot never records a failure: it performs no
            // claim mutation, so an unlinkable row is not blocked by it.
            const failure = input.verified
                ? recordMemoryClaimAdoptionFailure(db, row, projectId)
                : null;
            if (!input.verified || failure !== null || projectId === null) {
                hitMemoryClaimFailpoint("memory-claim.010.claim.after");
                const rowsWritten = replaceMemoryProjectionVerificationFiles(
                    db,
                    row.id,
                    input.files,
                    verifiedAt,
                    input.now,
                );
                hitMemoryClaimFailpoint("memory-claim.020.projection.after");
                return { result: { memoryId: row.id, claimId: null, rowsWritten }, effects: [] };
            }
            // A first adoption owes the outbox its upsert: the evidence
            // effect below only refreshes verification columns, so without
            // the upsert the adopted claim would never materialize downstream.
            const wasLinked = readMemoryClaimLink(db, row.id) !== null;
            const link = ensureMemoryClaimLinkInCurrentTransaction(db, row, projectId, {
                kind: "migration",
            });
            const effects: MemoryClaimEffect[] = [];
            if (!wasLinked) {
                effects.push({
                    effectKey: `memory:${row.id}:upsert`,
                    projectId,
                    claimId: link.claimId,
                    effectType: "upsert" as const,
                });
            }
            // The link above can dedup-adopt an archived canonical claim, so
            // the claim's state re-derives from its live links; the helper
            // no-ops when the state already matches.
            effects.push(
                ...syncClaimLifecycleAfterAdoption(db, row, link, projectId, envelope.producer),
            );
            addVerificationEvent(db, {
                revisionId: readClaimCurrentRevisionId(db, link.claimId),
                outcome: "verified",
                verifier: envelope.producer,
            });
            hitMemoryClaimFailpoint("memory-claim.010.claim.after");
            const rowsWritten = replaceMemoryProjectionVerificationFiles(
                db,
                row.id,
                input.files,
                verifiedAt,
                input.now,
            );
            hitMemoryClaimFailpoint("memory-claim.020.projection.after");
            effects.push({
                effectKey: `memory:${row.id}:evidence`,
                projectId,
                claimId: link.claimId,
                effectType: "evidence" as const,
            });
            return {
                result: { memoryId: row.id, claimId: link.claimId, rowsWritten },
                effects,
            };
        },
    );
}

// ---------------------------------------------------------------------------
// Module mirror deltas (R15, R19; U4)
// ---------------------------------------------------------------------------

export interface ModuleMemoryDeltaResult {
    memoryId: number;
    claimId: number | null;
    /** Newly appended revision id, when the delta changed semantic state. */
    revisionId: number | null;
    /** True when the projection row is gone after the delta (tombstone). */
    removed: boolean;
}

export interface CurrentClaimSemanticState {
    content: string;
    state: ClaimState;
    category: string | null;
    normalizedHash: string | null;
    importance: number | null;
    memoryScope: string | null;
    shareable: number | null;
    sourceType: string | null;
    expiresAt: number | null;
    metadataJson: string | null;
    sourceSessionId: string | null;
}

export function readCurrentClaimSemanticState(
    db: Database,
    claimId: number,
): CurrentClaimSemanticState {
    const row = db
        .prepare(
            `SELECT rev.content AS content, rev.source_session_id AS sourceSessionId,
                    claims.state AS state,
                    meta.category AS category, meta.normalized_hash AS normalizedHash,
                    meta.importance AS importance, meta.memory_scope AS memoryScope,
                    meta.shareable AS shareable, meta.source_type AS sourceType,
                    meta.expires_at AS expiresAt, meta.metadata_json AS metadataJson
               FROM claims
               JOIN claim_revisions rev ON rev.id = claims.current_revision_id
               LEFT JOIN claim_revision_memory_metadata meta ON meta.revision_id = rev.id
              WHERE claims.id = ?`,
        )
        .get(claimId) as CurrentClaimSemanticState | undefined;
    if (!row) {
        throw new ClaimGraphCorruptionError(
            `claim ${claimId} has no current revision for a module delta compare`,
        );
    }
    return row;
}

function claimSemanticStateDiffers(
    current: CurrentClaimSemanticState,
    content: string,
    desired: RevisionMemoryMetadataInput,
    sourceSessionId: string | null,
): boolean {
    return (
        current.content !== content ||
        current.category !== desired.category ||
        current.normalizedHash !== desired.normalizedHash ||
        current.importance !== desired.importance ||
        current.memoryScope !== desired.memoryScope ||
        current.shareable !== desired.shareable ||
        current.sourceType !== desired.sourceType ||
        (current.expiresAt ?? null) !== (desired.expiresAt ?? null) ||
        (current.metadataJson ?? null) !== (desired.metadataJson ?? null) ||
        // Session attribution is a semantic revision column: the projection
        // write guard covers it and appendMemoryClaimRevision persists it, so
        // a re-attribution without a content change still needs a revision.
        (current.sourceSessionId ?? null) !== (sourceSessionId ?? null)
    );
}

/**
 * Mirror of the memories_claims_boundary_delete_guard predicate (the
 * delete-side twin of storage-identity-merge's
 * rekeyTripsBoundaryIdentityGuard): true when deleting this row would abort
 * because the row is unlinked at or below the recorded claims-backfill
 * boundary.
 */
function unlinkedRowDeleteTripsBoundaryGuard(db: Database, memoryId: number): boolean {
    return Boolean(
        db
            .prepare(
                `SELECT 1 FROM memories m
                  WHERE m.id = ?
                    AND m.id <= COALESCE((SELECT CAST(value AS INTEGER) FROM schema_migrations_meta
                                           WHERE key = '${CLAIMS_BACKFILL_META_KEYS.boundaryMemoryId}'), 0)
                    AND NOT EXISTS (SELECT 1 FROM legacy_memory_claims WHERE memory_id = m.id)`,
            )
            .get(memoryId),
    );
}

/**
 * Apply one module changefeed memory delta with its claim-side effects in the
 * caller's privileged mirror-page transaction (R15). The envelope key is the
 * durable feed identity (module project + row id + feed sequence), so an
 * exact page replay returns the committed result and appends no revision,
 * outbox effect, or generation (AE7). The projection application itself runs
 * on every call — it is idempotent and must re-establish mirror identity on
 * replay-from-zero — while every claim mutation stays inside the envelope.
 *
 * Effective semantic state is compared, not feed ops: a telemetry-only
 * snapshot appends nothing (Mutation Transition Matrix last row), a
 * content/metadata change appends one revision, a status change moves claim
 * lifecycle, and a tombstone that actually removes the projection row retires
 * the claim after the unlinked preimage was adopted (R10).
 */
export function applyModuleMemoryDeltaWithClaimsInCurrentTransaction(
    db: Database,
    envelope: MemoryClaimOperationEnvelope,
    input: { memoryId: number; applyProjection: () => void },
): MemoryClaimOperationOutcome<ModuleMemoryDeltaResult> {
    // Preimage adoption runs BEFORE the projection delta (R10) so a boundary
    // row acquires its non-cascading link before a tombstone deletes it or an
    // update rewrites it — but only on a first run: a replayed envelope must
    // append zero claim rows (AE7), so the replay probe gates adoption. The
    // relationship-source snapshot still runs on replay: it is digest-
    // idempotent, no-ops without a link, and the projection's lineage-write
    // guard requires the preimage snapshot before every mutation.
    const replay = readMemoryClaimOperationResult<ModuleMemoryDeltaResult>(db, envelope);
    const pre = readMemoryProjectionRow(db, input.memoryId);
    let preLink: MemoryClaimLink | null = null;
    let preimageAdopted = false;
    let preRelationshipEffects: MemoryClaimEffect[] = [];
    if (pre && pre.content.length > 0) {
        if (replay) {
            preLink = readMemoryClaimLink(db, pre.id);
        } else {
            const preProjectId = resolveMemoryClaimProjectInCurrentTransaction(
                db,
                pre.project_path,
            );
            // Only an adoptable preimage links here; an unadoptable one (raw
            // identity or claim-invalid metadata) stays unlinked for the
            // repair lanes instead of aborting the mirror page.
            if (
                preProjectId !== null &&
                memoryClaimAdoptionFailureReason(pre, preProjectId) === null
            ) {
                // The adoption writes the link before the postimage probe
                // below reads it, so the probe must not mistake this run's
                // own adoption for a pre-existing link: a first adoption owes
                // the outbox an upsert effect even when the postimage is
                // semantically unchanged.
                const wasLinked = readMemoryClaimLink(db, pre.id) !== null;
                preLink = ensureMemoryClaimLinkInCurrentTransaction(db, pre, preProjectId, {
                    kind: "migration",
                });
                preimageAdopted = !wasLinked;
            }
        }
        if (preLink) {
            // Preimage lineage recorded here threads into the envelope
            // closure below (like preLink) so a first adoption's relationship
            // effects reach the outbox and bump the touched generations.
            const translated = translateMemoryClaimRelationshipsInCurrentTransaction(db, pre);
            if (!replay) preRelationshipEffects = translated;
        }
    }

    // A projection delete of an unlinked boundary row aborts on the
    // memories_claims_boundary_delete_guard. When the preimage stayed
    // unlinked (unadoptable), a module tombstone trips it and the RAISE
    // would roll back the whole mirror page, pinning the feed cursor on
    // this delta. The abort is statement-scoped — the page transaction
    // survives — so the kernel catches exactly that shape, records the
    // blocking repair diagnostic, and retains the projection row for the
    // repair lanes. The envelope stays uncommitted: the retained run
    // performs zero claim mutations, and a committed result would replay
    // as final — skipping claim retirement even after the repair lanes
    // link the row and a redelivered delete succeeds. Like the
    // pending-pair unadoptable path, no claim write happens outside an
    // envelope, and a later delivery of the same feed identity re-attempts
    // the tombstone whole.
    if (pre && !preLink && unlinkedRowDeleteTripsBoundaryGuard(db, pre.id)) {
        try {
            input.applyProjection();
        } catch (error) {
            if (
                !(
                    error instanceof Error &&
                    error.message.includes("claim crosswalk link before delete")
                )
            ) {
                throw error;
            }
            recordMemoryClaimAdoptionFailure(
                db,
                pre,
                resolveMemoryClaimProjectInCurrentTransaction(db, pre.project_path),
            );
            return {
                result: {
                    memoryId: input.memoryId,
                    claimId: null,
                    revisionId: null,
                    removed: false,
                },
                replayed: false,
            };
        }
    } else {
        input.applyProjection();
    }
    hitMemoryClaimFailpoint("memory-claim.020.projection.after");

    return runMemoryClaimOperationInCurrentTransaction<ModuleMemoryDeltaResult>(
        db,
        envelope,
        () => {
            const post = readMemoryProjectionRow(db, input.memoryId);
            const effects: MemoryClaimEffect[] = [...preRelationshipEffects];
            if (!post) {
                // Tombstone removed the projection row; the crosswalk is
                // retained (retention, not erasure). Shared-claim rule: the
                // claim holds the max-rank state across its surviving linked
                // projections, so a live sibling link keeps the claim
                // untouched and only the last link retires it — with the
                // archive event reserved for an actual archive transition.
                if (preLink) {
                    // The preimage adoption above committed the claim and
                    // crosswalk rows, and the projection row is gone — no
                    // later write can announce them — so a first adoption
                    // owes the outbox its upsert even when the shared-claim
                    // rule below transitions nothing. Upsert only, no
                    // verified carry: the delete-kernel twin of this branch.
                    if (preimageAdopted) {
                        effects.push({
                            effectKey: `memory:${input.memoryId}:upsert`,
                            projectId: preLink.projectId,
                            claimId: preLink.claimId,
                            effectType: "upsert" as const,
                        });
                    }
                    const desiredState = sharedClaimStateFromLiveLinks(
                        db,
                        preLink.claimId,
                        input.memoryId,
                        "archived",
                    );
                    if (readCurrentClaimSemanticState(db, preLink.claimId).state !== desiredState) {
                        setClaimLifecycleStateInCurrentTransaction(
                            db,
                            preLink.claimId,
                            desiredState,
                        );
                        if (desiredState === "archived") {
                            addVerificationEvent(db, {
                                revisionId: readClaimCurrentRevisionId(db, preLink.claimId),
                                outcome: "archive",
                                verifier: envelope.producer,
                            });
                        }
                        effects.push({
                            effectKey: `memory:${input.memoryId}:lifecycle`,
                            projectId: preLink.projectId,
                            claimId: preLink.claimId,
                            effectType: "lifecycle" as const,
                        });
                    }
                }
                hitMemoryClaimFailpoint("memory-claim.010.claim.after");
                return {
                    result: {
                        memoryId: input.memoryId,
                        claimId: preLink?.claimId ?? null,
                        revisionId: null,
                        removed: true,
                    },
                    effects,
                };
            }

            const projectId = resolveMemoryClaimProjectInCurrentTransaction(db, post.project_path);
            const failure = recordMemoryClaimAdoptionFailure(db, post, projectId);
            if (failure !== null || projectId === null) {
                // The preimage adoption above already committed claim,
                // crosswalk, and relationship rows, so a first adoption still
                // owes the outbox its upsert effect — dropping it would leave
                // the crosswalk row without an outbox effect forever.
                if (preimageAdopted && preLink) {
                    effects.push({
                        effectKey: `memory:${post.id}:upsert`,
                        projectId: preLink.projectId,
                        claimId: preLink.claimId,
                        effectType: "upsert" as const,
                    });
                }
                hitMemoryClaimFailpoint("memory-claim.010.claim.after");
                return {
                    result: {
                        memoryId: post.id,
                        claimId: preLink?.claimId ?? null,
                        revisionId: null,
                        removed: false,
                    },
                    effects,
                };
            }

            const previouslyLinked = !preimageAdopted && readMemoryClaimLink(db, post.id) !== null;
            const link = ensureMemoryClaimLinkInCurrentTransaction(db, post, projectId, {
                kind: "live",
                producer: envelope.producer,
                operationKey: envelope.operationKey,
                sourceSessionId: post.source_session_id,
            });

            effects.push(...translateMemoryClaimRelationshipsInCurrentTransaction(db, post));
            const current = readCurrentClaimSemanticState(db, link.claimId);
            const desiredMeta = metadataFromProjectionRow(post);
            let revisionId: number | null = null;
            if (
                claimSemanticStateDiffers(
                    current,
                    post.content,
                    desiredMeta,
                    post.source_session_id,
                )
            ) {
                const observationId = createMemoryObservation(db, {
                    projectId,
                    memoryId: post.id,
                    content: post.content,
                    provenance: liveProvenance(envelope, post.source_session_id),
                });
                revisionId = appendMemoryClaimRevision(db, {
                    claimId: link.claimId,
                    content: post.content,
                    observationId,
                    metadata: desiredMeta,
                    sourceSessionId: post.source_session_id,
                });
                effects.push({
                    effectKey: `memory:${post.id}:upsert`,
                    projectId,
                    claimId: link.claimId,
                    effectType: "upsert" as const,
                });
            } else if (!previouslyLinked) {
                // A fresh module insert: adoption above created revision 1.
                effects.push({
                    effectKey: `memory:${post.id}:upsert`,
                    projectId,
                    claimId: link.claimId,
                    effectType: "upsert" as const,
                });
            }

            // Shared-claim rule: the claim holds the max-rank state across
            // its surviving linked projections, so a delta on one projection
            // cannot downgrade a permanent sibling.
            const desiredState = sharedClaimStateFromLiveLinks(
                db,
                link.claimId,
                post.id,
                post.status,
            );
            if (current.state !== desiredState) {
                setClaimLifecycleStateInCurrentTransaction(db, link.claimId, desiredState);
                if (desiredState === "archived") {
                    addVerificationEvent(db, {
                        revisionId: readClaimCurrentRevisionId(db, link.claimId),
                        outcome: "archive",
                        verifier: envelope.producer,
                    });
                }
                effects.push({
                    effectKey: `memory:${post.id}:lifecycle`,
                    projectId,
                    claimId: link.claimId,
                    effectType: "lifecycle" as const,
                });
            }

            const outcome = VERIFICATION_EVENT_OUTCOMES[post.verification_status];
            const statusChanged = post.verification_status !== (pre?.verification_status ?? null);
            // A verified row can re-verify (verified_at advances) or gain a
            // content revision without a status flip; both leave the current
            // revision with no evidence unless an event lands here. The block
            // runs after the revision append, so the event attaches to the
            // new current revision. The single guard fires at most one event
            // per delta, so an overlapping status change cannot double-emit.
            const positiveAdvanced =
                outcome === "verified" && (post.verified_at ?? 0) > (pre?.verified_at ?? 0);
            const positiveRevision = outcome === "verified" && revisionId !== null;
            if (outcome && (statusChanged || positiveAdvanced || positiveRevision)) {
                addVerificationEvent(db, {
                    revisionId: readClaimCurrentRevisionId(db, link.claimId),
                    outcome,
                    verifier: envelope.producer,
                });
                effects.push({
                    effectKey: `memory:${post.id}:evidence`,
                    projectId,
                    claimId: link.claimId,
                    effectType: "evidence" as const,
                });
            } else if (
                statusChanged &&
                post.verification_status === "unverified" &&
                pre &&
                memoryRowHasPositiveVerification(db, pre)
            ) {
                // 'unverified' has no event outcome of its own, but a delta
                // that withdraws a positive verification records 'stale'
                // instead of silently losing the claim's verified standing —
                // the module-path twin of the direct verification writer's
                // withdrawal branch. The PRE row carries the positive state;
                // the postimage already reads unverified.
                addVerificationEvent(db, {
                    revisionId: readClaimCurrentRevisionId(db, link.claimId),
                    outcome: "stale",
                    verifier: envelope.producer,
                });
                effects.push({
                    effectKey: `memory:${post.id}:evidence`,
                    projectId,
                    claimId: link.claimId,
                    effectType: "evidence" as const,
                });
            } else if (preimageAdopted && memoryRowHasPositiveVerification(db, post)) {
                // Side-table-only verification never sets the projection
                // columns, so the gate above sees no change on a first
                // adoption; the adopted claim still owes one verified event
                // for the row's pre-existing verified state. The else-if
                // keeps the delta at one event.
                addVerificationEvent(db, {
                    revisionId: readClaimCurrentRevisionId(db, link.claimId),
                    outcome: "verified",
                    verifier: envelope.producer,
                });
                effects.push({
                    effectKey: `memory:${post.id}:evidence`,
                    projectId,
                    claimId: link.claimId,
                    effectType: "evidence" as const,
                });
            }

            const supersededBy = post.superseded_by_memory_id;
            if (supersededBy !== null && supersededBy !== (pre?.superseded_by_memory_id ?? null)) {
                const target = readMemoryProjectionRow(db, supersededBy);
                const targetProjectId = target
                    ? resolveMemoryClaimProjectInCurrentTransaction(db, target.project_path)
                    : null;
                if (
                    target &&
                    targetProjectId !== null &&
                    memoryClaimAdoptionFailureReason(target, targetProjectId) === null
                ) {
                    // Like the preimage probe above, the adoption below must
                    // not be mistaken for a pre-existing link: a first
                    // adoption owes the target's claim its verified carry.
                    const targetWasLinked = readMemoryClaimLink(db, target.id) !== null;
                    const targetLink = ensureMemoryClaimLinkInCurrentTransaction(
                        db,
                        target,
                        targetProjectId,
                        { kind: "migration" },
                    );
                    // The link above can dedup-adopt a canonical claim
                    // archived by a prior delete, so the target claim's state
                    // re-derives from its live links; the helper no-ops when
                    // the state already matches, so a pre-linked target with
                    // a healthy claim emits nothing here.
                    effects.push(
                        ...syncClaimLifecycleAfterAdoption(
                            db,
                            target,
                            targetLink,
                            targetProjectId,
                            envelope.producer,
                        ),
                    );
                    if (recordMemoryClaimSupersessionInCurrentTransaction(db, link, targetLink)) {
                        effects.push({
                            effectKey: `memory:${target.id}:supersede`,
                            projectId: targetProjectId,
                            claimId: targetLink.claimId,
                            effectType: "evidence" as const,
                        });
                    }
                    if (!targetWasLinked && memoryRowHasPositiveVerification(db, target)) {
                        // Side-table-only verification never sets the
                        // projection columns, so the target's first adoption
                        // owes one verified event for its pre-existing
                        // verified state — the target-side twin of the
                        // preimage carry above.
                        addVerificationEvent(db, {
                            revisionId: readClaimCurrentRevisionId(db, targetLink.claimId),
                            outcome: "verified",
                            verifier: envelope.producer,
                        });
                        effects.push({
                            effectKey: `memory:${target.id}:evidence`,
                            projectId: targetProjectId,
                            claimId: targetLink.claimId,
                            effectType: "evidence" as const,
                        });
                    }
                }
            }

            hitMemoryClaimFailpoint("memory-claim.010.claim.after");
            return {
                result: { memoryId: post.id, claimId: link.claimId, revisionId, removed: false },
                effects,
            };
        },
    );
}

// ---------------------------------------------------------------------------
// Independent current-claim reads (R17) and corruption reporting
// ---------------------------------------------------------------------------

export interface CurrentMemoryClaim {
    memoryId: number;
    canonicalMemoryId: number;
    claimId: number;
    projectId: number;
    state: ClaimState;
    revisionId: number;
    revision: number;
    content: string;
    contentSha256: string;
    category: string;
    normalizedHash: string;
    importance: number;
    memoryScope: string;
    shareable: number;
    sourceType: string;
    expiresAt: number | null;
    metadataJson: string | null;
}

const CURRENT_MEMORY_CLAIM_SELECT = `
    SELECT lmc.memory_id AS memoryId, lmc.canonical_memory_id AS canonicalMemoryId,
           lmc.claim_id AS claimId, lmc.project_id AS projectId, claims.state AS state,
           rev.id AS revisionId, rev.revision AS revision, rev.content AS content,
           rev.content_sha256 AS contentSha256,
           meta.category AS category, meta.normalized_hash AS normalizedHash,
           meta.importance AS importance, meta.memory_scope AS memoryScope,
           meta.shareable AS shareable, meta.source_type AS sourceType,
           meta.expires_at AS expiresAt, meta.metadata_json AS metadataJson
      FROM legacy_memory_claims lmc
      JOIN claims ON claims.id = lmc.claim_id
      JOIN claim_revisions rev ON rev.id = claims.current_revision_id
      LEFT JOIN claim_revision_memory_metadata meta ON meta.revision_id = rev.id`;

function assertCurrentMemoryClaimShape(record: CurrentMemoryClaim): CurrentMemoryClaim {
    if (record.category === null || record.category === undefined) {
        throw new ClaimGraphCorruptionError(
            `claim ${record.claimId} current revision ${record.revisionId} has no memory metadata row; direct-SQL corruption`,
        );
    }
    return record;
}

export function getCurrentMemoryClaimByLegacyMemoryId(
    db: Database,
    memoryId: number,
): CurrentMemoryClaim | null {
    const row = db
        .prepare(`${CURRENT_MEMORY_CLAIM_SELECT} WHERE lmc.memory_id = ?`)
        .get(memoryId) as CurrentMemoryClaim | undefined;
    return row ? assertCurrentMemoryClaimShape(row) : null;
}

export function listCurrentMemoryClaimsByProject(
    db: Database,
    projectId: number,
): CurrentMemoryClaim[] {
    const rows = db
        .prepare(`${CURRENT_MEMORY_CLAIM_SELECT} WHERE lmc.project_id = ? ORDER BY lmc.memory_id`)
        .all(projectId) as CurrentMemoryClaim[];
    return rows.map(assertCurrentMemoryClaimShape);
}

/**
 * Supported writers never commit these shapes; only direct SQL can. The v84
 * sibling of `findClaimGraphCorruption`: a memory-linked claim revision
 * without its metadata row, or a crosswalk whose canonical resolution or
 * project ownership is inconsistent.
 */
export interface MemoryClaimsCompatCorruptionReport {
    revisionIdsMissingMemoryMetadata: number[];
    invalidCrosswalkMemoryIds: number[];
}

export function findMemoryClaimsCompatCorruption(db: Database): MemoryClaimsCompatCorruptionReport {
    const missingMetadata = db
        .prepare(
            `SELECT DISTINCT rev.id AS id
               FROM legacy_memory_claims lmc
               JOIN claim_revisions rev ON rev.claim_id = lmc.claim_id
              WHERE NOT EXISTS (
                  SELECT 1 FROM claim_revision_memory_metadata meta WHERE meta.revision_id = rev.id
              )
              ORDER BY id`,
        )
        .all() as Array<{ id: number }>;
    const invalidCrosswalks = db
        .prepare(
            `SELECT lmc.memory_id AS id
               FROM legacy_memory_claims lmc
               LEFT JOIN legacy_memory_claims canon ON canon.memory_id = lmc.canonical_memory_id
               LEFT JOIN claims ON claims.id = lmc.claim_id
              WHERE canon.memory_id IS NULL
                 OR canon.canonical_memory_id <> canon.memory_id
                 OR canon.claim_id <> lmc.claim_id
                 OR canon.project_id <> lmc.project_id
                 OR claims.project_id IS NOT lmc.project_id
              ORDER BY id`,
        )
        .all() as Array<{ id: number }>;
    return {
        revisionIdsMissingMemoryMetadata: missingMetadata.map((row) => row.id),
        invalidCrosswalkMemoryIds: invalidCrosswalks.map((row) => row.id),
    };
}
