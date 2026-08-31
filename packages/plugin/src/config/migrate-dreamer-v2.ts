/**
 * The loader migrates v1 dreamer configs to v2 in memory.
 *
 * A v1 dreamer block may contain any subset of these fields.
 *   dreamer: {
 * The legacy schedule is a time window.
 * The legacy `tasks` field lists task names.
 *     task_timeout_minutes: 20,
 *     max_runtime_minutes: 120,
 *   }
 *
 * v2 shape:
 *   dreamer: {
 * Each v2 task stores its schedule and optional task settings.
 *   }
 *
 * The migration derives the base cron from the window start.
 * The migration treats a present legacy `tasks` array as the selected task set.
 * The migration assigns listed tasks the base cron and omitted canonical tasks an empty schedule.
 * The migration uses built-in defaults only when `tasks` is absent.
 * The migration disables `review-user-memories` when `user_memories.enabled` is false and otherwise assigns the base cron.
 * The migration carries `promotion_threshold` and drops `pin_key_files`.
 * The migration schedules `classify-memories` daily at 06:00 unless the dreamer block is disabled.
 * The migration assigns `evaluate-smart-notes` the base cron.
 * The migration uses `task_timeout_minutes` as each task's default `timeout_minutes` and drops `max_runtime_minutes`.
 * The migration folds retired memory task keys into `verify` and `curate` before schema parsing strips them.
 */

const OLD_VERIFY_TASK = "verify";
const OLD_CURATE_TASKS = ["consolidate", "archive-stale", "improve"] as const;
const RETIRED_OBJECT_MEMORY_TASKS = ["maintain-memory", ...OLD_CURATE_TASKS] as const;
/** Every v2 dreamer task. Exported so the doctor's coverage test can assert
 *  the on-disk migration emits an entry for every task in this list; the
 *  doctor derives its schedule set from here rather than a second list. */
export const CANONICAL_DREAMER_TASKS = [
    "map-memories",
    "verify",
    "verify-broad",
    "curate",
    "classify-memories",
    "retrospective",
    "maintain-docs",
    "evaluate-smart-notes",
    "review-user-memories",
    "promote-primers",
    "refresh-primers",
] as const;
const DEFAULT_BASE_CRON = "0 2 * * *"; // matches the historical "02:00-06:00" default window start
const DEFAULT_CLASSIFY_CRON = "0 6 * * *";
const DEFAULT_RETROSPECTIVE_CRON = "0 5 * * *";
const DEFAULT_VERIFY_BROAD_CRON = "0 4 * * 0"; // weekly — replaces the old broad_interval_days cadence

/**
 * `windowToCron` returns the default cron instead of throwing so config migration continues. */
function windowToCron(schedule: unknown): string {
    if (typeof schedule !== "string") return DEFAULT_BASE_CRON;
    const m = /^(\d{1,2}):(\d{2})\s*-/.exec(schedule.trim());
    if (!m) return DEFAULT_BASE_CRON;
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour >= 24 || minute >= 60) return DEFAULT_BASE_CRON;
    return `${minute} ${hour} * * *`;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function cronIntervalScore(schedule: string): number {
    const parts = schedule.trim().split(/\s+/);
    if (parts.length !== 5) return Number.POSITIVE_INFINITY;
    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
    if (month !== "*") return 366 * 24 * 60;
    if (dayOfMonth !== "*") return 31 * 24 * 60;
    if (dayOfWeek !== "*") return 7 * 24 * 60;
    const everyHour = /^\*\/(\d+)$/.exec(hour ?? "");
    if (everyHour) return Math.max(1, Number(everyHour[1])) * 60;
    if (hour === "*") {
        const everyMinute = /^\*\/(\d+)$/.exec(minute ?? "");
        return everyMinute ? Math.max(1, Number(everyMinute[1])) : 60;
    }
    return 24 * 60;
}

function mostFrequentSchedule(schedules: string[]): string {
    const enabled = schedules.map((s) => s.trim()).filter(Boolean);
    if (enabled.length === 0) return "";
    return enabled.sort((a, b) => cronIntervalScore(a) - cronIntervalScore(b))[0] ?? "";
}

function withoutBroadInterval(entry: Record<string, unknown>): Record<string, unknown> {
    const { broad_interval_days: _broad, ...rest } = entry;
    return rest;
}

