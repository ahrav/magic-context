import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalFingerprint, canonicalJson } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import {
    appendJudgment,
    closeAdjudication,
    publishAdjudicationClose,
    unblindAfterClose,
    validateJudgments,
} from "./adjudication";
import { buildBlindedPacket, createConcealedMap } from "./blinding";
import { closeManifest } from "./test-fixtures";

const authKey = new TextEncoder().encode("a".repeat(32));
const mapKey = new TextEncoder().encode("m".repeat(32));

function packetFixture(caseId = `case-${"a".repeat(32)}`) {
    const assignment = { caseId, buildA: "release-n" as const, buildB: "release-n-minus-1" as const };
    return buildBlindedPacket({
        caseId,
        assignment,
        observations: {
            "release-n": { status: "pass", checkIds: [] },
            "release-n-minus-1": { status: "fail", checkIds: ["check-current"] },
        },
        allowedCheckIds: ["check-current"],
        secret: authKey,
    });
}

function subjectiveClose(
    mapCommitment: string,
    caseIds: readonly string[] = [`case-${"a".repeat(32)}`],
) {
    const close = closeManifest();
    const template = close.body.cases[0]!;
    close.body.cases = caseIds.map((caseId, index) => ({
        ...template,
        intakeId: `intake-${(index + 1).toString(16).padStart(32, "0")}`,
        caseId,
        subjective: true,
    }));
    close.body.aggregateCounts.admitted = caseIds.length;
    close.body.subjectiveMapCommitment = mapCommitment;
    const subjectFingerprint = canonicalFingerprint(close.body);
    for (const approval of close.approvals) approval.subjectFingerprint = subjectFingerprint;
    return close;
}

