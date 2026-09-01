import type { PiThinkingLevel } from "../../../config/schema/magic-context";
import { log } from "../../../shared/logger";
import type { Database } from "../../../shared/sqlite";
import { nextDueAtMs } from "./cron";
import {
    acquireLeaseWithAcquisition,
    type LeaseAcquisition,
    leaseOwnershipMatches,
    releaseLease,
} from "./lease";
import { getDreamState } from "./storage-dream-state";
import {
    getTaskScheduleState,
    pruneNonCanonicalTaskRows,
    seedTaskScheduleState,
    writeTaskScheduleState,
} from "./storage-task-schedule";
import { evaluateTaskGate, getDreamTaskBacklogs } from "./task-gates";
import {
    compareTaskOrder,
    type DreamTaskBacklogMap,
    type DreamTaskName,
    leaseKeyFor,
    leaseKindFor,
} from "./task-registry";

/** Transient failures hot-retry at most `MAX_TASK_RETRIES` times, then wait for the next cron occurrence.
 * */
export const MAX_TASK_RETRIES = 3;

/** The scheduler uses this config independently of the Zod schema.
 * */
export interface DreamTaskRuntimeConfig {
    task: DreamTaskName;
    /** An empty `schedule` disables the task, so it is never due. */
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
    /** Transient failures hot-retry at most `MAX_TASK_RETRIES` times; permanent failures advance to the next cron slot.
     * */
    transient?: boolean;
    error?: string;
    schedulePatch?: {
        /** `retrospectiveWatermarkMs` records the maximum message timestamp scanned in this run. */
        retrospectiveWatermarkMs?: number | null;
    };
}

/** The executor runs the task's LLM loop. The runner supplies the executor.
 * The scheduler holds the domain lease and `holderId`; the executor must verify the lease holder under `BEGIN IMMEDIATE` immediately before every durable write.
 * */
export interface TaskExecutorContext {
    db: Database;
    projectIdentity: string;
    holderId: string;
    leaseKey: string;
    leaseAcquisition?: LeaseAcquisition;
}

export type TaskExecutor = (
    task: DreamTaskRuntimeConfig,
    ctx: TaskExecutorContext,
) => Promise<TaskExecOutcome>;

export interface RunDueTasksDeps {
    db: Database;
    projectIdentity: string;
    tasks: readonly DreamTaskRuntimeConfig[];
    executor: TaskExecutor;
    now?: number;
}

/**
 * The scheduler seeds `last_run_at` from legacy `last_dream_at` so upgraded projects do not treat every task as never run.
 * Concurrent seed attempts leave an existing row unchanged. */
function ensureSeeded(
    db: Database,
    projectIdentity: string,
    config: DreamTaskRuntimeConfig,
    now: number,
): void {
    if (getTaskScheduleState(db, projectIdentity, config.task)) return;
    const legacy = getDreamState(db, `last_dream_at:${projectIdentity}`);
    const legacyLastRun = legacy ? Number(legacy) : null;
    const lastRunAt = legacyLastRun && Number.isFinite(legacyLastRun) ? legacyLastRun : null;
    const nextDueAt = nextDueAtMs(config.schedule, now);
    seedTaskScheduleState(db, projectIdentity, config.task, nextDueAt, lastRunAt, config.schedule);
}

/**
 * The scheduler applies schedule changes before due checks so stale slots cannot fire.
 * Recomputing `next_due_at` prevents a task disabled after seeding from firing at its stale slot.
 * A task seeded while disabled has `next_due_at = NULL`; enabling it without recomputation leaves it never due.
 *
 *    reset retry_count.
 */
