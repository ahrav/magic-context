/**
 * The OpenCode and Pi plugins share this startup announcement.
 *
 * `ANNOUNCEMENT_VERSION` and `ANNOUNCEMENT_FEATURES` must remain empty unless they announce user-facing startup news.
 * `ANNOUNCEMENT_VERSION` must not change for patch releases without user-visible changes; changing it shows the dialog to dismissed users again.
 *
 * OpenCode and Pi share the state file because they use the same storage root.
 * Dismissing an announcement in either harness suppresses it in both.
 *
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { compareSemverCore } from "../hooks/auto-update-checker/semver";
import { getMagicContextStorageDir } from "./data-path";

/**
 * `ANNOUNCEMENT_VERSION` must change only for user-visible changes worth a startup dialog.
 * `ANNOUNCEMENT_VERSION` need not match the published package version.
 */
export const ANNOUNCEMENT_VERSION = "0.31.0";

/**
 */
export const ANNOUNCEMENT_FEATURES: ReadonlyArray<string> = [
    "New /ctx-wrapup command: compact older history on demand, keeping the newest N messages raw. Run it before switching to a smaller-context model.",
    "ctx_search now also searches your session notes and smart notes.",
    "Project identity now survives transient git failures (slow disks, dubious ownership) without splitting your project memory.",
    "Removed the ctx_reduce_enabled setting; agent-controlled reduction is always on. Caveman text compression is now independent (caveman_text_compression.enabled).",
];

/**
 * `ANNOUNCEMENT_FOOTER` appears below version-specific bullets in every announcement.
 * `ANNOUNCEMENT_FOOTER` must persist across releases so every announcement includes the Discord invite.
 * The Discord invite belongs in `ANNOUNCEMENT_FOOTER` to avoid repeating it in `ANNOUNCEMENT_FEATURES`.
 *
 * An empty `ANNOUNCEMENT_FOOTER` suppresses the footer.
 */
export const ANNOUNCEMENT_FOOTER = "Join us on Discord: https://discord.gg/F2uWxjGnU";

const STATE_FILENAME = "last_announced_version";

function getStateFilePath(): string {
    return path.join(getMagicContextStorageDir(), STATE_FILENAME);
}

type AnnouncementStateRead =
    | { status: "missing" }
    | { status: "valid"; version: string }
    | { status: "error" };

function readAnnouncementState(): AnnouncementStateRead {
    try {
        const file = getStateFilePath();
        if (!fs.existsSync(file)) return { status: "missing" };
        const version = fs.readFileSync(file, "utf-8").trim();
        if (!version) return { status: "error" };
        return { status: "valid", version };
    } catch {
        return { status: "error" };
    }
}

/**
 * `shouldShowAnnouncement` uses the tri-state read path to distinguish missing state from read and corruption failures.
 */
export function readLastAnnouncedVersion(): string {
    const state = readAnnouncementState();
    return state.status === "valid" ? state.version : "";
}

/**
 * `markAnnouncementSeen` swallows write failures so confirmation flows do not throw; the dialog can reappear on the next startup.
 */
export function markAnnouncementSeen(version: string): void {
    if (!version) return;
    try {
        const dir = getMagicContextStorageDir();
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(getStateFilePath(), version);
    } catch {
        // best-effort
    }
}

/**
 * Both the TUI dialog and Desktop ignored-message fallback use this predicate.
 *
 * Fresh installs do not receive a release changelog.
 *
 */
export function shouldShowAnnouncement(): boolean {
    if (!ANNOUNCEMENT_VERSION || ANNOUNCEMENT_FEATURES.length === 0) return false;
    const state = readAnnouncementState();
    if (state.status === "missing") {
        markAnnouncementSeen(ANNOUNCEMENT_VERSION);
        return false;
    }
    if (state.status === "error") {
        // A corrupt or unreadable existing state file is not first-run.
        // Read failures do not advance the version, so a later successful boot can still show the announcement.
        return false;
    }
    // `compareSemverCore`-orderable versions show only on upgrades.
    // String inequality would show the announcement after a downgrade.
    const ordering = compareSemverCore(ANNOUNCEMENT_VERSION, state.version);
    if (ordering === null) {
        // When semver ordering is unavailable, the predicate suppresses only an exact version-string match.
        return state.version !== ANNOUNCEMENT_VERSION;
    }
    return ordering > 0;
}
