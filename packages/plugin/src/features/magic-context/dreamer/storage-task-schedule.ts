import type { Database } from "../../../shared/sqlite";

/**
 * Per-task dreamer scheduling state (Dreamer v2). One row per (project, task):
 * when it last ran, when it's next due, and its last outcome. Replaces the
 * project-level `dream_queue` + the single `last_dream_at:<project>` key — drains
 * run straight off this table + keyed leases (see lease.ts).
 *
 * Project-scoped, NOT session-scoped → intentionally absent from clearSession().
 */

export interface TaskScheduleStateRow {
    projectPath: string;
    task: string;
    /** Epoch ms of the last actual run (success or fail). null = never run. */
    lastRunAt: number | null;
    /** Epoch ms of the next scheduled fire. null = never due (disabled / impossible cron). */
    nextDueAt: number | null;
    /** The cron `schedule` string `next_due_at` was last computed FROM. The
     *  scheduler reconciles this against the live config each pass: when the
     *  config schedule differs, `next_due_at` is recomputed so config is always
     *  authoritative (a disabled/enabled/changed task takes effect immediately,
     *  not only after the stale slot fires once). null on legacy rows. */
    schedule: string | null;
    lastStatus: "completed" | "failed" | "skipped" | null;
    lastError: string | null;
    retryCount: number;
    /** LEGACY/INERT: the old verify commit watermark. Verify now gates per-memory
     *  on each memory's own `verified_at` (map records the file→memory mapping
     *  first), so no global commit watermark is written. Column kept (v43) to
     *  avoid a DROP-COLUMN migration; field kept for a faithful round-trip. Do
     *  NOT read it for new logic. */
    lastCheckedCommit?: string | null;
    /** Start of the currently open verify-broad cycle, or null when the cycle
     *  is closed. This field reuses an existing database column from schema
     *  version 43 as the cycle watermark, allowing a broad pool to drain across
     *  scheduled runs without a migration. */
    lastBroadRunAt?: number | null;
    /** retrospective CONTENT watermark: max message ts actually scanned. Distinct
     *  from lastRunAt (schedule-completion time) — lastRunAt as a content cutoff
     *  loses messages that arrive mid-run. Undefined on writes preserves the DB
     *  value. */
    retrospectiveWatermarkMs?: number | null;
}

interface RawRow {
    project_path: string;
    task: string;
    last_run_at: number | null;
    next_due_at: number | null;
    schedule: string | null;
    last_status: string | null;
    last_error: string | null;
    retry_count: number | null;
    last_checked_commit: string | null;
    last_broad_run_at: number | null;
    retrospective_watermark_ms: number | null;
}

function toRow(r: RawRow): TaskScheduleStateRow {
    return {
        projectPath: r.project_path,
        task: r.task,
        lastRunAt: r.last_run_at,
        nextDueAt: r.next_due_at,
        schedule: r.schedule ?? null,
        lastStatus: (r.last_status as TaskScheduleStateRow["lastStatus"]) ?? null,
        lastError: r.last_error,
        retryCount: r.retry_count ?? 0,
        lastCheckedCommit: r.last_checked_commit ?? null,
        lastBroadRunAt: r.last_broad_run_at ?? null,
        retrospectiveWatermarkMs: r.retrospective_watermark_ms ?? null,
    };
}

const SELECT_COLUMNS =
    "project_path, task, last_run_at, next_due_at, schedule, last_status, last_error, retry_count, last_checked_commit, last_broad_run_at, retrospective_watermark_ms";

export function getTaskScheduleState(
    db: Database,
    projectPath: string,
    task: string,
): TaskScheduleStateRow | null {
    const row = db
        .prepare<[string, string], RawRow>(
            `SELECT ${SELECT_COLUMNS} FROM task_schedule_state WHERE project_path = ? AND task = ?`,
        )
        .get(projectPath, task);
    return row ? toRow(row) : null;
}

export function getTaskScheduleStatesForProject(
    db: Database,
    projectPath: string,
): TaskScheduleStateRow[] {
    return db
        .prepare<[string], RawRow>(
            `SELECT ${SELECT_COLUMNS} FROM task_schedule_state WHERE project_path = ? ORDER BY task`,
        )
        .all(projectPath)
        .map(toRow);
}

/**
 * Most recent successful Dreamer task run for a project, as an epoch-ms value,
 * or null if no task has run yet. `last_run_at` advances only on task success
 * (see the scheduler), so this is "last successful dreamer activity", the
 * meaning the V1 `dream_state['last_dream_at:<project>']` field carried before
 * Dreamer V2 retired it. Used by the OpenCode sidebar RPC and Pi's /ctx-status
 * so the displayed "last run" reflects V2 per-task execution instead of a frozen
 * V1 migration-seed timestamp.
 */
export function getMostRecentTaskRunAt(db: Database, projectPath: string): number | null {
    const row = db
        .prepare<[string], { max_at: number | null }>(
            "SELECT MAX(last_run_at) AS max_at FROM task_schedule_state WHERE project_path = ?",
        )
        .get(projectPath);
    const value = row?.max_at ?? null;
    return typeof value === "number" && value > 0 ? value : null;
}

