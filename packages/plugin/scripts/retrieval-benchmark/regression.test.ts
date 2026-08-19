import { describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { METRIC_POLICY_VERSION } from "./metrics";
import {
    aaMechanicalCheck,
    buildLatencyBaseline,
    buildQualityBaseline,
    evaluateRegression,
    type HostEvidence,
    loadBaselineFile,
    loadRegressionPolicyFile,
    medianOfThree,
    parseRegressionPolicy,
    publishBaseline,
    type QualityBaselineArtifact,
    RegressionError,
    regressionPolicyFingerprint,
    runLevelP95,
    tsAudit,
} from "./regression";
import { type BenchmarkReport, parseReport, REPORT_SCHEMA_VERSION } from "./report";
import { summarizeLatency, TIMING_POLICY_VERSION } from "./timing";

const FP = "a".repeat(64);
const HOST_A = "1".repeat(64);
const HOST_B = "2".repeat(64);
const BASELINE_FIXTURE_DIR = join(
    import.meta.dir,
    "..",
    "fixtures",
    "retrieval-benchmark",
    "baselines",
    "v1",
);

function policyObject(overrides: { maxAverageLossPoints?: number } = {}) {
    return {
        schemaVersion: "retrieval-benchmark-regression-policy/v1",
        id: "policy-test",
        description: "test policy with KTD17 values",
        runsRequired: 3,
        quality: {
            partition: "holdout",
            appliedPerMode: true,
            metrics: ["ndcgAt10", "recallAt50"],
            maxAverageLossPoints: overrides.maxAverageLossPoints ?? 2,
            maxSingleRunLossPoints: 5,
        },
        latency: {
            percentileRule: TIMING_POLICY_VERSION,
            runLevelP95Input: "raw-request-samples",
            runAggregation: "median-of-run-p95",
            maxMedianP95Percent: 110,
        },
    };
}

const POLICY = parseRegressionPolicy(policyObject());

interface ModeSpec {
    ndcgAt10: number;
    recallAt50: number;
}

interface RunSpec {
    salt: string;
    explicit?: ModeSpec;
    automatic?: ModeSpec;
    /** Each `cells` entry supplies raw latency samples for that case's
     *  explicit scenario. */
    cells?: Record<string, number[]>;
    hostFp?: string | null;
    config?: Record<string, unknown>;
    releaseFp?: string;
    /** When enabled, automatic scenarios set gated metrics to null,
     *  leaving automatic mode without a scoreable holdout aggregate. */
    unscoreableAutomatic?: boolean;
    status?: "complete" | "incomplete";
}

function makeRun(spec: RunSpec): BenchmarkReport {
    const explicit = spec.explicit ?? { ndcgAt10: 0.8, recallAt50: 0.8 };
    const automatic = spec.automatic ?? explicit;
    const cells = spec.cells ?? { "case-a": [10] };
    const releaseFp = spec.releaseFp ?? FP;
    const hostFp = spec.hostFp === undefined ? HOST_A : spec.hostFp;

    const scenario = (caseId: string, mode: "explicit" | "automatic", values: ModeSpec) => {
        const unscoreable = mode === "automatic" && spec.unscoreableAutomatic === true;
        return {
            queryId: `${caseId}:q-${mode}`,
            mode,
            partition: "holdout" as const,
            paraphraseGroup: `pg-${caseId}-${mode}`,
            rankedPhysical: ["memory:1"],
            deliveredPhysical: ["memory:1"],
            deliveredTokens: 100,
            deliveryReason: "delivered" as const,
            latencySamplesMs: mode === "explicit" ? cells[caseId] : [],
            metrics: {
                metricPolicyVersion: METRIC_POLICY_VERSION,
                recallAt10: unscoreable ? null : values.recallAt50,
                recallAt50: unscoreable ? null : values.recallAt50,
                reciprocalRank: 1,
                ndcgAt10: unscoreable ? null : values.ndcgAt10,
                duplicateRateAt50: 0,
                contextTokensPerUsefulResult: null,
                rerankerLift: { status: "not_applicable" as const },
                coverageAt50: {
                    judged: unscoreable ? 0 : 1,
                    unjudged: unscoreable ? 1 : 0,
                    unresolved: 0,
                    duplicates: 0,
                    total: 1,
                },
            },
            timing: null,
        };
    };

    const caseIds = Object.keys(cells);
    return parseReport({
        schemaVersion: REPORT_SCHEMA_VERSION,
        status: spec.status ?? "complete",
        semantic: {
            metricPolicyVersion: METRIC_POLICY_VERSION,
            timingPolicyVersion: TIMING_POLICY_VERSION,
            releaseFingerprints: {
                corpus: releaseFp,
                judgments: releaseFp,
                syntheticProfiles: releaseFp,
                manifest: releaseFp,
            },
            config: spec.config ?? {
                harness: "regression-test/v1",
                profileFingerprint: FP,
                instrumentation: { reportSchemaVersion: REPORT_SCHEMA_VERSION },
            },
        },
        evidence: {
            attempts: [
                {
                    attemptId: "attempt-1",
                    status: "completed",
                    startedAtEpochMs: 1_755_000_000_000,
                    endedAtEpochMs: 1_755_000_060_000,
                    workingDirectory: `/tmp/${spec.salt}`,
                    diagnostics: hostFp === null ? [] : [`host:${hostFp}`],
                },
            ],
            scenarios: caseIds.flatMap((caseId) => [
                scenario(caseId, "explicit", explicit),
                scenario(caseId, "automatic", automatic),
            ]),
            cases: caseIds.map((caseId) => ({
                caseId,
                workerCount: 1,
                warmups: 0,
                samplesPerQuery: 1,
                fixture: { manifestFingerprint: FP, indexBuildMs: 1, snapshotBytes: 1 },
                selectivityObserved: { preFilterDenominator: 1, eligibleCount: 1 },
                cacheLayers: [],
                laneRestricted: false,
                // Mirrors the runner: a case with samples records their
                // summary; the A/A mechanical check cross-verifies this
                // recorded p95 against its own recomputation.
                latencySummary:
                    (cells[caseId] ?? []).length > 0
                        ? (() => {
                              const summary = summarizeLatency(cells[caseId] ?? []);
                              return {
                                  timingPolicyVersion: summary.timingPolicyVersion,
                                  sampleCount: summary.sampleCount,
                                  p50Ms: summary.p50Ms,
                                  p95Ms: summary.p95Ms,
                              };
                          })()
                        : null,
            })),
        },
        candidatePool: {
            schemaVersion: "retrieval-benchmark-candidate-pool/v1",
            consumer: "magic-context-u51",
            topK: 50,
            entries: [],
        },
    });
}

function threeRuns(prefix: string, spec: Omit<RunSpec, "salt"> = {}): BenchmarkReport[] {
    return [1, 2, 3].map((i) => makeRun({ salt: `${prefix}-${i}`, ...spec }));
}

function candidateRuns(values: [number, number, number], prefix = "cand"): BenchmarkReport[] {
    return values.map((value, i) =>
        makeRun({
            salt: `${prefix}-${i + 1}`,
            explicit: { ndcgAt10: value, recallAt50: value },
        }),
    );
}

function qualityBaseline(
    overrides: {
        claimEligibility?: "judged-support-only" | "measured-win-eligible";
        reports?: BenchmarkReport[];
    } = {},
): QualityBaselineArtifact {
    return buildQualityBaseline({
        policy: POLICY,
        reports: overrides.reports ?? threeRuns("base"),
        claimEligibility: overrides.claimEligibility ?? "judged-support-only",
    });
}

function hostEvidence(over: Partial<HostEvidence> = {}): HostEvidence {
    return {
        hostFingerprint: HOST_A,
        exclusiveRunLock: true,
        canary: { pre: "stable", post: "stable" },
        affinity: "cpus-0-3",
        numa: "node0",
        power: "performance",
        cache: "controlled",
        ...over,
    };
}

function latencyBaseline(cells: Record<string, number[]> = { "case-a": [10] }) {
    return buildLatencyBaseline({
        policy: POLICY,
        reports: threeRuns("lat-base", { cells }),
        hostClass: "x86-avx2",
        hostEvidence: [hostEvidence(), hostEvidence(), hostEvidence()],
    });
}

describe("quality boundaries (scenario 1)", () => {
    it("passes an average loss of exactly 2 points and fails a larger one", () => {
        const baseline = qualityBaseline();
        const pass = evaluateRegression({
            policy: POLICY,
            baseline,
            candidates: candidateRuns([0.78, 0.78, 0.78]),
        });
        expect(pass.verdict).toBe("quality-only");
        expect(pass.quality.every((finding) => finding.pass)).toBe(true);

        const fail = evaluateRegression({
            policy: POLICY,
            baseline,
            candidates: candidateRuns([0.77, 0.77, 0.77]),
        });
        expect(fail.verdict).toBe("policy-fail");
        expect(fail.reasons.some((reason) => reason.startsWith("quality:"))).toBe(true);
    });

    it("fails the 5-point single-run floor even when the mean passes", () => {
        const result = evaluateRegression({
            policy: POLICY,
            baseline: qualityBaseline(),
            candidates: candidateRuns([0.8, 0.8, 0.74]),
        });
        expect(result.verdict).toBe("policy-fail");
        const explicitNdcg = result.quality.find(
            (finding) => finding.mode === "explicit" && finding.metric === "ndcgAt10",
        );
        expect(explicitNdcg?.averageLossPoints).toBeCloseTo(2, 6);
        expect(explicitNdcg?.worstRunLossPoints).toBeCloseTo(6, 6);
    });

    it("applies the gates separately per mode", () => {
        const candidates = [1, 2, 3].map((i) =>
            makeRun({
                salt: `mode-${i}`,
                explicit: { ndcgAt10: 0.8, recallAt50: 0.8 },
                automatic: { ndcgAt10: 0.7, recallAt50: 0.7 },
            }),
        );
        const result = evaluateRegression({
            policy: POLICY,
            baseline: qualityBaseline(),
            candidates,
        });
        expect(result.verdict).toBe("policy-fail");
        expect(
            result.quality
                .filter((finding) => finding.mode === "explicit")
                .every((finding) => finding.pass),
        ).toBe(true);
        expect(
            result.quality
                .filter((finding) => finding.mode === "automatic")
                .some((finding) => !finding.pass),
        ).toBe(true);
    });

    it("requires exactly three distinct complete candidate run IDs", () => {
        const baseline = qualityBaseline();
        const two = evaluateRegression({
            policy: POLICY,
            baseline,
            candidates: candidateRuns([0.8, 0.8, 0.8]).slice(0, 2),
        });
        expect(two.verdict).toBe("incomplete");

        const run = makeRun({ salt: "dup" });
        const duplicated = evaluateRegression({
            policy: POLICY,
            baseline,
            candidates: [run, run, run],
        });
        expect(duplicated.verdict).toBe("incomplete");

        const incomplete = evaluateRegression({
            policy: POLICY,
            baseline,
            candidates: [
                makeRun({ salt: "i1" }),
                makeRun({ salt: "i2" }),
                makeRun({ salt: "i3", status: "incomplete" }),
            ],
        });
        expect(incomplete.verdict).toBe("incomplete");
    });

    it("returns invalid-evidence when a baseline mode has no scoreable candidate aggregate", () => {
        const result = evaluateRegression({
            policy: POLICY,
            baseline: qualityBaseline(),
            candidates: [
                makeRun({ salt: "u1", unscoreableAutomatic: true }),
                makeRun({ salt: "u2" }),
                makeRun({ salt: "u3" }),
            ],
        });
        expect(result.verdict).toBe("invalid-evidence");
        expect(result.reasons.some((reason) => reason.includes("automatic"))).toBe(true);
    });
});

describe("latency median-of-three p95 (scenario 2)", () => {
    function evaluateLatency(cellSamples: [number[], number[], number[]]) {
        return evaluateRegression({
            policy: POLICY,
            baseline: qualityBaseline(),
            candidates: cellSamples.map((samples, i) =>
                makeRun({ salt: `lat-${i + 1}`, cells: { "case-a": samples } }),
            ),
            latency: {
                baseline: latencyBaseline(),
                candidateHostEvidence: [hostEvidence(), hostEvidence(), hostEvidence()],
            },
        });
    }

    it("passes a candidate/baseline median ratio of exactly 1.10 and fails a larger one", () => {
        const pass = evaluateLatency([[9], [11], [13]]);
        expect(pass.verdict).toBe("pass");
        expect(pass.latency.status).toBe("compared");
        expect(pass.latency.cells[0]?.candidateMedianP95Ms).toBe(11);
        expect(pass.latency.cells[0]?.baselineMedianP95Ms).toBe(10);

        const fail = evaluateLatency([[9], [11.2], [13]]);
        expect(fail.verdict).toBe("policy-fail");
        expect(fail.reasons.some((reason) => reason.startsWith("latency:"))).toBe(true);
    });

    it("reduces three run-level p95 values to their median, never their mean", () => {
        const result = evaluateLatency([[1], [11], [100]]);
        expect(result.latency.cells[0]?.candidateMedianP95Ms).toBe(11);
        expect(result.verdict).toBe("pass");
        expect(medianOfThree([100, 1, 11])).toBe(11);
    });
});

describe("latency policy inputs (scenario 3)", () => {
    it("accepts only raw request samples per run", () => {
        expect(runLevelP95({ kind: "raw-request-samples", samplesMs: [3, 1, 2] })).toBe(3);
        expect(() => runLevelP95({ kind: "pooled-samples", samplesMs: [1, 2, 3] })).toThrow(
            RegressionError,
        );
        expect(() => runLevelP95({ kind: "averaged-worker-p95s", p95sMs: [5, 6] })).toThrow(
            /rejected as policy input/,
        );
        expect(() => runLevelP95({ kind: "averaged-query-p95s", p95sMs: [5, 6] })).toThrow(
            /rejected as policy input/,
        );
    });
});

describe("host mismatch and canary drift (scenario 4)", () => {
    it("host fingerprint mismatch yields quality-only, never a latency or full-gate pass", () => {
        const result = evaluateRegression({
            policy: POLICY,
            baseline: qualityBaseline(),
            candidates: threeRuns("other-host", { hostFp: HOST_B }),
            latency: {
                baseline: latencyBaseline(),
                candidateHostEvidence: [
                    hostEvidence({ hostFingerprint: HOST_B }),
                    hostEvidence({ hostFingerprint: HOST_B }),
                    hostEvidence({ hostFingerprint: HOST_B }),
                ],
            },
            latencyRequired: true,
        });
        expect(result.verdict).toBe("quality-only");
        expect(result.latency.status).toBe("non-comparable");
        expect(result.gate.unblocked).toBe(false);
    });

    it("a failed pre/post canary makes latency non-comparable but quality survives", () => {
        const result = evaluateRegression({
            policy: POLICY,
            baseline: qualityBaseline(),
            candidates: threeRuns("canary"),
            latency: {
                baseline: latencyBaseline(),
                candidateHostEvidence: [
                    hostEvidence(),
                    hostEvidence({ canary: { pre: "stable", post: "failed" } }),
                    hostEvidence(),
                ],
            },
        });
        expect(result.verdict).toBe("quality-only");
        expect(result.reasons.some((reason) => reason.includes("canary"))).toBe(true);
        expect(result.gate.unblocked).toBe(true);
    });

    it("quality-only cannot unblock a latency-requiring gate, even without a latency baseline", () => {
        const withGate = evaluateRegression({
            policy: POLICY,
            baseline: qualityBaseline(),
            candidates: threeRuns("no-lat"),
            latencyRequired: true,
        });
        expect(withGate.verdict).toBe("quality-only");
        expect(withGate.gate.unblocked).toBe(false);
    });
});

describe("fingerprint invalidation (scenario 5)", () => {
    it("a release change makes the baseline non-comparable", () => {
        const result = evaluateRegression({
            policy: POLICY,
            baseline: qualityBaseline(),
            candidates: threeRuns("rel", { releaseFp: "b".repeat(64) }),
        });
        expect(result.verdict).toBe("non-comparable");
    });

    it("a behavior-contract change makes the baseline non-comparable", () => {
        const result = evaluateRegression({
            policy: POLICY,
            baseline: qualityBaseline(),
            candidates: threeRuns("beh", {
                config: {
                    harness: "regression-test/v2",
                    profileFingerprint: FP,
                    instrumentation: { reportSchemaVersion: REPORT_SCHEMA_VERSION },
                },
            }),
        });
        expect(result.verdict).toBe("non-comparable");
    });

    it("a tolerance change opens a new policy and invalidates the old baseline", () => {
        const loosened = parseRegressionPolicy(policyObject({ maxAverageLossPoints: 3 }));
        const result = evaluateRegression({
            policy: loosened,
            baseline: qualityBaseline(),
            candidates: threeRuns("pol"),
        });
        expect(result.verdict).toBe("non-comparable");
        expect(result.reasons.some((reason) => reason.startsWith("policy:"))).toBe(true);
    });
});

describe("baseline publication (scenario 6)", () => {
    function snapshot(dir: string): Map<string, string> {
        return new Map(
            readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), "utf8")]),
        );
    }

    it("publishes atomically, reloads through the strict schema, and refuses overwrite", () => {
        const dir = mkdtempSync(join(tmpdir(), "rb-baseline-"));
        const outPath = join(dir, "quality.json");
        publishBaseline(qualityBaseline(), outPath);
        const reloaded = loadBaselineFile(outPath);
        expect(reloaded.kind).toBe("quality");
        expect(reloaded.policyFingerprint).toBe(regressionPolicyFingerprint(POLICY));

        const before = snapshot(dir);
        expect(() =>
            publishBaseline(
                qualityBaseline({ claimEligibility: "measured-win-eligible" }),
                outPath,
            ),
        ).toThrow(/refuse-overwrite/);
        expect(snapshot(dir)).toEqual(before);
        expect(readdirSync(dir)).toEqual(["quality.json"]);
    });

    it("refuses partial evidence", () => {
        expect(() =>
            qualityBaseline({
                reports: [
                    makeRun({ salt: "p1" }),
                    makeRun({ salt: "p2" }),
                    makeRun({ salt: "p3", status: "incomplete" }),
                ],
            }),
        ).toThrow(/not complete/);
    });

    it("refuses mixed hosts for a latency baseline", () => {
        expect(() =>
            buildLatencyBaseline({
                policy: POLICY,
                reports: [
                    makeRun({ salt: "m1" }),
                    makeRun({ salt: "m2", hostFp: HOST_B }),
                    makeRun({ salt: "m3" }),
                ],
                hostClass: "x86-avx2",
                hostEvidence: [
                    hostEvidence(),
                    hostEvidence({ hostFingerprint: HOST_B }),
                    hostEvidence(),
                ],
            }),
        ).toThrow(/mixed hosts/);
    });
});

