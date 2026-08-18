import { describe, expect, it } from "bun:test";
import type {
    MemorySearchResult,
    MessageSearchResult,
    NoteSearchResult,
    UnifiedSearchResult,
} from "../../features/magic-context/search";
import {
    boundDynamicField,
    MAX_RENDER_FIELD_BYTES,
    MAX_RENDERED_RESULT_TOKENS,
} from "../../features/magic-context/search-bounds";
import { estimateTokens } from "../../shared/token-estimator";
import { formatSearchResults } from "./render";

const SESSION = "session-1";

function memoryResult(id: number, content: string): MemorySearchResult {
    return {
        source: "memory",
        content,
        score: 0.9,
        memoryId: id,
        category: "decision",
        matchType: "fts",
    };
}

function messageResult(ordinal: number, content: string): MessageSearchResult {
    return {
        source: "message",
        content,
        score: 0.8,
        messageOrdinal: ordinal,
        messageId: `m${ordinal}`,
        role: "user",
    };
}

function noteResult(id: number, anchorOrdinal: number | null): NoteSearchResult {
    return {
        source: "note",
        content: "parked decision",
        score: 0.7,
        noteId: id,
        status: "active",
        createdAt: Date.now(),
        anchorOrdinal,
        sourceSessionId: SESSION,
    };
}

describe("boundDynamicField", () => {
    it("returns short fields unchanged", () => {
        expect(boundDynamicField("short")).toBe("short");
    });

    it("cuts oversized fields to the byte cap on a code-point boundary", () => {
        const bounded = boundDynamicField("🎉".repeat(1000));
        expect(Buffer.byteLength(bounded, "utf8")).toBeLessThanOrEqual(MAX_RENDER_FIELD_BYTES);
        expect(Buffer.from(bounded, "utf8").toString("utf8")).toBe(bounded);
    });
});

describe("formatSearchResults", () => {
    it("freezes the historical under-budget shape", () => {
        const results: UnifiedSearchResult[] = [
            memoryResult(7, "always use bd for tracking"),
            messageResult(42, "we discussed queue saturation"),
        ];
        const text = formatSearchResults("queue", results, SESSION);
        expect(text).toBe(
            [
                'Found 2 results for "queue":',
                "",
                "[1] [memory] score=0.90 id=7 category=decision match=fts",
                "always use bd for tracking",
                "",
                "[2] [message] score=0.80 ordinal=42 range=39-45 role=user",
                "we discussed queue saturation",
                "",
                "Use ctx_expand(start, end) with the range from any message result above to read the full conversation context.",
            ].join("\n"),
        );
    });

    it("keeps the empty-result message unchanged", () => {
        expect(formatSearchResults("nothing", [], SESSION)).toBe(
            'No results found for "nothing" across notes, memories, primers, git commits, or message history.',
        );
    });

    it("emits the note expand hint only for current-session anchored notes", () => {
        const anchored = formatSearchResults("q", [noteResult(1, 12)], SESSION);
        expect(anchored).toContain("ctx_expand(start=N-10, end=N)");
        const foreign = formatSearchResults(
            "q",
            [{ ...noteResult(2, 12), sourceSessionId: "other" }],
            SESSION,
        );
        expect(foreign).not.toContain("ctx_expand(start=N-10, end=N)");
    });

    it("bounds every dynamic field before tokenization", () => {
        const huge = "content ".repeat(4000);
        const text = formatSearchResults("q", [memoryResult(1, huge)], SESSION);
        const body = text.split("\n")[3] ?? "";
        expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(MAX_RENDER_FIELD_BYTES);
    });

    it("bounds the echoed query", () => {
        const text = formatSearchResults("q".repeat(5000), [], SESSION);
        expect(Buffer.byteLength(text, "utf8")).toBeLessThan(MAX_RENDER_FIELD_BYTES + 200);
    });

    it("keeps a ranked prefix of complete blocks under the token budget", () => {
        const filler = Array.from({ length: 300 }, (_, index) =>
            ((index * 2654435761) % 36).toString(36),
        ).join(" ");
        const results = Array.from({ length: 50 }, (_, index) =>
            memoryResult(index + 1, `${filler} tail-${index}`),
        );
        const text = formatSearchResults("big", results, SESSION);
        expect(estimateTokens(text)).toBeLessThanOrEqual(MAX_RENDERED_RESULT_TOKENS);

        const shownBlocks = (text.match(/\[\d+\] \[memory\]/g) ?? []).length;
        expect(shownBlocks).toBeGreaterThan(0);
        expect(shownBlocks).toBeLessThan(50);
        // Ranked prefix: block indexes are 1..shownBlocks with none skipped.
        for (let index = 1; index <= shownBlocks; index += 1) {
            expect(text).toContain(`[${index}] [memory]`);
        }
        expect(text).toContain(
            `(${50 - shownBlocks} results omitted to fit the output budget — refine the query or lower the limit)`,
        );
        // Complete blocks only: every shown block still carries its tail marker.
        for (let index = 0; index < shownBlocks; index += 1) {
            expect(text).toContain(`tail-${index}`);
        }
    });

    it("omits a whole block rather than splitting it at the budget edge", () => {
        const filler = Array.from({ length: 300 }, (_, index) =>
            ((index * 48271) % 36).toString(36),
        ).join(" ");
        const results = Array.from({ length: 50 }, (_, index) =>
            memoryResult(index + 1, `${filler} sentinel-${index}`),
        );
        const text = formatSearchResults("edge", results, SESSION);
        // A block is either fully present (header + its sentinel) or fully absent.
        const shownBlocks = (text.match(/\[\d+\] \[memory\]/g) ?? []).length;
        for (let index = 0; index < 50; index += 1) {
            const hasHeader = text.includes(`[${index + 1}] [memory]`);
            const hasBody = text.includes(`sentinel-${index}`);
            expect(hasHeader).toBe(hasBody);
            expect(hasHeader).toBe(index < shownBlocks);
        }
    });

    it("suppresses source hints when every source-bearing block is omitted", () => {
        const filler = Array.from({ length: 300 }, (_, index) =>
            ((index * 69621) % 36).toString(36),
        ).join(" ");
        const memories = Array.from({ length: 49 }, (_, index) =>
            memoryResult(index + 1, `${filler} pad-${index}`),
        );
        // The lone message block ranks last, so packing drops it first.
        const results: UnifiedSearchResult[] = [...memories, messageResult(9, filler)];
        const text = formatSearchResults("hints", results, SESSION);
        // Packing must omit the last-ranked message block so the test covers
        // hint suppression after every source-bearing block is omitted.
        expect(text).not.toContain("[message]");
        expect(text).not.toContain("Use ctx_expand(start, end)");
        expect(estimateTokens(text)).toBeLessThanOrEqual(MAX_RENDERED_RESULT_TOKENS);
    });
});
