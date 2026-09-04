/**
 * Canonical Dreamer v2 task registry (pure — no DB imports, so the config schema
 * can import the task names without pulling runtime code).
 *
 * v2 promotes the former post-phases (review-user-memories, key-files,
 * evaluate-smart-notes) to first-class scheduled tasks alongside the agentic
 * maintenance tasks, and assigns each a LEASE DOMAIN so disjoint-state tasks run
 * concurrently while memory-mutating tasks serialize. See lease.ts + the A+B spec.
 */
export declare const CANONICAL_DREAM_TASKS: readonly ["map-memories", "verify", "verify-broad", "curate", "compress-cues", "classify-memories", "retrospective", "maintain-docs", "evaluate-smart-notes", "review-user-memories", "promote-primers", "refresh-primers"];
export type DreamTaskName = (typeof CANONICAL_DREAM_TASKS)[number];
/** Cheap, read-only work counts for one Dreamer task. */
export interface DreamTaskBacklog {
    /** Items selected by the task's current backlog predicate. */
    pending: number;
    /** Total items in the task's candidate pool. */
    total: number;
}
/** Backlog counts keyed by canonical task name. */
export type DreamTaskBacklogMap = Partial<Record<DreamTaskName, DreamTaskBacklog>>;
/** Stable human-readable rendering shared by /ctx-dream and status surfaces. */
export declare function formatDreamTaskBacklogs(backlogs: DreamTaskBacklogMap, tasks?: readonly DreamTaskName[]): string;
/** Process-local progress for the task currently applying a run chunk. */
export interface DreamTaskProgress {
    task: DreamTaskName;
    processed: number;
    total: number;
    startedAt: number;
}
/** Persisted per-task run counts used by dream-run history and summaries. */
export interface DreamTaskRunBacklog {
    pendingAtStart: number;
    totalAtStart: number;
    pendingAtEnd: number;
    totalAtEnd: number;
    processed: number;
}
/** Use the decrease in the persisted backlog between the start and end snapshots as the per-run progress count, clamped to zero when the backlog does not decrease. */
export declare function processedDreamTaskItems(startPending: number, endPending: number): number;
/**
 * The agentic tasks — those run as a generic dreamer agent session driven by
 * `buildDreamTaskPrompt`. The other canonical tasks (map-memories, verify,
 * verify-broad, classify-memories, review-user-memories, evaluate-smart-notes,
 * primers, retrospective) have their own specialized runners and do NOT go
 * through the prompt builder.
 */
export declare const AGENTIC_DREAM_TASKS: readonly ["curate", "maintain-docs"];
/**
 * Tasks that read-modify-write the project `memories` table (+ epoch +
 * supersede-delta rows). They SHARE one per-project "memory" lease so they
 * serialize with each other — concurrent runs race semantically (stale-view
 * merges/splits). Canonical run order when several are due in one drain.
 */
export declare const MEMORY_DOMAIN_TASKS: readonly DreamTaskName[];
/**
 * Lease KIND per task. `memory` + the three independent kinds are per-project;
 * `user-memories` is GLOBAL (mutates the cross-project user-profile pool, so two
 * different projects' dreamers must not review concurrently).
 */
export type LeaseKind = "memory" | "maintain-docs" | "evaluate-smart-notes" | "user-memories";
export declare function leaseKindFor(task: DreamTaskName): LeaseKind;
/**
 * Resolve the concrete lease key for a task in a project. The global
 * `user-memories` lease is NOT project-scoped (one reviewer across all projects);
 * every other domain is keyed by project so different projects never block.
 */
export declare function leaseKeyFor(task: DreamTaskName, projectIdentity: string): string;
export declare function isCanonicalDreamTask(value: string): value is DreamTaskName;
/**
 * Stable canonical ordering used when multiple due tasks share a lease domain
 * (preserves the suite order for the memory domain).
 */
export declare function compareTaskOrder(a: DreamTaskName, b: DreamTaskName): number;
//# sourceMappingURL=task-registry.d.ts.map