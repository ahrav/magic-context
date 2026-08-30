import { describe, expect, it, spyOn } from "bun:test";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import type { UnifiedSearchResult } from "@magic-context/core/features/magic-context/search";
import * as searchModule from "@magic-context/core/features/magic-context/search";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { createTestDb, fakeContext } from "../test-utils";
import { createCtxSearchTool } from "./ctx-search";

describe("createCtxSearchTool", () => {
	it("rejects an over-cap query with the native isError envelope before any work (AE1)", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "unifiedSearch");
		try {
			const tool = createCtxSearchTool({
				db,
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

	it("invokes normal search exactly once when every requested id is missing (Pi parity)", async () => {
		const db = createTestDb();
		let calls = 0;
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async () => {
				calls += 1;
				return [
					{
						source: "memory",
						content: "Fallback text search hit.",
						score: 0.5,
						memoryId: 1,
						category: "USER_DIRECTIVES",
						matchType: "fts",
					},
				] as UnifiedSearchResult[];
			},
		);
		try {
			const tool = createCtxSearchTool({
				db,
				memoryEnabled: true,
				embeddingEnabled: false,
				gitCommitsEnabled: false,
			});

			const result = await tool.execute(
				"call-id",
				{ query: "999999 888888" },
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

	it("resolves a locator query directly without calling unifiedSearch (Pi parity)", async () => {
		// `createTestDb` already installs the claim-memory schema; installing it
		// again here throws "table claim_public_ids already exists".
		const db = createTestDb();
		const { seedProjectMemoryClaim } = await import(
			"@magic-context/core/features/magic-context/test-claim-database"
		);
		const projectIdentity = resolveProjectIdentity(process.cwd());
		const claim = seedProjectMemoryClaim(db, {
			projectIdentity,
			category: "USER_DIRECTIVES",
			content: "Direct id hit for the short-circuit.",
		});
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async () => {
				throw new Error(
					"unifiedSearch must not run for locator-shaped queries",
				);
			},
		);
		try {
			const tool = createCtxSearchTool({
				db,
				memoryEnabled: true,
				embeddingEnabled: false,
				gitCommitsEnabled: false,
			});

			const result = await tool.execute(
				"call-id",
				{ query: claim.publicClaimId },
				new AbortController().signal,
				undefined,
				fakeContext("ses-search", process.cwd()) as never,
			);

			const text = result.content[0]?.text ?? "";
			expect(text).toContain("[1] [memory]");
			expect(text).toContain(`id=${claim.publicClaimId}`);
			expect(text).toContain("Direct id hit for the short-circuit.");
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});
});
