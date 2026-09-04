/**
 * Format an execute-threshold percentage for human-facing display.
 *
 * `executeThreshold` in the snapshot is always a percentage number, but it
 * comes from two very different config paths:
 *   1. `execute_threshold_percentage` (or its model-keyed variant) — user
 *      configures an integer like 65 directly. We must render exactly that.
 *   2. `execute_threshold_tokens` — user configures absolute token cap (e.g.
 *      128000). The resolver in `event-resolvers.ts` divides that by the
 *      model's context limit (`(128000 / 907788) * 100`) and the result is
 *      a long float like `14.099783080260304` that overflows the TUI cell
 *      (issue #90).
 *
 * Behaviour:
 *   - Integer input (≤0.05 fractional drift) renders without decimals.
 *   - Anything else is rendered with one decimal digit, which is precise
 *     enough to convey the configured token budget without smearing across
 *     two lines in a narrow sidebar.
 *
 * Returns the formatted percentage WITHOUT the trailing `%` so callers can
 * compose richer strings like `47.5% / 65%` consistently.
 */
export declare function formatThresholdPercent(value: number | undefined | null): string;
/**
 * Build a terse "clamped" annotation for execute-threshold display, or "" when the
 * configured value was not clamped. Status surfaces (/ctx-status text, pi status
 * dialog) append this so a user who configured e.g. 190000 tokens on a 128K model
 * sees that it was reduced to the 90% safety cap, instead of the value being
 * silently ignored (issue #241). The note includes the configured value and the cap
 * so the user can see the math.
 *
 * `maxPercentage` is passed in (rather than imported) to keep this shared module
 * free of a dependency on the resolver that owns the cap constant.
 */
export declare function formatThresholdClampNote(opts: {
    clamped?: boolean;
    mode: "tokens" | "percentage";
    /** Raw configured value before clamping (tokens in tokens mode, % in percentage mode). */
    configuredValue?: number;
    contextLimit: number;
    maxPercentage: number;
}): string;
//# sourceMappingURL=format-threshold.d.ts.map