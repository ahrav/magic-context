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
                counts: { "verified;files:src/cache.ts": 3 },
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
            counts: { archive: 1, "verified;files:src/cache.ts": 2 },
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

    test("a reordered system tuple is the same system", () => {
        const reordered = report(2);
        // Same five fields, rebuilt in another key order — what a report that
        // round-tripped through a different serializer carries.
        reordered.system = {
            parserImpl: system.parserImpl,
            modelId: system.modelId,
            opencodeVersion: system.opencodeVersion,
            bunVersion: system.bunVersion,
            repoCommitSha: system.repoCommitSha,
        };

        expect(() => aggregateDreamerEvalVariance([report(1), reordered])).not.toThrow();
    });

    test("a repeat with no verdict for a claim is counted, not dropped", () => {
        const lost = report(3);
        lost.status = "ERROR";
        lost.reason = "provider-failure";
        lost.rawManifest = null;
        lost.parsedManifest = null;

        const artifact = aggregateDreamerEvalVariance([report(1), report(2), lost]);

        expect(artifact.repeatCount).toBe(3);
        expect(artifact.claimHistograms).toEqual([
            { claimId: "claim-cache", counts: { missing: 1, "verified;files:src/cache.ts": 2 }, disagreement: true },
        ]);
    });

    test("a claim missing from every repeat still appears in the artifact", () => {
        const lost = (index: number): DreamerEvalRunReport => {
            const entry = report(index);
            entry.status = "ERROR";
            entry.reason = "provider-failure";
            entry.rawManifest = null;
            entry.parsedManifest = null;
            return entry;
        };

        const artifact = aggregateDreamerEvalVariance([lost(1), lost(2)]);

        expect(artifact.claimHistograms).toEqual([
            { claimId: "claim-cache", counts: { missing: 2 }, disagreement: false },
        ]);
    });

    test("duplicate mapped paths do not read as a different verdict", () => {
        const mapReport = (index: number, files: string[]): DreamerEvalRunReport => {
            const entry = report(index);
            entry.task = "map-memories";
            entry.parsedManifest = [{ publicClaimId: "mcm_claim", files, independent: false }];
            return entry;
        };

        const artifact = aggregateDreamerEvalVariance([
            mapReport(1, ["src/cache.ts"]),
            mapReport(2, ["src/cache.ts", "src/cache.ts"]),
        ]);

        expect(artifact.claimHistograms).toEqual([
            {
                claimId: "claim-cache",
                counts: { "independent:false;files:src/cache.ts": 2 },
                disagreement: false,
            },
        ]);
    });

    test("equivalent path spellings do not read as a different mapping", () => {
        const mapReport = (index: number, files: string[]): DreamerEvalRunReport => {
            const entry = report(index);
            entry.task = "map-memories";
            entry.parsedManifest = [{ publicClaimId: "mcm_claim", files, independent: false }];
            return entry;
        };

        // `scoreMapManifest` canonicalizes before comparing, so these two runs
        // record the same tracked mapping and the artifact must agree.
        const artifact = aggregateDreamerEvalVariance([
            mapReport(1, ["src/cache.ts"]),
            mapReport(2, ["src/./cache.ts"]),
        ]);

        expect(artifact.claimHistograms).toEqual([
            {
                claimId: "claim-cache",
                counts: { "independent:false;files:src/cache.ts": 2 },
                disagreement: false,
            },
        ]);
    });

    test("verify repeats sharing a verdict but not a payload disagree", () => {
        const verifyReport = (index: number, files: string[]): DreamerEvalRunReport => {
            const entry = report(index);
            entry.parsedManifest = {
                verified: [{ publicClaimId: "mcm_claim", files }],
                updated: [],
                archived: [],
            };
            return entry;
        };

        // scoreVerifyManifest judges a retained claim's file set, so one repeat
        // can pass while the other fails wrong-mapping. The verdict word alone
        // reported both as unanimous.
        const artifact = aggregateDreamerEvalVariance([
            verifyReport(1, ["src/cache.ts"]),
            verifyReport(2, ["src/cache.ts", "src/other.ts"]),
        ]);

        expect(artifact.claimHistograms[0]).toMatchObject({ disagreement: true });
        expect(Object.keys(artifact.claimHistograms[0]!.counts).sort()).toEqual([
            "verified;files:src/cache.ts",
            "verified;files:src/cache.ts,src/other.ts",
        ]);
    });

    test("update repeats differ by replacement body, not by whitespace or case", () => {
        const updateReport = (index: number, content: string): DreamerEvalRunReport => {
            const entry = report(index);
            entry.parsedManifest = {
                verified: [],
                updated: [{ publicClaimId: "mcm_claim", files: ["src/cache.ts"], content }],
                archived: [],
            };
            return entry;
        };

        // The scorer matches anchors against the trimmed, lowercased body, so
        // these two are one applied state.
        expect(
            aggregateDreamerEvalVariance([
                updateReport(1, "Cache holds 4096 entries."),
                updateReport(2, "  cache holds 4096 entries.  "),
            ]).claimHistograms[0],
        ).toMatchObject({ disagreement: false });

        // A different body is a different stored content, which is real variance.
        expect(
            aggregateDreamerEvalVariance([
                updateReport(1, "Cache holds 4096 entries."),
                updateReport(2, "Cache holds 2048 entries."),
            ]).claimHistograms[0],
        ).toMatchObject({ disagreement: true });
    });

    test("a partial classification resolves omitted fields like the scorer does", () => {
        const classifyReport = (index: number, entry: Record<string, unknown>): DreamerEvalRunReport => {
            const built = report(index);
            built.task = "classify-memories";
            built.parsedManifest = [{ publicClaimId: "mcm_claim", ...entry }];
            return built;
        };

        // poolBefore holds importance 70, scope project, sharing private. One run
        // states every field, the other omits the two it leaves unchanged; both
        // apply the same classification, so the artifact must not call it variance.
        const artifact = aggregateDreamerEvalVariance([
            classifyReport(1, { importance: 90, scope: "project", shareable: false }),
            classifyReport(2, { importance: 90 }),
        ]);

        expect(artifact.claimHistograms).toEqual([
            {
                claimId: "claim-cache",
                counts: { "importance:90;scope:project;shareable:false": 2 },
                disagreement: false,
            },
        ]);
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
