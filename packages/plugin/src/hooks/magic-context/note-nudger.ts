/**
 *
 * A successful nudge clears the pending trigger.
 * The system suppresses nudges after delivery until one of the three trigger events occurs.
 *
 * Triggers:
 *
 * The nudge itself is a short reminder folded into the existing nudge anchor.
 * It does NOT include note content — just a count and "use ctx_note read" hint.
 */

import {
    deliverNoteNudgeAtomic,
    getNoteLastReadAt,
    getPersistedNoteNudge,
    type NoteNudgeDeliveryOutcome,
    setPersistedNoteNudgeTrigger,
    setPersistedNoteNudgeTriggerMessageId,
} from "../../features/magic-context/storage-meta-persisted";
import {
    getReadySmartNotes,
    getSessionNotes,
    type Note,
} from "../../features/magic-context/storage-notes";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";

export type NoteNudgeTrigger = "historian_complete" | "commit_detected" | "todos_complete";

const NOTE_NUDGE_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes

// In-memory delivery timestamp per session. Doesn't need to survive restart —
// A restart resets the cooldown.
const lastDeliveredAt = new Map<string, number>();

function getPersistedNoteNudgeDeliveredAt(_db: unknown, sessionId: string): number {
    return lastDeliveredAt.get(sessionId) ?? 0;
}

export function recordNoteNudgeDeliveryTime(sessionId: string): void {
    lastDeliveredAt.set(sessionId, Date.now());
}

/**
 * Signal that a trigger event occurred. Call from hook layer when any of the 3 triggers fire.
 */
export function onNoteTrigger(db: Database, sessionId: string, trigger: NoteNudgeTrigger): void {
    setPersistedNoteNudgeTrigger(db, sessionId);
    sessionLog(sessionId, `note-nudge: trigger fired (${trigger}), triggerPending=true`);
}

/**
 * Does NOT clear triggerPending — call markNoteNudgeDelivered() after successful placement.
 *
 * @param currentUserMessageId - The latest user message ID in this transform pass.
 * Defer delivery when currentUserMessageId matches the trigger-time message ID.
 * The trigger fires during the agent's turn, so injecting into the current user message mutates Anthropic's cached prompt prefix.
 * Injecting into the current user message mutates Anthropic's cached prompt prefix.
 * noteReadStillVisible is true when a non-stripped ctx_note(action="read") call remains in the visible message context.
 * A visible non-stripped ctx_note(action="read") call keeps the latest note state in the agent's context.
 *   the agent has read the latest note state AND that read is still visible,
 * Suppress the nudge because the latest note state is already visible.
 * When compaction, ctx_reduce, or age cleaning removes the read call from context, fire the nudge at the next work boundary.
 * Fire the nudge at the next work boundary after the read call leaves visible context.
 * Call hasVisibleNoteReadCall(messages) after materializing drops.
 * Call hasVisibleNoteReadCall(messages) after materializing drops.
 */
export function peekNoteNudgeText(
    db: Database,
    sessionId: string,
    currentUserMessageId?: string | null,
    projectIdentity?: string,
    noteReadStillVisible?: boolean,
): string | null {
    const state = getPersistedNoteNudge(db, sessionId);

    if (!state.triggerPending) return null;

    // Hook callers lack the message array, so this function records the trigger-time message ID.
    // peekNoteNudgeText records the trigger-time message ID because some hooks lack the message array.
    if (!state.triggerMessageId && currentUserMessageId) {
        setPersistedNoteNudgeTriggerMessageId(db, sessionId, currentUserMessageId);
        state.triggerMessageId = currentUserMessageId;
    }

    // Defer delivery until a NEW user message arrives after the trigger.
    // Injecting into the trigger-time message would bust the cached prefix.
    if (
        state.triggerMessageId &&
        currentUserMessageId &&
        state.triggerMessageId === currentUserMessageId
    ) {
        sessionLog(
            sessionId,
            `note-nudge: deferring — current user message ${currentUserMessageId} is same as trigger-time message`,
        );
        return null;
    }

    // The cooldown prevents repeated nudges at commit and task-list boundaries during active work.
    const deliveredAt = getPersistedNoteNudgeDeliveredAt(db, sessionId);
    if (deliveredAt > 0 && Date.now() - deliveredAt < NOTE_NUDGE_COOLDOWN_MS) {
        sessionLog(
            sessionId,
            `note-nudge: suppressing — last delivered ${Math.round((Date.now() - deliveredAt) / 1000)}s ago (cooldown ${NOTE_NUDGE_COOLDOWN_MS / 60000}m)`,
        );
        clearNoteNudgeTriggerOnly(db, sessionId);
        return null;
    }

    const notes = getSessionNotes(db, sessionId);
    const readySmartNotes = projectIdentity ? getReadySmartNotes(db, projectIdentity) : [];
    const totalCount = notes.length + readySmartNotes.length;
    if (totalCount === 0) {
        sessionLog(sessionId, "note-nudge: triggerPending but no notes found, skipping");
        clearNoteNudgeTriggerOnly(db, sessionId);
        return null;
    }

    // Suppress only if lastReadAt is later than a positive mostRecentNoteActivity and the read remains visible.
    // The ctx_note(read) tool call remains visible in the agent's message context.
    //
    // Require both conditions because either condition alone suppresses valid nudges.
    // - Timestamp-only suppression persists after the read result leaves context.
    // Compaction, `ctx_reduce`, or age cleanup can remove the read result from context.
    // The agent then cannot see deferred intentions.
    // Visibility-only suppression re-nudges immediately after the agent reads the latest state.
    //
    const lastReadAt = getNoteLastReadAt(db, sessionId);
    if (lastReadAt > 0 && noteReadStillVisible) {
        const mostRecentNoteActivity = maxNoteActivityTime([...notes, ...readySmartNotes]);
        // The comparison uses `>` so same-millisecond write/read races surface the note rather than suppressing it.
        if (mostRecentNoteActivity > 0 && lastReadAt > mostRecentNoteActivity) {
            sessionLog(
                sessionId,
                `note-nudge: suppressing — agent ran ctx_note(read) at ${new Date(
                    lastReadAt,
                ).toISOString()} and the read is still visible; no new notes since ${new Date(
                    mostRecentNoteActivity,
                ).toISOString()}`,
            );
            clearNoteNudgeTriggerOnly(db, sessionId);
            return null;
        }
    }

    const parts: string[] = [];
    if (notes.length > 0) {
        parts.push(`${notes.length} deferred note${notes.length === 1 ? "" : "s"}`);
    }
    if (readySmartNotes.length > 0) {
        parts.push(
            `${readySmartNotes.length} ready smart note${readySmartNotes.length === 1 ? "" : "s"}`,
        );
    }
    sessionLog(sessionId, `note-nudge: delivering nudge for ${parts.join(" and ")}`);
    return `You have ${parts.join(" and ")}. Review with ctx_note read — some may be actionable now.`;
}

