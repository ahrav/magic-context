interface AutoUpdateInstallContext {
    installDir: string;
    packageJsonPath: string;
}
/**
 * Resolve the cache root only. Auto-update never edits, removes, or installs
 * into this tree: OpenCode owns versioned cache directories and reconciles the
 * exact spec selected by the configuration on the next boot.
 */
export declare function resolveInstallContext(runtimePackageJsonPath?: string | null): AutoUpdateInstallContext | null;
export {};
//# sourceMappingURL=cache.d.ts.map