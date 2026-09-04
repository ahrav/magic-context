import type { Database } from "../../../shared/sqlite";
import { type Primer } from "../storage-primers";
/** Token cap for the rendered orientation seed — a huge origin compartment must
 *  not blow the prompt; the investigator digs via tools, it does not need the
 *  whole chunk inline. */
export declare const PRIMER_SEED_CAP_TOKENS = 4000;
export interface PrimerSeed {
    /** "raw" = U:/TC: orientation from the origin compartment; "closed-book" =
     *  origin compartment P1 (raw unavailable). */
    kind: "raw" | "closed-book";
    /** The orientation block (already token-capped). */
    orientation: string;
    /** P1 of the immediately-preceding and -following compartments, for context. */
    prePost: string;
    /** Session + ordinal range the orientation came from (for logging). */
    sessionId: string | null;
}
/**
 * Build the orientation seed for a primer from its most-recent occurrence's
 * origin compartment. MUST be called inside a `withRawSessionMessageCache` scope
 * (and, on Pi, with a RawMessageProvider registered for the session) so the raw
 * read is cached across the run.
 */
export declare function buildPrimerSeed(db: Database, primer: Primer): PrimerSeed;
//# sourceMappingURL=primer-seed.d.ts.map