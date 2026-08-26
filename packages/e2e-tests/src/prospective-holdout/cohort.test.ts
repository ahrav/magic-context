import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCohortClose, ProspectiveIntakeStore } from "./cohort";
import { reviewSanitizedIntake, staticPrivacyRejection } from "./intake";
import { H1, H2, H3, sanitizedIntakeFixture } from "./test-fixtures";

const key = new TextEncoder().encode("c".repeat(32));

describe("cohort close", () => {
    it("takes close snapshot atomically before later submissions become late", () => {
        const root = mkdtempSync(join(tmpdir(), "cohort-store-"));
        try {
            const store = new ProspectiveIntakeStore(root);
            const admitted = reviewSanitizedIntake(sanitizedIntakeFixture(), {
                commitmentKey: key,
                expectedRubricFingerprint: H3,
                freezePublishedAt: "2026-09-01T00:00:00Z",
            });
            expect(store.submit(admitted)).toBe("included");
            expect(store.submit(staticPrivacyRejection(
                `intake-${"e".repeat(32)}`,
                sanitizedIntakeFixture().deletionEvidence,
            ))).toBe("included");
            const snapshot = store.closeSnapshot("epoch-test-release", "2026-09-08T00:00:00Z");
            expect(store.submit(staticPrivacyRejection(
                `intake-${"f".repeat(32)}`,
                sanitizedIntakeFixture().deletionEvidence,
            ))).toBe("late");
            const afterClose = store.readDecisions();
            expect(snapshot.late).toEqual([]);
            expect(afterClose.late).toHaveLength(1);
            const close = buildCohortClose({
                epochId: "epoch-test-release",
                freezeManifestFingerprint: H1,
                closedAt: "2026-09-08T00:00:00Z",
                decisions: snapshot.decisions,
                late: snapshot.late,
                subjectiveMapCommitment: H2,
                custodyEvidence: { policy: "outcome-blind/v1" },
                approvalActors: {
                    cohortCustodian: "custodian-one",
                    admissionReviewer: "reviewer-two",
                },
            });
            expect(close.body.aggregateCounts).toEqual({ admitted: 1, rejected: 1, late: 0 });
            expect(new Set(close.body.rejected.map((entry) => entry.intakeId)).size).toBe(1);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("blocks close when deletion evidence is overdue or incomplete", () => {
        const overdue = sanitizedIntakeFixture();
        overdue.deletionEvidence[0]!.completedAt = "2026-09-08T00:00:00Z";
        expect(() => reviewSanitizedIntake(overdue, {
            commitmentKey: key,
            expectedRubricFingerprint: H3,
            freezePublishedAt: "2026-09-01T00:00:00Z",
        })).toThrow(/overdue/);
        const incomplete = sanitizedIntakeFixture();
        incomplete.deletionEvidence.pop();
        expect(() => reviewSanitizedIntake(incomplete, {
            commitmentKey: key,
            expectedRubricFingerprint: H3,
            freezePublishedAt: "2026-09-01T00:00:00Z",
        })).toThrow(/exact-stores-required/);
    });
});
