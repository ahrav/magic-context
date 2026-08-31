import { clearRecompStaging } from "../../features/magic-context/compartment-storage";
import {
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../features/magic-context/storage-meta-session";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import type { NotificationDeliveryDisposition } from "./send-session-notification";

/**
 *
 * Legacy compartments render in title-only/P4 form until `/ctx-session-upgrade` runs.
 * The reminder is model-invisible and directs users to `/ctx-session-upgrade`.
 *
 * The reminder is delivered as an IGNORED message rather than appended to a user message.
 * IGNORED messages are user-visible and never reach the model, so the reminder does not alter the cacheable prompt prefix.
 *
 * A durable timestamp enforces a 24-hour per-session cooldown.
 * A durable count limits each session to three deliveries.
 *
 * `remindedThisProcess` prevents duplicate delivery before durable metadata is reread.
 * read back.
 */

export const UPGRADE_REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const MAX_UPGRADE_REMINDERS_PER_SESSION = 3;

const remindedThisProcess = new Set<string>();

// Non-TUI reminders end with `/ctx-session-upgrade` because they have no clickable upgrade button.
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

/**
 * Partial upgrades can violate the `legacy = 0` implies usable tiers invariant.
 * */
export const NEEDS_UPGRADE_SQL = "(legacy = 1 OR p1 IS NULL OR p1 = '')";

/**
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

/** Interrupted upgrades retain staged recompartment data for resumption.
 * Completed historian passes are staged in `recomp_compartments` before final promotion.
 * A mid-upgrade close leaves staged progress for the next run.
 * The next upgrade resumes staged progress instead of restarting. */
export interface ResumeInfo {
    /* */
    stagedCount: number;
    /* */
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

/* */
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
    /** The non-TUI path delivers the reminder as a model-invisible IGNORED message.
     * */
    sendIgnoredMessage: (
        client: unknown,
        sessionId: string,
        text: string,
        params: Record<string, unknown>,
    ) => Promise<NotificationDeliveryDisposition>;
    /* */
    getNotificationParams: (sessionId: string) => Record<string, unknown>;
    /** isTuiConnected returns true only when a TUI client actively polls the specified session.
     * A TUI connected to another session must not select the dialog path.
     * Harnesses without an OpenCode-style TUI dialog system may omit isTuiConnected.
     * Pi omits isTuiConnected because it delivers through ctx.ui.notify.
     * Harnesses that omit isTuiConnected always use sendIgnoredMessage. */
    isTuiConnected?: (sessionId?: string) => boolean;
    /** pushTuiDialogAction enqueues an interactive upgrade dialog instead of a transient toast.
     * pushTuiDialogAction is used only for TUI delivery.
     * Harnesses without a dialog system omit pushTuiDialogAction.
     * */
    pushTuiDialogAction?: (sessionId: string, resume?: ResumeInfo) => void;
    /** deliveryPersists controls whether delivery persists in scrollback and defaults to true for OpenCode.
     * Pi uses transient toasts, so it ignores the explicit-dismissal stamp.
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

    // Without legacy or tierless compartments, staged rows are orphaned.
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
            // The process-local guard prevents same-process retry loops.
        }
    };

    try {
        if (deps.isTuiConnected?.(sessionId) && deps.pushTuiDialogAction) {
            // Closing the dialog without choosing still consumes a delivery-cap slot.
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

/* */
export function __resetUpgradeReminderProcessGuard(): void {
    remindedThisProcess.clear();
}

export { UPGRADE_REMINDER_TEXT };
