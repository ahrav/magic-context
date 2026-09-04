import { type ContextDatabase } from "../../features/magic-context/storage";
import type { PendingOp } from "../../features/magic-context/types";
import type { TagTarget } from "./tag-messages";
export declare function buildSyntheticToolReclaimOps(input: {
    db: ContextDatabase;
    sessionId: string;
    targets: Map<number, TagTarget>;
    watermark: number;
    pendingOps?: readonly PendingOp[];
}): PendingOp[];
export declare function advanceToolReclaimWatermarkToCurrentMax(db: ContextDatabase, sessionId: string): number;
//# sourceMappingURL=tool-reclaim.d.ts.map