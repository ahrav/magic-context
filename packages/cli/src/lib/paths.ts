import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { resolveCortexKitUserConfigPath } from "@magic-context/core/config/migrate-config-location";
import type { HarnessId } from "@magic-context/core/shared/harness";

// ============================================================================
// OpenCode paths
// ============================================================================

export interface ConfigPaths {
    configDir: string;
    /* */
    opencodeConfig: string;
    opencodeConfigFormat: "json" | "jsonc" | "none";
    magicContextConfig: string;
    /* */
    omoConfig: string | null;
    tuiConfig: string;
    tuiConfigFormat: "json" | "jsonc" | "none";
}

/**
 *
 */
export function getOpenCodeConfigDir(): string {
    const envDir = process.env.OPENCODE_CONFIG_DIR?.trim();
    if (envDir) return envDir;
    if (process.platform === "win32") {
        return join(homedir(), ".config", "opencode");
    }
    const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
    return join(xdgConfig, "opencode");
}

function findOmoConfig(configDir: string): string | null {
    const locations = [
        join(configDir, "oh-my-openagent.jsonc"),
        join(configDir, "oh-my-openagent.json"),
        join(configDir, "oh-my-opencode.jsonc"),
        join(configDir, "oh-my-opencode.json"),
    ];
    for (const loc of locations) {
        if (existsSync(loc)) return loc;
    }
    return null;
}

export function detectConfigPaths(): ConfigPaths {
    const configDir = getOpenCodeConfigDir();

    let opencodeConfig: string;
    let opencodeConfigFormat: "json" | "jsonc" | "none";
    let tuiConfig: string;
    let tuiConfigFormat: "json" | "jsonc" | "none";

    const jsoncPath = join(configDir, "opencode.jsonc");
    const jsonPath = join(configDir, "opencode.json");
    if (existsSync(jsoncPath)) {
        opencodeConfig = jsoncPath;
        opencodeConfigFormat = "jsonc";
    } else if (existsSync(jsonPath)) {
        opencodeConfig = jsonPath;
        opencodeConfigFormat = "json";
    } else {
        // New installations use JSONC so users can add comments without later creating a higher-precedence config.
        opencodeConfig = jsoncPath;
        opencodeConfigFormat = "none";
    }

    const tuiJsoncPath = join(configDir, "tui.jsonc");
    const tuiJsonPath = join(configDir, "tui.json");
    if (existsSync(tuiJsoncPath)) {
        // OpenCode gives tui.jsonc precedence over tui.json, so write to an existing tui.jsonc.
        tuiConfig = tuiJsoncPath;
        tuiConfigFormat = "jsonc";
    } else if (existsSync(tuiJsonPath)) {
        tuiConfig = tuiJsonPath;
        tuiConfigFormat = "json";
    } else {
        // New installations use tui.jsonc so users can add comments without later creating a higher-precedence tui.jsonc.
        tuiConfig = tuiJsoncPath;
        tuiConfigFormat = "none";
    }

    return {
        configDir,
        opencodeConfig,
        opencodeConfigFormat,
        magicContextConfig: resolveCortexKitUserConfigPath(),
        omoConfig: findOmoConfig(configDir),
        tuiConfig,
        tuiConfigFormat,
    };
}

// ============================================================================
// Pi paths
// ============================================================================

function envFirstHomeDir(): string {
    const home = process.env.HOME?.trim();
    return home || homedir();
}

/* */
export function getPiAgentDir(): string {
    const envDir = process.env.PI_CODING_AGENT_DIR?.trim();
    if (envDir) return envDir;
    return join(envFirstHomeDir(), ".pi", "agent");
}

/** Pi session JSONL root (`<agentDir>/sessions`). */
export function getPiSessionsRoot(): string {
    return join(getPiAgentDir(), "sessions");
}

/* */
export function getPiCacheRoot(): string {
    return join(dirname(getPiAgentDir()), "cache");
}

/** Shared Magic Context user config, independent of any harness agent settings dir. */
export function getSharedUserConfigPath(): string {
    return resolveCortexKitUserConfigPath();
}

/**
 * Pi persists extension package sources in `settings.json`'s `packages` array.
 */
export function getPiUserExtensionsPath(): string {
    return join(getPiAgentDir(), "settings.json");
}

// ============================================================================
// OMP paths
// ============================================================================

export interface OmpPaths {
    configRoot: string;
    agentDir: string;
    dataRoot: string;
    dataAgentRoot: string;
    pluginsDir: string;
    sessionsRoot: string;
}

