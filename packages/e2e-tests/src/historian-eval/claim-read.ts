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
