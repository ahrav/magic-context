import { type ContextDatabase } from "../../features/magic-context/storage";
import type { PendingOp } from "../../features/magic-context/types";
import type { TagTarget } from "./tag-messages";
/**
 * Build synthetic drop ops for superseded spent-control-plane tool outputs.
 * Mirrors `buildSyntheticToolReclaimOps`'s op shape. The caller merges these
 * into the same gated `applyPendingOperations` call as the positional sweep.
 */
export declare function buildSupersessionReclaimOps(input: {
    db: ContextDatabase;
    sessionId: string;
    targets: Map<number, TagTarget>;
    pendingOps?: readonly PendingOp[];
}): PendingOp[];
/**
 * Select superseded edit/write tool calls for COMPRESSION (not full drop).
 * Among active edit/write tags grouped by their `filePath`, the newest stays
 * full; every older edit to the same file is an edit_marker target. Like the
 * control-plane selector, supersession is age-independent so the watermark is
 * ignored, but the caller only acts inside the gated pass.
 *
 * Returns both the drop ops AND the set of tag ids that must be compressed as
 * edit_marker (the caller passes the set to applyPendingOperations).
 */
export declare function buildEditSupersessionReclaim(input: {
    db: ContextDatabase;
    sessionId: string;
    targets: Map<number, TagTarget>;
    pendingOps?: readonly PendingOp[];
}): {
    ops: PendingOp[];
    editMarkerTagIds: Set<number>;
};
//# sourceMappingURL=supersession-reclaim.d.ts.map