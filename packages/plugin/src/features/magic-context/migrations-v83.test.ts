/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    clearClaimsBackfillFailpoints,
    setClaimsBackfillCalibrationForTests,
    setClaimsBackfillFailpoint,
} from "./claims-backfill";
import {
    createMemoryWithClaimsInCurrentTransaction,
    ensureMemoryClaimLinkInCurrentTransaction,
    runInMemoryClaimsWriteTransaction,
} from "./memory/storage-memory-claims";
import { readMemoryProjectionRow } from "./memory/storage-memory-projection";
import { LATEST_MIGRATION_VERSION, runMigrations } from "./migrations";
import { initializeDatabase, schemaVersionIsSupported } from "./storage-db";
import {
    APPEND_ONLY_MEMORY_CLAIMS_TABLES,
    CLAIMS_BACKFILL_META_KEYS,
    MEMORY_CLAIMS_COMPAT_TABLES,
} from "./storage-memory-claims-schema";

function migratedDb(): Database {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

/** A legacy database carrying pre-v83 memories: rows inserted BEFORE the
 *  migration chain runs, so v83 records them under its high-water boundary. */
function v82DatabaseWithRows(
    contents: readonly string[],
    projectPath = "git:v83-fixture",
): Database {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    initializeDatabase(db);
    const insert = db.prepare(
        `INSERT INTO memories (project_path, category, content, normalized_hash,
            seen_count, retrieval_count, first_seen_at, created_at, updated_at, last_seen_at)
         VALUES (?, 'CONSTRAINTS', ?, ?, 1, 0, 1, 1, 1, 1)`,
    );
    for (const content of contents) {
        insert.run(projectPath, content, `hash:${content}`);
    }
    runMigrations(db);
    return db;
}

function metaValue(db: Database, key: string): string | null {
    const row = db.prepare("SELECT value FROM schema_migrations_meta WHERE key = ?").get(key) as
        | { value: string }
        | undefined;
    return row?.value ?? null;
}

function v83ObjectRows(db: Database): Array<Record<string, unknown>> {
    const tables = new Set<string>(MEMORY_CLAIMS_COMPAT_TABLES);
    return (
        db
            .prepare(
                "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
            )
            .all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>
    ).filter((row) => tables.has(row.tbl_name) || row.name.startsWith("memories_claims_"));
}

describe("migration v83: memories-to-claims compatibility contract", () => {
    afterEach(() => {
        clearClaimsBackfillFailpoints();
        setClaimsBackfillCalibrationForTests(null);
    });
    test("a fresh database and a v82-upgraded database publish identical v83 objects and one version row", () => {
        const fresh = migratedDb();
        const upgraded = v82DatabaseWithRows(["carried row"]);
        try {
            for (const table of MEMORY_CLAIMS_COMPAT_TABLES) {
                expect(
                    fresh
                        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?")
                        .get(table),
                ).toBeTruthy();
            }
            expect(v83ObjectRows(upgraded)).toEqual(v83ObjectRows(fresh));
            for (const db of [fresh, upgraded]) {
                expect(
                    db
                        .prepare(
                            "SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 83",
                        )
                        .get(),
                ).toEqual({ count: 1 });
            }
            expect(LATEST_MIGRATION_VERSION).toBe(83);
        } finally {
            closeQuietly(fresh);
            closeQuietly(upgraded);
        }
    });

    test("an empty corpus completes synchronously; a nonempty v82 corpus records pending lazy state", () => {
        const fresh = migratedDb();
        const upgraded = v82DatabaseWithRows(["row one", "row two"]);
        try {
            expect(metaValue(fresh, CLAIMS_BACKFILL_META_KEYS.mode)).toBe("empty");
            expect(metaValue(fresh, CLAIMS_BACKFILL_META_KEYS.phase)).toBe("complete");
            expect(metaValue(fresh, CLAIMS_BACKFILL_META_KEYS.boundaryMemoryId)).toBe("0");
            expect(metaValue(fresh, CLAIMS_BACKFILL_META_KEYS.expectedRowCount)).toBe("0");
            expect(metaValue(fresh, CLAIMS_BACKFILL_META_KEYS.reconciliationVersion)).toBe("1");
            expect(metaValue(fresh, CLAIMS_BACKFILL_META_KEYS.finalOutboxWatermark)).toBe("0");

            expect(metaValue(upgraded, CLAIMS_BACKFILL_META_KEYS.mode)).toBe("lazy");
            expect(metaValue(upgraded, CLAIMS_BACKFILL_META_KEYS.phase)).toBe("rows");
            expect(metaValue(upgraded, CLAIMS_BACKFILL_META_KEYS.boundaryMemoryId)).toBe("2");
            expect(metaValue(upgraded, CLAIMS_BACKFILL_META_KEYS.expectedRowCount)).toBe("2");
            expect(metaValue(upgraded, CLAIMS_BACKFILL_META_KEYS.reconciliationVersion)).toBeNull();
        } finally {
            closeQuietly(fresh);
            closeQuietly(upgraded);
        }
    });

    test("forced eager conversion and reconciliation stay in the migration transaction", () => {
        const db = new Database(":memory:");
        db.exec("PRAGMA foreign_keys=ON");
        initializeDatabase(db);
        db.exec(`
            CREATE TABLE IF NOT EXISTS schema_migrations_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            INSERT OR REPLACE INTO schema_migrations_meta (key, value)
            VALUES ('v22_legacy_memory_backfill', 'completed');
        `);
        db.prepare(
            `INSERT INTO memories (project_path, category, content, normalized_hash,
                first_seen_at, created_at, updated_at, last_seen_at)
             VALUES ('git:eager-rollback', 'CONSTRAINTS', 'eager row', 'eager-hash', 1, 1, 1, 1)`,
        ).run();
        setClaimsBackfillCalibrationForTests({
            cutoffRows: 1,
            evidenceDigest: "e".repeat(64),
        });
        setClaimsBackfillFailpoint("claims-migration.020.rows.after", () => {
            throw new Error("eager migration cut");
        });
        try {
            expect(() => runMigrations(db)).toThrow(/eager migration cut/);
            expect(
                db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'legacy_memory_claims'").get(),
            ).toBeNull();
            expect(
                db.prepare("SELECT 1 FROM schema_migrations WHERE version = 83").get(),
            ).toBeNull();

            clearClaimsBackfillFailpoints();
            runMigrations(db);
            expect(metaValue(db, CLAIMS_BACKFILL_META_KEYS.mode)).toBe("eager");
            expect(metaValue(db, CLAIMS_BACKFILL_META_KEYS.phase)).toBe("complete");
            expect(db.prepare("SELECT COUNT(*) AS count FROM legacy_memory_claims").get()).toEqual({
                count: 1,
            });
        } finally {
            closeQuietly(db);
        }
    });

    test("v83 takes over v22 pending state even when the claims corpus is already complete", () => {
        const db = migratedDb();
        try {
            expect(metaValue(db, CLAIMS_BACKFILL_META_KEYS.mode)).toBe("empty");
            expect(metaValue(db, CLAIMS_BACKFILL_META_KEYS.phase)).toBe("complete");
            expect(metaValue(db, CLAIMS_BACKFILL_META_KEYS.v22Takeover)).toBe("pending");
        } finally {
            closeQuietly(db);
        }
    });

    test("a replayed v83 no-ops over its published schema; a partial schema refuses", () => {
        const db = migratedDb();
        try {
            db.prepare("DELETE FROM schema_migrations WHERE version = 83").run();
            runMigrations(db);
            expect(
                db
                    .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 83")
                    .get(),
            ).toEqual({ count: 1 });

            db.prepare("DELETE FROM schema_migrations WHERE version = 83").run();
            db.exec("DROP TABLE claim_backfill_failures");
            expect(() => runMigrations(db)).toThrow(/replay guard/);
        } finally {
            closeQuietly(db);
        }
    });

    test("AE8: held-open v82-shaped semantic statements are rejected; telemetry and mural-cue writes stay permitted", () => {
        const db = v82DatabaseWithRows(["held open target"]);
        try {
            const memoryId = (db.prepare("SELECT id FROM memories LIMIT 1").get() as { id: number })
                .id;
            const before = db.prepare("SELECT * FROM memories WHERE id = ?").get(memoryId);
            expect(() =>
                db
                    .prepare(
                        `INSERT INTO memories (project_path, category, content, normalized_hash,
                            first_seen_at, created_at, updated_at, last_seen_at)
                         VALUES ('git:v83-fixture', 'NAMING', 'held-open insert', 'hash:ho', 1, 1, 1, 1)`,
                    )
                    .run(),
            ).toThrow(/claims-write kernel/);
            expect(() =>
                db.prepare("UPDATE memories SET content = 'drifted' WHERE id = ?").run(memoryId),
            ).toThrow(/claims-write kernel/);
            expect(() =>
                db
                    .prepare(
                        "INSERT INTO memory_verifications (memory_id, file_path, verified_at, mapped_at) VALUES (?, 'src/a.ts', 1, 1)",
                    )
                    .run(memoryId),
            ).toThrow(/claims-write kernel/);
            expect(() => db.prepare("DELETE FROM memories WHERE id = ?").run(memoryId)).toThrow(
                /claims-write kernel|crosswalk link before delete/,
            );
            expect(db.prepare("SELECT * FROM memories WHERE id = ?").get(memoryId)).toEqual(before);
            expect(db.prepare("SELECT COUNT(*) AS count FROM claim_change_outbox").get()).toEqual({
                count: 0,
            });

            // Telemetry and derived-cache writes remain outside the guard.
            db.prepare(
                "UPDATE memory_stats SET seen_count = seen_count + 1, last_seen_at = 2, updated_at = 2 WHERE memory_id = ?",
            ).run(memoryId);
            db.prepare(
                "UPDATE memories SET mural_cue = 'cue', mural_cue_hash = 'ch', mural_cue_at = 3 WHERE id = ?",
            ).run(memoryId);
            db.prepare("UPDATE memories SET classified_at = 4 WHERE id = ?").run(memoryId);
        } finally {
            closeQuietly(db);
        }
    });

    test("a boundary-row delete or identity move without a crosswalk is rejected, then succeeds after transaction-local adoption", () => {
        const db = v82DatabaseWithRows(["boundary member"]);
        try {
            const memoryId = (db.prepare("SELECT id FROM memories LIMIT 1").get() as { id: number })
                .id;
            expect(() =>
                runInMemoryClaimsWriteTransaction(db, () => {
                    db.prepare("DELETE FROM memories WHERE id = ?").run(memoryId);
                }),
            ).toThrow(/crosswalk link before delete/);
            expect(() =>
                runInMemoryClaimsWriteTransaction(db, () => {
                    db.prepare(
                        "UPDATE memories SET project_path = 'git:elsewhere' WHERE id = ?",
                    ).run(memoryId);
                }),
            ).toThrow(/crosswalk link before identity moves/);

            runInMemoryClaimsWriteTransaction(db, () => {
                const row = readMemoryProjectionRow(db, memoryId);
                if (!row) throw new Error("boundary row missing");
                const projectId = (
                    db
                        .prepare(
                            "SELECT project_id AS id FROM project_aliases WHERE alias_identity = ?",
                        )
                        .get("git:v83-fixture") as { id: number }
                ).id;
                ensureMemoryClaimLinkInCurrentTransaction(db, row, projectId, {
                    kind: "migration",
                });
                db.prepare("DELETE FROM memories WHERE id = ?").run(memoryId);
            });
            expect(db.prepare("SELECT COUNT(*) AS count FROM memories").get()).toEqual({
                count: 0,
            });
            // The durable non-cascading link survives the projection delete (R1).
            expect(
                db
                    .prepare(
                        "SELECT COUNT(*) AS count FROM legacy_memory_claims WHERE memory_id = ?",
                    )
                    .get(memoryId),
            ).toEqual({ count: 1 });
        } finally {
            closeQuietly(db);
        }
    });

    test("a v82 binary refuses a v83 database through the schema fence", () => {
        const db = migratedDb();
        try {
            expect(schemaVersionIsSupported(db, 82)).toBeFalse();
            expect(schemaVersionIsSupported(db, 83)).toBeTrue();
        } finally {
            closeQuietly(db);
        }
    });

    test("the v83 compatibility tables are append-only and generations are monotonic", () => {
        const db = migratedDb();
        try {
            const outcome = runInMemoryClaimsWriteTransaction(db, () =>
                createMemoryWithClaimsInCurrentTransaction(
                    db,
                    {
                        producer: "v83-test",
                        operationKey: "append-only-seed",
                        requestDigest: "a".repeat(64),
                    },
                    {
                        projectPath: "git:v83-append",
                        category: "CONSTRAINTS",
                        content: "append-only seed",
                        normalizedHash: "hash:seed",
                    },
                ),
            );
            expect(outcome.result.claimId).not.toBeNull();

            for (const table of APPEND_ONLY_MEMORY_CLAIMS_TABLES) {
                const count = (
                    db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
                        count: number;
                    }
                ).count;
                if (count === 0) continue;
                expect(() => db.prepare(`DELETE FROM ${table}`).run()).toThrow(/append-only/);
            }
            expect(() =>
                db.prepare("UPDATE claim_operations SET result_json = '\"forged\"'").run(),
            ).toThrow(/immutable/);
            expect(() =>
                db
                    .prepare("UPDATE claim_project_generations SET generation = generation - 0")
                    .run(),
            ).toThrow(/monotonically/);
            expect(() => db.prepare("DELETE FROM claim_project_generations").run()).toThrow(
                /cannot be deleted/,
            );
            // INSERT OR REPLACE cannot slip past the delete guard.
            expect(() =>
                db
                    .prepare(
                        `INSERT OR REPLACE INTO legacy_memory_claims
                            (memory_id, canonical_memory_id, claim_id, project_id, root_observation_id, created_at)
                         SELECT memory_id, canonical_memory_id, claim_id, project_id, root_observation_id, 999
                           FROM legacy_memory_claims LIMIT 1`,
                    )
                    .run(),
            ).toThrow(/append-only/);
        } finally {
            closeQuietly(db);
        }
    });

    test("duplicate crosswalk links must resolve to the canonical claim and project", () => {
        const db = migratedDb();
        try {
            const outcome = runInMemoryClaimsWriteTransaction(db, () =>
                createMemoryWithClaimsInCurrentTransaction(
                    db,
                    {
                        producer: "v83-test",
                        operationKey: "dup-link-seed",
                        requestDigest: "b".repeat(64),
                    },
                    {
                        projectPath: "git:v83-dup",
                        category: "CONSTRAINTS",
                        content: "duplicate link seed",
                        normalizedHash: "hash:dup",
                    },
                ),
            );
            const link = db
                .prepare("SELECT * FROM legacy_memory_claims WHERE memory_id = ?")
                .get(outcome.result.memoryId) as Record<string, number>;
            // A duplicate link naming a nonexistent canonical row fails closed.
            expect(() =>
                db
                    .prepare(
                        `INSERT INTO legacy_memory_claims
                            (memory_id, canonical_memory_id, claim_id, project_id, root_observation_id, created_at)
                         VALUES (999, 998, ?, ?, ?, 1)`,
                    )
                    .run(link.claim_id, link.project_id, link.root_observation_id),
            ).toThrow(/canonical claim and project/);
            // A valid duplicate pointing at the existing canonical row links.
            db.prepare(
                `INSERT INTO legacy_memory_claims
                    (memory_id, canonical_memory_id, claim_id, project_id, root_observation_id, created_at)
                 VALUES (999, ?, ?, ?, ?, 1)`,
            ).run(link.memory_id, link.claim_id, link.project_id, link.root_observation_id);
        } finally {
            closeQuietly(db);
        }
    });
});
