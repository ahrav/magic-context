import type { PiThinkingLevel } from "../../../config/schema/magic-context";
import type { Database } from "../../../shared/sqlite";
import { type LeaseAcquisition } from "./lease";
import { type DreamTaskBacklogMap, type DreamTaskName } from "./task-registry";
/** Bounded retry before a transient failure stops hot-retrying and waits for the
 *  next cron occurrence. */
export declare const MAX_TASK_RETRIES = 3;
/** Resolved per-task config the scheduler operates on (decoupled from the Zod
 *  schema — step 5 produces this from config; the scheduler just consumes it). */
export interface DreamTaskRuntimeConfig {
    task: DreamTaskName;
    /** Cron string; `""` = disabled (never due). */
    schedule: string;
    model?: string;
    fallbackModels?: readonly string[];
    thinkingLevel?: PiThinkingLevel;
    language?: string;
    timeoutMinutes: number;
    /** review-user-memories */
    promotionThreshold?: number;
}
export interface TaskExecOutcome {
    status: "completed" | "failed";
    /** A transient failure (provider/network/rate-limit/timeout) hot-retries up to
     *  MAX_TASK_RETRIES; a permanent failure advances to the next cron slot. */
    transient?: boolean;
    error?: string;
    schedulePatch?: {
        /** retrospective content watermark (max message ts scanned this run). */
        retrospectiveWatermarkMs?: number | null;
    };
}
/** Runs ONE task's actual work (LLM loop). Supplied by the runner (step 4). The
 *  scheduler holds the domain lease + `holderId`; the executor must verify the
 *  lease holder under BEGIN IMMEDIATE immediately before any durable write. */
export interface TaskExecutorContext {
    db: Database;
    projectIdentity: string;
    holderId: string;
    leaseKey: string;
    leaseAcquisition?: LeaseAcquisition;
}
export type TaskExecutor = (task: DreamTaskRuntimeConfig, ctx: TaskExecutorContext) => Promise<TaskExecOutcome>;
export interface RunDueTasksDeps {
    db: Database;
    projectIdentity: string;
    tasks: readonly DreamTaskRuntimeConfig[];
    executor: TaskExecutor;
    now?: number;
}
interface DueTask {
    config: DreamTaskRuntimeConfig;
    /** The next_due_at slot being satisfied — excluded from the next computation
     *  to prevent a DST repeated-minute double-fire. */
    scheduledAt: number;
}
/** Pure-ish decision: seed missing rows, then collect tasks whose next_due_at has
 *  arrived. Gate evaluation happens in the drain (pre- AND post-lease). Exported
 *  for testing. */
export declare function planDueTasks(db: Database, projectIdentity: string, tasks: readonly DreamTaskRuntimeConfig[], now: number): DueTask[];
/** Lease wait budget for manual /ctx-dream runs. */
export declare const MANUAL_RUN_LEASE_WAIT_MS = 60000;
export interface ManualRunResult {
    /** Tasks that actually executed (gate passed, lease acquired). */
    ran: string[];
    /** Tasks that were skipped because their activity gate failed. */
    skippedNoWork: string[];
    /** Tasks whose domain lease was busy (another run in progress). */
    deferredBusy: string[];
    /** Tasks that ran but failed. */
    failed: string[];
    /** User-visible error details for failed tasks, including incomplete backlogs. */
    failureDetails?: string[];
    /** Read-only backlog snapshot before the selected tasks started. */
    backlogBefore: DreamTaskBacklogMap;
    /** Read-only backlog snapshot after the selected tasks finished or were skipped. */
    backlogAfter: DreamTaskBacklogMap;
}
/**
 * Manual `/ctx-dream` run: run dream tasks NOW, IGNORING their schedule.
 *
 * - No `task` arg → run every ENABLED task (schedule != "") whose activity gate
 *   passes, grouped by domain under leases (same concurrency rules as the timer).
 * - `task` arg → force-run that ONE task NOW, IGNORING its gate (explicit user
 *   intent), honoring its lease. Works even if the task's schedule is "".
 *
 * Still advances next_due_at on completion so the manual run resets the cadence.
 */
export declare function runManualDream(deps: Omit<RunDueTasksDeps, "now"> & {
    task?: DreamTaskName;
}): Promise<ManualRunResult>;
/**
 * One scheduler pass for a project: seed missing rows, collect due tasks,
 * pre-gate them, group by conflict-domain, and run domains CONCURRENTLY (tasks
 * within a domain sequentially in canonical order under one lease). Returns the
 * number of tasks actually executed (for logging/tests).
 */
export declare function runDueTasksForProject(deps: RunDueTasksDeps): Promise<number>;
export {};
//# sourceMappingURL=task-scheduler.d.ts.map