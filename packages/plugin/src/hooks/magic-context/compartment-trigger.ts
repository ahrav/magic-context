import {
    getLastCompartmentEndMessage,
    getLastCompartmentEndMessageId,
} from "../../features/magic-context/compartment-storage";
import {
    deriveTagLoadFloor,
    getActiveTagsBySession,
    getPendingOps,
    getTriggerTagTokenUpperBound,
    loadProtectedTailMeta,
} from "../../features/magic-context/storage";
import type { ContextUsage, SessionMeta, TagEntry } from "../../features/magic-context/types";
import { escalationBands } from "../../shared/escalation-bands";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import {
    createDefaultBoundarySnapshotForTests,
    getRawHistoryEligibility,
    hasRunnableCompartmentWindow,
    type ProtectedTailBoundarySnapshot,
    resolveOpenCodeProtectedTailBoundary,
} from "./protected-tail-boundary";
import {
    primeInMemoryTailRawMessageCache,
    primeTailRawMessageCache,
    readSessionChunk,
    withRawSessionMessageCache,
} from "./read-session-chunk";
import {
    buildInMemoryTailRawMessages,
    type InMemoryMessageView,
    type RawMessage,
} from "./read-session-raw";
import { estimateTrueRawMessageTokens } from "./read-session-true-raw-tokens";
import { modelAcceptsEmptyContent } from "./sentinel";

const PROACTIVE_TRIGGER_OFFSET_PERCENTAGE = 2;
const POST_DROP_TARGET_RATIO = 0.75;
const MIN_PROACTIVE_TAIL_TOKEN_ESTIMATE = 6_000;
const MIN_PROACTIVE_TAIL_MESSAGE_COUNT = 12;
const DEFAULT_MIN_COMMIT_CLUSTERS_FOR_TRIGGER = 3;
const TAIL_SIZE_TRIGGER_MULTIPLIER = 3;
const BLOCK_UNTIL_DONE_PERCENTAGE = 95;
const CONTENT_TAG_OWNER_SUFFIX = /:(?:p|file)\d+$/;

export { BLOCK_UNTIL_DONE_PERCENTAGE, POST_DROP_TARGET_RATIO };

export interface CompartmentTriggerResult {
    shouldFire: boolean;
    reason?: "projected_headroom" | "force_band" | "commit_clusters" | "tail_size";
    /**
     * The trigger computes its decision from this protected-tail boundary snapshot.
     * boundarySnapshot is present whenever tail inspection runs; transform callers that start the historian in the same pass must pass boundarySnapshot to runCompartmentPhase.
     * Passing boundarySnapshot to runCompartmentPhase preserves one boundary resolution per pass.
     * Passing boundarySnapshot gives the historian the snapshot used for the trigger decision.
     * decision saw.
     */
    boundarySnapshot?: ProtectedTailBoundarySnapshot;
}

/**
 * InMemoryTailSource contains the transform's args.messages converted to absolute-ordinal RawMessages.
 * buildInMemoryTailRawMessages must use anchorFound=true when constructing InMemoryTailSource.
 * When callers supply InMemoryTailSource, tail inspection primes the raw-message cache from memory.
 * The in-memory path performs no opencode.db reads during tail inspection.
 * Callers must pass only an anchored conversion; otherwise leave the source undefined to use the DB-primed path.
 * Unanchored conversions have assumed ordinals; leave the source undefined to use the DB-primed path.
 */
export interface InMemoryTailSource {
    messages: RawMessage[];
    absoluteMessageCount: number;
}

/**
 * ReasoningProjectionCapability indicates whether a provider can clear reasoning content when projecting reclaimable bytes.
 * OpenCode derives canClearReasoning from empty-sentinel support.
 * Serializers omit cleared thinking for every provider.
 */
export interface ReasoningProjectionCapability {
    providerID?: string;
    canClearReasoning?: boolean;
}

/**
 * LazyInMemoryTailSource defers RawMessage conversion until tail inspection requires it.
 * The trigger's cheap gate uses the caller-provided tag floor before constructing RawMessages.
 * The factory constructs RawMessages only when authoritative tail inspection is needed.
 */
export type LazyInMemoryTailSource = () => InMemoryTailSource | undefined;

