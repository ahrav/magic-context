import { createHash } from "node:crypto";

import { type Database, withPrivilegedWriter } from "../../../shared/sqlite";

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

/**
 * Per-memory mural cue storage (v65). The compress-cues dreamer task writes one
 *  compressed pidgin cue per memory content version onto the `memories` table
 *  (columns mural_cue / mural_cue_hash / mural_cue_at plus the rejection latch).
 *  resolveMural reads the hash-current ones and packs them deterministically at
 *  inject time.
 *
 * These are derived render-cache columns, not prompt-cache bytes. TypeScript authority writes them
 * through the narrow privileged writer; when MODULE owns memories, the dreamer sends the same
 * column-only mutation through the module facade and the changefeed mirrors it back here. Authority
 * triggers still guard every update to a managed memory row.
 */

/**
 * The staleness key: sha256 of the RAW memory content the cue was compressed
 * FROM. Any edit to the content changes this hash, so a stored cue whose hash no
 * longer matches the current content is detected as stale — re-selected by the
 * compress-cues gate and excluded by resolveMural until recompressed. This is
 * deliberately distinct from `normalizedHash` (md5 of normalized text used for
 * dedup): cue staleness must react to every content change, including
 * whitespace/case edits that normalization would erase.
 */
export function computeCueContentHash(content: string): string {
    return createHash("sha256").update(content).digest("hex");
}

const muralCueColumnCache = new WeakMap<Database, boolean>();
const muralCueRejectionColumnCache = new WeakMap<Database, boolean>();

/** Column-guard for pre-v65 databases so cue reads/writes degrade to a no-op
 *  rather than throwing "no such column" on an un-migrated DB. */
export function hasMuralCueColumns(db: Database): boolean {
    const cached = muralCueColumnCache.get(db);
    if (cached !== undefined) return cached;
    const columns = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name?: string }>;
    const present = columns.some((column) => column.name === "mural_cue");
    muralCueColumnCache.set(db, present);
    return present;
}

/** The rejection latch was added after the base cue columns. Keep this guard so
 *  a process inspecting a v65-v74 database can still read the cue cache. */
export function hasMuralCueRejectionCountColumn(db: Database): boolean {
    const cached = muralCueRejectionColumnCache.get(db);
    if (cached !== undefined) return cached;
    const columns = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name?: string }>;
    const present = columns.some((column) => column.name === "mural_cue_rejection_count");
    muralCueRejectionColumnCache.set(db, present);
    return present;
}

export interface MuralCueState {
    /** The stored compressed cue, or null when never compressed. */
    cue: string | null;
    /** sha256 of the content the stored cue was compressed from, or null. */
    hash: string | null;
    /** Number of validation failures for the content identified by `hash`. */
    rejectionCount?: number;
}

/**
 * Read the stored cue state for a set of memory ids. Ids absent from the map
 * have no row (or the column set is missing on a pre-v65 DB). Used by the
 * compress-cues gate and by resolveMural's hash-current filter.
 */
export function getMuralCueState(
    db: Database,
    memoryIds: readonly number[],
): Map<number, MuralCueState> {
    const out = new Map<number, MuralCueState>();
    if (!hasMuralCueColumns(db)) return out;
    const ids = Array.from(new Set(memoryIds.filter(Number.isInteger)));
    if (ids.length === 0) return out;
    const placeholders = ids.map(() => "?").join(", ");
    const rejectionCountColumn = hasMuralCueRejectionCountColumn(db)
        ? "COALESCE(mural_cue_rejection_count, 0) AS mural_cue_rejection_count"
        : "0 AS mural_cue_rejection_count";
    const rows = db
        .prepare<
            number[],
            {
                id: number;
                mural_cue: string | null;
                mural_cue_hash: string | null;
                mural_cue_rejection_count: number;
            }
        >(
            `SELECT id, mural_cue, mural_cue_hash, ${rejectionCountColumn} FROM memories WHERE id IN (${placeholders})`,
        )
        .all(...ids);
    for (const row of rows) {
        out.set(row.id, {
            cue: row.mural_cue ?? null,
            hash: row.mural_cue_hash ?? null,
            ...(row.mural_cue_rejection_count > 0
                ? { rejectionCount: row.mural_cue_rejection_count }
                : {}),
        });
    }
    return out;
}

/**
 * True when a memory needs (re)compression: it has no cue yet, or the stored cue
 * was computed from different content (hash mismatch). Callers pass the memory's
 * CURRENT content so the check reacts to edits.
 */
export function memoryNeedsCue(state: MuralCueState | undefined, currentContent: string): boolean {
    if (!state || state.cue === null || state.hash === null) return true;
    return state.hash !== computeCueContentHash(currentContent);
}

/**
 * Write a compressed cue as a column-only update. `contentHash` MUST be the
 * hash of the content that was actually compressed (not a re-hash of the row's
 * current content): if the memory was edited mid-run, storing the prompt-time
 * hash leaves mural_cue_hash != sha256(current content), so resolveMural
 * excludes the now-stale cue and the compress-cues gate re-selects the memory
 * next run. Cache-neutral: the mural is rendered on demand from these columns,
 * not injected as part of the m[0] baseline bytes.
 */
export function setMuralCue(
    db: Database,
    projectPath: string,
    id: number,
    cue: string,
    contentHash: string,
): void {
    if (!hasMuralCueColumns(db)) return;
    withPrivilegedWriter(db, () => {
        const owned = db
            .prepare("SELECT 1 FROM memories WHERE id = ? AND project_path = ?")
            .get(id, projectPath);
        if (!owned) {
            throw new Error(`Memory ${id} does not belong to project ${projectPath}`);
        }
        // Privilege is safe here because only derived cache columns are changed;
        // authoritative memory content and identity fields are never writable here.
        const rejectionReset = hasMuralCueRejectionCountColumn(db)
            ? ", mural_cue_rejection_count = 0"
            : "";
        db.prepare(
            `UPDATE memories SET mural_cue = ?, mural_cue_hash = ?, mural_cue_at = ?${rejectionReset} WHERE id = ? AND project_path = ?`,
        ).run(cue, contentHash, Date.now(), id, projectPath);
    });
}

/** Record one validation rejection for the selected content version. The cue hash
 * doubles as the latch key while the cue remains NULL; an edited memory therefore
 * starts at one rejection even if an old rejection row is still present. */
export function recordMuralCueRejection(
    db: Database,
    projectPath: string,
    id: number,
    contentHash: string,
): number {
    if (!hasMuralCueColumns(db) || !hasMuralCueRejectionCountColumn(db)) return 0;
    let count = 0;
    withPrivilegedWriter(db, () => {
        const owned = db
            .prepare("SELECT 1 FROM memories WHERE id = ? AND project_path = ?")
            .get(id, projectPath);
        if (!owned) {
            throw new Error(`Memory ${id} does not belong to project ${projectPath}`);
        }
        const row = db
            .prepare<
                number,
                { mural_cue_hash: string | null; mural_cue_rejection_count: number | null }
            >("SELECT mural_cue_hash, mural_cue_rejection_count FROM memories WHERE id = ?")
            .get(id);
        count = row?.mural_cue_hash === contentHash ? (row.mural_cue_rejection_count ?? 0) + 1 : 1;
        db.prepare(
            "UPDATE memories SET mural_cue = NULL, mural_cue_hash = ?, mural_cue_at = ?, mural_cue_rejection_count = ? WHERE id = ? AND project_path = ?",
        ).run(contentHash, Date.now(), count, id, projectPath);
    });
    return count;
}
