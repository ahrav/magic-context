/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    clearClaimsBackfillFailpoints,
    computeClaimsBackfillEvidenceDigest,
    decideClaimsBackfillMode,
    doctorRetryClaimsBackfill,
    getClaimsBackfillStatus,
    inspectClaimsBackfillReconciliation,
    listClaimsBackfillFailures,
    parseMergedFromLineage,
    recordClaimsBackfillWarningDisposition,
    runClaimsBackfill,
    setClaimsBackfillCalibrationForTests,
    setClaimsBackfillFailpoint,
} from "./claims-backfill";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";

interface LegacyRow {
    projectPath?: string;
    category?: string;
    content: string;
    hash?: string;
    status?: string;
    verificationStatus?: string;
    verifiedAt?: number | null;
    mergedFrom?: string | null;
    supersededBy?: number | null;
    metadataJson?: string | null;
    mappedFile?: string;
}

const openDbs: Database[] = [];
const tempDirs: string[] = [];

afterEach(() => {
    clearClaimsBackfillFailpoints();
    setClaimsBackfillCalibrationForTests(null);
    for (const db of openDbs.splice(0)) closeQuietly(db);
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function prepareLegacyDb(
    rows: readonly LegacyRow[],
    path = ":memory:",
): {
    db: Database;
    ids: number[];
} {
    const db = new Database(path);
    openDbs.push(db);
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0");
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
        `INSERT INTO memories
            (project_path, category, content, normalized_hash, importance, scope, shareable,
             source_type, first_seen_at, created_at, updated_at, last_seen_at, status,
             verification_status, verified_at, merged_from, superseded_by_memory_id, metadata_json)
         VALUES (?, ?, ?, ?, 73, 'ecosystem', 1, 'historian', 11, 12, 13, 14, ?, ?, ?, ?, ?, ?)`,
    );
    const ids: number[] = [];
    for (const [index, row] of rows.entries()) {
        const result = insert.run(
            row.projectPath ?? "git:claims-backfill-a",
            row.category ?? "CONSTRAINTS",
            row.content,
            row.hash ?? `hash:${index + 1}`,
            row.status ?? "active",
            row.verificationStatus ?? "unverified",
            row.verifiedAt ?? null,
            row.mergedFrom ?? null,
            row.supersededBy ?? null,
            row.metadataJson ?? '{"retained":true}',
        ) as { lastInsertRowid: number | bigint };
        const id = Number(result.lastInsertRowid);
        ids.push(id);
        if (row.mappedFile) {
            db.prepare(
                `INSERT INTO memory_verifications (memory_id, file_path, verified_at, mapped_at)
                 VALUES (?, ?, 0, 17)`,
            ).run(id, row.mappedFile);
        }
    }
    return { db, ids };
}

function migrateLazy(rows: readonly LegacyRow[]): { db: Database; ids: number[] } {
    const fixture = prepareLegacyDb(rows);
    runMigrations(fixture.db);
    expect(getClaimsBackfillStatus(fixture.db).mode).toBe(rows.length === 0 ? "empty" : "lazy");
    return fixture;
}

function migrateEager(rows: readonly LegacyRow[]): { db: Database; ids: number[] } {
    const fixture = prepareLegacyDb(rows);
    setClaimsBackfillCalibrationForTests({
        cutoffRows: rows.length || 1,
        evidenceDigest: "a".repeat(64),
    });
    runMigrations(fixture.db);
    setClaimsBackfillCalibrationForTests(null);
    expect(getClaimsBackfillStatus(fixture.db).mode).toBe(rows.length === 0 ? "empty" : "eager");
    return fixture;
}

function semanticSnapshot(db: Database): Record<string, unknown> {
    return {
        links: db
            .prepare(
                `SELECT memory_id, canonical_memory_id, project_id
                   FROM legacy_memory_claims ORDER BY memory_id`,
            )
            .all(),
        revisions: db
            .prepare(
                `SELECT lmc.memory_id, c.state, r.revision, r.content, r.content_sha256,
                        m.category, m.normalized_hash, m.importance, m.memory_scope,
                        m.shareable, m.source_type, m.expires_at, m.metadata_json
                   FROM legacy_memory_claims lmc
                   JOIN claims c ON c.id = lmc.claim_id
                   JOIN claim_revisions r ON r.claim_id = c.id
                   JOIN claim_revision_memory_metadata m ON m.revision_id = r.id
                  ORDER BY lmc.memory_id, r.revision`,
            )
            .all(),
        conflicts: db.prepare("SELECT relation FROM claim_conflicts ORDER BY id").all(),
        crossProject: db
            .prepare(
                "SELECT source_project_id <> target_project_id AS cross_project FROM claim_merge_lineage ORDER BY id",
            )
            .all(),
        effects: db
            .prepare("SELECT effect_key, effect_type FROM claim_change_outbox ORDER BY effect_key")
            .all(),
        dispositions: db
            .prepare(
                `SELECT item_kind, item_key, reason_code, disposition
                   FROM claim_backfill_failures
                  WHERE phase = 'relationships' ORDER BY item_key`,
            )
            .all(),
    };
}

const RELATIONAL_FIXTURE: LegacyRow[] = [
    {
        content: "canonical retained fact",
        hash: "hash:canonical",
        verificationStatus: "verified",
        verifiedAt: 99,
        mappedFile: "src/retained.ts",
    },
    {
        content: "superseded fact",
        hash: "hash:superseded",
        status: "archived",
        supersededBy: 1,
    },
    {
        projectPath: "git:claims-backfill-b",
        content: "cross-project merged fact",
        hash: "hash:cross-project",
        mergedFrom: "[1]",
    },
    {
        content: "mapped only fact",
        hash: "hash:mapped-only",
        verificationStatus: "verified",
        verifiedAt: 0,
    },
];

describe("claims backfill selection and conversion", () => {
    test("empty completes synchronously; calibrated cutoff twins choose eager at N and lazy at N+1", () => {
        const empty = prepareLegacyDb([]);
        runMigrations(empty.db);
        expect(getClaimsBackfillStatus(empty.db)).toMatchObject({
            mode: "empty",
            phase: "complete",
            expectedRowCount: 0,
            finalOutboxWatermark: 0,
        });

        const decisionDb = prepareLegacyDb([
            { content: "one" },
            { content: "two" },
            { content: "three" },
        ]).db;
        setClaimsBackfillCalibrationForTests({ cutoffRows: 2, evidenceDigest: "b".repeat(64) });
        expect(decideClaimsBackfillMode(decisionDb, 2, false).mode).toBe("eager");
        expect(decideClaimsBackfillMode(decisionDb, 3, false).mode).toBe("lazy");
        expect(decideClaimsBackfillMode(decisionDb, 2, true).mode).toBe("lazy");
        setClaimsBackfillCalibrationForTests(null);
        expect(decideClaimsBackfillMode(decisionDb, 1, false).mode).toBe("lazy");
    });

    test("forced eager and lazy preserve metadata, mappings, stats, evidence, lineage, and equivalent graph", async () => {
        const eager = migrateEager(RELATIONAL_FIXTURE);
        const lazy = migrateLazy(RELATIONAL_FIXTURE);

        const lazySummary = await runClaimsBackfill(lazy.db, {
            batchSize: 1,
            yieldToEventLoop: async () => {},
        });
        expect(lazySummary.status).toBe("complete");
        expect(getClaimsBackfillStatus(eager.db).state).toBe("complete");
        expect(semanticSnapshot(lazy.db)).toEqual(semanticSnapshot(eager.db));

        for (const { db, ids } of [eager, lazy]) {
            expect(db.prepare("SELECT COUNT(*) AS count FROM legacy_memory_claims").get()).toEqual({
                count: 4,
            });
            expect(
                db
                    .prepare(
                        `SELECT s.seen_count, s.retrieval_count, m.first_seen_at
                           FROM memory_stats s JOIN memories m ON m.id = s.memory_id
                          WHERE s.memory_id = ?`,
                    )
                    .get(ids[0]),
            ).toEqual({ seen_count: 1, retrieval_count: 0, first_seen_at: 11 });
            expect(
                db
                    .prepare(
                        "SELECT file_path, mapped_at FROM memory_verifications WHERE memory_id = ?",
                    )
                    .get(ids[0]),
            ).toEqual({ file_path: "src/retained.ts", mapped_at: 17 });
            expect(db.prepare("SELECT COUNT(*) AS count FROM verification_events").get()).toEqual({
                count: 1,
            });
            expect(db.prepare("SELECT COUNT(*) AS count FROM claim_conflicts").get()).toEqual({
                count: 1,
            });
            expect(db.prepare("SELECT COUNT(*) AS count FROM claim_merge_lineage").get()).toEqual({
                count: 1,
            });
            const tokenRows = db
                .prepare(
                    `SELECT detail, disposition FROM claim_backfill_failures
                      WHERE phase = 'relationships' ORDER BY item_key`,
                )
                .all() as Array<{ detail: string; disposition: string }>;
            expect(tokenRows).toHaveLength(2);
            for (const token of tokenRows) {
                expect(token.disposition).toBe("resolved");
                expect(JSON.parse(token.detail)).toMatchObject({
                    digest: expect.stringMatching(/^[0-9a-f]{64}$/),
                });
            }
        }
    });

    test("checked-in calibration digest is valid and omissions keep production cutoff zero", () => {
        const evidence = JSON.parse(
            readFileSync(
                new URL(
                    "../../../../../docs/evidence/claims-backfill/v83-threshold.json",
                    import.meta.url,
                ),
                "utf8",
            ),
        ) as {
            measurements: unknown;
            skippedScales: unknown[];
            reviewStatus: string;
            productionCutoff: number;
            evidenceDigest: string;
        };
        expect(computeClaimsBackfillEvidenceDigest(evidence.measurements)).toBe(
            evidence.evidenceDigest,
        );
        expect(evidence.skippedScales).not.toHaveLength(0);
        expect(evidence.reviewStatus).toBe("unreviewed");
        expect(evidence.productionCutoff).toBe(0);
    });

    test("historical JSON and comma lineage parsing is deterministic and preserves malformed raw tokens", () => {
        expect(parseMergedFromLineage('[1,"2",null]')).toEqual([
            { ordinal: 0, raw: "1", kind: "id", id: 1 },
            { ordinal: 1, raw: "2", kind: "id", id: 2 },
            { ordinal: 2, raw: "null", kind: "malformed" },
        ]);
        expect(parseMergedFromLineage("3, identity-merge, broken token")).toEqual([
            { ordinal: 0, raw: "3", kind: "id", id: 3 },
            { ordinal: 1, raw: "identity-merge", kind: "marker" },
            { ordinal: 2, raw: "broken token", kind: "malformed" },
        ]);
    });
});

describe("claims backfill batching and recovery", () => {
    test("batch graph writes and checkpoint roll back together; post-commit interruption resumes exactly once", async () => {
        const { db } = migrateLazy([{ content: "atomic row" }]);
        setClaimsBackfillFailpoint("claims-backfill.010.batch.after", () => {
            throw new Error("cut before batch commit");
        });
        await expect(runClaimsBackfill(db, { yieldToEventLoop: async () => {} })).rejects.toThrow(
            "cut before batch commit",
        );
        expect(db.prepare("SELECT COUNT(*) AS count FROM legacy_memory_claims").get()).toEqual({
            count: 0,
        });
        expect(getClaimsBackfillStatus(db).phase).toBe("rows");

        clearClaimsBackfillFailpoints();
        let committedCut = false;
        setClaimsBackfillFailpoint("claims-backfill.020.batch-commit.after", () => {
            if (!committedCut) {
                committedCut = true;
                throw new Error("cut after batch commit");
            }
        });
        await expect(runClaimsBackfill(db, { yieldToEventLoop: async () => {} })).rejects.toThrow(
            "cut after batch commit",
        );
        expect(db.prepare("SELECT COUNT(*) AS count FROM legacy_memory_claims").get()).toEqual({
            count: 1,
        });

        clearClaimsBackfillFailpoints();
        expect((await runClaimsBackfill(db, { yieldToEventLoop: async () => {} })).status).toBe(
            "complete",
        );
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM claim_operations WHERE producer = 'claims-backfill'",
                )
                .get(),
        ).toEqual({ count: 1 });
    });

    test("busy retry exhaustion leaves the checkpoint pending", async () => {
        const dir = mkdtempSync(join(tmpdir(), "claims-backfill-busy-"));
        tempDirs.push(dir);
        const path = join(dir, "context.db");
        const first = prepareLegacyDb([{ content: "busy row" }], path).db;
        runMigrations(first);
        first.exec("PRAGMA busy_timeout=0");
        const blocker = new Database(path);
        openDbs.push(blocker);
        blocker.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
        try {
            const summary = await runClaimsBackfill(first, {
                retryDelaysMs: [],
                yieldToEventLoop: async () => {},
            });
            expect(summary.status).toBe("pending");
            expect(getClaimsBackfillStatus(first).phase).toBe("rows");
            expect(
                first.prepare("SELECT COUNT(*) AS count FROM legacy_memory_claims").get(),
            ).toEqual({
                count: 0,
            });
        } finally {
            blocker.exec("ROLLBACK");
        }
    });

    test("two runners converge on one graph and one operation per boundary row", async () => {
        const dir = mkdtempSync(join(tmpdir(), "claims-backfill-race-"));
        tempDirs.push(dir);
        const path = join(dir, "context.db");
        const first = prepareLegacyDb(
            Array.from({ length: 8 }, (_, index) => ({ content: `race row ${index}` })),
            path,
        ).db;
        runMigrations(first);
        const second = new Database(path);
        openDbs.push(second);
        second.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0");
        const options = {
            batchSize: 1,
            retryDelaysMs: [1, 2, 5, 10, 20],
            sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
            yieldToEventLoop: () => new Promise<void>((resolve) => setImmediate(resolve)),
        };
        const summaries = await Promise.all([
            runClaimsBackfill(first, options),
            runClaimsBackfill(second, options),
        ]);
        expect(summaries.every((summary) => summary.status === "complete")).toBeTrue();
        expect(first.prepare("SELECT COUNT(*) AS count FROM legacy_memory_claims").get()).toEqual({
            count: 8,
        });
        expect(
            first
                .prepare(
                    "SELECT COUNT(*) AS count FROM claim_operations WHERE producer = 'claims-backfill'",
                )
                .get(),
        ).toEqual({ count: 8 });
        expect(getClaimsBackfillStatus(first).state).toBe("complete");
    });

    test("malformed and dangling lineage block, durable warning dispositions allow idempotent completion", async () => {
        const { db } = migrateLazy([{ content: "lineage target", mergedFrom: '[999,"broken"]' }]);
        const blocked = await runClaimsBackfill(db, { yieldToEventLoop: async () => {} });
        expect(blocked.status).toBe("blocked");
        const failures = listClaimsBackfillFailures(db, { dispositions: ["blocking"] });
        expect(failures.map((failure) => failure.reasonCode)).toEqual([
            "dangling-lineage",
            "malformed-lineage",
        ]);
        for (const failure of failures) {
            expect(
                recordClaimsBackfillWarningDisposition(db, failure.id, "legacy source reviewed"),
            ).toEqual({
                updated: true,
            });
        }
        const retry = await doctorRetryClaimsBackfill(db, { yieldToEventLoop: async () => {} });
        expect(retry.after.state).toBe("complete-with-warnings");
        expect(retry.before.phase).toBe("blocked");
        expect(retry.after.phase).toBe("complete");
        expect((await doctorRetryClaimsBackfill(db)).summary).toBeNull();
    });
});

