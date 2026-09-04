/**
 * Verbose / by-id rendering for ctx_expand.
 *
 * The default ctx_expand range view returns a CONDENSED digest (turns merged,
 * tool calls collapsed to `TC: name(arg)`). These two renderers add the recovery
 * modes:
 *
 *   - `renderVerboseRange`: every message shown SEPARATELY with its message id
 *     and a per-part preview, so the agent can see exactly what's in a range and
 *     pick the id of a specific message/tool call to recover in full.
 *   - `renderMessageById`: the FULL untruncated content of one message (any
 *     role) — every text part, and every tool call's complete input + output —
 *     read straight from the harness's stored history (opencode.db / Pi JSONL).
 *     This is the cheap way back from a `ctx_reduce` drop: the wire placeholder
 *     is `[dropped §N§]`, but the original output still lives in storage until
 *     the row is genuinely deleted (session prune/revert), in which case we say
 *     so rather than re-running the tool (which could now give a different
 *     answer).
 *
 * Both read through the shared provider-aware helpers, so Pi works by registering
 * its `RawMessageProvider` for the call exactly like the range view does.
 */
/**
 * Full untruncated recovery of one message by its ORDINAL — the same `[N]`
 * identifier the agent already uses everywhere (compartment start/end, ctx_search
 * hits, the verbose range view). Returns a "deleted" message when no message sits
 * at that ordinal (pruned/reverted or wrong ordinal).
 */
export declare function renderMessageByOrdinal(sessionId: string, ordinal: number): string;
export interface VerboseRangeResult {
    text: string;
    /** Last ordinal actually rendered (for the continuation hint). */
    lastOrdinal: number;
    /** True when the budget cut the range short. */
    truncated: boolean;
}
/**
 * Verbose range view: every message in [start, end] shown separately, with its
 * id and a per-part preview, bounded by `tokenBudget`. The agent reads the ids
 * here and recovers any one message in full with ctx_expand(id=...).
 */
export declare function renderVerboseRange(sessionId: string, start: number, end: number, tokenBudget: number): VerboseRangeResult;
//# sourceMappingURL=render.d.ts.map