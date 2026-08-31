/**
 * Persistent WebSocket to the server plugin's RPC server, replacing the old
 * 500ms HTTP notification poll.
 *
 * Why this exists: the TUI plugin and the server plugin run in separate Bun
 * runners in the same process, so they bridge over a localhost socket. The old
 * bridge polled `pending-notifications` over HTTP every 500ms — and each poll
 * opened a NEW loopback TCP connection (Bun's fetch isn't pooled to our server),
 * which was the entire source of idle TUI CPU (#200). A single long-lived WS
 * carries server→TUI pushes with zero per-event connection cost, and the server
 * pushes notifications the instant they're queued (no polling latency).
 *
 * Session scope: the socket carries the TUI's active session in its `hello` so
 * the server delivers only that session's (plus global) notifications and its
 * `isTuiConnected(session)` routing stays correct. The active session is tracked
 * with a cheap watcher that only reads `api.route.current` (a property access,
 * no IPC) and re-scopes the socket ONLY when the session actually changes — so
 * unlike the old poll it does no network work at idle.
 */

import { getRpcClient, getRpcGeneration } from "./context-db";

export interface SocketNotification {
    id: number;
    type: string;
    payload: Record<string, unknown>;
    sessionId?: string;
}

interface NotificationSocketOptions {
    /** Current active session id (re-read cheaply to follow session switches). */
    getSessionId: () => string | null;
    /** Handle one delivered notification. Returns true only after it is fully
     *  consumed and can be acknowledged. Async because dialog handlers await. */
    onNotification: (notification: SocketNotification) => boolean | Promise<boolean>;
}

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;
/** Cheap session-watch interval. Reads a property only; no network. The CPU bug
 *  was the per-tick fetch, not the timer — this tick does zero IPC at idle. */
const SESSION_WATCH_MS = 1_000;

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let sessionWatchTimer: ReturnType<typeof setInterval> | undefined;
let reconnectAttempt = 0;
let closed = false;
let helloedSession: string | null = null;
let opts: NotificationSocketOptions | null = null;
let activeToken: string | null = null;
/** Generation of the rpc client used by the active socket. */
let connectGeneration = 0;
/** Exactly one endpoint lookup may be active. A monotonically increasing id lets
 * stop/restart invalidate a late lookup before it can publish a socket. */
let nextAttemptId = 0;
let inFlightAttemptId: number | null = null;

const GLOBAL_CURSOR_KEY = "global";
const SESSION_CURSOR_PREFIX = "session:";
const MAX_DEDUPED_NOTIFICATION_IDS = 500;
const LEGACY_INSTANCE_ID = "legacy";
type NotificationProtocolMode = "legacy" | "v2";

/**
 * Notification ids restart with every server instance. Epoch-prefixing cursor keys
 * and deduplication ids prevents a surviving TUI from applying a replaced server's
 * high watermark or remembered ids to the replacement's fresh queue.
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

/** Open the persistent notification socket. Reconnects on its own after a drop. */
export function startNotificationSocket(options: NotificationSocketOptions): void {
    opts = options;
    closed = false;
    if (!socket && inFlightAttemptId === null) void connect();
    if (!sessionWatchTimer) {
        sessionWatchTimer = setInterval(watchSession, SESSION_WATCH_MS);
    }
}

/** Close the socket and release all state owned by this TUI initialization. */
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
            // Older servers still read these scoped cursors. Protocol 2 servers
            // rely only on exact acknowledgements and do not prune from them.
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
                // The server does not prune protocol 2 backlog from hello cursors, so a
                // corrected hello safely establishes fresh epoch-scoped state.
                sendHello(ws, token);
            }
        } else {
            // A hello-ack without an instance id is the frozen v0.32 shape. Its
            // server ignores exact-id acks, so cursors must remain gap-safe.
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
        // Server rejected us (bad token, etc.). Close and let backoff retry after
        // rediscovering the port/token (the server may have been replaced).
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
    // A single promise chain prevents two dialog actions from replacing each
    // other's UI while either handler is still awaiting user input.
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
    // Client-side session filtering follows session switches that happen between
    // queueing and delivery. Global notifications always apply.
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
    // A dispose, reconnect, or epoch correction during an awaited dialog invalidates
    // the delivery. The server retains it for the current socket to redeliver.
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
        // while a later notification was consumed successfully.
        ws.send(JSON.stringify({ type: "ack", ids: [notification.id] }));
    } catch {
        // Best-effort: an unacknowledged row is safely deduplicated and re-acked
        // when the server delivers it again after reconnecting.
    }
}

export function _resetNotificationSocketStateForTesting(): void {
    stopNotificationSocket();
}

/** Cheap session-change watcher: re-scope the socket only when the active session
 *  actually changes. Reads a property; no network at idle. */
function watchSession(): void {
    if (closed || !socket || socket.readyState !== WebSocket.OPEN) return;
    const current = opts?.getSessionId() ?? null;
    if (current === helloedSession) return;
    // Re-hello with the token authenticated by this socket; no rediscovery or
    // network request is needed for a local route change.
    sendHello(socket, activeToken);
}
