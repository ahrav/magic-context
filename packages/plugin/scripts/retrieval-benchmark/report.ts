/**
 *
 * `semantic` stores run-independent identity; `semanticFingerprint` hashes that section through canonical JSON.
 * `semanticFingerprint` uses canonical JSON, so object-key order does not change it.
 * `evidence.attempts` contains only stable terminal attempts; open attempts are excluded.
 * Raw per-scenario samples make aggregates recomputable.
 * `evidenceDigest` hashes the whole report, including evidence.
 *
 * The candidate pool is the versioned unjudged top-K artifact consumed by `magic-context-u51`.
 * `magic-context-u51` keeps unjudged results visible without treating them as negative labels.
 *
 * Incomplete or incompatible evidence cannot produce a pass.
 * `passEligibility` is the only pass gate this module exports and fails closed.
 * closed.
 */

import { z } from "zod";

import { canonicalFingerprint } from "./canonical-json";
import { ContractError } from "./contract";
import type { ResolvedRankedResult } from "./identity";
import {
    type JudgedGrade,
    type MacroAggregate,
    METRIC_POLICY_VERSION,
    macroAggregate,
} from "./metrics";
import { TIMING_POLICY_VERSION } from "./timing";

export const REPORT_SCHEMA_VERSION = "retrieval-benchmark-report/v2";
export const CANDIDATE_POOL_SCHEMA_VERSION = "retrieval-benchmark-candidate-pool/v1";
export const CANDIDATE_POOL_CONSUMER = "magic-context-u51";

const fingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/);

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
    z.union([
        z.string(),
        z.number().finite(),
        z.boolean(),
        z.null(),
        z.array(jsonValueSchema),
        z.record(z.string(), jsonValueSchema),
    ]),
);

const nullableUnitFraction = z.number().min(0).max(1).nullable();

const coverageSchema = z.strictObject({
    judged: z.number().int().nonnegative(),
    unjudged: z.number().int().nonnegative(),
    unresolved: z.number().int().nonnegative(),
    duplicates: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
});

const scenarioMetricsSchema = z.strictObject({
    metricPolicyVersion: z.literal(METRIC_POLICY_VERSION),
    recallAt10: nullableUnitFraction,
    recallAt50: nullableUnitFraction,
    reciprocalRank: z.number().min(0).max(1),
    ndcgAt10: nullableUnitFraction,
    duplicateRateAt50: nullableUnitFraction,
    contextTokensPerUsefulResult: z.number().min(0).nullable(),
    rerankerLift: z.union([
        z.strictObject({ status: z.literal("not_applicable") }),
        z.strictObject({
            status: z.literal("computed"),
            ndcgBefore: nullableUnitFraction,
            ndcgAfter: nullableUnitFraction,
            delta: z.number().min(-1).max(1).nullable(),
        }),
    ]),
    coverageAt50: coverageSchema,
});

const scenarioTimingSchema = z.strictObject({
    timingPolicyVersion: z.literal(TIMING_POLICY_VERSION),
    rootDurationMs: z.number().min(0),
    coveredMs: z.number().min(0),
    uncoveredMs: z.number().min(0),
    inclusiveSumMs: z.number().min(0),
    overlapMs: z.number().min(0),
    criticalPathMs: z.number().min(0),
    decodedVectorBytes: z.number().int().nonnegative(),
    cachedVectorBytes: z.number().int().nonnegative(),
    indexBuildMs: z.number().min(0).nullable(),
});

const scenarioSchema = z.strictObject({
    queryId: z.string().min(1),
    mode: z.enum(["explicit", "automatic"]),
    partition: z.enum(["development", "holdout"]),
    paraphraseGroup: z.string().min(1),
    /** `rankedPhysical` preserves the exact physical ranking returned by the surface. */
    rankedPhysical: z.array(z.string().min(1)),
    deliveredPhysical: z.array(z.string().min(1)),
    deliveredTokens: z.number().int().nonnegative().nullable(),
    deliveryReason: z.enum([
        "delivered",
        "empty-results",
        "packer-empty",
        "empty",
        "below-threshold",
        "timeout",
    ]),
    /** Raw per-scenario latency samples allow summaries to be recomputed. */
    latencySamplesMs: z.array(z.number().min(0)),
    queryEmbedPurpose: z.enum(["query", "passage"]).nullable(),
    metrics: scenarioMetricsSchema,
    timing: scenarioTimingSchema.nullable(),
});
export type ReportScenario = z.infer<typeof scenarioSchema>;
export type DeliveryReason = ReportScenario["deliveryReason"];

