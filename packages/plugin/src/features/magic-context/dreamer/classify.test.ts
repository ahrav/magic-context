/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import type { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import {
    computeProjectMemoryMutationToken,
    createProjectMemoryClaim,
    getProjectMemoryClaimByPublicId,
    reviseProjectMemoryClaim,
} from "../memory/storage-claim-operations";
import { ensureProject } from "../memory/storage-claims";
import { initializeDatabase } from "../storage-db";
import { createDirectTestDatabase } from "../test-database";
import { readDreamerProjectClaims } from "./claim-manifest";
import { applyClassifications, type ClassifyArgs, runClassify } from "./classify";
import { acquireLease } from "./lease";
import { buildClassifyModelChain } from "./task-config";

function freshDb(): Database {
    const db = createDirectTestDatabase().db;
    initializeDatabase(db);
    return db;
}

function seedClaim(db: Database, projectIdentity: string, index: number): string {
    const result = createProjectMemoryClaim(
        db,
        { producer: "classify-test", operationKey: `seed-${projectIdentity}-${index}` },
        {
            projectId: ensureProject(db, projectIdentity),
            content: `Classification fact ${index}.`,
            category: "ARCHITECTURE",
            provenance: {
                sourceLocator: `test://classify/${index}`,
                sourceContent: `Classification fact ${index}.`,
                extractor: "test",
                extractorVersion: "1",
                extractorRunId: "seed",
                independenceKey: `seed-${index}`,
                sourceTrustClass: "explicit_user",
            },
            actor: "user:test",
        },
    );
    return (result.result.payload as { claim: { publicClaimId: string } }).claim.publicClaimId;
}

function classifyArgs(db: Database, projectIdentity: string): ClassifyArgs {
    const holderId = `classify-holder-${Math.random()}`;
    const leaseKey = `classify-${Math.random()}`;
    expect(acquireLease(db, holderId, leaseKey)).toBe(true);
    return {
        db,
        client: {} as never,
        projectIdentity,
        parentSessionId: "run-classify",
        sessionDirectory: process.cwd(),
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

describe("claim-native classification", () => {
    test("applies one bound manifest under one receipt", () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:classify-apply";
            const publicClaimId = seedClaim(db, projectIdentity, 1);
            const [snapshot] = readDreamerProjectClaims(db, projectIdentity, "hygiene");
            if (!snapshot) throw new Error("missing claim snapshot");
            const receiptsBefore = count(db, "claim_operation_receipts");

            expect(
                applyClassifications(
                    classifyArgs(db, projectIdentity),
                    [snapshot],
                    `<classify><memory claim="${publicClaimId}" importance="85" scope="ecosystem" shareable="true"/></classify>`,
                ),
            ).toEqual({ classified: 1, changed: 1 });

            const current = getProjectMemoryClaimByPublicId(db, publicClaimId);
            expect(current?.revision).toBe(2);
            const attributes = db
                .prepare(
                    "SELECT importance, memory_scope AS memoryScope, sharing FROM claim_memory_revision_attributes WHERE revision_id = ?",
                )
                .get(current?.currentRevisionId) as Record<string, unknown>;
            expect(attributes).toEqual({
                importance: 85,
                memoryScope: "ecosystem",
                sharing: "shareable",
            });
            expect(count(db, "claim_operation_receipts")).toBe(receiptsBefore + 1);
        } finally {
            closeQuietly(db);
        }
    });

    test("stale member rolls back every classification in the batch", () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:classify-stale";
            const firstId = seedClaim(db, projectIdentity, 1);
            const secondId = seedClaim(db, projectIdentity, 2);
            const snapshots = readDreamerProjectClaims(db, projectIdentity, "hygiene");
            reviseProjectMemoryClaim(
                db,
                { producer: "test", operationKey: "move-second" },
                {
                    token: computeProjectMemoryMutationToken(db, secondId),
                    content: "Second claim changed.",
                    provenance: {
                        sourceLocator: "test://move",
                        sourceContent: "Second claim changed.",
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
            const firstRevisionBefore = getProjectMemoryClaimByPublicId(db, firstId)?.revision;

            expect(
                applyClassifications(
                    classifyArgs(db, projectIdentity),
                    snapshots,
                    `<classify><memory claim="${firstId}" importance="90"/><memory claim="${secondId}" importance="90"/></classify>`,
                ),
            ).toEqual({ classified: 0, changed: 0 });
            expect(getProjectMemoryClaimByPublicId(db, firstId)?.revision).toBe(
                firstRevisionBefore,
            );
            expect(count(db, "claim_operation_effects")).toBe(effectsBefore);
        } finally {
            closeQuietly(db);
        }
    });

    test("malformed manifest records one zero-effect rejection", () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:classify-malformed";
            seedClaim(db, projectIdentity, 1);
            const snapshots = readDreamerProjectClaims(db, projectIdentity, "hygiene");
            const receiptsBefore = count(db, "claim_operation_receipts");
            const effectsBefore = count(db, "claim_operation_effects");
            expect(() =>
                applyClassifications(
                    classifyArgs(db, projectIdentity),
                    snapshots,
                    `<classify><memory claim="${snapshots[0]?.publicClaimId}" importance="80"/>`,
                ),
            ).toThrow(/closing root/);
            expect(count(db, "claim_operation_receipts")).toBe(receiptsBefore + 1);
            expect(count(db, "claim_operation_effects")).toBe(effectsBefore);
        } finally {
            closeQuietly(db);
        }
    });

    test("provider failure records zero effects and leaves work pending", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:classify-provider";
            for (let index = 0; index < 10; index += 1) seedClaim(db, projectIdentity, index);
            const args = classifyArgs(db, projectIdentity);
            args.client = {
                session: { create: async () => Promise.reject(new Error("provider unavailable")) },
            } as never;
            const effectsBefore = count(db, "claim_operation_effects");
            const result = await runClassify(args);
            expect(result.complete).toBe(false);
            expect(result.remaining).toBe(10);
            expect(count(db, "claim_operation_effects")).toBe(effectsBefore);
        } finally {
            closeQuietly(db);
        }
    });
});

