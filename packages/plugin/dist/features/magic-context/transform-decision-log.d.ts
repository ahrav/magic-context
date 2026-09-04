import { Database } from "../../shared/sqlite";
export type TransformDecisionHarness = "opencode" | "pi";
export type TransformSchedulerDecision = "execute" | "defer" | "error" | "need_full_sync" | "parked" | "passthrough" | "unknown";
/**
 * Max transform_decisions rows kept per (session_id, harness). Pruned newest-first
 * after every insert so a long session's cache-affecting passes never grow this
 * telemetry table without bound (the dashboard loads all matching rows for cause
 * attribution).
 */
export declare const TRANSFORM_DECISIONS_RETENTION = 2000;
export type CanonicalMaterializeReason = "system_hash" | "model_change" | "project_memory_epoch" | "ttl_idle" | "explicit_flush" | "max_mutation_id" | "first_render" | "pressure_refold" | "upgrade_state" | "cached_m1_missing" | "project_change" | "compartment_render_epoch" | "m1_delta" | "ttl_expiry" | "epoch_change" | "coverage_fold" | "profile_transition";
export interface PendingTransformDecision {
    tsMs: number;
    decision: TransformSchedulerDecision;
    materialized: boolean;
    materializeReason: CanonicalMaterializeReason | null;
    emergency: boolean;
    droppedTokens: number;
    droppedCount: number;
    inputTokens: number;
    bustedThisPass: boolean;
}
interface TransformDecisionRow extends PendingTransformDecision {
    sessionId: string;
    harness: TransformDecisionHarness;
    messageId: string;
}
interface PendingPiTransformDecision extends PendingTransformDecision {
    snapshotNewestAssistantEntryId: string | null;
}
type TransformDecisionWriter = (dbPath: string, row: TransformDecisionRow) => void;
export declare function normalizeMaterializeReason(harness: TransformDecisionHarness, reason: string | null | undefined, rematerialized: boolean): CanonicalMaterializeReason | null;
/**
 * Stage one Rust pass for the assistant message that will receive its provider usage row.
 * The transform runs before that assistant exists, so binding to the newest input message
 * attributes a multi-step pass to the previous step. The ordinary OpenCode event path binds
 * this pending record to the next completed assistant id.
 */
export declare function writeRustTransformDecision(args: {
    sessionId: string;
    decision: string;
    materializeReason: string | null;
    inputTokens: number;
    tsMs?: number;
}): void;
export declare function clearOpenCodePendingTransformDecision(sessionId: string): void;
export declare function clearTransformDecisionSession(sessionId: string): void;
export declare function recordPendingTransformDecision(sessionId: string, decision: PendingTransformDecision): void;
export declare function recordPendingPiTransformDecision(sessionId: string, decision: PendingTransformDecision, snapshotNewestAssistantEntryId: string | null): void;
export declare function scheduleOpenCodeTransformDecisionWrite(args: {
    db: Database;
    sessionId: string;
    messageId: string;
    inputTokens: number;
}): boolean;
export declare function findNewestPiAssistantEntryId(entries: readonly unknown[] | null | undefined): string | null;
export declare function schedulePiTransformDecisionResolve(args: {
    db: Database;
    sessionId: string;
    branchEntries: readonly unknown[] | null;
}): boolean;
declare function findNewestPiAssistantEntryIdAfter(entries: readonly unknown[] | null, snapshotNewestAssistantEntryId: string | null): string | null;
export declare const __test: {
    getPending(sessionId: string): PendingTransformDecision | undefined;
    getPendingPi(sessionId: string): PendingPiTransformDecision | undefined;
    reset(): void;
    setWriterForTests(writer: TransformDecisionWriter | null): void;
    setRetentionForTests(cap: number | null): void;
    writeRow(dbPath: string, row: TransformDecisionRow): void;
    findNewestPiAssistantEntryIdAfter: typeof findNewestPiAssistantEntryIdAfter;
};
export {};
//# sourceMappingURL=transform-decision-log.d.ts.map