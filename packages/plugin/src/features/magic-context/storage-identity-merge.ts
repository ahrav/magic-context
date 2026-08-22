import { randomUUID } from "node:crypto";
import type { Database } from "../../shared/sqlite";
import {
    readMemorySideTableVerifiedAt,
    recordAdoptedMemoryVerifiedEventInCurrentTransaction,
} from "./claims-backfill";
import {
    moveLinkedMemoryAcrossProjects,
    recordSkippedCollisionMergeDiagnostic,
    syncAdoptedClaimLifecycleState,
    syncAdoptedRelocationClaimState,
} from "./memory/relocate-memory";
import { hasMemoryStatsTable, requireEffectiveSeenCount } from "./memory/storage-memory";
import {
    computeClaimRequestDigest,
    ensureMemoryClaimLinkInCurrentTransaction,
    hasMemoryClaimsCompatSchema,
    type MemoryClaimEffect,
    memoryClaimAdoptionFailureReason,
    readMemoryClaimLink,
    recordMemoryClaimLinkFailure,
    recordMemoryClaimSupersessionInCurrentTransaction,
    resolveMemoryClaimProjectInCurrentTransaction,
    retireMemoryClaimInCurrentTransaction,
    runMemoryClaimOperationInCurrentTransaction,
    translateMemoryClaimRelationshipsInCurrentTransaction,
    updateMemoryClassificationWithClaimsInCurrentTransaction,
    withClaimsWriteCapabilityInCurrentTransaction,
    withMemoryClaimGenerationContextInCurrentTransaction,
} from "./memory/storage-memory-claims";
import { readMemoryProjectionRow } from "./memory/storage-memory-projection";
import {
    memoryLineagePresentSql,
    memoryRelationshipSourceMatchSql,
} from "./storage-memory-claims-schema";
import {
    applyIdentityMergeToProjectRegistry,
    discoverIdentityTables,
    type IdentityTableInfo,
    quoteIdentifier,
    tableExists,
} from "./storage-project-identities";

type SqliteRow = Record<string, unknown>;

type MergeAction = "rekeyed" | "superseded" | "collision_deleted";

export interface IdentityMergeTableReport {
    tableName: string;
    identityColumn: string;
    derived: boolean;
    sourceRows: number;
    changedRows: number;
}

export interface IdentityMergeReport {
    fromIdentity: string;
    toIdentity: string;
    auditedTables: IdentityMergeTableReport[];
    changedRows: number;
    dryRun: boolean;
}

function primaryKeyColumns(db: Database, tableName: string): string[] {
    const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all() as Array<{
        name?: unknown;
        pk?: unknown;
    }>;
    return columns
        .filter(
            (column) =>
                typeof column.name === "string" && typeof column.pk === "number" && column.pk > 0,
        )
        .sort((a, b) => Number(a.pk) - Number(b.pk))
        .map((column) => column.name as string);
}

function rowKey(db: Database, tableName: string, row: SqliteRow): string {
    const keys = primaryKeyColumns(db, tableName);
    if (keys.length === 1) return String(row[keys[0]]);
    if (keys.length > 1) return JSON.stringify(keys.map((key) => row[key]));
    return String(row.rowid ?? row.id ?? "");
}

function rowPredicate(
    db: Database,
    tableName: string,
    row: SqliteRow,
): { sql: string; values: unknown[] } {
    const keys = primaryKeyColumns(db, tableName);
    if (keys.length > 0) {
        return {
            sql: keys.map((key) => `${quoteIdentifier(key)} = ?`).join(" AND "),
            values: keys.map((key) => row[key]),
        };
    }
    return { sql: "rowid = ?", values: [row.rowid] };
}

function uniqueIndexes(db: Database, tableName: string): string[][] {
    const indexes = db.prepare(`PRAGMA index_list(${quoteIdentifier(tableName)})`).all() as Array<{
        name?: unknown;
        unique?: unknown;
    }>;
    const result: string[][] = [];
    for (const index of indexes) {
        if (index.unique !== 1 || typeof index.name !== "string") continue;
        const columns = db
            .prepare(`PRAGMA index_info(${quoteIdentifier(index.name)})`)
            .all() as Array<{
            name?: unknown;
            seqno?: unknown;
        }>;
        result.push(
            columns
                .sort((a, b) => Number(a.seqno) - Number(b.seqno))
                .map((column) => column.name)
                .filter((name): name is string => typeof name === "string"),
        );
    }
    return result;
}

