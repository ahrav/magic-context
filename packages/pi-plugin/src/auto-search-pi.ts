/**
 * The runner appends a `ctx_search` hint only when the evaluated message produces a non-empty hint.
 *
 * For each new meaningful user message, `unifiedSearch()` receives the stripped prompt.
 * The hint omits retrieved data.
 * The hint directs the agent to call `ctx_search` for full context.
 *
 * ## Per-turn dedup
 *
 * Pi can re-fire `pi.on("context", ...)` multiple times for the same user
 * turn. Auto-search decisions are persisted in `session_meta`, so a turn that
 * was already evaluated is skipped and a non-empty hint replays through the
 * same idempotent append guard.
 *
 * ## Timeout
 *
 * The LLM-bound context path must not hang on embedding providers. We use
 * the same cap as OpenCode's `auto-search-runner.ts`. On
 * timeout the `AbortController` is fired so `unifiedSearch()` can cancel
 * the underlying embedding fetch.
 *
 *
 * The runner mutates only the targeted latest user message in place.
 * Callers can pass Pi's mutable event array and receive the same reference.
 * The runner preserves Pi's existing user-content shape instead of normalizing all content to arrays.
 * Appending a hint does not convert legacy string content to an array.
 * was added.
 *
 *
 * Before appending, we check whether the target message already contains
 * the exact hint or any `<ctx-search-hint>` block. Before searching, we
 * skip if raw user text already contains `<sidekick-augmentation>`,
 * `<ctx-search-hint>`, or `<ctx-search-auto>`, matching OpenCode's stacked
 * augmentation guard (`auto-search-runner.ts`'s `hasStackedAugmentation`).
 * Prompt extraction strips Magic Context markers and prior plugin blocks
 * before embedding, matching OpenCode's prompt extraction.
 */

import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import {
	embedTextForProject,
	getProjectEmbeddingSnapshot,
} from "@magic-context/core/features/magic-context/memory/embedding";
import { resolveProjectRootDirectory } from "@magic-context/core/features/magic-context/memory/project-identity";
import type { UnifiedSearchOptions } from "@magic-context/core/features/magic-context/search";
import {
	type AutoSearchHintDecision,
	type AutoSearchHintNoHintReason,
	appendAutoSearchHintDecision,
	getAutoSearchHintDecisions,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { collectMemoryHintFragments } from "@magic-context/core/hooks/magic-context/auto-search-hint";
import { extractBoundedAutoSearchQuery } from "@magic-context/core/hooks/magic-context/auto-search-prompt";
import {
	type AutoSearchDelivery,
	autoSearchHintReplayable,
	executeAutoSearchDelivery,
} from "@magic-context/core/hooks/magic-context/auto-search-runner";
import {
	AUTO_SEARCH_TIMEOUT_MS,
	hasStackedAugmentation,
} from "@magic-context/core/hooks/magic-context/auto-search-shared";
import type {
	KernelClientResolver,
	KernelMemorySnapshot,
} from "@magic-context/core/shared/kernel-client";
import { log, sessionLog } from "@magic-context/core/shared/logger";
import type { Database } from "@magic-context/core/shared/sqlite";

/**
 * Deriving `AgentMessage` from `ContextEvent` keeps the alias synchronized with Pi's SDK type.
 * mismatches.
 */
export type AgentMessage = ContextEvent["messages"][number];

/**
 * The `UserMessage` alias narrows `AgentMessage` to `user` messages so helpers can mutate `content` without re-narrowing.
 */
type UserMessage = Extract<AgentMessage, { role: "user" }>;

export interface PiAutoSearchOptions {
	enabled: boolean;
	scoreThreshold: number;
	minPromptChars: number;
	projectPath: string;
	/** The session's working directory; the kernel client binds to its project root. */
	directory?: string;
	/** Serves the `memory` source; absent when no daemon transport exists. */
	kernelClient?: KernelClientResolver;
	/** The pass's injection memory snapshot; the delivery consumes it instead of re-reading. */
	memorySnapshot?: KernelMemorySnapshot;
}

const DEFAULT_SCORE_THRESHOLD = 0.55;
const DEFAULT_MIN_PROMPT_CHARS = 20;

function collectUserPromptParts(message: UserMessage): string {
	const { content } = message;
	if (typeof content === "string") return content;

	let collected = "";
	for (const part of content) {
		if (part.type === "text" && typeof part.text === "string") {
			collected += (collected.length > 0 ? "\n" : "") + part.text;
		}
	}
	return collected;
}

function extractUserPromptText(message: UserMessage): string {
	return extractBoundedAutoSearchQuery(collectUserPromptParts(message));
}

function findLatestMeaningfulUserMessage(
	messages: AgentMessage[],
	entryIds: readonly (string | undefined)[],
	entryIdByRef?: ReadonlyMap<object, string> | null,
): { message: UserMessage; messageId: string } | null {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const msg = messages[i];
		if (msg?.role !== "user") continue;
		if (collectUserPromptParts(msg).trim().length === 0) continue;

		// The runner uses reference identity because splicing can make positional `entryIds` stale.
		if (entryIdByRef) {
			const byRef =
				msg && typeof msg === "object"
					? entryIdByRef.get(msg as object)
					: undefined;
			if (typeof byRef === "string") return { message: msg, messageId: byRef };
			// The runner does not fall back to `entryIds[i]` when the ref-map misses because splicing can identify another user turn.
			return null;
		}

		// Positional `entryIds` are authoritative when no ref-map is available.
		const messageId = entryIds[i];
		if (typeof messageId === "string") return { message: msg, messageId };
		return null;
	}

	return null;
}

