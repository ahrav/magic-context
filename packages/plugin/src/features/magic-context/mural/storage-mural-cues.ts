import type { Database } from "../../../shared/sqlite";

/**
 * Bump when the cue compression contract changes (prompt, packing, or
 * validation rules): stored cues from an older epoch read as absent and the
 * compress-cues task regenerates them.
 */
export const MURAL_CUE_RENDERER_EPOCH = 1;

export interface ClaimMuralCueState {
    cue: string | null;
    /** Exact revision locator the stored cue was compressed for. */
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

/** Stored cue state keyed by public claim ID. Absent keys have no row. */
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
            // Interpolation is a compile-time placeholder list, not caller input.
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
 * True when the claim needs (re)compression: no stored cue, a cue compressed
 * for a different revision locator, or a cue from another renderer epoch.
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

/** A stored cue renders only for the exact revision locator and renderer
 * epoch it was compressed for. */
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
 * Store a compressed cue. `revisionLocator` MUST be the locator the cue was
 * actually compressed from: a claim revised mid-run keeps a locator-stale
 * row, so the render path excludes it and the compress gate re-selects it.
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

/** Record one validation rejection for the exact revision locator. The
 * locator doubles as the latch key while the cue remains NULL; a revised
 * claim restarts at one rejection. */
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
