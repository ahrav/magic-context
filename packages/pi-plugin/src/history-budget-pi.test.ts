import { describe, expect, test } from "bun:test";
import { resolveHistoryBudgetTokensForPi } from "./context-handler";

/**
 * `usageContextLimit` takes precedence even when `usagePercentage` is 0.
 */

const ONE_M = 1_000_000;

describe("resolveHistoryBudgetTokensForPi", () => {
	test("uses usageContextLimit at percentage=0 (cold first pass)", () => {
		const budget = resolveHistoryBudgetTokensForPi({
			historyBudgetPercentage: 0.15,
			usagePercentage: 0,
			usageInputTokens: 0,
			usageContextLimit: ONE_M,
			executeThresholdPercentage: 65,
			executeThresholdTokens: undefined,
			modelKey: "anthropic/claude-opus-4-8",
		});
		expect(budget).toBe(Math.floor(ONE_M * 0.65 * 0.15));
		expect(budget).toBeGreaterThan(90_000);
	});

	test("falls back to live back-derivation when no contextWindow", () => {
		const budget = resolveHistoryBudgetTokensForPi({
			historyBudgetPercentage: 0.15,
			usagePercentage: 40,
			usageInputTokens: 200_000,
			usageContextLimit: undefined,
			executeThresholdPercentage: 65,
			executeThresholdTokens: undefined,
			modelKey: undefined,
		});
		expect(budget).toBe(Math.floor(500_000 * 0.65 * 0.15));
	});

	test("bails when neither stable limit nor usable live usage", () => {
		expect(
			resolveHistoryBudgetTokensForPi({
				historyBudgetPercentage: 0.15,
				usagePercentage: 0,
				usageInputTokens: 0,
				usageContextLimit: undefined,
				executeThresholdPercentage: 65,
				executeThresholdTokens: undefined,
				modelKey: undefined,
			}),
		).toBeUndefined();
	});

	test("bails when historyBudgetPercentage unset", () => {
		expect(
			resolveHistoryBudgetTokensForPi({
				historyBudgetPercentage: undefined,
				usagePercentage: 0,
				usageInputTokens: 0,
				usageContextLimit: ONE_M,
				executeThresholdPercentage: 65,
				executeThresholdTokens: undefined,
				modelKey: undefined,
			}),
		).toBeUndefined();
	});
});
