export type MagicContextEventType = "session.created" | "session.error" | "message.updated" | "message.removed" | "session.compacted" | "session.deleted";
export type MagicContextEvent = {
    type: MagicContextEventType;
    properties?: unknown;
};
export interface SessionCreatedInfo {
    id: string;
    parentID: string;
    providerID?: string;
    modelID?: string;
    /**
     * Session title set at create time. Magic Context's own hidden children
     * (historian/dreamer/sidekick/memory-migration) all use `magic-context-*`
     * titles, so this is the signal used to fully exempt them from the
     * transform + system-prompt injection pipeline.
     */
    title?: string;
}
export interface MessageUpdatedAssistantInfo {
    role: "assistant";
    finish?: string;
    sessionID: string;
    /** OpenCode assistant message id. Undefined only when the event payload
     *  doesn't include one (older SDK versions or malformed events). */
    messageID?: string;
    completedAt?: number;
    providerID?: string;
    modelID?: string;
    tokens?: {
        input?: number;
        cache?: {
            read?: number;
            write?: number;
        };
    };
    /** Error attached to the assistant message, if any. OpenCode attaches
     *  context-overflow errors here in addition to emitting session.error. */
    error?: unknown;
}
export interface MessageUpdatedInfo {
    role: "user" | "assistant" | string;
    sessionID: string;
    messageID?: string;
    finish?: string;
    completedAt?: number;
}
export interface SessionErrorInfo {
    sessionID: string;
    error: unknown;
}
export interface MessageRemovedInfo {
    sessionID: string;
    messageID: string;
}
export declare function getSessionProperties(properties: unknown): {
    info?: unknown;
    sessionID?: string;
} | undefined;
export declare function getSessionCreatedInfo(properties: unknown): SessionCreatedInfo | null;
export declare function getMessageUpdatedAssistantInfo(properties: unknown): MessageUpdatedAssistantInfo | null;
export declare function getMessageUpdatedInfo(properties: unknown): MessageUpdatedInfo | null;
/**
 * Extract `session.error` event payload. The event carries `{ sessionID, error }`
 * at the top level (no `info` wrapper). We intentionally keep `error` as
 * `unknown` — the plugin does not depend on OpenCode's NamedError shape, the
 * overflow detector accepts strings, Errors, or objects with `message`.
 */
export declare function getSessionErrorInfo(properties: unknown): SessionErrorInfo | null;
export declare function getMessageRemovedInfo(properties: unknown): MessageRemovedInfo | null;
//# sourceMappingURL=event-payloads.d.ts.map