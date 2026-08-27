/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { createDirectTestDatabase } from "../test-database";
import {
    createAgentAntiMemory,
    createAntiMemory,
    extendAntiMemoryTtl,
    readAntiMemory,
    reviseAntiMemory,
} from "./storage-anti-memory";
import {
    computeProjectMemoryMutationToken,
    mergeProjectMemoryClaims,
    reviseProjectMemoryClaim,
} from "./storage-claim-operations";
import { ensureProject } from "./storage-claims";

const DAY_MS = 24 * 60 * 60 * 1_000;

function provenance(
    key: string,
    sourceTrustClass: "model_inference" | "explicit_user" = "model_inference",
) {
    return {
        sourceLocator: `transcript://${key}`,
        sourceContent: `source ${key}`,
        extractor: "test",
        extractorVersion: "1",
        extractorRunId: `run-${key}`,
        independenceKey: key,
        sourceTrustClass,
    } as const;
}

function payload(reason = "Redis adds operational cost") {
    return {
        trigger: "session caching work",
        rejectedStrategy: "use Redis",
        rejectionReason: reason,
        saferAlternative: "use SQLite",
        preconditions: null,
        attemptedApproach: null,
        observedFailure: null,
        rootCause: null,
        recovery: null,
        nonApplicableWhen: null,
    };
}

function publicIdOf(result: ReturnType<typeof createAntiMemory>): string {
    return (result.result.payload as { claim: { publicClaimId: string } }).claim.publicClaimId;
}

