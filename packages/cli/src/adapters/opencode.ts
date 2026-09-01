import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, parse as parsePath, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc, stringify as stringifyJsonc } from "comment-json";
import { writeFileAtomic } from "../lib/atomic-write";
import { ensureParentDir } from "../lib/fs-utils";
import { detectOpenCode } from "../lib/opencode-detect";
import {
    getOpenCodePluginPackageJsonPaths,
    OPENCODE_PLUGIN_ENTRY_WITH_VERSION as PLUGIN_ENTRY,
    OPENCODE_PLUGIN_NAME as PLUGIN_NAME,
} from "../lib/opencode-plugin-cache";
import {
    detectConfigPaths,
    dirSizeBytes,
    getMagicContextLogPath,
    getOpenCodePluginCacheDir,
} from "../lib/paths";
import type {
    HarnessAdapter,
    HarnessConfigPaths,
    PluginCacheInfo,
    PluginEntryResult,
} from "./types";

export class OpenCodeAdapter implements HarnessAdapter {
    readonly kind = "opencode" as const;
    readonly displayName = "OpenCode";
    readonly pluginPackageName = PLUGIN_NAME;

    isInstalled(): boolean {
        // A Desktop-only install (no CLI on PATH) still counts as installed:
        // OpenCode Desktop ships no invocable `opencode` binary, so a binary
        // check alone would wrongly report OpenCode as absent.
        return detectOpenCode().kind !== "none";
    }

    hasPluginEntry(): boolean {
        const paths = detectConfigPaths();
        if (paths.opencodeConfigFormat === "none") return false;
        try {
            const raw = readFileSync(paths.opencodeConfig, "utf-8");
            const cfg = parseJsonc(raw) as Record<string, unknown> | null;
            const plugin = cfg?.plugin;
            if (!Array.isArray(plugin)) return false;
            return plugin.some((entry) => matchesPluginEntry(entry, PLUGIN_NAME));
        } catch {
            return false;
        }
    }

    getConfigPaths(): HarnessConfigPaths {
        const paths = detectConfigPaths();
        return {
            configDir: paths.configDir,
            pluginConfigPath: paths.opencodeConfig,
            magicContextConfigPath: paths.magicContextConfig,
            secondaryConfigPath: paths.tuiConfig,
        };
    }

    async ensurePluginEntry(): Promise<PluginEntryResult> {
        const paths = detectConfigPaths();
        const target = paths.opencodeConfig;
        try {
            const exists = paths.opencodeConfigFormat !== "none";
            if (!exists) {
                const initial = {
                    $schema: "https://opencode.ai/config.json",
                    plugin: [PLUGIN_ENTRY],
                };
                ensureParentDir(target);
                writeFileAtomic(target, `${JSON.stringify(initial, null, 4)}\n`);
                return {
                    ok: true,
                    action: "added",
                    message: `Created ${target} with plugin entry.`,
                    configPath: target,
                };
            }

            const raw = readFileSync(target, "utf-8");
            const cfg = parseJsonc(raw) as Record<string, unknown> | null;
            if (cfg === null || typeof cfg !== "object") {
                return {
                    ok: false,
                    action: "error",
                    message: `Could not parse ${target}.`,
                    configPath: target,
                };
            }

            const plugin = Array.isArray(cfg.plugin) ? cfg.plugin : [];
            const existingIdx = plugin.findIndex((e) => matchesPluginEntry(e, PLUGIN_NAME));
            const existingDevIdx = plugin.findIndex((e) => isDevPathPluginEntry(e));

            // Local dev-path entries are recognized so we don't double-add
            // an @latest entry on top, but they are NEVER replaced by setup.
            if (existingIdx === -1 && existingDevIdx === -1) {
                plugin.push(PLUGIN_ENTRY);
                cfg.plugin = plugin;
                writeFileAtomic(target, `${stringifyJsonc(cfg, null, 4)}\n`);
                return {
                    ok: true,
                    action: "added",
                    message: `Added ${PLUGIN_ENTRY} to ${target}.`,
                    configPath: target,
                };
            }

            if (existingDevIdx !== -1) {
                const devEntry = String(plugin[existingDevIdx]);
                return {
                    ok: true,
                    action: "already_present",
                    message: `Plugin already present (dev path: ${devEntry}) in ${target}.`,
                    configPath: target,
                };
            }

            const current = plugin[existingIdx];
            if (typeof current === "string" && current !== PLUGIN_ENTRY) {
                plugin[existingIdx] = PLUGIN_ENTRY;
                cfg.plugin = plugin;
                writeFileAtomic(target, `${stringifyJsonc(cfg, null, 4)}\n`);
                return {
                    ok: true,
                    action: "updated",
                    message: `Updated plugin entry to ${PLUGIN_ENTRY} in ${target}.`,
                    configPath: target,
                };
            }

            return {
                ok: true,
                action: "already_present",
                message: `Plugin entry already present in ${target}.`,
                configPath: target,
            };
        } catch (err) {
            return {
                ok: false,
                action: "error",
                message: `Failed to update ${target}: ${(err as Error).message}`,
                configPath: target,
            };
        }
    }

