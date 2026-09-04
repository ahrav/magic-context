import type { Database } from "../../shared/sqlite";
export type SubagentKind = "historian" | "historian_editor" | "compressor" | "dreamer" | "sidekick" | "user_memory_review" | "recomp";
export type SubagentInvocationStatus = "completed" | "failed" | "aborted";
export interface SubagentInvocationInput {
    sessionId: string;
    harness: "opencode" | "pi";
    subagent: SubagentKind;
    task?: string | null;
    providerId?: string | null;
    modelId?: string | null;
    startedAt: number;
    endedAt: number;
    status: SubagentInvocationStatus;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    error?: string | null;
    parentInvocationId?: number | null;
}
export interface SubagentInvocationRow {
    id: number;
    sessionId: string;
    harness: "opencode" | "pi";
    subagent: SubagentKind;
    task: string | null;
    providerId: string | null;
    modelId: string | null;
    startedAt: number;
    endedAt: number | null;
    status: SubagentInvocationStatus;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    error: string | null;
    parentInvocationId: number | null;
}
export interface SubagentTotals {
    invocations: number;
    totalInput: number;
    totalOutput: number;
    totalCacheRead: number;
    totalCacheWrite: number;
}
export declare function recordSubagentInvocation(db: Database, input: SubagentInvocationInput): number;
/**
 * Newest `historian` invocation id for a session (or null if none yet).
 *
 * Used to FK-link a `historian_runs` row to the invocation that produced it:
 * historian runs are serialized per session (compartmentInProgress lock), so the
 * latest historian invocation recorded between a pre-run baseline and the run's
 * end is the one for this run.
 */
export declare function getLatestHistorianInvocationId(db: Database, sessionId: string): number | null;
export declare function getSubagentInvocations(db: Database, sessionId: string, opts?: {
    subagent?: SubagentKind;
    limit?: number;
}): SubagentInvocationRow[];
export declare function getSubagentTotalsBySubagent(db: Database, sessionId: string): Partial<Record<SubagentKind, SubagentTotals>>;
//# sourceMappingURL=storage-subagent-invocations.d.ts.map