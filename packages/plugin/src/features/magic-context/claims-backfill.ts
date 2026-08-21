/**
 * v84 memories-to-claims backfill engine (U5): batch selection, checkpointing,
 * reconciliation, scheduling, and operational status for the high-water legacy
 * corpus. It drives the U2 kernel row-adoption and relationship-translation
 * primitives — the transition logic itself lives in
 * `memory/storage-memory-claims.ts`, never here.
 *
 * Modes (R7-R9):
 * - empty: the migration completes synchronously (owned by migrations.ts).
 * - eager: rows, relationships, and reconciliation commit inside the v84
 *   migration transaction; gated on calibration evidence, resolved v22
 *   identity state, and a fully convertible corpus.
 * - lazy: the migration records only the pending high-water checkpoint; the
 *   bounded runner below converges after startup.
 *
 * Lazy batches reselect missing source-derived work under the immediate write
 * lock (the lock is the CAS: two concurrent runners serialize and the loser
 * reselects), use the crosswalk and operation envelopes as idempotency
 * anchors, and commit each batch's graph writes with its cursor checkpoint in
 * one short immediate transaction. Busy retries cover the whole batch with
 * bounded backoff; exhausted retries leave the work pending (R9).
 *
 * Completion stays oracle-backed (R11) but the reconciling phase is batched:
 * lineage re-translation pages through bounded transactions, the read-only
 * completion oracle runs outside the write lock, and one short final
 * immediate transaction re-verifies the decisive conditions (phase unchanged,
 * zero unlinked boundary rows, zero boundary-scoped blocking failures) before
 * publishing the completion checkpoint — a cursor or count alone never
 * authorizes completion.
 */

import type { Database } from "../../shared/sqlite";
import { addVerificationEvent, sha256Utf8Hex } from "./memory/storage-claims";
import {
    canonicalMemoryProjectPathSql,
    computeClaimRequestDigest,
    ensureMemoryClaimLinkInCurrentTransaction,
    findMemoryClaimsCompatCorruption,
    hasMemoryClaimsCompatSchema,
    listMemoryRelationshipSources,
    type MemoryClaimEffect,
    type MemoryClaimLink,
    memoryClaimAdoptionFailureReason,
    memoryClaimMetadataFailureReason,
    memoryClaimSupersessionExists,
    parseMemoryClaimMergedFrom,
    readCurrentClaimSemanticState,
    readMemoryClaimLink,
    recordMemoryClaimLinkFailure,
    resolveMemoryClaimProjectInCurrentTransaction,
    retireMemoryClaimInCurrentTransaction,
    runMemoryClaimOperationInCurrentTransaction,
    setClaimLifecycleStateInCurrentTransaction,
    sharedClaimStateFromLiveLinks,
    translateMemoryClaimRelationshipsInCurrentTransaction,
    withMemoryClaimGenerationContextInCurrentTransaction,
} from "./memory/storage-memory-claims";
import {
    type MemoryProjectionRow,
    readMemoryProjectionRow,
} from "./memory/storage-memory-projection";
import { CLAIMS_AND_EVIDENCE_TABLES } from "./storage-claims-schema";
import {
    CLAIMS_BACKFILL_META_KEYS,
    MEMORY_CLAIMS_COMPAT_TABLES,
    memoryLineagePresentSql,
    memoryRelationshipSourceMatchSql,
} from "./storage-memory-claims-schema";

export const CLAIMS_BACKFILL_PRODUCER = "claims-backfill";
export const CLAIMS_BACKFILL_BATCH_SIZE = 25;

// ---------------------------------------------------------------------------
// Failpoint seams (Process-Crash Test Contract). No-op by default; U6
// activates them through this registry — the memory-claim.* registry pattern.
// ---------------------------------------------------------------------------

export const CLAIMS_BACKFILL_FAILPOINT_IDS = [
    "claims-backfill.010.batch.after",
    "claims-backfill.020.batch-commit.after",
    "claims-backfill.030.complete.before",
    "claims-backfill.040.complete.after",
] as const;

export const CLAIMS_MIGRATION_FAILPOINT_IDS = [
    "claims-migration.010.ddl.after",
    "claims-migration.020.rows.after",
    "claims-migration.030.reconcile.after",
    "claims-migration.040.version.after",
    "claims-migration.050.commit.after",
] as const;

/**
 * Concurrency seams, not crash sites: the process-crash matrix excludes
 * them. They let a test interleave a writer between two runner reads that
 * commit in separate transactions.
 */
export const CLAIMS_BACKFILL_CONCURRENCY_FAILPOINT_IDS = [
    "claims-backfill.025.reconcile-oracle.after",
] as const;

export type ClaimsBackfillFailpointId = (typeof CLAIMS_BACKFILL_FAILPOINT_IDS)[number];
export type ClaimsMigrationFailpointId = (typeof CLAIMS_MIGRATION_FAILPOINT_IDS)[number];
type BackfillFailpointId =
    | ClaimsBackfillFailpointId
    | ClaimsMigrationFailpointId
    | (typeof CLAIMS_BACKFILL_CONCURRENCY_FAILPOINT_IDS)[number];

const activeFailpoints = new Map<BackfillFailpointId, () => void>();

export function setClaimsBackfillFailpoint(
    id: BackfillFailpointId,
    hook: (() => void) | null,
): void {
    if (hook) activeFailpoints.set(id, hook);
    else activeFailpoints.delete(id);
}

export function clearClaimsBackfillFailpoints(): void {
    activeFailpoints.clear();
}

function hitFailpoint(id: BackfillFailpointId): void {
    activeFailpoints.get(id)?.();
}

/** Called by migrations.ts at the v84 migration cut points. */
export function hitClaimsMigrationFailpoint(id: ClaimsMigrationFailpointId): void {
    hitFailpoint(id);
}

// ---------------------------------------------------------------------------
// Calibration policy (KTD4, R7)
// ---------------------------------------------------------------------------

export interface ClaimsBackfillCalibratedPolicy {
    /** Largest corpus row count the eager migration path may convert. */
    cutoffRows: number;
    /** SHA-256 digest of the measurement payload that selected the cutoff. */
    evidenceDigest: string;
}

/**
 * The shipped production policy. Stays null (cutoff zero: every nonempty
 * corpus is lazy) until reviewed calibration evidence under
 * `docs/evidence/claims-backfill/` justifies a nonzero cutoff (R7).
 */
export const PRODUCTION_CLAIMS_BACKFILL_POLICY: ClaimsBackfillCalibratedPolicy | null = null;

let policyOverride: ClaimsBackfillCalibratedPolicy | null | undefined;
let cutoffCeilingBypassForMeasurement = false;

/** Test/benchmark seam: pass null to restore the production policy. */
export function setClaimsBackfillCalibrationForTests(
    policy: ClaimsBackfillCalibratedPolicy | null,
    options: {
        /**
         * Lets the calibration measurement harness force eager conversion at
         * scales above the ceiling so the ceiling itself stays evidence-backed.
         * Production reads only the shipped policy and never sets this.
         */
        bypassCutoffCeilingForMeasurement?: boolean;
    } = {},
): void {
    policyOverride = policy ?? undefined;
    cutoffCeilingBypassForMeasurement =
        policy !== null && options.bypassCutoffCeilingForMeasurement === true;
}

export function getActiveClaimsBackfillPolicy(): ClaimsBackfillCalibratedPolicy | null {
    return policyOverride ?? PRODUCTION_CLAIMS_BACKFILL_POLICY;
}

/**
 * Hard ceiling on any calibrated eager cutoff. The eager path converts the
 * whole corpus while holding the v84 migration write lock, and the checked-in
 * calibration evidence (docs/evidence/claims-backfill/v84-threshold.json)
 * budgets that lock at 2500ms — 2x margin under the 5s sibling busy_timeout.
 * The evidence measures a 1K-row corpus at ~660ms worst case and a 10K-row
 * corpus at ~10.8s, so 1000 is the largest measured scale whose slowest run
 * fits the budget. A policy claiming a larger cutoff is treated as
 * uncalibrated and the corpus converts lazily.
 */
export const CLAIMS_BACKFILL_EAGER_CUTOFF_CEILING = 1000;

/**
 * A policy may enable eager mode only with a plausible evidence digest and a
 * cutoff at or below the measured lock-budget ceiling. The measurement
 * harness alone may lift the ceiling through its seam option; the shipped
 * production policy is always ceiling-checked.
 */
