import { describe, expect, it } from "bun:test";
import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import type { PairedCaseFact, PairStatus } from "./comparison";
import {
    buildProspectiveReport,
    parseProspectiveReport,
    releasePromotionAllowed,
    validateProspectiveReportEvidence,
    type FamilyEstimatorAdapter,
    type ScorecardAdapter,
} from "./report";
import type { ProspectiveCellResult } from "./runner";
import { cellResultFixture, H1, H2, H3 } from "./test-fixtures";

function cell(role: "release-n" | "release-n-minus-1", outcome: "pass" | "fail" = "pass"): ProspectiveCellResult {
    return cellResultFixture(role, {
        productOutcome: outcome,
        failedChecks: outcome === "fail" ? ["check-current"] : [],
    });
}

function pair(): PairedCaseFact {
    return {
        caseId: `case-${"a".repeat(32)}`,
        familyId: "fam-context-loss",
        implementationFingerprint: H2,
        model: "fixture/model",
        seed: 7,
        platform: "linux-x64",
        releaseN: cell("release-n", "fail"),
        releaseNMinus1: cell("release-n-minus-1"),
        status: "complete",
    };
}

function coordinatePair(seed: number, status: PairStatus): PairedCaseFact {
    // A timed-out `release-n` arm makes a coordinate incomplete.
    // Both arms avoid `fail`, so the family contributes no miss; only counts differ across coordinates.
    const releaseN = status === "incomplete"
        ? cellResultFixture("release-n", {
            seed,
            runHealth: "timeout",
            productOutcome: "not-evaluated",
            reasonCode: "deadline-exceeded",
        })
        : cellResultFixture("release-n", { seed });
    return {
        ...pair(),
        seed,
        releaseN,
        releaseNMinus1: cellResultFixture("release-n-minus-1", { seed }),
        status,
    };
}

function adapters(
    input: {
        sufficient?: boolean;
        failures?: string[];
        evidence?: boolean;
        allowed?: boolean;
        completeFamilyCount?: number;
    } = {},
) {
    const estimator: FamilyEstimatorAdapter = {
        owner: "magic-context-x4l.14",
        analyze: () => ({
            direction: "regression",
            evidenceSufficient: input.sufficient ?? true,
            completeFamilyCount: input.completeFamilyCount ?? 1,
            resultFingerprint: H1,
        }),
    };
    const scorecard: ScorecardAdapter = {
        owner: "magic-context-x4l.15",
        evaluate: () => ({
            hardGateFailures: input.failures ?? [],
            mandatoryEvidenceComplete: input.evidence ?? true,
            promotionAllowed: input.allowed ?? false,
            resultFingerprint: H2,
        }),
    };
    return { estimator, scorecard };
}

function report(
    overrides: Parameters<typeof adapters>[0] = {},
    invalidated = false,
    pairs: readonly PairedCaseFact[] = [pair()],
) {
    return buildProspectiveReport({
        epochId: "epoch-test-release",
        freezeManifestFingerprint: H1,
        closeManifestFingerprint: H2,
        analysisPolicyFingerprint: H3,
        scorecardPolicyFingerprint: H3,
        pairs,
        ...adapters(overrides),
        invalidated,
    });
}

describe("prospective report", () => {
    it("delegates estimator and scorecard ownership and recomputes exact fingerprint", () => {
        const built = report();
        expect(built.body.decision).toBe("hold");
        expect(built.body.familyMisses).toEqual(["fam-context-loss"]);
        expect(parseProspectiveReport(structuredClone(built))).toEqual(built);
        const changed = structuredClone(built);
        changed.body.familyMisses = [];
        changed.reportFingerprint = canonicalFingerprint(changed.body);
        const parsed = parseProspectiveReport(changed);
        expect(() => validateProspectiveReportEvidence(parsed, [pair()])).toThrow(
            /deterministic-recomputation-mismatch/,
        );
    });

    it("rejects adapter-owned directional fields after report fingerprint recomputation", () => {
        const built = report();
        built.body.direction = "improvement";
        built.reportFingerprint = canonicalFingerprint(built.body);
        const parsed = parseProspectiveReport(built);
        expect(() => validateProspectiveReportEvidence(parsed, [pair()], adapters())).toThrow(
            /sibling-recomputation-mismatch/,
        );
    });

    it("uses invalidation, observed hard gate, then insufficiency precedence and blocks promotion without trust", () => {
        expect(report({}, true).body.decision).toBe("invalidated");
        expect(report({ sufficient: false, failures: ["gate-safety"] }).body.decision).toBe("hard-gate-failed");
        expect(report({ sufficient: false }).body.decision).toBe("insufficient-evidence");
        const promotable = report({ allowed: true });
        expect(promotable.body.decision).toBe("promote");
        expect(releasePromotionAllowed(promotable, false, "reported")).toBe(false);
        expect(releasePromotionAllowed(promotable, true, "reported")).toBe(true);
    });

    it("refuses promotion when a later legal transition supersedes the reported state", () => {
        const promotable = report({ allowed: true });
        expect(promotable.body.decision).toBe("promote");
        expect(releasePromotionAllowed(promotable, true, "invalidated")).toBe(false);
        expect(releasePromotionAllowed(promotable, true, "insufficient-evidence")).toBe(false);
        expect(releasePromotionAllowed(promotable, true, "running")).toBe(false);
        expect(releasePromotionAllowed(promotable, true, "state-added-later")).toBe(false);
        expect(releasePromotionAllowed(promotable, true, "reported")).toBe(true);
        expect(releasePromotionAllowed(promotable, true, "graduated")).toBe(true);
    });

    it("refuses promotion for a non-promote decision from every promotable state", () => {
        for (const state of ["reported", "graduated"]) {
            expect(releasePromotionAllowed(report(), true, state)).toBe(false);
            expect(releasePromotionAllowed(report({}, true), true, state)).toBe(false);
            expect(releasePromotionAllowed(report({ sufficient: false }), true, state)).toBe(false);
            expect(releasePromotionAllowed(report({ failures: ["gate-safety"] }), true, state)).toBe(false);
        }
    });

    it("names one incomplete case once while counting every coordinate", () => {
        const pairs = [
            coordinatePair(7, "complete"),
            coordinatePair(11, "incomplete"),
            coordinatePair(13, "incomplete"),
        ];
        const caseId = pairs[0]!.caseId;
        const built = report({ completeFamilyCount: 0 }, false, pairs);
        expect(built.body.incompleteCaseIds).toEqual([caseId]);
        expect(built.body.prospective.pairCount).toBe(pairs.length);
        expect(built.body.prospective.completePairCount).toBe(1);
        expect(parseProspectiveReport(structuredClone(built))).toEqual(built);
    });

    it("rejects a cleared incomplete case list while a coordinate stays incomplete", () => {
        const built = report({ completeFamilyCount: 0 }, false, [
            coordinatePair(7, "complete"),
            coordinatePair(11, "incomplete"),
        ]);
        const cleared = structuredClone(built);
        cleared.body.incompleteCaseIds = [];
        cleared.reportFingerprint = canonicalFingerprint(cleared.body);
        expect(() => parseProspectiveReport(cleared)).toThrow(
            /report\.body\.prospective: incomplete-count-mismatch/,
        );
    });
});
