import { z } from "zod";
export declare const NpmPackageEnvelopeSchema: z.ZodObject<{
    "dist-tags": z.ZodDefault<z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>>;
}, z.core.$strip>;
export declare const OpencodePluginTupleSchema: z.ZodTuple<[z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnknown>], null>;
export declare const OpencodeConfigSchema: z.ZodObject<{
    plugin: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodTuple<[z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnknown>], null>]>>>;
}, z.core.$strip>;
export declare const PackageJsonSchema: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    version: z.ZodOptional<z.ZodString>;
    dependencies: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
}, z.core.$loose>;
export interface AutoUpdateCheckerOptions {
    enabled?: boolean;
    showStartupToast?: boolean;
    autoUpdate?: boolean;
    npmRegistryUrl?: string;
    fetchTimeoutMs?: number;
    signal?: AbortSignal;
    /**
     * Storage directory used for cross-process check coordination. The
     * checker writes `last-update-check.json` here so concurrent plugin
     * instances (multi-project TUI launches) only hit npm once per
     * `checkIntervalMs`. Pass `null`/omit for fail-open behavior — the
     * check still runs, just without dedup. Recommended: pass the
     * plugin's existing storage path (e.g. `getMagicContextStorageDir()`).
     */
    storageDir?: string | null;
    /**
     * Minimum interval between checks across all plugin instances on
     * this machine. Default: 1 hour.
     */
    checkIntervalMs?: number;
    /**
     * Delay before the post-init check fires. Lets OpenCode finish boot
     * before the npm round-trip starts. Default: 5000ms.
     */
    initDelayMs?: number;
}
export interface PluginEntryInfo {
    entry: string;
    isPinned: boolean;
    pinnedVersion: string | null;
    configPath: string;
}
//# sourceMappingURL=types.d.ts.map