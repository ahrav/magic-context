// The planner selects tool tags by tier to restore target headroom.
//
// The planner only selects tags; the harness applies the returned plan.
// The harness drops selected tags, marks them `"dropped"`, and persists the watermark.
//
// The caller MUST invoke this only on the ≥derived force-materialize pass, which busts the cache and never defers.
// Each tag is dropped at most once: candidates require `tagNumber > priorWatermark` and `status === "active"`, and the watermark advances past every dropped tag.
// The number of drop-induced cache busts per session is bounded by the tool-tag count.
// All accounting uses tokens; tags store bytes, so the planner converts with `TOKENS_PER_BYTE`.

import { newestCtxReduceTagNumbers } from "../../features/magic-context/reclaim-protection";
import { TOKENS_PER_BYTE } from "./ctx-reduce-nudge";

/* */
export const TARGET_FRACTION = 0.3;

/** The planner keeps the newest `ceil(TIER_RECENCY_RESERVE × tierCount)` T1/T2 tags as continuation context. */
export const TIER_RECENCY_RESERVE = 0.2;

/**
 * The planner returns a no-op when computed reclaim is at most `EMERGENCY_REARM_MIN_TOKENS`, preventing force-band-to-94.9% oscillation.
 * force-band-to-94.9% oscillation).
 */
export const EMERGENCY_REARM_MIN_TOKENS = 2000;

export type Tier = 1 | 2 | 3;

const T1_TOOLS = new Set(["read", "todowrite", "task", "aft_outline", "aft_zoom"]);
const T2_TOOLS = new Set(["edit", "write", "apply_patch", "grep", "glob", "aft_search"]);

/* */
function normalizeToolName(toolName: string | null): string {
    if (!toolName) return "";
    let name = toolName.toLowerCase();
    if (name.startsWith("mcp_")) name = name.slice(4);
    return name;
}

/**
 */
export function resolveToolTier(toolName: string | null): Tier {
    const name = normalizeToolName(toolName);
    if (T1_TOOLS.has(name)) return 1;
    if (T2_TOOLS.has(name)) return 2;
    return 3;
}

/* */
export interface EmergencyDropTag {
    tagNumber: number;
    type: "message" | "tool" | "file";
    status: "active" | "dropped" | "compacted";
    toolName: string | null;
    byteSize: number;
    /** Tool-arg bytes — `drop()` removes the invocation too, so these reclaim. */
    inputByteSize: number;
    reasoningByteSize: number;
}

/**
 * A tool-tag drop reclaims output, invocation arguments, and preceding reasoning because `drop()` removes every tool occurrence.
 */
function tagReclaimBytes(tag: EmergencyDropTag): number {
    return tag.byteSize + tag.inputByteSize + tag.reasoningByteSize;
}

export interface EmergencyDropPlan {
    /* */
    shouldDrop: boolean;
    /** Tool tag numbers to drop, in eviction order (T3→T2→T1, oldest-first). */
    tagNumbers: number[];
    /** Reclaim target in tokens (for logging). */
    reclaimTokens: number;
    /** Human-readable reason (no-op explanation or drop summary), for logs. */
    reason: string;
}

export function estimateEmergencyDropReclaimTokens(tag: EmergencyDropTag): number {
    return Math.round(tagReclaimBytes(tag) * TOKENS_PER_BYTE);
}

/**
 *
 * fixedFloor is derived as `currentTotalInputTokens − Σ(active floor-tag tokens)`.
 * `floorTags` covers all live-tail content.
 * System, tool definitions, and m[0]/m[1] are untagged.
 * `fixedFloor` equals `system + toolDefs + (primary ? m0 + m1 : 0)`.
 * This derivation excludes m0/m1 for subagents.
 *
 * The two tag sets serve DIFFERENT contracts and must not be conflated:
 * `floorTags` contains all active live-window tags, including non-droppable tool tags.
 * Only `floorTags`' token sum determines `fixedFloor`.
 * Passing a narrower `floorTags` set makes `fixedFloor` include evictable tail content.
 * A tool-only `floorTags` set folds conversation and reasoning tail into `fixedFloor`.
 * A narrowed `floorTags` set raises the target and under-evicts.
 * `tags` contains evictable active tool tags.
 */
