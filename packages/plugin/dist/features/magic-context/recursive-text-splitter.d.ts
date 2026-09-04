/**
 * Minimal synchronous port of LangChain's `RecursiveCharacterTextSplitter`.
 *
 * Vendored (not depended on) so the plugin install stays lean and free of the
 * supply-chain surface of the full `@langchain/textsplitters` package (whose
 * bundled dist tripped an org Socket "obfuscated code" alert — a false positive
 * on minified output, but a policy blocker). We only need the recursive
 * character split for one job: cutting a single oversized canonical line down
 * to a token budget. The Document/metadata/language-preset/token machinery in
 * the upstream package is irrelevant here, so this keeps just the core
 * algorithm (`splitOnSeparator` + `mergeSplits` + `_splitText`) and makes it
 * synchronous (our `lengthFunction` is a sync tokenizer).
 *
 * Algorithm and separator hierarchy ported faithfully from
 * `@langchain/textsplitters` v1.0.1 (`text_splitter.ts`), MIT-licensed
 * (LangChain, Inc.). Behavior matches upstream for `keepSeparator: false`,
 * `chunkOverlap: 0`, which is all this call site uses.
 */
/** Length of a piece of text, in whatever unit the caller measures (tokens). */
export type LengthFunction = (text: string) => number;
export interface RecursiveCharacterSplitOptions {
    /** Max length (in `lengthFunction` units) of an emitted chunk. */
    chunkSize: number;
    /** Length function; defaults to character count. */
    lengthFunction?: LengthFunction;
    /** Separator hierarchy, tried in order; "" means split into characters. */
    separators?: string[];
}
/**
 * Recursively split `text` into chunks no larger than `chunkSize` (measured by
 * `lengthFunction`), preferring the coarsest separator that keeps chunks under
 * budget and falling back through the separator hierarchy down to characters.
 * Synchronous.
 */
export declare function recursiveCharacterSplit(text: string, options: RecursiveCharacterSplitOptions): string[];
//# sourceMappingURL=recursive-text-splitter.d.ts.map