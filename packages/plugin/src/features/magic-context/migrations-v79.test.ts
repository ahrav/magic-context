/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    installNotesSearchProjection,
    LATEST_MIGRATION_VERSION,
    runMigrations,
    validateNotesSearchProjection,
} from "./migrations";
import { initializeDatabase, LATEST_SUPPORTED_VERSION } from "./storage-db";
import { addNote, deleteNote, updateNote } from "./storage-notes";

function seedAppliedVersion(db: Database, version: number): void {
    db.exec(`
        CREATE TABLE schema_migrations (
            version INTEGER PRIMARY KEY,
            description TEXT NOT NULL,
            applied_at INTEGER NOT NULL
        );
    `);
    const insert = db.prepare(
        "INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)",
    );
    for (let current = 1; current <= version; current += 1) {
        insert.run(current, "seeded migration", Date.now());
    }
}

function migratedDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

/** Retains migration state through v78 after removing the v79/v80 objects. */
function v78DatabaseWithNotes(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    db.exec("DELETE FROM schema_migrations WHERE version >= 79");
    db.exec(`
        DROP TRIGGER IF EXISTS notes_fts_ai;
        DROP TRIGGER IF EXISTS notes_fts_ad;
        DROP TRIGGER IF EXISTS notes_fts_au;
        DROP VIEW IF EXISTS notes_search_view;
        DROP TABLE IF EXISTS notes_fts;
        DROP TRIGGER IF EXISTS memories_stats_ai;
        DROP TRIGGER IF EXISTS memories_telemetry_freeze_guard;
        DROP TRIGGER IF EXISTS memory_stats_authority_guard_insert;
        DROP TRIGGER IF EXISTS memory_stats_authority_guard_update;
        DROP TRIGGER IF EXISTS memory_stats_authority_guard_delete;
        DROP TABLE IF EXISTS memory_stats;
        ALTER TABLE notes DROP COLUMN source_revision;
        ALTER TABLE notes DROP COLUMN state_version;
    `);
    return db;
}

function projectedIds(db: Database, ftsQuery: string): number[] {
    return (
        db
            .prepare("SELECT rowid AS id FROM notes_fts WHERE notes_fts MATCH ?")
            .all(ftsQuery) as Array<{ id: number }>
    ).map((row) => row.id);
}

function projectionRowCount(db: Database): number {
    return (db.prepare("SELECT COUNT(*) AS count FROM notes_fts").get() as { count: number }).count;
}

function noteRowCount(db: Database): number {
    return (db.prepare("SELECT COUNT(*) AS count FROM notes").get() as { count: number }).count;
}

function appliedVersionCount(db: Database, version: number): number {
    return (
        db
            .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = ?")
            .get(version) as { count: number }
    ).count;
}

function objectExists(db: Database, name: string): boolean {
    return (
        db.prepare("SELECT 1 AS present FROM sqlite_master WHERE name = ? LIMIT 1").get(name) !=
        null
    );
}

function triggerNames(db: Database): string[] {
    return (
        db
            .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'notes_fts_%' ORDER BY name",
            )
            .all() as Array<{ name: string }>
    ).map((row) => row.name);
}

/** Throws from `exec` for the first statement matching `marker`. */
function failingOnExec(db: Database, marker: string, message: string): Database {
    return new Proxy(db, {
        get(target, prop) {
            if (prop === "exec") {
                return (sql: string) => {
                    if (sql.includes(marker)) throw new Error(message);
                    return target.exec(sql);
                };
            }
            const value = (target as unknown as Record<string | symbol, unknown>)[prop];
            return typeof value === "function" ? value.bind(target) : value;
        },
    }) as Database;
}

