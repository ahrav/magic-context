import { autoSearchHintFragmentsStillEligible } from "../../features/magic-context/memory/storage-claim-visibility";
import {
    addProcessedImageStrippedIds,
    addStaleReduceStrippedIds,
    applyStrippedPlaceholderDelta,
    type ContextDatabase,
    clearDeferredExecutePendingIfMatches,
    clearPendingCompactionMarkerStateIf,
    clearPersistedTodoSyntheticAnchor,
    getActiveTagsBySession,
    getAutoSearchHintDecisions,
    getMaxM0MutationId,
    getNoteNudgeAnchors,
    getPendingCompactionMarkerState,
    getPendingOps,
    getPersistedTodoPermissionDenied,
    getPersistedTodoSyntheticAnchor,
    getProcessedImageStrippedIds,
    getStaleReduceStrippedIds,
    getStrippedPlaceholderIds,
    type PendingCompactionMarker,
    peekDeferredExecutePending,
    pruneAutoSearchHintDecisions,
    pruneNoteNudgeAnchors,
    setPersistedTodoPermissionDenied,
    setPersistedTodoSyntheticAnchor,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import {
    addMergedReasoningStrippedIds,
    addTrailingBlankDecisions,
    getMergedReasoningStrippedIds,
    getPersistedCompactionMarkerState,
    getTrailingBlankDecisions,
    type PersistedCompactionMarkerState,
} from "../../features/magic-context/storage-meta-persisted";
import {
    getOldestActiveUnprotectedToolTags,
    getTagNumberByMessageId,
    getTailHygieneTags,
    updateTagStatus,
} from "../../features/magic-context/storage-tags";
import type { Tagger } from "../../features/magic-context/tagger";
import type { SessionMeta, TagEntry } from "../../features/magic-context/types";
import type { PluginContext } from "../../plugin/types";
import { BoundedSessionMap } from "../../shared/bounded-session-map";
import { getErrorMessage } from "../../shared/error-message";
import { sessionLog } from "../../shared/logger";
import { isRecord } from "../../shared/record-type-guard";
import { runAutoSearchHint } from "./auto-search-runner";
import {
    rearmChannel2AfterCoverageAdvancingHardFold,
    rearmChannel2AfterMeasuredCollapse,
} from "./channel2-cycle";
import { applyDeferredCompactionMarker, MARKER_SUMMARY_TEXT } from "./compaction-marker-manager";
import { getActiveCompartmentRun } from "./compartment-runner";
import type {
    CtxReduceAvailabilityVerdict,
    ToolAvailabilityVerdict,
} from "./ctx-reduce-availability";
import {
    cachedToolPermissionDenied,
    hasLoggedCtxReducePermissionDeny,
    markCtxReducePermissionDenyLogged,
    resolveToolPermissionDenied,
    todowritePermissionDenied,
} from "./ctx-reduce-availability";
import type { Channel1State } from "./ctx-reduce-nudge";
import { dropStaleReduceCalls } from "./drop-stale-reduce-calls";
import { foldExecutesThisPass } from "./fold-execution-gate";
import { applyHeuristicCleanup } from "./heuristic-cleanup";
import {
    clearInjectionCache,
    injectM0M1,
    type M0HardSignals,
    type M0M1State,
    mustMaterialize,
    type PreparedCompartmentInjection,
    renderCompartmentInjection,
} from "./inject-compartments";
import { markNoteNudgeDelivered, peekNoteNudgeText } from "./note-nudger";
import { hasVisibleNoteReadCall } from "./note-visibility";
import type { PassOutcome } from "./pass-outcome";
import { estimateTokens } from "./read-session-formatting";
import { modelAcceptsEmptyContent, replaySentinelByMessageIds } from "./sentinel";
import {
    applyFrozenTrailingBlankDecisions,
    clearOldReasoning,
    findMergedReasoningStripCandidateIds,
    findTrailingBlankDecisionCandidates,
    stripClearedReasoning,
    stripDroppedPlaceholderMessages,
    stripInlineThinking,
    stripReasoningFromMergedAssistants,
    stripSystemInjectedMessages,
    type TrailingBlankDecision,
} from "./strip-content";
import { buildEditSupersessionReclaim, buildSupersessionReclaimOps } from "./supersession-reclaim";
import { byteSize, prependTag } from "./tag-content-primitives";
import {
    assertTailHygieneContentUnchanged,
    refreshTailHygieneBaseline,
    sameTailHygieneStructuralSignature,
    type TailHygieneStructuralSignature,
    tailHygieneStructuralSignature,
} from "./tail-hygiene-walk";
import { buildSyntheticTodoPart, isSyntheticTodoPart, type SyntheticTodoPart } from "./todo-view";
import {
    advanceToolReclaimWatermarkToCurrentMax,
    buildSyntheticToolReclaimOps,
} from "./tool-reclaim";
import {
    appendReminderToUserMessageById,
    findLastUserMessageId,
    injectToolPartIntoAssistantById,
    injectToolPartIntoLatestAssistant,
} from "./transform-message-helpers";
import {
    applyPendingOperations,
    type MessageLike,
    stripProcessedImages,
    type TagTarget,
} from "./transform-operations";
import { logTransformTiming } from "./transform-stage-logger";

const DEGRADE_CACHE_WARNING_THRESHOLD = 10;
// The 100-entry LRU bounds entries for sessions that never reset.
const degradedCacheCountBySession = new BoundedSessionMap<number>(100);

export function resetDegradedCacheCount(sessionId: string): void {
    degradedCacheCountBySession.delete(sessionId);
}

export type DeferredCompactionMarkerClearOutcome =
    | "cleared"
    | "cas-lost-newer-pending"
    | "cas-lost-already-cleared";

function isSyntheticHeadMessage(message: MessageLike): boolean {
    // No persisted OpenCode row can satisfy this shape because persisted rows always have an id.
    // Both `prependM0M1Messages` and Rust m0/m1 encoding produce this shape.
    // The TypeScript lane additionally sets `info.syntheticHead`.
    // Rust m0/m1 encodings omit `info.syntheticHead`, so requiring it would place the compaction summary before m0.
    // Requiring `info.syntheticHead` would stop the Rust-mode head walk at index 0.
    // Splicing at index 0 would place the compaction summary ahead of m0, violating the m0 wire invariant.
    if (message.info.id !== undefined) return false;
    if (message.info.role !== "user") return false;
    const parts = message.parts;
    if (parts.length === 0) return false;
    return parts.every((part) => (part as { synthetic?: boolean }).synthetic === true);
}

const TODO_HEAD_ANCHOR_ID = "__magic_context_todo_head__";

interface SyntheticTodoInjectionResult {
    injected: boolean;
    messageId: string;
    prependedMessageCount: number;
}

function injectSyntheticTodoAtHead(
    messages: MessageLike[],
    sessionId: string,
    part: SyntheticTodoPart,
): SyntheticTodoInjectionResult {
    let headEnd = 0;
    while (headEnd < messages.length && isSyntheticHeadMessage(messages[headEnd])) {
        headEnd += 1;
    }
    const existing = messages[headEnd];
    if (existing?.info.id === TODO_HEAD_ANCHOR_ID) {
        injectToolPartIntoAssistantById(messages, TODO_HEAD_ANCHOR_ID, part);
        return {
            injected: true,
            messageId: TODO_HEAD_ANCHOR_ID,
            prependedMessageCount: 0,
        };
    }
    messages.splice(headEnd, 0, {
        info: {
            id: TODO_HEAD_ANCHOR_ID,
            role: "assistant",
            sessionID: sessionId,
        },
        parts: [part],
    });
    return {
        injected: true,
        messageId: TODO_HEAD_ANCHOR_ID,
        prependedMessageCount: 1,
    };
}

function injectPersistedTodoAnchor(
    messages: MessageLike[],
    sessionId: string,
    messageId: string,
    part: SyntheticTodoPart,
): SyntheticTodoInjectionResult {
    if (injectToolPartIntoAssistantById(messages, messageId, part)) {
        return { injected: true, messageId, prependedMessageCount: 0 };
    }
    if (messageId !== TODO_HEAD_ANCHOR_ID) {
        return { injected: false, messageId, prependedMessageCount: 0 };
    }
    return injectSyntheticTodoAtHead(messages, sessionId, part);
}

function removeSyntheticTodoParts(messages: MessageLike[]): void {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (!message) continue;
        const retainedParts = message.parts.filter((part) => !isSyntheticTodoPart(part));
        if (retainedParts.length === message.parts.length) continue;
        message.parts = retainedParts;
        if (message.info.id === TODO_HEAD_ANCHOR_ID && retainedParts.length === 0) {
            messages.splice(index, 1);
        }
    }
}

/**
 * Permission refreshes only on a cache-busting pass.
 * Defer passes replay the cached verdict and frozen bytes without consulting the SDK.
 */
