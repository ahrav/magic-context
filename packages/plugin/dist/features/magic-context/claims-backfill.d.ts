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
import { type MemoryProjectionRow } from "./memory/storage-memory-projection";
export declare const CLAIMS_BACKFILL_PRODUCER = "claims-backfill";
export declare const CLAIMS_BACKFILL_BATCH_SIZE = 25;
export declare const CLAIMS_BACKFILL_FAILPOINT_IDS: readonly ["claims-backfill.010.batch.after", "claims-backfill.020.batch-commit.after", "claims-backfill.030.complete.before", "claims-backfill.040.complete.after"];
export declare const CLAIMS_MIGRATION_FAILPOINT_IDS: readonly ["claims-migration.010.ddl.after", "claims-migration.020.rows.after", "claims-migration.030.reconcile.after", "claims-migration.040.version.after", "claims-migration.050.commit.after"];
/**
 * Concurrency seams, not crash sites: the process-crash matrix excludes
 * them. They let a test interleave a writer between two runner reads that
 * commit in separate transactions.
 */
export declare const CLAIMS_BACKFILL_CONCURRENCY_FAILPOINT_IDS: readonly ["claims-backfill.025.reconcile-oracle.after"];
export type ClaimsBackfillFailpointId = (typeof CLAIMS_BACKFILL_FAILPOINT_IDS)[number];
export type ClaimsMigrationFailpointId = (typeof CLAIMS_MIGRATION_FAILPOINT_IDS)[number];
type BackfillFailpointId = ClaimsBackfillFailpointId | ClaimsMigrationFailpointId | (typeof CLAIMS_BACKFILL_CONCURRENCY_FAILPOINT_IDS)[number];
export declare function setClaimsBackfillFailpoint(id: BackfillFailpointId, hook: (() => void) | null): void;
export declare function clearClaimsBackfillFailpoints(): void;
/** Called by migrations.ts at the v84 migration cut points. */
export declare function hitClaimsMigrationFailpoint(id: ClaimsMigrationFailpointId): void;
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
export declare const PRODUCTION_CLAIMS_BACKFILL_POLICY: ClaimsBackfillCalibratedPolicy | null;
/** Test/benchmark seam: pass null to restore the production policy. */
export declare function setClaimsBackfillCalibrationForTests(policy: ClaimsBackfillCalibratedPolicy | null, options?: {
    /**
     * Lets the calibration measurement harness force eager conversion at
     * scales above the ceiling so the ceiling itself stays evidence-backed.
     * Production reads only the shipped policy and never sets this.
     */
    bypassCutoffCeilingForMeasurement?: boolean;
}): void;
export declare function getActiveClaimsBackfillPolicy(): ClaimsBackfillCalibratedPolicy | null;
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
export declare const CLAIMS_BACKFILL_EAGER_CUTOFF_CEILING = 1000;
/**
 * A policy may enable eager mode only with a plausible evidence digest and a
 * cutoff at or below the measured lock-budget ceiling. The measurement
 * harness alone may lift the ceiling through its seam option; the shipped
 * production policy is always ceiling-checked.
 */
export declare function claimsBackfillPolicyIsCalibrated(policy: ClaimsBackfillCalibratedPolicy | null): policy is ClaimsBackfillCalibratedPolicy;
/** Canonical digest over a calibration measurement payload. */
export declare function computeClaimsBackfillEvidenceDigest(measurements: unknown): string;
/** Human-readable reason behind the recorded v84 mode decision (doctor status). */
export declare const CLAIMS_BACKFILL_MODE_REASON_META_KEY = "claims_backfill_mode_decision_reason";
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
export declare function readClaimsBackfillState(db: Database): ClaimsBackfillState;
export interface ClaimsBackfillModeDecision {
    mode: ClaimsBackfillMode;
    calibrationDigest: string;
    reason: string;
}
/**
 * Select the v84 conversion mode inside the migration transaction. Missing
 * calibration evidence, a corpus above the calibrated cutoff, unresolved v22
 * identity work, or an unconvertible row all force lazy mode.
 */
export declare function decideClaimsBackfillMode(db: Database, corpusCount: number, v22Pending: boolean): ClaimsBackfillModeDecision;
/**
 * Compat verification truth for one memory outside the projection columns:
 * the maximum `memory_verifications.verified_at`, or 0 when the row is
 * mapped-only or unmapped. Pre-v84 TypeScript verification writes a positive
 * `verified_at` only to this side table, never to the projection's
 * verification columns.
 */
export declare function readMemorySideTableVerifiedAt(db: Database, memoryId: number): number;
/**
 * Carry a memory's verified status onto its adopted claim as one
 * current-revision verified event. Positivity is
 * `memoryRowHasPositiveVerification`: the projection columns say verified,
 * or the `memory_verifications` side table carries a positive `verified_at`
 * (the only place pre-v84 TypeScript verification writes) — with explicit
 * projection revocations ('stale'/'flagged', or 'unverified' keeping a
 * positive `verified_at`) outranking stale side-table timestamps.
 * Mapped-only rows (no positive `verified_at` anywhere) record nothing.
 * Shared by the boundary backfill, relocation, and identity-merge adoption
 * sites; returns true when an event was recorded so callers can emit a
 * matching evidence effect.
 */
