/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { createAntiMemory } from "../memory/storage-anti-memory";
import {
    applyProjectMemoryMapping,
    computeProjectMemoryMutationToken,
    recordProjectMemoryVerification,
} from "../memory/storage-claim-operations";
import { ensureProject } from "../memory/storage-claims";
import {
    createClaimReaderTestDatabase,
    type SeededProjectMemoryClaim,
    seedProjectMemoryClaim,
} from "../test-claim-database";
import { evaluateTaskGate, getDreamTaskBacklog } from "./task-gates";
import { processedDreamTaskItems } from "./task-registry";

let db: Database | null = null;

afterEach(() => {
    if (db) closeQuietly(db);
    db = null;
});

function mapClaim(database: Database, claim: SeededProjectMemoryClaim, paths: string[]): void {
    const result = applyProjectMemoryMapping(
        database,
        { producer: "test", operationKey: `map-${claim.publicClaimId}` },
        {
            token: computeProjectMemoryMutationToken(database, claim.publicClaimId),
            revisionLocator: claim.revisionLocator,
            paths: { state: "known", exact: paths },
        },
    );
    expect(result.outcome).toBe("applied");
}

function verifyClaim(database: Database, claim: SeededProjectMemoryClaim): void {
    const result = recordProjectMemoryVerification(
        database,
        { producer: "test", operationKey: `verify-${claim.publicClaimId}` },
        {
            token: computeProjectMemoryMutationToken(database, claim.publicClaimId),
            revisionLocator: claim.revisionLocator,
            outcome: "verified",
            verifier: "dreamer:test",
        },
    );
    expect(result.outcome).toBe("applied");
}

/** `markClassified` inserts the evidence produced by a completed `classify-memories` pass. */
function markClassified(database: Database, claim: SeededProjectMemoryClaim): void {
    const revisionId = (
        database
            .prepare(
                `SELECT claims.current_revision_id AS id FROM claims
                  JOIN claim_public_ids cpi ON cpi.claim_id = claims.id
                 WHERE cpi.public_id = ?`,
            )
            .get(claim.publicClaimId) as { id: number }
    ).id;
    const spanId = (
        database
            .prepare(
                `SELECT observations.source_span_id AS id FROM claim_evidence
                  JOIN observations ON observations.id = claim_evidence.observation_id
                 WHERE claim_evidence.revision_id = ? LIMIT 1`,
            )
            .get(revisionId) as { id: number }
    ).id;
    const key = `classify-memories:1:${claim.publicClaimId}`;
    database
        .prepare(
            `INSERT INTO observations (source_span_id, extracted_text, content_sha256, extractor,
                extractor_version, extractor_run_id, independence_key, source_trust_class, created_at)
             VALUES (?, 'classified', ?, 'dreamer', '1', ?, ?, 'model_inference', 2)`,
        )
        .run(spanId, "e".repeat(64), key, key);
    const observationId = (
        database.prepare("SELECT MAX(id) AS id FROM observations").get() as { id: number }
    ).id;
    database
        .prepare(
            "INSERT INTO claim_evidence (revision_id, observation_id, relation, created_at) VALUES (?, ?, 'supports', 2)",
        )
        .run(revisionId, observationId);
}

