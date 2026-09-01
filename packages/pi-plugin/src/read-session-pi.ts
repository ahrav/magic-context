/**
 *
 * Pi message conversion synthesizes OpenCode-compatible `parts` so shared formatting, chunking, and trigger logic can consume Pi messages unchanged.
 *
 *
 * `@earendil-works/pi-coding-agent` core/session-manager.d.ts:
 *
 *
 *
 *
 * Mapping:
 * Each user and assistant message maps to one `RawMessage` with OpenCode-compatible `parts`.
 * The mapping folds each `ToolResultMessage` into the immediately following user `RawMessage` so its `callID` pairs with the assistant's `tool_use` part.
 * Trailing tool results without a following user message produce a synthetic user `RawMessage` with `id=""`.
 *
 * # Ordinals
 *
 * Branch-order ordinals start at 1; append-only active-branch entries keep the mapping stable for the session.
 *
 *
 * The historian skips every `getBranch()` entry except `SessionMessageEntry` because only that type provides `parts`.
 *
 *
 * Magic Context uses historian-driven compartments instead of `pi.compact()`.
 * compartments because:
 * Compartments preserve a structured XML view of older turns.
 * Pi's monolithic summary text cannot preserve categorized facts, ranges, and dates.
 * OpenCode users receive the same `<session-history>` shape regardless of the harness.
 *      historian.
 * Pi's compaction lives in the session JSONL file, whereas Magic Context stores compartments in the shared cortexkit DB scoped by `sessionId`.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RawMessage } from "@magic-context/core/hooks/magic-context/read-session-raw";

/**
 * `SYNTH_USER_ID_PREFIX` prefixes synthetic-user `RawMessage` ids created from `toolResult` runs.
 * A run of `toolResult` entries before an assistant message becomes one synthetic user turn.
 * `id` is `${SYNTH_USER_ID_PREFIX}${firstRealToolResultEntryId}`, not a real `SessionEntry.id`.
 * Pi `getBranch()` and compaction replay match real `entry.id` values.
 * Consumers requiring replay-safe real entry IDs must detect synthetic-user IDs.
 * `findFirstKeptEntryId` returns `null` when the kept start is a synthetic-user fold.
 * `findFirstKeptEntryId` retries the compaction marker next pass instead of cutting the tail at an orphaned `toolResult`.
 * `trimPiMessagesToBoundary` strips the synthetic-user prefix.
 * `trimPiMessagesToBoundary` trims at the underlying real `toolResult` entry ID.
 * `synth-user-` literal.
 */
export const SYNTH_USER_ID_PREFIX = "synth-user-";

/**
 *
 * Pi `AgentMessage`s have no stable per-message ID; the JSONL `SessionEntry` wrapper provides real `entry.id` values.
 * `resolvePiStableId` returns a real `entry.id` whenever available.
 * `resolvePiStableId` prefers real `entry.id` values because they survive message-array structural changes.
 * Real entry IDs survive compaction-prefix trims and `custom_message` inserts.
 * `resolvePiStableId` uses `pi-msg-${index}-...` IDs only when no real entry ID resolves.
 * Index-based fallback ids change when message positions change.
 * wrappers).
 *
 * Precedence:
 * `entryIdByRef.get(msg)` uses reference identity, so cloned messages do not resolve.
 * `entryIds[index]` is valid only while `entryIds` remains aligned with the containing messages array.
 * The positional fallback covers cloned messages only while `entryIds` remains aligned with the containing messages array.
 *      id resolves.
 *
 * All Pi stable-ID consumers must use `resolvePiStableId` to keep cross-path lookups consistent.
 * Lookup, heuristic-cleanup owner, and compaction-trim paths must use the same IDs.
 * Divergent ids make cross-path lookups miss.
 * silently miss.
 */
export function resolvePiStableId(
	msg: unknown,
	index: number,
	entryIds?: readonly (string | undefined)[],
	entryIdByRef?: ReadonlyMap<object, string>,
): string | undefined {
	if (!msg || typeof msg !== "object") return undefined;
	const byRef = entryIdByRef?.get(msg as object);
	if (typeof byRef === "string" && byRef.length > 0) return byRef;
	const positional = entryIds?.[index];
	if (typeof positional === "string" && positional.length > 0)
		return positional;
	// Index-based fallback IDs change when message positions change.
	const m = msg as { role?: string; timestamp?: number };
	const role = m.role ?? "unknown";
	return typeof m.timestamp === "number"
		? `pi-msg-${index}-${m.timestamp}-${role}`
		: `pi-msg-${index}-${role}`;
}

