/**
 * Transaction-local memory/claims kernel (KTD1, KTD3, KTD6-KTD8): every v83
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
 * pre-v22 path) or whose content is empty cannot form a claim. Those writes
 * apply the projection under the capability and record a blocking
 * `claim_backfill_failures` row instead of silently inventing claim state;
 * the v22 takeover (U4) and doctor retry (U5) own the repair.
 */

import type { Database } from "../../../shared/sqlite";
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

const compatSchemaCache = new WeakMap<Database, true>();

/**
 * Whether this database migrated to v83. A negative probe is never cached:
 * a sibling process can migrate the shared file after this handle opened.
 */
export function hasMemoryClaimsCompatSchema(db: Database): boolean {
    if (compatSchemaCache.get(db)) return true;
    const present = Boolean(
        db
            .prepare(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'claim_compatibility_write_state'",
            )
            .get(),
    );
    if (present) compatSchemaCache.set(db, true);
    return present;
}

const capabilityDepth = new WeakMap<Database, number>();

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
            const value = withClaimsWriteCapabilityInCurrentTransaction(db, fn);
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
    const existing = db
        .prepare(
            "SELECT request_digest AS requestDigest, result_json AS resultJson FROM claim_operations WHERE producer = ? AND operation_key = ?",
        )
        .get(envelope.producer, envelope.operationKey) as
        | { requestDigest: string; resultJson: string }
        | undefined;
    if (existing) {
        if (existing.requestDigest !== envelope.requestDigest) {
            throw new ClaimOperationKeyReuseError(envelope.producer, envelope.operationKey);
        }
        let stored: T;
        try {
            stored = JSON.parse(existing.resultJson) as T;
        } catch (error) {
            throw new ClaimGraphCorruptionError(
                `claim operation ${envelope.producer}/${envelope.operationKey} stored an unparseable result: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        return { result: stored, replayed: true };
    }

    const { result, effects } = work();
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

    const generationByProject = new Map<number, number>();
    const projectHasGenerationRow = new Map<number, boolean>();
    for (const effect of effects) {
        if (generationByProject.has(effect.projectId)) continue;
        const row = db
            .prepare("SELECT generation FROM claim_project_generations WHERE project_id = ?")
            .get(effect.projectId) as { generation: number } | null | undefined;
        projectHasGenerationRow.set(effect.projectId, row != null);
        generationByProject.set(effect.projectId, (row?.generation ?? 0) + 1);
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
            generationByProject.get(effect.projectId) as number,
            now,
        );
    }
    hitMemoryClaimFailpoint("memory-claim.030.outbox.after");

    for (const [projectId, generation] of generationByProject) {
        // UPDATE-then-INSERT instead of an upsert: the append-only collision
        // trigger fires on every INSERT, including ON CONFLICT resolution.
        // The branch uses the transaction-local read above, not the reported
        // change count, which bun:sqlite may widen to a total-changes delta.
        if (projectHasGenerationRow.get(projectId)) {
            db.prepare(
                "UPDATE claim_project_generations SET generation = ?, updated_at = ? WHERE project_id = ?",
            ).run(generation, now, projectId);
        } else {
            db.prepare(
                "INSERT INTO claim_project_generations (project_id, generation, updated_at) VALUES (?, ?, ?)",
            ).run(projectId, generation, now);
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

export type MemoryClaimLinkFailureReason = "unresolved-project-identity" | "empty-content";

export class MemoryClaimsStatsIntegrityError extends Error {
    readonly memoryId: number;

    constructor(memoryId: number) {
        super(`memory_stats row missing for memory ${memoryId} during a claims merge write`);
        this.name = "MemoryClaimsStatsIntegrityError";
        this.memoryId = memoryId;
    }
}

/**
 * Resolve a legacy `project_path` to the numeric claims project. A canonical
 * identity registers on demand; a raw path that never rekeyed stays
 * unresolved (null) and belongs to the v22 repair lane.
 */
export function resolveMemoryClaimProjectInCurrentTransaction(
    db: Database,
    projectPath: string,
): number | null {
    const existing = resolveProjectId(db, projectPath);
    if (existing !== null) return existing;
    if (
        (projectPath.startsWith("git:") || projectPath.startsWith("dir:")) &&
        projectPath.length > "git:".length
    ) {
        return ensureProjectInCurrentTransaction(db, projectPath);
    }
    return null;
}

function recordMemoryClaimLinkFailure(
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
        memoryScope: row.scope || "project",
        shareable: row.shareable ? 1 : 0,
        sourceType: row.source_type || "historian",
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

function claimStateFromMemoryStatus(status: string): ClaimState {
    return status === "permanent" || status === "archived" ? status : "active";
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
     * When false, a hash-equal preimage whose bytes differ from the canonical
     * content links WITHOUT appending a revision (the source bytes stay
     * retained on the root observation). Merge-delete relocations use this so
     * the canonical claim keeps reflecting the surviving projection row (R6).
     */
    adoptDivergentContent?: boolean;
}

/**
 * Ensure the memory row has its durable claim link, adopting the preimage as
 * revision 1 when unlinked (R10). Exact-hash dedup selects the existing
 * canonical claim for the (project, category, normalized hash) tuple before
 * allocating a new one (KTD3, R6); a hash-equal preimage whose bytes differ
 * from the canonical content appends a revision so the claim reflects it.
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

    const now = Date.now();
    const canonical = findCanonicalLinkByHash(db, projectId, row.category, row.normalized_hash);
    if (canonical && canonical.canonicalMemoryId !== row.id) {
        const observationId = createMemoryObservation(db, {
            projectId,
            memoryId: row.id,
            content: row.content,
            provenance,
        });
        if ((options.adoptDivergentContent ?? true) && canonical.currentContent !== row.content) {
            appendMemoryClaimRevision(db, {
                claimId: canonical.claimId,
                content: row.content,
                observationId,
                metadata: metadataFromProjectionRow(row),
                sourceSessionId: row.source_session_id,
            });
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
    return {
        memoryId: row.id,
        canonicalMemoryId: row.id,
        claimId: created.claimId,
        projectId,
        rootObservationId: observationId,
    };
}

/**
 * Record one supersession edge between two linked memories' current
 * revisions: same-project pairs use `claim_conflicts` (supersedes), distinct
 * projects use the audit-only `claim_merge_lineage` relation (KTD8). Both
 * paths are idempotent, so page replay or a doctor retry cannot duplicate
 * lineage. Returns true only when a new edge was recorded.
 */
export function recordMemoryClaimSupersessionInCurrentTransaction(
    db: Database,
    source: MemoryClaimLink,
    target: MemoryClaimLink,
): boolean {
    // A duplicate link shares its canonical claim; a claim cannot supersede
    // itself.
    if (source.claimId === target.claimId) return false;
    const sourceRevisionId = readClaimCurrentRevisionId(db, source.claimId);
    const targetRevisionId = readClaimCurrentRevisionId(db, target.claimId);
    if (source.projectId === target.projectId) {
        const existing = db
            .prepare(
                "SELECT 1 FROM claim_conflicts WHERE relation = 'supersedes' AND left_revision_id = ? AND right_revision_id = ?",
            )
            .get(targetRevisionId, sourceRevisionId);
        if (existing) return false;
        addClaimConflictInCurrentTransaction(db, {
            relation: "supersedes",
            leftRevisionId: targetRevisionId,
            rightRevisionId: sourceRevisionId,
        });
        return true;
    }
    const existing = db
        .prepare(
            "SELECT 1 FROM claim_merge_lineage WHERE source_revision_id = ? AND target_revision_id = ?",
        )
        .get(sourceRevisionId, targetRevisionId);
    if (existing) return false;
    db.prepare(
        `INSERT INTO claim_merge_lineage
            (source_revision_id, source_project_id, target_revision_id, target_project_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
    ).run(sourceRevisionId, source.projectId, targetRevisionId, target.projectId, Date.now());
    return true;
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

function requireProjectionRow(db: Database, memoryId: number): MemoryProjectionRow | null {
    return readMemoryProjectionRow(db, memoryId);
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
        if (projectId === null || input.content.length === 0) {
            recordMemoryClaimLinkFailure(
                db,
                memoryId,
                input.projectPath,
                projectId === null ? "unresolved-project-identity" : "empty-content",
            );
            hitMemoryClaimFailpoint("memory-claim.010.claim.after");
            hitMemoryClaimFailpoint("memory-claim.020.projection.after");
            return { result: unlinkableResult(memoryId), effects: [] };
        }
        const row = requireProjectionRow(db, memoryId) as MemoryProjectionRow;
        const link = ensureMemoryClaimLinkInCurrentTransaction(
            db,
            row,
            projectId,
            liveProvenance(envelope, input.sourceSessionId),
        );
        // Re-adding content whose canonical claim was archived by a delete
        // reactivates the claim alongside the fresh projection row.
        setClaimLifecycleStateInCurrentTransaction(db, link.claimId, "active");
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
            ],
        };
    });
}

