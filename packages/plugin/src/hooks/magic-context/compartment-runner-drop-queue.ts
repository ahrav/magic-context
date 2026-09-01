import { queuePendingOp } from "../../features/magic-context/storage-ops";
import { getTagsBySession } from "../../features/magic-context/storage-tags";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import { getRawSessionTagKeysThrough } from "./read-session-chunk";

/**
 *
 *
 *
 * correctly.
 */
export function queueDropsForCompartmentalizedMessages(
    db: Database,
    sessionId: string,
    upToMessageIndex: number,
): void {
    const tags = getTagsBySession(db, sessionId);
    const { messageFileKeys, toolObservations } = getRawSessionTagKeysThrough(
        sessionId,
        upToMessageIndex,
    );
    let dropsQueued = 0;

    for (const tag of tags) {
        if (tag.status !== "active") continue;

        if (tag.type === "tool") {
            const observedOwners = toolObservations.get(tag.messageId);
            if (!observedOwners) continue;

            if (tag.toolOwnerMessageId !== null) {
                // active.
                if (!observedOwners.has(tag.toolOwnerMessageId)) continue;
            }
            // `NULL` `toolOwnerMessageId` rows match by `messageId` only.

            queuePendingOp(db, sessionId, tag.tagNumber, "drop");
            dropsQueued += 1;
            continue;
        }

        if (messageFileKeys.has(tag.messageId)) {
            queuePendingOp(db, sessionId, tag.tagNumber, "drop");
            dropsQueued += 1;
        }
    }

    sessionLog(
        sessionId,
        `compartment agent: queued ${dropsQueued} drops for messages 0-${upToMessageIndex}`,
    );
}
