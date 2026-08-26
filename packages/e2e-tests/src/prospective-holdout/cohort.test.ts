import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCohortClose, ProspectiveIntakeStore } from "./cohort";
import { HoldoutContractError } from "./contract";
import { reviewSanitizedIntake, staticPrivacyRejection } from "./intake";
import { LOCK_OWNER_FILE, lockAbandoned, lockSidelinePath, takeOverLock, withRecoverableLock } from "./lock";
import { deadPid, H1, H2, H3, sanitizedIntakeFixture } from "./test-fixtures";

const key = new TextEncoder().encode("c".repeat(32));
const reviewOptions = {
    commitmentKey: key,
    expectedRubricFingerprint: H3,
    freezePublishedAt: "2026-09-01T00:00:00Z",
    intakeOpensAt: "2026-09-01T00:00:00Z",
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


function seedLock(root: string, owner: { pid: number; nonce: string; acquiredAt: number } | null): string {
    const lock = join(root, ".lock");
    mkdirSync(lock, { recursive: true });
    if (owner !== null) writeFileSync(join(lock, "owner.json"), `${JSON.stringify(owner)}\n`);
    return lock;
}

function pause(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Arranges for `lock` to be removed a moment from now by a separate process, and
 * returns once that process is running. A waiter blocks its own thread between
 * acquisition attempts, so nothing in this process could release the lock while
 * it waits: only another process can produce a release the waiter observes.
 *
 * The removal is sequenced behind a marker the caller's return writes, and the
 * caller waits for the poller to start, so the release lands after the waiter's
 * first attempt has already failed and well inside the acquire timeout.
 */
function releaseFromCompetingProcess(root: string, lock: string): void {
    const polling = join(root, "holder-polling");
    const release = join(root, "holder-release");
    // Paths arrive as positional arguments, so no path text is spliced into the script.
    const script = ': > "$2"; while [ ! -e "$3" ]; do sleep 0.01; done; sleep 0.15; rm -rf "$1"';
    const holder = spawn("/bin/sh", ["-c", script, "sh", lock, polling, release], { stdio: "ignore" });
    holder.unref();
    const startupDeadline = Date.now() + 10_000;
    while (!existsSync(polling)) {
        if (Date.now() >= startupDeadline) throw new Error("competing lock holder never started");
        pause(5);
    }
    writeFileSync(release, "");
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

    it("takes the lock a live holder releases while a waiter is waiting", () => {
        const root = mkdtempSync(join(tmpdir(), "cohort-lock-"));
        try {
            // A live holder inside its lease is never reclaimable, so the read can only
            // succeed by retrying across the release the competing process performs.
            const lock = seedLock(root, { pid: process.pid, nonce: "live-holder", acquiredAt: Date.now() });
            releaseFromCompetingProcess(root, lock);
            const store = new ProspectiveIntakeStore(root);
            const started = Date.now();
            expect(store.readDecisions()).toEqual({ decisions: [], late: [] });
            // An uncontended acquisition returns in about a millisecond, so the elapsed
            // wait is what distinguishes a read that waited out the holder from one that
            // found the lock already free and never entered the retry loop.
            expect(Date.now() - started).toBeGreaterThanOrEqual(100);
            expect(existsSync(lock)).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 20_000);

    it("keeps waiting when a failed claim leaves nothing at the lock path", () => {
        const root = mkdtempSync(join(tmpdir(), "cohort-lock-"));
        try {
            // A symlink to a missing target holds still, for a whole acquisition, the
            // state a release produces for an instant: `mkdirSync` refuses the path as
            // taken while every existence check on it reports nothing there. Reading
            // that absence as a failure is what would report busy for a free lock, so
            // acquisition must instead retry until its deadline.
            symlinkSync(join(root, "no-such-holder"), join(root, ".lock"));
            const store = new ProspectiveIntakeStore(root);
            const started = Date.now();
            expect(() => store.readDecisions()).toThrow(/cohort-store: busy/);
            expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 20_000);

    it("surfaces the filesystem error when the lock path cannot be created", () => {
        const root = mkdtempSync(join(tmpdir(), "cohort-lock-"));
        try {
            let refused: unknown;
            try {
                withRecoverableLock(join(root, "absent", ".lock"), { busyCode: "cohort-store: busy" }, () => {});
            } catch (error) {
                refused = error;
            }
            // A missing parent directory is not a busy peer, and reporting it as one
            // would hide the one fact that explains the failure.
            expect((refused as { code?: string }).code).toBe("ENOENT");
            expect(refused).not.toBeInstanceOf(HoldoutContractError);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("surfaces a refused permission on the store root rather than busy", () => {
        // A process running as root creates the lock regardless of the mode, so the
        // permission this asserts on does not exist there.
        if (process.getuid?.() === 0) return;
        const root = mkdtempSync(join(tmpdir(), "cohort-lock-"));
        try {
            // The store creates its own root, and a recursive create leaves an existing
            // directory's mode alone, so a read-only root reaches the lock as EACCES.
            chmodSync(root, 0o500);
            const store = new ProspectiveIntakeStore(root);
            let refused: unknown;
            try {
                store.readDecisions();
            } catch (error) {
                refused = error;
            }
            expect((refused as { code?: string }).code).toBe("EACCES");
            expect(refused).not.toBeInstanceOf(HoldoutContractError);
        } finally {
            chmodSync(root, 0o700);
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("removes the sideline it moves a reclaimed lock to", () => {
        const root = mkdtempSync(join(tmpdir(), "cohort-lock-"));
        try {
            const lock = seedLock(root, null);
            const orphaned = new Date(Date.now() - 600_000);
            utimesSync(lock, orphaned, orphaned);
            let ran = false;
            withRecoverableLock(lock, { busyCode: "cohort-store: busy" }, () => {
                ran = true;
            });
            // The takeover renames the abandoned lock aside before removing it, so a
            // reclaim that leaves the sideline behind leaves an entry in the lock's
            // parent that no later acquisition removes.
            expect(ran).toBe(true);
            expect(existsSync(lock)).toBe(false);
            expect(existsSync(lockSidelinePath(lock))).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("removes and claims nothing when the takeover of an abandoned lock loses its rename", () => {
        const root = mkdtempSync(join(tmpdir(), "cohort-lock-"));
        try {
            // An abandoned lock with no owner record reaches the reclaim path without
            // depending on a pid this test can prove dead.
            const lock = seedLock(root, null);
            const orphaned = new Date(Date.now() - 600_000);
            utimesSync(lock, orphaned, orphaned);
            // Occupying the sideline is what makes this process's rename fail, which is
            // the state a reclaimer that renamed first leaves for every other reclaimer
            // of the same lock. The occupant is non-empty because a rename onto an empty
            // directory replaces it and succeeds, which is the opposite of the loss
            // asserted here.
            const sideline = lockSidelinePath(lock);
            mkdirSync(sideline, { recursive: true });
            writeFileSync(join(sideline, "occupied"), "");
            let ran = false;
            const started = Date.now();
            expect(() => withRecoverableLock(lock, { busyCode: "cohort-store: busy" }, () => {
                ran = true;
            })).toThrow(/cohort-store: busy/);
            // A lost takeover deletes nothing and claims nothing: the lock stands where it
            // was, the sideline keeps its contents, and the guarded operation never runs.
            // Under an unconditional remove the lock would be gone and the operation would
            // have run, which is the concurrent entry two reclaimers must not produce.
            expect(ran).toBe(false);
            expect(existsSync(lock)).toBe(true);
            expect(existsSync(join(sideline, "occupied"))).toBe(true);
            // Waiting is the remaining behaviour once the reclaim budget is spent, so the
            // elapsed time separates this from an attempt that gave up without retrying.
            expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 20_000);

    it("refuses a takeover of a lock replaced after the abandonment test judged it", () => {
        const pid = deadPid();
        if (pid === null) return;
        const root = mkdtempSync(join(tmpdir(), "cohort-lock-"));
        try {
            const stale = { pid, nonce: "abandoned-worker", acquiredAt: Date.now() - 600_000 };
            const lock = seedLock(root, stale);
            // The verdict is reached while the stale holder is still the record on disk,
            // which is the only state an acquisition can judge.
            const judged = lockAbandoned(lock);
            expect(judged).toEqual({ owner: stale });
            // Another worker reclaims the lock and takes it in the gap between that
            // verdict and the takeover, so the path now holds a live holder's lock.
            rmSync(lock, { recursive: true, force: true });
            const fresh = { pid: process.pid, nonce: "fresh-holder", acquiredAt: Date.now() };
            seedLock(root, fresh);
            takeOverLock(lock, judged!);
            // The record no longer matches the one judged abandoned, so the takeover moves
            // and removes nothing and the new holder keeps the lock it claimed.
            expect(existsSync(lock)).toBe(true);
            expect(JSON.parse(readFileSync(join(lock, LOCK_OWNER_FILE), "utf8"))).toEqual(fresh);
            expect(existsSync(lockSidelinePath(lock))).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
