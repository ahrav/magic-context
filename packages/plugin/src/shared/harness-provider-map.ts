/**
 *
 *
 *   --------------------   -----------------
 *   openai/<model>         openai-codex/<model>
 *   google/<model>         google-antigravity/<model>
 *
 * Pi and OMP retain separate transforms so a rename in one cannot alter the other.
 *
 *
 * `remapProviderPrefix` translates only the prefix before the first slash.
 * `remapProviderPrefix` preserves suffixes containing additional slashes byte-for-byte.
 * Scoped or otherwise unknown provider prefixes are identities.
 *
 */

const CANONICAL_TO_PI_PROVIDER: Readonly<Record<string, string>> = {
    openai: "openai-codex",
    google: "google-antigravity",
};

const PI_TO_CANONICAL_PROVIDER: Readonly<Record<string, string>> = {
    "openai-codex": "openai",
    "google-antigravity": "google",
};

const CANONICAL_TO_OMP_PROVIDER: Readonly<Record<string, string>> = {
    openai: "openai-codex",
    google: "google-antigravity",
};

const OMP_TO_CANONICAL_PROVIDER: Readonly<Record<string, string>> = {
    "openai-codex": "openai",
    "google-antigravity": "google",
};

/**
 * Own-property lookups keep `constructor/model` and `toString/model` unchanged.
 * */
function remapProviderPrefix(ref: string, map: Readonly<Record<string, string>>): string {
    if (typeof ref !== "string") return ref;
    const slash = ref.indexOf("/");
    if (slash <= 0) return ref;
    const provider = ref.slice(0, slash);
    if (!Object.hasOwn(map, provider)) return ref;
    return `${map[provider]}${ref.slice(slash)}`;
}

/**
 * */
export function piModelRefToCanonical(ref: string): string {
    return remapProviderPrefix(ref, PI_TO_CANONICAL_PROVIDER);
}

/**
 * `resolveModelRefForPi` maps Pi-form and canonical refs to the same Pi-form ref.
 * */
export function resolveModelRefForPi(ref: string): string {
    return remapProviderPrefix(piModelRefToCanonical(ref), CANONICAL_TO_PI_PROVIDER);
}

/**
 * `modelRefLookupOrder` places the raw input after the canonical candidate when they differ.
 * `modelRefLookupOrder` returns one candidate for unknown provider prefixes.
 */
export function modelRefLookupOrder(ref: string): string[] {
    const canonical = piModelRefToCanonical(ompModelRefToCanonical(ref));
    return [
        ...new Set([
            canonical,
            ref,
            resolveModelRefForPi(canonical),
            resolveModelRefForOmp(canonical),
        ]),
    ];
}

/* */
export function ompModelRefToCanonical(ref: string): string {
    return remapProviderPrefix(ref, OMP_TO_CANONICAL_PROVIDER);
}

/* */
export function resolveModelRefForOmp(ref: string): string {
    return remapProviderPrefix(ompModelRefToCanonical(ref), CANONICAL_TO_OMP_PROVIDER);
}
