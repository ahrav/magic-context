/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage";
import { setPersistedCompactionMarkerState } from "../../features/magic-context/storage-meta-persisted";
import { createOpenCodeTestDb } from "../../features/magic-context/test-database";
import type { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { checkCompactionMarkerConsistency } from "./compaction-marker-manager";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

function useTempDataHome(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    // Create both parent directories: OpenCode writes opencode/opencode.db, and openDatabase() uses cortexkit/magic-context.
    mkdirSync(join(dir, "opencode"), { recursive: true });
    mkdirSync(join(dir, "cortexkit", "magic-context"), { recursive: true });
    return dir;
}

function insertMessage(db: Database, id: string): void {
    db.prepare("INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)").run(
        id,
        "ses-1",
        "{}",
    );
}

function insertPart(db: Database, id: string): void {
    db.prepare("INSERT INTO part (id, message_id, session_id, data) VALUES (?, ?, ?, ?)").run(
        id,
        "msg-x",
        "ses-1",
        "{}",
    );
}

afterEach(() => {
    closeDatabase();
    process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {}
    }
    tempDirs.length = 0;
});

describe("checkCompactionMarkerConsistency", () => {
    it("is a no-op when there is no persisted state", () => {
        const dataHome = useTempDataHome("consistency-empty-");
        const opencodeDb = createOpenCodeTestDb(dataHome);
        closeQuietly(opencodeDb);

        const db = openDatabase();
        expect(() => checkCompactionMarkerConsistency(db)).not.toThrow();
    });

    it("clears persisted state when any referenced row is missing", () => {
        const dataHome = useTempDataHome("consistency-orphan-");
        const opencodeDb = createOpenCodeTestDb(dataHome);

        insertMessage(opencodeDb, "msg-boundary");
        insertPart(opencodeDb, "prt-compaction");
        // msg-summary and prt-summary-text are absent.
        closeQuietly(opencodeDb);

        const db = openDatabase();
        setPersistedCompactionMarkerState(db, "ses-1", {
            boundaryMessageId: "msg-boundary",
            summaryMessageId: "msg-summary",
            compactionPartId: "prt-compaction",
            summaryPartId: "prt-summary-text",
            boundaryOrdinal: 42,
            targetEndMessageId: "msg-boundary",
        });

        checkCompactionMarkerConsistency(db);

        const row = db
            .prepare("SELECT compaction_marker_state FROM session_meta WHERE session_id = ?")
            .get("ses-1") as { compaction_marker_state?: string } | null;
        expect(row?.compaction_marker_state ?? "").toBe("");
    });

    it("preserves persisted state when all referenced rows are present", () => {
        const dataHome = useTempDataHome("consistency-healthy-");
        const opencodeDb = createOpenCodeTestDb(dataHome);

        insertMessage(opencodeDb, "msg-boundary");
        insertMessage(opencodeDb, "msg-summary");
        insertPart(opencodeDb, "prt-compaction");
        insertPart(opencodeDb, "prt-summary-text");
        closeQuietly(opencodeDb);

        const db = openDatabase();
        setPersistedCompactionMarkerState(db, "ses-1", {
            boundaryMessageId: "msg-boundary",
            summaryMessageId: "msg-summary",
            compactionPartId: "prt-compaction",
            summaryPartId: "prt-summary-text",
            boundaryOrdinal: 42,
            targetEndMessageId: "msg-boundary",
        });

        checkCompactionMarkerConsistency(db);

        const row = db
            .prepare("SELECT compaction_marker_state FROM session_meta WHERE session_id = ?")
            .get("ses-1") as { compaction_marker_state?: string } | null;
        const parsed = JSON.parse(row?.compaction_marker_state ?? "{}");
        expect(parsed.boundaryMessageId).toBe("msg-boundary");
        expect(parsed.boundaryOrdinal).toBe(42);
    });

    it("reconciles multiple sessions in one pass", () => {
        const dataHome = useTempDataHome("consistency-multi-");
        const opencodeDb = createOpenCodeTestDb(dataHome);

        // ses-1 has all referenced rows and must retain its marker state.
        insertMessage(opencodeDb, "msg-boundary-1");
        insertMessage(opencodeDb, "msg-summary-1");
        insertPart(opencodeDb, "prt-compaction-1");
        insertPart(opencodeDb, "prt-summary-text-1");
        // ses-2 has a missing referenced row and must have its marker state cleared.
        closeQuietly(opencodeDb);

        const db = openDatabase();
        setPersistedCompactionMarkerState(db, "ses-1", {
            boundaryMessageId: "msg-boundary-1",
            summaryMessageId: "msg-summary-1",
            compactionPartId: "prt-compaction-1",
            summaryPartId: "prt-summary-text-1",
            boundaryOrdinal: 10,
            targetEndMessageId: "msg-boundary-1",
        });
        setPersistedCompactionMarkerState(db, "ses-2", {
            boundaryMessageId: "msg-boundary-2",
            summaryMessageId: "msg-summary-2",
            compactionPartId: "prt-compaction-2",
            summaryPartId: "prt-summary-text-2",
            boundaryOrdinal: 20,
            targetEndMessageId: "msg-boundary-2",
        });

        checkCompactionMarkerConsistency(db);

        const row1 = db
            .prepare("SELECT compaction_marker_state FROM session_meta WHERE session_id = ?")
            .get("ses-1") as { compaction_marker_state?: string } | null;
        const row2 = db
            .prepare("SELECT compaction_marker_state FROM session_meta WHERE session_id = ?")
            .get("ses-2") as { compaction_marker_state?: string } | null;

        const parsed1 = JSON.parse(row1?.compaction_marker_state ?? "{}");
        expect(parsed1.boundaryMessageId).toBe("msg-boundary-1");
        expect(row2?.compaction_marker_state ?? "").toBe("");
    });

    it("is idempotent — running twice produces the same result", () => {
        const dataHome = useTempDataHome("consistency-idempotent-");
        const opencodeDb = createOpenCodeTestDb(dataHome);
        insertMessage(opencodeDb, "msg-boundary");
        // Any missing referenced row clears the marker state.
        closeQuietly(opencodeDb);

        const db = openDatabase();
        setPersistedCompactionMarkerState(db, "ses-1", {
            boundaryMessageId: "msg-boundary",
            summaryMessageId: "msg-summary",
            compactionPartId: "prt-compaction",
            summaryPartId: "prt-summary-text",
            boundaryOrdinal: 42,
            targetEndMessageId: "msg-boundary",
        });

        checkCompactionMarkerConsistency(db);
        checkCompactionMarkerConsistency(db); // second pass — no-op

        const row = db
            .prepare("SELECT compaction_marker_state FROM session_meta WHERE session_id = ?")
            .get("ses-1") as { compaction_marker_state?: string } | null;
        expect(row?.compaction_marker_state ?? "").toBe("");
    });
});
