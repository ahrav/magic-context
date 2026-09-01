import { describe, expect, test } from "bun:test";
import type { ContextLimitProvenance } from "../../shared/context-limit-provenance";
import { detectOverflow, extractErrorMessage, parseReportedLimit } from "./overflow-detection";

describe("overflow-detection / extractErrorMessage", () => {
    test("returns message from Error instance", () => {
        expect(extractErrorMessage(new Error("prompt is too long"))).toBe("prompt is too long");
    });

    test("returns raw string", () => {
        expect(extractErrorMessage("context length exceeded")).toBe("context length exceeded");
    });

    test("unwraps nested provider SDK error (error.error.message)", () => {
        const nested = {
            error: { message: "Input token count 200000 exceeds the maximum of 128000" },
        };
        expect(extractErrorMessage(nested)).toContain("exceeds the maximum");
    });

    test("reads top-level message property", () => {
        expect(extractErrorMessage({ message: "prompt is too long" })).toBe("prompt is too long");
    });

    test("reads responseBody fallback", () => {
        expect(extractErrorMessage({ responseBody: "413 payload too large" })).toBe(
            "413 payload too large",
        );
    });

    test("returns empty string for null / undefined", () => {
        expect(extractErrorMessage(null)).toBe("");
        expect(extractErrorMessage(undefined)).toBe("");
    });
});

describe("overflow-detection / detectOverflow", () => {
    // future regex edits can't silently regress provider support.
    test.each<[string, string, number | undefined, ContextLimitProvenance | undefined]>([
        ["anthropic", "prompt is too long: 210000 tokens > 200000 maximum", 200000, "prompt_only"],
        ["bedrock", "Input is too long for requested model.", undefined, undefined],
        ["openai", "This model's maximum context length is 128000 tokens", 128000, "combined"],
        [
            "gemini",
            "Input token count 1234567 exceeds the maximum number of tokens allowed",
            undefined,
            undefined,
        ],
        [
            "xai",
            "the maximum prompt length is 256000 tokens but the prompt was 300000",
            256000,
            "prompt_only",
        ],
        ["groq", "Please reduce the length of the messages or completion", undefined, undefined],
        ["openrouter", "the maximum context length is 32768 tokens", 32768, "combined"],
        ["copilot", "Prompt exceeds the limit of 64000 tokens", 64000, "unknown"],
        ["llamacpp", "Prompt exceeds the available context size", undefined, undefined],
        ["lmstudio", "Prompt greater than the context length of the model", undefined, undefined],
        ["minimax", "context window exceeds limit", undefined, undefined],
        ["moonshot", "exceeded model token limit of 131072", undefined, undefined],
        ["generic", "context_length_exceeded", undefined, undefined],
        ["http413", "413 request entity too large", undefined, undefined],
        ["vllm", "context length is only 4096 tokens, prompt was 5000", 4096, "combined"],
        ["vllm-model", "maximum model length is 8192 tokens", 8192, "combined"],
        ["vllm2", "input length 10000 exceeds the context length of 8000", 8000, "combined"],
        ["ollama", "prompt too long; exceeded max context length", undefined, undefined],
        [
            "mistral",
            "Prompt too large for model with 32768 maximum context length",
            32768,
            "combined",
        ],
        ["zai", "model_context_window_exceeded", undefined, undefined],
        ["lemonade", "Context size has been exceeded", undefined, undefined],
    ])("%s pattern matches overflow", (_provider, message, expectedLimit, expectedProvenance) => {
        const detection = detectOverflow(message);
        expect(detection.isOverflow).toBe(true);
        expect(detection.reportedLimit).toBe(expectedLimit);
        expect(detection.reportedLimitProvenance).toBe(expectedProvenance);
    });

    test("returns not-overflow for unrelated errors", () => {
        expect(detectOverflow("Network error").isOverflow).toBe(false);
        expect(detectOverflow("Rate limit exceeded").isOverflow).toBe(false);
        expect(detectOverflow("Invalid API key").isOverflow).toBe(false);
        expect(detectOverflow("").isOverflow).toBe(false);
        expect(detectOverflow(null).isOverflow).toBe(false);
    });

    test("extracts limit through Error + nested SDK shapes end-to-end", () => {
        const nested = new Error("");
        (nested as Error & { error?: unknown }).error = {
            message: "This model's maximum context length is 128000 tokens",
        };
        const detection = detectOverflow(nested);
        expect(detection.isOverflow).toBe(true);
        expect(detection.reportedLimit).toBe(128000);
        expect(detection.reportedLimitProvenance).toBe("combined");
    });

    test("returns matchedPattern for diagnostics", () => {
        const detection = detectOverflow("prompt is too long: 210000 > 200000");
        expect(detection.isOverflow).toBe(true);
        expect(detection.matchedPattern).toBeDefined();
    });
});

