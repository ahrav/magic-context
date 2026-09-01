/**
 *
 * This module avoids a dependency on `@langchain/textsplitters`.
 *
 */

/** `LengthFunction` returns text length in caller-defined units. */
export type LengthFunction = (text: string) => number;

export interface RecursiveCharacterSplitOptions {
    /** `chunkSize` recursively splits a fragment whose `lengthFunction` length is at least `chunkSize` when later separators remain. */
    chunkSize: number;
    /* */
    lengthFunction?: LengthFunction;
    /** `separators` are tried in order; `""` splits into characters. */
    separators?: string[];
}

const DEFAULT_SEPARATORS = ["\n\n", "\n", " ", ""];

function splitOnSeparator(text: string, separator: string): string[] {
    const splits = separator ? text.split(separator) : text.split("");
    return splits.filter((s) => s !== "");
}

/**
 * `mergeSplits` drains positive-length fragments after an overflow because overlap is zero.
 *
 */
function mergeSplits(
    splits: string[],
    lens: number[],
    separator: string,
    chunkSize: number,
): string[] {
    const docs: string[] = [];
    const separatorLength = separator.length;
    let start = 0;
    let end = 0;
    let total = 0;
    const joinDocs = (from: number, to: number): string | null => {
        const joined = splits.slice(from, to).join(separator).trim();
        return joined === "" ? null : joined;
    };
    for (let i = 0; i < splits.length; i += 1) {
        const len = lens[i];
        if (total + len + (end - start) * separatorLength > chunkSize) {
            if (end - start > 0) {
                const doc = joinDocs(start, end);
                if (doc !== null) docs.push(doc);
                // `total > 0` retains zero-length-measured fragments after the last positive-length fragment.
                while (total > 0 && end - start > 0) {
                    total -= lens[start];
                    start += 1;
                }
            }
        }
        end = i + 1;
        total += len;
    }
    const doc = joinDocs(start, end);
    if (doc !== null) docs.push(doc);
    return docs;
}

function splitTextRecursive(
    text: string,
    separators: string[],
    chunkSize: number,
    lengthFunction: LengthFunction,
): string[] {
    const finalChunks: string[] = [];
    let separator = separators[separators.length - 1];
    let newSeparators: string[] | undefined;
    for (let i = 0; i < separators.length; i += 1) {
        const s = separators[i];
        if (s === "") {
            separator = s;
            break;
        }
        if (text.includes(s)) {
            separator = s;
            newSeparators = separators.slice(i + 1);
            break;
        }
    }

    const splits = splitOnSeparator(text, separator);
    let goodSplits: string[] = [];
    let goodLens: number[] = [];
    for (const s of splits) {
        const len = lengthFunction(s);
        if (len < chunkSize) {
            goodSplits.push(s);
            goodLens.push(len);
        } else {
            if (goodSplits.length) {
                finalChunks.push(...mergeSplits(goodSplits, goodLens, separator, chunkSize));
                goodSplits = [];
                goodLens = [];
            }
            if (!newSeparators) {
                finalChunks.push(s);
            } else {
                finalChunks.push(
                    ...splitTextRecursive(s, newSeparators, chunkSize, lengthFunction),
                );
            }
        }
    }
    if (goodSplits.length) {
        finalChunks.push(...mergeSplits(goodSplits, goodLens, separator, chunkSize));
    }
    return finalChunks;
}

/**
 * Synchronous.
 */
export function recursiveCharacterSplit(
    text: string,
    options: RecursiveCharacterSplitOptions,
): string[] {
    const chunkSize = options.chunkSize;
    const lengthFunction = options.lengthFunction ?? ((t: string) => t.length);
    const separators = options.separators ?? DEFAULT_SEPARATORS;
    if (text.length === 0) return [];
    return splitTextRecursive(text, separators, chunkSize, lengthFunction);
}
