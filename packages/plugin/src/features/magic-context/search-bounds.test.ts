import { describe, expect, it } from "bun:test";
import { estimateTokens } from "../../shared/token-estimator";
import {
    CandidateDepthError,
    countQueryAtoms,
    DEFAULT_SEARCH_RESULT_LIMIT,
    describeQueryBoundsViolation,
    MAX_CANDIDATE_DEPTH,
    MAX_QUERY_ATOMS,
    MAX_QUERY_BYTES,
    MAX_QUERY_TOKENS,
    MAX_SEARCH_RESULT_LIMIT,
    normalizeCandidateDepth,
    normalizeSearchResultLimit,
    prepareAutomaticQuery,
    prepareExplicitQuery,
    QueryBoundsError,
    renderAntiMemoryWarningLine,
    truncateUtf8Bytes,
} from "./search-bounds";

function rejection(raw: string) {
    const outcome = prepareExplicitQuery(raw);
    if (outcome.ok) throw new Error("expected rejection");
    return outcome;
}

/** No lone surrogate anywhere — a round-trip through UTF-8 is lossless. */
function isValidUnicode(text: string): boolean {
    return Buffer.from(text, "utf8").toString("utf8") === text;
}

describe("countQueryAtoms", () => {
    it("counts whitespace-delimited operands including duplicates", () => {
        expect(countQueryAtoms("")).toBe(0);
        expect(countQueryAtoms("   ")).toBe(0);
        expect(countQueryAtoms("one")).toBe(1);
        expect(countQueryAtoms("dup dup dup")).toBe(3);
        expect(countQueryAtoms("  spaced\tout\nwords  ")).toBe(3);
    });
});

describe("prepareExplicitQuery", () => {
    it("admits a query at exactly the byte cap through byte preflight", () => {
        const raw = "a".repeat(MAX_QUERY_BYTES);
        const outcome = prepareExplicitQuery(raw);
        if (!outcome.ok) {
            expect(outcome.violation).not.toBe("bytes");
        }
    });

    it("rejects one byte over the cap on bytes, before token or atom checks", () => {
        const outcome = rejection("a".repeat(MAX_QUERY_BYTES + 1));
        expect(outcome.violation).toBe("bytes");
        expect(outcome.limit).toBe(MAX_QUERY_BYTES);
        expect(outcome.actual).toBe(MAX_QUERY_BYTES + 1);
    });

    it("measures bytes of UTF-8, not characters", () => {
        // 4 bytes per emoji: a quarter of the cap in characters still overflows.
        const outcome = rejection("🎉".repeat(MAX_QUERY_BYTES / 4 + 1));
        expect(outcome.violation).toBe("bytes");
    });

    it("rejects a huge whitespace-only query on raw bytes instead of trimming it empty", () => {
        const outcome = rejection(" ".repeat(MAX_QUERY_BYTES + 1));
        expect(outcome.violation).toBe("bytes");
    });

    it("admits exactly the atom cap and rejects one atom over", () => {
        const atCap = Array.from({ length: MAX_QUERY_ATOMS }, () => "w").join(" ");
        expect(prepareExplicitQuery(atCap)).toEqual({ ok: true, query: atCap });
        const overCap = `${atCap} extra`;
        const outcome = rejection(overCap);
        expect(outcome.violation).toBe("atoms");
        expect(outcome.actual).toBe(MAX_QUERY_ATOMS + 1);
    });

    it("counts duplicate atoms toward the cap", () => {
        const outcome = rejection(
            Array.from({ length: MAX_QUERY_ATOMS + 1 }, () => "dup").join(" "),
        );
        expect(outcome.violation).toBe("atoms");
    });

    it("rejects a token-cap overflow for a query under the byte and atom caps", () => {
        // Pseudo-random chars resist BPE run-collapsing, unlike "x".repeat().
        const raw = Array.from({ length: 8000 }, (_, index) =>
            ((index * 2654435761) % 36).toString(36),
        ).join("");
        expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(MAX_QUERY_BYTES);
        expect(countQueryAtoms(raw)).toBe(1);
        expect(estimateTokens(raw)).toBeGreaterThan(MAX_QUERY_TOKENS);
        const outcome = rejection(raw);
        expect(outcome.violation).toBe("tokens");
        expect(outcome.limit).toBe(MAX_QUERY_TOKENS);
    });

    it("admits an ordinary query trimmed", () => {
        expect(prepareExplicitQuery("  hello bounded world  ")).toEqual({
            ok: true,
            query: "hello bounded world",
        });
    });

    it("admits an empty query so the existing empty-query path still applies", () => {
        expect(prepareExplicitQuery("")).toEqual({ ok: true, query: "" });
        expect(prepareExplicitQuery("   ")).toEqual({ ok: true, query: "" });
    });
});

