import type { Database } from "../../shared/sqlite";
export interface WorkMetrics {
    newWorkTokens: number;
    totalInputTokens: number;
}
export interface PiSessionEntry {
    role?: unknown;
    usage?: unknown;
    message?: unknown;
}
export declare function computeOpenCodeWorkMetrics(openCodeDb: Database, sessionId: string): WorkMetrics;
/** A single assistant row's usage, as folded by `foldWorkMetricsRows`. */
export interface AssistantUsageRow {
    /** json_extract(data,'$.agent'); null when absent (its own partition). */
    agent: string | null;
    timeCreated: number;
    id: string;
    /** input + cache.read + cache.write. */
    prompt: number;
    output: number;
}
interface AgentCarry {
    prevPrompt: number;
    phaseId: number;
    /** Max qualifying prompt in the current (open) phase. */
    phasePeak: number;
    /** Whether the current phase has at least one qualifying row. */
    phaseHasQualifying: boolean;
    /** Summed peaks of already-closed qualifying phases. */
    closedPhaseSum: number;
    lastOutput: number;
    seen: boolean;
}
/** Resumable accumulator: fold new rows into this to extend the metric. */
export interface WorkMetricsCarry {
    perAgent: Map<string, AgentCarry>;
    /** Σ max(0, prompt - prevPrompt) across every folded row (metric A body). */
    newWorkSum: number;
    /** Watermark: last folded row's ordering key. */
    lastTimeCreated: number;
    lastId: string;
}
export declare function emptyWorkMetricsCarry(): WorkMetricsCarry;
/**
 * Fold rows (which MUST be in (timeCreated, id) ascending order and strictly
 * newer than `carry`'s watermark) into the carry, mutating and returning it.
 *
 * Mirrors OPEN_CODE_WORK_METRICS_SQL:
 *  - delta per row = max(0, prompt - LAG(prompt) per agent), default LAG 0.
 *  - phase_id = cumulative count of (prompt < prevPrompt) per agent; a dropping
 *    row starts (and belongs to) the new phase.
 *  - phase peak counts only QUALIFYING rows (prevPrompt > 0 OR phase_id == 0).
 *  - metric A = Σ deltas + Σ (last output per agent); metric B = Σ phase peaks.
 */
export declare function foldWorkMetricsRows(rows: AssistantUsageRow[], carry: WorkMetricsCarry): WorkMetricsCarry;
/** Current metric value implied by the carry (cheap; no DB access). */
export declare function metricsFromCarry(carry: WorkMetricsCarry): WorkMetrics;
/** Read assistant usage rows strictly newer than the carry watermark. */
export declare function readAssistantUsageRowsAfter(openCodeDb: Database, sessionId: string, afterTimeCreated: number, afterId: string): AssistantUsageRow[];
/**
 * Extend `carry` with assistant rows newer than its watermark and return the
 * up-to-date metrics. On a fresh carry this folds the whole session once (cold
 * start); subsequent calls fold only new rows (≈0 when idle).
 *
 * The single most-recent assistant row is NEVER committed into the durable
 * carry — OpenCode writes the row at stream start and finalizes `data.tokens`
 * at completion, so a poll mid-stream would otherwise freeze that row at a
 * partial/zero value. Instead the watermark is advanced only through the
 * second-to-last row; the last row is re-read every poll and folded into a
 * throwaway clone for the returned value, so the result always matches a full
 * re-scan even while the latest turn is still streaming.
 */
export declare function computeOpenCodeWorkMetricsIncremental(openCodeDb: Database, sessionId: string, carry: WorkMetricsCarry): {
    carry: WorkMetricsCarry;
    metrics: WorkMetrics;
};
export declare function computePiWorkMetrics(sessionEntries: PiSessionEntry[] | unknown[]): WorkMetrics;
export {};
//# sourceMappingURL=work-metrics.d.ts.map