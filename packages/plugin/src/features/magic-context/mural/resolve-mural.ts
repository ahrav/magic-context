import type { Database } from "../../../shared/sqlite";
import { trimClaimSnapshotsToBudget } from "../memory/claim-memory-render";
import { getMemoryCategoryOrder } from "../memory/constants";
import type { ProjectMemoryClaimSnapshot } from "../memory/storage-claim-current-state";
import { DEFAULT_MURAL_MEMORY_BUDGET } from "./mural-selection";
import { claimCueCurrent, getClaimMuralCueStates } from "./storage-mural-cues";

/** Wire options for the m0 mural image injection: whether the feature is on,
 *  whether the fold's model accepts images, and (when both hold) the rendered
 *  data URL plus its content hash. Produced by resolveMuralWire (render-trigger). */
export interface MuralWireOptions {
    enabled: boolean;
    supportsVision: boolean;
    dataUrl?: string;
    contentHash?: string;
}

/** A single deterministic mural entry: a compressed cue plus the ordering
 *  facts. No rooms, no merges — flat category bands. */
export interface ResolvedMuralEntry {
    publicClaimId: string;
    revisionLocator: string;
    category: string;
    importance: number;
    cue: string;
}

export interface MuralCoverage {
    /** Live claims eligible for mural cueing. */
    activeMemoryCount: number;
    /** Eligible claims with a cue compressed for their current revision
     * locator under the current renderer epoch. */
    cuedMemoryCount: number;
}

/**
 * The claim pool a mural is built from.
 *
 * Callers MUST pass a pool already filtered by the automatic-surface policy
 * gate (see `ensureMuralRendered`): the mural is folded into m[0] as an
 * image, so it is an automatic injection channel and may not carry
 * policy-hidden content. The parameter is required — no unfiltered fallback
 * read exists — so a new caller cannot silently bypass the gate. This module
 * stays a cue reader and never derives policy itself.
 */
export type MuralMemoryPool = readonly ProjectMemoryClaimSnapshot[];

/** Count current cues across the full eligible claim pool before limiting it
 * to the overflow subset used to build the mural. */
export function getMuralCoverage(
    db: Database,
    _projectIdentity: string,
    pool: MuralMemoryPool,
): MuralCoverage {
    const cueState = getClaimMuralCueStates(
        db,
        pool.map((item) => item.publicClaimId),
    );
    let cuedMemoryCount = 0;
    for (const item of pool) {
        if (claimCueCurrent(cueState.get(item.publicClaimId), item.revisionLocator)) {
            cuedMemoryCount += 1;
        }
    }
    return { activeMemoryCount: pool.length, cuedMemoryCount };
}

/**
 * Compute the deterministic mural entry list for a project — the zero-LLM half
 * of the cutover, callable any time.
 *
 * 1. SELECTION: the overflow set is the complement of the m0 budget trim (the
 *    claims that did NOT fit the injected memory budget). Same trim the m0
 *    path uses, so the mural shows exactly what the budget dropped.
 * 2. FILTER: keep only overflow claims whose stored cue is keyed to their
 *    current revision locator AND the current renderer epoch. Uncompressed or
 *    stale claims are simply absent until the compress-cues trickle catches
 *    up — render what exists, never block on coverage.
 * 3. ORDER: category (MEMORY_CATEGORY_ORDER) → importance DESC → public claim
 *    ID ASC (deterministic tiebreak).
 */
export function resolveMural(
    db: Database,
    _projectIdentity: string,
    budgetTokens: number = DEFAULT_MURAL_MEMORY_BUDGET,
    pool: MuralMemoryPool,
): ResolvedMuralEntry[] {
    const selected = new Set(
        trimClaimSnapshotsToBudget(pool, budgetTokens).selected.map((item) => item.publicClaimId),
    );
    const overflow = pool.filter((item) => !selected.has(item.publicClaimId));
    if (overflow.length === 0) return [];

    const cueState = getClaimMuralCueStates(
        db,
        overflow.map((item) => item.publicClaimId),
    );
    const entries: ResolvedMuralEntry[] = [];
    for (const item of overflow) {
        const state = cueState.get(item.publicClaimId);
        if (!claimCueCurrent(state, item.revisionLocator)) continue;
        entries.push({
            publicClaimId: item.publicClaimId,
            revisionLocator: item.revisionLocator,
            category: item.category,
            importance: item.importance,
            // claimCueCurrent proved cue is a nonempty string.
            cue: state?.cue ?? "",
        });
    }

    entries.sort(compareMuralEntries);
    return entries;
}

/** category order → importance DESC → public claim ID ASC. */
function compareMuralEntries(a: ResolvedMuralEntry, b: ResolvedMuralEntry): number {
    const categoryDelta = getMemoryCategoryOrder(a.category) - getMemoryCategoryOrder(b.category);
    if (categoryDelta !== 0) return categoryDelta;
    if (a.importance !== b.importance) return b.importance - a.importance;
    return a.publicClaimId < b.publicClaimId ? -1 : 1;
}
