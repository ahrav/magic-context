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

function claim(claimId: string, publicClaimId: string) {
    return {
        ...report(0).poolBefore[0]!,
        claimId,
        publicClaimId,
        revisionLocator: `${publicClaimId}@1`,
    };
}

function transformReport(
    index: number,
    task: "map-memories" | "classify-memories",
    parsedManifest: unknown[],
): DreamerEvalRunReport {
    return {
        ...report(index),
        task,
        poolBefore: [claim("claim-a", "mcm_a"), claim("claim-b", "mcm_b")],
        parsedManifest,
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
                observedRuns: 3,
                missingRuns: 0,
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
            observedRuns: 3,
            missingRuns: 0,
        });
    });

    test("map histograms sort files and claims without mutating report manifests", () => {
        const firstManifest = [
            { publicClaimId: "mcm_b", files: ["z.ts", "a.ts"], independent: false },
            { publicClaimId: "mcm_a", independent: true },
        ];
        const artifact = aggregateDreamerEvalVariance([
            transformReport(1, "map-memories", firstManifest),
            transformReport(2, "map-memories", [
                { publicClaimId: "mcm_a", independent: true },
                { publicClaimId: "mcm_b", files: ["a.ts", "z.ts"], independent: false },
            ]),
        ]);

        expect(artifact.claimHistograms).toEqual([
            { claimId: "claim-a", counts: { independent: 2 }, disagreement: false, observedRuns: 2, missingRuns: 0 },
            { claimId: "claim-b", counts: { "files:a.ts,z.ts": 2 }, disagreement: false, observedRuns: 2, missingRuns: 0 },
        ]);
        expect(firstManifest[0]!.files).toEqual(["z.ts", "a.ts"]);
    });

    test("classify histograms cover two claims and expose sparse observations", () => {
        const artifact = aggregateDreamerEvalVariance([
            transformReport(1, "classify-memories", [
                { publicClaimId: "mcm_a", importance: 50, scope: "project", shareable: false },
                { publicClaimId: "mcm_b", importance: 80, scope: "universe", shareable: true },
            ]),
            transformReport(2, "classify-memories", [
                { publicClaimId: "mcm_a", importance: 50, scope: "project", shareable: false },
            ]),
        ]);

        expect(artifact.claimHistograms).toEqual([
            {
                claimId: "claim-a",
                counts: { "importance:50;scope:project;shareable:false": 2 },
                disagreement: false,
                observedRuns: 2,
                missingRuns: 0,
            },
            {
                claimId: "claim-b",
                counts: { "importance:80;scope:universe;shareable:true": 1 },
                disagreement: false,
                observedRuns: 1,
                missingRuns: 1,
            },
        ]);
    });

    test("mixed system tuples are rejected", () => {
        const changed = report(2);
        changed.system = { ...changed.system, modelId: "anthropic/other" };

        expect(() => aggregateDreamerEvalVariance([report(1), changed])).toThrow(
            "variance reports must share one system tuple",
        );
    });

    test("empty, scenario-mismatched, and task-mismatched report sets are rejected", () => {
        expect(() => aggregateDreamerEvalVariance([])).toThrow("variance requires at least one report");
        expect(() =>
            aggregateDreamerEvalVariance([report(1), { ...report(2), scenarioId: "dme-other-pool" }]),
        ).toThrow("variance reports must share one scenario and task");
        expect(() =>
            aggregateDreamerEvalVariance([report(1), { ...report(2), task: "verify-broad" }]),
        ).toThrow("variance reports must share one scenario and task");
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
