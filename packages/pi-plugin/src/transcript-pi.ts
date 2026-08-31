/**
 *
 * Pi delivers messages via `pi.on("context", ...)` as `AgentMessage[]`
 * Pi context hooks receive `{ messages: AgentMessage[] }`.
 * Pi handlers return rebuilt message arrays instead of mutating `Part.text` in place.
 * `commit()` rebuilds dirty messages because Pi handlers must return a message array rather than mutate the input.
 *
 *
 * The transform pipeline expects tool results in user messages because OpenCode folds them into the next user message.
 *
 * The adapter exposes `toolResult` messages immediately before a user message as that user's `kind: "tool_result"` parts and tracks their source positions for `commit()`.
 *
 * If a trailing run of `toolResult` messages has no following user message, the adapter exposes it as a synthetic `user` message with ID `synth-user-<toolResultEntryId>` so tags remain stable across transform passes.
 *
 * The adapter only normalizes tool-result placement; the transform pipeline handles compaction markers, ordinals, and session-fact rendering.
 *
 *
 * For a `tool_result` part surfaced into a user message, the source location records the source `ToolResultMessage` index and content index.
 * `commit()` returns the final `AgentMessage[]` to the `pi.on("context", ...)` handler.
 *
 *
 * Two reasons:
 *
 *
 *      unchanged ones.
 *
 */

import { estimateTokens } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import { isRecord } from "@magic-context/core/shared/record-type-guard";
import type {
	Transcript,
	TranscriptMessage,
	TranscriptPart,
	TranscriptPartKind,
} from "@magic-context/core/shared/transcript";
import { resolvePiStableId, SYNTH_USER_ID_PREFIX } from "./read-session-pi";

// Local declarations prevent the plugin build from depending on pi-ai's exact version.
// Importing `@earendil-works/pi-ai` would couple the plugin to that package's exact version.
// The shape MUST stay structurally compatible with pi-ai's exports.

type PiTextContent = { type: "text"; text: string; textSignature?: string };
type PiThinkingContent = {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
	redacted?: boolean;
};
type PiImageContent = { type: "image"; data: string; mimeType: string };
type PiToolCall = {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	thoughtSignature?: string;
};

type PiUserMessage = {
	role: "user";
	content: string | (PiTextContent | PiImageContent)[];
	timestamp: number;
};

type PiAssistantMessage = {
	role: "assistant";
	content: (PiTextContent | PiThinkingContent | PiToolCall)[];
	api: string;
	provider: string;
	model: string;
	responseId?: string;
	usage: unknown;
	stopReason: string;
	errorMessage?: string;
	timestamp: number;
};

type PiToolResultMessage = {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (PiTextContent | PiImageContent)[];
	details?: unknown;
	isError: boolean;
	timestamp: number;
};

type PiAgentMessage = PiUserMessage | PiAssistantMessage | PiToolResultMessage;

/**
 * The adapter folds tool results into user messages before exposing the transcript view.
 *
 * The adapter accepts `unknown[]` because the package's `AgentMessage` type embeds `CustomAgentMessages`.
 * Augmented `CustomAgentMessages` prevent reliable generic inference.
 * Messages with unrecognized roles follow the opaque path, which reads no message fields.
 * structural typing.
 */
