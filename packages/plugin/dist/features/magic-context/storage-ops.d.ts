import type { Database } from "../../shared/sqlite";
import type { PendingOp } from "./types";
export declare function queuePendingOp(db: Database, sessionId: string, tagId: number, operation: PendingOp["operation"], queuedAt?: number): void;
export declare function getPendingOps(db: Database, sessionId: string): PendingOp[];
export declare function clearPendingOps(db: Database, sessionId: string): void;
export declare function removePendingOp(db: Database, sessionId: string, tagId: number): void;
//# sourceMappingURL=storage-ops.d.ts.map