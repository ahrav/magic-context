import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import {
    copyMemoriesToProject,
    moveMemoriesToProject,
    rekeyMemoryRowWithCollisionMerge,
    selectRelocatableMemoryIds,
} from "./relocate-memory";
import { insertMemory } from "./storage-memory";
import {
    getCurrentMemoryClaimByLegacyMemoryId,
    memoryClaimSupersessionExists,
    readMemoryClaimLink,
    runInMemoryClaimsWriteTransaction,
} from "./storage-memory-claims";

let db: Database | null = null;

function makeDb(): Database {
    db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

/** Direct projection insert without a claim crosswalk link. */
function insertUnlinkedMemory(
    database: Database,
    projectPath: string,
    content: string,
    hash: string,
): number {
    return runInMemoryClaimsWriteTransaction(database, () => {
        const result = database
            .prepare(
                `INSERT INTO memories
                    (project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at)
                 VALUES (?, 'CONSTRAINTS', ?, ?, 1, 1, 1, 1)`,
            )
            .run(projectPath, content, hash) as { lastInsertRowid: number | bigint };
        return Number(result.lastInsertRowid);
    });
}

function inTransaction<T>(database: Database, fn: () => T): T {
    return database.transaction(fn).immediate();
}

afterEach(() => {
    if (db) closeQuietly(db);
    db = null;
});

describe("relocate-memory claims (v84)", () => {
    test("rekeying an unlinked row adopts its claim under the target project before the identity move", () => {
        const database = makeDb();
        const rowId = insertUnlinkedMemory(database, "/raw/legacy/path", "raw fact", "rk-h1");

        const changed = inTransaction(database, () =>
            rekeyMemoryRowWithCollisionMerge(database, rowId, "/raw/legacy/path", "git:resolved"),
        );

        expect(changed).toBe(true);
        expect(
            database.prepare("SELECT project_path FROM memories WHERE id = ?").get(rowId),
        ).toEqual({ project_path: "git:resolved" });
        const current = getCurrentMemoryClaimByLegacyMemoryId(database, rowId);
        expect(current?.content).toBe("raw fact");
        expect(
            database
                .prepare("SELECT canonical_identity FROM projects WHERE id = ?")
                .get(current?.projectId ?? 0),
        ).toEqual({ canonical_identity: "git:resolved" });
    });

    test("a rekey onto the linked row's own numeric project keeps the claim untouched", () => {
        const database = makeDb();
        const memory = insertMemory(database, {
            projectPath: "git:stable",
            category: "CONSTRAINTS",
            content: "stable fact",
        });
        // Both identities resolve to the same numeric project.
        database
            .prepare(
                `INSERT INTO project_aliases (alias_identity, project_id, created_at)
                 SELECT 'git:alias-of-stable', project_id, 1 FROM project_aliases
                  WHERE alias_identity = 'git:stable'`,
            )
            .run();
        const linkBefore = readMemoryClaimLink(database, memory.id);

        const changed = inTransaction(database, () =>
            rekeyMemoryRowWithCollisionMerge(
                database,
                memory.id,
                "git:stable",
                "git:alias-of-stable",
            ),
        );

        expect(changed).toBe(true);
        expect(readMemoryClaimLink(database, memory.id)).toEqual(linkBefore);
        expect(database.prepare("SELECT COUNT(*) AS c FROM claims").get()).toEqual({ c: 1 });
    });

    test("a collision request cannot move a row owned by another source project", () => {
        const database = makeDb();
        insertMemory(database, {
            projectPath: "git:project-b",
            category: "CONSTRAINTS",
            content: "equivalent relocation fact",
        });
        const sourceC = insertMemory(database, {
            projectPath: "git:project-c",
            category: "CONSTRAINTS",
            content: "equivalent relocation fact",
        });
        const before = JSON.stringify({
            memories: database.prepare("SELECT * FROM memories ORDER BY id").all(),
            links: database.prepare("SELECT * FROM legacy_memory_claims ORDER BY memory_id").all(),
            claims: database.prepare("SELECT * FROM claims ORDER BY id").all(),
            generations: database
                .prepare("SELECT * FROM claim_project_generations ORDER BY project_id")
                .all(),
        });

        const changed = inTransaction(database, () =>
            rekeyMemoryRowWithCollisionMerge(
                database,
                sourceC.id,
                "git:project-a",
                "git:project-b",
            ),
        );

        expect(changed).toBeFalse();
        expect(
            JSON.stringify({
                memories: database.prepare("SELECT * FROM memories ORDER BY id").all(),
                links: database
                    .prepare("SELECT * FROM legacy_memory_claims ORDER BY memory_id")
                    .all(),
                claims: database.prepare("SELECT * FROM claims ORDER BY id").all(),
                generations: database
                    .prepare("SELECT * FROM claim_project_generations ORDER BY project_id")
                    .all(),
            }),
        ).toBe(before);
    });

    test("a collision merge selects one canonical claim, links the deleted source, and preserves stats", () => {
        const database = makeDb();
        const target = insertMemory(database, {
            projectPath: "git:shared",
            category: "CONSTRAINTS",
            content: "shared fact",
        });
        const targetHash = (
            database
                .prepare("SELECT normalized_hash AS hash FROM memories WHERE id = ?")
                .get(target.id) as { hash: string }
        ).hash;
        const sourceId = insertUnlinkedMemory(
            database,
            "/raw/twin/path",
            "shared fact",
            targetHash,
        );
        database
            .prepare("UPDATE memory_stats SET seen_count = 6 WHERE memory_id = ?")
            .run(sourceId);

        const changed = inTransaction(database, () =>
            rekeyMemoryRowWithCollisionMerge(database, sourceId, "/raw/twin/path", "git:shared"),
        );

        expect(changed).toBe(true);
        expect(
            database.prepare("SELECT COUNT(*) AS c FROM memories WHERE id = ?").get(sourceId),
        ).toEqual({ c: 0 });
        expect(
            database
                .prepare("SELECT seen_count FROM memory_stats WHERE memory_id = ?")
                .get(target.id),
        ).toEqual({ seen_count: 6 });
        const links = database
            .prepare(
                "SELECT memory_id, canonical_memory_id, claim_id FROM legacy_memory_claims ORDER BY memory_id",
            )
            .all() as Array<{ memory_id: number; canonical_memory_id: number; claim_id: number }>;
        expect(links).toEqual([
            { memory_id: target.id, canonical_memory_id: target.id, claim_id: links[0].claim_id },
            { memory_id: sourceId, canonical_memory_id: target.id, claim_id: links[0].claim_id },
        ]);
        expect(database.prepare("SELECT COUNT(*) AS c FROM claims").get()).toEqual({ c: 1 });
    });

    test("an authorized cross-project move creates the target claim and retires the source claim with lineage", () => {
        const database = makeDb();
        const source = insertMemory(database, {
            projectPath: "git:project-a",
            category: "CONSTRAINTS",
            content: "moving fact",
        });
        // A source sibling that references the moving row keeps referencing
        // the replacement row after the move mints a fresh row id.
        const pointer = insertMemory(database, {
            projectPath: "git:project-a",
            category: "CONSTRAINTS",
            content: "pointing fact",
        });
        runInMemoryClaimsWriteTransaction(database, () => {
            database
                .prepare("UPDATE memories SET superseded_by_memory_id = ? WHERE id = ?")
                .run(source.id, pointer.id);
            database
                .prepare(
                    "INSERT INTO memory_verifications (memory_id, file_path, verified_at, mapped_at) VALUES (?, 'src/moved.ts', 0, 7)",
                )
                .run(source.id);
        });
        insertMemory(database, {
            projectPath: "git:project-b",
            category: "CONSTRAINTS",
            content: "resident fact",
        });
        const sourceLink = readMemoryClaimLink(database, source.id);

        const result = inTransaction(database, () =>
            moveMemoriesToProject(database, [source.id], "git:project-a", "git:project-b"),
        );

        expect(result).toEqual({ relocated: 1, merged: 0, skipped: 0 });
        expect(
            database.prepare("SELECT COUNT(*) AS c FROM memories WHERE id = ?").get(source.id),
        ).toEqual({ c: 0 });
        const moved = database
            .prepare(
                "SELECT id FROM memories WHERE project_path = 'git:project-b' AND content = 'moving fact'",
            )
            .get() as { id: number };
        expect(moved).toBeDefined();
        expect(
            database
                .prepare(
                    "SELECT file_path, mapped_at FROM memory_verifications WHERE memory_id = ?",
                )
                .all(moved.id),
        ).toEqual([{ file_path: "src/moved.ts", mapped_at: 7 }]);
        expect(
            database
                .prepare("SELECT superseded_by_memory_id AS s FROM memories WHERE id = ?")
                .get(pointer.id),
        ).toEqual({ s: moved.id });
        expect(
            database.prepare("SELECT state FROM claims WHERE id = ?").get(sourceLink?.claimId ?? 0),
        ).toEqual({ state: "archived" });
        const movedClaim = getCurrentMemoryClaimByLegacyMemoryId(database, moved.id);
        expect(movedClaim?.state).toBe("active");
        expect(movedClaim?.content).toBe("moving fact");
        expect(movedClaim?.claimId).not.toBe(sourceLink?.claimId);
        expect(database.prepare("SELECT COUNT(*) AS c FROM claim_merge_lineage").get()).toEqual({
            c: 2,
        });
    });

    test("a cross-project move translates the moved row's inherited lineage", () => {
        const database = makeDb();
        const lineageSource = insertMemory(database, {
            projectPath: "git:project-a",
            category: "CONSTRAINTS",
            content: "lineage source fact",
        });
        const moving = insertMemory(database, {
            projectPath: "git:project-a",
            category: "CONSTRAINTS",
            content: "lineage carrier fact",
        });
        runInMemoryClaimsWriteTransaction(database, () => {
            database
                .prepare("UPDATE memories SET merged_from = ? WHERE id = ?")
                .run(JSON.stringify([lineageSource.id]), moving.id);
        });
        // The target numeric project must exist for the authorized move path.
        insertMemory(database, {
            projectPath: "git:project-b",
            category: "CONSTRAINTS",
            content: "resident fact",
        });

        const result = inTransaction(database, () =>
            moveMemoriesToProject(database, [moving.id], "git:project-a", "git:project-b"),
        );

        expect(result).toEqual({ relocated: 1, merged: 0, skipped: 0 });
        const moved = database
            .prepare(
                "SELECT id, merged_from FROM memories WHERE project_path = 'git:project-b' AND content = 'lineage carrier fact'",
            )
            .get() as { id: number; merged_from: string };
        expect(moved.merged_from).toBe(JSON.stringify([lineageSource.id]));
        const movedLink = readMemoryClaimLink(database, moved.id);
        const lineageLink = readMemoryClaimLink(database, lineageSource.id);
        if (!movedLink || !lineageLink) throw new Error("expected claim links after the move");
        expect(
            database
                .prepare(
                    "SELECT merged_from, superseded_by_memory_id FROM claim_memory_relationship_sources WHERE memory_id = ?",
                )
                .all(moved.id),
        ).toEqual([
            {
                merged_from: JSON.stringify([lineageSource.id]),
                superseded_by_memory_id: null,
            },
        ]);
        expect(memoryClaimSupersessionExists(database, lineageLink, movedLink)).toBe(true);
        // The moved row must be mutable: the relationship guard aborts a
        // lineage-column change unless a matching relationship source exists.
        expect(() =>
            runInMemoryClaimsWriteTransaction(database, () => {
                database
                    .prepare("UPDATE memories SET merged_from = NULL WHERE id = ?")
                    .run(moved.id);
            }),
        ).not.toThrow();
    });

    test("copying creates a target claim for each fresh row and leaves the source intact", () => {
        const database = makeDb();
        const source = insertMemory(database, {
            projectPath: "git:project-a",
            category: "CONSTRAINTS",
            content: "copied fact",
        });
        const ids = selectRelocatableMemoryIds(database, "git:project-a");

        const result = inTransaction(database, () =>
            copyMemoriesToProject(database, ids, "git:project-b"),
        );

        expect(result).toEqual({ relocated: 1, merged: 0, skipped: 0 });
        const copied = database
            .prepare("SELECT id FROM memories WHERE project_path = 'git:project-b'")
            .get() as { id: number };
        expect(copied).toBeDefined();
        const sourceClaim = getCurrentMemoryClaimByLegacyMemoryId(database, source.id);
        const copiedClaim = getCurrentMemoryClaimByLegacyMemoryId(database, copied.id);
        expect(sourceClaim?.state).toBe("active");
        expect(copiedClaim?.state).toBe("active");
        expect(copiedClaim?.claimId).not.toBe(sourceClaim?.claimId);
        expect(copiedClaim?.content).toBe("copied fact");
    });

    test("a pre-v84 database keeps the plain rekey behavior", () => {
        const database = new Database(":memory:");
        db = database;
        database.exec(`
            CREATE TABLE memories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_path TEXT NOT NULL,
                category TEXT NOT NULL,
                content TEXT NOT NULL,
                normalized_hash TEXT NOT NULL,
                seen_count INTEGER DEFAULT 1,
                status TEXT DEFAULT 'active',
                source_session_id TEXT,
                UNIQUE(project_path, category, normalized_hash)
            );
            CREATE TABLE memory_embeddings (
                memory_id INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
                embedding BLOB NOT NULL,
                model_id TEXT
            );
        `);
        database
            .prepare(
                "INSERT INTO memories (project_path, category, content, normalized_hash) VALUES ('git:old', 'CONSTRAINTS', 'legacy fact', 'lg-h1')",
            )
            .run();

        const changed = inTransaction(database, () =>
            rekeyMemoryRowWithCollisionMerge(database, 1, "git:old", "git:new"),
        );

        expect(changed).toBe(true);
        expect(database.prepare("SELECT project_path FROM memories WHERE id = 1").get()).toEqual({
            project_path: "git:new",
        });
    });

    test("a non-canonical relocation target throws instead of silently skipping claim work", () => {
        const database = makeDb();
        const memory = insertMemory(database, {
            projectPath: "git:origin",
            category: "CONSTRAINTS",
            content: "anchored fact",
        });

        expect(() =>
            inTransaction(database, () =>
                rekeyMemoryRowWithCollisionMerge(database, memory.id, "git:origin", "/raw/target"),
            ),
        ).toThrow(/does not resolve to a canonical git:\/dir: project/);
        expect(() =>
            inTransaction(database, () =>
                copyMemoriesToProject(database, [memory.id], "/raw/target"),
            ),
        ).toThrow(/does not resolve to a canonical git:\/dir: project/);

        // The rolled-back transactions leave the row where it was.
        expect(
            database.prepare("SELECT project_path FROM memories WHERE id = ?").get(memory.id),
        ).toEqual({ project_path: "git:origin" });
        expect(database.prepare("SELECT COUNT(*) AS c FROM memories").get()).toEqual({ c: 1 });
    });
});
