import { describe, expect, it } from "bun:test";
import { findFirstKeptEntryId } from "./pi-historian-runner";
import {
	convertEntriesToRawMessages,
	findLastModelKeyFromBranch,
	isMidTurnPi,
} from "./read-session-pi";

describe("isMidTurnPi", () => {
	it("is mid-turn when the latest assistant stopReason is toolUse", () => {
		expect(
			isMidTurnPi(
				{
					messages: [{ role: "assistant", stopReason: "toolUse", content: [] }],
				},
				"session-1",
			),
		).toBe(true);
	});

	it("is not mid-turn when a newer branch-backed user message ends a stale toolUse tail", () => {
		const assistant = { role: "assistant", stopReason: "toolUse", content: [] };
		const user = { role: "user", content: "new turn" };
		expect(
			isMidTurnPi({ messages: [assistant, user] }, "session-1", [
				{ type: "message", id: "assistant-1", message: assistant },
				{ type: "message", id: "user-1", message: user },
			]),
		).toBe(false);
	});

	it("does not release mid-turn for synthetic user-shaped model messages", () => {
		const assistant = { role: "assistant", stopReason: "toolUse", content: [] };
		const syntheticUser = { role: "user", content: "steer content" };
		expect(
			isMidTurnPi({ messages: [assistant, syntheticUser] }, "session-1", [
				{ type: "message", id: "assistant-1", message: assistant },
				{
					type: "custom_message",
					id: "steer-1",
					customType: "ctx-nudge",
					message: syntheticUser,
				},
			]),
		).toBe(true);
	});

	it("does not release mid-turn for custom-role nudges after a stale toolUse tail", () => {
		expect(
			isMidTurnPi(
				{
					messages: [
						{ role: "assistant", stopReason: "toolUse", content: [] },
						{ role: "custom", content: "agent nudge" },
					],
				},
				"session-1",
			),
		).toBe(true);
	});

	it("is mid-turn when the latest assistant has an unpaired toolCall", () => {
		expect(
			isMidTurnPi(
				{
					messages: [
						{
							role: "assistant",
							content: [{ type: "toolCall", id: "call-1", name: "bash" }],
						},
					],
				},
				"session-1",
			),
		).toBe(true);
	});

	it("is not mid-turn when a newer branch-backed user ends an unpaired toolCall tail", () => {
		const assistant = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "bash" }],
		};
		const user = { role: "user", content: "new turn" };
		expect(
			isMidTurnPi({ messages: [assistant, user] }, "session-1", [
				{ type: "message", id: "assistant-1", message: assistant },
				{ type: "message", id: "user-1", message: user },
			]),
		).toBe(false);
	});

	it("is not mid-turn when toolCall content is paired or absent", () => {
		expect(
			isMidTurnPi(
				{
					messages: [
						{
							role: "assistant",
							content: [{ type: "toolCall", id: "call-1", name: "bash" }],
						},
						{ role: "toolResult", toolCallId: "call-1", content: [] },
					],
				},
				"session-1",
			),
		).toBe(false);

		expect(
			isMidTurnPi(
				{
					messages: [
						{ role: "assistant", content: [{ type: "text", text: "done" }] },
					],
				},
				"session-1",
			),
		).toBe(false);
	});
});

