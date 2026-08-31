/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import {
    deriveHistorianChunkTokens,
    deriveTriggerBudget,
    resolveHistorianContextLimit,
} from "./derive-budgets";

describe("deriveTriggerBudget", () => {
    it("scales with main_context × execute_threshold × 0.05", () => {
        expect(deriveTriggerBudget(1_000_000, 40)).toBe(20_000);
        expect(deriveTriggerBudget(200_000, 65)).toBe(6_500);
    });

    it("clamps at max 50K for very large models with high threshold", () => {
        expect(deriveTriggerBudget(1_000_000, 100)).toBe(50_000);
        expect(deriveTriggerBudget(2_000_000, 80)).toBe(50_000);
    });

    it("clamps at min 5K for small models", () => {
        expect(deriveTriggerBudget(128_000, 65)).toBe(5_000);
        expect(deriveTriggerBudget(32_000, 40)).toBe(5_000);
    });

    it("handles invalid inputs defensively", () => {
        expect(deriveTriggerBudget(0, 40)).toBe(5_000);
        expect(deriveTriggerBudget(-1, 40)).toBe(5_000);
        expect(deriveTriggerBudget(Number.NaN, 40)).toBe(5_000);
        expect(deriveTriggerBudget(128_000, -10)).toBe(5_000);
        // deriveTriggerBudget does not clamp executeThresholdPercentage above 100%.
        // The 50K maximum bounds budgets from thresholds above 100%.
        expect(deriveTriggerBudget(128_000, 200)).toBe(12_800); // 128K × 200% × 5%
    });

    it("preserves ~15% of usable as tail_size threshold for the workload baseline", () => {
        const budget = deriveTriggerBudget(1_000_000, 40);
        const tailSize = budget * 3;
        const usable = 1_000_000 * 0.4;
        expect(tailSize).toBe(60_000);
        expect(tailSize / usable).toBeCloseTo(0.15, 2);
    });

    it("fixes the 128K overflow case by lowering tail_size % of usable", () => {
        const budget = deriveTriggerBudget(128_000, 65);
        const tailSize = budget * 3;
        const usable = 128_000 * 0.65;
        expect(tailSize / usable).toBeLessThan(0.25);
    });
});

describe("deriveHistorianChunkTokens", () => {
    it("scales with historian_context × 0.25", () => {
        expect(deriveHistorianChunkTokens(128_000)).toBe(32_000);
        expect(deriveHistorianChunkTokens(200_000)).toBe(50_000);
    });

    it("clamps at max 50K for huge historian models", () => {
        expect(deriveHistorianChunkTokens(400_000)).toBe(50_000);
        expect(deriveHistorianChunkTokens(1_000_000)).toBe(50_000);
    });

    it("clamps at min 8K for very small historian models", () => {
        expect(deriveHistorianChunkTokens(16_000)).toBe(8_000);
    });

    it("handles invalid inputs defensively", () => {
        expect(deriveHistorianChunkTokens(0)).toBe(8_000);
        expect(deriveHistorianChunkTokens(-1)).toBe(8_000);
        expect(deriveHistorianChunkTokens(Number.NaN)).toBe(8_000);
    });
});

describe("resolveHistorianContextLimit", () => {
    it("returns a positive context limit with no override (scans fallback chain)", () => {
        const limit = resolveHistorianContextLimit();
        expect(limit).toBeGreaterThan(0);
        expect(limit).toBeLessThanOrEqual(1_000_000);
    });

    it("returns a positive context limit for an explicit provider/model override", () => {
        const limit = resolveHistorianContextLimit("anthropic/claude-sonnet-4-6");
        expect(limit).toBeGreaterThan(0);
        expect(Number.isFinite(limit)).toBe(true);
    });

    it("falls through to chain for provider-less override and returns a positive value", () => {
        const originalWarn = console.warn;
        let warnedWith: string | undefined;
        console.warn = (msg: unknown) => {
            warnedWith = typeof msg === "string" ? msg : String(msg);
        };
        try {
            const limit = resolveHistorianContextLimit("llama3-32k");
            expect(limit).toBeGreaterThan(0);
            expect(warnedWith).toContain("llama3-32k");
        } finally {
            console.warn = originalWarn;
        }
    });
});
