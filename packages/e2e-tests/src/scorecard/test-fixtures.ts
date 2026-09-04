import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { METRIC_POLICY_VERSION } from "../../../plugin/scripts/retrieval-benchmark/metrics";
import {
    CANDIDATE_POOL_CONSUMER,
    CANDIDATE_POOL_SCHEMA_VERSION,
    REPORT_SCHEMA_VERSION as RETRIEVAL_REPORT_SCHEMA_VERSION,
    parseReport as parseRetrievalReport,
    type BenchmarkReport,
    type ReportScenario,
} from "../../../plugin/scripts/retrieval-benchmark/report";
import { TIMING_POLICY_VERSION } from "../../../plugin/scripts/retrieval-benchmark/timing";
import { sha256Utf8Hex } from "../../../plugin/src/features/magic-context/memory/storage-claims";
import {
    DREAMER_EVAL_REPORT_SCHEMA,
    parseRunReport as parseDreamerRunReport,
    type ClaimSnapshotProjection,
    type DreamerEvalRunReport,
} from "../dreamer-eval/contract";
import type { SystemVersionTuple } from "../historian-eval/runner";
import { buildLaneReport, type LaneReport as HistorianReport, type ScenarioScore } from "../historian-eval/scorer";
import { buildIncidentReport, computeSelectedSetDigest, type IncidentCaseResult, type IncidentPoolReport } from "../incident-pool/report";
import { buildMetamorphicReport, type MetamorphicReport } from "../metamorphic-eval/report";
import { derivativeScenarioId } from "../metamorphic-eval/transforms";
import { PAIRED_DELTA_POLICY_GATES, PAIRED_DELTA_POLICY_SCHEMA, parsePairedDeltaPolicy, type PairedDeltaPolicy } from "../paired-delta/contract";
import { estimateFamilyDeltas, type FamilyNoiseFloor } from "../paired-delta/estimator";
import { buildPairedDeltaReport, type PairedDeltaReport, type SecondaryMetrics } from "../paired-delta/report";
import type { PairedCaseFact } from "../prospective-holdout/comparison";
import { POLICY_OWNER_SCHEMA, type PolicyOwnerDocument } from "../prospective-holdout/contract";
import { pairedFactsFingerprint } from "../prospective-holdout/report";
import { cellResultFixture, freezeManifest, readyPolicies } from "../prospective-holdout/test-fixtures";
import type { EvidenceSources, LaneEvidence, ScorecardEvidenceBundle } from "./evidence";
import {
    LANE_IDS,
    LANE_REPORT_SCHEMAS,
    SCORECARD_GATE_IDS,
    SCORECARD_POLICY_OWNER,
    SCORECARD_POLICY_SCHEMA,
    SCORE_FAMILY_IDS,
    SLOT_IDS_BY_FAMILY,
    type LaneId,
    type LaneIdentity,
    type ScoreFamilyId,
    type ScorecardPolicy,
} from "./policy";
import {
    SCORECARD_REPORT_SCHEMA,
    deriveOutcome,
    type LaneStatus,
    type ScoreFamilySection,
    type ScorecardReport,
    type ScorecardReportBody,
} from "./report-contract";

export const CANARY_SCENARIO_IDS = ["hse-webhook-docs-injection", "hse-orders-key-conflict"];

export function requiredLanesWith(identities: Partial<Record<LaneId, LaneIdentity>> = {}): ScorecardPolicy["requiredLanes"] {
    return LANE_IDS.map((lane) => ({
        lane,
        schema: LANE_REPORT_SCHEMAS[lane],
        identity: identities[lane] ?? { kind: "identityless" },
    }));
}

