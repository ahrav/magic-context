/// <reference types="bun-types" />

/**
 * Tagger composite-identity tests for v3.3.1 Layer C.
 *
 * Covers the new `assignToolTag`/`getToolTag` API surface introduced
 * by the tag-owner identity fix:
 *
 *   - Composite key `(sessionId, callId, ownerMsgId)` produces distinct
 *     tags when two assistant turns reuse the same callId.
 *   - Lazy adoption claims a NULL-owner row left by Layer B backfill
 *     for sessions that hadn't been backfilled yet.
 *   - Multi-NULL-row collision deviation: when legacy data has multiple
 *     NULL-owner rows for the same callId (rare but observed in the
 *     user's 370MB DB), partial UNIQUE on `idx_tags_tool_composite`
 *     forces only one to be adopted at a time. The remaining rows stay
 *     NULL and are picked up by subsequent observations.
 *   - `initFromDb` reload preserves composite-key bindings.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import type { Database, Database as DatabaseType } from "../../shared/sqlite";
import { getNullOwnerToolTag, getTagsBySession } from "./storage-tags";
import { createTagger } from "./tagger";
import { createDirectTestDatabase } from "./test-database";

function openTestDb(): DatabaseType {
    const db = createDirectTestDatabase().db;
    return db;
}

describe("tagger composite identity", () => {
    let db: Database;

    beforeEach(() => {
        db = openTestDb();
    });

    it("two distinct owners produce two distinct tags for the same callId", () => {
        //#given
        const sessionId = "ses-1";
        const tagger = createTagger();

        //#when
        const tag1 = tagger.assignToolTag(sessionId, "read:32", "msg-A", 100, db);
        const tag2 = tagger.assignToolTag(sessionId, "read:32", "msg-B", 200, db);

        //#then
        expect(tag1).not.toBe(tag2);
        expect(tag1).toBe(1);
        expect(tag2).toBe(2);
        const tags = getTagsBySession(db, sessionId).filter((t) => t.type === "tool");
        expect(tags).toHaveLength(2);
        expect(tags.map((t) => t.toolOwnerMessageId).sort()).toEqual(["msg-A", "msg-B"]);
    });

    it("idempotent within same composite key", () => {
        //#given
        const sessionId = "ses-1";
        const tagger = createTagger();

        //#when
        const tag1 = tagger.assignToolTag(sessionId, "read:32", "msg-A", 100, db);
        const tag2 = tagger.assignToolTag(sessionId, "read:32", "msg-A", 999, db);

        //#then
        expect(tag1).toBe(tag2);
    });

    it("getToolTag returns undefined for unknown composite key", () => {
        //#given
        const sessionId = "ses-1";
        const tagger = createTagger();
        tagger.assignToolTag(sessionId, "read:32", "msg-A", 100, db);

        //#when
        const result = tagger.getToolTag(sessionId, "read:32", "msg-B");

        //#then
        expect(result).toBeUndefined();
    });

    it("lazy adoption: NULL-owner row gets claimed on first composite-key observation", () => {
        //#given — pre-insert a legacy NULL-owner row (simulates pre-v10 data
        // that hasn't been backfilled yet).
        const sessionId = "ses-1";
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number, harness, tool_owner_message_id) VALUES (?, ?, 'tool', 100, 1, 'opencode', NULL)",
        ).run(sessionId, "read:32");

        const tagger = createTagger();

        //#when
        const tag = tagger.assignToolTag(sessionId, "read:32", "msg-A", 100, db);

        //#then
        expect(tag).toBe(1); // adopted the legacy row
        const orphan = getNullOwnerToolTag(db, sessionId, "read:32");
        expect(orphan).toBeNull(); // adoption consumed it
        const rows = getTagsBySession(db, sessionId);
        expect(rows.filter((t) => t.type === "tool")[0]?.toolOwnerMessageId).toBe("msg-A");
    });

    it("multi-NULL-row collision deviation: only one row is adopted, remaining stay NULL", () => {
        //#given — legacy data with TWO NULL-owner rows for the same callId
        // (the rare collision artifact observed in the user's 370MB DB).
        // Partial UNIQUE on (session_id, message_id, tool_owner_message_id)
        // WHERE type='tool' AND tool_owner_message_id IS NOT NULL means once
        // the lowest-numbered row is adopted, no second row can adopt the
        // SAME owner — only different owners can adopt.
        const sessionId = "ses-1";
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number, harness, tool_owner_message_id) VALUES (?, ?, 'tool', 100, 1, 'opencode', NULL)",
        ).run(sessionId, "read:32");
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number, harness, tool_owner_message_id) VALUES (?, ?, 'tool', 200, 2, 'opencode', NULL)",
        ).run(sessionId, "read:32");

        const tagger = createTagger();

        //#when — first observation claims the lowest-numbered row
        const tag1 = tagger.assignToolTag(sessionId, "read:32", "msg-A", 100, db);

        //#then — adoption picked tag 1 (lowest), tag 2 remains NULL
        expect(tag1).toBe(1);
        const remaining = getNullOwnerToolTag(db, sessionId, "read:32");
        expect(remaining?.tagNumber).toBe(2);

        //#when — second observation with different owner claims the next NULL row
        const tag2 = tagger.assignToolTag(sessionId, "read:32", "msg-B", 200, db);

        //#then
        expect(tag2).toBe(2);
        expect(getNullOwnerToolTag(db, sessionId, "read:32")).toBeNull();
    });

    it("initFromDb reload preserves composite-key bindings", () => {
        //#given
        const sessionId = "ses-1";
        const tagger1 = createTagger();
        const tagA = tagger1.assignToolTag(sessionId, "read:32", "msg-A", 100, db);
        const tagB = tagger1.assignToolTag(sessionId, "read:32", "msg-B", 200, db);

        //#when
        const tagger2 = createTagger();
        tagger2.initFromDb(sessionId, db);

        //#then
        expect(tagger2.getToolTag(sessionId, "read:32", "msg-A")).toBe(tagA);
        expect(tagger2.getToolTag(sessionId, "read:32", "msg-B")).toBe(tagB);
    });

    it("initFromDb does NOT bind NULL-owner rows in memory", () => {
        //#given — pre-insert a NULL-owner row, then create a tagger.
        const sessionId = "ses-1";
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number, harness, tool_owner_message_id) VALUES (?, ?, 'tool', 100, 7, 'opencode', NULL)",
        ).run(sessionId, "read:32");

        const tagger = createTagger();

        //#when
        tagger.initFromDb(sessionId, db);

        //#then — NULL-owner row is NOT bound to any composite key, so a
        // probe with any owner returns undefined. The lazy-adoption DB
        // path will discover and claim it on the next assignToolTag call.
        expect(tagger.getToolTag(sessionId, "read:32", "msg-X")).toBeUndefined();
        // But the row is still discoverable via the helper.
        expect(getNullOwnerToolTag(db, sessionId, "read:32")?.tagNumber).toBe(7);
    });

    it("assignTag throws when called with type='tool' (defense-in-depth)", () => {
        //#given
        const sessionId = "ses-1";
        const tagger = createTagger();

        //#when / then — TS narrowing catches at compile time; runtime guard
        // is the safety net for any caller that bypasses TS via `as any`.
        expect(() =>
            (tagger.assignTag as unknown as (...args: unknown[]) => number)(
                sessionId,
                "read:32",
                "tool",
                100,
                db,
            ),
        ).toThrow(/forbidden/);
    });

    it("bindToolTag stores composite-keyed binding without DB write", () => {
        //#given
        const sessionId = "ses-1";
        const tagger = createTagger();

        //#when
        tagger.bindToolTag(sessionId, "read:32", "msg-A", 42);

        //#then
        expect(tagger.getToolTag(sessionId, "read:32", "msg-A")).toBe(42);
        // No DB row was created.
        expect(getTagsBySession(db, sessionId)).toHaveLength(0);
    });
});
