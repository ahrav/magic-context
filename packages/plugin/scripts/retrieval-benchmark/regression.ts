/**
 * Immutable baselines and the KTD17 regression policy (U6: R59-R62).
 *
 * Quality identity and latency identity are separate (KTD3): a quality
 * baseline binds release + metric policy + behavior + profile fingerprints;
 * a latency baseline additionally binds one exact host fingerprint plus
 * exclusive-lock, canary, affinity, NUMA, power, and cache evidence. A
 * mismatch or drift makes latency non-comparable and can never yield a
 * latency pass; matching quality keys may still yield a quality-only
 * verdict, which cannot unblock a gate that requires latency.
 *
 * Latency policy input is raw request samples only: one p95 per run per
 * matrix cell through the versioned nearest-rank rule, then the median of
 * the three run-level p95 values. Pooled cross-run samples and averaged
 * worker/query percentiles are rejected as policy inputs, not silently
 * accepted (KTD15, R61).
 *
 * KTD10: the thresholds are repository policy, not statistical confidence.
 * The A/A check reports mechanical integrity of report parsing and policy
 * application; its spread is never interpreted as a noise floor.
 *
 * KD4/R59: the TypeScript audit records absolute quality with
 * `quality_target: not_specified` and the 25 ms latency comparison for the
 * 100K/384 automatic cell; it never feeds the regression verdict.
 */

import {
    existsSync,
    linkSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { z } from "zod";

import { canonicalFingerprint, readCanonicalJsonFile } from "./canonical-json";
import { formatIssues } from "./contract";
import { gateAggregates, METRIC_POLICY_VERSION, type QueryMode } from "./metrics";
import {
    aggregateReportQuality,
    type BenchmarkReport,
    evidenceDigest,
    semanticFingerprint,
} from "./report";
import { nearestRankPercentile, TIMING_POLICY_VERSION } from "./timing";

export const REGRESSION_POLICY_SCHEMA_VERSION = "retrieval-benchmark-regression-policy/v1";
export const QUALITY_BASELINE_SCHEMA_VERSION = "retrieval-benchmark-quality-baseline/v1";
export const LATENCY_BASELINE_SCHEMA_VERSION = "retrieval-benchmark-latency-baseline/v1";
export const REGRESSION_RESULT_SCHEMA_VERSION = "retrieval-benchmark-regression-result/v1";
export const AA_CHECK_SCHEMA_VERSION = "retrieval-benchmark-aa-check/v1";
export const TS_AUDIT_SCHEMA_VERSION = "retrieval-benchmark-ts-audit/v1";

export const REQUIRED_RUN_COUNT = 3;
export const TS_AUDIT_LATENCY_THRESHOLD_MS = 25;

/** Absorbs binary-float noise when metric losses land exactly on a policy
 *  boundary (0.80 - 0.78 is 2.0000000000000018 points in float64); one
 *  nano-point can never flip a genuine regression. */
const LOSS_POINTS_EPSILON = 1e-9;

export class RegressionError extends Error {
    readonly diagnostics: readonly string[];

    constructor(diagnostics: string[]) {
        super(diagnostics.join("; "));
        this.diagnostics = diagnostics;
    }
}

// ---------------------------------------------------------------------------
// Strict versioned artifact schemas.
// ---------------------------------------------------------------------------

const fingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/);
const unitMetricSchema = z.number().min(0).max(1);

const policySchema = z.strictObject({
    schemaVersion: z.literal(REGRESSION_POLICY_SCHEMA_VERSION),
    id: z.string().regex(/^policy-[a-z0-9-]+$/),
    description: z.string().min(1),
    runsRequired: z.literal(REQUIRED_RUN_COUNT),
    quality: z.strictObject({
        partition: z.literal("holdout"),
        appliedPerMode: z.literal(true),
        metrics: z.tuple([z.literal("ndcgAt10"), z.literal("recallAt50")]),
        maxAverageLossPoints: z.number().positive(),
        maxSingleRunLossPoints: z.number().positive(),
    }),
    latency: z.strictObject({
        percentileRule: z.literal(TIMING_POLICY_VERSION),
        runLevelP95Input: z.literal("raw-request-samples"),
        runAggregation: z.literal("median-of-run-p95"),
        maxMedianP95Percent: z.number().int().positive(),
    }),
});
export type RegressionPolicy = z.infer<typeof policySchema>;

const qualityKeySchema = z.strictObject({
    releaseFingerprints: z.strictObject({
        corpus: fingerprintSchema,
        judgments: fingerprintSchema,
        syntheticProfiles: fingerprintSchema,
        manifest: fingerprintSchema,
    }),
    metricPolicyVersion: z.literal(METRIC_POLICY_VERSION),
    timingPolicyVersion: z.literal(TIMING_POLICY_VERSION),
    profileFingerprint: fingerprintSchema,
    /** Hash of the report's whole semantic config: harness version,
     *  instrumentation schema versions, case set, fixtures, and every other
     *  behavior-relevant knob. Any behavior-contract change moves it. */
    behaviorFingerprint: fingerprintSchema,
});
export type QualityKey = z.infer<typeof qualityKeySchema>;

