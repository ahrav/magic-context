import { describe, expect, it } from "bun:test";
import { parseRangeString } from "./range-parser";

describe("parseRangeString", () => {
    // Each row parses one accepted input shape into its expanded id list.
    it.each([
        ["parses a single number", "5", [5]],
        ["parses a range", "3-5", [3, 4, 5]],
        ["parses comma-separated numbers", "1,2,9", [1, 2, 9]],
        [
            "parses mixed ranges and individual numbers",
            "1-5,8,12-15",
            [1, 2, 3, 4, 5, 8, 12, 13, 14, 15],
        ],
        ["deduplicates repeated numbers", "1,1,2,3,3", [1, 2, 3]],
        ["handles whitespace around separators", " 3 - 5 , 8 ", [3, 4, 5, 8]],
        // The agent often pastes transcript §N§ tag markers verbatim; they
        // parse as their bare numbers instead of erroring.
        ["tolerates §N§ tag markers in a range", "§302§-§305§", [302, 303, 304, 305]],
        ["tolerates §N§ markers in a single id", "§5§", [5]],
        ["tolerates §N§ markers in a comma list", "§1§,§2§,§9§", [1, 2, 9]],
        ["tolerates mixed bare and marked ids", "1-3,§8§", [1, 2, 3, 8]],
    ] as Array<[string, string, number[]]>)("%s", (_title, input, expected) => {
        expect(parseRangeString(input)).toEqual(expected);
    });

    // Each row is one rejected input shape.
    it.each([
        ["throws on empty string", ""],
        ["throws on non-numeric input", "abc"],
        ["throws on reversed range", "5-3"],
        ["throws on range of 1001 elements", "1-1001"],
    ] as Array<[string, string]>)("%s", (_title, input) => {
        expect(() => parseRangeString(input)).toThrow();
    });

    it("throws on range exceeding 1000 elements", () => {
        //#given
        const input = "1-10000";
        //#when + #then
        expect(() => parseRangeString(input)).toThrow(
            'Range "1-10000" exceeds maximum size of 1000 elements (got 10000)',
        );
    });

    it("allows max valid range of 1000 elements", () => {
        //#given
        const input = "1-1000";
        //#when
        const result = parseRangeString(input);
        //#then
        expect(result).toHaveLength(1000);
        expect(result[0]).toBe(1);
        expect(result[999]).toBe(1000);
    });
});
