/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { runMigrations } from "../migrations";
import { countingDatabase } from "../sql-counters";
import { initializeDatabase } from "../storage-db";
import { dropMemoryClaimsCompatObjectsForTests } from "../storage-memory-claims-schema";
import {
    archiveMemory,
    clearEmbeddingsForProject,
    deleteEmbedding,
    deleteMemory,
    getMaxMemoryIdForProjects,
    getMemoriesByProject,
    getMemoriesByProjects,
    getMemoriesByRequestedIds,
    getMemoryByHash,
    getMemoryById,
    getMemoryCount,
    getMemoryVerifications,
    getProjectEmbeddings,
    getStoredModelId,
    insertMemory,
    insertMemoryIdempotent,
    loadAllEmbeddings,
    MemoryStatsIntegrityError,
    mergeMemoryStats,
    readNewMemoriesForM1Union,
    recordMemoryMapping,
    recordMemoryVerifications,
    resetEmbeddingCacheForTests,
    saveEmbedding,
    searchMemoriesFTS,
    searchMemoriesFTSUnion,
    setMemoryClassification,
    supersededMemory,
    updateMemoryContent,
    updateMemoryRetrievalCount,
    updateMemorySeenCount,
    updateMemoryStatus,
    updateMemoryVerification,
} from "./index";
import { computeNormalizedHash } from "./normalize-hash";
import { rekeyMemoryRowWithCollisionMerge } from "./relocate-memory";
import {
    getCurrentMemoryClaimByLegacyMemoryId,
    runInMemoryClaimsWriteTransaction,
} from "./storage-memory-claims";

let db: Database;

