import type { Database } from "../../shared/sqlite";
import type { EmbeddingPageReceipt } from "./memory/embedding-provider";
import { normalizedQueryHash } from "./query-normalization";

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
export const MEASUREMENT_CORPUS_SESSION_ROW_CAP = 2000;

export function recordEmbeddingMeasurement(
    db: Database,
    input: EmbeddingMeasurementInput,
): boolean {
    const queryTextHash = normalizedQueryHash(input.queryText);
    const dedupKey = queryTextHash;
    const result = db
        .prepare(
            `INSERT OR IGNORE INTO embedding_measurement_corpus
            (session_id, project_path, dedup_key, cohort_key, query_text_hash,
             primary_result_ids_json, shadow_result_ids_json, primary_latency_ms, shadow_latency_ms,
             primary_failed, shadow_failed, primary_model_id, shadow_model_id,
             primary_fingerprint, shadow_fingerprint, primary_epoch, shadow_epoch,
             corpus_hash, coverage_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
            input.sessionId,
            input.projectPath,
            dedupKey,
            input.cohortKey,
            queryTextHash,
            JSON.stringify(input.primaryResultIds.slice(0, 10)),
            JSON.stringify(input.shadowResultIds.slice(0, 10)),
            input.primaryLatencyMs,
            input.shadowLatencyMs,
            input.primaryFailed ? 1 : 0,
            input.shadowFailed ? 1 : 0,
            input.primaryModelId,
            input.shadowModelId,
            input.primaryFingerprint,
            input.shadowFingerprint,
            input.primaryEpoch,
            input.shadowEpoch,
            input.corpusHash,
            JSON.stringify(input.coverage),
            Date.now(),
        );
    if (result.changes > 0) {
        // Enforce the per-session cap only when a row was actually inserted
        // (INSERT OR IGNORE dedups repeat queries, the common case). One row
        // was just added, so at most one row overflows the cap; delete exactly
        // the oldest overflow rather than re-scanning the whole session.
        const rowCount = (
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM embedding_measurement_corpus WHERE session_id = ?",
                )
                .get(input.sessionId) as { count: number }
        ).count;
        const overflow = rowCount - MEASUREMENT_CORPUS_SESSION_ROW_CAP;
        if (overflow > 0) {
            db.prepare(
                `DELETE FROM embedding_measurement_corpus
                  WHERE session_id = ?
                    AND id IN (
                        SELECT id FROM embedding_measurement_corpus
                        WHERE session_id = ?
                        ORDER BY id ASC
                        LIMIT ?
                    )`,
            ).run(input.sessionId, input.sessionId, overflow);
        }
    }
    return result.changes > 0;
}

export function listEmbeddingMeasurements(
    db: Database,
    sessionId: string,
): EmbeddingMeasurementRow[] {
    return db
        .prepare("SELECT * FROM embedding_measurement_corpus WHERE session_id = ? ORDER BY id ASC")
        .all(sessionId) as EmbeddingMeasurementRow[];
}

export type MeasurementOwnership = "opencode" | "pi" | "missing" | "ambiguous";

export interface OwnedMeasurementRow {
    id: number;
    sessionId: string;
    projectPath: string;
    queryTextHash: string;
    ownership: MeasurementOwnership;
}

function classifyOwnership(harnesses: string | null): MeasurementOwnership {
    if (!harnesses) return "missing";
    const distinct = harnesses.split(",").filter(Boolean);
    if (distinct.length !== 1) return "ambiguous";
    if (distinct[0] === "opencode") return "opencode";
    if (distinct[0] === "pi") return "pi";
    return "ambiguous";
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
export function listMeasurementRowsWithOwnership(
    db: Database,
    page: { afterId: number; limit: number },
): OwnedMeasurementRow[] {
    const rows = db
        .prepare(
            `SELECT m.id, m.session_id, m.project_path, m.query_text_hash,
                    (SELECT GROUP_CONCAT(DISTINCT sp.harness)
                       FROM session_projects sp
                      WHERE sp.session_id = m.session_id
                        AND sp.project_path = m.project_path) AS harnesses
               FROM embedding_measurement_corpus m
              WHERE m.id > ?
              ORDER BY m.id ASC
              LIMIT ?`,
        )
        .all(page.afterId, Math.max(1, Math.floor(page.limit))) as Array<{
        id: number;
        session_id: string;
        project_path: string;
        query_text_hash: string;
        harnesses: string | null;
    }>;
    return rows.map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        projectPath: row.project_path,
        queryTextHash: row.query_text_hash,
        ownership: classifyOwnership(row.harnesses),
    }));
}

export type SynapseLedgerState =
    | "pending"
    | "polling"
    | "ready"
    | "complete"
    | "failed"
    | "obsolete";

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
export class SynapseLedgerConflictError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SynapseLedgerConflictError";
    }
}

interface RawLedgerRow {
    id: number;
    project_path: string;
    session_id: string;
    scope: string;
    lane_role: string;
    destination_model: string;
    application_group: string;
    request_key: string;
    manifest_json: string;
    state: string;
    state_version: number;
    attempt_id: string | null;
    job_id: string | null;
    cursor: string | null;
    deadline_at: number | null;
    restart_count: number;
    failure_disposition: string | null;
}

function toLedgerPage(row: RawLedgerRow): SynapseLedgerPage {
    let manifest: SynapseLedgerManifestItem[] = [];
    try {
        const parsed = JSON.parse(row.manifest_json);
        if (Array.isArray(parsed)) {
            manifest = parsed.filter(
                (entry): entry is SynapseLedgerManifestItem =>
                    entry !== null &&
                    typeof entry === "object" &&
                    typeof entry.id === "string" &&
                    typeof entry.contentSha256 === "string",
            );
        }
    } catch {
        manifest = [];
    }
    return {
        rowId: row.id,
        projectPath: row.project_path,
        sessionId: row.session_id,
        scope: row.scope as SynapseLedgerPageIdentity["scope"],
        laneRole: row.lane_role as SynapseLedgerPageIdentity["laneRole"],
        destinationModel: row.destination_model,
        applicationGroup: row.application_group,
        requestKey: row.request_key,
        manifest,
        state: row.state as SynapseLedgerState,
        stateVersion: row.state_version,
        attemptId: row.attempt_id,
        jobId: row.job_id,
        cursor: row.cursor,
        deadlineAt: row.deadline_at,
        restartCount: row.restart_count,
        failureDisposition: row.failure_disposition as SynapseFailureDisposition | null,
    };
}

export function getSynapseLedgerPage(db: Database, rowId: number): SynapseLedgerPage | null {
    const row = db
        .prepare("SELECT * FROM synapse_batch_ledger WHERE id = ?")
        .get(rowId) as RawLedgerRow | null;
    return row ? toLedgerPage(row) : null;
}

/** Exact-identity lookup of the one live row for a page. Never a scan: the
 *  ledger is not a work queue (R20); callers always know their page identity. */
export function findSynapseLedgerPage(
    db: Database,
    identity: SynapseLedgerPageIdentity,
): SynapseLedgerPage | null {
    const row = db
        .prepare(
            `SELECT * FROM synapse_batch_ledger
              WHERE project_path = ? AND session_id = ? AND scope = ? AND lane_role = ?
                AND destination_model = ? AND application_group = ? AND request_key = ?
                AND state != 'obsolete'`,
        )
        .get(
            identity.projectPath,
            identity.sessionId,
            identity.scope,
            identity.laneRole,
            identity.destinationModel,
            identity.applicationGroup,
            identity.requestKey,
        ) as RawLedgerRow | null;
    return row ? toLedgerPage(row) : null;
}

/** Create the page's ledger row in 'pending' with its absolute deadline
 *  persisted before any submission (R18/R19). Throws on a live duplicate. */
export function createSynapseLedgerPage(
    db: Database,
    input: SynapseLedgerPageInput,
): SynapseLedgerPage {
    const now = Date.now();
    let result: { lastInsertRowid: number | bigint };
    try {
        result = db
            .prepare(
                `INSERT INTO synapse_batch_ledger
                    (project_path, session_id, scope, lane_role, destination_model,
                     application_group, request_key, manifest_json, state, state_version,
                     deadline_at, restart_count, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, 0, ?, ?)`,
            )
            .run(
                input.projectPath,
                input.sessionId,
                input.scope,
                input.laneRole,
                input.destinationModel,
                input.applicationGroup,
                input.requestKey,
                JSON.stringify(input.manifest),
                input.deadlineAt,
                now,
                now,
            );
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/UNIQUE constraint failed/i.test(message)) {
            throw new SynapseLedgerConflictError(
                `synapse ledger page already live for request_key ${input.requestKey}`,
            );
        }
        throw error;
    }
    const page = getSynapseLedgerPage(db, Number(result.lastInsertRowid));
    if (!page) throw new SynapseLedgerConflictError("synapse ledger insert vanished");
    return page;
}

interface CasExpectation {
    rowId: number;
    stateVersion: number;
    states: readonly SynapseLedgerState[];
    jobId?: string;
    extraWhere?: string;
    extraParams?: readonly unknown[];
}

/** Core versioned CAS: match row id + expected state version + allowed prior
 *  states (+ optional job identity), bump state_version. Zero rows changed is
 *  a hard SynapseLedgerConflictError, never success (KTD12). */
function casLedgerUpdate(
    db: Database,
    expectation: CasExpectation,
    sets: Record<string, unknown>,
): SynapseLedgerPage {
    const setEntries = Object.entries(sets);
    const setSql = setEntries.map(([column]) => `${column} = ?`).join(", ");
    const statePlaceholders = expectation.states.map(() => "?").join(", ");
    const jobClause = expectation.jobId === undefined ? "" : " AND job_id = ?";
    const extraClause = expectation.extraWhere ? ` AND ${expectation.extraWhere}` : "";
    const params: unknown[] = [
        ...setEntries.map(([, value]) => value),
        Date.now(),
        expectation.rowId,
        expectation.stateVersion,
        ...expectation.states,
    ];
    if (expectation.jobId !== undefined) params.push(expectation.jobId);
    params.push(...(expectation.extraParams ?? []));
    const changes = db
        .prepare(
            `UPDATE synapse_batch_ledger
                SET ${setSql}, state_version = state_version + 1, updated_at = ?
              WHERE id = ? AND state_version = ? AND state IN (${statePlaceholders})${jobClause}${extraClause}`,
        )
        .run(...params).changes;
    if (changes !== 1) {
        throw new SynapseLedgerConflictError(
            `synapse ledger CAS matched ${changes} rows for row ${expectation.rowId} at version ${expectation.stateVersion}`,
        );
    }
    const page = getSynapseLedgerPage(db, expectation.rowId);
    if (!page) throw new SynapseLedgerConflictError("synapse ledger row vanished after CAS");
    return page;
}

/** pending -> polling: persist attempt identity and the admitted job_id
 *  immediately after embed.batch admission (R19; KTD12 row 1). */
export function markSynapseLedgerPolling(
    db: Database,
    args: { rowId: number; expectedStateVersion: number; attemptId: string; jobId: string },
): SynapseLedgerPage {
    return casLedgerUpdate(
        db,
        { rowId: args.rowId, stateVersion: args.expectedStateVersion, states: ["pending"] },
        { state: "polling", attempt_id: args.attemptId, job_id: args.jobId, cursor: null },
    );
}

/** polling -> polling: record the replacement job after a restart resubmission. */
export function recordSynapseLedgerJob(
    db: Database,
    args: { rowId: number; expectedStateVersion: number; attemptId: string; jobId: string },
): SynapseLedgerPage {
    return casLedgerUpdate(
        db,
        { rowId: args.rowId, stateVersion: args.expectedStateVersion, states: ["polling"] },
        { attempt_id: args.attemptId, job_id: args.jobId, cursor: null },
    );
}

/** polling -> polling: diagnostic cursor checkpoint after a validated result
 *  page. Recovery never resumes from it — polling restarts at cursor null. */
export function recordSynapseLedgerCursor(
    db: Database,
    args: { rowId: number; expectedStateVersion: number; jobId: string; cursor: string },
): SynapseLedgerPage {
    return casLedgerUpdate(
        db,
        {
            rowId: args.rowId,
            stateVersion: args.expectedStateVersion,
            states: ["polling"],
            jobId: args.jobId,
        },
        { cursor: args.cursor },
    );
}

/** polling -> polling on module_restarted: clear job/cursor and durably spend
 *  the single permitted restart, only inside the original deadline (R21). */
export function recordSynapseLedgerRestart(
    db: Database,
    args: { rowId: number; expectedStateVersion: number; jobId: string; now?: number },
): SynapseLedgerPage {
    const now = args.now ?? Date.now();
    return casLedgerUpdate(
        db,
        {
            rowId: args.rowId,
            stateVersion: args.expectedStateVersion,
            states: ["polling"],
            jobId: args.jobId,
            extraWhere: "restart_count = 0 AND deadline_at IS NOT NULL AND deadline_at > ?",
            extraParams: [now],
        },
        { job_id: null, cursor: null, restart_count: 1 },
    );
}

/** polling -> ready after the exact requested item set validated (R22). */
export function markSynapseLedgerReady(
    db: Database,
    args: { rowId: number; expectedStateVersion: number; jobId: string },
): SynapseLedgerPage {
    return casLedgerUpdate(
        db,
        {
            rowId: args.rowId,
            stateVersion: args.expectedStateVersion,
            states: ["polling"],
            jobId: args.jobId,
        },
        { state: "ready" },
    );
}

/** pending|polling -> failed with an explicit retry disposition. */
export function markSynapseLedgerOutcome(
    db: Database,
    args: {
        rowId: number;
        expectedStateVersion: number;
        disposition: SynapseFailureDisposition;
    },
): SynapseLedgerPage {
    return casLedgerUpdate(
        db,
        {
            rowId: args.rowId,
            stateVersion: args.expectedStateVersion,
            states: ["pending", "polling"],
        },
        { state: "failed", failure_disposition: args.disposition },
    );
}

/** failed -> pending for a new attempt: requires a retryable
 *  disposition and remaining time inside the original deadline (KTD12). */
export function retrySynapseLedgerPage(
    db: Database,
    args: { rowId: number; expectedStateVersion: number; now?: number },
): SynapseLedgerPage {
    const now = args.now ?? Date.now();
    return casLedgerUpdate(
        db,
        {
            rowId: args.rowId,
            stateVersion: args.expectedStateVersion,
            states: ["failed"],
            extraWhere:
                "failure_disposition = 'retryable' AND deadline_at IS NOT NULL AND deadline_at > ?",
            extraParams: [now],
        },
        {
            state: "pending",
            attempt_id: null,
            job_id: null,
            cursor: null,
            failure_disposition: null,
        },
    );
}

/** ready -> complete. Call ONLY inside the destination transaction that
 *  writes the receipt's complete item set (R23): the thrown conflict on a
 *  stale version must abort that whole transaction. */
export function completeSynapseLedgerReceipt(
    db: Database,
    args: { rowId: number; expectedStateVersion: number },
): SynapseLedgerPage {
    return casLedgerUpdate(
        db,
        { rowId: args.rowId, stateVersion: args.expectedStateVersion, states: ["ready"] },
        { state: "complete", failure_disposition: null },
    );
}

/** complete -> pending. 'complete' is absorbing (R24): call ONLY from a
 *  destination-owning selector that, in this same transaction, proved the
 *  application group's destination rows absent or source/lane-stale and
 *  invalidated the group's surviving rows before retrying. */
export function reopenCompleteSynapseLedgerPage(
    db: Database,
    args: { rowId: number; expectedStateVersion: number; deadlineAt: number },
): SynapseLedgerPage {
    return casLedgerUpdate(
        db,
        { rowId: args.rowId, stateVersion: args.expectedStateVersion, states: ["complete"] },
        {
            state: "pending",
            attempt_id: null,
            job_id: null,
            cursor: null,
            deadline_at: args.deadlineAt,
            restart_count: 0,
            failure_disposition: null,
        },
    );
}

/** Any non-absorbing state -> obsolete (terminal). 'complete' is excluded:
 *  it can only leave through the destination-proof reopen (KTD12). */
export function markSynapseLedgerObsolete(
    db: Database,
    args: { rowId: number; expectedStateVersion: number },
): SynapseLedgerPage {
    return casLedgerUpdate(
        db,
        {
            rowId: args.rowId,
            stateVersion: args.expectedStateVersion,
            states: ["pending", "polling", "ready", "failed"],
        },
        { state: "obsolete" },
    );
}

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
export function applySynapseReceiptGroup(
    db: Database,
    args: {
        receipts: readonly EmbeddingPageReceipt[];
        expectation: SynapseReceiptGroupExpectation;
        /** Recompute the CURRENT source hash per item id, inside the transaction.
         *  A missing id means the source row is gone (drift). */
        readCurrentHashes: (ids: readonly string[]) => ReadonlyMap<string, string>;
        /** Write every destination item. Runs inside the same transaction. */
        writeDestination: () => void;
    },
): void {
    const { receipts, expectation } = args;
    if (receipts.length === 0) {
        throw new SynapseLedgerConflictError("cannot apply an empty receipt group");
    }
    const group = receipts[0].applicationGroup;
    const driftedRowIds = new Set<number>();
    try {
        db.transaction(() => {
            const manifestHashes = new Map<string, string>();
            const rowIdByItem = new Map<string, number>();
            for (const receipt of receipts) {
                if (receipt.applicationGroup !== group) {
                    throw new SynapseLedgerConflictError(
                        "receipts span more than one application group",
                    );
                }
                for (const item of receipt.items) {
                    if (manifestHashes.has(item.id)) {
                        throw new SynapseLedgerConflictError(
                            `item ${item.id} appears in two receipts of one group`,
                        );
                    }
                    manifestHashes.set(item.id, item.contentSha256);
                    rowIdByItem.set(item.id, receipt.rowId);
                    if (!receipt.vectors.has(item.id)) {
                        throw new SynapseLedgerConflictError(
                            `receipt ${receipt.rowId} is missing a vector for item ${item.id}`,
                        );
                    }
                }
            }
            for (const receipt of receipts) {
                const row = getSynapseLedgerPage(db, receipt.rowId);
                if (row?.state !== "ready" || row.stateVersion !== receipt.stateVersion) {
                    throw new SynapseLedgerConflictError(
                        `receipt ${receipt.rowId} is not ready at version ${receipt.stateVersion}`,
                    );
                }
                if (
                    row.scope !== expectation.scope ||
                    row.laneRole !== expectation.laneRole ||
                    row.destinationModel !== expectation.destinationModel ||
                    row.applicationGroup !== group
                ) {
                    throw new SynapseLedgerConflictError(
                        `receipt ${receipt.rowId} identity does not match the destination context`,
                    );
                }
            }
            const ids = [...manifestHashes.keys()];
            const current = args.readCurrentHashes(ids);
            // Walk the full manifest before throwing so every drifted
            // receipt's row is collected and the catch handler retires them
            // all in one pass instead of one per application attempt.
            const driftedItems: string[] = [];
            for (const [id, hash] of manifestHashes) {
                if (current.get(id) !== hash) {
                    driftedItems.push(id);
                    const rowId = rowIdByItem.get(id);
                    if (rowId !== undefined) driftedRowIds.add(rowId);
                }
            }
            if (driftedItems.length > 0) {
                throw new SynapseLedgerConflictError(
                    `source drifted for ${driftedItems.length} item(s), first: ${driftedItems[0]}`,
                );
            }
            args.writeDestination();
            for (const receipt of receipts) {
                completeSynapseLedgerReceipt(db, {
                    rowId: receipt.rowId,
                    expectedStateVersion: receipt.stateVersion,
                });
            }
        })();
    } catch (error) {
        for (const rowId of driftedRowIds) {
            const row = getSynapseLedgerPage(db, rowId);
            if (!row || row.state === "complete" || row.state === "obsolete") continue;
            try {
                markSynapseLedgerObsolete(db, { rowId, expectedStateVersion: row.stateVersion });
            } catch {
                // Best effort: a concurrent transition already moved the row.
            }
        }
        throw error;
    }
}

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
export function reopenCompleteSynapseLedgerGroupWithProof(
    db: Database,
    args: {
        /** Ledger rows of ONE application group. */
        rowIds: readonly number[];
        deadlineAt: number;
        destinationState: (item: SynapseLedgerManifestItem) => "absent" | "stale" | "current";
        /** Remove one item's destination row. */
        invalidateDestination: (item: SynapseLedgerManifestItem) => void;
    },
): number {
    let reopened = 0;
    db.transaction(() => {
        const pages: SynapseLedgerPage[] = [];
        for (const rowId of args.rowIds) {
            const page = getSynapseLedgerPage(db, rowId);
            if (page?.state === "complete") pages.push(page);
        }
        let proven = false;
        for (const page of pages) {
            for (const item of page.manifest) {
                if (args.destinationState(item) !== "current") proven = true;
            }
        }
        if (!proven) return;
        for (const page of pages) {
            for (const item of page.manifest) args.invalidateDestination(item);
            reopenCompleteSynapseLedgerPage(db, {
                rowId: page.rowId,
                expectedStateVersion: page.stateVersion,
                deadlineAt: args.deadlineAt,
            });
            reopened += 1;
        }
    })();
    return reopened;
}

/** Retention for synapse_batch_ledger rows keyed by a project's synthetic
 *  sessions (primary `<projectIdentity>` and shadow `shadow:<projectIdentity>`).
 *  Real sessions prune their ledger rows when the session is deleted, but
 *  synthetic sessions are never deleted, so without a TTL their rows grow
 *  without bound over a long-lived project. 14 days matches the GC grace for
 *  stale embedding identities. */
export const SYNAPSE_BATCH_LEDGER_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** Delete a project's synthetic-session ledger rows whose last activity is
 *  older than the TTL. Runs on project (re)registration so a long-lived
 *  project prunes incrementally on every config load. */
export function pruneSynapseBatchLedgerForProject(
    db: Database,
    projectIdentity: string,
    ttlMs: number = SYNAPSE_BATCH_LEDGER_TTL_MS,
): number {
    // Minimal test databases may not create the ledger table; skip there (the
    // same sqlite_master guard persistPrimaryDescriptor uses for descriptors).
    const ledgerTable = db
        .prepare(
            "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'synapse_batch_ledger'",
        )
        .get();
    if (!ledgerTable) return 0;
    return db
        .prepare("DELETE FROM synapse_batch_ledger WHERE session_id IN (?, ?) AND updated_at < ?")
        .run(projectIdentity, `shadow:${projectIdentity}`, Date.now() - ttlMs).changes;
}
