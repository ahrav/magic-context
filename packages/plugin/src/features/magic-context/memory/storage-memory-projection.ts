/**
 * Transaction-local legacy `memories` projection primitives for the v84
 * memory/claims kernel (KTD1). Exact SQL over the migrated v84 shape (every
 * column exists at v84), no transaction ownership, no cache invalidation, no
 * claim knowledge. The kernel imports this leaf plus the transaction-local
 * claim primitives; `storage-memory.ts` and harness adapters depend on the
 * kernel, never the reverse — so this module must not import
 * `storage-memory.ts`.
 *
 * Type-only imports keep this module loadable by the Node SQLite smoke
 * script, whose loader cannot resolve extensionless runtime imports.
 *
 * Every writer here assumes the caller already holds a write transaction with
 * the claims-write capability enabled; the v84 guards reject these statements
 * otherwise.
 */

import type { Database } from "../../../shared/sqlite";

export interface MemoryProjectionRow {
    id: number;
    project_path: string;
    category: string;
    content: string;
    normalized_hash: string;
    importance: number | null;
    scope: string;
    shareable: number;
    source_session_id: string | null;
    source_type: string;
    first_seen_at: number;
    created_at: number;
    updated_at: number;
    status: string;
    expires_at: number | null;
    verification_status: string;
    verified_at: number | null;
    superseded_by_memory_id: number | null;
    merged_from: string | null;
    metadata_json: string | null;
}

export interface MemoryProjectionInsert {
    projectPath: string;
    category: string;
    content: string;
    normalizedHash: string;
    importance?: number | null;
    sourceSessionId?: string | null;
    sourceType?: string;
    expiresAt?: number | null;
    metadataJson?: string | null;
    nowMs?: number;
}

const PROJECTION_COLUMNS = `id, project_path, category, content, normalized_hash, importance,
    scope, shareable, source_session_id, source_type, first_seen_at, created_at, updated_at,
    status, expires_at, verification_status, verified_at, superseded_by_memory_id,
    merged_from, metadata_json`;

function toSafeRowId(result: unknown): number {
    const rowid = (result as { lastInsertRowid?: number | bigint }).lastInsertRowid;
    const value = Number(rowid);
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`memories insert did not produce a safe row id: ${String(rowid)}`);
    }
    return value;
}

/** Safe-number change count for Bun/Node `number | bigint` parity. */
export function toSafeChangeCount(result: unknown): number {
    return Number((result as { changes?: number | bigint }).changes ?? 0);
}

export function readMemoryProjectionRow(db: Database, id: number): MemoryProjectionRow | null {
    return (db.prepare(`SELECT ${PROJECTION_COLUMNS} FROM memories WHERE id = ?`).get(id) ??
        null) as MemoryProjectionRow | null;
}

/**
 * Insert one projection row with the legacy defaults. The v80
 * `memories_stats_ai` trigger creates the stats baseline and the FTS trigger
 * indexes the content, exactly as the legacy writer relied on.
 */
export function insertMemoryProjectionRow(db: Database, input: MemoryProjectionInsert): number {
    const now = input.nowMs ?? Date.now();
    return toSafeRowId(
        db
            .prepare(
                `INSERT INTO memories
                    (project_path, category, content, normalized_hash, importance,
                     source_session_id, source_type, seen_count, retrieval_count,
                     first_seen_at, created_at, updated_at, last_seen_at, last_retrieved_at,
                     status, expires_at, verification_status, verified_at,
                     superseded_by_memory_id, merged_from, metadata_json)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?, NULL, 'active', ?, 'unverified', NULL, NULL, NULL, ?)`,
            )
            .run(
                input.projectPath,
                input.category,
                input.content,
                input.normalizedHash,
                input.importance ?? 50,
                input.sourceSessionId ?? null,
                input.sourceType ?? "historian",
                now,
                now,
                now,
                now,
                input.expiresAt ?? null,
                input.metadataJson ?? null,
            ),
    );
}

/**
 * Semantic content rewrite plus the derived-state invalidation the legacy
 * writer performs: the classify `shareable` verdict and `classified_at`
 * marker were scored against the OLD content, the mural cue was compressed
 * from it, and the embedding vector encodes it — all reset so nothing stale
 * survives the new content. Verification state is deliberately NOT reset
 * (locked by the migrated-v82 characterization tests).
 */
export function updateMemoryProjectionContent(
    db: Database,
    id: number,
    content: string,
    normalizedHash: string,
    nowMs?: number,
): void {
    db.prepare(
        `UPDATE memories
            SET content = ?, normalized_hash = ?, updated_at = ?, shareable = 0,
                classified_at = NULL, mural_cue = NULL, mural_cue_hash = NULL,
                mural_cue_at = NULL, mural_cue_rejection_count = 0
          WHERE id = ?`,
    ).run(content, normalizedHash, nowMs ?? Date.now(), id);
    db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(id);
}