export function createPiTranscript(
	source: unknown[],
	sessionId: string | undefined,
	entryIds?: readonly (string | undefined)[],
): Transcript & {
	/**
	 * The `pi.on("context", ...)` callback receives `{ messages }`.
	 * `getOutputMessages()` returns the original array when no mutations occurred to preserve its identity.
	 */
	getOutputMessages(): unknown[];
	/**
	 * Mutator methods change `working`; `commit()` rebuilds dirty messages in its returned array.
	 *
	 * Mutator methods change `working`; `commit()` rebuilds dirty messages in its returned array.
	 * Mutator methods change `working`; `commit()` rebuilds dirty messages in its returned array.
	 * Mutator methods change `working`; `commit()` rebuilds dirty messages in its returned array.
	 * Mutator methods change `working`; `commit()` rebuilds dirty messages in its returned array.
	 * Mutator methods change `working`; `commit()` rebuilds dirty messages in its returned array.
	 * Mutator methods change `working`; `commit()` rebuilds dirty messages in its returned array.
	 * Mutator methods change `working`; `commit()` rebuilds dirty messages in its returned array.
	 * Mutator methods change `working`; `commit()` rebuilds dirty messages in its returned array.
	 * Mutator methods change `working`; `commit()` rebuilds dirty messages in its returned array.
	 */
	getWorkingMessages(): PiAgentMessage[];
} {
	const working = source.slice() as unknown as PiAgentMessage[];
	const dirtyMessages = new Set<number>();

	// Consecutive `toolResult` messages become `tool_result` transcript parts on the immediately following user message.
	// The view tracks source indices so `commit()` can write mutations back.
	const transcriptMessages: TranscriptMessage[] = buildTranscriptView(
		working,
		sessionId,
		(messageIndex) => {
			dirtyMessages.add(messageIndex);
		},
		entryIds,
	);

	let committed = false;

	return {
		messages: transcriptMessages,
		harness: "pi",
		commit(): void {
			if (committed) return;
			committed = true;
			// mutations.
			//
			// Without copying dirty entries, `source[i]` retains its pre-mutation shape.
			// Part proxies mutate `working[i]`, not `source[i]`.
			// Downstream callers that read `source` would see stale content.
			//
			for (const idx of dirtyMessages) {
				if (idx < source.length && idx < working.length) {
					(source as unknown as PiAgentMessage[])[idx] = working[idx];
				}
			}
		},
		getOutputMessages(): unknown[] {
			// After the first commit(), `source` contains the dirty entries present at that commit.
			// Returns `source`, preserving the caller's array identity.
			return source;
		},
		getWorkingMessages(): PiAgentMessage[] {
			return working;
		},
	};
}

/**
 *
 * Groups each contiguous `toolResult` run with the following user message, or emits a synthetic user message when no user follows.
 * Lazy part getters let part proxies write back to `working`.
 */
function buildTranscriptView(
	working: PiAgentMessage[],
	sessionId: string | undefined,
	markDirty: (messageIndex: number) => void,
	entryIds: readonly (string | undefined)[] | undefined,
): TranscriptMessage[] {
	const result: TranscriptMessage[] = [];

	let i = 0;
	while (i < working.length) {
		const msg = working[i];
		if (msg === undefined) {
			i += 1;
			continue;
		}

		if (msg.role === "toolResult") {
			const toolResultRun: { msg: PiToolResultMessage; index: number }[] = [];
			while (i < working.length) {
				const candidate = working[i];
				if (candidate === undefined || candidate.role !== "toolResult") break;
				toolResultRun.push({ msg: candidate, index: i });
				i += 1;
			}

			const next = i < working.length ? working[i] : undefined;
			if (next?.role === "user") {
				result.push(
					createUserTranscriptMessage(
						working,
						i,
						sessionId,
						toolResultRun,
						markDirty,
						entryIds,
					),
				);
				i += 1;
			} else {
				result.push(
					createSyntheticToolResultUserMessage(
						working,
						sessionId,
						toolResultRun,
						markDirty,
						entryIds,
					),
				);
			}
			continue;
		}

		if (msg.role === "user") {
			result.push(
				createUserTranscriptMessage(
					working,
					i,
					sessionId,
					[],
					markDirty,
					entryIds,
				),
			);
			i += 1;
			continue;
		}

		if (msg.role === "assistant") {
			result.push(
				createAssistantTranscriptMessage(
					working,
					i,
					sessionId,
					markDirty,
					entryIds,
				),
			);
			i += 1;
			continue;
		}

		// Unknown roles remain opaque to support future Pi message kinds.
		result.push(
			createOpaqueTranscriptMessage(working, i, sessionId, markDirty, entryIds),
		);
		i += 1;
	}

	return result;
}

/**
 */
