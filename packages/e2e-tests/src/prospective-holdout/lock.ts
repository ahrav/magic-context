import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HoldoutContractError } from "./contract";

/**
 * Identity of the process holding a lock. `nonce` is what separates this
 * process's lock from one a reclaimer installed after taking the lock over:
 * pids are recycled, so a matching pid alone does not prove the directory on disk
 * is still the one this process created.
 */
interface LockOwner {
    pid: number;
    nonce: string;
    acquiredAt: number;
}

/** Name of the owner record a holder publishes inside the lock directory. */
export const LOCK_OWNER_FILE = "owner.json";
const LOCK_NONCE = randomBytes(16).toString("hex");
const LOCK_ACQUIRE_TIMEOUT_MS = 5_000;
/**
 * How long a recorded holder is presumed to still be working. The lease must be
 * strictly longer than LOCK_ACQUIRE_TIMEOUT_MS: a waiter gives up with the
 * caller's busy code once the acquire timeout elapses, so any lease at or below
 * that timeout would let a waiter declare a slow but live holder abandoned and
 * reclaim the lock from underneath it. 60s keeps an order of magnitude above the
 * acquire timeout, far above the cost of the longest guarded operation (a full
 * cohort `decisions` readdir plus parse, or a lifecycle ledger read, validate and
 * append), while still bounding how long a worker killed mid-operation can wedge
 * the resource the lock guards.
 */
export const LOCK_LEASE_MS = 60_000;
/**
 * Slot `Atomics.wait` parks on between attempts. Nothing stores to it or notifies
 * on it, so every wait sleeps its full timeout and one slot serves every waiter.
 */
const LOCK_WAIT_SLOT = new Int32Array(new SharedArrayBuffer(4));

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

/**
 * Verdict the abandonment test reaches on a lock, produced only for a lock judged
 * abandoned. `owner` is the record the judgement rested on, or null for a
 * directory with no parseable record, whose abandonment rests on the directory's
 * own age instead. Carrying that record is what lets a takeover confirm it acts on
 * the lock that was judged rather than on whatever occupies the path by the time
 * it runs.
 */
export interface LockAbandonment {
    owner: LockOwner | null;
}

/**
 * Judges whether the lock at `lock` was left behind by a holder that is gone, and
 * returns the evidence that judgement rests on so a takeover can act on the same
 * lock. A lock still inside its lease, or held by a process whose death is not
 * proven, is never abandoned.
 */
export function lockAbandoned(lock: string): LockAbandonment | null {
    const owner = readLockOwner(lock);
    if (owner !== null) {
        const expired = Date.now() - owner.acquiredAt > LOCK_LEASE_MS && !holderAlive(owner.pid);
        return expired ? { owner } : null;
    }
    // Without a parseable record there is no pid to interrogate, so the directory's
    // own age is the only available evidence. A live holder publishes its record
    // microseconds after `mkdirSync`, so a record-less directory older than the
    // lease was orphaned inside that window and its holder is gone.
    try {
        return Date.now() - statSync(lock).mtimeMs > LOCK_LEASE_MS ? { owner: null } : null;
    } catch {
        return null;
    }
}

function sameLockOwner(left: LockOwner | null, right: LockOwner | null): boolean {
    // An absent record matches only an absent record: a lock reclaimed and re-taken
    // since the judgement publishes a record where the judged directory had none.
    if (left === null || right === null) return left === right;
    return left.pid === right.pid && left.nonce === right.nonce && left.acquiredAt === right.acquiredAt;
}

/**
 * Path a reclaimer moves an abandoned lock to before removing it. The sideline is a
 * sibling of the lock because a rename cannot cross filesystems, and it ends in
 * this process's nonce so two reclaimers of the same lock cannot pick the same
 * name. The whole name is derived from the lock's own plus that nonce, so no reader
 * of the guarded resource can mistake it for one of that resource's records.
 */
export function lockSidelinePath(lock: string): string {
    return `${lock}.reclaimed-${LOCK_NONCE}`;
}

/**
 * Removes the abandoned lock `judged` was reached on, by renaming it aside and
 * removing what the rename moved.
 *
 * `renameSync` is what makes the takeover exclusive. Two waiters can judge the same
 * expired lock abandoned; the rename that lands first leaves nothing at `lock`, so
 * the other rename fails and that waiter removes nothing. An unconditional `rmSync`
 * hands it no such failure: it deletes whatever occupies the path, which by then is
 * the fresh lock the winner has already claimed and holds, and both waiters go on
 * to run the guarded operation at once. Re-reading the record before that `rmSync`
 * narrows the window without closing it, because the lock can still be reclaimed
 * and replaced between the read and the delete. Only a single operation that both
 * moves the directory and fails once it is already gone leaves one winner.
 *
 * The record comparison guards a different gap than the rename rather than standing
 * in for it: it refuses a takeover whose subject is no longer the holder the
 * abandonment test judged, so a lock released and legitimately re-taken between the
 * judgement and the takeover keeps its new holder even though a rename would have
 * succeeded against it.
 *
 * A hard kill between the rename and the removal leaves the sideline directory in
 * the lock's parent, where no later acquisition removes it.
 */
