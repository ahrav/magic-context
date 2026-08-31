import {
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { stripJsonComments, stripTrailingCommas } from "../shared/jsonc-parser";

/**
 * Migrate Magic Context config from per-harness paths to CortexKit paths.
 * Renaming instead of copying prevents stale edits to legacy files.
 *
 * Old builds read these legacy paths:
 *   user:    ~/.config/opencode/magic-context.{jsonc,json}
 *            ~/.pi/agent/magic-context.{jsonc,json}
 *   project: <root>/magic-context.{jsonc,json}            (bare root)
 *            <root>/.opencode/magic-context.{jsonc,json}
 *            <root>/.pi/magic-context.{jsonc,json}
 *
 * New builds read only these harness-agnostic target paths:
 *   user:    ~/.config/cortexkit/magic-context.jsonc
 *   project: <root>/.cortexkit/magic-context.jsonc
 *
 * The migrator runs at plugin initialization before the loader.
 * After a legacy source is renamed to `<name>.MOVED_READPLEASE`, later runs find no source and no-op.
 * The loader never reads the `.MOVED_READPLEASE` marker.
 *
 * Config-file migration changes locations, not keys.
 * `migrate-dreamer-v2` and `migrate-experimental` rewrite keys within existing config files.
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

const CONFIG_FILE_BASENAME = "magic-context";
const MOVED_MARKER_SUFFIX = ".MOVED_READPLEASE";

function homeDir(): string {
    if (process.platform === "win32") {
        return process.env.USERPROFILE || process.env.HOME || homedir();
    }
    return process.env.HOME || homedir();
}

function configHome(): string {
    const xdg = process.env.XDG_CONFIG_HOME;
    if (xdg && isAbsolute(xdg)) return xdg;
    return join(homeDir(), ".config");
}

/** `~/.config/cortexkit/magic-context` (no extension — for detectConfigFile). */
export function cortexKitUserConfigBasePath(): string {
    return join(configHome(), "cortexkit", CONFIG_FILE_BASENAME);
}

/** `<root>/.cortexkit/magic-context` (no extension — for detectConfigFile). */
export function cortexKitProjectConfigBasePath(directory: string): string {
    return join(directory, ".cortexkit", CONFIG_FILE_BASENAME);
}

/* */
export function resolveCortexKitUserConfigPath(): string {
    return `${cortexKitUserConfigBasePath()}.jsonc`;
}

/* */
export function resolveCortexKitProjectConfigPath(directory: string): string {
    return `${cortexKitProjectConfigBasePath(directory)}.jsonc`;
}

/**
 * The single legacy-base table every consumer derives from. `userScopeConfigPaths`
 * is the guard that stops a project-scope migration from eating the user's own
 * config, so the user-scope half of this table and the migration sources must
 * stay one list: a base added to one but not the other silently escapes the
 * guard.
 */
const LEGACY_BASES: ReadonlyArray<{
    scope: "user" | "project";
    harness: "opencode" | "pi";
    base: (directory: string) => string;
    label: string;
}> = [
    {
        scope: "user",
        harness: "opencode",
        base: () => join(configHome(), "opencode", CONFIG_FILE_BASENAME),
        label: "OpenCode user",
    },
    {
        scope: "user",
        harness: "pi",
        base: () => join(homeDir(), ".pi", "agent", CONFIG_FILE_BASENAME),
        label: "Pi user",
    },
    // The bare project-root `<root>/magic-context.*` was OpenCode-only historically.
    {
        scope: "project",
        harness: "opencode",
        base: (directory) => join(directory, CONFIG_FILE_BASENAME),
        label: "project root",
    },
    {
        scope: "project",
        harness: "opencode",
        base: (directory) => join(directory, ".opencode", CONFIG_FILE_BASENAME),
        label: "OpenCode project",
    },
    {
        scope: "project",
        harness: "pi",
        base: (directory) => join(directory, ".pi", CONFIG_FILE_BASENAME),
        label: "Pi project",
    },
];

function legacySourcesForBase(basePath: string, label: string): LegacyConfigSource[] {
    return [
        { path: `${basePath}.jsonc`, label: `${label} magic-context.jsonc` },
        { path: `${basePath}.json`, label: `${label} magic-context.json` },
    ];
}

/** Legacy sources from the table, filtered by scope and owning harness. */
function legacyBaseSources(
    scope: "user" | "project",
    harness: ConfigHarness | "any",
    directory: string,
): LegacyConfigSource[] {
    return LEGACY_BASES.filter(
        (entry) => entry.scope === scope && (harness === "any" || entry.harness === harness),
    ).flatMap((entry) => legacySourcesForBase(entry.base(directory), entry.label));
}

/**
 * `userScopeConfigPaths` contains CortexKit user targets and user legacy sources; project migrations must not move them.
 */
function userScopeConfigPaths(): Set<string> {
    return new Set<string>([
        // Include both target extensions so a bare-root project source cannot match `~/.config/cortexkit/magic-context.json`.
        `${cortexKitUserConfigBasePath()}.jsonc`,
        `${cortexKitUserConfigBasePath()}.json`,
        ...LEGACY_BASES.filter((entry) => entry.scope === "user").flatMap((entry) => [
            `${entry.base("")}.jsonc`,
            `${entry.base("")}.json`,
        ]),
    ]);
}

/**
 * The bare-root project source (`<root>/magic-context.*`) must be included to migrate repo-root configs.
 *
 * `userScopeConfigPaths` prevents a project rooted at the user config directory from treating user config as a project source.
 * The user-scope filter prevents project migration from moving a user-scope config into `<root>/.cortexkit/`.
 */
export function resolveLegacyConfigSources(directory: string): {
    user: LegacyConfigSource[];
    project: LegacyConfigSource[];
} {
    const userPaths = userScopeConfigPaths();
    return {
        user: legacyBaseSources("user", "any", directory),
        project: legacyBaseSources("project", "any", directory).filter(
            (source) => !userPaths.has(source.path),
        ),
    };
}

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
 *
 * Project sources carry the same user-scope filter as
 * `resolveLegacyConfigSources`: when the project directory IS the user config
 * home, the bare-root project source resolves to the USER config file, and
 * reading it as a project config would strip user-tier fields and warn.
 */
export function resolveLegacyConfigSourcesForHarness(
    directory: string,
    harness: ConfigHarness,
): { user: LegacyConfigSource[]; project: LegacyConfigSource[] } {
    const userPaths = userScopeConfigPaths();
    return {
        user: legacyBaseSources("user", harness, directory),
        project: legacyBaseSources("project", harness, directory).filter(
            (source) => !userPaths.has(source.path),
        ),
    };
}

// The migration compares JSONC values semantically.
// A legacy source that semantically MATCHES an existing target is moved aside
// A differing legacy source triggers a warning; migration never overwrites the target.
// Semantic comparison ignores comments, trailing commas, formatting, and key order.

function sortJson(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortJson);
    if (value && typeof value === "object") {
        const sorted: Record<string, unknown> = {};
        for (const key of Object.keys(value as Record<string, unknown>).sort()) {
            sorted[key] = sortJson((value as Record<string, unknown>)[key]);
        }
        return sorted;
    }
    return value;
}