export const CLAIM_ELIGIBILITIES = ["judged-support-only", "measured-win-eligible"] as const;
export type ClaimEligibility = (typeof CLAIM_ELIGIBILITIES)[number];

const modeValuesSchema = z.strictObject({
    mode: z.enum(["explicit", "automatic"]),
    ndcgAt10: unitMetricSchema,
    recallAt50: unitMetricSchema,
});
export type BaselineModeValues = z.infer<typeof modeValuesSchema>;

const qualityRunSchema = z.strictObject({
    evidenceDigest: fingerprintSchema,
    semanticFingerprint: fingerprintSchema,
    hostFingerprint: fingerprintSchema.nullable(),
    modes: z
        .array(modeValuesSchema)
        .min(1)
        // Downstream lookups resolve a mode by find(); a duplicate entry in
        // a hand-edited baseline would silently drop every entry after the
        // first instead of failing loudly here.
        .refine((modes) => new Set(modes.map((entry) => entry.mode)).size === modes.length, {
            message: "duplicate mode entries in one run",
        }),
});

const qualityBaselineSchema = z.strictObject({
    schemaVersion: z.literal(QUALITY_BASELINE_SCHEMA_VERSION),
    kind: z.literal("quality"),
    policyFingerprint: fingerprintSchema,
    claimEligibility: z.enum(CLAIM_ELIGIBILITIES),
    qualityKey: qualityKeySchema,
    runs: z.array(qualityRunSchema).length(REQUIRED_RUN_COUNT),
});
export type QualityBaselineArtifact = z.infer<typeof qualityBaselineSchema>;

const hostEvidenceSchema = z.strictObject({
    hostFingerprint: fingerprintSchema,
    exclusiveRunLock: z.boolean(),
    canary: z.strictObject({
        pre: z.enum(["stable", "failed"]),
        post: z.enum(["stable", "failed"]),
    }),
    affinity: z.string().min(1),
    numa: z.string().min(1),
    power: z.string().min(1),
    cache: z.string().min(1),
});
export type HostEvidence = z.infer<typeof hostEvidenceSchema>;

const nonNegative = z.number().min(0);

const latencyCellSchema = z.strictObject({
    caseId: z.string().min(1),
    runP95sMs: z.tuple([nonNegative, nonNegative, nonNegative]),
    medianP95Ms: nonNegative,
});
export type LatencyBaselineCell = z.infer<typeof latencyCellSchema>;

const latencyBaselineSchema = z.strictObject({
    schemaVersion: z.literal(LATENCY_BASELINE_SCHEMA_VERSION),
    kind: z.literal("latency"),
    hostClass: z.enum(["arm-neon", "x86-avx2"]),
    policyFingerprint: fingerprintSchema,
    qualityKey: qualityKeySchema,
    hostFingerprint: fingerprintSchema,
    hostEvidence: hostEvidenceSchema,
    runs: z
        .array(
            z.strictObject({
                evidenceDigest: fingerprintSchema,
                semanticFingerprint: fingerprintSchema,
            }),
        )
        .length(REQUIRED_RUN_COUNT),
    cells: z.array(latencyCellSchema).min(1),
});
export type LatencyBaselineArtifact = z.infer<typeof latencyBaselineSchema>;

function formatArtifactIssues(prefix: string, error: z.ZodError): string[] {
    return formatIssues(prefix, error);
}

export function parseRegressionPolicy(value: unknown): RegressionPolicy {
    const parsed = policySchema.safeParse(value);
    if (!parsed.success) throw new RegressionError(formatArtifactIssues("policy", parsed.error));
    return parsed.data;
}

export function parseQualityBaseline(value: unknown): QualityBaselineArtifact {
    const parsed = qualityBaselineSchema.safeParse(value);
    if (!parsed.success) throw new RegressionError(formatArtifactIssues("baseline", parsed.error));
    // Cross-run mode consistency is a loader obligation, not just a builder
    // one: evaluateRegression derives its mode set from the first run and
    // asks every run for it, so a hand-edited but schema-valid artifact
    // with diverging per-run mode sets must fail here with a clean
    // diagnostic instead of crashing the evaluation.
    const modeSet = (run: { modes: readonly { mode: string }[] }) =>
        [...run.modes.map((entry) => entry.mode)].sort().join(",");
    const first = parsed.data.runs[0];
    if (first && parsed.data.runs.some((run) => modeSet(run) !== modeSet(first))) {
        throw new RegressionError(["baseline: holdout mode coverage differs across runs"]);
    }
    return parsed.data;
}

export function parseLatencyBaseline(value: unknown): LatencyBaselineArtifact {
    const parsed = latencyBaselineSchema.safeParse(value);
    if (!parsed.success) throw new RegressionError(formatArtifactIssues("baseline", parsed.error));
    return parsed.data;
}

export function parseHostEvidence(value: unknown): HostEvidence {
    const parsed = hostEvidenceSchema.safeParse(value);
    if (!parsed.success) {
        throw new RegressionError(formatArtifactIssues("hostEvidence", parsed.error));
    }
    return parsed.data;
}

/** Same promoter-serialization byte rule the release and profile loaders
 *  enforce: any byte the parsed view does not account for rejects. */
