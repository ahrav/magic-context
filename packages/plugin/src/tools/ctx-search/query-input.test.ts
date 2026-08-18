import { describe, expect, it } from "bun:test";

import { extractCtxSearchQueryInput, normalizeCtxSearchArgs } from "./query-input";

describe("normalizeCtxSearchArgs", () => {
    it("passes ordinary args through unchanged", () => {
        const args = { query: "find the retry policy", limit: 5 };
        expect(normalizeCtxSearchArgs(args)).toEqual(args);
    });

    it("unwraps the imitated-reduced argument shape", () => {
        const args = {
            reduced: true,
            summary: JSON.stringify({ query: "nested lookup", sources: ["memory"] }),
        };
        expect(normalizeCtxSearchArgs(args)).toMatchObject({ query: "nested lookup" });
    });

    it("keeps malformed nested summaries as-is instead of guessing", () => {
        const args = { reduced: true, summary: "not json at all" };
        expect(normalizeCtxSearchArgs(args)).toEqual(args);
    });
});

describe("extractCtxSearchQueryInput", () => {
    it("trims and accepts an ordinary query", () => {
        expect(extractCtxSearchQueryInput({ query: "  spaced query  " })).toEqual({
            ok: true,
            query: "spaced query",
        });
    });

    it("returns the empty query for omitted input", () => {
        expect(extractCtxSearchQueryInput({})).toEqual({ ok: true, query: "" });
    });

    it("rejects an over-cap query with the byte violation", () => {
        const result = extractCtxSearchQueryInput({ query: "x".repeat(17 * 1024) });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.violation).toBe("bytes");
    });
});
