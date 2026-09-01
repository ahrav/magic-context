import {
    clearSessionTracking,
    scheduleIncrementalIndex,
    scheduleReconciliation,
} from "../../features/magic-context/message-index-async";
import { clearPersistedReasoningWatermark } from "../../features/magic-context/storage";
import {
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../features/magic-context/storage-meta";
import {
    clearDetectedContextLimit,
    clearEmergencyDropSample,
    clearEmergencyRecovery,
    clearHistorianFailureState,
    getLastNudgeLevel,
    getLastNudgeUndropped,
    resetLastNudgeCycle,
    setLastNudgeLevel,
    setLastNudgeUndropped,
} from "../../features/magic-context/storage-meta-persisted";
import { clearSidebarSnapshotCache } from "../../plugin/sidebar-snapshot-cache";
import type { PluginContext } from "../../plugin/types";
import { sessionLog } from "../../shared/logger";
import { clearAutoSearchForSession } from "./auto-search-runner";
import {
    cachedToolPermissionDenied,
    resolveTodowriteAvailability,
    todowritePermissionDenied,
} from "./ctx-reduce-availability";
import {
    buildChannel1Reminder,
    CHANNEL1_SENTINEL,
    type Channel1State,
    decideChannel1,
    toolOutputTokens,
} from "./ctx-reduce-nudge";
import {
    getMessageUpdatedAssistantInfo,
    getMessageUpdatedInfo,
    getSessionProperties,
} from "./event-payloads";
import { resolveSessionId as resolveEventSessionId } from "./event-resolvers";
import { dropSlot } from "./lkg-slot";
import {
    clearNoteNudgeTriggerAndCooldown,
    onNoteTrigger,
    resetNoteNudgeCooldownOnly,
} from "./note-nudger";
import { readRawSessionMessageById, readRawSessionMessages } from "./read-session-chunk";
import { clearIgnoredMessages, flushIgnoredMessages } from "./send-session-notification";
import { variantChangeBustsProviderCache } from "./sentinel";
import { normalizeTodoStateJson } from "./todo-view";

export type LiveModelBySession = Map<string, { providerID: string; modelID: string }>;
export type VariantBySession = Map<string, string | undefined>;
export type AgentBySession = Map<string, string>;

/**
 *
 * Three separate sets keep three independent lifetimes apart; one shared
 * flag would let defer passes blocked by an in-progress historian keep
 * re-firing the same flush signal across multiple turns. Each set has
 * exactly one consumer and one lifetime.
 *
 * Producers add each session to every set whose consumer must react.
 * Consumers drain their sets after consuming the signal.
 */

/**
 * A `HistoryRefreshSessions` entry requires rebuilding `<session-history>` on the next pass.
 * `<session-history>` contains compartments, facts, and memories in `message[0]`.
 * `prepareCompartmentInjection()` consumes `HistoryRefreshSessions` entries.
 * `prepareCompartmentInjection()` drains the entry after invocation, even when no rebuild occurs.
 *
 * `/ctx-flush`, real variant changes, and system-prompt hash changes add sessions to `HistoryRefreshSessions`.
 * Explicit flush, recomp, variant, and system-prompt-hash refresh paths add sessions to `HistoryRefreshSessions`.
 * Background historian/compressor publications use DeferredHistoryRefreshSessions.
 *
 * The background compressor does not add sessions to `HistoryRefreshSessions`.
 * The background compressor's output waits for the next natural cache-bust pass.
 */
export type HistoryRefreshSessions = Set<string>;

/** `DeferredHistoryRefreshSessions` persists history-refresh signals from background historian and compressor publications. */
export type DeferredHistoryRefreshSessions = Set<string>;

/**
 * A `SystemPromptRefreshSessions` entry requires re-reading system-prompt adjuncts from disk on the next system-transform call.
 * System-prompt adjuncts include project docs, the user profile, key files, and the sticky date.
 * `system-prompt-hash.ts` consumes `SystemPromptRefreshSessions` entries.
 * `system-prompt-hash.ts` drains each entry after refreshing.
 *
 * `/ctx-flush`, real variant changes, and system-prompt hash changes add sessions to `SystemPromptRefreshSessions`.
 *
 * Historian, compressor, and recomp do not add sessions to `SystemPromptRefreshSessions`.
 * Historian, compressor, and recomp do not change disk adjuncts, so re-reading them performs unnecessary I/O.
 */
export type SystemPromptRefreshSessions = Set<string>;

/**
 * A `PendingMaterializationSessions` entry requires queued `ctx_reduce` operations and heuristic cleanup to run.
 * The work remains pending when the current pass cannot safely run heuristics.
 * A compartment run prevents heuristic execution.
 * `transform-postprocess-phase.ts` drains entries only after `shouldRunHeuristics` executes.
 * `PendingMaterializationSessions` entries survive blocked passes until materialization succeeds.
 *
 * `/ctx-flush`, real variant changes, system-prompt hash changes, and explicit user refresh paths add sessions to `PendingMaterializationSessions`.
 * Background historian publications use DeferredMaterializationSessions.
 *
 * Historian and recomp queue drops via `queueDropsForCompartmentalizedMessages`; the next safe pass must materialize them to prevent context accumulation.
 */
export type PendingMaterializationSessions = Set<string>;

/** `DeferredMaterializationSessions` persists deferred drop-materialization signals from background historian publication. */
export type DeferredMaterializationSessions = Set<string>;

export type LastHeuristicsTurnId = Map<string, string>;

export function getLiveNotificationParams(
    sessionId: string,
    liveModelBySession: LiveModelBySession,
    variantBySession: VariantBySession,
    agentBySession?: AgentBySession,
    toastDurationMs?: number,
): {
    agent?: string;
    variant?: string;
    providerId?: string;
    modelId?: string;
    toastDurationMs?: number;
} {
    const model = liveModelBySession.get(sessionId);
    const variant = variantBySession.get(sessionId);
    const agent = agentBySession?.get(sessionId);
    return {
        ...(agent ? { agent } : {}),
        ...(variant ? { variant } : {}),
        ...(model ? { providerId: model.providerID, modelId: model.modelID } : {}),
        ...(typeof toastDurationMs === "number" ? { toastDurationMs } : {}),
    };
}

export function createChatMessageHook(args: {
    db: Parameters<typeof getOrCreateSessionMeta>[0];
    liveModelBySession: LiveModelBySession;
    variantBySession: VariantBySession;
    agentBySession: AgentBySession;
    /** A real variant flip adds the session to `historyRefreshSessions`, `systemPromptRefreshSessions`, and `pendingMaterializationSessions`.
     * */
    historyRefreshSessions: HistoryRefreshSessions;
    systemPromptRefreshSessions: SystemPromptRefreshSessions;
    pendingMaterializationSessions: PendingMaterializationSessions;
    lastHeuristicsTurnId: LastHeuristicsTurnId;
    /**
     * */
    upgradeReminder?: (sessionId: string) => Promise<void>;
}) {
    return async (input: {
        sessionID?: string;
        variant?: string;
        agent?: string;
        model?: { providerID?: string; modelID?: string };
    }) => {
        const sessionId = input.sessionID;
        if (!sessionId) return;

        if (args.upgradeReminder) {
            void args.upgradeReminder(sessionId);
        }

        if (input.model?.providerID && input.model.modelID) {
            args.liveModelBySession.set(sessionId, {
                providerID: input.model.providerID,
                modelID: input.model.modelID,
            });
        }

        // Channel 1 `ctx_reduce` injects the reminder into tool outputs.
        // The chat-message hook tracks no per-user-turn reminder state.

        const previousVariant = args.variantBySession.get(sessionId);
        args.variantBySession.set(sessionId, input.variant);
        if (input.agent) {
            args.agentBySession.set(sessionId, input.agent);
        }
        if (
            previousVariant !== undefined &&
            input.variant !== undefined &&
            previousVariant !== input.variant
        ) {
            //
            // `providerID` uses the hook input's model and falls back to `liveModelBySession` when the first `chat.message` predates a model-bearing event.
            // `variantChangeBustsProviderCache` returns `true` when `providerID` is unknown so a needed drain is not dropped.
            const providerID =
                input.model?.providerID ?? args.liveModelBySession.get(sessionId)?.providerID;
            if (variantChangeBustsProviderCache(providerID)) {
                sessionLog(
                    sessionId,
                    `variant changed (${previousVariant} -> ${input.variant}), triggering flush`,
                );
                args.historyRefreshSessions.add(sessionId);
                args.systemPromptRefreshSessions.add(sessionId);
                args.pendingMaterializationSessions.add(sessionId);
                args.lastHeuristicsTurnId.delete(sessionId);
            } else {
                // Queued operations wait for a natural cache bust: fold, threshold, TTL, or flush.
                // Historian publications trigger the next cache bust; the variant-change handler does not create one.
                sessionLog(
                    sessionId,
                    `variant changed (${previousVariant} -> ${input.variant}) on provider ${providerID} whose cache ignores request params; deferring flush to next natural bust`,
                );
            }
        }
    };
}

export function createEventHook(args: {
    eventHandler: (input: { event: { type: string; properties?: unknown } }) => Promise<void>;
    contextUsageMap: Map<
        string,
        { usage: { percentage: number; inputTokens: number }; updatedAt: number }
    >;
    db: Parameters<typeof getOrCreateSessionMeta>[0];
    liveModelBySession: LiveModelBySession;
    variantBySession: VariantBySession;
    agentBySession: AgentBySession;
    /**
     * sessionDirectoryBySession caches resolved `session.directory` values from `client.session.get(...)`.
     * `session.deleted` clears `sessionDirectoryBySession` to prevent leaks.
     */
    sessionDirectoryBySession: Map<string, string>;
    /** `session.deleted` clears all signal sets to prevent leaks. */
    historyRefreshSessions: HistoryRefreshSessions;
    deferredHistoryRefreshSessions: DeferredHistoryRefreshSessions;
    systemPromptRefreshSessions: SystemPromptRefreshSessions;
    pendingMaterializationSessions: PendingMaterializationSessions;
    deferredMaterializationSessions: DeferredMaterializationSessions;
    lastHeuristicsTurnId: LastHeuristicsTurnId;
    commitSeenLastPass?: Map<string, boolean>;
    client: PluginContext["client"];
    protectedTags: number;
}) {
    return async (input: { event: { type: string; properties?: unknown } }) => {
        await args.eventHandler(input);

        if (input.event.type === "message.updated") {
            const messageInfo = getMessageUpdatedInfo(input.event.properties);
            if (messageInfo?.messageID) {
                const isTerminalUser = messageInfo.role === "user";
                const isTerminalAssistant =
                    messageInfo.role === "assistant" &&
                    (typeof messageInfo.completedAt === "number" ||
                        typeof messageInfo.finish === "string");
                if (isTerminalUser || isTerminalAssistant) {
                    scheduleIncrementalIndex(
                        args.db,
                        messageInfo.sessionID,
                        messageInfo.messageID,
                        readRawSessionMessageById,
                    );
                }
            }

            const assistantInfo = getMessageUpdatedAssistantInfo(input.event.properties);
            if (assistantInfo?.providerID && assistantInfo?.modelID) {
                const previous = args.liveModelBySession.get(assistantInfo.sessionID);
                args.liveModelBySession.set(assistantInfo.sessionID, {
                    providerID: assistantInfo.providerID,
                    modelID: assistantInfo.modelID,
                });
                // A model change clears stale context usage and historian failure state.
                // A model change clears stale context usage and historian failure state.
                // A model change clears stale context usage and historian failure state so the transform does not use the previous model's metrics or emergency state.
                if (
                    previous &&
                    (previous.providerID !== assistantInfo.providerID ||
                        previous.modelID !== assistantInfo.modelID)
                ) {
                    // A reasoning watermark is valid only for the model that produced it.
                    // An interleaved-reasoning provider cannot use a reasoning watermark from the previous model.
                    // An interleaved-reasoning provider cannot use a reasoning watermark from the previous model.
                    // Replaying a previous model's watermark would re-clear typed reasoning.
                    // OpenCode preserves typed reasoning so it can emit `reasoning_content` on the wire.
                    // A normal model requires a fresh reasoning-cleanup cutoff after a model switch.
                    // A normal model requires a fresh reasoning-cleanup cutoff after a model switch.
                    // A normal model requires a fresh reasoning-cleanup cutoff after a model switch.
                    // Reasoning watermarks are valid only for the model that produced them.
                    dropSlot(assistantInfo.sessionID, "model-change");
                    sessionLog(
                        assistantInfo.sessionID,
                        `model changed (${previous.providerID}/${previous.modelID} -> ${assistantInfo.providerID}/${assistantInfo.modelID}), clearing historian failure state and reasoning watermark`,
                    );
                    // The event handler preserves `lastContextPercentage` and `lastInputTokens` because it computed them with the new model's context limit.
                    // Clearing `lastContextPercentage` or `lastInputTokens` would erase the first valid usage sample for the new model.
                    // Clearing `lastContextPercentage` or `lastInputTokens` would erase the first valid usage sample for the new model.
                    clearHistorianFailureState(args.db, assistantInfo.sessionID);
                    clearPersistedReasoningWatermark(args.db, assistantInfo.sessionID);
                    // The transform's model-change branch does not run after a live switch.
                    // The live-switch handler clears stale context usage and historian failure state because the transform does not handle live model switches.
                    clearDetectedContextLimit(args.db, assistantInfo.sessionID);
                    clearEmergencyRecovery(args.db, assistantInfo.sessionID);
                    // Model changes reset the context latch because the context limit can change.
                    clearEmergencyDropSample(args.db, assistantInfo.sessionID);
                    updateSessionMeta(args.db, assistantInfo.sessionID, {
                        clearedReasoningThroughTag: 0,
                        observedSafeInputTokens: 0,
                        cacheAlertSent: false,
                    });
                }
            }
        }

        const properties = getSessionProperties(input.event.properties);
        const sessionId = resolveEventSessionId(properties);
        if (!sessionId) return;

        if (input.event.type !== "session.deleted") {
            scheduleReconciliation(args.db, sessionId, readRawSessionMessages);
        }

        if (input.event.type === "session.deleted") {
            args.liveModelBySession.delete(sessionId);
            args.variantBySession.delete(sessionId);
            args.agentBySession.delete(sessionId);
            args.sessionDirectoryBySession.delete(sessionId);
            args.historyRefreshSessions.delete(sessionId);
            args.deferredHistoryRefreshSessions.delete(sessionId);
            args.systemPromptRefreshSessions.delete(sessionId);
            args.pendingMaterializationSessions.delete(sessionId);
            args.deferredMaterializationSessions.delete(sessionId);
            args.lastHeuristicsTurnId.delete(sessionId);
            args.commitSeenLastPass?.delete(sessionId);
            clearIgnoredMessages(sessionId);
            resetNoteNudgeCooldownOnly(sessionId);
            clearAutoSearchForSession(sessionId);
            clearSidebarSnapshotCache(sessionId);
            clearSessionTracking(sessionId);
        }

        if (input.event.type !== "session.deleted") {
            await flushIgnoredMessages(sessionId);
        }
    };
}

export function createCommandExecuteBeforeHook(commandHandler: {
    "command.execute.before": (
        input: import("./command-handler").CommandExecuteInput,
        output: import("./command-handler").CommandExecuteOutput,
        params: { agent?: string; variant?: string; providerId?: string; modelId?: string },
    ) => Promise<unknown>;
}) {
    return async (input: unknown, output: unknown) => {
        const typedInput = input as import("./command-handler").CommandExecuteInput & {
            agent?: string;
            variant?: string;
            providerID?: string;
            modelID?: string;
        };
        const params = {
            agent: typedInput.agent,
            variant: typedInput.variant,
            providerId: typedInput.providerID,
            modelId: typedInput.modelID,
        };
        return commandHandler["command.execute.before"](
            typedInput as import("./command-handler").CommandExecuteInput,
            output as import("./command-handler").CommandExecuteOutput,
            params,
        );
    };
}

/**
 * OpenCode persists and replays mutations to `output.output` verbatim.
 * Persisted `output.output` mutations require no anchor store, CAS, or replay machinery.
 * Channel 1 skips MCP-server tools whose output is stored in `result.content[]`.
 */
function maybeInjectChannel1Nudge(
    args: {
        db: Parameters<typeof getOrCreateSessionMeta>[0];
        channel1StateBySession: Map<string, Channel1State>;
    },
    sessionId: string,
    tool: string,
    output: unknown,
): void {
    const state = args.channel1StateBySession.get(sessionId);
    // No baseline disables Channel 1 nudges for this session.
    if (!state) return;

    if (output === null || typeof output !== "object") return;
    const out = output as { output?: unknown };
    if (typeof out.output !== "string" || out.output.length === 0) return;

    // The sentinel prevents adding a second nudge when `out.output` already contains `CHANNEL1_SENTINEL`.
    if (out.output.includes(CHANNEL1_SENTINEL)) return;

    // The completed output is next-pass input inside the recency reserve, so it increases T but not U.
    state.turnDeltaT += toolOutputTokens(out.output);

    if (state.reducedSinceRefresh) return;

    const decision = decideChannel1({
        baselineU: state.baselineU,
        baselineT: state.baselineT,
        turnDeltaU: state.turnDeltaU,
        turnDeltaT: state.turnDeltaT,
        lastNudgeUndropped: getLastNudgeUndropped(args.db, sessionId),
        lastNudgeLevel: getLastNudgeLevel(args.db, sessionId),
        hasRecentReduce: false,
        evaluable: state.evaluable,
        generationInvalidated: state.generationInvalidated,
    });

    // The hook persists cadence and band state so a reduce-driven drop re-arms the nudge.
    setLastNudgeUndropped(args.db, sessionId, decision.nextLastNudge);
    setLastNudgeLevel(args.db, sessionId, decision.nextLastNudgeLevel);
    if (!decision.fire) return;

    out.output += buildChannel1Reminder(
        decision.level,
        decision.undroppedTokens,
        state.oldestReclaimableToolTags,
    );
    sessionLog(
        sessionId,
        `channel1 nudge fired: level=${decision.level} undropped~${Math.round(decision.undroppedTokens / 1000)}k tool=${tool}`,
    );
}

export function createToolExecuteAfterHook(args: {
    db: Parameters<typeof getOrCreateSessionMeta>[0];
    channel1StateBySession: Map<string, Channel1State>;
    client?: PluginContext["client"];
    transformMode?: "ts" | "rust";
    todoStateSet?: (input: {
        sessionId: string;
        stateJson: string;
        ownerMessageId: string;
    }) => Promise<unknown>;
}) {
    return async (input: unknown, output?: unknown) => {
        const typedInput = input as {
            tool?: string;
            sessionID?: string;
            args?: unknown;
            agent?: string;
        };
        if (!typedInput.sessionID || !typedInput.tool) {
            return;
        }

        await flushIgnoredMessages(typedInput.sessionID);

        if (typedInput.tool === "ctx_reduce") {
            // After `ctx_reduce`, mark the Channel 1 baseline dirty.
            const state = args.channel1StateBySession.get(typedInput.sessionID);
            if (state) {
                state.reducedSinceRefresh = true;
                state.evaluable = false;
                state.generationInvalidated = true;
            }
            try {
                resetLastNudgeCycle(args.db, typedInput.sessionID);
            } catch (error) {
                sessionLog(typedInput.sessionID, "channel1 reduce reset failed (ignored):", error);
            }
        } else {
            // Injection failures do not block the tool result.
            try {
                maybeInjectChannel1Nudge(args, typedInput.sessionID, typedInput.tool, output);
            } catch (error) {
                sessionLog(
                    typedInput.sessionID,
                    "channel1 nudge injection failed (ignored):",
                    error,
                );
            }
        }
        if (typedInput.tool === "todowrite") {
            // The hook persists task-list state only for native `todowrite` after checking availability and live permission.
            // remain refused.
            const todowriteVerdict = resolveTodowriteAvailability(typedInput.sessionID);
            if (todowriteVerdict.frozen && !todowriteVerdict.callable) return;
            const activeAgent = typedInput.agent;
            if (args.client) {
                try {
                    if (
                        await todowritePermissionDenied(
                            args.client,
                            typedInput.sessionID,
                            activeAgent,
                        )
                    ) {
                        return;
                    }
                } catch (error) {
                    // The permission check preserves a prior live deny across a transient SDK read.
                    // TODO: Prevent SDK read failures from resuming stale capture.
                    if (cachedToolPermissionDenied(typedInput.sessionID, "todowrite")) {
                        return;
                    }
                    sessionLog(
                        typedInput.sessionID,
                        "todowrite permission read failed during capture (ignored):",
                        error,
                    );
                }
            }
            // The hook triggers a note nudge only when every work item is `completed` or `cancelled`.
            const todoArgs = typedInput.args as { todos?: unknown } | undefined;
            const todos = todoArgs?.todos;
            const sessionMeta = Array.isArray(todos)
                ? getOrCreateSessionMeta(args.db, typedInput.sessionID)
                : null;
            if (sessionMeta && !sessionMeta.isSubagent) {
                const normalizedTodos = normalizeTodoStateJson(todos);
                if (normalizedTodos !== null) {
                    updateSessionMeta(args.db, typedInput.sessionID, {
                        lastTodoState: normalizedTodos,
                    });
                    if (args.transformMode === "rust" && args.todoStateSet) {
                        const todoSessionId = typedInput.sessionID;
                        const rawArgs =
                            typedInput.args && typeof typedInput.args === "object"
                                ? (typedInput.args as Record<string, unknown>)
                                : {};
                        const ownerMessageId =
                            (typeof rawArgs.owner_message_id === "string" &&
                                rawArgs.owner_message_id) ||
                            (typeof rawArgs.message_id === "string" && rawArgs.message_id) ||
                            (typeof (typedInput as { messageID?: unknown }).messageID ===
                                "string" &&
                                (typedInput as { messageID: string }).messageID) ||
                            (typeof (typedInput as { callID?: unknown }).callID === "string" &&
                                (typedInput as { callID: string }).callID) ||
                            typedInput.sessionID;
                        void args
                            .todoStateSet({
                                sessionId: todoSessionId,
                                stateJson: normalizedTodos,
                                ownerMessageId,
                            })
                            .catch((error) => {
                                sessionLog(
                                    todoSessionId,
                                    "rust todo_state.set failed (ignored):",
                                    error,
                                );
                            });
                    }
                }
            }
            if (
                Array.isArray(todos) &&
                todos.length > 0 &&
                todos.every(
                    (t) =>
                        typeof t === "object" &&
                        t !== null &&
                        ((t as { status?: unknown }).status === "completed" ||
                            (t as { status?: unknown }).status === "cancelled"),
                )
            ) {
                // The hook does not retain note-nudge trigger state for subagents.
                if (sessionMeta && !sessionMeta.isSubagent) {
                    onNoteTrigger(args.db, typedInput.sessionID, "todos_complete");
                }
            }
        }
        if (typedInput.tool === "ctx_note") {
            clearNoteNudgeTriggerAndCooldown(args.db, typedInput.sessionID);
        }
    };
}
