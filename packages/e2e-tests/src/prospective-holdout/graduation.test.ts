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
        const verifiedSource = verifyProspectiveSourceEvidence(candidate.source, close, trustedCloseFingerprint);
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
            const initiallyVerified = verifyProspectiveSourceEvidence(mutableSource, close, trustedCloseFingerprint);
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
