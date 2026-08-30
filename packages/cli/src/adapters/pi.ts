import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { stringify as stringifyJsonc } from "comment-json";
import { writeFileAtomic } from "../lib/atomic-write";
import { ensureParentDir } from "../lib/fs-utils";
import { readJsoncConfig, readJsoncConfigForUpdate } from "../lib/jsonc-config";
import {
    getMagicContextLogPath,
    getPiAgentDir,
    getSharedUserConfigPath,
    getPiUserExtensionsPath,
} from "../lib/paths";
import { detectPiBinary, PI_PACKAGE_SOURCE, runPiCommand } from "../lib/pi-helpers";
import { isPiMagicContextPackageEntry } from "../lib/pi-package-entry";
import type {
    HarnessAdapter,
    HarnessConfigPaths,
    PluginCacheInfo,
    PluginEntryResult,
} from "./types";

const PLUGIN_NAME = "@cortexkit/pi-magic-context";
const SETTINGS_BASENAME = "settings.json";

export class PiAdapter implements HarnessAdapter {
    readonly kind = "pi" as const;
    readonly displayName = "Pi";
    readonly pluginPackageName = PLUGIN_NAME;

    isInstalled(): boolean {
        return detectPiBinary() !== null;
    }

    hasPluginEntry(): boolean {
        const settings = readPiSettings();
        if (!settings) return false;
        const packages = (settings.packages ?? []) as unknown[];
        return packages.some((entry) => isPiMagicContextPackageEntry(entry));
    }

    getConfigPaths(): HarnessConfigPaths {
        const dir = getPiAgentDir();
        return {
            configDir: dir,
            pluginConfigPath: getPiUserExtensionsPath(),
            magicContextConfigPath: getSharedUserConfigPath(),
            secondaryConfigPath: null,
        };
    }

    async ensurePluginEntry(): Promise<PluginEntryResult> {
        const settingsPath = getPiUserExtensionsPath();
        try {
            const settings = readPiSettingsForUpdate();
            const packages = Array.isArray(settings.packages)
                ? (settings.packages as unknown[])
                : [];

            const idx = packages.findIndex((entry) => isPiMagicContextPackageEntry(entry));
            if (idx === -1) {
                packages.push(PI_PACKAGE_SOURCE);
                settings.packages = packages;
                writePiSettings(settings);
                return {
                    ok: true,
                    action: "added",
                    message: `Added ${PI_PACKAGE_SOURCE} to ${settingsPath}.`,
                    configPath: settingsPath,
                };
            }
            return {
                ok: true,
                action: "already_present",
                message: `Plugin entry already present in ${settingsPath}.`,
                configPath: settingsPath,
            };
        } catch (err) {
            return {
                ok: false,
                action: "error",
                message: `Failed to update ${settingsPath}: ${(err as Error).message}`,
                configPath: settingsPath,
            };
        }
    }

    async removePluginEntry(): Promise<PluginEntryResult> {
        const settingsPath = getPiUserExtensionsPath();
        try {
            const settings = readPiSettingsForUpdate();
            if (!Array.isArray(settings.packages)) {
                return {
                    ok: true,
                    action: "already_present",
                    message: `No packages array in ${settingsPath}.`,
                    configPath: settingsPath,
                };
            }
            const before = settings.packages.length;
            settings.packages = settings.packages.filter(
                (entry: unknown) => !isPiMagicContextPackageEntry(entry),
            );
            if (settings.packages.length === before) {
                return {
                    ok: true,
                    action: "already_present",
                    message: `Plugin entry not present in ${settingsPath}.`,
                    configPath: settingsPath,
                };
            }
            writePiSettings(settings);
            return {
                ok: true,
                action: "updated",
                message: `Removed ${PLUGIN_NAME} from ${settingsPath}.`,
                configPath: settingsPath,
            };
        } catch (err) {
            return {
                ok: false,
                action: "error",
                message: `Failed to update ${settingsPath}: ${(err as Error).message}`,
                configPath: settingsPath,
            };
        }
    }

    getInstallHint(): string {
        return "Install Pi: https://pi.coding/install (npm: @earendil-works/pi-coding-agent)";
    }

    getPluginCacheInfo(): PluginCacheInfo {
        // Pi doesn't have a separate user-level plugin cache the way OpenCode
        // does — it shells out to npm at install time. Reporting as "no cache"
        // means doctor --clear will skip Pi cleanup, which is the correct
        // behavior since there's nothing for us to safely clear.
        return { path: null, exists: false, sizeBytes: 0 };
    }

    getLogPath(): string {
        return getMagicContextLogPath("pi");
    }

    getInstalledPluginVersion(): string | null {
        // Try to ask Pi for the package version.
        const piBin = detectPiBinary();
        if (!piBin) return null;
        try {
            const output = runPiCommand(piBin.path, ["list"], 5000);
            if (output === null) return null;
            // Pi's `list` output line shape varies; look for our package name
            // followed by a version number. Conservative — return null on
            // parse failure rather than risk wrong output.
            const re = new RegExp(
                `${PLUGIN_NAME.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}.*?(\\d+\\.\\d+\\.\\d+(?:[-+][\\w.-]+)?)`,
            );
            const match = re.exec(output);
            if (match) return match[1] ?? null;
        } catch {
            // Pi binary might not support `list`, or call timed out.
        }
        return null;
    }
}

interface PiSettingsLike {
    packages?: unknown[];
    [k: string]: unknown;
}

function readPiSettings(): PiSettingsLike | null {
    const result = readJsoncConfig(getPiUserExtensionsPath());
    return result.kind === "parsed" ? (result.value as PiSettingsLike) : null;
}

function readPiSettingsForUpdate(): PiSettingsLike {
    // Missing settings may be created, but malformed settings must propagate to
    // mutation callers so they can abort without replacing user data.
    return readJsoncConfigForUpdate(getPiUserExtensionsPath()) as PiSettingsLike;
}

function writePiSettings(settings: PiSettingsLike): void {
    const settingsPath = getPiUserExtensionsPath();
    ensureParentDir(settingsPath);
    const text = stringifyJsonc(settings, null, 2);
    writeFileAtomic(settingsPath, `${text}\n`);
}

// SETTINGS_BASENAME is exported for tests that need it.
export { SETTINGS_BASENAME };