function findUniqueCollision(
    db: Database,
    table: IdentityTableInfo,
    row: SqliteRow,
    fromIdentity: string,
    toIdentity: string,
): SqliteRow | null {
    const indexes = uniqueIndexes(db, table.name);
    for (const columns of indexes) {
        if (!columns.includes(table.identityColumn)) continue;
        const where = columns.map((column) => `${quoteIdentifier(column)} = ?`).join(" AND ");
        const values = columns.map((column) =>
            column === table.identityColumn ? toIdentity : row[column],
        );
        const candidate = db
            .prepare(`SELECT rowid, * FROM ${quoteIdentifier(table.name)} WHERE ${where} LIMIT 1`)
            .get(...values) as SqliteRow | undefined;
        if (candidate && rowKey(db, table.name, candidate) !== rowKey(db, table.name, row)) {
            return candidate;
        }
    }
    // A source row can be returned by a unique index lookup only when it is the
    // target identity itself. Treat that case as no collision so a repeated
    // operation remains an idempotent no-op.
    if (row[table.identityColumn] !== fromIdentity) return row;
    return null;
}

function logRow(
    db: Database,
    fromIdentity: string,
    toIdentity: string,
    tableName: string,
    rowId: string,
    action: MergeAction,
    targetRowId: string | null,
    mergedAt: number,
): void {
    db.prepare(
        `INSERT INTO identity_merge_log
            (from_identity, to_identity, table_name, row_id, action, target_row_id, merged_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(fromIdentity, toIdentity, tableName, rowId, action, targetRowId, mergedAt);
}

/**
 * Claim adoption for one merged memory row. Returns false only when a
 * collision merge must be skipped because the surviving target cannot adopt
 * the canonical claim; every other shape lets the caller's merge proceed.
 */
function adoptIdentityMergeRowClaims(
    db: Database,
    sourceId: number,
    collisionTargetId: number | null,
    toIdentity: string,
    mergedAt: number,
): boolean {
    const projectId = resolveMemoryClaimProjectInCurrentTransaction(db, toIdentity);
    if (projectId === null) {
        // The merge itself proceeds (boundary rows self-heal via lazy
        // backfill); the blocking diagnostic makes the skipped claim work
        // observable per row.
        recordMemoryClaimLinkFailure(db, sourceId, toIdentity, "unresolved-project-identity");
        return true;
    }
    const sourceRow = readMemoryProjectionRow(db, sourceId);
    if (!sourceRow) return true;
    const sourceFailure = memoryClaimAdoptionFailureReason(sourceRow, projectId);
    if (collisionTargetId === null) {
        if (sourceFailure !== null) {
            // An unadoptable source (empty content or claim-invalid metadata)
            // cannot link; record the blocking diagnostic and let the
            // caller's relationship-guard check decide whether the rekey
            // itself can still proceed.
            recordMemoryClaimLinkFailure(db, sourceId, toIdentity, sourceFailure);
            return true;
        }
        runMemoryClaimOperationInCurrentTransaction(
            db,
            {
                producer: "identity-merge",
                operationKey: `merge-row:${randomUUID()}`,
                requestDigest: computeClaimRequestDigest({
                    sourceId,
                    collisionTargetId,
                    toIdentity,
                }),
                // The random key can never be presented again, so a
                // zero-effect run (an already-linked no-delta row) has no
                // replay value and must not persist an operation row.
                ephemeral: true,
            },
            () => {
                const effects: MemoryClaimEffect[] = [];
                // Adoption must precede the caller's project_path UPDATE: an
                // unlinked boundary row would trip the v84 identity-move guard.
                const wasLinked = readMemoryClaimLink(db, sourceId) !== null;
                const link = ensureMemoryClaimLinkInCurrentTransaction(db, sourceRow, projectId, {
                    kind: "migration",
                });
                effects.push(
                    ...translateMemoryClaimRelationshipsInCurrentTransaction(db, sourceRow),
                );
                if (!wasLinked) {
                    effects.push({
                        effectKey: `memory:${sourceId}:upsert`,
                        projectId,
                        claimId: link.claimId,
                        effectType: "upsert" as const,
                    });
                }
                // Adoption can reuse a canonical claim archived by a prior
                // delete of the target-project equivalent; the sync
                // reactivates it from the row's status and carries the row's
                // verified state onto the claim as evidence.
                effects.push(
                    ...syncAdoptedRelocationClaimState(
                        db,
                        sourceRow,
                        link,
                        projectId,
                        "identity-merge",
                    ),
                );
                return { result: link.claimId, effects };
            },
        );
        return true;
    }
    const targetRow = readMemoryProjectionRow(db, collisionTargetId);
    if (!targetRow) return false;
    const targetFailure = memoryClaimAdoptionFailureReason(targetRow, projectId);
    if (targetFailure !== null) {
        // The caller archives the source row as superseded by this target; a
        // target that cannot carry the canonical claim would leave the source
        // claim active on suppressed history. Skip the merge for this row
        // with a blocking diagnostic instead of failing the whole merge.
        recordSkippedCollisionMergeDiagnostic(db, sourceId, collisionTargetId, targetFailure);
        return false;
    }
    runMemoryClaimOperationInCurrentTransaction(
        db,
        {
            producer: "identity-merge",
            operationKey: `merge-row:${randomUUID()}`,
            requestDigest: computeClaimRequestDigest({ sourceId, collisionTargetId, toIdentity }),
            // Same random-key contract as the non-collision envelope above.
            ephemeral: true,
        },
        () => {
            const effects: MemoryClaimEffect[] = [];
            const targetWasLinked = readMemoryClaimLink(db, collisionTargetId) !== null;
            const targetLink = ensureMemoryClaimLinkInCurrentTransaction(db, targetRow, projectId, {
                kind: "migration",
            });
            if (!targetWasLinked) {
                effects.push({
                    effectKey: `memory:${collisionTargetId}:upsert`,
                    projectId,
                    claimId: targetLink.claimId,
                    effectType: "upsert" as const,
                });
            }
            // Lifecycle half only: adoption can reuse a canonical claim
            // archived by a prior delete of the target-project equivalent,
            // and the sync reactivates it from the survivor's status. The
            // verification funnel below owns the survivor's verified event
            // (source transfer and fresh adoption share it), so the full
            // sync would double-record that event.
            effects.push(
                ...syncAdoptedClaimLifecycleState(
                    db,
                    targetRow,
                    targetLink,
                    projectId,
                    "identity-merge",
                ),
            );
            // Pre-v84 TypeScript verification writes a positive verified_at
            // only to the memory_verifications side table, so each side's
            // side-table maximum stands in when its projection columns are
            // unset.
            const sourceVerifiedAt =
                sourceRow.verification_status === "verified" && (sourceRow.verified_at ?? 0) > 0
                    ? (sourceRow.verified_at as number)
                    : readMemorySideTableVerifiedAt(db, sourceId);
            const targetProjectionVerified =
                targetRow.verification_status === "verified" && (targetRow.verified_at ?? 0) > 0;
            const targetVerifiedAt = targetProjectionVerified
                ? (targetRow.verified_at as number)
                : readMemorySideTableVerifiedAt(db, collisionTargetId);
            const adoptedVerifiedAt = Math.max(sourceVerifiedAt, targetVerifiedAt);
            if (
                (sourceVerifiedAt > 0 && !targetProjectionVerified) ||
                (!targetWasLinked && targetVerifiedAt > 0)
            ) {
                // Two verification transfers land on the survivor's claim: the
                // caller copies the source's verification mappings onto the
                // survivor with verified_at preserved (compat readers filter
                // on verified_at), and a freshly-adopted target's own
                // pre-existing verification would otherwise leave its new
                // claim eventless. Promote the survivor's projection columns
                // when they are unset and record one verified event on the
                // canonical claim so either path carries claim evidence; the
                // single funnel keeps a both-verified collision from
                // double-recording the bare-INSERT event.
                if (!targetProjectionVerified) {
                    db.prepare(
                        `UPDATE memories
                            SET verification_status = 'verified', verified_at = ?, updated_at = ?
                          WHERE id = ?`,
                    ).run(adoptedVerifiedAt, mergedAt, collisionTargetId);
                }
                if (
                    recordAdoptedMemoryVerifiedEventInCurrentTransaction(
                        db,
                        {
                            id: collisionTargetId,
                            verification_status: "verified",
                            verified_at: adoptedVerifiedAt,
                        },
                        targetLink.claimId,
                        "identity-merge",
                    )
                ) {
                    effects.push({
                        effectKey: `memory:${collisionTargetId}:evidence`,
                        projectId,
                        claimId: targetLink.claimId,
                        effectType: "evidence" as const,
                    });
                }
            }
            let sourceLink = readMemoryClaimLink(db, sourceId);
            if (!sourceLink) {
                if (sourceFailure === null) {
                    sourceLink = ensureMemoryClaimLinkInCurrentTransaction(
                        db,
                        sourceRow,
                        projectId,
                        { kind: "migration" },
                        { adoptDivergentContent: false },
                    );
                } else {
                    // An unadoptable source cannot form the duplicate
                    // crosswalk link; the archive below still proceeds and
                    // the skipped link stays observable as a blocking
                    // rows-phase diagnostic.
                    recordMemoryClaimLinkFailure(db, sourceId, toIdentity, sourceFailure);
                }
            }
            effects.push(...translateMemoryClaimRelationshipsInCurrentTransaction(db, sourceRow));
            if (sourceLink && sourceLink.claimId !== targetLink.claimId) {
                // A colliding source with its own claim retires it with
                // supersession lineage; two active claims must not survive for
                // one surviving fact.
                retireMemoryClaimInCurrentTransaction(db, sourceLink.claimId, "identity-merge");
                recordMemoryClaimSupersessionInCurrentTransaction(db, sourceLink, targetLink);
                effects.push({
                    effectKey: `memory:${sourceId}:lifecycle`,
                    projectId: sourceLink.projectId,
                    claimId: sourceLink.claimId,
                    effectType: "lifecycle" as const,
                });
            }
            return { result: targetLink.claimId, effects };
        },
    );
    return true;
}

/**
 * Mirror of the memories_claims_relationship_update_guard predicate: true
 * when a project_path rekey of this row would abort because the row carries
 * lineage with no matching relationship snapshot.
 */
function rekeyTripsRelationshipGuard(db: Database, memoryId: number): boolean {
    return Boolean(
        db
            .prepare(
                `SELECT 1 FROM memories m
                  WHERE m.id = ?
                    AND ${memoryLineagePresentSql("m")}
                    AND NOT ${memoryRelationshipSourceMatchSql("m")}`,
            )
            .get(memoryId),
    );
}

function mergeMemoryRow(
    db: Database,
    row: SqliteRow,
    fromIdentity: string,
    toIdentity: string,
    mergedAt: number,
): boolean {
    const sourceId = row.id;
    if (typeof sourceId !== "number") return false;
    const claimsActive = hasMemoryClaimsCompatSchema(db);
    const statsBacked = hasMemoryStatsTable(db);
    const effectiveSeenCount = (memoryId: number, baseValue: unknown): number => {
        if (!statsBacked) return Number(baseValue ?? 1);
        const stats = db
            .prepare("SELECT seen_count FROM memory_stats WHERE memory_id = ?")
            .get(memoryId) as { seen_count?: number } | undefined;
        // requireEffectiveSeenCount rejects a missing stats row as corruption —
        // a defaulted count would merge wrong telemetry and then delete the
        // source row.
        return requireEffectiveSeenCount(db, memoryId, stats?.seen_count);
    };
    const collision = db
        .prepare(
            `SELECT *
               FROM memories
              WHERE project_path = ? AND category = ? AND normalized_hash = ? AND id <> ?
              LIMIT 1`,
        )
        .get(toIdentity, row.category, row.normalized_hash, sourceId) as SqliteRow | undefined;
    if (collision && typeof collision.id === "number") {
        const targetId = collision.id;
        // Adoption derives the canonical claim's lifecycle from the target
        // row's status, and a NULL status derives archived. The survivor is
        // live by contract, so the status normalizes to 'active' before the
        // adoption pass — activating it afterwards would flip the projection
        // active while the claim stays archived, outside the kernel.
        db.prepare("UPDATE memories SET status = COALESCE(status, 'active') WHERE id = ?").run(
            targetId,
        );
        // An unadoptable collision target cannot anchor the canonical claim,
        // so the merge is skipped for this row (fail-visible diagnostic,
        // source row preserved) before any stats or verification mutation.
        if (
            claimsActive &&
            !adoptIdentityMergeRowClaims(db, sourceId, targetId, toIdentity, mergedAt)
        ) {
            return false;
        }
        const mergedSeen = Math.max(
            effectiveSeenCount(targetId, collision.seen_count),
            effectiveSeenCount(sourceId, row.seen_count),
        );
        const sourceClassifiedAt = Number(row.classified_at ?? 0);
        const targetClassifiedAt = Number(collision.classified_at ?? 0);
        if (sourceClassifiedAt > targetClassifiedAt) {
            if (claimsActive) {
                // The winning classification goes through the claims kernel:
                // it appends a same-content revision carrying the metadata and
                // emits the upsert effect on the survivor's project. A raw
                // projection UPDATE would leave the survivor's claim stale.
                // The kernel stamps classified_at from nowMs, so the survivor
                // inherits the source's newer classification timestamp.
                updateMemoryClassificationWithClaimsInCurrentTransaction(
                    db,
                    {
                        producer: "identity-merge",
                        operationKey: `merge-classification:${randomUUID()}`,
                        requestDigest: computeClaimRequestDigest({
                            sourceId,
                            targetId,
                            toIdentity,
                        }),
                    },
                    {
                        memoryId: targetId,
                        importance: row.importance as number,
                        scope: row.scope as string,
                        shareable: row.shareable as number,
                        nowMs: sourceClassifiedAt,
                    },
                );
            } else {
                db.prepare(
                    `UPDATE memories
                        SET importance = ?, scope = ?, shareable = ?, classified_at = ?
                      WHERE id = ?`,
                ).run(row.importance, row.scope, row.shareable, row.classified_at, targetId);
            }
        }
        const sourceHasCue = typeof row.mural_cue === "string" && row.mural_cue.length > 0;
        const targetHasCue =
            typeof collision.mural_cue === "string" && collision.mural_cue.length > 0;
        const sourceCueAt = Number(row.mural_cue_at ?? 0);
        const targetCueAt = Number(collision.mural_cue_at ?? 0);
        if (sourceHasCue && (!targetHasCue || sourceCueAt > targetCueAt)) {
            db.prepare(
                `UPDATE memories
                    SET mural_cue = ?, mural_cue_hash = ?, mural_cue_at = ?,
                        mural_cue_rejection_count = ?
                  WHERE id = ?`,
            ).run(
                row.mural_cue,
                row.mural_cue_hash,
                row.mural_cue_at,
                row.mural_cue_rejection_count,
                targetId,
            );
        }
        db.prepare(
            `INSERT INTO memory_verifications (memory_id, file_path, verified_at, mapped_at)
             SELECT ?, file_path, verified_at, mapped_at
               FROM memory_verifications
              WHERE memory_id = ?
             ON CONFLICT(memory_id, file_path) DO UPDATE SET
                verified_at = MAX(memory_verifications.verified_at, excluded.verified_at),
                mapped_at = MAX(memory_verifications.mapped_at, excluded.mapped_at)`,
        ).run(targetId, sourceId);
        db.prepare("DELETE FROM memory_verifications WHERE memory_id = ?").run(sourceId);
        if (statsBacked) {
            db.prepare("UPDATE memory_stats SET seen_count = ? WHERE memory_id = ?").run(
                mergedSeen,
                targetId,
            );
        } else {
            db.prepare("UPDATE memories SET seen_count = ? WHERE id = ?").run(mergedSeen, targetId);
        }
        db.prepare(
            `UPDATE memories
                SET status = 'archived',
                    superseded_by_memory_id = ?,
                    merged_from = CASE
                        WHEN merged_from IS NULL OR merged_from = '' THEN ?
                        ELSE merged_from || ',' || ?
                    END,
                    updated_at = ?
              WHERE id = ? AND project_path = ?`,
        ).run(targetId, String(sourceId), "identity-merge", mergedAt, sourceId, fromIdentity);
        if (claimsActive) {
            // The archive UPDATE rewrites the source row's lineage after the
            // adoption pass snapshotted the pre-archive row, so no
            // relationship source matches the new (merged_from,
            // superseded_by_memory_id) pair and any later lineage UPDATE or
            // DELETE on the row would trip the v84 relationship guard.
            // Re-snapshot the post-archive row; the supersession itself is
            // already recorded above, so this appends only the source row.
            const post = readMemoryProjectionRow(db, sourceId);
            if (post) translateMemoryClaimRelationshipsInCurrentTransaction(db, post);
        }
        db.prepare(
            `INSERT INTO memory_mutation_log
                (project_path, mutation_type, target_memory_id, superseded_by_id, category, queued_at)
             VALUES (?, 'superseded', ?, ?, ?, ?)`,
        ).run(fromIdentity, sourceId, targetId, row.category, mergedAt);
        logRow(
            db,
            fromIdentity,
            toIdentity,
            "memories",
            String(sourceId),
            "superseded",
            String(targetId),
            mergedAt,
        );
        return true;
    }

    if (claimsActive) {
        const targetProjectId = resolveMemoryClaimProjectInCurrentTransaction(db, toIdentity);
        const link = targetProjectId !== null ? readMemoryClaimLink(db, sourceId) : null;
        if (targetProjectId !== null && link && link.projectId !== targetProjectId) {
            // The crosswalk is append-only, so a row linked to another numeric
            // project cannot re-link in place: an in-place project_path rekey
            // would strand the claim under the source project and make every
            // later claims-aware write fail the outbox project guard. The
            // authorized cross-project move inserts a fresh projection row at
            // the target with a fresh claim and retires the source claim with
            // lineage.
            if (
                !moveLinkedMemoryAcrossProjects(
                    db,
                    sourceId,
                    fromIdentity,
                    toIdentity,
                    targetProjectId,
                    link,
                )
            ) {
                return false;
            }
            logRow(
                db,
                fromIdentity,
                toIdentity,
                "memories",
                String(sourceId),
                "rekeyed",
                null,
                mergedAt,
            );
            return true;
        }
        adoptIdentityMergeRowClaims(db, sourceId, null, toIdentity, mergedAt);
        const projectionRow = readMemoryProjectionRow(db, sourceId);
        const failure = projectionRow
            ? memoryClaimAdoptionFailureReason(projectionRow, targetProjectId)
            : null;
        if (failure !== null && rekeyTripsRelationshipGuard(db, sourceId)) {
            // An unadoptable row cannot carry a relationship snapshot (the
            // snapshot requires a claim link), so a lineage-bearing one would
            // trip the v84 relationship guard on the project_path rekey and
            // abort the whole merge. Record the blocking diagnostic and leave
            // the row under the source identity for the repair lane.
            recordMemoryClaimLinkFailure(db, sourceId, fromIdentity, failure);
            return false;
        }
    }
    const result = db
        .prepare("UPDATE memories SET project_path = ? WHERE id = ? AND project_path = ?")
        .run(toIdentity, sourceId, fromIdentity) as { changes?: number };
    if ((result.changes ?? 0) === 0) return false;
    logRow(db, fromIdentity, toIdentity, "memories", String(sourceId), "rekeyed", null, mergedAt);
    return true;
}

function nullableMaximum(left: unknown, right: unknown): number | null {
    const values = [left, right].filter((value): value is number => typeof value === "number");
    return values.length > 0 ? Math.max(...values) : null;
}

function oldestOpenCycleStart(left: unknown, right: unknown): number | null {
    const values = [left, right].filter(
        (value): value is number => typeof value === "number" && value > 0,
    );
    return values.length > 0 ? Math.min(...values) : null;
}

function reconcileTaskScheduleCollision(db: Database, source: SqliteRow, target: SqliteRow): void {
    const sourceIsNewer =
        typeof source.last_run_at === "number" &&
        (typeof target.last_run_at !== "number" || source.last_run_at > target.last_run_at);
    const latest = sourceIsNewer ? source : target;

    // Take schedule outcome fields from the newest completed run. Merge progress
    // independently: retrospective checks keep the furthest completed position, while
    // an active broad verification pass keeps its earliest start. This preserves
    // completed checks as newer than the pass watermark when identities are merged.
    db.prepare(
        `UPDATE task_schedule_state
            SET last_run_at = ?, next_due_at = ?, schedule = ?, last_status = ?,
                last_error = ?, retry_count = ?, last_checked_commit = ?,
                last_broad_run_at = ?, retrospective_watermark_ms = ?
          WHERE project_path = ? AND task = ?`,
    ).run(
        nullableMaximum(source.last_run_at, target.last_run_at),
        latest.next_due_at,
        latest.schedule,
        latest.last_status,
        latest.last_error,
        latest.retry_count,
        latest.last_checked_commit,
        oldestOpenCycleStart(source.last_broad_run_at, target.last_broad_run_at),
        nullableMaximum(source.retrospective_watermark_ms, target.retrospective_watermark_ms),
        target.project_path,
        target.task,
    );
}

function rekeyGenericRow(
    db: Database,
    table: IdentityTableInfo,
    row: SqliteRow,
    fromIdentity: string,
    toIdentity: string,
    mergedAt: number,
): boolean {
    const rowId = rowKey(db, table.name, row);
    const collision = findUniqueCollision(db, table, row, fromIdentity, toIdentity);
    if (collision) {
        if (table.name === "task_schedule_state") {
            reconcileTaskScheduleCollision(db, row, collision);
        }
        const sourcePredicate = rowPredicate(db, table.name, row);
        const result = db
            .prepare(`DELETE FROM ${quoteIdentifier(table.name)} WHERE ${sourcePredicate.sql}`)
            .run(...sourcePredicate.values) as { changes?: number };
        if ((result.changes ?? 0) === 0) return false;
        logRow(
            db,
            fromIdentity,
            toIdentity,
            table.name,
            rowId,
            "collision_deleted",
            rowKey(db, table.name, collision),
            mergedAt,
        );
        return true;
    }

    const predicate = rowPredicate(db, table.name, row);
    const result = db
        .prepare(
            `UPDATE ${quoteIdentifier(table.name)}
                SET ${quoteIdentifier(table.identityColumn)} = ?
              WHERE ${predicate.sql}
                AND ${quoteIdentifier(table.identityColumn)} = ?`,
        )
        .run(toIdentity, ...predicate.values, fromIdentity) as { changes?: number };
    if ((result.changes ?? 0) === 0) return false;
    logRow(db, fromIdentity, toIdentity, table.name, rowId, "rekeyed", null, mergedAt);
    return true;
}

function tableSourceRows(
    db: Database,
    table: IdentityTableInfo,
    fromIdentity: string,
): SqliteRow[] {
    return db
        .prepare(
            `SELECT rowid, * FROM ${quoteIdentifier(table.name)} WHERE ${quoteIdentifier(table.identityColumn)} = ?`,
        )
        .all(fromIdentity) as SqliteRow[];
}

function assertMergeAllowed(db: Database, fromIdentity: string, toIdentity: string): void {
    if (!tableExists(db, "authority_managed")) return;
    const source = db
        .prepare("SELECT 1 FROM authority_managed WHERE project_path = ? LIMIT 1")
        .get(fromIdentity);
    if (source) {
        throw new Error(
            `Refusing identity merge: ${fromIdentity} is managed by the Rust module. Drain module authority before re-keying; module-store re-keying is not in scope.`,
        );
    }
    const target = db
        .prepare("SELECT 1 FROM authority_managed WHERE project_path = ? LIMIT 1")
        .get(toIdentity);
    if (target) {
        throw new Error(
            `Refusing identity merge: ${toIdentity} is managed by the Rust module. Module-owned target pools cannot be re-keyed by this command.`,
        );
    }
}

export function auditIdentityMerge(
    db: Database,
    fromIdentity: string,
    toIdentity: string,
): IdentityMergeReport {
    const auditedTables = discoverIdentityTables(db).map((table) => ({
        tableName: table.name,
        identityColumn: table.identityColumn,
        derived: table.derived,
        sourceRows: table.derived ? 0 : tableSourceRows(db, table, fromIdentity).length,
        changedRows: 0,
    }));
    return {
        fromIdentity,
        toIdentity,
        auditedTables,
        changedRows: auditedTables.reduce((total, table) => total + table.sourceRows, 0),
        dryRun: true,
    };
}

export function mergeProjectIdentities(
    db: Database,
    fromIdentity: string,
    toIdentity: string,
    options: { dryRun?: boolean; now?: number } = {},
): IdentityMergeReport {
    if (!fromIdentity.trim() || !toIdentity.trim()) {
        throw new Error("Both source and target identities are required.");
    }
    if (fromIdentity === toIdentity) {
        throw new Error("Source and target identities must be different.");
    }
    assertMergeAllowed(db, fromIdentity, toIdentity);
    const tables = discoverIdentityTables(db);
    const report = auditIdentityMerge(db, fromIdentity, toIdentity);
    if (options.dryRun) return report;

    const mergedAt = options.now ?? Date.now();
    const withWriteScope = (fn: () => void): void => {
        if (hasMemoryClaimsCompatSchema(db)) {
            withClaimsWriteCapabilityInCurrentTransaction(db, () =>
                withMemoryClaimGenerationContextInCurrentTransaction(db, fn),
            );
        } else {
            fn();
        }
    };
    const run = db
        .transaction(() => {
            withWriteScope(() => {
                // v22's identity-level map remains useful for legacy consumers; the row-level
                // log below is the authoritative audit trail for this command.
                if (tableExists(db, "v22_identity_rekey_map")) {
                    db.prepare(
                        `INSERT INTO v22_identity_rekey_map (old_project_path, new_project_path, rekeyed_at)
                 VALUES (?, ?, ?)
                 ON CONFLICT(old_project_path) DO UPDATE SET
                    new_project_path = excluded.new_project_path,
                    rekeyed_at = excluded.rekeyed_at`,
                    ).run(fromIdentity, toIdentity, mergedAt);
                }
                applyIdentityMergeToProjectRegistry(db, fromIdentity, toIdentity, mergedAt);

                for (const table of tables) {
                    const tableReport = report.auditedTables.find(
                        (candidate) => candidate.tableName === table.name,
                    );
                    if (!tableReport || table.derived) continue;
                    const rows = tableSourceRows(db, table, fromIdentity);
                    tableReport.sourceRows = rows.length;
                    for (const row of rows) {
                        const changed =
                            table.name === "memories"
                                ? mergeMemoryRow(db, row, fromIdentity, toIdentity, mergedAt)
                                : rekeyGenericRow(
                                      db,
                                      table,
                                      row,
                                      fromIdentity,
                                      toIdentity,
                                      mergedAt,
                                  );
                        if (changed) tableReport.changedRows += 1;
                    }
                }

                db.prepare(
                    `INSERT INTO project_state
                (project_path, project_memory_epoch, project_user_profile_version, updated_at)
             VALUES (?, 1, 0, ?)
             ON CONFLICT(project_path) DO UPDATE SET
                project_memory_epoch = project_memory_epoch + 1,
                updated_at = excluded.updated_at`,
                ).run(toIdentity, mergedAt);
            });
        })
        .immediate();
    void run;

    return {
        ...report,
        auditedTables: report.auditedTables,
        changedRows: report.auditedTables.reduce((total, table) => total + table.changedRows, 0),
        dryRun: false,
    };
}
