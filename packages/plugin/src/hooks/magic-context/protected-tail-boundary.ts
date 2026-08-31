import { getLastCompartmentEndMessage } from "../../features/magic-context/compartment-storage";
import {
    loadProtectedTailMeta,
    markProtectedTailPolicyV3Seeded,
    recordProtectedTailNoEligibleHead,
} from "../../features/magic-context/storage-meta-persisted";
import { getAllStatusTagTokenTotalsFlat } from "../../features/magic-context/storage-tags";
import { escalationBands } from "../../shared/escalation-bands";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import { deriveTriggerBudget } from "./derive-budgets";
import {
    getCachedAbsoluteMessageCount,
    getLegacyProtectedTailStartOrdinal,
    readRawSessionMessages,
} from "./read-session-chunk";
import { hasMeaningfulUserText } from "./read-session-formatting";
import {
    buildToolArcs,
    buildTrueRawTokenIndex,
    completedToolArcCrossesBoundary,
    computeRawRangeFingerprint,
    fenceBoundaryForToolArcs,
    type TrueRawTokenIndex,
} from "./read-session-true-raw-tokens";

export type BoundaryMode =
    | "trigger"
    | "incremental-runner"
    | "transform-force"
    | "manual-full-recomp"
    | "manual-partial-recomp"
    | "manual-wrapup"
    | "pi-trigger"
    | "pi-runner";

export interface BoundaryUsage {
    percentage: number;
    inputTokens: number;
}

export interface ResolvedBoundaryContext {
    sessionId: string;
    mode: BoundaryMode;
    contextLimit: number;
    executeThresholdPercentage: number;
    triggerBudget: number;
    usage: BoundaryUsage | null;
    usageSource: "live" | "persisted" | "provisional-zero" | "manual-none";
    lastCompartmentEndOrdinal: number;
    priorBoundaryOrdinal: number;
    protectedTailPolicyVersion: number;
    migrationFloorActive: boolean;
    emergencyTailScale?: 0.5 | 0.25;
    providerShapeVersion: "opencode-v1" | "pi-folded-v1";
    cacheNamespace: string;
    createdAt?: number;
    /**
     * Maps each real message ID to the sum of its active tags' `token_counts`.
     * When present, `storedTokenTotals` lets the boundary token index avoid re-tokenizing raw session messages.
     * A missing message entry or NULL tag-store count falls back to live tokenization.
     * When no tag store exists, omit `storedTokenTotals` to tokenize every message live.
     */
    storedTokenTotals?: Map<string, number>;
}

export interface ProtectedTailBoundarySnapshot {
    sessionId: string;
    mode: BoundaryMode;
    offset: number;
    offsetMessageId: string | null;
    protectedTailStart: number;
    protectedTailStartMessageId: string | null;
    eligibleEndOrdinal: number;
    eligibleEndMessageId: string | null;
    rawMessageCountAtTrigger: number;
    rawLastMessageIdAtTrigger: string | null;
    N: number;
    usagePercentage: number;
    usageInputTokens: number;
    usageSource: ResolvedBoundaryContext["usageSource"];
    contextLimit: number;
    executeThresholdPercentage: number;
    triggerBudget: number;
    priorBoundaryOrdinal: number;
    migrationFloorActive: boolean;
    emergencyTailScale?: 0.5 | 0.25;
    providerShapeVersion: "opencode-v1" | "pi-folded-v1";
    cacheNamespace: string;
    createdAt: number;
    rawRangeFingerprint: string;
    trueRawEligibleTokens: number;
    oversizeAtomicUnit: boolean;
    boundaryReason: string;
}

export interface ProtectedTailTokenTarget {
    usable: number;
    rawN: number;
    floorN: number;
    ceilingN: number;
    effectiveFloor: number;
    N: number;
    headroom: number;
    triggerBudget: number;
    reserve: number;
}

export interface RawHistoryEligibility {
    lastCompartmentEnd: number;
    offset: number;
    rawMessageCount: number;
    hasRawBeyondLastCompartment: boolean;
}

export interface ProactiveTriggerInfo {
    boundary: ProtectedTailBoundarySnapshot;
    hasProtectedEligibleHead: boolean;
    trueRawEligibleTokens: number;
    tcTokenEstimate: number;
    messageCount: number;
    commitClusterCount: number;
    isMeaningful: boolean;
}

export interface BoundarySnapshotValidationResult {
    ok: boolean;
    reason?: "stale_snapshot" | "model_or_limit_changed";
    detail?: string;
}

export interface WrapupBoundaryPlan {
    snapshot: ProtectedTailBoundarySnapshot;
    /** Raw messages (any role) after the last durable compartment, counted at command start. */
    rawMessagesAboveLastCompartment: number;
    /** Raw-message count used to anchor the keep watermark for the whole wrapup loop. */
    anchorRawMessageCount: number;
    /** First raw ordinal that remains protected by the keep watermark. */
    targetProtectedTailStart: number;
    /** Exclusive eligible end before per-run capping. */
    targetEligibleEndOrdinal: number;
}

