import { describe, expect, test } from "bun:test";
import { recursiveCharacterSplit } from "./recursive-text-splitter";

const charLen = (t: string) => t.length;

// ---------------------------------------------------------------------------
// The reference independently defines expected output and work costs.
//
// The reference shares no code with the production splitter, so production changes cannot rewrite its expectations.
// `lengthCalls` counts every `lengthFunction` call, including front-drain re-measurements.
// `frontDrainCopiedUnits` sums `currentDoc.length` before each `currentDoc.shift()`.
// ---------------------------------------------------------------------------

interface ReferenceWork {
    lengthCalls: number;
    frontDrainCopiedUnits: number;
}

function referenceSplit(
    text: string,
    options: {
        chunkSize: number;
        lengthFunction?: (t: string) => number;
        separators?: string[];
    },
    work: ReferenceWork = { lengthCalls: 0, frontDrainCopiedUnits: 0 },
): { chunks: string[]; work: ReferenceWork } {
    const lengthFunction = options.lengthFunction ?? ((t: string) => t.length);
    const measured = (t: string): number => {
        work.lengthCalls += 1;
        return lengthFunction(t);
    };
    const separators = options.separators ?? ["\n\n", "\n", " ", ""];

    const splitOnSeparator = (input: string, separator: string): string[] => {
        const splits = separator ? input.split(separator) : input.split("");
        return splits.filter((s) => s !== "");
    };

    const mergeSplits = (splits: string[], separator: string, chunkSize: number): string[] => {
        const docs: string[] = [];
        const currentDoc: string[] = [];
        let total = 0;
        const joinDocs = (docsToJoin: string[]): string | null => {
            const joined = docsToJoin.join(separator).trim();
            return joined === "" ? null : joined;
        };
        for (const d of splits) {
            const len = measured(d);
            if (total + len + currentDoc.length * separator.length > chunkSize) {
                if (currentDoc.length > 0) {
                    const doc = joinDocs(currentDoc);
                    if (doc !== null) docs.push(doc);
                    while (total > 0 && currentDoc.length > 0) {
                        total -= measured(currentDoc[0]);
                        work.frontDrainCopiedUnits += currentDoc.length;
                        currentDoc.shift();
                    }
                }
            }
            currentDoc.push(d);
            total += len;
        }
        const doc = joinDocs(currentDoc);
        if (doc !== null) docs.push(doc);
        return docs;
    };

    const splitTextRecursive = (input: string, seps: string[], chunkSize: number): string[] => {
        const finalChunks: string[] = [];
        let separator = seps[seps.length - 1];
        let newSeparators: string[] | undefined;
        for (let i = 0; i < seps.length; i += 1) {
            const s = seps[i];
            if (s === "") {
                separator = s;
                break;
            }
            if (input.includes(s)) {
                separator = s;
                newSeparators = seps.slice(i + 1);
                break;
            }
        }

        const splits = splitOnSeparator(input, separator);
        let goodSplits: string[] = [];
        for (const s of splits) {
            if (measured(s) < chunkSize) {
                goodSplits.push(s);
            } else {
                if (goodSplits.length) {
                    finalChunks.push(...mergeSplits(goodSplits, separator, chunkSize));
                    goodSplits = [];
                }
                if (!newSeparators) {
                    finalChunks.push(s);
                } else {
                    finalChunks.push(...splitTextRecursive(s, newSeparators, chunkSize));
                }
            }
        }
        if (goodSplits.length) {
            finalChunks.push(...mergeSplits(goodSplits, separator, chunkSize));
        }
        return finalChunks;
    };

    if (text.length === 0) return { chunks: [], work };
    return { chunks: splitTextRecursive(text, separators, options.chunkSize), work };
}

const tokenLen = (t: string) => t.split(/\s+/).filter(Boolean).length;

