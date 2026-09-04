/**
 * Hard bounds for every TypeScript search entry point (R11, R34-R37).
 *
 * One fixed, non-configurable policy for query bytes, estimated embedding
 * tokens, query atoms, result limits, and per-lane candidate ceilings.
 * OpenCode and Pi adapters, the automatic search runners, and direct
 * `unifiedSearch` callers all consume this module so the caps cannot drift
 * between harnesses.
 *
 * Overflow policy (KD7/KTD2): explicit agent queries REJECT so query
 * semantics are never silently altered; automatic (auto-search) prompts
 * TRUNCATE deterministically so long prompts still get recall.
 */
/** R34: raw UTF-8 ceiling checked before any trimming or tokenization. */
export declare const MAX_QUERY_BYTES: number;
/** R34: estimated embedding-token ceiling. Far below the smallest provider
 *  input window (SYNAPSE_MAX_INPUT_TOKENS = 8192), so a nominally valid query
 *  cannot approach a provider boundary even with estimator drift. */
export declare const MAX_QUERY_TOKENS = 512;
/** R34/R36: whitespace-delimited FTS operand ceiling, including duplicates.
 *  This is the shared pre-planning contract the U16 typed lexer must reuse. */
export declare const MAX_QUERY_ATOMS = 64;
/** R37: default returned-result limit for a missing or non-finite request. */
export declare const DEFAULT_SEARCH_RESULT_LIMIT = 10;
/** R37: hard ceiling on the final returned result array. */
export declare const MAX_SEARCH_RESULT_LIMIT = 50;
/** R37: ceiling on each bounded lexical/probe fetch and post-score lane output. */
export declare const MAX_LANE_CANDIDATES = 150;
/** KTD7: ceiling on a caller-requested per-lane candidate depth. Must stay
 *  at or below MAX_LANE_CANDIDATES: pruneToLaneCeiling truncates lanes at
 *  that bound, so tightening it below this value would silently cut an
 *  already-validated candidateDepth. The benchmark's profile K axis pins
 *  its maximum endpoint to this constant. */
export declare const MAX_CANDIDATE_DEPTH = 100;
/** Ceiling on the estimated tokens of one explicit search response. */
export declare const MAX_RENDERED_RESULT_TOKENS = 4096;
/** Ceiling on the estimated tokens of one automatic search hint. */
export declare const MAX_AUTO_HINT_TOKENS = 200;
/** Per-field UTF-8 byte ceiling applied before tokenization or compression. */
export declare const MAX_RENDER_FIELD_BYTES = 1024;
export declare function boundDynamicField(text: string): string;
/**
 * The one anti-memory warning sentence every surface renders. Callers supply
 * their own field-bounding function (explicit search uses the full
 * `boundDynamicField` cap; the compact auto-search hint applies a tighter
 * per-field character cap) and an optional locator citation. Keeping the
 * sentence here — the shared bounds module both renderers already import —
 * means the warning contract cannot drift between surfaces.
 */
export declare function renderAntiMemoryWarningLine(args: {
    trigger: string;
    rejectedStrategy: string;
    rejectionReason: string;
    saferAlternative: string | null | undefined;
    boundField: (text: string) => string;
    citation?: string;
}): string;
export type QueryBoundsViolation = "bytes" | "tokens" | "atoms";
export interface QueryBoundsDetail {
    violation: QueryBoundsViolation;
    limit: number;
    actual: number;
}
/** Thrown by `unifiedSearch` when a direct caller bypasses adapter preflight
 *  with an over-cap query. Thrown before any database or provider work. */
export declare class QueryBoundsError extends Error {
    readonly violation: QueryBoundsViolation;
    readonly limit: number;
    readonly actual: number;
    constructor(detail: QueryBoundsDetail);
}
/** Shared human-readable overflow reason. Harness adapters wrap this in their
 *  native error envelope (OpenCode string / Pi isError) without rewording. */
export declare function describeQueryBoundsViolation(detail: QueryBoundsDetail): string;
/** Whitespace-delimited FTS operands, including duplicates — duplicates still
 *  create parser and planner work (KTD5). Matches `sanitizeFtsQuery` token
 *  emission exactly. */
export declare function countQueryAtoms(query: string): number;
export type ExplicitQueryPreparation = {
    ok: true;
    query: string;
} | ({
    ok: false;
} & QueryBoundsDetail);
/**
 * Explicit-mode preflight (KD7 reject). Byte check runs on the RAW string
 * before trimming so a huge whitespace-only query rejects on bytes instead of
 * degrading into the empty-query case after unbounded trim work; atom and
 * token checks run on the trimmed query the search lanes would consume.
 */
export declare function prepareExplicitQuery(raw: string): ExplicitQueryPreparation;
export declare class CandidateDepthError extends Error {
    readonly requested: number;
    constructor(requested: number);
}
/** Rejects invalid depths instead of clamping them, so callers cannot receive a value different from the requested depth. */
export declare function normalizeCandidateDepth(depth?: number): number | null;
/** Longest prefix of `text` whose UTF-8 encoding is at most `maxBytes`,
 *  never splitting a surrogate pair. */
export declare function truncateUtf8Bytes(text: string, maxBytes: number): string;
/** Split `text` into UTF-8 byte-bounded slices without splitting surrogate pairs. */
export declare function splitUtf8Bytes(text: string, maxBytes: number): string[];
/** Largest index in [0, upper] whose prefix satisfies `fits`, assuming `fits`
 *  is monotone (a longer prefix never has fewer tokens). Returns -1 when even
 *  index 0 does not fit. */
export declare function binarySearchLargestFit(upper: number, fits: (index: number) => boolean): number;
/**
 * Automatic-mode preparation (KD7 truncate): deterministically keep a
 * Unicode-safe prefix satisfying the byte, atom, and token caps. Truncation
 * prefers complete-atom boundaries; a single over-cap atom (one unbroken
 * 16 KiB string) falls back to a surrogate-safe code-point prefix so the
 * token cap always holds. No marker text is added to the query.
 */
export declare function prepareAutomaticQuery(raw: string): string;
/**
 * R37 result-limit normalization: missing or non-finite uses the default,
 * finite values are floored and clamped to [1, MAX_SEARCH_RESULT_LIMIT].
 */
export declare function normalizeSearchResultLimit(limit?: number): number;
export declare const ID_SHAPED_QUERY_MAX_TOKENS = 5;
export declare function parseIdShapedQuery(query: string): number[] | null;
//# sourceMappingURL=search-bounds.d.ts.map