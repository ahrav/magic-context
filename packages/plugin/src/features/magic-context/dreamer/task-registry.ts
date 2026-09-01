/**
 * This module has no DB imports, so the config schema can import these task names.
 *
 * Disjoint-state tasks use separate lease domains; memory-mutating tasks share a lease and serialize.
 */

export const CANONICAL_DREAM_TASKS = [
    // `map-memories` precedes `verify` because it records the file mappings that `verify` gates on.
    "map-memories",
    "verify",
    "verify-broad",
    "curate",
    "compress-cues",
    "classify-memories",
    "retrospective",
    "maintain-docs",
    "evaluate-smart-notes",
    "review-user-memories",
    "promote-primers",
    "refresh-primers",
] as const;

export type DreamTaskName = (typeof CANONICAL_DREAM_TASKS)[number];

/* */
export interface DreamTaskBacklog {
    /** `pending` counts items that the task's current backlog predicate selects. */
    pending: number;
    /** `total` counts every item in the task's candidate pool. */
    total: number;
}

/* */
export type DreamTaskBacklogMap = Partial<Record<DreamTaskName, DreamTaskBacklog>>;

/* */
export function formatDreamTaskBacklogs(
    backlogs: DreamTaskBacklogMap,
    tasks: readonly DreamTaskName[] = CANONICAL_DREAM_TASKS,
): string {
    return tasks
        .filter((task) => backlogs[task] !== undefined)
        .map((task) => {
            const backlog = backlogs[task];
            return `- ${task}: ${backlog?.pending ?? 0} pending / ${backlog?.total ?? 0} total`;
        })
        .join("\n");
}

/* */
export interface DreamTaskProgress {
    task: DreamTaskName;
    processed: number;
    total: number;
    startedAt: number;
}

/* */
export interface DreamTaskRunBacklog {
    pendingAtStart: number;
    totalAtStart: number;
    pendingAtEnd: number;
    totalAtEnd: number;
    processed: number;
}

/* */
export function processedDreamTaskItems(startPending: number, endPending: number): number {
    return Math.max(0, startPending - endPending);
}

/**
 * `curate` and `maintain-docs` run generic dreamer agent sessions through `buildDreamTaskPrompt`.
 * Specialized runners handle every other canonical task.
 */
export const AGENTIC_DREAM_TASKS = ["curate", "maintain-docs"] as const;

/**
 * `MEMORY_DOMAIN_TASKS` contains tasks that read-modify-write `memories`, epoch, or supersede-delta rows.
 * `MEMORY_DOMAIN_TASKS` share one per-project `memory` lease.
 * Concurrent memory-domain runs can race on stale views.
 * `MEMORY_DOMAIN_TASKS` defines the run order when several tasks are due in one drain.
 */
export const MEMORY_DOMAIN_TASKS: readonly DreamTaskName[] = [
    "map-memories",
    "verify",
    "verify-broad",
    "curate",
    "compress-cues",
    "classify-memories",
    "retrospective",
    "promote-primers",
    "refresh-primers",
];

const MEMORY_DOMAIN_SET = new Set<DreamTaskName>(MEMORY_DOMAIN_TASKS);

/**
 * `memory`, `maintain-docs`, and `evaluate-smart-notes` leases are per-project; `user-memories` is global.
 * `user-memories` uses a global lease because it mutates the cross-project user-profile pool.
 * `review-user-memories` runs from different projects must not run concurrently.
 */
export type LeaseKind = "memory" | "maintain-docs" | "evaluate-smart-notes" | "user-memories";

export function leaseKindFor(task: DreamTaskName): LeaseKind {
    if (MEMORY_DOMAIN_SET.has(task)) return "memory";
    switch (task) {
        case "review-user-memories":
            return "user-memories";
        case "promote-primers":
        case "refresh-primers":
            return "memory";
        case "maintain-docs":
            return "maintain-docs";
        case "evaluate-smart-notes":
            return "evaluate-smart-notes";
        default:
            return "memory";
    }
}

/**
 */
export function leaseKeyFor(task: DreamTaskName, projectIdentity: string): string {
    const kind = leaseKindFor(task);
    return kind === "user-memories" ? "user-memories" : `${kind}:${projectIdentity}`;
}

export function isCanonicalDreamTask(value: string): value is DreamTaskName {
    return (CANONICAL_DREAM_TASKS as readonly string[]).includes(value);
}

/**
 */
export function compareTaskOrder(a: DreamTaskName, b: DreamTaskName): number {
    return CANONICAL_DREAM_TASKS.indexOf(a) - CANONICAL_DREAM_TASKS.indexOf(b);
}
