/**
 * `replayStrippedInlineThinking`.
 *
 *
 * Behavior:
 * Inline thinking markup is removed for messages through the cleared-reasoning watermark.
 *
 */

import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import type { TagTarget } from "@magic-context/core/hooks/magic-context/tag-messages";

type PiTextContent = { type: "text"; text: string };
type PiThinkingContent = {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
	redacted?: boolean;
};
type PiToolCall = {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
};
type PiAssistantContent = PiTextContent | PiThinkingContent | PiToolCall;
type PiAssistantMessage = {
	role: "assistant";
	content: PiAssistantContent[];
	timestamp?: number;
};

const INLINE_THINKING_PATTERNS = [
	/<thinking>[\s\S]*?<\/thinking>\s*/gi,
	/<think>[\s\S]*?<\/think>\s*/gi,
] as const;

// Pi's Amazon Bedrock serializer omits empty thinking blocks.
// Omitting empty thinking blocks prevents stale content/signature pairs from reaching providers.
const CLEARED = "";

function stripInlineThinkingMarkup(text: string): string {
	let cleaned = text;
	for (const pattern of INLINE_THINKING_PATTERNS) {
		cleaned = cleaned.replace(pattern, "");
	}
	return cleaned;
}

/**
 *
 * Thinking parts are absent from `targets`.
 * Reasoning replay uses each message's maximum tag.
 */
export function buildMessageIdToMaxTag(
	targets: Map<number, TagTarget>,
): Map<string, number> {
	const out = new Map<string, number>();
	for (const [tagNumber, target] of targets) {
		const id = target.message?.info?.id;
		if (typeof id !== "string" || id.length === 0) continue;
		const prev = out.get(id) ?? 0;
		if (tagNumber > prev) out.set(id, tagNumber);
	}
	return out;
}

/**
 *
 */
export function clearOldReasoningPi(args: {
	messages: unknown[];
	messageIdToMaxTag: Map<string, number>;
	clearReasoningAge: number;
	piMessageStableId: (msg: unknown, index: number) => string | undefined;
}): { cleared: number; newWatermark: number } {
	const { messages, messageIdToMaxTag, clearReasoningAge, piMessageStableId } =
		args;

	let maxTag = 0;
	for (const t of messageIdToMaxTag.values()) if (t > maxTag) maxTag = t;
	if (maxTag === 0) return { cleared: 0, newWatermark: 0 };

	const ageCutoff = maxTag - clearReasoningAge;
	if (ageCutoff <= 0) return { cleared: 0, newWatermark: 0 };

	let cleared = 0;
	let newWatermark = 0;

	for (let i = 0; i < messages.length; i++) {
		const raw = messages[i];
		if (!raw || typeof raw !== "object") continue;
		const msg = raw as PiAssistantMessage;
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

		const id = piMessageStableId(raw, i);
		if (!id) continue;
		const msgTag = messageIdToMaxTag.get(id) ?? 0;
		if (msgTag === 0 || msgTag > ageCutoff) continue;

		for (const part of msg.content) {
			if (
				part &&
				typeof part === "object" &&
				(part as { type?: unknown }).type === "thinking"
			) {
				const tp = part as PiThinkingContent;
				// The loop preserves redacted thinking blocks because serializers retain them even when empty.
				// Redacted blocks contain no plaintext, so clearing them saves no tokens.
				// Keeping redacted blocks verbatim preserves byte stability across passes.
				if (tp.redacted) continue;
				// Clearing eligible thinking blocks also removes signatures for the original thinking text.
				// working-array state.
				if (tp.thinking !== CLEARED || tp.thinkingSignature !== undefined) {
					tp.thinking = CLEARED;
					tp.thinkingSignature = undefined;
					cleared++;
				}
			}
		}

		if (cleared > 0 && msgTag > newWatermark) newWatermark = msgTag;
	}

	return { cleared, newWatermark };
}

/**
 */
