import { getErrorMessage } from "../../shared/error-message";
import { sessionLog } from "../../shared/logger";
import { isMidTurn } from "./read-session-db";

export interface NotificationParams {
    agent?: string;
    variant?: string;
    providerId?: string;
    modelId?: string;
    /* */
    toastDurationMs?: number;
}

export type NotificationDeliveryDisposition = "sent" | "queued" | "skipped" | "failed";

/**
 * Because notifications are status lines rather than user input, the queue keeps only the newest entries.
 * The per-session limit prevents an active turn from accumulating more than 16 queued notifications.
 * The limit caps an idle-boundary backlog at 16 user rows.
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
        // An RPC enqueue failure falls through to the persisted ignored-message path.
        sessionLog(sessionId, "TUI RPC toast enqueue failed, falling back to ignored message");
        return false;
    }
}

/** Production reads the OpenCode DB signal; tests replace it through __ignoredNotificationTest. */
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
 */
function extractToastTitle(text: string): string {
    const headingMatch = text.match(/^#+\s+(.+)/m);
    if (headingMatch) return headingMatch[1].trim();
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
    // A final active-run check closes the window created by title and prompt-context lookups.
    if (midTurnDetector(sessionId)) {
        queueIgnoredNotification({ client, sessionId, text, params, forcePersist });
        return "queued";
    }

    // Persistence requires a real session title.
    // Ignored messages are hidden from the LLM but are not `synthetic`, so OpenCode counts them as real user messages for title generation.
    // A notification persisted before title generation permanently suppresses that session's title generation.
    const { waitForSafeNotificationTarget } = await import("../../shared/safe-notification-target");
    if ((await waitForSafeNotificationTarget(client, sessionId)) === "skip") {
        sessionLog(sessionId, "notification skipped (session not titled yet)");
        return "skipped";
    }

    // The second active-run check prevents runs that begin during title or prompt-context lookup from receiving a user row.
    // The second check runs after title and prompt-context lookup to close their race window.
    // The second check prevents a newly active run from receiving a user row.
    if (midTurnDetector(sessionId)) {
        queueIgnoredNotification({ client, sessionId, text, params, forcePersist });
        return "queued";
    }

    if (!hasNotificationSessionClient(client)) {
        sessionLog(sessionId, "session prompt API unavailable for notification");
        return "failed";
    }
    const c = client;

    // Unresolved prompt context is pinned to the latest real turn so the noReply user row cannot change the next turn's active agent or model.
    // createUserMessage records prompt context on the appended noReply user message, making it active for the next real turn.
    // Without pinned context, OpenCode records the default agent and model.
    // The default agent and model become active on the user's next turn.
    //
    // Caller-supplied params win; otherwise resolve them from the last assistant message.
    // The code pins only values resolved from real messages; it never pins synthesized defaults.
    // Resolution failures leave prompt context unset.
    // Leaving context unset preserves fresh and empty sessions' default behavior.
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
            // If resolution fails, use caller-supplied params without blocking the notification.
        }
    }

    // Check for an active run immediately before the SDK call to prevent a concurrent run from receiving a user row.
    if (midTurnDetector(sessionId)) {
        queueIgnoredNotification({ client, sessionId, text, params, forcePersist });
        return "queued";
    }

    const input = {
        path: { id: sessionId },
        body: {
            // noReply prevents this status line from starting a new model loop.
            // noReply does not make appending during an active loop safe; the caller must prevent it.
            // The caller defers while mid-turn; that check is the separate safety gate.
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
    // forcePersist always persists the notification as an ignored message instead of using the TUI.
    // forcePersist preserves the message in scrollback.
    forcePersist = false,
): Promise<NotificationDeliveryDisposition> {
    // TUI notifications are already out-of-band and do not create a user row.
    if (await trySendTuiToast(sessionId, text, params, forcePersist)) return "sent";

    // `MessageV2.latest` treats an ignored-only user row as the latest user turn.
    // Do not create an ignored-only user row.
    // `MessageV2.latest` treats an ignored-only user row as the latest user turn; do not create one when `midTurnDetector(sessionId)` returns true.
    if (midTurnDetector(sessionId)) {
        queueIgnoredNotification({ client, sessionId, text, params, forcePersist });
        return "queued";
    }

    return sendIgnoredMessageNow(client, sessionId, text, params, forcePersist);
}

/**
 * Flush queued status lines only when the session is idle.
 * midTurnDetector prevents sends while the session is non-idle.
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
