import type { Database } from "../../shared/sqlite";
import type { SessionMeta } from "./types";
export declare function getOrCreateSessionMeta(db: Database, sessionId: string): SessionMeta;
export declare function updateSessionMeta(db: Database, sessionId: string, updates: Partial<SessionMeta>): void;
export declare function advanceToolReclaimWatermark(db: Database, sessionId: string, maxTagNumber: number): void;
export interface PendingSessionCleanupRetryResult {
    attempted: number;
    cleared: number;
    failedSessionIds: string[];
}
export declare function markSessionCleanupPending(db: Database, sessionId: string): void;
export declare function retryPendingSessionCleanups(db: Database, limit?: number): PendingSessionCleanupRetryResult;
export declare function clearSession(db: Database, sessionId: string): void;
//# sourceMappingURL=storage-meta-session.d.ts.map