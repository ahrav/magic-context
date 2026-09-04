/** The built-in prompt-surface variants. */
export type PromptSurfacePreset = "full" | "light";
/**
 * The configuration consumed by prompt-surface resolution. The schema adds
 * validation and defaults; this structural type keeps the resolver usable by
 * every host without importing a config loader.
 */
export interface PromptSurfaceConfig {
    default?: PromptSurfacePreset;
    models?: Readonly<Record<string, PromptSurfacePreset>>;
    guidance_override_path?: string;
    tool_descriptions?: Readonly<Record<string, string>>;
}
/** Stable wire identity for the config fields that can alter a served prompt surface. */
export declare function promptSurfaceConfigIdentity(config: PromptSurfaceConfig | undefined): string;
export type PromptSurfaceResolutionSource = "exact" | "bare" | "wildcard" | "default";
/** Validate bare model, provider/model, and provider/* routing keys. */
export declare function isValidPromptSurfaceModelKey(key: string): boolean;
export type ModelKeyLookupSource = Exclude<PromptSurfaceResolutionSource, "default">;
export interface ModelKeyCandidate {
    key: string;
    source: ModelKeyLookupSource;
}
/**
 * Return the same progressive model-key candidates used by cache_ttl. The
 * provider/model boundary is the first slash; the rest of the string remains
 * the model ID, including additional slashes. Candidates are case-sensitive.
 *
 * Known harness provider aliases are checked canonical-first at each specificity,
 * so one shared config works on every harness and canonical wins on collisions.
 * Provider wildcards are checked after progressively less-specific model keys,
 * but before the caller's default. That keeps an exact or base-model override
 * authoritative while still allowing `provider/*` to cover otherwise-unlisted
 * models.
 */
export declare function modelKeyLookupOrder(modelKey: string | undefined): ModelKeyCandidate[];
/** Resolve one per-model value using the shared cache_ttl lookup walk. */
export declare function resolveModelConfigValue<T>(values: Readonly<Record<string, T>> | undefined, modelKey: string | undefined): {
    value: T;
    source: ModelKeyLookupSource;
} | undefined;
/**
 * Resolve the prompt preset for a model. Invalid or missing model keys use the
 * configured default and are reported as a default resolution rather than a
 * partial match.
 */
export declare function resolvePromptSurface(config: PromptSurfaceConfig | undefined, modelKey: string | undefined): {
    preset: PromptSurfacePreset;
    source: PromptSurfaceResolutionSource;
};
/** Resolve a cache_ttl-style value with the shared model-key walk. */
export declare function resolveModelConfigOrDefault<T>(values: Readonly<Record<string, T>>, modelKey: string | undefined, fallback: T): T;
//# sourceMappingURL=prompt-surface.d.ts.map