export function stripInlineThinkingPi(args: {
	messages: unknown[];
	messageIdToMaxTag: Map<string, number>;
	clearReasoningAge: number;
	piMessageStableId: (msg: unknown, index: number) => string | undefined;
}): { stripped: number; newWatermark: number } {
	const { messages, messageIdToMaxTag, clearReasoningAge, piMessageStableId } =
		args;

	let maxTag = 0;
	for (const t of messageIdToMaxTag.values()) if (t > maxTag) maxTag = t;
	if (maxTag === 0) return { stripped: 0, newWatermark: 0 };

	const ageCutoff = maxTag - clearReasoningAge;
	if (ageCutoff <= 0) return { stripped: 0, newWatermark: 0 };

	let stripped = 0;
	let newWatermark = 0;

	for (let i = 0; i < messages.length; i++) {
		const raw = messages[i];
		if (!raw || typeof raw !== "object") continue;
		const msg = raw as PiAssistantMessage;
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

		const id = piMessageStableId(raw, i);
		if (!id) continue;
		const msgTag = messageIdToMaxTag.get(id) ?? 0;
		if (msgTag === 0 || msgTag > ageCutoff) continue;

		let strippedThisMessage = false;
		for (const part of msg.content) {
			if (
				part &&
				typeof part === "object" &&
				(part as { type?: unknown }).type === "text"
			) {
				const tp = part as PiTextContent;
				if (typeof tp.text !== "string") continue;
				const cleaned = stripInlineThinkingMarkup(tp.text);
				if (cleaned !== tp.text) {
					tp.text = cleaned;
					stripped++;
					strippedThisMessage = true;
				}
			}
		}

		if (strippedThisMessage && msgTag > newWatermark) newWatermark = msgTag;
	}

	return { stripped, newWatermark };
}

/**
 * across passes.
 */
export function replayClearedReasoningPi(args: {
	db: ContextDatabase;
	sessionId: string;
	messages: unknown[];
	messageIdToMaxTag: Map<string, number>;
	piMessageStableId: (msg: unknown, index: number) => string | undefined;
}): number {
	const { db, sessionId, messages, messageIdToMaxTag, piMessageStableId } =
		args;

	const meta = getOrCreateSessionMeta(db, sessionId);
	const watermark = meta.clearedReasoningThroughTag ?? 0;
	if (watermark <= 0) return 0;

	let cleared = 0;
	for (let i = 0; i < messages.length; i++) {
		const raw = messages[i];
		if (!raw || typeof raw !== "object") continue;
		const msg = raw as PiAssistantMessage;
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

		const id = piMessageStableId(raw, i);
		if (!id) continue;
		const msgTag = messageIdToMaxTag.get(id) ?? 0;
		if (msgTag === 0 || msgTag > watermark) continue;

		for (const part of msg.content) {
			if (
				part &&
				typeof part === "object" &&
				(part as { type?: unknown }).type === "thinking"
			) {
				const tp = part as PiThinkingContent;
				if (tp.redacted) continue;
				if (tp.thinking !== CLEARED || tp.thinkingSignature !== undefined) {
					tp.thinking = CLEARED;
					tp.thinkingSignature = undefined;
					cleared++;
				}
			}
		}
	}
	return cleared;
}

/**
 * This function replays inline `<thinking>...</thinking>` stripping on every pass.
 */
export function replayStrippedInlineThinkingPi(args: {
	db: ContextDatabase;
	sessionId: string;
	messages: unknown[];
	messageIdToMaxTag: Map<string, number>;
	piMessageStableId: (msg: unknown, index: number) => string | undefined;
}): number {
	const { db, sessionId, messages, messageIdToMaxTag, piMessageStableId } =
		args;

	const meta = getOrCreateSessionMeta(db, sessionId);
	const watermark = meta.clearedReasoningThroughTag ?? 0;
	if (watermark <= 0) return 0;

	let stripped = 0;
	for (let i = 0; i < messages.length; i++) {
		const raw = messages[i];
		if (!raw || typeof raw !== "object") continue;
		const msg = raw as PiAssistantMessage;
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

		const id = piMessageStableId(raw, i);
		if (!id) continue;
		const msgTag = messageIdToMaxTag.get(id) ?? 0;
		if (msgTag === 0 || msgTag > watermark) continue;

		for (const part of msg.content) {
			if (
				part &&
				typeof part === "object" &&
				(part as { type?: unknown }).type === "text"
			) {
				const tp = part as PiTextContent;
				if (typeof tp.text !== "string") continue;
				const cleaned = stripInlineThinkingMarkup(tp.text);
				if (cleaned !== tp.text) {
					tp.text = cleaned;
					stripped++;
				}
			}
		}
	}
	return stripped;
}

/**
 * Index-based fallback IDs are for tests only.
 *
 * Production callers must use `resolvePiStableId`.
 * Index-based IDs can orphan persisted state when the visible array shifts.
 */
export function piMessageStableId(
	msg: unknown,
	index: number,
): string | undefined {
	if (!msg || typeof msg !== "object") return undefined;
	const m = msg as { role?: string; timestamp?: number };
	const role = m.role ?? "unknown";
	if (typeof m.timestamp !== "number") return `pi-msg-${index}-${role}`;
	return `pi-msg-${index}-${m.timestamp}-${role}`;
}
