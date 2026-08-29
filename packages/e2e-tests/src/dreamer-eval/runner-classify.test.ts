import { describe, expect, test } from "bun:test";
import { shouldKeepSubagents } from "../../../plugin/src/shared/keep-subagents";
import { seedProjectMemoryClaim } from "../../../plugin/src/features/magic-context/test-claim-database";
import { createDirectTestDatabase } from "../../../plugin/src/features/magic-context/test-database";
import { dreamerScorerFixture } from "./scorer.test";
import {
    classifyDreamerRun,
    readDreamerReceipts,
    reconstructPoolEndState,
    type DreamerRunClassificationInput,
} from "./runner";

const validManifest = `<classifications>
<memory id="mem-1" importance="85" scope="project" shareable="true" />
<memory id="mem-2" importance="25" scope="ecosystem" shareable="false" />
</classifications>`;

function assistantMessages(text: string, info: Record<string, unknown> = {}): unknown[] {
    return [
        {
            info: {
                role: "assistant",
                time: { created: 1 },
                finish: "stop",
                tokens: { output: 80, reasoning: 0 },
                ...info,
            },
            parts: [{ type: "text", text }],
        },
    ];
}

function input(overrides: Partial<DreamerRunClassificationInput> = {}): DreamerRunClassificationInput {
    return {
        task: "classify-memories",
        pool: dreamerScorerFixture.pool,
        gold: dreamerScorerFixture.classifyGold,
        pinnedModel: "anthropic/claude-test",
        rawManifest: validManifest,
        childMessages: assistantMessages(validManifest),
        childCount: 1,
        expectedChildCount: 1,
        invocation: {
            status: "completed",
            providerId: "anthropic",
            modelId: "claude-test",
        },
        receipts: [],
        rejectionRequestDigest: "b".repeat(64),
        fixtureUnchanged: true,
        leaseLost: false,
        expectedResultMode: null,
        actualResultMode: null,
        ...overrides,
    };
}

