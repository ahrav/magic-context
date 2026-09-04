import { type PluginEntryInfo } from "./types";
export declare function extractChannel(version: string | null): string;
export declare function getLocalDevVersion(directory: string): string | null;
export declare function getCurrentRuntimePackageJsonPath(currentModuleUrl?: string): string | null;
export declare function findPluginEntry(directory: string): PluginEntryInfo | null;
export interface PreparedConfigUpdate {
    spec: string;
    configPaths: [string, string];
}
export declare function hasExplicitNonExactPluginVersion(spec: string): boolean;
export declare function preparePluginUpdate(directory: string, _pluginInfo: PluginEntryInfo, version: string, options?: {
    signal?: AbortSignal;
    timeoutMs?: number;
}): Promise<PreparedConfigUpdate | null>;
export declare function getCachedVersion(_spec?: string | null): string | null;
export declare function updatePinnedVersion(configPath: string, oldEntry: string, newVersion: string): boolean;
export declare function getLatestVersion(channel?: string, options?: {
    registryUrl?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
}): Promise<string | null>;
//# sourceMappingURL=checker.d.ts.map