export function takeOverLock(lock: string, judged: LockAbandonment): void {
    if (!sameLockOwner(readLockOwner(lock), judged.owner)) return;
    const sideline = lockSidelinePath(lock);
    try {
        renameSync(lock, sideline);
    } catch {
        // Every rename failure leaves the lock where it stands, and none of them can be
        // told apart from another waiter having taken the lock over first, so the lock
        // is left alone and the next attempt treats it as ordinary contention.
        return;
    }
    rmSync(sideline, { recursive: true, force: true });
}

/**
 * Outcome of one acquisition attempt. `contended` is every failure another
 * process can clear by releasing or by finishing a reclaim, so a later attempt
 * can still win the lock. `structural` is a path no attempt can turn into a lock
 * directory, and carries the filesystem error so a caller reports that cause
 * rather than presenting a broken path as a busy peer.
 */
type LockClaim =
    | { status: "acquired" }
    | { status: "contended" }
    | { status: "structural"; error: unknown };

function claimLock(lock: string): LockClaim {
    try {
        mkdirSync(lock);
    } catch (error) {
        // EEXIST is the only `mkdirSync` failure a releasing holder clears: the path is
        // already a lock directory. Every other errno describes the path itself, a
        // missing parent or a refused permission, and waiting does not change it.
        if (errorCode(error) === "EEXIST") return { status: "contended" };
        return { status: "structural", error };
    }
    const owner: LockOwner = { pid: process.pid, nonce: LOCK_NONCE, acquiredAt: Date.now() };
    try {
        writeFileSync(join(lock, LOCK_OWNER_FILE), `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600 });
    } catch {
        // `mkdirSync` created this directory empty a moment ago, so the record write
        // fails only once a reclaimer has removed the directory or installed its own
        // record in it. That lock belongs to the reclaimer, which is contention.
        return { status: "contended" };
    }
    // A racing reclaimer can remove this directory between `mkdirSync` and the
    // record write and install its own lock in the same place. Reading the record
    // back is what proves the surviving lock is this process's rather than the
    // racer's; a mismatch is a lost race, so leave the winner's lock alone and let
    // the caller retry.
    return readLockOwner(lock)?.nonce === LOCK_NONCE ? { status: "acquired" } : { status: "contended" };
}

function releaseLock(lock: string): void {
    // Only the process still recorded as owner may remove the directory. A lock
    // reclaimed out from under this process belongs to the reclaimer, and deleting
    // it would hand a third waiter a lock the reclaimer believes it holds.
    if (readLockOwner(lock)?.nonce !== LOCK_NONCE) return;
    rmSync(lock, { recursive: true, force: true });
}

export interface RecoverableLockOptions {
    /** `area: kebab-code` raised when the lock is still held at the acquire deadline. */
    busyCode: string;
}

/**
 * Runs `operation` under the mutual exclusion of the lock directory at
 * `lockPath`, whose parent directory the caller creates: the parent's location
 * and permissions belong to whatever resource the lock guards, not to the lock.
 *
 * The lock survives a hard kill of its holder, so acquisition also reclaims a
 * lock whose recorded holder is provably dead and past its lease. Without that
 * reclaim, a process killed between `mkdirSync` and release would leave a
 * directory no later run can remove, and every later operation on the guarded
 * resource would report `options.busyCode` forever.
 *
 * `options.busyCode` describes exactly one situation: a lock still held when the
 * acquire deadline passes. A lock path that cannot be created at all raises the
 * underlying filesystem error instead, so a missing parent or a refused
 * permission is not reported as a busy peer.
 */
export function withRecoverableLock<T>(
    lockPath: string,
    options: RecoverableLockOptions,
    operation: () => T,
): T {
    const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
    // One reclaim per acquisition bounds the loop: a freshly installed lock cannot
    // satisfy the lease test again before the acquire timeout expires, so every
    // later iteration goes through the deadline check.
    let reclaimed = false;
    for (;;) {
        const claim = claimLock(lockPath);
        if (claim.status === "acquired") break;
        // Waiting out the acquire timeout on a path that can never hold a directory
        // ends in `options.busyCode`, which names contention that was never there.
        // The filesystem error is the honest diagnostic, and rethrowing it is what
        // keeps the errno: the callers name their busy codes in different areas, so
        // no single contract code could carry a cause that belongs to the path.
        if (claim.status === "structural") throw claim.error;
        // The verdict carries the record it rests on, so the takeover acts on the lock
        // that was judged abandoned rather than on whatever holds the path once it runs.
        // A takeover that loses its rename removes nothing, which leaves the state the
        // next iteration reads as ordinary contention.
        const abandoned = reclaimed ? null : lockAbandoned(lockPath);
        if (abandoned !== null) {
            reclaimed = true;
            takeOverLock(lockPath, abandoned);
            continue;
        }
        // Contention is all that remains, and a holder that releases mid-wait leaves
        // an absent directory behind, which the next attempt turns into an acquired
        // lock. So the deadline alone ends the wait: reading absence as a failure here
        // would report busy for a lock that is already free.
        if (Date.now() >= deadline) throw new HoldoutContractError([options.busyCode]);
        Atomics.wait(LOCK_WAIT_SLOT, 0, 0, 5);
    }
    try {
        return operation();
    } finally {
        releaseLock(lockPath);
    }
}
