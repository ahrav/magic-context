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

import { MAX_QUERY_BYTES, prepareAutomaticQuery } from "../../features/magic-context/search-bounds";

/** Tags whose whole block (content included) is plugin-owned noise. The
 *  system-reminder entry legitimately nests, so all entries track depth. */
const CONTENT_DROP_TAGS = [
    "system-reminder",
    "ctx-search-hint",
    "ctx-search-auto",
    "sidekick-augmentation",
    "instruction",
] as const;

/** Index of the tag-closing `>` at or after `start`, scanning only until the
 *  next `<` — a nested `<` means the candidate span is plain text, not a tag
 *  body. Bounding the scan at the next `<` keeps the whole stripper linear:
 *  a prompt full of `<` characters with no later `>` cannot trigger an
 *  end-of-string scan per candidate. Returns -1 when the span is not a tag
 *  body. */
function findTagClose(text: string, start: number): number {
    for (let i = start; i < text.length; i += 1) {
        const char = text[i];
        if (char === ">") return i;
        if (char === "<") return -1;
    }
    return -1;
}

/** `<name ...>` / `</name>` at `index`, returning the tag end and whether it
 *  closes or self-closes, or null when `text` does not carry that tag here. */
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
    // Opening tags may carry attributes (`<instruction context="...">`), but a
    // name prefix (`<instructions>`) is a different tag.
    if (closing || (text[cursor] !== " " && text[cursor] !== "\t")) return null;
    const close = findTagClose(text, cursor);
    if (close === -1) return null;
    // `<instruction .../>` is a complete, empty block: it must not open a
    // content-drop span, or everything after it would be silently discarded.
    return { end: close + 1, closing: false, selfClosing: text[close - 1] === "/" };
}

/** Generic `<...>` markup span at `index`, or null when the `<` is plain text. */
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
 * Strip plugin markup and retain at most MAX_QUERY_BYTES of the result. The
 * returned prefix is surrogate-safe: emission stops before a code point that
 * would cross the byte budget.
 */
export function collectStrippedPromptPrefix(raw: string): string {
    let out = "";
    let outBytes = 0;
    // Stack of open content-drop tags; text is dropped while any is open.
    const dropStack: string[] = [];
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
                    // Orphan closers drop silently so a leaked closing tag from
                    // malformed input cannot bleed into the embedded text.
                    const openIndex = dropStack.lastIndexOf(name);
                    if (openIndex !== -1) dropStack.length = openIndex;
                } else if (!tag.selfClosing) {
                    dropStack.push(name);
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
        if (dropStack.length > 0) {
            i += 1;
            continue;
        }
        const codePoint = raw.codePointAt(i) ?? 0;
        const charText = String.fromCodePoint(codePoint);
        const charBytes = Buffer.byteLength(charText, "utf8");
        if (outBytes + charBytes > MAX_QUERY_BYTES) break;
        out += charText;
        outBytes += charBytes;
        i += charText.length;
    }
    return out;
}

/**
 * Full automatic-query pipeline: bounded streaming strip, tag-prefix and
 * whitespace cleanup, then deterministic truncation to the token and atom
 * caps. Callers apply their minimum-prompt-length gate to the returned query
 * and pass it unchanged to search, embedding, and shadow measurement.
 */
export function extractBoundedAutoSearchQuery(raw: string): string {
    const cleaned = collectStrippedPromptPrefix(raw)
        .replace(/§\d+§\s*/g, "")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    return prepareAutomaticQuery(cleaned);
}
