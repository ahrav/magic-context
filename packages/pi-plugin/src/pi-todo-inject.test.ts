import { describe, expect, it } from "bun:test";
import {
	getPersistedTodoSyntheticAnchor,
	setPersistedTodoSyntheticAnchor,
} from "@magic-context/core/features/magic-context/storage-meta";
import { computeSyntheticCallId } from "@magic-context/core/hooks/magic-context/todo-view";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { injectSyntheticTodowriteForPi } from "./pi-todo-inject";
import { assistantMessage, createTestDb } from "./test-utils";

/**
 * An assistant message is omitted when it yields zero output items; a toolResult message always emits a function_call_output.
 */
function findOrphanedFunctionCallOutputs(messages: unknown[]): string[] {
	const seenCallIds = new Set<string>();
	const orphans: string[] = [];
	for (const m of messages) {
		if (!m || typeof m !== "object") continue;
		const role = (m as { role?: unknown }).role;
		if (role === "assistant") {
			const content = (m as { content?: unknown }).content;
			if (!Array.isArray(content)) continue;
			// Codex omits assistant messages that produce zero output items.
			// Non-empty `text` blocks yield output items.
			const blocks = content as Array<Record<string, unknown>>;
			const producesOutput = blocks.some(
				(b) =>
					b?.type === "toolCall" ||
					(b?.type === "text" &&
						typeof b.text === "string" &&
						b.text.length > 0),
			);
			if (!producesOutput) continue;
			for (const b of blocks) {
				if (b?.type === "toolCall" && typeof b.id === "string") {
					seenCallIds.add(b.id.split("|")[0]);
				}
			}
		} else if (role === "toolResult") {
			const callId = (m as { toolCallId?: unknown }).toolCallId;
			if (typeof callId === "string") {
				const normalized = callId.split("|")[0];
				if (!seenCallIds.has(normalized)) orphans.push(normalized);
			}
		}
	}
	return orphans;
}

function thinkingToolCall(
	responseId: string,
	callId: string,
	timestamp: number,
): Record<string, unknown> {
	return {
		role: "assistant",
		content: [
			{
				type: "thinking",
				thinking: "...",
				thinkingSignature: `{"id":"rs_${callId}"}`,
			},
			{
				type: "toolCall",
				id: `${callId}|fc_${callId}`,
				name: "read",
				arguments: {},
			},
		],
		responseId,
		timestamp,
	};
}

function toolResultMsg(
	callId: string,
	timestamp: number,
): Record<string, unknown> {
	return {
		role: "toolResult",
		toolCallId: `${callId}|fc_${callId}`,
		toolName: "read",
		content: [{ type: "text", text: "ok" }],
		timestamp,
	};
}

