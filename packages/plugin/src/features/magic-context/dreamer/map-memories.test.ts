
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import {
    applyProjectMemoryMapping,
    computeProjectMemoryMutationToken,
    createProjectMemoryClaim,
    getProjectMemoryClaimByPublicId,
    reviseProjectMemoryClaim,
} from "../memory/storage-claim-operations";
import { ensureProject } from "../memory/storage-claims";
import { APPLICABILITY_BASELINE_STREAM_KEY } from "../storage-claim-applicability-schema";
import { createDirectTestDatabase } from "../test-database";
import { readDreamerProjectClaims } from "./claim-manifest";
import { acquireLease } from "./lease";
import {
    applyBatchMappings,
    type MapMemoriesArgs,
    mapMemories,
    selectMapMemoryInputs,
} from "./map-memories";

const tempDirs: string[] = [];

function freshDb(): Database {
    const db = createDirectTestDatabase().db;
    return db;
}

function tempProject(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "mc-map-claims-"));
    tempDirs.push(dir);
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "fact.ts"), "export const fact = true;");
    return dir;
}

function seedClaim(db: Database, projectIdentity: string, content: string, key: string): string {
    const result = createProjectMemoryClaim(
        db,
        { producer: "map-test", operationKey: `seed-${key}` },
        {
            projectId: ensureProject(db, projectIdentity),
            content,
            category: "ARCHITECTURE",
            provenance: {
                sourceLocator: `test://map/${key}`,
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

function mapArgs(db: Database, sessionDirectory: string, projectIdentity: string): MapMemoriesArgs {
    const holderId = `map-holder-${Math.random()}`;
    const leaseKey = `map-${Math.random()}`;
    expect(acquireLease(db, holderId, leaseKey)).toBe(true);
    return {
        db,
        client: {} as never,
        projectIdentity,
        parentSessionId: "run-map",
        sessionDirectory,
        holderId,
        leaseKey,
        deadline: Date.now() + 60_000,
    };
}

function count(
    db: Database,
    table: "claim_operation_receipts" | "claim_operation_effects",
): number {
    return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

function baseline(db: Database, projectIdentity: string, publicClaimId: string) {
    return readDreamerProjectClaims(db, projectIdentity, "verification")
        .find((claim) => claim.publicClaimId === publicClaimId)
        ?.applicability.find(
            (assertion) => assertion.streamKey === APPLICABILITY_BASELINE_STREAM_KEY,
        );
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("claim-native mapping", () => {
    test("selects unknown applicability and writes one manifest receipt", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:map-apply";
            const dir = tempProject();
            const publicClaimId = seedClaim(
                db,
                projectIdentity,
                "Fact lives in src/fact.ts.",
                "apply",
            );
            const selected = selectMapMemoryInputs(db, projectIdentity, dir);
            expect(selected.map((item) => item.publicClaimId)).toEqual([publicClaimId]);
            expect(selected[0]?.revisionLocator).toContain(`${publicClaimId}/r1/`);
            const receiptsBefore = count(db, "claim_operation_receipts");

            expect(
                await applyBatchMappings(
                    mapArgs(db, dir, projectIdentity),
                    selected,
                    `<mappings><memory claim="${publicClaimId}" files="src/fact.ts"/></mappings>`,
                ),
            ).toEqual({ mapped: 1, independent: 0 });
            expect(baseline(db, projectIdentity, publicClaimId)?.paths).toEqual([
                expect.objectContaining({ kind: "exact", value: "src/fact.ts" }),
            ]);
            expect(count(db, "claim_operation_receipts")).toBe(receiptsBefore + 1);
        } finally {
            closeQuietly(db);
        }
    });

    test("stale member rolls back every applicability write", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:map-stale";
            const dir = tempProject();
            const first = seedClaim(db, projectIdentity, "First in src/fact.ts.", "first");
            const second = seedClaim(db, projectIdentity, "Second in src/fact.ts.", "second");
            const selected = selectMapMemoryInputs(db, projectIdentity, dir);
            reviseProjectMemoryClaim(
                db,
                { producer: "test", operationKey: "move-map-second" },
                {
                    token: computeProjectMemoryMutationToken(db, second),
                    content: "Second moved.",
                    provenance: {
                        sourceLocator: "test://move",
                        sourceContent: "Second moved.",
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
                await applyBatchMappings(
                    mapArgs(db, dir, projectIdentity),
                    selected,
                    `<mappings><memory claim="${first}" files="src/fact.ts"/><memory claim="${second}" files="src/fact.ts"/></mappings>`,
                ),
            ).toEqual({ mapped: 0, independent: 0 });
            expect(baseline(db, projectIdentity, first)?.pathsState).toBe("unknown");
            expect(count(db, "claim_operation_effects")).toBe(effectsBefore);
        } finally {
            closeQuietly(db);
        }
    });

    test("malformed manifest stores one zero-effect rejection", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:map-malformed";
            const dir = tempProject();
            const publicClaimId = seedClaim(db, projectIdentity, "Fact in src/fact.ts.", "bad");
            const selected = selectMapMemoryInputs(db, projectIdentity, dir);
            const receiptsBefore = count(db, "claim_operation_receipts");
            const effectsBefore = count(db, "claim_operation_effects");
            await expect(
                applyBatchMappings(
                    mapArgs(db, dir, projectIdentity),
                    selected,
                    `<mappings><memory claim="${publicClaimId}" files="src/fact.ts"/>`,
                ),
            ).rejects.toThrow(/closing root/);
            expect(count(db, "claim_operation_receipts")).toBe(receiptsBefore + 1);
            expect(count(db, "claim_operation_effects")).toBe(effectsBefore);
        } finally {
            closeQuietly(db);
        }
    });

    test("known-empty claims that name a live path are requeued", () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:map-requeue";
            const dir = tempProject();
            const publicClaimId = seedClaim(
                db,
                projectIdentity,
                "Fact lives in src/fact.ts.",
                "requeue",
            );
            const claim = getProjectMemoryClaimByPublicId(db, publicClaimId);
            if (!claim) throw new Error("missing claim");
            applyProjectMemoryMapping(
                db,
                { producer: "test", operationKey: "mark-independent" },
                {
                    token: computeProjectMemoryMutationToken(db, publicClaimId),
                    revisionLocator: `${publicClaimId}/r${claim.revision}/${claim.contentDigest}`,
                    paths: { state: "known", exact: [] },
                },
            );
            expect(
                selectMapMemoryInputs(db, projectIdentity, dir).map((item) => item.publicClaimId),
            ).toEqual([publicClaimId]);
        } finally {
            closeQuietly(db);
        }
    });

    test("provider failure records zero effects and leaves mapping pending", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:map-provider";
            const dir = tempProject();
            seedClaim(db, projectIdentity, "Fact lives in src/fact.ts.", "provider");
            const args = mapArgs(db, dir, projectIdentity);
            args.client = {
                session: { create: async () => Promise.reject(new Error("provider unavailable")) },
            } as never;
            const effectsBefore = count(db, "claim_operation_effects");
            const result = await mapMemories(args);
            expect(result.complete).toBe(false);
            expect(result.remaining).toBe(1);
            expect(count(db, "claim_operation_effects")).toBe(effectsBefore);
        } finally {
            closeQuietly(db);
        }
    });
});
