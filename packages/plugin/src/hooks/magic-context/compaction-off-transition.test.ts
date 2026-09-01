/// <reference types="bun-types" />

/**
 *
 * crash protocol.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
    closeCompactionMarkerDb,
    getOpenCodeDbPath,
    removeMcOwnedCompactionMarkers,
} from "../../features/magic-context/compaction-marker";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    getPendingOps,
    openDatabase,
    queuePendingOp,
    recordOverflowDetected,
} from "../../features/magic-context/storage";
import {
    getChannel2NudgeState,
    getCompactionModeRecord,
    getOverflowState,
    getPendingCompactionMarkerState,
    getPersistedCompactionMarkerState,
    resolveCompactionModeRecord,
    setChannel2NudgeState,
    setCompactionModeRecord,
    setPendingCompactionMarkerState,
    setPersistedCompactionMarkerState,
} from "../../features/magic-context/storage-meta-persisted";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { MARKER_SUMMARY_TEXT } from "./compaction-marker-manager";
import {
    COMPACTION_OFF_FLIP_NOTICE,
    COMPACTION_ON_WRAPUP_SUGGESTION,
    commitCompactionModeRecord,
    reconcileCompactionMode,
} from "./compaction-off-transition";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

afterEach(() => {
    closeCompactionMarkerDb();
    closeDatabase();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            /* ignore */
        }
    }
    tempDirs.length = 0;
});

