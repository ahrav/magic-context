import type { Database } from "../../shared/sqlite";
import type { EmbeddingPageReceipt } from "./memory/embedding-provider";
export { normalizedQueryHash, normalizeQueryText } from "./query-normalization";
export interface EmbeddingMeasurementInput {
    sessionId: string;
    projectPath: string;
    queryText: string;
    cohortKey: string;
    primaryResultIds: readonly string[];
    shadowResultIds: readonly string[];
    primaryLatencyMs: number | null;
    shadowLatencyMs: number | null;
    primaryFailed: boolean;
    shadowFailed: boolean;
    primaryModelId: string;
    shadowModelId: string;
    primaryFingerprint: string;
    shadowFingerprint: string;
    primaryEpoch: number;
    shadowEpoch: number;
    corpusHash: string;
    coverage: Record<string, unknown>;
}
export interface EmbeddingMeasurementRow {
    id: number;
    session_id: string;
    project_path: string;
    dedup_key: string;
    cohort_key: string;
    query_text_hash: string;
    primary_result_ids_json: string;
    shadow_result_ids_json: string;
    primary_latency_ms: number | null;
    shadow_latency_ms: number | null;
    primary_failed: number;
    shadow_failed: number;
    primary_model_id: string;
    shadow_model_id: string;
    primary_fingerprint: string;
    shadow_fingerprint: string;
    primary_epoch: number;
    shadow_epoch: number;
    corpus_hash: string;
    coverage_json: string;
    created_at: number;
}
/** Per-session row cap for the measurement corpus. Dedup is per
 *  (query, cohort), so every fingerprint/epoch transition opens a new cohort
 *  that re-records the session's queries; a long-lived session seeing many
 *  cohort transitions would otherwise grow the corpus without bound. When an
 *  insert pushes a session past the cap, its oldest rows are pruned. */
export declare const MEASUREMENT_CORPUS_SESSION_ROW_CAP = 2000;
export declare function recordEmbeddingMeasurement(db: Database, input: EmbeddingMeasurementInput): boolean;
export declare function listEmbeddingMeasurements(db: Database, sessionId: string): EmbeddingMeasurementRow[];
export type MeasurementOwnership = "opencode" | "pi" | "missing" | "ambiguous";
export interface OwnedMeasurementRow {
    id: number;
    sessionId: string;
    projectPath: string;
    queryTextHash: string;
    ownership: MeasurementOwnership;
}
/**
 * One keyset page of measurement rows joined to session ownership. Ownership
 * is correlated on (session_id, project_path): a session shared across
 * harnesses in DIFFERENT projects still resolves for the project the row was
 * recorded in; multiple harnesses for the SAME project stay `ambiguous`.
 * The measurement corpus grows with session count (bounded only per session),
 * so this API forces bounded reads: callers page with `afterId`/`limit`
 * instead of materializing the full history in one array.
 */
export declare function listMeasurementRowsWithOwnership(db: Database, page: {
    afterId: number;
    limit: number;
}): OwnedMeasurementRow[];
export type SynapseLedgerState = "pending" | "polling" | "ready" | "complete" | "failed" | "obsolete";
export type SynapseFailureDisposition = "retryable" | "permanent";
export interface SynapseLedgerManifestItem {
    id: string;
    contentSha256: string;
}
/** Context-complete identity of one provider page (R18). One live (non-obsolete)
 *  ledger row exists per identity tuple; the row id is the receipt identity. */
export interface SynapseLedgerPageIdentity {
    projectPath: string;
    sessionId: string;
    scope: "memory" | "commit" | "chunk";
    laneRole: "primary" | "shadow";
    destinationModel: string;
    applicationGroup: string;
    requestKey: string;
}
export interface SynapseLedgerPageInput extends SynapseLedgerPageIdentity {
    manifest: readonly SynapseLedgerManifestItem[];
    /** Absolute wall-clock deadline for every attempt at this page (R19/R21). */
    deadlineAt: number;
}
export interface SynapseLedgerPage extends SynapseLedgerPageIdentity {
    rowId: number;
    manifest: SynapseLedgerManifestItem[];
    state: SynapseLedgerState;
    stateVersion: number;
    attemptId: string | null;
    jobId: string | null;
    cursor: string | null;
    deadlineAt: number | null;
    restartCount: number;
    failureDisposition: SynapseFailureDisposition | null;
}
/** A CAS transition matched zero rows: the caller's snapshot is stale (or the
 *  transition's evidence — state, version, job, restart budget, deadline — no
 *  longer holds). Never a success; destination transactions must abort on it. */