const ALPHA = 0.3;
const FLOOR_RATIO = 0.08;
const FLOOR_MIN = 2_000;
const FLOOR_MAX = 12_000;
const ABS_CAP = 96_000;
const MAX_USABLE_RATIO = 0.4;
const RESERVED_HEADROOM_MIN = 1_000;
const RESERVED_HEADROOM_RATIO = 0.02;
const NON_EMERGENCY_MAX_CAP = 250_000;
const FORCE80_MAX_CAP = 500_000;
const FORCE95_MAX_CAP = 750_000;
const NORMAL_HYSTERESIS_TOKENS = 256;

export const RECOVERY_NO_HEAD_LIMIT = 2;

/** At force pressure, summarize a complete eligible head at or above `deriveMinForceEligibleTokens(scaledN)`; otherwise wait for a real arc or user turn. */
export const MIN_FORCE_ELIGIBLE_TOKENS_CAP = 1_000;

export function deriveMinForceEligibleTokens(scaledN: number): number {
    return Math.min(MIN_FORCE_ELIGIBLE_TOKENS_CAP, Math.max(1, Math.floor(scaledN / 8)));
}

function clampPercentage(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(100, value));
}

function clampOrdinal(value: number, rawMessageCount: number): number {
    return Math.max(1, Math.min(rawMessageCount + 1, Math.floor(value)));
}

export function deriveProtectedTailTokenTarget(args: {
    contextLimit: number;
    executeThresholdPercentage: number;
    usagePercentage: number;
    triggerBudget?: number;
}): ProtectedTailTokenTarget {
    const safeContextLimit =
        Number.isFinite(args.contextLimit) && args.contextLimit > 0 ? args.contextLimit : 128_000;
    const safeThreshold = Number.isFinite(args.executeThresholdPercentage)
        ? Math.max(0, args.executeThresholdPercentage)
        : 65;
    const usable = Math.max(1, Math.round((safeContextLimit * safeThreshold) / 100));
    const usage = clampPercentage(args.usagePercentage);
    const triggerBudget =
        args.triggerBudget ?? deriveTriggerBudget(safeContextLimit, safeThreshold);
    const reserve = Math.max(RESERVED_HEADROOM_MIN, Math.round(usable * RESERVED_HEADROOM_RATIO));
    const rawN = Math.round(usable * ALPHA * (1 - usage / 100));
    const floorN = Math.min(FLOOR_MAX, Math.max(FLOOR_MIN, Math.round(usable * FLOOR_RATIO)));
    const headroom = Math.min(triggerBudget + reserve, Math.floor(usable * 0.5));
    const ceilingN = Math.max(
        1,
        Math.min(ABS_CAP, Math.floor(usable * MAX_USABLE_RATIO), usable - headroom),
    );
    const effectiveFloor = Math.min(floorN, ceilingN);
    const N = Math.min(ceilingN, Math.max(effectiveFloor, rawN));
    return { usable, rawN, floorN, ceilingN, effectiveFloor, N, headroom, triggerBudget, reserve };
}

/**
 * Per-run cap tiers, ordered by descending usage threshold; selection takes
 * the first tier whose `minUsagePercentage` the snapshot meets, falling back
 * to the last tier for out-of-domain values (negative or NaN usage). Every
 * column increases toward the higher-pressure tiers, so rising pressure can
 * never shrink the drain cap across a tier boundary.
 */
const PER_RUN_CAP_TIERS = [
    {
        minUsagePercentage: 95,
        maxCap: FORCE95_MAX_CAP,
        nMultiplier: 4,
        usableFraction: 0.5,
        absoluteCap: 250_000,
    },
    // Capacity sizing deliberately retains its historical 80% tier. For execute
    // thresholds from 84% through 90%, this cap no longer coincides with the
    // derived force-band transition.
    {
        minUsagePercentage: 80,
        maxCap: FORCE80_MAX_CAP,
        nMultiplier: 3,
        usableFraction: 0.35,
        absoluteCap: 150_000,
    },
    {
        minUsagePercentage: 0,
        maxCap: NON_EMERGENCY_MAX_CAP,
        nMultiplier: 2,
        usableFraction: 0.25,
        absoluteCap: 100_000,
    },
] as const;

function perRunCapForTier(
    tier: (typeof PER_RUN_CAP_TIERS)[number],
    usable: number,
    N: number,
): number {
    return Math.min(
        tier.maxCap,
        Math.max(
            tier.nMultiplier * N,
            Math.min(Math.round(tier.usableFraction * usable), tier.absoluteCap),
        ),
    );
}

export function selectPerRunCap(
    snapshot: Pick<
        ProtectedTailBoundarySnapshot,
        "usagePercentage" | "N" | "contextLimit" | "executeThresholdPercentage"
    >,
): number {
    const usable = Math.max(
        1,
        Math.round((snapshot.contextLimit * snapshot.executeThresholdPercentage) / 100),
    );
    const tier =
        PER_RUN_CAP_TIERS.find((t) => snapshot.usagePercentage >= t.minUsagePercentage) ??
        PER_RUN_CAP_TIERS[PER_RUN_CAP_TIERS.length - 1];
    return perRunCapForTier(tier, usable, snapshot.N);
}

function boundaryMessageId(index: TrueRawTokenIndex, ordinal: number): string | null {
    if (ordinal < 1 || ordinal > index.rawMessageCount) return null;
    return index.messageIdAtOrdinal(ordinal);
}

