/**
 * Pi transform-time auto-search hint runner.
 *
 * This is the Pi-shaped counterpart to OpenCode's
 * `auto-search-runner.ts`: when a context event carries a new meaningful
 * user message, run the shared `unifiedSearch()` over the stripped user
 * prompt, build the shared vague-recall hint, and append that hint to the
 * latest user message. The hint is deliberately not inline retrieved data;
 * it nudges the agent to call `ctx_search` for full context if relevant.
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
 * ## Mutation strategy
 *
 * The function returns an `AgentMessage[]`, but mutates only the targeted
 * latest user message in place. That keeps the standalone API easy for the
 * future integrator: callers can pass Pi's mutable event array and return
 * the same reference. We preserve Pi's existing user-content shape instead
 * of normalizing everything to arrays: string content gets a direct string
 * append; array content appends to the first text block or pushes a new
 * `TextContent` block if the user message is image-only. This avoids
 * changing legacy string messages into array messages solely because a hint
 * was added.
 *
 * ## Idempotency and augmentation stacking
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
import { recordDeliveredAntiMemoryUsage } from "@magic-context/core/features/magic-context/memory/storage-claim-operations";
import { autoSearchHintFragmentsStillEligible } from "@magic-context/core/features/magic-context/memory/storage-claim-visibility";
import type {
	UnifiedSearchOptions,
	UnifiedSearchResult,
} from "@magic-context/core/features/magic-context/search";
import { unifiedSearch } from "@magic-context/core/features/magic-context/search";
import {
	type AutoSearchHintDecision,
	type AutoSearchHintNoHintReason,
	appendAutoSearchHintDecision,
	getAutoSearchHintDecisions,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import {
	collectAntiMemoryWarningFragments,
	packAutoSearchHint,
} from "@magic-context/core/hooks/magic-context/auto-search-hint";
import { extractBoundedAutoSearchQuery } from "@magic-context/core/hooks/magic-context/auto-search-prompt";
import { log, sessionLog } from "@magic-context/core/shared/logger";
import type { Database } from "@magic-context/core/shared/sqlite";

/**
 * Pi's full AgentMessage union, sourced from the live SDK ContextEvent
 * payload. Using the SDK's type (instead of a re-declared structural alias)
 * keeps this module type-compatible with the rest of the Pi plugin without
 * a per-version maintenance burden — when pi-coding-agent's types shift,
 * we get build errors here at the import site instead of silent runtime
 * mismatches.
 */
export type AgentMessage = ContextEvent["messages"][number];

/**
 * Extract just the `user` variant of AgentMessage so internal helpers
 * can mutate `content` without re-narrowing on every call. Pi's user
 * message carries `string | (TextContent|ImageContent)[]` for content.
 */
type UserMessage = Extract<AgentMessage, { role: "user" }>;

export interface PiAutoSearchOptions {
	enabled: boolean;
	scoreThreshold: number;
	minPromptChars: number;
	projectPath: string;
}

const AUTO_SEARCH_TIMEOUT_MS = 3_000;
const DEFAULT_SCORE_THRESHOLD = 0.55;
const DEFAULT_MIN_PROMPT_CHARS = 20;

