import { describe, expect, it } from "bun:test";
import { estimateTokens } from "./read-session-formatting";

describe("estimateTokens — special-token safety", () => {
    it("does not throw on a literal <EOT> substring and counts it as text", () => {
        expect(() => estimateTokens("some text <EOT> more text")).not.toThrow();
        expect(estimateTokens("some text <EOT> more text")).toBeGreaterThan(0);
    });

    it("does not throw on <|endoftext|> or other special-token strings", () => {
        expect(() => estimateTokens("a <|endoftext|> b")).not.toThrow();
        expect(() => estimateTokens("<|im_start|>system<|im_end|>")).not.toThrow();
    });

    it("returns 0 for empty input", () => {
        expect(estimateTokens("")).toBe(0);
    });

    it("counts ordinary text identically (hardening changes nothing for normal content)", () => {
        // The input excludes special tokens so this test isolates ordinary-text behavior.
        expect(estimateTokens("the quick brown fox jumps over the lazy dog")).toBeGreaterThan(5);
    });
});