describe("overflow-detection / parseReportedLimit", () => {
    test("extracts from 'maximum prompt length' (xAI)", () => {
        expect(parseReportedLimit("the maximum prompt length is 256000 tokens")).toEqual({
            value: 256000,
            provenance: "prompt_only",
        });
    });

    test("extracts from 'maximum context length' (OpenRouter/DeepSeek)", () => {
        expect(parseReportedLimit("maximum context length is 32768 tokens")).toEqual({
            value: 32768,
            provenance: "combined",
        });
    });

    test("extracts from 'context length is only' (vLLM)", () => {
        expect(parseReportedLimit("context length is only 4096 tokens")).toEqual({
            value: 4096,
            provenance: "combined",
        });
    });

    test("extracts from 'exceeds the limit of' (Copilot)", () => {
        expect(parseReportedLimit("Prompt exceeds the limit of 64000 tokens")).toEqual({
            value: 64000,
            provenance: "unknown",
        });
    });

    test("extracts Anthropic-style '> N maximum|max|limit' caps", () => {
        for (const suffix of ["maximum", "max", "limit"]) {
            expect(
                parseReportedLimit(`prompt is too long: 210000 tokens > 200000 ${suffix}`),
            ).toEqual({ value: 200000, provenance: "prompt_only" });
        }
    });

    test("extracts from 'too large for model with' (Mistral)", () => {
        expect(parseReportedLimit("Too large for model with 32768 maximum context length")).toEqual(
            { value: 32768, provenance: "combined" },
        );
    });

    test("rejects implausibly small numbers (< 1024)", () => {
        // Error codes like "413" should not be mistaken for context limits
        expect(parseReportedLimit("maximum context length is 100 tokens")).toBeUndefined();
    });

    test("rejects implausibly large numbers (> 10M)", () => {
        expect(parseReportedLimit("maximum context length is 999999999 tokens")).toBeUndefined();
    });

    test("returns undefined when no pattern matches", () => {
        expect(parseReportedLimit("Random error message")).toBeUndefined();
        expect(parseReportedLimit("")).toBeUndefined();
    });

    test("returns first plausible match when multiple numbers present", () => {
        const msg = "maximum context length is 128000 tokens (limit 999)";
        expect(parseReportedLimit(msg)).toEqual({ value: 128000, provenance: "combined" });
    });
});

describe("llama.cpp context-size limit extraction", () => {
    // The capture must include the full context-size limit because the plausibility clamp rejects single-digit captures.
    test("extracts the limit from llama.cpp-style messages", () => {
        expect(
            parseReportedLimit(
                "context size has been exceeded: limit 200000 tokens, you sent 214311",
            ),
        ).toMatchObject({ value: 200000, provenance: "combined" });
        expect(parseReportedLimit("context size exceeded: 128000 tokens maximum")).toMatchObject({
            value: 128000,
            provenance: "combined",
        });
    });

    test("does not capture a number more than 40 chars past the phrase", () => {
        // The anchor prevents distant numbers, such as request IDs, from binding.
        expect(
            parseReportedLimit(
                "context size problem occurred while handling the request submitted at position 99999999 tokens",
            ),
        ).toBeUndefined();
    });
});
