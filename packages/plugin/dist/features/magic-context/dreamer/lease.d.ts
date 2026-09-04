import type { Database } from "../../../shared/sqlite";
/**
 * Dreamer v2 uses one lease PER CONFLICT-DOMAIN (memory:<project>,
 * key-files:<project>, user-memories, …) so disjoint-state tasks don't block
 * each other while the memory-mutating tasks still serialize. A lease is four
 * `dream_state` rows under a key namespace.
 *
 * `DREAMING_LEASE_KEY` is the legacy single-lease key. It keeps the original
 * `acquireLease(db, holderId)` signature working (the lease-key param defaults to
 * it) for the still-suite-based runner until the per-task scheduler replaces it.
 */
export declare const DREAMING_LEASE_KEY = "dreaming";
export declare function isLeaseActive(db: Database, leaseKey?: string): boolean;
export declare function getLeaseHolder(db: Database, leaseKey?: string): string | null;
export declare function getLeaseGeneration(db: Database, leaseKey?: string): number | null;
export declare function peekLeaseHolderAndExpiry(db: Database, expectedHolder: string, leaseKey?: string): boolean;
export declare function leaseOwnershipMatches(db: Database, expectedHolder: string, expectedGeneration: number, leaseKey?: string): boolean;
export interface LeaseAcquisition {
    acquiredAt: number;
    generation: number;
}
export declare function acquireLeaseWithAcquisition(db: Database, holderId: string, leaseKey?: string): LeaseAcquisition | null;
export declare function acquireLease(db: Database, holderId: string, leaseKey?: string): boolean;
export declare function renewLease(db: Database, holderId: string, leaseKey?: string, expectedGeneration?: number): boolean;
export declare function runLeaseGuardedWrite<T>(db: Database, holderId: string, leaseKey: string, fn: () => T, expectedGeneration?: number): T;
export interface LeaseHeartbeat {
    /** Stop the heartbeat timer. Safe to call more than once. */
    stop(): void;
    /** True once the lease was confirmed genuinely lost (and onLost was called). */
    readonly lost: boolean;
}
/**
 * Keep a held lease alive on a background interval, tolerating transient DB
 * contention. The brittle inline pattern this replaces aborted the whole task on
 * the FIRST renewal hiccup — including a transient SQLITE_BUSY throw under a
 * multi-instance lock storm — even though the 2-minute TTL means one missed 60s
 * beat is harmless. That killed multi-minute dreamer runs (map-memories/verify)
 * with "prompt aborted by external signal" when the lease was never actually
 * lost.
 *
 * We declare the lease lost (and call onLost ONCE) only when:
 *   - a DIFFERENT holder actively owns it — renewLease fails and acquireLease
 *     can't reclaim it (acquireLease reclaims an expired-but-free lease, so a
 *     self-inflicted expiry from our own delayed beat recovers instead of
 *     killing the run); or
 *   - a full TTL has elapsed with no confirmed renewal (only reachable via
 *     repeated transient throws), past which exclusive ownership can't be
 *     guaranteed.
 * A transient throw with a recent successful renewal is swallowed and retried on
 * the next beat.
 */
export declare function startLeaseHeartbeat(db: Database, holderId: string, leaseKey: string, onLost: (reason: string) => void, intervalOrAcquisition?: number | LeaseAcquisition): LeaseHeartbeat;
export declare function releaseLease(db: Database, holderId: string, leaseKey?: string): void;
//# sourceMappingURL=lease.d.ts.map