/**
 *
 * `ready_at` detects smart notes that became ready after the read even when their `updated_at` predates it.
 */
function maxNoteActivityTime(notes: Note[]): number {
    let max = 0;
    for (const note of notes) {
        if (note.updatedAt > max) max = note.updatedAt;
        if (note.readyAt !== null && note.readyAt > max) max = note.readyAt;
    }
    return max;
}

/**
 */
export function markNoteNudgeDelivered(
    db: Database,
    sessionId: string,
    text: string,
    messageId: string | null,
): NoteNudgeDeliveryOutcome {
    if (!messageId) {
        clearNoteNudgeTriggerAndCooldown(db, sessionId);
        sessionLog(sessionId, "note-nudge: marked delivered without anchor");
        return { ok: true, kind: "already-present" };
    }

    const outcome = deliverNoteNudgeAtomic(db, sessionId, messageId, text);
    if (outcome.ok) {
        recordNoteNudgeDeliveryTime(sessionId);
    }
    sessionLog(
        sessionId,
        outcome.ok
            ? `note-nudge: marked delivered, sticky anchor=${messageId} (${outcome.kind})`
            : `note-nudge: delivery not persisted for anchor=${messageId} (${outcome.kind})`,
    );
    return outcome;
}

/**
 */
export function getStickyNoteNudge(
    db: Database,
    sessionId: string,
): { text: string; messageId: string } | null {
    const state = getPersistedNoteNudge(db, sessionId);
    if (!state.stickyText || !state.stickyMessageId) return null;
    return { text: state.stickyText, messageId: state.stickyMessageId };
}

/**
 */
export function getNoteNudgeText(db: Database, sessionId: string): string | null {
    const text = peekNoteNudgeText(db, sessionId);
    if (text) {
        markNoteNudgeDelivered(db, sessionId, text, null);
    }
    return text;
}

/**
 */
export function clearNoteNudgeState(
    db: Database,
    sessionId: string,
    options?: { persist?: boolean },
): void {
    if (options?.persist !== false) {
        clearAllNoteNudgeState(db, sessionId);
    }
    lastDeliveredAt.delete(sessionId); // also reset in-memory cooldown
}

export function clearAllNoteNudgeState(db: Database, sessionId: string): void {
    db.transaction(() => {
        db.prepare(
            `UPDATE session_meta
             SET note_nudge_anchors = '[]',
                 note_nudge_trigger_pending = 0,
                 note_nudge_trigger_message_id = '',
                 note_nudge_sticky_text = '',
                 note_nudge_sticky_message_id = ''
             WHERE session_id = ?`,
        ).run(sessionId);
    })();
    lastDeliveredAt.delete(sessionId);
}

export function clearNoteNudgeTriggerAndCooldown(db: Database, sessionId: string): void {
    db.prepare(
        "UPDATE session_meta SET note_nudge_trigger_pending = 0, note_nudge_trigger_message_id = '' WHERE session_id = ?",
    ).run(sessionId);
    lastDeliveredAt.delete(sessionId);
}

export function resetNoteNudgeCooldownOnly(sessionId: string): void {
    lastDeliveredAt.delete(sessionId);
}

export function clearNoteNudgeTriggerOnly(db: Database, sessionId: string): void {
    db.prepare(
        "UPDATE session_meta SET note_nudge_trigger_pending = 0, note_nudge_trigger_message_id = '' WHERE session_id = ?",
    ).run(sessionId);
}