    async removePluginEntry(): Promise<PluginEntryResult> {
        const paths = detectConfigPaths();
        const target = paths.opencodeConfig;
        if (paths.opencodeConfigFormat === "none") {
            return {
                ok: true,
                action: "already_present",
                message: `No ${target} to remove from.`,
                configPath: target,
            };
        }
        try {
            const raw = readFileSync(target, "utf-8");
            const cfg = parseJsonc(raw) as Record<string, unknown> | null;
            if (cfg === null || typeof cfg !== "object" || !Array.isArray(cfg.plugin)) {
                return {
                    ok: true,
                    action: "already_present",
                    message: `No plugin array in ${target}.`,
                    configPath: target,
                };
            }
            const pluginArr = cfg.plugin as unknown[];
            const before = pluginArr.length;
            cfg.plugin = pluginArr.filter((e) => !matchesPluginEntry(e, PLUGIN_NAME));
            if ((cfg.plugin as unknown[]).length === before) {
                return {
                    ok: true,
                    action: "already_present",
                    message: `Plugin entry not present in ${target}.`,
                    configPath: target,
                };
            }
            writeFileAtomic(target, `${stringifyJsonc(cfg, null, 4)}\n`);
            return {
                ok: true,
                action: "updated",
                message: `Removed ${PLUGIN_NAME} from ${target}.`,
                configPath: target,
            };
        } catch (err) {
            return {
                ok: false,
                action: "error",
                message: `Failed to update ${target}: ${(err as Error).message}`,
                configPath: target,
            };
        }
    }

    getInstallHint(): string {
        return "Install OpenCode: curl -fsSL https://opencode.ai/install | bash";
    }

    getPluginCacheInfo(): PluginCacheInfo {
        const path = getOpenCodePluginCacheDir();
        return {
            path,
            exists: existsSync(path),
            sizeBytes: dirSizeBytes(path),
        };
    }

    getLogPath(): string {
        return getMagicContextLogPath("opencode");
    }

    getInstalledPluginVersion(): string | null {
        for (const candidate of getOpenCodePluginPackageJsonPaths()) {
            if (!existsSync(candidate)) continue;
            try {
                const raw = readFileSync(candidate, "utf-8");
                const pkg = JSON.parse(raw) as { version?: string };
                if (typeof pkg.version === "string") return pkg.version;
            } catch {
                // try next
            }
        }
        return null;
    }
}

export function isLocalPathPluginEntry(entry: unknown): boolean {
    const candidate =
        typeof entry === "string"
            ? entry
            : Array.isArray(entry) && typeof entry[0] === "string"
              ? entry[0]
              : null;
    if (!candidate) return false;
    return (
        candidate.startsWith("file://") ||
        isAbsolute(candidate) ||
        candidate.startsWith("./") ||
        candidate.startsWith("../")
    );
}

/**
 * Match a local plugin entry only when its nearest package.json identifies the
 * OpenCode Magic Context package. A basename substring is not sufficient: paths
 * such as `magic-context-theme` must not suppress the real plugin registration.
 */
export function isDevPathPluginEntry(entry: unknown): boolean {
    const candidate =
        typeof entry === "string"
            ? entry
            : Array.isArray(entry) && typeof entry[0] === "string"
              ? entry[0]
              : null;
    if (!candidate || !isLocalPathPluginEntry(entry)) return false;

    let localPath: string;
    try {
        if (candidate.startsWith("file://")) {
            localPath = fileURLToPath(candidate);
        } else {
            localPath = resolve(candidate);
        }

        if (statSync(localPath).isFile()) localPath = dirname(localPath);
        const root = parsePath(localPath).root;
        while (localPath !== root) {
            const packagePath = resolve(localPath, "package.json");
            if (existsSync(packagePath)) {
                const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { name?: unknown };
                return pkg.name === PLUGIN_NAME;
            }
            localPath = dirname(localPath);
        }
    } catch {
        // An unreadable or unresolved path cannot prove that our plugin is installed.
    }
    return false;
}

/**
 * OpenCode accepts string plugin entries with or without the `@latest` suffix.
 * OpenCode accepts tuple plugin entries whose first element is the package specifier.
 * OpenCode accepts `file://` URLs for local development checkouts.
 *
 * Package specifiers may include a version suffix.
 *
 * Returns false for `file://` entries so dev paths are not classified as
 * "the published plugin". Use `isDevPathPluginEntry` for that detection.
 *
 */
export function matchesPluginEntry(entry: unknown, pkgName: string): boolean {
    let candidate: string | null = null;
    if (typeof entry === "string") candidate = entry;
    else if (Array.isArray(entry) && typeof entry[0] === "string") candidate = entry[0];
    if (!candidate) return false;
    if (candidate.startsWith("file://")) return false;
    // The matcher uses the final `@` so scoped package names retain their scope.
    const at = candidate.lastIndexOf("@");
    const head = at > 0 ? candidate.slice(0, at) : candidate;
    return head === pkgName;
}
