import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { verifyProspectiveSourceEvidence } from "../incident-pool/evidence";
import {
    registerProspectiveIncidentCase,
    type IncidentCaseRegistry,
    type RegisteredIncidentCase,
} from "../incident-pool/registry";
import type { PairedCaseFact } from "./comparison";
import {
    appendGraduationCandidate,
    buildGraduationCandidate,
    validateGraduationCompleteness,
    validateGraduationPairBindings,
    type GraduationCandidate,
} from "./graduation";
import { buildProspectiveReport } from "./report";
import type { ProspectiveCellResult } from "./runner";
import { cellResultFixture, closeManifest, H1, H2, H3 } from "./test-fixtures";

function cell(role: "release-n" | "release-n-minus-1"): ProspectiveCellResult {
    return cellResultFixture(role);
}

function fixtures() {
    const close = closeManifest();
    const pair: PairedCaseFact = {
        caseId: close.body.cases[0]!.caseId,
        familyId: close.body.cases[0]!.familyId,
        implementationFingerprint: H2,
        model: "fixture/model",
        seed: 7,
        platform: "linux-x64",
        releaseN: cell("release-n"),
        releaseNMinus1: cell("release-n-minus-1"),
        status: "complete",
    };
    const report = buildProspectiveReport({
        epochId: close.body.epochId,
        freezeManifestFingerprint: close.body.freezeManifestFingerprint,
        closeManifestFingerprint: canonicalFingerprint(close),
        analysisPolicyFingerprint: H3,
        scorecardPolicyFingerprint: H3,
        pairs: [pair],
        estimator: {
            owner: "magic-context-x4l.14",
            analyze: () => ({ direction: "no-change", evidenceSufficient: true, completeFamilyCount: 1, resultFingerprint: H1 }),
        },
        scorecard: {
            owner: "magic-context-x4l.15",
            evaluate: () => ({ hardGateFailures: [], mandatoryEvidenceComplete: true, promotionAllowed: true, resultFingerprint: H2 }),
        },
        invalidated: false,
    });
    return { close, pair, report };
}

function coordinatePair(
    base: PairedCaseFact,
    seed: number,
    releaseNOverrides: Partial<ProspectiveCellResult> = {},
): PairedCaseFact {
    const releaseN = cellResultFixture("release-n", { seed, ...releaseNOverrides });
    const releaseNMinus1 = cellResultFixture("release-n-minus-1", { seed });
    return {
        ...base,
        seed,
        releaseN,
        releaseNMinus1,
        // Mirrors the derivation in buildPairedFacts: a coordinate is complete only when both
        // arms reach `completed`.
        status: releaseN.runHealth === "completed" && releaseNMinus1.runHealth === "completed"
            ? "complete"
            : "incomplete",
    };
}

function candidateFor(context: ReturnType<typeof fixtures>, pair: PairedCaseFact): GraduationCandidate {
    const trustedCloseFingerprint = canonicalFingerprint(context.close);
    const incidentBytes = { scenario: "synthetic-current-state", expected: "pass" };
    return buildGraduationCandidate({
        close: context.close,
        trustedCloseFingerprint,
        report: context.report,
        pair,
        incidentBytes,
        semanticRevisionId: "rev-first",
        secondPrivacyApproval: {
            approver: "privacy-reviewer",
            subjectFingerprint: canonicalFingerprint({
                epochId: context.close.body.epochId,
                caseId: pair.caseId,
                closeManifestFingerprint: trustedCloseFingerprint,
                incidentBytesFingerprint: canonicalFingerprint(incidentBytes),
            }),
        },
    });
}

