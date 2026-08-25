/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { __resetVerificationPathsForTests, __setVerificationPathsTestHooks } from "../memory";
import {
    applyProjectMemoryMapping,
    computeProjectMemoryMutationToken,
    createProjectMemoryClaim,
    getProjectMemoryClaimByPublicId,
    recordProjectMemoryVerification,
} from "../memory/storage-claim-operations";
import { ensureProject } from "../memory/storage-claims";
import { initializeDatabase } from "../storage-db";
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
    initializeDatabase(db);
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
