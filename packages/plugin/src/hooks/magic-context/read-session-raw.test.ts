import { describe, expect, it } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    countRawSessionMessageOrdinalsFromDb,
    readRawSessionMessageIdOrdinalsFromDb,
    readRawSessionMessageOrdinalByIdFromDb,
    readRawSessionMessagePageFromDb,
    readRawSessionMessagesFromDb,
} from "./read-session-raw";

describe("raw session message id ordinals", () => {
    it("matches the full raw reader across ordering, summaries, roles, and tool arcs", () => {
        const db = new Database(":memory:");
        try {
            db.exec(`
                CREATE TABLE message (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    time_created INTEGER NOT NULL,
                    time_updated INTEGER NOT NULL,
                    data TEXT NOT NULL
                );
                CREATE TABLE part (
                    id TEXT PRIMARY KEY,
                    message_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    time_created INTEGER NOT NULL,
                    time_updated INTEGER NOT NULL,
                    data TEXT NOT NULL
                );
            `);
            const insertMessage = db.prepare(
                "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, 'session', ?, ?, ?)",
            );
            const rows: Array<[string, number, string]> = [
                ["m-tool-result", 30, JSON.stringify({ role: "tool", finish: "stop" })],
                [
                    "m-summary",
                    20,
                    JSON.stringify({ role: "assistant", summary: true, finish: "stop" }),
                ],
                ["m-weird", 20, JSON.stringify({ role: { unexpected: true }, summary: "true" })],
                ["m-user", 10, JSON.stringify({ role: "user" })],
                ["m-malformed", 25, "{"],
                [
                    "m-assistant",
                    20,
                    JSON.stringify({ role: "assistant", summary: true, finish: "tool-calls" }),
                ],
            ];
            for (const [id, createdAt, data] of rows) {
                insertMessage.run(id, createdAt, createdAt, data);
            }
            const insertPart = db.prepare(
                "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, 'session', ?, ?, ?)",
            );
            insertPart.run(
                "p-call",
                "m-assistant",
                21,
                21,
                JSON.stringify({ type: "tool", callID: "call-1", state: { status: "completed" } }),
            );
            insertPart.run(
                "p-result",
                "m-tool-result",
                31,
                31,
                JSON.stringify({ type: "tool_result", callID: "call-1", output: "done" }),
            );

            const fullReaderMap = new Map(
                readRawSessionMessagesFromDb(db, "session").map((message) => [
                    message.id,
                    message.ordinal,
                ]),
            );

            expect(readRawSessionMessageIdOrdinalsFromDb(db, "session")).toEqual(fullReaderMap);
            expect(readRawSessionMessageOrdinalByIdFromDb(db, "session", "m-user")).toBe(1);
            expect(readRawSessionMessageOrdinalByIdFromDb(db, "session", "m-assistant")).toBe(2);
            expect(readRawSessionMessageOrdinalByIdFromDb(db, "session", "m-summary")).toBeNull();
            expect(readRawSessionMessageOrdinalByIdFromDb(db, "session", "missing")).toBeNull();
            expect([...fullReaderMap]).toEqual([
                ["m-user", 1],
                ["m-assistant", 2],
                ["m-weird", 3],
                ["m-tool-result", 5],
            ]);

            const firstPage = readRawSessionMessagePageFromDb(db, "session", 0, 2, 5);
            const secondPage = readRawSessionMessagePageFromDb(db, "session", 2, 3, 5);
            expect([...firstPage, ...secondPage].map(({ id, ordinal }) => [id, ordinal])).toEqual([
                ["m-user", 1],
                ["m-assistant", 2],
                ["m-weird", 3],
                ["m-malformed", 4],
                ["m-tool-result", 5],
            ]);
            expect(countRawSessionMessageOrdinalsFromDb(db, "session")).toBe(5);
        } finally {
            closeQuietly(db);
        }
    });
});
