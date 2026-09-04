import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { buildCohortClose, ProspectiveIntakeStore } from "./cohort";
import { HoldoutContractError } from "./contract";
import { reviewSanitizedIntake, staticPrivacyRejection } from "./intake";
import { LOCK_OWNER_FILE, lockAbandoned, lockSidelinePath, lockSidelinePrefix, restoreOrRemoveSideline, takeOverLock, withRecoverableLock } from "./lock";
import { deadPid, H1, H2, H3, sanitizedIntakeFixture, frozenEventFixture } from "./test-fixtures";

const key = new TextEncoder().encode("c".repeat(32));

/** Found by prefix rather than by asking for a path: `lockSidelinePath` allocates a fresh suffix on each call, so calling it after a takeover names a directory the takeover never used and reports it absent whatever the takeover left behind. */
function remainingSidelines(lock: string): string[] {
    const prefix = basename(lockSidelinePrefix(lock));
    return readdirSync(dirname(lock)).filter((entry) => entry.startsWith(prefix));
}
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
            expect(remainingSidelines(lock)).toEqual([]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("keeps a live lock whose owner record cannot be read", () => {
        // Root bypasses mode-bit checks, so owner-file reads succeed and cannot reach the
        // recordless fallback.
        if (process.getuid?.() === 0) return;
        const root = mkdtempSync(join(tmpdir(), "cohort-lock-"));
        const lock = seedLock(root, { pid: process.pid, nonce: "live-holder", acquiredAt: Date.now() });
        try {
            /** The mtime is aged past the lease because a holder of this lock runs for minutes, which is what makes the recordless fallback reachable while the claim is still live. */
            const orphaned = new Date(Date.now() - 600_000);
            utimesSync(lock, orphaned, orphaned);
            chmodSync(join(lock, LOCK_OWNER_FILE), 0o000);

            expect(lockAbandoned(lock)).toBeNull();

            /** Forced past the verdict, takeover still refuses: its own verification read fails the same way, so it cannot confirm the recordless claim it was handed. */
            takeOverLock(lock, { owner: null });
            expect(existsSync(lock)).toBe(true);
            expect(remainingSidelines(lock)).toEqual([]);
        } finally {
            chmodSync(join(lock, LOCK_OWNER_FILE), 0o600);
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("removes and claims nothing when a takeover cannot rename the lock aside", () => {
        // Mode bits do not restrain root, so the simulated rename failure would not occur.
        if (process.getuid?.() === 0) return;
        const root = mkdtempSync(join(tmpdir(), "cohort-lock-"));
        try {
            const lock = seedLock(root, null);
            const orphaned = new Date(Date.now() - 600_000);
            utimesSync(lock, orphaned, orphaned);
            const judged = lockAbandoned(lock);
            expect(judged).not.toBeNull();
            if (judged === null) return;

            // A read-execute parent makes the rename fail whatever path it targets, so this
            // exercises the branch without depending on where the sideline lands.
            chmodSync(root, 0o500);
            takeOverLock(lock, judged);
            chmodSync(root, 0o700);

            // A lost takeover deletes nothing: removing `lock` would let two reclaimers
            // enter the guarded operation.
            expect(existsSync(lock)).toBe(true);
        } finally {
            chmodSync(root, 0o700);
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("reclaims an abandoned lock even when a stale sideline is left behind", () => {
        const root = mkdtempSync(join(tmpdir(), "cohort-lock-"));
        try {
            const lock = seedLock(root, null);
            const orphaned = new Date(Date.now() - 600_000);
            utimesSync(lock, orphaned, orphaned);
            // `restoreOrRemoveSideline` deliberately leaves the displaced directory behind
            // when a third claimant occupies `lock`, so a sideline can outlive its takeover.
            // A takeover that reused that path renamed into an occupied directory and failed,
            // and acquisition spends its reclaim budget before the rename, so it did not
            // retry and reported an abandoned lock busy.
            const stale = lockSidelinePrefix(lock);
            mkdirSync(stale, { recursive: true });
            writeFileSync(join(stale, "occupied"), "");
            let ran = false;

            withRecoverableLock(lock, { busyCode: "cohort-store: busy" }, () => {
                ran = true;
            });

            expect(ran).toBe(true);
            // The foreign record left at the stale sideline is never destroyed.
            expect(existsSync(join(stale, "occupied"))).toBe(true);
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
            expect(remainingSidelines(lock)).toEqual([]);
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

    it("does not let a takeover restore a claim its owner already released", () => {
        const root = mkdtempSync(join(tmpdir(), "cohort-lock-"));
        try {
            const lock = join(root, ".lock");
            mkdirSync(root, { recursive: true });
            // This process holds the lock, so `LOCK_NONCE` is the owner on disk.
            const held = withRecoverableLock(lock, { busyCode: "cohort-store: busy" }, () => {
                // A reclaimer sidelines the directory while the owner still holds it.
                const sideline = lockSidelinePath(lock);
                renameSync(lock, sideline);
                return sideline;
            });
            // The release ran while the directory sat at the sideline.
            expect(existsSync(held)).toBe(false);
            expect(existsSync(lock)).toBe(false);
            // A restore attempt now finds nothing to move back, so a live pid cannot pin the path.
            expect(lockAbandoned(lock)).toBeNull();
            let ran = false;
            withRecoverableLock(lock, { busyCode: "cohort-store: busy" }, () => {
                ran = true;
            });
            expect(ran).toBe(true);
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
