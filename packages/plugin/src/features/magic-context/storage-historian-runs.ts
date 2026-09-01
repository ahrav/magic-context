import type { Database } from "../../shared/sqlite";

/**
 *
 * `subagent_invocations` stores the model and token usage.
 *
 * training-data roadmap.
 */

export type HistorianRunStatus =
    /** `success` means the historian validated and published the compartments. */
    | "success"
    /** `failed` covers validation, coverage, no-progress, and exception failures. */
    | "failed"
    /** `noop` means the historian found no eligible compartments or received an empty chunk. */
    | "noop";

export type HistorianRunKind = "incremental" | "recomp" | "partial-recomp" | "upgrade";

export interface HistorianRunInput {
    sessionId: string;
    harness: string;
    /** `subagentInvocationId` is null when no invocation exists and otherwise references `subagent_invocations.id`. */
    subagentInvocationId?: number | null;
    runKind: HistorianRunKind;
    status: HistorianRunStatus;
    /** `failureReason` records reasons for `failed` runs and may explain `noop` runs. */
    failureReason?: string | null;
    /** `chunkStartOrdinal` and `chunkEndOrdinal` bound the input chunk's raw-ordinal range. */
    chunkStartOrdinal?: number | null;
    chunkEndOrdinal?: number | null;
    /** `unprocessedFrom` records the historian's `<unprocessed_from>` next-start. */
    unprocessedFrom?: number | null;
    /** `compartmentsProduced` counts compartments persisted after discarding the last compartment. */
    compartmentsProduced?: number;
    /** `compartmentIdMin` and `compartmentIdMax` bound the persisted compartments' durable ID range. */
    compartmentIdMin?: number | null;
    compartmentIdMax?: number | null;
    /** `factsEmitted` counts facts emitted in the `<facts>` block. */
    factsEmitted?: number;
    /* */
    factsByCategory?: Record<string, number> | null;
    /** `eventsEmitted` counts emitted `causal_incident` and `trajectory_correction` events. */
    eventsEmitted?: number;
    /** `importanceMin`, `importanceMax`, and `importanceAvg` summarize persisted-compartment importance. */
    importanceMin?: number | null;
    importanceMax?: number | null;
    importanceAvg?: number | null;
    /** `discardedLast` is true when boundary healing discards the lookahead-free last compartment. */
    discardedLast?: boolean;
    /** `legacy` is true when the run produces or processes pre-v2 compartments. */
    legacy?: boolean;
}

/**
 * Telemetry failures never interrupt compaction.
 * failure.
 */
export function recordHistorianRun(db: Database, input: HistorianRunInput): number | null {
    try {
        const result = db
            .prepare(
                `INSERT INTO historian_runs (
                    session_id, harness, subagent_invocation_id, run_kind, status,
                    failure_reason, chunk_start_ordinal, chunk_end_ordinal, unprocessed_from,
                    compartments_produced, compartment_id_min, compartment_id_max,
                    facts_emitted, facts_by_category_json, events_emitted,
                    importance_min, importance_max, importance_avg,
                    discarded_last, legacy, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                input.sessionId,
                input.harness,
                input.subagentInvocationId ?? null,
                input.runKind,
                input.status,
                input.failureReason ?? null,
                input.chunkStartOrdinal ?? null,
                input.chunkEndOrdinal ?? null,
                input.unprocessedFrom ?? null,
                input.compartmentsProduced ?? 0,
                input.compartmentIdMin ?? null,
                input.compartmentIdMax ?? null,
                input.factsEmitted ?? 0,
                input.factsByCategory ? JSON.stringify(input.factsByCategory) : null,
                input.eventsEmitted ?? 0,
                input.importanceMin ?? null,
                input.importanceMax ?? null,
                input.importanceAvg ?? null,
                input.discardedLast ? 1 : 0,
                input.legacy ? 1 : 0,
                Date.now(),
            );
        return Number(result.lastInsertRowid);
    } catch {
        return null;
    }
}

/* */
export function summarizeImportance(values: readonly number[]): {
    min: number | null;
    max: number | null;
    avg: number | null;
} {
    const nums = values.filter((v) => typeof v === "number" && Number.isFinite(v));
    if (nums.length === 0) return { min: null, max: null, avg: null };
    let min = nums[0];
    let max = nums[0];
    let sum = 0;
    for (const v of nums) {
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v;
    }
    return { min, max, avg: sum / nums.length };
}

/* */
export function tallyFactsByCategory(
    facts: ReadonlyArray<{ category?: string | null }>,
): Record<string, number> {
    const out: Record<string, number> = {};
    for (const f of facts) {
        const cat = (f.category ?? "UNKNOWN").trim() || "UNKNOWN";
        out[cat] = (out[cat] ?? 0) + 1;
    }
    return out;
}