export interface MemoryProjectionClassificationUpdate {
    importance?: number;
    scope?: string;
    shareable?: number;
}

/** Classification fields plus the classified_at run-gate stamp. */
export function updateMemoryProjectionClassification(
    db: Database,
    id: number,
    update: MemoryProjectionClassificationUpdate,
    nowMs?: number,
): void {
    const assignments: string[] = [];
    const values: Array<number | string> = [];
    if (update.importance !== undefined) {
        assignments.push("importance = ?");
        values.push(update.importance);
    }
    if (update.scope !== undefined) {
        assignments.push("scope = ?");
        values.push(update.scope);
    }
    if (update.shareable !== undefined) {
        assignments.push("shareable = ?");
        values.push(update.shareable);
    }
    assignments.push("classified_at = ?");
    values.push(nowMs ?? Date.now());
    db.prepare(`UPDATE memories SET ${assignments.join(", ")} WHERE id = ?`).run(...values, id);
}

/** Status transition; metadataJson replaces the stored metadata when given. */
export function updateMemoryProjectionStatus(
    db: Database,
    id: number,
    status: string,
    metadataJson: string | null | undefined,
    nowMs?: number,
): void {
    if (metadataJson === undefined) {
        db.prepare("UPDATE memories SET status = ?, updated_at = ? WHERE id = ?").run(
            status,
            nowMs ?? Date.now(),
            id,
        );
        return;
    }
    db.prepare(
        "UPDATE memories SET status = ?, metadata_json = ?, updated_at = ? WHERE id = ?",
    ).run(status, metadataJson, nowMs ?? Date.now(), id);
}

export function updateMemoryProjectionVerification(
    db: Database,
    id: number,
    verificationStatus: string,
    nowMs?: number,
): void {
    const now = nowMs ?? Date.now();
    db.prepare(
        `UPDATE memories
            SET verification_status = ?,
                verified_at = CASE WHEN ? = 'verified' THEN ? ELSE verified_at END,
                updated_at = ?
          WHERE id = ?`,
    ).run(verificationStatus, verificationStatus, now, now, id);
}

export function setMemoryProjectionSuperseded(
    db: Database,
    id: number,
    supersededByMemoryId: number,
    nowMs?: number,
): void {
    db.prepare(
        "UPDATE memories SET superseded_by_memory_id = ?, status = 'archived', updated_at = ? WHERE id = ?",
    ).run(supersededByMemoryId, nowMs ?? Date.now(), id);
}

/**
 * Merge-canonical base update. Counters live in `memory_stats`; a base row
 * without a stats row breaks the one-row-per-memory invariant and must abort
 * the caller's transaction rather than committing a merged marker alone.
 */
export function updateMemoryProjectionMerge(
    db: Database,
    id: number,
    mergedFrom: string,
    status: string,
    seenCount: number,
    retrievalCount: number,
    nowMs?: number,
): { baseChanges: number; statsChanges: number } {
    const now = nowMs ?? Date.now();
    const base = toSafeChangeCount(
        db
            .prepare("UPDATE memories SET merged_from = ?, status = ?, updated_at = ? WHERE id = ?")
            .run(mergedFrom, status, now, id),
    );
    const stats = toSafeChangeCount(
        db
            .prepare(
                "UPDATE memory_stats SET seen_count = ?, retrieval_count = ?, updated_at = ? WHERE memory_id = ?",
            )
            .run(seenCount, retrievalCount, now, id),
    );
    return { baseChanges: base, statsChanges: stats };
}

/**
 * Remove the projection row and its embedding. `memory_stats` and
 * `memory_verifications` FK-cascade off the base row.
 */
export function deleteMemoryProjectionRow(db: Database, id: number): void {
    db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(id);
    db.prepare("DELETE FROM memories WHERE id = ?").run(id);
}

/**
 * Replace one memory's `memory_verifications` rows. `verifiedAt = 0` records
 * a mapping (files known, not content-verified); a positive `verifiedAt`
 * records a content verification. Files must already be normalized; an empty
 * list writes the `""` no-file sentinel row.
 */
export function replaceMemoryProjectionVerificationFiles(
    db: Database,
    memoryId: number,
    files: readonly string[],
    verifiedAt: number,
    mappedAt: number,
): number {
    db.prepare("DELETE FROM memory_verifications WHERE memory_id = ?").run(memoryId);
    const insert = db.prepare(
        "INSERT INTO memory_verifications (memory_id, file_path, verified_at, mapped_at) VALUES (?, ?, ?, ?)",
    );
    const rows = files.length > 0 ? files : [""];
    for (const file of rows) {
        insert.run(memoryId, file, verifiedAt, mappedAt);
    }
    return rows.length;
}
