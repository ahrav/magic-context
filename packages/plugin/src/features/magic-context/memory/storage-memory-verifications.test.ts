/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import {
    getUnclassifiedMemoryIds,
    insertMemory,
    setMemoryClassification,
    updateMemoryContent,
    updateMemoryVerification,
} from "./storage-memory";
import { getCurrentMemoryClaimByLegacyMemoryId } from "./storage-memory-claims";
import {
    clearMemoryVerifications,
    getMemoryVerifications,
    getUnmappedMemoryIds,
    recordMemoryMapping,
    recordMemoryVerifications,
} from "./storage-memory-verifications";

function freshDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

describe("memory verification side-table helpers", () => {
    test("record/get/clear side-table rows without mutating memories", () => {
        const db = freshDb();
        try {
            const memory = insertMemory(db, {
                projectPath: "git:test",
                category: "CONFIG_VALUES",
                content: "Config lives in src/config.ts.",
                sourceSessionId: "ses",
            });
            const before = db
                .prepare(
                    "SELECT verification_status, verified_at, updated_at FROM memories WHERE id=?",
                )
                .get(memory.id);

            expect(recordMemoryVerifications(db, memory.id, ["src/config.ts"], 1234)).toBe(1);
            const state = getMemoryVerifications(db, [memory.id]).get(memory.id);
            expect(state?.files).toEqual(["src/config.ts"]);
            expect(state?.hasSentinel).toBe(false);
            expect(state?.verifiedAt).toBe(1234);

            const after = db
                .prepare(
                    "SELECT verification_status, verified_at, updated_at FROM memories WHERE id=?",
                )
                .get(memory.id);
            expect(after).toEqual(before);

            clearMemoryVerifications(db, memory.id);
            expect(getMemoryVerifications(db, [memory.id]).has(memory.id)).toBe(false);
        } finally {
            closeQuietly(db);
        }
    });

    test("recordMemoryMapping marks mapped (mapped_at) but NOT content-verified (verified_at=0)", () => {
        const db = freshDb();
        try {
            const memory = insertMemory(db, {
                projectPath: "git:test",
                category: "ARCHITECTURE",
                content: "X lives in src/x.ts.",
                sourceSessionId: "ses",
            });
            recordMemoryMapping(db, memory.id, ["src/x.ts"], 5000);
            const state = getMemoryVerifications(db, [memory.id]).get(memory.id);
            expect(state?.files).toEqual(["src/x.ts"]);
            expect(state?.mappedAt).toBe(5000);
            // Mapped, not verified — verify still sees it as needing a content check.
            expect(state?.verifiedAt).toBe(0);

            // A later verify run sets verified_at on the same memory.
            recordMemoryVerifications(db, memory.id, ["src/x.ts"], 9000);
            const verified = getMemoryVerifications(db, [memory.id]).get(memory.id);
            expect(verified?.verifiedAt).toBe(9000);
        } finally {
            closeQuietly(db);
        }
    });

    test("getUnmappedMemoryIds returns only memories with no mapping rows", () => {
        const db = freshDb();
        try {
            const a = insertMemory(db, {
                projectPath: "git:test",
                category: "ARCHITECTURE",
                content: "A in src/a.ts.",
                sourceSessionId: "ses",
            });
            const b = insertMemory(db, {
                projectPath: "git:test",
                category: "CONSTRAINTS",
                content: "External provider behavior.",
                sourceSessionId: "ses",
            });
            expect(getUnmappedMemoryIds(db, [a.id, b.id]).sort()).toEqual([a.id, b.id].sort());
            // Mapping a (real file) and b (sentinel) both count as mapped.
            recordMemoryMapping(db, a.id, ["src/a.ts"], 1);
            recordMemoryMapping(db, b.id, [], 1);
            expect(getUnmappedMemoryIds(db, [a.id, b.id])).toEqual([]);
        } finally {
            closeQuietly(db);
        }
    });

    test("classified_at: setMemoryClassification stamps it; content update clears it", () => {
        const db = freshDb();
        try {
            const m = insertMemory(db, {
                projectPath: "git:test",
                category: "ARCHITECTURE",
                content: "X in src/x.ts.",
                sourceSessionId: "ses",
            });
            // Unclassified initially.
            expect(getUnclassifiedMemoryIds(db, [m.id])).toEqual([m.id]);
            setMemoryClassification(db, m.id, { importance: 70 });
            expect(getUnclassifiedMemoryIds(db, [m.id])).toEqual([]);
            // Content update re-opens it for classification.
            updateMemoryContent(db, m.id, "X moved to src/y.ts.", "newhash");
            expect(getUnclassifiedMemoryIds(db, [m.id])).toEqual([m.id]);
        } finally {
            closeQuietly(db);
        }
    });

    test("empty files write the no-file sentinel and do not call row verification mutation", () => {
        const db = freshDb();
        try {
            const memory = insertMemory(db, {
                projectPath: "git:test",
                category: "PROJECT_RULES",
                content: "Prefer narrow tests.",
                sourceSessionId: "ses",
            });
            recordMemoryVerifications(db, memory.id, [], 2000);

            const state = getMemoryVerifications(db, [memory.id]).get(memory.id);
            expect(state?.files).toEqual([]);
            expect(state?.hasSentinel).toBe(true);
            expect(state?.verifiedAt).toBe(2000);

            updateMemoryVerification(db, memory.id, "verified");
            const stillSideTable = getMemoryVerifications(db, [memory.id]).get(memory.id);
            expect(stillSideTable?.verifiedAt).toBe(2000);
        } finally {
            closeQuietly(db);
        }
    });
});

