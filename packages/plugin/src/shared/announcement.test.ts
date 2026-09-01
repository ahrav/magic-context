import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * On first run, the gate stores the current version and returns false to avoid showing a changelog without prior context.
 * Empty version marks do not modify the stored version.
 *
 * The module must be imported after XDG_DATA_HOME is set because it captures its storage path at import time.
 */

let tmpRoot = "";
let originalXdg: string | undefined;

beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mc-announcement-test-"));
    originalXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = tmpRoot;
});

afterEach(() => {
    if (originalXdg === undefined) {
        delete process.env.XDG_DATA_HOME;
    } else {
        process.env.XDG_DATA_HOME = originalXdg;
    }
    try {
        // maxRetries/retryDelay ride out transient EBUSY/EPERM on Windows.
        fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
        // best-effort
    }
});

describe("announcement state persistence", () => {
    test("round-trips a dismissed version through the file", async () => {
        // Import the module after setting XDG_DATA_HOME because it captures the temporary path at import time.
        const mod = await import(`./announcement?t=${Date.now()}-rt`);
        const { readLastAnnouncedVersion, markAnnouncementSeen } = mod;

        expect(readLastAnnouncedVersion()).toBe("");

        markAnnouncementSeen("9.9.9");
        expect(readLastAnnouncedVersion()).toBe("9.9.9");

        markAnnouncementSeen("9.9.10");
        expect(readLastAnnouncedVersion()).toBe("9.9.10");
    });

    test("ignores empty / zero-length version marks", async () => {
        const mod = await import(`./announcement?t=${Date.now()}-empty`);
        const { readLastAnnouncedVersion, markAnnouncementSeen } = mod;

        markAnnouncementSeen("");
        expect(readLastAnnouncedVersion()).toBe("");
    });

    test("creates the storage directory if it does not exist", async () => {
        const mod = await import(`./announcement?t=${Date.now()}-mkdir`);
        const { markAnnouncementSeen } = mod;

        const expectedDir = path.join(tmpRoot, "cortexkit", "magic-context");
        expect(fs.existsSync(expectedDir)).toBe(false);

        markAnnouncementSeen("0.21.7");

        expect(fs.existsSync(expectedDir)).toBe(true);
        expect(fs.readFileSync(path.join(expectedDir, "last_announced_version"), "utf-8")).toBe(
            "0.21.7",
        );
    });

    test("trims whitespace from stored version on read", async () => {
        const mod = await import(`./announcement?t=${Date.now()}-trim`);
        const { readLastAnnouncedVersion } = mod;

        const dir = path.join(tmpRoot, "cortexkit", "magic-context");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "last_announced_version"), "  1.2.3  \n");

        expect(readLastAnnouncedVersion()).toBe("1.2.3");
    });
});

describe("shouldShowAnnouncement gating", () => {
    test("returns false when the live version is already marked", async () => {
        const mod = await import(`./announcement?t=${Date.now()}-match`);
        const {
            ANNOUNCEMENT_VERSION,
            ANNOUNCEMENT_FEATURES,
            markAnnouncementSeen,
            shouldShowAnnouncement,
        } = mod;

        if (!ANNOUNCEMENT_VERSION || ANNOUNCEMENT_FEATURES.length === 0) {
            return;
        }

        markAnnouncementSeen(ANNOUNCEMENT_VERSION);
        expect(shouldShowAnnouncement()).toBe(false);
    });

    test("seeds state and returns false on first run / wiped sandbox (issue #99)", async () => {
        const mod = await import(`./announcement?t=${Date.now()}-none`);
        const {
            ANNOUNCEMENT_VERSION,
            ANNOUNCEMENT_FEATURES,
            shouldShowAnnouncement,
            readLastAnnouncedVersion,
        } = mod;

        if (!ANNOUNCEMENT_VERSION || ANNOUNCEMENT_FEATURES.length === 0) {
            // The gate returns false when ANNOUNCEMENT_VERSION is empty or ANNOUNCEMENT_FEATURES has no entries.
            expect(shouldShowAnnouncement()).toBe(false);
            return;
        }

        // When no stored mark exists, the gate seeds the current version and returns false.
        // The gate seeds the stored version with the current version and returns false when no mark exists.
        // The gate returns false after seeding a missing mark so first-run users do not see a changelog without prior context.
        // The gate returns false after seeding a missing mark so first-run users do not see a changelog without prior context.
        expect(readLastAnnouncedVersion()).toBe("");
        expect(shouldShowAnnouncement()).toBe(false);
        expect(readLastAnnouncedVersion()).toBe(ANNOUNCEMENT_VERSION);
        expect(shouldShowAnnouncement()).toBe(false);
    });

    test("does not seed or advance state when an existing state file is unreadable/corrupt", async () => {
        const mod = await import(`./announcement?t=${Date.now()}-corrupt`);
        const { ANNOUNCEMENT_VERSION, ANNOUNCEMENT_FEATURES, shouldShowAnnouncement } = mod;

        if (!ANNOUNCEMENT_VERSION || ANNOUNCEMENT_FEATURES.length === 0) {
            expect(shouldShowAnnouncement()).toBe(false);
            return;
        }

        const dir = path.join(tmpRoot, "cortexkit", "magic-context");
        const file = path.join(dir, "last_announced_version");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, "");

        expect(shouldShowAnnouncement()).toBe(false);
        expect(fs.readFileSync(file, "utf-8")).toBe("");
    });

    test("returns true when a different (older) version is marked", async () => {
        const mod = await import(`./announcement?t=${Date.now()}-older`);
        const {
            ANNOUNCEMENT_VERSION,
            ANNOUNCEMENT_FEATURES,
            markAnnouncementSeen,
            shouldShowAnnouncement,
        } = mod;

        if (!ANNOUNCEMENT_VERSION || ANNOUNCEMENT_FEATURES.length === 0) {
            return;
        }

        markAnnouncementSeen("0.0.0-pre-historic");
        expect(shouldShowAnnouncement()).toBe(true);
    });

    test("does NOT re-announce on a downgrade (stored version is newer)", async () => {
        const mod = await import(`./announcement?t=${Date.now()}-downgrade`);
        const {
            ANNOUNCEMENT_VERSION,
            ANNOUNCEMENT_FEATURES,
            markAnnouncementSeen,
            shouldShowAnnouncement,
        } = mod;

        if (!ANNOUNCEMENT_VERSION || ANNOUNCEMENT_FEATURES.length === 0) {
            return;
        }

        // A stored version newer than the running binary indicates a downgrade.
        // String inequality would re-show an older announcement after a downgrade.
        // The gate returns false when ANNOUNCEMENT_VERSION is empty, ANNOUNCEMENT_FEATURES has no entries, no stored mark exists, or the current version is not greater than the stored version.
        markAnnouncementSeen("999.0.0");
        expect(shouldShowAnnouncement()).toBe(false);
    });
});