export function policyFixture(overrides: Partial<ScorecardPolicy> = {}): ScorecardPolicy {
    return {
        schema: SCORECARD_POLICY_SCHEMA,
        primaryEndpoint: "mc-on-vs-mc-off",
        secondaryMetricSlots: ["final-attempt-tokens-mc-on", "final-attempt-wall-clock-ms-mc-on", "final-attempt-turns-mc-on"],
        gates: [...SCORECARD_GATE_IDS],
        injectionCanaryScenarioIds: [...CANARY_SCENARIO_IDS],
        maxToleratedRegressions: 0,
        statisticalComparison: { bootstrapResamples: 2000, noiseFloorSource: "none" },
        modelMatrix: [{ providerId: "anthropic", modelId: "fixture-model", contextLimit: 8192 }],
        replicateCount: 1,
        releaseCostBudgetUsd: 100,
        requiredLanes: requiredLanesWith(),
        requiredMetricSlots: ["valid-success-delta-mc-on-vs-mc-off"],
        pairedDeltaPolicyFingerprint: PAIRED_DELTA_POLICY_FP,
        baselineScorecardReportFingerprint: null,
        ...overrides,
    };
}

export function policyDocumentFixture(policy: ScorecardPolicy = policyFixture()): PolicyOwnerDocument {
    return {
        schema: POLICY_OWNER_SCHEMA,
        owner: SCORECARD_POLICY_OWNER,
        status: "ready",
        policy,
        policyFingerprint: canonicalFingerprint(policy),
    };
}

// ---------------------------------------------------------------------------
// Lane report fixtures, built through each lane's own builder so the scorecard
// tests consume the same shapes the lanes publish.
// ---------------------------------------------------------------------------

export const H1 = "1".repeat(64);
export const H2 = "2".repeat(64);
export const H3 = "3".repeat(64);
export const H4 = "4".repeat(64);

export const PAIRED_DELTA_POLICY = parsePairedDeltaPolicy({
    schema: PAIRED_DELTA_POLICY_SCHEMA,
    endpoint: "paired-valid-success-delta",
    targetMinimumDetectableDelta: 0.1,
    minimumAnalyzableFamilyCount: 2,
    bootstrapResamples: 2000,
    poolManifestFingerprint: H1,
    modelMatrix: [{ providerId: "anthropic", modelId: "fixture-model", contextLimit: 8192 }],
    replicateCount: 1,
    costBudgetUsd: { calibration: 50, weekly: 50, release: 100 },
    pricesPerMillionTokens: { input: 3, output: 15, cacheCreation: 3.75, cacheRead: 0.3 },
    gates: [...PAIRED_DELTA_POLICY_GATES],
});

export function pairedDeltaPolicyDocumentFixture(policy: PairedDeltaPolicy = PAIRED_DELTA_POLICY): PolicyOwnerDocument {
    return {
        schema: POLICY_OWNER_SCHEMA,
        owner: "magic-context-x4l.14",
        status: "ready",
        policy,
        policyFingerprint: canonicalFingerprint(policy),
    };
}

export const PAIRED_DELTA_POLICY_FP = pairedDeltaPolicyDocumentFixture().policyFingerprint!;

function pairedFact(seed: number): PairedCaseFact {
    return {
        caseId: `case-${"a".repeat(32)}`,
        familyId: "fam-a",
        implementationFingerprint: H2,
        model: "fixture/model",
        seed,
        platform: "linux-x64",
        releaseN: cellResultFixture("release-n", { seed }),
        releaseNMinus1: cellResultFixture("release-n-minus-1", { seed }),
        status: "complete",
    };
}

export const PAIRED_FACTS: PairedCaseFact[] = [pairedFact(9), pairedFact(7)];

export interface PairedDeltaFixtureOptions {
    policyDocument?: PolicyOwnerDocument;
    poolManifestFingerprint?: string;
    pinnedSnapshotId?: string;
    /** Declared alongside a policy document whose own minimum matches it, or the builder refuses the report. */
    minimumAnalyzableFamilyCount?: number;
    /** The live lane binds no prospective pairs; a prospective comparison binds the pairs it compared. */
    pairs?: readonly PairedCaseFact[];
    /** Per-family valid-success deltas at `mc-on-vs-mc-off`; the compaction endpoint sits 0.02 below each so the two are distinguishable. */
    familyDeltas?: Readonly<Record<string, number>>;
    noiseFloors?: readonly FamilyNoiseFloor[];
    runSummary?: Partial<PairedDeltaReport["body"]["runSummary"]>;
    secondaryMetrics?: SecondaryMetrics;
    bootstrapResamples?: number;
}

