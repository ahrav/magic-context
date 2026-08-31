/**
 *
 * Pi invokes this handler immediately before each LLM invocation with the outgoing `AgentMessage[]` array.
 * The handler can return `{ messages }` to replace the array.
 *
 * The handler omits `§N§ ` prefixes when the session has no `ctx_reduce` tool.
 * Dropped tags persist across sessions.
 * Prompt-cache-sensitive providers require byte-stable `m[0]`/`m[1]` history injection.
 * Anthropic prompt caching requires byte-stable `m[0]`/`m[1]` history injection.
 * The handler drains deferred compaction markers through Pi's `appendCompaction()`.
 *
 * Ordinary errors are logged and return the original messages; `FailClosedBlockingError` is rethrown to prevent fallback to native compaction.
 * native compaction.
 */

import * as crypto from "node:crypto";
import type {
	ContextEvent,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	acquireCompartmentLease,
	COMPARTMENT_LEASE_RENEWAL_MS,
	releaseCompartmentLease,
	renewCompartmentLease,
} from "@magic-context/core/features/magic-context/compartment-lease";
import { getCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { isFailClosedBlockingError } from "@magic-context/core/features/magic-context/fail-closed-block";
import { revalidateEnforcementArtifacts } from "@magic-context/core/features/magic-context/memory/enforcement-artifact-revalidation";
import {
	resolveProjectIdentityForSession,
	resolveProjectRootDirectory,
} from "@magic-context/core/features/magic-context/memory/project-identity";
import { autoSearchHintFragmentsStillEligible } from "@magic-context/core/features/magic-context/memory/storage-claim-visibility";
import {
	clearSessionTracking,
	scheduleIncrementalIndex,
	scheduleReconciliation,
} from "@magic-context/core/features/magic-context/message-index-async";
import {
	createScheduler,
	parseCacheTtl,
	type Scheduler,
} from "@magic-context/core/features/magic-context/scheduler";
import { recordSessionProjectIdentity } from "@magic-context/core/features/magic-context/session-project-storage";
import {
	adoptPiFallbackMessageTag,
	adoptPiFallbackToolOwnerTag,
	type ContextDatabase,
	casChannel2NudgeState,
	clearPendingPiCompactionMarkerStateIf,
	deriveTagLoadFloor,
	findAdoptableFallbackTags,
	findPiFallbackToolOwnerTags,
	getActiveTagsBySession,
	getDroppedTagsByNumbers,
	getHistorianFailureState,
	getMaxDroppedTagNumber,
	getOldestActiveUnprotectedToolTags,
	getPendingOps,
	getPendingPiCompactionMarkerState,
	getPersistedToolTagAccounting,
	getTagsByNumbers,
	getTagsBySession,
	getTagsForPendingOperations,
	hasPiFallbackMessageTags,
	hasPiFallbackToolOwnerTags,
	isWrapupInProgress,
	setSessionWorkMetrics,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage-meta";
import {
	clearDeferredExecutePendingIfMatches,
	clearDetectedContextLimit,
	clearEmergencyDropSample,
	clearEmergencyRecovery,
	clearHistorianFailureState,
	clearPersistedReasoningWatermark,
	getAutoSearchHintDecisions,
	getNoteNudgeAnchors,
	getOverflowState,
	type PendingPiCompactionMarker,
	peekDeferredExecutePending,
	pruneAutoSearchHintDecisions,
	pruneNoteNudgeAnchors,
	resetLastNudgeCycleIfTailShrank,
	setDeferredExecutePendingIfAbsent,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { getSourceContents } from "@magic-context/core/features/magic-context/storage-source";
import {
	createTagger,
	type Tagger,
} from "@magic-context/core/features/magic-context/tagger";
import {
	findNewestPiAssistantEntryId,
	normalizeMaterializeReason,
	recordPendingPiTransformDecision,
	schedulePiTransformDecisionResolve,
} from "@magic-context/core/features/magic-context/transform-decision-log";
import { computePiWorkMetrics } from "@magic-context/core/features/magic-context/work-metrics";
import {
	applyFlushedStatuses,
	applyPendingOperations,
	RECENT_TOOL_SKELETON_WINDOW,
} from "@magic-context/core/hooks/magic-context/apply-operations";
import {
	applyMidTurnDeferral,
	detectMidTurnBypassReason,
} from "@magic-context/core/hooks/magic-context/boundary-execution";
import { replayCavemanCompression } from "@magic-context/core/hooks/magic-context/caveman-cleanup";
import {
	rearmChannel2AfterCoverageAdvancingHardFold,
	rearmChannel2AfterMeasuredCollapse,
} from "@magic-context/core/hooks/magic-context/channel2-cycle";
import { checkCompartmentTrigger } from "@magic-context/core/hooks/magic-context/compartment-trigger";
import { evaluateChannel2 } from "@magic-context/core/hooks/magic-context/ctx-reduce-nudge";
import { deriveTriggerBudget } from "@magic-context/core/hooks/magic-context/derive-budgets";
import {
	DEFAULT_CONTEXT_LIMIT,
	resolveExecuteThreshold,
} from "@magic-context/core/hooks/magic-context/event-resolvers";
import { foldExecutesThisPass } from "@magic-context/core/hooks/magic-context/fold-execution-gate";
import {
	markNoteNudgeDelivered,
	onNoteTrigger,
	peekNoteNudgeText,
} from "@magic-context/core/hooks/magic-context/note-nudger";
import {
	getRawHistoryEligibility,
	hasRunnableCompartmentWindow,
	type ProtectedTailBoundarySnapshot,
	resolveBoundaryContext,
	resolveProtectedTailBoundary,
} from "@magic-context/core/hooks/magic-context/protected-tail-boundary";
import {
	readRawSessionMessages,
	setRawMessageProvider,
} from "@magic-context/core/hooks/magic-context/read-session-chunk";
import { invalidateTrueRawTokenCache } from "@magic-context/core/hooks/magic-context/read-session-true-raw-tokens";
import { modelAcceptsEmptyContent } from "@magic-context/core/hooks/magic-context/sentinel";
import {
	buildEditSupersessionReclaim,
	buildSupersessionReclaimOps,
} from "@magic-context/core/hooks/magic-context/supersession-reclaim";
import { stripTagPrefix } from "@magic-context/core/hooks/magic-context/tag-content-primitives";
import {
	advanceToolReclaimWatermarkToCurrentMax,
	buildSyntheticToolReclaimOps,
} from "@magic-context/core/hooks/magic-context/tool-reclaim";
import { escalationBands } from "@magic-context/core/shared/escalation-bands";
import { piModelRefToCanonical } from "@magic-context/core/shared/harness-provider-map";
import { log, sessionLog } from "@magic-context/core/shared/logger";
import { isSaneLimit } from "@magic-context/core/shared/models-dev-cache";
import type { SubagentRunner } from "@magic-context/core/shared/subagent-runner";
import {
	TEXT_TAG_IDENTITY_MARKER,
	tagTranscript,
} from "@magic-context/core/shared/tag-transcript";
import {
	clearAutoSearchForPiSession,
	runAutoSearchHintForPi,
} from "./auto-search-pi";
import { clearPiEmbedSessionState } from "./commands/ctx-embed";
import { sendCtxStatusMessage } from "./commands/pi-command-utils";
import {
	type ApplyDeferredPiCompactionMarkerDeps,
	applyDeferredPiCompactionMarker,
} from "./compaction-marker-manager-pi";
import {
	commitPiCompactionModeRecord,
	reconcilePiCompactionMode,
} from "./compaction-off-pi";
import {
	hasPiTransformTimingObserver,
	recordPiTransformTiming,
} from "./context-perf-hooks";
import {
	clearPiChannel1State,
	getPiChannel1Baseline,
	setPiChannel1Baseline,
} from "./ctx-reduce-nudge-pi";
import { detectRecentCommit } from "./detect-recent-commit";
import { ensureProjectRegisteredFromPiDirectory } from "./embedding-bootstrap";
import {
	applyPiHeuristicCleanup,
	type PiHeuristicCleanupResult,
} from "./heuristic-cleanup-pi";
import {
	clearM0M1PiCache,
	clearPiInjectionTokenCountCache,
	injectM0M1Pi,
	mustMaterializePi,
	type PiM0M1InjectionResult as PiInjectionResult,
	trimPiMessagesToCachedBoundary,
} from "./inject-compartments-pi";
import { hasVisibleNoteReadCallPi } from "./note-visibility-pi";
import {
	resolvePiUsableContextLimit,
	resolvePiWindowGeometry,
} from "./pi-context-limit";
import { type PiHistorianDeps, runPiHistorian } from "./pi-historian-runner";
import { injectSyntheticTodowriteForPi } from "./pi-todo-inject";
import {
	convertEntriesToRawMessages,
	findLastModelKeyFromBranch,
	isMidTurnPi,
	readPiSessionMessages,
	resolvePiStableId,
} from "./read-session-pi";
import {
	buildMessageIdToMaxTag,
	clearOldReasoningPi,
	replayClearedReasoningPi,
	replayStrippedInlineThinkingPi,
	stripInlineThinkingPi,
} from "./reasoning-replay-pi";
import { stripPiDroppedPlaceholderMessages } from "./strip-placeholders-pi";
import { stripPiProcessedImages } from "./strip-processed-images-pi";
import { clearPiSystemPromptSession } from "./system-prompt";
import {
	assertPiTailHygieneContentUnchanged,
	effectivePiTailHygiene,
	refreshPiTailHygieneBaseline,
} from "./tail-hygiene-walk-pi";
import {
	injectPiTemporalMarkers,
	stripPiLeadingTemporalMarker,
	withoutPiLeadingTemporalMarker,
} from "./temporal-awareness-pi";
import { withTimeout } from "./timeout";
import {
	type PiMessageTokenCacheEntry,
	tokenizePiMessages,
} from "./tokenize-pi-messages";
import { createPiTranscript } from "./transcript-pi";

/** The handler blocks when the emergency threshold reaches at least 95%. */
const EMERGENCY_BLOCK_PERCENTAGE = 95;

// Character-based `estimateTokens` omits provider-tokenizer and untagged structural/reasoning costs.
// The forward limit uses a 0.85 multiplier to reserve capacity for uncounted provider-tokenizer and structural costs.
// The forward limit uses 0.85 rather than 0.90 because 0.90 would start the 95% emergency band at ~360K.
const FORWARD_PRESSURE_LIMIT_FACTOR = 0.85;

// Pi recomputes the estimate from the live array on each call.
// The live-array estimate captures messages added during a turn that the persisted trailing count omits.
// `piUsage.tokens` uses the live array, so null persisted `token_count` values cannot affect it; the code discards `percent` because it includes output tokens.
function isPiHardCacheExpired(
	lastResponseTime: number,
	ttlMs: number,
	now: number,
): boolean {
	return lastResponseTime > 0 && now - lastResponseTime > ttlMs;
}

function applyForwardPressureFloor(
	trailingPercentage: number,
	trailingInputTokens: number,
	piUsageTokens: number | null | undefined,
	correctedLimit: number | undefined,
): { percentage: number; inputTokens: number } {
	const forwardTokens =
		typeof piUsageTokens === "number" && piUsageTokens > 0 ? piUsageTokens : 0;
	if (forwardTokens === 0 || !isSaneLimit(correctedLimit)) {
		return { percentage: trailingPercentage, inputTokens: trailingInputTokens };
	}
	// Only the forward-percentage calculation scales `LIMIT`; `usageContextLimit` remains unchanged.
	// `usageContextLimit` remains unscaled because the history budget and emergency-drop ceiling use its true value.
	// The handler keeps `forwardTokens` raw because emergency drops need the current assembled size.
	const forwardPressureLimit = correctedLimit * FORWARD_PRESSURE_LIMIT_FACTOR;
	const forwardPercentage = (forwardTokens / forwardPressureLimit) * 100;
	return forwardPercentage > trailingPercentage
		? {
				percentage: forwardPercentage,
				inputTokens: Math.max(trailingInputTokens, forwardTokens),
			}
		: { percentage: trailingPercentage, inputTokens: trailingInputTokens };
}

let injectM0M1PiForRun = injectM0M1Pi;
let persistReasoningWatermarkForRun = updateSessionMeta;
let persistStableIdSchemeForRun = updateSessionMeta;
let afterFallbackAdoptionForTests:
	| ((stableIdSchemeCutover: boolean) => void)
	| undefined;
let mutationGateObserverForTests:
	| ((snapshot: {
			foldDue: boolean;
			foldExecuted: boolean;
			shouldApplyPendingOps: boolean;
			shouldRunHeuristics: boolean;
			shouldRunReasoningCleanup: boolean;
	  }) => void)
	| undefined;

export const __test = {
	FORWARD_PRESSURE_LIMIT_FACTOR,
	isPiHardCacheExpired,
	adoptPiFallbackTags,
	applyForwardPressureFloor,
	buildEntryFingerprintMap,
	buildPiToolOwnerMap,
	readPiBranchEntriesForContext,
	getTaggedStableMessageIdsForTests(sessionId: string): ReadonlySet<string> {
		return new Set(taggedStableMessageIdsBySession.get(sessionId));
	},
	recordSuccessfulTaggedMessageIds,
	buildPiTextIdentityPlan,
	setInFlightHistorianForTests(
		sessionId: string,
		promise: Promise<unknown>,
	): () => void {
		inFlightHistorian.set(sessionId, promise);
		return () => {
			if (inFlightHistorian.get(sessionId) === promise) {
				inFlightHistorian.delete(sessionId);
			}
		};
	},
	setInjectM0M1PiForTests(fn: typeof injectM0M1Pi): () => void {
		injectM0M1PiForRun = fn;
		return () => {
			injectM0M1PiForRun = injectM0M1Pi;
		};
	},
	setReasoningWatermarkPersistenceForTests(
		fn: typeof updateSessionMeta,
	): () => void {
		persistReasoningWatermarkForRun = fn;
		return () => {
			persistReasoningWatermarkForRun = updateSessionMeta;
		};
	},
	setStableIdSchemePersistenceForTests(
		fn: typeof updateSessionMeta,
	): () => void {
		persistStableIdSchemeForRun = fn;
		return () => {
			persistStableIdSchemeForRun = updateSessionMeta;
		};
	},
	setAfterFallbackAdoptionForTests(
		fn: ((stableIdSchemeCutover: boolean) => void) | undefined,
	): () => void {
		afterFallbackAdoptionForTests = fn;
		return () => {
			afterFallbackAdoptionForTests = undefined;
		};
	},
	setMutationGateObserverForTests(
		fn: typeof mutationGateObserverForTests,
	): () => void {
		mutationGateObserverForTests = fn;
		return () => {
			mutationGateObserverForTests = undefined;
		};
	},
};

/**
 */
const DEFAULT_CLEAR_REASONING_AGE = 50;

/**
 * The Pi message stable-ID scheme version must increase when a durable stable-ID format change re-keys persisted state.
 * Sessions whose persisted `pi_stable_id_scheme` is below the current scheme version trigger one forced execute-and-materialize cutover.
 * Scheme version 0 (`NULL`) uses legacy index-based `pi-msg-${index}-...` IDs.
 * Scheme version 1 uses the real `SessionEntry.id` scheme (`resolvePiStableId`).
 */
const PI_STABLE_ID_SCHEME = 1;

/**
 * The scheduler waits until the configured quiet period elapses.
 * A session at ≥95% emits no repeated notification during defer passes.
 */
const lastEmergencyNotificationAtMs = new Map<string, number>();
const EMERGENCY_NOTIFICATION_COOLDOWN_MS = 60_000;

/**
 * The `commit_detected` trigger fires only when the current pass detects a recent commit and the previous pass did not.
 * The first pass records the baseline without firing `commit_detected`.
 * A restart does not emit `commit_detected` for a commit observed only on its first pass.
 * stale trigger).
 *
 * `clearContextHandlerSession()` removes the session's commit baseline when the session closes.
 */
const commitSeenLastPass = new Map<string, boolean>();

/**
 *
 * `historyRefreshSessions` invalidates the `<session-history>` injection cache.
 * `/ctx-flush`, historian publish, and compressor publish add sessions to `historyRefreshSessions`.
 * `runPipeline` removes a session from `historyRefreshSessions` after rebuilding its history injection.
 *    completes.
 *
 * `systemPromptRefreshSessions` refreshes disk- and database-derived system-prompt adjuncts.
 * `systemPromptRefreshSessions` refreshes `<project-docs>`, `<user-profile>`, `<key-files>`, and the sticky date.
 * `/ctx-flush`, system-prompt hash changes, dreamer publish, and user-memory promotion add sessions to `systemPromptRefreshSessions`.
 * `before_agent_start` removes a session from `systemPromptRefreshSessions` after refreshing or reusing its adjuncts.
 *
 * `pendingMaterializationSessions` schedules pending operations for the next execute pass.
 * `/ctx-flush` adds sessions to `pendingMaterializationSessions`; `runPipeline` removes them after materialization.
 *
 * A system-prompt hash change adds the session to all three refresh sets.
 * A system-prompt hash change invalidates the prefix cache.
 *
 * closure.
 */
const historyRefreshSessions = new Set<string>();
const systemPromptRefreshSessions = new Set<string>();
const pendingMaterializationSessions = new Set<string>();
const deferredHistoryRefreshSessions = new Set<string>();
const deferredMaterializationSessions = new Set<string>();
const sessionsByProject = new Map<string, Set<string>>();
const lastSeenProjectIdentityBySession = new Map<string, string>();
const rawMessageProviderUnregistersBySession = new Map<string, () => void>();
const activeContextHandlerSessions = new Set<string>();
const lastHeuristicsTurnIdBySession = new Map<string, string>();
const firstContextPassSeenBySession = new Set<string>();
const liveModelBySession = new Map<string, string>();
const taggedStableMessageIdsBySession = new Map<string, Set<string>>();
const taggersBySession = new Map<string, Tagger>();

function recordSuccessfulTaggedMessageIds(
	sessionId: string,
	entryIds: readonly (string | undefined)[],
): void {
	const liveRealIds = new Set<string>();
	for (const entryId of entryIds) {
		if (entryId && !entryId.startsWith("pi-msg-")) liveRealIds.add(entryId);
	}
	taggedStableMessageIdsBySession.set(sessionId, liveRealIds);
}

const piMessageTokenCacheBySession = new Map<
	string,
	Map<string, PiMessageTokenCacheEntry>
>();
const piTagTextTokenCacheBySession = new Map<
	string,
	Map<string, { text: string; tokenCount: number }>
>();
const piTagToolTokenCacheBySession = new Map<
	string,
	Map<string, { text: string; tokenCount: number }>
>();
const piTextIdentitySourceCacheBySession = new Map<
	string,
	Map<number, string>
>();

interface PiTextIdentityPlan {
	driftedMessageIds: Set<string>;
	reusableMessageIds: Set<string>;
	sourceCache: Map<number, string>;
}

function buildPiTextIdentityPlan(
	db: ContextDatabase,
	sessionId: string,
	tagger: Tagger,
	transcript: ReturnType<typeof createPiTranscript>,
	reuseCandidates: ReadonlySet<string> = new Set(),
): PiTextIdentityPlan {
	const currentSourcesByMessageId = new Map<string, string[]>();
	for (const message of transcript.messages) {
		const messageId = message.info.id;
		if (messageId === undefined) continue;
		currentSourcesByMessageId.set(
			messageId,
			// Temporal gap markers are not part of stored message identity and can disappear when compaction promotes a user message to the wire head.
			message.parts
				.filter((part) => part.kind === "text")
				.map((part) =>
					withoutPiLeadingTemporalMarker(stripTagPrefix(part.getText() ?? "")),
				),
		);
	}

	const legacyRowsByMessageId = new Map<
		string,
		Array<{ ordinal: number; tagId: number }>
	>();
	const versionedMessageIds = new Set<string>();
	for (const [contentId, tagId] of tagger.getAssignments(sessionId)) {
		const markerIndex = contentId.lastIndexOf(TEXT_TAG_IDENTITY_MARKER);
		if (markerIndex >= 0) {
			const ownerId = contentId.slice(0, markerIndex);
			if (currentSourcesByMessageId.has(ownerId))
				versionedMessageIds.add(ownerId);
			continue;
		}

		const ordinalMatch = /:p(\d+)$/.exec(contentId);
		if (!ordinalMatch) continue;
		const ownerId = contentId.slice(0, ordinalMatch.index);
		if (!currentSourcesByMessageId.has(ownerId)) continue;
		const ordinal = Number.parseInt(ordinalMatch[1] ?? "", 10);
		if (!Number.isSafeInteger(ordinal)) continue;
		const rows = legacyRowsByMessageId.get(ownerId) ?? [];
		rows.push({ ordinal, tagId });
		legacyRowsByMessageId.set(ownerId, rows);
	}

	let sourceCache = piTextIdentitySourceCacheBySession.get(sessionId);
	if (!sourceCache) {
		sourceCache = new Map();
		piTextIdentitySourceCacheBySession.set(sessionId, sourceCache);
	}
	const missingTagIds = Array.from(legacyRowsByMessageId.values())
		.flat()
		.map((row) => row.tagId)
		.filter((tagId) => !sourceCache.has(tagId));
	for (let offset = 0; offset < missingTagIds.length; offset += 500) {
		const loaded = getSourceContents(
			db,
			sessionId,
			missingTagIds.slice(offset, offset + 500),
		);
		for (const [tagId, source] of loaded) sourceCache.set(tagId, source);
	}

	const driftedMessageIds = new Set<string>();
	for (const [messageId, currentSources] of currentSourcesByMessageId) {
		const legacyRows = legacyRowsByMessageId.get(messageId) ?? [];
		if (versionedMessageIds.has(messageId)) {
			driftedMessageIds.add(messageId);
			continue;
		}
		if (legacyRows.length === 0) continue;
		legacyRows.sort((left, right) => left.ordinal - right.ordinal);
		const vectorMatches =
			legacyRows.length === currentSources.length &&
			legacyRows.every(
				(row, index) =>
					row.ordinal === index &&
					withoutPiLeadingTemporalMarker(sourceCache.get(row.tagId) ?? "") ===
						currentSources[index],
			);
		if (!vectorMatches) driftedMessageIds.add(messageId);
	}

	const reusableMessageIds = new Set<string>();
	for (const messageId of reuseCandidates) {
		if (!driftedMessageIds.has(messageId)) reusableMessageIds.add(messageId);
	}
	return { driftedMessageIds, reusableMessageIds, sourceCache };
}

interface PiBranchEntryLookup {
	entryIdByMessageRef: Map<object, string>;
	entryIdsByFingerprint: Map<string, string[]>;
	alignedEntryIds: (string | undefined)[];
}

interface PiBranchProjectionCache {
	leafId: string;
	entries: readonly unknown[];
	indexById: Map<string, number>;
	lookup: PiBranchEntryLookup;
}

const piBranchProjectionBySession = new Map<string, PiBranchProjectionCache>();
const piBranchLookupByProjection = new WeakMap<
	readonly unknown[],
	PiBranchEntryLookup
>();

function logTransformTiming(
	sessionId: string,
	stage: string,
	start: number,
	extra?: string,
): void {
	const elapsedMs = performance.now() - start;
	const elapsed = elapsedMs.toFixed(1);
	const suffix = extra ? ` ${extra}` : "";
	recordPiTransformTiming({ sessionId, stage, elapsedMs, extra });
	sessionLog(
		sessionId,
		`transform stage: stage=${stage} elapsed=${elapsed}ms${suffix}`,
	);
}

function resolvePiContextModelKey(ctx: ExtensionContext): string | undefined {
	const model = (ctx as { model?: { provider?: unknown; id?: unknown } }).model;
	if (!model) return undefined;
	if (typeof model.provider !== "string" || model.provider.length === 0) {
		return undefined;
	}
	if (typeof model.id !== "string" || model.id.length === 0) return undefined;
	return `${model.provider}/${model.id}`;
}

function readPiSessionMessageById(
	ctx: ExtensionContext,
	messageId: string,
): ReturnType<typeof readPiSessionMessages>[number] | null {
	return (
		readPiSessionMessages(ctx).find((message) => message.id === messageId) ??
		null
	);
}

function convertLocatedPiUserEntry(
	branchEntries: readonly unknown[],
	messageId: string,
): ReturnType<typeof readPiSessionMessages>[number] | null {
	let rawOrdinal = 0;
	let pendingToolStart = -1;
	for (let index = 0; index < branchEntries.length; index += 1) {
		const entry = branchEntries[index];
		if (!entry || typeof entry !== "object") continue;
		const record = entry as { type?: unknown; id?: unknown; message?: unknown };
		if (
			record.type !== "message" ||
			!record.message ||
			typeof record.message !== "object"
		) {
			continue;
		}
		const role = (record.message as { role?: unknown }).role;
		if (role === "toolResult") {
			if (pendingToolStart < 0) pendingToolStart = index;
			continue;
		}
		if (role === "assistant" && pendingToolStart >= 0) rawOrdinal += 1;
		rawOrdinal += 1;
		if (record.id === messageId && role === "user") {
			const start = pendingToolStart >= 0 ? pendingToolStart : index;
			const converted = convertEntriesToRawMessages(
				branchEntries.slice(start, index + 1) as unknown[],
			).find((message) => message.id === messageId);
			return converted ? { ...converted, ordinal: rawOrdinal } : null;
		}
		pendingToolStart = -1;
	}
	return null;
}

/**
 * The next transform pass rebuilds the session's injection cache.
 * Multiple callers can signal before the next transform pass; that pass observes the combined refresh.
 * combined effect.
 */
export function signalPiHistoryRefresh(sessionId: string): void {
	historyRefreshSessions.add(sessionId);
}

/**
 * The next agent start refreshes the session's system-prompt adjuncts.
 */
export function signalPiSystemPromptRefresh(sessionId: string): void {
	systemPromptRefreshSessions.add(sessionId);
}

/**
 * The next execute pass materializes the session's pending operations.
 */
export function signalPiPendingMaterialization(sessionId: string): void {
	pendingMaterializationSessions.add(sessionId);
}

export function clearPiM0Cache(
	db: ContextDatabase,
	sessionId: string,
	reason: string,
): void {
	clearM0M1PiCache(db, sessionId, reason);
}

export function signalPiDeferredHistoryRefresh(sessionId: string): void {
	deferredHistoryRefreshSessions.add(sessionId);
}

export function signalPiDeferredMaterialization(sessionId: string): void {
	deferredMaterializationSessions.add(sessionId);
}

export function consumeDeferredHistoryRefresh(sessionId: string): boolean {
	const wasSet = deferredHistoryRefreshSessions.has(sessionId);
	deferredHistoryRefreshSessions.delete(sessionId);
	return wasSet;
}

export function consumeDeferredMaterialization(sessionId: string): boolean {
	const wasSet = deferredMaterializationSessions.has(sessionId);
	deferredMaterializationSessions.delete(sessionId);
	return wasSet;
}

// A retention cap prevents leaks when session cleanup does not run.
// A crashed or force-quit Pi process skips `clearContextHandlerSession`, leaving its in-memory entries in a long-running host.
// The eviction policy removes the least-recently-tracked session when the live set exceeds the cap.
// Eviction uses `clearContextHandlerSession` to apply normal session cleanup.
// Eviction clears only in-memory session state.
// Eviction does not modify DB state.
const MAX_TRACKED_SESSIONS = 100;

export function trackSessionForProject(
	projectIdentity: string,
	sessionId: string,
): void {
	// The eviction routine reinserts sessions so Set iteration runs from least- to most-recently tracked.
	activeContextHandlerSessions.delete(sessionId);
	activeContextHandlerSessions.add(sessionId);
	let sessions = sessionsByProject.get(projectIdentity);
	if (!sessions) {
		sessions = new Set();
		sessionsByProject.set(projectIdentity, sessions);
	}
	sessions.add(sessionId);

	// The eviction routine evicts oldest tracked sessions beyond the cap through `clearContextHandlerSession`.
	// `clearContextHandlerSession` removes each evicted ID from `activeContextHandlerSessions`, so the eviction loop terminates.
	// The registration routine never evicts the session being registered.
	while (activeContextHandlerSessions.size > MAX_TRACKED_SESSIONS) {
		const oldest = activeContextHandlerSessions.values().next().value;
		if (oldest === undefined || oldest === sessionId) break;
		clearContextHandlerSession(oldest);
	}
}

function isContextHandlerSessionActive(sessionId: string): boolean {
	return activeContextHandlerSessions.has(sessionId);
}

function updateSessionProjectTracking(
	sessionId: string,
	projectIdentity: string | undefined,
	db?: ContextDatabase,
): void {
	if (!projectIdentity) return;
	const prev = lastSeenProjectIdentityBySession.get(sessionId);
	if (prev && prev !== projectIdentity) {
		const prevSessions = sessionsByProject.get(prev);
		prevSessions?.delete(sessionId);
		if (prevSessions?.size === 0) sessionsByProject.delete(prev);
		clearPiSystemPromptSession(sessionId);
	}

	// The identity-transition guard runs `clearContextHandlerSession` once per `(session, identity)` transition.
	if (db && prev !== projectIdentity) {
		try {
			recordSessionProjectIdentity(db, sessionId, projectIdentity);
		} catch {
		}
	}
	trackSessionForProject(projectIdentity, sessionId);
	lastSeenProjectIdentityBySession.set(sessionId, projectIdentity);
}

export function signalPiSystemPromptRefreshForProject(
	projectIdentity: string,
): void {
	const sessions = sessionsByProject.get(projectIdentity);
	if (!sessions) return;
	for (const sessionId of sessions) {
		systemPromptRefreshSessions.add(sessionId);
	}
}

export function recordPiLiveModel(sessionId: string, modelKey: string): void {
	liveModelBySession.set(sessionId, modelKey);
}

function summarizeTransformError(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	const normalized = raw.replace(/\s+/g, " ").trim();
	return normalized.length > 180
		? `${normalized.slice(0, 177).trimEnd()}...`
		: normalized || "Unknown transform error";
}

function persistLastTransformErrorIfChanged(
	db: ContextDatabase,
	sessionId: string,
	summary: string,
): void {
	try {
		const current = getOrCreateSessionMeta(db, sessionId).lastTransformError;
		if (current !== summary) {
			updateSessionMeta(db, sessionId, { lastTransformError: summary });
		}
	} catch (err) {
		sessionLog(
			sessionId,
			`transform error persistence failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

function clearLastTransformErrorIfSet(
	db: ContextDatabase,
	sessionId: string,
): void {
	try {
		const current = getOrCreateSessionMeta(db, sessionId).lastTransformError;
		if (current !== null) {
			updateSessionMeta(db, sessionId, { lastTransformError: null });
		}
	} catch (err) {
		sessionLog(
			sessionId,
			`transform error clear failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/**
 * The refresh check reads `systemPromptRefreshSessions` without draining it.
 */
export function hasSystemPromptRefresh(sessionId: string): boolean {
	return systemPromptRefreshSessions.has(sessionId);
}

/**
 * The `before_agent_start` handler clears the signal only after `processSystemPromptForCache(...)` succeeds. */
export function clearSystemPromptRefresh(sessionId: string): boolean {
	const wasSet = systemPromptRefreshSessions.has(sessionId);
	systemPromptRefreshSessions.delete(sessionId);
	return wasSet;
}

/**
 * */
export function hasPendingMaterialization(sessionId: string): boolean {
	return pendingMaterializationSessions.has(sessionId);
}

/**
 * */
export function consumePendingMaterialization(sessionId: string): boolean {
	const wasSet = pendingMaterializationSessions.has(sessionId);
	pendingMaterializationSessions.delete(sessionId);
	return wasSet;
}

/**
 * Deriving the union from `ContextEvent` keeps it synchronized with `@earendil-works/pi-coding-agent` without redeclaring it.
 *
 * The nudge, note-nudge, and auto-search helpers only inspect or mutate `user` and `assistant` messages.
 * The helpers leave `toolResult` and `custom` messages unchanged.
 */
type PiAgentMessage = ContextEvent["messages"][number];

/**
 * When `PiHistorianOptions` are provided, the context handler checks the compartment trigger after tagging and asynchronously fires `runPiHistorian` when `shouldFire` is true.
 * When `PiHistorianOptions` are omitted, the context handler does not invoke the historian.
 */
export interface PiHistorianOptions {
	/* */
	runner: SubagentRunner;
	/** `model` identifies the historian provider/model (for example, `anthropic/claude-haiku-4-5`). */
	model: string;
	/** `fallbackModels` tries fallback models in declaration order. */
	fallbackModels?: readonly string[];
	/** `historianChunkTokens` derives the chunk token budget. */
	historianChunkTokens: number;
	/** `timeoutMs` defaults to 120 seconds per call. */
	timeoutMs?: number;
	/** When `twoPass` is true, a successful first editor pass is followed by a second pass that removes low-signal `U:` lines and cross-compartment duplicates.
	 * This option mirrors OpenCode's `historian.two_pass` configuration. */
	twoPass?: boolean;
	/** Pi passes `thinkingLevel` to historian and compressor subagents as `--thinking <level>`.
	 * When `thinkingLevel` is unset, Pi applies its default thinking-level resolution.
	 * */
	thinkingLevel?: string;
	/** `memoryEnabled` gates cross-session memory through `memory.enabled`. */
	memoryEnabled?: boolean;
	/** `allowHomeProject` permits sessions started exactly in the canonical home directory only when user-level configuration enables them. */
	allowHomeProject?: boolean;
	/** autoPromote gates automatic promotion through `memory.auto_promote`. */
	autoPromote?: boolean;
	/** userMemoriesEnabled gates persistence of historian user observations as candidates.
	 * */
	userMemoriesEnabled?: boolean;
	language?: string;
	/** The historian calls onStatusChange after changing state. */
	onStatusChange?: (ctx: ExtensionContext, sessionId: string) => void;
	/**
	 * The trigger logic uses executeThresholdPercentage to compute pressure-driven trigger points.
	 */
	executeThresholdPercentage?:
		| number
		| { default: number; [modelKey: string]: number };
	/** executeThresholdTokens overrides token-based execute thresholds. */
	executeThresholdTokens?: {
		default?: number;
		[modelKey: string]: number | undefined;
	};
	/* */
	commitClusterTrigger?: { enabled: boolean; min_clusters: number };
	protectedTags?: number;
	clearReasoningAge?: number;
	/** historyBudgetPercentage reserves executable context for rendered `<session-history>`. */
	historyBudgetPercentage?: number;
}

/**
 * When enabled, the auto-search handler runs unifiedSearch against new user prompts.
 */
export interface PiAutoSearchHandlerOptions {
	enabled: boolean;
	scoreThreshold: number;
	minPromptChars: number;
}

/** Heuristic cleanup applies tiered emergency drops, deduplication, and system-injection stripping. */
export interface PiHeuristicsOptions {
	caveman?: { enabled: boolean; minChars: number };
	/**
	 * Number of tags before the most recent tag whose typed reasoning is
	 * cleared on cache-busting passes. Mirrors OpenCode's
	 * `clear_reasoning_age` config (`packages/plugin/src/config/schema/magic-context.ts`).
	 * Default `50` matches OpenCode and respects the user's configured
	 * clearing aggressiveness.
	 */
	clearReasoningAge?: number;
}

/** The injector writes compartments, facts, and memories into message[0]. */
export interface PiInjectionOptions {
	/** When memoryEnabled is false, the injector neither reads nor renders project memories in m[0] or m[1].
	 * */
	memoryEnabled?: boolean;
	/** When injectDocs is false, the injector omits `<project-docs>` and its hash from m[0]. */
	injectDocs?: boolean;
	injectionBudgetTokens: number;
	temporalAwareness?: boolean;
	/** During a full HARD context fold, muralEnabled renders a deterministic image of memories excluded by the context budget. */
	muralEnabled?: boolean;
}

/* */
export interface PiSchedulerOptions {
	executeThresholdPercentage:
		| number
		| { default: number; [modelKey: string]: number };
	executeThresholdTokens?: {
		default?: number;
		[modelKey: string]: number | undefined;
	};
}

export interface PiContextHandlerOptions {
	db: ContextDatabase;
	/** When enabled, smart drops reclaim tool output superseded by later calls in addition to age-based drops.
	 * */
	smartDrops?: boolean;
	/**
	 * When `heuristics` is configured, cleanup applies tiered emergency drops and caveman processing.
	 */
	heuristics?: PiHeuristicsOptions;
	/**
	 * When `injection` is omitted, the handler does not write the prepared compartment/fact/memory block to `message[0]`.
	 */
	injection?: PiInjectionOptions;
	/**
	 * `scheduler` gates heuristic cleanup when its TTL expires or its threshold is reached.
	 * `scheduler` defaults to a 65% threshold and 5-minute TTL when omitted.
	 */
	scheduler?: PiSchedulerOptions;
	/**
	 * The protected window covers the most recent tags and mirrors OpenCode's `protected_tags`.
	 * The handler defers drops whose tag IDs fall within the protected window.
	 * `applyPendingOperations` requeues protected drops as deferred.
	 * Deferred drops are re-evaluated on the next pass instead of being lost.
	 * Deferring protected drops preserves recent working context.
	 *
	 * `protectedTags` defaults to 20 and accepts values from 1 through 100.
	 */
	protectedTags?: number;
	language?: string;
	/**
	 * Without `historian`, context events tag and drop without changing historian state; otherwise, its trigger runs asynchronously after each tagging pass.
	 */
	historian?: PiHistorianOptions;
	/**
	 * When auto-search is omitted or disabled, no hint computation runs.
	 * Auto-search and OpenCode share the cortexkit DB, so memories are cross-harness.
	 */
	autoSearch?: PiAutoSearchHandlerOptions;
	/**
	 * The checkout's `.cortexkit/magic-context.jsonc` can define different `protected_tags` and thresholds.
	 * Without a resolver, passes after a project switch use the launch project's settings.
	 * The handler calls the resolver once per pass with the current `ctx.cwd` and uses the returned options for that pass.
	 * When `resolveForProject` is omitted, the handler uses the static options.
	 */
	resolveForProject?: (projectDir: string) => PiContextHandlerOptions;
	/** The compaction-off flag is resolved at boot and remains fixed for this Pi process. */
	compactionOff?: boolean;
	/** allowHomeProject permits a session started exactly in the canonical home directory only when user-level configuration enables it. */
	allowHomeProject?: boolean;
	maybeAutoEmbedSession?: (
		sessionId: string,
		projectDir: string,
		projectIdentity: string,
	) => void;
}

/**
 *
 *
 */
function resolveSessionId(ctx: ExtensionContext): string | undefined {
	const sm = ctx.sessionManager;
	if (sm === undefined) return undefined;
	const getSessionId = (sm as { getSessionId?: () => string | undefined })
		.getSessionId;
	if (typeof getSessionId !== "function") return undefined;
	try {
		const id = getSessionId.call(sm);
		if (typeof id !== "string" || id.length === 0) return undefined;
		return id;
	} catch {
		return undefined;
	}
}

/**
 *
 *
 *
 * The handler skips trimming when boundary lookup uses the synthesized fallback to avoid trimming the wrong slice.
 */
/**
 * `collectMessageEntryIds` returns IDs aligned 1:1 with `event.messages`, the `AgentMessage[]` that Pi's `buildSessionContext()` produces.
 *
 * `getBranch()` returns the leaf-to-root path, including entries that predate the latest compaction.
 * After compaction, filtering `getBranch()` for `type === "message"` can yield more entries than `event.messages`, breaking the index alignment required by `<session-history>` boundary trimming.
 *
 *
 * `collectMessageEntryIds` returns `undefined` at index 0 for the synthetic compaction summary message, which has no `SessionEntry` ID.
 *
 */
function collectMessageEntryIds(
	ctx: ExtensionContext,
	expectedLength: number,
	sessionId?: string,
	strict = false,
): readonly (string | undefined)[] | undefined {
	const sm = ctx.sessionManager as
		| {
				getBranch?: (fromId?: string) => unknown[];
				getLeafId?: () => string | undefined;
		  }
		| undefined;
	if (typeof sm?.getBranch !== "function") return undefined;

	let entries: unknown[];
	try {
		entries = sm.getBranch.call(sm);
	} catch {
		return undefined;
	}
	if (!Array.isArray(entries)) return undefined;

	let compactionIndex = -1;
	let firstKeptEntryId: string | undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i] as {
			type?: unknown;
			firstKeptEntryId?: unknown;
		} | null;
		if (e && typeof e === "object" && e.type === "compaction") {
			compactionIndex = i;
			if (typeof e.firstKeptEntryId === "string") {
				firstKeptEntryId = e.firstKeptEntryId;
			}
			break;
		}
	}

	const ids: (string | undefined)[] = [];

	// `isEmitEligible` matches the entry types that `buildSessionContext` converts to `AgentMessage`s.
	const isEmitEligible = (entry: unknown): entry is { id: string } => {
		if (!entry || typeof entry !== "object") return false;
		const t = (entry as { type?: unknown }).type;
		const id = (entry as { id?: unknown }).id;
		if (typeof id !== "string") return false;
		if (t === "message") return true;
		if (t === "custom_message") return true;
		if (t === "branch_summary") {
			const summary = (entry as { summary?: unknown }).summary;
			return typeof summary === "string" && summary.length > 0;
		}
		return false;
	};

	if (compactionIndex >= 0) {
		ids.push(undefined);

		if (firstKeptEntryId !== undefined) {
			let foundFirstKept = false;
			for (let i = 0; i < compactionIndex; i++) {
				const entry = entries[i];
				const entryId = (entry as { id?: unknown } | null)?.id;
				if (typeof entryId === "string" && entryId === firstKeptEntryId) {
					foundFirstKept = true;
				}
				if (!foundFirstKept) continue;
				if (isEmitEligible(entry)) {
					ids.push(entry.id);
				}
			}
		}

		for (let i = compactionIndex + 1; i < entries.length; i++) {
			const entry = entries[i];
			if (isEmitEligible(entry)) {
				ids.push(entry.id);
			}
		}
	} else {
		// full path.
		for (const entry of entries) {
			if (isEmitEligible(entry)) {
				ids.push(entry.id);
			}
		}
	}

	if (ids.length !== expectedLength) {
		const sm2 = sm as {
			getBranch?: (fromId?: string) => unknown[];
		};
		const totalEntries = entries.length;
		log(
			`[magic-context][pi]${sessionId ? `[${sessionId}]` : ""} collectMessageEntryIds length mismatch: ` +
				`expected=${expectedLength} got=${ids.length} (compactionIndex=${compactionIndex} ` +
				`firstKeptEntryId=${firstKeptEntryId ?? "<none>"} totalBranchEntries=${totalEntries})` +
				` — best-effort mapping returned; boundary trim may not match exactly`,
		);
		if (strict) return undefined;
		// `collectMessageEntryIds` retains the most recent IDs for boundary lookup when `ids` exceeds `expectedLength`.
		const _unused = sm2; // satisfy lint about unused alias above
		void _unused;
		if (ids.length < expectedLength) {
			const padded: (string | undefined)[] = [];
			for (let i = 0; i < expectedLength - ids.length; i++) {
				padded.push(undefined);
			}
			padded.push(...ids);
			return padded;
		}
		return ids.slice(ids.length - expectedLength);
	}

	return ids;
}

export function collectMessageEntryIdsStrict(
	ctx: ExtensionContext,
	expectedLength: number,
	sessionId?: string,
): readonly (string | undefined)[] | null {
	try {
		return collectMessageEntryIds(ctx, expectedLength, sessionId, true) ?? null;
	} catch (error) {
		sessionLog(
			sessionId ?? "pi",
			`collectMessageEntryIdsStrict failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		return null;
	}
}

/**
 * The handler uses content fingerprints because context and branch arrays need not share positions.
 * Pi clones context messages before extension handlers run, so production alignment uses content fingerprints.
 * Reference matching supports test doubles and Pi runtimes that do not clone context messages.
 *
 * Ambiguous fingerprints remain unresolved to avoid selecting the wrong durable boundary.
 * Custom and branch-summary wrappers remain unresolved because Pi synthesizes them for each context event.
 * Historian boundaries target only ordinary message entries.
 */
export function collectMessageEntryIdsByRef(
	ctx: ExtensionContext,
	messages: readonly PiAgentMessage[],
	sessionId?: string,
	preloadedBranchEntries?: readonly unknown[],
): readonly (string | undefined)[] | null {
	let entries: readonly unknown[];
	if (preloadedBranchEntries !== undefined) {
		entries = preloadedBranchEntries;
	} else {
		const sm = ctx.sessionManager as
			| {
					getBranch?: (fromId?: string) => unknown[];
			  }
			| undefined;
		if (typeof sm?.getBranch !== "function") return null;

		try {
			const branch = sm.getBranch.call(sm);
			if (!Array.isArray(branch)) return null;
			entries = branch;
		} catch (error) {
			sessionLog(
				sessionId ?? "pi",
				`collectMessageEntryIdsByRef getBranch failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return null;
		}
	}

	const { entryIdByMessageRef, entryIdsByFingerprint } =
		getPiBranchEntryLookup(entries);

	const result: (string | undefined)[] = new Array(messages.length);
	let resolved = 0;
	let fingerprintResolved = 0;
	const consumedFingerprintIds = new Set<string>();
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (!msg || typeof msg !== "object") {
			result[i] = undefined;
			continue;
		}
		const id = entryIdByMessageRef.get(msg as object);
		if (typeof id === "string") {
			result[i] = id;
			resolved += 1;
			continue;
		}
		const fingerprint = piMessageEntryFingerprint(msg);
		const fingerprintBucket = fingerprint
			? entryIdsByFingerprint.get(fingerprint)
			: undefined;
		// Repeated or cloned messages can share timestamps, roles, and text.
		// Ambiguous fingerprint buckets remain unresolved to avoid anchoring clones to the wrong SessionEntry.
		const fingerprintId =
			fingerprintBucket?.length === 1 &&
			!consumedFingerprintIds.has(fingerprintBucket[0] as string)
				? fingerprintBucket[0]
				: undefined;
		if (typeof fingerprintId === "string") {
			consumedFingerprintIds.add(fingerprintId);
			result[i] = fingerprintId;
			resolved += 1;
			fingerprintResolved += 1;
		} else {
			result[i] = undefined;
		}
	}

	if (resolved < messages.length) {
		log(
			`[magic-context][pi]${sessionId ? `[${sessionId}]` : ""} ` +
				`collectMessageEntryIdsByRef: resolved=${resolved}/${messages.length} ` +
				`(fingerprint=${fingerprintResolved}, branchEntries=${entries.length}, messageEntries=${entryIdByMessageRef.size}) — ` +
				`unmapped slots fall through to synthesized ids; boundary lookup still works ` +
				`for any compartment whose start/end message is among the resolved set`,
		);
	}

	return result;
}

function addPiBranchEntryToLookup(
	lookup: PiBranchEntryLookup,
	entry: unknown,
): void {
	if (!entry || typeof entry !== "object") return;
	const row = entry as { type?: unknown; id?: unknown; message?: unknown };
	if (
		row.type !== "message" ||
		typeof row.id !== "string" ||
		!row.message ||
		typeof row.message !== "object"
	) {
		return;
	}
	lookup.entryIdByMessageRef.set(row.message as object, row.id);
	const fingerprint = piMessageEntryFingerprint(row.message);
	if (!fingerprint) return;
	const bucket = lookup.entryIdsByFingerprint.get(fingerprint);
	if (bucket) bucket.push(row.id);
	else lookup.entryIdsByFingerprint.set(fingerprint, [row.id]);
}

function isPiContextEmitEligible(entry: unknown): entry is { id: string } {
	if (!entry || typeof entry !== "object") return false;
	const row = entry as { type?: unknown; id?: unknown; summary?: unknown };
	if (typeof row.id !== "string") return false;
	return (
		row.type === "message" ||
		row.type === "custom_message" ||
		(row.type === "branch_summary" &&
			typeof row.summary === "string" &&
			row.summary.length > 0)
	);
}

function buildPiAlignedEntryIds(
	entries: readonly unknown[],
): (string | undefined)[] {
	let compactionIndex = -1;
	let firstKeptEntryId: string | undefined;
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const row = entries[index] as
			| { type?: unknown; firstKeptEntryId?: unknown }
			| undefined;
		if (row?.type !== "compaction") continue;
		compactionIndex = index;
		firstKeptEntryId =
			typeof row.firstKeptEntryId === "string"
				? row.firstKeptEntryId
				: undefined;
		break;
	}
	if (compactionIndex < 0) {
		return entries.filter(isPiContextEmitEligible).map((entry) => entry.id);
	}

	const ids: (string | undefined)[] = [undefined];
	if (firstKeptEntryId !== undefined) {
		let foundFirstKept = false;
		for (let index = 0; index < compactionIndex; index += 1) {
			const entry = entries[index];
			if ((entry as { id?: unknown } | undefined)?.id === firstKeptEntryId) {
				foundFirstKept = true;
			}
			if (foundFirstKept && isPiContextEmitEligible(entry)) ids.push(entry.id);
		}
	}
	for (let index = compactionIndex + 1; index < entries.length; index += 1) {
		const entry = entries[index];
		if (isPiContextEmitEligible(entry)) ids.push(entry.id);
	}
	return ids;
}

// The first two prepended Pi messages already contain the compartment summaries.
// `appendCompaction` duplicates the summary on the next projection.
// The code removes `appendCompaction` only when the branch entry proves this plugin created the matching compaction.
function stripMcOwnedPiCompactionSummary(
	messages: PiAgentMessage[],
	entryIds: (string | undefined)[],
	branchEntries: readonly unknown[],
): boolean {
	const summaryMessage = messages[0] as
		| { role?: unknown; summary?: unknown; tokensBefore?: unknown }
		| undefined;
	if (summaryMessage?.role !== "compactionSummary") return false;

	let compaction:
		| {
				type?: unknown;
				summary?: unknown;
				tokensBefore?: unknown;
				fromHook?: unknown;
				details?: unknown;
		  }
		| undefined;
	for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
		const entry = branchEntries[index] as typeof compaction;
		if (entry?.type === "compaction") {
			compaction = entry;
			break;
		}
	}
	if (compaction?.fromHook !== true) return false;
	const details = compaction.details as { source?: unknown } | undefined;
	if (details?.source !== "magic-context") return false;
	if (
		summaryMessage.summary !== compaction.summary ||
		summaryMessage.tokensBefore !== compaction.tokensBefore ||
		entryIds[0] !== undefined
	) {
		return false;
	}

	messages.splice(0, 1);
	entryIds.splice(0, 1);
	return true;
}

function getPiBranchEntryLookup(
	entries: readonly unknown[],
): PiBranchEntryLookup {
	const cached = piBranchLookupByProjection.get(entries);
	if (cached) return cached;
	const lookup: PiBranchEntryLookup = {
		entryIdByMessageRef: new Map(),
		entryIdsByFingerprint: new Map(),
		alignedEntryIds: buildPiAlignedEntryIds(entries),
	};
	for (const entry of entries) addPiBranchEntryToLookup(lookup, entry);
	piBranchLookupByProjection.set(entries, lookup);
	return lookup;
}

/**
 *
 * Post-mutation consumers resolve each current message's entry ID by reference, avoiding stale positional indexes after splices.
 * `collectMessageEntryIdsByRef` must process `messages` in input order because fingerprint matching consumes bucket entries.
 * Unmapped messages defer anchor resolution.
 */
function buildEntryIdByRefMap(
	branchEntries: readonly unknown[] | null,
): Map<object, string> {
	return branchEntries
		? getPiBranchEntryLookup(branchEntries).entryIdByMessageRef
		: new Map();
}

function readPiBranchEntriesForContext(
	ctx: ExtensionContext,
	sessionId: string,
): readonly unknown[] | null {
	const sm = ctx.sessionManager as
		| {
				getLeafId?: () => string | null;
				getEntry?: (id: string) => unknown;
				getBranch?: (fromId?: string) => unknown[];
		  }
		| undefined;

	const installProjection = (
		leafId: string,
		entries: readonly unknown[],
	): readonly unknown[] => {
		const indexById = new Map<string, number>();
		const lookup = getPiBranchEntryLookup(entries);
		for (let index = 0; index < entries.length; index += 1) {
			const entry = entries[index];
			if (entry && typeof entry === "object") {
				const id = (entry as { id?: unknown }).id;
				if (typeof id === "string") indexById.set(id, index);
			}
		}
		const projection = { leafId, entries, indexById, lookup };
		piBranchProjectionBySession.set(sessionId, projection);
		piBranchLookupByProjection.set(entries, lookup);
		return entries;
	};

	const fallbackToBranch = (): readonly unknown[] | null => {
		if (typeof sm?.getBranch !== "function") return null;
		const entries = sm.getBranch.call(sm);
		if (!Array.isArray(entries)) return null;
		const leafId =
			typeof (entries.at(-1) as { id?: unknown } | undefined)?.id === "string"
				? ((entries.at(-1) as { id: string }).id ?? "")
				: "";
		return leafId ? installProjection(leafId, entries) : entries;
	};

	try {
		if (
			typeof sm?.getLeafId !== "function" ||
			typeof sm.getEntry !== "function"
		) {
			return fallbackToBranch();
		}
		const leafId = sm.getLeafId.call(sm);
		if (leafId === null) return [];
		if (typeof leafId !== "string" || leafId.length === 0) {
			return fallbackToBranch();
		}

		const cached = piBranchProjectionBySession.get(sessionId);
		if (cached?.leafId === leafId) return cached.entries;

		const suffix: unknown[] = [];
		const seen = new Set<string>();
		let cursor: string | null = leafId;
		let cachedAncestorIndex: number | undefined;
		while (cursor !== null) {
			const priorIndex = cached?.indexById.get(cursor);
			if (priorIndex !== undefined) {
				cachedAncestorIndex = priorIndex;
				break;
			}
			if (seen.has(cursor)) return fallbackToBranch();
			seen.add(cursor);
			const entry = sm.getEntry.call(sm, cursor);
			if (!entry || typeof entry !== "object") return fallbackToBranch();
			const row = entry as { id?: unknown; parentId?: unknown };
			if (
				row.id !== cursor ||
				(row.parentId !== null && typeof row.parentId !== "string")
			) {
				return fallbackToBranch();
			}
			suffix.push(entry);
			cursor = row.parentId as string | null;
		}
		suffix.reverse();

		if (cached && cachedAncestorIndex === cached.entries.length - 1) {
			const entries = [...cached.entries, ...suffix];
			if (
				suffix.some(
					(entry) =>
						(entry as { type?: unknown } | undefined)?.type === "compaction",
				)
			) {
				return installProjection(leafId, entries);
			}
			for (let index = 0; index < suffix.length; index += 1) {
				const entry = suffix[index];
				const id = (entry as { id: string }).id;
				cached.indexById.set(id, cached.entries.length + index);
				addPiBranchEntryToLookup(cached.lookup, entry);
				if (isPiContextEmitEligible(entry)) {
					cached.lookup.alignedEntryIds.push(entry.id);
				}
			}
			const projection = {
				leafId,
				entries,
				indexById: cached.indexById,
				lookup: cached.lookup,
			};
			piBranchProjectionBySession.set(sessionId, projection);
			piBranchLookupByProjection.set(entries, cached.lookup);
			return entries;
		}

		const entries =
			cached && cachedAncestorIndex !== undefined
				? [...cached.entries.slice(0, cachedAncestorIndex + 1), ...suffix]
				: suffix;
		return installProjection(leafId, entries);
	} catch (error) {
		sessionLog(
			sessionId,
			`Pi branch projection failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		try {
			return fallbackToBranch();
		} catch (fallbackError) {
			sessionLog(
				sessionId,
				`Pi branch pre-read failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
			);
			return null;
		}
	}
}

