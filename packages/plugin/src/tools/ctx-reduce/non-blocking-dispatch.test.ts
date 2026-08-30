import { beforeEach, describe, expect, it } from "bun:test";
import { createDirectTestDatabase } from "../../features/magic-context/test-database";
import type { Database } from "../../shared/sqlite";
import { createCtxReduceTools } from "./tools";

function createDb(): Database {
    return createDirectTestDatabase().db;
}

function seedTag(db: Database, id: number, sessionId = "ses-1"): void {
    db.prepare(
        "INSERT INTO tags (id, message_id, type, status, byte_size, session_id, tag_number) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(id, `msg-${id}`, "message", "active", 100, sessionId, id);
}

describe("ctx_reduce drop queueing", () => {
    let db: Database;

    beforeEach(() => {
        db = createDb();
        seedTag(db, 1);
        seedTag(db, 2);
        seedTag(db, 8);
        seedTag(db, 9);
        seedTag(db, 10);
    });

    it("returns queued ack immediately and stores pending drops", async () => {
        const tools = createCtxReduceTools({
            db,
            protectedTags: 3,
        });

        const result = await tools.ctx_reduce.execute({ drop: "1,2" }, {
            sessionID: "ses-1",
        } as never);

        expect(result).toContain("Queued");
        const pendingCount = db
            .prepare("SELECT COUNT(*) AS count FROM pending_ops WHERE session_id = ?")
            .get("ses-1") as { count: number };
        expect(pendingCount.count).toBe(2);
    });
});
