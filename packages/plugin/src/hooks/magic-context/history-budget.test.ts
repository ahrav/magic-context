import { describe, expect, test } from "bun:test";
import { resolveHistoryBudgetTokens } from "./transform";

/**
 * Regression coverage for the history-budget resolver.
 *
 * The failure mode is wire-confirmed: on the FIRST transform pass after a
 * restart, live usage is percentage=0 / inputTokens=0. The resolver used to
 * back-derive the context limit as inputTokens/(percentage/100) → 0/0 → bail
 * (undefined), and the caller fell through to the hard-coded 60K default. When
 * a re-materialize was forced on that same pass (m[1] cache cleared by the v26
 * migration), the decay renderer archived the oldest compartments to fit 60K
 * for a 1M-context model whose real history budget is ~98K, then stuck there
 * via cache_hit replay (337K→209K history chars).
 *
 * Fix: derive the budget from the model's STABLE resolved context limit
 * (resolveContextLimit), available even at percentage=0. The live-usage
 * back-derivation is kept only as a last-resort fallback.
 */

const HALF_M = 1_000_000;

describe("resolveHistoryBudgetTokens", () => {
    test("uses resolved context limit at percentage=0 (cold first pass)", () => {
        // 1M model, executeThreshold 65%, historyBudget 15% → 1M*0.65*0.15 = 97_500
        const budget = resolveHistoryBudgetTokens(
            0.15,
            { percentage: 0, inputTokens: 0 },
            65,
            "anthropic/claude-opus-4-8",
            undefined,
            HALF_M,
        );
        expect(budget).toBe(Math.floor(HALF_M * 0.65 * 0.15));
        // Must NOT collapse to the 60K default the renderer falls back to.
        expect(budget).toBeGreaterThan(90_000);
    });

    test("resolved limit wins even when live usage IS present (behavior-preserving)", () => {
        // At percentage>0, the event handler computed percentage FROM the same
        // resolveContextLimit, so back-derivation and resolved limit agree.
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
        // resolvedContextLimit omitted/0 → use inputTokens/percentage = 500K.
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