export function pairedDeltaReportFixture(options: PairedDeltaFixtureOptions = {}): PairedDeltaReport {
    const policyDocument = options.policyDocument ?? pairedDeltaPolicyDocumentFixture();
    const poolManifestFingerprint = options.poolManifestFingerprint ?? H1;
    const pinnedSnapshotId = options.pinnedSnapshotId ?? "fixture-model";
    const pairs = options.pairs ?? [];
    const familyDeltas = options.familyDeltas ?? { "fam-a": 0.3, "fam-b": 0.1 };
    const analysis = estimateFamilyDeltas({
        observations: Object.entries(familyDeltas).flatMap(([familyId, delta]) => [
            { coordinateId: `${familyId}:0`, familyId, endpoint: "mc-on-vs-mc-off" as const, delta, runHealth: "completed" as const },
            { coordinateId: `${familyId}:0`, familyId, endpoint: "mc-on-vs-compaction" as const, delta: delta - 0.02, runHealth: "completed" as const },
            { coordinateId: `${familyId}:1`, familyId, endpoint: "mc-on-vs-mc-off" as const, delta: delta - 0.05, runHealth: "completed" as const },
            { coordinateId: `${familyId}:1`, familyId, endpoint: "mc-on-vs-compaction" as const, delta: delta - 0.07, runHealth: "completed" as const },
            { coordinateId: `${familyId}:0`, familyId, endpoint: "retrieval" as const, delta: 0.1, runHealth: "completed" as const },
        ]),
        minimumAnalyzableFamilyCount: options.minimumAnalyzableFamilyCount ?? 2,
        bootstrapSeed: 17,
        bootstrapResamples: options.bootstrapResamples ?? 2000,
        lane: {
            poolManifestFingerprint,
            pinnedSnapshotId,
            policyFingerprint: policyDocument.policyFingerprint!,
            pairedFactsFingerprint: pairedFactsFingerprint(pairs),
        },
        ...(options.noiseFloors === undefined ? {} : { noiseFloors: options.noiseFloors }),
    });
    return buildPairedDeltaReport({
        poolManifestFingerprint,
        pinnedSnapshotId,
        policyDocument,
        implementationDigest: "impl-digest-fixture",
        limitations: ["fixture caveat"],
        pairs,
        analysis,
        runSummary: {
            status: "completed",
            spentUsd: 12.5,
            observedCostRollouts: 14,
            estimatedCostRollouts: 2,
            refusedRegretLadders: {},
            plannedCoordinates: 4,
            healthyCoordinates: 4,
            evidenceComplete: true,
            calibrationFingerprint: null,
            ...options.runSummary,
        },
        exclusions: [{ armId: "r2", reasonCode: "provider-unavailable", count: 2 }],
        secondaryMetrics: options.secondaryMetrics ?? {
            invalidSuccessRateByArm: { "mc-on": 0.1, "mc-off": 0, compaction: 0.2 },
            finalAttemptTokensByArm: { "mc-on": 1000, "mc-off": 800, compaction: 900 },
            finalAttemptWallClockMsByArm: { "mc-on": 4000, "mc-off": 3000, compaction: 3500 },
            finalAttemptTurnsByArm: { "mc-on": 8, "mc-off": 7, compaction: 7 },
        },
    });
}

export const HISTORIAN_SYSTEM: SystemVersionTuple = {
    repoCommitSha: "c".repeat(40),
    bunVersion: "1.4.0",
    opencodeVersion: "test",
    historianModelId: "scripted-mock",
    probeModelId: "scripted-mock",
    parserImpl: "ts",
    chunkTokenBudget: null,
};

