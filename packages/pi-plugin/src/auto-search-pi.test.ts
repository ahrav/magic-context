import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { renderAntiMemoryContent } from "@magic-context/core/features/magic-context/memory/anti-memory-content";
import { ANTI_MEMORY_CATEGORY } from "@magic-context/core/features/magic-context/memory/constants";
import type { UnifiedSearchResult } from "@magic-context/core/features/magic-context/search";
import * as searchModule from "@magic-context/core/features/magic-context/search";
import {
	appendAutoSearchHintDecision,
	getAutoSearchHintDecisions,
} from "@magic-context/core/features/magic-context/storage";
import { unavailable } from "@magic-context/core/shared/kernel-client";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	clearAutoSearchForPiSession,
	runAutoSearchHintForPi,
} from "./auto-search-pi";
import {
	createTestDb,
	fakeKernelResolver,
	textOf,
	userMessage,
} from "./test-utils";

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
		publicClaimId: `mcm_${memoryId}`,
		revisionLocator: `mcm_${memoryId}/r1/${"0".repeat(64)}`,
		category: "WORKFLOW_RULES",
		matchType: "exact",
		...(contentDigest === undefined ? {} : { contentDigest }),
	};
}

describe("runAutoSearchHintForPi", () => {
	afterEach(() => {
		clearAutoSearchForPiSession("ses-auto");
		clearAutoSearchForPiSession("ses-auto-2");
	});

	it("reuses the per-turn cached hint for the same user message id", async () => {
		const db = createTestDb();
		// No memory fragments contributed, so replay needs no policy check.
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
			expect(options?.sources).toEqual(["message", "git_commit"]);
			expect(options?.memoryPolicySurface).toBe("auto_search");
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("a kernel memory row that matches the prompt becomes the hint", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "unifiedSearch").mockResolvedValue([]);
		const fake = fakeKernelResolver();
		fake.kernel.seedDecision({
			object_id: `mem_${"a".repeat(32)}`,
			decision_kind: "PROJECT_RULES",
			summary:
				"the historian decides to run when context passes the execute threshold",
		});
		try {
			const messages = [
				userMessage("please explain how the historian decides when to run", 1),
			];
			await runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages,
				options: {
					...baseOptions,
					directory: "/tmp/auto-search",
					kernelClient: fake.kernelClient,
				},
			});
			expect(textOf(messages[0])).toContain("<ctx-search-hint>");
			expect(fake.transport.methods()).toEqual(["kernel.read"]);
			expect(fake.transport.calls[0]?.body).toMatchObject({
				surface: "explicit_search",
				gated: true,
			});
			expect(getAutoSearchHintDecisions(db, "ses-auto")[0]).toMatchObject({
				decision: "hint",
				memoryFragments: [],
			});
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("a provided memory snapshot serves the memory source with no kernel read", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "unifiedSearch").mockResolvedValue([]);
		const fake = fakeKernelResolver();
		fake.kernel.seedDecision({
			object_id: `mem_${"c".repeat(32)}`,
			decision_kind: "PROJECT_RULES",
			summary:
				"the historian decides to run when context passes the execute threshold",
		});
		try {
			const messages = [
				userMessage("please explain how the historian decides when to run", 1),
			];
			await runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages,
				options: {
					...baseOptions,
					directory: "/tmp/auto-search",
					kernelClient: fake.kernelClient,
					memorySnapshot: fake.kernel.snapshot("explicit_search"),
				},
			});
			expect(textOf(messages[0])).toContain("<ctx-search-hint>");
			expect(fake.transport.calls).toEqual([]);
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it.each([
		[
			"stale",
			{ kind: "stale", lag_positions: 3, oldest_unconsumed_age_ms: 500 } as const,
			"memory-abstained",
		],		["unavailable", unavailable("store_busy"), "memory-unavailable"],
	] as const)(
		"a %s kernel persists a typed no-hint reason and appends nothing",
		async (_label, state, reason) => {
			const db = createTestDb();
			const spy = spyOn(searchModule, "unifiedSearch").mockResolvedValue([]);
			const fake = fakeKernelResolver();
			fake.kernel.seedDecision({
				object_id: `mem_${"b".repeat(32)}`,
				decision_kind: "PROJECT_RULES",
				summary:
					"the historian decides to run when context passes the execute threshold",
			});
			fake.kernel.surfaceStates.set("explicit_search", state);
			try {
				const messages = [
					userMessage("please explain how the historian decides when to run", 1),
				];
				await runAutoSearchHintForPi({
					sessionId: "ses-auto",
					db,
					messages,
					options: {
						...baseOptions,
						directory: "/tmp/auto-search",
						kernelClient: fake.kernelClient,
					},
				});
				expect(textOf(messages[0])).not.toContain("<ctx-search-hint>");
				expect(getAutoSearchHintDecisions(db, "ses-auto")[0]).toMatchObject({
					decision: "no-hint",
					reason,
				});
			} finally {
				spy.mockRestore();
				closeQuietly(db);
			}
		},
	);

	it("a delivered kernel anti-memory warning appends once and never replays", async () => {
		const db = createTestDb();
		const prompt = "please explain how the historian decides when to run";
		const spy = spyOn(searchModule, "unifiedSearch").mockResolvedValue([]);
		const fake = fakeKernelResolver();
		fake.kernel.seedDecision({
			object_id: `mem_${"e".repeat(32)}`,
			decision_kind: ANTI_MEMORY_CATEGORY,
			summary: renderAntiMemoryContent({
				trigger: "historian scheduling",
				rejectedStrategy: "polling the session table",
				rejectionReason: "it starves the transform hot path",
			}),
			rationale: prompt,
		});
		const options = {
			...baseOptions,
			directory: "/tmp/auto-search",
			kernelClient: fake.kernelClient,
		};
		try {
			const messages = [userMessage(prompt, 1)];
			await runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages,
				options,
			});
			expect(textOf(messages[0])).toContain("Previously rejected");

			const decision = getAutoSearchHintDecisions(db, "ses-auto")[0];
			expect(decision?.decision).toBe("hint");
			if (decision?.decision !== "hint") return;
			expect(decision.memoryFragments?.length).toBe(1);

			const replayMessages = [userMessage(prompt, 1)];
			await runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages: replayMessages,
				options,
			});
			expect(textOf(replayMessages[0])).not.toContain("<ctx-search-hint>");
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("does not deliver a sub-threshold warning riding another lane's strong hit", async () => {
		const db = createTestDb();
		const warning: UnifiedSearchResult = {
			source: "anti_memory",
			score: 0.5,
			publicClaimId: "mcm_weak_warning",
			revisionLocator: "mcm_weak_warning/r1/digest",
			contentDigest: "digest",
			claimId: 99,
			normalizedHash: "hash",
			trigger: "session caching",
			rejectedStrategy: "Redis",
			rejectionReason: "it creates split ownership",
			saferAlternative: "use SQLite",
			matchType: "lexical",
		};
		const spy = spyOn(searchModule, "unifiedSearch").mockResolvedValue([
			memoryResult(0.9),
			warning,
		]);
		try {
			const messages = [
				userMessage("please add Redis backed session caching", 1),
			];
			await runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages,
				options: baseOptions,
			});
			expect(textOf(messages[0])).not.toContain("Previously rejected");
			expect(textOf(messages[0])).toContain("<ctx-search-hint>");
			expect(getAutoSearchHintDecisions(db, "ses-auto")[0]).toMatchObject({
				decision: "hint",
				memoryFragments: [],
			});
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
		// The code must resolve entry IDs by message reference after a splice because positional indices refer to the pre-splice array.
		const db = createTestDb();
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async () => [memoryResult()],
		);
		try {
			const latest = userMessage("explain the historian cache wiring", 1);
			const currentMessages = [latest];
			const stalePositionalEntryIds = ["entry-OLD-WRONG"];
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

			// The persisted decision must use the reference-mapped ID rather than entryIds[0].
			expect(textOf(currentMessages[0])).toContain("<ctx-search-hint>");
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
		// If a supplied reference map lacks the latest user message, do not fall back to entryIds[i]; the stale index can persist and replay a hint for another turn.
		const db = createTestDb();
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async () => [memoryResult()],
		);
		try {
			const latest = userMessage("explain the historian cache wiring", 1);
			const currentMessages = [latest];
			const stalePositionalEntryIds = ["entry-STALE-WRONG"];
			// The reference map omits `latest` to simulate a cloned or synthetic message.
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

			// An unresolved message must not receive a hint or persist a decision under entryIds[i].
			expect(textOf(currentMessages[0])).not.toContain("<ctx-search-hint>");
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
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async () => [memoryResult()],
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
