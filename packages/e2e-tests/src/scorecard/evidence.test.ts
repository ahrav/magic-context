import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { laneEvidence, loadEvidenceBundle, type EvidenceSources } from "./evidence";
import { LANE_IDS, ScorecardContractError } from "./policy";
import {
    HISTORIAN_SYSTEM,
    PAIRED_DELTA_POLICY,
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
    scannableDreamerReportFixture,
    scenarioScoreFixture,
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

    it("rejects a paired-delta report bound to another paired-delta policy as schema-mismatch", () => {
        const foreign = pairedDeltaPolicyDocumentFixture({ ...PAIRED_DELTA_POLICY, replicateCount: 2 });
        const bundle = loadEvidenceBundle(tree({ lanes: { "paired-delta": pairedDeltaReportFixture({ policyDocument: foreign }) } }));
        expect(laneEvidence(bundle, "paired-delta")).toMatchObject({ status: "schema-mismatch", diagnostics: ["policy-binding-mismatch"] });
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
        const noiseSource = loadEvidenceBundle(tree({ policy: policyFixture({ statisticalComparison: { bootstrapResamples: 2000, noiseFloorSource: "calibration" } }) }));
        expect(laneEvidence(noiseSource, "paired-delta").status).toBe("incomplete");
        const missingSecondary = loadEvidenceBundle(tree({ policy: policyFixture({ secondaryMetricSlots: ["final-attempt-tokens-mc-on", "invalid-success-rate-mc-off"] }) }));
        expect(laneEvidence(missingSecondary, "paired-delta").status).toBe("present");
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
        const named = "a".repeat(64);
        const policy = policyFixture({ baselineScorecardReportFingerprint: named });
        const missingPath = loadEvidenceBundle(tree({ policy, lanes: laneSet }));
        expect(missingPath.baseline).toMatchObject({ status: "schema-mismatch", diagnostics: ["baseline-path-missing"] });
        const wrongBytes = loadEvidenceBundle(tree({ policy, lanes: laneSet, baseline: { schema: "scorecard-report/v1", body: {}, reportFingerprint: named } }));
        expect(wrongBytes.baseline).toMatchObject({ status: "schema-mismatch", diagnostics: ["baseline-parse-failed"] });
    });

    it("leaves the artifacts directory untouched", () => {
        const sources = tree();
        const before = readdirSync(sources.artifactsDir).sort();
        loadEvidenceBundle(sources);
        expect(readdirSync(sources.artifactsDir).sort()).toEqual(before);
    });
});
