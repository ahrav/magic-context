import {
    getLastCompartmentEndMessage,
    getLastCompartmentEndMessageId,
} from "../../features/magic-context/compartment-storage";
import { type ContextDatabase, updateSessionMeta } from "../../features/magic-context/storage";
import type { ContextUsage } from "../../features/magic-context/types";
import type { PluginContext } from "../../plugin/types";
import { sessionLog } from "../../shared/logger";
import {
    type ActiveCompartmentRun,
    getActiveCompartmentRun,
    startCompartmentAgent,
} from "./compartment-runner";
import { BLOCK_UNTIL_DONE_PERCENTAGE } from "./compartment-trigger";
import {
    type PreparedCompartmentInjection,
    prepareCompartmentInjection,
} from "./inject-compartments";
import {
    getRawHistoryEligibility,
    hasRunnableCompartmentWindow,
    type ProtectedTailBoundarySnapshot,
    resolveOpenCodeProtectedTailBoundary,
} from "./protected-tail-boundary";
import { primeTailRawMessageCache, withRawSessionMessageCache } from "./read-session-chunk";
import { sendIgnoredMessage } from "./send-session-notification";
import type { MessageLike } from "./transform-operations";

interface RunCompartmentPhaseArgs {
    canRunCompartments: boolean;
    fullFeatureMode: boolean;
    /** Compaction-off mode: no historian start, no 95% block,
     *  no boundary resolution — the phase degrades to a stale-flag cleanup. */
    compactionOff?: boolean;
    /** `historianRunnable` is false when `historian.disable=true`, which blocks historian-backed child agents. */
    historianRunnable?: boolean;
    sessionMeta: { compartmentInProgress: boolean };
    contextUsage: { percentage: number };
    boundaryContextLimit: number;
    boundaryExecuteThresholdPercentage: number;
    boundaryUsage: ContextUsage;
    boundaryUsageSource: "live" | "persisted" | "provisional-zero" | "manual-none";
    client?: PluginContext["client"];
    db: ContextDatabase;
    sessionId: string;
    resolvedSessionId: string;
    historianChunkTokens: number;
    historyBudgetTokens?: number;
    historianTimeoutMs?: number;
    fallbackModels?: readonly string[];
    compartmentDirectory: string;
    messages: MessageLike[];
    pendingCompartmentInjection: PreparedCompartmentInjection | null;
    fallbackModelId?: string;
    ensureProjectRegistered?: (directory: string, db: ContextDatabase) => Promise<void>;
    projectPath?: string;
    injectionBudgetTokens?: number;
    getNotificationParams?: () => import("./send-session-notification").NotificationParams;
    /* */
    safeForBackgroundCompression?: boolean;
    deferredHistoryRefreshSessions: Set<string>;
    /** `skipAwaitForThisPass` is true after transform-triggered recovery or emergency historian work. */
    skipAwaitForThisPass?: boolean;
    /** `experimentalUserMemories` extracts user-behavior observations from historian output. */
    experimentalUserMemories?: boolean;
    /** `experimentalTemporalAwareness` injects wall-clock dates into compartments in `<session-history>`. */
    experimentalTemporalAwareness?: boolean;
    /** `historianTwoPass` runs a second editor pass after historian processing to remove `U:` lines. */
    historianTwoPass?: boolean;
    /** Cross-session memory feature gate (`memory.enabled`). */
    memoryEnabled?: boolean;
    /** Auto-promotion gate (`memory.auto_promote`). */
    autoPromote?: boolean;
    /** `onCompartmentStatePublished` forwards state-publication notifications to the compartment runner. */
    onCompartmentStatePublished?: (sessionId: string) => void;
    /**
     * `preResolvedBoundarySnapshot` was resolved by this pass's trigger decision.
     * When runnable, `preResolvedBoundarySnapshot` comes from the transform-located trigger.
     * A runnable `preResolvedBoundarySnapshot` prevents a second boundary resolution in the pass.
     * The historian uses the same boundary snapshot that triggered it.
     * The ≥80% emergency re-scale fallback re-resolves the boundary when `preResolvedBoundarySnapshot` has no runnable window.
     */
    preResolvedBoundarySnapshot?: ProtectedTailBoundarySnapshot;
}

