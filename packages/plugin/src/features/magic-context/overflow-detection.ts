import type { ContextLimitProvenance } from "../../shared/context-limit-provenance";

/**
 *
 *      turn fits.
 *
 * We copy OpenCode's BSD-licensed logic to avoid coupling the plugin to OpenCode versions.
 *
 * References:
 *     https://github.com/sst/opencode/blob/main/packages/opencode/src/provider/error.ts
 *     https://github.com/earendil-works/pi-mono/blob/main/packages/ai/src/utils/overflow.ts
 */

/**
 * emerge.
 */
export const OVERFLOW_PATTERNS: ReadonlyArray<RegExp> = [
    /prompt is too long/i, // Anthropic
    /input is too long for requested model/i, // Amazon Bedrock
    /exceeds the context window/i, // OpenAI (Completions + Responses API)
    /input token count.*exceeds the maximum/i, // Google Gemini
    /maximum prompt length is \d+/i, // xAI (Grok)
    /reduce the length of the messages/i, // Groq
    /maximum context length is \d+ tokens/i, // OpenRouter, DeepSeek, vLLM
    /maximum model length is \d+/i, // vLLM
    /exceeds the limit of \d+/i, // GitHub Copilot
    /exceeds the available context size/i, // llama.cpp server
    /greater than the context length/i, // LM Studio
    /context window exceeds limit/i, // MiniMax
    /exceeded model token limit/i, // Kimi For Coding, Moonshot
    /context[_ ]length[_ ]exceeded/i, // Generic fallback
    /request entity too large/i, // HTTP 413
    /context length is only \d+ tokens/i, // vLLM
    /input length.*exceeds.*context length/i, // vLLM
    /prompt too long; exceeded (?:max )?context length/i, // Ollama explicit overflow
    /too large for model with \d+ maximum context length/i, // Mistral
    /model_context_window_exceeded/i, // z.ai non-standard finish_reason
    /context size has been exceeded/i, // Lemonade / llama-cpp wrappers
];

/**
 * Each pattern's first capture group is the numeric token limit.
 *
 * The caller can still use the overflow signal when no numeric limit is available.
 */
interface LimitExtractionPattern {
    pattern: RegExp;
    provenance: ContextLimitProvenance;
}

const LIMIT_EXTRACTION_PATTERNS: ReadonlyArray<LimitExtractionPattern> = [
    { pattern: /maximum prompt length is (\d+)/i, provenance: "prompt_only" }, // xAI
    {
        pattern: /maximum context length is (\d+) tokens?/i,
        provenance: "combined",
    }, // OpenAI / OpenRouter / DeepSeek / vLLM
    { pattern: /maximum model length is (\d+)/i, provenance: "combined" }, // vLLM
    { pattern: /context length is only (\d+) tokens?/i, provenance: "combined" }, // vLLM
    { pattern: /exceeds the limit of (\d+)/i, provenance: "unknown" }, // GitHub Copilot
    {
        pattern: /too large for model with (\d+) maximum context length/i,
        provenance: "combined",
    }, // Mistral
    // Limit the gap to 40 non-digits so the capture selects the first four-or-more-digit token count.
    // An unbounded `.*` gap can skip the intended token count.
    { pattern: /context size[^0-9]{0,40}(\d{4,})\s*tokens?/i, provenance: "combined" }, // llama.cpp variants
    // Capture the context limit rather than the prompt size.
    // The explicit pattern prevents the fallback from extracting the prompt size.
    { pattern: /exceeds? the context length of (\d+)/i, provenance: "combined" }, // vLLM overflow
    {
        pattern: />\s*(\d+)\s*(?:tokens?\s*)?(?:maximum|max|limit)\b/i,
        provenance: "prompt_only",
    }, // Anthropic reports the accepted input ceiling, not input plus output.
    { pattern: /max(?:imum)?.*context.*?(\d+)/i, provenance: "unknown" }, // generic fallback
];

/**
 * Reject limits below 1024 to avoid unrelated numeric fields such as error codes.
 * */
const MIN_PLAUSIBLE_LIMIT = 1024;
/**
 * Reject larger values to avoid matching token-count fields instead of limits. */
const MAX_PLAUSIBLE_LIMIT = 10_000_000;

export interface ReportedContextLimit {
    value: number;
    provenance: ContextLimitProvenance;
}

export interface OverflowDetection {
    /* */
    isOverflow: boolean;
    /* */
    reportedLimit?: number;
    /** The provenance identifies whether the limit covers the prompt alone or the combined context window. */
    reportedLimitProvenance?: ContextLimitProvenance;
    /* */
    matchedPattern?: string;
}

/**
 * OpenCode events deliver errors as strings, Error instances, or objects with `message`.
 */
export function extractErrorMessage(error: unknown): string {
    if (!error) return "";
    if (typeof error === "string") return error;
    // Checking `error.error.message` first preserves nested provider error messages.
    if (typeof error === "object") {
        const obj = error as Record<string, unknown>;
        const nested = obj.error as Record<string, unknown> | undefined;
        if (nested && typeof nested.message === "string" && nested.message.length > 0) {
            return nested.message;
        }
    }
    if (error instanceof Error) return error.message;
    if (typeof error === "object") {
        const obj = error as Record<string, unknown>;
        if (typeof obj.message === "string") return obj.message;
        if (typeof obj.responseBody === "string") return obj.responseBody;
        try {
            return JSON.stringify(error);
        } catch {
            return String(error);
        }
    }
    return String(error);
}

/**
 */
export function detectOverflow(error: unknown): OverflowDetection {
    const message = extractErrorMessage(error);
    if (!message) {
        return { isOverflow: false };
    }

    const hasStatus413 =
        /\b413\b/.test(message) && /(entity|payload|context|prompt)/i.test(message);

    let matched: RegExp | undefined;
    for (const pattern of OVERFLOW_PATTERNS) {
        if (pattern.test(message)) {
            matched = pattern;
            break;
        }
    }

    if (!matched && !hasStatus413) {
        return { isOverflow: false };
    }

    const reportedLimit = parseReportedLimit(message);

    return {
        isOverflow: true,
        reportedLimit: reportedLimit?.value,
        reportedLimitProvenance: reportedLimit?.provenance,
        matchedPattern: matched?.source,
    };
}

/**
 */
export function parseReportedLimit(message: string): ReportedContextLimit | undefined {
    if (!message) return undefined;
    for (const { pattern, provenance } of LIMIT_EXTRACTION_PATTERNS) {
        const match = message.match(pattern);
        if (!match) continue;
        const raw = match[1];
        if (!raw) continue;
        const value = Number.parseInt(raw, 10);
        if (!Number.isFinite(value)) continue;
        if (value < MIN_PLAUSIBLE_LIMIT || value > MAX_PLAUSIBLE_LIMIT) continue;
        return { value, provenance };
    }
    return undefined;
}