export declare class SynapseLedgerConflictError extends Error {
    constructor(message: string);
}
export declare function getSynapseLedgerPage(db: Database, rowId: number): SynapseLedgerPage | null;
/** Exact-identity lookup of the one live row for a page. Never a scan: the
 *  ledger is not a work queue (R20); callers always know their page identity. */
export declare function findSynapseLedgerPage(db: Database, identity: SynapseLedgerPageIdentity): SynapseLedgerPage | null;
/** Create the page's ledger row in 'pending' with its absolute deadline
 *  persisted before any submission (R18/R19). Throws on a live duplicate. */
export declare function createSynapseLedgerPage(db: Database, input: SynapseLedgerPageInput): SynapseLedgerPage;
/** pending -> polling: persist attempt identity and the admitted job_id
 *  immediately after embed.batch admission (R19; KTD12 row 1). */
export declare function markSynapseLedgerPolling(db: Database, args: {
    rowId: number;
    expectedStateVersion: number;
    attemptId: string;
    jobId: string;
}): SynapseLedgerPage;
/** polling -> polling: record the replacement job after a restart resubmission. */
export declare function recordSynapseLedgerJob(db: Database, args: {
    rowId: number;
    expectedStateVersion: number;
    attemptId: string;
    jobId: string;
}): SynapseLedgerPage;
/** polling -> polling: diagnostic cursor checkpoint after a validated result
 *  page. Recovery never resumes from it — polling restarts at cursor null. */
export declare function recordSynapseLedgerCursor(db: Database, args: {
    rowId: number;
    expectedStateVersion: number;
    jobId: string;
    cursor: string;
}): SynapseLedgerPage;
/** polling -> polling on module_restarted: clear job/cursor and durably spend
 *  the single permitted restart, only inside the original deadline (R21). */
export declare function recordSynapseLedgerRestart(db: Database, args: {
    rowId: number;
    expectedStateVersion: number;
    jobId: string;
    now?: number;
}): SynapseLedgerPage;
/** polling -> ready after the exact requested item set validated (R22). */
export declare function markSynapseLedgerReady(db: Database, args: {
    rowId: number;
    expectedStateVersion: number;
    jobId: string;
}): SynapseLedgerPage;
/** pending|polling -> failed with an explicit retry disposition. */
export declare function markSynapseLedgerOutcome(db: Database, args: {
    rowId: number;
    expectedStateVersion: number;
    disposition: SynapseFailureDisposition;
}): SynapseLedgerPage;
/** failed -> pending for a new attempt: requires a retryable
 *  disposition and remaining time inside the original deadline (KTD12). */
export declare function retrySynapseLedgerPage(db: Database, args: {
    rowId: number;
    expectedStateVersion: number;
    now?: number;
}): SynapseLedgerPage;
/** ready -> complete. Call ONLY inside the destination transaction that
 *  writes the receipt's complete item set (R23): the thrown conflict on a
 *  stale version must abort that whole transaction. */
export declare function completeSynapseLedgerReceipt(db: Database, args: {
    rowId: number;
    expectedStateVersion: number;
}): SynapseLedgerPage;
/** complete -> pending. 'complete' is absorbing (R24): call ONLY from a
 *  destination-owning selector that, in this same transaction, proved the
 *  application group's destination rows absent or source/lane-stale and
 *  invalidated the group's surviving rows before retrying. */
export declare function reopenCompleteSynapseLedgerPage(db: Database, args: {
    rowId: number;
    expectedStateVersion: number;
    deadlineAt: number;
}): SynapseLedgerPage;
/** Any non-absorbing state -> obsolete (terminal). 'complete' is excluded:
 *  it can only leave through the destination-proof reopen (KTD12). */
