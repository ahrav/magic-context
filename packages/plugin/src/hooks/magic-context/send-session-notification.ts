import { getErrorMessage } from "../../shared/error-message";
import { sessionLog } from "../../shared/logger";
import { isMidTurn } from "./read-session-db";

export interface NotificationParams {
    agent?: string;
    variant?: string;
    providerId?: string;
    modelId?: string;
    /** TUI toast lifetime in milliseconds (default: 5000). */
    toastDurationMs?: number;
}

export type NotificationDeliveryDisposition = "sent" | "queued" | "skipped" | "failed";

/**
 * Notifications are status lines, not user input. Keep only the newest entries
 * while a real turn is active so a long background run cannot grow memory or
 * manufacture a backlog of user rows at the next idle boundary.
 */
export const MAX_QUEUED_IGNORED_NOTIFICATIONS = 16;

interface QueuedIgnoredNotification {
    client: unknown;
    sessionId: string;
    text: string;
    params: NotificationParams;
    forcePersist: boolean;
}

const queuedIgnoredNotifications = new Map<string, QueuedIgnoredNotification[]>();
const flushingIgnoredNotifications = new Set<string>();
let midTurnDetector = (sessionId: string): boolean => isMidTurn(undefined, sessionId);

function queueIgnoredNotification(notification: QueuedIgnoredNotification): void {
    const queued = queuedIgnoredNotifications.get(notification.sessionId) ?? [];
    queued.push(notification);
    if (queued.length > MAX_QUEUED_IGNORED_NOTIFICATIONS) {
        queued.splice(0, queued.length - MAX_QUEUED_IGNORED_NOTIFICATIONS);
        sessionLog(
            notification.sessionId,
            `ignored notification queue full; dropped oldest entries (kept newest ${MAX_QUEUED_IGNORED_NOTIFICATIONS})`,
        );
    }
    queuedIgnoredNotifications.set(notification.sessionId, queued);
}

async function trySendTuiToast(
    sessionId: string,
    text: string,
    params: NotificationParams,
    forcePersist: boolean,
): Promise<boolean> {
    if (forcePersist) return false;

    const title = extractToastTitle(text);
    const message = text.length > 200 ? `${text.slice(0, 200)}…` : text;
    const toastVariant = inferToastVariant(text);
    const duration = params.toastDurationMs ?? 5000;
    const { isTuiConnected: checkTui } = await import("../../shared/rpc-notifications");
    if (!checkTui(sessionId)) return false;

    try {
        const { pushNotification } = await import("../../shared/rpc-notifications");
        pushNotification(
            "toast",
            {
                title,
                message,
                variant: toastVariant,
                duration,
            },
            sessionId,
        );
        return true;
    } catch {
        // RPC enqueue failed — fall through to the persisted ignored-message path.
        sessionLog(sessionId, "TUI RPC toast enqueue failed, falling back to ignored message");
        return false;
    }
}

/** Test seams for the process-local queue; production uses the read-only OpenCode DB signal. */
export const __ignoredNotificationTest = {
    pendingTexts(sessionId: string): string[] {
        return (queuedIgnoredNotifications.get(sessionId) ?? []).map((item) => item.text);
    },
    reset(): void {
        queuedIgnoredNotifications.clear();
        flushingIgnoredNotifications.clear();
        midTurnDetector = (sessionId: string): boolean => isMidTurn(undefined, sessionId);
    },
    setMidTurnDetector(detector: (sessionId: string) => boolean): void {
        midTurnDetector = detector;
    },
};

interface NotificationClient {
    session?: {
        prompt?: (opts: unknown) => unknown | Promise<unknown>;
        promptAsync?: (opts: unknown) => Promise<unknown>;
    };
}

function hasNotificationSessionClient(client: unknown): client is NotificationClient {
    if (client === null || typeof client !== "object") return false;
    const candidate = client as Record<string, unknown>;
    if (candidate.session === undefined) return true;
    if (candidate.session === null || typeof candidate.session !== "object") return false;
    const session = candidate.session as Record<string, unknown>;
    return (
        (session.prompt === undefined || typeof session.prompt === "function") &&
        (session.promptAsync === undefined || typeof session.promptAsync === "function")
    );
}

