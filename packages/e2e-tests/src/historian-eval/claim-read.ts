/**
 *
 */

import { readAuthorizedClaimMemorySnapshot } from "../../../plugin/src/features/magic-context/memory/claim-memory-render";
import { resolveProjectIdsForIdentities } from "../../../plugin/src/features/magic-context/memory/storage-claim-current-state";
import type { Database } from "../../../plugin/src/shared/sqlite";

/* */
export interface InjectedClaimRecord {
    publicClaimId: string;
    revisionLocator: string;
    content: string;
    category: string;
    revision: number;
}

/* */
export function laneWorkspaceEpoch(scenarioId: string): string {
    return `historian-eval:${scenarioId}`;
}

/**
 * retry.
 */
export function readInjectedClaims(
    db: Database,
    projectIdentity: string,
    scenarioId: string,
    nowMs: number,
): InjectedClaimRecord[] | null {
    const snapshot = readAuthorizedClaimMemorySnapshot(db, {
        authorizedIdentities: [projectIdentity],
        ownIdentities: [projectIdentity],
        sharedCategories: [],
        workspaceEpoch: laneWorkspaceEpoch(scenarioId),
        nowMs,
    });
    if (snapshot === null) return null;
    return snapshot.items.map((item) => ({
        publicClaimId: item.publicClaimId,
        revisionLocator: item.revisionLocator,
        content: item.content,
        category: item.category,
        revision: item.revision,
    }));
}

/**
 *
 * project-routing fault.
 *
 *
 */
export function promotionEvidenceCount(db: Database, projectIdentity: string): number {
    const projectIds = resolveProjectIdsForIdentities(db, [projectIdentity]);
    if (projectIds.length === 0) return 0;
    const placeholders = projectIds.map(() => "?").join(", ");
    const claims =
        (
            db
                .prepare(`SELECT COUNT(*) AS n FROM claims WHERE project_id IN (${placeholders})`)
                .get(...projectIds) as { n: number } | null
        )?.n ?? 0;
    let evidence = 0;
    try {
        evidence =
            (
                db
                    .prepare(
                        `SELECT COUNT(*) AS n FROM claim_evidence
                           JOIN claim_revisions ON claim_revisions.id = claim_evidence.revision_id
                           JOIN claims ON claims.id = claim_revisions.claim_id
                          WHERE claims.project_id IN (${placeholders})`,
                    )
                    .get(...projectIds) as { n: number } | null
            )?.n ?? 0;
    } catch {
        evidence = 0;
    }
    return claims + evidence;
}