async function unifiedSearchWithTimeout(
	db: Database,
	sessionId: string,
	projectPath: string,
	prompt: string,
	options: UnifiedSearchOptions,
	timeoutMs: number,
): Promise<UnifiedSearchResult[] | null> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<null>((resolve) => {
		timer = setTimeout(() => {
			controller.abort();
			resolve(null);
		}, timeoutMs);
	});

	try {
		return await Promise.race([
			unifiedSearch(db, sessionId, projectPath, prompt, {
				...options,
				signal: controller.signal,
				// Auto hints are plugin-internal surfacing, not explicit agent
				// retrievals; match OpenCode's auto-search runner and search.ts.
				countRetrievals: false,
				memoryPolicySurface: "auto_search",
			}),
			timeoutPromise,
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

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

function hasStackedAugmentation(rawText: string): boolean {
	return (
		rawText.includes("<sidekick-augmentation>") ||
		rawText.includes("<ctx-search-hint>") ||
		rawText.includes("<ctx-search-auto>")
	);
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

		// Reference-identity resolution takes precedence: `entryIds` is positional
		// against the pre-splice array, but `messages` may have been spliced since
		// (compartment trim / placeholder strip), so index i can be stale. The
		// ref-map resolves the actual current message correctly.
		if (entryIdByRef) {
			const byRef =
				msg && typeof msg === "object"
					? entryIdByRef.get(msg as object)
					: undefined;
			if (typeof byRef === "string") return { message: msg, messageId: byRef };
			// Ref-map MISS with a ref-map present: do NOT fall back to the stale
			// positional `entryIds[i]` — after a splice it points at the wrong
			// message and would anchor the auto-search hint to the wrong user turn.
			// Treat as unresolved (degraded: no fresh hint this pass).
			return null;
		}

		// No ref-map (pre-mutation caller): positional entryIds is authoritative.
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
 * Run Pi auto-search hinting against the latest meaningful user message.
 *
 * The returned array is the same mutable array received in `args.messages`;
 * callers should still return it to Pi so the API shape remains compatible
 * if this implementation later switches to copy-on-write.
 */
export async function runAutoSearchHintForPi(args: {
	sessionId: string;
	db: Database;
	messages: AgentMessage[];
	entryIds?: readonly (string | undefined)[] | null;
	/**
	 * Splice-safe message→entryId map keyed by AgentMessage reference. Resolved
	 * against branch entries; correct even though `messages` was spliced since
	 * the positional `entryIds` was computed. Takes precedence over `entryIds`.
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
	// A persisted hint replays only while every contributing memory is still
	// auto_search-eligible: a later policy transition must not keep sending
	// the fragment through the stored text. Mirrors the OpenCode runner.
	const replayHintIfEligible = (decision: AutoSearchHintDecision): void => {
		if (decision.decision !== "hint") return;
		if (!autoSearchHintFragmentsStillEligible(db, decision.memoryFragments)) {
			sessionLog(
				sessionId,
				`auto-search: suppressing persisted anti-memory warning for ${decision.messageId} — fresh search required`,
			);
			return;
		}
		appendHintToUserMessage(userMsg, decision.text);
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

	let results: UnifiedSearchResult[] | null;
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
			// Primers v1 are cache-neutral: explicit ctx_search only,
			// never transform-time auto-search prompt hints.
			sources: ["memory", "message", "git_commit"],
		};
		results = await unifiedSearchWithTimeout(
			db,
			sessionId,
			options.projectPath,
			rawPrompt,
			searchOptions,
			AUTO_SEARCH_TIMEOUT_MS,
		);
	} catch (error) {
		// Retryable failure — do not persist a permanent no-hint decision, or the
		// same user message would be suppressed even though a later pass may succeed.
		log(
			`[auto-search] unified search failed for session ${sessionId} (will retry next pass): ${error instanceof Error ? error.message : String(error)}`,
		);
		return messages;
	}

	if (results === null) {
		// Timeout is also retryable, matching OpenCode's auto-search runner.
		sessionLog(
			sessionId,
			`auto-search: timed out after ${AUTO_SEARCH_TIMEOUT_MS}ms, skipping hint for this turn (will retry)`,
		);
		return messages;
	}

	if (results.length === 0) {
		writeNoHintAndReconcile("empty");
		return messages;
	}

	const scoreThreshold = options.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD;
	if (results[0].score < scoreThreshold) {
		sessionLog(
			sessionId,
			`auto-search: top score ${results[0].score.toFixed(3)} below threshold ${scoreThreshold}`,
		);
		writeNoHintAndReconcile("below-threshold");
		return messages;
	}

	const packed = packAutoSearchHint(results, {
		warningScoreThreshold: scoreThreshold,
	});
	if (!packed.text) {
		writeNoHintAndReconcile("empty");
		return messages;
	}

	// Prefix with double newline so the hint is a separate block, matching
	// OpenCode's auto-search runner.
	const payload = `\n\n${packed.text}`;
	// Any anti-memory fragment marks the persisted decision as non-replayable.
	// Warning delivery always requires a fresh search rather than stored text.
	const { warningResults, memoryFragments } = collectAntiMemoryWarningFragments(
		packed.delivered,
	);
	const outcome = appendAutoSearchHintDecision(db, sessionId, {
		messageId: userMsgId,
		decision: "hint",
		text: payload,
		memoryFragments,
	});
	if (!outcome.ok) return messages;
	// Deliver this call's fresh CAS winner directly. Concurrently persisted
	// decisions replay only when they contain no anti-memory fragment.
	// Mirrors the OpenCode runner's delivery contract.
	if (outcome.kind === "appended" && warningResults.length > 0) {
		appendHintToUserMessage(userMsg, payload);
		recordDeliveredAntiMemoryUsage(db, warningResults);
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
export function clearAutoSearchForPiSession(_sessionId: string): void {
	// Auto-search decisions live in session_meta and are cleared by clearSession().
}
