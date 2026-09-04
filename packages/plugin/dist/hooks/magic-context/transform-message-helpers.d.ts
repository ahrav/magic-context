import type { MessageLike } from "./transform-operations";
export declare function findSessionId(messages: MessageLike[]): string | null;
export declare function findLastUserMessageId(messages: MessageLike[]): string | null;
export declare function appendReminderToLatestUserMessage(messages: MessageLike[], reminder: string): string | null;
export declare function appendReminderToUserMessageById(messages: MessageLike[], messageId: string, reminder: string): boolean;
export declare function countMessagesSinceLastUser(messages: MessageLike[]): number;
/**
 * Inject a tool part into the latest replayable assistant message that has an ID.
 *
 * Idempotent on `callID` — if a part with the same `callID` already exists,
 * this is a no-op so defer-pass replays produce byte-identical output.
 *
 * Returns the message ID where the part landed, or `null` if no eligible
 * assistant message exists in the visible window. Assistant messages with an
 * OpenCode `error` are skipped because provider serializers can omit failed or
 * aborted assistants from the wire; anchoring a synthetic tool call there would
 * make its replay disappear on subsequent passes.
 */
export declare function injectToolPartIntoLatestAssistant(messages: MessageLike[], part: {
    callID: string;
}): string | null;
/**
 * Inject a tool part into the replayable assistant message with the given ID.
 *
 * Idempotent on `callID`. Returns `true` if the message exists and the part
 * is present after the call, `false` if the anchor message is not in the
 * visible window.
 */
export declare function injectToolPartIntoAssistantById(messages: MessageLike[], messageId: string, part: {
    callID: string;
}): boolean;
//# sourceMappingURL=transform-message-helpers.d.ts.map