import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
    canonicalFingerprint,
    readCanonicalJsonFile,
} from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { scanForSensitiveContent } from "../../../plugin/scripts/retrieval-benchmark/privacy";
import {
    computeReportStatus as computeRetrievalReportStatus,
    parseReport as parseRetrievalReport,
    type BenchmarkReport,
} from "../../../plugin/scripts/retrieval-benchmark/report";
import { parseRunReport as parseDreamerRunReport, type DreamerEvalRunReport } from "../dreamer-eval/contract";
import { parseLaneReport as parseHistorianReport, type LaneReport as HistorianReport } from "../historian-eval/scorer";
import { parseIncidentReport, type IncidentPoolReport } from "../incident-pool/report";
import { parseMetamorphicReport, type MetamorphicReport } from "../metamorphic-eval/report";
import { PairedDeltaContractError, parsePairedDeltaPolicy } from "../paired-delta/contract";
import { parsePairedDeltaReport, type PairedDeltaReport } from "../paired-delta/report";
import { HoldoutContractError, parsePolicyOwnerDocument } from "../prospective-holdout/contract";
import { loadFreeze, loadPolicyDocuments } from "../prospective-holdout/freeze";
import { pairedFactsFingerprint } from "../prospective-holdout/report";
import {
    LANE_IDS,
    ScorecardContractError,
    array,
    parseScorecardPolicy,
    reasonCode,
    type LaneId,
    type LaneIdentity,
    type RequiredLane,
    type ScorecardPolicy,
} from "./policy";
import { parseScorecardReport, type BaselineStatus, type LaneStatus, type ScorecardReport } from "./report-contract";

export interface LaneReports {
    "paired-delta": PairedDeltaReport;
    historian: HistorianReport;
    metamorphic: MetamorphicReport;
    /** One archived artifact holds every run report the dreamer lane wrote. */
    dreamer: DreamerEvalRunReport[];
    incident: IncidentPoolReport;
    retrieval: BenchmarkReport;
}

export type LaneEvidence = {
    [L in LaneId]: {
        lane: L;
        status: LaneStatus;
        reportFingerprint: string | null;
        /** The identity the report exposes, whatever the policy asked for; `null` when no report parsed or the lane exposes none. */
        identity: LaneIdentity | null;
        diagnostics: string[];
        report: LaneReports[L] | null;
    };
}[LaneId];

export interface BaselineEvidence {
    status: BaselineStatus;
    reportFingerprint: string | null;
    report: ScorecardReport | null;
    diagnostics: string[];
}

export interface ScorecardEvidenceBundle {
    freezeManifestFingerprint: string;
    policy: ScorecardPolicy;
    policyFingerprint: string;
    lanes: LaneEvidence[];
    baseline: BaselineEvidence;
    limitations: string[];
}

export interface EvidenceSources {
    freeze: { artifactDir: string; expectedManifestFingerprint: string };
    policies: { analysisPath: string; scorecardPath: string };
    pairedDeltaPolicyPath: string;
    artifactsDir: string;
    baselinePath: string | null;
}

export function laneArtifactName(lane: LaneId): string {
    return `${lane}-report.json`;
}

export function laneEvidence<L extends LaneId>(bundle: ScorecardEvidenceBundle, lane: L): Extract<LaneEvidence, { lane: L }> {
    const found = bundle.lanes.find((entry) => entry.lane === lane);
    if (found === undefined) throw new ScorecardContractError([`bundle.lanes: ${lane}-missing`]);
    return found as Extract<LaneEvidence, { lane: L }>;
}

type ParsedLane = { [L in LaneId]: { lane: L; report: LaneReports[L] } }[LaneId];

