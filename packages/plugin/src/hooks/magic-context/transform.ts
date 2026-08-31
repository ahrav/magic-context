import * as crypto from "node:crypto";
import {
    type AuthorityModuleClient,
    checksumAuthoritySeedRows,
    drainAuthority,
    ensureContextStoreUuid,
    getAuthorityManagedMarker,
} from "../../features/magic-context/context-authority";
import { revalidateEnforcementArtifacts } from "../../features/magic-context/memory/enforcement-artifact-revalidation";
import {
    isLinkedGitWorktree,
    resolveProjectIdentity,
    resolveProjectIdentityForSession,
    resolveProjectRootDirectory,
    takeDubiousOwnershipProjectIdentityWarning,
} from "../../features/magic-context/memory/project-identity";
import { scheduleReconciliation } from "../../features/magic-context/message-index-async";
import type { Scheduler } from "../../features/magic-context/scheduler";
import { parseCacheTtl } from "../../features/magic-context/scheduler";
import { recordSessionProjectIdentity } from "../../features/magic-context/session-project-storage";
import {
    type ContextDatabase,
    deriveTagLoadFloor,
    getActiveTagsBySession,
    getActiveTagTokenTotalsByMessage,
    getHistorianFailureState,
    getMaxDroppedTagNumber,
    getOrCreateSessionMeta,
    getTagsByNumbers,
    loadPersistedUsage,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import {
    casChannel2NudgeState,
    clearDetectedContextLimit,
    clearEmergencyDropSample,
    clearEmergencyRecovery,
    clearHistorianFailureState,
    clearPersistedReasoningWatermark,
    getOverflowState,
    loadProtectedTailMeta,
    recordOverflowDetected,
    resetLastNudgeCycleIfTailShrank,
    resetProtectedTailNoEligibleHead,
    setDeferredExecutePendingIfAbsent,
} from "../../features/magic-context/storage-meta-persisted";
import { bumpProjectMemoryEpoch } from "../../features/magic-context/storage-project-state";
import type { Tagger } from "../../features/magic-context/tagger";
import {
    clearOpenCodePendingTransformDecision,
    normalizeMaterializeReason,
    recordPendingTransformDecision,
} from "../../features/magic-context/transform-decision-log";
import type { ContextUsage } from "../../features/magic-context/types";
import type { PluginContext } from "../../plugin/types";
import { BoundedSessionMap } from "../../shared/bounded-session-map";
import { getErrorMessage } from "../../shared/error-message";
import { piModelRefToCanonical } from "../../shared/harness-provider-map";
import { log, sessionLog } from "../../shared/logger";
import { getSdkContextLimit } from "../../shared/models-dev-cache";
import type { PromptSurfaceConfig } from "../../shared/prompt-surface";
import type { PromptSurfaceRuntime } from "../../shared/prompt-surface-runtime";
import { applyMidTurnDeferral, detectMidTurnBypassReason } from "./boundary-execution";
import { canConsumeDeferredOnThisPass } from "./cache-busting-signals";
import { replayCavemanCompression } from "./caveman-cleanup";
import { commitCompactionModeRecord, reconcileCompactionMode } from "./compaction-off-transition";
import { getActiveCompartmentRun, startCompartmentAgent } from "./compartment-runner";
import { buildTriggerInMemoryTail, checkCompartmentTrigger } from "./compartment-trigger";
import {
    type CtxReduceAvailabilityVerdict,
    resolveCtxReduceAvailabilityFromMessages,
    resolveTodowriteAvailabilityFromMessages,
    type ToolAvailabilityVerdict,
} from "./ctx-reduce-availability";
import { evaluateChannel2 } from "./ctx-reduce-nudge";
import { deriveTriggerBudget } from "./derive-budgets";
import { EmergencyFailClosedError } from "./emergency-fail-closed";
import {
    escalationBands,
    resolveContextWindowGeometry,
    resolveExecuteThreshold,
    resolveModelKey,
    resolveTrustedContextLimit,
} from "./event-resolvers";
import {
    describeFinalWireTail,
    estimateFinalWireInputTokens,
    estimateMessageTokens,
} from "./final-wire-token-estimate";
import type { LiveModelBySession } from "./hook-handlers";
import {
    type PreparedCompartmentInjection,
    prepareCompartmentInjection,
} from "./inject-compartments";
import { captureLkgSlot, projectLkgEntry, resolveLkgModelKeys } from "./lkg-replay";
import { dropSlot } from "./lkg-slot";
import { onNoteTrigger } from "./note-nudger";
import { createPassOutcome } from "./pass-outcome";
import {
    createDefaultBoundarySnapshotForTests,
    hasRunnableCompartmentWindow,
    type ProtectedTailBoundarySnapshot,
    RECOVERY_NO_HEAD_LIMIT,
    recordHighPressureNoEligibleHead,
    resolveOpenCodeProtectedTailBoundary,
} from "./protected-tail-boundary";
import { readRawSessionMessages } from "./read-session-chunk";
import { findLastAssistantModelFromOpenCodeDb, isMidTurn } from "./read-session-db";
import { extractInMemoryMessageViews } from "./read-session-raw";
import { createRustModeTransform, type RustModeModuleClient } from "./rust-mode-transform";
import { sendIgnoredMessage } from "./send-session-notification";
import { modelAcceptsEmptyContent } from "./sentinel";
import {
    replayClearedReasoning,
    replayStrippedInlineThinking,
    stripClearedReasoning,
} from "./strip-content";
import { injectTemporalMarkers } from "./temporal-awareness";
import { runCompartmentPhase } from "./transform-compartment-phase";
import { loadContextUsage, resolveSchedulerDecision } from "./transform-context-state";
import { findLastUserMessageId, findSessionId } from "./transform-message-helpers";
import {
    applyFlushedStatuses,
    type MessageLike,
    stripStructuralNoise,
    type TagTarget,
    tagMessages,
} from "./transform-operations";
import {
    abortSessionFailClosed,
    evaluateEmergencyFailClosed,
    runPostTransformPhase,
} from "./transform-postprocess-phase";
import { logTransformTiming } from "./transform-stage-logger";

export { EmergencyFailClosedError } from "./emergency-fail-closed";

// Conversation tokens include text, reasoning, and images.
// Tool-call tokens include tool_use, tool_result, tool, and tool-invocation content.
//
// Completed messages are append-only, so cached token counts remain stable across transform passes.
//
// The outer cache is bounded because undeleted sessions would otherwise retain inner maps indefinitely.
// Evicted session entries are recomputed lazily on the next transform pass.
const MESSAGE_TOKENS_CACHE_MAX = 100;
const messageTokensBySession = new BoundedSessionMap<
    Map<string, { conversation: number; toolCall: number }>
>(MESSAGE_TOKENS_CACHE_MAX);

function getMessageTokensCache(
    sessionId: string,
): Map<string, { conversation: number; toolCall: number }> {
    let cache = messageTokensBySession.get(sessionId);
    if (!cache) {
        cache = new Map();
        messageTokensBySession.set(sessionId, cache);
    }
    return cache;
}

function maybeSendProjectIdentityWarning(
    deps: TransformDeps,
    sessionId: string,
    directory: string,
    notificationParams: import("./send-session-notification").NotificationParams,
): void {
    if (!deps.client) return;
    const warning = takeDubiousOwnershipProjectIdentityWarning(directory);
    if (!warning) return;
    void sendIgnoredMessage(deps.client, sessionId, warning, notificationParams).catch((error) => {
        sessionLog(
            sessionId,
            `project identity warning delivery failed: ${error instanceof Error ? error.message : String(error)}`,
        );
    });
}

export function clearMessageTokensCache(sessionId: string, messageId?: string): void {
    if (messageId === undefined) {
        messageTokensBySession.delete(sessionId);
        return;
    }
    const cache = messageTokensBySession.get(sessionId);
    if (cache) cache.delete(messageId);
}

// The DB upsert and repair run only when a session's resolved identity first appears or changes.
// The guard suppresses repeated DB upserts and repairs during later transform passes in the same process.
// The guard is bounded so crashed or abandoned sessions cannot retain it indefinitely.
const recordedSessionProjectIdentity = new BoundedSessionMap<string>(MESSAGE_TOKENS_CACHE_MAX);

// Only OpenCode uses the tagger/trigger tag-load floor.
// Large, old sessions make these reads process their full tag histories.
// The transform receives the post-compaction-boundary tail.
// Postprocess prepends m[0] and m[1] after the transform.
// Because tag_number increases with message order, the wire's front has the lowest tags.
// Tags below the floor belong to compacted-away history and are absent from the wire.
// We derive one floor per pass and scope every such read to `tag_number >= floor`.
//
// deriveTagLoadFloor takes the minimum tag among the first K ID-bearing messages.
// A leading compaction summary can have a recently assigned, high tag.
// Using the first message's tag could exclude an older message later in the wire.
// A lower floor loads more tags and never excludes an in-wire tag.
// The margin absorbs near-boundary tool-result straddles and minor ID reordering.
// The floor is derived each pass from the post-cleanup wire.
// The floor uses no stored state.
function activeAgentFromMessages(messages: readonly MessageLike[]): string | undefined {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const info = messages[index]?.info as { role?: unknown; agent?: unknown } | undefined;
        if (info?.role !== "user") continue;
        return typeof info.agent === "string" && info.agent.length > 0 ? info.agent : undefined;
    }
    return undefined;
}

function deriveTaggerLoadFloor(
    messages: MessageLike[],
    sessionId: string,
    db: ContextDatabase,
): number {
    return deriveTagLoadFloor(
        db,
        sessionId,
        (function* () {
            for (const message of messages) yield message.info?.id;
        })(),
    );
}

/**
 */
export function __getMessageTokensCacheForTest(
    sessionId: string,
): Map<string, { conversation: number; toolCall: number }> {
    return getMessageTokensCache(sessionId);
}

/**
 * Callers outside the transform pipeline use `parseCacheTtl` semantics.
 *
 * Returns false for `cacheTtl === "never"` because finite elapsed time is less than `Infinity`.
 *
 * @param onInvalid The function calls onInvalid when cacheTtl fails to parse.
 * The function applies the 5m fallback after `onInvalid` returns.
 */
export function computeHardCacheExpired(
    cacheTtl: string,
    lastResponseTime: number,
    now: number,
    onInvalid?: (error: unknown) => void,
): boolean {
    let ttlMs: number;
    try {
        ttlMs = parseCacheTtl(cacheTtl);
    } catch (error) {
        onInvalid?.(error);
        ttlMs = 5 * 60 * 1000;
    }
    // Strict `>` matches the Rust scheduler's predicate.
    // At `elapsed === ttl`, both schedulers defer for one more pass to avoid a premature paid cache rebuild.
    return lastResponseTime > 0 && now - lastResponseTime > ttlMs;
}

/**
 */
function findLastAssistantModel(
    messages: MessageLike[],
): { providerID: string; modelID: string } | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        // OpenCode stores assistant `providerID` and `modelID` under `info`, although `MessageInfo` does not declare them.
        const info = messages[i].info as {
            role?: string;
            providerID?: string;
            modelID?: string;
        };
        if (info.role === "assistant" && info.providerID && info.modelID) {
            return { providerID: info.providerID, modelID: info.modelID };
        }
    }
    return null;
}

/**
 *
 * OpenCode user messages nest the model under `info.model`, while assistant messages store it directly under `info`.
 */