const caseEvidenceSchema = z.strictObject({
    caseId: z.string().min(1),
    workerCount: z.number().int().positive(),
    warmups: z.number().int().nonnegative(),
    samplesPerQuery: z.number().int().positive(),
    fixture: z.strictObject({
        manifestFingerprint: fingerprintSchema,
        indexBuildMs: z.number().min(0),
        snapshotBytes: z.number().int().nonnegative(),
    }),
    selectivityObserved: z.strictObject({
        preFilterDenominator: z.number().int().nonnegative(),
        eligibleCount: z.number().int().nonnegative(),
    }),
    cacheLayers: z.array(
        z.strictObject({
            layer: z.enum(["processVector", "connectionStatement", "sqlitePage", "osPage"]),
            declared: z.enum(["cold", "warm"]),
            mechanism: z.string().min(1),
            resets: z.number().int().nonnegative(),
            verifications: z.number().int().nonnegative(),
            status: z.enum(["verified", "not-attempted", "not-applicable"]),
        }),
    ),
    /** Cases whose `sourceLanes` are narrower than the mode's full source set remain diagnostic and are excluded from gate macro-averages.
     * */
    laneRestricted: z.boolean(),
    /** Diagnostic p50 and p95 are computed from the case's trace-disabled samples.
     *  the regression policy recomputes percentiles from raw samples. */
    latencySummary: z
        .strictObject({
            timingPolicyVersion: z.literal(TIMING_POLICY_VERSION),
            sampleCount: z.number().int().positive(),
            p50Ms: z.number().min(0),
            p95Ms: z.number().min(0),
        })
        .nullable(),
});
export type CaseEvidence = z.infer<typeof caseEvidenceSchema>;

const attemptSchema = z.strictObject({
    attemptId: z.string().min(1),
    /** `evidence.attempts` contains only stable terminal attempts; open attempts are excluded. */
    status: z.enum(["completed", "failed", "interrupted"]),
    startedAtEpochMs: z.number().nonnegative(),
    endedAtEpochMs: z.number().nonnegative().nullable(),
    /** `evidence` holds real-clock and run-local detail; `semantic` never does.
     * */
    workingDirectory: z.string().nullable(),
    diagnostics: z.array(z.string()),
});
export type ReportAttempt = z.infer<typeof attemptSchema>;

const candidatePoolSchema = z.strictObject({
    schemaVersion: z.literal(CANDIDATE_POOL_SCHEMA_VERSION),
    consumer: z.literal(CANDIDATE_POOL_CONSUMER),
    topK: z.number().int().positive(),
    entries: z.array(
        z.strictObject({
            queryId: z.string().min(1),
            rank: z.number().int().positive(),
            locator: z.string().min(1),
            documentId: z.string().min(1).nullable(),
            canonicalId: z.string().min(1).nullable(),
            /** Unjudged results never receive an implicit grade 0. */
            status: z.enum(["unjudged", "unresolved"]),
        }),
    ),
});
export type CandidatePoolArtifact = z.infer<typeof candidatePoolSchema>;

const reportSchema = z.strictObject({
    schemaVersion: z.literal(REPORT_SCHEMA_VERSION),
    status: z.enum(["complete", "incomplete", "invalid"]),
    semantic: z.strictObject({
        metricPolicyVersion: z.literal(METRIC_POLICY_VERSION),
        timingPolicyVersion: z.literal(TIMING_POLICY_VERSION),
        releaseFingerprints: z.strictObject({
            corpus: fingerprintSchema,
            judgments: fingerprintSchema,
            syntheticProfiles: fingerprintSchema,
            manifest: fingerprintSchema,
        }),
        /** `semantic` identifies harness configuration; callers must store run-local paths and clocks in `evidence.attempts`.
         * */
        config: z.record(z.string(), jsonValueSchema),
    }),
    evidence: z.strictObject({
        attempts: z.array(attemptSchema).min(1),
        scenarios: z.array(scenarioSchema),
        cases: z.array(caseEvidenceSchema),
    }),
    candidatePool: candidatePoolSchema,
});
export type BenchmarkReport = z.infer<typeof reportSchema>;
export type ReportStatus = BenchmarkReport["status"];