export function isMidTurnPi(
	event: unknown,
	_sessionId: string,
	branchEntries?: readonly unknown[] | null,
): boolean {
	const messages = (event as { messages?: unknown })?.messages;
	if (!Array.isArray(messages)) return false;

	let latestAssistantIndex = -1;
	let latestAssistant: Record<string, unknown> | null = null;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg !== null && typeof msg === "object") {
			const record = msg as Record<string, unknown>;
			if (record.role === "assistant") {
				latestAssistantIndex = i;
				latestAssistant = record;
				break;
			}
		}
	}

	if (latestAssistant === null) return false;
	if (hasRealUserAfter(messages, latestAssistantIndex, branchEntries))
		return false;
	if (latestAssistant.stopReason === "toolUse") return true;

	const toolCallIds = getToolCallIds(latestAssistant.content);
	if (toolCallIds.size === 0) return false;

	const pairedToolResultIds = new Set<string>();
	for (const msg of messages.slice(latestAssistantIndex + 1)) {
		if (msg === null || typeof msg !== "object") continue;
		const record = msg as Record<string, unknown>;
		if (record.role !== "toolResult") continue;
		if (typeof record.toolCallId === "string") {
			pairedToolResultIds.add(record.toolCallId);
		}
	}

	for (const id of toolCallIds) {
		if (!pairedToolResultIds.has(id)) return true;
	}
	return false;
}

