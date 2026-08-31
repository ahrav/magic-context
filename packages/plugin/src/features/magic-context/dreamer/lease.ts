import type { Database } from "../../../shared/sqlite";
import { deleteDreamState, getDreamState, setDreamState } from "./storage-dream-state";

const LEASE_DURATION_MS = 2 * 60 * 1000; // 2 minutes — renewed periodically during task execution

/**
 *
 */
export const DREAMING_LEASE_KEY = "dreaming";

interface LeaseRowKeys {
    holder: string;
    heartbeat: string;
    expiry: string;
    generation: string;
}

function rowKeys(leaseKey: string): LeaseRowKeys {
    // The default lease uses un-namespaced row keys to retain existing persisted lease state.
    if (leaseKey === DREAMING_LEASE_KEY) {
        return {
            holder: "dreaming_lease_holder",
            heartbeat: "dreaming_lease_heartbeat",
            expiry: "dreaming_lease_expiry",
            generation: "dreaming_lease_generation",
        };
    }
    return {
        holder: `lease:${leaseKey}:holder`,
        heartbeat: `lease:${leaseKey}:heartbeat`,
        expiry: `lease:${leaseKey}:expiry`,
        generation: `lease:${leaseKey}:generation`,
    };
}

function getLeaseExpiry(db: Database, keys: LeaseRowKeys): number | null {
    const value = getDreamState(db, keys.expiry);
    if (!value) {
        return null;
    }

    const expiry = Number(value);
    return Number.isFinite(expiry) ? expiry : null;
}

export function isLeaseActive(db: Database, leaseKey: string = DREAMING_LEASE_KEY): boolean {
    const expiry = getLeaseExpiry(db, rowKeys(leaseKey));
    return expiry !== null && expiry > Date.now();
}

export function getLeaseHolder(db: Database, leaseKey: string = DREAMING_LEASE_KEY): string | null {
    return getDreamState(db, rowKeys(leaseKey).holder);
}

export function getLeaseGeneration(
    db: Database,
    leaseKey: string = DREAMING_LEASE_KEY,
): number | null {
    const value = getDreamState(db, rowKeys(leaseKey).generation);
    if (!value) return null;
    const generation = Number(value);
    return Number.isSafeInteger(generation) && generation > 0 ? generation : null;
}

export function peekLeaseHolderAndExpiry(
    db: Database,
    expectedHolder: string,
    leaseKey: string = DREAMING_LEASE_KEY,
): boolean {
    const keys = rowKeys(leaseKey);
    const holder = getDreamState(db, keys.holder);
    if (holder !== expectedHolder) return false;
    const expiryStr = getDreamState(db, keys.expiry);
    if (!expiryStr) return false;
    const expiry = Number(expiryStr);
    return Number.isFinite(expiry) && expiry >= Date.now();
}

export function leaseOwnershipMatches(
    db: Database,
    expectedHolder: string,
    expectedGeneration: number,
    leaseKey: string = DREAMING_LEASE_KEY,
): boolean {
    return (
        getLeaseGeneration(db, leaseKey) === expectedGeneration &&
        peekLeaseHolderAndExpiry(db, expectedHolder, leaseKey)
    );
}

// Each lease mutation uses `BEGIN IMMEDIATE` because the lease state spans four rows.
// `BEGIN IMMEDIATE` acquires SQLite's write lock before the transaction reads lease state.
// A deferred `BEGIN` acquires SQLite's write lock only at the first write.
// The write lock makes each lease mutation atomic across processes sharing the SQLite file.
// Without `BEGIN IMMEDIATE`, two readers can observe an inactive lease before either acquires the write lock.
function runImmediate<T>(db: Database, body: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
        const result = body();
        db.exec("COMMIT");
        committed = true;
        return result;
    } finally {
        if (!committed) {
            try {
                db.exec("ROLLBACK");
            } catch {
            }
        }
    }
}

export interface LeaseAcquisition {
    acquiredAt: number;
    generation: number;
}

export function acquireLeaseWithAcquisition(
    db: Database,
    holderId: string,
    leaseKey: string = DREAMING_LEASE_KEY,
): LeaseAcquisition | null {
    const keys = rowKeys(leaseKey);
    return runImmediate(db, () => {
        const existingHolder = getLeaseHolder(db, leaseKey);
        if (isLeaseActive(db, leaseKey) && existingHolder && existingHolder !== holderId) {
            return null;
        }

        const now = Date.now();
        const priorGeneration = getLeaseGeneration(db, leaseKey) ?? 0;
        const generation =
            existingHolder === holderId ? Math.max(1, priorGeneration) : priorGeneration + 1;
        setDreamState(db, keys.holder, holderId);
        setDreamState(db, keys.heartbeat, String(now));
        setDreamState(db, keys.expiry, String(now + LEASE_DURATION_MS));
        setDreamState(db, keys.generation, String(generation));
        return { acquiredAt: now, generation };
    });
}

export function acquireLease(
    db: Database,
    holderId: string,
    leaseKey: string = DREAMING_LEASE_KEY,
): boolean {
    return acquireLeaseWithAcquisition(db, holderId, leaseKey) !== null;
}

