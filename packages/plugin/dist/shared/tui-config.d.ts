/**
 * Configure tui.json with the magic-context TUI plugin entry.
 *
 * Called ONLY from the CLI setup wizard and `doctor` (via the core export) —
 * never at plugin startup. Startup injection would re-add the entry on every
 * launch, so a user who deliberately removed the sidebar could never keep it
 * removed; opting in/out of the sidebar is the user's call, made explicitly
 * through setup or doctor.
 */
/**
 * Ensure the selected TUI config has the magic-context plugin entry.
 * Creates tui.jsonc if neither TUI config exists. Silently skips if already present.
 */
export declare function ensureTuiPluginEntry(options?: {
    configDir?: string;
}): boolean;
//# sourceMappingURL=tui-config.d.ts.map