/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { runInMemoryClaimsWriteTransaction } from "./storage-memory-claims";
import {
    deleteMemoryProjectionRow,
    insertMemoryProjectionRow,
    readMemoryProjectionRow,
    readMemoryProjectionRowByHash,
    replaceMemoryProjectionVerificationFiles,
    setMemoryProjectionSuperseded,
    toSafeChangeCount,
    updateMemoryProjectionClassification,
    updateMemoryProjectionContent,
    updateMemoryProjectionMerge,
    updateMemoryProjectionStatus,
    updateMemoryProjectionVerification,
} from "./storage-memory-projection";

let db: Database;

function migratedDb(): Database {
    const database = new Database(":memory:");
    database.exec("PRAGMA foreign_keys=ON");
    initializeDatabase(database);
    runMigrations(database);
    return database;
}

function insertRow(content = "projection fact", nowMs = 1_000): number {
    return runInMemoryClaimsWriteTransaction(db, () =>
        insertMemoryProjectionRow(db, {
            projectPath: "git:projection",
            category: "CONSTRAINTS",
            content,
            normalizedHash: `hash:${content}`,
            nowMs,
        }),
    );
}

afterEach(() => {
    if (db) closeQuietly(db);
});

describe("memory projection leaf", () => {
    test("insert writes the legacy defaults and the stats/FTS triggers run", () => {
        db = migratedDb();
        const id = insertRow();
        const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Record<
            string,
            unknown
        >;
        expect(row).toMatchObject({
            project_path: "git:projection",
            category: "CONSTRAINTS",
            content: "projection fact",
            normalized_hash: "hash:projection fact",
            importance: 50,
            scope: "project",
            shareable: 0,
            source_type: "historian",
            seen_count: 1,
            retrieval_count: 0,
            first_seen_at: 1_000,
            status: "active",
            verification_status: "unverified",
        });
        expect(
            db.prepare("SELECT seen_count FROM memory_stats WHERE memory_id = ?").get(id),
        ).toEqual({ seen_count: 1 });
        expect(
            db
                .prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'projection'")
                .all(),
        ).toHaveLength(1);
    });

    test("reads resolve by id and by exact (project, category, hash)", () => {
        db = migratedDb();
        const id = insertRow();
        expect(readMemoryProjectionRow(db, id)?.content).toBe("projection fact");
        expect(readMemoryProjectionRow(db, 424_242)).toBeNull();
        expect(
            readMemoryProjectionRowByHash(
                db,
                "git:projection",
                "CONSTRAINTS",
                "hash:projection fact",
            )?.id,
        ).toBe(id);
        expect(
            readMemoryProjectionRowByHash(db, "git:projection", "NAMING", "hash:projection fact"),
        ).toBeNull();
    });

    test("content update rewrites semantics, resets derived state, and keeps verification columns", () => {
        db = migratedDb();
        const id = insertRow();
        runInMemoryClaimsWriteTransaction(db, () => {
            db.prepare(
                `UPDATE memories SET shareable = 1, classified_at = 5, verification_status = 'verified',
                    verified_at = 6, mural_cue = 'cue', mural_cue_hash = 'ch', mural_cue_at = 7,
                    mural_cue_rejection_count = 3
                  WHERE id = ?`,
            ).run(id);
        });
        db.prepare(
            "INSERT INTO memory_embeddings (memory_id, embedding, model_id) VALUES (?, ?, 'm')",
        ).run(id, Buffer.from([1]));

        runInMemoryClaimsWriteTransaction(db, () => {
            updateMemoryProjectionContent(db, id, "rewritten fact", "hash:rewritten fact", 2_000);
        });
        const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Record<
            string,
            unknown
        >;
        expect(row).toMatchObject({
            content: "rewritten fact",
            normalized_hash: "hash:rewritten fact",
            updated_at: 2_000,
            shareable: 0,
            classified_at: null,
            mural_cue: null,
            mural_cue_hash: null,
            mural_cue_at: null,
            mural_cue_rejection_count: 0,
            verification_status: "verified",
            verified_at: 6,
        });
        expect(
            db.prepare("SELECT 1 FROM memory_embeddings WHERE memory_id = ?").get(id),
        ).toBeNull();
    });

    test("classification update writes only the supplied fields plus the classified_at stamp", () => {
        db = migratedDb();
        const id = insertRow();
        runInMemoryClaimsWriteTransaction(db, () => {
            updateMemoryProjectionClassification(db, id, { importance: 91, shareable: 1 }, 3_000);
        });
        expect(
            db
                .prepare(
                    "SELECT importance, scope, shareable, classified_at FROM memories WHERE id = ?",
                )
                .get(id),
        ).toEqual({ importance: 91, scope: "project", shareable: 1, classified_at: 3_000 });
    });

    test("status, verification, supersession, and merge updates persist their exact columns", () => {
        db = migratedDb();
        const id = insertRow();
        runInMemoryClaimsWriteTransaction(db, () => {
            updateMemoryProjectionStatus(db, id, "archived", '{"archive_reason":"r"}', 4_000);
        });
        expect(
            db
                .prepare("SELECT status, metadata_json, updated_at FROM memories WHERE id = ?")
                .get(id),
        ).toEqual({
            status: "archived",
            metadata_json: '{"archive_reason":"r"}',
            updated_at: 4_000,
        });

        runInMemoryClaimsWriteTransaction(db, () => {
            updateMemoryProjectionStatus(db, id, "active", undefined, 4_100);
        });
        expect(
            db.prepare("SELECT status, metadata_json FROM memories WHERE id = ?").get(id),
        ).toEqual({
            status: "active",
            metadata_json: '{"archive_reason":"r"}',
        });

        runInMemoryClaimsWriteTransaction(db, () => {
            updateMemoryProjectionVerification(db, id, "verified", 5_000);
        });
        expect(
            db
                .prepare("SELECT verification_status, verified_at FROM memories WHERE id = ?")
                .get(id),
        ).toEqual({ verification_status: "verified", verified_at: 5_000 });
        runInMemoryClaimsWriteTransaction(db, () => {
            updateMemoryProjectionVerification(db, id, "stale", 5_500);
        });
        expect(
            db
                .prepare("SELECT verification_status, verified_at FROM memories WHERE id = ?")
                .get(id),
        ).toEqual({ verification_status: "stale", verified_at: 5_000 });

        runInMemoryClaimsWriteTransaction(db, () => {
            setMemoryProjectionSuperseded(db, id, 999, 6_000);
        });
        expect(
            db.prepare("SELECT status, superseded_by_memory_id FROM memories WHERE id = ?").get(id),
        ).toEqual({ status: "archived", superseded_by_memory_id: 999 });

        const changes = runInMemoryClaimsWriteTransaction(db, () =>
            updateMemoryProjectionMerge(db, id, "[7]", "permanent", 9, 4, 7_000),
        );
        expect(changes).toEqual({ baseChanges: 1, statsChanges: 1 });
        expect(db.prepare("SELECT merged_from, status FROM memories WHERE id = ?").get(id)).toEqual(
            { merged_from: "[7]", status: "permanent" },
        );
        expect(
            db
                .prepare("SELECT seen_count, retrieval_count FROM memory_stats WHERE memory_id = ?")
                .get(id),
        ).toEqual({ seen_count: 9, retrieval_count: 4 });
    });

    test("merge reports a missing stats row instead of silently committing the base marker", () => {
        db = migratedDb();
        const id = insertRow();
        db.prepare("DELETE FROM memory_stats WHERE memory_id = ?").run(id);
        const changes = runInMemoryClaimsWriteTransaction(db, () =>
            updateMemoryProjectionMerge(db, id, "[8]", "active", 1, 1, 8_000),
        );
        expect(changes).toEqual({ baseChanges: 1, statsChanges: 0 });
    });

    test("delete removes the row, embedding, and cascaded side tables", () => {
        db = migratedDb();
        const id = insertRow();
        db.prepare(
            "INSERT INTO memory_embeddings (memory_id, embedding, model_id) VALUES (?, ?, 'm')",
        ).run(id, Buffer.from([1]));
        runInMemoryClaimsWriteTransaction(db, () => {
            replaceMemoryProjectionVerificationFiles(db, id, ["src/a.ts"], 0, 1_000);
            deleteMemoryProjectionRow(db, id);
        });
        expect(db.prepare("SELECT 1 FROM memories WHERE id = ?").get(id)).toBeNull();
        expect(db.prepare("SELECT 1 FROM memory_stats WHERE memory_id = ?").get(id)).toBeNull();
        expect(
            db.prepare("SELECT 1 FROM memory_verifications WHERE memory_id = ?").get(id),
        ).toBeNull();
        expect(
            db.prepare("SELECT 1 FROM memory_embeddings WHERE memory_id = ?").get(id),
        ).toBeNull();
    });

    test("verification file replacement writes real files or the no-file sentinel", () => {
        db = migratedDb();
        const id = insertRow();
        const written = runInMemoryClaimsWriteTransaction(db, () =>
            replaceMemoryProjectionVerificationFiles(db, id, ["src/b.ts", "src/a.ts"], 0, 2_000),
        );
        expect(written).toBe(2);
        const sentinel = runInMemoryClaimsWriteTransaction(db, () =>
            replaceMemoryProjectionVerificationFiles(db, id, [], 3_000, 3_000),
        );
        expect(sentinel).toBe(1);
        expect(
            db
                .prepare(
                    "SELECT file_path, verified_at, mapped_at FROM memory_verifications WHERE memory_id = ?",
                )
                .all(id),
        ).toEqual([{ file_path: "", verified_at: 3_000, mapped_at: 3_000 }]);
    });

    test("Node-shaped bigint change counts normalize to safe numbers", () => {
        expect(toSafeChangeCount({ changes: 3n })).toBe(3);
        expect(toSafeChangeCount({ changes: 2 })).toBe(2);
        expect(toSafeChangeCount({})).toBe(0);
    });
});