function readCanonicalArtifact(label: string, path: string): unknown {
    return readCanonicalJsonFile(
        path,
        (code) => new RegressionError([`${label}: ${code} (${path})`]),
    );
}

export function loadRegressionPolicyFile(path: string): RegressionPolicy {
    return parseRegressionPolicy(readCanonicalArtifact("policy", path));
}

export type BaselineArtifact = QualityBaselineArtifact | LatencyBaselineArtifact;

export function loadBaselineFile(path: string): BaselineArtifact {
    const parsed = readCanonicalArtifact("baseline", path);
    const schemaVersion = (parsed as { schemaVersion?: unknown } | null)?.schemaVersion;
    if (schemaVersion === QUALITY_BASELINE_SCHEMA_VERSION) return parseQualityBaseline(parsed);
    if (schemaVersion === LATENCY_BASELINE_SCHEMA_VERSION) return parseLatencyBaseline(parsed);
    throw new RegressionError([`baseline: unknown-schema-version (${path})`]);
}

export function regressionPolicyFingerprint(policy: RegressionPolicy): string {
    return canonicalFingerprint(policy);
}

// ---------------------------------------------------------------------------
// Report-derived identity and latency evidence.
// ---------------------------------------------------------------------------

export function qualityKeyFromReport(report: BenchmarkReport): QualityKey {
    const profileFingerprint = report.semantic.config.profileFingerprint;
    if (typeof profileFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(profileFingerprint)) {
        throw new RegressionError(["report: semantic.config.profileFingerprint missing"]);
    }
    return {
        releaseFingerprints: report.semantic.releaseFingerprints,
        metricPolicyVersion: report.semantic.metricPolicyVersion,
        timingPolicyVersion: report.semantic.timingPolicyVersion,
        profileFingerprint,
        behaviorFingerprint: canonicalFingerprint(report.semantic.config),
    };
}

/** The runner records its host fingerprint as a `host:<sha256>` attempt
 *  diagnostic. Distinct fingerprints across attempts mean the checkpointed
 *  evidence mixes hosts, which is never usable latency identity. */
export function reportHostFingerprint(report: BenchmarkReport): string | null {
    const found = new Set<string>();
    for (const attempt of report.evidence.attempts) {
        for (const line of attempt.diagnostics) {
            const match = /^host:([0-9a-f]{64})$/.exec(line);
            if (match) found.add(match[1]);
        }
    }
    if (found.size > 1) throw new RegressionError(["report: mixed host fingerprints in attempts"]);
    return found.size === 1 ? [...found][0] : null;
}

export type RunCellLatencyEvidence =
    | { kind: "raw-request-samples"; samplesMs: readonly number[] }
    | { kind: "pooled-samples"; samplesMs: readonly number[] }
    | { kind: "averaged-worker-p95s"; p95sMs: readonly number[] }
    | { kind: "averaged-query-p95s"; p95sMs: readonly number[] };

/** One run-level p95 per matrix cell from raw request samples only.
 *  Pre-pooled cross-run samples and averaged worker/query percentiles are
 *  rejected as policy inputs (R61, KTD10). */
export function runLevelP95(evidence: RunCellLatencyEvidence): number {
    if (evidence.kind !== "raw-request-samples") {
        throw new RegressionError([
            `latency: ${evidence.kind} rejected as policy input; supply raw request samples per run`,
        ]);
    }
    return nearestRankPercentile(evidence.samplesMs, 95);
}

export function medianOfThree(values: readonly [number, number, number]): number {
    return [...values].sort((a, b) => a - b)[1];
}

/** Raw trace-disabled request samples per matrix cell (case) for one run. */
export function reportCellSamples(report: BenchmarkReport): Map<string, number[]> {
    const cells = new Map<string, number[]>();
    for (const caseEvidence of report.evidence.cases) {
        const prefix = `${caseEvidence.caseId}:`;
        const samples: number[] = [];
        for (const scenario of report.evidence.scenarios) {
            if (scenario.queryId.startsWith(prefix)) samples.push(...scenario.latencySamplesMs);
        }
        cells.set(caseEvidence.caseId, samples);
    }
    return cells;
}

export type PolicyMetric = "ndcgAt10" | "recallAt50";

function gateModeValues(report: BenchmarkReport): Map<QueryMode, BaselineModeValues> {
    const values = new Map<QueryMode, BaselineModeValues>();
    for (const aggregate of gateAggregates(aggregateReportQuality(report))) {
        if (aggregate.ndcgAt10 === null || aggregate.recallAt50 === null) continue;
        values.set(aggregate.mode, {
            mode: aggregate.mode,
            ndcgAt10: aggregate.ndcgAt10,
            recallAt50: aggregate.recallAt50,
        });
    }
    return values;
}

// ---------------------------------------------------------------------------
// Baseline creation and atomic publication (KTD11).
// ---------------------------------------------------------------------------

