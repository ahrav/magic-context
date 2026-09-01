import { existsSync, readFileSync, rmSync } from "node:fs";
import {
    getOpenCodePluginCacheRoots,
    getOpenCodePluginPackageJsonPath,
} from "../lib/opencode-plugin-cache";

export interface PluginCacheResult {
    action: "cleared" | "up_to_date" | "not_found" | "check_unavailable" | "error";
    path: string;
    paths?: string[];
    clearedPaths?: string[];
    failedPaths?: string[];
    cached?: string;
    latest?: string;
    error?: string;
}

function readCachedPluginVersion(pluginCacheDir: string): string | undefined {
    try {
        const installedPkgPath = getOpenCodePluginPackageJsonPath(pluginCacheDir);
        if (!existsSync(installedPkgPath)) return undefined;
        const pkg = JSON.parse(readFileSync(installedPkgPath, "utf-8")) as { version?: unknown };
        return typeof pkg.version === "string" ? pkg.version : undefined;
    } catch {
        return undefined;
    }
}

export async function clearPluginCache(
    options: { force?: boolean; latestVersion?: string | null } = {},
    deps: { remove?: (path: string) => void } = {},
): Promise<PluginCacheResult> {
    // Injected `remove` enables deterministic tests of per-root deletion failures.
    const remove =
        deps.remove ?? ((path: string) => rmSync(path, { recursive: true, force: true }));
    const pluginCacheRoots = getOpenCodePluginCacheRoots();
    const existingRoots = pluginCacheRoots.filter((root) => existsSync(root));

    if (existingRoots.length === 0) {
        return { action: "not_found", path: pluginCacheRoots[0] ?? "" };
    }

    const latestVersion = options.latestVersion ?? undefined;
    const cacheEntries = existingRoots.map((path) => ({
        path,
        cached: readCachedPluginVersion(path),
    }));

    if (options.force !== true && latestVersion === undefined) {
        const firstEntry = cacheEntries[0];
        return {
            action: "check_unavailable",
            path: firstEntry?.path ?? pluginCacheRoots[0] ?? "",
            paths: cacheEntries.map((entry) => entry.path),
            cached: firstEntry?.cached,
        };
    }

    const clearTargets = cacheEntries.filter(
        (entry) =>
            options.force === true || entry.cached === undefined || entry.cached !== latestVersion,
    );

    if (clearTargets.length === 0) {
        const firstEntry = cacheEntries[0];
        return {
            action: "up_to_date",
            path: firstEntry?.path ?? pluginCacheRoots[0] ?? "",
            paths: cacheEntries.map((entry) => entry.path),
            cached: firstEntry?.cached,
            latest: latestVersion,
        };
    }

    const cleared: typeof clearTargets = [];
    const failed: Array<{ path: string; error: string }> = [];
    for (const entry of clearTargets) {
        try {
            remove(entry.path);
            cleared.push(entry);
        } catch (err: unknown) {
            failed.push({
                path: entry.path,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    if (failed.length > 0) {
        const firstFailure = failed[0];
        return {
            action: "error",
            path: firstFailure?.path ?? clearTargets[0]?.path ?? existingRoots[0] ?? "",
            paths: failed.map((entry) => entry.path),
            clearedPaths: cleared.map((entry) => entry.path),
            failedPaths: failed.map((entry) => entry.path),
            error: firstFailure?.error,
        };
    }

    const firstTarget = cleared[0];
    return {
        action: "cleared",
        path: firstTarget?.path ?? pluginCacheRoots[0] ?? "",
        paths: cleared.map((entry) => entry.path),
        cached: firstTarget?.cached,
        latest: latestVersion,
    };
}
