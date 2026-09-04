import { type ContextDatabase } from "../../features/magic-context/storage";
import type { ContextUsage } from "../../features/magic-context/types";
import type { PluginContext } from "../../plugin/types";
import { type PreparedCompartmentInjection } from "./inject-compartments";
import { type ProtectedTailBoundarySnapshot } from "./protected-tail-boundary";
import type { MessageLike } from "./transform-operations";
interface RunCompartmentPhaseArgs {
    canRunCompartments: boolean;
    fullFeatureMode: boolean;
    /** Compaction-off mode (issue #266): no historian start, no 95% block,
     *  no boundary resolution — the phase degrades to a stale-flag cleanup. */
    compactionOff?: boolean;
    /** False when historian.disable=true, blocking historian-backed child agents. */
    historianRunnable?: boolean;
    sessionMeta: {
        compartmentInProgress: boolean;
    };
    contextUsage: {
        percentage: number;
    };
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
    /** Cross-session memory feature gate (`memory.enabled`). Issue #44. */
    memoryEnabled?: boolean;
    /** Auto-promotion gate (`memory.auto_promote`). Issue #44. */
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
export declare function runCompartmentPhase(args: RunCompartmentPhaseArgs): ReturnType<typeof runCompartmentPhaseImpl>;
declare function runCompartmentPhaseImpl(args: RunCompartmentPhaseArgs): Promise<{
    pendingCompartmentInjection: PreparedCompartmentInjection | null;
    awaitedCompartmentRun: boolean;
    compartmentInProgress: boolean;
    published: boolean;
    justAwaitedPublication: boolean;
    rebuiltHistoryThisPass: boolean;
}>;
export {};
//# sourceMappingURL=transform-compartment-phase.d.ts.map