function validateRunSet(
    label: string,
    reports: readonly BenchmarkReport[],
    options: { allowIdenticalRuns: boolean },
): string[] {
    const diagnostics: string[] = [];
    if (reports.length !== REQUIRED_RUN_COUNT) {
        diagnostics.push(`${label}: exactly ${REQUIRED_RUN_COUNT} complete run IDs required`);
        return diagnostics;
    }
    const digests = new Set<string>();
    for (const [i, report] of reports.entries()) {
        if (report.status !== "complete") {
            diagnostics.push(`${label}: run ${i + 1} is ${report.status}, not complete`);
        }
        digests.add(evidenceDigest(report));
    }
    if (!options.allowIdenticalRuns && digests.size !== REQUIRED_RUN_COUNT) {
        diagnostics.push(`${label}: duplicate run IDs`);
    }
    return diagnostics;
}

function missingModeDiagnostics(
    label: string,
    modes: readonly QueryMode[],
    runs: readonly Map<QueryMode, BaselineModeValues>[],
): string[] {
    const diagnostics: string[] = [];
    for (const mode of modes) {
        for (const [i, values] of runs.entries()) {
            if (!values.has(mode)) {
                diagnostics.push(
                    `${label}: run ${i + 1} has no scoreable holdout aggregate for ${mode}`,
                );
            }
        }
    }
    return diagnostics;
}

function matchingQualityKey(label: string, reports: readonly BenchmarkReport[]): QualityKey {
    const keys = reports.map(qualityKeyFromReport);
    const fingerprints = new Set(keys.map(canonicalFingerprint));
    if (fingerprints.size !== 1) {
        throw new RegressionError([`${label}: quality keys differ across runs`]);
    }
    return keys[0];
}

export function buildQualityBaseline(input: {
    policy: RegressionPolicy;
    reports: readonly BenchmarkReport[];
    claimEligibility: ClaimEligibility;
    /** A/A mechanical mode only: the same artifact plays all three runs. */
    allowIdenticalRuns?: boolean;
}): QualityBaselineArtifact {
    const allowIdenticalRuns = input.allowIdenticalRuns ?? false;
    const diagnostics = validateRunSet("baseline", input.reports, { allowIdenticalRuns });
    if (diagnostics.length > 0) throw new RegressionError(diagnostics);
    const qualityKey = matchingQualityKey("baseline", input.reports);

    const runs = input.reports.map((report, i) => {
        const modes = [...gateModeValues(report).values()].sort((a, b) =>
            a.mode.localeCompare(b.mode),
        );
        if (modes.length === 0) {
            throw new RegressionError([
                `baseline: run ${i + 1} has no scoreable holdout mode aggregate`,
            ]);
        }
        return {
            evidenceDigest: evidenceDigest(report),
            semanticFingerprint: semanticFingerprint(report),
            hostFingerprint: reportHostFingerprint(report),
            modes,
        };
    });
    const modeSets = new Set(runs.map((run) => run.modes.map((m) => m.mode).join(",")));
    if (modeSets.size !== 1) {
        throw new RegressionError(["baseline: holdout mode coverage differs across runs"]);
    }

    return parseQualityBaseline({
        schemaVersion: QUALITY_BASELINE_SCHEMA_VERSION,
        kind: "quality",
        policyFingerprint: regressionPolicyFingerprint(input.policy),
        claimEligibility: input.claimEligibility,
        qualityKey,
        runs,
    });
}

export function vacuousBaselineModes(artifact: QualityBaselineArtifact): QueryMode[] {
    const modes = artifact.runs[0]?.modes ?? [];
    return modes
        .filter((mode) =>
            artifact.runs.every((run) =>
                run.modes.some(
                    (entry) =>
                        entry.mode === mode.mode && entry.ndcgAt10 === 0 && entry.recallAt50 === 0,
                ),
            ),
        )
        .map((mode) => mode.mode);
}

/** Core per-run host-evidence checks shared by baseline building and
 *  candidate evaluation: the exclusive run lock, canary stability, and the
 *  report's host matching its evidence. Reference comparisons stay with
 *  each caller because their referents differ (the first run's evidence
 *  for a new baseline; the stored baseline for candidates). */
function hostEvidenceRunIssues(
    label: string,
    index: number,
    evidence: HostEvidence,
    report: BenchmarkReport,
): string[] {
    const issues: string[] = [];
    if (!evidence.exclusiveRunLock) {
        issues.push(`${label}: run ${index + 1} lacks the exclusive run lock`);
    }
    if (evidence.canary.pre !== "stable" || evidence.canary.post !== "stable") {
        issues.push(`${label}: run ${index + 1} has an unstable pre/post canary`);
    }
    if (reportHostFingerprint(report) !== evidence.hostFingerprint) {
        issues.push(`${label}: run ${index + 1} report host does not match its evidence`);
    }
    return issues;
}

