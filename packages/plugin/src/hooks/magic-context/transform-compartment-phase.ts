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
    /** False when historian.disable=true, blocking historian-backed child agents. */
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
    /** True when this pass is already safe for background compression to run. */
    safeForBackgroundCompression?: boolean;
    deferredHistoryRefreshSessions: Set<string>;
    /** True when transform already triggered recovery/emergency historian work this pass. */
    skipAwaitForThisPass?: boolean;
    /** When true, extract user behavior observations from historian output */
    experimentalUserMemories?: boolean;
    /** When true, inject wall-clock dates on compartments in <session-history>. */
    experimentalTemporalAwareness?: boolean;
    /** When true, run a second editor pass after historian to clean U: lines. */
    historianTwoPass?: boolean;
    /** Cross-session memory feature gate (`memory.enabled`). */
    memoryEnabled?: boolean;
    /** Auto-promotion gate (`memory.auto_promote`). */
    autoPromote?: boolean;
    /** Forwarded to compartment runner — see CompartmentRunnerDeps.onCompartmentStatePublished. */
    onCompartmentStatePublished?: (sessionId: string) => void;
    /**
     * Boundary snapshot already resolved by THIS pass's trigger decision
     * (transform-located trigger). When present and runnable, the phase uses it
     * instead of re-resolving — one boundary resolution per pass, and the
     * historian starts from exactly the snapshot the fire decision saw. The
     * ≥80% emergency re-scale fallback below still re-resolves when this
     * snapshot has no runnable window.
     */
    preResolvedBoundarySnapshot?: ProtectedTailBoundarySnapshot;
}

/**
 * Prime the raw-message cache for the WHOLE compartment phase, then run it.
 *
 * The phase's boundary resolution (`getRawHistoryEligibility` +
 * `resolveOpenCodeProtectedTailBoundary`) AND the historian runner's
 * `readSessionChunk` all read raw OpenCode history. On a large session an
 * un-primed read is O(session) (multi-second each) and runs on the transform
 * thread — OpenCode awaits `messages.transform` before the LLM call, so a
 * historian-FIRE pass froze ~9.6s at "Thinking". The compartment TRIGGER primes
 * its own scope (`withRawSessionMessageCache` inside `getUnsummarizedTailInfo`),
 * but that scope ends when the trigger returns, so the phase read un-primed.
 *
 * Prime from the TAIL-ONLY DB read (`primeTailRawMessageCache`), NOT the
 * in-memory `args.messages` tail: `extractInMemoryMessageViews` aliases the live
 * `parts` objects, which the transform MUTATES between the trigger and this phase
 * (§N§ prefixes, `[dropped]` sentinels, stripped reasoning). The historian must
 * read RAW content; the DB read is unmutated and O(tail).
 *
 * Scope/await correctness: every raw read happens in the phase's SYNCHRONOUS
 * prefix — `runCompartmentPhaseImpl` is `async` but reaches its first `await`
 * only on the ≥95% blocking path (`awaitCompartmentRun`), and the runner's
 * `readSessionChunk` runs in the runner's own synchronous prefix (before its
 * first `await` at `client.session.get`). `withRawSessionMessageCache`'s
 * try/finally clears the cache the moment the wrapped fn RETURNS its promise
 * (i.e. after the synchronous body suspends at the first await), so the cache
 * covers all raw reads; the only post-await work (`prepareCompartmentInjection`)
 * reads context.db, never raw history. Priming once under `resolvedSessionId`
 * covers the runner too — it reads under `args.sessionId`, which equals
 * `resolvedSessionId` (transform.ts).
 */
export function runCompartmentPhase(
    args: RunCompartmentPhaseArgs,
): ReturnType<typeof runCompartmentPhaseImpl> {
    // Only prime (and pay its tail DB read) on a pass that will ACTUALLY read raw
    // history — i.e. one that starts or blocks on a historian run. On a normal
    // defer pass the impl does ZERO raw reads (both its start-block and its ≥95%
    // block are gated off), so priming there would add a useless ~100ms tail read
    // to EVERY pass on a large session (the regression this gate fixes). The impl
    // reads raw history in exactly two cases, mirrored here:
    //   - compartmentInProgress is set (the trigger fired) AND no run is active
    //     yet → this pass resolves the boundary + the runner reads the chunk, OR
    //   - usage ≥ 95% with await allowed → the emergency block force-starts.
    // The active-run guard matters: compartmentInProgress STAYS true for the whole
    // background run, but while a run is active the impl no-ops (the run owns it),
    // so without this guard we'd re-prime every pass for the run's full duration.
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
        // No raw reads this pass — skip the prime and its cache scope entirely.
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
            // Priming is a pure optimization — on any failure the phase falls
            // back to the full read (its prior behavior). Never block the phase.
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

    const startForcedCompartmentAgent = (client: NonNullable<typeof args.client>): void => {
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
            startForcedCompartmentAgent(args.client);
            compartmentInProgress = true;
        }
    }

    let awaitedCompartmentRun = false;

    // At the derived force band, run aggressive heuristic cleanup (dropAllTools) but do NOT block
    // the transform waiting for historian. Historian runs in the background.
    // Blocking here freezes the session UI at "Thinking" with no LLM call.
    // Only 95% (BLOCK_UNTIL_DONE_PERCENTAGE) should block.

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
            startForcedCompartmentAgent(args.client);
            activeRun = getActiveCompartmentRun(args.sessionId);
        } else if (!activeRun && hasEligibleHistoryForCompartment()) {
            sessionLog(
                args.sessionId,
                "transform: cannot force-start compartment agent without client",
            );
        }
        if (activeRun) {
            // Notify user before blocking — the session will appear frozen at "Thinking"
            // while historian compacts. Without this, users have no idea what's happening.
            //
            // CRITICAL: This notification creates a user message via session.prompt
            // with noReply:true. The message is PERSISTED to OpenCode's session DB,
            // which gives it a higher ID than the latest assistant. OpenCode's
            // runLoop break condition checks `lastUser.id < lastAssistant.id`, and
            // a fresh notification-user-message every transform pass makes that
            // condition stay false → runLoop keeps iterating → mock returns text
            // above-force-band usage → transform fires again → notification fires again
            // → INFINITE LOOP. We've observed this on CI with >1700 requests per turn.
            //
            // Guard: only send the notification ONCE per active compartment run.
            // The flag lives on the activeRun and is cleared when the run completes,
            // so a future compartment run can notify again.
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
                // Timeout: historian is still running in the background.
                // Keep compartmentInProgress = true so future passes know the run is active.
                // Do NOT set awaitedCompartmentRun — the run hasn't actually completed.
                // The background run will publish when done, and the next pass picks it up.
                sessionLog(
                    args.sessionId,
                    "transform: proceeding after 95% timeout — historian still running in background",
                );
            }
        }
    }

    // v2: no independent compressor — deterministic decay-tier rendering keeps
    // the history block within budget at render time, with no LLM pass.
    return {
        pendingCompartmentInjection,
        awaitedCompartmentRun,
        compartmentInProgress,
        published,
        justAwaitedPublication,
        rebuiltHistoryThisPass,
    };
}
