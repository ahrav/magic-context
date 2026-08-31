/**
 *
 *
 * OpenCode synthesizes a single `tool` part on the latest assistant message
 *
 * ```text
 * packages/plugin/src/hooks/magic-context/todo-view.ts
 * ```
 * OpenCode's wire serializer splits the combined part into an assistant `tool_use` and a next-user `tool_result` at wire-emit time.
 *
 * Pi RPC delivers assistant `toolCall` blocks and `toolResult` values in separate top-level messages.
 * The injector must add a `toolCall` block to the latest assistant and insert its `PiToolResultMessage` immediately after that assistant.
 *
 *
 *
 *   callID match.
 * The injector runs after tagging, drops, and nudges in `runPipeline`.
 * Running after tagging, drops, and nudges prevents synthetic blocks from being tagged, dropped, or passed to `ctx_reduce`.
 *   reach `ctx_reduce`.
 * The injector derives `callID` as `mc_synthetic_todo_<sha256[:16]>` from persisted state.
 * Identical persisted state produces byte-identical wire shape.
 */

import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import {
	clearPersistedTodoSyntheticAnchor,
	getPersistedTodoSyntheticAnchor,
	setPersistedTodoSyntheticAnchor,
} from "@magic-context/core/features/magic-context/storage-meta";
import {
	buildSyntheticTodoPart,
	type SyntheticTodoPart,
} from "@magic-context/core/hooks/magic-context/todo-view";

// These local types mirror the Pi AI fields used here.
//
// Only the fields we read/write are typed; other fields pass through opaquely.
type PiToolCallBlock = {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	// Mirrors `SyntheticTodoPart.syntheticTodoMarker`.
	syntheticTodoMarker: true;
};

type PiAssistantMessage = {
	role: "assistant";
	content: Array<Record<string, unknown>>;
	responseId?: string;
	timestamp?: number;
	stopReason?: string;
};

type PiToolResultMessage = {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: Array<{ type: "text"; text: string }>;
	timestamp?: number;
	syntheticTodoMarker?: true;
};

type PiMessage =
	| PiAssistantMessage
	| PiToolResultMessage
	| Record<string, unknown>;

function getMessageId(message: PiAssistantMessage): string {
	if (typeof message.responseId === "string" && message.responseId.length > 0) {
		return message.responseId;
	}
	if (typeof message.timestamp === "number") {
		return `pi-ts-${message.timestamp}`;
	}
	// An index-based fallback would change across passes and break replay byte stability.
	return "";
}

/**
 * Pi omits aborted and errored assistant messages from wire requests but forwards top-level `toolResult` messages.
 * Anchoring a pair to an omitted assistant creates an orphaned `function_call_output`.
 */
function isReplayableAnchor(message: PiAssistantMessage): boolean {
	return message.stopReason !== "aborted" && message.stopReason !== "error";
}

function hasToolCallWithId(
	message: PiAssistantMessage,
	callId: string,
): boolean {
	if (!Array.isArray(message.content)) return false;
	for (const block of message.content) {
		if (!block || typeof block !== "object") continue;
		const t = (block as { type?: unknown }).type;
		const id = (block as { id?: unknown }).id;
		if (t === "toolCall" && id === callId) return true;
	}
	return false;
}

function findToolResultAfter(
	messages: PiMessage[],
	assistantIndex: number,
	callId: string,
): number {
	for (let i = assistantIndex + 1; i < messages.length; i += 1) {
		const m = messages[i];
		if (!m || typeof m !== "object") continue;
		const role = (m as { role?: unknown }).role;
		const tcId = (m as { toolCallId?: unknown }).toolCallId;
		if (role === "toolResult" && tcId === callId) return i;
		// Stop before the next assistant because Pi matches tool results to the preceding assistant turn.
		if (role === "assistant") return -1;
	}
	return -1;
}

/**
 */
function piBlocksFromSynthetic(part: SyntheticTodoPart): {
	call: PiToolCallBlock;
	result: PiToolResultMessage;
} {
	return {
		call: {
			type: "toolCall",
			id: part.callID,
			name: part.tool,
			arguments: { todos: part.state.input.todos },
			syntheticTodoMarker: true,
		},
		result: {
			role: "toolResult",
			toolCallId: part.callID,
			toolName: part.tool,
			content: [{ type: "text", text: part.state.output }],
			timestamp: 0,
			syntheticTodoMarker: true,
		},
	};
}