export function planEmergencyDrop(input: {
    /** Evictable candidates are active tool tags eligible for dropping. */
    tags: readonly EmergencyDropTag[];
    /**
     * All active live-window tags; used only for floor accounting.
     */
    floorTags: readonly EmergencyDropTag[];
    maxTag: number;
    protectedTags: number;
    currentTotalInputTokens: number;
    /* */
    ceilingTokens: number;
    /**
     * `priorInputSample` is `currentTotalInputTokens` at the previous emergency drop, or 0.
     * `priorInputSample` is an additional idempotence latch.
     * A dropped-through tag-number cursor excludes still-active lower-numbered tags after a non-contiguous tier-ordered drop.
     */
    priorInputSample: number;
    /** `hasPriorDrop` records whether an emergency drop has happened and enables the sample latch. */
    hasPriorDrop: boolean;
}): EmergencyDropPlan {
    const {
        tags,
        floorTags,
        maxTag,
        protectedTags,
        currentTotalInputTokens,
        ceilingTokens,
        priorInputSample,
        hasPriorDrop,
    } = input;

    const noop = (reason: string): EmergencyDropPlan => ({
        shouldDrop: false,
        tagNumbers: [],
        reclaimTokens: 0,
        reason,
    });

    if (!Number.isFinite(ceilingTokens) || ceilingTokens <= 0) {
        return noop("unknown-ceiling");
    }
    if (!Number.isFinite(currentTotalInputTokens) || currentTotalInputTokens <= 0) {
        return noop("unknown-usage");
    }

    // A second pass with the same usage reading would recompute the floor from the smaller active tail.
    // The latch prevents stale passes from over-dropping the remaining tail.
    // After a drop at a usage sample, return no-op until a fresh sample arrives.
    if (hasPriorDrop && currentTotalInputTokens === priorInputSample) {
        return noop("same-input-sample (awaiting fresh usage after prior drop)");
    }

    let tailTokens = 0;
    for (const tag of floorTags) {
        if (tag.status !== "active") continue;
        tailTokens += estimateEmergencyDropReclaimTokens(tag);
    }
    const fixedFloor = Math.max(currentTotalInputTokens - tailTokens, 0);
    const workingSpan = Math.max(ceilingTokens - fixedFloor, 0);
    const target = fixedFloor + TARGET_FRACTION * workingSpan;
    const reclaimTokens = Math.round(currentTotalInputTokens - target);

    if (reclaimTokens <= EMERGENCY_REARM_MIN_TOKENS) {
        return noop(`reclaim<=min (${reclaimTokens} <= ${EMERGENCY_REARM_MIN_TOKENS})`);
    }

    const protectedCutoff = maxTag - protectedTags;

    const tierActive: Record<1 | 2, number[]> = { 1: [], 2: [] };
    for (const tag of tags) {
        if (tag.status !== "active" || tag.type !== "tool") continue;
        const tier = resolveToolTier(tag.toolName);
        if (tier === 1 || tier === 2) tierActive[tier].push(tag.tagNumber);
    }
    const reserved = new Set<number>();
    for (const tier of [1, 2] as const) {
        const nums = tierActive[tier];
        if (nums.length === 0) continue;
        nums.sort((a, b) => b - a); // newest first
        const reserveCount = Math.ceil(TIER_RECENCY_RESERVE * nums.length);
        for (let i = 0; i < reserveCount && i < nums.length; i++) {
            reserved.add(nums[i]);
        }
    }

    // `reserved` does not affect `reclaimTokens`.
    const protectedCtxReduceTags = newestCtxReduceTagNumbers(
        floorTags.filter((tag) => tag.status === "active" && tag.type === "tool"),
    );

    const byTier: Record<Tier, EmergencyDropTag[]> = { 1: [], 2: [], 3: [] };
    for (const tag of tags) {
        if (tag.status !== "active" || tag.type !== "tool") continue;
        if (tag.tagNumber > protectedCutoff) continue; // global protected tail
        if (protectedCtxReduceTags.has(tag.tagNumber)) continue;
        const tier = resolveToolTier(tag.toolName);
        if ((tier === 1 || tier === 2) && reserved.has(tag.tagNumber)) continue;
        byTier[tier].push(tag);
    }

    // The planner drops T3, then T2, then T1, oldest-first within each tier, until it meets the reclaim target.
    const selected: number[] = [];
    let reclaimed = 0;
    outer: for (const tier of [3, 2, 1] as const) {
        const group = byTier[tier];
        group.sort((a, b) => a.tagNumber - b.tagNumber); // oldest first
        for (const tag of group) {
            selected.push(tag.tagNumber);
            reclaimed += estimateEmergencyDropReclaimTokens(tag);
            if (reclaimed >= reclaimTokens) break outer;
        }
    }

    if (selected.length === 0) {
        return noop("no-candidates");
    }

    return {
        shouldDrop: true,
        tagNumbers: selected,
        reclaimTokens,
        reason: `tiered drop: ${selected.length} tags, reclaim≈${reclaimed}/${reclaimTokens} tokens (floor≈${fixedFloor}, ceiling=${Math.round(ceilingTokens)})`,
    };
}
