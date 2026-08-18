import { describe, expect, it } from "bun:test";
import { estimateTokens as estimateTokensFromHook } from "../hooks/magic-context/read-session-formatting";
import { estimateTokens } from "./token-estimator";

describe("token estimator", () => {
    it("returns 0 for empty text", () => {
        expect(estimateTokens("")).toBe(0);
    });

    it("returns a positive count for ordinary text", () => {
        expect(estimateTokens("bounded search queries")).toBeGreaterThan(0);
    });

    it("counts literal special-token strings without throwing", () => {
        expect(
            estimateTokens("tool output contains <EOT> and <|endoftext|> literally"),
        ).toBeGreaterThan(0);
    });

    it("is monotone for repeated text", () => {
        const once = estimateTokens("hard bounds ");
        const many = estimateTokens("hard bounds ".repeat(100));
        expect(many).toBeGreaterThan(once);
    });

    it("matches the compatibility re-export exactly", () => {
        const samples = [
            "plain words",
            "<EOT> literal special tokens",
            "multibyte — émoji 🎉 text",
            "x".repeat(5000),
        ];
        for (const sample of samples) {
            expect(estimateTokensFromHook(sample)).toBe(estimateTokens(sample));
        }
    });
});
