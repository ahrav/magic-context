/**
 *
 *
 */

export type HarnessKind = "opencode" | "pi" | "omp";

export interface HarnessConfigPaths {
    /** configDir identifies the primary configuration directory. */
    configDir: string;
    /* */
    pluginConfigPath: string;
    /* */
    magicContextConfigPath: string;
    /**
     * secondaryConfigPath is null when the harness has no equivalent.
     */
    secondaryConfigPath: string | null;
}

export interface PluginEntryResult {
    ok: boolean;
    /* */
    action: "added" | "updated" | "already_present" | "error";
    /** message provides a human-readable result summary. */
    message: string;
    /* */
    configPath: string;
}

export interface PluginCacheInfo {
    /** path identifies the plugin cache directory and is null when the harness has no plugin cache. */
    path: string | null;
    /** exists is true when the cache contains data. */
    exists: boolean;
    /** sizeBytes reports the approximate cache size in bytes and is 0 when the cache is missing. */
    sizeBytes: number;
}

/**
 */
export interface HarnessAdapter {
    /* */
    readonly kind: HarnessKind;
    /* */
    readonly displayName: string;
    /* */
    readonly pluginPackageName: string;

    /* */
    isInstalled(): boolean;

    /* */
    hasPluginEntry(): boolean;

    /** getConfigPaths remains callable when the harness is not installed. */
    getConfigPaths(): HarnessConfigPaths;

    /**
     * ensurePluginEntry is idempotent.
     *
     */
    ensurePluginEntry(): Promise<PluginEntryResult>;

    /**
     *
     */
    removePluginEntry(): Promise<PluginEntryResult>;

    /**
     */
    getInstallHint(): string;

    /* */
    getPluginCacheInfo(): PluginCacheInfo;

    /* */
    getLogPath(): string;

    /* */
    getInstalledPluginVersion(): string | null;
}