/** `resolveOmpPaths` resolves OMP profile, custom-directory, and XDG paths without importing OMP. */
export function resolveOmpPaths(): OmpPaths {
    const rawProfile = process.env.OMP_PROFILE ?? process.env.PI_PROFILE;
    const normalizedProfile = rawProfile?.trim();
    const profile =
        normalizedProfile &&
        normalizedProfile !== "default" &&
        /^[a-z0-9][a-z0-9._-]{0,63}$/.test(normalizedProfile)
            ? normalizedProfile
            : undefined;
    const configDirName = process.env.PI_CONFIG_DIR?.trim() || ".omp";
    const baseConfigRoot = join(envFirstHomeDir(), configDirName);
    const configRoot = profile ? join(baseConfigRoot, "profiles", profile) : baseConfigRoot;
    const defaultAgentDir = join(configRoot, "agent");
    // Named profiles ignore `PI_CODING_AGENT_DIR` so an override cannot escape the profile root.
    const override = profile ? undefined : process.env.PI_CODING_AGENT_DIR?.trim();
    const agentDir = override ? resolve(override) : defaultAgentDir;
    const canUseXdg =
        (process.platform === "linux" || process.platform === "darwin") &&
        agentDir === defaultAgentDir;
    let dataRoot = configRoot;
    if (canUseXdg) {
        const xdgDataHome = process.env.XDG_DATA_HOME?.trim();
        if (xdgDataHome) {
            const appRoot = join(xdgDataHome, "omp");
            const candidate = profile ? join(appRoot, "profiles", profile) : appRoot;
            if (existsSync(candidate)) dataRoot = candidate;
        }
    }
    // OMP flattens the `agent/` prefix when XDG data is active.
    const dataAgentRoot = dataRoot === configRoot ? agentDir : dataRoot;
    return {
        configRoot,
        agentDir,
        dataRoot,
        dataAgentRoot,
        pluginsDir: join(dataRoot, "plugins"),
        sessionsRoot: join(dataAgentRoot, "sessions"),
    };
}

/* */
export function getOmpAgentDir(): string {
    return resolveOmpPaths().agentDir;
}

/** OMP stores session JSONL files under this root, including in its XDG data layout. */
export function getOmpSessionsRoot(): string {
    return resolveOmpPaths().sessionsRoot;
}

/** OMP stores global settings in this YAML file. */
export function getOmpConfigPath(): string {
    return join(resolveOmpPaths().agentDir, "config.yml");
}

/** Nix, Guix, and source installations use this OMP package-root override. */
export function getOmpPackageDir(): string | undefined {
    const value = process.env.PI_PACKAGE_DIR?.trim();
    if (!value) return undefined;
    if (value === "~") return envFirstHomeDir();
    if (value.startsWith("~/") || value.startsWith("~\\")) {
        return resolve(envFirstHomeDir(), value.slice(2));
    }
    return resolve(value);
}

/**
 * OMP's non-global settings layers can override `omp config set`.
 *
 * `PI_CONFIG_FILES` paths resolve relative to the command cwd.
 * `<cwd>/.omp/config.yml` overrides the global agent config. Callers must not mutate global settings for values from `PI_CONFIG_FILES` or `<cwd>/.omp/config.yml`.
 */
export function getOmpNonGlobalConfigSources(cwd = process.cwd()): string[] {
    const sources =
        process.env.PI_CONFIG_FILES?.split(delimiter)
            .map((entry) => entry.trim())
            .filter(Boolean)
            .map((entry) => {
                if (entry === "~") return envFirstHomeDir();
                const expanded =
                    entry.startsWith("~/") || entry.startsWith("~\\")
                        ? join(envFirstHomeDir(), entry.slice(2))
                        : entry;
                return resolve(cwd, expanded);
            }) ?? [];
    const projectConfig = resolve(cwd, ".omp", "config.yml");
    if (existsSync(projectConfig)) sources.push(projectConfig);
    return [...new Set(sources)];
}

/** OMP uses this root for npm and linked plugins, including profile and XDG data layouts. */
export function getOmpPluginsDir(): string {
    return resolveOmpPaths().pluginsDir;
}

/** OMP's plugin runtime uses this lock file. */
export function getOmpPluginsLockPath(): string {
    return join(resolveOmpPaths().pluginsDir, "omp-plugins.lock.json");
}

// ============================================================================
// ============================================================================

export {
    getMagicContextHistorianDir,
    getMagicContextLogPath,
} from "@magic-context/core/shared/data-path";

/**
 * OpenCode stores installed plugin packages in this cache directory.
 *
 * OpenCode's `xdg-basedir` dependency falls back to `<homedir>/.cache` on every platform, including Windows, when `XDG_CACHE_HOME` is unset.
 * `doctor --force` must clear the cache directory OpenCode uses.
 * `getOpenCodePluginCacheDir` must match the plugin runtime's cache resolution.
 */
export function getOpenCodePluginCacheDir(): string {
    const xdg = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
    return join(xdg, "opencode", "packages");
}

/* */
export function isDir(path: string): boolean {
    try {
        return statSync(path).isDirectory();
    } catch {
        return false;
    }
}

/* */
export function dirSizeBytes(path: string): number {
    if (!isDir(path)) return 0;
    let total = 0;
    const stack = [path];
    while (stack.length > 0) {
        const cur = stack.pop();
        if (cur === undefined) break;
        try {
            const entries = readdirSync(cur, { withFileTypes: true });
            for (const entry of entries) {
                const child = join(cur, entry.name);
                if (entry.isDirectory()) {
                    stack.push(child);
                } else if (entry.isFile()) {
                    try {
                        total += statSync(child).size;
                    } catch {
                        // ignore unreadable
                    }
                }
            }
        } catch {}
    }
    return total;
}
