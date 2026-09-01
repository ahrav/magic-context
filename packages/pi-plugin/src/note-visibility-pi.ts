/**
 *
 *
 *
 */

const NOTE_TOOL_NAME = "ctx_note";
const READ_ACTION = "read";
const WHOLE_MESSAGE_PLACEHOLDER_TEXT = "[dropped]";

type PiToolCall = {
	type: "toolCall";
	id?: unknown;
	name?: unknown;
	arguments?: unknown;
};
type PiAssistantMessage = {
	role: "assistant";
	content?: unknown;
};

/**
 */
export function hasVisibleNoteReadCallPi(messages: unknown[]): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const raw = messages[i];
		if (!raw || typeof raw !== "object") continue;
		const msg = raw as PiAssistantMessage;
		if (msg.role !== "assistant") continue;
		if (!Array.isArray(msg.content)) continue;
		for (const part of msg.content as unknown[]) {
			if (isSentinelPart(part)) continue;
			if (!part || typeof part !== "object") continue;
			const p = part as PiToolCall;
			if (p.type !== "toolCall") continue;
			if (p.name !== NOTE_TOOL_NAME) continue;
			const args = p.arguments;
			if (!args || typeof args !== "object") continue;
			const action = (args as { action?: unknown }).action;
			if (action === READ_ACTION) return true;
		}
	}
	return false;
}

function isSentinelPart(part: unknown): boolean {
	if (!part || typeof part !== "object") return false;
	const p = part as { type?: unknown; text?: unknown };
	return (
		p.type === "text" &&
		typeof p.text === "string" &&
		(p.text === "" || p.text === WHOLE_MESSAGE_PLACEHOLDER_TEXT)
	);
}
