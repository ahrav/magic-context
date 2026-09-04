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
/** Open the persistent notification socket. Reconnects on its own after a drop. */
export declare function startNotificationSocket(options: NotificationSocketOptions): void;
/** Close the socket and release all state owned by this TUI initialization. */
export declare function stopNotificationSocket(): void;
export declare function _resetNotificationSocketStateForTesting(): void;
export {};
//# sourceMappingURL=notification-socket.d.ts.map