/**
 */
function injectByAssistantId(
	messages: PiMessage[],
	messageId: string,
	part: SyntheticTodoPart,
): boolean {
	for (let i = 0; i < messages.length; i += 1) {
		const m = messages[i];
		if (!m || typeof m !== "object") continue;
		if ((m as { role?: unknown }).role !== "assistant") continue;
		const assistant = m as PiAssistantMessage;
		if (getMessageId(assistant) !== messageId) continue;
		if (!isReplayableAnchor(assistant)) return false;
		if (hasToolCallWithId(assistant, part.callID)) {
			if (findToolResultAfter(messages, i, part.callID) >= 0) return true;
		}
		const { call, result } = piBlocksFromSynthetic(part);
		if (!Array.isArray(assistant.content)) assistant.content = [];
		if (!hasToolCallWithId(assistant, part.callID)) {
			assistant.content.push(call as unknown as Record<string, unknown>);
		}
		if (findToolResultAfter(messages, i, part.callID) < 0) {
			messages.splice(i + 1, 0, result);
		}
		return true;
	}
	return false;
}

/**
 */
function injectIntoLatestAssistant(
	messages: PiMessage[],
	part: SyntheticTodoPart,
): string | null {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const m = messages[i];
		if (!m || typeof m !== "object") continue;
		if ((m as { role?: unknown }).role !== "assistant") continue;
		const assistant = m as PiAssistantMessage;
		if (!isReplayableAnchor(assistant)) continue;
		const id = getMessageId(assistant);
		if (id.length === 0) continue;
		if (hasToolCallWithId(assistant, part.callID)) {
			if (findToolResultAfter(messages, i, part.callID) >= 0) return id;
		}
		const { call, result } = piBlocksFromSynthetic(part);
		if (!Array.isArray(assistant.content)) assistant.content = [];
		if (!hasToolCallWithId(assistant, part.callID)) {
			assistant.content.push(call as unknown as Record<string, unknown>);
		}
		if (findToolResultAfter(messages, i, part.callID) < 0) {
			messages.splice(i + 1, 0, result);
		}
		return id;
	}
	return null;
}

/**
 * helpers.
 *
 * The injector mutates `messages` in place and returns the same array.
 */
export function injectSyntheticTodowriteForPi(args: {
	db: ContextDatabase;
	sessionId: string;
	isSubagent: boolean;
	isCacheBusting: boolean;
	lastTodoState: string;
	messages: PiMessage[];
}): PiMessage[] {
	if (args.isSubagent) return args.messages;

	const persistedAnchor = getPersistedTodoSyntheticAnchor(
		args.db,
		args.sessionId,
	);

	if (args.isCacheBusting) {
		const part = buildSyntheticTodoPart(args.lastTodoState);
		if (part === null) {
			if (persistedAnchor) {
				clearPersistedTodoSyntheticAnchor(args.db, args.sessionId);
			}
			return args.messages;
		}
		if (
			persistedAnchor &&
			persistedAnchor.callId === part.callID &&
			injectByAssistantId(args.messages, persistedAnchor.messageId, part)
		) {
			if (persistedAnchor.stateJson.length === 0) {
				setPersistedTodoSyntheticAnchor(
					args.db,
					args.sessionId,
					persistedAnchor.callId,
					persistedAnchor.messageId,
					args.lastTodoState,
				);
			}
			return args.messages;
		}
		const anchoredMessageId = injectIntoLatestAssistant(args.messages, part);
		if (anchoredMessageId) {
			setPersistedTodoSyntheticAnchor(
				args.db,
				args.sessionId,
				part.callID,
				anchoredMessageId,
				args.lastTodoState,
			);
		} else if (persistedAnchor) {
			clearPersistedTodoSyntheticAnchor(args.db, args.sessionId);
		}
		return args.messages;
	}

	if (!persistedAnchor || persistedAnchor.stateJson.length === 0) {
		return args.messages;
	}
	const part = buildSyntheticTodoPart(persistedAnchor.stateJson);
	if (part === null || part.callID !== persistedAnchor.callId) {
		return args.messages;
	}
	injectByAssistantId(args.messages, persistedAnchor.messageId, part);
	return args.messages;
}
