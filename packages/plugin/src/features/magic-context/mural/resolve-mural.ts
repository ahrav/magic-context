import type { Database } from "../../../shared/sqlite";
import { getMemoriesByProject } from "../memory";
import { getMemoryCategoryOrder } from "../memory/constants";
import type { Memory } from "../memory/types";
import { DEFAULT_MURAL_MEMORY_BUDGET, muralOverflowMemories } from "./mural-selection";
import { computeCueContentHash, getMuralCueState } from "./storage-mural-cues";

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
    id: number;
    category: string;
    importance: number;
    cue: string;
}

export interface MuralCoverage {
    /** Active and permanent memories eligible for mural cueing. */
    activeMemoryCount: number;
    /** Eligible memories with a non-null compressed cue generated for current content. */
    cuedMemoryCount: number;
}

/**
 * The memory pool a mural is built from.
 *
 * Callers that inject the mural into model context MUST pass a pool already
 * filtered by the automatic-surface policy gate (see `ensureMuralRendered`):
 * the mural is folded into m[0] as an image, so it is an automatic injection
 * channel and may not carry policy-hidden content. This module stays a
 * memories-only reader and never derives policy itself.
 */
export type MuralMemoryPool = readonly Memory[];

/** Count current cues across the full active and permanent memory pool before
 * limiting it to the overflow subset used to build the mural. */
export function getMuralCoverage(
    db: Database,
    projectIdentity: string,
    pool?: MuralMemoryPool,
): MuralCoverage {
    const memories = pool ?? getMemoriesByProject(db, projectIdentity, ["active", "permanent"]);
    const cueState = getMuralCueState(
        db,
        memories.map((memory) => memory.id),
    );
    let cuedMemoryCount = 0;
    for (const memory of memories) {
        const state = cueState.get(memory.id);
        if (
            state &&
            typeof state.cue === "string" &&
            state.cue.trim() !== "" &&
            state.hash !== null &&
            state.hash === computeCueContentHash(memory.content)
        ) {
            cuedMemoryCount += 1;
        }
    }
    return { activeMemoryCount: memories.length, cuedMemoryCount };
}

/**
 * Compute the deterministic mural entry list for a project — the zero-LLM half
 * of the cutover, callable any time.
 *
 * 1. SELECTION: the overflow set is the complement of the m0 budget trim (the
 *    memories that did NOT fit the injected memory budget). Same trim the m0
 *    path uses, so the mural shows exactly what the budget dropped.
 * 2. FILTER: keep only overflow memories with a hash-CURRENT compressed cue
 *    (mural_cue set AND mural_cue_hash == sha256(content)). Uncompressed or
 *    stale memories are simply absent until the compress-cues trickle catches
 *    up — render what exists, never block on coverage.
 * 3. ORDER: category (MEMORY_CATEGORY_ORDER) → importance DESC → id ASC. The
 *    id-ASC tiebreak makes the order APPEND-STABLE: inserting a new memory never
 *    reshuffles the relative order of the existing ones within their band.
 */
export function resolveMural(
    db: Database,
    projectIdentity: string,
    budgetTokens: number = DEFAULT_MURAL_MEMORY_BUDGET,
    pool?: MuralMemoryPool,
): ResolvedMuralEntry[] {
    const memories = pool ?? getMemoriesByProject(db, projectIdentity, ["active", "permanent"]);
    const overflow = muralOverflowMemories(memories, budgetTokens);
    if (overflow.length === 0) return [];

    const cueState = getMuralCueState(
        db,
        overflow.map((memory) => memory.id),
    );
    const entries: ResolvedMuralEntry[] = [];
    for (const memory of overflow) {
        const state = cueState.get(memory.id);
        if (!state || state.cue === null || state.hash === null) continue;
        // Hash-current only: a cue whose content hash no longer matches is stale
        // (the memory was edited after compression) and must not render.
        if (state.hash !== computeCueContentHash(memory.content)) continue;
        entries.push({
            id: memory.id,
            category: memory.category,
            importance: memory.importance ?? 50,
            cue: state.cue,
        });
    }

    entries.sort(compareMuralEntries);
    return entries;
}

/** category order → importance DESC → id ASC (append-stable). */
function compareMuralEntries(a: ResolvedMuralEntry, b: ResolvedMuralEntry): number {
    const categoryDelta = getMemoryCategoryOrder(a.category) - getMemoryCategoryOrder(b.category);
    if (categoryDelta !== 0) return categoryDelta;
    if (a.importance !== b.importance) return b.importance - a.importance;
    return a.id - b.id;
}
