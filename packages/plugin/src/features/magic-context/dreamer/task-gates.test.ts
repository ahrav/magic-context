/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import {
    applyProjectMemoryMapping,
    computeProjectMemoryMutationToken,
    recordProjectMemoryVerification,
} from "../memory/storage-claim-operations";
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

        // Never scanned → runs.
        expect(
            evaluateTaskGate("retrospective", {
                db: database,
                projectIdentity,
                lastRunAt: null,
                retrospectiveWatermarkMs: null,
                promotionThreshold: 3,
            }),
        ).toBe(true);
        // Session newer than watermark → runs (even if lastRunAt is newer — the
        // session was updated mid-run, so its content hasn't been scanned).
        expect(
            evaluateTaskGate("retrospective", {
                db: database,
                projectIdentity,
                lastRunAt: 9999,
                retrospectiveWatermarkMs: 100,
                promotionThreshold: 3,
            }),
        ).toBe(true);
        // Watermark at/after the session update → nothing new → skip.
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
