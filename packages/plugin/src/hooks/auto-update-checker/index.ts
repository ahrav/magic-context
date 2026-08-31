import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PluginInput } from "@opencode-ai/plugin";

import { getOpenCodeStorageDir } from "../../shared/data-path";
import { log } from "../../shared/logger";
import { resolveInstallContext } from "./cache";
import {
    extractChannel,
    findPluginEntry,
    getCachedVersion,
    getLatestVersion,
    getLocalDevVersion,
    hasExplicitNonExactPluginVersion,
    type PreparedConfigUpdate,
    preparePluginUpdate,
} from "./checker";
import { CACHE_DIR, NPM_FETCH_TIMEOUT, NPM_REGISTRY_URL, PACKAGE_NAME } from "./constants";
import { compareSemverCore } from "./semver";
import type { AutoUpdateCheckerOptions } from "./types";

type OpenCodeEvent = {
    type: string;
    properties?: unknown;
};

type ToastVariant = "info" | "warning" | "error" | "success";

type ResolvedAutoUpdateCheckerOptions = Required<
    Omit<AutoUpdateCheckerOptions, "enabled" | "storageDir">
> & { storageDir: string | null };

const DEFAULT_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_INIT_DELAY_MS = 5_000;
const TIMESTAMP_FILENAME = "last-update-check.json";
const PENDING_UPDATE_FILENAME = "pending-plugin-update.json";
const PENDING_UPDATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function warn(message: string): void {
    log(`WARN: ${message}`);
}

/**
 * Auto-update checker.
 *
 *
 * The checker must not gate update checks on `session.created`.
 *
 *   - TUI restart with a resumed session never fires `session.created`
 *     (the event fires on session creation, not on plugin reload).
 * Sidebar polling and idle TUI use do not emit `session.created`.
 *     `session.created`.
 *
 * The timestamp suppresses checks from plugin instances that share `storageDir`.
 * The checker skips the check when the timestamp is less than `checkIntervalMs` old.
 * A caller that claims the slot performs the check.
 * The timestamp write uses a temporary file and rename to avoid partial timestamp files.
 *
 */
export function createAutoUpdateCheckerHook(
    ctx: PluginInput,
    options: AutoUpdateCheckerOptions = {},
) {
    const {
        enabled = true,
        showStartupToast = true,
        autoUpdate = true,
        npmRegistryUrl = NPM_REGISTRY_URL,
        fetchTimeoutMs = NPM_FETCH_TIMEOUT,
        signal = new AbortController().signal,
        storageDir = null,
        checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
        initDelayMs = DEFAULT_INIT_DELAY_MS,
    } = options;

    if (!enabled) {
        // The disabled checker returns a no-op event hook to preserve the hook API.
        return async (_input: { event: OpenCodeEvent }) => {
            // intentionally empty
        };
    }

    // The checker schedules the check from plugin initialization rather than an event.
    // The timer returns control to OpenCode before the npm request starts.
    // The deferred `maybeRunCheck` call never blocks plugin initialization on the npm request.
    const initTimer = setTimeout(() => {
        void maybeRunCheck(ctx, {
            showStartupToast,
            autoUpdate,
            npmRegistryUrl,
            fetchTimeoutMs,
            signal,
            storageDir,
            checkIntervalMs,
            initDelayMs,
        }).catch((err) => {
            warn(`[auto-update-checker] Background update check failed: ${String(err)}`);
        });
    }, initDelayMs);

    // Calling `unref()` prevents the timer from keeping the Node event loop alive.
    if (typeof initTimer === "object" && initTimer !== null && "unref" in initTimer) {
        (initTimer as { unref: () => void }).unref();
    }

    // `signal` abort prevents a scheduled check that has not started.
    signal.addEventListener(
        "abort",
        () => {
            clearTimeout(initTimer);
        },
        { once: true },
    );

    return async (_input: { event: OpenCodeEvent }) => {
    };
}

async function maybeRunCheck(
    ctx: PluginInput,
    options: ResolvedAutoUpdateCheckerOptions,
): Promise<void> {
    if (options.signal.aborted) return;

    // `maybeRunCheck` checks the cross-process deduplication window before contacting npm.
    // `maybeRunCheck` skips the npm request when another plugin instance checked within the deduplication window.
    if (!claimCheckSlot(options.storageDir, options.checkIntervalMs)) {
        log("[auto-update-checker] Skipping check (another instance ran one recently)");
        return;
    }

    await runStartupCheck(ctx, options);
}