function createUserTranscriptMessage(
	working: PiAgentMessage[],
	index: number,
	sessionId: string | undefined,
	foldedToolResults: { msg: PiToolResultMessage; index: number }[],
	markDirty: (messageIndex: number) => void,
	entryIds: readonly (string | undefined)[] | undefined,
): TranscriptMessage {
	const userMsg = working[index] as PiUserMessage;

	// String content is exposed as one text part at index 0.
	// String content becomes a single `TextContent` with a locator at `partIndex` 0.
	const isStringContent = typeof userMsg.content === "string";

	return {
		info: {
			id: extractStableId(userMsg, index, entryIds),
			role: "user",
			sessionId,
		},
		get parts(): TranscriptPart[] {
			const parts: TranscriptPart[] = [];

			// Folded tool results precede user content to preserve conversation order.
			for (const { index: toolResultIndex } of foldedToolResults) {
				const toolMsg = working[toolResultIndex] as PiToolResultMessage;
				toolMsg.content.forEach((_, partIndex) => {
					parts.push(
						createPiToolResultPart(
							working,
							toolResultIndex,
							partIndex,
							markDirty,
						),
					);
				});
			}

			if (isStringContent) {
				parts.push(createPiUserStringPart(working, index, markDirty));
			} else if (Array.isArray(userMsg.content)) {
				userMsg.content.forEach((_, partIndex) => {
					parts.push(
						createPiUserArrayPart(working, index, partIndex, markDirty),
					);
				});
			}

			return parts;
		},
	};
}

/**
 * When available, synthetic tail message IDs use the `synth-user-` prefix and the first underlying `toolResult` entry ID.
 */
function createSyntheticToolResultUserMessage(
	working: PiAgentMessage[],
	sessionId: string | undefined,
	toolResultRun: { msg: PiToolResultMessage; index: number }[],
	markDirty: (messageIndex: number) => void,
	entryIds: readonly (string | undefined)[] | undefined,
): TranscriptMessage {
	return {
		info: {
			id: createSyntheticToolResultUserId(toolResultRun, entryIds),
			role: "user",
			sessionId,
		},
		get parts(): TranscriptPart[] {
			const parts: TranscriptPart[] = [];
			for (const { index: toolResultIndex } of toolResultRun) {
				const toolMsg = working[toolResultIndex] as PiToolResultMessage;
				toolMsg.content.forEach((_, partIndex) => {
					parts.push(
						createPiToolResultPart(
							working,
							toolResultIndex,
							partIndex,
							markDirty,
						),
					);
				});
			}
			return parts;
		},
	};
}

function createSyntheticToolResultUserId(
	toolResultRun: { msg: PiToolResultMessage; index: number }[],
	entryIds: readonly (string | undefined)[] | undefined,
): string | undefined {
	const first = toolResultRun[0];
	if (first === undefined) return undefined;
	const stableId = extractStableId(first.msg, first.index, entryIds);
	return stableId === undefined
		? undefined
		: `${SYNTH_USER_ID_PREFIX}${stableId}`;
}

function createAssistantTranscriptMessage(
	working: PiAgentMessage[],
	index: number,
	sessionId: string | undefined,
	markDirty: (messageIndex: number) => void,
	entryIds: readonly (string | undefined)[] | undefined,
): TranscriptMessage {
	const msg = working[index] as PiAssistantMessage;
	return {
		info: {
			id: extractStableId(msg, index, entryIds),
			role: "assistant",
			sessionId,
		},
		get parts(): TranscriptPart[] {
			return msg.content.map((_, partIndex) =>
				createPiAssistantPart(working, index, partIndex, markDirty),
			);
		},
	};
}

function createOpaqueTranscriptMessage(
	working: PiAgentMessage[],
	index: number,
	sessionId: string | undefined,
	_markDirty: (messageIndex: number) => void,
	entryIds: readonly (string | undefined)[] | undefined,
): TranscriptMessage {
	const msg = working[index];
	return {
		info: {
			id: extractStableId(msg, index, entryIds),
			role:
				typeof (msg as { role?: string })?.role === "string"
					? (msg as { role: string }).role
					: "unknown",
			sessionId,
		},
		// Unknown roles remain opaque to support future Pi message kinds.
		get parts(): TranscriptPart[] {
			return [];
		},
	};
}

/* ------------------------------------------------------------------ */
/* Part proxies                                                       */
/* ------------------------------------------------------------------ */

