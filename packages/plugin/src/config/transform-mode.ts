export type ResolvedTransformMode = "ts" | "rust";

export interface ResolveTransformModeArgs {
    configured: ResolvedTransformMode;
    userTierHasSubc: boolean;
    compactionEnabled: boolean;
}

export const RUST_COMPACTION_OFF_WARNING =
    "compaction-off mode does not support rust transform mode; using the TypeScript transform.";

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

    return { mode: args.configured, warnings: [] };
}
