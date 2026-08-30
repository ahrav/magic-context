import { describe, expect, it } from "bun:test";
import { cosineSimilarity } from "./cosine-similarity";

describe("cosine similarity", () => {
    it("returns 1 for identical vectors", () => {
        //#when
        const similarity = cosineSimilarity(
            new Float32Array([1, 2, 3]),
            new Float32Array([1, 2, 3]),
        );

        //#then
        expect(similarity).toBe(1);
    });

    it("returns 0 for orthogonal vectors", () => {
        //#when
        const similarity = cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]));

        //#then
        expect(similarity).toBe(0);
    });

    it("returns -1 for opposite vectors", () => {
        //#when
        const similarity = cosineSimilarity(new Float32Array([1, 0]), new Float32Array([-1, 0]));

        //#then
        expect(similarity).toBe(-1);
    });

    it("handles zero vectors gracefully", () => {
        //#when
        const similarity = cosineSimilarity(
            new Float32Array([0, 0, 0]),
            new Float32Array([0, 0, 0]),
        );

        //#then
        expect(similarity).toBe(0);
    });

    it("handles different length vectors", () => {
        //#when
        const similarity = cosineSimilarity(new Float32Array([1, 2, 3]), new Float32Array([1, 2]));

        //#then
        expect(similarity).toBe(0);
    });
});
