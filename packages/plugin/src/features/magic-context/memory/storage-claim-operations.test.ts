/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import type { SourceTrustClass } from "../storage-claim-applicability-schema";
import { createDirectTestDatabase } from "../test-database";
import {
    CLAIM_MUTATION_TOKEN_DIGEST_PROTOCOL,
    CLAIM_REQUEST_DIGEST_PROTOCOL,
    CLAIM_REQUEST_ENCODING_VERSION,
    CLAIM_RESULT_ENCODING_VERSION,
    type ClaimMutationToken,
    canonicalClaimMutationToken,
    canonicalJsonEncode,
    canonicalSnapshotVector,
    computeApplicabilityHeadsDigest,
    computeClaimMutationTokenDigest,
    computeClaimOperationRequestDigest,
    computePolicyHeadsDigest,
    computeSnapshotVectorDigest,
    decodeClaimOperationResult,
    formatRevisionLocator,
    isValidPublicClaimId,
    parseRevisionLocator,
    type SnapshotVector,
} from "./claim-operation-contract";
import contractFixture from "./fixtures/claim-operation-contract-v1.json";
import { combineClaimOperationStageOutcomes } from "./storage-claim-autonomous";
import {
    advanceOutboxConsumerCheckpointInCurrentTransaction,
    applyProjectMemoryMapping,
    type ClaimEvidenceProvenance,
    ClaimOperationKeyReuseError,
    computeProjectMemoryMutationToken,
    createProjectMemoryClaim,
    getProjectMemoryClaimByPublicId,
    mergeProjectMemoryClaims,
    pruneClaimOperationEffectsInCurrentTransaction,
    readOutboxConsumerCheckpoint,
    rebuildClaimMemoryCurrentHeads,
    recordClaimUsage,
    recordProjectMemoryVerification,
    reviseProjectMemoryClaim,
    runClaimOperation,
    setProjectMemoryClaimLifecycle,
    stageCreateProjectMemoryClaimInCurrentTransaction,
} from "./storage-claim-operations";
import { ensureProject } from "./storage-claims";

function directDb(path = ":memory:"): Database {
    return createDirectTestDatabase({ path }).db;
}

function provenance(
    independenceKey: string,
    run = "run-1",
    sourceTrustClass: SourceTrustClass = "model_inference",
): ClaimEvidenceProvenance {
    return {
        sourceLocator: "transcript://u2-ops",
        sourceContent: `raw source for ${independenceKey}/${run}`,
        extractor: "historian",
        extractorVersion: "2",
        extractorRunId: run,
        independenceKey,
        sourceTrustClass,
    };
}

interface Ctx {
    db: Database;
    projectId: number;
}

function setup(path = ":memory:"): Ctx {
    const db = directDb(path);
    const projectId = ensureProject(db, "git:u2-ops");
    return { db, projectId };
}

function createClaimOp(
    ctx: Ctx,
    key: string,
    content: string,
    overrides: Partial<Parameters<typeof createProjectMemoryClaim>[2]> = {},
) {
    return createProjectMemoryClaim(
        ctx.db,
        { producer: "test", operationKey: key },
        {
            projectId: ctx.projectId,
            content,
            category: "ARCHITECTURE",
            provenance: provenance(`ik-${key}`),
            actor: "user:test",
            ...overrides,
        },
    );
}

function publicIdOf(result: ReturnType<typeof createProjectMemoryClaim>): string {
    const payload = result.result.payload as { claim: { publicClaimId: string } };
    return payload.claim.publicClaimId;
}

