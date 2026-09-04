/**
 * Parses a range string into a sorted, deduplicated array of integers.
 *
 * Supported syntax:
 * - Single number: "5" → [5]
 * - Range: "3-5" → [3, 4, 5]
 * - Comma-separated: "1,2,9" → [1, 2, 9]
 * - Mixed: "1-5,8,12-15" → [1, 2, 3, 4, 5, 8, 12, 13, 14, 15]
 *
 * Tolerant of the `§N§` tag notation the agent sees in the transcript: a model
 * frequently copies the markers verbatim (e.g. `§302§-§380§`) instead of the bare
 * numbers. Since `§` (U+00A7) is never legitimate in a numeric range, we strip it
 * up front and accept the numbers rather than erroring — the markers are exactly
 * the identifiers we want to drop anyway.
 *
 * @throws {Error} on empty string, non-numeric input, reversed ranges, or ranges exceeding 1000 elements
 */
export declare function parseRangeString(input: string): number[];
//# sourceMappingURL=range-parser.d.ts.map