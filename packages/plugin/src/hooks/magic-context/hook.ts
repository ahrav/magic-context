import {
    isCompactionEnabled,
    isDreamerRunnable,
    isHistorianRunnable,
    isSidekickRunnable,
} from "../../config/agent-disable";
import {
    DEFAULT_HISTORIAN_TIMEOUT_MS,
    type DreamerConfig,
    type HistorianConfig,
    type SidekickConfig,
} from "../../config/schema/magic-context";
import type { ResolvedTransformMode } from "../../config/transform-mode";
import type { createCompactionHandler } from "../../features/magic-context/compaction";
import {
    applyMirrorPage,
    chainMirrorDomainSync,
    commitModuleClaimIntent,
    disposeModuleNoteEvaluationBridges,
    ensureContextStoreUuid,
    getMirrorCursor,
    getModuleNoteEvaluationBridge,
    moduleNoteEvaluationBridgeKey,
    registerModuleNoteEvaluationBridge,
    retainModuleNoteEvaluationBridge,
} from "../../features/magic-context/context-authority";
import { confirmSmartNoteReadOnly } from "../../features/magic-context/dreamer/evaluate-smart-notes";
import { openOpenCodeDb } from "../../features/magic-context/dreamer/open-opencode-db";
import { OpenCodeRetrospectiveRawProvider } from "../../features/magic-context/dreamer/retrospective-raw-provider";
import {
    buildDreamTaskRuntimeConfigs,
    userMemoryCollectionEnabled,
} from "../../features/magic-context/dreamer/task-config";
import { createDreamTaskExecutor } from "../../features/magic-context/dreamer/task-executor";
import {
    runDueTasksForProject,
    runManualDream,
} from "../../features/magic-context/dreamer/task-scheduler";
import {
    clearHookInitFailure,
    recordHookInitFailure,
} from "../../features/magic-context/fail-closed-block";
import {
    resolveProjectIdentityForSession,
    resolveProjectRootDirectory,
    takeDubiousOwnershipProjectIdentityWarning,
} from "../../features/magic-context/memory/project-identity";
import {
    embedSessionCompartmentChunks,
    getEmbeddingCoverageStatus,
} from "../../features/magic-context/project-embedding-registry";
import type { Scheduler } from "../../features/magic-context/scheduler";
import { createSmartNoteCapabilities } from "../../features/magic-context/smart-notes/capabilities";
import { compileSmartNoteCheck } from "../../features/magic-context/smart-notes/compiler";
import { SmartNoteEvaluatorWorker } from "../../features/magic-context/smart-notes/evaluator-worker";
import { runCompiledSmartNoteCheck } from "../../features/magic-context/smart-notes/sandbox-runner";
import { wakePlaneStatus } from "../../features/magic-context/smart-notes/wake-plane";
import {
    getDatabasePersistenceError,
    getSessionsWithPendingMarker,
    isDatabasePersisted,
    openDatabase,
} from "../../features/magic-context/storage";
import {
    getFormatRefusal,
    getSchemaFenceRejection,
    openDatabaseAsync,
} from "../../features/magic-context/storage-db";
import { readDirectFormatMarker } from "../../features/magic-context/storage-format-epoch";
import type { Tagger } from "../../features/magic-context/tagger";
import type { ContextUsage } from "../../features/magic-context/types";
import { bootQuietRemainingMs, scheduleAfterBootQuiet } from "../../plugin/boot-quiet";
import { ensureProjectRegisteredFromOpenCodeDirectory } from "../../plugin/embedding-bootstrap";
import type { RustToolBackends } from "../../plugin/rust-tool-backends";
import type { PluginContext } from "../../plugin/types";
import { getErrorMessage } from "../../shared/error-message";
import { log } from "../../shared/logger";
import { normalizeSDKResponse } from "../../shared/normalize-sdk-response";
import type { PromptSurfaceConfig } from "../../shared/prompt-surface";
import type { PromptSurfaceRuntime } from "../../shared/prompt-surface-runtime";
import { resolveFallbackChain } from "../../shared/resolve-fallbacks";
import { isTuiConnected, pushNotification } from "../../shared/rpc-notifications";
import type { Database } from "../../shared/sqlite";
import { createMagicContextCommandHandler } from "./command-handler";
import { clearToolPermissionDenied } from "./ctx-reduce-availability";
import { deriveHistorianChunkTokens, resolveHistorianContextLimit } from "./derive-budgets";
import {
    autoEmbedAttemptedBySession,
    clearEmbedSessionState,
    embedPauseBySession,
    embedRunStateBySession,
    getEmbedDrainUiStatus,
} from "./embed-session-state";
import { createEventHandler } from "./event-handler";
import {
    resolveContextLimit,
    resolveExecuteThresholdDetail,
    resolveModelKey,
} from "./event-resolvers";
import { formatEmbedStatusText } from "./format-embed-status";
import { clearInjectionCache } from "./inject-compartments";
import { dropSlot } from "./lkg-slot";
import {
    drainClaimEffectPrefix,
    MODULE_CLAIM_EFFECTS_CONSUMER,
    proveClaimOperationDurable,
} from "./module-state-sync";
import { McHostModuleTransport } from "./module-transport";
import { CLAIM_INTENT_PROTOCOL_VERSION, CLAIM_REQUEST_ENCODING_VERSION } from "./module-wire";
import { findLastAssistantModelFromOpenCodeDb } from "./read-session-db";
import type { ManagedRecompContext } from "./recomp-orchestrator";
import {
    runManagedRecomp,
    runManagedUpgrade,
    setRecompStarting,
    setRecompTerminal,
} from "./recomp-orchestrator";
import type { RustModeModuleClient } from "./rust-mode-transform";
import { createTextCompleteHandler } from "./text-complete";
import { createTransform } from "./transform";
import { type ManagedWrapupContext, runManagedWrapup } from "./wrapup-orchestrator";

export type { CommandExecuteInput, CommandExecuteOutput } from "./command-handler";

import { checkCompactionMarkerConsistency } from "./compaction-marker-manager";
import {
    createChatMessageHook,
    createCommandExecuteBeforeHook,
    createEventHook,
    createToolExecuteAfterHook,
    getLiveNotificationParams,
} from "./hook-handlers";
import type { LiveSessionState } from "./live-session-state";
import { type NotificationParams, sendIgnoredMessage } from "./send-session-notification";
import { createSystemPromptHashHandler } from "./system-prompt-hash";
import { maybeSendUpgradeReminder } from "./upgrade-reminder";

const DREAM_SCHEDULE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
// `createMagicContextHook` owns `lastScheduleCheckMs` so each hook instance tracks its dream schedule independently across projects.

export interface MagicContextDeps {
    client: PluginContext["client"];
    directory: string;
    tagger: Tagger;
    scheduler: Scheduler;
    onSessionCacheInvalidated?: (sessionId: string) => void;
    compactionHandler: ReturnType<typeof createCompactionHandler>;
    liveSessionState?: LiveSessionState;
    config: {
        protected_tags: number;
        /** User-level setting that lets a session started exactly in the canonical home directory use it as the project. */
        allow_home_project?: boolean;
        language?: string;
        smart_drops?: boolean;
        toast_duration_ms?: number;
        clear_reasoning_age?: number;
        execute_threshold_percentage?: number | { default: number; [modelKey: string]: number };
        execute_threshold_tokens?: { default?: number; [modelKey: string]: number | undefined };
        cache_ttl: string | Record<string, string>;
        prompt_surface?: PromptSurfaceConfig;

        historian?: HistorianConfig;
        history_budget_percentage?: number;
        historian_timeout_ms?: number;
        memory?: {
            enabled: boolean;
            injection_budget_tokens: number;
            /** When true, historian/recomp auto-promote eligible session facts
             * */
            auto_promote?: boolean;
            /* */
            auto_search?: {
                enabled: boolean;
                score_threshold: number;
                min_prompt_chars: number;
            };
        };
        embedding?: {
            provider?: "local" | "openai-compatible" | "off" | "synapse";
        };
        sidekick?: SidekickConfig;
        dreamer?: DreamerConfig;
        smart_notes?: { retina_handoff?: boolean };
        commit_cluster_trigger?: { enabled: boolean; min_clusters: number };
        /** Optional because Zod `.default()` supplies it in loaded configs.
         * */
        system_prompt_injection?: { enabled: boolean; skip_signatures: string[] };
        temporal_awareness?: boolean;
        caveman_text_compression?: {
            enabled: boolean;
            min_chars: number;
        };
        transform_mode?: ResolvedTransformMode;
        subc?: { connection_file: string };
        /** `createMagicContextHook` calls `isCompactionEnabled` once at construction and passes its result to transform phases.
         * */
        compaction?: { enabled?: boolean };
        mural?: { enabled: boolean; model?: string };
    };
    /** Registration owns `promptSurfaceRuntime` and shares it with the tool registry. */
    promptSurfaceRuntime?: PromptSurfaceRuntime;
    /** `rustModeModuleClient` lets tests replace the Rust authority adapter; production creates the subc client. */
    rustModeModuleClient?: RustModeModuleClient;
    /** `openDatabaseForHook` lets tests and async boot supply an already-open database. */
    openDatabaseForHook?: () => Database | null;
}

