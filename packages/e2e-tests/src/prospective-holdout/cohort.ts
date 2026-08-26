import { randomBytes } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import {
    CASE_ID_RE,
    CLOSE_SCHEMA,
    INTAKE_ID_RE,
    type CohortCloseManifest,
    HoldoutContractError,
    exact,
    hex64,
    instant,
    parseCloseManifest,
    record,
    staticId,
} from "./contract";
import {
    DELETION_STORES,
    parseDeletionEvidence,
    parseSanitizedIntake,
    type DeletionEvidence,
    type IntakeDisposition,
} from "./intake";

export type StaticPrivacyRejection = {
    status: "rejected";
    intakeId: string;
    reasonCode: "privacy-rejected";
    deletionEvidence: DeletionEvidence[];
};
export type CohortDisposition = IntakeDisposition | StaticPrivacyRejection;
export interface CohortSnapshot {
    decisions: CohortDisposition[];
    late: Array<{ intakeId: string }>;
}

export interface CustodyEvidence {
    schema: "prospective-custody-evidence/v1";
    verifiedThrough: string;
    custodianOutcomeAccess: false;
    admissionReviewerOutcomeAccess: false;
    buildIdentityAccess: false;
    diagnosticsAccess: false;
    concealedMapAccess: false;
}

export function parseCustodyEvidence(raw: unknown): CustodyEvidence {
    const value = record(raw, "cohort.custodyEvidence");
    exact(value, [
        "schema",
        "verifiedThrough",
        "custodianOutcomeAccess",
        "admissionReviewerOutcomeAccess",
        "buildIdentityAccess",
        "diagnosticsAccess",
        "concealedMapAccess",
    ], "cohort.custodyEvidence");
    if (value.schema !== "prospective-custody-evidence/v1") {
        throw new HoldoutContractError(["cohort.custodyEvidence.schema: version-invalid"]);
    }
    for (const field of [
        "custodianOutcomeAccess",
        "admissionReviewerOutcomeAccess",
        "buildIdentityAccess",
        "diagnosticsAccess",
        "concealedMapAccess",
    ] as const) {
        if (value[field] !== false) {
            throw new HoldoutContractError([`cohort.custodyEvidence.${field}: access-prohibited`]);
        }
    }
    return {
        schema: "prospective-custody-evidence/v1",
        verifiedThrough: instant(value.verifiedThrough, "cohort.custodyEvidence.verifiedThrough"),
        custodianOutcomeAccess: false,
        admissionReviewerOutcomeAccess: false,
        buildIdentityAccess: false,
        diagnosticsAccess: false,
        concealedMapAccess: false,
    };
}

/**
 * Identity of the process holding a cohort-store lock. `nonce` is what separates
 * this process's lock from one a reclaimer installed after taking the lock over:
 * pids are recycled, so a matching pid alone does not prove the directory on disk
 * is still the one this process created.
 */
interface LockOwner {
    pid: number;
    nonce: string;
    acquiredAt: number;
}

const LOCK_OWNER_FILE = "owner.json";
const LOCK_NONCE = randomBytes(16).toString("hex");
const LOCK_ACQUIRE_TIMEOUT_MS = 5_000;
/**
 * How long a recorded holder is presumed to still be working. The lease must be
 * strictly longer than LOCK_ACQUIRE_TIMEOUT_MS: a waiter gives up with
 * `cohort-store: busy` once the acquire timeout elapses, so any lease at or below
 * that timeout would let a waiter declare a slow but live holder abandoned and
 * reclaim the lock from underneath it. 60s keeps an order of magnitude above the
 * acquire timeout, far above the cost of the longest store operation (a full
 * `decisions` readdir plus parse), while still bounding how long a worker killed
 * mid-operation can wedge intake.
 */
const LOCK_LEASE_MS = 60_000;

function errorCode(error: unknown): string | undefined {
    return typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : undefined;
}

function holderAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // ESRCH is the only proof of death. EPERM means the signal was refused,
        // which the kernel only does for a process that exists under another uid,
        // so it proves the opposite. Any other code leaves liveness unknown, and
        // an unknown holder is treated as alive so the lock is never stolen on a
        // guess.
        return errorCode(error) !== "ESRCH";
    }
}

