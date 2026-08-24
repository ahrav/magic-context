import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { insertMemory } from "@magic-context/core/features/magic-context/memory";
import { sha256Utf8Hex } from "@magic-context/core/features/magic-context/memory/storage-claims";
import {
	runInMemoryClaimsWriteTransaction,
	updateMemoryContentWithClaimsInCurrentTransaction,
	updateMemoryVerificationWithClaimsInCurrentTransaction,
} from "@magic-context/core/features/magic-context/memory/storage-memory-claims";
import type { UnifiedSearchResult } from "@magic-context/core/features/magic-context/search";
import * as searchModule from "@magic-context/core/features/magic-context/search";
import {
	appendAutoSearchHintDecision,
	getAutoSearchHintDecisions,
} from "@magic-context/core/features/magic-context/storage";
import type { Database as DatabaseType } from "@magic-context/core/shared/sqlite";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	clearAutoSearchForPiSession,
	runAutoSearchHintForPi,
} from "./auto-search-pi";
import { createTestDb, textOf, userMessage } from "./test-utils.test";

const baseOptions = {
	enabled: true,
	scoreThreshold: 0.6,
	minPromptChars: 12,
	projectPath: "git:test",
	memoryEnabled: true,
	embeddingEnabled: false,
	gitCommitsEnabled: false,
};

function memoryResult(
	score = 0.9,
	content = "historian cache wiring details",
	memoryId = 1,
	contentDigest?: string,
): UnifiedSearchResult {
	return {
		source: "memory",
		content,
		score,
		memoryId,
		category: "WORKFLOW_RULES",
		matchType: "fts",
		...(contentDigest === undefined ? {} : { contentDigest }),
	};
}

/** A real claim-backed memory plus the search result the lane would emit for
 * it: fresh hints pass the same eligibility gate as replays, so mocked
 * results need a policy-eligible id and the digest of the loaded bytes. */
function seedEligibleMemory(
	db: DatabaseType,
	content = "historian cache wiring details",
): { id: number; digest: string; result: UnifiedSearchResult } {
	const seeded = insertMemory(db, {
		projectPath: "git:test",
		category: "WORKFLOW_RULES",
		content,
	});
	// A fresh insert is a CANDIDATE (auto-ineligible); the auto-search lane
	// only surfaces verified rows, so promote the seed the same way.
	runInMemoryClaimsWriteTransaction(db, () =>
		updateMemoryVerificationWithClaimsInCurrentTransaction(
			db,
			{
				producer: "auto-search-pi-test",
				operationKey: `verify:${seeded.id}`,
				requestDigest: sha256Utf8Hex(`verify:${seeded.id}`),
			},
			{ memoryId: seeded.id, verificationStatus: "verified", nowMs: 2_000 },
		),
	);
	const digest = sha256Utf8Hex(content);
	return {
		id: seeded.id,
		digest,
		result: memoryResult(0.9, content, seeded.id, digest),
	};
}

