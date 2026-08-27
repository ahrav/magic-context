/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { createAntiMemory, readAntiMemory } from "../memory/storage-anti-memory";
import {
    applyProjectMemoryMapping,
    computeProjectMemoryMutationToken,
    createProjectMemoryClaim,
    getProjectMemoryClaimByPublicId,
    reviseProjectMemoryClaim,
} from "../memory/storage-claim-operations";
import { recordApprovalActionInCurrentTransaction } from "../memory/storage-claim-policy";
import { ensureProject } from "../memory/storage-claims";
import { createDirectTestDatabase } from "../test-database";
import { readDreamerProjectClaims } from "./claim-manifest";
import { acquireLease } from "./lease";
import { applyVerifyManifest, runVerify, type VerifyArgs } from "./verify";
import type { VerifyPromptMemory } from "./verify-prompt";

const tempDirs: string[] = [];

function freshDb(): Database {
    const db = createDirectTestDatabase().db;
    return db;
}

function tempProject(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "mc-verify-claims-"));
    tempDirs.push(dir);
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "old.ts"), "export const oldValue = 1;");
    writeFileSync(path.join(dir, "src", "new.ts"), "export const newValue = 2;");
    return dir;
}

function seedClaim(db: Database, projectIdentity: string, content: string, key: string): string {
    const result = createProjectMemoryClaim(
        db,
        { producer: "verify-test", operationKey: `seed-${key}` },
        {
            projectId: ensureProject(db, projectIdentity),
            content,
            category: "ARCHITECTURE",
            provenance: {
                sourceLocator: `test://verify/${key}`,
                sourceContent: content,
                extractor: "test",
                extractorVersion: "1",
                extractorRunId: "seed",
                independenceKey: key,
                sourceTrustClass: "explicit_user",
            },
            actor: "user:test",
        },
    );
    return (result.result.payload as { claim: { publicClaimId: string } }).claim.publicClaimId;
}

function seedAntiMemory(db: Database, projectIdentity: string, key: string): string {
    const result = createAntiMemory(
        db,
        { producer: "verify-test", operationKey: `anti-${key}` },
        {
            projectId: ensureProject(db, projectIdentity),
            payload: {
                trigger: `${key} session caching`,
                rejectedStrategy: `Redis ${key}`,
                rejectionReason: "split ownership",
                saferAlternative: "use SQLite",
            },
            provenance: {
                sourceLocator: `test://verify/${key}`,
                sourceContent: "Redis rejected",
                extractor: "test",
                extractorVersion: "1",
                extractorRunId: key,
                independenceKey: key,
                sourceTrustClass: "explicit_user",
            },
            actor: "user:test",
            nowMs: Date.now() - 60 * 24 * 60 * 60 * 1_000,
        },
    );
    return (result.result.payload as { claim: { publicClaimId: string } }).claim.publicClaimId;
}

function mapClaim(db: Database, publicClaimId: string, file = "src/old.ts"): void {
    const claim = getProjectMemoryClaimByPublicId(db, publicClaimId);
    if (!claim) throw new Error("missing claim");
    applyProjectMemoryMapping(
        db,
        { producer: "verify-test", operationKey: `map-${publicClaimId}-${file}` },
        {
            token: computeProjectMemoryMutationToken(db, publicClaimId),
            revisionLocator: `${publicClaimId}/r${claim.revision}/${claim.contentDigest}`,
            paths: { state: "known", exact: [file] },
        },
    );
}

function verifyArgs(db: Database, sessionDirectory: string, projectIdentity: string): VerifyArgs {
    const holderId = `verify-holder-${Math.random()}`;
    const leaseKey = `verify-${Math.random()}`;
    expect(acquireLease(db, holderId, leaseKey)).toBe(true);
    return {
        db,
        client: {} as never,
        projectIdentity,
        parentSessionId: "run-verify",
        sessionDirectory,
        holderId,
        leaseKey,
        deadline: Date.now() + 60_000,
    };
}