export declare function recordAdoptedMemoryVerifiedEventInCurrentTransaction(db: Database, row: Pick<MemoryProjectionRow, "id" | "verification_status" | "verified_at">, claimId: number, verifier: string): boolean;
/**
 * Adopt one boundary memory row: crosswalk plus revision 1 through the
 * kernel, one current-snapshot verification event for a positively verified
 * row (mapped-only rows keep their `memory_verifications` mappings with no
 * event), and one upsert outbox effect under the deterministic
 * `row:<memoryId>` operation envelope. Returns false and records a blocking
 * diagnostic when the row cannot form a claim.
 */
export declare function adoptBoundaryMemoryRowInCurrentTransaction(db: Database, row: MemoryProjectionRow): boolean;
export interface ClaimsBackfillReconciliationReport {
    ok: boolean;
    problems: string[];
    warningCount: number;
    /** Lifecycle-oracle mismatches folded into `warningCount`; broken out so
     *  the status surface can name the warning that has no failure row. */
    lifecycleMismatches: number;
    /** Live crosswalk rows whose projection hash diverges from the claim's
     *  current-revision hash metadata (shared-claim sibling edits); folded
     *  into `warningCount` and broken out like `lifecycleMismatches`. */
    contentDivergences: number;
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
export declare function inspectClaimsBackfillReconciliation(db: Database, state?: ClaimsBackfillState): ClaimsBackfillReconciliationReport;
/**
 * Convert the whole boundary corpus inside the caller-owned v84 migration
 * transaction: rows, relationships, then the reconciliation oracle. A failed
 * oracle throws, rolling the entire migration back to complete v82 state.
 */
export declare function runEagerClaimsBackfillInMigrationTransaction(db: Database): void;
export declare function isRetryableSqliteBusyError(error: unknown): boolean;
export declare const DEFAULT_BUSY_RETRY_DELAYS_MS: readonly [50, 100, 250, 500];
/**
 * One whole-batch immediate transaction with bounded SQLITE_BUSY backoff —
 * the retry scaffolding both backfills (v84 claims, v86 claim policy)
 * share, extracted so a backoff-schedule tuning lands once. Returns "busy"
 * after the delay schedule is exhausted; every other error rethrows.
 */
export declare function runImmediateTransactionWithBusyRetry<T>(db: Database, work: () => T, options?: {
    retryDelaysMs?: readonly number[];
    sleep?: (delayMs: number) => Promise<void>;
}): Promise<T | "busy">;
/** Synchronous twin of `runImmediateTransactionWithBusyRetry` for callers on
 * synchronous paths (the injection transform, module state sync) that cannot
 * await: bounded BLOCKING backoff instead of event-loop sleeps, so the
 * caller observes the commit before its next statement — a fire-and-forget
 * promise would let publication-sensitive readers proceed on the old state.
 * Returns "busy" after exhausting the delays, like the async variant. */
export declare function runImmediateTransactionWithBusyRetrySync<T>(db: Database, work: () => T, options?: {
    retryDelaysMs?: readonly number[];
}): T | "busy";
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
export type ClaimsBackfillRunStatus = "not-applicable" | "complete" | "complete-with-warnings" | "blocked" | "pending";
export interface ClaimsBackfillRunSummary {
    status: ClaimsBackfillRunStatus;
    phaseBefore: ClaimsBackfillPhase | null;
    phaseAfter: ClaimsBackfillPhase | null;
    rowsAdopted: number;
    batches: number;
    problems: string[];
}
/**
 * Resume the lazy backfill until it completes, blocks, or exhausts busy
 * retries. Safe to run concurrently from multiple processes: every batch
 * reselects its work under the immediate write lock, adoption anchors on the
 * crosswalk and operation envelope, and phase transitions re-check state
 * inside the same transaction.
 */
export declare function runClaimsBackfill(db: Database, options?: ClaimsBackfillRunOptions): Promise<ClaimsBackfillRunSummary>;
export type ClaimsBackfillOperationalState = "not-applicable" | "pending" | "blocked" | "complete" | "complete-with-warnings";
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
export declare function getClaimsBackfillStatus(db: Database, options?: {
    includeProblems?: boolean;
}): ClaimsBackfillStatusReport;
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
export declare function listClaimsBackfillFailures(db: Database, options?: {
    dispositions?: readonly string[];
    limit?: number;
}): ClaimsBackfillFailureRecord[];
export interface WarningDispositionResult {
    updated: boolean;
    error?: string;
}
/**
 * Operator-approved warning disposition for one diagnostic. Requires a
 * non-empty rationale; a resolved diagnostic cannot be reopened as a warning.
 */
export declare function recordClaimsBackfillWarningDisposition(db: Database, failureId: number, rationale: string): WarningDispositionResult;
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
export declare function doctorRetryClaimsBackfill(db: Database, options?: ClaimsBackfillRunOptions): Promise<ClaimsBackfillDoctorRetryResult>;
export {};
//# sourceMappingURL=claims-backfill.d.ts.map