function useTempDataHome(prefix: string): void {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

interface OcMessage {
    id: string;
    role: string;
    data?: Record<string, unknown>;
    timeCreated?: number;
}

interface OcPart {
    id: string;
    messageId: string;
    data: Record<string, unknown>;
}

function createOpenCodeDb(sessionId: string): Database {
    const dbPath = getOpenCodeDbPath();
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.exec(`
        CREATE TABLE IF NOT EXISTS message (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL,
            data TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS part (
            id TEXT PRIMARY KEY,
            message_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL,
            data TEXT NOT NULL
        );
    `);
    void sessionId;
    return db;
}

function insertMessage(db: Database, sessionId: string, message: OcMessage): void {
    const time = message.timeCreated ?? 1;
    const data = {
        id: message.id,
        role: message.role,
        sessionID: sessionId,
        ...(message.data ?? {}),
    };
    db.prepare(
        "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    ).run(message.id, sessionId, time, time, JSON.stringify(data));
}

function insertPart(db: Database, sessionId: string, part: OcPart): void {
    db.prepare(
        "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(part.id, part.messageId, sessionId, 1, 1, JSON.stringify(part.data));
}

/* */
function insertCanonicalMcMarker(
    db: Database,
    sessionId: string,
    args: { boundaryMessageId: string; summaryId: string; partId: string; summaryPartId: string },
): void {
    insertPart(db, sessionId, {
        id: args.partId,
        messageId: args.boundaryMessageId,
        data: { type: "compaction", auto: true },
    });
    insertMessage(db, sessionId, {
        id: args.summaryId,
        role: "assistant",
        data: {
            parentID: args.boundaryMessageId,
            summary: true,
            finish: "stop",
            providerID: "magic-context",
            modelID: "magic-context",
        },
    });
    insertPart(db, sessionId, {
        id: args.summaryPartId,
        messageId: args.summaryId,
        data: { type: "text", text: MARKER_SUMMARY_TEXT },
    });
}

/** MC ownership never matches native OpenCode `/compact` markers. */
function insertNativeMarker(
    db: Database,
    sessionId: string,
    args: {
        boundaryMessageId: string;
        summaryId: string;
        partId: string;
        summaryPartId: string;
        tailStartId?: string;
    },
): void {
    insertPart(db, sessionId, {
        id: args.partId,
        messageId: args.boundaryMessageId,
        data: {
            type: "compaction",
            auto: true,
            ...(args.tailStartId ? { tail_start_id: args.tailStartId } : {}),
        },
    });
    insertMessage(db, sessionId, {
        id: args.summaryId,
        role: "assistant",
        data: {
            parentID: args.boundaryMessageId,
            summary: true,
            finish: "stop",
            providerID: "anthropic",
            modelID: "claude-sonnet-4-5",
        },
    });
    insertPart(db, sessionId, {
        id: args.summaryPartId,
        messageId: args.summaryId,
        data: { type: "text", text: "Native compaction summary" },
    });
}

function dumpRows(
    db: Database,
    sessionId: string,
): {
    messages: Array<{ id: string; data: string }>;
    parts: Array<{ id: string; message_id: string; data: string }>;
} {
    const messages = db
        .prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id")
        .all(sessionId) as Array<{ id: string; data: string }>;
    const parts = db
        .prepare(
            "SELECT id, message_id, data FROM part WHERE session_id = ? ORDER BY message_id, id",
        )
        .all(sessionId) as Array<{ id: string; message_id: string; data: string }>;
    return { messages, parts };
}

function countSummaryMessages(db: Database, sessionId: string): number {
    const row = db
        .prepare(
            `SELECT COUNT(*) AS n FROM message
             WHERE session_id = ?
               AND COALESCE(json_extract(data, '$.summary'), 0) = 1
               AND COALESCE(json_extract(data, '$.finish'), '') = 'stop'`,
        )
        .get(sessionId) as { n: number };
    return row.n;
}

describe("removeMcOwnedCompactionMarkers (flip-off deletion contract)", () => {
    it("deletes the canonical MC lineage: compaction part + summary rows together, never the boundary user row", () => {
        useTempDataHome("mc-marker-canonical-");
        const db = createOpenCodeDb("ses-1");
        try {
            insertMessage(db, "ses-1", { id: "msg-user-1", role: "user" });
            insertPart(db, "ses-1", {
                id: "prt-user-1-text",
                messageId: "msg-user-1",
                data: { type: "text", text: "real user history" },
            });
            insertCanonicalMcMarker(db, "ses-1", {
                boundaryMessageId: "msg-user-1",
                summaryId: "msg-mc-summary",
                partId: "prt-mc-compaction",
                summaryPartId: "prt-mc-summary-text",
            });

            const result = removeMcOwnedCompactionMarkers("ses-1", MARKER_SUMMARY_TEXT);

            expect(result.verified).toBe(true);
            expect(result.removedLineages).toBe(1);
            expect(result.removedRows).toBe(3);
            expect(result.retainedLineages).toBe(0);
            // The boundary USER row is real history — never deleted.
            const userRow = db.prepare("SELECT id FROM message WHERE id = 'msg-user-1'").get();
            expect(userRow).not.toBeNull();
            const userTextPart = db
                .prepare("SELECT id FROM part WHERE id = 'prt-user-1-text'")
                .get();
            expect(userTextPart).not.toBeNull();
            // Deletion removes the stranded summary assistant row and its parts with the compaction part.
            // model history.
            expect(countSummaryMessages(db, "ses-1")).toBe(0);
            expect(
                db.prepare("SELECT id FROM part WHERE id = 'prt-mc-compaction'").get(),
            ).toBeNull();
            expect(
                db.prepare("SELECT id FROM part WHERE id = 'prt-mc-summary-text'").get(),
            ).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    it("deletes supported LEGACY MC lineages (marker-text summaries without the provider identity)", () => {
        useTempDataHome("mc-marker-legacy-");
        const db = createOpenCodeDb("ses-1");
        try {
            insertMessage(db, "ses-1", { id: "msg-user-1", role: "user" });
            // The matcher identifies legacy summaries without `providerID` by exact marker text.
            insertMessage(db, "ses-1", {
                id: "msg-legacy-summary",
                role: "assistant",
                data: { parentID: "msg-user-1", summary: true, finish: "stop" },
            });
            insertPart(db, "ses-1", {
                id: "prt-legacy-summary-text",
                messageId: "msg-legacy-summary",
                data: { type: "text", text: MARKER_SUMMARY_TEXT },
            });
            insertPart(db, "ses-1", {
                id: "prt-mc-compaction",
                messageId: "msg-user-1",
                data: { type: "compaction", auto: true },
            });

            const result = removeMcOwnedCompactionMarkers("ses-1", MARKER_SUMMARY_TEXT);

            expect(result.removedLineages).toBe(1);
            expect(countSummaryMessages(db, "ses-1")).toBe(0);
            expect(
                db.prepare("SELECT id FROM part WHERE id = 'prt-mc-compaction'").get(),
            ).toBeNull();
            expect(
                db.prepare("SELECT id FROM message WHERE id = 'msg-user-1'").get(),
            ).not.toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    it("retains a lineage when a surviving compaction part's tail_start_id references a row to be deleted (never blind-delete)", () => {
        useTempDataHome("mc-marker-dangling-tail-");
        const db = createOpenCodeDb("ses-1");
        try {
            insertMessage(db, "ses-1", { id: "msg-user-1", role: "user" });
            insertCanonicalMcMarker(db, "ses-1", {
                boundaryMessageId: "msg-user-1",
                summaryId: "msg-mc-summary",
                partId: "prt-mc-compaction",
                summaryPartId: "prt-mc-summary-text",
            });
            // The lineage must be retained because a native compaction part on another boundary targets its summary row through `tail_start_id`.
            insertMessage(db, "ses-1", { id: "msg-user-2", role: "user", timeCreated: 5 });
            insertNativeMarker(db, "ses-1", {
                boundaryMessageId: "msg-user-2",
                summaryId: "msg-native-summary",
                partId: "prt-native-compaction",
                summaryPartId: "prt-native-summary-text",
                tailStartId: "msg-mc-summary",
            });

            const result = removeMcOwnedCompactionMarkers("ses-1", MARKER_SUMMARY_TEXT);

            expect(result.retainedLineages).toBe(1);
            expect(result.removedRows).toBe(0);
            // Every MC row is still present (retained, not blind-deleted).
            expect(
                db.prepare("SELECT id FROM message WHERE id = 'msg-mc-summary'").get(),
            ).not.toBeNull();
            expect(
                db.prepare("SELECT id FROM part WHERE id = 'prt-mc-compaction'").get(),
            ).not.toBeNull();
            // Deletion leaves native rows untouched.
            expect(
                db.prepare("SELECT id FROM message WHERE id = 'msg-native-summary'").get(),
            ).not.toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    it("retains a lineage when a surviving native tail points at the MC compaction PART id", () => {
        useTempDataHome("mc-marker-dangling-part-tail-");
        const db = createOpenCodeDb("ses-1");
        try {
            insertMessage(db, "ses-1", { id: "msg-user-1", role: "user" });
            insertCanonicalMcMarker(db, "ses-1", {
                boundaryMessageId: "msg-user-1",
                summaryId: "msg-mc-summary",
                partId: "prt-mc-compaction",
                summaryPartId: "prt-mc-summary-text",
            });
            insertMessage(db, "ses-1", { id: "msg-user-2", role: "user", timeCreated: 5 });
            insertNativeMarker(db, "ses-1", {
                boundaryMessageId: "msg-user-2",
                summaryId: "msg-native-summary",
                partId: "prt-native-compaction",
                summaryPartId: "prt-native-summary-text",
                tailStartId: "prt-mc-compaction",
            });

            const result = removeMcOwnedCompactionMarkers("ses-1", MARKER_SUMMARY_TEXT);

            expect(result.verified).toBe(false);
            expect(result.retainedLineages).toBe(1);
            expect(result.removedRows).toBe(0);
            expect(
                db.prepare("SELECT id FROM part WHERE id = 'prt-mc-compaction'").get(),
            ).not.toBeNull();
            expect(
                db.prepare("SELECT id FROM part WHERE id = 'prt-native-compaction'").get(),
            ).not.toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    it("preserves a hand-written compaction part without an exact MC payload signature", () => {
        useTempDataHome("mc-marker-foreign-part-");
        const db = createOpenCodeDb("ses-1");
        try {
            insertMessage(db, "ses-1", { id: "msg-user-1", role: "user" });
            insertCanonicalMcMarker(db, "ses-1", {
                boundaryMessageId: "msg-user-1",
                summaryId: "msg-mc-summary",
                partId: "prt-mc-compaction",
                summaryPartId: "prt-mc-summary-text",
            });
            insertPart(db, "ses-1", {
                id: "prt-hand-written-compaction",
                messageId: "msg-user-1",
                data: { type: "compaction", auto: true, source: "hand-written" },
            });

            const result = removeMcOwnedCompactionMarkers("ses-1", MARKER_SUMMARY_TEXT);

            expect(result.verified).toBe(true);
            expect(result.removedLineages).toBe(1);
            expect(
                db.prepare("SELECT id FROM part WHERE id = 'prt-mc-compaction'").get(),
            ).toBeNull();
            expect(
                db.prepare("SELECT id FROM part WHERE id = 'prt-hand-written-compaction'").get(),
            ).not.toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    it("mixed ordering — native boundary NEWER than MC: deletes only MC rows, native boundary stays authoritative", () => {
        useTempDataHome("mc-marker-native-after-");
        const db = createOpenCodeDb("ses-1");
        try {
            insertMessage(db, "ses-1", { id: "msg-user-1", role: "user" });
            insertCanonicalMcMarker(db, "ses-1", {
                boundaryMessageId: "msg-user-1",
                summaryId: "msg-mc-summary",
                partId: "prt-mc-compaction",
                summaryPartId: "prt-mc-summary-text",
            });
            insertMessage(db, "ses-1", { id: "msg-user-2", role: "user", timeCreated: 5 });
            // Native `tail_start_id` points to a surviving message, so preflight does not retain the lineage.
            insertNativeMarker(db, "ses-1", {
                boundaryMessageId: "msg-user-2",
                summaryId: "msg-native-summary",
                partId: "prt-native-compaction",
                summaryPartId: "prt-native-summary-text",
                tailStartId: "msg-user-2",
            });

            const result = removeMcOwnedCompactionMarkers("ses-1", MARKER_SUMMARY_TEXT);

            expect(result.removedLineages).toBe(1);
            expect(result.retainedLineages).toBe(0);
            // The native compaction part still hides its span.
            expect(
                db.prepare("SELECT id FROM message WHERE id = 'msg-native-summary'").get(),
            ).not.toBeNull();
            expect(
                db.prepare("SELECT id FROM part WHERE id = 'prt-native-compaction'").get(),
            ).not.toBeNull();
            expect(
                db.prepare("SELECT id FROM part WHERE id = 'prt-native-summary-text'").get(),
            ).not.toBeNull();
            expect(countSummaryMessages(db, "ses-1")).toBe(1); // only the native summary
        } finally {
            closeQuietly(db);
        }
    });

    it("mixed ordering — MC boundary NEWER than native: deletes only MC rows, the surviving native boundary still hides its span", () => {
        useTempDataHome("mc-marker-mc-after-");
        const db = createOpenCodeDb("ses-1");
        try {
            insertMessage(db, "ses-1", { id: "msg-user-1", role: "user" });
            insertNativeMarker(db, "ses-1", {
                boundaryMessageId: "msg-user-1",
                summaryId: "msg-native-summary",
                partId: "prt-native-compaction",
                summaryPartId: "prt-native-summary-text",
            });
            insertMessage(db, "ses-1", { id: "msg-user-2", role: "user", timeCreated: 5 });
            insertCanonicalMcMarker(db, "ses-1", {
                boundaryMessageId: "msg-user-2",
                summaryId: "msg-mc-summary",
                partId: "prt-mc-compaction",
                summaryPartId: "prt-mc-summary-text",
            });

            const result = removeMcOwnedCompactionMarkers("ses-1", MARKER_SUMMARY_TEXT);

            expect(result.removedLineages).toBe(1);
            expect(result.retainedLineages).toBe(0);
            expect(countSummaryMessages(db, "ses-1")).toBe(1);
            expect(
                db.prepare("SELECT id FROM message WHERE id = 'msg-native-summary'").get(),
            ).not.toBeNull();
            expect(
                db.prepare("SELECT id FROM message WHERE id = 'msg-mc-summary'").get(),
            ).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    it("never matches native-only sessions (zero rows removed)", () => {
        useTempDataHome("mc-marker-native-only-");
        const db = createOpenCodeDb("ses-1");
        try {
            insertMessage(db, "ses-1", { id: "msg-user-1", role: "user" });
            insertNativeMarker(db, "ses-1", {
                boundaryMessageId: "msg-user-1",
                summaryId: "msg-native-summary",
                partId: "prt-native-compaction",
                summaryPartId: "prt-native-summary-text",
            });
            const before = dumpRows(db, "ses-1");

            const result = removeMcOwnedCompactionMarkers("ses-1", MARKER_SUMMARY_TEXT);

            expect(result.removedLineages).toBe(0);
            expect(result.removedRows).toBe(0);
            expect(dumpRows(db, "ses-1")).toEqual(before);
        } finally {
            closeQuietly(db);
        }
    });

    it("is idempotent: second run reports ZERO affected rows and leaves the relevant row sets unchanged", () => {
        useTempDataHome("mc-marker-idempotent-");
        const db = createOpenCodeDb("ses-1");
        try {
            insertMessage(db, "ses-1", { id: "msg-user-1", role: "user" });
            insertCanonicalMcMarker(db, "ses-1", {
                boundaryMessageId: "msg-user-1",
                summaryId: "msg-mc-summary",
                partId: "prt-mc-compaction",
                summaryPartId: "prt-mc-summary-text",
            });
            insertMessage(db, "ses-1", { id: "msg-user-2", role: "user", timeCreated: 5 });
            insertNativeMarker(db, "ses-1", {
                boundaryMessageId: "msg-user-2",
                summaryId: "msg-native-summary",
                partId: "prt-native-compaction",
                summaryPartId: "prt-native-summary-text",
            });

            const first = removeMcOwnedCompactionMarkers("ses-1", MARKER_SUMMARY_TEXT);
            expect(first.removedRows).toBeGreaterThan(0);
            const afterFirst = dumpRows(db, "ses-1");

            const second = removeMcOwnedCompactionMarkers("ses-1", MARKER_SUMMARY_TEXT);
            expect(second.removedLineages).toBe(0);
            expect(second.removedRows).toBe(0);
            expect(second.retainedLineages).toBe(0);
            // The test compares rows rather than database bytes because WAL and journaling can change bytes without changing rows.
            expect(dumpRows(db, "ses-1")).toEqual(afterFirst);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("reconcileCompactionMode — transition algebra", () => {
    it("keeps an unverified cleanup retry durable until the schema becomes verifiable", () => {
        useTempDataHome("mc-mode-schema-retry-");
        const ocDb = createOpenCodeDb("ses-1");
        insertMessage(ocDb, "ses-1", { id: "msg-user-1", role: "user" });
        insertCanonicalMcMarker(ocDb, "ses-1", {
            boundaryMessageId: "msg-user-1",
            summaryId: "msg-mc-summary",
            partId: "prt-mc-compaction",
            summaryPartId: "prt-mc-summary-text",
        });
        ocDb.exec("ALTER TABLE part DROP COLUMN time_updated");

        const db = openDatabase();
        getOrCreateSessionMeta(db, "ses-1");
        const first = reconcileCompactionMode({
            db,
            sessionId: "ses-1",
            compactionOff: true,
            historianRunnable: true,
            compartmentInProgress: false,
        });

        expect(first.markerCleanup.verified).toBe(false);
        expect(first.recordToWrite).toBeNull();
        // Failed verification remains durable so later passes retry cleanup.
        expect(getCompactionModeRecord(db, "ses-1")).toBe("off_cleanup_pending");
        expect(
            ocDb.prepare("SELECT id FROM part WHERE id = 'prt-mc-compaction'").get(),
        ).not.toBeNull();

        // Resetting the probe cache emulates a process boundary.
        closeCompactionMarkerDb();
        ocDb.exec("ALTER TABLE part ADD COLUMN time_updated INTEGER NOT NULL DEFAULT 0");
        const second = reconcileCompactionMode({
            db,
            sessionId: "ses-1",
            compactionOff: true,
            historianRunnable: true,
            compartmentInProgress: false,
        });

        expect(second.markerCleanup.verified).toBe(true);
        expect(second.markerCleanup.removedLineages).toBe(1);
        expect(second.recordToWrite).toBe("off");
        commitCompactionModeRecord(db, "ses-1", second.recordToWrite!);
        expect(getCompactionModeRecord(db, "ses-1")).toBe("off");
        expect(ocDb.prepare("SELECT id FROM part WHERE id = 'prt-mc-compaction'").get()).toBeNull();
        closeQuietly(ocDb);
    });

    it("keeps notice delivery and unverified marker cleanup independently durable", () => {
        useTempDataHome("mc-mode-unverified-notice-retry-");
        const ocDb = createOpenCodeDb("ses-1");
        insertMessage(ocDb, "ses-1", { id: "msg-user-1", role: "user" });
        insertCanonicalMcMarker(ocDb, "ses-1", {
            boundaryMessageId: "msg-user-1",
            summaryId: "msg-mc-summary",
            partId: "prt-mc-compaction",
            summaryPartId: "prt-mc-summary-text",
        });
        ocDb.exec("ALTER TABLE part DROP COLUMN time_updated");

        const db = openDatabase();
        getOrCreateSessionMeta(db, "ses-1");
        queuePendingOp(db, "ses-1", 9, "drop");
        const first = reconcileCompactionMode({
            db,
            sessionId: "ses-1",
            compactionOff: true,
            historianRunnable: true,
            compartmentInProgress: false,
        });

        expect(first.markerCleanup.verified).toBe(false);
        expect(first.notice).toBe(COMPACTION_OFF_FLIP_NOTICE);
        // Replacing `off_notice_pending` with `null` lets a verified no-op suppress the flip notice.
        expect(getCompactionModeRecord(db, "ses-1")).toBe("off_notice_pending");
        expect(getPendingOps(db, "ses-1")).toEqual([]);

        // The cleanup-only state preserves marker cleanup's retry obligation after notice delivery.
        commitCompactionModeRecord(db, "ses-1", first.recordToWrite!);
        expect(getCompactionModeRecord(db, "ses-1")).toBe("off_cleanup_pending");

        closeCompactionMarkerDb();
        ocDb.exec("ALTER TABLE part ADD COLUMN time_updated INTEGER NOT NULL DEFAULT 0");
        const second = reconcileCompactionMode({
            db,
            sessionId: "ses-1",
            compactionOff: true,
            historianRunnable: true,
            compartmentInProgress: false,
        });

        expect(second.markerCleanup.verified).toBe(true);
        expect(second.notice).toBeNull();
        expect(second.recordToWrite).toBe("off");
        commitCompactionModeRecord(db, "ses-1", second.recordToWrite!);
        expect(getCompactionModeRecord(db, "ses-1")).toBe("off");
        closeQuietly(ocDb);
    });

    it("parses settled and pending records while preserving legacy no-record behavior", () => {
        useTempDataHome("mc-mode-record-domain-");
        const db = openDatabase();
        getOrCreateSessionMeta(db, "ses-1");
        const cases = [
            [null, null],
            ["on", "on"],
            ["off", "off"],
            ["on_notice_pending", "on"],
            ["off_notice_pending", "off"],
            ["off_cleanup_pending", "off"],
        ] as const;

        for (const [stored, resolved] of cases) {
            setCompactionModeRecord(db, "ses-1", stored);
            const record = getCompactionModeRecord(db, "ses-1");
            expect(resolveCompactionModeRecord(record)).toBe(resolved);
        }
        // Unknown values remain fail-closed as no record and do not widen the mode domain.
        db.prepare(
            "UPDATE session_meta SET compaction_mode_record = 'legacy' WHERE session_id = ?",
        ).run("ses-1");
        expect(getCompactionModeRecord(db, "ses-1")).toBeNull();
    });

    it("no record + on → writes 'on', no transition work, no notice", () => {
        useTempDataHome("mc-mode-norecord-on-");
        const db = openDatabase();
        getOrCreateSessionMeta(db, "ses-1");

        const result = reconcileCompactionMode({
            db,
            sessionId: "ses-1",
            compactionOff: false,
            historianRunnable: true,
            compartmentInProgress: false,
        });

        expect(result.recordToWrite).toBe("on");
        expect(result.notice).toBeNull();
        expect(result.clearedSomething).toBe(false);
        commitCompactionModeRecord(db, "ses-1", result.recordToWrite!);
        expect(getCompactionModeRecord(db, "ses-1")).toBe("on");
    });

    it("no record + off on a CLEAN session → writes 'off', changes no rows, emits NO notice", () => {
        useTempDataHome("mc-mode-clean-off-");
        const db = openDatabase();
        getOrCreateSessionMeta(db, "ses-1");

        const result = reconcileCompactionMode({
            db,
            sessionId: "ses-1",
            compactionOff: true,
            historianRunnable: true,
            compartmentInProgress: false,
        });

        expect(result.recordToWrite).toBe("off");
        expect(result.clearedSomething).toBe(false);
        // A fresh off-mode install cleans no markers and emits no notice because no user transition occurred.
        expect(result.notice).toBeNull();
        expect(getPendingOps(db, "ses-1")).toHaveLength(0);
        expect(getOverflowState(db, "ses-1").needsEmergencyRecovery).toBe(false);
        expect(getChannel2NudgeState(db, "ses-1")).toBe("");
    });

    it("persists off notice intent before the first durable clear", () => {
        useTempDataHome("mc-mode-interrupted-off-");
        const db = openDatabase();
        getOrCreateSessionMeta(db, "ses-1");
        setCompactionModeRecord(db, "ses-1", "on");
        setPersistedCompactionMarkerState(db, "ses-1", {
            boundaryMessageId: "msg-user-1",
            summaryMessageId: "msg-summary",
            compactionPartId: "prt-marker",
            summaryPartId: "prt-summary",
            boundaryOrdinal: 1,
            targetEndMessageId: null,
        });
        db.exec(`
            CREATE TRIGGER interrupt_first_off_clear
            BEFORE UPDATE OF compaction_marker_state ON session_meta
            WHEN OLD.compaction_marker_state <> '' AND NEW.compaction_marker_state = ''
            BEGIN SELECT RAISE(ABORT, 'simulated interrupt after notice intent'); END;
        `);

        expect(() =>
            reconcileCompactionMode({
                db,
                sessionId: "ses-1",
                compactionOff: true,
                historianRunnable: true,
                compartmentInProgress: false,
            }),
        ).toThrow("simulated interrupt after notice intent");
        expect(getCompactionModeRecord(db, "ses-1")).toBe("off_notice_pending");
        expect(getPersistedCompactionMarkerState(db, "ses-1")).not.toBeNull();

        db.exec("DROP TRIGGER interrupt_first_off_clear");
        const resumed = reconcileCompactionMode({
            db,
            sessionId: "ses-1",
            compactionOff: true,
            historianRunnable: true,
            compartmentInProgress: false,
        });
        expect(resumed.notice).toBe(COMPACTION_OFF_FLIP_NOTICE);
        expect(getPersistedCompactionMarkerState(db, "ses-1")).toBeNull();
    });

    it("no record + off on a LEGACY session (upgrade path) → full cleanup + flip notice", () => {
        useTempDataHome("mc-mode-legacy-off-");
        const db = openDatabase();
        getOrCreateSessionMeta(db, "ses-1");
        queuePendingOp(db, "ses-1", 7, "drop");
        recordOverflowDetected(db, "ses-1", 120000);
        setChannel2NudgeState(db, "ses-1", "pending");
        setPersistedCompactionMarkerState(db, "ses-1", {
            boundaryMessageId: "msg-user-1",
            summaryMessageId: "msg-mc-summary",
            compactionPartId: "prt-mc-compaction",
            summaryPartId: "prt-mc-summary-text",
            boundaryOrdinal: 10,
            targetEndMessageId: null,
        });
        setPendingCompactionMarkerState(db, "ses-1", {
            ordinal: 10,
            endMessageId: "msg-end-1",
            publishedAt: Date.now(),
        });

        const result = reconcileCompactionMode({
            db,
            sessionId: "ses-1",
            compactionOff: true,
            historianRunnable: true,
            compartmentInProgress: true,
        });

        expect(result.recordToWrite).toBe("off");
        expect(result.clearedSomething).toBe(true);
        expect(result.notice).toBe(COMPACTION_OFF_FLIP_NOTICE);
        expect(getPendingOps(db, "ses-1")).toHaveLength(0);
        expect(getOverflowState(db, "ses-1").needsEmergencyRecovery).toBe(false);
        expect(getChannel2NudgeState(db, "ses-1")).toBe("");
        expect(getPersistedCompactionMarkerState(db, "ses-1")).toBeNull();
        expect(getPendingCompactionMarkerState(db, "ses-1")).toBeNull();
        expect(result.clearedCompartmentInProgress).toBe(true);
        // The flip-off notice warns for one cycle.
        expect(result.notice).toContain(
            "the first turn after disabling may trigger one native compaction cycle on long sessions",
        );
    });

    it("on → off → same cleanup set as the upgrade path", () => {
        useTempDataHome("mc-mode-on-to-off-");
        const db = openDatabase();
        getOrCreateSessionMeta(db, "ses-1");
        setCompactionModeRecord(db, "ses-1", "on");
        queuePendingOp(db, "ses-1", 3, "drop");
        recordOverflowDetected(db, "ses-1", undefined);
        setChannel2NudgeState(db, "ses-1", "claimed");

        const result = reconcileCompactionMode({
            db,
            sessionId: "ses-1",
            compactionOff: true,
            historianRunnable: true,
            compartmentInProgress: false,
        });

        expect(result.recordToWrite).toBe("off");
        expect(result.clearedSomething).toBe(true);
        expect(result.notice).toBe(COMPACTION_OFF_FLIP_NOTICE);
        expect(getPendingOps(db, "ses-1")).toHaveLength(0);
        expect(getOverflowState(db, "ses-1").needsEmergencyRecovery).toBe(false);
        expect(getChannel2NudgeState(db, "ses-1")).toBe("");
    });

    it("off → on with historian runnable → catch-up signal + /ctx-wrapup suggestion, baseline invalidated", () => {
        useTempDataHome("mc-mode-off-to-on-");
        const db = openDatabase();
        const meta = getOrCreateSessionMeta(db, "ses-1");
        setCompactionModeRecord(db, "ses-1", "off");
        // Enabling compaction must recut an off-mode baseline without session history.
        expect(meta).not.toBeNull();

        const result = reconcileCompactionMode({
            db,
            sessionId: "ses-1",
            compactionOff: false,
            historianRunnable: true,
            compartmentInProgress: false,
        });

        expect(result.recordToWrite).toBe("on");
        expect(getCompactionModeRecord(db, "ses-1")).toBe("on_notice_pending");
        expect(result.historianCatchUpSignaled).toBe(true);
        expect(result.notice).toBe(COMPACTION_ON_WRAPUP_SUGGESTION);
        expect(result.notice).toContain("/ctx-wrapup");
        // A staged notice record survives a crash before delivery or settlement.
        const row = db
            .prepare("SELECT compartment_in_progress FROM session_meta WHERE session_id = 'ses-1'")
            .get() as { compartment_in_progress: number };
        expect(row.compartment_in_progress).toBe(1);
    });

    it("off → on with historian DISABLED → record only, no catch-up signal, no suggestion", () => {
        useTempDataHome("mc-mode-off-to-on-nohist-");
        const db = openDatabase();
        getOrCreateSessionMeta(db, "ses-1");
        setCompactionModeRecord(db, "ses-1", "off");

        const result = reconcileCompactionMode({
            db,
            sessionId: "ses-1",
            compactionOff: false,
            historianRunnable: false,
            compartmentInProgress: false,
        });

        expect(result.recordToWrite).toBe("on");
        expect(result.historianCatchUpSignaled).toBe(false);
        expect(result.notice).toBeNull();
        const row = db
            .prepare("SELECT compartment_in_progress FROM session_meta WHERE session_id = 'ses-1'")
            .get() as { compartment_in_progress: number };
        expect(row.compartment_in_progress).toBe(0);
    });

    it("matching on→on and off→off passes are no-ops (no record write, no work)", () => {
        useTempDataHome("mc-mode-matching-");
        const db = openDatabase();
        getOrCreateSessionMeta(db, "ses-on");
        getOrCreateSessionMeta(db, "ses-off");
        setCompactionModeRecord(db, "ses-on", "on");
        setCompactionModeRecord(db, "ses-off", "off");

        const onOn = reconcileCompactionMode({
            db,
            sessionId: "ses-on",
            compactionOff: false,
            historianRunnable: true,
            compartmentInProgress: false,
        });
        const offOff = reconcileCompactionMode({
            db,
            sessionId: "ses-off",
            compactionOff: true,
            historianRunnable: true,
            compartmentInProgress: false,
        });

        expect(onOn.recordToWrite).toBeNull();
        expect(onOn.notice).toBeNull();
        expect(offOff.recordToWrite).toBeNull();
        expect(offOff.notice).toBeNull();
    });

    it("crash retry: a durable pending off notice re-runs cleanup idempotently and settles the mode", () => {
        useTempDataHome("mc-mode-crash-retry-");
        const db = openDatabase();
        getOrCreateSessionMeta(db, "ses-1");
        queuePendingOp(db, "ses-1", 5, "drop");
        recordOverflowDetected(db, "ses-1", 120000);

        // Cleanup retries leave pending ops empty and the latch cleared while preserving the notice record.
        const first = reconcileCompactionMode({
            db,
            sessionId: "ses-1",
            compactionOff: true,
            historianRunnable: true,
            compartmentInProgress: false,
        });
        expect(first.recordToWrite).toBe("off");
        expect(first.clearedSomething).toBe(true);
        expect(getCompactionModeRecord(db, "ses-1")).toBe("off_notice_pending");

        // `markerCleanup` emits no notice when no marker state remains to clear.
        const second = reconcileCompactionMode({
            db,
            sessionId: "ses-1",
            compactionOff: true,
            historianRunnable: true,
            compartmentInProgress: false,
        });
        expect(second.recordToWrite).toBe("off");
        expect(second.notice).toBe(COMPACTION_OFF_FLIP_NOTICE);
        expect(getPendingOps(db, "ses-1")).toHaveLength(0);
        expect(getOverflowState(db, "ses-1").needsEmergencyRecovery).toBe(false);
        commitCompactionModeRecord(db, "ses-1", second.recordToWrite!);
        expect(getCompactionModeRecord(db, "ses-1")).toBe("off");

        // reconcileCompactionMode is a no-op after the record is committed.
        const third = reconcileCompactionMode({
            db,
            sessionId: "ses-1",
            compactionOff: true,
            historianRunnable: true,
            compartmentInProgress: false,
        });
        expect(third.recordToWrite).toBeNull();
    });

    it("delivered Channel-2 state is terminal: the off-transition clears pending/claimed but never delivered", () => {
        useTempDataHome("mc-mode-channel2-delivered-");
        const db = openDatabase();
        getOrCreateSessionMeta(db, "ses-1");
        setCompactionModeRecord(db, "ses-1", "on");
        setChannel2NudgeState(db, "ses-1", "delivered");

        const result = reconcileCompactionMode({
            db,
            sessionId: "ses-1",
            compactionOff: true,
            historianRunnable: true,
            compartmentInProgress: false,
        });

        expect(getChannel2NudgeState(db, "ses-1")).toBe("delivered");
        expect(result.clearedSomething).toBe(false);
        expect(result.notice).toBeNull();
    });
});
