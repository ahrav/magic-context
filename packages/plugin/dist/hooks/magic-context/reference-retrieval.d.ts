import { type ReferenceSeed } from "./reference-seeds.generated";
/**
 * Structural minimum a compartment must satisfy to render as a session
 * reference. Both `Compartment` (stored rows, incremental runner) and
 * `CandidateCompartment` (in-flight recomp staging) are assignable — they
 * differ only in null/undefined widening on the tier/importance fields.
 */
export interface ReferenceCompartment {
    startMessage: number;
    endMessage: number;
    title: string;
    content: string;
    p1?: string | null;
    p2?: string | null;
    p3?: string | null;
    p4?: string | null;
    importance?: number | null;
    episodeType?: string | null;
}
/** Permanent seed floor — never drops, even when the session is mature. */
export declare const SEED_FLOOR = 4;
/** Recency window of this-session compartments shown for continuity/calibration. */
export declare const SESSION_REF_WINDOW = 6;
/**
 * Select 4 diverse, importance-band-spanning seeds, deterministically rotated
 * by (sessionId, chunkStart) so different runs see different 4-seed combos
 * (≈15 distinct combinations before repeat across the 60-seed corpus) while a
 * given chunk always resolves to the same 4.
 *
 * Strategy: pick one seed from each of the first SEED_FLOOR bands (very-high,
 * high, mid, low-mid by default), rotating WITHIN each band by the hash so the
 * specific seed varies run to run. This guarantees band coverage on every run
 * (never 4 high-importance seeds) while still rotating the corpus.
 */
export declare function selectSeeds(sessionId: string, chunkStart: number, count?: number): ReferenceSeed[];
/** Render the cross-project calibration block. Empty string if no seeds. */
export declare function renderSeedExamplesBlock(seeds: ReferenceSeed[]): string;
/**
 * Render the continuity block from the last `SESSION_REF_WINDOW` persisted
 * compartments. `allCompartments` is the session's full ordered compartment
 * list (ascending by sequence/endMessage). Empty string when the session has
 * no prior compartments (young session — seeds carry calibration alone).
 */
export declare function renderSessionReferencesBlock(allCompartments: ReferenceCompartment[]): string;
export interface ReferenceBlocks {
    /** `<compartment_examples_from_other_projects>` — always present (4-seed floor). */
    seedExamples: string;
    /** `<session_references>` — empty for a young session with no prior compartments. */
    sessionReferences: string;
}
/**
 * Build both reference blocks for a historian run. Pure + deterministic for a
 * given (sessionId, chunkStart, compartments) — no embedding, no DB, no clock.
 */
export declare function buildReferenceBlocks(args: {
    sessionId: string;
    chunkStart: number;
    /** Full ordered list of this session's persisted compartments (asc). */
    sessionCompartments: ReferenceCompartment[];
}): ReferenceBlocks;
//# sourceMappingURL=reference-retrieval.d.ts.map