function createPiUserStringPart(
	working: PiAgentMessage[],
	messageIndex: number,
	markDirty: (messageIndex: number) => void,
): TranscriptPart {
	return {
		kind: "text",
		// Text ordinals disambiguate multiple text parts with the same parent message ID.
		id: undefined,
		getText(): string | undefined {
			const msg = working[messageIndex] as PiUserMessage | undefined;
			if (msg === undefined) return undefined;
			return typeof msg.content === "string" ? msg.content : undefined;
		},
		setText(newText: string): boolean {
			const msg = working[messageIndex] as PiUserMessage | undefined;
			if (msg === undefined || typeof msg.content !== "string") return false;
			if (msg.content === newText) return false;
			working[messageIndex] = { ...msg, content: newText };
			markDirty(messageIndex);
			return true;
		},
		setToolOutput(): boolean {
			throw new Error("setToolOutput on user-text part");
		},
		getToolMetadata(): {
			toolName: undefined;
			inputByteSize: 0;
			inputTokenCount: 0;
		} {
			return { toolName: undefined, inputByteSize: 0, inputTokenCount: 0 };
		},
		replaceWithSentinel(sentinelText: string): boolean {
			const msg = working[messageIndex] as PiUserMessage | undefined;
			if (msg === undefined) return false;
			working[messageIndex] = { ...msg, content: sentinelText };
			markDirty(messageIndex);
			return true;
		},
	};
}

function createPiUserArrayPart(
	working: PiAgentMessage[],
	messageIndex: number,
	partIndex: number,
	markDirty: (messageIndex: number) => void,
): TranscriptPart {
	const msg = working[messageIndex] as PiUserMessage;
	const part = Array.isArray(msg.content) ? msg.content[partIndex] : undefined;
	const kind: TranscriptPartKind = classifyContent(part);
	return {
		kind,
		// `tagTranscript` keys user text by the stable parent message ID and text ordinal.
		id: undefined,
		getText(): string | undefined {
			const current = (working[messageIndex] as PiUserMessage).content;
			if (!Array.isArray(current)) return undefined;
			const p = current[partIndex];
			if (p?.type === "text") return p.text;
			return undefined;
		},
		setText(newText: string): boolean {
			const current = (working[messageIndex] as PiUserMessage).content;
			if (!Array.isArray(current)) return false;
			const p = current[partIndex];
			if (p?.type !== "text") return false;
			if (p.text === newText) return false;
			const newContent = current.slice();
			newContent[partIndex] = { ...p, text: newText };
			working[messageIndex] = {
				...(working[messageIndex] as PiUserMessage),
				content: newContent,
			};
			markDirty(messageIndex);
			return true;
		},
		setToolOutput(): boolean {
			throw new Error("setToolOutput on non-tool-result part");
		},
		getToolMetadata(): {
			toolName: undefined;
			inputByteSize: 0;
			inputTokenCount: 0;
		} {
			return { toolName: undefined, inputByteSize: 0, inputTokenCount: 0 };
		},
		replaceWithSentinel(sentinelText: string): boolean {
			const current = (working[messageIndex] as PiUserMessage).content;
			if (!Array.isArray(current)) return false;
			const newContent = current.slice();
			newContent[partIndex] = { type: "text", text: sentinelText };
			working[messageIndex] = {
				...(working[messageIndex] as PiUserMessage),
				content: newContent,
			};
			markDirty(messageIndex);
			return true;
		},
	};
}

