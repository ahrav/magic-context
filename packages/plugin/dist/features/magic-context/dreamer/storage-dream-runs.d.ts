import type { Database } from "../../../shared/sqlite";
import { type ClaimOperationResultEffect } from "../memory/claim-operation-contract";
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
    writtenIds?: number[];
    deletedIds?: number[];
    archivedIds?: number[];
    mergedIds?: number[];
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
export declare function claimEffectMemoryChanges(effects: readonly ClaimOperationResultEffect[]): DreamRunMemoryChanges | null;
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
export declare function insertDreamRun(db: Database, run: DreamRunInput): void;
export declare function getDreamRuns(db: Database, projectPath: string, limit?: number): DreamRunRow[];
//# sourceMappingURL=storage-dream-runs.d.ts.map