/**
 * Delete task_schedule_state rows for a project whose `task` is NOT in the given
 * keep-set. Used to garbage-collect RETIRED task names (e.g. the v1
 * improve/consolidate/archive-stale rows superseded by the verify/curate split):
 * reconcile adds/updates canonical tasks but never removed obsolete rows, so they
 * lingered forever as perpetually-"due" garbage that polluted the dashboard.
 * Returns the number of rows deleted.
 */
export function pruneNonCanonicalTaskRows(
    db: Database,
    projectPath: string,
    canonicalTasks: readonly string[],
): number {
    if (canonicalTasks.length === 0) return 0;
    const placeholders = canonicalTasks.map(() => "?").join(", ");
    const result = db
        .prepare(
            `DELETE FROM task_schedule_state WHERE project_path = ? AND task NOT IN (${placeholders})`,
        )
        .run(projectPath, ...canonicalTasks);
    return Number(result.changes ?? 0);
}

/**
 * Delete ALL task_schedule_state rows for a project. Used to GC a fully-orphaned
 * project — a `dir:<md5>` identity whose backing directory is gone (e.g. a
 * finalized mason worktree). NEVER call this for a `git:` identity: that is
 * shared across worktrees/clones of the same repo, so a single dead worktree
 * must not delete the shared project's schedule. Returns rows deleted.
 */
export function deleteTaskScheduleRowsForProject(db: Database, projectPath: string): number {
    const result = db
        .prepare("DELETE FROM task_schedule_state WHERE project_path = ?")
        .run(projectPath);
    return Number(result.changes ?? 0);
}

/**
 * Idempotent first-seed: insert the row only if absent. Concurrent processes can
 * both call this safely — ON CONFLICT DO NOTHING means the first writer wins and
 * the second is a no-op (both compute the same next_due_at from the same cron).
 */
export function seedTaskScheduleState(
    db: Database,
    projectPath: string,
    task: string,
    nextDueAt: number | null,
    lastRunAt: number | null,
    schedule: string,
): void {
    db.prepare(
        "INSERT INTO task_schedule_state (project_path, task, last_run_at, next_due_at, schedule, last_status, last_error, retry_count) VALUES (?, ?, ?, ?, ?, NULL, NULL, 0) ON CONFLICT(project_path, task) DO NOTHING",
    ).run(projectPath, task, lastRunAt, nextDueAt, schedule);
}

/** Full upsert of a row's schedule fields (used on run completion / gate-skip /
 *  retry advancement / schedule reconciliation). Callers that read-then-write
 *  should wrap in BEGIN IMMEDIATE; run-completion writes are already
 *  single-writer under the domain lease.
 *
 *  Optional watermark fields preserve the existing value when omitted. Passing
 *  `lastBroadRunAt: null` explicitly closes a broad cycle; this distinction is
 *  needed because a closed cycle is durable state, not an absent patch. */
export function writeTaskScheduleState(db: Database, row: TaskScheduleStateRow): void {
    const broadCycleUpdate =
        row.lastBroadRunAt === undefined
            ? "last_broad_run_at = task_schedule_state.last_broad_run_at"
            : "last_broad_run_at = excluded.last_broad_run_at";
    db.prepare(
        `INSERT INTO task_schedule_state
           (project_path, task, last_run_at, next_due_at, schedule, last_status, last_error, retry_count, last_checked_commit, last_broad_run_at, retrospective_watermark_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_path, task) DO UPDATE SET
           last_run_at          = excluded.last_run_at,
           next_due_at          = excluded.next_due_at,
           schedule             = excluded.schedule,
           last_status          = excluded.last_status,
           last_error           = excluded.last_error,
           retry_count          = excluded.retry_count,
           last_checked_commit  = COALESCE(excluded.last_checked_commit, task_schedule_state.last_checked_commit),
           ${broadCycleUpdate},
           retrospective_watermark_ms = COALESCE(excluded.retrospective_watermark_ms, task_schedule_state.retrospective_watermark_ms)`,
    ).run(
        row.projectPath,
        row.task,
        row.lastRunAt,
        row.nextDueAt,
        row.schedule,
        row.lastStatus,
        row.lastError,
        row.retryCount,
        row.lastCheckedCommit ?? null,
        row.lastBroadRunAt ?? null,
        row.retrospectiveWatermarkMs ?? null,
    );
}

/**
 * Source-window idempotence for the retrospective task. A friction window
 * re-seen across the run-overlap (the ~12 user lines re-read before the
 * watermark) must not re-extract the same learning. `windowKey` is a stable hash
 * over the flagged user lines' (sessionId:ts) anchors — NOT prompt ordinals,
 * which are batch-local and unstable.
 */
export function isRetrospectiveWindowProcessed(
    db: Database,
    projectPath: string,
    windowKey: string,
): boolean {
    const row = db
        .prepare<[string, string], { one: number }>(
            "SELECT 1 AS one FROM retrospective_processed_windows WHERE project_path = ? AND window_key = ?",
        )
        .get(projectPath, windowKey);
    return row != null;
}

export function recordRetrospectiveWindowProcessed(
    db: Database,
    projectPath: string,
    windowKey: string,
): void {
    db.prepare(
        "INSERT INTO retrospective_processed_windows (project_path, window_key, processed_at) VALUES (?, ?, ?) ON CONFLICT(project_path, window_key) DO NOTHING",
    ).run(projectPath, windowKey, Date.now());
}
