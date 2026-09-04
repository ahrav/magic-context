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
export declare const UPGRADE_REMINDER_COOLDOWN_MS: number;
export declare const MAX_UPGRADE_REMINDERS_PER_SESSION = 3;
declare const UPGRADE_REMINDER_TEXT: string;
/** A compartment needs upgrading when it lacks usable v2 tiers — either a pre-v2
 *  `legacy=1` row, OR a malformed "pseudo-v2" row flagged `legacy=0` but with no
 *  `p1` tier (e.g. from an interrupted/crashed recomp, or an older partial-v2
 *  build). The `legacy=0 ⟹ has tiers` invariant can break from any partial state,
 *  which would otherwise TRAP the session — the old gate said "already upgraded"
 *  and refused to re-run (dogfood 2026-05-30, AFT session with 541 tierless rows).
 *  Single source of truth shared with the upgrade gate in recomp-orchestrator. */
export declare const NEEDS_UPGRADE_SQL = "(legacy = 1 OR p1 IS NULL OR p1 = '')";
/**
 * Count compartments that still need a v2 upgrade (pre-v2 `legacy=1` rows OR
 * tierless `p1 IS NULL/''` rows from an interrupted/old partial build). Shared
 * with the Pi /ctx-status dialog (Pi has no sidebar, so it surfaces upgrade
 * status here) and the OpenCode upgrade gate. Returns 0 on any error.
 */
export declare function countCompartmentsNeedingUpgrade(db: Database, sessionId: string): number;
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
export interface UpgradeReminderDeps {
    client: unknown;
    db: Database;
    /** Delivers a model-invisible ignored message to the session (non-TUI path:
     *  Desktop/headless, where it persists in scrollback). */
    sendIgnoredMessage: (client: unknown, sessionId: string, text: string, params: Record<string, unknown>) => Promise<NotificationDeliveryDisposition>;
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
export declare function maybeSendUpgradeReminder(deps: UpgradeReminderDeps, sessionId: string): Promise<void>;
/** Test-only: reset the per-process guard. */
export declare function __resetUpgradeReminderProcessGuard(): void;
export { UPGRADE_REMINDER_TEXT };
//# sourceMappingURL=upgrade-reminder.d.ts.map