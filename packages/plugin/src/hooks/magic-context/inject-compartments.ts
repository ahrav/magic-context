import { Buffer } from "node:buffer";
import {
    buildCompartmentBlock,
    type Compartment,
    type CompartmentDateRanges,
    escapeXmlAttr,
    escapeXmlContent,
    getCompartments,
    getLastCompartmentEndMessageId,
    type SessionFact,
} from "../../features/magic-context/compartment-storage";
import {
    type AuthorizedClaimMemorySnapshot,
    readAuthorizedClaimMemorySnapshot,
    renderClaimMemoryBlock,
    trimClaimSnapshotsToBudget,
    trimWorkspaceClaimSnapshotsToBudget,
} from "../../features/magic-context/memory/claim-memory-render";
import {
    canonicalSnapshotVector,
    type SnapshotVector,
} from "../../features/magic-context/memory/claim-operation-contract";
import { V2_MEMORY_CATEGORIES } from "../../features/magic-context/memory/constants";
import {
    hasClaimMemoryFragment,
    type ProjectMemoryClaimSnapshot,
    readProjectMemorySnapshotVector,
    snapshotVectorChanges,
} from "../../features/magic-context/memory/storage-claim-current-state";
import type { Memory } from "../../features/magic-context/memory/types";
import { resolveMuralWire } from "../../features/magic-context/mural/render-trigger";
import type { MuralWireOptions } from "../../features/magic-context/mural/resolve-mural";
import {
    computeProjectDocsHash,
    GLOBAL_USER_PROFILE_PROJECT_PATH,
    getMaxM0MutationId,
    getProjectState,
    persistCachedM0,
    readProjectDocsCanonical,
} from "../../features/magic-context/storage";
import { DIRECT_FORMAT_EPOCH } from "../../features/magic-context/storage-format-epoch";
import {
    getActiveUserMemories,
    type UserMemory,
} from "../../features/magic-context/user-memory/storage-user-memory";
import {
    computeWorkspaceEpochFingerprint,
    expandWorkspaceIdentitySetWithAliases,
    resolveStoredPathWorkspaceIdentity,
    resolveWorkspaceIdentitySet,
    resolveWorkspaceShareCategories,
    sourceNameForMemory,
    type WorkspaceIdentitySet,
} from "../../features/magic-context/workspaces";
import { BoundedSessionMap } from "../../shared/bounded-session-map";
import { piModelRefToCanonical } from "../../shared/harness-provider-map";
import { sessionLog } from "../../shared/logger";
import type { Database, Statement as PreparedStatement } from "../../shared/sqlite";
import { reconcileForkOrphanedCompactionMarkers } from "./compaction-marker-manager";
import {
    COMPARTMENT_RENDER_EPOCH,
    decodeCachedM0UpgradeIdentity,
    encodeCachedM0UpgradeIdentity,
} from "./compartment-render-epoch";
import { extractM0Block, renderCompartmentAtTier, renderDecayedCompartments } from "./decay-render";
import { getMessageTimesFromOpenCodeDb } from "./read-session-db";
import { estimateTokens } from "./read-session-formatting";
import type { MessageLike } from "./tag-messages";
import { formatDate } from "./temporal-awareness";

export interface PreparedCompartmentInjection {
    block: string;
    compartmentEndMessage: number;
    compartmentEndMessageId: string | null;
    compartmentCount: number;
    skippedVisibleMessages: number;
    factCount: number;
    memoryCount: number;
    rebuiltFromDb: boolean;
    /**
     * The transform sets needsFreshMaterialization when no durable compartment boundary is visible for a degraded injection and queues fresh materialization instead of re-anchoring.
     */
    needsFreshMaterialization?: boolean;
}

/**
 * Non-flush passes replay the cached result.
 * publications between passes do not bust the Anthropic prompt-cache prefix.
 * clearInjectionCache() invalidates the cache after historian, compressor, or recomp writes compartments or facts.
 *
 * The bounded LRU evicts entries for sessions that never emit session.deleted.
 * Cache-busting passes recompute evicted entries from authoritative SQLite compartment state.
 */
const INJECTION_CACHE_MAX = 100;
type InjectionCacheEntry =
    | {
          db: Database;
          kind: "empty";
          compartmentEndMessageId: string;
          renderedBytes: number;
          claimSnapshotVector: string;
          renderedRevisionLocators: string;
      }
    | {
          db: Database;
          kind: "populated";
          injection: PreparedCompartmentInjection;
          claimSnapshotVector: string;
          renderedRevisionLocators: string;
      };

const injectionCache = new BoundedSessionMap<InjectionCacheEntry>(INJECTION_CACHE_MAX);

export function clearInjectionCache(sessionId: string): void {
    injectionCache.delete(sessionId);
    // resetDegradedReanchorState makes re-anchoring evaluate the new compartment state.
    resetDegradedReanchorState(sessionId);
}

// Degraded-mode re-anchor
//
// When the compartment boundary is outside the visible window, the splice is a no-op and queues zero drops.
// A newer compaction marker can cut the visible window above the boundary and repeat the no-op splice on every pass.
// it:
// The first degraded detection runs fork-orphan marker hygiene.
// The hygiene pass removes foreign markers that outrank the session's marker.
// Removing the foreign marker makes filterCompacted stop at the session's marker again.
// After REANCHOR_MIN_DEGRADED_PASSES consecutive degraded rebuilds, the transform re-anchors the splice to the newest visible durable compartment boundary.
// Because re-anchoring changes rendered bytes, it runs only on cache-busting passes.

/**
 * degradedRebuildCountBySession counts consecutive rebuilds where the natural compartment boundary is outside the visible window and resets when a rebuild finds the boundary.
 * Defer-pass cache replays do not update the count because cached boundaries do not indicate natural-boundary visibility.
 * Defer-pass cache replays splice at the cached, possibly re-anchored boundary.
 */
const degradedRebuildCountBySession = new BoundedSessionMap<number>(INJECTION_CACHE_MAX);
/* */
const reAnchorLoggedBySession = new BoundedSessionMap<boolean>(INJECTION_CACHE_MAX);

/**
 * REANCHOR_MIN_DEGRADED_PASSES requires 2 consecutive degraded rebuilds to avoid reacting to a single transient.
 */
const REANCHOR_MIN_DEGRADED_PASSES = 2;

export function resetDegradedReanchorState(sessionId: string): void {
    degradedRebuildCountBySession.delete(sessionId);
    reAnchorLoggedBySession.delete(sessionId);
}

function noteDegradedRebuild(sessionId: string): number {
    const next = (degradedRebuildCountBySession.get(sessionId) ?? 0) + 1;
    degradedRebuildCountBySession.set(sessionId, next);
    return next;
}

function clearDegradedRebuild(sessionId: string): void {
    degradedRebuildCountBySession.delete(sessionId);
    reAnchorLoggedBySession.delete(sessionId);
}

/** logReanchorOnce logs one re-anchor announcement per degraded episode. */
function logReanchorOnce(sessionId: string, message: string): void {
    if (reAnchorLoggedBySession.get(sessionId)) return;
    reAnchorLoggedBySession.set(sessionId, true);
    sessionLog(sessionId, message);
}

/**
 * The re-anchor target is the newest durable compartment whose end message is visible.
 * The search returns the selected compartment's index in `compartments`, or -1.
 * Splicing at that boundary removes only messages covered by visible compartments.
 * The visible boundary preserves history when a newer marker cuts the window above it.
 */
function findVisibleReanchorIndex(
    compartments: readonly Compartment[],
    visibleMessageIds: ReadonlySet<string>,
): number {
    for (let index = compartments.length - 1; index >= 0; index -= 1) {
        const endMessageId = compartments[index]?.endMessageId;
        if (
            typeof endMessageId === "string" &&
            endMessageId.length > 0 &&
            visibleMessageIds.has(endMessageId)
        ) {
            return index;
        }
    }
    return -1;
}

/**
 * The function returns memory IDs rendered in the cached `<session-history>` block, if available.
 * `ctx_search` uses the IDs to exclude memories already in context.
 * Excluding rendered memories preserves tokens for unseen search results.
 *
 * The cache reader returns null when no cache exists or the JSON payload is malformed.
 * Callers must treat null as "don't filter"; missing or malformed cache data can only return redundant memories.
 */
export function getVisibleRevisionLocators(db: Database, sessionId: string): Set<string> | null {
    try {
        const row = db
            .prepare("SELECT memory_block_ids FROM session_meta WHERE session_id = ?")
            .get(sessionId) as { memory_block_ids: string | null } | null;
        if (!row?.memory_block_ids) return null;
        const parsed = JSON.parse(row.memory_block_ids) as unknown;
        if (!Array.isArray(parsed)) return null;
        const locators = new Set<string>();
        for (const value of parsed) {
            if (typeof value === "string" && value.length > 0) locators.add(value);
        }
        return locators.size > 0 ? locators : null;
    } catch {
        return null;
    }
}

export interface CompartmentInjectionResult {
    injected: boolean;
    prependedMessageCount: number;
    compartmentEndMessage: number;
    compartmentCount: number;
    skippedVisibleMessages: number;
}

export function renderMemoryBlock(memories: Memory[]): string | null {
    return renderMemoryBlockV2(memories) || null;
}

/** Constraint keywords identify memories that encode rules rather than descriptions. */
const CONSTRAINT_KEYWORDS = /\b(must|never|always|cannot|should not|must not)\b/i;

/**
 * utilityTier assigns injection priority tiers to memories.
 * Lower tier = higher priority (packed first).
 *
 */
function utilityTier(m: Memory): number {
    if (m.retrievalCount > 0) return 0;
    if (CONSTRAINT_KEYWORDS.test(m.content)) return 1;
    return 2;
}

/**
 *
 * Priority order:
 * Shorter content lets more memories fit within the budget.
 * The id tiebreaker stabilizes cached output.
 *
 */
export function trimMemoriesToBudget(
    sessionId: string,
    memories: Memory[],
    budgetTokens: number,
): Memory[] {
    const sorted = [...memories].sort((a, b) => {
        if (a.status === "permanent" && b.status !== "permanent") return -1;
        if (b.status === "permanent" && a.status !== "permanent") return 1;
        const tierDiff = utilityTier(a) - utilityTier(b);
        if (tierDiff !== 0) return tierDiff;
        const seenDiff = b.seenCount - a.seenCount;
        if (seenDiff !== 0) return seenDiff;
        // The sort places shorter memories first so more fit within the budget.
        const lenDiff = a.content.length - b.content.length;
        if (lenDiff !== 0) return lenDiff;
        return a.id - b.id;
    });

    const result: Memory[] = [];

    for (const memory of sorted) {
        // The budget check renders each candidate so category tags count only for included categories.
        const candidate = [...result, memory];
        if (estimateTokens(renderMemoryBlockV2(candidate)) > budgetTokens) {
            break;
        }
        result.push(memory);
    }

    if (result.length < memories.length) {
        sessionLog(
            sessionId,
            `trimmed memories from ${memories.length} to ${result.length} to fit injection budget of ${budgetTokens} tokens`,
        );
    }

    return result;
}

