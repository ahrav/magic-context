import { describe, expect, it } from "bun:test";
import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { LANE_IDS, SCORECARD_GATE_IDS } from "./policy";
import {
    GATE_SOURCE_LANES,
    deriveOutcome,
    parseScorecardReport,
    type AdverseRow,
    type DeltaRow,
    type EvidenceRow,
    type FamilyEstimateRow,
    type GateRow,
    type MetricSlot,
    type ScorecardReport,
    type ScorecardReportBody,
} from "./report-contract";
import { H2, H3, policyFixture, scorecardReportFixture } from "./test-fixtures";

/** The paired-delta and metamorphic rows carry `FP`; every other present lane carries its own fingerprint. */
const FP = "b".repeat(64);
const INJECTION = SCORECARD_GATE_IDS.indexOf("gate-injection-promoted");
const UNPRODUCED_GATES = SCORECARD_GATE_IDS.filter((gateId) => GATE_SOURCE_LANES[gateId] === null).sort();
type ComparedDelta = Extract<DeltaRow, { status: "compared" }>;

/** Re-signs `report` after `edit` mutates its body, so only the edited claim can make the parser refuse. */
function edited(report: ScorecardReport, edit: (body: ScorecardReportBody) => void): ScorecardReport {
    const body = structuredClone(report.body);
    edit(body);
    return { ...report, body, reportFingerprint: canonicalFingerprint(body) };
}

function presentLane(row: EvidenceRow, index: number): EvidenceRow {
    const shared = row.lane === "paired-delta" || row.lane === "metamorphic";
    return { ...row, status: "present", reportFingerprint: shared ? FP : String(index).repeat(64), diagnostics: [] };
}

/** Passes the one gate a lane produces and leaves the rest unobserved, as the gate evaluator does. */
function observedGate(row: GateRow): GateRow {
    return GATE_SOURCE_LANES[row.gateId] === null
        ? { ...row, status: "not-observed", observedCount: null, evidenceFingerprint: null, sourceLane: null, diagnostic: "no-producing-lane" }
        : { ...row, status: "passed", observedCount: 0, evidenceFingerprint: FP, sourceLane: "metamorphic", diagnostic: null };
}

const allPassed = (row: GateRow): GateRow => ({ ...row, status: "passed", observedCount: 0, evidenceFingerprint: FP, sourceLane: "metamorphic", diagnostic: null });

const estimate = (familyId: string, pointEstimate: number, noiseLabel: FamilyEstimateRow["noiseLabel"] = "outside-floor"): FamilyEstimateRow =>
    ({ endpoint: "mc-on-vs-mc-off", familyId, pointEstimate, interval: { lower: pointEstimate - 0.1, upper: pointEstimate + 0.1 }, noiseLabel });

const compared = (row: FamilyEstimateRow, baselinePoint: number): ComparedDelta => ({
    endpoint: row.endpoint,
    familyId: row.familyId,
    status: "compared",
    baselinePointEstimate: baselinePoint,
    delta: row.pointEstimate - baselinePoint,
    interval: { lower: row.interval.lower - baselinePoint, upper: row.interval.upper - baselinePoint },
    noiseLabel: row.noiseLabel,
});

const adverse = (row: ComparedDelta): AdverseRow =>
    ({ familyId: row.familyId, endpoint: row.endpoint, kind: "adverse-interval", noiseLabel: row.noiseLabel, delta: row.delta, interval: row.interval, blocking: row.noiseLabel === "outside-floor" });

