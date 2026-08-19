/**
 * Strict versioned benchmark report contract (KTD11).
 *
 * A report separates two identity channels. `semantic` holds only
 * run-independent identity — policy versions, release fingerprints, harness
 * configuration — and `semanticFingerprint` hashes exactly that section
 * through canonical JSON, so neither object-key order nor any run-local
 * working directory can change it. `evidence` holds every attempt
 * (real-clock timestamps, working directories, diagnostics) and every raw
 * per-scenario sample, so all aggregates are recomputable; `evidenceDigest`
 * hashes the whole report, evidence included.
 *
 * The candidate-pool section is the versioned unjudged top-K artifact that
 * `magic-context-u51` consumes: unjudged results stay visible without ever
 * becoming implicit negative labels.
 *
 * Incomplete or incompatible evidence can never produce a pass:
 * `passEligibility` is the only pass gate this module exports and it fails
 * closed.
 */

import { z } from "zod";

import { canonicalFingerprint } from "./canonical-json";
import { ContractError } from "./contract";
import type { ResolvedRankedResult } from "./identity";
import { type JudgedGrade, METRIC_POLICY_VERSION } from "./metrics";
import { TIMING_POLICY_VERSION } from "./timing";

export const REPORT_SCHEMA_VERSION = "retrieval-benchmark-report/v1";
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
    /** Raw physical ranking exactly as the surface returned it. */
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
    /** Raw per-scenario latency samples; summaries are recomputable. */
    latencySamplesMs: z.array(z.number().min(0)),
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
});
export type CaseEvidence = z.infer<typeof caseEvidenceSchema>;

const attemptSchema = z.strictObject({
    attemptId: z.string().min(1),
    /** Stable terminal statuses only — an open attempt is not evidence. */
    status: z.enum(["completed", "failed", "interrupted"]),
    startedAtEpochMs: z.number().nonnegative(),
    endedAtEpochMs: z.number().nonnegative().nullable(),
    /** Real-clock and run-local detail lives here, in evidence, never in
     *  the semantic section. */
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
            /** Unjudged stays unjudged — never an implicit grade 0. */
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
        /** Harness configuration identity. Callers must not put run-local
         *  paths or clocks here; those belong in evidence.attempts. */
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

/** Deterministic semantic/config fingerprint: hashes ONLY the semantic
 *  section (canonical JSON sorts keys, so insertion order is irrelevant).
 *  Attempts, timestamps, and working directories cannot reach it. */
export function semanticFingerprint(report: BenchmarkReport): string {
    return canonicalFingerprint({
        schemaVersion: report.schemaVersion,
        semantic: report.semantic,
    });
}

/** Hashes the whole report, attempts included. */
export function evidenceDigest(report: BenchmarkReport): string {
    return canonicalFingerprint(report);
}

/**
 * Compute the report status from expected coverage: every expected scenario
 * present exactly once and at least one completed attempt. A duplicate
 * scenario is structurally invalid; anything missing is incomplete.
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
 * The only pass gate this module exports. Fails closed: anything other than
 * a complete report over compatible evidence is ineligible, with stable
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
 * `magic-context-u51` consumes this versioned, unjudged top-K candidate-pool
 * artifact. Judged entries and duplicate aliases are excluded; unresolved
 * locators are retained with their status so the follow-up release can
 * account for them.
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