export function scenarioScoreFixture(scenarioId: string, overrides: Partial<ScenarioScore> = {}): ScenarioScore {
    const errored = overrides.verdict === "ERROR";
    return {
        scenarioId,
        verdict: "PASS",
        failReasons: [],
        errorReason: null,
        errorDetail: null,
        precision: errored ? null : 1,
        recall: errored ? null : 1,
        expectedClaimsMatched: errored ? 0 : 2,
        expectedClaimsTotal: errored ? 0 : 2,
        visibleClaimsMatched: errored ? 0 : 2,
        visibleClaimsTotal: errored ? 0 : 2,
        falseAuthoritativeMatches: [],
        structuralFindings: [],
        probeVerdicts: errored
            ? []
            : [{ probeId: "probe-1", outcome: "pass", expected: "yes", actual: "yes" }],
        system: HISTORIAN_SYSTEM,
        source: "run-record",
        ...overrides,
    };
}

export function historianReportFixture(scores: readonly ScenarioScore[] = [scenarioScoreFixture("hse-a"), scenarioScoreFixture("hse-b")]): HistorianReport {
    return buildLaneReport(scores, { releaseVersion: "v2.0.0" });
}

export function metamorphicReportFixture(options: {
    coveredScenarioIds?: readonly string[];
    injectionCanaryHits?: MetamorphicReport["injectionCanaryHits"];
    tierInvalidReason?: MetamorphicReport["tierInvalidReason"];
    /** The raw-output scoring seam publishes no system tuple, runs no control pair, and reports two extra invariants. */
    source?: ScenarioScore["source"];
    /** Entries appended after the scored pairs, for runs that left a pair unscored. */
    extraEntries?: readonly MetamorphicReport["entries"][number][];
    /** Overrides applied to every derivative score, for a run whose derivative role errored. */
    derivativeScore?: Partial<ScenarioScore>;
    /** Coverage violations recorded against the first covered scenario. */
    coverageViolations?: readonly string[];
} = {}): MetamorphicReport {
    const covered = options.coveredScenarioIds ?? CANARY_SCENARIO_IDS;
    const source = options.source ?? "run-record";
    const score = (scenarioId: string, overrides: Partial<ScenarioScore> = {}): ScenarioScore =>
        source === "run-record" ? scenarioScoreFixture(scenarioId, overrides) : scenarioScoreFixture(scenarioId, { system: null, source, probeVerdicts: [], ...overrides });
    const derivativeVerdict = options.derivativeScore?.verdict ?? "PASS";
    const invariants = (derivative: ScenarioScore["verdict"] = "PASS") => [
        { invariant: "injection-set-equality" as const, holds: true, changes: [] },
        ...(source === "raw-output"
            ? [
                { invariant: "expected-absent-empty" as const, holds: true, baselineMatches: [], derivativeMatches: [] },
                { invariant: "verdict-monotonicity" as const, holds: true, baselineVerdict: "PASS" as const, derivativeVerdict: "PASS" as const, introducedFailReasons: [] },
            ]
            : []),
        { invariant: "expectation-predicate-equality" as const, holds: true, changedExpectationIds: [] },
        { invariant: "false-authoritative-set-equality" as const, holds: true, baselineMatches: [], derivativeMatches: [] },
        { invariant: "scenario-verdict-equality" as const, holds: derivative === "PASS", baselineVerdict: "PASS" as const, derivativeVerdict: derivative },
    ];
    const entries: MetamorphicReport["entries"] = covered.flatMap((scenarioId, index) => {
            const pair = { scenarioId, transformId: "reorder-independent-turns", transformVersion: 1, seed: 0 };
            const product = {
                ...pair,
                kind: "scored" as const,
                baselineScore: score(scenarioId),
                derivativeScore: score(derivativeScenarioId(pair), options.derivativeScore ?? {}),
                invariants: invariants(derivativeVerdict),
            };
            return index === 0 && source === "run-record"
                ? [{
                    scenarioId,
                    transformId: "baseline-control" as const,
                    transformVersion: 1,
                    seed: 0,
                    kind: "scored" as const,
                    baselineScore: scenarioScoreFixture(scenarioId),
                    derivativeScore: scenarioScoreFixture(scenarioId),
                    invariants: invariants(),
                }, product]
                : [product];
        });
    return buildMetamorphicReport({
        entries: [...entries, ...(options.extraEntries ?? [])],
        coverage: covered.map((scenarioId, index) => ({ scenarioId, applied: 1, inapplicable: [], violations: index === 0 ? [...(options.coverageViolations ?? [])] : [] })),
        injectionCanaryHits: options.injectionCanaryHits ?? [],
        tierInvalidReason: options.tierInvalidReason ?? null,
        system: source === "run-record" ? HISTORIAN_SYSTEM : null,
    });
}

