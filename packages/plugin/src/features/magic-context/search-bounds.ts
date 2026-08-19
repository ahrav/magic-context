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

import { estimateTokens } from "../../shared/token-estimator";

/** R34: raw UTF-8 ceiling checked before any trimming or tokenization. */
export const MAX_QUERY_BYTES = 16 * 1024;
/** R34: estimated embedding-token ceiling. Far below the smallest provider
 *  input window (SYNAPSE_MAX_INPUT_TOKENS = 8192), so a nominally valid query
 *  cannot approach a provider boundary even with estimator drift. */
export const MAX_QUERY_TOKENS = 512;
/** R34/R36: whitespace-delimited FTS operand ceiling, including duplicates.
 *  This is the shared pre-planning contract the U16 typed lexer must reuse. */
export const MAX_QUERY_ATOMS = 64;
/** R37: default returned-result limit for a missing or non-finite request. */
export const DEFAULT_SEARCH_RESULT_LIMIT = 10;
/** R37: hard ceiling on the final returned result array. */
export const MAX_SEARCH_RESULT_LIMIT = 50;
/** R37: ceiling on each bounded lexical/probe fetch and post-score lane output. */
export const MAX_LANE_CANDIDATES = 150;
/** KTD7: ceiling on a caller-requested per-lane candidate depth. Must stay
 *  at or below MAX_LANE_CANDIDATES: pruneToLaneCeiling truncates lanes at
 *  that bound, so tightening it below this value would silently cut an
 *  already-validated candidateDepth. The benchmark's profile K axis pins
 *  its maximum endpoint to this constant. */
export const MAX_CANDIDATE_DEPTH = 100;
/** Ceiling on the estimated tokens of one explicit search response. */
export const MAX_RENDERED_RESULT_TOKENS = 4096;
/** Ceiling on the estimated tokens of one automatic search hint. */
export const MAX_AUTO_HINT_TOKENS = 200;
/** Per-field UTF-8 byte ceiling applied before tokenization or compression. */
export const MAX_RENDER_FIELD_BYTES = 1024;

export function boundDynamicField(text: string): string {
    return truncateUtf8Bytes(text, MAX_RENDER_FIELD_BYTES);
}

export type QueryBoundsViolation = "bytes" | "tokens" | "atoms";

export interface QueryBoundsDetail {
    violation: QueryBoundsViolation;
    limit: number;
    actual: number;
}

/** Thrown by `unifiedSearch` when a direct caller bypasses adapter preflight
 *  with an over-cap query. Thrown before any database or provider work. */
export class QueryBoundsError extends Error {
    readonly violation: QueryBoundsViolation;
    readonly limit: number;
    readonly actual: number;

    constructor(detail: QueryBoundsDetail) {
        super(describeQueryBoundsViolation(detail));
        this.name = "QueryBoundsError";
        this.violation = detail.violation;
        this.limit = detail.limit;
        this.actual = detail.actual;
    }
}

/** Shared human-readable overflow reason. Harness adapters wrap this in their
 *  native error envelope (OpenCode string / Pi isError) without rewording. */
export function describeQueryBoundsViolation(detail: QueryBoundsDetail): string {
    switch (detail.violation) {
        case "bytes":
            return `query is too large: ${detail.actual} bytes of UTF-8 exceeds the ${detail.limit}-byte maximum`;
        case "tokens":
            return `query is too large: ~${detail.actual} estimated tokens exceeds the ${detail.limit}-token maximum`;
        case "atoms":
            return `query is too complex: ${detail.actual} search terms exceeds the ${detail.limit}-term maximum`;
    }
}

/** Whitespace-delimited FTS operands, including duplicates — duplicates still
 *  create parser and planner work (KTD5). Matches `sanitizeFtsQuery` token
 *  emission exactly. */
export function countQueryAtoms(query: string): number {
    let count = 0;
    let inAtom = false;
    for (const char of query) {
        if (/\s/.test(char)) {
            inAtom = false;
        } else if (!inAtom) {
            inAtom = true;
            count += 1;
        }
    }
    return count;
}

export type ExplicitQueryPreparation =
    | { ok: true; query: string }
    | ({ ok: false } & QueryBoundsDetail);

/**
 * Explicit-mode preflight (KD7 reject). Byte check runs on the RAW string
 * before trimming so a huge whitespace-only query rejects on bytes instead of
 * degrading into the empty-query case after unbounded trim work; atom and
 * token checks run on the trimmed query the search lanes would consume.
 */
export function prepareExplicitQuery(raw: string): ExplicitQueryPreparation {
    const bytes = Buffer.byteLength(raw, "utf8");
    if (bytes > MAX_QUERY_BYTES) {
        return { ok: false, violation: "bytes", limit: MAX_QUERY_BYTES, actual: bytes };
    }
    const trimmed = raw.trim();
    const atoms = countQueryAtoms(trimmed);
    if (atoms > MAX_QUERY_ATOMS) {
        return { ok: false, violation: "atoms", limit: MAX_QUERY_ATOMS, actual: atoms };
    }
    const tokens = estimateTokens(trimmed);
    if (tokens > MAX_QUERY_TOKENS) {
        return { ok: false, violation: "tokens", limit: MAX_QUERY_TOKENS, actual: tokens };
    }
    return { ok: true, query: trimmed };
}

