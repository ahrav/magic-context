
import { describe, expect, it } from "bun:test";
import { enforceProtectedRegions, extractProtectedBlocks } from "./protected-regions";

const START = "<!-- mc:protected START — hand-authored cache-stability core. Only humans edit. -->";
const END = "<!-- mc:protected END -->";

function doc(outsideBefore: string, protectedBody: string, outsideAfter: string): string {
    return `${outsideBefore}\n${START}\n${protectedBody}\n${END}\n${outsideAfter}`;
}

describe("extractProtectedBlocks", () => {
    it("returns empty when no markers", () => {
        expect(extractProtectedBlocks("# Hello\n\nWorld")).toEqual([]);
    });
});

describe("enforceProtectedRegions", () => {
    it("identical protected region → no change, violated:false", () => {
        const original = doc("intro", "cache core", "outro");
        const candidate = doc("intro", "cache core", "outro");
        const result = enforceProtectedRegions(original, candidate);
        expect(result).toEqual({ text: candidate, violated: false });
    });

    it("edited text outside the region + untouched region → keeps edits, violated:false", () => {
        const original = doc("intro", "cache core", "outro");
        const candidate = doc("intro v2", "cache core", "outro v2");
        const result = enforceProtectedRegions(original, candidate);
        expect(result.violated).toBe(false);
        expect(result.text).toBe(candidate);
        expect(result.text).toContain("intro v2");
        expect(result.text).toContain("outro v2");
    });

    it("altered protected region → restored byte-identical, violated:true, surrounding edits preserved", () => {
        const original = doc("intro", "cache core", "outro");
        const candidate = doc("intro v2", "cache CORE", "outro v2");
        const result = enforceProtectedRegions(original, candidate);
        expect(result.violated).toBe(true);
        expect(result.text).toContain("intro v2");
        expect(result.text).toContain("outro v2");
        expect(result.text).toContain("cache core");
        expect(result.text).not.toContain("cache CORE");
        const origBlock = extractProtectedBlocks(original)[0]?.block;
        const resultBlock = extractProtectedBlocks(result.text)[0]?.block;
        expect(resultBlock).toBe(origBlock);
    });

    it("deleted protected markers → whole candidate rejected, returns original, violated:true", () => {
        const original = doc("intro", "cache core", "outro");
        const candidate = "intro v2\nno markers\noutro v2";
        const result = enforceProtectedRegions(original, candidate);
        expect(result).toEqual({ text: original, violated: true });
    });

    it("no protected region in original → candidate passed through unchanged", () => {
        const original = "# STRUCTURE\n\nNo protected blocks here.";
        const candidate = "# STRUCTURE\n\nUpdated tree.";
        const result = enforceProtectedRegions(original, candidate);
        expect(result).toEqual({ text: candidate, violated: false });
    });

    it("multiple protected blocks → each matched by start-marker identity and independently enforced", () => {
        const startA = "<!-- mc:protected START block A -->";
        const startB = "<!-- mc:protected START block B -->";
        const original = ["head", startA, "body A", END, "mid", startB, "body B", END, "tail"].join(
            "\n",
        );

        const candidate = [
            "head edited",
            startA,
            "body A TAMPERED",
            END,
            "mid edited",
            startB,
            "body B",
            END,
            "tail edited",
        ].join("\n");

        const result = enforceProtectedRegions(original, candidate);
        expect(result.violated).toBe(true);
        expect(result.text).toContain("head edited");
        expect(result.text).toContain("mid edited");
        expect(result.text).toContain("body A\n");
        expect(result.text).not.toContain("body A TAMPERED");
        expect(extractProtectedBlocks(result.text)[0]?.block).toBe(
            extractProtectedBlocks(original)[0]?.block,
        );
        expect(extractProtectedBlocks(result.text)[1]?.block).toBe(
            extractProtectedBlocks(original)[1]?.block,
        );
    });

    it("missing one of multiple blocks → rejects whole candidate", () => {
        const startA = "<!-- mc:protected START block A -->";
        const startB = "<!-- mc:protected START block B -->";
        const original = [startA, "a", END, "x", startB, "b", END].join("\n");
        const candidate = [startA, "a", END, "x only one block"].join("\n");
        const result = enforceProtectedRegions(original, candidate);
        expect(result).toEqual({ text: original, violated: true });
    });
});