describe("A/A mechanical check (scenario 7)", () => {
    it("exercises both labels over one artifact and reports mechanical integrity, not policy", () => {
        const result = aaMechanicalCheck({
            policy: POLICY,
            report: makeRun({ salt: "aa", cells: { "case-a": [5, 6, 7] } }),
        });
        expect(result.kind).toBe("mechanical-integrity");
        expect(result.status).toBe("ok");
        expect(result.verdictUnderPolicy).toBe("quality-only");
        expect(result.maxAbsAverageLossPoints).toBe(0);
        expect(result.runValuesExact).toBe(true);
        expect(result.maxAbsRunLossPoints).toBeLessThan(1e-9);
        expect(result.latencyCellsChecked).toBe(1);
        expect(result.interpretation).toContain("not a noise floor");
    });
});

describe("TS-only audit (scenario 8)", () => {
    it("records quality_target not_specified and the 25 ms latency comparison", () => {
        const slow = tsAudit({
            reports: threeRuns("slow", { cells: { "case-audit": [30] } }),
            auditCaseIds: ["case-audit"],
        });
        expect(slow.quality_target).toBe("not_specified");
        expect(slow.latency_target).toBe("not_met");
        expect(slow.latency.medianRunP95Ms).toBe(30);

        const fast = tsAudit({
            reports: threeRuns("fast", { cells: { "case-audit": [20] } }),
            auditCaseIds: ["case-audit"],
        });
        expect(fast.latency_target).toBe("met");

        const missing = tsAudit({ reports: threeRuns("none"), auditCaseIds: [] });
        expect(missing.latency_target).toBe("not_evaluated");
        expect(missing.latency.medianRunP95Ms).toBeNull();
    });

    it("rejects more than one audit case rather than pooling samples across cells", () => {
        expect(() =>
            tsAudit({
                reports: threeRuns("multi", { cells: { "case-a": [10], "case-b": [20] } }),
                auditCaseIds: ["case-a", "case-b"],
            }),
        ).toThrow(/supply at most one audit case id/);
    });

    it("never feeds the regression verdict", () => {
        const result = evaluateRegression({
            policy: POLICY,
            baseline: qualityBaseline({
                reports: threeRuns("audit-base", { cells: { "case-audit": [30] } }),
            }),
            candidates: threeRuns("audit-cand", { cells: { "case-audit": [30] } }),
            auditCaseIds: ["case-audit"],
        });
        expect(result.audit.latency_target).toBe("not_met");
        expect(result.verdict).toBe("quality-only");
        expect(result.gate.unblocked).toBe(true);
    });
});

