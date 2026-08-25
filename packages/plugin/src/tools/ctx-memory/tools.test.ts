import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DREAMER_AGENT } from "../../agents/dreamer";
import {
    computeProjectMemoryMutationToken,
    getProjectMemoryClaimByPublicId,
} from "../../features/magic-context/memory/storage-claim-operations";
import {
    createClaimReaderTestDatabase,
    seedProjectMemoryClaim,
} from "../../features/magic-context/test-claim-database";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createCtxMemoryTools } from "./tools";

const PROJECT = "git:u4-opencode";
const FOREIGN = "git:u4-foreign";

type JsonResult = {
    action: string;
    outcome: string;
    staleReason: string | null;
    affectedClaims?: Array<{
        publicClaimId: string;
        revisionLocator: string;
        mutationToken: ReturnType<typeof computeProjectMemoryMutationToken>;
    }>;
    claims?: Array<{
        publicClaimId: string;
        revisionLocator: string;
        content: string;
        lifecycleState: string;
        mutationToken: ReturnType<typeof computeProjectMemoryMutationToken>;
    }>;
    missingPublicClaimIds?: string[];
    effects: unknown[];
    generation: number | null;
};

function harness(db: ReturnType<typeof createClaimReaderTestDatabase>) {
    const definition = createCtxMemoryTools({
        db,
        resolveProjectPath: () => PROJECT,
        allowedActions: ["create", "get", "revise", "archive", "restore", "merge"],
    }).ctx_memory;
    const execute = async (
        args: Record<string, unknown>,
        callID: string,
        agent = "primary",
    ): Promise<string> =>
        definition.execute(
            args as never,
            {
                sessionID: "ses-u4-opencode",
                directory: "/tmp/u4-opencode",
                callID,
                agent,
            } as never,
        ) as Promise<string>;
    return { definition, execute };
}

function parseResult(text: string): JsonResult {
    expect(text.startsWith("Error:")).toBeFalse();
    return JSON.parse(text) as JsonResult;
}

function createArgs(content: string) {
    return { action: "create", category: "ARCHITECTURE", content };
}

describe("ctx_memory U4 scenario 1: create uses direct claims", () => {
    test("returns public identity, revision locator, generation, and mutation token", async () => {
        const db = createClaimReaderTestDatabase();
        try {
            const result = parseResult(
                await harness(db).execute(
                    createArgs("OpenCode uses direct claims."),
                    "call-create",
                ),
            );
            expect(result).toMatchObject({ action: "create", outcome: "applied" });
            expect(result.affectedClaims).toHaveLength(1);
            expect(result.affectedClaims?.[0]?.publicClaimId).toMatch(/^mcm_[0-9a-f]{32}$/);
            expect(result.affectedClaims?.[0]?.revisionLocator).toContain("/r1/");
            expect(result.affectedClaims?.[0]?.mutationToken.publicClaimId).toBe(
                result.affectedClaims?.[0]?.publicClaimId,
            );
            expect(result.generation).toBe(1);
            expect(
                db.prepare("SELECT COUNT(*) AS count FROM claim_operation_receipts").get(),
            ).toEqual({ count: 1 });
        } finally {
            closeQuietly(db);
        }
    });
});

