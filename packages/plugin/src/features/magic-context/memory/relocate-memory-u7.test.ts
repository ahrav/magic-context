import { describe, expect, test } from "bun:test";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { initializeDatabase } from "../storage-db";
import { clearSession, updateSessionMeta } from "../storage-meta-session";
import { createDirectTestDatabase } from "../test-database";
import { seedProjectMemoryClaim } from "../test-claim-database";
import { computeProjectMemoryMutationToken } from "./storage-claim-operations";
import { ensureProject } from "./storage-claims";
import { copyProjectMemoryClaims, moveProjectMemoryClaims } from "./relocate-memory";

function directDb() {
    const db = createDirectTestDatabase().db;
    initializeDatabase(db);
    return db;
}

function count(db: ReturnType<typeof directDb>, table: string): number {
    return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

function lifecycle(db: ReturnType<typeof directDb>, publicClaimId: string): string {
    return (
        db
            .prepare(
                `SELECT head.state
                   FROM claim_public_ids ids
                   JOIN claim_memory_lifecycle_heads head ON head.claim_id = ids.claim_id
                  WHERE ids.public_id = ?`,
            )
            .get(publicClaimId) as { state: string }
    ).state;
}

describe("U7 direct claim relocation", () => {
    test("scenario 3: copy derives and deduplicates targets with complete explicit lineage", () => {
        const db = directDb();
        try {
            ensureProject(db, "git:target");
            const first = seedProjectMemoryClaim(db, {
                projectIdentity: "git:source-a",
                content: "Shared relocation fact.",
                category: "CONSTRAINTS",
                importance: 80,
            });
            const second = seedProjectMemoryClaim(db, {
                projectIdentity: "git:source-b",
                content: "Shared relocation fact.",
                category: "CONSTRAINTS",
                importance: 80,
            });

            const result = copyProjectMemoryClaims(
                db,
                { producer: "u7-test", operationKey: "copy-dedup" },
                {
                    sourceTokens: [first.token, second.token],
                    targetProjectIdentity: "git:target",
                    nowMs: 100,
                },
            );
            const payload = result.result.payload as {
                mappings: Array<{ sourceClaim: string; targetClaim: string }>;
                targetProjectId: number;
            };

            expect(result.outcome).toBe("applied");
            expect(payload.mappings).toHaveLength(2);
            expect(new Set(payload.mappings.map((mapping) => mapping.sourceClaim))).toEqual(
                new Set([first.publicClaimId, second.publicClaimId]),
            );
            expect(new Set(payload.mappings.map((mapping) => mapping.targetClaim)).size).toBe(1);
            expect(
                db
                    .prepare(
                        "SELECT source_claim_id, target_claim_id, relation FROM claim_derivations ORDER BY source_claim_id",
                    )
                    .all(),
            ).toHaveLength(2);
            expect(db.prepare("SELECT DISTINCT relation FROM claim_derivations").all()).toEqual([
                { relation: "copied_from" },
            ]);
            expect(count(db, "claim_operation_receipts")).toBe(3);
        } finally {
            closeQuietly(db);
        }
    });

    test("scenario 4: an equal target gains conservative evidence without source trust or approval", () => {
        const db = directDb();
        try {
            const source = seedProjectMemoryClaim(db, {
                projectIdentity: "git:source",
                content: "Equal claim.",
                category: "ARCHITECTURE",
            });
            const target = seedProjectMemoryClaim(db, {
                projectIdentity: "git:target",
                content: "Equal claim.",
                category: "ARCHITECTURE",
            });
            const targetClaim = db
                .prepare("SELECT claim_id AS claimId FROM claim_public_ids WHERE public_id = ?")
                .get(target.publicClaimId) as { claimId: number };
            const evidenceBefore = count(db, "claim_evidence");

            const result = copyProjectMemoryClaims(
                db,
                { producer: "u7-test", operationKey: "copy-equal" },
                {
                    sourceTokens: [source.token],
                    targetProjectIdentity: "git:target",
                    nowMs: 200,
                },
            );
            const payload = result.result.payload as {
                mappings: Array<{ targetClaim: string }>;
            };

            expect(payload.mappings[0]?.targetClaim).toBe(target.publicClaimId);
            expect(count(db, "claims")).toBe(2);
            expect(count(db, "claim_evidence")).toBe(evidenceBefore + 1);
            expect(
                db
                    .prepare(
                        `SELECT observations.source_trust_class AS trust
                           FROM claim_evidence
                           JOIN observations ON observations.id = claim_evidence.observation_id
                          WHERE claim_evidence.revision_id = (
                              SELECT current_revision_id FROM claims WHERE id = ?
                          ) AND observations.extractor = 'claim-relocation'
                          LIMIT 1`,
                    )
                    .get(targetClaim.claimId),
            ).toEqual({ trust: "model_inference" });
            expect(
                db
                    .prepare(
                        `SELECT COUNT(*) AS count FROM claim_approval_actions
                          WHERE revision_id = (SELECT current_revision_id FROM claims WHERE id = ?)`,
                    )
                    .get(targetClaim.claimId),
            ).toEqual({ count: 0 });
        } finally {
            closeQuietly(db);
        }
    });

    test("scenario 5: move archives sources only after every target succeeds", () => {
        const db = directDb();
        try {
            ensureProject(db, "git:target");
            const first = seedProjectMemoryClaim(db, {
                projectIdentity: "git:source",
                content: "First move.",
                category: "CONSTRAINTS",
            });
            const second = seedProjectMemoryClaim(db, {
                projectIdentity: "git:source",
                content: "Second move.",
                category: "ARCHITECTURE",
            });
            seedProjectMemoryClaim(db, {
                projectIdentity: "git:target",
                content: "Second move.",
                category: "ARCHITECTURE",
                importance: 99,
            });
            const claimsBefore = count(db, "claims");
            const receiptsBefore = count(db, "claim_operation_receipts");

            expect(() =>
                moveProjectMemoryClaims(
                    db,
                    { producer: "u7-test", operationKey: "move-target-failure" },
                    {
                        sourceTokens: [first.token, second.token],
                        targetProjectIdentity: "git:target",
                        nowMs: 300,
                    },
                ),
            ).toThrow(/not semantically equal/);
            expect(lifecycle(db, first.publicClaimId)).toBe("active");
            expect(lifecycle(db, second.publicClaimId)).toBe("active");
            expect(count(db, "claims")).toBe(claimsBefore);
            expect(count(db, "claim_operation_receipts")).toBe(receiptsBefore);
        } finally {
            closeQuietly(db);
        }
    });

    test("scenario 6: one stale source stores a zero-effect result for the whole batch", () => {
        const db = directDb();
        try {
            ensureProject(db, "git:target");
            const current = seedProjectMemoryClaim(db, {
                projectIdentity: "git:source",
                content: "Current source.",
            });
            const stale = seedProjectMemoryClaim(db, {
                projectIdentity: "git:source",
                content: "Stale source.",
            });
            db.transaction(() => {
                db.prepare(
                    `INSERT INTO claim_memory_lifecycle_events
                        (claim_id, seq, predecessor_id, state, actor, recorded_at)
                     SELECT ids.claim_id, head.seq + 1, head.event_id, 'archived', 'test', 1
                       FROM claim_public_ids ids
                       JOIN claim_memory_lifecycle_heads head ON head.claim_id = ids.claim_id
                      WHERE ids.public_id = ?`,
                ).run(stale.publicClaimId);
                db.prepare(
                    `UPDATE claim_memory_current_heads SET lifecycle_state = 'archived'
                      WHERE claim_id = (SELECT claim_id FROM claim_public_ids WHERE public_id = ?)`,
                ).run(stale.publicClaimId);
            }).immediate();
            const claimsBefore = count(db, "claims");
            const derivationsBefore = count(db, "claim_derivations");

            const result = moveProjectMemoryClaims(
                db,
                { producer: "u7-test", operationKey: "move-stale-batch" },
                {
                    sourceTokens: [current.token, stale.token],
                    targetProjectIdentity: "git:target",
                    nowMs: 400,
                },
            );

            expect(result.outcome).toBe("stale");
            expect(result.result.effects).toEqual([]);
            expect(count(db, "claims")).toBe(claimsBefore);
            expect(count(db, "claim_derivations")).toBe(derivationsBefore);
            expect(lifecycle(db, current.publicClaimId)).toBe("active");
            expect(
                db
                    .prepare(
                        "SELECT outcome, expected_effect_count AS effects FROM claim_operation_receipts WHERE operation_key = ?",
                    )
                    .get("move-stale-batch"),
            ).toEqual({ outcome: "stale", effects: 0 });
        } finally {
            closeQuietly(db);
        }
    });

    test("scenario 8: clearSession preserves source and target relocation history", () => {
        const db = directDb();
        try {
            ensureProject(db, "git:target");
            updateSessionMeta(db, "source-session", { counter: 1 });
            updateSessionMeta(db, "target-session", { counter: 1 });
            const source = seedProjectMemoryClaim(db, {
                projectIdentity: "git:source",
                content: "History survives cleanup.",
                provenance: { sourceSessionId: "source-session" },
            });
            const result = moveProjectMemoryClaims(
                db,
                { producer: "u7-test", operationKey: "move-before-clear" },
                {
                    sourceTokens: [source.token],
                    targetProjectIdentity: "git:target",
                    nowMs: 500,
                },
            );
            const payload = result.result.payload as {
                mappings: Array<{ targetClaim: string }>;
            };
            const targetId = payload.mappings[0]?.targetClaim;
            const before = {
                claims: count(db, "claims"),
                revisions: count(db, "claim_revisions"),
                evidence: count(db, "claim_evidence"),
                receipts: count(db, "claim_operation_receipts"),
                derivations: count(db, "claim_derivations"),
            };

            clearSession(db, "source-session");
            clearSession(db, "target-session");

            expect({
                claims: count(db, "claims"),
                revisions: count(db, "claim_revisions"),
                evidence: count(db, "claim_evidence"),
                receipts: count(db, "claim_operation_receipts"),
                derivations: count(db, "claim_derivations"),
            }).toEqual(before);
            expect(computeProjectMemoryMutationToken(db, source.publicClaimId).publicClaimId).toBe(
                source.publicClaimId,
            );
            expect(computeProjectMemoryMutationToken(db, targetId as string).publicClaimId).toBe(
                targetId,
            );
        } finally {
            closeQuietly(db);
        }
    });
});