describe("anti-memory typed operations", () => {
    test("creates and reads a project-private record with a 90-day validity window", () => {
        const { db } = createDirectTestDatabase();
        try {
            const projectId = ensureProject(db, "git:anti-ops");
            const nowMs = 1_000;
            const created = createAntiMemory(
                db,
                { producer: "test", operationKey: "create" },
                {
                    projectId,
                    payload: payload(),
                    provenance: provenance("create", "explicit_user"),
                    actor: "host:user-corroborated",
                    nowMs,
                },
            );
            const record = readAntiMemory(db, publicIdOf(created));

            expect(record).toMatchObject({
                category: "REJECTED_APPROACH",
                memoryScope: "project",
                sharing: "private",
                expiresAt: nowMs + 90 * DAY_MS,
                payload: payload(),
            });
            expect(record?.content).toContain("Rejected strategy: use Redis");
            expect(record?.content).toContain("Rejection reason: Redis adds operational cost");
        } finally {
            closeQuietly(db);
        }
    });

    test("replays an identical create request digest", () => {
        const { db } = createDirectTestDatabase();
        try {
            const input = {
                projectId: ensureProject(db, "git:anti-replay"),
                payload: payload(),
                provenance: provenance("replay"),
                actor: "dreamer",
                nowMs: 1,
            };
            const first = createAntiMemory(db, { producer: "test", operationKey: "same" }, input);
            const replay = createAntiMemory(db, { producer: "test", operationKey: "same" }, input);

            expect(replay.replayed).toBeTrue();
            expect(publicIdOf(replay)).toBe(publicIdOf(first));
        } finally {
            closeQuietly(db);
        }
    });

    test("deduplicates by normalized trigger and strategy while preserving the first payload", () => {
        const { db } = createDirectTestDatabase();
        try {
            const projectId = ensureProject(db, "git:anti-dedup");
            const first = createAntiMemory(
                db,
                { producer: "test", operationKey: "first" },
                {
                    projectId,
                    payload: payload("first reason"),
                    provenance: provenance("first"),
                    actor: "dreamer",
                    nowMs: 1,
                },
            );
            const second = createAntiMemory(
                db,
                { producer: "test", operationKey: "second" },
                {
                    projectId,
                    payload: {
                        ...payload("second reason"),
                        trigger: "  SESSION   caching work ",
                        rejectedStrategy: "USE redis",
                    },
                    provenance: provenance("second"),
                    actor: "historian",
                    nowMs: 2,
                },
            );

            expect(publicIdOf(second)).toBe(publicIdOf(first));
            expect(readAntiMemory(db, publicIdOf(first))?.payload.rejectionReason).toBe(
                "first reason",
            );
            expect(db.prepare("SELECT COUNT(*) AS count FROM claims").get()).toEqual({ count: 1 });
            expect(db.prepare("SELECT COUNT(*) AS count FROM observations").get()).toEqual({
                count: 2,
            });
            expect(
                db
                    .prepare(
                        "SELECT extracted_text AS text FROM observations ORDER BY id DESC LIMIT 1",
                    )
                    .get(),
            ).toMatchObject({ text: expect.stringContaining("second reason") });

            const differentTrigger = createAntiMemory(
                db,
                { producer: "test", operationKey: "third" },
                {
                    projectId,
                    payload: { ...payload(), trigger: "rate limiting work" },
                    provenance: provenance("third"),
                    actor: "dreamer",
                    nowMs: 3,
                },
            );
            expect(publicIdOf(differentTrigger)).not.toBe(publicIdOf(first));
        } finally {
            closeQuietly(db);
        }
    });

    test("revises payloads and extends TTL without changing pair-based dedup identity", () => {
        const { db } = createDirectTestDatabase();
        try {
            const projectId = ensureProject(db, "git:anti-revise");
            const created = createAntiMemory(
                db,
                { producer: "test", operationKey: "create" },
                {
                    projectId,
                    payload: payload(),
                    provenance: provenance("create"),
                    actor: "dreamer",
                    nowMs: 10,
                },
            );
            const publicClaimId = publicIdOf(created);
            const reviseInput = {
                token: computeProjectMemoryMutationToken(db, publicClaimId),
                payload: payload("revised reason"),
                provenance: provenance("revise"),
                actor: "dreamer",
                nowMs: 20,
            };
            const revised = reviseAntiMemory(
                db,
                { producer: "test", operationKey: "revise" },
                reviseInput,
            );
            expect(revised.outcome).toBe("applied");
            expect(
                reviseAntiMemory(db, { producer: "test", operationKey: "revise" }, reviseInput)
                    .replayed,
            ).toBeTrue();
            const afterRevision = readAntiMemory(db, publicClaimId);
            expect(afterRevision?.revision).toBe(2);
            expect(afterRevision?.payload.rejectionReason).toBe("revised reason");
            const hash = afterRevision?.normalizedHash;

            const extendedTo = 200 * DAY_MS;
            extendAntiMemoryTtl(
                db,
                { producer: "test", operationKey: "extend" },
                {
                    token: computeProjectMemoryMutationToken(db, publicClaimId),
                    expiresAt: extendedTo,
                    provenance: provenance("extend"),
                    actor: "verifier",
                    nowMs: 30,
                },
            );
            const afterExtension = readAntiMemory(db, publicClaimId);
            expect(afterExtension?.revision).toBe(3);
            expect(afterExtension?.expiresAt).toBe(extendedTo);
            expect(afterExtension?.payload).toEqual(afterRevision?.payload);
            expect(afterExtension?.normalizedHash).toBe(hash);
        } finally {
            closeQuietly(db);
        }
    });

    test("rejects malformed payloads, category conversion, merge, and agent explicit-user trust", () => {
        const { db } = createDirectTestDatabase();
        try {
            const projectId = ensureProject(db, "git:anti-guards");
            expect(() =>
                createAntiMemory(
                    db,
                    { producer: "test", operationKey: "bad" },
                    {
                        projectId,
                        payload: { ...payload(), trigger: "" },
                        provenance: provenance("bad"),
                        actor: "dreamer",
                    },
                ),
            ).toThrow(/trigger/);
            expect(db.prepare("SELECT COUNT(*) AS count FROM claims").get()).toEqual({ count: 0 });

            const anti = createAntiMemory(
                db,
                { producer: "test", operationKey: "anti" },
                {
                    projectId,
                    payload: payload(),
                    provenance: provenance("anti"),
                    actor: "dreamer",
                    nowMs: 1,
                },
            );
            const antiId = publicIdOf(anti);
            expect(() =>
                reviseProjectMemoryClaim(
                    db,
                    { producer: "test", operationKey: "convert" },
                    {
                        token: computeProjectMemoryMutationToken(db, antiId),
                        category: "ARCHITECTURE",
                        provenance: provenance("convert"),
                        actor: "test",
                    },
                ),
            ).toThrow(/anti-memory/);

            const source = createAntiMemory(
                db,
                { producer: "test", operationKey: "source" },
                {
                    projectId,
                    payload: { ...payload(), trigger: "another trigger" },
                    provenance: provenance("source"),
                    actor: "dreamer",
                    nowMs: 2,
                },
            );
            expect(() =>
                mergeProjectMemoryClaims(
                    db,
                    { producer: "test", operationKey: "merge" },
                    {
                        targetToken: computeProjectMemoryMutationToken(db, antiId),
                        sourceTokens: [computeProjectMemoryMutationToken(db, publicIdOf(source))],
                        actor: "test",
                    },
                ),
            ).toThrow(/anti-memory/);

            const agent = createAgentAntiMemory(
                db,
                { producer: "agent", operationKey: "agent" },
                {
                    projectId,
                    payload: { ...payload(), trigger: "agent trigger" },
                    provenance: provenance("agent", "explicit_user") as never,
                    actor: "agent",
                    nowMs: 3,
                },
            );
            const agentId = publicIdOf(agent);
            expect(
                db
                    .prepare(
                        `SELECT source_trust_class AS trust FROM observations
                          JOIN claim_evidence ON claim_evidence.observation_id = observations.id
                          JOIN claim_revisions ON claim_revisions.id = claim_evidence.revision_id
                          JOIN claim_public_ids ON claim_public_ids.claim_id = claim_revisions.claim_id
                         WHERE claim_public_ids.public_id = ?`,
                    )
                    .get(agentId),
            ).toEqual({ trust: "model_inference" });
        } finally {
            closeQuietly(db);
        }
    });
});