function hasRealUserAfter(
	messages: readonly unknown[],
	latestAssistantIndex: number,
	branchEntries?: readonly unknown[] | null,
): boolean {
	if (!branchEntries) return false;
	const genuineUserMessages = new Set<object>();
	for (const entry of branchEntries) {
		if (entry === null || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		if (record.type !== "message") continue;
		const message = record.message;
		if (message === null || typeof message !== "object") continue;
		if ((message as Record<string, unknown>).role === "user") {
			genuineUserMessages.add(message);
		}
	}

	// Only user messages that are branch-entry identities end the lock; converted steer/custom messages do not.
	for (const msg of messages.slice(latestAssistantIndex + 1)) {
		if (
			msg !== null &&
			typeof msg === "object" &&
			genuineUserMessages.has(msg)
		) {
			return true;
		}
	}
	return false;
}

function getToolCallIds(content: unknown): Set<string> {
	const ids = new Set<string>();
	if (!Array.isArray(content)) return ids;
	for (const item of content) {
		if (item === null || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		if (record.type === "toolCall" && typeof record.id === "string") {
			ids.add(record.id);
		}
	}
	return ids;
}

/**
 * Returns an OpenCode-shape `RawMessage[]` synthesized from the active Pi session branch.
 *
 * branch.
 */
export function readPiSessionMessages(ctx: ExtensionContext): RawMessage[] {
	const sm = ctx.sessionManager;
	if (sm === undefined) return [];
	const getBranch = (sm as { getBranch?: (fromId?: string) => unknown[] })
		.getBranch;
	if (typeof getBranch !== "function") return [];

	let entries: unknown[];
	try {
		entries = getBranch.call(sm);
	} catch {
		return [];
	}
	if (!Array.isArray(entries)) return [];

	return convertEntriesToRawMessages(entries);
}

/**
 * The function returns a `provider/modelId` key matching `resolvePiContextModelKey`.
 *
 * On the first context pass after a restart, seed `liveModelBySession` from the branch before comparing model keys.
 * `liveModelBySession` is in memory, so `previousModelKey` is undefined after a restart.
 * A model change that occurred while the process was down would otherwise not be detected.
 * Without seeding, model-specific detected-context-limit, reasoning-watermark, and historian-failure state can leak to the new model.
 * The JSONL seed lets the first-pass model-key comparison reset model-specific state.
 *
 *
 * The helper accepts the caller's branch entries because the context handler reads `getBranch()` once per event.
 * The helper must reuse the caller's branch entries because `getBranch()` reads the whole JSONL branch.
 */
export function findLastModelKeyFromBranch(
	entries: readonly unknown[] | null | undefined,
): string | undefined {
	if (!Array.isArray(entries)) return undefined;

	// The last `model_change` entry determines the session's current model.
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (!e || typeof e !== "object") continue;
		const v = e as { type?: unknown; provider?: unknown; modelId?: unknown };
		if (v.type !== "model_change") continue;
		if (
			typeof v.provider === "string" &&
			v.provider.length > 0 &&
			typeof v.modelId === "string" &&
			v.modelId.length > 0
		) {
			return `${v.provider}/${v.modelId}`;
		}
	}
	return undefined;
}

function rawEntryVersion(entry: MessageEntry): string | number {
	const record = entry as unknown as Record<string, unknown>;
	const updated = record.updatedAt ?? record.updated_at ?? record.timestamp;
	return typeof updated === "string" || typeof updated === "number"
		? updated
		: entry.id;
}

function attachPiPartVersion(
	parts: unknown[],
	version: string | number,
): unknown[] {
	return parts.map((part) => {
		if (part === null || typeof part !== "object" || Array.isArray(part))
			return part;
		try {
			Object.defineProperty(part, "__magicContextPartUpdatedAt", {
				value: version,
				enumerable: false,
				configurable: true,
			});
		} catch {}
		return part;
	});
}

/**
 */
export function convertEntriesToRawMessages(entries: unknown[]): RawMessage[] {
	const result: RawMessage[] = [];
	let nextOrdinal = 1;

	// The pending buffer holds tool-result parts until the next user message.
	let pendingToolParts: unknown[] = [];
	// The pending buffer retains the first contributing real `toolResult` entry ID.
	// When tool results fold into a synthetic user after an assistant entry, that user must retain the first contributing real entry ID.
	// A synthetic user must retain the first contributing real entry ID.
	//
	//     unusable id.
	let pendingFirstRealId = "";
	let pendingFirstRealVersion: string | number = "";

	for (const entry of entries) {
		if (!isMessageEntry(entry)) {
			continue;
		}

		const msg = entry.message;
		const role = (msg as { role?: string }).role;

		if (role === "toolResult") {
			const version = rawEntryVersion(entry);
			pendingToolParts.push(
				...attachPiPartVersion(synthesizeToolResultParts(msg), version),
			);
			if (pendingFirstRealId === "") {
				pendingFirstRealId = entry.id;
				pendingFirstRealVersion = version;
			}
			continue;
		}

		if (role === "user") {
			// Tool-result parts precede user content in conversation order.
			const version = rawEntryVersion(entry);
			const parts: unknown[] = [
				...pendingToolParts,
				...attachPiPartVersion(synthesizeUserParts(msg), version),
			];
			pendingToolParts = [];
			pendingFirstRealId = "";
			pendingFirstRealVersion = "";
			result.push({
				ordinal: nextOrdinal++,
				id: entry.id,
				role: "user",
				parts,
				version,
			});
			continue;
		}

		if (role === "assistant") {
			if (pendingToolParts.length > 0) {
				result.push({
					ordinal: nextOrdinal++,
					id: `${SYNTH_USER_ID_PREFIX}${pendingFirstRealId}`,
					role: "user",
					parts: pendingToolParts,
					version: pendingFirstRealVersion,
				});
				pendingToolParts = [];
				pendingFirstRealId = "";
				pendingFirstRealVersion = "";
			}

			const version = rawEntryVersion(entry);
			result.push({
				ordinal: nextOrdinal++,
				id: entry.id,
				role: "assistant",
				parts: attachPiPartVersion(synthesizeAssistantParts(msg), version),
				version,
			});
			continue;
		}

		result.push({
			ordinal: nextOrdinal++,
			id: entry.id,
			role: typeof role === "string" ? role : "unknown",
			parts: [],
			version: rawEntryVersion(entry),
		});
	}

	// Trailing tool results produce a synthetic user turn.
	if (pendingToolParts.length > 0) {
		result.push({
			ordinal: nextOrdinal,
			id: `${SYNTH_USER_ID_PREFIX}${pendingFirstRealId}`,
			role: "user",
			parts: pendingToolParts,
			version: pendingFirstRealVersion,
		});
	}

	return result;
}

interface MessageEntry {
	type: "message";
	id: string;
	message: unknown;
}

function isMessageEntry(value: unknown): value is MessageEntry {
	if (value === null || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	if (v.type !== "message") return false;
	if (typeof v.id !== "string") return false;
	if (v.message === null || typeof v.message !== "object") return false;
	return true;
}

/**
 */
function synthesizeUserParts(msg: unknown): unknown[] {
	const m = msg as { content?: unknown };
	if (typeof m.content === "string") {
		if (m.content.trim().length === 0) return [];
		return [{ type: "text", text: m.content }];
	}
	if (!Array.isArray(m.content)) return [];

	const parts: unknown[] = [];
	for (const c of m.content) {
		if (c === null || typeof c !== "object") continue;
		const cc = c as Record<string, unknown>;
		if (cc.type === "text" && typeof cc.text === "string") {
			parts.push({ type: "text", text: cc.text });
		}
	}
	return parts;
}

/**
 * We map:
 *
 */
function synthesizeAssistantParts(msg: unknown): unknown[] {
	const m = msg as { content?: unknown };
	if (!Array.isArray(m.content)) return [];

	const parts: unknown[] = [];
	for (const c of m.content) {
		if (c === null || typeof c !== "object") continue;
		const cc = c as Record<string, unknown>;
		if (cc.type === "text" && typeof cc.text === "string") {
			parts.push({ type: "text", text: cc.text });
		} else if (cc.type === "toolCall" && typeof cc.id === "string") {
			parts.push({
				type: "tool",
				tool: typeof cc.name === "string" ? cc.name : "unknown",
				callID: cc.id,
				state: {
					input: cc.arguments ?? {},
				},
			});
		}
	}
	return parts;
}

/**
 */
function synthesizeToolResultParts(msg: unknown): unknown[] {
	const m = msg as {
		toolCallId?: unknown;
		toolName?: unknown;
		content?: unknown;
	};
	const callID = typeof m.toolCallId === "string" ? m.toolCallId : "";
	const tool = typeof m.toolName === "string" ? m.toolName : "unknown";

	if (!callID) return []; // no useful pairing handle

	let output = "";
	if (Array.isArray(m.content)) {
		const fragments: string[] = [];
		for (const c of m.content) {
			if (c === null || typeof c !== "object") continue;
			const cc = c as Record<string, unknown>;
			if (cc.type === "text" && typeof cc.text === "string") {
				fragments.push(cc.text);
			}
		}
		output = fragments.join("\n");
	}

	return [
		{
			type: "tool",
			tool,
			callID,
			state: {
				output,
			},
		},
	];
}
