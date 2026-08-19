import type { Database } from "../../shared/sqlite";
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

export interface SynapseBatchLedgerInput {
    sessionId: string;
    projectPath: string;
    scope: "memory" | "commit" | "chunk";
    manifest: readonly { id: string; contentSha256: string }[];
    requestKey: string;
}

export function beginSynapseBatchLedger(db: Database, input: SynapseBatchLedgerInput): void {
    const now = Date.now();
    db.prepare(
        `INSERT INTO synapse_batch_ledger
            (session_id, project_path, scope, manifest_json, request_key, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
         ON CONFLICT(session_id, request_key) DO UPDATE SET
            manifest_json = excluded.manifest_json,
            updated_at = excluded.updated_at`,
    ).run(
        input.sessionId,
        input.projectPath,
        input.scope,
        JSON.stringify(input.manifest),
        input.requestKey,
        now,
        now,
    );
}

export function finishSynapseBatchLedger(
    db: Database,
    sessionId: string,
    requestKey: string,
    status: "complete" | "partial" | "failed",
): void {
    db.prepare(
        "UPDATE synapse_batch_ledger SET status = ?, updated_at = ? WHERE session_id = ? AND request_key = ?",
    ).run(status, Date.now(), sessionId, requestKey);
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
