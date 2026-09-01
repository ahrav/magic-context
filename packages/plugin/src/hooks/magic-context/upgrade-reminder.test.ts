import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage";
import {
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../features/magic-context/storage-meta-session";
import {
    __resetUpgradeReminderProcessGuard,
    MAX_UPGRADE_REMINDERS_PER_SESSION,
    maybeSendUpgradeReminder,
    UPGRADE_REMINDER_COOLDOWN_MS,
    type UpgradeReminderDeps,
} from "./upgrade-reminder";

let prevDataHome: string | undefined;
let tempHome: string;

beforeEach(() => {
    prevDataHome = process.env.XDG_DATA_HOME;
    tempHome = mkdtempSync(join(tmpdir(), "mc-upgrade-rem-"));
    process.env.XDG_DATA_HOME = tempHome;
    mkdirSync(join(tempHome, "cortexkit", "magic-context"), { recursive: true });
    closeDatabase();
    __resetUpgradeReminderProcessGuard();
});

afterEach(() => {
    closeDatabase();
    if (prevDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevDataHome;
    rmSync(tempHome, { recursive: true, force: true });
});

function insertLegacyCompartment(db: ReturnType<typeof openDatabase>, sessionId: string): void {
    db.prepare(
        `INSERT INTO compartments (session_id, sequence, title, content, start_message, end_message, start_message_id, end_message_id, legacy, created_at)
         VALUES (?, 0, 'old', 'flat content', 1, 5, 'm1', 'm5', 1, ?)`,
    ).run(sessionId, Date.now());
}

function insertStagedCompartment(
    db: ReturnType<typeof openDatabase>,
    sessionId: string,
    seq: number,
    endMessage: number,
): void {
    db.prepare(
        `INSERT INTO recomp_compartments (session_id, sequence, start_message, end_message, title, content, pass_number, created_at)
         VALUES (?, ?, 1, ?, 'staged', 'partial', 1, ?)`,
    ).run(sessionId, seq, endMessage, Date.now());
}

/* */
function insertV2Compartment(db: ReturnType<typeof openDatabase>, sessionId: string): void {
    db.prepare(
        `INSERT INTO compartments (session_id, sequence, title, content, p1, p2, p3, p4, importance, start_message, end_message, start_message_id, end_message_id, legacy, created_at)
         VALUES (?, 0, 'new', 'p1 body', 'p1 body', 'p2', 'p3', 'p4', 50, 1, 5, 'm1', 'm5', 0, ?)`,
    ).run(sessionId, Date.now());
}

function countStaging(db: ReturnType<typeof openDatabase>, sessionId: string): number {
    const row = db
        .prepare("SELECT COUNT(*) AS c FROM recomp_compartments WHERE session_id = ?")
        .get(sessionId) as { c: number };
    return row.c;
}

function makeDeps(
    db: ReturnType<typeof openDatabase>,
    sent: string[],
    opts?: {
        tuiConnected?: boolean;
        dialogActions?: string[];
        resumeCaptures?: Array<{ sid: string; resume: unknown }>;
    },
): UpgradeReminderDeps {
    return {
        client: {},
        db,
        sendIgnoredMessage: async (_client, _sid, text) => {
            sent.push(text);
            return "sent";
        },
        getNotificationParams: () => ({}),
        // isTuiConnected defaults to false so assertions use the ignored-message path.
        isTuiConnected: () => opts?.tuiConnected ?? false,
        pushTuiDialogAction: (sid, resume) => {
            opts?.dialogActions?.push(sid);
            opts?.resumeCaptures?.push({ sid, resume });
        },
    };
}

describe("E5 upgrade reminder", () => {
    it("records the first delivered reminder for the durable cooldown", async () => {
        const db = openDatabase();
        insertLegacyCompartment(db, "ses-legacy");
        const sent: string[] = [];

        await maybeSendUpgradeReminder(makeDeps(db, sent), "ses-legacy");

        expect(sent).toHaveLength(1);
        expect(sent[0]).toContain("/ctx-session-upgrade");
        expect(getOrCreateSessionMeta(db, "ses-legacy")).toMatchObject({
            upgradeRemindedAt: null,
            upgradeReminderCount: 1,
            upgradeReminderLastSentAt: expect.any(Number),
        });
    });

    it("enqueues a TUI dialog action (not an ignored message) when a TUI is connected", async () => {
        const db = openDatabase();
        insertLegacyCompartment(db, "ses-tui");
        const sent: string[] = [];
        const dialogActions: string[] = [];

        await maybeSendUpgradeReminder(
            makeDeps(db, sent, { tuiConnected: true, dialogActions }),
            "ses-tui",
        );

        expect(dialogActions).toEqual(["ses-tui"]);
        expect(sent).toHaveLength(0);
        // TUI display leaves upgradeRemindedAt unset; dismiss-upgrade-reminder sets it after Confirm or Cancel so closing the dialog does not suppress future reminders.
        expect(getOrCreateSessionMeta(db, "ses-tui").upgradeRemindedAt).toBeNull();
    });

    it("suppresses a re-opened TUI dialog until the durable cooldown expires", async () => {
        const db = openDatabase();
        insertLegacyCompartment(db, "ses-tui-interrupted");
        const dialogActions: string[] = [];

        await maybeSendUpgradeReminder(
            makeDeps(db, [], { tuiConnected: true, dialogActions }),
            "ses-tui-interrupted",
        );
        // Clearing the in-memory guard simulates a process restart before dismissal.
        __resetUpgradeReminderProcessGuard();
        await maybeSendUpgradeReminder(
            makeDeps(db, [], { tuiConnected: true, dialogActions }),
            "ses-tui-interrupted",
        );

        // The shared delivery timestamp keeps a reopened process from immediately showing the dismissible dialog.
        expect(dialogActions).toEqual(["ses-tui-interrupted"]);
    });

    it("does not stamp when the ignored-message delivery is skipped", async () => {
        const db = openDatabase();
        insertLegacyCompartment(db, "ses-skip");
        const attempts: string[] = [];
        const deps: UpgradeReminderDeps = {
            ...makeDeps(db, attempts),
            sendIgnoredMessage: async (_client, _sid, text) => {
                attempts.push(text);
                return "skipped";
            },
        };

        await maybeSendUpgradeReminder(deps, "ses-skip");

        expect(attempts).toHaveLength(1);
        expect(getOrCreateSessionMeta(db, "ses-skip").upgradeRemindedAt).toBeNull();

        __resetUpgradeReminderProcessGuard();
        await maybeSendUpgradeReminder(deps, "ses-skip");

        expect(attempts).toHaveLength(2);
        expect(getOrCreateSessionMeta(db, "ses-skip").upgradeRemindedAt).toBeNull();
    });

    it("suppresses a delivered reminder within the cooldown on a new process", async () => {
        const db = openDatabase();
        insertLegacyCompartment(db, "ses-legacy");
        const sent: string[] = [];

        await maybeSendUpgradeReminder(makeDeps(db, sent), "ses-legacy");
        // Clearing the in-process guard simulates a restart; the durable cooldown still applies.
        __resetUpgradeReminderProcessGuard();
        await maybeSendUpgradeReminder(makeDeps(db, sent), "ses-legacy");

        expect(sent).toHaveLength(1);
    });

    it("RE-fires a resume prompt after an interrupted upgrade even with the stamp set", async () => {
        const db = openDatabase();
        insertLegacyCompartment(db, "ses-resume");
        // The fixture simulates a stamped reminder and three staged passes through message 120 before the user closes the upgrade.
        updateSessionMeta(db, "ses-resume", { upgradeRemindedAt: Date.now() });
        insertStagedCompartment(db, "ses-resume", 0, 40);
        insertStagedCompartment(db, "ses-resume", 1, 80);
        insertStagedCompartment(db, "ses-resume", 2, 120);
        const sent: string[] = [];

        // beforeEach clears the in-memory guard to simulate a new process.
        await maybeSendUpgradeReminder(makeDeps(db, sent), "ses-resume");

        // Despite the durable stamp, the resume prompt fires (non-TUI text path).
        expect(sent).toHaveLength(1);
        expect(sent[0]).toContain("interrupted");
        expect(sent[0]).toContain("3 compartments were already rebuilt");
        expect(sent[0]).toContain("message 120");
    });

    it("passes resume info to the TUI dialog action on an interrupted upgrade", async () => {
        const db = openDatabase();
        insertLegacyCompartment(db, "ses-resume-tui");
        updateSessionMeta(db, "ses-resume-tui", { upgradeRemindedAt: Date.now() });
        insertStagedCompartment(db, "ses-resume-tui", 0, 55);
        const sent: string[] = [];
        const dialogActions: string[] = [];
        const resumeCaptures: Array<{ sid: string; resume: unknown }> = [];

        await maybeSendUpgradeReminder(
            makeDeps(db, sent, { tuiConnected: true, dialogActions, resumeCaptures }),
            "ses-resume-tui",
        );

        expect(dialogActions).toEqual(["ses-resume-tui"]);
        expect(resumeCaptures).toEqual([
            { sid: "ses-resume-tui", resume: { stagedCount: 1, stagedThrough: 55 } },
        ]);
    });

    it("does not re-fire within the same process even before the stamp is read back", async () => {
        const db = openDatabase();
        insertLegacyCompartment(db, "ses-legacy");
        const sent: string[] = [];

        await maybeSendUpgradeReminder(makeDeps(db, sent), "ses-legacy");
        await maybeSendUpgradeReminder(makeDeps(db, sent), "ses-legacy");

        expect(sent).toHaveLength(1);
    });

    it("skips sessions with no legacy compartments and does NOT stamp", async () => {
        const db = openDatabase();
        getOrCreateSessionMeta(db, "ses-clean");
        const sent: string[] = [];

        await maybeSendUpgradeReminder(makeDeps(db, sent), "ses-clean");

        expect(sent).toHaveLength(0);
        // Restored pre-v2 sessions remain eligible for reminders.
        expect(getOrCreateSessionMeta(db, "ses-clean").upgradeRemindedAt).toBeNull();
    });

    it("transient Pi delivery uses the same cooldown without an explicit-dismissal stamp", async () => {
        // Pi delivers via ctx.ui.notify — a transient toast with no scrollback.
        // Pi toast delivery ignores the explicit-dismissal stamp but persists the shared cooldown and cap to prevent repeated process starts from looping toasts.
        const db = openDatabase();
        insertLegacyCompartment(db, "ses-pi");
        const sent: string[] = [];
        const deps = (): UpgradeReminderDeps => ({
            ...makeDeps(db, sent),
            deliveryPersists: false,
        });

        await maybeSendUpgradeReminder(deps(), "ses-pi");
        expect(sent).toHaveLength(1);
        // A transient toast does not set a durable stamp.
        expect(getOrCreateSessionMeta(db, "ses-pi").upgradeRemindedAt).toBeNull();

        // New process (guard cleared) still respects the persisted cooldown.
        __resetUpgradeReminderProcessGuard();
        await maybeSendUpgradeReminder(deps(), "ses-pi");
        expect(sent).toHaveLength(1);
    });

    it("transient delivery ignores a stale explicit-dismissal stamp", async () => {
        // A stale explicit-dismissal stamp does not suppress transient delivery.
        const db = openDatabase();
        insertLegacyCompartment(db, "ses-pi-stale");
        updateSessionMeta(db, "ses-pi-stale", { upgradeRemindedAt: Date.now() });
        const sent: string[] = [];

        await maybeSendUpgradeReminder(
            { ...makeDeps(db, sent), deliveryPersists: false },
            "ses-pi-stale",
        );

        // The transient toast fires despite the stale stamp; the per-process guard controls delivery.
        expect(sent).toHaveLength(1);
    });

    it("fires at most three reminders per session even after every cooldown", async () => {
        const db = openDatabase();
        insertLegacyCompartment(db, "ses-capped");
        const sent: string[] = [];

        for (
            let expectedCount = 1;
            expectedCount <= MAX_UPGRADE_REMINDERS_PER_SESSION;
            expectedCount++
        ) {
            await maybeSendUpgradeReminder(makeDeps(db, sent), "ses-capped");
            expect(getOrCreateSessionMeta(db, "ses-capped").upgradeReminderCount).toBe(
                expectedCount,
            );
            updateSessionMeta(db, "ses-capped", {
                upgradeReminderLastSentAt: Date.now() - UPGRADE_REMINDER_COOLDOWN_MS - 1,
            });
            __resetUpgradeReminderProcessGuard();
        }

        await maybeSendUpgradeReminder(makeDeps(db, sent), "ses-capped");
        expect(sent).toHaveLength(MAX_UPGRADE_REMINDERS_PER_SESSION);
        expect(getOrCreateSessionMeta(db, "ses-capped").upgradeReminderCount).toBe(
            MAX_UPGRADE_REMINDERS_PER_SESSION,
        );
    });

    it("skips subagent sessions", async () => {
        const db = openDatabase();
        insertLegacyCompartment(db, "ses-sub");
        updateSessionMeta(db, "ses-sub", { isSubagent: true });
        const sent: string[] = [];

        await maybeSendUpgradeReminder(makeDeps(db, sent), "ses-sub");

        expect(sent).toHaveLength(0);
    });

    it("does NOT show a resume prompt for a fully-upgraded session with orphan staging, and clears it", async () => {
        // A session with only v2 compartments must not show a resume dialog because leftover recomp_compartments rows do not satisfy the legacy-compartment gate.
        const db = openDatabase();
        insertV2Compartment(db, "ses-done"); // fully upgraded
        insertStagedCompartment(db, "ses-done", 0, 40069); // orphan staging
        insertStagedCompartment(db, "ses-done", 1, 40070);
        expect(countStaging(db, "ses-done")).toBe(2);
        const sent: string[] = [];
        const dialogActions: string[] = [];

        await maybeSendUpgradeReminder(
            makeDeps(db, sent, { tuiConnected: true, dialogActions }),
            "ses-done",
        );

        expect(sent).toHaveLength(0);
        expect(dialogActions).toHaveLength(0);
        // Garbage collection removes orphan staging so it cannot trigger a prompt after restart.
        expect(countStaging(db, "ses-done")).toBe(0);
        // Not stamped.
        expect(getOrCreateSessionMeta(db, "ses-done").upgradeRemindedAt).toBeNull();
    });

    it("STILL resumes a genuinely interrupted upgrade (legacy compartments remain + staging present)", async () => {
        // Legacy compartments require a resume prompt even when staging exists.
        // resume prompt must still fire even with staging present.
        const db = openDatabase();
        insertLegacyCompartment(db, "ses-mid"); // still has legacy → needs upgrade
        insertStagedCompartment(db, "ses-mid", 0, 200); // partial progress
        const sent: string[] = [];
        const dialogActions: string[] = [];
        const resumeCaptures: Array<{ sid: string; resume: unknown }> = [];

        await maybeSendUpgradeReminder(
            makeDeps(db, sent, { tuiConnected: true, dialogActions, resumeCaptures }),
            "ses-mid",
        );

        expect(dialogActions).toEqual(["ses-mid"]);
        expect(resumeCaptures[0]?.resume).toMatchObject({ stagedCount: 1, stagedThrough: 200 });
        // Resumption requires staging.
        expect(countStaging(db, "ses-mid")).toBe(1);
    });
});
