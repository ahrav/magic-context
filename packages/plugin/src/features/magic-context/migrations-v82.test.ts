/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    appendClaimRevision,
    createClaim,
    createEpisode,
    createObservation,
    createSourceSpan,
    ensureProject,
} from "./memory/storage-claims";
import { LATEST_MIGRATION_VERSION, runMigrations } from "./migrations";
import { dropClaimApplicabilityObjectsForTests } from "./storage-claim-applicability-schema";
import { APPEND_ONLY_CLAIMS_TABLES, CLAIMS_AND_EVIDENCE_TABLES } from "./storage-claims-schema";
import { closeDatabase, initializeDatabase, openDatabase } from "./storage-db";
import { dropMemoryClaimsCompatObjectsForTests } from "./storage-memory-claims-schema";

function migratedDb(): Database {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

/** Migration state through v81 with the v82+ objects and version rows removed. */
function v81Database(): Database {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    initializeDatabase(db);
    runMigrations(db);
    db.exec("DELETE FROM schema_migrations WHERE version >= 82");
    dropClaimApplicabilityObjectsForTests(db);
    dropMemoryClaimsCompatObjectsForTests(db);
    dropV82Objects(db);
    return db;
}

function dropV82Objects(db: Database): void {
    db.exec(`
        DROP TABLE IF EXISTS verification_events;
        DROP TABLE IF EXISTS claim_conflicts;
        DROP TABLE IF EXISTS claim_evidence;
        DROP TABLE IF EXISTS claim_revisions;
        DROP TABLE IF EXISTS claims;
        DROP TABLE IF EXISTS observations;
        DROP TABLE IF EXISTS source_spans;
        DROP TABLE IF EXISTS episodes;
        DROP TABLE IF EXISTS project_aliases;
        DROP TABLE IF EXISTS projects;
    `);
}

function objectNames(db: Database, type: "table" | "trigger" | "index"): string[] {
    return (
        db
            .prepare(
                "SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name",
            )
            .all(type) as Array<{ name: string }>
    ).map((row) => row.name);
}

function v82ObjectRows(db: Database): Array<Record<string, unknown>> {
    const tables = new Set<string>(CLAIMS_AND_EVIDENCE_TABLES);
    return (
        db
            .prepare(
                "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
            )
            .all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>
    ).filter((row) => tables.has(row.tbl_name));
}

function projectIdFor(db: Database, identity: string): number | undefined {
    const row = db
        .prepare("SELECT project_id AS id FROM project_aliases WHERE alias_identity = ?")
        .get(identity) as { id: number } | undefined;
    return row?.id;
}

function count(db: Database, table: string): number {
    return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

/** One full evidence chain plus a published claim; returns every row id. */
function seedClaimGraph(
    db: Database,
    identity = "git:probe-project",
): {
    projectId: number;
    episodeId: number;
    spanId: number;
    observationId: number;
    claimId: number;
    revisionId: number;
} {
    const projectId = ensureProject(db, identity);
    const episodeId = createEpisode(db, { projectId, sourceSessionId: "ses_probe" });
    const spanId = createSourceSpan(db, {
        episodeId,
        sourceLocator: "transcript://probe",
        content: "the raw span",
        startOffset: 0,
        endOffset: 12,
    });
    const observationId = createObservation(db, {
        sourceSpanId: spanId,
        extractedText: "observed fact",
        extractor: "historian",
        extractorVersion: "1",
        extractorRunId: "run-1",
        independenceKey: "ik-1",
    });
    const outcome = createClaim(db, {
        projectId,
        subject: "subject",
        predicate: "predicate",
        content: "claim content v1",
        evidence: [{ observationId }],
    });
    if (outcome.status !== "applied") throw new Error(`seed claim failed: ${outcome.status}`);
    return {
        projectId,
        episodeId,
        spanId,
        observationId,
        claimId: outcome.claimId,
        revisionId: outcome.revisionId,
    };
}

describe("migration v82: claims and evidence schema", () => {
    test("AE1: fresh database converges on every v82 table, index, trigger, and version row", () => {
        const initializerOnly = new Database(":memory:");
        initializerOnly.exec("PRAGMA foreign_keys=ON");
        initializeDatabase(initializerOnly);
        try {
            for (const table of CLAIMS_AND_EVIDENCE_TABLES) {
                expect(objectNames(initializerOnly, "table")).not.toContain(table);
            }
        } finally {
            closeQuietly(initializerOnly);
        }

        const db = migratedDb();
        try {
            const tables = objectNames(db, "table");
            for (const table of CLAIMS_AND_EVIDENCE_TABLES) {
                expect(tables).toContain(table);
            }
            const triggers = objectNames(db, "trigger");
            for (const table of APPEND_ONLY_CLAIMS_TABLES) {
                expect(triggers).toContain(`${table}_append_only_update`);
                expect(triggers).toContain(`${table}_append_only_delete`);
                expect(triggers).toContain(`${table}_append_only_insert_collision`);
            }
            expect(triggers).toContain("claims_semantic_freeze");
            expect(triggers).toContain("claims_pointer_clear_guard");
            expect(triggers).toContain("claim_evidence_same_project_guard");
            expect(triggers).toContain("projects_namespace_guard_update");
            expect(triggers).toContain("claim_conflicts_supersedes_cycle_guard");
            expect(objectNames(db, "index")).toContain("idx_project_aliases_project");
            expect(
                db
                    .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 82")
                    .get(),
            ).toEqual({ count: 1 });
            expect(LATEST_MIGRATION_VERSION).toBeGreaterThanOrEqual(82);
            expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
            expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
        } finally {
            closeQuietly(db);
        }
    });

    test("fresh and v81-upgraded databases publish identical v82 schema objects", () => {
        const fresh = migratedDb();
        const upgraded = v81Database();
        try {
            runMigrations(upgraded);
            expect(v82ObjectRows(upgraded)).toEqual(v82ObjectRows(fresh));
        } finally {
            closeQuietly(fresh);
            closeQuietly(upgraded);
        }
    });

    test("AE2: v81 identities seed one project per terminal identity with aliases and zero claims", () => {
        const db = v81Database();
        try {
            db.prepare(
                `INSERT INTO memories (project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at)
                 VALUES (?, 'CONSTRAINTS', 'remember', 'hash-1', 1, 1, 1, 1)`,
            ).run("git:terminal-a");
            db.prepare(
                "INSERT INTO session_projects (session_id, project_path, updated_at) VALUES (?, ?, 1)",
            ).run("ses_1", "git:terminal-a");
            db.prepare("INSERT INTO project_state (project_path) VALUES (?)").run("dir:terminal-b");
            db.prepare(
                "INSERT INTO workspaces (name, created_at, updated_at) VALUES ('w', 1, 1)",
            ).run();
            db.prepare(
                `INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
                 VALUES (1, ?, 'c', '/c', 1)`,
            ).run("git:terminal-c");
            db.prepare(
                "INSERT INTO v22_identity_rekey_map (old_project_path, new_project_path, rekeyed_at) VALUES (?, ?, 1)",
            ).run("git:hop-1", "git:hop-2");
            db.prepare(
                "INSERT INTO v22_identity_rekey_map (old_project_path, new_project_path, rekeyed_at) VALUES (?, ?, 1)",
            ).run("git:hop-2", "git:terminal-a");
            db.prepare(
                "INSERT INTO v22_identity_rekey_map (old_project_path, new_project_path, rekeyed_at) VALUES (?, ?, 1)",
            ).run("/raw/mapped", "git:terminal-a");
            db.prepare("INSERT INTO project_state (project_path) VALUES (?)").run("/raw/unmapped");
            const memoriesBefore = db.prepare("SELECT * FROM memories ORDER BY id").all();

            runMigrations(db);

            const canonical = (
                db
                    .prepare("SELECT canonical_identity AS c FROM projects ORDER BY c")
                    .all() as Array<{ c: string }>
            ).map((row) => row.c);
            expect(canonical).toEqual(["dir:terminal-b", "git:terminal-a", "git:terminal-c"]);
            const terminalA = projectIdFor(db, "git:terminal-a");
            expect(projectIdFor(db, "git:hop-1")).toBe(terminalA as number);
            expect(projectIdFor(db, "git:hop-2")).toBe(terminalA as number);
            expect(projectIdFor(db, "/raw/mapped")).toBe(terminalA as number);
            expect(projectIdFor(db, "/raw/unmapped")).toBeUndefined();
            expect(projectIdFor(db, "dir:terminal-b")).toBeDefined();
            expect(projectIdFor(db, "git:terminal-c")).toBeDefined();
            expect(count(db, "claims")).toBe(0);
            expect(count(db, "episodes")).toBe(0);
            expect(db.prepare("SELECT * FROM memories ORDER BY id").all()).toEqual(memoriesBefore);
        } finally {
            closeQuietly(db);
        }
    });

    test("a rekey cycle is skipped: v82 publishes, live identities seed, cyclic ones stay unregistered", () => {
        const db = v81Database();
        try {
            db.prepare(
                "INSERT INTO v22_identity_rekey_map (old_project_path, new_project_path, rekeyed_at) VALUES (?, ?, 1)",
            ).run("git:cycle-a", "git:cycle-b");
            db.prepare(
                "INSERT INTO v22_identity_rekey_map (old_project_path, new_project_path, rekeyed_at) VALUES (?, ?, 1)",
            ).run("git:cycle-b", "git:cycle-a");
            db.prepare("INSERT INTO project_state (project_path) VALUES (?)").run("git:live");

            // Legacy merge flows could write cyclic old→new rows; the cycle
            // must not permanently fail the migration and disable the plugin.
            runMigrations(db);

            expect(
                db
                    .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 82")
                    .get(),
            ).toEqual({ count: 1 });
            expect(projectIdFor(db, "git:live")).toBeDefined();
            expect(projectIdFor(db, "git:cycle-a")).toBeUndefined();
            expect(projectIdFor(db, "git:cycle-b")).toBeUndefined();
        } finally {
            closeQuietly(db);
        }
    });

    test("a failure after DDL rolls back every v82 object and version row", () => {
        const db = v81Database();
        try {
            db.exec(`
                CREATE TABLE decoy (id INTEGER PRIMARY KEY);
                CREATE TRIGGER claims_semantic_freeze BEFORE UPDATE ON decoy
                BEGIN SELECT RAISE(ABORT, 'decoy'); END;
            `);
            expect(() => runMigrations(db)).toThrow(/claims_semantic_freeze/);
            const tables = objectNames(db, "table");
            for (const table of CLAIMS_AND_EVIDENCE_TABLES) {
                expect(tables).not.toContain(table);
            }
            expect(
                db
                    .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 82")
                    .get(),
            ).toEqual({ count: 0 });

            db.exec("DROP TRIGGER claims_semantic_freeze; DROP TABLE decoy;");
            runMigrations(db);
            expect(
                db
                    .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 82")
                    .get(),
            ).toEqual({ count: 1 });
        } finally {
            closeQuietly(db);
        }
    });

    test("v82 performs no write to memories, memory_stats, embeddings, verifications, or FTS", () => {
        const db = v81Database();
        try {
            db.prepare(
                `INSERT INTO memories (project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at)
                 VALUES (?, 'CONSTRAINTS', 'byte stable', 'hash-stable', 1, 1, 1, 1)`,
            ).run("git:byte-stable");
            db.exec(`
                CREATE TABLE test_write_audit (table_name TEXT, op TEXT);

                CREATE TRIGGER test_memories_ai AFTER INSERT ON memories
                BEGIN INSERT INTO test_write_audit VALUES ('memories', 'insert'); END;
                CREATE TRIGGER test_memories_au AFTER UPDATE ON memories
                BEGIN INSERT INTO test_write_audit VALUES ('memories', 'update'); END;
                CREATE TRIGGER test_memories_ad AFTER DELETE ON memories
                BEGIN INSERT INTO test_write_audit VALUES ('memories', 'delete'); END;

                CREATE TRIGGER test_memory_stats_ai AFTER INSERT ON memory_stats
                BEGIN INSERT INTO test_write_audit VALUES ('memory_stats', 'insert'); END;
                CREATE TRIGGER test_memory_stats_au AFTER UPDATE ON memory_stats
                BEGIN INSERT INTO test_write_audit VALUES ('memory_stats', 'update'); END;
                CREATE TRIGGER test_memory_stats_ad AFTER DELETE ON memory_stats
                BEGIN INSERT INTO test_write_audit VALUES ('memory_stats', 'delete'); END;

                CREATE TRIGGER test_memory_embeddings_ai AFTER INSERT ON memory_embeddings
                BEGIN INSERT INTO test_write_audit VALUES ('memory_embeddings', 'insert'); END;
                CREATE TRIGGER test_memory_embeddings_au AFTER UPDATE ON memory_embeddings
                BEGIN INSERT INTO test_write_audit VALUES ('memory_embeddings', 'update'); END;
                CREATE TRIGGER test_memory_embeddings_ad AFTER DELETE ON memory_embeddings
                BEGIN INSERT INTO test_write_audit VALUES ('memory_embeddings', 'delete'); END;

                CREATE TRIGGER test_memory_verifications_ai AFTER INSERT ON memory_verifications
                BEGIN INSERT INTO test_write_audit VALUES ('memory_verifications', 'insert'); END;
                CREATE TRIGGER test_memory_verifications_au AFTER UPDATE ON memory_verifications
                BEGIN INSERT INTO test_write_audit VALUES ('memory_verifications', 'update'); END;
                CREATE TRIGGER test_memory_verifications_ad AFTER DELETE ON memory_verifications
                BEGIN INSERT INTO test_write_audit VALUES ('memory_verifications', 'delete'); END;
            `);
            const memoriesBefore = db.prepare("SELECT * FROM memories ORDER BY id").all();
            const statsBefore = db.prepare("SELECT * FROM memory_stats ORDER BY memory_id").all();
            const ftsBefore = db
                .prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'stable'")
                .all();

            runMigrations(db);

            expect(count(db, "test_write_audit")).toBe(0);
            expect(db.prepare("SELECT * FROM memories ORDER BY id").all()).toEqual(memoriesBefore);
            expect(db.prepare("SELECT * FROM memory_stats ORDER BY memory_id").all()).toEqual(
                statsBefore,
            );
            expect(
                db
                    .prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'stable'")
                    .all(),
            ).toEqual(ftsBefore);
        } finally {
            closeQuietly(db);
        }
    });

    test("enum, offset, and independence-key checks fail closed", () => {
        const db = migratedDb();
        try {
            const { projectId, spanId, revisionId } = seedClaimGraph(db);
            const unlinkedObservationId = createObservation(db, {
                sourceSpanId: spanId,
                extractedText: "second observed fact",
                extractor: "historian",
                extractorVersion: "1",
                extractorRunId: "run-2",
                independenceKey: "ik-2",
            });
            const now = Date.now();
            expect(() =>
                db
                    .prepare(
                        "INSERT INTO claims (project_id, subject, predicate, scope, state, created_at) VALUES (?, 's2', 'p2', '', 'bogus', ?)",
                    )
                    .run(projectId, now),
            ).toThrow(/CHECK/i);
            expect(() =>
                db
                    .prepare(
                        "INSERT INTO claim_evidence (revision_id, observation_id, relation, created_at) VALUES (?, ?, 'refutes', ?)",
                    )
                    .run(revisionId, unlinkedObservationId, now),
            ).toThrow(/CHECK/i);
            const sibling = createClaim(db, {
                projectId,
                subject: "sibling subject",
                predicate: "predicate",
                content: "sibling claim v1",
                evidence: [{ observationId: unlinkedObservationId }],
            });
            if (sibling.status !== "applied") throw new Error("sibling claim failed");
            expect(() =>
                db
                    .prepare(
                        "INSERT INTO claim_conflicts (relation, left_revision_id, right_revision_id, created_at) VALUES ('disagrees', ?, ?, ?)",
                    )
                    .run(revisionId, sibling.revisionId, now),
            ).toThrow(/CHECK/i);
            expect(() =>
                db
                    .prepare(
                        "INSERT INTO verification_events (revision_id, outcome, verifier, created_at) VALUES (?, 'unknown', 'v', ?)",
                    )
                    .run(revisionId, now),
            ).toThrow(/CHECK/i);
            expect(() =>
                db
                    .prepare(
                        `INSERT INTO source_spans (episode_id, source_locator, content_sha256, start_offset, end_offset, created_at)
                         VALUES (1, 'loc', '${"a".repeat(64)}', 5, 5, ?)`,
                    )
                    .run(now),
            ).toThrow(/CHECK/i);
            expect(() =>
                db
                    .prepare(
                        `INSERT INTO observations (source_span_id, extracted_text, content_sha256, extractor, extractor_version, extractor_run_id, independence_key, created_at)
                         VALUES (?, 't', '${"a".repeat(64)}', 'e', '1', 'r', '', ?)`,
                    )
                    .run(spanId, now),
            ).toThrow(/CHECK/i);
        } finally {
            closeQuietly(db);
        }
    });

    test("cross-project evidence and a foreign current pointer fail at the database boundary", () => {
        const db = migratedDb();
        try {
            const graphA = seedClaimGraph(db, "git:project-a");
            const graphB = seedClaimGraph(db, "git:project-b");
            expect(() =>
                db
                    .prepare(
                        "INSERT INTO claim_evidence (revision_id, observation_id, relation, created_at) VALUES (?, ?, 'supports', ?)",
                    )
                    .run(graphA.revisionId, graphB.observationId, Date.now()),
            ).toThrow(/same project/);
            expect(() =>
                db
                    .prepare("UPDATE claims SET current_revision_id = ? WHERE id = ?")
                    .run(graphB.revisionId, graphA.claimId),
            ).toThrow(/FOREIGN KEY|foreign key/i);
        } finally {
            closeQuietly(db);
        }
    });

    test("every immutable table rejects update, delete, replacement, and upsert-update", () => {
        const db = migratedDb();
        try {
            const graph = seedClaimGraph(db);
            const appended = appendClaimRevision(db, {
                claimId: graph.claimId,
                expectedCurrentRevisionId: graph.revisionId,
                content: "claim content v2",
                evidence: [{ observationId: graph.observationId }],
            });
            expect(appended.status).toBe("applied");
            const siblingClaim = createClaim(db, {
                projectId: graph.projectId,
                subject: "sibling subject",
                predicate: "predicate",
                content: "sibling claim v1",
                evidence: [{ observationId: graph.observationId }],
            });
            if (siblingClaim.status !== "applied") throw new Error("sibling claim failed");
            db.prepare(
                "INSERT INTO claim_conflicts (relation, left_revision_id, right_revision_id, created_at) VALUES ('supersedes', ?, ?, ?)",
            ).run(
                (appended as { revisionId: number }).revisionId,
                siblingClaim.revisionId,
                Date.now(),
            );
            db.prepare(
                "INSERT INTO verification_events (revision_id, outcome, verifier, created_at) VALUES (?, 'verified', 'v', ?)",
            ).run(graph.revisionId, Date.now());

            const probes: Array<{ table: string; update: string; del: string; replace: string }> = [
                {
                    table: "episodes",
                    update: "UPDATE episodes SET created_at = 99",
                    del: "DELETE FROM episodes",
                    replace: `INSERT OR REPLACE INTO episodes (id, project_id, created_at) VALUES (${graph.episodeId}, ${graph.projectId}, 99)`,
                },
                {
                    table: "source_spans",
                    update: "UPDATE source_spans SET start_offset = 1",
                    del: "DELETE FROM source_spans",
                    replace: `INSERT OR REPLACE INTO source_spans (id, episode_id, source_locator, content_sha256, start_offset, end_offset, created_at) VALUES (${graph.spanId}, ${graph.episodeId}, 'x', '${"b".repeat(64)}', 0, 1, 99)`,
                },
                {
                    table: "observations",
                    update: "UPDATE observations SET extracted_text = 'tampered'",
                    del: "DELETE FROM observations",
                    replace: `INSERT OR REPLACE INTO observations (id, source_span_id, extracted_text, content_sha256, extractor, extractor_version, extractor_run_id, independence_key, created_at) VALUES (${graph.observationId}, ${graph.spanId}, 'tampered', '${"b".repeat(64)}', 'e', '1', 'r', 'ik', 99)`,
                },
                {
                    table: "claim_revisions",
                    update: "UPDATE claim_revisions SET content = 'tampered'",
                    del: "DELETE FROM claim_revisions",
                    replace: `INSERT OR REPLACE INTO claim_revisions (claim_id, revision, content, content_sha256, created_at) VALUES (${graph.claimId}, 1, 'tampered', '${"b".repeat(64)}', 99)`,
                },
                {
                    table: "claim_evidence",
                    update: "UPDATE claim_evidence SET relation = 'merged_from'",
                    del: "DELETE FROM claim_evidence",
                    replace: `INSERT OR REPLACE INTO claim_evidence (revision_id, observation_id, relation, created_at) VALUES (${graph.revisionId}, ${graph.observationId}, 'merged_from', 99)`,
                },
                {
                    table: "claim_conflicts",
                    update: "UPDATE claim_conflicts SET relation = 'contradicts'",
                    del: "DELETE FROM claim_conflicts",
                    // A fresh tuple (not the reverse pair, which the supersedes
                    // cycle guard rejects on its own) so only the id collides.
                    replace: `INSERT OR REPLACE INTO claim_conflicts (id, relation, left_revision_id, right_revision_id, created_at) SELECT id, 'supersedes', ${graph.revisionId}, right_revision_id, 99 FROM claim_conflicts LIMIT 1`,
                },
                {
                    table: "verification_events",
                    update: "UPDATE verification_events SET outcome = 'stale'",
                    del: "DELETE FROM verification_events",
                    replace:
                        "INSERT OR REPLACE INTO verification_events (id, revision_id, outcome, verifier, created_at) SELECT id, revision_id, 'stale', 'x', 99 FROM verification_events LIMIT 1",
                },
            ];
            // Every append-only table must have a behavior probe: a new table
            // passing the name-existence checks above is not enough.
            expect(probes.map((probe) => probe.table).sort()).toEqual(
                [...APPEND_ONLY_CLAIMS_TABLES].sort(),
            );
            for (const probe of probes) {
                const before = db.prepare(`SELECT * FROM ${probe.table}`).all();
                expect(() => db.exec(probe.update), `${probe.table} update`).toThrow(/append-only/);
                expect(() => db.exec(probe.del), `${probe.table} delete`).toThrow(/append-only/);
                expect(() => db.exec(probe.replace), `${probe.table} replace`).toThrow(
                    /append-only/,
                );
                expect(db.prepare(`SELECT * FROM ${probe.table}`).all()).toEqual(before);
            }

            expect(() =>
                db
                    .prepare(
                        `INSERT INTO claim_revisions (claim_id, revision, content, content_sha256, created_at)
                         VALUES (?, 1, 'tampered', ?, 99)
                         ON CONFLICT (claim_id, revision) DO UPDATE SET content = 'tampered'`,
                    )
                    .run(graph.claimId, "b".repeat(64)),
            ).toThrow(/append-only/);

            // claim_evidence is WITHOUT ROWID: a rowid-addressed REPLACE with a
            // fresh (revision_id, observation_id) pair would otherwise replace
            // an existing evidence row without firing the pair-keyed collision
            // trigger or, with recursive triggers off, the delete guard.
            const freshObservationId = Number(
                (
                    db
                        .prepare(
                            `INSERT INTO observations
                                (source_span_id, extracted_text, content_sha256, extractor, extractor_version, extractor_run_id, independence_key, created_at)
                             VALUES (?, 'fresh', ?, 'e', '1', 'r2', 'ik2', 99)`,
                        )
                        .run(graph.spanId, "c".repeat(64)) as {
                        lastInsertRowid: number | bigint;
                    }
                ).lastInsertRowid,
            );
            const evidenceBefore = db
                .prepare("SELECT * FROM claim_evidence ORDER BY revision_id, observation_id")
                .all();
            expect(() =>
                db
                    .prepare(
                        "INSERT OR REPLACE INTO claim_evidence (rowid, revision_id, observation_id, relation, created_at) VALUES (1, ?, ?, 'supports', 99)",
                    )
                    .run(graph.revisionId, freshObservationId),
            ).toThrow(/rowid/i);
            expect(
                db
                    .prepare("SELECT * FROM claim_evidence ORDER BY revision_id, observation_id")
                    .all(),
            ).toEqual(evidenceBefore);

            expect(() =>
                db
                    .prepare("UPDATE claims SET subject = 'tampered' WHERE id = ?")
                    .run(graph.claimId),
            ).toThrow(/immutable/);
            expect(() =>
                db
                    .prepare("UPDATE claims SET current_revision_id = NULL WHERE id = ?")
                    .run(graph.claimId),
            ).toThrow(/cannot be cleared/);
            db.prepare("UPDATE claims SET state = 'archived' WHERE id = ?").run(graph.claimId);
        } finally {
            closeQuietly(db);
        }
    });

    test("alias namespace guards reject shadowing another project's identity", () => {
        const db = migratedDb();
        try {
            const a = ensureProject(db, "git:namespace-a");
            const b = ensureProject(db, "git:namespace-b");
            expect(a).not.toBe(b);
            expect(() =>
                db
                    .prepare(
                        "INSERT INTO project_aliases (alias_identity, project_id, created_at) VALUES (?, ?, ?)",
                    )
                    .run("git:namespace-a", b, Date.now()),
            ).toThrow(/collides/);
            expect(() =>
                db
                    .prepare("INSERT INTO projects (canonical_identity, created_at) VALUES (?, ?)")
                    .run("git:namespace-b", Date.now()),
            ).toThrow(/UNIQUE|collides/i);
            // UNIQUE only covers canonical identities; the update guard must
            // catch a direct-SQL rename onto another project's alias.
            db.prepare(
                "INSERT INTO project_aliases (alias_identity, project_id, created_at) VALUES (?, ?, ?)",
            ).run("dir:namespace-b-alias", b, Date.now());
            expect(() =>
                db
                    .prepare("UPDATE projects SET canonical_identity = ? WHERE id = ?")
                    .run("dir:namespace-b-alias", a),
            ).toThrow(/collides/);
            // Re-adopting an identity already aliased to the same project stays legal.
            db.prepare(
                "INSERT INTO project_aliases (alias_identity, project_id, created_at) VALUES (?, ?, ?)",
            ).run("dir:namespace-a-alias", a, Date.now());
            db.prepare("UPDATE projects SET canonical_identity = ? WHERE id = ?").run(
                "dir:namespace-a-alias",
                a,
            );
        } finally {
            closeQuietly(db);
        }
    });

    test("AE6: a binary fenced at v81 refuses a migrated v82 database", () => {
        const dir = mkdtempSync(join(tmpdir(), "mc-v82-fence-"));
        const dbPath = join(dir, "context.db");
        const seed = new Database(dbPath);
        try {
            seed.exec("PRAGMA foreign_keys=ON");
            initializeDatabase(seed);
            runMigrations(seed);
        } finally {
            closeQuietly(seed);
        }
        try {
            const refused = openDatabase({ dbPath, latestSupportedVersion: 81 });
            expect(refused).toBeNull();
            const probe = new Database(dbPath);
            try {
                expect(
                    probe
                        .prepare(
                            "SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 82",
                        )
                        .get(),
                ).toEqual({ count: 1 });
            } finally {
                closeQuietly(probe);
            }
        } finally {
            closeDatabase();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
