import type { Database } from "../../../shared/sqlite";

/**
 * A stored non-null cue needs regeneration when its `rendererEpoch` differs from `MURAL_CUE_RENDERER_EPOCH`.
 */
export const MURAL_CUE_RENDERER_EPOCH = 1;

export interface ClaimMuralCueState {
    cue: string | null;
    /** `revisionLocator` identifies the revision compressed into the stored cue. */
    revisionLocator: string;
    rendererEpoch: number;
    rejectionCount: number;
}

interface ClaimMuralCueRow {
    public_id: string;
    revision_locator: string;
    renderer_epoch: number;
    cue: string | null;
    rejection_count: number;
}

/* */
export function getClaimMuralCueStates(
    db: Database,
    publicClaimIds: readonly string[],
): Map<string, ClaimMuralCueState> {
    const out = new Map<string, ClaimMuralCueState>();
    const ids = [...new Set(publicClaimIds)];
    if (ids.length === 0) return out;
    const placeholders = ids.map(() => "?").join(", ");
    const rows = db
        .prepare(
            // `placeholders` contains only `?` tokens generated from `ids`.
            // pi-lens-ignore: sql-injection
            `SELECT cpi.public_id, cues.revision_locator, cues.renderer_epoch,
                    cues.cue, cues.rejection_count
               FROM claim_mural_cues cues
               JOIN claim_public_ids cpi ON cpi.claim_id = cues.claim_id
              WHERE cpi.public_id IN (${placeholders})`,
        )
        .all(...ids) as ClaimMuralCueRow[];
    for (const row of rows) {
        out.set(row.public_id, {
            cue: row.cue,
            revisionLocator: row.revision_locator,
            rendererEpoch: row.renderer_epoch,
            rejectionCount: row.rejection_count,
        });
    }
    return out;
}

/**
 */
export function claimNeedsCue(
    state: ClaimMuralCueState | undefined,
    currentRevisionLocator: string,
): boolean {
    if (!state || state.cue === null) return true;
    return (
        state.revisionLocator !== currentRevisionLocator ||
        state.rendererEpoch !== MURAL_CUE_RENDERER_EPOCH
    );
}

/**
 * */
export function claimCueCurrent(
    state: ClaimMuralCueState | undefined,
    currentRevisionLocator: string,
): boolean {
    return (
        state !== undefined &&
        state.cue !== null &&
        state.cue.trim() !== "" &&
        state.revisionLocator === currentRevisionLocator &&
        state.rendererEpoch === MURAL_CUE_RENDERER_EPOCH
    );
}

function claimIdForPublicId(db: Database, publicClaimId: string): number {
    const row = db
        .prepare("SELECT claim_id AS claimId FROM claim_public_ids WHERE public_id = ?")
        .get(publicClaimId) as { claimId: number } | undefined;
    if (!row) throw new Error(`unknown project-memory claim: ${publicClaimId}`);
    return row.claimId;
}

/**
 * `revisionLocator` MUST identify the revision compressed into `cue`; a mid-run revision leaves the row stale so rendering excludes it and compression reselects it.
 */
export function setClaimMuralCue(
    db: Database,
    args: { publicClaimId: string; revisionLocator: string; cue: string },
): void {
    const claimId = claimIdForPublicId(db, args.publicClaimId);
    db.prepare(
        `INSERT INTO claim_mural_cues
            (claim_id, revision_locator, renderer_epoch, cue, rejection_count, updated_at)
         VALUES (?, ?, ?, ?, 0, ?)
         ON CONFLICT(claim_id) DO UPDATE SET
            revision_locator = excluded.revision_locator,
            renderer_epoch = excluded.renderer_epoch,
            cue = excluded.cue,
            rejection_count = 0,
            updated_at = excluded.updated_at`,
    ).run(claimId, args.revisionLocator, MURAL_CUE_RENDERER_EPOCH, args.cue, Date.now());
}

/** `rejectionCount` is keyed by `revisionLocator` while `cue` is `NULL`; a revised claim's first rejection sets the count to 1.
 * */
export function recordClaimMuralCueRejection(
    db: Database,
    args: { publicClaimId: string; revisionLocator: string },
): number {
    const claimId = claimIdForPublicId(db, args.publicClaimId);
    const existing = db
        .prepare(
            `SELECT revision_locator AS revisionLocator, renderer_epoch AS rendererEpoch,
                    rejection_count AS rejectionCount
               FROM claim_mural_cues WHERE claim_id = ?`,
        )
        .get(claimId) as
        | { revisionLocator: string; rendererEpoch: number; rejectionCount: number }
        | null
        | undefined;
    const count =
        existing != null &&
        existing.revisionLocator === args.revisionLocator &&
        existing.rendererEpoch === MURAL_CUE_RENDERER_EPOCH
            ? existing.rejectionCount + 1
            : 1;
    db.prepare(
        `INSERT INTO claim_mural_cues
            (claim_id, revision_locator, renderer_epoch, cue, rejection_count, updated_at)
         VALUES (?, ?, ?, NULL, ?, ?)
         ON CONFLICT(claim_id) DO UPDATE SET
            revision_locator = excluded.revision_locator,
            renderer_epoch = excluded.renderer_epoch,
            cue = NULL,
            rejection_count = excluded.rejection_count,
            updated_at = excluded.updated_at`,
    ).run(claimId, args.revisionLocator, MURAL_CUE_RENDERER_EPOCH, count, Date.now());
    return count;
}
