/**
 *
 * ai-tokenizer encodings drift from API token counts by model-specific amounts.
 * Calibration ratios are empirically measured and model-specific.
 * `scripts/calibrate-tokenizer/` measures ratios against provider-reported `usage.input_tokens`.
 * The calibration sweep uses a production system prompt, 39 MCP-style tools, and a minimal conversation.
 * The calibration sweep compares local counts with each provider's `usage.input_tokens`.
 *
 * `system_ratio = api_tokens / local_raw_tokens` for plain-text system prompts
 * `tools_ratio  = api_tokens / local_raw_tokens` for the tools array
 *
 * Multiplying the local count by these ratios yields the API's count.
 *
 * Pattern matching: longest prefix wins. Unknown models fall back to 1.0 / 1.0
 * (no calibration).
 */

export interface ModelCalibration {
    systemRatio: number;
    toolsRatio: number;
}

interface CalibrationEntry extends ModelCalibration {
    /** `prefix` matches `${providerID}/${modelID}` case-insensitively; the longest match wins. */
    prefix: string;
}

/**
 */
const CALIBRATION_TABLE: CalibrationEntry[] = [
    // Opus 4.8 uses Opus 4.7's ratios because both use a tokenizer absent from ai-tokenizer's `claude` encoding.
    // Without Opus 4.8 entries, lookup uses 1.0 ratios.
    // The 1.0 fallback undercounts System+ToolDefs and shifts the residual into Conversation.
    { prefix: "anthropic/claude-opus-4-8", systemRatio: 1.51, toolsRatio: 1.57 },
    { prefix: "anthropic/claude-opus-4.8", systemRatio: 1.51, toolsRatio: 1.57 },
    // Anthropic Opus 4.7 — ai-tokenizer's claude encoding lacks its tokenizer,
    // so its empirically-measured ratios are pinned here (the 4.8 rows above
    // reuse them).
    { prefix: "anthropic/claude-opus-4-7", systemRatio: 1.51, toolsRatio: 1.57 },
    { prefix: "anthropic/claude-opus-4.7", systemRatio: 1.51, toolsRatio: 1.57 },
    { prefix: "anthropic/claude-opus-4-5", systemRatio: 1.02, toolsRatio: 1.16 },
    { prefix: "anthropic/claude-opus-4.5", systemRatio: 1.02, toolsRatio: 1.16 },
    { prefix: "anthropic/claude-opus-4-6", systemRatio: 1.02, toolsRatio: 1.16 },
    { prefix: "anthropic/claude-opus-4.6", systemRatio: 1.02, toolsRatio: 1.16 },
    { prefix: "anthropic/claude-sonnet-4-5", systemRatio: 1.02, toolsRatio: 1.16 },
    { prefix: "anthropic/claude-sonnet-4.5", systemRatio: 1.02, toolsRatio: 1.16 },
    { prefix: "anthropic/claude-sonnet-4-6", systemRatio: 1.02, toolsRatio: 1.14 },
    { prefix: "anthropic/claude-sonnet-4.6", systemRatio: 1.02, toolsRatio: 1.14 },
    { prefix: "anthropic/claude-haiku-4-5", systemRatio: 1.02, toolsRatio: 1.16 },
    { prefix: "anthropic/claude-haiku-4.5", systemRatio: 1.02, toolsRatio: 1.16 },
    // Claude models routed through OpenRouter and GitHub Copilot use Anthropic's tokenizer.
    // The OpenRouter and GitHub Copilot alias entries prevent fallback to 1.0 ratios.
    // The 1.0 fallback shifts System+ToolDefs tokens into Conversation/ToolCalls.
    // Residual buckets preserve `inputTokens` but alter per-bucket counts.
    { prefix: "openrouter/anthropic/claude-opus-4-8", systemRatio: 1.51, toolsRatio: 1.57 },
    { prefix: "openrouter/anthropic/claude-opus-4.8", systemRatio: 1.51, toolsRatio: 1.57 },
    { prefix: "github-copilot/claude-opus-4-8", systemRatio: 1.51, toolsRatio: 1.57 },
    { prefix: "github-copilot/claude-opus-4.8", systemRatio: 1.51, toolsRatio: 1.57 },
    { prefix: "openrouter/anthropic/claude-opus-4-7", systemRatio: 1.51, toolsRatio: 1.57 },
    { prefix: "openrouter/anthropic/claude-opus-4.7", systemRatio: 1.51, toolsRatio: 1.57 },
    { prefix: "github-copilot/claude-opus-4-7", systemRatio: 1.51, toolsRatio: 1.57 },
    { prefix: "github-copilot/claude-opus-4.7", systemRatio: 1.51, toolsRatio: 1.57 },
    { prefix: "openrouter/anthropic/claude-sonnet-4.6", systemRatio: 1.02, toolsRatio: 1.14 },
    { prefix: "github-copilot/claude-sonnet-4.6", systemRatio: 1.02, toolsRatio: 1.14 },
    { prefix: "github-copilot/claude-sonnet-4.5", systemRatio: 1.02, toolsRatio: 1.16 },
    { prefix: "github-copilot/claude-opus-4.5", systemRatio: 1.02, toolsRatio: 1.16 },
    { prefix: "github-copilot/claude-haiku-4.5", systemRatio: 1.02, toolsRatio: 1.16 },
    // For gpt-5.x, `o200k_base` matches system prompts, but overcounts tools by ~16%.
    { prefix: "openai/gpt-5", systemRatio: 1.0, toolsRatio: 0.84 },
    // xAI Grok — ai-tokenizer overcounts (uses p50k_base which doesn't match Grok exactly).
    { prefix: "xai/grok-4", systemRatio: 0.82, toolsRatio: 0.88 },
    { prefix: "xai/grok-code-fast", systemRatio: 0.82, toolsRatio: 0.89 },
    // Cerebras models require model-specific calibration ratios.
    { prefix: "cerebras/qwen-3-235b", systemRatio: 1.0, toolsRatio: 1.1 },
    { prefix: "cerebras/zai-glm-4.7", systemRatio: 1.0, toolsRatio: 1.09 },
    { prefix: "cerebras/gpt-oss-120b", systemRatio: 0.84, toolsRatio: 0.79 },
    {
        prefix: "fireworks-ai/accounts/fireworks/models/glm-5p1",
        systemRatio: 1.0,
        toolsRatio: 1.06,
    },
    {
        prefix: "fireworks-ai/accounts/fireworks/models/deepseek-v3p2",
        systemRatio: 1.05,
        toolsRatio: 1.09,
    },
    { prefix: "opencode-go/glm-5.1", systemRatio: 1.0, toolsRatio: 1.06 },
    { prefix: "opencode-go/glm-5", systemRatio: 1.0, toolsRatio: 1.06 },
    { prefix: "opencode-go/kimi-k2.6", systemRatio: 0.87, toolsRatio: 0.86 },
];

