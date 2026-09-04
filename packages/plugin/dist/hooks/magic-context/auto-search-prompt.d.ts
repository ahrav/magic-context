/**
 * Shared bounded prompt extraction for automatic (auto-search) queries.
 *
 * OpenCode and Pi both feed the user's prompt through this module before any
 * lexical, embedding, or shadow work, so the two harnesses always derive the
 * same bounded query from the same message (R35, AE2).
 *
 * One shared markup policy: plugin-owned blocks (system reminders, prior
 * ctx-search hints, sidekick augmentations, instruction wrappers, HTML
 * comments) are dropped WITH their content — they are injected noise that
 * would distort embeddings; user-pasted markup keeps its inner text because
 * `<thing>important data</thing>` still means "important data" to the user.
 *
 * The stripper is a single-pass streaming state machine that stops emitting
 * once MAX_QUERY_BYTES of stripped text is retained, so leading plugin markup
 * cannot erase later user text and no unbounded intermediate string is built
 * from markup-heavy prompts.
 */
/** Sources the automatic (transform-time) search path queries. Primers and
 *  notes are cache-neutral in v1: they surface via explicit ctx_search and
 *  the dashboard only, never auto-search prompt hints. Compartment chunks
 *  ride the "message" lane. The runner and the benchmark contract both
 *  derive from this value so an automatic scenario cannot positively judge
 *  a document the production automatic path never searches. */
export declare const AUTO_SEARCH_SOURCES: readonly ["memory", "message", "git_commit"];
/** Result limit the automatic path always requests. The runner and the
 *  benchmark contract both derive from this value so an automatic scenario
 *  cannot declare a cutoff production never executes. */
export declare const AUTO_SEARCH_RESULT_LIMIT = 10;
/**
 * Strip plugin markup and retain at most MAX_QUERY_BYTES of the result. The
 * returned prefix is surrogate-safe: emission stops before a code point that
 * would cross the byte budget.
 *
 * Whitespace runs are withheld and normalized (one space, or the newline
 * structure of the run capped at a blank line) before they are emitted, so
 * separators between stripped plugin blocks cannot consume the byte budget
 * that exists for user text. Leading and trailing runs never emit at all.
 */
export declare function collectStrippedPromptPrefix(raw: string): string;
/**
 * Full automatic-query pipeline: bounded streaming strip, tag-prefix and
 * whitespace cleanup, then deterministic truncation to the token and atom
 * caps. Callers apply their minimum-prompt-length gate to the returned query
 * and pass it unchanged to search, embedding, and shadow measurement.
 */
export declare function extractBoundedAutoSearchQuery(raw: string): string;
//# sourceMappingURL=auto-search-prompt.d.ts.map