/**
 * Map notification text to a TUI toast variant based on content heuristics.
 */
function inferToastVariant(text: string): "success" | "error" | "warning" | "info" {
    const lower = text.toLowerCase();
    if (lower.includes("error") || lower.includes("failed") || lower.includes("alert"))
        return "error";
    if (lower.includes("warning") || lower.includes("⚠")) return "warning";
    if (
        lower.includes("complete") ||
        lower.includes("success") ||
        lower.includes("✓") ||
        lower.includes("finished")
    )
        return "success";
    return "info";
}

/**
 * Extract a short title from notification text (first line or first sentence).
 */
function extractToastTitle(text: string): string {
    // Use first markdown heading if present
    const headingMatch = text.match(/^#+\s+(.+)/m);
    if (headingMatch) return headingMatch[1].trim();
    // Use first line if short enough
    const firstLine = text.split("\n")[0].trim();
    if (firstLine.length <= 80) return firstLine;
    return "Magic Context";
}

async function sendIgnoredMessageNow(
    client: unknown,
    sessionId: string,
    text: string,
    params: NotificationParams,
    forcePersist: boolean,
): Promise<NotificationDeliveryDisposition> {
    // A final active-run check closes the window created by the title/context
    // lookups below. The normal caller checks before entering this function too.
    if (midTurnDetector(sessionId)) {
        queueIgnoredNotification({ client, sessionId, text, params, forcePersist });
        return "queued";
    }

    // Title-safety guard (issue #129): an ignored message is hidden from the
    // LLM but NOT `synthetic`, so OpenCode's title gate counts it as a real
    // user message — one post into a not-yet-titled session permanently
    // suppresses that session's title generation. Only persist into sessions
    // that already have a real title (the toast path above is unaffected).
    const { waitForSafeNotificationTarget } = await import("../../shared/safe-notification-target");
    if ((await waitForSafeNotificationTarget(client, sessionId)) === "skip") {
        sessionLog(sessionId, "notification skipped (session not titled yet)");
        return "skipped";
    }

    // Check again immediately before constructing the prompt. This prevents an
    // active run that began during title lookup or prompt-context resolution
    // from receiving a new user row.
    if (midTurnDetector(sessionId)) {
        queueIgnoredNotification({ client, sessionId, text, params, forcePersist });
        return "queued";
    }

    if (!hasNotificationSessionClient(client)) {
        sessionLog(sessionId, "session prompt API unavailable for notification");
        return "failed";
    }
    const c = client;

    // Pin the prompt context (agent + model + variant) to the session's most
    // recent real turn. WHY: even though this is `noReply: true` (no assistant
    // turn fires now), OpenCode's createUserMessage RECORDS prompt context on
    // the appended user message, and THAT becomes the session's active
    // model/agent for the NEXT real turn. Passing nothing makes OpenCode record
    // the DEFAULT agent/model — which then switches the model on the user's
    // next turn and busts the provider prefix cache the prior turn warmed.
    // Mirrors AFT's notifications.ts.
    //
    // Caller-supplied params win; otherwise resolve from the last assistant
    // turn. We only pin values actually resolved from real messages (never a
    // synthesized default), and resolution failures degrade to "pin nothing"
    // (today's behavior) — so a fresh/empty session is never made worse.
    let agent = params.agent || undefined;
    let variant = params.variant || undefined;
    let model =
        params.providerId && params.modelId
            ? { providerID: params.providerId, modelID: params.modelId }
            : undefined;
    if (!agent || !model || !variant) {
        try {
            const { resolvePromptContext } = await import("../../shared/prompt-context");
            const resolved = await resolvePromptContext(client, sessionId);
            if (resolved) {
                agent = agent ?? resolved.agent;
                model = model ?? resolved.model;
                variant = variant ?? resolved.variant;
            }
        } catch {
            // Resolution is best-effort; on failure fall back to whatever the
            // caller passed (possibly nothing) rather than blocking the notice.
        }
    }

    // The context lookup above can yield to a newly started run. Check directly
    // before the SDK call so the final mutation gate covers that last window too.
    if (midTurnDetector(sessionId)) {
        queueIgnoredNotification({ client, sessionId, text, params, forcePersist });
        return "queued";
    }

    const input = {
        path: { id: sessionId },
        body: {
            // noReply prevents this status line from starting a new model loop.
            // It does not make appending during an active loop safe; the caller
            // defers while mid-turn, which is the separate safety gate.
            noReply: true,
            agent,
            model,
            variant,
            parts: [
                {
                    type: "text",
                    text,
                    ignored: true,
                },
            ],
        },
    };

    try {
        if (typeof c.session?.prompt === "function") {
            await Promise.resolve(c.session.prompt(input));
            return "sent";
        }
        if (typeof c.session?.promptAsync === "function") {
            await c.session.promptAsync(input);
            return "sent";
        }
        sessionLog(sessionId, "session prompt API unavailable for notification");
        return "failed";
    } catch (error: unknown) {
        const msg = getErrorMessage(error);
        sessionLog(sessionId, "failed to send notification:", msg);
        return "failed";
    }
}

export async function sendIgnoredMessage(
    client: unknown,
    sessionId: string,
    text: string,
    params: NotificationParams,
    // When true, always persist as an ignored message instead of using the TUI
    // toast path, so the content remains in scrollback. Use this for outcomes of
    // long-running background work, such as a session-upgrade result, when a
    // transient five-second toast may be missed.
    forcePersist = false,
): Promise<NotificationDeliveryDisposition> {
    // TUI notifications are already out-of-band and do not create a user row.
    if (await trySendTuiToast(sessionId, text, params, forcePersist)) return "sent";

    // OpenCode's MessageV2.latest is role-based and treats an ignored-only user
    // row as the latest user turn. Do not create that invisible chronology entry
    // while the read-only DB signal says the assistant is still mid-turn.
    if (midTurnDetector(sessionId)) {
        queueIgnoredNotification({ client, sessionId, text, params, forcePersist });
        return "queued";
    }

    return sendIgnoredMessageNow(client, sessionId, text, params, forcePersist);
}

/**
 * Flush queued status lines after an event that may have made the session idle.
 * The event hook and tool.execute.after both call this; the same DB-backed gate
 * remains authoritative, so a non-idle event is harmless.
 */
export async function flushIgnoredMessages(sessionId: string): Promise<void> {
    if (flushingIgnoredNotifications.has(sessionId) || midTurnDetector(sessionId)) return;
    const queued = queuedIgnoredNotifications.get(sessionId);
    if (!queued || queued.length === 0) return;

    queuedIgnoredNotifications.delete(sessionId);
    flushingIgnoredNotifications.add(sessionId);
    try {
        for (const notification of queued) {
            const disposition = await sendIgnoredMessage(
                notification.client,
                notification.sessionId,
                notification.text,
                notification.params,
                notification.forcePersist,
            );
            if (disposition === "queued") {
                // The current item is already re-queued by sendIgnoredMessage.
                // Preserve the remaining entries behind it in their original order.
                for (const remaining of queued.slice(queued.indexOf(notification) + 1)) {
                    queueIgnoredNotification(remaining);
                }
                break;
            }
        }
    } finally {
        flushingIgnoredNotifications.delete(sessionId);
    }
}

export function clearIgnoredMessages(sessionId: string): void {
    queuedIgnoredNotifications.delete(sessionId);
    flushingIgnoredNotifications.delete(sessionId);
}

/**
 * Send a real user prompt that will be processed by the model (not ignored).
 * Used by /ctx-aug to inject the augmented prompt after sidekick completes.
 */
export async function sendUserPrompt(
    client: unknown,
    sessionId: string,
    text: string,
): Promise<void> {
    if (!hasNotificationSessionClient(client)) {
        sessionLog(sessionId, "session prompt API unavailable for user prompt");
        return;
    }
    const c = client as NotificationClient;

    const input = {
        path: { id: sessionId },
        body: {
            parts: [{ type: "text", text }],
        },
    };

    try {
        if (typeof c.session?.promptAsync === "function") {
            await c.session.promptAsync(input);
        } else if (typeof c.session?.prompt === "function") {
            await Promise.resolve(c.session.prompt(input));
        } else {
            sessionLog(sessionId, "session prompt API unavailable for user prompt");
        }
    } catch (error: unknown) {
        const msg = getErrorMessage(error);
        sessionLog(sessionId, "failed to send user prompt:", msg);
    }
}