export function buildLatencyBaseline(input: {
    policy: RegressionPolicy;
    reports: readonly BenchmarkReport[];
    hostClass: "arm-neon" | "x86-avx2";
    hostEvidence: readonly HostEvidence[];
}): LatencyBaselineArtifact {
    const diagnostics = validateRunSet("baseline", input.reports, {
        allowIdenticalRuns: false,
    });
    if (input.hostEvidence.length !== REQUIRED_RUN_COUNT) {
        diagnostics.push("baseline: host evidence required for each of the three runs");
    }
    if (diagnostics.length > 0) throw new RegressionError(diagnostics);
    const qualityKey = matchingQualityKey("baseline", input.reports);

    for (const [i, evidence] of input.hostEvidence.entries()) {
        diagnostics.push(...hostEvidenceRunIssues("baseline", i, evidence, input.reports[i]));
        if (canonicalFingerprint(evidence) !== canonicalFingerprint(input.hostEvidence[0])) {
            diagnostics.push(
                `baseline: run ${i + 1} host evidence differs (mixed hosts or drifted placement/power/cache state)`,
            );
        }
    }
    if (diagnostics.length > 0) throw new RegressionError(diagnostics);

    const perRunCells = input.reports.map(reportCellSamples);
    const caseIds = [...perRunCells[0].keys()].sort();
    for (const [i, cells] of perRunCells.entries()) {
        if ([...cells.keys()].sort().join(",") !== caseIds.join(",")) {
            throw new RegressionError([`baseline: run ${i + 1} covers a different case set`]);
        }
    }
    const cells: LatencyBaselineCell[] = caseIds.map((caseId) => {
        const runP95sMs = perRunCells.map((cells, i) => {
            const samplesMs = cells.get(caseId) ?? [];
            if (samplesMs.length === 0) {
                throw new RegressionError([
                    `baseline: run ${i + 1} has no raw samples for ${caseId}`,
                ]);
            }
            return runLevelP95({ kind: "raw-request-samples", samplesMs });
        }) as [number, number, number];
        return { caseId, runP95sMs, medianP95Ms: medianOfThree(runP95sMs) };
    });

    return parseLatencyBaseline({
        schemaVersion: LATENCY_BASELINE_SCHEMA_VERSION,
        kind: "latency",
        hostClass: input.hostClass,
        policyFingerprint: regressionPolicyFingerprint(input.policy),
        qualityKey,
        hostFingerprint: input.hostEvidence[0].hostFingerprint,
        hostEvidence: input.hostEvidence[0],
        runs: input.reports.map((report) => ({
            evidenceDigest: evidenceDigest(report),
            semanticFingerprint: semanticFingerprint(report),
        })),
        cells,
    });
}

/**
 * Atomic immutable publication (KTD11): refuse overwrite, stage the complete
 * artifact beside the destination, re-load the exact staged bytes through
 * the strict schema, and hard-link into place. link(2) fails with EEXIST
 * when the destination exists, so a concurrent publisher cannot replace an
 * already published baseline (rename(2) would). Any failure removes the
 * staging directory and leaves the destination directory byte-identical.
 */
export function publishBaseline(artifact: BaselineArtifact, outPath: string): { path: string } {
    if (existsSync(outPath)) {
        throw new RegressionError([`baseline: refuse-overwrite (${outPath})`]);
    }
    const dir = dirname(outPath);
    mkdirSync(dir, { recursive: true });
    const staging = mkdtempSync(join(dir, ".baseline-staging-"));
    try {
        const stagedPath = join(staging, basename(outPath));
        writeFileSync(stagedPath, `${JSON.stringify(artifact, null, 2)}\n`, { flag: "wx" });
        loadBaselineFile(stagedPath);
        try {
            linkSync(stagedPath, outPath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") {
                throw new RegressionError([`baseline: refuse-overwrite (${outPath})`]);
            }
            throw error;
        }
    } finally {
        rmSync(staging, { recursive: true, force: true });
    }
    return { path: outPath };
}

// ---------------------------------------------------------------------------
// TS-only audit (KD4, R59, AE9).
// ---------------------------------------------------------------------------

export interface TsAudit {
    schemaVersion: typeof TS_AUDIT_SCHEMA_VERSION;
    /** KD4: no absolute quality target exists; absolute metrics are
     *  recorded without a verdict and never gate the roadmap. */
    quality_target: "not_specified";
    quality: Array<{
        runId: string;
        holdout: Array<{
            mode: QueryMode;
            ndcgAt10: number | null;
            recallAt10: number | null;
            recallAt50: number | null;
            mrr: number | null;
        }>;
    }>;
    latency_target: "met" | "not_met" | "not_evaluated";
    latency: {
        thresholdMs: typeof TS_AUDIT_LATENCY_THRESHOLD_MS;
        auditCaseIds: readonly string[];
        runP95sMs: readonly number[];
        medianRunP95Ms: number | null;
    };
}

