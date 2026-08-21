/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { inspectClaimsBackfillReconciliation } from "../claims-backfill";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { sha256Utf8Hex } from "./storage-claims";
import {
    applyModuleMemoryDeltaWithClaimsInCurrentTransaction,
    ClaimOperationKeyReuseError,
    canonicalMemoryProjectPathSql,
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
    memoryClaimSupersessionExists,
    mergeMemoryStatsWithClaimsInCurrentTransaction,
    readMemoryClaimLink,
    replaceMemoryVerificationFilesWithClaimsInCurrentTransaction,
    runInMemoryClaimsWriteTransaction,
    setMemoryClaimFailpoint,
    setMemoryStatusWithClaimsInCurrentTransaction,
    supersedeMemoryWithClaimsInCurrentTransaction,
    updateMemoryClassificationWithClaimsInCurrentTransaction,
    updateMemoryContentWithClaimsInCurrentTransaction,
    updateMemoryVerificationWithClaimsInCurrentTransaction,
} from "./storage-memory-claims";
import { recordMemoryMapping, recordMemoryVerifications } from "./storage-memory-verifications";

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

    test("a content update on a verified memory records a verified event on the new revision", () => {
        const db = track(migratedDb());
        const projectionSeed = createSeedMemory(db, "verified-update-seed", "projection verified");
        const sideTableSeed = createSeedMemory(db, "side-verified-update-seed", "side verified");
        runInMemoryClaimsWriteTransaction(db, () => {
            db.prepare(
                "UPDATE memories SET verification_status = 'verified', verified_at = 123 WHERE id = ?",
            ).run(projectionSeed.memoryId);
            // Pre-v84 TypeScript verification: positive verified_at lives only
            // in memory_verifications; the projection columns stay unverified.
            db.prepare(
                `INSERT INTO memory_verifications (memory_id, file_path, verified_at, mapped_at)
                 VALUES (?, 'src/compat.ts', 123, 100)`,
            ).run(sideTableSeed.memoryId);
        });

        for (const [key, seeded] of [
            ["verified-update-1", projectionSeed],
            ["side-verified-update-1", sideTableSeed],
        ] as const) {
            const outcome = runInMemoryClaimsWriteTransaction(db, () =>
                updateMemoryContentWithClaimsInCurrentTransaction(db, envelope(key, { key }), {
                    memoryId: seeded.memoryId,
                    content: `${key} rewritten`,
                    normalizedHash: `hash:${key} rewritten`,
                }),
            );
            expect(outcome.result.revisionId).not.toBeNull();
            // The verified event attaches to the NEW current revision, with a
            // matching evidence effect in the operation's outbox.
            expect(
                db
                    .prepare(
                        "SELECT outcome, verifier FROM verification_events WHERE revision_id = ?",
                    )
                    .all(outcome.result.revisionId),
            ).toEqual([{ outcome: "verified", verifier: "kernel-test" }]);
            expect(
                count(
                    db,
                    "claim_change_outbox",
                    `effect_type = 'evidence' AND effect_key = 'memory:${seeded.memoryId}:evidence'
                     AND operation_id = (SELECT id FROM claim_operations WHERE operation_key = '${key}')`,
                ),
            ).toBe(1);
        }
    });

    test("a content update that repairs an empty-content row adopts the repaired postimage in the same operation", () => {
        const db = track(migratedDb());
        let memoryId = 0;
        runInMemoryClaimsWriteTransaction(db, () => {
            memoryId = Number(
                db
                    .prepare(
                        `INSERT INTO memories (project_path, category, content, normalized_hash,
                            seen_count, retrieval_count, first_seen_at, created_at, updated_at, last_seen_at)
                         VALUES (?, 'CONSTRAINTS', '', 'hash:repairable empty', 1, 0, 1, 1, 1, 1)`,
                    )
                    .run(PROJECT).lastInsertRowid,
            );
        });
        // A prior claims-aware write records the blocking empty-content failure.
        runInMemoryClaimsWriteTransaction(db, () =>
            setMemoryStatusWithClaimsInCurrentTransaction(
                db,
                envelope("repair-empty-0", { id: memoryId }),
                { memoryId, status: "active" },
            ),
        );
        expect(
            db
                .prepare("SELECT disposition FROM claim_backfill_failures WHERE item_key = ?")
                .get(String(memoryId)),
        ).toEqual({ disposition: "blocking" });

        const outcome = runInMemoryClaimsWriteTransaction(db, () =>
            updateMemoryContentWithClaimsInCurrentTransaction(
                db,
                envelope("repair-empty-1", { id: memoryId }),
                {
                    memoryId,
                    content: "repaired wording",
                    normalizedHash: "hash:repaired wording",
                },
            ),
        );

        // The repaired postimage links inside the same operation: real claim
        // and revision ids, an upsert effect, and the failure resolves.
        expect(outcome.result.claimId).not.toBeNull();
        expect(outcome.result.revisionId).not.toBeNull();
        expect(readMemoryClaimLink(db, memoryId)?.claimId).toBe(outcome.result.claimId as number);
        const claim = getCurrentMemoryClaimByLegacyMemoryId(db, memoryId);
        expect(claim?.content).toBe("repaired wording");
        expect(
            count(
                db,
                "claim_change_outbox",
                `effect_type = 'upsert' AND effect_key = 'memory:${memoryId}:upsert'
                 AND operation_id = (SELECT id FROM claim_operations WHERE operation_key = 'repair-empty-1')`,
            ),
        ).toBe(1);
        expect(
            db
                .prepare("SELECT disposition FROM claim_backfill_failures WHERE item_key = ?")
                .get(String(memoryId)),
        ).toEqual({ disposition: "resolved" });
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

    test("a content update without a source session carries the row's session; a telemetry-only delta appends nothing", () => {
        const db = track(migratedDb());
        const seeded = createSeedMemory(db, "content-session-seed", "session default fact");

        const updated = runInMemoryClaimsWriteTransaction(db, () =>
            updateMemoryContentWithClaimsInCurrentTransaction(
                db,
                envelope("content-session-1", { id: seeded.memoryId }),
                {
                    memoryId: seeded.memoryId,
                    content: "session default fact v2",
                    normalizedHash: "hash:session default fact v2",
                    nowMs: 2_000,
                },
            ),
        );
        expect(updated.result.revisionId).not.toBeNull();
        expect(
            db
                .prepare("SELECT source_session_id AS session FROM claim_revisions WHERE id = ?")
                .get(updated.result.revisionId),
        ).toEqual({ session: "ses-kernel" });

        // The revision carries the row's session, so a following module
        // snapshot with an unchanged postimage appends nothing.
        const before = snapshotCounts(db);
        const delta = runInMemoryClaimsWriteTransaction(db, () =>
            applyModuleMemoryDeltaWithClaimsInCurrentTransaction(
                db,
                envelope("content-session-2", { id: seeded.memoryId }),
                { memoryId: seeded.memoryId, applyProjection: () => {} },
            ),
        );
        expect(delta.result.revisionId).toBeNull();
        const after = snapshotCounts(db);
        expect(after.claim_revisions).toBe(before.claim_revisions);
        expect(after.claim_change_outbox).toBe(before.claim_change_outbox);
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

    test("deleting one projection of a shared canonical claim retires the claim only with its last live link", () => {
        const db = track(migratedDb());
        const survivor = createSeedMemory(db, "shared-dup", "shared claim fact");
        // The live-DB shape after an identity merge: a second path string
        // aliased to the same project, so the unique (path, category, hash)
        // projection index admits a duplicate row that dedups onto the
        // survivor's canonical claim.
        const aliasPath = "git:kernel-project-alias";
        const projectId = (
            db
                .prepare("SELECT project_id AS id FROM project_aliases WHERE alias_identity = ?")
                .get(PROJECT) as { id: number }
        ).id;
        db.prepare(
            "INSERT INTO project_aliases (alias_identity, project_id, created_at) VALUES (?, ?, 1)",
        ).run(aliasPath, projectId);
        let sourceId = 0;
        runInMemoryClaimsWriteTransaction(db, () => {
            sourceId = Number(
                db
                    .prepare(
                        `INSERT INTO memories (project_path, category, content, normalized_hash,
                            seen_count, retrieval_count, first_seen_at, created_at, updated_at, last_seen_at)
                         VALUES (?, 'CONSTRAINTS', ?, ?, 1, 0, 1, 1, 1, 1)`,
                    )
                    .run(aliasPath, "shared claim fact", "hash:shared claim fact").lastInsertRowid,
            );
        });

        // Archiving the source links it as a duplicate of the shared claim
        // but leaves the claim active: the survivor link is still live.
        runInMemoryClaimsWriteTransaction(db, () =>
            setMemoryStatusWithClaimsInCurrentTransaction(
                db,
                envelope("shared-archive-src", { id: sourceId }),
                { memoryId: sourceId, status: "archived" },
            ),
        );
        expect(count(db, "legacy_memory_claims", `claim_id = ${survivor.claimId}`)).toBe(2);
        expect(db.prepare("SELECT state FROM claims WHERE id = ?").get(survivor.claimId)).toEqual({
            state: "active",
        });
        expect(count(db, "verification_events", "outcome = 'archive'")).toBe(0);

        // Deleting the archived source leaves the shared claim and its
        // lifecycle stream untouched.
        runInMemoryClaimsWriteTransaction(db, () =>
            deleteMemoryWithClaimsInCurrentTransaction(
                db,
                envelope("shared-delete-src", { id: sourceId }),
                { memoryId: sourceId },
            ),
        );
        expect(db.prepare("SELECT state FROM claims WHERE id = ?").get(survivor.claimId)).toEqual({
            state: "active",
        });
        expect(getCurrentMemoryClaimByLegacyMemoryId(db, survivor.memoryId)?.state).toBe("active");
        expect(
            count(
                db,
                "claim_change_outbox",
                "effect_type = 'lifecycle' AND operation_id = (SELECT id FROM claim_operations WHERE operation_key = 'shared-delete-src')",
            ),
        ).toBe(0);
        expect(count(db, "verification_events", "outcome = 'archive'")).toBe(0);

        // Deleting the survivor retires the last live link, so the claim
        // archives now.
        runInMemoryClaimsWriteTransaction(db, () =>
            deleteMemoryWithClaimsInCurrentTransaction(
                db,
                envelope("shared-delete-survivor", { id: survivor.memoryId }),
                { memoryId: survivor.memoryId },
            ),
        );
        expect(db.prepare("SELECT state FROM claims WHERE id = ?").get(survivor.claimId)).toEqual({
            state: "archived",
        });
        expect(count(db, "verification_events", "outcome = 'archive'")).toBe(1);
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

    test("superseding a shared-claim projection with a live sibling records no supersession edge", () => {
        const db = track(migratedDb());
        const survivor = createSeedMemory(db, "shared-supersede", "shared supersede fact");
        const target = createSeedMemory(db, "shared-supersede-target", "replacement fact");
        // The live-DB shape after an identity merge: a second path string
        // aliased to the same project admits a duplicate row that dedups onto
        // the survivor's canonical claim.
        const aliasPath = "git:kernel-project-alias";
        const projectId = (
            db
                .prepare("SELECT project_id AS id FROM project_aliases WHERE alias_identity = ?")
                .get(PROJECT) as { id: number }
        ).id;
        db.prepare(
            "INSERT INTO project_aliases (alias_identity, project_id, created_at) VALUES (?, ?, 1)",
        ).run(aliasPath, projectId);
        let sourceId = 0;
        runInMemoryClaimsWriteTransaction(db, () => {
            sourceId = Number(
                db
                    .prepare(
                        `INSERT INTO memories (project_path, category, content, normalized_hash,
                            seen_count, retrieval_count, first_seen_at, created_at, updated_at, last_seen_at)
                         VALUES (?, 'CONSTRAINTS', ?, ?, 1, 0, 1, 1, 1, 1)`,
                    )
                    .run(aliasPath, "shared supersede fact", "hash:shared supersede fact")
                    .lastInsertRowid,
            );
        });
        runInMemoryClaimsWriteTransaction(db, () =>
            setMemoryStatusWithClaimsInCurrentTransaction(
                db,
                envelope("shared-supersede-archive", { id: sourceId }),
                { memoryId: sourceId, status: "archived" },
            ),
        );
        expect(count(db, "legacy_memory_claims", `claim_id = ${survivor.claimId}`)).toBe(2);

        runInMemoryClaimsWriteTransaction(db, () =>
            supersedeMemoryWithClaimsInCurrentTransaction(
                db,
                envelope("shared-supersede-1", { id: sourceId }),
                { memoryId: sourceId, supersededByMemoryId: target.memoryId },
            ),
        );

        // No edge: the survivor's live link still asserts the shared claim,
        // and the post-state re-snapshot must not re-create it either.
        expect(count(db, "claim_conflicts")).toBe(0);
        const sourceLink = readMemoryClaimLink(db, sourceId);
        const targetLink = readMemoryClaimLink(db, target.memoryId);
        if (!sourceLink || !targetLink) throw new Error("expected both endpoints linked");
        expect(memoryClaimSupersessionExists(db, sourceLink, targetLink)).toBeFalse();
        expect(db.prepare("SELECT state FROM claims WHERE id = ?").get(survivor.claimId)).toEqual({
            state: "active",
        });
        expect(
            count(db, "claim_change_outbox", `effect_key = 'memory:${target.memoryId}:evidence'`),
        ).toBe(0);
        // The row-level pointer and relationship snapshot stay intact, and
        // the disposition oracle still reports the token translated.
        expect(
            db
                .prepare("SELECT status, superseded_by_memory_id FROM memories WHERE id = ?")
                .get(sourceId),
        ).toEqual({ status: "archived", superseded_by_memory_id: target.memoryId });
        expect(
            count(
                db,
                "claim_memory_relationship_sources",
                `memory_id = ${sourceId} AND superseded_by_memory_id = ${target.memoryId}`,
            ),
        ).toBe(1);
        expect(
            db
                .prepare(
                    `SELECT DISTINCT reason_code, disposition FROM claim_backfill_failures
                      WHERE phase = 'relationships' AND item_kind = 'supersession'`,
                )
                .all(),
        ).toEqual([{ reason_code: "translated-supersession", disposition: "resolved" }]);
        // The reconciliation oracle reads the same supersession-exists probe;
        // the gated edge must not surface as an undisposed token or blocking
        // failure (migratedDb always reports pending v22 identity work).
        expect(inspectClaimsBackfillReconciliation(db).problems).toEqual([
            "pending v22 identity work",
        ]);

        // Superseding the survivor retires the last live link, so the edge
        // records as before.
        runInMemoryClaimsWriteTransaction(db, () =>
            supersedeMemoryWithClaimsInCurrentTransaction(
                db,
                envelope("shared-supersede-2", { id: survivor.memoryId }),
                { memoryId: survivor.memoryId, supersededByMemoryId: target.memoryId },
            ),
        );
        expect(count(db, "claim_conflicts", "relation = 'supersedes'")).toBe(1);
        const survivorLink = readMemoryClaimLink(db, survivor.memoryId);
        if (!survivorLink) throw new Error("expected survivor link");
        expect(memoryClaimSupersessionExists(db, survivorLink, targetLink)).toBeTrue();
        expect(db.prepare("SELECT state FROM claims WHERE id = ?").get(survivor.claimId)).toEqual({
            state: "archived",
        });
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

    test("ephemeral zero-effect envelopes persist nothing; effect-bearing ones insert normally", () => {
        const db = track(migratedDb());
        const seeded = createSeedMemory(db, "ephemeral-seed", "ephemeral fact");
        const operationsBefore = count(db, "claim_operations");
        const outboxBefore = count(db, "claim_change_outbox");
        const generationBefore = db
            .prepare("SELECT generation FROM claim_project_generations")
            .get() as { generation: number };

        // Mapped-only snapshots always yield zero effects: their random-key
        // envelopes must not accumulate in claim_operations.
        recordMemoryMapping(db, seeded.memoryId, ["src/a.ts"], 5_000);
        recordMemoryMapping(db, seeded.memoryId, ["src/b.ts"], 6_000);
        expect(count(db, "claim_operations")).toBe(operationsBefore);
        expect(count(db, "claim_change_outbox")).toBe(outboxBefore);
        expect(db.prepare("SELECT generation FROM claim_project_generations").get()).toEqual(
            generationBefore,
        );
        // The side-table snapshot itself still applies.
        expect(
            db
                .prepare("SELECT file_path FROM memory_verifications WHERE memory_id = ?")
                .all(seeded.memoryId),
        ).toEqual([{ file_path: "src/b.ts" }]);

        // A verified snapshot carries an evidence effect, so its ephemeral
        // envelope inserts with the full outbox contract.
        recordMemoryVerifications(db, seeded.memoryId, ["src/a.ts"], 7_000);
        expect(count(db, "claim_operations")).toBe(operationsBefore + 1);
        expect(
            count(
                db,
                "claim_change_outbox",
                `effect_type = 'evidence' AND effect_key = 'memory:${seeded.memoryId}:evidence'`,
            ),
        ).toBe(1);
    });

    test("a module delta advancing verified_at with a content change lands one verified event on the new revision", () => {
        const db = track(migratedDb());
        const seeded = createSeedMemory(db, "reverify-seed", "reverify fact");

        runInMemoryClaimsWriteTransaction(db, () =>
            applyModuleMemoryDeltaWithClaimsInCurrentTransaction(
                db,
                envelope("reverify-1", { id: seeded.memoryId }),
                {
                    memoryId: seeded.memoryId,
                    applyProjection: () => {
                        db.prepare(
                            "UPDATE memories SET verification_status = 'verified', verified_at = 5000 WHERE id = ?",
                        ).run(seeded.memoryId);
                    },
                },
            ),
        );
        expect(count(db, "verification_events", "outcome = 'verified'")).toBe(1);

        const outcome = runInMemoryClaimsWriteTransaction(db, () =>
            applyModuleMemoryDeltaWithClaimsInCurrentTransaction(
                db,
                envelope("reverify-2", { id: seeded.memoryId }),
                {
                    memoryId: seeded.memoryId,
                    applyProjection: () => {
                        db.prepare(
                            "UPDATE memories SET content = ?, normalized_hash = ?, verified_at = 6000 WHERE id = ?",
                        ).run("reverify fact v2", "hash:reverify fact v2", seeded.memoryId);
                    },
                },
            ),
        );
        expect(outcome.result.revisionId).not.toBeNull();
        // The re-verification event attaches to the NEW current revision,
        // with a matching evidence effect; the status did not change.
        expect(count(db, "verification_events", "outcome = 'verified'")).toBe(2);
        expect(
            db
                .prepare(
                    "SELECT revision_id AS revisionId FROM verification_events WHERE outcome = 'verified' ORDER BY id DESC LIMIT 1",
                )
                .get(),
        ).toEqual({ revisionId: outcome.result.revisionId });
        expect(
            count(
                db,
                "claim_change_outbox",
                `effect_type = 'evidence' AND effect_key = 'memory:${seeded.memoryId}:evidence'`,
            ),
        ).toBe(2);
    });

    test("a first module delta on an unlinked side-table-verified row with unchanged state records one verified event with evidence", () => {
        const db = track(migratedDb());
        let memoryId = 0;
        runInMemoryClaimsWriteTransaction(db, () => {
            memoryId = Number(
                db
                    .prepare(
                        `INSERT INTO memories (project_path, category, content, normalized_hash,
                            seen_count, retrieval_count, first_seen_at, created_at, updated_at, last_seen_at)
                         VALUES (?, 'CONSTRAINTS', 'side verified module fact', 'hash:side verified module fact', 1, 0, 1, 1, 1, 1)`,
                    )
                    .run(PROJECT).lastInsertRowid,
            );
            // Pre-v84 TypeScript verification: positive verified_at lives only
            // in memory_verifications; the projection columns stay unverified.
            db.prepare(
                `INSERT INTO memory_verifications (memory_id, file_path, verified_at, mapped_at)
                 VALUES (?, 'src/compat.ts', 123, 100)`,
            ).run(memoryId);
        });

        const outcome = runInMemoryClaimsWriteTransaction(db, () =>
            applyModuleMemoryDeltaWithClaimsInCurrentTransaction(
                db,
                envelope("module-side-verified-1", { key: "module-side-verified" }),
                { memoryId, applyProjection: () => {} },
            ),
        );

        // The status gate sees no change, advance, or revision for a
        // side-table-only row, so the first adoption itself carries the
        // pre-existing verified state: one event on the current revision
        // plus a matching evidence effect.
        expect(outcome.result.claimId).not.toBeNull();
        expect(
            db
                .prepare(
                    `SELECT outcome, verifier FROM verification_events
                      WHERE revision_id IN (SELECT id FROM claim_revisions WHERE claim_id = ?)`,
                )
                .all(outcome.result.claimId),
        ).toEqual([{ outcome: "verified", verifier: "kernel-test" }]);
        expect(
            count(
                db,
                "claim_change_outbox",
                `effect_type = 'evidence' AND effect_key = 'memory:${memoryId}:evidence'
                 AND operation_id = (SELECT id FROM claim_operations WHERE operation_key = 'module-side-verified-1')`,
            ),
        ).toBe(1);
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

    test("a claims-aware write that links a repaired row resolves its blocking failure without the backfill runner", () => {
        const db = track(migratedDb());
        const outcome = runInMemoryClaimsWriteTransaction(db, () =>
            createMemoryWithClaimsInCurrentTransaction(db, envelope("repair-1", { raw: true }), {
                projectPath: "/legacy/repairable-path",
                category: "CONSTRAINTS",
                content: "repairable fact",
                normalizedHash: "hash:repairable fact",
            }),
        );
        const memoryId = outcome.result.memoryId;
        expect(
            db
                .prepare("SELECT disposition FROM claim_backfill_failures WHERE item_key = ?")
                .get(String(memoryId)),
        ).toEqual({ disposition: "blocking" });

        // Doctor-style identity repair; the next claims-aware write links the
        // row through the crosswalk and clears the failure itself.
        runInMemoryClaimsWriteTransaction(db, () => {
            db.prepare("UPDATE memories SET project_path = ? WHERE id = ?").run(PROJECT, memoryId);
        });
        runInMemoryClaimsWriteTransaction(db, () =>
            setMemoryStatusWithClaimsInCurrentTransaction(
                db,
                envelope("repair-2", { id: memoryId }),
                { memoryId, status: "active" },
            ),
        );
        expect(count(db, "legacy_memory_claims", `memory_id = ${memoryId}`)).toBe(1);
        expect(
            db
                .prepare(
                    "SELECT phase, item_kind, disposition FROM claim_backfill_failures WHERE item_key = ?",
                )
                .get(String(memoryId)),
        ).toEqual({ phase: "rows", item_kind: "memory", disposition: "resolved" });
    });

    test("an unlinked row with claim-invalid metadata records a blocking failure and applies the projection instead of aborting", () => {
        const db = track(migratedDb());
        let memoryId = 0;
        runInMemoryClaimsWriteTransaction(db, () => {
            memoryId = Number(
                db
                    .prepare(
                        `INSERT INTO memories (project_path, category, content, normalized_hash,
                            seen_count, retrieval_count, first_seen_at, created_at, updated_at, last_seen_at)
                         VALUES (?, 'CONSTRAINTS', ?, ?, 1, 0, 1, 1, 1, 1)`,
                    )
                    .run(PROJECT, "invalid scope fact", "hash:invalid scope fact").lastInsertRowid,
            );
            // Schema-legal but claim-invalid: `memories` has no CHECK on scope.
            db.prepare("UPDATE memories SET scope = '' WHERE id = ?").run(memoryId);
        });
        const outcome = runInMemoryClaimsWriteTransaction(db, () =>
            setMemoryStatusWithClaimsInCurrentTransaction(
                db,
                envelope("invalid-scope-1", { id: memoryId }),
                { memoryId, status: "archived" },
            ),
        );
        expect(outcome.result).toMatchObject({ memoryId, claimId: null, found: true });
        expect(count(db, "claims")).toBe(0);
        expect(count(db, "legacy_memory_claims")).toBe(0);
        expect(count(db, "claim_change_outbox")).toBe(0);
        expect(db.prepare("SELECT status FROM memories WHERE id = ?").get(memoryId)).toEqual({
            status: "archived",
        });
        expect(
            db
                .prepare(
                    "SELECT phase, item_kind, reason_code, disposition FROM claim_backfill_failures WHERE item_key = ?",
                )
                .get(String(memoryId)),
        ).toEqual({
            phase: "rows",
            item_kind: "memory",
            reason_code: "invalid-scope",
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

describe("canonical project path SQL predicate", () => {
    test("the SQL twin is binary like the TS resolver: case-variant and bare prefixes are rejected", () => {
        const db = track(migratedDb());
        const matches = (value: string): number =>
            (
                db
                    .prepare(
                        `SELECT CASE WHEN ${canonicalMemoryProjectPathSql(
                            `'${value.replaceAll("'", "''")}'`,
                        )} THEN 1 ELSE 0 END AS hit`,
                    )
                    .get() as { hit: number }
            ).hit;
        expect(matches("git:abc")).toBe(1);
        expect(matches("dir:/x")).toBe(1);
        expect(matches("GIT:abc")).toBe(0);
        expect(matches("Dir:/x")).toBe(0);
        expect(matches("git:")).toBe(0);
        expect(matches("dir:")).toBe(0);
        expect(matches("/legacy/raw-path")).toBe(0);
    });
});

describe("memory/claims kernel: canonical claim reuse", () => {
    test("re-adding hash-equal content with divergent metadata appends a same-content revision", () => {
        const db = track(migratedDb());
        const seeded = createSeedMemory(db, "canon-meta-seed", "shared dedup fact");
        // Delete frees the (project, category, hash) slot; the archived claim
        // and its crosswalk stay behind as the canonical match.
        runInMemoryClaimsWriteTransaction(db, () =>
            deleteMemoryWithClaimsInCurrentTransaction(
                db,
                envelope("canon-meta-delete", { id: seeded.memoryId }),
                { memoryId: seeded.memoryId },
            ),
        );
        const outcome = runInMemoryClaimsWriteTransaction(db, () =>
            createMemoryWithClaimsInCurrentTransaction(
                db,
                envelope("canon-meta-readd", { readd: true }),
                {
                    projectPath: PROJECT,
                    category: "CONSTRAINTS",
                    content: "shared dedup fact",
                    normalizedHash: "hash:shared dedup fact",
                    importance: 85,
                    sourceSessionId: "ses-kernel-2",
                    sourceType: "user",
                    nowMs: 2_000,
                },
            ),
        );
        expect(outcome.result.claimId).toBe(seeded.claimId);
        expect(count(db, "claim_revisions", `claim_id = ${seeded.claimId}`)).toBe(2);
        const revision = db
            .prepare(
                `SELECT rev.content AS content, meta.importance AS importance,
                        meta.source_type AS sourceType, claims.state AS state
                   FROM claims
                   JOIN claim_revisions rev ON rev.id = claims.current_revision_id
                   JOIN claim_revision_memory_metadata meta ON meta.revision_id = rev.id
                  WHERE claims.id = ?`,
            )
            .get(seeded.claimId) as {
            content: string;
            importance: number;
            sourceType: string;
            state: string;
        };
        expect(revision).toEqual({
            content: "shared dedup fact",
            importance: 85,
            sourceType: "user",
            state: "active",
        });
    });
});

describe("memory/claims kernel: status transitions with metadata replacement", () => {
    test("archiving with replacement metadata appends a same-content revision; a status-only transition does not", () => {
        const db = track(migratedDb());
        const withMeta = createSeedMemory(db, "archive-meta-seed", "archive metadata fact");
        const statusOnly = createSeedMemory(db, "archive-plain-seed", "archive plain fact");
        const metadataJson = JSON.stringify({ archive_reason: "stale" });

        const metaOutcome = runInMemoryClaimsWriteTransaction(db, () =>
            setMemoryStatusWithClaimsInCurrentTransaction(
                db,
                envelope("archive-meta-1", { id: withMeta.memoryId }),
                { memoryId: withMeta.memoryId, status: "archived", metadataJson },
            ),
        );
        expect(metaOutcome.result.revisionId).not.toBeNull();
        expect(count(db, "claim_revisions", `claim_id = ${withMeta.claimId}`)).toBe(2);
        expect(
            db
                .prepare(
                    "SELECT metadata_json FROM claim_revision_memory_metadata WHERE revision_id = ?",
                )
                .get(metaOutcome.result.revisionId),
        ).toEqual({ metadata_json: metadataJson });
        expect(
            db
                .prepare("SELECT content FROM claim_revisions WHERE id = ?")
                .get(metaOutcome.result.revisionId),
        ).toEqual({ content: "archive metadata fact" });
        expect(db.prepare("SELECT state FROM claims WHERE id = ?").get(withMeta.claimId)).toEqual({
            state: "archived",
        });
        expect(
            count(db, "claim_change_outbox", `effect_key = 'memory:${withMeta.memoryId}:upsert'`),
        ).toBe(2);

        const plainOutcome = runInMemoryClaimsWriteTransaction(db, () =>
            setMemoryStatusWithClaimsInCurrentTransaction(
                db,
                envelope("archive-plain-1", { id: statusOnly.memoryId }),
                { memoryId: statusOnly.memoryId, status: "archived" },
            ),
        );
        expect(plainOutcome.result.revisionId).toBeNull();
        expect(count(db, "claim_revisions", `claim_id = ${statusOnly.claimId}`)).toBe(1);
    });
});

describe("memory/claims kernel: relationship and session-attribution effects", () => {
    function insertUnlinkedRow(db: Database, content: string, mergedFrom: string): number {
        let memoryId = 0;
        runInMemoryClaimsWriteTransaction(db, () => {
            memoryId = Number(
                db
                    .prepare(
                        `INSERT INTO memories (project_path, category, content, normalized_hash,
                            merged_from, seen_count, retrieval_count, first_seen_at, created_at, updated_at, last_seen_at)
                         VALUES (?, 'CONSTRAINTS', ?, ?, ?, 1, 0, 1, 1, 1, 1)`,
                    )
                    .run(PROJECT, content, `hash:${content}`, mergedFrom).lastInsertRowid,
            );
        });
        return memoryId;
    }

    function operationOutbox(db: Database, operationKey: string): Array<{ effectKey: string }> {
        return db
            .prepare(
                `SELECT effect_key AS effectKey FROM claim_change_outbox
                  WHERE operation_id = (SELECT id FROM claim_operations WHERE operation_key = ?)`,
            )
            .all(operationKey) as Array<{ effectKey: string }>;
    }

    function expectedEffectCount(db: Database, operationKey: string): number {
        return (
            db
                .prepare(
                    "SELECT expected_effect_count AS count FROM claim_operations WHERE operation_key = ?",
                )
                .get(operationKey) as { count: number }
        ).count;
    }

    test("a module delta first adoption with pre-existing lineage records the lineage effect in the outbox", () => {
        const db = track(migratedDb());
        const source = createSeedMemory(db, "module-lineage-source", "module lineage source");
        const memoryId = insertUnlinkedRow(db, "module lineage fact", `[${source.memoryId}]`);

        const outcome = runInMemoryClaimsWriteTransaction(db, () =>
            applyModuleMemoryDeltaWithClaimsInCurrentTransaction(
                db,
                envelope("module-lineage-1", { key: "module-lineage" }),
                { memoryId, applyProjection: () => {} },
            ),
        );
        expect(outcome.result.claimId).not.toBeNull();

        const outbox = operationOutbox(db, "module-lineage-1");
        expect(
            outbox.some(
                (row) =>
                    row.effectKey.startsWith(`memory:${memoryId}:relations:`) &&
                    row.effectKey.endsWith(":lineage:0"),
            ),
        ).toBeTrue();
        expect(expectedEffectCount(db, "module-lineage-1")).toBe(outbox.length);
    });

    test("superseding a row with pre-existing lineage keeps the lineage effect in the outbox", () => {
        const db = track(migratedDb());
        const source = createSeedMemory(db, "supersede-lineage-source", "supersede lineage source");
        const target = createSeedMemory(db, "supersede-lineage-target", "supersede lineage target");
        const memoryId = insertUnlinkedRow(db, "supersede lineage fact", `[${source.memoryId}]`);

        const outcome = runInMemoryClaimsWriteTransaction(db, () =>
            supersedeMemoryWithClaimsInCurrentTransaction(
                db,
                envelope("supersede-lineage-1", { id: memoryId }),
                { memoryId, supersededByMemoryId: target.memoryId },
            ),
        );
        expect(outcome.result.supersededByClaimId).toBe(target.claimId);

        const outbox = operationOutbox(db, "supersede-lineage-1");
        const keys = outbox.map((row) => row.effectKey);
        expect(
            keys.some(
                (key) =>
                    key.startsWith(`memory:${memoryId}:relations:`) && key.endsWith(":lineage:0"),
            ),
        ).toBeTrue();
        expect(keys).toContain(`memory:${memoryId}:lifecycle`);
        expect(keys).toContain(`memory:${target.memoryId}:evidence`);
        expect(outbox).toHaveLength(3);
        expect(expectedEffectCount(db, "supersede-lineage-1")).toBe(3);
    });

    test("a module delta changing only source_session_id appends a revision carrying the new session id", () => {
        const db = track(migratedDb());
        const seeded = createSeedMemory(db, "session-reattr-seed", "session reattribution fact");

        const outcome = runInMemoryClaimsWriteTransaction(db, () =>
            applyModuleMemoryDeltaWithClaimsInCurrentTransaction(
                db,
                envelope("session-reattr-1", { key: "session-reattr" }),
                {
                    memoryId: seeded.memoryId,
                    applyProjection: () => {
                        db.prepare(
                            "UPDATE memories SET source_session_id = 'ses-reattributed' WHERE id = ?",
                        ).run(seeded.memoryId);
                    },
                },
            ),
        );

        expect(outcome.result.revisionId).not.toBeNull();
        const revision = db
            .prepare(
                "SELECT revision, source_session_id AS sourceSessionId FROM claim_revisions WHERE id = ?",
            )
            .get(outcome.result.revisionId) as { revision: number; sourceSessionId: string | null };
        expect(revision.revision).toBe(2);
        expect(revision.sourceSessionId).toBe("ses-reattributed");
        expect(
            count(
                db,
                "claim_change_outbox",
                `effect_key = 'memory:${seeded.memoryId}:upsert'
                 AND operation_id = (SELECT id FROM claim_operations WHERE operation_key = 'session-reattr-1')`,
            ),
        ).toBe(1);
    });
});

describe("memory/claims kernel: module delta replay", () => {
    test("a replayed envelope appends no claim rows for a now-adoptable preimage", () => {
        const db = track(migratedDb());
        let memoryId = 0;
        runInMemoryClaimsWriteTransaction(db, () => {
            memoryId = Number(
                db
                    .prepare(
                        `INSERT INTO memories (project_path, category, content, normalized_hash,
                            seen_count, retrieval_count, first_seen_at, created_at, updated_at, last_seen_at)
                         VALUES (?, 'CONSTRAINTS', ?, ?, 1, 0, 1, 1, 1, 1)`,
                    )
                    .run("/legacy/raw-module-path", "module fact", "hash:module fact")
                    .lastInsertRowid,
            );
        });
        const env = envelope("module-replay-1", { key: "module-replay" });
        const first = runInMemoryClaimsWriteTransaction(db, () =>
            applyModuleMemoryDeltaWithClaimsInCurrentTransaction(db, env, {
                memoryId,
                applyProjection: () => {},
            }),
        );
        expect(first.replayed).toBeFalse();
        expect(first.result.claimId).toBeNull();

        // The row later rekeys to a canonical identity, so the preimage is now
        // adoptable — but the committed envelope must keep the replay side-effect
        // free instead of appending claim rows outside envelope accounting.
        runInMemoryClaimsWriteTransaction(db, () => {
            db.prepare("UPDATE memories SET project_path = ? WHERE id = ?").run(PROJECT, memoryId);
        });
        const before = snapshotCounts(db);
        const replayed = runInMemoryClaimsWriteTransaction(db, () =>
            applyModuleMemoryDeltaWithClaimsInCurrentTransaction(db, env, {
                memoryId,
                applyProjection: () => {},
            }),
        );
        expect(replayed.replayed).toBeTrue();
        expect(snapshotCounts(db)).toEqual(before);
    });
});

describe("memory/claims kernel: shared-claim lifecycle rank", () => {
    /** Second projection row deduped onto the seeded claim via an alias path
     *  (the live-DB shape after an identity merge): the unique (path,
     *  category, hash) projection index admits the duplicate, and its first
     *  kernel write links it to the survivor's canonical claim. */
    function insertAliasSibling(db: Database, content: string): number {
        const aliasPath = "git:kernel-project-alias";
        const projectId = (
            db
                .prepare("SELECT project_id AS id FROM project_aliases WHERE alias_identity = ?")
                .get(PROJECT) as { id: number }
        ).id;
        db.prepare(
            "INSERT INTO project_aliases (alias_identity, project_id, created_at) VALUES (?, ?, 1)",
        ).run(aliasPath, projectId);
        let siblingId = 0;
        runInMemoryClaimsWriteTransaction(db, () => {
            siblingId = Number(
                db
                    .prepare(
                        `INSERT INTO memories (project_path, category, content, normalized_hash,
                            seen_count, retrieval_count, first_seen_at, created_at, updated_at, last_seen_at)
                         VALUES (?, 'CONSTRAINTS', ?, ?, 1, 0, 1, 1, 1, 1)`,
                    )
                    .run(aliasPath, content, `hash:${content}`).lastInsertRowid,
            );
        });
        return siblingId;
    }

    function setStatus(db: Database, key: string, memoryId: number, status: string): void {
        runInMemoryClaimsWriteTransaction(db, () =>
            setMemoryStatusWithClaimsInCurrentTransaction(db, envelope(key, { key, memoryId }), {
                memoryId,
                status,
            }),
        );
    }

    test("restoring an archived sibling never downgrades a permanent shared claim", () => {
        const db = track(migratedDb());
        const survivor = createSeedMemory(db, "rank-restore-seed", "rank restore fact");
        setStatus(db, "rank-restore-permanent", survivor.memoryId, "permanent");
        const siblingId = insertAliasSibling(db, "rank restore fact");
        setStatus(db, "rank-restore-archive-sibling", siblingId, "archived");
        expect(db.prepare("SELECT state FROM claims WHERE id = ?").get(survivor.claimId)).toEqual({
            state: "permanent",
        });
        expect(count(db, "verification_events", "outcome = 'archive'")).toBe(0);

        setStatus(db, "rank-restore-restore-sibling", siblingId, "active");
        expect(db.prepare("SELECT state FROM claims WHERE id = ?").get(survivor.claimId)).toEqual({
            state: "permanent",
        });
        // Neither sibling transition changed the max-rank state, so no
        // lifecycle effect reached the outbox for them.
        expect(
            count(
                db,
                "claim_change_outbox",
                `effect_type = 'lifecycle' AND operation_id IN (
                    SELECT id FROM claim_operations
                     WHERE operation_key IN ('rank-restore-archive-sibling', 'rank-restore-restore-sibling'))`,
            ),
        ).toBe(0);
    });

    test("demoting the only permanent sibling moves the shared claim to active", () => {
        const db = track(migratedDb());
        const survivor = createSeedMemory(db, "rank-demote-seed", "rank demote fact");
        const siblingId = insertAliasSibling(db, "rank demote fact");
        setStatus(db, "rank-demote-permanent", siblingId, "permanent");
        expect(db.prepare("SELECT state FROM claims WHERE id = ?").get(survivor.claimId)).toEqual({
            state: "permanent",
        });

        setStatus(db, "rank-demote-active", siblingId, "active");
        expect(db.prepare("SELECT state FROM claims WHERE id = ?").get(survivor.claimId)).toEqual({
            state: "active",
        });
    });

    test("archiving the only permanent sibling leaves the shared claim active, not stale-permanent", () => {
        const db = track(migratedDb());
        const survivor = createSeedMemory(db, "rank-archive-seed", "rank archive fact");
        const siblingId = insertAliasSibling(db, "rank archive fact");
        setStatus(db, "rank-archive-permanent", siblingId, "permanent");
        expect(db.prepare("SELECT state FROM claims WHERE id = ?").get(survivor.claimId)).toEqual({
            state: "permanent",
        });

        setStatus(db, "rank-archive-archive", siblingId, "archived");
        expect(db.prepare("SELECT state FROM claims WHERE id = ?").get(survivor.claimId)).toEqual({
            state: "active",
        });
        // The survivor still asserts the claim, so no archive event fires.
        expect(count(db, "verification_events", "outcome = 'archive'")).toBe(0);
    });
});
