import { describe, expect, it } from "bun:test";
import { CTX_REDUCE_KEEP } from "@magic-context/core/features/magic-context/reclaim-protection";
import {
	getActiveTagsBySession,
	getTagsBySession,
	insertTag,
	queuePendingOp,
} from "@magic-context/core/features/magic-context/storage";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import {
	applyFlushedStatuses,
	applyPendingOperations,
} from "@magic-context/core/hooks/magic-context/apply-operations";
import type { TagTarget } from "@magic-context/core/hooks/magic-context/tag-messages";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { tagTranscript } from "@magic-context/core/shared/tag-transcript";
import {
	applyPiHeuristicCleanup,
	PI_CTX_REDUCE_KEEP,
} from "./heuristic-cleanup-pi";
import {
	assistantMessage,
	createTestDb,
	textOf,
	toolResultMessage,
	userMessage,
} from "./test-utils";
import { createPiTranscript } from "./transcript-pi";

function tagMessages(
	sessionId: string,
	db: ReturnType<typeof createTestDb>,
	messages: unknown[],
) {
	const tagger = createTagger();
	tagger.initFromDb(sessionId, db);
	const transcript = createPiTranscript(messages, sessionId);
	const tagged = tagTranscript(sessionId, transcript, tagger, db);
	return { tagger, transcript, targets: tagged.targets };
}

function ctxReduceExchange(callId: string, timestamp: number): unknown[] {
	return [
		{
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: callId,
					name: "ctx_reduce",
					arguments: {},
				},
			],
			timestamp,
		},
		{
			...toolResultMessage(callId, `reduced ${callId}`, timestamp + 1),
			toolName: "ctx_reduce",
		},
	];
}