function reconcileSchedule(
    db: Database,
    projectIdentity: string,
    config: DreamTaskRuntimeConfig,
    now: number,
): void {
    ensureSeeded(db, projectIdentity, config, now);
    const stored = getTaskScheduleState(db, projectIdentity, config.task);
    if (!stored || stored.schedule === config.schedule) return;

    if (config.schedule.trim() === "") {
        writeTaskScheduleState(db, { ...stored, schedule: config.schedule, nextDueAt: null });
        return;
    }
    if (stored.schedule === null && stored.nextDueAt !== null) {
        // The schedule backfill preserves a live legacy `next_due_at` while it fills `schedule`.
        writeTaskScheduleState(db, { ...stored, schedule: config.schedule });
        return;
    }
    writeTaskScheduleState(db, {
        ...stored,
        schedule: config.schedule,
        nextDueAt: nextDueAtMs(config.schedule, now),
        retryCount: 0,
    });
}

interface DueTask {
    config: DreamTaskRuntimeConfig;
    /** The scheduler excludes the satisfied `next_due_at` slot when computing the next due time.
     * Excluding the satisfied `next_due_at` slot prevents a DST repeated-minute double-fire. */
    scheduledAt: number;
}

/**
 * Gate evaluation occurs in the drain before and after lease acquisition.
 *  for testing. */
export function planDueTasks(
    db: Database,
    projectIdentity: string,
    tasks: readonly DreamTaskRuntimeConfig[],
    now: number,
): DueTask[] {
    // Rows absent from `tasks` are obsolete because `tasks` is the canonical task set.
    // `tasks` contains the full canonical task set, so `pruneNonCanonicalTaskRows` is idempotent.
    const pruned = pruneNonCanonicalTaskRows(
        db,
        projectIdentity,
        tasks.map((t) => t.task),
    );
    if (pruned > 0) {
        log(`[dreamer] pruned ${pruned} retired task row(s) for ${projectIdentity}`);
    }

    const due: DueTask[] = [];
    for (const config of tasks) {
        reconcileSchedule(db, projectIdentity, config, now);
        const state = getTaskScheduleState(db, projectIdentity, config.task);
        if (!state || state.nextDueAt === null) continue; // disabled / impossible cron
        if (now >= state.nextDueAt) {
            due.push({ config, scheduledAt: state.nextDueAt });
        }
    }
    return due;
}

function advanceAfterRun(
    db: Database,
    projectIdentity: string,
    due: DueTask,
    finishedAt: number,
    status: "completed" | "failed" | "skipped",
    error: string | null,
    schedulePatch?: TaskExecOutcome["schedulePatch"],
): void {
    writeTaskScheduleState(db, {
        projectPath: projectIdentity,
        task: due.config.task,
        // last_run_at means "last SUCCESSFUL run" — the cutoff for "changed since"
        // `maintain-docs` uses `last_run_at` as its "changed since" cutoff.
        lastRunAt:
            status === "completed"
                ? finishedAt
                : readLastRunAt(db, projectIdentity, due.config.task),
        nextDueAt: nextDueAtMs(due.config.schedule, finishedAt, due.scheduledAt),
        schedule: due.config.schedule,
        lastStatus: status,
        lastError: error,
        retryCount: 0,
        retrospectiveWatermarkMs: schedulePatch?.retrospectiveWatermarkMs,
    });
}

function readLastRunAt(db: Database, projectIdentity: string, task: DreamTaskName): number | null {
    return getTaskScheduleState(db, projectIdentity, task)?.lastRunAt ?? null;
}

function readRetrospectiveWatermark(
    db: Database,
    projectIdentity: string,
    task: DreamTaskName,
): number | null {
    return getTaskScheduleState(db, projectIdentity, task)?.retrospectiveWatermarkMs ?? null;
}

/** A transient failure retains `next_due_at` for a next-tick retry.
 * The scheduler advances `next_due_at` to the next cron slot after `MAX_TASK_RETRIES` transient failures.
 * Incomplete manifest drains use the transient-failure retry path.
 * The retry cap prevents a permanently failing unit from starving its cron slot indefinitely.
 * After the retry cap, the next cron occurrence retries any remaining residue. */