describe("dream task backlog probes", () => {
    test("backlog probes read claims, never legacy memory tables", () => {
        const database = createClaimReaderTestDatabase();
        db = database;
        const projectIdentity = "git:u3-dreamer-reader";
        seedProjectMemoryClaim(database, {
            projectIdentity,
            content: "dreamer projection bytes: café",
            category: "PROJECT_RULES",
        });

        const statements: string[] = [];
        const originalPrepare = database.prepare.bind(database);
        database.prepare = ((sql: string) => {
            statements.push(sql);
            return originalPrepare(sql);
        }) as typeof database.prepare;
        let backlog: ReturnType<typeof getDreamTaskBacklog>;
        try {
            backlog = getDreamTaskBacklog(database, projectIdentity, "classify-memories");
        } finally {
            database.prepare = originalPrepare;
        }

        expect(backlog).toEqual({ pending: 1, total: 1 });
        expect(statements.some((sql) => /\bclaims\b/i.test(sql))).toBeTrue();
        expect(
            statements.some((sql) =>
                /\bmemories\b|\bmemory_stats\b|\bmemory_verifications\b|legacy_memory_claims/i.test(
                    sql,
                ),
            ),
        ).toBeFalse();
    });

    test("classify backlog drops as claims gain classify evidence", () => {
        // A completed pass must not report `pending === total` forever.
        const database = createClaimReaderTestDatabase();
        db = database;
        const projectIdentity = "git:u3-classify-backlog";
        const first = seedProjectMemoryClaim(database, {
            projectIdentity,
            content: "first classify target",
            category: "PROJECT_RULES",
        });
        seedProjectMemoryClaim(database, {
            projectIdentity,
            content: "second classify target",
            category: "PROJECT_RULES",
        });

        expect(getDreamTaskBacklog(database, projectIdentity, "classify-memories")).toEqual({
            pending: 2,
            total: 2,
        });

        markClassified(database, first);
        expect(getDreamTaskBacklog(database, projectIdentity, "classify-memories")).toEqual({
            pending: 1,
            total: 2,
        });
    });

    test("map probe counts claims without recorded path knowledge", () => {
        const database = createClaimReaderTestDatabase();
        db = database;
        const projectIdentity = "git:u3-map-probe";
        const first = seedProjectMemoryClaim(database, {
            projectIdentity,
            content: "Keep the first claim mapped.",
            category: "PROJECT_RULES",
        });
        seedProjectMemoryClaim(database, {
            projectIdentity,
            content: "The second claim still needs mapping.",
            category: "ARCHITECTURE",
        });
        mapClaim(database, first, ["src/first.ts"]);

        expect(getDreamTaskBacklog(database, projectIdentity, "map-memories")).toEqual({
            pending: 1,
            total: 2,
        });
        expect(getDreamTaskBacklog(database, projectIdentity, "classify-memories")).toEqual({
            pending: 2,
            total: 2,
        });
    });

    test("verify probe counts only mapped claims that are still unverified", () => {
        const database = createClaimReaderTestDatabase();
        db = database;
        const projectIdentity = "git:u3-verify-probe";
        const pending = seedProjectMemoryClaim(database, {
            projectIdentity,
            content: "This mapped claim still needs verification.",
            category: "PROJECT_RULES",
        });
        const verified = seedProjectMemoryClaim(database, {
            projectIdentity,
            content: "This mapped claim has already been verified.",
            category: "ARCHITECTURE",
        });
        mapClaim(database, pending, ["src/pending.ts"]);
        mapClaim(database, verified, ["src/verified.ts"]);
        verifyClaim(database, verified);

        expect(getDreamTaskBacklog(database, projectIdentity, "verify")).toEqual({
            pending: 1,
            total: 2,
        });
    });

    test("compress-cues probe counts claims without a current cue", () => {
        const database = createClaimReaderTestDatabase();
        db = database;
        const projectIdentity = "git:u3-cue-probe";
        const claim = seedProjectMemoryClaim(database, {
            projectIdentity,
            content: "Cue probe claim.",
        });
        expect(getDreamTaskBacklog(database, projectIdentity, "compress-cues")).toEqual({
            pending: 1,
            total: 1,
        });
        const claimId = (
            database
                .prepare("SELECT claim_id AS id FROM claim_public_ids WHERE public_id = ?")
                .get(claim.publicClaimId) as { id: number }
        ).id;
        database
            .prepare(
                `INSERT INTO claim_mural_cues
                    (claim_id, revision_locator, renderer_epoch, cue, rejection_count, updated_at)
                 VALUES (?, ?, 1, 'anchor → relation', 0, ?)`,
            )
            .run(claimId, claim.revisionLocator, Date.now());
        expect(getDreamTaskBacklog(database, projectIdentity, "compress-cues")).toEqual({
            pending: 0,
            total: 1,
        });
    });

    test("processed count is the start-to-end backlog reduction", () => {
        expect(processedDreamTaskItems(17, 5)).toBe(12);
        expect(processedDreamTaskItems(5, 7)).toBe(0);
    });
});