function isSemanticBoundaryCandidate(messageParts: unknown[], role: string): boolean {
    if (role === "user" && hasMeaningfulUserText(messageParts)) return true;
    if (
        messageParts.some(
            (part) =>
                String(
                    typeof part === "object" && part !== null && "type" in part
                        ? (part as { type?: unknown }).type
                        : "",
                ) === "tool",
        )
    ) {
        return true;
    }
    return false;
}

function semanticSnapBoundary(args: {
    messages: ReturnType<typeof readRawSessionMessages>;
    index: TrueRawTokenIndex;
    candidate: number;
    scaledN: number;
    lastCompartmentEndOrdinal: number;
}): number {
    const { messages, index, candidate, scaledN, lastCompartmentEndOrdinal } = args;
    let snapped = candidate;
    for (const message of messages) {
        if (message.ordinal > candidate) break;
        if (message.ordinal < lastCompartmentEndOrdinal + 1) continue;
        if (!isSemanticBoundaryCandidate(message.parts, message.role)) continue;
        snapped = message.ordinal;
    }
    if (snapped === candidate) return candidate;
    const extraTokens =
        index.suffixTokensFromOrdinal(snapped) - index.suffixTokensFromOrdinal(candidate);
    if (extraTokens > Math.min(Math.round(1.5 * scaledN), 48_000)) return candidate;
    const snappedMessage = messages.find((message) => message.ordinal === snapped);
    if (
        snappedMessage?.role === "user" &&
        index.tokenForOrdinal(snapped) > Math.max(2 * scaledN, 64_000)
    ) {
        return candidate;
    }
    return snapped;
}

function snapWrapupBoundaryToUser(args: {
    messages: ReturnType<typeof readRawSessionMessages>;
    index: TrueRawTokenIndex;
    candidate: number;
    offset: number;
    triggerBudget: number;
}): number {
    const { messages, index, candidate, offset, triggerBudget } = args;
    if (candidate <= offset) return candidate;
    const snapTokenLimit = Math.min(Math.max(triggerBudget, 2_000), 48_000);
    for (let ordinal = candidate; ordinal >= offset; ordinal -= 1) {
        const message = messages.find((m) => m.ordinal === ordinal);
        if (!message) continue;
        if (message.role !== "user" || !hasMeaningfulUserText(message.parts)) continue;
        const extraTokens = index.rangeTokens(ordinal, candidate);
        if (extraTokens <= snapTokenLimit) return ordinal;
        return candidate;
    }
    return candidate;
}

function fenceWrapupBoundaryForToolArcs(args: {
    candidate: number;
    arcs: ReturnType<typeof buildToolArcs>;
    lastCompartmentEndOrdinal: number;
}): number {
    let boundary = args.candidate;
    const maxPasses = args.arcs.length + 1;
    for (let pass = 0; pass < maxPasses; pass += 1) {
        let next = boundary;
        for (const arc of args.arcs) {
            if (arc.resOrdinal === null) {
                // An open invocation at or after the watermark is already in the kept tail.
                // An open invocation before the watermark is stale or interrupted.
                continue;
            }
            if (
                arc.invOrdinal >= args.lastCompartmentEndOrdinal + 1 &&
                completedToolArcCrossesBoundary(arc.invOrdinal, arc.resOrdinal, next)
            ) {
                next = arc.invOrdinal;
            }
        }
        if (next === boundary) return boundary;
        boundary = next;
    }
    return boundary;
}

function applyHeadCap(args: {
    index: TrueRawTokenIndex;
    protectedTailStart: number;
    offset: number;
    arcs: ReturnType<typeof buildToolArcs>;
    lastCompartmentEndOrdinal: number;
    capTokens: number;
    recentOpenArcCutoff: number;
}): { eligibleEndOrdinal: number; oversizeAtomicUnit: boolean } {
    const { index, protectedTailStart, offset, arcs, capTokens, recentOpenArcCutoff } = args;
    if (offset >= protectedTailStart)
        return { eligibleEndOrdinal: offset, oversizeAtomicUnit: false };
    let end = index.findHeadEndForCap(offset, protectedTailStart, capTokens);
    let oversizeAtomicUnit = end === offset + 1 && index.tokenForOrdinal(offset) > capTokens;
    for (const arc of arcs) {
        const resOrdinal = arc.resOrdinal;
        if (resOrdinal === null) {
            // Only a recent open arc, the in-flight call, caps the eligible head.
            // A stale open arc in the eligible head must not cap the head.
            // A stale open arc in the eligible head must not shrink the head to that arc's ordinal.
            // Do not cap the head at a stale arc's ordinal: a dead arc at the head edge would collapse the eligible region and starve the historian.
            if (
                arc.invOrdinal >= recentOpenArcCutoff &&
                arc.invOrdinal >= offset &&
                arc.invOrdinal < end
            ) {
                end = Math.min(end, arc.invOrdinal);
            }
            continue;
        }
        if (arc.invOrdinal < end && end <= resOrdinal) {
            end = Math.min(protectedTailStart, resOrdinal + 1);
            if (index.rangeTokens(Math.max(offset, arc.invOrdinal), end) > capTokens)
                oversizeAtomicUnit = true;
        }
    }
    if (end <= offset && offset < protectedTailStart) {
        return { eligibleEndOrdinal: offset, oversizeAtomicUnit };
    }
    return { eligibleEndOrdinal: Math.min(end, protectedTailStart), oversizeAtomicUnit };
}

