/// <reference types="bun-types" />

/**
 *
 *
 * A tool tag is unique per `(sessionId, callId, ownerMsgId)`.
 * A matching NULL-owner row is claimed on the first composite-key observation.
 * A partial unique index permits only one NULL-owner row to be adopted for each owner.
 * Remaining NULL-owner rows require observations with different owners.
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
        // The partial unique index permits one non-NULL `tool_owner_message_id` per `(sessionId, callId, ownerMsgId)`.
        const sessionId = "ses-1";
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number, harness, tool_owner_message_id) VALUES (?, ?, 'tool', 100, 1, 'opencode', NULL)",
        ).run(sessionId, "read:32");
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number, harness, tool_owner_message_id) VALUES (?, ?, 'tool', 200, 2, 'opencode', NULL)",
        ).run(sessionId, "read:32");

        const tagger = createTagger();

        // The first observation claims one NULL-owner row.
        const tag1 = tagger.assignToolTag(sessionId, "read:32", "msg-A", 100, db);

        expect(tag1).toBe(1);
        const remaining = getNullOwnerToolTag(db, sessionId, "read:32");
        expect(remaining?.tagNumber).toBe(2);

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
        const sessionId = "ses-1";
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number, harness, tool_owner_message_id) VALUES (?, ?, 'tool', 100, 7, 'opencode', NULL)",
        ).run(sessionId, "read:32");

        const tagger = createTagger();

        //#when
        tagger.initFromDb(sessionId, db);

        // A NULL-owner row is not bound to a composite key.
        // `getToolTag` ignores unowned rows until `assignToolTag` claims one.
        // `assignToolTag` claims an unowned row for the observed owner.
        expect(tagger.getToolTag(sessionId, "read:32", "msg-X")).toBeUndefined();
        // `getNullOwnerToolTag` returns the remaining unowned row.
        expect(getNullOwnerToolTag(db, sessionId, "read:32")?.tagNumber).toBe(7);
    });

    it("assignTag throws when called with type='tool' (defense-in-depth)", () => {
        //#given
        const sessionId = "ses-1";
        const tagger = createTagger();

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
        expect(getTagsBySession(db, sessionId)).toHaveLength(0);
    });
});
