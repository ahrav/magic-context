export declare const TUI_PREFS_FILE_ENV = "OPENCODE_TUI_PREFERENCES_FILE";
export declare function getTuiPreferencesFile(): string;
export declare function readTuiPreferencesFile(): Promise<Record<string, unknown>>;
export declare function readTuiPreferencesFileSync(): Record<string, unknown>;
export declare const PLUGIN_KEY = "magic-context";
export declare const DEFAULT_SLOT_ORDER = 170;
export interface MagicContextTuiPrefs {
    forceToTop: boolean;
    order: number;
    startCollapsed: boolean;
    rememberCollapsed: boolean;
    collapsed: boolean | null;
    header: {
        label: string;
    };
    sections: {
        historian: boolean;
        memory: boolean;
        status: boolean;
        dreamer: boolean;
        stats: boolean;
    };
}
export type TuiSections = MagicContextTuiPrefs["sections"];
export declare const DEFAULT_PREFS: MagicContextTuiPrefs;
export declare function resolveMagicContextPrefs(root: Record<string, unknown>): MagicContextTuiPrefs;
export declare function computeEffectiveOrder(root: Record<string, unknown>, pluginKey: string, defaultOrder: number): number;
type JsonValue = string | number | boolean | null;
export declare function queueTuiPreferenceUpdate(pluginKey: string, path: string[], value: JsonValue): Promise<void>;
type WatchReadFile = (file: string) => Promise<string>;
type WatchDirectory = (directory: string, listener: (event: string, filename: string | null) => void) => {
    close(): void;
};
export declare function __setTuiPreferencesWatchTestHooks(hooks: {
    readFile?: WatchReadFile;
    watch?: WatchDirectory;
}): void;
export declare function __resetTuiPreferencesWatchTestHooks(): void;
export declare function watchTuiPreferences(onChange: () => void): () => void;
export {};
//# sourceMappingURL=tui-preferences.d.ts.map