/** `dreamer.run_task` rejects a classify payload whose `model_chain` is missing
 *  or empty, and the chain is the only path by which the dreamer-level default
 *  model reaches classify. */
describe("module-route classify model chain", () => {
    function moduleArgs(db: Database, projectIdentity: string): ClassifyArgs {
        const args = classifyArgs(db, projectIdentity);
        args.moduleSessionId = "module-session";
        args.moduleProjectRoot = process.cwd();
        args.moduleContextStoreUuid = "context-store-uuid";
        args.moduleAuthorityGeneration = 1;
        return args;
    }

    test("sends the resolved chain verbatim, including the dreamer-level default", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:classify-module-chain";
            for (let index = 0; index < 10; index += 1) seedClaim(db, projectIdentity, index);
            const args = moduleArgs(db, projectIdentity);
            const payloads: { items: { public_claim_id: string }[]; model_chain?: unknown }[] = [];
            args.moduleClient = {
                call: async ({ body }) => {
                    const { payload } = body as {
                        payload: { items: { public_claim_id: string }[]; model_chain?: unknown };
                    };
                    payloads.push(payload);
                    return {
                        result: {
                            manifest_text: `<classify>${payload.items
                                .map(
                                    (item) =>
                                        `<memory claim="${item.public_claim_id}" importance="80"/>`,
                                )
                                .join("")}</classify>`,
                        },
                    };
                },
            };
            // Exactly the production wiring: task override → dreamer default → fallbacks.
            args.modelChain = buildClassifyModelChain("prov/task", "prov/dreamer", [
                "prov/fallback",
            ]);

            const result = await runClassify(args);
            expect(result.complete).toBe(true);
            expect(payloads).toHaveLength(1);
            expect(payloads[0]?.model_chain).toEqual([
                "prov/task",
                "prov/dreamer",
                "prov/fallback",
            ]);
        } finally {
            closeQuietly(db);
        }
    });

    test("an unresolvable chain fails permanently before any module call", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:classify-module-no-chain";
            for (let index = 0; index < 10; index += 1) seedClaim(db, projectIdentity, index);
            const args = moduleArgs(db, projectIdentity);
            let called = false;
            args.moduleClient = {
                call: async () => {
                    called = true;
                    return {};
                },
            };
            // Every model key unset or malformed resolves to an empty chain.
            args.modelChain = buildClassifyModelChain(undefined, "flat-model", undefined);
            expect(args.modelChain).toEqual([]);

            const error = await runClassify(args).then(
                () => null,
                (caught: unknown) => caught,
            );
            expect((error as Error | null)?.message).toMatch(/no effective model chain/);
            // Pre-flighted: no session is spawned and no module call is attempted.
            expect(called).toBe(false);
            // Permanent, not transient. It is thrown outside the per-chunk catch, so
            // it is never wrapped in DreamerModuleFailureError (transient = true), and
            // its wording avoids classifyFailure's transient vocabulary — the task
            // advances to its next cron slot instead of hot-retrying a config error.
            expect((error as { transient?: unknown } | null)?.transient).toBeUndefined();
            expect((error as Error | null)?.name).not.toBe("DreamerModuleFailureError");
            expect((error as Error | null)?.message ?? "").not.toMatch(
                /abort|lease|timeout|timed out|econn|socket|network|rate.?limit|429|503|overloaded|sqlite_busy|database is locked/i,
            );
        } finally {
            closeQuietly(db);
        }
    });
});