export function tsAudit(input: {
    reports: readonly BenchmarkReport[];
    /** Cases realizing the 100K/384 automatic audit cell; the caller derives
     *  them from the profile. Empty means the cell did not run here. */
    auditCaseIds: readonly string[];
}): TsAudit {
    // Pooling raw samples from several cases would fold distinct matrix
    // cells into one run-level p95 (R61), so more than one case rejects.
    if (input.auditCaseIds.length > 1) {
        throw new RegressionError([
            `audit: ${input.auditCaseIds.length} audit cases would pool raw samples across matrix cells into one run-level p95; supply at most one audit case id`,
        ]);
    }
    const quality = input.reports.map((report) => ({
        runId: evidenceDigest(report),
        holdout: gateAggregates(aggregateReportQuality(report)).map((aggregate) => ({
            mode: aggregate.mode,
            ndcgAt10: aggregate.ndcgAt10,
            recallAt10: aggregate.recallAt10,
            recallAt50: aggregate.recallAt50,
            mrr: aggregate.mrr,
        })),
    }));

    const runP95sMs: number[] = [];
    if (input.auditCaseIds.length > 0) {
        for (const report of input.reports) {
            const cells = reportCellSamples(report);
            const samplesMs = input.auditCaseIds.flatMap((caseId) => cells.get(caseId) ?? []);
            if (samplesMs.length === 0) {
                runP95sMs.length = 0;
                break;
            }
            runP95sMs.push(runLevelP95({ kind: "raw-request-samples", samplesMs }));
        }
    }
    const medianRunP95Ms =
        runP95sMs.length === REQUIRED_RUN_COUNT
            ? medianOfThree(runP95sMs as [number, number, number])
            : null;
    return {
        schemaVersion: TS_AUDIT_SCHEMA_VERSION,
        quality_target: "not_specified",
        quality,
        latency_target:
            medianRunP95Ms === null
                ? "not_evaluated"
                : medianRunP95Ms <= TS_AUDIT_LATENCY_THRESHOLD_MS
                  ? "met"
                  : "not_met",
        latency: {
            thresholdMs: TS_AUDIT_LATENCY_THRESHOLD_MS,
            auditCaseIds: [...input.auditCaseIds],
            runP95sMs,
            medianRunP95Ms,
        },
    };
}

// ---------------------------------------------------------------------------
// Regression evaluation (R60-R62, KTD17 values from the policy artifact).
// ---------------------------------------------------------------------------

export type RegressionVerdict =
    | "pass"
    | "policy-fail"
    | "quality-only"
    | "non-comparable"
    | "invalid-evidence"
    | "incomplete"
    | "needs_judgment";

export type RegressionClaim = "regression" | "measured-win";

export interface QualityModeFinding {
    mode: QueryMode;
    metric: PolicyMetric;
    baselineMean: number;
    candidateMean: number;
    averageLossPoints: number;
    worstRunLossPoints: number;
    pass: boolean;
}

export interface LatencyCellFinding {
    caseId: string;
    baselineMedianP95Ms: number;
    candidateRunP95sMs: readonly [number, number, number];
    candidateMedianP95Ms: number;
    withinBound: boolean;
}

export interface RegressionResult {
    schemaVersion: typeof REGRESSION_RESULT_SCHEMA_VERSION;
    verdict: RegressionVerdict;
    reasons: readonly string[];
    claim: RegressionClaim;
    claimEligibility: ClaimEligibility;
    quality: readonly QualityModeFinding[];
    latency: {
        status: "compared" | "non-comparable" | "no-baseline";
        reasons: readonly string[];
        cells: readonly LatencyCellFinding[];
    };
    gate: { latencyRequired: boolean; unblocked: boolean };
    audit: TsAudit;
}

export interface EvaluateRegressionInput {
    policy: RegressionPolicy;
    baseline: QualityBaselineArtifact;
    candidates: readonly BenchmarkReport[];
    claim?: RegressionClaim;
    latency?: {
        baseline: LatencyBaselineArtifact;
        candidateHostEvidence: readonly HostEvidence[];
    } | null;
    /** A gate that requires latency is never unblocked by quality-only. */
    latencyRequired?: boolean;
    auditCaseIds?: readonly string[];
    /** A/A mechanical mode only. */
    allowIdenticalRuns?: boolean;
}

function baselineModeMetric(
    baseline: QualityBaselineArtifact,
    mode: QueryMode,
    metric: PolicyMetric,
): number[] {
    return baseline.runs.map((run) => {
        const values = run.modes.find((m) => m.mode === mode);
        if (!values) throw new RegressionError([`baseline: run missing mode ${mode}`]);
        return values[metric];
    });
}