describe("convertEntriesToRawMessages: synthetic-user entry-id propagation", () => {
	// Tool-result-to-assistant transitions emit synthetic user RawMessages.
	// Synthetic user RawMessages require an entry ID for chunk boundaries and compaction markers.
	//
	// A synthetic user's entry ID must remain nonempty when it is the final chunk message.
	// A synthetic user's entry ID must remain nonempty so `mapParsedCompartmentsToChunk` can set `endMessageId`.
	// `findFirstKeptEntryId` must use the same raw-message ordinal mapping as `convertEntriesToRawMessages`.
	// A null first-kept ID prevents `appendCompaction` from writing a compaction marker.
	//
	// Synthetic `RawMessage.id` values derive from the first folded `toolResult` entry ID.
	// The first folded `toolResult` entry ID identifies a real, lookup-able `SessionEntry`.

	function messageEntry(
		id: string,
		message: Record<string, unknown>,
	): Record<string, unknown> {
		return { type: "message", id, message };
	}

	it("skips current custom entries and historical ctx-status custom messages", () => {
		const entries = [
			messageEntry("user-1", { role: "user", content: "before" }),
			{
				type: "custom",
				id: "status-current",
				customType: "ctx-status",
				data: { title: "Magic Embed", text: "Embedding history…" },
			},
			{
				type: "custom_message",
				id: "status-historical",
				customType: "ctx-status",
				content: "Historical status",
				display: true,
			},
			messageEntry("asst-1", { role: "assistant", content: "after" }),
		];

		expect(
			convertEntriesToRawMessages(entries).map(({ id, role }) => ({
				id,
				role,
			})),
		).toEqual([
			{ id: "user-1", role: "user" },
			{ id: "asst-1", role: "assistant" },
		]);
	});

	it("assigns the first folded toolResult's id to a synthetic user emitted at toolResult→assistant", () => {
		const entries = [
			messageEntry("user-1", { role: "user", content: "kick off" }),
			messageEntry("asst-1", {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc-1", name: "read" }],
			}),
			messageEntry("tr-1", {
				role: "toolResult",
				toolCallId: "tc-1",
				toolName: "read",
				content: [{ type: "text", text: "output-1" }],
			}),
			messageEntry("asst-2", {
				role: "assistant",
				content: [{ type: "text", text: "follow-up" }],
			}),
		];

		const raws = convertEntriesToRawMessages(entries);

		expect(
			raws.map((r) => ({ ordinal: r.ordinal, id: r.id, role: r.role })),
		).toEqual([
			{ ordinal: 1, id: "user-1", role: "user" },
			{ ordinal: 2, id: "asst-1", role: "assistant" },
			{ ordinal: 3, id: "synth-user-tr-1", role: "user" },
			{ ordinal: 4, id: "asst-2", role: "assistant" },
		]);
	});

	it("assigns the first folded toolResult's id when multiple toolResults stack before an assistant", () => {
		const entries = [
			messageEntry("user-1", { role: "user", content: "start" }),
			messageEntry("asst-1", {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "tc-1", name: "read" },
					{ type: "toolCall", id: "tc-2", name: "read" },
				],
			}),
			messageEntry("tr-1", {
				role: "toolResult",
				toolCallId: "tc-1",
				toolName: "read",
				content: [{ type: "text", text: "out-1" }],
			}),
			messageEntry("tr-2", {
				role: "toolResult",
				toolCallId: "tc-2",
				toolName: "read",
				content: [{ type: "text", text: "out-2" }],
			}),
			// The transition folds `tr-1` and `tr-2` into one synthetic user.
			messageEntry("asst-2", { role: "assistant", content: [] }),
		];

		const raws = convertEntriesToRawMessages(entries);
		const synthetic = raws[2];
		expect(synthetic?.ordinal).toBe(3);
		expect(synthetic?.role).toBe("user");
		expect(synthetic?.id).toBe("synth-user-tr-1");
	});

	it("assigns the first folded toolResult's id to a trailing-tail synthetic user", () => {
		const entries = [
			messageEntry("user-1", { role: "user", content: "start" }),
			messageEntry("asst-1", {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc-1", name: "read" }],
			}),
			messageEntry("tr-tail", {
				role: "toolResult",
				toolCallId: "tc-1",
				toolName: "read",
				content: [{ type: "text", text: "tail" }],
			}),
			// A trailing `toolResult` sequence emits a synthetic user.
		];

		const raws = convertEntriesToRawMessages(entries);
		const tail = raws[raws.length - 1];
		expect(tail?.ordinal).toBe(3);
		expect(tail?.role).toBe("user");
		expect(tail?.id).toBe("synth-user-tr-tail");
	});

	it("clears pending state after a real user folds toolResults", () => {
		// A real user message folds pending `toolResult` entries without emitting a synthetic user `RawMessage`.
		// Emission clears pending tool results so later synthetic users cannot reuse their IDs.
		const entries = [
			messageEntry("asst-1", {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc-1", name: "read" }],
			}),
			messageEntry("tr-1", {
				role: "toolResult",
				toolCallId: "tc-1",
				toolName: "read",
				content: [{ type: "text", text: "x" }],
			}),
			messageEntry("real-user", { role: "user", content: "next" }),
			messageEntry("asst-2", {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc-2", name: "read" }],
			}),
			messageEntry("tr-2", {
				role: "toolResult",
				toolCallId: "tc-2",
				toolName: "read",
				content: [{ type: "text", text: "y" }],
			}),
			messageEntry("asst-3", { role: "assistant", content: [] }),
		];

		const raws = convertEntriesToRawMessages(entries);
		// Expected:
		//   1: asst-1
		//   3: asst-2
		//   5: asst-3
		expect(
			raws.map((r) => ({ ordinal: r.ordinal, id: r.id, role: r.role })),
		).toEqual([
			{ ordinal: 1, id: "asst-1", role: "assistant" },
			{ ordinal: 2, id: "real-user", role: "user" },
			{ ordinal: 3, id: "asst-2", role: "assistant" },
			{ ordinal: 4, id: "synth-user-tr-2", role: "user" },
			{ ordinal: 5, id: "asst-3", role: "assistant" },
		]);
	});

	it("reproduces the user-session ordinal divergence: every RawMessage has a non-empty id", () => {
		// Every `RawMessage` has a nonempty `id`, including synthetic users.
		//
		const entries: Array<Record<string, unknown>> = [
			messageEntry("u-0", { role: "user", content: "go" }),
		];
		for (let i = 1; i <= 50; i++) {
			entries.push(
				messageEntry(`a-${i}`, {
					role: "assistant",
					content: [{ type: "toolCall", id: `tc-${i}`, name: "read" }],
				}),
				messageEntry(`tr-${i}`, {
					role: "toolResult",
					toolCallId: `tc-${i}`,
					toolName: "read",
					content: [{ type: "text", text: `out-${i}` }],
				}),
			);
		}
		entries.push(
			messageEntry("a-final", {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
			}),
		);

		const raws = convertEntriesToRawMessages(entries);

		const empties = raws.filter((r) => !r.id || r.id.length === 0);
		expect(empties).toEqual([]);

		// Ordinals are contiguous from 1.
		const ordinals = raws.map((r) => r.ordinal);
		expect(ordinals[0]).toBe(1);
		for (let i = 1; i < ordinals.length; i++) {
			const prev = ordinals[i - 1] ?? 0;
			const cur = ordinals[i] ?? 0;
			expect(cur).toBe(prev + 1);
		}

		const syntheticUsers = raws.filter(
			(r, idx) =>
				r.role === "user" &&
				idx > 0 &&
				raws[idx - 1] !== undefined &&
				raws[idx - 1]?.role === "assistant" &&
				r.id.startsWith("synth-user-tr-"),
		);
		expect(syntheticUsers.length).toBe(50);
	});
});

