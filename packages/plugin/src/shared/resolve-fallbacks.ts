/**
 *
 *
 */
export function resolveFallbackChain(
    userFallbacks: readonly string[] | string | undefined,
): string[] {
    const userList = normalizeUserFallbacks(userFallbacks);
    return dedupe(userList.filter(isValidModelSpec));
}

function normalizeUserFallbacks(userFallbacks: readonly string[] | string | undefined): string[] {
    if (!userFallbacks) return [];
    if (typeof userFallbacks === "string") {
        const trimmed = userFallbacks.trim();
        return trimmed ? [trimmed] : [];
    }
    return userFallbacks.map((s) => s.trim()).filter((s) => s.length > 0);
}

function isValidModelSpec(spec: string): boolean {
    const slash = spec.indexOf("/");
    return slash > 0 && slash < spec.length - 1;
}

function dedupe(list: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of list) {
        if (seen.has(item)) continue;
        seen.add(item);
        out.push(item);
    }
    return out;
}

/**
 *
 * parseProviderModel splits at the first `/`; modelID may contain `/`.
 * (e.g. `lemonade/GLM-4.7-Flash-GGUF/main`).
 */
export function parseProviderModel(spec: string): { providerID: string; modelID: string } | null {
    const slash = spec.indexOf("/");
    if (slash < 1 || slash >= spec.length - 1) return null;
    return {
        providerID: spec.slice(0, slash).trim(),
        modelID: spec.slice(slash + 1).trim(),
    };
}

/**
 * `client.session.prompt` body.
 */
export function modelBodyField(spec: string | undefined): {
    model?: { providerID: string; modelID: string };
} {
    if (!spec) return {};
    const parsed = parseProviderModel(spec);
    return parsed ? { model: parsed } : {};
}