/**
 * `reconcileV2TasksObject` backfills `verify-broad` from `verify`'s enabled state and removes `broad_interval_days`.
 *  idempotent). */
function reconcileV2TasksObject(
    rawConfig: Record<string, unknown>,
    dreamer: Record<string, unknown>,
    tasksObject: Record<string, unknown>,
): Record<string, unknown> {
    const hasVerifyBroad = "verify-broad" in tasksObject;
    const hasBroadIntervalAnywhere = Object.values(tasksObject).some(
        (v) => asObject(v) && "broad_interval_days" in (v as Record<string, unknown>),
    );
    const hasStaleKeyFiles = "key-files" in tasksObject;
    if (hasVerifyBroad && !hasBroadIntervalAnywhere && !hasStaleKeyFiles) return rawConfig;

    const nextTasks: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(tasksObject)) {
        if (key === "key-files") continue;
        const obj = asObject(value);
        nextTasks[key] = obj ? withoutBroadInterval(obj) : value;
    }
    if (!hasVerifyBroad) {
        const verify = asObject(tasksObject.verify);
        const verifyEnabled = typeof verify?.schedule === "string" && verify.schedule.trim() !== "";
        nextTasks["verify-broad"] = {
            schedule: verifyEnabled ? DEFAULT_VERIFY_BROAD_CRON : "",
        };
    }
    return { ...rawConfig, dreamer: { ...dreamer, tasks: nextTasks } };
}

