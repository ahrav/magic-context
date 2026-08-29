/// <reference types="bun-types" />

/**
 * Tagger collision-recovery and counter-drift tests.
 *
 * These exercise the real bun:sqlite-backed paths that the lighter mock-based
 * tagger.test.ts cannot reach: UNIQUE-constraint collisions, monotonic counter
 * upserts and initFromDb refresh on memory drift.
 *
 * The bug these protect against is the cache-bust cascade traced in the
 * v0.15.7 incident — once session_meta.counter dropped below the tags table's
 * actual max tag_number for any reason (outer-transaction rollback in the
 * legacy tagMessages, multi-process race, non-monotonic counter upsert), the
 * tagger could never self-heal and every transform pass that allocated a new
 * tag would either fail outright or fall into the throw-error recovery path,
 * which the transform's catch block then turned into a full message[0] rebuild.
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
 * Open a file-backed test DB. Required for tests that need a SECOND
 * `Database` connection to the same file (e.g. cross-process WAL behavior),
 * since `:memory:` databases are private to one connection.
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
        //#given — simulate the v0.15.6 failure mode: a previous pass committed
        // tags up to 5 in DB but session_meta.counter is stuck at 2 (e.g. from
        // an outer-transaction rollback that undid the counter upsert while
        // inner SAVEPOINTs already committed the inserts).
        const sessionId = "session-drift";
        const tagger = createTagger();
        tagger.assignTag(sessionId, "msg-1", "message", 100, db);
        tagger.assignTag(sessionId, "msg-2", "message", 100, db);
        // Fake legacy state: bump tags table to 5 directly, leave counter at 2
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, ?, 'message', 0, ?)",
        ).run(sessionId, "legacy-msg-3", 3);
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, ?, 'message', 0, ?)",
        ).run(sessionId, "legacy-msg-4", 4);
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, ?, 'message', 0, ?)",
        ).run(sessionId, "legacy-msg-5", 5);
        // Force in-memory counter to be stale
        const fresh = createTagger();
        // Don't initFromDb — simulate not realizing the drift exists yet.
        // The first assignTag call should detect via the dbMax read and skip
        // ahead to 6 instead of trying 3 and colliding.

        //#when
        const newTag = fresh.assignTag(sessionId, "msg-new", "message", 100, db);

        //#then
        expect(newTag).toBe(6);
        expect(getCounter(db, sessionId)).toBe(6);
        expect(getMaxTagNumberBySession(db, sessionId)).toBe(6);
    });

    it("rebinds when a different writer raced this messageId to its own tag", () => {
        //#given — simulate a concurrent writer that just inserted a row for
        // our messageId before we got to it.
        const sessionId = "session-race";
        const tagger = createTagger();
        tagger.assignTag(sessionId, "msg-prior", "message", 100, db);
        // Concurrent writer claims tag 2 for "msg-raced" while our tagger is
        // about to allocate.
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, ?, 'message', 0, ?)",
        ).run(sessionId, "msg-raced", 2);
        // Our process didn't observe that insert in memory yet — counter is
        // still 1 in our tagger, so it would propose 2.

        //#when — assigning the raced message should rebind to the existing
        // tag rather than throw or duplicate.
        const racedTag = tagger.assignTag(sessionId, "msg-raced", "message", 100, db);

        //#then
        expect(racedTag).toBe(2);
        expect(tagger.getTag(sessionId, "msg-raced", "message")).toBe(2);
    });

    it("monotonic counter upsert never moves backward under concurrent writes", () => {
        //#given — two taggers that write counter values out of order.
        const sessionId = "session-monotonic";
        const taggerA = createTagger();
        const taggerB = createTagger();

        //#when — A allocates tag 5, then B (with a stale view) tries to
        // upsert the counter back to 3.
        taggerA.assignTag(sessionId, "msg-a-1", "message", 100, db);
        taggerA.assignTag(sessionId, "msg-a-2", "message", 100, db);
        taggerA.assignTag(sessionId, "msg-a-3", "message", 100, db);
        taggerA.assignTag(sessionId, "msg-a-4", "message", 100, db);
        taggerA.assignTag(sessionId, "msg-a-5", "message", 100, db);
        expect(getCounter(db, sessionId)).toBe(5);
        // Force B to do a stale write: directly call the upsert SQL with a
        // smaller value, simulating B's in-memory counter being 3.
        db.prepare(
            "INSERT INTO session_meta (session_id, counter) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET counter = MAX(session_meta.counter, excluded.counter)",
        ).run(sessionId, 3);

        //#then — counter must still be 5, not 3.
        expect(getCounter(db, sessionId)).toBe(5);
        // And B's next allocation through assignTag picks up the live max.
        const nextFromB = taggerB.assignTag(sessionId, "msg-b-new", "message", 100, db);
        expect(nextFromB).toBe(6);
    });

    it("initFromDb refreshes from DB even when session is already known in memory", () => {
        //#given — tagger has already loaded counter 2 from DB.
        const sessionId = "session-refresh";
        const tagger = createTagger();
        tagger.assignTag(sessionId, "msg-1", "message", 100, db);
        tagger.assignTag(sessionId, "msg-2", "message", 100, db);
        expect(tagger.getCounter(sessionId)).toBe(2);

        // Another writer commits tags 3-5 (different messageIds) in DB.
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, ?, 'message', 0, ?)",
        ).run(sessionId, "msg-other-3", 3);
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, ?, 'message', 0, ?)",
        ).run(sessionId, "msg-other-4", 4);
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, ?, 'message', 0, ?)",
        ).run(sessionId, "msg-other-5", 5);

        //#when — initFromDb should refresh, not early-return based on
        // in-memory state.
        tagger.initFromDb(sessionId, db);

        //#then — counter is now at the live DB max, and assignments reflect
        // the new rows.
        expect(tagger.getCounter(sessionId)).toBe(5);
        expect(tagger.getTag(sessionId, "msg-other-3", "message")).toBe(3);
        expect(tagger.getTag(sessionId, "msg-other-5", "message")).toBe(5);
        // Next allocation goes to 6.
        const next = tagger.assignTag(sessionId, "msg-fresh", "message", 100, db);
        expect(next).toBe(6);
    });

    it("does not infinite-loop or wedge if collisions persist (capped retries)", () => {
        //#given — pathological case: pre-fill many tag numbers so the tagger
        // has to walk past several before finding a free slot.
        const sessionId = "session-walk";
        for (let n = 1; n <= 4; n++) {
            db.prepare(
                "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, ?, 'message', 0, ?)",
            ).run(sessionId, `legacy-${n}`, n);
        }
        // counter still 0 — first attempt would propose 1 and collide.
        const tagger = createTagger();

        //#when
        const tag = tagger.assignTag(sessionId, "msg-new", "message", 100, db);

        //#then — retry loop walked past 1-4, allocated 5 cleanly.
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
        // Different session, same messageId — must not leak.
        expect(getTagNumberByMessageId(db, "s2", "msg-shared")).toBeNull();
    });
});

describe("initFromDb signature cache", () => {
    let db: Database;

    beforeEach(() => {
        db = openTestDb();
    });

    /**
     * Cache hit after same-connection tagger writes: own writes update the
     * in-memory map/counter directly, so data_version-only initFromDb must not
     * rescan assignments on the next pass.
     */
    it("cache hit: skips full reload after same-connection tagger writes", () => {
        const sessionId = "s-cache-hit-own-writes";
        const tagger = createTagger();
        const reloads = trackAssignmentReloads(db);
        try {
            // Pass start: establish the data_version signature.
            tagger.initFromDb(sessionId, db);
            expect(reloads.count()).toBe(1);

            // Same pass: tagger writes two assignments and updates memory in place.
            expect(tagger.assignTag(sessionId, "msg-1", "message", 100, db)).toBe(1);
            expect(tagger.assignTag(sessionId, "msg-2", "message", 100, db)).toBe(2);
            expect(tagger.getAssignments(sessionId).size).toBe(2);

            // Next pass: data_version is unchanged for own-connection writes, so
            // initFromDb cache-hits and does NOT rebuild the tampered map.
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

            // Next pass with only one appended message: cache hit, no full rescan.
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
        // Different mechanism: a SECOND open Database object commits a
        // row to the same file. PRAGMA data_version bumps for OTHER-
        // connection commits but NOT for our own. This proves the
        // data_version probe is wired correctly. Requires WAL + a real
        // file-backed DB because :memory: databases are private to one
        // connection.
        const tmpDir = mkdtempSync(join(tmpdir(), "magic-context-tagger-"));
        try {
            const dbPath = join(tmpDir, "ctx.db");
            const dbA = openFileBackedTestDb(dbPath);
            const dbB = new Database(dbPath);
            try {
                const sessionId = "s-second-conn";
                const tagger = createTagger();

                // Establish baseline through dbA.
                tagger.assignTag(sessionId, "msg-1", "message", 100, dbA);
                tagger.initFromDb(sessionId, dbA);
                expect(tagger.getCounter(sessionId)).toBe(1);

                //#when — second connection commits a row.
                dbB.prepare(
                    "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, ?, 'message', 0, ?)",
                ).run(sessionId, "msg-from-dbB", 2);

                // Tagger sees dbA only. initFromDb(sessionId, dbA) should
                // detect the data_version bump (dbA's pragma reflects
                // dbB's commit because they're separate connections to
                // the same DB file) and reload.
                tagger.initFromDb(sessionId, dbA);

                //#then — full reload picked up dbB's commit.
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
                /* Ignore EBUSY on Windows */
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

            // Session A's same-connection writes do not bump data_version and are
            // scoped to A's map, so B's next initFromDb is a cache hit with no
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
        // resetCounter is called by /ctx-recomp full rebuild, which also
        // wipes the tags table for the session via separate code paths.
        // Here we simulate that whole workflow: reset counter, delete
        // tag rows, then re-populate. The test verifies that initFromDb
        // doesn't cache-hit against pre-reset state.
        const sessionId = "s-reset";
        const tagger = createTagger();
        tagger.assignTag(sessionId, "msg-1", "message", 100, db);
        tagger.assignTag(sessionId, "msg-2", "message", 100, db);
        tagger.initFromDb(sessionId, db);
        expect(tagger.getCounter(sessionId)).toBe(2);
        expect(tagger.getAssignments(sessionId).size).toBe(2);

        //#when — full /ctx-recomp-style reset: drop tag rows, reset
        // counter, repopulate.
        db.prepare("DELETE FROM tags WHERE session_id = ?").run(sessionId);
        tagger.resetCounter(sessionId, db);
        expect(tagger.getCounter(sessionId)).toBe(0);
        // Recomp inserts the rebuilt tags.
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, ?, 'message', 0, ?)",
        ).run(sessionId, "rebuilt-msg-1", 1);
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, ?, 'message', 0, ?)",
        ).run(sessionId, "rebuilt-msg-2", 2);

        // initFromDb must not cache-hit against the pre-reset signature.
        // resetCounter() explicitly invalidates the data_version signature so
        // the next load sees the rebuilt rows even when the same connection
        // performed the surrounding delete/insert work.
        tagger.initFromDb(sessionId, db);

        //#then — full reload picked up the rebuilt rows.
        expect(tagger.getCounter(sessionId)).toBe(2);
        expect(tagger.getTag(sessionId, "rebuilt-msg-1", "message")).toBe(1);
        expect(tagger.getTag(sessionId, "rebuilt-msg-2", "message")).toBe(2);
        // Old assignments are gone.
        expect(tagger.getTag(sessionId, "msg-1", "message")).toBeUndefined();
        expect(tagger.getTag(sessionId, "msg-2", "message")).toBeUndefined();
    });

    it("cleanup invalidates signature so a re-loaded session does a full reload", () => {
        const sessionId = "s-cleanup";
        const tagger = createTagger();
        tagger.assignTag(sessionId, "msg-1", "message", 100, db);
        tagger.initFromDb(sessionId, db);

        //#when — session is cleaned up (e.g. session.deleted lifecycle),
        // then later something tries to load it again.
        tagger.cleanup(sessionId);
        expect(tagger.getCounter(sessionId)).toBe(0);
        expect(tagger.getAssignments(sessionId).size).toBe(0);

        // Subsequent initFromDb must do a full reload to repopulate
        // memory from disk, NOT cache-hit against the pre-cleanup
        // signature.
        tagger.initFromDb(sessionId, db);

        //#then — counter and assignments restored from DB.
        expect(tagger.getCounter(sessionId)).toBe(1);
        expect(tagger.getTag(sessionId, "msg-1", "message")).toBe(1);
    });
});
