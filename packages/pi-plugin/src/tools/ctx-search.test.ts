import { describe, expect, it, spyOn } from "bun:test";
import type { UnifiedSearchResult } from "@magic-context/core/features/magic-context/search";
import * as searchModule from "@magic-context/core/features/magic-context/search";
import { renderToolStateText } from "@magic-context/core/shared/kernel-client";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	createTestDb,
	fakeContext,
	fakeKernelResolver,
} from "../test-utils";
import { createCtxSearchTool } from "./ctx-search";

describe("createCtxSearchTool", () => {
	it("rejects an over-cap query with the native isError envelope before any work (AE1)", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "unifiedSearch");
		try {
			const tool = createCtxSearchTool({
				db,
				kernelClient: fakeKernelResolver().kernelClient,
				memoryEnabled: true,
				embeddingEnabled: false,
				gitCommitsEnabled: false,
				resolveProjectIdentity: () => {
					throw new Error("preflight must run before project resolution");
				},
			});

			const byteResult = await tool.execute(
				"call-overcap",
				{ query: "a".repeat(16 * 1024 + 1) },
				new AbortController().signal,
				undefined,
				fakeContext("ses-overcap") as never,
			);
			expect(byteResult.isError).toBe(true);
			expect(byteResult.content[0]?.text).toStartWith(
				"Error: query is too large:",
			);

			const atomResult = await tool.execute(
				"call-overcap-atoms",
				{
					query: Array.from({ length: 65 }, (_, index) => `a${index}`).join(
						" ",
					),
				},
				new AbortController().signal,
				undefined,
				fakeContext("ses-overcap") as never,
			);
			expect(atomResult.isError).toBe(true);
			expect(atomResult.content[0]?.text).toStartWith(
				"Error: query is too complex:",
			);

			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("clamps an over-cap limit to 50 instead of rejecting (Pi parity)", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "unifiedSearch").mockResolvedValue([]);
		try {
			const tool = createCtxSearchTool({
				db,
				kernelClient: fakeKernelResolver().kernelClient,
				memoryEnabled: false,
				embeddingEnabled: false,
				gitCommitsEnabled: false,
				resolveProjectIdentity: () => "git:test",
			});
			await tool.execute(
				"call-clamp",
				{ query: "clamped", limit: 10_000 },
				new AbortController().signal,
				undefined,
				fakeContext("ses-clamp") as never,
			);
			expect(spy).toHaveBeenCalledTimes(1);
			const options = spy.mock.calls[0]?.[4] as { limit?: number };
			expect(options.limit).toBe(50);
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("prints ctx_expand ranges and footer for message search hits", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async () =>
				[
					{
						source: "message",
						content: "prior conversation detail",
						score: 0.87,
						messageOrdinal: 12,
						role: "user",
						matchType: "fts",
					},
				] as UnifiedSearchResult[],
		);
		try {
			const tool = createCtxSearchTool({
				db,
				kernelClient: fakeKernelResolver().kernelClient,
				memoryEnabled: false,
				embeddingEnabled: false,
				gitCommitsEnabled: false,
			});

			const result = await tool.execute(
				"call-1",
				{ query: "prior detail", sources: ["message"] },
				new AbortController().signal,
				undefined,
				fakeContext("ses-search") as never,
			);

			const text = result.content[0]?.text ?? "";
			expect(text).toContain("ordinal=12 range=9-15 role=user");
			expect(text).toContain(
				"Use ctx_expand(start, end) with the range from any message result above",
			);
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("accepts note sources and renders note anchors", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async (_db, _sessionId, _project, _query, options) => {
				expect(options?.sources).toEqual(["note"]);
				return [
					{
						source: "note",
						content:
							"Decision: keep the compatibility shim for one more release.",
						score: 0.91,
						noteId: 5,
						status: "ready",
						createdAt: Date.now() - 24 * 60 * 60 * 1000,
						anchorOrdinal: 21,
						sourceSessionId: "ses-search",
					},
				] as UnifiedSearchResult[];
			},
		);
		try {
			const tool = createCtxSearchTool({
				db,
				kernelClient: fakeKernelResolver().kernelClient,
				memoryEnabled: false,
				embeddingEnabled: false,
				gitCommitsEnabled: false,
			});

			const result = await tool.execute(
				"call-2",
				{ query: "compatibility shim", sources: ["note"] },
				new AbortController().signal,
				undefined,
				fakeContext("ses-search") as never,
			);

			const text = result.content[0]?.text ?? "";
			expect(text).toContain("id=#5 status=ready");
			expect(text).toContain("@msg 21");
			expect(text).toContain(
				"Use ctx_expand(start=N-10, end=N) around any note @msg anchor above",
			);
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("omits note anchors and footer hints for foreign-session smart notes", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async () =>
				[
					{
						source: "note",
						content:
							"Foreign session note should not expose an expandable anchor.",
						score: 0.72,
						noteId: 6,
						status: "ready",
						createdAt: Date.now(),
						anchorOrdinal: 22,
						sourceSessionId: "ses-other",
					},
				] as UnifiedSearchResult[],
		);
		try {
			const tool = createCtxSearchTool({
				db,
				kernelClient: fakeKernelResolver().kernelClient,
				memoryEnabled: false,
				embeddingEnabled: false,
				gitCommitsEnabled: false,
			});

			const result = await tool.execute(
				"call-3",
				{ query: "foreign anchor", sources: ["note"] },
				new AbortController().signal,
				undefined,
				fakeContext("ses-search") as never,
			);

			const text = result.content[0]?.text ?? "";
			expect(text).toContain("id=#6 status=ready");
			expect(text).not.toContain("@msg 22");
			expect(text).not.toContain(
				"Use ctx_expand(start=N-10, end=N) around any note @msg anchor above",
			);
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("falls through to local search when no object id matches (Pi parity)", async () => {
		const db = createTestDb();
		let calls = 0;
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async () => {
				calls += 1;
				return [
					{
						source: "message",
						content: "Fallback text search hit.",
						score: 0.5,
						messageOrdinal: 4,
						role: "user",
						matchType: "fts",
					},
				] as UnifiedSearchResult[];
			},
		);
		try {
			const tool = createCtxSearchTool({
				db,
				kernelClient: fakeKernelResolver().kernelClient,
				memoryEnabled: true,
				embeddingEnabled: false,
				gitCommitsEnabled: false,
			});

			const result = await tool.execute(
				"call-id",
				{ query: `mem_${"9".repeat(32)} mem_${"8".repeat(32)}` },
				new AbortController().signal,
				undefined,
				fakeContext("ses-search", process.cwd()) as never,
			);

			expect(result.content[0]?.text ?? "").toContain(
				"Fallback text search hit.",
			);
			expect(calls).toBe(1);
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("resolves an object-id query from the kernel without calling unifiedSearch (Pi parity)", async () => {
		const db = createTestDb();
		const fake = fakeKernelResolver();
		const objectId = `mem_${"a".repeat(32)}`;
		fake.kernel.seedDecision({
			object_id: objectId,
			decision_kind: "USER_DIRECTIVES",
			summary: "Direct id hit for the short-circuit.",
		});
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async () => {
				throw new Error(
					"unifiedSearch must not run for object-id queries",
				);
			},
		);
		try {
			const tool = createCtxSearchTool({
				db,
				kernelClient: fake.kernelClient,
				memoryEnabled: true,
				embeddingEnabled: false,
				gitCommitsEnabled: false,
			});

			const result = await tool.execute(
				"call-id",
				{ query: objectId },
				new AbortController().signal,
				undefined,
				fakeContext("ses-search", process.cwd()) as never,
			);

			const text = result.content[0]?.text ?? "";
			expect(text).toContain("[1] [memory]");
			expect(text).toContain(objectId);
			expect(text).toContain("Direct id hit for the short-circuit.");
			expect(fake.transport.methods()).toEqual(["kernel.read"]);
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("renders the memory state text when the daemon is absent", async () => {
		const db = createTestDb();
		const fake = fakeKernelResolver();
		fake.transport.fileExists = false;
		const spy = spyOn(searchModule, "unifiedSearch").mockResolvedValue([]);
		try {
			const tool = createCtxSearchTool({
				db,
				kernelClient: fake.kernelClient,
				memoryEnabled: true,
				embeddingEnabled: false,
				gitCommitsEnabled: false,
			});
			const memoryOnly = await tool.execute(
				"call-absent",
				{ query: "anything", sources: ["memory"] },
				new AbortController().signal,
				undefined,
				fakeContext("ses-search", process.cwd()) as never,
			);
			expect(memoryOnly.isError).toBe(true);
			expect(memoryOnly.content[0]?.text).toBe(
				`Error: ${renderToolStateText({ kind: "unavailable", reason: "daemon_absent" })}`,
			);
			const mixed = await tool.execute(
				"call-absent-mixed",
				{ query: "anything" },
				new AbortController().signal,
				undefined,
				fakeContext("ses-search", process.cwd()) as never,
			);
			expect(mixed.isError).toBeUndefined();
			expect(mixed.content[0]?.text).toStartWith(
				`Memory: ${renderToolStateText({ kind: "unavailable", reason: "daemon_absent" })}`,
			);
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});
});