function findNewestUserModel(
    messages: MessageLike[],
): { providerID: string; modelID: string } | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        const info = messages[i].info as {
            role?: string;
            model?: { providerID?: string; modelID?: string };
        };
        if (info.role !== "user") continue;
        // Return the newest user's requested model; do not use an older user's model when the newest user has none.
        if (info.model?.providerID && info.model.modelID) {
            return { providerID: info.model.providerID, modelID: info.model.modelID };
        }
        return null;
    }
    return null;
}

type TsAuthorityRecoveryOutcome = "completed" | "retryable";

const tsAuthorityRecoveryStateByProject = new Map<string, "running" | "complete">();
const tsAuthorityMismatchLoggedProjects = new Set<string>();
const tsAuthorityUnreachableLoggedProjects = new Set<string>();

function authorityModuleForProject(
    module: RustModeModuleClient,
    projectRoot: string,
): AuthorityModuleClient {
    const authorityStatus = module.authorityStatus;
    const authorityDrain = module.authorityDrain;
    const mirrorPull = module.mirrorPull;
    if (!authorityStatus || !authorityDrain || !mirrorPull) {
        throw new Error(
            "the module does not expose authority.status, authority.drain, and mirror.pull",
        );
    }
    return {
        authorityStatus: (request) => authorityStatus.call(module, { ...request, projectRoot }),
        authorityPrepare: (request) => {
            if (!module.authorityPrepare) {
                throw new Error("the module does not expose authority.prepare");
            }
            return module.authorityPrepare({ ...request, projectRoot });
        },
        authorityDrain: (request) => authorityDrain.call(module, { ...request, projectRoot }),
        mirrorPull: (request) => mirrorPull.call(module, { ...request, projectRoot }),
    };
}

/**
 * recoverTsAuthorityProject restores TypeScript ownership when transform_mode no longer selects Rust.
 * The durable marker fences writes until every module-owned domain drains through the module protocol.
 */
export async function recoverTsAuthorityProject(args: {
    db: ContextDatabase;
    projectPath: string;
    projectRoot: string;
    module: RustModeModuleClient;
}): Promise<TsAuthorityRecoveryOutcome> {
    const module = authorityModuleForProject(args.module, args.projectRoot);
    const domains = ["memories", "notes"] as const;
    const statuses = await Promise.all(
        domains.map(async (domain) => ({
            domain,
            authority: (
                await module.authorityStatus({
                    context_store_uuid: ensureContextStoreUuid(args.db),
                    project: args.projectPath,
                    domain,
                })
            ).authority,
        })),
    );

    let drainedDomain = false;
    for (const { domain, authority } of statuses) {
        if (!authority || authority.state === "TS") continue;
        // The module's begin route owns MODULE → DRAINING.
        // Calling drainAuthority preserves the lease, mirror replay, checksum, and recovery choreography.
        if (authority.state !== "MODULE" && authority.state !== "DRAINING") {
            return "retryable";
        }
        let drained: Awaited<ReturnType<typeof drainAuthority>> | undefined;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            drained = await drainAuthority({
                db: args.db,
                projectPath: args.projectPath,
                domain,
                module,
                checksum: () => {
                    if (domain === "memories") return checksumAuthoritySeedRows([]);
                    const rows = args.db
                        .prepare("SELECT * FROM notes WHERE project_path = ? ORDER BY id ASC")
                        .all(args.projectPath)
                        .filter(
                            (row): row is Record<string, unknown> =>
                                row !== null && typeof row === "object",
                        );
                    return checksumAuthoritySeedRows(rows);
                },
            });
            if (!("code" in drained)) break;
        }
        if (!drained || "code" in drained) return "retryable";
        drainedDomain = true;
    }

    // drainAuthority removes the shared marker only after every domain is TS.
    // After a completed replay, bump the project memory epoch once so the memory view re-renders changes mirrored during recovery.
    if (drainedDomain && !getAuthorityManagedMarker(args.db, args.projectPath)) {
        bumpProjectMemoryEpoch(args.db, args.projectPath);
        return "completed";
    }
    return "retryable";
}

export function scheduleTsAuthorityRecovery(args: {
    db: ContextDatabase;
    projectPath: string;
    projectRoot: string;
    module?: RustModeModuleClient;
    isLinkedWorktree?: (directory: string) => boolean;
}): void {
    if (!getAuthorityManagedMarker(args.db, args.projectPath)) return;
    if ((args.isLinkedWorktree ?? isLinkedGitWorktree)(args.projectRoot)) return;
    if (tsAuthorityRecoveryStateByProject.has(args.projectPath)) return;
    const module = args.module;

    if (!tsAuthorityMismatchLoggedProjects.has(args.projectPath)) {
        tsAuthorityMismatchLoggedProjects.add(args.projectPath);
        log(
            `[magic-context] project ${args.projectPath} is module-authority-managed but transform_mode is TS; draining authority back to TypeScript`,
        );
    }
    if (!module) {
        tsAuthorityRecoveryStateByProject.set(args.projectPath, "complete");
        if (!tsAuthorityUnreachableLoggedProjects.has(args.projectPath)) {
            tsAuthorityUnreachableLoggedProjects.add(args.projectPath);
            log(
                `[magic-context] authority recovery for ${args.projectPath} cannot reach subc; writes remain fenced. Run magic-context doctor drain-authority ${args.projectRoot} with rust mode or restore subc connectivity.`,
            );
        }
        return;
    }

    tsAuthorityRecoveryStateByProject.set(args.projectPath, "running");
    void Promise.resolve()
        .then(() => recoverTsAuthorityProject({ ...args, module }))
        .then((outcome) => {
            if (outcome === "completed") {
                tsAuthorityRecoveryStateByProject.set(args.projectPath, "complete");
                log(`[magic-context] authority drain complete for project ${args.projectPath}`);
            } else {
                tsAuthorityRecoveryStateByProject.delete(args.projectPath);
            }
        })
        .catch((error) => {
            tsAuthorityRecoveryStateByProject.set(args.projectPath, "complete");
            if (!tsAuthorityUnreachableLoggedProjects.has(args.projectPath)) {
                tsAuthorityUnreachableLoggedProjects.add(args.projectPath);
                log(
                    `[magic-context] authority recovery for ${args.projectPath} cannot reach subc; writes remain fenced. Run magic-context doctor drain-authority ${args.projectRoot} with rust mode or restore subc connectivity.`,
                    error,
                );
            }
        });
}

export interface TransformDeps {
    tagger: Tagger;
    scheduler: Scheduler;
    contextUsageMap: Map<
        string,
        {
            usage: ContextUsage;
            updatedAt: number;
            lastResponseTime?: number;
            hasUsageTokens?: boolean;
        }
    >;
    db: ContextDatabase;
    /**
     */
    channel1StateBySession?: Map<string, import("./ctx-reduce-nudge").Channel1State>;
    /* */
    channel2DirectiveTextBySession?: Map<string, string>;
    protectedTags: number;
    /**
     */
    /**
     * */
    smartDrops?: boolean;
    clearReasoningAge: number;
    /* */
    commitClusterTrigger?: { enabled: boolean; min_clusters: number };
    /**
     */
    historyRefreshSessions: Set<string>;
    deferredHistoryRefreshSessions?: Set<string>;
    /**
     */
    pendingMaterializationSessions: Set<string>;
    deferredMaterializationSessions?: Set<string>;
    lastHeuristicsTurnId: Map<string, string>;
    commitSeenLastPass?: Map<string, boolean>;
    client?: PluginContext["client"];
    directory?: string;
    /* */
    allowHomeProject?: boolean;
    memoryConfig?: {
        enabled: boolean;
        injectionBudgetTokens: number;
        /**
         * */
        autoPromote: boolean;
    };
    /* */
    injectDocs?: boolean;
    ensureProjectRegistered?: (directory: string, db: ContextDatabase) => Promise<void>;
    /**
     */
    getHistorianChunkTokens?: () => number;
    historyBudgetPercentage?: number;
    executeThresholdPercentage?: number | { default: number; [modelKey: string]: number };
    executeThresholdTokens?: { default?: number; [modelKey: string]: number | undefined };
    historianTimeoutMs?: number;
    /* */
    fallbackModels?: readonly string[];
    /** Historian-backed child agents are blocked when historian.disable=true. */
    historianRunnable?: boolean;
    /**
     * Compaction-off mode is boot-resolved and process-stable.
     * `compactionOff` preserves memory and docs injection while disabling mutating compaction.
     * `compactionOff` disables every mutating compaction gate, including subagent gates.
     * `compactionOff` preserves `m[0]`/`m[1]` injection even when `fullFeatureMode` is false.
     * delivery.
     */
    compactionOff?: boolean;
    getNotificationParams?: (
        sessionId: string,
    ) => import("./send-session-notification").NotificationParams;
    getModelKey?: (sessionId: string) => string | undefined;
    getFallbackModelId?: (sessionId: string) => string | undefined;
    projectPath?: string;
    experimentalUserMemories?: boolean;

    /** Temporal-awareness injection adds wall-clock gap markers (`<!-- +Xm -->`) to user messages when enabled.
     * The transform adds compact date ranges to `<session-history>` compartment headings.
     * The `experimental.temporal_awareness` config controls temporal-awareness injection. */
    experimentalTemporalAwareness?: boolean;
    /** When `mural.enabled` is true and the fold's model accepts images, `materializeM0` renders the mural on demand.
     * `materializeM0` renders the deterministic mural on demand and folds its image into the `m[0]` baseline.
     * */
    muralEnabled?: boolean;
    /** The `historian.two_pass` config runs a second editor pass after historian to clean `U:` lines.
     * The `historian.two_pass` config enables the historian-editor agent. */
    historianTwoPass?: boolean;
    liveModelBySession?: LiveModelBySession;
    /**
     * The process-scoped cache stores resolved `session.directory` values.
     * The cache checks entries before querying OpenCode's API and stores successful lookups.
     */
    sessionDirectoryBySession?: Map<string, string>;
    /**
     * The process-scoped set records Magic Context hidden child sessions.
     * The `session.created` handler detects these sessions by title prefix.
     * The `session.created` handler adds title-prefixed hidden child sessions to the set; the transform returns their messages unmodified.
     * The transform returns hidden child-session messages unmodified because those sessions have fixed agent identities.
     */
    internalChildSessions?: Set<string>;
    /** Auto-search runs `ctx_search` for each new user message.
     * The transform appends a compact fragment hint when the top hit meets the threshold.
     * The `experimental.auto_search.*` config controls auto-search.
     *  `experimental.auto_search.*` config. */
    autoSearch?: {
        enabled: boolean;
        scoreThreshold: number;
        minPromptChars: number;
        directory?: string;
        ensureProjectRegistered?: (directory: string, db: ContextDatabase) => Promise<void>;
    };
    /**
     * Age-tier caveman compression rewrites long user and assistant text.
     * Compression applies progressively aggressive caveman rules according to each part's position in the eligible tag window.
     * Compression runs only for primary sessions.
     * Compression excludes subagents because their context is curated by the parent and they have no `ctx_expand` recovery path.
     */
    cavemanTextCompression?: {
        enabled: boolean;
        minChars: number;
    };
    /** The transform schedules active-session embed backfill without awaiting it. */
    maybeAutoEmbedSession?: (sessionId: string) => void;
    /** `transformMode` is the resolved project mode; Rust mode bypasses every TypeScript mutation below. */
    transformMode?: "ts" | "rust";
    /** Rust mode receives prompt-surface routing and USER description overrides. */
    promptSurface?: PromptSurfaceConfig;
    /** The runtime resolves trusted USER guidance files before the module boundary. */
    promptSurfaceRuntime?: PromptSurfaceRuntime;
    /* */
    rustModeModuleClient?: RustModeModuleClient;
    /* */
    rustModeAllowAuthorityProtocolBypassForTests?: boolean;
    rustModeProjectRoot?: string;
    /**
     * The recovery module restores projects that switched from Rust to TypeScript while their durable authority marker remains.
     */
    tsAuthorityRecoveryModuleClient?: RustModeModuleClient;
    onRustModeParked?: (sessionId: string, message: string) => void;
    onRustModeProjectPrepared?: (projectPath: string, projectRoot: string) => void;
}