export declare function markSynapseLedgerObsolete(db: Database, args: {
    rowId: number;
    expectedStateVersion: number;
}): SynapseLedgerPage;
export interface SynapseReceiptGroupExpectation {
    scope: "memory" | "commit" | "chunk";
    laneRole: "primary" | "shadow";
    /** Ledger destination model (the provider lane identity), not the storage model id. */
    destinationModel: string;
}
/**
 * Apply one application group's receipts atomically (R23, KTD13).
 *
 * Runs inside ONE SQLite transaction (a savepoint when the caller already
 * holds one — it never commits independently). Preflights the complete
 * receipt set, exact item coverage, per-item vectors, current source hashes,
 * and each ledger row's state/version/lane/model; then writes every
 * destination item via `writeDestination` and advances every contributing
 * receipt ready->complete. ANY failed guard, missing vector, or zero-row CAS
 * throws SynapseLedgerConflictError and rolls back destination and ledger
 * together. Proven source drift additionally retires the drifted rows to
 * 'obsolete' after the rollback (KTD12).
 */
export declare function applySynapseReceiptGroup(db: Database, args: {
    receipts: readonly EmbeddingPageReceipt[];
    expectation: SynapseReceiptGroupExpectation;
    /** Recompute the CURRENT source hash per item id, inside the transaction.
     *  A missing id means the source row is gone (drift). */
    readCurrentHashes: (ids: readonly string[]) => ReadonlyMap<string, string>;
    /** Write every destination item. Runs inside the same transaction. */
    writeDestination: () => void;
}): void;
/**
 * Reopen one application group's 'complete' pages with destination proof (R24).
 *
 * The group is the atomic application unit: `applySynapseReceiptGroup` writes
 * every destination row and completes every contributing page in ONE
 * transaction. 'complete' on a page therefore asserts that the whole group's
 * destination was written, so proving ANY page of the group absent or stale
 * falsifies that assertion for all of them: the sibling pages' surviving rows
 * are the residue of an application that has to be redone as a whole. Every
 * complete page in `rowIds` reopens together, and every item of every reopened
 * page is invalidated — including items whose row is still current, because a
 * destination row that outlives its receipt is exactly the split state the
 * ledger exists to prevent.
 *
 * Reopening only the pages that carry their own proof is what strands a group:
 * a sibling left 'complete' answers idempotency_conflict on every attempt, so
 * its receipt never returns and the group's item coverage is never met.
 *
 * All `destinationState` reads happen before the first `invalidateDestination`,
 * so one destination snapshot serves the whole proof. Returns the number of
 * pages reopened; 0 changes nothing — 'complete' stays absorbing for a group
 * whose destination is truthfully there.
 */
export declare function reopenCompleteSynapseLedgerGroupWithProof(db: Database, args: {
    /** Ledger rows of ONE application group. */
    rowIds: readonly number[];
    deadlineAt: number;
    destinationState: (item: SynapseLedgerManifestItem) => "absent" | "stale" | "current";
    /** Remove one item's destination row. */
    invalidateDestination: (item: SynapseLedgerManifestItem) => void;
}): number;
/** Retention for synapse_batch_ledger rows keyed by a project's synthetic
 *  sessions (primary `<projectIdentity>` and shadow `shadow:<projectIdentity>`).
 *  Real sessions prune their ledger rows when the session is deleted, but
 *  synthetic sessions are never deleted, so without a TTL their rows grow
 *  without bound over a long-lived project. 14 days matches the GC grace for
 *  stale embedding identities. */
export declare const SYNAPSE_BATCH_LEDGER_TTL_MS: number;
/** Delete a project's synthetic-session ledger rows whose last activity is
 *  older than the TTL. Runs on project (re)registration so a long-lived
 *  project prunes incrementally on every config load. */
export declare function pruneSynapseBatchLedgerForProject(db: Database, projectIdentity: string, ttlMs?: number): number;
//# sourceMappingURL=storage-embedding-measurements.d.ts.map