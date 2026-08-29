/**
 * Lane-owned verification bridge.
 *
 * The claim visibility policy admits a claim to automatic surfaces
 * (`auto_inject`) only at effective maturity VERIFIED or above; historian
 * promotions carry `model_inference` provenance and land as CANDIDATE, so a
 * fresh temp environment's injection read is empty by policy, not by
 * formation quality. The lane measures FORMATION — did the historian extract
 * the right durable facts and refuse speculation — so it normalizes the
 * orthogonal maturity gate by recording a `verified` outcome for every
 * active claim through the production verification operation
 * (`recordProjectMemoryVerification`, the same claim-op the dreamer's verify
 * path drives). Content is untouched; a promoted speculation becomes
 * visible and is then correctly caught by the false-authoritative check
 * instead of being masked by the maturity gate.
 *
 * The step is recorded in the run record (`verifiedClaimCount`) so every
 * score is explicit about the bridge having run.
 */

import {
    readProjectMemoryCurrentState,
    resolveProjectIdsForIdentities,
} from "../../../plugin/src/features/magic-context/memory/storage-claim-current-state";
import { recordProjectMemoryVerification } from "../../../plugin/src/features/magic-context/memory/storage-claim-operations";
import type { Database } from "../../../plugin/src/shared/sqlite";

export const LANE_VERIFIER = "historian-eval-lane";

/**
 * Record a `verified` outcome for every active claim under the identity.
 * Returns the number of claims verified.
 *
 * Throws when the maintenance read reports stale, and when any verification
 * resolves to something other than `applied`. A fresh single-writer lane
 * environment cannot legitimately race, so `stale` or `noop` means the bridge
 * itself did not do its job: the claim stays at CANDIDATE maturity, the
 * visibility policy keeps it off the `auto_inject` surface the scorer reads,
 * and the missing claim lands as FAIL:recall against the historian. Failing
 * loudly instead routes it through the runner as a `harness-failure` ERROR,
 * which is the R6-correct attribution for a bridge fault.
 */
export function verifyAllActiveClaims(db: Database, projectIdentity: string, nowMs: number): number {
    const projectIds = resolveProjectIdsForIdentities(db, [projectIdentity]);
    if (projectIds.length === 0) return 0;
    const state = readProjectMemoryCurrentState(db, {
        projectIds,
        surface: "maintenance_verification",
        lifecycleStates: ["active"],
        nowMs,
    });
    if (state.status !== "ok") {
        throw new Error(`historian-eval verification bridge: maintenance read stale (${state.reasons.join(", ")})`);
    }
    let verified = 0;
    for (const item of state.items) {
        const result = recordProjectMemoryVerification(
            db,
            { producer: LANE_VERIFIER, operationKey: `historian-eval-verify:${item.revisionLocator}` },
            {
                token: item.mutationToken,
                revisionLocator: item.revisionLocator,
                outcome: "verified",
                verifier: LANE_VERIFIER,
                nowMs,
            },
        );
        if (result.outcome !== "applied") {
            throw new Error(
                `historian-eval verification bridge: claim ${item.revisionLocator} not verified (outcome ${result.outcome})`,
            );
        }
        verified += 1;
    }
    return verified;
}
