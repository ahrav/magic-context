import {
    applyEdits,
    createScanner,
    findNodeAtLocation,
    getNodeValue,
    type JSONPath,
    modify,
    type Node,
    type ParseError,
    parseTree,
} from "jsonc-parser";

interface TokenLocation {
    offset: number;
    length: number;
    line: number;
}

/**
 * Isolated modules cannot reference jsonc-parser's const-enum SyntaxKind.
 */
const TOKEN_COMMA = 5;
const TOKEN_LINE_COMMENT = 12;
const TOKEN_BLOCK_COMMENT = 13;
const TOKEN_EOF = 17;

function parseDocument(text: string): Node {
    const errors: ParseError[] = [];
    const root = parseTree(text, errors, { allowTrailingComma: true });
    if (!root || errors.length > 0) {
        throw new Error("Cannot edit invalid JSONC");
    }
    return root;
}

function findNode(text: string, path: JSONPath): Node | undefined {
    return findNodeAtLocation(parseDocument(text), path);
}

function findComma(text: string, start: number, end: number): TokenLocation | undefined {
    const scanner = createScanner(text, false);
    scanner.setPosition(start);

    for (;;) {
        const kind = scanner.scan();
        const offset = scanner.getTokenOffset();
        if (kind === TOKEN_EOF || offset >= end) return undefined;
        if (kind === TOKEN_COMMA) {
            return {
                offset,
                length: scanner.getTokenLength(),
                line: scanner.getTokenStartLine(),
            };
        }
    }
}

function lineStart(text: string, offset: number): number {
    const previousNewline = text.lastIndexOf("\n", offset - 1);
    return previousNewline === -1 ? 0 : previousNewline + 1;
}

function lineEnd(text: string, offset: number): number {
    const nextNewline = text.indexOf("\n", offset);
    if (nextNewline === -1) return text.length;
    return text[nextNewline - 1] === "\r" ? nextNewline - 1 : nextNewline;
}

function inlineCommentEnd(
    text: string,
    start: number,
    line: number,
    limit: number,
): number | undefined {
    const scanner = createScanner(text, false);
    scanner.setPosition(start);
    let end: number | undefined;

    for (;;) {
        const kind = scanner.scan();
        const offset = scanner.getTokenOffset();
        if (kind === TOKEN_EOF || offset >= limit || scanner.getTokenStartLine() !== line) {
            return end;
        }
        if (kind === TOKEN_LINE_COMMENT || kind === TOKEN_BLOCK_COMMENT) {
            end = offset + scanner.getTokenLength();
        }
    }
}

/**
 * Inline comments after a comma belong to the preceding entry.
 * Comments after a comma on a later line belong to the following entry.
 */
function startAfterPrecedingInlineComments(
    text: string,
    comma: TokenLocation,
    entryOffset: number,
): number {
    const commentEnd = inlineCommentEnd(text, comma.offset + comma.length, comma.line, entryOffset);
    if (commentEnd === undefined) return comma.offset + comma.length;

    const nextNewline = text.indexOf("\n", commentEnd);
    return nextNewline === -1 ? commentEnd : nextNewline + 1;
}

/** The removal range includes inline comments after the removed entry's comma. */
function endAfterFollowingInlineComments(
    text: string,
    comma: TokenLocation,
    nextEntryOffset: number,
): number {
    const commentEnd = inlineCommentEnd(
        text,
        comma.offset + comma.length,
        comma.line,
        nextEntryOffset,
    );
    return commentEnd === undefined ? comma.offset + comma.length : lineEnd(text, commentEnd);
}

function closingWhitespace(text: string, entryEnd: number, closingBracket: number): string {
    const trailing = text.slice(entryEnd, closingBracket);
    const finalNewline = trailing.lastIndexOf("\n");
    if (finalNewline === -1) return "";
    const newlineStart = trailing[finalNewline - 1] === "\r" ? finalNewline - 1 : finalNewline;
    return trailing.slice(newlineStart);
}

function removeArrayEntry(text: string, array: Node, index: number): string {
    const entries = array.children ?? [];
    const entry = entries[index];
    if (!entry) return text;

    const closingBracket = array.offset + array.length - 1;
    if (entries.length === 1) {
        const start = array.offset + 1;
        const replacement = closingWhitespace(text, entry.offset + entry.length, closingBracket);
        return text.slice(0, start) + replacement + text.slice(closingBracket);
    }

    if (index === entries.length - 1) {
        const previous = entries[index - 1];
        if (!previous) return text;
        const comma = findComma(text, previous.offset + previous.length, entry.offset);
        if (!comma) return text;
        const replacement = closingWhitespace(text, entry.offset + entry.length, closingBracket);
        return text.slice(0, comma.offset) + replacement + text.slice(closingBracket);
    }

    const next = entries[index + 1];
    if (!next) return text;
    const followingComma = findComma(text, entry.offset + entry.length, next.offset);
    if (!followingComma) return text;

    const start =
        index === 0
            ? array.offset + 1
            : (() => {
                  const previous = entries[index - 1];
                  if (!previous) return entry.offset;
                  const precedingComma = findComma(
                      text,
                      previous.offset + previous.length,
                      entry.offset,
                  );
                  return precedingComma
                      ? startAfterPrecedingInlineComments(text, precedingComma, entry.offset)
                      : entry.offset;
              })();
    const end = endAfterFollowingInlineComments(text, followingComma, next.offset);

    return text.slice(0, start) + text.slice(end);
}

