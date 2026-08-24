import { describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { LATEST_MIGRATION_VERSION, runMigrations } from "./migrations";
import { initializeDatabase, LATEST_SUPPORTED_VERSION } from "./storage-db";

function tableColumns(db: Database, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (column) => column.name,
    );
}

function indexNames(db: Database): string[] {
    return (
        db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{
            name: string;
        }>
    ).map((row) => row.name);
}

const CLEARED_NULL_COLUMNS = [
    "cached_m0_bytes",
    "cached_m1_bytes",
    "cached_m0_project_memory_epoch",
    "cached_m0_workspace_fingerprint",
    "cached_m0_project_user_profile_version",
    "cached_m0_max_compartment_seq",
    "cached_m0_max_memory_id",
    "cached_m0_max_mutation_id",
    "cached_m0_max_memory_mutation_id",
    "cached_m0_project_docs_hash",
    "cached_m0_materialized_at",
    "cached_m0_session_facts_version",
    "cached_m0_upgrade_state",
    "cached_m0_system_hash",
    "cached_m0_tool_set_hash",
    "cached_m0_model_key",
    "cached_m0_last_baseline_end_message_id",
] as const;

const CLEARED_EMPTY_COLUMNS = ["memory_block_cache", "memory_block_ids"] as const;

