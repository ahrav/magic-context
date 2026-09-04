/**
 * Per-model tokenizer calibration ratios.
 *
 * ai-tokenizer's `claude` / `o200k_base` / `cl100k_base` / `p50k_base` encodings
 * approximate provider tokenizers but drift from the API's actual count by
 * model-specific amounts. Empirically measured ratios from
 * `scripts/calibrate-tokenizer/` (sweep against real production system prompt
 * + 39 MCP-style tools + minimal conversation, comparing local count vs each
 * provider's own usage.input_tokens).
 *
 * `system_ratio = api_tokens / local_raw_tokens` for plain-text system prompts
 * `tools_ratio  = api_tokens / local_raw_tokens` for the tools array
 *
 * Multiplying the local count by these ratios yields the API's count.
 *
 * Pattern matching: longest prefix wins. Unknown models fall back to 1.0 / 1.0
 * (no calibration). Re-run the harness when adding new models or after a
 * provider tokenizer change.
 */
export interface ModelCalibration {
    systemRatio: number;
    toolsRatio: number;
}
/**
 * Look up calibration ratios for a given `providerID/modelID` key. Performs
 * longest-prefix match (case-insensitive). Returns neutral ratios (1.0/1.0)
 * for unknown models so the calibration is a no-op rather than incorrect.
 */
export declare function resolveModelCalibration(providerId: string | undefined, modelId: string | undefined): ModelCalibration;
/**
 * Apply calibration to local raw counts and absorb the residual into the
 * unknown-drift buckets so all categories sum to exactly inputTokens.
 *
 * Bucket policy by stability:
 *   1. **Calibrated** (System, Tool Defs) — local count × measured per-model
 *      ratio. We have empirically derived ratios from `scripts/calibrate-tokenizer/`,
 *      so these match the API to within ~5%.
 *   2. **Verbatim** (Compartments, Facts, Memories) — local raw count, no
 *      scaling. Magic-context owns this content end-to-end (rendered XML,
 *      injected via `prepareCompartmentInjection`), and the compressor uses
 *      the same local count for budget math (`execute-status.ts` "History
 *      block"). Showing a different number here would confuse users and
 *      desync the sidebar from `/ctx-status`.
 *   3. **Residual absorbers** (Conversation, Tool Calls) — proportionally
 *      scaled to absorb whatever's left after (1) and (2). These have the
 *      most genuine drift (mixed user/assistant text + tool I/O) and the
 *      least fixed structure, so attributing the unknown remainder here is
 *      the most honest mapping.
 *
 * Behavior at the edges:
 *   - inputTokens === 0 → returns all zeros.
 *   - residual local sum === 0 (no conversation or tool calls yet) →
 *     conversation absorbs the full remainder so the bar still adds up.
 *   - non-residual buckets together exceed inputTokens (rare clamp case) →
 *     residuals = 0; calibrated + verbatim are scaled down proportionally so
 *     the sum never exceeds inputTokens.
 *   - rounding: residual ±1 token from rounding lands in the larger residual
 *     bucket so exact equality is preserved.
 */
export interface CalibratedBuckets {
    systemTokens: number;
    toolDefinitionTokens: number;
    compartmentTokens: number;
    factTokens: number;
    memoryTokens: number;
    docsTokens: number;
    profileTokens: number;
    conversationTokens: number;
    toolCallTokens: number;
}
export interface CalibrationInput {
    inputTokens: number;
    /** Local raw count (ai-tokenizer) for the system prompt. */
    systemLocal: number;
    /** Local raw count (ai-tokenizer) for the tool definitions. */
    toolDefsLocal: number;
    /** Verbatim — local raw counts displayed unchanged so the sidebar matches `/ctx-status`. */
    compartmentsLocal: number;
    factsLocal: number;
    memoriesLocal: number;
    /** Verbatim — <project-docs> block in m[0] (stable scaffolding, own budget). */
    docsLocal: number;
    /** Verbatim — <user-profile> block in m[0] (stable scaffolding, own budget). */
    profileLocal: number;
    /** Residual absorbers — proportionally scaled to absorb the remainder. */
    conversationLocal: number;
    toolCallsLocal: number;
    calibration: ModelCalibration;
}
export declare function calibrateBuckets(input: CalibrationInput): CalibratedBuckets;
//# sourceMappingURL=tokenizer-calibration.d.ts.map