function readLockOwner(lock: string): LockOwner | null {
    try {
        const value = JSON.parse(readFileSync(join(lock, LOCK_OWNER_FILE), "utf8")) as unknown;
        if (typeof value !== "object" || value === null) return null;
        const { pid, nonce, acquiredAt } = value as Record<string, unknown>;
        // A pid of 0 or below addresses a process group rather than one process, so
        // `process.kill` would report the caller's own group as alive forever.
        if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
        if (typeof nonce !== "string" || nonce.length === 0) return null;
        if (typeof acquiredAt !== "number" || !Number.isFinite(acquiredAt)) return null;
        return { pid, nonce, acquiredAt };
    } catch {
        return null;
    }
}

function lockAbandoned(lock: string): boolean {
    const owner = readLockOwner(lock);
    if (owner !== null) {
        return Date.now() - owner.acquiredAt > LOCK_LEASE_MS && !holderAlive(owner.pid);
    }
    // Without a parseable record there is no pid to interrogate, so the directory's
    // own age is the only available evidence. A live holder publishes its record
    // microseconds after `mkdirSync`, so a record-less directory older than the
    // lease was orphaned inside that window and its holder is gone.
    try {
        return Date.now() - statSync(lock).mtimeMs > LOCK_LEASE_MS;
    } catch {
        return false;
    }
}

