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
import { LOCK_OWNER_FILE, lockAbandoned, lockSidelinePath, restoreOrRemoveSideline, takeOverLock, withRecoverableLock } from "./lock";
import { deadPid, H1, H2, H3, sanitizedIntakeFixture, frozenEventFixture } from "./test-fixtures";

const key = new TextEncoder().encode("c".repeat(32));
const reviewOptions = {
    commitmentKey: key,
    expectedRubricFingerprint: H3,
    frozenEvent: frozenEventFixture(),
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
    it("rejects in-memory deletion evidence whose stores or instants are invalid", () => {
        const base = staticPrivacyRejection(
            `intake-${"e".repeat(32)}`,
            sanitizedIntakeFixture().submittedAt,
            sanitizedIntakeFixture().deletionEvidence,
        );
        const closeInput = {
            epochId: "epoch-test-release",
            freezeManifestFingerprint: H1,
            closedAt: "2026-09-08T00:00:00Z",
            late: [],
            subjectiveMapCommitment: H2,
            custodyEvidence,
            approvalActors: { cohortCustodian: "custodian-one", admissionReviewer: "reviewer-two" },
        };
        const bogusStores = {
            ...base,
            deletionEvidence: base.deletionEvidence.map((entry, index) => ({
                ...entry,
                store: `bogus-${index}` as typeof entry.store,
            })),
        };
        expect(() => buildCohortClose({ ...closeInput, decisions: [bogusStores] }))
            .toThrow(/store/);
        const bogusInstant = {
            ...base,
            deletionEvidence: base.deletionEvidence.map((entry) => ({
                ...entry,
                completedAt: "not-an-instant" as typeof entry.completedAt,
            })),
        };
        expect(() => buildCohortClose({ ...closeInput, decisions: [bogusInstant] }))
            .toThrow(/completedAt/);
    });

    it("takes close snapshot atomically before later submissions become late", () => {
        const root = mkdtempSync(join(tmpdir(), "cohort-store-"));
        try {
            const store = new ProspectiveIntakeStore(root);
            const admitted = reviewSanitizedIntake(sanitizedIntakeFixture(), reviewOptions);
            expect(store.submit(admitted)).toBe("included");
            expect(store.submit(staticPrivacyRejection(
                `intake-${"e".repeat(32)}`,
                sanitizedIntakeFixture().submittedAt,
                sanitizedIntakeFixture().deletionEvidence,
            ))).toBe("included");
            const snapshot = store.closeSnapshot("epoch-test-release", "2026-09-08T00:00:00Z");
            expect(store.submit(staticPrivacyRejection(
                `intake-${"f".repeat(32)}`,
                sanitizedIntakeFixture().submittedAt,
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
 *
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
            // The store must retry after the competing process releases the lock.
            const lock = seedLock(root, { pid: process.pid, nonce: "live-holder", acquiredAt: Date.now() });
            releaseFromCompetingProcess(root, lock);
            const store = new ProspectiveIntakeStore(root);
            const started = Date.now();
            expect(store.readDecisions()).toEqual({ decisions: [], late: [] });
            expect(Date.now() - started).toBeGreaterThanOrEqual(100);
            expect(existsSync(lock)).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 20_000);

    it("keeps waiting when a failed claim leaves nothing at the lock path", () => {
        const root = mkdtempSync(join(tmpdir(), "cohort-lock-"));
        try {
            // `mkdirSync` treats a dangling symlink as taken, while existence checks treat it as absent.
            // `mkdirSync` can fail with `EEXIST` while `existsSync(lock)` is false, so acquisition must retry until its deadline.
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
            // A missing parent must report `ENOENT`, not `cohort-store: busy`.
            expect((refused as { code?: string }).code).toBe("ENOENT");
            expect(refused).not.toBeInstanceOf(HoldoutContractError);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("surfaces a refused permission on the store root rather than busy", () => {
        // Root bypasses permission checks.
        if (process.getuid?.() === 0) return;
        const root = mkdtempSync(join(tmpdir(), "cohort-lock-"));
        try {
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
            // An abandoned lock with no owner record reaches the reclaim path without requiring a pid that the test can prove dead.
            // The no-owner-record case does not require a pid that the test can prove dead.
            const lock = seedLock(root, null);
            const orphaned = new Date(Date.now() - 600_000);
            utimesSync(lock, orphaned, orphaned);
            // A non-empty sideline makes this process's rename fail.
            // A reclaimer that renames first leaves the sideline occupied for every other reclaimer of the same lock.
            // The sideline must be non-empty because renaming onto an empty directory replaces it and succeeds.
            // Renaming onto an empty directory succeeds by replacing it, so an empty occupant cannot model a lost takeover.
            // asserted here.
            const sideline = lockSidelinePath(lock);
            mkdirSync(sideline, { recursive: true });
            writeFileSync(join(sideline, "occupied"), "");
            let ran = false;
            const started = Date.now();
            expect(() => withRecoverableLock(lock, { busyCode: "cohort-store: busy" }, () => {
                ran = true;
            })).toThrow(/cohort-store: busy/);
            // A lost takeover deletes nothing and claims nothing; the lock remains, the sideline retains its contents, and the guarded operation does not run.
            // After a lost takeover, the sideline retains its contents and the guarded operation does not run.
            // A lost takeover must not remove `lock`; removing it would allow two reclaimers to enter the guarded operation.
            // Two reclaimers must not both enter the guarded operation.
            expect(ran).toBe(false);
            expect(existsSync(lock)).toBe(true);
            expect(existsSync(join(sideline, "occupied"))).toBe(true);
            // After the reclaim budget is spent, acquisition waits until its deadline.
            // The elapsed time distinguishes waiting until the deadline from giving up without retrying.
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
            // The abandonment verdict is reached while the stale holder remains recorded on disk.
            // An acquisition can judge only the holder record present on disk.
            const judged = lockAbandoned(lock);
            expect(judged).toEqual({ owner: stale });
            // Another worker can reclaim and acquire the lock between the abandonment verdict and takeover, leaving a live holder's lock at the path.
            // The takeover can encounter a live holder's lock after another worker acquires it.
            rmSync(lock, { recursive: true, force: true });
            const fresh = { pid: process.pid, nonce: "fresh-holder", acquiredAt: Date.now() };
            seedLock(root, fresh);
            takeOverLock(lock, judged!);
            // Because the record no longer matches the abandoned record, the takeover moves and removes nothing.
            // The new holder keeps the lock it claimed because the takeover moves and removes nothing.
            expect(existsSync(lock)).toBe(true);
            expect(JSON.parse(readFileSync(join(lock, LOCK_OWNER_FILE), "utf8"))).toEqual(fresh);
            expect(existsSync(lockSidelinePath(lock))).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("keeps a displaced live lock when neither restoration can land", () => {
        const root = mkdtempSync(join(tmpdir(), "cohort-lock-"));
        try {
            const lock = join(root, ".lock");
            const sideline = lockSidelinePath(lock);
            // A reclaimer judged a dead holder, but renamed away a live holder's replacement lock.
            const displaced = { pid: process.pid, nonce: "displaced-holder", acquiredAt: Date.now() };
            mkdirSync(sideline, { recursive: true });
            writeFileSync(join(sideline, LOCK_OWNER_FILE), `${JSON.stringify(displaced)}\n`);
            // A third claimant published its own record, so `link` is refused and the sideline directory cannot move back.
            const third = { pid: process.pid, nonce: "third-claimant", acquiredAt: Date.now() };
            mkdirSync(lock, { recursive: true });
            writeFileSync(join(lock, LOCK_OWNER_FILE), `${JSON.stringify(third)}\n`);

            const judgedDead = {
                owner: { pid: 999_999, nonce: "abandoned-worker", acquiredAt: Date.now() - 600_000 },
            };
            restoreOrRemoveSideline(lock, sideline, judgedDead);

            expect(existsSync(join(sideline, LOCK_OWNER_FILE))).toBe(true);
            expect(JSON.parse(readFileSync(join(sideline, LOCK_OWNER_FILE), "utf8")))
                .toEqual(displaced);
            expect(JSON.parse(readFileSync(join(lock, LOCK_OWNER_FILE), "utf8"))).toEqual(third);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("removes the sideline when it still holds the judged abandoned lock", () => {
        const root = mkdtempSync(join(tmpdir(), "cohort-lock-"));
        try {
            const lock = join(root, ".lock");
            const sideline = lockSidelinePath(lock);
            const stale = { pid: 999_999, nonce: "abandoned-worker", acquiredAt: Date.now() - 600_000 };
            mkdirSync(sideline, { recursive: true });
            writeFileSync(join(sideline, LOCK_OWNER_FILE), `${JSON.stringify(stale)}\n`);

            restoreOrRemoveSideline(lock, sideline, { owner: stale });

            expect(existsSync(sideline)).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