describe("claims backfill reconciliation", () => {
    test("refuses missing metadata, root evidence, outbox, generation, and lineage disposition", async () => {
        const { db } = migrateLazy([
            { content: "source", hash: "source" },
            { content: "target", hash: "target", mergedFrom: "[1]" },
        ]);
        expect((await runClaimsBackfill(db, { yieldToEventLoop: async () => {} })).status).toBe(
            "complete",
        );
        db.exec(`
            DROP TRIGGER claim_revision_memory_metadata_append_only_delete;
            DROP TRIGGER claim_evidence_append_only_delete;
            DROP TRIGGER claim_change_outbox_append_only_delete;
            DROP TRIGGER claim_project_generations_delete_guard;
        `);
        const revisionId = (
            db
                .prepare("SELECT revision_id AS id FROM claim_revision_memory_metadata LIMIT 1")
                .get() as {
                id: number;
            }
        ).id;
        db.prepare("DELETE FROM claim_revision_memory_metadata WHERE revision_id = ?").run(
            revisionId,
        );
        db.prepare("DELETE FROM claim_evidence WHERE revision_id = ?").run(revisionId);
        db.prepare("DELETE FROM claim_change_outbox").run();
        db.prepare("DELETE FROM claim_project_generations").run();
        db.prepare("DELETE FROM claim_backfill_failures WHERE phase = 'relationships'").run();

        const report = inspectClaimsBackfillReconciliation(db);
        expect(report.ok).toBeFalse();
        expect(report.problems.join("\n")).toContain("missing memory metadata");
        expect(report.problems.join("\n")).toContain("missing root evidence");
        expect(report.problems.join("\n")).toContain("missing an outbox effect");
        expect(report.problems.join("\n")).toContain("missing a project generation");
        expect(report.problems.join("\n")).toContain("lineage token(s) without a disposition");
    });

    test("expected count and boundary anti-join refuse a missing crosswalk despite complete cursors", async () => {
        const { db } = migrateLazy([{ content: "crosswalk oracle" }]);
        expect((await runClaimsBackfill(db, { yieldToEventLoop: async () => {} })).status).toBe(
            "complete",
        );
        db.exec("DROP TRIGGER legacy_memory_claims_append_only_delete");
        db.prepare("DELETE FROM legacy_memory_claims").run();
        const report = inspectClaimsBackfillReconciliation(db);
        expect(report.ok).toBeFalse();
        expect(report.problems.join("\n")).toContain("missing a crosswalk link");
        expect(report.problems.join("\n")).toContain("does not equal expected");
    });
});