function createPiAssistantPart(
	working: PiAgentMessage[],
	messageIndex: number,
	partIndex: number,
	markDirty: (messageIndex: number) => void,
): TranscriptPart {
	const msg = working[messageIndex] as PiAssistantMessage;
	const part = msg.content[partIndex];
	const kind = classifyAssistantContent(part);
	const id = part?.type === "toolCall" ? part.id : undefined;

	return {
		kind,
		id,
		getText(): string | undefined {
			const current = (working[messageIndex] as PiAssistantMessage).content;
			const p = current[partIndex];
			if (p?.type === "text") return p.text;
			if (p?.type === "thinking") return p.thinking;
			if (p?.type === "toolCall") {
				try {
					return JSON.stringify(p.arguments);
				} catch {
					return undefined;
				}
			}
			return undefined;
		},
		setText(newText: string): boolean {
			const current = (working[messageIndex] as PiAssistantMessage).content;
			const p = current[partIndex];
			if (p?.type === "text") {
				if (p.text === newText) return false;
				const newContent = current.slice();
				newContent[partIndex] = { ...p, text: newText };
				working[messageIndex] = {
					...(working[messageIndex] as PiAssistantMessage),
					content: newContent,
				};
				markDirty(messageIndex);
				return true;
			}
			if (p?.type === "thinking") {
				if (p.thinking === newText) return false;
				const newContent = current.slice();
				newContent[partIndex] = { ...p, thinking: newText };
				working[messageIndex] = {
					...(working[messageIndex] as PiAssistantMessage),
					content: newContent,
				};
				markDirty(messageIndex);
				return true;
			}
			if (p?.type === "toolCall") {
				const replacementArgs = { __magic_context_replacement__: newText };
				try {
					if (JSON.stringify(p.arguments) === JSON.stringify(replacementArgs)) {
						return false;
					}
				} catch {
					// Non-serializable args still need to be replaceable.
				}
				const newContent = current.slice();
				newContent[partIndex] = {
					...p,
					arguments: replacementArgs,
				};
				working[messageIndex] = {
					...(working[messageIndex] as PiAssistantMessage),
					content: newContent,
				};
				markDirty(messageIndex);
				return true;
			}
			return false;
		},
		setToolOutput(): boolean {
			// `setToolOutput` is invalid on assistant parts because Pi stores tool outputs in `ToolResultMessage` entries.
			throw new Error("setToolOutput on assistant part");
		},
		getToolMetadata(): {
			toolName: string | undefined;
			inputByteSize: number;
			inputTokenCount: number;
		} {
			const current = (working[messageIndex] as PiAssistantMessage).content;
			const p = current[partIndex];
			if (p?.type !== "toolCall") {
				return { toolName: undefined, inputByteSize: 0, inputTokenCount: 0 };
			}
			let inputByteSize = 0;
			let inputTokenCount = 0;
			try {
				const serialized = JSON.stringify(p.arguments);
				inputByteSize = serialized.length;
				inputTokenCount = serialized ? estimateTokens(serialized) : 0;
			} catch {
				inputByteSize = 0;
				inputTokenCount = 0;
			}
			return { toolName: p.name, inputByteSize, inputTokenCount };
		},
		getToolInput(): Record<string, unknown> | null {
			const current = (working[messageIndex] as PiAssistantMessage).content;
			const p = current[partIndex];
			if (p?.type !== "toolCall") return null;
			return p.arguments && typeof p.arguments === "object"
				? (p.arguments as Record<string, unknown>)
				: null;
		},
		setToolInput(input: Record<string, unknown>): boolean {
			const current = (working[messageIndex] as PiAssistantMessage).content;
			const p = current[partIndex];
			if (p?.type !== "toolCall") return false;
			try {
				if (JSON.stringify(p.arguments) === JSON.stringify(input)) return false;
			} catch {
			}
			const newContent = current.slice();
			newContent[partIndex] = { ...p, arguments: input };
			working[messageIndex] = {
				...(working[messageIndex] as PiAssistantMessage),
				content: newContent,
			};
			markDirty(messageIndex);
			return true;
		},
		//
		// `toolCall` sentinels preserve `type`, `id`, and `name` because matching `ToolResultMessage.toolCallId` requires the original call shell.
		// A `ToolResultMessage.toolCallId` must match the preceding tool call ID.
		//
		// API boundary.
		//
		// Text and thinking sentinels can replace the part directly because they have no tool-result pairing constraint.
		replaceWithSentinel(sentinelText: string): boolean {
			const current = (working[messageIndex] as PiAssistantMessage).content;
			const existing = current[partIndex];
			const newContent = current.slice();
			if (existing && existing.type === "toolCall") {
				newContent[partIndex] = {
					...existing,
					arguments: { __magic_context_dropped__: sentinelText },
				};
			} else {
				newContent[partIndex] = { type: "text", text: sentinelText };
			}
			working[messageIndex] = {
				...(working[messageIndex] as PiAssistantMessage),
				content: newContent,
			};
			markDirty(messageIndex);
			return true;
		},
	};
}

