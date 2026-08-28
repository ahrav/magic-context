/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawMessage } from "../../hooks/magic-context/read-session-raw";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    getDirtyIndexFloor,
    getLastIndexedOrdinal,
    indexMessagesAfterOrdinal,
    indexSingleMessage,
    markMessageIndexDirty,
} from "./message-index";
import { createDirectTestDatabase } from "./test-database";

function createTestDb(): Database {
    const db = createDirectTestDatabase().db;
    return db;
}

function indexedRows(db: Database, sessionId: string): Array<{ message_id: string }> {
    return db
        .prepare("SELECT message_id FROM message_history_fts WHERE session_id = ?")
        .all(sessionId) as Array<{ message_id: string }>;
}

describe("message-index", () => {
    let db: Database;

    beforeEach(() => {
        db = createTestDb();
    });

    afterEach(() => {
        closeQuietly(db);
    });

    it("indexSingleMessage skips already-indexed messages", () => {
        const message: RawMessage = {
            ordinal: 1,
            id: "m-1",
            role: "user",
            parts: [{ type: "text", text: "indexed once" }],
        };

        expect(indexSingleMessage(db, "ses-1", message)).toBe(true);
        expect(indexSingleMessage(db, "ses-1", message)).toBe(false);

        expect(indexedRows(db, "ses-1")).toEqual([{ message_id: "m-1" }]);
    });

    it("preserves an unrelated later dirty floor across a same-ID replacement", () => {
        const original: RawMessage = {
            ordinal: 1,
            id: "m-edit-with-gap",
            role: "user",
            parts: [{ type: "text", text: "before edit" }],
            version: 1,
        };
        const second: RawMessage = {
            ordinal: 2,
            id: "m-second",
            role: "user",
            parts: [{ type: "text", text: "second" }],
            version: 1,
        };
        indexMessagesAfterOrdinal(db, "ses-edit-with-gap", [original, second], 0, 2);
        markMessageIndexDirty(db, "ses-edit-with-gap", 3);

        expect(
            indexSingleMessage(db, "ses-edit-with-gap", {
                ...original,
                parts: [{ type: "text", text: "after edit" }],
                version: 2,
            }),
        ).toBe(true);

        expect(getDirtyIndexFloor(db, "ses-edit-with-gap")).toBe(3);
        expect(
            db
                .prepare(
                    "SELECT content FROM message_history_fts WHERE session_id = ? AND message_id = ?",
                )
                .get("ses-edit-with-gap", original.id),
        ).toEqual({ content: "after edit" });
    });

    it("preserves a dirty floor beyond a stale snapshot and fills it on the next pass", () => {
        const directory = mkdtempSync(join(tmpdir(), "message-index-gap-"));
        const dbPath = join(directory, "context.db");
        const first = createDirectTestDatabase({ path: dbPath }).db;
        const second = new Database(dbPath);
        try {
            const messages: RawMessage[] = [
                {
                    ordinal: 1,
                    id: "m-1",
                    role: "user",
                    parts: [{ type: "text", text: "first" }],
                },
                {
                    ordinal: 2,
                    id: "m-2",
                    role: "user",
                    parts: [{ type: "text", text: "covered later" }],
                },
                {
                    ordinal: 3,
                    id: "m-3",
                    role: "user",
                    parts: [{ type: "text", text: "newer live row" }],
                },
            ];
            indexMessagesAfterOrdinal(first, "ses-gap", [messages[0]!], 0, 1);
            markMessageIndexDirty(second, "ses-gap", 2);
            second
                .prepare(
                    "INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES ('ses-gap', 3, 'm-3', 'user', 'newer live row')",
                )
                .run();
            second
                .prepare(
                    "UPDATE message_history_index SET last_indexed_ordinal = 3 WHERE session_id = 'ses-gap'",
                )
                .run();

            indexMessagesAfterOrdinal(first, "ses-gap", [messages[0]!], 1, 1);

            expect(getLastIndexedOrdinal(first, "ses-gap")).toBe(1);
            expect(getDirtyIndexFloor(first, "ses-gap")).toBe(2);
            expect(indexedRows(first, "ses-gap")).toEqual([
                { message_id: "m-1" },
                { message_id: "m-3" },
            ]);

            indexMessagesAfterOrdinal(first, "ses-gap", [messages[1]!], 1, 2);
            indexMessagesAfterOrdinal(first, "ses-gap", [messages[2]!], 2, 3);

            expect(getLastIndexedOrdinal(first, "ses-gap")).toBe(3);
            expect(getDirtyIndexFloor(first, "ses-gap")).toBeNull();
            expect(indexedRows(first, "ses-gap")).toEqual([
                { message_id: "m-1" },
                { message_id: "m-3" },
                { message_id: "m-2" },
            ]);
        } finally {
            closeQuietly(second);
            closeQuietly(first);
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
