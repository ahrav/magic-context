import { describe, expect, it } from "bun:test";
import {
	getPersistedTodoSyntheticAnchor,
	setPersistedTodoSyntheticAnchor,
} from "@magic-context/core/features/magic-context/storage-meta";
import { computeSyntheticCallId } from "@magic-context/core/hooks/magic-context/todo-view";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { injectSyntheticTodowriteForPi } from "./pi-todo-inject";
import { assistantMessage, createTestDb } from "./test-utils.test";

/**
 * Replicates the function_call / function_call_output pairing the OpenAI
 * Responses (Codex) serializer produces — see pi-mono
 * packages/ai/src/providers/openai-responses-shared.ts: an assistant message
 * emits one `function_call` per `toolCall` content block but is SKIPPED whole
 * when it yields zero output items; a `toolResult` message always emits a
 * `function_call_output`. The wire is invalid when a `function_call_output`
 * has no preceding `function_call` with the same call_id (the live 400 error).
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
			// Codex skips an assistant message entirely when it produces no
			// output items. Of the blocks we model, only `toolCall` and
			// non-empty `text` yield output items.
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

	// Reproduction of the live Codex 400 on session 019de471: the
	// persisted anchor pointed at an ABORTED assistant (stopReason "aborted",
	// empty content). Pi's transform-messages skips errored/aborted assistants
	// wholesale at wire build but forwards toolResult messages unconditionally,
	// so the synthetic pair's call half vanished while its output half shipped —
	// an orphaned function_call_output, rejected 400 on every subsequent turn.
	it("never anchors the synthetic pair to an aborted or errored assistant", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-pi-todo-aborted-anchor";
			const stateJson = JSON.stringify([
				{ content: "Ship it", status: "in_progress", priority: "high" },
			]);
			const callId = computeSyntheticCallId(stateJson);
			// The anchor persisted on an earlier pass now resolves to an aborted
			// assistant (the live shape: aborted, content []).
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

			// Defer pass: the pair must NOT attach to the aborted anchor (skip
			// silently, same as an anchor outside the visible window).
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

			// Cache-busting pass: the pair re-anchors to a REPLAYABLE assistant
			// instead (never the aborted one, even when it is the newest).
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

	// Reproduction of the live Codex 400 "No tool call found for function call
	// output with call_id mc_synthetic_todo_..." on a post-/ctx-recomp Pi tail.
	//
	// Proven on-disk shape (JSONL lines 22091/22093/22095 of the bogged session):
	// a single Codex response is split by Pi into MULTIPLE assistant messages
	// that all carry the SAME `responseId`, and a trailing reasoning-only segment
	// has empty content. getMessageId() keys identity on responseId, so the
	// synthetic anchor id is NON-UNIQUE across those messages.
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

			// The latest-assistant inject path anchored to the LAST message
			// carrying the shared responseId (the empty reasoning-only segment).
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
				// Trailing reasoning-only segment of the SAME response: empty content.
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

			// The synthetic pair must be injected AND wire-valid: every synthetic
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
