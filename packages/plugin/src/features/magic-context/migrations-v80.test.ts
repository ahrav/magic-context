/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    getMemoriesByProject,
    getMemoryById,
    insertMemory,
    mergeMemoryStats,
    updateMemoryContent,
    updateMemoryRetrievalCount,
    updateMemorySeenCount,
} from "./memory/storage-memory";
import type { Memory } from "./memory/types";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";

const V80_OBJECT_NAMES = [
    "memory_stats",
    "memories_stats_ai",
    "memories_telemetry_freeze_guard",
    "memory_stats_authority_guard_insert",
    "memory_stats_authority_guard_update",
    "memory_stats_authority_guard_delete",
] as const;

function migratedDb(): Database {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

/** Migration state through v79 with the v80 objects and version row removed. */
function v79Database(): Database {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    initializeDatabase(db);
    runMigrations(db);
    db.exec("DELETE FROM schema_migrations WHERE version = 80");
    db.exec(`
        DROP TRIGGER IF EXISTS memories_stats_ai;
        DROP TRIGGER IF EXISTS memories_telemetry_freeze_guard;
        DROP TRIGGER IF EXISTS memory_stats_authority_guard_insert;
        DROP TRIGGER IF EXISTS memory_stats_authority_guard_update;
        DROP TRIGGER IF EXISTS memory_stats_authority_guard_delete;
        DROP TABLE IF EXISTS memory_stats;
    `);
    return db;
}

function insertLegacyMemory(
    db: Database,
    args: {
        projectPath: string;
        content: string;
        seenCount?: number;
        retrievalCount?: number;
        firstSeenAt?: number;
        createdAt?: number;
        updatedAt?: number;
        lastSeenAt?: number;
        lastRetrievedAt?: number | null;
    },
): number {
    const hash = `hash:${args.content}`;
    const result = db
        .prepare(
            `INSERT INTO memories (project_path, category, content, normalized_hash,
                seen_count, retrieval_count, first_seen_at, created_at, updated_at,
                last_seen_at, last_retrieved_at)
             VALUES (?, 'CONSTRAINTS', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
            args.projectPath,
            args.content,
            hash,
            args.seenCount ?? 1,
            args.retrievalCount ?? 0,
            args.firstSeenAt ?? 1000,
            args.createdAt ?? 1000,
            args.updatedAt ?? 1000,
            args.lastSeenAt ?? 1000,
            args.lastRetrievedAt ?? null,
        ) as { lastInsertRowid: number | bigint };
    return Number(result.lastInsertRowid);
}

function objectSql(db: Database, name: string): string | null {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(name) as
        | { sql: string | null }
        | undefined;
    return row?.sql ?? null;
}

function statsRow(db: Database, memoryId: number): Record<string, unknown> | undefined {
    return db.prepare("SELECT * FROM memory_stats WHERE memory_id = ?").get(memoryId) as
        | Record<string, unknown>
        | undefined;
}

function baseTelemetry(db: Database, memoryId: number): Record<string, unknown> | undefined {
    return db
        .prepare(
            "SELECT seen_count, retrieval_count, last_seen_at, last_retrieved_at, updated_at FROM memories WHERE id = ?",
        )
        .get(memoryId) as Record<string, unknown> | undefined;
}

/** Test-only audit trail proving telemetry paths never UPDATE memories. */
function installBaseUpdateAudit(db: Database): () => number {
    db.exec(`
        CREATE TABLE test_base_update_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, memory_id INTEGER);
        CREATE TRIGGER test_memories_update_audit AFTER UPDATE ON memories BEGIN
            INSERT INTO test_base_update_audit (memory_id) VALUES (NEW.id);
        END;
    `);
    return () =>
        (db.prepare("SELECT COUNT(*) AS n FROM test_base_update_audit").get() as { n: number }).n;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
});

describe("migration v80: memory_stats telemetry side table", () => {
    test("initializer-only setup contains no v80 stats objects", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            for (const name of V80_OBJECT_NAMES) {
                expect(objectSql(db, name)).toBeNull();
            }
            // The initializer's memories_au fallback already carries the
            // value-sensitive definition.
            const au = objectSql(db, "memories_au");
            expect(au).toContain("UPDATE OF content, category");
            expect(au).toContain("WHEN OLD.content IS NOT NEW.content OR");
        } finally {
            closeQuietly(db);
        }
    });

    test("fresh and v79-upgraded databases converge on the same v80 schema objects", () => {
        const fresh = migratedDb();
        const upgraded = v79Database();
        try {
            insertLegacyMemory(upgraded, { projectPath: "git:up", content: "legacy row" });
            runMigrations(upgraded);
            for (const name of [...V80_OBJECT_NAMES, "memories_au"]) {
                const sql = objectSql(fresh, name);
                expect(sql).not.toBeNull();
                expect(objectSql(upgraded, name)).toBe(sql);
            }
        } finally {
            closeQuietly(fresh);
            closeQuietly(upgraded);
        }
    });

    test("v79 telemetry backfills one stats row per memory and public values survive (AE3)", () => {
        const db = v79Database();
        try {
            const id = insertLegacyMemory(db, {
                projectPath: "git:ae3",
                content: "constraint with history",
                seenCount: 7,
                retrievalCount: 3,
                firstSeenAt: 1111,
                createdAt: 1111,
                updatedAt: 5555,
                lastSeenAt: 4444,
                lastRetrievedAt: 3333,
            });
            const nullRetrieval = insertLegacyMemory(db, {
                projectPath: "git:ae3",
                content: "never retrieved",
                updatedAt: 2000,
                lastRetrievedAt: null,
            });
            const before = getMemoriesByProject(db, "git:ae3");

            runMigrations(db);

            expect(statsRow(db, id)).toEqual({
                memory_id: id,
                seen_count: 7,
                retrieval_count: 3,
                last_seen_at: 4444,
                last_retrieved_at: 3333,
                updated_at: 5555,
            });
            const after = getMemoriesByProject(db, "git:ae3");
            expect(after).toEqual(before);
            const nullAfter = getMemoryById(db, nullRetrieval);
            expect(nullAfter?.lastRetrievedAt).toBeNull();
            expect(nullAfter?.retrievalCount).toBe(0);

            // Idempotent reopen: one version row, one stats row per memory.
            runMigrations(db);
            const versionCount = (
                db
                    .prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 80")
                    .get() as { n: number }
            ).n;
            expect(versionCount).toBe(1);
            const counts = db
                .prepare(
                    "SELECT (SELECT COUNT(*) FROM memories) AS m, (SELECT COUNT(*) FROM memory_stats) AS s",
                )
                .get() as { m: number; s: number };
            expect(counts.s).toBe(counts.m);
        } finally {
            closeQuietly(db);
        }
    });

    test("invalid v79 telemetry aborts with a bounded diagnostic and publishes nothing", () => {
        const db = v79Database();
        try {
            for (let i = 0; i < 25; i += 1) {
                const id = insertLegacyMemory(db, {
                    projectPath: "git:bad",
                    content: `invalid ${i}`,
                });
                db.prepare("UPDATE memories SET seen_count = -1 WHERE id = ?").run(id);
            }
            // A legitimately-null nullable timestamp is NOT invalid.
            insertLegacyMemory(db, {
                projectPath: "git:bad",
                content: "valid nullable",
                lastRetrievedAt: null,
            });

            let message = "";
            try {
                runMigrations(db);
            } catch (error) {
                message = error instanceof Error ? error.message : String(error);
            }
            expect(message).toContain("25 memories row(s) carry invalid legacy telemetry");
            expect(message).toContain("first 20 as (memory_id, reason)");
            expect(message).toContain("seen_count-not-nonnegative-integer");
            // Bounded: exactly 20 sampled ids, no content, no partial schema.
            expect(message.match(/seen_count-not-nonnegative-integer/g)?.length).toBe(20);
            expect(message).not.toContain("invalid 0");
            expect(objectSql(db, "memory_stats")).toBeNull();
            const versionCount = (
                db
                    .prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 80")
                    .get() as { n: number }
            ).n;
            expect(versionCount).toBe(0);

            // Stopped-writer correction, then the rerun publishes v80.
            db.exec("UPDATE memories SET seen_count = 1 WHERE seen_count < 0");
            runMigrations(db);
            expect(objectSql(db, "memory_stats")).not.toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    test("base inserts create exactly one stats row through the insert trigger", () => {
        const db = migratedDb();
        try {
            const viaHelper = insertMemory(db, {
                projectPath: "git:ins",
                category: "CONSTRAINTS",
                content: "helper insert",
            });
            expect(statsRow(db, viaHelper.id)).toBeDefined();
            expect(statsRow(db, viaHelper.id)?.seen_count).toBe(1);

            // A held-open v79-shaped statement (legacy SQL) gets the same trigger.
            const legacyId = insertLegacyMemory(db, {
                projectPath: "git:ins",
                content: "legacy-shaped insert",
                seenCount: 4,
                retrievalCount: 2,
                lastSeenAt: 7777,
                lastRetrievedAt: 6666,
                updatedAt: 8888,
            });
            expect(statsRow(db, legacyId)).toEqual({
                memory_id: legacyId,
                seen_count: 4,
                retrieval_count: 2,
                last_seen_at: 7777,
                last_retrieved_at: 6666,
                updated_at: 8888,
            });
        } finally {
            closeQuietly(db);
        }
    });

    test("telemetry bumps write memory_stats only, never the base row (AE4)", () => {
        const db = migratedDb();
        try {
            const memory = insertMemory(db, {
                projectPath: "git:bump",
                category: "CONSTRAINTS",
                content: "bump target",
            });
            const baseBefore = baseTelemetry(db, memory.id);
            const auditCount = installBaseUpdateAudit(db);

            updateMemorySeenCount(db, memory.id);
            updateMemoryRetrievalCount(db, memory.id);

            expect(auditCount()).toBe(0);
            expect(baseTelemetry(db, memory.id)).toEqual(baseBefore);
            const stats = statsRow(db, memory.id);
            expect(stats?.seen_count).toBe(2);
            expect(stats?.retrieval_count).toBe(1);
            expect(stats?.last_retrieved_at).not.toBeNull();

            // Each bump advances only its own event timestamp.
            const seenAfterBumps = stats?.last_seen_at;
            updateMemoryRetrievalCount(db, memory.id);
            expect(statsRow(db, memory.id)?.last_seen_at).toBe(seenAfterBumps);

            // The effective projection surfaces the stats tuple and the
            // telemetry-advanced update time.
            const effective = getMemoryById(db, memory.id);
            expect(effective?.seenCount).toBe(2);
            expect(effective?.retrievalCount).toBe(2);
            expect(effective?.updatedAt).toBe(statsRow(db, memory.id)?.updated_at as number);
        } finally {
            closeQuietly(db);
        }
    });

    test("telemetry activity keeps pre-v80 list ordering (effective update time)", () => {
        const db = migratedDb();
        try {
            const older = insertMemory(db, {
                projectPath: "git:order",
                category: "CONSTRAINTS",
                content: "older memory",
            });
            db.prepare("UPDATE memory_stats SET updated_at = 1000 WHERE memory_id = ?").run(
                older.id,
            );
            db.prepare("UPDATE memories SET updated_at = 1000, created_at = 1000 WHERE id = ?").run(
                older.id,
            );
            const newer = insertMemory(db, {
                projectPath: "git:order",
                category: "CONSTRAINTS",
                content: "newer memory",
            });
            expect(getMemoriesByProject(db, "git:order").map((m) => m.id)).toEqual([
                newer.id,
                older.id,
            ]);

            // A seen bump moves the older memory to the front, exactly as the
            // legacy base-row updated_at bump did.
            updateMemorySeenCount(db, older.id);
            expect(getMemoriesByProject(db, "git:order").map((m) => m.id)).toEqual([
                older.id,
                newer.id,
            ]);
        } finally {
            closeQuietly(db);
        }
    });

    test("explicit merge sums counters under one clock and preserves event timestamps (AE5)", () => {
        const db = migratedDb();
        try {
            const canonical = insertMemory(db, {
                projectPath: "git:merge",
                category: "CONSTRAINTS",
                content: "canonical",
            });
            db.prepare(
                "UPDATE memory_stats SET seen_count = 3, retrieval_count = 2, last_seen_at = 4242, last_retrieved_at = NULL WHERE memory_id = ?",
            ).run(canonical.id);

            mergeMemoryStats(db, canonical.id, 9, 5, "2,3", "active");

            const stats = statsRow(db, canonical.id);
            const base = db
                .prepare("SELECT merged_from, status, updated_at FROM memories WHERE id = ?")
                .get(canonical.id) as Record<string, unknown>;
            expect(stats?.seen_count).toBe(9);
            expect(stats?.retrieval_count).toBe(5);
            expect(stats?.last_seen_at).toBe(4242);
            expect(stats?.last_retrieved_at).toBeNull();
            expect(base.merged_from).toBe("2,3");
            // One clock value stamps both update times.
            expect(stats?.updated_at).toBe(base.updated_at);
        } finally {
            closeQuietly(db);
        }
    });

    test("retained telemetry columns are frozen after v80 (AE7 guard)", () => {
        const db = migratedDb();
        try {
            const memory = insertMemory(db, {
                projectPath: "git:frozen",
                category: "CONSTRAINTS",
                content: "frozen baseline",
            });
            const baseBefore = baseTelemetry(db, memory.id);
            const statsBefore = statsRow(db, memory.id);

            expect(() =>
                db.prepare("UPDATE memories SET seen_count = 99 WHERE id = ?").run(memory.id),
            ).toThrow(/memories telemetry columns are frozen at v80/);
            expect(() =>
                db
                    .prepare("UPDATE memories SET last_retrieved_at = 123 WHERE id = ?")
                    .run(memory.id),
            ).toThrow(/frozen at v80/);

            // A SET list naming a retained column with an UNCHANGED value passes
            // (the guard compares values), so full-row mirror statements that
            // bind existing telemetry keep working.
            db.prepare("UPDATE memories SET seen_count = seen_count WHERE id = ?").run(memory.id);

            expect(baseTelemetry(db, memory.id)).toEqual(baseBefore);
            expect(statsRow(db, memory.id)).toEqual(statsBefore);
        } finally {
            closeQuietly(db);
        }
    });

    test("memories_au is value-sensitive, column-scoped, and never on the telemetry path", () => {
        const db = migratedDb();
        try {
            const memory = insertMemory(db, {
                projectPath: "git:fts",
                category: "CONSTRAINTS",
                content: "searchable alpha content",
            });
            const au = objectSql(db, "memories_au");
            expect(au).toContain("AFTER UPDATE OF content, category ON memories");
            expect(au).toContain(
                "WHEN OLD.content IS NOT NEW.content OR OLD.category IS NOT NEW.category",
            );

            // With `memories_fts` removed, updating `content` fails because
            // `memories_au` references the missing table; telemetry bumps still
            // succeed because they update only `memory_stats`.
            db.exec("DROP TABLE memories_fts");
            updateMemorySeenCount(db, memory.id);
            updateMemoryRetrievalCount(db, memory.id);
            expect(statsRow(db, memory.id)?.seen_count).toBe(2);
            expect(() =>
                db
                    .prepare("UPDATE memories SET content = 'changed beta content' WHERE id = ?")
                    .run(memory.id),
            ).toThrow(/no such table/);
        } finally {
            closeQuietly(db);
        }
    });

    test("content updates still reindex FTS while telemetry stays isolated", () => {
        const db = migratedDb();
        try {
            const memory = insertMemory(db, {
                projectPath: "git:fts2",
                category: "CONSTRAINTS",
                content: "original searchable phrase",
            });
            updateMemorySeenCount(db, memory.id);
            updateMemoryContent(db, memory.id, "replacement indexed phrase", "hash:replacement");
            const matches = db
                .prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?")
                .all('"replacement"') as Array<{ rowid: number }>;
            expect(matches.map((m) => m.rowid)).toEqual([memory.id]);
            const stale = db
                .prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?")
                .all('"original"') as Array<{ rowid: number }>;
            expect(stale).toEqual([]);
        } finally {
            closeQuietly(db);
        }
    });

    test("deleting a memory cascades its stats row and passes foreign_key_check (AE6)", () => {
        const db = migratedDb();
        try {
            const doomed = insertMemory(db, {
                projectPath: "git:del",
                category: "CONSTRAINTS",
                content: "doomed",
            });
            const survivor = insertMemory(db, {
                projectPath: "git:del",
                category: "CONSTRAINTS",
                content: "survivor",
            });
            db.prepare("DELETE FROM memories WHERE id = ?").run(doomed.id);
            expect(statsRow(db, doomed.id) ?? null).toBeNull();
            expect(statsRow(db, survivor.id)).toBeDefined();
            expect(db.prepare("PRAGMA foreign_key_check(memory_stats)").all()).toEqual([]);
        } finally {
            closeQuietly(db);
        }
    });

    test("a missing stats row surfaces as corruption instead of healing from legacy columns", () => {
        const db = migratedDb();
        try {
            const memory = insertMemory(db, {
                projectPath: "git:corrupt",
                category: "CONSTRAINTS",
                content: "loses stats",
            });
            db.exec("PRAGMA foreign_keys=OFF");
            db.prepare("DELETE FROM memory_stats WHERE memory_id = ?").run(memory.id);
            expect(() => getMemoryById(db, memory.id)).toThrow(/memory_stats row missing/);
            expect(() => getMemoriesByProject(db, "git:corrupt")).toThrow(
                /memory_stats row missing/,
            );
        } finally {
            closeQuietly(db);
        }
    });

    test("a connection opened before v80 keeps inserting and is fenced from telemetry updates (AE7)", () => {
        const dir = mkdtempSync(path.join(tmpdir(), "mc-v80-"));
        cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
        const dbPath = path.join(dir, "context.db");

        const legacy = new Database(dbPath);
        legacy.exec("PRAGMA foreign_keys=ON");
        initializeDatabase(legacy);
        runMigrations(legacy);
        legacy.exec(`
            DELETE FROM schema_migrations WHERE version = 80;
            DROP TRIGGER IF EXISTS memories_stats_ai;
            DROP TRIGGER IF EXISTS memories_telemetry_freeze_guard;
            DROP TRIGGER IF EXISTS memory_stats_authority_guard_insert;
            DROP TRIGGER IF EXISTS memory_stats_authority_guard_update;
            DROP TRIGGER IF EXISTS memory_stats_authority_guard_delete;
            DROP TABLE IF EXISTS memory_stats;
        `);
        cleanups.push(() => closeQuietly(legacy));

        // Second process migrates while the legacy connection stays open.
        const migrator = new Database(dbPath);
        migrator.exec("PRAGMA foreign_keys=ON");
        runMigrations(migrator);
        cleanups.push(() => closeQuietly(migrator));

        // The held-open v79 statement inserts and receives stats atomically.
        const result = legacy
            .prepare(
                `INSERT INTO memories (project_path, category, content, normalized_hash,
                    seen_count, retrieval_count, first_seen_at, created_at, updated_at,
                    last_seen_at, last_retrieved_at)
                 VALUES ('git:legacy', 'CONSTRAINTS', 'held-open insert', 'hash:held', 2, 1, 1, 1, 9, 8, 7)`,
            )
            .run() as { lastInsertRowid: number | bigint };
        const id = Number(result.lastInsertRowid);
        expect(statsRow(migrator, id)).toEqual({
            memory_id: id,
            seen_count: 2,
            retrieval_count: 1,
            last_seen_at: 8,
            last_retrieved_at: 7,
            updated_at: 9,
        });

        // A later legacy attempt to mutate retained telemetry is rejected.
        expect(() =>
            legacy.prepare("UPDATE memories SET seen_count = seen_count + 1 WHERE id = ?").run(id),
        ).toThrow(/frozen at v80/);
        expect(statsRow(migrator, id)?.seen_count).toBe(2);

        // Two connections bumping the same memory keep both increments.
        updateMemorySeenCount(migrator, id);
        const third = new Database(dbPath);
        cleanups.push(() => closeQuietly(third));
        updateMemorySeenCount(third, id);
        expect(statsRow(migrator, id)?.seen_count).toBe(4);
    });

    test("a negative stats-table probe does not survive v80 on the same handle", () => {
        const db = v79Database();
        try {
            const id = insertLegacyMemory(db, {
                projectPath: "git:probe",
                content: "probe memory",
                seenCount: 2,
            });
            // Probe and prepare telemetry statements while the handle is v79:
            // the probe must not freeze `false`, and the cached legacy UPDATE
            // must not outlive the migration.
            updateMemorySeenCount(db, id);
            expect(
                (
                    db.prepare("SELECT seen_count FROM memories WHERE id = ?").get(id) as {
                        seen_count: number;
                    }
                ).seen_count,
            ).toBe(3);

            runMigrations(db);

            // Post-migration the same handle must route the bump into
            // memory_stats; a stale cached branch would hit the freeze guard.
            updateMemorySeenCount(db, id);
            expect(statsRow(db, id)?.seen_count).toBe(4);
            expect(
                (
                    db.prepare("SELECT seen_count FROM memories WHERE id = ?").get(id) as {
                        seen_count: number;
                    }
                ).seen_count,
            ).toBe(3);
        } finally {
            closeQuietly(db);
        }
    });

    test("memory_stats has no session ownership and survives durable-memory expectations", () => {
        const db = migratedDb();
        try {
            const columns = db.prepare("PRAGMA table_info(memory_stats)").all() as Array<{
                name: string;
            }>;
            expect(columns.map((column) => column.name)).toEqual([
                "memory_id",
                "seen_count",
                "retrieval_count",
                "last_seen_at",
                "last_retrieved_at",
                "updated_at",
            ]);
        } finally {
            closeQuietly(db);
        }
    });
});