/**
 * The nine snapshot fields copied verbatim from the resolved boundary context.
 * Kept as one helper so every snapshot constructor carries the identical
 * context slice; the Pick return type pins the field set at compile time.
 */
function boundaryCtxFields(
    ctx: ResolvedBoundaryContext,
): Pick<
    ProtectedTailBoundarySnapshot,
    | "usageSource"
    | "contextLimit"
    | "executeThresholdPercentage"
    | "triggerBudget"
    | "priorBoundaryOrdinal"
    | "migrationFloorActive"
    | "emergencyTailScale"
    | "providerShapeVersion"
    | "cacheNamespace"
> {
    return {
        usageSource: ctx.usageSource,
        contextLimit: ctx.contextLimit,
        executeThresholdPercentage: ctx.executeThresholdPercentage,
        triggerBudget: ctx.triggerBudget,
        priorBoundaryOrdinal: ctx.priorBoundaryOrdinal,
        migrationFloorActive: ctx.migrationFloorActive,
        emergencyTailScale: ctx.emergencyTailScale,
        providerShapeVersion: ctx.providerShapeVersion,
        cacheNamespace: ctx.cacheNamespace,
    };
}

export function resolveProtectedTailBoundary(
    ctx: ResolvedBoundaryContext,
): ProtectedTailBoundarySnapshot {
    const createdAt = ctx.createdAt ?? Date.now();
    const messages = readRawSessionMessages(ctx.sessionId);
    const storedTotals = ctx.storedTokenTotals;
    // When a tail-only slice is primed, `messages` holds the eligible tail with absolute ordinals.
    // Size the index to the absolute session message count.
    // A `null` slice indexes the whole session with `messages.length`.
    const absoluteMessageCount = getCachedAbsoluteMessageCount(ctx.sessionId) ?? undefined;
    const index = buildTrueRawTokenIndex(ctx.sessionId, messages, {
        providerShapeVersion: ctx.providerShapeVersion,
        cacheNamespace: ctx.cacheNamespace,
        absoluteMessageCount,
        storedTotalForMessage: storedTotals
            ? (m) => {
                  const v = storedTotals.get(m.id);
                  return v === undefined ? null : v;
              }
            : undefined,
    });
    const rawMessageCount = index.rawMessageCount;
    const offset = Math.max(1, ctx.lastCompartmentEndOrdinal + 1);
    const usagePercentage = clampPercentage(ctx.usage?.percentage ?? 0);
    const usageInputTokens = Math.max(0, Math.round(ctx.usage?.inputTokens ?? 0));

    if (rawMessageCount === 0) {
        return {
            sessionId: ctx.sessionId,
            mode: ctx.mode,
            offset,
            offsetMessageId: null,
            protectedTailStart: 1,
            protectedTailStartMessageId: null,
            eligibleEndOrdinal: 1,
            eligibleEndMessageId: null,
            rawMessageCountAtTrigger: 0,
            rawLastMessageIdAtTrigger: null,
            N: 0,
            usagePercentage,
            usageInputTokens,
            ...boundaryCtxFields(ctx),
            createdAt,
            rawRangeFingerprint: "",
            trueRawEligibleTokens: 0,
            oversizeAtomicUnit: false,
            boundaryReason: "empty-session",
        };
    }

    if (ctx.mode === "manual-full-recomp") {
        const arcs = buildToolArcs(messages);
        // Only an open arc within the live recent window may hold back a full recomp.
        // A stale or interrupted open arc must not block `/ctx-recomp` because its result will never arrive.
        // A stale or interrupted open arc must not block `/ctx-recomp`.
        // A dead invocation must not freeze the historian or `/ctx-recomp`.
        const recompTarget = deriveProtectedTailTokenTarget({
            contextLimit: ctx.contextLimit,
            executeThresholdPercentage: ctx.executeThresholdPercentage,
            usagePercentage: 0,
            triggerBudget: ctx.triggerBudget,
        });
        const recentOpenArcCutoff = index.findSuffixStartForTokens(recompTarget.N);
        const firstOpenArc = arcs.find(
            (arc) =>
                arc.resOrdinal === null &&
                arc.invOrdinal >= offset &&
                arc.invOrdinal >= recentOpenArcCutoff,
        );
        const protectedTailStart = firstOpenArc?.invOrdinal ?? rawMessageCount + 1;
        const rawRangeFingerprint = computeRawRangeFingerprint(
            messages,
            offset,
            protectedTailStart,
        );
        return {
            sessionId: ctx.sessionId,
            mode: ctx.mode,
            offset,
            offsetMessageId: boundaryMessageId(index, offset),
            protectedTailStart,
            protectedTailStartMessageId: null,
            eligibleEndOrdinal: protectedTailStart,
            eligibleEndMessageId: boundaryMessageId(index, protectedTailStart - 1),
            rawMessageCountAtTrigger: rawMessageCount,
            rawLastMessageIdAtTrigger: boundaryMessageId(index, rawMessageCount),
            N: 0,
            usagePercentage: 0,
            usageInputTokens: 0,
            usageSource: "manual-none",
            contextLimit: ctx.contextLimit,
            executeThresholdPercentage: ctx.executeThresholdPercentage,
            triggerBudget: ctx.triggerBudget,
            priorBoundaryOrdinal: ctx.priorBoundaryOrdinal,
            migrationFloorActive: false,
            emergencyTailScale: ctx.emergencyTailScale,
            providerShapeVersion: ctx.providerShapeVersion,
            cacheNamespace: ctx.cacheNamespace,
            createdAt,
            rawRangeFingerprint,
            trueRawEligibleTokens: index.rangeTokens(offset, protectedTailStart),
            oversizeAtomicUnit: false,
            boundaryReason: firstOpenArc ? "open-tool-arc" : "manual-full-recomp",
        };
    }

    const target = deriveProtectedTailTokenTarget({
        contextLimit: ctx.contextLimit,
        executeThresholdPercentage: ctx.executeThresholdPercentage,
        usagePercentage,
        triggerBudget: ctx.triggerBudget,
    });
    const scaledN = ctx.emergencyTailScale
        ? Math.max(1, Math.floor(target.N * ctx.emergencyTailScale))
        : target.N;
    const arcs = buildToolArcs(messages);
    let boundary = index.findSuffixStartForTokens(scaledN);
    // Open tool arcs at or after recentOpenArcCutoff remain protected.
    // Open arcs before recentOpenArcCutoff do not fence the boundary.
    const recentOpenArcCutoff = boundary;
    let boundaryReason = boundary === 1 ? "whole-session-smaller-than-tail" : "size-walk";
    const tokenAtBoundary = index.tokenForOrdinal(boundary);
    if (
        boundary <= rawMessageCount &&
        tokenAtBoundary > Math.max(2 * scaledN, 64_000) &&
        boundary < rawMessageCount
    ) {
        boundary += 1;
        boundaryReason = "huge-message-exception";
    }
    boundary = fenceBoundaryForToolArcs(
        boundary,
        arcs,
        ctx.lastCompartmentEndOrdinal,
        recentOpenArcCutoff,
    );
    const snapped = semanticSnapBoundary({
        messages,
        index,
        candidate: boundary,
        scaledN,
        lastCompartmentEndOrdinal: ctx.lastCompartmentEndOrdinal,
    });
    if (snapped !== boundary) boundaryReason = "semantic-snap";
    boundary = fenceBoundaryForToolArcs(
        snapped,
        arcs,
        ctx.lastCompartmentEndOrdinal,
        recentOpenArcCutoff,
    );
    let runtimeFloor = offset;
    if (ctx.migrationFloorActive) runtimeFloor = Math.max(runtimeFloor, ctx.priorBoundaryOrdinal);
    let protectedTailStart = Math.max(boundary, runtimeFloor);
    // Except for the hysteresis reset, non-emergency passes below forceMaterializationPercentage lower protectedTailStart to the newest meaningful user message at or after offset.
    // Emergency-scaled passes may compact the newest meaningful user message.
    // usagePercentage at or above forceMaterializationPercentage skips the live-prompt floor when emergencyTailScale is unset.
    // emergency-scaled retry.
    const forceMaterializationPercentage = escalationBands(
        ctx.executeThresholdPercentage,
    ).forceMaterializationPercentage;
    if (!ctx.emergencyTailScale && usagePercentage < forceMaterializationPercentage) {
        let lastMeaningfulUserOrdinal = 0;
        for (let i = messages.length - 1; i >= 0; i--) {
            const message = messages[i];
            if (message.role !== "user") continue;
            if (!hasMeaningfulUserText(message.parts)) continue;
            lastMeaningfulUserOrdinal = message.ordinal;
            break;
        }
        if (lastMeaningfulUserOrdinal >= offset) {
            protectedTailStart = Math.min(protectedTailStart, lastMeaningfulUserOrdinal);
        }
    }
    if (
        protectedTailStart > offset &&
        index.rangeTokens(offset, protectedTailStart) <= NORMAL_HYSTERESIS_TOKENS
    ) {
        protectedTailStart = offset;
    }
    protectedTailStart = clampOrdinal(protectedTailStart, rawMessageCount);
    const perRunCap = selectPerRunCap({
        usagePercentage,
        N: scaledN,
        contextLimit: ctx.contextLimit,
        executeThresholdPercentage: ctx.executeThresholdPercentage,
    });
    const head = applyHeadCap({
        index,
        protectedTailStart,
        offset,
        arcs,
        lastCompartmentEndOrdinal: ctx.lastCompartmentEndOrdinal,
        capTokens: perRunCap,
        recentOpenArcCutoff,
    });
    const rawRangeFingerprint = computeRawRangeFingerprint(
        messages,
        offset,
        head.eligibleEndOrdinal,
    );
    return {
        sessionId: ctx.sessionId,
        mode: ctx.mode,
        offset,
        offsetMessageId: boundaryMessageId(index, offset),
        protectedTailStart,
        protectedTailStartMessageId: boundaryMessageId(index, protectedTailStart),
        eligibleEndOrdinal: head.eligibleEndOrdinal,
        eligibleEndMessageId: boundaryMessageId(index, head.eligibleEndOrdinal - 1),
        rawMessageCountAtTrigger: rawMessageCount,
        rawLastMessageIdAtTrigger: boundaryMessageId(index, rawMessageCount),
        N: scaledN,
        usagePercentage,
        usageInputTokens,
        ...boundaryCtxFields(ctx),
        createdAt,
        rawRangeFingerprint,
        trueRawEligibleTokens: index.rangeTokens(offset, protectedTailStart),
        oversizeAtomicUnit: head.oversizeAtomicUnit,
        boundaryReason,
    };
}

