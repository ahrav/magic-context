import type { Database } from "../../shared/sqlite";
/**
 * Queue drop ops for every tag whose source content lies inside the
 * compartment range `[1, upToMessageIndex]`.
 *
 * v3.3.1 Layer C — Finding D: pre-fix this matched tool tags by bare
 * `messageId` (= callId), so a callId reused outside the compartment
 * would match a tag inside the compartment by string equality alone.
 * Both occurrences would get queued for drop, including the live
 * out-of-range tag — silent corruption.
 *
 * Post-fix: tool tags are matched by composite identity
 * `(callId, tool_owner_message_id)`. The visible-window scan in
 * `getRawSessionTagKeysThrough` produces both the callId and the FIFO-
 * paired ownerMsgId; we drop only when both match the persisted tag.
 *
 * Legacy NULL-owner rows (pre-Layer-B-backfill data the user hasn't
 * regenerated yet) fall back to the bare-callId match. The trade-off
 * is documented in plan §Risk #20: in unbackfilled sessions a
 * collision could still wrong-drop the lowest-numbered orphan, but
 * the bug is bounded to that one tag and lazy adoption converts the
 * row to non-NULL on next observation, so the next pass behaves
 * correctly.
 */
export declare function queueDropsForCompartmentalizedMessages(db: Database, sessionId: string, upToMessageIndex: number): void;
//# sourceMappingURL=compartment-runner-drop-queue.d.ts.map