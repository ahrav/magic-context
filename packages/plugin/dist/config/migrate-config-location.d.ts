/**
 * Config-LOCATION migration: move Magic Context config from the per-harness
 * legacy locations to one shared CortexKit location, mirroring AFT's proven
 * move-and-marker design (NOT copy-in-place, which is a silent stale-edit trap).
 *
 * Legacy (read by old builds):
 *   user:    ~/.config/opencode/magic-context.{jsonc,json}
 *            ~/.pi/agent/magic-context.{jsonc,json}
 *   project: <root>/magic-context.{jsonc,json}            (bare root)
 *            <root>/.opencode/magic-context.{jsonc,json}
 *            <root>/.pi/magic-context.{jsonc,json}
 *
 * Target (the only thing new builds read — HARD CUTOVER, harness-agnostic):
 *   user:    ~/.config/cortexkit/magic-context.jsonc
 *   project: <root>/.cortexkit/magic-context.jsonc
 *
 * The migrator runs at plugin init before the loader. Idempotency comes from
 * the legacy file being renamed away (not from a sentinel): once a source is
 * moved aside to `<name>.MOVED_READPLEASE`, later runs find no legacy source
 * and no-op. The marker is a pure human breadcrumb — the loader never reads it.
 *
 * NB: this is config-LOCATION migration. It is unrelated to the schema/key
 * migrations (migrate-dreamer-v2, migrate-experimental) that rewrite keys
 * INSIDE an already-located config file.
 */
export interface LegacyConfigSource {
    path: string;
    label: string;
}
export interface ConfigMigrationLogger {
    warn?: (msg: string) => void;
    info?: (msg: string) => void;
    log?: (msg: string) => void;
}
export interface ConfigFileMigrationOptions {
    scope: "user" | "project";
    targetPath: string;
    legacySources: readonly LegacyConfigSource[];
    logger?: ConfigMigrationLogger;
}
export interface ConfigFileMigrationResult {
    migrated: boolean;
    conflict: boolean;
    sourcePath?: string;
    targetPath: string;
    warnings: string[];
}
/** `~/.config/cortexkit/magic-context` (no extension — for detectConfigFile). */
export declare function cortexKitUserConfigBasePath(): string;
/** `<root>/.cortexkit/magic-context` (no extension — for detectConfigFile). */
export declare function cortexKitProjectConfigBasePath(directory: string): string;
/** The migration target: always normalized to `.jsonc`. */
export declare function resolveCortexKitUserConfigPath(): string;
/** The migration target: always normalized to `.jsonc`. */
export declare function resolveCortexKitProjectConfigPath(directory: string): string;
/**
 * The legacy config locations to migrate FROM, by scope. Each base produces a
 * `.jsonc` and a `.json` candidate; whichever exists migrates, target is always
 * `.jsonc`. The bare-root project source (`<root>/magic-context.*`) is unique to
 * Magic Context (AFT never had it) — omitting it would orphan repo-root configs.
 *
 * Project sources are filtered against the user-scope path set: when a session's
 * project directory IS the user config home (e.g. opencode opened in
 * `~/.config/cortexkit`), the bare-root project source `<root>/magic-context.jsonc`
 * resolves to the USER config path. Without this guard the project migration
 * would "migrate" the user's own config into `<root>/.cortexkit/` and rename the
 * original aside, leaving the user on schema defaults (the config-eats-itself
 * bug). A project migration must never touch a user-scope file.
 */
export declare function resolveLegacyConfigSources(directory: string): {
    user: LegacyConfigSource[];
    project: LegacyConfigSource[];
};
export type ConfigHarness = "opencode" | "pi";
/**
 * Legacy sources owned by ONE harness, most-specific first. Used by the loaders
 * as a NON-DESTRUCTIVE read fallback: when the shared CortexKit base is absent
 * (migration not yet run, or refused because OpenCode and Pi legacy configs
 * differ), the running harness reads its OWN legacy config rather than silently
 * falling back to schema defaults — which would re-enable features the legacy
 * config disabled. Each harness reads only its own files, so a differing pair
 * stays correct per-harness until the user consolidates. The bare project-root
 * `<root>/magic-context.*` was OpenCode-only historically.
 */
export declare function resolveLegacyConfigSourcesForHarness(directory: string, harness: ConfigHarness): {
    user: LegacyConfigSource[];
    project: LegacyConfigSource[];
};
export declare function migrateConfigFile(opts: ConfigFileMigrationOptions): ConfigFileMigrationResult;
/**
 * Run both the user-scope and project-scope config-location migrations for a
 * project directory. Idempotent and cheap when nothing to migrate (a few
 * existsSync calls). Call once at plugin init, before loading config. Returns
 * any warnings (conflicts / partial failures) for the host to surface + log.
 */
export declare function migrateMagicContextConfigLocations(directory: string, logger?: ConfigMigrationLogger): string[];
//# sourceMappingURL=migrate-config-location.d.ts.map