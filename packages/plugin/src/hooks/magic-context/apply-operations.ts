import type { ContextDatabase } from "../../features/magic-context/storage";
import {
    getPendingOps,
    getTagsBySession,
    removePendingOp,
    updateTagDropMode,
    updateTagStatus,
} from "../../features/magic-context/storage";
import type { PendingOp, TagEntry } from "../../features/magic-context/types";
import type { TagTarget } from "./tag-messages";

/**
 * marker.)
 *
 * Recent skeletons preserve tool-call context.
 *
 */
export const RECENT_TOOL_SKELETON_WINDOW = 20;

export function buildReplacementContent(tagId: number): string {
    return `[dropped \u00a7${tagId}\u00a7]`;
}
export function applyPendingOperations(
    sessionId: string,
    db: ContextDatabase,
    targets: Map<number, TagTarget>,
    protectedTags: number = 0,
    preloadedTags?: TagEntry[],
    preloadedPendingOps?: ReturnType<typeof getPendingOps>,
    syntheticPendingOps: PendingOp[] = [],
    /**
     */
    editMarkerTagIds: ReadonlySet<number> = new Set(),
): boolean {
    let didMutateMessage = false;
    db.transaction(() => {
        const tags = preloadedTags ?? getTagsBySession(db, sessionId);
        const tagStatusById = new Map(tags.map((tag) => [tag.tagNumber, tag.status] as const));
        const tagTypeById = new Map(tags.map((tag) => [tag.tagNumber, tag.type] as const));
        const protectedTagIds =
            protectedTags > 0
                ? new Set(
                      tags
                          .filter((tag) => tag.status === "active")
                          .map((tag) => tag.tagNumber)
                          .sort((left, right) => right - left)
                          .slice(0, protectedTags),
                  )
                : new Set<number>();

        const pendingOps = preloadedPendingOps ?? getPendingOps(db, sessionId);
        const opsToApply: Array<{ op: PendingOp; synthetic: boolean }> = [
            ...pendingOps.map((op) => ({ op, synthetic: false })),
            ...syntheticPendingOps.map((op) => ({ op, synthetic: true })),
        ];

        // The skeleton window reflects conversation recency, not droppability.
        const skeletonWindow = new Set(
            tags
                .filter((tag) => tag.type === "tool")
                .map((tag) => tag.tagNumber)
                .sort((left, right) => right - left)
                .slice(0, RECENT_TOOL_SKELETON_WINDOW),
        );

        for (const { op: pendingOp, synthetic } of opsToApply) {
            const tagStatus = tagStatusById.get(pendingOp.tagId);
            if (tagStatus === "compacted" || tagStatus === "dropped") {
                if (!synthetic) removePendingOp(db, sessionId, pendingOp.tagId);
                continue;
            }

            if (protectedTagIds.has(pendingOp.tagId)) {
                continue;
            }

            const target = targets.get(pendingOp.tagId);
            const isToolTag = tagTypeById.get(pendingOp.tagId) === "tool";

            if (synthetic) {
                if (!isToolTag || target?.canDrop?.() !== true) continue;
            }

            let shouldPersistDrop = false;
            if (isToolTag) {
                if (editMarkerTagIds.has(pendingOp.tagId)) {
                    const markResult = target?.editMarker?.() ?? "absent";
                    if (markResult === "incomplete" || markResult === "absent") {
                        continue;
                    }
                    didMutateMessage = true;
                    updateTagDropMode(db, sessionId, pendingOp.tagId, "edit_marker");
                    shouldPersistDrop = true;
                } else if (skeletonWindow.has(pendingOp.tagId)) {
                    const truncResult = target?.truncate?.() ?? "absent";
                    if (
                        truncResult === "incomplete" ||
                        (synthetic && truncResult !== "truncated")
                    ) {
                        continue;
                    }
                    if (truncResult === "truncated") {
                        didMutateMessage = true;
                    }
                    updateTagDropMode(db, sessionId, pendingOp.tagId, "truncated");
                    shouldPersistDrop = true;
                } else {
                    const dropResult = target?.drop?.() ?? "absent";
                    if (dropResult === "incomplete" || (synthetic && dropResult !== "removed")) {
                        continue;
                    }
                    if (dropResult === "removed") {
                        didMutateMessage = true;
                    }
                    updateTagDropMode(db, sessionId, pendingOp.tagId, "full");
                    shouldPersistDrop = true;
                }
            } else if (target) {
                const changed = target.setContent(buildReplacementContent(pendingOp.tagId));
                if (changed) didMutateMessage = true;
                shouldPersistDrop = true;
            } else if (!synthetic) {
                shouldPersistDrop = true;
            }

            if (!shouldPersistDrop) continue;
            updateTagStatus(db, sessionId, pendingOp.tagId, "dropped");
            if (!synthetic) removePendingOp(db, sessionId, pendingOp.tagId);
        }
    })();
    return didMutateMessage;
}

export function applyFlushedStatuses(
    sessionId: string,
    db: ContextDatabase,
    targets: Map<number, TagTarget>,
    preloadedTags?: TagEntry[],
): boolean {
    let didMutateMessage = false;
    const tags = preloadedTags ?? getTagsBySession(db, sessionId);

    for (const tag of tags) {
        if (tag.status === "dropped") {
            const target = targets.get(tag.tagNumber);
            if (tag.type === "tool") {
                if (tag.dropMode === "edit_marker") {
                    const markResult = target?.editMarker?.() ?? "absent";
                    if (markResult === "truncated") {
                        didMutateMessage = true;
                    }
                } else if (tag.dropMode === "truncated") {
                    const truncResult = target?.truncate?.() ?? "absent";
                    if (truncResult === "truncated") {
                        didMutateMessage = true;
                    }
                } else {
                    const dropResult = target?.drop?.() ?? "absent";
                    if (dropResult === "removed") {
                        didMutateMessage = true;
                    }
                }
            } else if (target) {
                const changed = target.setContent(buildReplacementContent(tag.tagNumber));
                if (changed) didMutateMessage = true;
            }
        }
    }
    return didMutateMessage;
}