/**
 * `claimCheckSlot` uses the on-disk timestamp file to claim the next check slot.
 *
 * `claimCheckSlot` returns false when the timestamp age is less than `intervalMs`.
 * Storage errors return true, allowing the check to proceed.
 * missed check).
 *
 * `claimCheckSlot` is not atomic: concurrent initializations can both pass the window check.
 * Two concurrent callers can trigger two npm requests.
 * The atomic temp-file rename keeps the timestamp valid JSON even when concurrent writers race.
 */
function claimCheckSlot(storageDir: string | null, intervalMs: number): boolean {
    if (!storageDir) return true; // No storage available — fail open.
    try {
        const file = join(storageDir, TIMESTAMP_FILENAME);
        if (existsSync(file)) {
            try {
                const raw = JSON.parse(readFileSync(file, "utf-8")) as {
                    lastCheckedMs?: unknown;
                };
                const last = typeof raw.lastCheckedMs === "number" ? raw.lastCheckedMs : 0;
                if (Number.isFinite(last) && Date.now() - last < intervalMs) {
                    return false;
                }
            } catch {
            }
        }
        mkdirSync(dirname(file), { recursive: true });
        const tmp = `${file}.tmp.${process.pid}`;
        writeFileSync(tmp, JSON.stringify({ lastCheckedMs: Date.now() }), "utf-8");
        renameSync(tmp, file);
        return true;
    } catch (err) {
        warn(`[auto-update-checker] Could not coordinate via timestamp file: ${String(err)}`);
        return true;
    }
}

type PendingUpdateMarker = {
    spec: string;
    version: string;
    configPaths: [string, string];
    writtenAt: number;
};

function pendingMarkerPath(storageDir: string | null): string {
    return join(storageDir ?? getOpenCodeStorageDir(), PENDING_UPDATE_FILENAME);
}

function writePendingUpdateMarker(
    storageDir: string | null,
    update: PreparedConfigUpdate,
    version: string,
): void {
    try {
        const dir = storageDir ?? dirname(pendingMarkerPath(storageDir));
        mkdirSync(dir, { recursive: true });
        const path = pendingMarkerPath(storageDir);
        const temp = `${path}.tmp.${process.pid}`;
        writeFileSync(
            temp,
            `${JSON.stringify({ spec: update.spec, version, configPaths: update.configPaths, writtenAt: Date.now() }, null, 2)}\n`,
            "utf-8",
        );
        renameSync(temp, path);
    } catch (err) {
        warn(`[auto-update-checker] Could not write pending update marker: ${String(err)}`);
    }
}

function consumePendingUpdateMarker(storageDir: string | null, loadedVersion: string | null): void {
    const path = pendingMarkerPath(storageDir);
    if (!existsSync(path)) return;
    try {
        const marker = JSON.parse(readFileSync(path, "utf-8")) as Partial<PendingUpdateMarker>;
        const age = Date.now() - (marker.writtenAt ?? 0);
        const olderThanLoaded =
            typeof marker.version === "string" &&
            typeof loadedVersion === "string" &&
            (compareSemverCore(marker.version, loadedVersion) ?? 0) < 0;
        if (
            marker.version === loadedVersion &&
            marker.spec === `${PACKAGE_NAME}@${loadedVersion}` &&
            Array.isArray(marker.configPaths) &&
            marker.configPaths.length === 2
        ) {
            rmSync(path, { force: true });
            log(`[auto-update-checker] Pending update applied: ${marker.spec}`);
        } else if (age > PENDING_UPDATE_MAX_AGE_MS || olderThanLoaded) {
            rmSync(path, { force: true });
            warn("[auto-update-checker] Discarded stale or mismatched pending update marker");
        }
    } catch (err) {
        try {
            rmSync(path, { force: true });
        } catch {
        }
        warn(`[auto-update-checker] Discarded corrupt pending update marker: ${String(err)}`);
    }
}