describe("prepareAutomaticQuery", () => {
    it("returns an under-cap prompt trimmed and unchanged", () => {
        expect(prepareAutomaticQuery("  keep this text  ")).toBe("keep this text");
    });

    it("always satisfies every cap for adversarial inputs", () => {
        const inputs = [
            "word ".repeat(50_000),
            "x".repeat(1_000_000),
            `${"🎉".repeat(10_000)} trailing words here`,
            `lead ${"y".repeat(40_000)} tail`,
        ];
        for (const input of inputs) {
            const query = prepareAutomaticQuery(input);
            expect(Buffer.byteLength(query, "utf8")).toBeLessThanOrEqual(MAX_QUERY_BYTES);
            expect(countQueryAtoms(query)).toBeLessThanOrEqual(MAX_QUERY_ATOMS);
            expect(estimateTokens(query)).toBeLessThanOrEqual(MAX_QUERY_TOKENS);
            expect(isValidUnicode(query)).toBe(true);
        }
    });

    it("is deterministic", () => {
        const input = `${"🎉".repeat(9000)} some trailing words`;
        expect(prepareAutomaticQuery(input)).toBe(prepareAutomaticQuery(input));
    });

    it("keeps exactly the first MAX_QUERY_ATOMS atoms when only the atom cap binds", () => {
        const atoms = Array.from({ length: 200 }, (_, index) => `w${index}`);
        const query = prepareAutomaticQuery(atoms.join(" "));
        expect(query).toBe(atoms.slice(0, MAX_QUERY_ATOMS).join(" "));
    });

    it("cuts on complete-atom boundaries when the token cap binds", () => {
        const atoms = Array.from({ length: 60 }, (_, atomIndex) =>
            Array.from({ length: 120 }, (_, charIndex) =>
                ((atomIndex * 7919 + charIndex * 2654435761) % 36).toString(36),
            ).join(""),
        );
        expect(estimateTokens(atoms.join(" "))).toBeGreaterThan(MAX_QUERY_TOKENS);
        const query = prepareAutomaticQuery(atoms.join(" "));
        expect(estimateTokens(query)).toBeLessThanOrEqual(MAX_QUERY_TOKENS);
        const kept = query.split(/\s+/);
        expect(kept.length).toBeLessThan(atoms.length);
        expect(kept.length).toBeGreaterThan(0);
        // Every retained atom is complete — no atom was split mid-way.
        kept.forEach((atom, index) => {
            expect(atom).toBe(atoms[index]);
        });
    });

    it("falls back to a code-point cut when a single atom exceeds the token cap", () => {
        const raw = Array.from({ length: 12_000 }, (_, index) =>
            ((index * 2654435761) % 36).toString(36),
        ).join("");
        expect(estimateTokens(raw)).toBeGreaterThan(MAX_QUERY_TOKENS);
        const query = prepareAutomaticQuery(raw);
        expect(query.length).toBeGreaterThan(0);
        expect(estimateTokens(query)).toBeLessThanOrEqual(MAX_QUERY_TOKENS);
    });

    it("never splits a surrogate pair at the byte boundary", () => {
        // 4-byte emoji misaligned with the 16 KiB boundary.
        const query = prepareAutomaticQuery(`abc${"🎉".repeat(8000)}`);
        expect(isValidUnicode(query)).toBe(true);
        expect(Buffer.byteLength(query, "utf8")).toBeLessThanOrEqual(MAX_QUERY_BYTES);
    });

    it("returns empty for whitespace-only input", () => {
        expect(prepareAutomaticQuery(" ".repeat(100_000))).toBe("");
    });
});

