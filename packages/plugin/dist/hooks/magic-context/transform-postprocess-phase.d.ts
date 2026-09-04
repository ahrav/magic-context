import { type ContextDatabase, type PendingCompactionMarker } from "../../features/magic-context/storage";
import { type PersistedCompactionMarkerState } from "../../features/magic-context/storage-meta-persisted";
import type { Tagger } from "../../features/magic-context/tagger";
import type { SessionMeta, TagEntry } from "../../features/magic-context/types";
import type { PluginContext } from "../../plugin/types";
import type { CtxReduceAvailabilityVerdict, ToolAvailabilityVerdict } from "./ctx-reduce-availability";
import type { Channel1State } from "./ctx-reduce-nudge";
import { type M0HardSignals, type PreparedCompartmentInjection } from "./inject-compartments";
import type { PassOutcome } from "./pass-outcome";
import { type TrailingBlankDecision } from "./strip-content";
import { type MessageLike, type TagTarget } from "./transform-operations";
export declare function resetDegradedCacheCount(sessionId: string): void;
export type DeferredCompactionMarkerClearOutcome = "cleared" | "cas-lost-newer-pending" | "cas-lost-already-cleared";
/**
 * Apply the synthetic todowrite pair with cache-safe live permission checks.
 * Permission is refreshed only on a cache-busting pass; defer passes replay
 * the cached verdict and frozen bytes without consulting the SDK.
 */
export declare function applyTodoSynthesis(args: {
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
}): Promise<number>;
/**
 * Rebuild host-owned canonical representation after native Rust serving.
 * The persisted compaction summary is restored with the same canonicalizer as the
 * TypeScript lane, then note and recall anchors are replayed onto the native result.
 */
export declare function runRustModePostprocess(args: {
    db: ContextDatabase;
    sessionId: string;
    messages: MessageLike[];
    projectPath?: string;
    fullFeatureMode: boolean;
    compactionOff?: boolean;
    tagger: Tagger;
    ctxReduceAvailability: CtxReduceAvailabilityVerdict;
}): void;
/**
 * Replay the persisted marker representation on every pass.
 *
 * OpenCode projects a completed summary immediately before the retained tail.
 * The transform prepends synthetic history slots later, so the canonical array
 * position is after the contiguous synthetic head and before every real tail
 * message, regardless of role. Rebuilding from persisted state also removes
 * stale loser-process arrays and duplicate summaries deterministically.
 */