export function prepareCompartmentInjection(
    db: Database,
    sessionId: string,
    messages: MessageLike[],
    isCacheBusting: boolean,
    projectPath?: string,
    injectionBudgetTokens?: number,
    temporalAwareness?: boolean,
): PreparedCompartmentInjection | null {
    const workspace = resolveWorkspaceRenderContext({ db, projectPath });
    const claimLane = readClaimLaneSnapshot({ db, projectPath, workspace });
    const renderedClaims =
        claimLane === null
            ? []
            : trimClaimLane(
                  claimLane,
                  injectionBudgetTokens ?? DEFAULT_MEMORY_BUDGET_TOKENS,
                  workspace,
              );
    const claimSnapshotVector =
        claimLane === null ? "" : canonicalSnapshotVector(claimLane.snapshotVector);
    const renderedRevisionLocators = JSON.stringify(
        renderedClaims.map((item) => item.revisionLocator).sort(),
    );

    const cached = injectionCache.get(sessionId);
    if (
        cached &&
        (cached.db !== db ||
            cached.claimSnapshotVector !== claimSnapshotVector ||
            cached.renderedRevisionLocators !== renderedRevisionLocators)
    ) {
        clearInjectionCache(sessionId);
    }
    const replayableCached = injectionCache.get(sessionId);

    if (!isCacheBusting && replayableCached?.db === db && claimLane !== null) {
        if (replayableCached.kind === "empty") {
            return null;
        }
        const prepared = replayableCached.injection;
        if (prepared.compartmentEndMessageId === null) {
            sessionLog(
                sessionId,
                "compartment injection cache in degraded mode (null boundary), forcing rebuild",
            );
        } else {
            // Each pass rebuilds messages, so the splice uses the cached boundary.
            if (prepared.compartmentEndMessageId.length > 0) {
                const cutoffIndex = messages.findIndex(
                    (message) => message.info.id === prepared.compartmentEndMessageId,
                );
                if (cutoffIndex >= 0) {
                    const remaining = messages.slice(cutoffIndex + 1);
                    messages.splice(0, messages.length, ...remaining);
                } else {
                    // The cached injection remains during deferred passes to keep <session-history> stable.
                    sessionLog(
                        sessionId,
                        `compartment injection: cached boundary ${prepared.compartmentEndMessageId} not in messages (already trimmed), reusing cache`,
                    );
                }
            }
            return { ...prepared, rebuiltFromDb: false };
        }
    }

    const compartments = getCompartments(db, sessionId);
    // The renderer emits facts only from <project-memory> and ignores legacy session_facts rows.
    const facts: SessionFact[] = [];

    let memoryBlock =
        claimLane === null
            ? undefined
            : renderClaimMemoryBlock(renderedClaims, "project-memory", {
                  sourceNameByClaimId: claimLane.sourceNameByClaimId,
              }) || undefined;
    let memoryCount = renderedClaims.length;
    let claimLaneStable = claimLane !== null;
    if (claimLane !== null) {
        const freshVector = readProjectMemorySnapshotVector(
            db,
            claimLane.projectIds,
            claimLane.workspaceEpoch,
        );
        if (snapshotVectorChanges(claimLane.snapshotVector, freshVector).length > 0) {
            claimLaneStable = false;
            memoryBlock = undefined;
            memoryCount = 0;
        }
    }

    if (claimLaneStable) {
        try {
            db.prepare(
                "UPDATE session_meta SET memory_block_count = ?, memory_block_ids = ?, memory_block_hashes = ? WHERE session_id = ?",
            ).run(
                memoryCount,
                renderedRevisionLocators,
                JSON.stringify(renderedClaims.map((item) => item.contentDigest)),
                sessionId,
            );
        } catch (error) {
            const code = (error as { code?: string } | null)?.code;
            if (code !== "SQLITE_BUSY") throw error;
            sessionLog(sessionId, "claim locator cache update hit SQLITE_BUSY; skipping snapshot");
        }
    }

    if (compartments.length === 0 && facts.length === 0 && !memoryBlock) {
        if (claimLaneStable) {
            injectionCache.set(sessionId, {
                db,
                kind: "empty",
                claimSnapshotVector,
                renderedRevisionLocators,
                compartmentEndMessageId: "",
                renderedBytes: 0,
            });
        }
        return null;
    }

    let dateRanges: CompartmentDateRanges | undefined;
    if (temporalAwareness && compartments.length > 0) {
        const ids = new Set<string>();
        for (const c of compartments) {
            if (c.startMessageId) ids.add(c.startMessageId);
            if (c.endMessageId) ids.add(c.endMessageId);
        }
        const times = getMessageTimesFromOpenCodeDb(sessionId, Array.from(ids));
        const byId = new Map<number, { start: string; end: string }>();
        for (const c of compartments) {
            const startMs = times.get(c.startMessageId);
            const endMs = times.get(c.endMessageId);
            if (startMs !== undefined && endMs !== undefined) {
                byId.set(c.id, { start: formatDate(startMs), end: formatDate(endMs) });
            }
        }
        if (byId.size > 0) dateRanges = { byId };
    }

    let block = buildCompartmentBlock(compartments, facts, memoryBlock, dateRanges);
    if (claimLane !== null) {
        const freshVector = readProjectMemorySnapshotVector(
            db,
            claimLane.projectIds,
            claimLane.workspaceEpoch,
        );
        if (snapshotVectorChanges(claimLane.snapshotVector, freshVector).length > 0) {
            claimLaneStable = false;
            memoryBlock = undefined;
            memoryCount = 0;
            block = buildCompartmentBlock(compartments, facts, undefined, dateRanges);
        }
    }

    // When no compartments exist, injection omits a boundary cutoff.
    // When no compartments exist, injection omits a boundary cutoff.
    // When no messages are replaced, the injector prepends the block to messages[0].
    if (compartments.length === 0) {
        const result: PreparedCompartmentInjection = {
            block,
            compartmentEndMessage: 0,
            compartmentEndMessageId: "",
            compartmentCount: 0,
            skippedVisibleMessages: 0,
            factCount: facts.length,
            memoryCount,
            rebuiltFromDb: true,
        };
        if (claimLaneStable) {
            injectionCache.set(sessionId, {
                db,
                kind: "populated",
                injection: result,
                claimSnapshotVector,
                renderedRevisionLocators,
            });
        }
        return result;
    }

    const lastCompartment = compartments[compartments.length - 1];
    const lastEnd = lastCompartment.endMessage;
    const lastEndMessageId = lastCompartment.endMessageId;

    // A request rebuilds the cold in-memory injection cache after restart.
    // After restart, the in-memory injection cache is cold.
    // A compartment published after materialization is absent from cached m[0] and m[1].
    // Trimming to the latest boundary would discard that compartment's raw messages until the next exec pass.
    // The cached boundary keeps newer compartment messages in the live tail.
    // Only m0/m1 materialize/soft-refresh writes cached_m0_last_baseline_end_message_id.
    let trimEndMessageId = lastEndMessageId;
    if (!isCacheBusting) {
        const baseline = readCachedBaselineState(db, sessionId);
        if (baseline.hasCachedM0) {
            // A cold, non-cache-busting rebuild trims at the cached m[1] boundary.
            if (baseline.boundary) {
                trimEndMessageId = baseline.boundary;
            } else {
                // A null baseline.boundary means cached m[0]/m[1] has no compartment boundary.
                // Trimming to the latest boundary would discard raw messages absent from m[0] and m[1].
                // The null boundary suppresses trimming and retains all raw messages in the tail.
                // The next exec pass folds the retained tail messages into m[1].
                trimEndMessageId = "";
            }
        }
    }

    if (trimEndMessageId.length === 0) {
        sessionLog(
            sessionId,
            "injecting legacy compartments without visible-prefix trimming because latest stored compartment has no end_message_id",
            {
                compartmentCount: compartments.length,
                compartmentEndMessage: lastEnd,
            },
        );
        const result: PreparedCompartmentInjection = {
            block,
            compartmentEndMessage: lastEnd,
            compartmentEndMessageId: "",
            compartmentCount: compartments.length,
            skippedVisibleMessages: 0,
            factCount: facts.length,
            memoryCount,
            rebuiltFromDb: true,
        };
        if (claimLaneStable) {
            injectionCache.set(sessionId, {
                db,
                kind: "populated",
                injection: result,
                claimSnapshotVector,
                renderedRevisionLocators,
            });
        }
        return result;
    }

    let skippedVisibleMessages = 0;
    let needsFreshMaterialization = false;
    let resultEndMessage: number = lastEnd;
    let resultEndMessageId: string | null = null;
    const cutoffIndex = messages.findIndex((message) => message.info.id === trimEndMessageId);
    if (cutoffIndex >= 0) {
        clearDegradedRebuild(sessionId);
        skippedVisibleMessages = cutoffIndex + 1;
        const remaining = messages.slice(cutoffIndex + 1);
        messages.splice(0, messages.length, ...remaining);
        resultEndMessageId = trimEndMessageId;
    } else {
        const degradedCount = noteDegradedRebuild(sessionId);
        if (degradedCount === 1) {
            reconcileForkOrphanedCompactionMarkers(db, sessionId);
        }

        let reAnchored = false;
        if (degradedCount >= REANCHOR_MIN_DEGRADED_PASSES && isCacheBusting) {
            // Re-anchor only on cache-busting passes because re-anchoring changes bytes.
            const visibleMessageIds = new Set<string>();
            for (const message of messages) {
                if (typeof message.info.id === "string") visibleMessageIds.add(message.info.id);
            }
            const reAnchorIndex = findVisibleReanchorIndex(compartments, visibleMessageIds);
            if (reAnchorIndex >= 0) {
                const reAnchorCompartment = compartments[reAnchorIndex];
                const reAnchorCutoff = messages.findIndex(
                    (message) => message.info.id === reAnchorCompartment.endMessageId,
                );
                if (reAnchorCutoff >= 0) {
                    skippedVisibleMessages = reAnchorCutoff + 1;
                    const remaining = messages.slice(reAnchorCutoff + 1);
                    messages.splice(0, messages.length, ...remaining);
                    resultEndMessage = reAnchorCompartment.endMessage;
                    resultEndMessageId = reAnchorCompartment.endMessageId;
                    reAnchored = true;
                    logReanchorOnce(
                        sessionId,
                        `compartment injection re-anchored: natural boundary ${trimEndMessageId} not visible for ${degradedCount} passes; splicing at visible compartment boundary ${resultEndMessageId} (ordinal ${resultEndMessage})`,
                    );
                }
            }
            if (!reAnchored) {
                needsFreshMaterialization = true;
                logReanchorOnce(
                    sessionId,
                    `compartment injection degraded: boundary ${trimEndMessageId} not visible for ${degradedCount} passes and no compartment boundary is visible; requesting fresh materialization to re-cut the baseline`,
                );
            }
        } else {
            sessionLog(
                sessionId,
                `compartment injection entering degraded mode: boundary ${trimEndMessageId} not in visible messages (consecutive degraded passes: ${degradedCount})`,
            );
        }
    }

    const result: PreparedCompartmentInjection = {
        block,
        compartmentEndMessage: resultEndMessage,
        compartmentEndMessageId: resultEndMessageId,
        compartmentCount: compartments.length,
        skippedVisibleMessages,
        factCount: facts.length,
        memoryCount,
        rebuiltFromDb: true,
    };
    if (needsFreshMaterialization) {
        result.needsFreshMaterialization = true;
    }
    if (claimLaneStable) {
        injectionCache.set(sessionId, {
            db,
            kind: "populated",
            injection: result,
            claimSnapshotVector,
            renderedRevisionLocators,
        });
    }
    return result;
}

/**
 *
 */
function readCachedBaselineState(
    db: Database,
    sessionId: string,
): { hasCachedM0: boolean; boundary: string | null } {
    const row = db
        .prepare(
            "SELECT cached_m0_bytes AS m0, cached_m0_last_baseline_end_message_id AS boundary FROM session_meta WHERE session_id = ?",
        )
        .get(sessionId) as { m0: unknown; boundary: string | null } | undefined;
    const boundary = row?.boundary;
    return {
        hasCachedM0: row?.m0 != null,
        boundary: boundary && boundary.length > 0 ? boundary : null,
    };
}

export function renderCompartmentInjection(
    sessionId: string,
    messages: MessageLike[],
    prepared: PreparedCompartmentInjection,
): CompartmentInjectionResult {
    const historyBlock = `<session-history>\n${prepared.block}\n</session-history>`;
    const firstMessage = messages[0];
    const textPart = firstMessage ? findFirstTextPart(firstMessage.parts) : null;
    let prependedMessageCount = 0;
    if (!firstMessage || !textPart || isDroppedPlaceholder(textPart.text)) {
        prependedMessageCount = 1;
        messages.unshift({
            info: { role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: historyBlock, synthetic: true }],
        });
    } else {
        textPart.text = `${historyBlock}\n\n${textPart.text}`;
    }

    const memoryLabel = prepared.memoryCount > 0 ? ` + ${prepared.memoryCount} memories` : "";
    if (prepared.compartmentCount > 0) {
        sessionLog(
            sessionId,
            `injected ${prepared.compartmentCount} compartments + ${prepared.factCount} facts${memoryLabel} into message[0]`,
        );
    } else {
        sessionLog(
            sessionId,
            `injected ${prepared.factCount} facts${memoryLabel} into message[0] (no compartments yet)`,
        );
    }

    return {
        injected: true,
        prependedMessageCount,
        compartmentEndMessage: prepared.compartmentEndMessage,
        compartmentCount: prepared.compartmentCount,
        skippedVisibleMessages: prepared.skippedVisibleMessages,
    };
}

function findFirstTextPart(parts: unknown[]): { type: string; text: string } | null {
    for (const part of parts) {
        if (part === null || typeof part !== "object") continue;
        const p = part as Record<string, unknown>;
        if (p.type === "text" && typeof p.text === "string" && !p.ignored) {
            return p as { type: string; text: string };
        }
    }
    return null;
}

function isDroppedPlaceholder(text: string): boolean {
    return /^\[dropped §\d+§\]$/.test(text.trim());
}

export interface M0SnapshotMarkers {
    claimFormatEpoch?: number;
    claimSnapshotVector?: SnapshotVector;
    renderedRevisionLocators?: string[];
    projectUserProfileVersion: number;
    maxCompartmentSeq: number;
    maxMutationId: number;
    projectDocsHash: string;
    materializedAt: number;
    sessionFactsVersion: number;
    upgradeState: string | null;
    compartmentRenderEpoch: string | null;
    systemHash: string;
    modelKey: string;
    projectIdentity?: string | null;
    /* */
    muralHash?: string | null;
    muralEnabled: boolean | null;
    renderBudgetIdentity: string | null;
}

