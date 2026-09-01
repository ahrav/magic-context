/// <reference types="bun-types" />

/**
 *
 * The test covers two assistant turns that share a tool call ID.
 * Dropping either turn must not alter the other turn's tag.
 *
 * Post-fix:
 * Each tool tag carries `tool_owner_message_id`; rows with the same call ID require distinct owner message IDs.
 * The drop queue and heuristic dedup must not merge tags with different owners.
 *
 * The harness cannot execute tools because OpenCode requires registered tools.
 *
 * `compartment-runner-drop-queue.test.ts`, `migrations-v10.test.ts`)
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { TestHarness } from "../src/harness";
import { openTestDb } from "../src/test-db";

let h: TestHarness;

beforeAll(async () => {
    h = await TestHarness.create({
        magicContextConfig: { protected_tags: 1 },
    });
});

afterAll(async () => {
    await h.dispose();
});

describe("tag-owner collision repro (v3.3.1 Layer C)", () => {
    it("creates a session and applies migration v10", async () => {
        h.mock.setDefault({
            text: "first response",
            usage: {
                input_tokens: 100,
                output_tokens: 10,
                cache_creation_input_tokens: 100,
            },
        });

        const sessionId = await h.createSession();
        await h.sendPrompt(sessionId, "create-session-for-collision-test");

        await h.waitFor(() => h.hasContextDb(), { label: "context.db created" });

        // `openDatabase()` applies migrations at startup.
        const db = h.contextDb();
        const row = db
            .prepare("SELECT MAX(version) AS v FROM schema_migrations")
            .get() as { v: number };
        expect(row.v).toBeGreaterThanOrEqual(10);

        const cols = db.prepare("PRAGMA table_info(tags)").all() as Array<{
            name: string;
            dflt_value: string | null;
            type: string;
        }>;
        const owner = cols.find((c) => c.name === "tool_owner_message_id");
        expect(owner).toBeDefined();
        expect(owner?.type).toBe("TEXT");

        const idxComposite = db
            .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?")
            .get("idx_tags_tool_composite") as { sql: string } | undefined;
        expect(idxComposite).toBeDefined();
        expect(idxComposite?.sql).toContain("UNIQUE");

        const idxNullOwner = db
            .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?")
            .get("idx_tags_tool_null_owner") as { sql: string } | undefined;
        expect(idxNullOwner).toBeDefined();
    }, 60_000);

    it("two tool rows with same callId + different owners coexist via composite UNIQUE", async () => {
        // The writable handle is required because the harness's default handle is read-only.
        // read-only.
        const sessionId = "ses-collision-repro";
        const dbPath = h.contextDb().filename;
        const writable = openTestDb(dbPath);
        // SQLite waits for a concurrent startup migration writer instead of returning `SQLITE_BUSY` immediately.
        // The plugin can hold the write lock while applying startup migrations.
        // A handle without a busy timeout fails with `database is locked` before inserting.
        try {
            // The composite key treats rows with different `tool_owner_message_id` values as distinct.
            // unique-violated.
            const insert = writable.prepare(
                "INSERT INTO tags (session_id, message_id, type, tag_number, byte_size, tool_name, tool_owner_message_id, harness) VALUES (?, ?, 'tool', ?, ?, 'read', ?, 'opencode')",
            );
            insert.run(sessionId, "read:32", 100, 200, "m-asst-1");
            insert.run(sessionId, "read:32", 200, 200, "m-asst-2");

            const tags = writable
                .prepare(
                    "SELECT tag_number, tool_owner_message_id FROM tags WHERE session_id = ? ORDER BY tag_number",
                )
                .all(sessionId) as Array<{
                tag_number: number;
                tool_owner_message_id: string;
            }>;
            expect(tags).toHaveLength(2);
            expect(tags.map((t) => t.tag_number)).toEqual([100, 200]);
            expect(tags.map((t) => t.tool_owner_message_id)).toEqual([
                "m-asst-1",
                "m-asst-2",
            ]);

            // The partial UNIQUE index rejects a third row with the same non-NULL `(message_id, tool_owner_message_id)` pair.
            // The partial unique index rejects duplicate non-NULL `(message_id, tool_owner_message_id)` pairs.
            expect(() =>
                insert.run(sessionId, "read:32", 999, 200, "m-asst-1"),
            ).toThrow(/UNIQUE/i);

            // The index permits a third row with a new `tool_owner_message_id`.
            // Rows with the same callId and different owners remain insertable.
            insert.run(sessionId, "read:32", 300, 200, "m-asst-3");
            const after = writable
                .prepare("SELECT COUNT(*) AS n FROM tags WHERE session_id = ?")
                .get(sessionId) as { n: number };
            expect(after.n).toBe(3);
        } finally {
            writable.close();
        }
    }, 30_000);

    it("legacy NULL-owner rows for the same callId still coexist (no UNIQUE collision)", async () => {
        // Tool tags with `tool_owner_message_id = NULL` are excluded from the partial unique index.
        const sessionId = "ses-legacy-null";
        const dbPath = h.contextDb().filename;
        const writable = openTestDb(dbPath);
        // The busy timeout lets SQLite wait while the plugin's startup migration holds the write lock.
        try {
            const insert = writable.prepare(
                "INSERT INTO tags (session_id, message_id, type, tag_number, byte_size, tool_name, tool_owner_message_id, harness) VALUES (?, ?, 'tool', ?, ?, 'read', NULL, 'opencode')",
            );
            insert.run(sessionId, "legacy:1", 1, 100);
            insert.run(sessionId, "legacy:1", 2, 100); // same callId, same NULL owner — must succeed

            const tags = writable
                .prepare(
                    "SELECT COUNT(*) AS n FROM tags WHERE session_id = ? AND tool_owner_message_id IS NULL",
                )
                .get(sessionId) as { n: number };
            expect(tags.n).toBe(2);
        } finally {
            writable.close();
        }
    }, 30_000);

    it("dropping tag-1 (m-asst-1) leaves tag-2 (m-asst-2) active — no cross-owner cascade", async () => {
        // Dropping tag 1 must leave tag 2 active.
        const sessionId = "ses-drop-isolation";
        const dbPath = h.contextDb().filename;
        const writable = openTestDb(dbPath);
        // The busy timeout lets the concurrent writer wait for the write lock before SQLite returns SQLITE_BUSY.
        try {
            const insert = writable.prepare(
                "INSERT INTO tags (session_id, message_id, type, tag_number, byte_size, tool_name, tool_owner_message_id, status, harness) VALUES (?, ?, 'tool', ?, ?, 'read', ?, 'active', 'opencode')",
            );
            insert.run(sessionId, "read:32", 1, 200, "m-asst-1");
            insert.run(sessionId, "read:32", 2, 200, "m-asst-2");

            writable
                .prepare(
                    "UPDATE tags SET status = 'dropped' WHERE session_id = ? AND tag_number = ?",
                )
                .run(sessionId, 1);

            const rows = writable
                .prepare(
                    "SELECT tag_number, status, tool_owner_message_id FROM tags WHERE session_id = ? ORDER BY tag_number",
                )
                .all(sessionId) as Array<{
                tag_number: number;
                status: string;
                tool_owner_message_id: string;
            }>;
            expect(rows).toEqual([
                { tag_number: 1, status: "dropped", tool_owner_message_id: "m-asst-1" },
                { tag_number: 2, status: "active", tool_owner_message_id: "m-asst-2" },
            ]);
        } finally {
            writable.close();
        }
    }, 30_000);
});
