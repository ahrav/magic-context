import { hasMeaningfulUserText } from "./read-session-formatting";
import { isTextPart } from "./tag-part-guards";
import type { MessageLike } from "./transform-operations";

/**
 */
function isMeaningfulUserMessage(msg: MessageLike): boolean {
    return msg.info.role === "user" && hasMeaningfulUserText(msg.parts as unknown[]);
}

export function findSessionId(messages: MessageLike[]): string | null {
    // Session ID is valid on any user message, including ignored ones
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.info.role === "user" && typeof message.info.sessionID === "string") {
            return message.info.sessionID;
        }
    }

    return null;
}

export function findLastUserMessageId(messages: MessageLike[]): string | null {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (isMeaningfulUserMessage(message) && typeof message.info.id === "string") {
            return message.info.id;
        }
    }

    return null;
}

/**
 * The meaningful user message that anchors a reminder: the latest one when
 * `messageId` is omitted, else the message with that exact id.
 */
function findMeaningfulUserAnchor(messages: MessageLike[], messageId?: string): MessageLike | null {
    if (messageId === undefined) {
        for (let index = messages.length - 1; index >= 0; index -= 1) {
            const message = messages[index];
            if (isMeaningfulUserMessage(message)) return message;
        }
        return null;
    }
    for (const message of messages) {
        if (message.info.id === messageId && isMeaningfulUserMessage(message)) {
            return message;
        }
    }
    return null;
}

export function appendReminderToLatestUserMessage(
    messages: MessageLike[],
    reminder: string,
): string | null {
    const message = findMeaningfulUserAnchor(messages);
    if (!message) return null;
    appendReminderToUserMessage(message, reminder);
    return typeof message.info.id === "string" ? message.info.id : null;
}

export function appendReminderToUserMessageById(
    messages: MessageLike[],
    messageId: string,
    reminder: string,
): boolean {
    const message = findMeaningfulUserAnchor(messages, messageId);
    if (!message) return false;
    appendReminderToUserMessage(message, reminder);
    return true;
}

/**
 *
 *
 */
export function injectToolPartIntoLatestAssistant(
    messages: MessageLike[],
    part: { callID: string },
): string | null {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.info.role !== "assistant") continue;
        if (typeof message.info.id !== "string") continue;
        if (!isReplayableAssistantAnchor(message)) continue;
        injectToolPartIntoAnchor(message, part);
        return message.info.id;
    }
    return null;
}

/** Idempotent on `callID`: pushes the part unless it is already present. */
function injectToolPartIntoAnchor(message: MessageLike, part: { callID: string }): void {
    if (hasToolPartWithCallId(message, part.callID)) {
        // Already present — idempotent no-op for cache stability.
        return;
    }
    message.parts.push(part);
}

/**
 *
 * visible window.
 */
export function injectToolPartIntoAssistantById(
    messages: MessageLike[],
    messageId: string,
    part: { callID: string },
): boolean {
    for (const message of messages) {
        if (message.info.id !== messageId) continue;
        if (message.info.role !== "assistant") continue;
        if (!isReplayableAssistantAnchor(message)) return false;
        injectToolPartIntoAnchor(message, part);
        return true;
    }
    return false;
}

function hasToolPartWithCallId(message: MessageLike, callId: string): boolean {
    for (const part of message.parts) {
        if (part === null || typeof part !== "object") continue;
        const p = part as { type?: unknown; callID?: unknown };
        if (p.type !== "tool") continue;
        if (p.callID === callId) return true;
    }
    return false;
}

function isReplayableAssistantAnchor(message: MessageLike): boolean {
    if (message.info.summary === true) return false;
    return message.info.error === undefined || message.info.error === null;
}

function appendReminderToUserMessage(message: MessageLike, reminder: string): void {
    for (const part of message.parts) {
        if (!isTextPart(part)) {
            continue;
        }

        if (!part.text.includes(reminder)) {
            part.text += reminder;
        }
        return;
    }

    message.parts.unshift({ type: "text", text: reminder.trimStart() });
}
