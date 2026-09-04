import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import type { BenchmarkReport } from "../../../plugin/scripts/retrieval-benchmark/report";
import { parseMetamorphicReport } from "../metamorphic-eval/report";
import type { PolicyOwnerDocument } from "../prospective-holdout/contract";
import { laneEvidence, loadEvidenceBundle, type EvidenceSources } from "./evidence";
import { LANE_IDS, ScorecardContractError } from "./policy";
import {
    CANARY_SCENARIO_IDS,
    H2,
    HISTORIAN_SYSTEM,
    PAIRED_DELTA_POLICY,
    PAIRED_DELTA_POLICY_FP,
    PAIRED_FACTS,
    dreamerReportFixture,
    historianReportFixture,
    incidentReportFixture,
    incidentResultFixture,
    laneFixtures,
    metamorphicReportFixture,
    pairedDeltaPolicyDocumentFixture,
    pairedDeltaReportFixture,
    policyFixture,
    requiredLanesWith,
    retrievalReportFixture,
    retrievalScenarioFixture,
    scannableDreamerReportFixture,
    scenarioScoreFixture,
    scorecardReportFixture,
    writeReleaseTree,
    type ReleaseTreeOptions,
} from "./test-fixtures";

const roots: string[] = [];

function tree(options: ReleaseTreeOptions = {}): EvidenceSources {
    const root = mkdtempSync(join(tmpdir(), "scorecard-evidence-"));
    roots.push(root);
    return writeReleaseTree(root, { lanes: { dreamer: [scannableDreamerReportFixture()] }, ...options });
}

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function statuses(sources: EvidenceSources): Record<string, string> {
    return Object.fromEntries(loadEvidenceBundle(sources).lanes.map((lane) => [lane.lane, lane.status]));
}

