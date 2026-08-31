import { describe, expect, test } from "bun:test";
import { resolveHistoryBudgetTokens } from "./transform";

/**
 *
 * When percentage and inputTokens are both 0, live-usage back-derivation cannot determine a context limit.
 *
 * The resolver uses the resolved context limit when percentage is 0.
 */

const HALF_M = 1_000_000;

describe("resolveHistoryBudgetTokens", () => {
    test("uses resolved context limit at percentage=0 (cold first pass)", () => {
        const budget = resolveHistoryBudgetTokens(
            0.15,
            { percentage: 0, inputTokens: 0 },
            65,
            "anthropic/claude-opus-4-8",
            undefined,
            HALF_M,
        );
        expect(budget).toBe(Math.floor(HALF_M * 0.65 * 0.15));
        expect(budget).toBeGreaterThan(90_000);
    });

    test("resolved limit wins even when live usage IS present (behavior-preserving)", () => {
        const resolved = resolveHistoryBudgetTokens(
            0.15,
            { percentage: 20, inputTokens: 200_000 }, // back-derives to 1M too
            65,
            "anthropic/claude-opus-4-8",
            undefined,
            HALF_M,
        );
        expect(resolved).toBe(Math.floor(HALF_M * 0.65 * 0.15));
    });

    test("falls back to live-usage back-derivation when no resolved limit", () => {
        const budget = resolveHistoryBudgetTokens(
            0.15,
            { percentage: 40, inputTokens: 200_000 },
            65,
            undefined,
            undefined,
            0,
        );
        expect(budget).toBe(Math.floor(500_000 * 0.65 * 0.15));
    });

    test("returns undefined when no budget signal at all (cold + no limit)", () => {
        expect(
            resolveHistoryBudgetTokens(
                0.15,
                { percentage: 0, inputTokens: 0 },
                65,
                undefined,
                undefined,
                0,
            ),
        ).toBeUndefined();
    });

    test("returns undefined when historyBudgetPercentage is unset", () => {
        expect(
            resolveHistoryBudgetTokens(
                undefined,
                { percentage: 0, inputTokens: 0 },
                65,
                undefined,
                undefined,
                HALF_M,
            ),
        ).toBeUndefined();
    });

    test("rejects non-finite resolved limit and bails when no usable fallback", () => {
        expect(
            resolveHistoryBudgetTokens(
                0.15,
                { percentage: 0, inputTokens: 0 },
                65,
                undefined,
                undefined,
                Number.NaN,
            ),
        ).toBeUndefined();
    });
});
