import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { ProjectIdentityError } from "./memory/project-identity";
import { runInMemoryClaimsWriteTransaction } from "./memory/storage-memory-claims";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";
import { getProjectState } from "./storage-project-state";
import {
    BATCH_SIZE,
    computeLegacyRustDirIdentity,
    runDeferredV22Backfill,
} from "./v22-deferred-backfill";

let db: Database | null = null;
const tempDirs: string[] = [];

function makeDb(): Database {
    db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function makeTempDir(prefix = "mc-v22-backfill-"): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

function insertMemory(database: Database, projectPath: string, normalizedHash: string): number {
    return runInMemoryClaimsWriteTransaction(database, () => {
        const result = database
            .prepare(
                `INSERT INTO memories
                (project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at)
             VALUES (?, 'CONSTRAINTS', ?, ?, 1, 1, 1, 1)`,
            )
            .run(projectPath, `content-${normalizedHash}`, normalizedHash) as {
            lastInsertRowid: number;
        };
        return Number(result.lastInsertRowid);
    });
}

function metaValue(database: Database, key: string): string | null {
    const row = database
        .prepare("SELECT value FROM schema_migrations_meta WHERE key = ?")
        .get(key) as { value: string } | undefined;
    return row?.value ?? null;
}

afterEach(() => {
    if (db) {
        closeQuietly(db);
        db = null;
    }
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe("runDeferredV22Backfill", () => {
    test("empty table completes without error", async () => {
        const database = makeDb();

        const summary = await runDeferredV22Backfill(database, {
            yieldToEventLoop: async () => {},
        });

        expect(summary.status).toBe("completed");
        expect(summary.changedRows).toBe(0);
        expect(metaValue(database, "v22_legacy_memory_backfill")).toBe("completed");
    });

    test("converts 100 legacy rows, records rekey maps, bumps each distinct identity once, and batches at 25", async () => {
        const database = makeDb();
        for (let i = 0; i < 100; i += 1) {
            insertMemory(database, `/legacy/project-${i}`, `hash-${i}`);
        }
        const batchSizes: number[] = [];

        const summary = await runDeferredV22Backfill(database, {
            resolveIdentity: (raw) => `git:${raw.split("-").at(-1)}`,
            yieldToEventLoop: async () => {},
            onBatchResolved: (batch) => {
                batchSizes.push(batch.length);
            },
        });

        expect(summary.changedRows).toBe(100);
        expect(batchSizes).toEqual([BATCH_SIZE, BATCH_SIZE, BATCH_SIZE, BATCH_SIZE]);
        const unresolved = database
            .prepare(
                "SELECT COUNT(*) AS count FROM memories WHERE project_path NOT LIKE 'git:%' AND project_path NOT LIKE 'dir:%'",
            )
            .get() as { count: number };
        expect(unresolved.count).toBe(0);
        const mapCount = database
            .prepare("SELECT COUNT(*) AS count FROM v22_identity_rekey_map")
            .get() as { count: number };
        expect(mapCount.count).toBeGreaterThanOrEqual(100);
        const epochs = database
            .prepare("SELECT project_memory_epoch FROM project_state ORDER BY project_path")
            .all() as Array<{ project_memory_epoch: number }>;
        expect(epochs).toHaveLength(100);
        expect(epochs.every((row) => row.project_memory_epoch === 1)).toBe(true);
    });

    test("falls back to dir identity for accessible non-git rows", async () => {
        const database = makeDb();
        const dir = makeTempDir();
        insertMemory(database, dir, "non-git");

        await runDeferredV22Backfill(database, { yieldToEventLoop: async () => {} });

        const row = database.prepare("SELECT project_path FROM memories").get() as {
            project_path: string;
        };
        expect(row.project_path).toMatch(/^dir:[0-9a-f]{12}$/);
        expect(getProjectState(database, row.project_path)?.projectMemoryEpoch).toBe(1);
    });

    test("records resolver failures and advances the cursor", async () => {
        const database = makeDb();
        const failedId = insertMemory(database, "/denied", "denied");
        const okId = insertMemory(database, "/ok", "ok");

        const summary = await runDeferredV22Backfill(database, {
            resolveIdentity: (raw) => {
                if (raw === "/denied") {
                    throw new ProjectIdentityError("permission_denied", raw, "permission denied");
                }
                return "git:ok";
            },
            yieldToEventLoop: async () => {},
        });

        expect(summary.status).toBe("completed_with_failures");
        expect(metaValue(database, "v22_legacy_memory_backfill_cursor")).toBe(String(okId));
        const failure = database
            .prepare("SELECT row_id, error_class FROM v22_backfill_failures")
            .get() as { row_id: number; error_class: string };
        expect(failure).toEqual({ row_id: failedId, error_class: "permission_denied" });
    });

    test("merges (does not abort) when two legacy paths collide on (category, normalized_hash) under one identity", async () => {
        // Regression: two raw legacy paths for the SAME project (e.g. a symlinked
        // path and the canonical path) both resolve to one git: identity and share
        // a (category, normalized_hash). A blind UPDATE would trip
        // UNIQUE(project_path, category, normalized_hash) and abort the batch.
        const database = makeDb();
        const firstId = insertMemory(database, "/proj/canonical", "dup-hash");
        const secondId = insertMemory(database, "/proj/symlinked", "dup-hash");
        // Give the second (later) row a higher seen_count to verify merge keeps max.
        database
            .prepare("UPDATE memory_stats SET seen_count = 9 WHERE memory_id = ?")
            .run(secondId);

        const summary = await runDeferredV22Backfill(database, {
            resolveIdentity: () => "git:sharedidentity",
            yieldToEventLoop: async () => {},
        });

        // Must complete cleanly, not "completed_with_failures" from a constraint abort.
        expect(summary.status).toBe("completed");
        // Exactly one surviving row under the shared identity.
        const survivors = database
            .prepare(
                "SELECT m.id, s.seen_count FROM memories m JOIN memory_stats s ON s.memory_id = m.id WHERE m.project_path = 'git:sharedidentity' AND m.normalized_hash = 'dup-hash'",
            )
            .all() as Array<{ id: number; seen_count: number }>;
        expect(survivors).toHaveLength(1);
        // The earlier row survives (UPDATE'd first); seen_count merged to the max (9).
        expect(survivors[0].id).toBe(firstId);
        expect(survivors[0].seen_count).toBe(9);
        // No legacy rows remain.
        const unresolved = database
            .prepare(
                "SELECT COUNT(*) AS count FROM memories WHERE project_path NOT LIKE 'git:%' AND project_path NOT LIKE 'dir:%'",
            )
            .get() as { count: number };
        expect(unresolved.count).toBe(0);
    });

    test("collision-merge preserves the source row's embedding on the survivor (no FK-cascade loss)", async () => {
        // Regression: when a legacy source row carrying an embedding collides with
        // an existing target row that has NONE, the merge deletes the source —
        // FK-cascading its embedding away. Without the INSERT OR IGNORE transfer,
        // the survivor would be left unembedded (silent vector loss). The DB is
        // initialized with foreign_keys=ON, so the cascade is real here.
        const database = makeDb();
        const targetId = insertMemory(database, "/proj/canonical", "dup-hash");
        const sourceId = insertMemory(database, "/proj/symlinked", "dup-hash");
        // Only the SOURCE (later-deleted) row has an embedding.
        database
            .prepare(
                "INSERT INTO memory_embeddings (memory_id, embedding, model_id) VALUES (?, ?, 'm')",
            )
            .run(sourceId, new Uint8Array([1, 2, 3, 4]));

        const summary = await runDeferredV22Backfill(database, {
            resolveIdentity: () => "git:sharedidentity",
            yieldToEventLoop: async () => {},
        });

        expect(summary.status).toBe("completed");
        // Source row gone; survivor is the earlier (target) row. (.get() returns
        // null on node:sqlite / undefined on bun:sqlite for a missing row.)
        expect(
            database.prepare("SELECT id FROM memories WHERE id = ?").get(sourceId) ?? null,
        ).toBeNull();
        // The survivor must now carry the adopted embedding — not lost to cascade.
        const surviving = database
            .prepare("SELECT COUNT(*) AS c FROM memory_embeddings WHERE memory_id = ?")
            .get(targetId) as { c: number };
        expect(surviving.c).toBe(1);
        // And no orphaned embedding rows remain anywhere.
        const total = database.prepare("SELECT COUNT(*) AS c FROM memory_embeddings").get() as {
            c: number;
        };
        expect(total.c).toBe(1);
    });

    test("concurrent project_path mutation is a guarded no-op", async () => {
        const database = makeDb();
        const rowId = insertMemory(database, "/race", "race");

        const summary = await runDeferredV22Backfill(database, {
            resolveIdentity: () => "git:resolved-after-race",
            yieldToEventLoop: async () => {},
            onBatchResolved: () => {
                database
                    .prepare("UPDATE memories SET project_path = 'git:concurrent' WHERE id = ?")
                    .run(rowId);
            },
        });

        expect(summary.changedRows).toBe(0);
        const row = database
            .prepare("SELECT project_path FROM memories WHERE id = ?")
            .get(rowId) as {
            project_path: string;
        };
        expect(row.project_path).toBe("git:concurrent");
        expect(getProjectState(database, "git:resolved-after-race")).toBeNull();
    });

    test("computes legacy Rust dir identities for explicit rekeying", () => {
        const dir = makeTempDir();
        expect(computeLegacyRustDirIdentity(dir)).toMatch(/^dir:[0-9a-f]{64}$/);
    });
});

describe("v22 backfill under the v83 claims contract", () => {
    function makeV82StyleDb(rows: Array<{ projectPath: string; content: string; hash: string }>): {
        database: Database;
        ids: number[];
    } {
        // Rows inserted BEFORE the migration chain runs sit at or below the
        // v83 high-water boundary, so their identity moves and deletes are
        // fenced by the boundary guards until they acquire crosswalk links.
        const database = new Database(":memory:");
        db = database;
        database.exec("PRAGMA foreign_keys=ON");
        initializeDatabase(database);
        const ids: number[] = [];
        for (const row of rows) {
            const result = database
                .prepare(
                    `INSERT INTO memories
                        (project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at)
                     VALUES (?, 'CONSTRAINTS', ?, ?, 1, 1, 1, 1)`,
                )
                .run(row.projectPath, row.content, row.hash) as {
                lastInsertRowid: number | bigint;
            };
            ids.push(Number(result.lastInsertRowid));
        }
        runMigrations(database);
        return { database, ids };
    }

    test("boundary rows adopt claims before the identity move and a clean run resolves the v83 takeover", async () => {
        const { database, ids } = makeV82StyleDb([
            { projectPath: "/legacy/one", content: "unique fact", hash: "v22-h1" },
        ]);
        expect(metaValue(database, "claims_backfill_v22_takeover")).toBe("pending");

        const summary = await runDeferredV22Backfill(database, {
            resolveIdentity: () => "git:resolved",
            yieldToEventLoop: async () => {},
        });

        expect(summary.status).toBe("completed");
        expect(
            database.prepare("SELECT project_path FROM memories WHERE id = ?").get(ids[0]),
        ).toEqual({ project_path: "git:resolved" });
        const link = database
            .prepare(
                "SELECT memory_id, canonical_memory_id, claim_id, project_id FROM legacy_memory_claims WHERE memory_id = ?",
            )
            .get(ids[0]) as { claim_id: number; project_id: number };
        expect(link).toBeDefined();
        expect(
            database
                .prepare("SELECT canonical_identity FROM projects WHERE id = ?")
                .get(link.project_id),
        ).toEqual({ canonical_identity: "git:resolved" });
        expect(
            database
                .prepare("SELECT content FROM claim_revisions WHERE claim_id = ?")
                .all(link.claim_id),
        ).toEqual([{ content: "unique fact" }]);
        expect(metaValue(database, "claims_backfill_v22_takeover")).toBe("none");
    });

    test("a rekey collision selects one canonical claim and projection and records every source link", async () => {
        const { database, ids } = makeV82StyleDb([
            { projectPath: "/proj/canonical", content: "duplicate fact", hash: "dup-hash" },
            { projectPath: "/proj/symlinked", content: "duplicate fact", hash: "dup-hash" },
        ]);
        const [firstId, secondId] = ids as [number, number];
        database
            .prepare("UPDATE memory_stats SET seen_count = 9 WHERE memory_id = ?")
            .run(secondId);
        runInMemoryClaimsWriteTransaction(database, () => {
            database
                .prepare(
                    "INSERT INTO memory_verifications (memory_id, file_path, verified_at, mapped_at) VALUES (?, 'src/kept.ts', 5, 5)",
                )
                .run(firstId);
        });

        const summary = await runDeferredV22Backfill(database, {
            resolveIdentity: () => "git:sharedidentity",
            yieldToEventLoop: async () => {},
        });

        expect(summary.status).toBe("completed");
        // One canonical projection row survives with merged telemetry and its
        // retained verification mapping.
        const survivors = database
            .prepare(
                "SELECT m.id, s.seen_count FROM memories m JOIN memory_stats s ON s.memory_id = m.id WHERE m.normalized_hash = 'dup-hash'",
            )
            .all() as Array<{ id: number; seen_count: number }>;
        expect(survivors).toEqual([{ id: firstId, seen_count: 9 }]);
        expect(
            database
                .prepare("SELECT file_path FROM memory_verifications WHERE memory_id = ?")
                .all(firstId),
        ).toEqual([{ file_path: "src/kept.ts" }]);
        // One canonical claim; the deleted duplicate keeps its audit link.
        const links = database
            .prepare(
                "SELECT memory_id, canonical_memory_id, claim_id FROM legacy_memory_claims ORDER BY memory_id",
            )
            .all() as Array<{ memory_id: number; canonical_memory_id: number; claim_id: number }>;
        expect(links).toEqual([
            { memory_id: firstId, canonical_memory_id: firstId, claim_id: links[0].claim_id },
            { memory_id: secondId, canonical_memory_id: firstId, claim_id: links[0].claim_id },
        ]);
        expect(database.prepare("SELECT COUNT(*) AS c FROM claims").get()).toEqual({ c: 1 });
        expect(metaValue(database, "claims_backfill_v22_takeover")).toBe("none");
    });

    test("unresolved failures keep the v83 takeover pending", async () => {
        const { database } = makeV82StyleDb([
            { projectPath: "/denied", content: "blocked fact", hash: "blocked-h1" },
        ]);

        const summary = await runDeferredV22Backfill(database, {
            resolveIdentity: (raw) => {
                throw new ProjectIdentityError("permission_denied", raw, "permission denied");
            },
            yieldToEventLoop: async () => {},
        });

        expect(summary.status).toBe("completed_with_failures");
        expect(metaValue(database, "claims_backfill_v22_takeover")).toBe("pending");
    });
});