export interface UpdateMemoryContentClaimInput {
    memoryId: number;
    content: string;
    normalizedHash: string;
    sourceSessionId?: string | null;
    nowMs?: number;
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
        const row = requireProjectionRow(db, input.memoryId);
        if (!row) return { result: unlinkableResult(input.memoryId, false), effects: [] };
        const projectId = resolveMemoryClaimProjectInCurrentTransaction(db, row.project_path);
        if (projectId === null || row.content.length === 0 || input.content.length === 0) {
            recordMemoryClaimLinkFailure(
                db,
                row.id,
                row.project_path,
                projectId === null ? "unresolved-project-identity" : "empty-content",
            );
            hitMemoryClaimFailpoint("memory-claim.010.claim.after");
            updateMemoryProjectionContent(
                db,
                row.id,
                input.content,
                input.normalizedHash,
                input.nowMs,
            );
            hitMemoryClaimFailpoint("memory-claim.020.projection.after");
            return { result: unlinkableResult(row.id), effects: [] };
        }
        const link = ensureMemoryClaimLinkInCurrentTransaction(db, row, projectId, {
            kind: "migration",
        });
        const observationId = createMemoryObservation(db, {
            projectId,
            memoryId: row.id,
            content: input.content,
            provenance: liveProvenance(envelope, input.sourceSessionId),
        });
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
            sourceSessionId: input.sourceSessionId ?? null,
        });
        hitMemoryClaimFailpoint("memory-claim.010.claim.after");
        updateMemoryProjectionContent(db, row.id, input.content, input.normalizedHash, input.nowMs);
        hitMemoryClaimFailpoint("memory-claim.020.projection.after");
        return {
            result: { memoryId: row.id, claimId: link.claimId, revisionId, found: true },
            effects: [
                {
                    effectKey: `memory:${row.id}:upsert`,
                    projectId,
                    claimId: link.claimId,
                    effectType: "upsert" as const,
                },
            ],
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
        const row = requireProjectionRow(db, input.memoryId);
        if (!row) return { result: unlinkableResult(input.memoryId, false), effects: [] };
        const projectId = resolveMemoryClaimProjectInCurrentTransaction(db, row.project_path);
        const projectionUpdate = {
            importance: input.importance,
            scope: input.scope,
            shareable: input.shareable,
        };
        if (projectId === null || row.content.length === 0) {
            recordMemoryClaimLinkFailure(
                db,
                row.id,
                row.project_path,
                projectId === null ? "unresolved-project-identity" : "empty-content",
            );
            hitMemoryClaimFailpoint("memory-claim.010.claim.after");
            updateMemoryProjectionClassification(db, row.id, projectionUpdate, input.nowMs);
            hitMemoryClaimFailpoint("memory-claim.020.projection.after");
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
        hitMemoryClaimFailpoint("memory-claim.010.claim.after");
        updateMemoryProjectionClassification(db, row.id, projectionUpdate, input.nowMs);
        hitMemoryClaimFailpoint("memory-claim.020.projection.after");
        return {
            result: { memoryId: row.id, claimId: link.claimId, revisionId, found: true },
            effects: [
                {
                    effectKey: `memory:${row.id}:upsert`,
                    projectId,
                    claimId: link.claimId,
                    effectType: "upsert" as const,
                },
            ],
        };
    });
}