describe("applyPiHeuristicCleanup", () => {
	it("keeps identical read-tool fingerprints distinct across assistant owners", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-heuristic-cross-owner";
			const messages = [
				userMessage("read once", 1),
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "read-call-a",
							name: "mcp_read",
							arguments: { filePath: "src/a.ts" },
						},
					],
					timestamp: 2,
				},
				userMessage("read again", 3),
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "read-call-b",
							name: "mcp_read",
							arguments: { filePath: "src/a.ts" },
						},
					],
					timestamp: 4,
				},
			];
			const { transcript, targets } = tagMessages(sessionId, db, messages);

			const result = applyPiHeuristicCleanup(sessionId, db, targets, messages, {
				protectedTags: 0,
				staleReduceStripEnabled: true,
			});
			transcript.commit();

			expect(result.deduplicatedTools).toBe(0);
			expect(
				getTagsBySession(db, sessionId)
					.filter((tag) => tag.type === "tool")
					.map((tag) => [tag.messageId, tag.toolOwnerMessageId, tag.status]),
			).toEqual([
				["read-call-a", "pi-msg-1-2-assistant", "active"],
				["read-call-b", "pi-msg-3-4-assistant", "active"],
			]);
		} finally {
			closeQuietly(db);
		}
	});

	it("deduplicates same-owner parallel read calls with identical arguments", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-heuristic-same-owner";
			const messages = [
				userMessage("read twice", 1),
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "read-call-a",
							name: "mcp_read",
							arguments: { filePath: "src/a.ts" },
						},
						{
							type: "toolCall",
							id: "read-call-b",
							name: "mcp_read",
							arguments: { filePath: "src/a.ts" },
						},
					],
					timestamp: 2,
				},
			];
			const { transcript, targets } = tagMessages(sessionId, db, messages);

			const result = applyPiHeuristicCleanup(sessionId, db, targets, messages, {
				protectedTags: 0,
				staleReduceStripEnabled: true,
			});
			transcript.commit();

			expect(result.deduplicatedTools).toBe(1);
			expect(
				getTagsBySession(db, sessionId)
					.filter((tag) => tag.type === "tool")
					.map((tag) => [tag.messageId, tag.toolOwnerMessageId, tag.status]),
			).toEqual([
				["read-call-a", "pi-msg-1-2-assistant", "dropped"],
				["read-call-b", "pi-msg-1-2-assistant", "active"],
			]);
		} finally {
			closeQuietly(db);
		}
	});

	it("does not count an absent dedup target as a confirmed mutation", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-heuristic-dedup-absent";
			const messages = [
				userMessage("read twice", 1),
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "read-call-a",
							name: "mcp_read",
							arguments: { filePath: "src/a.ts" },
						},
						{
							type: "toolCall",
							id: "read-call-b",
							name: "mcp_read",
							arguments: { filePath: "src/a.ts" },
						},
					],
					timestamp: 2,
				},
			];
			const { targets } = tagMessages(sessionId, db, messages);
			const oldTag = getTagsBySession(db, sessionId).find(
				(tag) => tag.messageId === "read-call-a",
			);
			if (!oldTag) throw new Error("missing old tag");
			targets.delete(oldTag.tagNumber);

			const result = applyPiHeuristicCleanup(sessionId, db, targets, messages, {
				protectedTags: 0,
				staleReduceStripEnabled: true,
			});

			expect(result.deduplicatedTools).toBe(0);
			expect(
				getTagsBySession(db, sessionId).find(
					(tag) => tag.tagNumber === oldTag.tagNumber,
				)?.status,
			).toBe("dropped");
		} finally {
			closeQuietly(db);
		}
	});

	it("protects the same newest three ctx_reduce arcs in Pi sentinel selection", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-pi-ctx-reduce-exemplars";
			const messages: unknown[] = [];
			for (let n = 1; n <= 5; n++) {
				messages.push(
					userMessage(`request ${n}`, n * 3 - 2),
					{
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: `reduce-${n}`,
								name: "ctx_reduce",
								arguments: {},
							},
						],
						timestamp: n * 3 - 1,
					},
					{
						...toolResultMessage(`reduce-${n}`, `reduced ${n}`, n * 3),
						toolName: "ctx_reduce",
					},
				);
			}
			const { transcript, targets } = tagMessages(sessionId, db, messages);

			const result = applyPiHeuristicCleanup(sessionId, db, targets, messages, {
				protectedTags: 0,
				staleReduceStripEnabled: true,
			});
			transcript.commit();

			const reduceStatuses = getTagsBySession(db, sessionId)
				.filter((tag) => tag.type === "tool" && tag.toolName === "ctx_reduce")
				.sort((left, right) => left.tagNumber - right.tagNumber)
				.map((tag) => [tag.messageId, tag.status]);
			expect(result.droppedStaleReduceCalls).toBe(2);
			expect(reduceStatuses).toEqual([
				["reduce-1", "dropped"],
				["reduce-2", "dropped"],
				["reduce-3", "active"],
				["reduce-4", "active"],
				["reduce-5", "active"],
			]);
			expect(CTX_REDUCE_KEEP).toBe(3);
			expect(PI_CTX_REDUCE_KEEP).toBe(CTX_REDUCE_KEEP);
		} finally {
			closeQuietly(db);
		}
	});

	it("persists full drops for stale ctx_reduce calls and paired tool results", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-heuristic";
			const messages = [
				userMessage("older request", 1),
				{
					role: "assistant",
					content: [
						{ type: "text", text: "I will reduce now." },
						{
							type: "toolCall",
							id: "reduce-1",
							name: "ctx_reduce",
							arguments: {},
						},
					],
					timestamp: 2,
				},
				{
					...toolResultMessage("reduce-1", "reduced old tags", 3),
					toolName: "ctx_reduce",
				},
				userMessage("next request", 4),
				assistantMessage("newer answer", 5),
				userMessage("latest request", 6),
				...ctxReduceExchange("reduce-2", 7),
				...ctxReduceExchange("reduce-3", 9),
				...ctxReduceExchange("reduce-4", 11),
			];
			const tagger = createTagger();
			tagger.initFromDb(sessionId, db);
			const transcript = createPiTranscript(messages, sessionId);
			const { targets } = tagTranscript(sessionId, transcript, tagger, db);

			// The stale-reduce cutoff is maxTag - protectedTags.
			// protectedTags: 2 preserves the two newest tags.
			const result = applyPiHeuristicCleanup(sessionId, db, targets, messages, {
				protectedTags: 2,
				staleReduceStripEnabled: true,
			});
			transcript.commit();

			expect(result.droppedStaleReduceCalls).toBe(1);
			expect(
				getTagsBySession(db, sessionId)
					.filter((tag) => tag.messageId === "reduce-1")
					.map((tag) => [tag.status, tag.dropMode]),
			).toEqual([["dropped", "full"]]);

			const replayMessages = [
				userMessage("older request", 1),
				{
					role: "assistant",
					content: [
						{ type: "text", text: "I will reduce now." },
						{
							type: "toolCall",
							id: "reduce-1",
							name: "ctx_reduce",
							arguments: {},
						},
					],
					timestamp: 2,
				},
				{
					...toolResultMessage("reduce-1", "reduced old tags", 3),
					toolName: "ctx_reduce",
				},
				userMessage("next request", 4),
				assistantMessage("newer answer", 5),
				userMessage("latest request", 6),
				...ctxReduceExchange("reduce-2", 7),
				...ctxReduceExchange("reduce-3", 9),
				...ctxReduceExchange("reduce-4", 11),
			];
			const replayTranscript = createPiTranscript(replayMessages, sessionId);
			const replay = tagTranscript(sessionId, replayTranscript, tagger, db);
			applyPendingOperations(sessionId, db, replay.targets, 0);
			applyFlushedStatuses(sessionId, db, replay.targets);
			replayTranscript.commit();

			// The aggregate drop sentinel contains the target's tagId.
			// The `reduce-1` call and result share tag 3.
			expect(textOf(replayTranscript.getOutputMessages()[2] as never)).toBe(
				"[dropped §3§]",
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("drops a STALE ctx_reduce but preserves a FRESH one reusing the same callId", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-reduce-collision";
			// The two `ctx_reduce` calls reuse `callId` `reduce-1`; cleanup must distinguish them by `(owner, callId)`.
			// The older reduce-1 is stale; the newer reduce-1 must remain.
			const messages = [
				userMessage("old request", 1),
				{
					role: "assistant",
					content: [
						{ type: "text", text: "reducing (old)" },
						{
							type: "toolCall",
							id: "reduce-1",
							name: "ctx_reduce",
							arguments: {},
						},
					],
					timestamp: 2,
				},
				{
					...toolResultMessage("reduce-1", "reduced old", 3),
					toolName: "ctx_reduce",
				},
				userMessage("a", 4),
				assistantMessage("b", 5),
				userMessage("c", 6),
				assistantMessage("d", 7),
				userMessage("fresh request", 8),
				{
					role: "assistant",
					content: [
						{ type: "text", text: "reducing (fresh)" },
						{
							type: "toolCall",
							id: "reduce-1",
							name: "ctx_reduce",
							arguments: {},
						},
					],
					timestamp: 9,
				},
				{
					...toolResultMessage("reduce-1", "reduced fresh", 10),
					toolName: "ctx_reduce",
				},
				userMessage("latest", 11),
				...ctxReduceExchange("reduce-2", 12),
				...ctxReduceExchange("reduce-3", 14),
			];
			const tagger = createTagger();
			tagger.initFromDb(sessionId, db);
			const transcript = createPiTranscript(messages, sessionId);
			const { targets } = tagTranscript(sessionId, transcript, tagger, db);

			// The reused fresh call and the two newer calls remain.
			// Only the older (owner, callId) pair is reclaimable.
			const result = applyPiHeuristicCleanup(sessionId, db, targets, messages, {
				protectedTags: 3,
				staleReduceStripEnabled: true,
			});
			transcript.commit();

			// Only the older `(owner, callId)` pair is stale.
			expect(result.droppedStaleReduceCalls).toBe(1);

			// The two `ctx_reduce` tool tags share `callId` `reduce-1` but have distinct owners; cleanup must drop only the older tag.
			const reduceTags = getTagsBySession(db, sessionId)
				.filter((tag) => tag.type === "tool" && tag.messageId === "reduce-1")
				.map((tag) => tag.status);
			expect(reduceTags.filter((s) => s === "dropped")).toHaveLength(1);
			expect(reduceTags.filter((s) => s === "active")).toHaveLength(1);
		} finally {
			closeQuietly(db);
		}
	});
});