/**
 */
export interface M0HardSignals {
    systemHash: string;
    modelKey: string;
    /* */
    cacheExpired: boolean;
    /* */
    lastResponseTime: number;
}

const EMPTY_HARD_SIGNALS: M0HardSignals = {
    systemHash: "",
    modelKey: "",
    cacheExpired: false,
    lastResponseTime: 0,
};

export interface M0M1State {
    sessionId: string;
    isSubagent?: boolean;
    cachedM0Bytes: Buffer | null;
    cachedM1Bytes: Buffer | null;
    cachedM0ClaimFormatEpoch: number | null;
    cachedM0ClaimSnapshotVector: string | null;
    cachedM0RenderedRevisionLocators: string | null;
    cachedM0ProjectUserProfileVersion: number | null;
    cachedM0MaxCompartmentSeq: number | null;
    cachedM0MaxMutationId: number | null;
    cachedM0ProjectDocsHash: string | null;
    cachedM0MaterializedAt: number | null;
    cachedM0SessionFactsVersion: number | null;
    cachedM0UpgradeState: string | null;
    cachedM0SystemHash: string | null;
    cachedM0ToolSetHash: string | null;
    cachedM0ModelKey: string | null;
    cachedM0ProjectIdentity?: string | null;
    snapshotMarkers?: M0SnapshotMarkers | null;
    /**
     * */
    cachedM0MuralDataUrl?: string | null;
    cachedM0MuralHash?: string | null;
}

export interface M0M1RenderOptions {
    db: Database;
    sessionId: string;
    messages?: MessageLike[];
    state: M0M1State;
    projectPath?: string;
    projectDirectory?: string;
    /* */
    injectDocs?: boolean;
    memoryInjectionBudgetTokens?: number;
    historyBudgetTokens?: number;
    userProfileBudgetTokens?: number;
    temporalAwareness?: boolean;
    /**
     * */
    mural?: { enabled: boolean; supportsVision: boolean; dataUrl?: string; contentHash?: string };
    /**
     * */
    muralEnabled?: boolean;
    isCacheBustingPass?: boolean;
    /**
     */
    compactionOff?: boolean;
    /* */
    hardSignals?: M0HardSignals;
    workspaceIdentitySet?: WorkspaceIdentitySet;
    beforePhase3ForTest?: () => void;
}

export interface MaterializeDecision {
    value: boolean;
    reason: string | null;
}

export interface MaterializeM0Result {
    m0Bytes: Buffer;
    m0Text: string;
    m1Bytes: Buffer;
    m1Text: string;
    snapshotMarkers: M0SnapshotMarkers;
    renderedRevisionLocators: string[];
}

export interface InjectM0M1Result {
    injected: boolean;
    prependedMessageCount: number;
    m0RematerializedThisPass: boolean;
    materializationContentionRetryExhausted: boolean;
    decision: MaterializeDecision;
    m0Bytes: Buffer | null;
    m1Text: string | null;
}

export class MaterializeContentionError extends Error {
    readonly retries: number;
    readonly reason: string;

    constructor(args: { retries?: number; reason?: string } = {}) {
        super(args.reason ?? "m[0] materialization contention");
        this.name = "MaterializeContentionError";
        this.retries = args.retries ?? 0;
        this.reason = args.reason ?? "contention";
    }
}

export class RenderM1InvalidMarkersError extends Error {
    constructor(sessionId: string) {
        super(`Cannot render m[1] for ${sessionId}: missing cached m[0] snapshot markers`);
        this.name = "RenderM1InvalidMarkersError";
    }
}

type M0Compartment = Compartment & {
    startDate?: string | null;
    endDate?: string | null;
};

/**
 */
function lastCompartmentBoundaryId(compartments: readonly M0Compartment[]): string | null {
    const last = compartments.at(-1);
    return last?.endMessageId && last.endMessageId.length > 0 ? last.endMessageId : null;
}

const DEFAULT_HISTORY_BUDGET_TOKENS = 60_000;
export const DEFAULT_MEMORY_BUDGET_TOKENS = 8_000;

function renderBudgetIdentity(memoryBudget?: number, historyBudget?: number): string {
    return `m${memoryBudget ?? DEFAULT_MEMORY_BUDGET_TOKENS}-h${historyBudget ?? DEFAULT_HISTORY_BUDGET_TOKENS}`;
}

export const DEFAULT_USER_PROFILE_BUDGET_TOKENS = 4_000;
const M0_EMPTY_BODY = "<session-history></session-history>";
const M1_EMPTY_PLACEHOLDER =
    "<session-history-since>(no new content since last materialization)</session-history-since>";

type ProjectDocsRender = { renderedBlock: string; canonicalHash: string };
const EMPTY_PROJECT_DOCS: ProjectDocsRender = { renderedBlock: "", canonicalHash: "" };

function readProjectDocsForM0(projectDirectory: string, injectDocs?: boolean): ProjectDocsRender {
    return projectDirectory && injectDocs !== false
        ? readProjectDocsCanonical(projectDirectory)
        : EMPTY_PROJECT_DOCS;
}

export interface WorkspaceRenderContext {
    identities: string[];
    expandedIdentities: string[];
    ownIdentities: string[];
    shareCategories: string[] | null;
    namesByIdentity: Map<string, string>;
    canonicalIdentityByStoredPath: Map<string, string>;
    isWorkspaced: boolean;
}

export interface MemoryRenderOptions {
    sourceNameByMemoryId?: ReadonlyMap<number, string>;
}

export interface ClaimLaneSnapshot extends AuthorizedClaimMemorySnapshot {
    workspaceEpoch: string;
    sourceNameByClaimId: Map<string, string>;
}

function resolveWorkspaceEpoch(db: Database, workspace: WorkspaceRenderContext): string {
    return workspace.identities.length === 0
        ? "project-memory-disabled"
        : computeWorkspaceEpochFingerprint(db, workspace.identities);
}

export function readClaimLaneSnapshot(args: {
    db: Database;
    projectPath?: string;
    workspace: WorkspaceRenderContext;
    nowMs?: number;
}): ClaimLaneSnapshot | null {
    const workspaceEpoch = resolveWorkspaceEpoch(args.db, args.workspace);
    if (!args.projectPath || !hasClaimMemoryFragment(args.db)) {
        return {
            items: [],
            projectIds: [],
            ownProjectIds: [],
            identityByProjectId: new Map(),
            snapshotVector: readProjectMemorySnapshotVector(args.db, [], workspaceEpoch),
            workspaceEpoch,
            sourceNameByClaimId: new Map(),
        };
    }
    const snapshot = readAuthorizedClaimMemorySnapshot(args.db, {
        authorizedIdentities: args.workspace.isWorkspaced
            ? args.workspace.expandedIdentities
            : [args.projectPath],
        ownIdentities: args.workspace.isWorkspaced
            ? args.workspace.ownIdentities
            : [args.projectPath],
        sharedCategories: args.workspace.shareCategories ?? [],
        workspaceEpoch,
        ...(args.workspace.identities.length === 0
            ? {}
            : { workspaceIdentities: args.workspace.identities }),
        ...(args.nowMs === undefined ? {} : { nowMs: args.nowMs }),
    });
    if (snapshot === null) return null;
    const sourceNameByClaimId = new Map<string, string>();
    if (args.workspace.isWorkspaced) {
        for (const item of snapshot.items) {
            const identity = snapshot.identityByProjectId.get(item.projectId);
            if (!identity) continue;
            const source = sourceNameForMemory(
                identity,
                args.projectPath,
                args.workspace.identities,
                args.workspace.namesByIdentity,
                args.workspace.canonicalIdentityByStoredPath,
            );
            if (source) sourceNameByClaimId.set(item.publicClaimId, source);
        }
    }
    return { ...snapshot, workspaceEpoch, sourceNameByClaimId };
}

export function readProjectClaimLaneSnapshot(
    db: Database,
    projectPath: string,
    nowMs?: number,
): ClaimLaneSnapshot | null {
    const workspace = resolveWorkspaceRenderContext({ db, projectPath });
    return readClaimLaneSnapshot({
        db,
        projectPath,
        workspace,
        ...(nowMs === undefined ? {} : { nowMs }),
    });
}

export function trimClaimLane(
    snapshot: ClaimLaneSnapshot,
    budgetTokens: number,
    workspace: WorkspaceRenderContext,
): ProjectMemoryClaimSnapshot[] {
    const renderOptions = { sourceNameByClaimId: snapshot.sourceNameByClaimId };
    return workspace.isWorkspaced
        ? trimWorkspaceClaimSnapshotsToBudget(
              snapshot.items,
              budgetTokens,
              {
                  identities: workspace.identities,
                  identityByProjectId: snapshot.identityByProjectId,
              },
              renderOptions,
          ).renderOrder
        : trimClaimSnapshotsToBudget(snapshot.items, budgetTokens, renderOptions).renderOrder;
}

function resolveWorkspaceRenderContext(args: {
    db: Database;
    projectPath?: string;
    workspaceIdentitySet?: WorkspaceIdentitySet;
}): WorkspaceRenderContext {
    if (!args.projectPath) {
        return {
            identities: [],
            expandedIdentities: [],
            ownIdentities: [],
            shareCategories: null,
            namesByIdentity: new Map(),
            canonicalIdentityByStoredPath: new Map(),
            isWorkspaced: false,
        };
    }
    const identitySet =
        args.workspaceIdentitySet ?? resolveWorkspaceIdentitySet(args.db, args.projectPath);
    const isWorkspaced = identitySet.identities.length > 1;
    const expanded = expandWorkspaceIdentitySetWithAliases(args.db, identitySet.identities);
    const expandedIdentities = isWorkspaced ? expanded.expandedIdentities : identitySet.identities;
    const canonicalIdentityByStoredPath = isWorkspaced
        ? expanded.canonicalIdentityByStoredPath
        : new Map(identitySet.identities.map((identity) => [identity, identity]));
    let ownIdentities = expandedIdentities.filter(
        (identity) => canonicalIdentityByStoredPath.get(identity) === args.projectPath,
    );
    if (ownIdentities.length === 0 && expandedIdentities.includes(args.projectPath)) {
        ownIdentities = [args.projectPath];
    }
    return {
        identities: identitySet.identities,
        expandedIdentities,
        ownIdentities,
        shareCategories: isWorkspaced
            ? resolveWorkspaceShareCategories(args.db, args.projectPath)
            : null,
        namesByIdentity: identitySet.namesByIdentity,
        canonicalIdentityByStoredPath,
        isWorkspaced,
    };
}

function memoryCanonicalIdentity(memory: Memory, workspace: WorkspaceRenderContext): string | null {
    return resolveStoredPathWorkspaceIdentity(
        memory.projectPath,
        workspace.identities,
        workspace.canonicalIdentityByStoredPath,
    );
}

function memorySelectionOrder(left: Memory, right: Memory): number {
    if (left.status === "permanent" && right.status !== "permanent") return -1;
    if (right.status === "permanent" && left.status !== "permanent") return 1;
    const leftImportance = left.importance ?? Number.NEGATIVE_INFINITY;
    const rightImportance = right.importance ?? Number.NEGATIVE_INFINITY;
    const importanceDiff = rightImportance - leftImportance;
    if (importanceDiff !== 0) return importanceDiff;
    return left.id - right.id;
}

function memoryRenderOrder(left: Memory, right: Memory): number {
    const leftPriority = V2_MEMORY_CATEGORIES.indexOf(
        left.category as (typeof V2_MEMORY_CATEGORIES)[number],
    );
    const rightPriority = V2_MEMORY_CATEGORIES.indexOf(
        right.category as (typeof V2_MEMORY_CATEGORIES)[number],
    );
    if (leftPriority >= 0 || rightPriority >= 0) {
        if (leftPriority < 0) return 1;
        if (rightPriority < 0) return -1;
        if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    } else if (left.category !== right.category) {
        return left.category < right.category ? -1 : 1;
    }
    return left.id - right.id;
}

const maxCompartmentSeqStatements = new WeakMap<Database, PreparedStatement>();
const legacyCompartmentCountStatements = new WeakMap<Database, PreparedStatement>();
const m0CompartmentStatements = new WeakMap<Database, PreparedStatement>();
const newCompartmentStatements = new WeakMap<Database, PreparedStatement>();

function cachedStatement(
    cache: WeakMap<Database, PreparedStatement>,
    db: Database,
    sql: string,
): PreparedStatement {
    let stmt = cache.get(db);
    if (!stmt) {
        stmt = db.prepare(sql);
        cache.set(db, stmt);
    }
    return stmt;
}

