import { homedir, platform } from "node:os";
import { join } from "node:path";

export const PACKAGE_NAME = "@cortexkit/opencode-magic-context";
export const NPM_REGISTRY_URL = "https://registry.npmjs.org";
export const NPM_FETCH_TIMEOUT = 10_000;

function getOpenCodeCacheRoot(): string {
    if (platform() === "win32") {
        return join(process.env.LOCALAPPDATA ?? homedir(), "opencode");
    }
    return join(homedir(), ".cache", "opencode");
}

function getOpenCodeConfigRoot(): string {
    if (platform() === "win32") {
        return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "opencode");
    }
    return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode");
}

/* */
export const CACHE_DIR = join(getOpenCodeCacheRoot(), "packages");

/* */
export const USER_OPENCODE_CONFIG = join(getOpenCodeConfigRoot(), "opencode.json");

/* */
export const USER_OPENCODE_CONFIG_JSONC = join(getOpenCodeConfigRoot(), "opencode.jsonc");
