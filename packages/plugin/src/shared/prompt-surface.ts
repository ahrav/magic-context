import { modelRefLookupOrder } from "./harness-provider-map";

/* */
export type PromptSurfacePreset = "full" | "light";

/**
 */
export interface PromptSurfaceConfig {
    default?: PromptSurfacePreset;
    models?: Readonly<Record<string, PromptSurfacePreset>>;
    guidance_override_path?: string;
    tool_descriptions?: Readonly<Record<string, string>>;
}

/** Stable wire identity for the config fields that can alter a served prompt surface. */
export function promptSurfaceConfigIdentity(config: PromptSurfaceConfig | undefined): string {
    return JSON.stringify({
        default: config?.default ?? "full",
        models: Object.entries(config?.models ?? {}).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
        ),
        guidanceOverridePath: config?.guidance_override_path ?? null,
        toolDescriptions: Object.entries(config?.tool_descriptions ?? {}).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
        ),
    });
}

export type PromptSurfaceResolutionSource = "exact" | "bare" | "wildcard" | "default";

/** The validator accepts bare model, provider/model, and provider/* routing keys. */
export function isValidPromptSurfaceModelKey(key: string): boolean {
    if (key.length === 0 || key.trim() !== key) return false;

    const slash = key.indexOf("/");
    if (slash < 0) return !key.includes("*");
    if (slash === 0 || slash === key.length - 1) return false;

    const provider = key.slice(0, slash);
    const modelID = key.slice(slash + 1);
    if (
        provider.trim() !== provider ||
        modelID.trim() !== modelID ||
        provider.includes("*") ||
        (modelID.includes("*") && modelID !== "*")
    ) {
        return false;
    }
    if (modelID === "*") return true;

    return (
        modelID.length > 0 &&
        !modelID.startsWith("/") &&
        !modelID.endsWith("/") &&
        !modelID.includes("//")
    );
}

export type ModelKeyLookupSource = Exclude<PromptSurfaceResolutionSource, "default">;

export interface ModelKeyCandidate {
    key: string;
    source: ModelKeyLookupSource;
}

/**
 * The lookup returns candidates from most to least specific.
 * The model ID retains additional slashes, and candidate matching is case-sensitive.
 *
 * The lookup checks `provider/*` after exact, base-model, and bare keys.
 * Exact and base-model overrides take precedence over `provider/*`.
 * A provider wildcard applies only when no exact, base-model, or bare key matches.
 * models.
 */
export function modelKeyLookupOrder(modelKey: string | undefined): ModelKeyCandidate[] {
    if (!modelKey) return [];

    const slash = modelKey.indexOf("/");
    if (slash <= 0 || slash === modelKey.length - 1) return [];

    const provider = modelKey.slice(0, slash);
    let modelID = modelKey.slice(slash + 1);
    const providerRefs = modelRefLookupOrder(`${provider}/${modelID}`);
    const candidates: ModelKeyCandidate[] = [];

    while (modelID.length > 0) {
        for (const providerRef of providerRefs) {
            const providerSlash = providerRef.indexOf("/");
            const providerPrefix = providerRef.slice(0, providerSlash);
            candidates.push({ key: `${providerPrefix}/${modelID}`, source: "exact" });
        }
        candidates.push({ key: modelID, source: "bare" });

        const lastDash = modelID.lastIndexOf("-");
        if (lastDash <= 0) break;
        modelID = modelID.slice(0, lastDash);
    }

    for (const providerRef of providerRefs) {
        const providerSlash = providerRef.indexOf("/");
        const providerPrefix = providerRef.slice(0, providerSlash);
        candidates.push({ key: `${providerPrefix}/*`, source: "wildcard" });
    }

    const seen = new Set<string>();
    return candidates.filter((candidate) => {
        if (seen.has(candidate.key)) return false;
        seen.add(candidate.key);
        return true;
    });
}

/** Resolve one per-model value using the shared cache_ttl lookup walk. */
function resolveModelConfigValue<T>(
    values: Readonly<Record<string, T>> | undefined,
    modelKey: string | undefined,
): { value: T; source: ModelKeyLookupSource } | undefined {
    if (!values) return undefined;

    for (const candidate of modelKeyLookupOrder(modelKey)) {
        const value = values[candidate.key];
        if (value !== undefined) {
            return { value, source: candidate.source };
        }
    }

    return undefined;
}

/**
 * partial match.
 */
export function resolvePromptSurface(
    config: PromptSurfaceConfig | undefined,
    modelKey: string | undefined,
): { preset: PromptSurfacePreset; source: PromptSurfaceResolutionSource } {
    const fallback = config?.default ?? "full";
    const match = resolveModelConfigValue(config?.models, modelKey);

    if (match) {
        return { preset: match.value, source: match.source };
    }

    return { preset: fallback, source: "default" };
}

/* */
export function resolveModelConfigOrDefault<T>(
    values: Readonly<Record<string, T>>,
    modelKey: string | undefined,
    fallback: T,
): T {
    return resolveModelConfigValue(values, modelKey)?.value ?? fallback;
}
