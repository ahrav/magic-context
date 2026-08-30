import { clearRecompStaging } from "../../features/magic-context/compartment-storage";
import {
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../features/magic-context/storage-meta-session";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import type { NotificationDeliveryDisposition } from "./send-session-notification";

/**
 * E5 — Session upgrade reminder (v2).
 *
 * When a session still holds pre-v2 (legacy) compartments, those render in a
 * degraded title-only/P4 form until the user runs `/ctx-session-upgrade`. This
 * surfaces a bounded, model-invisible reminder pointing at the command.
 *
 * Cache-safety (locked design): the reminder is delivered as an IGNORED message
 * (user-visible, never sent to the model), NOT appended to a user message — so it
 * has zero effect on the cacheable prompt prefix. No anchor/replay machinery needed.
 *
 * Push reminders are bounded per session. A durable timestamp enforces a 24-hour
 * cooldown, and a durable count caps deliveries at three. Pull surfaces such as
 * `/ctx-status` continue to show upgrade-needed compartments after the cap.
 *
 * The in-process set still prevents duplicate delivery before durable metadata is
 * read back.
 */

export const UPGRADE_REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const MAX_UPGRADE_REMINDERS_PER_SESSION = 3;

const remindedThisProcess = new Set<string>();

// Non-TUI (Desktop/Web/headless) reminder text. Mirrors the TUI dialog copy but,
// since there is no clickable button here, it ends with the explicit slash command.
const UPGRADE_REMINDER_TEXT = [
    "🎆 Historian V2 is released!",
    "",
    "This session's compartments are written by the old historian. The session is still usable with its old compartments, however it's strongly advised to upgrade them to the new format. This means every compartment needs to be reprocessed by the new historian, which might take a while depending on how big your session is.",
    "",
    "Running the upgrade will:",
    "• Rebuild this session's compartments into the new layered format",
    "• Re-organize this project's memories into the new taxonomy (once per project)",
    "",
    "The historian runs in the background and you can keep working while older compartments are reprocessed.",
    "",
    "Run `/ctx-session-upgrade` to upgrade now.",
].join("\n");

/** A compartment needs upgrading when it lacks usable v2 tiers — either a pre-v2
 *  `legacy=1` row, OR a malformed "pseudo-v2" row flagged `legacy=0` but with no
 *  `p1` tier (e.g. from an interrupted/crashed recomp, or an older partial-v2
 *  build). The `legacy=0 ⟹ has tiers` invariant can break from any partial state,
 *  which would otherwise TRAP the session — the old gate said "already upgraded"
 *  and refused to re-run on a session with 541 tierless rows.
 *  Single source of truth shared with the upgrade gate in recomp-orchestrator. */
export const NEEDS_UPGRADE_SQL = "(legacy = 1 OR p1 IS NULL OR p1 = '')";

/**
 * Count compartments that still need a v2 upgrade (pre-v2 `legacy=1` rows OR
 * tierless `p1 IS NULL/''` rows from an interrupted/old partial build). Shared
 * with the Pi /ctx-status dialog (Pi has no sidebar, so it surfaces upgrade
 * status here) and the OpenCode upgrade gate. Returns 0 on any error.
 */
export function countCompartmentsNeedingUpgrade(db: Database, sessionId: string): number {
    try {
        const row = db
            .prepare(
                `SELECT COUNT(*) AS count FROM compartments WHERE session_id = ? AND ${NEEDS_UPGRADE_SQL}`,
            )
            .get(sessionId) as { count?: number } | undefined;
        return typeof row?.count === "number" ? row.count : 0;
    } catch {
        return 0;
    }
}

function hasLegacyCompartments(db: Database, sessionId: string): boolean {
    return countCompartmentsNeedingUpgrade(db, sessionId) > 0;
}

/** Partial recomp staging from an INTERRUPTED upgrade — completed historian
 *  passes are committed to `recomp_compartments` per-pass and only promoted to
 *  the real tables at the very end, so a mid-upgrade close leaves staged progress
 *  there that the next run resumes from (it does NOT restart from scratch). */
export interface ResumeInfo {
    /** Compartments already rebuilt and staged. */
    stagedCount: number;
    /** Raw message ordinal the staged work covers through. */
    stagedThrough: number;
}

function getResumeInfo(db: Database, sessionId: string): ResumeInfo | null {
    try {
        const row = db
            .prepare(
                "SELECT COUNT(*) AS count, COALESCE(MAX(end_message), 0) AS through FROM recomp_compartments WHERE session_id = ?",
            )
            .get(sessionId) as { count?: number; through?: number } | undefined;
        if (typeof row?.count === "number" && row.count > 0) {
            return { stagedCount: row.count, stagedThrough: Number(row.through ?? 0) };
        }
        return null;
    } catch {
        return null;
    }
}

/** Resume-flavored reminder copy for the non-TUI (Desktop/headless) path. */
function buildResumeReminderText(resume: ResumeInfo): string {
    return [
        "🎆 Resume the interrupted upgrade?",
        "",
        `An earlier upgrade to the new historian format was interrupted. ${resume.stagedCount} compartment${resume.stagedCount === 1 ? " was" : "s were"} already rebuilt (through message ${resume.stagedThrough}). Resuming continues from where it left off — nothing already rebuilt is reprocessed.`,
        "",
        "Run `/ctx-session-upgrade` to resume now.",
    ].join("\n");
}

export interface UpgradeReminderDeps {
    client: unknown;
    db: Database;
    /** Delivers a model-invisible ignored message to the session (non-TUI path:
     *  Desktop/headless, where it persists in scrollback). */
    sendIgnoredMessage: (
        client: unknown,
        sessionId: string,
        text: string,
        params: Record<string, unknown>,
    ) => Promise<NotificationDeliveryDisposition>;
    /** Live notification params (model/variant/agent) for the active session. */
    getNotificationParams: (sessionId: string) => Record<string, unknown>;
    /** True when a TUI client is actively polling FOR THIS SESSION (decides
     *  dialog vs ignored msg). Must be session-scoped: a TUI on a different
     *  session in the same process must not make this session take the dialog
     *  path. Optional: harnesses without an OpenCode-style TUI dialog system
     *  (e.g. Pi, which delivers via `ctx.ui.notify`) omit this and always take
     *  the `sendIgnoredMessage` path. */
    isTuiConnected?: (sessionId?: string) => boolean;
    /** Enqueue a server→TUI action so the TUI shows an interactive upgrade dialog
     *  ("Run upgrade now"/"Later") instead of a transient toast. TUI path only;
     *  omitted on harnesses without a dialog system. When `resume` is set, the
     *  dialog shows resume-flavored copy. */
    pushTuiDialogAction?: (sessionId: string, resume?: ResumeInfo) => void;
    /** Whether delivery persists in scrollback. Default true for OpenCode.
     *  Pi uses transient toasts, so it ignores the old explicit-dismissal stamp;
     *  both harnesses still persist the shared cooldown and delivery cap. */
    deliveryPersists?: boolean;
}

export async function maybeSendUpgradeReminder(
    deps: UpgradeReminderDeps,
    sessionId: string,
): Promise<void> {
    if (remindedThisProcess.has(sessionId)) return;

    let meta: ReturnType<typeof getOrCreateSessionMeta>;
    try {
        meta = getOrCreateSessionMeta(deps.db, sessionId);
    } catch {
        return;
    }
    if (meta.isSubagent) {
        remindedThisProcess.add(sessionId);
        return;
    }

    // A reminder is warranted only while the session still has legacy/tierless
    // compartments. Fully upgraded sessions can safely discard orphan staging.
    if (!hasLegacyCompartments(deps.db, sessionId)) {
        const orphan = getResumeInfo(deps.db, sessionId);
        if (orphan) {
            try {
                clearRecompStaging(deps.db, sessionId);
                sessionLog(
                    sessionId,
                    `upgrade-reminder: cleared ${orphan.stagedCount} orphan staging row(s) on fully-upgraded session`,
                );
            } catch {
                /* best-effort GC */
            }
        }
        return;
    }

    const resume = getResumeInfo(deps.db, sessionId);
    const durableDismissalActive = deps.deliveryPersists !== false;
    // An explicit OpenCode dialog choice remains a permanent dismissal for the
    // fresh reminder. Pi ignores old stamps because its toast never persisted.
    if (!resume && durableDismissalActive && meta.upgradeRemindedAt !== null) {
        remindedThisProcess.add(sessionId);
        return;
    }

    const now = Date.now();
    if (
        meta.upgradeReminderCount >= MAX_UPGRADE_REMINDERS_PER_SESSION ||
        (meta.upgradeReminderLastSentAt !== null &&
            now - meta.upgradeReminderLastSentAt < UPGRADE_REMINDER_COOLDOWN_MS)
    ) {
        remindedThisProcess.add(sessionId);
        return;
    }

    // In-memory guard prevents same-process re-fire regardless of delivery path.
    remindedThisProcess.add(sessionId);
    const kind = resume ? "resume" : "fresh";
    const recordDelivery = (): void => {
        try {
            updateSessionMeta(deps.db, sessionId, {
                upgradeReminderLastSentAt: now,
                upgradeReminderCount: meta.upgradeReminderCount + 1,
            });
        } catch {
            // Best-effort: process-local guard still avoids a same-process loop.
        }
    };

    try {
        if (deps.isTuiConnected?.(sessionId) && deps.pushTuiDialogAction) {
            // A display is not a dismissal: the user may close the dialog without
            // choosing. It is still a delivered reminder and consumes the cap slot.
            deps.pushTuiDialogAction(sessionId, resume ?? undefined);
            recordDelivery();
            sessionLog(sessionId, `upgrade-reminder: TUI dialog action enqueued (${kind})`);
        } else {
            const delivery = await deps.sendIgnoredMessage(
                deps.client,
                sessionId,
                resume ? buildResumeReminderText(resume) : UPGRADE_REMINDER_TEXT,
                deps.getNotificationParams(sessionId),
            );
            if (delivery === "sent") {
                recordDelivery();
                sessionLog(
                    sessionId,
                    `upgrade-reminder: ignored message delivered (${kind}, non-TUI)`,
                );
            } else {
                sessionLog(
                    sessionId,
                    `upgrade-reminder: ignored message not delivered (${kind}, non-TUI, ${delivery})`,
                );
            }
        }
    } catch (error) {
        sessionLog(sessionId, `upgrade-reminder: delivery failed: ${String(error)}`);
    }
}

/** Test-only: reset the per-process guard. */
export function __resetUpgradeReminderProcessGuard(): void {
    remindedThisProcess.clear();
}

export { UPGRADE_REMINDER_TEXT };