/**
 *
 * `getRawHistoryEligibility`, `resolveOpenCodeProtectedTailBoundary`, and `readSessionChunk` read raw OpenCode history.
 * An unprimed raw-history read is O(session) and blocks the transform thread.
 * OpenCode awaits `messages.transform` before the LLM call, so raw-history reads block the request.
 * `getUnsummarizedTailInfo` primes only its own raw-message-cache scope.
 * The `withRawSessionMessageCache` scope in `getUnsummarizedTailInfo` ends when the trigger returns.
 * The phase would otherwise read raw history without the trigger's cache.
 *
 * `primeTailRawMessageCache` must read raw history rather than the in-memory `args.messages` tail.
 * `extractInMemoryMessageViews` aliases live `parts` objects from `args.messages`.
 * The transform mutates those `parts` objects between the trigger and this phase.
 * The transform can replace `§N§` prefixes, insert `[dropped]` sentinels, and strip reasoning from live `parts`.
 * `primeTailRawMessageCache` reads raw content because the DB read is unmutated and O(tail).
 *
 * `runCompartmentPhaseImpl` reaches its first `await` only on the ≥95% blocking path.
 * `readSessionChunk` runs before the runner's first `await`, `client.session.get`.
 * `try/finally` clears the cache when the wrapped function returns its promise.
 * `try/finally` clears the cache when the wrapped function returns its promise, after the function suspends at its first `await`.
 * Only `prepareCompartmentInjection` runs after the first `await`.
 * `prepareCompartmentInjection` reads `context.db`, never raw history.
 * `resolvedSessionId` (transform.ts).
 */
export function runCompartmentPhase(
    args: RunCompartmentPhaseArgs,
): ReturnType<typeof runCompartmentPhaseImpl> {
    // `runCompartmentPhase` primes only passes that start or block on a historian run.
    // Normal defer passes perform no raw reads.
    // Priming normal defer passes would add a tail DB read to every defer pass on a large session.
    // When `compartmentInProgress` is set and no run is active, this pass resolves the boundary and the runner reads the chunk.
    // The emergency block force-starts when usage is at least 95% and awaiting is allowed.
    // `compartmentInProgress` remains true while a background run is active.
    // An active run owns `compartmentInProgress`; the implementation no-ops while it is active.
    // The active-run guard prevents re-priming on every pass while a background run is active.
    const historianRunnable = args.historianRunnable !== false;
    const willReadRawHistory =
        historianRunnable &&
        !args.compactionOff &&
        args.canRunCompartments &&
        getActiveCompartmentRun(args.sessionId) === undefined &&
        (args.sessionMeta.compartmentInProgress ||
            (!args.skipAwaitForThisPass &&
                args.contextUsage.percentage >= BLOCK_UNTIL_DONE_PERCENTAGE));

    if (!willReadRawHistory) {
        return runCompartmentPhaseImpl(args);
    }

    return withRawSessionMessageCache(() => {
        try {
            primeTailRawMessageCache({
                sessionId: args.resolvedSessionId,
                lastCompartmentEnd: getLastCompartmentEndMessage(args.db, args.resolvedSessionId),
                anchorMessageId: getLastCompartmentEndMessageId(args.db, args.resolvedSessionId),
            });
        } catch (error) {
            // A `primeTailRawMessageCache` failure falls back to the full read without blocking the phase.
            sessionLog(args.sessionId, "compartment phase: tail prime failed (non-fatal):", error);
        }
        return runCompartmentPhaseImpl(args);
    });
}

