import { describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";
import {
    bumpEpochsForWorkspaceMembers,
    computeWorkspaceEpochFingerprint,
    expandWorkspaceIdentitySet,
    resolveWorkspaceIdentitySet,
    resolveWorkspaceShareCategories,
} from "./workspaces";

function openDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

describe("workspace identity helpers", () => {
    test("resolves members and reverse-expands legacy aliases from the v22 rekey map", () => {
        const db = openDb();
        try {
            db.exec(`
                INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (1, 'ws', 1, 1);
                INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
                VALUES (1, 'git:new-a', 'A', '/a', 1), (1, 'git:new-b', 'B', '/b', 1);
                INSERT INTO v22_identity_rekey_map (old_project_path, new_project_path, rekeyed_at)
                VALUES ('/raw/path/a', 'git:new-a', 2);
            `);

            const set = resolveWorkspaceIdentitySet(db, "git:new-b");
            expect(set.identities).toEqual(["git:new-a", "git:new-b"]);
            expect(set.namesByIdentity.get("git:new-a")).toBe("A");
            expect(expandWorkspaceIdentitySet(db, set.identities).sort()).toEqual([
                "/raw/path/a",
                "git:new-a",
                "git:new-b",
            ]);
        } finally {
            closeQuietly(db);
        }
    });

    test("expands multi-hop rekey chains and numeric-registry aliases to workspace members", () => {
        const db = openDb();
        try {
            db.exec(`
                INSERT INTO v22_identity_rekey_map (old_project_path, new_project_path, rekeyed_at)
                VALUES ('git:hop-1', 'git:hop-2', 2), ('git:hop-2', 'git:member', 2);
                INSERT INTO projects (canonical_identity, created_at) VALUES ('git:member', 1);
                INSERT INTO project_aliases (alias_identity, project_id, created_at)
                VALUES ('git:member', 1, 1), ('git:registry-alias', 1, 1);
            `);

            expect(expandWorkspaceIdentitySet(db, ["git:member"]).sort()).toEqual([
                "git:hop-1",
                "git:hop-2",
                "git:member",
                "git:registry-alias",
            ]);
        } finally {
            closeQuietly(db);
        }
    });

    test("workspace fingerprint is stable over sorted identity/epoch pairs", () => {
        const db = openDb();
        try {
            db.prepare(
                "INSERT INTO project_state (project_path, project_memory_epoch, project_user_profile_version, updated_at) VALUES (?, ?, 0, 1)",
            ).run("git:b", 2);
            db.prepare(
                "INSERT INTO project_state (project_path, project_memory_epoch, project_user_profile_version, updated_at) VALUES (?, ?, 0, 1)",
            ).run("git:a", 1);

            expect(computeWorkspaceEpochFingerprint(db, ["git:b", "git:a"])).toHaveLength(64);
            expect(computeWorkspaceEpochFingerprint(db, ["git:b", "git:a"])).toBe(
                computeWorkspaceEpochFingerprint(db, ["git:a", "git:b"]),
            );
        } finally {
            closeQuietly(db);
        }
    });

    test("share categories resolve as sorted canonical values and fingerprint tracks the normalized set", () => {
        const db = openDb();
        try {
            db.exec(`
                INSERT INTO workspaces (id, name, share_categories, created_at, updated_at)
                VALUES (1, 'ws', '["NAMING","CONSTRAINTS","NAMING"]', 1, 1);
                INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
                VALUES (1, 'git:a', 'A', '/a', 1), (1, 'git:b', 'B', '/b', 1);
            `);

            const initial = computeWorkspaceEpochFingerprint(db, ["git:b", "git:a"]);

            expect(resolveWorkspaceShareCategories(db, "git:a")).toEqual(["CONSTRAINTS", "NAMING"]);
            db.prepare("UPDATE workspaces SET share_categories = ? WHERE id = 1").run(
                '["CONSTRAINTS","NAMING"]',
            );
            expect(computeWorkspaceEpochFingerprint(db, ["git:a", "git:b"])).toBe(initial);

            db.prepare("UPDATE workspaces SET share_categories = ? WHERE id = 1").run("[]");
            expect(computeWorkspaceEpochFingerprint(db, ["git:a", "git:b"])).not.toBe(initial);
            expect(resolveWorkspaceShareCategories(db, "git:a")).toEqual([]);
        } finally {
            closeQuietly(db);
        }
    });

    test("share categories default legacy NULL and fail closed for malformed rows", () => {
        const db = new Database(":memory:");
        try {
            db.exec(`
                CREATE TABLE workspaces (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE,
                    share_categories TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE workspace_members (
                    workspace_id INTEGER NOT NULL,
                    project_path TEXT NOT NULL,
                    display_name TEXT NOT NULL,
                    display_path TEXT NOT NULL,
                    added_at INTEGER NOT NULL,
                    PRIMARY KEY (workspace_id, project_path)
                );
                INSERT INTO workspaces (id, name, share_categories, created_at, updated_at)
                VALUES (1, 'legacy-null', NULL, 1, 1);
                INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
                VALUES (1, 'git:a', 'A', '/a', 1), (1, 'git:b', 'B', '/b', 1);
            `);

            expect(resolveWorkspaceShareCategories(db, "git:a")).toEqual(["CONSTRAINTS"]);

            db.prepare("UPDATE workspaces SET share_categories = ? WHERE id = 1").run("not-json");
            expect(resolveWorkspaceShareCategories(db, "git:a")).toEqual([]);

            db.prepare("UPDATE workspaces SET share_categories = ? WHERE id = 1").run(
                '["CONSTRAINTS","NOT_A_CATEGORY"]',
            );
            expect(resolveWorkspaceShareCategories(db, "git:a")).toEqual([]);
        } finally {
            closeQuietly(db);
        }
    });

    test("epoch fan-out bumps every member of the target workspace", () => {
        const db = openDb();
        try {
            db.exec(`
                INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (1, 'ws', 1, 1);
                INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
                VALUES (1, 'git:a', 'A', '/a', 1), (1, 'git:b', 'B', '/b', 1);
            `);

            bumpEpochsForWorkspaceMembers(db, "git:a", 10);

            expect(
                db
                    .prepare(
                        "SELECT project_memory_epoch FROM project_state WHERE project_path = 'git:a'",
                    )
                    .get(),
            ).toEqual({ project_memory_epoch: 1 });
            expect(
                db
                    .prepare(
                        "SELECT project_memory_epoch FROM project_state WHERE project_path = 'git:b'",
                    )
                    .get(),
            ).toEqual({ project_memory_epoch: 1 });
        } finally {
            closeQuietly(db);
        }
    });
});
