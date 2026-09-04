import type { MessageLike } from "./tag-messages";
/**
 * Replace structural/cleared parts with empty-text sentinels instead of removing
 * them. Preserves message.parts length between passes so Anthropic prompt-cache
 * prefixes stay byte-stable while OpenCode filters the empty text parts before
 * the wire.
 *
 * Caller contract: run only when `modelAcceptsEmptyContent(providerID)` is true.
 * Non-Anthropic adapters can forward empty text parts as real wire content.
 *
 * Idempotent: sentinels are themselves recognized on subsequent passes and
 * skipped (not re-mutated, not re-counted).
 */
export declare function stripStructuralNoise(messages: MessageLike[]): number;
//# sourceMappingURL=strip-structural-noise.d.ts.map