/**
 * Budget derivation
 *
 * Two scaling bases, two clamps. Replaces the old static
 * `compartment_token_budget` setting which tried to serve both roles
 * and scaled with neither model.
 *
 *   - triggerBudget: scales with (main model × executeThreshold).
 *     Drives size-based historian triggers (`tail_size`, `commit_clusters`).
 *     "How big can the uncompartmentalized tail get before we force
 *     historian to run." This is anchored to the MAIN model's usable
 *     working space, not its total context.
 *
 *   - historianChunkTokens: scales with the HISTORIAN model's context.
 *     The raw-history window historian processes per call. Different
 *     scaling basis because historian is a single-shot summarizer bound
 *     by its own context, not the main session's pressure math.
 */
/**
 * Budget basis for size-based historian triggers (tail_size, commit_clusters).
 * Anchored to the MAIN model's usable working space, not its total context.
 *
 * @param mainContextLimit Main session model's context window (tokens).
 * @param executeThresholdPercentage The effective execute threshold (0-100).
 */
export declare function deriveTriggerBudget(mainContextLimit: number, executeThresholdPercentage: number): number;
/**
 * Raw-history chunk budget for historian's own context window.
 * Historian formats tool calls as compact `TC:` summaries and drops tool results,
 * so a 50K-token chunk typically represents far more raw messages than its token
 * count implies. The max is tuned around that compression.
 *
 * @param historianContextLimit Historian model's context window (tokens).
 */
export declare function deriveHistorianChunkTokens(historianContextLimit: number): number;
/**
 * Resolve the historian model's context limit for chunk budget sizing.
 *
 * Behavior:
 *   - If `historianModelOverride` is a full `provider/model-id` → use that model's
 *     context directly. This honors explicit user intent.
 *   - If the override is set but lacks `/` (e.g. `"llama3-32k"`) → warn and use
 *     the conservative default, since we can't look up a model without a
 *     provider and silently guessing would produce an incorrect chunk size.
 *   - If no override (or the model is unknown to models.dev / opencode.json
 *     custom providers) → 128K conservative default.
 *
 * Context limits are resolved through `getSdkContextLimit`, which reads
 * OpenCode's SDK-resolved provider config (models.dev + snapshot + opencode.json
 * overrides + auth-plugin caps), bounded to a sane range.
 */
export declare function resolveHistorianContextLimit(historianModelOverride?: string): number;
//# sourceMappingURL=derive-budgets.d.ts.map