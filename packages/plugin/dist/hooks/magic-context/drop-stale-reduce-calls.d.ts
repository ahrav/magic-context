import type { MessageLike } from "./tag-messages";
export declare function isReduceToolPart(part: unknown): boolean;
export interface StaleReduceStripResult {
    /** True if any ctx_reduce part was sentinelized this pass. */
    didDrop: boolean;
    /** Message ids newly detected as aged this pass (only when detect=true). */
    newlyStrippedIds: string[];
}
/**
 * Sentinel-strip aged `ctx_reduce` tool parts using a FROZEN replay watermark.
 *
 * The cache-stability contract: a defer pass must replay byte-identical to the
 * prior pass. An earlier version recomputed eligibility from the live
 * `messages.length - protectedCount` boundary on every pass — but that boundary
 * MOVES as the conversation grows, so a defer pass with tail growth would newly
 * strip an older ctx_reduce call mid-prefix (for Anthropic the empty sentinel is
 * filtered before the wire and the dropped tool_result lets the SDK merge
 * adjacent assistants → the message vanishes + the array shifts → the cached
 * prefix busts). That is exactly the bug this design removes.
 *
 * Instead, eligibility is an id-keyed frozen set:
 * - REPLAY (every pass): strip ctx_reduce parts in any message whose `info.id`
 *   is in `frozenIds`. Growth-invariant and compaction-safe (a missing id is a
 *   no-op). This is what makes defer passes byte-identical.
 * - DETECT (cache-busting passes only, `detect=true`): additionally scan the
 *   pre-protected region for ctx_reduce calls not yet frozen, strip them, and
 *   return their ids in `newlyStrippedIds` so the caller can advance the
 *   persisted watermark. Detection happens only on passes where the wire is
 *   already allowed to change, so it never busts a defer pass.
 *
 * Messages without a stable `info.id` are never newly detected (they cannot be
 * frozen for deterministic replay), so they are left intact rather than stripped
 * inconsistently.
 */
export declare function dropStaleReduceCalls(messages: MessageLike[], frozenIds: Set<string>, options?: {
    detect?: boolean;
    protectedCount?: number;
}): StaleReduceStripResult;
//# sourceMappingURL=drop-stale-reduce-calls.d.ts.map