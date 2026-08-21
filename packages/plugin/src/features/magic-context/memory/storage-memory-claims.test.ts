/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { sha256Utf8Hex } from "./storage-claims";
import {
    ClaimOperationKeyReuseError,
    clearMemoryClaimFailpoints,
    createMemoryWithClaimsInCurrentTransaction,
    deleteMemoryWithClaimsInCurrentTransaction,
    findMemoryClaimsCompatCorruption,
    getCurrentMemoryClaimByLegacyMemoryId,
    hasMemoryClaimsCompatSchema,
    listCurrentMemoryClaimsByProject,
    MEMORY_CLAIM_FAILPOINT_IDS,
    type MemoryClaimFailpointId,
    type MemoryClaimOperationEnvelope,
    mergeMemoryStatsWithClaimsInCurrentTransaction,
    replaceMemoryVerificationFilesWithClaimsInCurrentTransaction,
    runInMemoryClaimsWriteTransaction,
    setMemoryClaimFailpoint,
    setMemoryStatusWithClaimsInCurrentTransaction,
    supersedeMemoryWithClaimsInCurrentTransaction,
    updateMemoryClassificationWithClaimsInCurrentTransaction,
    updateMemoryContentWithClaimsInCurrentTransaction,
    updateMemoryVerificationWithClaimsInCurrentTransaction,
} from "./storage-memory-claims";

const PROJECT = "git:kernel-project";