function recordTransientFailure(
    db: Database,
    projectIdentity: string,
    due: DueTask,
    finishedAt: number,
    error: string | null,
): void {
    const prior = getTaskScheduleState(db, projectIdentity, due.config.task);
    const retryCount = (prior?.retryCount ?? 0) + 1;
    // A failed run preserves the prior success cutoff.
    const priorLastRun = prior?.lastRunAt ?? null;
    if (retryCount > MAX_TASK_RETRIES) {
        writeTaskScheduleState(db, {
            projectPath: projectIdentity,
            task: due.config.task,
            lastRunAt: priorLastRun,
            nextDueAt: nextDueAtMs(due.config.schedule, finishedAt, due.scheduledAt),
            schedule: due.config.schedule,
            lastStatus: "failed",
            lastError: error,
            retryCount: 0,
        });
    } else {
        // A transient failure retains `next_due_at` for a next-tick retry, except disabled tasks must not become due.
        // A disabled task has `schedule.trim() === ""` and must not become due after a transient failure.
        // A manual force-run of a disabled task (`/ctx-dream <task>`) sets `due.scheduledAt` to `now`.
        // Without the disabled-task guard, a transient failure would set `next_due_at` to `now`, causing the timer to run a disabled task.
        const disabled = due.config.schedule.trim() === "";
        writeTaskScheduleState(db, {
            projectPath: projectIdentity,
            task: due.config.task,
            lastRunAt: priorLastRun,
            nextDueAt: disabled ? null : (prior?.nextDueAt ?? due.scheduledAt),
            schedule: due.config.schedule,
            lastStatus: "failed",
            lastError: error,
            retryCount,
        });
    }
}

interface DomainGroupCallbacks {
    /** Manual single-task run ignores the post-lease activity gate re-check. */
    forceGate?: boolean;
    /**
     * `leaseWaitMs` limits how long a manual run waits for a busy domain lease.
     * Scheduled ticks leave `leaseWaitMs` unset because the next tick retries.
     */
    leaseWaitMs?: number;
    onRan?: (task: DreamTaskName) => void;
    onFailed?: (task: DreamTaskName, error?: string) => void;
    onBusy?: (task: DreamTaskName) => void;
}

/* */
const LEASE_WAIT_POLL_MS = 2_000;
/* */
export const MANUAL_RUN_LEASE_WAIT_MS = 60_000;