function dreamerPoolSnapshot(index: number): ClaimSnapshotProjection {
    const publicClaimId = `mcm_${(index + 1).toString(16).padStart(2, "0").repeat(16)}`;
    const content = `Distinct memory content ${index + 1}`;
    return {
        claimId: `claim-${index + 1}`,
        publicClaimId,
        revisionLocator: `${publicClaimId}/r1/${sha256Utf8Hex(content)}`,
        content,
        category: "CONSTRAINTS",
        importance: 50,
        memoryScope: "project",
        sharing: "private",
        lifecycleState: "active",
        files: ["src/a.ts"],
        verificationOutcome: null,
    };
}

export function dreamerReportFixture(overrides: Partial<DreamerEvalRunReport> = {}): DreamerEvalRunReport {
    const pool = Array.from({ length: 10 }, (_, index) => dreamerPoolSnapshot(index));
    const verified = { verified: [{ publicClaimId: pool[0]!.publicClaimId, files: ["src/a.ts"] }], updated: [], archived: [] };
    return parseDreamerRunReport({
        schema: DREAMER_EVAL_REPORT_SCHEMA,
        scenarioId: "dme-core-pool",
        task: "verify",
        runId: "run-1",
        nowMs: 1,
        status: "PASS",
        reason: null,
        runFatal: false,
        system: {
            repoCommitSha: "a".repeat(40),
            bunVersion: "1.4.0",
            opencodeVersion: "1.0.0",
            modelId: "fixture-model",
            platform: "linux",
            parserImpl: "ts",
            pluginEntry: "src",
            runtimeDigest: "d".repeat(64),
        },
        trackedFiles: ["src/a.ts"],
        fixtureRoot: null,
        poolBefore: pool,
        poolAfter: pool,
        rawManifest: `<verify>\n<verified claim="${pool[0]!.publicClaimId}" files="src/a.ts"/>\n</verify>`,
        parsedManifest: verified,
        receiptOutcomes: [],
        ...overrides,
    });
}

/**
 * A dreamer run whose bytes pass the shared privacy scan. A PASS run carries an XML manifest whose
 * closing tags read as absolute paths to the scanner, so the scannable variant is a behavioral FAIL
 * with unparseable output.
 */
export function scannableDreamerReportFixture(): DreamerEvalRunReport {
    return dreamerReportFixture({ status: "FAIL", reason: "invalid-output", rawManifest: "not a manifest", parsedManifest: null });
}

export function incidentResultFixture(overrides: Partial<IncidentCaseResult> = {}): IncidentCaseResult {
    return {
        family_id: "fam-archived-reobservation",
        variant_id: "var-green-one",
        lane: "green",
        semantic_revision_id: "rev-one",
        semantic_fingerprint: H3,
        implementation_digest: H4,
        baseline_event_id: "adj-one",
        baseline_verdict: "green",
        run_health: "completed",
        behavioral_verdict: "pass",
        baseline_comparison: "expected_green",
        failed_checks: [],
        observation_signature: null,
        blocked_by: [],
        reason_code: null,
        ...overrides,
    };
}

export function incidentReportFixture(results: readonly IncidentCaseResult[] = [incidentResultFixture()]): IncidentPoolReport {
    return buildIncidentReport({
        runNonce: "f".repeat(32),
        harness: "opencode",
        ledgerFingerprint: H2,
        selectedSetDigest: computeSelectedSetDigest(results.map((result) => [
            result.variant_id,
            result.semantic_fingerprint,
            result.implementation_digest,
            result.baseline_event_id,
        ])),
        selectedVariantIds: results.map((result) => result.variant_id),
        familyCount: new Set(results.map((result) => result.family_id)).size,
        results,
    });
}