function normalizedJsoncSemantics(content: string): string {
    return JSON.stringify(sortJson(JSON.parse(stripTrailingCommas(stripJsonComments(content)))));
}

function fileSemanticsMatch(a: string, b: string): boolean {
    try {
        return normalizedJsoncSemantics(a) === normalizedJsoncSemantics(b);
    } catch {
        // If either side cannot be parsed, compare the files byte-for-byte.
        // A malformed legacy file that differs byte-for-byte is treated as a conflict.
        return a === b;
    }
}

// Desktop instances use a cross-process lock because they can migrate concurrently.

// Locks older than the stale threshold are reclaimed.
const CONFIG_LOCK_STALE_MS = 4_000;

/**
 * `mkdir` atomically creates the lock directory; EEXIST indicates that the lock path already exists.
 * A live competing lock holder causes migration to return `null` immediately.
 * After reclaiming a stale lock directory, retry `mkdir` once.
 * Lock contention returns `null` without waiting.
 */
function acquireConfigMigrationLock(lockDir: string): (() => void) | null {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            mkdirSync(lockDir, { recursive: false });
            return () => {
                try {
                    rmSync(lockDir, { recursive: true, force: true });
                } catch {
                    // Lock-cleanup failures do not affect migration.
                }
            };
        } catch (err) {
            const code = (err as { code?: unknown })?.code;
            if (code !== "EEXIST") throw err;
            try {
                const ageMs = Date.now() - statSync(lockDir).mtimeMs;
                if (ageMs > CONFIG_LOCK_STALE_MS) {
                    rmSync(lockDir, { recursive: true, force: true });
                    continue;
                }
            } catch {
                // On the first attempt, retry `mkdir` if lock inspection or removal fails.
                continue;
            }
            return null;
        }
    }
    return null;
}