function piMessageEntryFingerprint(message: unknown): string | null {
	if (!message || typeof message !== "object") return null;
	const record = message as {
		responseId?: unknown;
		timestamp?: unknown;
		role?: unknown;
		toolCallId?: unknown;
		content?: unknown;
	};
	if (typeof record.role !== "string") return null;
	const firstText = firstPiTextContent(record.content);
	const firstTextHash = crypto
		.createHash("sha256")
		.update(firstText ?? "")
		.digest("hex")
		.slice(0, 16);
	return JSON.stringify([
		typeof record.responseId === "string" ? record.responseId : null,
		typeof record.timestamp === "number" || typeof record.timestamp === "string"
			? record.timestamp
			: null,
		record.role,
		typeof record.toolCallId === "string" ? record.toolCallId : null,
		firstTextHash,
	]);
}

function firstPiTextContent(content: unknown): string | null {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return null;
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const record = part as { type?: unknown; text?: unknown };
		if (record.type === "text" && typeof record.text === "string") {
			return record.text;
		}
	}
	return null;
}

/**
 * Tag adoption requires the fingerprint to remain byte-stable across fallback and real-ID passes.
 * Only message entries receive persisted fingerprints; tool tags are out of scope.
 */
function buildEntryFingerprintMap(
	messages: readonly PiAgentMessage[],
	resolveStableId: (msg: unknown, index: number) => string | undefined,
	reusableMessageIds?: ReadonlySet<string>,
	includeReusable = true,
): Map<string, string> {
	const map = new Map<string, string>();
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		const id = resolveStableId(msg, i);
		if (!id) continue;
		if (!includeReusable && reusableMessageIds?.has(id)) continue;
		const fp = piMessageEntryFingerprint(msg);
		if (fp) map.set(id, fp);
	}
	return map;
}

