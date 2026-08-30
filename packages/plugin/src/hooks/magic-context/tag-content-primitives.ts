import type { ThinkingLikePart } from "./tag-messages";

const encoder = new TextEncoder();

// Well-formed tag prefix: one or more `§N§` tokens separated by whitespace.
const TAG_PREFIX_REGEX = /^(?:§\d+§\s*)+/;

// Malformed tag prefix repair (leading only — see MALFORMED_TAG_GLOBAL_REGEX).
//
// Some models occasionally produce a garbled tag reference at the start of an
// assistant text part — the patterns observed in production are:
//
//   §15298">§15298§ hello...  ← same number twice, with `">` interjected
//   §15298">§ hello...        ← partial, no closing digits
//   §15298">§ §15298§ hello   ← partial stub followed by a normal tag
//
// The root cause was token-level confusion between our `§N§` tag format and
// quoted ordinal/date attributes in the former rendered compartment tags.
// Current <session-history> bytes use `## N-M · date · title` headings, but a
// cached m0 stays byte-identical until its next natural fold, so this repair
// must continue accepting malformed prefixes learned from the former format.
//
// This regex recognizes the malformed shapes so stripTagPrefix removes them
// BEFORE the next prependTag runs. Without this, the regex above
// (`/^(?:§\d+§\s*)+/`) fails to match the malformed prefix, leaves it in
// place, and prepends a NEW `§N§ ` in front — creating double-tagged text
// that persists through re-tagging on every future transform pass and
// reinforces the pattern in-context.
const MALFORMED_TAG_PREFIX_REGEX = /^(?:§\d+">§(?:\d+§)?\s*)+/;

// Dangling-open tag: `§` + digits NOT closed by a second `§` — the model opened
// our tag format and improvised the closer (or dropped it). Observed closers are
// always punctuation/symbol/non-ASCII (`§103012$`, `§11865ҩ`, `§42">`-stubs),
// never a letter, so we consume at most ONE non-word closer. Anchoring on our
// own `§\d+` opener (not a homoglyph table — `§` has no meaningful confusable
// set, and the next model would pick a different stray char anyway) is the
// reliable signal: no legitimate content opens a token with `§` followed by
// digits. Without this, the stray-`§` pass strips only the `§` and ORPHANS the
// digits + closer (`§103012$` → `103012$`) on the wire.
//
// Runs AFTER the complete-pair and `">`-hybrid regexes (so well-formed `§N§` and
// `§N">§` are already gone) and BEFORE the stray-`§` pass.
//
// Two precision guards so we don't mangle real content:
//   - `(?!\.\d)` — a `§` + digits + DECIMAL (`§5.1` = a section citation) is NOT
//     a dangling tag; leave it for the stray-`§` pass (`§5.1` → `5.1`).
//   - closer excludes `\w` AND `.` — never eats a following letter
//     (`§42important` → `important`) or a sentence period; whitespace is excluded
//     so content after a space survives (`§42 files` → ` files`).
const DANGLING_TAG_GLOBAL_REGEX = /\u00a7\d+(?!\.\d)[^\s\u00a7\w.]?/g;
const DANGLING_TAG_PREFIX_REGEX = /^(?:\u00a7\d+(?!\.\d)[^\s\u00a7\w.]?\s*)+/;

/** Well-formed `§N§` pairs anywhere (persistence cargo-cult cleanup). */
const COMPLETE_TAG_PAIR_GLOBAL_REGEX = /\u00a7\d+\u00a7/g;

/** Malformed tag/XML hybrid shapes anywhere (persistence cargo-cult cleanup). */
const MALFORMED_TAG_GLOBAL_REGEX = /\u00a7\d+">(?:\u00a7(?:\d+\u00a7)?)?/g;

/** Lone section signs after pair/malformed removal (persistence only). */
const STRAY_SECTION_CHAR_REGEX = /\u00a7/g;

export function stripWellFormedLeadingTagPrefix(value: string): string {
    return value.replace(/^(\u00a7\d+\u00a7\s*)+/, "");
}

function stripCompleteTagPairsGlobally(value: string): string {
    return value.replace(COMPLETE_TAG_PAIR_GLOBAL_REGEX, "");
}

function stripMalformedTagNotationGlobally(value: string): string {
    return value.replace(MALFORMED_TAG_GLOBAL_REGEX, "");
}

/** Dangling `§N<closer?>` shapes anywhere (cargo-cult cleanup). */
export function stripDanglingTagNotationGlobally(value: string): string {
    return value.replace(DANGLING_TAG_GLOBAL_REGEX, "");
}

export function stripTagSectionCharacters(value: string): string {
    return value.replace(STRAY_SECTION_CHAR_REGEX, "");
}

/**
 * Strip MC tag notation from assistant text at the persistence boundary
 * (`experimental.text.complete`, Pi `message_end`). Removes whole `§N§` pairs
 * (never bare leading digits), then malformed hybrids and stray `§`.
 */
export function stripPersistedAssistantText(value: string): string {
    let text = stripWellFormedLeadingTagPrefix(value);
    text = stripCompleteTagPairsGlobally(text);
    text = stripMalformedTagNotationGlobally(text);
    // Catch dangling `§N$` / `§Nҩ` (improvised closer) BEFORE the stray-§ pass,
    // so the digits + closer are removed as a unit instead of orphaned.
    text = stripDanglingTagNotationGlobally(text);
    text = stripTagSectionCharacters(text);
    return text.trim();
}

export function byteSize(value: string): number {
    return encoder.encode(value).length;
}

/**
 * Strip only §-shaped MC tag notation from the start of transform-visible text.
 * Does not remove bare leading digits — those may be legitimate user content
 * (`99 files`, `2024 roadmap`, numbered lists).
 */
export function stripTagPrefix(value: string): string {
    let stripped = value;
    for (let pass = 0; pass < 8; pass++) {
        const prev = stripped;
        stripped = stripped.replace(MALFORMED_TAG_PREFIX_REGEX, "");
        stripped = stripped.replace(TAG_PREFIX_REGEX, "");
        // Dangling-open leading tag LAST: a well-formed `§N§` must be consumed by
        // TAG_PREFIX_REGEX first, or this would strip `§N` and orphan the closing
        // `§` (`§42§ hi` → `§ hi`). Recognizing it here stops re-tagging from
        // prepending a fresh `§M§` in front of a cargo-culted `§N$`, which would
        // compound and reinforce the pattern in-context every pass.
        stripped = stripped.replace(DANGLING_TAG_PREFIX_REGEX, "");
        if (stripped === prev) break;
    }
    return stripped;
}

/**
 * Split leading MC tag notation from the body (temporal marker injection).
 * Uses the same §-only rules as {@link stripTagPrefix}.
 */
export function peelLeadingMcTagNotation(value: string): { tagPrefix: string; body: string } {
    const body = stripTagPrefix(value);
    if (body === value) return { tagPrefix: "", body };
    return { tagPrefix: value.slice(0, value.length - body.length), body };
}

export function prependTag(tagId: number, value: string): string {
    const stripped = stripTagPrefix(value);
    return `§${tagId}§ ${stripped}`;
}

export function isThinkingPart(part: unknown): part is ThinkingLikePart {
    if (part === null || typeof part !== "object") return false;
    const candidate = part as Record<string, unknown>;
    return candidate.type === "thinking" || candidate.type === "reasoning";
}
