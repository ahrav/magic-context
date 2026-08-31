import { describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import {
    getSubagentInvocations,
    getSubagentTotalsBySubagent,
    recordSubagentInvocation,
} from "./storage-subagent-invocations";

function dbWithTable(): Database {
    const db = new Database(":memory:");
    db.exec(`
        CREATE TABLE subagent_invocations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            harness TEXT NOT NULL,
            subagent TEXT NOT NULL,
            task TEXT,
            provider_id TEXT,
            model_id TEXT,
            started_at INTEGER NOT NULL,
            ended_at INTEGER,
            status TEXT NOT NULL,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            cache_read_tokens INTEGER NOT NULL DEFAULT 0,
            cache_write_tokens INTEGER NOT NULL DEFAULT 0,
            error TEXT,
            parent_invocation_id INTEGER
        )`);
    return db;
}

describe("subagent invocation storage", () => {
    test("records, reads, and totals invocations", () => {
        const db = dbWithTable();
        const parent = recordSubagentInvocation(db, {
            sessionId: "ses",
            harness: "opencode",
            subagent: "historian",
            startedAt: 1,
            endedAt: 2,
            status: "completed",
            inputTokens: 10,
            outputTokens: 2,
            cacheReadTokens: 5,
            cacheWriteTokens: 1,
        });
        const child = recordSubagentInvocation(db, {
            sessionId: "ses",
            harness: "opencode",
            subagent: "historian_editor",
            startedAt: 3,
            endedAt: 4,
            status: "failed",
            inputTokens: 4,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            error: "bad",
            parentInvocationId: parent,
        });
        const newerSameTimestamp = recordSubagentInvocation(db, {
            sessionId: "ses",
            harness: "opencode",
            subagent: "historian",
            startedAt: 3,
            endedAt: 5,
            status: "completed",
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
        });
        const rows = getSubagentInvocations(db, "ses");
        expect(rows).toHaveLength(3);
        expect(rows.map((row) => row.id)).toEqual([newerSameTimestamp, child, parent]);
        expect(rows.find((row) => row.id === child)?.parentInvocationId).toBe(parent);
        const totals = getSubagentTotalsBySubagent(db, "ses");
        expect(totals.historian).toEqual({
            invocations: 2,
            totalInput: 10,
            totalOutput: 2,
            totalCacheRead: 5,
            totalCacheWrite: 1,
        });
    });
});
