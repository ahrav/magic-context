/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    applyIdentityMergeToProjectRegistry,
    collectAliasesForTargets,
    discoverIdentityTables,
    isCanonicalProjectIdentity,
    resolveProjectIdentitySeed,
    resolveTerminalIdentity,
    seedProjectRegistry,
} from "./storage-project-identities";
import { createDirectTestDatabase } from "./test-database";

let db: Database | null = null;

function rawDb(): Database {
    db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    return db;
}

function registryDb(): Database {
    const database = createDirectTestDatabase().db;
    db = database;
    return database;
}

function projectIdFor(database: Database, identity: string): number | undefined {
    const row = database
        .prepare("SELECT project_id AS id FROM project_aliases WHERE alias_identity = ?")
        .get(identity) as { id: number } | undefined;
    return row?.id;
}

afterEach(() => {
    if (db) closeQuietly(db);
    db = null;
});

describe("identity discovery", () => {
    test("finds non-derived tables carrying project_path or project_identity columns", () => {
        const database = rawDb();
        database.exec(`
            CREATE TABLE plain (id INTEGER PRIMARY KEY, project_path TEXT);
            CREATE TABLE alt (id INTEGER PRIMARY KEY, project_identity TEXT);
            CREATE TABLE unrelated (id INTEGER PRIMARY KEY, name TEXT);
            CREATE TABLE plain_fts (project_path TEXT);
        `);
        const tables = discoverIdentityTables(database);
        expect(tables.map((table) => [table.name, table.identityColumn, table.derived])).toEqual([
            ["alt", "project_identity", false],
            ["plain", "project_path", false],
            ["plain_fts", "project_path", true],
        ]);
    });

    test("isCanonicalProjectIdentity accepts git:/dir: values and rejects raw paths", () => {
        expect(isCanonicalProjectIdentity("git:abc123")).toBe(true);
        expect(isCanonicalProjectIdentity("dir:deadbeef")).toBe(true);
        expect(isCanonicalProjectIdentity("git:")).toBe(false);
        expect(isCanonicalProjectIdentity("/home/user/project")).toBe(false);
    });
});

describe("terminal-chain resolution", () => {
    test("walks multi-hop chains to the terminal identity", () => {
        const map = new Map([
            ["git:a", "git:b"],
            ["git:b", "git:c"],
        ]);
        expect(resolveTerminalIdentity(map, "git:a")).toBe("git:c");
        expect(resolveTerminalIdentity(map, "git:b")).toBe("git:c");
        expect(resolveTerminalIdentity(map, "git:c")).toBe("git:c");
        expect(resolveTerminalIdentity(map, "git:untouched")).toBe("git:untouched");
    });

    test("rejects cycles with a bounded diagnostic", () => {
        const map = new Map([
            ["git:a", "git:b"],
            ["git:b", "git:a"],
        ]);
        expect(() => resolveTerminalIdentity(map, "git:a")).toThrow(/rekey cycle/);
    });
});

