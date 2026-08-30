import { describe, expect, test } from "bun:test";
import { shouldKeepSubagents } from "../../../plugin/src/shared/keep-subagents";
import { dreamerScorerFixture } from "./scorer.test";
import {
    classifyDreamerRun,
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
                        claimId: "claim-one",
                        operation: "classify-memories",
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
            claimId: "claim-one",
            operation: "classify-memories",
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
});
