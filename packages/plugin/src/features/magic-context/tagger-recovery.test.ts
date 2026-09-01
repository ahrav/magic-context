/// <reference types="bun-types" />

/**
 *
 * These tests require bun:sqlite behavior.
 *
 * `assignTag` must recover when `session_meta.counter` is below the session's maximum `tags.tag_number`.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseType } from "../../shared/sqlite";
import { Database } from "../../shared/sqlite";
import { getMaxTagNumberBySession, getTagNumberByMessageId } from "./storage-tags";
import { createTagger } from "./tagger";
import { createDirectTestDatabase } from "./test-database";

function openTestDb(): DatabaseType {
    const db = createDirectTestDatabase().db;
    return db;
}

/**
 * File-backed databases allow a second connection because `:memory:` databases are per-connection.
 */
function openFileBackedTestDb(filePath: string): DatabaseType {
    return createDirectTestDatabase({ path: filePath }).db;
}

function getCounter(db: Database, sessionId: string): number {
    const row = db
        .prepare("SELECT counter FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { counter: number } | null | undefined;
    return row?.counter ?? 0;
}

function trackAssignmentReloads(db: DatabaseType): { count: () => number; restore: () => void } {
    let reloads = 0;
    const originalPrepare = db.prepare.bind(db) as DatabaseType["prepare"];
    db.prepare = ((sql: string) => {
        if (sql.includes("SELECT message_id, tag_number, type, tool_owner_message_id,")) {
            reloads += 1;
        }
        return originalPrepare(sql);
    }) as DatabaseType["prepare"];

    return {
        count: () => reloads,
        restore: () => {
            db.prepare = originalPrepare;
        },
    };
}

describe("tagger collision recovery", () => {
    let db: Database;

    beforeEach(() => {
        db = openTestDb();
    });

    it("recovers when memory counter is behind DB max for a different message", () => {
        const sessionId = "session-drift";
        const tagger = createTagger();
        tagger.assignTag(sessionId, "msg-1", "message", 100, db);
        tagger.assignTag(sessionId, "msg-2", "message", 100, db);
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, ?, 'message', 0, ?)",
        ).run(sessionId, "legacy-msg-3", 3);
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, ?, 'message', 0, ?)",
        ).run(sessionId, "legacy-msg-4", 4);
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, ?, 'message', 0, ?)",
        ).run(sessionId, "legacy-msg-5", 5);
        const fresh = createTagger();
        // The test omits `initFromDb` so `assignTag` must detect the stale counter.
        // `assignTag` reads the database maximum and allocates tag 6 instead of retrying tag 3.

        //#when
        const newTag = fresh.assignTag(sessionId, "msg-new", "message", 100, db);

        //#then
        expect(newTag).toBe(6);
        expect(getCounter(db, sessionId)).toBe(6);
        expect(getMaxTagNumberBySession(db, sessionId)).toBe(6);
    });

    it("rebinds when a different writer raced this messageId to its own tag", () => {
        // The direct insert models a concurrent writer inserting a row for the same `messageId` before `assignTag` allocates a tag.
        const sessionId = "session-race";
        const tagger = createTagger();
        tagger.assignTag(sessionId, "msg-prior", "message", 100, db);
        // The direct insert models a concurrent writer assigning `msg-raced` tag 2 before allocation.
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, ?, 'message', 0, ?)",
        ).run(sessionId, "msg-raced", 2);
        // The tagger's in-memory counter remains 1, so it proposes tag 2.
        // The tagger's in-memory counter is 1, so it proposes tag 2.

        // `assignTag` rebinds `msg-raced` to its existing tag instead of throwing or creating a duplicate.
        const racedTag = tagger.assignTag(sessionId, "msg-raced", "message", 100, db);

        //#then
        expect(racedTag).toBe(2);
        expect(tagger.getTag(sessionId, "msg-raced", "message")).toBe(2);
    });

    it("monotonic counter upsert never moves backward under concurrent writes", () => {
        const sessionId = "session-monotonic";
        const taggerA = createTagger();
        const taggerB = createTagger();

        taggerA.assignTag(sessionId, "msg-a-1", "message", 100, db);
        taggerA.assignTag(sessionId, "msg-a-2", "message", 100, db);
        taggerA.assignTag(sessionId, "msg-a-3", "message", 100, db);
        taggerA.assignTag(sessionId, "msg-a-4", "message", 100, db);
        taggerA.assignTag(sessionId, "msg-a-5", "message", 100, db);
        expect(getCounter(db, sessionId)).toBe(5);
        db.prepare(
            "INSERT INTO session_meta (session_id, counter) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET counter = MAX(session_meta.counter, excluded.counter)",
        ).run(sessionId, 3);

        expect(getCounter(db, sessionId)).toBe(5);
        const nextFromB = taggerB.assignTag(sessionId, "msg-b-new", "message", 100, db);
        expect(nextFromB).toBe(6);
    });

    it("initFromDb refreshes from DB even when session is already known in memory", () => {
        const sessionId = "session-refresh";
        const tagger = createTagger();
        tagger.assignTag(sessionId, "msg-1", "message", 100, db);
        tagger.assignTag(sessionId, "msg-2", "message", 100, db);
        expect(tagger.getCounter(sessionId)).toBe(2);

        // Direct inserts model tags written by another process.
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, ?, 'message', 0, ?)",
        ).run(sessionId, "msg-other-3", 3);
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, ?, 'message', 0, ?)",
        ).run(sessionId, "msg-other-4", 4);
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, ?, 'message', 0, ?)",
        ).run(sessionId, "msg-other-5", 5);

        // initFromDb refreshes an already cached session from the database.
        // in-memory state.
        tagger.initFromDb(sessionId, db);

        expect(tagger.getCounter(sessionId)).toBe(5);
        expect(tagger.getTag(sessionId, "msg-other-3", "message")).toBe(3);
        expect(tagger.getTag(sessionId, "msg-other-5", "message")).toBe(5);
        const next = tagger.assignTag(sessionId, "msg-fresh", "message", 100, db);
        expect(next).toBe(6);
    });

    it("does not infinite-loop or wedge if collisions persist (capped retries)", () => {
        // Existing tags 1–4 force collision retries.
        const sessionId = "session-walk";
        for (let n = 1; n <= 4; n++) {
            db.prepare(
                "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, ?, 'message', 0, ?)",
            ).run(sessionId, `legacy-${n}`, n);
        }
        // The counter is 0, so the first allocation attempts tag 1 and collides.
        const tagger = createTagger();

        //#when
        const tag = tagger.assignTag(sessionId, "msg-new", "message", 100, db);

        // `assignTag` retries tags 1–4 and allocates tag 5.
        expect(tag).toBe(5);
    });
});