async function runCompartmentPhaseImpl(args: RunCompartmentPhaseArgs): Promise<{
    pendingCompartmentInjection: PreparedCompartmentInjection | null;
    awaitedCompartmentRun: boolean;
    compartmentInProgress: boolean;
    published: boolean;
    justAwaitedPublication: boolean;
    rebuiltHistoryThisPass: boolean;
}> {
    let pendingCompartmentInjection = args.pendingCompartmentInjection;
    let compartmentInProgress = args.sessionMeta.compartmentInProgress;
    let published = false;
    let justAwaitedPublication = false;
    let rebuiltHistoryThisPass = false;
    const historianRunnable = args.historianRunnable !== false;

    // Compaction-off mode: the historian/compartment phase is
    // fully gated off — no fires, no boundary resolution, no await. A stale
    // compartmentInProgress flag (a run interrupted before the flip) is
    // cleared so the session state is honest and flip-back starts clean.
    if (args.compactionOff) {
        if (args.sessionMeta.compartmentInProgress) {
            sessionLog(
                args.sessionId,
                "transform: compaction off; clearing stale compartmentInProgress flag",
            );
            updateSessionMeta(args.db, args.sessionId, { compartmentInProgress: false });
            compartmentInProgress = false;
        }
        return {
            pendingCompartmentInjection,
            awaitedCompartmentRun: false,
            compartmentInProgress,
            published,
            justAwaitedPublication,
            rebuiltHistoryThisPass,
        };
    }
    let rawEligibility: ReturnType<typeof getRawHistoryEligibility> | null = null;
    let lastObservedCompartmentEnd = -1;
    let cachedBoundarySnapshot: ProtectedTailBoundarySnapshot | null = null;

    function hasNewRawHistoryForCompartment(): boolean {
        if (!args.fullFeatureMode || !historianRunnable) return false;
        if (rawEligibility === null) {
            rawEligibility = getRawHistoryEligibility(args.db, args.resolvedSessionId);
            lastObservedCompartmentEnd = rawEligibility.lastCompartmentEnd;
        }
        return rawEligibility.hasRawBeyondLastCompartment;
    }

    function resolveBoundarySnapshot(
        emergencyTailScale?: 0.5 | 0.25,
    ): ProtectedTailBoundarySnapshot {
        return resolveOpenCodeProtectedTailBoundary({
            db: args.db,
            sessionId: args.resolvedSessionId,
            mode: "transform-force",
            contextLimit: args.boundaryContextLimit,
            executeThresholdPercentage: args.boundaryExecuteThresholdPercentage,
            usage: args.boundaryUsage,
            usageSource: args.boundaryUsageSource,
            emergencyTailScale,
        });
    }

    function getBoundarySnapshotForCompartment(): ProtectedTailBoundarySnapshot | null {
        if (!hasNewRawHistoryForCompartment()) return null;
        if (cachedBoundarySnapshot === null) {
            let snapshot =
                args.preResolvedBoundarySnapshot &&
                hasRunnableCompartmentWindow(args.preResolvedBoundarySnapshot)
                    ? args.preResolvedBoundarySnapshot
                    : resolveBoundarySnapshot();
            if (!hasRunnableCompartmentWindow(snapshot) && args.contextUsage.percentage >= 80) {
                snapshot = resolveBoundarySnapshot(
                    args.contextUsage.percentage >= BLOCK_UNTIL_DONE_PERCENTAGE ? 0.25 : 0.5,
                );
            }
            cachedBoundarySnapshot = snapshot;
        }
        return cachedBoundarySnapshot;
    }

    const startCompartmentAgentWithPhaseArgs = (client: NonNullable<typeof args.client>): void => {
        startCompartmentAgent({
            client,
            db: args.db,
            sessionId: args.sessionId,
            historianChunkTokens: args.historianChunkTokens,
            boundarySnapshot: getBoundarySnapshotForCompartment() ?? undefined,
            currentContextLimit: args.boundaryContextLimit,
            historyBudgetTokens: args.historyBudgetTokens,
            historianTimeoutMs: args.historianTimeoutMs,
            fallbackModels: args.fallbackModels,
            directory: args.compartmentDirectory,
            fallbackModelId: args.fallbackModelId,
            ensureProjectRegistered: args.ensureProjectRegistered,
            getNotificationParams: args.getNotificationParams,
            experimentalUserMemories: args.experimentalUserMemories,
            historianTwoPass: args.historianTwoPass,
            memoryEnabled: args.memoryEnabled,
            autoPromote: args.autoPromote,
            onCompartmentStatePublished: args.onCompartmentStatePublished,
            preserveInjectionCacheUntilConsumed: true,
        });
    };

    function hasEligibleHistoryForCompartment(): boolean {
        const snapshot = getBoundarySnapshotForCompartment();
        return snapshot !== null && hasRunnableCompartmentWindow(snapshot);
    }

    async function awaitCompartmentRun(
        activeRun: ActiveCompartmentRun,
        reason: string,
    ): Promise<"completed" | "timed_out"> {
        sessionLog(args.sessionId, reason);
        const timeoutMs = args.historianTimeoutMs ?? 120_000; // 2 minutes default
        const timeout = new Promise<"timeout">((resolve) =>
            setTimeout(() => resolve("timeout"), timeoutMs),
        );
        const result = await Promise.race([activeRun.promise.then(() => "done" as const), timeout]);
        if (result === "timeout") {
            sessionLog(
                args.sessionId,
                `transform: compartment await timed out after ${timeoutMs}ms — proceeding without waiting`,
            );
            return "timed_out";
        }
        sessionLog(
            args.sessionId,
            "transform: compartment agent completed, refreshing compartment coverage",
        );
        justAwaitedPublication = activeRun.published;
        published = published || activeRun.published;
        const historyReprepareShouldBust =
            activeRun.published && args.deferredHistoryRefreshSessions.has(args.sessionId);
        pendingCompartmentInjection = prepareCompartmentInjection(
            args.db,
            args.resolvedSessionId,
            args.messages,
            historyReprepareShouldBust,
            args.projectPath,
            args.injectionBudgetTokens,
            args.experimentalTemporalAwareness,
        );
        if (historyReprepareShouldBust) {
            rebuiltHistoryThisPass = true;
        }
        return "completed";
    }

    if (!historianRunnable && args.sessionMeta.compartmentInProgress) {
        sessionLog(
            args.sessionId,
            "transform: historian disabled; clearing stale compartmentInProgress flag",
        );
        updateSessionMeta(args.db, args.sessionId, { compartmentInProgress: false });
        compartmentInProgress = false;
    }

    if (
        historianRunnable &&
        args.canRunCompartments &&
        args.sessionMeta.compartmentInProgress &&
        !getActiveCompartmentRun(args.sessionId)
    ) {
        if (!hasEligibleHistoryForCompartment()) {
            sessionLog(
                args.sessionId,
                `transform: skipping compartment start, no eligible history before protected tail (beyond ${lastObservedCompartmentEnd})`,
            );
            updateSessionMeta(args.db, args.sessionId, { compartmentInProgress: false });
            compartmentInProgress = false;
        } else if (!args.client) {
            sessionLog(args.sessionId, "transform: cannot start compartment agent without client");
            updateSessionMeta(args.db, args.sessionId, { compartmentInProgress: false });
            compartmentInProgress = false;
        } else {
            sessionLog(args.sessionId, "transform: compartmentInProgress flag set, starting agent");
            startCompartmentAgentWithPhaseArgs(args.client);
            compartmentInProgress = true;
        }
    }

    let awaitedCompartmentRun = false;

    if (
        historianRunnable &&
        args.canRunCompartments &&
        !args.skipAwaitForThisPass &&
        args.contextUsage.percentage >= BLOCK_UNTIL_DONE_PERCENTAGE
    ) {
        let activeRun = getActiveCompartmentRun(args.sessionId);
        if (!activeRun && hasEligibleHistoryForCompartment() && args.client) {
            sessionLog(
                args.sessionId,
                `transform: 95% reached (${args.contextUsage.percentage.toFixed(1)}%), force-starting compartment agent and blocking`,
            );
            startCompartmentAgentWithPhaseArgs(args.client);
            activeRun = getActiveCompartmentRun(args.sessionId);
        } else if (!activeRun && hasEligibleHistoryForCompartment()) {
            sessionLog(
                args.sessionId,
                "transform: cannot force-start compartment agent without client",
            );
        }
        if (activeRun) {
            //
            //
            if (args.client && !activeRun.notificationSent) {
                activeRun.notificationSent = true;
                const notifParams = args.getNotificationParams?.() ?? {};
                void sendIgnoredMessage(
                    args.client,
                    args.sessionId,
                    `⏳ Context at ${args.contextUsage.percentage.toFixed(0)}% — Magic Context is comparting history before continuing. This may take up to 2 minutes.`,
                    notifParams,
                );
            }
            const awaitResult = await awaitCompartmentRun(
                activeRun,
                `transform: blocking at ${args.contextUsage.percentage.toFixed(1)}% until compartment agent completes`,
            );
            if (awaitResult === "completed") {
                awaitedCompartmentRun = true;
                compartmentInProgress = false;
            } else {
                sessionLog(
                    args.sessionId,
                    "transform: proceeding after 95% timeout — historian still running in background",
                );
            }
        }
    }

    return {
        pendingCompartmentInjection,
        awaitedCompartmentRun,
        compartmentInProgress,
        published,
        justAwaitedPublication,
        rebuiltHistoryThisPass,
    };
}
