import { readFileSync, watch } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parse, stringify } from "comment-json";

// The file stores one top-level key for each OpenCode TUI plugin.
// Plugin keys must be non-integer-like names such as `magic-context`; the file is optional.
//
//
// Magic Context uses `comment-json` when writing to preserve comments and sibling plugin keys.
// Writers must preserve sibling plugins' values and comments.

export const TUI_PREFS_FILE_ENV = "OPENCODE_TUI_PREFERENCES_FILE";
const FILE_NAME = "tui-preferences.jsonc";

export function getTuiPreferencesFile(): string {
    const override = process.env[TUI_PREFS_FILE_ENV];
    if (override) return override;
    const configDir =
        process.env.OPENCODE_CONFIG_DIR ||
        join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
    return join(configDir, FILE_NAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readTuiPreferencesFile(): Promise<Record<string, unknown>> {
    try {
        const raw = await readFile(getTuiPreferencesFile(), "utf8");
        if (raw.trim() === "") return {};
        const root: unknown = parse(raw);
        return isRecord(root) ? (root as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

// The synchronous read prevents async flicker in the sidebar's initial collapse state and effective order.
// The synchronous reader matches the async reader's tolerance contract and never throws.
export function readTuiPreferencesFileSync(): Record<string, unknown> {
    try {
        const raw = readFileSync(getTuiPreferencesFile(), "utf8");
        if (raw.trim() === "") return {};
        const root: unknown = parse(raw);
        return isRecord(root) ? (root as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

export const PLUGIN_KEY = "magic-context";
export const DEFAULT_SLOT_ORDER = 170;

export interface MagicContextTuiPrefs {
    forceToTop: boolean;
    order: number;
    startCollapsed: boolean;
    rememberCollapsed: boolean;
    // `collapsed: null` prevents persistence; the UI initializes from `startCollapsed`.
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

export const DEFAULT_PREFS: MagicContextTuiPrefs = {
    forceToTop: false,
    order: DEFAULT_SLOT_ORDER,
    startCollapsed: false,
    rememberCollapsed: true,
    collapsed: null,
    header: { label: "Magic Context" },
    sections: {
        historian: true,
        memory: true,
        status: true,
        dreamer: true,
        stats: true,
    },
};

function bool(value: unknown, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback;
}

function int(value: unknown, fallback: number, min: number, max: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return Math.min(Math.max(Math.round(value), min), max);
}

function label(value: unknown, fallback: string, maxLength: number): string {
    if (typeof value !== "string" || value.length === 0) return fallback;
    return value.slice(0, maxLength);
}

// Each preference is independently clamped or defaulted, so an invalid value does not affect valid preferences.
// The reader never throws; a missing or non-object `magic-context` value produces a full defaults clone.
export function resolveMagicContextPrefs(root: Record<string, unknown>): MagicContextTuiPrefs {
    const entry = root[PLUGIN_KEY];
    if (!isRecord(entry)) return structuredClone(DEFAULT_PREFS);

    const d = DEFAULT_PREFS;
    const header = isRecord(entry.header) ? entry.header : {};
    const sections = isRecord(entry.sections) ? entry.sections : {};

    return {
        forceToTop: bool(entry.forceToTop, d.forceToTop),
        order: int(entry.order, d.order, -10000, 10000),
        startCollapsed: bool(entry.startCollapsed, d.startCollapsed),
        rememberCollapsed: bool(entry.rememberCollapsed, d.rememberCollapsed),
        collapsed: typeof entry.collapsed === "boolean" ? entry.collapsed : null,
        header: {
            label: label(header.label, d.header.label, 24),
        },
        sections: {
            historian: bool(sections.historian, d.sections.historian),
            memory: bool(sections.memory, d.sections.memory),
            status: bool(sections.status, d.sections.status),
            dreamer: bool(sections.dreamer, d.sections.dreamer),
            stats: bool(sections.stats, d.sections.stats),
        },
    };
}

const FORCE_TOP_BASE = -100000;

// Forced plugins sort below `FORCE_TOP_BASE`; top-level key order breaks ties.
// Users reprioritize forced plugins by reordering their top-level keys.
// The `order` value clamps to -10000..10000, strictly above the forced band.
// A manual `order` never overrides `forceToTop`.
// Host slots render in ascending order.
//
// JavaScript iterates integer-like keys such as `"0"` and `"42"` before string keys.
// Integer-like keys iterate before string keys, skewing index-based forced-plugin ordering.
export function computeEffectiveOrder(
    root: Record<string, unknown>,
    pluginKey: string,
    defaultOrder: number,
): number {
    const entry = root[pluginKey];
    if (!isRecord(entry)) return defaultOrder;
    if (entry.forceToTop === true) {
        return FORCE_TOP_BASE + Object.keys(root).indexOf(pluginKey);
    }
    return int(entry.order, defaultOrder, -10000, 10000);
}

const TEMPLATE = `// Shared preferences for OpenCode TUI plugins.
// Plugins update individual keys and preserve all other values and comments.
{}
`;

type JsonValue = string | number | boolean | null;

// setDeep preserves comments on existing leaves.
function setDeep(root: Record<string, unknown>, path: string[], value: JsonValue): boolean {
    let node: Record<string, unknown> = root;
    for (let i = 0; i < path.length - 1; i += 1) {
        const key = path[i];
        const child = node[key];
        if (child === undefined || child === null) {
            node[key] = {};
        } else if (!isRecord(child)) {
            return false;
        }
        node = node[key] as Record<string, unknown>;
    }
    node[path[path.length - 1]] = value;
    return true;
}

async function writePreference(pluginKey: string, path: string[], value: JsonValue): Promise<void> {
    const file = getTuiPreferencesFile();
    await mkdir(dirname(file), { recursive: true });
    let text: string;
    try {
        text = await readFile(file, "utf8");
    } catch {
        text = "";
    }
    if (text.trim() === "") text = TEMPLATE;

    let root: unknown;
    try {
        root = parse(text);
    } catch {
        // If parsing the shared file fails, skip the write to preserve sibling plugins' keys.
        return;
    }
    if (!isRecord(root)) root = {};
    if (!setDeep(root as Record<string, unknown>, [pluginKey, ...path], value)) {
        return;
    }

    const next = `${stringify(root, null, 2)}\n`;
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, next, "utf8");
    await rename(tmp, file);
}

let writeChain: Promise<void> = Promise.resolve();

// The promise chain serializes writes so each update reads the latest file.
// Same-directory temp-file renames replace the file atomically.
// Preference-write failures do not crash the TUI.
export function queueTuiPreferenceUpdate(
    pluginKey: string,
    path: string[],
    value: JsonValue,
): Promise<void> {
    writeChain = writeChain.then(() => writePreference(pluginKey, path, value)).catch(() => {});
    return writeChain;
}

const WATCH_DEBOUNCE_MS = 150;

type WatchReadFile = (file: string) => Promise<string>;
type WatchDirectory = (
    directory: string,
    listener: (event: string, filename: string | null) => void,
) => { close(): void };

let watchReadFile: WatchReadFile = (file) => readFile(file, "utf8");
let watchDirectory: WatchDirectory = (directory, listener) => watch(directory, listener);

export function __setTuiPreferencesWatchTestHooks(hooks: {
    readFile?: WatchReadFile;
    watch?: WatchDirectory;
}): void {
    watchReadFile = hooks.readFile ?? ((file) => readFile(file, "utf8"));
    watchDirectory = hooks.watch ?? ((directory, listener) => watch(directory, listener));
}

export function __resetTuiPreferencesWatchTestHooks(): void {
    watchReadFile = (file) => readFile(file, "utf8");
    watchDirectory = (directory, listener) => watch(directory, listener);
}

// The watcher observes the directory because renaming the preference file invalidates file-level watchers.
//
//
export function watchTuiPreferences(onChange: () => void): () => void {
    const file = getTuiPreferencesFile();
    const name = basename(file);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastSeen: string | null = null;
    try {
        lastSeen = readFileSync(file, "utf8");
    } catch {
        // A missing or unreadable baseline is retried after registration.
    }
    const reconcile = (): void => {
        void watchReadFile(file)
            .catch(() => null)
            .then((text) => {
                if (text === null || text === lastSeen) return;
                lastSeen = text;
                onChange();
            });
    };
    try {
        const watcher = watchDirectory(dirname(file), (_event, filename) => {
            const isOurs =
                filename === name ||
                (filename?.startsWith(`${name}.`) && filename.endsWith(".tmp"));
            if (filename != null && !isOurs) return;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                timer = null;
                reconcile();
            }, WATCH_DEBOUNCE_MS);
        });
        // Watcher setup reconciles after registration to observe changes between the baseline read and watcher installation.
        reconcile();
        return () => {
            if (timer) clearTimeout(timer);
            watcher.close();
        };
    } catch {
        return () => {};
    }
}