describe("uniformly absent claims are not runnable work", () => {
    test("a quarantined claim leaves the backlog empty", () => {
        // `surfaceDecision` excludes quarantined lifecycle-active claims from every surface.
        // Counting lifecycle heads opens a child `curate` session when the runner pool is empty.
        // An empty runner pool prevents the backlog from draining.
        const database = createClaimReaderTestDatabase();
        db = database;
        const projectIdentity = "git:u3-hidden-pool";
        const claim = seedProjectMemoryClaim(database, {
            projectIdentity,
            content: "quarantined claim bytes",
            category: "PROJECT_RULES",
        });

        expect(getDreamTaskBacklog(database, projectIdentity, "curate").total).toBe(1);

        database
            .prepare(
                `INSERT INTO claim_disposition_events
                    (revision_id, project_id, disposition, action, actor, policy_version, recorded_at)
                 SELECT claims.current_revision_id, claims.project_id, 'quarantined', 'assert',
                        'user:test', 1, ?
                   FROM claims
                   JOIN claim_public_ids cpi ON cpi.claim_id = claims.id
                  WHERE cpi.public_id = ?`,
            )
            .run(Date.now(), claim.publicClaimId);

        expect(getDreamTaskBacklog(database, projectIdentity, "curate")).toEqual({
            pending: 0,
            total: 0,
        });
    });
});

describe("anti-memory is not maintenance work", () => {
    test("a project holding only anti-memory reports no backlog and no gate", () => {
        // The reader excludes anti-memory on every non-explicit surface.
        // A gate must not count anti-memory that no maintenance runner can see.
        // Counting anti-memory that no maintenance runner can see causes the scheduler to reopen the work forever.
        const database = createClaimReaderTestDatabase();
        db = database;
        const projectIdentity = "git:u3-anti-only";
        const projectId = ensureProject(database, projectIdentity);

        createAntiMemory(
            database,
            { producer: "test", operationKey: "anti" },
            {
                projectId,
                payload: {
                    trigger: "session caching work",
                    rejectedStrategy: "use Redis",
                    rejectionReason: "Redis adds operational cost",
                },
                provenance: {
                    sourceLocator: "transcript://anti",
                    sourceContent: "source anti",
                    extractor: "test",
                    extractorVersion: "1",
                    extractorRunId: "run-anti",
                    independenceKey: "anti",
                    sourceTrustClass: "model_inference",
                },
                actor: "dreamer",
                nowMs: Date.now(),
            },
        );

        for (const task of ["curate", "verify", "map-memories"] as const) {
            expect(getDreamTaskBacklog(database, projectIdentity, task)).toEqual({
                pending: 0,
                total: 0,
            });
        }
        expect(
            evaluateTaskGate("classify-memories", {
                db: database,
                projectIdentity,
                lastRunAt: Date.now(),
                promotionThreshold: 3,
            }),
        ).toBe(false);
    });
});

describe("evaluateTaskGate", () => {
    test("classify-memories runs when active claims exist", () => {
        const database = createClaimReaderTestDatabase();
        db = database;
        const projectIdentity = "git:u3-gate-classify";
        expect(
            evaluateTaskGate("classify-memories", {
                db: database,
                projectIdentity,
                lastRunAt: null,
                promotionThreshold: 3,
            }),
        ).toBe(false);

        seedProjectMemoryClaim(database, {
            projectIdentity,
            content: "Use Bun for package scripts in this repo.",
            category: "PROJECT_RULES",
        });

        expect(
            evaluateTaskGate("classify-memories", {
                db: database,
                projectIdentity,
                lastRunAt: Date.now(),
                promotionThreshold: 3,
            }),
        ).toBe(true);
    });

    test("retrospective gates on the CONTENT watermark, not lastRunAt", () => {
        const database = createClaimReaderTestDatabase();
        db = database;
        const projectIdentity = "/repo/project";
        database
            .prepare(
                "INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES (?, ?, ?, ?)",
            )
            .run("s1", "opencode", projectIdentity, 200);

        expect(
            evaluateTaskGate("retrospective", {
                db: database,
                projectIdentity,
                lastRunAt: null,
                retrospectiveWatermarkMs: null,
                promotionThreshold: 3,
            }),
        ).toBe(true);
        // A session newer than the watermark runs even when `lastRunAt` is newer, because its content changed mid-run.
        expect(
            evaluateTaskGate("retrospective", {
                db: database,
                projectIdentity,
                lastRunAt: 9999,
                retrospectiveWatermarkMs: 100,
                promotionThreshold: 3,
            }),
        ).toBe(true);
        expect(
            evaluateTaskGate("retrospective", {
                db: database,
                projectIdentity,
                lastRunAt: null,
                retrospectiveWatermarkMs: 300,
                promotionThreshold: 3,
            }),
        ).toBe(false);
    });
});