export function migrateDreamerV2(
    rawConfig: Record<string, unknown>,
    warnings: string[],
): Record<string, unknown> {
    const dreamer = asObject(rawConfig.dreamer);
    if (!dreamer) return rawConfig;

    const tasksObject = asObject(dreamer.tasks);
    const hasRetiredObjectTasks = tasksObject
        ? RETIRED_OBJECT_MEMORY_TASKS.some((task) => task in tasksObject)
        : false;

    if (tasksObject && !hasRetiredObjectTasks) {
        const hasLegacyOutsideTasks =
            "schedule" in dreamer ||
            "user_memories" in dreamer ||
            "pin_key_files" in dreamer ||
            "task_timeout_minutes" in dreamer ||
            "max_runtime_minutes" in dreamer;
        if (!hasLegacyOutsideTasks) {
            return reconcileV2TasksObject(rawConfig, dreamer, tasksObject);
        }
    }

    const hasLegacy =
        "schedule" in dreamer ||
        Array.isArray(dreamer.tasks) ||
        hasRetiredObjectTasks ||
        "user_memories" in dreamer ||
        "pin_key_files" in dreamer ||
        "task_timeout_minutes" in dreamer ||
        "max_runtime_minutes" in dreamer;
    if (!hasLegacy) return rawConfig;

    const baseCron = windowToCron(dreamer.schedule);
    const timeout =
        typeof dreamer.task_timeout_minutes === "number" ? dreamer.task_timeout_minutes : undefined;
    const withTimeout = <T extends Record<string, unknown>>(entry: T): T =>
        timeout !== undefined ? { ...entry, timeout_minutes: timeout } : entry;
    const classifySchedule = dreamer.disable === true ? "" : DEFAULT_CLASSIFY_CRON;
    const retrospectiveSchedule = dreamer.disable === true ? "" : DEFAULT_RETROSPECTIVE_CRON;

    const tasks: Record<string, Record<string, unknown>> = {};

    if (tasksObject) {
        for (const [key, value] of Object.entries(tasksObject)) {
            if ((RETIRED_OBJECT_MEMORY_TASKS as readonly string[]).includes(key)) continue;
            if (asObject(value)) tasks[key] = { ...(value as Record<string, unknown>) };
        }
        const maintainMemoryEntry = asObject(tasksObject["maintain-memory"]);
        if (maintainMemoryEntry) {
            const schedule =
                typeof maintainMemoryEntry.schedule === "string"
                    ? maintainMemoryEntry.schedule
                    : baseCron;
            tasks.verify = withTimeout({
                ...withoutBroadInterval(maintainMemoryEntry),
                ...(tasks.verify ?? {}),
                schedule: tasks.verify?.schedule ?? schedule,
            });
            tasks.curate = withTimeout({
                ...withoutBroadInterval(maintainMemoryEntry),
                ...(tasks.curate ?? {}),
                schedule: tasks.curate?.schedule ?? schedule,
            });
        }

        const oldVerifyEntry = asObject(tasksObject[OLD_VERIFY_TASK]);
        if (oldVerifyEntry) {
            tasks.verify = withTimeout({
                ...withoutBroadInterval(oldVerifyEntry),
                ...(tasks.verify ?? {}),
                schedule:
                    tasks.verify?.schedule ??
                    (typeof oldVerifyEntry.schedule === "string"
                        ? oldVerifyEntry.schedule
                        : baseCron),
            });
        }

        // The migration enables `verify-broad` weekly when `verify` is enabled.
        if (!tasks["verify-broad"]) {
            const verifyEnabled =
                typeof tasks.verify?.schedule === "string" && tasks.verify.schedule.trim() !== "";
            tasks["verify-broad"] = withTimeout({
                schedule: verifyEnabled ? DEFAULT_VERIFY_BROAD_CRON : "",
            });
        }

        const oldCurateEntries = OLD_CURATE_TASKS.map((task) => asObject(tasksObject[task])).filter(
            (entry): entry is Record<string, unknown> => Boolean(entry),
        );
        if (oldCurateEntries.length > 0) {
            const oldSchedules = oldCurateEntries.map((entry) =>
                typeof entry.schedule === "string" ? entry.schedule : baseCron,
            );
            tasks.curate = withTimeout({
                ...(tasks.curate ?? {}),
                schedule: mostFrequentSchedule(oldSchedules),
            });
        }

        for (const task of CANONICAL_DREAMER_TASKS) {
            if (!tasks[task]) {
                const schedule =
                    task === "verify" || task === "curate" || task === "verify-broad"
                        ? ""
                        : task === "classify-memories"
                          ? classifySchedule
                          : task === "retrospective"
                            ? retrospectiveSchedule
                            : task === "maintain-docs"
                              ? ""
                              : baseCron;
                tasks[task] = withTimeout({ schedule });
            }
        }
    } else {
        // Any `OLD_CURATE_TASKS` member in `dreamer.tasks` enables `curate`.
        // Omitting `dreamer.tasks` enables `verify` and `curate`.
        const legacyArray = Array.isArray(dreamer.tasks)
            ? (dreamer.tasks as unknown[]).filter((t): t is string => typeof t === "string")
            : null;
        const verifySelected = legacyArray ? legacyArray.includes(OLD_VERIFY_TASK) : true;
        const curateSelected = legacyArray
            ? legacyArray.some((task) => (OLD_CURATE_TASKS as readonly string[]).includes(task))
            : true;
        tasks.verify = withTimeout({
            schedule: verifySelected ? baseCron : "",
        });
        tasks["verify-broad"] = withTimeout({
            schedule: verifySelected ? DEFAULT_VERIFY_BROAD_CRON : "",
        });
        tasks.curate = withTimeout({
            schedule: curateSelected ? baseCron : "",
        });
        tasks["classify-memories"] = withTimeout({
            schedule: classifySchedule,
        });
        tasks.retrospective = withTimeout({
            schedule: retrospectiveSchedule,
        });
        tasks["maintain-docs"] = withTimeout({
            schedule: legacyArray?.includes("maintain-docs") ? baseCron : "",
        });
    }

    tasks["map-memories"] ??= withTimeout({ schedule: baseCron });

    tasks["evaluate-smart-notes"] ??= withTimeout({ schedule: baseCron });

    const um = asObject(dreamer.user_memories);
    const umEnabled = um ? um.enabled !== false : true;
    if (um || !tasks["review-user-memories"]) {
        tasks["review-user-memories"] = withTimeout({
            ...(tasks["review-user-memories"] ?? {}),
            schedule: umEnabled ? baseCron : "",
            ...(um && typeof um.promotion_threshold === "number"
                ? { promotion_threshold: um.promotion_threshold }
                : {}),
        });
    }


    const {
        schedule: _schedule,
        tasks: _tasks,
        task_timeout_minutes: _tto,
        max_runtime_minutes: _max,
        user_memories: _um,
        pin_key_files: _pkf,
        ...rest
    } = dreamer;

    warnings.push(
        'Migrated legacy dreamer scheduling (schedule window / tasks array / user_memories / pin_key_files) → per-task "dreamer.tasks" in-memory (run `doctor` to persist).',
    );

    return { ...rawConfig, dreamer: { ...rest, tasks } };
}