function createPiToolResultPart(
	working: PiAgentMessage[],
	messageIndex: number,
	partIndex: number,
	markDirty: (messageIndex: number) => void,
): TranscriptPart {
	const msg = working[messageIndex] as PiToolResultMessage;
	// All blocks in one `PiToolResultMessage` form one droppable tool-output unit.
	// The adapter exposes image blocks as `tool_result`, not `image`, so `tagTranscript` groups them with text blocks by `msg.toolCallId`.
	// Dropping one group replaces the entire tool result.
	const kind: TranscriptPartKind = "tool_result";
	return {
		kind,
		id: msg.toolCallId,
		getText(): string | undefined {
			const current = (working[messageIndex] as PiToolResultMessage).content;
			const p = current[partIndex];
			return p?.type === "text" ? p.text : undefined;
		},
		setText(newText: string): boolean {
			// `setText` mutates text slots for tagging.
			// `setToolOutput` handles tool-output changes; `setText` supports tagging.
			const current = (working[messageIndex] as PiToolResultMessage).content;
			const p = current[partIndex];
			if (p?.type !== "text") return false;
			if (p.text === newText) return false;
			const newContent = current.slice();
			newContent[partIndex] = { ...p, text: newText };
			working[messageIndex] = {
				...(working[messageIndex] as PiToolResultMessage),
				content: newContent,
			};
			markDirty(messageIndex);
			return true;
		},
		setToolOutput(newText: string): boolean {
			// Truncated drops call `setToolOutput`; `setText` changes only `type: "text"` blocks.
			const current = (working[messageIndex] as PiToolResultMessage).content;
			const p = current[partIndex];
			if (p?.type === "text") return this.setText(newText);
			const newContent = current.slice();
			newContent[partIndex] = { type: "text", text: newText };
			working[messageIndex] = {
				...(working[messageIndex] as PiToolResultMessage),
				content: newContent,
			};
			markDirty(messageIndex);
			return true;
		},
		getToolMetadata(): {
			toolName: string;
			inputByteSize: number;
			inputTokenCount: number;
		} {
			return {
				toolName: (working[messageIndex] as PiToolResultMessage).toolName,
				inputByteSize: 0,
				inputTokenCount: 0,
			};
		},
		replaceWithSentinel(sentinelText: string): boolean {
			const current = (working[messageIndex] as PiToolResultMessage).content;
			const newContent = current.slice();
			newContent[partIndex] = { type: "text", text: sentinelText };
			working[messageIndex] = {
				...(working[messageIndex] as PiToolResultMessage),
				content: newContent,
			};
			markDirty(messageIndex);
			return true;
		},
		rawByteSize(): number {
			// Size non-text tool results from their serialized payloads because `getText()` returns `undefined` for them.
			const current = (working[messageIndex] as PiToolResultMessage).content;
			const p = current[partIndex];
			if (p?.type === "text") return Buffer.byteLength(p.text, "utf8");
			try {
				return Buffer.byteLength(JSON.stringify(p ?? null), "utf8");
			} catch {
				return 0;
			}
		},
	};
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function classifyContent(part: unknown): TranscriptPartKind {
	if (!isRecord(part)) return "unknown";
	if (part.type === "text") return "text";
	if (part.type === "image") return "image";
	return "unknown";
}

function classifyAssistantContent(part: unknown): TranscriptPartKind {
	if (!isRecord(part)) return "unknown";
	if (part.type === "text") return "text";
	if (part.type === "thinking") return "thinking";
	if (part.type === "toolCall") return "tool_use";
	return "unknown";
}

/**
 *
 *   `pi-msg-${index}-${timestamp}-${role}`
 *
 */
function extractStableId(
	msg: PiAgentMessage | undefined,
	index: number,
	entryIds: readonly (string | undefined)[] | undefined,
): string | undefined {
	return resolvePiStableId(msg, index, entryIds);
}
