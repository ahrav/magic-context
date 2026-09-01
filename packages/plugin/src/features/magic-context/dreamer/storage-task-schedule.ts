import type { Database } from "../../../shared/sqlite";

/**
 * Each `(project, task)` has one scheduling-state row.
 *
 * `clearSession()` must retain scheduling state because it is project-scoped.
 */

export interface TaskScheduleStateRow {
    projectPath: string;
    task: string;
    /** Epoch ms of the last actual run (success or fail). null = never run. */
    lastRunAt: number | null;
    /** Epoch ms of the next scheduled fire. null = never due (disabled / impossible cron). */
    nextDueAt: number | null;
    /** `schedule` stores the value used to compute `next_due_at`.
     * The scheduler compares `schedule` with the live config on every pass.
     * The scheduler recomputes `next_due_at` when the live config differs from `schedule`.
     * Schedule changes take effect immediately rather than after a stale slot fires.
     * */
    schedule: string | null;
    lastStatus: "completed" | "failed" | "skipped" | null;
    lastError: string | null;
    retryCount: number;
    /** Do not read `lastCheckedCommit` in new logic; verification uses each memory's `verified_at` value.
     * Verify gates each memory on its own `verified_at` value after recording the file-to-memory mapping.
     * Keep the column for faithful row round-trips.
     * */
    lastCheckedCommit?: string | null;
    /** Stores the start of the open verify-broad cycle; null when no cycle is open.
     * */
    lastBroadRunAt?: number | null;
    /** Stores the maximum message timestamp actually scanned.
     * `lastRunAt` records schedule-completion time, not a content cutoff.
     * Omitting `retrospectiveWatermarkMs` on writes preserves the stored database value.
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
 * Delete schedule rows only for orphaned `dir:<md5>` projects.
 * A `dir:<md5>` identity is orphaned when its backing directory is gone.
 * Never delete schedule rows for a `git:` identity.
 * A `git:` identity is shared by worktrees and clones of the same repository.
 */
export function deleteTaskScheduleRowsForProject(db: Database, projectPath: string): number {
    const result = db
        .prepare("DELETE FROM task_schedule_state WHERE project_path = ?")
        .run(projectPath);
    return Number(result.changes ?? 0);
}

/**
 * `ON CONFLICT DO NOTHING` makes concurrent first-seeds idempotent: the first writer wins.
 * `ON CONFLICT DO NOTHING` makes concurrent first-seeds idempotent: the first writer wins.
 * `ON CONFLICT DO NOTHING` makes concurrent first-seeds idempotent: the first writer wins.
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

/**
 *
 * Optional watermark fields preserve existing values when omitted.
 * Passing `lastBroadRunAt: null` explicitly closes a broad cycle.
 * A closed broad cycle is durable state, not an absent patch. */
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
