export type ResolvedTransformMode = "ts" | "rust";

export interface ResolveTransformModeArgs {
    configured: ResolvedTransformMode;
    /** The user tier itself selected rust, consenting to the managed packaged host. */
    userTierConfiguredRust: boolean;
    /** The user tier supplies a trusted explicit daemon (`subc`). */
    userTierHasSubc: boolean;
    compactionEnabled: boolean;
}

export const RUST_COMPACTION_OFF_WARNING =
    "compaction-off mode does not support rust transform mode; using the TypeScript transform.";

export const RUST_REQUIRES_USER_CONSENT_WARNING =
    "rust mode requires user-level consent (user-tier transform_mode or subc configuration); running ts.";

export function resolveTransformMode(args: ResolveTransformModeArgs): {
    mode: ResolvedTransformMode;
    warnings: string[];
} {
    if (args.configured === "rust" && !args.compactionEnabled) {
        return {
            mode: "ts",
            warnings: [RUST_COMPACTION_OFF_WARNING],
        };
    }

    // Rust mode requires user-tier consent before activation.
    // Project-controlled configuration alone must not activate Rust mode.
    // User-tier Rust selection or a trusted explicit `subc` daemon grants consent.
    if (args.configured === "rust" && !args.userTierConfiguredRust && !args.userTierHasSubc) {
        return {
            mode: "ts",
            warnings: [RUST_REQUIRES_USER_CONSENT_WARNING],
        };
    }

    return { mode: args.configured, warnings: [] };
}