describe("normalizeSearchResultLimit", () => {
    it("uses the default for missing and non-finite limits", () => {
        expect(normalizeSearchResultLimit(undefined)).toBe(DEFAULT_SEARCH_RESULT_LIMIT);
        expect(normalizeSearchResultLimit(Number.NaN)).toBe(DEFAULT_SEARCH_RESULT_LIMIT);
        expect(normalizeSearchResultLimit(Number.POSITIVE_INFINITY)).toBe(
            DEFAULT_SEARCH_RESULT_LIMIT,
        );
        expect(normalizeSearchResultLimit(Number.NEGATIVE_INFINITY)).toBe(
            DEFAULT_SEARCH_RESULT_LIMIT,
        );
    });

    it("floors fractional limits and clamps to the minimum", () => {
        expect(normalizeSearchResultLimit(3.9)).toBe(3);
        expect(normalizeSearchResultLimit(0.5)).toBe(1);
        expect(normalizeSearchResultLimit(0)).toBe(1);
        expect(normalizeSearchResultLimit(-25)).toBe(1);
    });

    it("clamps values above the ceiling to the ceiling", () => {
        expect(normalizeSearchResultLimit(MAX_SEARCH_RESULT_LIMIT)).toBe(MAX_SEARCH_RESULT_LIMIT);
        expect(normalizeSearchResultLimit(MAX_SEARCH_RESULT_LIMIT + 1)).toBe(
            MAX_SEARCH_RESULT_LIMIT,
        );
        expect(normalizeSearchResultLimit(10_000)).toBe(MAX_SEARCH_RESULT_LIMIT);
    });
});

describe("truncateUtf8Bytes", () => {
    it("returns short text unchanged", () => {
        expect(truncateUtf8Bytes("short", 100)).toBe("short");
    });

    it("cuts to the byte budget without splitting a surrogate pair", () => {
        const cut = truncateUtf8Bytes("🎉🎉🎉", 6);
        expect(cut).toBe("🎉");
        expect(isValidUnicode(cut)).toBe(true);
    });
});

describe("normalizeCandidateDepth", () => {
    it("returns null for a missing request", () => {
        expect(normalizeCandidateDepth(undefined)).toBeNull();
    });

    it("admits integer depths across the full range", () => {
        expect(normalizeCandidateDepth(1)).toBe(1);
        expect(normalizeCandidateDepth(50)).toBe(50);
        expect(normalizeCandidateDepth(MAX_CANDIDATE_DEPTH)).toBe(MAX_CANDIDATE_DEPTH);
    });

    it("rejects out-of-range and non-integer depths instead of clamping", () => {
        for (const depth of [
            0,
            -1,
            MAX_CANDIDATE_DEPTH + 1,
            2.5,
            Number.NaN,
            Number.POSITIVE_INFINITY,
        ]) {
            let error: unknown = null;
            try {
                normalizeCandidateDepth(depth);
            } catch (caught) {
                error = caught;
            }
            expect(error).toBeInstanceOf(CandidateDepthError);
            expect((error as CandidateDepthError).requested).toBe(depth);
        }
    });
});

describe("QueryBoundsError", () => {
    it("carries the violation detail and shared message", () => {
        const detail = { violation: "atoms" as const, limit: 64, actual: 65 };
        const error = new QueryBoundsError(detail);
        expect(error.violation).toBe("atoms");
        expect(error.limit).toBe(64);
        expect(error.actual).toBe(65);
        expect(error.message).toBe(describeQueryBoundsViolation(detail));
    });
});

describe("renderAntiMemoryWarningLine", () => {
    const fields = {
        trigger: "session caching",
        rejectedStrategy: "Redis",
        rejectionReason: "it creates split ownership",
    };

    it("renders the safer-alternative clause when bounding keeps content", () => {
        expect(
            renderAntiMemoryWarningLine({
                ...fields,
                saferAlternative: "use SQLite",
                boundField: (text) => text,
            }),
        ).toContain(" Safer alternative: use SQLite.");
    });

    it("drops the clause when the caller's bounding empties the field", () => {
        const line = renderAntiMemoryWarningLine({
            ...fields,
            saferAlternative: "   ",
            boundField: (text) => text.trim(),
        });
        expect(line).not.toContain("Safer alternative");
        expect(line).not.toContain(": .");
    });
});
