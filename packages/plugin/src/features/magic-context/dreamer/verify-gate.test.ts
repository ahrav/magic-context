/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { __resetVerificationPathsForTests, __setVerificationPathsTestHooks } from "../memory";
import { createAntiMemory } from "../memory/storage-anti-memory";
import {
    applyProjectMemoryMapping,
    computeProjectMemoryMutationToken,
    createProjectMemoryClaim,
    getProjectMemoryClaimByPublicId,
    recordProjectMemoryVerification,
} from "../memory/storage-claim-operations";
import { ensureProject } from "../memory/storage-claims";
import { createDirectTestDatabase } from "../test-database";
import { acquireLease } from "./lease";
import {
    getTaskScheduleState,
    seedTaskScheduleState,
    writeTaskScheduleState,
} from "./storage-task-schedule";
import { partitionVerifyScope } from "./verify-gate";

const PROJECT = "git:verify-gate";
const dirs: string[] = [];

function freshDb(): Database {
    const db = createDirectTestDatabase().db;
    return db;
}

function projectDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "mc-verify-gate-"));
    dirs.push(dir);
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, "a.ts"), "export const a = 1;");
    writeFileSync(join(dir, "b.ts"), "export const b = 1;");
    return dir;
}

function seedClaim(db: Database, content: string, key: string): string {
    const result = createProjectMemoryClaim(
        db,
        { producer: "gate-test", operationKey: `seed-${key}` },
        {
            projectId: ensureProject(db, PROJECT),
            content,
            category: "ARCHITECTURE",
            provenance: {
                sourceLocator: `test://gate/${key}`,
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

function seedAntiMemory(
    db: Database,
    overrides: { rootCause?: string; rejectedStrategy?: string } = {},
): string {
    const result = createAntiMemory(
        db,
        {
            producer: "gate-test",
            operationKey: `seed-anti-${overrides.rejectedStrategy ?? "default"}`,
        },
        {
            projectId: ensureProject(db, PROJECT),
            payload: {
                trigger: "session caching",
                rejectedStrategy: "Redis",
                rejectionReason: "split ownership",
                ...overrides,
            },
            provenance: {
                sourceLocator: `test://gate/anti-${overrides.rejectedStrategy ?? "default"}`,
                sourceContent: "Redis rejected",
                extractor: "test",
                extractorVersion: "1",
                extractorRunId: "seed",
                independenceKey: `anti-${overrides.rejectedStrategy ?? "default"}`,
                sourceTrustClass: "explicit_user",
            },
            actor: "user:test",
        },
    );
    return (result.result.payload as { claim: { publicClaimId: string } }).claim.publicClaimId;
}

function mapClaim(db: Database, publicClaimId: string, files: string[]): void {
    const claim = getProjectMemoryClaimByPublicId(db, publicClaimId);
    if (!claim) throw new Error("missing claim");
    applyProjectMemoryMapping(
        db,
        { producer: "gate-test", operationKey: `map-${publicClaimId}` },
        {
            token: computeProjectMemoryMutationToken(db, publicClaimId),
            revisionLocator: `${publicClaimId}/r${claim.revision}/${claim.contentDigest}`,
            paths: { state: "known", exact: files },
            knownFrom: 1_000,
        },
    );
}

function verifyClaim(db: Database, publicClaimId: string, nowMs: number): void {
    const claim = getProjectMemoryClaimByPublicId(db, publicClaimId);
    if (!claim) throw new Error("missing claim");
    recordProjectMemoryVerification(
        db,
        { producer: "gate-test", operationKey: `verify-${publicClaimId}-${nowMs}` },
        {
            token: computeProjectMemoryMutationToken(db, publicClaimId),
            revisionLocator: `${publicClaimId}/r${claim.revision}/${claim.contentDigest}`,
            outcome: "verified",
            verifier: "gate-test",
            nowMs,
        },
    );
}

afterEach(() => {
    __resetVerificationPathsForTests();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("claim-current verify gate", () => {
    test("includes only claims with known non-empty applicability paths", async () => {
        const db = freshDb();
        const dir = projectDir();
        try {
            const mapped = seedClaim(db, "Mapped claim.", "mapped");
            const independent = seedClaim(db, "Independent claim.", "independent");
            seedClaim(db, "Unmapped claim.", "unmapped");
            mapClaim(db, mapped, ["a.ts"]);
            mapClaim(db, independent, []);
            __setVerificationPathsTestHooks({
                execFile: async () => Promise.reject(new Error("git unavailable")),
            });

            const gate = await partitionVerifyScope({
                db,
                projectIdentity: PROJECT,
                projectDirectory: dir,
                now: 3_000,
            });
            expect(gate.mode).toBe("full");
            expect(gate.inScopeIds).toEqual([mapped]);
            expect(gate.inScope[0]).toMatchObject({
                publicClaimId: mapped,
                mappedFiles: ["a.ts"],
            });
            expect(gate.inScope[0]?.revisionLocator).toContain(`${mapped}/r1/`);
        } finally {
            closeQuietly(db);
        }
    });

    test("includes file-independent anti-memories without widening ordinary claim scope", async () => {
        const db = freshDb();
        const dir = projectDir();
        try {
            const anti = seedAntiMemory(db);
            seedClaim(db, "Unmapped ordinary claim.", "ordinary-unmapped");
            __setVerificationPathsTestHooks({
                execFile: async () => Promise.reject(new Error("git unavailable")),
            });

            const gate = await partitionVerifyScope({
                db,
                projectIdentity: PROJECT,
                projectDirectory: dir,
                now: 3_000,
            });

            expect(gate.inScopeIds).toEqual([anti]);
            expect(gate.inScope[0]).toMatchObject({
                publicClaimId: anti,
                category: "REJECTED_APPROACH",
                mappedFiles: [],
            });
        } finally {
            closeQuietly(db);
        }
    });

    test("excludes an oversized anti-memory so one record cannot fail the batch", async () => {
        const db = freshDb();
        const dir = projectDir();
        try {
            const ordinary = seedAntiMemory(db);
            const oversized = seedAntiMemory(db, {
                rejectedStrategy: "Memcached",
                rootCause: "why ".repeat(4_000),
            });
            __setVerificationPathsTestHooks({
                execFile: async () => Promise.reject(new Error("git unavailable")),
            });

            const gate = await partitionVerifyScope({
                db,
                projectIdentity: PROJECT,
                projectDirectory: dir,
                now: 3_000,
            });

            expect(gate.inScopeIds).toEqual([ordinary]);
            expect(gate.inScopeIds).not.toContain(oversized);
        } finally {
            closeQuietly(db);
        }
    });

    test("excludes a demoted anti-memory from every subsequent verification scope", async () => {
        const db = freshDb();
        const dir = projectDir();
        try {
            const anti = seedAntiMemory(db);
            const claim = getProjectMemoryClaimByPublicId(db, anti);
            if (!claim) throw new Error("missing anti-memory claim");
            // An anti-memory archive verdict keeps the record lifecycle-active until its TTL expires.
            // An anti-memory archive verdict keeps the record lifecycle-active until its TTL expires.
            // The gate treats an anti-memory archive verdict as terminal rather than never verified.
            //
            db.prepare(
                "INSERT INTO verification_events (revision_id, outcome, verifier, created_at) VALUES (?, 'stale', 'gate-test', ?)",
            ).run(claim.currentRevisionId, 2_000);
            __setVerificationPathsTestHooks({
                execFile: async () => Promise.reject(new Error("git unavailable")),
            });

            const incremental = await partitionVerifyScope({
                db,
                projectIdentity: PROJECT,
                projectDirectory: dir,
                now: 3_000,
            });
            expect(incremental.inScopeIds).toEqual([]);

            seedTaskScheduleState(db, PROJECT, "verify-broad", null, null, "0 3 * * 0");
            const state = getTaskScheduleState(db, PROJECT, "verify-broad");
            if (!state) throw new Error("missing schedule state");
            writeTaskScheduleState(db, { ...state, lastBroadRunAt: 2_500 });
            const broad = await partitionVerifyScope({
                db,
                projectIdentity: PROJECT,
                projectDirectory: dir,
                forceBroad: true,
                now: 3_000,
            });
            expect(broad.inScopeIds).toEqual([]);
        } finally {
            closeQuietly(db);
        }
    });

    test("broad cycle skips claims verified after cycle start and drains older claims", async () => {
        const db = freshDb();
        const dir = projectDir();
        try {
            const fresh = seedClaim(db, "Fresh claim.", "fresh");
            const old = seedClaim(db, "Old claim.", "old");
            mapClaim(db, fresh, ["a.ts"]);
            mapClaim(db, old, ["b.ts"]);
            verifyClaim(db, fresh, 2_000);
            seedTaskScheduleState(db, PROJECT, "verify-broad", null, null, "0 3 * * 0");
            const state = getTaskScheduleState(db, PROJECT, "verify-broad");
            if (!state) throw new Error("missing schedule state");
            writeTaskScheduleState(db, { ...state, lastBroadRunAt: 1_500 });

            const gate = await partitionVerifyScope({
                db,
                projectIdentity: PROJECT,
                projectDirectory: dir,
                forceBroad: true,
                now: 3_000,
            });
            expect(gate.broadCycleStartAt).toBe(1_500);
            expect(gate.inScopeIds).toEqual([old]);
            expect(gate.skippedIds).toEqual([fresh]);
        } finally {
            closeQuietly(db);
        }
    });

    test("opening a broad cycle persists its exact lease-guarded start", async () => {
        const db = freshDb();
        const dir = projectDir();
        try {
            const claim = seedClaim(db, "Broad claim.", "open");
            mapClaim(db, claim, ["a.ts"]);
            seedTaskScheduleState(db, PROJECT, "verify-broad", null, null, "0 3 * * 0");
            const holderId = "gate-holder";
            const leaseKey = "gate-lease";
            expect(acquireLease(db, holderId, leaseKey)).toBe(true);

            const gate = await partitionVerifyScope({
                db,
                projectIdentity: PROJECT,
                projectDirectory: dir,
                forceBroad: true,
                now: 4_000,
                holderId,
                leaseKey,
            });
            expect(gate.broadCycleStartAt).toBe(4_000);
            expect(getTaskScheduleState(db, PROJECT, "verify-broad")?.lastBroadRunAt).toBe(4_000);
        } finally {
            closeQuietly(db);
        }
    });
});