const GOLDEN_FIXTURES: Array<{
    name: string;
    text: string;
    options: {
        chunkSize: number;
        lengthFunction?: (t: string) => number;
        separators?: string[];
    };
    expected: string[];
}> = [
    {
        name: "default paragraph/line/space hierarchy with trim",
        text: "para one\n\npara two line one\npara two line two\n\nshort para",
        options: { chunkSize: 12, lengthFunction: charLen },
        expected: ["para one", "para two", "line one", "para two", "line two", "short para"],
    },
    {
        name: "custom separator list",
        text: "a,b|c,d,e|f",
        options: { chunkSize: 3, lengthFunction: charLen, separators: ["|", ","] },
        expected: ["a,b", "c,d", "e", "f"],
    },
    {
        name: "custom token-based length function",
        text: Array.from({ length: 20 }, (_, i) => `w${i}`).join(" "),
        options: { chunkSize: 5, lengthFunction: tokenLen },
        expected: [
            "w0 w1 w2",
            "w3 w4 w5",
            "w6 w7 w8",
            "w9 w10 w11",
            "w12 w13 w14",
            "w15 w16 w17",
            "w18 w19",
        ],
    },
    {
        name: "unicode text with UTF-16 code-unit character fallback",
        text: "héllo wörld 😀😀 ünïcode tèxt",
        options: { chunkSize: 6, lengthFunction: charLen },
        expected: ["héllo", "wörld", "😀😀", "ünïcod", "e", "tèxt"],
    },
    {
        name: "fragment length exactly equal to chunkSize takes the recursive branch",
        text: "abcde fg hi",
        options: { chunkSize: 5, lengthFunction: charLen },
        expected: ["abcde", "fg hi"],
    },
    {
        name: "whitespace trimming around separators",
        text: "  alpha  \n\n  beta gamma  \n\n  delta  ",
        options: { chunkSize: 10, lengthFunction: charLen },
        expected: ["alpha", "beta gamma", "delta"],
    },
    {
        name: "long word falls through to character chunks",
        text: "aaaaaaaaaaaaaaaaaaaaaaaaa bb",
        options: { chunkSize: 10, lengthFunction: charLen },
        expected: ["aaaaaaaaaa", "aaaaaaaaaa", "aaaaa", "bb"],
    },
];

describe("recursiveCharacterSplit", () => {
    test("returns empty for empty input", () => {
        expect(recursiveCharacterSplit("", { chunkSize: 10, lengthFunction: charLen })).toEqual([]);
    });

    test("keeps text that already fits as a single chunk", () => {
        const out = recursiveCharacterSplit("short", { chunkSize: 100, lengthFunction: charLen });
        expect(out).toEqual(["short"]);
    });

    test("splits on the coarsest separator that keeps chunks under budget", () => {
        const text = "para one\n\npara two\n\npara three";
        const out = recursiveCharacterSplit(text, { chunkSize: 10, lengthFunction: charLen });
        expect(out.length).toBeGreaterThan(1);
        for (const chunk of out) {
            expect(chunk.length).toBeLessThanOrEqual(10);
        }
        expect(out.join("").replace(/\s/g, "")).toBe(text.replace(/\s/g, ""));
    });

    test("falls through the separator hierarchy down to words", () => {
        const text = "alpha beta gamma delta epsilon zeta eta theta";
        const out = recursiveCharacterSplit(text, { chunkSize: 12, lengthFunction: charLen });
        expect(out.length).toBeGreaterThan(1);
        for (const chunk of out) {
            expect(chunk.length).toBeLessThanOrEqual(12);
        }
    });

    test("splits a single long word into character chunks (no separators)", () => {
        const text = "a".repeat(50);
        const out = recursiveCharacterSplit(text, { chunkSize: 10, lengthFunction: charLen });
        expect(out.length).toBeGreaterThan(1);
        for (const chunk of out) {
            expect(chunk.length).toBeLessThanOrEqual(10);
        }
        expect(out.join("")).toBe(text);
    });

    test("honors a custom (token-like) length function", () => {
        const text = Array.from({ length: 20 }, (_, i) => `w${i}`).join(" ");
        const out = recursiveCharacterSplit(text, { chunkSize: 5, lengthFunction: tokenLen });
        expect(out.length).toBeGreaterThan(1);
        for (const chunk of out) {
            expect(tokenLen(chunk)).toBeLessThanOrEqual(5);
        }
    });

    test("defaults lengthFunction to character count", () => {
        const out = recursiveCharacterSplit("alpha beta gamma", { chunkSize: 6 });
        for (const chunk of out) {
            expect(chunk.length).toBeLessThanOrEqual(6);
        }
    });
});

