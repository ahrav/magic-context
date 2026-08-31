import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createDirectTestDatabase } from "./test-database";
import { __test, TRANSFORM_DECISIONS_RETENTION } from "./transform-decision-log";

let dir: string;
let dbPath: string;
let db: Database;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mc-txn-decision-"));
    dbPath = join(dir, "context.db");
    db = createDirectTestDatabase({ path: dbPath }).db;
    __test.reset();
});

afterEach(() => {
    closeQuietly(db);
    rmSync(dir, { recursive: true, force: true });
    __test.reset();
});

function baseRow(messageId: string, tsMs: number) {
    return {
        sessionId: "ses-1",
        harness: "opencode" as const,
        messageId,
        tsMs,
        decision: "execute" as const,
        materialized: true,
        materializeReason: "model_change" as const,
        emergency: false,
        droppedTokens: 0,
        droppedCount: 0,
        inputTokens: 100,
        bustedThisPass: true,
    };
}

function rowCount(): number {
    return (
        db
            .prepare(
                "SELECT COUNT(*) AS c FROM transform_decisions WHERE session_id = 'ses-1' AND harness = 'opencode'",
            )
            .get() as { c: number }
    ).c;
}

describe("transform_decisions retention cap", () => {
    const TEST_CAP = 10;

    beforeEach(() => {
        __test.setRetentionForTests(TEST_CAP);
    });

    it("prunes to the newest cap rows per (session,harness)", () => {
        const total = TEST_CAP + 5;
        for (let i = 0; i < total; i++) {
            __test.writeRow(dbPath, baseRow(`msg-${i}`, 1000 + i));
        }
        expect(rowCount()).toBe(TEST_CAP);

        const oldest = db
            .prepare("SELECT 1 FROM transform_decisions WHERE message_id = 'msg-0'")
            .get();
        const newest = db
            .prepare(`SELECT 1 FROM transform_decisions WHERE message_id = 'msg-${total - 1}'`)
            .get();
        expect(oldest ?? null).toBeNull();
        expect(newest ?? null).not.toBeNull();
    });

    it("does not prune below the cap", () => {
        for (let i = 0; i < TEST_CAP - 1; i++) {
            __test.writeRow(dbPath, baseRow(`m-${i}`, 1000 + i));
        }
        expect(rowCount()).toBe(TEST_CAP - 1);
    });

    it("evicts only the overage when oldest timestamps tie", () => {
        // A newer write over `TEST_CAP` must evict one row from the tied oldest timestamp group.
        for (let i = 0; i < TEST_CAP; i++) {
            __test.writeRow(dbPath, baseRow(`tie-${i}`, 1000));
        }
        __test.writeRow(dbPath, baseRow("newer", 2000));
        expect(rowCount()).toBe(TEST_CAP);
        const newer = db
            .prepare("SELECT 1 FROM transform_decisions WHERE message_id = 'newer'")
            .get();
        expect(newer ?? null).not.toBeNull();
    });

    it("keeps the production retention constant sane", () => {
        expect(TRANSFORM_DECISIONS_RETENTION).toBe(2000);
    });
});

describe("findNewestPiAssistantEntryIdAfter (index-aware binding)", () => {
    const asst = (id: string) => ({
        id,
        type: "message",
        message: { role: "assistant" },
    });
    const user = (id: string) => ({
        id,
        type: "message",
        message: { role: "user" },
    });

    it("binds to the first assistant AFTER the snapshot", () => {
        const entries = [asst("a1"), user("u1"), asst("a2")];
        expect(__test.findNewestPiAssistantEntryIdAfter(entries, "a1")).toBe("a2");
    });

    it("returns null when no assistant exists after the snapshot (no older-entry fallback)", () => {
        const entries = [asst("a1"), asst("a2")];
        expect(__test.findNewestPiAssistantEntryIdAfter(entries, "a2")).toBeNull();
    });

    it("refuses to bind when the snapshot id is absent (compacted/reordered)", () => {
        const entries = [asst("a1"), asst("a2")];
        expect(__test.findNewestPiAssistantEntryIdAfter(entries, "missing-snapshot")).toBeNull();
    });

    it("with a null snapshot, binds to the FIRST assistant (recorded when none existed)", () => {
        // A `null` snapshot records that no assistant existed at decision time.
        // The decision must bind to the first later assistant, not the newest.
        const entries = [asst("a1"), user("u1"), asst("a2"), user("u2")];
        expect(__test.findNewestPiAssistantEntryIdAfter(entries, null)).toBe("a1");
    });
});