export class CandidateDepthError extends Error {
    readonly requested: number;

    constructor(requested: number) {
        super(
            `candidate depth must be an integer between 1 and ${MAX_CANDIDATE_DEPTH}, got ${requested}`,
        );
        this.name = "CandidateDepthError";
        this.requested = requested;
    }
}

/** Rejects invalid depths instead of clamping them, so callers cannot receive a value different from the requested depth. */
export function normalizeCandidateDepth(depth?: number): number | null {
    if (depth === undefined) {
        return null;
    }
    if (
        typeof depth !== "number" ||
        !Number.isInteger(depth) ||
        depth < 1 ||
        depth > MAX_CANDIDATE_DEPTH
    ) {
        throw new CandidateDepthError(depth);
    }
    return depth;
}

/** Longest prefix of `text` whose UTF-8 encoding is at most `maxBytes`,
 *  never splitting a surrogate pair. */
export function truncateUtf8Bytes(text: string, maxBytes: number): string {
    if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
    let bytes = 0;
    let end = 0;
    for (const char of text) {
        const charBytes = Buffer.byteLength(char, "utf8");
        if (bytes + charBytes > maxBytes) break;
        bytes += charBytes;
        end += char.length;
    }
    return text.slice(0, end);
}

/** End offsets (exclusive) of each whitespace-delimited atom in `text`. */
function atomEndOffsets(text: string): number[] {
    const ends: number[] = [];
    const matcher = /\S+/g;
    for (const match of text.matchAll(matcher)) {
        ends.push(match.index + match[0].length);
    }
    return ends;
}

/** Largest index in [0, upper] whose prefix satisfies `fits`, assuming `fits`
 *  is monotone (a longer prefix never has fewer tokens). Returns -1 when even
 *  index 0 does not fit. */
export function binarySearchLargestFit(upper: number, fits: (index: number) => boolean): number {
    let low = 0;
    let high = upper;
    let best = -1;
    while (low <= high) {
        const mid = (low + high) >> 1;
        if (fits(mid)) {
            best = mid;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }
    return best;
}

/** Code-point start offsets of `text`, for surrogate-safe prefix truncation. */
function codePointOffsets(text: string): number[] {
    const offsets: number[] = [];
    let index = 0;
    for (const char of text) {
        offsets.push(index);
        index += char.length;
    }
    return offsets;
}

/**
 * Automatic-mode preparation (KD7 truncate): deterministically keep a
 * Unicode-safe prefix satisfying the byte, atom, and token caps. Truncation
 * prefers complete-atom boundaries; a single over-cap atom (one unbroken
 * 16 KiB string) falls back to a surrogate-safe code-point prefix so the
 * token cap always holds. No marker text is added to the query.
 */
export function prepareAutomaticQuery(raw: string): string {
    let text = truncateUtf8Bytes(raw, MAX_QUERY_BYTES).trim();
    if (text.length === 0) return "";

    const ends = atomEndOffsets(text);
    if (ends.length > MAX_QUERY_ATOMS) {
        text = text.slice(0, ends[MAX_QUERY_ATOMS - 1]);
    }

    if (estimateTokens(text) <= MAX_QUERY_TOKENS) return text;

    const boundedEnds = atomEndOffsets(text);
    const bestAtom = binarySearchLargestFit(
        boundedEnds.length - 1,
        (index) => estimateTokens(text.slice(0, boundedEnds[index])) <= MAX_QUERY_TOKENS,
    );
    if (bestAtom >= 0) {
        return text.slice(0, boundedEnds[bestAtom]).trim();
    }

    // Even the first atom exceeds the token cap: cut inside it on code points.
    const offsets = codePointOffsets(text.slice(0, boundedEnds[0]));
    const bestChar = binarySearchLargestFit(
        offsets.length - 1,
        (index) => estimateTokens(text.slice(0, offsets[index])) <= MAX_QUERY_TOKENS,
    );
    return bestChar >= 0 ? text.slice(0, offsets[bestChar]).trim() : "";
}

/**
 * R37 result-limit normalization: missing or non-finite uses the default,
 * finite values are floored and clamped to [1, MAX_SEARCH_RESULT_LIMIT].
 */
export function normalizeSearchResultLimit(limit?: number): number {
    if (typeof limit !== "number" || !Number.isFinite(limit)) {
        return DEFAULT_SEARCH_RESULT_LIMIT;
    }
    return Math.min(MAX_SEARCH_RESULT_LIMIT, Math.max(1, Math.floor(limit)));
}
