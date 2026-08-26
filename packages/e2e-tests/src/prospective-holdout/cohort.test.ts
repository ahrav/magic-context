import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCohortClose, ProspectiveIntakeStore } from "./cohort";
import { reviewSanitizedIntake, staticPrivacyRejection } from "./intake";
import { H1, H2, H3, sanitizedIntakeFixture } from "./test-fixtures";

const key = new TextEncoder().encode("c".repeat(32));
const reviewOptions = {
    commitmentKey: key,
    expectedRubricFingerprint: H3,
    freezePublishedAt: "2026-09-01T00:00:00Z",
    intakeClosesAt: "2026-09-08T00:00:00Z",
};
const custodyEvidence = {
    schema: "prospective-custody-evidence/v1",
    verifiedThrough: "2026-09-08T00:00:00Z",
    custodianOutcomeAccess: false,
    admissionReviewerOutcomeAccess: false,
    buildIdentityAccess: false,
    diagnosticsAccess: false,
    concealedMapAccess: false,
};

describe("cohort close", () => {
    it("takes close snapshot atomically before later submissions become late", () => {
        const root = mkdtempSync(join(tmpdir(), "cohort-store-"));
        try {
            const store = new ProspectiveIntakeStore(root);
            const admitted = reviewSanitizedIntake(sanitizedIntakeFixture(), reviewOptions);
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
            const closeInput = {
                epochId: "epoch-test-release",
                freezeManifestFingerprint: H1,
                closedAt: "2026-09-08T00:00:00Z",
                decisions: snapshot.decisions,
                late: snapshot.late,
                subjectiveMapCommitment: H2,
                custodyEvidence,
                approvalActors: {
                    cohortCustodian: "custodian-one",
                    admissionReviewer: "reviewer-two",
                },
            };
            const close = buildCohortClose(closeInput);
            expect(close.body.aggregateCounts).toEqual({ admitted: 1, rejected: 1, late: 0 });
            expect(new Set(close.body.rejected.map((entry) => entry.intakeId)).size).toBe(1);
            expect(buildCohortClose({
                ...closeInput,
                decisions: [...snapshot.decisions].reverse(),
            }).body.retentionEvidenceFingerprint).toBe(close.body.retentionEvidenceFingerprint);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("blocks close when deletion or custody evidence is invalid", () => {
        const overdue = sanitizedIntakeFixture();
        overdue.deletionEvidence[0]!.completedAt = "2026-09-08T00:00:00Z";
        expect(() => reviewSanitizedIntake(overdue, reviewOptions)).toThrow(/overdue/);
        const incomplete = sanitizedIntakeFixture();
        incomplete.deletionEvidence.pop();
        expect(() => reviewSanitizedIntake(incomplete, reviewOptions)).toThrow(/exact-stores-required/);

        const admitted = reviewSanitizedIntake(sanitizedIntakeFixture(), reviewOptions);
        expect(() => buildCohortClose({
            epochId: "epoch-test-release",
            freezeManifestFingerprint: H1,
            closedAt: "2026-09-08T00:00:00Z",
            decisions: [admitted],
            late: [],
            subjectiveMapCommitment: H2,
            custodyEvidence: { ...custodyEvidence, diagnosticsAccess: true },
            approvalActors: { cohortCustodian: "custodian-one", admissionReviewer: "reviewer-two" },
        })).toThrow(/access-prohibited/);
        expect(() => buildCohortClose({
            epochId: "epoch-test-release",
            freezeManifestFingerprint: H1,
            closedAt: "2026-09-08T00:00:00Z",
            decisions: [admitted],
            late: [],
            subjectiveMapCommitment: H2,
            custodyEvidence: { ...custodyEvidence, verifiedThrough: "2026-09-07T23:59:59Z" },
            approvalActors: { cohortCustodian: "custodian-one", admissionReviewer: "reviewer-two" },
        })).toThrow(/does-not-cover-close/);
    });

    it("rejects deletion evidence completed after the cohort closed", () => {
        const trailing = sanitizedIntakeFixture();
        for (const evidence of trailing.deletionEvidence) {
            evidence.deadline = "2026-09-12T00:00:00Z";
            evidence.completedAt = "2026-09-10T00:00:00Z";
        }
        // Intake admits this evidence because every store sits inside its own
        // deadline; only the close manifest compares completion against closedAt.
        const admitted = reviewSanitizedIntake(trailing, reviewOptions);
        expect(() => buildCohortClose({
            epochId: "epoch-test-release",
            freezeManifestFingerprint: H1,
            closedAt: "2026-09-08T00:00:00Z",
            decisions: [admitted],
            late: [],
            subjectiveMapCommitment: H2,
            custodyEvidence,
            approvalActors: { cohortCustodian: "custodian-one", admissionReviewer: "reviewer-two" },
        })).toThrow(/deletion-after-close/);
    });
});

/**
 * Yields a pid that is not running: a child is spawned and reaped so the kernel
 * releases its pid, then each candidate is confirmed dead so a recycled pid cannot
 * make an abandoned-lock fixture look live. Returns null when nothing can be
 * proven dead.
 */
function deadPid(): number | null {
    const reaped = spawnSync(process.execPath, ["--version"], { stdio: "ignore" }).pid;
    for (const candidate of [reaped, 4_194_301, 4_194_302, 4_194_303]) {
        if (typeof candidate !== "number" || !Number.isInteger(candidate) || candidate <= 1) continue;
        try {
            process.kill(candidate, 0);
        } catch (error) {
            if ((error as { code?: string }).code === "ESRCH") return candidate;
        }
    }
    return null;
}

function seedLock(root: string, owner: { pid: number; nonce: string; acquiredAt: number } | null): string {
    const lock = join(root, ".lock");
    mkdirSync(lock, { recursive: true });
    if (owner !== null) writeFileSync(join(lock, "owner.json"), `${JSON.stringify(owner)}\n`);
    return lock;
}

describe("cohort store lock", () => {
    it("reclaims a lock whose recorded holder is dead and whose lease expired", () => {
        const pid = deadPid();
        if (pid === null) return;
        const root = mkdtempSync(join(tmpdir(), "cohort-lock-"));
        try {
            const lock = seedLock(root, { pid, nonce: "abandoned-worker", acquiredAt: Date.now() - 600_000 });
            const store = new ProspectiveIntakeStore(root);
            expect(store.readDecisions()).toEqual({ decisions: [], late: [] });
            expect(existsSync(lock)).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("reclaims a lock with no owner record once the directory outlives the lease", () => {
        const root = mkdtempSync(join(tmpdir(), "cohort-lock-"));
        try {
            const lock = seedLock(root, null);
            const orphaned = new Date(Date.now() - 600_000);
            utimesSync(lock, orphaned, orphaned);
            const store = new ProspectiveIntakeStore(root);
            expect(store.readDecisions()).toEqual({ decisions: [], late: [] });
            expect(existsSync(lock)).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("reports busy while the recorded holder is live inside its lease", () => {
        const root = mkdtempSync(join(tmpdir(), "cohort-lock-"));
        try {
            const lock = seedLock(root, { pid: process.pid, nonce: "live-holder", acquiredAt: Date.now() });
            const store = new ProspectiveIntakeStore(root);
            expect(() => store.readDecisions()).toThrow(/cohort-store: busy/);
            expect(existsSync(lock)).toBe(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 20_000);
});