function tagOwnerMessageId(row: {
    type: string;
    message_id: string;
    tool_owner_message_id: string | null;
}): string {
    if (row.type === "tool") return row.tool_owner_message_id ?? row.message_id;
    return row.message_id.replace(CONTENT_TAG_OWNER_SUFFIX, "");
}

function getActiveOrDroppedTagOwnerMessageIds(
    db: Database,
    sessionId: string,
    floor = 0,
): Set<string> {
    // The returned owner IDs identify in-memory tail messages already covered by tags.
    // The cheap-gate estimate charges only messages without a matching tag owner.
    // Every in-memory tail message is at or after floor by construction, so tags below floor cannot cover tail messages.
    const rows = (
        floor > 0
            ? db
                  .prepare(
                      `SELECT type, message_id, tool_owner_message_id
                       FROM tags
                       WHERE session_id = ? AND status IN ('active', 'dropped') AND tag_number >= ?`,
                  )
                  .all(sessionId, floor)
            : db
                  .prepare(
                      `SELECT type, message_id, tool_owner_message_id
                       FROM tags
                       WHERE session_id = ? AND status IN ('active', 'dropped')`,
                  )
                  .all(sessionId)
    ) as Array<{
        type: string;
        message_id: string;
        tool_owner_message_id: string | null;
    }>;
    const owners = new Set<string>();
    for (const row of rows) owners.add(tagOwnerMessageId(row));
    return owners;
}

function estimateUntaggedInMemoryTailUpperBound(
    db: Database,
    sessionId: string,
    inMemoryTail: InMemoryTailSource,
    taggerFloor = 0,
): number {
    const lastCompartmentEnd = getLastCompartmentEndMessage(db, sessionId);
    const coveredOwnerMessageIds = getActiveOrDroppedTagOwnerMessageIds(db, sessionId, taggerFloor);
    let total = 0;
    for (const message of inMemoryTail.messages) {
        // The anchored in-memory tail includes the last compartment boundary row
        // The boundary row is not eligible for a new compartment.
        // The persisted bound excludes compacted tags, so the estimate must not charge the boundary row.
        if (message.ordinal <= lastCompartmentEnd) continue;
        if (coveredOwnerMessageIds.has(message.id)) continue;
        total += estimateTrueRawMessageTokens(message, {
            providerShapeVersion: "opencode-v1",
        }).total;
    }
    return total;
}

/**
 * Convert `args.messages` into a trigger tail source only when the compaction boundary is present.
 * The conversion returns a tail source only when it finds the compaction boundary in args.messages.
 *
 * anchorFound is true only when args.messages contains the compaction boundary.
 * The compaction boundary is the anchor; marker-draining lag can place it after the array head.
 * Drop the prefix because it belongs to an already compartmentalized range.
 * An absent anchor makes ordinal assignment unverifiable.
 * Without a boundary message ID, ordinal assignment is unverifiable.
 *
 */
export function buildTriggerInMemoryTail(
    db: Database,
    sessionId: string,
    messages: readonly InMemoryMessageView[],
): InMemoryTailSource | undefined {
    if (messages.length === 0) return undefined;
    const lastCompartmentEnd = getLastCompartmentEndMessage(db, sessionId);
    const anchorMessageId = getLastCompartmentEndMessageId(db, sessionId);
    if (lastCompartmentEnd >= 1 && !anchorMessageId) return undefined;

    const built = buildInMemoryTailRawMessages({
        messages,
        lastCompartmentEnd,
        anchorMessageId,
    });
    if (!built) return undefined;
    if (lastCompartmentEnd >= 1 && anchorMessageId && !built.anchorFound) return undefined;
    return { messages: built.messages, absoluteMessageCount: built.absoluteMessageCount };
}

export function getProactiveCompartmentTriggerPercentage(
    executeThresholdPercentage: number,
): number {
    return Math.max(0, executeThresholdPercentage - PROACTIVE_TRIGGER_OFFSET_PERCENTAGE);
}