describe("dreamer runner classification", () => {
    test("completed validator rejection is FAIL:invalid-output", () => {
        const result = classifyDreamerRun(
            input({
                rawManifest: "not XML",
                childMessages: assistantMessages("not XML"),
                receipts: [
                    {
                        affectedClaimIds: [],
                        operationKey: "reject:one",
                        outcome: "stale",
                        requestDigest: "b".repeat(64),
                    },
                ],
            }),
        );
        expect(result).toMatchObject({ status: "FAIL", reason: "invalid-output" });
    });

    test("no child output is ERROR:provider-failure", () => {
        expect(
            classifyDreamerRun(input({ rawManifest: null, childMessages: [] })),
        ).toMatchObject({ status: "ERROR", reason: "provider-failure" });
    });

    test("length-capped output is ERROR:output-length-capped", () => {
        expect(
            classifyDreamerRun(
                input({
                    childMessages: assistantMessages(validManifest, { finish_reason: "length" }),
                }),
            ),
        ).toMatchObject({ status: "ERROR", reason: "output-length-capped" });
    });

    test("typed provider output fault is ERROR:provider-failure", () => {
        const text = "service unavailable";
        expect(
            classifyDreamerRun(
                input({
                    rawManifest: text,
                    childMessages: assistantMessages(text, {
                        tokens: { output: 2, reasoning: 0 },
                    }),
                }),
            ),
        ).toMatchObject({ status: "ERROR", reason: "provider-failure" });
    });

    test("completed invocation on another model is ERROR:fallback-engaged", () => {
        expect(
            classifyDreamerRun(
                input({
                    invocation: {
                        status: "completed",
                        providerId: "anthropic",
                        modelId: "claude-fallback",
                    },
                }),
            ),
        ).toMatchObject({ status: "ERROR", reason: "fallback-engaged" });
    });

    test("verify result mode mismatch is ERROR:wrong-result-mode", () => {
        expect(
            classifyDreamerRun(
                input({
                    task: "verify-broad",
                    gold: dreamerScorerFixture.verifyGold,
                    expectedResultMode: "broad",
                    actualResultMode: "incremental",
                }),
            ),
        ).toMatchObject({ status: "ERROR", reason: "wrong-result-mode" });
    });

    test("stale apply receipt is infra while stale rejection receipt is invalid output", () => {
        const staleReceipt = {
            affectedClaimIds: ["claim-one"],
            operationKey: "apply:one",
            outcome: "stale",
            requestDigest: "a".repeat(64),
        };
        expect(
            classifyDreamerRun(input({ receipts: [staleReceipt] })),
        ).toMatchObject({ status: "ERROR", reason: "apply-not-applied" });
        expect(
            classifyDreamerRun(
                input({
                    rawManifest: "not XML",
                    childMessages: assistantMessages("not XML"),
                    receipts: [
                        { ...staleReceipt, requestDigest: "b".repeat(64) },
                    ],
                }),
            ),
        ).toMatchObject({ status: "FAIL", reason: "invalid-output" });
    });

    test("fixture drift, child mismatch, and lease loss remain ERROR", () => {
        expect(classifyDreamerRun(input({ fixtureUnchanged: false }))).toMatchObject({
            status: "ERROR",
            reason: "fixture-drift",
        });
        expect(classifyDreamerRun(input({ childCount: 0 }))).toMatchObject({
            status: "ERROR",
            reason: "harness-failure",
        });
        expect(classifyDreamerRun(input({ leaseLost: true }))).toMatchObject({
            status: "ERROR",
            reason: "lease-lost",
        });
    });

    test("runner import does not mutate keep-subagents", () => {
        expect(shouldKeepSubagents()).toBe(false);
    });

    test("pool end state reconstructs from report snapshots without a database", () => {
        const after = dreamerScorerFixture.pool.claims.map((claim, index) => ({
            ...claim,
            importance: index === 0 ? 91 : claim.importance,
        }));
        expect(reconstructPoolEndState({ poolAfter: after })).toEqual(after);
    });

    test("reads one receipt record with only its actual affected claims", () => {
        const db = createDirectTestDatabase().db;
        try {
            const first = seedProjectMemoryClaim(db, {
                projectIdentity: "dir:/tmp/dreamer-receipt-test",
                content: "First receipt claim.",
                operationKey: "seed:first",
            });
            const second = seedProjectMemoryClaim(db, {
                projectIdentity: "dir:/tmp/dreamer-receipt-test",
                content: "Second receipt claim.",
                operationKey: "seed:second",
            });
            const row = db.prepare(
                `SELECT claims.id AS claimId, claims.project_id AS projectId,
                        claims.current_revision_id AS revisionId
                   FROM claims
                   JOIN claim_public_ids ON claim_public_ids.claim_id = claims.id
                  WHERE claim_public_ids.public_id = ?`,
            ).get(first.publicClaimId) as { claimId: number; projectId: number; revisionId: number };
            const insertReceipt = db.prepare(
                `INSERT INTO claim_operation_receipts
                    (producer, operation_key, request_digest, request_encoding_version,
                     result_encoding_version, outcome, expected_effect_count,
                     effect_summary_json, generation_vector_json, result_json, created_at)
                 VALUES (?, ?, ?, 1, 1, ?, ?, '[]', '{}', '{}', 1)`,
            );
            const applied = insertReceipt.run(
                "dreamer-classify-memories",
                "apply:one",
                "a".repeat(64),
                "applied",
                1,
            );
            db.prepare(
                `INSERT INTO claim_operation_effects
                    (receipt_id, effect_key, project_id, claim_id, revision_id,
                     change_kind, generation, created_at)
                 VALUES (?, 'effect:one', ?, ?, ?, 'applicability', 1, 1)`,
            ).run(Number(applied.lastInsertRowid), row.projectId, row.claimId, row.revisionId);
            insertReceipt.run(
                "dreamer-classify-memories",
                "reject:one",
                "b".repeat(64),
                "stale",
                0,
            );

            expect(
                readDreamerReceipts(db, "classify-memories", {
                    "claim-one": first.publicClaimId,
                    "claim-two": second.publicClaimId,
                }),
            ).toEqual([
                {
                    requestDigest: "a".repeat(64),
                    operationKey: "apply:one",
                    outcome: "applied",
                    affectedClaimIds: ["claim-one"],
                },
                {
                    requestDigest: "b".repeat(64),
                    operationKey: "reject:one",
                    outcome: "stale",
                    affectedClaimIds: [],
                },
            ]);
        } finally {
            db.close();
        }
    });
});