async function runDomainGroup(
    deps: RunDueTasksDeps,
    group: DueTask[],
    cb?: DomainGroupCallbacks,
): Promise<void> {
    const { db, projectIdentity, executor } = deps;
    // All tasks in a group share a lease domain → one key for the group.
    const leaseKey = leaseKeyFor(group[0].config.task, projectIdentity);
    const holderId = crypto.randomUUID();

    let acquisition = acquireLeaseWithAcquisition(db, holderId, leaseKey);
    if (!acquisition && cb?.leaseWaitMs) {
        const deadline = Date.now() + cb.leaseWaitMs;
        while (!acquisition && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, LEASE_WAIT_POLL_MS));
            acquisition = acquireLeaseWithAcquisition(db, holderId, leaseKey);
        }
    }
    if (!acquisition) {
        // Lease-acquisition failures leave `next_due_at` unchanged.
        // The unchanged `next_due_at` keeps lease-blocked tasks eligible for the next tick.
        log(`[dreamer] domain lease busy (${leaseKey}) — deferring ${group.length} task(s)`);
        for (const due of group) cb?.onBusy?.(due.config.task);
        return;
    }

    try {
        for (const due of [...group].sort((a, b) =>
            compareTaskOrder(a.config.task, b.config.task),
        )) {
            if (!leaseOwnershipMatches(db, holderId, acquisition.generation, leaseKey)) {
                log(`[dreamer] domain lease lost (${leaseKey}) — stopping remaining task(s)`);
                break;
            }

            // The runner re-evaluates the gate after acquiring the lease because another process may have consumed the work.
            if (!cb?.forceGate) {
                const gatePass = evaluateTaskGate(due.config.task, {
                    db,
                    projectIdentity,
                    lastRunAt: readLastRunAt(db, projectIdentity, due.config.task),
                    retrospectiveWatermarkMs: readRetrospectiveWatermark(
                        db,
                        projectIdentity,
                        due.config.task,
                    ),
                    promotionThreshold: due.config.promotionThreshold ?? 3,
                });
                if (!gatePass) {
                    advanceAfterRun(db, projectIdentity, due, Date.now(), "skipped", null);
                    continue;
                }
            }

            let outcome: TaskExecOutcome;
            try {
                outcome = await executor(due.config, {
                    db,
                    projectIdentity,
                    holderId,
                    leaseKey,
                    leaseAcquisition: acquisition,
                });
            } catch (error) {
                outcome = { status: "failed", transient: true, error: String(error) };
            }

            const finishedAt = Date.now();
            if (outcome.status === "completed") {
                advanceAfterRun(
                    db,
                    projectIdentity,
                    due,
                    finishedAt,
                    "completed",
                    null,
                    outcome.schedulePatch,
                );
                cb?.onRan?.(due.config.task);
            } else if (outcome.transient) {
                recordTransientFailure(db, projectIdentity, due, finishedAt, outcome.error ?? null);
                cb?.onFailed?.(due.config.task, outcome.error);
            } else {
                advanceAfterRun(
                    db,
                    projectIdentity,
                    due,
                    finishedAt,
                    "failed",
                    outcome.error ?? null,
                );
                cb?.onFailed?.(due.config.task, outcome.error);
            }
        }
    } finally {
        releaseLease(db, holderId, leaseKey);
    }
}

export interface ManualRunResult {
    /** The result contains tasks whose activity gate passed and whose domain lease was acquired. */
    ran: string[];
    /** The result contains tasks skipped because their activity gate failed. */
    skippedNoWork: string[];
    /** The result contains tasks whose domain lease was busy because another run was in progress. */
    deferredBusy: string[];
    /** The result contains tasks that executed and failed. */
    failed: string[];
    /* */
    failureDetails?: string[];
    /** The snapshot is read-only and was taken before the selected tasks started. */
    backlogBefore: DreamTaskBacklogMap;
    /** The snapshot is read-only and was taken after the selected tasks finished or were skipped. */
    backlogAfter: DreamTaskBacklogMap;
}

/**
 * A manual `/ctx-dream` run does not wait for scheduled due times.
 *
 * Without a `task` argument, `/ctx-dream` selects every task with a nonblank schedule whose activity gate passes.
 * Without `task`, the runner groups gate-passing tasks by domain and acquires a lease for each group.
 * A `task` argument bypasses that task's activity gate but still requires its domain lease.
 * `task` runs honor leases even when `schedule` is empty.
 *
 * A completed manual run advances `next_due_at`, resetting the cadence.
 */