export function createTransform(deps: TransformDeps) {
    const loadedSessions = new Set<string>();
    const rustModeTransform =
        deps.transformMode === "rust" && deps.rustModeModuleClient
            ? createRustModeTransform(deps, {
                  moduleClient: deps.rustModeModuleClient,
                  hostClient: deps.client,
                  projectRoot: deps.rustModeProjectRoot,
                  notifyParked: deps.onRustModeParked,
                  onProjectPrepared: deps.onRustModeProjectPrepared,
                  allowAuthorityProtocolBypassForTests:
                      deps.rustModeAllowAuthorityProtocolBypassForTests,
              })
            : undefined;
    const deferredHistoryRefreshSessions = deps.deferredHistoryRefreshSessions ?? new Set<string>();
    const deferredMaterializationSessions =
        deps.deferredMaterializationSessions ?? new Set<string>();

    const transform = async (
        _input: Record<string, never>,
        output: { messages: unknown[] },
    ): Promise<void> => {
        const startTime = performance.now();
        const messages = output.messages as MessageLike[];
        const passOutcome = createPassOutcome();
        const lkgInput = projectLkgEntry(messages);
        const sessionId = findSessionId(messages);
        if (!sessionId) {
            return;
        }
        const resolvedSessionId = sessionId;
        clearOpenCodePendingTransformDecision(sessionId);
        logTransformTiming(sessionId, "findSessionId", startTime, `messages=${messages.length}`);

        const db = deps.db;
        if (deps.client !== undefined) {
            scheduleReconciliation(db, sessionId, readRawSessionMessages);
        }

        const tUserMsg = performance.now();
        const currentTurnId = findLastUserMessageId(messages);
        const activeAgent = activeAgentFromMessages(messages);
        logTransformTiming(sessionId, "findLastUserMessageId", tUserMsg);

        const tMeta = performance.now();
        let sessionMeta: import("../../features/magic-context/types").SessionMeta | undefined;
        try {
            // Magic Context does not block live chat when a session-state read fails.
            sessionMeta = getOrCreateSessionMeta(db, sessionId);
        } catch (error) {
            passOutcome.record("session-meta-early-return", "fatal");
            sessionLog(sessionId, "transform failed reading session meta:", error);
            return;
        }
        logTransformTiming(sessionId, "getOrCreateSessionMeta", tMeta);

        if (deps.internalChildSessions?.has(sessionId)) {
            sessionLog(sessionId, "transform skipped (internal magic-context child session)");
            return;
        }

        // Compaction-mode reconciliation must run before either renderer returns so stale markers and latches are reconciled.
        const compactionOff = deps.compactionOff === true;

        try {
            const transition = reconcileCompactionMode({
                db,
                sessionId,
                compactionOff,
                historianRunnable: deps.historianRunnable !== false,
                compartmentInProgress: sessionMeta.compartmentInProgress,
            });
            const hasTransitionEffects =
                transition.recordToWrite !== null ||
                transition.notice !== null ||
                transition.invalidatedM0Baseline ||
                transition.clearedCompartmentInProgress ||
                transition.historianCatchUpSignaled;
            if (hasTransitionEffects) {
                if (transition.invalidatedM0Baseline) {
                    sessionMeta = {
                        ...sessionMeta,
                        cachedM0Bytes: null,
                        cachedM1Bytes: null,
                        cachedM0MuralDataUrl: null,
                        cachedM0MuralHash: null,
                    };
                }
                if (transition.clearedCompartmentInProgress) {
                    sessionMeta = { ...sessionMeta, compartmentInProgress: false };
                }
                if (transition.historianCatchUpSignaled) {
                    sessionMeta = { ...sessionMeta, compartmentInProgress: true };
                }
                const notice = transition.notice;
                // The delivery path treats a missing client as successful notice delivery and commits the settled record only after successful delivery.
                let noticeDelivered = notice === null || deps.client === undefined;
                if (notice && deps.client) {
                    noticeDelivered =
                        (await sendIgnoredMessage(
                            deps.client,
                            sessionId,
                            notice,
                            deps.getNotificationParams?.(sessionId) ?? {},
                        )) === "sent";
                }
                if (noticeDelivered && transition.recordToWrite !== null) {
                    commitCompactionModeRecord(db, sessionId, transition.recordToWrite);
                } else if (!noticeDelivered) {
                    sessionLog(
                        sessionId,
                        "compaction mode notice was not delivered; durable pending record will retry on the next pass",
                    );
                }
            }
        } catch (error) {
            passOutcome.record("compaction-mode-transition-failure");
            sessionLog(sessionId, "compaction mode transition failed (retrying next pass):", error);
        }

        if (deps.transformMode === "rust") {
            if (!rustModeTransform) {
                sessionLog(sessionId, "rust transform unavailable; using raw passthrough");
                return;
            }
            // Rust mode revalidates artifacts because the TypeScript probe runs after Rust mode returns.
            // An edited or deleted artifact must withdraw ENFORCED maturity in Rust-only sessions.
            // Rust mode uses the TypeScript path's revalidation throttle and failure semantics.
            // Rust mode resolves the probe directory from the same session-directory cache as the TypeScript path.
            if (deps.memoryConfig?.enabled) {
                try {
                    const probeDirectory =
                        deps.sessionDirectoryBySession?.get(sessionId) ??
                        deps.directory ??
                        process.cwd();
                    revalidateEnforcementArtifacts(
                        db,
                        resolveProjectIdentity(probeDirectory),
                        resolveProjectRootDirectory(probeDirectory),
                    );
                } catch (error) {
                    sessionLog(
                        sessionId,
                        "artifact revalidation failed (retrying on a later pass):",
                        error,
                    );
                }
            }
            await rustModeTransform.run(sessionId, messages, output, sessionMeta);
            return;
        }

        // `experimental.chat.system.transform` detects system prompt changes.
        // The transform detects system-prompt changes from user and assistant messages, not system messages.

        const reducedMode = sessionMeta.isSubagent;
        const fullFeatureMode = !reducedMode;
        // Compaction-off mode is independent of subagent mode.
        // `m[0]/m[1]` injection requires identity and `(fullFeatureMode || compactionOff)`.
        // `compactionOff` preserves memory delivery.

        // `ctxReduceCallable` gates the §N§ prefix, `ctx_reduce`, and Channel 1.
        // `ctxReduceCallable` does not depend on subagent status.
        // `ctx_reduce` is registered process-globally, so subagents can have the tool.
        // Subagents need the §N§ prefix, Channel 1 baseline, and guidance to use `ctx_reduce`.
        //
        // `ctxReduceCallable` also requires the session's tool allow-list to include `ctx_reduce`.
        // A session can use an explicit tool allow-list that excludes `ctx_reduce`.
        // `transform` must not inject §N§ prefixes or nudges when `ctx_reduce` is unavailable.
        // `transform` must not inject prefixes or nudges for unavailable tools.
        // `ctxReduceAvailability` must remain fixed for the session from the first user message's tool map.
        // `ctxReduceAvailability` remains unchanged for the session, preserving cache keys.
        const ctxReduceAvailability: CtxReduceAvailabilityVerdict =
            resolveCtxReduceAvailabilityFromMessages(sessionId, messages);
        const ctxReduceCallable = ctxReduceAvailability.callable;

        // `todowriteAvailability` is frozen for each session.
        // `transform` must not inject the synthetic task-list pair when the session tool map excludes `todowrite`.
        // `todowriteAvailability` uses the first user message's tools map.
        const todowriteAvailability: ToolAvailabilityVerdict =
            resolveTodowriteAvailabilityFromMessages(sessionId, messages);

        // `deps.directory` is captured at plugin initialization and can differ from the session project directory.
        //
        //
        // `transform` must use the public SDK because OpenCode's internal SQLite schema is private and may change without notice.
        //
        let sessionDirectory: string = deps.directory ?? "";
        let sessionDirectoryResolvedFromHost = false;
        const cachedDirectory = deps.sessionDirectoryBySession?.get(sessionId);
        if (cachedDirectory && cachedDirectory.length > 0) {
            sessionDirectory = cachedDirectory;
            sessionDirectoryResolvedFromHost = true;
        } else if (deps.client !== undefined) {
            try {
                const sessionResponse = await deps.client.session
                    .get({ path: { id: sessionId } })
                    .catch(() => null);
                const sessionInfo = (sessionResponse as { data?: { directory?: string } } | null)
                    ?.data;
                if (
                    sessionInfo &&
                    typeof sessionInfo.directory === "string" &&
                    sessionInfo.directory.length > 0
                ) {
                    sessionDirectory = sessionInfo.directory;
                    // `deps.directory` is used only when session-directory resolution fails.
                    deps.sessionDirectoryBySession?.set(sessionId, sessionDirectory);
                    sessionDirectoryResolvedFromHost = true;
                }
            } catch (error) {
                passOutcome.record("session-directory-fallback");
                sessionLog(sessionId, "session directory lookup failed; using fallback:", error);
            }
            if (!sessionDirectoryResolvedFromHost) passOutcome.record("session-directory-fallback");
        }
        const compartmentDirectory = sessionDirectory;
        const historianRunnable = deps.historianRunnable !== false;
        const canRunCompartments =
            fullFeatureMode &&
            !compactionOff &&
            historianRunnable &&
            deps.client !== undefined &&
            compartmentDirectory.length > 0;
        const fallbackModelId = deps.getFallbackModelId?.(sessionId);

        const tModelDetect = performance.now();
        // `transform` must capture persisted usage before resets because model-change and first-pass resets clear `last_context_percentage` and `last_input_tokens`.
        const persistedUsageBeforeResets = loadPersistedUsage(db, sessionId);

        // `transform` must detect model changes before loading context usage so threshold checks and the history budget use the current model's numbers.
        if (deps.liveModelBySession) {
            // `transform` must use the newest user message's nested `info.model`; it determines the request model and reflects a switch before the preceding assistant message's flat model fields.
            // On a switching turn, the last assistant has the old model.
            const currentOutgoingModel =
                findNewestUserModel(messages) ??
                deps.liveModelBySession.get(sessionId) ??
                findLastAssistantModel(messages);
            if (currentOutgoingModel) {
                // `liveModelBySession` is seeded after restart.
                deps.liveModelBySession.set(sessionId, currentOutgoingModel);

                // Model-change detection compares outgoingModelKey with lastObservedModelKey, not liveModelBySession.
                // Comparing liveModelBySession with outgoingModelKey misses live switches.
                // lastObservedModelKey identifies the model that produced the last persisted usage.
                // A differing outgoingModelKey means the model changed after the last measured turn.
                // A model change requires clearing the prior model's detected limit, reasoning watermark, and emergency state.
                const outgoingModelKey = resolveModelKey(
                    currentOutgoingModel.providerID,
                    currentOutgoingModel.modelID,
                );
                const lastUsageModelKey = persistedUsageBeforeResets?.lastObservedModelKey ?? null;
                if (
                    lastUsageModelKey != null &&
                    outgoingModelKey != null &&
                    piModelRefToCanonical(lastUsageModelKey) !==
                        piModelRefToCanonical(outgoingModelKey)
                ) {
                    dropSlot(sessionId, "model-change");
                    sessionLog(
                        sessionId,
                        `transform: model change since last usage (${lastUsageModelKey} -> ${outgoingModelKey}), clearing stale per-model state`,
                    );
                    updateSessionMeta(db, sessionId, {
                        lastContextPercentage: 0,
                        lastInputTokens: 0,
                        observedSafeInputTokens: 0,
                        cacheAlertSent: false,
                        clearedReasoningThroughTag: 0,
                    });
                    clearHistorianFailureState(db, sessionId);
                    clearPersistedReasoningWatermark(db, sessionId);
                    // A model change resets the emergency-drop watermark because its contextLimit × executeThreshold ceiling changes.
                    // Clearing the emergency state forces a full-tail reevaluation.
                    // A model change clears the detected-overflow limit and recovery flag because both are model-specific.
                    // The proactive recovery arm reevaluates the new model after a model change.
                    clearEmergencyDropSample(db, sessionId);
                    clearDetectedContextLimit(db, sessionId);
                    clearEmergencyRecovery(db, sessionId);
                    // Clearing the in-memory usage map makes loadContextUsage recompute usage.
                    deps.contextUsageMap.delete(sessionId);
                    sessionMeta = {
                        ...sessionMeta,
                        lastContextPercentage: 0,
                        lastInputTokens: 0,
                        clearedReasoningThroughTag: 0,
                        observedSafeInputTokens: 0,
                        cacheAlertSent: false,
                    };
                }
            }
        }

        logTransformTiming(sessionId, "modelChangeDetection", tModelDetect);
        logTransformTiming(sessionId, "schedulerAndUsage", tModelDetect);
        const tFirstPass = performance.now();
        const isFirstTransformPassForSession = !loadedSessions.has(sessionId);
        loadedSessions.add(sessionId);

        // The first-pass reset precedes loadContextUsage so stale data cannot trigger 95% blocking or an 80% emergency nudge.
        // persistedUsageBeforeResets retains pre-reset usage for restart recovery and protected-tail boundary sizing.
        const historianFailureState = getHistorianFailureState(db, sessionId);

        if (isFirstTransformPassForSession && sessionMeta) {
            const persistedPct = sessionMeta.lastContextPercentage ?? 0;
            if (persistedPct > 0) {
                sessionLog(
                    sessionId,
                    `transform: first pass reset — percentage=${persistedPct.toFixed(1)}% — clearing stale usage state`,
                );
                updateSessionMeta(db, sessionId, {
                    lastContextPercentage: 0,
                    lastInputTokens: 0,
                    // `transform` must not clear `compartmentInProgress`: `runCompartmentPhase` needs it to resume interrupted historian runs.
                    // runCompartmentPhase resumes historian runs interrupted by process restart.
                });
                // `transform` must not clear historian failure state because restart recovery uses it.
                deps.contextUsageMap.delete(sessionId);
                sessionMeta = { ...sessionMeta, lastContextPercentage: 0, lastInputTokens: 0 };
            }
        }

        let contextUsageEarly = loadContextUsage(deps.contextUsageMap, db, sessionId);

        let recoveryNoHeadEscapeActive = false;
        let emergencyRecoveryArmed = false;
        let emergencyRecoveryOrigin: "provider_overflow" | "proactive_model_shrink" | null = null;
        let usagePercentageSynthetic = false;

        // `transform` sets effective usage to 95% on the pass after a persisted context-overflow error so emergency recovery runs when the resolved limit exceeds the provider's actual limit.
        //
        // `transform` bypasses overflow recovery when `compactionOff` is true, allowing native provider compaction without consuming the persisted emergency latch.
        // compaction instead.
        if (fullFeatureMode && !compactionOff) {
            try {
                // `transform` arms recovery after a switch to a smaller context window when the previous model's measured input exceeds the current catalog limit.
                //
                // `transform` arms recovery only when canonical model keys differ.
                // `transform` uses `getSdkContextLimit` so a stale unkeyed detected limit from the prior model cannot false-arm recovery.
                // The recovery arm keeps `armCatalogLimit` separate from `detected_context_limit` so a stale-low catalog value cannot pin the cap.
                const armModel = deps.liveModelBySession?.get(sessionId);
                const armModelKey = deps.getModelKey?.(sessionId);
                const armSnapshot = persistedUsageBeforeResets;
                const lastMeasuredInput =
                    armSnapshot?.usage.inputTokens ?? sessionMeta?.lastInputTokens ?? 0;
                const lastMeasuredModelKey = armSnapshot?.lastObservedModelKey ?? null;
                const armCatalogLimit = armModel
                    ? getSdkContextLimit(armModel.providerID, armModel.modelID)
                    : undefined;
                if (
                    !sessionMeta?.isSubagent &&
                    armModel &&
                    typeof armCatalogLimit === "number" &&
                    armCatalogLimit > 0 &&
                    lastMeasuredInput > armCatalogLimit &&
                    lastMeasuredModelKey != null &&
                    armModelKey != null &&
                    piModelRefToCanonical(lastMeasuredModelKey) !==
                        piModelRefToCanonical(armModelKey) &&
                    !getOverflowState(db, sessionId).needsEmergencyRecovery
                ) {
                    sessionLog(
                        sessionId,
                        `transform: last input ${lastMeasuredInput} (model ${lastMeasuredModelKey}) exceeds new model ${armModelKey} catalog limit ${armCatalogLimit}; arming overflow recovery proactively for the shrinking switch`,
                    );
                    // detected_context_limit.
                    dropSlot(sessionId, "overflow-recovery-arm");
                    recordOverflowDetected(
                        db,
                        sessionId,
                        undefined,
                        armModelKey,
                        "proactive_model_shrink",
                    );
                    // Model-change arming resets `noEligibleHeadCount` because a stale prior-model count would let `noHeadEscape` suppress the newly armed bump.
                    resetProtectedTailNoEligibleHead(db, sessionId);
                }

                const overflowState = getOverflowState(db, sessionId);
                emergencyRecoveryArmed = overflowState.needsEmergencyRecovery;
                emergencyRecoveryOrigin = overflowState.emergencyRecoveryOrigin;
                if (contextUsageEarly.percentage < 80 && !overflowState.needsEmergencyRecovery) {
                    resetProtectedTailNoEligibleHead(db, sessionId);
                }
                const protectedTailMeta = loadProtectedTailMeta(db, sessionId);
                const noHeadEscape =
                    overflowState.needsEmergencyRecovery &&
                    protectedTailMeta.recoveryNoEligibleHeadCount >= RECOVERY_NO_HEAD_LIMIT;
                recoveryNoHeadEscapeActive = noHeadEscape;
                if (
                    overflowState.needsEmergencyRecovery &&
                    contextUsageEarly.percentage < 95 &&
                    !noHeadEscape
                ) {
                    sessionLog(
                        sessionId,
                        `transform: bumping percentage to 95% due to overflow recovery flag (was ${contextUsageEarly.percentage.toFixed(1)}%, detectedLimit=${overflowState.detectedContextLimit || "unknown"})`,
                    );
                    contextUsageEarly = {
                        ...contextUsageEarly,
                        percentage: 95,
                    };
                    usagePercentageSynthetic = true;
                } else if (recoveryNoHeadEscapeActive && deps.client) {
                    void sendIgnoredMessage(
                        deps.client,
                        sessionId,
                        "Magic Context can't compact yet — the recent history is a single in-progress block. Continuing; it will compact once the block completes. Run `/ctx-recomp` if this persists.",
                        deps.getNotificationParams?.(sessionId) ?? {},
                    );
                }
            } catch (error) {
                passOutcome.record("overflow-state-read-failure");
                sessionLog(
                    sessionId,
                    "transform: overflow recovery state read failed:",
                    getErrorMessage(error),
                );
            }
        }
        // `transform` resolves the stable model limit directly so the first post-restart pass, whose live usage is 0%, receives a nonvolatile history budget.
        //
        // `liveModelBySession` can omit the last assistant model when `messages` omits that tuple.
        // If the visible message array omits the last assistant tuple, fall back to findLastAssistantModelFromOpenCodeDb; otherwise a cold compartmented session falls back to 60K.
        //
        // `resolveTrustedContextLimit` returns only models.dev or detected-overflow limits; `resolveContextLimit` can return the generic 128K default.
        // The generic 128K default would shrink an unknown large-context model's history below the live-usage-derived budget.
        // Unknown models fall through to the live-usage path in the resolver.
        let modelForBudget = deps.liveModelBySession?.get(sessionId);
        if (!modelForBudget) {
            const recovered = findLastAssistantModelFromOpenCodeDb(sessionId);
            if (recovered) {
                modelForBudget = recovered;
                deps.liveModelBySession?.set(sessionId, recovered);
            }
        }
        // resolvedProviderID supplies every empty-sentinel producer during the pass.
        // A cold pass can recover modelForBudget from OpenCode's DB; hot passes use deps.liveModelBySession.
        // Both cold and hot passes derive empty-sentinel eligibility from resolvedProviderID.
        // Postprocessing must reuse resolvedProviderID rather than resolve the provider again.
        const resolvedProviderID = modelForBudget?.providerID;
        const canUseEmptySentinels = modelAcceptsEmptyContent(resolvedProviderID);
        const resolvedContextLimit = modelForBudget
            ? resolveTrustedContextLimit(modelForBudget.providerID, modelForBudget.modelID, {
                  db,
                  sessionID: sessionId,
              })
            : undefined;
        const windowGeometry = modelForBudget
            ? resolveContextWindowGeometry(modelForBudget.providerID, modelForBudget.modelID, {
                  db,
                  sessionID: sessionId,
              })
            : undefined;
        const emergencyUsagePercentageEarly = usagePercentageSynthetic
            ? Math.max(95, contextUsageEarly.percentage)
            : windowGeometry?.usableHard && contextUsageEarly.inputTokens > 0
              ? (contextUsageEarly.inputTokens / windowGeometry.usableHard) * 100
              : contextUsageEarly.percentage;
        const currentModelKeyForBoundary = deps.getModelKey?.(sessionId);
        const thresholdContextLimit =
            resolvedContextLimit && resolvedContextLimit > 0
                ? resolvedContextLimit
                : contextUsageEarly.percentage > 0
                  ? contextUsageEarly.inputTokens / (contextUsageEarly.percentage / 100)
                  : undefined;
        const effectiveExecuteThresholdPercentage = resolveExecuteThreshold(
            deps.executeThresholdPercentage ?? 65,
            currentModelKeyForBoundary,
            65,
            {
                tokensConfig: deps.executeThresholdTokens,
                contextLimit: thresholdContextLimit,
                sessionId,
            },
        );
        const { forceMaterializationPercentage } = escalationBands(
            effectiveExecuteThresholdPercentage,
        );
        const persistedUsageFreshForBoundary =
            persistedUsageBeforeResets &&
            Date.now() - persistedUsageBeforeResets.updatedAt <= 10 * 60 * 1000 &&
            (persistedUsageBeforeResets.lastObservedModelKey === null ||
                currentModelKeyForBoundary === undefined ||
                piModelRefToCanonical(persistedUsageBeforeResets.lastObservedModelKey) ===
                    piModelRefToCanonical(currentModelKeyForBoundary)) &&
            (resolvedContextLimit === undefined ||
                persistedUsageBeforeResets.lastUsageContextLimit === 0 ||
                persistedUsageBeforeResets.lastUsageContextLimit === resolvedContextLimit)
                ? persistedUsageBeforeResets.usage
                : null;
        const boundaryUsageForProtectedTail = persistedUsageFreshForBoundary ?? contextUsageEarly;
        const boundaryUsageSource = persistedUsageFreshForBoundary ? "persisted" : "live";

        const historyBudgetTokens = resolveHistoryBudgetTokens(
            deps.historyBudgetPercentage,
            contextUsageEarly,
            deps.executeThresholdPercentage,
            deps.getModelKey?.(sessionId),
            deps.executeThresholdTokens,
            resolvedContextLimit,
        );
        // The ceiling does not scale with history_budget_percentage.
        // The emergency-drop limit uses the stable model limit or back-derives a limit from live usage.
        // Back-derivation is unreliable only when percentage is 0, below the emergency-drop trigger.
        // When neither limit is available, emergency drop skips and the 95% block remains the fallback.
        const emergencyCeilingLimit = thresholdContextLimit ?? 0;
        const emergencyCeilingTokens =
            Number.isFinite(emergencyCeilingLimit) && emergencyCeilingLimit > 0
                ? Math.floor(emergencyCeilingLimit * (effectiveExecuteThresholdPercentage / 100))
                : undefined;
        // With compaction off, the scheduler approves no execute pass, so pending-operation draining cannot run.
        // With compaction off, age sweeps and smart drops cannot run.
        // With compaction off, execute passes do not write the lastResponseTime watermark.
        const schedulerDecisionEarly = compactionOff
            ? ("defer" as const)
            : resolveSchedulerDecision(
                  deps.scheduler,
                  sessionMeta,
                  contextUsageEarly,
                  sessionId,
                  deps.getModelKey?.(sessionId),
                  resolvedContextLimit,
              );
        const midTurn = isMidTurn(deps, resolvedSessionId);
        const bypassReason = detectMidTurnBypassReason({
            contextUsage: contextUsageEarly,
            sessionMeta,
            historyRefreshSessions: deps.historyRefreshSessions,
            sessionId,
            effectiveExecuteThresholdPercentage,
        });

        const { midTurnAdjustedSchedulerDecision, sideEffect } = applyMidTurnDeferral({
            base: schedulerDecisionEarly,
            bypassReason,
            midTurn,
        });

        if (sideEffect === "set-flag") {
            const flagPayload = {
                id: crypto.randomUUID(),
                reason: `${schedulerDecisionEarly}-${bypassReason}`,
                recordedAt: Date.now(),
            };
            setDeferredExecutePendingIfAbsent(db, sessionId, flagPayload);
        }

        sessionLog(
            sessionId,
            `[boundary-exec] base=${schedulerDecisionEarly} bypass=${bypassReason} midTurn=${midTurn} effective=${midTurnAdjustedSchedulerDecision} sideEffect=${sideEffect}`,
        );
        // The pass captures explicit history refresh before prepareCompartmentInjection consumes it or any drain runs.
        // The explicit-history-refresh value is pass-local rather than shared deps state.
        // Concurrent transforms must not overwrite another pass's explicit or deferred attribution.
        //
        const historyRefreshExplicitBeforePrepare = deps.historyRefreshSessions.has(sessionId);
        const deferredHistoryWasPendingAtPassStart = deferredHistoryRefreshSessions.has(sessionId);
        const earlyActiveRunBlocksMaterialization =
            (getActiveCompartmentRun(sessionId) !== undefined ||
                sessionMeta.compartmentInProgress) &&
            contextUsageEarly.percentage < forceMaterializationPercentage;
        const canConsumeDeferredEarly = canConsumeDeferredOnThisPass({
            schedulerDecision: midTurnAdjustedSchedulerDecision,
            contextPercentage: contextUsageEarly.percentage,
            justAwaitedPublication: false,
            activeRunBlocksMaterialization: earlyActiveRunBlocksMaterialization,
            forceMaterializationPercentage,
        });
        const consumingDeferredEarly =
            canConsumeDeferredEarly && deferredHistoryWasPendingAtPassStart;
        const isCacheBusting = historyRefreshExplicitBeforePrepare || consumingDeferredEarly;
        const notificationParams = deps.getNotificationParams?.(sessionId) ?? {};
        const boundaryContextLimit =
            resolvedContextLimit && resolvedContextLimit > 0
                ? resolvedContextLimit
                : emergencyCeilingLimit > 0
                  ? emergencyCeilingLimit
                  : contextUsageEarly.percentage > 0
                    ? Math.round(
                          contextUsageEarly.inputTokens / (contextUsageEarly.percentage / 100),
                      )
                    : 128_000;
        const boundaryExecuteThreshold = resolveExecuteThreshold(
            deps.executeThresholdPercentage ?? 65,
            deps.getModelKey?.(sessionId),
            65,
            {
                tokensConfig: deps.executeThresholdTokens,
                contextLimit: boundaryContextLimit,
            },
        );
        let _boundarySnapshotCache: ProtectedTailBoundarySnapshot | null | undefined;
        const getRunnableBoundaryForCompartment = (
            emergencyTailScale?: 0.5 | 0.25,
        ): ProtectedTailBoundarySnapshot | null => {
            if (!canRunCompartments) return null;
            if (_boundarySnapshotCache === undefined || emergencyTailScale) {
                const snapshot = resolveOpenCodeProtectedTailBoundary({
                    db,
                    sessionId: resolvedSessionId,
                    mode: "transform-force",
                    contextLimit: boundaryContextLimit,
                    executeThresholdPercentage: boundaryExecuteThreshold,
                    usage: boundaryUsageForProtectedTail,
                    usageSource: boundaryUsageSource,
                    emergencyTailScale,
                });
                if (emergencyTailScale) return snapshot;
                _boundarySnapshotCache = snapshot;
            }
            return _boundarySnapshotCache;
        };
        const getEligibleHistoryForCompartment = (): boolean => {
            const snapshot = getRunnableBoundaryForCompartment();
            if (snapshot !== null && hasRunnableCompartmentWindow(snapshot)) return true;
            if (process.env.NODE_ENV === "test" && !emergencyRecoveryArmed) {
                return hasRunnableCompartmentWindow(
                    createDefaultBoundarySnapshotForTests(sessionId),
                );
            }
            return false;
        };
        let skipCompartmentAwaitForThisPass = false;

        const startRecoveryRun = (): boolean => {
            const scale = emergencyUsagePercentageEarly >= 95 ? 0.25 : 0.5;
            let boundarySnapshot = getRunnableBoundaryForCompartment();
            if (!boundarySnapshot || !hasRunnableCompartmentWindow(boundarySnapshot)) {
                boundarySnapshot = getRunnableBoundaryForCompartment(scale);
            }
            if (
                process.env.NODE_ENV === "test" &&
                !emergencyRecoveryArmed &&
                (!boundarySnapshot || !hasRunnableCompartmentWindow(boundarySnapshot))
            ) {
                const legacyTestSnapshot = createDefaultBoundarySnapshotForTests(sessionId);
                if (hasRunnableCompartmentWindow(legacyTestSnapshot)) {
                    boundarySnapshot = legacyTestSnapshot;
                }
            }
            if (
                !canRunCompartments ||
                !deps.client ||
                !boundarySnapshot ||
                !hasRunnableCompartmentWindow(boundarySnapshot)
            ) {
                return false;
            }
            if (getActiveCompartmentRun(sessionId)) {
                return false;
            }

            updateSessionMeta(db, sessionId, { compartmentInProgress: true });
            startCompartmentAgent({
                client: deps.client,
                db,
                sessionId,
                historianChunkTokens: deps.getHistorianChunkTokens?.() ?? 20_000,
                boundarySnapshot,
                currentContextLimit: boundaryContextLimit,
                historyBudgetTokens,
                historianTimeoutMs: deps.historianTimeoutMs,
                fallbackModels: deps.fallbackModels,
                directory: compartmentDirectory,
                fallbackModelId,
                getNotificationParams: () => notificationParams,
                experimentalUserMemories: deps.experimentalUserMemories,
                experimentalTemporalAwareness: deps.experimentalTemporalAwareness,
                historianTwoPass: deps.historianTwoPass,
                memoryEnabled: deps.memoryConfig?.enabled,
                autoPromote: deps.memoryConfig?.autoPromote,
                ensureProjectRegistered: deps.ensureProjectRegistered,
                // Historian publication invalidates the injection cache because it changes the compartments and facts rendered into message[0].
                // signal:
                // A materializing pass rebuilds deferred history only when it can consume history and drops together.
                // deferredMaterializationSessions queues drops for a later materializing pass.
                // deferredMaterializationSessions retains historian-published drops until a materializing pass consumes them.
                // Historian publication does not change disk-backed adjuncts, so `systemPromptRefreshSessions` remains unsignaled.
                preserveInjectionCacheUntilConsumed: true,
                onCompartmentStatePublished: (sid) => {
                    deferredHistoryRefreshSessions.add(sid);
                    deferredMaterializationSessions.add(sid);
                },
            });
            skipCompartmentAwaitForThisPass = true;
            return true;
        };

        if (
            fullFeatureMode &&
            !compactionOff &&
            historianFailureState.failureCount > 0 &&
            emergencyUsagePercentageEarly >= 95 &&
            !recoveryNoHeadEscapeActive
        ) {
            skipCompartmentAwaitForThisPass = true;
            const emergencyPercentage = contextUsageEarly.percentage.toFixed(1);
            const recoveryStarted = startRecoveryRun();
            // Recovery remains armed until the protected tail closes.
            if (!recoveryStarted && !getEligibleHistoryForCompartment()) {
                const noHeadSnapshot =
                    getRunnableBoundaryForCompartment(
                        emergencyUsagePercentageEarly >= 95 ? 0.25 : 0.5,
                    ) ?? getRunnableBoundaryForCompartment();
                if (noHeadSnapshot) {
                    recordHighPressureNoEligibleHead(db, noHeadSnapshot);
                }
                sessionLog(
                    sessionId,
                    "transform: emergency recovery remains armed — no complete eligible head before protected tail",
                );
            }
            sessionLog(
                sessionId,
                `EMERGENCY: historian recovery requested at ${emergencyPercentage}%, failures: ${historianFailureState.failureCount}`,
            );
        } else if (
            fullFeatureMode &&
            !compactionOff &&
            isFirstTransformPassForSession &&
            historianFailureState.failureCount > 0 &&
            getEligibleHistoryForCompartment() &&
            startRecoveryRun()
        ) {
            sessionLog(
                sessionId,
                `transform: historian recovery triggered on session load after ${historianFailureState.failureCount} failure(s)`,
            );
            if (deps.client) {
                void sendIgnoredMessage(
                    deps.client,
                    sessionId,
                    `## Historian recovery\n\nHistorian previously failed ${historianFailureState.failureCount} time(s), so Magic Context is retrying history comparting immediately after restart.`,
                    notificationParams,
                );
            }
        }

        logTransformTiming(sessionId, "emergencyRecoveryBlock", tFirstPass);

        const memoryProjectDirectory = compartmentDirectory || process.cwd();
        const projectIdentity = deps.memoryConfig?.enabled
            ? resolveProjectIdentity(memoryProjectDirectory)
            : undefined;
        if (deps.memoryConfig?.enabled) {
            maybeSendProjectIdentityWarning(
                deps,
                sessionId,
                memoryProjectDirectory,
                notificationParams,
            );
        }
        if (projectIdentity) {
            // pass.
            try {
                revalidateEnforcementArtifacts(
                    db,
                    projectIdentity,
                    resolveProjectRootDirectory(memoryProjectDirectory),
                );
            } catch (error) {
                sessionLog(
                    sessionId,
                    `enforcement artifact revalidation failed (retrying next pass): ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
        // Nudges and auto-search use the session's project identity.
        const sessionProjectIdentity =
            projectIdentity ??
            (sessionDirectory ? resolveProjectIdentity(sessionDirectory) : deps.projectPath);
        const sessionIdentityForBinding = sessionDirectory
            ? resolveProjectIdentityForSession(sessionDirectory, deps.allowHomeProject)
            : undefined;
        if (sessionDirectory) {
            maybeSendProjectIdentityWarning(deps, sessionId, sessionDirectory, notificationParams);
        }
        // Memory-enabled projects use their MC identity, never a raw path.
        // Scheduling only starts background recovery; this transform continues normally.
        const authorityProjectPath =
            (deps.memoryConfig?.enabled ? projectIdentity : undefined) ??
            deps.projectPath ??
            sessionProjectIdentity;
        if (authorityProjectPath) {
            scheduleTsAuthorityRecovery({
                db,
                projectPath: authorityProjectPath,
                projectRoot: sessionDirectory || memoryProjectDirectory,
                module: deps.tsAuthorityRecoveryModuleClient,
            });
        }
        // The transform persists only host-resolved session bindings.
        // The launch-directory fallback keeps transforms non-fatal.
        // The transform does not persist the launch-directory fallback as ownership because a transient SDK failure could permanently mis-scope chunk backfills.
        if (
            sessionIdentityForBinding &&
            sessionDirectoryResolvedFromHost &&
            recordedSessionProjectIdentity.get(sessionId) !== sessionIdentityForBinding
        ) {
            recordSessionProjectIdentity(db, sessionId, sessionIdentityForBinding);
            recordedSessionProjectIdentity.set(sessionId, sessionIdentityForBinding);
        }

        // `messages` contains the post-compaction-marker eligible tail as parsed objects.
        // Trigger inspection does not read `opencode.db`.
        // The transform evaluates the trigger once per LLM request because its inputs change only then.
        // `messages` is still the clean pre-injection, pre-mutation tail.
        // The transform mutates `sessionMeta` when `shouldFire` so `runCompartmentPhase` starts the historian in the same pass.
        // The caller passes the resolved boundary snapshot to avoid resolving it again.
        // re-resolve it.
        // The transform derives `taggerFloor` from raw wire IDs so the trigger and tagger scans share a scope.
        // `taggerFloor` defines the scope for trigger scans and `initFromDb`.
        // The transform derives `taggerFloor` from raw wire IDs because `inMemoryTail` can be unavailable without a compaction anchor.
        // `taggerFloor` requires only leading wire IDs.
        const taggerFloor = compactionOff ? 0 : deriveTaggerLoadFloor(messages, sessionId, db);
        // When `taggerFloor` is `0`, both tag scans use the full history.
        if (!compactionOff && taggerFloor === 0 && messages.length > 0) {
            sessionLog(
                sessionId,
                `tag floor: 0 (full-scan fallback) — no leading wire message resolved a tag across ${messages.length} msgs`,
            );
        }

        let triggerBoundarySnapshot: ProtectedTailBoundarySnapshot | undefined;
        if (
            fullFeatureMode &&
            !compactionOff &&
            historianRunnable &&
            !sessionMeta.compartmentInProgress
        ) {
            const tTrigger = performance.now();
            try {
                const inMemoryTail = buildTriggerInMemoryTail(
                    db,
                    sessionId,
                    extractInMemoryMessageViews(messages),
                );
                const triggerResult = checkCompartmentTrigger(
                    db,
                    sessionId,
                    sessionMeta,
                    boundaryUsageForProtectedTail,
                    sessionMeta.lastContextPercentage,
                    boundaryExecuteThreshold,
                    deriveTriggerBudget(boundaryContextLimit, boundaryExecuteThreshold),
                    deps.clearReasoningAge,
                    deps.commitClusterTrigger,
                    undefined,
                    boundaryContextLimit,
                    inMemoryTail,
                    taggerFloor,
                    { providerID: resolvedProviderID },
                );
                if (triggerResult.shouldFire) {
                    sessionLog(
                        sessionId,
                        `compartment trigger: firing (reason=${triggerResult.reason})`,
                    );
                    updateSessionMeta(db, sessionId, { compartmentInProgress: true });
                    sessionMeta.compartmentInProgress = true;
                    triggerBoundarySnapshot = triggerResult.boundarySnapshot;
                }
            } catch (error) {
                passOutcome.record("compartment-trigger-failure");
                sessionLog(sessionId, "compartment trigger failed (non-fatal):", error);
            }
            logTransformTiming(sessionId, "compartmentTrigger", tTrigger);
        }

        let pendingCompartmentInjection: PreparedCompartmentInjection | null = null;
        let rebuiltHistoryFromInitialPrepare = false;
        // Compaction-off skips preparation even when historical compartment rows exist.
        // Compaction-off renders no `<session-history>`, trims no raw tail, splices no boundary, and writes no marker.
        if (fullFeatureMode && !compactionOff) {
            const tInj = performance.now();
            pendingCompartmentInjection = prepareCompartmentInjection(
                db,
                sessionId,
                messages,
                isCacheBusting,
                projectIdentity,
                deps.memoryConfig?.injectionBudgetTokens,
                deps.experimentalTemporalAwareness,
            );
            logTransformTiming(sessionId, "prepareCompartmentInjection", tInj);

            // The transform consumes each `historyRefreshSessions` entry once.
            // The injection rebuild is the messages-transform path's only `historyRefreshSessions` consumer.
            // Cached injection results keep the Anthropic prompt-cache prefix stable within the TTL window.
            // Draining `historyRefreshSessions` does not change the captured `isCacheBusting` value in this pass.
            //
            // Calling `prepareCompartmentInjection` consumes the one-shot deferred-history signal.
            if (isCacheBusting) {
                // The transform records a history rebuild even when `prepareCompartmentInjection` returns no injection.
                // `compartmentInjectionRebuiltFromDb` reports only an actual database rebuild.
                rebuiltHistoryFromInitialPrepare = true;
            }
            if (historyRefreshExplicitBeforePrepare) {
                deps.historyRefreshSessions.delete(sessionId);
            }
        }

        let targets = new Map<number, TagTarget>();
        // ──────────────────────────────────────────────────────────────────────

        let reasoningByMessage = new Map<
            MessageLike,
            { type: string; thinking?: string; text?: string }[]
        >();
        let messageTagNumbers = new Map<MessageLike, number>();
        let batch: { finalize: () => void } | null = null;
        let hasRecentReduceCall = false;
        // `injectTemporalMarkers` runs before tagging so each `§N§` prefix wraps a marker.
        //
        // that safe:
        //
        if (deps.experimentalTemporalAwareness && !compactionOff) {
            const tTemporal = performance.now();
            const injected = injectTemporalMarkers(messages);
            if (injected > 0) {
                sessionLog(sessionId, `temporal: injected ${injected} gap markers`);
            }
            logTransformTiming(sessionId, "injectTemporalMarkers", tTemporal);
        }

        let taggingSucceeded = false;
        // Compaction-off mode writes no tag rows and emits no `§N§` prefixes.
        // When compactionOff becomes false, tagMessages assigns tags to untagged messages.
        if (!compactionOff) {
            try {
                const t0 = performance.now();
                const tInitFromDb = performance.now();
                deps.tagger.initFromDb(sessionId, db, taggerFloor);
                logTransformTiming(sessionId, "tag.initFromDb", tInitFromDb);
                // `skipPrefixInjection` suppresses agent-visible `§N§` prefixes while retaining DB tags when `ctxReduceCallable` is false.
                const skipPrefixInjection = !ctxReduceCallable;
                const result = tagMessages(sessionId, messages, deps.tagger, db, {
                    skipPrefixInjection,
                });
                targets = result.targets;
                reasoningByMessage = result.reasoningByMessage;
                messageTagNumbers = result.messageTagNumbers;
                batch = result.batch;
                hasRecentReduceCall = result.hasRecentReduceCall;
                const hadPriorCommitState = deps.commitSeenLastPass?.has(sessionId) ?? false;
                const sawCommitLastPass = deps.commitSeenLastPass?.get(sessionId) ?? false;
                // Triggering requires commit state from a prior pass.
                // The first pass establishes commit state without triggering.
                if (
                    fullFeatureMode &&
                    hadPriorCommitState &&
                    result.hasRecentCommit &&
                    !sawCommitLastPass
                ) {
                    onNoteTrigger(db, sessionId, "commit_detected");
                }
                deps.commitSeenLastPass?.set(sessionId, result.hasRecentCommit);
                logTransformTiming(sessionId, "tagMessages", t0);
                taggingSucceeded = true;
            } catch (error) {
                passOutcome.record("tagging-persistence-failure");
                sessionLog(
                    sessionId,
                    "transform tag persistence failed; continuing without tagging:",
                    error,
                );
                // cleanup forces the next pass to reload the tagger from the DB.
                // Reloading prevents stale tagger state from repeating UNIQUE collisions.
                // A stale assignments map can repeat a UNIQUE collision.
                // tagger.assignTag allocates tags from the DB, so reloading restores authoritative state.
                try {
                    deps.tagger.cleanup(sessionId);
                } catch (cleanupError) {
                    sessionLog(sessionId, "tagger cleanup after failure threw:", cleanupError);
                }
            }
        }

        // Targeted queries avoid loading every tag in the session.
        //
        // activeTags limits heuristic cleanup, nudger, and caveman scope to active tags.
        // targetsSliceTags supplies the visible target subset to applyFlushedStatuses and caveman replay.
        // The lookup uses an IN list over the existing (session_id, tag_number) index.
        //
        // applyHeuristicCleanup and nudger ignore non-active tags, so active-only input preserves behavior.
        // applyFlushedStatuses and caveman replay ignore tag numbers outside targets.
        // Prefiltering tag numbers to targets preserves applyFlushedStatuses and caveman replay behavior.
        const t1 = performance.now();
        const activeTags = compactionOff ? [] : getActiveTagsBySession(db, sessionId);
        logTransformTiming(sessionId, "getActiveTagsBySession", t1, `count=${activeTags.length}`);

        const t1b = performance.now();
        const targetTagNumbers = [...targets.keys()];
        const targetsSliceTags = compactionOff
            ? []
            : getTagsByNumbers(db, sessionId, targetTagNumbers);
        logTransformTiming(
            sessionId,
            "getTagsByNumbers",
            t1b,
            `targets=${targetTagNumbers.length} fetched=${targetsSliceTags.length}`,
        );

        let didMutateFromFlushedStatuses = false;
        // Mutation stages run only after successful tagging because failed tagging leaves `targets` empty.
        // Without targets, applyFlushedStatuses cannot persist drops.
        if (taggingSucceeded) {
            try {
                const t2 = performance.now();
                didMutateFromFlushedStatuses = applyFlushedStatuses(
                    sessionId,
                    db,
                    targets,
                    targetsSliceTags,
                );
                logTransformTiming(sessionId, "applyFlushedStatuses", t2);
                batch?.finalize();
                logTransformTiming(sessionId, "batchFinalize:flushed", t2);
            } catch (error) {
                passOutcome.record("flushed-status-failure");
                sessionLog(sessionId, "transform failed applying flushed statuses:", error);
            }
        }

        const t3 = performance.now();
        const strippedStructuralNoise =
            canUseEmptySentinels && !compactionOff ? stripStructuralNoise(messages) : 0;
        logTransformTiming(
            sessionId,
            "stripStructuralNoise",
            t3,
            `strippedParts=${strippedStructuralNoise}`,
        );

        const persistedReasoningWatermark = sessionMeta?.clearedReasoningThroughTag ?? 0;
        if (persistedReasoningWatermark > 0 && !compactionOff) {
            const tReplay = performance.now();
            const replayed = canUseEmptySentinels
                ? replayClearedReasoning(
                      messages,
                      reasoningByMessage,
                      messageTagNumbers,
                      persistedReasoningWatermark,
                  )
                : 0;
            const replayedInline = replayStrippedInlineThinking(
                messages,
                messageTagNumbers,
                persistedReasoningWatermark,
            );
            if (replayed > 0 || replayedInline > 0) {
                sessionLog(
                    sessionId,
                    `reasoning replay: cleared=${replayed} inlineStripped=${replayedInline} (watermark=${persistedReasoningWatermark})`,
                );
            }
            logTransformTiming(sessionId, "replayReasoningClearing", tReplay);
        }

        // first place.
        //
        if (!reducedMode && !compactionOff && deps.cavemanTextCompression?.enabled) {
            const tCavemanReplay = performance.now();
            const replayedCaveman = replayCavemanCompression(
                sessionId,
                db,
                targets,
                targetsSliceTags,
            );
            if (replayedCaveman > 0) {
                sessionLog(sessionId, `caveman replay: re-applied ${replayedCaveman} text tags`);
            }
            logTransformTiming(sessionId, "replayCavemanCompression", tCavemanReplay);
        }

        const t4 = performance.now();
        const strippedClearedReasoning =
            canUseEmptySentinels && !compactionOff ? stripClearedReasoning(messages) : 0;
        logTransformTiming(
            sessionId,
            "stripClearedReasoning",
            t4,
            `strippedParts=${strippedClearedReasoning}`,
        );

        const watermark = getMaxDroppedTagNumber(db, sessionId);

        const contextUsage = contextUsageEarly;
        const schedulerDecision = midTurnAdjustedSchedulerDecision;
        const rawGetNotifParams = deps.getNotificationParams;
        const tCompartmentPhase = performance.now();
        const compartmentPhase = await runCompartmentPhase({
            canRunCompartments,
            fullFeatureMode,
            compactionOff,
            historianRunnable,
            sessionMeta,
            contextUsage,
            boundaryContextLimit,
            boundaryExecuteThresholdPercentage: boundaryExecuteThreshold,
            boundaryUsage: boundaryUsageForProtectedTail,
            boundaryUsageSource,
            preResolvedBoundarySnapshot: triggerBoundarySnapshot,
            client: deps.client,
            db,
            sessionId,
            resolvedSessionId,
            historianChunkTokens: deps.getHistorianChunkTokens?.() ?? 20_000,
            historyBudgetTokens,
            historianTimeoutMs: deps.historianTimeoutMs,
            fallbackModels: deps.fallbackModels,
            compartmentDirectory,
            messages,
            pendingCompartmentInjection,
            fallbackModelId,
            projectPath: projectIdentity,
            injectionBudgetTokens: deps.memoryConfig?.injectionBudgetTokens,
            getNotificationParams: rawGetNotifParams
                ? () => rawGetNotifParams(sessionId)
                : undefined,
            safeForBackgroundCompression:
                historianRunnable &&
                (isCacheBusting || midTurnAdjustedSchedulerDecision === "execute"),
            deferredHistoryRefreshSessions,
            skipAwaitForThisPass: skipCompartmentAwaitForThisPass,
            experimentalUserMemories: deps.experimentalUserMemories,
            experimentalTemporalAwareness: deps.experimentalTemporalAwareness,
            historianTwoPass: deps.historianTwoPass,
            // memory.auto_promote.
            memoryEnabled: deps.memoryConfig?.enabled,
            autoPromote: deps.memoryConfig?.autoPromote,
            ensureProjectRegistered: deps.ensureProjectRegistered,
            onCompartmentStatePublished: (sid) => {
                deferredHistoryRefreshSessions.add(sid);
                deferredMaterializationSessions.add(sid);
            },
        });
        pendingCompartmentInjection = compartmentPhase.pendingCompartmentInjection;
        const awaitedCompartmentRun = compartmentPhase.awaitedCompartmentRun;
        const compartmentInProgress = compartmentPhase.compartmentInProgress;
        sessionMeta = { ...sessionMeta, compartmentInProgress };
        logTransformTiming(sessionId, "compartmentPhase", tCompartmentPhase);

        if (pendingCompartmentInjection?.needsFreshMaterialization) {
            deps.pendingMaterializationSessions.add(sessionId);
            deferredMaterializationSessions.add(sessionId);
        }

        const hardModel = deps.liveModelBySession?.get(sessionId);
        const hardModelKey = hardModel ? `${hardModel.providerID}/${hardModel.modelID}` : "";
        const hardSystemHash =
            typeof sessionMeta.systemPromptHash === "string" ? sessionMeta.systemPromptHash : "";
        const hardCacheExpired = computeHardCacheExpired(
            sessionMeta.cacheTtl,
            sessionMeta.lastResponseTime,
            Date.now(),
            (error) => {
                passOutcome.record("invalid-cache-ttl-fallback");
                sessionLog(sessionId, "invalid cache_ttl; using the 5m default:", error);
            },
        );
        const m0HardSignals = {
            systemHash: hardSystemHash,
            modelKey: hardModelKey,
            cacheExpired: hardCacheExpired,
            lastResponseTime: sessionMeta.lastResponseTime,
        };

        const lateActiveRunBlocksMaterialization =
            getActiveCompartmentRun(sessionId) !== undefined &&
            contextUsageEarly.percentage < forceMaterializationPercentage;
        const canConsumeDeferredLate = canConsumeDeferredOnThisPass({
            schedulerDecision: midTurnAdjustedSchedulerDecision,
            contextPercentage: contextUsageEarly.percentage,
            justAwaitedPublication: compartmentPhase.justAwaitedPublication,
            activeRunBlocksMaterialization: lateActiveRunBlocksMaterialization,
            forceMaterializationPercentage,
        });
        const wasEmergencyBlock =
            contextUsageEarly.percentage >= forceMaterializationPercentage &&
            compartmentPhase.justAwaitedPublication;
        const historyRebuiltThisPass = wasEmergencyBlock
            ? compartmentPhase.rebuiltHistoryThisPass
            : rebuiltHistoryFromInitialPrepare || compartmentPhase.rebuiltHistoryThisPass;

        const tPostProcess = performance.now();
        const postTransformResult = await runPostTransformPhase({
            sessionId,
            db,
            messages,
            // applyPendingOperations lazy-loads tags when no preload is provided.
            tags: activeTags,
            targets,
            reasoningByMessage,
            messageTagNumbers,
            tagger: deps.tagger,
            ctxReduceAvailability,
            channel1StateBySession: deps.channel1StateBySession,
            todowriteAvailability,
            client: deps.client,
            activeAgent,
            batch,
            contextUsage,
            schedulerDecision,
            fullFeatureMode,
            compactionOff,
            canRunCompartments,
            awaitedCompartmentRun,
            phaseJustAwaitedPublication: compartmentPhase.justAwaitedPublication,
            compartmentInProgress,
            historyRefreshExplicitBeforePrepare,
            deferredHistoryWasPendingAtPassStart,
            compartmentInjectionRebuiltFromDb: pendingCompartmentInjection?.rebuiltFromDb === true,
            rebuiltHistoryFromInitialPrepare,
            historyRebuiltThisPass,
            canConsumeDeferredLate,
            sessionMeta,
            currentTurnId,
            // Postprocess uses pendingMaterializationSessions to determine whether `/ctx-flush`-style materialization is queued.
            // Postprocess drains pendingMaterializationSessions after heuristics run; it does not use the history-refresh set.
            // Postprocess does not refresh `<session-history>`.
            pendingMaterializationSessions: deps.pendingMaterializationSessions,
            deferredHistoryRefreshSessions,
            deferredMaterializationSessions,
            lastHeuristicsTurnId: deps.lastHeuristicsTurnId,
            clearReasoningAge: deps.clearReasoningAge,
            protectedTags: deps.protectedTags,
            emergencyCeilingTokens,
            pendingCompartmentInjection,
            didMutateFromFlushedStatuses,
            watermark,
            forceMaterializationPercentage,
            hasRecentReduceCall,
            // Note-nudge and auto-search must use sessionProjectIdentity to target the resumed session's project.
            projectPath: sessionProjectIdentity,
            sessionDirectory,
            autoSearch: deps.autoSearch,
            // Subagents must not receive cavemanTextCompression because the spawning primary agent already curates their context.
            cavemanTextCompression: !reducedMode ? deps.cavemanTextCompression : undefined,
            smartDrops: deps.smartDrops === true,
            // Postprocess receives resolvedProviderID so provider-dependent decisions remain consistent for the transform pass.
            // resolvedProviderID keeps empty-sentinel gates and whole-message placeholder selection consistent.
            // Cold DB-recovered passes receive resolvedProviderID.
            resolvedProviderID,
            passOutcome,
            historyRefreshSessions: deps.historyRefreshSessions,
            m0M1: {
                // m0M1.projectPath must remain undefined when memory.enabled=false.
                // materializeM0 must not fall back to deps.projectPath because any projectPath injects memory.
                // projectDirectory independently drives docs, key files, and history.
                // disable those.
                projectPath: projectIdentity,
                projectDirectory: sessionDirectory,
                injectDocs: deps.injectDocs,
                memoryInjectionBudgetTokens: deps.memoryConfig?.injectionBudgetTokens,
                historyBudgetTokens,
                temporalAwareness: deps.experimentalTemporalAwareness,
                hardSignals: m0HardSignals,
                muralEnabled: deps.muralEnabled,
            },
        });
        passOutcome.markFinalized();
        // compactionOff disables force-band drops, the 95% block, and the overflow-recovery latch.
        // The off-transition clears the persisted overflow-recovery latch without consuming it.
        // With compactionOff, overflow reaches native compaction instead of blocking.
        const finalWireTail = describeFinalWireTail(messages);
        let finalWireEstimate: ReturnType<typeof estimateFinalWireInputTokens> | undefined;
        if (!compactionOff) {
            // The code fresh-tokenizes only in the emergency band; the estimate is telemetry.
            // module-side implementation.
            const emergencyUsagePercentage = usagePercentageSynthetic
                ? Math.max(95, contextUsage.percentage)
                : windowGeometry?.usableHard && contextUsage.inputTokens > 0
                  ? (contextUsage.inputTokens / windowGeometry.usableHard) * 100
                  : contextUsage.percentage;
            finalWireEstimate =
                emergencyUsagePercentage >= 95
                    ? estimateFinalWireInputTokens({
                          messages,
                          systemPromptTokens: sessionMeta.systemPromptTokens,
                          providerID: modelForBudget?.providerID,
                          modelID: modelForBudget?.modelID,
                          agentName: notificationParams.agent,
                      })
                    : undefined;
            if (finalWireEstimate) {
                sessionLog(
                    sessionId,
                    `transform: final-wire telemetry estimate=${finalWireEstimate.tokens} trusted=${finalWireEstimate.trusted} conversation=${finalWireEstimate.messageTokens.conversation} tools=${finalWireEstimate.messageTokens.toolCall} system=${finalWireEstimate.systemTokens} toolDefinitions=${finalWireEstimate.toolDefinitionTokens ?? "unknown"} tail=${finalWireTail}`,
                );
            }
            const currentModelKeyForRecovery = deps.getModelKey?.(sessionId);
            const overflowStateForFinalWire = getOverflowState(
                db,
                sessionId,
                currentModelKeyForRecovery,
            );
            // A catalog or user-configured limit cannot prove that this provider accepts the recovered wire shape.
            // An overflow response from the active model disarms recovery.
            const providerProvenLimitTokens =
                typeof currentModelKeyForRecovery === "string" &&
                currentModelKeyForRecovery.length > 0 &&
                overflowStateForFinalWire.detectedContextLimit > 0 &&
                piModelRefToCanonical(
                    overflowStateForFinalWire.detectedContextLimitModelKey ?? "",
                ) === piModelRefToCanonical(currentModelKeyForRecovery)
                    ? overflowStateForFinalWire.detectedContextLimit
                    : undefined;
            const emergencyFailClosed = evaluateEmergencyFailClosed({
                usagePercentage: emergencyUsagePercentage,
                emergencyRecoveryArmed,
                emergencyRecoveryOrigin,
                foldMaterializedThisPass: postTransformResult.historianFoldMaterializedThisPass,
                finalWireEstimate,
                providerProvenLimitTokens,
            });
            if (emergencyFailClosed.disarm) {
                clearEmergencyRecovery(db, sessionId);
                sessionLog(
                    sessionId,
                    `emergency disarm: trusted final-wire ${emergencyFailClosed.disarm.finalWireTokens} under limit ${emergencyFailClosed.disarm.provenLimitTokens}`,
                );
            }
            if (emergencyFailClosed.shouldAbort) {
                if (!deps.client) {
                    throw new EmergencyFailClosedError(
                        "Cannot fail closed: OpenCode client is unavailable",
                    );
                }
                // The recovery notice must finish before self-abort so recovery instructions survive interruption.
                let notification: Awaited<ReturnType<typeof sendIgnoredMessage>>;
                try {
                    notification = await sendIgnoredMessage(
                        deps.client,
                        sessionId,
                        "Context full — /ctx-flush or /clear to continue.",
                        notificationParams,
                    );
                } catch (error) {
                    throw new EmergencyFailClosedError("Emergency recovery notification failed", {
                        cause: error,
                    });
                }
                if (notification !== "sent" && notification !== "queued") {
                    throw new EmergencyFailClosedError(
                        `Emergency recovery notification was ${notification}`,
                    );
                }
                try {
                    await abortSessionFailClosed(deps.client, sessionId);
                } catch (error) {
                    sessionLog(
                        sessionId,
                        "transform: emergency fail-closed abort failed; refusing to return a sendable prompt:",
                        getErrorMessage(error),
                    );
                    throw new EmergencyFailClosedError("Emergency recovery abort failed", {
                        cause: error,
                    });
                }
                // The retry must clear the stale-sample latch because aborting prevents a fresh provider usage sample.
                try {
                    clearEmergencyDropSample(db, sessionId);
                } catch (error) {
                    throw new EmergencyFailClosedError("Emergency recovery cleanup failed", {
                        cause: error,
                    });
                }
                sessionLog(
                    sessionId,
                    `EMERGENCY: fail-closed (reason=${emergencyFailClosed.reason}, recoveryOrigin=${emergencyRecoveryOrigin ?? "unknown"}, finalEstimate=${finalWireEstimate?.tokens ?? "unavailable"}, estimateTrusted=${finalWireEstimate?.trusted ?? false}, syntheticUsage=${usagePercentageSynthetic})`,
                );
                return;
            }
        }
        if (!finalWireEstimate) {
            sessionLog(
                sessionId,
                `transform: final-wire telemetry estimate=unavailable trusted=false conversation=unknown tools=unknown system=unknown toolDefinitions=unknown tail=${finalWireTail}`,
            );
        }

        if (passOutcome.captureEligible) {
            const keys = resolveLkgModelKeys(messages);
            const modelKey = modelForBudget
                ? `${modelForBudget.providerID}/${modelForBudget.modelID}`
                : keys.modelKey;
            const providerKey = modelForBudget?.providerID ?? keys.providerKey;
            const captured = captureLkgSlot({
                sessionId,
                input: lkgInput,
                output: messages,
                modelKey,
                providerKey,
            });
            if (postTransformResult.bustedThisPass && !captured) {
                dropSlot(sessionId, "lkg_refresh_declined");
            }
        } else if (passOutcome.degradations.length > 0) {
            sessionLog(
                sessionId,
                `lkg_capture_declined degradations=${passOutcome.degradations.map((item) => item.site).join(",")}`,
            );
        }

        if (postTransformResult.bustedThisPass) {
            recordPendingTransformDecision(sessionId, {
                tsMs: Date.now(),
                decision: schedulerDecision,
                materialized: postTransformResult.materialized,
                materializeReason: normalizeMaterializeReason(
                    "opencode",
                    postTransformResult.materializeReason,
                    postTransformResult.materialized,
                ),
                emergency: postTransformResult.emergency,
                droppedTokens: postTransformResult.droppedTokens,
                droppedCount: postTransformResult.droppedCount,
                inputTokens: contextUsage.inputTokens,
                bustedThisPass: true,
            });
        }
        logTransformTiming(sessionId, "postTransformPhase", tPostProcess);

        // The sidebar attributes inputTokens across System, Tool Definitions, and Conversation.
        // compartments/facts/memories).
        //
        // The token count includes text, reasoning, tool inputs, tool outputs, and tool_result content from every Anthropic message-part type.
        // user/assistant conversation.
        //                        actually wrote/read
        //
        // estimate.
        const msgTokens = getMessageTokensCache(sessionId);
        // The tag store persists per-message token counts, allowing cold passes to avoid re-tokenizing tagged messages.
        // A NULL-count tag requires live token estimation.
        let storedByMessage: Map<
            string,
            { conversation: number; toolCall: number; hasNull: boolean }
        >;
        try {
            storedByMessage = getActiveTagTokenTotalsByMessage(db, sessionId);
        } catch {
            storedByMessage = new Map();
        }
        let conversationTokens = 0;
        let toolCallTokens = 0;
        for (const message of messages) {
            const mid = (message.info as { id?: string }).id;
            if (mid) {
                const cached = msgTokens.get(mid);
                if (cached) {
                    conversationTokens += cached.conversation;
                    toolCallTokens += cached.toolCall;
                    continue;
                }
                const stored = storedByMessage.get(mid);
                if (stored && !stored.hasNull) {
                    conversationTokens += stored.conversation;
                    toolCallTokens += stored.toolCall;
                    msgTokens.set(mid, {
                        conversation: stored.conversation,
                        toolCall: stored.toolCall,
                    });
                    continue;
                }
            }
            const estimated = estimateMessageTokens(message);
            if (mid) msgTokens.set(mid, estimated);
            conversationTokens += estimated.conversation;
            toolCallTokens += estimated.toolCall;
        }
        try {
            updateSessionMeta(db, sessionId, { conversationTokens, toolCallTokens });
        } catch (error) {
            // Token telemetry update failures must not fail the transform.
            const code = (error as { code?: string } | null)?.code;
            if (code !== "SQLITE_BUSY") {
                sessionLog(sessionId, "conversation_tokens UPDATE failed:", error);
            }
        }

        const channelBaseline = deps.channel1StateBySession?.get(sessionId);
        if (ctxReduceCallable && !compactionOff && channelBaseline) {
            const measuredU = Math.min(
                Math.max(0, channelBaseline.baselineT + channelBaseline.turnDeltaT),
                Math.max(0, channelBaseline.baselineU + channelBaseline.turnDeltaU),
            );
            resetLastNudgeCycleIfTailShrank(db, sessionId, measuredU);
            if (
                channelBaseline.evaluable &&
                !channelBaseline.generationInvalidated &&
                !channelBaseline.reducedSinceRefresh
            ) {
                const channel2Evaluation = evaluateChannel2(channelBaseline);
                try {
                    if (channel2Evaluation.shouldTrigger) {
                        casChannel2NudgeState(db, sessionId, "", "pending");
                    } else {
                        casChannel2NudgeState(db, sessionId, "pending", "");
                    }
                } catch (error) {
                    sessionLog(sessionId, "channel2 trigger CAS failed (ignored):", error);
                }
            }
        }

        const elapsed = (performance.now() - startTime).toFixed(1);
        sessionLog(
            sessionId,
            `transform completed in ${elapsed}ms (${messages.length} messages, ${targets.size} targets, watermark: ${watermark})`,
        );

        deps.maybeAutoEmbedSession?.(sessionId);
    };

    return Object.assign(transform, {
        invalidateRustWireState(sessionId: string): void {
            rustModeTransform?.invalidateWireState(sessionId);
        },
        clearRustSession(sessionId: string): void {
            rustModeTransform?.clearSession(sessionId);
        },
    });
}

export function resolveHistoryBudgetTokens(
    historyBudgetPercentage: number | undefined,
    contextUsage: ContextUsage,
    executeThresholdPercentage:
        | number
        | { default: number; [modelKey: string]: number }
        | undefined,
    modelKey: string | undefined,
    executeThresholdTokens?: { default?: number; [modelKey: string]: number | undefined },
    resolvedContextLimit?: number,
): number | undefined {
    if (!historyBudgetPercentage) {
        return undefined;
    }

    let contextLimit = resolvedContextLimit && resolvedContextLimit > 0 ? resolvedContextLimit : 0;
    if (contextLimit <= 0) {
        if (contextUsage.percentage <= 0) {
            return undefined;
        }
        contextLimit = contextUsage.inputTokens / (contextUsage.percentage / 100);
    }
    if (!Number.isFinite(contextLimit) || contextLimit <= 0) {
        return undefined;
    }

    return Math.floor(
        contextLimit *
            (resolveExecuteThreshold(executeThresholdPercentage ?? 65, modelKey, 65, {
                tokensConfig: executeThresholdTokens,
                contextLimit,
            }) /
                100) *
            historyBudgetPercentage,
    );
}
