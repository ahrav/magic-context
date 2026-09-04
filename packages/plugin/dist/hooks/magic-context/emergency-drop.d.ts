/** Reclaim target = fixedFloor + TARGET_FRACTION × (ceiling − fixedFloor). */
export declare const TARGET_FRACTION = 0.3;
/** Keep the newest `ceil(RESERVE × tierCount)` of T1/T2 as continuation context. */
export declare const TIER_RECENCY_RESERVE = 0.2;
/**
 * Don't bust the cache for a trivial reclaim. If the computed reclaim is at or
 * below this, the pass is a no-op (combined with the watermark, this prevents
 * force-band-to-94.9% oscillation).
 */
export declare const EMERGENCY_REARM_MIN_TOKENS = 2000;
export type Tier = 1 | 2 | 3;
/**
 * Classify a tool into its drop tier. T1 (keep longest) = navigation/structure
 * the agent re-uses; T2 (medium) = edit-class continuation context; T3 (drop
 * first) = everything else (the default — bash, ctx_reduce, inspect, web, …).
 */
export declare function resolveToolTier(toolName: string | null): Tier;
/** Minimal tag shape the planner needs (subset of TagEntry, harness-agnostic). */
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
export interface EmergencyDropPlan {
    /** Whether the caller should perform any drop this pass. */
    shouldDrop: boolean;
    /** Tool tag numbers to drop, in eviction order (T3→T2→T1, oldest-first). */
    tagNumbers: number[];
    /** Reclaim target in tokens (for logging). */
    reclaimTokens: number;
    /** Human-readable reason (no-op explanation or drop summary), for logs. */
    reason: string;
}
export declare function estimateEmergencyDropReclaimTokens(tag: EmergencyDropTag): number;
/**
 * Plan a tiered target-headroom emergency drop. Pure: returns the ordered set of
 * tool tag numbers to drop plus the new watermark; the caller applies them.
 *
 * fixedFloor is derived as `currentTotalInputTokens − Σ(active floor-tag tokens)`.
 * Tags cover exactly the live-tail content (messages, tool outputs, files,
 * reasoning); system, tool defs, and m[0]/m[1] are untagged. So this difference
 * IS `system + toolDefs + (primary ? m0 + m1 : 0)` — the irreducible prefix —
 * with no extra plumbing, and it self-adjusts for subagents (no m0/m1 in their
 * total) by construction.
 *
 * The two tag sets serve DIFFERENT contracts and must not be conflated:
 * - `floorTags`: the ENTIRE active live-window tag set (all types, including
 *   non-droppable tool tags). Only their token sum matters — it makes
 *   `fixedFloor` the true irreducible prefix. Passing a narrower set (e.g.
 *   tool-only) folds real conversation/reasoning tail into the "floor",
 *   raising the target and systematically under-evicting at the derived force band.
 * - `tags`: the evictable candidates — active tool tags whose drop target
 *   would actually reclaim bytes (caller pre-filters on `canDrop()` so no
 *   phantom tag is counted as reclaimed).
 */
export declare function planEmergencyDrop(input: {
    /** Evictable candidates: active tool tags with a working drop target. */
    tags: readonly EmergencyDropTag[];
    /**
     * FULL active live-window tag set (all types) — floor accounting only.
     * See the fixedFloor contract above.
     */
    floorTags: readonly EmergencyDropTag[];
    maxTag: number;
    protectedTags: number;
    currentTotalInputTokens: number;
    /** ceiling = contextLimit × executeThreshold%. */
    ceilingTokens: number;
    /**
     * last_emergency_input_sample — the `currentTotalInputTokens` reading at the
     * previous emergency drop (0 if never dropped). The SOLE idempotence latch:
     * see the same-sample no-op below. (There is deliberately no tag-number
     * watermark — a scalar "dropped-through" cursor wrongly excludes still-active
     * lower-numbered tags after a non-contiguous tier-ordered drop. Dropped tags
     * leave the `status='active'` set, so they're never re-selected; the sample
     * latch is what prevents over-dropping the rest of the tail on a stale pass.)
     */
    priorInputSample: number;
    /** True once any emergency drop has happened (drives the latch + log). */
    hasPriorDrop: boolean;
}): EmergencyDropPlan;
//# sourceMappingURL=emergency-drop.d.ts.map