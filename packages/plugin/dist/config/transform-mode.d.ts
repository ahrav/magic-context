export type ResolvedTransformMode = "ts" | "rust";
export interface ResolveTransformModeArgs {
    configured: ResolvedTransformMode;
    /** The user tier itself selected rust, consenting to the managed packaged host. */
    userTierConfiguredRust: boolean;
    /** The user tier supplies a trusted explicit daemon (`subc`). */
    userTierHasSubc: boolean;
    compactionEnabled: boolean;
}
export declare const RUST_COMPACTION_OFF_WARNING = "compaction-off mode does not support rust transform mode; using the TypeScript transform.";
export declare const RUST_REQUIRES_USER_CONSENT_WARNING = "rust mode requires user-level consent (user-tier transform_mode or subc configuration); running ts.";
export declare function resolveTransformMode(args: ResolveTransformModeArgs): {
    mode: ResolvedTransformMode;
    warnings: string[];
};
//# sourceMappingURL=transform-mode.d.ts.map