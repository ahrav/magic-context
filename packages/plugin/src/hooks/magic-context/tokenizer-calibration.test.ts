import { describe, expect, it } from "bun:test";
import {
    calibrateBuckets,
    type ModelCalibration,
    resolveModelCalibration,
} from "./tokenizer-calibration";

const NEUTRAL: ModelCalibration = { systemRatio: 1.0, toolsRatio: 1.0 };

describe("resolveModelCalibration", () => {
    it("returns neutral ratios for unknown models", () => {
        const calib = resolveModelCalibration("brand-new-provider", "weird-model-99");
        expect(calib.systemRatio).toBe(1.0);
        expect(calib.toolsRatio).toBe(1.0);
    });

    it("returns neutral when provider or model is missing", () => {
        expect(resolveModelCalibration(undefined, "x")).toEqual(NEUTRAL);
        expect(resolveModelCalibration("y", undefined)).toEqual(NEUTRAL);
    });

    it("matches Anthropic Opus 4.7 outlier ratios", () => {
        const calib = resolveModelCalibration("anthropic", "claude-opus-4-7");
        expect(calib.systemRatio).toBeCloseTo(1.51, 2);
        expect(calib.toolsRatio).toBeCloseTo(1.57, 2);
    });

    it("matches Claude 4.5/4.6 family within range", () => {
        const cases = [
            ["anthropic", "claude-opus-4-5"],
            ["anthropic", "claude-sonnet-4-5"],
            ["anthropic", "claude-haiku-4-5"],
            ["anthropic", "claude-sonnet-4-6"],
        ];
        for (const [provider, model] of cases) {
            const calib = resolveModelCalibration(provider, model);
            expect(calib.systemRatio).toBeCloseTo(1.02, 2);
            expect(calib.toolsRatio).toBeGreaterThanOrEqual(1.14);
            expect(calib.toolsRatio).toBeLessThanOrEqual(1.16);
        }
    });

    it("matches GPT-5.x family across all variants", () => {
        const cases = ["gpt-5", "gpt-5.4", "gpt-5.4-codex", "gpt-5.5", "gpt-5.3-codex"];
        for (const model of cases) {
            const calib = resolveModelCalibration("openai", model);
            expect(calib.systemRatio).toBe(1.0);
            expect(calib.toolsRatio).toBeCloseTo(0.84, 2);
        }
    });

    it("is case-insensitive", () => {
        const lower = resolveModelCalibration("anthropic", "claude-opus-4-7");
        const upper = resolveModelCalibration("Anthropic", "Claude-Opus-4-7");
        expect(upper).toEqual(lower);
    });

    it("uses longest prefix match", () => {
        // `claude-opus-4-7` takes precedence over the generic `anthropic/claude` prefix.
        const opus47 = resolveModelCalibration("anthropic", "claude-opus-4-7");
        const opus45 = resolveModelCalibration("anthropic", "claude-opus-4-5");
        expect(opus47.systemRatio).not.toBe(opus45.systemRatio);
    });

    it("matches Opus 4.7 routed via OpenRouter and GitHub Copilot (regression: A2)", () => {
        // Without `openrouter/anthropic` and `github-copilot` prefixes, the matcher falls through to `NEUTRAL`.
        const cases = [
            ["openrouter/anthropic", "claude-opus-4-7"],
            ["openrouter/anthropic", "claude-opus-4.7"],
            ["github-copilot", "claude-opus-4-7"],
            ["github-copilot", "claude-opus-4.7"],
        ];
        for (const [provider, model] of cases) {
            const calib = resolveModelCalibration(provider, model);
            expect(calib.systemRatio).toBeCloseTo(1.51, 2);
            expect(calib.toolsRatio).toBeCloseTo(1.57, 2);
        }
    });
});