export function parseReport(value: unknown): BenchmarkReport {
    const parsed = reportSchema.safeParse(value);
    if (!parsed.success) {
        throw new ContractError(
            parsed.error.issues
                .map((issue) => `report.${issue.path.join(".")}: ${issue.code}`)
                .sort(),
        );
    }
    return parsed.data;
}

/**
 * Attempts, timestamps, and working directories cannot affect `semanticFingerprint`. */
export function semanticFingerprint(report: BenchmarkReport): string {
    return canonicalFingerprint({
        schemaVersion: report.schemaVersion,
        semantic: report.semantic,
    });
}

/* */
export function evidenceDigest(report: BenchmarkReport): string {
    return canonicalFingerprint(report);
}

/**
 * Each scenario query ID must be unique, and at least one attempt must be completed.
 * A missing expected query ID returns "incomplete".
 */
export function computeReportStatus(input: {
    expectedQueryIds: readonly string[];
    scenarios: readonly Pick<ReportScenario, "queryId">[];
    attempts: readonly Pick<ReportAttempt, "status">[];
}): ReportStatus {
    const seen = new Set<string>();
    for (const scenario of input.scenarios) {
        if (seen.has(scenario.queryId)) return "invalid";
        seen.add(scenario.queryId);
    }
    if (input.attempts.length === 0) return "incomplete";
    if (!input.attempts.some((attempt) => attempt.status === "completed")) return "incomplete";
    for (const queryId of input.expectedQueryIds) {
        if (!seen.has(queryId)) return "incomplete";
    }
    return "complete";
}

/**
 * reason codes.
 */
export function passEligibility(
    report: Pick<BenchmarkReport, "status">,
    options: { compatible: boolean },
): { eligible: boolean; reasons: readonly string[] } {
    const reasons: string[] = [];
    if (report.status !== "complete") reasons.push(`evidence:${report.status}`);
    if (!options.compatible) reasons.push("evidence:incompatible");
    return { eligible: reasons.length === 0, reasons };
}

/**
 * */
export function aggregateReportQuality(report: BenchmarkReport): MacroAggregate[] {
    const laneRestrictedCases = new Set(
        report.evidence.cases
            .filter((caseEvidence) => caseEvidence.laneRestricted)
            .map((caseEvidence) => caseEvidence.caseId),
    );
    return macroAggregate(
        report.evidence.scenarios
            .filter((scenario) => !laneRestrictedCases.has(scenario.queryId.split(":", 1)[0]))
            .map((scenario) => ({
                queryId: scenario.queryId,
                paraphraseGroup: scenario.paraphraseGroup,
                partition: scenario.partition,
                mode: scenario.mode,
                values: {
                    recallAt10: scenario.metrics.recallAt10,
                    recallAt50: scenario.metrics.recallAt50,
                    reciprocalRank: scenario.metrics.reciprocalRank,
                    ndcgAt10: scenario.metrics.ndcgAt10,
                },
            })),
    );
}

/**
 */
export function buildCandidatePool(input: {
    topK: number;
    queries: readonly {
        queryId: string;
        ranked: readonly string[];
        resolved: readonly ResolvedRankedResult[];
        judgedGrades: ReadonlyMap<string, JudgedGrade>;
    }[];
}): CandidatePoolArtifact {
    if (!Number.isInteger(input.topK) || input.topK <= 0) {
        throw new ContractError(["candidatePool.topK: not-positive"]);
    }
    const entries: CandidatePoolArtifact["entries"] = [];
    for (const query of input.queries) {
        if (query.resolved.length !== query.ranked.length) {
            throw new ContractError([
                `candidatePool.${query.queryId}: ranked/resolved length mismatch`,
            ]);
        }
        for (const entry of query.resolved.slice(0, input.topK)) {
            const locator = query.ranked[entry.rank - 1];
            if (entry.status === "unresolved") {
                entries.push({
                    queryId: query.queryId,
                    rank: entry.rank,
                    locator,
                    documentId: null,
                    canonicalId: null,
                    status: "unresolved",
                });
                continue;
            }
            if (entry.status === "duplicate") continue;
            if (query.judgedGrades.has(entry.documentId)) continue;
            entries.push({
                queryId: query.queryId,
                rank: entry.rank,
                locator,
                documentId: entry.documentId,
                canonicalId: entry.canonicalId,
                status: "unjudged",
            });
        }
    }
    return {
        schemaVersion: CANDIDATE_POOL_SCHEMA_VERSION,
        consumer: CANDIDATE_POOL_CONSUMER,
        topK: input.topK,
        entries,
    };
}
