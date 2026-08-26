import { afterAll, describe, expect, it } from "bun:test";
import { realpathSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import type { MockProvider } from "../src/mock-provider/server";
import { TestHarness } from "../src/harness";
import { PiTestHarness } from "../src/pi-harness";
import { openTestDb } from "../src/test-db";

interface MutationToken {
    tokenVersion: number;
    publicClaimId: string;
    revision: number;
    contentDigest: string;
    lifecycleSeq: number;
    applicabilityHeadsDigest: string;
    policyHeadsDigest: string;
}

interface MutationResult {
    action: "create";
    outcome: "applied" | "noop" | "stale";
    generation: number | null;
    affectedClaims: Array<{
        publicClaimId: string;
        revisionLocator: string;
        mutationToken: MutationToken;
    }>;
    effects: Array<{
        changeKind: string;
        effectKey: string;
        generation: number;
        revisionLocator: string | null;
    }>;
}

interface GetResult {
    action: "get";
    outcome: "noop";
    generation: null;
    claims: Array<{
        publicClaimId: string;
        revisionLocator: string;
        revision: number;
        contentDigest: string;
        content: string;
        mutationToken: MutationToken;
    }>;
    missingPublicClaimIds: string[];
}

let openCode: TestHarness | null = null;
let pi: PiTestHarness | null = null;

afterAll(async () => {
    await pi?.dispose();
    await openCode?.dispose();
});

function emitToolOnce(
    mock: MockProvider,
    input: Record<string, unknown>,
    prefix: string,
): void {
    let emitted = false;
    mock.addMatcher((body) => {
        if (emitted || !Array.isArray(body.tools)) return null;
        const tool = body.tools.find(
            (candidate) =>
                candidate !== null &&
                typeof candidate === "object" &&
                (candidate as { name?: unknown }).name === "ctx_memory",
        ) as { name: string } | undefined;
        if (!tool) return null;
        emitted = true;
        return {
            content: [
                {
                    type: "tool_use",
                    id: `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
                    name: tool.name,
                    input,
                },
            ],
            stop_reason: "tool_use",
            usage: {
                input_tokens: 100,
                output_tokens: 10,
                cache_creation_input_tokens: 100,
                cache_read_input_tokens: 0,
            },
        };
    });
}

function collectStrings(value: unknown, into: string[]): void {
    if (typeof value === "string") {
        into.push(value);
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectStrings(item, into);
        return;
    }
    if (value !== null && typeof value === "object") {
        for (const item of Object.values(value)) collectStrings(item, into);
    }
}

function toolResult<T extends { action: string }>(
    mock: MockProvider,
    action: T["action"],
): T {
    const strings: string[] = [];
    for (const request of mock.requests())
        collectStrings(request.body.messages, strings);
    const results = strings.flatMap((value) => {
        try {
            const parsed = JSON.parse(value.replace(/^§\d+§\s*/, "")) as unknown;
            return parsed !== null &&
                typeof parsed === "object" &&
                (parsed as { action?: unknown }).action === action
                ? [parsed as T]
                : [];
        } catch {
            return [];
        }
    });
    const result = results.at(-1);
    if (!result) {
        const toolNames = mock.requests().map((request) =>
            Array.isArray(request.body.tools)
                ? request.body.tools.map((tool) =>
                      tool && typeof tool === "object"
                          ? (tool as { name?: unknown }).name
                          : null,
                  )
                : null,
        );
        throw new Error(
            `missing ctx_memory ${action} tool result after ${mock.requests().length} provider requests; tools=${JSON.stringify(toolNames)}`,
        );
    }
    return result;
}

function resetMock(mock: MockProvider, text: string): void {
    mock.reset();
    mock.setDefault({
        text,
        usage: {
            input_tokens: 120,
            output_tokens: 10,
            cache_creation_input_tokens: 120,
            cache_read_input_tokens: 0,
        },
    });
}

describe("OpenCode and Pi direct claims parity", () => {
    it("keeps canonical locators and generation sequencing across OpenCode and Pi", async () => {
        openCode = await TestHarness.create();
        const sharedWorkdir = realpathSync(
            pathResolve(openCode.opencode.env.workdir),
        );
        pi = await PiTestHarness.create({
            sharedDataDir: openCode.opencode.env.dataDir,
            workdir: sharedWorkdir,
        });
        const content = "Direct claims parity uses canonical revision locators";
        const openCodeSession = await openCode.createSession();

        resetMock(openCode.mock, "OpenCode create complete");
        emitToolOnce(
            openCode.mock,
            { action: "create", category: "ARCHITECTURE", content },
            "toolu_oc_claim",
        );
        await openCode.sendPrompt(
            openCodeSession,
            "record direct claims parity rule",
        );
        const openCodeCreate = toolResult<MutationResult>(
            openCode.mock,
            "create",
        );
        const openCodeClaim = openCodeCreate.affectedClaims[0];
        if (!openCodeClaim || openCodeCreate.generation === null) {
            throw new Error("OpenCode create returned no claim or generation");
        }

        resetMock(pi.mock, "Pi create complete");
        emitToolOnce(
            pi.mock,
            { action: "create", category: "ARCHITECTURE", content },
            "toolu_pi_claim",
        );
        await pi.sendPrompt("record the same direct claims parity rule", {
            timeoutMs: 90_000,
        });
        const piCreate = toolResult<MutationResult>(pi.mock, "create");
        const piClaim = piCreate.affectedClaims[0];
        if (!piClaim || piCreate.generation === null) {
            throw new Error("Pi create returned no claim or generation");
        }

        expect(openCodeCreate.outcome).toBe("applied");
        expect(piCreate.outcome).toBe("applied");
        expect(openCodeClaim.publicClaimId).toMatch(/^mcm_[0-9a-f]{32}$/);
        expect(piClaim.publicClaimId).toBe(openCodeClaim.publicClaimId);
        expect(piClaim.revisionLocator).toBe(openCodeClaim.revisionLocator);
        expect(piClaim.mutationToken).toEqual(openCodeClaim.mutationToken);
        expect(piCreate.generation).toBe(openCodeCreate.generation + 1);
        expect(openCodeCreate.effects).toEqual([
            expect.objectContaining({
                changeKind: "upsert",
                generation: openCodeCreate.generation,
                revisionLocator: openCodeClaim.revisionLocator,
            }),
        ]);
        expect(piCreate.effects).toEqual([
            expect.objectContaining({
                changeKind: "evidence",
                generation: piCreate.generation,
                revisionLocator: piClaim.revisionLocator,
            }),
        ]);

        resetMock(openCode.mock, "OpenCode get complete");
        emitToolOnce(
            openCode.mock,
            { action: "get", publicClaimIds: [piClaim.publicClaimId] },
            "toolu_oc_get_claim",
        );
        await openCode.sendPrompt(
            openCodeSession,
            "read the claim written from both surfaces",
        );
        const read = toolResult<GetResult>(openCode.mock, "get");
        expect(read.missingPublicClaimIds).toEqual([]);
        expect(read.claims).toEqual([
            expect.objectContaining({
                publicClaimId: openCodeClaim.publicClaimId,
                revisionLocator: openCodeClaim.revisionLocator,
                revision: 1,
                content,
            }),
        ]);
        expect(read.claims[0]?.mutationToken).toEqual(
            openCodeClaim.mutationToken,
        );

        const db = openTestDb(openCode.contextDbPath(), { readonly: true });
        try {
            const oracle = db
                .prepare(
                    `SELECT claim_public_ids.public_id AS publicClaimId,
                                claim_revisions.revision,
                                claim_revisions.content_sha256 AS contentDigest,
                                claim_project_generations.generation
                           FROM claims
                           JOIN claim_public_ids ON claim_public_ids.claim_id = claims.id
                           JOIN claim_revisions ON claim_revisions.id = claims.current_revision_id
                           JOIN claim_project_generations
                             ON claim_project_generations.project_id = claims.project_id
                          WHERE claim_revisions.content = ?`,
                )
                .get(content) as {
                publicClaimId: string;
                revision: number;
                contentDigest: string;
                generation: number;
            };
            expect(oracle).toEqual({
                publicClaimId: openCodeClaim.publicClaimId,
                revision: 1,
                contentDigest: openCodeClaim.mutationToken.contentDigest,
                generation: piCreate.generation,
            });
            expect(
                db
                    .prepare(
                        "SELECT COUNT(*) AS count FROM claim_operation_receipts WHERE producer = 'ctx-memory-agent-v1'",
                    )
                    .get(),
            ).toEqual({ count: 2 });
            expect(
                db
                    .prepare(
                        `SELECT COUNT(*) AS count
                               FROM claim_evidence
                               JOIN claim_revisions ON claim_revisions.id = claim_evidence.revision_id
                               JOIN claim_public_ids ON claim_public_ids.claim_id = claim_revisions.claim_id
                              WHERE claim_public_ids.public_id = ?`,
                    )
                    .get(openCodeClaim.publicClaimId),
            ).toEqual({ count: 2 });
        } finally {
            db.close();
        }

        for (const result of [openCodeCreate, piCreate, read]) {
            expect(JSON.stringify(result)).not.toMatch(
                /"(?:memoryId|memory_id|id)"\s*:/,
            );
        }
    }, 300_000);
});
