import type { Database } from "../../../shared/sqlite";
/**
 * Bump when the cue compression contract changes (prompt, packing, or
 * validation rules): stored cues from an older epoch read as absent and the
 * compress-cues task regenerates them.
 */
export declare const MURAL_CUE_RENDERER_EPOCH = 1;
export interface ClaimMuralCueState {
    cue: string | null;
    /** Exact revision locator the stored cue was compressed for. */
    revisionLocator: string;
    rendererEpoch: number;
    rejectionCount: number;
}
/** Stored cue state keyed by public claim ID. Absent keys have no row. */
export declare function getClaimMuralCueStates(db: Database, publicClaimIds: readonly string[]): Map<string, ClaimMuralCueState>;
/**
 * True when the claim needs (re)compression: no stored cue, a cue compressed
 * for a different revision locator, or a cue from another renderer epoch.
 */
export declare function claimNeedsCue(state: ClaimMuralCueState | undefined, currentRevisionLocator: string): boolean;
/** A stored cue renders only for the exact revision locator and renderer
 * epoch it was compressed for. */
export declare function claimCueCurrent(state: ClaimMuralCueState | undefined, currentRevisionLocator: string): boolean;
/**
 * Store a compressed cue. `revisionLocator` MUST be the locator the cue was
 * actually compressed from: a claim revised mid-run keeps a locator-stale
 * row, so the render path excludes it and the compress gate re-selects it.
 */
export declare function setClaimMuralCue(db: Database, args: {
    publicClaimId: string;
    revisionLocator: string;
    cue: string;
}): void;
/** Record one validation rejection for the exact revision locator. The
 * locator doubles as the latch key while the cue remains NULL; a revised
 * claim restarts at one rejection. */
export declare function recordClaimMuralCueRejection(db: Database, args: {
    publicClaimId: string;
    revisionLocator: string;
}): number;
/**
 * The staleness key: sha256 of the RAW memory content the cue was compressed
 * FROM. Any edit to the content changes this hash, so a stored cue whose hash no
 * longer matches the current content is detected as stale — re-selected by the
 * compress-cues gate and excluded by resolveMural until recompressed. This is
 * deliberately distinct from `normalizedHash` (md5 of normalized text used for
 * dedup): cue staleness must react to every content change, including
 * whitespace/case edits that normalization would erase.
 */
export declare function computeCueContentHash(content: string): string;
//# sourceMappingURL=storage-mural-cues.d.ts.map