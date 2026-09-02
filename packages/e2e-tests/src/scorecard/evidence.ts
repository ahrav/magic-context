import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
    canonicalFingerprint,
    readCanonicalJsonFile,
} from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { scanForSensitiveContent } from "../../../plugin/scripts/retrieval-benchmark/privacy";
import { parseReport as parseRetrievalReport, type BenchmarkReport } from "../../../plugin/scripts/retrieval-benchmark/report";
import { parseRunReport as parseDreamerRunReport, type DreamerEvalRunReport } from "../dreamer-eval/contract";
import { parseLaneReport as parseHistorianReport, type LaneReport as HistorianReport } from "../historian-eval/scorer";
import { parseIncidentReport, type IncidentPoolReport } from "../incident-pool/report";
import { parseMetamorphicReport, type MetamorphicReport } from "../metamorphic-eval/report";
import { parsePairedDeltaPolicy } from "../paired-delta/contract";
import { parsePairedDeltaReport, type PairedDeltaReport } from "../paired-delta/report";
import { HoldoutContractError, parsePolicyOwnerDocument } from "../prospective-holdout/contract";
import { loadFreeze, loadPolicyDocuments } from "../prospective-holdout/freeze";
import {
    LANE_IDS,
    SCORECARD_POLICY_OWNER,
    SECONDARY_SLOT_SOURCES,
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
            const summary = parsed.report.body.runSummary;
            return summary.status === "completed" && summary.evidenceComplete ? [] : ["run-incomplete"];
        }
        case "historian":
            return parsed.report.aggregate.errors > 0 ? ["run-incomplete"] : [];
        case "metamorphic":
            return parsed.report.tierInvalidReason === null ? [] : ["run-incomplete"];
        case "dreamer":
            return parsed.report.length > 0 && parsed.report.every((run) => run.status !== "ERROR") ? [] : ["run-incomplete"];
        case "incident":
            return parsed.report.evaluation_complete ? [] : ["run-incomplete"];
        case "retrieval":
            return parsed.report.status === "complete" ? [] : ["run-incomplete"];
    }
}

function pairedDeltaBindingReasons(report: PairedDeltaReport, policy: ScorecardPolicy): string[] {
    return report.body.policyFingerprint === policy.pairedDeltaPolicyFingerprint ? [] : ["policy-binding-mismatch"];
}

/** Every pre-registered run setting the paired-delta report can show is compared here; a difference is a pre-registration mismatch, not a schema problem. */
function pairedDeltaConformanceReasons(report: PairedDeltaReport, policy: ScorecardPolicy, pairedDeltaPolicy: PairedDeltaPolicyView): string[] {
    const body = report.body;
    const mismatched = body.analysis.endpoints.every((estimate) => estimate.endpoint !== policy.primaryEndpoint)
        || policy.secondaryMetricSlots.some((slot) => {
            const source = SECONDARY_SLOT_SOURCES[slot]!;
            return body.secondaryMetrics[source.metric][source.arm] === undefined;
        })
        || body.analysis.bootstrapResamples !== policy.statisticalComparison.bootstrapResamples
        || (body.runSummary.calibrationFingerprint !== null) !== (policy.statisticalComparison.noiseFloorSource === "calibration")
        || body.runSummary.spentUsd > policy.releaseCostBudgetUsd
        || canonicalFingerprint(pairedDeltaPolicy.modelMatrix) !== canonicalFingerprint(policy.modelMatrix)
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
    modelMatrix: ScorecardPolicy["modelMatrix"];
    replicateCount: number;
    releaseCostBudgetUsd: number;
}

