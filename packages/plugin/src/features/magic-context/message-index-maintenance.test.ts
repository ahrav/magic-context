/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    MESSAGE_HISTORY_ORPHAN_SAFETY_AGE_MS,
    sweepOrphanedOpenCodeMessageIndexes,
} from "./message-index";
import { createDirectTestDatabase } from "./test-database";

const tempDirectories: string[] = [];

function createOpenCodeDb(liveSessionIds: string[]): string {
    const directory = mkdtempSync(join(tmpdir(), "message-index-orphan-source-"));
    tempDirectories.push(directory);
    const path = join(directory, "opencode.db");
    const db = new Database(path);
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY)");
    const insert = db.prepare("INSERT INTO session (id) VALUES (?)");
    for (const sessionId of liveSessionIds) insert.run(sessionId);
    closeQuietly(db);
    return path;
}

function seedIndexedSession(db: Database, sessionId: string, updatedAt: number): void {
    db.prepare(
        `INSERT INTO message_history_index
            (session_id, last_indexed_ordinal, dirty_floor_ordinal, updated_at, harness)
         VALUES (?, 1, 0, ?, 'opencode')`,
    ).run(sessionId, updatedAt);
    db.prepare(
        `INSERT INTO message_history_fts
            (session_id, message_ordinal, message_id, role, content)
         VALUES (?, 1, ?, 'user', ?)`,
    ).run(sessionId, `${sessionId}-message`, `searchable ${sessionId}`);
}

function countRows(db: Database, table: string, sessionId: string): number {
    const row = db
        .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE session_id = ?`)
        .get(sessionId) as { count: number };
    return row.count;
}

afterEach(() => {
    for (const directory of tempDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }
    tempDirectories.length = 0;
});

describe("message history orphan maintenance", () => {
    test("sweeps old orphans while retaining live and young sessions", () => {
        const db = createDirectTestDatabase().db;
        const now = 2_000_000_000_000;
        const old = now - MESSAGE_HISTORY_ORPHAN_SAFETY_AGE_MS - 1;
        seedIndexedSession(db, "ses-live", old);
        seedIndexedSession(db, "ses-orphan", old);
        seedIndexedSession(db, "ses-young", now - 1_000);
        const openCodePath = createOpenCodeDb(["ses-live"]);

        try {
            const result = sweepOrphanedOpenCodeMessageIndexes(
                db,
                () => new Database(openCodePath, { readonly: true }),
                { now },
            );

            expect(result).toMatchObject({ status: "swept", scanned: 2, deleted: 1 });
            expect(countRows(db, "message_history_fts", "ses-orphan")).toBe(0);
            expect(countRows(db, "message_history_index", "ses-orphan")).toBe(0);
            expect(countRows(db, "message_history_fts", "ses-live")).toBe(1);
            expect(countRows(db, "message_history_index", "ses-live")).toBe(1);
            expect(countRows(db, "message_history_fts", "ses-young")).toBe(1);
            expect(countRows(db, "message_history_index", "ses-young")).toBe(1);
        } finally {
            closeQuietly(db);
        }
    });

    test("persists a keyset cursor and resumes within the configured batch bound", () => {
        const db = createDirectTestDatabase().db;
        const now = 2_000_000_000_000;
        const old = now - MESSAGE_HISTORY_ORPHAN_SAFETY_AGE_MS - 1;
        for (const sessionId of ["ses-a", "ses-b", "ses-c"]) {
            seedIndexedSession(db, sessionId, old);
        }
        const openCodePath = createOpenCodeDb([]);

        try {
            const openSource = () => new Database(openCodePath, { readonly: true });
            const first = sweepOrphanedOpenCodeMessageIndexes(db, openSource, {
                now,
                batchSize: 2,
            });
            expect(first).toEqual({ status: "swept", scanned: 2, deleted: 2, cursor: "ses-b" });

            const persisted = db
                .prepare(
                    "SELECT cursor_session_id FROM message_history_orphan_sweep WHERE harness = 'opencode'",
                )
                .get() as { cursor_session_id: string };
            expect(persisted.cursor_session_id).toBe("ses-b");

            const second = sweepOrphanedOpenCodeMessageIndexes(db, openSource, {
                now,
                batchSize: 2,
            });
            expect(second).toEqual({ status: "swept", scanned: 1, deleted: 1, cursor: "" });
            expect(
                (
                    db.prepare("SELECT COUNT(*) AS count FROM message_history_index").get() as {
                        count: number;
                    }
                ).count,
            ).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });

    test("parks cleanly when a Pi-only install has no OpenCode database", () => {
        const db = createDirectTestDatabase().db;
        const now = 2_000_000_000_000;
        seedIndexedSession(db, "pi-do-not-delete", now - MESSAGE_HISTORY_ORPHAN_SAFETY_AGE_MS - 1);
        let openAttempts = 0;
        const unavailable = () => {
            openAttempts += 1;
            return null;
        };

        try {
            const first = sweepOrphanedOpenCodeMessageIndexes(db, unavailable, { now });
            const second = sweepOrphanedOpenCodeMessageIndexes(db, unavailable, {
                now: now + 15 * 60 * 1000,
            });

            expect(first.status).toBe("source_unavailable");
            expect(second.status).toBe("cooldown");
            expect(openAttempts).toBe(1);
            expect(countRows(db, "message_history_fts", "pi-do-not-delete")).toBe(1);
        } finally {
            closeQuietly(db);
        }
    });
});