export declare function reconcileMarkerRepresentation(messages: MessageLike[], persistedMarkerState: PersistedCompactionMarkerState | null, options: {
    db: ContextDatabase;
    sessionId: string;
    tagger: Tagger;
    ctxReduceAvailability: CtxReduceAvailabilityVerdict;
}): boolean;
export declare function clearPendingCompactionMarkerAfterSuccessfulDrain(args: {
    db: ContextDatabase;
    sessionId: string;
    pending: PendingCompactionMarker;
    deferredHistoryRefreshSessions: Set<string>;
}): DeferredCompactionMarkerClearOutcome;
interface RunPostTransformPhaseArgs {
    sessionId: string;
    db: ContextDatabase;
    messages: MessageLike[];
    tags: TagEntry[];
    targets: Map<number, TagTarget>;
    reasoningByMessage: Map<MessageLike, {
        type: string;
        thinking?: string;
        text?: string;
    }[]>;
    messageTagNumbers: Map<MessageLike, number>;
    tagger: Tagger;
    ctxReduceAvailability: CtxReduceAvailabilityVerdict;
    /** Final-array counts of reclaimable tagged mass (U) and total eligible mass (T). */
    channel1StateBySession?: Map<string, Channel1State>;
    /** Frozen-per-session verdict for the native `todowrite` tool. Gates the
     *  synthetic todo-pair injection below: a session whose tools map filters
     *  todowrite out must not get a synthetic pair for a tool it cannot call. */
    todowriteAvailability: ToolAvailabilityVerdict;
    /** OpenCode SDK for live permission checks on cache-busting passes. */
    client?: PluginContext["client"];
    /** Active agent selected by the latest user message or hook input. */
    activeAgent?: string;
    batch: {
        finalize: () => void;
    } | null;
    contextUsage: {
        percentage: number;
        inputTokens: number;
    };
    schedulerDecision: "execute" | "defer";
    fullFeatureMode: boolean;
    /**
     * Compaction-off mode (issue #266), boot-resolved. Every mutating gate in
     * this phase becomes `existingGate && !compactionOff`; the m[0]/m[1]
     * injection gate is re-expressed as identity-present AND (fullFeatureMode
     * || compactionOff) so the mode keeps additive memory/docs delivery (and
     * extends it to subagent sessions, which gain the knowledge surface).
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
     * reason for the three-set split (see Oracle review 2026-04-26).
     */
    pendingMaterializationSessions: Set<string>;
    deferredHistoryRefreshSessions: Set<string>;
    deferredMaterializationSessions: Set<string>;
    lastHeuristicsTurnId: Map<string, string>;
    clearReasoningAge: number;
    protectedTags: number;
    /**
     * Ceiling for the tiered emergency drop = contextLimit × executeThreshold%.
     * Undefined when the context limit isn't resolved (cold start) — the
     * emergency drop then skips (the 95% block stays the backstop).
     */
    emergencyCeilingTokens?: number;
    pendingCompartmentInjection: PreparedCompartmentInjection | null;
    didMutateFromFlushedStatuses: boolean;
    watermark: number;
    forceMaterializationPercentage: number;
    hasRecentReduceCall: boolean;
    projectPath?: string;
    sessionDirectory?: string;
    /** Experimental auto-search: when enabled, runs ctx_search on the latest
     *  user prompt and appends a compact fragment hint. */
    autoSearch?: {
        enabled: boolean;
        scoreThreshold: number;
        minPromptChars: number;
        directory?: string;
        ensureProjectRegistered?: (directory: string, db: ContextDatabase) => Promise<void>;
    };
    /**
     * Age-tier caveman compression (experimental). Caller forwards this only
     * for primary sessions because subagent context is curated by the parent.
     * Passed through to `applyHeuristicCleanup`.
     */
    cavemanTextCompression?: {
        enabled: boolean;
        minChars: number;
    };
    /**
     * Smart-drops (experimental, default off): content-aware reclaim of tool
     * output that a later call supersedes. Runs alongside the age-based
     * auto-drop, only inside an execute pass that is already mutating, so it
     * never causes a cache bust on its own. Off → the messages sent to the model
     * are byte-identical to the age-based-only behavior.
     */
    smartDrops?: boolean;
    /**
     * Provider resolved once by the main transform for this pass. Used for every
     * empty-sentinel gate and whole-message placeholder choice so postprocess
     * cannot diverge from the main transform on cold DB-recovered passes.
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
        /** mural.enabled — drives the on-demand deterministic mural
         *  render inside the HARD fold. */
        muralEnabled?: boolean;
    };
}
export interface PostTransformPhaseResult {
    explicitMaterializedSuccessfully: boolean;
    deferredMaterializedSuccessfully: boolean;
    materialized: boolean;
    /** True only when this pass consumed newly folded historian history. */
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
            path: {
                id: string;
            };
            throwOnError: true;
        }) => Promise<{
            data?: boolean;
            error?: unknown;
        }>;
    };
}
export declare function abortSessionFailClosed(client: ConfirmedAbortClient, sessionId: string): Promise<void>;
export interface EmergencyFailClosedDecision {
    shouldAbort: boolean;
    reason: "below-emergency-band" | "provider-overflow-abort" | "proceed" | "trusted-final-wire-disarm";
    /** Trusted current-pass wire evidence that lets the caller clear its durable latch. */
    disarm?: {
        finalWireTokens: number;
        provenLimitTokens: number;
    };
}
export declare function evaluateEmergencyFailClosed(input: {
    usagePercentage: number;
    emergencyRecoveryArmed: boolean;
    emergencyRecoveryOrigin: "provider_overflow" | "proactive_model_shrink" | null;
    foldMaterializedThisPass: boolean;
    finalWireEstimate?: {
        tokens: number;
        trusted: boolean;
    };
    /** A current-model limit parsed from a provider overflow response, never a catalog fallback. */
    providerProvenLimitTokens?: number;
}): EmergencyFailClosedDecision;
export declare function finalizeMessageRepresentation(messages: MessageLike[], resolvedProviderID?: string, options?: {
    prependedMessageCount?: number;
    reasoningMutatedMessages?: Iterable<MessageLike>;
    reasoningMutationExemptMessage?: MessageLike;
    mergedReasoningStrippedIds?: ReadonlySet<string>;
    trailingBlankDecisions?: ReadonlyMap<string, TrailingBlankDecision>;
    skipMergedReasoningStrip?: boolean;
    skipTrailingWhitespaceStrip?: boolean;
}): {
    clearedParts: number;
    mergedReasoningParts: number;
};
export declare function runPostTransformPhase(args: RunPostTransformPhaseArgs): Promise<PostTransformPhaseResult>;
export declare function checkM0MutationDriftAndSignal(args: {
    db: ContextDatabase;
    sessionId: string;
    cachedM0MaxMutationId: number | null;
    pendingMaterializationSessions: Set<string>;
    historyRefreshSessions?: Set<string>;
}): boolean;
export {};
//# sourceMappingURL=transform-postprocess-phase.d.ts.map