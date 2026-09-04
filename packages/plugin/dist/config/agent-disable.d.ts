/**
 * User-facing spelling of the compaction-off config path, for log lines and
 * command output. Built from fragments so the accessor-exclusivity guard
 * (compaction-accessor-guard.test.ts) can keep rejecting literal
 * `compaction.enabled` reads elsewhere — messages import this constant instead
 * of inlining the path (the S5/S8 slices both re-derived it and tripped the
 * guard; one constant ends that class).
 */
export declare const COMPACTION_ENABLED_PATH = "compaction.enabled";
export declare function isDreamerRunnable(config: {
    dreamer?: {
        disable?: boolean;
    } | null;
}): boolean;
export declare function isSidekickRunnable(config: {
    sidekick?: {
        disable?: boolean;
    } | null;
}): boolean;
export declare function isHistorianRunnable(config: {
    historian?: {
        disable?: boolean;
    } | null;
}): boolean;
/**
 * The ONLY non-schema reader of the `compaction.enabled` config path.
 * Resolves the compaction-off mode gate from a parsed Magic Context config.
 * Lives beside the other subsystem toggles (isDreamerRunnable /
 * isHistorianRunnable) and is IMPORTED — never re-derived — by every gate
 * site (pi-plugin, cli, plugin boot, session hooks). Returns true (compaction
 * ON / default behavior) when the block or field is absent.
 */
export declare function isCompactionEnabled(config: {
    compaction?: {
        enabled?: boolean;
    } | null;
}): boolean;
export declare function migrateLegacyAgentEnabledInMemory(rawConfig: Record<string, unknown>, warnings: string[]): Record<string, unknown>;
//# sourceMappingURL=agent-disable.d.ts.map