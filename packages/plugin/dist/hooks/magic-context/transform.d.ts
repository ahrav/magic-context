import type { Scheduler } from "../../features/magic-context/scheduler";
import { type ContextDatabase } from "../../features/magic-context/storage";
import type { Tagger } from "../../features/magic-context/tagger";
import type { ContextUsage } from "../../features/magic-context/types";
import type { PluginContext } from "../../plugin/types";
import type { PromptSurfaceConfig } from "../../shared/prompt-surface";
import type { PromptSurfaceRuntime } from "../../shared/prompt-surface-runtime";
import type { LiveModelBySession } from "./hook-handlers";
import { type RustModeModuleClient } from "./rust-mode-transform";
export { EmergencyFailClosedError } from "./emergency-fail-closed";
export declare function clearMessageTokensCache(sessionId: string, messageId?: string): void;
/**
 * Test-only accessor that returns (and lazily creates) the per-session token
 * cache map so tests can seed and inspect entries without running the full
 * transform pipeline. Not exported from any barrel.
 */
export declare function __getMessageTokensCacheForTest(sessionId: string): Map<string, {
    conversation: number;
    toolCall: number;
}>;
/**
 * Compute whether the provider cache expired due to idle time.
 * Extracted so callers that don't run the full transform pipeline can still
 * evaluate the TTL idle window with the same parseCacheTtl semantics.
 *
 * Returns false when cacheTtl is "never" (Infinity) because any finite
 * elapsed time is < Infinity.
 *
 * @param onInvalid Optional callback invoked when cacheTtl fails to parse;
 *        the 5m fallback is applied AFTER the callback returns.
 */
export declare function computeHardCacheExpired(cacheTtl: string, lastResponseTime: number, now: number, onInvalid?: (error: unknown) => void): boolean;
type TsAuthorityRecoveryOutcome = "completed" | "retryable";
/**
 * Restore a project to TypeScript ownership after its transform_mode setting no
 * longer selects Rust. The durable marker keeps writes fenced until the module
 * confirms every module-owned domain has drained back through its normal protocol.
 */