export function retrievalScenarioFixture(
    queryId: string,
    overrides: {
        mode?: ReportScenario["mode"];
        partition?: ReportScenario["partition"];
        paraphraseGroup?: string;
        metricValue?: number;
        duplicateRateAt50?: number | null;
    } = {},
): ReportScenario {
    const metricValue = overrides.metricValue ?? 1;
    return {
        queryId,
        mode: overrides.mode ?? "explicit",
        partition: overrides.partition ?? "holdout",
        paraphraseGroup: overrides.paraphraseGroup ?? `pg-${queryId}`,
        rankedPhysical: ["memory:1", "memory:2"],
        deliveredPhysical: ["memory:1"],
        deliveredTokens: 120,
        deliveryReason: "delivered",
        latencySamplesMs: [4.5, 6.25, 5.5],
        queryEmbedPurpose: null,
        metrics: {
            metricPolicyVersion: METRIC_POLICY_VERSION,
            recallAt10: metricValue,
            recallAt50: metricValue,
            reciprocalRank: metricValue,
            ndcgAt10: metricValue,
            duplicateRateAt50: overrides.duplicateRateAt50 === undefined ? 0 : overrides.duplicateRateAt50,
            contextTokensPerUsefulResult: 120,
            rerankerLift: { status: "not_applicable" },
            coverageAt50: { judged: 1, unjudged: 1, unresolved: 0, duplicates: 0, total: 2 },
        },
        timing: null,
    };
}

export function retrievalReportFixture(options: {
    status?: BenchmarkReport["status"];
    scenarios?: ReportScenario[];
    /** Case ids whose queries the lane treats as diagnostic and excludes from gate aggregates. */
    laneRestrictedCaseIds?: readonly string[];
} = {}): BenchmarkReport {
    const scenarios = options.scenarios ?? [
        retrievalScenarioFixture("case-1:q-1", { mode: "explicit" }),
        retrievalScenarioFixture("case-1:q-2", { mode: "automatic", metricValue: 0.5, duplicateRateAt50: 0.2 }),
    ];
    const caseIds = [...new Set(scenarios.map((scenario) => scenario.queryId.split(":", 1)[0]!))].sort();
    return parseRetrievalReport({
        schemaVersion: RETRIEVAL_REPORT_SCHEMA_VERSION,
        status: options.status ?? "complete",
        semantic: {
            metricPolicyVersion: METRIC_POLICY_VERSION,
            timingPolicyVersion: TIMING_POLICY_VERSION,
            releaseFingerprints: { corpus: H1, judgments: H2, syntheticProfiles: H3, manifest: H4 },
            config: { profile: "ci", candidateK: 100 },
        },
        evidence: {
            attempts: [{
                attemptId: "attempt-1",
                status: "completed",
                startedAtEpochMs: 1_700_000_000_000,
                endedAtEpochMs: 1_700_000_060_000,
                workingDirectory: null,
                diagnostics: [],
            }],
            scenarios,
            cases: caseIds.map((caseId) => ({
                caseId,
                workerCount: 1,
                warmups: 1,
                samplesPerQuery: 3,
                fixture: { manifestFingerprint: H4, indexBuildMs: 250, snapshotBytes: 4096 },
                selectivityObserved: { preFilterDenominator: 100, eligibleCount: 100 },
                cacheLayers: [],
                laneRestricted: options.laneRestrictedCaseIds?.includes(caseId) ?? false,
                latencySummary: null,
            })),
        },
        candidatePool: {
            schemaVersion: CANDIDATE_POOL_SCHEMA_VERSION,
            consumer: CANDIDATE_POOL_CONSUMER,
            topK: 50,
            entries: [],
        },
    });
}

export interface LaneFixtureSet {
    "paired-delta": PairedDeltaReport;
    historian: HistorianReport;
    metamorphic: MetamorphicReport;
    dreamer: DreamerEvalRunReport[];
    incident: IncidentPoolReport;
    retrieval: BenchmarkReport;
}

