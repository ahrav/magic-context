import type { createCompactionHandler } from "../../features/magic-context/compaction";
import { scheduleClearAndReindex } from "../../features/magic-context/message-index-async";
import {
    detectOverflow,
    type OverflowDetection,
} from "../../features/magic-context/overflow-detection";
import {
    clearHistorianFailureState,
    clearPendingCompactionMarkerStateIf,
    clearSession,
    deleteIndexedMessage,
    deleteTagsByMessageId,
    getHistorianFailureState,
    getMaxTagNumberBySession,
    getOrCreateSessionMeta,
    getOverflowState,
    getPendingCompactionMarkerState,
    getPersistedNoteNudge,
    getPersistedReasoningWatermark,
    markSessionCleanupPending,
    recordDetectedContextLimit,
    recordOverflowDetected,
    removeAutoSearchHintDecisionByMessageId,
    removeNoteNudgeAnchorByMessageId,
    removeStrippedPlaceholderId,
    setPersistedReasoningWatermark,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import {
    getChannel2NudgeState,
    getPersistedCompactionMarkerState,
} from "../../features/magic-context/storage-meta-persisted";
import type { Tagger } from "../../features/magic-context/tagger";
import {
    clearTransformDecisionSession,
    scheduleOpenCodeTransformDecisionWrite,
} from "../../features/magic-context/transform-decision-log";
import type { ContextUsage, SessionMeta } from "../../features/magic-context/types";
import { captureWindowReport } from "../../features/magic-context/window-report-ledger";
import { log, sessionLog } from "../../shared/logger";
import {
    refreshModelLimitsAfterAuthOnce,
    refreshModelLimitsFromApi,
} from "../../shared/models-dev-cache";
import { maybeDeliverChannel2 } from "./channel2-delivery";
import { removeCompactionMarkerForSession } from "./compaction-marker-manager";
import {
    getMessageRemovedInfo,
    getMessageUpdatedAssistantInfo,
    getSessionCreatedInfo,
    getSessionErrorInfo,
    getSessionProperties,
} from "./event-payloads";
import {
    resolveCacheTtl,
    resolveContextLimit,
    resolveModelKey,
    resolveSessionId,
} from "./event-resolvers";
import { dropSlot } from "./lkg-slot";
import { clearNoteNudgeTriggerOnly } from "./note-nudger";
import { readRawSessionMessages } from "./read-session-chunk";
import { invalidateTrueRawTokenCache } from "./read-session-true-raw-tokens";
import { type NotificationParams, sendIgnoredMessage } from "./send-session-notification";
import { clearMessageTokensCache } from "./transform";
import { resetDegradedCacheCount } from "./transform-postprocess-phase";

const CONTEXT_USAGE_TTL_MS = 60 * 60 * 1000;

type CacheTtlConfig = string | Record<string, string>;

interface ContextUsageEntry {
    usage: ContextUsage;
    updatedAt: number;
    lastResponseTime?: number;
    hasUsageTokens?: boolean;
}

interface MessageRemovedCleanupResult {
    clearedNoteNudge: boolean;
}

export interface EventHandlerDeps {
    contextUsageMap: Map<string, ContextUsageEntry>;
    compactionHandler: ReturnType<typeof createCompactionHandler>;
    /**
     * Compaction-off mode, boot-resolved. Overflow recovery is
     * never armed in this mode (record the provider-reported limit only, so
     * raw-usage math stays accurate) and Channel-2 delivery stays silent;
     * the off-transition clears any persisted intent.
     */
    compactionOff?: boolean;
    onSessionCacheInvalidated?: (sessionId: string) => void;
    onRustWireInvalidated?: (sessionId: string) => void;
    onSessionDeleted?: (sessionId: string) => void;
    config: {
        protected_tags: number;
        clear_reasoning_age?: number;
        execute_threshold_percentage?: number | { default: number; [modelKey: string]: number };
        execute_threshold_tokens?: { default?: number; [modelKey: string]: number | undefined };
        cache_ttl: CacheTtlConfig;
        commit_cluster_trigger?: { enabled: boolean; min_clusters: number };
    };
    tagger: Tagger;
    // `db` is non-null because the hook disables MC when `openDatabase()` fails.
    db: import("../../shared/sqlite").Database;
    /** The in-process client OpenCode hands the plugin; Channel 2 delivers through it. */
    client?: unknown;
    /** Channel 2 reads the Channel 1 per-session metric baseline for ceiling-nudge wording. */
    channel1StateBySession?: Map<string, import("./ctx-reduce-nudge").Channel1State>;
    /** The handler holds Rust module directives until terminal `message.updated` so Rust and TypeScript nudges use the same host-side delivery path. */
    channel2DirectiveTextBySession?: Map<string, string>;
    getNotificationParams?: (sessionId: string) => NotificationParams;
    /**
     * `internalChildSessions` tracks `magic-context-` child sessions so transform and system-prompt hooks exempt them from the MC pipeline.
     */
    internalChildSessions?: Set<string>;
}

/* */
const INTERNAL_CHILD_TITLE_PREFIX = "magic-context-";

function formatTokens(value: number): string {
    return value.toLocaleString();
}

function evictExpiredUsageEntries(contextUsageMap: Map<string, ContextUsageEntry>): void {
    const now = Date.now();
    for (const [sessionId, entry] of contextUsageMap) {
        if (now - entry.updatedAt > CONTEXT_USAGE_TTL_MS) {
            contextUsageMap.delete(sessionId);
        }
    }
}

/**
 * The handler delivers pending Channel 2 nudges at assistant step boundaries; primary sessions also fall back at final stop, while subagents deliver only during active runs.
 */
async function deliverChannel2IfPending(deps: EventHandlerDeps, sessionId: string): Promise<void> {
    try {
        // Channel 2 delivers to primary sessions and subagents through `deps.client`.
        // active.
        const baseline = deps.channel1StateBySession?.get(sessionId);
        // A reduce after the persisted generation invalidates its U/T values.
        // `pending` remains set until a cache-busting pass rewalks the final rendered tail, preventing stale mass from consuming the cap.
        if (baseline?.reducedSinceRefresh) return;
        const delivered = await maybeDeliverChannel2(sessionId, {
            db: deps.db,
            client: deps.client,
            directiveText: deps.channel2DirectiveTextBySession?.get(sessionId),
            baseline,
            oldestReclaimableToolTags: baseline?.oldestReclaimableToolTags,
        });
        if (delivered || getChannel2NudgeState(deps.db, sessionId) !== "pending") {
            deps.channel2DirectiveTextBySession?.delete(sessionId);
        }
    } catch (error) {
        sessionLog(sessionId, "channel2 delivery wrapper failed (ignored):", error);
    }
}

function cleanupRemovedMessageState(
    deps: EventHandlerDeps,
    sessionId: string,
    messageId: string,
): MessageRemovedCleanupResult {
    return deps.db.transaction(() => {
        const removedTagNumbers = deleteTagsByMessageId(deps.db, sessionId, messageId);
        sessionLog(
            sessionId,
            `event message.removed: deleted ${removedTagNumbers.length} tag(s) for message ${messageId}`,
        );

        const strippedPlaceholderRemoved = removeStrippedPlaceholderId(
            deps.db,
            sessionId,
            messageId,
        );
        sessionLog(
            sessionId,
            strippedPlaceholderRemoved
                ? `event message.removed: removed ${messageId} from stripped placeholder ids`
                : `event message.removed: stripped placeholder ids unchanged for ${messageId}`,
        );

        const removedNoteNudgeAnchor = removeNoteNudgeAnchorByMessageId(
            deps.db,
            sessionId,
            messageId,
        );
        const removedAutoSearchDecision = removeAutoSearchHintDecisionByMessageId(
            deps.db,
            sessionId,
            messageId,
        );
        const persistedNoteNudge = getPersistedNoteNudge(deps.db, sessionId);
        const clearedNoteNudgeTrigger = persistedNoteNudge.triggerMessageId === messageId;
        if (clearedNoteNudgeTrigger) {
            clearNoteNudgeTriggerOnly(deps.db, sessionId);
        }
        const clearedNoteNudge = removedNoteNudgeAnchor || clearedNoteNudgeTrigger;
        sessionLog(
            sessionId,
            clearedNoteNudge
                ? `event message.removed: pruned note nudge state for ${messageId}`
                : `event message.removed: note nudge state unchanged for ${messageId}`,
        );
        sessionLog(
            sessionId,
            removedAutoSearchDecision
                ? `event message.removed: pruned auto-search decision for ${messageId}`
                : `event message.removed: auto-search decision unchanged for ${messageId}`,
        );

        const currentWatermark = getPersistedReasoningWatermark(deps.db, sessionId);
        const maxRemainingTag = getMaxTagNumberBySession(deps.db, sessionId);
        if (currentWatermark > maxRemainingTag) {
            setPersistedReasoningWatermark(deps.db, sessionId, maxRemainingTag);
            sessionLog(
                sessionId,
                `event message.removed: reset reasoning watermark ${currentWatermark}→${maxRemainingTag}`,
            );
        } else {
            sessionLog(
                sessionId,
                `event message.removed: reasoning watermark unchanged at ${currentWatermark} (max tag ${maxRemainingTag})`,
            );
        }

        const removedIndexedMessages = deleteIndexedMessage(deps.db, sessionId, messageId);
        sessionLog(
            sessionId,
            `event message.removed: deleted ${removedIndexedMessages} indexed message row(s) for ${messageId}`,
        );

        return {
            clearedNoteNudge,
        };
    })();
}

/** Record a provider-reported context limit without arming overflow recovery. */
function recordLimitWithoutArming(
    db: Parameters<typeof recordDetectedContextLimit>[0],
    sessionId: string,
    detection: Pick<
        OverflowDetection,
        "reportedLimit" | "reportedLimitProvenance" | "matchedPattern"
    >,
    modelKey: string | undefined,
    logSuffix: string,
    note?: string,
): void {
    if (typeof detection.reportedLimit === "number" && detection.reportedLimit > 0) {
        recordDetectedContextLimit(
            db,
            sessionId,
            detection.reportedLimit,
            modelKey,
            detection.reportedLimitProvenance,
        );
    }
    sessionLog(
        sessionId,
        `overflow detected ${logSuffix}: reportedLimit=${detection.reportedLimit ?? "unknown"} provenance=${detection.reportedLimitProvenance ?? "n/a"} pattern=${detection.matchedPattern ?? "n/a"} — recorded limit only${note ? ` (${note})` : ""}`,
    );
}

export function createEventHandler(deps: EventHandlerDeps) {
    return async (input: { event: { type: string; properties?: unknown } }): Promise<void> => {
        evictExpiredUsageEntries(deps.contextUsageMap);

        const properties = getSessionProperties(input.event.properties);

        if (input.event.type === "session.created") {
            const info = getSessionCreatedInfo(input.event.properties);
            if (!info) {
                return;
            }

            // The handler adds hidden sessions titled `magic-context-` to `internalChildSessions` so transform and system-prompt hooks exempt them; the set is not persisted across restarts.
            if (
                deps.internalChildSessions &&
                info.parentID.length > 0 &&
                typeof info.title === "string" &&
                info.title.startsWith(INTERNAL_CHILD_TITLE_PREFIX)
            ) {
                deps.internalChildSessions.add(info.id);
                sessionLog(
                    info.id,
                    `marked internal magic-context child (title="${info.title}") — exempt from transform + injection`,
                );
            }

            try {
                const modelKey = resolveModelKey(info.providerID, info.modelID);
                updateSessionMeta(deps.db, info.id, {
                    isSubagent: info.parentID.length > 0,
                    cacheTtl: resolveCacheTtl(deps.config.cache_ttl, modelKey),
                });
            } catch (error) {
                sessionLog(info.id, "event session.created persistence failed:", error);
            }
            return;
        }

        if (input.event.type === "session.error") {
            const errInfo = getSessionErrorInfo(input.event.properties);
            if (!errInfo) {
                return;
            }
            try {
                const detection = detectOverflow(errInfo.error);
                if (!detection.isOverflow) {
                    return;
                }
                captureWindowReport({
                    db: deps.db,
                    sessionID: errInfo.sessionID,
                    matchedPattern: detection.matchedPattern,
                    reportedLimit: detection.reportedLimit,
                    reportedLimitProvenance: detection.reportedLimitProvenance,
                    error: errInfo.error,
                });
                const sessionMeta = getOrCreateSessionMeta(deps.db, errInfo.sessionID);
                if (sessionMeta.isSubagent) {
                    // Subagents can't run historian, so we skip the recovery
                    // flag — but the reported limit is still useful data for
                    // pressure math (consumed by resolveContextLimit via
                    // getOverflowState). Record it without arming recovery.
                    recordLimitWithoutArming(
                        deps.db,
                        errInfo.sessionID,
                        detection,
                        undefined,
                        "on subagent",
                        "subagents cannot run historian",
                    );
                    return;
                }
                const existing = getOverflowState(deps.db, errInfo.sessionID);
                if (deps.compactionOff) {
                    // Compaction-off: never arm MC emergency recovery — the
                    // latch machinery is gated off and the off-transition
                    // clears any persisted latch. The provider-reported limit
                    // is still useful for raw-usage math (the sidebar's only
                    // numeric source in this mode), so record it without
                    // arming, exactly like the subagent path above.
                    recordLimitWithoutArming(
                        deps.db,
                        errInfo.sessionID,
                        detection,
                        undefined,
                        "in compaction-off mode",
                        "recovery disarmed; native compaction owns the window",
                    );
                    return;
                }
                dropSlot(errInfo.sessionID, "overflow-recovery-arm");
                recordOverflowDetected(
                    deps.db,
                    errInfo.sessionID,
                    detection.reportedLimit,
                    undefined,
                    "provider_overflow",
                    detection.reportedLimitProvenance,
                );
                sessionLog(
                    errInfo.sessionID,
                    `overflow detected via session.error: reportedLimit=${detection.reportedLimit ?? "unknown"} provenance=${detection.reportedLimitProvenance ?? "n/a"} pattern=${detection.matchedPattern ?? "n/a"} (previousRecovery=${existing.needsEmergencyRecovery})`,
                );
                deps.onSessionCacheInvalidated?.(errInfo.sessionID);
            } catch (error) {
                sessionLog(errInfo.sessionID, "event session.error handling failed:", error);
            }
            return;
        }

        if (input.event.type === "message.updated") {
            const info = getMessageUpdatedAssistantInfo(input.event.properties);
            if (!info) {
                const sessionId = properties ? resolveSessionId(properties) : null;
                if (sessionId) {
                    sessionLog(
                        sessionId,
                        "event message.updated: no assistant info extracted from event",
                    );
                } else {
                    log(
                        "[magic-context] event message.updated: no assistant info extracted from event",
                    );
                }
                return;
            }

            // The handler recomputes cached token contributions at `message.updated`; streaming, edited, or retried messages may have stale cached content, and a missing message ID requires clearing the session cache.
            // At terminal `message.updated`, recompute cached token contributions for partial, edited, or retried messages.
            // Partial streaming content requires recomputing the cached token contribution after `message.updated`.
            // Edited or retried messages require recomputing their cached token contribution.
            // A missing message ID prevents per-message invalidation, so the handler clears the session cache.
            if (info.messageID) {
                clearMessageTokensCache(info.sessionID, info.messageID);
                invalidateTrueRawTokenCache({
                    sessionId: info.sessionID,
                    messageId: info.messageID,
                    reason: "message.updated",
                });
            } else {
                clearMessageTokensCache(info.sessionID);
                invalidateTrueRawTokenCache({
                    sessionId: info.sessionID,
                    reason: "message.updated",
                });
            }

            let messageHadOverflowError = false;

            // The handler checks both `session.error` and assistant-message errors because OpenCode may report overflow through either event; either event can arrive first or be absent.
            // OpenCode may attach overflow errors to assistant messages as well as emit `session.error`.
            // The handler checks both `session.error` and assistant-message errors because OpenCode may report overflow through either event.
            // The handler checks `session.error` and assistant-message errors because either overflow event can arrive first or be absent.
            // Subagents have no emergency recovery machinery that can consume the emergency-recovery flag.
            // Subagents do not consume the emergency-recovery flag because they cannot run historian.
            if (info.error !== undefined && info.error !== null) {
                const detection = detectOverflow(info.error);
                if (detection.isOverflow) {
                    messageHadOverflowError = true;
                    try {
                        captureWindowReport({
                            db: deps.db,
                            sessionID: info.sessionID,
                            providerID: info.providerID,
                            modelID: info.modelID,
                            matchedPattern: detection.matchedPattern,
                            reportedLimit: detection.reportedLimit,
                            reportedLimitProvenance: detection.reportedLimitProvenance,
                            attemptedTokens:
                                (info.tokens?.input ?? 0) +
                                (info.tokens?.cache?.read ?? 0) +
                                (info.tokens?.cache?.write ?? 0),
                            error: info.error,
                        });
                        const overflowModelKey = resolveModelKey(info.providerID, info.modelID);
                        const metaForOverflow = getOrCreateSessionMeta(deps.db, info.sessionID);
                        if (metaForOverflow.isSubagent) {
                            // Still record the detected limit (useful for
                            // pressure math), but don't arm recovery — see
                            // session.error path above.
                            recordLimitWithoutArming(
                                deps.db,
                                info.sessionID,
                                detection,
                                overflowModelKey,
                                "on subagent via message.updated",
                            );
                        } else if (deps.compactionOff) {
                            // Compaction-off: record the limit only, never arm
                            // recovery (mirrors the session.error path above).
                            recordLimitWithoutArming(
                                deps.db,
                                info.sessionID,
                                detection,
                                overflowModelKey,
                                "in compaction-off mode via message.updated",
                            );
                        } else {
                            dropSlot(info.sessionID, "overflow-recovery-arm");
                            recordOverflowDetected(
                                deps.db,
                                info.sessionID,
                                detection.reportedLimit,
                                overflowModelKey,
                                "provider_overflow",
                                detection.reportedLimitProvenance,
                            );
                            sessionLog(
                                info.sessionID,
                                `overflow detected via message.updated: reportedLimit=${detection.reportedLimit ?? "unknown"} provenance=${detection.reportedLimitProvenance ?? "n/a"} pattern=${detection.matchedPattern ?? "n/a"}`,
                            );
                            deps.onSessionCacheInvalidated?.(info.sessionID);
                        }
                    } catch (error) {
                        sessionLog(
                            info.sessionID,
                            "event message.updated overflow persistence failed:",
                            error,
                        );
                    }
                }
            }

            const now = Date.now();
            const usageTokens = [
                info.tokens?.input,
                info.tokens?.cache?.read,
                info.tokens?.cache?.write,
            ];
            const hasUsageTokens = usageTokens.some(
                (value) => typeof value === "number" && value > 0,
            );
            const terminalAssistantUpdate =
                info.messageID !== undefined &&
                hasUsageTokens &&
                (typeof info.finish === "string" || typeof info.completedAt === "number");
            if (terminalAssistantUpdate && info.messageID) {
                scheduleOpenCodeTransformDecisionWrite({
                    db: deps.db,
                    sessionId: info.sessionID,
                    messageId: info.messageID,
                    inputTokens:
                        (info.tokens?.input ?? 0) +
                        (info.tokens?.cache?.read ?? 0) +
                        (info.tokens?.cache?.write ?? 0),
                });
            }

            sessionLog(
                info.sessionID,
                `event message.updated: provider=${info.providerID} model=${info.modelID} hasUsageTokens=${hasUsageTokens} tokens.input=${info.tokens?.input} cache.read=${info.tokens?.cache?.read} cache.write=${info.tokens?.cache?.write}`,
            );

            const hasKnownUsage = hasUsageTokens || deps.contextUsageMap.has(info.sessionID);
            if (!hasKnownUsage) {
                sessionLog(
                    info.sessionID,
                    "event message.updated: skipping — no usage tokens and no known usage",
                );
                return;
            }

            try {
                const modelKey = resolveModelKey(info.providerID, info.modelID);
                const updates: Partial<SessionMeta> & { lastResponseTime: number } = {
                    lastResponseTime: now,
                };

                if (typeof deps.config.cache_ttl === "string") {
                    updates.cacheTtl = resolveCacheTtl(deps.config.cache_ttl, modelKey);
                } else if (modelKey) {
                    updates.cacheTtl = resolveCacheTtl(deps.config.cache_ttl, modelKey);
                }

                if (hasUsageTokens) {
                    const totalInputTokens =
                        (info.tokens?.input ?? 0) +
                        (info.tokens?.cache?.read ?? 0) +
                        (info.tokens?.cache?.write ?? 0);
                    // A request that returns usage proves authentication is live; then re-warm the model-limit cache once to replace stale pre-auth limits.
                    // The process re-warms the model-limit cache once after authentication to replace stale pre-auth limits.
                    // After authentication, the process re-warms the model-limit cache once to replace stale pre-auth limits.
                    // A stale pre-auth cache can retain the raw 922k limit instead of OAuth's 272k limit.
                    // Subsequent successful warms are no-ops.
                    if (deps.client) {
                        await refreshModelLimitsAfterAuthOnce(
                            deps.client as Parameters<typeof refreshModelLimitsAfterAuthOnce>[0],
                        );
                    }
                    let contextLimit = resolveContextLimit(info.providerID, info.modelID, {
                        db: deps.db,
                        sessionID: info.sessionID,
                    });
                    let percentage = contextLimit > 0 ? (totalInputTokens / contextLimit) * 100 : 0;

                    sessionLog(
                        info.sessionID,
                        `event message.updated: totalInputTokens=${totalInputTokens} contextLimit=${contextLimit} percentage=${percentage.toFixed(1)}%`,
                    );

                    const sessionMeta = getOrCreateSessionMeta(deps.db, info.sessionID);
                    const observedSafeInputTokens = sessionMeta.observedSafeInputTokens ?? 0;
                    if (
                        percentage > 100 &&
                        observedSafeInputTokens > 0 &&
                        totalInputTokens <= observedSafeInputTokens * 2
                    ) {
                        const oldLimit = contextLimit;
                        if (deps.client) {
                            await refreshModelLimitsFromApi(
                                deps.client as Parameters<typeof refreshModelLimitsFromApi>[0],
                            );
                            contextLimit = resolveContextLimit(info.providerID, info.modelID, {
                                db: deps.db,
                                sessionID: info.sessionID,
                            });
                            if (contextLimit >= totalInputTokens) {
                                percentage = (totalInputTokens / contextLimit) * 100;
                                sessionLog(
                                    info.sessionID,
                                    `models-dev-cache: regression recovered for ${info.providerID}/${info.modelID} via refresh (was=${oldLimit}, now=${contextLimit})`,
                                );
                            }
                        }

                        if (contextLimit < totalInputTokens && !sessionMeta.cacheAlertSent) {
                            const safeTokens = Math.max(observedSafeInputTokens, totalInputTokens);
                            const delivery = await sendIgnoredMessage(
                                deps.client,
                                info.sessionID,
                                `⚠️ Magic Context: OpenCode reports a context limit of ${formatTokens(contextLimit)} tokens for ${info.providerID}/${info.modelID} but you've successfully sent ${formatTokens(safeTokens)} tokens in this session — the cached limit looks wrong. Restart OpenCode if you suspect this is incorrect.`,
                                deps.getNotificationParams?.(info.sessionID) ?? {},
                            );
                            // `cacheAlertSent` remains unset unless a notification reaches a user-visible surface.
                            if (delivery === "sent") {
                                updates.cacheAlertSent = true;
                            }
                        }
                    }

                    deps.contextUsageMap.set(info.sessionID, {
                        usage: {
                            percentage,
                            inputTokens: totalInputTokens,
                        },
                        updatedAt: now,
                        lastResponseTime: now,
                        hasUsageTokens: true,
                    });

                    updates.lastContextPercentage = percentage;
                    updates.lastInputTokens = totalInputTokens;
                    updates.lastUsageContextLimit = contextLimit;
                    updates.lastObservedModelKey = modelKey ?? null;
                    if (!messageHadOverflowError) {
                        updates.observedSafeInputTokens = Math.max(
                            observedSafeInputTokens,
                            totalInputTokens,
                        );
                    }

                    const historianFailureState = getHistorianFailureState(deps.db, info.sessionID);
                    if (historianFailureState.failureCount > 0 && percentage < 90) {
                        clearHistorianFailureState(deps.db, info.sessionID);
                        sessionLog(
                            info.sessionID,
                            `event message.updated: cleared historian failure state at ${percentage.toFixed(1)}%`,
                        );
                    }
                }

                updateSessionMeta(deps.db, info.sessionID, updates);
            } catch (error) {
                sessionLog(info.sessionID, "event message.updated persistence failed:", error);
            }

            // The handler delivers mid-turn so the agent can act before additional reclaimable context accumulates.
            // Reclaimable context can accumulate before the next assistant event.
            // `deliverChannel2IfPending` delivers only to subagents with active runs.
            // `deliverChannel2IfPending` no-ops unless a pending intent exists.
            if (
                (info.finish === "stop" || info.finish === "tool-calls") &&
                deps.client &&
                deps.channel1StateBySession &&
                !deps.compactionOff
            ) {
                void deliverChannel2IfPending(deps, info.sessionID);
            }
            return;
        }

        if (input.event.type === "message.removed") {
            const info = getMessageRemovedInfo(input.event.properties);
            if (!info) {
                const sessionId = properties ? resolveSessionId(properties) : null;
                if (sessionId) {
                    sessionLog(
                        sessionId,
                        "event message.removed: no message removal info extracted from event",
                    );
                } else {
                    log(
                        "[magic-context] event message.removed: no message removal info extracted from event",
                    );
                }
                return;
            }

            dropSlot(info.sessionID, "message.removed");
            deps.onRustWireInvalidated?.(info.sessionID);
            sessionLog(
                info.sessionID,
                `event message.removed: invalidating state for message ${info.messageID}`,
            );

            try {
                cleanupRemovedMessageState(deps, info.sessionID, info.messageID);
                scheduleClearAndReindex(deps.db, info.sessionID, readRawSessionMessages);

                deps.tagger.cleanup(info.sessionID);
                sessionLog(
                    info.sessionID,
                    "event message.removed: invalidated tagger session cache",
                );

                // A compaction marker is invalid when its boundary or summary message is removed.
                const markerState = getPersistedCompactionMarkerState(deps.db, info.sessionID);
                if (
                    markerState &&
                    (markerState.boundaryMessageId === info.messageID ||
                        markerState.summaryMessageId === info.messageID)
                ) {
                    removeCompactionMarkerForSession(deps.db, info.sessionID);
                    sessionLog(
                        info.sessionID,
                        `event message.removed: cleared compaction marker (boundary or summary message removed)`,
                    );
                }

                clearMessageTokensCache(info.sessionID, info.messageID);
                invalidateTrueRawTokenCache({
                    sessionId: info.sessionID,
                    messageId: info.messageID,
                    reason: "message.removed",
                });

                deps.onSessionCacheInvalidated?.(info.sessionID);
                sessionLog(
                    info.sessionID,
                    "event message.removed: cleared session injection cache",
                );
            } catch (error) {
                sessionLog(info.sessionID, "event message.removed cleanup failed:", error);
            }
            return;
        }

        if (input.event.type === "session.compacted") {
            const sessionId = resolveSessionId(properties);
            if (!sessionId) {
                return;
            }

            dropSlot(sessionId, "session.compacted");
            try {
                deps.compactionHandler.onCompacted(sessionId, deps.db);
            } catch (error) {
                sessionLog(sessionId, "event session.compacted handling failed:", error);
            }
            // When native compaction deletes the boundary message, remove the marker to prevent orphaned rows.
            try {
                removeCompactionMarkerForSession(deps.db, sessionId);
            } catch (error) {
                sessionLog(sessionId, "event session.compacted marker cleanup failed:", error);
            }
            // User-driven OpenCode compaction invalidates deferred pending markers because it replaces their boundary.
            try {
                const pending = getPendingCompactionMarkerState(deps.db, sessionId);
                if (pending) {
                    clearPendingCompactionMarkerStateIf(deps.db, sessionId, pending);
                }
            } catch (error) {
                sessionLog(
                    sessionId,
                    "event session.compacted pending-marker cleanup failed:",
                    error,
                );
            }
            resetDegradedCacheCount(sessionId);
            // Clear the session's per-message token cache after compaction because compaction deletes or replaces messages.
            // The next transform pass recomputes token counts from the compacted message set.
            clearMessageTokensCache(sessionId);
            invalidateTrueRawTokenCache({ sessionId, reason: "session.compacted" });
            deps.onSessionCacheInvalidated?.(sessionId);
            return;
        }

        if (input.event.type === "session.deleted") {
            const sessionId = resolveSessionId(properties);
            if (!sessionId) {
                return;
            }

            dropSlot(sessionId, "session.deleted");
            try {
                // Commit the retry marker before deletion; `clearSession` removes it with the session data, so a `BUSY` error or rollback leaves it for the next maintenance tick.
                markSessionCleanupPending(deps.db, sessionId);
                // Read and remove compaction marker BEFORE clearSession destroys session_meta.
                // `pending_compaction_marker_state` is stored in the `session_meta` row deleted by `clearSession`.
                // Deleting `session_meta` with `clearSession` clears `pending_compaction_marker_state` without a separate CAS.
                removeCompactionMarkerForSession(deps.db, sessionId);
                clearSession(deps.db, sessionId);
            } catch (error) {
                sessionLog(sessionId, "event session.deleted persistence failed:", error);
            }
            resetDegradedCacheCount(sessionId);
            deps.onSessionCacheInvalidated?.(sessionId);
            deps.onSessionDeleted?.(sessionId);
            deps.contextUsageMap.delete(sessionId);
            deps.tagger.cleanup(sessionId);
            clearTransformDecisionSession(sessionId);
            clearMessageTokensCache(sessionId);
            invalidateTrueRawTokenCache({ sessionId, reason: "session.deleted" });
            return;
        }
    };
}