function parseLane(lane: LaneId, raw: unknown): ParsedLane {
    switch (lane) {
        case "paired-delta":
            return { lane, report: parsePairedDeltaReport(raw) };
        case "historian":
            return { lane, report: parseHistorianReport(raw) };
        case "metamorphic":
            return { lane, report: parseMetamorphicReport(raw) };
        case "dreamer":
            return { lane, report: array(raw, "report").map((entry, index) => parseDreamerRunReport(entry, `report[${index}]`)) };
        case "incident":
            return { lane, report: parseIncidentReport(raw) };
        case "retrieval":
            return { lane, report: parseRetrievalReport(raw) };
    }
}

function observedIdentity(parsed: ParsedLane): LaneIdentity | null {
    switch (parsed.lane) {
        case "paired-delta":
            return { kind: "projection", implementationDigest: parsed.report.body.implementationDigest, pinnedSnapshotId: parsed.report.body.pinnedSnapshotId };
        case "historian":
        case "metamorphic":
            return parsed.report.system === null ? null : { kind: "projection", system: parsed.report.system };
        case "retrieval":
            return { kind: "projection", releaseFingerprints: parsed.report.semantic.releaseFingerprints };
        case "dreamer":
        case "incident":
            return { kind: "identityless" };
    }
}

/** Reason codes for a parsed report whose own run summary says the run did not finish. Empty when the lane completed. */
function runIncompleteReasons(parsed: ParsedLane): string[] {
    switch (parsed.lane) {
        case "paired-delta": {
            // Without a calibration, `evidenceComplete` records pool-sizing validity and says nothing about whether
            // enough families were analyzable, so the estimator's own sufficiency verdict is required alongside it.
            const { runSummary, analysis } = parsed.report.body;
            return runSummary.status === "completed" && runSummary.evidenceComplete && analysis.evidenceSufficient ? [] : ["run-incomplete"];
        }
        case "historian":
            return parsed.report.aggregate.errors > 0 ? ["run-incomplete"] : [];
        case "metamorphic": {
            // A pair that threw, failed admission, was never scored, or whose role scored ERROR is one the run did not
            // finish; a scored pair whose verdict is FAIL or whose invariants failed is a result.
            const { tierInvalidReason, entries } = parsed.report;
            const finished = (entry: MetamorphicReport["entries"][number]): boolean =>
                entry.kind === "scored" && entry.baselineScore.verdict !== "ERROR" && entry.derivativeScore.verdict !== "ERROR";
            return tierInvalidReason === null && entries.length > 0 && entries.every(finished) ? [] : ["run-incomplete"];
        }
        case "dreamer":
            return parsed.report.length > 0 && parsed.report.every((run) => run.status !== "ERROR") ? [] : ["run-incomplete"];
        case "incident":
            return parsed.report.evaluation_complete ? [] : ["run-incomplete"];
        case "retrieval": {
            // The declared status is recomputed from the archived rows. The manifest's expected query ids are not
            // archived with the report, so a missing expected query is the one `incomplete` cause not recoverable here.
            const { scenarios, attempts } = parsed.report.evidence;
            const recomputed = computeRetrievalReportStatus({ expectedQueryIds: [], scenarios, attempts });
            return parsed.report.status === "complete" && recomputed === "complete" && scenarios.length > 0 ? [] : ["run-incomplete"];
        }
    }
}

/** A report whose own rows the lane's contract would refuse is a schema mismatch, however its declared status reads. */
function contradictionReasons(parsed: ParsedLane): string[] {
    if (parsed.lane !== "retrieval") return [];
    const { scenarios, attempts } = parsed.report.evidence;
    return computeRetrievalReportStatus({ expectedQueryIds: [], scenarios, attempts }) === "invalid" ? ["report-parse-failed"] : [];
}

/** The live paired-delta lane analyses its own rollouts and binds the empty prospective pair set. */
const LIVE_PAIRED_FACTS_FINGERPRINT = pairedFactsFingerprint([]);

/**
 * Each lane's report must come from that lane's live producer. The metamorphic producer resolves a system tuple
 * before it scores, while the raw-output scoring seam publishes none; the paired-delta producer binds the empty
 * pair set, while a prospective comparison binds the pairs it compared. The historian parser already refuses
 * raw-output scores itself.
 */
