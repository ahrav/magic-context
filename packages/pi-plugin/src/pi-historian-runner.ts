/**
 *
 * The Pi historian runner invokes `PiSubagentRunner` instead of `client.session.create`.
 *
 * The eligible chunk begins after the last compartment and excludes the protected tail.
 * The runner retries validation failures once with a repair pass.
 * The runner appends compartments and replaces facts atomically.
 * The runner promotes facts only when `memory.enabled` and `auto_promote` are enabled.
 *
 * Pi relies on native compaction instead of OpenCode-style compaction markers.
 * `PiSubagentRunner` enforces each run's timeout; this runner does not accept an `AbortSignal`.
 *
 * On validation, parse, or spawn failure, the runner leaves stored compartments unchanged and increments the historian failure counter.
 *
 * Pi logs use `sessionLog` so OpenCode log-tailers receive `[magic-context][ses_xxx]` entries.
 */

import * as crypto from "node:crypto";
import { withContentLanguageDirective } from "@magic-context/core/agents/language-directive";
import { embedAndStoreCompartmentChunks } from "@magic-context/core/features/magic-context/compartment-embedding";
import { insertCompartmentEvents } from "@magic-context/core/features/magic-context/compartment-events";
import { isCompartmentLeaseHeld } from "@magic-context/core/features/magic-context/compartment-lease";
import {
	appendCompartments,
	getCompartments,
} from "@magic-context/core/features/magic-context/compartment-storage";
import { promoteSessionFactsDurable } from "@magic-context/core/features/magic-context/memory";
import {
	readAuthorizedClaimMemorySnapshot,
	renderClaimMemoryBlock,
} from "@magic-context/core/features/magic-context/memory/claim-memory-render";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import {
	clearEmergencyDrainLatch,
	clearEmergencyRecovery,
	clearHistorianDrainFailure,
	clearHistorianFailureState,
	getOverflowState,
	incrementHistorianFailure,
	isWrapupInProgress,
	recordHistorianDrainFailure,
	recordProtectedTailPublicationFloor,
	reserveProtectedTailDrainTokens,
	rollbackProtectedTailDrainReservation,
	setPendingPiCompactionMarkerState,
} from "@magic-context/core/features/magic-context/storage";
import {
	type HistorianRunInput,
	recordHistorianRun,
	summarizeImportance,
	tallyFactsByCategory,
} from "@magic-context/core/features/magic-context/storage-historian-runs";
import { updateSessionMeta } from "@magic-context/core/features/magic-context/storage-meta";
import { insertPrimerCandidates } from "@magic-context/core/features/magic-context/storage-primers";
import { getLatestHistorianInvocationId } from "@magic-context/core/features/magic-context/storage-subagent-invocations";
import { insertUserMemoryCandidates } from "@magic-context/core/features/magic-context/user-memory/storage-user-memory";
import {
	buildCompartmentAgentPrompt,
	buildHistorianEditorPrompt,
	COMPARTMENT_AGENT_SYSTEM_PROMPT,
	HISTORIAN_EDITOR_SYSTEM_PROMPT,
} from "@magic-context/core/hooks/magic-context/compartment-prompt";
import { queueDropsForCompartmentalizedMessages } from "@magic-context/core/hooks/magic-context/compartment-runner-drop-queue";
import {
	buildHistorianFailureNotice,
	buildHistorianRepairPrompt,
	HISTORIAN_BOUNDARY_HEALING_SLACK,
	shouldDiscardLastHistorianCompartment,
	validateChunkCoverage,
	validateHistorianOutput,
	validateStoredCompartments,
} from "@magic-context/core/hooks/magic-context/compartment-runner-validation";
import { onNoteTrigger } from "@magic-context/core/hooks/magic-context/note-nudger";
import {
	createDefaultBoundarySnapshotForTests,
	hasRunnableCompartmentWindow,
	type ProtectedTailBoundarySnapshot,
	recordHighPressureNoEligibleHead,
	selectPerRunCap,
	validateBoundarySnapshot,
} from "@magic-context/core/hooks/magic-context/protected-tail-boundary";
import {
	type RawMessageProvider,
	readSessionChunk,
	withRawMessageProvider,
} from "@magic-context/core/hooks/magic-context/read-session-chunk";
import { estimateTokens } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import { buildReferenceBlocks } from "@magic-context/core/hooks/magic-context/reference-retrieval";
import { describeError } from "@magic-context/core/shared/error-message";
import { sessionLog } from "@magic-context/core/shared/logger";
import type { Database } from "@magic-context/core/shared/sqlite";
import type {
	SubagentProgressEvent,
	SubagentRunner,
	SubagentRunOptions,
	SubagentRunResult,
} from "@magic-context/core/shared/subagent-runner";

import { ensureProjectRegisteredFromPiDirectory } from "./embedding-bootstrap";
import {
	convertEntriesToRawMessages,
	SYNTH_USER_ID_PREFIX,
} from "./read-session-pi";

const HISTORIAN_AGENT_NAME = "magic-context-historian";
const DEFAULT_HISTORIAN_TIMEOUT_MS = 120_000;
const MAX_HISTORIAN_RETRIES = 2;

/** The runner emits at most one historian alert per session per minute. */
const HISTORIAN_ALERT_COOLDOWN_MS = 60 * 1000;
const lastHistorianAlertBySession = new Map<string, number>();

function getHistorianRetryBackoffMs(retryIndex: number): number {
	if (retryIndex === 0) {
		return 2_000 + Math.floor(Math.random() * 1_001);
	}

	return 6_000 + Math.floor(Math.random() * 2_001);
}

function isTransientHistorianPromptError(message: string): boolean {
	const normalized = message.toLowerCase();
	if (
		normalized.includes("invalid request") ||
		normalized.includes("bad request") ||
		normalized.includes("unauthorized") ||
		normalized.includes("forbidden") ||
		normalized.includes("authentication") ||
		normalized.includes("auth") ||
		normalized.includes(" 400") ||
		normalized.startsWith("400")
	) {
		return false;
	}

	return [
		"429",
		"rate limit",
		"timeout",
		"econnreset",
		"etimedout",
		"503",
		"502",
		"500",
		"overloaded",
	].some((token) => normalized.includes(token));
}

function isTransientHistorianRunFailure(
	result: Extract<SubagentRunResult, { ok: false }>,
): boolean {
	if (result.reason === "abort") return false;
	if (result.reason === "timeout") return true;
	return isTransientHistorianPromptError(result.error);
}

function historianAbortResult(startedAt: number): SubagentRunResult {
	return {
		ok: false,
		reason: "abort",
		error: "pi subagent aborted by caller",
		durationMs: Date.now() - startedAt,
	};
}

