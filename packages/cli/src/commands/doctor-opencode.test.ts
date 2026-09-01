import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseJsonc, stringify as stringifyJsonc } from "comment-json";
import {
    OPENCODE_PLUGIN_ENTRY_WITH_VERSION,
    OPENCODE_PLUGIN_NAME,
} from "../lib/opencode-plugin-cache";
import {
    checkUserMemoriesDreamerCompatibility,
    collectNpmReleaseAgeWarnings,
    getUserNpmrcPath,
    isPinnedOpenCodePluginSpecifier,
    migrateLegacyAgentEnabledConfigForDoctor,
} from "./doctor-opencode";
import { clearPluginCache } from "./doctor-opencode-cache";

function migrate(input: Record<string, unknown>) {
    const logs: Array<{ level: "success" | "warn"; message: string }> = [];
    const result = migrateLegacyAgentEnabledConfigForDoctor(input, {
        success: (message) => logs.push({ level: "success", message }),
        warn: (message) => logs.push({ level: "warn", message }),
    });
    return { config: input, logs, result };
}

describe("doctor OpenCode legacy agent enabled migration", () => {
    it("migrates legacy enabled fields with conflict rules and warning text", () => {
        const { config, logs, result } = migrate({
            dreamer: { enabled: false, disable: false },
            sidekick: { enabled: true, disable: true },
            historian: { enabled: true, disable: true },
        });

        expect(result).toEqual({ changed: true, fixes: 3 });
        expect(config).toEqual({
            dreamer: { disable: true },
            sidekick: { disable: true },
            historian: { disable: true },
        });
        expect(logs).toContainEqual({
            level: "warn",
            message:
                "Migrated dreamer.enabled=false → dreamer.disable=true. This now also disables manual /ctx-dream. To keep manual dreaming, remove disable=true and set schedule to empty string.",
        });
        expect(logs.map((entry) => entry.message)).toContain(
            "Removed deprecated sidekick.enabled (use sidekick.disable=true to turn off Sidekick).",
        );
        expect(logs.map((entry) => entry.message)).toContain(
            "Removed invalid historian.enabled (historian uses disable=true to turn off).",
        );
    });

    it("removes enabled=true without adding disable=false and is idempotent", () => {
        const first = migrate({ dreamer: { enabled: true }, sidekick: { enabled: false } });
        expect(first.config).toEqual({ dreamer: {}, sidekick: { disable: true } });

        const second = migrate(first.config);
        expect(second.result).toEqual({ changed: false, fixes: 0 });
        expect(second.logs).toEqual([]);
    });

    it("round-trips migrated config through JSONC serialization", () => {
        const config = parseJsonc(
            '{ "dreamer": { "enabled": false }, "sidekick": { "enabled": false } }',
        ) as Record<string, unknown>;
        migrateLegacyAgentEnabledConfigForDoctor(config, { success: () => {}, warn: () => {} });
        const serialized = stringifyJsonc(config, null, 2);

        expect(serialized).toContain('"disable": true');
        expect(serialized).not.toContain('"enabled"');
    });
});

describe("checkUserMemoriesDreamerCompatibility", () => {
    const WARNING =
        'dreamer.tasks["review-user-memories"] is scheduled but dreamer.disable=true, so new promotions will not run. Remove dreamer.disable or set dreamer.tasks["review-user-memories"].schedule="" to disable the task.';

    it("warns when review-user-memories is scheduled and dreamer.disable=true", () => {
        const result = checkUserMemoriesDreamerCompatibility({
            dreamer: {
                disable: true,
                tasks: { "review-user-memories": { schedule: "0 2 * * *" } },
            },
        });
        expect(result).toBe(WARNING);
    });

    it("returns null when dreamer is not disabled", () => {
        const result = checkUserMemoriesDreamerCompatibility({
            dreamer: {
                disable: false,
                tasks: { "review-user-memories": { schedule: "0 2 * * *" } },
            },
        });
        expect(result).toBeNull();
    });

    it("returns null when review-user-memories schedule is empty", () => {
        const result = checkUserMemoriesDreamerCompatibility({
            dreamer: {
                disable: true,
                tasks: { "review-user-memories": { schedule: "" } },
            },
        });
        expect(result).toBeNull();
    });

    it("returns null when review-user-memories schedule is whitespace-only", () => {
        const result = checkUserMemoriesDreamerCompatibility({
            dreamer: {
                disable: true,
                tasks: { "review-user-memories": { schedule: "   " } },
            },
        });
        expect(result).toBeNull();
    });

    it("returns null when review-user-memories task is absent", () => {
        const result = checkUserMemoriesDreamerCompatibility({
            dreamer: { disable: true, tasks: { verify: { schedule: "0 2 * * *" } } },
        });
        expect(result).toBeNull();
    });

    it("returns null when dreamer block is absent", () => {
        expect(checkUserMemoriesDreamerCompatibility({})).toBeNull();
    });

    it("returns null when tasks block is absent (legacy v1 shape without user_memories)", () => {
        const result = checkUserMemoriesDreamerCompatibility({
            dreamer: { disable: true },
        });
        expect(result).toBeNull();
    });

    it("does not read legacy dreamer.user_memories (v1 key, migrated away in v2)", () => {
        const result = checkUserMemoriesDreamerCompatibility({
            dreamer: {
                disable: true,
                user_memories: { enabled: true },
            },
        });
        expect(result).toBeNull();
    });
});