function makeMemoryDatabase(): Database {
    const database = new Database(":memory:");
    database.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      normalized_hash TEXT NOT NULL,
      source_session_id TEXT,
      source_type TEXT DEFAULT 'historian',
      seen_count INTEGER DEFAULT 1,
      retrieval_count INTEGER DEFAULT 0,
      first_seen_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      last_retrieved_at INTEGER,
      status TEXT DEFAULT 'active',
      expires_at INTEGER,
      verification_status TEXT DEFAULT 'unverified',
      verified_at INTEGER,
      superseded_by_memory_id INTEGER,
      merged_from TEXT,
      metadata_json TEXT,
      UNIQUE(project_path, category, normalized_hash)
    );

    CREATE TABLE IF NOT EXISTS memory_embeddings (
      memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      embedding BLOB NOT NULL,
      model_id TEXT NOT NULL,
      PRIMARY KEY(memory_id, model_id)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      category,
      content='memories',
      content_rowid='id',
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, category) VALUES (new.id, new.content, new.category);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, category) VALUES ('delete', old.id, old.content, old.category);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, category) VALUES ('delete', old.id, old.content, old.category);
      INSERT INTO memories_fts(rowid, content, category) VALUES (new.id, new.content, new.category);
    END;
  `);
    return database;
}

afterEach(() => {
    resetEmbeddingCacheForTests();
    if (db) {
        closeQuietly(db);
    }
});

describe("storage-memory", () => {
    describe("#given insert and lookup operations", () => {
        it("#when inserting a memory #then it persists defaults and computed hash", () => {
            db = makeMemoryDatabase();

            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "USER_DIRECTIVES",
                content: "Always use Bun for builds",
                sourceSessionId: "ses-1",
            });

            expect(memory.id).toBe(1);
            expect(memory.normalizedHash).toBe(computeNormalizedHash("Always use Bun for builds"));
            expect(memory.sourceType).toBe("historian");
            expect(memory.status).toBe("active");
            expect(memory.verificationStatus).toBe("unverified");
            expect(memory.seenCount).toBe(1);
            expect(memory.retrievalCount).toBe(0);
            expect(memory.lastRetrievedAt).toBeNull();
        });

        it("#when looking up by hash and id #then it returns the matching memory", () => {
            db = makeMemoryDatabase();
            const inserted = insertMemory(db, {
                projectPath: "/repo/project",
                category: "NAMING",
                content: "Use createX factory names",
            });

            const byHash = getMemoryByHash(
                db,
                "/repo/project",
                "NAMING",
                computeNormalizedHash("use createx factory names"),
            );
            const byId = getMemoryById(db, inserted.id);

            expect(byHash?.id).toBe(inserted.id);
            expect(byId?.content).toBe("Use createX factory names");
        });

        it("#when listing by project without statuses #then only active and permanent memories are returned", () => {
            db = makeMemoryDatabase();
            const active = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Keep strict typing enabled",
            });
            const permanent = insertMemory(db, {
                projectPath: "/repo/project",
                category: "USER_PREFERENCES",
                content: "Keep answers terse",
            });
            const archived = insertMemory(db, {
                projectPath: "/repo/project",
                category: "KNOWN_ISSUES",
                content: "Legacy parser can fail on malformed XML",
            });

            updateMemoryStatus(db, permanent.id, "permanent");
            archiveMemory(db, archived.id);

            const memories = getMemoriesByProject(db, "/repo/project");

            expect(memories.map((memory) => memory.id)).toEqual([active.id, permanent.id]);
        });
    });

    describe("#given update operations", () => {
        it("#when incrementing seen and retrieval counters #then timestamps and counters update", () => {
            db = makeMemoryDatabase();
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "ARCHITECTURE_DECISIONS",
                content: "Use SQLite for magic-context persistence",
            });

            updateMemorySeenCount(db, memory.id);
            updateMemoryRetrievalCount(db, memory.id);

            const updated = getMemoryById(db, memory.id);

            expect(updated?.seenCount).toBe(2);
            expect(updated?.retrievalCount).toBe(1);
            expect(updated?.lastRetrievedAt).not.toBeNull();
            expect(updated?.updatedAt).toBeGreaterThanOrEqual(memory.updatedAt);
        });

        it("#when updating verification and archive state #then fields persist", () => {
            db = makeMemoryDatabase();
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "ENVIRONMENT",
                content: "CI runs on darwin and linux",
            });

            updateMemoryVerification(db, memory.id, "verified");
            archiveMemory(db, memory.id);

            const updated = getMemoryById(db, memory.id);

            expect(updated?.verificationStatus).toBe("verified");
            expect(updated?.verifiedAt).not.toBeNull();
            expect(updated?.status).toBe("archived");
        });

        it("#when archiving with a reason #then metadata stores the archive reason", () => {
            db = makeMemoryDatabase();
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "KNOWN_ISSUES",
                content: "Legacy issue",
            });

            archiveMemory(db, memory.id, "Superseded by new pipeline");

            const updated = getMemoryById(db, memory.id);
            expect(updated?.status).toBe("archived");
            expect(updated?.metadataJson).toContain("Superseded by new pipeline");
        });

        it("#when updating memory content #then normalized hash changes and embeddings are deleted", () => {
            db = makeMemoryDatabase();
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONFIG_DEFAULTS",
                content: "cache_ttl=5m",
            });
            saveEmbedding(db, memory.id, new Float32Array([0.1, 0.2]), "local:model-a");

            updateMemoryContent(
                db,
                memory.id,
                "cache_ttl=10m",
                computeNormalizedHash("cache_ttl=10m"),
            );

            const updated = getMemoryById(db, memory.id);
            expect(updated?.content).toBe("cache_ttl=10m");
            expect(updated?.normalizedHash).toBe(computeNormalizedHash("cache_ttl=10m"));
            expect(loadAllEmbeddings(db, "/repo/project", "local:model-a")).toEqual(new Map());
        });

        it("#when cache-sensitive writes occur #then embedding cache invalidates updated project entries", () => {
            db = makeMemoryDatabase();

            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONFIG_DEFAULTS",
                content: "cache_ttl=5m",
            });
            saveEmbedding(db, memory.id, new Float32Array([0.1, 0.2]), "local:model-a");

            const initialCache = getProjectEmbeddings(db, "/repo/project", "local:model-a");
            expect(Array.from(initialCache.get(memory.id)?.embedding ?? [])).toEqual(
                Array.from(new Float32Array([0.1, 0.2])),
            );

            updateMemoryContent(
                db,
                memory.id,
                "cache_ttl=10m",
                computeNormalizedHash("cache_ttl=10m"),
            );

            const cacheAfterUpdate = getProjectEmbeddings(db, "/repo/project", "local:model-a");
            expect(cacheAfterUpdate.has(memory.id)).toBeFalse();

            const secondMemory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONFIG_DEFAULTS",
                content: "cache_ttl=15m",
            });
            saveEmbedding(db, secondMemory.id, new Float32Array([0.3, 0.4]), "local:model-a");

            const cacheAfterInsert = getProjectEmbeddings(db, "/repo/project", "local:model-a");
            expect(Array.from(cacheAfterInsert.keys())).toEqual([secondMemory.id]);

            deleteMemory(db, secondMemory.id);

            expect(getProjectEmbeddings(db, "/repo/project", "local:model-a")).toEqual(new Map());
        });
    });

    describe("#given FTS search", () => {
        it("#when searching matching content #then it returns project-scoped active memories", () => {
            db = makeMemoryDatabase();
            insertMemory(db, {
                projectPath: "/repo/project",
                category: "USER_DIRECTIVES",
                content: "Always run bun test before finishing",
            });
            const archived = insertMemory(db, {
                projectPath: "/repo/project",
                category: "WORKFLOW_RULES",
                content: "Always run bun test in old workflow",
            });
            insertMemory(db, {
                projectPath: "/repo/other",
                category: "USER_DIRECTIVES",
                content: "Always run bun test before release",
            });
            archiveMemory(db, archived.id);

            const matches = searchMemoriesFTS(db, "/repo/project", "bun");

            expect(matches).toHaveLength(1);
            expect(matches[0].projectPath).toBe("/repo/project");
            expect(matches[0].status).toBe("active");
        });

        it("#when memory content changes or is deleted #then FTS triggers stay in sync", () => {
            db = makeMemoryDatabase();
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONFIG_DEFAULTS",
                content: "Default cache ttl is 5m",
            });

            db.prepare("UPDATE memories SET content = ?, updated_at = ? WHERE id = ?").run(
                "Default cache ttl is 10m",
                Date.now(),
                memory.id,
            );

            expect(searchMemoriesFTS(db, "/repo/project", "10m")).toHaveLength(1);

            deleteMemory(db, memory.id);

            expect(searchMemoriesFTS(db, "/repo/project", "10m")).toEqual([]);
        });
    });

    it("#when workspace sharing is narrowed #then baseline delta watermark and FTS agree", () => {
        db = makeMemoryDatabase();
        const ownRule = insertMemory(db, {
            projectPath: "/repo/own",
            category: "PROJECT_RULES",
            content: "own rule needle",
        });
        const ownAlias = insertMemory(db, {
            projectPath: "/repo/own-legacy",
            category: "NAMING",
            content: "own legacy alias needle",
        });
        const foreignShared = insertMemory(db, {
            projectPath: "/repo/foreign",
            category: "CONSTRAINTS",
            content: "foreign shared needle",
        });
        const foreignHidden = insertMemory(db, {
            projectPath: "/repo/foreign",
            category: "NAMING",
            content: "foreign hidden needle",
        });
        const identities = ["/repo/own", "/repo/own-legacy", "/repo/foreign"];
        const ownIdentities = ["/repo/own", "/repo/own-legacy"];

        const sharedArgs = [ownIdentities, ["CONSTRAINTS"]] as const;
        const visibleIds = getMemoriesByProjects(
            db,
            identities,
            ["active", "permanent"],
            Date.now(),
            ...sharedArgs,
        )
            .map((memory) => memory.id)
            .sort((left, right) => left - right);
        expect(visibleIds).toEqual([ownRule.id, ownAlias.id, foreignShared.id]);
        expect(
            readNewMemoriesForM1Union(db, identities, ownRule.id, Date.now(), ...sharedArgs)
                .map((memory) => memory.id)
                .sort((left, right) => left - right),
        ).toEqual([ownAlias.id, foreignShared.id]);
        expect(getMaxMemoryIdForProjects(db, identities, ...sharedArgs)).toBe(foreignShared.id);
        expect(
            searchMemoriesFTSUnion(db, identities, "needle", 10, ...sharedArgs)
                .map((memory) => memory.id)
                .sort((left, right) => left - right),
        ).toEqual([ownRule.id, ownAlias.id, foreignShared.id]);

        const ownOnlyArgs = [ownIdentities, []] as const;
        expect(
            getMemoriesByProjects(
                db,
                identities,
                ["active", "permanent"],
                Date.now(),
                ...ownOnlyArgs,
            )
                .map((memory) => memory.id)
                .sort((left, right) => left - right),
        ).toEqual([ownRule.id, ownAlias.id]);
        expect(getMaxMemoryIdForProjects(db, identities, ...ownOnlyArgs)).toBe(ownAlias.id);

        const allIds = getMemoriesByProjects(
            db,
            identities,
            ["active", "permanent"],
            Date.now(),
            ownIdentities,
            null,
        )
            .map((memory) => memory.id)
            .sort((left, right) => left - right);
        expect(allIds).toEqual([ownRule.id, ownAlias.id, foreignShared.id, foreignHidden.id]);
        expect(getMaxMemoryIdForProjects(db, identities, ownIdentities, null)).toBe(
            foreignHidden.id,
        );
    });

    describe("#given embedding storage", () => {
        it("#when saving, loading, and deleting embeddings #then blob values round-trip by project", () => {
            db = makeMemoryDatabase();
            const memoryA = insertMemory(db, {
                projectPath: "/repo/project",
                category: "NAMING",
                content: "Prefer createMemoryStore naming",
            });
            const memoryB = insertMemory(db, {
                projectPath: "/repo/other",
                category: "NAMING",
                content: "Prefer createOther naming",
            });

            saveEmbedding(db, memoryA.id, new Float32Array([0.25, 0.5, 0.75]), "local:model-a");
            saveEmbedding(db, memoryB.id, new Float32Array([1, 2, 3]), "local:model-a");

            const embeddings = loadAllEmbeddings(db, "/repo/project", "local:model-a");

            expect(Array.from(embeddings.keys())).toEqual([memoryA.id]);
            expect(Array.from(embeddings.get(memoryA.id)?.embedding ?? [])).toEqual([
                0.25, 0.5, 0.75,
            ]);
            expect(getStoredModelId(db, "/repo/project")).toBe("local:model-a");

            deleteEmbedding(db, memoryA.id);

            expect(loadAllEmbeddings(db, "/repo/project", "local:model-a")).toEqual(new Map());
        });

        it("#when clearing all embeddings #then stored vectors and model id are removed", () => {
            db = makeMemoryDatabase();
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "NAMING",
                content: "Prefer createMemoryStore naming",
            });

            saveEmbedding(db, memory.id, new Float32Array([0.25, 0.5, 0.75]), "local:model-b");

            clearEmbeddingsForProject(db, "/repo/project");

            expect(loadAllEmbeddings(db, "/repo/project", "local:model-b")).toEqual(new Map());
            expect(getStoredModelId(db, "/repo/project")).toBeNull();
        });

        it("#when clearing embeddings for one project #then other projects' embeddings are preserved", () => {
            db = makeMemoryDatabase();
            const memoryA = insertMemory(db, {
                projectPath: "/repo/project-a",
                category: "NAMING",
                content: "Project A naming",
            });
            const memoryB = insertMemory(db, {
                projectPath: "/repo/project-b",
                category: "NAMING",
                content: "Project B naming",
            });

            saveEmbedding(db, memoryA.id, new Float32Array([1, 2, 3]), "local:model-x");
            saveEmbedding(db, memoryB.id, new Float32Array([4, 5, 6]), "local:model-x");

            clearEmbeddingsForProject(db, "/repo/project-a");

            expect(loadAllEmbeddings(db, "/repo/project-a", "local:model-x")).toEqual(new Map());
            expect(getStoredModelId(db, "/repo/project-a")).toBeNull();
            expect(loadAllEmbeddings(db, "/repo/project-b", "local:model-x").size).toBe(1);
            expect(getStoredModelId(db, "/repo/project-b")).toBe("local:model-x");
        });
    });

    describe("#given count and delete operations", () => {
        it("#when counting and deleting memories #then counts reflect scope changes", () => {
            db = makeMemoryDatabase();
            const memoryA = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "No as any",
            });
            insertMemory(db, {
                projectPath: "/repo/project",
                category: "USER_PREFERENCES",
                content: "Answer densely",
            });
            insertMemory(db, {
                projectPath: "/repo/other",
                category: "ENVIRONMENT",
                content: "Uses Bun 1.3",
            });

            expect(getMemoryCount(db)).toBe(3);
            expect(getMemoryCount(db, "/repo/project")).toBe(2);

            deleteMemory(db, memoryA.id);

            expect(getMemoryCount(db)).toBe(2);
            expect(getMemoryById(db, memoryA.id)).toBeNull();
        });
    });
});

describe("getMemoriesByRequestedIds", () => {
    let scoped: Database;

    function makeFullSchemaDatabase(): Database {
        const database = new Database(":memory:");
        initializeDatabase(database);
        return database;
    }

    afterEach(() => {
        closeQuietly(scoped);
    });

    function seedVisibilityMatrix(scopedDatabase: Database) {
        const own = insertMemory(scopedDatabase, {
            projectPath: "git:own",
            category: "CONSTRAINTS",
            content: "own active row",
        });
        const ownArchived = insertMemory(scopedDatabase, {
            projectPath: "git:own",
            category: "CONSTRAINTS",
            content: "own archived row",
        });
        scopedDatabase
            .prepare("UPDATE memories SET status = 'archived' WHERE id = ?")
            .run(ownArchived.id);
        const foreignShared = insertMemory(scopedDatabase, {
            projectPath: "git:foreign",
            category: "CONSTRAINTS",
            content: "foreign shared row",
        });
        const foreignWrongCategory = insertMemory(scopedDatabase, {
            projectPath: "git:foreign",
            category: "NAMING",
            content: "foreign wrong category row",
        });
        const foreignArchived = insertMemory(scopedDatabase, {
            projectPath: "git:foreign",
            category: "CONSTRAINTS",
            content: "foreign archived row",
        });
        const foreignExpired = insertMemory(scopedDatabase, {
            projectPath: "git:foreign",
            category: "CONSTRAINTS",
            content: "foreign expired row",
        });
        const foreignUnshareable = insertMemory(scopedDatabase, {
            projectPath: "git:foreign",
            category: "CONSTRAINTS",
            content: "foreign unshareable row",
        });
        const foreignPrivate = insertMemory(scopedDatabase, {
            projectPath: "git:foreign",
            category: "CONSTRAINTS",
            content: "foreign private row",
        });
        const setShareable = scopedDatabase.prepare(
            "UPDATE memories SET shareable = ? WHERE id = ?",
        );
        setShareable.run(1, foreignShared.id);
        setShareable.run(1, foreignWrongCategory.id);
        setShareable.run(1, foreignArchived.id);
        setShareable.run(1, foreignExpired.id);
        setShareable.run(0, foreignUnshareable.id);
        setShareable.run(1, foreignPrivate.id);
        scopedDatabase
            .prepare("UPDATE memories SET status = 'archived' WHERE id = ?")
            .run(foreignArchived.id);
        scopedDatabase
            .prepare("UPDATE memories SET expires_at = 1 WHERE id = ?")
            .run(foreignExpired.id);
        scopedDatabase
            .prepare("UPDATE memories SET scope = 'private' WHERE id = ?")
            .run(foreignPrivate.id);
        return {
            own: own.id,
            ownArchived: ownArchived.id,
            foreignShared: foreignShared.id,
            foreignWrongCategory: foreignWrongCategory.id,
            foreignArchived: foreignArchived.id,
            foreignExpired: foreignExpired.id,
            foreignUnshareable: foreignUnshareable.id,
            foreignPrivate: foreignPrivate.id,
        };
    }

    const workspaceScope = {
        identities: ["git:own", "git:foreign"],
        ownIdentities: ["git:own"],
        shareCategories: ["CONSTRAINTS"],
        statuses: ["active", "permanent", "archived"] as const,
    };

    it("returns requested ids in caller order, keeping duplicates", () => {
        scoped = makeFullSchemaDatabase();
        const seeded = seedVisibilityMatrix(scoped);

        const resolved = getMemoriesByRequestedIds(scoped, {
            ids: [seeded.foreignShared, 9999, seeded.ownArchived, seeded.foreignShared],
            identities: workspaceScope.identities,
            ownIdentities: workspaceScope.ownIdentities,
            shareCategories: workspaceScope.shareCategories,
            statuses: [...workspaceScope.statuses],
        });

        expect(resolved.map((memory) => memory.id)).toEqual([
            seeded.foreignShared,
            seeded.ownArchived,
            seeded.foreignShared,
        ]);
    });

    it("hides foreign rows that fail any visibility rule and keeps own archived rows", () => {
        scoped = makeFullSchemaDatabase();
        const seeded = seedVisibilityMatrix(scoped);

        const resolved = getMemoriesByRequestedIds(scoped, {
            ids: [
                seeded.own,
                seeded.ownArchived,
                seeded.foreignShared,
                seeded.foreignWrongCategory,
                seeded.foreignArchived,
                seeded.foreignExpired,
                seeded.foreignUnshareable,
                seeded.foreignPrivate,
            ],
            identities: workspaceScope.identities,
            ownIdentities: workspaceScope.ownIdentities,
            shareCategories: workspaceScope.shareCategories,
            statuses: [...workspaceScope.statuses],
            expiryCutoff: Date.now(),
        });

        expect(resolved.map((memory) => memory.id)).toEqual([
            seeded.own,
            seeded.ownArchived,
            seeded.foreignShared,
        ]);
    });

    it("returns [] for an empty id list without running a lookup", () => {
        scoped = makeFullSchemaDatabase();
        seedVisibilityMatrix(scoped);
        const counter = countingDatabase(scoped);

        expect(
            getMemoriesByRequestedIds(counter.db, {
                ids: [],
                identities: ["git:own"],
                statuses: ["active", "permanent", "archived"],
            }),
        ).toEqual([]);
        expect(counter.count("FROM memories")).toBe(0);
        expect(counter.count("json_each")).toBe(0);
    });

    it("reaches memories through the integer primary key with no full table scan", () => {
        scoped = makeFullSchemaDatabase();
        const seeded = seedVisibilityMatrix(scoped);
        const captured: string[] = [];
        const spy = new Proxy(scoped, {
            get(target, prop) {
                if (prop === "prepare") {
                    return (sql: string) => {
                        captured.push(sql);
                        return target.prepare(sql);
                    };
                }
                const value = (target as unknown as Record<string | symbol, unknown>)[prop];
                return typeof value === "function" ? value.bind(target) : value;
            },
        }) as Database;

        getMemoriesByRequestedIds(spy, {
            ids: [seeded.own, seeded.foreignShared],
            identities: workspaceScope.identities,
            ownIdentities: workspaceScope.ownIdentities,
            shareCategories: workspaceScope.shareCategories,
            statuses: [...workspaceScope.statuses],
        });

        const lookupSql = captured.find((sql) => sql.includes("json_each"));
        expect(lookupSql).toBeDefined();
        const plan = scoped
            .prepare(`EXPLAIN QUERY PLAN ${lookupSql}`)
            .all(
                JSON.stringify([seeded.own, seeded.foreignShared]),
                "git:own",
                "active",
                "permanent",
                "archived",
                Date.now(),
                "git:foreign",
                Date.now(),
                "CONSTRAINTS",
            ) as Array<{ detail: string }>;
        const detail = plan.map((row) => row.detail).join(" | ");
        expect(detail).toContain("USING INTEGER PRIMARY KEY");
        expect(detail).not.toContain("SCAN memories");
    });
});

// ---------------------------------------------------------------------------
// U1 characterization: the pre-v84 memory mutation inventory over the REAL
// migrated v82 schema. These tests lock in the exact current base-row, stats,
// FTS, embedding, and side-table effects of every legacy semantic writer so
// the v84 claims kernel (U2-U6) can be proven behavior-preserving. Do not
// "fix" a surprising assertion here — it is the contract being preserved.
// ---------------------------------------------------------------------------
describe("migrated-v82 mutation inventory characterization", () => {
    let migrated: Database;

    function migratedDb(): Database {
        const database = new Database(":memory:");
        database.exec("PRAGMA foreign_keys=ON");
        initializeDatabase(database);
        runMigrations(database);
        return database;
    }

    function baseRow(database: Database, id: number): Record<string, unknown> | null {
        return (database.prepare("SELECT * FROM memories WHERE id = ?").get(id) ?? null) as Record<
            string,
            unknown
        > | null;
    }

    function statsRow(database: Database, id: number): Record<string, unknown> | null {
        return (database.prepare("SELECT * FROM memory_stats WHERE memory_id = ?").get(id) ??
            null) as Record<string, unknown> | null;
    }

    afterEach(() => {
        if (migrated) closeQuietly(migrated);
    });

    it("insert: one base row with defaults, one trigger-created stats row, FTS visibility", () => {
        migrated = migratedDb();
        const memory = insertMemory(migrated, {
            projectPath: "git:v82-charter",
            category: "CONSTRAINTS",
            content: "Inserted characterization fact",
            sourceSessionId: "ses-charter",
            nowMs: 1_000,
        });

        expect(baseRow(migrated, memory.id)).toEqual({
            id: memory.id,
            project_path: "git:v82-charter",
            category: "CONSTRAINTS",
            content: "Inserted characterization fact",
            normalized_hash: computeNormalizedHash("Inserted characterization fact"),
            importance: 50,
            scope: "project",
            shareable: 0,
            source_session_id: "ses-charter",
            source_type: "historian",
            seen_count: 1,
            retrieval_count: 0,
            first_seen_at: 1_000,
            created_at: 1_000,
            updated_at: 1_000,
            last_seen_at: 1_000,
            last_retrieved_at: null,
            status: "active",
            expires_at: null,
            verification_status: "unverified",
            verified_at: null,
            classified_at: null,
            superseded_by_memory_id: null,
            merged_from: null,
            metadata_json: null,
            mural_cue: null,
            mural_cue_hash: null,
            mural_cue_at: null,
            mural_cue_rejection_count: 0,
        });
        expect(statsRow(migrated, memory.id)).toEqual({
            memory_id: memory.id,
            seen_count: 1,
            retrieval_count: 0,
            last_seen_at: 1_000,
            last_retrieved_at: null,
            updated_at: 1_000,
        });
        expect(
            searchMemoriesFTS(migrated, "git:v82-charter", "characterization").map((m) => m.id),
        ).toEqual([memory.id]);
    });

    it("duplicate: idempotent re-insert bumps stats seen_count only; direct insert throws UNIQUE", () => {
        migrated = migratedDb();
        const first = insertMemory(migrated, {
            projectPath: "git:v82-charter",
            category: "NAMING",
            content: "Duplicate FACT wording",
            nowMs: 1_000,
        });
        const baseBefore = JSON.stringify(baseRow(migrated, first.id));

        const dup = insertMemoryIdempotent(migrated, {
            projectPath: "git:v82-charter",
            category: "NAMING",
            // Same normalized hash: case and whitespace differences collapse.
            content: "duplicate   fact WORDING",
            nowMs: 2_000,
        });

        expect(dup.inserted).toBeFalse();
        expect(dup.memory.id).toBe(first.id);
        expect(dup.memory.seenCount).toBe(2);
        // The base row is byte-identical: telemetry lives in memory_stats.
        expect(JSON.stringify(baseRow(migrated, first.id))).toBe(baseBefore);
        expect(statsRow(migrated, first.id)?.seen_count).toBe(2);
        expect((statsRow(migrated, first.id)?.last_seen_at as number) > 1_000).toBeTrue();

        expect(() =>
            insertMemory(migrated, {
                projectPath: "git:v82-charter",
                category: "NAMING",
                content: "duplicate fact wording",
            }),
        ).toThrow(/UNIQUE/);
        expect(getMemoryCount(migrated, "git:v82-charter")).toBe(1);
    });

    it("update: content rewrite resets shareable/classified_at/mural cue and embedding, keeps verification", () => {
        migrated = migratedDb();
        const memory = insertMemory(migrated, {
            projectPath: "git:v82-charter",
            category: "CONFIG_DEFAULTS",
            content: "cache_ttl=5m",
            nowMs: 1_000,
        });
        saveEmbedding(migrated, memory.id, new Float32Array([0.5, 0.25]), "local:model-a");
        // Fixture seeding of pre-existing semantic state must hold the v84
        // claims-write capability; the guards reject bare semantic UPDATEs.
        runInMemoryClaimsWriteTransaction(migrated, () => {
            migrated
                .prepare(
                    `UPDATE memories SET shareable = 1, classified_at = 111, verification_status = 'verified',
                        verified_at = 222, mural_cue = 'cue', mural_cue_hash = 'cuehash', mural_cue_at = 333,
                        mural_cue_rejection_count = 2
                      WHERE id = ?`,
                )
                .run(memory.id);
        });

        updateMemoryContent(
            migrated,
            memory.id,
            "cache_ttl=10m",
            computeNormalizedHash("cache_ttl=10m"),
        );

        const row = baseRow(migrated, memory.id);
        expect(row?.content).toBe("cache_ttl=10m");
        expect(row?.normalized_hash).toBe(computeNormalizedHash("cache_ttl=10m"));
        expect((row?.updated_at as number) > 1_000).toBeTrue();
        // Classification judgements were made against the OLD content: reset.
        expect(row?.shareable).toBe(0);
        expect(row?.classified_at).toBeNull();
        expect(row?.mural_cue).toBeNull();
        expect(row?.mural_cue_hash).toBeNull();
        expect(row?.mural_cue_at).toBeNull();
        expect(row?.mural_cue_rejection_count).toBe(0);
        // Verification state is NOT reset by a content update in v82.
        expect(row?.verification_status).toBe("verified");
        expect(row?.verified_at).toBe(222);
        // The stale vector is dropped; stats stay untouched.
        expect(loadAllEmbeddings(migrated, "git:v82-charter", "local:model-a")).toEqual(new Map());
        expect(statsRow(migrated, memory.id)?.seen_count).toBe(1);
        expect(statsRow(migrated, memory.id)?.updated_at).toBe(1_000);
    });

    it("archive: status-only without a reason, metadata archive_reason merge with one", () => {
        migrated = migratedDb();
        const plain = insertMemory(migrated, {
            projectPath: "git:v82-charter",
            category: "KNOWN_ISSUES",
            content: "archive me plain",
            nowMs: 1_000,
        });
        const reasoned = insertMemory(migrated, {
            projectPath: "git:v82-charter",
            category: "KNOWN_ISSUES",
            content: "archive me with reason",
            metadataJson: JSON.stringify({ origin: "fixture" }),
            nowMs: 1_000,
        });

        archiveMemory(migrated, plain.id);
        archiveMemory(migrated, reasoned.id, "  superseded by pipeline  ");

        const plainRow = baseRow(migrated, plain.id);
        expect(plainRow?.status).toBe("archived");
        expect(plainRow?.metadata_json).toBeNull();
        const reasonedRow = baseRow(migrated, reasoned.id);
        expect(reasonedRow?.status).toBe("archived");
        // Reason is trimmed and merged into existing metadata keys.
        expect(JSON.parse(reasonedRow?.metadata_json as string)).toEqual({
            origin: "fixture",
            archive_reason: "superseded by pipeline",
        });
        // Archiving a missing id is a silent no-op in both shapes.
        archiveMemory(migrated, 424_242);
        archiveMemory(migrated, 424_242, "reason");
    });

    it("status: repeated unkeyed writes on an unadoptable row persist no claim operations; a keyed write does", () => {
        migrated = migratedDb();
        const memory = insertMemory(migrated, {
            projectPath: "/legacy/raw-ephemeral",
            category: "CONSTRAINTS",
            content: "raw path fact",
            nowMs: 1_000,
        });
        const operations = () =>
            (
                migrated.prepare("SELECT COUNT(*) AS count FROM claim_operations").get() as {
                    count: number;
                }
            ).count;
        // The unadoptable insert itself is zero-effect, so its random-key
        // envelope persists no operation row.
        expect(operations()).toBe(0);

        updateMemoryStatus(migrated, memory.id, "permanent");
        updateMemoryStatus(migrated, memory.id, "active");
        expect(operations()).toBe(0);

        // A caller-supplied durable key keeps the replay contract.
        updateMemoryStatus(migrated, memory.id, "archived", {
            producer: "storage-memory",
            operationKey: "status-keyed-1",
        });
        expect(operations()).toBe(1);
    });

    it("delete: removes base row, cascades stats/embeddings/verifications, clears FTS", () => {
        migrated = migratedDb();
        const memory = insertMemory(migrated, {
            projectPath: "git:v82-charter",
            category: "ENVIRONMENT",
            content: "delete cascade target",
            nowMs: 1_000,
        });
        saveEmbedding(migrated, memory.id, new Float32Array([1, 2]), "local:model-a");
        recordMemoryVerifications(migrated, memory.id, ["src/a.ts"], 2_000);

        deleteMemory(migrated, memory.id);

        expect(baseRow(migrated, memory.id)).toBeNull();
        expect(statsRow(migrated, memory.id)).toBeNull();
        expect(loadAllEmbeddings(migrated, "git:v82-charter", "local:model-a")).toEqual(new Map());
        expect(getMemoryVerifications(migrated, [memory.id]).size).toBe(0);
        expect(searchMemoriesFTS(migrated, "git:v82-charter", "cascade")).toEqual([]);
    });

    it("merge: supersededMemory archives with a pointer; mergeMemoryStats SETS counters and is stats-atomic", () => {
        migrated = migratedDb();
        const canonical = insertMemory(migrated, {
            projectPath: "git:v82-charter",
            category: "PROJECT_RULES",
            content: "canonical merged wording",
            nowMs: 1_000,
        });
        const source = insertMemory(migrated, {
            projectPath: "git:v82-charter",
            category: "PROJECT_RULES",
            content: "source wording",
            nowMs: 1_000,
        });

        supersededMemory(migrated, source.id, canonical.id);
        const sourceRow = baseRow(migrated, source.id);
        expect(sourceRow?.status).toBe("archived");
        expect(sourceRow?.superseded_by_memory_id).toBe(canonical.id);

        mergeMemoryStats(migrated, canonical.id, 7, 3, JSON.stringify([source.id]), "permanent");
        const canonicalRow = baseRow(migrated, canonical.id);
        expect(canonicalRow?.merged_from).toBe(JSON.stringify([source.id]));
        expect(canonicalRow?.status).toBe("permanent");
        // Counters are assigned (the caller pre-computes the merged totals),
        // and last-seen/retrieved event timestamps stay untouched.
        expect(statsRow(migrated, canonical.id)).toEqual({
            memory_id: canonical.id,
            seen_count: 7,
            retrieval_count: 3,
            last_seen_at: 1_000,
            last_retrieved_at: null,
            updated_at: statsRow(migrated, canonical.id)?.updated_at,
        });

        // A base row without a stats row is v80 corruption: the base write
        // must roll back rather than committing a merged marker alone.
        migrated.prepare("DELETE FROM memory_stats WHERE memory_id = ?").run(canonical.id);
        const beforeFailure = JSON.stringify(baseRow(migrated, canonical.id));
        expect(() => mergeMemoryStats(migrated, canonical.id, 9, 9, "[999]", "active")).toThrow(
            MemoryStatsIntegrityError,
        );
        expect(JSON.stringify(baseRow(migrated, canonical.id))).toBe(beforeFailure);
    });

    it("mapping vs verification: mapped-only rows keep verified_at=0; verify stamps it; base column is separate", () => {
        migrated = migratedDb();
        const memory = insertMemory(migrated, {
            projectPath: "git:v82-charter",
            category: "ARCHITECTURE_DECISIONS",
            content: "mapping target",
            nowMs: 1_000,
        });

        // MAP: files known, NOT content-verified (verified_at stays 0).
        expect(
            recordMemoryMapping(migrated, memory.id, ["src/b.ts", "src/a.ts", "src/a.ts"], 5_000),
        ).toBe(2);
        let state = getMemoryVerifications(migrated, [memory.id]).get(memory.id);
        expect(state).toEqual({
            files: ["src/a.ts", "src/b.ts"],
            hasSentinel: false,
            verifiedAt: 0,
            mappedAt: 5_000,
        });

        // MAP with no real files writes the "" sentinel row.
        expect(recordMemoryMapping(migrated, memory.id, [], 6_000)).toBe(1);
        state = getMemoryVerifications(migrated, [memory.id]).get(memory.id);
        expect(state).toEqual({ files: [], hasSentinel: true, verifiedAt: 0, mappedAt: 6_000 });

        // VERIFY replaces the side-table rows and stamps verified_at.
        expect(recordMemoryVerifications(migrated, memory.id, ["src/a.ts"], 7_000)).toBe(1);
        state = getMemoryVerifications(migrated, [memory.id]).get(memory.id);
        expect(state).toEqual({
            files: ["src/a.ts"],
            hasSentinel: false,
            verifiedAt: 7_000,
            mappedAt: 7_000,
        });

        // The base-column status is a separate surface: verified stamps
        // verified_at; a later non-verified status keeps the old stamp.
        updateMemoryVerification(migrated, memory.id, "verified");
        const verifiedAt = baseRow(migrated, memory.id)?.verified_at as number;
        expect(verifiedAt).toBeGreaterThan(0);
        updateMemoryVerification(migrated, memory.id, "stale");
        expect(baseRow(migrated, memory.id)?.verification_status).toBe("stale");
        expect(baseRow(migrated, memory.id)?.verified_at).toBe(verifiedAt);
    });

    it("classification builds exact metadata for pre-v84 and v84 no-op/all-field updates", () => {
        const preV84 = migratedDb();
        dropMemoryClaimsCompatObjectsForTests(preV84);
        migrated = migratedDb();
        try {
            const legacy = insertMemory(preV84, {
                projectPath: "git:classification-parity",
                category: "CONSTRAINTS",
                content: "legacy classification fact",
            });
            const claims = insertMemory(migrated, {
                projectPath: "git:classification-parity",
                category: "CONSTRAINTS",
                content: "claims classification fact",
            });
            const v84CountsBefore = {
                revisions: (
                    migrated.prepare("SELECT COUNT(*) AS count FROM claim_revisions").get() as {
                        count: number;
                    }
                ).count,
                outbox: (
                    migrated.prepare("SELECT COUNT(*) AS count FROM claim_change_outbox").get() as {
                        count: number;
                    }
                ).count,
            };

            expect(
                setMemoryClassification(preV84, legacy.id, {
                    importance: 50,
                    scope: "project",
                    shareable: false,
                }),
            ).toBeFalse();
            expect(
                setMemoryClassification(migrated, claims.id, {
                    importance: 50,
                    scope: "project",
                    shareable: false,
                }),
            ).toBeFalse();
            expect(migrated.prepare("SELECT COUNT(*) AS count FROM claim_revisions").get()).toEqual(
                { count: v84CountsBefore.revisions },
            );
            expect(
                migrated.prepare("SELECT COUNT(*) AS count FROM claim_change_outbox").get(),
            ).toEqual({ count: v84CountsBefore.outbox });

            const allFields = {
                importance: 91,
                scope: "ecosystem" as const,
                shareable: true,
            };
            expect(setMemoryClassification(preV84, legacy.id, allFields)).toBeTrue();
            expect(setMemoryClassification(migrated, claims.id, allFields)).toBeTrue();
            for (const [database, id] of [
                [preV84, legacy.id],
                [migrated, claims.id],
            ] as const) {
                expect(
                    database
                        .prepare("SELECT importance, scope, shareable FROM memories WHERE id = ?")
                        .get(id),
                ).toEqual({ importance: 91, scope: "ecosystem", shareable: 1 });
            }
            expect(getCurrentMemoryClaimByLegacyMemoryId(migrated, claims.id)).toMatchObject({
                revision: 2,
                importance: 91,
                memoryScope: "ecosystem",
                shareable: 1,
            });
        } finally {
            closeQuietly(preV84);
        }
    });

    it("identity repair: rekey moves project_path in place; a collision merges stats and deletes the source", () => {
        migrated = migratedDb();
        const plain = insertMemory(migrated, {
            projectPath: "/legacy/raw-path",
            category: "CONSTRAINTS",
            content: "plain rekey row",
            nowMs: 1_000,
        });
        const source = insertMemory(migrated, {
            projectPath: "/legacy/raw-path",
            category: "NAMING",
            content: "collision wording",
            nowMs: 1_000,
        });
        const target = insertMemory(migrated, {
            projectPath: "git:canonical",
            category: "NAMING",
            content: "Collision   WORDING",
            nowMs: 1_000,
        });
        migrated
            .prepare("UPDATE memory_stats SET seen_count = 5 WHERE memory_id = ?")
            .run(source.id);
        saveEmbedding(migrated, source.id, new Float32Array([9, 9]), "local:model-a");

        migrated.transaction(() => {
            // Plain rekey: same row id, new identity, everything else intact.
            expect(
                rekeyMemoryRowWithCollisionMerge(
                    migrated,
                    plain.id,
                    "/legacy/raw-path",
                    "git:canonical",
                ),
            ).toBeTrue();
            // Collision merge: target keeps the larger seen_count, adopts the
            // orphaned embedding, and the source row is deleted.
            expect(
                rekeyMemoryRowWithCollisionMerge(
                    migrated,
                    source.id,
                    "/legacy/raw-path",
                    "git:canonical",
                ),
            ).toBeTrue();
        })();

        const plainRow = baseRow(migrated, plain.id);
        expect(plainRow?.project_path).toBe("git:canonical");
        expect(plainRow?.content).toBe("plain rekey row");
        expect(baseRow(migrated, source.id)).toBeNull();
        expect(statsRow(migrated, target.id)?.seen_count).toBe(5);
        const adopted = loadAllEmbeddings(migrated, "git:canonical", "local:model-a");
        expect(Array.from(adopted.keys())).toEqual([target.id]);
        expect(getMemoryCount(migrated, "/legacy/raw-path")).toBe(0);
    });
});