function numberFromRow(row: unknown, key: string): number {
    if (!row || typeof row !== "object") return 0;
    const value = (row as Record<string, unknown>)[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function getMaxCompartmentSeq(db: Database, sessionId: string): number {
    const row = cachedStatement(
        maxCompartmentSeqStatements,
        db,
        "SELECT COALESCE(MAX(sequence), -1) AS s FROM compartments WHERE session_id = ?",
    ).get(sessionId);
    return numberFromRow(row, "s");
}

function getSessionFactsVersion(_db: Database, _sessionId: string): number {
    return 0;
}

function getUpgradeState(db: Database, sessionId: string): string | null {
    const row = cachedStatement(
        legacyCompartmentCountStatements,
        db,
        "SELECT COUNT(*) AS count FROM compartments WHERE session_id = ? AND legacy = 1",
    ).get(sessionId);
    return numberFromRow(row, "count") > 0 ? "legacy" : "ready";
}

function getGlobalUserProfileVersion(db: Database): number {
    return getProjectState(db, GLOBAL_USER_PROFILE_PROJECT_PATH)?.projectUserProfileVersion ?? 0;
}

interface M0SnapshotMarkerReadArgs {
    db: Database;
    sessionId: string;
    projectPath?: string;
    projectDirectory?: string;
    injectDocs?: boolean;
    muralEnabled?: boolean;
    memoryInjectionBudgetTokens?: number;
    historyBudgetTokens?: number;
    hardSignals?: M0HardSignals;
    workspaceIdentitySet?: WorkspaceIdentitySet;
    nowMs?: number;
}

function readCurrentM0SnapshotMarkersUncached(args: M0SnapshotMarkerReadArgs): {
    markers: M0SnapshotMarkers;
    workspace: WorkspaceRenderContext;
} {
    const projectDirectory = args.projectDirectory ?? args.projectPath ?? "";
    const hard = args.hardSignals ?? EMPTY_HARD_SIGNALS;
    const materializedAt = args.nowMs ?? Date.now();
    const workspace = resolveWorkspaceRenderContext({
        db: args.db,
        projectPath: args.projectPath,
        workspaceIdentitySet: args.workspaceIdentitySet,
    });
    const claimLane = readClaimLaneSnapshot({
        db: args.db,
        projectPath: args.projectPath,
        workspace,
        nowMs: materializedAt,
    });
    const claimSnapshotVector =
        claimLane?.snapshotVector ??
        readProjectMemorySnapshotVector(args.db, [], resolveWorkspaceEpoch(args.db, workspace));
    const renderedRevisionLocators =
        claimLane === null
            ? []
            : trimClaimLane(
                  claimLane,
                  args.memoryInjectionBudgetTokens ?? DEFAULT_MEMORY_BUDGET_TOKENS,
                  workspace,
              ).map((item) => item.revisionLocator);
    return {
        workspace,
        markers: {
            claimFormatEpoch: DIRECT_FORMAT_EPOCH,
            claimSnapshotVector,
            renderedRevisionLocators,
            projectUserProfileVersion: getGlobalUserProfileVersion(args.db),
            maxCompartmentSeq: getMaxCompartmentSeq(args.db, args.sessionId),
            maxMutationId: getMaxM0MutationId(args.db, args.sessionId) ?? 0,
            projectDocsHash:
                projectDirectory && args.injectDocs !== false
                    ? computeProjectDocsHash(projectDirectory)
                    : "",
            materializedAt,
            sessionFactsVersion: getSessionFactsVersion(args.db, args.sessionId),
            upgradeState: getUpgradeState(args.db, args.sessionId),
            compartmentRenderEpoch: COMPARTMENT_RENDER_EPOCH,
            systemHash: hard.systemHash,
            modelKey: piModelRefToCanonical(hard.modelKey),
            projectIdentity: args.projectPath ?? null,
            muralEnabled: args.muralEnabled === true,
            renderBudgetIdentity: renderBudgetIdentity(
                args.memoryInjectionBudgetTokens,
                args.historyBudgetTokens,
            ),
        },
    };
}

export function readCurrentM0SnapshotMarkers(args: M0SnapshotMarkerReadArgs): M0SnapshotMarkers {
    return readCurrentM0SnapshotMarkersUncached(args).markers;
}

function isGenerationRecord(value: unknown): value is Record<string, number> {
    return (
        value !== null &&
        typeof value === "object" &&
        Object.entries(value).every(
            ([key, generation]) => /^\d+$/.test(key) && Number.isSafeInteger(generation),
        )
    );
}

function parseCachedSnapshotVector(raw: string | null): SnapshotVector | null {
    if (raw === null) return null;
    try {
        const value = JSON.parse(raw) as Record<string, unknown>;
        if (
            value.vectorVersion !== 1 ||
            typeof value.databaseIncarnationId !== "string" ||
            typeof value.workspaceEpoch !== "string" ||
            !isGenerationRecord(value.projectGenerations) ||
            !isGenerationRecord(value.policyGenerations)
        ) {
            return null;
        }
        return {
            vectorVersion: 1,
            databaseIncarnationId: value.databaseIncarnationId,
            workspaceEpoch: value.workspaceEpoch,
            projectGenerations: value.projectGenerations,
            policyGenerations: value.policyGenerations,
        };
    } catch {
        return null;
    }
}

function parseCachedRevisionLocators(raw: string | null): string[] | null {
    if (raw === null) return null;
    try {
        const value = JSON.parse(raw) as unknown;
        return Array.isArray(value) && value.every((item) => typeof item === "string")
            ? value
            : null;
    } catch {
        return null;
    }
}

function snapshotMarkersFromCachedM0(state: M0M1State): M0SnapshotMarkers | null {
    if (!state.cachedM0Bytes) return null;
    const cachedUpgradeIdentity = decodeCachedM0UpgradeIdentity(state.cachedM0UpgradeState);
    const claimSnapshotVector = parseCachedSnapshotVector(state.cachedM0ClaimSnapshotVector);
    const renderedRevisionLocators = parseCachedRevisionLocators(
        state.cachedM0RenderedRevisionLocators,
    );
    if (state.cachedM0ClaimFormatEpoch === null) return null;
    if (claimSnapshotVector === null || renderedRevisionLocators === null) return null;
    if (state.cachedM0ProjectUserProfileVersion === null) return null;
    if (state.cachedM0MaxCompartmentSeq === null) return null;
    if (state.cachedM0MaxMutationId === null) return null;
    if (state.cachedM0SessionFactsVersion === null) return null;
    return {
        claimFormatEpoch: state.cachedM0ClaimFormatEpoch,
        claimSnapshotVector,
        renderedRevisionLocators,
        projectUserProfileVersion: state.cachedM0ProjectUserProfileVersion,
        maxCompartmentSeq: state.cachedM0MaxCompartmentSeq,
        maxMutationId: state.cachedM0MaxMutationId,
        projectDocsHash: state.cachedM0ProjectDocsHash ?? "",
        materializedAt: state.cachedM0MaterializedAt ?? 0,
        sessionFactsVersion: state.cachedM0SessionFactsVersion,
        upgradeState: cachedUpgradeIdentity.upgradeState,
        compartmentRenderEpoch: cachedUpgradeIdentity.compartmentRenderEpoch,
        systemHash: state.cachedM0SystemHash ?? "",
        modelKey: state.cachedM0ModelKey ?? "",
        projectIdentity: state.cachedM0ProjectIdentity ?? null,
        muralHash: state.cachedM0MuralHash ?? null,
        muralEnabled: cachedUpgradeIdentity.muralEnabled,
        renderBudgetIdentity: cachedUpgradeIdentity.renderBudgetIdentity,
    };
}

/**
 *
 *
 */
export function mustMaterialize(args: {
    db: Database;
    sessionId: string;
    state: M0M1State;
    projectPath?: string;
    projectDirectory?: string;
    hardSignals?: M0HardSignals;
    workspaceIdentitySet?: WorkspaceIdentitySet;
    injectDocs?: boolean;
    muralEnabled?: boolean;
    memoryInjectionBudgetTokens?: number;
    historyBudgetTokens?: number;
}): MaterializeDecision {
    if (!args.state.cachedM0Bytes) return { value: true, reason: "first_render" };
    if (!args.state.cachedM1Bytes) return { value: true, reason: "cached_m1_missing" };
    const hard = args.hardSignals ?? EMPTY_HARD_SIGNALS;
    const current = readCurrentM0SnapshotMarkers(args);
    const cachedUpgradeIdentity = decodeCachedM0UpgradeIdentity(args.state.cachedM0UpgradeState);

    if (cachedUpgradeIdentity.compartmentRenderEpoch !== current.compartmentRenderEpoch) {
        return { value: true, reason: "compartment_render_epoch" };
    }
    // A change to a recorded component triggers a fold.
    if (
        (cachedUpgradeIdentity.muralEnabled !== null &&
            cachedUpgradeIdentity.muralEnabled !== current.muralEnabled) ||
        (cachedUpgradeIdentity.renderBudgetIdentity !== null &&
            cachedUpgradeIdentity.renderBudgetIdentity !== current.renderBudgetIdentity)
    ) {
        return { value: true, reason: "render_config" };
    }

    // An empty model or system-hash signal does not trigger materialization.
    const canonicalHardModelKey = piModelRefToCanonical(hard.modelKey);
    const canonicalCachedModelKey = piModelRefToCanonical(args.state.cachedM0ModelKey ?? "");
    if (canonicalHardModelKey !== "" && canonicalHardModelKey !== canonicalCachedModelKey) {
        return { value: true, reason: "model_change" };
    }
    if (hard.systemHash !== "" && hard.systemHash !== (args.state.cachedM0SystemHash ?? "")) {
        return { value: true, reason: "system_hash" };
    }
    // Fold after expiry only when hard.lastResponseTime exceeds cachedM0MaterializedAt.
    if (
        hard.cacheExpired &&
        hard.lastResponseTime > 0 &&
        hard.lastResponseTime > (args.state.cachedM0MaterializedAt ?? 0)
    ) {
        return { value: true, reason: "ttl_idle" };
    }

    if (current.projectIdentity !== null) {
        const cachedProjectIdentity = args.state.cachedM0ProjectIdentity ?? null;
        if (cachedProjectIdentity === null) {
            args.state.cachedM0ProjectIdentity = current.projectIdentity;
            args.db
                .prepare(
                    "UPDATE session_meta SET cached_m0_project_identity = ? WHERE session_id = ?",
                )
                .run(current.projectIdentity, args.sessionId);
        } else if (cachedProjectIdentity !== current.projectIdentity) {
            return { value: true, reason: "project_change" };
        }
    }

    if (
        current.claimFormatEpoch !== DIRECT_FORMAT_EPOCH ||
        current.claimSnapshotVector === undefined ||
        current.renderedRevisionLocators === undefined ||
        args.state.cachedM0ClaimFormatEpoch !== current.claimFormatEpoch ||
        args.state.cachedM0ClaimSnapshotVector !==
            canonicalSnapshotVector(current.claimSnapshotVector) ||
        args.state.cachedM0RenderedRevisionLocators !==
            JSON.stringify([...current.renderedRevisionLocators].sort())
    ) {
        return { value: true, reason: "project_memory_change" };
    }
    //
    //
    if (args.state.cachedM0MaxMutationId !== current.maxMutationId) {
        return { value: true, reason: "max_mutation_id" };
    }
    if (cachedUpgradeIdentity.upgradeState !== current.upgradeState) {
        return { value: true, reason: "upgrade_state" };
    }
    return { value: false, reason: null };
}

export interface TrimMemoriesResultV2 {
    selected: Memory[];
    renderOrder: Memory[];
}

export function trimMemoriesToBudgetV2(
    sessionId: string,
    memories: Memory[],
    budgetTokens: number,
    renderOptions: MemoryRenderOptions = {},
): TrimMemoriesResultV2 {
    const selectionOrder = [...memories].sort(memorySelectionOrder);
    const selected: Memory[] = [];
    const accounting = createMemoryBlockAccounting(renderOptions);

    for (const memory of selectionOrder) {
        const cost = accounting.candidateCost(memory);
        if (accounting.usedTokens + cost > budgetTokens) continue;
        accounting.admit(memory, cost);
        selected.push(memory);
    }

    if (selected.length < memories.length) {
        sessionLog(
            sessionId,
            `v2 trimmed memories from ${memories.length} to ${selected.length} to fit injection budget of ${budgetTokens} tokens`,
        );
    }

    const renderOrder = [...selected].sort(memoryRenderOrder);

    return { selected, renderOrder };
}

export function trimWorkspaceMemoriesToBudgetV2(
    sessionId: string,
    memories: Memory[],
    budgetTokens: number,
    workspace: WorkspaceRenderContext,
    renderOptions: MemoryRenderOptions = {},
): TrimMemoriesResultV2 {
    if (!workspace.isWorkspaced) {
        return trimMemoriesToBudgetV2(sessionId, memories, budgetTokens, renderOptions);
    }

    const selected: Memory[] = [];
    const selectedIds = new Set<number>();
    const accounting = createMemoryBlockAccounting(renderOptions);
    const trySelect = (memory: Memory): boolean => {
        if (selectedIds.has(memory.id)) return false;
        const cost = accounting.candidateCost(memory);
        if (accounting.usedTokens + cost > budgetTokens) return false;
        selected.push(memory);
        selectedIds.add(memory.id);
        accounting.admit(memory, cost);
        return true;
    };

    for (const memory of memories
        .filter((candidate) => candidate.status === "permanent")
        .sort(memorySelectionOrder)) {
        trySelect(memory);
    }

    const remainingAfterPermanent = Math.max(0, budgetTokens - accounting.usedTokens);
    const floorTokens = remainingAfterPermanent / Math.max(1, workspace.identities.length);
    const byIdentity = new Map<string, Memory[]>();
    for (const memory of memories) {
        if (memory.status === "permanent") continue;
        const identity = memoryCanonicalIdentity(memory, workspace);
        if (!identity) continue;
        const list = byIdentity.get(identity) ?? [];
        list.push(memory);
        byIdentity.set(identity, list);
    }

    for (const identity of workspace.identities) {
        let memberTokens = 0;
        const candidates = (byIdentity.get(identity) ?? []).sort(memorySelectionOrder);
        for (const memory of candidates) {
            if (selectedIds.has(memory.id)) continue;
            const cost = accounting.candidateCost(memory);
            if (memberTokens + cost > floorTokens) continue;
            if (accounting.usedTokens + cost > budgetTokens) continue;
            selected.push(memory);
            selectedIds.add(memory.id);
            accounting.admit(memory, cost);
            memberTokens += cost;
        }
    }

    const remaining = memories
        .filter((memory) => !selectedIds.has(memory.id))
        .sort(memorySelectionOrder);
    for (const memory of remaining) {
        trySelect(memory);
    }

    if (selected.length < memories.length) {
        sessionLog(
            sessionId,
            `v2 trimmed memories from ${memories.length} to ${selected.length} to fit injection budget of ${budgetTokens} tokens`,
        );
    }

    return { selected, renderOrder: [...selected].sort(memoryRenderOrder) };
}

function safeGetActiveUserMemories(db: Database): UserMemory[] {
    try {
        return getActiveUserMemories(db);
    } catch (error) {
        if (String(error).includes("no such table: user_memories")) return [];
        throw error;
    }
}

export function trimUserMemoriesToBudget(
    memories: UserMemory[],
    budgetTokens: number,
): UserMemory[] {
    const selected: UserMemory[] = [];
    let usedTokens = 0;
    for (const memory of memories) {
        const tokens = estimateTokens(`- ${memory.content}`) + 4;
        if (usedTokens + tokens > budgetTokens) continue;
        selected.push(memory);
        usedTokens += tokens;
    }
    return selected;
}

function readM0Compartments(db: Database, sessionId: string): M0Compartment[] {
    const rows = cachedStatement(
        m0CompartmentStatements,
        db,
        `SELECT id, session_id, sequence, start_message, end_message, start_message_id,
                end_message_id, title, content, p1, p2, p3, p4, episode_type,
                created_at, importance, legacy
           FROM compartments
          WHERE session_id = ?
          ORDER BY sequence ASC`,
    ).all(sessionId) as Array<Record<string, unknown>>;

    return rows.map(rowToM0Compartment);
}

function nullableString(value: unknown): string | null {
    return typeof value === "string" ? value : null;
}

/**
 */
function withCompartmentDates(
    sessionId: string,
    compartments: M0Compartment[],
    temporalAwareness: boolean | undefined,
): M0Compartment[] {
    if (!temporalAwareness || compartments.length === 0) return compartments;

    const messageIds = new Set<string>();
    for (const compartment of compartments) {
        if (compartment.startMessageId) messageIds.add(compartment.startMessageId);
        if (compartment.endMessageId) messageIds.add(compartment.endMessageId);
    }
    const times = getMessageTimesFromOpenCodeDb(sessionId, Array.from(messageIds));
    return compartments.map((compartment) => {
        const startMs = times.get(compartment.startMessageId);
        const endMs = times.get(compartment.endMessageId);
        if (startMs === undefined || endMs === undefined) return compartment;
        return {
            ...compartment,
            startDate: formatDate(startMs),
            endDate: formatDate(endMs),
        };
    });
}

function rowToM0Compartment(row: Record<string, unknown>): M0Compartment {
    return {
        id: Number(row.id ?? 0),
        sessionId: String(row.session_id ?? ""),
        sequence: Number(row.sequence ?? 0),
        startMessage: Number(row.start_message ?? 0),
        endMessage: Number(row.end_message ?? 0),
        startMessageId: String(row.start_message_id ?? ""),
        endMessageId: String(row.end_message_id ?? ""),
        title: String(row.title ?? ""),
        content: String(row.content ?? ""),
        p1: nullableString(row.p1),
        p2: nullableString(row.p2),
        p3: nullableString(row.p3),
        p4: nullableString(row.p4),
        importance: Number(row.importance ?? 50),
        episodeType: nullableString(row.episode_type),
        legacy: Number(row.legacy ?? 0),
        createdAt: Number(row.created_at ?? 0),
    };
}

function readNewCompartments(
    db: Database,
    sessionId: string,
    afterSequence: number,
): M0Compartment[] {
    const rows = cachedStatement(
        newCompartmentStatements,
        db,
        `SELECT id, session_id, sequence, start_message, end_message, start_message_id,
                end_message_id, title, content, p1, p2, p3, p4, episode_type,
                created_at, importance, legacy
           FROM compartments
          WHERE session_id = ? AND sequence > ?
          ORDER BY sequence ASC`,
    ).all(sessionId, afterSequence) as Array<Record<string, unknown>>;
    return rows.map(rowToM0Compartment);
}

/**
 * over it.
 */
function createMemoryBlockAccounting(renderOptions: MemoryRenderOptions) {
    const seenCategories = new Set<string>();
    const categoryCost = new Map<string, number>();
    return {
        usedTokens: estimateTokens("<project-memory>\n</project-memory>"),
        candidateCost(memory: Memory): number {
            const line = renderMemoryLineV2(
                memory,
                renderOptions.sourceNameByMemoryId?.get(memory.id),
            );
            let cost = estimateTokens(`${line}\n`);
            if (!seenCategories.has(memory.category)) {
                let tags = categoryCost.get(memory.category);
                if (tags === undefined) {
                    tags = estimateTokens(
                        `<${escapeXmlAttr(memory.category)}>\n</${escapeXmlAttr(memory.category)}>\n`,
                    );
                    categoryCost.set(memory.category, tags);
                }
                cost += tags;
            }
            return cost;
        },
        admit(memory: Memory, cost: number): void {
            this.usedTokens += cost;
            seenCategories.add(memory.category);
        },
    };
}

/**
 * */
export function renderMemoryLineV2(memory: Memory, sourceName?: string): string {
    const source = sourceName ? ` [${escapeXmlContent(sourceName)}]` : "";
    return `#${memory.id}${source}: ${escapeXmlContent(memory.content)}`;
}

export function renderMemoryBlockV2(
    memories: Memory[],
    wrapper = "project-memory",
    renderOptions: MemoryRenderOptions = {},
): string {
    if (memories.length === 0) return "";
    const ordered = [...memories].sort(memoryRenderOrder);
    const lines = [`<${wrapper}>`];
    let openCategory: string | undefined;
    for (const memory of ordered) {
        if (memory.category !== openCategory) {
            if (openCategory !== undefined) lines.push(`</${escapeXmlAttr(openCategory)}>`);
            openCategory = memory.category;
            lines.push(`<${escapeXmlAttr(openCategory)}>`);
        }
        lines.push(renderMemoryLineV2(memory, renderOptions.sourceNameByMemoryId?.get(memory.id)));
    }
    if (openCategory !== undefined) lines.push(`</${escapeXmlAttr(openCategory)}>`);
    lines.push(`</${wrapper}>`);
    return lines.join("\n");
}

function renderUserProfileBlock(memories: UserMemory[], wrapper = "user-profile"): string {
    if (memories.length === 0) return "";
    const lines = [`<${wrapper}>`];
    for (const memory of memories) {
        lines.push(`- ${escapeXmlContent(memory.content)}`);
    }
    lines.push(`</${wrapper}>`);
    return lines.join("\n");
}

/**
 *
 */
function renderSessionHistoryWithDecay(args: {
    compartments: M0Compartment[];
    historyBudgetTokens: number;
}): string {
    return renderDecayedCompartments({
        compartments: args.compartments,
        historyBudgetTokens: args.historyBudgetTokens,
    });
}

const MEMORY_MURAL_BLOCK =
    "<memory-mural>\nThe project memory mural image follows.\n</memory-mural>";

/** Remove a stale mural reference when a legacy cached baseline has no paired image payload. */
export function stripMemoryMuralBlock(m0Text: string): string {
    return m0Text
        .split("\n\n")
        .filter((section) => section !== MEMORY_MURAL_BLOCK)
        .join("\n\n")
        .trim();
}

export function stripProjectMemoryBlock(m0Text: string): string {
    const block = extractM0Block(m0Text, "project-memory");
    return block
        ? m0Text
              .replace(block, "")
              .replace(/\n{3,}/g, "\n\n")
              .trim()
        : m0Text;
}

export function renderM0(args: {
    projectDocs: string;
    userProfileBaseline: UserMemory[];
    compartments: M0Compartment[];
    memories: Memory[];
    claimMemories?: ProjectMemoryClaimSnapshot[];
    facts: SessionFact[];
    mural?: { enabled: boolean; supportsVision: boolean; dataUrl?: string };
    memoryRenderOptions?: MemoryRenderOptions;
    claimSourceNameById?: ReadonlyMap<string, string>;
    historyBudgetTokens?: number;
    userProfileBudgetTokens?: number;
    decayPressureMultiplier?: number;
}): string {
    const sections: string[] = [];
    if (args.projectDocs.length > 0) sections.push(args.projectDocs);
    const userProfile = renderUserProfileBlock(
        trimUserMemoriesToBudget(
            args.userProfileBaseline,
            args.userProfileBudgetTokens ?? DEFAULT_USER_PROFILE_BUDGET_TOKENS,
        ),
    );
    if (userProfile) sections.push(userProfile);

    const baseBudget = args.historyBudgetTokens ?? DEFAULT_HISTORY_BUDGET_TOKENS;
    const effectiveBudget = baseBudget / Math.max(1, args.decayPressureMultiplier ?? 1);
    const sessionHistory = renderSessionHistoryWithDecay({
        compartments: args.compartments,
        historyBudgetTokens: effectiveBudget,
    });
    sections.push(
        sessionHistory.length > 0
            ? `<session-history>\n${sessionHistory}\n</session-history>`
            : M0_EMPTY_BODY,
    );

    const memoriesBlock = args.claimMemories
        ? renderClaimMemoryBlock(args.claimMemories, "project-memory", {
              sourceNameByClaimId: args.claimSourceNameById,
          })
        : renderMemoryBlockV2(args.memories, "project-memory", args.memoryRenderOptions);
    if (memoriesBlock) sections.push(memoriesBlock);
    if (args.mural?.enabled && args.mural.supportsVision && args.mural.dataUrl) {
        sections.push(MEMORY_MURAL_BLOCK);
    }
    return sections.join("\n\n").trim();
}

function applyMarkersToState(
    state: M0M1State,
    m0Bytes: Buffer,
    markers: M0SnapshotMarkers,
    m1Bytes?: Buffer,
): void {
    state.cachedM0Bytes = m0Bytes;
    if (m1Bytes) state.cachedM1Bytes = m1Bytes;
    state.cachedM0ClaimFormatEpoch = markers.claimFormatEpoch ?? null;
    state.cachedM0ClaimSnapshotVector = markers.claimSnapshotVector
        ? canonicalSnapshotVector(markers.claimSnapshotVector)
        : null;
    state.cachedM0RenderedRevisionLocators = markers.renderedRevisionLocators
        ? JSON.stringify([...markers.renderedRevisionLocators].sort())
        : null;
    state.cachedM0ProjectUserProfileVersion = markers.projectUserProfileVersion;
    state.cachedM0MaxCompartmentSeq = markers.maxCompartmentSeq;
    state.cachedM0MaxMutationId = markers.maxMutationId;
    state.cachedM0ProjectDocsHash = markers.projectDocsHash;
    state.cachedM0MaterializedAt = markers.materializedAt;
    state.cachedM0SessionFactsVersion = markers.sessionFactsVersion;
    state.cachedM0UpgradeState = encodeCachedM0UpgradeIdentity(
        markers.upgradeState,
        markers.compartmentRenderEpoch,
        markers.muralEnabled,
        markers.renderBudgetIdentity,
    );
    // Mirror HARD-bust markers into the corresponding flat state fields because mustMaterialize reads cachedM0SystemHash and cachedM0ModelKey directly.
    state.cachedM0SystemHash = markers.systemHash;
    state.cachedM0ModelKey = markers.modelKey;
    state.cachedM0ProjectIdentity = markers.projectIdentity;
    state.cachedM0MuralHash = markers.muralHash ?? null;
    state.snapshotMarkers = markers;
}

/**
 * Returns the real-tokenizer size of only the rendered m[0] <session-history> slice.
 *
 * The over-budget tightening loop compares only session-history tokens against the history budget.
 * Charging fixed blocks against the history budget falsely inflates measured cost.
 * Charging fixed blocks against the history budget reduces the budget available to session history.
 */
function historySliceTokens(m0Text: string): number {
    const slice = extractM0Block(m0Text, "session-history");
    return slice ? estimateTokens(slice) : 0;
}

/**
 * Use no mural image unless the mural feature is enabled and the fold's model accepts images.
 * The renderer generates a PNG only when the mural changes.
 */
function resolveMuralForM0(
    options: M0M1RenderOptions,
    projectPath: string | undefined,
    modelKey: string,
    budgetTokens: number,
): MuralWireOptions | undefined {
    if (!options.muralEnabled) return undefined;
    return resolveMuralWire(options.db, projectPath, modelKey, true, budgetTokens);
}

export function materializeM0(options: M0M1RenderOptions): MaterializeM0Result {
    const projectPath = options.projectPath;
    const projectDirectory = options.projectDirectory ?? projectPath ?? "";
    const workspace = resolveWorkspaceRenderContext({
        db: options.db,
        projectPath,
        workspaceIdentitySet: options.workspaceIdentitySet,
    });
    const foldMaterializedAt = Date.now();
    const claimLane = readClaimLaneSnapshot({
        db: options.db,
        projectPath,
        workspace,
        nowMs: foldMaterializedAt,
    });
    if (claimLane === null) {
        throw new MaterializeContentionError({ reason: "claim snapshot kept moving" });
    }
    const memoryBudget = options.memoryInjectionBudgetTokens ?? DEFAULT_MEMORY_BUDGET_TOKENS;
    const renderedClaims = trimClaimLane(claimLane, memoryBudget, workspace);
    const snapshotMarkers = readCurrentM0SnapshotMarkers({
        db: options.db,
        sessionId: options.sessionId,
        projectPath,
        projectDirectory,
        injectDocs: options.injectDocs,
        muralEnabled: options.muralEnabled,
        memoryInjectionBudgetTokens: options.memoryInjectionBudgetTokens,
        historyBudgetTokens: options.historyBudgetTokens,
        hardSignals: options.hardSignals,
        workspaceIdentitySet: {
            identities: workspace.identities,
            namesByIdentity: workspace.namesByIdentity,
        },
        nowMs: foldMaterializedAt,
    });
    if (
        snapshotMarkers.claimSnapshotVector === undefined ||
        snapshotMarkers.renderedRevisionLocators === undefined ||
        canonicalSnapshotVector(snapshotMarkers.claimSnapshotVector) !==
            canonicalSnapshotVector(claimLane.snapshotVector) ||
        JSON.stringify([...snapshotMarkers.renderedRevisionLocators].sort()) !==
            JSON.stringify(renderedClaims.map((item) => item.revisionLocator).sort())
    ) {
        throw new MaterializeContentionError({ reason: "claim snapshot changed before render" });
    }
    const docs = readProjectDocsForM0(projectDirectory, options.injectDocs);
    snapshotMarkers.projectDocsHash = docs.canonicalHash;
    let compartments = options.compactionOff
        ? []
        : readM0Compartments(options.db, options.sessionId);
    const facts: SessionFact[] = [];
    const userMemories = safeGetActiveUserMemories(options.db);
    compartments = withCompartmentDates(options.sessionId, compartments, options.temporalAwareness);
    const mural =
        options.mural ??
        resolveMuralForM0(options, projectPath, snapshotMarkers.modelKey, memoryBudget);
    let decayPressureMultiplier = 1;
    let m0Text = renderM0({
        projectDocs: docs.renderedBlock,
        userProfileBaseline: userMemories,
        compartments,
        memories: [],
        claimMemories: renderedClaims,
        facts,
        claimSourceNameById: claimLane.sourceNameByClaimId,
        historyBudgetTokens: options.historyBudgetTokens ?? DEFAULT_HISTORY_BUDGET_TOKENS,
        userProfileBudgetTokens: options.userProfileBudgetTokens,
        decayPressureMultiplier,
        mural,
    });

    let attempts = 0;
    const budget = options.historyBudgetTokens ?? DEFAULT_HISTORY_BUDGET_TOKENS;
    while (budget > 0 && historySliceTokens(m0Text) > budget * 1.05 && attempts < 3) {
        decayPressureMultiplier *= 1.15;
        m0Text = renderM0({
            projectDocs: docs.renderedBlock,
            userProfileBaseline: userMemories,
            compartments,
            memories: [],
            claimMemories: renderedClaims,
            facts,
            claimSourceNameById: claimLane.sourceNameByClaimId,
            historyBudgetTokens: budget,
            userProfileBudgetTokens: options.userProfileBudgetTokens,
            decayPressureMultiplier,
            mural,
        });
        attempts += 1;
    }

    if (m0Text.length === 0) m0Text = M0_EMPTY_BODY;
    const m0Bytes = Buffer.from(m0Text, "utf8");
    const frozenMuralDataUrl =
        mural?.enabled && mural.supportsVision ? (mural.dataUrl ?? null) : null;
    const frozenMuralHash =
        mural?.enabled && mural.supportsVision ? (mural.contentHash ?? null) : null;
    snapshotMarkers.muralHash = frozenMuralHash;
    snapshotMarkers.materializedAt = foldMaterializedAt;
    const renderedRevisionLocators = renderedClaims.map((item) => item.revisionLocator);
    const phase3ProjectDocsHash = readProjectDocsForM0(
        projectDirectory,
        options.injectDocs,
    ).canonicalHash;

    options.beforePhase3ForTest?.();

    let m1Text = M1_EMPTY_PLACEHOLDER;
    let m1Bytes = Buffer.from(m1Text, "utf8");
    options.db.exec("BEGIN IMMEDIATE");
    try {
        const currentWorkspace = resolveWorkspaceRenderContext({
            db: options.db,
            projectPath,
            workspaceIdentitySet: options.workspaceIdentitySet,
        });
        const freshVector = readProjectMemorySnapshotVector(
            options.db,
            claimLane.projectIds,
            resolveWorkspaceEpoch(options.db, currentWorkspace),
        );
        const stale =
            snapshotVectorChanges(claimLane.snapshotVector, freshVector).length > 0 ||
            getGlobalUserProfileVersion(options.db) !== snapshotMarkers.projectUserProfileVersion ||
            getMaxCompartmentSeq(options.db, options.sessionId) !==
                snapshotMarkers.maxCompartmentSeq ||
            (getMaxM0MutationId(options.db, options.sessionId) ?? 0) !==
                snapshotMarkers.maxMutationId ||
            getSessionFactsVersion(options.db, options.sessionId) !==
                snapshotMarkers.sessionFactsVersion ||
            getUpgradeState(options.db, options.sessionId) !== snapshotMarkers.upgradeState ||
            phase3ProjectDocsHash !== snapshotMarkers.projectDocsHash ||
            (projectPath ?? null) !== (snapshotMarkers.projectIdentity ?? null);
        if (stale) {
            options.db.exec("ROLLBACK");
            throw new MaterializeContentionError({ reason: "snapshot changed before Phase 3" });
        }

        const m1Render = renderM1WithMetadata(
            {
                ...options,
                workspaceIdentitySet: {
                    identities: workspace.identities,
                    namesByIdentity: workspace.namesByIdentity,
                },
            },
            snapshotMarkers,
            [],
        );
        m1Text = m1Render.text;
        m1Bytes = Buffer.from(m1Text, "utf8");

        persistCachedM0(options.db, options.sessionId, {
            m0Bytes,
            muralDataUrl: frozenMuralDataUrl,
            muralHash: frozenMuralHash,
            claimFormatEpoch: DIRECT_FORMAT_EPOCH,
            claimSnapshotVector: canonicalSnapshotVector(claimLane.snapshotVector),
            renderedRevisionLocators: JSON.stringify([...renderedRevisionLocators].sort()),
            projectUserProfileVersion: snapshotMarkers.projectUserProfileVersion,
            maxCompartmentSeq: snapshotMarkers.maxCompartmentSeq,
            maxMutationId: snapshotMarkers.maxMutationId,
            m1Bytes,
            projectDocsHash: snapshotMarkers.projectDocsHash,
            materializedAt: snapshotMarkers.materializedAt,
            sessionFactsVersion: snapshotMarkers.sessionFactsVersion,
            upgradeState: encodeCachedM0UpgradeIdentity(
                snapshotMarkers.upgradeState,
                snapshotMarkers.compartmentRenderEpoch,
                snapshotMarkers.muralEnabled,
                snapshotMarkers.renderBudgetIdentity,
            ),
            systemHash: snapshotMarkers.systemHash,
            modelKey: snapshotMarkers.modelKey,
            projectIdentity: snapshotMarkers.projectIdentity,
        });

        options.db
            .prepare(
                "UPDATE session_meta SET memory_block_count = ?, memory_block_ids = ?, memory_block_hashes = ? WHERE session_id = ?",
            )
            .run(
                renderedRevisionLocators.length,
                JSON.stringify([...renderedRevisionLocators].sort()),
                JSON.stringify(renderedClaims.map((item) => item.contentDigest)),
                options.sessionId,
            );

        const baselineEndMessageId = lastCompartmentBoundaryId(compartments);
        options.db
            .prepare(
                "UPDATE session_meta SET cached_m0_last_baseline_end_message_id = ? WHERE session_id = ?",
            )
            .run(baselineEndMessageId, options.sessionId);

        options.db.exec("COMMIT");
        options.state.cachedM0MuralDataUrl = frozenMuralDataUrl;
        options.state.cachedM0MuralHash = frozenMuralHash;
    } catch (error) {
        try {
            options.db.exec("ROLLBACK");
        } catch {
        }
        throw error;
    }

    return { m0Bytes, m0Text, m1Bytes, m1Text, snapshotMarkers, renderedRevisionLocators };
}

export function materializeWithRetry(
    options: M0M1RenderOptions,
    maxRetries = 3,
): MaterializeM0Result {
    let lastError: MaterializeContentionError | null = null;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return materializeM0(options);
        } catch (error) {
            if (!(error instanceof MaterializeContentionError)) throw error;
            lastError = error;
        }
    }
    throw new MaterializeContentionError({
        retries: maxRetries,
        reason: lastError?.reason ?? "m[0] materialization contention exhausted",
    });
}

