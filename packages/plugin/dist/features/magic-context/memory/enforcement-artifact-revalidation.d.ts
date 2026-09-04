/**
 * Ongoing enforcement-artifact revalidation (direct claim kernel).
 *
 * ENFORCED maturity is earned by a passing evaluation of exact artifact
 * bytes; editing or deleting the recorded `canonical_path` after the fact
 * would otherwise leave the rung standing forever, because validity reads
 * only the stored `pass` result and explicit revocation events. A missing or
 * digest-drifted artifact gets a revocation event plus a policy refresh, so
 * `supportedMaturity` falls back to the revision's next supported rung. A
 * missing PROJECT ROOT is treated as "cannot judge" (checkout absent or
 * moved) and revokes nothing.
 *
 * Revocations commit through the claim operation kernel, so each one leaves
 * a durable receipt, a lifecycle effect for the module mirror, and a policy
 * generation bump that invalidates every derived cache.
 */
import type { Database } from "../../../shared/sqlite";
/** Test seam: clears the per-project throttle. */
export declare function __resetArtifactRevalidationThrottleForTests(): void;
/**
 * Re-verify that every currently valid enforcement artifact still exists on
 * disk with the recorded bytes. Throttled per identity+root; the filesystem
 * walk runs off the caller's synchronous path.
 */
export declare function revalidateEnforcementArtifacts(db: Database, projectIdentity: string, projectRoot: string, nowMs?: number): void;
//# sourceMappingURL=enforcement-artifact-revalidation.d.ts.map