function estimateProjectedPostDropPercentage(
    db: Database,
    sessionId: string,
    usage: ContextUsage,
    activeTags: readonly TagEntry[],
    clearReasoningAge: number | undefined,
    clearedReasoningThroughTag: number | undefined,
    canClearReasoning: boolean,
): number | null {
    // Denominator must include both text/tool bytes and reasoning bytes to match the numerator
    const totalActiveBytes = activeTags.reduce(
        (sum, tag) => sum + tag.byteSize + tag.reasoningByteSize,
        0,
    );
    if (totalActiveBytes === 0) return null;

    let droppableBytes = 0;

    const pendingDrops = getPendingOps(db, sessionId).filter((op) => op.operation === "drop");
    const pendingDropTagIds = new Set(pendingDrops.map((op) => op.tagId));
    if (pendingDrops.length > 0) {
        droppableBytes += activeTags
            .filter((tag) => pendingDropTagIds.has(tag.tagNumber))
            .reduce((sum, tag) => sum + tag.byteSize + tag.reasoningByteSize, 0);
    }

    const maxTag = activeTags.reduce((max, t) => Math.max(max, t.tagNumber), 0);
    if (
        canClearReasoning &&
        clearReasoningAge !== undefined &&
        clearedReasoningThroughTag !== undefined
    ) {
        const reasoningAgeCutoff = maxTag - clearReasoningAge;
        for (const tag of activeTags) {
            if (tag.type !== "message") continue;
            // The reasoning-clear estimate excludes tags already counted in pending drops.
            if (pendingDropTagIds.has(tag.tagNumber)) continue;
            if (tag.tagNumber <= clearedReasoningThroughTag) continue;
            if (tag.tagNumber > reasoningAgeCutoff) continue;
            if (tag.reasoningByteSize > 0) {
                droppableBytes += tag.reasoningByteSize;
            }
        }
    }

    if (droppableBytes === 0) return null;

    const dropRatio = Math.min(droppableBytes / totalActiveBytes, 1);
    return usage.percentage * (1 - dropRatio);
}

interface TailInfo {
    nextStartOrdinal: number;
    hasNewRawHistory: boolean;
    hasProtectedEligibleHead: boolean;
    isMeaningful: boolean;
    tokenEstimate: number;
    /**
     * `tokenEstimate` saturates at the scan budget when content exceeds it.
     * Budget exhaustion means narratable content exceeds the tail-size threshold.
     */
    chunkHasMore: boolean;
    trueRawEligibleTokens: number;
    commitClusterCount: number;
    boundarySnapshot?: ProtectedTailBoundarySnapshot;
}

const TAIL_INFO_DEFAULTS: TailInfo = {
    nextStartOrdinal: 1,
    hasNewRawHistory: false,
    hasProtectedEligibleHead: false,
    isMeaningful: false,
    tokenEstimate: 0,
    chunkHasMore: false,
    trueRawEligibleTokens: 0,
    commitClusterCount: 0,
};

function resolveBoundaryContextLimit(usage: ContextUsage, fallbackContextLimit?: number): number {
    if (fallbackContextLimit && fallbackContextLimit > 0) return fallbackContextLimit;
    if (usage.percentage > 0 && usage.inputTokens > 0) {
        return Math.max(1, Math.round(usage.inputTokens / (usage.percentage / 100)));
    }
    return 128_000;
}

