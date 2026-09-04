/**
 * compress-cues prompt + manifest parser (non-agentic single-shot transform).
 *
 * Replaces the single-shot mural AUTHOR flow. The old author did selection,
 * room grouping, ranking, AND cue compression in one LLM call — three of those
 * four jobs are deterministic and were being re-done (badly) by the model every
 * week. This task keeps ONLY the genuinely-generative job: compress one memory's
 * content into a terse pidgin cue. Selection (overflow complement) and packing
 * (rank-ordered budget trim) are deterministic and live in resolveMural /
 * renderMural.
 *
 * Pattern mirrors classify-memories: the host renders ONE prompt per chunk, a
 * zero-tool agent emits ONE XML manifest, and the host parses fail-closed and
 * applies COLUMN-ONLY writes (mural_cue). No per-memory tool calls.
 *
 * The cue grammar is adapted from the retired MURAL_AUTHORING_PROMPT: pidgin
 * anchors, symbol vocabulary, per-importance budget, prohibition polarity,
 * verbatim identifiers, XML-escaping. What is dropped: room names, merges,
 * selection, ranking, and the <mural>/<room> scaffolding — none of which the
 * model should decide anymore.
 */
export interface CompressCuesPromptMemory {
    id: string;
    category: string;
    importance: number;
    content: string;
}
/** Per-cue hard budget in codepoints. Importance >= 70 gets more room because
 *  load-bearing rules carry more that must survive compression; everything else
 *  is held tighter. Mirrors the retired author budgets. */
export declare const CUE_BUDGET_HIGH = 90;
export declare const CUE_BUDGET_LOW = 50;
export declare function cueBudgetFor(importance: number): number;
export declare const COMPRESS_CUES_SYSTEM_PROMPT = "You compress project memories into mnemonic mural cues. Each cue is a compact pidgin anchor that lets a reader recall the full memory at a glance \u2014 NOT a sentence, NOT a summary. You do not select, rank, group, merge, or reword the underlying facts; you compress each supplied memory into one cue, independently.\n\n### Cue grammar\n- A cue is mnemonic shorthand, not prose. Prefer one to three distinctive tokens plus a relation. Use the symbols \u2192 \u2190 \u2298 \u2235 \u227A \u227B \u2205 \u2200 when they are shorter than words.\n- Preserve exact identifiers, paths, commands, flags, versions, filenames, hashes, and code tokens VERBATIM. These are the anchor \u2014 never abbreviate or paraphrase them.\n- Per-cue hard budget (in characters): 90 when importance >= 70, else 50. Exceeding the budget makes the cue unusable, so compress harder rather than overrun.\n- Never put a source claim id (e.g. mcm_0123abcd...) in a cue.\n- XML-escape &, <, >, and quotes in cue text (&amp; &lt; &gt; &quot;).\n- A PROHIBITION must mark the excluded thing as \u2298thing followed IMMEDIATELY by a terse parenthesized mechanism, e.g. \u2298cache write (ABI break). Keep parentheses balanced. Positive facts must be phrased WITHOUT trigger words (must not / never / without / instead of / exclude).\n- Do not invent facts, add commentary, or restate the category. Compress only what the memory says.\n\n### Output contract\nOutput ONE XML manifest at the very end and NOTHING else \u2014 no narration, no per-memory commentary, no reasoning:\n<cues>\n<cue id=\"mcm_00000000000000000000000000000001\">terse anchor \u2192 relation</cue>\n<cue id=\"mcm_00000000000000000000000000000002\">\u2298cache write (ABI break)</cue>\n</cues>\n\nRules:\n- Emit exactly one <cue> per memory in the pool below, using its id.\n- The complete <cues> root must be closed. Do not wrap it in a Markdown fence.";
/** Build the compress-cues prompt for one chunk. The category and importance are
 *  copied into the pool line so the model applies the right budget and polarity,
 *  but it never re-decides them — those are source facts. */
export declare function buildCompressCuesPrompt(args: {
    projectPath: string;
    memories: CompressCuesPromptMemory[];
}): string;
export interface ParsedCue {
    id: string;
    cue: string;
}
/**
 * Parse the agent's complete `<cues>` manifest, fail-closed on a missing/
 * truncated root (a length-capped reply must never apply a partial prefix of
 * cues). Per-cue VALIDATION happens on the write path, not here — a single bad
 * cue must not reject the whole chunk, so the parser only extracts id+text and
 * the caller decides which cues to keep.
 */
export declare function parseCuesManifest(text: string): ParsedCue[];
//# sourceMappingURL=compress-cues-prompt.d.ts.map