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

    // Rust mode may demand-start the managed native host and hand it the
    // user's provider credentials. Project (repo-controlled) config alone must
    // not activate that: the user tier consents either by selecting rust
    // itself or by supplying a trusted explicit daemon. project-security.ts
    // documents project-tier `transform_mode` as safe under exactly this gate.
    if (args.configured === "rust" && !args.userTierConfiguredRust && !args.userTierHasSubc) {
        return {
            mode: "ts",
            warnings: [RUST_REQUIRES_USER_CONSENT_WARNING],
        };
    }

    return { mode: args.configured, warnings: [] };
}