describe("calibrateBuckets", () => {
    it("returns all zeros when inputTokens is 0", () => {
        const out = calibrateBuckets({
            inputTokens: 0,
            systemLocal: 1000,
            toolDefsLocal: 500,
            compartmentsLocal: 100,
            factsLocal: 0,
            memoriesLocal: 0,
            docsLocal: 0,
            profileLocal: 0,
            conversationLocal: 200,
            toolCallsLocal: 50,
            calibration: NEUTRAL,
        });
        expect(out.systemTokens).toBe(0);
        expect(out.toolDefinitionTokens).toBe(0);
        expect(out.compartmentTokens).toBe(0);
        expect(out.conversationTokens).toBe(0);
        expect(out.toolCallTokens).toBe(0);
    });

    it("sums to exactly inputTokens with neutral calibration", () => {
        const out = calibrateBuckets({
            inputTokens: 100_000,
            systemLocal: 16_000,
            toolDefsLocal: 21_000,
            compartmentsLocal: 80_000,
            factsLocal: 50,
            memoriesLocal: 0,
            docsLocal: 0,
            profileLocal: 0,
            conversationLocal: 30_000,
            toolCallsLocal: 60_000,
            calibration: NEUTRAL,
        });
        const sum =
            out.systemTokens +
            out.toolDefinitionTokens +
            out.compartmentTokens +
            out.factTokens +
            out.memoryTokens +
            out.conversationTokens +
            out.toolCallTokens;
        expect(sum).toBe(100_000);
    });

    it("applies system_ratio and tools_ratio to calibrated buckets", () => {
        // Only calibrated buckets use calibration ratios; verbatim buckets retain local counts and residual buckets receive the remainder.
        const out = calibrateBuckets({
            inputTokens: 50_000,
            systemLocal: 10_000,
            toolDefsLocal: 0,
            compartmentsLocal: 0,
            factsLocal: 0,
            memoriesLocal: 0,
            docsLocal: 0,
            profileLocal: 0,
            conversationLocal: 30_000,
            toolCallsLocal: 0,
            calibration: { systemRatio: 2.0, toolsRatio: 1.0 },
        });
        expect(out.systemTokens).toBe(20_000);
        expect(out.conversationTokens).toBe(30_000);
        expect(out.systemTokens + out.conversationTokens).toBe(50_000);
    });

    it("keeps verbatim buckets at local count and absorbs residual into conversation/tool calls", () => {
        const out = calibrateBuckets({
            inputTokens: 10_000,
            systemLocal: 1_000,
            toolDefsLocal: 500,
            compartmentsLocal: 1_000,
            factsLocal: 500,
            memoriesLocal: 0,
            docsLocal: 0,
            profileLocal: 0,
            conversationLocal: 2_000,
            toolCallsLocal: 500,
            calibration: NEUTRAL,
        });
        // Neutral calibration leaves calibrated buckets at local counts.
        expect(out.systemTokens).toBe(1_000);
        expect(out.toolDefinitionTokens).toBe(500);
        // Verbatim buckets equal local input exactly.
        expect(out.compartmentTokens).toBe(1_000);
        expect(out.factTokens).toBe(500);
        expect(out.memoryTokens).toBe(0);
        // Residual buckets absorb the remainder in proportion to their local counts.
        expect(out.conversationTokens).toBeGreaterThanOrEqual(5_590);
        expect(out.conversationTokens).toBeLessThanOrEqual(5_610);
        expect(out.toolCallTokens).toBeGreaterThanOrEqual(1_390);
        expect(out.toolCallTokens).toBeLessThanOrEqual(1_410);
        const sum =
            out.systemTokens +
            out.toolDefinitionTokens +
            out.compartmentTokens +
            out.factTokens +
            out.memoryTokens +
            out.conversationTokens +
            out.toolCallTokens;
        expect(sum).toBe(10_000);
    });

    it("parks the full remainder in conversation when residual local sum is 0", () => {
        // With no conversation content, conversationTokens absorbs the full remainder.
        const out = calibrateBuckets({
            inputTokens: 50_000,
            systemLocal: 16_000,
            toolDefsLocal: 21_000,
            compartmentsLocal: 0,
            factsLocal: 0,
            memoriesLocal: 0,
            docsLocal: 0,
            profileLocal: 0,
            conversationLocal: 0,
            toolCallsLocal: 0,
            calibration: NEUTRAL,
        });
        expect(out.systemTokens).toBe(16_000);
        expect(out.toolDefinitionTokens).toBe(21_000);
        expect(out.compartmentTokens).toBe(0);
        expect(out.factTokens).toBe(0);
        expect(out.memoryTokens).toBe(0);
        expect(out.conversationTokens).toBe(13_000);
        expect(out.toolCallTokens).toBe(0);
    });

    it("clamps non-residual buckets when calibrated + verbatim exceeds inputTokens", () => {
        // When scaled stable and verbatim buckets exceed `inputTokens`, all nonzero buckets scale down proportionally.
        // When stable and verbatim totals exceed `inputTokens`, all nonzero buckets scale down proportionally.
        // stay 0.
        const out = calibrateBuckets({
            inputTokens: 1_000,
            systemLocal: 800,
            toolDefsLocal: 800,
            compartmentsLocal: 100,
            factsLocal: 0,
            memoriesLocal: 0,
            docsLocal: 0,
            profileLocal: 0,
            conversationLocal: 100,
            toolCallsLocal: 0,
            calibration: { systemRatio: 5.0, toolsRatio: 5.0 },
        });
        const sum =
            out.systemTokens +
            out.toolDefinitionTokens +
            out.compartmentTokens +
            out.factTokens +
            out.memoryTokens +
            out.conversationTokens +
            out.toolCallTokens;
        expect(sum).toBeLessThanOrEqual(1_000);
        expect(sum).toBe(1_000);
    });

    it("tiny inputTokens with clamp path: still sums exactly (regression: Oracle final review)", () => {
        // When a rounding overshoot exceeds one residual bucket, correction decrements non-residual buckets in descending token-count order until `delta` is zero.
        const out = calibrateBuckets({
            inputTokens: 2,
            systemLocal: 1,
            toolDefsLocal: 1,
            compartmentsLocal: 2,
            factsLocal: 2,
            memoriesLocal: 0,
            docsLocal: 0,
            profileLocal: 0,
            conversationLocal: 1,
            toolCallsLocal: 0,
            calibration: { systemRatio: 1.51, toolsRatio: 1.57 },
        });
        const sum =
            out.systemTokens +
            out.toolDefinitionTokens +
            out.compartmentTokens +
            out.factTokens +
            out.memoryTokens +
            out.conversationTokens +
            out.toolCallTokens;
        expect(sum).toBe(2);
        // No bucket goes negative.
        for (const v of [
            out.systemTokens,
            out.toolDefinitionTokens,
            out.compartmentTokens,
            out.factTokens,
            out.memoryTokens,
            out.conversationTokens,
            out.toolCallTokens,
        ]) {
            expect(v).toBeGreaterThanOrEqual(0);
        }
    });

    it("clamp + zero residuals: rounding overshoot does NOT exceed inputTokens (regression: A1)", () => {
        // When calibrated stable totals exceed `inputTokens` and residual local counts are zero, residual buckets cannot absorb a negative delta.
        // Rounding calibrated buckets can overshoot `inputTokens`.
        const out = calibrateBuckets({
            inputTokens: 1_000,
            systemLocal: 500,
            toolDefsLocal: 500,
            compartmentsLocal: 500,
            factsLocal: 0,
            memoriesLocal: 0,
            docsLocal: 0,
            profileLocal: 0,
            conversationLocal: 0,
            toolCallsLocal: 0,
            calibration: { systemRatio: 5.0, toolsRatio: 5.0 },
        });
        const sum =
            out.systemTokens +
            out.toolDefinitionTokens +
            out.compartmentTokens +
            out.factTokens +
            out.memoryTokens +
            out.conversationTokens +
            out.toolCallTokens;
        // Final sum equals inputTokens.
        expect(sum).toBe(1_000);
        // Residual buckets with zero local counts stay zero.
        expect(out.conversationTokens).toBe(0);
        expect(out.toolCallTokens).toBe(0);
        expect(out.systemTokens).toBeGreaterThanOrEqual(0);
        expect(out.toolDefinitionTokens).toBeGreaterThanOrEqual(0);
        expect(out.compartmentTokens).toBeGreaterThanOrEqual(0);
    });

    it("real-world Opus 4.7 example: verbatim history matches /ctx-status, residual absorbs drift", () => {
        const out = calibrateBuckets({
            inputTokens: 378_000,
            systemLocal: 16_500,
            toolDefsLocal: 21_400,
            compartmentsLocal: 89_000,
            factsLocal: 50,
            memoriesLocal: 8_000,
            docsLocal: 0,
            profileLocal: 0,
            conversationLocal: 40_000,
            toolCallsLocal: 68_000,
            calibration: { systemRatio: 1.51, toolsRatio: 1.57 },
        });
        // Calibrated buckets.
        expect(out.systemTokens).toBe(Math.round(16_500 * 1.51));
        expect(out.toolDefinitionTokens).toBe(Math.round(21_400 * 1.57));
        // Verbatim buckets retain exact local counts without scaling.
        expect(out.compartmentTokens).toBe(89_000);
        expect(out.factTokens).toBe(50);
        expect(out.memoryTokens).toBe(8_000);
        // conversationTokens and toolCallTokens absorb the residual.
        expect(out.conversationTokens).toBeGreaterThan(70_000);
        expect(out.toolCallTokens).toBeGreaterThan(120_000);
        const sum =
            out.systemTokens +
            out.toolDefinitionTokens +
            out.compartmentTokens +
            out.factTokens +
            out.memoryTokens +
            out.conversationTokens +
            out.toolCallTokens;
        expect(sum).toBe(378_000);
    });

    it("docs + profile are verbatim buckets that come OUT of the residual (not Conversation)", () => {
        // `<project-docs>` and `<user-profile>` use separate buckets instead of Conversation.
        const base = {
            inputTokens: 200_000,
            systemLocal: 5_000,
            toolDefsLocal: 5_000,
            compartmentsLocal: 60_000,
            factsLocal: 0,
            memoriesLocal: 10_000,
            conversationLocal: 40_000,
            toolCallsLocal: 20_000,
            calibration: { systemRatio: 1, toolsRatio: 1 },
        };
        const without = calibrateBuckets({ ...base, docsLocal: 0, profileLocal: 0 });
        const withDocs = calibrateBuckets({ ...base, docsLocal: 20_000, profileLocal: 2_000 });

        // Verbatim buckets retain exact local counts without scaling.
        expect(withDocs.docsTokens).toBe(20_000);
        expect(withDocs.profileTokens).toBe(2_000);
        // docsLocal and profileLocal reduce the residual available to conversationTokens and toolCallTokens.
        expect(withDocs.conversationTokens).toBeLessThan(without.conversationTokens);
        // All buckets sum exactly to inputTokens.
        const sum =
            withDocs.systemTokens +
            withDocs.toolDefinitionTokens +
            withDocs.compartmentTokens +
            withDocs.factTokens +
            withDocs.memoryTokens +
            withDocs.docsTokens +
            withDocs.profileTokens +
            withDocs.conversationTokens +
            withDocs.toolCallTokens;
        expect(sum).toBe(200_000);
    });
});
