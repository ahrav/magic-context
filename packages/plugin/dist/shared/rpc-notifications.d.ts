/**
 * In-memory notification queue for server→TUI push.
 * Replaces SQLite plugin_messages table.
 *
 * Also tracks whether a TUI client is actively connected (polling).
 * The server plugin cannot use `process.env.OPENCODE_CLIENT` to detect TUI
 * because the server runs in a separate process from the TUI client.
 */
export interface RpcNotification {
    id: number;
    type: string;
    payload: Record<string, unknown>;
    sessionId?: string;
}
/**
 * A connected TUI notification sink — one per authenticated WebSocket. The RPC
 * server registers a sink when a TUI socket authenticates (hello) and removes
 * it on close. `send` is sink-agnostic (the server owns the actual WS socket)
 * so this module stays free of Bun/WS types.
 */
export interface NotificationSink {
    /** The TUI's active session at connect time (its hello scope). */
    sessionId?: string;
    /** Protocol 2 clients use strict session scoping; absent means legacy behavior. */
    protocol?: number;
    /** Deliver one notification over this sink's live socket. */
    send: (notification: RpcNotification) => void;
}
/** Register a live TUI sink. Returns an unregister fn (call on socket close). */
export declare function registerNotificationSink(sink: NotificationSink): () => void;
/** Push a notification to the TUI. Fans out to any live WS sink immediately and
 *  also enqueues it so a TUI that is momentarily disconnected (reconnecting, or
 *  not yet connected) still receives it on its next hello via the backlog drain.
 *  At-least-once: a live push that the socket drops is re-delivered from the
 *  queue on reconnect (pruned only when the client acknowledges it). */
export declare function pushNotification(type: string, payload: Record<string, unknown>, sessionId?: string): void;
export declare function acknowledgeNotifications(ids: readonly number[]): void;
/** Reset process-local state to simulate a fresh server module in protocol tests. */
export declare function __resetNotificationStateForTests(): void;
export interface DrainNotificationsOptions {
    /**
     * Cursor for global notifications when a session-scoped client sends separate
     * session and global watermarks.
     */
    globalLastReceivedId?: number;
    /** Ack/drain only the named session, not global notifications. */
    sessionOnly?: boolean;
    /** Ack/drain only session-less global notifications. */
    globalOnly?: boolean;
}
/** Return pending notifications after pruning only the scopes the client acked.
 *
 *  Session-scoped and global notifications have independent cursors. A TUI can
 *  switch from session A to session B after handling a high id in A; that high
 *  watermark must never prune B's lower, still-unseen ids. Global notifications
 *  are also tracked separately so a global dialog does not become a session
 *  watermark. Legacy callers that omit options keep the original single-cursor
 *  behavior.
 *
 *  Delivery is at-least-once (non-destructive return + prune-on-ack): a returned
 *  notification stays queued until an exact acknowledgement or a legacy cursor
 *  removes it, so a dropped WS socket re-delivers unhandled backlog on reconnect. */
export declare function drainNotifications(lastReceivedId?: number, sessionId?: string, options?: DrainNotificationsOptions): RpcNotification[];
/** Whether a TUI client is connected via a live notification socket.
 *  Now exact socket liveness (a registered WS sink), not a poll-drain timestamp.
 *
 *  Pass `sessionId` (preferred) to ask whether a TUI is connected FOR THAT
 *  SESSION — this is what producers (`/ctx-status`, `/ctx-recomp`, the upgrade
 *  reminder) must use to decide dialog-vs-message, so a TUI on a different
 *  session in the same process does not misroute their delivery. A modern
 *  session-less sink is global-only; a legacy sink retains broad compatibility.
 *  Omit `sessionId` only for callers with no session context. */
export declare function isTuiConnected(sessionId?: string): boolean;
//# sourceMappingURL=rpc-notifications.d.ts.map