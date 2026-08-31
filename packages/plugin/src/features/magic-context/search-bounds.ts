/**
 *
 * between harnesses.
 *
 */

import { estimateTokens } from "../../shared/token-estimator";

/** The query validator checks the 16 KiB UTF-8 limit before trimming or tokenization. */
export const MAX_QUERY_BYTES = 16 * 1024;
/**
 * */
export const MAX_QUERY_TOKENS = 512;
/** The FTS lexer counts duplicate whitespace-delimited operands toward the 64-atom limit.
 * */
export const MAX_QUERY_ATOMS = 64;
/** Missing or non-finite result-limit requests default to 10. */
export const DEFAULT_SEARCH_RESULT_LIMIT = 10;
/* */
export const MAX_SEARCH_RESULT_LIMIT = 50;
/** Each lexical/probe fetch and post-score lane emits at most 150 candidates. */
export const MAX_LANE_CANDIDATES = 150;
/** MAX_CANDIDATE_DEPTH must not exceed MAX_LANE_CANDIDATES because pruneToLaneCeiling truncates lanes at MAX_LANE_CANDIDATES.
 * */
export const MAX_CANDIDATE_DEPTH = 100;
/* */
export const MAX_RENDERED_RESULT_TOKENS = 4096;
/* */
export const MAX_AUTO_HINT_TOKENS = 200;
/** Renderers must apply the 1024-byte field limit before tokenization or compression. */
export const MAX_RENDER_FIELD_BYTES = 1024;

export function boundDynamicField(text: string): string {
    return truncateUtf8Bytes(text, MAX_RENDER_FIELD_BYTES);
}

/**
 */
export function renderAntiMemoryWarningLine(args: {
    trigger: string;
    rejectedStrategy: string;
    rejectionReason: string;
    saferAlternative: string | null | undefined;
    boundField: (text: string) => string;
    citation?: string;
}): string {
    // `boundField` can erase a non-empty alternative, so the renderer tests its output before adding the clause.
    const boundedAlternative = args.saferAlternative ? args.boundField(args.saferAlternative) : "";
    const alternative =
        boundedAlternative.length > 0 ? ` Safer alternative: ${boundedAlternative}.` : "";
    const citation = args.citation ? ` (see ${args.citation})` : "";
    return `⚠ Previously rejected: ${args.boundField(args.rejectedStrategy)}. Reason: ${args.boundField(args.rejectionReason)}.${alternative} Verify before proceeding: confirm the rejection no longer applies to ${args.boundField(args.trigger)}.${citation}`;
}

export type QueryBoundsViolation = "bytes" | "tokens" | "atoms";

export interface QueryBoundsDetail {
    violation: QueryBoundsViolation;
    limit: number;
    actual: number;
}

/**
 * */
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

/**
 * */
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

/**
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
 * The validator checks bytes before trimming so an over-cap whitespace-only query rejects without trim work.
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

/** The function returns the longest prefix of `text` whose UTF-8 encoding is at most `maxBytes` without splitting surrogate pairs.
 * */
export function truncateUtf8Bytes(text: string, maxBytes: number): string {
    if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
    return text.slice(0, utf8PrefixEnd(text, maxBytes));
}

function utf8PrefixEnd(text: string, maxBytes: number, start = 0): number {
    let bytes = 0;
    let end = start;
    for (const char of text.slice(start)) {
        const charBytes = Buffer.byteLength(char, "utf8");
        if (bytes + charBytes > maxBytes) break;
        bytes += charBytes;
        end += char.length;
    }
    return end;
}

/** Each UTF-8 byte-bounded slice preserves surrogate pairs. */
export function splitUtf8Bytes(text: string, maxBytes: number): string[] {
    if (!Number.isInteger(maxBytes) || maxBytes < 1) {
        throw new RangeError("maxBytes must be a positive integer");
    }
    if (Buffer.byteLength(text, "utf8") <= maxBytes) return [text];
    const slices: string[] = [];
    let start = 0;
    while (start < text.length) {
        const end = utf8PrefixEnd(text, maxBytes, start);
        if (end === start) {
            throw new RangeError("maxBytes cannot hold one Unicode code point");
        }
        slices.push(text.slice(start, end));
        start = end;
    }
    return slices;
}

/** The lexer returns exclusive end offsets for whitespace-delimited atoms in `text`. */
function atomEndOffsets(text: string): number[] {
    const ends: number[] = [];
    const matcher = /\S+/g;
    for (const match of text.matchAll(matcher)) {
        ends.push(match.index + match[0].length);
    }
    return ends;
}

/** The function returns the largest index in `[0, upper]` whose prefix satisfies monotone `fits`.
 * */
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

/** The truncator uses code-point start offsets to preserve surrogate pairs. */
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
 * The truncator returns a prefix without splitting surrogate pairs that satisfies the byte, atom, and token caps.
 * After byte truncation, atom and token limits use complete-atom boundaries when possible.
 * If no complete atom fits the token cap, the fallback cuts at code-point boundaries.
 * The fallback returns an empty string when no code-point prefix fits the token cap.
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

    const offsets = codePointOffsets(text.slice(0, boundedEnds[0]));
    const bestChar = binarySearchLargestFit(
        offsets.length - 1,
        (index) => estimateTokens(text.slice(0, offsets[index])) <= MAX_QUERY_TOKENS,
    );
    return bestChar >= 0 ? text.slice(0, offsets[bestChar]).trim() : "";
}

/**
 * Missing or non-finite values use the default; finite values are floored and clamped to [1, MAX_SEARCH_RESULT_LIMIT].
 */
export function normalizeSearchResultLimit(limit?: number): number {
    if (typeof limit !== "number" || !Number.isFinite(limit)) {
        return DEFAULT_SEARCH_RESULT_LIMIT;
    }
    return Math.min(MAX_SEARCH_RESULT_LIMIT, Math.max(1, Math.floor(limit)));
}

export const ID_SHAPED_QUERY_MAX_TOKENS = 5;
const ID_SHAPED_TOKEN = /^#?\d+$/;

export function parseIdShapedQuery(query: string): number[] | null {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
        return null;
    }
    const tokens = trimmed.split(/[\s,]+/).filter((token) => token.length > 0);
    if (tokens.length === 0 || tokens.length > ID_SHAPED_QUERY_MAX_TOKENS) {
        return null;
    }
    const ids: number[] = [];
    for (const token of tokens) {
        if (!ID_SHAPED_TOKEN.test(token)) {
            return null;
        }
        const parsed = Number.parseInt(token.replace(/^#/, ""), 10);
        if (!Number.isFinite(parsed) || parsed <= 0) {
            return null;
        }
        ids.push(parsed);
    }
    return ids;
}
