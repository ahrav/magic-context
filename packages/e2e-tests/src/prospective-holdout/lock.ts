import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { HoldoutContractError } from "./contract";

/**
 * A unique nonce distinguishes a holder's lock from a replacement lock after PID reuse.
 * A PID alone cannot identify a lock after PID reuse.
 */
interface LockOwner {
    pid: number;
    nonce: string;
    acquiredAt: number;
}

/** Holders publish their owner records as `owner.json` inside lock directories. */
export const LOCK_OWNER_FILE = "owner.json";
const LOCK_NONCE = randomBytes(16).toString("hex");
const LOCK_ACQUIRE_TIMEOUT_MS = 5_000;
/**
 * `LOCK_LEASE_MS` must exceed `LOCK_ACQUIRE_TIMEOUT_MS` so waiters cannot reclaim a live holder's lock.
 */
export const LOCK_LEASE_MS = 60_000;
/**
 * `Atomics.wait` on `LOCK_WAIT_SLOT` always sleeps its full timeout because no code stores to or notifies that slot.
 * `LOCK_WAIT_SLOT` serves every waiter.
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
        // Only `ESRCH` proves death; `EPERM` proves the process exists but is inaccessible.
        // Non-`ESRCH` errors keep a parseable owner's lock from being reclaimed.
        // guess.
        return errorCode(error) !== "ESRCH";
    }
}

function readLockOwner(lock: string): LockOwner | null {
    try {
        const value = JSON.parse(readFileSync(join(lock, LOCK_OWNER_FILE), "utf8")) as unknown;
        if (typeof value !== "object" || value === null) return null;
        const { pid, nonce, acquiredAt } = value as Record<string, unknown>;
        // Nonpositive PIDs address process groups rather than individual processes.
        if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
        if (typeof nonce !== "string" || nonce.length === 0) return null;
        if (typeof acquiredAt !== "number" || !Number.isFinite(acquiredAt)) return null;
        return { pid, nonce, acquiredAt };
    } catch {
        return null;
    }
}

/**
 * `LockAbandonment` is returned only for a lock judged abandoned.
 * `owner` is the parsed record used to judge abandonment, or null when no record is parseable.
 * Without a parseable record, abandonment depends on the directory's age.
 * `owner` lets takeover verify that the path still contains the lock it judged.
 * it runs.
 */
export interface LockAbandonment {
    owner: LockOwner | null;
}

/**
 * A lock is not abandoned while its lease is active or when its holder's death is unproven.
 */
export function lockAbandoned(lock: string): LockAbandonment | null {
    const owner = readLockOwner(lock);
    if (owner !== null) {
        const expired = Date.now() - owner.acquiredAt > LOCK_LEASE_MS && !holderAlive(owner.pid);
        return expired ? { owner } : null;
    }
    try {
        return Date.now() - statSync(lock).mtimeMs > LOCK_LEASE_MS ? { owner: null } : null;
    } catch {
        return null;
    }
}

function sameLockOwner(left: LockOwner | null, right: LockOwner | null): boolean {
    // A reclaimed recordless lock publishes an owner record before takeover verifies it.
    if (left === null || right === null) return left === right;
    return left.pid === right.pid && left.nonce === right.nonce && left.acquiredAt === right.acquiredAt;
}

/**
 * The sideline must be a sibling of `lock` because `renameSync` cannot cross filesystems.
 * `LOCK_NONCE` distinguishes reclaimers' sideline paths.
 */
export function lockSidelinePath(lock: string): string {
    return `${lock}.reclaimed-${LOCK_NONCE}`;
}

/**
 * A live owner can replace the judged lock between `takeOverLock`'s ownership check and `renameSync`; verify `sideline`'s owner before removing it.
 * `sideline` is the foreign owner's only lock record; restore it before removal, by `link` into the reclaimed path or by moving the directory itself.
 * If neither restoration succeeds, leave `sideline` in place: deleting it can destroy a live owner's lock record, and an orphaned sideline only leaves `lock` unreclaimed.
 * Exported for tests: the branch is reachable only through a rename that races a live claimant, which a single process cannot stage.
 * commentlint: allow(JUDGE)
 */
export function restoreOrRemoveSideline(
    lock: string,
    sideline: string,
    judged: LockAbandonment,
): void {
    if (sameLockOwner(readLockOwner(sideline), judged.owner)) {
        rmSync(sideline, { recursive: true, force: true });
        return;
    }
    try {
        /** `link` refuses an occupied destination, so a third claimant that already published its own record is not overwritten. commentlint: allow(JUDGE) */
        linkSync(join(sideline, LOCK_OWNER_FILE), join(lock, LOCK_OWNER_FILE));
    } catch {
        try {
            renameSync(sideline, lock);
        } catch {
            return;
        }
        return;
    }
    rmSync(sideline, { recursive: true, force: true });
}

/**
 *
 * `renameSync` makes takeover exclusive: only the first waiter can move the expired lock from `lock`.
 * `rmSync(lock)` could delete a replacement lock and allow two waiters to enter the guarded operation.
 * Re-reading before `rmSync` cannot prevent replacement between the read and delete.
 * `renameSync` atomically moves the lock selected for takeover to the sideline.
 *
 * `sameLockOwner` prevents moving a lock re-taken after abandonment was judged.
 * `renameSync` alone could move a lock re-taken after abandonment was judged.
 *
 * A hard kill between the rename and removal leaves the sideline directory in the lock's parent, where no later acquisition removes it.
 */