describe("seed resolution", () => {
    test("collects observed identities and rekey chains into terminals plus aliases", () => {
        const database = rawDb();
        database.exec(`
            CREATE TABLE memories (id INTEGER PRIMARY KEY, project_path TEXT);
            CREATE TABLE v22_identity_rekey_map (
                old_project_path TEXT PRIMARY KEY,
                new_project_path TEXT NOT NULL,
                rekeyed_at INTEGER NOT NULL
            );
            INSERT INTO memories (project_path) VALUES ('git:live'), ('/raw/unmapped');
            INSERT INTO v22_identity_rekey_map VALUES ('git:old', 'git:live', 1);
            INSERT INTO v22_identity_rekey_map VALUES ('/raw/mapped', 'git:live', 1);
            INSERT INTO v22_identity_rekey_map VALUES ('/raw/dead-end', '/raw/other', 1);
        `);
        const seed = resolveProjectIdentitySeed(database);
        expect(seed.terminals).toEqual(["git:live"]);
        expect([...seed.aliasTargets.entries()].sort()).toEqual([
            ["/raw/mapped", "git:live"],
            ["git:live", "git:live"],
            ["git:old", "git:live"],
        ]);
        expect(seed.skippedCycles).toEqual([]);
    });

    test("cyclic rekey chains are skipped with diagnostics instead of failing the seed", () => {
        const database = rawDb();
        database.exec(`
            CREATE TABLE memories (id INTEGER PRIMARY KEY, project_path TEXT);
            CREATE TABLE v22_identity_rekey_map (
                old_project_path TEXT PRIMARY KEY,
                new_project_path TEXT NOT NULL,
                rekeyed_at INTEGER NOT NULL
            );
            INSERT INTO memories (project_path) VALUES ('git:live'), ('git:loop-a');
            INSERT INTO v22_identity_rekey_map VALUES ('git:loop-a', 'git:loop-b', 1);
            INSERT INTO v22_identity_rekey_map VALUES ('git:loop-b', 'git:loop-a', 1);
        `);
        const seed = resolveProjectIdentitySeed(database);
        expect(seed.terminals).toEqual(["git:live"]);
        expect([...seed.skippedCycles].sort()).toEqual(["git:loop-a", "git:loop-b"]);
        expect(seed.aliasTargets.has("git:loop-a")).toBe(false);
        expect(seed.aliasTargets.has("git:loop-b")).toBe(false);
    });

    test("seedProjectRegistry publishes one project per terminal with every alias", () => {
        const database = registryDb();
        seedProjectRegistry(
            database,
            {
                terminals: ["dir:two", "git:one"],
                aliasTargets: new Map([
                    ["dir:two", "dir:two"],
                    ["git:one", "git:one"],
                    ["git:legacy", "git:one"],
                ]),
            },
            1_000,
        );
        expect(projectIdFor(database, "git:legacy")).toBe(
            projectIdFor(database, "git:one") as number,
        );
        expect(projectIdFor(database, "dir:two")).not.toBe(projectIdFor(database, "git:one"));
    });
});

describe("collectAliasesForTargets", () => {
    test("flattens rekey chains and registry aliases while skipping corrupt cycles", () => {
        const database = registryDb();
        database.exec(`
            INSERT INTO v22_identity_rekey_map VALUES ('git:hop-1', 'git:hop-2', 1);
            INSERT INTO v22_identity_rekey_map VALUES ('git:hop-2', 'git:target', 1);
            INSERT INTO v22_identity_rekey_map VALUES ('git:loop-a', 'git:loop-b', 1);
            INSERT INTO v22_identity_rekey_map VALUES ('git:loop-b', 'git:loop-a', 1);
        `);
        seedProjectRegistry(
            database,
            {
                terminals: ["git:target"],
                aliasTargets: new Map([
                    ["git:target", "git:target"],
                    ["git:registry-alias", "git:target"],
                ]),
            },
            1_000,
        );
        const aliases = collectAliasesForTargets(database, ["git:target"]);
        expect([...aliases.entries()].sort()).toEqual([
            ["git:hop-1", "git:target"],
            ["git:hop-2", "git:target"],
            ["git:registry-alias", "git:target"],
        ]);
    });

    test("returns rekey-map aliases when the registry tables are absent", () => {
        const database = rawDb();
        database.exec(`
            CREATE TABLE v22_identity_rekey_map (
                old_project_path TEXT PRIMARY KEY,
                new_project_path TEXT NOT NULL,
                rekeyed_at INTEGER NOT NULL
            );
            INSERT INTO v22_identity_rekey_map VALUES ('git:old', 'git:target', 1);
        `);
        expect([...collectAliasesForTargets(database, ["git:target"]).entries()]).toEqual([
            ["git:old", "git:target"],
        ]);
    });
});

