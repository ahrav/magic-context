/**
 *
 */

import {
    chmodSync,
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "comment-json";
import { log } from "./logger";
import { getOpenCodeConfigPaths } from "./opencode-config-dir";

const PLUGIN_NAME = "@cortexkit/opencode-magic-context";
const PLUGIN_ENTRY = `${PLUGIN_NAME}@latest`;

function pluginEntryId(entry: unknown): string {
    if (typeof entry === "string") return entry;
    if (Array.isArray(entry) && typeof entry[0] === "string") return entry[0];
    return "";
}

function isLocalMagicContextDevEntry(entry: unknown): boolean {
    const id = pluginEntryId(entry);
    if (!id) return false;
    if (id === PLUGIN_NAME || id.startsWith(`${PLUGIN_NAME}@`)) return false;
    const isPath =
        id.startsWith("file://") || id.startsWith("/") || id.startsWith("./") || id.includes("\\");
    if (!isPath) return false;
    return id.includes("opencode-magic-context") || id.includes("magic-context");
}

function isMagicContextPluginEntry(entry: unknown): boolean {
    const id = pluginEntryId(entry);
    if (!id) return false;
    if (id === PLUGIN_NAME || id.startsWith(`${PLUGIN_NAME}@`)) return true;
    return isLocalMagicContextDevEntry(entry);
}

function writeTuiConfigAtomic(configPath: string, config: Record<string, unknown>): void {
    const body = `${stringify(config, null, 2)}\n`;
    const tmpPath = `${configPath}.tmp`;
    writeFileSync(tmpPath, body);
    try {
        if (statSync(configPath, { throwIfNoEntry: false })?.isFile()) {
            chmodSync(tmpPath, statSync(configPath).mode & 0o777);
        }
    } catch {
        /* new file */
    }
    renameSync(tmpPath, configPath);
}

function resolveTuiConfigPath(configDirOverride?: string): string {
    const configDir = configDirOverride ?? getOpenCodeConfigPaths({ binary: "opencode" }).configDir;
    const jsoncPath = join(configDir, "tui.jsonc");
    const jsonPath = join(configDir, "tui.json");

    if (existsSync(jsoncPath)) return jsoncPath;
    if (existsSync(jsonPath)) return jsonPath;
    return jsoncPath;
}

/**
 */
export function ensureTuiPluginEntry(options: { configDir?: string } = {}): boolean {
    try {
        const configPath = resolveTuiConfigPath(options.configDir);

        let config: Record<string, unknown> = {};
        if (existsSync(configPath)) {
            const raw = readFileSync(configPath, "utf-8");
            config = (parse(raw) as Record<string, unknown>) ?? {};
        }

        const plugins: unknown[] = Array.isArray(config.plugin) ? [...config.plugin] : [];

        const existingIdx = plugins.findIndex(isMagicContextPluginEntry);
        if (existingIdx >= 0) {
            const existing = plugins[existingIdx];
            if (isLocalMagicContextDevEntry(existing)) {
                return false;
            }
            const id = pluginEntryId(existing);
            if (id === PLUGIN_ENTRY) {
                return false;
            }
            if (id === PLUGIN_NAME) {
                if (Array.isArray(existing) && existing.length >= 1) {
                    const replacement = [...existing];
                    replacement[0] = PLUGIN_ENTRY;
                    plugins[existingIdx] = replacement;
                } else {
                    plugins[existingIdx] = PLUGIN_ENTRY;
                }
            } else {
                return false;
            }
        } else {
            const hasDev = plugins.some(isLocalMagicContextDevEntry);
            if (!hasDev) {
                plugins.push(PLUGIN_ENTRY);
            } else {
                return false;
            }
        }
        config.plugin = plugins;

        mkdirSync(dirname(configPath), { recursive: true });
        writeTuiConfigAtomic(configPath, config);
        log(`[magic-context] updated TUI plugin entry in ${configPath}`);
        return true;
    } catch (error) {
        log(
            `[magic-context] failed to update tui.json: ${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
    }
}