export async function applyTodoSynthesis(args: {
    db: ContextDatabase;
    sessionId: string;
    messages: MessageLike[];
    fullFeatureMode: boolean;
    compactionOff?: boolean;
    isCacheBustingPass: boolean;
    sessionMeta: SessionMeta;
    todowriteAvailability: ToolAvailabilityVerdict;
    client?: PluginContext["client"];
    activeAgent?: string;
}): Promise<number> {
    if (!args.fullFeatureMode || args.compactionOff) return 0;

    const persistedAnchor = getPersistedTodoSyntheticAnchor(args.db, args.sessionId);
    let permissionDenied =
        cachedToolPermissionDenied(args.sessionId, "todowrite") ??
        getPersistedTodoPermissionDenied(args.db, args.sessionId) ??
        false;
    const toolsMapUnavailable =
        args.todowriteAvailability.frozen && !args.todowriteAvailability.callable;

    if (args.isCacheBustingPass && args.client && !toolsMapUnavailable) {
        try {
            permissionDenied = await todowritePermissionDenied(
                args.client,
                args.sessionId,
                args.activeAgent,
            );
            setPersistedTodoPermissionDenied(args.db, args.sessionId, permissionDenied);
        } catch (error) {
            // A transient SDK read must not turn a previously denied tool back on.
            // The cache retains the last in-memory or durable verdict until a permission refresh reads the live state successfully.
            // A permission refresh must successfully read the live state.
            sessionLog(
                args.sessionId,
                "todowrite permission read failed; retaining the last successful verdict:",
                error,
            );
        }
    }

    const todowriteUnavailable = toolsMapUnavailable || permissionDenied;
    if (args.isCacheBustingPass && todowriteUnavailable) {
        removeSyntheticTodoParts(args.messages);
        // Cleanup clears the persisted synthetic anchor even when an older row contains only one synthetic field.
        // Otherwise, stale partial data could retain one field after the tool becomes unavailable.
        clearPersistedTodoSyntheticAnchor(args.db, args.sessionId);
        if (persistedAnchor) {
            sessionLog(
                args.sessionId,
                "todowrite synthetic pair cleared on a cache-busting pass because the tool is denied",
            );
        }
        return 0;
    }

    if (args.isCacheBustingPass) {
        const part = buildSyntheticTodoPart(args.sessionMeta.lastTodoState);
        const persistedInjection =
            part !== null && persistedAnchor && persistedAnchor.callId === part.callID
                ? injectPersistedTodoAnchor(
                      args.messages,
                      args.sessionId,
                      persistedAnchor.messageId,
                      part,
                  )
                : null;
        if (part === null) {
            if (persistedAnchor) clearPersistedTodoSyntheticAnchor(args.db, args.sessionId);
            return 0;
        }
        if (persistedAnchor && persistedInjection?.injected) {
            if (persistedAnchor.stateJson.length === 0) {
                setPersistedTodoSyntheticAnchor(
                    args.db,
                    args.sessionId,
                    persistedAnchor.callId,
                    persistedAnchor.messageId,
                    args.sessionMeta.lastTodoState,
                );
            }
            return persistedInjection.prependedMessageCount;
        }

        const existingAssistantId = injectToolPartIntoLatestAssistant(args.messages, part);
        const injection =
            existingAssistantId === null
                ? injectSyntheticTodoAtHead(args.messages, args.sessionId, part)
                : {
                      injected: true,
                      messageId: existingAssistantId,
                      prependedMessageCount: 0,
                  };
        setPersistedTodoSyntheticAnchor(
            args.db,
            args.sessionId,
            part.callID,
            injection.messageId,
            args.sessionMeta.lastTodoState,
        );
        return injection.prependedMessageCount;
    }

    // A defer pass rebuilds from the persisted snapshot, never from live `last_todo_state`.
    // A real `todowrite` between passes cannot change the bytes.
    if (persistedAnchor && persistedAnchor.stateJson.length > 0) {
        const part = buildSyntheticTodoPart(persistedAnchor.stateJson);
        if (part !== null && part.callID === persistedAnchor.callId) {
            return injectPersistedTodoAnchor(
                args.messages,
                args.sessionId,
                persistedAnchor.messageId,
                part,
            ).prependedMessageCount;
        }
    }
    return 0;
}

/**
 * Replay canonicalizes native Rust output before restoring host-owned anchors.
 * The persisted compaction summary uses the TypeScript lane's canonicalizer.
 * The TypeScript lane canonicalizes the summary before note and recall anchors are replayed onto the native result.
 */
export function runRustModePostprocess(args: {
    db: ContextDatabase;
    sessionId: string;
    messages: MessageLike[];
    projectPath?: string;
    fullFeatureMode: boolean;
    compactionOff?: boolean;
    tagger: Tagger;
    ctxReduceAvailability: CtxReduceAvailabilityVerdict;
}): void {
    if (!args.fullFeatureMode || args.compactionOff) return;
    // Test doubles and older integrations may return the legacy bare message shape.
    // The host-side sticky phase applies only to OpenCode `MessageLike` objects.
    // The sticky phase leaves legacy bare message responses unchanged.
    if (
        args.messages.some(
            (message) =>
                !message ||
                typeof message !== "object" ||
                !isRecord((message as { info?: unknown }).info),
        )
    ) {
        return;
    }
    reconcileMarkerRepresentation(
        args.messages,
        getPersistedCompactionMarkerState(args.db, args.sessionId),
        {
            db: args.db,
            sessionId: args.sessionId,
            tagger: args.tagger,
            ctxReduceAvailability: args.ctxReduceAvailability,
        },
    );
    for (const anchor of getNoteNudgeAnchors(args.db, args.sessionId)) {
        appendReminderToUserMessageById(args.messages, anchor.messageId, anchor.text);
    }
    for (const decision of getAutoSearchHintDecisions(args.db, args.sessionId)) {
        // Anti-memory warnings require a fresh search; they never replay stored hint text.
        // Anti-memory decisions without warning fragments can replay.
        if (
            decision.decision === "hint" &&
            autoSearchHintFragmentsStillEligible(args.db, decision.memoryFragments)
        ) {
            appendReminderToUserMessageById(args.messages, decision.messageId, decision.text);
        }
    }

    const currentUserMessageId = findLastUserMessageId(args.messages);
    const noteReadStillVisible = hasVisibleNoteReadCall(args.messages);
    const deferredNoteText = peekNoteNudgeText(
        args.db,
        args.sessionId,
        currentUserMessageId,
        args.projectPath,
        noteReadStillVisible,
    );
    if (!deferredNoteText) return;
    const instruction = `\n\n<instruction name="deferred_notes">${deferredNoteText}</instruction>`;
    const anchoredMessageId = findLastUserMessageId(args.messages);
    const outcome = markNoteNudgeDelivered(args.db, args.sessionId, instruction, anchoredMessageId);
    if (anchoredMessageId && outcome.ok) {
        appendReminderToUserMessageById(args.messages, anchoredMessageId, instruction);
    } else if (anchoredMessageId && !outcome.ok) {
        sessionLog(args.sessionId, `rust note-nudge delivery skipped wire append: ${outcome.kind}`);
    }
}

function dropMarkerSummaryTag(
    db: ContextDatabase,
    sessionId: string,
    summaryMessageId: string,
): void {
    const tagNumber = getTagNumberByMessageId(db, sessionId, `${summaryMessageId}:p0`);
    if (tagNumber !== null) updateTagStatus(db, sessionId, tagNumber, "dropped");
}

/**
 * The transform replays the persisted marker on every pass so output does not depend on live marker state.
 *
 * OpenCode projects a completed summary immediately before the retained tail.
 * The summary must follow the contiguous synthetic head to preserve OpenCode's retained-tail ordering.
 * Rebuilding from persisted state removes stale summaries before inserting the persisted summary.
 */
export function reconcileMarkerRepresentation(
    messages: MessageLike[],
    persistedMarkerState: PersistedCompactionMarkerState | null,
    options: {
        db: ContextDatabase;
        sessionId: string;
        tagger: Tagger;
        ctxReduceAvailability: CtxReduceAvailabilityVerdict;
    },
): boolean {
    const retainedMessages: MessageLike[] = [];
    const staleSummaryIds = new Set<string>();
    for (const message of messages) {
        if (message.info.summary !== true) {
            retainedMessages.push(message);
            continue;
        }
        const messageId = message.info.id;
        if (typeof messageId === "string" && messageId !== persistedMarkerState?.summaryMessageId) {
            staleSummaryIds.add(messageId);
        }
    }
    if (staleSummaryIds.size > 0) {
        options.db.transaction(() => {
            for (const messageId of staleSummaryIds) {
                dropMarkerSummaryTag(options.db, options.sessionId, messageId);
            }
        })();
    }

    const removedSummary = retainedMessages.length !== messages.length;
    if (removedSummary) messages.splice(0, messages.length, ...retainedMessages);
    if (persistedMarkerState === null) return removedSummary;

    const summaryTagNumber = options.tagger.assignTag(
        options.sessionId,
        `${persistedMarkerState.summaryMessageId}:p0`,
        "message",
        byteSize(MARKER_SUMMARY_TEXT),
        options.db,
        0,
        null,
        0,
        null,
        () => ({
            tokenCount: estimateTokens(MARKER_SUMMARY_TEXT),
            inputTokenCount: null,
            reasoningTokenCount: null,
        }),
    );
    const summaryText =
        options.ctxReduceAvailability.frozen && options.ctxReduceAvailability.callable
            ? prependTag(summaryTagNumber, MARKER_SUMMARY_TEXT)
            : MARKER_SUMMARY_TEXT;
    const summaryMessage: MessageLike = {
        info: {
            id: persistedMarkerState.summaryMessageId,
            role: "assistant",
            sessionID: options.sessionId,
            summary: true,
            finish: "stop",
        },
        parts: [{ type: "text", text: summaryText }],
    };

    let retainedTailStart = 0;
    while (
        retainedTailStart < messages.length &&
        isSyntheticHeadMessage(messages[retainedTailStart])
    ) {
        retainedTailStart += 1;
    }
    messages.splice(retainedTailStart, 0, summaryMessage);
    return true;
}

