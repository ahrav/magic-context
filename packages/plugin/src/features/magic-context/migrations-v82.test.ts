/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";
import {
    createSynapseLedgerPage,
    SynapseLedgerConflictError,
} from "./storage-embedding-measurements";

const LEGACY_LEDGER_DDL = `
    CREATE TABLE synapse_batch_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        project_path TEXT NOT NULL DEFAULT '',
        scope TEXT NOT NULL DEFAULT '',
        manifest_json TEXT NOT NULL DEFAULT '{}',
        request_key TEXT NOT NULL DEFAULT '',
        job_id TEXT,
        cursor TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0,
        UNIQUE(session_id, request_key)
    );
    CREATE INDEX idx_synapse_batch_ledger_session
        ON synapse_batch_ledger(session_id, updated_at);
`;

const dirs: string[] = [];

afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fileDbPath(prefix: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), prefix));
    dirs.push(dir);
    return path.join(dir, "context.db");
}

/** Migration state through v81: the v82-shape ledger and version row are
 *  replaced by the legacy (session_id, request_key)-keyed table. */
function v81Database(dbPath: string): Database {
    const db = new Database(dbPath);
    db.exec("PRAGMA foreign_keys=ON");
    initializeDatabase(db);
    runMigrations(db);
    db.exec("DELETE FROM schema_migrations WHERE version >= 82");
    db.exec(`
        DROP INDEX IF EXISTS idx_synapse_batch_ledger_identity;
        DROP INDEX IF EXISTS idx_synapse_batch_ledger_session;
        DROP TABLE synapse_batch_ledger;
    `);
    db.exec(LEGACY_LEDGER_DDL);
    return db;
}

function insertLegacyLedgerRow(
    db: Database,
    args: {
        sessionId: string;
        projectPath?: string;
        scope?: string;
        manifestJson?: string;
        requestKey: string;
        status?: string;
        jobId?: string | null;
        cursor?: string | null;
    },
): void {
    db.prepare(
        `INSERT INTO synapse_batch_ledger
            (session_id, project_path, scope, manifest_json, request_key, job_id, cursor, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1000, 1000)`,
    ).run(
        args.sessionId,
        args.projectPath ?? "/repo",
        args.scope ?? "memory",
        args.manifestJson ?? '[{"id":"memory:1","contentSha256":"h1"}]',
        args.requestKey,
        args.jobId ?? null,
        args.cursor ?? null,
        args.status ?? "pending",
    );
}

function insertMemoryEmbedding(db: Database, modelId: string): number {
    const memoryId = Number(
        db
            .prepare(
                `INSERT INTO memories (project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at)
                 VALUES ('/repo', 'CONSTRAINTS', 'content-${modelId}', 'hash-${modelId}', 1, 1, 1, 1)`,
            )
            .run().lastInsertRowid,
    );
    db.prepare(
        "INSERT INTO memory_embeddings (memory_id, embedding, model_id) VALUES (?, ?, ?)",
    ).run(memoryId, new Uint8Array([1, 2, 3]), modelId);
    return memoryId;
}

function insertCommitEmbedding(db: Database, sha: string, modelId: string): void {
    db.prepare(
        `INSERT INTO git_commits (sha, project_path, short_sha, message, committed_at, indexed_at)
         VALUES (?, '/repo', ?, 'msg', 1, 1)`,
    ).run(sha, sha.slice(0, 7));
    db.prepare(
        "INSERT INTO git_commit_embeddings (sha, embedding, model_id, created_at) VALUES (?, ?, ?, 1)",
    ).run(sha, new Uint8Array([1]), modelId);
}

let compartmentSequence = 0;

function insertChunkEmbedding(db: Database, modelId: string, chunkHash: string): number {
    compartmentSequence += 1;
    const compartmentId = Number(
        db
            .prepare(
                `INSERT INTO compartments (session_id, sequence, start_message, end_message, title, content, created_at)
                 VALUES ('ses-1', ?, 0, 1, 't', 'c', 1)`,
            )
            .run(compartmentSequence).lastInsertRowid,
    );
    db.prepare(
        `INSERT INTO compartment_chunk_embeddings
            (compartment_id, session_id, project_path, window_index, start_ordinal, end_ordinal, chunk_hash, model_id, dims, vector, created_at)
         VALUES (?, 'ses-1', '/repo', 0, 0, 1, ?, ?, 3, ?, 1)`,
    ).run(compartmentId, chunkHash, modelId, new Uint8Array([1]));
    return compartmentId;
}

