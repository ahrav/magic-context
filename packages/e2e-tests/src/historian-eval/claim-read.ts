/**
 * Single lane-owned read of the literal injection surface (KTD1).
 *
 * The runner's claim capture, the scorer's facts read, and test fixtures must
 * all observe the IDENTICAL surface — `readAuthorizedClaimMemorySnapshot`
 * (`auto_inject`, active lifecycle, stale retry) with the identical workspace
 * epoch — or probe verdicts (resolved against the runner's recorded set) and
 * facts precision/recall (computed from the scorer's read) silently diverge.
 * This helper owns the option construction so an edit applies to every read.
 */

import { readAuthorizedClaimMemorySnapshot } from "../../../plugin/src/features/magic-context/memory/claim-memory-render";
import { resolveProjectIdsForIdentities } from "../../../plugin/src/features/magic-context/memory/storage-claim-current-state";
import type { Database } from "../../../plugin/src/shared/sqlite";

/** One injection-visible claim as recorded in the run record. */
export interface InjectedClaimRecord {
    publicClaimId: string;
    revisionLocator: string;
    content: string;
    category: string;
    revision: number;
}

/** Workspace epoch the lane pins for every injection-surface read. */
export function laneWorkspaceEpoch(scenarioId: string): string {
    return `historian-eval:${scenarioId}`;
}

/**
 * Injection-visible claims under `projectIdentity` at the pinned clock, or
 * `null` when the snapshot still reports stale after the read's built-in
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
 * Promotion evidence under `projectIdentity`: claims plus the evidence rows
 * attached to their revisions.
 *
 * Scoped, not global, because the verification bridge and the authoritative claim
 * read are both scoped this way — claims promoted under a different identity would
 * satisfy a global count while leaving those reads empty, and the scorer would
 * then report the resulting recall miss as historian quality rather than as a
 * project-routing fault.
 *
 * Evidence rows are counted alongside claims because a promotion does not always
 * create one. `stageCreateProjectMemoryClaimInCurrentTransaction` matches on a
 * normalized content hash and, for a fact an earlier run already promoted,
 * attaches evidence to the existing claim instead — so counting claims alone reads
 * a successful re-promotion as a lost one, which is a false plumbing failure on
 * exactly the repeated-fact transcript a two-run scenario produces.
 *
 * Shared by the runner (which samples it around each run to derive that run's
 * delta) and the scorer (which reapplies the runner's plumbing guard to a stored
 * snapshot), so the two cannot disagree about what counts as promotion evidence.
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
        // Older fragment without the evidence tables: the claim count alone still
        // detects a first promotion, which is the common case.
        evidence = 0;
    }
    return claims + evidence;
}