function pendingMarkerCoveredByConsumedBoundary(
    pending: PendingCompactionMarker,
    injection: PreparedCompartmentInjection | null,
): boolean {
    if (!injection) return false;
    if (pending.endMessageId === injection.compartmentEndMessageId) return true;
    return pending.ordinal <= injection.compartmentEndMessage;
}

export function clearPendingCompactionMarkerAfterSuccessfulDrain(args: {
    db: ContextDatabase;
    sessionId: string;
    pending: PendingCompactionMarker;
    deferredHistoryRefreshSessions: Set<string>;
}): DeferredCompactionMarkerClearOutcome {
    if (clearPendingCompactionMarkerStateIf(args.db, args.sessionId, args.pending)) {
        return "cleared";
    }

    const latestPending = getPendingCompactionMarkerState(args.db, args.sessionId);
    if (latestPending) {
        args.deferredHistoryRefreshSessions.add(args.sessionId);
        sessionLog(
            args.sessionId,
            "compaction-marker drain: CAS-clear failed because a newer pending blob exists; preserving deferred history refresh signal",
        );
        return "cas-lost-newer-pending";
    }

    sessionLog(
        args.sessionId,
        "compaction-marker drain: CAS-clear failed but no pending blob remains; another drain already cleared it",
    );
    return "cas-lost-already-cleared";
}

interface RunPostTransformPhaseArgs {
    sessionId: string;
    db: ContextDatabase;
    messages: MessageLike[];
    tags: TagEntry[];
    targets: Map<number, TagTarget>;
    reasoningByMessage: Map<MessageLike, { type: string; thinking?: string; text?: string }[]>;
    messageTagNumbers: Map<MessageLike, number>;
    tagger: Tagger;
    ctxReduceAvailability: CtxReduceAvailabilityVerdict;
    /* */
    channel1StateBySession?: Map<string, Channel1State>;
    /**
     * */
    todowriteAvailability: ToolAvailabilityVerdict;
    /* */
    client?: PluginContext["client"];
    /* */
    activeAgent?: string;
    batch: { finalize: () => void } | null;
    contextUsage: { percentage: number; inputTokens: number };
    schedulerDecision: "execute" | "defer";
    fullFeatureMode: boolean;
    /**
     */
    compactionOff?: boolean;
    canRunCompartments: boolean;
    awaitedCompartmentRun: boolean;
    phaseJustAwaitedPublication: boolean;
    compartmentInProgress: boolean;
    historyRefreshExplicitBeforePrepare: boolean;
    deferredHistoryWasPendingAtPassStart: boolean;
    compartmentInjectionRebuiltFromDb: boolean;
    rebuiltHistoryFromInitialPrepare: boolean;
    historyRebuiltThisPass: boolean;
    canConsumeDeferredLate: boolean;
    sessionMeta: SessionMeta;
    currentTurnId: string | null;
    /**
     * Persistent signal that pending ops + heuristics need to materialize.
     * Survives across defer passes when `compartmentRunning` blocks the
     * heuristic pass. Drained ONLY after `shouldRunHeuristics` succeeds —
     * preserving `/ctx-flush` intent across blocked passes is the entire
     * reason for the three-set split (see the lifetime notes on
     * `hook-handlers.ts`).
     */
    pendingMaterializationSessions: Set<string>;
    deferredHistoryRefreshSessions: Set<string>;
    deferredMaterializationSessions: Set<string>;
    lastHeuristicsTurnId: Map<string, string>;
    clearReasoningAge: number;
    protectedTags: number;
    /**
     */
    emergencyCeilingTokens?: number;
    pendingCompartmentInjection: PreparedCompartmentInjection | null;
    didMutateFromFlushedStatuses: boolean;
    watermark: number;
    forceMaterializationPercentage: number;
    hasRecentReduceCall: boolean;
    projectPath?: string;
    sessionDirectory?: string;
    /**
     * */
    autoSearch?: {
        enabled: boolean;
        scoreThreshold: number;
        minPromptChars: number;
        directory?: string;
        ensureProjectRegistered?: (directory: string, db: ContextDatabase) => Promise<void>;
    };
    /**
     */
    cavemanTextCompression?: {
        enabled: boolean;
        minChars: number;
    };
    /**
     */
    smartDrops?: boolean;
    /**
     */
    resolvedProviderID?: string;
    passOutcome?: PassOutcome;
    historyRefreshSessions?: Set<string>;
    m0M1?: {
        projectPath?: string;
        projectDirectory?: string;
        injectDocs?: boolean;
        memoryInjectionBudgetTokens?: number;
        historyBudgetTokens?: number;
        temporalAwareness?: boolean;
        hardSignals?: M0HardSignals;
        /**
         * */
        muralEnabled?: boolean;
    };
}

export interface PostTransformPhaseResult {
    explicitMaterializedSuccessfully: boolean;
    deferredMaterializedSuccessfully: boolean;
    materialized: boolean;
    /* */
    historianFoldMaterializedThisPass: boolean;
    materializeReason: string | null;
    droppedTokens: number;
    emergencyReclaimedTokens: number;
    droppedCount: number;
    emergency: boolean;
    bustedThisPass: boolean;
}

export interface ConfirmedAbortClient {
    session?: {
        abort?: (input: {
            path: { id: string };
            throwOnError: true;
        }) => Promise<{ data?: boolean; error?: unknown }>;
    };
}

export async function abortSessionFailClosed(
    client: ConfirmedAbortClient,
    sessionId: string,
): Promise<void> {
    if (typeof client.session?.abort !== "function") {
        throw new Error("OpenCode session.abort is unavailable");
    }
    const result = await client.session.abort({
        path: { id: sessionId },
        throwOnError: true,
    });
    if (result.data !== true) {
        throw new Error(
            `OpenCode session.abort was not confirmed: ${JSON.stringify(result.error ?? result.data)}`,
        );
    }
}

export interface EmergencyFailClosedDecision {
    shouldAbort: boolean;
    reason:
        | "below-emergency-band"
        | "provider-overflow-abort"
        | "proceed"
        | "trusted-final-wire-disarm";
    /** The caller may clear its durable latch only with trusted current-pass wire evidence. */
    disarm?: { finalWireTokens: number; provenLimitTokens: number };
}

export function evaluateEmergencyFailClosed(input: {
    usagePercentage: number;
    emergencyRecoveryArmed: boolean;
    emergencyRecoveryOrigin: "provider_overflow" | "proactive_model_shrink" | null;
    foldMaterializedThisPass: boolean;
    finalWireEstimate?: { tokens: number; trusted: boolean };
    /** providerProvenLimitTokens comes only from a provider overflow response, never a catalog fallback. */
    providerProvenLimitTokens?: number;
}): EmergencyFailClosedDecision {
    const estimate = input.finalWireEstimate;
    const limit = input.providerProvenLimitTokens;
    if (
        input.emergencyRecoveryArmed &&
        estimate?.trusted === true &&
        typeof limit === "number" &&
        Number.isFinite(limit) &&
        limit > 0 &&
        estimate.tokens < limit * 0.8
    ) {
        return {
            shouldAbort: false,
            reason: "trusted-final-wire-disarm",
            disarm: { finalWireTokens: estimate.tokens, provenLimitTokens: limit },
        };
    }
    if (input.usagePercentage < 95) {
        return { shouldAbort: false, reason: "below-emergency-band" };
    }
    // Only the provider's own rejection proves that a messages.transform turn shape overflows.
    // Local numeric estimates remain telemetry until module-side accounting reproduces provider-accurate framing.
    const shouldAbort =
        input.emergencyRecoveryArmed &&
        input.emergencyRecoveryOrigin === "provider_overflow" &&
        !input.foldMaterializedThisPass;
    return {
        shouldAbort,
        reason: shouldAbort ? "provider-overflow-abort" : "proceed",
    };
}

export function finalizeMessageRepresentation(
    messages: MessageLike[],
    resolvedProviderID?: string,
    options?: {
        prependedMessageCount?: number;
        reasoningMutatedMessages?: Iterable<MessageLike>;
        reasoningMutationExemptMessage?: MessageLike;
        mergedReasoningStrippedIds?: ReadonlySet<string>;
        trailingBlankDecisions?: ReadonlyMap<string, TrailingBlankDecision>;
        skipMergedReasoningStrip?: boolean;
        skipTrailingWhitespaceStrip?: boolean;
    },
): { clearedParts: number; mergedReasoningParts: number } {
    let clearedParts = 0;
    if (modelAcceptsEmptyContent(resolvedProviderID)) {
        const prependedMessageCount = Math.min(
            messages.length,
            Math.max(0, options?.prependedMessageCount ?? 0),
        );
        const targetedMessages = options ? messages.slice(0, prependedMessageCount) : messages;
        if (options?.reasoningMutatedMessages) {
            const seen = new Set(targetedMessages);
            for (const message of options.reasoningMutatedMessages) {
                if (!seen.has(message)) {
                    seen.add(message);
                    targetedMessages.push(message);
                }
            }
        }
        if (targetedMessages.length > 0) {
            clearedParts = stripClearedReasoning(targetedMessages);
        }
    }
    let newestAssistant = options?.reasoningMutationExemptMessage;
    if (!newestAssistant) {
        for (let index = messages.length - 1; index >= 0; index -= 1) {
            const message = messages[index];
            if (message.info.role !== "assistant") continue;
            newestAssistant = message;
            break;
        }
    }
    const mergedReasoningParts = options?.skipMergedReasoningStrip
        ? 0
        : stripReasoningFromMergedAssistants(messages, resolvedProviderID, {
              mutationExemptMessage: options?.reasoningMutationExemptMessage,
              frozenMessageIds: options?.mergedReasoningStrippedIds,
          });
    if (!options?.skipTrailingWhitespaceStrip && modelAcceptsEmptyContent(resolvedProviderID)) {
        applyFrozenTrailingBlankDecisions(
            messages,
            typeof newestAssistant?.info.id === "string" ? newestAssistant.info.id : undefined,
            options?.trailingBlankDecisions ?? new Map(),
        );
    }
    return { clearedParts, mergedReasoningParts };
}

