/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    clearClaimsBackfillFailpoints,
    setClaimsBackfillCalibrationForTests,
} from "./claims-backfill";
import { LATEST_MIGRATION_VERSION, runMigrations } from "./migrations";
import {
    CLAIM_POLICY_SEED_META_KEYS,
    CLAIM_POLICY_TABLES,
    dropClaimPolicyObjectsForTests,
    missingClaimPolicySchemaObjects,
} from "./storage-claim-policy-schema";
import { initializeDatabase, schemaVersionIsSupported } from "./storage-db";

function migratedDb(): Database {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

interface SeededGraph {
    projectId: number;
    claimId: number;
    revisionId: number;
    observationId: number;
}

let seedCounter = 0;

function seedClaimGraph(db: Database, suffix = `-${++seedCounter}`): SeededGraph {
    const now = 12_345;
    db.prepare("INSERT INTO projects (canonical_identity, created_at) VALUES (?, ?)").run(
        // pi-lens-ignore-next-line: sql-injection
        `git:policy-seed${suffix}`,
        now,
    );
    const projectId = Number(
        (
            db
                .prepare("SELECT id FROM projects WHERE canonical_identity = ?")
                .get(`git:policy-seed${suffix}`) as { id: number }
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
         VALUES (?, 'seed text', ?, 'seed', '1', ?, ?, ?)`,
    ).run(
        spanId,
        "b".repeat(64),
        // pi-lens-ignore-next-line: sql-injection
        `run${suffix}`,
        `key${suffix}`,
        now,
    );
    const observationId = Number(
        (db.prepare("SELECT MAX(id) AS id FROM observations").get() as { id: number }).id,
    );
    db.prepare(
        `INSERT INTO claims (project_id, subject, predicate, scope, state, current_revision_id, created_at)
         VALUES (?, ?, 'states', '', 'active', NULL, ?)`,
        // pi-lens-ignore: sql-injection
    ).run(projectId, `policy-subject${suffix}`, now);
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
    return { projectId, claimId, revisionId, observationId };
}

function insertSubject(
    db: Database,
    graph: SeededGraph,
    overrides: Partial<{
        projectId: number;
        originObservationId: number | null;
        sourceDigest: string;
    }> = {},
): void {
    db.prepare(
        `INSERT INTO claim_revision_policy_subjects
            (revision_id, project_id, claim_kind, origin_observation_id, origin_taint,
             classification_method, source_digest, policy_version, created_at)
         VALUES (?, ?, 'unknown', ?, 'ASSISTANT_INFERENCE', 'test', ?, 1, 1)`,
    ).run(
        graph.revisionId,
        overrides.projectId ?? graph.projectId,
        overrides.originObservationId === undefined
            ? graph.observationId
            : overrides.originObservationId,
        overrides.sourceDigest ?? "c".repeat(64),
    );
}

function insertStreamWithAssertion(
    db: Database,
    graph: SeededGraph,
    maturity = "CANDIDATE",
): { streamId: number; assertionId: number } {
    db.prepare(
        "INSERT INTO claim_maturity_streams (revision_id, project_id, created_at) VALUES (?, ?, 1)",
    ).run(graph.revisionId, graph.projectId);
    const streamId = Number(
        (db.prepare("SELECT MAX(id) AS id FROM claim_maturity_streams").get() as { id: number }).id,
    );
    db.prepare(
        `INSERT INTO claim_maturity_assertions
            (stream_id, seq, predecessor_id, maturity, actor, policy_version, recorded_at)
         VALUES (?, 1, NULL, ?, 'test', 1, 1)`,
    ).run(streamId, maturity);
    const assertionId = Number(
        (db.prepare("SELECT MAX(id) AS id FROM claim_maturity_assertions").get() as { id: number })
            .id,
    );
    return { streamId, assertionId };
}

describe("migration v86: claim trust policy authority", () => {
    afterEach(() => {
        clearClaimsBackfillFailpoints();
        setClaimsBackfillCalibrationForTests(null);
    });

    test("a fresh database publishes every v86 object, meta boundary, and one version row", () => {
        const db = migratedDb();
        try {
            for (const table of CLAIM_POLICY_TABLES) {
                expect(
                    db
                        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?")
                        .get(table),
                ).toBeTruthy();
            }
            expect(missingClaimPolicySchemaObjects(db)).toEqual([]);
            expect(
                db
                    .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 86")
                    .get(),
            ).toEqual({ count: 1 });
            expect(LATEST_MIGRATION_VERSION).toBeGreaterThanOrEqual(86);
            const meta = Object.fromEntries(
                (
                    db
                        .prepare(
                            "SELECT key, value FROM schema_migrations_meta WHERE key LIKE 'claim_policy_seed_%'",
                        )
                        .all() as Array<{ key: string; value: string }>
                ).map((row) => [row.key, row.value]),
            );
            // An empty corpus completes synchronously inside the migration.
            expect(meta[CLAIM_POLICY_SEED_META_KEYS.phase]).toBe("complete");
            expect(meta[CLAIM_POLICY_SEED_META_KEYS.expectedCount]).toBe("0");
        } finally {
            closeQuietly(db);
        }
    });

    test("a populated v85 database records a pending fail-closed boundary and identical objects", () => {
        const db = migratedDb();
        try {
            dropClaimPolicyObjectsForTests(db);
            const graph = seedClaimGraph(db);
            runMigrations(db);
            expect(missingClaimPolicySchemaObjects(db)).toEqual([]);
            const meta = Object.fromEntries(
                (
                    db
                        .prepare(
                            "SELECT key, value FROM schema_migrations_meta WHERE key LIKE 'claim_policy_seed_%'",
                        )
                        .all() as Array<{ key: string; value: string }>
                ).map((row) => [row.key, row.value]),
            );
            expect(meta[CLAIM_POLICY_SEED_META_KEYS.phase]).toBe("pending");
            expect(meta[CLAIM_POLICY_SEED_META_KEYS.expectedCount]).toBe("1");
            expect(Number(meta[CLAIM_POLICY_SEED_META_KEYS.boundaryRevisionId])).toBe(
                graph.revisionId,
            );
            // Parent rows keep their exact bytes.
            expect(
                db
                    .prepare("SELECT content, content_sha256 FROM claim_revisions WHERE id = ?")
                    .get(graph.revisionId),
            ).toEqual({ content: "seed content", content_sha256: "c".repeat(64) });
        } finally {
            closeQuietly(db);
        }
    });

    test("the migration invalidates pre-v86 project-memory and auto-search caches", () => {
        const db = migratedDb();
        try {
            dropClaimPolicyObjectsForTests(db);
            db.prepare(
                "INSERT INTO project_state (project_path, project_memory_epoch) VALUES ('git:cache', 3)",
            ).run();
            db.prepare(
                `INSERT INTO session_meta (session_id, cached_m0_bytes, cached_m1_bytes,
                    cached_m0_project_memory_epoch, auto_search_hint_decisions)
                 VALUES ('ses_cache', X'01', X'02', 3, '[{"stale":true}]')`,
            ).run();
            runMigrations(db);
            expect(
                db
                    .prepare(
                        "SELECT project_memory_epoch FROM project_state WHERE project_path = 'git:cache'",
                    )
                    .get(),
            ).toEqual({ project_memory_epoch: 4 });
            expect(
                db
                    .prepare(
                        `SELECT cached_m0_bytes AS m0, cached_m1_bytes AS m1,
                                cached_m0_project_memory_epoch AS epoch,
                                auto_search_hint_decisions AS hints
                         FROM session_meta WHERE session_id = 'ses_cache'`,
                    )
                    .get(),
            ).toEqual({ m0: null, m1: null, epoch: null, hints: "[]" });
        } finally {
            closeQuietly(db);
        }
    });

    test("an old binary refuses a v86 database through the schema fence", () => {
        const db = migratedDb();
        try {
            expect(schemaVersionIsSupported(db, 84)).toBeFalse();
            expect(schemaVersionIsSupported(db, 85)).toBeFalse();
            expect(schemaVersionIsSupported(db, LATEST_MIGRATION_VERSION)).toBeTrue();
        } finally {
            closeQuietly(db);
        }
    });

    test("a replayed v86 no-ops over its published schema; a partial schema refuses", () => {
        const db = migratedDb();
        try {
            db.prepare("DELETE FROM schema_migrations WHERE version >= 86").run();
            runMigrations(db);
            expect(
                db
                    .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 86")
                    .get(),
            ).toEqual({ count: 1 });

            db.prepare("DELETE FROM schema_migrations WHERE version >= 86").run();
            db.exec("DROP TABLE claim_policy_projector_watermarks");
            expect(() => runMigrations(db)).toThrow(/v86 replay guard/);
        } finally {
            closeQuietly(db);
        }
    });

    test("a fresh schema publishes every required non-table object; a replay missing one refuses", () => {
        const db = migratedDb();
        try {
            expect(missingClaimPolicySchemaObjects(db)).toEqual([]);
            db.prepare("DELETE FROM schema_migrations WHERE version >= 86").run();
            db.exec("DROP TRIGGER claim_maturity_assertions_ladder_guard");
            expect(() => runMigrations(db)).toThrow(
                /v86 replay guard: policy tables exist but trigger claim_maturity_assertions_ladder_guard missing/,
            );
        } finally {
            closeQuietly(db);
        }
    });

    test("wrong-project, non-evidence, and digest-mismatched origins fail before creating a subject", () => {
        const db = migratedDb();
        try {
            const graph = seedClaimGraph(db);
            const foreign = seedClaimGraph(db);
            expect(() => insertSubject(db, graph, { projectId: foreign.projectId })).toThrow(
                /project must match the revision project/,
            );
            expect(() =>
                insertSubject(db, graph, { originObservationId: foreign.observationId }),
            ).toThrow(/origin must be evidence for the same revision/);
            expect(() => insertSubject(db, graph, { sourceDigest: "d".repeat(64) })).toThrow(
                /source digest must match the revision content hash/,
            );
            // A NULL origin (unknown provenance) is the conservative path.
            insertSubject(db, graph, { originObservationId: null });
            expect(
                db
                    .prepare(
                        "SELECT COUNT(*) AS count FROM claim_revision_policy_subjects WHERE revision_id = ?",
                    )
                    .get(graph.revisionId),
            ).toEqual({ count: 1 });
        } finally {
            closeQuietly(db);
        }
    });

    test("every policy ledger rejects UPDATE, DELETE, REPLACE, gaps, and reused predecessors", () => {
        const db = migratedDb();
        try {
            const graph = seedClaimGraph(db);
            insertSubject(db, graph);
            expect(() =>
                db
                    .prepare(
                        "UPDATE claim_revision_policy_subjects SET claim_kind = 'descriptive' WHERE revision_id = ?",
                    )
                    .run(graph.revisionId),
            ).toThrow(/append-only/);
            expect(() =>
                db
                    .prepare("DELETE FROM claim_revision_policy_subjects WHERE revision_id = ?")
                    .run(graph.revisionId),
            ).toThrow(/append-only/);
            expect(() => insertSubject(db, graph)).toThrow(/append-only/);
            expect(() =>
                db
                    .prepare(
                        `INSERT OR REPLACE INTO claim_revision_policy_subjects
                            (revision_id, project_id, claim_kind, origin_observation_id, origin_taint,
                             classification_method, source_digest, policy_version, created_at)
                         VALUES (?, ?, 'descriptive', NULL, 'USER_EXPLICIT', 'forged', ?, 1, 1)`,
                    )
                    .run(graph.revisionId, graph.projectId, "c".repeat(64)),
            ).toThrow(/append-only/);

            const { streamId, assertionId } = insertStreamWithAssertion(db, graph);
            expect(() =>
                db
                    .prepare(
                        "UPDATE claim_maturity_assertions SET maturity = 'ENFORCED' WHERE id = ?",
                    )
                    .run(assertionId),
            ).toThrow(/append-only/);
            expect(() =>
                db.prepare("DELETE FROM claim_maturity_assertions WHERE id = ?").run(assertionId),
            ).toThrow(/append-only/);
            // Sequence gap.
            expect(() =>
                db
                    .prepare(
                        `INSERT INTO claim_maturity_assertions
                            (stream_id, seq, predecessor_id, maturity, actor, policy_version, recorded_at)
                         VALUES (?, 3, ?, 'CORROBORATED', 'test', 1, 1)`,
                    )
                    .run(streamId, assertionId),
            ).toThrow(/previous sequence/);
            // Downward ladder.
            db.prepare(
                `INSERT INTO claim_maturity_assertions
                    (stream_id, seq, predecessor_id, maturity, actor, policy_version, recorded_at)
                 VALUES (?, 2, ?, 'VERIFIED', 'test', 1, 1)`,
            ).run(streamId, assertionId);
            const headId = Number(
                (
                    db.prepare("SELECT MAX(id) AS id FROM claim_maturity_assertions").get() as {
                        id: number;
                    }
                ).id,
            );
            expect(() =>
                db
                    .prepare(
                        `INSERT INTO claim_maturity_assertions
                            (stream_id, seq, predecessor_id, maturity, actor, policy_version, recorded_at)
                         VALUES (?, 3, ?, 'CANDIDATE', 'test', 1, 1)`,
                    )
                    .run(streamId, headId),
            ).toThrow(/strictly increase/);
            // Reused predecessor: valid next seq and rung, stale predecessor
            // only, so exactly the predecessor guard must reject it.
            expect(() =>
                db
                    .prepare(
                        `INSERT INTO claim_maturity_assertions
                            (stream_id, seq, predecessor_id, maturity, actor, policy_version, recorded_at)
                         VALUES (?, 3, ?, 'CORROBORATED', 'test', 1, 1)`,
                    )
                    .run(streamId, assertionId),
            ).toThrow(/previous sequence|key collisions/);
            // Consuming an already-consumed predecessor at ITS successor seq
            // trips the unique-predecessor collision arm specifically.
            expect(() =>
                db
                    .prepare(
                        `INSERT INTO claim_maturity_assertions
                            (stream_id, seq, predecessor_id, maturity, actor, policy_version, recorded_at)
                         VALUES (?, 2, ?, 'CORROBORATED', 'test', 1, 1)`,
                    )
                    .run(streamId, assertionId),
            ).toThrow(/key collisions cannot replace rows/);
        } finally {
            closeQuietly(db);
        }
    });

    test("APPROVED and ENFORCED require same-revision approval and passing artifact proof rows", () => {
        const db = migratedDb();
        try {
            const graph = seedClaimGraph(db);
            insertSubject(db, graph);
            const { streamId, assertionId } = insertStreamWithAssertion(db, graph, "VERIFIED");
            // APPROVED without a proof row fails the CHECK.
            expect(() =>
                db
                    .prepare(
                        `INSERT INTO claim_maturity_assertions
                            (stream_id, seq, predecessor_id, maturity, actor, policy_version, recorded_at)
                         VALUES (?, 2, ?, 'APPROVED', 'test', 1, 1)`,
                    )
                    .run(streamId, assertionId),
            ).toThrow(/CHECK/i);
            // Enforcement artifacts require a currently effective approval.
            expect(() =>
                db
                    .prepare(
                        `INSERT INTO claim_enforcement_artifacts
                            (revision_id, project_id, artifact_kind, canonical_path, bytes_digest,
                             evaluator, evaluator_version, evaluator_result, revision_digest,
                             policy_version, recorded_at)
                         VALUES (?, ?, 'test', 'tests/policy.test.ts', ?, 'bun-test', '1', 'pass', ?, 1, 1)`,
                    )
                    .run(graph.revisionId, graph.projectId, "e".repeat(64), "c".repeat(64)),
            ).toThrow(/currently effective approval/);
            // A digest-mismatched approval fails before recording authority.
            expect(() =>
                db
                    .prepare(
                        `INSERT INTO claim_approval_actions
                            (revision_id, project_id, action, host, source_session_id, user_command_event,
                             command_identity, confirmation_nonce, revision_digest, policy_version, recorded_at)
                         VALUES (?, ?, 'approve', 'opencode', 'ses', 'evt', 'cmd-1', 'nonce', ?, 1, 1)`,
                    )
                    .run(graph.revisionId, graph.projectId, "f".repeat(64)),
            ).toThrow(/revision digest must match/);
            // A revoke without a prior approve fails.
            expect(() =>
                db
                    .prepare(
                        `INSERT INTO claim_approval_actions
                            (revision_id, project_id, action, host, source_session_id, user_command_event,
                             command_identity, confirmation_nonce, revision_digest, policy_version, recorded_at)
                         VALUES (?, ?, 'revoke', 'opencode', 'ses', 'evt', 'cmd-2', 'nonce', ?, 1, 1)`,
                    )
                    .run(graph.revisionId, graph.projectId, "c".repeat(64)),
            ).toThrow(/currently effective approval/);
        } finally {
            closeQuietly(db);
        }
    });

    test("cross-project approvals, artifacts, and dispositions fail at the database boundary", () => {
        const db = migratedDb();
        try {
            const graph = seedClaimGraph(db);
            const foreign = seedClaimGraph(db);
            insertSubject(db, graph);
            expect(() =>
                db
                    .prepare(
                        `INSERT INTO claim_approval_actions
                            (revision_id, project_id, action, host, source_session_id, user_command_event,
                             command_identity, confirmation_nonce, revision_digest, policy_version, recorded_at)
                         VALUES (?, ?, 'approve', 'opencode', 'ses', 'evt', 'cmd-x', 'nonce', ?, 1, 1)`,
                    )
                    .run(graph.revisionId, foreign.projectId, "c".repeat(64)),
            ).toThrow(/project must match the revision project/);
            expect(() =>
                db
                    .prepare(
                        `INSERT INTO claim_disposition_events
                            (revision_id, project_id, disposition, action, actor, policy_version, recorded_at)
                         VALUES (?, ?, 'quarantined', 'assert', 'test', 1, 1)`,
                    )
                    .run(graph.revisionId, foreign.projectId),
            ).toThrow(/project must match the revision project/);
            // A clear without a currently asserted disposition fails.
            expect(() =>
                db
                    .prepare(
                        `INSERT INTO claim_disposition_events
                            (revision_id, project_id, disposition, action, actor, policy_version, recorded_at)
                         VALUES (?, ?, 'stale', 'clear', 'test', 1, 1)`,
                    )
                    .run(graph.revisionId, graph.projectId),
            ).toThrow(/currently asserted disposition/);
        } finally {
            closeQuietly(db);
        }
    });
});