function loadPairedDeltaPolicy(path: string, expectedFingerprint: string): PairedDeltaPolicyView {
    const raw = readCanonicalJsonFile(path, (code) => new ScorecardContractError([`paired-delta-policy: ${code}`]));
    const document = parsePolicyOwnerDocument(raw, "magic-context-x4l.14");
    if (document.status !== "ready" || document.policyFingerprint !== expectedFingerprint) {
        throw new ScorecardContractError(["scorecard: paired-delta-policy-binding-mismatch"]);
    }
    const policy = parsePairedDeltaPolicy(document.policy);
    return { modelMatrix: policy.modelMatrix, replicateCount: policy.replicateCount, releaseCostBudgetUsd: policy.costBudgetUsd.release };
}

function readLaneArtifact(path: string): { kind: "missing" } | { kind: "unparseable" } | { kind: "json"; raw: unknown } {
    if (!existsSync(path)) return { kind: "missing" };
    try {
        return { kind: "json", raw: JSON.parse(readFileSync(path, "utf8")) as unknown };
    } catch {
        return { kind: "unparseable" };
    }
}

function loadLane(required: RequiredLane, policy: ScorecardPolicy, pairedDeltaPolicy: PairedDeltaPolicyView, artifactsDir: string): LaneEvidence {
    const lane = required.lane;
    const artifact = readLaneArtifact(join(artifactsDir, laneArtifactName(lane)));
    if (artifact.kind === "missing") return { lane, status: "missing", reportFingerprint: null, identity: null, diagnostics: ["artifact-missing"], report: null };
    if (artifact.kind === "unparseable") return { lane, status: "schema-mismatch", reportFingerprint: null, identity: null, diagnostics: ["artifact-invalid-json"], report: null };
    if (scanForSensitiveContent(artifact.raw).length > 0) {
        return { lane, status: "schema-mismatch", reportFingerprint: null, identity: null, diagnostics: ["privacy-rejected"], report: null };
    }
    const reportFingerprint = canonicalFingerprint(artifact.raw);
    let parsed: ParsedLane;
    try {
        parsed = parseLane(lane, artifact.raw);
    } catch {
        return { lane, status: "schema-mismatch", reportFingerprint, identity: null, diagnostics: ["report-parse-failed"], report: null };
    }
    const identity = observedIdentity(parsed);
    const bindingReasons = parsed.lane === "paired-delta" ? pairedDeltaBindingReasons(parsed.report, policy) : [];
    if (bindingReasons.length > 0) {
        return { lane, status: "schema-mismatch", reportFingerprint, identity, diagnostics: bindingReasons, report: null };
    }
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
    let raw: unknown;
    try {
        raw = readCanonicalJsonFile(path, (code) => new ScorecardContractError([code]));
    } catch (error) {
        return mismatch(`baseline-${error instanceof ScorecardContractError ? error.diagnostics[0]! : "unreadable"}`);
    }
    if (scanForSensitiveContent(raw).length > 0) return mismatch("baseline-privacy-rejected");
    let report: ScorecardReport;
    try {
        report = parseScorecardReport(raw);
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
    if (policyDocuments.scorecard.owner !== SCORECARD_POLICY_OWNER || policyDocuments.scorecard.policyFingerprint === null) {
        throw new ScorecardContractError(["scorecard: policy-not-frozen"]);
    }
    const policy = parseScorecardPolicy(policyDocuments.scorecard.policy);
    const pairedDeltaPolicy = loadPairedDeltaPolicy(sources.pairedDeltaPolicyPath, policy.pairedDeltaPolicyFingerprint);
    const lanes = LANE_IDS.map((lane) => {
        const required = policy.requiredLanes.find((row) => row.lane === lane)!;
        return loadLane(required, policy, pairedDeltaPolicy, sources.artifactsDir);
    });
    return {
        freezeManifestFingerprint,
        policy,
        policyFingerprint: policyDocuments.scorecard.policyFingerprint,
        lanes,
        baseline: loadBaseline(policy, sources.baselinePath),
        limitations: policy.requiredLanes
            .filter((row) => row.identity.kind === "identityless")
            .map((row) => reasonCode(`identity-unverified-${row.lane}`)),
    };
}