async function runStartupCheck(
    ctx: PluginInput,
    options: ResolvedAutoUpdateCheckerOptions,
): Promise<void> {
    if (options.signal.aborted) return;

    const cachedVersion = getCachedVersion();
    consumePendingUpdateMarker(options.storageDir, cachedVersion);
    const localDevVersion = getLocalDevVersion(ctx.directory);
    const displayVersion = localDevVersion ?? cachedVersion;

    if (localDevVersion) {
        if (options.showStartupToast) {
            showToast(
                ctx,
                `Magic Context ${displayVersion} (dev)`,
                "Running in local development mode.",
                "info",
            );
        }
        log("[auto-update-checker] Local development mode");
        return;
    }

    if (options.showStartupToast) {
        showToast(
            ctx,
            `Magic Context ${displayVersion ?? "unknown"}`,
            "@cortexkit/opencode-magic-context is active.",
            "info",
        );
    }

    await runBackgroundUpdateCheck(ctx, options);
}

async function runBackgroundUpdateCheck(
    ctx: PluginInput,
    options: ResolvedAutoUpdateCheckerOptions,
): Promise<void> {
    if (options.signal.aborted) return;

    const pluginInfo = findPluginEntry(ctx.directory);
    if (!pluginInfo) {
        log("[auto-update-checker] Plugin not found in config");
        return;
    }

    if (hasExplicitNonExactPluginVersion(pluginInfo.entry)) {
        if (pluginInfo.entry === `${PACKAGE_NAME}@latest`) {
            log(
                "[auto-update-checker] Explicit @latest leaves the active package unpinned; OpenCode may delete it mid-session.",
            );
        }
        return;
    }

    const cachedVersion = getCachedVersion(pluginInfo.entry);
    const currentVersion = cachedVersion ?? pluginInfo.pinnedVersion;
    if (!currentVersion) {
        log("[auto-update-checker] No version found (cached or pinned)");
        return;
    }

    const channel = extractChannel(pluginInfo.pinnedVersion ?? currentVersion);
    const latestVersion = await getLatestVersion(channel, {
        registryUrl: options.npmRegistryUrl,
        timeoutMs: options.fetchTimeoutMs,
        signal: options.signal,
    });
    if (!latestVersion) {
        warn(`[auto-update-checker] Failed to fetch latest version for channel: ${channel}`);
        showToast(
            ctx,
            "Magic Context update check failed",
            "Could not check npm for @cortexkit/opencode-magic-context updates. Continuing with the cached version.",
            "warning",
            8000,
        );
        return;
    }

    if (currentVersion === latestVersion) {
        log(`[auto-update-checker] Already on latest version for channel: ${channel}`);
        return;
    }

    log(
        `[auto-update-checker] Update available (${channel}): ${currentVersion} → ${latestVersion}`,
    );

    if (pluginInfo.isPinned) {
        showToast(
            ctx,
            `Magic Context ${latestVersion}`,
            `v${latestVersion} available. Version is pinned; update your OpenCode plugin config to upgrade.`,
            "info",
            8000,
        );
        log("[auto-update-checker] Version is pinned; skipping auto-update");
        return;
    }

    if (!options.autoUpdate) {
        showToast(
            ctx,
            `Magic Context ${latestVersion}`,
            `v${latestVersion} available. Auto-update is disabled.`,
            "info",
            8000,
        );
        log("[auto-update-checker] Auto-update disabled, notification only");
        return;
    }

    const preparedUpdate = await preparePluginUpdate(ctx.directory, pluginInfo, latestVersion, {
        signal: options.signal,
    });
    if (preparedUpdate) {
        writePendingUpdateMarker(options.storageDir, preparedUpdate, latestVersion);
        showToast(
            ctx,
            "Magic Context Update Ready",
            `v${currentVersion} → v${latestVersion}\nRestart OpenCode to apply.`,
            "success",
            8000,
        );
        log(`[auto-update-checker] Update ready: ${currentVersion} → ${latestVersion}`);
        return;
    }

    showToast(
        ctx,
        `Magic Context ${latestVersion}`,
        `v${latestVersion} available, but auto-update failed to update both plugin configs.`,
        "error",
        8000,
    );
    warn("[auto-update-checker] Exact-spec config transaction failed; update not announced");
}

export function getAutoUpdateInstallDir(): string {
    return resolveInstallContext()?.installDir ?? CACHE_DIR;
}

function showToast(
    ctx: PluginInput,
    title: string,
    message: string,
    variant: ToastVariant = "info",
    duration = 3000,
): void {
    ctx.client.tui.showToast({ body: { title, message, variant, duration } }).catch(() => {});
}

export type { AutoUpdateCheckerOptions } from "./types";
