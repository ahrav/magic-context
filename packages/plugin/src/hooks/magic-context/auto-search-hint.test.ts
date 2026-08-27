import { describe, expect, it } from "bun:test";
import type { UnifiedSearchResult } from "../../features/magic-context/search";
import {
    MAX_AUTO_HINT_TOKENS,
    MAX_RENDER_FIELD_BYTES,
} from "../../features/magic-context/search-bounds";
import { estimateTokens } from "../../shared/token-estimator";
import { buildAutoSearchHint, packAutoSearchHint } from "./auto-search-hint";

function memory(content: string, score = 0.85, id = 1): UnifiedSearchResult {
    return {
        source: "memory",
        content,
        score,
        memoryId: id,
        category: "ARCHITECTURE_DECISIONS",
        matchType: "hybrid",
    };
}

function commit(message: string, daysAgo = 3): UnifiedSearchResult {
    return {
        source: "git_commit",
        content: message,
        score: 0.8,
        sha: "a".repeat(40),
        shortSha: "abcd123",
        author: "dev@example.com",
        committedAtMs: Date.now() - daysAgo * 24 * 60 * 60 * 1000,
        matchType: "fts",
    };
}

function antiMemory(id: string, strategy: string): UnifiedSearchResult {
    return {
        source: "anti_memory",
        score: 0.95,
        publicClaimId: id,
        revisionLocator: `${id}/r1/${"a".repeat(64)}`,
        contentDigest: "a".repeat(64),
        claimId: 1,
        normalizedHash: "b".repeat(64),
        trigger: "session caching",
        rejectedStrategy: strategy,
        rejectionReason: "it creates split ownership",
        saferAlternative: "use SQLite",
        matchType: "lexical",
    };
}

describe("buildAutoSearchHint", () => {
    it("returns null for empty results", () => {
        expect(buildAutoSearchHint([])).toBeNull();
    });

    it("wraps fragments in <ctx-search-hint>", () => {
        const hint = buildAutoSearchHint([memory("install.sh uses bunx without --bun flag")]);
        expect(hint).not.toBeNull();
        expect(hint?.startsWith("<ctx-search-hint>")).toBe(true);
        expect(hint?.endsWith("</ctx-search-hint>")).toBe(true);
        expect(hint).toContain("ctx_search");
        expect(hint).toContain("If the fragments above seem relevant");
    });

    it("caps to max fragments", () => {
        const results = [memory("one"), memory("two"), memory("three"), memory("four")];
        const hint = buildAutoSearchHint(results, { maxFragments: 2 });
        const lines = (hint ?? "").split("\n").filter((l) => l.startsWith("- "));
        expect(lines).toHaveLength(2);
    });

    it("truncates overlong fragments with ellipsis", () => {
        const long = "a".repeat(500);
        const hint = buildAutoSearchHint([memory(long)], { fragmentCharCap: 40 });
        expect(hint).not.toBeNull();
        // Find the bullet line
        const bullet = (hint ?? "").split("\n").find((l) => l.startsWith("- "));
        expect(bullet).toBeDefined();
        expect((bullet?.length ?? 0) <= 45).toBe(true);
        expect(bullet?.endsWith("…")).toBe(true);
    });

    it("prefixes commit fragments with sha and relative age", () => {
        const hint = buildAutoSearchHint([commit("install: force bun runtime", 5)]);
        expect(hint).toContain("commit abcd123");
        expect(hint).toContain("5d ago");
        expect(hint).toContain("install: force bun runtime");
    });

    it("compresses memory content with caveman-ultra", () => {
        // "because" should become "//" under ultra compression.
        const hint = buildAutoSearchHint([
            memory("install fails because Node handles stdin differently"),
        ]);
        expect(hint).toContain("//");
    });

    it("singular vs plural header", () => {
        const single = buildAutoSearchHint([memory("one")]);
        expect(single).toContain("1 related fragment");
        const many = buildAutoSearchHint([memory("one"), memory("two")]);
        expect(many).toContain("2 related fragments");
    });

    it("keeps a fitting prefix when the full fragment set overflows the budget", () => {
        const noisy = (seed: number) =>
            Array.from({ length: 900 }, (_, index) =>
                ((seed * 7919 + index * 2654435761) % 36).toString(36),
            ).join("");
        const hint = buildAutoSearchHint(
            [memory(noisy(1), 0.9, 1), memory(noisy(2), 0.9, 2), memory(noisy(3), 0.9, 3)],
            { fragmentCharCap: 220 },
        );
        // The packer must return a hint when a prefix of cap-truncated
        // fragments fits the budget, rather than dropping the hint entirely.
        expect(hint).not.toBeNull();
        expect(estimateTokens(hint ?? "")).toBeLessThanOrEqual(MAX_AUTO_HINT_TOKENS);
        expect(hint?.startsWith("<ctx-search-hint>")).toBe(true);
        expect(hint?.endsWith("</ctx-search-hint>")).toBe(true);
        expect(hint).toContain("If the fragments above seem relevant");
        const bullets = (hint ?? "").split("\n").filter((line) => line.startsWith("- "));
        expect(bullets.length).toBeGreaterThanOrEqual(1);
        expect(bullets.length).toBeLessThan(3);
        for (const bullet of bullets) {
            // A kept fragment carries its full cap-truncated shape.
            expect(bullet.length).toBeGreaterThan(180);
        }
    });

    it("bounds oversized dynamic fields before compression", () => {
        const oversized = "word ".repeat(10_000);
        const hint = buildAutoSearchHint([
            {
                source: "compartment",
                content: "preview",
                score: 0.9,
                compartmentId: 1,
                sessionId: "s1",
                title: oversized,
                startOrdinal: 1,
                endOrdinal: 2,
                matchType: "semantic",
            },
        ]);
        expect(hint).not.toBeNull();
        const bullet = (hint ?? "").split("\n").find((line) => line.startsWith("- "));
        expect(Buffer.byteLength(bullet ?? "", "utf8")).toBeLessThanOrEqual(MAX_RENDER_FIELD_BYTES);
    });

    it("puts one complete warning first and stays inside the hint budget", () => {
        const first = antiMemory(`mcm_${"a".repeat(32)}`, "Redis");
        const second = antiMemory(`mcm_${"b".repeat(32)}`, "Memcached");
        const packed = packAutoSearchHint([memory("ordinary fragment"), second, first]);

        expect(packed.text).toContain("⚠ Previously rejected: Memcached");
        expect(packed.text).toContain("Reason: it creates split ownership");
        expect(packed.text).toContain("Safer alternative: use SQLite");
        expect(packed.text).toContain("Verify before proceeding");
        expect(packed.text).not.toContain("Previously rejected: Redis");
        expect(packed.delivered.filter((result) => result.source === "anti_memory")).toHaveLength(
            1,
        );
        expect(packed.delivered[0]).toBe(second);
        expect(packed.tokenCount).toBeLessThanOrEqual(MAX_AUTO_HINT_TOKENS);
    });
});