interface RenderM1Result {
    text: string;
    memoryUpdateCount: number;
    renderedRevisionLocators: string[];
}

function renderM1WithMetadata(
    options: M0M1RenderOptions,
    markers: M0SnapshotMarkers,
    _renderedRevisionLocators: readonly string[],
): RenderM1Result {
    if (!markers || markers.maxCompartmentSeq === undefined) {
        throw new RenderM1InvalidMarkersError(options.sessionId);
    }
    if (markers.claimSnapshotVector === undefined) {
        throw new RenderM1InvalidMarkersError(options.sessionId);
    }
    const projectIds = Object.keys(markers.claimSnapshotVector.projectGenerations).map(Number);
    const freshVector = readProjectMemorySnapshotVector(
        options.db,
        projectIds,
        markers.claimSnapshotVector.workspaceEpoch,
    );
    if (snapshotVectorChanges(markers.claimSnapshotVector, freshVector).length > 0) {
        throw new MaterializeContentionError({ reason: "claim snapshot changed before m1 render" });
    }

    const blocks: string[] = [];
    const newCompartments = withCompartmentDates(
        options.sessionId,
        readNewCompartments(options.db, options.sessionId, markers.maxCompartmentSeq),
        options.temporalAwareness,
    );
    if (newCompartments.length > 0) {
        blocks.push(
            `<new-compartments>\n${newCompartments
                .map((compartment) => renderCompartmentAtTier(compartment, 1))
                .join("\n\n")}\n</new-compartments>`,
        );
    }

    const currentUserProfileVersion = getGlobalUserProfileVersion(options.db);
    if (currentUserProfileVersion !== markers.projectUserProfileVersion) {
        const profileBlock = renderUserProfileBlock(
            trimUserMemoriesToBudget(
                safeGetActiveUserMemories(options.db),
                Math.max(
                    1,
                    Math.floor(
                        (options.userProfileBudgetTokens ?? DEFAULT_USER_PROFILE_BUDGET_TOKENS) *
                            0.25,
                    ),
                ),
            ),
            "new-user-profile",
        );
        if (profileBlock) blocks.push(profileBlock);
    }

    if (blocks.length === 0) {
        return {
            text: M1_EMPTY_PLACEHOLDER,
            memoryUpdateCount: 0,
            renderedRevisionLocators: [],
        };
    }
    return {
        text: `<session-history-since>\n${blocks.join("\n")}\n</session-history-since>`,
        memoryUpdateCount: 0,
        renderedRevisionLocators: [],
    };
}

