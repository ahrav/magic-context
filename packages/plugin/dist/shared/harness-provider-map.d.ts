/**
 * Provider-id translation between the canonical (OpenCode) form stored in the
 * shared magic-context config and Pi's harness-native provider ids.
 *
 * Provider IDs are a harness boundary, not a database identity. Shared config
 * always stores the canonical OpenCode form. Each non-OpenCode harness owns an
 * explicit pair of edge transforms:
 *
 *   canonical (OpenCode)   Pi / OMP selector
 *   --------------------   -----------------
 *   openai/<model>         openai-codex/<model>
 *   google/<model>         google-antigravity/<model>
 *   anthropic/<model>      anthropic/<model> (same; every other provider too)
 *
 * Pi and OMP currently expose the same two subscription-provider aliases, but
 * their exported functions remain distinct deliberately. A future OMP catalog
 * rename must not silently change plain-Pi behavior (or vice versa).
 *
 * The mapping is intentionally not a one-to-one provider identity. Both
 * harnesses also expose plain `openai` and `google` providers for direct API
 * keys, while the canonical prefix does not record whether a subscription or
 * API-key backend should win. The runtime starts with the preferred
 * subscription form and subagent-runner may retry once with the untranslated
 * canonical form when that form reports missing credentials.
 *
 * Only the provider prefix before the first slash is translated. Model IDs,
 * including nested IDs containing more slashes, are preserved byte-for-byte.
 * Scoped or otherwise unknown provider prefixes are identities.
 *
 * OpenCode needs no translation because canonical is its native form.
 */
/** Pi-native `provider/model` -> canonical (OpenCode). Identity when unmapped.
 *  Used by the Pi setup wizard so configs it writes stay OpenCode-readable. */
export declare function piModelRefToCanonical(ref: string): string;
/** Canonical (OpenCode) `provider/model` -> Pi-native, for spawning a model on
 *  Pi. Idempotent: normalizes any Pi-form prefix back to canonical first, so it
 *  is safe on a config that already holds Pi-form ids (hand-edited or pre-fix). */
export declare function resolveModelRefForPi(ref: string): string;
/**
 * Return every known spelling of a model reference with the canonical shared
 * form first. The raw input remains the first fallback, so a single config file
 * works on every harness: canonical wins when both spellings are present, while
 * Pi/OMP-native provider ids are still accepted at the read edge. Unknown
 * providers pass through unchanged and therefore produce one candidate.
 */
export declare function modelRefLookupOrder(ref: string): string[];
/** OMP-native selector -> canonical shared-config model reference. */
export declare function ompModelRefToCanonical(ref: string): string;
/** Canonical shared-config model reference -> OMP-native selector. */
export declare function resolveModelRefForOmp(ref: string): string;
//# sourceMappingURL=harness-provider-map.d.ts.map