export function claimsBackfillPolicyIsCalibrated(
    policy: ClaimsBackfillCalibratedPolicy | null,
): policy is ClaimsBackfillCalibratedPolicy {
    return (
        policy !== null &&
        Number.isSafeInteger(policy.cutoffRows) &&
        policy.cutoffRows >= 1 &&
        (cutoffCeilingBypassForMeasurement ||
            policy.cutoffRows <= CLAIMS_BACKFILL_EAGER_CUTOFF_CEILING) &&
        /^[0-9a-f]{64}$/.test(policy.evidenceDigest)
    );
}

/** Canonical digest over a calibration measurement payload. */
export function computeClaimsBackfillEvidenceDigest(measurements: unknown): string {
    return sha256Utf8Hex(JSON.stringify(measurements));
}

// ---------------------------------------------------------------------------
// Meta state
// ---------------------------------------------------------------------------

function readMeta(db: Database, key: string): string | null {
    const row = db.prepare("SELECT value FROM schema_migrations_meta WHERE key = ?").get(key) as
        | { value: string }
        | undefined;
    return row?.value ?? null;
}

function writeMeta(db: Database, key: string, value: string): void {
    db.prepare(
        `INSERT INTO schema_migrations_meta (key, value)
         VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, value);
}

function readIntMeta(db: Database, key: string): number {
    const parsed = Number.parseInt(readMeta(db, key) ?? "0", 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

// Meta keys owned by this module, beyond the U2-created contract in
// CLAIMS_BACKFILL_META_KEYS. The `claims_backfill_` prefix keeps them inside
// the schema module's test-drop cleanup wildcard.

/** Human-readable reason behind the recorded v84 mode decision (doctor status). */
export const CLAIMS_BACKFILL_MODE_REASON_META_KEY = "claims_backfill_mode_decision_reason";
/** Digest of the boundary-scoped blocking failure set at the blocked checkpoint. */
const CLAIMS_BACKFILL_BLOCKED_DIGEST_META_KEY = "claims_backfill_blocked_failure_digest";
/** Reconciling-phase lineage re-translation cursor (acceleration only; never completion). */
const CLAIMS_BACKFILL_RECONCILE_CURSOR_META_KEY = "claims_backfill_reconcile_cursor";

export type ClaimsBackfillMode = "empty" | "eager" | "lazy";
export type ClaimsBackfillPhase = "rows" | "relationships" | "reconciling" | "complete" | "blocked";

export interface ClaimsBackfillState {
    mode: ClaimsBackfillMode | null;
    phase: ClaimsBackfillPhase | null;
    boundaryMemoryId: number;
    expectedRowCount: number;
    rowsCursor: number;
    relationshipsCursor: number;
    v22Takeover: string | null;
    reconciliationVersion: string | null;
    finalOutboxWatermark: number;
    calibrationDigest: string | null;
    modeDecisionReason: string | null;
}

export function readClaimsBackfillState(db: Database): ClaimsBackfillState {
    return {
        mode: readMeta(db, CLAIMS_BACKFILL_META_KEYS.mode) as ClaimsBackfillMode | null,
        phase: readMeta(db, CLAIMS_BACKFILL_META_KEYS.phase) as ClaimsBackfillPhase | null,
        boundaryMemoryId: readIntMeta(db, CLAIMS_BACKFILL_META_KEYS.boundaryMemoryId),
        expectedRowCount: readIntMeta(db, CLAIMS_BACKFILL_META_KEYS.expectedRowCount),
        rowsCursor: readIntMeta(db, CLAIMS_BACKFILL_META_KEYS.rowsCursor),
        relationshipsCursor: readIntMeta(db, CLAIMS_BACKFILL_META_KEYS.relationshipsCursor),
        v22Takeover: readMeta(db, CLAIMS_BACKFILL_META_KEYS.v22Takeover),
        reconciliationVersion: readMeta(db, CLAIMS_BACKFILL_META_KEYS.reconciliationVersion),
        finalOutboxWatermark: readIntMeta(db, CLAIMS_BACKFILL_META_KEYS.finalOutboxWatermark),
        calibrationDigest: readMeta(db, CLAIMS_BACKFILL_META_KEYS.calibrationDigest),
        modeDecisionReason: readMeta(db, CLAIMS_BACKFILL_MODE_REASON_META_KEY),
    };
}

// ---------------------------------------------------------------------------
// Migration mode decision (KTD4, R7-R8, R19)
// ---------------------------------------------------------------------------

export interface ClaimsBackfillModeDecision {
    mode: ClaimsBackfillMode;
    calibrationDigest: string;
    reason: string;
}

function countScalar(db: Database, sql: string, ...params: Array<number | string>): number {
    return (db.prepare(sql).get(...params) as { count: number }).count;
}

/**
 * Rows the eager migration path could not convert without the lazy repair
 * lane: unresolvable project identities, empty content, and lineage whose
 * tokens are malformed or dangle. Eager is all-or-nothing inside one
 * migration transaction, so any such row forces lazy mode.
 */
function eagerConversionBlockers(db: Database): string | null {
    // The canonical-shape predicate is the SQL twin of the resolver's TS
    // check (canonicalMemoryProjectPathSql, derived from
    // CANONICAL_MEMORY_PROJECT_PATH_PREFIXES): a row this gate passes is a
    // row resolveMemoryClaimProjectInCurrentTransaction can resolve, so eager
    // adoption cannot hit unresolved-project-identity and roll the migration
    // back.
    const noncanonical = countScalar(
        db,
        `SELECT COUNT(*) AS count FROM memories
          WHERE NOT ${canonicalMemoryProjectPathSql("project_path")}`,
    );
    if (noncanonical > 0) return `${noncanonical} row(s) with a noncanonical project path`;
    const emptyContent = countScalar(
        db,
        "SELECT COUNT(*) AS count FROM memories WHERE length(content) = 0",
    );
    if (emptyContent > 0) return `${emptyContent} row(s) with empty content`;
    for (const { id } of db.prepare("SELECT id FROM memories ORDER BY id").all() as Array<{
        id: number;
    }>) {
        const row = readMemoryProjectionRow(db, id);
        if (!row) continue;
        const failure = memoryClaimMetadataFailureReason(row);
        if (failure) return `memory ${id} has invalid claim metadata: ${failure}`;
    }
    const memoryIds = new Set(
        (db.prepare("SELECT id FROM memories").all() as Array<{ id: number }>).map((row) => row.id),
    );
    const lineageRows = db
        .prepare(
            `SELECT m.id, m.merged_from, m.superseded_by_memory_id FROM memories m
              WHERE ${memoryLineagePresentSql("m")}`,
        )
        .all() as Array<{
        id: number;
        merged_from: string | null;
        superseded_by_memory_id: number | null;
    }>;
    for (const row of lineageRows) {
        if (row.superseded_by_memory_id !== null && !memoryIds.has(row.superseded_by_memory_id)) {
            return `memory ${row.id} supersession dangles`;
        }
        for (const token of parseMemoryClaimMergedFrom(row.merged_from)) {
            if (token.kind === "malformed") return `memory ${row.id} has malformed lineage`;
            if (token.kind === "id" && token.id !== undefined && !memoryIds.has(token.id)) {
                return `memory ${row.id} lineage token ${token.ordinal} dangles`;
            }
        }
    }
    return null;
}

/**
 * Select the v84 conversion mode inside the migration transaction. Missing
 * calibration evidence, a corpus above the calibrated cutoff, unresolved v22
 * identity work, or an unconvertible row all force lazy mode.
 */
export function decideClaimsBackfillMode(
    db: Database,
    corpusCount: number,
    v22Pending: boolean,
): ClaimsBackfillModeDecision {
    if (corpusCount === 0) {
        return { mode: "empty", calibrationDigest: "none", reason: "empty corpus" };
    }
    const policy = getActiveClaimsBackfillPolicy();
    if (!claimsBackfillPolicyIsCalibrated(policy)) {
        return { mode: "lazy", calibrationDigest: "none", reason: "no calibration evidence" };
    }
    if (corpusCount > policy.cutoffRows) {
        return {
            mode: "lazy",
            calibrationDigest: policy.evidenceDigest,
            reason: `corpus ${corpusCount} above calibrated cutoff ${policy.cutoffRows}`,
        };
    }
    if (v22Pending) {
        return {
            mode: "lazy",
            calibrationDigest: policy.evidenceDigest,
            reason: "pending v22 identity work",
        };
    }
    const blocker = eagerConversionBlockers(db);
    if (blocker !== null) {
        return { mode: "lazy", calibrationDigest: policy.evidenceDigest, reason: blocker };
    }
    return {
        mode: "eager",
        calibrationDigest: policy.evidenceDigest,
        reason: `corpus ${corpusCount} at or below calibrated cutoff ${policy.cutoffRows}`,
    };
}

// ---------------------------------------------------------------------------
// Failure surface helpers (bounded repair surface)
// ---------------------------------------------------------------------------

type FailurePhase = "rows" | "relationships" | "reconcile";

function markFailureResolved(
    db: Database,
    phase: FailurePhase,
    itemKind: string,
    itemKey: string,
): void {
    db.prepare(
        `UPDATE claim_backfill_failures SET disposition = 'resolved', updated_at = ?
          WHERE phase = ? AND item_kind = ? AND item_key = ?
            AND disposition IN ('blocking', 'retry', 'warning')`,
    ).run(Date.now(), phase, itemKind, itemKey);
}

function countFailures(
    db: Database,
    dispositions: readonly string[],
    phase?: FailurePhase,
): number {
    const placeholders = dispositions.map(() => "?").join(", ");
    if (phase) {
        return countScalar(
            db,
            `SELECT COUNT(*) AS count FROM claim_backfill_failures
              WHERE disposition IN (${placeholders}) AND phase = ?`,
            ...dispositions,
            phase,
        );
    }
    return countScalar(
        db,
        `SELECT COUNT(*) AS count FROM claim_backfill_failures WHERE disposition IN (${placeholders})`,
        ...dispositions,
    );
}

/** Rows-phase failures whose memory has since acquired its crosswalk link. */
function sweepResolvedRowFailures(db: Database): void {
    db.prepare(
        `UPDATE claim_backfill_failures SET disposition = 'resolved', updated_at = ?
          WHERE phase = 'rows' AND item_kind = 'memory' AND disposition IN ('blocking', 'retry')
            AND EXISTS (
                SELECT 1 FROM legacy_memory_claims
                 WHERE memory_id = CAST(claim_backfill_failures.item_key AS INTEGER)
            )`,
    ).run(Date.now());
}

/**
 * Failure rows the boundary backfill can never repair: their item identifies
 * a memory above the recorded high-water boundary, so only a live writer can
 * clear them. Rows-phase keys are the memory id itself
 * (`recordMemoryClaimLinkFailure`); relationship-phase keys embed it as
 * `memory:<id>:relations:<digest>:...`
 * (`translateMemoryClaimRelationshipsInCurrentTransaction`), so
 * `substr(item_key, 8)` skips the 7-character 'memory:' prefix and CAST
 * reads the leading integer. A failure whose key does not positively parse
 * above the boundary keeps gating (fail closed). Binds the boundary twice.
 */
const ABOVE_BOUNDARY_FAILURE_WHERE = `(
    (phase = 'rows' AND item_kind = 'memory' AND CAST(item_key AS INTEGER) > ?)
    OR (phase = 'relationships' AND item_key LIKE 'memory:%'
        AND CAST(substr(item_key, 8) AS INTEGER) > ?)
)`;

/**
 * Failures that gate the boundary corpus. Above-boundary failures stay
 * visible on the repair surface (status counts, doctor listing) but never
 * gate completion or phase transitions: nothing in the boundary backfill can
 * repair them, so gating on them would make completion permanently
 * unreachable.
 */
function countBoundaryFailures(
    db: Database,
    dispositions: readonly string[],
    boundary: number,
    phase?: FailurePhase,
): number {
    const placeholders = dispositions.map(() => "?").join(", ");
    const params: Array<number | string> = [...dispositions];
    if (phase) params.push(phase);
    return countScalar(
        db,
        `SELECT COUNT(*) AS count FROM claim_backfill_failures
          WHERE disposition IN (${placeholders})${phase ? " AND phase = ?" : ""}
            AND NOT ${ABOVE_BOUNDARY_FAILURE_WHERE}`,
        ...params,
        boundary,
        boundary,
    );
}

/**
 * Deterministic digest of the boundary-scoped blocking/retry failure set.
 * (id, disposition, reason_code) is stable across re-scans that change
 * nothing: an unchanged failure upserts in place under its (phase,
 * item_kind, item_key) key, keeping its id and reason, while a repair,
 * waiver, or new diagnostic changes the set. updated_at is deliberately
 * excluded — every re-scan bumps it without changing what blocks.
 */
function computeBlockedFailureDigest(db: Database, boundary: number): string {
    const rows = db
        .prepare(
            `SELECT id, disposition, reason_code AS reasonCode FROM claim_backfill_failures
              WHERE disposition IN ('blocking', 'retry')
                AND NOT ${ABOVE_BOUNDARY_FAILURE_WHERE}
              ORDER BY id`,
        )
        .all(boundary, boundary) as Array<{ id: number; disposition: string; reasonCode: string }>;
    return sha256Utf8Hex(
        JSON.stringify(rows.map((row) => [row.id, row.disposition, row.reasonCode])),
    );
}

/**
 * Blocked checkpoint: the phase plus the failure-set digest the next start
 * compares against, so an unchanged blocked database skips the full-corpus
 * reset instead of re-scanning on every boot. Caller owns the transaction.
 */
function writeBlockedCheckpoint(db: Database, boundary: number): void {
    writeMeta(db, CLAIMS_BACKFILL_META_KEYS.phase, "blocked");
    writeMeta(
        db,
        CLAIMS_BACKFILL_BLOCKED_DIGEST_META_KEY,
        computeBlockedFailureDigest(db, boundary),
    );
}

// ---------------------------------------------------------------------------
// Row adoption (drives the U2 kernel; R1-R6, R10)
// ---------------------------------------------------------------------------

function readClaimCurrentRevisionId(db: Database, claimId: number): number {
    const row = db
        .prepare("SELECT current_revision_id AS pointer FROM claims WHERE id = ?")
        .get(claimId) as { pointer: number | null } | undefined;
    if (!row || row.pointer === null) {
        throw new Error(`claim ${claimId} is missing or has a null current-revision pointer`);
    }
    return row.pointer;
}

/**
 * Compat verification truth for one memory outside the projection columns:
 * the maximum `memory_verifications.verified_at`, or 0 when the row is
 * mapped-only or unmapped. Pre-v84 TypeScript verification writes a positive
 * `verified_at` only to this side table, never to the projection's
 * verification columns.
 */
export function readMemorySideTableVerifiedAt(db: Database, memoryId: number): number {
    const row = db
        .prepare(
            "SELECT MAX(verified_at) AS verifiedAt FROM memory_verifications WHERE memory_id = ?",
        )
        .get(memoryId) as { verifiedAt: number | null } | undefined;
    return row?.verifiedAt ?? 0;
}

/**
 * Carry a memory's verified status onto its adopted claim as one
 * current-revision verified event. A row counts as verified when either the
 * projection columns say so or the `memory_verifications` side table carries
 * a positive `verified_at` (the only place pre-v84 TypeScript verification
 * writes). Mapped-only rows (no positive `verified_at` anywhere) record
 * nothing. Shared by the boundary backfill, relocation, and identity-merge
 * adoption sites; returns true when an event was recorded so callers can
 * emit a matching evidence effect.
 */
export function recordAdoptedMemoryVerifiedEventInCurrentTransaction(
    db: Database,
    row: Pick<MemoryProjectionRow, "id" | "verification_status" | "verified_at">,
    claimId: number,
    verifier: string,
): boolean {
    const projectionVerified =
        row.verification_status === "verified" && row.verified_at !== null && row.verified_at > 0;
    if (!projectionVerified && readMemorySideTableVerifiedAt(db, row.id) <= 0) {
        return false;
    }
    addVerificationEvent(db, {
        revisionId: readClaimCurrentRevisionId(db, claimId),
        outcome: "verified",
        verifier,
    });
    return true;
}

/**
 * Adopt one boundary memory row: crosswalk plus revision 1 through the
 * kernel, one current-snapshot verification event for a positively verified
 * row (mapped-only rows keep their `memory_verifications` mappings with no
 * event), and one upsert outbox effect under the deterministic
 * `row:<memoryId>` operation envelope. Returns false and records a blocking
 * diagnostic when the row cannot form a claim.
 */
export function adoptBoundaryMemoryRowInCurrentTransaction(
    db: Database,
    row: MemoryProjectionRow,
): boolean {
    const projectId = resolveMemoryClaimProjectInCurrentTransaction(db, row.project_path);
    const failure = memoryClaimAdoptionFailureReason(row, projectId);
    if (failure) {
        recordMemoryClaimLinkFailure(db, row.id, row.project_path, failure);
        return false;
    }
    const adoptProjectId = projectId as number;
    runMemoryClaimOperationInCurrentTransaction(
        db,
        {
            producer: CLAIMS_BACKFILL_PRODUCER,
            operationKey: `row:${row.id}`,
            requestDigest: computeClaimRequestDigest({ backfillRow: row.id }),
        },
        () => {
            const link = ensureMemoryClaimLinkInCurrentTransaction(db, row, adoptProjectId, {
                kind: "migration",
            });
            const effects: MemoryClaimEffect[] = [
                {
                    effectKey: `memory:${row.id}:upsert`,
                    projectId: adoptProjectId,
                    claimId: link.claimId,
                    effectType: "upsert" as const,
                },
            ];
            // Adoption can reuse a canonical claim whose stored state
            // reflects only the rows adopted before this one. Recompute the
            // shared max-rank state so id order cannot strand an archived
            // claim under a live projection or downgrade a permanent sibling.
            const nextState = sharedClaimStateFromLiveLinks(db, link.claimId, row.id, row.status);
            if (readCurrentClaimSemanticState(db, link.claimId).state !== nextState) {
                if (nextState === "archived") {
                    retireMemoryClaimInCurrentTransaction(
                        db,
                        link.claimId,
                        CLAIMS_BACKFILL_PRODUCER,
                    );
                } else {
                    setClaimLifecycleStateInCurrentTransaction(db, link.claimId, nextState);
                }
                effects.push({
                    effectKey: `memory:${row.id}:lifecycle`,
                    projectId: adoptProjectId,
                    claimId: link.claimId,
                    effectType: "lifecycle" as const,
                });
            }
            recordAdoptedMemoryVerifiedEventInCurrentTransaction(
                db,
                row,
                link.claimId,
                CLAIMS_BACKFILL_PRODUCER,
            );
            return {
                result: { memoryId: row.id, claimId: link.claimId },
                effects,
            };
        },
    );
    markFailureResolved(db, "rows", "memory", String(row.id));
    return true;
}

// ---------------------------------------------------------------------------
// Relationship translation (KTD5, KTD8, R3-R6)
// ---------------------------------------------------------------------------

interface LineageRowShape {
    id: number;
    merged_from: string | null;
    superseded_by_memory_id: number | null;
}

function selectLineageRows(
    db: Database,
    boundary: number,
    afterId: number,
    limit: number | null,
): LineageRowShape[] {
    const base = `SELECT m.id, m.merged_from, m.superseded_by_memory_id FROM memories m
         WHERE m.id > ? AND m.id <= ? AND ${memoryLineagePresentSql("m")} ORDER BY m.id ASC`;
    if (limit === null) return db.prepare(base).all(afterId, boundary) as LineageRowShape[];
    return db.prepare(`${base} LIMIT ?`).all(afterId, boundary, limit) as LineageRowShape[];
}

// ---------------------------------------------------------------------------
// Reconciliation oracles (R11)
// ---------------------------------------------------------------------------

export interface ClaimsBackfillReconciliationReport {
    ok: boolean;
    problems: string[];
    warningCount: number;
}

/** Anti-join fragment: the aliased memories row has no crosswalk link (R1, R11). */
function unlinkedBoundaryRowSql(alias: string): string {
    return `NOT EXISTS (SELECT 1 FROM legacy_memory_claims lmc WHERE lmc.memory_id = ${alias}.id)`;
}

function countUnlinkedBoundaryRows(db: Database, boundary: number): number {
    return countScalar(
        db,
        `SELECT COUNT(*) AS count FROM memories m
          WHERE m.id <= ? AND ${unlinkedBoundaryRowSql("m")}`,
        boundary,
    );
}

/** Next id-ordered batch of boundary rows still missing their crosswalk link. */
function selectUnlinkedBoundaryRowIds(
    db: Database,
    afterId: number,
    boundary: number,
    limit: number,
): number[] {
    return (
        db
            .prepare(
                `SELECT m.id FROM memories m
                  WHERE m.id > ? AND m.id <= ? AND ${unlinkedBoundaryRowSql("m")}
                  ORDER BY m.id ASC LIMIT ?`,
            )
            .all(afterId, boundary, limit) as Array<{ id: number }>
    ).map((row) => row.id);
}

function countBoundaryCrosswalkRows(db: Database, boundary: number): number {
    return countScalar(
        db,
        "SELECT COUNT(*) AS count FROM legacy_memory_claims WHERE memory_id <= ?",
        boundary,
    );
}

/**
 * Read-only completion oracle. Every check derives from source state — a
 * cursor or count alone never authorizes completion:
 * - every current boundary row is linked (anti-join);
 * - every original boundary id has a link, so removed boundary ids were
 *   linked before deletion (expected-count oracle);
 * - crosswalks, revision metadata, and root evidence are intact;
 * - every boundary claim has an outbox effect and a project generation;
 * - every re-derived lineage token is resolved in the graph or carries an
 *   operator warning; an append-only replaced source is terminal only when a
 *   newer source snapshot exists and that current snapshot is fully disposed;
 * - no blocking or retry diagnostic remains within the boundary corpus
 *   (an above-boundary diagnostic belongs to live writers: it stays visible
 *   on the repair surface but the boundary backfill can never clear it, so
 *   it must not gate completion);
 * - v84's adopted v22 identity work is resolved.
 */
export function inspectClaimsBackfillReconciliation(
    db: Database,
    state: ClaimsBackfillState = readClaimsBackfillState(db),
): ClaimsBackfillReconciliationReport {
    const problems: string[] = [];
    const boundary = state.boundaryMemoryId;

    const unlinked = countUnlinkedBoundaryRows(db, boundary);
    if (unlinked > 0) problems.push(`${unlinked} boundary memory row(s) missing a crosswalk link`);

    const crosswalkCount = countBoundaryCrosswalkRows(db, boundary);
    if (crosswalkCount !== state.expectedRowCount) {
        problems.push(
            `boundary crosswalk count ${crosswalkCount} does not equal expected ${state.expectedRowCount}`,
        );
    }

    const corruption = findMemoryClaimsCompatCorruption(db);
    if (corruption.revisionIdsMissingMemoryMetadata.length > 0) {
        problems.push(
            `${corruption.revisionIdsMissingMemoryMetadata.length} revision(s) missing memory metadata`,
        );
    }
    if (corruption.invalidCrosswalkMemoryIds.length > 0) {
        problems.push(`${corruption.invalidCrosswalkMemoryIds.length} invalid crosswalk row(s)`);
    }

    const missingRootEvidence = countScalar(
        db,
        `SELECT COUNT(*) AS count FROM legacy_memory_claims lmc
           JOIN claim_revisions rev ON rev.claim_id = lmc.claim_id AND rev.revision = 1
          WHERE lmc.memory_id = lmc.canonical_memory_id AND NOT EXISTS (
              SELECT 1 FROM claim_evidence ce
               WHERE ce.revision_id = rev.id
                 AND ce.observation_id = lmc.root_observation_id
          )`,
    );
    if (missingRootEvidence > 0) {
        problems.push(`${missingRootEvidence} canonical claim(s) missing root evidence`);
    }
    const evidencelessRevisions = countScalar(
        db,
        `SELECT COUNT(*) AS count FROM legacy_memory_claims lmc
           JOIN claim_revisions rev ON rev.claim_id = lmc.claim_id
          WHERE lmc.memory_id = lmc.canonical_memory_id AND NOT EXISTS (
              SELECT 1 FROM claim_evidence ce WHERE ce.revision_id = rev.id
          )`,
    );
    if (evidencelessRevisions > 0) {
        problems.push(`${evidencelessRevisions} revision(s) missing evidence`);
    }

    const missingOutbox = countScalar(
        db,
        `SELECT COUNT(*) AS count FROM legacy_memory_claims lmc
          WHERE lmc.memory_id <= ? AND NOT EXISTS (
              SELECT 1 FROM claim_change_outbox o WHERE o.claim_id = lmc.claim_id
          )`,
        boundary,
    );
    if (missingOutbox > 0)
        problems.push(`${missingOutbox} crosswalk row(s) missing an outbox effect`);

    const mismatchedOutboxProjects = countScalar(
        db,
        `SELECT COUNT(*) AS count FROM claim_change_outbox o
           LEFT JOIN claims c ON c.id = o.claim_id
          WHERE c.id IS NULL OR c.project_id IS NOT o.project_id`,
    );
    if (mismatchedOutboxProjects > 0) {
        problems.push(`${mismatchedOutboxProjects} outbox effect(s) have a mismatched project`);
    }

    const missingGeneration = countScalar(
        db,
        `SELECT COUNT(*) AS count FROM legacy_memory_claims lmc
          WHERE lmc.memory_id <= ? AND NOT EXISTS (
              SELECT 1 FROM claim_project_generations g WHERE g.project_id = lmc.project_id
          )`,
        boundary,
    );
    if (missingGeneration > 0) {
        problems.push(`${missingGeneration} crosswalk row(s) missing a project generation`);
    }

    const unsnapshottedRelationshipRows = countScalar(
        db,
        `SELECT COUNT(*) AS count FROM memories m
          WHERE m.id <= ?
            AND ${memoryLineagePresentSql("m")}
            AND NOT ${memoryRelationshipSourceMatchSql("m")}`,
        boundary,
    );
    if (unsnapshottedRelationshipRows > 0) {
        problems.push(
            `${unsnapshottedRelationshipRows} relationship source row(s) were not persisted`,
        );
    }

    let tokensWithoutDisposition = 0;
    // The token walks below revisit the same crosswalk links and claim pairs
    // repeatedly, and the imported probes prepare their statements per call.
    // The oracle is read-only, so one probe per distinct key is sound; the
    // caches hoist both the statement preparation and the query out of the
    // loops.
    const linkCache = new Map<number, MemoryClaimLink | null>();
    const readLink = (memoryId: number): MemoryClaimLink | null => {
        let link = linkCache.get(memoryId);
        if (link === undefined) {
            link = readMemoryClaimLink(db, memoryId);
            linkCache.set(memoryId, link);
        }
        return link;
    };
    const supersessionCache = new Map<string, boolean>();
    const supersessionExists = (source: MemoryClaimLink, target: MemoryClaimLink): boolean => {
        const key = `${source.claimId}:${target.claimId}`;
        let exists = supersessionCache.get(key);
        if (exists === undefined) {
            exists = memoryClaimSupersessionExists(db, source, target);
            supersessionCache.set(key, exists);
        }
        return exists;
    };
    const readDisposition = db.prepare(
        `SELECT disposition, reason_code AS reasonCode FROM claim_backfill_failures
          WHERE phase = 'relationships' AND item_kind = ? AND item_key = ?`,
    );
    const relationshipSources = listMemoryRelationshipSources(db, boundary);
    const currentSourceByMemory = new Map<number, (typeof relationshipSources)[number]>();
    for (const source of relationshipSources) currentSourceByMemory.set(source.memoryId, source);
    const tokenIsDisposed = (
        itemKind: "lineage" | "supersession",
        itemKey: string,
        resolvedInGraph: boolean,
        replacedByDisposedSource = false,
    ): boolean => {
        const disposition = readDisposition.get(itemKind, itemKey) as
            | { disposition: string; reasonCode: string }
            | undefined;
        return (
            disposition?.disposition === "warning" ||
            (disposition?.disposition === "resolved" &&
                (resolvedInGraph ||
                    (disposition.reasonCode === "relationship-source-replaced" &&
                        replacedByDisposedSource)))
        );
    };
    const sourceIsDisposed = (source: (typeof relationshipSources)[number]): boolean => {
        for (const token of disposalTokens(source)) {
            if (!tokenIsDisposed(token.itemKind, token.itemKey, token.resolvedInGraph)) {
                return false;
            }
        }
        return true;
    };
    /**
     * One source expands to its supersession token plus its merged-from
     * lineage tokens, each carrying the graph-resolution flag the disposition
     * check consumes. `sourceIsDisposed` and the completion count below walk
     * this same expansion, so the replaced-source check and the completion
     * oracle cannot silently diverge on token keys or resolution semantics.
     */
    function* disposalTokens(source: (typeof relationshipSources)[number]): Generator<{
        itemKind: "lineage" | "supersession";
        itemKey: string;
        resolvedInGraph: boolean;
    }> {
        const link = readLink(source.memoryId);
        const prefix = `memory:${source.memoryId}:relations:${source.sourceDigest}`;
        if (source.supersededByMemoryId !== null) {
            const targetLink = readLink(source.supersededByMemoryId);
            yield {
                itemKind: "supersession",
                itemKey: `${prefix}:superseded-by`,
                resolvedInGraph:
                    link !== null && targetLink !== null && supersessionExists(link, targetLink),
            };
        }
        for (const token of parseMemoryClaimMergedFrom(source.mergedFrom)) {
            let resolvedInGraph = token.kind === "marker";
            if (token.kind === "id" && link !== null) {
                const sourceLink = readLink(token.id as number);
                resolvedInGraph = sourceLink !== null && supersessionExists(sourceLink, link);
            }
            yield {
                itemKind: "lineage",
                itemKey: `${prefix}:merged-from:${token.ordinal}`,
                resolvedInGraph,
            };
        }
    }
    const currentSourceDisposed = new Map<number, boolean>();
    for (const [memoryId, source] of currentSourceByMemory) {
        currentSourceDisposed.set(memoryId, sourceIsDisposed(source));
    }
    for (const source of relationshipSources) {
        const current = currentSourceByMemory.get(source.memoryId);
        const replacedByDisposedSource =
            current !== undefined &&
            current.sourceId > source.sourceId &&
            currentSourceDisposed.get(source.memoryId) === true;
        for (const token of disposalTokens(source)) {
            if (
                !tokenIsDisposed(
                    token.itemKind,
                    token.itemKey,
                    token.resolvedInGraph,
                    replacedByDisposedSource,
                )
            ) {
                tokensWithoutDisposition += 1;
            }
        }
    }
    if (tokensWithoutDisposition > 0) {
        problems.push(`${tokensWithoutDisposition} lineage token(s) without a disposition`);
    }

    const blocking = countBoundaryFailures(db, ["blocking", "retry"], boundary);
    if (blocking > 0) {
        problems.push(`${blocking} blocking backfill failure(s) remain within the boundary corpus`);
    }

    for (const table of [...CLAIMS_AND_EVIDENCE_TABLES, ...MEMORY_CLAIMS_COMPAT_TABLES]) {
        // pi-lens-ignore: sql-injection
        const violations = db.prepare(`PRAGMA foreign_key_check(${table})`).all() as unknown[];
        if (violations.length > 0) {
            problems.push(`${table}: ${violations.length} foreign key violation(s)`);
        }
    }

    if (state.v22Takeover === "pending") problems.push("pending v22 identity work");

    // Warning-class lifecycle oracle: a boundary claim whose stored state
    // diverges from the max-rank state derived from its linked projections —
    // the SQL twin of `sharedClaimStateFromLiveLinks` with no substituted
    // row (a claim with no surviving projection rows derives archived).
    // Warning disposition: any later kernel write on a linked row repairs
    // the state, so a mismatch never gates completion.
    const lifecycleMismatches = countScalar(
        db,
        `SELECT COUNT(*) AS count FROM claims c
          WHERE EXISTS (
                SELECT 1 FROM legacy_memory_claims b
                 WHERE b.claim_id = c.id AND b.memory_id <= ?
            )
            AND c.state <> (
                SELECT CASE COALESCE(MAX(CASE m.status
                                WHEN 'permanent' THEN 2
                                WHEN 'active' THEN 1
                                ELSE 0 END), 0)
                       WHEN 2 THEN 'permanent' WHEN 1 THEN 'active' ELSE 'archived' END
                  FROM legacy_memory_claims lmc
                  JOIN memories m ON m.id = lmc.memory_id
                 WHERE lmc.claim_id = c.id
            )`,
        boundary,
    );

    return {
        ok: problems.length === 0,
        problems,
        warningCount: countBoundaryFailures(db, ["warning"], boundary) + lifecycleMismatches,
    };
}

/** Publish the completion checkpoint. Caller owns the transaction. */
function writeCompletionCheckpoint(db: Database): void {
    writeMeta(db, CLAIMS_BACKFILL_META_KEYS.phase, "complete");
    writeMeta(db, CLAIMS_BACKFILL_META_KEYS.reconciliationVersion, "1");
    const watermark = (
        db.prepare("SELECT COALESCE(MAX(id), 0) AS watermark FROM claim_change_outbox").get() as {
            watermark: number;
        }
    ).watermark;
    writeMeta(db, CLAIMS_BACKFILL_META_KEYS.finalOutboxWatermark, String(watermark));
}

// ---------------------------------------------------------------------------
// Eager migration path (R8)
// ---------------------------------------------------------------------------

/**
 * Convert the whole boundary corpus inside the caller-owned v84 migration
 * transaction: rows, relationships, then the reconciliation oracle. A failed
 * oracle throws, rolling the entire migration back to complete v82 state.
 */
export function runEagerClaimsBackfillInMigrationTransaction(db: Database): void {
    withMemoryClaimGenerationContextInCurrentTransaction(db, () => {
        const state = readClaimsBackfillState(db);
        const boundary = state.boundaryMemoryId;

        let cursor = 0;
        while (true) {
            const ids = selectUnlinkedBoundaryRowIds(
                db,
                cursor,
                boundary,
                CLAIMS_BACKFILL_BATCH_SIZE,
            );
            if (ids.length === 0) break;
            for (const id of ids) {
                const row = readMemoryProjectionRow(db, id);
                if (!row) continue;
                if (!adoptBoundaryMemoryRowInCurrentTransaction(db, row)) {
                    throw new Error(`v84 eager backfill could not adopt memory ${id}`);
                }
            }
            cursor = ids[ids.length - 1];
        }
        writeMeta(db, CLAIMS_BACKFILL_META_KEYS.rowsCursor, String(boundary));
        hitClaimsMigrationFailpoint("claims-migration.020.rows.after");

        for (const row of selectLineageRows(db, boundary, 0, null)) {
            translateMemoryClaimRelationshipsInCurrentTransaction(db, row);
        }
        writeMeta(db, CLAIMS_BACKFILL_META_KEYS.relationshipsCursor, String(boundary));

        const report = inspectClaimsBackfillReconciliation(db);
        if (!report.ok) {
            throw new Error(
                `v84 eager backfill reconciliation refused: ${report.problems.join("; ")}`,
            );
        }
        hitClaimsMigrationFailpoint("claims-migration.030.reconcile.after");
        writeCompletionCheckpoint(db);
    });
}

// ---------------------------------------------------------------------------
// Lazy runner (R9, KTD9)
// ---------------------------------------------------------------------------

export function isRetryableSqliteBusyError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const candidate = error as { code?: unknown; errcode?: unknown };
    if (candidate.code === "SQLITE_BUSY" || candidate.code === "SQLITE_BUSY_SNAPSHOT") return true;
    return typeof candidate.errcode === "number" && (candidate.errcode & 0xff) === 5;
}

const DEFAULT_BUSY_RETRY_DELAYS_MS = [50, 100, 250, 500] as const;

export interface ClaimsBackfillRunOptions {
    batchSize?: number;
    retryDelaysMs?: readonly number[];
    sleep?: (delayMs: number) => Promise<void>;
    yieldToEventLoop?: () => Promise<void>;
    /**
     * Reset the checkpoint to the rows phase before running, bypassing the
     * blocked failure-set digest gate. The doctor retry sets this: an
     * operator-requested re-scan always re-derives from source, even from a
     * corrupt `complete` checkpoint.
     */
    forceReset?: boolean;
}

export type ClaimsBackfillRunStatus =
    | "not-applicable"
    | "complete"
    | "complete-with-warnings"
    | "blocked"
    | "pending";

export interface ClaimsBackfillRunSummary {
    status: ClaimsBackfillRunStatus;
    phaseBefore: ClaimsBackfillPhase | null;
    phaseAfter: ClaimsBackfillPhase | null;
    rowsAdopted: number;
    batches: number;
    problems: string[];
}

type BatchStep =
    | { kind: "worked" }
    | { kind: "advance" }
    | { kind: "phase-changed" }
    | { kind: "blocked"; problems: string[] }
    | { kind: "skip-reset"; problems: string[] }
    | { kind: "drained" }
    | { kind: "complete"; warnings: number };

/**
 * Resume the lazy backfill until it completes, blocks, or exhausts busy
 * retries. Safe to run concurrently from multiple processes: every batch
 * reselects its work under the immediate write lock, adoption anchors on the
 * crosswalk and operation envelope, and phase transitions re-check state
 * inside the same transaction.
 */
export async function runClaimsBackfill(
    db: Database,
    options: ClaimsBackfillRunOptions = {},
): Promise<ClaimsBackfillRunSummary> {
    const summary: ClaimsBackfillRunSummary = {
        status: "pending",
        phaseBefore: null,
        phaseAfter: null,
        rowsAdopted: 0,
        batches: 0,
        problems: [],
    };
    if (!hasMemoryClaimsCompatSchema(db)) {
        summary.status = "not-applicable";
        return summary;
    }
    const initial = readClaimsBackfillState(db);
    summary.phaseBefore = initial.phase;
    summary.phaseAfter = initial.phase;
    if (initial.mode === null) {
        summary.status = "not-applicable";
        return summary;
    }
    const forceReset = options.forceReset === true;
    if (initial.phase === "complete" && !forceReset) {
        const report = inspectClaimsBackfillReconciliation(db, initial);
        summary.status = report.ok
            ? report.warningCount > 0
                ? "complete-with-warnings"
                : "complete"
            : "blocked";
        summary.problems = report.problems;
        return summary;
    }

    const batchSize = options.batchSize ?? CLAIMS_BACKFILL_BATCH_SIZE;
    const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_BUSY_RETRY_DELAYS_MS;
    const sleep =
        options.sleep ??
        ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
    const yieldToEventLoop =
        options.yieldToEventLoop ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));

    /** Whole-batch immediate transaction with bounded busy backoff (R9). */
    const runBatch = async (work: () => BatchStep): Promise<BatchStep | "busy"> => {
        for (let attempt = 0; ; attempt += 1) {
            try {
                const step = db
                    .transaction(() =>
                        withMemoryClaimGenerationContextInCurrentTransaction(db, work),
                    )
                    .immediate();
                hitFailpoint("claims-backfill.020.batch-commit.after");
                return step;
            } catch (error) {
                if (!isRetryableSqliteBusyError(error)) throw error;
                const delayMs = retryDelaysMs[attempt];
                if (delayMs === undefined) return "busy";
                await sleep(delayMs);
            }
        }
    };

    const rowsBatch = (): BatchStep => {
        const phase = readMeta(db, CLAIMS_BACKFILL_META_KEYS.phase);
        if (phase !== "rows") return { kind: "phase-changed" };
        const state = readClaimsBackfillState(db);
        const ids = selectUnlinkedBoundaryRowIds(
            db,
            state.rowsCursor,
            state.boundaryMemoryId,
            batchSize,
        );
        if (ids.length === 0) {
            sweepResolvedRowFailures(db);
            const unlinked = countUnlinkedBoundaryRows(db, state.boundaryMemoryId);
            const linked = countBoundaryCrosswalkRows(db, state.boundaryMemoryId);
            if (unlinked === 0 && linked === state.expectedRowCount) {
                writeMeta(db, CLAIMS_BACKFILL_META_KEYS.phase, "relationships");
                return { kind: "advance" };
            }
            writeBlockedCheckpoint(db, state.boundaryMemoryId);
            return {
                kind: "blocked",
                problems:
                    unlinked > 0
                        ? [`${unlinked} boundary memory row(s) could not be linked`]
                        : [
                              `boundary crosswalk count ${linked} does not equal expected ${state.expectedRowCount}`,
                          ],
            };
        }
        for (const id of ids) {
            const row = readMemoryProjectionRow(db, id);
            if (!row) continue;
            if (adoptBoundaryMemoryRowInCurrentTransaction(db, row)) summary.rowsAdopted += 1;
        }
        writeMeta(db, CLAIMS_BACKFILL_META_KEYS.rowsCursor, String(ids[ids.length - 1]));
        hitFailpoint("claims-backfill.010.batch.after");
        return { kind: "worked" };
    };

    const relationshipsBatch = (): BatchStep => {
        const phase = readMeta(db, CLAIMS_BACKFILL_META_KEYS.phase);
        if (phase !== "relationships") return { kind: "phase-changed" };
        const state = readClaimsBackfillState(db);
        const rows = selectLineageRows(
            db,
            state.boundaryMemoryId,
            state.relationshipsCursor,
            batchSize,
        );
        if (rows.length === 0) {
            const blocking = countBoundaryFailures(
                db,
                ["blocking", "retry"],
                state.boundaryMemoryId,
                "relationships",
            );
            if (blocking === 0) {
                writeMeta(db, CLAIMS_BACKFILL_META_KEYS.phase, "reconciling");
                writeMeta(db, CLAIMS_BACKFILL_RECONCILE_CURSOR_META_KEY, "0");
                return { kind: "advance" };
            }
            writeBlockedCheckpoint(db, state.boundaryMemoryId);
            return {
                kind: "blocked",
                problems: [`${blocking} relationship failure(s) require repair`],
            };
        }
        for (const row of rows) {
            translateMemoryClaimRelationshipsInCurrentTransaction(db, row);
        }
        writeMeta(
            db,
            CLAIMS_BACKFILL_META_KEYS.relationshipsCursor,
            String(rows[rows.length - 1].id),
        );
        hitFailpoint("claims-backfill.010.batch.after");
        return { kind: "worked" };
    };

    /**
     * Reconciling, part one: bounded lineage re-translation. Rows may have
     * changed after the relationships cursor passed them, so the boundary
     * lineage set re-derives through the idempotent kernel — one batch per
     * transaction, so the write lock is held for ~batchSize rows instead of
     * the whole corpus. `drained` hands control to the completion decision.
     */
    const reconcileTranslationBatch = (): BatchStep => {
        const phase = readMeta(db, CLAIMS_BACKFILL_META_KEYS.phase);
        if (phase !== "reconciling") return { kind: "phase-changed" };
        const state = readClaimsBackfillState(db);
        const cursor = readIntMeta(db, CLAIMS_BACKFILL_RECONCILE_CURSOR_META_KEY);
        const rows = selectLineageRows(db, state.boundaryMemoryId, cursor, batchSize);
        if (rows.length === 0) {
            sweepResolvedRowFailures(db);
            return { kind: "drained" };
        }
        for (const row of rows) {
            translateMemoryClaimRelationshipsInCurrentTransaction(db, row);
        }
        writeMeta(db, CLAIMS_BACKFILL_RECONCILE_CURSOR_META_KEY, String(rows[rows.length - 1].id));
        hitFailpoint("claims-backfill.010.batch.after");
        return { kind: "worked" };
    };

    /**
     * Reconciling, part two: the completion decision (R11). The caller runs
     * the read-only oracle OUTSIDE the write lock and passes its report in;
     * this short immediate transaction re-verifies the decisive conditions —
     * phase unchanged, zero unlinked boundary rows, zero boundary-scoped
     * blocking failures, no pending v22 takeover — so a write racing between
     * the oracle read and this commit cannot certify a stale state, then
     * publishes the completion checkpoint.
     */
    const finalizeReconciliation = (report: ClaimsBackfillReconciliationReport): BatchStep => {
        const phase = readMeta(db, CLAIMS_BACKFILL_META_KEYS.phase);
        if (phase !== "reconciling") return { kind: "phase-changed" };
        const state = readClaimsBackfillState(db);
        if (!report.ok) {
            writeBlockedCheckpoint(db, state.boundaryMemoryId);
            return { kind: "blocked", problems: report.problems };
        }
        const unlinked = countUnlinkedBoundaryRows(db, state.boundaryMemoryId);
        const blocking = countBoundaryFailures(db, ["blocking", "retry"], state.boundaryMemoryId);
        if (unlinked > 0 || blocking > 0 || state.v22Takeover === "pending") {
            // The corpus changed between the oracle read and this
            // transaction; fall back to the rows phase to re-derive. Every
            // cursor resets with the phase: the batch queries select strictly
            // above their cursor, so a stale cursor would hide the very rows
            // the fallback exists to re-observe and the re-derive would
            // re-block with an unchanged failure digest.
            writeMeta(db, CLAIMS_BACKFILL_META_KEYS.phase, "rows");
            writeMeta(db, CLAIMS_BACKFILL_META_KEYS.rowsCursor, "0");
            writeMeta(db, CLAIMS_BACKFILL_META_KEYS.relationshipsCursor, "0");
            writeMeta(db, CLAIMS_BACKFILL_RECONCILE_CURSOR_META_KEY, "0");
            return { kind: "advance" };
        }
        writeCompletionCheckpoint(db);
        hitFailpoint("claims-backfill.030.complete.before");
        return { kind: "complete", warnings: report.warningCount };
    };

    // A blocked checkpoint re-derives from source: reset to the rows phase so
    // repaired identities, restored targets, and operator dispositions are
    // re-observed without a bespoke repair scan. The reset is gated on the
    // boundary-scoped blocking failure set having changed since the blocked
    // checkpoint: a persistently blocked database otherwise re-scans the
    // whole corpus on every start. forceReset (the doctor retry) bypasses the
    // gate and re-derives from any phase, including a corrupt `complete`.
    if (initial.phase === "blocked" || forceReset) {
        const reset = await runBatch((): BatchStep => {
            const phase = readMeta(db, CLAIMS_BACKFILL_META_KEYS.phase);
            if (phase === null) return { kind: "phase-changed" };
            if (!forceReset && phase !== "blocked") return { kind: "phase-changed" };
            const state = readClaimsBackfillState(db);
            // Sweep first so a row linked by a live writer since the blocked
            // checkpoint leaves the blocking set and changes the digest.
            sweepResolvedRowFailures(db);
            const digest = computeBlockedFailureDigest(db, state.boundaryMemoryId);
            if (!forceReset && digest === readMeta(db, CLAIMS_BACKFILL_BLOCKED_DIGEST_META_KEY)) {
                const blocking = countBoundaryFailures(
                    db,
                    ["blocking", "retry"],
                    state.boundaryMemoryId,
                );
                return {
                    kind: "skip-reset",
                    problems: [
                        `${blocking} blocking failure(s) unchanged since the last blocked run; repair or waive them, or force a re-scan with the doctor retry`,
                    ],
                };
            }
            writeMeta(db, CLAIMS_BACKFILL_BLOCKED_DIGEST_META_KEY, digest);
            writeMeta(db, CLAIMS_BACKFILL_META_KEYS.phase, "rows");
            writeMeta(db, CLAIMS_BACKFILL_META_KEYS.rowsCursor, "0");
            writeMeta(db, CLAIMS_BACKFILL_META_KEYS.relationshipsCursor, "0");
            writeMeta(db, CLAIMS_BACKFILL_RECONCILE_CURSOR_META_KEY, "0");
            return { kind: "advance" };
        });
        if (reset === "busy") {
            summary.status = "pending";
            return summary;
        }
        if (reset.kind === "skip-reset") {
            summary.status = "blocked";
            summary.problems = reset.problems;
            return summary;
        }
    }

    while (true) {
        const phase = readMeta(db, CLAIMS_BACKFILL_META_KEYS.phase) as ClaimsBackfillPhase | null;
        summary.phaseAfter = phase;
        if (phase === "complete") {
            const report = inspectClaimsBackfillReconciliation(db);
            summary.status = report.ok
                ? report.warningCount > 0
                    ? "complete-with-warnings"
                    : "complete"
                : "blocked";
            summary.problems = report.problems;
            return summary;
        }
        if (phase === "blocked" || phase === null) {
            summary.status = "blocked";
            return summary;
        }
        let step: BatchStep | "busy";
        if (phase === "reconciling") {
            step = await runBatch(reconcileTranslationBatch);
            if (step !== "busy" && step.kind === "drained") {
                summary.batches += 1;
                // The oracle is read-only: run it outside the write lock,
                // then decide inside one short transaction (R11).
                const report = inspectClaimsBackfillReconciliation(db);
                hitFailpoint("claims-backfill.025.reconcile-oracle.after");
                step = await runBatch(() => finalizeReconciliation(report));
            }
        } else {
            step = await runBatch(phase === "rows" ? rowsBatch : relationshipsBatch);
        }
        if (step === "busy") {
            summary.status = "pending";
            return summary;
        }
        summary.batches += 1;
        if (step.kind === "blocked") {
            summary.problems = step.problems;
            summary.phaseAfter = "blocked";
            summary.status = "blocked";
            return summary;
        }
        if (step.kind === "complete") {
            hitFailpoint("claims-backfill.040.complete.after");
            summary.phaseAfter = "complete";
            summary.status = step.warnings > 0 ? "complete-with-warnings" : "complete";
            return summary;
        }
        await yieldToEventLoop();
    }
}

// ---------------------------------------------------------------------------
// Operational status and doctor recovery (AE10)
// ---------------------------------------------------------------------------

export type ClaimsBackfillOperationalState =
    | "not-applicable"
    | "pending"
    | "blocked"
    | "complete"
    | "complete-with-warnings";

export interface ClaimsBackfillStatusReport {
    applicable: boolean;
    state: ClaimsBackfillOperationalState;
    mode: ClaimsBackfillMode | null;
    phase: ClaimsBackfillPhase | null;
    boundaryMemoryId: number;
    expectedRowCount: number;
    linkedBoundaryRows: number;
    blockingFailures: number;
    warningFailures: number;
    v22Takeover: string | null;
    reconciliationVersion: string | null;
    finalOutboxWatermark: number;
    calibrationDigest: string | null;
    /** Why the recorded v84 mode was selected; null when the meta row is absent. */
    modeDecisionReason: string | null;
    /** Reconciliation problems, populated only when requested. */
    problems: string[];
}

export function getClaimsBackfillStatus(
    db: Database,
    options: { includeProblems?: boolean } = {},
): ClaimsBackfillStatusReport {
    if (!hasMemoryClaimsCompatSchema(db)) {
        return {
            applicable: false,
            state: "not-applicable",
            mode: null,
            phase: null,
            boundaryMemoryId: 0,
            expectedRowCount: 0,
            linkedBoundaryRows: 0,
            blockingFailures: 0,
            warningFailures: 0,
            v22Takeover: null,
            reconciliationVersion: null,
            finalOutboxWatermark: 0,
            calibrationDigest: null,
            modeDecisionReason: null,
            problems: [],
        };
    }
    const state = readClaimsBackfillState(db);
    const blocking = countFailures(db, ["blocking", "retry"]);
    const warnings = countFailures(db, ["warning"]);
    // The reported blockingFailures/warningFailures counts stay DB-wide (the
    // repair surface shows every open failure), but the operational-state
    // decision gates on the boundary corpus like the run/step paths: an
    // above-boundary failure belongs to live writers and must not flip a
    // non-complete phase to blocked (which would invite a wasteful doctor
    // force-reset) nor pin a complete phase to complete-with-warnings.
    const gatingBlocking = countBoundaryFailures(db, ["blocking", "retry"], state.boundaryMemoryId);
    const gatingWarnings = countBoundaryFailures(db, ["warning"], state.boundaryMemoryId);
    const reconciliation =
        options.includeProblems && state.mode !== null
            ? inspectClaimsBackfillReconciliation(db, state)
            : null;
    let operational: ClaimsBackfillOperationalState;
    if (state.mode === null) operational = "not-applicable";
    else if (state.phase === "complete" && reconciliation && !reconciliation.ok) {
        operational = "blocked";
    } else if (state.phase === "complete" && state.v22Takeover !== "pending") {
        operational = gatingWarnings > 0 ? "complete-with-warnings" : "complete";
    } else if (state.phase === "blocked" || gatingBlocking > 0 || state.v22Takeover === "pending") {
        operational = "blocked";
    } else operational = "pending";
    const problems = reconciliation?.problems ?? [];
    return {
        applicable: state.mode !== null,
        state: operational,
        mode: state.mode,
        phase: state.phase,
        boundaryMemoryId: state.boundaryMemoryId,
        expectedRowCount: state.expectedRowCount,
        linkedBoundaryRows: countBoundaryCrosswalkRows(db, state.boundaryMemoryId),
        blockingFailures: blocking,
        warningFailures: warnings,
        v22Takeover: state.v22Takeover,
        reconciliationVersion: state.reconciliationVersion,
        finalOutboxWatermark: state.finalOutboxWatermark,
        calibrationDigest: state.calibrationDigest,
        modeDecisionReason: state.modeDecisionReason,
        problems,
    };
}

export interface ClaimsBackfillFailureRecord {
    id: number;
    phase: string;
    itemKind: string;
    itemKey: string;
    reasonCode: string;
    detail: string;
    disposition: string;
    rationale: string | null;
}

export function listClaimsBackfillFailures(
    db: Database,
    options: { dispositions?: readonly string[]; limit?: number } = {},
): ClaimsBackfillFailureRecord[] {
    const dispositions = options.dispositions ?? ["blocking", "retry", "warning"];
    const placeholders = dispositions.map(() => "?").join(", ");
    return db
        .prepare(
            `SELECT id, phase, item_kind AS itemKind, item_key AS itemKey,
                    reason_code AS reasonCode, detail, disposition, rationale
               FROM claim_backfill_failures
              WHERE disposition IN (${placeholders})
              ORDER BY id ASC LIMIT ?`,
        )
        .all(...dispositions, options.limit ?? 50) as ClaimsBackfillFailureRecord[];
}

export interface WarningDispositionResult {
    updated: boolean;
    error?: string;
}

/**
 * Operator-approved warning disposition for one diagnostic. Requires a
 * non-empty rationale; a resolved diagnostic cannot be reopened as a warning.
 */
export function recordClaimsBackfillWarningDisposition(
    db: Database,
    failureId: number,
    rationale: string,
): WarningDispositionResult {
    const trimmed = rationale.trim();
    if (trimmed.length === 0) {
        return { updated: false, error: "a warning disposition requires an operator rationale" };
    }
    const row = db
        .prepare(
            `SELECT phase, item_kind AS itemKind, reason_code AS reasonCode, disposition
               FROM claim_backfill_failures WHERE id = ?`,
        )
        .get(failureId) as
        | { phase: string; itemKind: string; reasonCode: string; disposition: string }
        | undefined;
    if (!row) return { updated: false, error: `no backfill failure with id ${failureId}` };
    if (row.disposition === "resolved") {
        return { updated: false, error: `failure ${failureId} is already resolved` };
    }
    const waivable =
        row.phase === "relationships" &&
        (row.itemKind === "lineage" || row.itemKind === "supersession") &&
        ["dangling-lineage", "malformed-lineage", "dangling-supersession"].includes(row.reasonCode);
    if (!waivable) {
        return {
            updated: false,
            error: `failure ${failureId} is not a waivable lineage diagnostic; repair its source invariant`,
        };
    }
    db.prepare(
        "UPDATE claim_backfill_failures SET disposition = 'warning', rationale = ?, updated_at = ? WHERE id = ?",
    ).run(trimmed, Date.now(), failureId);
    return { updated: true };
}

export interface ClaimsBackfillDoctorRetryResult {
    before: ClaimsBackfillStatusReport;
    after: ClaimsBackfillStatusReport;
    summary: ClaimsBackfillRunSummary | null;
}

/**
 * Doctor repair: rerun the lazy runner with `forceReset`, which resets the
 * checkpoint to the rows phase — bypassing the blocked failure-set digest
 * gate — so every failed item is re-derived through the kernel to a fresh
 * completion attempt. Idempotent: already-linked rows and recorded edges are
 * skipped by reselection, and no schema version changes.
 */
export async function doctorRetryClaimsBackfill(
    db: Database,
    options: ClaimsBackfillRunOptions = {},
): Promise<ClaimsBackfillDoctorRetryResult> {
    const before = getClaimsBackfillStatus(db, { includeProblems: true });
    if (
        !before.applicable ||
        before.state === "complete" ||
        before.state === "complete-with-warnings"
    ) {
        return { before, after: before, summary: null };
    }
    const summary = await runClaimsBackfill(db, { ...options, forceReset: true });
    return {
        before,
        after: getClaimsBackfillStatus(db, { includeProblems: true }),
        summary,
    };
}