export function renewLease(
    db: Database,
    holderId: string,
    leaseKey: string = DREAMING_LEASE_KEY,
    expectedGeneration?: number,
): boolean {
    const keys = rowKeys(leaseKey);
    return runImmediate(db, () => {
        if (
            getLeaseHolder(db, leaseKey) !== holderId ||
            !isLeaseActive(db, leaseKey) ||
            (expectedGeneration !== undefined &&
                getLeaseGeneration(db, leaseKey) !== expectedGeneration)
        ) {
            return false;
        }

        const now = Date.now();
        setDreamState(db, keys.heartbeat, String(now));
        setDreamState(db, keys.expiry, String(now + LEASE_DURATION_MS));
        return true;
    });
}

export function runLeaseGuardedWrite<T>(
    db: Database,
    holderId: string,
    leaseKey: string,
    fn: () => T,
    expectedGeneration?: number,
): T {
    return runImmediate(db, () => {
        if (
            !peekLeaseHolderAndExpiry(db, holderId, leaseKey) ||
            (expectedGeneration !== undefined &&
                getLeaseGeneration(db, leaseKey) !== expectedGeneration)
        ) {
            throw new Error("Dream lease lost before guarded write");
        }
        return fn();
    });
}

/** The lease TTL is twice the renewal interval, so one missed or contended renewal leaves one full interval before expiry.
 * */
const LEASE_HEARTBEAT_INTERVAL_MS = 60 * 1000;

export interface LeaseHeartbeat {
    /** Stopping the heartbeat timer is idempotent. */
    stop(): void;
    /* */
    readonly lost: boolean;
}

/**
 * Renewal tolerates transient database contention because one missed 60-second renewal cannot expire a 2-minute lease.
 * A transient `SQLITE_BUSY` renewal failure does not abort the task.
 * lost.
 *
 * We declare the lease lost and call `onLost` once when another holder owns the lease or no renewal is confirmed for more than `LEASE_DURATION_MS`.
 * Another holder actively owns the lease when `renewLease` fails and `acquireLease` cannot reclaim it.
 * A delayed heartbeat can reclaim its own expired lease.
 *     guaranteed.
 * The heartbeat loop retries a transient error on the next beat while the last confirmed renewal is within `LEASE_DURATION_MS`.
 */
export function startLeaseHeartbeat(
    db: Database,
    holderId: string,
    leaseKey: string,
    onLost: (reason: string) => void,
    intervalOrAcquisition: number | LeaseAcquisition = LEASE_HEARTBEAT_INTERVAL_MS,
): LeaseHeartbeat {
    const intervalMs =
        typeof intervalOrAcquisition === "number"
            ? intervalOrAcquisition
            : LEASE_HEARTBEAT_INTERVAL_MS;
    const acquisition =
        typeof intervalOrAcquisition === "number" ? undefined : intervalOrAcquisition;
    let lost = false;
    let expectedGeneration = acquisition?.generation ?? getLeaseGeneration(db, leaseKey);
    let lastConfirmedAt = acquisition?.acquiredAt ?? Date.now();
    const declareLost = (reason: string): void => {
        if (lost) return;
        lost = true;
        onLost(reason);
    };
    const beat = () => {
        if (lost) return;
        try {
            if (
                renewLease(
                    db,
                    holderId,
                    leaseKey,
                    expectedGeneration === null ? undefined : expectedGeneration,
                )
            ) {
                lastConfirmedAt = Date.now();
                return;
            }
            if (
                expectedGeneration !== null &&
                getLeaseGeneration(db, leaseKey) !== expectedGeneration
            ) {
                declareLost("lease generation changed — another holder acquired it");
                return;
            }
            // If no renewal is confirmed for more than `LEASE_DURATION_MS`, another process may acquire the lease.
            // The holder must stop after a gap longer than LEASE_DURATION_MS because another process may own the lease.
            if (Date.now() - lastConfirmedAt > LEASE_DURATION_MS) {
                declareLost("lease lapsed past TTL — another holder may have run");
                return;
            }
            // After a gap no longer than `LEASE_DURATION_MS`, `acquireLeaseWithAcquisition` reclaims a free expired lease; it returns `null` only when another holder owns the lease.
            const reacquired = acquireLeaseWithAcquisition(db, holderId, leaseKey);
            if (reacquired) {
                if (expectedGeneration !== null && reacquired.generation !== expectedGeneration) {
                    declareLost("lease generation changed during reacquisition");
                    return;
                }
                expectedGeneration = reacquired.generation;
                lastConfirmedAt = Date.now();
                return;
            }
            declareLost("lease acquired by another holder");
        } catch {
            if (Date.now() - lastConfirmedAt > LEASE_DURATION_MS) {
                declareLost("lease renewal unconfirmed past TTL");
            }
        }
    };

    // The initial synchronous beat prevents intervalMs from delaying the first lease-renewal attempt.
    beat();

    const timer = lost ? undefined : setInterval(beat, intervalMs);
    return {
        stop: () => {
            if (timer) clearInterval(timer);
        },
        get lost() {
            return lost;
        },
    };
}

export function releaseLease(
    db: Database,
    holderId: string,
    leaseKey: string = DREAMING_LEASE_KEY,
): void {
    const keys = rowKeys(leaseKey);
    runImmediate(db, () => {
        if (getLeaseHolder(db, leaseKey) !== holderId) {
            return;
        }

        deleteDreamState(db, keys.holder);
        deleteDreamState(db, keys.heartbeat);
        deleteDreamState(db, keys.expiry);
    });
}