const NEUTRAL: ModelCalibration = { systemRatio: 1.0, toolsRatio: 1.0 };

/**
 * Unknown models use 1.0 ratios, leaving local counts unchanged.
 */
export function resolveModelCalibration(
    providerId: string | undefined,
    modelId: string | undefined,
): ModelCalibration {
    if (!providerId || !modelId) return NEUTRAL;
    const key = `${providerId}/${modelId}`.toLowerCase();
    let best: CalibrationEntry | null = null;
    for (const entry of CALIBRATION_TABLE) {
        const prefix = entry.prefix.toLowerCase();
        if (!key.startsWith(prefix)) continue;
        if (!best || prefix.length > best.prefix.length) {
            best = entry;
        }
    }
    return best ?? NEUTRAL;
}

/**
 * Calibration multiplies local counts and absorbs residuals into unknown-drift buckets.
 * Unknown-drift buckets ensure all categories sum exactly to `inputTokens`.
 *
 * `System` and `Tool Defs` use their local counts multiplied by the measured model-specific ratio.
 * `Compartments`, `Facts`, and `Memories` retain their unadjusted local counts.
 *
 * The function returns all-zero buckets when `inputTokens <= 0`.
 * When `residualLocalSum <= 0`, `conversation` receives the full residual.
 * For `inputTokens > 0`, the returned buckets total exactly `inputTokens`.
 * When rounding leaves a nonzero delta, apply it to the selected residual bucket so the final sum equals `inputTokens`.
 */
export interface CalibratedBuckets {
    systemTokens: number;
    toolDefinitionTokens: number;
    compartmentTokens: number;
    factTokens: number;
    memoryTokens: number;
    docsTokens: number;
    profileTokens: number;
    conversationTokens: number;
    toolCallTokens: number;
}

export interface CalibrationInput {
    inputTokens: number;
    /* */
    systemLocal: number;
    /* */
    toolDefsLocal: number;
    /* */
    compartmentsLocal: number;
    factsLocal: number;
    memoriesLocal: number;
    /* */
    docsLocal: number;
    /* */
    profileLocal: number;
    /* */
    conversationLocal: number;
    toolCallsLocal: number;
    calibration: ModelCalibration;
}