describe("injectSyntheticTodowriteForPi", () => {
	it("skips defer replay when the persisted anchor is outside the visible window", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-pi-todo-defer-missing-anchor";
			const stateJson = JSON.stringify([
				{
					content: "Keep stable anchor",
					status: "in_progress",
					priority: "high",
				},
			]);
			const callId = computeSyntheticCallId(stateJson);
			setPersistedTodoSyntheticAnchor(
				db,
				sessionId,
				callId,
				"old-anchor-not-visible",
				stateJson,
			);
			const messages = [
				assistantMessage("latest visible assistant", 2, {
					responseId: "new-visible-anchor",
				}),
			] as Parameters<typeof injectSyntheticTodowriteForPi>[0]["messages"];

			const result = injectSyntheticTodowriteForPi({
				db,
				sessionId,
				isSubagent: false,
				isCacheBusting: false,
				lastTodoState: stateJson,
				messages,
			});

			expect(result).toBe(messages);
			expect(messages).toHaveLength(1);
			expect(JSON.stringify(messages)).not.toContain(callId);
			expect(getPersistedTodoSyntheticAnchor(db, sessionId)?.messageId).toBe(
				"old-anchor-not-visible",
			);
		} finally {
			closeQuietly(db);
		}
	});

	// Pi omits aborted assistant messages but forwards toolResult messages, so attaching a synthetic pair to an aborted assistant produces an orphaned function_call_output.
	// An aborted assistant has stopReason "aborted" and empty content.
	// An orphaned function_call_output is rejected.
	it("never anchors the synthetic pair to an aborted or errored assistant", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-pi-todo-aborted-anchor";
			const stateJson = JSON.stringify([
				{ content: "Ship it", status: "in_progress", priority: "high" },
			]);
			const callId = computeSyntheticCallId(stateJson);
			// The persisted anchor can resolve to an aborted assistant.
			// An aborted assistant has empty content.
			setPersistedTodoSyntheticAnchor(
				db,
				sessionId,
				callId,
				"resp_aborted",
				stateJson,
			);
			const aborted = {
				role: "assistant",
				content: [],
				responseId: "resp_aborted",
				stopReason: "aborted",
				timestamp: 1,
			};
			const good = assistantMessage("all done", 2, {
				responseId: "resp_good",
			});

			// Pi omits aborted assistant messages but forwards toolResult messages, so replaying the synthetic pair would orphan the synthetic tool result.
			// Pi omits aborted assistant messages but forwards toolResult messages, so replaying the synthetic pair would orphan the synthetic tool result.
			const deferMessages = [aborted, good] as unknown as Parameters<
				typeof injectSyntheticTodowriteForPi
			>[0]["messages"];
			injectSyntheticTodowriteForPi({
				db,
				sessionId,
				isSubagent: false,
				isCacheBusting: false,
				lastTodoState: stateJson,
				messages: deferMessages,
			});
			expect(findOrphanedFunctionCallOutputs(deferMessages)).toEqual([]);
			expect(JSON.stringify(deferMessages)).not.toContain(callId);

			// Cache-busting replay re-anchors the synthetic pair to a replayable assistant.
			// The injector never anchors the synthetic pair to an aborted assistant.
			const errored = {
				role: "assistant",
				content: [],
				responseId: "resp_errored",
				stopReason: "error",
				timestamp: 3,
			};
			const bustMessages = [aborted, good, errored] as unknown as Parameters<
				typeof injectSyntheticTodowriteForPi
			>[0]["messages"];
			injectSyntheticTodowriteForPi({
				db,
				sessionId,
				isSubagent: false,
				isCacheBusting: true,
				lastTodoState: stateJson,
				messages: bustMessages,
			});
			expect(findOrphanedFunctionCallOutputs(bustMessages)).toEqual([]);
			const anchor = getPersistedTodoSyntheticAnchor(db, sessionId);
			expect(anchor?.messageId).toBe("resp_good");
			const goodContent = (good as { content: Array<{ id?: string }> }).content;
			expect(goodContent.some((b) => b.id === callId)).toBe(true);
		} finally {
			closeQuietly(db);
		}
	});

	//
	// A Codex response can be split into multiple assistant messages with the same responseId.
	// Pi can split one Codex response into multiple assistant messages that share a responseId.
	// Pi can split one Codex response into multiple assistant messages that share a responseId; a trailing reasoning-only message can have empty content.
	// `responseId` is non-unique across messages from the same Codex response.
	it("does not orphan the synthetic toolResult when several tail messages share one responseId", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-pi-todo-shared-responseid";
			const stateJson = JSON.stringify([
				{
					content: "Refresh PR metadata",
					status: "in_progress",
					priority: "high",
				},
			]);
			const callId = computeSyntheticCallId(stateJson);
			const sharedResponseId =
				"resp_040c5c13bbb6f3bc016a2d8705d29c819181a2638024c55a80";

			// A trailing reasoning-only segment has empty content.
			setPersistedTodoSyntheticAnchor(
				db,
				sessionId,
				callId,
				sharedResponseId,
				stateJson,
			);

			const messages = [
				thinkingToolCall(sharedResponseId, "a1", 1),
				toolResultMsg("a1", 1),
				thinkingToolCall(sharedResponseId, "a2", 2),
				toolResultMsg("a2", 2),
				// A trailing reasoning-only segment has empty content.
				{
					role: "assistant",
					content: [],
					responseId: sharedResponseId,
					timestamp: 3,
				},
			] as Parameters<typeof injectSyntheticTodowriteForPi>[0]["messages"];

			injectSyntheticTodowriteForPi({
				db,
				sessionId,
				isSubagent: false,
				isCacheBusting: true,
				lastTodoState: stateJson,
				messages,
			});

			// function_call_output must have a matching function_call before it.
			expect(JSON.stringify(messages)).toContain(callId);
			const orphans = findOrphanedFunctionCallOutputs(
				messages as unknown as unknown[],
			);
			expect(orphans).toEqual([]);
		} finally {
			closeQuietly(db);
		}
	});
});