export function resolveBoundaryContext(args: {
    db: Database;
    sessionId: string;
    mode: BoundaryMode;
    contextLimit: number;
    executeThresholdPercentage: number;
    usage?: BoundaryUsage | null;
    usageSource?: ResolvedBoundaryContext["usageSource"];
    emergencyTailScale?: 0.5 | 0.25;
    providerShapeVersion?: "opencode-v1" | "pi-folded-v1";
    cacheNamespace?: string;
    /**
     */
    taggerFloor?: number;
}): ResolvedBoundaryContext {
    const lastCompartmentEndOrdinal = getLastCompartmentEndMessage(args.db, args.sessionId);
    const triggerBudget = deriveTriggerBudget(args.contextLimit, args.executeThresholdPercentage);
    let meta = loadProtectedTailMeta(args.db, args.sessionId);
    let migrationFloorActive = false;
    if (meta.protectedTailPolicyVersion < 3) {
        let legacyBoundary = 1;
        try {
            legacyBoundary = getLegacyProtectedTailStartOrdinal(args.sessionId);
        } catch (error) {
            sessionLog(
                args.sessionId,
                "protected-tail migration seed fell back to ordinal 1:",
                error,
            );
        }
        const seedResult = markProtectedTailPolicyV3Seeded(
            args.db,
            args.sessionId,
            Math.max(1, legacyBoundary),
        );
        meta = seedResult;
        migrationFloorActive = seedResult.seeded;
    }
    let storedTokenTotals: Map<string, number> | undefined;
    try {
        storedTokenTotals = getAllStatusTagTokenTotalsFlat(
            args.db,
            args.sessionId,
            args.taggerFloor ?? 0,
        ).totals;
    } catch (error) {
        sessionLog(
            args.sessionId,
            "protected-tail stored-token map unavailable (live fallback):",
            error,
        );
    }
    return {
        sessionId: args.sessionId,
        mode: args.mode,
        contextLimit: args.contextLimit,
        executeThresholdPercentage: args.executeThresholdPercentage,
        triggerBudget,
        usage: args.usage ?? null,
        usageSource: args.usageSource ?? (args.usage ? "live" : "provisional-zero"),
        lastCompartmentEndOrdinal,
        priorBoundaryOrdinal: meta.priorBoundaryOrdinal,
        protectedTailPolicyVersion: meta.protectedTailPolicyVersion,
        migrationFloorActive,
        emergencyTailScale: args.emergencyTailScale,
        providerShapeVersion: args.providerShapeVersion ?? "opencode-v1",
        cacheNamespace: args.cacheNamespace ?? `opencode:${args.sessionId}`,
        storedTokenTotals,
    };
}

