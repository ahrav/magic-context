/**
 *
 * The Pi system prompt contains only stable instructions.
 * The Pi system prompt retains Magic Context guidance and Pi/OpenCode's existing `Today's date` line.
 * `processSystemPromptForCache` freezes the `Today's date` line for cache stability.
 * The message materializer renders user profiles, key files, memories, facts, and compartments in `m[0]`/`m[1]`.
 */

import { createHash } from "node:crypto";
import { buildMagicContextSection } from "@magic-context/core/agents/magic-context-prompt";
import {
	type ContextDatabase,
	getOrCreateSessionMeta,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { estimateTokens } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import { sessionLog } from "@magic-context/core/shared/logger";
import type { PromptSurfacePreset } from "@magic-context/core/shared/prompt-surface";
import { promptSurfaceHashMaterial } from "@magic-context/core/shared/prompt-surface-runtime";

const PROJECT_DOCS_MARKER = "<project-docs>";
const USER_PROFILE_MARKER = "<user-profile>";

const MAGIC_CONTEXT_MARKER = "## Magic Context";

/**
 * `stickyDateBySession` is module-scoped so `clearPiSystemPromptSession` can release its entries.
 */
const stickyDateBySession = new Map<string, string>();

export interface BuildMagicContextBlockOptions {
	db: ContextDatabase;
	cwd: string;
	sessionId?: string;
	/** `memoryEnabled` is reserved for compatibility; project memories live in `m[0]`/`m[1]`. */
	memoryEnabled: boolean;
	memoryBudgetChars?: number;
	/* */
	includeGuidance?: boolean;
	protectedTags?: number;
	ctxReduceCallable?: boolean;
	dreamerEnabled?: boolean;
	temporalAwarenessEnabled?: boolean;
	cavemanTextCompressionEnabled?: boolean;
	language?: string;
	promptSurfacePreset?: PromptSurfacePreset;
	primaryGuidanceOverride?: string;
	/** `userMemoriesEnabled` is reserved for compatibility; the user profile lives in `m[0]`. */
	userMemoriesEnabled?: boolean;
	existingSystemPrompt?: string;
	isCacheBusting?: boolean;
}

/**
 * `buildMagicContextBlock` emits guidance only.
 * The message materializer renders volatile data-bearing blocks in `m[0]`/`m[1]`.
 * `buildMagicContextBlock` never emits `<project-docs>` or `<user-profile>`, even when legacy options are true.
 */
export function buildMagicContextBlock(
	opts: BuildMagicContextBlockOptions,
): string | null {
	const existing = opts.existingSystemPrompt ?? "";
	const includeGuidance =
		(opts.includeGuidance ?? true) && !existing.includes(MAGIC_CONTEXT_MARKER);
	if (!includeGuidance) return null;

	return buildMagicContextSection(
		null,
		opts.protectedTags ?? 20,
		opts.ctxReduceCallable ?? true,
		opts.dreamerEnabled ?? false,
		opts.temporalAwarenessEnabled ?? false,
		opts.cavemanTextCompressionEnabled ?? false,
		false,
		opts.language,
		// `memoryEnabled !== false` suppresses `ctx_memory` guidance; `ctx_search` guidance remains.
		opts.memoryEnabled !== false,
		opts.promptSurfacePreset,
		opts.primaryGuidanceOverride,
	);
}

export function composeMagicContextSystemPrompt(
	basePrompt: string,
	block: string | null,
): string {
	return block ? `${basePrompt}\n\n${block}` : basePrompt;
}

export interface SystemPromptHashResult {
	/** `systemPrompt` is the prompt sent to the LLM and may contain a frozen date. */
	systemPrompt: string;
	/** `hashChanged` reports whether prompt content or the prompt-surface preset differs from the persisted hash. */
	hashChanged: boolean;
	/** `currentHash` is the content-and-preset hash persisted to `session_meta`. */
	currentHash: string;
}

const DATE_PATTERN = /Today's date: .+/;

/**
 *
 * The persisted `session_meta.system_prompt_hash` detects content and prompt-surface preset changes.
 * `processSystemPromptForCache` returns `hashChanged=true` when the persisted hash changes.
 *
 * `processSystemPromptForCache` freezes `Today's date` unless `isCacheBusting` or a hash change busts the cache.
 * A cache-busting turn updates the sticky date to the live date.
 */
export function processSystemPromptForCache(args: {
	db: ContextDatabase;
	sessionId: string;
	systemPrompt: string;
	/** `isCacheBusting` means the caller has already determined that this turn busts the cache. */
	isCacheBusting: boolean;
	promptSurfacePreset?: PromptSurfacePreset;
}): SystemPromptHashResult {
	const { db, sessionId, systemPrompt, isCacheBusting } = args;

	let sessionMeta:
		| import("@magic-context/core/features/magic-context/types").SessionMeta
		| undefined;
	try {
		sessionMeta = getOrCreateSessionMeta(db, sessionId);
	} catch (error) {
		sessionLog(
			sessionId,
			"system-prompt-hash session meta load failed:",
			error,
		);
	}

	const previousHash = sessionMeta?.systemPromptHash ?? "";
	const isFirstHash = previousHash === "" || previousHash === "0";

	// A content or preset change permits the date to advance in the same cache-busting pass.
	let frozenPrompt = systemPrompt;
	const dateMatch = systemPrompt.match(DATE_PATTERN);
	const liveDate = dateMatch ? dateMatch[0] : null;
	const stickyDate = stickyDateBySession.get(sessionId);
	const stableCandidate =
		liveDate && stickyDate && liveDate !== stickyDate
			? systemPrompt.replace(DATE_PATTERN, stickyDate)
			: systemPrompt;
	const stableCandidateHash = createHash("md5")
		.update(
			promptSurfaceHashMaterial(stableCandidate, args.promptSurfacePreset),
		)
		.digest("hex");
	const contentOrPresetChanged =
		!isFirstHash && stableCandidateHash !== previousHash;
	const dateMayAdvance = isCacheBusting || contentOrPresetChanged;

	if (liveDate && !stickyDate) {
		stickyDateBySession.set(sessionId, liveDate);
	} else if (liveDate && stickyDate && liveDate !== stickyDate) {
		if (dateMayAdvance) {
			stickyDateBySession.set(sessionId, liveDate);
			sessionLog(
				sessionId,
				`system prompt date updated: ${stickyDate} → ${liveDate} (cache-busting pass)`,
			);
		} else {
			frozenPrompt = systemPrompt.replace(DATE_PATTERN, stickyDate);
			sessionLog(
				sessionId,
				`system prompt date frozen: real=${liveDate}, using=${stickyDate} (cache-stable pass)`,
			);
		}
	}

	const currentHash = createHash("md5")
		.update(promptSurfaceHashMaterial(frozenPrompt, args.promptSurfacePreset))
		.digest("hex");
	const hashChanged = !isFirstHash && currentHash !== previousHash;

	if (hashChanged) {
		sessionLog(
			sessionId,
			`system prompt hash changed: ${previousHash} → ${currentHash} (len=${frozenPrompt.length})`,
		);
	} else if (isFirstHash) {
		sessionLog(
			sessionId,
			`system prompt hash initialized: ${currentHash} (len=${frozenPrompt.length})`,
		);
	}

	// Persist hash + token estimate so status surfaces are
	// up-to-date and the next turn can compare against this value.
	const systemPromptTokens = estimateTokens(frozenPrompt);
	if (sessionMeta) {
		if (currentHash !== previousHash) {
			updateSessionMeta(db, sessionId, {
				systemPromptHash: currentHash,
				systemPromptTokens,
			});
		} else if (
			Math.abs(sessionMeta.systemPromptTokens - systemPromptTokens) > 50
		) {
			updateSessionMeta(db, sessionId, { systemPromptTokens });
		}
	}

	return {
		systemPrompt: frozenPrompt,
		hashChanged,
		currentHash,
	};
}

/**
 */
export function clearPiSystemPromptSession(sessionId: string): void {
	stickyDateBySession.delete(sessionId);
}

/* */
export const MAGIC_CONTEXT_GUIDANCE_MARKER = MAGIC_CONTEXT_MARKER;
export const SYSTEM_PROMPT_DATA_MARKERS = {
	projectDocs: PROJECT_DOCS_MARKER,
	userProfile: USER_PROFILE_MARKER,
} as const;