describe("loadEvidenceBundle", () => {
    it("refuses when the freeze manifest binds another policy and reads no lane file", () => {
        const sources = tree();
        const other = tree({ policy: policyFixture({ maxToleratedRegressions: 3 }) });
        const swapped: EvidenceSources = { ...sources, policies: other.policies };
        expect(() => loadEvidenceBundle(swapped)).toThrow(ScorecardContractError);
        expect(() => loadEvidenceBundle(swapped)).toThrow(/scorecard: policy-not-frozen/);
        const unreadable: EvidenceSources = { ...swapped, artifactsDir: join(sources.artifactsDir, "absent") };
        expect(() => loadEvidenceBundle(unreadable)).toThrow(/policy-not-frozen/);
    });

    it("refuses when the bound paired-delta policy document differs from the pre-registered fingerprint", () => {
        const sources = tree({
            pairedDeltaPolicyDocument: pairedDeltaPolicyDocumentFixture({ ...PAIRED_DELTA_POLICY, replicateCount: 2 }),
        });
        expect(() => loadEvidenceBundle(sources)).toThrow(/paired-delta-policy-binding-mismatch/);
    });

    it("marks every conformant lane present with distinct fingerprints that ignore serialization whitespace", () => {
        const bundle = loadEvidenceBundle(tree());
        expect(bundle.lanes.map((lane) => lane.lane)).toEqual([...LANE_IDS]);
        expect(bundle.lanes.every((lane) => lane.status === "present")).toBe(true);
        const fingerprints = bundle.lanes.map((lane) => lane.reportFingerprint);
        expect(new Set(fingerprints).size).toBe(LANE_IDS.length);
        // Artifacts are written with four-space indentation; the fingerprint is of the parsed value.
        expect(laneEvidence(bundle, "paired-delta").reportFingerprint).toBe(canonicalFingerprint(pairedDeltaReportFixture()));
        expect(bundle.baseline).toEqual({ status: "absent", reportFingerprint: null, report: null, diagnostics: [] });
        expect(bundle.limitations).toEqual(LANE_IDS.map((lane) => `identity-unverified-${lane}`));
    });

    it("marks an absent artifact missing and an unparseable or privacy-violating one schema-mismatch", () => {
        expect(statuses(tree({ omitLanes: ["historian"] })).historian).toBe("missing");
        const bundle = loadEvidenceBundle(tree({ rawArtifacts: { incident: { schema: "incident-pool-report/v1" } } }));
        expect(laneEvidence(bundle, "incident")).toMatchObject({ status: "schema-mismatch", diagnostics: ["report-parse-failed"] });
        const leaked = loadEvidenceBundle(tree({
            rawArtifacts: { historian: { ...historianReportFixture(), releaseVersion: "/home/operator/build" } },
        }));
        expect(laneEvidence(bundle, "incident").report).toBeNull();
        expect(laneEvidence(leaked, "historian")).toMatchObject({ status: "schema-mismatch", diagnostics: ["privacy-rejected"], reportFingerprint: null });
        // A PASS dreamer run carries an XML manifest the shared scan reads as a path, so the built fixture is rejected before parse.
        expect(statuses(tree({ lanes: { dreamer: [dreamerReportFixture()] } })).dreamer).toBe("schema-mismatch");
    });

    it("lowers each lane to incomplete when its own run summary says the run did not finish", () => {
        expect(statuses(tree({ lanes: { "paired-delta": pairedDeltaReportFixture({ runSummary: { evidenceComplete: false } }) } }))["paired-delta"]).toBe("incomplete");
        expect(statuses(tree({ lanes: { metamorphic: metamorphicReportFixture({ tierInvalidReason: { kind: "incomplete" } }) } })).metamorphic).toBe("incomplete");
        // A pair the live run never scored leaves `tierInvalidReason` null, and the lane's own exit code still calls the run a failure.
        const unscored = metamorphicReportFixture({
            extraEntries: [{ scenarioId: CANARY_SCENARIO_IDS[0]!, transformId: "reorder-independent-turns", transformVersion: 1, seed: 1, kind: "error", error: "role threw" }],
        });
        expect(unscored.tierInvalidReason).toBeNull();
        expect(statuses(tree({ lanes: { metamorphic: unscored } })).metamorphic).toBe("incomplete");
        // A derivative role that scored ERROR is packaged as a scored pair, and is still a pair the run did not finish.
        const erroredRole = metamorphicReportFixture({
            derivativeScore: { verdict: "ERROR", errorReason: "run-never-fired", precision: null, recall: null, expectedClaimsMatched: 0, expectedClaimsTotal: 0, visibleClaimsMatched: 0, visibleClaimsTotal: 0, probeVerdicts: [] },
        });
        expect(erroredRole.tierInvalidReason).toBeNull();
        expect(statuses(tree({ lanes: { metamorphic: erroredRole } })).metamorphic).toBe("incomplete");
        const violated = metamorphicReportFixture({ coverageViolations: ["no transforms applied"] });
        expect(statuses(tree({ lanes: { metamorphic: violated } })).metamorphic).toBe("incomplete");
        expect(statuses(tree({
            lanes: { historian: historianReportFixture([scenarioScoreFixture("hse-a", { verdict: "ERROR", errorReason: "run-never-fired", precision: null, recall: null })]) },
        })).historian).toBe("incomplete");
        expect(statuses(tree({
            lanes: {
                incident: incidentReportFixture([incidentResultFixture({
                    run_health: "timeout", behavioral_verdict: "not_evaluated", baseline_comparison: "unscored", reason_code: "deadline_exceeded",
                })]),
            },
        })).incident).toBe("incomplete");
        expect(statuses(tree({
            lanes: { dreamer: [dreamerReportFixture({ status: "ERROR", reason: "provider-failure", rawManifest: null, parsedManifest: null, poolBefore: [], poolAfter: [] })] },
        })).dreamer).toBe("incomplete");
        expect(statuses(tree({ lanes: { retrieval: retrievalReportFixture({ status: "incomplete" }) } })).retrieval).toBe("incomplete");
        const bundle = loadEvidenceBundle(tree({ lanes: { "paired-delta": pairedDeltaReportFixture({ runSummary: { evidenceComplete: false } }) } }));
        expect(laneEvidence(bundle, "paired-delta")).toMatchObject({ diagnostics: ["run-incomplete"] });
        expect(laneEvidence(bundle, "paired-delta").report).not.toBeNull();
    });

    it("refuses an artifact whose bytes no publisher would write, so no member can hide from the scan", () => {
        const sources = tree();
        const incident = JSON.parse(readFileSync(join(sources.artifactsDir, "incident-report.json"), "utf8")) as Record<string, unknown>;
        // A duplicated member: JSON.parse keeps the last value, so the first would never reach the scan or the fingerprint.
        const shadowed = `{"harness": "/home/operator/secret", ${JSON.stringify(incident, null, 4).slice(1)}`;
        writeFileSync(join(sources.artifactsDir, "incident-report.json"), `${shadowed}\n`);
        expect(laneEvidence(loadEvidenceBundle(sources), "incident")).toMatchObject({ status: "schema-mismatch", diagnostics: ["artifact-non-canonical"], reportFingerprint: null });
        // Both publisher indentations are accepted; any other whitespace is not.
        writeFileSync(join(sources.artifactsDir, "incident-report.json"), `${JSON.stringify(incident, null, 2)}\n`);
        expect(laneEvidence(loadEvidenceBundle(sources), "incident").status).toBe("present");
        writeFileSync(join(sources.artifactsDir, "incident-report.json"), JSON.stringify(incident));
        expect(laneEvidence(loadEvidenceBundle(sources), "incident")).toMatchObject({ status: "schema-mismatch", diagnostics: ["artifact-non-canonical"] });
    });

    it("rejects a paired-delta report bound to a prospective pair set", () => {
        // The live lane binds the empty pair set; a report that compared release pairs came from the holdout comparison.
        const prospective = pairedDeltaReportFixture({ pairs: PAIRED_FACTS });
        const bundle = loadEvidenceBundle(tree({ lanes: { "paired-delta": prospective } }));
        expect(laneEvidence(bundle, "paired-delta")).toMatchObject({ status: "schema-mismatch", diagnostics: ["producer-mismatch"], report: null });
    });

    it("rejects a metamorphic report from the raw-output scoring seam", () => {
        // The raw-output seam scores without a system tuple; the live producer always publishes one.
        const rawMetamorphic = metamorphicReportFixture({ source: "raw-output" });
        expect(rawMetamorphic.system).toBeNull();
        expect(() => parseMetamorphicReport(rawMetamorphic)).not.toThrow();
        const bundle = loadEvidenceBundle(tree({ lanes: { metamorphic: rawMetamorphic } }));
        expect(laneEvidence(bundle, "metamorphic")).toMatchObject({ status: "schema-mismatch", diagnostics: ["producer-mismatch"], report: null });
    });

    it("lowers paired-delta to incomplete when the estimator found too few analyzable families", () => {
        // One family is below the pre-registered minimum of two, and without a calibration the run summary can still say complete.
        const insufficient = pairedDeltaReportFixture({ familyDeltas: { "fam-a": 0.3 } });
        expect(insufficient.body.analysis.evidenceSufficient).toBe(false);
        expect(insufficient.body.runSummary.evidenceComplete).toBe(true);
        const bundle = loadEvidenceBundle(tree({ lanes: { "paired-delta": insufficient } }));
        expect(laneEvidence(bundle, "paired-delta")).toMatchObject({ status: "incomplete", diagnostics: ["run-incomplete"] });
    });

    it("recomputes retrieval completeness from the archived scenarios and attempts", () => {
        const declared = (report: BenchmarkReport): BenchmarkReport => ({ ...report, status: "complete" });
        const noScenarios = declared(retrievalReportFixture({ scenarios: [] }));
        expect(statuses(tree({ lanes: { retrieval: noScenarios } })).retrieval).toBe("incomplete");
        // Duplicate query ids are a report the retrieval contract itself calls invalid, not a run that stopped early.
        const duplicated = declared(retrievalReportFixture({ scenarios: [retrievalScenarioFixture("case-1:q-1"), retrievalScenarioFixture("case-1:q-1")] }));
        expect(laneEvidence(loadEvidenceBundle(tree({ lanes: { retrieval: duplicated } })), "retrieval"))
            .toMatchObject({ status: "schema-mismatch", diagnostics: ["report-parse-failed"] });
        const complete = retrievalReportFixture();
        const interrupted = declared({
            ...complete,
            evidence: { ...complete.evidence, attempts: complete.evidence.attempts.map((attempt) => ({ ...attempt, status: "interrupted" as const })) },
        });
        expect(statuses(tree({ lanes: { retrieval: interrupted } })).retrieval).toBe("incomplete");
    });

    it("rejects a paired-delta report bound to another paired-delta policy as schema-mismatch", () => {
        const foreign = pairedDeltaPolicyDocumentFixture({ ...PAIRED_DELTA_POLICY, replicateCount: 2 });
        const bundle = loadEvidenceBundle(tree({ lanes: { "paired-delta": pairedDeltaReportFixture({ policyDocument: foreign }) } }));
        expect(laneEvidence(bundle, "paired-delta")).toMatchObject({ status: "schema-mismatch", diagnostics: ["policy-binding-mismatch"] });
        // The report names the pinned policy but a pool the loaded paired-delta policy does not name.
        const otherPool = loadEvidenceBundle(tree({ lanes: { "paired-delta": pairedDeltaReportFixture({ poolManifestFingerprint: H2 }) } }));
        expect(laneEvidence(otherPool, "paired-delta")).toMatchObject({ status: "schema-mismatch", diagnostics: ["policy-binding-mismatch"] });
    });

    it("lowers paired-delta to incomplete when a pre-registered run setting differs", () => {
        const twoModels = policyFixture({
            modelMatrix: [...policyFixture().modelMatrix, { providerId: "anthropic", modelId: "second-model", contextLimit: 8192 }],
        });
        const modelBundle = loadEvidenceBundle(tree({ policy: twoModels }));
        expect(laneEvidence(modelBundle, "paired-delta")).toMatchObject({ status: "incomplete", diagnostics: ["pre-registration-mismatch"] });
        const overBudget = loadEvidenceBundle(tree({ lanes: { "paired-delta": pairedDeltaReportFixture({ runSummary: { spentUsd: 1000 } }) } }));
        expect(laneEvidence(overBudget, "paired-delta")).toMatchObject({ status: "incomplete", diagnostics: ["pre-registration-mismatch"] });
        const wrongResamples = loadEvidenceBundle(tree({ lanes: { "paired-delta": pairedDeltaReportFixture({ bootstrapResamples: 2500 }) } }));
        expect(laneEvidence(wrongResamples, "paired-delta").status).toBe("incomplete");
        // The scorecard policy and the pinned paired-delta policy must agree on the resample count the runner takes from the latter.
        const disagreeing = loadEvidenceBundle(tree({ policy: policyFixture({ statisticalComparison: { bootstrapResamples: 2500, noiseFloorSource: "none" } }) }));
        expect(laneEvidence(disagreeing, "paired-delta")).toMatchObject({ status: "incomplete", diagnostics: ["pre-registration-mismatch"] });
        const noiseSource = loadEvidenceBundle(tree({ policy: policyFixture({ statisticalComparison: { bootstrapResamples: 2000, noiseFloorSource: "calibration" } }) }));
        expect(laneEvidence(noiseSource, "paired-delta").status).toBe("incomplete");
        const missingSecondary = loadEvidenceBundle(tree({ policy: policyFixture({ secondaryMetricSlots: ["final-attempt-tokens-mc-on", "invalid-success-rate-mc-off"] }) }));
        expect(laneEvidence(missingSecondary, "paired-delta").status).toBe("present");
        // The report stamps the pinned policy fingerprint but declares a looser minimum than the loaded policy pre-registered.
        const looserMinimum = { ...pairedDeltaReportFixture({
            policyDocument: pairedDeltaPolicyDocumentFixture({ ...PAIRED_DELTA_POLICY, minimumAnalyzableFamilyCount: 1 }),
            minimumAnalyzableFamilyCount: 1,
        }) };
        looserMinimum.body = { ...looserMinimum.body, policyFingerprint: PAIRED_DELTA_POLICY_FP, analysis: { ...looserMinimum.body.analysis, policyFingerprint: PAIRED_DELTA_POLICY_FP } };
        looserMinimum.reportFingerprint = canonicalFingerprint(looserMinimum.body);
        const restamped = loadEvidenceBundle(tree({ lanes: { "paired-delta": looserMinimum } }));
        expect(laneEvidence(restamped, "paired-delta")).toMatchObject({ status: "incomplete", diagnostics: ["pre-registration-mismatch"] });
        const foreignSnapshot = loadEvidenceBundle(tree({ lanes: { "paired-delta": pairedDeltaReportFixture({ pinnedSnapshotId: "other-model" }) } }));
        expect(laneEvidence(foreignSnapshot, "paired-delta")).toMatchObject({ status: "incomplete", diagnostics: ["pre-registration-mismatch"] });
    });

    it("verifies projected build identity and records identityless lanes as limitations", () => {
        const matching = policyFixture({
            requiredLanes: requiredLanesWith({
                historian: { kind: "projection", system: HISTORIAN_SYSTEM },
                "paired-delta": { kind: "projection", implementationDigest: "impl-digest-fixture", pinnedSnapshotId: "fixture-model" },
            }),
        });
        const bundle = loadEvidenceBundle(tree({ policy: matching }));
        expect(laneEvidence(bundle, "historian").status).toBe("present");
        expect(laneEvidence(bundle, "paired-delta").status).toBe("present");
        expect(bundle.limitations).toEqual(["identity-unverified-metamorphic", "identity-unverified-dreamer", "identity-unverified-incident", "identity-unverified-retrieval"]);
        const drifted = policyFixture({
            requiredLanes: requiredLanesWith({ historian: { kind: "projection", system: { ...HISTORIAN_SYSTEM, repoCommitSha: "d".repeat(40) } } }),
        });
        const driftedBundle = loadEvidenceBundle(tree({ policy: drifted }));
        expect(laneEvidence(driftedBundle, "historian")).toMatchObject({ status: "incomplete", diagnostics: ["build-identity-mismatch"] });
        expect(laneEvidence(driftedBundle, "historian").identity).toEqual({ kind: "projection", system: HISTORIAN_SYSTEM });
    });

    it("loads a baseline only when its fingerprint matches the policy", () => {
        const laneSet = laneFixtures({ dreamer: [scannableDreamerReportFixture()] });
        const baseline = scorecardReportFixture();
        const policy = policyFixture({ baselineScorecardReportFingerprint: baseline.reportFingerprint });
        const missingPath = loadEvidenceBundle(tree({ policy, lanes: laneSet }));
        expect(missingPath.baseline).toMatchObject({ status: "schema-mismatch", diagnostics: ["baseline-path-missing"] });
        const wrongBytes = loadEvidenceBundle(tree({ policy, lanes: laneSet, baseline: { ...baseline, body: {} } }));
        expect(wrongBytes.baseline).toMatchObject({ status: "schema-mismatch", diagnostics: ["baseline-parse-failed"] });
        const other = scorecardReportFixture(policyFixture({ maxToleratedRegressions: 3 }));
        const wrongReport = loadEvidenceBundle(tree({ policy, lanes: laneSet, baseline: other }));
        expect(wrongReport.baseline).toMatchObject({ status: "schema-mismatch", diagnostics: ["baseline-fingerprint-mismatch"] });
        const present = loadEvidenceBundle(tree({ policy, lanes: laneSet, baseline }));
        expect(present.baseline).toMatchObject({ status: "present", reportFingerprint: baseline.reportFingerprint, diagnostics: [] });
        expect(present.baseline.report).toEqual(baseline);
    });

    it("classifies a lane whose JSON is valid but not canonicalizable instead of aborting the bundle", () => {
        const sources = tree();
        // `JSON.parse` reads `1e999` as `Infinity`, which no publisher can serialize back, so the bytes fail the round trip.
        writeFileSync(join(sources.artifactsDir, "incident-report.json"), '{\n    "schema": "incident-pool-report/v1",\n    "spent": 1e999\n}\n');
        const bundle = loadEvidenceBundle(sources);
        expect(laneEvidence(bundle, "incident")).toMatchObject({ status: "schema-mismatch", diagnostics: ["artifact-non-canonical"], reportFingerprint: null });
        expect(laneEvidence(bundle, "historian").status).toBe("present");
    });

    it("raises the scorecard error class when the paired-delta policy document does not parse", () => {
        const emptyMatrix = pairedDeltaPolicyDocumentFixture({ ...PAIRED_DELTA_POLICY, modelMatrix: [] });
        const bundle = tree({ pairedDeltaPolicyDocument: emptyMatrix, policy: policyFixture({ pairedDeltaPolicyFingerprint: emptyMatrix.policyFingerprint! }) });
        expect(() => loadEvidenceBundle(bundle)).toThrow(ScorecardContractError);
        expect(() => loadEvidenceBundle(bundle)).toThrow(/paired-delta-policy: parse-failed/);
        const notOwner = { ...pairedDeltaPolicyDocumentFixture(), owner: "magic-context-x4l.99" } as unknown as PolicyOwnerDocument;
        expect(() => loadEvidenceBundle(tree({ pairedDeltaPolicyDocument: notOwner }))).toThrow(ScorecardContractError);
    });

    it("refuses a paired-delta policy document that carries sensitive content", () => {
        const leaked = { ...pairedDeltaPolicyDocumentFixture(), owner: "/home/operator/magic-context-x4l.14" } as unknown as PolicyOwnerDocument;
        expect(() => loadEvidenceBundle(tree({ pairedDeltaPolicyDocument: leaked }))).toThrow(/paired-delta-policy: privacy-rejected/);
    });

    it("aborts the bundle under the scorecard error class when a lane artifact cannot be read", () => {
        const sources = tree();
        const path = join(sources.artifactsDir, "incident-report.json");
        rmSync(path, { force: true });
        mkdirSync(path);
        expect(() => loadEvidenceBundle(sources)).toThrow(ScorecardContractError);
        expect(() => loadEvidenceBundle(sources)).toThrow(/artifact: unreadable-eisdir/);
    });

    it("leaves the artifacts directory untouched", () => {
        const sources = tree();
        const before = readdirSync(sources.artifactsDir).sort();
        loadEvidenceBundle(sources);
        expect(readdirSync(sources.artifactsDir).sort()).toEqual(before);
    });
});
