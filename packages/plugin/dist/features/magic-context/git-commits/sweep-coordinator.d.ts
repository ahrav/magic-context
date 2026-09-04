import type { Database } from "../../../shared/sqlite";
export declare const GIT_SWEEP_COOLDOWN_MS: number;
export declare const GIT_SWEEP_LEASE_TTL_MS: number;
/**
 * Re-probe horizon for structurally non-indexable directories (not a repo /
 * empty repo). Long enough to stop per-tick log flooding, short enough that a
 * directory that becomes a real repo starts indexing within a day.
 */
export declare const GIT_SWEEP_NON_INDEXABLE_REPROBE_MS: number;
export declare const GIT_SWEEP_LEASE_RENEWAL_MS: number;
export type GitSweepSkipReason = "lease_active" | "cooldown_active";
export interface GitSweepLeaseAcquired {
    acquired: true;
    projectPath: string;
    holderId: string;
    acquiredAt: number;
    leaseExpiresAt: number;
}
export interface GitSweepLeaseSkipped {
    acquired: false;
    projectPath: string;
    reason: GitSweepSkipReason;
    leaseHolder: string | null;
    leaseExpiresAt: number | null;
    lastSweptAt: number | null;
    nextAllowedAt: number | null;
}
export type GitSweepLeaseResult = GitSweepLeaseAcquired | GitSweepLeaseSkipped;
export interface GitSweepCoordinatorState {
    projectPath: string;
    leaseHolder: string | null;
    leaseExpiresAt: number | null;
    lastSweptAt: number | null;
}
export interface AcquireGitSweepLeaseOptions {
    cooldownMs?: number;
    leaseTtlMs?: number;
    /**
     * Skip the recently-swept cooldown gate, acquiring on mutual-exclusion
     * (lease) alone. Used by the backlog-drain path: draining unembedded rows
     * has no git-log cost and must run every tick until the backlog clears, so
     * it must not be starved by a cooldown the dream-timer sweep advanced.
     * Cross-process duplication is still prevented by the lease itself, and the
     * caller releases with releaseGitSweepLease (which does NOT advance the
     * cooldown), keeping the dream-timer's cooldown tracking independent.
     */
    ignoreCooldown?: boolean;
}
export declare function getGitSweepCoordinatorState(db: Database, projectPath: string): GitSweepCoordinatorState | null;
export declare function acquireGitSweepLease(db: Database, projectPath: string, holderId: string, options?: AcquireGitSweepLeaseOptions): GitSweepLeaseResult;
export declare function renewGitSweepLease(db: Database, projectPath: string, holderId: string, leaseTtlMs?: number): boolean;
export declare function markGitSweepSuccessAndRelease(db: Database, projectPath: string, holderId: string): boolean;
/**
 * Park a structurally non-indexable project (not a git repo, or a repo with
 * no commits) and release the lease. Re-probes are still allowed after
 * `reprobeMs` — a plain directory can be `git init`-ed and an empty repo gets
 * its first commit — but until then every sweep tick would fail identically,
 * so the cooldown gate absorbs them. Implemented by future-dating
 * `last_swept_at` so the existing cooldown arithmetic
 * (`last_swept_at + cooldownMs`) yields the long re-probe horizon without a
 * schema change; `last_swept_at` is only ever read by that arithmetic.
 */
export declare function parkGitSweepNonIndexable(db: Database, projectPath: string, holderId: string, reprobeMs?: number): boolean;
export declare function releaseGitSweepLease(db: Database, projectPath: string, holderId: string): void;
//# sourceMappingURL=sweep-coordinator.d.ts.map