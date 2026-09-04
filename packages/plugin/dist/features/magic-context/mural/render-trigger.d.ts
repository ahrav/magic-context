import type { Database } from "../../../shared/sqlite";
import type { MuralWireOptions } from "./resolve-mural";
/**
 * On-demand deterministic mural render. The weekly author task is gone: the
 * mural is now a pure function of the compressed cue pool, rendered when the m0
 * injection path needs it. Change detection is CHEAP — resolveMural plus a text
 * assembly hash, no PNG work — so an unchanged cue pool costs one resolve and a
 * hash compare. The PNG is only encoded and upserted when the resolved text
 * actually changed.
 *
 * The stored row still feeds `mural_manifest` for the dashboard (`get_mural`);
 * its `model` column becomes "deterministic" since no compressor model rendered
 * it (the compressor model is recorded per-cue, not per-render).
 */
export declare const DETERMINISTIC_MURAL_MODEL = "deterministic";
export declare const MIN_MURAL_CUED_MEMORIES = 15;
export declare const MIN_MURAL_COVERAGE = 0.5;
export interface EnsureMuralResult {
    /** True when a resolved cue pool exists (the mural block should be injected). */
    hasMural: boolean;
    /** data URL of the current mural PNG, when hasMural. */
    dataUrl?: string;
    /** sha256 of the mural PNG bytes — the m0 mural fold identity. */
    contentHash?: string;
    /** True when this call re-rendered + upserted (the text changed or was new). */
    rerendered: boolean;
    /** Set when the coverage gate intentionally omitted the mural. */
    skipReason?: string;
    width?: number;
    height?: number;
}
/** A mural is useful with enough cues or broad enough pool coverage. */
export declare function muralCoverageGate(cuedMemoryCount: number, activeMemoryCount: number): boolean;
/**
 * Ensure the stored mural reflects the current compressed cue pool, rendering
 * and upserting only when the deterministic mural TEXT changed since the stored
 * render. Returns the wire data for the injection path.
 *
 * @param budgetTokens the project memory injection budget, so the overflow set
 *   matches exactly what the m0 path dropped.
 */
export declare function ensureMuralRendered(db: Database, projectIdentity: string, budgetTokens?: number): EnsureMuralResult;
/**
 * Resolve the mural WIRE options for the m0 injection path: gate on the mural
 * feature flag AND the outgoing model's vision capability, then ensure the
 * deterministic mural is rendered and return its data URL + content hash. This
 * is the on-demand render trigger — called from the HARD-fold materialization so
 * the injected data-url only swaps on a natural fold (defer passes replay the
 * baked-in bytes), matching the existing inject-compartments cache rule.
 *
 * Returns `{ enabled: false }` (no image) when the feature is off, the model
 * can't take images, or the cue pool is empty.
 */
export declare function resolveMuralWire(db: Database, projectIdentity: string | undefined, modelKey: string | undefined, enabled: boolean, budgetTokens?: number): MuralWireOptions;
//# sourceMappingURL=render-trigger.d.ts.map