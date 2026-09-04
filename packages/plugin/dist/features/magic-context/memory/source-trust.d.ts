import type { SourceTrustClass } from "../storage-claim-applicability-schema.ts";
export { SOURCE_TRUST_CLASSES } from "../storage-claim-applicability-schema.ts";
export declare function trustClassForLegacyMemorySource(sourceType: string | null | undefined): SourceTrustClass;
/**
 * Returning `null` prevents model-authored replacement bytes from inheriting
 * a legacy `user` row's `explicit_user` trust classification.
 */
export declare function liveRewriteSourceType(): string | null;
//# sourceMappingURL=source-trust.d.ts.map