function producerReasons(parsed: ParsedLane): string[] {
    switch (parsed.lane) {
        case "metamorphic":
            return parsed.report.system === null ? ["producer-mismatch"] : [];
        case "paired-delta":
            return parsed.report.body.analysis.pairedFactsFingerprint === LIVE_PAIRED_FACTS_FINGERPRINT ? [] : ["producer-mismatch"];
        default:
            return [];
    }
}

/** The report's binding fields must name the paired-delta policy the scorecard policy pinned, and that policy's pool. */
function pairedDeltaBindingReasons(report: PairedDeltaReport, policy: ScorecardPolicy, pairedDeltaPolicy: PairedDeltaPolicyView): string[] {
    const bound = report.body.policyFingerprint === policy.pairedDeltaPolicyFingerprint
        && report.body.poolManifestFingerprint === pairedDeltaPolicy.poolManifestFingerprint;
    return bound ? [] : ["policy-binding-mismatch"];
}

/** A difference in a pre-registered run setting is a pre-registration mismatch, not a schema problem. */
function pairedDeltaConformanceReasons(report: PairedDeltaReport, policy: ScorecardPolicy, pairedDeltaPolicy: PairedDeltaPolicyView): string[] {
    const body = report.body;
    // The live runner pins the model it runs as the snapshot id, so the snapshot must name a model the policy pre-registered.
    const mismatched = body.analysis.bootstrapResamples !== policy.statisticalComparison.bootstrapResamples
        || body.analysis.minimumAnalyzableFamilyCount !== pairedDeltaPolicy.minimumAnalyzableFamilyCount
        || !pairedDeltaPolicy.modelMatrix.some((model) => model.modelId === body.pinnedSnapshotId)
        // The runner plans one coordinate per selected scenario per replicate, so the plan is a whole number of replicate sets.
        || body.runSummary.plannedCoordinates % pairedDeltaPolicy.replicateCount !== 0
        || (body.runSummary.calibrationFingerprint !== null) !== (policy.statisticalComparison.noiseFloorSource === "calibration")
        || body.runSummary.spentUsd > policy.releaseCostBudgetUsd
        || canonicalFingerprint(pairedDeltaPolicy.modelMatrix) !== canonicalFingerprint(policy.modelMatrix)
        || pairedDeltaPolicy.bootstrapResamples !== policy.statisticalComparison.bootstrapResamples
        || pairedDeltaPolicy.replicateCount !== policy.replicateCount
        || pairedDeltaPolicy.releaseCostBudgetUsd !== policy.releaseCostBudgetUsd;
    return mismatched ? ["pre-registration-mismatch"] : [];
}

function identityReasons(identity: LaneIdentity | null, required: RequiredLane): string[] {
    if (required.identity.kind === "identityless") return [];
    if (identity === null) return ["build-identity-mismatch"];
    return canonicalFingerprint(identity) === canonicalFingerprint(required.identity) ? [] : ["build-identity-mismatch"];
}

interface PairedDeltaPolicyView {
    poolManifestFingerprint: string;
    minimumAnalyzableFamilyCount: number;
    bootstrapResamples: number;
    modelMatrix: ScorecardPolicy["modelMatrix"];
    replicateCount: number;
    releaseCostBudgetUsd: number;
}