function countRows(db: Database, table: string, where = "1=1"): number {
    return (
        db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get() as {
            count: number;
        }
    ).count;
}

function claimEventOutcomes(db: Database, memoryId: number): string[] {
    const claim = getCurrentMemoryClaimByLegacyMemoryId(db, memoryId);
    if (!claim) return [];
    return (
        db
            .prepare(
                `SELECT ve.outcome AS outcome FROM verification_events ve
                   JOIN claim_revisions rev ON rev.id = ve.revision_id
                  WHERE rev.claim_id = ? ORDER BY ve.id`,
            )
            .all(claim.claimId) as Array<{ outcome: string }>
    ).map((row) => row.outcome);
}

describe("verification claim effects on a migrated v84 database (KTD5)", () => {
    test("a mapped-only file snapshot adds NO verification event and no outbox effect", () => {
        const db = freshDb();
        try {
            const memory = insertMemory(db, {
                projectPath: "git:test",
                category: "ARCHITECTURE",
                content: "X lives in src/x.ts.",
                sourceSessionId: "ses",
            });
            const eventsBefore = countRows(db, "verification_events");
            const outboxBefore = countRows(db, "claim_change_outbox");

            recordMemoryMapping(db, memory.id, ["src/x.ts"], 5000);

            expect(countRows(db, "verification_events")).toBe(eventsBefore);
            expect(countRows(db, "claim_change_outbox")).toBe(outboxBefore);
            // The mapping itself is durable in the side table.
            expect(getMemoryVerifications(db, [memory.id]).get(memory.id)?.mappedAt).toBe(5000);
        } finally {
            closeQuietly(db);
        }
    });

    test("a positive verification adds exactly one current-snapshot verified event and one evidence effect", () => {
        const db = freshDb();
        try {
            const memory = insertMemory(db, {
                projectPath: "git:test",
                category: "ARCHITECTURE",
                content: "X lives in src/x.ts.",
                sourceSessionId: "ses",
            });
            const outboxBefore = countRows(db, "claim_change_outbox");

            recordMemoryVerifications(db, memory.id, ["src/x.ts"], 9000);

            expect(claimEventOutcomes(db, memory.id)).toEqual(["verified"]);
            expect(countRows(db, "claim_change_outbox")).toBe(outboxBefore + 1);
            expect(
                countRows(db, "claim_change_outbox", "effect_type = 'evidence'"),
            ).toBeGreaterThanOrEqual(1);
        } finally {
            closeQuietly(db);
        }
    });

    test("verified, stale, and flagged status changes append one event each; unverified appends none", () => {
        const db = freshDb();
        try {
            const memory = insertMemory(db, {
                projectPath: "git:test",
                category: "CONSTRAINTS",
                content: "Provider rate limit is 10 rps.",
                sourceSessionId: "ses",
            });
            updateMemoryVerification(db, memory.id, "verified");
            updateMemoryVerification(db, memory.id, "stale");
            updateMemoryVerification(db, memory.id, "flagged");
            updateMemoryVerification(db, memory.id, "unverified");

            expect(claimEventOutcomes(db, memory.id)).toEqual(["verified", "stale", "flagged"]);
            const projection = db
                .prepare("SELECT verification_status FROM memories WHERE id = ?")
                .get(memory.id) as { verification_status: string };
            expect(projection.verification_status).toBe("unverified");
        } finally {
            closeQuietly(db);
        }
    });
});