function rowCount(db: Database, table: string): number {
    // Table names come from the fixed test list, never caller input.
    // pi-lens-ignore: sql-injection
    return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

const CLAIM_ROW_TABLES = [
    "claims",
    "claim_revisions",
    "claim_evidence",
    "observations",
    "claim_public_ids",
    "claim_memory_revision_attributes",
    "claim_memory_lifecycle_events",
    "claim_memory_current_heads",
    "claim_revision_applicability_assertions",
    "claim_revision_policy_subjects",
    "claim_maturity_assertions",
    "claim_effective_policy",
    "claim_operation_effects",
    "claim_project_generations",
    "verification_events",
] as const;

function snapshotCounts(db: Database): Record<string, number> {
    return Object.fromEntries(CLAIM_ROW_TABLES.map((table) => [table, rowCount(db, table)]));
}

function snapshotSemanticRows(db: Database): Record<string, unknown[]> {
    return Object.fromEntries(
        CLAIM_ROW_TABLES.map((table) => {
            // Table names come from the fixed test list, never caller input.
            // pi-lens-ignore: sql-injection
            const rows = db.prepare(`SELECT * FROM ${table}`).all() as unknown[];
            rows.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
            return [table, rows];
        }),
    );
}

describe("claim operations: create (scenario 1)", () => {
    test("commits identity, revision 1, attributes, evidence, applicability, policy, receipt, effect, and one generation", () => {
        const ctx = setup();
        try {
            const created = createClaimOp(ctx, "op-create", "The project uses bun.");
            expect(created.outcome).toBe("applied");
            expect(created.replayed).toBe(false);
            const publicId = publicIdOf(created);
            expect(isValidPublicClaimId(publicId)).toBe(true);

            const claim = getProjectMemoryClaimByPublicId(ctx.db, publicId);
            expect(claim).not.toBeNull();
            if (!claim) throw new Error("unreachable");
            expect(claim.revision).toBe(1);

            expect(rowCount(ctx.db, "claim_public_ids")).toBe(1);
            expect(rowCount(ctx.db, "claim_memory_revision_attributes")).toBe(1);
            expect(rowCount(ctx.db, "claim_memory_lifecycle_events")).toBe(1);
            expect(rowCount(ctx.db, "claim_memory_current_heads")).toBe(1);
            expect(rowCount(ctx.db, "claim_usage_stats")).toBe(1);
            expect(rowCount(ctx.db, "claim_evidence")).toBe(1);
            expect(rowCount(ctx.db, "claim_revision_applicability_assertions")).toBe(1);
            expect(rowCount(ctx.db, "claim_revision_policy_subjects")).toBe(1);
            expect(rowCount(ctx.db, "claim_effective_policy")).toBe(1);
            expect(rowCount(ctx.db, "claim_operation_receipts")).toBe(1);
            expect(rowCount(ctx.db, "claim_operation_effects")).toBe(1);

            const generation = ctx.db
                .prepare("SELECT generation FROM claim_project_generations WHERE project_id = ?")
                .get(ctx.projectId) as { generation: number };
            expect(generation.generation).toBe(1);
            expect(created.result.generations[String(ctx.projectId)]).toBe(1);
            expect(created.result.effects).toHaveLength(1);
            expect(created.result.effects[0].changeKind).toBe("upsert");
            expect(created.result.effects[0].revisionLocator).toBe(
                formatRevisionLocator({
                    publicClaimId: publicId,
                    revision: 1,
                    contentDigest: claim.contentDigest,
                }),
            );
        } finally {
            closeQuietly(ctx.db);
        }
    });
});

describe("claim operations: revise (scenario 2)", () => {
    test("a dedup-identity-only revision is not treated as unchanged", () => {
        const ctx = setup();
        try {
            const created = createClaimOp(ctx, "op-create", "The project uses bun.");
            const publicId = publicIdOf(created);
            const r1 = getProjectMemoryClaimByPublicId(ctx.db, publicId);
            if (!r1) throw new Error("unreachable");
            const hashOf = (revisionId: number) =>
                (
                    ctx.db
                        .prepare(
                            "SELECT normalized_hash AS hash FROM claim_memory_revision_attributes WHERE revision_id = ?",
                        )
                        .get(revisionId) as { hash: string }
                ).hash;
            const hash1 = hashOf(r1.currentRevisionId);

            // Same bytes, same attributes, different dedup preimage: the claim
            // moves to another (project, category, hash) slot, so the fast path
            // must not swallow it and leave the stale hash on the head.
            const revised = reviseProjectMemoryClaim(
                ctx.db,
                { producer: "test", operationKey: "op-dedup-text" },
                {
                    token: computeProjectMemoryMutationToken(ctx.db, publicId),
                    dedupText: "bun runtime identity",
                    provenance: provenance("ik-dedup-text", "run-2"),
                    actor: "user:test",
                },
            );

            expect(revised.outcome).toBe("applied");
            const r2 = getProjectMemoryClaimByPublicId(ctx.db, publicId);
            expect(r2?.revision).toBe(2);
            expect(r2?.contentDigest).toBe(r1.contentDigest);
            const hash2 = hashOf(r2?.currentRevisionId as number);
            expect(hash2).not.toBe(hash1);
            expect(
                (
                    ctx.db
                        .prepare(
                            "SELECT normalized_hash AS hash FROM claim_memory_current_heads WHERE claim_id = ?",
                        )
                        .get(r1.claimId) as { hash: string }
                ).hash,
            ).toBe(hash2);
        } finally {
            closeQuietly(ctx.db);
        }
    });

    test("content and category changes append revisions and leave revision-1 bytes unchanged", () => {
        const ctx = setup();
        try {
            const created = createClaimOp(ctx, "op-create", "The project uses bun.");
            const publicId = publicIdOf(created);
            const r1 = getProjectMemoryClaimByPublicId(ctx.db, publicId);
            if (!r1) throw new Error("unreachable");
            const revision1Row = ctx.db
                .prepare("SELECT * FROM claim_revisions WHERE id = ?")
                .get(r1.currentRevisionId);
            const attributes1Row = ctx.db
                .prepare("SELECT * FROM claim_memory_revision_attributes WHERE revision_id = ?")
                .get(r1.currentRevisionId);

            const token = computeProjectMemoryMutationToken(ctx.db, publicId);
            const revised = reviseProjectMemoryClaim(
                ctx.db,
                { producer: "test", operationKey: "op-revise" },
                {
                    token,
                    content: "The project uses bun 1.3.",
                    provenance: provenance("ik-revise", "run-2"),
                    actor: "user:test",
                },
            );
            expect(revised.outcome).toBe("applied");
            const r2 = getProjectMemoryClaimByPublicId(ctx.db, publicId);
            expect(r2?.revision).toBe(2);

            const token2 = computeProjectMemoryMutationToken(ctx.db, publicId);
            const recategorized = reviseProjectMemoryClaim(
                ctx.db,
                { producer: "test", operationKey: "op-category" },
                {
                    token: token2,
                    category: "PROJECT_RULES",
                    provenance: provenance("ik-category", "run-3"),
                    actor: "user:test",
                },
            );
            expect(recategorized.outcome).toBe("applied");
            const r3 = getProjectMemoryClaimByPublicId(ctx.db, publicId);
            expect(r3?.revision).toBe(3);
            expect(r3?.contentDigest).toBe(r2?.contentDigest as string);
            const attributes3 = ctx.db
                .prepare(
                    "SELECT category FROM claim_memory_revision_attributes WHERE revision_id = ?",
                )
                .get(r3?.currentRevisionId as number) as { category: string };
            expect(attributes3.category).toBe("PROJECT_RULES");

            expect(
                ctx.db
                    .prepare("SELECT * FROM claim_revisions WHERE id = ?")
                    .get(r1.currentRevisionId),
            ).toEqual(revision1Row);
            expect(
                ctx.db
                    .prepare("SELECT * FROM claim_memory_revision_attributes WHERE revision_id = ?")
                    .get(r1.currentRevisionId),
            ).toEqual(attributes1Row);
        } finally {
            closeQuietly(ctx.db);
        }
    });
});

describe("claim operations: lifecycle (scenario 3)", () => {
    test("a lifecycle-only operation preserves revision identity and advances only the lifecycle token part", () => {
        const ctx = setup();
        try {
            const created = createClaimOp(ctx, "op-create", "Lifecycle test claim.");
            const publicId = publicIdOf(created);
            const before = computeProjectMemoryMutationToken(ctx.db, publicId);
            const archived = setProjectMemoryClaimLifecycle(
                ctx.db,
                { producer: "test", operationKey: "op-archive" },
                { token: before, state: "archived", actor: "user:test" },
            );
            expect(archived.outcome).toBe("applied");
            const after = computeProjectMemoryMutationToken(ctx.db, publicId);
            expect(after.revision).toBe(before.revision);
            expect(after.contentDigest).toBe(before.contentDigest);
            expect(after.applicabilityHeadsDigest).toBe(before.applicabilityHeadsDigest);
            expect(after.policyHeadsDigest).toBe(before.policyHeadsDigest);
            expect(after.lifecycleSeq).toBe(before.lifecycleSeq + 1);
            expect(rowCount(ctx.db, "claim_memory_lifecycle_events")).toBe(2);
            expect(rowCount(ctx.db, "claim_revisions")).toBe(1);

            // Re-setting the head state is a persisted zero-effect no-op.
            const again = setProjectMemoryClaimLifecycle(
                ctx.db,
                { producer: "test", operationKey: "op-archive-again" },
                { token: after, state: "archived", actor: "user:test" },
            );
            expect(again.outcome).toBe("noop");
            expect(again.result.effects).toHaveLength(0);
            expect(rowCount(ctx.db, "claim_memory_lifecycle_events")).toBe(2);
        } finally {
            closeQuietly(ctx.db);
        }
    });
});

describe("claim operations: stale claim-local tokens (scenario 4)", () => {
    function staleCase(mutate: (ctx: Ctx, publicId: string) => void, expectedPart: string): void {
        const ctx = setup();
        try {
            const created = createClaimOp(ctx, "op-create", "Stale fencing claim.");
            const publicId = publicIdOf(created);
            const staleToken = computeProjectMemoryMutationToken(ctx.db, publicId);
            mutate(ctx, publicId);

            const before = snapshotSemanticRows(ctx.db);
            const receiptsBefore = rowCount(ctx.db, "claim_operation_receipts");
            const attempt = reviseProjectMemoryClaim(
                ctx.db,
                { producer: "test", operationKey: "op-stale-attempt" },
                {
                    token: staleToken,
                    content: "Rewritten under a stale token.",
                    provenance: provenance("ik-stale", "run-9"),
                    actor: "user:test",
                },
            );
            expect(attempt.outcome).toBe("stale");
            expect(attempt.result.staleReason).toContain(expectedPart);
            expect(attempt.result.effects).toHaveLength(0);
            // The stale attempt adds no partial rows; it adds only the
            // zero-effect receipt.
            expect(snapshotSemanticRows(ctx.db)).toEqual(before);
            expect(rowCount(ctx.db, "claim_operation_receipts")).toBe(receiptsBefore + 1);

            // The stored stale result replays byte-identically.
            const replay = reviseProjectMemoryClaim(
                ctx.db,
                { producer: "test", operationKey: "op-stale-attempt" },
                {
                    token: staleToken,
                    content: "Rewritten under a stale token.",
                    provenance: provenance("ik-stale", "run-9"),
                    actor: "user:test",
                },
            );
            expect(replay.replayed).toBe(true);
            expect(replay.resultJson).toBe(attempt.resultJson);
            expect(snapshotSemanticRows(ctx.db)).toEqual(before);
        } finally {
            closeQuietly(ctx.db);
        }
    }

    test("a stale revision head stores one zero-effect result", () => {
        staleCase((ctx, publicId) => {
            const token = computeProjectMemoryMutationToken(ctx.db, publicId);
            reviseProjectMemoryClaim(
                ctx.db,
                { producer: "test", operationKey: "op-mutate" },
                {
                    token,
                    content: "Revised by a faster writer.",
                    provenance: provenance("ik-fast", "run-2"),
                    actor: "user:test",
                },
            );
        }, "revision");
    });

    test("a stale lifecycle head stores one zero-effect result", () => {
        staleCase((ctx, publicId) => {
            const token = computeProjectMemoryMutationToken(ctx.db, publicId);
            setProjectMemoryClaimLifecycle(
                ctx.db,
                { producer: "test", operationKey: "op-mutate" },
                { token, state: "archived", actor: "user:test" },
            );
        }, "lifecycle");
    });

    test("a stale applicability head stores one zero-effect result", () => {
        staleCase((ctx, publicId) => {
            const token = computeProjectMemoryMutationToken(ctx.db, publicId);
            const claim = getProjectMemoryClaimByPublicId(ctx.db, publicId);
            if (!claim) throw new Error("unreachable");
            applyProjectMemoryMapping(
                ctx.db,
                { producer: "test", operationKey: "op-mutate" },
                {
                    token,
                    revisionLocator: formatRevisionLocator(claim),
                    paths: { state: "known", exact: ["src/index.ts"] },
                },
            );
        }, "applicability");
    });

    test("a stale policy head stores one zero-effect result", () => {
        staleCase((ctx, publicId) => {
            const token = computeProjectMemoryMutationToken(ctx.db, publicId);
            const claim = getProjectMemoryClaimByPublicId(ctx.db, publicId);
            if (!claim) throw new Error("unreachable");
            recordProjectMemoryVerification(
                ctx.db,
                { producer: "test", operationKey: "op-mutate" },
                {
                    token,
                    revisionLocator: formatRevisionLocator(claim),
                    outcome: "verified",
                    verifier: "test-verifier",
                },
            );
        }, "policy");
    });

    test("a write to an unrelated claim does not stale the token", () => {
        const ctx = setup();
        try {
            const created = createClaimOp(ctx, "op-a", "Claim A content.");
            const publicId = publicIdOf(created);
            const token = computeProjectMemoryMutationToken(ctx.db, publicId);
            createClaimOp(ctx, "op-b", "Claim B content.");
            const archived = setProjectMemoryClaimLifecycle(
                ctx.db,
                { producer: "test", operationKey: "op-archive-a" },
                { token, state: "archived", actor: "user:test" },
            );
            expect(archived.outcome).toBe("applied");
        } finally {
            closeQuietly(ctx.db);
        }
    });
});

describe("claim operations: replay and key reuse (scenario 5)", () => {
    test("same key + same digest replays byte-identical result JSON with no new effects", () => {
        const ctx = setup();
        try {
            const created = createClaimOp(ctx, "op-create", "Replay test claim.");
            const before = snapshotSemanticRows(ctx.db);
            const replay = createClaimOp(ctx, "op-create", "Replay test claim.");
            expect(replay.replayed).toBe(true);
            expect(replay.resultJson).toBe(created.resultJson);
            expect(snapshotSemanticRows(ctx.db)).toEqual(before);
        } finally {
            closeQuietly(ctx.db);
        }
    });

    test("same key + different digest fails before the work callback runs", () => {
        const ctx = setup();
        try {
            createClaimOp(ctx, "op-create", "Replay test claim.");
            let workRan = false;
            expect(() =>
                runClaimOperation(
                    ctx.db,
                    {
                        producer: "test",
                        operationKey: "op-create",
                        requestDigest: computeClaimOperationRequestDigest({ different: true }),
                    },
                    () => {
                        workRan = true;
                        return { kind: "noop" };
                    },
                ),
            ).toThrow(ClaimOperationKeyReuseError);
            expect(workRan).toBe(false);
        } finally {
            closeQuietly(ctx.db);
        }
    });
});

describe("claim operations: duplicate statements (scenarios 6-7, R7)", () => {
    test("independent provenance for identical content attaches evidence to one revision", () => {
        const ctx = setup();
        try {
            const first = createClaimOp(ctx, "op-first", "Duplicate statement content.");
            const second = createProjectMemoryClaim(
                ctx.db,
                { producer: "test", operationKey: "op-second" },
                {
                    projectId: ctx.projectId,
                    content: "Duplicate statement content.",
                    category: "ARCHITECTURE",
                    provenance: provenance("ik-independent", "run-2"),
                    actor: "historian:test",
                },
            );
            expect(second.outcome).toBe("applied");
            expect((second.result.payload as { kind: string }).kind).toBe("evidence_attached");
            expect(rowCount(ctx.db, "claims")).toBe(1);
            expect(rowCount(ctx.db, "claim_revisions")).toBe(1);
            expect(rowCount(ctx.db, "claim_evidence")).toBe(2);
            expect(second.result.effects[0].changeKind).toBe("evidence");

            // Replaying either operation adds nothing.
            const counts = snapshotCounts(ctx.db);
            expect(createClaimOp(ctx, "op-first", "Duplicate statement content.").replayed).toBe(
                true,
            );
            const secondReplay = createProjectMemoryClaim(
                ctx.db,
                { producer: "test", operationKey: "op-second" },
                {
                    projectId: ctx.projectId,
                    content: "Duplicate statement content.",
                    category: "ARCHITECTURE",
                    provenance: provenance("ik-independent", "run-2"),
                    actor: "historian:test",
                },
            );
            expect(secondReplay.replayed).toBe(true);
            expect(secondReplay.resultJson).toBe(second.resultJson);
            expect(snapshotCounts(ctx.db)).toEqual(counts);
            expect(first.replayed).toBe(false);
        } finally {
            closeQuietly(ctx.db);
        }
    });

    test("several attachments to one claim in one receipt carry distinct effect keys", () => {
        // An autonomous manifest whose entries normalize onto the same live
        // (project, category, hash) slot creates the claim once and attaches the
        // rest. Those attachments share a claim AND a revision, so a key built
        // from those alone repeats — and `claim_operation_effects` enforces
        // UNIQUE (receipt_id, effect_key) with an append-only trigger, so the
        // duplicate aborts the whole manifest including its unrelated entries.
        const ctx = setup();
        try {
            const staged = ctx.db
                .transaction(() => {
                    const outcomes = ["ik-a", "ik-b", "ik-c"].map((key, index) =>
                        stageCreateProjectMemoryClaimInCurrentTransaction(
                            ctx.db,
                            {
                                projectId: ctx.projectId,
                                content: "One slot, three manifest entries.",
                                category: "ARCHITECTURE",
                                provenance: provenance(key, `run-${index}`),
                                actor: "historian:test",
                            },
                            1_000,
                        ),
                    );
                    return combineClaimOperationStageOutcomes(outcomes, null);
                })
                .immediate();

            if (staged.kind !== "effects") throw new Error(`unexpected stage kind ${staged.kind}`);
            // One create plus two attachments.
            expect(staged.effects).toHaveLength(3);
            expect(
                staged.effects.filter((effect) => effect.changeKind === "evidence"),
            ).toHaveLength(2);
            const keys = staged.effects.map((effect) => effect.effectKey);
            expect(new Set(keys).size).toBe(keys.length);
        } finally {
            closeQuietly(ctx.db);
        }
    });

    test("the unique current-head index converges concurrent duplicates and rebuilds from authoritative rows", () => {
        const ctx = setup();
        try {
            createClaimOp(ctx, "op-a", "Converging duplicate content.");
            createClaimOp(ctx, "op-b", "converging   DUPLICATE content.");
            expect(rowCount(ctx.db, "claims")).toBe(1);

            // A direct-SQL duplicate live head cannot exist: the partial
            // unique index is the database-boundary backstop.
            const claimRow = ctx.db
                .prepare(
                    "SELECT claim_id, project_id, category, normalized_hash, revision_id FROM claim_memory_current_heads",
                )
                .get() as {
                claim_id: number;
                project_id: number;
                category: string;
                normalized_hash: string;
                revision_id: number;
            };
            expect(() =>
                ctx.db
                    .prepare(
                        `INSERT INTO claim_memory_current_heads
                            (claim_id, project_id, category, normalized_hash, revision_id, lifecycle_state, updated_at)
                         VALUES (?, ?, ?, ?, ?, 'active', 0)`,
                    )
                    .run(
                        claimRow.claim_id + 999,
                        claimRow.project_id,
                        claimRow.category,
                        claimRow.normalized_hash,
                        claimRow.revision_id,
                    ),
            ).toThrow();

            const rows = ctx.db
                .prepare("SELECT * FROM claim_memory_current_heads ORDER BY claim_id")
                .all();
            rebuildClaimMemoryCurrentHeads(ctx.db, 0);
            const rebuilt = ctx.db
                .prepare("SELECT * FROM claim_memory_current_heads ORDER BY claim_id")
                .all() as Array<Record<string, unknown>>;
            expect(rebuilt.map(({ updated_at, ...row }) => row)).toEqual(
                (rows as Array<Record<string, unknown>>).map(({ updated_at, ...row }) => row),
            );
        } finally {
            closeQuietly(ctx.db);
        }
    });
});

describe("claim operations: generations (scenario 8)", () => {
    test("one operation touching multiple claims in one project allocates one generation", () => {
        const ctx = setup();
        try {
            const target = createClaimOp(ctx, "op-target", "Merge target content.");
            const source = createClaimOp(ctx, "op-source", "Merge source content.");
            const generationBefore = (
                ctx.db
                    .prepare(
                        "SELECT generation FROM claim_project_generations WHERE project_id = ?",
                    )
                    .get(ctx.projectId) as { generation: number }
            ).generation;
            const merged = mergeProjectMemoryClaims(
                ctx.db,
                { producer: "test", operationKey: "op-merge" },
                {
                    targetToken: computeProjectMemoryMutationToken(ctx.db, publicIdOf(target)),
                    sourceTokens: [computeProjectMemoryMutationToken(ctx.db, publicIdOf(source))],
                    actor: "user:test",
                },
            );
            expect(merged.outcome).toBe("applied");
            expect(merged.result.effects.length).toBe(2);
            const generationAfter = (
                ctx.db
                    .prepare(
                        "SELECT generation FROM claim_project_generations WHERE project_id = ?",
                    )
                    .get(ctx.projectId) as { generation: number }
            ).generation;
            expect(generationAfter).toBe(generationBefore + 1);
            expect(merged.result.generations).toEqual({
                [String(ctx.projectId)]: generationAfter,
            });
        } finally {
            closeQuietly(ctx.db);
        }
    });

    test("one operation touching two projects allocates one generation in each", () => {
        const ctx = setup();
        try {
            const otherProjectId = ensureProject(ctx.db, "git:u2-ops-other");
            const claimA = createClaimOp(ctx, "op-a", "Project one claim.");
            const claimB = createProjectMemoryClaim(
                ctx.db,
                { producer: "test", operationKey: "op-b" },
                {
                    projectId: otherProjectId,
                    content: "Project two claim.",
                    category: "ARCHITECTURE",
                    provenance: provenance("ik-b"),
                    actor: "user:test",
                },
            );
            const refA = getProjectMemoryClaimByPublicId(ctx.db, publicIdOf(claimA));
            const refB = getProjectMemoryClaimByPublicId(ctx.db, publicIdOf(claimB));
            if (!refA || !refB) throw new Error("unreachable");
            const cross = runClaimOperation(
                ctx.db,
                {
                    producer: "test",
                    operationKey: "op-cross",
                    requestDigest: computeClaimOperationRequestDigest({ op: "cross" }),
                },
                () => ({
                    kind: "effects",
                    payload: null,
                    effects: [
                        {
                            effectKey: "cross:a",
                            projectId: refA.projectId,
                            claimId: refA.claimId,
                            revisionId: refA.currentRevisionId,
                            changeKind: "evidence",
                        },
                        {
                            effectKey: "cross:b",
                            projectId: refB.projectId,
                            claimId: refB.claimId,
                            revisionId: refB.currentRevisionId,
                            changeKind: "evidence",
                        },
                    ],
                }),
            );
            expect(cross.outcome).toBe("applied");
            expect(cross.result.generations).toEqual({
                [String(ctx.projectId)]: 2,
                [String(otherProjectId)]: 2,
            });
        } finally {
            closeQuietly(ctx.db);
        }
    });
});

describe("claim operations: commit agreement (scenario 9)", () => {
    test("policy projection, outbox rows, effect summary, generation vector, and declared count agree", () => {
        const ctx = setup();
        try {
            const created = createClaimOp(ctx, "op-create", "Agreement test claim.");
            const receipt = ctx.db
                .prepare(
                    `SELECT id, expected_effect_count AS expectedEffectCount,
                            effect_summary_json AS effectSummaryJson,
                            generation_vector_json AS generationVectorJson
                       FROM claim_operation_receipts WHERE operation_key = 'op-create'`,
                )
                .get() as {
                id: number;
                expectedEffectCount: number;
                effectSummaryJson: string;
                generationVectorJson: string;
            };
            const outbox = ctx.db
                .prepare(
                    `SELECT effect_key AS effectKey, change_kind AS changeKind,
                            project_id AS projectId, generation
                       FROM claim_operation_effects WHERE receipt_id = ? ORDER BY id`,
                )
                .all(receipt.id) as Array<{
                effectKey: string;
                changeKind: string;
                projectId: number;
                generation: number;
            }>;
            expect(outbox).toHaveLength(receipt.expectedEffectCount);
            const summary = JSON.parse(receipt.effectSummaryJson) as Array<{
                effectKey: string;
                changeKind: string;
                projectId: number;
                generation: number;
            }>;
            expect(
                summary.map(({ effectKey, changeKind, projectId, generation }) => ({
                    effectKey,
                    changeKind,
                    projectId,
                    generation,
                })),
            ).toEqual(outbox);
            expect(JSON.parse(receipt.generationVectorJson)).toEqual(created.result.generations);
            const projection = ctx.db
                .prepare(
                    `SELECT generation FROM claim_effective_policy
                      WHERE revision_id = (SELECT current_revision_id FROM claims LIMIT 1)`,
                )
                .get() as { generation: number };
            expect(projection.generation).toBe(created.result.generations[String(ctx.projectId)]);
        } finally {
            closeQuietly(ctx.db);
        }
    });
});

describe("claim outbox: checkpoints and pruning (scenarios 10-11)", () => {
    function seedOutbox(ctx: Ctx): { maxEffectId: number } {
        createClaimOp(ctx, "op-1", "First claim content.");
        const target = createClaimOp(ctx, "op-2", "Second claim content.");
        const source = createClaimOp(ctx, "op-3", "Third claim content.");
        // The merge receipt groups two effects.
        mergeProjectMemoryClaims(
            ctx.db,
            { producer: "test", operationKey: "op-merge" },
            {
                targetToken: computeProjectMemoryMutationToken(ctx.db, publicIdOf(target)),
                sourceTokens: [computeProjectMemoryMutationToken(ctx.db, publicIdOf(source))],
                actor: "user:test",
            },
        );
        const max = ctx.db.prepare("SELECT MAX(id) AS max FROM claim_operation_effects").get() as {
            max: number;
        };
        return { maxEffectId: max.max };
    }

    test("consumers advance independently and pruning stops at the minimum complete receipt boundary", () => {
        const ctx = setup();
        try {
            const { maxEffectId } = seedOutbox(ctx);
            expect(rowCount(ctx.db, "claim_operation_effects")).toBe(5);
            ctx.db
                .transaction(() => {
                    advanceOutboxConsumerCheckpointInCurrentTransaction(ctx.db, {
                        consumer: "module-mirror",
                        projectId: ctx.projectId,
                        ackedEffectId: maxEffectId,
                    });
                    advanceOutboxConsumerCheckpointInCurrentTransaction(ctx.db, {
                        consumer: "policy-projector",
                        projectId: ctx.projectId,
                        ackedEffectId: 2,
                    });
                    advanceOutboxConsumerCheckpointInCurrentTransaction(ctx.db, {
                        consumer: "retrieval-projector",
                        projectId: ctx.projectId,
                        ackedEffectId: 3,
                    });
                })
                .immediate();
            expect(readOutboxConsumerCheckpoint(ctx.db, "module-mirror", ctx.projectId)).toBe(
                maxEffectId,
            );

            const receiptsBefore = rowCount(ctx.db, "claim_operation_receipts");
            const pruned = ctx.db
                .transaction(() =>
                    pruneClaimOperationEffectsInCurrentTransaction(ctx.db, [
                        "module-mirror",
                        "policy-projector",
                        "retrieval-projector",
                    ]),
                )
                .immediate();
            expect(pruned.boundary).toBe(2);
            expect(pruned.prunedEffectRows).toBe(2);
            expect(rowCount(ctx.db, "claim_operation_effects")).toBe(3);
            // Receipts never leave (R20).
            expect(rowCount(ctx.db, "claim_operation_receipts")).toBe(receiptsBefore);

            // A consumer with no checkpoint pins the boundary at zero.
            const noProgress = ctx.db
                .transaction(() =>
                    pruneClaimOperationEffectsInCurrentTransaction(ctx.db, [
                        "module-mirror",
                        "unregistered-consumer",
                    ]),
                )
                .immediate();
            expect(noProgress.boundary).toBe(0);
            expect(noProgress.prunedEffectRows).toBe(0);
        } finally {
            closeQuietly(ctx.db);
        }
    });

    test("a project the consumer never checkpointed pins the boundary at zero", () => {
        // Checkpoints are keyed (consumer, project_id) while the delete is
        // global over effect ids, so a consumer caught up on one project must
        // not license pruning another project's unprocessed effects.
        const ctx = setup();
        try {
            const otherProjectId = ensureProject(ctx.db, "git:u2-ops-other");
            createClaimOp({ db: ctx.db, projectId: otherProjectId }, "op-other", "Other project.");
            const { maxEffectId } = seedOutbox(ctx);
            const effectsBefore = rowCount(ctx.db, "claim_operation_effects");

            ctx.db
                .transaction(() => {
                    advanceOutboxConsumerCheckpointInCurrentTransaction(ctx.db, {
                        consumer: "module-mirror",
                        projectId: ctx.projectId,
                        ackedEffectId: maxEffectId,
                    });
                })
                .immediate();

            const pruned = ctx.db
                .transaction(() =>
                    pruneClaimOperationEffectsInCurrentTransaction(ctx.db, ["module-mirror"]),
                )
                .immediate();
            expect(pruned.boundary).toBe(0);
            expect(pruned.prunedEffectRows).toBe(0);
            expect(rowCount(ctx.db, "claim_operation_effects")).toBe(effectsBefore);

            // Checkpointing the second project too releases the boundary.
            ctx.db
                .transaction(() => {
                    advanceOutboxConsumerCheckpointInCurrentTransaction(ctx.db, {
                        consumer: "module-mirror",
                        projectId: otherProjectId,
                        ackedEffectId: maxEffectId,
                    });
                })
                .immediate();
            const after = ctx.db
                .transaction(() =>
                    pruneClaimOperationEffectsInCurrentTransaction(ctx.db, ["module-mirror"]),
                )
                .immediate();
            expect(after.boundary).toBe(maxEffectId);
            expect(after.prunedEffectRows).toBeGreaterThan(0);
        } finally {
            closeQuietly(ctx.db);
        }
    });

    test("a checkpoint beyond the outbox tail is refused", () => {
        // A cursor past the tail claims effects that do not exist. The
        // receipt-split guard cannot see it — there is no pending row beyond
        // such an id — and once every required consumer holds one, the prune
        // boundary becomes that future id and later effects are deleted unread.
        const ctx = setup();
        try {
            const { maxEffectId } = seedOutbox(ctx);
            expect(() =>
                ctx.db
                    .transaction(() =>
                        advanceOutboxConsumerCheckpointInCurrentTransaction(ctx.db, {
                            consumer: "module-mirror",
                            projectId: ctx.projectId,
                            ackedEffectId: maxEffectId + 1,
                        }),
                    )
                    .immediate(),
            ).toThrow("beyond the outbox tail");

            // The tail itself is fine, and re-acknowledging it stays idempotent
            // after pruning empties the table — those effects are gone because
            // they were consumed.
            ctx.db
                .transaction(() => {
                    for (const consumer of [
                        "module-mirror",
                        "policy-projector",
                        "retrieval-projector",
                    ]) {
                        advanceOutboxConsumerCheckpointInCurrentTransaction(ctx.db, {
                            consumer,
                            projectId: ctx.projectId,
                            ackedEffectId: maxEffectId,
                        });
                    }
                })
                .immediate();
            ctx.db
                .transaction(() =>
                    pruneClaimOperationEffectsInCurrentTransaction(ctx.db, [
                        "module-mirror",
                        "policy-projector",
                        "retrieval-projector",
                    ]),
                )
                .immediate();
            expect(rowCount(ctx.db, "claim_operation_effects")).toBe(0);
            expect(() =>
                ctx.db
                    .transaction(() =>
                        advanceOutboxConsumerCheckpointInCurrentTransaction(ctx.db, {
                            consumer: "module-mirror",
                            projectId: ctx.projectId,
                            ackedEffectId: maxEffectId,
                        }),
                    )
                    .immediate(),
            ).not.toThrow();
        } finally {
            closeQuietly(ctx.db);
        }
    });

    test("a checkpoint cannot split a receipt group and cannot regress", () => {
        const ctx = setup();
        try {
            const { maxEffectId } = seedOutbox(ctx);
            // The merge receipt owns the last two effect ids; acking between
            // them would expose half an operation.
            expect(() =>
                ctx.db
                    .transaction(() =>
                        advanceOutboxConsumerCheckpointInCurrentTransaction(ctx.db, {
                            consumer: "module-mirror",
                            projectId: ctx.projectId,
                            ackedEffectId: maxEffectId - 1,
                        }),
                    )
                    .immediate(),
            ).toThrow(/splits a receipt group/);
            ctx.db
                .transaction(() =>
                    advanceOutboxConsumerCheckpointInCurrentTransaction(ctx.db, {
                        consumer: "module-mirror",
                        projectId: ctx.projectId,
                        ackedEffectId: maxEffectId,
                    }),
                )
                .immediate();
            expect(() =>
                ctx.db
                    .transaction(() =>
                        advanceOutboxConsumerCheckpointInCurrentTransaction(ctx.db, {
                            consumer: "module-mirror",
                            projectId: ctx.projectId,
                            ackedEffectId: 1,
                        }),
                    )
                    .immediate(),
            ).toThrow(/cannot regress/);
        } finally {
            closeQuietly(ctx.db);
        }
    });

    test("pruning and restart leave the lifetime receipt and late replay intact", () => {
        const dir = mkdtempSync(join(tmpdir(), "mc-u2-outbox-"));
        const path = join(dir, "context.db");
        try {
            const ctx = { db: directDb(path), projectId: 0 } as Ctx;
            ctx.projectId = ensureProject(ctx.db, "git:u2-ops");
            const created = createClaimOp(ctx, "op-durable", "Durable replay claim.");
            const maxEffectId = (
                ctx.db.prepare("SELECT MAX(id) AS max FROM claim_operation_effects").get() as {
                    max: number;
                }
            ).max;
            ctx.db
                .transaction(() => {
                    advanceOutboxConsumerCheckpointInCurrentTransaction(ctx.db, {
                        consumer: "module-mirror",
                        projectId: ctx.projectId,
                        ackedEffectId: maxEffectId,
                    });
                    pruneClaimOperationEffectsInCurrentTransaction(ctx.db, ["module-mirror"]);
                })
                .immediate();
            expect(rowCount(ctx.db, "claim_operation_effects")).toBe(0);
            expect(rowCount(ctx.db, "claim_operation_receipts")).toBe(1);
            closeQuietly(ctx.db);

            const reopened = new Database(path);
            try {
                reopened.exec("PRAGMA foreign_keys=ON");
                const replay = createProjectMemoryClaim(
                    reopened,
                    { producer: "test", operationKey: "op-durable" },
                    {
                        projectId: ctx.projectId,
                        content: "Durable replay claim.",
                        category: "ARCHITECTURE",
                        provenance: provenance("ik-op-durable"),
                        actor: "user:test",
                    },
                );
                expect(replay.replayed).toBe(true);
                expect(replay.resultJson).toBe(created.resultJson);
            } finally {
                closeQuietly(reopened);
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("effect deletes require the prune capability and receipts never delete", () => {
        const ctx = setup();
        try {
            seedOutbox(ctx);
            expect(() => ctx.db.prepare("DELETE FROM claim_operation_effects").run()).toThrow(
                /prune capability/,
            );
            expect(() => ctx.db.prepare("DELETE FROM claim_operation_receipts").run()).toThrow(
                /whole-database reset/,
            );
        } finally {
            closeQuietly(ctx.db);
        }
    });
});

/** Observation IDs linked to one revision, optionally narrowed to one relation. */
function evidenceObservationIds(
    db: Database,
    revisionId: number,
    relation?: "supports" | "merged_from",
): number[] {
    return (
        db
            .prepare(
                `SELECT observation_id AS observationId FROM claim_evidence
                  WHERE revision_id = ? AND (? IS NULL OR relation = ?)
                  ORDER BY observation_id`,
            )
            .all(revisionId, relation ?? null, relation ?? null) as Array<{
            observationId: number;
        }>
    ).map((row) => row.observationId);
}

function currentRevisionIdOf(ctx: Ctx, publicClaimId: string): number {
    const claim = getProjectMemoryClaimByPublicId(ctx.db, publicClaimId);
    if (!claim) throw new Error(`unknown claim ${publicClaimId}`);
    return claim.currentRevisionId;
}

/** The single observation a freshly created claim's revision 1 carries. */
function soleObservationIdOf(ctx: Ctx, publicClaimId: string): number {
    const ids = evidenceObservationIds(ctx.db, currentRevisionIdOf(ctx, publicClaimId));
    if (ids.length !== 1) {
        throw new Error(`expected one observation for ${publicClaimId}, found ${ids.length}`);
    }
    return ids[0];
}

function mergeOp(
    ctx: Ctx,
    key: string,
    targetPublicId: string,
    sourcePublicIds: readonly string[],
    mergedContent: string,
) {
    return mergeProjectMemoryClaims(
        ctx.db,
        { producer: "test", operationKey: key },
        {
            targetToken: computeProjectMemoryMutationToken(ctx.db, targetPublicId),
            sourceTokens: sourcePublicIds.map((publicId) =>
                computeProjectMemoryMutationToken(ctx.db, publicId),
            ),
            mergedContent,
            actor: "user:test",
        },
    );
}

function ascending(ids: readonly number[]): number[] {
    return [...ids].sort((left, right) => left - right);
}

describe("claim operations: same-project merge (R8, AE6)", () => {
    test("merge appends one target revision, preserves source evidence, and retires sources without trust transfer", () => {
        const ctx = setup();
        try {
            const target = createClaimOp(ctx, "op-target", "Target claim content.", {
                provenance: provenance("ik-target", "run-1", "explicit_user"),
            });
            const sourceA = createClaimOp(ctx, "op-source-a", "Source A content.");
            const sourceB = createClaimOp(ctx, "op-source-b", "Source B content.");
            const targetId = publicIdOf(target);
            const sourceAId = publicIdOf(sourceA);
            const sourceBId = publicIdOf(sourceB);
            const sourceARef = getProjectMemoryClaimByPublicId(ctx.db, sourceAId);
            const sourceBRef = getProjectMemoryClaimByPublicId(ctx.db, sourceBId);
            if (!sourceARef || !sourceBRef) throw new Error("unreachable");

            const merged = mergeProjectMemoryClaims(
                ctx.db,
                { producer: "test", operationKey: "op-merge" },
                {
                    targetToken: computeProjectMemoryMutationToken(ctx.db, targetId),
                    sourceTokens: [
                        computeProjectMemoryMutationToken(ctx.db, sourceAId),
                        computeProjectMemoryMutationToken(ctx.db, sourceBId),
                    ],
                    mergedContent: "Source A content.",
                    actor: "user:test",
                },
            );
            expect(merged.outcome).toBe("applied");
            const targetRef = getProjectMemoryClaimByPublicId(ctx.db, targetId);
            expect(targetRef?.revision).toBe(2);

            // Source evidence rows survive untouched and back the new target
            // revision through merged_from links.
            const mergedEvidence = ctx.db
                .prepare(
                    `SELECT COUNT(*) AS count FROM claim_evidence
                      WHERE revision_id = ? AND relation = 'merged_from'`,
                )
                .get(targetRef?.currentRevisionId as number) as { count: number };
            expect(mergedEvidence.count).toBe(2);
            for (const source of [sourceARef, sourceBRef]) {
                expect(
                    (
                        ctx.db
                            .prepare(
                                "SELECT COUNT(*) AS count FROM claim_evidence WHERE revision_id = ?",
                            )
                            .get(source.currentRevisionId) as { count: number }
                    ).count,
                ).toBe(1);
                const head = ctx.db
                    .prepare("SELECT state FROM claim_memory_lifecycle_heads WHERE claim_id = ?")
                    .get(source.claimId) as { state: string };
                expect(head.state).toBe("retired");
                const supersedes = ctx.db
                    .prepare(
                        `SELECT COUNT(*) AS count FROM claim_conflicts
                          WHERE relation = 'supersedes' AND right_revision_id = ?`,
                    )
                    .get(source.currentRevisionId) as { count: number };
                expect(supersedes.count).toBe(1);
            }

            // No trust or approval transfer: the merged revision opens its
            // own conservative inference-tainted subject with no approvals.
            const subject = ctx.db
                .prepare(
                    `SELECT origin_taint AS originTaint FROM claim_revision_policy_subjects
                      WHERE revision_id = ?`,
                )
                .get(targetRef?.currentRevisionId as number) as { originTaint: string };
            expect(subject.originTaint).toBe("ASSISTANT_INFERENCE");
            expect(
                (
                    ctx.db
                        .prepare(
                            "SELECT COUNT(*) AS count FROM claim_approval_actions WHERE revision_id = ?",
                        )
                        .get(targetRef?.currentRevisionId as number) as { count: number }
                ).count,
            ).toBe(0);
        } finally {
            closeQuietly(ctx.db);
        }
    });

    test("a merge-produced source carries its merged_from lineage into the next merge", () => {
        const ctx = setup();
        try {
            const sourceA = publicIdOf(createClaimOp(ctx, "op-a", "Source A content."));
            const sourceB = publicIdOf(createClaimOp(ctx, "op-b", "Source B content."));
            const firstTarget = publicIdOf(createClaimOp(ctx, "op-c", "First target content."));
            const plainSource = publicIdOf(createClaimOp(ctx, "op-d", "Plain source content."));
            const secondTarget = publicIdOf(createClaimOp(ctx, "op-e", "Second target content."));
            const observationA = soleObservationIdOf(ctx, sourceA);
            const observationB = soleObservationIdOf(ctx, sourceB);
            const observationD = soleObservationIdOf(ctx, plainSource);

            const first = mergeOp(
                ctx,
                "op-merge-1",
                firstTarget,
                [sourceA, sourceB],
                "Merged once content.",
            );
            expect(first.outcome).toBe("applied");
            const firstRevisionId = currentRevisionIdOf(ctx, firstTarget);
            // A merge-produced revision records its lineage exclusively as
            // merged_from, so a supports-only lookup finds nothing here.
            expect(evidenceObservationIds(ctx.db, firstRevisionId, "supports")).toEqual([]);
            expect(evidenceObservationIds(ctx.db, firstRevisionId, "merged_from")).toEqual(
                ascending([observationA, observationB]),
            );

            // Mixed sources: the merge-produced source's transitive lineage
            // survives alongside the plain source's own observation.
            const second = mergeOp(
                ctx,
                "op-merge-2",
                secondTarget,
                [firstTarget, plainSource],
                "Merged twice content.",
            );
            expect(second.outcome).toBe("applied");
            expect(
                evidenceObservationIds(
                    ctx.db,
                    currentRevisionIdOf(ctx, secondTarget),
                    "merged_from",
                ),
            ).toEqual(ascending([observationA, observationB, observationD]));
        } finally {
            closeQuietly(ctx.db);
        }
    });

    test("a merge whose every source is merge-produced unions their lineage", () => {
        const ctx = setup();
        try {
            const leafA = publicIdOf(createClaimOp(ctx, "op-leaf-a", "Leaf A content."));
            const leafB = publicIdOf(createClaimOp(ctx, "op-leaf-b", "Leaf B content."));
            const mergedA = publicIdOf(createClaimOp(ctx, "op-mid-a", "Mid A content."));
            const mergedB = publicIdOf(createClaimOp(ctx, "op-mid-b", "Mid B content."));
            const finalTarget = publicIdOf(createClaimOp(ctx, "op-final", "Final target content."));
            const observationA = soleObservationIdOf(ctx, leafA);
            const observationB = soleObservationIdOf(ctx, leafB);

            expect(mergeOp(ctx, "op-mid-merge-a", mergedA, [leafA], "Mid A merged.").outcome).toBe(
                "applied",
            );
            expect(mergeOp(ctx, "op-mid-merge-b", mergedB, [leafB], "Mid B merged.").outcome).toBe(
                "applied",
            );

            // Neither source holds a supports row, so a supports-only evidence
            // read would leave this merge with nothing to carry forward.
            const final = mergeOp(
                ctx,
                "op-final-merge",
                finalTarget,
                [mergedA, mergedB],
                "Final merged content.",
            );
            expect(final.outcome).toBe("applied");
            expect(
                evidenceObservationIds(
                    ctx.db,
                    currentRevisionIdOf(ctx, finalTarget),
                    "merged_from",
                ),
            ).toEqual(ascending([observationA, observationB]));
        } finally {
            closeQuietly(ctx.db);
        }
    });

    test("one stale source token aborts the whole merge with a zero-effect result", () => {
        const ctx = setup();
        try {
            const target = createClaimOp(ctx, "op-target", "Target claim content.");
            const source = createClaimOp(ctx, "op-source", "Source claim content.");
            const staleSourceToken = computeProjectMemoryMutationToken(ctx.db, publicIdOf(source));
            reviseProjectMemoryClaim(
                ctx.db,
                { producer: "test", operationKey: "op-move-source" },
                {
                    token: staleSourceToken,
                    content: "Source moved on.",
                    provenance: provenance("ik-move", "run-2"),
                    actor: "user:test",
                },
            );
            const before = snapshotCounts(ctx.db);
            const merged = mergeProjectMemoryClaims(
                ctx.db,
                { producer: "test", operationKey: "op-merge" },
                {
                    targetToken: computeProjectMemoryMutationToken(ctx.db, publicIdOf(target)),
                    sourceTokens: [staleSourceToken],
                    actor: "user:test",
                },
            );
            expect(merged.outcome).toBe("stale");
            expect(merged.result.effects).toHaveLength(0);
            expect(snapshotCounts(ctx.db)).toEqual(before);
        } finally {
            closeQuietly(ctx.db);
        }
    });

    test("a merge that keeps the target content keeps the target's own evidence", () => {
        // Built from source observations only, the merged revision dropped the
        // target's attestation of bytes it still holds — invisible in evidence
        // summaries, and gone from the chain once this claim is merged again.
        const ctx = setup();
        try {
            const target = createClaimOp(ctx, "op-target", "Target claim content.");
            const source = createClaimOp(ctx, "op-source", "Source claim content.");
            const targetObservations = ctx.db
                .prepare(
                    `SELECT observation_id AS observationId FROM claim_evidence
                      WHERE revision_id = (SELECT current_revision_id FROM claims
                                            WHERE id = (SELECT claim_id FROM claim_public_ids
                                                         WHERE public_id = ?))
                        AND relation = 'supports'`,
                )
                .all(publicIdOf(target)) as Array<{ observationId: number }>;
            expect(targetObservations.length).toBeGreaterThan(0);

            // mergedContent omitted, so the target keeps its bytes.
            const merged = mergeProjectMemoryClaims(
                ctx.db,
                { producer: "test", operationKey: "op-merge" },
                {
                    targetToken: computeProjectMemoryMutationToken(ctx.db, publicIdOf(target)),
                    sourceTokens: [computeProjectMemoryMutationToken(ctx.db, publicIdOf(source))],
                    actor: "user:test",
                },
            );
            expect(merged.outcome).toBe("applied");

            const carried = ctx.db
                .prepare(
                    `SELECT observation_id AS observationId FROM claim_evidence
                      WHERE revision_id = (SELECT current_revision_id FROM claims
                                            WHERE id = (SELECT claim_id FROM claim_public_ids
                                                         WHERE public_id = ?))`,
                )
                .all(publicIdOf(target)) as Array<{ observationId: number }>;
            const carriedIds = new Set(carried.map((row) => row.observationId));
            for (const row of targetObservations) {
                expect(carriedIds.has(row.observationId)).toBe(true);
            }
        } finally {
            closeQuietly(ctx.db);
        }
    });

    test("a cross-category merge is refused before any claim is retired", () => {
        // A merge keeps the target's category and terminally retires every
        // source, so merging across categories destroys the source category's
        // live fact. The pre-cutover `merge_memories` rejected this before any
        // store mutation and the curator prompt still promises it.
        const ctx = setup();
        try {
            const target = createClaimOp(ctx, "op-target", "Target claim content.");
            const source = createClaimOp(ctx, "op-source", "Source claim content.", {
                category: "CONSTRAINTS",
            });
            const before = snapshotCounts(ctx.db);
            expect(() =>
                mergeProjectMemoryClaims(
                    ctx.db,
                    { producer: "test", operationKey: "op-merge" },
                    {
                        targetToken: computeProjectMemoryMutationToken(ctx.db, publicIdOf(target)),
                        sourceTokens: [
                            computeProjectMemoryMutationToken(ctx.db, publicIdOf(source)),
                        ],
                        actor: "user:test",
                    },
                ),
            ).toThrow(/cross-category merge is refused/);
            // Nothing staged, so the source's distinct fact is still live.
            expect(snapshotCounts(ctx.db)).toEqual(before);
        } finally {
            closeQuietly(ctx.db);
        }
    });

    test("merged content may keep a source's exact wording", () => {
        // The sources are still `active` when the duplicate-content guard runs
        // and only retire later in the same transaction, so a merge that keeps
        // one source's wording — the common outcome — must not read that source
        // as the pre-existing owner of the coordinate.
        const ctx = setup();
        try {
            const target = createClaimOp(ctx, "op-target", "Target claim content.");
            const source = createClaimOp(ctx, "op-source", "Source claim content.");
            const sourceRef = getProjectMemoryClaimByPublicId(ctx.db, publicIdOf(source));
            if (!sourceRef) throw new Error("unreachable");

            const merged = mergeProjectMemoryClaims(
                ctx.db,
                { producer: "test", operationKey: "op-merge" },
                {
                    targetToken: computeProjectMemoryMutationToken(ctx.db, publicIdOf(target)),
                    sourceTokens: [computeProjectMemoryMutationToken(ctx.db, publicIdOf(source))],
                    mergedContent: "Source claim content.",
                    actor: "user:test",
                },
            );

            expect(merged.outcome).toBe("applied");
            const targetRef = getProjectMemoryClaimByPublicId(ctx.db, publicIdOf(target));
            expect(targetRef?.revision).toBe(2);
            expect(
                (
                    ctx.db
                        .prepare(
                            "SELECT state FROM claim_memory_lifecycle_heads WHERE claim_id = ?",
                        )
                        .get(sourceRef.claimId) as { state: string }
                ).state,
            ).toBe("retired");
            // The retired source vacates the coordinate, so exactly one live
            // claim owns the merged content afterwards.
            expect(
                (
                    ctx.db
                        .prepare(
                            `SELECT COUNT(*) AS count FROM claim_memory_current_heads
                              WHERE normalized_hash = (
                                  SELECT normalized_hash FROM claim_memory_current_heads
                                  WHERE claim_id = ?)
                                AND lifecycle_state = 'active'`,
                        )
                        .get(targetRef?.claimId as number) as { count: number }
                ).count,
            ).toBe(1);
        } finally {
            closeQuietly(ctx.db);
        }
    });
});

describe("claim operations: mapping and verification (scenario 14)", () => {
    test("unknown, exact, known-empty, and clear mappings append against the exact revision", () => {
        const ctx = setup();
        try {
            const created = createClaimOp(ctx, "op-create", "Mapping test claim.");
            const publicId = publicIdOf(created);
            const claim = getProjectMemoryClaimByPublicId(ctx.db, publicId);
            if (!claim) throw new Error("unreachable");
            const locator = formatRevisionLocator(claim);
            const steps: Array<{
                key: string;
                paths: Parameters<typeof applyProjectMemoryMapping>[2]["paths"];
                expectOutcome: "applied" | "noop";
            }> = [
                { key: "map-unknown", paths: { state: "unknown" }, expectOutcome: "noop" },
                {
                    key: "map-exact",
                    paths: { state: "known", exact: ["src/a.ts", "src/b.ts"] },
                    expectOutcome: "applied",
                },
                {
                    key: "map-empty",
                    paths: { state: "known", exact: [] },
                    expectOutcome: "applied",
                },
                { key: "map-clear", paths: { state: "unknown" }, expectOutcome: "applied" },
            ];
            for (const step of steps) {
                const token = computeProjectMemoryMutationToken(ctx.db, publicId);
                const outcome = applyProjectMemoryMapping(
                    ctx.db,
                    { producer: "test", operationKey: step.key },
                    { token, revisionLocator: locator, paths: step.paths },
                );
                expect(outcome.outcome).toBe(step.expectOutcome);
                if (step.expectOutcome === "applied") {
                    expect(outcome.result.effects[0].changeKind).toBe("applicability");
                    expect(outcome.result.effects[0].revisionLocator).toBe(locator);
                }
            }
            // Baseline stream: opening assertion plus the three appends.
            expect(rowCount(ctx.db, "claim_revision_applicability_assertions")).toBe(4);

            // A mapping computed against a superseded revision is stale.
            const oldToken = computeProjectMemoryMutationToken(ctx.db, publicId);
            reviseProjectMemoryClaim(
                ctx.db,
                { producer: "test", operationKey: "op-revise" },
                {
                    token: oldToken,
                    content: "Mapping test claim, revised.",
                    provenance: provenance("ik-revise", "run-2"),
                    actor: "user:test",
                },
            );
            const staleMap = applyProjectMemoryMapping(
                ctx.db,
                { producer: "test", operationKey: "map-stale" },
                {
                    token: computeProjectMemoryMutationToken(ctx.db, publicId),
                    revisionLocator: locator,
                    paths: { state: "known", exact: ["src/c.ts"] },
                },
            );
            expect(staleMap.outcome).toBe("stale");
        } finally {
            closeQuietly(ctx.db);
        }
    });

    test("verification outcomes append events against the exact revision and share the operation effects", () => {
        const ctx = setup();
        try {
            const created = createClaimOp(ctx, "op-create", "Verification test claim.");
            const publicId = publicIdOf(created);
            const claim = getProjectMemoryClaimByPublicId(ctx.db, publicId);
            if (!claim) throw new Error("unreachable");
            const locator = formatRevisionLocator(claim);
            for (const outcome of ["verified", "stale"] as const) {
                const token = computeProjectMemoryMutationToken(ctx.db, publicId);
                const recorded = recordProjectMemoryVerification(
                    ctx.db,
                    { producer: "test", operationKey: `verify-${outcome}` },
                    { token, revisionLocator: locator, outcome, verifier: "test-verifier" },
                );
                expect(recorded.outcome).toBe("applied");
                expect(recorded.result.effects[0].changeKind).toBe("verification");
            }
            const events = ctx.db
                .prepare(
                    "SELECT outcome FROM verification_events WHERE revision_id = ? ORDER BY id",
                )
                .all(claim.currentRevisionId) as Array<{ outcome: string }>;
            expect(events.map((event) => event.outcome)).toEqual(["verified", "stale"]);
            // The latest outcome flows into the effective policy projection.
            const projection = ctx.db
                .prepare(
                    "SELECT dispositions_json AS dispositions FROM claim_effective_policy WHERE revision_id = ?",
                )
                .get(claim.currentRevisionId) as { dispositions: string };
            expect(JSON.parse(projection.dispositions)).toContain("stale");
        } finally {
            closeQuietly(ctx.db);
        }
    });
});

describe("claim usage telemetry (R3)", () => {
    test("empty usage batches do not open a transaction", () => {
        const ctx = setup();
        try {
            const originalTransaction = ctx.db.transaction.bind(ctx.db);
            let transactions = 0;
            ctx.db.transaction = ((callback: () => unknown) => {
                transactions += 1;
                return originalTransaction(callback);
            }) as typeof ctx.db.transaction;

            recordClaimUsage(ctx.db, { publicClaimIds: [], kind: "retrieved" });
            expect(transactions).toBe(0);
        } finally {
            closeQuietly(ctx.db);
        }
    });

    test("counters mutate without receipts or generation movement", () => {
        const ctx = setup();
        try {
            const created = createClaimOp(ctx, "op-create", "Telemetry test claim.");
            const publicId = publicIdOf(created);
            const receipts = rowCount(ctx.db, "claim_operation_receipts");
            recordClaimUsage(ctx.db, { publicClaimIds: [publicId], kind: "seen" });
            recordClaimUsage(ctx.db, { publicClaimIds: [publicId], kind: "retrieved" });
            recordClaimUsage(ctx.db, { publicClaimIds: [publicId], kind: "retrieved" });
            const stats = ctx.db
                .prepare(
                    `SELECT seen_count AS seen, retrieval_count AS retrieved
                       FROM claim_usage_stats
                       JOIN claim_public_ids USING (claim_id)
                      WHERE public_id = ?`,
                )
                .get(publicId) as { seen: number; retrieved: number };
            expect(stats).toEqual({ seen: 1, retrieved: 2 });
            expect(rowCount(ctx.db, "claim_operation_receipts")).toBe(receipts);
            expect(
                (
                    ctx.db
                        .prepare(
                            "SELECT generation FROM claim_project_generations WHERE project_id = ?",
                        )
                        .get(ctx.projectId) as { generation: number }
                ).generation,
            ).toBe(1);
        } finally {
            closeQuietly(ctx.db);
        }
    });
});

describe("claim operation contract: golden vectors (scenario 13)", () => {
    test("vocabulary matches the fixture shared with mc-core", () => {
        expect(CLAIM_REQUEST_ENCODING_VERSION).toBe(contractFixture.requestEncodingVersion);
        expect(CLAIM_RESULT_ENCODING_VERSION).toBe(contractFixture.resultEncodingVersion);
        expect(CLAIM_REQUEST_DIGEST_PROTOCOL).toBe(contractFixture.digestProtocols.request);
        expect(CLAIM_MUTATION_TOKEN_DIGEST_PROTOCOL).toBe(
            contractFixture.digestProtocols.mutationToken,
        );
    });

    test("canonical bytes and request digests match the fixture", () => {
        for (const item of contractFixture.canonicalization) {
            expect(canonicalJsonEncode(item.value)).toBe(item.canonical);
            expect(computeClaimOperationRequestDigest(item.value)).toBe(item.requestDigest);
        }
        for (const item of contractFixture.invalidCanonical) {
            expect(() => canonicalJsonEncode(JSON.parse(item.valueJson))).toThrow();
        }
    });

    test("public locator validation matches the fixture", () => {
        for (const id of contractFixture.publicClaimIds.valid) {
            expect(isValidPublicClaimId(id)).toBe(true);
        }
        for (const id of contractFixture.publicClaimIds.invalid) {
            expect(isValidPublicClaimId(id)).toBe(false);
        }
        for (const item of contractFixture.revisionLocators.valid) {
            expect(parseRevisionLocator(item.locator)).toEqual({
                publicClaimId: item.publicClaimId,
                revision: item.revision,
                contentDigest: item.contentDigest,
            });
            expect(
                formatRevisionLocator({
                    publicClaimId: item.publicClaimId,
                    revision: item.revision,
                    contentDigest: item.contentDigest,
                }),
            ).toBe(item.locator);
        }
        for (const raw of contractFixture.revisionLocators.invalid) {
            expect(parseRevisionLocator(raw)).toBeNull();
        }
    });

    test("claim tokens, head digests, and snapshot vectors match the fixture", () => {
        for (const item of contractFixture.mutationTokens) {
            const token = item.token as ClaimMutationToken;
            expect(canonicalClaimMutationToken(token)).toBe(item.canonical);
            expect(computeClaimMutationTokenDigest(token)).toBe(item.digest);
        }
        for (const item of contractFixture.applicabilityHeads) {
            expect(computeApplicabilityHeadsDigest(item.heads)).toBe(item.digest);
        }
        for (const item of contractFixture.policyHeads) {
            expect(computePolicyHeadsDigest(item.counts)).toBe(item.digest);
        }
        for (const item of contractFixture.snapshotVectors) {
            const vector = item.vector as SnapshotVector;
            expect(canonicalSnapshotVector(vector)).toBe(item.canonical);
            expect(computeSnapshotVectorDigest(vector)).toBe(item.digest);
        }
    });

    test("result decoding matches the fixture", () => {
        for (const item of contractFixture.results.valid) {
            const decoded = decodeClaimOperationResult(item.resultJson);
            expect(decoded.outcome).toBe(item.outcome as typeof decoded.outcome);
            expect(decoded.effects).toHaveLength(item.effectCount);
        }
        for (const item of contractFixture.results.invalid) {
            expect(() => decodeClaimOperationResult(item.resultJson)).toThrow();
        }
    });
});
