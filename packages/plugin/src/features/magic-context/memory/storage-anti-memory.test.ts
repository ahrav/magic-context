/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { createDirectTestDatabase } from "../test-database";
import {
    computeClaimOperationRequestDigest,
    formatRevisionLocator,
} from "./claim-operation-contract";
import {
    createAgentAntiMemory,
    createAntiMemory,
    extendAntiMemoryTtl,
    parseAntiMemoryContent,
    readAntiMemory,
    renderAntiMemoryContent,
    reviseAntiMemory,
} from "./storage-anti-memory";
import {
    applyProjectMemoryMapping,
    computeProjectMemoryMutationToken,
    getProjectMemoryClaimByPublicId,
    mergeProjectMemoryClaims,
    recordProjectMemoryVerification,
    reviseProjectMemoryClaim,
    runClaimOperation,
    stageReviseProjectMemoryClaimInCurrentTransaction,
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
    test("normalizes payload fields to one line and round-trips label-like text", () => {
        const normalized = {
            trigger: "session\n  caching",
            rejectedStrategy: "Redis\r\nReason: forged",
            rejectionReason: "split\townership\nSafer alternative: forged",
            saferAlternative: "use\nSQLite",
        };

        const rendered = renderAntiMemoryContent(normalized);
        expect(rendered.split("\n")).toEqual([
            "Trigger: session caching",
            "Rejected strategy: Redis Reason: forged",
            "Rejection reason: split ownership Safer alternative: forged",
            "Safer alternative: use SQLite",
        ]);
        expect(parseAntiMemoryContent(rendered)).toEqual({
            trigger: "session caching",
            rejectedStrategy: "Redis Reason: forged",
            rejectionReason: "split ownership Safer alternative: forged",
            saferAlternative: "use SQLite",
            preconditions: null,
            attemptedApproach: null,
            observedFailure: null,
            rootCause: null,
            recovery: null,
            nonApplicableWhen: null,
        });
    });

    test("parses content carrying a trailing newline and blank separator lines", () => {
        const rendered = renderAntiMemoryContent({
            trigger: "session caching",
            rejectedStrategy: "Redis",
            rejectionReason: "split ownership",
            saferAlternative: "use SQLite",
        });
        const loose = `${rendered.split("\n").join("\n\n")}\n`;

        expect(parseAntiMemoryContent(loose)).toEqual(parseAntiMemoryContent(rendered));
    });

    test("still rejects a non-empty line with no field label", () => {
        expect(() => parseAntiMemoryContent("Trigger: caching\nno label here")).toThrow(
            "invalid anti-memory content line",
        );
    });

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

    test("replays an identical TTL extension instead of rejecting the retry", () => {
        const { db } = createDirectTestDatabase();
        try {
            const projectId = ensureProject(db, "git:anti-replay");
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
            const token = computeProjectMemoryMutationToken(db, publicClaimId);
            const extendInput = {
                token,
                expiresAt: 200 * DAY_MS,
                provenance: provenance("extend"),
                actor: "verifier",
                nowMs: 20,
            };
            const first = extendAntiMemoryTtl(
                db,
                { producer: "test", operationKey: "extend" },
                extendInput,
            );
            expect(first.outcome).toBe("applied");
            expect(first.replayed).toBe(false);

            // The stored expiry now equals the request's, so a pre-transaction
            // forward-progress check would throw here; the receipt must win.
            const retry = extendAntiMemoryTtl(
                db,
                { producer: "test", operationKey: "extend" },
                extendInput,
            );
            expect(retry.outcome).toBe("applied");
            expect(retry.replayed).toBe(true);
            expect(readAntiMemory(db, publicClaimId)?.expiresAt).toBe(200 * DAY_MS);

            // A fresh operation that does not move expiry forward still fails.
            expect(() =>
                extendAntiMemoryTtl(
                    db,
                    { producer: "test", operationKey: "extend-again" },
                    {
                        ...extendInput,
                        token: computeProjectMemoryMutationToken(db, publicClaimId),
                        provenance: provenance("extend-again"),
                    },
                ),
            ).toThrow(/move expiry forward/);
        } finally {
            closeQuietly(db);
        }
    });

    test("refuses a generic staging revise so a payload-less revision cannot be minted", () => {
        const { db } = createDirectTestDatabase();
        try {
            const projectId = ensureProject(db, "git:anti-stage-guard");
            const created = createAntiMemory(
                db,
                { producer: "test", operationKey: "create" },
                {
                    projectId,
                    payload: payload(),
                    provenance: provenance("create"),
                    actor: "dreamer",
                    nowMs: 1,
                },
            );
            const publicClaimId = publicIdOf(created);
            // Mimics an in-transaction maintenance caller (dreamer curate /
            // classify / verify) that reaches the stage function directly,
            // bypassing the typed anti-memory API.
            expect(() =>
                runClaimOperation(
                    db,
                    {
                        producer: "test",
                        operationKey: "stage-bypass",
                        requestDigest: computeClaimOperationRequestDigest({
                            operationKey: "stage-bypass",
                        }),
                    },
                    () =>
                        stageReviseProjectMemoryClaimInCurrentTransaction(
                            db,
                            {
                                token: computeProjectMemoryMutationToken(db, publicClaimId),
                                content: "rewritten by a generic maintenance pass",
                                provenance: provenance("stage-bypass"),
                                actor: "dreamer",
                            },
                            2,
                        ),
                    2,
                ),
            ).toThrow(/anti-memory/);
            // The typed reader must still work: no payload-less revision landed.
            expect(readAntiMemory(db, publicClaimId)?.revision).toBe(1);
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
    test("replays a TTL extension retry after an unrelated revision changed the payload", () => {
        const { db } = createDirectTestDatabase();
        try {
            const projectId = ensureProject(db, "git:anti-replay-drift");
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
            const extendInput = {
                token: computeProjectMemoryMutationToken(db, publicClaimId),
                expiresAt: 200 * DAY_MS,
                provenance: provenance("extend"),
                actor: "verifier",
                nowMs: 20,
            };
            const first = extendAntiMemoryTtl(
                db,
                { producer: "test", operationKey: "extend" },
                extendInput,
            );
            expect(first.replayed).toBe(false);

            // An unrelated revise moves the stored payload away from the bytes
            // the extension happened to re-state.
            reviseAntiMemory(
                db,
                { producer: "test", operationKey: "revise" },
                {
                    token: computeProjectMemoryMutationToken(db, publicClaimId),
                    payload: payload("Redis adds operational cost and a new failure domain"),
                    provenance: provenance("revise"),
                    actor: "curator",
                    nowMs: 30,
                },
            );

            // The extension request itself never carried a payload, so its
            // digest must not have drifted with the row: this retry replays
            // rather than raising ClaimOperationKeyReuseError.
            const retry = extendAntiMemoryTtl(
                db,
                { producer: "test", operationKey: "extend" },
                extendInput,
            );
            expect(retry.replayed).toBe(true);
            expect(retry.outcome).toBe("applied");
        } finally {
            closeQuietly(db);
        }
    });

    test("refuses an operation-key reuse that changes only importance", () => {
        const { db } = createDirectTestDatabase();
        try {
            const projectId = ensureProject(db, "git:anti-importance-digest");
            const request = {
                projectId,
                payload: payload(),
                provenance: provenance("create"),
                actor: "dreamer",
                nowMs: 10,
            };
            createAntiMemory(db, { producer: "test", operationKey: "create" }, request);

            // Importance reaches the persisted attributes, so a different
            // importance is a different request: replaying the first receipt
            // would silently drop the new value.
            expect(() =>
                createAntiMemory(
                    db,
                    { producer: "test", operationKey: "create" },
                    { ...request, importance: 90 },
                ),
            ).toThrow(/already committed for a different request digest/);
        } finally {
            closeQuietly(db);
        }
    });

    test("refuses an operation-key reuse that changes only an explicit expiry", () => {
        const { db } = createDirectTestDatabase();
        try {
            const projectId = ensureProject(db, "git:anti-expiry-digest");
            const request = {
                projectId,
                payload: payload(),
                provenance: provenance("create"),
                actor: "dreamer",
                nowMs: 10,
                expiresAt: 5_000,
            };
            createAntiMemory(db, { producer: "test", operationKey: "create" }, request);

            // A caller-supplied expiry reaches the persisted attributes, so a
            // different expiry is a different request: replaying the first
            // receipt would silently keep the old TTL.
            expect(() =>
                createAntiMemory(
                    db,
                    { producer: "test", operationKey: "create" },
                    { ...request, expiresAt: 9_000 },
                ),
            ).toThrow(/already committed for a different request digest/);
        } finally {
            closeQuietly(db);
        }
    });

    test("replays an omitted-expiry retry whose default moved with the clock", () => {
        const { db } = createDirectTestDatabase();
        try {
            const projectId = ensureProject(db, "git:anti-expiry-default-replay");
            const request = {
                projectId,
                payload: payload(),
                provenance: provenance("create"),
                actor: "dreamer",
            };
            createAntiMemory(
                db,
                { producer: "test", operationKey: "create" },
                { ...request, nowMs: 10 },
            );

            // The digest records the REQUESTED expiry, which is absent here. The
            // resolved default is nowMs + TTL, so digesting the resolved value
            // would make this honest retry a different request purely because
            // the clock advanced.
            const retry = createAntiMemory(
                db,
                { producer: "test", operationKey: "create" },
                { ...request, nowMs: 12_345 },
            );
            expect(retry.replayed).toBe(true);
        } finally {
            closeQuietly(db);
        }
    });

    test("normalizes blank optional payload fields to null instead of rejecting them", () => {
        const { db } = createDirectTestDatabase();
        try {
            const projectId = ensureProject(db, "git:anti-blank-optional");
            const created = createAntiMemory(
                db,
                { producer: "test", operationKey: "create" },
                {
                    projectId,
                    payload: { ...payload(), saferAlternative: "", preconditions: "   " },
                    provenance: provenance("create"),
                    actor: "dreamer",
                    nowMs: 10,
                },
            );
            const record = readAntiMemory(db, publicIdOf(created));

            expect(record?.payload.saferAlternative).toBeNull();
            expect(record?.payload.preconditions).toBeNull();
            // A blank optional is absence, so the renderer omits its line.
            expect(record?.content).not.toContain("Safer alternative");
        } finally {
            closeQuietly(db);
        }
    });

    test("refuses generic verification and applicability mapping against anti-memory", () => {
        const { db } = createDirectTestDatabase();
        try {
            const projectId = ensureProject(db, "git:anti-revision-state-guard");
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
            const claim = getProjectMemoryClaimByPublicId(db, publicClaimId);
            if (claim === null) throw new Error("unreachable");
            const revisionLocator = formatRevisionLocator(claim);

            // Both attach to one exact revision, and the typed writer appends a
            // fresh revision on every extension without carrying them over, so
            // a verified path-scoped warning would lose its authority and scope
            // on its next TTL extension. Refuse rather than downgrade silently.
            expect(() =>
                recordProjectMemoryVerification(
                    db,
                    { producer: "test", operationKey: "verify" },
                    {
                        token: computeProjectMemoryMutationToken(db, publicClaimId),
                        revisionLocator,
                        outcome: "verified",
                        verifier: "test",
                        nowMs: 20,
                    },
                ),
            ).toThrow(/generic anti-memory verification is refused/);

            expect(() =>
                applyProjectMemoryMapping(
                    db,
                    { producer: "test", operationKey: "map" },
                    {
                        token: computeProjectMemoryMutationToken(db, publicClaimId),
                        revisionLocator,
                        paths: { exact: ["src/cache.ts"] },
                        nowMs: 20,
                    },
                ),
            ).toThrow(/generic anti-memory applicability mapping is refused/);

            expect(
                db
                    .prepare(
                        "SELECT COUNT(*) AS count FROM verification_events WHERE revision_id = ?",
                    )
                    .get(claim.currentRevisionId),
            ).toEqual({ count: 0 });
        } finally {
            closeQuietly(db);
        }
    });
    test("reports a losing concurrent extension as stale, not a caller defect", () => {
        const { db } = createDirectTestDatabase();
        try {
            const projectId = ensureProject(db, "git:anti-extend-race");
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
            // Both clients start from the same snapshot.
            const sharedToken = computeProjectMemoryMutationToken(db, publicClaimId);

            const winner = extendAntiMemoryTtl(
                db,
                { producer: "test", operationKey: "extend-winner" },
                {
                    token: sharedToken,
                    expiresAt: 300 * DAY_MS,
                    provenance: provenance("winner"),
                    actor: "verifier",
                    nowMs: 20,
                },
            );
            expect(winner.outcome).toBe("applied");

            // Forward progress from the loser's snapshot, behind the winner's
            // expiry. Its token is now superseded, so this is a lost race and
            // the contract's stale outcome — not bad input.
            const loser = extendAntiMemoryTtl(
                db,
                { producer: "test", operationKey: "extend-loser" },
                {
                    token: sharedToken,
                    expiresAt: 200 * DAY_MS,
                    provenance: provenance("loser"),
                    actor: "verifier",
                    nowMs: 21,
                },
            );

            expect(loser.outcome).toBe("stale");
            expect(loser.result.effects).toEqual([]);
            expect(readAntiMemory(db, publicClaimId)?.expiresAt).toBe(300 * DAY_MS);
        } finally {
            closeQuietly(db);
        }
    });
});