function loadPairedDeltaPolicy(path: string, expectedFingerprint: string): PairedDeltaPolicyView {
    const raw = readCanonicalJsonFile(path, (code) => new ScorecardContractError([`paired-delta-policy: ${code}`]));
    if (scanForSensitiveContent(raw).length > 0) throw new ScorecardContractError(["paired-delta-policy: privacy-rejected"]);
    let policy: ReturnType<typeof parsePairedDeltaPolicy>;
    try {
        const document = parsePolicyOwnerDocument(raw, "magic-context-x4l.14");
        if (document.status !== "ready" || document.policyFingerprint !== expectedFingerprint) {
            throw new ScorecardContractError(["scorecard: paired-delta-policy-binding-mismatch"]);
        }
        policy = parsePairedDeltaPolicy(document.policy);
    } catch (error) {
        if (error instanceof HoldoutContractError || error instanceof PairedDeltaContractError) {
            throw new ScorecardContractError(["paired-delta-policy: parse-failed", ...error.diagnostics]);
        }
        throw error;
    }
    return {
        poolManifestFingerprint: policy.poolManifestFingerprint,
        minimumAnalyzableFamilyCount: policy.minimumAnalyzableFamilyCount,
        bootstrapResamples: policy.bootstrapResamples,
        modelMatrix: policy.modelMatrix,
        replicateCount: policy.replicateCount,
        releaseCostBudgetUsd: policy.costBudgetUsd.release,
    };
}

type JsonArtifact = { kind: "missing" } | { kind: "unparseable" } | { kind: "non-canonical" } | { kind: "json"; raw: unknown };

/** The two indentations the repository's publishers write: `publishJsonAtomically` (four) and the runners' direct writes (two). */
const PUBLISHER_INDENTS = [2, 4] as const;

/**
 * A published report must be the bytes one of the repository's publishers writes for its parsed value. Any other
 * byte sequence, such as a duplicate member that `JSON.parse` silently drops, would carry content the privacy scan
 * and the fingerprint never see, so it is refused rather than read. An absent file is a lane outcome. Any other read
 * failure is an infrastructure fault, which must not read as a behavioral failure of the lane, so it aborts the
 * bundle under the module's own error class.
 */
function readJsonArtifact(path: string): JsonArtifact {
    let text: string;
    try {
        text = readFileSync(path, "utf8");
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return { kind: "missing" };
        throw new ScorecardContractError([`artifact: unreadable-${(code ?? "unknown").toLowerCase()}`]);
    }
    let raw: unknown;
    try {
        raw = JSON.parse(text) as unknown;
    } catch {
        return { kind: "unparseable" };
    }
    if (!PUBLISHER_INDENTS.some((indent) => `${JSON.stringify(raw, null, indent)}\n` === text)) return { kind: "non-canonical" };
    return { kind: "json", raw };
}

function loadLane(required: RequiredLane, policy: ScorecardPolicy, pairedDeltaPolicy: PairedDeltaPolicyView, artifactsDir: string): LaneEvidence {
    const lane = required.lane;
    const rejected = (status: LaneStatus, diagnostics: string[], reportFingerprint: string | null = null, identity: LaneIdentity | null = null): LaneEvidence =>
        ({ lane, status, reportFingerprint, identity, diagnostics, report: null });
    const artifact = readJsonArtifact(join(artifactsDir, laneArtifactName(lane)));
    if (artifact.kind === "missing") return rejected("missing", ["artifact-missing"]);
    if (artifact.kind === "unparseable") return rejected("schema-mismatch", ["artifact-invalid-json"]);
    if (artifact.kind === "non-canonical") return rejected("schema-mismatch", ["artifact-non-canonical"]);
    if (scanForSensitiveContent(artifact.raw).length > 0) return rejected("schema-mismatch", ["privacy-rejected"]);
    // A value that round-tripped through `JSON.stringify` has nothing `canonicalFingerprint` refuses.
    const reportFingerprint = canonicalFingerprint(artifact.raw);
    let parsed: ParsedLane;
    try {
        parsed = parseLane(lane, artifact.raw);
    } catch {
        return rejected("schema-mismatch", ["report-parse-failed"], reportFingerprint);
    }
    const identity = observedIdentity(parsed);
    const rejectedReasons = [
        ...contradictionReasons(parsed),
        ...producerReasons(parsed),
        ...(parsed.lane === "paired-delta" ? pairedDeltaBindingReasons(parsed.report, policy, pairedDeltaPolicy) : []),
    ];
    if (rejectedReasons.length > 0) return rejected("schema-mismatch", rejectedReasons, reportFingerprint, identity);
    const diagnostics = [
        ...runIncompleteReasons(parsed),
        ...(parsed.lane === "paired-delta" ? pairedDeltaConformanceReasons(parsed.report, policy, pairedDeltaPolicy) : []),
        ...identityReasons(identity, required),
    ].map(reasonCode);
    return { ...parsed, status: diagnostics.length === 0 ? "present" : "incomplete", reportFingerprint, identity, diagnostics } as LaneEvidence;
}

