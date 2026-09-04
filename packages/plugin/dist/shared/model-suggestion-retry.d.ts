import type { createOpencodeClient } from "@opencode-ai/sdk";
type Client = ReturnType<typeof createOpencodeClient>;
export type PromptBody = {
    model?: {
        providerID: string;
        modelID: string;
    };
    [key: string]: unknown;
};
export type PromptArgs = {
    path: {
        id: string;
    };
    body: PromptBody;
    signal?: AbortSignal;
    [key: string]: unknown;
};
export interface PromptAttemptInfo {
    /** Human-readable model label used in logs ("primary" or "provider/model"). */
    label: string;
    /** Zero-based attempt index: 0 is primary, 1+ are fallback models. */
    attemptIndex: number;
    /** True for configured fallback models, false for the primary attempt. */
    isFallback: boolean;
    /** Total attempted models including the primary and all configured fallbacks. */
    totalAttempts: number;
    /** Explicit model override for this attempt, when one was supplied. */
    model?: {
        providerID: string;
        modelID: string;
    };
}
export interface PromptRetryOptions {
    timeoutMs?: number;
    /** External abort signal — cancels the in-flight LLM prompt immediately when aborted */
    signal?: AbortSignal;
    /**
     * Ordered list of "provider/modelID" alternates to try if the primary call
     * (and its single-suggestion retry) fails. Empty / undefined = no fallback
     * iteration (legacy behavior).
     *
     * Fallback policy:
     *   - Each fallback gets the FULL `timeoutMs` budget (per-attempt, not total).
     *   - Suggestion-retry runs inside each attempt (so "did you mean X?" errors
     *     still self-heal at the primary AND at each fallback).
     *   - Iteration stops immediately on abort/timeout/context-overflow errors —
     *     fallbacks won't help and the caller's emergency-recovery path needs
     *     to handle these.
     *   - On all-failed, the LAST error is thrown (matches legacy behavior when
     *     `fallbackModels` is empty).
     */
    fallbackModels?: readonly string[];
    /**
     * Identifier for structured logging (e.g. "dreamer:consolidate",
     * "historian", "compressor", "sidekick"). Helps correlate fallback
     * attempts to a specific call site in `magic-context.log`. Defaults to
     * "subagent" if not provided.
     */
    callContext?: string;
}
export interface ValidatedPromptRetryOptions<TOutput, TValidated> extends PromptRetryOptions {
    /**
     * Fetch the output produced by the just-completed prompt attempt. This is
     * intentionally caller-owned because OpenCode exposes results via session
     * messages and each caller validates a different shape.
     */
    fetchOutput: (args: PromptArgs, attempt: PromptAttemptInfo) => Promise<TOutput>;
    /**
     * Validate and optionally transform the fetched output. Throw to reject this
     * model's output and advance to the next configured fallback model.
     */
    validateOutput: (output: TOutput, attempt: PromptAttemptInfo) => TValidated | Promise<TValidated>;
}
export interface ValidatedPromptRetryResult<TOutput, TValidated> {
    output: TOutput;
    validated: TValidated;
    attempt: PromptAttemptInfo;
}
export interface ModelSuggestionInfo {
    providerID: string;
    modelID: string;
    suggestion: string;
}
export declare function parseModelSuggestion(error: unknown): ModelSuggestionInfo | null;
/**
 * Run an OpenCode subagent prompt with model fallback support.
 *
 * Attempts the configured primary model first (whatever `args.body.model` or
 * the registered agent default resolves to), then iterates through
 * `options.fallbackModels` if provided. Each attempt internally retries once on
 * the SDK's "model not found, did you mean X?" suggestion. Aborts, timeouts,
 * and context-overflow errors short-circuit the fallback loop because retrying
 * the same prompt against another model won't help.
 *
 * Behavior with `fallbackModels` empty/undefined is identical to the pre-v0.18
 * single-suggestion retry — fully backward-compatible for callers that haven't
 * been updated to thread a chain.
 */
export declare function promptSyncWithModelSuggestionRetry(client: Client, args: PromptArgs, options?: PromptRetryOptions): Promise<void>;
/**
 * Run a prompt with model fallback support, but accept an attempt only after the
 * caller validates the model's actual output. This covers "empty success" cases
 * where the provider/OpenCode prompt call completes successfully but the subagent
 * produced no usable assistant text / JSON.
 *
 * The happy path is still one prompt + one caller-owned output fetch: callers
 * should use the returned output instead of fetching messages a second time.
 * Validation failures are retryable across configured fallback models. If every
 * attempt produces invalid output (or otherwise fails retryably), the first
 * failure is re-thrown so callers surface the original failure semantics.
 */
export declare function promptSyncWithValidatedOutputRetry<TOutput, TValidated = TOutput>(client: Client, args: PromptArgs, options: ValidatedPromptRetryOptions<TOutput, TValidated>): Promise<ValidatedPromptRetryResult<TOutput, TValidated>>;
export {};
//# sourceMappingURL=model-suggestion-retry.d.ts.map