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
export declare const MAX_QUEUED_IGNORED_NOTIFICATIONS = 16;
/** Test seams for the process-local queue; production uses the read-only OpenCode DB signal. */
export declare const __ignoredNotificationTest: {
    pendingTexts(sessionId: string): string[];
    reset(): void;
    setMidTurnDetector(detector: (sessionId: string) => boolean): void;
};
export declare function sendIgnoredMessage(client: unknown, sessionId: string, text: string, params: NotificationParams, forcePersist?: boolean): Promise<NotificationDeliveryDisposition>;
/**
 * Flush queued status lines after an event that may have made the session idle.
 * The event hook and tool.execute.after both call this; the same DB-backed gate
 * remains authoritative, so a non-idle event is harmless.
 */
export declare function flushIgnoredMessages(sessionId: string): Promise<void>;
export declare function clearIgnoredMessages(sessionId: string): void;
/**
 * Send a real user prompt that will be processed by the model (not ignored).
 * Used by /ctx-aug to inject the augmented prompt after sidekick completes.
 */
export declare function sendUserPrompt(client: unknown, sessionId: string, text: string): Promise<void>;
//# sourceMappingURL=send-session-notification.d.ts.map