function getUnsummarizedTailInfo(
    db: Database,
    sessionId: string,
    triggerBudget: number,
    usage: ContextUsage,
    executeThresholdPercentage: number,
    contextLimit?: number,
    inMemoryTail?: InMemoryTailSource,
    taggerFloor = 0,
): TailInfo {
    return withRawSessionMessageCache(() => {
        try {
            const memoryPrimed = inMemoryTail
                ? primeInMemoryTailRawMessageCache({
                      sessionId,
                      messages: inMemoryTail.messages,
                      absoluteMessageCount: inMemoryTail.absoluteMessageCount,
                  })
                : false;
            if (!memoryPrimed) {
                const policyVersion = loadProtectedTailMeta(
                    db,
                    sessionId,
                ).protectedTailPolicyVersion;
                if (policyVersion >= 3) {
                    primeTailRawMessageCache({
                        sessionId,
                        lastCompartmentEnd: getLastCompartmentEndMessage(db, sessionId),
                        anchorMessageId: getLastCompartmentEndMessageId(db, sessionId),
                    });
                }
            }

            const rawEligibility = getRawHistoryEligibility(db, sessionId);
            if (!rawEligibility.hasRawBeyondLastCompartment) {
                return { ...TAIL_INFO_DEFAULTS, nextStartOrdinal: rawEligibility.offset };
            }

            const boundary =
                process.env.NODE_ENV === "test"
                    ? createDefaultBoundarySnapshotForTests(sessionId)
                    : resolveOpenCodeProtectedTailBoundary({
                          db,
                          sessionId,
                          mode: "trigger",
                          contextLimit: resolveBoundaryContextLimit(usage, contextLimit),
                          executeThresholdPercentage,
                          usage,
                          usageSource: "live",
                          taggerFloor,
                      });
            const hasProtectedEligibleHead = boundary.offset < boundary.protectedTailStart;

            if (!hasProtectedEligibleHead) {
                return {
                    ...TAIL_INFO_DEFAULTS,
                    nextStartOrdinal: rawEligibility.offset,
                    hasNewRawHistory: true,
                    boundarySnapshot: boundary,
                };
            }

            const scanBudget = Math.max(
                MIN_PROACTIVE_TAIL_TOKEN_ESTIMATE,
                triggerBudget * TAIL_SIZE_TRIGGER_MULTIPLIER,
            );
            const chunk = readSessionChunk(
                sessionId,
                scanBudget,
                rawEligibility.offset,
                boundary.protectedTailStart,
            );
            const isMeaningful =
                chunk.hasMore ||
                boundary.trueRawEligibleTokens >= MIN_PROACTIVE_TAIL_TOKEN_ESTIMATE ||
                chunk.tokenEstimate >= MIN_PROACTIVE_TAIL_TOKEN_ESTIMATE ||
                chunk.messageCount >= MIN_PROACTIVE_TAIL_MESSAGE_COUNT;

            return {
                nextStartOrdinal: rawEligibility.offset,
                hasNewRawHistory: true,
                hasProtectedEligibleHead,
                isMeaningful,
                tokenEstimate: chunk.tokenEstimate,
                chunkHasMore: chunk.hasMore,
                trueRawEligibleTokens: boundary.trueRawEligibleTokens,
                commitClusterCount: chunk.commitClusterCount,
                boundarySnapshot: boundary,
            };
        } catch (error) {
            sessionLog(sessionId, "compartment trigger: raw tail inspection failed:", error);
            return TAIL_INFO_DEFAULTS;
        }
    });
}