const tempDirs: string[] = [];
let originalXdgCacheHome: string | undefined;
let originalHome: string | undefined;
let originalNpmUserConfig: string | undefined;

function makeTempDir(prefix = "mc-v22-doctor-"): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

afterEach(() => {
    if (originalXdgCacheHome === undefined) {
        delete process.env.XDG_CACHE_HOME;
    } else {
        process.env.XDG_CACHE_HOME = originalXdgCacheHome;
    }
    if (originalHome === undefined) {
        delete process.env.HOME;
    } else {
        process.env.HOME = originalHome;
    }
    if (originalNpmUserConfig === undefined) {
        delete process.env.NPM_CONFIG_USERCONFIG;
    } else {
        process.env.NPM_CONFIG_USERCONFIG = originalNpmUserConfig;
    }
    originalXdgCacheHome = undefined;
    originalHome = undefined;
    originalNpmUserConfig = undefined;
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function createCachedOpenCodePlugin(
    root: string,
    version: string,
    entry = OPENCODE_PLUGIN_ENTRY_WITH_VERSION,
): string {
    const pluginCachePath = join(root, "opencode", "packages", entry);
    const installedPackagePath = join(
        pluginCachePath,
        "node_modules",
        "@cortexkit",
        "opencode-magic-context",
        "package.json",
    );
    mkdirSync(dirname(installedPackagePath), { recursive: true });
    writeFileSync(installedPackagePath, `${JSON.stringify({ version })}\n`);
    return pluginCachePath;
}

describe("doctor OpenCode plugin cache", () => {
    it("clears stale @latest cache when cached plugin is older than npm latest", async () => {
        const cacheRoot = makeTempDir("mc-opencode-cache-");
        originalXdgCacheHome = process.env.XDG_CACHE_HOME;
        process.env.XDG_CACHE_HOME = cacheRoot;
        const pluginCachePath = createCachedOpenCodePlugin(cacheRoot, "0.26.0");

        const result = await clearPluginCache({ latestVersion: "0.29.1" });

        expect(result).toMatchObject({
            action: "cleared",
            cached: "0.26.0",
            latest: "0.29.1",
            path: pluginCachePath,
        });
        expect(existsSync(pluginCachePath)).toBe(false);
    });

    it("keeps @latest cache when cached plugin matches npm latest", async () => {
        const cacheRoot = makeTempDir("mc-opencode-cache-");
        originalXdgCacheHome = process.env.XDG_CACHE_HOME;
        process.env.XDG_CACHE_HOME = cacheRoot;
        const pluginCachePath = createCachedOpenCodePlugin(cacheRoot, "0.29.1");

        const result = await clearPluginCache({ latestVersion: "0.29.1" });

        expect(result).toMatchObject({
            action: "up_to_date",
            cached: "0.29.1",
            latest: "0.29.1",
            path: pluginCachePath,
        });
        expect(existsSync(pluginCachePath)).toBe(true);
    });

    it("clears stale versionless cache even when @latest cache is current", async () => {
        const cacheRoot = makeTempDir("mc-opencode-cache-");
        originalXdgCacheHome = process.env.XDG_CACHE_HOME;
        process.env.XDG_CACHE_HOME = cacheRoot;
        const latestCachePath = createCachedOpenCodePlugin(cacheRoot, "0.29.1");
        const versionlessCachePath = createCachedOpenCodePlugin(
            cacheRoot,
            "0.26.0",
            OPENCODE_PLUGIN_NAME,
        );

        const result = await clearPluginCache({ latestVersion: "0.29.1" });

        expect(result).toMatchObject({
            action: "cleared",
            cached: "0.26.0",
            latest: "0.29.1",
            path: versionlessCachePath,
            paths: [versionlessCachePath],
        });
        expect(existsSync(latestCachePath)).toBe(true);
        expect(existsSync(versionlessCachePath)).toBe(false);
    });

    it("preserves existing cache when plugin npm latest is unavailable", async () => {
        const cacheRoot = makeTempDir("mc-opencode-cache-");
        originalXdgCacheHome = process.env.XDG_CACHE_HOME;
        process.env.XDG_CACHE_HOME = cacheRoot;
        const pluginCachePath = createCachedOpenCodePlugin(cacheRoot, "0.29.1");

        const result = await clearPluginCache({ latestVersion: null });

        expect(result).toMatchObject({
            action: "check_unavailable",
            cached: "0.29.1",
            path: pluginCachePath,
            paths: [pluginCachePath],
        });
        expect(result.latest).toBeUndefined();
        expect(existsSync(pluginCachePath)).toBe(true);
    });

    it("force-clears existing cache even when plugin npm latest is unavailable", async () => {
        const cacheRoot = makeTempDir("mc-opencode-cache-");
        originalXdgCacheHome = process.env.XDG_CACHE_HOME;
        process.env.XDG_CACHE_HOME = cacheRoot;
        const pluginCachePath = createCachedOpenCodePlugin(cacheRoot, "0.29.1");

        const result = await clearPluginCache({ force: true, latestVersion: null });

        expect(result).toMatchObject({
            action: "cleared",
            cached: "0.29.1",
            path: pluginCachePath,
            paths: [pluginCachePath],
        });
        expect(result.latest).toBeUndefined();
        expect(existsSync(pluginCachePath)).toBe(false);
    });

    it("reports the actually-failed root and clears the rest when one root fails", async () => {
        const cacheRoot = makeTempDir("mc-opencode-cache-");
        originalXdgCacheHome = process.env.XDG_CACHE_HOME;
        process.env.XDG_CACHE_HOME = cacheRoot;
        const latestCachePath = createCachedOpenCodePlugin(cacheRoot, "0.26.0");
        const versionlessCachePath = createCachedOpenCodePlugin(
            cacheRoot,
            "0.26.0",
            OPENCODE_PLUGIN_NAME,
        );

        // When the second root removal fails, clearPluginCache still removes the first root.
        // clearPluginCache reports the failed root, not the root removed before the failure.
        const removed: string[] = [];
        const result = await clearPluginCache(
            { latestVersion: "0.29.1" },
            {
                remove: (path) => {
                    if (path === versionlessCachePath) {
                        throw new Error("EACCES: permission denied");
                    }
                    rmSync(path, { recursive: true, force: true });
                    removed.push(path);
                },
            },
        );

        expect(result).toMatchObject({
            action: "error",
            path: versionlessCachePath,
            paths: [versionlessCachePath],
            clearedPaths: [latestCachePath],
            failedPaths: [versionlessCachePath],
            error: "EACCES: permission denied",
        });
        expect(removed).toEqual([latestCachePath]);
        expect(existsSync(latestCachePath)).toBe(false);
    });
});

describe("doctor OpenCode helper logic", () => {
    it("treats dist-tags like @next and @beta as pinned plugin entries", () => {
        expect(isPinnedOpenCodePluginSpecifier("@cortexkit/opencode-magic-context@next")).toBe(
            true,
        );
        expect(isPinnedOpenCodePluginSpecifier("@cortexkit/opencode-magic-context@beta")).toBe(
            true,
        );
        expect(isPinnedOpenCodePluginSpecifier("@cortexkit/opencode-magic-context@0.29.1")).toBe(
            true,
        );
        expect(isPinnedOpenCodePluginSpecifier("@cortexkit/opencode-magic-context")).toBe(false);
        expect(isPinnedOpenCodePluginSpecifier("@cortexkit/opencode-magic-context@latest")).toBe(
            false,
        );
    });

    it("honors NPM_CONFIG_USERCONFIG before HOME for npmrc release-age warnings", () => {
        const root = makeTempDir("mc-npmrc-");
        const home = join(root, "home");
        const customNpmrc = join(root, "custom.npmrc");
        originalHome = process.env.HOME;
        originalNpmUserConfig = process.env.NPM_CONFIG_USERCONFIG;
        process.env.HOME = home;
        process.env.NPM_CONFIG_USERCONFIG = customNpmrc;
        mkdirSync(home, { recursive: true });
        writeFileSync(join(home, ".npmrc"), "min-release-age=9999\n");
        writeFileSync(customNpmrc, "before=2026-01-01\n");

        expect(getUserNpmrcPath()).toBe(customNpmrc);
        expect(collectNpmReleaseAgeWarnings()).toEqual([`${customNpmrc} has 'before=2026-01-01'`]);
    });
});
