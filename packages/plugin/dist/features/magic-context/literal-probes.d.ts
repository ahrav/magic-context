/**
 * Extract high-signal literal tokens ("probes") from a search query.
 *
 * Why this exists: `sanitizeFtsQuery` AND-joins every token, so a long natural-
 * language query like "why did ctx-status tool calls inflate" only matches a
 * message that contains ALL those words. A message that contains the literal
 * symbol `/ctx-status` but not the other six words is never retrieved — pure
 * recall loss, unfixable by ranking. Running each literal probe as its OWN FTS
 * query (in addition to the full query) recovers those candidates.
 *
 * Tuned for a PROSE / CONVERSATION corpus (memories + raw chat + commit
 * messages), NOT code: we look for the symbol/command/path/identifier shapes
 * that appear verbatim in conversation and that a paraphrased NL query would
 * otherwise drown. Plain prose yields zero probes, so NL queries are unaffected.
 */
/**
 * Pull literal probes from a query, most-specific shapes first, deduplicated
 * (case-insensitive) and capped. Returns [] for plain natural-language text.
 * Extraction stops when the MAX_PROBES prioritized slots are full — later
 * shapes are never scanned once the cap is reached.
 */
export declare function extractLiteralProbes(query: string): string[];
/** True when a probe appears verbatim (case-insensitive) in the text. Used to
 *  boost candidates that contain the exact literal the user searched for. */
export declare function containsProbeVerbatim(text: string, probes: string[]): boolean;
//# sourceMappingURL=literal-probes.d.ts.map