export function laneFixtures(overrides: Partial<LaneFixtureSet> = {}): LaneFixtureSet {
    return {
        "paired-delta": pairedDeltaReportFixture(),
        historian: historianReportFixture(),
        metamorphic: metamorphicReportFixture(),
        dreamer: [dreamerReportFixture()],
        incident: incidentReportFixture(),
        retrieval: retrievalReportFixture(),
        ...overrides,
    };
}

function unmeasuredFamily(family: ScoreFamilyId): ScoreFamilySection {
    return { family, slots: SLOT_IDS_BY_FAMILY[family].map((id) => ({ id, status: "not-measured", reason: "lane-missing" })) };
}

export function scorecardReportFixture(policy: ScorecardPolicy = policyFixture(), overrides: Partial<ScorecardReportBody> = {}): ScorecardReport {
    const rows: Omit<ScorecardReportBody, "outcome"> = {
        target: {
            freezeManifestFingerprint: H1,
            policyFingerprint: canonicalFingerprint(policy),
            pairedDeltaPolicyFingerprint: policy.pairedDeltaPolicyFingerprint,
            baselineScorecardReportFingerprint: policy.baselineScorecardReportFingerprint,
            requiredMetricSlots: policy.requiredMetricSlots,
            maxToleratedRegressions: policy.maxToleratedRegressions,
        },
        utility: { ...unmeasuredFamily("utility"), family: "utility", familyEstimates: [], deltas: [] },
        formation: unmeasuredFamily("formation"),
        retrieval: unmeasuredFamily("retrieval"),
        context: unmeasuredFamily("context"),
        reliability: unmeasuredFamily("reliability"),
        safetyGates: SCORECARD_GATE_IDS.map((gateId) => ({
            gateId, status: "not-observed", observedCount: null, evidenceFingerprint: null, sourceLane: null, diagnostic: "lane-missing",
        })),
        regret: [],
        adverseDeltas: [],
        limitations: [],
        evidence: {
            lanes: LANE_IDS.map((lane) => ({ lane, status: "missing", reportFingerprint: null, identity: null, diagnostics: ["artifact-missing"] })),
            baseline: policy.baselineScorecardReportFingerprint === null
                ? { status: "absent", reportFingerprint: null }
                : { status: "present", reportFingerprint: policy.baselineScorecardReportFingerprint },
        },
        ...overrides,
    };
    const body: ScorecardReportBody = {
        ...rows,
        outcome: overrides.outcome ?? deriveOutcome({
            gates: rows.safetyGates,
            lanes: rows.evidence.lanes,
            baseline: rows.evidence.baseline.status,
            families: SCORE_FAMILY_IDS.map((family) => rows[family]),
            adverseDeltas: rows.adverseDeltas,
            requiredMetricSlots: rows.target.requiredMetricSlots,
            maxToleratedRegressions: rows.target.maxToleratedRegressions,
        }),
    };
    return { schema: SCORECARD_REPORT_SCHEMA, body, reportFingerprint: canonicalFingerprint(body) };
}

// ---------------------------------------------------------------------------
// A release-shaped directory tree: approved freeze manifest, both policy-owner
// documents, the bound paired-delta policy, and one artifact per lane.
// ---------------------------------------------------------------------------

export interface ReleaseTreeOptions {
    policy?: ScorecardPolicy;
    lanes?: Partial<LaneFixtureSet>;
    /** Lanes whose artifact is deliberately absent. */
    omitLanes?: readonly LaneId[];
    /** Raw artifact bytes that replace the built fixture for a lane. */
    rawArtifacts?: Partial<Record<LaneId, unknown>>;
    pairedDeltaPolicyDocument?: PolicyOwnerDocument;
    baseline?: unknown;
}

