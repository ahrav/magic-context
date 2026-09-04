import type { RawMessage } from "./read-session-raw";
export interface TrueRawTokenBreakdown {
    text: number;
    reasoning: number;
    toolInput: number;
    toolOutput: number;
    image: number;
    other: number;
    total: number;
}
export interface TrueRawEstimateOptions {
    providerShapeVersion: "opencode-v1" | "pi-folded-v1";
    imageTokenHeuristic?: (part: unknown) => number;
}
export interface TrueRawTokenIndex {
    readonly sessionId: string;
    readonly providerShapeVersion: string;
    readonly rawMessageCount: number;
    tokenForOrdinal(ordinal: number): number;
    messageIdAtOrdinal(ordinal: number): string | null;
    suffixTokensFromOrdinal(ordinal: number): number;
    rangeTokens(startInclusive: number, endExclusive: number): number;
    findSuffixStartForTokens(tokens: number): number;
    findHeadEndForCap(startInclusive: number, endExclusive: number, capTokens: number): number;
}
export interface ToolArc {
    callId: string;
    invOrdinal: number;
    resOrdinal: number | null;
}
/** True when a tail beginning at `boundary` would retain a completed result without its call. */
export declare function completedToolArcCrossesBoundary(invOrdinal: number, resOrdinal: number, boundary: number): boolean;
export interface TrueRawTokenIndexBuildOptions extends TrueRawEstimateOptions {
    cacheNamespace: string;
    /**
     * Durable per-message token source. When provided and it returns a non-null
     * value for a message, that value is used as the message's total instead of
     * live-tokenizing its parts — this is how the protected-tail boundary reads
     * the precomputed `tags.token_count` store (restart-durable) rather than
     * re-tokenizing the whole raw session every cold pass. Returning null falls
     * back to live tokenization for that message (untagged / legacy-NULL rows),
     * which converges to the stored path once the tagger backfills.
     */
    storedTotalForMessage?: (message: RawMessage) => number | null;
    /**
     * Absolute total message count for the session, when `messages` is a
     * TAIL-ONLY slice carrying absolute ordinals (e.g. only messages after the
     * last compartment boundary). The prefix/suffix machinery is sized to this
     * count and ordinals outside the supplied slice contribute zero tokens —
     * which is exactly correct for every offset-forward query the protected-tail
     * boundary makes (its candidate, suffix, range, and head-cap reads never
     * cross below the eligible offset). Lets the boundary resolve from only the
     * eligible tail instead of reading the whole session every pass.
     *
     * Omitted for whole-session callers: defaults to `messages.length`, and with
     * contiguous 1..N ordinals the result is byte-identical to the prior
     * index-positional fill.
     */
    absoluteMessageCount?: number;
}
export declare function estimateTrueRawMessageTokens(message: RawMessage, options: TrueRawEstimateOptions): TrueRawTokenBreakdown;
export declare function buildToolArcs(messages: readonly RawMessage[]): ToolArc[];
export declare function fenceBoundaryForToolArcs(candidate: number, arcs: readonly ToolArc[], lastCompartmentEndOrdinal: number, recentOpenArcCutoff: number): number;
export declare function buildTrueRawTokenIndex(sessionId: string, messages: readonly RawMessage[], options: TrueRawTokenIndexBuildOptions): TrueRawTokenIndex;
export declare function computeRawRangeFingerprint(messages: readonly RawMessage[], startInclusive: number, endExclusive: number): string;
export declare function invalidateTrueRawTokenCache(args: {
    sessionId?: string;
    messageId?: string;
    reason: "message.updated" | "message.removed" | "session.compacted" | "session.deleted" | "pi.branch.changed" | "pi.stable-id-scheme.changed" | "provider.unregistered" | "schema.migration";
}): void;
export declare function buildTrueRawTokenIndexFromTokenCountsForTest(sessionId: string, tokens: readonly number[]): TrueRawTokenIndex;
//# sourceMappingURL=read-session-true-raw-tokens.d.ts.map