describe("migration v34/v35 — workspaces", () => {
    test("fresh DB schema includes workspace tables and schema fence version", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);

            expect(tableColumns(db, "workspaces")).toEqual(
                expect.arrayContaining([
                    "id",
                    "name",
                    "created_at",
                    "updated_at",
                    "share_categories",
                ]),
            );
            expect(tableColumns(db, "workspace_members")).toEqual(
                expect.arrayContaining([
                    "workspace_id",
                    "project_path",
                    "display_name",
                    "display_path",
                    "added_at",
                ]),
            );
            expect(tableColumns(db, "session_meta")).toContain("cached_m0_workspace_fingerprint");
            expect(indexNames(db)).toEqual(
                expect.arrayContaining([
                    "idx_workspace_member_unique",
                    "idx_workspace_member_name",
                ]),
            );
            db.prepare(
                "INSERT INTO workspaces (name, created_at, updated_at) VALUES ('fresh', 1, 1)",
            ).run();
            expect(
                db.prepare("SELECT share_categories FROM workspaces WHERE name = 'fresh'").get(),
            ).toEqual({ share_categories: '["CONSTRAINTS"]' });
            expect(LATEST_SUPPORTED_VERSION).toBe(LATEST_MIGRATION_VERSION);
            expect(LATEST_MIGRATION_VERSION).toBeGreaterThanOrEqual(35);
            expect(
                db
                    .prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")
                    .get(),
            ).toEqual({ version: LATEST_MIGRATION_VERSION });
        } finally {
            closeQuietly(db);
        }
    });

    test("up clears every cached m0/m1 column with explicit reset values", () => {
        const db = new Database(":memory:");
        try {
            db.exec(`
                CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at INTEGER NOT NULL);
                INSERT INTO schema_migrations (version, description, applied_at) VALUES (33, 'pre-v34 fixture', 1);
                CREATE TABLE session_meta (
                    session_id TEXT PRIMARY KEY,
                    cached_m0_bytes BLOB,
                    cached_m1_bytes BLOB,
                    cached_m0_project_memory_epoch INTEGER,
                    cached_m0_project_user_profile_version INTEGER,
                    cached_m0_max_compartment_seq INTEGER,
                    cached_m0_max_memory_id INTEGER,
                    cached_m0_max_mutation_id INTEGER,
                    cached_m0_max_memory_mutation_id INTEGER,
                    cached_m0_project_docs_hash TEXT,
                    cached_m0_materialized_at INTEGER,
                    cached_m0_session_facts_version INTEGER,
                    cached_m0_upgrade_state TEXT,
                    cached_m0_system_hash TEXT,
                    cached_m0_tool_set_hash TEXT,
                    cached_m0_model_key TEXT,
                    cached_m0_last_baseline_end_message_id TEXT,
                    memory_block_cache TEXT,
                    memory_block_ids TEXT,
                    memory_block_count INTEGER
                );
                INSERT INTO session_meta (
                    session_id,
                    cached_m0_bytes,
                    cached_m1_bytes,
                    cached_m0_project_memory_epoch,
                    cached_m0_project_user_profile_version,
                    cached_m0_max_compartment_seq,
                    cached_m0_max_memory_id,
                    cached_m0_max_mutation_id,
                    cached_m0_max_memory_mutation_id,
                    cached_m0_project_docs_hash,
                    cached_m0_materialized_at,
                    cached_m0_session_facts_version,
                    cached_m0_upgrade_state,
                    cached_m0_system_hash,
                    cached_m0_tool_set_hash,
                    cached_m0_model_key,
                    cached_m0_last_baseline_end_message_id,
                    memory_block_cache,
                    memory_block_ids,
                    memory_block_count
                ) VALUES (
                    's1', X'0102', X'0304', 1, 2, 3, 4, 5, 6, 'docs', 7, 8, 'ready', 'sys', 'tools', 'model', 'msg-1', 'cache', '[1,2]', 2
                );
            `);

            runMigrations(db);

            const row = db
                .prepare("SELECT * FROM session_meta WHERE session_id = 's1'")
                .get() as Record<string, unknown>;
            for (const column of CLEARED_NULL_COLUMNS) {
                expect(row[column], column).toBeNull();
            }
            for (const column of CLEARED_EMPTY_COLUMNS) {
                expect(row[column], column).toBe("");
            }
            expect(row.memory_block_count).toBe(0);
            expect(tableColumns(db, "session_meta")).toContain("cached_m0_workspace_fingerprint");
        } finally {
            closeQuietly(db);
        }
    });

    test("v35 adds guarded share_categories default and bumps existing workspace member epochs", () => {
        const db = new Database(":memory:");
        try {
            db.exec(`
                CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at INTEGER NOT NULL);
                INSERT INTO schema_migrations (version, description, applied_at) VALUES (34, 'pre-v35 fixture', 1);
                CREATE TABLE workspaces (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE workspace_members (
                    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
                    project_path TEXT NOT NULL,
                    display_name TEXT NOT NULL,
                    display_path TEXT NOT NULL,
                    added_at INTEGER NOT NULL,
                    PRIMARY KEY (workspace_id, project_path)
                );
                CREATE TABLE project_state (
                    project_path TEXT PRIMARY KEY,
                    project_memory_epoch INTEGER NOT NULL DEFAULT 0,
                    project_user_profile_version INTEGER NOT NULL DEFAULT 0,
                    updated_at INTEGER NOT NULL DEFAULT 0
                );
                INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (1, 'ws', 1, 1);
                INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
                VALUES (1, 'git:a', 'A', '/a', 1), (1, 'git:b', 'B', '/b', 1);
                INSERT INTO project_state (project_path, project_memory_epoch, project_user_profile_version, updated_at)
                VALUES ('git:a', 7, 0, 1);
            `);

            runMigrations(db);

            expect(tableColumns(db, "workspaces")).toContain("share_categories");
            expect(
                db.prepare("SELECT share_categories FROM workspaces WHERE id = 1").get(),
            ).toEqual({ share_categories: '["CONSTRAINTS"]' });
            expect(
                db
                    .prepare(
                        "SELECT project_path, project_memory_epoch FROM project_state ORDER BY project_path",
                    )
                    .all(),
            ).toEqual([
                { project_path: "git:a", project_memory_epoch: 9 },
                { project_path: "git:b", project_memory_epoch: 2 },
            ]);
            expect(
                db
                    .prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")
                    .get(),
            ).toEqual({ version: LATEST_MIGRATION_VERSION });
        } finally {
            closeQuietly(db);
        }
    });
});