export function writeReleaseTree(root: string, options: ReleaseTreeOptions = {}): EvidenceSources {
    const scorecardDocument = policyDocumentFixture(options.policy ?? policyFixture());
    const analysisDocument = readyPolicies().analysis;
    const freeze = freezeManifest();
    freeze.body.policies.analysis.policyFingerprint = analysisDocument.policyFingerprint!;
    freeze.body.policies.scorecard = {
        owner: SCORECARD_POLICY_OWNER,
        schemaVersion: SCORECARD_POLICY_SCHEMA,
        policyFingerprint: scorecardDocument.policyFingerprint!,
    };
    const subjectFingerprint = canonicalFingerprint(freeze.body);
    freeze.approvals = freeze.approvals.map((approval) => ({ ...approval, subjectFingerprint }));
    const paths = {
        freezeDir: join(root, "freeze"),
        policiesDir: join(root, "policies"),
        artifactsDir: join(root, "artifacts"),
        pairedDeltaPolicy: join(root, "paired-delta-policy.json"),
        baseline: join(root, "baseline-scorecard-report.json"),
    };
    for (const dir of [paths.freezeDir, paths.policiesDir, paths.artifactsDir]) mkdirSync(dir, { recursive: true });
    const writeCanonical = (path: string, value: unknown): void => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
    writeCanonical(join(paths.freezeDir, "manifest.json"), freeze);
    writeCanonical(join(paths.policiesDir, "analysis-policy.json"), analysisDocument);
    writeCanonical(join(paths.policiesDir, "scorecard-policy.json"), scorecardDocument);
    writeCanonical(paths.pairedDeltaPolicy, options.pairedDeltaPolicyDocument ?? pairedDeltaPolicyDocumentFixture());
    const lanes = laneFixtures(options.lanes);
    const publish = (path: string, value: unknown): void => writeFileSync(path, `${JSON.stringify(value, null, 4)}\n`);
    for (const lane of LANE_IDS) {
        if (options.omitLanes?.includes(lane)) continue;
        const raw = options.rawArtifacts !== undefined && lane in options.rawArtifacts ? options.rawArtifacts[lane] : lanes[lane];
        publish(join(paths.artifactsDir, `${lane}-report.json`), raw);
    }
    if (options.baseline !== undefined) publish(paths.baseline, options.baseline);
    return {
        freeze: { artifactDir: paths.freezeDir, expectedManifestFingerprint: canonicalFingerprint(freeze) },
        policies: {
            analysisPath: join(paths.policiesDir, "analysis-policy.json"),
            scorecardPath: join(paths.policiesDir, "scorecard-policy.json"),
        },
        pairedDeltaPolicyPath: paths.pairedDeltaPolicy,
        artifactsDir: paths.artifactsDir,
        baselinePath: options.baseline === undefined ? null : paths.baseline,
    };
}

// ---------------------------------------------------------------------------
// An in-memory evidence bundle, for the pure stages after the loader.
// ---------------------------------------------------------------------------

export interface BundleFixtureOptions {
    policy?: ScorecardPolicy;
    lanes?: Partial<LaneFixtureSet>;
    statuses?: Partial<Record<LaneId, LaneStatus>>;
    baseline?: ScorecardReport | null;
    freezeManifestFingerprint?: string;
}

export function bundleFixture(options: BundleFixtureOptions = {}): ScorecardEvidenceBundle {
    const policy = options.policy ?? policyFixture();
    const fixtures = laneFixtures(options.lanes);
    const lanes = LANE_IDS.map((lane): LaneEvidence => {
        const status = options.statuses?.[lane] ?? "present";
        const report = fixtures[lane];
        const retained = status === "present" || status === "incomplete";
        return {
            lane,
            status,
            reportFingerprint: status === "missing" ? null : canonicalFingerprint(report),
            identity: null,
            diagnostics: status === "present" ? [] : [`fixture-${status}`],
            report: retained ? report : null,
        } as LaneEvidence;
    });
    const baseline = options.baseline ?? null;
    return {
        freezeManifestFingerprint: options.freezeManifestFingerprint ?? H1,
        policy,
        policyFingerprint: canonicalFingerprint(policy),
        lanes,
        baseline: baseline === null
            ? { status: "absent", reportFingerprint: null, report: null, diagnostics: [] }
            : { status: "present", reportFingerprint: baseline.reportFingerprint, report: baseline, diagnostics: [] },
        limitations: policy.requiredLanes.filter((row) => row.identity.kind === "identityless").map((row) => `identity-unverified-${row.lane}`),
    };
}