describe("findFirstKeptEntryId — replay-safe boundary resolution", () => {
	function messageEntry(
		id: string,
		message: Record<string, unknown>,
	): Record<string, unknown> {
		return { type: "message", id, message };
	}

	// `${PREFIX}tr-1`), 4=asst-2.
	const entries = [
		messageEntry("u-0", { role: "user", content: "go" }),
		messageEntry("asst-1", {
			role: "assistant",
			content: [{ type: "toolCall", id: "tc-1", name: "read" }],
		}),
		messageEntry("tr-1", {
			role: "toolResult",
			toolCallId: "tc-1",
			toolName: "read",
			content: [{ type: "text", text: "out" }],
		}),
		messageEntry("asst-2", {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
		}),
	];

	it("returns a real entry id when the boundary lands on a normal message", () => {
		// A boundary after ordinal 1 makes ordinal 2 (`asst-1`) the kept-tail start.
		expect(findFirstKeptEntryId(entries, 1)).toBe("asst-1");
	});

	it("DEFERS (null) when the kept-start ordinal is a folded-toolResult synthetic user", () => {
		// A boundary after ordinal 2 makes ordinal 3 the kept-tail start.
		// Ordinal 3 is the synthetic user that folds `tr-1`.
		// The folded `toolResult` run remains unsummarized kept-tail content.
		// Advancing the boundary to `asst-2` would drop the folded `toolResult` run instead of summarizing or retaining it.
		// `appendCompaction` must wait until a real entry heads the kept tail before writing a compaction marker.
		expect(findFirstKeptEntryId(entries, 2)).toBeNull();
	});

	it("defers (null) when only folded tool-result tails remain after the boundary", () => {
		const tailEntries = [
			messageEntry("u-0", { role: "user", content: "go" }),
			messageEntry("asst-1", {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc-1", name: "read" }],
			}),
			messageEntry("tr-1", {
				role: "toolResult",
				toolCallId: "tc-1",
				toolName: "read",
				content: [{ type: "text", text: "out" }],
			}),
		];
		// A boundary after ordinal 2 leaves only the synthetic user that folds tr-1.
		// No replay-safe real entry remains, so findFirstKeptEntryId returns null.
		expect(findFirstKeptEntryId(tailEntries, 2)).toBeNull();
	});
});

describe("findLastModelKeyFromBranch", () => {
	it("returns the LAST model_change as provider/modelId", () => {
		const entries = [
			{ type: "model_change", provider: "openai", modelId: "gpt-5.4" },
			{ type: "message", id: "m1", message: { role: "user" } },
			{ type: "model_change", provider: "anthropic", modelId: "opus-4-8" },
			{ type: "message", id: "m2", message: { role: "assistant" } },
		];
		expect(findLastModelKeyFromBranch(entries)).toBe("anthropic/opus-4-8");
	});

	it("returns undefined when there is no model_change entry (no-regression path)", () => {
		const entries = [
			{ type: "message", id: "m1", message: { role: "user" } },
			{ type: "message", id: "m2", message: { role: "assistant" } },
		];
		expect(findLastModelKeyFromBranch(entries)).toBeUndefined();
	});

	it("ignores malformed model_change entries (missing provider/modelId)", () => {
		expect(
			findLastModelKeyFromBranch([
				{ type: "model_change", provider: "openai" },
			]),
		).toBeUndefined();
		expect(findLastModelKeyFromBranch([])).toBeUndefined();
		expect(findLastModelKeyFromBranch(null)).toBeUndefined();
		expect(findLastModelKeyFromBranch(undefined)).toBeUndefined();
	});
});
