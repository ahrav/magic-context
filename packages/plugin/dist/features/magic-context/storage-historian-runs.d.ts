import type { Database } from "../../shared/sqlite";
/**
 * Per historian-invocation telemetry.
 *
 * One row per attempted historian run (incremental publish, recomp pass, or
 * session-upgrade), recording the INPUT (chunk range) and OUTPUT shape
 * (compartments / facts / events / importance) plus success/failure. Tokens and
 * the model used live on the FK-linked `subagent_invocations` row
 * (`subagentInvocationId`) — join to get cost/model.
 *
 * Purpose: debugging (which range produced what), quality analysis (facts per
 * output token, importance distribution by model), and the productization /
 * training-data roadmap.
 */
export type HistorianRunStatus = 
/** Compartments were validated + published. */
"success"
/** A real failure (validation / coverage / no-progress / exception). */
 | "failed"
/** A successful no-op (nothing eligible to compact, empty chunk). */
 | "noop";
export type HistorianRunKind = "incremental" | "recomp" | "partial-recomp" | "upgrade";
export interface HistorianRunInput {
    sessionId: string;
    harness: string;
    /** FK to subagent_invocations.id (tokens/model/timing). NULL if no invocation. */
    subagentInvocationId?: number | null;
    runKind: HistorianRunKind;
    status: HistorianRunStatus;
    /** Failure reason for `failed` (and optionally a no-op explanation). */
    failureReason?: string | null;
    /** Raw-ordinal range of the input chunk. */
    chunkStartOrdinal?: number | null;
    chunkEndOrdinal?: number | null;
    /** Historian's reported next-start (its `<unprocessed_from>`). */
    unprocessedFrom?: number | null;
    /** Compartments actually persisted (post discard-last). */
    compartmentsProduced?: number;
    /** Durable id range of the persisted compartments. */
    compartmentIdMin?: number | null;
    compartmentIdMax?: number | null;
    /** Facts emitted in the `<facts>` block. */
    factsEmitted?: number;
    /** `{ [category]: count }` of emitted facts. */
    factsByCategory?: Record<string, number> | null;
    /** Events emitted (causal_incident / trajectory_correction). */
    eventsEmitted?: number;
    /** Importance distribution across persisted compartments. */
    importanceMin?: number | null;
    importanceMax?: number | null;
    importanceAvg?: number | null;
    /** Whether the lookahead-free last compartment was discarded (boundary healing). */
    discardedLast?: boolean;
    /** Whether the run produced/processed legacy (pre-v2) compartments. */
    legacy?: boolean;
}
/**
 * Record one historian run. Best-effort: never throws into the historian path —
 * telemetry must not break compaction. Returns the new row id, or null on
 * failure.
 */
export declare function recordHistorianRun(db: Database, input: HistorianRunInput): number | null;
/** Summarize a list of importance values into min/max/avg (null on empty). */
export declare function summarizeImportance(values: readonly number[]): {
    min: number | null;
    max: number | null;
    avg: number | null;
};
/** Tally facts by their category for `factsByCategory`. */
export declare function tallyFactsByCategory(facts: ReadonlyArray<{
    category?: string | null;
}>): Record<string, number>;
//# sourceMappingURL=storage-historian-runs.d.ts.map