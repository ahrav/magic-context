/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    adoptBoundaryMemoryRowInCurrentTransaction,
    CLAIMS_BACKFILL_EAGER_CUTOFF_CEILING,
    clearClaimsBackfillFailpoints,
    computeClaimsBackfillEvidenceDigest,
    decideClaimsBackfillMode,
    doctorRetryClaimsBackfill,
    getClaimsBackfillStatus,
    inspectClaimsBackfillReconciliation,
    isRetryableSqliteBusyError,
    listClaimsBackfillFailures,
    recordClaimsBackfillWarningDisposition,
    runClaimsBackfill,
    setClaimsBackfillCalibrationForTests,
    setClaimsBackfillFailpoint,
} from "./claims-backfill";
import { deleteMemory, insertMemory } from "./memory/storage-memory";
import {
    parseMemoryClaimMergedFrom,
    runInMemoryClaimsWriteTransaction,
} from "./memory/storage-memory-claims";
import { readMemoryProjectionRow } from "./memory/storage-memory-projection";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";

interface LegacyRow {
    projectPath?: string;
    category?: string;
    content: string;
    hash?: string;
    scope?: string;
    status?: string;
    verificationStatus?: string;
    verifiedAt?: number | null;
    mergedFrom?: string | null;
    supersededBy?: number | null;
    metadataJson?: string | null;
    sourceSessionId?: string | null;
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
             source_session_id, source_type, first_seen_at, created_at, updated_at, last_seen_at,
             status, verification_status, verified_at, merged_from, superseded_by_memory_id,
             metadata_json)
         VALUES (?, ?, ?, ?, 73, ?, 1, ?, 'historian', 11, 12, 13, 14, ?, ?, ?, ?, ?, ?)`,
    );
    const ids: number[] = [];
    for (const [index, row] of rows.entries()) {
        const result = insert.run(
            row.projectPath ?? "git:claims-backfill-a",
            row.category ?? "CONSTRAINTS",
            row.content,
            row.hash ?? `hash:${index + 1}`,
            row.scope ?? "ecosystem",
            row.sourceSessionId ?? null,
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

    test("a bare 'git:' project path forces lazy mode under a calibrated policy", () => {
        const { db } = prepareLegacyDb([{ content: "bare prefix row", projectPath: "git:" }]);
        setClaimsBackfillCalibrationForTests({ cutoffRows: 1, evidenceDigest: "d".repeat(64) });
        const decision = decideClaimsBackfillMode(db, 1, false);
        expect(decision.mode).toBe("lazy");
        expect(decision.reason).toContain("noncanonical project path");
    });

    test("a cutoff above the measured lock-budget ceiling is uncalibrated and forces lazy mode", () => {
        const { db } = prepareLegacyDb([{ content: "ceiling row" }]);
        setClaimsBackfillCalibrationForTests({
            cutoffRows: CLAIMS_BACKFILL_EAGER_CUTOFF_CEILING + 1,
            evidenceDigest: "e".repeat(64),
        });
        const rejected = decideClaimsBackfillMode(db, 1, false);
        expect(rejected).toMatchObject({
            mode: "lazy",
            calibrationDigest: "none",
            reason: "no calibration evidence",
        });
        setClaimsBackfillCalibrationForTests({
            cutoffRows: CLAIMS_BACKFILL_EAGER_CUTOFF_CEILING,
            evidenceDigest: "e".repeat(64),
        });
        expect(decideClaimsBackfillMode(db, 1, false).mode).toBe("eager");
    });

    test("invalid legacy metadata enters the same bounded blocked lane in lazy and forced-eager modes", async () => {
        const cases: Array<[LegacyRow, string]> = [
            [{ content: "empty category", category: "" }, "empty-category"],
            [{ content: "empty hash", hash: "" }, "empty-normalized-hash"],
            [{ content: "empty scope", scope: "" }, "invalid-scope"],
            [{ content: "empty source session", sourceSessionId: "" }, "empty-source-session-id"],
        ];
        for (const [row, reason] of cases) {
            for (const calibrated of [false, true]) {
                const fixture = prepareLegacyDb([row]);
                if (calibrated) {
                    setClaimsBackfillCalibrationForTests({
                        cutoffRows: 1,
                        evidenceDigest: "c".repeat(64),
                    });
                }
                runMigrations(fixture.db);
                setClaimsBackfillCalibrationForTests(null);
                expect(getClaimsBackfillStatus(fixture.db).mode).toBe("lazy");
                expect(
                    (await runClaimsBackfill(fixture.db, { yieldToEventLoop: async () => {} }))
                        .status,
                ).toBe("blocked");
                expect(
                    listClaimsBackfillFailures(fixture.db, { dispositions: ["blocking"] }),
                ).toEqual([expect.objectContaining({ phase: "rows", reasonCode: reason })]);
                expect(
                    fixture.db
                        .prepare(
                            `SELECT
                                (SELECT COUNT(*) FROM legacy_memory_claims) AS links,
                                (SELECT COUNT(*) FROM claims) AS claims,
                                (SELECT COUNT(*) FROM claim_operations) AS operations,
                                (SELECT COUNT(*) FROM claim_change_outbox) AS effects`,
                        )
                        .get(),
                ).toEqual({ links: 0, claims: 0, operations: 0, effects: 0 });
            }
        }
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
                    "../../../../../docs/evidence/claims-backfill/v84-threshold.json",
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
        expect(parseMemoryClaimMergedFrom('[1,"2",null]')).toEqual([
            { ordinal: 0, raw: "1", kind: "id", id: 1 },
            { ordinal: 1, raw: "2", kind: "id", id: 2 },
            { ordinal: 2, raw: "null", kind: "malformed" },
        ]);
        expect(parseMemoryClaimMergedFrom("3, identity-merge, broken token")).toEqual([
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

    test("a linked row deleted before the relationship phase retains lineage required for completion", async () => {
        const { db, ids } = migrateLazy([
            { content: "lineage source", hash: "lineage-source" },
            { content: "lineage target", hash: "lineage-target", mergedFrom: "[1]" },
        ]);
        runInMemoryClaimsWriteTransaction(db, () => {
            for (const id of ids) {
                const row = readMemoryProjectionRow(db, id);
                if (!row) throw new Error(`missing boundary memory ${id}`);
                expect(adoptBoundaryMemoryRowInCurrentTransaction(db, row)).toBeTrue();
            }
        });

        deleteMemory(db, ids[1]);
        expect(db.prepare("SELECT 1 FROM memories WHERE id = ?").get(ids[1])).toBeNull();
        expect(
            db
                .prepare(
                    "SELECT merged_from FROM claim_memory_relationship_sources WHERE memory_id = ?",
                )
                .get(ids[1]),
        ).toEqual({ merged_from: "[1]" });
        expect(
            db
                .prepare(
                    `SELECT disposition FROM claim_backfill_failures
                      WHERE phase = 'relationships' AND item_kind = 'lineage'`,
                )
                .get(),
        ).toEqual({ disposition: "resolved" });

        const summary = await runClaimsBackfill(db, { yieldToEventLoop: async () => {} });
        expect(summary.status).toBe("complete");
        expect(db.prepare("SELECT COUNT(*) AS count FROM claim_conflicts").get()).toEqual({
            count: 1,
        });
        expect(inspectClaimsBackfillReconciliation(db).ok).toBeTrue();
    });

    test("busy classification retries only SQLite base code 5 adapter shapes", () => {
        expect(isRetryableSqliteBusyError({ code: "SQLITE_BUSY" })).toBeTrue();
        expect(isRetryableSqliteBusyError({ code: "SQLITE_BUSY_SNAPSHOT" })).toBeTrue();
        expect(isRetryableSqliteBusyError({ code: "ERR_SQLITE_ERROR", errcode: 5 })).toBeTrue();
        expect(isRetryableSqliteBusyError({ code: "ERR_SQLITE_ERROR", errcode: 0x105 })).toBeTrue();
        expect(isRetryableSqliteBusyError({ code: "SQLITE_LOCKED" })).toBeFalse();
        expect(isRetryableSqliteBusyError({ code: "ERR_SQLITE_ERROR", errcode: 6 })).toBeFalse();
        expect(isRetryableSqliteBusyError(new Error("database is locked"))).toBeFalse();
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

    test("a replaced dangling source is terminal only after a newer current source is disposed", async () => {
        const { db, ids } = migrateLazy([
            { content: "rewritten lineage target", mergedFrom: "[999]" },
        ]);
        expect((await runClaimsBackfill(db, { yieldToEventLoop: async () => {} })).status).toBe(
            "blocked",
        );
        const [failure] = listClaimsBackfillFailures(db, { dispositions: ["blocking"] });
        expect(failure).toMatchObject({ reasonCode: "dangling-lineage" });

        db.prepare(
            `UPDATE claim_backfill_failures
                SET disposition = 'resolved', reason_code = 'relationship-source-replaced'
              WHERE id = ?`,
        ).run(failure.id);
        expect(inspectClaimsBackfillReconciliation(db).problems.join("\n")).toContain(
            "lineage token(s) without a disposition",
        );

        runInMemoryClaimsWriteTransaction(db, () => {
            db.prepare("UPDATE memories SET merged_from = 'identity-merge' WHERE id = ?").run(
                ids[0],
            );
        });
        const retry = await doctorRetryClaimsBackfill(db, {
            yieldToEventLoop: async () => {},
        });
        expect(retry.after.state).toBe("complete");
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM claim_memory_relationship_sources WHERE memory_id = ?",
                )
                .get(ids[0]),
        ).toEqual({ count: 2 });
        expect(inspectClaimsBackfillReconciliation(db).ok).toBeTrue();
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

describe("claims backfill boundary scoping and blocked-state gating", () => {
    test("an above-boundary blocking failure never gates completion but stays on the repair surface", async () => {
        const { db } = migrateLazy([{ content: "boundary row" }]);
        const boundary = getClaimsBackfillStatus(db).boundaryMemoryId;
        const insertFailure = db.prepare(
            `INSERT INTO claim_backfill_failures
                (phase, item_kind, item_key, reason_code, detail, disposition, created_at, updated_at)
             VALUES (?, ?, ?, ?, '', 'blocking', 1, 1)`,
        );
        insertFailure.run("rows", "memory", String(boundary + 1), "unresolved-project-identity");
        insertFailure.run(
            "relationships",
            "lineage",
            `memory:${boundary + 2}:relations:${"d".repeat(64)}:merged-from:0`,
            "dangling-lineage",
        );

        const summary = await runClaimsBackfill(db, { yieldToEventLoop: async () => {} });
        expect(summary.status).toBe("complete");
        expect(inspectClaimsBackfillReconciliation(db).ok).toBeTrue();

        const status = getClaimsBackfillStatus(db, { includeProblems: true });
        expect(status.state).toBe("complete");
        expect(status.blockingFailures).toBe(2);
        expect(listClaimsBackfillFailures(db, { dispositions: ["blocking"] })).toHaveLength(2);
    });

    test("an above-boundary blocking failure does not flip a non-complete phase to blocked", () => {
        const { db } = migrateLazy([{ content: "boundary row" }]);
        const boundary = getClaimsBackfillStatus(db).boundaryMemoryId;
        db.prepare(
            `INSERT INTO claim_backfill_failures
                (phase, item_kind, item_key, reason_code, detail, disposition, created_at, updated_at)
             VALUES ('rows', 'memory', ?, 'unresolved-project-identity', '', 'blocking', 1, 1)`,
        ).run(String(boundary + 1));

        const status = getClaimsBackfillStatus(db);
        expect(status.state).toBe("pending");
        // The repair surface still reports the live-writer failure DB-wide.
        expect(status.blockingFailures).toBe(1);
    });

    test("an above-boundary warning does not pin completion to complete-with-warnings", async () => {
        const { db } = migrateLazy([{ content: "boundary row" }]);
        const boundary = getClaimsBackfillStatus(db).boundaryMemoryId;
        db.prepare(
            `INSERT INTO claim_backfill_failures
                (phase, item_kind, item_key, reason_code, detail, disposition, created_at, updated_at)
             VALUES ('rows', 'memory', ?, 'unresolved-project-identity', '', 'warning', 1, 1)`,
        ).run(String(boundary + 1));

        const summary = await runClaimsBackfill(db, { yieldToEventLoop: async () => {} });
        expect(summary.status).toBe("complete");
        const reconciliation = inspectClaimsBackfillReconciliation(db);
        expect(reconciliation.ok).toBeTrue();
        expect(reconciliation.warningCount).toBe(0);
        const status = getClaimsBackfillStatus(db);
        expect(status.state).toBe("complete");
        // The DB-wide repair surface still reports the live-writer warning.
        expect(status.warningFailures).toBe(1);
    });

    test("a persistently blocked checkpoint skips the full re-scan while the failure set is unchanged", async () => {
        const { db } = migrateLazy([{ content: "blocked row", category: "" }]);
        const first = await runClaimsBackfill(db, { yieldToEventLoop: async () => {} });
        expect(first.status).toBe("blocked");
        expect(getClaimsBackfillStatus(db).phase).toBe("blocked");

        const second = await runClaimsBackfill(db, { yieldToEventLoop: async () => {} });
        expect(second.status).toBe("blocked");
        expect(second.batches).toBe(0);
        expect(second.rowsAdopted).toBe(0);
        expect(second.phaseAfter).toBe("blocked");
        expect(second.problems.join("\n")).toContain("unchanged since the last blocked run");
        expect(getClaimsBackfillStatus(db).phase).toBe("blocked");
    });

    test("a corpus change between the oracle read and finalize resets cursors for the re-derive", async () => {
        const { db, ids } = migrateLazy([
            { content: "lineage source", hash: "source" },
            { content: "lineage target", hash: "target", mergedFrom: "[1]" },
        ]);
        // One-shot writer race: after the oracle reads a clean report but
        // before finalize commits, the translated lineage disposition flips
        // back to blocking. The finalize recheck must fall back to the rows
        // phase with zeroed cursors so the relationships re-scan re-observes
        // memory 2 and re-resolves the disposition; stale cursors would skip
        // it and re-block behind an unchanged digest.
        let injected = false;
        setClaimsBackfillFailpoint("claims-backfill.025.reconcile-oracle.after", () => {
            if (injected) return;
            injected = true;
            db.prepare(
                `UPDATE claim_backfill_failures SET disposition = 'blocking'
                  WHERE phase = 'relationships' AND item_key LIKE ?`,
            ).run(`memory:${ids[1]}:%`);
        });

        const summary = await runClaimsBackfill(db, { yieldToEventLoop: async () => {} });
        expect(injected).toBeTrue();
        expect(summary.status).toBe("complete");
        expect(getClaimsBackfillStatus(db).phase).toBe("complete");
        expect(listClaimsBackfillFailures(db, { dispositions: ["blocking"] })).toHaveLength(0);
    });

    test("a takeover flip to pending between the oracle read and finalize does not certify complete", async () => {
        const { db } = migrateLazy([{ content: "takeover race row" }]);
        // One-shot writer race: syncClaimsTakeoverMeta is non-monotonic, so a
        // v22 runner can flip the takeover key none → pending after the
        // oracle reads a clean report but before finalize commits. The
        // finalize recheck must treat the pending takeover as decisive, like
        // the oracle does, instead of certifying completion over it.
        let injected = false;
        setClaimsBackfillFailpoint("claims-backfill.025.reconcile-oracle.after", () => {
            if (injected) return;
            injected = true;
            db.prepare(
                `INSERT INTO schema_migrations_meta (key, value) VALUES (?, 'pending')
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            ).run("claims_backfill_v22_takeover");
        });

        const summary = await runClaimsBackfill(db, { yieldToEventLoop: async () => {} });
        expect(injected).toBeTrue();
        expect(summary.status).toBe("blocked");
        expect(summary.problems.join("\n")).toContain("pending v22 identity work");
        expect(getClaimsBackfillStatus(db).phase).not.toBe("complete");
    });

    test("waiving the blocking failure changes the digest and the next start resets and completes", async () => {
        const { db } = migrateLazy([{ content: "lineage row", mergedFrom: "[999]" }]);
        expect((await runClaimsBackfill(db, { yieldToEventLoop: async () => {} })).status).toBe(
            "blocked",
        );
        expect((await runClaimsBackfill(db, { yieldToEventLoop: async () => {} })).batches).toBe(0);

        const [failure] = listClaimsBackfillFailures(db, { dispositions: ["blocking"] });
        expect(
            recordClaimsBackfillWarningDisposition(db, failure.id, "legacy source reviewed"),
        ).toEqual({ updated: true });

        const resumed = await runClaimsBackfill(db, { yieldToEventLoop: async () => {} });
        expect(resumed.status).toBe("complete-with-warnings");
        expect(resumed.batches).toBeGreaterThan(0);
        expect(getClaimsBackfillStatus(db).phase).toBe("complete");
    });

    test("doctor retry forces the reset past an unchanged blocked digest", async () => {
        const { db, ids } = migrateLazy([{ content: "repairable row", category: "" }]);
        expect((await runClaimsBackfill(db, { yieldToEventLoop: async () => {} })).status).toBe(
            "blocked",
        );

        // Repairing the source row leaves the failure surface untouched, so
        // the automatic start still skips; the operator escape is the forced
        // doctor retry.
        runInMemoryClaimsWriteTransaction(db, () => {
            db.prepare("UPDATE memories SET category = 'CONSTRAINTS' WHERE id = ?").run(ids[0]);
        });
        const skipped = await runClaimsBackfill(db, { yieldToEventLoop: async () => {} });
        expect(skipped.status).toBe("blocked");
        expect(skipped.batches).toBe(0);

        const retry = await doctorRetryClaimsBackfill(db, { yieldToEventLoop: async () => {} });
        expect(retry.summary?.status).toBe("complete");
        expect(retry.after.state).toBe("complete");
        expect(listClaimsBackfillFailures(db, { dispositions: ["blocking"] })).toHaveLength(0);
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

    test("existing outbox project corruption blocks final reconciliation", async () => {
        const { db } = migrateLazy([{ content: "outbox project oracle" }]);
        expect((await runClaimsBackfill(db, { yieldToEventLoop: async () => {} })).status).toBe(
            "complete",
        );
        const other = insertMemory(db, {
            projectPath: "git:claims-backfill-other",
            category: "CONSTRAINTS",
            content: "other project claim",
        });
        const source = db
            .prepare(
                "SELECT claim_id AS claimId FROM legacy_memory_claims ORDER BY memory_id LIMIT 1",
            )
            .get() as { claimId: number };
        const otherProject = db
            .prepare("SELECT project_id AS projectId FROM legacy_memory_claims WHERE memory_id = ?")
            .get(other.id) as { projectId: number };
        const operation = db
            .prepare("SELECT id FROM claim_operations ORDER BY id LIMIT 1")
            .get() as {
            id: number;
        };
        db.exec("DROP TRIGGER claim_change_outbox_project_guard");
        db.prepare(
            `INSERT INTO claim_change_outbox
                (operation_id, effect_key, project_id, claim_id, effect_type, generation, created_at)
             VALUES (?, 'forged:mismatched-project', ?, ?, 'upsert', 1, 1)`,
        ).run(operation.id, otherProject.projectId, source.claimId);

        const report = inspectClaimsBackfillReconciliation(db);
        expect(report.ok).toBeFalse();
        expect(report.problems).toContain("1 outbox effect(s) have a mismatched project");
    });

    test("completed status and doctor retry stay blocked on targeted claim foreign-key violations", async () => {
        const { db } = migrateLazy([{ content: "foreign key oracle" }]);
        expect((await runClaimsBackfill(db, { yieldToEventLoop: async () => {} })).status).toBe(
            "complete",
        );
        db.exec(`
            PRAGMA foreign_keys=OFF;
            DROP TRIGGER claim_change_outbox_project_guard;
        `);
        const operationId = (
            db.prepare("SELECT id FROM claim_operations LIMIT 1").get() as { id: number }
        ).id;
        db.prepare(
            `INSERT INTO claim_change_outbox
                (operation_id, effect_key, project_id, claim_id, effect_type, generation, created_at)
             VALUES (?, 'orphan:test', 999999, 999999, 'upsert', 1, 1)`,
        ).run(operationId);
        db.exec("PRAGMA foreign_keys=ON");

        const status = getClaimsBackfillStatus(db, { includeProblems: true });
        expect(status.state).toBe("blocked");
        expect(status.problems.join("\n")).toContain(
            "claim_change_outbox: 2 foreign key violation(s)",
        );
        const retry = await doctorRetryClaimsBackfill(db, { yieldToEventLoop: async () => {} });
        expect(retry.summary?.status).toBe("blocked");
        expect(retry.after.state).toBe("blocked");
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