function indentationAt(text: string, offset: number): string {
    const prefix = text.slice(lineStart(text, offset), offset);
    return /^[\t ]*$/.test(prefix) ? prefix : "";
}

function inferIndent(text: string, array: Node): string {
    const firstEntry = array.children?.[0];
    if (firstEntry) return indentationAt(text, firstEntry.offset);

    const closingBracket = array.offset + array.length - 1;
    const closingIndent = indentationAt(text, closingBracket);
    return `${closingIndent}${closingIndent.includes("\t") ? "\t" : "  "}`;
}

function appendArrayValue(text: string, array: Node, value: unknown): string {
    const entries = array.children ?? [];
    const closingBracket = array.offset + array.length - 1;
    const serialized = JSON.stringify(value);

    if (entries.length === 0) {
        if (!text.slice(array.offset, closingBracket).includes("\n")) {
            return text.slice(0, closingBracket) + serialized + text.slice(closingBracket);
        }

        const indent = inferIndent(text, array);
        const closingLineStart = lineStart(text, closingBracket);
        const eol = text.includes("\r\n") ? "\r\n" : "\n";
        return (
            text.slice(0, closingLineStart) +
            indent +
            serialized +
            eol +
            text.slice(closingLineStart)
        );
    }

    const lastEntry = entries.at(-1);
    if (!lastEntry) return text;
    const trailingComma = findComma(text, lastEntry.offset + lastEntry.length, closingBracket);
    const isMultiline = text.slice(array.offset, closingBracket).includes("\n");

    if (!isMultiline) {
        return (
            text.slice(0, lastEntry.offset + lastEntry.length) +
            `,${serialized}` +
            text.slice(lastEntry.offset + lastEntry.length)
        );
    }

    const closingLineStart = lineStart(text, closingBracket);
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const inserted = `${inferIndent(text, array)}${serialized}${trailingComma ? "," : ""}${eol}`;
    const withValue = text.slice(0, closingLineStart) + inserted + text.slice(closingLineStart);

    if (trailingComma) return withValue;
    return (
        withValue.slice(0, lastEntry.offset + lastEntry.length) +
        "," +
        withValue.slice(lastEntry.offset + lastEntry.length)
    );
}

/**
 * The editor replaces values without reserializing the rest of the document.
 * When the target path is absent, the editor uses jsonc-parser's structural edit.
 * The structural edit preserves bytes outside its edit ranges.
 */
export function setJsoncValue(text: string, path: JSONPath, value: unknown): string {
    const node = findNode(text, path);
    if (node) {
        if (Object.is(getNodeValue(node), value)) return text;
        const serialized = JSON.stringify(value);
        return text.slice(0, node.offset) + serialized + text.slice(node.offset + node.length);
    }

    return applyEdits(text, modify(text, path, value, {}));
}

/**
 * The remover preserves the exact bytes of surviving comments and surrounding JSONC regions.
 */
export function removeJsoncArrayEntries(
    text: string,
    path: JSONPath,
    shouldRemove: (entry: unknown) => boolean,
): { text: string; removed: boolean } {
    let nextText = text;
    let removed = false;

    for (;;) {
        const array = findNode(nextText, path);
        if (array?.type !== "array") return { text: nextText, removed };
        const index = (array.children ?? []).findIndex((entry) =>
            shouldRemove(getNodeValue(entry)),
        );
        if (index === -1) return { text: nextText, removed };

        const updated = removeArrayEntry(nextText, array, index);
        if (updated === nextText) return { text: nextText, removed };
        nextText = updated;
        removed = true;
    }
}

/** The appender adds values without reserializing sibling fields. */
export function appendJsoncArrayValues(text: string, path: JSONPath, values: unknown[]): string {
    let nextText = text;

    for (const value of values) {
        const array = findNode(nextText, path);
        if (array?.type !== "array") {
            return setJsoncValue(nextText, path, values);
        }
        nextText = appendArrayValue(nextText, array, value);
    }

    return nextText;
}
