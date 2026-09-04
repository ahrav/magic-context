import type { Database } from "../../shared/sqlite";
export interface SessionProjectBackfillSession {
    sessionId: string;
    directory: string;
}
export type SessionProjectBackfillSource = readonly SessionProjectBackfillSession[] | ((afterSessionId: string | null, limit: number) => readonly SessionProjectBackfillSession[] | Promise<readonly SessionProjectBackfillSession[]>);
export interface BackfillResult {
    status: "completed" | "already_completed" | "blocked_by_lease" | "lost_lease" | "retry_pending";
    totalSessions: number;
    alreadyMappedSessions: number;
    unmappedSessions: number;
    backfilledSessions: number;
    skippedDeadDirectories: number;
    skippedEmptyDirectories: number;
    durationMs: number;
}
export interface SessionProjectBackfillStateRow {
    harness: string;
    status: "running" | "completed";
    holder_id: string | null;
    started_at: number | null;
    lease_expires_at: number | null;
    completed_at: number | null;
}
interface RunSessionProjectBackfillOptions {
    resolveIdentity?: (directory: string) => string | Promise<string>;
    now?: () => number;
    yieldFn?: () => Promise<void>;
    holderId?: string;
}
export declare function runSessionProjectBackfill(db: Database, source: SessionProjectBackfillSource, options?: RunSessionProjectBackfillOptions): Promise<BackfillResult>;
export declare function _getSessionProjectBackfillState(db: Database, harness?: import("../../shared/harness").HarnessId): SessionProjectBackfillStateRow | null;
export {};
//# sourceMappingURL=session-project-backfill.d.ts.map