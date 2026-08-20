/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";

function columnNames(db: Database): Set<string> {
    return new Set(
        (db.prepare("PRAGMA table_info(notes)").all() as Array<{ name: string }>).map(
            (row) => row.name,
        ),
    );
}

function v80Database(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    // Deleting only row 81 would leave the current version at 82 and never
    // re-select the pending 81; the replayed 82 no-ops over its existing tables.
    db.exec("DELETE FROM schema_migrations WHERE version >= 81");
    db.exec(`
        ALTER TABLE notes DROP COLUMN source_revision;
        ALTER TABLE notes DROP COLUMN state_version;
    `);
    return db;
}

describe("migration v81: smart-note evaluation revisions", () => {
    test("fresh database gets both revision columns defaulted to 0", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            const columns = columnNames(db);
            expect(columns.has("source_revision")).toBe(true);
            expect(columns.has("state_version")).toBe(true);

            db.prepare(
                "INSERT INTO notes (type, status, content, project_path, surface_condition, created_at, updated_at, harness) VALUES ('smart', 'pending', 'c', '/p', 'cond', 1, 1, 't')",
            ).run();
            const row = db
                .prepare("SELECT source_revision, state_version FROM notes")
                .get() as Record<string, number>;
            expect(row.source_revision).toBe(0);
            expect(row.state_version).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });

    test("existing rows migrate with equal source and state revisions", () => {
        const db = v80Database();
        try {
            db.prepare(
                "INSERT INTO notes (type, status, content, project_path, surface_condition, created_at, updated_at, harness) VALUES ('smart', 'pending', 'legacy', '/p', 'cond', 1, 1, 't')",
            ).run();
            expect(columnNames(db).has("state_version")).toBe(false);

            runMigrations(db);
            const row = db
                .prepare("SELECT source_revision, state_version FROM notes")
                .get() as Record<string, number>;
            expect(row.source_revision).toBe(0);
            expect(row.state_version).toBe(0);
            expect(row.source_revision).toBe(row.state_version);
        } finally {
            closeQuietly(db);
        }
    });
});