export function calibrateBuckets(input: CalibrationInput): CalibratedBuckets {
    const empty: CalibratedBuckets = {
        systemTokens: 0,
        toolDefinitionTokens: 0,
        compartmentTokens: 0,
        factTokens: 0,
        memoryTokens: 0,
        docsTokens: 0,
        profileTokens: 0,
        conversationTokens: 0,
        toolCallTokens: 0,
    };
    if (input.inputTokens <= 0) return empty;

    let calibratedSystem = Math.round(input.systemLocal * input.calibration.systemRatio);
    let calibratedToolDefs = Math.round(input.toolDefsLocal * input.calibration.toolsRatio);

    let compartments = Math.max(0, input.compartmentsLocal);
    let facts = Math.max(0, input.factsLocal);
    let memories = Math.max(0, input.memoriesLocal);
    let docs = Math.max(0, input.docsLocal);
    let profile = Math.max(0, input.profileLocal);

    const nonResidualTotal =
        calibratedSystem + calibratedToolDefs + compartments + facts + memories + docs + profile;
    if (nonResidualTotal > input.inputTokens) {
        const ratio = input.inputTokens / nonResidualTotal;
        calibratedSystem = Math.round(calibratedSystem * ratio);
        calibratedToolDefs = Math.round(calibratedToolDefs * ratio);
        compartments = Math.round(compartments * ratio);
        facts = Math.round(facts * ratio);
        memories = Math.round(memories * ratio);
        docs = Math.round(docs * ratio);
        profile = Math.round(profile * ratio);
    }

    const residualTarget = Math.max(
        0,
        input.inputTokens -
            calibratedSystem -
            calibratedToolDefs -
            compartments -
            facts -
            memories -
            docs -
            profile,
    );
    const residualLocalSum = input.conversationLocal + input.toolCallsLocal;

    let conversation: number;
    let toolCalls: number;

    if (residualLocalSum <= 0) {
        conversation = residualTarget;
        toolCalls = 0;
    } else {
        const scale = residualTarget / residualLocalSum;
        conversation = Math.round(input.conversationLocal * scale);
        toolCalls = Math.round(input.toolCallsLocal * scale);
    }

    // Apply the delta to the larger residual bucket first; non-residual buckets absorb any remaining overshoot.
    const provisionalSum =
        calibratedSystem +
        calibratedToolDefs +
        compartments +
        facts +
        memories +
        docs +
        profile +
        conversation +
        toolCalls;
    let delta = input.inputTokens - provisionalSum;
    if (delta !== 0) {
        if (conversation >= toolCalls) {
            const adjusted = Math.max(0, conversation + delta);
            delta -= adjusted - conversation;
            conversation = adjusted;
        } else {
            const adjusted = Math.max(0, toolCalls + delta);
            delta -= adjusted - toolCalls;
            toolCalls = adjusted;
        }
    }

    // When the residual adjustment leaves a negative delta, subtract the remaining overshoot from non-residual buckets.
    // The loop handles overshoot larger than a single bucket.
    // Without the overshoot-correction loop, bucket totals can exceed `inputTokens`.
    if (delta < 0) {
        type BucketName =
            | "system"
            | "toolDefs"
            | "compartments"
            | "facts"
            | "memories"
            | "docs"
            | "profile";
        const get = (name: BucketName): number => {
            if (name === "system") return calibratedSystem;
            if (name === "toolDefs") return calibratedToolDefs;
            if (name === "compartments") return compartments;
            if (name === "facts") return facts;
            if (name === "docs") return docs;
            if (name === "profile") return profile;
            return memories;
        };
        const subtract = (name: BucketName, amount: number): void => {
            if (name === "system") calibratedSystem -= amount;
            else if (name === "toolDefs") calibratedToolDefs -= amount;
            else if (name === "compartments") compartments -= amount;
            else if (name === "facts") facts -= amount;
            else if (name === "docs") docs -= amount;
            else if (name === "profile") profile -= amount;
            else memories -= amount;
        };
        const buckets: BucketName[] = [
            "system",
            "toolDefs",
            "compartments",
            "facts",
            "memories",
            "docs",
            "profile",
        ];
        buckets.sort((a, b) => get(b) - get(a));
        for (const name of buckets) {
            if (delta >= 0) break;
            const value = get(name);
            if (value <= 0) continue;
            const adjustment = Math.min(value, -delta);
            subtract(name, adjustment);
            delta += adjustment;
        }
    }

    return {
        systemTokens: calibratedSystem,
        toolDefinitionTokens: calibratedToolDefs,
        compartmentTokens: compartments,
        factTokens: facts,
        memoryTokens: memories,
        docsTokens: docs,
        profileTokens: profile,
        conversationTokens: conversation,
        toolCallTokens: toolCalls,
    };
}
