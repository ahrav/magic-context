/**
 * Resolve the fallback model list to attempt for a hidden-agent (historian /
 * dreamer / sidekick) call when its configured primary fails.
 *
 * Policy: ONLY the user's explicitly-configured `fallback_models` for this
 * agent. There is NO builtin provider-agnostic chain — a hardcoded chain
 * inevitably names providers the user doesn't have (e.g. a metapi-only user got
 * a chain of google/github-copilot/opencode entries, every one a
 * `Model not found` retry), which produced confusing errors and wasted
 * attempts. If the user configured nothing, this returns an empty list and the
 * runner's session-model last resort (the model the user is actually using) is
 * the only fallback.
 *
 * The returned list does NOT include the primary model — it's the ordered list
 * of *alternates* to try after the primary fails. Each entry is
 * "provider/modelID" form. Duplicates and empty strings are filtered; entries
 * that don't match the "provider/modelID" shape (a "/" with non-empty parts) are
 * dropped as a defensive guard against malformed user config.
 */
export declare function resolveFallbackChain(userFallbacks: readonly string[] | string | undefined): string[];
/**
 * Parse a "provider/modelID" string into the OpenCode `model` object shape.
 * Returns null on invalid input.
 *
 * Note: only splits on the FIRST "/" — modelID can legitimately contain slashes
 * (e.g. `lemonade/GLM-4.7-Flash-GGUF/main`).
 */
export declare function parseProviderModel(spec: string): {
    providerID: string;
    modelID: string;
} | null;
/**
 * Build the `{ model: { providerID, modelID } }` fragment for an OpenCode prompt
 * body from a `provider/model` spec string, or `{}` when the spec is absent or
 * unparseable (the session falls back to its default model). Spread into a
 * `client.session.prompt` body.
 */
export declare function modelBodyField(spec: string | undefined): {
    model?: {
        providerID: string;
        modelID: string;
    };
};
//# sourceMappingURL=resolve-fallbacks.d.ts.map