export function checkCompartmentTrigger(
    db: Database,
    sessionId: string,
    sessionMeta: SessionMeta,
    usage: ContextUsage,
    _previousPercentage: number,
    executeThresholdPercentage: number,
    triggerBudget: number,
    clearReasoningAge?: number,
    commitClusterTrigger?: { enabled: boolean; min_clusters: number },
    preloadedActiveTags?: readonly TagEntry[],
    contextLimit?: number,
    inMemoryTail?: InMemoryTailSource | LazyInMemoryTailSource,
    taggerFloorOverride?: number,
    reasoningProjection?: ReasoningProjectionCapability,
): CompartmentTriggerResult {
    if (sessionMeta.compartmentInProgress) {
        sessionLog(
            sessionId,
            `compartment trigger: skipped — historian already in progress (usage=${usage.percentage.toFixed(1)}%)`,
        );
        return { shouldFire: false };
    }

    const lazyInMemoryTail = typeof inMemoryTail === "function" ? inMemoryTail : undefined;
    let resolvedInMemoryTail = typeof inMemoryTail === "function" ? undefined : inMemoryTail;

    if (resolvedInMemoryTail) {
        try {
            const policyVersion = loadProtectedTailMeta(db, sessionId).protectedTailPolicyVersion;
            if (policyVersion < 3) resolvedInMemoryTail = undefined;
        } catch {
            resolvedInMemoryTail = undefined;
        }
    }

    //
    const taggerFloor =
        taggerFloorOverride !== undefined && taggerFloorOverride > 0
            ? taggerFloorOverride
            : resolvedInMemoryTail
              ? deriveTagLoadFloor(
                    db,
                    sessionId,
                    resolvedInMemoryTail.messages.map((m) => m.id),
                )
              : 0;

    //
    const proactiveFloorForGate = getProactiveCompartmentTriggerPercentage(
        executeThresholdPercentage,
    );
    if (usage.percentage < proactiveFloorForGate) {
        try {
            const boundFloor = resolvedInMemoryTail || lazyInMemoryTail ? taggerFloor : 0;
            const { bound: persistedBound, nullCount } = getTriggerTagTokenUpperBound(
                db,
                sessionId,
                boundFloor,
            );
            if (nullCount === 0) {
                const untaggedUpperBound = resolvedInMemoryTail
                    ? estimateUntaggedInMemoryTailUpperBound(
                          db,
                          sessionId,
                          resolvedInMemoryTail,
                          taggerFloor,
                      )
                    : 0;
                const eligibleUpperBound = persistedBound + untaggedUpperBound;
                if (eligibleUpperBound < triggerBudget) {
                    const memorySuffix = resolvedInMemoryTail
                        ? ` (persisted=${persistedBound}, untagged-memory≤${untaggedUpperBound})`
                        : "";
                    sessionLog(
                        sessionId,
                        `compartment trigger: cheap-skip at ${usage.percentage.toFixed(1)}% (below proactive floor ${proactiveFloorForGate}%) — live-tail upper bound ${eligibleUpperBound}${memorySuffix} < triggerBudget ${triggerBudget}; no size trigger possible, skipped full raw read`,
                    );
                    return { shouldFire: false };
                }
            }
        } catch (error) {
            sessionLog(
                sessionId,
                `compartment trigger: cheap-gate skipped (falling through to full read): ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    if (lazyInMemoryTail) {
        try {
            const policyVersion = loadProtectedTailMeta(db, sessionId).protectedTailPolicyVersion;
            if (policyVersion >= 3) resolvedInMemoryTail = lazyInMemoryTail();
        } catch {
            resolvedInMemoryTail = undefined;
        }
    }

    const tailInfo = getUnsummarizedTailInfo(
        db,
        sessionId,
        triggerBudget,
        usage,
        executeThresholdPercentage,
        contextLimit,
        resolvedInMemoryTail,
        taggerFloor,
    );
    if (!tailInfo.hasNewRawHistory) {
        try {
            const lastCompartmentEnd = getLastCompartmentEndMessage(db, sessionId);
            sessionLog(
                sessionId,
                `compartment trigger: skipped — no new raw history (usage=${usage.percentage.toFixed(1)}% nextStartOrdinal=${tailInfo.nextStartOrdinal} lastCompartmentEnd=${lastCompartmentEnd})`,
            );
        } catch (error) {
            sessionLog(
                sessionId,
                `compartment trigger: skipped — no new raw history (usage=${usage.percentage.toFixed(1)}% nextStartOrdinal=${tailInfo.nextStartOrdinal} diagnostic-collection-failed: ${error instanceof Error ? error.message : String(error)})`,
            );
        }
        return { shouldFire: false };
    }

    const canClearReasoning =
        reasoningProjection?.canClearReasoning ??
        modelAcceptsEmptyContent(reasoningProjection?.providerID);
    const projectedPostDropPercentage = estimateProjectedPostDropPercentage(
        db,
        sessionId,
        usage,
        preloadedActiveTags ?? getActiveTagsBySession(db, sessionId),
        clearReasoningAge,
        sessionMeta.clearedReasoningThroughTag,
        canClearReasoning,
    );
    const relativePostDropTarget = executeThresholdPercentage * POST_DROP_TARGET_RATIO;

    const forceMaterializationPercentage = escalationBands(
        executeThresholdPercentage,
    ).forceMaterializationPercentage;
    if (usage.percentage >= forceMaterializationPercentage) {
        if (
            projectedPostDropPercentage !== null &&
            projectedPostDropPercentage <= relativePostDropTarget
        ) {
            sessionLog(
                sessionId,
                `compartment trigger: skipping force band ${forceMaterializationPercentage}% because projected post-drop usage is ${projectedPostDropPercentage.toFixed(1)}% (target ${relativePostDropTarget.toFixed(1)}%)`,
            );
            return { shouldFire: false };
        }

        sessionLog(
            sessionId,
            `compartment trigger: force-firing at ${usage.percentage.toFixed(1)}% (projected post-drop ${projectedPostDropPercentage?.toFixed(1) ?? "none"}%)`,
        );
        if (tailInfo.boundarySnapshot && hasRunnableCompartmentWindow(tailInfo.boundarySnapshot)) {
            return {
                shouldFire: true,
                reason: "force_band",
                boundarySnapshot: tailInfo.boundarySnapshot,
            };
        }
        const scale = usage.percentage >= BLOCK_UNTIL_DONE_PERCENTAGE ? 0.25 : 0.5;
        const scaledBoundary = withRawSessionMessageCache(() => {
            if (resolvedInMemoryTail) {
                primeInMemoryTailRawMessageCache({
                    sessionId,
                    messages: resolvedInMemoryTail.messages,
                    absoluteMessageCount: resolvedInMemoryTail.absoluteMessageCount,
                });
            }
            return resolveOpenCodeProtectedTailBoundary({
                db,
                sessionId,
                mode: "trigger",
                contextLimit: resolveBoundaryContextLimit(usage, contextLimit),
                executeThresholdPercentage,
                usage,
                usageSource: "live",
                emergencyTailScale: scale,
            });
        });
        if (hasRunnableCompartmentWindow(scaledBoundary)) {
            return { shouldFire: true, reason: "force_band", boundarySnapshot: scaledBoundary };
        }
        sessionLog(
            sessionId,
            "compartment trigger: force_band skipped — raw exists but protected head genuinely empty after emergency tail scale",
        );
        return { shouldFire: false };
    }

    const clusterEnabled = commitClusterTrigger?.enabled ?? true;
    const minClusters =
        commitClusterTrigger?.min_clusters ?? DEFAULT_MIN_COMMIT_CLUSTERS_FOR_TRIGGER;
    if (
        clusterEnabled &&
        tailInfo.commitClusterCount >= minClusters &&
        tailInfo.tokenEstimate >= triggerBudget
    ) {
        sessionLog(
            sessionId,
            `compartment trigger: commit-cluster fire — ${tailInfo.commitClusterCount} clusters (min=${minClusters}), ~${tailInfo.tokenEstimate} tokens in eligible prefix`,
        );
        return {
            shouldFire: true,
            reason: "commit_clusters",
            boundarySnapshot: tailInfo.boundarySnapshot,
        };
    }

    // crossed-the-threshold signal.
    if (
        tailInfo.tokenEstimate >= triggerBudget * TAIL_SIZE_TRIGGER_MULTIPLIER ||
        (tailInfo.chunkHasMore && tailInfo.tokenEstimate > 0)
    ) {
        sessionLog(
            sessionId,
            `compartment trigger: tail-size fire — ~${tailInfo.tokenEstimate} TC-chunked tokens (hasMore=${tailInfo.chunkHasMore}, true-raw ~${tailInfo.trueRawEligibleTokens}) exceeds ${triggerBudget * TAIL_SIZE_TRIGGER_MULTIPLIER} budget threshold`,
        );
        return {
            shouldFire: true,
            reason: "tail_size",
            boundarySnapshot: tailInfo.boundarySnapshot,
        };
    }

    const proactiveTriggerPercentage = getProactiveCompartmentTriggerPercentage(
        executeThresholdPercentage,
    );
    if (usage.percentage < proactiveTriggerPercentage) {
        sessionLog(
            sessionId,
            `compartment trigger: not firing at ${usage.percentage.toFixed(1)}% — below proactive floor (${proactiveTriggerPercentage}%)`,
        );
        return { shouldFire: false };
    }

    if (
        projectedPostDropPercentage !== null &&
        projectedPostDropPercentage <= relativePostDropTarget
    ) {
        sessionLog(
            sessionId,
            `compartment trigger: not firing at ${usage.percentage.toFixed(1)}% because projected post-drop usage is ${projectedPostDropPercentage.toFixed(1)}% (target ${relativePostDropTarget.toFixed(1)}%)`,
        );
        return { shouldFire: false };
    }

    if (!tailInfo.hasProtectedEligibleHead || !tailInfo.isMeaningful) {
        sessionLog(
            sessionId,
            `compartment trigger: not firing at ${usage.percentage.toFixed(1)}% because unsummarized tail from ${tailInfo.nextStartOrdinal} is too small`,
        );
        return { shouldFire: false };
    }

    sessionLog(
        sessionId,
        `compartment trigger: proactive fire at ${usage.percentage.toFixed(1)}% (floor=${proactiveTriggerPercentage}% projected post-drop=${projectedPostDropPercentage?.toFixed(1) ?? "none"}% target=${relativePostDropTarget.toFixed(1)}%)`,
    );
    return {
        shouldFire: true,
        reason: "projected_headroom",
        boundarySnapshot: tailInfo.boundarySnapshot,
    };
}