describe("getTagNumberByMessageId helper", () => {
    let db: Database;

    beforeEach(() => {
        db = openTestDb();
    });

    it("returns the tag for a known messageId", () => {
        const sessionId = "s1";
        const tagger = createTagger();
        tagger.assignTag(sessionId, "msg-target", "message", 100, db);

        const tag = getTagNumberByMessageId(db, sessionId, "msg-target");
        expect(tag).toBe(1);
    });

    it("returns null for an unknown messageId", () => {
        expect(getTagNumberByMessageId(db, "s1", "msg-missing")).toBeNull();
    });

    it("scopes to the correct session", () => {
        const tagger = createTagger();
        tagger.assignTag("s1", "msg-shared", "message", 100, db);
        // Tags for one session do not apply to the same messageId in another session.
        expect(getTagNumberByMessageId(db, "s2", "msg-shared")).toBeNull();
    });
});

describe("initFromDb signature cache", () => {
    let db: Database;

    beforeEach(() => {
        db = openTestDb();
    });

    /**
     * assignTag updates its in-memory state after writes on the same connection.
     */
    it("cache hit: skips full reload after same-connection tagger writes", () => {
        const sessionId = "s-cache-hit-own-writes";
        const tagger = createTagger();
        const reloads = trackAssignmentReloads(db);
        try {
            tagger.initFromDb(sessionId, db);
            expect(reloads.count()).toBe(1);

            // assignTag updates the in-memory map and counter after each write.
            expect(tagger.assignTag(sessionId, "msg-1", "message", 100, db)).toBe(1);
            expect(tagger.assignTag(sessionId, "msg-2", "message", 100, db)).toBe(2);
            expect(tagger.getAssignments(sessionId).size).toBe(2);

            // initFromDb preserves in-memory assignments when data_version is unchanged after its own writes.
            const sessionAssignmentsRef = tagger.getAssignments(sessionId) as Map<string, number>;
            sessionAssignmentsRef.delete("msg-1");
            tagger.initFromDb(sessionId, db);

            expect(reloads.count()).toBe(1);
            expect(tagger.getAssignments(sessionId).size).toBe(1);
            expect(tagger.getTag(sessionId, "msg-1", "message")).toBeUndefined();
            expect(tagger.getTag(sessionId, "msg-2", "message")).toBe(2);
        } finally {
            reloads.restore();
        }
    });

    it("steady state: adding one new tag cache-hits initFromDb and preserves prior assignments", () => {
        const sessionId = "s-steady-add-one";
        const tagger = createTagger();
        const reloads = trackAssignmentReloads(db);
        try {
            tagger.initFromDb(sessionId, db);
            expect(reloads.count()).toBe(1);

            const first = tagger.assignTag(sessionId, "msg-1", "message", 100, db);
            const second = tagger.assignTag(sessionId, "msg-2", "message", 100, db);
            expect([first, second]).toEqual([1, 2]);

            // initFromDb skips a full rescan when its own write has already updated the in-memory state.
            tagger.initFromDb(sessionId, db);
            const third = tagger.assignTag(sessionId, "msg-3", "message", 100, db);
            tagger.initFromDb(sessionId, db);

            expect(reloads.count()).toBe(1);
            expect(third).toBe(3);
            expect(tagger.getTag(sessionId, "msg-1", "message")).toBe(1);
            expect(tagger.getTag(sessionId, "msg-2", "message")).toBe(2);
            expect(tagger.getTag(sessionId, "msg-3", "message")).toBe(3);
        } finally {
            reloads.restore();
        }
    });

    it("cache miss: a second Database connection bumps data_version and forces reload", () => {
        // Commits from another Database connection increment the observing connection's PRAGMA data_version; commits on the observing connection do not.
        // File-backed databases are required because :memory: databases are private per connection.
        // connection.
        const tmpDir = mkdtempSync(join(tmpdir(), "magic-context-tagger-"));
        try {
            const dbPath = join(tmpDir, "ctx.db");
            const dbA = openFileBackedTestDb(dbPath);
            const dbB = new Database(dbPath);
            try {
                const sessionId = "s-second-conn";
                const tagger = createTagger();

                tagger.assignTag(sessionId, "msg-1", "message", 100, dbA);
                tagger.initFromDb(sessionId, dbA);
                expect(tagger.getCounter(sessionId)).toBe(1);

                dbB.prepare(
                    "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, ?, 'message', 0, ?)",
                ).run(sessionId, "msg-from-dbB", 2);

                // `initFromDb(sessionId, dbA)` reloads when `dbA` observes `dbB`'s commit through `data_version`.
                tagger.initFromDb(sessionId, dbA);

                expect(tagger.getCounter(sessionId)).toBe(2);
                expect(tagger.getTag(sessionId, "msg-from-dbB", "message")).toBe(2);
            } finally {
                dbB.close();
                dbA.close();
            }
        } finally {
            try {
                rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
            } catch {
                /* */
            }
        }
    });

    it("cross-session same-process tagger writes do not invalidate or contaminate another session", () => {
        const tagger = createTagger();
        const sessionA = "s-A";
        const sessionB = "s-B";
        const reloads = trackAssignmentReloads(db);
        try {
            tagger.initFromDb(sessionA, db);
            tagger.initFromDb(sessionB, db);
            expect(reloads.count()).toBe(2);

            expect(tagger.assignTag(sessionB, "b-msg-1", "message", 100, db)).toBe(1);
            tagger.initFromDb(sessionB, db);
            expect(reloads.count()).toBe(2);

            expect(tagger.assignTag(sessionA, "a-msg-1", "message", 100, db)).toBe(1);
            expect(tagger.assignTag(sessionA, "a-msg-2", "message", 100, db)).toBe(2);

            // Session A's writes leave `data_version` unchanged and update only A's map, so `initFromDb(sessionB, db)` uses B's cache.
            // cross-contamination.
            tagger.initFromDb(sessionB, db);

            expect(reloads.count()).toBe(2);
            expect(tagger.getCounter(sessionB)).toBe(1);
            expect(tagger.getTag(sessionB, "b-msg-1", "message")).toBe(1);
            expect(tagger.getTag(sessionB, "a-msg-1", "message")).toBeUndefined();
            expect(tagger.getTag(sessionB, "a-msg-2", "message")).toBeUndefined();
            expect(tagger.getTag(sessionA, "a-msg-1", "message")).toBe(1);
            expect(tagger.getTag(sessionA, "a-msg-2", "message")).toBe(2);
        } finally {
            reloads.restore();
        }
    });

    it("unbindTag removes an in-memory assignment without requiring a DB reload", () => {
        const sessionId = "s-unbind";
        const tagger = createTagger();
        const reloads = trackAssignmentReloads(db);
        try {
            tagger.initFromDb(sessionId, db);
            expect(tagger.assignTag(sessionId, "msg-1", "message", 100, db)).toBe(1);
            expect(tagger.getTag(sessionId, "msg-1", "message")).toBe(1);

            tagger.unbindTag(sessionId, "msg-1");
            tagger.initFromDb(sessionId, db);

            expect(reloads.count()).toBe(1);
            expect(tagger.getTag(sessionId, "msg-1", "message")).toBeUndefined();
        } finally {
            reloads.restore();
        }
    });

    it("resetCounter invalidates signature so next initFromDb forces full reload", () => {
        // `initFromDb` must not use the pre-reset signature after `resetCounter` and tag-row replacement.
        const sessionId = "s-reset";
        const tagger = createTagger();
        tagger.assignTag(sessionId, "msg-1", "message", 100, db);
        tagger.assignTag(sessionId, "msg-2", "message", 100, db);
        tagger.initFromDb(sessionId, db);
        expect(tagger.getCounter(sessionId)).toBe(2);
        expect(tagger.getAssignments(sessionId).size).toBe(2);

        // counter, repopulate.
        db.prepare("DELETE FROM tags WHERE session_id = ?").run(sessionId);
        tagger.resetCounter(sessionId, db);
        expect(tagger.getCounter(sessionId)).toBe(0);
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, ?, 'message', 0, ?)",
        ).run(sessionId, "rebuilt-msg-1", 1);
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, ?, 'message', 0, ?)",
        ).run(sessionId, "rebuilt-msg-2", 2);

        // `resetCounter` invalidates the `data_version` signature so `initFromDb` reloads rows changed through the same connection.
        tagger.initFromDb(sessionId, db);

        expect(tagger.getCounter(sessionId)).toBe(2);
        expect(tagger.getTag(sessionId, "rebuilt-msg-1", "message")).toBe(1);
        expect(tagger.getTag(sessionId, "rebuilt-msg-2", "message")).toBe(2);
        expect(tagger.getTag(sessionId, "msg-1", "message")).toBeUndefined();
        expect(tagger.getTag(sessionId, "msg-2", "message")).toBeUndefined();
    });

    it("cleanup invalidates signature so a re-loaded session does a full reload", () => {
        const sessionId = "s-cleanup";
        const tagger = createTagger();
        tagger.assignTag(sessionId, "msg-1", "message", 100, db);
        tagger.initFromDb(sessionId, db);

        // `cleanup` invalidates the session signature so `initFromDb` performs a full reload instead of using the pre-cleanup cache.
        tagger.cleanup(sessionId);
        expect(tagger.getCounter(sessionId)).toBe(0);
        expect(tagger.getAssignments(sessionId).size).toBe(0);

        // signature.
        tagger.initFromDb(sessionId, db);

        expect(tagger.getCounter(sessionId)).toBe(1);
        expect(tagger.getTag(sessionId, "msg-1", "message")).toBe(1);
    });
});
