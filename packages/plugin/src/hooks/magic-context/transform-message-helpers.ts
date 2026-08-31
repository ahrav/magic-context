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

export function appendReminderToLatestUserMessage(
    messages: MessageLike[],
    reminder: string,
): string | null {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (!isMeaningfulUserMessage(message)) {
            continue;
        }

        appendReminderToUserMessage(message, reminder);
        return typeof message.info.id === "string" ? message.info.id : null;
    }

    return null;
}

export function appendReminderToUserMessageById(
    messages: MessageLike[],
    messageId: string,
    reminder: string,
): boolean {
    for (const message of messages) {
        if (message.info.id !== messageId || !isMeaningfulUserMessage(message)) {
            continue;
        }

        appendReminderToUserMessage(message, reminder);
        return true;
    }

    return false;
}

export function countMessagesSinceLastUser(messages: MessageLike[]): number {
    let messagesSinceLastUser = 0;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (isMeaningfulUserMessage(messages[i])) break;
        messagesSinceLastUser += 1;
    }
    return messagesSinceLastUser;
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
        if (hasToolPartWithCallId(message, part.callID)) {
            return message.info.id;
        }
        message.parts.push(part);
        return message.info.id;
    }
    return null;
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
        if (hasToolPartWithCallId(message, part.callID)) return true;
        message.parts.push(part);
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
