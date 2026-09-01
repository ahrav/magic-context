/**
 * The server keeps notifications in memory for TUI push.
 *
 * The server plugin cannot use `process.env.OPENCODE_CLIENT` to detect TUI
 * The server runs in a separate process from the TUI client.
 */

export interface RpcNotification {
    id: number;
    type: string;
    payload: Record<string, unknown>;
    sessionId?: string;
}

let queue: RpcNotification[] = [];
let nextNotificationId = 1;

/**
 * Each authenticated TUI WebSocket registers one `NotificationSink`.
 * The server registers a sink when a TUI socket authenticates and removes the sink when the socket closes.
 * The server owns the WebSocket, so `send` is sink-agnostic.
 * `send` accepts no WebSocket type, so this module has no Bun/WS dependency.
 */
export interface NotificationSink {
    /** `sessionId` records the TUI's active session when the TUI connects. */
    sessionId?: string;
    /** Protocol 2 clients use strict session scoping; absent means legacy behavior. */
    protocol?: number;
    /* */
    send: (notification: RpcNotification) => void;
}

// Protocol 2 sinks with `sessionId` receive scoped notifications only for that `sessionId`.
const sinks = new Set<NotificationSink>();

/** Call the returned function when the socket closes. */
export function registerNotificationSink(sink: NotificationSink): () => void {
    sinks.add(sink);
    return () => {
        sinks.delete(sink);
    };
}

/**
 * Protocol 2 sinks without `sessionId` receive only global notifications; legacy sinks also receive scoped notifications. */
function notificationMatchesSink(notification: RpcNotification, sink: NotificationSink): boolean {
    if (notification.sessionId === undefined) return true;
    if (sink.sessionId !== undefined) return notification.sessionId === sink.sessionId;
    return sink.protocol !== 2;
}

/**
 * The queue retains notifications for backlog delivery until acknowledgement or capacity eviction.
 * A reconnecting TUI can receive retained notifications during its next hello.
 * A failed live send leaves the notification queued unless capacity eviction removes it.
 * */
export function pushNotification(
    type: string,
    payload: Record<string, unknown>,
    sessionId?: string,
): void {
    const notification: RpcNotification = { id: nextNotificationId++, type, payload, sessionId };
    queue.push(notification);
    // A thrown `send` call must not block other sinks or the caller.
    for (const sink of sinks) {
        if (!notificationMatchesSink(notification, sink)) continue;
        try {
            sink.send(notification);
        } catch {
            // Ignore `send` failures so the notification remains queued for backlog delivery.
        }
    }
    // `queue` reserves one notification for each of up to 25 recent scopes during capacity eviction.
    if (queue.length > 100) {
        const reservedIds = new Set<number>();
        const reservedScopes = new Set<string>();
        for (let i = queue.length - 1; i >= 0 && reservedScopes.size < 25; i -= 1) {
            const candidate = queue[i];
            const scope = candidate.sessionId ?? "\0global";
            if (reservedScopes.has(scope)) continue;
            reservedScopes.add(scope);
            reservedIds.add(candidate.id);
        }
        const evictionIndex = queue.findIndex((candidate) => !reservedIds.has(candidate.id));
        queue.splice(evictionIndex >= 0 ? evictionIndex : 0, 1);
    }
}

export function acknowledgeNotifications(ids: readonly number[]): void {
    const acknowledged = new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0));
    if (acknowledged.size === 0) return;
    // Acknowledging specific IDs prevents an out-of-order handler from removing an earlier notification.
    queue = queue.filter((notification) => !acknowledged.has(notification.id));
}

/** `__resetNotificationStateForTests` simulates a fresh server module by clearing process-local notification state. */
export function __resetNotificationStateForTests(): void {
    queue = [];
    nextNotificationId = 1;
    sinks.clear();
}

export interface DrainNotificationsOptions {
    /**
     * `globalLastReceivedId` tracks global notifications independently from the session cursor.
     */
    globalLastReceivedId?: number;
    /* */
    sessionOnly?: boolean;
    /* */
    globalOnly?: boolean;
}

function cursor(value: number | undefined): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** `drainNotifications` prunes only the scopes acknowledged by the client's cursors.
 *
 * When `globalLastReceivedId` is set with a `sessionId`, session-scoped and global notifications use separate cursors.
 *  behavior.
 *
 * Returned notifications remain queued until acknowledgement, so reconnecting clients can receive them again.
 * */
export function drainNotifications(
    lastReceivedId = 0,
    sessionId?: string,
    options: DrainNotificationsOptions = {},
): RpcNotification[] {
    const sessionCursor = cursor(lastReceivedId);

    if (options.globalOnly) {
        queue = queue.filter(
            (notification) =>
                notification.sessionId !== undefined || notification.id > sessionCursor,
        );
        return queue.filter(
            (notification) =>
                notification.sessionId === undefined && notification.id > sessionCursor,
        );
    }

    if (options.sessionOnly) {
        if (sessionId === undefined) return [];
        queue = queue.filter(
            (notification) =>
                notification.sessionId !== sessionId || notification.id > sessionCursor,
        );
        return queue.filter(
            (notification) =>
                notification.sessionId === sessionId && notification.id > sessionCursor,
        );
    }

    if (sessionId !== undefined && options.globalLastReceivedId !== undefined) {
        const globalCursor = cursor(options.globalLastReceivedId);
        queue = queue.filter((notification) => {
            if (notification.sessionId === undefined) return notification.id > globalCursor;
            if (notification.sessionId === sessionId) return notification.id > sessionCursor;
            return true;
        });
        return queue.filter((notification) => {
            if (notification.sessionId === undefined) return notification.id > globalCursor;
            return notification.sessionId === sessionId && notification.id > sessionCursor;
        });
    }

    const matchesClient = (notification: RpcNotification): boolean =>
        sessionId === undefined ||
        notification.sessionId === undefined ||
        notification.sessionId === sessionId;
    if (sessionCursor > 0) {
        // Legacy single-cursor mode prunes only the scopes visible to that client.
        queue = queue.filter(
            (notification) => !(notification.id <= sessionCursor && matchesClient(notification)),
        );
    }
    return queue.filter(
        (notification) => notification.id > sessionCursor && matchesClient(notification),
    );
}

/** A TUI is connected only when a live notification sink is registered.
 * A TUI connection requires a registered notification sink; draining notifications does not establish one.
 *
 * `sessionId` scopes the connection check to that session.
 * A session-less sink with `protocol !== 2` counts as connected for every session.
 * */
export function isTuiConnected(sessionId?: string): boolean {
    if (sinks.size === 0) return false;
    if (sessionId === undefined) return true;
    for (const sink of sinks) {
        if (sink.sessionId === sessionId) return true;
        if (sink.sessionId === undefined && sink.protocol !== 2) return true;
    }
    return false;
}
