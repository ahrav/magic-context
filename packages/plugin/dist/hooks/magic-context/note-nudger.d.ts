/**
 * Note nudge state machine.
 *
 * State: idle → (trigger fires + notes exist) → nudged → (any trigger fires again) → nudged → ...
 * Suppression: after a nudge fires, suppress until the NEXT trigger event (any of 3).
 *
 * Triggers:
 *   1. Post-historian completion — compartments just compressed history
 *   2. Post-commit detection — agent committed work, natural boundary
 *   3. Todos complete — agent finished planned work, receptive to deferred items
 *
 * The nudge itself is a short reminder folded into the existing nudge anchor.
 * It does NOT include note content — just a count and "use ctx_note read" hint.
 */
import { type NoteNudgeDeliveryOutcome } from "../../features/magic-context/storage-meta-persisted";
import type { Database } from "../../shared/sqlite";
export type NoteNudgeTrigger = "historian_complete" | "commit_detected" | "todos_complete";
export declare function recordNoteNudgeDeliveryTime(sessionId: string): void;
/**
 * Signal that a trigger event occurred. Call from hook layer when any of the 3 triggers fire.
 */
export declare function onNoteTrigger(db: Database, sessionId: string, trigger: NoteNudgeTrigger): void;
/**
 * Peek at whether a note nudge should be injected during this transform pass.
 * Returns the nudge text if yes, null if no.
 * Does NOT clear triggerPending — call markNoteNudgeDelivered() after successful placement.
 *
 * @param currentUserMessageId - The latest user message ID in this transform pass.
 *   If it matches the trigger-time message, delivery is deferred to avoid busting
 *   the Anthropic prompt-cache prefix (the trigger fired during the agent's turn,
 *   so injecting into the current user message would mutate cached content).
 * @param projectIdentity - Project identity for resolving ready smart notes.
 * @param noteReadStillVisible - True if the agent currently has a non-stripped
 *   `ctx_note(action="read")` tool call in their visible message context. When
 *   the agent has read the latest note state AND that read is still visible,
 *   the nudge is suppressed (no value re-surfacing what's already on screen).
 *   When the read has been dropped (compactified, ctx_reduce'd, age-cleaned),
 *   the nudge fires again at the next work boundary so the agent regains
 *   visibility into deferred intentions. Caller computes this via
 *   `hasVisibleNoteReadCall(messages)` AFTER drops are materialized.
 */
export declare function peekNoteNudgeText(db: Database, sessionId: string, currentUserMessageId?: string | null, projectIdentity?: string, noteReadStillVisible?: boolean): string | null;
/**
 * Mark the note nudge as delivered after successful placement.
 * Only call after appendReminderToLatestUserMessage returns an anchor (or null if no user message exists).
 */
export declare function markNoteNudgeDelivered(db: Database, sessionId: string, text: string, messageId: string | null): NoteNudgeDeliveryOutcome;
/**
 * Get sticky note nudge for replay on subsequent transform passes.
 * Returns { text, messageId } if a delivered nudge needs re-injection, null otherwise.
 */
export declare function getStickyNoteNudge(db: Database, sessionId: string): {
    text: string;
    messageId: string;
} | null;
/**
 * Legacy wrapper — peek + mark in one call.
 * Kept for tests; prefer peekNoteNudgeText + markNoteNudgeDelivered in production.
 */
export declare function getNoteNudgeText(db: Database, sessionId: string): string | null;
/**
 * Call when session is deleted or notes are read to clear persisted state.
 */
export declare function clearNoteNudgeState(db: Database, sessionId: string, options?: {
    persist?: boolean;
}): void;
export declare function clearAllNoteNudgeState(db: Database, sessionId: string): void;
export declare function clearNoteNudgeTriggerAndCooldown(db: Database, sessionId: string): void;
export declare function resetNoteNudgeCooldownOnly(sessionId: string): void;
export declare function clearNoteNudgeTriggerOnly(db: Database, sessionId: string): void;
//# sourceMappingURL=note-nudger.d.ts.map