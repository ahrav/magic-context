import { describe, expect, test } from "bun:test";

import { DREAMER_EVAL_REPORT_SCHEMA, type DreamerEvalRunReport, type VerifyVerdict } from "./contract";
import { aggregateDreamerEvalVariance } from "./variance";

const system = {
    repoCommitSha: "a".repeat(40),
    bunVersion: "1.3.11",
    opencodeVersion: "1.0.0",
    modelId: "anthropic/model",
    parserImpl: "ts" as const,
};

function report(index: number, verdict: VerifyVerdict = "verified"): DreamerEvalRunReport {
    const entry = { publicClaimId: "mcm_claim", files: ["src/cache.ts"] };
    return {
        schema: DREAMER_EVAL_REPORT_SCHEMA,
        scenarioId: "dme-core-pool",
        task: "verify",
        runId: `run-${index}`,
        nowMs: index,
        status: "PASS",
        reason: null,
        runFatal: false,
        system,
        poolBefore: [
            {
                claimId: "claim-cache",
                publicClaimId: "mcm_claim",
                revisionLocator: "mcm_claim@1",
                content: "Cache entries are bounded.",
                category: "CONSTRAINTS",
                importance: 70,
                memoryScope: "project",
                sharing: "private",
                lifecycleState: "active",
                files: ["src/cache.ts"],
                verificationOutcome: null,
            },
        ],
        poolAfter: [],
        rawManifest: "<verify/>",
        parsedManifest: {
            verified: verdict === "verified" ? [entry] : [],
            updated: verdict === "update" ? [{ ...entry, content: "Updated" }] : [],
            archived: verdict === "archive" ? [{ publicClaimId: entry.publicClaimId, reason: "stale" }] : [],
        },
        receiptOutcomes: [],
    };
}

describe("dreamer eval variance", () => {
    test("three agreeing reports produce one zero-disagreement histogram", () => {
        const artifact = aggregateDreamerEvalVariance([report(1), report(2), report(3)]);

        expect(artifact.claimHistograms).toEqual([
            {
                claimId: "claim-cache",
                counts: { verified: 3 },
                disagreement: false,
            },
        ]);
        expect(artifact.red).toBe(false);
        expect(artifact.runFatal).toBe(false);
    });

    test("a divergent verdict is counted for the same claim", () => {
        const artifact = aggregateDreamerEvalVariance([report(1), report(2), report(3, "archive")]);

        expect(artifact.claimHistograms[0]).toEqual({
            claimId: "claim-cache",
            counts: { archive: 1, verified: 2 },
            disagreement: true,
        });
    });

    test("mixed system tuples are rejected", () => {
        const changed = report(2);
        changed.system = { ...changed.system, modelId: "anthropic/other" };

        expect(() => aggregateDreamerEvalVariance([report(1), changed])).toThrow(
            "variance reports must share one system tuple",
        );
    });

    test("any red run marks the set red and a run-fatal report marks it run-fatal", () => {
        const failed = report(2);
        failed.status = "FAIL";
        failed.reason = "wrong-verdict";
        expect(aggregateDreamerEvalVariance([report(1), failed])).toMatchObject({
            red: true,
            runFatal: false,
        });

        failed.reason = "wrong-archival";
        failed.runFatal = true;
        expect(aggregateDreamerEvalVariance([report(1), failed])).toMatchObject({
            red: true,
            runFatal: true,
        });
    });
});