export function resolveOpenCodeProtectedTailBoundary(
    args: Parameters<typeof resolveBoundaryContext>[0],
): ProtectedTailBoundarySnapshot {
    return resolveProtectedTailBoundary(resolveBoundaryContext(args));
}

export function resolveWrapupProtectedTailBoundary(
    args: Parameters<typeof resolveBoundaryContext>[0] & {
        messagesToKeep: number;
        anchorRawMessageCount?: number;
    },
): WrapupBoundaryPlan {
    const ctx = resolveBoundaryContext({ ...args, mode: "manual-wrapup" });
    const createdAt = ctx.createdAt ?? Date.now();
    const messages = readRawSessionMessages(ctx.sessionId);
    const absoluteMessageCount = getCachedAbsoluteMessageCount(ctx.sessionId) ?? undefined;
    const index = buildTrueRawTokenIndex(ctx.sessionId, messages, {
        providerShapeVersion: ctx.providerShapeVersion,
        cacheNamespace: ctx.cacheNamespace,
        absoluteMessageCount,
        storedTotalForMessage: ctx.storedTokenTotals
            ? (m) => {
                  const value = ctx.storedTokenTotals?.get(m.id);
                  return value === undefined ? null : value;
              }
            : undefined,
    });
    const rawMessageCount = index.rawMessageCount;
    const offset = Math.max(1, ctx.lastCompartmentEndOrdinal + 1);
    const anchorRawMessageCount = Math.max(
        0,
        Math.min(rawMessageCount, Math.floor(args.anchorRawMessageCount ?? rawMessageCount)),
    );
    const usagePercentage = clampPercentage(ctx.usage?.percentage ?? 0);
    const usageInputTokens = Math.max(0, Math.round(ctx.usage?.inputTokens ?? 0));

    // cut safe.
    const rawMessagesAboveLastCompartment = Math.max(0, anchorRawMessageCount - offset + 1);
    const keep = Math.max(1, Math.floor(args.messagesToKeep));

    let targetProtectedTailStart = offset;
    let boundaryReason = "manual-wrapup-empty";
    if (rawMessageCount === 0 || rawMessagesAboveLastCompartment <= keep) {
        targetProtectedTailStart = offset;
        boundaryReason =
            rawMessageCount === 0 ? "manual-wrapup-empty" : "manual-wrapup-within-keep";
    } else {
        targetProtectedTailStart = anchorRawMessageCount - keep + 1;
        boundaryReason = "manual-wrapup-keep-watermark";
        const arcs = buildToolArcs(messages);
        const fenced = fenceWrapupBoundaryForToolArcs({
            candidate: targetProtectedTailStart,
            arcs,
            lastCompartmentEndOrdinal: ctx.lastCompartmentEndOrdinal,
        });
        if (fenced !== targetProtectedTailStart) boundaryReason = "manual-wrapup-tool-arc";
        targetProtectedTailStart = fenced;
        const snapped = snapWrapupBoundaryToUser({
            messages,
            index,
            candidate: targetProtectedTailStart,
            offset,
            triggerBudget: ctx.triggerBudget,
        });
        if (snapped !== targetProtectedTailStart) boundaryReason = "manual-wrapup-user-snap";
        targetProtectedTailStart = snapped;
        const refenced = fenceWrapupBoundaryForToolArcs({
            candidate: targetProtectedTailStart,
            arcs,
            lastCompartmentEndOrdinal: ctx.lastCompartmentEndOrdinal,
        });
        // Re-fence after semantic snapping to preserve tool-arc boundaries.
        if (refenced !== targetProtectedTailStart) boundaryReason = "manual-wrapup-tool-arc";
        targetProtectedTailStart = refenced;
    }

    targetProtectedTailStart = clampOrdinal(targetProtectedTailStart, rawMessageCount);
    const target = deriveProtectedTailTokenTarget({
        contextLimit: ctx.contextLimit,
        executeThresholdPercentage: ctx.executeThresholdPercentage,
        usagePercentage,
        triggerBudget: ctx.triggerBudget,
    });
    const perRunCap = selectPerRunCap({
        usagePercentage,
        N: target.N,
        contextLimit: ctx.contextLimit,
        executeThresholdPercentage: ctx.executeThresholdPercentage,
    });
    const head = applyHeadCap({
        index,
        protectedTailStart: targetProtectedTailStart,
        offset,
        arcs: buildToolArcs(messages),
        lastCompartmentEndOrdinal: ctx.lastCompartmentEndOrdinal,
        capTokens: perRunCap,
        recentOpenArcCutoff: targetProtectedTailStart,
    });
    const eligibleEndOrdinal = Math.min(head.eligibleEndOrdinal, targetProtectedTailStart);
    const rawRangeFingerprint = computeRawRangeFingerprint(messages, offset, eligibleEndOrdinal);
    const snapshot: ProtectedTailBoundarySnapshot = {
        sessionId: ctx.sessionId,
        mode: "manual-wrapup",
        offset,
        offsetMessageId: boundaryMessageId(index, offset),
        protectedTailStart: targetProtectedTailStart,
        protectedTailStartMessageId: boundaryMessageId(index, targetProtectedTailStart),
        eligibleEndOrdinal,
        eligibleEndMessageId: boundaryMessageId(index, eligibleEndOrdinal - 1),
        rawMessageCountAtTrigger: rawMessageCount,
        rawLastMessageIdAtTrigger: boundaryMessageId(index, rawMessageCount),
        N: keep,
        usagePercentage,
        usageInputTokens,
        ...boundaryCtxFields(ctx),
        createdAt,
        rawRangeFingerprint,
        trueRawEligibleTokens: index.rangeTokens(offset, targetProtectedTailStart),
        oversizeAtomicUnit: head.oversizeAtomicUnit,
        boundaryReason,
    };
    return {
        snapshot,
        rawMessagesAboveLastCompartment,
        anchorRawMessageCount,
        targetProtectedTailStart,
        targetEligibleEndOrdinal: targetProtectedTailStart,
    };
}

