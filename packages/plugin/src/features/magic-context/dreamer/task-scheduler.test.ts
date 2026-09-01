/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import type { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { createClaimReaderTestDatabase, seedProjectMemoryClaim } from "../test-claim-database";
import { acquireLease, releaseLease } from "./lease";
import { setDreamState } from "./storage-dream-state";
import {
    deleteTaskScheduleRowsForProject,
    getTaskScheduleState,
    writeTaskScheduleState,
} from "./storage-task-schedule";
import { leaseKeyFor } from "./task-registry";
import {
    type DreamTaskRuntimeConfig,
    planDueTasks,
    runDueTasksForProject,
    runManualDream,
    type TaskExecOutcome,
} from "./task-scheduler";

let db: Database | null = null;
afterEach(() => {
    if (db) closeQuietly(db);
    db = null;
});

function freshDb(): Database {
    return createClaimReaderTestDatabase();
}

const PROJECT = "git:abc";

function cfg(
    task: DreamTaskRuntimeConfig["task"],
    schedule: string,
    extra: Partial<DreamTaskRuntimeConfig> = {},
): DreamTaskRuntimeConfig {
    return { task, schedule, timeoutMinutes: 20, ...extra };
}

/** Active claims satisfy memory-domain gates. */
let memorySeq = 0;
function seedActiveMemory(d: Database, project = PROJECT): void {
    memorySeq += 1;
    seedProjectMemoryClaim(d, {
        projectIdentity: project,
        category: "PROJECT_RULES",
        content: `mem-${memorySeq}`,
    });
}

describe("task-scheduler — manual lease wait", () => {
    it("manual run waits for a briefly-held domain lease instead of reporting busy", async () => {
        db = freshDb();
        seedActiveMemory(db);
        const leaseKey = leaseKeyFor("curate", PROJECT);
        const otherHolder = "other-process";
        expect(acquireLease(db, otherHolder, leaseKey)).toBe(true);
        setTimeout(() => releaseLease(db as Database, otherHolder, leaseKey), 150);

        let executed = 0;
        const executor = async (): Promise<TaskExecOutcome> => {
            executed += 1;
            return { status: "completed" };
        };
        const result = await runManualDream({
            db,
            projectIdentity: PROJECT,
            tasks: [cfg("curate", "0 4 * * 0")],
            executor,
            task: "curate",
        });
        expect(executed).toBe(1);
        expect(result.ran).toEqual(["curate"]);
        expect(result.deferredBusy).toEqual([]);
    });

    it("scheduled ticks do not wait on a busy lease", async () => {
        db = freshDb();
        seedActiveMemory(db);
        const leaseKey = leaseKeyFor("curate", PROJECT);
        expect(acquireLease(db, "other-process", leaseKey)).toBe(true);

        const now = Date.now();
        writeTaskScheduleState(db, {
            projectPath: PROJECT,
            task: "curate",
            lastRunAt: null,
            nextDueAt: now - 1000,
            schedule: "0 4 * * 0",
            lastStatus: null,
            lastError: null,
            retryCount: 0,
        });
        let executed = 0;
        const executor = async (): Promise<TaskExecOutcome> => {
            executed += 1;
            return { status: "completed" };
        };
        const started = Date.now();
        await runDueTasksForProject({
            db,
            projectIdentity: PROJECT,
            tasks: [cfg("curate", "0 4 * * 0")],
            executor,
            now,
        });
        expect(executed).toBe(0);
        // No lease-wait loop on the scheduled path: returns immediately.
        expect(Date.now() - started).toBeLessThan(1500);
    });
});

describe("task-scheduler — planDueTasks", () => {
    it("first-seed does NOT fire immediately (next_due in the future)", () => {
        db = freshDb();
        const now = Date.UTC(2026, 0, 1, 12, 0); // midday
        const due = planDueTasks(db, PROJECT, [cfg("verify", "0 3 * * *")], now);
        expect(due).toHaveLength(0);
        const state = getTaskScheduleState(db, PROJECT, "verify");
        expect(state?.nextDueAt).not.toBeNull();
        expect(state?.nextDueAt).toBeGreaterThan(now);
    });

    it("seeds last_run_at from legacy last_dream_at (no full historical pass)", () => {
        db = freshDb();
        setDreamState(db, `last_dream_at:${PROJECT}`, "555000");
        planDueTasks(db, PROJECT, [cfg("verify", "0 3 * * *")], Date.now());
        expect(getTaskScheduleState(db, PROJECT, "verify")?.lastRunAt).toBe(555000);
    });

    it("prunes retired task rows not in the canonical config set", () => {
        db = freshDb();
        // The scheduler prunes stale rows from obsolete scheduler configurations.
        // Pruning removes task names absent from the canonical configuration.
        for (const task of ["improve", "consolidate", "archive-stale", "render-mural"] as const) {
            writeTaskScheduleState(db, {
                projectPath: PROJECT,
                task,
                lastRunAt: null,
                nextDueAt: Date.now() - 1000,
                schedule: "0 3 * * *",
                lastStatus: "skipped",
                lastError: null,
                retryCount: 0,
                lastCheckedCommit: null,
                retrospectiveWatermarkMs: null,
            });
        }
        // A plan pass with the canonical config set deletes stale task-schedule rows.
        planDueTasks(
            db,
            PROJECT,
            [cfg("verify", "0 3 * * *"), cfg("curate", "0 4 * * 0")],
            Date.now(),
        );
        for (const task of ["improve", "consolidate", "archive-stale", "render-mural"] as const) {
            expect(getTaskScheduleState(db, PROJECT, task)).toBeNull();
        }
        // Pruning preserves rows for canonical task names.
        expect(getTaskScheduleState(db, PROJECT, "verify")).not.toBeNull();
        expect(getTaskScheduleState(db, PROJECT, "curate")).not.toBeNull();
    });

    it("deleteTaskScheduleRowsForProject removes ALL rows for an orphaned project only", () => {
        db = freshDb();
        const orphan = "dir:deadworktree";
        planDueTasks(
            db,
            orphan,
            [cfg("verify", "0 3 * * *"), cfg("curate", "0 4 * * 0")],
            Date.now(),
        );
        planDueTasks(db, PROJECT, [cfg("verify", "0 3 * * *")], Date.now());
        expect(getTaskScheduleState(db, orphan, "verify")).not.toBeNull();

        const removed = deleteTaskScheduleRowsForProject(db, orphan);
        expect(removed).toBe(2);
        expect(getTaskScheduleState(db, orphan, "verify")).toBeNull();
        expect(getTaskScheduleState(db, orphan, "curate")).toBeNull();
        // Pruning preserves task-schedule rows for other projects.
        expect(getTaskScheduleState(db, PROJECT, "verify")).not.toBeNull();
    });

    it("disabled schedule ('') seeds a NULL-due row that is never due", () => {
        db = freshDb();
        const due = planDueTasks(db, PROJECT, [cfg("maintain-docs", "")], Date.now());
        expect(due).toHaveLength(0);
        expect(getTaskScheduleState(db, PROJECT, "maintain-docs")?.nextDueAt).toBeNull();
    });

    it("a past next_due_at is collected as due", () => {
        db = freshDb();
        const now = Date.now();
        planDueTasks(db, PROJECT, [cfg("verify", "0 3 * * *")], now);
        writeTaskScheduleState(db, {
            projectPath: PROJECT,
            task: "verify",
            lastRunAt: null,
            nextDueAt: now - 1000,
            schedule: "0 3 * * *",
            lastStatus: null,
            lastError: null,
            retryCount: 0,
        });
        const due = planDueTasks(db, PROJECT, [cfg("verify", "0 3 * * *")], now);
        expect(due.map((d) => d.config.task)).toEqual(["verify"]);
    });

    // Config-authoritative reconciliation
    it("disabling a task AFTER it was seeded forces next_due_at NULL (no stale fire)", () => {
        db = freshDb();
        const now = Date.now();
        planDueTasks(db, PROJECT, [cfg("verify", "0 3 * * *")], now);
        forceDue(db, "verify", now);
        // A disabled config prevents a stale past-due slot from firing.
        const due = planDueTasks(db, PROJECT, [cfg("verify", "")], now);
        expect(due).toHaveLength(0);
        expect(getTaskScheduleState(db, PROJECT, "verify")?.nextDueAt).toBeNull();
    });

    it("enabling a task that was seeded NULL (disabled) makes it due-eligible", () => {
        db = freshDb();
        const now = Date.UTC(2026, 0, 1, 12, 0);
        planDueTasks(db, PROJECT, [cfg("maintain-docs", "")], now);
        expect(getTaskScheduleState(db, PROJECT, "maintain-docs")?.nextDueAt).toBeNull();
        // Enabling the task computes a future next_due instead of running it immediately.
        planDueTasks(db, PROJECT, [cfg("maintain-docs", "0 3 * * *")], now);
        const state = getTaskScheduleState(db, PROJECT, "maintain-docs");
        expect(state?.nextDueAt).not.toBeNull();
        expect(state?.nextDueAt).toBeGreaterThan(now);
        expect(state?.schedule).toBe("0 3 * * *");
    });

    it("changing the cron recomputes next_due_at from the new schedule", () => {
        db = freshDb();
        const now = Date.UTC(2026, 0, 1, 12, 0);
        planDueTasks(db, PROJECT, [cfg("verify", "0 3 * * *")], now);
        const before = getTaskScheduleState(db, PROJECT, "verify")?.nextDueAt;
        // An hourly schedule moves next_due to the next top of the hour.
        planDueTasks(db, PROJECT, [cfg("verify", "0 * * * *")], now);
        const after = getTaskScheduleState(db, PROJECT, "verify");
        expect(after?.schedule).toBe("0 * * * *");
        expect(after?.nextDueAt).not.toBe(before);
        expect(after?.nextDueAt).toBeLessThan(before ?? Number.POSITIVE_INFINITY);
    });

    it("legacy row (schedule IS NULL) with a live next_due is backfilled, not recomputed", () => {
        db = freshDb();
        const now = Date.now();
        const due = now - 1000;
        // A NULL schedule with a past next_due remains due.
        writeTaskScheduleState(db, {
            projectPath: PROJECT,
            task: "verify",
            lastRunAt: null,
            nextDueAt: due,
            schedule: null,
            lastStatus: null,
            lastError: null,
            retryCount: 0,
        });
        const collected = planDueTasks(db, PROJECT, [cfg("verify", "0 3 * * *")], now);
        // The scheduler preserves the past-due slot and fires it.
        expect(collected.map((d) => d.config.task)).toEqual(["verify"]);
        const state = getTaskScheduleState(db, PROJECT, "verify");
        expect(state?.schedule).toBe("0 3 * * *");
        expect(state?.nextDueAt).toBe(due);
    });
});

/* */
function forceDue(d: Database, task: DreamTaskRuntimeConfig["task"], now: number): void {
    const prior = getTaskScheduleState(d, PROJECT, task);
    writeTaskScheduleState(d, {
        projectPath: PROJECT,
        task,
        lastRunAt: null,
        nextDueAt: now - 1000,
        schedule: prior?.schedule ?? "0 3 * * *",
        lastStatus: null,
        lastError: null,
        retryCount: 0,
    });
}

describe("task-scheduler — runDueTasksForProject", () => {
    it("runs a due+gated task and advances next_due to the future", async () => {
        db = freshDb();
        seedActiveMemory(db);
        const now = Date.now();
        const tasks = [cfg("verify", "0 3 * * *")];
        planDueTasks(db, PROJECT, tasks, now);
        forceDue(db, "verify", now);

        const ran: string[] = [];
        const executor = async (): Promise<TaskExecOutcome> => {
            ran.push("verify");
            return { status: "completed" };
        };
        await runDueTasksForProject({
            db,
            projectIdentity: PROJECT,
            tasks,
            executor,
            now,
        });
        expect(ran).toEqual(["verify"]);
        const state = getTaskScheduleState(db, PROJECT, "verify");
        expect(state?.lastStatus).toBe("completed");
        expect(state?.lastRunAt).toBeGreaterThanOrEqual(now);
        expect(state?.nextDueAt).toBeGreaterThan(now);
    });

    it("skips a due task whose gate fails (no active memories) and advances it", async () => {
        db = freshDb();
        // No memories → verify gate fails.
        const now = Date.now();
        const tasks = [cfg("verify", "0 3 * * *")];
        planDueTasks(db, PROJECT, tasks, now);
        forceDue(db, "verify", now);

        let ranExecutor = false;
        const executor = async (): Promise<TaskExecOutcome> => {
            ranExecutor = true;
            return { status: "completed" };
        };
        const count = await runDueTasksForProject({
            db,
            projectIdentity: PROJECT,
            tasks,
            executor,
            now,
        });
        expect(count).toBe(0);
        expect(ranExecutor).toBe(false);
        const state = getTaskScheduleState(db, PROJECT, "verify");
        expect(state?.lastStatus).toBe("skipped");
        expect(state?.nextDueAt).toBeGreaterThan(now);
    });

    it("completed runs persist the retrospective content watermark patch", async () => {
        db = freshDb();
        seedActiveMemory(db);
        const now = Date.now();
        // curate has no memory-domain gate, so the mocked executor runs without seeded memory.
        const tasks = [cfg("curate", "0 3 * * *")];
        planDueTasks(db, PROJECT, tasks, now);
        forceDue(db, "curate", now);

        const executor = async (): Promise<TaskExecOutcome> => ({
            status: "completed",
            schedulePatch: { retrospectiveWatermarkMs: 1700000000000 },
        });
        await runDueTasksForProject({ db, projectIdentity: PROJECT, tasks, executor, now });
        const state = getTaskScheduleState(db, PROJECT, "curate");
        expect(state?.retrospectiveWatermarkMs).toBe(1700000000000);
    });

    it("partial broad success advances the schedule while keeping its cycle open", async () => {
        db = freshDb();
        seedActiveMemory(db);
        const now = Date.now();
        const tasks = [cfg("verify-broad", "0 3 * * 0")];
        writeTaskScheduleState(db, {
            projectPath: PROJECT,
            task: "verify-broad",
            lastRunAt: null,
            nextDueAt: now - 1000,
            schedule: "0 3 * * 0",
            lastStatus: null,
            lastError: null,
            retryCount: 0,
            lastBroadRunAt: 123,
        });

        const executor = async (): Promise<TaskExecOutcome> => ({ status: "completed" });
        await runDueTasksForProject({ db, projectIdentity: PROJECT, tasks, executor, now });
        const state = getTaskScheduleState(db, PROJECT, "verify-broad");
        expect(state?.lastStatus).toBe("completed");
        expect(state?.lastRunAt).toBeGreaterThanOrEqual(now);
        expect(state?.nextDueAt).toBeGreaterThan(now);
        expect(state?.lastBroadRunAt).toBe(123);
    });

    it("a busy domain lease defers its tasks (next_due unchanged, no run)", async () => {
        db = freshDb();
        seedActiveMemory(db);
        const now = Date.now();
        const tasks = [cfg("verify", "0 3 * * *")];
        planDueTasks(db, PROJECT, tasks, now);
        forceDue(db, "verify", now);
        expect(acquireLease(db, "other-holder", leaseKeyFor("verify", PROJECT))).toBe(true);

        let ran = false;
        const executor = async (): Promise<TaskExecOutcome> => {
            ran = true;
            return { status: "completed" };
        };
        await runDueTasksForProject({ db, projectIdentity: PROJECT, tasks, executor, now });
        expect(ran).toBe(false);
        // next_due stayed in the past → still due next tick.
        const state = getTaskScheduleState(db, PROJECT, "verify");
        expect(state?.nextDueAt).toBeLessThan(now);
        expect(state?.lastStatus).toBeNull();
    });

    it("different domains run CONCURRENTLY (memory + smart-notes both execute)", async () => {
        db = freshDb();
        seedActiveMemory(db);
        // The pending smart note satisfies the evaluate-smart-notes gate.
        db.prepare(
            `INSERT INTO notes (type, project_path, content, status, created_at, updated_at)
             VALUES ('smart', ?, 'n', 'pending', 1, 1)`,
        ).run(PROJECT);
        const now = Date.now();
        const tasks = [cfg("verify", "0 3 * * *"), cfg("evaluate-smart-notes", "0 3 * * *")];
        planDueTasks(db, PROJECT, tasks, now);
        forceDue(db, "verify", now);
        forceDue(db, "evaluate-smart-notes", now);

        const ran = new Set<string>();
        const executor = async (c: DreamTaskRuntimeConfig): Promise<TaskExecOutcome> => {
            ran.add(c.task);
            return { status: "completed" };
        };
        const count = await runDueTasksForProject({
            db,
            projectIdentity: PROJECT,
            tasks,
            executor,
            now,
        });
        expect(count).toBe(2);
        expect(ran.has("verify")).toBe(true);
        expect(ran.has("evaluate-smart-notes")).toBe(true);
    });

    it("verify and curate share the memory domain and run in canonical order", async () => {
        db = freshDb();
        seedActiveMemory(db);
        const now = Date.now();
        const tasks = [cfg("curate", "0 4 * * 0"), cfg("verify", "0 3 * * *")];
        planDueTasks(db, PROJECT, tasks, now);
        forceDue(db, "verify", now);
        forceDue(db, "curate", now);

        const ran: string[] = [];
        const leaseKeys = new Set<string>();
        const executor = async (
            c: DreamTaskRuntimeConfig,
            ctx: { leaseKey: string },
        ): Promise<TaskExecOutcome> => {
            ran.push(c.task);
            leaseKeys.add(ctx.leaseKey);
            return { status: "completed" };
        };

        const count = await runDueTasksForProject({
            db,
            projectIdentity: PROJECT,
            tasks,
            executor,
            now,
        });
        expect(count).toBe(2);
        expect(ran).toEqual(["verify", "curate"]);
        expect([...leaseKeys]).toEqual([leaseKeyFor("verify", PROJECT)]);
    });

    it("stops a domain group before the next task when the lease is no longer held", async () => {
        db = freshDb();
        seedActiveMemory(db);
        const now = Date.now();
        const tasks = [cfg("verify", "0 3 * * *"), cfg("curate", "0 4 * * 0")];
        planDueTasks(db, PROJECT, tasks, now);
        forceDue(db, "verify", now);
        forceDue(db, "curate", now);

        const ran: string[] = [];
        const executor = async (
            c: DreamTaskRuntimeConfig,
            ctx: { holderId: string; leaseKey: string },
        ): Promise<TaskExecOutcome> => {
            ran.push(c.task);
            releaseLease(db as Database, ctx.holderId, ctx.leaseKey);
            return { status: "completed" };
        };

        await runDueTasksForProject({
            db,
            projectIdentity: PROJECT,
            tasks,
            executor,
            now,
        });
        expect(ran).toEqual(["verify"]);
        expect(getTaskScheduleState(db, PROJECT, "curate")?.nextDueAt).toBeLessThan(now);
    });

    it("transient failure keeps next_due (hot-retry) until MAX_TASK_RETRIES, then advances", async () => {
        db = freshDb();
        seedActiveMemory(db);
        const now = Date.now();
        const tasks = [cfg("verify", "0 3 * * *")];

        const executor = async (): Promise<TaskExecOutcome> => ({
            status: "failed",
            transient: true,
            error: "rate limit",
        });

        // A transient failure keeps `next_due` in the past, so retries remain due across ticks; re-forcing resets `retry_count`.
        // The task stays due across ticks without re-forcing; re-forcing resets `retry_count`.
        // Re-forcing resets retry_count.
        planDueTasks(db, PROJECT, tasks, now);
        forceDue(db, "verify", now);
        // Attempts 1..3 keep next_due in the past (retry next tick).
        for (let attempt = 1; attempt <= 3; attempt++) {
            await runDueTasksForProject({ db, projectIdentity: PROJECT, tasks, executor, now });
            const s = getTaskScheduleState(db, PROJECT, "verify");
            expect(s?.retryCount).toBe(attempt);
            expect(s?.lastRunAt).toBeNull();
            expect(s?.nextDueAt).toBeLessThan(now); // still due
        }
        // Attempt 4 exceeds `MAX_TASK_RETRIES = 3`, advances `next_due`, and resets `retry_count`.
        await runDueTasksForProject({ db, projectIdentity: PROJECT, tasks, executor, now });
        const s = getTaskScheduleState(db, PROJECT, "verify");
        expect(s?.retryCount).toBe(0);
        expect(s?.nextDueAt).toBeGreaterThan(now);
        expect(s?.lastStatus).toBe("failed");
    });

    it("permanent failure advances to the next cron slot (no hot-retry)", async () => {
        db = freshDb();
        seedActiveMemory(db);
        const now = Date.now();
        const tasks = [cfg("verify", "0 3 * * *")];
        planDueTasks(db, PROJECT, tasks, now);
        forceDue(db, "verify", now);
        const executor = async (): Promise<TaskExecOutcome> => ({
            status: "failed",
            transient: false,
            error: "model not found",
        });
        await runDueTasksForProject({ db, projectIdentity: PROJECT, tasks, executor, now });
        const s = getTaskScheduleState(db, PROJECT, "verify");
        expect(s?.nextDueAt).toBeGreaterThan(now);
        expect(s?.retryCount).toBe(0);
        expect(s?.lastStatus).toBe("failed");
    });
});

describe("task-scheduler — runManualDream", () => {
    it("no task arg runs ALL enabled tasks regardless of schedule (not due)", async () => {
        db = freshDb();
        seedActiveMemory(db);
        db.prepare(
            `INSERT INTO notes (type, project_path, content, status, created_at, updated_at)
             VALUES ('smart', ?, 'n', 'pending', 1, 1)`,
        ).run(PROJECT);
        const tasks = [
            cfg("verify", "0 3 * * *"),
            cfg("evaluate-smart-notes", "0 3 * * *"),
            cfg("maintain-docs", ""), // disabled → must NOT run even manually
        ];
        const ran: string[] = [];
        const executor = async (c: DreamTaskRuntimeConfig): Promise<TaskExecOutcome> => {
            ran.push(c.task);
            return { status: "completed" };
        };
        const result = await runManualDream({ db, projectIdentity: PROJECT, tasks, executor });
        expect(result.ran.sort()).toEqual(["evaluate-smart-notes", "verify"]);
        expect(ran).not.toContain("maintain-docs"); // disabled stays off
    });

    it("a single task arg FORCE-runs it ignoring the activity gate", async () => {
        db = freshDb();
        // Forced `verify` runs bypass its memory gate.
        const tasks = [cfg("verify", "0 3 * * *")];
        let ran = false;
        const executor = async (): Promise<TaskExecOutcome> => {
            ran = true;
            return { status: "completed" };
        };
        const result = await runManualDream({
            db,
            projectIdentity: PROJECT,
            tasks,
            executor,
            task: "verify",
        });
        expect(ran).toBe(true);
        expect(result.ran).toEqual(["verify"]);
    });

    it("a single DISABLED task can still be force-run by name", async () => {
        db = freshDb();
        const tasks = [cfg("maintain-docs", "")]; // disabled
        let ran = false;
        const executor = async (): Promise<TaskExecOutcome> => {
            ran = true;
            return { status: "completed" };
        };
        const result = await runManualDream({
            db,
            projectIdentity: PROJECT,
            tasks,
            executor,
            task: "maintain-docs",
        });
        expect(ran).toBe(true);
        expect(result.ran).toEqual(["maintain-docs"]);
    });

    it("reports gate-skipped tasks in the all-enabled run", async () => {
        db = freshDb();
        // Without active memories, the scheduler skips the enabled `verify` task because its gate fails.
        const tasks = [cfg("verify", "0 3 * * *")];
        const executor = async (): Promise<TaskExecOutcome> => ({ status: "completed" });
        const result = await runManualDream({ db, projectIdentity: PROJECT, tasks, executor });
        expect(result.ran).toEqual([]);
        expect(result.skippedNoWork).toEqual(["verify"]);
    });

    it("an unknown forced task name is a no-op", async () => {
        db = freshDb();
        const tasks = [cfg("verify", "0 3 * * *")];
        const executor = async (): Promise<TaskExecOutcome> => ({ status: "completed" });
        const result = await runManualDream({
            db,
            projectIdentity: PROJECT,
            tasks,
            executor,
            task: "not-a-task" as never,
        });
        expect(result.ran).toEqual([]);
    });
});
