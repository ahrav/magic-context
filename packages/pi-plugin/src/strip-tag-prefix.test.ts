import { describe, expect, it } from "bun:test";
import { stripTagPrefixFromAssistantMessage } from "./strip-tag-prefix";

describe("stripTagPrefixFromAssistantMessage", () => {
	describe("leading tag prefix (canonical MC tagger mimicry)", () => {
		// Each row is one single-text-part assistant message: the leading-tag
		// scrub must report a mutation and leave exactly the expected text.
		it.each([
			[
				"strips a single §N§ prefix from assistant text",
				"§4§ Yes. I can see the magic context.",
				"Yes. I can see the magic context.",
			],
			[
				"strips consecutive §N§ prefixes (model-mimicked sequence)",
				"§3§ §4§ §5§ Hello world",
				"Hello world",
			],
			["strips trailing whitespace after the prefix", "§4§   \n\nYes", "Yes"],
			["strips multi-digit tag IDs", "§38773§ Found it.", "Found it."],
		] as Array<[string, string, string]>)("%s", (_title, input, expected) => {
			const msg = {
				role: "assistant",
				content: [{ type: "text", text: input }],
			};
			expect(stripTagPrefixFromAssistantMessage(msg)).toBe(true);
			expect((msg.content[0] as { type: string; text: string }).text).toBe(
				expected,
			);
		});
	});

	describe("cargo-culted § mid-text (models mimicking MC notation)", () => {
		// Cargo-cult defense rows: § notation appearing mid-text (not as a
		// leading tag) must be scrubbed wherever it appears.
		it.each([
			[
				"removes mid-text §N§ pair entirely (cargo-cult defense)",
				"Looking at §5§ which references the earlier discussion",
				"Looking at  which references the earlier discussion",
			],
			[
				'removes malformed §N"> hybrid mid-text',
				'Hello §40827">Oracle confirmed',
				"Hello Oracle confirmed",
			],
			[
				"strips stray § character anywhere",
				"See § marker for details",
				"See  marker for details",
			],
			[
				"strips both leading prefix and mid-text § in same message",
				"§42§ The pattern §40827§ appeared.",
				"The pattern  appeared.",
			],
		] as Array<[string, string, string]>)("%s", (_title, input, expected) => {
			const msg = {
				role: "assistant",
				content: [{ type: "text", text: input }],
			};
			expect(stripTagPrefixFromAssistantMessage(msg)).toBe(true);
			expect((msg.content[0] as { type: string; text: string }).text).toBe(
				expected,
			);
		});
	});

	describe("scope guards", () => {
		it("does NOT strip prefix on user messages", () => {
			const msg = {
				role: "user",
				content: [{ type: "text", text: "§4§ Hello from user" }],
			};
			expect(stripTagPrefixFromAssistantMessage(msg)).toBe(false);
			expect((msg.content[0] as { type: string; text: string }).text).toBe(
				"§4§ Hello from user",
			);
		});

		it("does NOT strip prefix on tool result messages", () => {
			const msg = {
				role: "toolResult",
				content: [{ type: "text", text: "§7§ tool output" }],
			};
			expect(stripTagPrefixFromAssistantMessage(msg)).toBe(false);
		});

		it("strips across multiple text parts in a single message", () => {
			const msg = {
				role: "assistant",
				content: [
					{ type: "text", text: "§4§ First chunk" },
					{ type: "text", text: "§4§ Second chunk" },
				],
			};
			expect(stripTagPrefixFromAssistantMessage(msg)).toBe(true);
			expect((msg.content[0] as { type: string; text: string }).text).toBe(
				"First chunk",
			);
			expect((msg.content[1] as { type: string; text: string }).text).toBe(
				"Second chunk",
			);
		});

		it("ignores non-text parts (thinking, toolCall, image)", () => {
			const msg = {
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "§4§ pretend reasoning, not stripped",
					},
					{ type: "text", text: "§4§ Real assistant text" },
					{
						type: "toolCall",
						id: "t1",
						name: "ctx_search",
						arguments: {},
					},
				],
			};
			expect(stripTagPrefixFromAssistantMessage(msg)).toBe(true);
			expect((msg.content[1] as { type: string; text: string }).text).toBe(
				"Real assistant text",
			);
			// stripTagPrefixFromAssistantMessage scrubs only text parts.
			expect(
				(msg.content[0] as { type: string; thinking: string }).thinking,
			).toBe("§4§ pretend reasoning, not stripped");
		});
	});

	describe("no-op cases", () => {
		it("returns false when no text parts have any §", () => {
			const msg = {
				role: "assistant",
				content: [{ type: "text", text: "Plain response without any prefix" }],
			};
			expect(stripTagPrefixFromAssistantMessage(msg)).toBe(false);
		});

		it("handles empty content array gracefully", () => {
			const msg = { role: "assistant", content: [] };
			expect(stripTagPrefixFromAssistantMessage(msg)).toBe(false);
		});

		it("handles non-array content gracefully", () => {
			const msg = { role: "assistant", content: "§4§ legacy string" };
			expect(stripTagPrefixFromAssistantMessage(msg)).toBe(false);
			expect(msg.content).toBe("§4§ legacy string");
		});
	});
});
