/**
 *
 *
 * `conversation` counts user and assistant text, assistant thinking, and user and tool-result images.
 * `toolCall` counts tool invocation names, arguments, and result text.
 *
 * The result is persisted to `session_meta.{conversation_tokens,tool_call_tokens}`
 * so `/ctx-status` can render an accurate breakdown
 * bar that sums to the wire `inputTokens` (give or take provider
 * tokenizer drift).
 *
 *
 * The cache reuses a stable message ID only when every token-relevant field matches exactly.
 * The cache avoids repeated BPE work and serialization of fields the counter ignores.
 *
 * PiTextContent from user, assistant, or toolResult contributes to conversation.
 * PiThinkingContent from an assistant contributes its text and signature to conversation.
 * PiImageContent from user or toolResult contributes visual tokens to conversation.
 * PiToolCall from an assistant contributes its name and JSON arguments to toolCall.
 * PiToolResult content text contributes to toolCall.
 *
 * The counter excludes tool definitions sent in the request's separate `tools` field.
 */

import { estimateTokens } from "@magic-context/core/hooks/magic-context/read-session-formatting";

export interface PiMessageTokenCounts {
	conversation: number;
	toolCall: number;
}

export interface PiMessageTokenCacheEntry {
	fingerprint: readonly (string | null)[];
	counts: PiMessageTokenCounts;
}

export interface TokenizePiMessagesOptions {
	cache: Map<string, PiMessageTokenCacheEntry>;
	stableId: (message: object) => string | undefined;
	onTiming?: (
		phase: "cacheValidation" | "bpe" | "cachePrune",
		elapsedMs: number,
	) => void;
}

interface MaybePart {
	type?: string;
	text?: string;
	thinking?: string;
	thinkingSignature?: string;
	textSignature?: string;
	data?: string;
	mimeType?: string;
	name?: string;
	arguments?: unknown;
}

interface MaybeMessage {
	role?: string;
	content?: unknown;
	toolCallId?: string;
}

/**
 *
 * The fingerprint includes exact text, signatures, tool names, and canonical tool arguments; it omits fields the counter never reads.
 * Base64 image bytes are omitted because their token count is fixed.
 */
export function tokenizePiMessages(
	messages: unknown[],
	options?: TokenizePiMessagesOptions,
): PiMessageTokenCounts {
	let conversation = 0;
	let toolCall = 0;
	let cacheValidationMs = 0;
	let bpeMs = 0;
	const liveIds = options ? new Set<string>() : undefined;

	for (const raw of messages) {
		if (!raw || typeof raw !== "object") continue;
		const cacheValidationStart = options?.onTiming ? performance.now() : 0;
		const resolvedStableId = options?.stableId(raw);
		// Messages with custom prototypes or `toJSON` hooks bypass the cache because canonical serialization may differ.
		const stableId =
			resolvedStableId !== undefined && isTokenCacheSafeMessage(raw)
				? resolvedStableId
				: undefined;
		const fingerprint =
			stableId === undefined ? null : buildTokenCacheFingerprint(raw);
		if (stableId !== undefined && fingerprint !== null) {
			liveIds?.add(stableId);
			const cached = options?.cache.get(stableId);
			if (
				cached &&
				tokenCacheFingerprintsEqual(cached.fingerprint, fingerprint)
			) {
				conversation += cached.counts.conversation;
				toolCall += cached.counts.toolCall;
				cacheValidationMs += performance.now() - cacheValidationStart;
				continue;
			}
		}
		cacheValidationMs += performance.now() - cacheValidationStart;
		const bpeStart = options?.onTiming ? performance.now() : 0;
		const beforeConversation = conversation;
		const beforeToolCall = toolCall;
		try {
			const msg = raw as MaybeMessage;
			const content = msg.content;

			if (msg.role === "user" || msg.role === "assistant") {
				if (typeof content === "string") {
					conversation += estimateTokens(content);
					continue;
				}
				if (!Array.isArray(content)) continue;
				for (const part of content) {
					if (!part || typeof part !== "object") continue;
					const p = part as MaybePart;
					switch (p.type) {
						case "text":
							if (typeof p.text === "string")
								conversation += estimateTokens(p.text);
							if (typeof p.textSignature === "string")
								conversation += estimateTokens(p.textSignature);
							break;
						case "thinking":
							if (typeof p.thinking === "string")
								conversation += estimateTokens(p.thinking);
							if (typeof p.thinkingSignature === "string")
								conversation += estimateTokens(p.thinkingSignature);
							break;
						case "image":
							// Pi images use 1200 tokens because Pi exposes no dimensions for a size-based estimate.
							conversation += 1200;
							break;
						case "toolCall":
							if (typeof p.name === "string")
								toolCall += estimateTokens(p.name);
							if (p.arguments !== undefined) {
								const s =
									typeof p.arguments === "string"
										? p.arguments
										: safeJsonStringify(p.arguments);
								if (s) toolCall += estimateTokens(s);
							}
							break;
					}
				}
				continue;
			}

			// ToolResult content counts as tool-call tokens because it is the output body.
			if (msg.role === "toolResult") {
				if (typeof content === "string") {
					toolCall += estimateTokens(content);
					continue;
				}
				if (!Array.isArray(content)) continue;
				for (const part of content) {
					if (!part || typeof part !== "object") continue;
					const p = part as MaybePart;
					if (p.type === "text" && typeof p.text === "string") {
						toolCall += estimateTokens(p.text);
					} else if (p.type === "image") {
						toolCall += 1200;
					}
				}
			}
		} finally {
			bpeMs += performance.now() - bpeStart;
			if (stableId !== undefined && fingerprint !== null) {
				options?.cache.set(stableId, {
					fingerprint,
					counts: {
						conversation: conversation - beforeConversation,
						toolCall: toolCall - beforeToolCall,
					},
				});
			}
		}
	}

	if (options && liveIds) {
		const cachePruneStart = options.onTiming ? performance.now() : 0;
		for (const id of options.cache.keys()) {
			if (!liveIds.has(id)) options.cache.delete(id);
		}
		options.onTiming?.("cachePrune", performance.now() - cachePruneStart);
	}
	options?.onTiming?.("cacheValidation", cacheValidationMs);
	options?.onTiming?.("bpe", bpeMs);
	return { conversation, toolCall };
}

