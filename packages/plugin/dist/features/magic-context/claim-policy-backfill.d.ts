/**
 * Bounded, fail-closed v86 claim-policy seeding (claim-trust-policy plan:
 * U1; KTD11; R25-R28).
 *
 * Migration v86 records the deterministic boundary and pending phase; this
 * reconciler then seeds one conservative policy subject, maturity stream, and
 * effective-policy projection row per pre-existing revision in bounded
 * immediate-transaction batches. Missing rows read as CANDIDATE / unknown /
 * automatic-hidden until seeded (R26), so interruption is safe at any batch
 * cursor. Completion publishes only after expected-count and anti-join checks
 * pass in one immediate transaction. No legacy row is grandfathered into
 * automatic visibility.
 */
import type { Database } from "../../shared/sqlite.ts";
export interface ClaimPolicySeedStatus {
    applicable: boolean;
    phase: "pending" | "complete" | null;
    boundaryRevisionId: number;
    expectedCount: number;
    cursor: number;
    seededCounts: Record<string, number> | null;
}
export declare function getClaimPolicySeedStatus(db: Database): ClaimPolicySeedStatus;
export interface ClaimPolicySeedRunSummary {
    status: "complete" | "pending" | "noop";
    batches: number;
    seeded: number;
    seededCounts: Record<string, number>;
    autoHidden: number;
}
export interface RunClaimPolicySeedOptions {
    batchSize?: number;
    /** Bound the batches one call may run; remaining work stays pending. */
    maxBatches?: number;
    nowMs?: number;
    /** Bounded backoff before a contended batch reports `pending`. */
    retryDelaysMs?: readonly number[];
    sleep?: (delayMs: number) => Promise<void>;
    yieldToEventLoop?: () => Promise<void>;
}
/**
 * Run bounded seed batches until done (or `maxBatches`). Deterministic and
 * resumable: each batch commits its subjects, streams, assertions, projection
 * rows, and cursor in one immediate transaction; a crash resumes to identical
 * results (AE9). Completion re-checks the whole table with an anti-join so a
 * revision added by a held-open v85 writer during reconciliation is seeded
 * before the completion watermark publishes.
 *
 * Async and cooperative on purpose (the v84 runner's shape): batches yield to
 * the event loop so a large corpus cannot stall the host, and a contended
 * batch backs off and reports `pending` instead of aborting the whole run.
 */
export declare function runClaimPolicySeed(db: Database, options?: RunClaimPolicySeedOptions): Promise<ClaimPolicySeedRunSummary>;
/** Test seam: clears the per-project throttle. */
export declare function __resetArtifactRevalidationThrottleForTests(): void;
/**
 * Re-verify that every currently valid enforcement artifact still exists on
 * disk with the recorded bytes. ENFORCED maturity is earned by a passing
 * evaluation of exact artifact bytes; editing or deleting the recorded
 * `canonical_path` after the fact would otherwise leave the rung standing
 * forever, because validity reads only the stored `pass` result and explicit
 * revocation events. A missing or digest-drifted artifact gets a revocation
 * event plus a policy refresh, so `supportedMaturity` falls back to the
 * revision's next supported rung. A missing PROJECT ROOT is treated as
 * "cannot judge" (checkout absent or moved) and revokes nothing.
 */
export declare function revalidateEnforcementArtifacts(db: Database, projectIdentity: string, projectRoot: string, nowMs?: number): void;
export declare function seedLateCompatibilityRevisions(db: Database): void;
export declare function reconcileCompatibilityVerifications(db: Database): number;
//# sourceMappingURL=claim-policy-backfill.d.ts.map