import type { PluginContext } from "../../../plugin/types";
import type { Database } from "../../../shared/sqlite";
import { type LeaseAcquisition } from "../dreamer/lease";
import type { ProjectMemoryClaimSnapshot } from "../memory/storage-claim-current-state";
/**
 * compress-cues: a NON-agentic single-shot transform (classify-memories shape).
 * For each project memory whose cue is missing or stale, the host renders one
 * prompt per chunk, a zero-tool agent emits ONE <cues> XML manifest, and the
 * host validates each cue and applies COLUMN-ONLY writes (mural_cue), either locally
 * under TS authority or through the module facade when MODULE owns memories. No per-memory
 * tool calls; no selection/ranking/packing (those are deterministic
 * in resolveMural / renderMural).
 *
 * Gate: mural_cue IS NULL OR mural_cue_hash != sha256(content). Resumable — cues
 * are written per memory, so a partial run sticks and the next run picks up the
 * remaining gate set.
 *
 * Economics: chunks are small (~40 memories), so after the initial backfill the
 * daily trickle is cheap. First run on a 470-memory pool is ~12 chunks; steady
 * state is a handful of new/edited memories per day.
 */
/** Memories per compress call. Small so peak context stays bounded and a
 *  partial run leaves little re-work; the daily cadence drains any backlog. */
export declare const COMPRESS_CUES_CHUNK_SIZE = 40;
/** Minimum wall-clock budget a single chunk is allowed before we consider it
 *  doomed. runCompressCues divides the remaining task deadline evenly across the
 *  chunks still to run; on a large backfill (e.g. a 470-memory pool = 12 chunks)
 *  that even split can hand a slow thinking model far less than it needs, so
 *  every chunk times out, contributes 0 cues, and the loop burns the whole
 *  deadline (and model quota) marching through chunks that can never finish.
 *  The floor keeps each attempted chunk's slice at least this large, and if the
 *  remaining budget drops below it we stop the run and bank progress instead of
 *  starting a chunk we already know cannot complete. */
export declare const CHUNK_TIMEOUT_FLOOR_MS = 240000;
/** Three validation failures for one content hash are enough to stop spending
 * a child session on a response that is not going to change. */
export declare const CUE_REJECTION_LATCH_THRESHOLD = 3;
export interface CompressCuesArgs {
    db: Database;
    client: PluginContext["client"];
    projectIdentity: string;
    parentSessionId: string | undefined;
    sessionDirectory: string;
    holderId: string;
    leaseKey: string;
    deadline: number;
    leaseAcquisition?: LeaseAcquisition;
    model?: string;
    fallbackModels?: readonly string[];
    onProgress?: (processed: number) => void;
}
export interface CompressCuesResult {
    /** Cues written this run (memories whose cue moved from missing/stale to set). */
    compressed: number;
    /** Cues the model returned that failed per-cue validation and were skipped. */
    skipped: number;
    chunks: number;
    remaining: number;
    complete: boolean;
}
/** A claim selected for (re)compression. The revision locator captured at
 *  SELECTION time is the race guard: if the claim is revised between
 *  selection and write, the stored locator won't match the new revision, so
 *  resolveMural excludes the cue and the gate re-selects the claim next run
 *  — it never adopts a cue for content it wasn't compressed from. */
interface CueCandidate {
    item: ProjectMemoryClaimSnapshot;
}
/** Compute the wall-clock slice for the next chunk: an even split of the
 *  remaining budget across the chunks still to run, but never below
 *  CHUNK_TIMEOUT_FLOOR_MS (a slice smaller than the model needs guarantees a
 *  timeout) and never more than the budget actually remaining. Exported for
 *  test; the run loop calls this once per chunk. */
export declare function computeChunkSliceMs(remainingMs: number, chunksRemaining: number): number;
export declare function runCompressCues(args: CompressCuesArgs): Promise<CompressCuesResult>;
/**
 * Validate each returned cue independently and write the valid ones into the
 * derived cue table. The first validation failures are skipped (the claim
 * keeps a NULL cue); after the rejection latch trips, a deterministic
 * fallback is written instead of retrying forever. The stored key is the
 * SELECTION-time revision locator, so a claim revised mid-run doesn't adopt
 * a cue compressed from its old content.
 */
export declare function applyCues(args: CompressCuesArgs, chunk: CueCandidate[], manifestText: string): {
    compressed: number;
    skipped: number;
};
export {};
//# sourceMappingURL=compress-cues.d.ts.map