function loadBaseline(policy: ScorecardPolicy, path: string | null): BaselineEvidence {
    const expected = policy.baselineScorecardReportFingerprint;
    if (expected === null) return { status: "absent", reportFingerprint: null, report: null, diagnostics: [] };
    const mismatch = (code: string): BaselineEvidence => ({ status: "schema-mismatch", reportFingerprint: null, report: null, diagnostics: [reasonCode(code)] });
    if (path === null) return mismatch("baseline-path-missing");
    const artifact = readJsonArtifact(path);
    if (artifact.kind === "missing") return mismatch("baseline-unreadable");
    if (artifact.kind === "unparseable") return mismatch("baseline-invalid-json");
    if (artifact.kind === "non-canonical") return mismatch("baseline-non-canonical");
    let report: ScorecardReport;
    if (scanForSensitiveContent(artifact.raw).length > 0) return mismatch("baseline-privacy-rejected");
    try {
        report = parseScorecardReport(artifact.raw);
    } catch {
        return mismatch("baseline-parse-failed");
    }
    if (report.reportFingerprint !== expected) return mismatch("baseline-fingerprint-mismatch");
    return { status: "present", reportFingerprint: report.reportFingerprint, report, diagnostics: [] };
}

/**
 * The only scorecard stage that touches the filesystem. Freeze binding runs before any lane file is
 * read, so a policy the freeze manifest does not bind produces no evidence at all.
 */
export function loadEvidenceBundle(sources: EvidenceSources): ScorecardEvidenceBundle {
    let policyDocuments: ReturnType<typeof loadPolicyDocuments>;
    let freezeManifestFingerprint: string;
    try {
        policyDocuments = loadPolicyDocuments(sources.policies.analysisPath, sources.policies.scorecardPath);
        freezeManifestFingerprint = loadFreeze(sources.freeze.artifactDir, sources.freeze.expectedManifestFingerprint, policyDocuments).manifestFingerprint;
    } catch (error) {
        if (error instanceof HoldoutContractError) throw new ScorecardContractError(["scorecard: policy-not-frozen", ...error.diagnostics]);
        throw error;
    }
    // `loadFreeze` has already refused a pending scorecard policy, so this only narrows the type.
    const policyFingerprint = policyDocuments.scorecard.policyFingerprint;
    if (policyFingerprint === null) throw new ScorecardContractError(["scorecard: policy-not-frozen"]);
    const policy = parseScorecardPolicy(policyDocuments.scorecard.policy);
    const pairedDeltaPolicy = loadPairedDeltaPolicy(sources.pairedDeltaPolicyPath, policy.pairedDeltaPolicyFingerprint);
    const lanes = LANE_IDS.map((lane) => {
        const required = policy.requiredLanes.find((row) => row.lane === lane)!;
        return loadLane(required, policy, pairedDeltaPolicy, sources.artifactsDir);
    });
    return {
        freezeManifestFingerprint,
        policy,
        policyFingerprint,
        lanes,
        baseline: loadBaseline(policy, sources.baselinePath),
        limitations: policy.requiredLanes
            .filter((row) => row.identity.kind === "identityless")
            .map((row) => reasonCode(`identity-unverified-${row.lane}`)),
    };
}
