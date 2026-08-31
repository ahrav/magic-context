import type { Database } from "../../../shared/sqlite";
import { trimClaimSnapshotsToBudget } from "../memory/claim-memory-render";
import { getMemoryCategoryOrder } from "../memory/constants";
import type { ProjectMemoryClaimSnapshot } from "../memory/storage-claim-current-state";
import { DEFAULT_MURAL_MEMORY_BUDGET } from "./mural-selection";
import { claimCueCurrent, getClaimMuralCueStates } from "./storage-mural-cues";

/**
 * */
export interface MuralWireOptions {
    enabled: boolean;
    supportsVision: boolean;
    dataUrl?: string;
    contentHash?: string;
}

/**
 * */
export interface ResolvedMuralEntry {
    publicClaimId: string;
    revisionLocator: string;
    category: string;
    importance: number;
    cue: string;
}

export interface MuralCoverage {
    /** activeMemoryCount counts claims eligible for mural cueing. */
    activeMemoryCount: number;
    /** cuedMemoryCount counts eligible claims with cues for their current revision.
     * */
    cuedMemoryCount: number;
}

/**
 *
 */
export type MuralMemoryPool = readonly ProjectMemoryClaimSnapshot[];

/** getMuralCoverage counts current cues across the full pool, not only mural overflow.
 * */
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
 *
 * resolveMural keeps only overflow claims.
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
            cue: state?.cue ?? "",
        });
    }

    entries.sort(compareMuralEntries);
    return entries;
}

/* */
function compareMuralEntries(a: ResolvedMuralEntry, b: ResolvedMuralEntry): number {
    const categoryDelta = getMemoryCategoryOrder(a.category) - getMemoryCategoryOrder(b.category);
    if (categoryDelta !== 0) return categoryDelta;
    if (a.importance !== b.importance) return b.importance - a.importance;
    return a.publicClaimId < b.publicClaimId ? -1 : 1;
}
