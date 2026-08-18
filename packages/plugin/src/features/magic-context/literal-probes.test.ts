import { describe, expect, it } from "bun:test";
import { containsProbeVerbatim, extractLiteralProbes } from "./literal-probes";

describe("extractLiteralProbes", () => {
    it("returns no probes for plain natural-language prose", () => {
        expect(extractLiteralProbes("why did the tool calls inflate the context")).toEqual([]);
        expect(extractLiteralProbes("how does the cache system avoid busting")).toEqual([]);
    });

    it("extracts slash commands", () => {
        expect(extractLiteralProbes("why did /ctx-status show wrong tool calls")).toContain(
            "/ctx-status",
        );
    });

    it("extracts kebab and snake identifiers", () => {
        const probes = extractLiteralProbes("the git_sweep_coordinator and memory-block-ids logic");
        expect(probes).toContain("git_sweep_coordinator");
        expect(probes).toContain("memory-block-ids");
    });

    it("extracts dotted identifiers / file paths", () => {
        const probes = extractLiteralProbes("look at search.ts and memory.auto_search");
        expect(probes).toContain("search.ts");
        expect(probes).toContain("memory.auto_search");
    });

    it("extracts camelCase identifiers", () => {
        expect(extractLiteralProbes("where is getMessageOrdinal called")).toContain(
            "getMessageOrdinal",
        );
    });

    it("extracts quoted spans and commit shas and error codes", () => {
        expect(extractLiteralProbes('the error said "conversation must end"')).toContain(
            "conversation must end",
        );
        expect(extractLiteralProbes("commit 6e0dc12 broke it")).toContain("6e0dc12");
        expect(extractLiteralProbes("got TS2345 after the change")).toContain("TS2345");
    });

    it("deduplicates case-insensitively and caps at five", () => {
        const probes = extractLiteralProbes(
            "ctx-status ctx-status foo-bar baz-qux a-b c-d e-f g-h",
        );
        expect(probes.length).toBeLessThanOrEqual(5);
        const lowered = probes.map((p) => p.toLowerCase());
        expect(new Set(lowered).size).toBe(lowered.length);
    });

    it("stops accepting matches once the five prioritized slots are full", () => {
        // Five quoted spans claim every slot; the later kebab identifiers and
        // camelCase shapes must not displace or extend them.
        const query =
            '"one span" "two span" "three span" "four span" "five span" "six span" kebab-late camelLate';
        expect(extractLiteralProbes(query)).toEqual([
            "one span",
            "two span",
            "three span",
            "four span",
            "five span",
        ]);
    });

    it("keeps priority order for many mixed shapes", () => {
        const query =
            'run /slash-cmd with "quoted text" then TS9999 plus file.name kebab-case camelCase deadbee1';
        expect(extractLiteralProbes(query)).toEqual([
            "quoted text",
            "/slash-cmd",
            "TS9999",
            "file.name",
            // The kebab shape re-matches the slash command without its slash.
            "slash-cmd",
        ]);
    });

    it("ignores tokens shorter than the minimum", () => {
        // "a-b" is 3 chars (kept); bare short words are not identifiers.
        expect(extractLiteralProbes("go to it")).toEqual([]);
    });
});

describe("containsProbeVerbatim", () => {
    it("matches case-insensitively", () => {
        expect(containsProbeVerbatim("Fixed the /CTX-Status bug", ["/ctx-status"])).toBe(true);
    });
    it("returns false with no probes", () => {
        expect(containsProbeVerbatim("anything", [])).toBe(false);
    });
    it("returns false when no probe appears", () => {
        expect(containsProbeVerbatim("unrelated text", ["getMessageOrdinal"])).toBe(false);
    });
});
