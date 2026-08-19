import { describe, expect, it } from "bun:test";

import { ContractError } from "./contract";
import type { ResolvedRankedResult } from "./identity";
import { type JudgedGrade, METRIC_POLICY_VERSION } from "./metrics";
import {
    type BenchmarkReport,
    buildCandidatePool,
    CANDIDATE_POOL_CONSUMER,
    CANDIDATE_POOL_SCHEMA_VERSION,
    computeReportStatus,
    evidenceDigest,
    parseReport,
    passEligibility,
    REPORT_SCHEMA_VERSION,
    type ReportScenario,
    semanticFingerprint,
} from "./report";
import { TIMING_POLICY_VERSION } from "./timing";

const FP = "a".repeat(64);

function makeScenario(queryId: string): ReportScenario {
    return {
        queryId,
        mode: "explicit",
        partition: "holdout",
        paraphraseGroup: "pg-1",
        rankedPhysical: ["memory:1", "memory:2"],
        deliveredPhysical: ["memory:1"],
        deliveredTokens: 120,
        deliveryReason: "delivered",
        latencySamplesMs: [4.5, 6.25, 5.5],
        metrics: {
            metricPolicyVersion: METRIC_POLICY_VERSION,
            recallAt10: 1,
            recallAt50: 1,
            reciprocalRank: 1,
            ndcgAt10: 1,
            duplicateRateAt50: 0,
            contextTokensPerUsefulResult: 120,
            rerankerLift: { status: "not_applicable" },
            coverageAt50: { judged: 1, unjudged: 1, unresolved: 0, duplicates: 0, total: 2 },
        },
        timing: {
            timingPolicyVersion: TIMING_POLICY_VERSION,
            rootDurationMs: 95,
            coveredMs: 80,
            uncoveredMs: 15,
            inclusiveSumMs: 100,
            overlapMs: 20,
            criticalPathMs: 60,
            decodedVectorBytes: 1000,
            cachedVectorBytes: 200,
            indexBuildMs: 1234,
        },
    };
}

function makeReport(
    overrides: {
        config?: Record<string, unknown>;
        workingDirectory?: string;
        startedAtEpochMs?: number;
        status?: BenchmarkReport["status"];
    } = {},
): BenchmarkReport {
    return parseReport({
        schemaVersion: REPORT_SCHEMA_VERSION,
        status: overrides.status ?? "complete",
        semantic: {
            metricPolicyVersion: METRIC_POLICY_VERSION,
            timingPolicyVersion: TIMING_POLICY_VERSION,
            releaseFingerprints: {
                corpus: FP,
                judgments: FP,
                syntheticProfiles: FP,
                manifest: FP,
            },
            config: overrides.config ?? { profile: "ci", candidateK: 100 },
        },
        evidence: {
            attempts: [
                {
                    attemptId: "attempt-1",
                    status: "completed",
                    startedAtEpochMs: overrides.startedAtEpochMs ?? 1_700_000_000_000,
                    endedAtEpochMs: (overrides.startedAtEpochMs ?? 1_700_000_000_000) + 60_000,
                    workingDirectory: overrides.workingDirectory ?? "/tmp/bench-run-1",
                    diagnostics: [],
                },
            ],
            scenarios: [makeScenario("q-1")],
            cases: [
                {
                    caseId: "case-1",
                    workerCount: 1,
                    warmups: 1,
                    samplesPerQuery: 3,
                    fixture: {
                        manifestFingerprint: FP,
                        indexBuildMs: 250,
                        snapshotBytes: 4096,
                    },
                    selectivityObserved: { preFilterDenominator: 100, eligibleCount: 100 },
                    cacheLayers: [
                        {
                            layer: "processVector",
                            declared: "warm",
                            mechanism: "warmup-population",
                            resets: 0,
                            verifications: 3,
                            status: "verified",
                        },
                    ],
                },
            ],
        },
        candidatePool: {
            schemaVersion: CANDIDATE_POOL_SCHEMA_VERSION,
            consumer: CANDIDATE_POOL_CONSUMER,
            topK: 50,
            entries: [
                {
                    queryId: "q-1",
                    rank: 2,
                    locator: "memory:2",
                    documentId: "d-2",
                    canonicalId: "c-2",
                    status: "unjudged",
                },
            ],
        },
    });
}

describe("parseReport", () => {
    it("round-trips a valid report through the strict schema", () => {
        const report = makeReport();
        expect(parseReport(JSON.parse(JSON.stringify(report)))).toEqual(report);
    });

    it("rejects unknown fields, wrong versions, and missing evidence", () => {
        const report = makeReport();
        expect(() => parseReport({ ...report, extra: 1 })).toThrow(ContractError);
        expect(() => parseReport({ ...report, schemaVersion: "other/v9" })).toThrow(
            ContractError,
        );
        expect(() =>
            parseReport({ ...report, evidence: { ...report.evidence, attempts: [] } }),
        ).toThrow(ContractError);
    });
});

