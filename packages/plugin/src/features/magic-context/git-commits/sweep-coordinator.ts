import type { Database } from "../../../shared/sqlite";
import { runImmediate } from "../../../shared/sqlite";

export const GIT_SWEEP_COOLDOWN_MS = 10 * 60 * 1000;
// Commit indexing can require two embedding drains: the indexer drain and the timer follow-up drain.
// The sweep renews its lease every minute.
// Minute-by-minute renewal makes the TTL bound crash-recovery latency rather than sweep duration.
// wall-clock budget.
export const GIT_SWEEP_LEASE_TTL_MS = 5 * 60 * 1000;
/**
 * The 24-hour horizon delays re-probing structurally non-indexable directories.
 * The 24-hour delay limits repeated failure logs from non-indexable directories.
 * A directory that becomes a Git repository is re-probed within 24 hours.
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
     * ignoreCooldown skips the cooldown gate but still requires lease acquisition.
     * The backlog-drain path ignores cooldown because unembedded rows must drain on every tick.
     * Draining unembedded rows has no git-log cost and continues until the backlog clears.
     * The backlog drain ignores cooldown so the dream-timer sweep cannot starve it.
     * The lease prevents duplicate sweeps across processes.
     * releaseGitSweepLease does not advance the cooldown.
     * The backlog-drain path leaves dream-timer cooldown tracking unchanged.
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
 * Non-indexable projects release their leases and are not retried until reprobeMs.
 * Non-indexable projects can be re-probed after reprobeMs.
 * A plain directory can become a Git repository, and an empty repository can receive its first commit before reprobeMs.
 * Suppressing sweep ticks before reprobeMs avoids identical failures.
 * The function future-dates last_swept_at so the cooldown gate suppresses sweeps until reprobeMs.
 * The function future-dates `last_swept_at` so the cooldown expires at the reprobe deadline.
 * Future-dating last_swept_at encodes the reprobe deadline without another field.
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