describe("sparse-v1 claim eligibility (scenario 9)", () => {
    it("supports judged-support regression verdicts but returns needs_judgment for measured-win claims", () => {
        const baseline = qualityBaseline({ claimEligibility: "judged-support-only" });
        const regression = evaluateRegression({
            policy: POLICY,
            baseline,
            candidates: threeRuns("claim-reg"),
            claim: "regression",
        });
        expect(regression.verdict).toBe("quality-only");

        const win = evaluateRegression({
            policy: POLICY,
            baseline,
            candidates: threeRuns("claim-win"),
            claim: "measured-win",
        });
        expect(win.verdict).toBe("needs_judgment");
        expect(win.gate.unblocked).toBe(false);
    });

    it("a measured-win-eligible replacement baseline proceeds past the eligibility gate", () => {
        const result = evaluateRegression({
            policy: POLICY,
            baseline: qualityBaseline({ claimEligibility: "measured-win-eligible" }),
            candidates: threeRuns("claim-ok"),
            claim: "measured-win",
        });
        expect(result.verdict).toBe("quality-only");
    });
});

describe("checked-in policy and baseline artifacts", () => {
    it("reload through the strict schemas and stay mutually bound", () => {
        const policy = loadRegressionPolicyFile(join(BASELINE_FIXTURE_DIR, "policy.json"));
        expect(policy.quality.maxAverageLossPoints).toBe(2);
        expect(policy.quality.maxSingleRunLossPoints).toBe(5);
        expect(policy.latency.maxMedianP95Percent).toBe(110);
        expect(policy.runsRequired).toBe(3);

        const baseline = loadBaselineFile(join(BASELINE_FIXTURE_DIR, "quality.json"));
        expect(baseline.kind).toBe("quality");
        if (baseline.kind !== "quality") return;
        expect(baseline.claimEligibility).toBe("judged-support-only");
        expect(baseline.policyFingerprint).toBe(regressionPolicyFingerprint(policy));
        expect(baseline.runs).toHaveLength(3);
        expect(new Set(baseline.runs.map((run) => run.evidenceDigest)).size).toBe(3);
    });
});