async function sleepWithAbort(
	ms: number,
	signal?: AbortSignal,
): Promise<boolean> {
	if (signal?.aborted) return true;
	if (ms <= 0) return signal?.aborted === true;

	return new Promise<boolean>((resolve) => {
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const finish = (aborted: boolean) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			resolve(aborted);
		};
		const onAbort = () => finish(true);
		signal?.addEventListener("abort", onAbort, { once: true });
		timeout = setTimeout(() => finish(false), ms);
	});
}

async function runHistorianSubagentWithTransientRetries(args: {
	runner: SubagentRunner;
	options: SubagentRunOptions;
	sessionId: string;
	passLabel: string;
	retryBackoffMs?: (retryIndex: number) => number;
}): Promise<SubagentRunResult> {
	const startedAt = Date.now();
	if (args.options.signal?.aborted) return historianAbortResult(startedAt);

	for (
		let retryIndex = 0;
		retryIndex <= MAX_HISTORIAN_RETRIES;
		retryIndex += 1
	) {
		const attemptStart = Date.now();
		let result: SubagentRunResult;
		try {
			result = await args.runner.run({
				...args.options,
				// The historian runner must parse and validate each candidate before stopping.
				fallbackModels: undefined,
			});
		} catch (error) {
			const desc = describeError(error);
			result = {
				ok: false,
				reason: "model_failed",
				error: desc.brief,
				durationMs: Date.now() - attemptStart,
			};
		}

		if (result.ok) return result;
		if (result.reason === "abort" || args.options.signal?.aborted) {
			return result.reason === "abort"
				? result
				: historianAbortResult(startedAt);
		}

		const shouldRetry =
			retryIndex < MAX_HISTORIAN_RETRIES &&
			isTransientHistorianRunFailure(result);
		if (!shouldRetry) return result;

		const backoffMs =
			args.retryBackoffMs?.(retryIndex) ??
			getHistorianRetryBackoffMs(retryIndex);
		sessionLog(
			args.sessionId,
			`historian[${args.passLabel}] transient failure; retry ${retryIndex + 1}/${MAX_HISTORIAN_RETRIES} on same model after ${backoffMs}ms: ${result.error}`,
		);
		const aborted = await sleepWithAbort(backoffMs, args.options.signal);
		if (aborted) return historianAbortResult(startedAt);
	}

	return historianAbortResult(startedAt);
}

function buildHistorianFallbackChain(
	primaryModel: string,
	fallbackModels?: readonly string[],
	fallbackModelId?: string,
): Array<{ modelId: string; kind: "configured" | "session" }> {
	const seen = new Set<string>();
	if (primaryModel) seen.add(primaryModel);
	const chain: Array<{ modelId: string; kind: "configured" | "session" }> = [];
	for (const candidate of fallbackModels ?? []) {
		if (!candidate || seen.has(candidate)) continue;
		seen.add(candidate);
		chain.push({ modelId: candidate, kind: "configured" });
	}
	if (fallbackModelId && !seen.has(fallbackModelId)) {
		chain.push({ modelId: fallbackModelId, kind: "session" });
	}
	return chain;
}