describe("migration v82: context-complete synapse batch ledger", () => {
    test("quarantines every legacy row as obsolete with preserved count and derived lane role", () => {
        const dbPath = fileDbPath("migrations-v82-quarantine-");
        const db = v81Database(dbPath);
        try {
            insertLegacyLedgerRow(db, { sessionId: "ses-1", requestKey: "k1", status: "pending" });
            // A false 'complete': the legacy path marked completion before any
            // destination write could prove it.
            insertLegacyLedgerRow(db, {
                sessionId: "ses-1",
                requestKey: "k2",
                status: "complete",
                jobId: "job-9",
                cursor: "cur-9",
            });
            insertLegacyLedgerRow(db, {
                sessionId: "shadow:/repo",
                requestKey: "k1",
                status: "partial",
                manifestJson: "{}",
            });

            runMigrations(db);

            const rows = db
                .prepare(
                    "SELECT session_id, lane_role, state, state_version, request_key, deadline_at, restart_count FROM synapse_batch_ledger ORDER BY id",
                )
                .all() as Array<Record<string, unknown>>;
            expect(rows).toHaveLength(3);
            expect(rows.every((row) => row.state === "obsolete")).toBe(true);
            expect(rows.every((row) => row.state_version === 0)).toBe(true);
            expect(rows.every((row) => row.deadline_at === null)).toBe(true);
            expect(rows[0].lane_role).toBe("primary");
            expect(rows[1].lane_role).toBe("primary");
            expect(rows[2].lane_role).toBe("shadow");
            expect(
                db
                    .prepare(
                        "SELECT name FROM sqlite_master WHERE name = 'synapse_batch_ledger_legacy_v81'",
                    )
                    .get(),
            ).toBeNull();
            expect(
                db.prepare("SELECT 1 FROM schema_migrations WHERE version = 82").get(),
            ).not.toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    test("invalidates unproven synapse destination rows in the migration transaction, keeps proven and non-synapse rows", () => {
        const dbPath = fileDbPath("migrations-v82-invalidate-");
        const db = v81Database(dbPath);
        try {
            const synapseModel = "synapse:v1:abc123";
            insertMemoryEmbedding(db, synapseModel);
            insertMemoryEmbedding(db, "local-model");
            insertCommitEmbedding(db, "a".repeat(40), synapseModel);
            insertCommitEmbedding(db, "b".repeat(40), "local-model");
            // chunk rows carry their source hash; a non-empty hash is the
            // compatibility proof, an empty one is unprovable.
            insertChunkEmbedding(db, synapseModel, "chunk-hash-proven");
            insertChunkEmbedding(db, synapseModel, "");
            insertChunkEmbedding(db, "local-model", "");

            runMigrations(db);

            const memoryModels = (
                db
                    .prepare("SELECT model_id FROM memory_embeddings ORDER BY model_id")
                    .all() as Array<{
                    model_id: string;
                }>
            ).map((row) => row.model_id);
            expect(memoryModels).toEqual(["local-model"]);
            const commitModels = (
                db
                    .prepare("SELECT model_id FROM git_commit_embeddings ORDER BY model_id")
                    .all() as Array<{ model_id: string }>
            ).map((row) => row.model_id);
            expect(commitModels).toEqual(["local-model"]);
            const chunkRows = db
                .prepare(
                    "SELECT model_id, chunk_hash FROM compartment_chunk_embeddings ORDER BY model_id, chunk_hash",
                )
                .all() as Array<{ model_id: string; chunk_hash: string }>;
            expect(chunkRows).toEqual([
                { model_id: "local-model", chunk_hash: "" },
                { model_id: synapseModel, chunk_hash: "chunk-hash-proven" },
            ]);
        } finally {
            closeQuietly(db);
        }
    });

    test("rolls back every schema and data change when the replacement fails, surviving reopen", () => {
        const dbPath = fileDbPath("migrations-v82-rollback-");
        let db = v81Database(dbPath);
        try {
            insertLegacyLedgerRow(db, { sessionId: "ses-1", requestKey: "k1" });
            insertMemoryEmbedding(db, "synapse:v1:abc123");
            // Occupying the quarantine rename target makes the first v82
            // statement throw, which must roll back the whole migration.
            db.exec("CREATE TABLE synapse_batch_ledger_legacy_v81 (id INTEGER PRIMARY KEY)");

            expect(() => runMigrations(db)).toThrow(/Migration v82 failed/);
            closeQuietly(db);

            db = new Database(dbPath);
            db.exec("PRAGMA foreign_keys=ON");
            const columns = new Set(
                (
                    db.prepare("PRAGMA table_info(synapse_batch_ledger)").all() as Array<{
                        name: string;
                    }>
                ).map((row) => row.name),
            );
            expect(columns.has("status")).toBe(true);
            expect(columns.has("state_version")).toBe(false);
            expect(
                (
                    db.prepare("SELECT COUNT(*) AS count FROM synapse_batch_ledger").get() as {
                        count: number;
                    }
                ).count,
            ).toBe(1);
            expect(
                (
                    db.prepare("SELECT COUNT(*) AS count FROM memory_embeddings").get() as {
                        count: number;
                    }
                ).count,
            ).toBe(1);
            expect(
                db.prepare("SELECT 1 FROM schema_migrations WHERE version = 82").get(),
            ).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    test("fresh database gets the v82 shape and live-identity uniqueness", () => {
        const db = new Database(":memory:");
        try {
            db.exec("PRAGMA foreign_keys=ON");
            initializeDatabase(db);
            runMigrations(db);
            const base = {
                projectPath: "/repo",
                sessionId: "ses-1",
                scope: "memory" as const,
                laneRole: "primary" as const,
                destinationModel: "synapse:v1:m",
                applicationGroup: "memory:1",
                requestKey: "k".repeat(64),
                manifest: [{ id: "memory:1", contentSha256: "h1" }],
                deadlineAt: Date.now() + 60_000,
            };
            createSynapseLedgerPage(db, base);
            expect(() => createSynapseLedgerPage(db, base)).toThrow(SynapseLedgerConflictError);
            // Re-running migrations against the already-migrated shape is a no-op.
            runMigrations(db);
            expect(
                (
                    db.prepare("SELECT COUNT(*) AS count FROM synapse_batch_ledger").get() as {
                        count: number;
                    }
                ).count,
            ).toBe(1);
        } finally {
            closeQuietly(db);
        }
    });
});