describe("fingerprints", () => {
    it("semantic fingerprint ignores object-key order", () => {
        const a = makeReport({ config: { profile: "ci", candidateK: 100 } });
        const b = makeReport({ config: { candidateK: 100, profile: "ci" } });
        expect(semanticFingerprint(a)).toBe(semanticFingerprint(b));
        expect(evidenceDigest(a)).toBe(evidenceDigest(b));
    });

    it("real-clock attempts and working directories change only the evidence digest", () => {
        const a = makeReport({
            workingDirectory: "/tmp/bench-run-aaa",
            startedAtEpochMs: 1_700_000_000_000,
        });
        const b = makeReport({
            workingDirectory: "/var/folders/xy/bench-run-bbb",
            startedAtEpochMs: 1_700_009_999_999,
        });
        expect(semanticFingerprint(a)).toBe(semanticFingerprint(b));
        expect(evidenceDigest(a)).not.toBe(evidenceDigest(b));
    });

    it("a config change moves the semantic fingerprint", () => {
        const a = makeReport({ config: { profile: "ci" } });
        const b = makeReport({ config: { profile: "arm-neon" } });
        expect(semanticFingerprint(a)).not.toBe(semanticFingerprint(b));
    });
});

describe("computeReportStatus and passEligibility", () => {
    const attempts = [{ status: "completed" as const }];

    it("is complete only when every expected scenario is present exactly once", () => {
        expect(
            computeReportStatus({
                expectedQueryIds: ["q-1", "q-2"],
                scenarios: [{ queryId: "q-1" }, { queryId: "q-2" }],
                attempts,
            }),
        ).toBe("complete");
        expect(
            computeReportStatus({
                expectedQueryIds: ["q-1", "q-2"],
                scenarios: [{ queryId: "q-1" }],
                attempts,
            }),
        ).toBe("incomplete");
        expect(
            computeReportStatus({
                expectedQueryIds: ["q-1"],
                scenarios: [{ queryId: "q-1" }, { queryId: "q-1" }],
                attempts,
            }),
        ).toBe("invalid");
    });

    it("requires at least one completed attempt", () => {
        expect(
            computeReportStatus({
                expectedQueryIds: ["q-1"],
                scenarios: [{ queryId: "q-1" }],
                attempts: [],
            }),
        ).toBe("incomplete");
        expect(
            computeReportStatus({
                expectedQueryIds: ["q-1"],
                scenarios: [{ queryId: "q-1" }],
                attempts: [{ status: "interrupted" }],
            }),
        ).toBe("incomplete");
    });

    it("never grants pass eligibility to incomplete or incompatible evidence", () => {
        expect(passEligibility({ status: "complete" }, { compatible: true })).toEqual({
            eligible: true,
            reasons: [],
        });
        expect(passEligibility({ status: "incomplete" }, { compatible: true })).toEqual({
            eligible: false,
            reasons: ["evidence:incomplete"],
        });
        expect(passEligibility({ status: "invalid" }, { compatible: true })).toEqual({
            eligible: false,
            reasons: ["evidence:invalid"],
        });
        expect(passEligibility({ status: "complete" }, { compatible: false })).toEqual({
            eligible: false,
            reasons: ["evidence:incompatible"],
        });
        expect(passEligibility({ status: "incomplete" }, { compatible: false }).eligible).toBe(
            false,
        );
    });
});

describe("buildCandidatePool", () => {
    const ranked = ["memory:1", "memory:1", "memory:2", "bogus:x"];
    const resolved: ResolvedRankedResult[] = [
        { status: "resolved", rank: 1, canonicalId: "c-1", documentId: "d-1" },
        { status: "duplicate", rank: 2, canonicalId: "c-1", documentId: "d-1" },
        { status: "resolved", rank: 3, canonicalId: "c-2", documentId: "d-2" },
        { status: "unresolved", rank: 4, reason: "malformed" },
    ];
    const judgedGrades = new Map<string, JudgedGrade>([["d-1", 2]]);

    it("emits unjudged and unresolved entries, skipping judged and duplicates", () => {
        const pool = buildCandidatePool({
            topK: 50,
            queries: [{ queryId: "q-1", ranked, resolved, judgedGrades }],
        });
        expect(pool.schemaVersion).toBe(CANDIDATE_POOL_SCHEMA_VERSION);
        expect(pool.consumer).toBe(CANDIDATE_POOL_CONSUMER);
        expect(pool.entries).toEqual([
            {
                queryId: "q-1",
                rank: 3,
                locator: "memory:2",
                documentId: "d-2",
                canonicalId: "c-2",
                status: "unjudged",
            },
            {
                queryId: "q-1",
                rank: 4,
                locator: "bogus:x",
                documentId: null,
                canonicalId: null,
                status: "unresolved",
            },
        ]);
    });

    it("applies the top-K window to the physical ranking", () => {
        const pool = buildCandidatePool({
            topK: 3,
            queries: [{ queryId: "q-1", ranked, resolved, judgedGrades }],
        });
        expect(pool.entries.map((entry) => entry.rank)).toEqual([3]);
    });

    it("rejects a ranked/resolved mismatch and a non-positive top-K", () => {
        expect(() =>
            buildCandidatePool({
                topK: 10,
                queries: [{ queryId: "q-1", ranked: ["memory:1"], resolved, judgedGrades }],
            }),
        ).toThrow(ContractError);
        expect(() => buildCandidatePool({ topK: 0, queries: [] })).toThrow(ContractError);
    });
});
