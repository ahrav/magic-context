/**
 * Deterministic rule-based text compression in the style of caveman-speak.
 *
 * Inspired by the caveman Claude Code skill (JuliusBrussee/caveman, 40k stars)
 * which validated telegraph-style compression as the right LLM-friendly
 * compression style — backed by research showing brevity constraints can
 * actually improve LLM accuracy (arxiv 2604.00025, March 2026).
 *
 * This module is pure and stateless. It takes text, applies progressively
 * aggressive rule-based transformations by level, and returns the compressed
 * output. It is used by the compressor to post-process historian output at
 * depths 2-4, enforcing style consistency without relying on LLM compliance.
 *
 * Preservation guarantees (all levels):
 *  - Code blocks (` and ``` fenced)
 *  - URLs (http://, https://)
 *  - File paths (contain / or start with ./ or ../)
 *  - Commit hashes (7-40 hex chars at word boundaries)
 *  - Compartment markers (§N§, U: lines, msg_*, ses_*, toolu_*)
 *  - Lines starting with "U: " (user quotes — irreplaceable phrasing)
 *
 * Compression by level:
 *  - lite   (depth 2): drops filler words and hedging
 *  - full   (depth 3): lite + drops articles and most auxiliaries, allows fragments
 *  - ultra  (depth 4): full + symbol connectives and common-term abbreviation
 */
export type CavemanLevel = "lite" | "full" | "ultra";
/** Compress `text` using caveman-style rules at the given `level`.
 *
 *  Preserved regions (code, URLs, paths, hashes, tag markers, U: lines) are
 *  never modified. Only surrounding prose is transformed.
 *
 *  The function is pure: same input always produces the same output. */
export declare function cavemanCompress(text: string, level: CavemanLevel): string;
//# sourceMappingURL=caveman.d.ts.map