describe("prospective incident graduation", () => {
    it("graduates both-pass cases with trusted provenance and idempotent append", () => {
        const { close, pair, report } = fixtures();
        const trustedCloseFingerprint = canonicalFingerprint(close);
        const incidentBytes = { scenario: "synthetic-current-state", expected: "pass" };
        const incidentBytesFingerprint = canonicalFingerprint(incidentBytes);
        const subjectFingerprint = canonicalFingerprint({
            epochId: close.body.epochId,
            caseId: pair.caseId,
            closeManifestFingerprint: trustedCloseFingerprint,
            incidentBytesFingerprint,
        });
        const candidate = buildGraduationCandidate({
            close,
            trustedCloseFingerprint,
            report,
            pair,
            incidentBytes,
            semanticRevisionId: "rev-first",
            secondPrivacyApproval: { approver: "privacy-reviewer", subjectFingerprint },
        });
        expect(candidate.disposition).toBe("executable-accepted-behavior");
        expect(() => validateGraduationCompleteness(close, [candidate])).not.toThrow();

        const registry: IncidentCaseRegistry = new Map();
        const verifiedSource = verifyProspectiveSourceEvidence(
            candidate.source,
            close,
            trustedCloseFingerprint,
            candidate.incidentBytes,
        );
        const registration: RegisteredIncidentCase = {
            variantId: candidate.variantId,
            implementationFiles: ["scenario.ts"],
            fixtures: { prospectiveSourceFingerprint: candidate.sourceFingerprint },
            async driver() { return null; },
            normalizer: (raw) => raw,
            precondition: () => ({ satisfied: true as const }),
            verifier: () => [],
            binding: { driver: () => undefined, verifier: () => undefined },
        };
        registerProspectiveIncidentCase(registry, verifiedSource, registration);
        expect(registry.has(candidate.variantId)).toBe(true);

        const root = mkdtempSync(join(tmpdir(), "graduation-"));
        try {
            const path = join(root, "candidate.json");
            appendGraduationCandidate(candidate, path);
            expect(() => appendGraduationCandidate(candidate, path)).not.toThrow();
            expect(() => appendGraduationCandidate({ ...candidate, disposition: "executable-regression" }, path)).toThrow(/append-conflict/);

            const mutableSource = structuredClone(candidate.source);
            const initiallyVerified = verifyProspectiveSourceEvidence(
                mutableSource,
                close,
                trustedCloseFingerprint,
                candidate.incidentBytes,
            );
            mutableSource.case_commitment = H3;
            expect(() => registerProspectiveIncidentCase(new Map(), initiallyVerified, registration)).toThrow(
                /requires verified source evidence/,
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("rejects a disposition flipped away from recomputed paired outcomes", () => {
        const { close, pair, report } = fixtures();
        const trustedCloseFingerprint = canonicalFingerprint(close);
        const incidentBytes = { scenario: "synthetic-current-state", expected: "pass" };
        const candidate = buildGraduationCandidate({
            close,
            trustedCloseFingerprint,
            report,
            pair,
            incidentBytes,
            semanticRevisionId: "rev-first",
            secondPrivacyApproval: {
                approver: "privacy-reviewer",
                subjectFingerprint: canonicalFingerprint({
                    epochId: close.body.epochId,
                    caseId: pair.caseId,
                    closeManifestFingerprint: trustedCloseFingerprint,
                    incidentBytesFingerprint: canonicalFingerprint(incidentBytes),
                }),
            },
        });
        expect(() => validateGraduationPairBindings([
            { ...candidate, disposition: "executable-regression" },
        ], [pair])).toThrow(/pair-binding-mismatch/);
    });

    it("rejects an accepted-behavior disposition when a later coordinate regresses", () => {
        const context = fixtures();
        const candidate = candidateFor(context, context.pair);
        expect(candidate.disposition).toBe("executable-accepted-behavior");
        const failing = coordinatePair(context.pair, 11, {
            productOutcome: "fail",
            failedChecks: ["check-current"],
        });
        expect(() => validateGraduationPairBindings([candidate], [context.pair, failing])).toThrow(
            /pair-binding-mismatch/,
        );
        const timedOut = coordinatePair(context.pair, 13, {
            runHealth: "timeout",
            productOutcome: "not-evaluated",
            reasonCode: "deadline-exceeded",
        });
        expect(() => validateGraduationPairBindings([candidate], [context.pair, timedOut])).toThrow(
            /pair-binding-mismatch/,
        );
    });

    it("accepts an accepted-behavior disposition when every coordinate passes", () => {
        const context = fixtures();
        const candidate = candidateFor(context, context.pair);
        expect(() => validateGraduationPairBindings(
            [candidate],
            [context.pair, coordinatePair(context.pair, 11)],
        )).not.toThrow();
    });

    it("rejects a coordinate whose implementation fingerprint drifts from the candidate", () => {
        const context = fixtures();
        const candidate = candidateFor(context, context.pair);
        const drifted: PairedCaseFact = { ...coordinatePair(context.pair, 11), implementationFingerprint: H3 };
        expect(candidate.implementationFingerprint).not.toBe(drifted.implementationFingerprint);
        expect(() => validateGraduationPairBindings([candidate], [context.pair, drifted])).toThrow(
            /pair-binding-mismatch/,
        );
    });

    it("blocks untrusted, incomplete, or privacy-unsafe graduation", () => {
        const { close, pair, report } = fixtures();
        expect(() => validateGraduationCompleteness(close, [])).toThrow(/cohort-incomplete/);
        expect(() => buildGraduationCandidate({
            close,
            trustedCloseFingerprint: canonicalFingerprint(close),
            report,
            pair,
            incidentBytes: { scenario: "/home/private/customer" },
            semanticRevisionId: "rev-first",
            secondPrivacyApproval: { approver: "privacy-reviewer", subjectFingerprint: H1 },
        })).toThrow(/graduation.privacy/);
    });
});
