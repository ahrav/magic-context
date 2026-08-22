import type { SourceTrustClass } from "../storage-claim-applicability-schema.ts";

export { SOURCE_TRUST_CLASSES } from "../storage-claim-applicability-schema.ts";

export function trustClassForLegacyMemorySource(
    sourceType: string | null | undefined,
): SourceTrustClass {
    return sourceType === "user" ? "explicit_user" : "model_inference";
}

/**
 * Returning `null` prevents model-authored replacement bytes from inheriting
 * a legacy `user` row's `explicit_user` trust classification.
 */
export function liveRewriteSourceType(): string | null {
    return null;
}