export function takeOverLock(lock: string, judged: LockAbandonment): void {
    if (!sameLockOwner(readLockOwner(lock), judged.owner)) return;
    const sideline = lockSidelinePath(lock);
    try {
        renameSync(lock, sideline);
    } catch {
        // A `renameSync` error makes `takeOverLock` return without deleting `lock`.
        return;
    }
    restoreOrRemoveSideline(lock, sideline, judged);
}

/** True when `lock` still carries this process's claim. A holder that intends to act on a lock reads it again rather than trusting acquisition, because reclamation of an expired lock cannot be made atomic against a concurrent reclaimer. */
export function lockHeldByThisProcess(lock: string): boolean {
    return readLockOwner(lock)?.nonce === LOCK_NONCE;
}

/**
 * `contended` tells the caller to retry acquisition.
 * `structural` identifies a non-`EEXIST` `mkdirSync` failure so callers report it instead of treating it as contention.
 */
type LockClaim =
    | { status: "acquired" }
    | { status: "contended" }
    | { status: "structural"; error: unknown };

function claimLock(lock: string): LockClaim {
    try {
        mkdirSync(lock);
    } catch (error) {
        if (errorCode(error) === "EEXIST") return { status: "contended" };
        return { status: "structural", error };
    }
    const owner: LockOwner = { pid: process.pid, nonce: LOCK_NONCE, acquiredAt: Date.now() };
    try {
        writeFileSync(join(lock, LOCK_OWNER_FILE), `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600 });
    } catch {
        return { status: "contended" };
    }
    // A reclaimer can replace `lock` after the owner record is written; read-back detects the replacement.
    // A nonce mismatch means another process replaced the lock; leave that lock untouched.
    return readLockOwner(lock)?.nonce === LOCK_NONCE ? { status: "acquired" } : { status: "contended" };
}

function releaseLock(lock: string): void {
    /** A release has to reach this process's record wherever a reclaimer has moved it: a takeover that sidelined the directory can still restore it, and a record restored after its owner released would hold the path until that owner's process exits, because `lockAbandoned` will not reclaim a live holder's pid. The reclaimer's nonce names the sideline, so the sidelines are matched by this process's own owner record rather than by path. commentlint: allow(JUDGE) */
    const parent = dirname(lock);
    const prefix = `${basename(lock)}.reclaimed-`;
    const sweepSidelines = (): void => {
        let siblings: string[] = [];
        try {
            siblings = readdirSync(parent);
        } catch {
            siblings = [];
        }
        for (const entry of siblings) {
            if (!entry.startsWith(prefix)) continue;
            const sideline = join(parent, entry);
            if (readLockOwner(sideline)?.nonce !== LOCK_NONCE) continue;
            rmSync(sideline, { recursive: true, force: true });
        }
    };
    sweepSidelines();
    // A lock reclaimed from this process belongs to the reclaimer.
    // Deleting a reclaimed lock would let another waiter acquire a lock the reclaimer still believes it holds.
    if (readLockOwner(lock)?.nonce !== LOCK_NONCE) {
        /** A takeover between the sweep and the read above moves this record to a sideline neither observation covered, so the sweep runs again once the path is known not to carry it. Each pass narrows the interleaving rather than closing it: reclamation cannot be made atomic against a concurrent reclaimer, which is why a holder that intends to act reads the lock again instead of trusting acquisition. commentlint: allow(JUDGE) */
        sweepSidelines();
        return;
    }
    rmSync(lock, { recursive: true, force: true });
}

export interface RecoverableLockOptions {
    /* */
    busyCode: string;
}

/**
 * `operation` runs under the mutual exclusion provided by `lockPath`.
 * The caller creates `lockPath`'s parent directory.
 * The guarded resource determines `lockPath`'s parent location and permissions.
 *
 * Acquisition reclaims a lock only when its recorded holder is dead and its lease has expired.
 * A holder killed after writing its owner record and before release leaves a lock that requires reclamation.
 *
 * `options.busyCode` is raised only when the lock remains held at the acquire deadline.
 * Filesystem errors creating `lockPath` propagate instead of reporting `options.busyCode`.
 */
export function withRecoverableLock<T>(
    lockPath: string,
    options: RecoverableLockOptions,
    operation: () => T,
): T {
    const held = acquireRecoverableLock(lockPath, options);
    try {
        return operation();
    } finally {
        held.release();
    }
}

/**
 * `acquireRecoverableLock` holds `lockPath` until the returned `release` runs, for a guarded
 * span the caller cannot express as one operation — a run that interleaves reads and writes
 * over minutes rather than a single call.
 *
 * Acquisition and reclamation are `withRecoverableLock`'s, so both share one definition of
 * when a lock is abandoned and one takeover sequence.
 */
export function acquireRecoverableLock(
    lockPath: string,
    options: RecoverableLockOptions,
): { release(): void } {
    const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
    let reclaimed = false;
    for (;;) {
        const claim = claimLock(lockPath);
        if (claim.status === "acquired") break;
        if (claim.status === "structural") throw claim.error;
        const abandoned = reclaimed ? null : lockAbandoned(lockPath);
        if (abandoned !== null) {
            reclaimed = true;
            takeOverLock(lockPath, abandoned);
            continue;
        }
        if (Date.now() >= deadline) throw new HoldoutContractError([options.busyCode]);
        Atomics.wait(LOCK_WAIT_SLOT, 0, 0, 5);
    }
    let released = false;
    return {
        release(): void {
            if (released) return;
            released = true;
            releaseLock(lockPath);
        },
    };
}