export interface SetMemoryStatusClaimInput {
    memoryId: number;
    status: string;
    /** Replacement metadata JSON (already merged by the caller), if any. */
    metadataJson?: string | null;
    nowMs?: number;
}

/**
 * Lifecycle transition (archive, restore, permanent): claim state change
 * plus an archive verification event when archiving, and the projection
 * status/metadata update. No revision — prior revisions stay untouched (R3).
 */
export function setMemoryStatusWithClaimsInCurrentTransaction(
    db: Database,
    envelope: MemoryClaimOperationEnvelope,
    input: SetMemoryStatusClaimInput,
): MemoryClaimOperationOutcome<MemoryClaimWriteResult> {
    return runMemoryClaimOperationInCurrentTransaction(db, envelope, () => {
        const row = requireProjectionRow(db, input.memoryId);
        if (!row) return { result: unlinkableResult(input.memoryId, false), effects: [] };
        const projectId = resolveMemoryClaimProjectInCurrentTransaction(db, row.project_path);
        if (projectId === null || row.content.length === 0) {
            recordMemoryClaimLinkFailure(
                db,
                row.id,
                row.project_path,
                projectId === null ? "unresolved-project-identity" : "empty-content",
            );
            hitMemoryClaimFailpoint("memory-claim.010.claim.after");
            updateMemoryProjectionStatus(db, row.id, input.status, input.metadataJson, input.nowMs);
            hitMemoryClaimFailpoint("memory-claim.020.projection.after");
            return { result: unlinkableResult(row.id), effects: [] };
        }
        const link = ensureMemoryClaimLinkInCurrentTransaction(db, row, projectId, {
            kind: "migration",
        });
        setClaimLifecycleStateInCurrentTransaction(
            db,
            link.claimId,
            claimStateFromMemoryStatus(input.status),
        );
        if (input.status === "archived") {
            addVerificationEvent(db, {
                revisionId: readClaimCurrentRevisionId(db, link.claimId),
                outcome: "archive",
                verifier: envelope.producer,
            });
        }
        hitMemoryClaimFailpoint("memory-claim.010.claim.after");
        updateMemoryProjectionStatus(db, row.id, input.status, input.metadataJson, input.nowMs);
        hitMemoryClaimFailpoint("memory-claim.020.projection.after");
        return {
            result: {
                memoryId: row.id,
                claimId: link.claimId,
                revisionId: null,
                found: true,
            },
            effects: [
                {
                    effectKey: `memory:${row.id}:lifecycle`,
                    projectId,
                    claimId: link.claimId,
                    effectType: "lifecycle" as const,
                },
            ],
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
        const row = requireProjectionRow(db, input.memoryId);
        if (!row) return { result: unlinkableResult(input.memoryId, false), effects: [] };
        const projectId = resolveMemoryClaimProjectInCurrentTransaction(db, row.project_path);
        if (projectId === null || row.content.length === 0) {
            recordMemoryClaimLinkFailure(
                db,
                row.id,
                row.project_path,
                projectId === null ? "unresolved-project-identity" : "empty-content",
            );
            hitMemoryClaimFailpoint("memory-claim.010.claim.after");
            // The boundary guard still rejects this delete for an unlinked
            // boundary row: an unlinkable boundary member must stay until the
            // v22/doctor lane repairs its identity.
            deleteMemoryProjectionRow(db, row.id);
            hitMemoryClaimFailpoint("memory-claim.020.projection.after");
            return { result: unlinkableResult(row.id), effects: [] };
        }
        const link = ensureMemoryClaimLinkInCurrentTransaction(db, row, projectId, {
            kind: "migration",
        });
        setClaimLifecycleStateInCurrentTransaction(db, link.claimId, "archived");
        addVerificationEvent(db, {
            revisionId: readClaimCurrentRevisionId(db, link.claimId),
            outcome: "archive",
            verifier: envelope.producer,
        });
        hitMemoryClaimFailpoint("memory-claim.010.claim.after");
        deleteMemoryProjectionRow(db, row.id);
        hitMemoryClaimFailpoint("memory-claim.020.projection.after");
        return {
            result: { memoryId: row.id, claimId: link.claimId, revisionId: null, found: true },
            effects: [
                {
                    effectKey: `memory:${row.id}:lifecycle`,
                    projectId,
                    claimId: link.claimId,
                    effectType: "lifecycle" as const,
                },
            ],
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
            const row = requireProjectionRow(db, input.memoryId);
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
            if (projectId === null || row.content.length === 0) {
                recordMemoryClaimLinkFailure(
                    db,
                    row.id,
                    row.project_path,
                    projectId === null ? "unresolved-project-identity" : "empty-content",
                );
                hitMemoryClaimFailpoint("memory-claim.010.claim.after");
                setMemoryProjectionSuperseded(db, row.id, input.supersededByMemoryId, input.nowMs);
                hitMemoryClaimFailpoint("memory-claim.020.projection.after");
                return {
                    result: { ...unlinkableResult(row.id), supersededByClaimId: null },
                    effects: [],
                };
            }
            const link = ensureMemoryClaimLinkInCurrentTransaction(db, row, projectId, {
                kind: "migration",
            });
            const sourceRevisionId = readClaimCurrentRevisionId(db, link.claimId);

            const effects: MemoryClaimEffect[] = [
                {
                    effectKey: `memory:${row.id}:lifecycle`,
                    projectId,
                    claimId: link.claimId,
                    effectType: "lifecycle" as const,
                },
            ];
            let supersededByClaimId: number | null = null;
            const target = requireProjectionRow(db, input.supersededByMemoryId);
            const targetProjectId = target
                ? resolveMemoryClaimProjectInCurrentTransaction(db, target.project_path)
                : null;
            if (target && targetProjectId !== null && target.content.length > 0) {
                const targetLink = ensureMemoryClaimLinkInCurrentTransaction(
                    db,
                    target,
                    targetProjectId,
                    { kind: "migration" },
                );
                const targetRevisionId = readClaimCurrentRevisionId(db, targetLink.claimId);
                supersededByClaimId = targetLink.claimId;
                if (targetProjectId === projectId) {
                    addClaimConflictInCurrentTransaction(db, {
                        relation: "supersedes",
                        leftRevisionId: targetRevisionId,
                        rightRevisionId: sourceRevisionId,
                    });
                } else {
                    db.prepare(
                        `INSERT INTO claim_merge_lineage
                        (source_revision_id, source_project_id, target_revision_id, target_project_id, created_at)
                     VALUES (?, ?, ?, ?, ?)`,
                    ).run(
                        sourceRevisionId,
                        projectId,
                        targetRevisionId,
                        targetProjectId,
                        Date.now(),
                    );
                }
                effects.push({
                    effectKey: `memory:${target.id}:evidence`,
                    projectId: targetProjectId,
                    claimId: targetLink.claimId,
                    effectType: "evidence" as const,
                });
            }
            setClaimLifecycleStateInCurrentTransaction(db, link.claimId, "archived");
            hitMemoryClaimFailpoint("memory-claim.010.claim.after");
            setMemoryProjectionSuperseded(db, row.id, input.supersededByMemoryId, input.nowMs);
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
        const row = requireProjectionRow(db, input.memoryId);
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
        if (projectId === null || row.content.length === 0) {
            recordMemoryClaimLinkFailure(
                db,
                row.id,
                row.project_path,
                projectId === null ? "unresolved-project-identity" : "empty-content",
            );
            hitMemoryClaimFailpoint("memory-claim.010.claim.after");
            applyProjection();
            hitMemoryClaimFailpoint("memory-claim.020.projection.after");
            return { result: unlinkableResult(row.id), effects: [] };
        }
        const link = ensureMemoryClaimLinkInCurrentTransaction(db, row, projectId, {
            kind: "migration",
        });
        setClaimLifecycleStateInCurrentTransaction(
            db,
            link.claimId,
            claimStateFromMemoryStatus(input.status),
        );
        hitMemoryClaimFailpoint("memory-claim.010.claim.after");
        applyProjection();
        hitMemoryClaimFailpoint("memory-claim.020.projection.after");
        return {
            result: { memoryId: row.id, claimId: link.claimId, revisionId: null, found: true },
            effects: [
                {
                    effectKey: `memory:${row.id}:lifecycle`,
                    projectId,
                    claimId: link.claimId,
                    effectType: "lifecycle" as const,
                },
            ],
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
 * flagged outcomes (`unverified` stays the absence of events, KTD5) plus the
 * projection verification columns.
 */
export function updateMemoryVerificationWithClaimsInCurrentTransaction(
    db: Database,
    envelope: MemoryClaimOperationEnvelope,
    input: UpdateMemoryVerificationClaimInput,
): MemoryClaimOperationOutcome<MemoryClaimWriteResult> {
    return runMemoryClaimOperationInCurrentTransaction(db, envelope, () => {
        const row = requireProjectionRow(db, input.memoryId);
        if (!row) return { result: unlinkableResult(input.memoryId, false), effects: [] };
        const projectId = resolveMemoryClaimProjectInCurrentTransaction(db, row.project_path);
        if (projectId === null || row.content.length === 0) {
            recordMemoryClaimLinkFailure(
                db,
                row.id,
                row.project_path,
                projectId === null ? "unresolved-project-identity" : "empty-content",
            );
            hitMemoryClaimFailpoint("memory-claim.010.claim.after");
            updateMemoryProjectionVerification(db, row.id, input.verificationStatus, input.nowMs);
            hitMemoryClaimFailpoint("memory-claim.020.projection.after");
            return { result: unlinkableResult(row.id), effects: [] };
        }
        const link = ensureMemoryClaimLinkInCurrentTransaction(db, row, projectId, {
            kind: "migration",
        });
        const outcome = VERIFICATION_EVENT_OUTCOMES[input.verificationStatus];
        if (outcome) {
            addVerificationEvent(db, {
                revisionId: readClaimCurrentRevisionId(db, link.claimId),
                outcome,
                verifier: envelope.producer,
            });
        }
        hitMemoryClaimFailpoint("memory-claim.010.claim.after");
        updateMemoryProjectionVerification(db, row.id, input.verificationStatus, input.nowMs);
        hitMemoryClaimFailpoint("memory-claim.020.projection.after");
        return {
            result: { memoryId: row.id, claimId: link.claimId, revisionId: null, found: true },
            effects: [
                {
                    effectKey: `memory:${row.id}:evidence`,
                    projectId,
                    claimId: link.claimId,
                    effectType: "evidence" as const,
                },
            ],
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
            const row = requireProjectionRow(db, input.memoryId);
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
            if (!input.verified || projectId === null || row.content.length === 0) {
                if (input.verified) {
                    recordMemoryClaimLinkFailure(
                        db,
                        row.id,
                        row.project_path,
                        projectId === null ? "unresolved-project-identity" : "empty-content",
                    );
                }
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
            const link = ensureMemoryClaimLinkInCurrentTransaction(db, row, projectId, {
                kind: "migration",
            });
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
            return {
                result: { memoryId: row.id, claimId: link.claimId, rowsWritten },
                effects: [
                    {
                        effectKey: `memory:${row.id}:evidence`,
                        projectId,
                        claimId: link.claimId,
                        effectType: "evidence" as const,
                    },
                ],
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

interface CurrentClaimSemanticState {
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
}

function readCurrentClaimSemanticState(db: Database, claimId: number): CurrentClaimSemanticState {
    const row = db
        .prepare(
            `SELECT rev.content AS content, claims.state AS state,
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
        (current.metadataJson ?? null) !== (desired.metadataJson ?? null)
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
    // update rewrites it. Idempotent on replay: an existing link short-circuits.
    const pre = readMemoryProjectionRow(db, input.memoryId);
    let preLink: MemoryClaimLink | null = null;
    if (pre && pre.content.length > 0) {
        const preProjectId = resolveMemoryClaimProjectInCurrentTransaction(db, pre.project_path);
        if (preProjectId !== null) {
            preLink = ensureMemoryClaimLinkInCurrentTransaction(db, pre, preProjectId, {
                kind: "migration",
            });
        }
    }

    input.applyProjection();
    hitMemoryClaimFailpoint("memory-claim.020.projection.after");

    return runMemoryClaimOperationInCurrentTransaction<ModuleMemoryDeltaResult>(
        db,
        envelope,
        () => {
            const post = readMemoryProjectionRow(db, input.memoryId);
            const effects: MemoryClaimEffect[] = [];
            if (!post) {
                // Tombstone removed the projection row: retire the claim, keep
                // the crosswalk (retention, not erasure).
                if (preLink) {
                    setClaimLifecycleStateInCurrentTransaction(db, preLink.claimId, "archived");
                    addVerificationEvent(db, {
                        revisionId: readClaimCurrentRevisionId(db, preLink.claimId),
                        outcome: "archive",
                        verifier: envelope.producer,
                    });
                    effects.push({
                        effectKey: `memory:${input.memoryId}:lifecycle`,
                        projectId: preLink.projectId,
                        claimId: preLink.claimId,
                        effectType: "lifecycle" as const,
                    });
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
            if (projectId === null || post.content.length === 0) {
                recordMemoryClaimLinkFailure(
                    db,
                    post.id,
                    post.project_path,
                    projectId === null ? "unresolved-project-identity" : "empty-content",
                );
                hitMemoryClaimFailpoint("memory-claim.010.claim.after");
                return {
                    result: { memoryId: post.id, claimId: null, revisionId: null, removed: false },
                    effects: [],
                };
            }

            const previouslyLinked = readMemoryClaimLink(db, post.id) !== null;
            const link = ensureMemoryClaimLinkInCurrentTransaction(db, post, projectId, {
                kind: "live",
                producer: envelope.producer,
                operationKey: envelope.operationKey,
                sourceSessionId: post.source_session_id,
            });

            const current = readCurrentClaimSemanticState(db, link.claimId);
            const desiredMeta = metadataFromProjectionRow(post);
            let revisionId: number | null = null;
            if (claimSemanticStateDiffers(current, post.content, desiredMeta)) {
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

            const desiredState = claimStateFromMemoryStatus(post.status);
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
            if (outcome && post.verification_status !== (pre?.verification_status ?? null)) {
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
            }

            const supersededBy = post.superseded_by_memory_id;
            if (supersededBy !== null && supersededBy !== (pre?.superseded_by_memory_id ?? null)) {
                const target = readMemoryProjectionRow(db, supersededBy);
                const targetProjectId = target
                    ? resolveMemoryClaimProjectInCurrentTransaction(db, target.project_path)
                    : null;
                if (target && targetProjectId !== null && target.content.length > 0) {
                    const targetLink = ensureMemoryClaimLinkInCurrentTransaction(
                        db,
                        target,
                        targetProjectId,
                        { kind: "migration" },
                    );
                    if (recordMemoryClaimSupersessionInCurrentTransaction(db, link, targetLink)) {
                        effects.push({
                            effectKey: `memory:${target.id}:supersede`,
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
    revisionCreatedAt: number;
}

const CURRENT_MEMORY_CLAIM_SELECT = `
    SELECT lmc.memory_id AS memoryId, lmc.canonical_memory_id AS canonicalMemoryId,
           lmc.claim_id AS claimId, lmc.project_id AS projectId, claims.state AS state,
           rev.id AS revisionId, rev.revision AS revision, rev.content AS content,
           rev.content_sha256 AS contentSha256, rev.created_at AS revisionCreatedAt,
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
 * Supported writers never commit these shapes; only direct SQL can. The v83
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