describe("migration v79: notes_fts candidate projection", () => {
    test("fresh databases publish the projection and align the schema fence", () => {
        const db = migratedDb();
        try {
            expect(objectExists(db, "notes_fts")).toBe(true);
            expect(objectExists(db, "notes_search_view")).toBe(true);
            expect(triggerNames(db)).toEqual(["notes_fts_ad", "notes_fts_ai", "notes_fts_au"]);
            expect(appliedVersionCount(db, 79)).toBe(1);
            expect(LATEST_SUPPORTED_VERSION).toBe(LATEST_MIGRATION_VERSION);
        } finally {
            closeQuietly(db);
        }
    });

    test("upgrading a v78 database backfills existing notes and stays idempotent (AE4)", () => {
        const db = v78DatabaseWithNotes();
        try {
            const session = addNote(db, "session", {
                sessionId: "ses-v79",
                content: "Queue drain backpressure needs a regression test.",
            });
            const smart = addNote(db, "smart", {
                content: "Retry the benchmark after release.",
                projectPath: "git:v79",
                sessionId: "ses-v79",
                surfaceCondition: "When the release ships",
            });
            updateNote(
                db,
                smart.id,
                { status: "ready", readyReason: "Release shipped with the drain fix." },
                { sessionId: "ses-v79", projectPath: "git:v79" },
            );

            runMigrations(db);

            expect(appliedVersionCount(db, 79)).toBe(1);
            expect(projectionRowCount(db)).toBe(2);
            expect(projectedIds(db, '"backpressure"')).toEqual([session.id]);
            expect(projectedIds(db, '"reason: release shipped"')).toEqual([smart.id]);

            runMigrations(db);
            expect(appliedVersionCount(db, 79)).toBe(1);
            expect(projectionRowCount(db)).toBe(2);
            expect(triggerNames(db)).toEqual(["notes_fts_ad", "notes_fts_ai", "notes_fts_au"]);
        } finally {
            closeQuietly(db);
        }
    });

    test("a failure during the migration leaves no version row and no projection", () => {
        const db = v78DatabaseWithNotes();
        try {
            addNote(db, "session", { sessionId: "ses-fail", content: "Note that must survive." });

            const failing = failingOnExec(
                db,
                "CREATE VIRTUAL TABLE notes_fts",
                "injected projection failure",
            );
            expect(() => runMigrations(failing)).toThrow(/injected projection failure/);
            expect(appliedVersionCount(db, 79)).toBe(0);
            expect(objectExists(db, "notes_fts")).toBe(false);
            expect(noteRowCount(db)).toBe(1);

            runMigrations(db);
            expect(appliedVersionCount(db, 79)).toBe(1);
            expect(projectionRowCount(db)).toBe(1);
        } finally {
            closeQuietly(db);
        }
    });

    test("validation failure aborts the migration instead of publishing a partial projection", () => {
        const db = v78DatabaseWithNotes();
        try {
            addNote(db, "session", { sessionId: "ses-validate", content: "Validated note." });

            const failing = failingOnExec(db, "integrity-check", "injected validation failure");
            expect(() => runMigrations(failing)).toThrow(/injected validation failure/);
            expect(appliedVersionCount(db, 79)).toBe(0);
            expect(objectExists(db, "notes_fts")).toBe(false);
        } finally {
            closeQuietly(db);
        }
    });

    test("every note lifecycle transition keeps the projection synchronized", () => {
        const db = migratedDb();
        try {
            const note = addNote(db, "session", {
                sessionId: "ses-life",
                content: "Original lifecycle content about caching.",
            });
            expect(projectedIds(db, '"caching"')).toEqual([note.id]);

            updateNote(
                db,
                note.id,
                { content: "Replaced lifecycle content about sharding." },
                { sessionId: "ses-life", projectPath: "git:life" },
            );
            expect(projectedIds(db, '"caching"')).toEqual([]);
            expect(projectedIds(db, '"sharding"')).toEqual([note.id]);

            const smart = addNote(db, "smart", {
                content: "Smart note about throttling.",
                projectPath: "git:life",
                sessionId: "ses-life",
                surfaceCondition: "When throttled",
            });
            updateNote(
                db,
                smart.id,
                { status: "ready", readyReason: "Throttle window observed." },
                { sessionId: "ses-life", projectPath: "git:life" },
            );
            expect(projectedIds(db, '"throttle window"')).toEqual([smart.id]);

            expect(deleteNote(db, note.id)).toBe(true);
            expect(projectedIds(db, '"sharding"')).toEqual([]);
            validateNotesSearchProjection(db);
        } finally {
            closeQuietly(db);
        }
    });

    test("a rolled-back note write leaves neither surface mutated", () => {
        const db = migratedDb();
        try {
            const before = projectionRowCount(db);
            expect(() =>
                db.transaction(() => {
                    addNote(db, "session", {
                        sessionId: "ses-rollback",
                        content: "Rolled back note about eviction.",
                    });
                    throw new Error("forced rollback");
                })(),
            ).toThrow(/forced rollback/);

            expect(projectionRowCount(db)).toBe(before);
            expect(projectedIds(db, '"eviction"')).toEqual([]);
            expect(noteRowCount(db)).toBe(0);
            validateNotesSearchProjection(db);
        } finally {
            closeQuietly(db);
        }
    });

    test("the projection has no session_id column and every status is projected", () => {
        const db = migratedDb();
        try {
            const columns = (
                db.prepare("PRAGMA table_info(notes_fts)").all() as Array<{ name: string }>
            ).map((column) => column.name);
            expect(columns).not.toContain("session_id");
            expect(columns).toContain("searchable_text");

            const active = addNote(db, "session", {
                sessionId: "ses-status",
                content: "Active status note about pagination.",
            });
            const dismissed = addNote(db, "session", {
                sessionId: "ses-status",
                content: "Dismissed status note about pagination.",
            });
            db.prepare("UPDATE notes SET status = 'dismissed' WHERE id = ?").run(dismissed.id);

            expect(projectedIds(db, '"pagination"').sort((a, b) => a - b)).toEqual(
                [active.id, dismissed.id].sort((a, b) => a - b),
            );
        } finally {
            closeQuietly(db);
        }
    });

    test("clearing one session removes only its session-note projection rows", () => {
        const db = migratedDb();
        try {
            const mine = addNote(db, "session", {
                sessionId: "ses-clear-a",
                content: "Session A note about quorum.",
            });
            const other = addNote(db, "session", {
                sessionId: "ses-clear-b",
                content: "Session B note about quorum.",
            });

            db.prepare("DELETE FROM notes WHERE session_id = ? AND type = 'session'").run(
                "ses-clear-a",
            );

            expect(projectedIds(db, '"quorum"')).toEqual([other.id]);
            expect(projectedIds(db, '"quorum"')).not.toContain(mine.id);
            validateNotesSearchProjection(db);
        } finally {
            closeQuietly(db);
        }
    });

    test("a corrupted projection is detected and rebuilt from notes", () => {
        const db = migratedDb();
        try {
            const note = addNote(db, "session", {
                sessionId: "ses-corrupt",
                content: "Authoritative content about replication.",
            });

            db.prepare("INSERT INTO notes_fts(rowid, searchable_text) VALUES (?, ?)").run(
                note.id + 1000,
                "stale phantom text about compaction",
            );
            expect(projectedIds(db, '"compaction"')).toEqual([note.id + 1000]);
            expect(projectionRowCount(db)).toBe(noteRowCount(db));
            expect(() => validateNotesSearchProjection(db)).toThrow(
                /malformed|projection validation failed/,
            );

            db.transaction(() => installNotesSearchProjection(db))();

            expect(projectedIds(db, '"compaction"')).toEqual([]);
            expect(projectedIds(db, '"replication"')).toEqual([note.id]);
            expect(projectionRowCount(db)).toBe(1);
            validateNotesSearchProjection(db);
        } finally {
            closeQuietly(db);
        }
    });

    test("replaying from v78 tolerates a legacy notes table without ready_reason", () => {
        const db = new Database(":memory:");
        try {
            seedAppliedVersion(db, 78);
            db.exec(`
                CREATE TABLE notes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    type TEXT NOT NULL DEFAULT 'session',
                    status TEXT NOT NULL DEFAULT 'active',
                    content TEXT NOT NULL,
                    session_id TEXT,
                    project_path TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
            `);
            db.prepare(
                "INSERT INTO notes (content, session_id, created_at, updated_at) VALUES (?, ?, ?, ?)",
            ).run("Legacy note about batching.", "ses-legacy", 1, 1);

            runMigrations(db);

            expect(appliedVersionCount(db, 79)).toBe(1);
            expect(projectedIds(db, '"batching"')).toEqual([1]);
            validateNotesSearchProjection(db);
        } finally {
            closeQuietly(db);
        }
    });
});