function mean(values: readonly number[]): number {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function evaluateRegression(input: EvaluateRegressionInput): RegressionResult {
    const claim = input.claim ?? "regression";
    const latencyRequired = input.latencyRequired ?? false;
    const audit = tsAudit({
        reports: input.candidates,
        auditCaseIds: input.auditCaseIds ?? [],
    });
    const finish = (
        verdict: RegressionVerdict,
        reasons: string[],
        quality: QualityModeFinding[],
        latency: RegressionResult["latency"],
    ): RegressionResult => ({
        schemaVersion: REGRESSION_RESULT_SCHEMA_VERSION,
        verdict,
        reasons,
        claim,
        claimEligibility: input.baseline.claimEligibility,
        quality,
        latency,
        gate: {
            latencyRequired,
            unblocked: verdict === "pass" || (verdict === "quality-only" && !latencyRequired),
        },
        audit,
    });
    const noLatency: RegressionResult["latency"] = {
        status: "no-baseline",
        reasons: [],
        cells: [],
    };

    const incomplete = validateRunSet("candidate", input.candidates, {
        allowIdenticalRuns: input.allowIdenticalRuns ?? false,
    });
    if (incomplete.length > 0) return finish("incomplete", incomplete, [], noLatency);

    const comparability: string[] = [];
    if (input.baseline.policyFingerprint !== regressionPolicyFingerprint(input.policy)) {
        comparability.push("policy: baseline is bound to a different policy artifact");
    }
    let candidateKey: QualityKey | null = null;
    try {
        candidateKey = matchingQualityKey("candidate", input.candidates);
    } catch (error) {
        if (!(error instanceof RegressionError)) throw error;
        comparability.push(...error.diagnostics);
    }
    if (
        candidateKey !== null &&
        canonicalFingerprint(candidateKey) !== canonicalFingerprint(input.baseline.qualityKey)
    ) {
        comparability.push("quality-key: candidate does not match the baseline");
    }
    if (comparability.length > 0) return finish("non-comparable", comparability, [], noLatency);

    const candidateModes = input.candidates.map(gateModeValues);
    const modes = input.baseline.runs[0].modes.map((m) => m.mode);
    const invalid = missingModeDiagnostics("candidate", modes, candidateModes);
    if (invalid.length > 0) return finish("invalid-evidence", invalid, [], noLatency);

    const quality: QualityModeFinding[] = [];
    const qualityFailures: string[] = [];
    for (const mode of modes) {
        for (const metric of input.policy.quality.metrics) {
            const baselineMean = mean(baselineModeMetric(input.baseline, mode, metric));
            const candidateValues = candidateModes.map((values) => {
                const modeValues = values.get(mode);
                if (!modeValues) throw new RegressionError([`candidate: missing mode ${mode}`]);
                return modeValues[metric];
            });
            const candidateMean = mean(candidateValues);
            const averageLossPoints = (baselineMean - candidateMean) * 100;
            const worstRunLossPoints = Math.max(
                ...candidateValues.map((value) => (baselineMean - value) * 100),
            );
            const pass =
                averageLossPoints <=
                    input.policy.quality.maxAverageLossPoints + LOSS_POINTS_EPSILON &&
                worstRunLossPoints <=
                    input.policy.quality.maxSingleRunLossPoints + LOSS_POINTS_EPSILON;
            if (!pass) {
                qualityFailures.push(
                    `quality: ${mode} ${metric} loss avg=${averageLossPoints.toFixed(3)} worst=${worstRunLossPoints.toFixed(3)} points`,
                );
            }
            quality.push({
                mode,
                metric,
                baselineMean,
                candidateMean,
                averageLossPoints,
                worstRunLossPoints,
                pass,
            });
        }
    }
    if (qualityFailures.length > 0) {
        return finish("policy-fail", qualityFailures, quality, noLatency);
    }

    if (claim === "measured-win" && input.baseline.claimEligibility !== "measured-win-eligible") {
        return finish(
            "needs_judgment",
            [
                "claim: baseline is judged-support-only; a measured-win claim needs the denser reviewed release and a replacement baseline",
            ],
            quality,
            noLatency,
        );
    }

    if (!input.latency) {
        return finish(
            "quality-only",
            ["latency: no comparable latency baseline supplied"],
            quality,
            { status: "no-baseline", reasons: ["latency: no baseline"], cells: [] },
        );
    }

    const latencyBaseline = input.latency.baseline;
    const latencyReasons: string[] = [];
    if (latencyBaseline.policyFingerprint !== regressionPolicyFingerprint(input.policy)) {
        latencyReasons.push("latency: baseline is bound to a different policy artifact");
    }
    if (
        canonicalFingerprint(latencyBaseline.qualityKey) !==
        canonicalFingerprint(input.baseline.qualityKey)
    ) {
        latencyReasons.push("latency: baseline quality key does not match");
    }
    const hostEvidence = input.latency.candidateHostEvidence;
    if (hostEvidence.length !== REQUIRED_RUN_COUNT) {
        latencyReasons.push("latency: host evidence required for each candidate run");
    } else {
        for (const [i, evidence] of hostEvidence.entries()) {
            latencyReasons.push(
                ...hostEvidenceRunIssues("latency", i, evidence, input.candidates[i]),
            );
            if (evidence.hostFingerprint !== latencyBaseline.hostFingerprint) {
                latencyReasons.push(`latency: run ${i + 1} host fingerprint mismatch`);
            }
            for (const field of ["affinity", "numa", "power", "cache"] as const) {
                if (evidence[field] !== latencyBaseline.hostEvidence[field]) {
                    latencyReasons.push(`latency: run ${i + 1} ${field} evidence drifted`);
                }
            }
        }
    }
    let cells: LatencyCellFinding[] = [];
    if (latencyReasons.length === 0) {
        const perRunCells = input.candidates.map(reportCellSamples);
        cells = latencyBaseline.cells.map((cell) => {
            const candidateRunP95sMs = perRunCells.map((runCells, i) => {
                const samplesMs = runCells.get(cell.caseId) ?? [];
                if (samplesMs.length === 0) {
                    latencyReasons.push(
                        `latency: run ${i + 1} has no raw samples for ${cell.caseId}`,
                    );
                    return Number.NaN;
                }
                return runLevelP95({ kind: "raw-request-samples", samplesMs });
            }) as [number, number, number];
            if (candidateRunP95sMs.some(Number.isNaN)) {
                return {
                    caseId: cell.caseId,
                    baselineMedianP95Ms: cell.medianP95Ms,
                    candidateRunP95sMs,
                    candidateMedianP95Ms: Number.NaN,
                    withinBound: false,
                };
            }
            const candidateMedianP95Ms = medianOfThree(candidateRunP95sMs);
            // Cross-multiplied percent comparison: the declared equality
            // rule, so a median ratio of exactly 1.10 passes without a
            // floating-point division deciding the boundary.
            const withinBound =
                candidateMedianP95Ms * 100 <=
                cell.medianP95Ms * input.policy.latency.maxMedianP95Percent;
            return {
                caseId: cell.caseId,
                baselineMedianP95Ms: cell.medianP95Ms,
                candidateRunP95sMs,
                candidateMedianP95Ms,
                withinBound,
            };
        });
    }
    if (latencyReasons.length > 0) {
        return finish("quality-only", latencyReasons, quality, {
            status: "non-comparable",
            reasons: latencyReasons,
            cells: [],
        });
    }

    const overBound = cells.filter((cell) => !cell.withinBound);
    if (overBound.length > 0) {
        return finish(
            "policy-fail",
            overBound.map(
                (cell) =>
                    `latency: ${cell.caseId} median p95 ${cell.candidateMedianP95Ms.toFixed(3)}ms exceeds ${input.policy.latency.maxMedianP95Percent}% of baseline ${cell.baselineMedianP95Ms.toFixed(3)}ms`,
            ),
            quality,
            { status: "compared", reasons: [], cells },
        );
    }
    return finish("pass", [], quality, { status: "compared", reasons: [], cells });
}

// ---------------------------------------------------------------------------
// A/A mechanical-integrity check (KTD10).
// ---------------------------------------------------------------------------

export interface AaMechanicalResult {
    schemaVersion: typeof AA_CHECK_SCHEMA_VERSION;
    kind: "mechanical-integrity";
    status: "ok" | "mechanical-failure";
    verdictUnderPolicy: RegressionVerdict;
    maxAbsAverageLossPoints: number;
    /** Identical artifacts must parse to identical per-run values under
     *  both labels; a float residue of the policy's mean arithmetic is
     *  reported but is not a mechanical defect. */
    runValuesExact: boolean;
    maxAbsRunLossPoints: number;
    latencyCellsChecked: number;
    /** Parsing and policy application over identical artifacts must be
     *  exact; any spread is a harness defect, not a noise floor. */
    interpretation: "mechanical integrity of report parsing and policy application over identical artifact/config fingerprints; not a statistical control and not a noise floor";
}

export function aaMechanicalCheck(input: {
    policy: RegressionPolicy;
    report: BenchmarkReport;
}): AaMechanicalResult {
    const runs = [input.report, input.report, input.report];
    const baseline = buildQualityBaseline({
        policy: input.policy,
        reports: runs,
        claimEligibility: "judged-support-only",
        allowIdenticalRuns: true,
    });
    const evaluation = evaluateRegression({
        policy: input.policy,
        baseline,
        candidates: runs,
        allowIdenticalRuns: true,
    });

    // Cross-check two INDEPENDENT computations of the same policy: the
    // p95 recomputed here from raw samples against the p95 the runner
    // recorded in case evidence at run time. Recomputing the same pure
    // function twice over one array would be tautological and could never
    // surface a defect in either pipeline.
    const recordedP95ByCase = new Map<string, number>();
    for (const caseEvidence of input.report.evidence.cases) {
        if (caseEvidence.latencySummary) {
            recordedP95ByCase.set(caseEvidence.caseId, caseEvidence.latencySummary.p95Ms);
        }
    }
    const cells = reportCellSamples(input.report);
    let latencyCellsChecked = 0;
    let latencyExact = true;
    for (const [caseId, samplesMs] of cells) {
        if (samplesMs.length === 0) continue;
        latencyCellsChecked += 1;
        const recordedP95 = recordedP95ByCase.get(caseId);
        // The runner records a summary for every case with samples, so a
        // missing or diverging recorded p95 is a mechanical defect.
        if (recordedP95 === undefined) {
            latencyExact = false;
            continue;
        }
        const recomputedP95 = runLevelP95({ kind: "raw-request-samples", samplesMs });
        if (recomputedP95 !== recordedP95) latencyExact = false;
    }

    const maxAbsAverageLossPoints = Math.max(
        0,
        ...evaluation.quality.map((finding) => Math.abs(finding.averageLossPoints)),
    );
    const maxAbsRunLossPoints = Math.max(
        0,
        ...evaluation.quality.map((finding) => Math.abs(finding.worstRunLossPoints)),
    );
    const candidateValues = [...gateModeValues(input.report).values()].sort((a, b) =>
        a.mode.localeCompare(b.mode),
    );
    const runValuesExact = baseline.runs.every(
        (run) => canonicalFingerprint(run.modes) === canonicalFingerprint(candidateValues),
    );
    const status =
        evaluation.verdict === "quality-only" &&
        maxAbsAverageLossPoints === 0 &&
        runValuesExact &&
        latencyExact
            ? "ok"
            : "mechanical-failure";
    return {
        schemaVersion: AA_CHECK_SCHEMA_VERSION,
        kind: "mechanical-integrity",
        status,
        verdictUnderPolicy: evaluation.verdict,
        maxAbsAverageLossPoints,
        runValuesExact,
        maxAbsRunLossPoints,
        latencyCellsChecked,
        interpretation:
            "mechanical integrity of report parsing and policy application over identical artifact/config fingerprints; not a statistical control and not a noise floor",
    };
}
