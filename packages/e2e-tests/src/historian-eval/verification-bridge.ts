/**
 *
 *
 */

import {
    readProjectMemoryCurrentState,
    resolveProjectIdsForIdentities,
} from "../../../plugin/src/features/magic-context/memory/storage-claim-current-state";
import { recordProjectMemoryVerification } from "../../../plugin/src/features/magic-context/memory/storage-claim-operations";
import type { Database } from "../../../plugin/src/shared/sqlite";

export const LANE_VERIFIER = "historian-eval-lane";

/**
 *
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
