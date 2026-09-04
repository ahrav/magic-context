/**
 * Compaction Marker Injection
 *
 * Injects compaction boundaries into OpenCode's SQLite DB so that
 * `filterCompacted` stops at the historian boundary. After injection,
 * the transform hook receives only post-boundary messages instead
 * of the full session history.
 *
 * Always-on as of v0.21.4. Previously gated behind `compaction_markers`
 * config (default true since v0.9.0); the knob was removed because the
 * feature is required for sane transform performance.
 *
 * ## What gets injected (3 rows):
 * 1. A `compaction` part on the boundary user message
 * 2. A summary assistant message with `parentID` → boundary user message
 * 3. A text part on that summary message containing a static placeholder
 *
 * The real `<session-history>` is injected by the transform pipeline via
 * inject-compartments.ts. The marker exists solely to make filterCompacted
 * stop at the boundary.
 *
 * ## How OpenCode's filterCompacted works:
 * - Iterates newest→oldest
 * - Stops when it finds a user message that:
 *   (a) has a part with type: "compaction"
 *   (b) has a completed summary assistant response (summary: true, finish: "stop")
 *       whose parentID matches that user message's id
 */
export declare function generateMessageId(timestampMs: number, counter?: bigint, identity?: string): string;
export declare function generatePartId(timestampMs: number, counter?: bigint, identity?: string): string;
export declare function getOpenCodeDbPath(): string;
export declare function closeCompactionMarkerDb(): void;
export interface BoundaryUserMessage {
    id: string;
    timeCreated: number;
}
/**
 * Find the nearest user message at or before the given end message id.
 * The boundary must be a user message for filterCompacted to work.
 *
 * Filters out compaction summary messages (summary=true, finish="stop")
 * so ordinals stay consistent with readRawSessionMessagesFromDb.
 */
export declare function findBoundaryUserMessage(sessionId: string, endMessageId: string): BoundaryUserMessage | null;
export declare function compareOpenCodeMessagesByCanonicalOrder(sessionId: string, leftMessageId: string, rightMessageId: string): number | null;
/**
 * Check whether an OpenCode message ID still exists for a given session.
 *
 * Used by plan v6's deferred marker drain to validate that a deferred
 * compaction-marker target hasn't been wiped by recomp / revert / partial
 * recomp between publication and the consuming pass. Errors propagate
 * (unlike the swallow-and-return-empty helpers in `read-session-db.ts`):
 * the marker-manager wraps this call in its own try/catch so missing or
 * locked OpenCode DBs become `retryable-failure` outcomes, not silent skips.
 *
 * Note: returns `{ id }` rather than a richer row shape because the only
 * thing the caller needs is existence. If a future caller needs role or
 * timestamps, widen the return type but keep the throw-on-failure contract.
 */
export declare function getOpenCodeMessageById(sessionId: string, messageId: string): {
    id: string;
} | null;
interface CompactionMarkerState {
    /** The user message ID that has the compaction part */
    boundaryMessageId: string;
    /** The summary assistant message ID we injected */
    summaryMessageId: string;
    /** The compaction part ID on the user message */
    compactionPartId: string;
    /** The text part ID on the summary message */
    summaryPartId: string;
}
export interface InjectCompactionMarkerArgs {
    sessionId: string;
    /** Raw ordinal of the last compartmentalized message */
    endOrdinal: number;
    /** OpenCode message id of the last compartmentalized message */
    endMessageId: string;
    /** Summary text for the compaction summary message (static placeholder) */
    summaryText: string;
    /** Working directory for the session */
    directory: string;
    /** Boundary resolved before removing the old marker (prevents null-boundary cache busts). */
    resolvedBoundary?: BoundaryUserMessage;
}
/**
 * Inject a compaction marker into OpenCode's DB.
 * Returns the marker state if successful, null if boundary couldn't be found.
 */
export declare function injectCompactionMarker(args: InjectCompactionMarkerArgs): CompactionMarkerState | null;
/**
 * One compaction marker row-set found in opencode.db for a session.
 *
 * `summaryMessageIds` lists the completed summary assistant messages
 * (summary=true, finish="stop") parented to the boundary user message and
 * carrying magic-context's provider identity — i.e. the summaries THIS plugin
 * injected. OpenCode-native /compact summaries carry the real provider id and
 * are deliberately NOT listed, so callers can never delete a native compaction.
 */
