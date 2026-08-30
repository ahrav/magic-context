import type { Database } from "../../../shared/sqlite";
import { runImmediate } from "../../../shared/sqlite";

export const GIT_SWEEP_COOLDOWN_MS = 10 * 60 * 1000;
// Commit indexing can include two embedding drains (the indexer drain plus the
// timer follow-up drain). The lease is renewed every minute while the sweep is
// running, so this TTL is crash-recovery latency rather than the expected full
// wall-clock budget.
export const GIT_SWEEP_LEASE_TTL_MS = 5 * 60 * 1000;
/**
 * Re-probe horizon for structurally non-indexable directories (not a repo /
 * empty repo). Long enough to stop per-tick log flooding, short enough that a
 * directory that becomes a real repo starts indexing within a day.
 */
export const GIT_SWEEP_NON_INDEXABLE_REPROBE_MS = 24 * 60 * 60 * 1000;
export const GIT_SWEEP_LEASE_RENEWAL_MS = 60 * 1000;

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

interface GitSweepCoordinatorRow {
    project_path: string;
    lease_holder: string | null;
    lease_expires_at: number | null;
    last_swept_at: number | null;
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

function rowToState(row: GitSweepCoordinatorRow): GitSweepCoordinatorState {
    return {
        projectPath: row.project_path,
        leaseHolder: row.lease_holder,
        leaseExpiresAt: row.lease_expires_at,
        lastSweptAt: row.last_swept_at,
    };
}

export function getGitSweepCoordinatorState(
    db: Database,
    projectPath: string,
): GitSweepCoordinatorState | null {
    const row = db
        .prepare(
            `SELECT project_path, lease_holder, lease_expires_at, last_swept_at
             FROM git_sweep_coordinator
             WHERE project_path = ?`,
        )
        .get(projectPath) as GitSweepCoordinatorRow | undefined;
    return row ? rowToState(row) : null;
}

export function acquireGitSweepLease(
    db: Database,
    projectPath: string,
    holderId: string,
    options: AcquireGitSweepLeaseOptions = {},
): GitSweepLeaseResult {
    const cooldownMs = options.cooldownMs ?? GIT_SWEEP_COOLDOWN_MS;
    const leaseTtlMs = options.leaseTtlMs ?? GIT_SWEEP_LEASE_TTL_MS;

    return runImmediate(db, () => {
        const now = Date.now();
        const row = getGitSweepCoordinatorState(db, projectPath);
        if (row?.leaseHolder && row.leaseExpiresAt !== null && row.leaseExpiresAt > now) {
            return {
                acquired: false,
                projectPath,
                reason: "lease_active",
                leaseHolder: row.leaseHolder,
                leaseExpiresAt: row.leaseExpiresAt,
                lastSweptAt: row.lastSweptAt,
                nextAllowedAt: null,
            };
        }

        if (
            !options.ignoreCooldown &&
            row?.lastSweptAt !== null &&
            row?.lastSweptAt !== undefined
        ) {
            const nextAllowedAt = row.lastSweptAt + cooldownMs;
            if (nextAllowedAt > now) {
                return {
                    acquired: false,
                    projectPath,
                    reason: "cooldown_active",
                    leaseHolder: row.leaseHolder,
                    leaseExpiresAt: row.leaseExpiresAt,
                    lastSweptAt: row.lastSweptAt,
                    nextAllowedAt,
                };
            }
        }

        const leaseExpiresAt = now + leaseTtlMs;
        db.prepare(
            `INSERT INTO git_sweep_coordinator (
                 project_path,
                 lease_holder,
                 lease_expires_at,
                 last_swept_at
             ) VALUES (?, ?, ?, NULL)
             ON CONFLICT(project_path) DO UPDATE SET
                 lease_holder = excluded.lease_holder,
                 lease_expires_at = excluded.lease_expires_at`,
        ).run(projectPath, holderId, leaseExpiresAt);

        return {
            acquired: true,
            projectPath,
            holderId,
            acquiredAt: now,
            leaseExpiresAt,
        };
    });
}

export function renewGitSweepLease(
    db: Database,
    projectPath: string,
    holderId: string,
    leaseTtlMs = GIT_SWEEP_LEASE_TTL_MS,
): boolean {
    return runImmediate(db, () => {
        const now = Date.now();
        const leaseExpiresAt = now + leaseTtlMs;
        const result = db
            .prepare(
                `UPDATE git_sweep_coordinator
                 SET lease_expires_at = ?
                 WHERE project_path = ?
                   AND lease_holder = ?
                   AND lease_expires_at > ?`,
            )
            .run(leaseExpiresAt, projectPath, holderId, now);
        return result.changes === 1;
    });
}

export function markGitSweepSuccessAndRelease(
    db: Database,
    projectPath: string,
    holderId: string,
): boolean {
    return runImmediate(db, () => {
        const now = Date.now();
        const result = db
            .prepare(
                `UPDATE git_sweep_coordinator
                 SET lease_holder = NULL,
                     lease_expires_at = NULL,
                     last_swept_at = ?
                 WHERE project_path = ?
                   AND lease_holder = ?
                   AND lease_expires_at > ?`,
            )
            .run(now, projectPath, holderId, now);
        return result.changes === 1;
    });
}

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
export function parkGitSweepNonIndexable(
    db: Database,
    projectPath: string,
    holderId: string,
    reprobeMs: number = GIT_SWEEP_NON_INDEXABLE_REPROBE_MS,
): boolean {
    return runImmediate(db, () => {
        const now = Date.now();
        const sweptAt = now + reprobeMs - GIT_SWEEP_COOLDOWN_MS;
        const result = db
            .prepare(
                `UPDATE git_sweep_coordinator
                 SET lease_holder = NULL,
                     lease_expires_at = NULL,
                     last_swept_at = ?
                 WHERE project_path = ?
                   AND lease_holder = ?
                   AND lease_expires_at > ?`,
            )
            .run(sweptAt, projectPath, holderId, now);
        return result.changes === 1;
    });
}

export function releaseGitSweepLease(db: Database, projectPath: string, holderId: string): void {
    runImmediate(db, () => {
        db.prepare(
            `UPDATE git_sweep_coordinator
             SET lease_holder = NULL,
                 lease_expires_at = NULL
             WHERE project_path = ?
               AND lease_holder = ?`,
        ).run(projectPath, holderId);
    });
}
