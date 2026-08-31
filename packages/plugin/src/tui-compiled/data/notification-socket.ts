/**
 *
 * The TUI and server plugins run in separate Bun runners in the same process and communicate over a localhost socket.
 * The persistent socket avoids opening a loopback TCP connection for each notification.
 * The server pushes queued notifications over the socket.
 *
 * The socket includes the TUI's active session in its `hello`.
 * The server delivers notifications for the active session and global notifications only.
 * The active-session `hello` keeps `isTuiConnected(session)` routing correct.
 * The watcher reads only `api.route.current`.
 * The watcher re-scopes the socket only when the active session changes.
 */

import { getRpcClient, getRpcGeneration } from "./context-db";

export interface SocketNotification {
    id: number;
    type: string;
    payload: Record<string, unknown>;
    sessionId?: string;
}

interface NotificationSocketOptions {
    /* */
    getSessionId: () => string | null;
    /** `onNotification` returns `true` only after the notification can be acknowledged.
     * `onNotification` may be asynchronous because dialog handlers await. */
    onNotification: (notification: SocketNotification) => boolean | Promise<boolean>;
}

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;
/** The interval reads a property and performs no IPC or network work while idle.
 * */
const SESSION_WATCH_MS = 1_000;

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let sessionWatchTimer: ReturnType<typeof setInterval> | undefined;
let reconnectAttempt = 0;
let closed = false;
let helloedSession: string | null = null;
let opts: NotificationSocketOptions | null = null;
let activeToken: string | null = null;
/* */
let connectGeneration = 0;
/** At most one endpoint lookup may be active.
 * Stopping or restarting invalidates a late endpoint lookup before it publishes a socket. */
let nextAttemptId = 0;
let inFlightAttemptId: number | null = null;

const GLOBAL_CURSOR_KEY = "global";
const SESSION_CURSOR_PREFIX = "session:";
const MAX_DEDUPED_NOTIFICATION_IDS = 500;
const LEGACY_INSTANCE_ID = "legacy";
type NotificationProtocolMode = "legacy" | "v2";

/**
 * Server-instance epochs isolate cursor state because notification IDs restart for each server instance.
 * Epoch-prefixing deduplication IDs prevents remembered IDs from one server instance from suppressing another instance's notifications.
 * Epoch-scoped state prevents a replacement server from inheriting the previous server's cursor watermark or deduplicated IDs.
 */
let activeInstanceId: string | null = null;
let notificationProtocolMode: NotificationProtocolMode | null = null;
const bufferedNotifications: SocketNotification[] = [];
const lastHandledIdByCursor = new Map<string, number>();
const handledNotificationIds = new Set<string>();
const handledNotificationIdOrder: string[] = [];
const legacyUnconsumedIdsByCursor = new Map<string, Set<number>>();
const legacyConsumedIdsByCursor = new Map<string, Set<number>>();
/** Dialog actions share UI state, so notification handlers must never overlap. */
let notificationHandlingChain: Promise<void> = Promise.resolve();

/* */
export function startNotificationSocket(options: NotificationSocketOptions): void {
    opts = options;
    closed = false;
    if (!socket && inFlightAttemptId === null) void connect();
    if (!sessionWatchTimer) {
        sessionWatchTimer = setInterval(watchSession, SESSION_WATCH_MS);
    }
}

/* */
export function stopNotificationSocket(): void {
    closed = true;
    nextAttemptId += 1;
    inFlightAttemptId = null;
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
    }
    if (sessionWatchTimer) {
        clearInterval(sessionWatchTimer);
        sessionWatchTimer = undefined;
    }
    try {
        socket?.close();
    } catch {
        // best-effort
    }
    socket = null;
    opts = null;
    activeToken = null;
    helloedSession = null;
    reconnectAttempt = 0;
    activeInstanceId = null;
    notificationProtocolMode = null;
    bufferedNotifications.length = 0;
    lastHandledIdByCursor.clear();
    handledNotificationIds.clear();
    handledNotificationIdOrder.length = 0;
    legacyUnconsumedIdsByCursor.clear();
    legacyConsumedIdsByCursor.clear();
    notificationHandlingChain = Promise.resolve();
}

function scheduleReconnect(): void {
    if (closed) return;
    if (reconnectTimer) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        connect();
    }, delay);
}