export function getRawHistoryEligibility(db: Database, sessionId: string): RawHistoryEligibility {
    const lastCompartmentEnd = getLastCompartmentEndMessage(db, sessionId);
    const offset = Math.max(1, lastCompartmentEnd + 1);
    const absoluteCount = getCachedAbsoluteMessageCount(sessionId);
    const rawMessageCount = absoluteCount ?? readRawSessionMessages(sessionId).length;
    return {
        lastCompartmentEnd,
        offset,
        rawMessageCount,
        hasRawBeyondLastCompartment: rawMessageCount >= offset,
    };
}

export function hasProtectedEligibleHead(snapshot: ProtectedTailBoundarySnapshot): boolean {
    return snapshot.offset < snapshot.protectedTailStart;
}

export function hasRunnableCompartmentWindow(snapshot: ProtectedTailBoundarySnapshot): boolean {
    if (snapshot.offset >= snapshot.protectedTailStart) return false;
    const forceMaterializationPercentage = escalationBands(
        snapshot.executeThresholdPercentage,
    ).forceMaterializationPercentage;
    if (snapshot.usagePercentage >= forceMaterializationPercentage || snapshot.emergencyTailScale) {
        return (
            snapshot.trueRawEligibleTokens >= deriveMinForceEligibleTokens(snapshot.N) ||
            snapshot.eligibleEndOrdinal > snapshot.offset
        );
    }
    return snapshot.eligibleEndOrdinal > snapshot.offset;
}