describe("recursiveCharacterSplit output characterization (R34)", () => {
    for (const fixture of GOLDEN_FIXTURES) {
        test(`literal anchor: ${fixture.name}`, () => {
            expect(recursiveCharacterSplit(fixture.text, fixture.options)).toEqual(
                fixture.expected,
            );
        });

        test(`frozen reference parity: ${fixture.name}`, () => {
            const reference = referenceSplit(fixture.text, fixture.options);
            // With `charLen` and a fresh `work` object, `referenceSplit` returns deterministic chunks and work counters.
            expect(referenceSplit(fixture.text, fixture.options).chunks).toEqual(reference.chunks);
            expect(reference.chunks).toEqual(fixture.expected);
            expect(recursiveCharacterSplit(fixture.text, fixture.options)).toEqual(
                reference.chunks,
            );
        });
    }

    test("empty input and unsplittable fragments keep terminal behavior", () => {
        expect(referenceSplit("", { chunkSize: 4, lengthFunction: charLen }).chunks).toEqual([]);
        expect(recursiveCharacterSplit("", { chunkSize: 4, lengthFunction: charLen })).toEqual([]);
        // With no finer separator, a fragment whose measured length is at least `chunkSize` is emitted as-is.
        const options = {
            chunkSize: 2,
            lengthFunction: tokenLen,
            separators: ["|"],
        };
        const text = "a b c d e";
        const reference = referenceSplit(text, options).chunks;
        expect(reference).toEqual(["a b c d e"]);
        expect(recursiveCharacterSplit(text, options)).toEqual(reference);
    });

    test("differential sweep across separator levels and budgets", () => {
        const texts = [
            "one two three four five six seven eight nine ten",
            "p1 a b\n\np2 c d e\np2 line2\n\np3",
            "x".repeat(37),
            "word ".repeat(50).trim(),
            "a,b,c|d,e|f,g,h,i|j",
            "mixé 😀 ünits\n\nsécond 😀😀 pärt",
            " leading and trailing  ",
        ];
        const budgets = [1, 2, 3, 5, 8, 13, 21, 100];
        for (const text of texts) {
            for (const chunkSize of budgets) {
                for (const lengthFunction of [charLen, tokenLen]) {
                    const options = { chunkSize, lengthFunction };
                    expect(recursiveCharacterSplit(text, options)).toEqual(
                        referenceSplit(text, options).chunks,
                    );
                }
                const customOptions = {
                    chunkSize,
                    lengthFunction: charLen,
                    separators: ["|", ",", ""],
                };
                expect(recursiveCharacterSplit(text, customOptions)).toEqual(
                    referenceSplit(text, customOptions).chunks,
                );
            }
        }
    });
});

describe("recursiveCharacterSplit work bounds (R35)", () => {
    /**
     * */
    function adversarialFixture(n: number): {
        text: string;
        chunkSize: number;
        wordCount: number;
    } {
        const words = Array.from({ length: n }, (_, i) => `w${String(i % 97).padStart(2, "0")}`);
        return { text: words.join(" "), chunkSize: Math.floor(n / 2), wordCount: n };
    }

    function countingCharLen(): { fn: (t: string) => number; calls: () => number } {
        let calls = 0;
        return {
            fn: (t: string) => {
                calls += 1;
                return t.length;
            },
            calls: () => calls,
        };
    }

    test("production splitter measures each fragment exactly once per split level", () => {
        const { text, chunkSize, wordCount } = adversarialFixture(400);
        const counter = countingCharLen();
        recursiveCharacterSplit(text, { chunkSize, lengthFunction: counter.fn });
        expect(counter.calls()).toBe(wordCount);
    });

    test("production work scales linearly from N to 2N while the frozen front-drain model does not", () => {
        const n = 400;
        const small = adversarialFixture(n);
        const large = adversarialFixture(2 * n);

        const smallCounter = countingCharLen();
        const smallChunks = recursiveCharacterSplit(small.text, {
            chunkSize: small.chunkSize,
            lengthFunction: smallCounter.fn,
        });
        const largeCounter = countingCharLen();
        const largeChunks = recursiveCharacterSplit(large.text, {
            chunkSize: large.chunkSize,
            lengthFunction: largeCounter.fn,
        });

        expect(smallCounter.calls()).toBe(small.wordCount);
        expect(largeCounter.calls()).toBe(large.wordCount);
        expect(largeCounter.calls()).toBe(2 * smallCounter.calls());

        const smallRef = referenceSplit(small.text, {
            chunkSize: small.chunkSize,
            lengthFunction: charLen,
        });
        const largeRef = referenceSplit(large.text, {
            chunkSize: large.chunkSize,
            lengthFunction: charLen,
        });
        expect(smallRef.work.lengthCalls).toBeGreaterThan(small.wordCount);
        expect(largeRef.work.lengthCalls).toBeGreaterThan(large.wordCount);
        expect(largeRef.work.frontDrainCopiedUnits).toBeGreaterThan(
            3 * smallRef.work.frontDrainCopiedUnits,
        );

        expect(smallChunks).toEqual(smallRef.chunks);
        expect(largeChunks).toEqual(largeRef.chunks);
    });
});