describe("ctx_memory U4 scenario 2: canonical reads and role gates", () => {
    test("get uses public IDs and list remains dreamer-only", async () => {
        const db = createClaimReaderTestDatabase();
        try {
            const seeded = seedProjectMemoryClaim(db, {
                projectIdentity: PROJECT,
                content: "Canonical reader claim.",
                operationKey: "u4-read",
            });
            const tool = harness(db);
            const got = parseResult(
                await tool.execute(
                    { action: "get", publicClaimIds: [seeded.publicClaimId] },
                    "call-get",
                ),
            );
            expect(got.claims?.[0]).toMatchObject({
                publicClaimId: seeded.publicClaimId,
                revisionLocator: seeded.revisionLocator,
                content: "Canonical reader claim.",
            });
            expect(got.missingPublicClaimIds).toEqual([]);

            expect(await tool.execute({ action: "list" }, "call-list-primary")).toContain(
                "not allowed",
            );
            const listed = parseResult(
                await tool.execute({ action: "list" }, "call-list-dreamer", DREAMER_AGENT),
            );
            expect(listed.claims?.map((claim) => claim.publicClaimId)).toEqual([
                seeded.publicClaimId,
            ]);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("ctx_memory U4 scenario 3: revise and lifecycle", () => {
    test("appends revision, archives, and restores with returned tokens", async () => {
        const db = createClaimReaderTestDatabase();
        try {
            const tool = harness(db);
            const created = parseResult(
                await tool.execute(createArgs("Lifecycle original."), "call-create"),
            );
            const first = created.affectedClaims?.[0];
            if (!first) throw new Error("missing create result");
            const revised = parseResult(
                await tool.execute(
                    {
                        action: "revise",
                        publicClaimId: first.publicClaimId,
                        mutationToken: first.mutationToken,
                        content: "Lifecycle revised.",
                    },
                    "call-revise",
                ),
            );
            const second = revised.affectedClaims?.[0];
            expect(second?.revisionLocator).toContain("/r2/");
            if (!second) throw new Error("missing revise result");

            const archived = parseResult(
                await tool.execute(
                    {
                        action: "archive",
                        publicClaimId: second.publicClaimId,
                        mutationToken: second.mutationToken,
                        reason: "obsolete",
                    },
                    "call-archive",
                ),
            );
            expect(archived.affectedClaims?.[0]?.mutationToken.lifecycleSeq).toBe(
                second.mutationToken.lifecycleSeq + 1,
            );
            const archivedToken = archived.affectedClaims?.[0]?.mutationToken;
            if (!archivedToken) throw new Error("missing archive token");
            const restored = parseResult(
                await tool.execute(
                    {
                        action: "restore",
                        publicClaimId: second.publicClaimId,
                        mutationToken: archivedToken,
                    },
                    "call-restore",
                ),
            );
            expect(restored.outcome).toBe("applied");
            expect(getProjectMemoryClaimByPublicId(db, second.publicClaimId)?.revision).toBe(2);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("ctx_memory U4 scenario 4: same-project merge", () => {
    test("retires sources and rejects a foreign source", async () => {
        const db = createClaimReaderTestDatabase();
        try {
            const target = seedProjectMemoryClaim(db, {
                projectIdentity: PROJECT,
                content: "Merge target.",
                operationKey: "u4-merge-target",
            });
            const source = seedProjectMemoryClaim(db, {
                projectIdentity: PROJECT,
                content: "Merge source.",
                operationKey: "u4-merge-source",
            });
            const foreign = seedProjectMemoryClaim(db, {
                projectIdentity: FOREIGN,
                content: "Foreign source.",
                operationKey: "u4-merge-foreign",
            });
            const tool = harness(db);
            const merged = parseResult(
                await tool.execute(
                    {
                        action: "merge",
                        mutationTokens: [target.token, source.token],
                        content: "Merged claim.",
                    },
                    "call-merge",
                ),
            );
            expect(merged.affectedClaims?.map((claim) => claim.publicClaimId).sort()).toEqual(
                [target.publicClaimId, source.publicClaimId].sort(),
            );
            const sourceGet = parseResult(
                await tool.execute(
                    { action: "get", publicClaimIds: [source.publicClaimId] },
                    "call-get-retired",
                ),
            );
            expect(sourceGet.claims?.[0]?.lifecycleState).toBe("retired");

            const blocked = await tool.execute(
                {
                    action: "merge",
                    mutationTokens: [
                        computeProjectMemoryMutationToken(db, target.publicClaimId),
                        foreign.token,
                    ],
                },
                "call-merge-foreign",
            );
            expect(blocked).toBe("Error: claim not found or not visible from this project");
        } finally {
            closeQuietly(db);
        }
    });
});

describe("ctx_memory U4 scenario 5: operation replay", () => {
    test("same call replays; changed arguments return the shared key-reuse error", async () => {
        const db = createClaimReaderTestDatabase();
        try {
            const tool = harness(db);
            const args = createArgs("Replay exact bytes.");
            const firstText = await tool.execute(args, "call-replay");
            const first = parseResult(firstText).affectedClaims?.[0];
            if (!first) throw new Error("missing replay create result");
            await tool.execute(
                {
                    action: "revise",
                    publicClaimId: first.publicClaimId,
                    mutationToken: first.mutationToken,
                    content: "Replay state moved later.",
                },
                "call-replay-state-move",
            );
            expect(await tool.execute(args, "call-replay")).toBe(firstText);
            expect(await tool.execute(createArgs("Changed args."), "call-replay")).toBe(
                "Error: this tool call id was already committed with different arguments. Retry as a new call.",
            );
            expect(
                db.prepare("SELECT COUNT(*) AS count FROM claim_operation_receipts").get(),
            ).toEqual({ count: 2 });
        } finally {
            closeQuietly(db);
        }
    });
});

describe("ctx_memory U4 scenario 6: privacy and ownership", () => {
    test("hidden and missing get results match; foreign claims cannot mutate", async () => {
        const db = createClaimReaderTestDatabase();
        const missingDb = createClaimReaderTestDatabase();
        try {
            const hidden = seedProjectMemoryClaim(db, {
                projectIdentity: PROJECT,
                content: "Hidden claim.",
                operationKey: "u4-hidden",
            });
            const hiddenRef = getProjectMemoryClaimByPublicId(db, hidden.publicClaimId);
            if (!hiddenRef) throw new Error("missing hidden claim");
            db.transaction(() => {
                db.prepare(
                    `INSERT INTO claim_disposition_events
                        (revision_id, project_id, disposition, action, actor, policy_version, recorded_at)
                     VALUES (?, ?, 'quarantined', 'assert', 'user:test', 1, ?)`,
                ).run(hiddenRef.currentRevisionId, hidden.projectId, Date.now());
                db.prepare(
                    "UPDATE claim_effective_policy SET hard_hidden = 1, auto_eligible = 0, explicit_eligible = 0 WHERE revision_id = ?",
                ).run(hiddenRef.currentRevisionId);
            }).immediate();
            const tool = harness(db);
            const hiddenText = await tool.execute(
                { action: "get", publicClaimIds: [hidden.publicClaimId] },
                "call-hidden",
            );
            const missingText = await harness(missingDb).execute(
                { action: "get", publicClaimIds: [hidden.publicClaimId] },
                "call-missing",
            );
            expect(hiddenText).toBe(missingText);
            const hiddenGet = parseResult(hiddenText);
            expect(hiddenGet.claims).toEqual([]);
            expect(hiddenGet.missingPublicClaimIds).toEqual([hidden.publicClaimId]);

            const foreign = seedProjectMemoryClaim(db, {
                projectIdentity: FOREIGN,
                content: "Foreign claim.",
                operationKey: "u4-foreign",
            });
            expect(
                await tool.execute(
                    {
                        action: "archive",
                        publicClaimId: foreign.publicClaimId,
                        mutationToken: foreign.token,
                    },
                    "call-foreign-archive",
                ),
            ).toBe("Error: claim not found or not visible from this project");
        } finally {
            closeQuietly(db);
            closeQuietly(missingDb);
        }
    });
});

describe("ctx_memory U4 scenario 7: human authority", () => {
    test("agent approve and enforce actions are rejected", async () => {
        const db = createClaimReaderTestDatabase();
        try {
            const tool = harness(db);
            expect(await tool.execute({ action: "approve" }, "call-approve")).toContain(
                "human-host-owned",
            );
            expect(await tool.execute({ action: "enforce" }, "call-enforce")).toContain(
                "human-host-owned",
            );
            expect(
                await tool.execute({ action: "delete" }, "call-delete", DREAMER_AGENT),
            ).toContain("not allowed");
        } finally {
            closeQuietly(db);
        }
    });
});

describe("ctx_memory U4 scenario 8: no legacy active path", () => {
    test("tool sources contain no legacy IDs, embeddings, or mutation-log writes", () => {
        const files = [
            resolve(import.meta.dir, "claim-actions.ts"),
            resolve(import.meta.dir, "constants.ts"),
            resolve(import.meta.dir, "tools.ts"),
            resolve(import.meta.dir, "types.ts"),
            resolve(import.meta.dir, "../../plugin/tool-registry.ts"),
            resolve(import.meta.dir, "../../../../pi-plugin/src/tools/ctx-memory.ts"),
            resolve(import.meta.dir, "../../../../pi-plugin/src/tools/index.ts"),
        ];
        const forbidden = [
            "memory_embeddings",
            "memory_mutation_log",
            "storage-memory-claims",
            'storage-memory"',
            "memoryId",
            "projectId: effect.projectId",
        ];
        for (const file of files) {
            const source = readFileSync(file, "utf8");
            for (const value of forbidden) expect(source).not.toContain(value);
        }
    });
});