function promptBatch(db: Database, projectIdentity: string): VerifyPromptMemory[] {
    return readDreamerProjectClaims(db, projectIdentity, "verification").map((claim) => {
        const files = claim.applicability.flatMap((assertion) =>
            assertion.paths.filter((entry) => entry.kind === "exact").map((entry) => entry.value),
        );
        return {
            publicClaimId: claim.publicClaimId,
            revisionLocator: claim.revisionLocator,
            contentDigest: claim.contentDigest,
            mutationToken: claim.mutationToken,
            category: claim.category,
            content: claim.content,
            mappedFiles: files,
        };
    });
}

function count(
    db: Database,
    table: "claim_operation_receipts" | "claim_operation_effects",
): number {
    return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("claim-native verification", () => {
    test("verified anti-memory extends TTL while archive demotes another to stale", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:verify-anti";
            const dir = tempProject();
            const verifiedId = seedAntiMemory(db, projectIdentity, "verified");
            const staleId = seedAntiMemory(db, projectIdentity, "stale");
            const beforeExpiry = readAntiMemory(db, verifiedId)?.expiresAt ?? 0;
            const batch = promptBatch(db, projectIdentity);

            expect(
                await applyVerifyManifest(
                    verifyArgs(db, dir, projectIdentity),
                    batch,
                    `<verify><verified claim="${verifiedId}" files=""/><archive claim="${staleId}" reason="rejection no longer applies"/></verify>`,
                ),
            ).toEqual({ verified: 1, updated: 0, archived: 1 });

            const verified = readAntiMemory(db, verifiedId);
            expect(verified?.revision).toBe(2);
            expect(verified?.expiresAt).toBeGreaterThan(beforeExpiry);
            const revisionsAfterFirstVerify = (
                db
                    .prepare(
                        `SELECT COUNT(*) AS count FROM claim_revisions revisions
                          JOIN claim_public_ids public ON public.claim_id = revisions.claim_id
                         WHERE public.public_id = ?`,
                    )
                    .get(verifiedId) as { count: number }
            ).count;
            const secondBatch = promptBatch(db, projectIdentity).filter(
                (memory) => memory.publicClaimId === verifiedId,
            );
            expect(
                await applyVerifyManifest(
                    verifyArgs(db, dir, projectIdentity),
                    secondBatch,
                    `<verify><verified claim="${verifiedId}" files=""/></verify>`,
                ),
            ).toEqual({ verified: 1, updated: 0, archived: 0 });
            expect(readAntiMemory(db, verifiedId)?.revision).toBe(2);
            expect(
                (
                    db
                        .prepare(
                            `SELECT COUNT(*) AS count FROM claim_revisions revisions
                              JOIN claim_public_ids public ON public.claim_id = revisions.claim_id
                             WHERE public.public_id = ?`,
                        )
                        .get(verifiedId) as { count: number }
                ).count,
            ).toBe(revisionsAfterFirstVerify);
            const outcomes = db
                .prepare(
                    `SELECT public.public_id AS publicClaimId, events.outcome
                       FROM verification_events events
                       JOIN claim_revisions revisions ON revisions.id = events.revision_id
                       JOIN claim_public_ids public ON public.claim_id = revisions.claim_id
                      WHERE public.public_id IN (?, ?) ORDER BY public.public_id`,
                )
                .all(verifiedId, staleId) as Array<{ publicClaimId: string; outcome: string }>;
            expect(outcomes.find((row) => row.publicClaimId === verifiedId)?.outcome).toBe(
                "verified",
            );
            expect(outcomes.find((row) => row.publicClaimId === staleId)?.outcome).toBe("stale");
            expect(
                db
                    .prepare(
                        `SELECT heads.state FROM claim_memory_lifecycle_heads heads
                         JOIN claim_public_ids public ON public.claim_id = heads.claim_id
                         WHERE public.public_id = ?`,
                    )
                    .get(staleId),
            ).toEqual({ state: "active" });
        } finally {
            closeQuietly(db);
        }
    });

    test("verified, update, and archive commit exact events under one receipt", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:verify-apply";
            const dir = tempProject();
            const verifiedId = seedClaim(db, projectIdentity, "Verified fact.", "verified");
            const updatedId = seedClaim(db, projectIdentity, "Old fact.", "updated");
            const archivedId = seedClaim(db, projectIdentity, "Removed fact.", "archived");
            for (const id of [verifiedId, updatedId, archivedId]) mapClaim(db, id);
            const oldUpdated = getProjectMemoryClaimByPublicId(db, updatedId);
            if (!oldUpdated) throw new Error("missing update target");
            db.transaction(() =>
                recordApprovalActionInCurrentTransaction(db, {
                    revisionId: oldUpdated.currentRevisionId,
                    projectId: oldUpdated.projectId,
                    action: "approve",
                    host: "test",
                    sessionId: "session",
                    userCommandEvent: "approve",
                    commandIdentity: "approve-old-update",
                    confirmationNonce: "nonce",
                }),
            ).immediate();
            const batch = promptBatch(db, projectIdentity);
            const receiptsBefore = count(db, "claim_operation_receipts");
            const generationBefore = (
                db
                    .prepare(
                        "SELECT COALESCE(MAX(generation), 0) AS generation FROM claim_project_generations",
                    )
                    .get() as { generation: number }
            ).generation;

            expect(
                await applyVerifyManifest(
                    verifyArgs(db, dir, projectIdentity),
                    batch,
                    `<verify><verified claim="${verifiedId}" files="src/old.ts"/><update claim="${updatedId}" files="src/new.ts">New fact.</update><archive claim="${archivedId}" reason="removed"/></verify>`,
                ),
            ).toEqual({ verified: 1, updated: 1, archived: 1 });

            expect(count(db, "claim_operation_receipts")).toBe(receiptsBefore + 1);
            const generationAfter = (
                db
                    .prepare(
                        "SELECT COALESCE(MAX(generation), 0) AS generation FROM claim_project_generations",
                    )
                    .get() as { generation: number }
            ).generation;
            expect(generationAfter).toBe(generationBefore + 1);

            const outcomes = db
                .prepare(
                    `SELECT ids.public_id AS publicClaimId, events.outcome
                       FROM verification_events events
                       JOIN claim_revisions revisions ON revisions.id = events.revision_id
                       JOIN claim_public_ids ids ON ids.claim_id = revisions.claim_id
                      WHERE ids.public_id IN (?, ?, ?) ORDER BY events.id`,
                )
                .all(verifiedId, updatedId, archivedId) as Array<{
                publicClaimId: string;
                outcome: string;
            }>;
            expect(outcomes).toEqual([
                { publicClaimId: verifiedId, outcome: "verified" },
                { publicClaimId: updatedId, outcome: "update" },
                { publicClaimId: archivedId, outcome: "archive" },
            ]);
            expect(getProjectMemoryClaimByPublicId(db, updatedId)?.content).toBe("New fact.");
            expect(
                db
                    .prepare(
                        `SELECT lifecycle.state FROM claim_memory_lifecycle_heads lifecycle
                           JOIN claim_public_ids ids ON ids.claim_id = lifecycle.claim_id
                          WHERE ids.public_id = ?`,
                    )
                    .get(archivedId),
            ).toEqual({ state: "archived" });
            const updatedCurrent = getProjectMemoryClaimByPublicId(db, updatedId);
            expect(updatedCurrent?.revision).toBe(2);
            expect(
                db
                    .prepare(
                        "SELECT COUNT(*) AS count FROM claim_approval_actions WHERE revision_id = ?",
                    )
                    .get(updatedCurrent?.currentRevisionId),
            ).toEqual({ count: 0 });
            expect(
                db
                    .prepare(
                        `SELECT observations.source_trust_class AS trust
                           FROM claim_evidence evidence
                           JOIN observations ON observations.id = evidence.observation_id
                          WHERE evidence.revision_id = ?`,
                    )
                    .get(updatedCurrent?.currentRevisionId),
            ).toEqual({ trust: "model_inference" });
        } finally {
            closeQuietly(db);
        }
    });

    test("stale member rolls back every event and lifecycle effect", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:verify-stale";
            const dir = tempProject();
            const first = seedClaim(db, projectIdentity, "First fact.", "stale-first");
            const second = seedClaim(db, projectIdentity, "Second fact.", "stale-second");
            mapClaim(db, first);
            mapClaim(db, second);
            const batch = promptBatch(db, projectIdentity);
            reviseProjectMemoryClaim(
                db,
                { producer: "test", operationKey: "move-verify-second" },
                {
                    token: computeProjectMemoryMutationToken(db, second),
                    content: "Second changed.",
                    provenance: {
                        sourceLocator: "test://move",
                        sourceContent: "Second changed.",
                        extractor: "test",
                        extractorVersion: "1",
                        extractorRunId: "move",
                        independenceKey: "move",
                        sourceTrustClass: "explicit_user",
                    },
                    actor: "user:test",
                },
            );
            const effectsBefore = count(db, "claim_operation_effects");
            expect(
                await applyVerifyManifest(
                    verifyArgs(db, dir, projectIdentity),
                    batch,
                    `<verify><verified claim="${first}" files="src/old.ts"/><archive claim="${second}" reason="stale"/></verify>`,
                ),
            ).toEqual({ verified: 0, updated: 0, archived: 0 });
            expect(db.prepare("SELECT COUNT(*) AS count FROM verification_events").get()).toEqual({
                count: 0,
            });
            expect(
                db
                    .prepare(
                        `SELECT lifecycle.state FROM claim_memory_lifecycle_heads lifecycle
                           JOIN claim_public_ids ids ON ids.claim_id = lifecycle.claim_id
                          WHERE ids.public_id = ?`,
                    )
                    .get(first),
            ).toEqual({ state: "active" });
            expect(count(db, "claim_operation_effects")).toBe(effectsBefore);
        } finally {
            closeQuietly(db);
        }
    });

    test("malformed manifest records one zero-effect rejection", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:verify-malformed";
            const dir = tempProject();
            const publicClaimId = seedClaim(db, projectIdentity, "Fact.", "malformed");
            mapClaim(db, publicClaimId);
            const batch = promptBatch(db, projectIdentity);
            const receiptsBefore = count(db, "claim_operation_receipts");
            const effectsBefore = count(db, "claim_operation_effects");
            await expect(
                applyVerifyManifest(
                    verifyArgs(db, dir, projectIdentity),
                    batch,
                    `<verify><verified claim="${publicClaimId}" files="src/old.ts"/>`,
                ),
            ).rejects.toThrow(/closing root/);
            expect(count(db, "claim_operation_receipts")).toBe(receiptsBefore + 1);
            expect(count(db, "claim_operation_effects")).toBe(effectsBefore);
        } finally {
            closeQuietly(db);
        }
    });

    test("provider failure stores zero effects and leaves broad work pending", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:verify-provider";
            const dir = tempProject();
            const publicClaimId = seedClaim(db, projectIdentity, "Fact.", "provider");
            mapClaim(db, publicClaimId);
            const args = verifyArgs(db, dir, projectIdentity);
            args.forceBroad = true;
            args.client = {
                session: { create: async () => Promise.reject(new Error("provider unavailable")) },
            } as never;
            const effectsBefore = count(db, "claim_operation_effects");
            const result = await runVerify(args);
            expect(result.complete).toBe(false);
            expect(result.remaining).toBe(1);
            expect(count(db, "claim_operation_effects")).toBe(effectsBefore);
        } finally {
            closeQuietly(db);
        }
    });
});