export function validateBoundarySnapshot(args: {
    db: Database;
    snapshot: ProtectedTailBoundarySnapshot;
    currentContextLimit?: number;
}): BoundarySnapshotValidationResult {
    const { snapshot } = args;
    if (args.currentContextLimit && args.currentContextLimit !== snapshot.contextLimit) {
        return {
            ok: false,
            reason: "model_or_limit_changed",
            detail: `context limit changed from ${snapshot.contextLimit} to ${args.currentContextLimit}`,
        };
    }
    const messages = readRawSessionMessages(snapshot.sessionId);
    const currentRawMessageCount = messages.reduce(
        (max, message) => Math.max(max, message.ordinal),
        messages.length,
    );
    if (snapshot.rawMessageCountAtTrigger > currentRawMessageCount) {
        return { ok: false, reason: "stale_snapshot", detail: "raw message count shrank" };
    }
    const idsByOrdinal = new Map(messages.map((message) => [message.ordinal, message.id]));
    const idAt = (ordinal: number): string | null => idsByOrdinal.get(ordinal) ?? null;
    const checks: Array<[number, string | null, string]> = [
        [snapshot.offset, snapshot.offsetMessageId, "offset"],
        [snapshot.rawMessageCountAtTrigger, snapshot.rawLastMessageIdAtTrigger, "last"],
    ];
    if (snapshot.protectedTailStart <= snapshot.rawMessageCountAtTrigger) {
        checks.push([
            snapshot.protectedTailStart,
            snapshot.protectedTailStartMessageId,
            "protectedTailStart",
        ]);
    }
    if (snapshot.eligibleEndOrdinal > snapshot.offset) {
        checks.push([
            snapshot.eligibleEndOrdinal - 1,
            snapshot.eligibleEndMessageId,
            "eligibleEnd",
        ]);
    }
    for (const [ordinal, expected, label] of checks) {
        if (expected !== idAt(ordinal)) {
            return {
                ok: false,
                reason: "stale_snapshot",
                detail: `${label} ordinal ${ordinal} id changed`,
            };
        }
    }
    const expectedOffset = Math.max(
        1,
        getLastCompartmentEndMessage(args.db, snapshot.sessionId) + 1,
    );
    if (expectedOffset !== snapshot.offset) {
        return {
            ok: false,
            reason: "stale_snapshot",
            detail: `last compartment moved: offset ${snapshot.offset} -> ${expectedOffset}`,
        };
    }
    const fingerprint = computeRawRangeFingerprint(
        messages,
        snapshot.offset,
        snapshot.eligibleEndOrdinal,
    );
    if (fingerprint !== snapshot.rawRangeFingerprint) {
        return { ok: false, reason: "stale_snapshot", detail: "raw range fingerprint changed" };
    }
    return { ok: true };
}

export function recordHighPressureNoEligibleHead(
    db: Database,
    snapshot: ProtectedTailBoundarySnapshot,
): number {
    const forceMaterializationPercentage = escalationBands(
        snapshot.executeThresholdPercentage,
    ).forceMaterializationPercentage;
    if (snapshot.usagePercentage < forceMaterializationPercentage && !snapshot.emergencyTailScale) {
        return 0;
    }
    return recordProtectedTailNoEligibleHead(db, snapshot.sessionId);
}

export function createDefaultBoundarySnapshotForTests(
    sessionId: string,
): ProtectedTailBoundarySnapshot {
    const messages = readRawSessionMessages(sessionId);
    const rawMessageCount = messages.length;
    const protectedTailStart = Math.max(
        1,
        Math.min(rawMessageCount + 1, getLegacyProtectedTailStartOrdinal(sessionId)),
    );
    const index = buildTrueRawTokenIndex(sessionId, messages, {
        providerShapeVersion: "opencode-v1",
        cacheNamespace: `test:${sessionId}`,
    });
    const trueRawEligibleTokens = index.rangeTokens(1, protectedTailStart);
    const messageIdAt = (ordinal: number): string | null =>
        messages.find((message) => message.ordinal === ordinal)?.id ?? null;
    return {
        sessionId,
        mode: "incremental-runner",
        offset: 1,
        offsetMessageId: messageIdAt(1),
        protectedTailStart,
        protectedTailStartMessageId: messageIdAt(protectedTailStart),
        eligibleEndOrdinal: protectedTailStart,
        eligibleEndMessageId: messageIdAt(protectedTailStart - 1),
        rawMessageCountAtTrigger: rawMessageCount,
        rawLastMessageIdAtTrigger: messageIdAt(rawMessageCount),
        N: 0,
        usagePercentage: 0,
        usageInputTokens: 0,
        usageSource: "provisional-zero",
        contextLimit: 128_000,
        executeThresholdPercentage: 65,
        triggerBudget: deriveTriggerBudget(128_000, 65),
        priorBoundaryOrdinal: protectedTailStart,
        migrationFloorActive: false,
        providerShapeVersion: "opencode-v1",
        cacheNamespace: `test:${sessionId}`,
        createdAt: Date.now(),
        rawRangeFingerprint: "",
        trueRawEligibleTokens,
        oversizeAtomicUnit: false,
        boundaryReason: "test-legacy",
    };
}
