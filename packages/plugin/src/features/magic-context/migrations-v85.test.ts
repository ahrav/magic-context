/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    clearClaimsBackfillFailpoints,
    setClaimsBackfillCalibrationForTests,
    setClaimsBackfillFailpoint,
} from "./claims-backfill";
import { LATEST_MIGRATION_VERSION, runMigrations } from "./migrations";
import {
    APPLICABILITY_BASELINE_STREAM_KEY,
    CLAIM_APPLICABILITY_TABLES,
    dropClaimApplicabilityObjectsForTests,
    missingClaimApplicabilitySchemaObjects,
    SOURCE_TRUST_CLASSES,
} from "./storage-claim-applicability-schema";
import { initializeDatabase, schemaVersionIsSupported } from "./storage-db";

function migratedDb(): Database {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

/** A legacy database whose memories convert eagerly inside the v84 migration,
 *  so claim revisions and observations exist BEFORE v85 runs. */
function eagerlyConvertedDb(contents: readonly string[]): Database {
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
    const insert = db.prepare(
        `INSERT INTO memories (project_path, category, content, normalized_hash,
            seen_count, retrieval_count, first_seen_at, created_at, updated_at, last_seen_at)
         VALUES ('git:v85-fixture', 'CONSTRAINTS', ?, ?, 1, 0, 777, 1, 1, 1)`,
    );
    for (const content of contents) {
        // pi-lens-ignore: sql-injection
        insert.run(content, `hash:${content}`);
    }
    setClaimsBackfillCalibrationForTests({
        cutoffRows: Math.max(contents.length, 1),
        evidenceDigest: "e".repeat(64),
    });
    runMigrations(db);
    return db;
}

function v85ObjectRows(db: Database): Array<Record<string, unknown>> {
    const tables = new Set<string>(CLAIM_APPLICABILITY_TABLES);
    return (
        db
            .prepare(
                "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
            )
            .all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>
    ).filter(
        (row) =>
            tables.has(row.tbl_name) ||
            row.name === "claim_revision_applicability_intervals" ||
            row.name.startsWith("claim_applicability_") ||
            row.name.startsWith("git_anchor"),
    );
}

function seedClaimGraph(db: Database, suffix = ""): { revisionId: number; observationId: number } {
    const now = 12_345;
    db.prepare("INSERT INTO projects (canonical_identity, created_at) VALUES (?, ?)").run(
        // pi-lens-ignore: sql-injection
        `git:seed${suffix}`,
        now,
    );
    const projectId = Number(
        (
            db
                .prepare("SELECT id FROM projects WHERE canonical_identity = ?")
                .get(`git:seed${suffix}`) as { id: number }
        ).id,
    );
    db.prepare("INSERT INTO episodes (project_id, created_at) VALUES (?, ?)").run(projectId, now);
    const episodeId = Number(
        (db.prepare("SELECT MAX(id) AS id FROM episodes").get() as { id: number }).id,
    );
    db.prepare(
        `INSERT INTO source_spans (episode_id, source_locator, content_sha256, start_offset, end_offset, created_at)
         VALUES (?, 'seed', ?, 0, 1, ?)`,
    ).run(episodeId, "a".repeat(64), now);
    const spanId = Number(
        (db.prepare("SELECT MAX(id) AS id FROM source_spans").get() as { id: number }).id,
    );
    db.prepare(
        `INSERT INTO observations (source_span_id, extracted_text, content_sha256, extractor, extractor_version, extractor_run_id, independence_key, created_at)
         VALUES (?, 'seed text', ?, 'seed', '1', 'run', 'key', ?)`,
    ).run(spanId, "b".repeat(64), now);
    const observationId = Number(
        (db.prepare("SELECT MAX(id) AS id FROM observations").get() as { id: number }).id,
    );
    db.prepare(
        `INSERT INTO claims (project_id, subject, predicate, scope, state, current_revision_id, created_at)
         VALUES (?, ?, 'states', '', 'active', NULL, ?)`,
        // pi-lens-ignore: sql-injection
    ).run(projectId, `seed-subject${suffix}`, now);
    const claimId = Number(
        (db.prepare("SELECT MAX(id) AS id FROM claims").get() as { id: number }).id,
    );
    db.prepare(
        `INSERT INTO claim_revisions (claim_id, revision, content, content_sha256, created_at)
         VALUES (?, 1, 'seed content', ?, ?)`,
    ).run(claimId, "c".repeat(64), now);
    const revisionId = Number(
        (db.prepare("SELECT MAX(id) AS id FROM claim_revisions").get() as { id: number }).id,
    );
    db.prepare(
        "INSERT INTO claim_evidence (revision_id, observation_id, relation, created_at) VALUES (?, ?, 'supports', ?)",
    ).run(revisionId, observationId, now);
    db.prepare("UPDATE claims SET current_revision_id = ? WHERE id = ?").run(revisionId, claimId);
    return { revisionId, observationId };
}

describe("migration v85: claim applicability, git anchors, and source trust", () => {
    afterEach(() => {
        clearClaimsBackfillFailpoints();
        setClaimsBackfillCalibrationForTests(null);
    });

    test("a fresh database and an eagerly converted legacy database publish identical v85 objects and one version row", () => {
        const fresh = migratedDb();
        const upgraded = eagerlyConvertedDb(["carried row"]);
        try {
            for (const table of CLAIM_APPLICABILITY_TABLES) {
                expect(
                    fresh
                        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?")
                        .get(table),
                ).toBeTruthy();
            }
            expect(v85ObjectRows(upgraded)).toEqual(v85ObjectRows(fresh));
            for (const db of [fresh, upgraded]) {
                expect(
                    db
                        .prepare(
                            "SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 85",
                        )
                        .get(),
                ).toEqual({ count: 1 });
                const column = db.prepare("PRAGMA table_info(observations)").all() as Array<{
                    name: string;
                    notnull: number;
                    dflt_value: string | null;
                }>;
                const trust = column.find((c) => c.name === "source_trust_class");
                expect(trust?.notnull).toBe(1);
                expect(trust?.dflt_value).toBe("'model_inference'");
            }
            expect(LATEST_MIGRATION_VERSION).toBeGreaterThanOrEqual(85);
        } finally {
            closeQuietly(fresh);
            closeQuietly(upgraded);
        }
    });

    test("an old binary refuses a v85 database through the schema fence", () => {
        const db = migratedDb();
        try {
            expect(schemaVersionIsSupported(db, 83)).toBeFalse();
            expect(schemaVersionIsSupported(db, 84)).toBeFalse();
            expect(schemaVersionIsSupported(db, 85)).toBeFalse();
            expect(schemaVersionIsSupported(db, LATEST_MIGRATION_VERSION)).toBeTrue();
        } finally {
            closeQuietly(db);
        }
    });

    test("pre-v85 revisions keep their bytes and receive one seeded unknown baseline assertion", () => {
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
                seen_count, retrieval_count, first_seen_at, created_at, updated_at, last_seen_at)
             VALUES ('git:v85-bytes', 'CONSTRAINTS', 'pre-v85 fact', 'hash:pre', 1, 0, 777, 1, 1, 1)`,
        ).run();
        setClaimsBackfillCalibrationForTests({ cutoffRows: 1, evidenceDigest: "e".repeat(64) });
        setClaimsBackfillFailpoint("claims-migration.050.commit.after", () => {
            throw new Error("halt after v84 commit");
        });
        try {
            expect(() => runMigrations(db)).toThrow(/halt after v84 commit/);
            expect(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({
                v: 84,
            });
            const revisionBytesBefore = db
                .prepare(
                    "SELECT id, claim_id, revision, content, content_sha256, source_session_id, created_at FROM claim_revisions ORDER BY id",
                )
                .all();
            expect(revisionBytesBefore.length).toBeGreaterThan(0);

            clearClaimsBackfillFailpoints();
            runMigrations(db);

            const revisionBytesAfter = db
                .prepare(
                    "SELECT id, claim_id, revision, content, content_sha256, source_session_id, created_at FROM claim_revisions ORDER BY id",
                )
                .all();
            expect(revisionBytesAfter).toEqual(revisionBytesBefore);
            const streams = db
                .prepare(
                    "SELECT revision_id, owner_kind, stream_key, source_digest FROM claim_revision_applicability_streams ORDER BY id",
                )
                .all() as Array<Record<string, unknown>>;
            expect(streams.length).toBe(revisionBytesBefore.length);
            for (const stream of streams) {
                expect(stream.owner_kind).toBe("source");
                expect(stream.stream_key).toBe(APPLICABILITY_BASELINE_STREAM_KEY);
            }
            const assertions = db
                .prepare(
                    `SELECT assertion.seq AS seq, assertion.state AS state,
                            assertion.paths_state AS pathsState, assertion.known_from AS knownFrom,
                            rev.created_at AS revisionCreatedAt
                       FROM claim_revision_applicability_assertions assertion
                       JOIN claim_revision_applicability_streams stream ON stream.id = assertion.stream_id
                       JOIN claim_revisions rev ON rev.id = stream.revision_id`,
                )
                .all() as Array<{
                seq: number;
                state: string;
                pathsState: string;
                knownFrom: number | null;
                revisionCreatedAt: number;
            }>;
            expect(assertions.length).toBe(revisionBytesBefore.length);
            for (const assertion of assertions) {
                expect(assertion.seq).toBe(1);
                expect(assertion.state).toBe("unknown");
                expect(assertion.pathsState).toBe("unknown");
                expect(assertion.knownFrom).toBe(assertion.revisionCreatedAt);
            }
            const observations = db
                .prepare("SELECT DISTINCT source_trust_class AS trust FROM observations")
                .all();
            expect(observations).toEqual([{ trust: "model_inference" }]);
        } finally {
            closeQuietly(db);
        }
    });

    test("invalid or NULL trust inserts fail; every valid class is accepted", () => {
        const db = migratedDb();
        try {
            seedClaimGraph(db);
            const spanId = Number(
                (db.prepare("SELECT MAX(id) AS id FROM source_spans").get() as { id: number }).id,
            );
            const insert = db.prepare(
                `INSERT INTO observations (source_span_id, extracted_text, content_sha256, extractor, extractor_version, extractor_run_id, independence_key, source_trust_class, created_at)
                 VALUES (?, 't', ?, 'e', '1', ?, ?, ?, 1)`,
            );
            let runId = 0;
            for (const trust of SOURCE_TRUST_CLASSES) {
                runId += 1;
                // pi-lens-ignore: sql-injection
                insert.run(spanId, "d".repeat(64), `run-${runId}`, `key-${runId}`, trust);
            }
            expect(() =>
                insert.run(spanId, "d".repeat(64), "run-bad", "key-bad", "somewhat_trusted"),
            ).toThrow(/CHECK/i);
            expect(() => insert.run(spanId, "d".repeat(64), "run-null", "key-null", null)).toThrow(
                /NOT NULL/i,
            );
        } finally {
            closeQuietly(db);
        }
    });

    test("every v85 table rejects UPDATE, DELETE, and key-collision INSERT", () => {
        const db = migratedDb();
        try {
            const seed = seedClaimGraph(db);
            db.prepare("INSERT INTO git_anchors (project_id, created_at) VALUES (1, 1)").run();
            const anchorId = Number(
                (db.prepare("SELECT MAX(id) AS id FROM git_anchors").get() as { id: number }).id,
            );
            db.prepare(
                `INSERT INTO git_anchor_representations
                    (anchor_id, project_id, kind, object_format, protocol, namespace, value, created_at)
                 VALUES (?, 1, 'commit_oid', 'sha1', 'git-oid-v1', '', ?, 1)`,
            ).run(anchorId, "f".repeat(40));
            db.prepare(
                `INSERT INTO claim_revision_applicability_streams
                    (revision_id, project_id, owner_kind, stream_key, key_protocol, source_digest, created_at)
                 VALUES (?, 1, 'source', 'guard:v1', 'p1', ?, 1)`,
            ).run(seed.revisionId, "0".repeat(64));
            const streamId = Number(
                (
                    db
                        .prepare("SELECT MAX(id) AS id FROM claim_revision_applicability_streams")
                        .get() as { id: number }
                ).id,
            );
            db.prepare(
                `INSERT INTO claim_revision_applicability_assertions
                    (stream_id, seq, predecessor_id, state, recorded_at, paths_state)
                 VALUES (?, 1, NULL, 'unknown', 5, 'known')`,
            ).run(streamId);
            const assertionId = Number(
                (
                    db
                        .prepare(
                            "SELECT MAX(id) AS id FROM claim_revision_applicability_assertions",
                        )
                        .get() as { id: number }
                ).id,
            );
            db.prepare(
                "INSERT INTO claim_revision_applicability_paths (assertion_id, kind, value) VALUES (?, 'exact', 'src/a.ts')",
            ).run(assertionId);
            db.prepare(
                "INSERT INTO claim_revision_applicability_symbols (assertion_id, protocol, value) VALUES (?, 'sym-v1', 'foo()')",
            ).run(assertionId);

            const attempts: Array<[string, string]> = [
                ["git_anchors", "UPDATE git_anchors SET created_at = 99"],
                ["git_anchors", "DELETE FROM git_anchors"],
                ["git_anchor_representations", "UPDATE git_anchor_representations SET value = 'x'"],
                ["git_anchor_representations", "DELETE FROM git_anchor_representations"],
                [
                    "claim_revision_applicability_streams",
                    "UPDATE claim_revision_applicability_streams SET source_digest = '1'",
                ],
                [
                    "claim_revision_applicability_streams",
                    "DELETE FROM claim_revision_applicability_streams",
                ],
                [
                    "claim_revision_applicability_assertions",
                    "UPDATE claim_revision_applicability_assertions SET state = 'current'",
                ],
                [
                    "claim_revision_applicability_assertions",
                    "DELETE FROM claim_revision_applicability_assertions",
                ],
                [
                    "claim_revision_applicability_paths",
                    "UPDATE claim_revision_applicability_paths SET value = 'x'",
                ],
                [
                    "claim_revision_applicability_paths",
                    "DELETE FROM claim_revision_applicability_paths",
                ],
                [
                    "claim_revision_applicability_symbols",
                    "UPDATE claim_revision_applicability_symbols SET value = 'x'",
                ],
                [
                    "claim_revision_applicability_symbols",
                    "DELETE FROM claim_revision_applicability_symbols",
                ],
            ];
            for (const [table, sql] of attempts) {
                expect(() => db.exec(sql), `${table}: ${sql}`).toThrow(/append-only/);
            }
            const replaceAttempts: Array<[string, string]> = [
                [
                    "git_anchors",
                    "INSERT OR REPLACE INTO git_anchors (id, project_id, created_at) VALUES (1, 1, 99)",
                ],
                [
                    "git_anchor_representations",
                    `INSERT OR REPLACE INTO git_anchor_representations
                        (id, anchor_id, project_id, kind, object_format, protocol, namespace, value, created_at)
                     VALUES (1, ${anchorId}, 1, 'commit_oid', 'sha1', 'git-oid-v1', '', '${"f".repeat(40)}', 99)`,
                ],
                [
                    "claim_revision_applicability_streams",
                    `INSERT OR REPLACE INTO claim_revision_applicability_streams
                        (id, revision_id, project_id, owner_kind, stream_key, key_protocol, source_digest, created_at)
                     VALUES (${streamId}, ${seed.revisionId}, 1, 'source', 'guard:v1', 'p1', '${"1".repeat(64)}', 99)`,
                ],
                [
                    "claim_revision_applicability_assertions",
                    `INSERT OR REPLACE INTO claim_revision_applicability_assertions
                        (id, stream_id, seq, predecessor_id, state, recorded_at, paths_state)
                     VALUES (${assertionId}, ${streamId}, 2, ${assertionId}, 'current', 99, 'known')`,
                ],
                [
                    "claim_revision_applicability_paths",
                    `INSERT OR REPLACE INTO claim_revision_applicability_paths
                        (assertion_id, kind, value) VALUES (${assertionId}, 'exact', 'src/a.ts')`,
                ],
                [
                    "claim_revision_applicability_symbols",
                    `INSERT OR REPLACE INTO claim_revision_applicability_symbols
                        (assertion_id, protocol, value) VALUES (${assertionId}, 'sym-v1', 'foo()')`,
                ],
            ];
            for (const [table, sql] of replaceAttempts) {
                // pi-lens-ignore: sql-injection
                expect(() => db.exec(sql), `${table}: OR REPLACE`).toThrow(/append-only/);
            }
        } finally {
            closeQuietly(db);
        }
    });

    test("cross-project streams, representations, and anchors fail at the database boundary", () => {
        const db = migratedDb();
        try {
            const seed = seedClaimGraph(db, "-p1");
            db.prepare("INSERT INTO projects (canonical_identity, created_at) VALUES (?, ?)").run(
                "git:other-project",
                1,
            );
            const otherProject = Number(
                (
                    db
                        .prepare("SELECT id FROM projects WHERE canonical_identity = ?")
                        .get("git:other-project") as { id: number }
                ).id,
            );
            expect(() =>
                db
                    .prepare(
                        `INSERT INTO claim_revision_applicability_streams
                            (revision_id, project_id, owner_kind, stream_key, key_protocol, source_digest, created_at)
                         VALUES (?, ?, 'source', 'wrong-project:v1', 'p1', ?, 1)`,
                    )
                    .run(seed.revisionId, otherProject, "0".repeat(64)),
            ).toThrow(/project must match/);

            db.prepare("INSERT INTO git_anchors (project_id, created_at) VALUES (?, 1)").run(
                otherProject,
            );
            const foreignAnchor = Number(
                (db.prepare("SELECT MAX(id) AS id FROM git_anchors").get() as { id: number }).id,
            );
            expect(() =>
                db
                    .prepare(
                        `INSERT INTO git_anchor_representations
                            (anchor_id, project_id, kind, object_format, protocol, namespace, value, created_at)
                         VALUES (?, 1, 'tree_oid', 'sha1', 'git-oid-v1', '', ?, 1)`,
                    )
                    .run(foreignAnchor, "e".repeat(40)),
            ).toThrow(/project must match/);

            db.prepare(
                `INSERT INTO claim_revision_applicability_streams
                    (revision_id, project_id, owner_kind, stream_key, key_protocol, source_digest, created_at)
                 VALUES (?, 1, 'source', 'anchor-guard:v1', 'p1', ?, 1)`,
            ).run(seed.revisionId, "0".repeat(64));
            const streamId = Number(
                (
                    db
                        .prepare("SELECT MAX(id) AS id FROM claim_revision_applicability_streams")
                        .get() as { id: number }
                ).id,
            );
            expect(() =>
                db
                    .prepare(
                        `INSERT INTO claim_revision_applicability_assertions
                            (stream_id, seq, predecessor_id, state, valid_from_anchor_id, recorded_at, paths_state)
                         VALUES (?, 1, NULL, 'unknown', ?, 5, 'unknown')`,
                    )
                    .run(streamId, foreignAnchor),
            ).toThrow(/must belong to the stream project/);
        } finally {
            closeQuietly(db);
        }
    });

    test("assertion chains stay gapless with unique predecessor consumption and non-regressing time", () => {
        const db = migratedDb();
        try {
            const seed = seedClaimGraph(db);
            db.prepare(
                `INSERT INTO claim_revision_applicability_streams
                    (revision_id, project_id, owner_kind, stream_key, key_protocol, source_digest, created_at)
                 VALUES (?, 1, 'source', 'chain:v1', 'p1', ?, 1)`,
            ).run(seed.revisionId, "0".repeat(64));
            const streamId = Number(
                (
                    db
                        .prepare("SELECT MAX(id) AS id FROM claim_revision_applicability_streams")
                        .get() as { id: number }
                ).id,
            );
            const insert = db.prepare(
                `INSERT INTO claim_revision_applicability_assertions
                    (stream_id, seq, predecessor_id, state, known_from, recorded_at, paths_state)
                 VALUES (?, ?, ?, 'unknown', ?, ?, 'unknown')`,
            );
            insert.run(streamId, 1, null, 100, 10);
            const first = Number(
                (
                    db
                        .prepare(
                            "SELECT MAX(id) AS id FROM claim_revision_applicability_assertions",
                        )
                        .get() as { id: number }
                ).id,
            );
            expect(() => insert.run(streamId, 3, first, 100, 11)).toThrow(/previous sequence/);
            expect(() => insert.run(streamId, 2, null, 100, 11)).toThrow(/CHECK|open its stream/);
            expect(() => insert.run(streamId, 2, first, 100, 5)).toThrow(/cannot regress/);
            expect(() => insert.run(streamId, 2, first, 50, 11)).toThrow(/cannot regress/);
            insert.run(streamId, 2, first, 200, 11);
            // A consumed predecessor is rejected by the collision guard even
            // with a well-formed sequence.
            expect(() => insert.run(streamId, 2, first, 300, 12)).toThrow(/key collisions/);
            const second = Number(
                (
                    db
                        .prepare(
                            "SELECT MAX(id) AS id FROM claim_revision_applicability_assertions",
                        )
                        .get() as { id: number }
                ).id,
            );
            // A NULL known_from gap must not reopen an older knowledge time:
            // seq 3 carries NULL, then seq 4 below the stream maximum fails.
            insert.run(streamId, 3, second, null, 12);
            const third = second + 1;
            expect(() => insert.run(streamId, 4, third, 150, 13)).toThrow(/cannot regress/);
            insert.run(streamId, 4, third, 200, 13);
            const fourth = third + 1;

            db.prepare(
                `INSERT INTO claim_revision_applicability_streams
                    (revision_id, project_id, owner_kind, stream_key, key_protocol, source_digest, created_at)
                 VALUES (?, 1, 'source', 'chain-two:v1', 'p1', ?, 1)`,
            ).run(seed.revisionId, "0".repeat(64));
            const otherStream = Number(
                (
                    db
                        .prepare("SELECT MAX(id) AS id FROM claim_revision_applicability_streams")
                        .get() as { id: number }
                ).id,
            );
            db.prepare(
                `INSERT INTO claim_revision_applicability_streams
                    (revision_id, project_id, owner_kind, stream_key, key_protocol, source_digest, created_at)
                 VALUES (?, 1, 'source', 'chain-three:v1', 'p1', ?, 1)`,
            ).run(seed.revisionId, "0".repeat(64));
            const thirdStream = otherStream + 1;
            // Cross-stream closure: an unconsumed seq-1 assertion from ANOTHER
            // stream satisfies every predicate except stream ownership.
            insert.run(otherStream, 1, null, 300, 20);
            const otherFirst = fourth + 1;
            insert.run(thirdStream, 1, null, 300, 20);
            expect(() => insert.run(thirdStream, 2, otherFirst, 400, 21)).toThrow(
                /previous sequence/,
            );
        } finally {
            closeQuietly(db);
        }
    });

    test("evaluation streams require a context fingerprint and paths require known state", () => {
        const db = migratedDb();
        try {
            const seed = seedClaimGraph(db);
            expect(() =>
                db
                    .prepare(
                        `INSERT INTO claim_revision_applicability_streams
                            (revision_id, project_id, owner_kind, stream_key, key_protocol, source_digest, context_fingerprint, created_at)
                         VALUES (?, 1, 'evaluation', 'eval:v1', 'p1', ?, NULL, 1)`,
                    )
                    .run(seed.revisionId, "0".repeat(64)),
            ).toThrow(/CHECK/i);

            db.prepare(
                `INSERT INTO claim_revision_applicability_streams
                    (revision_id, project_id, owner_kind, stream_key, key_protocol, source_digest, created_at)
                 VALUES (?, 1, 'source', 'paths:v1', 'p1', ?, 1)`,
            ).run(seed.revisionId, "0".repeat(64));
            const streamId = Number(
                (
                    db
                        .prepare("SELECT MAX(id) AS id FROM claim_revision_applicability_streams")
                        .get() as { id: number }
                ).id,
            );
            db.prepare(
                `INSERT INTO claim_revision_applicability_assertions
                    (stream_id, seq, predecessor_id, state, recorded_at, paths_state)
                 VALUES (?, 1, NULL, 'unknown', 5, 'unknown')`,
            ).run(streamId);
            const assertionId = Number(
                (
                    db
                        .prepare(
                            "SELECT MAX(id) AS id FROM claim_revision_applicability_assertions",
                        )
                        .get() as { id: number }
                ).id,
            );
            expect(() =>
                db
                    .prepare(
                        "INSERT INTO claim_revision_applicability_paths (assertion_id, kind, value) VALUES (?, 'exact', 'src/a.ts')",
                    )
                    .run(assertionId),
            ).toThrow(/known path state/);

            db.prepare("INSERT INTO git_anchors (project_id, created_at) VALUES (1, 1)").run();
            const sameProjectAnchor = Number(
                (db.prepare("SELECT MAX(id) AS id FROM git_anchors").get() as { id: number }).id,
            );
            expect(() =>
                db
                    .prepare(
                        `INSERT INTO claim_revision_applicability_assertions
                            (stream_id, seq, predecessor_id, state, valid_until_anchor_id, recorded_at, paths_state)
                         VALUES (?, 2, ?, 'historical', ?, 6, 'unknown')`,
                    )
                    .run(streamId, assertionId, sameProjectAnchor),
            ).toThrow(/CHECK/i);
        } finally {
            closeQuietly(db);
        }
    });

    test("a replayed v85 no-ops over its published schema; a partial schema refuses", () => {
        const db = migratedDb();
        try {
            db.prepare("DELETE FROM schema_migrations WHERE version >= 85").run();
            runMigrations(db);
            expect(
                db
                    .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 85")
                    .get(),
            ).toEqual({ count: 1 });

            db.prepare("DELETE FROM schema_migrations WHERE version >= 85").run();
            db.exec("DROP TABLE claim_revision_applicability_symbols");
            expect(() => runMigrations(db)).toThrow(/v85 replay guard/);
        } finally {
            closeQuietly(db);
        }
    });

    test("a fresh schema publishes every required non-table object; a replay missing one refuses", () => {
        const db = migratedDb();
        try {
            expect(missingClaimApplicabilitySchemaObjects(db)).toEqual([]);
            db.prepare("DELETE FROM schema_migrations WHERE version >= 85").run();
            db.exec("DROP TRIGGER claim_applicability_assertions_time_guard");
            expect(() => runMigrations(db)).toThrow(
                /v85 replay guard: applicability tables exist but trigger claim_applicability_assertions_time_guard missing/,
            );
        } finally {
            closeQuietly(db);
        }
    });

    test("an INSERT OR REPLACE colliding on the commit-OID unique index cannot replace another anchor's representation", () => {
        const db = migratedDb();
        try {
            seedClaimGraph(db);
            db.prepare("INSERT INTO git_anchors (project_id, created_at) VALUES (1, 1)").run();
            db.prepare("INSERT INTO git_anchors (project_id, created_at) VALUES (1, 1)").run();
            const anchors = db.prepare("SELECT id FROM git_anchors ORDER BY id").all() as Array<{
                id: number;
            }>;
            const oid = "f".repeat(40);
            db.prepare(
                `INSERT INTO git_anchor_representations
                    (anchor_id, project_id, kind, object_format, protocol, namespace, value, created_at)
                 VALUES (?, 1, 'commit_oid', 'sha1', 'git-oid-v1', '', ?, 1)`,
            ).run(anchors[0].id, oid);
            expect(() =>
                db
                    .prepare(
                        `INSERT OR REPLACE INTO git_anchor_representations
                            (anchor_id, project_id, kind, object_format, protocol, namespace, value, created_at)
                         VALUES (?, 1, 'commit_oid', 'sha1', 'git-oid-v1', '', ?, 2)`,
                    )
                    .run(anchors[1].id, oid),
            ).toThrow(/key collisions cannot replace rows/);
            expect(
                db
                    .prepare(
                        "SELECT anchor_id FROM git_anchor_representations WHERE kind = 'commit_oid' AND value = ?",
                    )
                    .all(oid),
            ).toEqual([{ anchor_id: anchors[0].id }]);
        } finally {
            closeQuietly(db);
        }
    });

    test("a trust column without the applicability tables refuses as a partial shape", () => {
        const db = migratedDb();
        try {
            dropClaimApplicabilityObjectsForTests(db);
            expect(() => runMigrations(db)).toThrow(
                /source_trust_class exists without the applicability tables/,
            );
        } finally {
            closeQuietly(db);
        }
    });

    test("the interval view derives recorded_until and known_until only from same-stream successors", () => {
        const db = migratedDb();
        try {
            const seed = seedClaimGraph(db);
            db.prepare(
                `INSERT INTO claim_revision_applicability_streams
                    (revision_id, project_id, owner_kind, stream_key, key_protocol, source_digest, created_at)
                 VALUES (?, 1, 'source', 'view-a:v1', 'p1', ?, 1)`,
            ).run(seed.revisionId, "0".repeat(64));
            const streamA = Number(
                (
                    db
                        .prepare("SELECT MAX(id) AS id FROM claim_revision_applicability_streams")
                        .get() as { id: number }
                ).id,
            );
            db.prepare(
                `INSERT INTO claim_revision_applicability_streams
                    (revision_id, project_id, owner_kind, stream_key, key_protocol, source_digest, created_at)
                 VALUES (?, 1, 'source', 'view-b:v1', 'p1', ?, 1)`,
            ).run(seed.revisionId, "0".repeat(64));
            const streamB = streamA + 1;
            const insert = db.prepare(
                `INSERT INTO claim_revision_applicability_assertions
                    (stream_id, seq, predecessor_id, state, known_from, recorded_at, paths_state)
                 VALUES (?, ?, ?, 'unknown', ?, ?, 'unknown')`,
            );
            insert.run(streamA, 1, null, 100, 10);
            const firstA = Number(
                (
                    db
                        .prepare(
                            "SELECT MAX(id) AS id FROM claim_revision_applicability_assertions",
                        )
                        .get() as { id: number }
                ).id,
            );
            insert.run(streamB, 1, null, 150, 11);
            insert.run(streamA, 2, firstA, 400, 20);
            const intervals = db
                .prepare(
                    `SELECT stream_id AS streamId, seq, known_from AS knownFrom, known_until AS knownUntil,
                            recorded_at AS recordedAt, recorded_until AS recordedUntil
                       FROM claim_revision_applicability_intervals
                      WHERE revision_id = ? ORDER BY stream_id, seq`,
                )
                .all(seed.revisionId) as Array<Record<string, unknown>>;
            expect(intervals).toEqual([
                {
                    streamId: streamA,
                    seq: 1,
                    knownFrom: 100,
                    knownUntil: 400,
                    recordedAt: 10,
                    recordedUntil: 20,
                },
                {
                    streamId: streamA,
                    seq: 2,
                    knownFrom: 400,
                    knownUntil: null,
                    recordedAt: 20,
                    recordedUntil: null,
                },
                {
                    streamId: streamB,
                    seq: 1,
                    knownFrom: 150,
                    knownUntil: null,
                    recordedAt: 11,
                    recordedUntil: null,
                },
            ]);
        } finally {
            closeQuietly(db);
        }
    });

    test("a NULL known_from gap does not leave a superseded assertion knowledge-open", () => {
        const db = migratedDb();
        try {
            const seed = seedClaimGraph(db);
            db.prepare(
                `INSERT INTO claim_revision_applicability_streams
                    (revision_id, project_id, owner_kind, stream_key, key_protocol, source_digest, created_at)
                 VALUES (?, 1, 'source', 'view-gap:v1', 'p1', ?, 1)`,
            ).run(seed.revisionId, "0".repeat(64));
            const streamId = Number(
                (
                    db
                        .prepare("SELECT MAX(id) AS id FROM claim_revision_applicability_streams")
                        .get() as { id: number }
                ).id,
            );
            const insert = db.prepare(
                `INSERT INTO claim_revision_applicability_assertions
                    (stream_id, seq, predecessor_id, state, known_from, recorded_at, paths_state)
                 VALUES (?, ?, ?, 'unknown', ?, ?, 'unknown')`,
            );
            const lastId = (): number =>
                Number(
                    (
                        db
                            .prepare(
                                "SELECT MAX(id) AS id FROM claim_revision_applicability_assertions",
                            )
                            .get() as { id: number }
                    ).id,
                );
            insert.run(streamId, 1, null, 100, 10);
            const first = lastId();
            insert.run(streamId, 2, first, null, 20);
            const second = lastId();
            insert.run(streamId, 3, second, 400, 30);
            const intervals = db
                .prepare(
                    `SELECT seq, known_from AS knownFrom, known_until AS knownUntil
                       FROM claim_revision_applicability_intervals
                      WHERE stream_id = ? ORDER BY seq`,
                )
                .all(streamId) as Array<Record<string, unknown>>;
            // seq 1 is closed by the NEAREST LATER non-NULL knowledge time
            // (seq 3), not left open by seq 2's NULL gap: two open knowledge
            // intervals in one stream would let an as-of-knowledge-time query
            // return the stale state as current.
            expect(intervals).toEqual([
                { seq: 1, knownFrom: 100, knownUntil: 400 },
                { seq: 2, knownFrom: null, knownUntil: 400 },
                { seq: 3, knownFrom: 400, knownUntil: null },
            ]);
        } finally {
            closeQuietly(db);
        }
    });
});