function atomicCopyConfigFile(sourcePath: string, targetPath: string): void {
    mkdirSync(dirname(targetPath), { recursive: true });
    const tmpPath = join(
        dirname(targetPath),
        `.${basename(targetPath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
    );
    let fd: number | null = null;
    try {
        fd = openSync(tmpPath, "wx", 0o600);
        writeFileSync(fd, readFileSync(sourcePath));
        closeSync(fd);
        fd = null;
        renameSync(tmpPath, targetPath);
    } catch (err) {
        if (fd !== null) {
            try {
                closeSync(fd);
            } catch {}
        }
        try {
            unlinkSync(tmpPath);
        } catch {}
        throw err;
    }
}

function atomicWriteConfigFile(targetPath: string, content: string): void {
    mkdirSync(dirname(targetPath), { recursive: true });
    const tmpPath = join(
        dirname(targetPath),
        `.${basename(targetPath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
    );
    let fd: number | null = null;
    try {
        fd = openSync(tmpPath, "wx", 0o600);
        writeFileSync(fd, content);
        closeSync(fd);
        fd = null;
        renameSync(tmpPath, targetPath);
    } catch (err) {
        if (fd !== null) {
            try {
                closeSync(fd);
            } catch {}
        }
        try {
            unlinkSync(tmpPath);
        } catch {}
        throw err;
    }
}

function movedMarkerContent(
    targetPath: string,
    originalName: string,
    originalContent: string,
): string {
    const header = [
        "// Magic Context configuration moved.",
        "//",
        "// Magic Context now reads its configuration from one shared CortexKit",
        "// location instead of a per-agent path. The settings that were in this",
        "// file have been moved to:",
        "//",
        `//     ${targetPath}`,
        "//",
        "// Edit that file to change Magic Context settings. This location is no",
        "// longer read by Magic Context.",
        "//",
        `// To undo, rename this file back to "${originalName}" (and remove the`,
        "// CortexKit copy above if you want this location to take precedence).",
        "//",
        "// Your original settings are preserved below for reference.",
        "",
        "",
    ].join("\n");
    return `${header}${originalContent}`;
}

/**
 */
function markLegacySourcesMovedAside(
    sources: readonly { path: string }[],
    targetPath: string,
    logger?: ConfigMigrationLogger,
): string[] {
    const warnings: string[] = [];
    const info = logger?.info ?? logger?.log;
    for (const source of sources) {
        const markerPath = `${source.path}${MOVED_MARKER_SUFFIX}`;
        try {
            const original = readFileSync(source.path, "utf-8");
            atomicWriteConfigFile(
                markerPath,
                movedMarkerContent(targetPath, basename(source.path), original),
            );
            unlinkSync(source.path);
            info?.(
                `Moved legacy Magic Context config ${source.path} aside to ${markerPath}; now reading ${targetPath}`,
            );
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            warnings.push(
                `Magic Context could not move legacy config ${source.path} aside (${msg}); it is now stale and ignored. Delete it manually — config is read from ${targetPath}.`,
            );
            logger?.warn?.(
                `Could not move legacy Magic Context config ${source.path} aside (${msg}); reading ${targetPath}`,
            );
        }
    }
    return warnings;
}

function visibleConfigMigrationWarning(
    scope: "user" | "project",
    targetPath: string,
    paths: readonly string[],
    reason: string,
): string {
    const uniquePaths = [...new Set([targetPath, ...paths])];
    return (
        `Magic Context ${scope} config migration refused: ${reason}. ` +
        `Legacy and CortexKit config paths collapse to one file, but Magic Context will not overwrite or merge them automatically. ` +
        `Please consolidate manually into ${targetPath}. Paths: ${uniquePaths.join(" ; ")}`
    );
}

export function migrateConfigFile(opts: ConfigFileMigrationOptions): ConfigFileMigrationResult {
    const warnings: string[] = [];
    const existingSources = opts.legacySources.filter((source) => existsSync(source.path));
    const info = opts.logger?.info ?? opts.logger?.log;

    if (existingSources.length === 0) {
        return { migrated: false, conflict: false, targetPath: opts.targetPath, warnings };
    }

    mkdirSync(dirname(opts.targetPath), { recursive: true });
    const release = acquireConfigMigrationLock(`${opts.targetPath}.lock`);
    if (!release) {
        warnings.push(
            `Config migration for ${opts.scope} skipped this run (another instance is migrating); will retry on next start.`,
        );
        return { migrated: false, conflict: false, targetPath: opts.targetPath, warnings };
    }
    try {
        const sources = existingSources.map((source) => ({
            ...source,
            content: readFileSync(source.path, "utf-8"),
        }));

        if (existsSync(opts.targetPath)) {
            const targetContent = readFileSync(opts.targetPath, "utf-8");
            const differing = sources.filter(
                (source) => !fileSemanticsMatch(source.content, targetContent),
            );
            if (differing.length > 0) {
                const message = visibleConfigMigrationWarning(
                    opts.scope,
                    opts.targetPath,
                    differing.map((source) => source.path),
                    "the CortexKit target already exists with different settings",
                );
                warnings.push(message);
                opts.logger?.warn?.(message);
                return { migrated: false, conflict: true, targetPath: opts.targetPath, warnings };
            }
            info?.(
                `Magic Context ${opts.scope} config already present at ${opts.targetPath}; legacy copies match`,
            );
            warnings.push(...markLegacySourcesMovedAside(sources, opts.targetPath, opts.logger));
            return { migrated: false, conflict: false, targetPath: opts.targetPath, warnings };
        }

        const first = sources[0];
        const differing = sources.filter(
            (source) => !fileSemanticsMatch(source.content, first.content),
        );
        if (differing.length > 0) {
            const message = visibleConfigMigrationWarning(
                opts.scope,
                opts.targetPath,
                sources.map((source) => source.path),
                "multiple legacy sources have different settings",
            );
            warnings.push(message);
            opts.logger?.warn?.(message);
            return { migrated: false, conflict: true, targetPath: opts.targetPath, warnings };
        }

        atomicCopyConfigFile(first.path, opts.targetPath);
        info?.(
            `Migrated Magic Context ${opts.scope} config from ${first.path} to ${opts.targetPath}`,
        );
        warnings.push(...markLegacySourcesMovedAside(sources, opts.targetPath, opts.logger));
        return {
            migrated: true,
            conflict: false,
            sourcePath: first.path,
            targetPath: opts.targetPath,
            warnings,
        };
    } catch (err) {
        const message = visibleConfigMigrationWarning(
            opts.scope,
            opts.targetPath,
            existingSources.map((source) => source.path),
            `migration failed (${err instanceof Error ? err.message : String(err)})`,
        );
        warnings.push(message);
        opts.logger?.warn?.(message);
        return { migrated: false, conflict: true, targetPath: opts.targetPath, warnings };
    } finally {
        release();
    }
}

/**
 */
export function migrateMagicContextConfigLocations(
    directory: string,
    logger?: ConfigMigrationLogger,
): string[] {
    const warnings: string[] = [];
    const legacy = resolveLegacyConfigSources(directory);
    try {
        warnings.push(
            ...migrateConfigFile({
                scope: "user",
                targetPath: resolveCortexKitUserConfigPath(),
                legacySources: legacy.user,
                logger,
            }).warnings,
        );
        warnings.push(
            ...migrateConfigFile({
                scope: "project",
                targetPath: resolveCortexKitProjectConfigPath(directory),
                legacySources: legacy.project,
                logger,
            }).warnings,
        );
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger?.warn?.(`Magic Context config-location migration error (continuing): ${msg}`);
        warnings.push(`Magic Context config-location migration error: ${msg}`);
    }
    return warnings;
}