describe("packAutoSearchHint", () => {
    it("returns text byte-identical to buildAutoSearchHint when every fragment fits", () => {
        const results = [memory("one fragment", 0.9, 1), commit("install: force bun runtime", 5)];
        const packed = packAutoSearchHint(results);
        expect(packed.text).toBe(buildAutoSearchHint(results));
        expect(packed.delivered).toEqual(results);
        expect(packed.omittedCount).toBe(0);
        expect(packed.tokenCount).toBe(estimateTokens(packed.text ?? ""));
    });

    it("returns text byte-identical to buildAutoSearchHint when packing drops fragments", () => {
        const noisy = (seed: number) =>
            Array.from({ length: 900 }, (_, index) =>
                ((seed * 7919 + index * 2654435761) % 36).toString(36),
            ).join("");
        const results = [
            memory(noisy(1), 0.9, 1),
            memory(noisy(2), 0.9, 2),
            memory(noisy(3), 0.9, 3),
        ];
        const options = { fragmentCharCap: 220 };
        const packed = packAutoSearchHint(results, options);
        expect(packed.text).toBe(buildAutoSearchHint(results, options));
        expect(packed.text).not.toBeNull();

        const bullets = (packed.text ?? "").split("\n").filter((line) => line.startsWith("- "));
        // Delivered results preserve input order and correspond one-to-one
        // with emitted hint fragments.
        expect(packed.delivered.length).toBe(bullets.length);
        expect(packed.delivered.length).toBeLessThan(results.length);
        expect(packed.delivered).toEqual(results.slice(0, packed.delivered.length));
        expect(packed.omittedCount).toBe(results.length - packed.delivered.length);
        expect(packed.tokenCount).toBe(estimateTokens(packed.text ?? ""));
        expect(packed.tokenCount).toBeLessThanOrEqual(MAX_AUTO_HINT_TOKENS);
    });

    it("counts results beyond maxFragments as omitted, not delivered", () => {
        const results = [memory("one"), memory("two"), memory("three"), memory("four")];
        const packed = packAutoSearchHint(results, { maxFragments: 2 });
        expect(packed.text).toBe(buildAutoSearchHint(results, { maxFragments: 2 }));
        expect(packed.delivered).toEqual(results.slice(0, 2));
        expect(packed.omittedCount).toBe(2);
    });

    it("returns a null-text empty delivery for empty results", () => {
        const packed = packAutoSearchHint([]);
        expect(packed.text).toBeNull();
        expect(packed.delivered).toEqual([]);
        expect(packed.tokenCount).toBe(0);
        expect(packed.omittedCount).toBe(0);
    });

    it("returns a null-text empty delivery when no fragment survives compression", () => {
        const packed = packAutoSearchHint([memory("   ", 0.9, 1)]);
        expect(packed.text).toBeNull();
        expect(buildAutoSearchHint([memory("   ", 0.9, 1)])).toBeNull();
        expect(packed.delivered).toEqual([]);
        expect(packed.tokenCount).toBe(0);
        expect(packed.omittedCount).toBe(1);
    });
});
