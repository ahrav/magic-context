import type { Database, Statement as PreparedStatement } from "../../../shared/sqlite";
import {
    type ClaimOperationResultEffect,
    parseRevisionLocator,
} from "../memory/claim-operation-contract";
import type { DreamTaskRunBacklog } from "./task-registry";

export interface DreamRunTaskSummary {
    name: string;
    durationMs: number;
    resultChars: number;
    /** Missing `error` means no failure was recorded.
     * Empty `error` strings are treated as absent and are not persisted. */
    error?: string;
    /** Missing `progress` means no progress was reported.
     * Empty `progress` strings are treated as absent and are not persisted. */
    progress?: string;
    backlog?: DreamTaskRunBacklog;
}

export interface DreamRunMemoryChanges {
    written: number;
    deleted: number;
    archived: number;
    merged: number;
    // Each array contains the exact IDs changed in its bucket.
    // The fields are persisted in `memory_changes_json`.
    // Consumers use these IDs to report the exact memories a run touched instead of reconstructing them from an approximate `created_at`/`updated_at` time window.
    // Older rows and the manual `/ctx-dream` summary path provide counts only.
    // When arrays are present, each count equals its array's length.
    //
    // These are legacy numeric IDs from the `memories` table.
    // Claim-native writers must leave all four legacy numeric ID arrays absent rather than emit empty arrays.
    writtenIds?: number[];
    deletedIds?: number[];
    archivedIds?: number[];
    mergedIds?: number[];
    // Claim-native runs store touched public claim IDs (`mcm_<32hex>`) by the effect's `changeKind`.
    // These fields supplement the legacy numeric ID fields.
    // A claim-native run cannot populate only the legacy arrays without inventing IDs.
    //
    // These fields are bucketed by claim-operation `changeKind`, not curate action names.
    // Several curate actions share a `changeKind`.
    // `claimUpsertedIds` contains IDs whose new revision was written.
    // `claimUpsertedIds` includes creates, revisions, merge targets, split parents, and new split children.
    // `claimLifecycleIds` contains IDs whose lifecycle state changed.
    // `claimLifecycleIds` includes archives and retired merge sources.
    // `claimOtherIds` contains evidence, applicability, verification, and other `changeKind` values.
    // `claimOtherIds` records unrecognized `changeKind` values instead of dropping them.
    claimUpsertedIds?: string[];
    claimLifecycleIds?: string[];
    claimOtherIds?: string[];
}

/**
 * `claimEffectMemoryChanges` projects applied claim-operation effects onto the `dream_runs` telemetry shape.
 *
 * `claimEffectMemoryChanges` returns `null` when no effects were applied.
 *
 *
 * A reader falls back to time-window reconstruction when all four legacy ID arrays are absent.
 * Empty legacy ID arrays would satisfy the reader's presence check and report an exact-but-empty change set.
 * An exact-but-empty change set suppresses time-window reconstruction.
 *
 */
export function claimEffectMemoryChanges(
    effects: readonly ClaimOperationResultEffect[],
): DreamRunMemoryChanges | null {
    const upserted = new Set<string>();
    const lifecycle = new Set<string>();
    const other = new Set<string>();
    for (const effect of effects) {
        const publicClaimId = effect.revisionLocator
            ? parseRevisionLocator(effect.revisionLocator)?.publicClaimId
            : undefined;
        if (!publicClaimId) continue;
        if (effect.changeKind === "upsert") upserted.add(publicClaimId);
        else if (effect.changeKind === "lifecycle") lifecycle.add(publicClaimId);
        else other.add(publicClaimId);
    }
    if (upserted.size === 0 && lifecycle.size === 0 && other.size === 0) return null;
    const changes: DreamRunMemoryChanges = { written: 0, deleted: 0, archived: 0, merged: 0 };
    if (upserted.size > 0) changes.claimUpsertedIds = [...upserted];
    if (lifecycle.size > 0) changes.claimLifecycleIds = [...lifecycle];
    if (other.size > 0) changes.claimOtherIds = [...other];
    return changes;
}

export interface DreamRunRow {
    id: number;
    project_path: string;
    started_at: number;
    finished_at: number;
    holder_id: string;
    tasks_json: string;
    tasks_succeeded: number;
    tasks_failed: number;
    smart_notes_surfaced: number;
    smart_notes_pending: number;
    memory_changes_json: string | null;
}

export interface DreamRunInput {
    projectPath: string;
    startedAt: number;
    finishedAt: number;
    holderId: string;
    tasks: DreamRunTaskSummary[];
    tasksSucceeded: number;
    tasksFailed: number;
    smartNotesSurfaced: number;
    smartNotesPending: number;
    memoryChanges?: DreamRunMemoryChanges | null;
    /**
     * */
    parentSessionId?: string | null;
}

const insertDreamRunStatements = new WeakMap<Database, PreparedStatement>();
const getDreamRunsByProjectStatements = new Map<number, WeakMap<Database, PreparedStatement>>();

function getInsertDreamRunStatement(db: Database): PreparedStatement {
    let stmt = insertDreamRunStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "INSERT INTO dream_runs (project_path, started_at, finished_at, holder_id, tasks_json, tasks_succeeded, tasks_failed, smart_notes_surfaced, smart_notes_pending, memory_changes_json, parent_session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        insertDreamRunStatements.set(db, stmt);
    }
    return stmt;
}

function getDreamRunsByProjectStatement(db: Database, limit: number): PreparedStatement {
    let statements = getDreamRunsByProjectStatements.get(limit);
    if (!statements) {
        statements = new WeakMap<Database, PreparedStatement>();
        getDreamRunsByProjectStatements.set(limit, statements);
    }

    let stmt = statements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT id, project_path, started_at, finished_at, holder_id, tasks_json, tasks_succeeded, tasks_failed, smart_notes_surfaced, smart_notes_pending, memory_changes_json FROM dream_runs WHERE project_path = ? ORDER BY finished_at DESC LIMIT ${limit}`,
        );
        statements.set(db, stmt);
    }

    return stmt;
}

function isNullableString(value: unknown): value is string | null {
    return value === null || typeof value === "string";
}

function isDreamRunRow(row: unknown): row is DreamRunRow {
    if (row === null || typeof row !== "object") return false;
    const candidate = row as Record<string, unknown>;
    return (
        typeof candidate.id === "number" &&
        typeof candidate.project_path === "string" &&
        typeof candidate.started_at === "number" &&
        typeof candidate.finished_at === "number" &&
        typeof candidate.holder_id === "string" &&
        typeof candidate.tasks_json === "string" &&
        typeof candidate.tasks_succeeded === "number" &&
        typeof candidate.tasks_failed === "number" &&
        typeof candidate.smart_notes_surfaced === "number" &&
        typeof candidate.smart_notes_pending === "number" &&
        isNullableString(candidate.memory_changes_json)
    );
}

export function insertDreamRun(db: Database, run: DreamRunInput): void {
    getInsertDreamRunStatement(db).run(
        run.projectPath,
        run.startedAt,
        run.finishedAt,
        run.holderId,
        JSON.stringify(run.tasks),
        run.tasksSucceeded,
        run.tasksFailed,
        run.smartNotesSurfaced,
        run.smartNotesPending,
        run.memoryChanges ? JSON.stringify(run.memoryChanges) : null,
        run.parentSessionId ?? null,
    );
}

export function getDreamRuns(db: Database, projectPath: string, limit = 20): DreamRunRow[] {
    const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 20;
    return getDreamRunsByProjectStatement(db, normalizedLimit)
        .all(projectPath)
        .filter(isDreamRunRow)
        .map((row) => ({ ...row }));
}
