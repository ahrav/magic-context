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

/** Distinguishes "this path holds no parseable claim" from "this path could not be read at all". Release has to tell them apart: an unreadable record may still be this process's own claim, and treating a transient `EIO` or `EACCES` as a foreign owner let release report success over a directory it had not removed. */
class LockOwnerUnreadableError extends Error {}

function parseLockOwner(text: string): LockOwner | null {
    try {
        const value = JSON.parse(text) as unknown;
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

/** The three answers a lock record can give, kept apart because they license different actions. `owner` is a claim that can be judged. `none` means the path carries no claim, because the record is absent — the narrow window between `mkdirSync` and the owner write — or because its bytes do not parse. `unreadable` means the record may hold a claim that could not be read. Treating `unreadable` as `none` lets an inaccessible live lock look abandoned: the verdict falls back to the directory's mtime, which a lock held across a whole multi-minute rollout leaves older than the lease, and takeover then reads its own failed read as confirmation that the path still carries the recordless claim it judged. */
type LockOwnerRead =
    | { status: "owner"; owner: LockOwner }
    | { status: "none" }
    | { status: "unreadable"; code: string | undefined };

function readLockOwnerRecord(lock: string): LockOwnerRead {
    let text: string;
    try {
        text = readFileSync(join(lock, LOCK_OWNER_FILE), "utf8");
    } catch (error) {
        const code = errorCode(error);
        if (code === "ENOENT" || code === "ENOTDIR") return { status: "none" };
        return { status: "unreadable", code };
    }
    /** The checked bytes are parsed here rather than re-read: a second read can fail where the first succeeded, and a failure answered as "no claim" is exactly the conflation this type exists to prevent. */
    const owner = parseLockOwner(text);
    return owner === null ? { status: "none" } : { status: "owner", owner };
}

/** The null-collapsing view, for callers whose answer is the same either way: a read that failed and a record that is absent both mean "not confirmed to be this process's claim". */
function readLockOwner(lock: string): LockOwner | null {
    const read = readLockOwnerRecord(lock);
    return read.status === "owner" ? read.owner : null;
}

/** Release deletes a directory, so it must not read a transient `EIO` as proof the claim is foreign. An absent record and one whose bytes do not parse stay `null`; anything else raises. */
function readLockOwnerForRelease(lock: string): LockOwner | null {
    const read = readLockOwnerRecord(lock);
    if (read.status === "unreadable") {
        throw new LockOwnerUnreadableError(
            `lock owner record at ${lock} could not be read (${String(read.code)})`,
        );
    }
    return read.status === "owner" ? read.owner : null;
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
    const read = readLockOwnerRecord(lock);
    /** A record that could not be read is not evidence of an absent claim, so the mtime fallback below is not licensed here: that path exists for the window in which a live holder has created the directory and not yet written its record, and using it for a failed read judges an inaccessible live lock abandoned. */
    if (read.status === "unreadable") return null;
    if (read.status === "owner") {
        const { owner } = read;
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
 * `LOCK_NONCE` distinguishes reclaimers' sideline paths, and the counter distinguishes
 * successive takeovers by one reclaimer: a restoration that cannot land leaves the
 * directory in place by design, and reusing that path would make the next takeover's
 * rename fail into an occupied directory. Acquisition sets its reclaimed flag before
 * attempting the rename, so it does not retry, and an abandoned lock would be reported
 * busy. The `.reclaimed-` prefix is retained because release sweeps by prefix and owner.
 */
let sidelineSequence = 0;

/** The stable part of this process's sideline paths: what release sweeps by, and what a takeover extends with a per-takeover suffix. */
export function lockSidelinePrefix(lock: string): string {
    return `${lock}.reclaimed-${LOCK_NONCE}`;
}

export function lockSidelinePath(lock: string): string {
    sidelineSequence += 1;
    return `${lockSidelinePrefix(lock)}-${sidelineSequence}`;
}

/**
 * A live owner can replace the judged lock between `takeOverLock`'s ownership check and `renameSync`; verify `sideline`'s owner before removing it.
 * `sideline` is the foreign owner's only lock record; restore it before removal, by `link` into the reclaimed path or by moving the directory itself.
 * If neither restoration succeeds, leave `sideline` in place: deleting it can destroy a live owner's lock record, and an orphaned sideline only leaves `lock` unreclaimed.
 * Exported for tests: the branch is reachable only through a rename that races a live claimant, which a single process cannot stage.
 */
export function restoreOrRemoveSideline(
    lock: string,
    sideline: string,
    judged: LockAbandonment,
): void {
    /** The removal below destroys the sideline, so a read that merely failed must not stand in for an absent record: `sameLockOwner` matches two nulls, so a failed read against an mtime-judged verdict would delete a directory that may carry a live claim. An unreadable sideline falls through to the restoration attempts, which leave it in place when neither lands. */
    const read = readLockOwnerRecord(sideline);
    if (
        read.status !== "unreadable" &&
        sameLockOwner(read.status === "owner" ? read.owner : null, judged.owner)
    ) {
        rmSync(sideline, { recursive: true, force: true });
        return;
    }
    try {
        /** `link` refuses an occupied destination, so a third claimant that already published its own record is not overwritten. */
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
    /** The verification read has to distinguish a failure from an absent record, because `sameLockOwner` treats two nulls as a match: a recordless lock judged by mtime, verified through a read that merely failed, confirms itself and moves whatever claim the path actually holds. */
    const read = readLockOwnerRecord(lock);
    if (read.status === "unreadable") return;
    if (!sameLockOwner(read.status === "owner" ? read.owner : null, judged.owner)) return;
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
    /** A release has to reach this process's record wherever a reclaimer has moved it: a takeover that sidelined the directory can still restore it, and a record restored after its owner released would hold the path until that owner's process exits, because `lockAbandoned` will not reclaim a live holder's pid. The reclaimer's nonce names the sideline, so the sidelines are matched by this process's own owner record rather than by path. */
    const parent = dirname(lock);
    const prefix = `${basename(lock)}.reclaimed-`;
    const sweepSidelines = (): void => {
        /** An enumeration failure is not an empty directory: a parent that permits traversal by known path while denying listing would make every sweep skip this process's displaced claim, and release would then report success over a claim still on disk. `ENOENT` is the one case that genuinely means there is nothing to sweep. */
        let siblings: string[];
        try {
            siblings = readdirSync(parent);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "ENOENT") return;
            throw new LockOwnerUnreadableError(
                `lock sideline directory ${parent} could not be listed (${String(code)})`,
            );
        }
        for (const entry of siblings) {
            if (!entry.startsWith(prefix)) continue;
            const sideline = join(parent, entry);
            /** The propagating read, for the same reason the main lock uses it: a read failure here is not proof the sideline is someone else's, and skipping it would let release report success while this process's displaced claim is still on disk. */
            if (readLockOwnerForRelease(sideline)?.nonce !== LOCK_NONCE) continue;
            rmSync(sideline, { recursive: true, force: true });
        }
    };
    sweepSidelines();
    // A lock reclaimed from this process belongs to the reclaimer.
    // Deleting a reclaimed lock would let another waiter acquire a lock the reclaimer still believes it holds.
    if (readLockOwnerForRelease(lock)?.nonce !== LOCK_NONCE) {
        /** A takeover between the sweep and the read above moves this record to a sideline neither observation covered, so the sweep runs again once the path is known not to carry it. Each pass narrows the interleaving rather than closing it: reclamation cannot be made atomic against a concurrent reclaimer, which is why a holder that intends to act reads the lock again instead of trusting acquisition. */
        sweepSidelines();
        return;
    }
    rmSync(lock, { recursive: true, force: true });
    /** `force` succeeds against an absent path, so the removal above cannot distinguish "deleted this claim" from "a reclaimer moved it first". A reclaimer that then restores the displaced directory would leave this process's record at `lock` with the handle already marked released. Sweeping again catches the record wherever it landed, and the ownership re-read catches a restoration to `lock` itself. */
    sweepSidelines();
    if (readLockOwnerForRelease(lock)?.nonce === LOCK_NONCE) {
        rmSync(lock, { recursive: true, force: true });
        /** The same check-then-delete gap as above, so it gets the same treatment: a reclaimer moving this record between the check and the removal leaves it at a sideline, and only a sweep behind the delete finds it there. Each pass narrows the interleaving; none closes it, because reclamation cannot be made atomic against a concurrent reclaimer. */
        sweepSidelines();
    }
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
        /** The flag is set only once cleanup returns. Setting it first made a transient failure permanent: the directory still carried this live owner record, and a second call — believing the work was done — reported success to a caller that then disowned the claim, leaving a lock nothing could reclaim until the process exited. */
        release(): void {
            if (released) return;
            releaseLock(lockPath);
            released = true;
        },
    };
}