async function connect(): Promise<void> {
    if (closed || socket || inFlightAttemptId !== null) return;

    const client = getRpcClient();
    if (!client) {
        scheduleReconnect();
        return;
    }

    const attemptId = ++nextAttemptId;
    const rpcGeneration = getRpcGeneration();
    inFlightAttemptId = attemptId;
    const endpoint = await client.resolveEndpoint();
    if (closed || inFlightAttemptId !== attemptId || getRpcGeneration() !== rpcGeneration) {
        return;
    }
    inFlightAttemptId = null;
    if (!endpoint) {
        scheduleReconnect();
        return;
    }

    let ws: WebSocket;
    try {
        ws = new WebSocket(`ws://127.0.0.1:${endpoint.port}/ws`, {
            headers: endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {},
        });
    } catch {
        client.reset();
        scheduleReconnect();
        return;
    }

    if (closed || getRpcGeneration() !== rpcGeneration || socket) {
        ws.close();
        return;
    }
    connectGeneration = rpcGeneration;
    activeToken = endpoint.token;
    notificationProtocolMode = null;
    bufferedNotifications.length = 0;
    switchNotificationEpoch(endpoint.instanceId ?? LEGACY_INSTANCE_ID);
    socket = ws;

    ws.addEventListener("open", () => {
        if (socket !== ws || getRpcGeneration() !== connectGeneration) {
            ws.close();
            return;
        }
        reconnectAttempt = 0;
        sendHello(ws, endpoint.token);
    });

    ws.addEventListener("message", (event) => {
        if (socket !== ws) return;
        handleSocketMessage(ws, String((event as MessageEvent).data), endpoint.token);
    });

    const onDown = () => {
        if (socket !== ws) return;
        client.reset();
        socket = null;
        activeToken = null;
        helloedSession = null;
        notificationProtocolMode = null;
        bufferedNotifications.length = 0;
        scheduleReconnect();
    };
    ws.addEventListener("close", onDown);
    ws.addEventListener("error", onDown);
}

function sendHello(ws: WebSocket, token: string | null): void {
    const sessionId = opts?.getSessionId() ?? undefined;
    helloedSession = sessionId ?? null;
    ws.send(
        JSON.stringify({
            type: "hello",
            protocol: 2,
            instanceId: activeInstanceId,
            token: token ?? "",
            sessionId,
            // Legacy servers read scoped cursors.
            // Protocol 2 servers prune notifications only from exact acknowledgements, not scoped cursors.
            lastReceivedId: cursorForKey(cursorKeyForSession(sessionId)),
            globalLastReceivedId: cursorForKey(cursorKeyForSession(undefined)),
        }),
    );
}

function handleSocketMessage(ws: WebSocket, raw: string, token: string | null): void {
    let msg: {
        type?: string;
        notification?: SocketNotification;
        error?: string;
        instanceId?: string;
    };
    try {
        msg = JSON.parse(raw);
    } catch {
        return;
    }

    if (msg.type === "hello-ack") {
        if (typeof msg.instanceId === "string") {
            notificationProtocolMode = "v2";
            if (msg.instanceId !== activeInstanceId) {
                switchNotificationEpoch(msg.instanceId);
                // A `hello` with a changed instance ID establishes fresh epoch-scoped state.
                sendHello(ws, token);
            }
        } else {
            // A hello-ack without an instance ID identifies the legacy protocol.
            // Legacy servers ignore exact-ID acknowledgements, so cursors must remain gap-safe.
            notificationProtocolMode = "legacy";
            switchNotificationEpoch(LEGACY_INSTANCE_ID);
        }
        flushBufferedNotifications(ws);
        return;
    }

    if (msg.type === "notification" && msg.notification) {
        if (notificationProtocolMode === null) {
            bufferedNotifications.push(msg.notification);
        } else {
            queueNotification(ws, msg.notification);
        }
        return;
    }

    if (msg.type === "error") {
        // Server rejection closes the socket so backoff retries after rediscovering the port and token.
        try {
            ws.close();
        } catch {
            // best-effort
        }
    }
}

function flushBufferedNotifications(ws: WebSocket): void {
    const pending = bufferedNotifications.splice(0);
    for (const notification of pending) queueNotification(ws, notification);
}

function queueNotification(ws: WebSocket, notification: SocketNotification): void {
    const deliveryInstanceId = activeInstanceId ?? LEGACY_INSTANCE_ID;
    const deliveryMode = notificationProtocolMode;
    if (deliveryMode === null) return;
    // The promise chain prevents one dialog action from replacing another action's UI while either awaits user input.
    notificationHandlingChain = notificationHandlingChain
        .then(() => handleNotification(ws, notification, deliveryInstanceId, deliveryMode))
        .catch(() => {});
}

async function handleNotification(
    ws: WebSocket,
    notification: SocketNotification,
    deliveryInstanceId: string,
    deliveryMode: NotificationProtocolMode,
): Promise<void> {
    if (
        socket !== ws ||
        getRpcGeneration() !== connectGeneration ||
        activeInstanceId !== deliveryInstanceId ||
        notificationProtocolMode !== deliveryMode
    ) {
        return;
    }
    // Session filtering uses the session active at delivery time; global notifications bypass the filter.
    const active = opts?.getSessionId() ?? null;
    if (notification.sessionId !== undefined && notification.sessionId !== active) return;

    if (deliveryMode === "legacy") markLegacyUnconsumed(notification);
    if (handledNotificationIds.has(notificationDedupKey(notification.id, deliveryInstanceId))) {
        if (deliveryMode === "legacy") markLegacyConsumed(notification);
        sendAck(ws, notification, deliveryMode);
        return;
    }

    let consumed = false;
    try {
        consumed = await Promise.resolve(opts?.onNotification(notification) ?? false);
    } catch {
        consumed = false;
    }
    // The client does not acknowledge a delivery after the socket, RPC generation, instance, or protocol mode changes while `onNotification` awaits.
    if (
        socket !== ws ||
        getRpcGeneration() !== connectGeneration ||
        activeInstanceId !== deliveryInstanceId ||
        notificationProtocolMode !== deliveryMode
    ) {
        return;
    }
    if (consumed) {
        rememberHandledId(notification.id, deliveryInstanceId);
        if (deliveryMode === "legacy") {
            markLegacyConsumed(notification);
        } else {
            advanceCursor(notificationCursorKey(notification), notification.id);
        }
        sendAck(ws, notification, deliveryMode);
    }
}