export interface SessionCompactionMarkerRows {
    /** id of the `type:"compaction"` part on the boundary user message */
    compactionPartId: string;
    /** the user message id the compaction part is attached to */
    boundaryMessageId: string;
    /** magic-context-injected summary messages parented to the boundary */
    summaryMessageIds: string[];
}
/**
 * List every compaction marker present in opencode.db for a session.
 *
 * Used by the fork-orphan hygiene pass (#263): OpenCode's `/fork` copies the
 * parent session's message rows — including this plugin's compaction marker
 * rows — into the fork, while magic-context's durable marker state (context.db)
 * is NOT inherited (PARITY.md gap #25). The fork then owns marker rows its
 * state knows nothing about. This scan enumerates all markers so the caller can
 * diff them against the persisted state and repair the ones it does not own.
 *
 * Errors propagate to the caller (the hygiene pass treats any failure as
 * "skip this pass and retry later" — never as a fatal transform error).
 */
export declare function listSessionCompactionMarkers(sessionId: string): SessionCompactionMarkerRows[];
/**
 * Remove one foreign (not owned by this session's durable state) compaction
 * marker from opencode.db: its compaction part, plus the magic-context summary
 * lineage parented to its boundary message.
 *
 * Deleting the compaction part alone is sufficient to make `filterCompacted`
 * stop ignoring our marker (it requires a compaction part to break), but the
 * summary rows are removed too so no stale "[Compacted by magic-context]"
 * message lingers in the fork's history.
 *
 * `protectedSummaryMessageId` is the caller's OWN summary message id; it is
 * never deleted even if it happened to share the boundary (defensive — a
 * foreign boundary newer than ours should always differ).
 *
 * Returns false (without throwing) when the DELETE transaction fails, e.g.
 * SQLITE_BUSY; the caller retries on a later pass.
 */
export declare function removeForeignCompactionMarker(sessionId: string, marker: SessionCompactionMarkerRows, protectedSummaryMessageId: string | null): boolean;
/**
 * Result of the compaction-off flip cleanup over one session's opencode.db
 * rows (issue #266). Counts are row-level so the transition can both gate
 * the flip notice ("cleared something") and prove idempotence (a second run
 * reports zero removed rows).
 */
export interface McOwnedMarkerCleanupResult {
    /**
     * True only when cleanup completed without skipping an MC-owned lineage.
     * False keeps the mode transition retryable instead of recording a
     * successful flip while a marker can still hide history.
     */
    verified: boolean;
    /** MC-owned marker lineages fully removed (compaction part + summary rows together). */
    removedLineages: number;
    /** Message + part rows deleted in total. */
    removedRows: number;
    /**
     * Lineages deliberately LEFT in place because a surviving compaction part
     * (or message-level compaction field) carries a `tail_start_id` that
     * references a row the deletion would remove. A missing tail target makes
     * OpenCode's tailIndex resolve to -1 and silently bypass its reorder, so
     * the contract is retarget-or-retain, never blind-delete; this cleanup
     * retains.
     */
    retainedLineages: number;
}
/**
 * Delete every Magic Context-owned compaction-marker lineage for a session
 * from opencode.db. This is the flip-off transition's primary mechanism
 * (issue #266 decision #7): with MC no longer injecting `<session-history>`,
 * a surviving MC marker would keep `filterCompacted` hiding pre-boundary
 * history with nothing to replace it — orphaned context. Deleting the MC
 * pairs lets OpenCode recompute filtering live from the surviving rows, as if
 * the MC markers never existed (peer-verified newest-completed-summary
 * semantics; older markers inside the retained tail do not define the
 * boundary). Native compaction rows are never matched: ownership keys on
 * MC-specific signatures (the `magic-context` provider identity on summary
 * messages, the exact MC marker summary text for legacy lineages, and the
 * MC canonical compaction-part shape) plus session identity.
 *
 * Deletion caveats honored (both binding from the OpenCode peer verification):
 *   1. The compaction part and its summary assistant rows are deleted TOGETHER
 *      in one transaction (summary parts cascade first). Deleting only the
 *      compaction part would strand the summary message in model history.
 *      The boundary USER message row itself is real user history and is never
 *      deleted — only the MC-injected compaction part attached to it.
 *   2. tail_start_id PREFLIGHT: before deleting, every SURVIVING compaction
 *      part (and message-level compaction field) is checked for a
 *      `tail_start_id` equal to any row about to be deleted. On a hit the
 *      lineage is RETAINED, never blind-deleted.
 *
 * Idempotent: absent rows delete as a no-op (second run reports zeros).
 * Errors propagate — the transition treats them as retryable and reruns the
 * same logical cleanup on the next pass (delete-then-record protocol).
 */
export declare function removeMcOwnedCompactionMarkers(sessionId: string, summaryText: string): McOwnedMarkerCleanupResult;
/**
 * Remove an existing compaction marker (all 3 rows).
 * Used when moving the boundary forward or on session cleanup.
 */
export declare function removeCompactionMarker(state: CompactionMarkerState): boolean;
export {};
//# sourceMappingURL=compaction-marker.d.ts.map