export async function runManualDream(
    deps: Omit<RunDueTasksDeps, "now"> & { task?: DreamTaskName },
): Promise<ManualRunResult> {
    const now = Date.now();
    const result: ManualRunResult = {
        ran: [],
        skippedNoWork: [],
        deferredBusy: [],
        failed: [],
        failureDetails: [],
        backlogBefore: {},
        backlogAfter: {},
    };

    let selected: readonly DreamTaskRuntimeConfig[];
    let forceGate = false;
    if (deps.task) {
        const cfg = deps.tasks.find((t) => t.task === deps.task);
        if (!cfg) return result;
        selected = [cfg];
        forceGate = true; // explicit single-task run ignores the activity gate
    } else {
        selected = deps.tasks.filter((t) => t.schedule.trim() !== "");
    }
    if (selected.length === 0) return result;

    const selectedTaskNames = selected.map((config) => config.task);
    result.backlogBefore = getDreamTaskBacklogs(deps.db, deps.projectIdentity, selectedTaskNames);
    result.backlogAfter = { ...result.backlogBefore };

    // The scheduler seeds rows so completion advancement has a row to update.
    for (const cfg of selected) ensureSeeded(deps.db, deps.projectIdentity, cfg, now);

    // Manual runs ignore schedules, so they use `scheduledAt = now`.
    const dueAll: DueTask[] = selected.map((config) => ({ config, scheduledAt: now }));

    const gated: DueTask[] = [];
    for (const d of dueAll) {
        if (forceGate) {
            gated.push(d);
            continue;
        }
        const pass = evaluateTaskGate(d.config.task, {
            db: deps.db,
            projectIdentity: deps.projectIdentity,
            lastRunAt: readLastRunAt(deps.db, deps.projectIdentity, d.config.task),
            retrospectiveWatermarkMs: readRetrospectiveWatermark(
                deps.db,
                deps.projectIdentity,
                d.config.task,
            ),
            promotionThreshold: d.config.promotionThreshold ?? 3,
        });
        if (pass) gated.push(d);
        else result.skippedNoWork.push(d.config.task);
    }
    if (gated.length === 0) {
        result.backlogAfter = getDreamTaskBacklogs(
            deps.db,
            deps.projectIdentity,
            selectedTaskNames,
        );
        return result;
    }

    const groups = new Map<string, DueTask[]>();
    for (const d of gated) {
        const kind = leaseKindFor(d.config.task);
        const arr = groups.get(kind) ?? [];
        arr.push(d);
        groups.set(kind, arr);
    }

    await Promise.all(
        [...groups.values()].map((group) =>
            runDomainGroup({ ...deps, executor: deps.executor }, group, {
                forceGate,
                leaseWaitMs: MANUAL_RUN_LEASE_WAIT_MS,
                onRan: (t) => result.ran.push(t),
                onFailed: (task, error) => {
                    result.failed.push(task);
                    if (error) result.failureDetails?.push(`${task}: ${error}`);
                },
                onBusy: (t) => result.deferredBusy.push(t),
            }),
        ),
    );
    result.backlogAfter = getDreamTaskBacklogs(deps.db, deps.projectIdentity, selectedTaskNames);
    return result;
}

/**
 * Each scheduler pass seeds missing rows, pre-gates due tasks, and runs conflict domains concurrently.
 * Each domain runs tasks sequentially in canonical order under one lease.
 * Returns the number of tasks actually executed.
 */
export async function runDueTasksForProject(deps: RunDueTasksDeps): Promise<number> {
    const now = deps.now ?? Date.now();
    const due = planDueTasks(deps.db, deps.projectIdentity, deps.tasks, now);
    if (due.length === 0) return 0;

    // The scheduler pre-gates due tasks before lease acquisition.
    const gated: DueTask[] = [];
    for (const d of due) {
        const pass = evaluateTaskGate(d.config.task, {
            db: deps.db,
            projectIdentity: deps.projectIdentity,
            lastRunAt: readLastRunAt(deps.db, deps.projectIdentity, d.config.task),
            retrospectiveWatermarkMs: readRetrospectiveWatermark(
                deps.db,
                deps.projectIdentity,
                d.config.task,
            ),
            promotionThreshold: d.config.promotionThreshold ?? 3,
        });
        if (pass) {
            gated.push(d);
        } else {
            advanceAfterRun(deps.db, deps.projectIdentity, d, now, "skipped", null);
        }
    }
    if (gated.length === 0) return 0;

    const groups = new Map<string, DueTask[]>();
    for (const d of gated) {
        const kind = leaseKindFor(d.config.task);
        const arr = groups.get(kind) ?? [];
        arr.push(d);
        groups.set(kind, arr);
    }

    await Promise.all([...groups.values()].map((group) => runDomainGroup(deps, group)));
    return gated.length;
}
