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
    runMemoryClaimOperationInCurrentTransaction,
} from "./memory/storage-memory-claims";
import { readMemoryProjectionRow } from "./memory/storage-memory-projection";
import { LATEST_MIGRATION_VERSION, runMigrations } from "./migrations";
import { initializeDatabase, schemaVersionIsSupported } from "./storage-db";
import {
    APPEND_ONLY_MEMORY_CLAIMS_TABLES,
    CLAIMS_BACKFILL_META_KEYS,
    MEMORY_CLAIMS_COMPAT_TABLES,
    pruneClaimChangeLogInCurrentTransaction,
} from "./storage-memory-claims-schema";

function migratedDb(): Database {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

/** A legacy database carrying pre-v84 memories: rows inserted BEFORE the
 *  migration chain runs, so v84 records them under its high-water boundary. */
function v82DatabaseWithRows(
    contents: readonly string[],
    projectPath = "git:v84-fixture",
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

function v84ObjectRows(db: Database): Array<Record<string, unknown>> {
    const tables = new Set<string>(MEMORY_CLAIMS_COMPAT_TABLES);
    return (
        db
            .prepare(
                "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
            )
            .all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>
    ).filter((row) => tables.has(row.tbl_name) || row.name.startsWith("memories_claims_"));
}

describe("migration v84: memories-to-claims compatibility contract", () => {
    afterEach(() => {
        clearClaimsBackfillFailpoints();
        setClaimsBackfillCalibrationForTests(null);
    });
    test("a fresh database and a v82-upgraded database publish identical v84 objects and one version row", () => {
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
            expect(v84ObjectRows(upgraded)).toEqual(v84ObjectRows(fresh));
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

    test("v84 takes over v22 pending state even when the claims corpus is already complete", () => {
        const db = migratedDb();
        try {
            expect(metaValue(db, CLAIMS_BACKFILL_META_KEYS.mode)).toBe("empty");
            expect(metaValue(db, CLAIMS_BACKFILL_META_KEYS.phase)).toBe("complete");
            expect(metaValue(db, CLAIMS_BACKFILL_META_KEYS.v22Takeover)).toBe("pending");
        } finally {
            closeQuietly(db);
        }
    });

    test("a replayed v84 no-ops over its published schema; a partial schema refuses", () => {
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
                         VALUES ('git:v84-fixture', 'NAMING', 'held-open insert', 'hash:ho', 1, 1, 1, 1)`,
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

            const linked = runInMemoryClaimsWriteTransaction(db, () =>
                createMemoryWithClaimsInCurrentTransaction(
                    db,
                    {
                        producer: "v84-held-open",
                        operationKey: "linked-project-path",
                        requestDigest: "f".repeat(64),
                    },
                    {
                        projectPath: "git:v84-fixture",
                        category: "CONSTRAINTS",
                        content: "linked project path target",
                        normalizedHash: "hash:linked-project-path",
                    },
                ),
            );
            const linkedBefore = JSON.stringify(
                db.prepare("SELECT * FROM memories WHERE id = ?").get(linked.result.memoryId),
            );
            const tupleBefore = [
                "claim_operations",
                "claim_change_outbox",
                "claim_project_generations",
            ].map(
                (table) =>
                    (
                        db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
                            count: number;
                        }
                    ).count,
            );
            expect(() =>
                db
                    .prepare("UPDATE memories SET project_path = 'git:bare-bypass' WHERE id = ?")
                    .run(linked.result.memoryId),
            ).toThrow(/claims-write kernel/);
            expect(
                JSON.stringify(
                    db.prepare("SELECT * FROM memories WHERE id = ?").get(linked.result.memoryId),
                ),
            ).toBe(linkedBefore);
            expect(
                ["claim_operations", "claim_change_outbox", "claim_project_generations"].map(
                    (table) =>
                        (
                            db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
                                count: number;
                            }
                        ).count,
                ),
            ).toEqual(tupleBefore);

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
                        .get("git:v84-fixture") as { id: number }
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

    test("a v82 binary refuses a v84 database through the schema fence", () => {
        const db = migratedDb();
        try {
            expect(schemaVersionIsSupported(db, 82)).toBeFalse();
            expect(schemaVersionIsSupported(db, 83)).toBeTrue();
        } finally {
            closeQuietly(db);
        }
    });

    test("the v84 compatibility tables are append-only and generations are monotonic", () => {
        const db = migratedDb();
        try {
            const outcome = runInMemoryClaimsWriteTransaction(db, () =>
                createMemoryWithClaimsInCurrentTransaction(
                    db,
                    {
                        producer: "v84-test",
                        operationKey: "append-only-seed",
                        requestDigest: "a".repeat(64),
                    },
                    {
                        projectPath: "git:v84-append",
                        category: "CONSTRAINTS",
                        content: "append-only seed",
                        normalizedHash: "hash:seed",
                    },
                ),
            );
            expect(outcome.result.claimId).not.toBeNull();
            const other = runInMemoryClaimsWriteTransaction(db, () =>
                createMemoryWithClaimsInCurrentTransaction(
                    db,
                    {
                        producer: "v84-test",
                        operationKey: "outbox-project-guard",
                        requestDigest: "e".repeat(64),
                    },
                    {
                        projectPath: "git:v84-other-project",
                        category: "CONSTRAINTS",
                        content: "other project seed",
                        normalizedHash: "hash:other-project",
                    },
                ),
            );
            const operationId = (
                db
                    .prepare(
                        "SELECT id FROM claim_operations WHERE operation_key = 'append-only-seed'",
                    )
                    .get() as { id: number }
            ).id;
            const otherProjectId = (
                db
                    .prepare("SELECT project_id AS id FROM claims WHERE id = ?")
                    .get(other.result.claimId) as { id: number }
            ).id;
            expect(() =>
                db
                    .prepare(
                        `INSERT INTO claim_change_outbox
                            (operation_id, effect_key, project_id, claim_id, effect_type, generation, created_at)
                         VALUES (?, 'forged:wrong-project', ?, ?, 'upsert', 1, 1)`,
                    )
                    .run(operationId, otherProjectId, outcome.result.claimId),
            ).toThrow(/outbox project must match/);
            expect(() =>
                db
                    .prepare(
                        `INSERT INTO claim_change_outbox
                            (operation_id, effect_key, project_id, claim_id, effect_type, generation, created_at)
                         VALUES (?, 'forged:missing-claim', ?, 999999, 'upsert', 1, 1)`,
                    )
                    .run(operationId, otherProjectId),
            ).toThrow(/outbox project must match/);

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

    test("crosswalk REPLACE cannot move a canonical claim to a fresh memory id", () => {
        for (const recursiveTriggers of [0, 1]) {
            const db = migratedDb();
            try {
                db.exec(
                    recursiveTriggers === 0
                        ? "PRAGMA recursive_triggers=OFF"
                        : "PRAGMA recursive_triggers=ON",
                );
                const outcome = runInMemoryClaimsWriteTransaction(db, () =>
                    createMemoryWithClaimsInCurrentTransaction(
                        db,
                        {
                            producer: "v84-test",
                            operationKey: `replace-collision-${recursiveTriggers}`,
                            requestDigest: "d".repeat(64),
                        },
                        {
                            projectPath: "git:v84-replace",
                            category: "CONSTRAINTS",
                            content: "replace collision seed",
                            normalizedHash: "hash:replace-collision",
                        },
                    ),
                );
                const original = JSON.stringify(
                    db
                        .prepare("SELECT * FROM legacy_memory_claims WHERE memory_id = ?")
                        .get(outcome.result.memoryId),
                );
                const link = JSON.parse(original) as Record<string, number>;
                expect(() =>
                    db
                        .prepare(
                            `INSERT OR REPLACE INTO legacy_memory_claims
                                (memory_id, canonical_memory_id, claim_id, project_id, root_observation_id, created_at)
                             VALUES (?, ?, ?, ?, ?, 999)`,
                        )
                        .run(
                            outcome.result.memoryId + 10_000,
                            outcome.result.memoryId + 10_000,
                            link.claim_id,
                            link.project_id,
                            link.root_observation_id,
                        ),
                ).toThrow(/append-only/);
                expect(
                    JSON.stringify(
                        db
                            .prepare("SELECT * FROM legacy_memory_claims WHERE memory_id = ?")
                            .get(outcome.result.memoryId),
                    ),
                ).toBe(original);
            } finally {
                closeQuietly(db);
            }
        }
    });

    test("duplicate crosswalk links must resolve to the canonical claim and project", () => {
        const db = migratedDb();
        try {
            const outcome = runInMemoryClaimsWriteTransaction(db, () =>
                createMemoryWithClaimsInCurrentTransaction(
                    db,
                    {
                        producer: "v84-test",
                        operationKey: "dup-link-seed",
                        requestDigest: "b".repeat(64),
                    },
                    {
                        projectPath: "git:v84-dup",
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

    test("v84 publishes the revision-metadata hash index and the dedup probe uses it", () => {
        const db = migratedDb();
        try {
            expect(
                db
                    .prepare(
                        "SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = 'idx_claim_revision_memory_metadata_hash'",
                    )
                    .get(),
            ).toEqual({ tbl_name: "claim_revision_memory_metadata" });
            const plan = JSON.stringify(
                db
                    .prepare(
                        "EXPLAIN QUERY PLAN SELECT 1 FROM claim_revision_memory_metadata meta WHERE meta.category = ? AND meta.normalized_hash = ?",
                    )
                    .all("CONSTRAINTS", "hash:probe"),
            );
            expect(plan).toContain("idx_claim_revision_memory_metadata_hash");
        } finally {
            closeQuietly(db);
        }
    });

    test("change-log pruning: plain deletes abort; the prune function removes only consumed rows", () => {
        const db = migratedDb();
        try {
            const seed = (key: string, content: string) =>
                runInMemoryClaimsWriteTransaction(db, () =>
                    createMemoryWithClaimsInCurrentTransaction(
                        db,
                        {
                            producer: "v84-prune",
                            operationKey: key,
                            requestDigest: "c".repeat(64),
                        },
                        {
                            projectPath: "git:v84-prune",
                            category: "CONSTRAINTS",
                            content,
                            normalizedHash: `hash:${content}`,
                        },
                    ),
                );
            const first = seed("prune-seed-1", "prune seed one");
            seed("prune-seed-2", "prune seed two");
            const claimId = first.result.claimId as number;
            const projectId = (
                db.prepare("SELECT project_id AS id FROM claims WHERE id = ?").get(claimId) as {
                    id: number;
                }
            ).id;
            // A third operation carrying two effects, so one effect can sit
            // above the watermark while the other is consumed.
            db.transaction(() =>
                runMemoryClaimOperationInCurrentTransaction(
                    db,
                    {
                        producer: "v84-prune",
                        operationKey: "straddle",
                        requestDigest: "1".repeat(64),
                    },
                    () => ({
                        result: null,
                        effects: [
                            {
                                effectKey: "straddle:one",
                                projectId,
                                claimId,
                                effectType: "evidence" as const,
                            },
                            {
                                effectKey: "straddle:two",
                                projectId,
                                claimId,
                                effectType: "evidence" as const,
                            },
                        ],
                    }),
                ),
            ).immediate();
            // A zero-effect operation: its envelope is the only replay record
            // for that key, so pruning never removes it.
            db.transaction(() =>
                runMemoryClaimOperationInCurrentTransaction(
                    db,
                    {
                        producer: "v84-prune",
                        operationKey: "no-effects",
                        requestDigest: "2".repeat(64),
                    },
                    () => ({ result: null, effects: [] }),
                ),
            ).immediate();

            const outboxIds = (
                db.prepare("SELECT id FROM claim_change_outbox ORDER BY id").all() as Array<{
                    id: number;
                }>
            ).map((row) => row.id);
            expect(outboxIds).toHaveLength(4);
            const straddleOpId = (
                db
                    .prepare("SELECT id FROM claim_operations WHERE operation_key = 'straddle'")
                    .get() as { id: number }
            ).id;
            const prune = (watermark: number) =>
                db
                    .transaction(() => pruneClaimChangeLogInCurrentTransaction(db, watermark))
                    .immediate();

            // Without the prune capability every delete aborts.
            expect(() => db.prepare("DELETE FROM claim_change_outbox").run()).toThrow(
                /append-only/,
            );
            expect(() => db.prepare("DELETE FROM claim_operations").run()).toThrow(/append-only/);

            // Watermark covers the first three effects: the two fully
            // consumed operations go; the straddle operation keeps its
            // remaining effect and survives.
            const watermark = outboxIds[2] as number;
            expect(prune(watermark)).toEqual({ prunedOutboxRows: 3, prunedOperationRows: 2 });
            expect(
                (
                    db.prepare("SELECT id FROM claim_change_outbox ORDER BY id").all() as Array<{
                        id: number;
                    }>
                ).map((row) => row.id),
            ).toEqual([outboxIds[3] as number]);
            expect(
                (
                    db
                        .prepare("SELECT operation_key AS key FROM claim_operations ORDER BY id")
                        .all() as Array<{ key: string }>
                ).map((row) => row.key),
            ).toEqual(["straddle", "no-effects"]);
            expect(
                db
                    .prepare(
                        "SELECT enabled, consumed_watermark FROM claim_change_log_prune_state WHERE id = 1",
                    )
                    .get(),
            ).toEqual({ enabled: 0, consumed_watermark: watermark });

            // The capability cleared with the prune scope: a plain delete
            // still aborts even below the recorded watermark.
            expect(() => db.prepare("DELETE FROM claim_change_outbox").run()).toThrow(
                /append-only/,
            );
            expect(() =>
                db.prepare("DELETE FROM claim_operations WHERE operation_key = 'no-effects'").run(),
            ).toThrow(/append-only/);

            // Even with the capability held, state above the watermark
            // refuses to leave.
            db.exec("BEGIN IMMEDIATE");
            try {
                db.prepare(
                    "UPDATE claim_change_log_prune_state SET enabled = 1 WHERE id = 1",
                ).run();
                expect(() =>
                    db.prepare("DELETE FROM claim_change_outbox WHERE id = ?").run(outboxIds[3]),
                ).toThrow(/consumed watermark/);
                expect(() =>
                    db.prepare("DELETE FROM claim_operations WHERE id = ?").run(straddleOpId),
                ).toThrow(/consumed watermark/);
            } finally {
                db.exec("ROLLBACK");
            }

            // Consuming the final effect releases the straddle operation;
            // the recorded watermark never regresses; the zero-effect
            // envelope stays.
            expect(prune(outboxIds[3] as number)).toEqual({
                prunedOutboxRows: 1,
                prunedOperationRows: 1,
            });
            expect(prune(1)).toEqual({ prunedOutboxRows: 0, prunedOperationRows: 0 });
            expect(
                db
                    .prepare(
                        "SELECT consumed_watermark AS watermark FROM claim_change_log_prune_state WHERE id = 1",
                    )
                    .get(),
            ).toEqual({ watermark: outboxIds[3] as number });
            expect(db.prepare("SELECT COUNT(*) AS count FROM claim_change_outbox").get()).toEqual({
                count: 0,
            });
            expect(
                (
                    db.prepare("SELECT operation_key AS key FROM claim_operations").all() as Array<{
                        key: string;
                    }>
                ).map((row) => row.key),
            ).toEqual(["no-effects"]);
        } finally {
            closeQuietly(db);
        }
    });
});
