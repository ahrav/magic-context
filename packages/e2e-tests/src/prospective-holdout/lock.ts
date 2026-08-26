import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
    while (!claimLock(lockPath)) {
        if (!reclaimed && lockAbandoned(lockPath)) {
            reclaimed = true;
            rmSync(lockPath, { recursive: true, force: true });
            continue;
        }
        if (!existsSync(lockPath) || Date.now() >= deadline) {
            throw new HoldoutContractError([options.busyCode]);
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    try {
        return operation();
    } finally {
        releaseLock(lockPath);
    }
}