function piToolOwnerMapKey(timestamp: number, callId: string): string {
	return `${timestamp}\x00${callId}`;
}

function buildPiToolOwnerMap(
	messages: readonly PiAgentMessage[],
	resolveStableId: (msg: unknown, index: number) => string | undefined,
): Map<string, Set<string>> {
	const map = new Map<string, Set<string>>();
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (!message || typeof message !== "object") continue;
		const msg = message as {
			role?: unknown;
			content?: unknown;
			timestamp?: unknown;
		};
		if (msg.role !== "assistant") continue;
		if (typeof msg.timestamp !== "number" || !Number.isFinite(msg.timestamp)) {
			continue;
		}
		if (!Array.isArray(msg.content)) continue;
		const ownerRealId = resolveStableId(message, i);
		if (!ownerRealId || ownerRealId.startsWith("pi-msg-")) continue;
		for (const part of msg.content) {
			if (!part || typeof part !== "object") continue;
			const p = part as { type?: unknown; id?: unknown };
			if (p.type !== "toolCall") continue;
			if (typeof p.id !== "string" || p.id.length === 0) continue;
			const key = piToolOwnerMapKey(msg.timestamp, p.id);
			let owners = map.get(key);
			if (!owners) {
				owners = new Set<string>();
				map.set(key, owners);
			}
			owners.add(ownerRealId);
		}
	}
	return map;
}

function parsePiFallbackToolOwnerId(
	ownerMsgId: string,
): { timestamp: number; role: string } | null {
	const match = /^pi-msg-\d+-(\d+)-(.+)$/.exec(ownerMsgId);
	if (!match) return null;
	const timestamp = Number(match[1]);
	if (!Number.isFinite(timestamp)) return null;
	return { timestamp, role: match[2] ?? "" };
}

interface AdoptPiFallbackTagsOptions {
	messages?: readonly PiAgentMessage[];
	resolveStableId?: (msg: unknown, index: number) => string | undefined;
	hasFallbackMessageTags?: boolean;
	hasFallbackToolOwnerTags?: boolean;
}

function hasAdoptablePiFallbackMessageTags(
	db: ContextDatabase,
	sessionId: string,
	fingerprintById: ReadonlyMap<string, string>,
): boolean {
	for (const [realMessageId, fingerprint] of fingerprintById) {
		if (realMessageId.startsWith("pi-msg-")) continue;
		if (findAdoptableFallbackTags(db, sessionId, fingerprint).length > 0) {
			return true;
		}
	}
	return false;
}

/**
 * Fallback-tag adoption runs before tagging so tagging reuses adopted tags instead of allocating duplicates.
 */
function adoptPiFallbackTags(
	db: ContextDatabase,
	sessionId: string,
	tagger: Tagger,
	fingerprintById: ReadonlyMap<string, string>,
	options: AdoptPiFallbackTagsOptions = {},
): void {
	// The adoption pre-pass re-probes negative results so it observes commits made before adoption starts.
	const hasFallbackMessageTags =
		options.hasFallbackMessageTags === true ||
		hasPiFallbackMessageTags(db, sessionId);
	const hasFallbackToolOwnerTags =
		options.hasFallbackToolOwnerTags === true ||
		hasPiFallbackToolOwnerTags(db, sessionId);
	const shouldRunMessageMigration =
		hasFallbackMessageTags &&
		hasAdoptablePiFallbackMessageTags(db, sessionId, fingerprintById);
	const shouldRunToolOwnerMigration = Boolean(
		options.messages && options.resolveStableId && hasFallbackToolOwnerTags,
	);
	if (!shouldRunMessageMigration && !shouldRunToolOwnerMigration) return;

	// db.transaction() uses a savepoint inside an existing transaction.
	db.transaction(() => {
		if (shouldRunMessageMigration) {
			for (const [realMessageId, fingerprint] of fingerprintById) {
				// Only real IDs can be adoption targets; pi-msg-* IDs remain fallback aliases.
				if (realMessageId.startsWith("pi-msg-")) continue;
				const candidates = findAdoptableFallbackTags(
					db,
					sessionId,
					fingerprint,
				);
				if (candidates.length === 0) continue;
				// A unique fallback-message base ID proves that one fallback message supplied the fingerprint.
				// Ambiguous fallback-message bases skip adoption so tagTranscript allocates a new tag.
				// fresh.
				const baseIds = new Set<string>();
				for (const c of candidates) {
					const m = /^(.*):p\d+$/.exec(c.messageId);
					baseIds.add(m ? m[1] : c.messageId);
				}
				if (baseIds.size !== 1) continue;
				for (const c of candidates) {
					const ordinalMatch = /:p(\d+)$/.exec(c.messageId);
					if (!ordinalMatch) continue;
					const realContentId = `${realMessageId}:p${ordinalMatch[1]}`;
					const adoption = adoptPiFallbackMessageTag(
						db,
						sessionId,
						c.tagNumber,
						c.messageId,
						realContentId,
					);
					if (adoption.action !== "skipped") {
						tagger.unbindTag(sessionId, c.messageId);
						if (adoption.action === "folded") {
							tagger.unbindTag(sessionId, realContentId);
						}
						tagger.bindTag(sessionId, realContentId, adoption.tagNumber);
					}
				}
			}
		}

		if (
			shouldRunToolOwnerMigration &&
			options.messages &&
			options.resolveStableId
		) {
			const ownerMap = buildPiToolOwnerMap(
				options.messages,
				options.resolveStableId,
			);
			for (const row of findPiFallbackToolOwnerTags(db, sessionId)) {
				const parsed = parsePiFallbackToolOwnerId(row.toolOwnerMessageId);
				if (parsed?.role !== "assistant") continue;
				const owners = ownerMap.get(
					piToolOwnerMapKey(parsed.timestamp, row.callId),
				);
				if (owners?.size !== 1) continue;
				const [realOwnerId] = owners;
				if (!realOwnerId || realOwnerId.startsWith("pi-msg-")) continue;
				const adoption = adoptPiFallbackToolOwnerTag(
					db,
					sessionId,
					row.tagNumber,
					row.callId,
					row.toolOwnerMessageId,
					realOwnerId,
				);
				if (adoption.action !== "skipped") {
					tagger.unbindToolTag(sessionId, row.toolOwnerMessageId, row.callId);
					if (adoption.action === "folded") {
						tagger.unbindToolTag(sessionId, realOwnerId, row.callId);
					}
					tagger.bindToolTag(
						sessionId,
						row.callId,
						realOwnerId,
						adoption.tagNumber,
					);
					const accounting = getPersistedToolTagAccounting(
						db,
						sessionId,
						adoption.tagNumber,
					);
					if (accounting) {
						tagger.setToolTagAccounting(
							sessionId,
							adoption.tagNumber,
							accounting,
						);
					}
				}
			}
		}
	}).immediate();
}

/**
 *
 */
