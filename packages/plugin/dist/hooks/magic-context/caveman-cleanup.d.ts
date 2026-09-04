/**
 * Age-tier caveman text compression for long user/assistant text parts.
 *
 * Two entry points:
 *
 * 1. `applyCavemanCleanup` — runs ONLY on cache-busting heuristic passes
 *    (execute / flush / force-materialize) and is the only path that may
 *    INCREASE `tags.caveman_depth`. Computes age tiers (20/20/20/40),
 *    persists the new depth, and applies the compressed text in place.
 *
 * 2. `replayCavemanCompression` — runs on EVERY transform pass (defer too)
 *    and re-applies the persisted depth to message text without ever
 *    increasing it. This exists because `tagMessages` restores
 *    `textPart.text = source_contents.content` (the pristine original) on
 *    every pass; without a replay step the compressed text would oscillate
 *    between compressed (post-execute) and original (defer), which would
 *    bust the provider prompt cache on every turn.
 *
 * Partitioning: eligible tags (message-type, active, byte_size >= threshold,
 * tag_number <= protected cutoff) are sorted by tag_number ascending, then
 * bucketed 20/20/20/40:
 *  - oldest 20%  → ultra
 *  - next 20%    → full
 *  - next 20%    → lite
 *  - newest 40%  → untouched
 *
 * Source-of-truth invariant: compression is ALWAYS computed from the
 * pristine original (`source_contents.content`), never from an already-
 * cavemaned intermediate. So repeated tier shifts converge identically to
 * direct compression at the target depth, and the replay path can produce
 * the exact same output as the original execute pass.
 *
 * Persisted state:
 *  - tags.caveman_depth records the applied depth
 *  - source_contents.content is unchanged (remains the pristine original)
 *  - message-part text holds the cavemaned result visible to the agent
 */
import type { ContextDatabase } from "../../features/magic-context/storage";
import type { TagEntry } from "../../features/magic-context/types";
import type { TagTarget } from "./tag-messages";
export interface CavemanCleanupConfig {
    enabled: boolean;
    minChars: number;
}
export interface CavemanCleanupResult {
    compressedToLite: number;
    compressedToFull: number;
    compressedToUltra: number;
    mutatedTextTags: number;
}
/**
 * Compute target caveman depth for a tag by its position in the sorted
 * eligible list. Visible for testing.
 */
export declare function computeTargetDepth(positionIndex: number, totalEligible: number): number;
/**
 * Apply age-tier caveman compression to eligible message tags.
 *
 * Preconditions: caller has already acquired the DB transaction context for
 * this heuristic pass (or this function opens its own). Caller is expected
 * to gate on primary sessions and `config.enabled === true`.
 */
export declare function applyCavemanCleanup(sessionId: string, db: ContextDatabase, targets: Map<number, TagTarget>, tags: TagEntry[], config: CavemanCleanupConfig & {
    protectedTags: number;
}): CavemanCleanupResult;
/**
 * Re-apply persisted caveman compression on every transform pass (defer
 * included). This is the cache-stability counterpart to applyCavemanCleanup.
 *
 * Why this exists: tagMessages restores `textPart.text = source_contents.content`
 * (the pristine original) for every existing tag on every pass. Without this
 * replay step, a tag compressed during an execute pass would revert to its
 * original text on the next defer pass. Anthropic's prompt cache hashes the
 * full message prefix, so an oscillating tag would bust cache on every turn
 * after compression first runs.
 *
 * Mirrors the pattern used by replayClearedReasoning / replayStrippedInline
 * for typed reasoning. Pure read \u2014 never increases caveman_depth, never
 * mutates the database. Only execute/flush passes (via applyCavemanCleanup)
 * can deepen the depth.
 *
 * Idempotent: cavemanCompress is deterministic over (originalText, level),
 * so calling this on every pass produces the exact same text the original
 * execute pass produced.
 */
export declare function replayCavemanCompression(sessionId: string, db: ContextDatabase, targets: Map<number, TagTarget>, tags: TagEntry[]): number;
//# sourceMappingURL=caveman-cleanup.d.ts.map