describe("parseScorecardReport", () => {
    const policy = policyFixture();
    const missingLanes = scorecardReportFixture(policy);
    const presentLanes = scorecardReportFixture(policy, {
        evidence: { lanes: missingLanes.body.evidence.lanes.map(presentLane), baseline: { status: "absent", reportFingerprint: null } },
        safetyGates: missingLanes.body.safetyGates.map(observedGate),
    });

    it("round-trips a report whose outcome is derived from its rows", () => {
        expect(parseScorecardReport(missingLanes)).toEqual(missingLanes);
        expect(missingLanes.body.outcome).toMatchObject({ promotionAllowed: false, mandatoryEvidenceComplete: false });
        expect(parseScorecardReport(presentLanes)).toEqual(presentLanes);
        // Every required slot is unmeasured, and the four gates without a producing lane are hard-gate failures.
        expect(presentLanes.body.outcome).toMatchObject({ promotionAllowed: false, mandatoryEvidenceComplete: false, hardGateFailures: UNPRODUCED_GATES });
    });

    it("recomputes the whole outcome from the restated policy terms", () => {
        const claim = (outcome: Partial<ScorecardReportBody["outcome"]>): ScorecardReport =>
            edited(presentLanes, (body) => Object.assign(body.outcome, outcome));
        expect(() => parseScorecardReport(claim({ mandatoryEvidenceComplete: true }))).toThrow(/report.body.outcome: cross-field-invalid/);
        expect(() => parseScorecardReport(claim({ promotionAllowed: true, mandatoryEvidenceComplete: true }))).toThrow(/outcome: cross-field-invalid/);
        expect(() => parseScorecardReport(claim({ hardGateFailures: [] }))).toThrow(/outcome: cross-field-invalid/);
        expect(() => parseScorecardReport(edited(missingLanes, (body) => { body.outcome.blockingRegressionCount = 1; }))).toThrow(/outcome: cross-field-invalid/);
        const unconstrained = scorecardReportFixture(policyFixture({ requiredMetricSlots: [] }), {
            evidence: presentLanes.body.evidence,
            safetyGates: presentLanes.body.safetyGates,
        });
        expect(parseScorecardReport(unconstrained).body.outcome).toMatchObject({ promotionAllowed: false, mandatoryEvidenceComplete: true, hardGateFailures: UNPRODUCED_GATES });
        expect(() => parseScorecardReport(edited(unconstrained, (body) => { body.target.maxToleratedRegressions = -1; }))).toThrow(/maxToleratedRegressions: integer-invalid/);
        expect(() => parseScorecardReport(edited(unconstrained, (body) => { body.target.requiredMetricSlots = ["currentness", "currentness"]; }))).toThrow(/requiredMetricSlots: duplicate/);
    });

    it("rejects a blocking regression beyond the restated tolerance", () => {
        const current = [estimate("fam-a", 0.2), estimate("fam-b", 0.3, "inside-floor")];
        const deltas = [compared(current[0]!, 0.5), compared(current[1]!, 0.6)];
        const baseline = policyFixture({ requiredMetricSlots: [], baselineScorecardReportFingerprint: H2 });
        const regressed = scorecardReportFixture(baseline, {
            evidence: { lanes: presentLanes.body.evidence.lanes, baseline: { status: "present", reportFingerprint: H2 } },
            safetyGates: presentLanes.body.safetyGates,
            utility: { ...presentLanes.body.utility, familyEstimates: current, deltas },
            adverseDeltas: deltas.map(adverse),
        });
        expect(parseScorecardReport(regressed).body.outcome).toMatchObject({ promotionAllowed: false, blockingRegressionCount: 1, mandatoryEvidenceComplete: true });
        expect(() => parseScorecardReport(edited(regressed, (body) => { body.outcome.promotionAllowed = true; }))).toThrow(/outcome: cross-field-invalid/);
        // With every gate passed the tolerance alone decides promotion.
        const terms = {
            gates: regressed.body.safetyGates.map(allPassed),
            lanes: regressed.body.evidence.lanes,
            baseline: "present" as const,
            families: [regressed.body.utility, regressed.body.formation, regressed.body.retrieval, regressed.body.context, regressed.body.reliability],
            requiredMetricSlots: [],
            adverseDeltas: regressed.body.adverseDeltas,
        };
        expect(deriveOutcome({ ...terms, maxToleratedRegressions: 0 })).toMatchObject({ promotionAllowed: false, blockingRegressionCount: 1 });
        expect(deriveOutcome({ ...terms, maxToleratedRegressions: 1 })).toMatchObject({ promotionAllowed: true, blockingRegressionCount: 1 });
    });

    it("derives the adverse rows from the compared deltas", () => {
        const current = [estimate("fam-a", 0.2), estimate("fam-b", 0.9)];
        const deltas = [compared(current[0]!, 0.5), compared(current[1]!, 0.5)];
        const baseline = policyFixture({ requiredMetricSlots: [], baselineScorecardReportFingerprint: H2 });
        const withBaseline = (overrides: Partial<ScorecardReportBody>): ScorecardReport => scorecardReportFixture(baseline, {
            evidence: { lanes: presentLanes.body.evidence.lanes, baseline: { status: "present", reportFingerprint: H2 } },
            utility: { ...presentLanes.body.utility, familyEstimates: current, deltas },
            adverseDeltas: [adverse(deltas[0]!)],
            ...overrides,
        });
        expect(parseScorecardReport(withBaseline({})).body.outcome.blockingRegressionCount).toBe(1);
        expect(() => parseScorecardReport(withBaseline({ adverseDeltas: [] }))).toThrow(/adverseDeltas: derived-mismatch/);
        expect(() => parseScorecardReport(withBaseline({ adverseDeltas: [adverse(deltas[1]!)] }))).toThrow(/adverseDeltas: derived-mismatch/);
        expect(() => parseScorecardReport(withBaseline({ adverseDeltas: [{ ...adverse(deltas[0]!), delta: -0.2 }] }))).toThrow(/adverseDeltas: derived-mismatch/);
        const missingFamily: AdverseRow = { familyId: "fam-a", endpoint: "mc-on-vs-mc-off", kind: "family-missing", noiseLabel: null, delta: null, interval: null, blocking: true };
        expect(() => parseScorecardReport(withBaseline({ adverseDeltas: [adverse(deltas[0]!), missingFamily] }))).toThrow(/adverseDeltas\[1\]: family-present/);
        // A missing-family row must name its endpoint and carry no comparison fields, so it cannot dodge the key check.
        expect(() => parseScorecardReport(withBaseline({ adverseDeltas: [adverse(deltas[0]!), { ...missingFamily, endpoint: null as unknown as AdverseRow["endpoint"] }] })))
            .toThrow(/adverseDeltas\[1\].endpoint: enum-invalid/);
        expect(() => parseScorecardReport(withBaseline({ adverseDeltas: [adverse(deltas[0]!), { ...missingFamily, familyId: "fam-z", delta: -0.1 }] })))
            .toThrow(/adverseDeltas\[1\]: shape-invalid/);
        const absentFamily = { ...missingFamily, familyId: "fam-z" };
        expect(parseScorecardReport(withBaseline({ adverseDeltas: [adverse(deltas[0]!), absentFamily] })).body.outcome.blockingRegressionCount).toBe(2);
        expect(() => parseScorecardReport(withBaseline({ adverseDeltas: [absentFamily, adverse(deltas[0]!)] }))).toThrow(/adverseDeltas: order-invalid/);
        const relabelled = deltas.map((row) => ({ ...row, noiseLabel: "inside-floor" as const }));
        expect(() => parseScorecardReport(withBaseline({ utility: { ...presentLanes.body.utility, familyEstimates: current, deltas: relabelled } })))
            .toThrow(/deltas\[0\].noiseLabel: cross-field-invalid/);
        expect(() => parseScorecardReport(withBaseline({ utility: { ...presentLanes.body.utility, familyEstimates: current, deltas: deltas.slice(0, 1) } })))
            .toThrow(/deltas: estimate-mirror-invalid/);
        // A delta or shifted interval that the current estimate and the stated baseline point do not produce is refused.
        const inflated = [{ ...deltas[0]!, delta: 0.1, interval: { lower: 0, upper: 0.2 } }, deltas[1]!];
        expect(() => parseScorecardReport(withBaseline({ utility: { ...presentLanes.body.utility, familyEstimates: current, deltas: inflated }, adverseDeltas: [] })))
            .toThrow(/deltas\[0\]: cross-field-invalid/);
        const restated = [{ ...deltas[0]!, baselinePointEstimate: 0.4 }, deltas[1]!];
        expect(() => parseScorecardReport(withBaseline({ utility: { ...presentLanes.body.utility, familyEstimates: current, deltas: restated } })))
            .toThrow(/deltas\[0\]: cross-field-invalid/);
    });

    it("bounds every paired-delta estimate it carries to [-1, 1]", () => {
        const rung = edited(missingLanes, (body) => {
            body.regret = [{ coordinateId: "fam-a:0", familyId: "fam-a", retrieval: 5.7, formation: null, representation: null, label: "raw-non-inferential" }];
        });
        expect(() => parseScorecardReport(rung)).toThrow(/regret\[0\].retrieval: number-invalid/);
        const wide = edited(missingLanes, (body) => {
            body.utility.familyEstimates = [{ ...estimate("fam-a", 0.2), interval: { lower: -1.5, upper: 0.3 } }];
            body.utility.deltas = [{ endpoint: "mc-on-vs-mc-off", familyId: "fam-a", status: "no-baseline", value: 0.2 }];
        });
        expect(() => parseScorecardReport(wide)).toThrow(/familyEstimates\[0\].interval.lower: number-invalid/);
    });

    it("ties every compared delta and adverse row to a present baseline", () => {
        const current = [estimate("fam-a", 0.2)];
        const noBaseline: DeltaRow = { endpoint: "mc-on-vs-mc-off", familyId: "fam-a", status: "no-baseline", value: 0.2 };
        const unpinned = scorecardReportFixture(policy, { utility: { ...missingLanes.body.utility, familyEstimates: current, deltas: [noBaseline] } });
        expect(parseScorecardReport(unpinned)).toEqual(unpinned);
        expect(() => parseScorecardReport(edited(unpinned, (body) => { (body.utility.deltas[0] as Extract<DeltaRow, { status: "no-baseline" }>).value = 0.3; })))
            .toThrow(/deltas\[0\].value: cross-field-invalid/);
        const comparedRow = compared(current[0]!, 0.5);
        expect(() => parseScorecardReport(edited(unpinned, (body) => { body.utility.deltas = [comparedRow]; }))).toThrow(/deltas\[0\].status: baseline-required/);
        expect(() => parseScorecardReport(edited(unpinned, (body) => { body.adverseDeltas = [adverse(comparedRow)]; }))).toThrow(/adverseDeltas: baseline-required/);
    });

    it("counts a pinned baseline that did not load as missing mandatory evidence", () => {
        const pinned = policyFixture({ requiredMetricSlots: [], baselineScorecardReportFingerprint: H2 });
        const loaded = scorecardReportFixture(pinned, {
            evidence: { lanes: presentLanes.body.evidence.lanes, baseline: { status: "present", reportFingerprint: H2 } },
            safetyGates: presentLanes.body.safetyGates,
        });
        expect(parseScorecardReport(loaded).body.outcome.mandatoryEvidenceComplete).toBe(true);
        const unloaded = scorecardReportFixture(pinned, {
            evidence: { lanes: presentLanes.body.evidence.lanes, baseline: { status: "schema-mismatch", reportFingerprint: null } },
            safetyGates: presentLanes.body.safetyGates,
        });
        expect(parseScorecardReport(unloaded).body.outcome).toMatchObject({ promotionAllowed: false, mandatoryEvidenceComplete: false });
        expect(() => parseScorecardReport(edited(unloaded, (body) => { body.outcome.mandatoryEvidenceComplete = true; }))).toThrow(/outcome: cross-field-invalid/);
        expect(() => parseScorecardReport(edited(loaded, (body) => { body.evidence.baseline = { status: "absent", reportFingerprint: null }; })))
            .toThrow(/baseline.status: cross-field-invalid/);
        expect(() => parseScorecardReport(edited(loaded, (body) => { body.evidence.baseline.reportFingerprint = H3; }))).toThrow(/baseline.reportFingerprint: cross-field-invalid/);
        expect(() => parseScorecardReport(edited(presentLanes, (body) => { body.evidence.baseline = { status: "present", reportFingerprint: H2 }; })))
            .toThrow(/baseline.status: cross-field-invalid/);
    });

    it("requires each lane row's fingerprint, identity, and diagnostics to match its status", () => {
        const lane = (edit: (row: EvidenceRow) => void): ScorecardReport => edited(presentLanes, (body) => edit(body.evidence.lanes[0]!));
        expect(() => parseScorecardReport(lane((row) => { row.reportFingerprint = null; }))).toThrow(/lanes\[0\].reportFingerprint: required/);
        expect(() => parseScorecardReport(lane((row) => { row.diagnostics = ["run-incomplete"]; }))).toThrow(/lanes\[0\].diagnostics: cross-field-invalid/);
        expect(() => parseScorecardReport(lane((row) => { row.status = "incomplete"; }))).toThrow(/lanes\[0\].diagnostics: cross-field-invalid/);
        expect(() => parseScorecardReport(lane((row) => { row.status = "incomplete"; row.diagnostics = ["run-incomplete"]; row.reportFingerprint = null; })))
            .toThrow(/lanes\[0\].reportFingerprint: required/);
        expect(() => parseScorecardReport(edited(missingLanes, (body) => { body.evidence.lanes[0]!.reportFingerprint = FP; }))).toThrow(/lanes\[0\]: shape-invalid/);
    });

    it("binds every observed gate to a present lane row with the same fingerprint", () => {
        const gate = (edit: (row: GateRow) => void): ScorecardReport => edited(presentLanes, (body) => edit(body.safetyGates[INJECTION]!));
        expect(() => parseScorecardReport(gate((row) => { row.evidenceFingerprint = "c".repeat(64); }))).toThrow(/safetyGates\[2\]: evidence-binding-invalid/);
        expect(() => parseScorecardReport(edited(presentLanes, (body) => {
            const row = body.evidence.lanes[LANE_IDS.indexOf("metamorphic")]!;
            row.status = "incomplete";
            row.diagnostics = ["run-incomplete"];
            body.outcome.mandatoryEvidenceComplete = false;
        }))).toThrow(/safetyGates\[2\]: evidence-binding-invalid/);
        const failed = gate((row) => { row.status = "failed"; row.observedCount = 2; row.evidenceFingerprint = "c".repeat(64); });
        expect(() => parseScorecardReport(failed)).toThrow(/safetyGates\[2\]: evidence-binding-invalid/);
    });

    it("requires the gate row shape its status tags", () => {
        const gate = (report: ScorecardReport, index: number, edit: (row: GateRow) => void): ScorecardReport => edited(report, (body) => edit(body.safetyGates[index]!));
        expect(() => parseScorecardReport(gate(presentLanes, INJECTION, (row) => { row.diagnostic = "lane-missing"; }))).toThrow(/safetyGates\[2\]: evidence-shape-invalid/);
        expect(() => parseScorecardReport(gate(missingLanes, 0, (row) => { row.sourceLane = "metamorphic"; row.evidenceFingerprint = FP; }))).toThrow(/safetyGates\[0\]: evidence-shape-invalid/);
        expect(() => parseScorecardReport(gate(missingLanes, 0, (row) => { row.diagnostic = null; }))).toThrow(/safetyGates\[0\]: evidence-shape-invalid/);
    });

    it("restricts each observed gate to its producing lane", () => {
        const incidentSourced = edited(presentLanes, (body) => {
            const row = body.safetyGates[INJECTION]!;
            row.sourceLane = "incident";
            row.evidenceFingerprint = body.evidence.lanes[LANE_IDS.indexOf("incident")]!.reportFingerprint;
        });
        expect(() => parseScorecardReport(incidentSourced)).toThrow(/safetyGates\[2\].sourceLane: gate-producer-invalid/);
        // A gate no lane produces cannot be observed, whichever lane a report names.
        const forged = edited(presentLanes, (body) => {
            body.safetyGates = body.safetyGates.map(allPassed);
            body.outcome.hardGateFailures = [];
        });
        expect(() => parseScorecardReport(forged)).toThrow(/safetyGates\[0\].sourceLane: gate-producer-invalid/);
    });

    it("binds every measured slot to a parsed lane row and to the slot's unit, domain, and producer", () => {
        const measured = (slot: Partial<Extract<MetricSlot, { status: "measured" }>>): ScorecardReport => edited(presentLanes, (body) => {
            body.utility.slots[0] = { id: "valid-success-delta-mc-on-vs-mc-off", status: "measured", value: 0.25, unit: "delta", sourceLane: "paired-delta", sourceFingerprint: FP, ...slot };
            body.outcome.mandatoryEvidenceComplete = true;
        });
        expect(parseScorecardReport(measured({})).body.outcome.mandatoryEvidenceComplete).toBe(true);
        expect(() => parseScorecardReport(measured({ sourceFingerprint: "c".repeat(64) }))).toThrow(/utility.slots\[0\]: evidence-binding-invalid/);
        expect(() => parseScorecardReport(measured({ sourceLane: "historian" }))).toThrow(/utility.slots\[0\].sourceLane: slot-producer-invalid/);
        // The metamorphic row carries the same fingerprint as paired-delta, so only the producer rule can refuse it.
        expect(() => parseScorecardReport(measured({ sourceLane: "metamorphic" }))).toThrow(/utility.slots\[0\].sourceLane: slot-producer-invalid/);
        const unproduced = edited(presentLanes, (body) => {
            body.context.slots[0] = { id: "post-compaction-probe-accuracy", status: "measured", value: 0.5, unit: "ratio", sourceLane: "paired-delta", sourceFingerprint: FP };
        });
        expect(() => parseScorecardReport(unproduced)).toThrow(/context.slots\[0\].sourceLane: slot-producer-invalid/);
        expect(() => parseScorecardReport(measured({ unit: "ratio" }))).toThrow(/utility.slots\[0\].unit: slot-unit-invalid/);
        expect(() => parseScorecardReport(measured({ value: 1.5 }))).toThrow(/utility.slots\[0\].value: number-invalid/);
        const incompleteSource = edited(measured({}), (body) => {
            const row = body.evidence.lanes[LANE_IDS.indexOf("paired-delta")]!;
            row.status = "incomplete";
            row.diagnostics = ["run-incomplete"];
            body.outcome.mandatoryEvidenceComplete = false;
        });
        expect(parseScorecardReport(incompleteSource).body.outcome.mandatoryEvidenceComplete).toBe(false);
        const rejectedSource = edited(incompleteSource, (body) => { body.evidence.lanes[LANE_IDS.indexOf("paired-delta")]!.status = "schema-mismatch"; });
        expect(() => parseScorecardReport(rejectedSource)).toThrow(/utility.slots\[0\]: evidence-binding-invalid/);
        const count = edited(presentLanes, (body) => {
            body.reliability.slots[0] = { id: "paired-delta-planned-coordinates", status: "measured", value: 4.5, unit: "count", sourceLane: "paired-delta", sourceFingerprint: FP };
        });
        expect(() => parseScorecardReport(count)).toThrow(/reliability.slots\[0\].value: integer-invalid/);
    });
});