export function renderM1(
    options: M0M1RenderOptions,
    markers: M0SnapshotMarkers,
    renderedRevisionLocators: readonly string[] = [],
): string {
    return renderM1WithMetadata(options, markers, renderedRevisionLocators).text;
}

function decodeM0Bytes(bytes: Buffer | Uint8Array | null): string | null {
    if (!bytes) return null;
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");
}

interface CachedM0M1Row {
    cached_m0_bytes: Buffer | Uint8Array | null;
    cached_m0_mural_data_url: string | null;
    cached_m0_mural_hash: string | null;
    cached_m1_bytes: Buffer | Uint8Array | null;
    cached_m0_claim_format_epoch: number | null;
    cached_m0_claim_snapshot_vector: string | null;
    cached_m0_rendered_revision_locators: string | null;
    cached_m0_project_user_profile_version: number | null;
    cached_m0_max_compartment_seq: number | null;
    cached_m0_max_mutation_id: number | null;
    cached_m0_project_docs_hash: string | null;
    cached_m0_materialized_at: number | null;
    cached_m0_session_facts_version: number | null;
    cached_m0_upgrade_state: string | null;
    cached_m0_system_hash: string | null;
    cached_m0_model_key: string | null;
    cached_m0_project_identity: string | null;
}

function toBuffer(value: Buffer | Uint8Array): Buffer {
    return Buffer.isBuffer(value)
        ? value
        : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function bufferEqualsNullable(
    left: Buffer | Uint8Array | null,
    right: Buffer | Uint8Array | null,
): boolean {
    if (left === null || right === null) return left === right;
    return toBuffer(left).equals(toBuffer(right));
}

function readCachedM0M1Row(db: Database, sessionId: string): CachedM0M1Row | null {
    return db
        .prepare(
            `SELECT cached_m0_bytes, cached_m0_mural_data_url,
                    cached_m0_mural_hash, cached_m1_bytes,
                    cached_m0_claim_format_epoch,
                    cached_m0_claim_snapshot_vector,
                    cached_m0_rendered_revision_locators,
                    cached_m0_project_user_profile_version,
                    cached_m0_max_compartment_seq,
                    cached_m0_max_mutation_id,
                    cached_m0_project_docs_hash,
                    cached_m0_materialized_at,
                    cached_m0_session_facts_version,
                    cached_m0_upgrade_state,
                    cached_m0_system_hash,
                    cached_m0_model_key,
                    cached_m0_project_identity
               FROM session_meta
              WHERE session_id = ?`,
        )
        .get(sessionId) as CachedM0M1Row | null;
}

function markersFromCachedRow(row: CachedM0M1Row): M0SnapshotMarkers | null {
    if (!row.cached_m0_bytes) return null;
    const cachedUpgradeIdentity = decodeCachedM0UpgradeIdentity(row.cached_m0_upgrade_state);
    const claimSnapshotVector = parseCachedSnapshotVector(row.cached_m0_claim_snapshot_vector);
    const renderedRevisionLocators = parseCachedRevisionLocators(
        row.cached_m0_rendered_revision_locators,
    );
    if (row.cached_m0_claim_format_epoch === null) return null;
    if (claimSnapshotVector === null || renderedRevisionLocators === null) return null;
    if (row.cached_m0_project_user_profile_version === null) return null;
    if (row.cached_m0_max_compartment_seq === null) return null;
    if (row.cached_m0_max_mutation_id === null) return null;
    if (row.cached_m0_session_facts_version === null) return null;
    return {
        claimFormatEpoch: row.cached_m0_claim_format_epoch,
        claimSnapshotVector,
        renderedRevisionLocators,
        projectUserProfileVersion: row.cached_m0_project_user_profile_version,
        maxCompartmentSeq: row.cached_m0_max_compartment_seq,
        maxMutationId: row.cached_m0_max_mutation_id,
        projectDocsHash: row.cached_m0_project_docs_hash ?? "",
        materializedAt: row.cached_m0_materialized_at ?? 0,
        sessionFactsVersion: row.cached_m0_session_facts_version,
        upgradeState: cachedUpgradeIdentity.upgradeState,
        compartmentRenderEpoch: cachedUpgradeIdentity.compartmentRenderEpoch,
        systemHash: row.cached_m0_system_hash ?? "",
        modelKey: row.cached_m0_model_key ?? "",
        projectIdentity: row.cached_m0_project_identity ?? null,
        muralHash: row.cached_m0_mural_hash ?? null,
        muralEnabled: cachedUpgradeIdentity.muralEnabled,
        renderBudgetIdentity: cachedUpgradeIdentity.renderBudgetIdentity,
    };
}

function cachedRowMatchesState(row: CachedM0M1Row, state: M0M1State): boolean {
    return (
        bufferEqualsNullable(row.cached_m0_bytes, state.cachedM0Bytes) &&
        (row.cached_m0_mural_data_url ?? null) === (state.cachedM0MuralDataUrl ?? null) &&
        (row.cached_m0_mural_hash ?? null) === (state.cachedM0MuralHash ?? null) &&
        row.cached_m0_claim_format_epoch === state.cachedM0ClaimFormatEpoch &&
        row.cached_m0_claim_snapshot_vector === state.cachedM0ClaimSnapshotVector &&
        row.cached_m0_rendered_revision_locators === state.cachedM0RenderedRevisionLocators &&
        row.cached_m0_project_user_profile_version === state.cachedM0ProjectUserProfileVersion &&
        row.cached_m0_max_compartment_seq === state.cachedM0MaxCompartmentSeq &&
        row.cached_m0_max_mutation_id === state.cachedM0MaxMutationId &&
        row.cached_m0_materialized_at === state.cachedM0MaterializedAt &&
        row.cached_m0_session_facts_version === state.cachedM0SessionFactsVersion &&
        (row.cached_m0_upgrade_state ?? null) === (state.cachedM0UpgradeState ?? null) &&
        (row.cached_m0_system_hash ?? "") === (state.cachedM0SystemHash ?? "") &&
        piModelRefToCanonical(row.cached_m0_model_key ?? "") ===
            piModelRefToCanonical(state.cachedM0ModelKey ?? "") &&
        (row.cached_m0_project_identity ?? null) === (state.cachedM0ProjectIdentity ?? null)
    );
}

function applyCachedRowToState(state: M0M1State, row: CachedM0M1Row): void {
    const markers = markersFromCachedRow(row);
    if (!row.cached_m0_bytes || !row.cached_m1_bytes || !markers) {
        throw new RenderM1InvalidMarkersError(state.sessionId);
    }
    state.cachedM0Bytes = toBuffer(row.cached_m0_bytes);
    state.cachedM0MuralDataUrl = row.cached_m0_mural_data_url ?? null;
    state.cachedM0MuralHash = row.cached_m0_mural_hash ?? null;
    state.cachedM1Bytes = toBuffer(row.cached_m1_bytes);
    state.cachedM0ClaimFormatEpoch = markers.claimFormatEpoch ?? null;
    state.cachedM0ClaimSnapshotVector = markers.claimSnapshotVector
        ? canonicalSnapshotVector(markers.claimSnapshotVector)
        : null;
    state.cachedM0RenderedRevisionLocators = markers.renderedRevisionLocators
        ? JSON.stringify([...markers.renderedRevisionLocators].sort())
        : null;
    state.cachedM0ProjectUserProfileVersion = markers.projectUserProfileVersion;
    state.cachedM0MaxCompartmentSeq = markers.maxCompartmentSeq;
    state.cachedM0MaxMutationId = markers.maxMutationId;
    state.cachedM0ProjectDocsHash = markers.projectDocsHash;
    state.cachedM0MaterializedAt = markers.materializedAt;
    state.cachedM0SessionFactsVersion = markers.sessionFactsVersion;
    state.cachedM0UpgradeState = encodeCachedM0UpgradeIdentity(
        markers.upgradeState,
        markers.compartmentRenderEpoch,
        markers.muralEnabled,
        markers.renderBudgetIdentity,
    );
    state.cachedM0SystemHash = markers.systemHash;
    state.cachedM0ModelKey = markers.modelKey;
    state.cachedM0ProjectIdentity = markers.projectIdentity;
    state.snapshotMarkers = markers;
}

function replayCachedM1(state: M0M1State): string {
    if (!state.cachedM1Bytes) {
        throw new RenderM1InvalidMarkersError(state.sessionId);
    }
    return decodeM0Bytes(state.cachedM1Bytes) ?? M1_EMPTY_PLACEHOLDER;
}

function softRefreshCachedM1(options: M0M1RenderOptions): RenderM1Result {
    options.db.exec("BEGIN IMMEDIATE");
    try {
        const row = readCachedM0M1Row(options.db, options.sessionId);
        if (!row || !cachedRowMatchesState(row, options.state)) {
            options.db.exec("ROLLBACK");
            const sibling = readCachedM0M1Row(options.db, options.sessionId);
            if (!sibling) throw new RenderM1InvalidMarkersError(options.sessionId);
            applyCachedRowToState(options.state, sibling);
            return {
                text: replayCachedM1(options.state),
                memoryUpdateCount: 0,
                renderedRevisionLocators: [],
            };
        }

        const markers = markersFromCachedRow(row);
        if (!markers) throw new RenderM1InvalidMarkersError(options.sessionId);
        const renderedM0Locators = markers.renderedRevisionLocators ?? [];
        const rendered = renderM1WithMetadata({ ...options }, markers, renderedM0Locators);
        const m1Bytes = Buffer.from(rendered.text, "utf8");
        const baselineEndMessageId = getLastCompartmentEndMessageId(options.db, options.sessionId);
        options.db
            .prepare(
                `UPDATE session_meta
                    SET cached_m1_bytes = ?,
                        cached_m0_last_baseline_end_message_id = ?,
                        memory_block_count = ?,
                        memory_block_ids = ?,
                        memory_block_hashes = ?
                  WHERE session_id = ?`,
            )
            .run(
                m1Bytes,
                baselineEndMessageId,
                renderedM0Locators.length,
                JSON.stringify([...renderedM0Locators].sort()),
                JSON.stringify([]),
                options.sessionId,
            );
        options.db.exec("COMMIT");
        options.state.cachedM1Bytes = m1Bytes;
        options.state.snapshotMarkers = markers;
        return rendered;
    } catch (error) {
        try {
            options.db.exec("ROLLBACK");
        } catch {
        }
        throw error;
    }
}

function prependM0M1Messages(
    sessionId: string,
    messages: MessageLike[],
    m0Text: string,
    m1Text: string,
    mural?: { enabled: boolean; supportsVision: boolean; dataUrl?: string },
): number {
    // Without the part-level `synthetic` flag, m[0] and m[1] permanently suppress the session's auto-title.
    const muralImage =
        mural?.enabled && mural.supportsVision && mural.dataUrl
            ? { type: "file", mime: "image/png", url: mural.dataUrl, synthetic: true }
            : null;
    messages.unshift(
        {
            info: { role: "user", sessionID: sessionId, syntheticHead: true },
            parts: [
                {
                    type: "text",
                    text: m0Text.length > 0 ? m0Text : M0_EMPTY_BODY,
                    synthetic: true,
                },
                ...(muralImage ? [muralImage] : []),
            ],
        },
        {
            info: { role: "user", sessionID: sessionId, syntheticHead: true },
            parts: [{ type: "text", text: m1Text, synthetic: true }],
        },
    );
    return 2;
}

/**
 * renderFreshM0NonPersisted renders fresh m[0] from DB state without persisting it or taking the materialize lock.
 * The fallback renders unpersisted history when contention exhausts after a history refresh clears the cache.
 * renderFreshM0NonPersisted uses a plain read because it does not persist m[0].
 */
function renderFreshM0NonPersisted(options: M0M1RenderOptions): {
    m0Bytes: Buffer;
    snapshotMarkers: M0SnapshotMarkers;
    renderedRevisionLocators: string[];
} {
    const projectPath = options.projectPath;
    const projectDirectory = options.projectDirectory;
    const workspace = resolveWorkspaceRenderContext({
        db: options.db,
        projectPath,
        workspaceIdentitySet: options.workspaceIdentitySet,
    });
    const snapshotMarkers = readCurrentM0SnapshotMarkers({
        db: options.db,
        sessionId: options.sessionId,
        projectPath,
        projectDirectory,
        injectDocs: options.injectDocs,
        muralEnabled: options.muralEnabled,
        memoryInjectionBudgetTokens: options.memoryInjectionBudgetTokens,
        historyBudgetTokens: options.historyBudgetTokens,
        hardSignals: options.hardSignals,
        workspaceIdentitySet: {
            identities: workspace.identities,
            namesByIdentity: workspace.namesByIdentity,
        },
    });
    const claimLane = readClaimLaneSnapshot({ db: options.db, projectPath, workspace });
    const memoryBudget = options.memoryInjectionBudgetTokens ?? DEFAULT_MEMORY_BUDGET_TOKENS;
    let renderedClaims =
        claimLane === null ? [] : trimClaimLane(claimLane, memoryBudget, workspace);
    const docs = readProjectDocsForM0(projectDirectory ?? "", options.injectDocs);
    snapshotMarkers.projectDocsHash = docs.canonicalHash;
    snapshotMarkers.materializedAt = options.state.cachedM0MaterializedAt ?? 0;
    const compartments = options.compactionOff
        ? []
        : withCompartmentDates(
              options.sessionId,
              readM0Compartments(options.db, options.sessionId),
              options.temporalAwareness,
          );
    const userMemories = safeGetActiveUserMemories(options.db);
    const budget = options.historyBudgetTokens ?? DEFAULT_HISTORY_BUDGET_TOKENS;
    const mural =
        options.mural ??
        resolveMuralForM0(options, projectPath, snapshotMarkers.modelKey, memoryBudget);
    const render = (decayPressureMultiplier: number): string =>
        renderM0({
            projectDocs: docs.renderedBlock,
            userProfileBaseline: userMemories,
            compartments,
            memories: [],
            claimMemories: renderedClaims,
            facts: [],
            claimSourceNameById: claimLane?.sourceNameByClaimId,
            historyBudgetTokens: budget,
            userProfileBudgetTokens: options.userProfileBudgetTokens,
            decayPressureMultiplier,
            mural,
        });
    let decayPressureMultiplier = 1;
    let m0Text = render(decayPressureMultiplier);
    let attempts = 0;
    while (budget > 0 && historySliceTokens(m0Text) > budget * 1.05 && attempts < 3) {
        decayPressureMultiplier *= 1.15;
        m0Text = render(decayPressureMultiplier);
        attempts += 1;
    }
    if (claimLane !== null) {
        const freshVector = readProjectMemorySnapshotVector(
            options.db,
            claimLane.projectIds,
            claimLane.workspaceEpoch,
        );
        if (snapshotVectorChanges(claimLane.snapshotVector, freshVector).length > 0) {
            renderedClaims = [];
            m0Text = render(decayPressureMultiplier);
            snapshotMarkers.claimSnapshotVector = freshVector;
            snapshotMarkers.renderedRevisionLocators = [];
        } else {
            snapshotMarkers.claimSnapshotVector = claimLane.snapshotVector;
            snapshotMarkers.renderedRevisionLocators = renderedClaims.map(
                (item) => item.revisionLocator,
            );
        }
    }
    if (m0Text.length === 0) m0Text = M0_EMPTY_BODY;
    options.state.cachedM0MuralDataUrl =
        mural?.enabled && mural.supportsVision ? (mural.dataUrl ?? null) : null;
    options.state.cachedM0MuralHash =
        mural?.enabled && mural.supportsVision ? (mural.contentHash ?? null) : null;
    snapshotMarkers.muralHash = options.state.cachedM0MuralHash;
    return {
        m0Bytes: Buffer.from(m0Text, "utf8"),
        snapshotMarkers,
        renderedRevisionLocators: renderedClaims.map((item) => item.revisionLocator),
    };
}

export function injectM0M1(options: M0M1RenderOptions): InjectM0M1Result {
    // Hydration reads only the cached row that supplied the held m[0] bytes.
    if (options.state.cachedM0Bytes && options.state.cachedM0MuralDataUrl === undefined) {
        const row = readCachedM0M1Row(options.db, options.sessionId);
        if (row && bufferEqualsNullable(row.cached_m0_bytes, options.state.cachedM0Bytes)) {
            options.state.cachedM0MuralDataUrl = row.cached_m0_mural_data_url ?? null;
            options.state.cachedM0MuralHash = row.cached_m0_mural_hash ?? null;
        }
    }
    if (!options.workspaceIdentitySet && options.projectPath) {
        options = {
            ...options,
            workspaceIdentitySet: resolveWorkspaceIdentitySet(options.db, options.projectPath),
        };
    }
    const skipped: InjectM0M1Result = {
        injected: false,
        prependedMessageCount: 0,
        m0RematerializedThisPass: false,
        materializationContentionRetryExhausted: false,
        decision: { value: false, reason: "skipped" },
        m0Bytes: options.state.cachedM0Bytes,
        m1Text: null,
    };
    if (options.state.isSubagent && !options.compactionOff) return skipped;

    const decision = mustMaterialize({
        db: options.db,
        sessionId: options.sessionId,
        state: options.state,
        projectPath: options.projectPath,
        projectDirectory: options.projectDirectory,
        hardSignals: options.hardSignals,
        workspaceIdentitySet: options.workspaceIdentitySet,
        injectDocs: options.injectDocs,
        muralEnabled: options.muralEnabled,
        memoryInjectionBudgetTokens: options.memoryInjectionBudgetTokens,
        historyBudgetTokens: options.historyBudgetTokens,
    });
    let rematerialized = false;
    let contentionExhausted = false;
    let freshFallbackRenderedRevisionLocators: string[] | null = null;
    let m1Render: RenderM1Result | null = null;

    if (decision.value) {
        try {
            const materialized = materializeWithRetry(options);
            applyMarkersToState(
                options.state,
                materialized.m0Bytes,
                materialized.snapshotMarkers,
                materialized.m1Bytes,
            );
            m1Render = {
                text: materialized.m1Text,
                memoryUpdateCount: 0,
                renderedRevisionLocators: [],
            };
            rematerialized = true;
        } catch (error) {
            if (!(error instanceof MaterializeContentionError)) throw error;
            if (options.state.cachedM0Bytes && options.state.cachedM1Bytes) {
                // The fallback reuses the cached baseline after a sibling process mutates state during materialization.
                // The fallback serves the cached m[0]/m[1] pair for this pass and retries on the next pass.
                // The fallback requires both byte buffers because replayCachedM1 throws when m[1] is absent.
                // Reusing m[0] without m[1] makes replayCachedM1 throw RenderM1InvalidMarkersError, dropping injection entirely.
                // The partial-cache state is reachable when a prior fresh fallback sets in-memory m[0] without persisting m[1].
                contentionExhausted = true;
                options.state.snapshotMarkers =
                    options.state.snapshotMarkers ?? snapshotMarkersFromCachedM0(options.state);
                sessionLog(
                    options.sessionId,
                    `m[0] materialization contention exhausted after ${error.retries} retries; reusing cached m[0]/m[1]`,
                );
            } else {
                // A history refresh can clear the cache before lock contention exhausts.
                // The fallback renders a non-persisted m[0]/m[1] pair when contention exhausts without a cached baseline, preserving session history.
                const fresh = renderFreshM0NonPersisted(options);
                options.state.cachedM0Bytes = fresh.m0Bytes;
                options.state.snapshotMarkers = fresh.snapshotMarkers;
                freshFallbackRenderedRevisionLocators = fresh.renderedRevisionLocators;
                contentionExhausted = true;
                sessionLog(
                    options.sessionId,
                    `m[0] materialization contention exhausted after ${error.retries} retries with no cached fallback; rendered fresh non-persisted m[0]/m[1]`,
                );
            }
        }
    } else {
        options.state.snapshotMarkers =
            options.state.snapshotMarkers ?? snapshotMarkersFromCachedM0(options.state);
    }

    if (!options.state.cachedM0Bytes || !options.state.snapshotMarkers) {
        throw new RenderM1InvalidMarkersError(options.sessionId);
    }

    let m0Text = decodeM0Bytes(options.state.cachedM0Bytes) ?? M0_EMPTY_BODY;
    let m1Text: string;
    let memoryUpdateCount = 0;
    let m1Recomputed = m1Render !== null;

    if (m1Render) {
        m1Text = m1Render.text;
        memoryUpdateCount = m1Render.memoryUpdateCount;
    } else if (contentionExhausted && freshFallbackRenderedRevisionLocators) {
        const freshM1 = renderM1WithMetadata(
            { ...options },
            options.state.snapshotMarkers,
            freshFallbackRenderedRevisionLocators,
        );
        m1Text = freshM1.text;
        memoryUpdateCount = freshM1.memoryUpdateCount;
        m1Recomputed = true;
    } else if (contentionExhausted) {
        m1Text = replayCachedM1(options.state);
    } else if (options.isCacheBustingPass) {
        const refreshed = softRefreshCachedM1(options);
        m1Text = refreshed.text;
        memoryUpdateCount = refreshed.memoryUpdateCount;
        m1Recomputed = true;
        m0Text = decodeM0Bytes(options.state.cachedM0Bytes) ?? M0_EMPTY_BODY;
    } else {
        m1Text = replayCachedM1(options.state);
    }

    // When no hard bust occurs but the m[1] delta grows large, the code folds m[1] into m[0] and resets m[1].
    // The code refolds only cache-busting passes that freshly recompute m[1].
    // Non-cache-busting passes replay persisted bytes and never refold.
    //
    // For eligible cache-busting passes, memoryUpdateCount > 40 triggers refolding regardless of m[1] size.
    // Eligible passes refold when m[1] exceeds 15% of m[0] and m[0] has at least 500 tokens.
    // M0_DRIFT_RATIO_FLOOR prevents M0_EMPTY_BODY from exceeding the 15% ratio threshold on every pass.
    // The absolute cap refolds eligible passes even when m[0] is below the ratio floor.
    const M0_DRIFT_RATIO_FLOOR_TOKENS = 500;
    const M1_DRIFT_RATIO = 0.15;
    const M1_ABSOLUTE_CAP_RATIO = 0.2;
    const m1AbsoluteBudget =
        (options.historyBudgetTokens ?? DEFAULT_HISTORY_BUDGET_TOKENS) * M1_ABSOLUTE_CAP_RATIO;
    // The refold check uses token counts because the budgets are token-based.
    const m1HasContent = m1Text !== M1_EMPTY_PLACEHOLDER;
    const m1Tokens = m1HasContent ? estimateTokens(m1Text) : 0;
    const m0Tokens = estimateTokens(m0Text);
    const m1OverAbsoluteCap = m1HasContent && m1Tokens > m1AbsoluteBudget;
    if (
        !rematerialized &&
        !contentionExhausted &&
        m1Recomputed &&
        options.isCacheBustingPass &&
        (memoryUpdateCount > 40 ||
            m1OverAbsoluteCap ||
            (m1HasContent &&
                m0Tokens >= M0_DRIFT_RATIO_FLOOR_TOKENS &&
                m1Tokens > m0Tokens * M1_DRIFT_RATIO))
    ) {
        try {
            const refolded = materializeWithRetry(options);
            applyMarkersToState(
                options.state,
                refolded.m0Bytes,
                refolded.snapshotMarkers,
                refolded.m1Bytes,
            );
            rematerialized = true;
            m0Text = decodeM0Bytes(options.state.cachedM0Bytes) ?? M0_EMPTY_BODY;
            m1Text = refolded.m1Text;
        } catch (error) {
            // MaterializeContentionError leaves the current un-refolded m[0]/m[1] pair.
            if (!(error instanceof MaterializeContentionError)) throw error;
        }
    }

    const publishedVector = options.state.snapshotMarkers.claimSnapshotVector;
    const currentWorkspace = resolveWorkspaceRenderContext({
        db: options.db,
        projectPath: options.projectPath,
        workspaceIdentitySet: options.workspaceIdentitySet,
    });
    const claimLaneMoved =
        publishedVector === undefined ||
        snapshotVectorChanges(
            publishedVector,
            readProjectMemorySnapshotVector(
                options.db,
                Object.keys(publishedVector?.projectGenerations ?? {}).map(Number),
                resolveWorkspaceEpoch(options.db, currentWorkspace),
            ),
        ).length > 0;
    if (claimLaneMoved) {
        m0Text = stripProjectMemoryBlock(m0Text);
        options.state.cachedM0MuralDataUrl = null;
        options.state.cachedM0MuralHash = null;
        options.db
            .prepare(
                "UPDATE session_meta SET memory_block_count = 0, memory_block_ids = '[]', memory_block_hashes = '[]' WHERE session_id = ?",
            )
            .run(options.sessionId);
    }

    // The state must not retain a textual mural reference when no mural is sent.
    if (!options.state.cachedM0MuralDataUrl) {
        m0Text = stripMemoryMuralBlock(m0Text);
    }

    let prependedMessageCount = 0;
    if (options.messages) {
        const muralForWire = options.state.cachedM0MuralDataUrl
            ? {
                  enabled: true,
                  supportsVision: true,
                  dataUrl: options.state.cachedM0MuralDataUrl,
                  contentHash: options.state.cachedM0MuralHash ?? undefined,
              }
            : undefined;
        prependedMessageCount = prependM0M1Messages(
            options.sessionId,
            options.messages,
            m0Text,
            m1Text,
            muralForWire,
        );
    }

    return {
        injected: true,
        prependedMessageCount,
        m0RematerializedThisPass: rematerialized,
        materializationContentionRetryExhausted: contentionExhausted,
        decision,
        m0Bytes: options.state.cachedM0Bytes,
        m1Text,
    };
}