describe("runAutoSearchHintForPi", () => {
	afterEach(() => {
		clearAutoSearchForPiSession("ses-auto");
		clearAutoSearchForPiSession("ses-auto-2");
	});

	it("reuses the per-turn cached hint for the same user message id", async () => {
		const db = createTestDb();
		// A message-source fragment carries no memory ids, so the persisted
		// hint replays without a policy lookup; memory-backed replay gating
		// is covered by the persisted-hints policy test below.
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async () => [
				{
					source: "message",
					content: "historian cache wiring details",
					score: 0.9,
					messageOrdinal: 1,
					messageId: "m-hist",
					role: "assistant",
				},
			],
		);
		try {
			const firstMessages = [
				userMessage("explain the historian cache wiring", 1),
			];
			await runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages: firstMessages,
				options: baseOptions,
			});

			const replayMessages = [
				userMessage("explain the historian cache wiring", 1),
			];
			await runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages: replayMessages,
				options: baseOptions,
			});

			expect(spy).toHaveBeenCalledTimes(1);
			expect(textOf(replayMessages[0])).toContain("<ctx-search-hint>");
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("suppresses a persisted hint whose contributing memory is no longer eligible", async () => {
		const db = createTestDb();
		const seeded = seedEligibleMemory(db);
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async () => [seeded.result],
		);
		try {
			const firstMessages = [
				userMessage("explain the historian cache wiring", 1),
			];
			await runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages: firstMessages,
				options: baseOptions,
			});
			expect(textOf(firstMessages[0])).toContain("<ctx-search-hint>");

			// An in-place rewrite changes the exact content digest, so the
			// replay pass must suppress the persisted hint instead of
			// re-serving a fragment bound to bytes that no longer exist.
			runInMemoryClaimsWriteTransaction(db, () =>
				updateMemoryContentWithClaimsInCurrentTransaction(
					db,
					{
						producer: "auto-search-pi-test",
						operationKey: `rewrite:${seeded.id}`,
						requestDigest: sha256Utf8Hex(`rewrite:${seeded.id}`),
					},
					{
						memoryId: seeded.id,
						content: "rewritten after the hint was persisted",
						normalizedHash: "hash:rewritten",
					},
				),
			);
			const replayMessages = [
				userMessage("explain the historian cache wiring", 1),
			];
			await runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages: replayMessages,
				options: baseOptions,
			});
			expect(spy).toHaveBeenCalledTimes(1);
			expect(textOf(replayMessages[0])).not.toContain("<ctx-search-hint>");
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("excludes Primers from transform-time auto-search hints", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async () => [],
		);
		try {
			await runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages: [
					userMessage("explain how durable primer questions are maintained", 1),
				],
				options: baseOptions,
			});

			const options = spy.mock.calls[0]?.[4];
			expect(options?.sources).toEqual(["memory", "message", "git_commit"]);
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("replays persisted hints but skips fresh decisions when strict entry ids fail", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async () => [memoryResult()],
		);
		try {
			appendAutoSearchHintDecision(db, "ses-auto", {
				messageId: "entry-replay",
				decision: "hint",
				text: "\n\n<ctx-search-hint>stored hint</ctx-search-hint>",
				// No memory fragments contributed, so replay needs no policy check.
				memoryFragments: [],
			});
			const replay = [
				{ ...userMessage("explain cached hint", 1), id: "entry-replay" },
			];
			await runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages: replay as never,
				entryIds: null,
				options: baseOptions,
			});
			expect(textOf(replay[0] as never)).toContain("stored hint");

			const fresh = [
				{ ...userMessage("explain new hint", 2), id: "entry-fresh" },
			];
			await runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages: fresh as never,
				entryIds: null,
				options: baseOptions,
			});

			expect(spy).not.toHaveBeenCalled();
			expect(textOf(fresh[0] as never)).not.toContain("<ctx-search-hint>");
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("resolves the anchor by reference when the positional entryIds is stale (post-splice)", async () => {
		// Simulates the runPipeline splice: `entryIds` was resolved against a
		// PRE-splice array where the latest user message sat at a higher index.
		// After the splice, the latest user message is at index 0 of the current
		// array, but the stale positional entryIds[0] points at a DIFFERENT,
		// now-removed message's id ("entry-OLD-WRONG"). The reference-keyed map
		// must win and anchor the hint to the real id ("entry-REAL").
		const db = createTestDb();
		const seeded = seedEligibleMemory(db);
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async () => [seeded.result],
		);
		try {
			const latest = userMessage("explain the historian cache wiring", 1);
			const currentMessages = [latest];
			// Stale positional array (wrong id at index 0).
			const stalePositionalEntryIds = ["entry-OLD-WRONG"];
			// Splice-safe reference map: the actual current message -> real id.
			const entryIdByRef = new Map<object, string>([
				[latest as object, "entry-REAL"],
			]);

			await runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages: currentMessages,
				entryIds: stalePositionalEntryIds,
				entryIdByRef,
				options: baseOptions,
			});

			// The hint was injected onto the latest message...
			expect(textOf(currentMessages[0])).toContain("<ctx-search-hint>");
			// ...and the persisted decision is keyed to the REAL id, not the stale
			// positional one — proving reference resolution took precedence.
			const decisions = getAutoSearchHintDecisions(db, "ses-auto");
			expect(decisions.some((d) => d.messageId === "entry-REAL")).toBe(true);
			expect(decisions.some((d) => d.messageId === "entry-OLD-WRONG")).toBe(
				false,
			);
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("does NOT fall back to stale positional entryIds when the ref-map MISSES", async () => {
		// When a ref-map is supplied but the current latest user message is NOT in
		// it (e.g. an injection-cloned object, or a synthetic prepend), the resolver
		// must treat it as unresolved — NOT silently use the stale positional
		// entryIds[i], which after a splice points at a different message. A wrong
		// anchor would persist a decision against the wrong turn and replay the hint
		// onto the wrong message on later passes.
		const db = createTestDb();
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async () => [memoryResult()],
		);
		try {
			const latest = userMessage("explain the historian cache wiring", 1);
			const currentMessages = [latest];
			const stalePositionalEntryIds = ["entry-STALE-WRONG"];
			// Ref-map present but does NOT contain `latest` (simulates a clone/
			// synthetic the map was not built for).
			const entryIdByRef = new Map<object, string>([
				[{} as object, "entry-SOMETHING-ELSE"],
			]);

			await runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages: currentMessages,
				entryIds: stalePositionalEntryIds,
				entryIdByRef,
				options: baseOptions,
			});

			// No hint injected (unresolved → degraded, no fresh anchor)...
			expect(textOf(currentMessages[0])).not.toContain("<ctx-search-hint>");
			// ...and crucially NO decision was persisted to the stale positional id.
			const decisions = getAutoSearchHintDecisions(db, "ses-auto");
			expect(decisions.some((d) => d.messageId === "entry-STALE-WRONG")).toBe(
				false,
			);
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("runs a fresh search for a new user message id", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async () => [memoryResult()],
		);
		try {
			await runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages: [userMessage("first long prompt", 1)],
				options: baseOptions,
			});
			await runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages: [userMessage("second long prompt", 2)],
				options: baseOptions,
			});

			expect(spy).toHaveBeenCalledTimes(2);
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("does not append a hint when top score is below threshold", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async () => [memoryResult(0.2)],
		);
		try {
			const messages = [userMessage("long prompt with weak matches", 1)];

			await runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages,
				options: baseOptions,
			});

			expect(spy).toHaveBeenCalledTimes(1);
			expect(textOf(messages[0])).not.toContain("<ctx-search-hint>");
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("skips empty user messages", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async () => [memoryResult()],
		);
		try {
			await runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages: [userMessage("   ", 1)],
				options: baseOptions,
			});

			expect(spy).toHaveBeenCalledTimes(0);
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("skips stacked sidekick augmentation without searching", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async () => [memoryResult()],
		);
		try {
			const messages = [
				userMessage(
					"Implement this\n\n<sidekick-augmentation>context</sidekick-augmentation>",
					1,
				),
			];

			await runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages,
				options: baseOptions,
			});

			expect(spy).toHaveBeenCalledTimes(0);
			expect(textOf(messages[0])).not.toContain("<ctx-search-hint>");
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("strips plugin markers from the prompt before searching", async () => {
		const db = createTestDb();
		let capturedPrompt = "";
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async (_db, _session, _project, prompt) => {
				capturedPrompt = prompt;
				return [];
			},
		);
		try {
			const messages = [
				userMessage(
					[
						"§42§ <!-- +5m -->",
						"<system-reminder>outer <system-reminder>inner</system-reminder> tail</system-reminder>",
						"</system-reminder>",
						'<instruction name="ctx_reduce_turn_cleanup">drop</instruction>',
						"<custom-tag>actual project prompt survives</custom-tag>",
						"<!-- arbitrary <tag> commented noise -->",
						"<!-- OMO_INTERNAL_INITIATOR -->",
						"<!-- ALFONSO_INTERNAL_INITIATOR -->",
					].join("\n"),
					1,
				),
			];

			await runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages,
				options: baseOptions,
			});

			expect(capturedPrompt).toBe("actual project prompt survives");
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("does not persist no-hint decisions for retryable search errors", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async () => {
				throw new Error("temporary search failure");
			},
		);
		try {
			const messages = [userMessage("explain the historian cache wiring", 1)];

			await runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages,
				options: baseOptions,
			});
			await runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages,
				options: baseOptions,
			});

			expect(spy).toHaveBeenCalledTimes(2);
			expect(getAutoSearchHintDecisions(db, "ses-auto")).toHaveLength(0);
			expect(textOf(messages[0])).not.toContain("<ctx-search-hint>");
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("does not persist no-hint decisions for retryable search timeouts", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			() => new Promise<UnifiedSearchResult[]>(() => undefined),
		);
		try {
			const messages = [userMessage("explain the historian cache wiring", 1)];
			const started = Date.now();
			await runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages,
				options: baseOptions,
			});
			const elapsed = Date.now() - started;

			expect(elapsed).toBeLessThan(4_000);
			expect(getAutoSearchHintDecisions(db, "ses-auto")).toHaveLength(0);
			expect(textOf(messages[0])).not.toContain("<ctx-search-hint>");

			await runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages,
				options: baseOptions,
			});
			expect(spy).toHaveBeenCalledTimes(2);
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	}, 10_000);

	it("does not double-append an already present cached hint", async () => {
		const db = createTestDb();
		const seeded = seedEligibleMemory(db);
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async () => [seeded.result],
		);
		try {
			const messages = [userMessage("explain the historian cache wiring", 1)];

			await runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages,
				options: baseOptions,
			});
			await runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages,
				options: baseOptions,
			});

			expect(spy).toHaveBeenCalledTimes(1);
			expect(textOf(messages[0]).match(/<ctx-search-hint>/g)).toHaveLength(1);
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});
});
