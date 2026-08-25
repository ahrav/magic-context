import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseType } from "../../shared/sqlite";
import { Database, withPrivilegedWriter } from "../../shared/sqlite";
import { ensureContextStoreUuid, installAuthorityManagedMarker } from "./context-authority";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";

const databases: DatabaseType[] = [];
const tempDirs: string[] = [];

function freshDatabase(path = ":memory:"): DatabaseType {
    const db = new Database(path);
    databases.push(db);
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

afterEach(() => {
    for (const db of databases.splice(0)) db.close();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("authority-managed context.db schema", () => {
    it("mints a stable store UUID and closes managed memory and smart-note writes", () => {
        const db = freshDatabase();
        const uuid = ensureContextStoreUuid(db);
        expect(uuid).toMatch(/^[0-9a-f-]{36}$/);
        expect(ensureContextStoreUuid(db)).toBe(uuid);
        installAuthorityManagedMarker(db, "/project", uuid);

        expect(() =>
            db
                .prepare(
                    "INSERT INTO memories (project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES (?, ?, ?, ?, 0, 0, 0, 0)",
                )
                .run("/project", "CONSTRAINTS", "blocked", "hash"),
        ).toThrow();
        expect(() =>
            db
                .prepare(
                    "INSERT INTO notes (type, status, content, project_path, created_at, updated_at) VALUES ('smart', 'active', 'blocked', ?, 0, 0)",
                )
                .run("/project"),
        ).toThrow();

        withPrivilegedWriter(db, () => {
            db.prepare(
                "INSERT INTO authority_repair_pending(project_path, started_at) VALUES (?, 0)",
            ).run("/repairing");
        });
        expect(() =>
            db
                .prepare(
                    "INSERT INTO memories (project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES (?, ?, ?, ?, 0, 0, 0, 0)",
                )
                .run("/repairing", "CONSTRAINTS", "blocked", "hash"),
        ).toThrow();
        withPrivilegedWriter(db, () => {
            db.prepare("DELETE FROM authority_repair_pending WHERE project_path = ?").run(
                "/repairing",
            );
        });

        withPrivilegedWriter(db, () => {
            db.prepare(
                "INSERT INTO memories (project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES (?, ?, ?, ?, 0, 0, 0, 0)",
            ).run("/project", "CONSTRAINTS", "allowed", "hash");
            db.prepare(
                "INSERT INTO notes (type, status, content, project_path, created_at, updated_at) VALUES ('smart', 'active', 'allowed', ?, 0, 0)",
            ).run("/project");
        });

        db.prepare(
            "INSERT INTO session_projects(session_id, harness, project_path, updated_at) VALUES (?, 'opencode', ?, 0)",
        ).run("session", "/project");
        expect(() =>
            db
                .prepare(
                    "INSERT INTO notes (type, status, content, session_id, created_at, updated_at) VALUES ('session', 'active', 'blocked session note', ?, 0, 0)",
                )
                .run("session"),
        ).toThrow();
        withPrivilegedWriter(db, () => {
            db.prepare(
                "INSERT INTO notes (type, status, content, session_id, created_at, updated_at) VALUES ('session', 'active', 'allowed session note', ?, 0, 0)",
            ).run("session");
        });

        const triggerSql = (
            db
                .prepare(
                    "SELECT group_concat(sql, char(10)) AS sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%authority_guard%'",
                )
                .get() as { sql?: string }
        ).sql;
        expect(triggerSql).toContain(
            "COALESCE((SELECT enabled FROM context_privilege_state WHERE id = 1), 0) = 0",
        );
        expect(triggerSql).not.toContain("mc_privileged_writer");
    });

    it("composes privilege brackets with an existing BEGIN IMMEDIATE", () => {
        const db = freshDatabase();
        db.exec("BEGIN IMMEDIATE");
        withPrivilegedWriter(db, () => {
            db.prepare(
                "INSERT INTO authority_repair_pending(project_path, started_at) VALUES (?, 0)",
            ).run("/nested");
        });
        expect(
            db.prepare("SELECT enabled FROM context_privilege_state WHERE id = 1").get() as {
                enabled: number;
            },
        ).toEqual({ enabled: 0 });
        db.exec("ROLLBACK");
    });

    it("keeps an outer privilege bracket active across sequential inner brackets", () => {
        const db = freshDatabase();
        const uuid = ensureContextStoreUuid(db);
        installAuthorityManagedMarker(db, "/project", uuid);

        withPrivilegedWriter(db, () => {
            withPrivilegedWriter(db, () => {
                db.prepare(
                    "INSERT INTO authority_repair_pending(project_path, started_at) VALUES (?, 0)",
                ).run("/inner-a");
            });
            withPrivilegedWriter(db, () => {
                db.prepare(
                    "INSERT INTO authority_repair_pending(project_path, started_at) VALUES (?, 0)",
                ).run("/inner-b");
            });
            db.prepare(
                "INSERT INTO memories (project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES (?, ?, ?, ?, 0, 0, 0, 0)",
            ).run("/project", "CONSTRAINTS", "outer write", "outer-hash");
        });

        expect(
            db.prepare("SELECT content FROM memories WHERE project_path = ?").get("/project") as {
                content: string;
            },
        ).toEqual({ content: "outer write" });
    });

    it("rejects a raw connection that has not entered a privilege bracket", () => {
        const dir = mkdtempSync(join(tmpdir(), "mc-authority-"));
        tempDirs.push(dir);
        const path = join(dir, "context.db");
        const managed = freshDatabase(path);
        const uuid = ensureContextStoreUuid(managed);
        installAuthorityManagedMarker(managed, "/project", uuid);
        managed.close();
        databases.splice(databases.indexOf(managed), 1);

        const raw = new Database(path);
        databases.push(raw);
        expect(() =>
            raw
                .prepare(
                    "INSERT INTO memories (project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES (?, ?, ?, ?, 0, 0, 0, 0)",
                )
                .run("/project", "CONSTRAINTS", "raw", "raw"),
        ).toThrow(/managed by the Rust module/i);
    });

    it("does not leak privilege to a second connection during a paused bracket", () => {
        const dir = mkdtempSync(join(tmpdir(), "mc-authority-leak-"));
        tempDirs.push(dir);
        const path = join(dir, "context.db");
        const connA = freshDatabase(path);
        const uuid = ensureContextStoreUuid(connA);
        installAuthorityManagedMarker(connA, "/project", uuid);
        const connB = new Database(path);
        databases.push(connB);
        connB.exec("PRAGMA busy_timeout=50; PRAGMA journal_mode=WAL");

        withPrivilegedWriter(connA, () => {
            expect(() =>
                connB
                    .prepare(
                        "INSERT INTO memories (project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES (?, ?, ?, ?, 0, 0, 0, 0)",
                    )
                    .run("/project", "CONSTRAINTS", "racing", "hash"),
            ).toThrow(/busy|locked|managed by the Rust module/i);
        });

        expect(() =>
            connB
                .prepare(
                    "INSERT INTO memories (project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES (?, ?, ?, ?, 0, 0, 0, 0)",
                )
                .run("/project", "CONSTRAINTS", "after", "hash"),
        ).toThrow(/managed by the Rust module/i);
    });

    it("reinstalls the latest authority triggers after replaying a legacy batch", () => {
        const db = freshDatabase();
        const uuid = ensureContextStoreUuid(db);
        installAuthorityManagedMarker(db, "/project", uuid);
        db.prepare(
            "INSERT INTO session_projects(session_id, harness, project_path, updated_at) VALUES (?, 'opencode', ?, 0)",
        ).run("session", "/project");
        db.exec(`
            DROP TRIGGER notes_authority_guard_insert;
            CREATE TRIGGER notes_authority_guard_insert
            BEFORE INSERT ON notes
            WHEN NEW.type = 'smart' AND NEW.project_path IS NOT NULL
              AND EXISTS (SELECT 1 FROM authority_managed WHERE project_path = NEW.project_path)
              AND COALESCE((SELECT enabled FROM context_privilege_state WHERE id = 1), 0) = 0
            BEGIN SELECT RAISE(ABORT, 'old smart-note-only guard'); END;
            DELETE FROM schema_migrations WHERE version >= 61;
        `);

        runMigrations(db);

        expect(() =>
            db
                .prepare(
                    "INSERT INTO notes (type, status, content, session_id, created_at, updated_at) VALUES ('session', 'active', 'blocked after replay', ?, 0, 0)",
                )
                .run("session"),
        ).toThrow(/managed by the Rust module/i);
    });
});
