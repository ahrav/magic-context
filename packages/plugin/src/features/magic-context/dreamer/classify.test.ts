/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import type { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import {
    readProjectMemoryCurrentState,
    resolveProjectIdsForIdentities,
} from "../memory/storage-claim-current-state";
import {
    computeProjectMemoryMutationToken,
    createProjectMemoryClaim,
    getProjectMemoryClaimByPublicId,
    reviseProjectMemoryClaim,
} from "../memory/storage-claim-operations";
import { ensureProject } from "../memory/storage-claims";
import { createDirectTestDatabase } from "../test-database";
import { readDreamerProjectClaims } from "./claim-manifest";
import {
    applyClassifications,
    type ClassifyArgs,
    MAX_CLASSIFY_PROMPT_BYTES,
    runClassify,
} from "./classify";
import { acquireLease } from "./lease";
import { buildClassifyModelChain } from "./task-config";

function freshDb(): Database {
    const db = createDirectTestDatabase().db;
    return db;
}

function seedClaim(
    db: Database,
    projectIdentity: string,
    index: number,
    content = `Classification fact ${index}.`,
): string {
    const result = createProjectMemoryClaim(
        db,
        { producer: "classify-test", operationKey: `seed-${projectIdentity}-${index}` },
        {
            projectId: ensureProject(db, projectIdentity),
            content,
            category: "ARCHITECTURE",
            provenance: {
                sourceLocator: `test://classify/${index}`,
                sourceContent: content,
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

function moduleArgs(db: Database, projectIdentity: string): ClassifyArgs {
    const args = classifyArgs(db, projectIdentity);
    args.moduleSessionId = "module-session";
    args.moduleProjectRoot = process.cwd();
    args.moduleContextStoreUuid = "context-store-uuid";
    args.moduleAuthorityGeneration = 1;
    args.modelChain = ["prov/model"];
    return args;
}

/** One `dreamer.run_task` classify payload as it reaches the module. */
interface CapturedCall {
    promptBytes: number;
    timeoutMs: number | undefined;
    payloadTimeoutMs: unknown;
    items: Array<{
        public_claim_id: string;
        revision_locator: string;
        content_digest: string;
        mutation_token: { publicClaimId: string };
    }>;
}

/** A module client that answers every chunk with the manifest shape
 *  `CLASSIFY_SYSTEM_PROMPT` demands, recording what the caller sent. */
function capturingModuleClient(calls: CapturedCall[]): NonNullable<ClassifyArgs["moduleClient"]> {
    return {
        call: async ({ body, timeoutMs }) => {
            const { payload } = body as {
                payload: {
                    prompt_body: string;
                    timeout_ms?: unknown;
                    items: CapturedCall["items"];
                };
            };
            calls.push({
                promptBytes: Buffer.byteLength(payload.prompt_body, "utf8"),
                timeoutMs,
                payloadTimeoutMs: payload.timeout_ms,
                items: payload.items,
            });
            return {
                result: {
                    manifest_text: `<classify>${payload.items
                        .map(
                            (item) =>
                                `<memory claim="${item.public_claim_id}" importance="80" scope="project" shareable="true"/>`,
                        )
                        .join("")}</classify>`,
                },
            };
        },
    };
}

function count(
    db: Database,
    table: "claim_operation_receipts" | "claim_operation_effects",
): number {
    return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

/** The current revision's stored policy decision: the maturity rung and the
 *  automatic-surface bit that gate injection. */
function currentPolicy(
    db: Database,
    publicClaimId: string,
): { revision: number; maturity: string; taint: string; autoEligible: number } {
    const claim = getProjectMemoryClaimByPublicId(db, publicClaimId);
    if (!claim) throw new Error(`missing claim ${publicClaimId}`);
    const row = db
        .prepare(
            `SELECT effective_maturity AS maturity, origin_taint AS taint,
                    auto_eligible AS autoEligible
               FROM claim_effective_policy WHERE revision_id = ?`,
        )
        .get(claim.currentRevisionId) as {
        maturity: string;
        taint: string;
        autoEligible: number;
    };
    return { revision: claim.revision, ...row };
}

/** Public claim ids the automatic-injection surface would publish. */
function autoInjectIds(db: Database, projectIdentity: string): string[] {
    const [projectId] = resolveProjectIdsForIdentities(db, [projectIdentity]);
    if (projectId === undefined) return [];
    const result = readProjectMemoryCurrentState(db, {
        projectIds: [projectId],
        lifecycleStates: ["active"],
        surface: "auto_inject",
        workspaceEpoch: `test:auto_inject:${projectIdentity}`,
    });
    return result.status === "ok" ? result.items.map((item) => item.publicClaimId) : [];
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

/** Classification only ever rewrites importance/scope/sharing, never the claim
 *  bytes. A revision carrying identical bytes keeps the evidence that supports
 *  them, so metadata upkeep cannot quietly demote a trusted memory off the
 *  automatic surfaces — nor promote model-authored bytes onto them. */
describe("classification and claim trust", () => {
    test("metadata-only classification keeps a verified memory injectable", () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:classify-trust-preserved";
            const publicClaimId = seedClaim(db, projectIdentity, 1);
            const [snapshot] = readDreamerProjectClaims(db, projectIdentity, "hygiene");
            if (!snapshot) throw new Error("missing claim snapshot");

            expect(currentPolicy(db, publicClaimId)).toEqual({
                revision: 1,
                maturity: "VERIFIED",
                taint: "USER_EXPLICIT",
                autoEligible: 1,
            });
            expect(autoInjectIds(db, projectIdentity)).toEqual([publicClaimId]);

            expect(
                applyClassifications(
                    classifyArgs(db, projectIdentity),
                    [snapshot],
                    `<classify><memory claim="${publicClaimId}" importance="85"/></classify>`,
                ),
            ).toEqual({ classified: 1, changed: 1 });

            // A new revision is minted, so the rung is re-derived from scratch.
            // The carried explicit-user observation is what keeps it at VERIFIED;
            // the revision's own origin stays honestly DREAMER_INFERENCE, which
            // does not gate the automatic surfaces.
            expect(currentPolicy(db, publicClaimId)).toEqual({
                revision: 2,
                maturity: "VERIFIED",
                taint: "DREAMER_INFERENCE",
                autoEligible: 1,
            });
            expect(autoInjectIds(db, projectIdentity)).toEqual([publicClaimId]);

            // Both observations support the identical bytes, and because the
            // dreamer re-states that same content they are not an independent
            // pair — carrying evidence forward must not inflate corroboration.
            const evidence = db
                .prepare(
                    `SELECT observations.source_trust_class AS trust
                       FROM claim_evidence
                       JOIN observations ON observations.id = claim_evidence.observation_id
                      WHERE claim_evidence.revision_id = ?
                        AND claim_evidence.relation = 'supports'
                      ORDER BY trust`,
                )
                .all(getProjectMemoryClaimByPublicId(db, publicClaimId)?.currentRevisionId);
            expect(evidence).toEqual([{ trust: "explicit_user" }, { trust: "model_inference" }]);
        } finally {
            closeQuietly(db);
        }
    });

    test("classification cannot lift model-authored content to explicit-user trust", () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:classify-trust-trap";
            const publicClaimId = seedClaim(db, projectIdentity, 1);
            // A content rewrite replaces the bytes the user asserted, so the
            // explicit-user observation must NOT follow it.
            reviseProjectMemoryClaim(
                db,
                { producer: "test", operationKey: "model-rewrite" },
                {
                    token: computeProjectMemoryMutationToken(db, publicClaimId),
                    content: "Replacement the user never asserted.",
                    provenance: {
                        sourceLocator: "dreamer://rewrite",
                        sourceContent: "Replacement the user never asserted.",
                        extractor: "dreamer-map-memories",
                        extractorVersion: "1",
                        extractorRunId: "rewrite",
                        independenceKey: "rewrite",
                        sourceTrustClass: "model_inference",
                    },
                    actor: "dreamer:test",
                },
            );
            expect(currentPolicy(db, publicClaimId)).toEqual({
                revision: 2,
                maturity: "CANDIDATE",
                taint: "DREAMER_INFERENCE",
                autoEligible: 0,
            });
            expect(autoInjectIds(db, projectIdentity)).toEqual([]);

            const [snapshot] = readDreamerProjectClaims(db, projectIdentity, "hygiene");
            if (!snapshot) throw new Error("missing claim snapshot");
            expect(
                applyClassifications(
                    classifyArgs(db, projectIdentity),
                    [snapshot],
                    `<classify><memory claim="${publicClaimId}" importance="95"/></classify>`,
                ),
            ).toEqual({ classified: 1, changed: 1 });

            // Carrying the prior revision's evidence forward is safe: those
            // observations are model inference, and the explicit-user standing
            // was already severed by the rewrite.
            expect(currentPolicy(db, publicClaimId)).toEqual({
                revision: 3,
                maturity: "CANDIDATE",
                taint: "DREAMER_INFERENCE",
                autoEligible: 0,
            });
            expect(autoInjectIds(db, projectIdentity)).toEqual([]);
        } finally {
            closeQuietly(db);
        }
    });
});

/** `dreamer.run_task` rejects a classify payload whose `model_chain` is missing
 *  or empty, and the chain is the only path by which the dreamer-level default
 *  model reaches classify. */
describe("module-route classify model chain", () => {
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

/** The module route's request items, its manifest identities, the prompt byte
 *  cap, and the module-side deadline are one contract: the handler's request
 *  parser, its expected-id set, and its manifest validator all key on the
 *  claim's public id, and it refuses a prompt over the cap or a payload without
 *  a deadline. */
describe("module-route classify wire contract", () => {
    test("a claim-identity payload round-trips and applies", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:classify-module-identity";
            const seeded = new Set<string>();
            for (let index = 0; index < 10; index += 1) {
                seeded.add(seedClaim(db, projectIdentity, index));
            }
            const snapshots = readDreamerProjectClaims(db, projectIdentity, "hygiene");
            const args = moduleArgs(db, projectIdentity);
            const calls: CapturedCall[] = [];
            args.moduleClient = capturingModuleClient(calls);

            const result = await runClassify(args);

            expect(result).toMatchObject({ classified: 10, remaining: 0, complete: true });
            expect(calls).toHaveLength(1);
            // Every item is a claim identity: the opaque public id plus the
            // revision binding, with no integer memory id anywhere.
            expect(new Set(calls[0]?.items.map((item) => item.public_claim_id))).toEqual(seeded);
            const byId = new Map(snapshots.map((claim) => [claim.publicClaimId, claim]));
            expect(
                calls[0]?.items.every(
                    (item) =>
                        item.revision_locator === byId.get(item.public_claim_id)?.revisionLocator &&
                        item.content_digest === byId.get(item.public_claim_id)?.contentDigest &&
                        item.mutation_token.publicClaimId === item.public_claim_id &&
                        !("memory_id" in item),
                ),
            ).toBe(true);
            // The `claim="mcm_..."` manifest was accepted and applied.
            for (const publicClaimId of seeded) {
                expect(getProjectMemoryClaimByPublicId(db, publicClaimId)?.revision).toBe(2);
            }
        } finally {
            closeQuietly(db);
        }
    });

    test("a manifest naming an unexpected claim is rejected without applying", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:classify-module-unexpected";
            for (let index = 0; index < 10; index += 1) seedClaim(db, projectIdentity, index);
            const args = moduleArgs(db, projectIdentity);
            const effectsBefore = count(db, "claim_operation_effects");
            args.moduleClient = {
                call: async ({ body }) => {
                    const { payload } = body as {
                        payload: { items: Array<{ public_claim_id: string }> };
                    };
                    const entries = payload.items
                        .map((item) => `<memory claim="${item.public_claim_id}" importance="80"/>`)
                        .join("");
                    return {
                        result: {
                            // One claim nobody asked about rides along.
                            manifest_text: `<classify>${entries}<memory claim="mcm_${"9".repeat(32)}" importance="80"/></classify>`,
                        },
                    };
                },
            };

            const error = await runClassify(args).then(
                () => null,
                (caught: unknown) => caught,
            );
            expect((error as Error | null)?.message).toMatch(/unknown id/);
            expect(count(db, "claim_operation_effects")).toBe(effectsBefore);
        } finally {
            closeQuietly(db);
        }
    });

    test("a pool over the prompt byte cap splits into chunks that each fit", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:classify-module-bytes";
            const seeded = new Set<string>();
            // Ten entries stay under the 100-entry chunk bound, so only the
            // byte bound can split them. Together they are ~400 KiB, well over
            // the module's 256 KiB prompt_body cap.
            for (let index = 0; index < 10; index += 1) {
                seeded.add(
                    seedClaim(db, projectIdentity, index, `fact ${index} `.padEnd(40_000, "x")),
                );
            }
            const args = moduleArgs(db, projectIdentity);
            const calls: CapturedCall[] = [];
            args.moduleClient = capturingModuleClient(calls);

            const result = await runClassify(args);

            expect(calls.length).toBeGreaterThan(1);
            for (const call of calls) {
                expect(call.promptBytes).toBeLessThanOrEqual(MAX_CLASSIFY_PROMPT_BYTES);
            }
            // Splitting must not drop or duplicate work.
            const sent = calls.flatMap((call) => call.items.map((item) => item.public_claim_id));
            expect(new Set(sent)).toEqual(seeded);
            expect(sent).toHaveLength(seeded.size);
            expect(result).toMatchObject({ classified: 10, remaining: 0, complete: true });
        } finally {
            closeQuietly(db);
        }
    });

    test("a single claim too large for any chunk is skipped with a recorded reason", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:classify-module-oversized";
            const fitting = new Set<string>();
            for (let index = 0; index < 9; index += 1) {
                fitting.add(seedClaim(db, projectIdentity, index));
            }
            // Larger than the whole pool byte budget, so no split can ever make
            // it fit: a byte-aware chunker that only kept splitting would make
            // no progress and this claim would never classify on any run.
            const oversized = seedClaim(db, projectIdentity, 99, "big ".padEnd(200_000, "x"));
            const args = moduleArgs(db, projectIdentity);
            const calls: CapturedCall[] = [];
            args.moduleClient = capturingModuleClient(calls);

            const result = await runClassify(args);

            const sent = calls.flatMap((call) => call.items.map((item) => item.public_claim_id));
            expect(new Set(sent)).toEqual(fitting);
            expect(sent).not.toContain(oversized);
            // The skip is durable evidence, not just a log line: a zero-effect
            // rejection receipt names the claim, its size, and the budget.
            const receipts = db
                .prepare(
                    `SELECT result_json AS resultJson FROM claim_operation_receipts
                      WHERE producer = 'dreamer-classify-memories' AND outcome = 'stale'`,
                )
                .all() as Array<{ resultJson: string }>;
            const reasons = receipts.map((row) => row.resultJson).join("\n");
            expect(reasons).toContain(oversized);
            expect(reasons).toMatch(/over the \d+-byte pool budget/);
            expect(getProjectMemoryClaimByPublicId(db, oversized)?.revision).toBe(1);
            // The skipped claim is not counted as outstanding work, so the pass
            // completes instead of hot-retrying a chunk that can never fit.
            expect(result).toMatchObject({ classified: 9, remaining: 0, complete: true });
        } finally {
            closeQuietly(db);
        }
    });

    test("the module deadline is present and strictly shorter than the transport budget", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:classify-module-deadline";
            for (let index = 0; index < 10; index += 1) seedClaim(db, projectIdentity, index);
            const args = moduleArgs(db, projectIdentity);
            const calls: CapturedCall[] = [];
            args.moduleClient = capturingModuleClient(calls);

            await runClassify(args);

            expect(calls).toHaveLength(1);
            const transportMs = calls[0]?.timeoutMs;
            const payloadMs = calls[0]?.payloadTimeoutMs;
            expect(typeof transportMs).toBe("number");
            expect(typeof payloadMs).toBe("number");
            expect(payloadMs as number).toBeGreaterThan(0);
            // The gap is the module's cleanup reserve: without it the transport
            // cancels first, between the producer run and `purge_session`, so
            // nothing is recorded, no fallback completes, and the attempt's
            // billable run stays alive.
            expect((transportMs as number) - (payloadMs as number)).toBe(40_000);
            expect(payloadMs as number).toBeLessThan(transportMs as number);
        } finally {
            closeQuietly(db);
        }
    });

    test("a slice too short to reserve the cleanup margin makes no module call", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:classify-module-short-slice";
            for (let index = 0; index < 10; index += 1) seedClaim(db, projectIdentity, index);
            const args = moduleArgs(db, projectIdentity);
            // Positive, so the pass starts, but under the cleanup reserve: a
            // call here could only hand the module a non-positive deadline.
            args.deadline = Date.now() + 5_000;
            const calls: CapturedCall[] = [];
            args.moduleClient = capturingModuleClient(calls);

            const result = await runClassify(args);

            expect(calls).toHaveLength(0);
            // The chunk stays unbanked and eligible on the next pass rather
            // than being counted as done.
            expect(result).toMatchObject({ classified: 0, remaining: 10, complete: false });
        } finally {
            closeQuietly(db);
        }
    });
});