function appendHintToUserMessage(message: UserMessage, hint: string): boolean {
	if (hint.length === 0) return false;

	const rawText = collectUserPromptParts(message);
	if (rawText.includes(hint) || rawText.includes("<ctx-search-hint>")) {
		return false;
	}

	if (typeof message.content === "string") {
		message.content += hint;
		return true;
	}

	const firstTextIndex = message.content.findIndex(
		(part) => part.type === "text",
	);
	if (firstTextIndex >= 0) {
		const part = message.content[firstTextIndex];
		if (part?.type !== "text") return false;
		message.content[firstTextIndex] = { ...part, text: part.text + hint };
		return true;
	}

	message.content.push({ type: "text", text: hint.trimStart() });
	return true;
}

/**
 *
 */
export async function runAutoSearchHintForPi(args: {
	sessionId: string;
	db: Database;
	messages: AgentMessage[];
	entryIds?: readonly (string | undefined)[] | null;
	/**
	 * The runner maps `AgentMessage` references to entry IDs because splicing invalidates positional `entryIds`.
	 */
	entryIdByRef?: ReadonlyMap<object, string> | null;
	options: PiAutoSearchOptions;
	ensureProjectRegistered?: () => Promise<void>;
}): Promise<AgentMessage[]> {
	const { sessionId, db, messages, options, entryIdByRef } = args;
	const entryIds =
		args.entryIds === undefined
			? messages.map((message, index) => {
					const timestamp = (message as { timestamp?: unknown }).timestamp;
					return `test-entry-${index}:${typeof timestamp === "number" ? timestamp : "no-ts"}`;
				})
			: args.entryIds;
	if (!options.enabled) return messages;
	const strictResolutionFailed = entryIds === null;
	const effectiveEntryIds = strictResolutionFailed
		? messages.map((message) => {
				const id = (message as { id?: unknown }).id;
				return typeof id === "string" ? id : undefined;
			})
		: entryIds;

	const found = findLatestMeaningfulUserMessage(
		messages,
		effectiveEntryIds,
		entryIdByRef,
	);
	if (found === null) return messages;

	const { message: userMsg, messageId: userMsgId } = found;
	const replayHintIfEligible = (decision: AutoSearchHintDecision): void => {
		if (decision.decision !== "hint") return;
		if (autoSearchHintReplayable(decision)) {
			appendHintToUserMessage(userMsg, decision.text);
			return;
		}
		sessionLog(
			sessionId,
			`auto-search: suppressing persisted memory-backed hint for ${decision.messageId} — fresh search required`,
		);
	};
	const existing = getAutoSearchHintDecisions(db, sessionId);
	const existingForMessage = existing.find(
		(decision) => decision.messageId === userMsgId,
	);
	if (existingForMessage) {
		replayHintIfEligible(existingForMessage);
		return messages;
	}
	if (strictResolutionFailed) {
		sessionLog(
			sessionId,
			"Pi auto-search: strict entry-id resolution failed; replayed persisted decisions only",
		);
		return messages;
	}

	await args.ensureProjectRegistered?.();

	const writeNoHintAndReconcile = (
		reason: AutoSearchHintNoHintReason,
	): void => {
		const outcome = appendAutoSearchHintDecision(db, sessionId, {
			messageId: userMsgId,
			decision: "no-hint",
			reason,
		});
		if (!outcome.ok) return;
		if (outcome.kind === "already-present") {
			replayHintIfEligible(outcome.decision);
		}
	};

	// Suppression check runs on raw text before stripping; OpenCode does the
	// same because stripping removes the signal tags.
	const rawPartsText = collectUserPromptParts(userMsg);
	if (hasStackedAugmentation(rawPartsText)) {
		sessionLog(
			sessionId,
			"auto-search: skipping — user message already carries augmentation/hint",
		);
		writeNoHintAndReconcile("stacked");
		return messages;
	}

	const rawPrompt = extractUserPromptText(userMsg);
	const minPromptChars = options.minPromptChars ?? DEFAULT_MIN_PROMPT_CHARS;
	if (rawPrompt.length < minPromptChars) {
		writeNoHintAndReconcile("too-short");
		return messages;
	}

	let delivery: AutoSearchDelivery;
	try {
		const snapshot = getProjectEmbeddingSnapshot(options.projectPath);
		const memoryEnabled = snapshot?.features.memoryEnabled ?? true;
		const embeddingEnabled = snapshot
			? snapshot.enabled || snapshot.gitCommitEnabled
			: true;
		const gitCommitsEnabled = snapshot?.gitCommitEnabled ?? false;
		const searchOptions: UnifiedSearchOptions = {
			limit: 10,
			memoryEnabled,
			embeddingEnabled,
			gitCommitsEnabled,
			embedQuery: async (text, signal) => {
				const result = await embedTextForProject(
					options.projectPath,
					text,
					signal,
					"query",
				);
				return result?.vector ?? null;
			},
			isEmbeddingRuntimeEnabled: () => embeddingEnabled === true,
			// Primers are cache-neutral: explicit ctx_search only, never
			// transform-time auto-search prompt hints.
			sources: ["memory", "message", "git_commit"],
		};
		delivery = await executeAutoSearchDelivery({
			db,
			sessionId,
			projectPath: options.projectPath,
			prompt: rawPrompt,
			searchOptions,
			scoreThreshold: options.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD,
			// The snapshot substitutes for the kernel read, so it forwards without a resolver or directory; tying it to client resolution would drop the pass's injection read and record the project as empty. commentlint: allow(JUDGE)
			...(memoryEnabled && options.memorySnapshot !== undefined
				? { memorySnapshot: options.memorySnapshot }
				: {}),
			...(memoryEnabled && options.kernelClient && options.directory
				? {
						kernelClient: options.kernelClient({
							sessionId,
							projectRoot: resolveProjectRootDirectory(options.directory),
						}),
					}
				: {}),
		});
	} catch (error) {
		delivery = { status: "incomplete", kind: "search-failure", error };
	}

	if (delivery.status === "incomplete") {
		log(
			`[auto-search] unified search failed for session ${sessionId} (will retry next pass): ${delivery.error instanceof Error ? delivery.error.message : String(delivery.error)}`,
		);
		return messages;
	}
	if (delivery.reason === "timeout") {
		sessionLog(
			sessionId,
			`auto-search: timed out after ${AUTO_SEARCH_TIMEOUT_MS}ms, skipping hint for this turn (will retry)`,
		);
		return messages;
	}
	const results = delivery.prePack;
	if (delivery.reason === "packer-empty") {
		writeNoHintAndReconcile("empty");
		return messages;
	}
	if (
		delivery.reason === "memory-abstained" ||
		delivery.reason === "memory-unavailable"
	) {
		// A withheld memory lane is transient evidence like a timeout: the pass persists no decision, so a later pass re-evaluates the message once the daemon recovers.
		sessionLog(
			sessionId,
			`auto-search: memory lane ${delivery.reason}, skipping hint for this turn (will retry)`,
		);
		return messages;
	}
	if (delivery.reason === "empty") {
		writeNoHintAndReconcile(delivery.reason);
		return messages;
	}
	if (delivery.reason === "below-threshold") {
		sessionLog(
			sessionId,
			`auto-search: top score ${results[0].score.toFixed(3)} below threshold ${options.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD}`,
		);
		writeNoHintAndReconcile("below-threshold");
		return messages;
	}

	// Prefix with double newline so the hint is a separate block, matching
	// OpenCode's auto-search runner.
	const payload = `\n\n${delivery.hintText}`;
	// Any memory-backed fragment — an anti-memory warning or a positive kernel hit — marks the persisted decision as non-replayable; hints from non-memory sources persist an empty list and replay. commentlint: allow(JUDGE)
	const { memoryFragments } = collectMemoryHintFragments(delivery.delivered);
	const outcome = appendAutoSearchHintDecision(db, sessionId, {
		messageId: userMsgId,
		decision: "hint",
		text: payload,
		memoryFragments,
	});
	if (!outcome.ok) return messages;
	if (outcome.kind === "appended") {
		// A fresh delivery appends directly because a memory-backed decision bypasses replay; later passes cannot re-serve it. commentlint: allow(JUDGE)
		appendHintToUserMessage(userMsg, payload);
	} else {
		replayHintIfEligible(outcome.decision);
	}
	sessionLog(
		sessionId,
		`auto-search: attached hint to ${userMsgId} (${results.length} fragments, top score ${results[0].score.toFixed(3)})`,
	);

	return messages;
}

/**
 * Session cleanup hook. No-op: auto-search decisions live in `session_meta`
 * and are cleared by `clearSession()`.
 */
export function clearAutoSearchForPiSession(_sessionId: string): void {}