export function registerPiContextHandler(
	pi: ExtensionAPI,
	baseOptions: PiContextHandlerOptions,
): void {
	const tagger = createTagger();

	// Caching avoids recreating the Scheduler on each context event.
	const schedulerCache = new WeakMap<PiSchedulerOptions, Scheduler>();
	const DEFAULT_SCHEDULER_CONFIG: PiSchedulerOptions = {
		executeThresholdPercentage: 65,
	};
	const schedulerFor = (opts: PiContextHandlerOptions): Scheduler => {
		const cfg = opts.scheduler ?? DEFAULT_SCHEDULER_CONFIG;
		let s = schedulerCache.get(cfg);
		if (!s) {
			s = createScheduler({
				executeThresholdPercentage: cfg.executeThresholdPercentage,
				executeThresholdTokens: cfg.executeThresholdTokens,
			});
			schedulerCache.set(cfg, s);
		}
		return s;
	};

	pi.on("context", async (event, ctx) => {
		const transformStartTime = performance.now();
		let sessionIdForError: string | undefined;
		try {
			const tFindSession = performance.now();
			const sessionId = resolveSessionId(ctx);
			if (sessionId === undefined) {
				log(
					"[magic-context][pi] context event fired with no session id (falling through unmodified)",
				);
				return;
			}
			sessionIdForError = sessionId;
			const projectDirectory = ctx.cwd;
			const fullWireMessageCount = event.messages.length;

			const options =
				baseOptions.resolveForProject?.(projectDirectory) ?? baseOptions;
			const schedulerConfig = options.scheduler ?? DEFAULT_SCHEDULER_CONFIG;
			const scheduler = schedulerFor(options);
			const projectIdentity =
				resolveProjectIdentityForSession(
					projectDirectory,
					options.allowHomeProject,
				) ?? "";
			updateSessionProjectTracking(sessionId, projectIdentity, options.db);
			if (projectIdentity) {
				try {
					revalidateEnforcementArtifacts(
						options.db,
						projectIdentity,
						resolveProjectRootDirectory(projectDirectory),
					);
				} catch (error) {
					sessionLog(
						sessionId,
						`enforcement artifact revalidation failed (retrying next pass): ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
			logTransformTiming(
				sessionId,
				"findSessionId",
				tFindSession,
				`messages=${event.messages.length}`,
			);

			const tEntryBranch = performance.now();
			const branchEntries = readPiBranchEntriesForContext(ctx, sessionId);
			schedulePiTransformDecisionResolve({
				db: options.db,
				sessionId,
				branchEntries,
			});
			const rawMessageProvider = {
				readMessages: () =>
					branchEntries !== null
						? convertEntriesToRawMessages([...branchEntries])
						: readPiSessionMessages(ctx),
				readMessageById: (messageId: string) =>
					readPiSessionMessageById(ctx, messageId),
			};
			rawMessageProviderUnregistersBySession.get(sessionId)?.();
			const unregisterRaw = setRawMessageProvider(
				sessionId,
				rawMessageProvider,
			);
			rawMessageProviderUnregistersBySession.set(sessionId, unregisterRaw);
			scheduleReconciliation(options.db, sessionId, readRawSessionMessages);
			// Fingerprint matching preserves alignment when another extension changes the message count.
			// Ambiguous fingerprints remain unresolved to avoid selecting the wrong durable boundary.
			const branchLookup =
				branchEntries === null ? null : getPiBranchEntryLookup(branchEntries);
			const alignedEntryIds = branchLookup?.alignedEntryIds ?? null;
			const resolvedEntryIds =
				alignedEntryIds?.length === event.messages.length
					? alignedEntryIds
					: branchEntries === null
						? null
						: collectMessageEntryIdsByRef(
								ctx,
								event.messages as readonly PiAgentMessage[],
								sessionId,
								branchEntries,
							);
			const strictEntryIds = resolvedEntryIds ? [...resolvedEntryIds] : null;
			if (
				strictEntryIds &&
				branchEntries &&
				options.injection &&
				!options.compactionOff &&
				stripMcOwnedPiCompactionSummary(
					event.messages as PiAgentMessage[],
					strictEntryIds,
					branchEntries,
				)
			) {
				logTransformTiming(
					sessionId,
					"mcCompactionSummarySuppression",
					tEntryBranch,
				);
			}
			if (strictEntryIds && options.injection && !options.compactionOff) {
				const removed = trimPiMessagesToCachedBoundary(
					options.db,
					sessionId,
					event.messages as unknown as Parameters<
						typeof trimPiMessagesToCachedBoundary
					>[2],
					strictEntryIds,
				);
				if (removed > 0) {
					logTransformTiming(
						sessionId,
						"cachedBoundaryEarlyTrim",
						tEntryBranch,
						`removed=${removed}`,
					);
				}
			}
			const entryIdByRef = buildEntryIdByRefMap(branchEntries);
			const previouslyTaggedIds =
				taggedStableMessageIdsBySession.get(sessionId);
			const reusableMessageIds = new Set<string>();
			if (strictEntryIds && previouslyTaggedIds) {
				for (const entryId of strictEntryIds) {
					if (entryId && previouslyTaggedIds.has(entryId)) {
						reusableMessageIds.add(entryId);
					}
				}
			}
			logTransformTiming(
				sessionId,
				"entryParseAndBranchResolution",
				tEntryBranch,
				`branchEntries=${branchEntries?.length ?? 0}`,
			);

			const tLastUser = performance.now();
			const latestUser = findLatestUserMessageIdPi(
				event.messages as PiAgentMessage[],
				buildPiMessageIdByIndex(
					event.messages as PiAgentMessage[],
					strictEntryIds,
				),
			);
			logTransformTiming(sessionId, "findLastUserMessageId", tLastUser);
			const tMessageIndexScheduling = performance.now();
			if (latestUser) {
				const located = branchEntries
					? convertLocatedPiUserEntry(branchEntries, latestUser.messageId)
					: null;
				scheduleIncrementalIndex(
					options.db,
					sessionId,
					latestUser.messageId,
					located ??
						((_sessionId, messageId) =>
							readPiSessionMessageById(ctx, messageId)),
				);
			}
			logTransformTiming(
				sessionId,
				"messageIndexScheduling",
				tMessageIndexScheduling,
			);

			// `session_meta.counter` column.
			const taggerFloor = strictEntryIds
				? deriveTagLoadFloor(options.db, sessionId, strictEntryIds)
				: 0;
			tagger.initFromDb(sessionId, options.db, taggerFloor);
			taggersBySession.set(sessionId, tagger);
			const isFirstContextPassForSession =
				!firstContextPassSeenBySession.has(sessionId);
			firstContextPassSeenBySession.add(sessionId);
			const piUsage = ctx.getContextUsage?.();
			const tModelDetect = performance.now();
			// Without a seed, `previousModelKey` is undefined, so `modelChanged` is false and prior-model state leaks into the new model.
			// Without a seed, the prior model's detected-context-limit, reasoning-watermark, and historian-failure state can leak into the new model.
			if (
				isFirstContextPassForSession &&
				liveModelBySession.get(sessionId) === undefined
			) {
				// The handler reuses branchEntries because getBranch() is traversed once per event.
				const seeded = findLastModelKeyFromBranch(branchEntries);
				if (seeded !== undefined) {
					liveModelBySession.set(sessionId, seeded);
				}
			}
			const previousModelKey = liveModelBySession.get(sessionId);
			const currentModelKey = resolvePiContextModelKey(ctx);
			const modelChanged =
				previousModelKey !== undefined &&
				currentModelKey !== undefined &&
				piModelRefToCanonical(previousModelKey) !==
					piModelRefToCanonical(currentModelKey);
			if (currentModelKey !== undefined) {
				liveModelBySession.set(sessionId, currentModelKey);
			}

			// cache_ttl).
			// `effectiveContextLimit` already incorporates `detected_context_limit`.
			// Pi's `getContextUsage().percent` includes output tokens.
			// `sessionMetaForUsage` falls back to `piUsage` before the first `message_end` persists usage.
			const tMeta = performance.now();
			const sessionMetaForUsage = getOrCreateSessionMeta(options.db, sessionId);
			logTransformTiming(sessionId, "getOrCreateSessionMeta", tMeta);

			// `pending_pi_compaction_marker_state` and the deferred-drain sets are Pi's durable equivalent of OpenCode marker cleanup.
			// The transform reconciles before every phase so a disabled phase cannot drain or render stale MC compaction state.
			const compactionTransition = reconcilePiCompactionMode({
				db: options.db,
				sessionId,
				compactionOff: options.compactionOff === true,
				historianRunnable: options.historian !== undefined,
			});
			if (compactionTransition.recordToWrite) {
				if (compactionTransition.clearDeferredMarkerState) {
					clearPiCompactionOffInMemoryState(sessionId);
				}
				if (compactionTransition.invalidatedBaseline) {
					clearPiInjectionTokenCountCache(sessionId);
					sessionMetaForUsage.cachedM0Bytes = null;
					sessionMetaForUsage.cachedM1Bytes = null;
				}
				let noticeDelivered = compactionTransition.notice === null;
				if (compactionTransition.notice && ctx.ui?.notify) {
					ctx.ui.notify(compactionTransition.notice, "info");
					noticeDelivered = true;
				}
				if (noticeDelivered) {
					commitPiCompactionModeRecord(
						options.db,
						sessionId,
						compactionTransition.recordToWrite,
					);
				}
			}
			// A model change invalidates the safe-token baseline and alert state.
			// A model change clears all four pressure fields because the new model has different limits.
			const usageReset = {
				lastContextPercentage: 0,
				lastInputTokens: 0,
				observedSafeInputTokens: 0,
				cacheAlertSent: false,
			};
			if (modelChanged) {
				// A model change clears model-specific state unconditionally, even when usage is zero.
				// A model change discards the prior model's reasoning watermark, historian state, and detected context limit.
				sessionLog(
					sessionId,
					`transform: model switch ${previousModelKey} -> ${currentModelKey} reset — percentage=${sessionMetaForUsage.lastContextPercentage.toFixed(1)}% tokens=${sessionMetaForUsage.lastInputTokens} — clearing stale model-specific state`,
				);
				updateSessionMeta(options.db, sessionId, {
					...usageReset,
					clearedReasoningThroughTag: 0,
				});
				clearHistorianFailureState(options.db, sessionId);
				clearPersistedReasoningWatermark(options.db, sessionId);
				clearDetectedContextLimit(options.db, sessionId);
				clearEmergencyRecovery(options.db, sessionId);
				clearEmergencyDropSample(options.db, sessionId);
				sessionMetaForUsage.clearedReasoningThroughTag = 0;
				sessionMetaForUsage.lastContextPercentage = 0;
				sessionMetaForUsage.lastInputTokens = 0;
				sessionMetaForUsage.observedSafeInputTokens = 0;
				sessionMetaForUsage.cacheAlertSent = false;
			} else if (
				isFirstContextPassForSession &&
				sessionMetaForUsage.lastContextPercentage > 0
			) {
				// A same-model restart preserves historian failure state and the reasoning watermark.
				// The unchanged model retains its learned safe-input baseline across a restart.
				sessionLog(
					sessionId,
					`transform: first pass reset — percentage=${sessionMetaForUsage.lastContextPercentage.toFixed(1)}% tokens=${sessionMetaForUsage.lastInputTokens} — clearing stale usage state`,
				);
				updateSessionMeta(options.db, sessionId, {
					lastContextPercentage: 0,
					lastInputTokens: 0,
				});
				sessionMetaForUsage.lastContextPercentage = 0;
				sessionMetaForUsage.lastInputTokens = 0;
			}
			let usagePercentage = 0;
			let usageInputTokens = 0;
			// The transform uses persisted usage without recomputing its percentage; only raw getContextUsage usage needs denominator correction.
			let usedPersistedUsage = false;
			if (
				sessionMetaForUsage.lastContextPercentage > 0 &&
				sessionMetaForUsage.lastInputTokens > 0
			) {
				usagePercentage = sessionMetaForUsage.lastContextPercentage;
				usageInputTokens = sessionMetaForUsage.lastInputTokens;
				usedPersistedUsage = true;
			} else {
				usagePercentage =
					typeof piUsage?.percent === "number" ? piUsage.percent : 0;
				usageInputTokens =
					typeof piUsage?.tokens === "number" ? piUsage.tokens : 0;
			}
			let usageContextLimit = isSaneLimit(piUsage?.contextWindow)
				? piUsage.contextWindow
				: undefined;
			let detectedContextLimit: number | undefined;

			//
			// If a provider context-overflow error reports a valid limit, the recovery path prefers that limit.
			// The recovery path floors usagePercentage at 95%.
			//
			// Successful historian publication clears needsEmergencyRecovery.
			const tEmergencyRecovery = performance.now();
			let needsEmergencyBump = false;
			let emergencyRecoveryArmed = false;
			try {
				const overflowState = options.compactionOff
					? { detectedContextLimit: 0, needsEmergencyRecovery: false }
					: getOverflowState(options.db, sessionId);
				if (overflowState.detectedContextLimit > 0) {
					detectedContextLimit = overflowState.detectedContextLimit;
					// The recovery path prefers the detected limit because provider metadata can report an invalid context window.
					usageContextLimit = Math.min(
						usageContextLimit ?? overflowState.detectedContextLimit,
						overflowState.detectedContextLimit,
					);
				}
				emergencyRecoveryArmed = overflowState.needsEmergencyRecovery;
				needsEmergencyBump =
					overflowState.needsEmergencyRecovery && usagePercentage < 95;
			} catch (err) {
				sessionLog(
					sessionId,
					`transform: overflow state read failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}

			const sessionMeta = sessionMetaForUsage;
			const modelKey = liveModelBySession.get(sessionId);
			const providerId =
				typeof ctx.model?.provider === "string"
					? ctx.model.provider
					: undefined;
			const canUseEmptySentinels = modelAcceptsEmptyContent(providerId);
			// The fallback uses ctx.model.contextWindow when getContextUsage() has not reported a sane window.
			// isSaneLimit rejects bad windows so their values cannot reduce the budget below the 60K fallback.
			// Unknown or insane modelWindow leaves usageContextLimit undefined for live back-derivation.
			if (usageContextLimit === undefined) {
				const modelWindow = ctx.model?.contextWindow;
				if (isSaneLimit(modelWindow)) {
					usageContextLimit = modelWindow;
				}
			}
			const windowGeometry = resolvePiWindowGeometry({
				rawContextWindow: usageContextLimit,
				model: ctx.model,
				detectedContextLimit,
			});
			usageContextLimit = windowGeometry?.usableSoft;
			const effectiveExecuteThresholdPercentage = resolveExecuteThreshold(
				schedulerConfig.executeThresholdPercentage,
				modelKey,
				65,
				{
					tokensConfig: schedulerConfig.executeThresholdTokens,
					contextLimit: usageContextLimit,
					sessionId,
				},
			);
			const { forceMaterializationPercentage } = escalationBands(
				effectiveExecuteThresholdPercentage,
			);
			// When persisted usage is unavailable, Pi's usagePercentage uses the raw denominator, so the transform recomputes it against the corrected limit.
			// The recomputed percentage drives the scheduler check and the 85% and 95% cleanup paths.
			if (
				!usedPersistedUsage &&
				isSaneLimit(usageContextLimit) &&
				usageInputTokens > 0
			) {
				usagePercentage = (usageInputTokens / usageContextLimit) * 100;
			}
			({ percentage: usagePercentage, inputTokens: usageInputTokens } =
				applyForwardPressureFloor(
					usagePercentage,
					usageInputTokens,
					piUsage?.tokens,
					usageContextLimit,
				));
			const realUsagePercentageBeforeEmergencyBump = usagePercentage;
			// The recovery path applies the emergency bump after forward-pressure flooring so the bump cannot cap a higher reading.
			if (needsEmergencyBump) {
				sessionLog(
					sessionId,
					`transform: overflow recovery flag set — bumping percentage to 95% (detectedLimit=${usageContextLimit ?? "unknown"})`,
				);
				usagePercentage = Math.max(usagePercentage, 95);
			}
			let schedulerDecision: "execute" | "defer";
			const tScheduler = performance.now();
			try {
				schedulerDecision = scheduler.shouldExecute(
					sessionMeta,
					{ percentage: usagePercentage, inputTokens: usageInputTokens },
					Date.now(),
					sessionId,
					modelKey,
					usageContextLimit,
				);
			} catch (err) {
				sessionLog(
					sessionId,
					`scheduler failed (defaulting to defer): ${err instanceof Error ? err.message : String(err)}`,
				);
				schedulerDecision = "defer";
			}
			logTransformTiming(sessionId, "schedulerAndUsage", tScheduler);

			// A migrated Pi session can have existing JSONL without usage data or a last_response_time baseline.
			// Imported sessions force execution when the scheduler defers, usage is 0, `lastResponseTime` is 0, and the session has at least 50 messages.
			// would produce.
			//
			const piMessageCount = fullWireMessageCount;
			const looksLikeImportedSession =
				schedulerDecision === "defer" &&
				usagePercentage === 0 &&
				sessionMeta.lastResponseTime === 0 &&
				piMessageCount >= 50;
			if (looksLikeImportedSession && !options.compactionOff) {
				schedulerDecision = "execute";
				sessionLog(
					sessionId,
					`transform: large imported session detected (${piMessageCount} messages, no usage baseline) — forcing execute on first pass`,
				);
			}
			logTransformTiming(sessionId, "modelChangeDetection", tModelDetect);

			// Legacy `pi-msg-*` keys orphan persisted state after switching to real entry IDs.
			// `stableIdSchemeCutover` forces materialization so cleanup re-drops legacy content under entry IDs.
			// A successful cutover clears `stripped_placeholder_ids` so placeholder discovery uses real entry IDs.
			// The transform persists `PI_STABLE_ID_SCHEME` only after all transform phases succeed.
			const storedStableIdScheme = sessionMeta.piStableIdScheme ?? 0;
			// The cutover retries after `getBranch()` returns real entry IDs.
			const realEntryIdsAvailable =
				strictEntryIds?.some((id) => typeof id === "string" && id.length > 0) ??
				false;
			const stableIdSchemeCutover =
				storedStableIdScheme < PI_STABLE_ID_SCHEME && realEntryIdsAvailable;
			if (
				storedStableIdScheme < PI_STABLE_ID_SCHEME &&
				!realEntryIdsAvailable
			) {
				sessionLog(
					sessionId,
					`stable-id scheme cutover deferred: real SessionEntry ids unavailable this pass (branch resolution failed) — will retry when getBranch() succeeds`,
				);
			}
			if (stableIdSchemeCutover && !options.compactionOff) {
				schedulerDecision = "execute";
				signalPiPendingMaterialization(sessionId);
				// `prune` removes legacy `pi-msg-*` placeholder IDs because they are absent from real-ID `presentIds`.
				// `stripped_placeholder_ids` must remain intact until a successful pass; pre-clearing loses placeholder IDs on mid-pass failure.
				// `forceDiscovery` retries until the stable-ID scheme is stored.
				sessionLog(
					sessionId,
					`stable-id scheme cutover: stored=${storedStableIdScheme} < current=${PI_STABLE_ID_SCHEME} — forcing execute+materialize this pass`,
				);
			}

			const tBoundaryChecks = performance.now();
			const schedulerDecisionEarly = schedulerDecision;
			const midTurn = isMidTurnPi(event, sessionId, branchEntries);
			const bypassReason = detectMidTurnBypassReason({
				contextUsage: { percentage: usagePercentage },
				sessionMeta,
				historyRefreshSessions,
				sessionId,
				effectiveExecuteThresholdPercentage,
			});

			const { midTurnAdjustedSchedulerDecision, sideEffect } =
				options.compactionOff
					? {
							midTurnAdjustedSchedulerDecision: "defer" as const,
							sideEffect: "none" as const,
						}
					: applyMidTurnDeferral({
							base: schedulerDecisionEarly,
							bypassReason,
							midTurn,
						});

			if (sideEffect === "set-flag" && !options.compactionOff) {
				const flagPayload = {
					id: crypto.randomUUID(),
					reason: `${schedulerDecisionEarly}-${bypassReason}`,
					recordedAt: Date.now(),
				};
				setDeferredExecutePendingIfAbsent(options.db, sessionId, flagPayload);
			}

			schedulerDecision = midTurnAdjustedSchedulerDecision;
			// The deferred-execute flag is drained only by a successful execution; it does not promote `defer` to `execute`.
			// The scheduler re-returns `execute` on the next non-mid-turn pass while pressure holds.
			// When pressure drops below the threshold after a mid-turn defer, promotion would force a cache-busting pass instead of deferring.
			// `runPipeline` clears the deferred-execute flag only after it completes successfully.
			sessionLog(
				sessionId,
				`[boundary-exec] base=${schedulerDecisionEarly} bypass=${bypassReason} midTurn=${midTurn} effective=${midTurnAdjustedSchedulerDecision} sideEffect=${sideEffect}`,
			);

			// `forceMaterialization` enables drop-all-tools mode at the derived force band.
			const forceMaterialization =
				!options.compactionOff &&
				usagePercentage >= forceMaterializationPercentage;

			// The emergency block waits for an in-flight historian so queued drops materialize before the LLM call.
			// The emergency block applies `dropAllTools` to reduce prompt size.
			//
			// Pi extensions cannot call `client.session.abort()` mid-pass.
			// When no historian is in flight, `forceMaterialization` still applies `dropAllTools`.
			//     shrinks regardless.
			// The 30-second cap prevents a hung historian from delaying the user's LLM call.
			const hardUsagePercentage = needsEmergencyBump
				? Math.max(EMERGENCY_BLOCK_PERCENTAGE, usagePercentage)
				: windowGeometry?.usableHard && usageInputTokens > 0
					? (usageInputTokens / windowGeometry.usableHard) * 100
					: usagePercentage;
			// Without `ctx.model`, callers use `usagePercentage` because geometry cannot be resolved.
			const emergencyPercentage = ctx.model
				? hardUsagePercentage
				: usagePercentage;
			const isEmergency =
				!options.compactionOff &&
				emergencyPercentage >= EMERGENCY_BLOCK_PERCENTAGE;
			if (isEmergency) {
				const lastNotifiedAt =
					lastEmergencyNotificationAtMs.get(sessionId) ?? 0;
				const now = Date.now();
				if (now - lastNotifiedAt >= EMERGENCY_NOTIFICATION_COOLDOWN_MS) {
					lastEmergencyNotificationAtMs.set(sessionId, now);
					sendPiIgnoredNotification(
						ctx,
						"Context full — /ctx-flush or /clear to continue.",
					);
					sessionLog(
						sessionId,
						`EMERGENCY: usage=${usagePercentage.toFixed(1)}% — notified user, awaiting in-flight historian + applying drop-all-tools`,
					);
				}

				const histPromise = inFlightHistorian.get(sessionId);
				if (histPromise) {
					try {
						await withTimeout(histPromise, 30_000);
						sessionLog(
							sessionId,
							"EMERGENCY: historian wait completed (or timed out)",
						);
					} catch {
					}
				}

				// Clearing `emergencyRecoveryArmed` while the session remains oversized can cause the next send to overflow.
				// After usage falls below `forceMaterializationPercentage`, a stale emergency bump need not force every pass to 95%.
				// Disarming recovery does not clear the detected context limit.
				if (
					emergencyRecoveryArmed &&
					realUsagePercentageBeforeEmergencyBump <
						forceMaterializationPercentage &&
					!inFlightHistorian.has(sessionId) &&
					!hasEligiblePiCompartmentHistory(options.db, sessionId)
				) {
					try {
						clearEmergencyRecovery(options.db, sessionId);
						sessionLog(
							sessionId,
							"EMERGENCY: disarming recovery — no eligible pre-tail history to compact (would otherwise loop at 95%)",
						);
					} catch (err) {
						sessionLog(
							sessionId,
							`EMERGENCY: clearEmergencyRecovery failed: ${err instanceof Error ? err.message : String(err)}`,
						);
					}
				}
			}

			// `historyRefreshSessions` is the only injection-cache rebuild signal.
			//
			// Force and emergency passes do not rebuild the injection cache.
			// Force and emergency passes indicate that the current pass mutates tag state.
			//
			// Otherwise, every execute pass re-renders the history block and busts Anthropic's prompt cache after the execute threshold.
			// `runPipeline` removes `sessionId` from `historyRefreshSessions` only after `injectSessionHistoryIntoPi(...)` succeeds.
			// If injection throws in `runPipeline`, `runPipeline` retains `historyRefreshSessions` so the next pass rebuilds history.
			const isCacheBusting = historyRefreshSessions.has(sessionId);
			logTransformTiming(sessionId, "boundaryTriggerChecks", tBoundaryChecks);

			sessionLog(
				sessionId,
				`transform: usage=${usagePercentage.toFixed(1)}% (${usageInputTokens} tokens, limit=${usageContextLimit ?? "?"}) decision=${schedulerDecision}${forceMaterialization ? " force=true" : ""}${isEmergency ? " EMERGENCY=true" : ""}${isCacheBusting ? " busting=true" : ""}`,
			);
			logTransformTiming(
				sessionId,
				"emergencyRecoveryBlock",
				tEmergencyRecovery,
			);

			// `entryIds` uses historian's persisted ID format for `<session-history>` boundary lookups.
			const entryIds = strictEntryIds ?? undefined;

			// `emergencyCeilingTokens` is undefined when the context limit is unresolved, so emergency dropping skips that pass; the 95% block remains the backstop.
			const emergencyCeilingTokens =
				usageContextLimit && usageContextLimit > 0
					? Math.floor(
							usageContextLimit *
								// `emergencyCeilingTokens` uses the scheduler execute threshold because `options.historian` defaults to 65% when historian is disabled and ignores `execute_threshold_*`.
								(resolveExecuteThreshold(
									schedulerConfig.executeThresholdPercentage ?? 65,
									liveModelBySession.get(sessionId),
									65,
									{
										tokensConfig: schedulerConfig.executeThresholdTokens,
										contextLimit: usageContextLimit,
										sessionId,
									},
								) /
									100),
						)
					: undefined;

			logTransformTiming(sessionId, "prePipelineTotal", transformStartTime);
			const tRunPipeline = performance.now();
			const result = await runPipeline({
				db: options.db,
				tagger,
				sessionId,
				projectIdentity,
				projectDirectory,
				sessionMeta,
				messages: event.messages,
				smartDrops: options.smartDrops === true,
				protectedTags: options.protectedTags ?? 20,
				heuristics: options.heuristics,
				emergencyCeilingTokens,
				injection: options.injection
					? {
							...options.injection,
							memoryEnabled: options.injection.memoryEnabled,
							historyBudgetTokens: resolveHistoryBudgetTokensForPi({
								historyBudgetPercentage:
									options.historian?.historyBudgetPercentage,
								usagePercentage,
								usageInputTokens,
								usageContextLimit,
								executeThresholdPercentage:
									options.historian?.executeThresholdPercentage,
								executeThresholdTokens:
									options.historian?.executeThresholdTokens,
								modelKey: liveModelBySession.get(sessionId),
							}),
						}
					: undefined,
				entryIds,
				entryIdByRef,
				reusableMessageIds,
				stableIdSchemeCutover,
				schedulerDecision,
				// At 95% usage, emergency recovery drops all tools.
				forceMaterialization: forceMaterialization || isEmergency,
				forceMaterializationPercentage,
				contextUsage: {
					percentage: usagePercentage,
					inputTokens: usageInputTokens,
				},
				isCacheBusting,
				reasoningClearing: {
					clearReasoningAge:
						options.heuristics?.clearReasoningAge ??
						DEFAULT_CLEAR_REASONING_AGE,
				},
				canUseEmptySentinels,
				temporalAwareness: options.injection?.temporalAwareness === true,
				appendCompaction: resolvePiAppendCompaction(ctx),
				readBranchEntries: resolvePiReadBranchEntries(ctx),
				isSubagent: sessionMeta.isSubagent,
				compactionOff: options.compactionOff === true,
			});
			logTransformTiming(sessionId, "runPipeline", tRunPipeline);
			const postPipelineStart = performance.now();
			const tTransformDecision = performance.now();
			// The reuse window is replaced only after a successful pass. An ID absent from the current branch must complete one derivation pass if it returns; limiting the set to the live branch prevents session-long growth.
			if (strictEntryIds) {
				recordSuccessfulTaggedMessageIds(sessionId, strictEntryIds);
			}
			const piDecisionSnapshotNewestAssistant = result.bustedThisPass
				? findNewestPiAssistantEntryId(branchEntries)
				: undefined;
			if (piDecisionSnapshotNewestAssistant !== undefined) {
				recordPendingPiTransformDecision(
					sessionId,
					{
						tsMs: Date.now(),
						decision: schedulerDecision,
						materialized: result.materialized,
						materializeReason: normalizeMaterializeReason(
							"pi",
							result.materializeReason,
							result.materialized,
						),
						emergency: result.emergency,
						droppedTokens: result.droppedTokens,
						droppedCount: result.droppedCount,
						inputTokens: usageInputTokens,
						bustedThisPass: true,
					},
					piDecisionSnapshotNewestAssistant,
				);
			}
			logTransformTiming(
				sessionId,
				"transformDecisionAndReuseState",
				tTransformDecision,
			);

			// Historian config is optional, so tagging-only runs remain supported.
			const tHistorianScheduling = performance.now();
			if (options.historian && !options.compactionOff) {
				maybeFireHistorian({
					pi,
					ctx,
					sessionId,
					db: options.db,
					historian: options.historian,
					isFirstContextPassForSession,
					activeTags: result.activeTags,
					rawMessageProvider,
					taggerFloor,
				});
			}
			logTransformTiming(
				sessionId,
				"historianScheduling",
				tHistorianScheduling,
			);

			// Post-transform hints run after tagging and drops so they observe the post-mutation message shape.
			// Any thrown error is logged; the pipeline returns the already-mutated messages unchanged.
			const tPostTransform = performance.now();
			let outputMessages = result.messages as PiAgentMessage[];
			let assertTailHygieneLastWriter: (() => void) | undefined;

			const tNoteNudges = performance.now();
			try {
				if (!options.compactionOff) {
					outputMessages = applyNoteNudges({
						sessionId,
						db: options.db,
						messages: outputMessages,
						projectIdentity,
						entryIds: strictEntryIds,
						// The pipeline uses `result.postCommitEntryIdByRef` because commits and splices can change message-reference-to-entry-ID mappings.
						entryIdByRef: result.postCommitEntryIdByRef,
						// Sticky-anchor GC treats history refresh or executed work as cache-busting.
						isCacheBusting: isCacheBusting || result.executedWorkThisPass,
						// Sticky-anchor GC excludes leading synthetic messages from its denominator because they lack persisted entry IDs.
						syntheticLeadingCount: result.syntheticLeadingCount,
					});
				}
			} catch (err) {
				sessionLog(
					sessionId,
					`note nudges failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			logTransformTiming(sessionId, "noteNudges", tNoteNudges);

			const tAutoSearch = performance.now();
			if (options.autoSearch?.enabled && !options.compactionOff) {
				try {
					outputMessages = await runAutoSearchHintForPi({
						sessionId,
						db: options.db,
						messages: outputMessages,
						entryIds: strictEntryIds,
						entryIdByRef: result.postCommitEntryIdByRef,
						ensureProjectRegistered: () =>
							ensureProjectRegisteredFromPiDirectory(
								projectDirectory,
								options.db,
							),
						options: {
							enabled: true,
							scoreThreshold: options.autoSearch.scoreThreshold,
							minPromptChars: options.autoSearch.minPromptChars,
							projectPath: projectIdentity,
						},
					});
				} catch (err) {
					sessionLog(
						sessionId,
						`auto-search failed: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
			logTransformTiming(sessionId, "autoSearch", tAutoSearch);

			// Cache-busting passes inject a synthetic Pi `toolCall` and `toolResult` from `session_meta.last_todo_state`.
			// Deferred passes replay the persisted pair so its wire bytes remain identical.
			//
			// The cache-busting condition includes `result.executedWorkThisPass` because `isCacheBusting` covers only history refresh.
			// The cache-busting condition treats pending-op materialization, heuristic cleanup, and reasoning clearing as cache-busting work.
			// semantics.
			//
			const tTodoCapture = performance.now();
			try {
				const sessionMetaForTodo = getOrCreateSessionMeta(
					options.db,
					sessionId,
				);
				if (
					!options.compactionOff &&
					!sessionMetaForTodo.isSubagent &&
					sessionMetaForTodo.lastTodoState !== ""
				) {
					const isCacheBustingForTodo =
						isCacheBusting || result.executedWorkThisPass;
					// SAFETY: `PiAgentMessage` and plugin-core messages share every field that `injectSyntheticTodowriteForPi` reads and returns; TypeScript cannot unify the package types.
					outputMessages = injectSyntheticTodowriteForPi({
						db: options.db,
						sessionId,
						isSubagent: sessionMetaForTodo.isSubagent,
						isCacheBusting: isCacheBustingForTodo,
						lastTodoState: sessionMetaForTodo.lastTodoState,
						messages: outputMessages as unknown as Parameters<
							typeof injectSyntheticTodowriteForPi
						>[0]["messages"],
					}) as unknown as typeof outputMessages;
				}
			} catch (err) {
				sessionLog(
					sessionId,
					`synthetic todowrite injection failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			logTransformTiming(sessionId, "todoCapture", tTodoCapture);

			// Cache-busting passes replace the saved baseline; deferred passes retain it.
			// A deferred pass preserves the saved baseline and adds only newly appended content and protection-boundary moves.
			const tChannelAccounting = performance.now();
			try {
				const sessionMetaForCh1 = getOrCreateSessionMeta(options.db, sessionId);
				if (!options.compactionOff && !sessionMetaForCh1.isSubagent) {
					const tags = getTagsBySession(options.db, sessionId);
					const protectedTags = options.protectedTags ?? 20;
					const stableId = (message: unknown): string | undefined =>
						message && typeof message === "object"
							? result.postCommitEntryIdByRef.get(message)
							: undefined;
					const baseline = refreshPiTailHygieneBaseline({
						messages: outputMessages,
						tags,
						protectedTags,
						stableId,
						syntheticLeadingCount: result.syntheticLeadingCount,
						cacheBusting: result.bustedThisPass,
						previous: getPiChannel1Baseline(sessionId),
					});
					const effective = effectivePiTailHygiene(baseline);
					resetLastNudgeCycleIfTailShrank(options.db, sessionId, effective.u);
					const oldestReclaimableToolTags = getOldestActiveUnprotectedToolTags(
						options.db,
						sessionId,
						protectedTags,
					);
					const channelState = {
						...baseline,
						reducedSinceRefresh: false,
						oldestReclaimableToolTags,
					};
					setPiChannel1Baseline(sessionId, channelState);

					const channel2Evaluation = evaluateChannel2(channelState);
					if (channel2Evaluation.evaluable) {
						try {
							rearmChannel2AfterMeasuredCollapse({
								db: options.db,
								sessionId,
								baseline: channelState,
							});
						} catch (error) {
							sessionLog(
								sessionId,
								`pi channel2 U-collapse reset failed: ${error instanceof Error ? error.message : String(error)}`,
							);
						}
						if (channel2Evaluation.shouldTrigger) {
							casChannel2NudgeState(options.db, sessionId, "", "pending");
						} else {
							casChannel2NudgeState(options.db, sessionId, "pending", "");
						}
					}

					assertTailHygieneLastWriter = () =>
						assertPiTailHygieneContentUnchanged({
							messages: outputMessages,
							tags,
							protectedTags,
							stableId,
							syntheticLeadingCount: result.syntheticLeadingCount,
							expectedSignature: baseline.contentSignature,
						});
				} else {
					clearPiChannel1State(sessionId);
				}
			} catch (err) {
				const stale = getPiChannel1Baseline(sessionId);
				if (stale) {
					stale.evaluable = false;
					stale.generationInvalidated = true;
				}
				sessionLog(
					sessionId,
					`channel1 baseline / channel2 trigger failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			logTransformTiming(
				sessionId,
				"channelNudgeAccounting",
				tChannelAccounting,
			);

			// Every transform pass updates work metrics so sessions below the execute threshold populate Pi's status values.
			const tWorkMetrics = performance.now();
			try {
				const metrics = computePiWorkMetrics(outputMessages as unknown[]);
				setSessionWorkMetrics(
					options.db,
					sessionId,
					metrics.newWorkTokens,
					metrics.totalInputTokens,
				);
			} catch (err) {
				sessionLog(
					sessionId,
					`work-metrics update failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			logTransformTiming(sessionId, "workMetrics", tWorkMetrics);

			const tStableIdSchemePersist = performance.now();
			if (stableIdSchemeCutover && !options.compactionOff) {
				// The cutover pass stamps the scheme only after completion; failure ships the original messages so the next pass repeats forced placeholder discovery.
				persistStableIdSchemeForRun(options.db, sessionId, {
					piStableIdScheme: PI_STABLE_ID_SCHEME,
				});
				invalidateTrueRawTokenCache({
					sessionId,
					reason: "pi.stable-id-scheme.changed",
				});
				sessionLog(
					sessionId,
					`stable-id scheme cutover complete — stamped scheme=${PI_STABLE_ID_SCHEME}`,
				);
			}
			logTransformTiming(
				sessionId,
				"stableIdSchemePersist",
				tStableIdSchemePersist,
			);

			logTransformTiming(sessionId, "postTransformPhase", tPostTransform);

			// The rebuilt array is cast to `AgentMessage[]` because unchanged nudge, note, and auto-search messages retain identity and only mutated messages are rebuilt.
			clearLastTransformErrorIfSet(options.db, sessionId);
			options.maybeAutoEmbedSession?.(
				sessionId,
				projectDirectory,
				projectIdentity,
			);
			logTransformTiming(sessionId, "postPipelineTotal", postPipelineStart);
			const transformElapsedMs = performance.now() - transformStartTime;
			recordPiTransformTiming({
				sessionId,
				stage: "total",
				elapsedMs: transformElapsedMs,
				extra: `messages=${outputMessages.length} targets=${result.targetCount}`,
			});
			sessionLog(
				sessionId,
				`transform completed in ${transformElapsedMs.toFixed(1)}ms (${outputMessages.length} messages, ${result.targetCount} targets, watermark: ${result.reasoningWatermark})`,
			);
			if (
				assertTailHygieneLastWriter &&
				process.env.NODE_ENV !== "production"
			) {
				assertTailHygieneLastWriter();
			}
			return { messages: outputMessages } as {
				messages: typeof event.messages;
			};
		} catch (err) {
			// Fail-closed and emergency aborts must reach the user; do not fall through to native compaction.
			if (isFailClosedBlockingError(err) && !baseOptions.compactionOff)
				throw err;
			const message = err instanceof Error ? err.message : String(err);
			const stack = err instanceof Error ? err.stack : undefined;
			log(
				`[magic-context][pi] context handler failed (continuing without mutation): ${message}`,
				stack,
			);
			if (sessionIdForError) {
				persistLastTransformErrorIfChanged(
					baseOptions.db,
					sessionIdForError,
					summarizeTransformError(err),
				);
			}
			// The fallback leaves messages unmodified so Pi receives the originals.
			return;
		}
	});
	log(
		"[magic-context][pi] registered context handler (tagging + drops + nudges)",
	);
}

/**
 * Per-session in-flight historian Promises prevent concurrent runs and let shutdown await them without a per-turn DB lookup.
 *
 * `session_shutdown` awaits stored historian Promises before Pi exits; `--print` exits after `agent_end`.
 * subprocess mid-run.
 */
const inFlightHistorian = new Map<string, Promise<unknown>>();

/**
 */
export async function awaitInFlightHistorians(): Promise<void> {
	if (inFlightHistorian.size === 0) return;
	await Promise.allSettled(Array.from(inFlightHistorian.values()));
}

export function resolvePiHistorianTriggerInputs(args: {
	db: ContextDatabase;
	sessionId: string;
	historian: PiHistorianOptions;
	modelKey: string | undefined;
	usageContextLimit?: number;
}): {
	executeThresholdPercentage: number;
	triggerBudget: number;
	protectedTags: number | undefined;
	clearReasoningAge: number;
	commitClusterTrigger: { enabled: boolean; min_clusters: number } | undefined;
	contextLimit: number;
	/* */
	emergencyCeilingTokens: number;
} {
	// Pi supplies `usageContextLimit` from its runtime.
	const contextLimit =
		typeof args.usageContextLimit === "number" &&
		Number.isFinite(args.usageContextLimit) &&
		args.usageContextLimit > 0
			? args.usageContextLimit
			: DEFAULT_CONTEXT_LIMIT;
	const executeThresholdPercentage = resolveExecuteThreshold(
		args.historian.executeThresholdPercentage ?? 65,
		args.modelKey,
		65,
		{
			tokensConfig: args.historian.executeThresholdTokens,
			contextLimit,
			sessionId: args.sessionId,
		},
	);
	return {
		executeThresholdPercentage,
		triggerBudget: deriveTriggerBudget(
			contextLimit,
			executeThresholdPercentage,
		),
		protectedTags: args.historian.protectedTags,
		clearReasoningAge:
			args.historian.clearReasoningAge ?? DEFAULT_CLEAR_REASONING_AGE,
		commitClusterTrigger: args.historian.commitClusterTrigger,
		contextLimit,
		emergencyCeilingTokens: Math.floor(
			contextLimit * (executeThresholdPercentage / 100),
		),
	};
}

export function selectPiHistorianRunBoundarySnapshot(args: {
	resolvedBoundarySnapshot: ProtectedTailBoundarySnapshot;
	triggerBoundarySnapshot?: ProtectedTailBoundarySnapshot;
}): ProtectedTailBoundarySnapshot {
	// The runner uses `triggerBoundarySnapshot` when available to preserve the boundary evaluated by the trigger.
	return args.triggerBoundarySnapshot ?? args.resolvedBoundarySnapshot;
}

export function resolveHistoryBudgetTokensForPi(args: {
	historyBudgetPercentage: number | undefined;
	usagePercentage: number;
	usageInputTokens: number;
	usageContextLimit: number | undefined;
	executeThresholdPercentage: PiHistorianOptions["executeThresholdPercentage"];
	executeThresholdTokens: PiHistorianOptions["executeThresholdTokens"];
	modelKey: string | undefined;
}): number | undefined {
	const {
		historyBudgetPercentage,
		usagePercentage,
		usageInputTokens,
		usageContextLimit,
		executeThresholdPercentage,
		executeThresholdTokens,
		modelKey,
	} = args;
	if (!historyBudgetPercentage) return undefined;
	// When `usageContextLimit` is known, `usagePercentage === 0` does not disable budget resolution.
	const derivedLimit =
		usageContextLimit && usageContextLimit > 0
			? usageContextLimit
			: usagePercentage > 0 && usageInputTokens > 0
				? usageInputTokens / (usagePercentage / 100)
				: 0;
	if (!Number.isFinite(derivedLimit) || derivedLimit <= 0) return undefined;
	return Math.floor(
		derivedLimit *
			// `executeThresholdTokens` must affect history-budget resolution.
			(resolveExecuteThreshold(executeThresholdPercentage ?? 65, modelKey, 65, {
				tokensConfig: executeThresholdTokens,
				contextLimit: derivedLimit,
			}) /
				100) *
			historyBudgetPercentage,
	);
}

function startPiCompartmentLeaseRenewal(
	db: ContextDatabase,
	sessionId: string,
	holderId: string,
): ReturnType<typeof setInterval> {
	return setInterval(() => {
		try {
			if (!renewCompartmentLease(db, sessionId, holderId)) {
				sessionLog(
					sessionId,
					"compartment lease renewal failed; publish will be skipped if holder is stale",
				);
			}
		} catch (err) {
			// The compartment lease expires after five minutes if renewal is missed.
			sessionLog(
				sessionId,
				`compartment lease renewal threw; publish will be skipped if holder is stale (${err instanceof Error ? err.message : String(err)})`,
			);
		}
	}, COMPARTMENT_LEASE_RENEWAL_MS);
}

function ensureRunnablePiBoundaryForTests(
	snapshot: ProtectedTailBoundarySnapshot,
): ProtectedTailBoundarySnapshot {
	if (
		process.env.NODE_ENV !== "test" ||
		hasRunnableCompartmentWindow(snapshot)
	) {
		return snapshot;
	}
	const rawEnd =
		(snapshot.rawMessageCountAtTrigger ?? snapshot.protectedTailStart) + 1;
	const endOrdinal = Math.min(
		rawEnd,
		Math.max(snapshot.offset + 2, snapshot.protectedTailStart),
	);
	return {
		...snapshot,
		protectedTailStart: endOrdinal,
		eligibleEndOrdinal: endOrdinal,
		trueRawEligibleTokens: Math.max(1, snapshot.trueRawEligibleTokens),
		rawRangeFingerprint: "",
	};
}

function hasEligiblePiCompartmentHistory(
	db: ContextDatabase,
	sessionId: string,
	boundarySnapshot?: ProtectedTailBoundarySnapshot,
): boolean {
	try {
		const rawEligibility = getRawHistoryEligibility(db, sessionId);
		if (!rawEligibility.hasRawBeyondLastCompartment) return false;
		if (!boundarySnapshot)
			return rawEligibility.offset <= rawEligibility.rawMessageCount;
		return hasRunnableCompartmentWindow(
			ensureRunnablePiBoundaryForTests(boundarySnapshot),
		);
	} catch (err) {
		sessionLog(
			sessionId,
			`historian recovery eligibility failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return false;
	}
}

function sendPiIgnoredNotification(
	ctx: ExtensionContext,
	message: string,
): void {
	const uiNotify = (ctx as { ui?: { notify?: (message: string) => unknown } })
		.ui?.notify;
	if (typeof uiNotify === "function") {
		try {
			const result = uiNotify.call(ctx.ui, message);
			if (
				result &&
				typeof (result as PromiseLike<unknown>).then === "function"
			) {
				void Promise.resolve(result).catch((error) =>
					sessionLog("pi", "UI notification rejected:", error),
				);
			}
			return;
		} catch {
		}
	}
	sessionLog("pi", message);
}

function spawnPiHistorianRun(args: {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	sessionId: string;
	db: ContextDatabase;
	historian: PiHistorianOptions;
	provider: { readMessages: () => ReturnType<typeof readPiSessionMessages> };
	unregister: () => void;
	boundarySnapshot: ProtectedTailBoundarySnapshot;
	refreshBoundarySnapshot?: () => ProtectedTailBoundarySnapshot;
	currentContextLimit: number;
	fallbackModelId?: string;
}): void {
	const {
		pi,
		ctx,
		sessionId,
		db,
		historian,
		provider,
		unregister,
		boundarySnapshot,
		refreshBoundarySnapshot,
		currentContextLimit,
		fallbackModelId,
	} = args;
	const holderId = crypto.randomUUID();
	const runPromise = (async () => {
		const lease = acquireCompartmentLease(db, sessionId, holderId);
		if (!lease) {
			sessionLog(
				sessionId,
				"historian skipped: compartment lease held by another process",
			);
			return;
		}
		if (isWrapupInProgress(db, sessionId)) {
			// `/ctx-wrapup` can publish its marker between the initial check and lease acquisition; recheck after acquiring the lease.
			sessionLog(sessionId, "historian skipped: /ctx-wrapup became active");
			releaseCompartmentLease(db, sessionId, holderId);
			return;
		}
		const renewal = startPiCompartmentLeaseRenewal(db, sessionId, holderId);
		try {
			await runPiHistorian({
				db,
				sessionId,
				directory: ctx.cwd,
				provider,
				appendCompaction: resolvePiAppendCompaction(ctx),
				readBranchEntries: resolvePiReadBranchEntries(ctx),
				runner: historian.runner,
				historianModel: historian.model,
				fallbackModels: historian.fallbackModels,
				fallbackModelId,
				historianChunkTokens: historian.historianChunkTokens,
				boundarySnapshot,
				refreshBoundarySnapshot,
				currentContextLimit,
				historianTimeoutMs: historian.timeoutMs,
				twoPass: historian.twoPass,
				thinkingLevel: historian.thinkingLevel,
				memoryEnabled: historian.memoryEnabled,
				allowHomeProject: historian.allowHomeProject,
				autoPromote: historian.autoPromote,
				userMemoriesEnabled: historian.userMemoriesEnabled,
				language: historian.language,
				compartmentLeaseHolderId: holderId,
				notifyIssue: (text) => {
					if (!isContextHandlerSessionActive(sessionId)) {
						sessionLog(
							sessionId,
							"historian failure notice skipped after session context cleared",
						);
						return;
					}
					sendCtxStatusMessage(pi, {
						title: "Magic Context",
						text,
						level: "warning",
					});
				},
				onPublished: () => {
					const sessionStillActive = isContextHandlerSessionActive(sessionId);
					try {
						clearEmergencyRecovery(db, sessionId);
					} catch (err) {
						sessionLog(
							sessionId,
							`historian: clearEmergencyRecovery failed: ${err instanceof Error ? err.message : String(err)}`,
						);
					}
					// Historian publication invalidates the injection cache and queues drops for messages covered by new compartments.
					// `signalPiDeferredHistoryRefresh` schedules one rebuild for the next transform pass.
					// The next transform pass drains the refresh immediately after rebuilding.
					// `signalPiDeferredMaterialization` queues historian-published drops until a pipeline pass materializes them.
					// Without `signalPiDeferredMaterialization`, drops remain in `pending_ops` and context climbs to the derived force-materialization threshold.
					//
					// Historian does not change disk-backed adjuncts, so do not signal `systemPromptRefresh`.
					signalPiDeferredHistoryRefresh(sessionId);
					signalPiDeferredMaterialization(sessionId);
					if (sessionStillActive) {
						historian.onStatusChange?.(ctx, sessionId);
					} else {
						sessionLog(
							sessionId,
							"historian publication recorded after session clear; status callback skipped",
						);
					}
				},
			});
		} finally {
			clearInterval(renewal);
			releaseCompartmentLease(db, sessionId, holderId);
		}
	})().finally(() => {
		inFlightHistorian.delete(sessionId);
		unregister();
		if (isContextHandlerSessionActive(sessionId)) {
			historian.onStatusChange?.(ctx, sessionId);
		}
	});
	inFlightHistorian.set(sessionId, runPromise);
	historian.onStatusChange?.(ctx, sessionId);
}

function resolvePiAppendCompaction(
	ctx: ExtensionContext,
): PiHistorianDeps["appendCompaction"] {
	const sm = ctx.sessionManager as
		| {
				appendCompaction?: (
					summary: string,
					firstKeptEntryId: string,
					tokensBefore: number,
					details?: unknown,
					fromHook?: boolean,
				) => string | undefined;
		  }
		| undefined;
	if (typeof sm?.appendCompaction !== "function") return undefined;
	return sm.appendCompaction.bind(sm);
}

function resolvePiReadBranchEntries(
	ctx: ExtensionContext,
): (() => unknown[]) | undefined {
	const sm = ctx.sessionManager as { getBranch?: () => unknown[] } | undefined;
	if (typeof sm?.getBranch !== "function") return undefined;
	return () => {
		const entries = sm.getBranch?.call(sm);
		if (!Array.isArray(entries)) {
			throw new Error("Pi sessionManager.getBranch() did not return an array");
		}
		return entries;
	};
}

/**
 * `maybeFireHistorian` evaluates the trigger and invokes the historian without awaiting it.
 * `maybeFireHistorian` runs after synchronous tagging so trigger logic sees just-assigned tags.
 * just-assigned tags.
 *
 * Errors are logged but never propagated; the user's agent turn continues regardless of historian outcome.
 */
function maybeFireHistorian(args: {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	sessionId: string;
	db: ContextDatabase;
	historian: PiHistorianOptions;
	isFirstContextPassForSession?: boolean;
	activeTags?: ReturnType<typeof getActiveTagsBySession>;
	rawMessageProvider?: {
		readMessages: () => ReturnType<typeof readPiSessionMessages>;
	};
	taggerFloor?: number;
}): void {
	const { ctx, sessionId, db, historian, isFirstContextPassForSession } = args;

	if (inFlightHistorian.has(sessionId)) {
		sessionLog(sessionId, "historian trigger eval: in-flight, skipping");
		return;
	}

	if (isWrapupInProgress(db, sessionId)) {
		// `/ctx-wrapup` owns compartment-state publication while the wrapup marker is live.
		// The marker has a five-minute TTL renewed by wrapup; a crashed wrapup self-expires instead of suppressing trigger-fired historian runs forever.
		sessionLog(
			sessionId,
			"historian trigger eval: /ctx-wrapup active, skipping",
		);
		return;
	}

	// Pi's built-in `ctx.getContextUsage()` reports total-token percentage (`input + output + cache`), but historian and trigger math require wire-input pressure (`input + cacheRead + cacheWrite`).
	// `session_meta.lastContextPercentage` is computed by `pi-pressure.ts` against the effective context limit, including any `detected_context_limit` override.
	let usage: { percentage: number; inputTokens: number };
	let usageContextLimit: number | undefined;
	try {
		const piUsage = ctx.getContextUsage?.();
		let usageSource: "session_meta" | "piUsage fallback";
		// Only `isSaneLimit(limit)` may determine the trigger budget; a positive invalid window cannot.
		usageContextLimit = isSaneLimit(piUsage?.contextWindow)
			? piUsage.contextWindow
			: undefined;
		let detectedContextLimit: number | undefined;
		// Cold starts use the model's window until usage is reported.
		if (
			usageContextLimit === undefined &&
			isSaneLimit(ctx.model?.contextWindow)
		) {
			usageContextLimit = ctx.model.contextWindow;
		}
		// The detected overflow limit caps the trigger budget.
		try {
			const overflowState = getOverflowState(db, sessionId);
			if (overflowState.detectedContextLimit > 0) {
				detectedContextLimit = overflowState.detectedContextLimit;
				usageContextLimit = Math.min(
					usageContextLimit ?? overflowState.detectedContextLimit,
					overflowState.detectedContextLimit,
				);
			}
		} catch {
		}
		usageContextLimit = resolvePiUsableContextLimit({
			rawContextWindow: usageContextLimit,
			model: ctx.model,
			detectedContextLimit,
		});
		const sessionMetaForUsage = getOrCreateSessionMeta(db, sessionId);
		if (
			sessionMetaForUsage.lastContextPercentage > 0 &&
			sessionMetaForUsage.lastInputTokens > 0
		) {
			usage = {
				percentage: sessionMetaForUsage.lastContextPercentage,
				inputTokens: sessionMetaForUsage.lastInputTokens,
			};
			usageSource = "session_meta";
		} else {
			// The fallback uses Pi-reported usage only when no `message_end` run has recorded usage.
			// message_end runs.
			if (
				!piUsage ||
				piUsage.tokens === null ||
				piUsage.percent === null ||
				piUsage.contextWindow === 0
			) {
				sessionLog(
					sessionId,
					`historian trigger eval: no usage info yet (tokens=${piUsage?.tokens ?? "<no piUsage>"}, percent=${piUsage?.percent ?? "<no piUsage>"}, contextWindow=${piUsage?.contextWindow ?? "<no piUsage>"})`,
				);
				return;
			}
			// The fallback recomputes against `usageContextLimit` because `piUsage.percent` may use a different denominator.
			const fallbackPercentage =
				isSaneLimit(usageContextLimit) && piUsage.tokens > 0
					? (piUsage.tokens / usageContextLimit) * 100
					: piUsage.percent;
			usage = {
				percentage: fallbackPercentage,
				inputTokens: piUsage.tokens,
			};
			usageSource = "piUsage fallback";
		}
		usage = applyForwardPressureFloor(
			usage.percentage,
			usage.inputTokens,
			piUsage?.tokens,
			usageContextLimit,
		);
		sessionLog(
			sessionId,
			`historian trigger eval: usage=${usage.percentage.toFixed(1)}% (${usage.inputTokens} tokens) [${usageSource}], checking trigger...`,
		);
	} catch (err) {
		sessionLog(
			sessionId,
			`historian trigger eval: getContextUsage threw: ${err instanceof Error ? err.message : String(err)}`,
		);
		return;
	}

	// `rawMessageProvider` remains registered for `sessionId` until the historian finishes so shared trigger logic and the historian can read Pi session messages.
	// via `readRawSessionMessages`.
	const provider = args.rawMessageProvider ?? {
		readMessages: () => readPiSessionMessages(ctx),
	};
	const unregister = setRawMessageProvider(sessionId, provider);
	const sessionMeta = getOrCreateSessionMeta(db, sessionId);
	const modelKey = liveModelBySession.get(sessionId);
	const triggerInputs = resolvePiHistorianTriggerInputs({
		db,
		sessionId,
		historian,
		modelKey,
		usageContextLimit,
	});
	const historianForceMaterializationPercentage = escalationBands(
		triggerInputs.executeThresholdPercentage,
	).forceMaterializationPercentage;
	const boundaryContextLimit = triggerInputs.contextLimit;
	const resolvePiBoundarySnapshot = (
		emergencyTailScale?: 0.5 | 0.25,
	): ProtectedTailBoundarySnapshot =>
		resolveProtectedTailBoundary(
			resolveBoundaryContext({
				db,
				sessionId,
				mode: "pi-trigger",
				contextLimit: boundaryContextLimit,
				executeThresholdPercentage: triggerInputs.executeThresholdPercentage,
				usage,
				usageSource: "live",
				providerShapeVersion: "pi-folded-v1",
				cacheNamespace: `pi:${sessionId}`,
				emergencyTailScale,
			}),
		);
	const resolveRunnablePiBoundarySnapshot =
		(): ProtectedTailBoundarySnapshot => {
			let snapshot = ensureRunnablePiBoundaryForTests(
				resolvePiBoundarySnapshot(),
			);
			if (
				!hasRunnableCompartmentWindow(snapshot) &&
				usage.percentage >= historianForceMaterializationPercentage
			) {
				snapshot = ensureRunnablePiBoundaryForTests(
					resolvePiBoundarySnapshot(usage.percentage >= 95 ? 0.25 : 0.5),
				);
			}
			return snapshot;
		};
	let boundarySnapshot: ProtectedTailBoundarySnapshot | undefined;

	let triggered = false;
	try {
		if (isFirstContextPassForSession) {
			const sessionMeta = getOrCreateSessionMeta(db, sessionId);
			if (
				sessionMeta.compartmentInProgress &&
				!inFlightHistorian.has(sessionId)
			) {
				updateSessionMeta(db, sessionId, { compartmentInProgress: false });
				sessionLog(
					sessionId,
					"historian: cleared stale compartmentInProgress flag on first context pass after restart",
				);
			}

			const failureState = getHistorianFailureState(db, sessionId);
			if (failureState.failureCount > 0) {
				boundarySnapshot = resolveRunnablePiBoundarySnapshot();
			}
			const shouldRecoverOnFirstPass =
				failureState.failureCount > 0 &&
				boundarySnapshot !== undefined &&
				hasEligiblePiCompartmentHistory(db, sessionId, boundarySnapshot);
			if (shouldRecoverOnFirstPass) {
				triggered = true;
				sessionLog(
					sessionId,
					`historian recovery triggered on session load after ${failureState.failureCount} failure(s)`,
				);
				sendPiIgnoredNotification(
					ctx,
					`## Historian recovery\n\nHistorian previously failed ${failureState.failureCount} time(s), so Magic Context is retrying history comparting immediately after restart.`,
				);
				spawnPiHistorianRun({
					pi: args.pi,
					ctx,
					sessionId,
					db,
					historian,
					provider,
					unregister,
					boundarySnapshot: boundarySnapshot as ProtectedTailBoundarySnapshot,
					refreshBoundarySnapshot: resolveRunnablePiBoundarySnapshot,
					currentContextLimit: boundaryContextLimit,
					fallbackModelId: modelKey,
				});
				return;
			}
		}

		// Pi serializers omit empty thinking blocks, unlike OpenCode's canonical-Anthropic-only empty-sentinel path.
		const trigger = checkCompartmentTrigger(
			db,
			sessionId,
			sessionMeta,
			usage,
			0, // _previousPercentage — unused by current trigger logic
			triggerInputs.executeThresholdPercentage,
			triggerInputs.triggerBudget,
			triggerInputs.clearReasoningAge,
			triggerInputs.commitClusterTrigger,
			args.activeTags,
			boundaryContextLimit,
			() => {
				const messages = provider.readMessages();
				return { messages, absoluteMessageCount: messages.length };
			},
			args.taggerFloor,
			{ canClearReasoning: true },
		);

		if (!trigger.shouldFire) {
			sessionLog(
				sessionId,
				`historian trigger eval: shouldFire=false (no trigger condition met)`,
			);
			//
			// High pressure with no runnable window keeps emergency recovery armed.
			try {
				const overflowState = getOverflowState(db, sessionId);
				if (
					overflowState.needsEmergencyRecovery &&
					usage.percentage < historianForceMaterializationPercentage &&
					!inFlightHistorian.has(sessionId)
				) {
					boundarySnapshot ??= resolveRunnablePiBoundarySnapshot();
				}
				if (
					overflowState.needsEmergencyRecovery &&
					usage.percentage < historianForceMaterializationPercentage &&
					!inFlightHistorian.has(sessionId) &&
					boundarySnapshot !== undefined &&
					!hasRunnableCompartmentWindow(boundarySnapshot)
				) {
					clearEmergencyRecovery(db, sessionId);
					sessionLog(
						sessionId,
						`historian: disarming stale emergency recovery — real pressure ${usage.percentage.toFixed(1)}% with no runnable compartment window (would otherwise bump to 95% every pass)`,
					);
				}
			} catch (err) {
				sessionLog(
					sessionId,
					`historian: emergency-recovery disarm check failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			return;
		}

		triggered = true;
		sessionLog(
			sessionId,
			`historian trigger fired (reason=${trigger.reason ?? "unknown"}) usage=${usage.percentage.toFixed(1)}% — spawning subagent`,
		);

		// The parent LLM turn does not await `spawnPiHistorianRun`.
		// `pi --print` would kill the historian subprocess when the parent exits without shutdown waiting.
		spawnPiHistorianRun({
			pi: args.pi,
			ctx,
			sessionId,
			db,
			historian,
			provider,
			unregister,
			boundarySnapshot: selectPiHistorianRunBoundarySnapshot({
				resolvedBoundarySnapshot:
					boundarySnapshot ??
					trigger.boundarySnapshot ??
					resolveRunnablePiBoundarySnapshot(),
				triggerBoundarySnapshot: trigger.boundarySnapshot,
			}),
			refreshBoundarySnapshot: resolveRunnablePiBoundarySnapshot,
			currentContextLimit: boundaryContextLimit,
			fallbackModelId: modelKey,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		sessionLog(sessionId, `historian trigger eval failed: ${message}`);
	} finally {
		if (!triggered) unregister();
	}
}
interface RunPipelineArgs {
	db: ContextDatabase;
	tagger: Tagger;
	sessionId: string;
	projectIdentity: string;
	projectDirectory: string;
	sessionMeta: ReturnType<typeof getOrCreateSessionMeta>;
	messages: Parameters<typeof createPiTranscript>[0];
	/**
	 * */
	smartDrops?: boolean;
	protectedTags: number;
	/** When omitted, heuristic-cleanup config uses OpenCode parity defaults. */
	heuristics?: {
		caveman?: { enabled: boolean; minChars: number };
	};
	isSubagent?: boolean;
	/** Additive-only transform mode adds no tags, drops, history trim, markers, or nudges. */
	compactionOff?: boolean;
	/* */
	emergencyCeilingTokens?: number;
	/** When omitted, memory-injection config disables `<session-history>` injection. */
	injection?: {
		/**
		 * */
		memoryEnabled?: boolean;
		/** `injectDocs` defaults to true; when false, `m[0]` omits the `<project-docs>` block and docs hash. */
		injectDocs?: boolean;
		injectionBudgetTokens: number;
		/**
		 * */
		historyBudgetTokens?: number;
		temporalAwareness?: boolean;
		/** `muralEnabled` generates a deterministic image of memories excluded by the context budget during a full HARD context fold. */
		muralEnabled?: boolean;
	};
	/**
	 * Boundary lookup matches historian IDs with `RawMessage.id = entry.id`; callers must filter message entries from `ctx.sessionManager.getBranch()`, matching `buildSessionContext`.
	 *
	 * When `entryIds` is absent, boundary lookup uses synthesized IDs that do not match historian IDs, so `<session-history>` cannot trim raw history.
	 */
	entryIds?: readonly (string | undefined)[];
	/**
	 * `entryIdByRef` maps each `AgentMessage` reference to its entry ID; cloned messages fall back to `entryIds`.
	 * Transcript tagging and reasoning cleanup must resolve the same entry ID for each message.
	 */
	entryIdByRef?: ReadonlyMap<object, string> | null;
	/* */
	reusableMessageIds?: ReadonlySet<string>;
	/**
	 * `stableIdSchemeCutover` forces placeholder rediscovery after Pi message IDs switch from index-based IDs to entry IDs.
	 * The caller enables the cutover only after persisting the `pi_stable_id_scheme` version.
	 */
	stableIdSchemeCutover?: boolean;
	/**
	 * `schedulerDecision` determines whether heuristic cleanup runs for this pass.
	 * `"defer"` runs tagging, `applyFlushedStatuses`, and cached-injection replay.
	 */
	schedulerDecision: "execute" | "defer";
	/**
	 * `forceMaterialization` enables drop-all-tools mode.
	 * The caller derives `forceMaterialization` from current context usage.
	 */
	forceMaterialization?: boolean;
	/** `forceMaterializationPercentage` defaults to `85` for callers that omit it. */
	forceMaterializationPercentage?: number;
	contextUsage: { percentage: number; inputTokens: number };
	/**
	 * `isCacheBusting` rebuilds the prepared injection block for this pass.
	 * historyRefreshSessions set.
	 */
	isCacheBusting: boolean;
	/**
	 * When configured, execute passes replace eligible `PiThinkingContent` blocks with `[cleared]`.
	 * A block is eligible when its message is more than `clearReasoningAge` tags older than the newest tag.
	 * The code persists the cleared-through watermark in `session_meta.cleared_reasoning_through_tag`.
	 * Defer passes replay the persisted cleared-reasoning state.
	 *
	 * The provider transform always emits the interleaved `reasoning_content` field, even when no reasoning parts remain.
	 */
	reasoningClearing?: {
		clearReasoningAge: number;
	};
	/** `canUseEmptySentinels` is true only when the active provider filters empty sentinel content. */
	canUseEmptySentinels: boolean;
	/**
	 * When enabled, `temporalAwareness` causes the pipeline to inject `<!-- +Xm -->` markers into user `experimental.temporal_awareness` idempotently across passes.
	 */
	temporalAwareness?: boolean;
	appendCompaction?: ApplyDeferredPiCompactionMarkerDeps["appendCompaction"];
	readBranchEntries?: ApplyDeferredPiCompactionMarkerDeps["readBranchEntries"];
}

interface RunPipelineResult {
	messages: unknown[];
	/* */
	heuristicsExecuted: boolean;
	/* */
	executedWorkThisPass: boolean;
	/** `historyInjected` is true when `<session-history>` is written into `message[0]`. */
	historyInjected: boolean;
	/**
	 * `syntheticLeadingCount` excludes synthetic leading messages from Anchor-GC because they have no real entry ID and would otherwise keep `allResolved` false.
	 */
	syntheticLeadingCount: number;
	/* */
	heuristicsResult: PiHeuristicCleanupResult | null;
	injectionResult: PiInjectionResult | null;
	materialized: boolean;
	materializeReason: string | null;
	droppedTokens: number;
	droppedCount: number;
	emergency: boolean;
	bustedThisPass: boolean;
	targetCount: number;
	reasoningWatermark: number;
	activeTags: ReturnType<typeof getActiveTagsBySession>;
	/**
	 * `postCommitEntryIdByRef` maps post-commit `AgentMessage` objects to real `SessionEntry` IDs.
	 * Consumers after `runPipeline` must use `postCommitEntryIdByRef`.
	 * The pass-start `entryIdByRef` omits cloned dirty messages because it keys pre-commit objects.
	 * `postCommitEntryIdByRef` contains no `pi-msg-*` fallback IDs; unresolved branches remain unmapped.
	 * Consumers must use their degraded `entryIds === null` path when branch resolution leaves a message unmapped.
	 */
	postCommitEntryIdByRef: ReadonlyMap<object, string>;
}

function pendingPiMarkerCoveredByRenderedBoundary(
	pending: PendingPiCompactionMarker,
	injection: PiInjectionResult | null,
): boolean {
	// Contention-exhausted injections cannot authorize native trimming because served bytes can lag the latest compartment snapshot.
	if (!injection || injection.contentionExhausted) return false;
	// The m[0] arm accepts the boundary rendered into the m[0] snapshot.
	const boundary = injection.renderedBoundary;
	if (pending.endMessageId === boundary.endMessageId) return true;
	if (boundary.ordinal !== null && pending.ordinal <= boundary.ordinal)
		return true;
	// Fresh publications render their compartment into m[1], so m[1] coverage permits pending markers to drain without a HARD bust.
	// `m[1]` coverage requires a compartment freshly rendered during the pass.
	// `m1RenderedCoverage` is null for cached or sibling replays.
	const m1Coverage = injection.m1RenderedCoverage;
	if (!m1Coverage) return false;
	if (pending.endMessageId === m1Coverage.endMessageId) return true;
	return m1Coverage.ordinal !== null && pending.ordinal <= m1Coverage.ordinal;
}

function captureReasoningMutationRollback(
	messages: readonly unknown[],
): () => void {
	const snapshots: Array<{
		part: Record<string, unknown>;
		field: "thinking" | "text";
		value: unknown;
		hadSignature?: boolean;
		signature?: unknown;
	}> = [];
	for (const raw of messages) {
		if (!raw || typeof raw !== "object") continue;
		const message = raw as { role?: unknown; content?: unknown };
		if (message.role !== "assistant" || !Array.isArray(message.content))
			continue;
		for (const rawPart of message.content) {
			if (!rawPart || typeof rawPart !== "object") continue;
			const part = rawPart as Record<string, unknown>;
			if (part.type === "thinking") {
				snapshots.push({
					part,
					field: "thinking",
					value: part.thinking,
					hadSignature: Object.hasOwn(part, "thinkingSignature"),
					signature: part.thinkingSignature,
				});
			} else if (part.type === "text") {
				snapshots.push({ part, field: "text", value: part.text });
			}
		}
	}
	return () => {
		for (const snapshot of snapshots) {
			snapshot.part[snapshot.field] = snapshot.value;
			if (snapshot.field === "thinking") {
				if (snapshot.hadSignature) {
					snapshot.part.thinkingSignature = snapshot.signature;
				} else {
					delete snapshot.part.thinkingSignature;
				}
			}
		}
	};
}

async function runCompactionOffPipeline(
	args: RunPipelineArgs,
): Promise<RunPipelineResult> {
	let injectionResult: PiInjectionResult | null = null;
	if (args.injection) {
		injectionResult = injectM0M1Pi(
			{
				sessionId: args.sessionId,
				projectIdentity: args.projectIdentity,
				projectDirectory: args.projectDirectory,
				memoryEnabled: args.injection.memoryEnabled,
				injectDocs: args.injection.injectDocs,
				injectionBudgetTokens: args.injection.injectionBudgetTokens,
				historyBudgetTokens: args.injection.historyBudgetTokens,
				muralEnabled: args.injection.muralEnabled === true,
				compactionOff: true,
			},
			args.db,
			args.messages as Parameters<typeof injectM0M1Pi>[2],
			args.entryIds,
			false,
		);
	}
	return {
		messages: args.messages as unknown[],
		heuristicsExecuted: false,
		executedWorkThisPass: false,
		historyInjected: false,
		syntheticLeadingCount: injectionResult?.syntheticLeadingCount ?? 0,
		heuristicsResult: null,
		injectionResult,
		materialized: injectionResult?.m0Materialized === true,
		materializeReason: injectionResult?.m0Reason ?? null,
		droppedTokens: 0,
		droppedCount: 0,
		emergency: false,
		bustedThisPass: injectionResult?.m0Materialized === true,
		targetCount: 0,
		reasoningWatermark: args.sessionMeta.clearedReasoningThroughTag ?? 0,
		activeTags: [],
		postCommitEntryIdByRef: new Map(),
	};
}

async function runPipeline(args: RunPipelineArgs): Promise<RunPipelineResult> {
	if (args.compactionOff) return runCompactionOffPipeline(args);
	const forceMaterializationPercentage =
		args.forceMaterializationPercentage ??
		escalationBands(65).forceMaterializationPercentage;
	let executedWorkThisPass = false;
	let historyWasConsumedThisPass = false;
	let materializationSatisfiedThisPass = false;
	let pendingOpsAppliedThisPass = false;
	let pendingOpsDidMutate = false;
	let heuristicOrReasoningDidMutate = false;
	let didMutateFromFlushedStatuses = false;
	let droppedCount = 0;
	const droppedTokens = 0;
	let emergency = false;
	let autoReclaimDidMutateThisPass = false;
	let suppressDeferredHistoryDrain = false;
	let deferredMaterializationConsumedThisPass = false;
	let casLost = false;
	const deferredHistoryWasPendingAtPassStart =
		deferredHistoryRefreshSessions.has(args.sessionId);

	if (args.temporalAwareness) {
		const tTemporal = performance.now();
		try {
			const injected = injectPiTemporalMarkers(args.messages);
			if (injected > 0) {
				sessionLog(
					args.sessionId,
					`temporal-awareness: injected ${injected} gap markers`,
				);
			}
		} catch (err) {
			sessionLog(
				args.sessionId,
				`temporal-awareness failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		logTransformTiming(args.sessionId, "injectTemporalMarkers", tTemporal);
	}

	const tTranscriptBuild = performance.now();
	const transcript = createPiTranscript(
		args.messages,
		args.sessionId,
		args.entryIds,
	);
	logTransformTiming(args.sessionId, "transcriptBuild", tTranscriptBuild);
	const workingMessages = transcript.getWorkingMessages();
	const stableIdResolver = (msg: unknown, index: number): string | undefined =>
		resolvePiStableId(
			msg,
			index,
			args.entryIds,
			args.entryIdByRef ?? undefined,
		);
	const currentTurnId = (() => {
		const ids = buildPiMessageIdByIndex(
			args.messages as PiAgentMessage[],
			args.entryIds ?? null,
		);
		return (
			findLatestUserMessageIdPi(args.messages as PiAgentMessage[], ids)
				?.messageId ?? null
		);
	})();
	const alreadyRanHeuristicsThisTurn =
		currentTurnId !== null &&
		lastHeuristicsTurnIdBySession.get(args.sessionId) === currentTurnId;
	const ctxReduceCallable = !args.sessionMeta.isSubagent;
	const canConsumeDeferredLate =
		args.schedulerDecision === "execute" ||
		args.forceMaterialization === true ||
		args.contextUsage.percentage >= forceMaterializationPercentage;
	const deferredMaterializeEligible =
		canConsumeDeferredLate &&
		deferredMaterializationSessions.has(args.sessionId);
	const piHardSignals = args.injection
		? (() => {
				// map.
				const hardMeta = args.sessionMeta;
				let piTtlMs = 5 * 60 * 1000;
				try {
					piTtlMs = parseCacheTtl(hardMeta.cacheTtl);
				} catch {
				}
				return {
					systemHash:
						typeof hardMeta.systemPromptHash === "string"
							? hardMeta.systemPromptHash
							: "",
					modelKey: liveModelBySession.get(args.sessionId) ?? "",
					cacheExpired: isPiHardCacheExpired(
						hardMeta.lastResponseTime,
						piTtlMs,
						Date.now(),
					),
					lastResponseTime: hardMeta.lastResponseTime,
				};
			})()
		: undefined;
	const piM0State =
		args.injection && piHardSignals
			? {
					sessionId: args.sessionId,
					projectIdentity: args.projectIdentity,
					projectDirectory: args.projectDirectory,
					memoryEnabled: args.injection.memoryEnabled,
					injectDocs: args.injection.injectDocs,
					injectionBudgetTokens: args.injection.injectionBudgetTokens,
					historyBudgetTokens: args.injection.historyBudgetTokens,
					hardSignals: piHardSignals,
					muralEnabled: args.injection.muralEnabled === true,
				}
			: undefined;
	const foldDueDecision = piM0State
		? mustMaterializePi(
				piM0State,
				args.db,
				getCompartments(args.db, args.sessionId),
			)
		: { value: false, reason: null };
	let foldExecutedThisPass = false;
	let preFoldInjectionResult: PiInjectionResult | null = null;
	const persistedM0BeforeFold = getOrCreateSessionMeta(args.db, args.sessionId);
	const m0CoverageBeforeFold =
		persistedM0BeforeFold.cachedM0Bytes === null
			? -1
			: persistedM0BeforeFold.cachedM0MaxCompartmentSeq;
	if (foldDueDecision.value && piM0State) {
		try {
			preFoldInjectionResult = injectM0M1PiForRun(
				piM0State,
				args.db,
				[],
				undefined,
				false,
			);
			foldExecutedThisPass = foldExecutesThisPass(
				foldDueDecision.value,
				preFoldInjectionResult.m0Materialized === true,
			);
			const m0CoverageAfterFold = getOrCreateSessionMeta(
				args.db,
				args.sessionId,
			).cachedM0MaxCompartmentSeq;
			try {
				rearmChannel2AfterCoverageAdvancingHardFold({
					db: args.db,
					sessionId: args.sessionId,
					foldExecuted: foldExecutedThisPass,
					compactionOff: false,
					previousCoverage: m0CoverageBeforeFold,
					currentCoverage: m0CoverageAfterFold,
				});
			} catch (error) {
				sessionLog(
					args.sessionId,
					`pi channel2 fold-cycle reset failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		} catch (error) {
			sessionLog(
				args.sessionId,
				`pi m[0] HARD fold pre-execution failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const mismatch = foldDueDecision.mismatch
			? ` mismatch=${JSON.stringify(foldDueDecision.mismatch)}`
			: "";
		sessionLog(
			args.sessionId,
			`pi m[0] HARD fold decision: reason=${foldDueDecision.reason ?? "unknown"}${mismatch} executed=${foldExecutedThisPass}`,
		);
	}
	const historianRunning = inFlightHistorian.has(args.sessionId);
	const bypassHistorianGate =
		args.forceMaterialization === true || foldExecutedThisPass;
	const hasPendingMaterializeSignal = hasPendingMaterialization(args.sessionId);
	const shouldRunHeuristics =
		args.heuristics !== undefined &&
		(!historianRunning || bypassHistorianGate) &&
		(args.forceMaterialization === true ||
			hasPendingMaterializeSignal ||
			deferredMaterializeEligible ||
			foldExecutedThisPass ||
			(args.schedulerDecision === "execute" && !alreadyRanHeuristicsThisTurn));

	//
	const tFallbackIdentity = performance.now();
	const hasFallbackMessageTags = hasPiFallbackMessageTags(
		args.db,
		args.sessionId,
	);
	const entryFingerprintByMessageId = buildEntryFingerprintMap(
		args.messages as PiAgentMessage[],
		stableIdResolver,
		args.reusableMessageIds,
		hasFallbackMessageTags,
	);
	adoptPiFallbackTags(
		args.db,
		args.sessionId,
		args.tagger,
		entryFingerprintByMessageId,
		{
			messages: args.messages as PiAgentMessage[],
			resolveStableId: stableIdResolver,
			hasFallbackMessageTags,
		},
	);
	logTransformTiming(
		args.sessionId,
		"fallbackIdentityAndAdoption",
		tFallbackIdentity,
	);
	afterFallbackAdoptionForTests?.(args.stableIdSchemeCutover === true);
	const textIdentityPlan = buildPiTextIdentityPlan(
		args.db,
		args.sessionId,
		args.tagger,
		transcript,
		args.reusableMessageIds,
	);
	const tTag = performance.now();
	let tagTextTokenCache = piTagTextTokenCacheBySession.get(args.sessionId);
	if (!tagTextTokenCache) {
		tagTextTokenCache = new Map();
		piTagTextTokenCacheBySession.set(args.sessionId, tagTextTokenCache);
	}
	let tagToolTokenCache = piTagToolTokenCacheBySession.get(args.sessionId);
	if (!tagToolTokenCache) {
		tagToolTokenCache = new Map();
		piTagToolTokenCacheBySession.set(args.sessionId, tagToolTokenCache);
	}
	const { targets } = tagTranscript(
		args.sessionId,
		transcript,
		args.tagger,
		args.db,
		{
			skipPrefixInjection: !ctxReduceCallable,
			entryFingerprintByMessageId,
			reuseMessageIds: textIdentityPlan.reusableMessageIds,
			textIdentityDriftMessageIds: textIdentityPlan.driftedMessageIds,
			textIdentitySourceCache: textIdentityPlan.sourceCache,
			textTokenCache: tagTextTokenCache,
			toolTokenCache: tagToolTokenCache,
			onTiming: hasPiTransformTimingObserver()
				? (phase, elapsedMs) => {
						recordPiTransformTiming({
							sessionId: args.sessionId,
							stage: `tag:${phase}`,
							elapsedMs,
						});
					}
				: undefined,
		},
	);
	logTransformTiming(args.sessionId, "tagMessages", tTag);

	//
	try {
		if (!args.sessionMeta.isSubagent) {
			const hasRecentCommit = detectRecentCommit(args.messages);
			const hadPriorCommitState = commitSeenLastPass.has(args.sessionId);
			const sawCommitLastPass = commitSeenLastPass.get(args.sessionId) ?? false;
			if (hadPriorCommitState && hasRecentCommit && !sawCommitLastPass) {
				onNoteTrigger(args.db, args.sessionId, "commit_detected");
			}
			commitSeenLastPass.set(args.sessionId, hasRecentCommit);
		}
	} catch (err) {
		// Commit detection is best-effort; failures must not interrupt the pipeline.
		// On commit-detection failure, the pipeline logs the error and continues.
		sessionLog(
			args.sessionId,
			`commit-detect failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	// Queued-drop materialization is gated because it mutates tag content and busts the provider cache.
	// Scheduler decisions gate ordinary queued-drop materialization; explicit flushes and forced materialization can also apply pending operations.
	//
	// `pendingMaterializationSessions` removes the session only after `applyPendingOperations` succeeds.
	// If `applyPendingOperations` throws, `pendingMaterializationSessions` retains the session for the next pass.
	//
	// Protected-window drops are re-queued to preserve the agent's recent working context.
	const deferredMaterializationWasPending = deferredMaterializationSessions.has(
		args.sessionId,
	);
	const deferredHistoryRefreshWasPending = deferredHistoryWasPendingAtPassStart;
	// Defer passes replay persisted tag statuses without applying newly queued operations.
	const shouldReadPendingOps =
		!args.compactionOff &&
		(args.schedulerDecision === "execute" ||
			args.forceMaterialization ||
			hasPendingMaterializeSignal ||
			foldExecutedThisPass ||
			historianRunning);
	const pendingOps = shouldReadPendingOps
		? getPendingOps(args.db, args.sessionId)
		: [];
	const pendingOperationTags =
		pendingOps.length > 0
			? getTagsForPendingOperations(
					args.db,
					args.sessionId,
					pendingOps.map((operation) => operation.tagId),
					args.protectedTags,
					RECENT_TOOL_SKELETON_WINDOW,
				)
			: [];
	// `deferredMaterialize` must not gate base pending-operation application.
	// The scheduler drives deferred execution only on a non-mid-turn pass that returns `"execute"`.
	// Deferred materialization is consumed only when the scheduler returns `"execute"` on a non-mid-turn pass.
	const baseShouldApplyPendingOps =
		args.schedulerDecision === "execute" ||
		args.forceMaterialization ||
		hasPendingMaterializeSignal ||
		foldExecutedThisPass;
	// `canConsumeDeferredLate` must remain independent of `shouldRunHeuristics` to prevent mid-turn deferred drains.
	const deferredMaterialize =
		canConsumeDeferredLate && deferredMaterializationWasPending;
	const deferredHistoryRefresh =
		canConsumeDeferredLate && deferredHistoryRefreshWasPending;
	const shouldApplyPendingOps =
		(baseShouldApplyPendingOps || deferredMaterialize) &&
		(!historianRunning || bypassHistorianGate);
	mutationGateObserverForTests?.({
		foldDue: foldDueDecision.value,
		foldExecuted: foldExecutedThisPass,
		shouldApplyPendingOps,
		shouldRunHeuristics,
		shouldRunReasoningCleanup:
			args.reasoningClearing !== undefined && shouldRunHeuristics,
	});
	if (shouldApplyPendingOps) {
		const applyReason = hasPendingMaterializeSignal
			? "explicit_flush"
			: deferredMaterialize
				? "deferred_publication"
				: args.forceMaterialization
					? "force_materialization"
					: foldExecutedThisPass && args.schedulerDecision !== "execute"
						? `m0_hard_fold (drain folded into executed m[0] bust, scheduler=${args.schedulerDecision})`
						: `scheduler_execute (scheduler=${args.schedulerDecision})`;
		sessionLog(
			args.sessionId,
			`pending ops WILL APPLY — reason=${applyReason}, pendingOps=${pendingOps.length}, context=${args.contextUsage.percentage.toFixed(1)}%`,
		);
		try {
			const tApplyPending = performance.now();
			pendingOpsDidMutate = applyPendingOperations(
				args.sessionId,
				args.db,
				targets,
				args.protectedTags,
				pendingOperationTags,
				pendingOps,
			);
			if (pendingOpsDidMutate) {
				droppedCount += pendingOps.length;
			}
			logTransformTiming(
				args.sessionId,
				"applyPendingOperations",
				tApplyPending,
			);
			executedWorkThisPass = true;
			// A successful pending-operation application sets `materializationSatisfiedThisPass` so deferred history can drain without heuristic success.
			materializationSatisfiedThisPass = true;
			pendingOpsAppliedThisPass = true;
			if (hasPendingMaterializeSignal) {
				if (args.heuristics === undefined) {
					consumePendingMaterialization(args.sessionId);
				}
			}
			// `deferredMaterialization` remains pending until heuristics succeeds or is disabled.
			// `deferredMaterializedSuccessfully` is set only after heuristics succeeds or is disabled.
			// If heuristics throws, deferred materialization remains pending for the next pass.
			// If heuristics throws, OpenCode leaves deferred materialization undrained so the next pass retries publication-driven materialization and heuristics.
			// `Pi` consumes deferred materialization only after its separate heuristics try succeeds or heuristics is disabled.
		} catch (err) {
			sessionLog(
				args.sessionId,
				`pending operations failed: ${err instanceof Error ? err.message : String(err)}`,
			);
			throw err;
		}
	} else {
		sessionLog(
			args.sessionId,
			`pending ops WILL NOT APPLY — reason=scheduler_defer pendingOps=${pendingOps.length} context=${args.contextUsage.percentage.toFixed(1)}%`,
		);
	}

	// Status replay reapplies persisted dropped and truncated tag statuses so drops survive across passes.
	// Status replay always runs regardless of scheduler decision so persisted drops survive across passes.
	// at transform.ts:728.
	//
	// Status replay filters SQLite rows by dropped status and visible tag number so active rows are not materialized.
	// SQLite filters by status and visible tag number so status replay does not materialize active rows.
	const targetTagNumbers = [...targets.keys()];
	const tGetTags = performance.now();
	const flushedDroppedTags = getDroppedTagsByNumbers(
		args.db,
		args.sessionId,
		targetTagNumbers,
	);
	logTransformTiming(
		args.sessionId,
		"getDroppedTagsByNumbers",
		tGetTags,
		`targets=${targetTagNumbers.length} fetched=${flushedDroppedTags.length}`,
	);
	const tFlushed = performance.now();
	didMutateFromFlushedStatuses = applyFlushedStatuses(
		args.sessionId,
		args.db,
		targets,
		flushedDroppedTags,
	);
	logTransformTiming(args.sessionId, "applyFlushedStatuses", tFlushed);
	logTransformTiming(args.sessionId, "batchFinalize:flushed", tFlushed);

	// Reasoning replay reapplies `[cleared]` markers and strips inline `<thinking>` from messages below the persisted watermark.
	// Reasoning replay is required on every context event so original thinking content does not reappear.
	// `Pi` replays reasoning so original thinking content does not reappear on defer passes.
	// in transform-postprocess-phase.ts.
	const messageIdToMaxTag = buildMessageIdToMaxTag(targets);
	if (args.reasoningClearing) {
		try {
			const tReplayReasoning = performance.now();
			const clearedReplay = replayClearedReasoningPi({
				db: args.db,
				sessionId: args.sessionId,
				messages: workingMessages,
				messageIdToMaxTag,
				piMessageStableId: stableIdResolver,
			});
			const inlineReplay = replayStrippedInlineThinkingPi({
				db: args.db,
				sessionId: args.sessionId,
				messages: workingMessages,
				messageIdToMaxTag,
				piMessageStableId: stableIdResolver,
			});
			if (clearedReplay > 0 || inlineReplay > 0) {
				sessionLog(
					args.sessionId,
					`reasoning replay: cleared=${clearedReplay} inline=${inlineReplay}`,
				);
			}
			logTransformTiming(
				args.sessionId,
				"replayReasoningClearing",
				tReplayReasoning,
			);
			logTransformTiming(
				args.sessionId,
				"stripClearedReasoning",
				tReplayReasoning,
				`strippedParts=${clearedReplay}`,
			);
		} catch (err) {
			sessionLog(
				args.sessionId,
				`reasoning replay failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	// On execute passes, `applyPiHeuristicCleanup` persists per-tag `caveman_depth`, but compressed text exists only in memory.
	// Caveman compression replays on every context event because compressed text exists only in memory.
	// The next defer pass rebuilds `AgentMessage[]` from JSONL with uncompressed text.
	// Without replay, defer passes after caveman compression bust the provider cache prefix.
	// Without replay, the next defer pass replaces compressed text with the original JSONL text.
	//
	if (args.heuristics?.caveman?.enabled && !args.isSubagent) {
		const tCavemanReplay = performance.now();
		try {
			const tags = getTagsByNumbers(args.db, args.sessionId, targetTagNumbers);
			const replayed = replayCavemanCompression(
				args.sessionId,
				args.db,
				targets,
				tags,
			);
			if (replayed > 0) {
				sessionLog(
					args.sessionId,
					`caveman replay: ${replayed} tags re-compressed from source`,
				);
			}
		} catch (err) {
			sessionLog(
				args.sessionId,
				`caveman replay failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		logTransformTiming(args.sessionId, "cavemanReplay", tCavemanReplay);
	}

	//
	// `stripStructuralNoise` has no Pi-specific parts to remove.
	//
	// Pi does not need `stripReasoningFromMergedAssistants` because its send path does not merge consecutive assistant messages.
	//

	// Heuristic mutations bust the provider cache, so the scheduler gates cleanup.
	// Persisted heuristic mutations let defer passes replay them.
	// transform-postprocess-phase.ts.
	let heuristicsExecuted = false;
	let heuristicsResult: PiHeuristicCleanupResult | null = null;
	const tActiveTags = performance.now();
	// The active-tag reread excludes tags reclaimed in this pass from the emergency-drop floor.
	const activeTags = getActiveTagsBySession(args.db, args.sessionId);
	logTransformTiming(
		args.sessionId,
		"getActiveTagsBySession",
		tActiveTags,
		`count=${activeTags.length}`,
	);
	if (shouldRunHeuristics) {
		const reason = args.forceMaterialization
			? "force_materialization"
			: foldExecutedThisPass && args.schedulerDecision !== "execute"
				? `m0_hard_fold (drain folded into executed m[0] bust, scheduler=${args.schedulerDecision})`
				: `scheduler_execute (pendingOps=${pendingOps.length}, scheduler=${args.schedulerDecision})`;
		sessionLog(
			args.sessionId,
			`heuristics WILL RUN — reason=${reason}, context=${args.contextUsage.percentage.toFixed(1)}%, turn=n/a`,
		);
	} else {
		const reason =
			args.heuristics === undefined ? "disabled" : "scheduler_defer";
		sessionLog(args.sessionId, `heuristics WILL NOT RUN — reason=${reason}`);
	}
	if (shouldRunHeuristics && args.heuristics) {
		try {
			const tHeuristic = performance.now();
			heuristicsResult = applyPiHeuristicCleanup(
				args.sessionId,
				args.db,
				targets,
				args.messages,
				{
					protectedTags: args.protectedTags,
					staleReduceStripEnabled: args.canUseEmptySentinels,
					emergency:
						args.forceMaterialization === true &&
						args.emergencyCeilingTokens !== undefined &&
						args.emergencyCeilingTokens > 0
							? {
									currentTotalInputTokens: args.contextUsage.inputTokens,
									ceilingTokens: args.emergencyCeilingTokens,
								}
							: undefined,
					caveman: args.isSubagent ? undefined : args.heuristics.caveman,
				},
				activeTags,
				stableIdResolver,
			);
			const heuristicMutationCount =
				heuristicsResult.droppedTools +
				heuristicsResult.deduplicatedTools +
				heuristicsResult.droppedInjections +
				heuristicsResult.droppedStaleReduceCalls +
				heuristicsResult.mutatedTextTags;
			droppedCount +=
				heuristicsResult.droppedTools +
				heuristicsResult.deduplicatedTools +
				heuristicsResult.droppedInjections +
				heuristicsResult.droppedStaleReduceCalls +
				heuristicsResult.mutatedTextTags;
			emergency ||= heuristicsResult.emergencyDroppedTools > 0;
			if (heuristicMutationCount > 0) heuristicOrReasoningDidMutate = true;
			heuristicsExecuted = true;
			executedWorkThisPass = true;
			if (hasPendingMaterializeSignal) {
				consumePendingMaterialization(args.sessionId);
			}
			if (currentTurnId !== null) {
				lastHeuristicsTurnIdBySession.set(args.sessionId, currentTurnId);
			}
			logTransformTiming(
				args.sessionId,
				"applyHeuristicCleanup",
				tHeuristic,
				`droppedTools=${heuristicsResult.droppedTools} deduplicatedTools=${heuristicsResult.deduplicatedTools} droppedInjections=${heuristicsResult.droppedInjections} staleReduce=${heuristicsResult.droppedStaleReduceCalls} compressedTextTags=${heuristicsResult.compressedTextTags} mutatedTextTags=${heuristicsResult.mutatedTextTags}`,
			);
		} catch (err) {
			sessionLog(
				args.sessionId,
				`heuristic cleanup failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	// Deferred materialization is consumed only after pending operations and heuristics succeed.
	// A cleanup failure leaves deferred materialization armed for the next pass.
	// `pendingOpsAppliedThisPass` satisfies deferred materialization when `args.heuristics === undefined`.
	if (deferredMaterialize && pendingOpsAppliedThisPass) {
		const fullPassSucceeded = shouldRunHeuristics ? heuristicsExecuted : true;
		if (fullPassSucceeded) {
			deferredMaterializationConsumedThisPass = consumeDeferredMaterialization(
				args.sessionId,
			);
		}
	}

	// The cleanup persists the maximum cleared tag so replay uses the same cleared range.
	// heuristic cleanup.
	// `shouldRunHeuristics` gates reasoning clearing so reasoning cleanup and tool drops share cache-busting passes.
	if (args.reasoningClearing && shouldRunHeuristics) {
		const rollbackReasoning = captureReasoningMutationRollback(workingMessages);
		try {
			const tClearReasoning = performance.now();
			const prevWatermark = args.sessionMeta.clearedReasoningThroughTag ?? 0;
			const clearOutcome = clearOldReasoningPi({
				messages: workingMessages,
				messageIdToMaxTag,
				clearReasoningAge: args.reasoningClearing.clearReasoningAge,
				piMessageStableId: stableIdResolver,
			});
			const stripOutcome = stripInlineThinkingPi({
				messages: workingMessages,
				messageIdToMaxTag,
				clearReasoningAge: args.reasoningClearing.clearReasoningAge,
				piMessageStableId: stableIdResolver,
			});
			const combinedWatermark = Math.max(
				clearOutcome.newWatermark,
				stripOutcome.newWatermark,
			);
			if (combinedWatermark > prevWatermark) {
				persistReasoningWatermarkForRun(args.db, args.sessionId, {
					clearedReasoningThroughTag: combinedWatermark,
				});
				args.sessionMeta.clearedReasoningThroughTag = combinedWatermark;
				sessionLog(
					args.sessionId,
					`reasoning cleanup: cleared=${clearOutcome.cleared} inlineStripped=${stripOutcome.stripped} watermark=${prevWatermark}→${combinedWatermark}`,
				);
			}
			logTransformTiming(args.sessionId, "clearOldReasoning", tClearReasoning);
			logTransformTiming(args.sessionId, "watermarkCleanup", tClearReasoning);
			if (clearOutcome.cleared > 0 || stripOutcome.stripped > 0) {
				heuristicOrReasoningDidMutate = true;
				droppedCount += clearOutcome.cleared + stripOutcome.stripped;
			}
			if (
				combinedWatermark > prevWatermark ||
				clearOutcome.cleared > 0 ||
				stripOutcome.stripped > 0
			) {
				executedWorkThisPass = true;
			}
		} catch (err) {
			// A reasoning-cleanup failure restores reasoning mutations before logging the error.
			// The next cleanup pass retries the watermark write.
			rollbackReasoning();
			sessionLog(
				args.sessionId,
				`reasoning clearing failed; restored original reasoning: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	const toolReclaimExecutePass = args.schedulerDecision === "execute";
	const alreadyMutatingThisPass =
		pendingOpsDidMutate || heuristicOrReasoningDidMutate;
	const emergencyDropEligible =
		args.forceMaterialization === true ||
		args.contextUsage.percentage >= forceMaterializationPercentage;
	let autoReclaimTargetCount = 0;
	let autoReclaimDidMutate = false;
	if (
		toolReclaimExecutePass &&
		alreadyMutatingThisPass &&
		!emergencyDropEligible
	) {
		const reclaimMeta = args.sessionMeta;
		const syntheticPendingOps = buildSyntheticToolReclaimOps({
			db: args.db,
			sessionId: args.sessionId,
			targets,
			watermark: reclaimMeta.toolReclaimWatermark ?? 0,
			pendingOps,
		});
		// Smart-drops run only during the age-based sweep.
		// Multiple rules can select the same tag; deduplication prevents duplicate selection.
		const editMarkerTagIds = new Set<number>();
		if (args.smartDrops) {
			const selectedIds = new Set(syntheticPendingOps.map((op) => op.tagId));
			const supersessionOps = buildSupersessionReclaimOps({
				db: args.db,
				sessionId: args.sessionId,
				targets,
				pendingOps,
			});
			for (const op of supersessionOps) {
				if (!selectedIds.has(op.tagId)) {
					syntheticPendingOps.push(op);
					selectedIds.add(op.tagId);
				}
			}
			const editReclaim = buildEditSupersessionReclaim({
				db: args.db,
				sessionId: args.sessionId,
				targets,
				pendingOps,
			});
			for (const op of editReclaim.ops) {
				// Drop wins over compression: only compress edits no earlier rule selected for a full or skeleton drop.
				if (!selectedIds.has(op.tagId)) {
					syntheticPendingOps.push(op);
					selectedIds.add(op.tagId);
					editMarkerTagIds.add(op.tagId);
				}
			}
		}
		autoReclaimTargetCount = syntheticPendingOps.length;
		if (syntheticPendingOps.length > 0) {
			autoReclaimDidMutate = applyPendingOperations(
				args.sessionId,
				args.db,
				targets,
				args.protectedTags,
				undefined,
				[],
				syntheticPendingOps,
				editMarkerTagIds,
			);
			if (autoReclaimDidMutate) {
				droppedCount += syntheticPendingOps.length;
				autoReclaimDidMutateThisPass = true;
			}
		}
	}

	// Pi stores base64 image data in user and tool-result parts.
	// Anthropic passes replay frozen IDs.
	// `isCacheBusting`, `shouldApplyPendingOps`, or `shouldRunHeuristics` triggers newly aged-ID detection.
	if (args.canUseEmptySentinels) {
		const tProcessedImages = performance.now();
		try {
			const imageResult = stripPiProcessedImages({
				db: args.db,
				sessionId: args.sessionId,
				messages: workingMessages,
				detect:
					args.isCacheBusting || shouldApplyPendingOps || shouldRunHeuristics,
				watermark: getMaxDroppedTagNumber(args.db, args.sessionId),
				messageIdToMaxTag,
				stableId: stableIdResolver,
			});
			if (imageResult.newlyStrippedIds.length > 0) {
				heuristicOrReasoningDidMutate = true;
				executedWorkThisPass = true;
				droppedCount += imageResult.stripped;
			}
		} catch (err) {
			sessionLog(
				args.sessionId,
				`processed-image strip failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		logTransformTiming(
			args.sessionId,
			"stripProcessedImages",
			tProcessedImages,
		);
	}

	// History injection writes to tagged content only after `transcript.commit()`.
	// Pi's transcript adapter propagates part-proxy mutations to the underlying AgentMessage[] objects.
	const tTranscriptCommit = performance.now();
	transcript.commit();
	logTransformTiming(args.sessionId, "transcriptCommit", tTranscriptCommit);
	if (toolReclaimExecutePass) {
		advanceToolReclaimWatermarkToCurrentMax(args.db, args.sessionId);
	}
	if (autoReclaimTargetCount > 0) {
		sessionLog(
			args.sessionId,
			`tool reclaim auto-drop: targets=${autoReclaimTargetCount} mutated=${autoReclaimDidMutate}`,
		);
	}

	// `commit()` replaces dirty message objects with clones, so map construction follows it.
	// `injectM0M1Pi` splices the message array after map construction.
	// Injection splices the message array, so positional entryIds[index] becomes stale.
	// `commit()` replaces dirty message objects with clones, so the ref-keyed map uses cloned-message identities that remain valid after injection splices the array.
	//
	// Use separate maps because placeholder stripping accepts fallback IDs, while reminders and auto-search require SessionEntry IDs.
	// Use postCommitStableIdByRef for stripPiDroppedPlaceholderMessages because it resolves fallback pi-msg-* IDs.
	// Use postCommitEntryIdByRef only for real SessionEntry IDs; do not fall back to pi-msg-* IDs.
	// Sticky reminders, note nudges, and auto-search use entryIds === null when branch resolution fails.
	// Do not use a pi-msg-* fallback ID after branch resolution fails; it would anchor these features to an unstable ID.
	const tPostCommitStableIdMaps = performance.now();
	const postCommitStableIdByRef = new Map<object, string>();
	const postCommitEntryIdByRef = new Map<object, string>();
	for (let i = 0; i < args.messages.length; i++) {
		const m = args.messages[i];
		if (!m || typeof m !== "object") continue;
		const id = resolvePiStableId(
			m,
			i,
			args.entryIds,
			args.entryIdByRef ?? undefined,
		);
		if (id) postCommitStableIdByRef.set(m as object, id);
		// Each positional `entryIds[i]` is a real `SessionEntry` ID or `undefined`.
		const realId = args.entryIds?.[i];
		if (typeof realId === "string" && realId.length > 0) {
			postCommitEntryIdByRef.set(m as object, realId);
		}
	}
	logTransformTiming(
		args.sessionId,
		"postCommitStableIdMaps",
		tPostCommitStableIdMaps,
	);

	let injectionResult: PiInjectionResult | null = null;
	if (args.injection) {
		if (!piM0State)
			throw new Error("memory injection requires hard-signal state");
		try {
			const tInjection = performance.now();
			// New compartments are soft m[1] deltas, so cache-busting passes retain cached m[0] unless mustMaterializePi detects a hard trigger.
			const wireInjectionResult = injectM0M1PiForRun(
				piM0State,
				args.db,
				args.messages as Parameters<typeof injectM0M1Pi>[2],
				args.entryIds,
				// Recompute m[1] after cache-busting, deferred-history-refresh, or executed-work passes so newly published compartments are rendered.
				args.isCacheBusting || deferredHistoryRefresh || executedWorkThisPass,
			);
			injectionResult = preFoldInjectionResult?.m0Materialized
				? {
						...wireInjectionResult,
						m0Materialized: true,
						m0Reason:
							preFoldInjectionResult.m0Reason ?? wireInjectionResult.m0Reason,
					}
				: wireInjectionResult;
			// Temporal markers are derived before history injection trims raw messages.
			// After trimming, remove a leading user's temporal marker if an omitted predecessor determined it; this matches the next pass.
			if (
				args.temporalAwareness &&
				injectionResult.skippedVisibleMessages > 0
			) {
				const firstRetainedMessage =
					args.messages[injectionResult.syntheticLeadingCount];
				stripPiLeadingTemporalMarker(firstRetainedMessage);
			}
			// Delete `historyRefreshSessions` only after cache-busting injection succeeds.
			if (args.isCacheBusting) {
				historyRefreshSessions.delete(args.sessionId);
				historyWasConsumedThisPass = true;
			}
			if (deferredHistoryRefresh) {
				historyWasConsumedThisPass = true;
			}
			logTransformTiming(
				args.sessionId,
				"prepareCompartmentInjection",
				tInjection,
			);
			logTransformTiming(args.sessionId, "compartmentPhase", tInjection);
		} catch (err) {
			sessionLog(
				args.sessionId,
				`compartment injection failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	const tDroppedPlaceholders = performance.now();
	stripPiDroppedPlaceholderMessages({
		db: args.db,
		sessionId: args.sessionId,
		messages: args.messages,
		// Pi splices the message during the fresh-drop execute pass.
		isCacheBusting: args.isCacheBusting,
		stableIdByRef: postCommitStableIdByRef,
		forceDiscovery: args.stableIdSchemeCutover === true,
	});
	logTransformTiming(
		args.sessionId,
		"stripDroppedPlaceholders",
		tDroppedPlaceholders,
	);

	// !suppress`:
	const deferredHistoryDrainEligible =
		historyWasConsumedThisPass &&
		materializationSatisfiedThisPass &&
		(deferredHistoryWasPendingAtPassStart || hasPendingMaterializeSignal) &&
		!suppressDeferredHistoryDrain &&
		!casLost;
	let preserveDeferredMaterializationForMarkerDrain = false;
	if (deferredHistoryDrainEligible) {
		try {
			const pending = getPendingPiCompactionMarkerState(
				args.db,
				args.sessionId,
			);
			if (!pending) {
				if (injectionResult?.contentionExhausted === true) {
					suppressDeferredHistoryDrain = true;
					preserveDeferredMaterializationForMarkerDrain = true;
					sessionLog(
						args.sessionId,
						"Pi deferred-history drain skipped: m[0]/m[1] used a contention fallback; preserving deferred signals",
					);
				} else {
					consumeDeferredHistoryRefresh(args.sessionId);
				}
			} else if (
				!pendingPiMarkerCoveredByRenderedBoundary(pending, injectionResult)
			) {
				suppressDeferredHistoryDrain = true;
				preserveDeferredMaterializationForMarkerDrain = true;
				const boundary = injectionResult?.renderedBoundary;
				const m1Coverage = injectionResult?.m1RenderedCoverage;
				sessionLog(
					args.sessionId,
					`Pi compaction-marker drain skipped: pending ordinal ${pending.ordinal} is newer than rendered boundary ${boundary?.ordinal ?? "<none>"} endMessageId=${boundary?.endMessageId ?? "<none>"} (m[1] coverage ${m1Coverage?.ordinal ?? "<none>"} endMessageId=${m1Coverage?.endMessageId ?? "<none>"}); preserving deferred signals`,
				);
			} else if (!args.appendCompaction || !args.readBranchEntries) {
				suppressDeferredHistoryDrain = true;
				sessionLog(
					args.sessionId,
					"Pi compaction-marker drain skipped: sessionManager appendCompaction/getBranch unavailable; preserving deferred-history signal",
				);
			} else {
				const outcome = applyDeferredPiCompactionMarker(
					{
						db: args.db,
						appendCompaction: args.appendCompaction,
						readBranchEntries: args.readBranchEntries,
					},
					args.sessionId,
					pending,
				);
				if (outcome.kind === "retryable-failure") {
					sessionLog(
						args.sessionId,
						`Pi compaction-marker drain retryable failure: ${outcome.error.message}`,
					);
				} else if (
					clearPendingPiCompactionMarkerStateIf(
						args.db,
						args.sessionId,
						pending,
					)
				) {
					consumeDeferredHistoryRefresh(args.sessionId);
				} else {
					casLost = true;
					sessionLog(
						args.sessionId,
						"CAS-clear failed (newer blob written or another actor cleared); preserving deferred-history signal",
					);
				}
			}
		} catch (err) {
			sessionLog(
				args.sessionId,
				`Pi compaction-marker drain failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
	if (
		preserveDeferredMaterializationForMarkerDrain &&
		deferredMaterializationConsumedThisPass
	) {
		signalPiDeferredMaterialization(args.sessionId);
	}

	if (executedWorkThisPass) {
		try {
			const currentFlag = peekDeferredExecutePending(args.db, args.sessionId);
			if (currentFlag !== null) {
				clearDeferredExecutePendingIfMatches(
					args.db,
					args.sessionId,
					currentFlag,
				);
			}
		} catch (err) {
			sessionLog(
				args.sessionId,
				`[boundary-exec] drain failed (continuing): ${err}`,
			);
		}
	}
	logTransformTiming(
		args.sessionId,
		"batchFinalize:heuristics",
		performance.now(),
	);

	const outputMessages = transcript.getOutputMessages();

	// 7. Persist conversation/tool-call token totals for /ctx-status.
	// Walks the post-everything message array (tagged,
	// injected, stripped) so the numbers reflect what the LLM actually
	// receives. Mirrors OpenCode's transform.ts token accounting. Best-effort —
	// never fail the pipeline on a stats write error.
	try {
		const tTokenAccounting = performance.now();
		let tokenCache = piMessageTokenCacheBySession.get(args.sessionId);
		if (!tokenCache) {
			tokenCache = new Map();
			piMessageTokenCacheBySession.set(args.sessionId, tokenCache);
		}
		const counts = tokenizePiMessages(outputMessages as unknown[], {
			cache: tokenCache,
			stableId: (message) => postCommitEntryIdByRef.get(message),
			onTiming: hasPiTransformTimingObserver()
				? (phase, elapsedMs) => {
						recordPiTransformTiming({
							sessionId: args.sessionId,
							stage: `token:${phase}`,
							elapsedMs,
						});
					}
				: undefined,
		});
		updateSessionMeta(args.db, args.sessionId, {
			conversationTokens: counts.conversation,
			toolCallTokens: counts.toolCall,
		});
		logTransformTiming(args.sessionId, "tokenAccounting", tTokenAccounting);
	} catch (err) {
		sessionLog(
			args.sessionId,
			`token accounting failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	const materialized = injectionResult?.m0Materialized === true;
	const materializeReason = injectionResult?.m0Reason ?? null;
	const bustedThisPass =
		didMutateFromFlushedStatuses ||
		pendingOpsDidMutate ||
		heuristicOrReasoningDidMutate ||
		autoReclaimDidMutateThisPass ||
		materialized ||
		historyWasConsumedThisPass;

	return {
		messages: outputMessages,
		heuristicsExecuted,
		executedWorkThisPass,
		historyInjected: injectionResult?.injected ?? false,
		syntheticLeadingCount: injectionResult?.syntheticLeadingCount ?? 0,
		heuristicsResult,
		injectionResult,
		materialized,
		materializeReason,
		droppedTokens,
		droppedCount,
		emergency,
		bustedThisPass,
		targetCount: targets.size,
		reasoningWatermark: args.sessionMeta.clearedReasoningThroughTag ?? 0,
		activeTags,
		postCommitEntryIdByRef,
	};
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

/**
 *
 */
/**
 * Apply note-nudge replay + delivery. Mirrors OpenCode's
 * `transform-postprocess-phase.ts` note-nudge pass.
 *
 * Two paths:
 *
 */
function applyNoteNudges(args: {
	sessionId: string;
	db: ContextDatabase;
	messages: PiAgentMessage[];
	projectIdentity: string;
	entryIds: readonly (string | undefined)[] | null;
	/**
	 */
	entryIdByRef?: ReadonlyMap<object, string> | null;
	/**
	 */
	isCacheBusting: boolean;
	/**
	 */
	syntheticLeadingCount?: number;
}): PiAgentMessage[] {
	const { sessionId, db, messages, projectIdentity, entryIds, entryIdByRef } =
		args;

	const tNoteIndexMaps = performance.now();
	const messageIdByIndex = buildPiMessageIdByIndex(
		messages,
		entryIds,
		false,
		entryIdByRef,
	);
	const replayMessageIdByIndex = buildPiMessageIdByIndex(
		messages,
		entryIds,
		true,
		entryIdByRef,
	);
	logTransformTiming(sessionId, "noteIndexMaps", tNoteIndexMaps);

	const tStickyReplay = performance.now();
	for (const anchor of getNoteNudgeAnchors(db, sessionId)) {
		appendReminderToUserMessageByIdPi(
			messages,
			replayMessageIdByIndex,
			anchor.messageId,
			anchor.text,
		);
	}
	for (const decision of getAutoSearchHintDecisions(db, sessionId)) {
		if (decision.decision === "hint") {
			if (!autoSearchHintFragmentsStillEligible(db, decision.memoryFragments)) {
				continue;
			}
			appendReminderToUserMessageByIdPi(
				messages,
				replayMessageIdByIndex,
				decision.messageId,
				decision.text,
			);
		}
	}
	logTransformTiming(sessionId, "stickyReplayDecisions", tStickyReplay);

	//
	const latestUser = findLatestUserMessageIdPi(messages, messageIdByIndex);
	const latestUserId = latestUser?.messageId ?? null;
	const noteReadStillVisible = hasVisibleNoteReadCallPi(messages);
	const deferredNoteText = peekNoteNudgeText(
		db,
		sessionId,
		latestUserId,
		projectIdentity,
		noteReadStillVisible,
	);
	if (deferredNoteText) {
		if (entryIds === null) {
			sessionLog(
				sessionId,
				"Pi note-nudge: strict resolution failed; deferring delivery to next pass",
			);
			return messages;
		}
		const noteInstruction = `\n\n<instruction name="deferred_notes">${deferredNoteText}</instruction>`;
		const anchoredId = latestUser?.messageId ?? null;
		if (!anchoredId) {
			sessionLog(
				sessionId,
				"Pi note-nudge: latest user message has no resolved SessionEntry id; deferring delivery to next pass",
			);
			return messages;
		}
		const outcome = markNoteNudgeDelivered(
			db,
			sessionId,
			noteInstruction,
			anchoredId,
		);
		if (latestUser && outcome.ok) {
			appendReminderToPiUserMessage(
				messages[latestUser.index] as PiAgentMessage,
				noteInstruction,
			);
		} else if (!outcome.ok) {
			sessionLog(
				sessionId,
				`Pi note-nudge delivery skipped wire append: ${outcome.kind}`,
			);
		}
	}

	//
	// Derive the visible set from messageIdByIndex, which resolves references in the current messages array.
	// Prune only when messageIdByIndex resolves every real message.
	// A partial messageIdByIndex map can omit a present message and wrongly prune its anchor.
	if (args.isCacheBusting) {
		const visibleIds = new Set<string>(messageIdByIndex.values());
		// Exclude synthetic leading messages from realMessageCount because they never resolve to entry IDs.
		// Including synthetic messages in realMessageCount makes allResolved false on every injected pass.
		const realMessageCount = Math.max(
			0,
			messages.length - (args.syntheticLeadingCount ?? 0),
		);
		const allResolved = messageIdByIndex.size === realMessageCount;
		if (allResolved && visibleIds.size > 0) {
			pruneNoteNudgeAnchors(db, sessionId, visibleIds);
			pruneAutoSearchHintDecisions(db, sessionId, visibleIds);
		}
	}

	return messages;
}

/* */
function hasMeaningfulUserTextPi(message: PiAgentMessage): boolean {
	if (message.role !== "user") return false;
	const content = (message as { content: unknown }).content;
	if (typeof content === "string") return content.trim().length > 0;
	if (!Array.isArray(content)) return false;
	for (const part of content as Array<{ type?: unknown; text?: unknown }>) {
		if (
			part &&
			part.type === "text" &&
			typeof part.text === "string" &&
			part.text.trim().length > 0
		) {
			return true;
		}
	}
	return false;
}

type PiMessageIdByIndex = Map<number, string>;

/**
 * Rebuild the index→entryId map after message mutations because strictEntryIds indexes the original event.messages array.
 *
 *
 * Compartment-boundary trimming and stripPiDroppedPlaceholderMessages splice messages in place, shifting later indexes.
 * Consumers that run after splices must not index strictEntryIds against the mutated messages array.
 * After a splice, strictEntryIds[index] can identify a different SessionEntry than messages[index], causing replay and pruning to target the wrong message.
 *
 * Splicing preserves message object identity.
 * The reference map remains valid after splices.
 */
function buildPiMessageIdByIndex(
	messages: PiAgentMessage[],
	entryIds: readonly (string | undefined)[] | null,
	includeMessageIdFallback = false,
	entryIdByRef?: ReadonlyMap<object, string> | null,
): PiMessageIdByIndex {
	const ids = new Map<number, string>();
	for (let index = 0; index < messages.length; index += 1) {
		// Prefer `entryIdByRef` after splices because `strictEntryIds` retains pass-start indices.
		if (entryIdByRef) {
			const msg = messages[index];
			const byRef =
				msg && typeof msg === "object"
					? entryIdByRef.get(msg as object)
					: undefined;
			if (typeof byRef === "string") {
				ids.set(index, byRef);
				continue;
			}
			// With `entryIdByRef`, do not fall back to `entryIds[index]`: splices can misalign positional IDs.
			// `messages[index].id` is splice-safe because it belongs to the current message object.
			// callers (includeMessageIdFallback=true).
			if (includeMessageIdFallback) {
				const messageId = (messages[index] as { id?: unknown } | undefined)?.id;
				if (typeof messageId === "string") {
					ids.set(index, messageId);
				}
			}
			continue;
		}
		// Without `entryIdByRef`, positional `entryIds` is authoritative only while `messages` retains its original order.
		const entryId = entryIds?.[index];
		if (typeof entryId === "string") {
			ids.set(index, entryId);
			continue;
		}
		if (includeMessageIdFallback) {
			const messageId = (messages[index] as { id?: unknown } | undefined)?.id;
			if (typeof messageId === "string") {
				ids.set(index, messageId);
			}
		}
		// Fresh anchors must not use `AgentMessage.id` because it is not a `SessionEntry` ID.
	}
	return ids;
}

function findLatestUserMessageIdPi(
	messages: PiAgentMessage[],
	messageIdByIndex: PiMessageIdByIndex,
): { index: number; messageId: string } | null {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const msg = messages[i];
		if (msg?.role !== "user" || !hasMeaningfulUserTextPi(msg)) continue;
		const messageId = messageIdByIndex.get(i);
		if (typeof messageId === "string") {
			return { index: i, messageId };
		}
	}
	return null;
}

/**
 * Do not append `reminder` when the user content already includes it.
 * `transform-message-helpers.ts:54`.
 */
function appendReminderToUserMessageByIdPi(
	messages: PiAgentMessage[],
	messageIdByIndex: PiMessageIdByIndex,
	messageId: string,
	reminder: string,
): boolean {
	for (let i = 0; i < messages.length; i += 1) {
		const msg = messages[i];
		if (msg?.role !== "user" || !hasMeaningfulUserTextPi(msg)) continue;
		if (messageIdByIndex.get(i) !== messageId) continue;
		appendReminderToPiUserMessage(msg, reminder);
		return true;
	}
	return false;
}

/**
 *
 * The function appends only when the string content or first text block does not include `reminder`.
 */
function appendReminderToPiUserMessage(
	message: PiAgentMessage,
	reminder: string,
): void {
	if (message.role !== "user") return;
	const userMsg = message as { content: unknown };

	if (typeof userMsg.content === "string") {
		if (!userMsg.content.includes(reminder)) {
			userMsg.content = userMsg.content + reminder;
		}
		return;
	}
	if (!Array.isArray(userMsg.content)) return;

	const contentArr = userMsg.content as Array<{
		type?: unknown;
		text?: unknown;
	}>;
	for (let i = 0; i < contentArr.length; i += 1) {
		const part = contentArr[i];
		if (
			part &&
			part.type === "text" &&
			typeof (part as { text?: string }).text === "string"
		) {
			const text = (part as { text: string }).text;
			if (!text.includes(reminder)) {
				(part as { text: string }).text = text + reminder;
			}
			return;
		}
	}
	// The function trims leading whitespace because no text block precedes the new block.
	contentArr.push({ type: "text", text: reminder.trimStart() });
}

function clearPiCompactionOffInMemoryState(sessionId: string): void {
	historyRefreshSessions.delete(sessionId);
	deferredHistoryRefreshSessions.delete(sessionId);
	pendingMaterializationSessions.delete(sessionId);
	deferredMaterializationSessions.delete(sessionId);
	clearPiChannel1State(sessionId);
}

/**
 *
 * module owns:
 *     systemPromptRefresh)
 *
 * Not cleaned:
 */
export function clearContextHandlerSession(sessionId: string): void {
	invalidateTrueRawTokenCache({ sessionId, reason: "pi.branch.changed" });
	activeContextHandlerSessions.delete(sessionId);
	clearAutoSearchForPiSession(sessionId);
	lastEmergencyNotificationAtMs.delete(sessionId);
	historyRefreshSessions.delete(sessionId);
	pendingMaterializationSessions.delete(sessionId);
	systemPromptRefreshSessions.delete(sessionId);
	deferredHistoryRefreshSessions.delete(sessionId);
	deferredMaterializationSessions.delete(sessionId);
	firstContextPassSeenBySession.delete(sessionId);
	commitSeenLastPass.delete(sessionId);
	liveModelBySession.delete(sessionId);
	taggedStableMessageIdsBySession.delete(sessionId);
	const tagger = taggersBySession.get(sessionId);
	if (tagger) {
		tagger.cleanup(sessionId);
		taggersBySession.delete(sessionId);
	}
	piMessageTokenCacheBySession.delete(sessionId);
	piTagTextTokenCacheBySession.delete(sessionId);
	piTagToolTokenCacheBySession.delete(sessionId);
	piTextIdentitySourceCacheBySession.delete(sessionId);
	piBranchProjectionBySession.delete(sessionId);
	clearPiInjectionTokenCountCache(sessionId);
	clearPiChannel1State(sessionId);
	lastHeuristicsTurnIdBySession.delete(sessionId);
	lastSeenProjectIdentityBySession.delete(sessionId);
	for (const [projectIdentity, sessions] of sessionsByProject) {
		sessions.delete(sessionId);
		if (sessions.size === 0) sessionsByProject.delete(projectIdentity);
	}
	const unregister = rawMessageProviderUnregistersBySession.get(sessionId);
	if (unregister) {
		unregister();
		rawMessageProviderUnregistersBySession.delete(sessionId);
	}
	clearSessionTracking(sessionId);
	clearPiEmbedSessionState(sessionId);
}