describe("applyIdentityMergeToProjectRegistry", () => {
    function seededRegistry(): Database {
        const database = registryDb();
        seedProjectRegistry(
            database,
            {
                terminals: ["git:source", "git:target"],
                aliasTargets: new Map([
                    ["git:source", "git:source"],
                    ["git:source-old", "git:source"],
                    ["git:target", "git:target"],
                ]),
            },
            1_000,
        );
        return database;
    }

    test("repoints every source alias to the target and drops the empty source project", () => {
        const database = seededRegistry();
        database.exec("INSERT INTO v22_identity_rekey_map VALUES ('git:chained', 'git:source', 1)");
        const targetId = projectIdFor(database, "git:target") as number;

        applyIdentityMergeToProjectRegistry(database, "git:source", "git:target", 2_000);

        expect(projectIdFor(database, "git:source")).toBe(targetId);
        expect(projectIdFor(database, "git:source-old")).toBe(targetId);
        expect(
            database.prepare("SELECT COUNT(*) AS count FROM projects").get() as { count: number },
        ).toEqual({ count: 1 });
        expect(
            database
                .prepare(
                    "SELECT new_project_path AS target FROM v22_identity_rekey_map WHERE old_project_path = 'git:chained'",
                )
                .get(),
        ).toEqual({ target: "git:target" });
    });

    test("refuses to merge a source project that owns authoritative children", () => {
        const database = seededRegistry();
        const sourceId = projectIdFor(database, "git:source") as number;
        database
            .prepare("INSERT INTO episodes (project_id, created_at) VALUES (?, 1)")
            .run(sourceId);
        expect(() =>
            applyIdentityMergeToProjectRegistry(database, "git:source", "git:target", 2_000),
        ).toThrow(/authoritative episodes or claims/);
    });

    test("adopts the target identity in place when only the source is registered", () => {
        const database = seededRegistry();
        const sourceId = projectIdFor(database, "git:source") as number;
        applyIdentityMergeToProjectRegistry(database, "git:source", "git:brand-new", 2_000);
        expect(projectIdFor(database, "git:brand-new")).toBe(sourceId);
        expect(projectIdFor(database, "git:source")).toBe(sourceId);
        expect(
            database
                .prepare("SELECT canonical_identity AS c FROM projects WHERE id = ?")
                .get(sourceId),
        ).toEqual({ c: "git:brand-new" });
    });

    test("in-place adoption stays legal when the source owns authoritative children", () => {
        const database = seededRegistry();
        const sourceId = projectIdFor(database, "git:source") as number;
        database
            .prepare("INSERT INTO episodes (project_id, created_at) VALUES (?, 1)")
            .run(sourceId);

        // The routine dir:/git: rekey renames the same numeric row; children
        // keep their project_id, so owned history must not block it.
        applyIdentityMergeToProjectRegistry(database, "git:source", "git:brand-new", 2_000);

        expect(projectIdFor(database, "git:brand-new")).toBe(sourceId);
        expect(
            database
                .prepare("SELECT canonical_identity AS c FROM projects WHERE id = ?")
                .get(sourceId),
        ).toEqual({ c: "git:brand-new" });
        expect(
            database
                .prepare("SELECT COUNT(*) AS count FROM episodes WHERE project_id = ?")
                .get(sourceId),
        ).toEqual({ count: 1 });
    });

    test("refuses adopting a non-canonical target for a registered source", () => {
        const database = seededRegistry();
        expect(() =>
            applyIdentityMergeToProjectRegistry(database, "git:source", "/raw/target", 2_000),
        ).toThrow(/not a canonical/);
    });

    test("adds a source alias when only the target is registered, and no-ops when neither is", () => {
        const database = seededRegistry();
        const targetId = projectIdFor(database, "git:target") as number;
        applyIdentityMergeToProjectRegistry(database, "/raw/unregistered", "git:target", 2_000);
        expect(projectIdFor(database, "/raw/unregistered")).toBe(targetId);

        applyIdentityMergeToProjectRegistry(database, "/raw/a", "/raw/b", 2_000);
        expect(projectIdFor(database, "/raw/a")).toBeUndefined();
    });
});
