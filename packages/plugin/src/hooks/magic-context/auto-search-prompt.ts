/**
 *
 *
 *
 */

import type { SearchSource } from "../../features/magic-context/search";
import {
    DEFAULT_SEARCH_RESULT_LIMIT,
    MAX_QUERY_BYTES,
    prepareAutomaticQuery,
} from "../../features/magic-context/search-bounds";

/**
 * */
export const AUTO_SEARCH_SOURCES = [
    "memory",
    "message",
    "git_commit",
] as const satisfies readonly SearchSource[];

/**
 * */
export const AUTO_SEARCH_RESULT_LIMIT = DEFAULT_SEARCH_RESULT_LIMIT;

/**
 * */
const CONTENT_DROP_TAGS = [
    "system-reminder",
    "ctx-search-hint",
    "ctx-search-auto",
    "sidekick-augmentation",
    "instruction",
] as const;

/**
 * */
function findTagClose(text: string, start: number): number {
    let quote: "'" | '"' | null = null;
    for (let i = start; i < text.length; i += 1) {
        const char = text[i];
        if (char === "<") return -1;
        if (quote !== null) {
            if (char === quote) quote = null;
            continue;
        }
        if (char === "'" || char === '"') {
            quote = char;
            continue;
        }
        if (char === ">") return i;
    }
    return -1;
}

/** XML permits whitespace between a tag name and its attributes or closing delimiter.
 * */
function isTagWhitespace(char: string | undefined): boolean {
    return char === " " || char === "\t" || char === "\n" || char === "\r";
}

/**
 * */
function matchDropTag(
    text: string,
    index: number,
    name: string,
): { end: number; closing: boolean; selfClosing: boolean } | null {
    let cursor = index + 1;
    let closing = false;
    if (text[cursor] === "/") {
        closing = true;
        cursor += 1;
    }
    if (!text.startsWith(name, cursor)) return null;
    cursor += name.length;
    if (text[cursor] === ">") return { end: cursor + 1, closing, selfClosing: false };
    if (closing) {
        // `matchDropTag` accepts whitespace before `>` in closing tags so `</instruction >` closes `dropStack`.
        // The whitespace scan stops at the first non-whitespace character, preserving linear time.
        while (isTagWhitespace(text[cursor])) cursor += 1;
        if (text[cursor] !== ">") return null;
        return { end: cursor + 1, closing: true, selfClosing: false };
    }
    // `matchDropTag` permits attributes on opening tags but rejects name prefixes.
    // name prefix (`<instructions>`) is a different tag.
    if (!isTagWhitespace(text[cursor])) return null;
    const close = findTagClose(text, cursor);
    if (close === -1) return null;
    // `matchDropTag` treats `<instruction .../>` as self-closing so it does not open a content-drop span.
    return { end: close + 1, closing: false, selfClosing: text[close - 1] === "/" };
}

/* */
function matchGenericTag(text: string, index: number): number | null {
    const first = text[index + 1];
    const isTagStart =
        (first >= "a" && first <= "z") || (first >= "A" && first <= "Z") || first === "/";
    if (!isTagStart) return null;
    if (first === "/") {
        const second = text[index + 2];
        if (!((second >= "a" && second <= "z") || (second >= "A" && second <= "Z"))) return null;
    }
    const close = findTagClose(text, index + 1);
    if (close === -1) return null;
    return close + 1;
}

/**
 * `collectStrippedPromptPrefix` returns plugin-markup-free output no longer than `MAX_QUERY_BYTES`.
 * `collectStrippedPromptPrefix` never emits a code point that would exceed `MAX_QUERY_BYTES`.
 *
 * The function normalizes withheld whitespace to one space or at most one blank line before emission.
 * Withholding separators preserves the byte budget for user text.
 * Leading and trailing whitespace runs never emit.
 */
export function collectStrippedPromptPrefix(raw: string): string {
    let out = "";
    let outBytes = 0;
    // `dropStack` holds open content-drop tags; the stripper drops text while `dropStack` is nonempty.
    // `openDepth` rejects orphan closers in constant time.
    // `n` open tags followed by `n` mismatched closers make repeated `dropStack` scans quadratic.
    const dropStack: string[] = [];
    const openDepth = new Map<string, number>();
    // -1: no withheld run; 0: spaces/tabs only; 1-2: newline count in the run.
    let pendingNewlines = -1;
    let i = 0;
    while (i < raw.length) {
        const char = raw[i];
        if (char === "<") {
            if (raw.startsWith("<!--", i)) {
                const end = raw.indexOf("-->", i + 4);
                i = end === -1 ? raw.length : end + 3;
                continue;
            }
            let matchedDrop = false;
            for (const name of CONTENT_DROP_TAGS) {
                const tag = matchDropTag(raw, i, name);
                if (!tag) continue;
                if (tag.closing) {
                    // The stripper drops orphan closers so malformed input cannot leak closing tags into embedded text.
                    // Each scan for a matching closer is amortized by the entries it pops.
                    if ((openDepth.get(name) ?? 0) > 0) {
                        const openIndex = dropStack.lastIndexOf(name);
                        for (let k = openIndex; k < dropStack.length; k += 1) {
                            const popped = dropStack[k];
                            openDepth.set(popped, (openDepth.get(popped) ?? 1) - 1);
                        }
                        dropStack.length = openIndex;
                    }
                } else if (!tag.selfClosing) {
                    dropStack.push(name);
                    openDepth.set(name, (openDepth.get(name) ?? 0) + 1);
                }
                i = tag.end;
                matchedDrop = true;
                break;
            }
            if (matchedDrop) continue;
            const genericEnd = matchGenericTag(raw, i);
            if (genericEnd !== null) {
                i = genericEnd;
                continue;
            }
        }
        if (char === "§") {
            // `§N§` line markers are removed unconditionally.
            // Skipping markers excludes them from the byte budget.
            // Skipping a complete marker prevents `MAX_QUERY_BYTES` from splitting it.
            let cursor = i + 1;
            while (raw[cursor] >= "0" && raw[cursor] <= "9") cursor += 1;
            if (cursor > i + 1 && raw[cursor] === "§") {
                i = cursor + 1;
                continue;
            }
        }
        if (dropStack.length > 0) {
            i += 1;
            continue;
        }
        const codePoint = raw.codePointAt(i) ?? 0;
        const charText = String.fromCodePoint(codePoint);
        if (/\s/.test(charText)) {
            // `collectStrippedPromptPrefix` discards leading whitespace instead of buffering it.
            if (out.length > 0) {
                if (pendingNewlines === -1) pendingNewlines = 0;
                if (charText === "\n" && pendingNewlines < 2) pendingNewlines += 1;
            }
            i += charText.length;
            continue;
        }
        const separator =
            pendingNewlines === -1
                ? ""
                : pendingNewlines === 0
                  ? " "
                  : "\n".repeat(pendingNewlines);
        const charBytes = Buffer.byteLength(charText, "utf8");
        // Separators are ASCII, so string length equals UTF-8 byte length.
        if (outBytes + separator.length + charBytes > MAX_QUERY_BYTES) break;
        out += separator + charText;
        outBytes += separator.length + charBytes;
        pendingNewlines = -1;
        i += charText.length;
    }
    return out;
}

/**
 */
export function extractBoundedAutoSearchQuery(raw: string): string {
    const cleaned = collectStrippedPromptPrefix(raw)
        .replace(/§\d+§\s*/g, "")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    return prepareAutomaticQuery(cleaned);
}