function claimLock(lock: string): boolean {
    try {
        mkdirSync(lock);
    } catch {
        return false;
    }
    const owner: LockOwner = { pid: process.pid, nonce: LOCK_NONCE, acquiredAt: Date.now() };
    try {
        writeFileSync(join(lock, LOCK_OWNER_FILE), `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600 });
    } catch {
        return false;
    }
    // A racing reclaimer can remove this directory between `mkdirSync` and the
    // record write and install its own lock in the same place. Reading the record
    // back is what proves the surviving lock is this process's rather than the
    // racer's; a mismatch is a lost race, so leave the winner's lock alone and let
    // the caller retry.
    return readLockOwner(lock)?.nonce === LOCK_NONCE;
}

function releaseLock(lock: string): void {
    // Only the process still recorded as owner may remove the directory. A lock
    // reclaimed out from under this process belongs to the reclaimer, and deleting
    // it would hand a third waiter a lock the reclaimer believes it holds.
    if (readLockOwner(lock)?.nonce !== LOCK_NONCE) return;
    rmSync(lock, { recursive: true, force: true });
}

function withLock<T>(root: string, operation: () => T): T {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const lock = join(root, ".lock");
    const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
    // One reclaim per acquisition bounds the loop: a freshly installed lock cannot
    // satisfy the lease test again before the acquire timeout expires, so every
    // later iteration goes through the deadline check.
    let reclaimed = false;
    while (!claimLock(lock)) {
        if (!reclaimed && lockAbandoned(lock)) {
            reclaimed = true;
            rmSync(lock, { recursive: true, force: true });
            continue;
        }
        if (!existsSync(lock) || Date.now() >= deadline) {
            throw new HoldoutContractError(["cohort-store: busy"]);
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    try {
        return operation();
    } finally {
        releaseLock(lock);
    }
}

function intakeId(disposition: CohortDisposition): string {
    return disposition.status === "admitted" ? disposition.intake.intakeId : disposition.intakeId;
}

function publishFileOnce(storeRoot: string, path: string, bytes: string): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Staging lives in a store-root directory the readers never scan. A hard kill between
    // the write and the cleanup leaves the staging file behind, and the readers reject any
    // name that is not a decision record, so a leftover inside `decisions` or `late` would
    // wedge every later read and close until an operator removed it by hand.
    const stagingDirectory = join(storeRoot, ".staging");
    mkdirSync(stagingDirectory, { recursive: true, mode: 0o700 });
    const staging = join(stagingDirectory, `${basename(path)}.${randomBytes(8).toString("hex")}`);
    try {
        writeFileSync(staging, bytes, { flag: "wx", mode: 0o600 });
        linkSync(staging, path);
    } catch (error) {
        if (!existsSync(path) || readFileSync(path, "utf8") !== bytes) throw error;
    } finally {
        rmSync(staging, { force: true });
    }
}

function parseStoredDisposition(raw: unknown): CohortDisposition {
    const value = record(raw, "cohort-store.record");
    if (value.status === "admitted") {
        exact(value, ["status", "intake", "caseId", "caseCommitment", "scenarioFingerprint"], "cohort-store.record");
        const intake = parseSanitizedIntake(value.intake);
        if (!intake.admission.accepted) throw new HoldoutContractError(["cohort-store.record: admission-mismatch"]);
        return {
            status: "admitted",
            intake,
            caseId: staticId(value.caseId, "cohort-store.record.caseId", CASE_ID_RE),
            caseCommitment: hex64(value.caseCommitment, "cohort-store.record.caseCommitment"),
            scenarioFingerprint: hex64(value.scenarioFingerprint, "cohort-store.record.scenarioFingerprint"),
        };
    }
    if (value.reasonCode === "admission-rejected") {
        exact(value, ["status", "intakeId", "reasonCode", "intake"], "cohort-store.record");
        const intake = parseSanitizedIntake(value.intake);
        if (intake.admission.accepted || intake.intakeId !== value.intakeId) {
            throw new HoldoutContractError(["cohort-store.record: rejection-mismatch"]);
        }
        return {
            status: "rejected",
            intakeId: staticId(value.intakeId, "cohort-store.record.intakeId", INTAKE_ID_RE),
            reasonCode: "admission-rejected",
            intake,
        };
    }
    if (value.reasonCode === "privacy-rejected") {
        exact(value, ["status", "intakeId", "reasonCode", "deletionEvidence"], "cohort-store.record");
        const deletionEvidence = parseDeletionEvidence(
            value.deletionEvidence,
            "cohort-store.record.deletionEvidence",
        );
        return {
            status: "rejected",
            intakeId: staticId(value.intakeId, "cohort-store.record.intakeId", INTAKE_ID_RE),
            reasonCode: "privacy-rejected",
            deletionEvidence,
        };
    }
    throw new HoldoutContractError(["cohort-store.record: disposition-invalid"]);
}

export class ProspectiveIntakeStore {
    constructor(readonly root: string) {}

    submit(disposition: CohortDisposition): "included" | "late" {
        return withLock(this.root, () => {
            const id = intakeId(disposition);
            const dispositionBytes = `${JSON.stringify(disposition, null, 2)}\n`;
            const decisionPath = join(this.root, "decisions", `${id}.json`);
            if (existsSync(decisionPath)) {
                try {
                    publishFileOnce(this.root, decisionPath, dispositionBytes);
                } catch {
                    throw new HoldoutContractError(["cohort-store: disposition-conflict"]);
                }
                return "included";
            }
            const closed = existsSync(join(this.root, "closed.json"));
            const directory = join(this.root, closed ? "late" : "decisions");
            const path = join(directory, `${id}.json`);
            const value = closed
                ? { intakeId: id, dispositionFingerprint: canonicalFingerprint(disposition) }
                : disposition;
            try {
                publishFileOnce(this.root, path, `${JSON.stringify(value, null, 2)}\n`);
            } catch {
                throw new HoldoutContractError(["cohort-store: disposition-conflict"]);
            }
            return closed ? "late" : "included";
        });
    }

    closeSnapshot(epochId: string, closedAt: string): CohortSnapshot {
        return withLock(this.root, () => {
            const marker = join(this.root, "closed.json");
            const bytes = `${JSON.stringify({ epochId, closedAt }, null, 2)}\n`;
            try {
                publishFileOnce(this.root, marker, bytes);
            } catch {
                throw new HoldoutContractError(["cohort-store: already-closed"]);
            }
            return this.readDecisionsUnlocked();
        });
    }

    readDecisions(): CohortSnapshot {
        return withLock(this.root, () => this.readDecisionsUnlocked());
    }

    private readDecisionsUnlocked(): CohortSnapshot {
        const readDirectory = (name: string): unknown[] => {
            const directory = join(this.root, name);
            if (!existsSync(directory)) return [];
            return readdirSync(directory).sort().map((file) => {
                if (!/^intake-[0-9a-f]{32}\.json$/.test(file)) {
                    throw new HoldoutContractError(["cohort-store: filename-invalid"]);
                }
                try {
                    return JSON.parse(readFileSync(join(directory, file), "utf8")) as unknown;
                } catch {
                    throw new HoldoutContractError(["cohort-store: record-invalid"]);
                }
            });
        };
        const late = readDirectory("late").map((raw) => {
            const value = record(raw, "cohort-store.late");
            exact(value, ["intakeId", "dispositionFingerprint"], "cohort-store.late");
            hex64(value.dispositionFingerprint, "cohort-store.late.dispositionFingerprint");
            return { intakeId: staticId(value.intakeId, "cohort-store.late.intakeId", INTAKE_ID_RE) };
        });
        return {
            decisions: readDirectory("decisions").map(parseStoredDisposition),
            late,
        };
    }
}

export function buildCohortClose(input: {
    epochId: string;
    freezeManifestFingerprint: string;
    closedAt: string;
    decisions: readonly CohortDisposition[];
    late: readonly { intakeId: string }[];
    subjectiveMapCommitment: string;
    custodyEvidence: unknown;
    approvalActors: { cohortCustodian: string; admissionReviewer: string };
}): CohortCloseManifest {
    const cases = input.decisions
        .filter((entry): entry is Extract<IntakeDisposition, { status: "admitted" }> => entry.status === "admitted")
        .map((entry) => ({
            intakeId: entry.intake.intakeId,
            caseId: entry.caseId,
            caseCommitment: entry.caseCommitment,
            familyId: entry.intake.familyId,
            scenarioFingerprint: entry.scenarioFingerprint,
            subjective: entry.intake.scenario.subjective,
        }))
        .sort((left, right) => left.caseId.localeCompare(right.caseId));
    const rejected = input.decisions
        .filter((entry): entry is Exclude<CohortDisposition, { status: "admitted" }> => entry.status === "rejected")
        .map((entry) => ({ intakeId: entry.intakeId, reasonCode: entry.reasonCode }))
        .sort((left, right) => left.intakeId.localeCompare(right.intakeId));
    const late = [...input.late].sort((left, right) => left.intakeId.localeCompare(right.intakeId));
    const closedAtMs = Date.parse(input.closedAt);
    const deletionEvidence = input.decisions.map((entry) => {
        const evidence = "intake" in entry ? entry.intake.deletionEvidence : entry.deletionEvidence;
        if (
            evidence.length !== DELETION_STORES.length ||
            new Set(evidence.map((item) => item.store)).size !== DELETION_STORES.length ||
            evidence.some((item) => Date.parse(item.completedAt) > Date.parse(item.deadline))
        ) {
            throw new HoldoutContractError(["cohort: deletion-evidence-invalid"]);
        }
        // A per-store deadline may fall after the cohort closes, so the deadline
        // test on its own admits evidence for deletion that has not run at close
        // time. Comparison reads the closed cohort, so every store's deletion must
        // complete no later than closedAt for the manifest's retention claim to
        // hold.
        if (evidence.some((item) => Date.parse(item.completedAt) > closedAtMs)) {
            throw new HoldoutContractError(["cohort: deletion-after-close"]);
        }
        return { intakeId: intakeId(entry), evidence };
    }).sort((left, right) => left.intakeId.localeCompare(right.intakeId));
    const custodyEvidence = parseCustodyEvidence(input.custodyEvidence);
    if (Date.parse(custodyEvidence.verifiedThrough) < Date.parse(input.closedAt)) {
        throw new HoldoutContractError(["cohort.custodyEvidence: does-not-cover-close"]);
    }
    const body = {
        epochId: input.epochId,
        freezeManifestFingerprint: input.freezeManifestFingerprint,
        closedAt: input.closedAt,
        cases,
        rejected,
        late,
        aggregateCounts: { admitted: cases.length, rejected: rejected.length, late: late.length },
        subjectiveMapCommitment: input.subjectiveMapCommitment,
        retentionEvidenceFingerprint: canonicalFingerprint(deletionEvidence),
        custodyEvidenceFingerprint: canonicalFingerprint(custodyEvidence),
    };
    const subjectFingerprint = canonicalFingerprint(body);
    return parseCloseManifest({
        schema: CLOSE_SCHEMA,
        body,
        approvals: [
            {
                kind: "cohort-custodian",
                approver: input.approvalActors.cohortCustodian,
                subjectFingerprint,
            },
            {
                kind: "admission-reviewer",
                approver: input.approvalActors.admissionReviewer,
                subjectFingerprint,
            },
        ],
    });
}