describe("immutable adjudication", () => {
    it("authenticates packet-bound judgments, closes once, then unblinds independently", () => {
        const packet = packetFixture();
        const map = createConcealedMap([packet.caseId], mapKey, "1".repeat(32));
        const cohortClose = subjectiveClose(map.commitment);
        const trustedCloseFingerprint = canonicalFingerprint(cohortClose);
        const judgments = appendJudgment({
            prior: [],
            packet,
            sealedPackets: [packet],
            adjudicator: "judge-one",
            verdict: "build-a",
            authenticationKey: authKey,
        });
        expect(validateJudgments(judgments, authKey, [packet])).toHaveLength(1);
        const close = closeAdjudication({
            close: cohortClose,
            trustedCloseFingerprint,
            closedAt: "2026-09-09T00:00:00Z",
            judgments,
            sealedPackets: [packet],
            authenticationKey: authKey,
            approver: "reviewer-three",
        });
        // The HMAC requires `approvalKey`; a digest of call inputs cannot prove a second actor approved.
        const approvalKey = new Uint8Array(32).fill(9);
        const approvalFingerprint = createHmac("sha256", approvalKey)
            .update(canonicalJson({
                kind: "unblind",
                approver: "reviewer-four",
                adjudicationCloseFingerprint: canonicalFingerprint(close),
                closeManifestFingerprint: trustedCloseFingerprint,
                mapCommitment: map.commitment,
            }))
            .digest("hex");
        expect(unblindAfterClose({
            close,
            cohortClose,
            trustedCloseFingerprint,
            judgments,
            sealedPackets: [packet],
            authenticationKey: authKey,
            concealedMap: map,
            commitmentSecret: mapKey,
            unblindApprover: "reviewer-four",
            unblindApprovalKey: approvalKey,
            approvalFingerprint,
        })).toEqual(map);
        // Only a holder of `unblindApprovalKey` can produce `approvalFingerprint`.
        expect(() => unblindAfterClose({
            close,
            cohortClose,
            trustedCloseFingerprint,
            judgments,
            sealedPackets: [packet],
            authenticationKey: authKey,
            concealedMap: map,
            commitmentSecret: mapKey,
            unblindApprover: "reviewer-four",
            unblindApprovalKey: new Uint8Array(32).fill(7),
            approvalFingerprint,
        })).toThrow(/unblind: approval-invalid/);
    });

    it("rejects zero and missing subjective judgments", () => {
        const first = packetFixture();
        const second = packetFixture(`case-${"b".repeat(32)}`);
        const cohortClose = subjectiveClose("1".repeat(64), [first.caseId, second.caseId]);
        const trustedCloseFingerprint = canonicalFingerprint(cohortClose);
        expect(() => closeAdjudication({
            close: cohortClose,
            trustedCloseFingerprint,
            closedAt: "2026-09-09T00:00:00Z",
            judgments: [],
            sealedPackets: [first, second],
            authenticationKey: authKey,
            approver: "reviewer-three",
        })).toThrow(/cardinality-mismatch/);
        const oneJudgment = appendJudgment({
            prior: [],
            packet: first,
            sealedPackets: [first, second],
            adjudicator: "judge-one",
            verdict: "build-a",
            authenticationKey: authKey,
        });
        expect(() => closeAdjudication({
            close: cohortClose,
            trustedCloseFingerprint,
            closedAt: "2026-09-09T00:00:00Z",
            judgments: oneJudgment,
            sealedPackets: [first, second],
            authenticationKey: authKey,
            approver: "reviewer-three",
        })).toThrow(/cardinality-mismatch/);
    });

    it("rejects a close stamped before the cohort close and admits the same instant", () => {
        const packet = packetFixture();
        const cohortClose = subjectiveClose("1".repeat(64));
        const judgments = appendJudgment({
            prior: [],
            packet,
            sealedPackets: [packet],
            adjudicator: "judge-one",
            verdict: "build-a",
            authenticationKey: authKey,
        });
        const base = {
            close: cohortClose,
            trustedCloseFingerprint: canonicalFingerprint(cohortClose),
            judgments,
            sealedPackets: [packet],
            authenticationKey: authKey,
            approver: "reviewer-three",
        };
        expect(() => closeAdjudication({ ...base, closedAt: "2026-09-07T23:59:59Z" }))
            .toThrow(/adjudication-close\.closedAt: before-cohort-close/);
        expect(closeAdjudication({ ...base, closedAt: cohortClose.body.closedAt }).closedAt)
            .toBe(cohortClose.body.closedAt);
    });

    it("rejects replacement, replay, forged authentication, and overwrite", () => {
        const packet = packetFixture();
        const judgments = appendJudgment({
            prior: [], packet, sealedPackets: [packet], adjudicator: "judge-one", verdict: "tie", authenticationKey: authKey,
        });
        expect(() => appendJudgment({
            prior: judgments, packet, sealedPackets: [packet], adjudicator: "judge-one", verdict: "build-a", authenticationKey: authKey,
        })).toThrow(/duplicate-packet/);
        const forged = structuredClone(judgments);
        forged[0]!.verdict = "neither";
        expect(() => validateJudgments(forged, authKey, [packet])).toThrow(/authentication-invalid/);

        const root = mkdtempSync(join(tmpdir(), "adjudication-close-"));
        try {
            const cohortClose = subjectiveClose("1".repeat(64));
            const close = closeAdjudication({
                close: cohortClose,
                trustedCloseFingerprint: canonicalFingerprint(cohortClose),
                closedAt: "2026-09-09T00:00:00Z",
                judgments,
                sealedPackets: [packet],
                authenticationKey: authKey,
                approver: "reviewer-three",
            });
            const destination = join(root, "close.json");
            publishAdjudicationClose(close, destination);
            // A retry with the same close completes when interruption follows link installation.
            // A retry with the same close completes when interruption follows link installation.
            expect(() => publishAdjudicationClose(close, destination)).not.toThrow();
            const conflicting = closeAdjudication({
                close: cohortClose,
                trustedCloseFingerprint: canonicalFingerprint(cohortClose),
                closedAt: "2026-09-10T00:00:00Z",
                judgments,
                sealedPackets: [packet],
                authenticationKey: authKey,
                approver: "reviewer-three",
            });
            expect(() => publishAdjudicationClose(conflicting, destination))
                .toThrow(/destination-conflict/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