function parseSourceMessageTime(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const numeric = Number(value);
		if (Number.isFinite(numeric) && numeric > 0) return numeric;
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

function truncateHistorianInputIfNeeded(text: string, budget: number): string {
	if (estimateTokens(text) <= budget) return text;
	let lo = 0;
	let hi = text.length;
	let best = 0;
	const marker =
		"\n[… tokens truncated by Magic Context to fit the historian window …]";
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (estimateTokens(text.slice(0, mid) + marker) <= budget) {
			best = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return text.slice(0, best) + marker;
}

function shouldSuppressHistorianAlert(sessionId: string): boolean {
	const last = lastHistorianAlertBySession.get(sessionId);
	if (last && Date.now() - last < HISTORIAN_ALERT_COOLDOWN_MS) return true;
	lastHistorianAlertBySession.set(sessionId, Date.now());
	return false;
}

/** `clearPiHistorianAlertState` removes the session's module-scope alert state when the session is deleted. */
export function clearPiHistorianAlertState(sessionId: string): void {
	lastHistorianAlertBySession.delete(sessionId);
}

export interface PiHistorianDeps {
	/** `db` accesses the shared cortexkit SQLite database. */
	db: Database;
	/* */
	sessionId: string;
	/** `directory` scopes memory to the project identity. */
	directory: string;
	/** `provider` resolves `readRawSessionMessages(sessionId)` to Pi data. */
	provider: RawMessageProvider;
	/* */
	runner: SubagentRunner;
	/** `historianModel` supplies the provider/model ID required by `PiSubagentRunner`. */
	historianModel: string;
	/** The fallback chain tries configured models in order. */
	fallbackModels?: readonly string[];
	/** The live session model runs after all configured fallbacks. */
	fallbackModelId?: string;
	/** The historian context window determines the chunk token budget. */
	historianChunkTokens: number;
	/** The Pi trigger/recovery decision resolves the boundary using the active model's context limit. */
	boundarySnapshot?: ProtectedTailBoundarySnapshot;
	/**
	 * The live boundary resolver recovers a stale trigger snapshot.
	 * The live boundary resolver must recompute against the registered Pi raw-message provider.
	 */
	refreshBoundarySnapshot?: () => ProtectedTailBoundarySnapshot;
	/** The resolved context limit rejects snapshots made before a model switch. */
	currentContextLimit?: number;
	/* */
	historianTimeoutMs?: number;
	/* */
	signal?: AbortSignal;
	/** The retry backoff defaults to OpenCode's retry cadence. */
	retryBackoffMs?: (retryIndex: number) => number;
	/**
	 * The second editor pass removes low-signal `U:` lines and cross-compartment duplicates.
	 * The `twoPass` option corresponds to OpenCode's `historian.two_pass` config.
	 * */
	twoPass?: boolean;
	/** Pi passes the explicit thinking level as `--thinking <level>` to historian subagent invocations.
	 * When `thinkingLevel` is unset, Pi resolves the thinking level.
	 * Pi cannot resolve the default thinking level for `github-copilot/gpt-5.4`. */
	thinkingLevel?: string;
	/** `memory.enabled` enables cross-session memory. */
	memoryEnabled?: boolean;
	/** allowHomeProject permits sessions started exactly in the canonical home directory only when user-level configuration enables it. */
	allowHomeProject?: boolean;
	/* */
	autoPromote?: boolean;
	/**
	 * `dreamer.user_memories.enabled` controls whether historian-extracted user observations are persisted as candidates. */
	userMemoriesEnabled?: boolean;
	language?: string;
	/** Successful publication invokes the callback to signal cache invalidation. */
	onPublished?: () => void;
	/** compartmentLeaseHolderId identifies the DB-backed compartment-state lease holder that guards publish paths. */
	compartmentLeaseHolderId?: string;
	/** appendCompaction invokes Pi's `sessionManager.appendCompaction` hook. */
	appendCompaction?: (
		summary: string,
		firstKeptEntryId: string,
		tokensBefore: number,
		details?: unknown,
		fromHook?: boolean,
	) => string | undefined;
	/** readBranchEntries supplies raw Pi branch entries for mapping raw ordinals to entry IDs. */
	readBranchEntries?: () => unknown[];
	/** notifyIssue surfaces failure notices in the Pi UI or logs. */
	notifyIssue?: (message: string) => void | Promise<void>;
	/* */
	ensureProjectRegistered?: (
		directory: string,
		db: Database,
	) => void | Promise<void>;
	/** Manual wrapup bypasses the pressure-window quota but keeps no-progress protection. */
	forceDrainQuota?: boolean;
	/** forceKeepLastCompartment persists the final weak-lookahead compartment for coverage without promoting it. */
	forceKeepLastCompartment?: boolean;
}

export async function runPiHistorian(deps: PiHistorianDeps): Promise<void> {
	const {
		db,
		sessionId,
		directory,
		provider,
		runner,
		historianModel,
		fallbackModels,
		fallbackModelId,
		historianChunkTokens,
		boundarySnapshot: providedBoundarySnapshot,
		refreshBoundarySnapshot,
		currentContextLimit,
		historianTimeoutMs = DEFAULT_HISTORIAN_TIMEOUT_MS,
		signal,
		retryBackoffMs,
		twoPass,
		thinkingLevel,
		memoryEnabled,
		allowHomeProject,
		autoPromote,
		userMemoriesEnabled,
		onPublished,
		compartmentLeaseHolderId,
		readBranchEntries,
		notifyIssue,
		ensureProjectRegistered = ensureProjectRegisteredFromPiDirectory,
		forceDrainQuota,
		forceKeepLastCompartment,
	} = deps;

	let issueNotified = false;
	const notify = async (message: string): Promise<void> => {
		issueNotified = true;
		if (shouldSuppressHistorianAlert(sessionId)) {
			sessionLog(sessionId, "historian alert suppressed (cooldown)");
			return;
		}
		try {
			await notifyIssue?.(message);
		} catch (error) {
			sessionLog(sessionId, "historian notify failed", {
				error: describeError(error).brief,
			});
		}
	};

	updateSessionMeta(db, sessionId, { compartmentInProgress: true });

	const invocationBaseline = getLatestHistorianInvocationId(db, sessionId);
	const telemetry: Partial<HistorianRunInput> = {
		runKind: "incremental",
		status: "failed",
	};
	let completedSuccessfully = false;
	let retainDrainReservationForRetryThrottle = false;
	let drainReservation: ReturnType<
		typeof reserveProtectedTailDrainTokens
	>["reservation"] = null;
	const rollbackDrainReservation = (): void => {
		if (!drainReservation) return;
		rollbackProtectedTailDrainReservation(db, drainReservation);
		drainReservation = null;
	};

	try {
		// The shared helpers consult RawMessageProvider for sessionId.
		// `withRawMessageProvider` unregisters the provider when its callback throws.
		await withRawMessageProvider(sessionId, provider, async () => {
			const priorCompartments = getCompartments(db, sessionId);

			const existingValidationError =
				validateStoredCompartments(priorCompartments);
			if (existingValidationError) {
				sessionLog(
					sessionId,
					`historian failure: source=existing-validation reason="${existingValidationError}"`,
				);
				{
					const failCount = incrementHistorianFailure(
						db,
						sessionId,
						existingValidationError,
					);
					await notify(
						buildHistorianFailureNotice(failCount, existingValidationError),
					);
				}
				return;
			}

			const offset =
				priorCompartments.length > 0
					? priorCompartments[priorCompartments.length - 1].endMessage + 1
					: 1;

			let boundarySnapshot =
				providedBoundarySnapshot ??
				(process.env.NODE_ENV === "test"
					? createDefaultBoundarySnapshotForTests(sessionId)
					: null);
			if (!boundarySnapshot) {
				sessionLog(
					sessionId,
					"historian no-op: missing protected-tail boundary snapshot from Pi trigger decision",
				);
				return;
			}
			let validation =
				boundarySnapshot.rawRangeFingerprint.length > 0
					? validateBoundarySnapshot({
							db,
							snapshot: boundarySnapshot,
							currentContextLimit:
								currentContextLimit ?? boundarySnapshot.contextLimit,
						})
					: { ok: true as const };
			// A trigger-time boundary can become stale before detached historian validation.
			// New live-tail messages can arrive before detached historian validation.
			// The historian re-resolves the boundary from current Pi messages and adopts it only when it exposes an eligible head.
			// The refreshed snapshot recomputes the protected tail from live messages.
			if (
				!validation.ok &&
				validation.reason === "stale_snapshot" &&
				refreshBoundarySnapshot
			) {
				try {
					const refreshed = refreshBoundarySnapshot();
					if (hasRunnableCompartmentWindow(refreshed)) {
						sessionLog(
							sessionId,
							`historian: refreshed stale protected-tail snapshot at run time (was: ${validation.detail ?? "stale"}) — eligible head ${refreshed.offset}-${refreshed.eligibleEndOrdinal - 1}`,
						);
						boundarySnapshot = refreshed;
						validation = { ok: true };
					}
				} catch (error) {
					const desc = describeError(error);
					sessionLog(
						sessionId,
						`historian: failed to refresh stale protected-tail snapshot at run time (${validation.detail ?? "stale"}): ${desc.brief}`,
					);
				}
			}
			if (!validation.ok) {
				sessionLog(
					sessionId,
					`historian no-op: stale protected-tail snapshot (${validation.detail ?? validation.reason ?? "unknown"})`,
				);
				return;
			}
			const protectedTailStart = boundarySnapshot.protectedTailStart;
			const eligibleEndOrdinal = Math.min(
				boundarySnapshot.eligibleEndOrdinal,
				protectedTailStart,
			);
			if (protectedTailStart <= offset || eligibleEndOrdinal <= offset) {
				sessionLog(
					sessionId,
					`historian no-op: protectedTailStart=${protectedTailStart} eligibleEnd=${eligibleEndOrdinal} <= offset=${offset} — nothing to compact`,
				);
				if (boundarySnapshot.usagePercentage < 80) {
					if (!isWrapupInProgress(db, sessionId))
						clearEmergencyRecovery(db, sessionId);
				} else {
					recordHighPressureNoEligibleHead(db, boundarySnapshot);
				}
				// The historian clears the emergency catch-up latch when the tail is exhausted.
				clearEmergencyDrainLatch(db, sessionId);
				return;
			}

			const perRunCap = selectPerRunCap(boundarySnapshot);
			const usable = Math.max(
				1,
				Math.round(
					(boundarySnapshot.contextLimit *
						boundarySnapshot.executeThresholdPercentage) /
						100,
				),
			);
			const reserve = forceDrainQuota
				? { ok: true as const, reservation: null }
				: reserveProtectedTailDrainTokens({
						db,
						sessionId,
						runId: crypto.randomUUID(),
						trueRawTokens: boundarySnapshot.trueRawEligibleTokens,
						usagePercentage: boundarySnapshot.usagePercentage,
						usable,
						perRunCap,
						executeThresholdPercentage:
							boundarySnapshot.executeThresholdPercentage,
					});
			if (!reserve.ok) {
				sessionLog(
					sessionId,
					`historian rate-limit skip: ${reserve.skippedReason ?? "quota exhausted"}`,
				);
				telemetry.status = "noop";
				telemetry.failureReason = "protected-tail drain quota exhausted";
				return;
			}
			drainReservation = reserve.reservation;

			const chunk = readSessionChunk(
				sessionId,
				historianChunkTokens,
				offset,
				eligibleEndOrdinal,
			);
			const forceKeepLastCompartmentForChunk =
				forceKeepLastCompartment === true && !chunk.hasMore;
			if (!chunk.text || chunk.messageCount === 0) {
				sessionLog(
					sessionId,
					`historian no-op: chunk empty after filtering (messageCount=${chunk.messageCount}, textLen=${chunk.text?.length ?? 0}) range=${offset}-${protectedTailStart - 1}`,
				);
				if (boundarySnapshot.usagePercentage < 80) {
					if (!isWrapupInProgress(db, sessionId))
						clearEmergencyRecovery(db, sessionId);
				} else {
					recordHighPressureNoEligibleHead(db, boundarySnapshot);
				}
				// The historian clears the emergency catch-up latch when an eligible head produces no compactable chunk.
				clearEmergencyDrainLatch(db, sessionId);
				telemetry.status = "noop";
				telemetry.failureReason = "chunk empty after filtering";
				rollbackDrainReservation();
				return;
			}

			const chunkCoverageError = validateChunkCoverage(chunk);
			if (chunkCoverageError) {
				sessionLog(
					sessionId,
					`historian failure: source=chunk-coverage reason="${chunkCoverageError}" chunkRange=${chunk.startIndex}-${chunk.endIndex}`,
				);
				{
					const failCount = incrementHistorianFailure(
						db,
						sessionId,
						chunkCoverageError,
					);
					await notify(
						buildHistorianFailureNotice(failCount, chunkCoverageError),
					);
				}
				rollbackDrainReservation();
				return;
			}

			// The prompt includes prior compartments, facts, and a read-only memory block so the historian can deduplicate new facts against existing state.
			const projectPath = resolveProjectIdentityForSession(
				directory,
				allowHomeProject,
			);
			if (!projectPath) {
				rollbackDrainReservation();
				return;
			}
			const memorySnapshot = readAuthorizedClaimMemorySnapshot(db, {
				authorizedIdentities: [projectPath],
				ownIdentities: [projectPath],
				sharedCategories: [],
				workspaceEpoch: `pi-historian:${sessionId}:${chunk.startIndex}-${chunk.endIndex}`,
			});
			if (!memorySnapshot) {
				sessionLog(
					sessionId,
					"pi historian claim snapshot remained stale; omitting memories",
				);
			}
			const memoryBlock =
				renderClaimMemoryBlock(memorySnapshot?.items ?? []) ?? undefined;

			// The historian receives bounded reference blocks instead of all prior compartments.
			// The historian receives four rotating cross-project seed examples for importance-band calibration and the last six same-session compartments for continuity.
			const projectMemory = memoryBlock ?? "";
			const references = buildReferenceBlocks({
				sessionId,
				chunkStart: chunk.startIndex,
				sessionCompartments: priorCompartments,
			});

			const chunkText = truncateHistorianInputIfNeeded(
				chunk.text,
				historianChunkTokens,
			);
			if (chunkText !== chunk.text) {
				sessionLog(
					sessionId,
					`historian pre-flight: truncated formatted input for ${chunk.startIndex}-${chunk.endIndex} to fit ${historianChunkTokens} tokens`,
				);
			}

			const prompt = buildCompartmentAgentPrompt({
				seedExamples: references.seedExamples,
				sessionReferences: references.sessionReferences,
				projectMemory,
				inputSource: `Messages ${chunk.startIndex}-${chunk.endIndex}:\n\n${chunkText}`,
				memoryEnabled: memoryEnabled !== false,
			});

			// The sequence allocator uses `MAX(sequence) + 1` because recompaction can leave sequence gaps.
			const maxExistingSequence = priorCompartments.reduce(
				(max, c) => (c.sequence > max ? c.sequence : max),
				-1,
			);
			const sequenceOffset =
				priorCompartments.length === 0 ? 0 : maxExistingSequence + 1;

			sessionLog(
				sessionId,
				`historian: invoking subagent (model=${historianModel}, chunk=${chunk.startIndex}-${chunk.endIndex}, ${chunk.messageCount} msgs, ~${chunk.tokenEstimate} tokens)`,
			);

			// The historian logs lifecycle events by default so failure timelines remain readable in `magic-context.log`.
			// The logger skips `raw_event` and `first_event` logs unless `MC_PI_HISTORIAN_TRACE=1` to keep `magic-context.log` readable.
			const traceRawEvents = process.env.MC_PI_HISTORIAN_TRACE === "1";
			const buildProgressLogger = (passLabel: string) => {
				return (event: SubagentProgressEvent) => {
					try {
						if (event.type === "spawned") {
							sessionLog(
								sessionId,
								`historian[${passLabel}] spawned pid=${event.pid ?? "?"} argv=${event.argv.length} args`,
							);
						} else if (event.type === "terminal") {
							sessionLog(
								sessionId,
								`historian[${passLabel}] terminal @${event.ms}ms stopReason=${event.stopReason ?? "?"} textLen=${event.textLength} hasToolCall=${event.hasToolCall}`,
							);
						} else if (event.type === "stderr") {
							const cleaned = event.chunk.replace(/\s+/g, " ").trim();
							if (cleaned.length > 0) {
								sessionLog(
									sessionId,
									`historian[${passLabel}] stderr: ${cleaned.slice(0, 500)}`,
								);
							}
						} else if (event.type === "child_exit") {
							sessionLog(
								sessionId,
								`historian[${passLabel}] child_exit @${event.ms}ms code=${event.code} signal=${event.signal}`,
							);
						} else if (traceRawEvents) {
							if (event.type === "raw_event") {
								let serialized: string;
								try {
									serialized = JSON.stringify(event.event);
								} catch {
									serialized = "[unserializable]";
								}
								if (serialized.length > 4000) {
									serialized = `${serialized.slice(0, 4000)}…[truncated ${serialized.length - 4000} chars]`;
								}
								sessionLog(
									sessionId,
									`historian[${passLabel}] raw_event @${event.ms}ms type=${event.eventType ?? "?"}: ${serialized}`,
								);
							} else if (event.type === "first_event") {
								sessionLog(
									sessionId,
									`historian[${passLabel}] first_event @${event.ms}ms type=${event.eventType}`,
								);
							}
						}
					} catch {
						// Logging must never crash the runner.
					}
				};
			};

			retainDrainReservationForRetryThrottle = true;
			const historianSystemPrompt = withContentLanguageDirective(
				COMPARTMENT_AGENT_SYSTEM_PROMPT,
				deps.language,
				{ preserveUserQuotes: true },
			);
			const historianEditorSystemPrompt = withContentLanguageDirective(
				HISTORIAN_EDITOR_SYSTEM_PROMPT,
				deps.language,
				{ preserveUserQuotes: true },
			);

			// First pass.
			const firstResult = await runHistorianSubagentWithTransientRetries({
				runner,
				sessionId,
				passLabel: "first",
				retryBackoffMs,
				options: {
					agent: HISTORIAN_AGENT_NAME,
					systemPrompt: historianSystemPrompt,
					userMessage: prompt,
					model: historianModel,
					timeoutMs: historianTimeoutMs,
					cwd: directory,
					signal,
					thinkingLevel,
					onProgress: buildProgressLogger("first"),
					accountingSessionId: sessionId,
					accountingSubagent: "historian",
				},
			});

			let validatedPass = await validateHistorianResult(
				firstResult,
				sessionId,
				chunk,
				priorCompartments,
				sequenceOffset,
			);
			// The historian keeps the validated run's text so the editor receives repair output when the repair validates.
			// The editor must refine the repair draft that passed validation.
			let validatedDraftText: string | null = firstResult.ok
				? firstResult.assistantText
				: null;

			if (validatedPass.kind === "validation-failed") {
				sessionLog(
					sessionId,
					`historian: first pass validation failed, retrying with repair prompt: ${validatedPass.error}`,
				);
				const repairPrompt = buildHistorianRepairPrompt(
					prompt,
					validatedPass.rawText,
					validatedPass.error,
					deps.language,
				);
				const repairResult = await runHistorianSubagentWithTransientRetries({
					runner,
					sessionId,
					passLabel: "repair",
					retryBackoffMs,
					options: {
						agent: HISTORIAN_AGENT_NAME,
						systemPrompt: historianSystemPrompt,
						userMessage: repairPrompt,
						model: historianModel,
						timeoutMs: historianTimeoutMs,
						cwd: directory,
						signal,
						thinkingLevel,
						onProgress: buildProgressLogger("repair"),
						accountingSessionId: sessionId,
						accountingSubagent: "historian",
					},
				});
				validatedPass = await validateHistorianResult(
					repairResult,
					sessionId,
					chunk,
					priorCompartments,
					sequenceOffset,
				);
				if (validatedPass.kind === "ok" && repairResult.ok) {
					validatedDraftText = repairResult.assistantText;
				}
			}

			// The runner validates every candidate because successful completion can still yield no usable compartments.
			const fallbackChain = buildHistorianFallbackChain(
				historianModel,
				fallbackModels,
				fallbackModelId,
			);
			if (
				validatedPass.kind !== "ok" &&
				!(
					validatedPass.kind === "spawn-failed" &&
					validatedPass.reason === "abort"
				) &&
				fallbackChain.length > 0
			) {
				for (let i = 0; i < fallbackChain.length; i += 1) {
					const candidate = fallbackChain[i];
					sessionLog(
						sessionId,
						`historian: escalating to ${candidate.kind === "session" ? "session-model last resort" : "configured fallback model"} ${candidate.modelId}`,
					);
					const fbResult = await runHistorianSubagentWithTransientRetries({
						runner,
						sessionId,
						passLabel:
							candidate.kind === "session" ? "fallback-session" : "fallback",
						retryBackoffMs,
						options: {
							agent: HISTORIAN_AGENT_NAME,
							systemPrompt: historianSystemPrompt,
							userMessage: prompt,
							model: candidate.modelId,
							timeoutMs: historianTimeoutMs,
							cwd: directory,
							signal,
							thinkingLevel,
							onProgress: buildProgressLogger("fallback"),
							accountingSessionId: sessionId,
							accountingSubagent: "historian",
						},
					});
					const fbPass = await validateHistorianResult(
						fbResult,
						sessionId,
						chunk,
						priorCompartments,
						sequenceOffset,
					);
					if (fbPass.kind === "ok") {
						validatedPass = fbPass;
						if (fbResult.ok) validatedDraftText = fbResult.assistantText;
						break;
					}
					if (fbPass.kind === "spawn-failed" && fbPass.reason === "abort") {
						validatedPass = fbPass;
						break;
					}
				}
			}

			if (validatedPass.kind !== "ok") {
				const errorMsg =
					validatedPass.kind === "validation-failed"
						? validatedPass.error
						: validatedPass.kind === "spawn-failed"
							? `subagent run failed (${validatedPass.reason}): ${validatedPass.error}`
							: "historian returned no usable text";
				sessionLog(sessionId, `historian failure: ${errorMsg}`);
				{
					const failCount = incrementHistorianFailure(db, sessionId, errorMsg);
					await notify(buildHistorianFailureNotice(failCount, errorMsg));
				}
				return;
			}
			retainDrainReservationForRetryThrottle = false;

			// When `twoPass` is enabled, the historian replaces the draft only with editor output that passes validation.
			if (twoPass && validatedPass.kind === "ok") {
				const draftAssistantText = validatedDraftText ?? "";
				if (draftAssistantText.trim().length > 0) {
					sessionLog(sessionId, "historian two-pass: running editor on draft");
					const editorResult = await runHistorianSubagentWithTransientRetries({
						runner,
						sessionId,
						passLabel: "editor",
						retryBackoffMs,
						options: {
							agent: HISTORIAN_AGENT_NAME,
							systemPrompt: historianEditorSystemPrompt,
							userMessage: buildHistorianEditorPrompt(draftAssistantText),
							model: historianModel,
							timeoutMs: historianTimeoutMs,
							cwd: directory,
							signal,
							thinkingLevel,
							onProgress: buildProgressLogger("editor"),
							accountingSessionId: sessionId,
							accountingSubagent: "historian_editor",
						},
					});
					const editorPass = await validateHistorianResult(
						editorResult,
						sessionId,
						chunk,
						priorCompartments,
						sequenceOffset,
					);
					if (editorPass.kind === "ok") {
						sessionLog(
							sessionId,
							`historian two-pass: editor accepted, replacing draft`,
						);
						validatedPass = editorPass;
					} else {
						const editorErr =
							editorPass.kind === "validation-failed"
								? editorPass.error
								: editorPass.kind === "spawn-failed"
									? `subagent run failed (${editorPass.reason}): ${editorPass.error}`
									: "editor returned no usable text";
						sessionLog(
							sessionId,
							`historian two-pass: editor failed (${editorErr}), falling back to draft`,
						);
					}
				}
			}

			// The last compartment of a greedy-consume run has no lookahead, so its boundary is unreliable.
			// The historian drops the final compartment when at most `HISTORIAN_BOUNDARY_HEALING_SLACK` messages follow it, so the next run re-derives it with following context.
			// The historian requires at least two emitted compartments so one remains after discarding the provisional tail and publication advances.
			// The historian never persists a boundary inside a completed invocation/result pair.
			// During emergency recovery, the historian retains all compartments for immediate space relief.
			// Outside emergency recovery, the historian re-derives the discarded compartment on the next run with additional following context.
			const inEmergency = getOverflowState(
				db,
				sessionId,
			).needsEmergencyRecovery;
			const emittedCompartments = validatedPass.compartments;
			let newCompartments = emittedCompartments;
			if (
				!inEmergency &&
				!forceKeepLastCompartmentForChunk &&
				shouldDiscardLastHistorianCompartment(emittedCompartments, chunk)
			) {
				const lastEmitted = emittedCompartments[emittedCompartments.length - 1];
				const lookaheadMargin = chunk.endIndex - lastEmitted.endMessage;
				newCompartments = emittedCompartments.slice(0, -1);
				sessionLog(
					sessionId,
					`historian discard-last: dropped provisional compartment ${lastEmitted.startMessage}-${lastEmitted.endMessage} (lookaheadMargin=${lookaheadMargin} <= ${HISTORIAN_BOUNDARY_HEALING_SLACK}); will re-derive next run`,
				);
			}
			const lastNewEnd =
				newCompartments[newCompartments.length - 1]?.endMessage ?? 0;
			if (lastNewEnd + 1 <= offset) {
				const errorMsg = `historian returned compartments that did not advance past raw message ${offset - 1}`;
				sessionLog(
					sessionId,
					`historian failure: source=no-progress newCompartmentCount=${newCompartments.length} lastNewEnd=${lastNewEnd} priorEnd=${offset - 1}`,
				);
				{
					const failCount = incrementHistorianFailure(db, sessionId, errorMsg);
					await notify(buildHistorianFailureNotice(failCount, errorMsg));
				}
				rollbackDrainReservation();
				return;
			}

			const markerSummary = buildPiCompactionSummary(newCompartments);
			const lastNewEndMessageId =
				newCompartments[newCompartments.length - 1]?.endMessageId;
			let firstKeptEntryId: string | null = null;
			if (readBranchEntries) {
				try {
					firstKeptEntryId = findFirstKeptEntryId(
						readBranchEntries(),
						lastNewEnd,
					);
					if (!firstKeptEntryId) {
						sessionLog(
							sessionId,
							`historian: native compaction queue skipped; no firstKeptEntryId after ordinal ${lastNewEnd}`,
						);
					}
				} catch (error) {
					sessionLog(
						sessionId,
						`historian: native compaction queue lookup failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}

			// Preserve a weak-lookahead tail only for the final raw-history chunk.
			// Treat `chunk.hasMore` as evidence that raw history remains after a token-capped chunk.
			// Token-capped chunks use discard-last healing and promotion.
			const discardedLast = newCompartments.length < emittedCompartments.length;
			const weakLookaheadFinalCompartment = forceKeepLastCompartmentForChunk;
			// Skip unanchored promotion after discard-last runs because facts cannot be attributed to the persisted range.
			// would double-store.
			const skipUnanchoredPromotion =
				discardedLast || weakLookaheadFinalCompartment;

			const embeddingActive = memoryEnabled !== false;
			const promotionActive = embeddingActive && autoPromote !== false;

			const publishableEvents = (validatedPass.events ?? []).filter((e) => {
				if (typeof e.atCompartment !== "number")
					return !weakLookaheadFinalCompartment;
				if (e.atCompartment > newCompartments.length) return false;
				if (
					weakLookaheadFinalCompartment &&
					e.atCompartment >= emittedCompartments.length
				)
					return false;
				return true;
			});
			let persistedIds: number[] = [];

			// The transaction atomically publishes appended compartments, durable facts, events, the drop queue, and failure-state clearing.
			// Stage the Pi-native compaction marker payload in the transaction so a crash cannot leave compartments without a marker queued for deferred materialization.
			// BEGIN IMMEDIATE performs the holder check and writes on a single write-locked snapshot.
			if (!compartmentLeaseHolderId) {
				sessionLog(
					sessionId,
					"historian publish skipped: missing compartment lease holder",
				);
				rollbackDrainReservation();
				return;
			}
			let published = false;
			db.exec("BEGIN IMMEDIATE");
			try {
				if (!isCompartmentLeaseHeld(db, sessionId, compartmentLeaseHolderId)) {
					db.exec("ROLLBACK");
					sessionLog(
						sessionId,
						"historian publish skipped: compartment lease no longer held",
					);
					rollbackDrainReservation();
					return;
				}
				appendCompartments(db, sessionId, newCompartments);
				// appendCompartments inserts at the tail, so the last N compartments provide durable IDs for event anchoring and post-commit embeddings.
				persistedIds = getCompartments(db, sessionId)
					.slice(-newCompartments.length)
					.map((c) => c.id);
				// Promote only facts from this chunk; do not replace the session fact list.
				// Promotion and boundary-floor updates commit or roll back together.
				if (promotionActive && !skipUnanchoredPromotion) {
					promoteSessionFactsDurable(
						db,
						sessionId,
						projectPath,
						validatedPass.facts ?? [],
						{
							producer: "pi-historian",
							runId: `${sessionId}:${chunk.startIndex}:${chunk.endIndex}`,
							leaseKey: `compartment:${sessionId}`,
							leaseGeneration: compartmentLeaseHolderId,
							batchId: `${chunk.startIndex}-${lastNewEnd}`,
						},
					);
				}

				if (publishableEvents.length > 0) {
					try {
						insertCompartmentEvents(
							db,
							sessionId,
							publishableEvents,
							persistedIds,
						);
						sessionLog(
							sessionId,
							`stored ${publishableEvents.length} compartment event(s)`,
						);
					} catch (error) {
						sessionLog(sessionId, "failed to store compartment events:", error);
					}
				}

				queueDropsForCompartmentalizedMessages(db, sessionId, lastNewEnd);

				clearHistorianFailureState(db, sessionId);
				// Wrapup retains overflow recovery until the loop reaches the keep watermark.
				clearHistorianDrainFailure(db, sessionId);
				recordProtectedTailPublicationFloor(db, sessionId, lastNewEnd + 1);
				if (!isWrapupInProgress(db, sessionId))
					clearEmergencyRecovery(db, sessionId);
				// Insert userObservations after commit so auxiliary failures cannot roll back compartment publication.
				if (firstKeptEntryId && lastNewEndMessageId) {
					setPendingPiCompactionMarkerState(db, sessionId, {
						firstKeptEntryId,
						endMessageId: lastNewEndMessageId,
						ordinal: lastNewEnd,
						tokensBefore: chunk.tokenEstimate,
						summary: markerSummary,
						publishedAt: Date.now(),
					});
				}
				db.exec("COMMIT");
				published = true;
			} finally {
				if (!published) {
					try {
						db.exec("ROLLBACK");
					} catch {
					}
				}
			}

			// The publisher signals deferred materialization and history refresh immediately after COMMIT.
			// The transaction contains all publish-visible durable state; embedding registration and provider calls run post-commit on a best-effort basis.
			onPublished?.();
			completedSuccessfully = true;

			sessionLog(
				sessionId,
				`historian: published ${newCompartments.length} compartment(s), ${validatedPass.facts?.length ?? 0} fact(s) covering messages ${chunk.startIndex}-${lastNewEnd}`,
			);

			// Historian publication signals deferred notes for the next user turn.
			onNoteTrigger(db, sessionId, "historian_complete");

			// The user-memory gate prevents opted-out users from persisting behavioral candidates.
			if (
				userMemoriesEnabled === true &&
				!skipUnanchoredPromotion &&
				validatedPass.userObservations?.length
			) {
				try {
					insertUserMemoryCandidates(
						db,
						validatedPass.userObservations.map((obs) => ({
							content: obs,
							sessionId,
							sourceCompartmentStart: newCompartments[0]?.startMessage,
							sourceCompartmentEnd: lastNewEnd,
						})),
					);
					sessionLog(
						sessionId,
						`stored ${validatedPass.userObservations.length} user memory candidate(s)`,
					);
				} catch (error) {
					sessionLog(
						sessionId,
						"failed to store user memory candidates:",
						error,
					);
				}
			}

			if (
				!skipUnanchoredPromotion &&
				validatedPass.primerCandidates?.length &&
				projectPath
			) {
				try {
					const firstNew = newCompartments[0];
					const lastNew = newCompartments[newCompartments.length - 1];
					const [candidate] = validatedPass.primerCandidates;
					// originCompartmentIndex identifies the emitted compartment that produced the question.
					const idx = candidate.originCompartmentIndex;
					const origin =
						typeof idx === "number" && idx >= 1 && idx <= newCompartments.length
							? newCompartments[idx - 1]
							: undefined;
					const startC = origin ?? firstNew;
					const endC = origin ?? lastNew;
					const sourceStartMessageId =
						startC?.startMessageId ||
						`ordinal:${startC?.startMessage ?? chunk.startIndex}`;
					const sourceEndMessageId =
						endC?.endMessageId || `ordinal:${endC?.endMessage ?? lastNewEnd}`;
					const sourceMessage =
						provider.readMessageById?.(sourceStartMessageId);
					const sourceMessageTime =
						parseSourceMessageTime(sourceMessage?.version) ?? Date.now();
					const stored = insertPrimerCandidates(db, [
						{
							projectPath,
							harness: "pi",
							sessionId,
							question: candidate.question,
							sourceCompartmentStart: startC?.startMessage,
							sourceCompartmentEnd: endC?.endMessage,
							sourceStartMessageId,
							sourceEndMessageId,
							sourceMessageTime,
						},
					]);
					sessionLog(
						sessionId,
						`stored ${stored.length} primer candidate occurrence(s)${origin ? " (origin-tagged)" : " (chunk-span fallback)"}`,
					);
				} catch (error) {
					sessionLog(sessionId, "failed to store primer candidates:", error);
				}
			}

			// Raw chunk embeddings support ctx_search over session history.
			if (embeddingActive) {
				const chunksToEmbed = newCompartments
					.map((c, i) => ({
						id: persistedIds[i],
						startMessage: c.startMessage,
						endMessage: c.endMessage,
						sourceChunkText: chunk.text,
					}))
					.filter((c) => typeof c.id === "number");
				void (async () => {
					try {
						await ensureProjectRegistered(directory, db);
					} catch (error) {
						sessionLog(
							sessionId,
							"project registration after publish failed:",
							error,
						);
					}
					try {
						await embedAndStoreCompartmentChunks(
							db,
							sessionId,
							projectPath,
							chunksToEmbed,
						);
					} catch (error) {
						sessionLog(
							sessionId,
							"compartment embedding dispatch failed:",
							error,
						);
					}
				})();
			}

			{
				const facts = validatedPass.facts ?? [];
				const validIds = persistedIds.filter(
					(id): id is number => typeof id === "number",
				);
				const imp = summarizeImportance(
					newCompartments.map((c) => c.importance ?? 50),
				);
				telemetry.status = "success";
				telemetry.chunkStartOrdinal = chunk.startIndex;
				telemetry.chunkEndOrdinal = chunk.endIndex;
				telemetry.unprocessedFrom = lastNewEnd + 1;
				telemetry.compartmentsProduced = newCompartments.length;
				telemetry.compartmentIdMin =
					validIds.length > 0 ? Math.min(...validIds) : null;
				telemetry.compartmentIdMax =
					validIds.length > 0 ? Math.max(...validIds) : null;
				telemetry.factsEmitted = facts.length;
				telemetry.factsByCategory =
					facts.length > 0 ? tallyFactsByCategory(facts) : null;
				telemetry.eventsEmitted = publishableEvents.length;
				telemetry.importanceMin = imp.min;
				telemetry.importanceMax = imp.max;
				telemetry.importanceAvg = imp.avg;
				telemetry.discardedLast = discardedLast;
			}
		});
	} catch (error) {
		const desc = describeError(error);
		telemetry.failureReason = `exception: ${desc.brief}`;
		sessionLog(
			sessionId,
			`historian failure: source=exception ${desc.brief}${desc.stackHead ? ` stackHead="${desc.stackHead}"` : ""}`,
		);
		if (!issueNotified) {
			const failCount = incrementHistorianFailure(db, sessionId, desc.brief);
			await notify(buildHistorianFailureNotice(failCount, desc.brief));
		}
	} finally {
		if (!completedSuccessfully) {
			if (!retainDrainReservationForRetryThrottle) {
				rollbackDrainReservation();
			} else {
				// Suppress the emergency catch-up latch during the retained-reservation retry backoff.
				// OpenCode.
				recordHistorianDrainFailure(db, sessionId);
			}
		}
		updateSessionMeta(db, sessionId, { compartmentInProgress: false });
		// Record one historian_runs row for this attempt (every exit path).
		try {
			const latest = getLatestHistorianInvocationId(db, sessionId);
			const invocationId =
				latest != null &&
				(invocationBaseline == null || latest > invocationBaseline)
					? latest
					: null;
			recordHistorianRun(db, {
				sessionId,
				harness: "pi",
				subagentInvocationId: invocationId,
				runKind: telemetry.runKind ?? "incremental",
				status: telemetry.status ?? "failed",
				failureReason: telemetry.failureReason ?? null,
				chunkStartOrdinal: telemetry.chunkStartOrdinal ?? null,
				chunkEndOrdinal: telemetry.chunkEndOrdinal ?? null,
				unprocessedFrom: telemetry.unprocessedFrom ?? null,
				compartmentsProduced: telemetry.compartmentsProduced ?? 0,
				compartmentIdMin: telemetry.compartmentIdMin ?? null,
				compartmentIdMax: telemetry.compartmentIdMax ?? null,
				factsEmitted: telemetry.factsEmitted ?? 0,
				factsByCategory: telemetry.factsByCategory ?? null,
				eventsEmitted: telemetry.eventsEmitted ?? 0,
				importanceMin: telemetry.importanceMin ?? null,
				importanceMax: telemetry.importanceMax ?? null,
				importanceAvg: telemetry.importanceAvg ?? null,
				discardedLast: telemetry.discardedLast ?? false,
			});
		} catch {
			/* Telemetry failures must not interrupt compaction. */
		}
	}
}

/* */
type ValidationOutcome =
	| {
			kind: "ok";
			compartments: ReturnType<typeof validateHistorianOutput> extends infer T
				? T extends { ok: true; compartments: infer C }
					? C
					: never
				: never;
			facts: ReturnType<typeof validateHistorianOutput> extends infer T
				? T extends { ok: true; facts: infer F }
					? F
					: never
				: never;
			userObservations?: string[];
			primerCandidates?: ReturnType<
				typeof validateHistorianOutput
			> extends infer T
				? T extends { ok: true; primerCandidates?: infer P }
					? P
					: never
				: never;
			events?: ReturnType<typeof validateHistorianOutput> extends infer T
				? T extends { ok: true; events?: infer E }
					? E
					: never
				: never;
	  }
	| { kind: "validation-failed"; error: string; rawText: string }
	| { kind: "spawn-failed"; reason: string; error: string }
	| { kind: "no-output" };

async function validateHistorianResult(
	result: SubagentRunResult,
	sessionId: string,
	chunk: Parameters<typeof validateHistorianOutput>[2],
	priorCompartments: Parameters<typeof validateHistorianOutput>[3],
	sequenceOffset: number,
): Promise<ValidationOutcome> {
	if (!result.ok) {
		return {
			kind: "spawn-failed",
			reason: result.reason,
			error: result.error,
		};
	}
	if (result.assistantText.trim().length === 0) {
		return { kind: "no-output" };
	}

	const validation = validateHistorianOutput(
		result.assistantText,
		sessionId,
		chunk,
		priorCompartments,
		sequenceOffset,
	);
	if (validation.ok) {
		return {
			kind: "ok",
			compartments: validation.compartments,
			facts: validation.facts,
			userObservations: validation.userObservations,
			primerCandidates: validation.primerCandidates,
			events: validation.events,
		};
	}
	return {
		kind: "validation-failed",
		error: validation.error,
		rawText: result.assistantText,
	};
}

export function buildPiCompactionSummary(
	compartments: Array<{
		title: string;
		startMessage: number;
		endMessage: number;
	}>,
): string {
	if (compartments.length === 0)
		return "Magic Context compacted prior history.";
	const titles = compartments
		.map((c) => c.title.trim())
		.filter((title) => title.length > 0);
	if (titles.length === 0) {
		const first = compartments[0];
		const last = compartments[compartments.length - 1];
		return `Magic Context compacted messages ${first?.startMessage ?? "?"}-${last?.endMessage ?? "?"}.`;
	}
	// Cap the title list so the marker summary stays bounded.
	// The marker summary is not model-visible because filterCompacted replaces it with <session-history>.
	// The marker summary remains written to JSONL.
	// Joining all titles makes the marker grow without bound as compartment count increases.
	const MAX_SUMMARY_TITLES = 5;
	if (titles.length <= MAX_SUMMARY_TITLES) {
		return `Magic Context compacted: ${titles.join("; ")}`;
	}
	const shown = titles.slice(0, MAX_SUMMARY_TITLES).join("; ");
	return `Magic Context compacted ${titles.length} segments: ${shown}; …and ${
		titles.length - MAX_SUMMARY_TITLES
	} more`;
}

/**
 * Set firstKeptEntryId to the SessionEntry ID for RawMessage ordinal lastCompactedOrdinal + 1 so entries after the compacted compartment survive.
 *
 *
 * Use convertEntriesToRawMessages for ordinals because Historian publishes its endMessage values from that source, while appendCompaction requires a real SessionEntry ID for firstKeptEntryId.
 *
 * Use `convertEntriesToRawMessages` because it emits synthetic-user RawMessages for `toolResult→assistant` transitions.
 *
 * e2e test).
 *
 *
 *
 * Do not pass a folded toolResult RawMessage ID as firstKeptEntryId: its synthetic ID is not a real SessionEntry ID, and compaction replay locates the kept tail by real entry.id.
 * Synthetic-user IDs do not match `SessionEntry.id` values.
 *
 * Ordinals ≤ `lastCompactedOrdinal` are summarized.
 * A synthetic-user message at `target` is un-summarized kept-tail content.
 * The function must not advance past an un-summarized synthetic-user boundary to a later assistant.
 * Advancing to a later assistant would omit the folded toolResult run from the summary and kept tail.
 * The boundary must not be a toolResult: the kept tail cannot start with a toolResult whose `tool_use` was summarized.
 *
 */
export function findFirstKeptEntryId(
	entries: unknown[],
	lastCompactedOrdinal: number,
): string | null {
	const rawMessages = convertEntriesToRawMessages(entries);
	const target = lastCompactedOrdinal + 1;
	const boundary = rawMessages.find((m) => m.ordinal === target);
	if (!boundary) return null;
	if (boundary.id.length === 0) return null;
	if (boundary.id.startsWith(SYNTH_USER_ID_PREFIX)) return null;
	return boundary.id;
}