function notifyMagicContextDisabled(client: PluginContext["client"], reason: string): void {
    const detail = reason.trim();
    // `tui.showToast` is optional in the experimental OpenCode API.
    const c = client as {
        tui?: {
            showToast?: (input: {
                body: {
                    title: string;
                    message: string;
                    variant?: "warning" | "error" | "info" | "success";
                    duration?: number;
                };
            }) => Promise<unknown>;
        };
    };

    const message =
        detail.length > 0
            ? `Persistent storage is unavailable, so magic-context is disabled for safety. ${detail}`
            : "Persistent storage is unavailable, so magic-context is disabled for safety.";

    void c.tui
        ?.showToast?.({
            body: {
                title: "Magic Context Disabled",
                message,
                variant: "warning",
                duration: 8000,
            },
        })
        .catch((error) => {
            log("[magic-context] failed to show disabled toast:", error);
        });
}

export function createMagicContextHook(deps: MagicContextDeps) {
    const contextUsageMap = new Map<string, { usage: ContextUsage; updatedAt: number }>();
    let db: Database;
    try {
        // A successful reopen or non-storage null clears the init-failure latch.
        clearHookInitFailure();
        const opened = deps.openDatabaseForHook ? deps.openDatabaseForHook() : openDatabase();
        if (!opened || !isDatabasePersisted(opened)) {
            const reason =
                (opened ? getDatabasePersistenceError(opened) : null) ??
                "Failed to initialize the persistent SQLite database.";
            log(
                "[magic-context] disabling feature because persistent storage is unavailable:",
                reason,
            );
            notifyMagicContextDisabled(deps.client, reason);
            const formatRefusal = getFormatRefusal();
            const fence = getSchemaFenceRejection();
            recordHookInitFailure({
                type: "storage",
                reason: formatRefusal
                    ? {
                          kind: "format_refusal",
                          family: formatRefusal.family,
                          reasons: formatRefusal.reasons,
                      }
                    : fence
                      ? {
                            kind: "schema_fence",
                            persistedVersion: fence.persistedVersion,
                            supportedVersion: fence.supportedVersion,
                        }
                      : {
                            kind: "storage_failure",
                            cause: reason,
                        },
            });
            return null;
        }
        db = opened;
    } catch (error) {
        const reason = getErrorMessage(error);
        log("[magic-context] hook failed to open storage; disabling feature:", error);
        notifyMagicContextDisabled(deps.client, reason);
        clearHookInitFailure();
        recordHookInitFailure({
            type: "storage",
            reason: { kind: "storage_failure", cause: reason },
        });
        return null;
    }

    const projectPath = resolveProjectIdentityForSession(
        deps.directory,
        deps.config.allow_home_project,
    );
    if (!projectPath) {
        log("[magic-context] not binding a project identity for this directory");
        clearHookInitFailure();
        recordHookInitFailure({ type: "no_project" });
        return null;
    }

    // Startup reconciles compaction markers that reference missing OpenCode DB rows after crashes between database writes.
    // modified externally.
    try {
        checkCompactionMarkerConsistency(db);
    } catch (error) {
        log("[magic-context] startup compaction-marker consistency check failed:", error);
    }

    let lastScheduleCheckMs = 0;
    let dreamQueueQuietScheduled = false;

    // The historian derives chunk budget from its model's context window.
    const getHistorianChunkTokens = (): number =>
        deriveHistorianChunkTokens(resolveHistorianContextLimit(deps.config.historian?.model));
    const historianFallbackModels = resolveFallbackChain(deps.config.historian?.fallback_models);

    // `LiveSessionState` owns three independent cache-busting signal sets so RPC handlers and the hook share them; tests without it use local sets.
    const historyRefreshSessions =
        deps.liveSessionState?.historyRefreshSessions ?? new Set<string>();
    const deferredHistoryRefreshSessions =
        deps.liveSessionState?.deferredHistoryRefreshSessions ?? new Set<string>();
    const systemPromptRefreshSessions =
        deps.liveSessionState?.systemPromptRefreshSessions ?? new Set<string>();
    const pendingMaterializationSessions =
        deps.liveSessionState?.pendingMaterializationSessions ?? new Set<string>();
    const deferredMaterializationSessions =
        deps.liveSessionState?.deferredMaterializationSessions ?? new Set<string>();

    // On restart, the hook reloads deferred signal sets from `pending_compaction_marker_state` so the next transform applies the pending marker.
    try {
        const sessionsWithPending = getSessionsWithPendingMarker(db);
        if (sessionsWithPending.length > 0) {
            for (const sid of sessionsWithPending) {
                deferredHistoryRefreshSessions.add(sid);
                deferredMaterializationSessions.add(sid);
            }
            log(
                `[magic-context] rehydrated ${sessionsWithPending.length} session(s) with pending compaction-marker drain at hook init`,
            );
        }
    } catch (error) {
        log("[magic-context] hook init: pending-marker rehydration failed:", error);
    }
    const lastHeuristicsTurnId = new Map<string, string>();
    const commitSeenLastPass = new Map<string, boolean>();
    const variantBySession =
        deps.liveSessionState?.variantBySession ?? new Map<string, string | undefined>();
    const liveModelBySession =
        deps.liveSessionState?.liveModelBySession ??
        new Map<string, { providerID: string; modelID: string }>();
    const agentBySession = deps.liveSessionState?.agentBySession ?? new Map<string, string>();
    const sessionDirectoryBySession =
        deps.liveSessionState?.sessionDirectoryBySession ?? new Map<string, string>();
    const internalChildSessions = deps.liveSessionState?.internalChildSessions ?? new Set<string>();
    // The map stores recomp/upgrade progress shared with the RPC sidebar/status snapshot.
    const recompProgressBySession =
        deps.liveSessionState?.recompProgressBySession ??
        new Map<string, import("./compartment-runner-types").RecompProgress>();
    const dreamerProgressByProject =
        deps.liveSessionState?.dreamerProgressByProject ??
        new Map<
            string,
            import("../../features/magic-context/dreamer/task-registry").DreamTaskProgress
        >();
    // The per-session metric baseline tracks Channel 1 (`ctx_reduce` tool-output nudges).
    // The map is written after each transform pass and read by `tool.execute.after`; only primary sessions populate it.
    const channel1StateBySession =
        deps.liveSessionState?.channel1StateBySession ??
        new Map<string, import("./ctx-reduce-nudge").Channel1State>();
    const channel2DirectiveTextBySession = new Map<string, string>();

    /**
     *
     * `resolveLiveModel` prefers entries in `liveModelBySession` populated by transform passes.
     * `resolveLiveModel` falls back to the database when `/ctx-status` runs before a transform pass populates `liveModelBySession`.
     * `resolveLiveModel` reads the last assistant model from OpenCode's SQLite DB when the map lacks a session.
     * `resolveLiveModel` caches the database result so later calls in the process avoid another database read.
     *
     */
    const resolveLiveModel = (
        sessionId: string,
    ): { providerID: string; modelID: string } | undefined => {
        const cached = liveModelBySession.get(sessionId);
        if (cached) return cached;
        const recovered = findLastAssistantModelFromOpenCodeDb(sessionId);
        if (recovered) {
            liveModelBySession.set(sessionId, recovered);
            return recovered;
        }
        return undefined;
    };

    const maybeSendProjectIdentitySessionWarning = (sessionId: string, directory: string): void => {
        const warning = takeDubiousOwnershipProjectIdentityWarning(directory);
        if (!warning) return;
        const notificationParams: NotificationParams = getLiveNotificationParams(
            sessionId,
            liveModelBySession,
            variantBySession,
            agentBySession,
            deps.config.toast_duration_ms,
        );
        void sendIgnoredMessage(deps.client, sessionId, warning, notificationParams).catch(
            (error) => {
                log(
                    `[magic-context] failed to send project identity warning for ${directory}: ${getErrorMessage(error)}`,
                );
            },
        );
    };
    const dreamerRunnable = isDreamerRunnable(deps.config);
    const dreamerConfig = dreamerRunnable ? deps.config.dreamer : undefined;
    const historianRunnable = isHistorianRunnable(deps.config);
    // `createMagicContextHook` resolves `compactionOff` once so phases receive a boolean without rereading configuration.
    const compactionOff = !isCompactionEnabled(deps.config);

    // `/ctx-recomp`, `/ctx-session-upgrade`, and RPC dialogs share one recomp/upgrade context.
    // The command and RPC dialog paths use one runner with the same fallback policy, progress state, and terminal state.
    // `resolveLiveModel` resolves `fallbackModelId` with OpenCode database recovery.
    // `resolveLiveModel` recovers the fallback model before a transform pass populates `liveModelBySession`.
    const buildManagedRecompCtx = (sessionId: string): ManagedRecompContext => ({
        client: deps.client,
        db,
        // The orchestrator must share the hook's map and set instances so its writes reach the next transform pass and RPC sidebar.
        liveSessionState: {
            liveModelBySession,
            channel1StateBySession,
            variantBySession,
            agentBySession,
            historyRefreshSessions,
            deferredHistoryRefreshSessions,
            systemPromptRefreshSessions,
            pendingMaterializationSessions,
            deferredMaterializationSessions,
            sessionDirectoryBySession,
            recompProgressBySession,
            dreamerProgressByProject,
            internalChildSessions,
        },
        directory: deps.directory,
        historianChunkTokens: getHistorianChunkTokens(),
        historianTimeoutMs: deps.config.historian_timeout_ms ?? DEFAULT_HISTORIAN_TIMEOUT_MS,
        memoryEnabled: deps.config.memory?.enabled ?? true,
        autoPromote: deps.config.memory?.auto_promote ?? true,
        fallbackModels: historianFallbackModels,
        language: deps.config.language,
        fallbackModelId: (() => {
            const model = resolveLiveModel(sessionId);
            return model ? `${model.providerID}/${model.modelID}` : undefined;
        })(),
        historianTwoPass: deps.config.historian?.two_pass === true,
        // Historian runs collect behavioral observation candidates only when `review-user-memories.schedule !== ""`.
        userMemoriesEnabled: userMemoryCollectionEnabled(dreamerConfig),
        ensureProjectRegistered: ensureProjectRegisteredFromOpenCodeDirectory,
        getNotificationParams: (sid) =>
            getLiveNotificationParams(
                sid,
                liveModelBySession,
                variantBySession,
                agentBySession,
                deps.config.toast_duration_ms,
            ),
    });
    const buildManagedWrapupCtx = (sessionId: string): ManagedWrapupContext => ({
        ...buildManagedRecompCtx(sessionId),
        contextLimit: (() => {
            const model = resolveLiveModel(sessionId);
            return model
                ? resolveContextLimit(model.providerID, model.modelID, { db, sessionID: sessionId })
                : 128_000;
        })(),
        executeThresholdPercentage: (() => {
            const model = resolveLiveModel(sessionId);
            const contextLimit = model
                ? resolveContextLimit(model.providerID, model.modelID, { db, sessionID: sessionId })
                : 128_000;
            return resolveExecuteThresholdDetail(
                deps.config.execute_threshold_percentage ?? 65,
                model ? `${model.providerID}/${model.modelID}` : undefined,
                65,
                {
                    tokensConfig: deps.config.execute_threshold_tokens,
                    contextLimit,
                    sessionId,
                },
            ).percentage;
        })(),
        hasPendingNaturalBust: (sid) =>
            historyRefreshSessions.has(sid) ||
            systemPromptRefreshSessions.has(sid) ||
            pendingMaterializationSessions.has(sid),
    });
    // Embed backfills reuse the recompilation progress UI with kind="embed".
    const executeEmbedHistory = async (
        sessionId: string,
        options?: { signal?: AbortSignal; silent?: boolean },
    ): Promise<string> => {
        if (deps.config.memory?.enabled === false) {
            return "Memory is disabled for this project, so there is no semantic embedding to backfill.";
        }
        const directory = sessionDirectoryBySession.get(sessionId) ?? deps.directory;
        // A start without a signal must not abort an active drain; reacquiring the active drain's lease can return "busy" and terminate the run.
        const active = embedRunStateBySession.get(sessionId);
        if (active && !active.signal.aborted && !options?.signal) {
            return "Embedding is already running for this session.";
        }
        await ensureProjectRegisteredFromOpenCodeDirectory(directory, db);
        const sessionProjectIdentity = resolveProjectIdentityForSession(
            directory,
            deps.config.allow_home_project,
        );
        if (!sessionProjectIdentity) return "No project identity is bound for the home directory.";
        maybeSendProjectIdentitySessionWarning(sessionId, directory);
        embedPauseBySession.delete(sessionId);
        const prior = embedRunStateBySession.get(sessionId);
        if (prior) prior.abort();
        const controller = new AbortController();
        embedRunStateBySession.set(sessionId, controller);
        const signal = options?.signal ?? controller.signal;
        if (!options?.silent) {
            setRecompStarting(
                { recompProgressBySession } as LiveSessionState,
                sessionId,
                "Embedding history…",
                "embed",
            );
        }
        let runFailed = 0;
        let outcome: Awaited<ReturnType<typeof embedSessionCompartmentChunks>>;
        try {
            outcome = await embedSessionCompartmentChunks(db, sessionProjectIdentity, sessionId, {
                signal,
                onProgress: ({ embedded, total }) => {
                    const cur = recompProgressBySession.get(sessionId);
                    if (cur?.phase !== "recomp") return;
                    recompProgressBySession.set(sessionId, {
                        ...cur,
                        processedMessages: embedded,
                        totalMessages: total,
                        updatedAt: Date.now(),
                    });
                },
            });
        } finally {
            // The drain must release the per-session controller after failures; otherwise later starts report "already running".
            if (embedRunStateBySession.get(sessionId) === controller) {
                embedRunStateBySession.delete(sessionId);
            }
        }
        if ("failed" in outcome) runFailed = outcome.failed;
        const terminal = (phase: "done" | "skipped", message: string): string => {
            if (!options?.silent) {
                setRecompTerminal(
                    { recompProgressBySession } as LiveSessionState,
                    sessionId,
                    phase,
                    message,
                );
            }
            return message;
        };
        switch (outcome.status) {
            case "nothing":
                return terminal("done", "All of this session's history is already embedded.");
            case "disabled":
                return terminal(
                    "skipped",
                    "No embedding provider is configured, so there is nothing to embed.",
                );
            case "busy":
                return terminal(
                    "skipped",
                    "Embedding is already running for this project. Try again shortly.",
                );
            case "aborted": {
                // An aborted drain must render as "skipped", not "done", because the sidebar renders "done" as "✓ Embed complete".
                // finished.
                const cov = getEmbeddingCoverageStatus(db, sessionProjectIdentity, sessionId);
                const msg = `Paused at ${cov.session.embedded}/${cov.session.total} compartments embedded.`;
                return terminal("skipped", msg);
            }
            case "stalled":
                return terminal(
                    "skipped",
                    `Embedded ${outcome.embedded} compartments; ${outcome.remaining} could not be embedded (the provider returned no result). Run /ctx-embed start again to retry them.`,
                );
            default:
                return terminal(
                    "done",
                    `Embedded ${outcome.embedded} compartment${outcome.embedded === 1 ? "" : "s"} of history for semantic search${runFailed > 0 ? ` (${runFailed} failed)` : ""}.`,
                );
        }
    };

    const pauseEmbedDrain = (sessionId: string): string => {
        embedPauseBySession.add(sessionId);
        const ctrl = embedRunStateBySession.get(sessionId);
        if (ctrl) ctrl.abort();
        const directory = sessionDirectoryBySession.get(sessionId) ?? deps.directory;
        const sessionProjectIdentity = resolveProjectIdentityForSession(
            directory,
            deps.config.allow_home_project,
        );
        if (!sessionProjectIdentity) return "No project identity is bound for the home directory.";
        maybeSendProjectIdentitySessionWarning(sessionId, directory);
        const cov = getEmbeddingCoverageStatus(db, sessionProjectIdentity, sessionId);
        return `Paused at ${cov.session.embedded}/${cov.session.total} compartments embedded.`;
    };

    const getEmbedStatusText = (sessionId: string): string => {
        const directory = sessionDirectoryBySession.get(sessionId) ?? deps.directory;
        const sessionProjectIdentity = resolveProjectIdentityForSession(
            directory,
            deps.config.allow_home_project,
        );
        if (!sessionProjectIdentity) return "No project identity is bound for the home directory.";
        maybeSendProjectIdentitySessionWarning(sessionId, directory);
        const coverage = getEmbeddingCoverageStatus(db, sessionProjectIdentity, sessionId);
        const progress = recompProgressBySession.get(sessionId);
        const drainUi = getEmbedDrainUiStatus(sessionId, progress);
        return formatEmbedStatusText(coverage, {
            status: drainUi.status,
            embedded: progress?.processedMessages,
            total: progress?.totalMessages,
        });
    };

    const maybeAutoEmbedSession = (sessionId: string): void => {
        if (autoEmbedAttemptedBySession.has(sessionId)) return;
        if (embedPauseBySession.has(sessionId)) return;
        if (deps.config.memory?.enabled === false) return;
        autoEmbedAttemptedBySession.add(sessionId);
        const directory = sessionDirectoryBySession.get(sessionId) ?? deps.directory;
        void (async () => {
            let completedDrainWithWork = false;
            try {
                // Registration synchronously loads configuration and wipes stale embeddings; yielding first keeps that work off the transform return path.
                await new Promise((resolve) => setTimeout(resolve, 0));
                await ensureProjectRegisteredFromOpenCodeDirectory(directory, db);
                const sessionProjectIdentity = resolveProjectIdentityForSession(
                    directory,
                    deps.config.allow_home_project,
                );
                if (!sessionProjectIdentity) return;
                maybeSendProjectIdentitySessionWarning(sessionId, directory);
                const coverage = getEmbeddingCoverageStatus(db, sessionProjectIdentity, sessionId);
                if (!coverage.enabled) return;
                const remaining = coverage.session.total - coverage.session.embedded;
                if (remaining <= 0) return;
                const notifyParams = getLiveNotificationParams(
                    sessionId,
                    liveModelBySession,
                    variantBySession,
                    agentBySession,
                );
                if (!isTuiConnected(sessionId)) {
                    const startMsg = `Embedding ${remaining} compartment${remaining === 1 ? "" : "s"} of history in the background…`;
                    await sendIgnoredMessage(deps.client, sessionId, startMsg, {
                        ...notifyParams,
                    });
                }
                const summary = await executeEmbedHistory(sessionId);
                const completedCoverage = getEmbeddingCoverageStatus(
                    db,
                    sessionProjectIdentity,
                    sessionId,
                );
                completedDrainWithWork =
                    completedCoverage.session.total - completedCoverage.session.embedded <= 0;
                if (!isTuiConnected(sessionId)) {
                    await sendIgnoredMessage(deps.client, sessionId, summary, {
                        ...notifyParams,
                    });
                }
            } catch (error) {
                log("[magic-context] auto-embed drain failed:", error);
            } finally {
                if (!completedDrainWithWork) autoEmbedAttemptedBySession.delete(sessionId);
            }
        })();
    };

    const sidekickRunnable = isSidekickRunnable(deps.config);
    const sidekickConfig = sidekickRunnable ? deps.config.sidekick : undefined;
    // The subc-backed transport connects only when a marker requires draining.
    const authorityRecoveryModuleClient =
        deps.rustModeModuleClient ??
        (() => {
            const transport = new McHostModuleTransport(deps.config.subc?.connection_file);
            const client: RustModeModuleClient = {
                call: (args) => transport.call(args),
                stateSyncCapabilities: (args) => transport.stateSyncCapabilities(args),
                deleteSession: (sessionId, projectRoot) =>
                    transport.deleteSession(sessionId, projectRoot),
                closeSession: (sessionId) => transport.closeSession(sessionId),
                authorityStatus: (args) => transport.authorityStatus(args),
                authorityPrepare: (args) => transport.authorityPrepare(args),
                authoritySeed: (args) => transport.authoritySeed(args),
                authorityDrain: (args) => transport.authorityDrain(args),
                mirrorPull: (args) => transport.mirrorPull(args),
                // In Rust transform mode, rustModeModuleClient must include the claim lanes.
                // Omitting the claim lanes makes every ctx_memory mutation fail its availability guard.
                // When claim lanes are omitted, mirror sync reports "unavailable".
                claimIntentStage: (args) => transport.claimIntentStage(args),
                claimIntentInspect: (args) => transport.claimIntentInspect(args),
                claimIntentAck: (args) => transport.claimIntentAck(args),
                claimEffectsApply: (args) => transport.claimEffectsApply(args),
                claimMirrorReplace: (args) => transport.claimMirrorReplace(args),
                claimMirrorApply: (args) => transport.claimMirrorApply(args),
                getCompartmentsAfter: async (sessionId, afterSequence) => {
                    const response = await transport.call({
                        sessionId,
                        projectRoot: deps.directory,
                        method: "session.status",
                        body: {
                            method: "session.status",
                            v: 1,
                            session_id: sessionId,
                            include_compartments_after_seq: afterSequence,
                        },
                    });
                    const value =
                        response && typeof response === "object" && "result" in response
                            ? (response as { result?: unknown }).result
                            : response;
                    const record = value && typeof value === "object" ? value : {};
                    const compartments =
                        "compartments" in record && Array.isArray(record.compartments)
                            ? record.compartments
                            : [];
                    const maxSequence =
                        "max_sequence" in record && typeof record.max_sequence === "number"
                            ? record.max_sequence
                            : afterSequence;
                    const compartmentCount =
                        "compartment_count" in record &&
                        typeof record.compartment_count === "number"
                            ? record.compartment_count
                            : undefined;
                    const revertEpoch =
                        "revert_epoch" in record && typeof record.revert_epoch === "number"
                            ? record.revert_epoch
                            : undefined;
                    return {
                        max_sequence: maxSequence,
                        compartments,
                        ...(compartmentCount !== undefined
                            ? { compartment_count: compartmentCount }
                            : {}),
                        ...(revertEpoch !== undefined ? { revert_epoch: revertEpoch } : {}),
                        ...("set_changed" in record && record.set_changed === true
                            ? { set_changed: true }
                            : {}),
                    };
                },
            };
            return client;
        })();
    const rustModeModuleClient =
        deps.config.transform_mode === "rust" ? authorityRecoveryModuleClient : undefined;
    const runModuleDomainSync = async (domain: "notes"): Promise<void> => {
        if (!rustModeModuleClient?.mirrorPull) return;
        for (;;) {
            const cursor = getMirrorCursor(db, domain);
            const response = await rustModeModuleClient.mirrorPull({
                domain,
                cursor,
                limit: 1000,
            });
            const next = applyMirrorPage({ db, page: response.page });
            if (!response.page.has_more || next === cursor) break;
        }
    };
    // Chain pulls process-globally by (store, domain) because plugin instances can share a database and interleaved pulls cause applyMirrorPage cursor mismatches.
    const syncModuleDomain = (domain: "notes"): Promise<void> =>
        chainMirrorDomainSync(db, domain, () => runModuleDomainSync(domain));
    const syncModuleNotes = (): Promise<void> => syncModuleDomain("notes");
    const rustToolBackends: RustToolBackends | undefined =
        deps.config.transform_mode === "rust" && rustModeModuleClient
            ? {
                  authorityState: async ({ projectPath, projectRoot, domain }) => {
                      if (!rustModeModuleClient.authorityStatus) return null;
                      const result = await rustModeModuleClient.authorityStatus({
                          context_store_uuid: ensureContextStoreUuid(db),
                          project: projectPath,
                          projectRoot,
                          domain,
                      });
                      return result.authority?.state ?? null;
                  },
                  reduce: ({ sessionId, projectRoot, drop, commandId }) =>
                      rustModeModuleClient.call({
                          sessionId,
                          projectRoot,
                          method: "agent_drops.append",
                          body: {
                              method: "agent_drops.append",
                              v: 1,
                              session_id: sessionId,
                              drop,
                              command_id: commandId,
                          },
                      }),
                  note: async ({
                      commandId,
                      sessionId,
                      projectRoot,
                      memoryProject,
                      action,
                      content,
                      surfaceCondition,
                      compiledProvider,
                      compiledConfig,
                      compiledAt,
                      compileStatus,
                      filter,
                      limit,
                      offset,
                      noteId,
                  }) => {
                      const response = await rustModeModuleClient.call({
                          sessionId,
                          projectRoot,
                          method: "ctx_note",
                          body: {
                              name: "ctx_note",
                              arguments: {
                                  ...(commandId ? { command_id: commandId } : {}),
                                  action,
                                  content,
                                  memory_project: memoryProject,
                                  surface_condition: surfaceCondition,
                                  ...(compileStatus
                                      ? {
                                            compiled_provider: compiledProvider,
                                            compiled_config: compiledConfig,
                                            compiled_at: compiledAt,
                                            compile_status: compileStatus,
                                        }
                                      : {}),
                                  filter,
                                  limit,
                                  offset,
                                  note_id: noteId,
                              },
                          },
                      });
                      // `rustModeModuleClient` is authoritative; `context.db` is the local read model for note nudges and dashboard/RPC consumers.
                      await syncModuleNotes();
                      return response;
                  },
                  memory: async ({
                      sessionId,
                      projectRoot,
                      projectPath,
                      producer,
                      operationKey,
                      intentRequest,
                      commitContext,
                  }) => {
                      const marker = readDirectFormatMarker(db);
                      if (marker.status !== "present") {
                          throw new Error("claim intent requires a valid context format marker");
                      }
                      if (!rustModeModuleClient.authorityStatus) {
                          throw new Error("claim intent requires memory authority status");
                      }
                      const status = await rustModeModuleClient.authorityStatus({
                          context_store_uuid: ensureContextStoreUuid(db),
                          project: projectPath,
                          projectRoot,
                          domain: "memories",
                      });
                      if (status.authority?.state !== "MODULE") {
                          throw Object.assign(
                              new Error("memory authority is not accepting intents"),
                              {
                                  code: "authority_draining",
                              },
                          );
                      }
                      const claimIntentStage = rustModeModuleClient.claimIntentStage;
                      const claimIntentInspect = rustModeModuleClient.claimIntentInspect;
                      const claimIntentAck = rustModeModuleClient.claimIntentAck;
                      const claimEffectsApply = rustModeModuleClient.claimEffectsApply;
                      if (
                          !claimIntentStage ||
                          !claimIntentInspect ||
                          !claimIntentAck ||
                          !claimEffectsApply
                      ) {
                          throw new Error("module claim intent protocol is unavailable");
                      }
                      return commitModuleClaimIntent({
                          client: { claimIntentStage, claimIntentInspect, claimIntentAck },
                          sessionId,
                          projectRoot,
                          request: {
                              protocolVersion: CLAIM_INTENT_PROTOCOL_VERSION,
                              requestEncodingVersion: CLAIM_REQUEST_ENCODING_VERSION,
                              binding: {
                                  databaseIncarnationId: marker.marker.databaseIncarnationId,
                                  formatEpoch: marker.marker.formatEpoch,
                                  authorityProject: projectPath,
                                  authorityGeneration: status.authority.generation,
                              },
                              command: { producer, operationKey },
                              request: intentRequest,
                          },
                          commitContext,
                          settleContext: async (commit) => {
                              const proof = proveClaimOperationDurable({
                                  db,
                                  producer: commit.producer,
                                  operationKey: commit.operationKey,
                                  resultJson: commit.resultJson,
                              });
                              await drainClaimEffectPrefix({
                                  db,
                                  consumer: MODULE_CLAIM_EFFECTS_CONSUMER,
                                  throughReceiptId: proof.receiptId,
                                  deliver: (receipt) =>
                                      claimEffectsApply({
                                          sessionId,
                                          projectRoot,
                                          request: {
                                              protocolVersion: CLAIM_INTENT_PROTOCOL_VERSION,
                                              consumer: MODULE_CLAIM_EFFECTS_CONSUMER,
                                              receipt,
                                          },
                                      }),
                              });
                          },
                      });
                  },
                  noteEvaluationAvailable: (evaluationProjectPath: string) =>
                      getModuleNoteEvaluationBridge(evaluationProjectPath)?.available() === true,
              }
            : undefined;
    // Bridges are per resolved project because sessions can resolve projects other than the plugin's launch directory through /cd switches or multi-project hosts.
    // Registration is an idempotent ensure for every project that reaches Rust-mode preparation.
    const evaluatorTransport = rustModeModuleClient
        ? new McHostModuleTransport(deps.config.subc?.connection_file)
        : undefined;
    // Instance disposal must remove only bridge keys registered by this hook instance because the registry is process-global.
    const ownedBridgeProjects = new Set<string>();
    // The bridge uses the scheduled evaluate-smart-notes model ladder: task override, then dreamer model, then configured fallbacks.
    const evaluatorTaskConfig = dreamerConfig
        ? buildDreamTaskRuntimeConfigs(dreamerConfig).find(
              (config) => config.task === "evaluate-smart-notes",
          )
        : undefined;
    const ensureModuleNoteEvaluationBridge = (
        bridgeProjectPath: string,
        bridgeProjectRoot: string,
    ): void => {
        if (!rustModeModuleClient?.mirrorPull || !evaluatorTransport) return;
        // Without a drain path, conditioned notes remain pending forever.
        // Without registration, the live-evaluator gate rejects conditioned writes.
        if (!dreamerRunnable) return;
        // An empty per-task schedule means the task is never due, so do not register a bridge.
        // A bridge's timer drain runs unconditionally.
        // Skipping registration for a disabled task makes conditioned writes fail closed.
        if ((evaluatorTaskConfig?.schedule ?? "").trim() === "") return;
        // Bridge keys include identity and root because worktrees share repository identity.
        // A shared bridge evaluates file-dependent conditions in the first checkout.
        const bridgeKeyId = moduleNoteEvaluationBridgeKey(bridgeProjectPath, bridgeProjectRoot);
        const existingBridge = getModuleNoteEvaluationBridge(bridgeProjectPath, bridgeProjectRoot);
        if (existingBridge) {
            // Each instance records ownership once so disposing one instance cannot remove a bridge another instance still uses.
            if (!ownedBridgeProjects.has(bridgeKeyId)) {
                const retained = retainModuleNoteEvaluationBridge(
                    bridgeProjectPath,
                    bridgeProjectRoot,
                );
                if (retained) ownedBridgeProjects.add(retained);
            }
            // Boot registration can precede authority preparation and be rejected.
            // The existing bridge retries registration so conditioned writes are not refused before the timer drain registers the bridge.
            void existingBridge.ensureRegistered?.().catch((error) => {
                log(`[magic-context] evaluator registration retry failed: ${error}`);
            });
            return;
        }
        // The module derives evaluator scope from the server-side route root.
        // Filesystem capabilities resolve against the checkout.
        // The bridge uses the prepared project's root rather than the plugin launch directory.
        // Otherwise, the bridge registers against and drains the wrong project's notes.
        // project's notes.
        const capabilityFactory = (signal: AbortSignal) =>
            createSmartNoteCapabilities({ projectRoot: bridgeProjectRoot, signal });
        // Evaluator LLM children need a parent session for trace nesting.
        // A parent ID nests evaluator children in the picker and lets recordChildInvocation capture their token telemetry.
        // The bridge resolves the parent ID per claim because the bridge can outlive a session.
        // deps.client.session.list lacks abort support, so the lookup races the claim signal and a 5-second timeout.
        // A stalled lookup pins the claim executor.
        // Lease renewals keep the claim alive, so dispose() waits for the stalled lookup.
        const resolveEvaluatorParentSession = async (
            signal: AbortSignal,
        ): Promise<string | undefined> => {
            try {
                const listResponse = await Promise.race([
                    deps.client.session.list({ query: { directory: bridgeProjectRoot } }),
                    new Promise<never>((_, reject) => {
                        const fail = (reason: unknown) =>
                            reject(
                                reason instanceof Error
                                    ? reason
                                    : new Error("parent session lookup aborted"),
                            );
                        if (signal.aborted) {
                            fail(signal.reason);
                            return;
                        }
                        const timer = setTimeout(
                            () => fail(new Error("parent session lookup timed out")),
                            5_000,
                        );
                        if (typeof timer.unref === "function") timer.unref();
                        signal.addEventListener(
                            "abort",
                            () => {
                                clearTimeout(timer);
                                fail(signal.reason);
                            },
                            { once: true },
                        );
                    }),
                ]);
                const sessions = normalizeSDKResponse(listResponse, [] as { id?: string }[], {
                    preferResponseOnMissingData: true,
                });
                return sessions?.find((s) => typeof s?.id === "string")?.id;
            } catch {
                return undefined;
            }
        };
        const workerPolicy = {
            retinaHandoff: deps.config.smart_notes?.retina_handoff === true,
            wakeOwned: false,
        };
        const worker = new SmartNoteEvaluatorWorker({
            transport: {
                call: ({ method, body, signal }) =>
                    evaluatorTransport.call({
                        sessionId: `note-evaluator:${bridgeProjectPath}`,
                        projectRoot: bridgeProjectRoot,
                        method,
                        body: { method, ...(body as Record<string, unknown>) },
                        signal,
                    }),
            },
            // Each QuickJS execution reserves a sandbox slot only for its own execution window.
            // Holding a reservation spans more than the QuickJS execution window.
            // A held reservation occupies the process-wide slot during compile and fallback LLM calls.
            // A held reservation stalls other projects' sweeps during fallback LLM calls.
            executors: (snapshot, signal, deadline) => ({
                compile: async () =>
                    compileSmartNoteCheck({
                        client: deps.client,
                        db,
                        parentSessionId: await resolveEvaluatorParentSession(signal),
                        sessionDirectory: bridgeProjectRoot,
                        projectIdentity: bridgeProjectPath,
                        model: evaluatorTaskConfig?.model,
                        fallbackModels: evaluatorTaskConfig?.fallbackModels,
                        note: {
                            id: snapshot.noteId,
                            content: snapshot.content,
                            surfaceCondition: snapshot.surfaceCondition,
                        },
                        capabilityFactory,
                        signal,
                        deadline,
                    }),
                runCompiled: (compiledCheck) =>
                    runCompiledSmartNoteCheck({
                        compiledCheck,
                        capabilityFactory,
                        signal,
                        timeoutMs: 2_000,
                    }),
                confirmFallback: async () =>
                    confirmSmartNoteReadOnly({
                        client: deps.client,
                        db,
                        parentSessionId: await resolveEvaluatorParentSession(signal),
                        sessionDirectory: bridgeProjectRoot,
                        projectIdentity: bridgeProjectPath,
                        model: evaluatorTaskConfig?.model,
                        fallbackModels: evaluatorTaskConfig?.fallbackModels,
                        deadline,
                        noteId: snapshot.noteId,
                        content: snapshot.content,
                        surfaceCondition: snapshot.surfaceCondition,
                        signal,
                    }),
            }),
            policy: () => ({ ...workerPolicy }),
        });
        const bridgeKey = registerModuleNoteEvaluationBridge(bridgeProjectPath, bridgeProjectRoot, {
            sync: syncModuleNotes,
            available: () => worker.registered,
            async ensureRegistered() {
                if (!worker.registered) await worker.register();
            },
            async drain(drainArgs) {
                const wakePresent = (await wakePlaneStatus()) === "present";
                const wakeReleased = workerPolicy.wakeOwned && !wakePresent;
                workerPolicy.wakeOwned = wakePresent;
                if (wakePresent) {
                    if (worker.registered) await worker.heartbeat();
                    else await worker.register(drainArgs.signal);
                    await syncModuleNotes();
                    return { claimed: 0, completed: 0, abandoned: 0, surfaced: 0, drained: true };
                }
                if (wakeReleased && worker.registered) await worker.heartbeat();
                const result = await worker.drainOnce(drainArgs);
                await syncModuleNotes();
                return result;
            },
            dispose: () => worker.dispose(),
        });
        ownedBridgeProjects.add(bridgeKey);
        void worker.register().catch((error) => {
            log(`[magic-context] evaluator registration failed: ${error}`);
        });
    };
    ensureModuleNoteEvaluationBridge(projectPath, deps.directory);
    const notifyRustModeParked = (sessionId: string, message: string): void => {
        const client = deps.client as {
            tui?: {
                showToast?: (input: {
                    body: {
                        title: string;
                        message: string;
                        variant?: "warning" | "error" | "info" | "success";
                        duration?: number;
                    };
                }) => Promise<unknown>;
            };
        };
        void client.tui
            ?.showToast?.({
                body: {
                    title: "Rust Magic Context paused",
                    message,
                    variant: "warning",
                    duration: 8000,
                },
            })
            .catch((error) =>
                log(`[magic-context] rust park toast failed for ${sessionId}:`, error),
            );
    };

    const transform = createTransform({
        tagger: deps.tagger,
        scheduler: deps.scheduler,
        contextUsageMap,
        db,
        channel1StateBySession,
        channel2DirectiveTextBySession,
        protectedTags: deps.config.protected_tags,
        smartDrops: deps.config.smart_drops === true,
        clearReasoningAge: deps.config.clear_reasoning_age ?? 50,
        commitClusterTrigger: deps.config.commit_cluster_trigger,
        historyRefreshSessions,
        deferredHistoryRefreshSessions,
        pendingMaterializationSessions,
        deferredMaterializationSessions,
        lastHeuristicsTurnId,
        commitSeenLastPass,
        internalChildSessions,
        client: deps.client,
        directory: deps.directory,
        allowHomeProject: deps.config.allow_home_project,
        injectDocs: deps.config.dreamer?.inject_docs !== false,
        memoryConfig: deps.config.memory
            ? {
                  enabled: deps.config.memory.enabled,
                  injectionBudgetTokens: deps.config.memory.injection_budget_tokens,
                  autoPromote: deps.config.memory.auto_promote ?? true,
              }
            : undefined,
        ensureProjectRegistered: ensureProjectRegisteredFromOpenCodeDirectory,
        getHistorianChunkTokens,
        historyBudgetPercentage: deps.config.history_budget_percentage,
        executeThresholdPercentage: deps.config.execute_threshold_percentage,
        executeThresholdTokens: deps.config.execute_threshold_tokens,
        historianTimeoutMs: deps.config.historian_timeout_ms ?? DEFAULT_HISTORIAN_TIMEOUT_MS,
        fallbackModels: historianFallbackModels,
        getNotificationParams: (sessionId) =>
            getLiveNotificationParams(
                sessionId,
                liveModelBySession,
                variantBySession,
                agentBySession,
                deps.config.toast_duration_ms,
            ),
        getModelKey: (sessionId) => {
            const model = liveModelBySession.get(sessionId);
            return resolveModelKey(model?.providerID, model?.modelID);
        },
        getFallbackModelId: (sessionId) => {
            const model = liveModelBySession.get(sessionId);
            return model ? `${model.providerID}/${model.modelID}` : undefined;
        },
        projectPath,
        historianRunnable,
        compactionOff,
        experimentalUserMemories: userMemoryCollectionEnabled(dreamerConfig),
        experimentalTemporalAwareness: deps.config.temporal_awareness === true,
        muralEnabled: deps.config.mural?.enabled === true,
        historianTwoPass: deps.config.historian?.two_pass === true,
        liveModelBySession,
        sessionDirectoryBySession,
        autoSearch: {
            enabled: deps.config.memory?.auto_search?.enabled ?? true,
            scoreThreshold: deps.config.memory?.auto_search?.score_threshold ?? 0.6,
            minPromptChars: deps.config.memory?.auto_search?.min_prompt_chars ?? 20,
            directory: deps.directory,
            ensureProjectRegistered: ensureProjectRegisteredFromOpenCodeDirectory,
        },
        cavemanTextCompression: compactionOff
            ? undefined
            : deps.config.caveman_text_compression?.enabled === true
              ? {
                    enabled: true,
                    minChars: deps.config.caveman_text_compression.min_chars ?? 500,
                }
              : undefined,
        maybeAutoEmbedSession,
        transformMode: deps.config.transform_mode,
        promptSurface: deps.config.prompt_surface,
        promptSurfaceRuntime: deps.promptSurfaceRuntime,
        rustModeModuleClient,
        tsAuthorityRecoveryModuleClient: authorityRecoveryModuleClient,
        onRustModeParked: notifyRustModeParked,
        onRustModeProjectPrepared: ensureModuleNoteEvaluationBridge,
    });
    const eventHandler = createEventHandler({
        contextUsageMap,
        compactionHandler: deps.compactionHandler,
        config: deps.config,
        compactionOff,
        tagger: deps.tagger,
        db,
        client: deps.client,
        channel1StateBySession,
        channel2DirectiveTextBySession,
        internalChildSessions,
        getNotificationParams: (sessionId) =>
            getLiveNotificationParams(
                sessionId,
                liveModelBySession,
                variantBySession,
                agentBySession,
                deps.config.toast_duration_ms,
            ),
        onSessionCacheInvalidated: (sessionId: string) => {
            dropSlot(sessionId, "session-cache-invalidated");
            clearInjectionCache(sessionId);
            deps.onSessionCacheInvalidated?.(sessionId);
        },
        onRustWireInvalidated: (sessionId: string) => {
            transform.invalidateRustWireState(sessionId);
        },
        // plugin's lifetime.
        onSessionDeleted: (sessionId: string) => {
            dropSlot(sessionId, "session-deleted");
            transform.clearRustSession(sessionId);
            systemPromptHash.clearSession(sessionId);
            // Session-deletion handling prunes per-session maps to release entries retained for the plugin process lifetime.
            // Session-deletion handling prunes per-session maps to release entries retained for the plugin process lifetime.
            // Session-deletion handling prunes per-session maps to release entries retained for the plugin process lifetime.
            // The session.deleted handler clears shared liveSessionState maps because deleted sessions cannot use them.
            // The session.deleted handler clears shared liveSessionState maps because deleted sessions cannot use them.
            lastHeuristicsTurnId.delete(sessionId);
            clearToolPermissionDenied(sessionId);
            commitSeenLastPass.delete(sessionId);
            variantBySession.delete(sessionId);
            liveModelBySession.delete(sessionId);
            agentBySession.delete(sessionId);
            sessionDirectoryBySession.delete(sessionId);
            recompProgressBySession.delete(sessionId);
            internalChildSessions.delete(sessionId);
            channel1StateBySession.delete(sessionId);
            channel2DirectiveTextBySession.delete(sessionId);
            clearEmbedSessionState(sessionId);
        },
    });

    const runDreamQueueInBackground = (): void => {
        if (bootQuietRemainingMs() > 0) {
            if (!dreamQueueQuietScheduled) {
                dreamQueueQuietScheduled = true;
                scheduleAfterBootQuiet(() => {
                    dreamQueueQuietScheduled = false;
                    runDreamQueueInBackground();
                });
            }
            return;
        }
        const dreaming = deps.config.dreamer;
        if (!dreaming || dreaming.disable === true) {
            return;
        }

        const now = Date.now();
        if (now - lastScheduleCheckMs < DREAM_SCHEDULE_CHECK_INTERVAL_MS) {
            return;
        }
        lastScheduleCheckMs = now;

        // The per-task scheduler owns due evaluation and keyed leases.
        // Message events and the process timer invoke the same idempotent scheduler; keyed leases prevent overlap.
        // Message events and the process timer invoke the same idempotent scheduler; keyed leases prevent overlap.
        const runtimeConfigs = buildDreamTaskRuntimeConfigs(dreaming, deps.config.language);
        const executor = createDreamTaskExecutor({
            client: deps.client,
            // The hook runs in its own directory, not a sibling checkout resolved from the shared git:<sha> identity map.
            // The hook runs in its own directory, not a sibling checkout resolved from the shared git:<sha> identity map.
            sessionDirectory: deps.directory,
            openOpenCodeDb,
            retrospectiveRawProvider: (providerDb) =>
                new OpenCodeRetrospectiveRawProvider({
                    contextDb: providerDb,
                    openOpenCodeDb,
                }),
            userMemoryCollectionEnabled: userMemoryCollectionEnabled(dreaming),
            language: deps.config.language,
            retinaHandoff: deps.config.smart_notes?.retina_handoff === true,
            transformMode: deps.config.transform_mode,
            // Scheduled and message-triggered runs use authority.status so cold processes read the live MODULE verdict instead of session-cached transform state or the guarded TypeScript child path.
            moduleClient: rustModeModuleClient,
            onProgress: (progress, completedTask) => {
                if (progress) {
                    dreamerProgressByProject.set(projectPath, progress);
                } else if (dreamerProgressByProject.get(projectPath)?.task === completedTask) {
                    dreamerProgressByProject.delete(projectPath);
                }
            },
        });
        void runDueTasksForProject({
            db,
            projectIdentity: projectPath,
            tasks: runtimeConfigs,
            executor,
        }).catch((error: unknown) => {
            log("[dreamer] scheduled task run failed:", error);
        });
    };

    const commandHandler = createMagicContextCommandHandler({
        db,
        protectedTags: deps.config.protected_tags,
        compactionOff,
        toastDurationMs: deps.config.toast_duration_ms,
        executeThresholdPercentage: deps.config.execute_threshold_percentage ?? 65,
        executeThresholdTokens: deps.config.execute_threshold_tokens,
        historyBudgetPercentage: deps.config.history_budget_percentage,
        transformMode: deps.config.transform_mode,
        rustModeModuleClient,
        projectRoot: deps.directory,
        projectPath,
        // /ctx-approve and /ctx-enforce resolve artifact IDs against the invoking session's project, preventing sessions moved to another directory from accessing launch-project artifacts.
        // Artifact resolution canonicalizes paths against the identity-owning root so in-repo paths are not treated as escapes.
        resolveProjectForSession: (sessionId) => {
            const directory = sessionDirectoryBySession.get(sessionId) ?? deps.directory;
            return {
                projectPath:
                    resolveProjectIdentityForSession(directory, deps.config.allow_home_project) ??
                    undefined,
                projectRoot: resolveProjectRootDirectory(directory),
            };
        },
        commitClusterTrigger: deps.config.commit_cluster_trigger,
        getLiveModelKey: (sessionId) => {
            // The model resolver falls back to DB model data before the first transform after restart so /ctx-status uses the model-specific threshold rather than the default.
            const model = resolveLiveModel(sessionId);
            return model ? `${model.providerID}/${model.modelID}` : undefined;
        },
        getDreamerProgress: () => dreamerProgressByProject.get(projectPath) ?? null,
        getTailHygiene: (sessionId) => channel1StateBySession.get(sessionId),
        getContextLimit: (sessionId) => {
            // The model resolver falls back to DB model data because /ctx-status's resolved context limit and history budget use the live model.
            const model = resolveLiveModel(sessionId);
            if (!model) return undefined;
            return resolveContextLimit(model.providerID, model.modelID);
        },
        // /ctx-flush signals history rebuild, system-prompt adjuncts, and forced materialization.
        onFlush: (sessionId) => {
            historyRefreshSessions.add(sessionId);
            systemPromptRefreshSessions.add(sessionId);
            pendingMaterializationSessions.add(sessionId);
        },
        // runManagedRecomp and runManagedUpgrade give command paths the same model fallback, live progress, and terminal state as RPC dialog paths.
        executeWrapup: historianRunnable
            ? async (sessionId, options) =>
                  runManagedWrapup(buildManagedWrapupCtx(sessionId), sessionId, options)
            : undefined,
        executeRecomp: historianRunnable
            ? async (sessionId, options) =>
                  runManagedRecomp(buildManagedRecompCtx(sessionId), sessionId, options)
            : undefined,
        // runManagedUpgrade performs a full recomp and once-per-project memory migration.
        runUpgrade: historianRunnable
            ? async (sessionId: string) =>
                  runManagedUpgrade(buildManagedRecompCtx(sessionId), sessionId)
            : undefined,
        executeEmbedHistory,
        pauseEmbedDrain,
        getEmbedStatusText,
        sendNotification: async (sessionId, text, params) => {
            await sendIgnoredMessage(deps.client, sessionId, text, {
                ...getLiveNotificationParams(
                    sessionId,
                    liveModelBySession,
                    variantBySession,
                    agentBySession,
                    deps.config.toast_duration_ms,
                ),
                ...params,
            });
        },
        sidekick: sidekickConfig
            ? {
                  config: sidekickConfig,
                  projectPath,
                  sessionDirectory: deps.directory,
                  client: deps.client,
                  language: deps.config.language,
              }
            : undefined,
        dreamer: dreamerConfig
            ? {
                  config: dreamerConfig,
                  projectPath,
                  // Manual /ctx-dream runs Dreamer v2 tasks in the active checkout.
                  // separate drain.
                  runManual: (task) =>
                      runManualDream({
                          db,
                          projectIdentity: projectPath,
                          tasks: buildDreamTaskRuntimeConfigs(dreamerConfig, deps.config.language),
                          executor: createDreamTaskExecutor({
                              client: deps.client,
                              sessionDirectory: deps.directory,
                              openOpenCodeDb,
                              retrospectiveRawProvider: (providerDb) =>
                                  new OpenCodeRetrospectiveRawProvider({
                                      contextDb: providerDb,
                                      openOpenCodeDb,
                                  }),
                              userMemoryCollectionEnabled:
                                  userMemoryCollectionEnabled(dreamerConfig),
                              language: deps.config.language,
                              mural: deps.config.mural,
                              memoryInjectionBudgetTokens:
                                  deps.config.memory?.injection_budget_tokens,
                              retinaHandoff: deps.config.smart_notes?.retina_handoff === true,
                              transformMode: deps.config.transform_mode,
                              // The /ctx-status handler must not rely on a transform-populated cache.
                              moduleClient: rustModeModuleClient,
                              onProgress: (progress, completedTask) => {
                                  if (progress) {
                                      dreamerProgressByProject.set(projectPath, progress);
                                  } else if (
                                      dreamerProgressByProject.get(projectPath)?.task ===
                                      completedTask
                                  ) {
                                      dreamerProgressByProject.delete(projectPath);
                                  }
                              },
                          }),
                          task,
                      }),
              }
            : undefined,
    });

    const systemPromptHash = createSystemPromptHashHandler({
        db,
        protectedTags: deps.config.protected_tags,
        dreamerEnabled: dreamerRunnable,
        memoryEnabled: deps.config.memory?.enabled !== false,
        language: deps.config.language,
        promptSurface: deps.config.prompt_surface,
        promptSurfaceRuntime: deps.promptSurfaceRuntime,
        resolveModel: resolveLiveModel,
        historyRefreshSessions,
        systemPromptRefreshSessions,
        pendingMaterializationSessions,
        lastHeuristicsTurnId,
        injectionEnabled: deps.config.system_prompt_injection?.enabled ?? true,
        injectionSkipSignatures: deps.config.system_prompt_injection?.skip_signatures ?? [
            "<!-- magic-context: skip -->",
        ],
        internalChildSessions,
        experimentalUserMemories: userMemoryCollectionEnabled(deps.config.dreamer),
        experimentalTemporalAwareness: deps.config.temporal_awareness === true,
        experimentalCavemanTextCompression: deps.config.caveman_text_compression?.enabled === true,
    });
    const systemPromptHashHandler = systemPromptHash.handler;

    const eventHook = createEventHook({
        eventHandler,
        contextUsageMap,
        db,
        liveModelBySession,
        variantBySession,
        agentBySession,
        sessionDirectoryBySession,
        historyRefreshSessions,
        deferredHistoryRefreshSessions,
        systemPromptRefreshSessions,
        pendingMaterializationSessions,
        deferredMaterializationSessions,
        lastHeuristicsTurnId,
        commitSeenLastPass,
        client: deps.client,
        protectedTags: deps.config.protected_tags,
    });

    const hooks = {
        "experimental.chat.messages.transform": transform,
        "experimental.chat.system.transform": systemPromptHashHandler,
        "experimental.text.complete": createTextCompleteHandler(),
        disposeNoteEvaluationBridges: () => disposeModuleNoteEvaluationBridges(ownedBridgeProjects),
        "chat.message": createChatMessageHook({
            db,
            liveModelBySession,
            variantBySession,
            agentBySession,
            historyRefreshSessions,
            systemPromptRefreshSessions,
            pendingMaterializationSessions,
            lastHeuristicsTurnId,
            upgradeReminder: historianRunnable
                ? (sessionId: string) =>
                      maybeSendUpgradeReminder(
                          {
                              client: deps.client,
                              db,
                              sendIgnoredMessage,
                              getNotificationParams: (sid) =>
                                  getLiveNotificationParams(
                                      sid,
                                      liveModelBySession,
                                      variantBySession,
                                      agentBySession,
                                      deps.config.toast_duration_ms,
                                  ),
                              isTuiConnected,
                              pushTuiDialogAction: (sid, resume) =>
                                  pushNotification(
                                      "action",
                                      resume
                                          ? {
                                                action: "show-upgrade-dialog",
                                                resume: true,
                                                stagedCount: resume.stagedCount,
                                                stagedThrough: resume.stagedThrough,
                                            }
                                          : { action: "show-upgrade-dialog" },
                                      sid,
                                  ),
                          },
                          sessionId,
                      )
                : undefined,
        }),
        event: async (input: { event: { type: string; properties?: unknown } }) => {
            await eventHook(input);
            if (input.event.type === "message.updated") {
                runDreamQueueInBackground();
            }
        },
        "command.execute.before": createCommandExecuteBeforeHook(commandHandler),
        "tool.execute.after": createToolExecuteAfterHook({
            db,
            channel1StateBySession,
            client: deps.client,
            transformMode: deps.config.transform_mode,
            todoStateSet:
                deps.config.transform_mode === "rust" && rustModeModuleClient
                    ? ({ sessionId, stateJson, ownerMessageId }) =>
                          rustModeModuleClient.call({
                              sessionId,
                              projectRoot: deps.directory,
                              method: "todo_state.set",
                              body: {
                                  method: "todo_state.set",
                                  v: 1,
                                  session_id: sessionId,
                                  state_json: stateJson,
                                  owner_message_id: ownerMessageId,
                              },
                          })
                    : undefined,
        }),
    };
    const hooksWithBackends = hooks as typeof hooks & {
        rustToolBackends?: RustToolBackends;
    };
    Object.defineProperty(hooksWithBackends, "rustToolBackends", {
        value: rustToolBackends,
        enumerable: false,
    });
    return hooksWithBackends;
}

/**
 */
export async function createMagicContextHookAsync(
    deps: MagicContextDeps,
): Promise<ReturnType<typeof createMagicContextHook>> {
    let database: Database | null;
    try {
        clearHookInitFailure();
        database = await openDatabaseAsync();
    } catch (error) {
        const reason = getErrorMessage(error);
        log("[magic-context] hook failed to open storage; disabling feature:", error);
        notifyMagicContextDisabled(deps.client, reason);
        clearHookInitFailure();
        recordHookInitFailure({
            type: "storage",
            reason: { kind: "storage_failure", cause: reason },
        });
        return null;
    }
    return createMagicContextHook({
        ...deps,
        openDatabaseForHook: () => database,
    });
}
