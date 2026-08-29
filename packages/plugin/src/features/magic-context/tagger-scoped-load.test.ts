/// <reference types="bun-types" />

/**
 * Tagger load-scoping tests (OpenCode `initFromDb(sessionId, db, floor)`).
 *
 * On a large/old session the tagger used to preload EVERY tag row (100K+) on
 * every cache-miss pass (~32ms). The scoped load reads only `tag_number >= floor`,
 * where `floor` is derived from the live wire's first message. Correctness rests
 * on self-heal: a below-floor in-wire tag is NOT preloaded but `allocateTag`'s
 * `dbExistingLookup` rebinds its EXACT persisted number on first touch — so the
 * §N§ wire bytes are byte-identical; scoping only changes how many point lookups
 * happen. These tests lock that property plus the floor query, the cache
 * signature, and counter safety.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import type { Database as DatabaseType } from "../../shared/sqlite";
import {
    deriveTagLoadFloor,
    getAllStatusTagTokenTotalsFlat,
    getMaxTagNumberBySession,
    getMinMessageTagNumberForRawId,
    getTriggerTagTokenUpperBound,
} from "./storage-tags";
import { createTagger } from "./tagger";
import { createDirectTestDatabase } from "./test-database";

function openTestDb(): DatabaseType {
    const db = createDirectTestDatabase().db;
    return db;
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

function insertMessageTag(
    db: DatabaseType,
    sessionId: string,
    contentId: string,
    tagNumber: number,
): void {
    db.prepare(
        "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number, harness) VALUES (?, ?, 'message', 100, ?, 'opencode')",
    ).run(sessionId, contentId, tagNumber);
}

describe("getMinMessageTagNumberForRawId", () => {
    let db: DatabaseType;
    beforeEach(() => {
        db = openTestDb();
    });

    it("returns the lowest tag_number across a rawId's message/file content-ids", () => {
        const s = "ses-1";
        insertMessageTag(db, s, "msg_abc:p0", 5);
        insertMessageTag(db, s, "msg_abc:p1", 6);
        // a file tag for the same rawId (lower number)
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number, harness) VALUES (?, ?, 'file', 100, ?, 'opencode')",
        ).run(s, "msg_abc:file0", 4);
        expect(getMinMessageTagNumberForRawId(db, s, "msg_abc")).toBe(4);
    });

    it("does NOT match a different rawId that shares a prefix (msg_abc vs msg_abcd)", () => {
        const s = "ses-1";
        insertMessageTag(db, s, "msg_abc:p0", 10);
        insertMessageTag(db, s, "msg_abcd:p0", 3); // longer rawId, lower number
        // The half-open range [msg_abc:, msg_abc;) must exclude msg_abcd:p0.
        expect(getMinMessageTagNumberForRawId(db, s, "msg_abc")).toBe(10);
        expect(getMinMessageTagNumberForRawId(db, s, "msg_abcd")).toBe(3);
    });

    it("returns null for an untagged rawId", () => {
        expect(getMinMessageTagNumberForRawId(db, "ses-1", "msg_nope")).toBeNull();
    });

    it("returns null defensively for a rawId containing ':' (delimiter proof would break)", () => {
        const s = "ses-1";
        insertMessageTag(db, s, "weird:id:p0", 7);
        expect(getMinMessageTagNumberForRawId(db, s, "weird:id")).toBeNull();
    });

    it("ignores tool tags (their message_id is the callId, not rawId:pN)", () => {
        const s = "ses-1";
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number, harness, tool_owner_message_id) VALUES (?, ?, 'tool', 100, 2, 'opencode', ?)",
        ).run(s, "read:32", "msg_abc");
        // No message/file content-id for msg_abc → null even though a tool tag
        // is owned by msg_abc.
        expect(getMinMessageTagNumberForRawId(db, s, "msg_abc")).toBeNull();
    });
});

describe("tagger scoped initFromDb", () => {
    let db: DatabaseType;
    beforeEach(() => {
        db = openTestDb();
    });

    it("loads only tags >= floor into the in-memory map", () => {
        const s = "ses-1";
        for (let n = 1; n <= 10; n++) insertMessageTag(db, s, `msg_${n}:p0`, n);
        const tagger = createTagger();
        tagger.initFromDb(s, db, 8);
        // >= floor are preloaded
        expect(tagger.getTag(s, "msg_8:p0", "message")).toBe(8);
        expect(tagger.getTag(s, "msg_10:p0", "message")).toBe(10);
        // below floor are NOT preloaded
        expect(tagger.getTag(s, "msg_1:p0", "message")).toBeUndefined();
        expect(tagger.getTag(s, "msg_7:p0", "message")).toBeUndefined();
    });

    it("self-heals a below-floor in-wire tag to its EXACT persisted number (byte-identical)", () => {
        const s = "ses-1";
        for (let n = 1; n <= 10; n++) insertMessageTag(db, s, `msg_${n}:p0`, n);
        const tagger = createTagger();
        tagger.initFromDb(s, db, 8); // excludes 1..7
        // assignTag for a below-floor content-id must REBIND the persisted number,
        // not allocate a fresh one — this is what keeps the §N§ prefix stable.
        const rebound = tagger.assignTag(s, "msg_3:p0", "message", 100, db);
        expect(rebound).toBe(3);
        // The full (unscoped) load would have produced the identical number.
        const fresh = createTagger();
        fresh.initFromDb(s, db, 0);
        expect(fresh.getTag(s, "msg_3:p0", "message")).toBe(3);
    });

    it("counter stays at the true DB max under a scoped load (max is always >= floor)", () => {
        const s = "ses-1";
        for (let n = 1; n <= 10; n++) insertMessageTag(db, s, `msg_${n}:p0`, n);
        const tagger = createTagger();
        tagger.initFromDb(s, db, 9); // loads 9,10
        expect(getMaxTagNumberBySession(db, s)).toBe(10);
        // Next fresh allocation must go above the true DB max, never collide.
        const next = tagger.assignTag(s, "msg_new:p0", "message", 100, db);
        expect(next).toBe(11);
    });

    it("a floor change forces exactly one reload; same floor + same data_version cache-HITs", () => {
        const s = "ses-1";
        for (let n = 1; n <= 10; n++) insertMessageTag(db, s, `msg_${n}:p0`, n);
        const tagger = createTagger();
        const tracker = trackAssignmentReloads(db);
        try {
            tagger.initFromDb(s, db, 8); // reload #1
            tagger.initFromDb(s, db, 8); // same floor + dv → HIT, no reload
            expect(tracker.count()).toBe(1);
            tagger.initFromDb(s, db, 3); // floor drop (revert) → reload #2
            expect(tracker.count()).toBe(2);
            // After the wider reload the previously-excluded tag is now preloaded.
            expect(tagger.getTag(s, "msg_3:p0", "message")).toBe(3);
        } finally {
            tracker.restore();
        }
    });

    it("floor=0 (default / Pi) loads the full session unchanged", () => {
        const s = "ses-1";
        for (let n = 1; n <= 10; n++) insertMessageTag(db, s, `msg_${n}:p0`, n);
        const tagger = createTagger();
        tagger.initFromDb(s, db); // no floor arg → 0
        expect(tagger.getTag(s, "msg_1:p0", "message")).toBe(1);
        expect(tagger.getTag(s, "msg_10:p0", "message")).toBe(10);
    });
});

describe("deriveTagLoadFloor", () => {
    let db: DatabaseType;
    beforeEach(() => {
        db = openTestDb();
    });

    it("returns MIN over the first K wire ids minus the safety margin", () => {
        const s = "ses-1";
        // Tags 400..410 belong to the leading wire messages.
        for (let n = 400; n <= 410; n++) insertMessageTag(db, s, `msg_${n}:p0`, n);
        // Floor = min(400) - 256 = 144.
        const floor = deriveTagLoadFloor(db, s, ["msg_400", "msg_401", "msg_402"]);
        expect(floor).toBe(144);
    });

    it("takes the MIN, not the first id (guards a high-tag leading summary)", () => {
        const s = "ses-1";
        // A leading compaction-summary carries a RECENT (high) tag despite sitting
        // first; the genuinely-oldest wire message behind it has a lower tag.
        insertMessageTag(db, s, "msg_summary:p0", 9000); // first in wire, high tag
        insertMessageTag(db, s, "msg_real:p0", 500); // older, lower tag
        const floor = deriveTagLoadFloor(db, s, ["msg_summary", "msg_real"]);
        // MIN(9000, 500) - 256 = 244 — NOT 9000-256 (which would exclude msg_real).
        expect(floor).toBe(244);
    });

    it("clamps to 0 and skips untagged/empty ids", () => {
        const s = "ses-1";
        insertMessageTag(db, s, "msg_a:p0", 100); // 100 - 256 < 0 → clamps to 0
        expect(deriveTagLoadFloor(db, s, [null, undefined, "", "msg_a"])).toBe(0);
        expect(deriveTagLoadFloor(db, s, ["msg_untagged"])).toBe(0);
    });

    it("scans PAST tagless leaders (ghost/tool-only) to the first real :p tag", () => {
        // Reproduces the live regression: after a compaction marker the wire head
        // is a run of tool-only / tagless ghost messages with NO :p/:file tag, so
        // the old 8-id-probe MIN exhausted on NULLs → floor 0 → full scan.
        const s = "ses-1";
        // 3 tagless leaders (no message/file tag), then the first real one at 9000.
        insertMessageTag(db, s, "msg_real:p0", 9000);
        const floor = deriveTagLoadFloor(db, s, [
            "msg_ghost1",
            "msg_tool2",
            "msg_tool3",
            "msg_real",
        ]);
        // Resolves (not 0). Base margin 256 + 3 skipped * 64 = 448 → 9000 - 448.
        expect(floor).toBe(9000 - (256 + 3 * 64));
    });

    it("widens the margin per skipped leader so skipped tool tags stay included", () => {
        const s = "ses-1";
        // One skipped leader → margin 256 + 64 = 320.
        insertMessageTag(db, s, "msg_real:p0", 1000);
        expect(deriveTagLoadFloor(db, s, ["msg_ghost", "msg_real"])).toBe(1000 - 320);
        // Zero skipped (first id resolves) → base margin only.
        expect(deriveTagLoadFloor(db, s, ["msg_real"])).toBe(1000 - 256);
    });

    it("stops at MAX_PROBES on a fully-tagless head → floor 0 (full-scan fallback)", () => {
        const s = "ses-1";
        // A real tag exists but only PAST the probe cap; 100 tagless leaders first.
        insertMessageTag(db, s, "msg_real:p0", 5000);
        const head: string[] = [];
        for (let i = 0; i < 100; i++) head.push(`msg_ghost${i}`);
        head.push("msg_real");
        // The first 64 probes are all NULL → break before reaching msg_real → 0.
        expect(deriveTagLoadFloor(db, s, head)).toBe(0);
    });
});

describe("scoped tag-token scans (boundary + trigger pre-gate)", () => {
    let db: DatabaseType;
    beforeEach(() => {
        db = openTestDb();
    });

    function insertToolTag(
        sessionId: string,
        callId: string,
        owner: string,
        tagNumber: number,
        tokens: number,
        status: "active" | "dropped" = "active",
    ): void {
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number, harness, tool_owner_message_id, token_count, status) VALUES (?, ?, 'tool', 100, ?, 'opencode', ?, ?, ?)",
        ).run(sessionId, callId, tagNumber, owner, tokens, status);
    }
    function insertMsgTagTokens(
        sessionId: string,
        contentId: string,
        tagNumber: number,
        tokens: number | null,
        status: "active" | "dropped" = "active",
    ): void {
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number, harness, token_count, status) VALUES (?, ?, 'message', 100, ?, 'opencode', ?, ?)",
        ).run(sessionId, contentId, tagNumber, tokens, status);
    }

    it("getAllStatusTagTokenTotalsFlat with floor matches the full scan for in-range messages", () => {
        const s = "ses-1";
        // Old (below floor) + new (above floor) messages.
        insertMsgTagTokens(s, "msg_old:p0", 10, 111);
        insertMsgTagTokens(s, "msg_new:p0", 5000, 222);
        const full = getAllStatusTagTokenTotalsFlat(db, s, 0).totals;
        const scoped = getAllStatusTagTokenTotalsFlat(db, s, 4000).totals;
        // In-range message: identical total in both.
        expect(scoped.get("msg_new")).toBe(222);
        expect(full.get("msg_new")).toBe(222);
        // Below-floor message: present in full, absent in scoped (it would be
        // live-tokenized to the same value by the boundary).
        expect(full.get("msg_old")).toBe(111);
        expect(scoped.has("msg_old")).toBe(false);
    });

    it("getTriggerTagTokenUpperBound scoped sum is a tighter valid upper bound", () => {
        const s = "ses-1";
        insertToolTag(s, "read:1", "m_old", 10, 1000, "dropped");
        insertToolTag(s, "read:2", "m_new", 5000, 300, "active");
        const full = getTriggerTagTokenUpperBound(db, s, 0);
        const scoped = getTriggerTagTokenUpperBound(db, s, 4000);
        expect(full.bound).toBe(1300); // both rows
        expect(scoped.bound).toBe(300); // only the in-range row — tighter, still ≥ eligible
        expect(scoped.bound).toBeLessThanOrEqual(full.bound);
    });

    it("scoping drops nullCount to 0 by excluding un-backfilled legacy rows below the floor", () => {
        const s = "ses-1";
        // Legacy below-floor row with NULL token_count — never backfilled, so a
        // whole-session nullCount stays > 0 forever and the pre-gate skip can
        // never trigger. Scoping past it fixes that.
        insertMsgTagTokens(s, "msg_legacy:p0", 10, null);
        insertMsgTagTokens(s, "msg_new:p0", 5000, 222);
        expect(getTriggerTagTokenUpperBound(db, s, 0).nullCount).toBe(1);
        expect(getTriggerTagTokenUpperBound(db, s, 4000).nullCount).toBe(0);
    });
});