function buildTokenCacheFingerprint(value: object): readonly (string | null)[] {
	const message = value as MaybeMessage;
	const role = typeof message.role === "string" ? message.role : null;
	const fingerprint: (string | null)[] = [role];
	if (role !== "user" && role !== "assistant" && role !== "toolResult") {
		return fingerprint;
	}
	if (typeof message.content === "string") {
		fingerprint.push("string", message.content);
		return fingerprint;
	}
	if (!Array.isArray(message.content)) {
		fingerprint.push("non-array");
		return fingerprint;
	}
	fingerprint.push("parts");
	for (const rawPart of message.content) {
		if (!rawPart || typeof rawPart !== "object") continue;
		const part = rawPart as MaybePart;
		if (role === "toolResult") {
			if (part.type === "text" && typeof part.text === "string") {
				fingerprint.push("text", part.text);
			} else if (part.type === "image") {
				fingerprint.push("image");
			}
			continue;
		}
		switch (part.type) {
			case "text":
				fingerprint.push(
					"text",
					typeof part.text === "string" ? part.text : null,
					typeof part.textSignature === "string" ? part.textSignature : null,
				);
				break;
			case "thinking":
				fingerprint.push(
					"thinking",
					typeof part.thinking === "string" ? part.thinking : null,
					typeof part.thinkingSignature === "string"
						? part.thinkingSignature
						: null,
				);
				break;
			case "image":
				fingerprint.push("image");
				break;
			case "toolCall": {
				const argumentsJson =
					part.arguments === undefined
						? null
						: typeof part.arguments === "string"
							? part.arguments
							: safeJsonStringify(part.arguments);
				fingerprint.push(
					"toolCall",
					typeof part.name === "string" ? part.name : null,
					argumentsJson,
				);
				break;
			}
		}
	}
	return fingerprint;
}

function tokenCacheFingerprintsEqual(
	left: readonly (string | null)[],
	right: readonly (string | null)[],
): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index += 1) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

function isTokenCacheSafeMessage(value: object): boolean {
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	if ("toJSON" in value) return false;
	if (
		!isJsonVisibleDataProperty(value, "role") ||
		!isJsonVisibleDataProperty(value, "content")
	) {
		return false;
	}
	return isPlainJsonData((value as { content?: unknown }).content, new Set());
}

function isJsonVisibleDataProperty(value: object, key: string): boolean {
	if (!(key in value)) return true;
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	return (
		descriptor !== undefined &&
		descriptor.enumerable === true &&
		"value" in descriptor
	);
}

function isPlainJsonData(value: unknown, seen: Set<object>): boolean {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean" ||
		typeof value === "undefined"
	) {
		return true;
	}
	if (typeof value !== "object" || seen.has(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	if (
		!Array.isArray(value) &&
		prototype !== Object.prototype &&
		prototype !== null
	) {
		return false;
	}
	if ("toJSON" in value) return false;
	seen.add(value);
	try {
		for (const key of Reflect.ownKeys(value)) {
			if (Array.isArray(value) && key === "length") continue;
			if (typeof key !== "string") return false;
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor?.enumerable || !("value" in descriptor)) {
				return false;
			}
			if (!isPlainJsonData(descriptor.value, seen)) return false;
		}
		return true;
	} finally {
		seen.delete(value);
	}
}

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return "";
	}
}