export async function runPostTransformPhase(
    args: RunPostTransformPhaseArgs,
): Promise<PostTransformPhaseResult> {
    const compactionOff = args.compactionOff === true;
    let reasoningMutationExemptMessage: MessageLike | undefined;
    for (let index = args.messages.length - 1; index >= 0; index -= 1) {
        const message = args.messages[index];
        if (message.info.role !== "assistant") continue;
        reasoningMutationExemptMessage = message;
        break;
    }
    const pendingMaterializationAtPassStart = args.pendingMaterializationSessions.has(
        args.sessionId,
    );
    const deferredMaterializationAtPassStart = args.deferredMaterializationSessions.has(
        args.sessionId,
    );
    const isExplicitFlush = pendingMaterializationAtPassStart;
    const deferredMaterializationWasPending = deferredMaterializationAtPassStart;
    const alreadyRanThisTurn =
        args.currentTurnId !== null &&
        args.lastHeuristicsTurnId.get(args.sessionId) === args.currentTurnId;
    const forceMaterialization =
        args.fullFeatureMode &&
        !compactionOff &&
        args.contextUsage.percentage >= args.forceMaterializationPercentage;
    const emergencyDropEligible =
        !compactionOff && args.contextUsage.percentage >= args.forceMaterializationPercentage;
    const activeCompartmentRun = args.canRunCompartments
        ? getActiveCompartmentRun(args.sessionId)
        : undefined;
    const compartmentRunning =
        args.canRunCompartments &&
        !args.awaitedCompartmentRun &&
        activeCompartmentRun !== undefined;
    const deferredMaterialize = args.canConsumeDeferredLate && deferredMaterializationWasPending;
    const materializationRequested = isExplicitFlush || deferredMaterialize;
    // A HARD decision alone is not a cache bust. Execute it off-wire first, then
    // let pending drops and heuristics ride the bust only when persistence reports
    // that m[0] actually materialized. A contention fallback or failed attempt
    // leaves the mutation gates closed, preserving byte-identical defer replay.
    // injectM0M1 still rechecks later, so a cross-process marker bump after this
    // pre-execution can fold safely without retroactively authorizing mutations.
    // Re-gated for compaction-off mode: injection runs when the
    // memory/docs identity is present AND (fullFeatureMode || compactionOff),
    // so the mode cannot swallow m[0]/m[1] delivery — and a compaction-off
    // SUBAGENT session receives the additive blocks too (injectM0M1's
    // isSubagent skip is lifted by the same flag).
    const m0M1EnabledForFold =
        args.m0M1 !== undefined &&
        (!!args.m0M1.projectPath || !!args.m0M1.projectDirectory) &&
        (args.fullFeatureMode || compactionOff);
    const foldDueDecision =
        m0M1EnabledForFold && args.m0M1
            ? mustMaterialize({
                  db: args.db,
                  sessionId: args.sessionId,
                  state: args.sessionMeta as M0M1State,
                  projectPath: args.m0M1.projectPath,
                  projectDirectory: args.m0M1.projectDirectory,
                  injectDocs: args.m0M1.injectDocs,
                  muralEnabled: args.m0M1.muralEnabled,
                  memoryInjectionBudgetTokens: args.m0M1.memoryInjectionBudgetTokens,
                  historyBudgetTokens: args.m0M1.historyBudgetTokens,
                  hardSignals: args.m0M1.hardSignals,
              })
            : { value: false, reason: null };
    let foldExecutedThisPass = false;
    let m0RematerializedThisPass = false;
    const m0CoverageBeforeFold =
        args.sessionMeta.cachedM0Bytes === null ? -1 : args.sessionMeta.cachedM0MaxCompartmentSeq;
    let m0MaterializeReason: string | null = null;
    if (foldDueDecision.value && args.m0M1) {
        try {
            const foldResult = injectM0M1({
                db: args.db,
                sessionId: args.sessionId,
                state: args.sessionMeta as M0M1State,
                projectPath: args.m0M1.projectPath,
                projectDirectory: args.m0M1.projectDirectory,
                injectDocs: args.m0M1.injectDocs,
                memoryInjectionBudgetTokens: args.m0M1.memoryInjectionBudgetTokens,
                historyBudgetTokens: args.m0M1.historyBudgetTokens,
                temporalAwareness: args.m0M1.temporalAwareness,
                isCacheBustingPass: true,
                hardSignals: args.m0M1.hardSignals,
                muralEnabled: args.m0M1.muralEnabled,
                compactionOff,
            });
            foldExecutedThisPass = foldExecutesThisPass(
                foldDueDecision.value,
                foldResult.m0RematerializedThisPass,
            );
            m0RematerializedThisPass = foldResult.m0RematerializedThisPass;
            m0MaterializeReason = foldResult.decision.reason;
            try {
                rearmChannel2AfterCoverageAdvancingHardFold({
                    db: args.db,
                    sessionId: args.sessionId,
                    foldExecuted: foldExecutedThisPass,
                    compactionOff,
                    previousCoverage: m0CoverageBeforeFold,
                    currentCoverage: args.sessionMeta.cachedM0MaxCompartmentSeq,
                });
            } catch (error) {
                sessionLog(args.sessionId, "channel2 fold-cycle reset failed (ignored):", error);
            }
        } catch (error) {
            args.passOutcome?.record("m0-m1-fold-preexecution-degradation");
            sessionLog(
                args.sessionId,
                "transform: m[0] HARD fold pre-execution failed:",
                getErrorMessage(error),
            );
        }
        sessionLog(
            args.sessionId,
            `m[0] HARD fold decision: reason=${foldDueDecision.reason ?? "unknown"} executed=${foldExecutedThisPass}`,
        );
    }
    const bypassCompartmentGate = forceMaterialization || foldExecutedThisPass;
    const shouldReadPendingOps =
        !compactionOff &&
        (materializationRequested ||
            args.schedulerDecision === "execute" ||
            forceMaterialization ||
            foldExecutedThisPass ||
            compartmentRunning);
    const pendingOps = shouldReadPendingOps ? getPendingOps(args.db, args.sessionId) : [];
    const hasPendingUserOps = pendingOps.length > 0;
    const shouldApplyPendingOps =
        !compactionOff &&
        (args.schedulerDecision === "execute" ||
            materializationRequested ||
            forceMaterialization ||
            foldExecutedThisPass) &&
        (!compartmentRunning || bypassCompartmentGate);
    // needing historian/compartments.
    //
    //
    const shouldRunHeuristics =
        !compactionOff &&
        (!compartmentRunning || bypassCompartmentGate) &&
        (materializationRequested ||
            forceMaterialization ||
            foldExecutedThisPass ||
            emergencyDropEligible ||
            (args.schedulerDecision === "execute" &&
                (!alreadyRanThisTurn || !args.fullFeatureMode)));
    //
    //
    //
    const isCacheBustingPass = shouldApplyPendingOps || shouldRunHeuristics;
    if (
        isCacheBustingPass &&
        args.client &&
        args.ctxReduceAvailability.callable &&
        !hasLoggedCtxReducePermissionDeny(args.sessionId)
    ) {
        try {
            const denied = await resolveToolPermissionDenied(
                args.client,
                args.sessionId,
                "ctx_reduce",
                args.activeAgent,
            );
            if (denied) {
                markCtxReducePermissionDenyLogged(args.sessionId);
                sessionLog(
                    args.sessionId,
                    "ctx_reduce permission is denied by OpenCode; frozen guidance remains until session restart",
                );
            }
        } catch (error) {
            sessionLog(args.sessionId, "ctx_reduce permission read failed (ignored):", error);
        }
    }
    const canUseEmptySentinels = modelAcceptsEmptyContent(args.resolvedProviderID);
    if (shouldRunHeuristics) {
        const subagentRerun =
            !args.fullFeatureMode &&
            alreadyRanThisTurn &&
            args.schedulerDecision === "execute" &&
            !isExplicitFlush &&
            !forceMaterialization;
        const reason = isExplicitFlush
            ? "explicit_flush"
            : deferredMaterialize
              ? "deferred_materialization"
              : forceMaterialization
                ? `force_materialization (${args.contextUsage.percentage.toFixed(1)}% >= ${args.forceMaterializationPercentage}%)`
                : foldExecutedThisPass && args.schedulerDecision !== "execute"
                  ? `m0_hard_fold (drain folded into executed m[0] bust, scheduler=${args.schedulerDecision})`
                  : subagentRerun
                    ? `scheduler_execute_subagent_rerun (pendingOps=${pendingOps.length}, scheduler=${args.schedulerDecision})`
                    : `scheduler_execute (pendingOps=${pendingOps.length}, scheduler=${args.schedulerDecision})`;
        sessionLog(
            args.sessionId,
            `heuristics WILL RUN — reason=${reason}, context=${args.contextUsage.percentage.toFixed(1)}%, turn=${args.currentTurnId}`,
        );
    }
    if (
        alreadyRanThisTurn &&
        args.schedulerDecision === "execute" &&
        !materializationRequested &&
        args.fullFeatureMode
    ) {
        sessionLog(
            args.sessionId,
            `transform: skipping heuristics (already ran for turn ${args.currentTurnId})`,
        );
    }
    if (compartmentRunning && hasPendingUserOps) {
        if (bypassCompartmentGate) {
            const bypassReason = forceMaterialization
                ? `emergency >=${args.forceMaterializationPercentage}%`
                : "m0 hard fold";
            sessionLog(
                args.sessionId,
                `transform: compartment-gate bypass (${bypassReason}) — applying ${pendingOps.length} pending ops while compartment agent runs (${args.contextUsage.percentage.toFixed(1)}%)`,
            );
        } else {
            sessionLog(
                args.sessionId,
                "transform: deferring pending ops — compartment agent in progress",
            );
        }
    }
    let explicitMaterializedSuccessfully = false;
    let deferredMaterializedSuccessfully = false;
    let heuristicsRanSuccessfully = false;
    let pendingOpsRanSuccessfully = false;
    let pendingOpsDidMutate = false;
    let heuristicOrReasoningDidMutate = false;
    let droppedCount = 0;
    const droppedTokens = 0;
    let emergencyReclaimedTokens = 0;
    let emergency = false;
    let m0M1InjectedThisPass = false;
    let prependedMessageCount = 0;
    const reasoningMutatedMessages = new Set<MessageLike>();
    let reasoningMutationTargetUnknown = false;
    if (args.didMutateFromFlushedStatuses) {
        for (const target of args.targets.values()) {
            if (target.message) reasoningMutatedMessages.add(target.message);
            else reasoningMutationTargetUnknown = true;
        }
    }
    let autoReclaimDidMutateThisPass = false;
    try {
        if (shouldApplyPendingOps) {
            const applyReason = isExplicitFlush
                ? "explicit_flush"
                : deferredMaterialize
                  ? "deferred_materialization"
                  : foldExecutedThisPass && args.schedulerDecision !== "execute"
                    ? `m0_hard_fold (drain folded into executed m[0] bust, scheduler=${args.schedulerDecision})`
                    : `scheduler_execute (scheduler=${args.schedulerDecision})`;
            sessionLog(
                args.sessionId,
                `pending ops WILL APPLY — reason=${applyReason}, pendingOps=${pendingOps.length}, context=${args.contextUsage.percentage.toFixed(1)}%`,
            );
            const tApply = performance.now();
            pendingOpsDidMutate = applyPendingOperations(
                args.sessionId,
                args.db,
                args.targets,
                args.protectedTags,
                undefined,
                pendingOps,
            );
            if (pendingOpsDidMutate) {
                droppedCount += pendingOps.length;
                for (const pendingOp of pendingOps) {
                    const message = args.targets.get(pendingOp.tagId)?.message;
                    if (message) reasoningMutatedMessages.add(message);
                    else reasoningMutationTargetUnknown = true;
                }
            }
            logTransformTiming(args.sessionId, "applyPendingOperations", tApply);
        }
        if (shouldRunHeuristics) {
            const t5 = performance.now();
            const cavemanConfig = args.cavemanTextCompression?.enabled
                ? {
                      enabled: true,
                      minChars: args.cavemanTextCompression.minChars,
                  }
                : undefined;
            const heuristicTags = shouldApplyPendingOps
                ? getActiveTagsBySession(args.db, args.sessionId)
                : args.tags;
            // Emergency floor math must use the post-operation active tag set.
            const cleanup = applyHeuristicCleanup(
                args.sessionId,
                args.db,
                args.targets,
                args.messageTagNumbers,
                {
                    protectedTags: args.protectedTags,
                    emergency:
                        emergencyDropEligible &&
                        args.emergencyCeilingTokens !== undefined &&
                        args.emergencyCeilingTokens > 0
                            ? {
                                  currentTotalInputTokens: args.contextUsage.inputTokens,
                                  ceilingTokens: args.emergencyCeilingTokens,
                              }
                            : undefined,
                    caveman: cavemanConfig,
                },
                heuristicTags,
            );
            logTransformTiming(
                args.sessionId,
                "applyHeuristicCleanup",
                t5,
                `droppedTools=${cleanup.droppedTools} deduplicatedTools=${cleanup.deduplicatedTools} droppedInjections=${cleanup.droppedInjections} compressedTextTags=${cleanup.compressedTextTags} mutatedTextTags=${cleanup.mutatedTextTags}`,
            );
            const heuristicMutationCount =
                cleanup.droppedTools +
                cleanup.deduplicatedTools +
                cleanup.droppedInjections +
                cleanup.mutatedTextTags;
            droppedCount +=
                cleanup.droppedTools +
                cleanup.deduplicatedTools +
                cleanup.droppedInjections +
                cleanup.mutatedTextTags;
            emergency ||= cleanup.emergencyDroppedTools > 0;
            emergencyReclaimedTokens += cleanup.emergencyReclaimedTokens;
            const t7 = performance.now();
            const clearedReasoning = canUseEmptySentinels
                ? clearOldReasoning(
                      args.messages,
                      args.reasoningByMessage,
                      args.messageTagNumbers,
                      args.clearReasoningAge,
                  )
                : 0;
            if (canUseEmptySentinels) {
                stripClearedReasoning(args.messages);
            }
            const strippedInline = stripInlineThinking(
                args.messages,
                args.messageTagNumbers,
                args.clearReasoningAge,
            );
            if (clearedReasoning > 0 || strippedInline > 0) {
                let maxTag = 0;
                for (const tag of args.messageTagNumbers.values()) {
                    if (tag > maxTag) maxTag = tag;
                }
                const newWatermark = maxTag - args.clearReasoningAge;
                const currentWatermark = args.sessionMeta?.clearedReasoningThroughTag ?? 0;
                if (newWatermark > currentWatermark) {
                    updateSessionMeta(args.db, args.sessionId, {
                        clearedReasoningThroughTag: newWatermark,
                    });
                    args.sessionMeta.clearedReasoningThroughTag = newWatermark;
                    sessionLog(
                        args.sessionId,
                        `reasoning cleanup: cleared=${clearedReasoning} inlineStripped=${strippedInline} watermark=${currentWatermark}→${newWatermark}`,
                    );
                } else {
                    sessionLog(
                        args.sessionId,
                        `reasoning cleanup: cleared=${clearedReasoning} inlineStripped=${strippedInline} watermark=${currentWatermark} (unchanged)`,
                    );
                }
            }
            logTransformTiming(args.sessionId, "clearOldReasoning", t7);
            heuristicOrReasoningDidMutate =
                heuristicMutationCount + clearedReasoning + strippedInline > 0;
            droppedCount += clearedReasoning + strippedInline;
            if (pendingMaterializationAtPassStart) {
                args.pendingMaterializationSessions.delete(args.sessionId);
            }
            if (args.currentTurnId) {
                args.lastHeuristicsTurnId.set(args.sessionId, args.currentTurnId);
            }
        }
        if (args.schedulerDecision === "execute" && !materializationRequested) {
            updateSessionMeta(args.db, args.sessionId, { lastResponseTime: Date.now() });
        }

        const toolReclaimExecutePass = !compactionOff && args.schedulerDecision === "execute";
        const alreadyMutatingThisPass = pendingOpsDidMutate || heuristicOrReasoningDidMutate;
        let autoReclaimTargetCount = 0;
        let autoReclaimDidMutate = false;
        if (toolReclaimExecutePass && alreadyMutatingThisPass && !emergencyDropEligible) {
            const syntheticPendingOps = buildSyntheticToolReclaimOps({
                db: args.db,
                sessionId: args.sessionId,
                targets: args.targets,
                watermark: args.sessionMeta.toolReclaimWatermark ?? 0,
                pendingOps,
            });
            const editMarkerTagIds = new Set<number>();
            if (args.smartDrops) {
                const selectedIds = new Set(syntheticPendingOps.map((op) => op.tagId));
                const supersessionOps = buildSupersessionReclaimOps({
                    db: args.db,
                    sessionId: args.sessionId,
                    targets: args.targets,
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
                    targets: args.targets,
                    pendingOps,
                });
                for (const op of editReclaim.ops) {
                    // strictly more).
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
                    args.targets,
                    args.protectedTags,
                    undefined,
                    [],
                    syntheticPendingOps,
                    editMarkerTagIds,
                );
                if (autoReclaimDidMutate) {
                    droppedCount += syntheticPendingOps.length;
                    autoReclaimDidMutateThisPass = true;
                    for (const pendingOp of syntheticPendingOps) {
                        const message = args.targets.get(pendingOp.tagId)?.message;
                        if (message) reasoningMutatedMessages.add(message);
                        else reasoningMutationTargetUnknown = true;
                    }
                }
            }
        }
        args.batch?.finalize();
        if (toolReclaimExecutePass) {
            const maxTagNumber = advanceToolReclaimWatermarkToCurrentMax(args.db, args.sessionId);
            args.sessionMeta.toolReclaimWatermark = Math.max(
                args.sessionMeta.toolReclaimWatermark ?? 0,
                maxTagNumber,
            );
        }
        if (autoReclaimTargetCount > 0) {
            sessionLog(
                args.sessionId,
                `tool reclaim auto-drop: targets=${autoReclaimTargetCount} mutated=${autoReclaimDidMutate}`,
            );
        }
        logTransformTiming(args.sessionId, "batchFinalize:heuristics", performance.now());
        if (args.sessionMeta.lastTransformError !== null) {
            updateSessionMeta(args.db, args.sessionId, { lastTransformError: null });
        }
        if (shouldRunHeuristics) {
            if (isExplicitFlush) explicitMaterializedSuccessfully = true;
            if (deferredMaterialize) deferredMaterializedSuccessfully = true;
            heuristicsRanSuccessfully = true;
        }
        if (shouldApplyPendingOps) {
            pendingOpsRanSuccessfully = true;
        }
    } catch (error) {
        args.passOutcome?.record("pending-operation-failure");
        sessionLog(args.sessionId, "transform failed applying pending operations:", error);
        updateSessionMeta(args.db, args.sessionId, { lastTransformError: getErrorMessage(error) });
    }

    // placeholder replay:
    if (canUseEmptySentinels && !compactionOff) {
        try {
            const t8 = performance.now();
            const frozenStaleReduceIds = getStaleReduceStrippedIds(args.db, args.sessionId);
            const staleReduceResult = dropStaleReduceCalls(args.messages, frozenStaleReduceIds, {
                detect: isCacheBustingPass,
                protectedCount: args.protectedTags,
            });
            if (isCacheBustingPass && staleReduceResult.newlyStrippedIds.length > 0) {
                addStaleReduceStrippedIds(
                    args.db,
                    args.sessionId,
                    staleReduceResult.newlyStrippedIds,
                );
            }
            logTransformTiming(args.sessionId, "dropStaleReduceCalls", t8);
        } catch (error) {
            args.passOutcome?.record("stale-reduce-strip-exception");
            sessionLog(args.sessionId, "transform failed dropping stale ctx_reduce calls:", error);
        }
    }

    if (canUseEmptySentinels && !compactionOff) {
        try {
            const tImg = performance.now();
            const frozenImageIds = getProcessedImageStrippedIds(args.db, args.sessionId);
            const imageResult = stripProcessedImages(args.messages, frozenImageIds, {
                detect: isCacheBustingPass && args.watermark > 0,
                watermark: args.watermark,
                messageTagNumbers: args.messageTagNumbers,
            });
            if (isCacheBustingPass && imageResult.newlyStrippedIds.length > 0) {
                addProcessedImageStrippedIds(args.db, args.sessionId, imageResult.newlyStrippedIds);
            }
            logTransformTiming(args.sessionId, "stripProcessedImages", tImg);
        } catch (error) {
            args.passOutcome?.record("image-strip-exception");
            sessionLog(args.sessionId, "transform failed stripping processed images:", error);
        }
    }

    const m0M1Enabled = m0M1EnabledForFold;
    if (m0M1Enabled && args.m0M1) {
        const tInjectM0M1 = performance.now();
        try {
            const result = injectM0M1({
                db: args.db,
                sessionId: args.sessionId,
                messages: args.messages,
                state: args.sessionMeta as M0M1State,
                projectPath: args.m0M1.projectPath,
                projectDirectory: args.m0M1.projectDirectory,
                injectDocs: args.m0M1.injectDocs,
                memoryInjectionBudgetTokens: args.m0M1.memoryInjectionBudgetTokens,
                historyBudgetTokens: args.m0M1.historyBudgetTokens,
                temporalAwareness: args.m0M1.temporalAwareness,
                isCacheBustingPass,
                hardSignals: args.m0M1.hardSignals,
                muralEnabled: args.m0M1.muralEnabled,
                compactionOff,
            });
            if (result.injected) {
                m0M1InjectedThisPass = true;
                prependedMessageCount += result.prependedMessageCount;
                m0RematerializedThisPass ||= result.m0RematerializedThisPass;
                m0MaterializeReason = result.decision.reason ?? m0MaterializeReason;
                sessionLog(
                    args.sessionId,
                    `transform: injected m[0]/m[1] (rematerialized=${result.m0RematerializedThisPass}, reason=${result.decision.reason ?? "cache_hit"})`,
                );
            }
        } catch (error) {
            args.passOutcome?.record("m0-m1-injection-degradation");
            sessionLog(
                args.sessionId,
                "transform: m[0]/m[1] injection failed:",
                getErrorMessage(error),
            );
            if (args.pendingCompartmentInjection) {
                try {
                    const fallbackResult = renderCompartmentInjection(
                        args.sessionId,
                        args.messages,
                        args.pendingCompartmentInjection,
                    );
                    prependedMessageCount += fallbackResult.prependedMessageCount;
                    sessionLog(
                        args.sessionId,
                        "transform: rendered legacy <session-history> fallback after m[0]/m[1] failure",
                    );
                } catch (fallbackError) {
                    args.passOutcome?.record("m0-m1-fallback-failure", "fatal");
                    sessionLog(
                        args.sessionId,
                        "transform: legacy fallback injection also failed:",
                        getErrorMessage(fallbackError),
                    );
                }
            }
            clearInjectionCache(args.sessionId);
        }
        logTransformTiming(args.sessionId, "pp.injectM0M1", tInjectM0M1);
    } else if (args.fullFeatureMode && !compactionOff && args.pendingCompartmentInjection) {
        const compartmentResult = renderCompartmentInjection(
            args.sessionId,
            args.messages,
            args.pendingCompartmentInjection,
        );
        if (compartmentResult.injected) {
            prependedMessageCount += compartmentResult.prependedMessageCount;
            if (compartmentResult.compartmentCount > 0) {
                sessionLog(
                    args.sessionId,
                    `transform: injected ${compartmentResult.compartmentCount} compartments ` +
                        `(covering raw messages 1-${compartmentResult.compartmentEndMessage}, ` +
                        `skipped ${compartmentResult.skippedVisibleMessages} visible messages)`,
                );
            } else {
                sessionLog(
                    args.sessionId,
                    "transform: injected memories/facts block (no compartments yet)",
                );
            }
        }
    }

    //
    //
    //
    if (!compactionOff) {
        const tPlaceholder = performance.now();
        const persistedIds = getStrippedPlaceholderIds(args.db, args.sessionId);

        if (persistedIds.size > 0) {
            const { replayed, missingIds } = replaySentinelByMessageIds(
                args.messages,
                persistedIds,
                args.resolvedProviderID,
            );
            if (replayed > 0) {
                sessionLog(
                    args.sessionId,
                    `sentinel replay: neutralized ${replayed} previously-stripped messages`,
                );
            }
            if (missingIds.length > 0) {
                for (const id of missingIds) persistedIds.delete(id);
                applyStrippedPlaceholderDelta(args.db, args.sessionId, { remove: missingIds });
            }
        }

        if (isCacheBustingPass) {
            const droppedResult = stripDroppedPlaceholderMessages(
                args.messages,
                args.resolvedProviderID,
            );
            const protectedTailStart = Math.max(0, args.messages.length - args.protectedTags * 2);
            const systemInjectedResult = stripSystemInjectedMessages(
                args.messages,
                protectedTailStart,
                args.resolvedProviderID,
            );

            const newlyNeutralized =
                droppedResult.sentineledIds.length + systemInjectedResult.sentineledIds.length;

            if (newlyNeutralized > 0) {
                const addedIds = [
                    ...droppedResult.sentineledIds,
                    ...systemInjectedResult.sentineledIds,
                ];
                for (const id of addedIds) persistedIds.add(id);
                applyStrippedPlaceholderDelta(args.db, args.sessionId, { add: addedIds });
                sessionLog(
                    args.sessionId,
                    `neutralized ${droppedResult.stripped} dropped + ${systemInjectedResult.stripped} system-injected messages (${newlyNeutralized} new, ${persistedIds.size} total persisted)`,
                );
            }
        }
        logTransformTiming(args.sessionId, "pp.placeholderNeutralize", tPlaceholder);
    }


    const tNudgeBlock = performance.now();

    if (args.fullFeatureMode && !compactionOff) {
        for (const anchor of getNoteNudgeAnchors(args.db, args.sessionId)) {
            appendReminderToUserMessageById(args.messages, anchor.messageId, anchor.text);
        }
        for (const decision of getAutoSearchHintDecisions(args.db, args.sessionId)) {
            if (
                decision.decision === "hint" &&
                autoSearchHintFragmentsStillEligible(args.db, decision.memoryFragments)
            ) {
                appendReminderToUserMessageById(args.messages, decision.messageId, decision.text);
            }
        }
    }

    logTransformTiming(args.sessionId, "pp.nudgeAndSticky", tNudgeBlock);

    const explicitRebuildHappened =
        args.historyRefreshExplicitBeforePrepare && args.rebuiltHistoryFromInitialPrepare;
    const materializationSatisfied =
        !deferredMaterializationWasPending ||
        explicitMaterializedSuccessfully ||
        deferredMaterializedSuccessfully;
    const historyWasConsumedThisPass =
        args.historyRebuiltThisPass &&
        (args.canConsumeDeferredLate ||
            args.phaseJustAwaitedPublication ||
            explicitRebuildHappened) &&
        materializationSatisfied;

    let suppressV12HistoryDrain = false;
    if (historyWasConsumedThisPass && args.deferredHistoryWasPendingAtPassStart) {
        const pending = getPendingCompactionMarkerState(args.db, args.sessionId);
        if (pending) {
            if (
                !pendingMarkerCoveredByConsumedBoundary(pending, args.pendingCompartmentInjection)
            ) {
                suppressV12HistoryDrain = true;
                sessionLog(
                    args.sessionId,
                    `compaction-marker drain: pending ordinal ${pending.ordinal} is newer than consumed boundary ${args.pendingCompartmentInjection?.compartmentEndMessage ?? "<none>"}; preserving deferred history refresh signal`,
                );
            } else {
                const outcome = applyDeferredCompactionMarker(
                    args.db,
                    args.sessionId,
                    pending,
                    args.sessionDirectory,
                );
                switch (outcome.kind) {
                    case "applied":
                    case "already-current":
                    case "stale-skip":
                        if (
                            clearPendingCompactionMarkerAfterSuccessfulDrain({
                                db: args.db,
                                sessionId: args.sessionId,
                                pending,
                                deferredHistoryRefreshSessions: args.deferredHistoryRefreshSessions,
                            }) === "cas-lost-newer-pending"
                        ) {
                            suppressV12HistoryDrain = true;
                        }
                        break;
                    case "retryable-failure":
                        args.passOutcome?.record("compaction-marker-drain-failure");
                        sessionLog(
                            args.sessionId,
                            "compaction-marker drain: retryable failure; preserving deferred history refresh signal",
                            outcome.error,
                        );
                        suppressV12HistoryDrain = true;
                        break;
                }
            }
        }
    }

    if (!compactionOff) {
        reconcileMarkerRepresentation(
            args.messages,
            getPersistedCompactionMarkerState(args.db, args.sessionId),
            {
                db: args.db,
                sessionId: args.sessionId,
                tagger: args.tagger,
                ctxReduceAvailability: args.ctxReduceAvailability,
            },
        );
    }

    const deferredHistoryDrainEligible =
        historyWasConsumedThisPass &&
        args.deferredHistoryWasPendingAtPassStart &&
        !suppressV12HistoryDrain;
    if (deferredHistoryDrainEligible) {
        args.deferredHistoryRefreshSessions.delete(args.sessionId);
    }
    if (
        (explicitMaterializedSuccessfully || deferredMaterializedSuccessfully) &&
        deferredMaterializationAtPassStart
    ) {
        args.deferredMaterializationSessions.delete(args.sessionId);
    }

    const tNoteAndTodo = performance.now();
    const noteReadStillVisible = args.fullFeatureMode
        ? hasVisibleNoteReadCall(args.messages)
        : false;
    const deferredNoteText = args.fullFeatureMode
        ? peekNoteNudgeText(
              args.db,
              args.sessionId,
              args.currentTurnId,
              args.projectPath,
              noteReadStillVisible,
          )
        : null;
    if (deferredNoteText) {
        const noteInstruction = `\n\n<instruction name="deferred_notes">${deferredNoteText}</instruction>`;
        const anchoredMessageId = findLastUserMessageId(args.messages);
        const outcome = markNoteNudgeDelivered(
            args.db,
            args.sessionId,
            noteInstruction,
            anchoredMessageId,
        );
        if (anchoredMessageId && outcome.ok) {
            appendReminderToUserMessageById(args.messages, anchoredMessageId, noteInstruction);
        } else if (anchoredMessageId && !outcome.ok) {
            args.passOutcome?.record("note-nudge-cas-failure");
            sessionLog(args.sessionId, `note-nudge delivery skipped wire append: ${outcome.kind}`);
        }
    }

    if (args.fullFeatureMode && !compactionOff) {
        prependedMessageCount += await applyTodoSynthesis({
            db: args.db,
            sessionId: args.sessionId,
            messages: args.messages,
            fullFeatureMode: args.fullFeatureMode,
            compactionOff,
            isCacheBustingPass,
            sessionMeta: args.sessionMeta,
            todowriteAvailability: args.todowriteAvailability,
            client: args.client,
            activeAgent: args.activeAgent,
        });
    }

    logTransformTiming(args.sessionId, "pp.noteAndTodoSynthesis", tNoteAndTodo);

    // council).
    if (args.compartmentInjectionRebuiltFromDb && args.pendingCompartmentInjection) {
        if (args.pendingCompartmentInjection.compartmentEndMessageId === null) {
            const nextCount = (degradedCacheCountBySession.get(args.sessionId) ?? 0) + 1;
            degradedCacheCountBySession.set(args.sessionId, nextCount);
            if (nextCount === DEGRADE_CACHE_WARNING_THRESHOLD) {
                sessionLog(
                    args.sessionId,
                    `WARNING: compartment injection cache has rebuilt with a degraded null boundary ${nextCount} consecutive times; investigate missing boundary messages`,
                );
            }
        } else {
            degradedCacheCountBySession.delete(args.sessionId);
        }
    }

    if (
        args.fullFeatureMode &&
        isCacheBustingPass &&
        args.m0M1 &&
        (!!args.m0M1.projectPath || !!args.m0M1.projectDirectory)
    ) {
        checkM0MutationDriftAndSignal({
            db: args.db,
            sessionId: args.sessionId,
            cachedM0MaxMutationId: args.sessionMeta.cachedM0MaxMutationId,
            pendingMaterializationSessions: args.pendingMaterializationSessions,
            historyRefreshSessions: args.historyRefreshSessions,
        });
    }

    const workExecutedSuccessfully =
        explicitMaterializedSuccessfully ||
        deferredMaterializedSuccessfully ||
        heuristicsRanSuccessfully ||
        pendingOpsRanSuccessfully;


    if (workExecutedSuccessfully) {
        try {
            const currentFlag = peekDeferredExecutePending(args.db, args.sessionId);
            if (currentFlag !== null) {
                const cleared = clearDeferredExecutePendingIfMatches(
                    args.db,
                    args.sessionId,
                    currentFlag,
                );
                sessionLog(
                    args.sessionId,
                    `[boundary-exec] deferred-execute drain: ${cleared ? "cleared" : "stale-noop"} reason=${currentFlag.reason}`,
                );
            }
        } catch (err) {
            args.passOutcome?.record("deferred-execute-drain-failure");
            sessionLog(args.sessionId, `[boundary-exec] drain failed (continuing): ${err}`);
        }
    }

    if (args.fullFeatureMode && args.autoSearch?.enabled && args.projectPath) {
        const tAutoSearch = performance.now();
        try {
            const autoSearchOutcome = await runAutoSearchHint({
                sessionId: args.sessionId,
                db: args.db,
                messages: args.messages,
                options: {
                    enabled: true,
                    scoreThreshold: args.autoSearch.scoreThreshold,
                    minPromptChars: args.autoSearch.minPromptChars,
                    directory: args.autoSearch.directory ?? args.sessionDirectory,
                    projectPath: args.projectPath,
                    ensureProjectRegistered: args.autoSearch.ensureProjectRegistered,
                },
            });
            if (!autoSearchOutcome.ok) {
                args.passOutcome?.record(`auto-search-${autoSearchOutcome.kind}`);
            }
        } catch (error) {
            args.passOutcome?.record("auto-search-internal-failure");
            sessionLog(args.sessionId, "auto-search runner failed:", error);
        }
        logTransformTiming(args.sessionId, "pp.autoSearchHint", tAutoSearch);
    }

    if (args.fullFeatureMode && isCacheBustingPass) {
        const visibleIds = new Set<string>();
        for (const message of args.messages) {
            if (typeof message.info?.id === "string") {
                visibleIds.add(message.info.id);
            }
        }
        const prunedAnchors = pruneNoteNudgeAnchors(args.db, args.sessionId, visibleIds);
        const prunedDecisions = pruneAutoSearchHintDecisions(args.db, args.sessionId, visibleIds);
        if (prunedAnchors > 0 || prunedDecisions > 0) {
            sessionLog(
                args.sessionId,
                `sticky-injection GC: pruned ${prunedAnchors} note-nudge anchor(s), ${prunedDecisions} auto-search decision(s)`,
            );
        }
    }

    const materializeReason =
        m0MaterializeReason ?? (explicitMaterializedSuccessfully ? "explicit_flush" : null);
    const materialized =
        m0RematerializedThisPass ||
        explicitMaterializedSuccessfully ||
        deferredMaterializedSuccessfully;
    let bustedThisPass =
        args.didMutateFromFlushedStatuses ||
        pendingOpsDidMutate ||
        heuristicOrReasoningDidMutate ||
        autoReclaimDidMutateThisPass ||
        m0RematerializedThisPass ||
        (m0M1InjectedThisPass && historyWasConsumedThisPass) ||
        historyWasConsumedThisPass;

    //
    if (reasoningMutationTargetUnknown) {
        const reasoningCandidates =
            args.reasoningByMessage.size > 0 ? args.reasoningByMessage.keys() : args.messages;
        for (const message of reasoningCandidates) {
            const hasClearedReasoning = message.parts.some((part) => {
                if (part === null || typeof part !== "object") return false;
                const candidate = part as { type?: unknown; thinking?: unknown; text?: unknown };
                if (candidate.type !== "reasoning" && candidate.type !== "thinking") return false;
                return candidate.thinking === "[cleared]" || candidate.text === "[cleared]";
            });
            if (hasClearedReasoning) reasoningMutatedMessages.add(message);
        }
    }

    const mergedReasoningStrippedIds = new Set<string>();
    if (canUseEmptySentinels && !compactionOff) {
        try {
            for (const id of getMergedReasoningStrippedIds(args.db, args.sessionId)) {
                mergedReasoningStrippedIds.add(id);
            }
            if (isCacheBustingPass) {
                const candidates = findMergedReasoningStripCandidateIds(
                    args.messages,
                    args.resolvedProviderID,
                    { mutationExemptMessage: reasoningMutationExemptMessage },
                );
                const newlyDetectedIds = candidates.filter(
                    (id) => !mergedReasoningStrippedIds.has(id),
                );
                if (newlyDetectedIds.length > 0) {
                    const persisted = addMergedReasoningStrippedIds(
                        args.db,
                        args.sessionId,
                        newlyDetectedIds,
                    );
                    if (persisted) {
                        for (const id of newlyDetectedIds) mergedReasoningStrippedIds.add(id);
                        bustedThisPass = true;
                    } else {
                        args.passOutcome?.record("merged-reasoning-strip-persistence-failure");
                        sessionLog(
                            args.sessionId,
                            "merged reasoning strip: persistence failed; leaving newly detected assistants intact",
                        );
                    }
                }
            }
        } catch (error) {
            args.passOutcome?.record("merged-reasoning-strip-exception");
            sessionLog(args.sessionId, "transform failed freezing merged reasoning strip:", error);
        }
    }

    const trailingBlankDecisions = new Map<string, TrailingBlankDecision>();
    if (canUseEmptySentinels && !compactionOff) {
        try {
            for (const [id, decision] of getTrailingBlankDecisions(args.db, args.sessionId)) {
                trailingBlankDecisions.set(id, decision);
            }
        } catch (error) {
            args.passOutcome?.record("trailing-blank-decision-load-exception");
            sessionLog(args.sessionId, "transform failed loading trailing blank decisions:", error);
        }
    }

    const newestAssistantId =
        typeof reasoningMutationExemptMessage?.info.id === "string"
            ? reasoningMutationExemptMessage.info.id
            : undefined;
    const tFinalRepresentation = performance.now();
    const finalRepresentation = finalizeMessageRepresentation(
        args.messages,
        args.resolvedProviderID,
        {
            prependedMessageCount,
            reasoningMutatedMessages,
            reasoningMutationExemptMessage,
            mergedReasoningStrippedIds,
            trailingBlankDecisions,
            skipMergedReasoningStrip: compactionOff,
            skipTrailingWhitespaceStrip: compactionOff,
        },
    );

    if (canUseEmptySentinels && !compactionOff) {
        const detectedCandidates = findTrailingBlankDecisionCandidates(
            args.messages,
            trailingBlankDecisions,
            { refreshMessageId: newestAssistantId },
        );
        const candidates = isCacheBustingPass
            ? detectedCandidates
            : detectedCandidates.filter(([id]) => id === newestAssistantId);
        if (candidates.length > 0) {
            try {
                const persisted = addTrailingBlankDecisions(args.db, args.sessionId, candidates, {
                    overwriteMessageId: newestAssistantId,
                });
                if (persisted) {
                    const committed = getTrailingBlankDecisions(args.db, args.sessionId);
                    const newlyFrozen = new Map<string, TrailingBlankDecision>();
                    for (const [id] of candidates) {
                        const decision = committed.get(id);
                        if (!decision) continue;
                        trailingBlankDecisions.set(id, decision);
                        newlyFrozen.set(id, decision);
                    }
                    applyFrozenTrailingBlankDecisions(
                        args.messages,
                        newestAssistantId,
                        newlyFrozen,
                    );
                    if (isCacheBustingPass) bustedThisPass = true;
                } else {
                    args.passOutcome?.record("trailing-blank-decision-persistence-failure");
                    sessionLog(
                        args.sessionId,
                        "trailing blank decision: persistence failed; leaving newly observed assistants intact",
                    );
                }
            } catch (error) {
                args.passOutcome?.record("trailing-blank-decision-exception");
                sessionLog(
                    args.sessionId,
                    "transform failed freezing trailing blank decision:",
                    error,
                );
            }
        }
    }

    sessionLog(
        args.sessionId,
        `final representation: clearedParts=${finalRepresentation.clearedParts} mergedReasoningParts=${finalRepresentation.mergedReasoningParts}`,
    );
    logTransformTiming(
        args.sessionId,
        "finalizeMessageRepresentation",
        tFinalRepresentation,
        `clearedParts=${finalRepresentation.clearedParts} mergedReasoningParts=${finalRepresentation.mergedReasoningParts}`,
    );

    let assertedBaseline:
        | {
              tags: TagEntry[];
              protectedTags: number;
              contentSignature: string;
              structuralSignature: TailHygieneStructuralSignature;
          }
        | undefined;
    if (args.channel1StateBySession) {
        if (args.ctxReduceAvailability.callable && !compactionOff) {
            try {
                const tags = getTailHygieneTags(args.db, args.sessionId);
                const previous = args.channel1StateBySession.get(args.sessionId);
                const baseline = refreshTailHygieneBaseline({
                    messages: args.messages,
                    tags,
                    protectedTags: args.protectedTags,
                    cacheBusting: bustedThisPass,
                    previous,
                });
                const structuralSignature = tailHygieneStructuralSignature(args.messages);
                args.channel1StateBySession.set(args.sessionId, {
                    ...baseline,
                    reducedSinceRefresh:
                        baseline.baselineGeneration !== previous?.baselineGeneration
                            ? false
                            : (previous?.reducedSinceRefresh ?? false),
                    oldestReclaimableToolTags: getOldestActiveUnprotectedToolTags(
                        args.db,
                        args.sessionId,
                        args.protectedTags,
                    ),
                });
                try {
                    rearmChannel2AfterMeasuredCollapse({
                        db: args.db,
                        sessionId: args.sessionId,
                        baseline,
                    });
                } catch (error) {
                    sessionLog(
                        args.sessionId,
                        "channel2 U-collapse reset failed (ignored):",
                        error,
                    );
                }
                assertedBaseline = {
                    tags,
                    protectedTags: args.protectedTags,
                    contentSignature: baseline.contentSignature,
                    structuralSignature,
                };
            } catch (error) {
                const stale = args.channel1StateBySession.get(args.sessionId);
                if (stale) {
                    stale.evaluable = false;
                    stale.generationInvalidated = true;
                }
                sessionLog(args.sessionId, "tail hygiene baseline refresh failed (held):", error);
            }
        } else {
            args.channel1StateBySession.delete(args.sessionId);
        }
    }
    if (assertedBaseline) {
        try {
            const servedSignature = tailHygieneStructuralSignature(args.messages);
            if (
                !sameTailHygieneStructuralSignature(
                    assertedBaseline.structuralSignature,
                    servedSignature,
                )
            ) {
                sessionLog(
                    args.sessionId,
                    `ERROR [tail-hygiene-last-writer-mismatch]: served messages changed after tail-hygiene baseline refresh (expected messages=${assertedBaseline.structuralSignature.messageCount}, parts=[${assertedBaseline.structuralSignature.partCounts.join(",")}], bytes=${assertedBaseline.structuralSignature.totalBytes}; actual messages=${servedSignature.messageCount}, parts=[${servedSignature.partCounts.join(",")}], bytes=${servedSignature.totalBytes})`,
                );
            }
        } catch (error) {
            sessionLog(
                args.sessionId,
                "ERROR [tail-hygiene-last-writer-check-failed]: structural production guard failed open:",
                error,
            );
        }
        if (process.env.NODE_ENV !== "production") {
            assertTailHygieneContentUnchanged({
                messages: args.messages,
                tags: assertedBaseline.tags,
                protectedTags: assertedBaseline.protectedTags,
                expectedSignature: assertedBaseline.contentSignature,
            });
        }
    }

    return {
        explicitMaterializedSuccessfully,
        deferredMaterializedSuccessfully,
        materialized,
        historianFoldMaterializedThisPass: historyWasConsumedThisPass,
        materializeReason,
        droppedTokens,
        emergencyReclaimedTokens,
        droppedCount,
        emergency,
        bustedThisPass,
    };
}

export function checkM0MutationDriftAndSignal(args: {
    db: ContextDatabase;
    sessionId: string;
    cachedM0MaxMutationId: number | null;
    pendingMaterializationSessions: Set<string>;
    historyRefreshSessions?: Set<string>;
}): boolean {
    const currentMaxMutationId = getMaxM0MutationId(args.db, args.sessionId) ?? 0;
    const cachedMaxMutationId = args.cachedM0MaxMutationId ?? 0;
    if (currentMaxMutationId !== cachedMaxMutationId) {
        args.pendingMaterializationSessions.add(args.sessionId);
        args.historyRefreshSessions?.add(args.sessionId);
        sessionLog(
            args.sessionId,
            `m[0] drift watcher: mutation id changed ${cachedMaxMutationId} → ${currentMaxMutationId}; scheduling next-pass materialization`,
        );
        return true;
    }
    return false;
}
