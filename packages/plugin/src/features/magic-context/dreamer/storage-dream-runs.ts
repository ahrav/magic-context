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
    /** Failure detail only. Missing means no failure was recorded; an empty
     * string is treated as absent and is not persisted. */
    error?: string;
    /** Successful progress/detail. Missing means no progress was reported; an
     * empty string is treated as absent and is not persisted. */
    progress?: string;
    backlog?: DreamTaskRunBacklog;
}

export interface DreamRunMemoryChanges {
    written: number;
    deleted: number;
    archived: number;
    merged: number;
    // Exact ids of the memories changed in each bucket. Persisted in the
    // same `memory_changes_json` blob (no schema migration) so a drill-down
    // consumer can show EXACTLY which memories a run touched instead of
    // reconstructing them with an approximate created_at/updated_at time-window
    // query. Optional: older rows + the manual /ctx-dream summary path carry
    // counts only. Each count stays === its array length when arrays are present.
    //
    // These are LEGACY numeric ids from the `memories` table. Claim-native
    // writers MUST leave all four absent rather than emit empty arrays — see
    // `claimEffectMemoryChanges` for why an empty array is not a safe stand-in.
    writtenIds?: number[];
    deletedIds?: number[];
    archivedIds?: number[];
    mergedIds?: number[];
    // Public claim IDs (`mcm_<32hex>`) touched by a claim-native run, bucketed by
    // the effect's `changeKind`. Additive to the legacy numeric fields above: the
    // claim graph has no numeric memory id to report, so a claim-native run that
    // filled only the legacy arrays would have to invent ids.
    //
    // Bucketed by the change kinds that claim operations actually emit — NOT by
    // the curate action names (archive/merge/split). One curate action fans out
    // into several effects and several actions share a kind, so `changeKind` is
    // the only grouping the effect itself carries:
    //   claimUpsertedIds  — a new revision was written (create, revise, merge
    //                       target, split parent + its new children).
    //   claimLifecycleIds — a lifecycle state transition (archive, and the
    //                       retirement of each merge source).
    //   claimOtherIds     — any other kind (evidence/applicability/verification),
    //                       so a future kind is recorded rather than dropped.
    claimUpsertedIds?: string[];
    claimLifecycleIds?: string[];
    claimOtherIds?: string[];
}

/**
 * Project applied claim-operation effects onto the `dream_runs` telemetry shape.
 *
 * Returns null when nothing was applied, matching `memoryChanges: null` so the
 * caller stores SQL NULL for a no-op run.
 *
 * Two deliberate constraints keep this blob's shape stable for readers of
 * rows already written (the retired dashboard parsed it, and its convention
 * is the persisted format):
 *
 *  1. The legacy `*Ids` arrays stay ABSENT, not empty. A reader treats
 *     "all three of writtenIds/archivedIds/mergedIds missing" as its signal to
 *     fall back to the time-window reconstruction. Emitting `[]` instead would
 *     satisfy its presence check and make it report an EXACT-but-empty change
 *     set, suppressing that fallback.
 *  2. The legacy counts stay 0. A change-presence gate ORs over every value in
 *     this object, so a non-zero legacy count here would render a change block
 *     whose numeric drill-down has nothing behind it.
 *
 * Claim-native counts are therefore carried by the arrays' lengths.
 */
export function claimEffectMemoryChanges(
    effects: readonly ClaimOperationResultEffect[],
): DreamRunMemoryChanges | null {
    const upserted = new Set<string>();
    const lifecycle = new Set<string>();
    const other = new Set<string>();
    for (const effect of effects) {
        // The locator is the effect's only carrier of the public claim ID; a
        // null one means the revision row was gone, which is not reportable.
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
    /** Dreamer child session that produced this run — lets a telemetry reader
     *  scope the token join to this run (avoids cross-summing concurrent
     *  same-name cross-project runs). null when no parent session was resolved. */
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