function migratedDb(): Database {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

/** Pre-v84 rows below the high-water boundary: inserted before migrations run. */
function v82DatabaseWithRows(contents: readonly string[], projectPath = PROJECT): Database {
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

function envelope(operationKey: string, request: unknown): MemoryClaimOperationEnvelope {
    return {
        producer: "kernel-test",
        operationKey,
        requestDigest: sha256Utf8Hex(JSON.stringify(request)),
    };
}

function count(db: Database, table: string, where = "1=1"): number {
    return (
        db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get() as {
            count: number;
        }
    ).count;
}

function snapshotCounts(db: Database): Record<string, number> {
    const tables = [
        "memories",
        "memory_stats",
        "claims",
        "claim_revisions",
        "claim_evidence",
        "claim_revision_memory_metadata",
        "legacy_memory_claims",
        "claim_operations",
        "claim_change_outbox",
        "claim_project_generations",
        "verification_events",
        "episodes",
        "observations",
    ];
    return Object.fromEntries(tables.map((table) => [table, count(db, table)]));
}

function createSeedMemory(
    db: Database,
    key: string,
    content: string,
    projectPath = PROJECT,
): { memoryId: number; claimId: number; revisionId: number } {
    const outcome = runInMemoryClaimsWriteTransaction(db, () =>
        createMemoryWithClaimsInCurrentTransaction(db, envelope(key, { key, content }), {
            projectPath,
            category: "CONSTRAINTS",
            content,
            normalizedHash: `hash:${content}`,
            importance: 60,
            sourceSessionId: "ses-kernel",
            sourceType: "agent",
            nowMs: 1_000,
        }),
    );
    if (outcome.result.claimId === null || outcome.result.revisionId === null) {
        throw new Error("seed memory did not link");
    }
    return {
        memoryId: outcome.result.memoryId,
        claimId: outcome.result.claimId,
        revisionId: outcome.result.revisionId,
    };
}

const openDbs: Database[] = [];
function track(db: Database): Database {
    openDbs.push(db);
    return db;
}

afterEach(() => {
    clearMemoryClaimFailpoints();
    while (openDbs.length > 0) closeQuietly(openDbs.pop());
});

describe("memory/claims kernel: new memory", () => {
    test("commits revision 1, exact revision metadata, crosswalk, projection, one outbox effect, one generation bump, stats, and FTS", () => {
        const db = track(migratedDb());
        const seeded = createSeedMemory(db, "create-1", "kernel fact one");

        const claim = db.prepare("SELECT * FROM claims WHERE id = ?").get(seeded.claimId) as
            | Record<string, unknown>
            | undefined;
        expect(claim?.subject).toBe(`legacy-memory:${seeded.memoryId}`);
        expect(claim?.predicate).toBe("states");
        expect(claim?.scope).toBe("project-memory");
        expect(claim?.state).toBe("active");
        const revision = db
            .prepare("SELECT * FROM claim_revisions WHERE id = ?")
            .get(seeded.revisionId) as Record<string, unknown>;
        expect(revision.revision).toBe(1);
        expect(revision.content).toBe("kernel fact one");
        expect(revision.content_sha256).toBe(sha256Utf8Hex("kernel fact one"));
        expect(
            db
                .prepare("SELECT * FROM claim_revision_memory_metadata WHERE revision_id = ?")
                .get(seeded.revisionId),
        ).toMatchObject({
            category: "CONSTRAINTS",
            normalized_hash: "hash:kernel fact one",
            importance: 60,
            memory_scope: "project",
            shareable: 0,
            source_type: "agent",
            expires_at: null,
            metadata_json: null,
        });
        expect(
            db
                .prepare("SELECT * FROM legacy_memory_claims WHERE memory_id = ?")
                .get(seeded.memoryId),
        ).toMatchObject({
            memory_id: seeded.memoryId,
            canonical_memory_id: seeded.memoryId,
            claim_id: seeded.claimId,
        });
        expect(count(db, "claim_evidence", `revision_id = ${seeded.revisionId}`)).toBe(1);
        const projection = db
            .prepare("SELECT * FROM memories WHERE id = ?")
            .get(seeded.memoryId) as Record<string, unknown>;
        expect(projection.content).toBe("kernel fact one");
        expect(projection.status).toBe("active");
        expect(projection.source_session_id).toBe("ses-kernel");
        expect(
            db
                .prepare("SELECT seen_count FROM memory_stats WHERE memory_id = ?")
                .get(seeded.memoryId),
        ).toEqual({ seen_count: 1 });
        expect(
            db
                .prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'kernel'")
                .all()
                .map((row) => (row as { rowid: number }).rowid),
        ).toEqual([seeded.memoryId]);
        const outbox = db.prepare("SELECT * FROM claim_change_outbox").all() as Array<
            Record<string, unknown>
        >;
        expect(outbox).toHaveLength(1);
        expect(outbox[0]).toMatchObject({
            effect_key: `memory:${seeded.memoryId}:upsert`,
            claim_id: seeded.claimId,
            effect_type: "upsert",
            generation: 1,
        });
        expect(count(db, "claim_project_generations")).toBe(1);
        expect(
            (
                db.prepare("SELECT generation FROM claim_project_generations").get() as {
                    generation: number;
                }
            ).generation,
        ).toBe(1);
        expect(count(db, "claim_operations", "operation_key = 'create-1'")).toBe(1);
    });

    test("live provenance records the operation locator and source session", () => {
        const db = track(migratedDb());
        const seeded = createSeedMemory(db, "provenance-1", "provenance fact");
        const chain = db
            .prepare(
                `SELECT episodes.source_session_id AS session, source_spans.source_locator AS locator,
                        observations.extractor AS extractor
                   FROM claim_evidence
                   JOIN observations ON observations.id = claim_evidence.observation_id
                   JOIN source_spans ON source_spans.id = observations.source_span_id
                   JOIN episodes ON episodes.id = source_spans.episode_id
                  WHERE claim_evidence.revision_id = ?`,
            )
            .get(seeded.revisionId) as { session: string; locator: string; extractor: string };
        expect(chain.session).toBe("ses-kernel");
        expect(chain.locator).toBe("operation://kernel-test/provenance-1");
        expect(chain.extractor).toBe("kernel-test");
    });
});

describe("memory/claims kernel: content and classification updates", () => {
    test("a content update appends revision 2 while revision 1 and its metadata stay byte-identical", () => {
        const db = track(migratedDb());
        const seeded = createSeedMemory(db, "update-seed", "original wording");
        const revision1 = JSON.stringify(
            db.prepare("SELECT * FROM claim_revisions WHERE id = ?").get(seeded.revisionId),
        );
        const metadata1 = JSON.stringify(
            db
                .prepare("SELECT * FROM claim_revision_memory_metadata WHERE revision_id = ?")
                .get(seeded.revisionId),
        );

        const outcome = runInMemoryClaimsWriteTransaction(db, () =>
            updateMemoryContentWithClaimsInCurrentTransaction(
                db,
                envelope("update-1", { id: seeded.memoryId }),
                {
                    memoryId: seeded.memoryId,
                    content: "revised wording",
                    normalizedHash: "hash:revised wording",
                },
            ),
        );
        expect(outcome.result.revisionId).not.toBe(seeded.revisionId);
        const revision2 = db
            .prepare("SELECT * FROM claim_revisions WHERE id = ?")
            .get(outcome.result.revisionId as number) as Record<string, unknown>;
        expect(revision2.revision).toBe(2);
        expect(revision2.content).toBe("revised wording");
        expect(
            JSON.stringify(
                db.prepare("SELECT * FROM claim_revisions WHERE id = ?").get(seeded.revisionId),
            ),
        ).toBe(revision1);
        expect(
            JSON.stringify(
                db
                    .prepare("SELECT * FROM claim_revision_memory_metadata WHERE revision_id = ?")
                    .get(seeded.revisionId),
            ),
        ).toBe(metadata1);
        expect(
            db.prepare("SELECT content FROM memories WHERE id = ?").get(seeded.memoryId),
        ).toEqual({ content: "revised wording" });
        expect(count(db, "claim_change_outbox")).toBe(2);
        expect(
            (
                db.prepare("SELECT generation FROM claim_project_generations").get() as {
                    generation: number;
                }
            ).generation,
        ).toBe(2);
    });

    test("a classification-only change appends a same-content revision with new metadata; a seen-count bump touches only memory_stats", () => {
        const db = track(migratedDb());
        const seeded = createSeedMemory(db, "classify-seed", "classified fact");

        runInMemoryClaimsWriteTransaction(db, () =>
            updateMemoryClassificationWithClaimsInCurrentTransaction(
                db,
                envelope("classify-1", { id: seeded.memoryId }),
                { memoryId: seeded.memoryId, importance: 95, scope: "ecosystem", shareable: 1 },
            ),
        );
        const current = getCurrentMemoryClaimByLegacyMemoryId(db, seeded.memoryId);
        expect(current?.revision).toBe(2);
        expect(current?.content).toBe("classified fact");
        expect(current).toMatchObject({ importance: 95, memoryScope: "ecosystem", shareable: 1 });
        expect(
            db
                .prepare("SELECT importance, scope, shareable FROM memories WHERE id = ?")
                .get(seeded.memoryId),
        ).toEqual({ importance: 95, scope: "ecosystem", shareable: 1 });

        const before = snapshotCounts(db);
        db.prepare(
            "UPDATE memory_stats SET seen_count = seen_count + 1, last_seen_at = 9, updated_at = 9 WHERE memory_id = ?",
        ).run(seeded.memoryId);
        const after = snapshotCounts(db);
        expect(after).toEqual(before);
        expect(
            db
                .prepare("SELECT seen_count FROM memory_stats WHERE memory_id = ?")
                .get(seeded.memoryId),
        ).toEqual({ seen_count: 2 });
    });
});

describe("memory/claims kernel: atomicity and idempotency", () => {
    test.each([
        "memory-claim.010.claim.after",
        "memory-claim.020.projection.after",
        "memory-claim.030.outbox.after",
        "memory-claim.040.generation.after",
        "memory-claim.050.commit.before",
    ] as MemoryClaimFailpointId[])("a failure at %s rolls back the whole tuple", (failpointId) => {
        const db = track(migratedDb());
        createSeedMemory(db, "atomic-baseline", "baseline fact");
        const before = snapshotCounts(db);
        setMemoryClaimFailpoint(failpointId, () => {
            throw new Error(`injected failure at ${failpointId}`);
        });
        expect(() =>
            runInMemoryClaimsWriteTransaction(db, () =>
                createMemoryWithClaimsInCurrentTransaction(
                    db,
                    envelope(`atomic-${failpointId}`, { failpointId }),
                    {
                        projectPath: PROJECT,
                        category: "CONSTRAINTS",
                        content: `doomed at ${failpointId}`,
                        normalizedHash: `hash:doomed-${failpointId}`,
                    },
                ),
            ),
        ).toThrow(`injected failure at ${failpointId}`);
        expect(snapshotCounts(db)).toEqual(before);
        // The capability never leaks past the failed transaction.
        expect(
            db
                .prepare(
                    "SELECT COALESCE((SELECT enabled FROM claim_compatibility_write_state WHERE id = 1), 0) AS enabled",
                )
                .get(),
        ).toEqual({ enabled: 0 });
        clearMemoryClaimFailpoints();
    });

    test("the failpoint registry covers every stable memory-claim site", () => {
        expect([...MEMORY_CLAIM_FAILPOINT_IDS]).toEqual([
            "memory-claim.010.claim.after",
            "memory-claim.020.projection.after",
            "memory-claim.030.outbox.after",
            "memory-claim.040.generation.after",
            "memory-claim.050.commit.before",
            "memory-claim.060.commit.after",
            "memory-claim.070.ack.after",
        ]);
    });

    test("replaying an operation key returns the committed result with zero new effects", () => {
        const db = track(migratedDb());
        const request = { key: "replay-1", content: "replayed fact" };
        const first = runInMemoryClaimsWriteTransaction(db, () =>
            createMemoryWithClaimsInCurrentTransaction(db, envelope("replay-1", request), {
                projectPath: PROJECT,
                category: "CONSTRAINTS",
                content: "replayed fact",
                normalizedHash: "hash:replayed fact",
            }),
        );
        expect(first.replayed).toBeFalse();
        const before = snapshotCounts(db);
        const second = runInMemoryClaimsWriteTransaction(db, () =>
            createMemoryWithClaimsInCurrentTransaction(db, envelope("replay-1", request), {
                projectPath: PROJECT,
                category: "CONSTRAINTS",
                content: "replayed fact",
                normalizedHash: "hash:replayed fact",
            }),
        );
        expect(second.replayed).toBeTrue();
        expect(second.result).toEqual(first.result);
        expect(snapshotCounts(db)).toEqual(before);
    });

    test("reusing an operation key with a different digest fails and preserves the original result", () => {
        const db = track(migratedDb());
        const first = runInMemoryClaimsWriteTransaction(db, () =>
            createMemoryWithClaimsInCurrentTransaction(
                db,
                envelope("reuse-1", { attempt: "first" }),
                {
                    projectPath: PROJECT,
                    category: "CONSTRAINTS",
                    content: "first request",
                    normalizedHash: "hash:first request",
                },
            ),
        );
        const before = snapshotCounts(db);
        expect(() =>
            runInMemoryClaimsWriteTransaction(db, () =>
                createMemoryWithClaimsInCurrentTransaction(
                    db,
                    envelope("reuse-1", { attempt: "second" }),
                    {
                        projectPath: PROJECT,
                        category: "CONSTRAINTS",
                        content: "second request",
                        normalizedHash: "hash:second request",
                    },
                ),
            ),
        ).toThrow(ClaimOperationKeyReuseError);
        expect(snapshotCounts(db)).toEqual(before);
        expect(
            db
                .prepare(
                    "SELECT result_json FROM claim_operations WHERE producer = 'kernel-test' AND operation_key = 'reuse-1'",
                )
                .get(),
        ).toEqual({ result_json: JSON.stringify(first.result) });
    });
});

describe("memory/claims kernel: preimage adoption (R10)", () => {
    test("a semantic mutation of an unlinked boundary row adopts the preimage as revision 1 before applying the change", () => {
        const db = track(v82DatabaseWithRows(["unlinked preimage"]));
        const memoryId = (db.prepare("SELECT id FROM memories LIMIT 1").get() as { id: number }).id;
        expect(count(db, "legacy_memory_claims")).toBe(0);

        runInMemoryClaimsWriteTransaction(db, () =>
            updateMemoryContentWithClaimsInCurrentTransaction(
                db,
                envelope("adopt-1", { memoryId }),
                {
                    memoryId,
                    content: "post-adoption wording",
                    normalizedHash: "hash:post-adoption wording",
                },
            ),
        );

        const current = getCurrentMemoryClaimByLegacyMemoryId(db, memoryId);
        expect(current?.revision).toBe(2);
        expect(current?.content).toBe("post-adoption wording");
        const revisions = db
            .prepare(
                "SELECT revision, content FROM claim_revisions WHERE claim_id = ? ORDER BY revision",
            )
            .all(current?.claimId as number) as Array<{ revision: number; content: string }>;
        expect(revisions).toEqual([
            { revision: 1, content: "unlinked preimage" },
            { revision: 2, content: "post-adoption wording" },
        ]);
        // The adopted preimage carries migration provenance keyed by the
        // legacy memory id (R4).
        const rootLocator = db
            .prepare(
                `SELECT source_spans.source_locator AS locator
                   FROM legacy_memory_claims
                   JOIN observations ON observations.id = legacy_memory_claims.root_observation_id
                   JOIN source_spans ON source_spans.id = observations.source_span_id
                  WHERE legacy_memory_claims.memory_id = ?`,
            )
            .get(memoryId) as { locator: string };
        expect(rootLocator.locator).toBe(`legacy-memory://${memoryId}`);
    });
});

describe("memory/claims kernel: lifecycle, merge, and verification", () => {
    test("archive sets claim state archived with one archive event, one lifecycle effect, one bump", () => {
        const db = track(migratedDb());
        const seeded = createSeedMemory(db, "archive-seed", "archive target");
        runInMemoryClaimsWriteTransaction(db, () =>
            setMemoryStatusWithClaimsInCurrentTransaction(
                db,
                envelope("archive-1", { id: seeded.memoryId }),
                {
                    memoryId: seeded.memoryId,
                    status: "archived",
                    metadataJson: JSON.stringify({ archive_reason: "done" }),
                },
            ),
        );
        expect(db.prepare("SELECT state FROM claims WHERE id = ?").get(seeded.claimId)).toEqual({
            state: "archived",
        });
        expect(count(db, "verification_events", "outcome = 'archive'")).toBe(1);
        expect(
            db
                .prepare("SELECT status, metadata_json FROM memories WHERE id = ?")
                .get(seeded.memoryId),
        ).toEqual({
            status: "archived",
            metadata_json: JSON.stringify({ archive_reason: "done" }),
        });
        expect(count(db, "claim_change_outbox", "effect_type = 'lifecycle'")).toBe(1);
    });

    test("delete retires the claim, removes the projection, and retains the crosswalk", () => {
        const db = track(migratedDb());
        const seeded = createSeedMemory(db, "delete-seed", "delete target");
        runInMemoryClaimsWriteTransaction(db, () =>
            deleteMemoryWithClaimsInCurrentTransaction(
                db,
                envelope("delete-1", { id: seeded.memoryId }),
                { memoryId: seeded.memoryId },
            ),
        );
        expect(db.prepare("SELECT 1 FROM memories WHERE id = ?").get(seeded.memoryId)).toBeNull();
        expect(count(db, "legacy_memory_claims", `memory_id = ${seeded.memoryId}`)).toBe(1);
        expect(db.prepare("SELECT state FROM claims WHERE id = ?").get(seeded.claimId)).toEqual({
            state: "archived",
        });
    });

    test("re-adding deleted content links the new row as a duplicate of the canonical claim and reactivates it", () => {
        const db = track(migratedDb());
        const seeded = createSeedMemory(db, "readd-seed", "readd target");
        runInMemoryClaimsWriteTransaction(db, () =>
            deleteMemoryWithClaimsInCurrentTransaction(
                db,
                envelope("readd-delete", { id: seeded.memoryId }),
                { memoryId: seeded.memoryId },
            ),
        );
        const readded = createSeedMemory(db, "readd-create", "readd target");
        expect(readded.claimId).toBe(seeded.claimId);
        expect(readded.memoryId).not.toBe(seeded.memoryId);
        const link = db
            .prepare(
                "SELECT canonical_memory_id AS canonical FROM legacy_memory_claims WHERE memory_id = ?",
            )
            .get(readded.memoryId) as { canonical: number };
        expect(link.canonical).toBe(seeded.memoryId);
        expect(db.prepare("SELECT state FROM claims WHERE id = ?").get(seeded.claimId)).toEqual({
            state: "active",
        });
    });

    test("same-project supersession records a supersedes conflict and retires the source claim", () => {
        const db = track(migratedDb());
        const source = createSeedMemory(db, "supersede-source", "old wording fact");
        const target = createSeedMemory(db, "supersede-target", "new wording fact");
        runInMemoryClaimsWriteTransaction(db, () =>
            supersedeMemoryWithClaimsInCurrentTransaction(
                db,
                envelope("supersede-1", { source: source.memoryId }),
                { memoryId: source.memoryId, supersededByMemoryId: target.memoryId },
            ),
        );
        expect(
            db
                .prepare(
                    "SELECT relation, left_revision_id, right_revision_id FROM claim_conflicts",
                )
                .get(),
        ).toEqual({
            relation: "supersedes",
            left_revision_id: target.revisionId,
            right_revision_id: source.revisionId,
        });
        expect(db.prepare("SELECT state FROM claims WHERE id = ?").get(source.claimId)).toEqual({
            state: "archived",
        });
        expect(
            db
                .prepare("SELECT status, superseded_by_memory_id FROM memories WHERE id = ?")
                .get(source.memoryId),
        ).toEqual({ status: "archived", superseded_by_memory_id: target.memoryId });
        // One bump per touched project: both effects share one project here.
        expect(
            count(
                db,
                "claim_change_outbox",
                "operation_id = (SELECT id FROM claim_operations WHERE operation_key = 'supersede-1')",
            ),
        ).toBe(2);
    });

    test("a cross-project supersession records audit-only merge lineage instead of a conflict", () => {
        const db = track(migratedDb());
        const source = createSeedMemory(db, "xp-source", "cross project source", "git:project-a");
        const target = createSeedMemory(db, "xp-target", "cross project target", "git:project-b");
        runInMemoryClaimsWriteTransaction(db, () =>
            supersedeMemoryWithClaimsInCurrentTransaction(
                db,
                envelope("xp-supersede", { source: source.memoryId }),
                { memoryId: source.memoryId, supersededByMemoryId: target.memoryId },
            ),
        );
        expect(count(db, "claim_conflicts")).toBe(0);
        const lineage = db.prepare("SELECT * FROM claim_merge_lineage").get() as Record<
            string,
            unknown
        >;
        expect(lineage).toMatchObject({
            source_revision_id: source.revisionId,
            target_revision_id: target.revisionId,
        });
        expect(lineage.source_project_id).not.toBe(lineage.target_project_id);
        // Two touched projects: one generation bump each.
        expect(count(db, "claim_project_generations")).toBe(2);
    });

    test("merge stats follows claim lifecycle from the new status and keeps counters in memory_stats", () => {
        const db = track(migratedDb());
        const seeded = createSeedMemory(db, "merge-seed", "merge canonical");
        runInMemoryClaimsWriteTransaction(db, () =>
            mergeMemoryStatsWithClaimsInCurrentTransaction(
                db,
                envelope("merge-1", { id: seeded.memoryId }),
                {
                    memoryId: seeded.memoryId,
                    seenCount: 7,
                    retrievalCount: 3,
                    mergedFrom: "[42]",
                    status: "permanent",
                },
            ),
        );
        expect(db.prepare("SELECT state FROM claims WHERE id = ?").get(seeded.claimId)).toEqual({
            state: "permanent",
        });
        expect(
            db
                .prepare("SELECT merged_from, status FROM memories WHERE id = ?")
                .get(seeded.memoryId),
        ).toEqual({ merged_from: "[42]", status: "permanent" });
        expect(
            db
                .prepare("SELECT seen_count, retrieval_count FROM memory_stats WHERE memory_id = ?")
                .get(seeded.memoryId),
        ).toEqual({ seen_count: 7, retrieval_count: 3 });
        // No revision for a lifecycle/merge marker change (R3).
        expect(count(db, "claim_revisions", `claim_id = ${seeded.claimId}`)).toBe(1);
    });

    test("verification outcomes append events; mapped-only file snapshots do not (KTD5)", () => {
        const db = track(migratedDb());
        const seeded = createSeedMemory(db, "verify-seed", "verify target");

        const mapped = runInMemoryClaimsWriteTransaction(db, () =>
            replaceMemoryVerificationFilesWithClaimsInCurrentTransaction(
                db,
                envelope("map-1", { id: seeded.memoryId }),
                { memoryId: seeded.memoryId, files: ["src/a.ts"], now: 5_000, verified: false },
            ),
        );
        expect(mapped.result.rowsWritten).toBe(1);
        expect(count(db, "verification_events")).toBe(0);
        expect(count(db, "claim_change_outbox", "effect_type = 'evidence'")).toBe(0);

        runInMemoryClaimsWriteTransaction(db, () =>
            replaceMemoryVerificationFilesWithClaimsInCurrentTransaction(
                db,
                envelope("verify-1", { id: seeded.memoryId }),
                { memoryId: seeded.memoryId, files: ["src/a.ts"], now: 6_000, verified: true },
            ),
        );
        expect(count(db, "verification_events", "outcome = 'verified'")).toBe(1);
        expect(
            db
                .prepare(
                    "SELECT verified_at FROM memory_verifications WHERE memory_id = ? AND file_path = 'src/a.ts'",
                )
                .get(seeded.memoryId),
        ).toEqual({ verified_at: 6_000 });

        runInMemoryClaimsWriteTransaction(db, () =>
            updateMemoryVerificationWithClaimsInCurrentTransaction(
                db,
                envelope("verify-2", { id: seeded.memoryId }),
                { memoryId: seeded.memoryId, verificationStatus: "stale" },
            ),
        );
        expect(count(db, "verification_events", "outcome = 'stale'")).toBe(1);
        expect(
            db
                .prepare("SELECT verification_status FROM memories WHERE id = ?")
                .get(seeded.memoryId),
        ).toEqual({ verification_status: "stale" });
    });
});

describe("memory/claims kernel: unresolved identity fallback", () => {
    test("a raw legacy project path applies the projection and records a blocking backfill failure instead of inventing claim state", () => {
        const db = track(migratedDb());
        const outcome = runInMemoryClaimsWriteTransaction(db, () =>
            createMemoryWithClaimsInCurrentTransaction(db, envelope("raw-path-1", { raw: true }), {
                projectPath: "/legacy/raw-path",
                category: "CONSTRAINTS",
                content: "raw path fact",
                normalizedHash: "hash:raw path fact",
            }),
        );
        expect(outcome.result.claimId).toBeNull();
        expect(count(db, "claims")).toBe(0);
        expect(count(db, "claim_change_outbox")).toBe(0);
        expect(
            db.prepare("SELECT 1 FROM memories WHERE id = ?").get(outcome.result.memoryId),
        ).toBeTruthy();
        expect(
            db
                .prepare(
                    "SELECT phase, item_kind, reason_code, disposition FROM claim_backfill_failures WHERE item_key = ?",
                )
                .get(String(outcome.result.memoryId)),
        ).toEqual({
            phase: "rows",
            item_kind: "memory",
            reason_code: "unresolved-project-identity",
            disposition: "blocking",
        });
    });
});

describe("memory/claims kernel: current-claim reads and corruption reporting", () => {
    test("reads by project and by legacy memory id resolve the current revision with metadata", () => {
        const db = track(migratedDb());
        const first = createSeedMemory(db, "read-1", "read fact one");
        const second = createSeedMemory(db, "read-2", "read fact two");
        const projectId = (
            db
                .prepare("SELECT project_id AS id FROM project_aliases WHERE alias_identity = ?")
                .get(PROJECT) as { id: number }
        ).id;
        const listed = listCurrentMemoryClaimsByProject(db, projectId);
        expect(listed.map((record) => record.memoryId)).toEqual([first.memoryId, second.memoryId]);
        const single = getCurrentMemoryClaimByLegacyMemoryId(db, second.memoryId);
        expect(single).toMatchObject({
            claimId: second.claimId,
            content: "read fact two",
            category: "CONSTRAINTS",
            state: "active",
            revision: 1,
        });
        expect(getCurrentMemoryClaimByLegacyMemoryId(db, 424_242)).toBeNull();
        expect(hasMemoryClaimsCompatSchema(db)).toBeTrue();
    });

    test("missing revision metadata and invalid crosswalks are reported as corruption", () => {
        const db = track(migratedDb());
        const seeded = createSeedMemory(db, "corrupt-1", "corruption target");
        expect(findMemoryClaimsCompatCorruption(db)).toEqual({
            revisionIdsMissingMemoryMetadata: [],
            invalidCrosswalkMemoryIds: [],
        });
        // Only direct SQL can produce these shapes: simulate by dropping the
        // append-only guards on the metadata table and crosswalk.
        db.exec(`
            DROP TRIGGER claim_revision_memory_metadata_append_only_delete;
            DELETE FROM claim_revision_memory_metadata WHERE revision_id = ${seeded.revisionId};
            DROP TRIGGER legacy_memory_claims_append_only_update;
            UPDATE legacy_memory_claims SET canonical_memory_id = 777 WHERE memory_id = ${seeded.memoryId};
        `);
        const report = findMemoryClaimsCompatCorruption(db);
        expect(report.revisionIdsMissingMemoryMetadata).toEqual([seeded.revisionId]);
        expect(report.invalidCrosswalkMemoryIds).toEqual([seeded.memoryId]);
        expect(() => getCurrentMemoryClaimByLegacyMemoryId(db, seeded.memoryId)).toThrow(
            /no memory metadata row/,
        );
    });
});
