import type { Database } from "../../../shared/sqlite";
import { type DreamTaskBacklog, type DreamTaskBacklogMap, type DreamTaskName } from "./task-registry";
/**
 * Per-task activity gates (Dreamer v2 A+B). A due task runs ONLY if its gate
 * passes, so cron cadence never burns a 60-turn agentic loop on an unchanged
 * pool. Gates are conservative — allow when uncertain — and cheap (count
 * queries, no full-row loads, no LLM).
 *
 * `lastRunAt` is the task's own `task_schedule_state.last_run_at` (null = never
 * run → treat "changed since" gates as "is there anything at all").
 */
export interface TaskGateContext {
    db: Database;
    projectIdentity: string;
    lastRunAt: number | null;
    /** retrospective content watermark (max message ts scanned). Distinct from
     *  lastRunAt: a session updated mid-run is newer than its scanned content but
     *  older than the run-completion time, so gating on lastRunAt would skip it. */
    retrospectiveWatermarkMs?: number | null;
    /** review-user-memories: min candidate observations before a review is worthwhile. */
    promotionThreshold: number;
}
export declare function countActiveMemories(db: Database, projectPath: string): number;
/** Active claims whose latest baseline assertion has no `paths_state = 'known'`. */
export declare function countUnmappedActiveMemories(db: Database, projectPath: string): number;
export declare function countCompartmentsSince(db: Database, projectPath: string, since: number): number;
export declare function countProjectSessionsSince(db: Database, projectPath: string, since: number | null): number;
/**
 * Read-only backlog probe for one task. These probes reuse the task selection
 * predicates and never acquire a lease, materialize a prompt cache, or invoke a model.
 */
export declare function getDreamTaskBacklog(db: Database, projectPath: string, task: DreamTaskName, options?: {
    lastRunAt?: number | null;
    retrospectiveWatermarkMs?: number | null;
}): DreamTaskBacklog;
/** Read the complete backlog breakdown in the caller's requested registry order. */
export declare function getDreamTaskBacklogs(db: Database, projectPath: string, tasks?: readonly DreamTaskName[], options?: {
    lastRunAt?: number | null;
    retrospectiveWatermarkMs?: number | null;
}): DreamTaskBacklogMap;
/**
 * Evaluate a task's activity gate. Returns true if the task has work to do.
 * Throwing DB errors propagate to the caller (a gate that can't read is a real
 * problem, not silently "no work").
 */
export declare function evaluateTaskGate(task: DreamTaskName, ctx: TaskGateContext): boolean;
//# sourceMappingURL=task-gates.d.ts.map