function cursorKeyForSession(sessionId: string | null | undefined): string {
    const scope = sessionId ? `${SESSION_CURSOR_PREFIX}${sessionId}` : GLOBAL_CURSOR_KEY;
    return `${activeInstanceId ?? LEGACY_INSTANCE_ID}:${scope}`;
}

function notificationCursorKey(notification: SocketNotification): string {
    return cursorKeyForSession(notification.sessionId);
}

function cursorForKey(key: string): number {
    return lastHandledIdByCursor.get(key) ?? 0;
}

function advanceCursor(key: string, id: number): void {
    if (id > cursorForKey(key)) lastHandledIdByCursor.set(key, id);
}

function idsForCursor(map: Map<string, Set<number>>, key: string): Set<number> {
    let ids = map.get(key);
    if (!ids) {
        ids = new Set<number>();
        map.set(key, ids);
    }
    return ids;
}

function markLegacyUnconsumed(notification: SocketNotification): void {
    const key = notificationCursorKey(notification);
    if (idsForCursor(legacyConsumedIdsByCursor, key).has(notification.id)) return;
    idsForCursor(legacyUnconsumedIdsByCursor, key).add(notification.id);
}

function markLegacyConsumed(notification: SocketNotification): void {
    const key = notificationCursorKey(notification);
    idsForCursor(legacyUnconsumedIdsByCursor, key).delete(notification.id);
    const consumedIds = idsForCursor(legacyConsumedIdsByCursor, key);
    consumedIds.add(notification.id);

    let safeCursor = Math.max(cursorForKey(key), ...consumedIds);
    const unconsumedIds = legacyUnconsumedIdsByCursor.get(key);
    if (unconsumedIds && unconsumedIds.size > 0) {
        safeCursor = Math.min(safeCursor, Math.min(...unconsumedIds) - 1);
    }
    advanceCursor(key, safeCursor);
    for (const id of consumedIds) {
        if (id <= cursorForKey(key)) consumedIds.delete(id);
    }
}

function notificationDedupKey(
    id: number,
    instanceId = activeInstanceId ?? LEGACY_INSTANCE_ID,
): string {
    return `${instanceId}:${id}`;
}

function rememberHandledId(id: number, instanceId: string): void {
    const key = notificationDedupKey(id, instanceId);
    if (handledNotificationIds.has(key)) return;
    handledNotificationIds.add(key);
    handledNotificationIdOrder.push(key);
    while (handledNotificationIdOrder.length > MAX_DEDUPED_NOTIFICATION_IDS) {
        const evicted = handledNotificationIdOrder.shift();
        if (evicted !== undefined) handledNotificationIds.delete(evicted);
    }
}

function switchNotificationEpoch(instanceId: string): void {
    if (activeInstanceId === instanceId) return;
    activeInstanceId = instanceId;
    lastHandledIdByCursor.clear();
    handledNotificationIds.clear();
    handledNotificationIdOrder.length = 0;
    legacyUnconsumedIdsByCursor.clear();
    legacyConsumedIdsByCursor.clear();
}

function sendAck(
    ws: WebSocket,
    notification: SocketNotification,
    mode: NotificationProtocolMode,
): void {
    try {
        if (mode === "legacy") {
            const cursor = cursorForKey(notificationCursorKey(notification));
            ws.send(
                JSON.stringify({
                    type: "ack",
                    cursor,
                    ...(notification.sessionId
                        ? { sessionId: notification.sessionId }
                        : { ackScope: "global" }),
                }),
            );
            return;
        }
        // Exact ids avoid deleting an earlier notification whose handler failed
        ws.send(JSON.stringify({ type: "ack", ids: [notification.id] }));
    } catch {
        // The client re-acknowledges duplicate notifications after reconnecting so the server stops redelivering them.
    }
}

export function _resetNotificationSocketStateForTesting(): void {
    stopNotificationSocket();
}

/**
 * */
function watchSession(): void {
    if (closed || !socket || socket.readyState !== WebSocket.OPEN) return;
    const current = opts?.getSessionId() ?? null;
    if (current === helloedSession) return;
    // The client reuses the socket's authenticated token for local route changes without rediscovering the port or token.
    sendHello(socket, activeToken);
}