function makePiDropTarget(): TagTarget {
	const state = { present: true };
	return {
		setContent: () => false,
		drop: () => {
			if (!state.present) return "absent";
			state.present = false;
			return "removed";
		},
		canDrop: () => state.present,
	};
}

describe("applyPiHeuristicCleanup emergency floor accounting", () => {
	it("uses the post-pending-op active tag set for emergency planning", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-pi-floor-recompute";
			const targets = new Map<number, TagTarget>();
			for (let tag = 1; tag <= 4; tag++) {
				insertTag(db, sessionId, `tool-${tag}`, "tool", 4000, tag, 0, "bash");
				targets.set(tag, makePiDropTarget());
			}
			queuePendingOp(db, sessionId, 1, "drop", 1);
			queuePendingOp(db, sessionId, 2, "drop", 2);

			applyPendingOperations(sessionId, db, targets, 0);
			const activeAfterPending = getActiveTagsBySession(db, sessionId);
			applyPiHeuristicCleanup(
				sessionId,
				db,
				targets,
				[],
				{
					protectedTags: 0,
					staleReduceStripEnabled: true,
					emergency: { currentTotalInputTokens: 7000, ceilingTokens: 6000 },
				},
				activeAfterPending,
			);

			expect(
				getTagsBySession(db, sessionId).map((tag) => [
					tag.tagNumber,
					tag.status,
				]),
			).toEqual([
				[1, "dropped"],
				[2, "dropped"],
				[3, "active"],
				[4, "active"],
			]);
		} finally {
			closeQuietly(db);
		}
	});
});