export declare function recoverTsAuthorityProject(args: {
    db: ContextDatabase;
    projectPath: string;
    projectRoot: string;
    module: RustModeModuleClient;
}): Promise<TsAuthorityRecoveryOutcome>;
export declare function scheduleTsAuthorityRecovery(args: {
    db: ContextDatabase;
    projectPath: string;
    projectRoot: string;
    module?: RustModeModuleClient;
    isLinkedWorktree?: (directory: string) => boolean;
}): void;
export interface TransformDeps {
    tagger: Tagger;
    scheduler: Scheduler;
    contextUsageMap: Map<string, {
        usage: ContextUsage;
        updatedAt: number;
        lastResponseTime?: number;
        hasUsageTokens?: boolean;
    }>;
    db: ContextDatabase;
    /**
     * Channel 1 (ctx_reduce tool-output nudge) per-session metric baseline,
     * refreshed at the end of each transform pass where ctx_reduce is callable
     * and read in tool.execute.after.
     */
    channel1StateBySession?: Map<string, import("./ctx-reduce-nudge").Channel1State>;
    /** Module-authored Channel 2 text held until the terminal `message.updated` event, when the host delivers the pending nudge. */
    channel2DirectiveTextBySession?: Map<string, string>;
    protectedTags: number;
    /**
     * ctx_reduce visibility is resolved per session from the session's tool
     * allow-list. Tag DB rows are still maintained when the tool is unavailable,
     * but §N§ prefixes and nudges are suppressed. See tag-messages.ts for the gate.
     */
    /** Smart-drops (experimental, default off): also reclaim tool output that a
     *  later call supersedes, on top of the age-based auto-drop. Off → messages
     *  sent to the model are byte-identical to the age-based-only behavior. */
    smartDrops?: boolean;
    clearReasoningAge: number;
    /** Commit-cluster historian trigger config (`commit_cluster_trigger`). */
    commitClusterTrigger?: {
        enabled: boolean;
        min_clusters: number;
    };
    /**
     * One-shot signal that `<session-history>` injection cache is stale and
     * `prepareCompartmentInjection` should rebuild on this pass. Drained
     * after the rebuild so subsequent defer passes hit the fresh cache.
     * See Oracle review 2026-04-26 for the three-set split rationale.
     */
    historyRefreshSessions: Set<string>;
    deferredHistoryRefreshSessions?: Set<string>;
    /**
     * Persistent signal that pending ops + heuristics need to materialize.
     * Survives across defer passes when `compartmentRunning` blocks the
     * heuristic pass. Drained only after `shouldRunHeuristics` succeeds.
     */
    pendingMaterializationSessions: Set<string>;
    deferredMaterializationSessions?: Set<string>;
    lastHeuristicsTurnId: Map<string, string>;
    commitSeenLastPass?: Map<string, boolean>;
    client?: PluginContext["client"];
    directory?: string;
    /** Whether user-level configuration lets this session use the canonical home directory as its project. */
    allowHomeProject?: boolean;
    memoryConfig?: {
        enabled: boolean;
        injectionBudgetTokens: number;
        /** When true, historian/recomp auto-promote eligible session facts
         *  to project memories. When false, promotion is skipped — agents can
         *  still write memories explicitly via `ctx_memory write`. Issue #44. */
        autoPromote: boolean;
    };
    /** Defaults true. When false, m[0] omits the <project-docs> block and docs hash. */
    injectDocs?: boolean;
    ensureProjectRegistered?: (directory: string, db: ContextDatabase) => Promise<void>;
    /**
     * Returns the historian chunk budget. Called at each historian spawn site
     * so the value is always derived from current config — keeping hook,
     * RPC, and TUI trigger paths consistent and honoring runtime config changes.
     * Optional for tests; production (hook.ts) always provides it.
     */
    getHistorianChunkTokens?: () => number;
    historyBudgetPercentage?: number;
    executeThresholdPercentage?: number | {
        default: number;
        [modelKey: string]: number;
    };
    executeThresholdTokens?: {
        default?: number;
        [modelKey: string]: number | undefined;
    };
    historianTimeoutMs?: number;
    /** Resolved fallback chain for historian-family calls. */
    fallbackModels?: readonly string[];
    /** False when historian.disable=true, blocking historian-backed child agents. */
    historianRunnable?: boolean;
    /**
     * Compaction-off mode (issue #266), boot-resolved and process-stable.
     * When true the transform runs additive-only: m[0]/m[1] memory/docs
     * injection, measurement and identity recording stay; every mutating
     * compaction gate (historian, drops, strips, nudges, emergency, markers,
     * tag writes) is off. Precedence: every mutating gate becomes
     * `existingGate && !compactionOff` — the mode wins over both the primary
     * and the subagent path. It does NOT alias fullFeatureMode=false: the
     * m[0]/m[1] injection gate is re-expressed as identity-present AND
     * (fullFeatureMode || compactionOff) so the mode cannot swallow memory
     * delivery.
     */
    compactionOff?: boolean;
    getNotificationParams?: (sessionId: string) => import("./send-session-notification").NotificationParams;
    getModelKey?: (sessionId: string) => string | undefined;
    getFallbackModelId?: (sessionId: string) => string | undefined;
    projectPath?: string;
    experimentalUserMemories?: boolean;
    /** When true, inject wall-clock gap markers (<!-- +Xm -->) on user messages and
     *  add compact date ranges to compartment headings in <session-history>.
     *  Controlled by `experimental.temporal_awareness` config. */
    experimentalTemporalAwareness?: boolean;
    /** mural.enabled — when true (and the fold's model accepts
     *  images), materializeM0 renders the deterministic mural on demand and folds
     *  its image into the m[0] baseline. */
    muralEnabled?: boolean;
    /** When true, run a second editor pass after historian to clean U: lines.
     *  Enables the historian-editor agent. Controlled by `historian.two_pass` config. */
    historianTwoPass?: boolean;
    liveModelBySession?: LiveModelBySession;
    /**
     * Process-scoped cache of resolved session.directory values. When provided,
     * we look up here before hitting OpenCode's API and populate after a
     * successful lookup. The session→project binding is immutable in OpenCode,
     * so this cache lives until the session is deleted.
     */
    sessionDirectoryBySession?: Map<string, string>;
    /**
     * Process-scoped set of Magic Context's OWN hidden child sessions
     * (historian/dreamer/sidekick/memory-migration), detected by title prefix
     * at `session.created`. When a session is in this set the transform returns
     * immediately (messages unmodified) — these children have their own fixed
     * agent identity and never use any MC feature, so even reduced-mode work
     * (tagging, heuristic drops) is pure overhead. See live-session-state.ts.
     */
    internalChildSessions?: Set<string>;
    /** Experimental auto-search hint — transform-time ctx_search on each new
     *  user message; when top hit clears the threshold, append a compact
     *  fragment hint to the user message. Controlled by
     *  `experimental.auto_search.*` config. */
    autoSearch?: {
        enabled: boolean;
        scoreThreshold: number;
        minPromptChars: number;
        directory?: string;
        ensureProjectRegistered?: (directory: string, db: ContextDatabase) => Promise<void>;
    };
    /**
     * Experimental age-tier caveman text compression — rewrites long
     * user/assistant text parts with progressively aggressive caveman
     * rules based on their position in the eligible tag window. Only runs for
     * primary sessions; subagents are excluded because their context is curated
     * by the parent and they have no ctx_expand recovery path.
     */
    cavemanTextCompression?: {
        enabled: boolean;
        minChars: number;
    };
    /** Fire-and-forget active-session embed backfill after transform returns. */
    maybeAutoEmbedSession?: (sessionId: string) => void;
    /** Resolved project mode. Rust mode bypasses every TS mutation below. */
    transformMode?: "ts" | "rust";
    /** Prompt-surface routing and USER description overrides forwarded to Rust mode. */
    promptSurface?: PromptSurfaceConfig;
    /** Resolves trusted USER guidance files before crossing the module boundary. */
    promptSurfaceRuntime?: PromptSurfaceRuntime;
    /** Module transport injected by the hook; tests use a deterministic mock. */
    rustModeModuleClient?: RustModeModuleClient;
    /** Test-only opt-out for transform-wire fixtures without the authority protocol. */
    rustModeAllowAuthorityProtocolBypassForTests?: boolean;
    rustModeProjectRoot?: string;
    /**
     * Module route used only to recover a project whose config changed from Rust
     * transforms back to TypeScript while the durable authority marker remains.
     */
    tsAuthorityRecoveryModuleClient?: RustModeModuleClient;
    onRustModeParked?: (sessionId: string, message: string) => void;
    onRustModeProjectPrepared?: (projectPath: string, projectRoot: string) => void;
}
export declare function createTransform(deps: TransformDeps): ((_input: Record<string, never>, output: {
    messages: unknown[];
}) => Promise<void>) & {
    invalidateRustWireState(sessionId: string): void;
    clearRustSession(sessionId: string): void;
};
export declare function resolveHistoryBudgetTokens(historyBudgetPercentage: number | undefined, contextUsage: ContextUsage, executeThresholdPercentage: number | {
    default: number;
    [modelKey: string]: number;
} | undefined, modelKey: string | undefined, executeThresholdTokens?: {
    default?: number;
    [modelKey: string]: number | undefined;
}, resolvedContextLimit?: number): number | undefined;
//# sourceMappingURL=transform.d.ts.map